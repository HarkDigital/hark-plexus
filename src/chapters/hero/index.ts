import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { el, reveal, rise, setRise } from '../../core/dom'
import { BRAND, MICROCOPY } from '../../content'
import { clamp, damp, lerp, segment, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { Dust } from '../../kit/particles'
import { G } from '../../kit/glass'
import { buildGenesis, type GenesisCloud } from './genesis'
import { buildGlassMark, type GlassMark } from './mark'
import { PlexusRing } from './plexus'
import { sampleWord } from './word'
import './hero.css'

/*
 * HERO — "Genesis". Particles become glass, and the glass becomes a network.
 *
 *   0.00–0.08  INTRO      a spiral nebula of ~11k particles turns slowly in
 *                         front of the network; the cursor parts it. After
 *                         the loader it breathes in from the dark (~1.6 s).
 *                         Eyebrow, manifesto and 'Scroll to connect' hold
 *                         through the condense (the manifesto to ~0.27, the
 *                         eyebrow + hint to ~0.35).
 *   0.08–0.30  CONDENSE   scroll spirals every particle in around the view
 *                         axis until they settle into the Hark mark; the
 *                         backdrop network leans toward it.
 *   0.31–0.45  CRYSTALLIZE a front sweeps diagonally across the particle
 *                         mark: behind it the mark is GLASS, and its heart is
 *                         a live mini-constellation (a node in each hook's eye,
 *                         a hub where the diamond sat) whose nodes ignite and
 *                         whose links grow as the front passes. At the front
 *                         the particles flare; most lift off into the orbit
 *                         ring, and a quarter STREAM OFF INTO THE HEADLINE:
 *                         they write 'listen.' left to right where the DOM
 *                         word will sit. A light sweep runs with the front.
 *   0.39–0.52  the camera glides the mark right of centre (portrait: up) and
 *                         the plexus ring spreads out; the payoff copy comes
 *                         in (0.44–0.50) around the particle word.
 *   0.49–0.56  the DOM 'listen.' crossfades in over its particle twin, and
 *                         the particles drift apart and fade.
 *   0.52–0.93  PAYOFF     the glass mark floats inside its orbiting ring;
 *                         tagline + CTAs (anchor 0.8). The cursor repels nodes
 *                         and grabs lines to them; a click sends a soft ring
 *                         through the particles.
 *   0.93–1.00  OUT        the camera drifts into the constellation heart; once
 *                         the particle cut owns the frame the glass is hidden
 *                         and the backdrop network steps back (no one can see
 *                         them under the dots, and they are the priciest pixels).
 *
 * Every pose and form is derived from `local`; frame.time only drives idle
 * spin, float and twinkle (so it all holds still when motion is off).
 */

/** mark height (world units) */
const S = 2
/** nebula radius */
const NEB_R = 2.9

const sm = (x: number, a: number, b: number) => {
  const t = segment(x, a, b)
  return t * t * t * (t * (t * 6 - 15) + 10)
}

interface Shot {
  /** where the subject's centre sits on screen (NDC) */
  sx: number
  sy: number
  /** subject height / width (world) and the viewport fractions they should fill */
  h: number
  hf: number
  w: number
  wf: number
  yaw: number
  elev: number
  fov: number
}
type Beat = 'intro' | 'gen' | 'pay' | 'out'
const LAND: Record<Beat, Shot> = {
  intro: { sx: 0.2, sy: 0.04, h: 4.2, hf: 0.9, w: 6.0, wf: 0.74, yaw: -0.1, elev: 0.08, fov: 38 },
  gen: { sx: 0.0, sy: 0.03, h: S, hf: 0.5, w: S, wf: 0.5, yaw: 0, elev: 0.03, fov: 36 },
  pay: { sx: 0.47, sy: 0.03, h: S, hf: 0.36, w: S * 2.1, wf: 0.44, yaw: 0.1, elev: 0.12, fov: 36 },
  out: { sx: 0.02, sy: 0.0, h: S, hf: 2.4, w: S, wf: 2.4, yaw: 0.02, elev: 0.04, fov: 32 },
}
const PORT: Record<Beat, Shot> = {
  intro: { sx: 0.0, sy: 0.3, h: 4.2, hf: 0.56, w: 6.0, wf: 1.45, yaw: -0.1, elev: 0.08, fov: 42 },
  gen: { sx: 0.0, sy: 0.12, h: S, hf: 0.3, w: S, wf: 0.7, yaw: 0, elev: 0.03, fov: 40 },
  pay: { sx: 0.0, sy: 0.37, h: S, hf: 0.24, w: S * 2.1, wf: 1.0, yaw: 0.08, elev: 0.12, fov: 40 },
  out: { sx: 0.0, sy: 0.18, h: S, hf: 1.7, w: S, wf: 1.9, yaw: 0.02, elev: 0.04, fov: 36 },
}

export default function create(): Chapter {
  const group = new THREE.Group()
  let cloud: GenesisCloud
  let mark: GlassMark
  let plexus: PlexusRing
  let dust: Dust
  const glow = new THREE.PointLight(G.ice, 0, 2.6, 2)
  group.add(glow)
  let reduced = false
  let mobile = false
  let ready = false

  // DOM
  let intro: HTMLElement
  let manifesto: HTMLElement
  let payoff: HTMLElement
  let title: HTMLElement
  let accentOn = -1

  // the particle word: its DOM twin's box (CSS px, relative to the canvas)
  let canvasEl: HTMLCanvasElement
  let wordReady = false
  let wordW = 3
  let wordDirty = true
  let wordOk = false

  // reveal clock (performance seconds)
  let revealAt = -1
  let initAt = 0
  const now = () => performance.now() / 1000

  // pointer: mouse only (touch devices stay calm)
  let mouse = false
  let ptrK = 0
  const ptr = new THREE.Vector2(9, 9)
  let clickAt = -99
  const clickPos = new THREE.Vector2(9, 9)

  // per-frame pose
  const shot: Shot = { ...LAND.intro }
  const pos = new THREE.Vector3()
  const tgt = new THREE.Vector3()
  let fov = 38
  const F = new THREE.Vector3()
  const Rv = new THREE.Vector3()
  const U = new THREE.Vector3()
  const UP = new THREE.Vector3(0, 1, 0)
  const ray = new THREE.Raycaster()
  const plane = new THREE.Plane()
  const hit = new THREE.Vector3()
  const camLocal = new THREE.Vector3()
  const viewLocal = new THREE.Vector3()
  const localPlane = new THREE.Plane()
  const tmpV = new THREE.Vector3()
  /** the dust's pointer pull, eased to rest when motion is off (never a snap) */
  const dustPtr = new THREE.Vector2()

  const shotAt = (local: number, portrait: boolean, out: Shot) => {
    const T = portrait ? PORT : LAND
    const w1 = sm(local, 0.05, 0.28)
    const w2 = sm(local, 0.35, 0.47)
    const w3 = Math.pow(segment(local, 0.925, 1), 1.6)
    for (const k of Object.keys(out) as (keyof Shot)[]) {
      out[k] = lerp(lerp(lerp(T.intro[k], T.gen[k], w1), T.pay[k], w2), T.out[k], w3)
    }
    return out
  }

  /** the DOM accent word's box → the particle word's screen placement (on resize / font load only) */
  const measureWord = () => {
    wordDirty = false
    const em = title.querySelector('em')
    const c = canvasEl.getBoundingClientRect()
    const r = em?.getBoundingClientRect()
    const fs = parseFloat(getComputedStyle(title).fontSize)
    wordOk = !!r && r.width > 4 && r.height > 4 && fs > 0 && c.width > 0 && c.height > 0
    if (!wordOk || !r) return
    // the <em> carries 0.04em of padding-right; fit the sampled advance to the rest
    const kx = clamp((r.width - 0.04 * fs) / Math.max(1, wordW * fs), 0.85, 1.15)
    const u = cloud.u
    u.uTextC.value.set((2 * (r.left - c.left)) / c.width - 1, 1 - (2 * (r.top + r.height / 2 - c.top)) / c.height)
    u.uTextK.value.set((2 * fs * kx) / c.width, (2 * fs) / c.height)
  }

  return {
    id: 'hero',
    group,
    anchors: [0.8],

    async init(ctx: ChapterContext) {
      reduced = ctx.reducedMotion
      mobile = ctx.mobile
      initAt = now()
      // the crystallization front clips the glass (materials opt in with clippingPlanes)
      ctx.renderer.localClippingEnabled = true

      cloud = buildGenesis({ count: mobile ? 4800 : 11000, S, nebR: NEB_R, mobile, wordShare: mobile ? 0.34 : 0.3 })
      group.add(cloud.group)
      await nextFrame()
      mark = buildGlassMark(mobile, S)
      mark.logo.root.scale.setScalar(S)
      mark.pivot.visible = false
      group.add(mark.pivot)
      await nextFrame()
      plexus = new PlexusRing(mobile ? 40 : 66, cloud.ringR, cloud.ringRot, S * 0.36, mobile ? 0.1 : 0.085)
      group.add(plexus.group)
      dust = new Dust({
        count: mobile ? 90 : 220,
        box: new THREE.Box3(new THREE.Vector3(-7, -4, 0.8), new THREE.Vector3(7, 4, 4.5)),
        size: mobile ? 0.03 : 0.022,
        color: '#cfe3ff',
        seed: 41,
      })
      group.add(dust.points)

      // ---- DOM
      intro = el('div', 'gx-intro', undefined, ctx.stage)
      el('p', 'hud-eyebrow', MICROCOPY.signalEyebrow, intro)
      // (wrapped: the wrapper takes the entrance, the paragraph its own scroll fade)
      manifesto = el('p', 'hud-body gx-manifesto', BRAND.manifesto, el('div', 'gx-man', undefined, intro))
      const hint = el('p', 'hud-label gx-hint', undefined, intro)
      el('span', 'gx-hint-line', undefined, hint).setAttribute('aria-hidden', 'true')
      el('span', '', MICROCOPY.scrollHint, hint)

      payoff = el('div', 'gx-payoff', undefined, ctx.stage)
      const inner = el('div', 'gx-payoff-inner', undefined, payoff)
      el('p', 'hud-label gx-locale', BRAND.locale, inner)
      // the tagline, its last word the accent (the one the particles write)
      const words = BRAND.tagline.split(' ')
      const accent = words.pop() ?? ''
      title = rise(el('h1', 'hud-title gx-title', undefined, inner), `${words.join(' ')} <em>${accent}</em>`)
      const wraps = title.querySelectorAll<HTMLElement>('.rise-w')
      wraps[wraps.length - 1]?.classList.add('gx-accent')
      const ctas = el('div', 'gx-ctas', undefined, inner)
      const see = el('button', 'hud-btn', 'See the work', ctas)
      see.type = 'button'
      see.addEventListener('click', () => window.__hark?.land('work'))
      const start = el('a', 'hud-btn hud-btn--ghost', 'Start a project', ctas)
      start.href = '#contact'
      start.addEventListener('click', e => {
        if (!window.__hark) return
        e.preventDefault()
        window.__hark.land('contact')
      })

      // ---- the particle word: glyph targets in the headline's own face, once it has loaded
      canvasEl = ctx.renderer.domElement
      const cs = getComputedStyle(title)
      const family = cs.fontFamily || "'Sora Variable', 'Sora', system-ui, sans-serif"
      const weight = parseFloat(cs.fontWeight) || 560
      const tracking = (parseFloat(cs.letterSpacing) || -0.052 * 100) / (parseFloat(cs.fontSize) || 100)
      const buildWord = () => {
        const w = sampleWord(accent, cloud.wordCount, { family, weight, tracking: Number.isFinite(tracking) ? tracking : -0.052 })
        cloud.setWord(w.pts, w.width)
        wordW = w.width
        wordReady = true
        wordDirty = true
      }
      const face = `${weight} 100px ${family}`
      const loaded = document.fonts?.load ? document.fonts.load(face, accent).catch(() => []) : Promise.resolve([])
      await Promise.race([loaded, new Promise(r => setTimeout(r, 2500))])
      const faceOk = () => {
        try {
          return document.fonts ? document.fonts.check(face, accent) : true
        } catch {
          return true
        }
      }
      const early = faceOk()
      buildWord()
      // the face was late: sample again in the real one when it arrives
      if (!early) void loaded.then(() => faceOk() && buildWord())
      window.addEventListener('resize', () => (wordDirty = true), { passive: true })
      document.fonts?.addEventListener?.('loadingdone', () => (wordDirty = true))

      window.addEventListener('pointermove', e => (mouse = e.pointerType === 'mouse'), { passive: true })
      document.documentElement.addEventListener('pointerleave', () => (mouse = false))

      const onReveal = () => {
        if (revealAt < 0) revealAt = now()
      }
      if (document.documentElement.dataset.ready === '1') onReveal()
      else window.addEventListener('hark:reveal', onReveal, { once: true })
      ready = true
    },

    onPointerDown(frame: Frame) {
      if (reduced || mobile || frame.still) return
      clickAt = frame.time
      clickPos.copy(frame.pointerRaw)
    },

    update(local: number, frame: Frame, ctx: ChapterContext) {
      if (!ready) return
      const t = frame.time
      const portrait = frame.width <= frame.height
      const aspect = frame.width / Math.max(1, frame.height)
      const calm = reduced ? 0.15 : 1

      // ---- reveal (time-based)
      const clock = now()
      if (revealAt < 0 && (document.documentElement.dataset.ready === '1' || clock - initAt > 20)) revealAt = clock
      const since = revealAt < 0 ? 0 : clock - revealAt
      const rv = reduced ? sm(since, 0, 0.5) : sm(since, 0.0, 1.6)
      const rFrost = reduced ? 0 : 1 - sm(since, 0.05, 1.3)

      // ---- the story, from local
      const condense = sm(local, 0.08, 0.3)
      const sweep = segment(local, 0.31, 0.45)
      const hot = S * 0.07
      const front = lerp(cloud.sMin - hot * 1.5, cloud.sMax + S * 0.9 * 1.35, sweep)
      const glassOn = local > 0.305
      // how far the front has crossed the mark (0..1): drives the heart and the light sweep
      const cross = clamp((front - cloud.sMin) / (cloud.sMax - cloud.sMin))
      const settled = sm(local, 0.4, 0.5)
      // the particle cut owns the frame (the image is all dots): hide what no one can see.
      // First the glass lets go of its reflections (uniform values only: no program
      // changes), so hiding it at 0.5 swaps a clear pane for nothing — no step in the dots.
      const underCut = ctx.post.transition > 0.5
      const glassK = 1 - smoothstep(0.12, 0.48, ctx.post.transition)
      const dive = Math.pow(segment(local, 0.93, 1), 1.4)

      // ---- camera shot
      shotAt(local, portrait, shot)
      const tanV = Math.tan(THREE.MathUtils.degToRad(shot.fov / 2))
      const d = Math.max(shot.h / (shot.hf * 2 * tanV), shot.w / (shot.wf * 2 * tanV * aspect))
      tgt.set(0, 0, 0)
      const ce = Math.cos(shot.elev)
      pos.set(Math.sin(shot.yaw) * ce, Math.sin(shot.elev), Math.cos(shot.yaw) * ce).multiplyScalar(d).add(tgt)
      F.subVectors(tgt, pos).normalize()
      Rv.crossVectors(F, UP).normalize()
      U.crossVectors(Rv, F)
      const shiftR = -shot.sx * d * tanV * aspect
      const shiftU = -shot.sy * d * tanV
      pos.addScaledVector(Rv, shiftR).addScaledVector(U, shiftU)
      tgt.addScaledVector(Rv, shiftR).addScaledVector(U, shiftU)
      fov = shot.fov

      // ---- pointer (mouse only, never under reduced motion / touch)
      const ptrBeat = lerp(lerp(1, 0.75, condense), 0.9, settled) * (1 - dive)
      ptrK = damp(ptrK, mouse && !reduced && !mobile && !frame.still ? ptrBeat : 0, 4, frame.dt)
      const kp = 1 - Math.exp(-14 * frame.dt)
      if (ptr.x > 5) ptr.copy(frame.pointerRaw)
      else ptr.lerp(frame.pointerRaw, kp)

      // ---- the particle cloud
      const u = cloud.u
      u.uTime.value = t
      u.uReveal.value = rv
      u.uCondense.value = condense
      u.uFront.value = front
      u.uTravel.value = S * 0.9
      u.uHot.value = hot
      u.uSwirl.value = reduced ? 0.25 : 0.7
      u.uNebSpin.value = t * 0.085 * calm + local * 1.4
      u.uRingSpin.value = t * 0.14 * calm + local * 2.2
      u.uShellSpin.value = t * 0.03 * calm + local * 0.6
      u.uHaloK.value = 1 + dive * 0.35
      u.uOpacity.value = lerp(1, 0.86, settled) * (1 - dive * 0.35)
      u.uNearFade.value = lerp(0.9, 1.4, dive)
      u.uAspect.value = aspect
      u.uPtr.value.copy(ptr)
      u.uPtrK.value = ptrK
      u.uPtrR.value = lerp(lerp(0.17, 0.12, condense), 0.15, settled)
      const age = t - clickAt
      u.uClick.value.set(clickPos.x, clickPos.y, age >= 0 && age < 2 ? age : 99)
      // the split: behind the mark's centre → opaque list (refracted by the glass)
      if (glassOn) {
        tmpV.set(0, 0, 0).applyMatrix4(ctx.camera.matrixWorldInverse)
        u.uSplitZ.value = tmpV.z
      } else u.uSplitZ.value = 1e6

      // ---- the particle word: a quarter of the mark streams into 'listen.'
      if (wordDirty && wordReady) measureWord()
      u.uTextOn.value = wordOk ? 1 : 0
      u.uTextT.value = segment(local, 0.32, 0.49)
      u.uTextFade.value = sm(local, 0.505, 0.57)
      // a plane a little in front of the mark (so the word draws over the glass list)
      u.uTextD.value = Math.max(0.5, -pos.dot(F) * 0.82)
      u.uTextDrift.value = reduced ? 0 : 0.12

      // ---- the glass mark
      mark.pivot.visible = glassOn
      if (glassOn) {
        // clip: keep dot(p, dir) <= front (a little behind the particle front)
        const f = sweep >= 1 ? 1e4 : front - hot * 0.4
        localPlane.normal.set(-cloud.dir.x, -cloud.dir.y, 0)
        localPlane.constant = f
        group.updateMatrixWorld()
        mark.plane.copy(localPlane).applyMatrix4(group.matrixWorld)
        // idle float + sway (only once the sweep has passed, so glass and particles align)
        const free = settled
        // a turn that shows the glass's depth, settling at a slight three-quarter
        // (settling turned a touch TOWARD the camera — the shot sits the mark off-axis —
        // so the heart reads through the hooks' eyes)
        const turn = 0.3 * Math.sin(Math.PI * segment(local, 0.35, 0.55)) - 0.1 * sm(local, 0.42, 0.55)
        mark.pivot.rotation.set(
          (0.04 * Math.sin(t * 0.33 * calm) - 0.03) * free,
          turn + 0.08 * Math.sin(t * 0.41 * calm) * free,
          0.02 * Math.sin(t * 0.27 * calm) * free,
        )
        mark.pivot.position.set(0, 0.05 * Math.sin(t * 0.8 * calm) * free, 0)
        const coreK = smoothstep(0.42, 0.62, cross)
        mark.rimMat.uniforms.uStrength.value = 0.4 * smoothstep(0.2, 1, cross) * glassK
        glow.intensity = 0.55 * coreK
        // the heart: nodes ignite and links grow behind the same front as the glass
        mark.heart.update(t * calm, f, cloud.dir, hot, 1 + dive * 0.35, !reduced)
      } else {
        glow.intensity = 0
      }
      // the glass under the cut: visibility on the meshes (their walls and rims ride along)
      mark.logo.loopA.visible = !underCut
      mark.logo.loopB.visible = !underCut
      mark.loopMat.specularIntensity = glassK
      // (clearcoat stays > 0 on desktop: a 0 would switch the program)
      if (mark.coat > 0) mark.loopMat.clearcoat = Math.max(0.002, mark.coat * glassK)
      mark.wallMat.opacity = glassK
      mark.pivot.updateMatrixWorld()
      glow.position.copy(mark.coreCentre).multiplyScalar(S).applyMatrix4(mark.pivot.matrixWorld)

      // ---- the plexus ring (payoff): nodes spread out from the mark
      const grow = sm(local, 0.36, 0.48)
      const plexK = grow * (1 - smoothstep(0.945, 0.99, local))
      camLocal.copy(pos)
      viewLocal.copy(F)
      let ptrLocal: THREE.Vector3 | null = null
      if (ptrK > 0.01 && plexK > 0.01) {
        ray.setFromCamera(frame.pointerRaw, ctx.camera)
        plane.setFromNormalAndCoplanarPoint(F, tmpV.set(0, 0, 0))
        if (ray.ray.intersectPlane(plane, hit)) ptrLocal = hit
      }
      plexus.update(t, t * 0.14 * calm + local * 2.2, grow, plexK, ptrLocal, ptrK, S * 0.6, camLocal, viewLocal, glassOn)

      // ---- dust (the Particles.tsx look: magnetism toward the pointer)
      const still = reduced || mobile || !!frame.still
      dustPtr.x = damp(dustPtr.x, still ? 0 : frame.pointer.x, 3, frame.dt)
      dustPtr.y = damp(dustPtr.y, still ? 0 : frame.pointer.y, 3, frame.dt)
      dust.update(t * calm, dustPtr, 0.55 * rv * (1 - dive))

      // ---- world: night-blue studio, the network leaning toward the forming mark
      const wp = ctx.world.params
      wp.top = '#0c0f30'
      wp.bottom = '#05061a'
      wp.a = G.violet
      wp.b = '#56b4ff'
      // the network steps back while the particles take the stage, then returns
      // (and steps back again under the cut: the dots replace the image anyway)
      wp.net = lerp(lerp(0.55, 0.5, condense), 0.95, settled) * lerp(0.4, 1, rv) * (1 - smoothstep(0.35, 0.8, ctx.post.transition))
      wp.gather = 0.2 * Math.sin(Math.PI * segment(local, 0.08, 0.38)) * (1 - settled)
      wp.pointer = lerp(lerp(1, 0.55, condense), 0.75, settled)
      const yaw = Math.atan2(F.x, -F.z)
      const pitch = Math.asin(clamp(F.y, -1, 1))
      wp.focus.set(shot.sx * aspect + Math.sin(yaw) * 0.35, shot.sy + pitch * 0.3)
      // reflections: strong while the front sweeps (the light runs with it), then eased
      // so the settled glass reads clear (refraction over mirror)
      wp.env = lerp(lerp(0.9, 1.15, smoothstep(0.1, 0.6, cross)), 0.82, settled)
      // light sweep: runs with the crystallization front, then a slow glide every ~8 s
      let idleSweep = 0
      if (!reduced) {
        const cyc = t / 8
        const ph = cyc - Math.floor(cyc)
        const dir = Math.floor(cyc) % 2 === 0 ? 1 : -1
        idleSweep = 0.4 * dir * (sm(ph, 0.0, 0.4) * 2 - 1) * settled
      }
      wp.envTurn = -0.9 + 1.8 * smoothstep(0, 1, cross) + idleSweep + dive * 0.6
      wp.key = 1.5
      wp.keyDir.set(-0.5, 0.8, 0.55)
      wp.fill = 0.3

      // ---- post
      const pp = ctx.post.params
      pp.bloomStrength = lerp(0.75, 0.6, settled)
      pp.bloomRadius = 0.6
      pp.bloomThreshold = lerp(0.72, 0.85, settled)
      pp.vignette = 0.34
      pp.frost = Math.max(rFrost * 0.7, reduced ? 0 : 0.24 * smoothstep(0.955, 1, local))

      // ---- DOM
      // the intro holds through the condense: the manifesto to ~0.27, eyebrow + hint to ~0.35
      reveal(intro, 1 - smoothstep(0.3, 0.355, local))
      reveal(manifesto, 1 - smoothstep(0.21, 0.27, local))
      intro.classList.toggle('is-in', revealAt >= 0 && since > (reduced ? 0 : 0.45))
      // the payoff comes in as the glass locks, around the particle word
      reveal(payoff, smoothstep(0.44, 0.5, local) * (1 - smoothstep(0.925, 0.96, local)), 0)
      setRise(title, local > 0.455 && local < 0.945)
      // the DOM accent crossfades in over its particle twin (scroll-driven, not the rise)
      const acc = Math.round((wordOk ? sm(local, 0.495, 0.54) : sm(local, 0.46, 0.5)) * 100) / 100
      if (acc !== accentOn) {
        accentOn = acc
        title.style.setProperty('--gx-accent', String(acc))
      }
    },

    camera(_local: number, _frame: Frame, out: CameraPose) {
      out.position.copy(pos)
      out.target.copy(tgt)
      out.fov = fov
      out.roll = 0
      out.parallax = 0.25
    },
  }
}
