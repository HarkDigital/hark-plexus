import * as THREE from 'three'
import { G, edgeGlow, glass, pane, sharpTransmission } from '../../kit/glass'
import { placeholderTexture } from '../../kit/images'
import { Dust } from '../../kit/particles'
import { rng } from '../../core/math'
import {
  DOT_FRAG,
  FLOW_VERT,
  HALO_FRAG,
  HALO_VERT,
  LINK_FRAG,
  LINK_VERT,
  MAX_EDGES,
  MAX_STARS,
  STAR_FRAG,
  STAR_VERT,
} from './shaders'

/*
 * The Constellation set: six thin glass tiles (the featured projects) float
 * in a loose zig-zag like the bright stars of a constellation, each with its
 * site's screenshot just inside the front face and a soft backlight halo;
 * glowing links join them (and nine small stars: the rest of the portfolio),
 * and a signal of particles flows along every link. The glass refracts the
 * world's backdrop network AND the links/particles behind it (those are drawn
 * in the opaque pass, additive, so the transmission pass captures them).
 *
 * Per frame the chapter drives: tile poses and material strengths, the
 * per-edge glow / flow phase / draw-on uniforms, the stars' lit values and
 * the two 'pixel' pools (a star opening into a dot-matrix of its site).
 */

/* tile: outer size incl. bevel, the screenshot inside (1280x800 aspect) */
export const TW = 1.6
export const TH = 1.08
const T_DEPTH = 0.06
const T_BEVEL = 0.028
export const FRONT = T_DEPTH / 2 + T_BEVEL
export const IW = 1.46
export const IH = IW * 0.625

/** tile centres: a loose zig-zag in depth, left to right in story order */
export const TILE_POS: [number, number, number][] = [
  [-7.0, 0.7, -0.4],
  [-3.9, -0.75, 0.9],
  [-0.8, 0.95, -1.2],
  [2.3, -0.65, 0.5],
  [5.4, 0.85, -0.9],
  [8.4, -0.5, 0.6],
]
/** resting pose of each tile (yaw, pitch, roll): turned away, like shards catching light */
export const TILE_REST: [number, number, number][] = [
  [0.52, -0.1, 0.05],
  [-0.48, 0.12, -0.06],
  [0.56, 0.08, 0.04],
  [-0.5, -0.12, -0.05],
  [0.46, 0.1, 0.06],
  [-0.54, -0.07, -0.04],
]
/** the nine small stars (the rest of the portfolio), around the chain */
export const STAR_POS: [number, number, number][] = [
  [-9.0, 2.4, -2.4],
  [-5.7, -2.5, -1.4],
  [-2.6, 2.9, -3.2],
  [0.7, -2.6, -2.2],
  [3.7, 3.0, -2.8],
  [6.9, -2.5, -1.8],
  [10.2, 2.1, -1.4],
  [-9.6, -1.4, -3.4],
  [11.2, -1.8, -0.6],
]

/**
 * The list beat draws the constellation together into a compact map (the
 * whole portfolio at a glance): positions scale toward the chain's centre.
 */
export const LIST_CENTRE = new THREE.Vector3(0.7, 0.05, -0.4)
export function listPos(p: readonly number[], portrait: boolean, out: THREE.Vector3) {
  const sx = portrait ? 0.42 : 0.55
  return out.set(LIST_CENTRE.x + (p[0] - 0.7) * sx, LIST_CENTRE.y + (p[1] - 0.05) * 1.05, LIST_CENTRE.z + (p[2] + 0.4) * 0.6)
}

/** Accent per tile: ice and violet, one peach and one rose as rare counterpoints (never green). */
export const ACCENTS = [G.ice, G.violet, '#9fd0ff', G.peach, '#a99bff', G.rose]

type Node = { kind: 't' | 's'; i: number }
const T = (i: number): Node => ({ kind: 't', i })
const S = (i: number): Node => ({ kind: 's', i })

/** links: the chain in story order (the signal flows 01 → 06), two cross links, every star to its tile, arcs between stars */
export const EDGES: [Node, Node][] = [
  [T(0), T(1)],
  [T(1), T(2)],
  [T(2), T(3)],
  [T(3), T(4)],
  [T(4), T(5)],
  [T(0), T(2)],
  [T(3), T(5)],
  [S(0), T(0)],
  [S(7), T(0)],
  [S(1), T(1)],
  [S(2), T(2)],
  [S(3), T(3)],
  [S(4), T(4)],
  [S(5), T(5)],
  [S(6), T(5)],
  [S(8), T(5)],
  [S(0), S(2)],
  [S(2), S(4)],
  [S(4), S(6)],
  [S(7), S(1)],
  [S(1), S(3)],
  [S(3), S(5)],
  [S(5), S(8)],
]
export const NE = EDGES.length
if (NE > MAX_EDGES) throw new Error('[work] more links than MAX_EDGES')

