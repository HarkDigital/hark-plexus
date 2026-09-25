import * as THREE from 'three'
import { rng } from '../../core/math'
import { G } from '../../kit/glass'

/*
 * THE HEART — the mark's core as a live mini-constellation (Plexus's own
 * answer to a glowing crystal):
 *
 *   anchors   a node in the eye of each of the four hooks, and a hub where the
 *             diamond sat; the anchors join in a ring and the hub throws a
 *             spoke to each, so the mark's diamond is drawn as a constellation
 *   satellites a few small nodes drifting in the open channels around the hub;
 *             they link to anything near them (particles.js: alpha by
 *             distance), so links form and break as they wander
 *   pulses    beads of light running out along the spokes and round the ring
 *
 * Everything lives in the mark's units (1 tall, scaled with the mark) and is
 * drawn in three's OPAQUE list (additive, no depth write), so the transmission
 * pass captures it and the glass loops refract whatever passes behind them;
 * the hook eyes and the channels show it plain.
 *
 * The crystallization front lights it: a node ignites (with a flare) as the
 * front passes it, and each link grows from its lit end to exactly where the
 * front has reached. Positions come from time (drift, twinkle, pulses) and the
 * front only — no simulation state — so any jumped-to scroll is exact and it
 * all holds still when motion is off.
 */

const HOOKS = [
  // hook eyes in mark units (from the mark's SVG: circle centres, y up)
  [0.00085, 0.34904],
  [-0.34896, -0.00093],
  [-0.00085, -0.34899],
  [0.34896, 0.00093],
] as const
const SAT = 8
const N = 5 + SAT
const PULSES = 8
/** skeleton: four spokes and the anchor ring */
const SKELETON = [
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 1],
] as const
const MAX_LINKS = (N * (N - 1)) / 2
/** satellites link to anything closer than this (mark units) */
const LINK = 0.2

const RIBBON_VERT = /* glsl */ `
  attribute vec3 aB;
  attribute vec2 aCorner;   // x: 0 at this end (position), 1 at the other (aB); y: side -1 | 1
  attribute float aW;       // half width, world units
  attribute vec3 color;
  uniform float uMinW;      // minimum half width, NDC
  varying vec3 vCol;
  varying float vSide;
  void main() {
    vec4 ca = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec4 cb = projectionMatrix * modelViewMatrix * vec4(aB, 1.0);
    vec4 c = aCorner.x < 0.5 ? ca : cb;
    float asp = projectionMatrix[1][1] / projectionMatrix[0][0];
    vec2 sa = ca.xy / max(ca.w, 1e-4);
    vec2 sb = cb.xy / max(cb.w, 1e-4);
    vec2 d = (sb - sa) * vec2(asp, 1.0);
    float l = length(d);
    vec2 dir = l > 1e-6 ? d / l : vec2(1.0, 0.0);
    vec2 n = vec2(-dir.y / asp, dir.x);
    float hw = max(aW * projectionMatrix[1][1], uMinW * c.w);
    c.xy += n * aCorner.y * hw;
    vCol = color;
    vSide = aCorner.y;
    gl_Position = c;
  }
`
const RIBBON_FRAG = /* glsl */ `
  varying vec3 vCol;
  varying float vSide;
  void main() {
    float a = 1.0 - smoothstep(0.25, 1.0, abs(vSide));
    if (a <= 0.003) discard;
    gl_FragColor = vec4(vCol * a, 1.0);
  }
`
const NODE_VERT = /* glsl */ `
  attribute float aSize;    // sprite diameter, world units
  attribute vec3 color;
  uniform float uPx;
  varying vec3 vCol;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vCol = color;
    gl_PointSize = clamp(aSize * projectionMatrix[1][1] * 0.5 * uPx / max(-mv.z, 0.05), 1.0, 128.0);
    gl_Position = aSize > 0.0 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
  }
`
const NODE_FRAG = /* glsl */ `
  varying vec3 vCol;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float halo = 1.0 - smoothstep(0.0, 1.0, d);
    float a = halo * halo * 0.32 + exp(-d * d * 34.0);
    if (a <= 0.004) discard;
    gl_FragColor = vec4(vCol * a, 1.0);
  }
`

