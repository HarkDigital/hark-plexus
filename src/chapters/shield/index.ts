import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { el, reveal, rise, setRise } from '../../core/dom'
import { clamp, ease, lerp, segment, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { SECURITY, STATS } from '../../content'
import { G, glass, pane } from '../../kit/glass'
import { SITE_H, SITE_W, siteMaterial, siteTexture } from './site'
import { Dome } from './dome'
import { Swarm } from './swarm'
import './shield.css'

/*
 * FIREWALL — "Hacked? Breathe."
 *
 * 'Your site' is a floating pane of clear glass with a minimal website etched
 * into it. Around it: a geodesic dome of hexagonal glass tiles, the shield.
 *
 *   0.00–0.05  IN        the site floats in a night-blue network; far off,
 *                        the first warm sparks.
 *   0.05–0.28  ATTACK    the network turns hostile red (world.warm); warm-red
 *                        particles pour in along S-shaped streams (the front
 *                        advances with scroll) and strike the page: it goes
 *                        ember, bands of it slip (a little post glitch). The
 *                        eyebrow and 'Hacked?' are up from 0.06. Mouse: the
 *                        swarm parts around the cursor.
 *   0.26–0.42  SHIELD    a breath of frost; hex glass tiles fly in and lock
 *                        into the dome, pole first (each cell lights as it
 *                        seats); 'Breathe.' comes into focus with the body.
 *   0.38–0.58  DEFLECT   the streams now skim the shell, cool from red to
 *                        ice and spray off the rim, dissolving; a restore
 *                        line sweeps down the page; warm → 0, the network
 *                        calms to ice blue. Landing 0.45: everything settled.
 *   0.55–0.95  WATCH     the dissolved sparks condense into two tilted
 *                        orbits circling the shield — a watchful ring — while
 *                        a scan ring passes over the cells and light sweeps
 *                        the glass. '24/7' + label + the emergency CTA
 *                        (anchor 0.8). Mouse: cells light under the cursor,
 *                        the ring leans toward it; click sends a ripple.
 *   0.95–1.00  OUT       still.
 *
 * Everything derives from `local`; frame.time only drives idle motion.
 */

const STAT = STATS.find(s => s.value === '24/7') ?? STATS[STATS.length - 1]

/** the dome: a spherical cap in front of the site */
const DOME_C = new THREE.Vector3(0, 0, -1.25)
const DOME_R = 2.55
const DOME_RIM = THREE.MathUtils.degToRad(63)
const PANE_DEPTH = 0.1
const PANE_FRONT = PANE_DEPTH / 2 + 0.04

const T = {
  copyIn: 0.06,
  reach0: 0.03,
  reach1: 0.25,
  warm0: 0.03,
  warm1: 0.2,
  infect0: 0.16,
  infect1: 0.26,
  asm0: 0.26,
  asm1: 0.43,
  breathe: 0.31,
  heal0: 0.39,
  heal1: 0.54,
  cool0: 0.36,
  cool1: 0.54,
  tail0: 0.42,
  tail1: 0.6,
  copyOut: 0.575,
  orbit0: 0.54,
  orbit1: 0.8,
  copyB: 0.615,
  scan0: 0.64,
  scan1: 0.86,
}

// ------------------------------------------------------------------ camera

interface Layout {
  w: number
  h: number
  top: number
  bottom: number
  gutter: number
  aRight: number
  aTop: number
  bRight: number
  bTop: number
  ok: boolean
}
interface Region {
  cx: number
  cy: number
  fw: number
  fh: number
}
interface Key {
  l: number
  s: [number, number, number]
  sw: number
  sh: number
  yaw: number
  pitch: number
  /** 0 = whole safe area, 1 = beside/above copy A, 2 = beside/above copy B */
  reg: 0 | 1 | 2
  fill: number
}

const KEYS: Key[] = [
  { l: 0.0, s: [0.85, 0.0, 0.3], sw: 5.5, sh: 3.3, yaw: -0.5, pitch: 0.07, reg: 1, fill: 0.9 },
  { l: 0.24, s: [0.7, 0.0, 0.3], sw: 4.9, sh: 3.0, yaw: -0.38, pitch: 0.05, reg: 1, fill: 0.92 },
  { l: 0.42, s: [0.0, 0.0, 0.45], sw: 5.2, sh: 4.9, yaw: -0.52, pitch: 0.1, reg: 1, fill: 0.92 },
  { l: 0.56, s: [0.0, 0.0, 0.45], sw: 5.1, sh: 4.8, yaw: -0.58, pitch: 0.12, reg: 1, fill: 0.92 },
  { l: 0.8, s: [0.0, 0.05, 0.45], sw: 7.0, sh: 5.4, yaw: -0.4, pitch: 0.2, reg: 2, fill: 0.97 },
  { l: 1.0, s: [0.0, 0.05, 0.45], sw: 6.9, sh: 5.3, yaw: -0.34, pitch: 0.19, reg: 2, fill: 0.97 },
]
const KEYS_TALL: Key[] = [
  { l: 0.0, s: [0.05, 0.0, 0.3], sw: 3.6, sh: 2.6, yaw: -0.36, pitch: 0.07, reg: 1, fill: 0.93 },
  { l: 0.24, s: [0.0, 0.0, 0.3], sw: 3.4, sh: 2.45, yaw: -0.28, pitch: 0.05, reg: 1, fill: 0.95 },
  { l: 0.42, s: [0.0, 0.0, 0.45], sw: 4.9, sh: 4.8, yaw: -0.4, pitch: 0.1, reg: 1, fill: 0.9 },
  { l: 0.56, s: [0.0, 0.0, 0.45], sw: 4.8, sh: 4.7, yaw: -0.44, pitch: 0.12, reg: 1, fill: 0.9 },
  { l: 0.8, s: [0.0, 0.05, 0.45], sw: 6.9, sh: 5.2, yaw: -0.3, pitch: 0.22, reg: 2, fill: 0.95 },
  { l: 1.0, s: [0.0, 0.05, 0.45], sw: 6.8, sh: 5.1, yaw: -0.26, pitch: 0.21, reg: 2, fill: 0.95 },
]

/** studio turn: light sweeps across the tiles as they lock, then a slow drift */
const TURN: [number, number][] = [
  [0.0, 0.25],
  [0.26, 0.15],
  [0.44, 1.55],
  [0.6, 1.7],
  [0.95, 2.35],
  [1.0, 2.4],
]
function envTurn(l: number) {
  for (let i = 0; i < TURN.length - 1; i++) {
    const [a, va] = TURN[i]
    const [b, vb] = TURN[i + 1]
    if (l <= b) return lerp(va, vb, ease.inOutCubic(segment(l, a, b)))
  }
  return TURN[TURN.length - 1][1]
}

const isTall = (w: number, h: number) => h > w * 1.05

function regionFor(kind: 0 | 1 | 2, L: Layout, out: Region) {
  const w = L.w
  const h = L.h
  let x0 = L.gutter
  const x1 = w - L.gutter
  const y0 = L.top
  let y1 = h - L.bottom
  if (kind > 0 && L.ok) {
    if (isTall(w, h)) y1 = Math.min(y1, (kind === 1 ? L.aTop : L.bTop) - 12)
    else x0 = Math.max(x0, (kind === 1 ? L.aRight : L.bRight) + 16)
  }
  if (y1 - y0 < h * 0.2) y1 = y0 + h * 0.2
  if (x1 - x0 < w * 0.3) x0 = x1 - w * 0.3
  out.cx = (x0 + x1) / w - 1
  out.cy = 1 - (y0 + y1) / h
  out.fw = (x1 - x0) / w
  out.fh = (y1 - y0) / h
}

const _ra: Region = { cx: 0, cy: 0, fw: 1, fh: 1 }
const _rb: Region = { cx: 0, cy: 0, fw: 1, fh: 1 }
const _r: Region = { cx: 0, cy: 0, fw: 1, fh: 1 }
const _dir = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const _up = new THREE.Vector3()
const _Y = new THREE.Vector3(0, 1, 0)

/** Frame the subject inside the region beside (or above) the copy. */
function solvePose(l: number, frame: Frame, L: Layout, out: CameraPose): Region {
  const keys = isTall(frame.width, frame.height) ? KEYS_TALL : KEYS
  let k = 0
  while (k < keys.length - 2 && l > keys[k + 1].l) k++
  const a = keys[k]
  const b = keys[k + 1]
  const t = ease.inOutCubic(segment(l, a.l, b.l))
  const lay = L.ok ? L : { ...L, w: frame.width, h: frame.height, top: 90, bottom: 90, gutter: 32 }
  regionFor(a.reg, lay, _ra)
  regionFor(b.reg, lay, _rb)
  _r.cx = lerp(_ra.cx, _rb.cx, t)
  _r.cy = lerp(_ra.cy, _rb.cy, t)
  _r.fw = lerp(_ra.fw, _rb.fw, t)
  _r.fh = lerp(_ra.fh, _rb.fh, t)
  const fov = isTall(frame.width, frame.height) ? 36 : 32
  const aspect = frame.width / Math.max(1, frame.height)
  const tanV = Math.tan(THREE.MathUtils.degToRad(fov / 2))
  const tanX = tanV * aspect
  const fill = lerp(a.fill, b.fill, t)
  const D = Math.max(lerp(a.sw, b.sw, t) / (2 * tanX * _r.fw * fill), lerp(a.sh, b.sh, t) / (2 * tanV * _r.fh * fill))
  const yaw = lerp(a.yaw, b.yaw, t)
  const pitch = lerp(a.pitch, b.pitch, t)
  _dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
  _fwd.copy(_dir).negate()
  _right.crossVectors(_fwd, _Y).normalize()
  _up.crossVectors(_right, _fwd)
  out.position
    .set(lerp(a.s[0], b.s[0], t), lerp(a.s[1], b.s[1], t), lerp(a.s[2], b.s[2], t))
    .addScaledVector(_dir, D)
    .addScaledVector(_right, -_r.cx * D * tanX)
    .addScaledVector(_up, -_r.cy * D * tanV)
  out.target.copy(out.position).addScaledVector(_fwd, D)
  out.fov = fov
  out.roll = 0
  out.parallax = 0.18
  return _r
}

// ------------------------------------------------------------------ chapter

export default function create(): Chapter {
  const group = new THREE.Group()
  const site = new THREE.Group()
  group.add(site)

  let swarm: Swarm | null = null
  let dome: Dome | null = null
  let siteMat: ReturnType<typeof siteMaterial> | null = null
  let paneMesh: THREE.Mesh | null = null

  // DOM
  let copyA: HTMLElement
  let eyebrow: HTMLElement
  let title: HTMLElement
  let line1: HTMLElement
  let line2: HTMLElement
  let panelA: HTMLElement
  let copyB: HTMLElement
  let stat: HTMLElement
  let panelB: HTMLElement
  let probe: HTMLElement

  const layout: Layout = { w: 1, h: 1, top: 90, bottom: 90, gutter: 32, aRight: 0, aTop: 0, bRight: 0, bTop: 0, ok: false }
  const scratch: CameraPose = { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: 32, roll: 0, parallax: 0 }

  // colours
  const cTop = new THREE.Color()
  const cBottom = new THREE.Color()
  const cA = new THREE.Color()
  const cB = new THREE.Color()
  const cNode = new THREE.Color()
  const cLine = new THREE.Color()
  const TOP_CALM = new THREE.Color(G.night)
  const TOP_HOT = new THREE.Color('#1a0b24')
  const BOT_CALM = new THREE.Color('#05061a')
  const BOT_HOT = new THREE.Color('#0b0512')
  const A_CALM = new THREE.Color(G.violet)
  const A_HOT = new THREE.Color('#ff5a5a')
  const B_CALM = new THREE.Color('#56b4ff')
  const B_HOT = new THREE.Color('#8b3a7a')

  // pointer (mouse only)
  let hasMouse = false
  const ptr = new THREE.Vector2(9, 9)
  const ptrNdc = new THREE.Vector2()
  let lastRipple = -10
  /** where each stream strikes the shell, weighted by how hard it is striking right now */
  const hits: { dir: THREE.Vector3; w: number }[] = []

  function measure(stage: HTMLElement) {
    const cs = getComputedStyle(probe)
    layout.w = stage.clientWidth || window.innerWidth
    layout.h = stage.clientHeight || window.innerHeight
    layout.top = parseFloat(cs.paddingTop) || 90
    layout.bottom = parseFloat(cs.paddingBottom) || 90
    layout.gutter = parseFloat(cs.paddingLeft) || 32
    layout.aRight = copyA.offsetLeft + copyA.offsetWidth
    layout.aTop = copyA.offsetTop + eyebrow.offsetTop
    layout.bRight = copyB.offsetLeft + copyB.offsetWidth
    layout.bTop = copyB.offsetTop + stat.offsetTop
    layout.ok = layout.w > 0 && layout.h > 0 && copyA.offsetWidth > 0
  }

  return {
    id: 'shield',
    group,
    anchors: [0.8],

    async init(ctx: ChapterContext) {
      const stage = ctx.stage
      const mobile = ctx.mobile

      // ---------------- DOM (visual layer; the accessible copy is srContent)
      copyA = el('div', 'sh-a', undefined, stage)
      eyebrow = el('p', 'hud-eyebrow sh-eyebrow', SECURITY.eyebrow, copyA)
      title = el('h2', 'hud-title sh-title', undefined, copyA)
      title.setAttribute('aria-label', SECURITY.title)
      line1 = rise(el('span', 'sh-l1', undefined, title), 'Hacked?')
      line2 = rise(el('span', 'sh-l2', undefined, title), '<em>Breathe.</em>')
      panelA = el('div', 'hud-panel sh-panel', undefined, copyA)
      el('p', 'hud-body', SECURITY.body, panelA)

      copyB = el('div', 'sh-b', undefined, stage)
      stat = rise(el('p', 'hud-title sh-stat', undefined, copyB), `<em>${STAT.value}</em>`)
      panelB = el('div', 'hud-panel sh-panel sh-panel-b', undefined, copyB)
      el('p', 'hud-body sh-stat-label', STAT.label, panelB)
      const cta = el('a', 'hud-btn sh-cta', SECURITY.cta, panelB)
      cta.href = SECURITY.href

      probe = el('div', 'sh-probe', undefined, stage)
      reveal(eyebrow, 0)
      reveal(panelA, 0)
      reveal(copyB, 0, 0)
      reveal(panelB, 0)
      measure(stage)
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => measure(stage))
        ro.observe(stage)
        ro.observe(copyA)
        ro.observe(copyB)
      } else window.addEventListener('resize', () => measure(stage))

      window.addEventListener('pointermove', e => {
        hasMouse = e.pointerType === 'mouse'
      })
      window.addEventListener('pointerdown', e => {
        if (e.pointerType !== 'mouse') hasMouse = false
      })
      document.documentElement.addEventListener('pointerleave', () => (hasMouse = false))

      // ---------------- the site: a pane of clear glass with the page etched inside
      siteMat = siteMaterial(siteTexture(mobile))
      const etch = new THREE.Mesh(new THREE.PlaneGeometry(SITE_W, SITE_H), siteMat)
      etch.renderOrder = -1
      paneMesh = pane(SITE_W + 0.08, SITE_H + 0.08, {
        radius: 0.14,
        depth: PANE_DEPTH,
        bevel: 0.04,
        material: glass({ tint: '#dfe8ff', tintDistance: 3, thickness: 0.35, ior: 1.5, dispersion: 0.3, env: 1.2, coat: 0.5, sharp: true }),
      })
      site.add(etch, paneMesh)
      await nextFrame()

      // ---------------- the shield
      dome = new Dome({ radius: DOME_R, center: DOME_C, rim: DOME_RIM, mobile })
      group.add(dome.group)
      await nextFrame()

      // ---------------- the swarm (sources placed around a representative view)
      const yaw = -0.42
      const pitch = 0.08
      const toCam = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
      const right = new THREE.Vector3().crossVectors(toCam.clone().negate(), _Y).normalize()
      const up = new THREE.Vector3().crossVectors(right, toCam.clone().negate())
      swarm = new Swarm({
        count: mobile ? 4200 : 10500,
        center: DOME_C,
        radius: DOME_R,
        rim: DOME_RIM,
        paneW: SITE_W,
        paneH: SITE_H,
        front: PANE_FRONT + 0.02,
        toCam,
        right,
        up,
        streams: mobile ? 7 : 9,
        compact: isTall(stage.clientWidth || window.innerWidth, stage.clientHeight || window.innerHeight),
      })
      group.add(swarm.points, swarm.rings)
    },

    update(local, frame, ctx) {
      const l = local
      const calm = ctx.reducedMotion
      const still = !!frame.still
      const time = frame.time
      const aspect = frame.width / Math.max(1, frame.height)

      // ---------------- story values (all from local)
      const warmIn = smoothstep(T.warm0, T.warm1, l)
      const cool = smoothstep(T.cool0, T.cool1, l)
      const warm = warmIn * (1 - cool)
      const reach = smoothstep(T.reach0, T.reach1, l)
      const tail = smoothstep(T.tail0, T.tail1, l)
      const infect = smoothstep(T.infect0, T.infect1, l)
      const heal = segment(l, T.heal0, T.heal1)
      const asm = segment(l, T.asm0, T.asm1)
      const orbit = segment(l, T.orbit0, T.orbit1)
      const watch = smoothstep(T.orbit0, T.orbit1, l)
      const sick = infect * (1 - heal)

      // ---------------- pointer (mouse only, never on touch / reduced motion / paused)
      const live = hasMouse && !calm && !still && !frame.mobile
      if (live) {
        const k = 1 - Math.exp(-14 * frame.dt)
        if (ptr.x > 5) ptr.copy(frame.pointerRaw)
        else ptr.lerp(frame.pointerRaw, k)
      } else ptr.set(9, 9)
      ptrNdc.copy(ptr)

      // ---------------- the site
      if (siteMat && paneMesh) {
        const u = siteMat.uniforms
        // a touch brighter once the dome stands in front of it (seen through two layers of glass)
        const lit = 1 + 0.35 * smoothstep(0.3, 0.9, asm)
        u.uNeutral.value.setRGB(0.55, 0.64, 0.86).multiplyScalar(lit)
        u.uAccent.value.set(G.ice).multiplyScalar(1.05 * lit)
        u.uHot.value.setRGB(1.35, 0.32, 0.26)
        u.uAlert.value.setRGB(1.45, 0.3, 0.24)
        u.uScan.value.set(G.ice).multiplyScalar(1.6)
        u.uInfect.value = infect
        u.uHeal.value = heal
        u.uSlip.value = calm ? 0 : 1
        u.uTime.value = time
        // the page floats; it shivers a little while it's under attack
        const shiver = calm ? 0 : sick * 0.006
        site.position.set(0, Math.sin(time * 0.5) * 0.025, 0)
        site.rotation.set(Math.sin(time * 0.37) * 0.015, Math.sin(time * 0.29) * 0.02, Math.sin(time * 7.3) * shiver)
      }

      // ---------------- the shield
      if (dome) {
        if (swarm && hits.length !== swarm.streams.length) {
          hits.length = 0
          for (const s of swarm.streams) hits.push({ dir: s.dir, w: 0 })
        }
        if (swarm) {
          for (let i = 0; i < hits.length; i++) {
            const s = swarm.streams[i]
            const K = clamp((asm - (s.theta / DOME_RIM) * 0.55) / 0.45)
            hits[i].w = s.u > 1 ? 0 : K * smoothstep(s.u - 0.05, s.u + 0.02, reach) * (1 - smoothstep(s.u - 0.12, s.u, tail))
          }
        }
        const scanPos = l >= T.scan0 && l <= T.scan1 ? segment(l, T.scan0, T.scan1) * 1.3 - 0.15 : -1
        dome.update({
          assembly: asm,
          base: lerp(0.34, 0.26, watch),
          scan: scanPos,
          shell: smoothstep(0.3, 0.5, asm) * lerp(0.55, 0.42, watch),
          hits,
          pointer: live && asm > 0.9 ? ptrNdc : null,
          camera: ctx.camera,
          aspect,
          dt: frame.dt,
          time,
        })
      }

      // ---------------- the swarm
      if (swarm) {
        swarm.set({
          time,
          speed: calm ? 0.02 : 0.11,
          reach,
          tail,
          shield: asm,
          orbit,
          px: ctx.renderer.domElement.height,
          aspect,
          pointer: live ? ptrNdc : null,
          pointerK: 1,
          lines: smoothstep(0.62, 0.82, l),
        })
      }

      // ---------------- world
      const wp = ctx.world.params
      wp.warm = warm
      wp.top = cTop.lerpColors(TOP_CALM, TOP_HOT, warm)
      wp.bottom = cBottom.lerpColors(BOT_CALM, BOT_HOT, warm)
      wp.a = cA.lerpColors(A_CALM, A_HOT, warm * 0.8)
      wp.b = cB.lerpColors(B_CALM, B_HOT, warm)
      wp.node = cNode.set('#c9e4ff')
      wp.line = cLine.set(G.ice)
      wp.speed = lerp(lerp(1, 1.8, warm), 0.6, watch)
      wp.net = lerp(1, 0.85, watch)
      wp.gather = 0.1 * watch
      wp.env = 1.1
      wp.envTurn = envTurn(l)
      wp.key = 1.3
      // aim the light pools / gather at the subject
      const reg = solvePose(l, frame, layout, scratch)
      wp.focus.set(reg.cx * aspect, reg.cy)

      // ---------------- post
      const pp = ctx.post.params
      pp.glitch = calm ? 0 : Math.min(0.18, 0.16 * sick + 0.04 * warm * (1 - asm))
      const breath = Math.exp(-(((l - 0.305) / 0.026) ** 2))
      pp.frost = breath * (calm ? 0.1 : 0.2)
      pp.bloomStrength = lerp(0.62, 0.55, watch)
      pp.bloomRadius = 0.55
      pp.aberration = 0.0012 + 0.0014 * warm
      pp.vignette = 0.34

      // ---------------- DOM
      const inA = l > T.copyIn && l < T.copyOut
      reveal(eyebrow, smoothstep(0.05, 0.09, l) * (1 - smoothstep(0.55, 0.585, l)))
      setRise(line1, inA)
      setRise(line2, l > T.breathe && l < T.copyOut)
      title.classList.toggle('is-hot', l < T.breathe + 0.02)
      reveal(panelA, smoothstep(0.32, 0.37, l) * (1 - smoothstep(0.55, 0.585, l)))
      const inB = l > T.copyB && l < 0.955
      reveal(copyB, inB ? 1 : smoothstep(0.6, 0.615, l) * (1 - smoothstep(0.955, 0.97, l)), 0)
      setRise(stat, inB)
      reveal(panelB, smoothstep(0.63, 0.68, l) * (1 - smoothstep(0.94, 0.965, l)))
    },

    camera(local, frame, out) {
      solvePose(local, frame, layout, out)
    },

    onPointerDown(frame, ctx) {
      // a ripple of light across the cells from where the dome was clicked
      if (!dome || ctx.reducedMotion || frame.still || frame.time - lastRipple < 0.45) return
      const ray = new THREE.Raycaster()
      ray.setFromCamera(frame.pointerRaw, ctx.camera)
      const hit = ray.ray.intersectSphere(new THREE.Sphere(DOME_C, DOME_R + 0.1), new THREE.Vector3())
      if (!hit) return
      const dir = hit.sub(DOME_C).normalize()
      if (dir.z < Math.cos(DOME_RIM + 0.05)) return
      if (dome.ripple(dir, frame.time)) lastRipple = frame.time
    },
  }
}
