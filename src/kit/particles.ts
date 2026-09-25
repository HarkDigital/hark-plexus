import * as THREE from 'three'
import { logoPoints } from '../logo/logo'

/*
 * Hark Plexus particle kit — the particles.js vocabulary, in 3D.
 *
 *   new Morph(count, o)          a point cloud that MORPHS between shapes:
 *                                morph.to(slot 'a'|'b', positions) then drive
 *                                morph.set(o) every frame with ONE reused
 *                                MorphSet { mix, time, size, opacity, colorA,
 *                                colorB, swirl, px }. mix 0 = shape a,
 *                                1 = shape b; particles travel on staggered,
 *                                swirling paths (never in straight lines).
 *   shapes                       position generators (Float32Array xyz):
 *     markShape(n, {size, depth})   the Hark mark (area-uniform on its face)
 *     textShape(text, n, {height, weight})  particles sampled from canvas text
 *     sphereShape(n, r, {shell})    sphere or shell
 *     ringShape(n, r, {thickness})  torus-ish ring
 *     gridShape(n, w, h)            a flat grid (a 'layout' / wireframe)
 *     cloudShape(n, box)            random volume
 *     waveShape(n, {width, amp, freq, rows, phase})  a sound-wave ribbon
 *     glyphShape(draw, n, {size})   sample any canvas drawing (icons)
 *   new Constellation(o)         the particles.js network on the CPU: nodes
 *                                drift in a box, lines join pairs within
 *                                `link` distance (alpha by distance), the
 *                                pointer (a world point) repels nodes.
 *                                c.update(dt, pointerWorld | null, calm)
 *   new Dust(o)                  ambient floating particles with gentle
 *                                magnetism to the pointer (Particles.tsx look)
 *
 * All particles are additive, soft round sprites with a slight twinkle; size
 * is in world units (they scale with distance like real objects). They sit
 * in front of glass (transparent: glass does not refract them — the world's
 * backdrop network is what glass bends).
 */

const SPRITE_VERT = /* glsl */ `
  attribute vec3 aFrom;
  attribute vec3 aTo;
  attribute vec4 aRand;
  uniform float uMix, uTime, uSize, uSwirl, uPx;
  varying float vMix;
  varying float vTw;
  vec3 swirlOffset(vec3 p, float k, vec4 r) {
    float a = r.z * 6.2831 + uTime * 0.6;
    return vec3(sin(a + p.y * 1.7), cos(a * 1.3 + p.x * 1.3), sin(a * 0.7 + p.z)) * k;
  }
  void main() {
    // staggered progress per particle
    float m = clamp((uMix - aRand.x * 0.35) / 0.65, 0.0, 1.0);
    m = m * m * (3.0 - 2.0 * m);
    vec3 p = mix(aFrom, aTo, m);
    // mid-flight swirl
    float fly = 4.0 * m * (1.0 - m);
    p += swirlOffset(p, uSwirl * fly * (0.4 + aRand.y), aRand);
    // idle shimmer
    p += vec3(sin(uTime * (0.7 + aRand.y) + aRand.z * 9.0), cos(uTime * (0.6 + aRand.x) + aRand.w * 9.0), 0.0) * 0.012 * (0.5 + aRand.w);
    vMix = m;
    vTw = 0.75 + 0.25 * sin(uTime * (1.5 + aRand.w * 2.0) + aRand.z * 20.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = clamp(uSize * (0.6 + aRand.y * 0.8) * projectionMatrix[1][1] * 0.5 * uPx / max(-mv.z, 0.05), 1.0, 64.0);
    gl_Position = projectionMatrix * mv;
  }
`
const SPRITE_FRAG = /* glsl */ `
  uniform vec3 uColorA, uColorB;
  uniform float uOpacity;
  varying float vMix;
  varying float vTw;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float core = 1.0 - smoothstep(0.0, 0.5, d);
    float a = core * core * uOpacity * vTw;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(mix(uColorA, uColorB, vMix) * a, 1.0);
  }
`

function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => ((s = (s * 16807) % 2147483647) / 2147483647)
}

