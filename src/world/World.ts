import * as THREE from 'three'
import type { Frame } from '../core/types'

/*
 * The shared world for Hark Plexus: a deep night-blue studio whose backdrop IS
 * a living particle network (the particles.js "constellation" look, done on
 * the GPU): nodes drift, lines join near neighbours and fade with distance,
 * and the mouse pointer pushes nodes away and GRABS the nearest ones with
 * bright lines, while a soft node of light sits under it (the visitor is a
 * node, everywhere). Two layers at different scales give depth and parallax.
 *
 * How it is drawn (cheap on purpose: it is behind everything, on every frame):
 *  - the DOME (a big opaque back-facing sphere around the camera) paints the
 *    gradient, the two light pools and the pointer glow per pixel;
 *  - each network layer is ONE instanced draw of screen-space quads: one
 *    instance per field cell = 4 links (right, up, both diagonals of its 2x2
 *    block), the cell's node dot and its grab line to the pointer. The vertex
 *    shader places the cell's node (drift, repel, gather) and builds tight
 *    quads; the fragment shader evaluates the same line / dot profiles the
 *    old per-pixel field did, so the look is identical and full-resolution
 *    crisp at a small fraction of the cost.
 * Both are OPAQUE-list objects (the network blends additively onto the dome),
 * so three's transmission pass captures them: every glass object in front
 * refracts the network — the signature read.
 *
 * Field space: p = (ndc.x·aspect, ndc.y) + shift, where shift is a small
 * parallax offset from the camera's yaw / pitch. params.focus and the pointer
 * live in this space.
 *
 * params (set every frame; the engine resets them to defaults first; damped):
 *   top / bottom          backdrop gradient
 *   a / b                 two soft light pools (violet / ice by default)
 *   node / line           network colours
 *   net                   0..1 network strength (0 = hidden)
 *   density               1 = default cell size; > 1 = more, smaller cells
 *   speed                 drift speed multiplier
 *   gather                0..1 pull nodes toward `focus` (a converging moment)
 *   warm                  0..1 tint the network hostile red (the shield)
 *   pointer               0..1 how strongly the mouse repels / grabs / glows
 *                         (always 0 under reduced motion or the Motion switch)
 *   focus                 field-space point (x = ndc.x·aspect + shift.x, y = ndc.y + shift.y) the pools and gather aim at
 *   env / envTurn         studio reflection strength / rotation (sweep highlights across glass)
 *   keyDir / key / fill   key light and hemisphere fill
 */

export interface WorldParams {
  top: THREE.ColorRepresentation
  bottom: THREE.ColorRepresentation
  a: THREE.ColorRepresentation
  b: THREE.ColorRepresentation
  node: THREE.ColorRepresentation
  line: THREE.ColorRepresentation
  net: number
  density: number
  speed: number
  gather: number
  warm: number
  pointer: number
  focus: THREE.Vector2
  env: number
  envTurn: number
  keyDir: THREE.Vector3
  key: number
  fill: number
}

export const WORLD_DEFAULTS = {
  top: '#0c0f2e',
  bottom: '#05061a',
  a: '#8b7bff',
  b: '#56b4ff',
  node: '#c9e4ff',
  line: '#88c4ff',
  net: 1,
  density: 1,
  speed: 1,
  gather: 0,
  warm: 0,
  pointer: 1,
  env: 1,
  envTurn: 0,
  key: 1.5,
  fill: 0.35,
}

/* ------------------------------------------------------------------ dome */

