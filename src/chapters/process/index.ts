import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { el, rise, setRise, reveal } from '../../core/dom'
import { PROCESS, STATS } from '../../content'
import { clamp, ease, lerp, segment, smoothstep, window01 } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { G, edgeGlow, etch, glass, pane } from '../../kit/glass'
import { Constellation, Dust } from '../../kit/particles'
import { Flow } from './flow'
import { buildFlow, PAGE_H, PAGE_W, SLABS } from './layout'
import { TileSparkles } from './sparkles'
import './process.css'

/*
 * FLOW — "We listen first. Then we build."   CHAOS → ORDER, through glass.
 *
 * Four tall glass panes stand in a gentle arc, each etched with a step. One
 * particle system (~10k points) flows through them and is re-formed by each:
 *
 *   01 LISTEN     noise (a particles.js constellation + a cloud of dust)
 *                 is drawn toward the first pane and aligns into a sound wave
 *   02 PROTOTYPE  the wave streams through the second pane and snaps into the
 *                 wireframe of a web page (hairlines, design grid, a button)
 *   03 BUILD      the layout streams on and tightens into dense solid blocks;
 *                 small glass slabs grow where the particles were densest
 *   04 SUPPORT    the finished glass form glides to the last pane; the
 *                 particles unwind into a steady orbit around it (a slow
 *                 heartbeat; a comet keeps watch)
 *   RESULTS       the orbit unspools into one flow through all four panes;
 *                 three stat tiles resolve out of frost and sparkles settle
 *                 on them
 *
 * Everything is derived from `local`; frame.time only drives idle motion.
 */

// ---------------------------------------------------------------- layout

const UP = new THREE.Vector3(0, 1, 0)
const STEP = 4.8
const ARC = 0.32
const YAW = -0.26
const PANE_W = 2.3
const PANE_H = 3.05
const PANE_D = 0.18
const PANE_B = 0.065
const FACE_Z = PANE_D / 2 + PANE_B + 0.004
const PANES = [0, 1, 2, 3].map(k => new THREE.Vector3(k * STEP, 0, -ARC * Math.sin((Math.PI * k) / 3)))
/** each form floats in front of the upper part of its pane */
const FORM_LOCAL = new THREE.Vector3(0, 0.32, 0.46)
const FORMS = PANES.map(p => p.clone().add(FORM_LOCAL.clone().applyAxisAngle(UP, YAW)))
const LINE_MID = new THREE.Vector3(STEP * 1.5, 0.3, -ARC * 0.8)
const RING_R = 1.5

// ---------------------------------------------------------------- timeline
//
// The chapter cut (the frame breaking into dots) covers local 0–0.082 and
// 0.918–1, so every piece of copy lives inside [0.086, 0.91].

/** the headline comes in just past the opening cut (settled by the heading stop, 0.12) */
const HEAD_IN = 0.086
/** step 01 starts here (the card, landscape; the fills count from it) */
const A = 0.14
/**
 * The card changes step at the MIDPOINT of each camera glide between panes
 * (0.285→0.378, 0.445→0.538, 0.605→0.70), so it always names the pane in
 * view; the panes' rims hand over at the same moments.
 */
const BOUNDS = [0.332, 0.492, 0.652] as const
/** the step card leaves as the camera pulls back for the results */
const CARD_END = 0.77
/** keyboard stops: each pane once the camera has settled on it, then the stats */
const ANCHORS = [0.236, 0.388, 0.548, 0.708]
const STATS_AT = 0.865
/** uStage windows: chaos→wave, wave→wire, wire→blocks, blocks→ring, ring→stream */
const STAGE_WIN: [number, number][] = [
  [0.1, 0.236],
  [0.29, 0.372],
  [0.45, 0.532],
  [0.61, 0.692],
  [0.757, 0.845],
]
const GLIDE: [number, number] = [0.612, 0.69]
/** the results: the camera pulls back down the line while the frost comes and clears */
const RESULTS: [number, number] = [0.755, 0.85]
/** stat tiles on → off: the beat is over before the closing cut starts (~0.918) */
const TILES = [0.785, 0.905] as const

// 10 years, $1M+, 15 — in that order
const SHOW = [STATS[0], STATS[2], STATS[1]]

// ---------------------------------------------------------------- camera

interface Key {
  t: number
  pos: THREE.Vector3
  tgt: THREE.Vector3
  fov: number
  focus: THREE.Vector3
  lift?: number
}
const DEG = Math.PI / 180
const _f = new THREE.Vector3()
const _r = new THREE.Vector3()
const _u = new THREE.Vector3()