export class Heart {
  group = new THREE.Group()
  private base = new Float32Array(N * 3)
  private ph = new Float32Array(N * 4)
  private col = new Float32Array(N * 3)
  private size = new Float32Array(N)
  private pos = new Float32Array(N * 3)
  private sAx = new Float32Array(N)
  private lit = new Float32Array(N)
  private pulse = new Float32Array(PULSES * 2)
  private nodePos: Float32Array
  private nodeCol: Float32Array
  private nodeSize: Float32Array
  private rA: Float32Array
  private rB: Float32Array
  private rCol: Float32Array
  private rW: Float32Array
  private nodes: THREE.Points
  private ribbons: THREE.Mesh
  /** the dynamic attributes, flagged for upload each frame (kept to avoid per-frame lookups) */
  private dirty: THREE.BufferAttribute[] = []
  private white = new THREE.Color(G.white)

  /** S: the mark's scale (world units per mark unit); hub: the diamond's centre (mark units) */
  constructor(
    private S: number,
    hub: THREE.Vector3,
    mobile: boolean,
  ) {
    const r = rng(29)
    const ice = new THREE.Color(G.ice)
    const violet = new THREE.Color(G.violet)
    const peach = new THREE.Color(G.peach)
    const hubC = new THREE.Color('#eaf5ff')
    const setCol = (i: number, c: THREE.Color, k: number) => {
      this.col[i * 3] = c.r * k
      this.col[i * 3 + 1] = c.g * k
      this.col[i * 3 + 2] = c.b * k
    }
    // hub + hook anchors
    this.base.set([hub.x, hub.y, 0], 0)
    setCol(0, hubC, 3)
    this.size[0] = 0.16
    for (let k = 0; k < 4; k++) {
      this.base.set([HOOKS[k][0], HOOKS[k][1], 0], (k + 1) * 3)
      setCol(k + 1, ice, 2.6)
      this.size[k + 1] = 0.13
    }
    // satellites: mostly in the open diagonal channels either side of the hub
    for (let k = 0; k < SAT; k++) {
      const i = 5 + k
      const side = k % 2 === 0 ? 1 : -1
      const a = Math.PI / 4 + (side < 0 ? Math.PI : 0) + (r() - 0.5) * 1.3
      const rad = 0.09 + 0.22 * Math.sqrt(r())
      this.base.set([hub.x + Math.cos(a) * rad, hub.y + Math.sin(a) * rad, (r() - 0.5) * 0.1], i * 3)
      setCol(i, k === 3 ? peach : r() < 0.55 ? ice : violet, k === 3 ? 1.7 : 1.4 + 0.5 * r())
      this.size[i] = 0.05 + 0.03 * r()
    }
    for (let i = 0; i < N * 4; i++) this.ph[i] = r() * Math.PI * 2
    for (let k = 0; k < PULSES; k++) {
      this.pulse[k * 2] = r()
      this.pulse[k * 2 + 1] = 0.26 + 0.12 * r()
    }
    // sizes are sprite diameters in world units
    for (let i = 0; i < N; i++) this.size[i] *= S * (mobile ? 1.15 : 1)

    // ---- nodes + pulses (one Points)
    const P = N + PULSES
    this.nodePos = new Float32Array(P * 3)
    this.nodeCol = new Float32Array(P * 3)
    this.nodeSize = new Float32Array(P)
    const ng = new THREE.BufferGeometry()
    ng.setAttribute('position', new THREE.BufferAttribute(this.nodePos, 3).setUsage(THREE.DynamicDrawUsage))
    ng.setAttribute('color', new THREE.BufferAttribute(this.nodeCol, 3).setUsage(THREE.DynamicDrawUsage))
    ng.setAttribute('aSize', new THREE.BufferAttribute(this.nodeSize, 1).setUsage(THREE.DynamicDrawUsage))
    ng.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
    const nm = new THREE.ShaderMaterial({
      uniforms: { uPx: { value: 900 } },
      vertexShader: NODE_VERT,
      fragmentShader: NODE_FRAG,
      transparent: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    this.nodes = new THREE.Points(ng, nm)
    this.nodes.frustumCulled = false

    // ---- links: screen-facing ribbons (a GL line is 1 device px: too faint through glass)
    const V = MAX_LINKS * 4
    this.rA = new Float32Array(V * 3)
    this.rB = new Float32Array(V * 3)
    this.rCol = new Float32Array(V * 3)
    this.rW = new Float32Array(V)
    const corner = new Float32Array(V * 2)
    const index = new Uint16Array(MAX_LINKS * 6)
    for (let l = 0; l < MAX_LINKS; l++) {
      const v = l * 4
      corner.set([0, -1, 0, 1, 1, -1, 1, 1], v * 2)
      index.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], l * 6)
    }
    const rg = new THREE.BufferGeometry()
    rg.setAttribute('position', new THREE.BufferAttribute(this.rA, 3).setUsage(THREE.DynamicDrawUsage))
    rg.setAttribute('aB', new THREE.BufferAttribute(this.rB, 3).setUsage(THREE.DynamicDrawUsage))
    rg.setAttribute('color', new THREE.BufferAttribute(this.rCol, 3).setUsage(THREE.DynamicDrawUsage))
    rg.setAttribute('aW', new THREE.BufferAttribute(this.rW, 1).setUsage(THREE.DynamicDrawUsage))
    rg.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2))
    rg.setIndex(new THREE.BufferAttribute(index, 1))
    rg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
    const rm = new THREE.ShaderMaterial({
      uniforms: { uMinW: { value: 1 / 900 } },
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      transparent: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
    })
    this.ribbons = new THREE.Mesh(rg, rm)
    this.ribbons.frustumCulled = false

    // the glass buffer is smaller than the frame: keep sprite / line sizes per render target
    const perTarget = (m: THREE.ShaderMaterial, set: (px: number) => boolean) => (renderer: THREE.WebGLRenderer) => {
      const rt = renderer.getRenderTarget()
      if (set(rt ? rt.height : renderer.domElement.height)) m.uniformsNeedUpdate = true
    }
    this.nodes.onBeforeRender = perTarget(nm, px => {
      if (nm.uniforms.uPx.value === px) return false
      nm.uniforms.uPx.value = px
      return true
    })
    this.ribbons.onBeforeRender = perTarget(rm, px => {
      const w = 0.9 / Math.max(1, px)
      if (rm.uniforms.uMinW.value === w) return false
      rm.uniforms.uMinW.value = w
      return true
    })
    this.group.add(this.ribbons, this.nodes)
    for (const name of ['position', 'color', 'aSize']) this.dirty.push(ng.getAttribute(name) as THREE.BufferAttribute)
    for (const name of ['position', 'aB', 'color', 'aW']) this.dirty.push(rg.getAttribute(name) as THREE.BufferAttribute)
  }

  /**
   * time: idle clock (already calm-scaled for reduced motion); front: the
   * crystallization front along `dir` in the chapter group's units (1e4 = all
   * lit); hot: the front's flare width; gain: overall brightness; pulses: run
   * the beads (off under reduced motion).
   */
  update(time: number, front: number, dir: THREE.Vector2, hot: number, gain: number, pulses: boolean) {
    const S = this.S
    const b = this.base
    const p = this.pos
    const ph = this.ph
    // ---- nodes: drift (satellites wander, anchors breathe), ignition, twinkle
    for (let i = 0; i < N; i++) {
      const amp = i === 0 ? 0.004 : i < 5 ? 0.006 : 0.03
      const q = i * 4
      p[i * 3] = b[i * 3] + Math.sin(time * 0.37 + ph[q]) * amp
      p[i * 3 + 1] = b[i * 3 + 1] + Math.cos(time * 0.31 + ph[q + 1]) * amp
      p[i * 3 + 2] = b[i * 3 + 2] + Math.sin(time * 0.23 + ph[q + 2]) * amp * 0.6
      const s = (p[i * 3] * dir.x + p[i * 3 + 1] * dir.y) * S
      this.sAx[i] = s
      const past = front - s
      const lit = past <= -hot ? 0 : past >= hot ? 1 : 0.5 + 0.5 * Math.sin((past / hot) * Math.PI * 0.5)
      this.lit[i] = lit
      const fx = past / (hot * 2.2)
      const flare = past > -hot && past < hot * 6 ? Math.exp(-fx * fx) : 0
      const tw = 0.8 + 0.2 * Math.sin(time * (0.9 + (ph[q + 3] / 6.283) * 0.8) + ph[q + 3] * 3)
      // the hub and anchors flare as the front passes; satellites only brighten a touch
      const fk = i < 5 ? 1.6 : 0.5
      const k = lit * tw * (1 + flare * fk) * gain
      const o = i * 3
      this.nodePos[o] = p[o]
      this.nodePos[o + 1] = p[o + 1]
      this.nodePos[o + 2] = p[o + 2]
      this.nodeCol[o] = this.col[o] * k
      this.nodeCol[o + 1] = this.col[o + 1] * k
      this.nodeCol[o + 2] = this.col[o + 2] * k
      this.nodeSize[i] = lit > 0.001 ? this.size[i] * (0.55 + 0.45 * lit) * (1 + flare * fk * 0.45) : 0
    }

    // ---- links: the skeleton, then particles.js links around the satellites
    let n = 0
    for (let l = 0; l < SKELETON.length; l++) {
      const i = SKELETON[l][0]
      const j = SKELETON[l][1]
      const breathe = 0.85 + 0.15 * Math.sin(time * 0.6 + l * 1.7)
      n = this.link(n, i, j, front, (l < 4 ? 1.25 : 1.0) * breathe * gain, l < 4 ? 0.0058 : 0.005)
    }
    for (let i = 0; i < N; i++) {
      for (let j = Math.max(i + 1, 5); j < N; j++) {
        const dx = p[i * 3] - p[j * 3]
        const dy = p[i * 3 + 1] - p[j * 3 + 1]
        const dz = p[i * 3 + 2] - p[j * 3 + 2]
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (d >= LINK) continue
        const t = 1 - d / LINK
        n = this.link(n, i, j, front, t * t * 1.1 * gain, 0.0038)
      }
    }
    this.ribbons.geometry.setDrawRange(0, n * 6)

    // ---- pulses: beads running out along the spokes, then round the ring
    for (let k = 0; k < PULSES; k++) {
      const i = SKELETON[k][0]
      const j = SKELETON[k][1]
      const o = (N + k) * 3
      const u = time * this.pulse[k * 2 + 1] + this.pulse[k * 2]
      const f = u - Math.floor(u)
      const on = pulses ? Math.sin(f * Math.PI) * Math.min(this.lit[i], this.lit[j]) : 0
      this.nodePos[o] = p[i * 3] + (p[j * 3] - p[i * 3]) * f
      this.nodePos[o + 1] = p[i * 3 + 1] + (p[j * 3 + 1] - p[i * 3 + 1]) * f
      this.nodePos[o + 2] = p[i * 3 + 2] + (p[j * 3 + 2] - p[i * 3 + 2]) * f
      const k2 = on * 2.6 * gain
      this.nodeCol[o] = this.white.r * k2
      this.nodeCol[o + 1] = this.white.g * k2
      this.nodeCol[o + 2] = this.white.b * k2
      this.nodeSize[N + k] = on > 0.01 ? 0.05 * S * (0.6 + 0.4 * on) : 0
    }
    for (let d = 0; d < this.dirty.length; d++) this.dirty[d].needsUpdate = true
  }

  /** write link i–j (clipped to the part the front has reached); returns the new count */
  private link(n: number, i: number, j: number, front: number, k: number, halfW: number): number {
    if (k < 0.004 || n >= MAX_LINKS) return n
    const si = this.sAx[i]
    const sj = this.sAx[j]
    if (si > front && sj > front) return n
    const p = this.pos
    // lit end → where the front is
    const a = si <= sj ? i : j
    const c = si <= sj ? j : i
    const sa = Math.min(si, sj)
    const sc = Math.max(si, sj)
    const t = sc <= front ? 1 : (front - sa) / Math.max(1e-5, sc - sa)
    const ax = p[a * 3]
    const ay = p[a * 3 + 1]
    const az = p[a * 3 + 2]
    const bx = ax + (p[c * 3] - ax) * t
    const by = ay + (p[c * 3 + 1] - ay) * t
    const bz = az + (p[c * 3 + 2] - az) * t
    const la = this.lit[a]
    const lc = t >= 1 ? this.lit[c] : 1
    const v = n * 4
    for (let q = 0; q < 4; q++) {
      const o = (v + q) * 3
      this.rA[o] = ax
      this.rA[o + 1] = ay
      this.rA[o + 2] = az
      this.rB[o] = bx
      this.rB[o + 1] = by
      this.rB[o + 2] = bz
      // colour runs from each end's node colour (normalized), so a spoke fades ice → white
      const e = q < 2 ? a : c
      const m = (q < 2 ? la : lc) * k
      const cr = this.col[e * 3]
      const cg = this.col[e * 3 + 1]
      const cb = this.col[e * 3 + 2]
      const nrm = 1 / Math.max(cr, cg, cb, 1e-3)
      this.rCol[o] = cr * nrm * m
      this.rCol[o + 1] = cg * nrm * m
      this.rCol[o + 2] = cb * nrm * m
      this.rW[v + q] = halfW * this.S
    }
    return n + 1
  }
}