const DOME_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const DOME_FRAG = /* glsl */ `
  uniform vec3 uTop, uBottom, uA, uB, uNode;
  uniform float uNet, uTime, uWarm, uTanV, uGlow;
  uniform vec2 uFocus, uShift, uPointer;
  uniform mat3 uViewRot;
  varying vec3 vDir;

  float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

  void main() {
    vec3 v = uViewRot * normalize(vDir);
    float z = max(-v.z, 0.05);
    vec2 p = v.xy / z / uTanV + uShift;
    float h = clamp(p.y * 0.35 + 0.5, 0.0, 1.0);
    vec3 col = mix(uBottom, uTop, smoothstep(0.05, 0.95, h));
    vec2 q = p - uFocus;
    col += uA * exp(-dot(q - vec2(0.4, 0.15), q - vec2(0.4, 0.15)) / 0.8) * 0.12;
    col += uB * exp(-dot(q + vec2(0.6, 0.25), q + vec2(0.6, 0.25)) / 1.1) * 0.1;
    // the visitor is a node: a bright core, a halo and a faint pool of light
    // under the mouse (the grab lines in the network layers converge on it)
    if (uGlow > 0.002) {
      vec2 dp = p - uPointer;
      float r2 = dot(dp, dp);
      vec3 nodeC = mix(uNode, vec3(1.0, 0.72, 0.62), uWarm);
      float g = exp(-r2 / 0.000072) * 0.95 + exp(-r2 / 0.00045) * 0.3 + exp(-r2 / 0.02) * 0.07;
      col += nodeC * g * uGlow * min(1.0, 0.35 + uNet);
    }
    col += (hash(gl_FragCoord.xy + fract(uTime) * 37.0) - 0.5) / 255.0;
    gl_FragColor = vec4(max(col, 0.0), 1.0);
  }
`

/* --------------------------------------------------------------- network */

// position = (across -1..1, along 0..1, primitive 0..5); one instance per cell
const NET_VERT = /* glsl */ `
  uniform float uCell, uLw, uTime, uPointerK, uGather, uAspect, uCols, uDotR, uGrab0, uGrab1;
  uniform vec2 uOrigin, uOffset, uShift, uPointer, uFocus;
  varying vec2 vP;
  varying vec4 vSeg;
  varying vec3 vInfo;

  float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  vec2 hash2(vec2 p) { return vec2(hash(p), hash(p + 17.31)); }

  // node position for cell id (in cell units, absolute)
  vec2 nodeAt(vec2 id, vec2 ptr, vec2 focusC) {
    vec2 h = hash2(id);
    vec2 wob = vec2(sin(uTime * (0.35 + h.x * 0.5) + h.y * 6.28), cos(uTime * (0.3 + h.y * 0.45) + h.x * 6.28)) * 0.32;
    vec2 n = id + 0.5 + (h - 0.5) * 0.35 + wob;
    // pointer repulsion (particles.js 'repulse')
    vec2 d = n - ptr;
    float r = length(d);
    n += normalize(d + 1e-5) * uPointerK * 0.55 * (1.0 - smoothstep(0.0, 1.6, r));
    // gather toward the focus: a pull clamped to 0.42 cell
    vec2 pull = (focusC + (n - focusC) * 0.35) - n;
    float pl = length(pull);
    n += pull * min(1.0, 0.42 / max(pl, 1e-4)) * uGather;
    return n;
  }

  void main() {
    float inst = float(gl_InstanceID);
    float row = floor((inst + 0.5) / uCols);
    vec2 id = uOrigin + vec2(inst - row * uCols, row);
    float prim = position.z;
    vec2 ptrC = (uPointer + uOffset) / uCell;
    vec2 focC = (uFocus + uOffset) / uCell;
    // links: 0 A→A+(1,0), 1 A→A+(0,1), 2 A→A+(1,1), 3 A+(1,0)→A+(0,1)
    vec2 a = nodeAt(id + (prim > 2.5 && prim < 3.5 ? vec2(1.0, 0.0) : vec2(0.0)), ptrC, focC);
    vec2 b = a;
    float kind = 0.0;
    float k = 1.0;
    float w = uLw;
    if (prim < 3.5) {
      vec2 db = prim < 0.5 ? vec2(1.0, 0.0) : prim < 1.5 ? vec2(0.0, 1.0) : prim < 2.5 ? vec2(1.0, 1.0) : vec2(0.0, 1.0);
      b = nodeAt(id + db, ptrC, focC);
      k = 1.0 - smoothstep(0.55, 1.45, length(b - a));
    } else if (prim < 4.5) {
      kind = 1.0;
      w = uDotR;
    } else {
      // pointer 'grab': a line from this node to the pointer, fading with distance
      kind = 2.0;
      b = ptrC;
      k = (1.0 - smoothstep(uGrab0, uGrab1, length(b - a))) * uPointerK;
      w = uLw * 1.6;
    }
    vInfo = vec3(kind, k, w);
    vec2 A = a * uCell;
    vec2 B = b * uCell;
    vSeg = vec4(A, B);
    if (k < 0.004) {
      // invisible primitive: collapse it outside the clip volume
      vP = A;
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      return;
    }
    vec2 pos;
    if (kind > 0.5 && kind < 1.5) {
      pos = A + vec2(position.x, position.y * 2.0 - 1.0) * w;
    } else {
      vec2 d = B - A;
      float len = length(d);
      vec2 t = len > 1e-6 ? d / len : vec2(1.0, 0.0);
      pos = mix(A - t * w, B + t * w, position.y) + vec2(-t.y, t.x) * position.x * w;
    }
    vP = pos;
    vec2 s = pos - uOffset - uShift;
    gl_Position = vec4(s.x / uAspect, s.y, 0.0, 1.0);
  }
`