/** a key orbiting `c` (phi: degrees from the left-front) with `c` placed at screen offset (sx, sy) */
function orbit(t: number, c: THREE.Vector3, phi: number, d: number, elev: number, sx: number, sy: number, aspect: number, fov: number, lift = 0): Key {
  const p = phi * DEG
  const e = elev * DEG
  const pos = new THREE.Vector3(c.x - Math.sin(p) * Math.cos(e) * d, c.y + Math.sin(e) * d, c.z + Math.cos(p) * Math.cos(e) * d)
  _f.subVectors(c, pos).normalize()
  _r.crossVectors(_f, UP).normalize()
  _u.crossVectors(_r, _f)
  const halfH = Math.tan((fov * DEG) / 2) * d
  const tgt = c.clone().addScaledVector(_r, -sx * halfH * aspect).addScaledVector(_u, -sy * halfH)
  return { t, pos, tgt, fov, focus: c.clone(), lift }
}

/** the Listen pane's top rim in world space: along its flat top edge, front and back */
const PANE0_TOP = [-1, 0, 1].flatMap(sx =>
  [-1, 1].map(sz =>
    new THREE.Vector3(sx * (PANE_W / 2 - 0.24), PANE_H / 2 + PANE_B, sz * (PANE_D / 2 + PANE_B)).applyAxisAngle(UP, YAW).add(PANES[0]),
  ),
)
const _cam = new THREE.PerspectiveCamera(40, 1, 0.1, 200)
const _kp = new THREE.Vector3()
const _kt = new THREE.Vector3()
const _kf = new THREE.Vector3()
const _kq = new THREE.Vector3()

/** screen y (CSS px from the top) of the highest point of the Listen pane's rim at `local` */
function paneTop(keys: Key[], local: number, aspect: number, H: number): number {
  _cam.fov = sample(keys, local, _kp, _kt, _kf)
  _cam.aspect = aspect
  _cam.updateProjectionMatrix()
  _cam.position.copy(_kp)
  _cam.lookAt(_kt)
  _cam.updateMatrixWorld()
  let top = H
  for (const v of PANE0_TOP) {
    _kq.copy(v).project(_cam)
    if (_kq.z < 1 && Number.isFinite(_kq.y)) top = Math.min(top, ((1 - _kq.y) / 2) * H)
  }
  return top
}

/**
 * Portrait keys. The opening frames the chaos, then the LANDING (the headline
 * still up, the card not yet) frames the Listen pane below the headline; as
 * the headline leaves and the card rises, the pane lifts into the space above
 * the card. `headB` is the headline's bottom (CSS px): the landing framing is
 * lowered — and if need be pulled back — until the pane's rim clears it by
 * 16px at every local the headline shows (a short phone's headline takes a
 * bigger share of the screen, so an aspect-only lift would cut through it).
 */
