import * as THREE from 'three'
import { edgeGlow, glass, sharpTransmission, G } from '../../kit/glass'
import { pxFromTarget } from './cloud'

/*
 * Nodes — the graph itself.
 *
 *   layout      eleven nodes on a loose shell around a hub (each at its own
 *               longitude step, latitude and radius: a molecule, not a ring)
 *   beads       one clear glass sphere per node (11 transmissive meshes, one
 *               material each so every bead can focus/defocus on its own)
 *               + a fresnel rim of light
 *   hub         a larger violet-tinted glass sphere at the centre (the Hark
 *               mark glows inside it: a Cloud in index.ts)
 *   links       hairlines (spokes to the hub, the ring, a few chords) and
 *               PARTICLES FLOWING along every link (GPU: one Points draw), plus
 *               a glowing nucleus of particles orbiting inside every bead
 *
 * Every particle/line material here draws in three's OPAQUE list with
 * additive blending: the transmission pass captures it, so the glass beads
 * refract the flows and nuclei (links visibly bend as they enter a bead).
 * Node positions bob gently; bob() is mirrored in the flow shader.
 */

export const N = 11
export const HUB = N // node index of the hub in the flow/lit arrays
export const BEAD_R = 0.44
export const HUB_R = 0.78

const STEP = (Math.PI * 2) / N
const LAT = [0.24, -0.25, 0.32, -0.08, 0.28, -0.3, 0.12, -0.22, 0.3, -0.14, 0.2]
const RAD = [3.5, 3.3, 3.6, 3.35, 3.55, 3.3, 3.6, 3.35, 3.5, 3.3, 3.55]

/** node i's resting position (graph space, hub at origin) */
export const NODES: THREE.Vector3[] = Array.from({ length: N }, (_, i) => {
  const lon = i * STEP
  const c = Math.cos(LAT[i])
  return new THREE.Vector3(Math.sin(lon) * c * RAD[i], Math.sin(LAT[i]) * RAD[i], Math.cos(lon) * c * RAD[i])
})
export const LON = Array.from({ length: N }, (_, i) => i * STEP)

/** links: spokes to the hub, the ring, and a few chords */
export const EDGES: [number, number][] = [
  ...Array.from({ length: N }, (_, i) => [HUB, i] as [number, number]),
  ...Array.from({ length: N }, (_, i) => [i, (i + 1) % N] as [number, number]),
  [0, 2],
  [3, 5],
  [4, 7],
  [6, 8],
  [8, 10],
  [1, 9],
]

export const BOB = 0.05
/** mirrors bob() in the flow shader */
export function bob(i: number, t: number, out: THREE.Vector3): THREE.Vector3 {
  if (i >= HUB) return out.set(0, 0, 0)
  return out.set(Math.sin(t * 0.45 + i * 1.9), Math.sin(t * 0.37 + i * 2.7 + 1.0), Math.cos(t * 0.41 + i * 1.3)).multiplyScalar(BOB)
}

export const nodePos = (i: number) => (i >= HUB ? new THREE.Vector3() : NODES[i])

/* ------------------------------------------------------------ flows shader */

const FLOW_VERT = /* glsl */ `
  attribute vec3 aA;
  attribute vec3 aB;
  attribute vec2 aIdx;
  attribute vec4 aRand;
  attribute float aKind;
  uniform float uTime, uPx, uSize, uBase, uBob;
  uniform float uLit[12];
  uniform float uSeed[12];
  varying float vB;
  varying float vTone;
  varying float vKind;
  vec3 bob(float i, float t) {
    float h = 1.0 - step(10.5, i);
    return vec3(sin(t * 0.45 + i * 1.9), sin(t * 0.37 + i * 2.7 + 1.0), cos(t * 0.41 + i * 1.3)) * uBob * h;
  }
  void main() {
    int ia = int(aIdx.x + 0.5);
    int ib = int(aIdx.y + 0.5);
    vec3 A = aA + bob(aIdx.x, uTime);
    vec3 B = aB + bob(aIdx.y, uTime);
    vec3 p;
    float b;
    float s = 1.0;
    if (aKind < 0.5) {
      // a particle flowing along the link A -> B
      float t = fract(aRand.x + uTime * aRand.y);
      p = mix(A, B, t);
      vec3 w = vec3(sin(t * 11.0 + aRand.z * 30.0), cos(t * 9.0 + aRand.w * 30.0), sin(t * 8.0 + aRand.z * 17.0));
      p += w * 0.03 * sin(3.14159 * t);
      float env = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.88, 1.0, t));
      float lit = max(uLit[ia], uLit[ib]);
      b = (uBase + lit * 1.35) * env;
      s = 0.8 + lit * 0.5;
    } else {
      // the nucleus: particles orbiting inside the bead
      float ang = uTime * (0.35 + aRand.y * 0.6) + aRand.z * 6.2831;
      float rr = 0.03 + aRand.x * aRand.x * 0.13;
      p = A + vec3(cos(ang) * rr, sin(ang * 0.8 + aRand.w * 6.2831) * rr * 0.7, sin(ang) * rr);
      b = uSeed[ia] * (0.65 + 0.35 * sin(uTime * (1.2 + aRand.w) + aRand.z * 20.0)) * (1.4 - aRand.x);
      s = 0.9 + (1.0 - aRand.x) * 0.9;
    }
    vB = b;
    vTone = aRand.w;
    vKind = aKind;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = clamp(uSize * s * (0.6 + aRand.w * 0.8) * projectionMatrix[1][1] * 0.5 * uPx / max(-mv.z, 0.05), 1.0, 40.0);
    gl_Position = projectionMatrix * mv;
  }
`

