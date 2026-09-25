import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { el, rise, setRise } from '../../core/dom'
import { clamp, damp, lerp, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { SECTIONS, TESTIMONIALS } from '../../content'
import { G, edgeGlow, glass } from '../../kit/glass'
import { Dust } from '../../kit/particles'
import { EchoRings, EchoWave, lensUniforms, type VoiceSig } from './wave'
import './voices.css'

/*
 * ECHOES (voices) — "Hark" means listen, so the testimonials are heard.
 *
 * A luminous sound wave of particles runs across the frame and through a tall
 * glass lens (a flattened capsule, like a microphone's capsule) that bends the
 * living network behind it and magnifies the wave where it passes through.
 * Faint ripple rings of particles expand from the lens. Every client's voice
 * has its own wave signature — amplitude, frequency, strands, pace — and the
 * wave swirls from one to the next as the quotes change, starting at the lens
 * and rippling outward. The pointer plucks the wave; a click sends an echo.
 *
 *   0.000–0.095  intro: the particles gather into a calm listening line;
 *                "We listen. They talk." (settled at 0.06 and at 0.08)
 *   0.095–0.920  eight voices (~0.103 each): quote, name, company in the
 *                frosted panel; a 1–8 constellation progress row.
 *   0.920–1.000  out: the wave flattens to a calm line and dissolves.
 *
 * Everything story-shaped is derived from `local`; frame.time only drives the
 * idle travel of the wave, the ripples and the float of the lens.
 */

const N = TESTIMONIALS.length
const B0 = 0.095
const B1 = 0.92
const SPAN = (B1 - B0) / N
/** scroll hysteresis around every copy boundary */
const HYST = 0.006
/** the wave's morph window around each copy switch */
const PRE = 0.012
const POST = 0.036

/** the calm "listening" line of the intro, the eight voices, the flat line of the out-beat */
const ICE = G.ice
const VIOLET = G.violet
const LISTEN: VoiceSig = { amp: 0.09, freq: 3.2, strands: 3, speed: 1.0, harm: 0, ratio: 2, env: 2.6, spread: 0.55, c0: ICE, c1: VIOLET }
const FLAT: VoiceSig = { amp: 0.015, freq: 2.2, strands: 3, speed: 0.5, harm: 0, ratio: 1, env: 2.6, spread: 0.3, c0: ICE, c1: VIOLET }
const VOICES: VoiceSig[] = [
  // clean, concise, modern
  { amp: 0.82, freq: 1.75, strands: 3, speed: 1.0, harm: 0.08, ratio: 2.0, env: 2.2, spread: 0.5, c0: ICE, c1: VIOLET },
  // a holiday rush: quick, bright, a little warmth
  { amp: 0.95, freq: 3.3, strands: 5, speed: 1.7, harm: 0.32, ratio: 1.5, env: 1.9, spread: 0.62, c0: '#a99bff', c1: G.peach },
  // a turnaround: dense, many voices at once
  { amp: 1.08, freq: 2.4, strands: 7, speed: 1.3, harm: 0.46, ratio: 2.6, env: 2.4, spread: 0.3, c0: ICE, c1: '#dfe9ff' },
  // mellow, unhurried
  { amp: 0.58, freq: 1.3, strands: 4, speed: 0.65, harm: 0.14, ratio: 3.0, env: 2.8, spread: 0.5, c0: VIOLET, c1: '#e58cc8' },
  // glass: a fine shimmer
  { amp: 0.66, freq: 4.4, strands: 6, speed: 1.15, harm: 0.24, ratio: 1.25, env: 1.8, spread: 0.85, c0: '#bfe0ff', c1: ICE },
  // considered, balanced
  { amp: 0.86, freq: 2.0, strands: 5, speed: 0.85, harm: 0.28, ratio: 2.0, env: 2.3, spread: 0.42, c0: ICE, c1: VIOLET },
  // steady: on time, on budget
  { amp: 0.72, freq: 2.7, strands: 3, speed: 1.0, harm: 0, ratio: 1, env: 2.6, spread: 0.36, c0: G.white, c1: ICE },
  // bold
  { amp: 1.0, freq: 2.2, strands: 6, speed: 1.2, harm: 0.4, ratio: 1.75, env: 2.1, spread: 0.55, c0: VIOLET, c1: ICE },
]
const sigOf = (k: number) => (k < 0 ? LISTEN : k >= N ? FLAT : VOICES[k])

/** small camera glides per voice (lens units): each quote gets its own framing */
const CAM = [
  [0.0, 0.0],
  [0.22, 0.05],
  [-0.16, -0.04],
  [0.26, 0.06],
  [-0.12, 0.03],
  [0.2, -0.05],
  [-0.22, 0.04],
  [0.1, -0.03],
  [0.0, 0.0],
  [0.0, 0.0],
]

interface Track {
  /** signature we come from (-1 listen, 0..N-1 voices, N flat) */
  from: number
  to: number
  /** raw 0..1 through the morph */
  raw: number
}

function trackAt(local: number, out: Track): Track {
  out.from = -1
  out.to = -1
  out.raw = 0
  for (let i = 0; i <= N; i++) {
    const s = i < N ? B0 + i * SPAN : B1
    const a = i === 0 ? B0 - PRE : s - PRE
    const b = i === N ? B1 + 0.03 : s + POST
    if (local < a) break
    out.from = i - 1
    out.to = i
    out.raw = clamp((local - a) / (b - a))
    if (local < b) break
    out.from = i
    out.raw = 0
  }
  return out
}

/** gentle start, long settle */
const settle = (t: number) => {
  const x = clamp(t)
  return 1 - (1 - x) * (1 - x) * (1 - x)
}

interface Layout {
  portrait: boolean
  fov: number
  dist: number
  /** lens centre (world, z = 0 plane) */
  lx: number
  ly: number
  /** lens unit (the lens is LENS_D units across) */
  unit: number
  /** visible half-width at z = 0 */
  halfW: number
}

export default function create(): Chapter {
  const group = new THREE.Group()
  const lensU = lensUniforms()
  let wave: EchoWave
  let rings: EchoRings
  let dust: Dust
  const lensRoot = new THREE.Group()
  const lensTilt = new THREE.Group()
  lensRoot.add(lensTilt)
  let lensMesh: THREE.Mesh
  let rimMesh: THREE.Mesh
  /** lens radius (lens units) and its depth squash: a biconvex disc */
  const LENS_R = 1.55
  const LENS_T = 0.27
  /** the lens diameter in lens units */
  const LENS_D = 2 * LENS_R

  // DOM
  let intro: HTMLElement
  let introTitle: HTMLElement
  let panel: HTMLElement
  let stack: HTMLElement
  let meta: HTMLElement
  let count: HTMLElement
  let fill: HTMLElement
  let dots: HTMLElement[] = []
  const cards: { root: HTMLElement; parts: HTMLElement[]; h: number }[] = []
  let shown = -2 // -2 fresh, -1 intro, 0..N-1 card, N out
  let stackH = -1
  let deferShow = 0
  /** measured layout (px), read on resize / card-size changes only */
  const lay = { safeTop: 0, introBottom: 0, panelBottom: 0, maxPanel: 0, h: 0, w: 0 }

  // pointer
  let mouseOn = false
  let ptrK = 0
  const ptrWorld = new THREE.Vector3(0, 0, 0)
  const ptrTarget = new THREE.Vector3()
  const ray = new THREE.Raycaster()
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
  let clickAt = -1e9
  const clickPos = new THREE.Vector3()
  let tIdle = 0
  const tilt = { x: 0, y: 0 }

  const trk: Track = { from: -1, to: -1, raw: 0 }
  const L: Layout = { portrait: false, fov: 34, dist: 10, lx: 0, ly: 0, unit: 1, halfW: 5 }
  const zero = new THREE.Vector2()
  const tmpV = new THREE.Vector3()
  const tmpC = new THREE.Vector3()
  const camRight = new THREE.Vector3()
  const camUp = new THREE.Vector3()

  /* ------------------------------------------------------------ layout */

  function layout(f: Frame, local: number, out: Layout) {
    const w = f.width
    const H = f.height
    const aspect = w / Math.max(1, H)
    out.portrait = aspect <= 1
    if (!out.portrait) {
      out.fov = 34
      out.dist = 10
      const halfH = out.dist * Math.tan(THREE.MathUtils.degToRad(out.fov / 2))
      out.halfW = halfH * aspect
      // the lens stands in the free area right of the copy panel
      const short = H <= 500
      const gutter = clamp(0.034 * w, 16, 48)
      const panelW = short ? Math.min(440, 0.46 * w) : Math.min(520, 0.4 * w)
      const freeC = (gutter + panelW + w) / 2
      const nx = clamp((freeC / w) * 2 - 1, 0.18, 0.5)
      out.lx = nx * out.halfW
      out.ly = (short ? 0.02 : 0.07) * halfH
      // ~58% of the frame's height, but never reaching over the panel on squarer screens
      const panelRight = ((gutter + panelW) / w) * 2 - 1
      out.unit = Math.min((0.58 * 2 * halfH) / LENS_D, ((nx - panelRight) * 0.95 * out.halfW) / LENS_R)
    } else {
      out.fov = 40
      out.dist = 10
      const halfH = out.dist * Math.tan(THREE.MathUtils.degToRad(out.fov / 2))
      out.halfW = halfH * aspect
      // the subject lives in the window between the chrome and the panel,
      // sized for the TALLEST quote so the framing never jumps between voices
      // stage px (from the top) map straight onto the canvas, which shares its
      // top edge (the canvas may be taller: 100lvh), so only the width must match
      const measured = lay.h > 0 && Math.abs(lay.w - w) < 2
      const safeTop = measured ? lay.safeTop : clamp(0.105 * H, 80, 112)
      const panelBottom = measured ? lay.panelBottom : H - clamp(0.105 * H, 82, 110)
      // quotes: between the chrome and the tallest card; the intro: below the headline
      const qTop = safeTop
      const qBot = (measured ? panelBottom - lay.maxPanel : panelBottom - 0.4 * H) - 14
      const iTop = (measured ? lay.introBottom : safeTop + 0.2 * H) + 10
      const iBot = panelBottom - 8
      // the lens rises from under the headline into the quote framing with the first voice
      const k = smoothstep(B0 - PRE, B0 + POST * 0.8, local)
      const top = lerp(iTop, qTop, k)
      const bot = lerp(iBot, qBot, k)
      const region = Math.max(120, bot - top)
      const cy = 1 - (top + bot) / H
      const regionW = (region / H) * 2 * halfH
      out.lx = 0
      out.ly = cy * halfH
      out.unit = Math.min((0.84 * regionW) / LENS_D, (0.8 * 2 * out.halfW) / LENS_D)
    }
  }

  /* -------------------------------------------------------------- DOM */

  function buildDom(stage: HTMLElement) {
    intro = el('div', 'ec-intro', undefined, stage)
    el('p', 'hud-eyebrow ec-eyebrow', SECTIONS.voices.eyebrow, intro)
    const m = SECTIONS.voices.title.match(/^(.*?\.)\s+(.*)$/)
    const html = m ? `${m[1]} <em>${m[2]}</em>` : SECTIONS.voices.title
    introTitle = rise(el('h2', 'hud-h2 ec-title', undefined, intro), html)

    panel = el('figure', 'ec-panel hud-panel hud-panel--strong', undefined, stage)
    meta = el('div', 'ec-meta', undefined, panel)
    count = el('p', 'ec-count', '', meta)
    const track = el('div', 'ec-track', undefined, meta)
    el('span', 'ec-line', undefined, track)
    fill = el('span', 'ec-fill', undefined, track)
    dots = TESTIMONIALS.map(() => el('i', '', undefined, track))
    stack = el('div', 'ec-stack', undefined, panel)
    TESTIMONIALS.forEach(t => {
      const root = el('div', 'ec-card', undefined, stack)
      if (t.quote.length > 170) root.classList.add('ec-card--long')
      const q = rise(el('blockquote', 'hud-quote ec-quote', undefined, root), `“${t.quote}”`)
      const who = el('p', 'ec-who', undefined, root)
      const name = rise(el('span', 'hud-label ec-name', undefined, who), t.name)
      const co = rise(el('span', 'hud-label ec-co', undefined, who), t.company)
      cards.push({ root, parts: [q, name, co], h: 0 })
    })
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(entries => {
        for (const e of entries) {
          const c = cards.find(k => k.root === e.target)
          if (c) c.h = (e.target as HTMLElement).offsetHeight
        }
        applyStackHeight()
        measure()
      })
      cards.forEach(c => ro.observe(c.root))
      ro.observe(meta)
      ro.observe(intro)
    }
    window.addEventListener('resize', measure)
    measure()
  }

  function measure() {
    const cs = getComputedStyle(panel)
    const gap = parseFloat(cs.rowGap) || 0
    const chrome = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + gap + meta.offsetHeight
    let tallest = 0
    for (const c of cards) tallest = Math.max(tallest, c.h || c.root.offsetHeight)
    lay.safeTop = intro.offsetTop
    lay.introBottom = intro.offsetTop + intro.offsetHeight
    lay.panelBottom = panel.offsetTop + panel.offsetHeight
    lay.maxPanel = chrome + tallest
    lay.h = window.innerHeight
    lay.w = window.innerWidth
  }

  function applyStackHeight(snap = false) {
    if (shown < 0 || shown >= N) return
    const c = cards[shown]
    const h = c.h || (c.h = c.root.offsetHeight)
    if (h && h !== stackH) {
      stackH = h
      if (snap) stack.style.transition = 'none'
      stack.style.height = `${h}px`
      if (snap) {
        void stack.offsetHeight
        stack.style.transition = ''
      }
    }
  }

  function setCard(i: number, on: boolean) {
    const c = cards[i]
    if (!c) return
    c.root.classList.toggle('is-on', on)
    for (const p of c.parts) setRise(p, on)
  }

  function sinkAll() {
    for (let i = 0; i < N; i++) setCard(i, false)
    setRise(introTitle, false)
    intro.classList.remove('is-on')
    panel.classList.remove('is-on')
    shown = -2
    stackH = -1
  }

  function wantAt(local: number) {
    let want = local < B0 ? -1 : local >= B1 ? N : Math.min(N - 1, Math.floor((local - B0) / SPAN))
    if (shown >= -1 && want !== shown && Math.abs(want - shown) === 1) {
      const hi = Math.max(want, shown)
      const boundary = hi >= N ? B1 : B0 + hi * SPAN
      if (Math.abs(local - boundary) < HYST) want = shown
    }
    return want
  }

  function show(next: number) {
    if (next === shown) return
    const wasCard = shown >= 0 && shown < N
    if (wasCard) setCard(shown, false)
    shown = next
    const isCard = next >= 0 && next < N
    panel.classList.toggle('is-on', isCard)
    if (isCard) {
      setCard(next, true)
      count.innerHTML = `<b>${String(next + 1).padStart(2, '0')}</b> / ${String(N).padStart(2, '0')}`
      dots.forEach((d, i) => {
        d.classList.toggle('is-on', i === next)
        d.classList.toggle('is-past', i < next)
      })
      fill.style.transform = `scaleX(${(next / (N - 1)).toFixed(4)})`
      applyStackHeight(!wasCard)
    }
  }

  /* ------------------------------------------------------------ lens */

  function buildLens(mobile: boolean) {
    const geo = new THREE.SphereGeometry(LENS_R, mobile ? 64 : 112, mobile ? 40 : 72)
    geo.scale(1, 1, LENS_T)
    geo.computeBoundingSphere()
    const mat = glass({ thickness: 1.5, ior: 1.52, dispersion: 0.55, iridescence: 0.18, coat: 0.6, env: 1.1 })
    lensMesh = new THREE.Mesh(geo, mat)
    // a fresnel rim of light so the silhouette reads against the night
    rimMesh = new THREE.Mesh(geo, edgeGlow('#a9c8ff', 3, 0.55))
    rimMesh.scale.setScalar(1.006)
    rimMesh.renderOrder = 2
    lensTilt.add(lensMesh, rimMesh)
    group.add(lensRoot)
  }

  /** project the lens silhouette to screen space for the particles' fake refraction */
  function updateLensUniforms(camera: THREE.Camera) {
    const cam = camera as THREE.PerspectiveCamera
    lensRoot.updateMatrixWorld()
    lensMesh.getWorldPosition(tmpC)
    camRight.setFromMatrixColumn(cam.matrixWorld, 0).normalize()
    camUp.setFromMatrixColumn(cam.matrixWorld, 1).normalize()
    const s = lensRoot.scale.x
    // a turned disc: its silhouette narrows toward its (thinner) depth
    const ry = lensTilt.rotation.y
    const rx0 = lensTilt.rotation.x
    const rEff = s * LENS_R * Math.hypot(Math.cos(ry), LENS_T * Math.sin(ry))
    const halfTall = s * LENS_R * Math.hypot(Math.cos(rx0), LENS_T * Math.sin(rx0))
    const aspect = cam.aspect || 1
    tmpV.copy(tmpC).project(cam)
    const cx = tmpV.x * aspect
    const cy = tmpV.y
    tmpV.copy(tmpC).addScaledVector(camRight, rEff).project(cam)
    const rx = Math.abs(tmpV.x * aspect - cx)
    tmpV.copy(tmpC).addScaledVector(camUp, halfTall).project(cam)
    const hy = Math.abs(tmpV.y - cy)
    if (![cx, cy, rx, hy].every(Number.isFinite)) return
    lensU.uLens.value.set(cx, cy, rx, hy)
    lensU.uAspect.value = aspect
  }

  /* ----------------------------------------------------------- chapter */

  return {
    id: 'voices',
    group,
    // keyboard stops land on each voice once the wave has settled and the quote is sharp
    anchors: TESTIMONIALS.map((_, i) => B0 + SPAN * (i + 0.58)),

    async init(ctx: ChapterContext) {
      buildDom(ctx.stage)
      const mobile = ctx.mobile
      buildLens(mobile)
      await nextFrame()
      wave = new EchoWave(mobile ? 4200 : 11000, lensU)
      rings = new EchoRings(mobile ? 260 : 620, lensU)
      dust = new Dust({
        count: mobile ? 90 : 220,
        box: new THREE.Box3(new THREE.Vector3(-8, -4.5, -3), new THREE.Vector3(8, 4.5, 2.5)),
        size: 0.022,
        color: '#cfe0ff',
      })
      group.add(rings.points, wave.points, dust.points)
      // the lens projection is read at draw time, with the camera that draws it
      wave.points.onBeforeRender = (_r, _s, camera) => updateLensUniforms(camera)
      await nextFrame()

      window.addEventListener('pointermove', e => {
        if (e.pointerType === 'mouse') mouseOn = true
      })
      document.documentElement.addEventListener('pointerleave', () => (mouseOn = false))
    },

    onEnter() {
      // every entry replays the focus pull: sink whatever an earlier visit (or
      // the engine's prewarm) left in, and show the copy a frame later so the
      // rise transitions actually run
      sinkAll()
      deferShow = 1
    },

    onLeave() {
      sinkAll()
    },

    onPointerDown(frame, ctx) {
      if (ctx.reducedMotion || frame.still || ctx.mobile) return
      if (tIdle - clickAt < 0.45) return
      ray.setFromCamera(frame.pointerRaw, ctx.camera)
      if (!ray.ray.intersectPlane(plane, clickPos)) return
      clickAt = tIdle
      rings.u.uClick.value.set(clickPos.x, clickPos.y, clickPos.z, 0)
    },

    update(local, frame, ctx) {
      const rm = frame.reducedMotion
      const calm = rm || !!frame.still
      tIdle = frame.time * (rm ? 0.15 : 1)
      layout(frame, local, L)
      const U = L.unit
      const tr = trackAt(local, trk)
      const arc = tr.raw > 0 && tr.raw < 1 ? Math.sin(Math.PI * tr.raw) : 0

      /* ---- the lens: floats, swivels a touch on each new voice, leans toward the pointer ---- */
      const introK = smoothstep(0.0, 0.06, local)
      const outK = smoothstep(0.93, 1.0, local)
      lensRoot.position.set(L.lx, L.ly + (rm ? 0 : Math.sin(tIdle * 0.5) * 0.04 * U) - (1 - introK) * 0.35 * U, 0)
      lensRoot.scale.setScalar(U * lerp(0.9, 1, introK) * lerp(1, 0.96, outK))
      const mouse = mouseOn && !calm && !ctx.mobile
      ptrK = damp(ptrK, mouse ? 1 : 0, 3, frame.dt)
      tilt.y = damp(tilt.y, mouse ? frame.pointerRaw.x * 0.22 : 0, 2.5, frame.dt)
      tilt.x = damp(tilt.x, mouse ? -frame.pointerRaw.y * 0.12 : 0, 2.5, frame.dt)
      const dir = tr.to > tr.from ? 1 : -1
      lensTilt.rotation.set(
        tilt.x + (rm ? 0 : Math.sin(tIdle * 0.37) * 0.03),
        -0.52 + tilt.y + (rm ? 0 : Math.sin(tIdle * 0.23) * 0.07) + (rm ? 0 : 0.4 * arc * dir),
        rm ? 0 : Math.sin(tIdle * 0.19) * 0.025,
      )

      /* ---- the wave ---- */
      const D = L.dist
      const wz = -0.9 * U
      const depthK = (D - wz) / D
      const px = ctx.renderer.domElement.height
      const scatter = Math.max(1 - smoothstep(0.0, 0.058, local), smoothstep(0.945, 1.0, local))
      const wu = wave.u
      wave.setVoices(sigOf(tr.from), sigOf(tr.to), tr.raw)
      wu.uTime.value = tIdle
      wu.uUnit.value = U
      wu.uY.value = L.ly * depthK
      wu.uZ.value = wz
      wu.uSpan.value.set(L.lx * depthK, -L.halfW * depthK * 1.1, L.halfW * depthK * 1.1)
      wu.uPhase.value = local * 14
      wu.uSwirl.value = calm ? 0 : 0.75
      wu.uSize.value = 0.032 * lerp(U, 1, 0.5)
      wu.uPx.value = px
      wu.uScatter.value = scatter
      wu.uOpacity.value = lerp(0.75, 0.55, outK)

      // pointer on the wave's plane (damped): plucks and swells the ribbon
      plane.constant = -wz
      ray.setFromCamera(frame.pointerRaw, ctx.camera)
      if (ray.ray.intersectPlane(plane, ptrTarget)) {
        const k = 1 - Math.exp(-10 * frame.dt)
        ptrWorld.lerp(ptrTarget, ptrWorld.lengthSq() === 0 ? 1 : k)
      }
      const nearLine = 1 - smoothstep(0.7 * U, 2.4 * U, Math.abs(ptrWorld.y - L.ly * depthK))
      wu.uPtr.value.set(ptrWorld.x, ptrWorld.y, ptrWorld.z, ptrK * (1 - scatter))
      wu.uSwell.value.set(ptrWorld.x, ptrK * nearLine * (1 - scatter))

      /* ---- the ripple rings ---- */
      const ru = rings.u
      const rz = -1.5 * U
      const rK = (D - rz) / D
      ru.uTime.value = tIdle
      ru.uUnit.value = U
      ru.uCenter.value.set(L.lx * rK, L.ly * rK, rz)
      ru.uSize.value = 0.028 * lerp(U, 1, 0.5)
      ru.uPx.value = px
      ru.uR0.value = 0.4
      ru.uR1.value = L.portrait ? 3.6 : 5.2
      ru.uOpacity.value = 0.6 * introK * (1 - outK * 0.7)
      ru.uSpeed.value = 0.05
      const age = tIdle - clickAt
      ru.uClick.value.w = age >= 0 && age < 3 && !calm ? age : -1
      // the lens bends the particles only once it has arrived
      lensU.uLensOn.value = introK

      dust.update(tIdle, calm || ctx.mobile ? zero : frame.pointer, 0.45 * introK)

      /* ---- light: night-blue studio, network gathered behind the lens ---- */
      const w = ctx.world.params
      const aspect = frame.width / Math.max(1, frame.height)
      w.top = '#070920'
      w.bottom = '#03040f'
      w.a = '#3b2f9e'
      w.b = '#1d4aa8'
      w.node = '#b8cdf2'
      w.line = G.ice
      w.net = 0.55
      w.density = 1.05
      w.speed = 0.7
      const ndcX = L.lx / L.halfW
      const halfH = L.dist * Math.tan(THREE.MathUtils.degToRad(L.fov / 2))
      w.focus.set(ndcX * aspect, L.ly / halfH)
      w.gather = 0.1
      w.pointer = 0.55
      // at rest the studio leaves the lens's centre clear (a glint and a rim
      // arc up top); each new voice runs a light strip across the glass
      w.envTurn = rm ? 0 : 1.3 * arc
      w.env = 1.15 + (rm ? 0 : 0.25 * arc)
      w.key = 1.3
      w.keyDir.set(-0.5, 0.8, 0.6)
      w.fill = 0.3

      const post = ctx.post.params
      post.bloomStrength = 0.52
      post.bloomRadius = 0.5
      post.bloomThreshold = 0.93
      post.vignette = 0.36
      // a breath of frost as one voice hands over to the next (a focus pull)
      post.frost = rm ? 0 : 0.1 * arc * (tr.from >= 0 && tr.to < N ? 1 : 0.4)

      /* ---- DOM ---- */
      if (deferShow > 0) {
        deferShow--
        return
      }
      show(wantAt(local))
      setRise(introTitle, shown === -1 && local > 0.012)
      intro.classList.toggle('is-on', shown === -1)
    },

    camera(local: number, frame: Frame, out: CameraPose) {
      layout(frame, local, L)
      const tr = trackAt(local, trk)
      const U = L.unit
      const t = settle(tr.raw)
      const a = CAM[tr.from + 1] ?? CAM[0]
      const b = CAM[tr.to + 1] ?? CAM[0]
      const ox = lerp(a[0], b[0], t) * U * (L.portrait ? 0.4 : 1)
      const oy = lerp(a[1], b[1], t) * U
      const arc = tr.raw > 0 && tr.raw < 1 ? Math.sin(Math.PI * tr.raw) : 0
      // the intro drifts in from a touch further back
      const inK = smoothstep(0.0, 0.08, local)
      const calm = frame.reducedMotion ? 0 : 1
      out.position.set(ox, oy, L.dist + arc * 0.35 * U * calm + (1 - inK) * 0.8 * calm)
      out.target.set(ox * 0.6, oy * 0.6, 0)
      out.fov = L.fov
      out.roll = 0
      out.parallax = frame.reducedMotion ? 0 : 0.22
    },
  }
}