function portraitKeys(aspect: number, H: number, headB: number): Key[] {
  const tall = clamp((0.62 - aspect) / 0.16) // 0 at tablet, 1 at phone
  const back = 1 + 0.12 * tall
  const sy = lerp(0.26, 0.34, tall)
  const fov = 46
  const chaosP = new THREE.Vector3(0.9, 0.25, 0)
  const build = (syC: number, syL: number, dL: number): Key[] => {
    const k: Key[] = []
    k.push(orbit(0, chaosP, 30, 12.5 * back, 7, 0, syC, aspect, fov))
    k.push(orbit(0.1, chaosP, 28, 11.8 * back, 7, 0, syC, aspect, fov))
    k.push(orbit(0.19, FORMS[0], 18.6, dL, 6, 0, syL, aspect, fov))
    k.push(orbit(0.2, FORMS[0], 18.3, dL * 0.995, 6, 0, syL, aspect, fov))
    k.push(orbit(0.232, FORMS[0], 17.6, 8.85 * back, 6, 0, sy, aspect, fov))
    k.push(orbit(0.285, FORMS[0], 16, 8.6 * back, 6, 0, sy, aspect, fov))
    k.push(orbit(0.378, FORMS[1], 12, 7.6 * back, 5, 0, sy, aspect, fov, 0.5))
    k.push(orbit(0.445, FORMS[1], 10, 7.4 * back, 5, 0, sy, aspect, fov))
    k.push(orbit(0.538, FORMS[2], 10, 7.5 * back, 5, 0, sy, aspect, fov, 0.45))
    k.push(orbit(0.605, FORMS[2], 9, 7.3 * back, 5, 0, sy, aspect, fov))
    k.push(orbit(0.7, FORMS[3], 16, 9.4 * back, 8, 0, sy, aspect, fov, 0.35))
    k.push(orbit(RESULTS[0], FORMS[3], 18, 9.1 * back, 8, 0, sy, aspect, fov))
    // results: straight down the line — the four panes stack in depth, the flow threads them
    const endC = new THREE.Vector3(STEP * 1.75, 0.3, -ARC)
    const ey = lerp(0.3, 0.37, tall)
    k.push(orbit(RESULTS[1], endC, 66, 15.5 * back, 9, 0.02, ey, aspect, fov))
    k.push(orbit(0.95, endC, 64, 15 * back, 9, 0.02, ey, aspect, fov))
    k.push(orbit(1, endC, 63, 15.3 * back, 9.5, 0.02, ey, aspect, fov))
    return k
  }
  let syC = 0.1
  let syL = sy
  let dL = 8.95 * back
  let keys = build(syC, syL, dL)
  if (headB <= 0 || H <= 0) return keys
  const need = headB + 16
  for (let it = 0; it < 12; it++) {
    // the headline is up from HEAD_IN until it has faded (~0.2 in portrait)
    let worst = 0
    let worstAt = 0
    for (let l = HEAD_IN; l <= 0.2001; l += 0.006) {
      const v = need - paneTop(keys, l, aspect, H)
      if (v > worst) {
        worst = v
        worstAt = l
      }
    }
    if (worst < 0.5) break
    const dy = ((worst + 2) * 2) / H // px → NDC
    if (worstAt <= 0.1) syC -= dy
    else if (syL - dy >= sy - 0.45) syL -= dy
    else dL *= 1.06
    keys = build(syC, syL, dL)
  }
  return keys
}

function keysFor(aspect: number, H: number, headB: number): Key[] {
  if (aspect < 0.9) return portraitKeys(aspect, H, headB)
  const k: Key[] = []
  const chaosC = new THREE.Vector3(1.6, 0.25, 0)
  const narrow = clamp((1.6 - aspect) / 0.6) // 0 at 16:10, 1 at 1:1
  const back = 1 + 0.2 * narrow
  const sx = 0.26 + 0.1 * narrow
  k.push(orbit(0, chaosC, 38, 12.5 * back, 7, 0.16 + 0.08 * narrow, -0.04, aspect, 36))
  k.push(orbit(0.1, chaosC, 36, 11.6 * back, 7, 0.16 + 0.08 * narrow, -0.04, aspect, 36))
  k.push(orbit(0.215, FORMS[0], 30, 7.4 * back, 6, sx, 0.02, aspect, 34))
  k.push(orbit(0.285, FORMS[0], 28, 7.1 * back, 6, sx, 0.02, aspect, 34))
  k.push(orbit(0.378, FORMS[1], 20, 6.9 * back, 5, sx, 0.03, aspect, 34, 0.14))
  k.push(orbit(0.445, FORMS[1], 18, 6.7 * back, 5, sx, 0.03, aspect, 34))
  k.push(orbit(0.538, FORMS[2], 16, 6.8 * back, 5, sx, 0.03, aspect, 34, 0.12))
  k.push(orbit(0.605, FORMS[2], 15, 6.6 * back, 5, sx, 0.03, aspect, 34))
  k.push(orbit(0.7, FORMS[3], 24, 8.1 * back, 8, sx, 0.02, aspect, 34, 0.1))
  k.push(orbit(RESULTS[0], FORMS[3], 26, 7.8 * back, 8, sx, 0.02, aspect, 34))
  // results: down the line in perspective, the flow snaking through every pane
  const endC = new THREE.Vector3(STEP * 1.3, 0.35, -ARC)
  k.push(orbit(RESULTS[1], endC, 30, 17.2 * (1 + 0.22 * narrow), 8, 0.02, 0.24, aspect, 36))
  k.push(orbit(0.95, endC, 32, 16.8 * (1 + 0.22 * narrow), 8, 0.02, 0.24, aspect, 36))
  k.push(orbit(1, endC, 33, 17 * (1 + 0.22 * narrow), 8.5, 0.02, 0.24, aspect, 36))
  return k
}

const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