const FLOW_FRAG = /* glsl */ `
  uniform vec3 uColA, uColB, uColSeed;
  uniform float uGlobal;
  varying float vB;
  varying float vTone;
  varying float vKind;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float core = 1.0 - smoothstep(0.0, 0.5, d);
    float a = core * core * vB * uGlobal;
    if (a <= 0.003) discard;
    vec3 col = mix(uColA, uColB, vTone * vTone);
    col = mix(col, uColSeed, vKind);
    gl_FragColor = vec4(col * a, 1.0);
  }
`

export interface Graph {
  root: THREE.Group
  beads: THREE.Mesh[]
  beadMats: THREE.MeshPhysicalMaterial[]
  rims: THREE.Mesh[]
  rimMats: THREE.ShaderMaterial[]
  hub: THREE.Mesh
  hubMat: THREE.MeshPhysicalMaterial
  lines: THREE.LineSegments
  flows: THREE.Points
  flowU: {
    uTime: { value: number }
    uPx: { value: number }
    uSize: { value: number }
    uBase: { value: number }
    uBob: { value: number }
    uGlobal: { value: number }
    uLit: { value: number[] }
    uSeed: { value: number[] }
  }
  /** per-frame: bob the beads and redraw the hairlines. lit[] 0..1 per node (hub last) */
  sync(t: number, lit: ArrayLike<number>, lineGain: number): void
}

function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => ((s = (s * 16807) % 2147483647) / 2147483647)
}

