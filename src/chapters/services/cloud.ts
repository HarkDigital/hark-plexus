import * as THREE from 'three'

/*
 * Nodes — a chapter-local morphing particle cloud (the kit's Morph, plus the
 * two things this chapter needs):
 *
 *  - it draws in three's OPAQUE list (additive, no depth write), so the
 *    transmission pass captures it and every glass bead REFRACTS it: an icon
 *    sitting inside a bead is seen through real glass, warped at the rim.
 *  - particles.js "repulse" on the pointer: a world point pushes particles
 *    aside (stateless, in the vertex shader) and they brighten as they part.
 *
 * Colour is stable at rest (it never depends on which morph slot a shape is
 * in), so swapping slot a/b at a rest point is seamless; mid-flight particles
 * take the `fly` tint.
 *
 *   const c = new Cloud(6000, { size: 0.012 })
 *   c.to('a', shapeA); c.to('b', shapeB)
 *   c.set({ mix, time, px, ptr, ptrK, ... })   // every frame
 */

const VERT = /* glsl */ `
  attribute vec3 aFrom;
  attribute vec3 aTo;
  attribute vec4 aRand;
  uniform float uMix, uTime, uSize, uSwirl, uPx, uShimmer, uPtrK, uPtrR;
  uniform vec3 uPtr, uOffA, uOffB;
  varying float vFly;
  varying float vTone;
  varying float vTw;
  varying float vPush;
  void main() {
    // staggered departure: particles leave (and arrive) at different times
    float m = clamp((uMix - aRand.x * 0.35) / 0.65, 0.0, 1.0);
    m = m * m * (3.0 - 2.0 * m);
    vec3 p = mix(aFrom + uOffA, aTo + uOffB, m);
    float fly = 4.0 * m * (1.0 - m);
    float a = aRand.z * 6.2831 + uTime * 0.6;
    p += vec3(sin(a + p.y * 1.7), cos(a * 1.3 + p.x * 1.3), sin(a * 0.7 + p.z)) * uSwirl * fly * (0.4 + aRand.y);
    // idle shimmer
    p += vec3(
      sin(uTime * (0.7 + aRand.y) + aRand.z * 9.0),
      cos(uTime * (0.6 + aRand.x) + aRand.w * 9.0),
      sin(uTime * (0.5 + aRand.w) + aRand.y * 7.0)
    ) * uShimmer * (0.5 + aRand.w);
    // pointer repulse (particles.js): a soft bubble around the pointer
    vec3 d = p - uPtr;
    float r = length(d);
    float k = uPtrK * (1.0 - smoothstep(0.0, uPtrR, r));
    p += (d / max(r, 1e-4)) * k * uPtrR * (0.45 + 0.35 * aRand.y);
    vFly = fly;
    vTone = aRand.w;
    vPush = k;
    vTw = 0.72 + 0.28 * sin(uTime * (1.5 + aRand.w * 2.0) + aRand.z * 20.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = clamp(uSize * (0.6 + aRand.y * 0.8) * projectionMatrix[1][1] * 0.5 * uPx / max(-mv.z, 0.05), 1.0, 48.0);
    gl_Position = projectionMatrix * mv;
  }
`

const FRAG = /* glsl */ `
  uniform vec3 uColA, uColB, uColFly;
  uniform float uOpacity;
  varying float vFly;
  varying float vTone;
  varying float vTw;
  varying float vPush;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float core = 1.0 - smoothstep(0.0, 0.5, d);
    float a = core * core * uOpacity * vTw * (1.0 + vPush * 0.6);
    if (a <= 0.003) discard;
    vec3 col = mix(uColA, uColB, vTone);
    col = mix(col, uColFly, clamp(vFly * 0.85, 0.0, 1.0));
    gl_FragColor = vec4(col * a, 1.0);
  }
`