const NET_FRAG = /* glsl */ `
  uniform vec3 uNode, uLine;
  uniform float uNet, uWarm, uLineW, uDotW, uGrabW;
  uniform vec2 uOffset, uFocus;
  varying vec2 vP;
  varying vec4 vSeg;
  varying vec3 vInfo;

  void main() {
    float kind = vInfo.x;
    vec3 c;
    if (kind > 0.5 && kind < 1.5) {
      vec2 dd = vP - vSeg.xy;
      float d2 = dot(dd, dd);
      vec3 nodeC = mix(uNode, vec3(1.0, 0.72, 0.62), uWarm);
      c = nodeC * (exp(-d2 / (0.0045 * 0.0045 * 4.0)) + 0.25 * exp(-d2 / (0.016 * 0.016))) * uDotW;
    } else {
      vec2 pa = vP - vSeg.xy;
      vec2 ba = vSeg.zw - vSeg.xy;
      float hh = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
      float l = (1.0 - smoothstep(0.0, vInfo.z, length(pa - ba * hh))) * vInfo.y;
      vec3 lineC = mix(uLine, vec3(1.0, 0.36, 0.34), uWarm);
      c = lineC * l * (kind < 0.5 ? uLineW : uGrabW);
    }
    // the network fades toward the frame edges and gathers light near the focus
    vec2 q = vP - uOffset - uFocus;
    float vis = 0.55 + 0.45 * exp(-dot(q, q) / 2.2);
    gl_FragColor = vec4(c * uNet * vis, 1.0);
  }
`

interface NetLayer {
  mesh: THREE.Mesh
  geo: THREE.InstancedBufferGeometry
  u: {
    uCell: { value: number }
    uLw: { value: number }
    uDotR: { value: number }
    uLineW: { value: number }
    uDotW: { value: number }
    uGrabW: { value: number }
    uCols: { value: number }
    uOrigin: { value: THREE.Vector2 }
    uOffset: { value: THREE.Vector2 }
    uTime: { value: number }
  }
  /** base cell size (field units at density 1) */
  cell: number
  /** time scale / offset (the far layer drifts slower, out of phase) */
  tk: number
  t0: number
  /** extra field offset: the far layer parallaxes 35% more and starts elsewhere */
  shiftK: number
  base: THREE.Vector2
}

/** at most this many cells per layer (a 4:1 window at density 2 needs ~2.3k) */
const MAX_CELLS = 4096

function quadGeometry(): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry()
  const pos = new Float32Array(6 * 4 * 3)
  const idx: number[] = []
  for (let q = 0; q < 6; q++) {
    const corners = [-1, 0, 1, 0, -1, 1, 1, 1]
    for (let c = 0; c < 4; c++) {
      const o = (q * 4 + c) * 3
      pos[o] = corners[c * 2]
      pos[o + 1] = corners[c * 2 + 1]
      pos[o + 2] = q
    }
    const v = q * 4
    idx.push(v, v + 1, v + 2, v + 2, v + 1, v + 3)
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
  g.instanceCount = 0
  return g
}

