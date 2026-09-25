import * as THREE from 'three'
import type { Frame } from '../core/types'

/*
 * The shared world for Hark Plexus: a deep night-blue studio whose backdrop IS
 * a living particle network (the particles.js "constellation" look, done on
 * the GPU): nodes drift, lines join near neighbours and fade with distance,
 * and the pointer pushes nodes away and grabs lines toward itself. Two layers
 * at different scales give depth and parallax.
 *
 * The backdrop is an OPAQUE mesh, so three's transmission pass captures it:
 * every glass object in front refracts the network — the signature read.
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
 *   pointer               0..1 how strongly the pointer repels / grabs
 *   focus                 screen-space point (x = ndc.x·aspect, y = ndc.y) the pools and gather aim at
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

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const FRAG = /* glsl */ `
  uniform vec3 uTop, uBottom, uA, uB, uNode, uLine;
  uniform float uNet, uDensity, uTime, uGather, uWarm, uPointerK, uTanV;
  uniform vec2 uFocus, uShift, uPointer;
  uniform mat3 uViewRot;
  varying vec3 vDir;

  float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  vec2 hash2(vec2 p) { return vec2(hash(p), hash(p + 17.31)); }
  float pow2(float x) { return x * x; }

  // node position for cell id (in cell units, absolute)
  vec2 nodeAt(vec2 id, float t, vec2 ptr, float cell, vec2 focusC) {
    vec2 h = hash2(id);
    vec2 wob = vec2(sin(t * (0.35 + h.x * 0.5) + h.y * 6.28), cos(t * (0.3 + h.y * 0.45) + h.x * 6.28)) * 0.32;
    vec2 n = id + 0.5 + (h - 0.5) * 0.35 + wob;
    // pointer repulsion (particles.js 'repulse')
    vec2 d = n - ptr;
    float r = length(d);
    float rad = 1.6;
    n += normalize(d + 1e-5) * uPointerK * 0.55 * (1.0 - smoothstep(0.0, rad, r));
    // gather toward the focus: a pull clamped to 0.42 cell so a node never
    // leaves the 3x3 neighbourhood the shader draws (no clipped half dots)
    vec2 pull = (focusC + (n - focusC) * 0.35) - n;
    float pl = length(pull);
    n += pull * min(1.0, 0.42 / max(pl, 1e-4)) * uGather;
    return n;
  }

  float segment(vec2 p, vec2 a, vec2 b, float w) {
    vec2 pa = p - a, ba = b - a;
    float hh = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    return 1.0 - smoothstep(0.0, w, length(pa - ba * hh));
  }

  // one network layer: returns (line, node) intensity at p (screen units)
  vec2 layer(vec2 p, float cell, float t, vec2 ptr, vec2 focus, float lw) {
    vec2 gp = p / cell;
    vec2 ptrC = ptr / cell;
    vec2 focusC = focus / cell;
    vec2 id0 = floor(gp);
    vec2 nodes[9];
    int k = 0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        nodes[k] = nodeAt(id0 + vec2(float(i), float(j)), t, ptrC, cell, focusC);
        k++;
      }
    }
    float lines = 0.0;
    float dots = 0.0;
    float maxLen = 1.45;
    for (int m = 0; m < 9; m++) {
      if (m != 4) {
        float L = length(nodes[m] - nodes[4]);
        float fade = 1.0 - smoothstep(0.55, maxLen, L);
        lines += segment(gp, nodes[4], nodes[m], lw / cell) * fade;
      }
      float dn = length(gp - nodes[m]) * cell;
      dots += exp(-dn * dn / (0.0045 * 0.0045 * 4.0)) + 0.25 * exp(-dn * dn / (0.016 * 0.016));
    }
    // cross links so the mesh doesn't look like a star around every node
    lines += segment(gp, nodes[1], nodes[3], lw / cell) * (1.0 - smoothstep(0.55, maxLen, length(nodes[1] - nodes[3])));
    lines += segment(gp, nodes[1], nodes[5], lw / cell) * (1.0 - smoothstep(0.55, maxLen, length(nodes[1] - nodes[5])));
    lines += segment(gp, nodes[3], nodes[7], lw / cell) * (1.0 - smoothstep(0.55, maxLen, length(nodes[3] - nodes[7])));
    lines += segment(gp, nodes[5], nodes[7], lw / cell) * (1.0 - smoothstep(0.55, maxLen, length(nodes[5] - nodes[7])));
    // pointer 'grab': lines from the pointer to nearby nodes
    for (int m = 0; m < 9; m++) {
      float L = length(nodes[m] - ptrC);
      float g = (1.0 - smoothstep(0.4, 1.3, L)) * uPointerK;
      lines += segment(gp, ptrC, nodes[m], lw / cell) * g * 0.8;
    }
    return vec2(lines, dots);
  }

  void main() {
    vec3 v = uViewRot * normalize(vDir);
    float z = max(-v.z, 0.05);
    vec2 p = v.xy / z / uTanV;
    p += uShift;
    float h = clamp(p.y * 0.35 + 0.5, 0.0, 1.0);
    vec3 col = mix(uBottom, uTop, smoothstep(0.05, 0.95, h));
    vec2 q = p - uFocus;
    col += uA * exp(-dot(q - vec2(0.4, 0.15), q - vec2(0.4, 0.15)) / 0.8) * 0.12;
    col += uB * exp(-dot(q + vec2(0.6, 0.25), q + vec2(0.6, 0.25)) / 1.1) * 0.1;

    if (uNet > 0.002) {
      float t = uTime;
      float d = max(uDensity, 0.3);
      vec2 near = layer(p, 0.34 / d, t, uPointer, uFocus, 0.0028);
      vec2 far = layer(p * 1.0 + uShift * 0.35 + vec2(3.7, 1.3), 0.2 / d, t * 0.7 + 11.0, uPointer + uShift * 0.35 + vec2(3.7, 1.3), uFocus + vec2(3.7, 1.3), 0.0022);
      vec3 lineC = mix(uLine, vec3(1.0, 0.36, 0.34), uWarm);
      vec3 nodeC = mix(uNode, vec3(1.0, 0.72, 0.62), uWarm);
      // the network fades toward the frame edges and gathers light near the focus
      float vis = 0.55 + 0.45 * exp(-dot(q, q) / 2.2);
      col += lineC * (near.x * 0.2 + far.x * 0.085) * uNet * vis;
      col += nodeC * (near.y * 0.95 + far.y * 0.38) * uNet * vis;
    }
    col += (hash(gl_FragCoord.xy + fract(uTime) * 37.0) - 0.5) / 255.0;
    gl_FragColor = vec4(max(col, 0.0), 1.0);
  }
`

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
    env: 1,
    envTurn: 0,
    key: WORLD_DEFAULTS.key,
    fill: WORLD_DEFAULTS.fill,
    focus: new THREE.Vector2(0.2, 0),
    ptr: new THREE.Vector2(9, 9),
  }
  private first = true
  private clock = 0
  private u = {
    uTop: { value: new THREE.Color() },
    uBottom: { value: new THREE.Color() },
    uA: { value: new THREE.Color() },
    uB: { value: new THREE.Color() },
    uNode: { value: new THREE.Color() },
    uLine: { value: new THREE.Color() },
    uNet: { value: 1 },
    uDensity: { value: 1 },
    uTime: { value: 0 },
    uGather: { value: 0 },
    uWarm: { value: 0 },
    uPointerK: { value: 1 },
    uTanV: { value: 0.4 },
    uFocus: { value: new THREE.Vector2() },
    uShift: { value: new THREE.Vector2() },
    uPointer: { value: new THREE.Vector2(9, 9) },
    uViewRot: { value: new THREE.Matrix3() },
  }
  private tmp = new THREE.Color()
  private tmpV = new THREE.Vector3()
  private tmpM = new THREE.Matrix4()
  private hasPointer = false

  constructor(
    private scene: THREE.Scene,
    private mobile: boolean,
    renderer?: THREE.WebGLRenderer,
  ) {
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(900, 48, 24),
      new THREE.ShaderMaterial({ side: THREE.BackSide, depthWrite: false, toneMapped: false, uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG }),
    )
    dome.frustumCulled = false
    dome.renderOrder = -10
    this.object.add(dome)
    this.key = new THREE.DirectionalLight(0xffffff, WORLD_DEFAULTS.key)
    scene.add(this.key)
    scene.add(this.key.target)
    this.hemi = new THREE.HemisphereLight(0xcfd8ff, 0x140f2a, WORLD_DEFAULTS.fill)
    scene.add(this.hemi)
    if (renderer) this.buildStudio(renderer)
    // real pointer only (touch devices keep the network undisturbed)
    window.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse') this.hasPointer = true
    })
    document.documentElement.addEventListener('pointerleave', () => (this.hasPointer = false))
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
    panel(4, 2.2, '#56b4ff', 1.2, [6, -3.5, 5])
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
    c.pointer += ((frame.reducedMotion ? 0 : p.pointer) - c.pointer) * k
    c.env += (p.env - c.env) * k
    let dt = p.envTurn - c.envTurn
    dt = Math.atan2(Math.sin(dt), Math.cos(dt))
    c.envTurn += dt * k
    c.key += (p.key - c.key) * k
    c.fill += (p.fill - c.fill) * k
    c.focus.lerp(p.focus, k)
    if (!frame.still) this.clock += frame.dt * 0.35 * c.speed * (frame.reducedMotion ? 0.2 : 1)

    const aspect = frame.width / Math.max(1, frame.height)
    // pointer in the field's screen units (x·aspect, y); far away when absent
    const tx = this.hasPointer ? frame.pointerRaw.x * aspect : 9
    const ty = this.hasPointer ? frame.pointerRaw.y : 9
    const kp = 1 - Math.exp(-10 * frame.dt)
    c.ptr.x += (tx - c.ptr.x) * (Math.abs(tx - c.ptr.x) > 4 ? 1 : kp)
    c.ptr.y += (ty - c.ptr.y) * (Math.abs(ty - c.ptr.y) > 4 ? 1 : kp)

    const u = this.u
    u.uTop.value.copy(c.top)
    u.uBottom.value.copy(c.bottom)
    u.uA.value.copy(c.a)
    u.uB.value.copy(c.b)
    u.uNode.value.copy(c.node)
    u.uLine.value.copy(c.line)
    u.uNet.value = c.net
    u.uDensity.value = c.density * (this.mobile ? 0.8 : 1)
    u.uTime.value = this.clock
    u.uGather.value = c.gather
    u.uWarm.value = c.warm
    u.uPointerK.value = c.pointer * (this.hasPointer ? 1 : 0)
    u.uFocus.value.copy(c.focus)
    u.uPointer.value.copy(c.ptr)
    const persp = camera as THREE.PerspectiveCamera
    u.uTanV.value = Math.tan(THREE.MathUtils.degToRad((persp.fov ?? 45) / 2))
    camera.updateMatrixWorld()
    this.tmpM.extractRotation(camera.matrixWorldInverse)
    u.uViewRot.value.setFromMatrix4(this.tmpM)
    camera.getWorldDirection(this.tmpV)
    const yaw = Math.atan2(this.tmpV.x, -this.tmpV.z)
    const pitch = Math.asin(THREE.MathUtils.clamp(this.tmpV.y, -1, 1))
    u.uShift.value.set(Math.sin(yaw) * 0.35, pitch * 0.3)

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