export const nodePos = (n: Node, out = new THREE.Vector3()) => out.fromArray(n.kind === 't' ? TILE_POS[n.i] : STAR_POS[n.i])


export interface Tile {
  root: THREE.Group
  /** rotation (rest -> facing) + hover tilt */
  pivot: THREE.Group
  glassMat: THREE.MeshPhysicalMaterial
  shot: THREE.Mesh
  shotMat: THREE.MeshBasicMaterial
  rimMat: THREE.ShaderMaterial
  haloMat: THREE.ShaderMaterial
  restQ: THREE.Quaternion
}

interface PtrUniforms {
  uPtr: { value: THREE.Vector2 }
  uPtrK: { value: number }
  uAspect: { value: number }
}

export interface Constellation {
  root: THREE.Group
  tiles: Tile[]
  /**
   * Per-edge state shared by the links and the flow (set every frame):
   * A / B = the endpoints (a star's centre, or a point on a tile's glass rim
   * facing the other end), edge = (glow, draw-on, flow phase 0..1, -).
   */
  edgeA: THREE.Vector3[]
  edgeB: THREE.Vector3[]
  edge: THREE.Vector4[]
  link: {
    mesh: THREE.Mesh
    u: { uRes: { value: THREE.Vector2 }; uWidth: { value: number }; uColor: { value: THREE.Color }; uHot: { value: THREE.Color }; uOpacity: { value: number } }
  }
  flow: {
    points: THREE.Points
    u: { uTime: { value: number }; uSize: { value: number }; uPx: { value: number }; uMaxPx: { value: number }; uGather: { value: number }; uTail: { value: number }; uColor: { value: THREE.Color }; uHot: { value: THREE.Color }; uOpacity: { value: number } } & PtrUniforms
  }
  stars: {
    points: THREE.Points
    u: { uStarPos: { value: THREE.Vector3[] }; uLit: { value: number[] }; uRing: { value: number[] }; uTime: { value: number }; uSize: { value: number }; uPx: { value: number }; uMaxPx: { value: number }; uFade: { value: number }; uColor: { value: THREE.Color }; uAlt: { value: THREE.Color } } & PtrUniforms
  }
  dust: Dust
}

function ptrUniforms(): PtrUniforms {
  return { uPtr: { value: new THREE.Vector2(9, 9) }, uPtrK: { value: 0 }, uAspect: { value: 1.6 } }
}

/** additive, drawn in the opaque pass (so glass refracts it), depth-tested, never writes depth */
function additive(vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    transparent: false,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  })
}

/** A plane with rounded corners and 0..1 UVs across its whole rectangle. */
function roundedPlane(w: number, h: number, r: number): THREE.BufferGeometry {
  const s = new THREE.Shape()
  const x = -w / 2
  const y = -h / 2
  s.moveTo(x + r, y)
  s.lineTo(x + w - r, y)
  s.quadraticCurveTo(x + w, y, x + w, y + r)
  s.lineTo(x + w, y + h - r)
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  s.lineTo(x + r, y + h)
  s.quadraticCurveTo(x, y + h, x, y + h - r)
  s.lineTo(x, y + r)
  s.quadraticCurveTo(x, y, x + r, y)
  const g = new THREE.ShapeGeometry(s, 5)
  const pos = g.attributes.position
  const uv = g.attributes.uv
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) - x) / w, (pos.getY(i) - y) / h)
  uv.needsUpdate = true
  return g
}