export class World {
  object = new THREE.Group()
  key: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  envMap: THREE.Texture | null = null
  params: WorldParams = {
    ...WORLD_DEFAULTS,
    focus: new THREE.Vector2(0.2, 0),
    keyDir: new THREE.Vector3(-0.4, 0.9, 0.5),
  }
  private cur = {
    top: new THREE.Color(),
    bottom: new THREE.Color(),
    a: new THREE.Color(),
    b: new THREE.Color(),
    node: new THREE.Color(),
    line: new THREE.Color(),
    net: 1,
    density: 1,
    speed: 1,
    gather: 0,
    warm: 0,
    pointer: 1,
    /** 0..1 a mouse is over the page (fades, never pops) */
    present: 0,
    env: 1,
    envTurn: 0,
    key: WORLD_DEFAULTS.key,
    fill: WORLD_DEFAULTS.fill,
    focus: new THREE.Vector2(0.2, 0),
    /** damped pointer in SCREEN units (x·aspect, y); the view shift is added on write */
    ptr: new THREE.Vector2(9, 9),
  }
  private first = true
  private clock = 0
  /** shared by the dome and both network layers */
  private u = {
    uTop: { value: new THREE.Color() },
    uBottom: { value: new THREE.Color() },
    uA: { value: new THREE.Color() },
    uB: { value: new THREE.Color() },
    uNode: { value: new THREE.Color() },
    uLine: { value: new THREE.Color() },
    uNet: { value: 1 },
    uTime: { value: 0 },
    uGather: { value: 0 },
    uWarm: { value: 0 },
    uPointerK: { value: 1 },
    uGlow: { value: 0 },
    uTanV: { value: 0.4 },
    uAspect: { value: 1 },
    uGrab0: { value: 0.5 },
    uGrab1: { value: 1.5 },
    uFocus: { value: new THREE.Vector2() },
    uShift: { value: new THREE.Vector2() },
    uPointer: { value: new THREE.Vector2(9, 9) },
    uViewRot: { value: new THREE.Matrix3() },
  }
  private layers: NetLayer[] = []
  private tmp = new THREE.Color()
  private tmpV = new THREE.Vector3()
  private tmpM = new THREE.Matrix4()
  private hasPointer = false
  private root = document.documentElement

