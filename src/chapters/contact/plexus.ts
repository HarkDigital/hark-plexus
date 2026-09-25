import * as THREE from 'three'

/*
 * Chapter-local particles.js renderers for CONNECT.
 *
 *   Segments   anti-aliased screen-space lines (instanced quads): every link
 *              is a soft 1–1.5 CSS px beam whose colour and alpha run from one
 *              end to the other (particles.js 'alpha by distance', plus
 *              gradients: the visitor's peach running into the ice network).
 *   Sprites    glowing nodes in CSS px (a crisp core + a soft halo, the
 *              Constellation.tsx 'glow' look), with a second kind for thin
 *              rings (the visitor's node, the copy pulse).
 *
 * Both are rebuilt from CPU arrays every frame (a few hundred items) and
 * blend additively. They live inside the chapter's rig (scaled), so every
 * position is in rig units; sizes and widths are screen pixels.
 */

const SEG_VERT = /* glsl */ `
  attribute vec3 aA;
  attribute vec3 aB;
  attribute vec4 aCA;
  attribute vec4 aCB;
  uniform vec2 uRes;
  uniform float uHalf;
  varying vec4 vCol;
  varying float vV;
  void main() {
    vec4 ca = projectionMatrix * modelViewMatrix * vec4(aA, 1.0);
    vec4 cb = projectionMatrix * modelViewMatrix * vec4(aB, 1.0);
    vec2 sa = ca.xy / max(ca.w, 1e-4) * uRes * 0.5;
    vec2 sb = cb.xy / max(cb.w, 1e-4) * uRes * 0.5;
    vec2 d = sb - sa;
    float L = length(d);
    vec2 dir = L > 1e-4 ? d / L : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    float t = position.x;
    vec4 c = mix(ca, cb, t);
    c.xy += nrm * position.y * uHalf * 2.0 / uRes * c.w;
    vCol = mix(aCA, aCB, t);
    vV = position.y;
    gl_Position = c;
  }
`
const SEG_FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec4 vCol;
  varying float vV;
  void main() {
    float a = (1.0 - smoothstep(0.3, 1.0, abs(vV))) * vCol.a * uOpacity;
    if (a <= 0.002) discard;
    gl_FragColor = vec4(vCol.rgb * a, 1.0);
  }
`

export class Segments {
  mesh: THREE.Mesh
  count = 0
  private aA: Float32Array
  private aB: Float32Array
  private aCA: Float32Array
  private aCB: Float32Array
  private geo: THREE.InstancedBufferGeometry
  private u = {
    uRes: { value: new THREE.Vector2(1, 1) },
    uHalf: { value: 1.5 },
    uOpacity: { value: 1 },
  }
  constructor(readonly max: number) {
    const g = new THREE.InstancedBufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0]), 3))
    g.setIndex([0, 1, 2, 2, 1, 3])
    this.aA = new Float32Array(max * 3)
    this.aB = new Float32Array(max * 3)
    this.aCA = new Float32Array(max * 4)
    this.aCB = new Float32Array(max * 4)
    g.setAttribute('aA', new THREE.InstancedBufferAttribute(this.aA, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aB', new THREE.InstancedBufferAttribute(this.aB, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aCA', new THREE.InstancedBufferAttribute(this.aCA, 4).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aCB', new THREE.InstancedBufferAttribute(this.aCB, 4).setUsage(THREE.DynamicDrawUsage))
    g.instanceCount = 0
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
    this.geo = g
    const m = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: SEG_VERT,
      fragmentShader: SEG_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    this.mesh = new THREE.Mesh(g, m)
    this.mesh.frustumCulled = false
  }
  begin() {
    this.count = 0
  }
  /** one link from A to B; colours are linear RGB, alphas 0..1 */
  push(ax: number, ay: number, az: number, bx: number, by: number, bz: number, ca: THREE.Color, aa: number, cb: THREE.Color, ab: number) {
    if (this.count >= this.max || (aa <= 0.002 && ab <= 0.002)) return
    const i = this.count++
    const i3 = i * 3
    const i4 = i * 4
    this.aA[i3] = ax
    this.aA[i3 + 1] = ay
    this.aA[i3 + 2] = az
    this.aB[i3] = bx
    this.aB[i3 + 1] = by
    this.aB[i3 + 2] = bz
    this.aCA[i4] = ca.r
    this.aCA[i4 + 1] = ca.g
    this.aCA[i4 + 2] = ca.b
    this.aCA[i4 + 3] = aa
    this.aCB[i4] = cb.r
    this.aCB[i4 + 1] = cb.g
    this.aCB[i4 + 2] = cb.b
    this.aCB[i4 + 3] = ab
  }
  /** resX/resY: drawing-buffer size; halfPx: half the beam width in drawing-buffer px */
  end(resX: number, resY: number, halfPx: number, opacity = 1) {
    const g = this.geo
    g.instanceCount = this.count
    for (const k of ['aA', 'aB', 'aCA', 'aCB']) {
      const a = g.getAttribute(k) as THREE.InstancedBufferAttribute
      a.clearUpdateRanges()
      a.addUpdateRange(0, this.count * a.itemSize)
      a.needsUpdate = true
    }
    this.u.uRes.value.set(resX, resY)
    this.u.uHalf.value = halfPx
    this.u.uOpacity.value = opacity
  }
}

const SPR_VERT = /* glsl */ `
  attribute vec3 aColor;
  attribute float aSize;
  attribute float aKind;
  uniform float uDpr, uRefZ;
  varying vec3 vCol;
  varying float vKind;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(aSize * uDpr * uRefZ / max(-mv.z, 0.05), 0.0, 160.0);
    vCol = aColor;
    vKind = aKind;
    gl_Position = projectionMatrix * mv;
  }