export function buildGraph(mobile: boolean): Graph {
  const root = new THREE.Group()

  /* ---- beads */
  const beadGeo = new THREE.SphereGeometry(BEAD_R, mobile ? 40 : 64, mobile ? 28 : 44)
  const base = glass({ thickness: 0.32, ior: 1.4, dispersion: 0.22, coat: 0.6 })
  const beads: THREE.Mesh[] = []
  const beadMats: THREE.MeshPhysicalMaterial[] = []
  const rims: THREE.Mesh[] = []
  const rimMats: THREE.ShaderMaterial[] = []
  for (let i = 0; i < N; i++) {
    const m = base.clone()
    // phones render the glass buffer at half resolution: sample it at mip 0 so the icon stays crisp
    if (mobile) sharpTransmission(m)
    const bead = new THREE.Mesh(beadGeo, m)
    bead.position.copy(NODES[i])
    bead.userData.node = i
    const rm = edgeGlow(G.ice, 3, 0.5)
    const rim = new THREE.Mesh(beadGeo, rm)
    rim.scale.setScalar(1.006)
    bead.add(rim)
    root.add(bead)
    beads.push(bead)
    beadMats.push(m)
    rims.push(rim)
    rimMats.push(rm)
  }

  /* ---- hub */
  const hubMat = glass({ thickness: 0.55, ior: 1.36, dispersion: 0.26, coat: 0.8, tint: '#c4b8ff', tintDistance: 2.2 }).clone()
  const hub = new THREE.Mesh(new THREE.SphereGeometry(HUB_R, mobile ? 48 : 80, mobile ? 32 : 56), hubMat)
  const hubRim = new THREE.Mesh(hub.geometry, edgeGlow(G.violet, 3, 0.45))
  hubRim.scale.setScalar(1.005)
  hub.add(hubRim)
  root.add(hub)

  /* ---- hairlines */
  const E = EDGES.length
  const linePos = new Float32Array(E * 6)
  const lineCol = new Float32Array(E * 6)
  const lg = new THREE.BufferGeometry()
  lg.setAttribute('position', new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage))
  lg.setAttribute('color', new THREE.BufferAttribute(lineCol, 3).setUsage(THREE.DynamicDrawUsage))
  lg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
  const lines = new THREE.LineSegments(
    lg,
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: false, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
  )
  lines.frustumCulled = false
  root.add(lines)

  /* ---- flows + nuclei (one Points draw) */
  const r = rng(41)
  const perUnit = mobile ? 9 : 16
  const seedsPer = mobile ? 26 : 48
  let total = N * seedsPer
  const counts = EDGES.map(([a, b]) => Math.max(6, Math.round(nodePos(a).distanceTo(nodePos(b)) * perUnit)))
  for (const c of counts) total += c
  const aA = new Float32Array(total * 3)
  const aB = new Float32Array(total * 3)
  const aIdx = new Float32Array(total * 2)
  const aRand = new Float32Array(total * 4)
  const aKind = new Float32Array(total)
  let k = 0
  EDGES.forEach(([a, b], e) => {
    const A = nodePos(a)
    const B = nodePos(b)
    const len = A.distanceTo(B)
    for (let j = 0; j < counts[e]; j++, k++) {
      A.toArray(aA, k * 3)
      B.toArray(aB, k * 3)
      aIdx[k * 2] = a
      aIdx[k * 2 + 1] = b
      aRand[k * 4] = r()
      aRand[k * 4 + 1] = (0.16 + r() * 0.14) / len // travel rate: ~0.16–0.3 units/s
      aRand[k * 4 + 2] = r()
      aRand[k * 4 + 3] = r()
      aKind[k] = 0
    }
  })
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < seedsPer; j++, k++) {
      NODES[i].toArray(aA, k * 3)
      NODES[i].toArray(aB, k * 3)
      aIdx[k * 2] = i
      aIdx[k * 2 + 1] = i
      aRand[k * 4] = r()
      aRand[k * 4 + 1] = r()
      aRand[k * 4 + 2] = r()
      aRand[k * 4 + 3] = r()
      aKind[k] = 1
    }
  }
  const fg = new THREE.BufferGeometry()
  fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(total * 3), 3))
  fg.setAttribute('aA', new THREE.BufferAttribute(aA, 3))
  fg.setAttribute('aB', new THREE.BufferAttribute(aB, 3))
  fg.setAttribute('aIdx', new THREE.BufferAttribute(aIdx, 2))
  fg.setAttribute('aRand', new THREE.BufferAttribute(aRand, 4))
  fg.setAttribute('aKind', new THREE.BufferAttribute(aKind, 1))
  fg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
  const flowU = {
    uTime: { value: 0 },
    uPx: { value: 900 },
    uSize: { value: 0.022 },
    uBase: { value: 0.45 },
    uBob: { value: BOB },
    uGlobal: { value: 1 },
    uLit: { value: new Array<number>(12).fill(0) },
    uSeed: { value: new Array<number>(12).fill(0) },
    uColA: { value: new THREE.Color(G.ice) },
    uColB: { value: new THREE.Color(G.violet) },
    uColSeed: { value: new THREE.Color('#dce9ff') },
  }
  const flows = new THREE.Points(
    fg,
    new THREE.ShaderMaterial({
      uniforms: flowU,
      vertexShader: FLOW_VERT,
      fragmentShader: FLOW_FRAG,
      transparent: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    }),
  )
  flows.frustumCulled = false
  pxFromTarget(flows, flowU.uPx)
  root.add(flows)

  const va = new THREE.Vector3()
  const vb = new THREE.Vector3()
  const ice = new THREE.Color(G.ice)
  const violet = new THREE.Color(G.violet)
  const bobs = Array.from({ length: N }, () => new THREE.Vector3())

  function sync(t: number, lit: ArrayLike<number>, lineGain: number) {
    for (let i = 0; i < N; i++) {
      bob(i, t, bobs[i])
      beads[i].position.copy(NODES[i]).add(bobs[i])
    }
    EDGES.forEach(([a, b], e) => {
      va.copy(nodePos(a))
      vb.copy(nodePos(b))
      if (a < HUB) va.add(bobs[a])
      if (b < HUB) vb.add(bobs[b])
      va.toArray(linePos, e * 6)
      vb.toArray(linePos, e * 6 + 3)
      const l = Math.max(lit[a] ?? 0, lit[b] ?? 0)
      const g = (0.13 + 0.42 * l) * lineGain
      const c = a === HUB ? violet : ice
      lineCol[e * 6] = lineCol[e * 6 + 3] = c.r * g
      lineCol[e * 6 + 1] = lineCol[e * 6 + 4] = c.g * g
      lineCol[e * 6 + 2] = lineCol[e * 6 + 5] = c.b * g
    })
    ;(lg.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(lg.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true
  }

  return { root, beads, beadMats, rims, rimMats, hub, hubMat, lines, flows, flowU, sync }
}