  constructor(
    private scene: THREE.Scene,
    private mobile: boolean,
    renderer?: THREE.WebGLRenderer,
  ) {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(900, 48, 24),
      new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, toneMapped: false, uniforms: this.u, vertexShader: DOME_VERT, fragmentShader: DOME_FRAG }),
    )
    dome.frustumCulled = false
    dome.renderOrder = -10
    this.object.add(dome)
    // near layer: bigger cells, brighter; far layer: finer, dimmer, parallaxes more
    this.layers.push(this.makeLayer({ cell: 0.34, lw: 0.0028, dotR: 0.036, lineW: 0.2, dotW: 0.95, grabW: 0.7, tk: 1, t0: 0, shiftK: 0, base: [0, 0] }))
    this.layers.push(this.makeLayer({ cell: 0.2, lw: 0.0022, dotR: 0.032, lineW: 0.085, dotW: 0.38, grabW: 0.26, tk: 0.7, t0: 11, shiftK: 0.35, base: [3.7, 1.3] }))
    this.key = new THREE.DirectionalLight(0xffffff, WORLD_DEFAULTS.key)
    scene.add(this.key)
    scene.add(this.key.target)
    this.hemi = new THREE.HemisphereLight(0xcfd8ff, 0x140f2a, WORLD_DEFAULTS.fill)
    scene.add(this.hemi)
    if (renderer) this.buildStudio(renderer)
    // real mouse only: touch keeps the network undisturbed (a finger drag is a scroll)
    window.addEventListener('pointermove', e => {
      this.hasPointer = e.pointerType === 'mouse'
    })
    document.documentElement.addEventListener('pointerleave', () => (this.hasPointer = false))
  }

  private makeLayer(o: { cell: number; lw: number; dotR: number; lineW: number; dotW: number; grabW: number; tk: number; t0: number; shiftK: number; base: [number, number] }): NetLayer {
    const u = {
      uCell: { value: o.cell },
      uLw: { value: o.lw },
      uDotR: { value: o.dotR },
      uLineW: { value: o.lineW },
      uDotW: { value: o.dotW },
      uGrabW: { value: o.grabW },
      uCols: { value: 1 },
      uOrigin: { value: new THREE.Vector2() },
      uOffset: { value: new THREE.Vector2(o.base[0], o.base[1]) },
      uTime: { value: 0 },
    }
    const s = this.u
    const geo = quadGeometry()
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...u,
        uNode: s.uNode,
        uLine: s.uLine,
        uNet: s.uNet,
        uWarm: s.uWarm,
        uGather: s.uGather,
        uPointerK: s.uPointerK,
        uAspect: s.uAspect,
        uGrab0: s.uGrab0,
        uGrab1: s.uGrab1,
        uFocus: s.uFocus,
        uShift: s.uShift,
        uPointer: s.uPointer,
      },
      vertexShader: NET_VERT,
      fragmentShader: NET_FRAG,
      // opaque list (so the transmission pass sees it), blended onto the dome
      transparent: false,
      blending: THREE.AdditiveBlending,
      // quads come out with either winding (a line's frame can mirror)
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = -9
    this.object.add(mesh)
    return { mesh, geo, u, cell: o.cell, tk: o.tk, t0: o.t0, shiftK: o.shiftK, base: new THREE.Vector2(o.base[0], o.base[1]) }
  }

  /** Studio reflections for glass: dark room, white softbox strips, cool accents. */
  private buildStudio(renderer: THREE.WebGLRenderer) {
    const room = new THREE.Scene()
    room.add(new THREE.Mesh(new THREE.BoxGeometry(24, 16, 24), new THREE.MeshBasicMaterial({ color: '#070818', side: THREE.BackSide })))
    const panel = (w: number, h: number, color: string, power: number, pos: [number, number, number]) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(power), side: THREE.DoubleSide }))
      m.position.set(...pos)
      m.lookAt(0, 0, 0)
      room.add(m)
    }
    panel(9, 5, '#ffffff', 2.2, [0, 7.8, 0])
    panel(1.1, 11, '#ffffff', 5, [-9, 1, 2])
    panel(0.8, 11, '#eef3ff', 3.6, [9, 1, -1])
    panel(10, 0.35, '#ffffff', 4, [0, 3.5, 9])
    panel(4, 2.2, '#8b7bff', 1.4, [-5, -4, -6])
    panel(7, 4, '#56b4ff', 0.45, [6, -3.5, 5])
    panel(5, 2.5, '#ffb38a', 0.7, [5, -2, -8])
    const pmrem = new THREE.PMREMGenerator(renderer)
    const rt = pmrem.fromScene(room, 0.035)
    pmrem.dispose()
    room.traverse(o => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        m.geometry.dispose()
        ;(m.material as THREE.Material).dispose()
      }
    })
    this.envMap = rt.texture
    this.scene.environment = rt.texture
  }

  resetParams() {
    const p = this.params
    p.top = WORLD_DEFAULTS.top
    p.bottom = WORLD_DEFAULTS.bottom
    p.a = WORLD_DEFAULTS.a
    p.b = WORLD_DEFAULTS.b
    p.node = WORLD_DEFAULTS.node
    p.line = WORLD_DEFAULTS.line
    p.net = WORLD_DEFAULTS.net
    p.density = WORLD_DEFAULTS.density
    p.speed = WORLD_DEFAULTS.speed
    p.gather = WORLD_DEFAULTS.gather
    p.warm = WORLD_DEFAULTS.warm
    p.pointer = WORLD_DEFAULTS.pointer
    p.env = WORLD_DEFAULTS.env
    p.envTurn = WORLD_DEFAULTS.envTurn
    p.key = WORLD_DEFAULTS.key
    p.fill = WORLD_DEFAULTS.fill
    p.focus.set(0.2, 0)
    p.keyDir.set(-0.4, 0.9, 0.5)
  }

  update(frame: Frame, camera: THREE.Camera) {
    const p = this.params
    const c = this.cur
    const k = this.first ? 1 : 1 - Math.exp(-4 * frame.dt)
    this.first = false
    // reduced motion, or the visitor's Motion switch (html.motion-off, and
    // frame.still once the reveal grace ends): the network ignores the pointer
    const calm = frame.reducedMotion || !!frame.still || this.root.classList.contains('motion-off')
    c.top.lerp(this.tmp.set(p.top), k)
    c.bottom.lerp(this.tmp.set(p.bottom), k)
    c.a.lerp(this.tmp.set(p.a), k)
    c.b.lerp(this.tmp.set(p.b), k)
    c.node.lerp(this.tmp.set(p.node), k)
    c.line.lerp(this.tmp.set(p.line), k)
    c.net += (p.net - c.net) * k
    c.density += (p.density - c.density) * k
    c.speed += (p.speed - c.speed) * k
    c.gather += (p.gather - c.gather) * k
    c.warm += (p.warm - c.warm) * k
    c.pointer += ((calm ? 0 : p.pointer) - c.pointer) * k
    c.env += (p.env - c.env) * k
    let dt = p.envTurn - c.envTurn
    dt = Math.atan2(Math.sin(dt), Math.cos(dt))
    c.envTurn += dt * k
    c.key += (p.key - c.key) * k
    c.fill += (p.fill - c.fill) * k
    c.focus.lerp(p.focus, k)
    if (!frame.still) this.clock += frame.dt * 0.35 * c.speed * (frame.reducedMotion ? 0.2 : 1)

    // the view: a small parallax shift of the field from the camera's yaw / pitch
    const u = this.u
    const persp = camera as THREE.PerspectiveCamera
    u.uTanV.value = Math.tan(THREE.MathUtils.degToRad((persp.fov ?? 45) / 2))
    camera.updateMatrixWorld()
    this.tmpM.extractRotation(camera.matrixWorldInverse)
    u.uViewRot.value.setFromMatrix4(this.tmpM)
    camera.getWorldDirection(this.tmpV)
    const yaw = Math.atan2(this.tmpV.x, -this.tmpV.z)
    const pitch = Math.asin(THREE.MathUtils.clamp(this.tmpV.y, -1, 1))
    const sx = Math.sin(yaw) * 0.35
    const sy = pitch * 0.3
    u.uShift.value.set(sx, sy)

    // the pointer, damped in SCREEN units (so the lag never swims as the camera
    // pans), then moved into field space by the same shift the field uses.
    // Frozen while calm, so nothing follows the mouse and nothing snaps later.
    const aspect = frame.width / Math.max(1, frame.height)
    const kp = 1 - Math.exp(-10 * frame.dt)
    if (!calm) {
      const tx = frame.pointerRaw.x * aspect
      const ty = frame.pointerRaw.y
      const snap = Math.abs(tx - c.ptr.x) > 4 || Math.abs(ty - c.ptr.y) > 4
      c.ptr.x += (tx - c.ptr.x) * (snap ? 1 : kp)
      c.ptr.y += (ty - c.ptr.y) * (snap ? 1 : kp)
    }
    c.present += ((this.hasPointer && !calm ? 1 : 0) - c.present) * (calm ? k : kp)
    const pk = c.pointer * c.present
    u.uPointerK.value = pk
    u.uGlow.value = pk
    u.uPointer.value.set(c.ptr.x + sx, c.ptr.y + sy)

    u.uTop.value.copy(c.top)
    u.uBottom.value.copy(c.bottom)
    u.uA.value.copy(c.a)
    u.uB.value.copy(c.b)
    u.uNode.value.copy(c.node)
    u.uLine.value.copy(c.line)
    u.uNet.value = c.net
    u.uTime.value = this.clock
    u.uGather.value = c.gather
    u.uWarm.value = c.warm
    u.uFocus.value.copy(c.focus)
    u.uAspect.value = aspect

    // lay out each network layer's cells over the visible field (+ margins:
    // nodes wander up to ~1 cell from home and links reach one cell further)
    const d = Math.max(c.density * (this.mobile ? 0.8 : 1), 0.3)
    const show = c.net > 0.002
    for (const L of this.layers) {
      L.mesh.visible = show
      if (!show) continue
      const cell = L.cell / d
      const ox = L.base.x + sx * L.shiftK
      const oy = L.base.y + sy * L.shiftK
      L.u.uOffset.value.set(ox, oy)
      L.u.uCell.value = cell
      L.u.uTime.value = this.clock * L.tk + L.t0
      const x0 = Math.floor((sx + ox - aspect) / cell) - 3
      const x1 = Math.ceil((sx + ox + aspect) / cell) + 2
      const y0 = Math.floor((sy + oy - 1) / cell) - 3
      const y1 = Math.ceil((sy + oy + 1) / cell) + 2
      const cols = x1 - x0 + 1
      L.u.uOrigin.value.set(x0, y0)
      L.u.uCols.value = cols
      L.geo.instanceCount = Math.min(MAX_CELLS, cols * (y1 - y0 + 1))
    }

    this.scene.environmentIntensity = c.env
    this.scene.environmentRotation.y = c.envTurn
    this.key.intensity = c.key
    this.key.position.copy(camera.position).addScaledVector(this.tmpV.copy(p.keyDir).normalize(), 50)
    this.key.target.position.copy(camera.position)
    this.key.target.updateMatrixWorld()
    this.hemi.intensity = c.fill
    this.object.position.copy(camera.position)
  }
}