`
const SPR_FRAG = /* glsl */ `
  uniform float uOpacity;
  varying vec3 vCol;
  varying float vKind;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float a;
    if (vKind < 0.5) {
      // node: a crisp core and a soft glow
      float core = 1.0 - smoothstep(0.14, 0.26, d);
      float glow = exp(-d * d * 7.0) * 0.42;
      a = core + glow;
    } else {
      // ring: a thin bright circle with a whisper of fill
      float ring = 1.0 - smoothstep(0.0, 0.07, abs(d - 0.82));
      a = ring * 0.9 + exp(-d * d * 5.0) * 0.06;
    }
    a *= (1.0 - smoothstep(0.9, 1.0, d)) * uOpacity;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(vCol * a, 1.0);
  }
`

export class Sprites {
  points: THREE.Points
  count = 0
  private pos: Float32Array
  private col: Float32Array
  private size: Float32Array
  private kind: Float32Array
  private u = {
    uDpr: { value: 1 },
    uRefZ: { value: 10 },
    uOpacity: { value: 1 },
  }
  constructor(readonly max: number) {
    const g = new THREE.BufferGeometry()
    this.pos = new Float32Array(max * 3)
    this.col = new Float32Array(max * 3)
    this.size = new Float32Array(max)
    this.kind = new Float32Array(max)
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aKind', new THREE.BufferAttribute(this.kind, 1).setUsage(THREE.DynamicDrawUsage))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
    g.setDrawRange(0, 0)
    const m = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: SPR_VERT,
      fragmentShader: SPR_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    this.points = new THREE.Points(g, m)
    this.points.frustumCulled = false
  }
  begin() {
    this.count = 0
  }
  /** a node (kind 0) or a ring (kind 1); `size` in CSS px at the rig plane; colour pre-multiplied by its alpha */
  push(x: number, y: number, z: number, c: THREE.Color, k: number, size: number, kind = 0) {
    if (this.count >= this.max || k <= 0.003 || size <= 0.1) return
    const i = this.count++
    this.pos[i * 3] = x
    this.pos[i * 3 + 1] = y
    this.pos[i * 3 + 2] = z
    this.col[i * 3] = c.r * k
    this.col[i * 3 + 1] = c.g * k
    this.col[i * 3 + 2] = c.b * k
    this.size[i] = size
    this.kind[i] = kind
  }
  /** dpr: drawing-buffer px per CSS px; refZ: camera distance to the rig plane (world units) */
  end(dpr: number, refZ: number, opacity = 1) {
    const g = this.points.geometry
    g.setDrawRange(0, this.count)
    for (const k of ['position', 'aColor', 'aSize', 'aKind']) {
      const a = g.getAttribute(k) as THREE.BufferAttribute
      a.clearUpdateRanges()
      a.addUpdateRange(0, this.count * a.itemSize)
      a.needsUpdate = true
    }
    this.u.uDpr.value = dpr
    this.u.uRefZ.value = refZ
    this.u.uOpacity.value = opacity
  }
}