export class Morph {
  points: THREE.Points
  private geo: THREE.BufferGeometry
  private u = {
    uMix: { value: 0 },
    uTime: { value: 0 },
    uSize: { value: 0.03 },
    uSwirl: { value: 0.6 },
    uPx: { value: 900 },
    uOpacity: { value: 1 },
    uColorA: { value: new THREE.Color('#c9e4ff') },
    uColorB: { value: new THREE.Color('#c9e4ff') },
  }
  constructor(
    readonly count: number,
    o: { seed?: number; size?: number; colorA?: THREE.ColorRepresentation; colorB?: THREE.ColorRepresentation } = {},
  ) {
    const r = rng(o.seed ?? 7)
    const g = new THREE.BufferGeometry()
    const rand = new Float32Array(count * 4)
    for (let i = 0; i < rand.length; i++) rand[i] = r()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
    g.setAttribute('aFrom', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
    g.setAttribute('aTo', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
    g.setAttribute('aRand', new THREE.BufferAttribute(rand, 4))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
    this.geo = g
    if (o.size) this.u.uSize.value = o.size
    if (o.colorA) this.u.uColorA.value.set(o.colorA)
    if (o.colorB) this.u.uColorB.value.set(o.colorB)
    const m = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: SPRITE_VERT,
      fragmentShader: SPRITE_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    this.points = new THREE.Points(g, m)
    this.points.frustumCulled = false
    // sprite size in world units: read the height of whatever target is being
    // drawn (the canvas, the post chain, or three's smaller glass buffer)
    this.points.onBeforeRender = r => {
      const rt = r.getRenderTarget()
      this.u.uPx.value = rt ? rt.height : r.domElement.height
    }
  }
  /** Set shape 'a' (mix 0) or 'b' (mix 1). positions.length must be count*3 (shorter arrays repeat). */
  to(slot: 'a' | 'b', positions: Float32Array) {
    const attr = this.geo.getAttribute(slot === 'a' ? 'aFrom' : 'aTo') as THREE.BufferAttribute
    const dst = attr.array as Float32Array
    const n = positions.length
    for (let i = 0; i < dst.length; i++) dst[i] = positions[i % n]
    attr.needsUpdate = true
  }
  /**
   * Per frame. `px` = drawing-buffer height in px (for world-size sprites).
   * Allocation-free: hoist one MorphSet object and reuse it every frame; a
   * colour given as a string / number is only re-parsed when it changes (a
   * THREE.Color is copied, so it may be mutated between frames).
   */
  set(o: MorphSet) {
    const u = this.u
    if (o.mix !== undefined) u.uMix.value = o.mix
    if (o.time !== undefined) u.uTime.value = o.time
    if (o.size !== undefined) u.uSize.value = o.size
    if (o.opacity !== undefined) u.uOpacity.value = o.opacity
    if (o.swirl !== undefined) u.uSwirl.value = o.swirl
    if (o.px !== undefined) u.uPx.value = o.px
    if (o.colorA !== undefined && o.colorA !== this.lastA) {
      u.uColorA.value.set(o.colorA)
      this.lastA = typeof o.colorA === 'object' ? undefined : o.colorA
    }
    if (o.colorB !== undefined && o.colorB !== this.lastB) {
      u.uColorB.value.set(o.colorB)
      this.lastB = typeof o.colorB === 'object' ? undefined : o.colorB
    }
  }
  private lastA: THREE.ColorRepresentation | undefined
  private lastB: THREE.ColorRepresentation | undefined
}

/** Morph.set options: keep one per Morph and reuse it every frame (no per-frame allocation). */
export interface MorphSet {
  mix?: number
  time?: number
  size?: number
  opacity?: number
  swirl?: number
  px?: number
  colorA?: THREE.ColorRepresentation
  colorB?: THREE.ColorRepresentation
}

/* ---------------------------------------------------------------- shapes */

/** The Hark mark: `n` points on its face, `size` tall, centred, facing +z. */
export function markShape(n: number, o: { size?: number; depth?: number; seed?: number } = {}): Float32Array {
  const pts = logoPoints(n, { depth: o.depth ?? 0.06, seed: o.seed ?? 5 })
  const s = o.size ?? 1
  for (let i = 0; i < pts.length; i++) pts[i] *= s
  return pts
}

/** Sample any canvas drawing (white on transparent) into `n` points, `size` tall, centred on XY. */
export function glyphShape(draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, n: number, o: { size?: number; w?: number; h?: number; depth?: number; seed?: number } = {}): Float32Array {
  const W = o.w ?? 256
  const H = o.h ?? 256
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const g = cv.getContext('2d', { willReadFrequently: true })!
  g.fillStyle = '#fff'
  g.strokeStyle = '#fff'
  draw(g, W, H)
  const data = g.getImageData(0, 0, W, H).data
  const hits: number[] = []
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) if (data[(y * W + x) * 4 + 3] > 128) hits.push(x, y)
  const out = new Float32Array(n * 3)
  const r = rng(o.seed ?? 3)
  const size = o.size ?? 1
  const scale = size / H
  const count = hits.length / 2
  for (let i = 0; i < n; i++) {
    const k = count ? Math.floor(r() * count) : 0
    const x = count ? hits[k * 2] + r() : W / 2
    const y = count ? hits[k * 2 + 1] + r() : H / 2
    out[i * 3] = (x - W / 2) * scale
    out[i * 3 + 1] = -(y - H / 2) * scale
    out[i * 3 + 2] = (r() - 0.5) * (o.depth ?? 0.04)
  }
  return out
}

/** Particles sampled from text (Sora), `height` tall, centred. */
export function textShape(text: string, n: number, o: { height?: number; weight?: number; font?: string; depth?: number } = {}): Float32Array {
  const px = 160
  const font = `${o.weight ?? 600} ${px}px ${o.font ?? "'Sora Variable', 'Sora', system-ui, sans-serif"}`
  const probe = document.createElement('canvas').getContext('2d')!
  probe.font = font
  const W = Math.ceil(probe.measureText(text).width) + 40
  const H = Math.ceil(px * 1.3)
  const height = o.height ?? 0.4
  return glyphShape(
    (g, w, h) => {
      g.font = font
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(text, w / 2, h / 2)
    },
    n,
    { w: W, h: H, size: height * 1.3, depth: o.depth },
  )
}

export function sphereShape(n: number, r = 1, o: { shell?: boolean; seed?: number } = {}): Float32Array {
  const rr = rng(o.seed ?? 11)
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const u = rr() * 2 - 1
    const t = rr() * Math.PI * 2
    const s = Math.sqrt(1 - u * u)
    const k = o.shell ? 1 : Math.cbrt(rr())
    out[i * 3] = s * Math.cos(t) * r * k
    out[i * 3 + 1] = u * r * k
    out[i * 3 + 2] = s * Math.sin(t) * r * k
  }
  return out
}