/** Box–Muller gaussian */
function gauss(r: () => number) {
  const u = Math.max(1e-6, r())
  const v = r()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export function buildConstellation(mobile: boolean): Constellation {
  const root = new THREE.Group()
  root.name = 'constellation'

  // ---------------------------------------------------------------- tiles
  const tileGeo = pane(TW - 2 * T_BEVEL * 0.85, TH - 2 * T_BEVEL * 0.85, { depth: T_DEPTH, bevel: T_BEVEL, radius: 0.06 }).geometry
  const shotGeo = roundedPlane(IW, IH, 0.02)
  const haloPlane = new THREE.Vector2(TW + 1.8, TH + 1.8)
  const haloGeo = new THREE.PlaneGeometry(haloPlane.x, haloPlane.y)
  const base = glass({ thickness: 0.3, dispersion: 0.4, env: 1.1, coat: 0.3, ior: 1.5 })
  // phones: the transmission buffer is half resolution, so the screenshot
  // sits ON the face there (sharp); desktop sets it just inside the slab,
  // seen through the front face and refracted as the tile turns
  const shotZ = mobile ? FRONT + 0.003 : -0.004
  const e = new THREE.Euler()
  const tiles: Tile[] = TILE_POS.map((p, k) => {
    const tileRoot = new THREE.Group()
    tileRoot.position.fromArray(p)
    const pivot = new THREE.Group()
    tileRoot.add(pivot)
    const glassMat = base.clone()
    sharpTransmission(glassMat)
    const g = new THREE.Mesh(tileGeo, glassMat)
    pivot.add(g)
    const rimMat = edgeGlow(new THREE.Color(ACCENTS[k]).lerp(new THREE.Color('#ffffff'), 0.4), 2.5, 0.35)
    const rim = new THREE.Mesh(tileGeo, rimMat)
    rim.scale.setScalar(1.004)
    rim.renderOrder = 3
    pivot.add(rim)
    const shotMat = new THREE.MeshBasicMaterial({ map: placeholderTexture('#12163a'), toneMapped: true })
    shotMat.color.setScalar(0.86)
    const shot = new THREE.Mesh(shotGeo, shotMat)
    shot.position.z = shotZ
    pivot.add(shot)
    const haloMat = additive(HALO_VERT, HALO_FRAG, {
      uPlane: { value: haloPlane },
      uColor: { value: new THREE.Color(ACCENTS[k]) },
      uStrength: { value: 0.3 },
      uHalf: { value: new THREE.Vector2(TW / 2 - 0.02, TH / 2 - 0.02) },
      uRadius: { value: 0.06 },
    })
    const halo = new THREE.Mesh(haloGeo, haloMat)
    halo.position.z = -0.16
    halo.renderOrder = 1
    pivot.add(halo)
    root.add(tileRoot)
    const [yaw, pitch, roll] = TILE_REST[k]
    const restQ = new THREE.Quaternion().setFromEuler(e.set(pitch, yaw, roll, 'YXZ'))
    pivot.quaternion.copy(restQ)
    return { root: tileRoot, pivot, glassMat, shot, shotMat, rimMat, haloMat, restQ }
  })

  // ---------------------------------------------------------------- per-edge state (shared uniforms)
  const edgeA = Array.from({ length: MAX_EDGES }, () => new THREE.Vector3())
  const edgeB = Array.from({ length: MAX_EDGES }, () => new THREE.Vector3())
  const edge = Array.from({ length: MAX_EDGES }, () => new THREE.Vector4(0.5, 1, 0, 0))
  EDGES.forEach(([n0, n1], ei) => {
    nodePos(n0, edgeA[ei])
    nodePos(n1, edgeB[ei])
  })

  // ---------------------------------------------------------------- links (screen-space ribbons)
  const li: number[] = []
  const idx: number[] = []
  for (let ei = 0; ei < NE; ei++) {
    const v0 = li.length / 3
    for (const [side, end] of [
      [-1, 0],
      [1, 0],
      [-1, 1],
      [1, 1],
    ])
      li.push(side, end, ei)
    idx.push(v0, v0 + 1, v0 + 2, v0 + 2, v0 + 1, v0 + 3)
  }
  const lg = new THREE.BufferGeometry()
  lg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(li.length), 3))
  lg.setAttribute('aInfo', new THREE.Float32BufferAttribute(li, 3))
  lg.setIndex(idx)
  lg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
  const linkU = {
    uA: { value: edgeA },
    uB: { value: edgeB },
    uEdge: { value: edge },
    uRes: { value: new THREE.Vector2(1440, 900) },
    uWidth: { value: 3 },
    uColor: { value: new THREE.Color('#a8d2ff') },
    uHot: { value: new THREE.Color('#eef6ff') },
    uOpacity: { value: 1 },
  }
  const linkMesh = new THREE.Mesh(lg, additive(LINK_VERT, LINK_FRAG, linkU))
  linkMesh.frustumCulled = false
  linkMesh.renderOrder = 1
  root.add(linkMesh)

  // ---------------------------------------------------------------- the flowing signal
  const PER_EDGE = mobile ? 14 : 30
  const TAIL = mobile ? 2 : 3
  const r = rng(71)
  const fr: number[] = []
  const fi: number[] = []
  const A = new THREE.Vector3()
  const B = new THREE.Vector3()
  EDGES.forEach(([n0, n1], ei) => {
    nodePos(n0, A)
    nodePos(n1, B)
    // longer links carry more particles
    const n = Math.round(PER_EDGE * THREE.MathUtils.clamp(A.distanceTo(B) / 3.2, 0.6, 1.3))
    for (let p = 0; p < n; p++) {
      const rand = [(p + r() * 0.8) / n, r(), r(), r()]
      for (let t = 0; t < TAIL; t++) {
        fr.push(...rand)
        fi.push(ei, t)
      }
    }
  })
  const fg = new THREE.BufferGeometry()
  fg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((fi.length / 2) * 3), 3))
  fg.setAttribute('aRand', new THREE.Float32BufferAttribute(fr, 4))
  fg.setAttribute('aInfo', new THREE.Float32BufferAttribute(fi, 2))
  fg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
  const flowU = {
    ...ptrUniforms(),
    uA: { value: edgeA },
    uB: { value: edgeB },
    uEdge: { value: edge },
    uTime: { value: 0 },
    uSize: { value: 0.045 },
    uPx: { value: 900 },
    uMaxPx: { value: 16 },
    uGather: { value: 1 },
    uTail: { value: 0.045 },
    uColor: { value: new THREE.Color('#9fd0ff') },
    uHot: { value: new THREE.Color('#ffffff') },
    uOpacity: { value: 1 },
  }
  const flow = new THREE.Points(fg, additive(FLOW_VERT, DOT_FRAG, flowU))
  flow.frustumCulled = false
  flow.renderOrder = 2
  root.add(flow)

  // ---------------------------------------------------------------- the nine small stars
  const PER_STAR = mobile ? 44 : 80
  const PER_RING = mobile ? 26 : 48
  const so: number[] = []
  const sr: number[] = []
  const si: number[] = []
  const r2 = rng(97)
  STAR_POS.forEach((_, j) => {
    for (let q = 0; q <= PER_STAR + PER_RING; q++) {
      const kind = q === 0 ? 1 : q > PER_STAR ? 2 : 0
      const k = 0.55
      so.push(gauss(r2) * k, gauss(r2) * k * 0.8, gauss(r2) * k)
      sr.push(r2(), r2(), r2(), r2())
      si.push(j, kind)
    }
  })
  const sg = new THREE.BufferGeometry()
  sg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((si.length / 2) * 3), 3))
  sg.setAttribute('aOff', new THREE.Float32BufferAttribute(so, 3))
  sg.setAttribute('aRand', new THREE.Float32BufferAttribute(sr, 4))
  sg.setAttribute('aInfo', new THREE.Float32BufferAttribute(si, 2))
  sg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
  const starU = {
    ...ptrUniforms(),
    uStarPos: { value: STAR_POS.map(p => new THREE.Vector3().fromArray(p)) },
    uLit: { value: new Array(MAX_STARS).fill(0) },
    uRing: { value: new Array(MAX_STARS).fill(0) },
    uTime: { value: 0 },
    uSize: { value: 0.035 },
    uPx: { value: 900 },
    uMaxPx: { value: 16 },
    uFade: { value: 1 },
    uColor: { value: new THREE.Color('#b9dcff') },
    uAlt: { value: new THREE.Color(G.violet) },
  }
  const stars = new THREE.Points(sg, additive(STAR_VERT, STAR_FRAG, starU))
  stars.frustumCulled = false
  stars.renderOrder = 2
  root.add(stars)

  // ---------------------------------------------------------------- ambient dust (depth + pointer magnetism)
  const dust = new Dust({
    count: mobile ? 180 : 420,
    box: new THREE.Box3(new THREE.Vector3(-12, -4.5, -5), new THREE.Vector3(13, 5, 3.5)),
    size: 0.022,
    color: '#cfe3ff',
    seed: 41,
  })
  root.add(dust.points)

  return {
    root,
    tiles,
    edgeA,
    edgeB,
    edge,
    link: { mesh: linkMesh, u: linkU },
    flow: { points: flow, u: flowU },
    stars: { points: stars, u: starU },
    dust,
  }
}
