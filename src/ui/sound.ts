import type { Frame } from '../core/types'
import type { EngineState } from '../core/Engine'
import { CHAPTERS } from '../chapters/index'

/*
 * Hark Plexus sound: a shimmering synth-granular pad (WebAudio, no files).
 *
 *   pad      four chord voices, each a soft sine + a detuned triangle + a
 *            quiet octave sine, low-passed and breathing on slow LFOs. On a
 *            new chapter every voice GLIDES to the new chord (~1 s), so the
 *            harmony morphs like the particle clouds do.
 *   grains   tiny windowed sine / triangle grains (50–120 ms) high in the
 *            chord, scattered across the stereo field into a ping-pong
 *            shimmer delay. Their density follows scroll velocity: scroll
 *            and the air fills with glints, stop and it thins to a trickle
 *            (particles ↔ sound).
 *   pings    sparse crystalline notes (a sine with a faint inharmonic
 *            partial, fast attack, long decay) that ring on through the delay
 *            feedback. They also quicken with scroll speed.
 *   modes    every chapter has its own chord and colour:
 *              hero      Genesis        C maj9, open
 *              work      Constellation  A min9, calm
 *              services  Nodes          F lydian, bright
 *              voices    Echoes         D min9, warm, slower pings
 *              shield    Firewall       tense: B♭ m(maj7 ♯11), darker filter, sparse diminished pings
 *              process   Flow           G 6/9, steady
 *              contact   Connect        C maj9, high and clear
 *   cut()    a soft "scatter": a band-passed noise swell sweeping up then
 *            down, and a few pings falling away in the new chapter's key
 *   blip()   a tiny ping (nav, buttons), stepping up the pentatonic
 *   tone()   a pure sine a chapter may ask for (also via 'hark:tone' events)
 *   meter()  five band levels for the chrome's dancing dots
 *
 * Off by default. Sound only ever starts from a real gesture: the toggle's
 * own click / tap / Enter / Space. A remembered "on" (localStorage) waits for
 * the first real activation (a click or tap, or Enter / Space on a control;
 * never Tab, arrows or scrolling). Faded out and suspended while the tab is
 * hidden. On iOS the audio session is set to "playback" so the silent switch
 * doesn't swallow it. Levels stay low: the master sits well under full
 * scale, behind a gentle compressor.
 */

const STORE_KEY = 'hark-plexus:sound'