export function ringShape(n: number, r = 1, o: { thickness?: number; seed?: number } = {}): Float32Array {
  const rr = rng(o.seed ?? 13)
  const th = o.thickness ?? 0.08
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const a = rr() * Math.PI * 2
    const b = rr() * Math.PI * 2
    const rad = th * Math.sqrt(rr())
    out[i * 3] = (r + Math.cos(b) * rad) * Math.cos(a)
    out[i * 3 + 1] = (r + Math.cos(b) * rad) * Math.sin(a)
    out[i * 3 + 2] = Math.sin(b) * rad
  }
  return out
}

export function gridShape(n: number, w = 2, h = 1.2, o: { cols?: number; rows?: number } = {}): Float32Array {
  const cols = o.cols ?? Math.round(Math.sqrt((n * w) / h))
  const rows = Math.ceil(n / cols)
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const c = i % cols
    const r = Math.floor(i / cols)
    out[i * 3] = (c / Math.max(1, cols - 1) - 0.5) * w
    out[i * 3 + 1] = (0.5 - r / Math.max(1, rows - 1)) * h
    out[i * 3 + 2] = 0
  }
  return out
}

export function cloudShape(n: number, box: THREE.Box3, seed = 17): Float32Array {
  const rr = rng(seed)
  const out = new Float32Array(n * 3)
  const s = box.getSize(new THREE.Vector3())
  for (let i = 0; i < n; i++) {
    out[i * 3] = box.min.x + rr() * s.x
    out[i * 3 + 1] = box.min.y + rr() * s.y
    out[i * 3 + 2] = box.min.z + rr() * s.z
  }
  return out
}

