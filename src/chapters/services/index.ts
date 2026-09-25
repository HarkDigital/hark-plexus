import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { clamp, damp, lerp, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { SERVICES } from '../../content'
import { Constellation, markShape, ringShape, sphereShape } from '../../kit/particles'
import { G } from '../../kit/glass'
import { Cloud } from './cloud'
import { iconPoints } from './icons'
import { BEAD_R, HUB, N, NODES, bob, buildGraph, type Graph } from './graph'
import { Hud, type HudMetrics } from './hud'
import './services.css'

/*
 * SERVICES — "Nodes".
 *
 * A 3D node graph in glass: eleven clear glass beads on a loose shell around
 * a violet glass hub (the Hark mark glows inside it as particles). Every link
 * carries a stream of particles; every bead holds an orbiting nucleus. The
 * particles draw in the opaque list, so the glass REFRACTS them (links bend
 * as they enter a bead; the icon is seen through the orb).
 *
 * For each service the camera glides around the hub to the next bead while
 * the particle cloud dissolves out of the previous icon, streams along the
 * link, and CONDENSES into the new icon inside the new bead. The bead in view
 * comes into focus (clear glass, a rim of light) and the others defocus
 * (satin glass) and dim. With a mouse, the icon's particles part around the
 * pointer, a 3D constellation around the graph flees it, and a bead can be
 * clicked to land on it.
 *
 *   0.00–0.09  intro: the hub mark condenses out of a cloud, the graph
 *              assembles out of frost; "Eleven ways to be heard." (settled at
 *              the intro 0.06 and the landing 0.08); the camera begins the
 *              glide in at ~0.076
 *   0.09–0.92  eleven nodes; each glide is centred on the boundary between
 *              two items, so the card switches as the camera passes halfway
 *              and always names the bead in view
 *   0.92–1.00  the camera pulls back, every bead lights, the icon's
 *              particles scatter outward into the cut
 *
 * Story state (which node, which icon, the pose) derives from `local` only.
 * Light is smoothed over time so fast scrolling can't strobe (WCAG 2.3.1):
 * each bead's focus/light, the nucleus-to-icon handover and the outro glow
 * are damped toward their targets, and the studio light sweep fades out with
 * scroll speed.
 */

const A = 0.09
const B = 0.92
const SPAN = (B - A) / N
/** half-width (in beats) of each glide, centred on the boundary between two items */
const TURN = 0.3
const INTRO_IN = 0.03
const CARD_OUT = 0.925
const FLY_A = 0.076
const FLY_B = 0.118
const OUT_A = 0.922
const OUT_B = 0.985
/** studio rotation relative to the camera: the softbox strips land as rim crescents on every bead */
const ENV_OFF = -1.1
const ANCHORS = Array.from({ length: N }, (_, i) => A + SPAN * (i + 0.55))

/** a long, front-loaded glide with a soft start and a settled finish */
const glide = (t: number) => {
  const x = Math.pow(clamp(t), 0.8)
  return x * x * (3 - 2 * x)
}
const seg = (v: number, a: number, b: number) => clamp((v - a) / (b - a))

/** Continuous story index F ∈ [-1, 11]: -1 the wide intro, 0..10 the nodes, 11 the wide outro. */
function storyF(local: number) {
  const u = (local - A) / SPAN
  let f = -1 + glide(seg(local, FLY_A, FLY_B))
  for (let j = 1; j < N; j++) f += glide((u - (j - TURN)) / (2 * TURN))
  f += glide(seg(local, OUT_A, OUT_B))
  return { F: f, u }
}

const Y = new THREE.Vector3(0, 1, 0)

interface Pose {
  lon: number
  lat: number
  rad: number
  target: THREE.Vector3
}

export default function create(): Chapter {
  const group = new THREE.Group()
  let graph: Graph
  let hud: Hud
  let icon: Cloud
  let hubMark: Cloud
  let net: Constellation
  let mobile = false
  let active = false
  let canvas: HTMLCanvasElement | null = null

  /**
   * Per-node view direction (from the node toward its resting camera), built
   * in the node's own frame (radial / tangent / meridian) so the hub lands in
   * the same place beside every bead: off the radial toward the card, a touch
   * from above.
   */
  const VIEW = NODES.map(p => {
    const r = p.clone().normalize()
    const t = new THREE.Vector3().crossVectors(Y, r).normalize()
    const b = new THREE.Vector3().crossVectors(r, t)
    const beta = -0.64
    return r.multiplyScalar(Math.cos(beta)).addScaledVector(t, Math.sin(beta)).addScaledVector(b, 0.1).normalize()
  })

  // shapes for the particle cloud: -1 intro halo, 0..10 icons, 11 scatter
  const shapes = new Map<number, Float32Array>()
  const slot = { a: NaN, b: NaN }

  // time-smoothed light
  const lit = new Float32Array(N + 1)
  const hov = new Float32Array(N)
  /** where the icon is (damped): the bead's nucleus hands over to it */
  const icn = new Float32Array(N)
  let outL = 0
  let calm = 1
  let snap = true
  let lastLocal = -1
  let hovered = -1
  let lastHoverX = 9
  let lastHoverY = 9
  let lastHoverL = -1

  // pointer (mouse only)
  let hasMouse = false
  let ptrK = 0
  const ptr = new THREE.Vector3(999, 999, 999)
  const ptrTarget = new THREE.Vector3()
  const ray = new THREE.Raycaster()
  const plane = new THREE.Plane()
  const ndc = new THREE.Vector2()

  // camera
  const pose = { pos: new THREE.Vector3(0, 1, 12), target: new THREE.Vector3(), fov: 32, roll: 0 }
  const poses: Pose[] = []
  for (let i = 0; i < N + 2; i++) poses.push({ lon: 0, lat: 0, rad: 10, target: new THREE.Vector3() })
  const tmpA = new THREE.Vector3()
  const tmpB = new THREE.Vector3()
  const tmpC = new THREE.Vector3()
  const offA = new THREE.Vector3()
  const offB = new THREE.Vector3()
  const camV = new THREE.Vector3()
  const ORIGIN = new THREE.Vector3()
  let focusX = 0.3
  let focusY = 0

  /** Build resting poses for every story index from the live layout. */
  function computePoses(frame: Frame, m: HudMetrics) {
    const W = Math.max(1, frame.width)
    const H = Math.max(1, frame.height)
    const aspect = W / H
    const portrait = H > W * 1.02
    const fov = portrait ? 40 : 32
    const tv = Math.tan(THREE.MathUtils.degToRad(fov / 2))
    const th = tv * aspect
    const gutter = m.valid ? m.gutter : 24
    const safeTop = m.valid ? m.safeTop : H * 0.11
    const safeBottom = m.valid ? m.safeBottom : H * 0.11
    let x0: number, x1: number, y0: number, y1: number
    if (portrait) {
      x0 = gutter
      x1 = W - gutter
      y0 = safeTop
      y1 = (m.valid ? m.cardTop : H * 0.56) - 10
    } else {
      x0 = (m.valid ? m.colRight : W * 0.36) + 24
      x1 = W - gutter
      y0 = safeTop
      y1 = H - safeBottom
    }
    const cx = (x0 + x1) / W - 1
    const cy = 1 - (y0 + y1) / H
    const hw = Math.max(0.12, (x1 - x0) / W)
    const hh = Math.max(0.1, (y1 - y0) / H)
    // the bead in view fills a set share of the free region
    const fx = portrait ? 0.6 : 0.42
    const fy = portrait ? 0.56 : 0.5
    const r = BEAD_R * 1.1
    const dist = clamp(Math.max(r / (th * fx * hw), r / (tv * fy * hh)), 2.4, 14)
    // the bead sits a little off-centre, away from the hub
    const ax = cx + hw * (portrait ? 0.08 : 0.14)
    const ay = cy - hh * (portrait ? 0.04 : 0.02)
    pose.fov = fov
    focusX = ax * aspect
    focusY = ay

    const aimTarget = (from: THREE.Vector3, at: THREE.Vector3, d: number, out: THREE.Vector3, px = ax, py = ay) => {
      const L = tmpA.copy(at).sub(from).normalize()
      const right = tmpB.crossVectors(L, Y).normalize()
      const up = tmpC.crossVectors(right, L)
      return out.copy(at).addScaledVector(right, -px * th * d).addScaledVector(up, -py * tv * d)
    }
    const toPose = (cam: THREE.Vector3, p: Pose) => {
      p.rad = cam.length()
      p.lat = Math.asin(clamp(cam.y / p.rad, -1, 1))
      p.lon = Math.atan2(cam.x, cam.z)
    }

    for (let i = 0; i < N; i++) {
      const cam = camV.copy(NODES[i]).addScaledVector(VIEW[i], dist)
      const p = poses[i + 1]
      toPose(cam, p)
      aimTarget(cam, NODES[i], dist, p.target)
    }
    // unwrap longitudes so each glide takes the short way round
    for (let i = 2; i <= N; i++) {
      while (poses[i].lon - poses[i - 1].lon > Math.PI) poses[i].lon -= Math.PI * 2
      while (poses[i].lon - poses[i - 1].lon < -Math.PI) poses[i].lon += Math.PI * 2
    }
    // wide shots: the intro frames the whole graph beside the headline; the
    // outro (copy gone) centres it in the frame between the chrome bands
    const Rg = 4.1
    const fw = portrait ? 1.3 : 1.18
    const dW = clamp(Math.max(Rg / (th * hw * fw), Rg / (tv * hh * fw)), 8, 30)
    const oy = 1 - (safeTop + H - safeBottom) / H
    const ohh = Math.max(0.1, (H - safeTop - safeBottom) / H)
    const dO = clamp(Math.max(Rg / (th * 0.94), Rg / (tv * ohh * 1.1)), 8, 30)
    const wide = (p: Pose, lon: number, lat: number, d: number, px: number, py: number) => {
      p.lon = lon
      p.lat = lat
      p.rad = d
      camV.set(Math.sin(lon) * Math.cos(lat), Math.sin(lat), Math.cos(lon) * Math.cos(lat)).multiplyScalar(d)
      aimTarget(camV, ORIGIN, d, p.target, px, py)
    }
    wide(poses[0], poses[1].lon - 0.5, 0.52, dW, cx, cy)
    wide(poses[N + 1], poses[N].lon + 0.55, 0.56, dO, 0, oy)
  }

  /** Camera for story index F (idle sway from t). */
  function poseAt(F: number, t: number, rm: boolean) {
    const k = clamp(Math.floor(F + 1), 0, N + 1)
    const k2 = Math.min(N + 1, k + 1)
    const w = clamp(F + 1 - k)
    const p0 = poses[k]
    const p1 = poses[k2]
    const between = k >= 1 && k2 <= N ? Math.sin(Math.PI * w) : 0
    const lon = lerp(p0.lon, p1.lon, w) + (rm ? 0 : Math.sin(t * 0.13) * 0.025)
    const lat = lerp(p0.lat, p1.lat, w) + (rm ? 0 : Math.sin(t * 0.11 + 1.3) * 0.012)
    const rad = lerp(p0.rad, p1.rad, w) * (1 + 0.14 * between)
    pose.pos.set(Math.sin(lon) * Math.cos(lat), Math.sin(lat), Math.cos(lon) * Math.cos(lat)).multiplyScalar(rad)
    pose.target.copy(p0.target).lerp(p1.target, w)
    pose.roll = rm ? 0 : -0.035 * between
    return lon
  }

  /** a story index's cloud shape */
  function shapeFor(k: number) {
    return shapes.get(clamp(k, -1, N))!
  }

  return {
    id: 'services',
    group,
    anchors: ANCHORS,

    async init(ctx: ChapterContext) {
      mobile = ctx.mobile
      graph = buildGraph(mobile)
      group.add(graph.root)
      await nextFrame()

      /* the icon cloud */
      const count = mobile ? 4000 : 9000
      icon = new Cloud(count, { size: mobile ? 0.013 : 0.0105, colA: G.ice, colB: G.white, fly: G.violet, seed: 9 })
      // -1: a halo disc around the hub
      const ring = ringShape(count, 1.9, { thickness: 0.5, seed: 5 })
      for (let i = 0; i < count; i++) {
        const y = ring[i * 3 + 1]
        ring[i * 3 + 1] = ring[i * 3 + 2] * 0.6 + 0.05
        ring[i * 3 + 2] = y
      }
      shapes.set(-1, ring)
      for (let i = 0; i < N; i++) {
        const flat = iconPoints(SERVICES[i].slug, count, 0.54, 3 + i)
        // orient the glyph to face node i's resting camera
        const z = VIEW[i]
        const x = new THREE.Vector3().crossVectors(Y, z).normalize()
        const y = new THREE.Vector3().crossVectors(z, x)
        const out = new Float32Array(count * 3)
        for (let p = 0; p < count; p++) {
          const gx = flat[p * 3]
          const gy = flat[p * 3 + 1]
          const gz = flat[p * 3 + 2]
          out[p * 3] = NODES[i].x + x.x * gx + y.x * gy + z.x * gz
          out[p * 3 + 1] = NODES[i].y + x.y * gx + y.y * gy + z.y * gz
          out[p * 3 + 2] = NODES[i].z + x.z * gx + y.z * gy + z.z * gz
        }
        shapes.set(i, out)
        if (i % 4 === 3) await nextFrame()
      }
      // 11: scattered outward, a flattened shell
      const sc = sphereShape(count, 1, { shell: true, seed: 21 })
      for (let i = 0; i < count; i++) {
        const k = 4.2 + ((i * 7919) % 1000) / 1000 * 3.2
        sc[i * 3] *= k
        sc[i * 3 + 1] *= k * 0.45
        sc[i * 3 + 2] *= k
      }
      shapes.set(N, sc)
      group.add(icon.points)

      /* the Hark mark inside the hub */
      const hn = mobile ? 1600 : 3200
      hubMark = new Cloud(hn, { size: mobile ? 0.013 : 0.0105, colA: G.ice, colB: G.white, fly: G.violet, seed: 13 })
      hubMark.to('a', sphereShape(hn, 0.6, { seed: 3 }))
      hubMark.to('b', markShape(hn, { size: 0.8, depth: 0.1 }))
      group.add(hubMark.points)

      /* a 3D particles.js constellation around the graph (pointer repels) */
      net = new Constellation({
        count: mobile ? 56 : 120,
        box: new THREE.Box3(new THREE.Vector3(-6.4, -3.2, -6.4), new THREE.Vector3(6.4, 3.2, 6.4)),
        link: mobile ? 1.5 : 1.3,
        repel: 1.1,
        color: G.ice,
        nodeSize: 0.045,
        seed: 31,
      })
      group.add(net.group)
      await nextFrame()

      hud = new Hud(ctx.stage, k => window.__hark?.land('services', true, ANCHORS[k]))

      window.addEventListener('pointermove', e => {
        hasMouse = e.pointerType === 'mouse'
      })
      document.documentElement.addEventListener('pointerleave', () => (hasMouse = false))

      // click a bead to land on it (click, not pointerdown: touch scrolls must not jump)
      canvas = ctx.renderer.domElement
      canvas.addEventListener('click', e => {
        if (!active || !canvas || lastLocal < A - 0.03 || lastLocal > CARD_OUT) return
        const r = canvas.getBoundingClientRect()
        ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
        const k = pick(ctx)
        if (k >= 0) window.__hark?.land('services', true, ANCHORS[k])
      })
    },

    onEnter() {
      active = true
      snap = true
    },
    onLeave() {
      active = false
      hovered = -1
      if (canvas) canvas.style.cursor = ''
    },

    update(local, frame, ctx) {
      const w = ctx.world.params
      const post = ctx.post.params
      const rm = frame.reducedMotion
      const t = frame.time * (rm ? 0.15 : 1)
      const dt = frame.dt
      if (Math.abs(local - lastLocal) > 0.04) snap = true
      lastLocal = local

      computePoses(frame, hud.metrics())
      const { F, u } = storyF(local)
      const camLon = poseAt(F, t, rm)

      const introMix = 1 - smoothstep(0.082, 0.11, local)
      const outT = smoothstep(OUT_A, 0.965, local)
      const build = smoothstep(0.0, 0.06, local)
      // speed calm: 1 at reading pace, 0 when scrubbing fast (drops fast, recovers gently)
      const calmV = 1 - smoothstep(0.5, 1.3, Math.abs(frame.velocity))
      calm = snap ? calmV : damp(calm, calmV, calmV < calm ? 10 : 2.5, dt)

      /* ---- beads: focus + light (all damped: a fast scrub merges into a steady glow) */
      const outAll = (outL = snap ? outT : damp(outL, outT, 5, dt))
      for (let i = 0; i < N; i++) {
        const here = Math.max(0, 1 - Math.abs(i - F))
        const tgt = Math.max(here, 0.8 * outT)
        lit[i] = snap ? tgt : damp(lit[i], tgt, 6, dt)
        icn[i] = snap ? here : damp(icn[i], here, 6, dt)
        hov[i] = damp(hov[i], i === hovered ? 1 : 0, 8, dt)
      }
      lit[HUB] = 0.35 + 0.45 * outAll
      snap = false
      graph.sync(t, lit, 0.4 + 0.6 * build)
      const clear = Math.max(outAll, introMix * 0.6)
      // a hovered bead swells a touch (lights only under reduced motion / Motion off)
      const hovGrow = rm || frame.still ? 0 : 0.04
      for (let i = 0; i < N; i++) {
        const l = lit[i]
        const bead = graph.beads[i]
        bead.scale.setScalar((0.94 + 0.14 * l + hovGrow * hov[i]) * (0.6 + 0.4 * build))
        const m = graph.beadMats[i]
        m.roughness = lerp(lerp(0.2, 0.012, l), 0.03, clear) + 0.3 * (1 - build)
        m.specularIntensity = lerp(0.6, 1, Math.max(l, clear))
        graph.rimMats[i].uniforms.uStrength.value = (0.14 + 0.4 * l + 0.3 * hov[i]) * build + 0.35 * outAll
        // the nucleus hands over to the icon in the bead in view
        graph.flowU.uSeed.value[i] = (0.62 + 0.5 * hov[i]) * (1 - icn[i]) * build + 1.6 * outAll
        graph.flowU.uLit.value[i] = l + 0.35 * hov[i]
      }
      graph.flowU.uLit.value[HUB] = lit[HUB]
      graph.flowU.uSeed.value[HUB] = 0
      graph.flowU.uTime.value = t
      graph.flowU.uSize.value = mobile ? 0.03 : 0.024
      graph.flowU.uGlobal.value = 0.25 + 0.75 * build
      graph.hub.scale.setScalar(0.8 + 0.2 * build)
      graph.hubMat.roughness = 0.02 + 0.35 * (1 - build)

      /* ---- the pointer on a plane through the bead in view (mouse only) */
      const near = clamp(Math.round(F), 0, N - 1)
      const mouseOn = hasMouse && !rm && !frame.still && !mobile && active
      if (mouseOn) {
        ray.setFromCamera(ndc.set(frame.pointerRaw.x, frame.pointerRaw.y), ctx.camera)
        const nrm = tmpA.copy(ctx.camera.position).sub(NODES[near]).normalize()
        plane.setFromNormalAndCoplanarPoint(nrm, NODES[near])
        if (ray.ray.intersectPlane(plane, ptrTarget)) {
          if (ptr.x > 900) ptr.copy(ptrTarget)
          else ptr.lerp(ptrTarget, 1 - Math.exp(-14 * dt))
        }
      }
      ptrK = damp(ptrK, mouseOn ? 1 : 0, 4, dt)

      /* ---- the icon cloud: dissolve → stream along the link → condense */
      const i0 = Math.round(F)
      const j = Math.min(N, Math.max(0, F < i0 ? i0 : i0 + 1))
      const mix = clamp(F - (j - 1))
      if (slot.a !== j - 1) {
        slot.a = j - 1
        icon.to('a', shapeFor(j - 1))
      }
      if (slot.b !== j) {
        slot.b = j
        icon.to('b', shapeFor(j))
      }
      const nodeOff = (k: number, out: THREE.Vector3) => (k >= 0 && k < N ? bob(k, t, out) : out.set(0, 0, 0))
      const opOf = (k: number) => (k < 0 ? 0.42 : k >= N ? 0.5 * (1 - smoothstep(0.97, 1, local)) : mobile ? 0.62 : 0.62)
      const opacity = lerp(opOf(j - 1), opOf(j), smoothstep(0.2, 0.8, mix))
      icon.set({
        mix,
        time: t,
        opacity,
        swirl: j === 0 ? 0.7 : j >= N ? 0.9 : 0.5,
        shimmer: rm ? 0.002 : 0.005,
        offA: nodeOff(j - 1, offA),
        offB: nodeOff(j, offB),
        ptr,
        ptrK: ptrK * (1 - outAll),
        ptrR: 0.19,
      })

      /* ---- the hub mark (always faces the camera) */
      hubMark.points.lookAt(pose.pos)
      hubMark.set({ mix: glide(seg(local, 0.005, 0.062)), time: t, opacity: (0.5 + 0.25 * outAll) * (0.5 + 0.5 * build), swirl: 0.5, shimmer: rm ? 0.002 : 0.004 })

      /* ---- the ambient constellation */
      const netDt = frame.still ? 0 : dt
      net.update(netDt, mouseOn ? ptr : null, rm, (0.35 + 0.45 * build) * (1 - 0.3 * outAll))

      /* ---- world: a quieter backdrop network, lit behind the bead in view */
      const hold = 1 - Math.sin(Math.PI * (F - Math.floor(F)))
      w.top = '#0a0c2a'
      w.bottom = '#05061a'
      w.a = G.violet
      w.b = '#3f7fe0'
      w.net = 0.46 + 0.1 * introMix
      w.density = 1.15
      w.focus.set(focusX, focusY)
      w.gather = 0.1 * hold * (1 - introMix) + 0.18 * outAll
      w.env = 1.2
      // the studio turns with the camera (every bead rests under the same light);
      // a highlight sweeps across the glass while the camera glides (still when scrubbing / reduced motion)
      const sweep = Math.sin(Math.PI * (F - Math.floor(F)))
      w.envTurn = -camLon + ENV_OFF - (rm ? 0 : 0.9 * sweep * calm)
      w.keyDir.set(-0.5, 0.8, 0.6)
      w.key = 1.6
      w.fill = 0.3

      /* ---- post */
      post.frost = 0.36 * (1 - smoothstep(0.0, 0.055, local))
      post.bloomStrength = (mobile ? 0.48 : 0.62) + 0.18 * outAll
      post.bloomRadius = 0.55
      post.bloomThreshold = 0.88
      post.vignette = 0.34
      post.aberration = 0.0012 + 0.0016 * outAll

      /* ---- copy */
      const introOn = local >= INTRO_IN && local < A
      const shown = local >= A && local < CARD_OUT ? clamp(Math.floor(u), 0, N - 1) : -1
      hud.update(introOn, shown)

      /* ---- hover: the pointer over a bead (desktop) */
      if (active && !mobile && canvas) {
        const hx = frame.pointerRaw.x
        const hy = frame.pointerRaw.y
        // re-pick when the pointer moves or the graph moves under it (scrolling)
        if (hx !== lastHoverX || hy !== lastHoverY || Math.abs(local - lastHoverL) > 0.002) {
          lastHoverX = hx
          lastHoverY = hy
          lastHoverL = local
          ndc.set(hx, hy)
          const k = hasMouse && local > A - 0.03 && local < CARD_OUT ? pick(ctx) : -1
          hovered = k
          canvas.style.cursor = k >= 0 ? 'pointer' : ''
        }
      }
    },

    camera(_local, frame, out: CameraPose) {
      out.position.copy(pose.pos)
      out.target.copy(pose.target)
      out.fov = pose.fov
      out.roll = pose.roll
      out.parallax = frame.mobile ? 0 : 0.2
    },
  }

  /** bead under `ndc`, or -1 */
  function pick(ctx: ChapterContext): number {
    ray.setFromCamera(ndc, ctx.camera)
    const hits = ray.intersectObjects(graph.beads, false)
    if (!hits.length) return -1
    const k = hits[0].object.userData.node
    return typeof k === 'number' ? k : -1
  }
}