function stored(): boolean | null {
  try {
    const v = localStorage.getItem(STORE_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

interface Mode {
  pad: number[]
  ping: number[]
  cutoff: number
  /** grains / s at rest */
  grains: number
  /** pings / s at rest */
  pings: number
}

const MODES: Record<string, Mode> = {
  hero: { pad: [48, 55, 64, 71], ping: [84, 86, 88, 91, 93, 96], cutoff: 1250, grains: 2.4, pings: 0.28 },
  work: { pad: [45, 52, 60, 67], ping: [81, 84, 86, 88, 91, 93], cutoff: 1100, grains: 2.2, pings: 0.26 },
  services: { pad: [41, 48, 57, 64], ping: [77, 79, 81, 84, 88, 91], cutoff: 1500, grains: 3, pings: 0.34 },
  voices: { pad: [50, 57, 60, 65], ping: [86, 89, 91, 93, 96, 98], cutoff: 1000, grains: 1.8, pings: 0.2 },
  shield: { pad: [46, 52, 57, 61], ping: [82, 85, 88, 91, 94, 97], cutoff: 720, grains: 1.4, pings: 0.14 },
  process: { pad: [43, 50, 57, 64], ping: [79, 81, 83, 86, 88, 91], cutoff: 1300, grains: 2.6, pings: 0.3 },
  contact: { pad: [48, 55, 67, 76], ping: [84, 88, 91, 93, 96, 100], cutoff: 1600, grains: 2.4, pings: 0.3 },
}

const ACTIVATE_KEYS = new Set(['Enter', ' ', 'Spacebar'])
const CONTROL = 'a[href], button, [role="button"], [role="switch"], summary, input, select, textarea'
const MASTER_LEVEL = 0.8
const TONE_MAX = 0.04
const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12)
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

function setAudioSession(type: string) {
  try {
    const nav = navigator as Navigator & { audioSession?: { type: string } }
    if (nav.audioSession) nav.audioSession.type = type
  } catch {
    /* not supported */
  }
}

interface Voice {
  oscs: OscillatorNode[]
  ratios: number[]
}

export class Sound {
  enabled = false
  onChange: ((enabled: boolean) => void)[] = []

  private ctx: AudioContext | null = null
  private master!: GainNode
  private dry!: GainNode
  private bus!: GainNode
  private padFilter!: BiquadFilterNode
  private analyser: AnalyserNode | null = null
  private bins = new Uint8Array(64)
  private noise: AudioBuffer | null = null
  private voices: Voice[] = []
  private toneOsc: OscillatorNode | null = null
  private toneGain: GainNode | null = null

  private chapter = 'hero'
  private modeKey = ''
  private mode: Mode = MODES.hero
  private cutoff = 1200
  private lastFilterAt = 0
  private grainAcc = 0
  private lastCut = 0
  private lastBlip = 0
  private suspendTimer = 0
  private hidden = typeof document !== 'undefined' && document.hidden
  /** a remembered "on" waiting for the first real gesture */
  private armed = false
  private gestureBound = false
  private toneHz = 440
  private toneLevel = 0

  constructor() {
    this.armed = stored() === true
    if (this.armed) this.waitForGesture()
    document.addEventListener('visibilitychange', () => {
      this.hidden = document.hidden
      this.applyRunning()
    })
    window.addEventListener('hark:tone', e => {
      const d = (e as CustomEvent<{ hz?: number; level?: number }>).detail
      if (d && typeof d.hz === 'number') this.tone(d.hz, d.level ?? 0)
    })
  }

  /** was sound on last visit? (it still needs a gesture to start) */
  get remembered() {
    return stored() === true
  }

  /** Flip sound on/off. Call from a user gesture (click / key). */
  toggle() {
    this.armed = false
    this.setEnabled(!this.enabled)
    try {
      localStorage.setItem(STORE_KEY, this.enabled ? '1' : '0')
    } catch {
      /* storage blocked: the choice lasts for this visit */
    }
  }

  /** Follow the story: chord per chapter, grain / ping density from scroll speed. */
  update(frame: Frame, state: EngineState) {
    const slot = state.slots[state.index]
    if (slot) this.chapter = slot.def.id
    const ctx = this.live()
    if (!ctx) return
    if (this.chapter !== this.modeKey) this.setMode(this.chapter, ctx)
    const now = ctx.currentTime
    const dt = Math.min(0.05, Math.max(0, frame.dt || 0))
    const v = Math.min(3, Math.abs(frame.velocity || 0))

    // moving opens the filter a little (brighter shimmer), then it settles
    if (now - this.lastFilterAt > 0.1) {
      this.lastFilterAt = now
      const target = this.mode.cutoff * (1 + v * 0.45)
      if (Math.abs(target - this.cutoff) > 10) {
        this.cutoff = target
        this.padFilter.frequency.setTargetAtTime(target, now, 0.4)
      }
    }

    // grains: a steady trickle that thickens with scroll speed
    this.grainAcc += this.mode.grains * (1 + v * 3.2) * dt
    let spawned = 0
    while (this.grainAcc >= 1 && spawned < 5) {
      this.grainAcc -= 1
      spawned++
      this.grain(ctx, now + Math.random() * 0.05)
    }
    if (this.grainAcc > 3) this.grainAcc = 0
    // pings: sparse, a little more often while moving
    if (Math.random() < this.mode.pings * (0.7 + v * 1.4) * dt) {
      const m = this.mode.ping[Math.floor(Math.random() * this.mode.ping.length)]
      this.ping(ctx, now + 0.01, m, 0.02 + Math.random() * 0.018, 1 + Math.random() * 0.9, Math.random() * 1.6 - 0.8)
    }
  }

  /** A chapter cut: particles scatter, so does the sound. */
  cut(_from: number, to: number) {
    const ctx = this.live()
    if (!ctx || !this.noise) return
    const now = ctx.currentTime
    if (now - this.lastCut < 0.5) return
    this.lastCut = now
    const src = ctx.createBufferSource()
    src.buffer = this.noise
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.Q.value = 1.1
    bp.frequency.setValueAtTime(520, now)
    bp.frequency.exponentialRampToValueAtTime(3400, now + 0.32)
    bp.frequency.exponentialRampToValueAtTime(760, now + 1.0)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, now)
    g.gain.exponentialRampToValueAtTime(0.04, now + 0.28)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 1.05)
    src.connect(bp).connect(g)
    g.connect(this.dry)
    const send = ctx.createGain()
    send.gain.value = 0.7
    g.connect(send).connect(this.bus)
    src.start(now)
    src.stop(now + 1.1)
    // a few pings falling away in the key we're arriving in
    const m = MODES[CHAPTERS[to]?.id ?? ''] ?? this.mode
    const top = m.ping.length - 1
    for (let k = 0; k < 4; k++) {
      this.ping(ctx, now + 0.26 + k * 0.075, m.ping[top - k], 0.026 - k * 0.005, 1.2, (k % 2 ? 1 : -1) * (0.3 + k * 0.12))
    }
  }

  /** A tiny ping (nav, buttons). `pitch` steps up the pentatonic. No-op while off. */
  blip(pitch = 0) {
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    if (now - this.lastBlip < 0.06) return
    this.lastBlip = now
    const p = Math.max(0, Math.round(pitch))
    const scale = this.mode.ping
    const m = scale[p % scale.length] - 12 + 12 * Math.floor(p / scale.length)
    this.ping(ctx, now, m, 0.03, 0.45, 0)
  }

  /** A pure sine a chapter may ask for: level 0..1 (0 releases it). */
  tone(hz: number, level: number) {
    if (Number.isFinite(hz) && hz > 20 && hz < 12000) this.toneHz = hz
    this.toneLevel = clamp01(Number.isFinite(level) ? level : 0)
    this.applyTone()
  }

  /** Five band levels 0..1 (low → high) for a level meter; false while silent. */
  meter(out: number[]): boolean {
    const ctx = this.live()
    if (!ctx || !this.analyser) return false
    this.analyser.getByteFrequencyData(this.bins)
    const b = this.bins
    const band = (a: number, z: number) => {
      let m = 0
      for (let i = a; i <= z; i++) m = Math.max(m, b[i])
      return m / 255
    }
    out[0] = band(0, 2)
    out[1] = band(3, 5)
    out[2] = band(6, 10)
    out[3] = band(11, 20)
    out[4] = band(21, 50)
    return true
  }

  /* ------------------------------------------------------------ internals */

  private live() {
    const ctx = this.ctx
    if (!ctx || !this.enabled || this.hidden || ctx.state !== 'running') return null
    return ctx
  }

  private setEnabled(on: boolean) {
    if (on === this.enabled) return
    this.enabled = on
    setAudioSession(on ? 'playback' : 'auto')
    if (on) {
      try {
        this.ensureGraph()
      } catch (err) {
        console.warn('[hark] audio unavailable', err)
      }
    }
    this.applyRunning(true)
    for (const fn of this.onChange) fn(on)
  }

  /** Resume + fade in, or fade out + suspend, from enabled / hidden. */
  private applyRunning(greet = false) {
    const ctx = this.ctx
    if (!ctx) return
    clearTimeout(this.suspendTimer)
    const now = ctx.currentTime
    if (this.enabled && !this.hidden) {
      ctx
        .resume()
        .then(() => {
          if (!this.enabled || this.hidden) return
          if (ctx.state !== 'running') return this.waitForGesture()
          const t = ctx.currentTime
          this.master.gain.cancelScheduledValues(t)
          this.master.gain.setValueAtTime(this.master.gain.value, t)
          this.master.gain.setTargetAtTime(MASTER_LEVEL, t, 0.7)
          this.modeKey = ''
          this.setMode(this.chapter, ctx)
          this.applyTone()
          if (greet) {
            // "on": three pings, rising, ringing into the shimmer
            const s = this.mode.ping
            this.ping(ctx, t + 0.05, s[0], 0.03, 1.4, -0.35)
            this.ping(ctx, t + 0.2, s[2], 0.026, 1.4, 0.05)
            this.ping(ctx, t + 0.36, s[4], 0.022, 1.8, 0.4)
          }
        })
        .catch(() => this.waitForGesture())
    } else {
      this.master.gain.cancelScheduledValues(now)
      this.master.gain.setValueAtTime(this.master.gain.value, now)
      this.master.gain.setTargetAtTime(0, now, this.hidden ? 0.05 : 0.2)
      this.suspendTimer = window.setTimeout(
        () => {
          if (!this.enabled || this.hidden) ctx.suspend().catch(() => {})
        },
        this.hidden ? 300 : 1100,
      )
    }
  }

  /** Start audio on the first real gesture (a remembered "on", or a blocked resume). */
  private waitForGesture() {
    if (this.gestureBound) return
    this.gestureBound = true
    let sx = 0
    let sy = 0
    const events = ['click', 'keydown', 'touchstart', 'touchend'] as const
    const handler = (e: Event) => {
      if (e.type === 'touchstart') {
        const t = (e as TouchEvent).touches[0]
        if (t) {
          sx = t.clientX
          sy = t.clientY
        }
        return
      }
      if (e.type === 'touchend') {
        // a tap, not a scroll or a swipe
        const t = (e as TouchEvent).changedTouches[0]
        if (!t || Math.hypot(t.clientX - sx, t.clientY - sy) > 12) return
      }
      // keyboard: only Enter / Space on a control is "play"; Tab and friends are just moving around
      if (e instanceof KeyboardEvent) {
        if (!ACTIVATE_KEYS.has(e.key) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
        if (!(e.target as Element | null)?.closest?.(CONTROL)) return
      }
      for (const ev of events) window.removeEventListener(ev, handler, true)
      this.gestureBound = false
      const onToggle = (e.target as Element | null)?.closest?.('[data-sound-toggle]')
      if (this.armed) {
        this.armed = false
        // the toggle's own click decides for itself
        if (!onToggle) this.setEnabled(true)
      } else if (this.enabled) this.applyRunning()
    }
    for (const ev of events) window.addEventListener(ev, handler, { capture: true, passive: true })
  }

  private ensureGraph() {
    if (this.ctx) return
    const AC =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC({ latencyHint: 'playback' })
    this.ctx = ctx

    // master → high-pass → glue compression → out (+ a meter tap)
    this.master = ctx.createGain()
    this.master.gain.value = 0
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 55
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -22
    comp.knee.value = 18
    comp.ratio.value = 3
    comp.attack.value = 0.01
    comp.release.value = 0.35
    this.master.connect(hp).connect(comp).connect(ctx.destination)
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 128
    this.analyser.smoothingTimeConstant = 0.78
    this.analyser.minDecibels = -90
    this.analyser.maxDecibels = -30
    comp.connect(this.analyser)

    this.dry = ctx.createGain()
    this.dry.connect(this.master)

    // the shimmer: a ping-pong delay with a darkening feedback loop
    this.bus = ctx.createGain()
    const dL = ctx.createDelay(2)
    const dR = ctx.createDelay(2)
    dL.delayTime.value = 0.37
    dR.delayTime.value = 0.53
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 3600
    const fbL = ctx.createGain()
    const fbR = ctx.createGain()
    fbL.gain.value = 0.56
    fbR.gain.value = 0.56
    this.bus.connect(dL)
    dL.connect(lp).connect(fbL).connect(dR)
    dR.connect(fbR).connect(dL)
    const wet = ctx.createGain()
    wet.gain.value = 0.62
    const pl = this.panner(ctx, -0.75)
    const pr = this.panner(ctx, 0.75)
    dL.connect(pl).connect(wet)
    dR.connect(pr).connect(wet)
    wet.connect(this.master)

    // the pad
    this.padFilter = ctx.createBiquadFilter()
    this.padFilter.type = 'lowpass'
    this.padFilter.frequency.value = this.cutoff
    this.padFilter.Q.value = 0.6
    const padGain = ctx.createGain()
    padGain.gain.value = 0.5
    this.padFilter.connect(padGain).connect(this.dry)
    const padSend = ctx.createGain()
    padSend.gain.value = 0.18
    padGain.connect(padSend).connect(this.bus)
    // a slow sweep on the filter
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.045
    const lfoAmt = ctx.createGain()
    lfoAmt.gain.value = 260
    lfo.connect(lfoAmt).connect(this.padFilter.frequency)
    lfo.start()

    const notes = this.mode.pad
    this.voices = notes.map((m, i) => {
      const vg = ctx.createGain()
      vg.gain.value = 0.045
      // each voice breathes on its own slow swell
      const br = ctx.createOscillator()
      br.frequency.value = 0.05 + i * 0.023
      const brAmt = ctx.createGain()
      brAmt.gain.value = 0.018
      br.connect(brAmt).connect(vg.gain)
      br.start(ctx.currentTime + i * 0.7)
      vg.connect(this.padFilter)
      const spec: [OscillatorType, number, number, number][] = [
        ['sine', 1, 0, 0.5],
        ['triangle', 1, 7, 0.32],
        ['sine', 2, -5, 0.14],
      ]
      const oscs: OscillatorNode[] = []
      const ratios: number[] = []
      for (const [type, ratio, cents, level] of spec) {
        const o = ctx.createOscillator()
        o.type = type
        o.frequency.value = mtof(m) * ratio
        o.detune.value = cents + (i % 2 ? 2 : -2)
        const g = ctx.createGain()
        g.gain.value = level
        o.connect(g).connect(vg)
        o.start()
        oscs.push(o)
        ratios.push(ratio)
      }
      return { oscs, ratios }
    })

    // a pure tone a chapter may ask for
    this.toneOsc = ctx.createOscillator()
    this.toneOsc.type = 'sine'
    this.toneOsc.frequency.value = this.toneHz
    this.toneGain = ctx.createGain()
    this.toneGain.gain.value = 0
    this.toneOsc.connect(this.toneGain).connect(this.dry)
    this.toneOsc.start()

    // a second of white noise for the cut's scatter
    const len = Math.floor(ctx.sampleRate * 1.2)
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = this.noise.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  }

  private panner(ctx: AudioContext, pan: number): AudioNode {
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner()
      p.pan.value = pan
      return p
    }
    return ctx.createGain()
  }

  private setMode(id: string, ctx: AudioContext) {
    const m = MODES[id] ?? MODES.hero
    this.modeKey = id
    this.mode = m
    const now = ctx.currentTime
    // every voice glides to the new chord: the harmony morphs, like the particles
    this.voices.forEach((v, i) => {
      const f = mtof(m.pad[i] ?? m.pad[0])
      v.oscs.forEach((o, k) => o.frequency.setTargetAtTime(f * v.ratios[k], now, 0.45))
    })
    this.cutoff = m.cutoff
    this.padFilter.frequency.setTargetAtTime(m.cutoff, now, 0.6)
  }

  /** a windowed micro-grain high in the chord, flung somewhere in the stereo field */
  private grain(ctx: AudioContext, at: number) {
    const pad = this.mode.pad
    const m = pad[Math.floor(Math.random() * pad.length)] + (Math.random() < 0.6 ? 24 : 36)
    const dur = 0.05 + Math.random() * 0.07
    const o = ctx.createOscillator()
    o.type = Math.random() < 0.5 ? 'sine' : 'triangle'
    o.frequency.value = mtof(m)
    o.detune.value = (Math.random() - 0.5) * 12
    const g = ctx.createGain()
    const peak = 0.006 + Math.random() * 0.008
    g.gain.setValueAtTime(0, at)
    g.gain.linearRampToValueAtTime(peak, at + dur * 0.45)
    g.gain.linearRampToValueAtTime(0, at + dur)
    const p = this.panner(ctx, Math.random() * 1.8 - 0.9)
    o.connect(g).connect(p)
    p.connect(this.bus)
    const d = ctx.createGain()
    d.gain.value = 0.35
    p.connect(d).connect(this.dry)
    o.start(at)
    o.stop(at + dur + 0.02)
  }

  /** a crystalline note: sine + a faint inharmonic partial, long ring into the shimmer */
  private ping(ctx: AudioContext, at: number, midi: number, level: number, decay: number, pan: number) {
    if (level <= 0) return
    const f = mtof(midi)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(level, at + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, at + decay)
    const o1 = ctx.createOscillator()
    o1.type = 'sine'
    o1.frequency.value = f
    const o2 = ctx.createOscillator()
    o2.type = 'sine'
    o2.frequency.value = f * 2.76
    const g2 = ctx.createGain()
    g2.gain.value = 0.16
    o1.connect(g)
    o2.connect(g2).connect(g)
    const p = this.panner(ctx, pan)
    g.connect(p)
    const d = ctx.createGain()
    d.gain.value = 0.55
    p.connect(d).connect(this.dry)
    p.connect(this.bus)
    o1.start(at)
    o2.start(at)
    o1.stop(at + decay + 0.05)
    o2.stop(at + decay * 0.6 + 0.05)
  }

  private applyTone() {
    const ctx = this.ctx
    if (!ctx || !this.toneOsc || !this.toneGain) return
    const now = ctx.currentTime
    this.toneOsc.frequency.setTargetAtTime(this.toneHz, now, 0.08)
    this.toneGain.gain.setTargetAtTime(this.toneLevel * TONE_MAX, now, 0.12)
  }
}