/**
 * World-sized sprites need the height of the target being drawn: three's
 * transmission pass renders the opaque list into a smaller buffer (0.55 of a
 * DPR-2 frame, 0.5 on phones), and sprites sized for the full frame would
 * come out ~2x too big there (a milky haze inside the glass). Set per draw.
 */
export function pxFromTarget(obj: THREE.Object3D, u: { value: number }) {
  obj.onBeforeRender = renderer => {
    const rt = renderer.getRenderTarget()
    u.value = rt ? rt.height : renderer.domElement.height
  }
}

function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => ((s = (s * 16807) % 2147483647) / 2147483647)
}

export interface CloudSet {
  mix?: number
  time?: number
  size?: number
  opacity?: number
  swirl?: number
  shimmer?: number
  ptr?: THREE.Vector3
  ptrK?: number
  ptrR?: number
  offA?: THREE.Vector3
  offB?: THREE.Vector3
}

export class Cloud {
  points: THREE.Points
  material: THREE.ShaderMaterial
  private geo: THREE.BufferGeometry
  u = {
    uMix: { value: 0 },
    uTime: { value: 0 },
    uSize: { value: 0.012 },
    uSwirl: { value: 0.5 },
    uShimmer: { value: 0.006 },
    uPx: { value: 900 },
    uOpacity: { value: 0.6 },
    uPtr: { value: new THREE.Vector3(999, 999, 999) },
    uPtrK: { value: 0 },
    uPtrR: { value: 0.22 },
    uOffA: { value: new THREE.Vector3() },
    uOffB: { value: new THREE.Vector3() },
    uColA: { value: new THREE.Color('#88c4ff') },
    uColB: { value: new THREE.Color('#f4f7ff') },
    uColFly: { value: new THREE.Color('#8b7bff') },
  }

  constructor(
    readonly count: number,
    o: { seed?: number; size?: number; colA?: THREE.ColorRepresentation; colB?: THREE.ColorRepresentation; fly?: THREE.ColorRepresentation } = {},
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
    if (o.colA) this.u.uColA.value.set(o.colA)
    if (o.colB) this.u.uColB.value.set(o.colB)
    if (o.fly) this.u.uColFly.value.set(o.fly)
    this.material = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: VERT,
      fragmentShader: FRAG,
      // opaque list + additive: captured by the transmission pass, so glass refracts it
      transparent: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    this.points = new THREE.Points(g, this.material)
    this.points.frustumCulled = false
    pxFromTarget(this.points, this.u.uPx)
  }

  /** Set shape 'a' (mix 0) or 'b' (mix 1). Arrays shorter than count*3 repeat. */
  to(slot: 'a' | 'b', positions: Float32Array) {
    const attr = this.geo.getAttribute(slot === 'a' ? 'aFrom' : 'aTo') as THREE.BufferAttribute
    const dst = attr.array as Float32Array
    const n = positions.length
    if (n >= dst.length) dst.set(positions.subarray(0, dst.length))
    else for (let i = 0; i < dst.length; i++) dst[i] = positions[i % n]
    attr.needsUpdate = true
  }

  set(o: CloudSet) {
    const u = this.u
    if (o.mix !== undefined) u.uMix.value = o.mix
    if (o.time !== undefined) u.uTime.value = o.time
    if (o.size !== undefined) u.uSize.value = o.size
    if (o.opacity !== undefined) u.uOpacity.value = o.opacity
    if (o.swirl !== undefined) u.uSwirl.value = o.swirl
    if (o.shimmer !== undefined) u.uShimmer.value = o.shimmer
    if (o.ptr !== undefined) u.uPtr.value.copy(o.ptr)
    if (o.ptrK !== undefined) u.uPtrK.value = o.ptrK
    if (o.ptrR !== undefined) u.uPtrR.value = o.ptrR
    if (o.offA !== undefined) u.uOffA.value.copy(o.offA)
    if (o.offB !== undefined) u.uOffB.value.copy(o.offB)
  }
}