function sample(keys: Key[], local: number, pos: THREE.Vector3, tgt: THREE.Vector3, focus: THREE.Vector3): number {
  if (local <= keys[0].t) {
    pos.copy(keys[0].pos)
    tgt.copy(keys[0].tgt)
    focus.copy(keys[0].focus)
    return keys[0].fov
  }
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]
    const b = keys[i + 1]
    if (local <= b.t) {
      const e = smoother(segment(local, a.t, b.t))
      pos.lerpVectors(a.pos, b.pos, e)
      tgt.lerpVectors(a.tgt, b.tgt, e)
      focus.lerpVectors(a.focus, b.focus, e)
      if (b.lift) pos.sub(tgt).multiplyScalar(1 + b.lift * Math.sin(Math.PI * e)).add(tgt)
      return lerp(a.fov, b.fov, e)
    }
  }
  const z = keys[keys.length - 1]
  pos.copy(z.pos)
  tgt.copy(z.tgt)
  focus.copy(z.focus)
  return z.fov
}

/** 0..5: which shape the flow is in (fractional = travelling) */
function stageAt(local: number): number {
  let s = 0
  for (const [a, b] of STAGE_WIN) s += segment(local, a, b)
  return s
}

// ---------------------------------------------------------------- chapter

export default function create(): Chapter {
  const group = new THREE.Group()
  let ctxRef: ChapterContext | null = null
  let flow: Flow
  let net: Constellation
  let dust: Dust
  const panes: THREE.Mesh[] = []
  const rims: THREE.ShaderMaterial[] = []
  const labelMats: { name: THREE.MeshBasicMaterial; num: THREE.MeshBasicMaterial }[] = []
  /** each engraving's two ends in world space (panes never move): a label the frame edge would crop fades instead */
  const labelEnds: THREE.Vector3[][] = []
  const _c = new THREE.Vector3()
  /** the step card's rect (px, viewport) and visibility: engravings it covers fade */
  const cardRect = { l: 0, t: 0, r: 0, b: 0 }
  let cardVis = 0
  const product = new THREE.Group()
  const slabs: THREE.Mesh[] = []
  const slabRims: THREE.ShaderMaterial[] = []

  // DOM
  let head: HTMLElement, headline: HTMLElement
  let card: HTMLElement
  const stepEls: HTMLElement[] = []
  const stepTitles: HTMLElement[] = []
  const fills: HTMLElement[] = []
  const segs: HTMLElement[] = []
  let statsEl: HTMLElement
  const tiles: HTMLElement[] = []
  let sparkles: TileSparkles
  let shown = -2
  let tilesShown = false
  const fillCache = [-1, -1, -1, -1]

  // pointer (mouse only)
  let hasMouse = false
  let ptrK = 0
  const ray = new THREE.Raycaster()
  const plane = new THREE.Plane()
  const planeN = new THREE.Vector3(Math.sin(YAW), 0, Math.cos(YAW))
  const hit = new THREE.Vector3()
  const active = new THREE.Vector3()
  const productPos = new THREE.Vector3()
  const centers = [FORMS[0], FORMS[0], FORMS[1], FORMS[2], productPos, LINE_MID]
  const spPtr = { x: 0, y: 0 }

  const tmpPos = new THREE.Vector3()
  const tmpTgt = new THREE.Vector3()
  const tmpFocus = new THREE.Vector3()
  const scratch = new THREE.PerspectiveCamera(40, 1, 0.1, 200)
  let keys: Key[] = []
  let keysAspect = -1
  let keysH = -1
  let keysHead = -1
  /** the headline's bottom edge (CSS px from the top; measured on resize): the portrait landing frames the pane below it */
  let headB = 0
  const focusNdc = new THREE.Vector3()
  const ZERO2 = new THREE.Vector2()
  const act = [0, 0, 0, 0]

  return {
    id: 'process',
    group,
    // the four steps, then the stats
    anchors: [...ANCHORS, STATS_AT],

    async init(ctx) {
      ctxRef = ctx
      const mobile = ctx.mobile

      // ---- the flow (one particle system through the whole chapter)
      const n = mobile ? 5000 : 10000
      const data = buildFlow(n, { min: [-4.4, -2.2, -2.8], max: [4.0, 2.5, 2.2] })
      flow = new Flow(data)
      const u = flow.u
      u.uYaw.value = YAW
      u.uSize.value = mobile ? 0.032 : 0.026
      u.uRingR.value = RING_R
      FORMS.forEach((f, i) => u.uForm.value[i].copy(f))
      PANES.forEach((p, i) => {
        u.uGlass.value[i].set(p.x, p.y, p.z, YAW)
        u.uGlassH.value[i].set(PANE_W / 2, PANE_H / 2, FACE_Z)
      })
      u.uLine.value.set(-3.4, STEP * 3 + 3.4, ARC, 0.32)
      group.add(flow.points)
      await nextFrame()

      // ---- the chaos: a particles.js constellation + ambient dust
      net = new Constellation({
        count: mobile ? 56 : 100,
        box: new THREE.Box3(new THREE.Vector3(-5.2, -2.1, -2.6), new THREE.Vector3(3.4, 2.6, 1.3)),
        link: 1.2,
        repel: 1.1,
        color: G.ice,
        nodeSize: 0.05,
      })
      group.add(net.group)
      dust = new Dust({
        count: mobile ? 150 : 320,
        box: new THREE.Box3(new THREE.Vector3(-7, -3.4, -5), new THREE.Vector3(STEP * 3 + 7, 4.2, 3.4)),
        size: 0.022,
        color: '#cfe0ff',
      })
      group.add(dust.points)

      // ---- four glass panes: satin faces, clear bevelled edges, a light rim
      const face = glass({ frost: 0.2, thickness: 0.4, dispersion: 0, ior: 1.45, env: 1 })
      const side = glass({ thickness: 0.9, dispersion: 0.5, ior: 1.52, coat: 0.6 })
      const proto = pane(PANE_W, PANE_H, { radius: 0.24, depth: PANE_D, bevel: PANE_B, material: face })
      const geo = proto.geometry
      for (let i = 0; i < 4; i++) {
        const p = new THREE.Mesh(geo, [face, side])
        p.position.copy(PANES[i])
        p.rotation.y = YAW
        group.add(p)
        panes.push(p)
        const rm = edgeGlow('#cfe6ff', 3, 0.2)
        rims.push(rm)
        const rim = new THREE.Mesh(geo, rm)
        rim.scale.setScalar(1.003)
        rim.renderOrder = 4
        p.add(rim)
        // etched: the number top-left, the name bottom-left
        const num = etch(String(i + 1).padStart(2, '0'), {
          height: 0.12,
          weight: 500,
          font: "'DM Mono', ui-monospace, monospace",
          color: G.ice,
          glow: 1.3,
          opacity: 0.9,
          letterSpacing: 0.06,
        })
        const name = etch(PROCESS[i].title, {
          height: 0.22,
          weight: 560,
          font: "'Sora Variable', 'Sora', system-ui, sans-serif",
          color: G.white,
          glow: 1.2,
          opacity: 0.9,
          letterSpacing: -0.02,
        })
        const wNum = (num.geometry as THREE.PlaneGeometry).parameters.width
        const wName = (name.geometry as THREE.PlaneGeometry).parameters.width
        num.position.set(-PANE_W / 2 + 0.2 + wNum / 2, PANE_H / 2 - 0.24, FACE_Z)
        name.position.set(-PANE_W / 2 + 0.2 + wName / 2, -PANE_H / 2 + 0.3, FACE_Z)
        num.renderOrder = name.renderOrder = 5
        p.add(num, name)
        labelMats.push({ name: name.material as THREE.MeshBasicMaterial, num: num.material as THREE.MeshBasicMaterial })
        p.updateMatrixWorld(true)
        labelEnds.push([
          new THREE.Vector3(-wName / 2, 0, 0).applyMatrix4(name.matrixWorld),
          new THREE.Vector3(wName / 2, 0, 0).applyMatrix4(name.matrixWorld),
          new THREE.Vector3(-wNum / 2, 0, 0).applyMatrix4(num.matrixWorld),
        ])
      }
      await nextFrame()

      // ---- the finished form: glass slabs where Build's blocks were densest
      const slabMat = glass({ tint: '#cfe2ff', tintDistance: 0.5, thickness: 0.7, frost: 0.05, dispersion: 0.45, ior: 1.5, coat: 0.9 })
      for (const [x0, y0, x1, y1] of SLABS) {
        const w = x1 - x0
        const h = y1 - y0
        const m = pane(w, h, { radius: Math.min(0.05, h * 0.3), depth: 0.13, bevel: 0.038, material: slabMat })
        m.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0.01)
        const sr = edgeGlow('#dcecff', 3, 0)
        slabRims.push(sr)
        const rim = new THREE.Mesh(m.geometry, sr)
        rim.scale.setScalar(1.004)
        rim.renderOrder = 4
        m.add(rim)
        product.add(m)
        slabs.push(m)
      }
      product.rotation.y = YAW
      group.add(product)
      await nextFrame()

      // ---- DOM
      const stage = ctx.stage
      head = el('div', 'pr-head', undefined, stage)
      el('p', 'hud-eyebrow', 'How we work', head)
      headline = rise(el('h2', 'hud-h2 pr-headline', undefined, head), 'We listen first. <em>Then we build.</em>')

      card = el('div', 'pr-card hud-panel hud-panel--strong', undefined, stage)
      const steps = el('div', 'pr-steps', undefined, card)
      PROCESS.forEach((p, i) => {
        const s = el('div', 'pr-step', undefined, steps)
        stepTitles.push(rise(el('h3', 'pr-title', undefined, s), `<em>${String(i + 1).padStart(2, '0')}</em> — ${p.title}`))
        el('p', 'hud-body pr-text', p.text, s)
        stepEls.push(s)
      })
      const track = el('ol', 'pr-track', undefined, card)
      PROCESS.forEach(p => {
        const li = el('li', 'pr-seg', undefined, track)
        const bar = el('span', 'pr-bar', undefined, li)
        fills.push(el('span', 'pr-fill', undefined, bar))
        el('span', 'pr-name', p.title, li)
        segs.push(li)
      })

      statsEl = el('div', 'pr-stats', undefined, stage)
      SHOW.forEach((s, i) => {
        const t = el('div', 'pr-tile hud-panel hud-panel--strong', undefined, statsEl)
        t.style.setProperty('--i', String(i))
        el('p', 'pr-value', s.value, t)
        el('p', 'pr-label', s.label, t)
        tiles.push(t)
      })
      sparkles = new TileSparkles(statsEl, tiles, mobile ? 16 : 30, TILES[0] - 0.01)
      const measureCard = () => {
        const b = card.getBoundingClientRect()
        cardRect.l = b.left - 18
        cardRect.t = b.top - 18
        cardRect.r = b.right + 18
        cardRect.b = b.bottom + 18
      }
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measureCard).observe(card)
      window.addEventListener('resize', measureCard)
      measureCard()
      // the headline's bottom (layout only: the word-rise transforms don't move it)
      const measureHead = () => {
        headB = head.offsetHeight > 0 ? Math.round(head.offsetTop + head.offsetHeight) : 0
      }
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measureHead).observe(head)
      window.addEventListener('resize', measureHead)
      measureHead()
      reveal(head, 0, 0)
      reveal(card, 0, 0)
      reveal(statsEl, 0, 0)

      window.addEventListener('pointermove', e => {
        hasMouse = e.pointerType === 'mouse'
      })
      document.documentElement.addEventListener('pointerleave', () => (hasMouse = false))
    },

    update(local, frame, ctx) {
      const rm = frame.reducedMotion
      const calm = rm || !!frame.still
      const t = frame.time
      const portrait = frame.width < frame.height * 0.9

      // ---- the flow
      const st = stageAt(local)
      const u = flow.u
      u.uStage.value = st
      u.uTime.value = rm ? t * 0.15 : t
      u.uPx.value = ctx.renderer.domElement.height
      const P = 2.4
      const ph = (t % P) / P
      // (a still frame never holds a beat's peak: no heartbeat when calm)
      u.uBeat.value = calm ? 0 : Math.exp(-(((ph - 0.08) / 0.03) ** 2)) + 0.55 * Math.exp(-(((ph - 0.2) / 0.035) ** 2))
      u.uComet.value = t * (rm ? 0.08 : 0.85)
      u.uSolid.value = smoothstep(0.56, 0.64, local)
      u.uOpacity.value = 1

      // the finished form glides from the Build pane to the Support pane
      const glide = ease.inOutCubic(segment(local, GLIDE[0], GLIDE[1]))
      productPos.lerpVectors(FORMS[2], FORMS[3], glide)
      u.uProduct.value.copy(productPos)
      product.position.copy(productPos)
      product.position.y += rm ? 0 : Math.sin(t * 0.5) * 0.02 * glide
      let grown = 0
      for (let i = 0; i < slabs.length; i++) {
        const g = ease.outCubic(segment(local, 0.5 + i * 0.011, 0.565 + i * 0.011))
        grown += g / slabs.length
        const s = slabs[i]
        s.visible = g > 0.002
        s.scale.set(lerp(0.9, 1, g), lerp(0.9, 1, g), Math.max(0.02, g))
        slabRims[i].uniforms.uStrength.value = 0.5 * g + 0.3 * g * (1 - smoothstep(0.58, 0.64, local))
      }
      product.visible = grown > 0.002
      // the glass form hides what's behind it from the flow (fake refraction)
      u.uGlass.value[4].set(productPos.x, productPos.y, productPos.z, YAW)
      if (grown > 0.5) u.uGlassH.value[4].set(PAGE_W / 2, PAGE_H / 2, 0.08)
      else u.uGlassH.value[4].set(-1, -1, 0)

      // ---- the pointer: a plane through the active form
      const k = Math.min(4, Math.floor(st))
      active.lerpVectors(centers[k], centers[k + 1], st - k)
      const wantPtr = hasMouse && !calm && !frame.mobile ? window01(local, 0.05, 0.94, 0.03) : 0
      ptrK = lerp(ptrK, wantPtr, 1 - Math.exp(-4 * frame.dt))
      u.uPtrK.value = ptrK
      let ptrWorld: THREE.Vector3 | null = null
      if (ptrK > 0.001) {
        ray.setFromCamera(frame.pointerRaw, ctx.camera)
        plane.setFromNormalAndCoplanarPoint(planeN, active)
        if (ray.ray.intersectPlane(plane, hit)) {
          u.uPtr.value.copy(hit)
          ptrWorld = hit
        }
      }

      // ---- chaos: the constellation fades as the noise becomes signal
      const chaos = 1 - smoothstep(0.13, 0.25, local)
      net.group.visible = chaos > 0.002
      if (net.group.visible) net.update(frame.still ? 0 : frame.dt, hasMouse && !frame.mobile ? ptrWorld : null, calm, chaos * 0.9)
      dust.update(t, calm ? ZERO2 : frame.pointer, lerp(0.35, 0.7, chaos))

      // ---- panes: the active one lights its rim and label
      // (they hand over at the card's step boundaries: the lit pane is the step named)
      for (let i = 0; i < 4; i++) {
        const on = i === 0 ? smoothstep(0.11, 0.17, local) : smoothstep(BOUNDS[i - 1] - 0.03, BOUNDS[i - 1] + 0.03, local)
        const off = i === 3 ? smoothstep(CARD_END - 0.04, CARD_END + 0.02, local) : smoothstep(BOUNDS[i] - 0.03, BOUNDS[i] + 0.03, local)
        act[i] = on * (1 - off)
      }
      act[3] = Math.max(act[3], smoothstep(RESULTS[0] - 0.06, RESULTS[0] + 0.03, local) * 0.6)
      const results = smoothstep(RESULTS[0] + 0.01, RESULTS[1] - 0.005, local)
      for (let i = 0; i < 4; i++) {
        const a = Math.max(act[i], results * 0.55)
        rims[i].uniforms.uStrength.value = 0.18 + 0.5 * a
        const L = labelMats[i]
        L.name.color.set(G.white).multiplyScalar(0.5 + 0.42 * a)
        L.num.color.set(G.ice).multiplyScalar(0.62 + 0.5 * a)
      }

      // ---- world: deep night; the network calms as order arrives
      const w = ctx.world.params
      w.top = '#0b0e2e'
      w.bottom = '#04051a'
      w.a = '#6f5fff'
      w.b = st > 3.2 && st < 4.8 ? '#5a7dff' : '#3f86ff'
      w.node = '#c9e4ff'
      w.line = '#88c4ff'
      w.net = lerp(lerp(0.5, 0.62, results), 0.78, chaos)
      w.speed = lerp(0.55, 1.3, chaos)
      w.gather = 0.16 * window01(local, 0.14, 0.3, 0.06) + 0.22 * window01(local, 0.48, 0.7, 0.06)
      w.pointer = 1
      w.env = 1.05
      let turn = 0.2
      for (const [a] of STAGE_WIN) turn += 0.55 * ease.outCubic(segment(local, a + 0.02, a + 0.1))
      w.envTurn = rm ? 0.2 + (turn - 0.2) * 0.25 : turn
      w.keyDir.set(-0.5, 0.8, 0.6)
      w.key = 1.6
      w.fill = 0.3

      // ---- post
      const post = ctx.post.params
      post.bloomStrength = 0.62
      post.bloomRadius = 0.55
      post.bloomThreshold = 0.9
      post.vignette = 0.34
      // the results come into focus: frost, then clear
      post.frost = rm ? 0 : 0.3 * Math.max(0, Math.sin(Math.PI * segment(local, RESULTS[0] + 0.003, RESULTS[1])))

      // ---- DOM
      // the headline: in just past the opening cut, settled at the heading stop (0.12) and the landing (0.17)
      const headEnd = portrait ? 0.205 : 0.27
      reveal(head, window01(local, HEAD_IN, headEnd, 0.03), 0)
      setRise(headline, local > HEAD_IN && local < headEnd - 0.01)

      const cardFrom = portrait ? 0.2 : 0.145
      const cardV = window01(local, cardFrom, CARD_END, 0.018)
      reveal(card, cardV, 0)
      cardVis = cardV
      // the step changes at each glide's midpoint; the fill runs over the step's own span
      const idx = local < BOUNDS[0] ? 0 : local < BOUNDS[1] ? 1 : local < BOUNDS[2] ? 2 : 3
      const from = idx === 0 ? A : BOUNDS[idx - 1]
      const to = idx === 3 ? CARD_END - 0.02 : BOUNDS[idx]
      const phase = segment(local, from, to)
      const cur = local > cardFrom && local < CARD_END ? idx : -1
      if (cur !== shown) {
        shown = cur
        stepEls.forEach((s, i) => s.classList.toggle('is-on', i === cur))
        segs.forEach((s, i) => {
          s.classList.toggle('is-on', i === cur)
          s.classList.toggle('is-done', cur >= 0 && i < cur)
        })
      }
      for (let i = 0; i < stepTitles.length; i++) setRise(stepTitles[i], i === cur && cardV > 0.05)
      for (let i = 0; i < 4; i++) {
        const f = i < idx ? 1 : i === idx ? ease.outCubic(clamp(phase / 0.55)) : 0
        const q = Math.round(f * 1000)
        if (fillCache[i] !== q) {
          fillCache[i] = q
          fills[i].style.transform = `scaleX(${(q / 1000).toFixed(3)})`
        }
      }

      const statsV = window01(local, TILES[0] - 0.01, TILES[1] + 0.005, 0.02)
      reveal(statsEl, statsV, 0)
      const tilesOn = local > TILES[0] && local < TILES[1]
      if (tilesOn !== tilesShown) {
        tilesShown = tilesOn
        for (const tile of tiles) tile.classList.toggle('is-on', tilesOn)
      }
      let sp: { x: number; y: number } | null = null
      if (hasMouse && !calm && !frame.mobile) {
        spPtr.x = ((frame.pointerRaw.x + 1) / 2) * frame.width
        spPtr.y = ((1 - frame.pointerRaw.y) / 2) * frame.height
        sp = spPtr
      }
      sparkles.draw(statsV, local, t, sp, calm)
    },

    camera(local: number, frame: Frame, out: CameraPose) {
      const aspect = frame.width / Math.max(1, frame.height)
      if (Math.abs(aspect - keysAspect) > 1e-3 || frame.height !== keysH || headB !== keysHead) {
        keys = keysFor(aspect, frame.height, headB)
        keysAspect = aspect
        keysH = frame.height
        keysHead = headB
      }
      const fov = sample(keys, local, tmpPos, tmpTgt, tmpFocus)
      out.position.copy(tmpPos)
      out.target.copy(tmpTgt)
      out.fov = fov
      out.roll = 0
      out.parallax = frame.reducedMotion ? 0 : 0.24

      // gather the network's light pools behind the subject
      if (ctxRef) {
        scratch.position.copy(tmpPos)
        scratch.fov = fov
        scratch.aspect = aspect
        scratch.updateProjectionMatrix()
        scratch.lookAt(tmpTgt)
        scratch.updateMatrixWorld()
        const f = focusNdc.copy(tmpFocus).project(scratch)
        if (Number.isFinite(f.x) && Number.isFinite(f.y)) {
          ctxRef.world.params.focus.set(clamp(f.x, -1.2, 1.2) * aspect, clamp(f.y, -0.9, 0.9))
        }
        // engravings the frame edge would crop fade out (no "sten" at the edge)
        // (and so do engravings the step card covers: no half-word peeking out)
        for (let i = 0; i < labelEnds.length; i++) {
          let reach = 0
          let covered = false
          for (const e of labelEnds[i]) {
            _c.copy(e).project(scratch)
            if (!Number.isFinite(_c.x) || _c.z > 1) reach = 2
            else {
              reach = Math.max(reach, Math.abs(_c.x), Math.abs(_c.y))
              const px = ((_c.x + 1) / 2) * frame.width
              const py = ((1 - _c.y) / 2) * frame.height
              if (px > cardRect.l && px < cardRect.r && py > cardRect.t && py < cardRect.b) covered = true
            }
          }
          const o = 0.9 * (1 - smoothstep(0.9, 0.99, reach)) * (covered ? 1 - cardVis : 1)
          labelMats[i].name.opacity = o
          labelMats[i].num.opacity = o
        }
      }
    },
  }
}