export function waveShape(n: number, o: { width?: number; amp?: number; freq?: number; rows?: number; phase?: number; seed?: number } = {}): Float32Array {
  const rr = rng(o.seed ?? 19)
  const w = o.width ?? 3
  const amp = o.amp ?? 0.3
  const f = o.freq ?? 3
  const rows = o.rows ?? 5
  const ph = o.phase ?? 0
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const x = (rr() - 0.5) * w
    const row = Math.floor(rr() * rows)
    const env = Math.exp(-((x / (w * 0.45)) ** 2) * 2)
    const y = Math.sin(x * f + ph + row * 0.35) * amp * env * (1 - row * 0.12)
    out[i * 3] = x
    out[i * 3 + 1] = y + (rr() - 0.5) * 0.015
    out[i * 3 + 2] = (row - rows / 2) * 0.03
  }
  return out
}

/* ------------------------------------------------------- constellation */

/**
 * particles.js in 3D: `count` nodes drift inside `box`, lines join pairs
 * closer than `link` (alpha falls with distance), the pointer (a world
 * point) repels nodes within `repel`. Add `c.group` to your chapter.
 */
export class Constellation {
  group = new THREE.Group()
  private pos: Float32Array
  private vel: Float32Array
  private linePos: Float32Array
  private lineCol: Float32Array
  private lines: THREE.LineSegments
  private dots: THREE.Points
  private maxLinks: number
  private color = new THREE.Color()
  constructor(
    private o: { count?: number; box: THREE.Box3; link?: number; repel?: number; color?: THREE.ColorRepresentation; nodeSize?: number; maxLinks?: number; seed?: number },
  ) {
    const n = o.count ?? 90
    const rr = rng(o.seed ?? 23)
    this.pos = cloudShape(n, o.box, o.seed ?? 23)
    this.vel = new Float32Array(n * 3)
    for (let i = 0; i < this.vel.length; i++) this.vel[i] = (rr() - 0.5) * 0.12
    this.maxLinks = o.maxLinks ?? n * 4
    this.linePos = new Float32Array(this.maxLinks * 6)
    this.lineCol = new Float32Array(this.maxLinks * 6)
    this.color.set(o.color ?? '#88c4ff')
    const lg = new THREE.BufferGeometry()
    lg.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage))
    lg.setAttribute('color', new THREE.BufferAttribute(this.lineCol, 3).setUsage(THREE.DynamicDrawUsage))
    lg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
    this.lines = new THREE.LineSegments(
      lg,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
    )
    this.lines.frustumCulled = false
    const dg = new THREE.BufferGeometry()
    dg.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    dg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
    this.dots = new THREE.Points(
      dg,
      new THREE.PointsMaterial({ color: new THREE.Color(o.color ?? '#c9e4ff').multiplyScalar(1.6), size: o.nodeSize ?? 0.035, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, map: dotTexture(), alphaTest: 0.01 }),
    )
    this.dots.frustumCulled = false
    this.group.add(this.lines, this.dots)
  }
  /** strength 0..1 fades the whole network */
  update(dt: number, pointer: THREE.Vector3 | null, calm = false, strength = 1) {
    const { box } = this.o
    const link = this.o.link ?? 0.9
    const repel = this.o.repel ?? 0.8
    const p = this.pos
    const v = this.vel
    const n = p.length / 3
    const step = calm ? dt * 0.25 : dt
    for (let i = 0; i < n; i++) {
      const ix = i * 3
      if (pointer && !calm) {
        const dx = p[ix] - pointer.x
        const dy = p[ix + 1] - pointer.y
        const dz = p[ix + 2] - pointer.z
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (d < repel && d > 1e-4) {
          const f = ((repel - d) / repel) * 2.2 * dt
          v[ix] += (dx / d) * f
          v[ix + 1] += (dy / d) * f
          v[ix + 2] += (dz / d) * f
        }
      }
      for (let a = 0; a < 3; a++) {
        v[ix + a] *= 0.985
        p[ix + a] += v[ix + a] * step
      }
      // soft bounce inside the box
      if (p[ix] < box.min.x || p[ix] > box.max.x) v[ix] *= -1
      if (p[ix + 1] < box.min.y || p[ix + 1] > box.max.y) v[ix + 1] *= -1
      if (p[ix + 2] < box.min.z || p[ix + 2] > box.max.z) v[ix + 2] *= -1
      p[ix] = Math.min(box.max.x, Math.max(box.min.x, p[ix]))
      p[ix + 1] = Math.min(box.max.y, Math.max(box.min.y, p[ix + 1]))
      p[ix + 2] = Math.min(box.max.z, Math.max(box.min.z, p[ix + 2]))
      // keep a gentle minimum drift
      const sp = Math.abs(v[ix]) + Math.abs(v[ix + 1])
      if (sp < 0.02) {
        v[ix] += Math.sin(i * 12.9 + ix) * 0.004
        v[ix + 1] += Math.cos(i * 7.3) * 0.004
      }
    }
    let k = 0
    const L2 = link * link
    const c = this.color
    for (let i = 0; i < n && k < this.maxLinks; i++) {
      for (let j = i + 1; j < n && k < this.maxLinks; j++) {
        const dx = p[i * 3] - p[j * 3]
        const dy = p[i * 3 + 1] - p[j * 3 + 1]
        const dz = p[i * 3 + 2] - p[j * 3 + 2]
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 > L2) continue
        const a = (1 - Math.sqrt(d2) / link) * 0.55 * strength
        const o6 = k * 6
        this.linePos[o6] = p[i * 3]
        this.linePos[o6 + 1] = p[i * 3 + 1]
        this.linePos[o6 + 2] = p[i * 3 + 2]
        this.linePos[o6 + 3] = p[j * 3]
        this.linePos[o6 + 4] = p[j * 3 + 1]
        this.linePos[o6 + 5] = p[j * 3 + 2]
        this.lineCol[o6] = this.lineCol[o6 + 3] = c.r * a
        this.lineCol[o6 + 1] = this.lineCol[o6 + 4] = c.g * a
        this.lineCol[o6 + 2] = this.lineCol[o6 + 5] = c.b * a
        k++
      }
    }
    const lg = this.lines.geometry
    lg.setDrawRange(0, k * 2)
    ;(lg.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(lg.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true
    ;(this.dots.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(this.dots.material as THREE.PointsMaterial).opacity = strength
  }
}

let _dot: THREE.Texture | null = null
/** A soft round sprite texture for PointsMaterial. */
export function dotTexture(): THREE.Texture {
  if (_dot) return _dot
  const cv = document.createElement('canvas')
  cv.width = cv.height = 64
  const g = cv.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.35, 'rgba(255,255,255,0.6)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  _dot = new THREE.CanvasTexture(cv)
  return _dot
}

/**
 * Ambient floating dust (the Particles.tsx look): tiny points drifting in a
 * box, each with its own 'magnetism' toward the pointer (parallax-like).
 */
export class Dust {
  points: THREE.Points
  private base: Float32Array
  private pos: Float32Array
  private mag: Float32Array
  constructor(o: { count?: number; box: THREE.Box3; size?: number; color?: THREE.ColorRepresentation; seed?: number }) {
    const n = o.count ?? 400
    this.base = cloudShape(n, o.box, o.seed ?? 29)
    this.pos = this.base.slice()
    const rr = rng(o.seed ?? 29)
    this.mag = new Float32Array(n)
    for (let i = 0; i < n; i++) this.mag[i] = 0.1 + rr() * 0.9
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
    this.points = new THREE.Points(
      g,
      new THREE.PointsMaterial({ color: new THREE.Color(o.color ?? '#dfe9ff'), size: o.size ?? 0.02, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, map: dotTexture(), opacity: 0.8, toneMapped: false }),
    )
    this.points.frustumCulled = false
  }
  /** pointer: -1..1 screen pointer (frame.pointer); time: seconds */
  update(time: number, pointer: THREE.Vector2, strength = 1) {
    const n = this.mag.length
    for (let i = 0; i < n; i++) {
      const m = this.mag[i]
      const ix = i * 3
      this.pos[ix] = this.base[ix] + Math.sin(time * 0.15 + i) * 0.06 + pointer.x * 0.25 * m
      this.pos[ix + 1] = this.base[ix + 1] + Math.cos(time * 0.12 + i * 1.3) * 0.05 + pointer.y * 0.18 * m
    }
    ;(this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(this.points.material as THREE.PointsMaterial).opacity = 0.8 * strength
  }
}
