import * as THREE from 'three'
import { G } from '../../kit/glass'
import { rng } from '../../core/math'

/*
 * The attack, the deflection and the watch — one GPU particle system.
 *
 * STREAMS  warm-red particles pour along S-shaped cubic Bézier streams from
 *          the edges of the frame toward points on the site pane. Each
 *          particle rides its stream on a loop (frame.time), twisting in a
 *          tube around the centreline that narrows as it closes in. `reach`
 *          (scroll) is how far the swarm's front has advanced; `tail`
 *          (scroll) is where the last of it has passed — the attack ends.
 * DEFLECT  past the point where a stream would pierce the dome's sphere
 *          (aHit, precomputed on the CPU), a particle instead skims the
 *          shell: it slides from the impact point toward the rim, twisting,
 *          cools from red to ice, and sprays off the rim and dissolves —
 *          particles.js 'repulse' at the scale of a force field. `shield`
 *          (scroll) is the dome's assembly; the deflection follows the
 *          tiles as they lock (pole first, rim last).
 * WATCH    a share of the particles ('members') then leave the stream and
 *          condense (chaos → order) into two tilted orbits around the
 *          shield, circling calmly (frame.time) — a watchful ring, with a
 *          few brighter sentinel beads.
 * POINTER  (mouse only) the warm swarm is pushed away from the cursor in
 *          screen space; the calm ring leans toward it.
 *
 * Everything additive, no depth test: glass does not refract these, so they
 * stay visible through it (as they would through real glass).
 */

const VERT = /* glsl */ `
  attribute vec3 aS;
  attribute vec3 aC1;
  attribute vec3 aC2;
  attribute vec3 aT;
  attribute vec4 aR;
  attribute vec4 aO;
  attribute float aHit;

  uniform float uTime, uSpeed, uReach, uTail, uShield, uOrbit, uSize, uPx, uOpacity;
  uniform vec3 uC, uView;
  uniform float uR, uRim;
  uniform vec3 uWarmA, uWarmB, uIce, uWhite;
  uniform vec2 uPointer;
  uniform float uPointerK, uAspect;
  uniform mat3 uRingA, uRingB;
  uniform vec3 uRingC;
  uniform vec2 uRingR, uRingW;

  varying vec3 vCol;
  varying float vA;

  vec3 bez(float t) {
    float it = 1.0 - t;
    return it * it * it * aS + 3.0 * it * it * t * aC1 + 3.0 * it * t * t * aC2 + t * t * t * aT;
  }
  vec3 bezD(float t) {
    float it = 1.0 - t;
    return 3.0 * it * it * (aC1 - aS) + 6.0 * it * t * (aC2 - aC1) + 3.0 * t * t * (aT - aC2);
  }

  // Where this particle's stream meets the shell, and the great circle it is
  // repelled along: pushed over the shell away from the viewer (around the
  // silhouette, off behind it) with a little of the stream's own momentum.
  void shellPath(out vec3 h, out vec3 tt, out float phiX, out float th) {
    h = normalize(bez(aHit) - uC);
    th = acos(clamp(h.z, -1.0, 1.0));
    vec3 v = normalize(bezD(aHit) + vec3(1e-5, 2e-5, 3e-5));
    vec3 away = -uView - h * dot(-uView, h);
    vec3 along = v - h * dot(v, h);
    tt = away + along * 0.25;
    float tl = length(tt);
    vec3 alt = normalize(cross(h, vec3(0.0, 0.0, 1.0)) + vec3(1e-4, 0.0, 0.0));
    tt = tl > 0.05 ? tt / tl : alt;
    vec3 bt = cross(h, tt);
    float fan = (aR.z - 0.5) * 1.1;
    tt = normalize(tt * cos(fan) + bt * sin(fan));
    // where that great circle leaves the cap
    float gA = h.z;
    float gB = tt.z;
    float gR = max(sqrt(gA * gA + gB * gB), 1e-4);
    phiX = atan(gB, gA) + acos(clamp(cos(uRim) / gR, -1.0, 1.0));
  }
  // s = 0 at the strike → 1 dissolved; skims while on the cap, then sprays off the rim
  vec3 onShell(vec3 h, vec3 tt, float phiX, float lift, float s, out float skim) {
    float phi = s * (phiX + 0.95);
    skim = 1.0 - step(phiX, phi);
    if (phi <= phiX) return uC + lift * (h * cos(phi) + tt * sin(phi));
    vec3 nx = h * cos(phiX) + tt * sin(phiX);
    vec3 dx = -h * sin(phiX) + tt * cos(phiX);
    return uC + lift * nx + (dx + nx * 0.5) * (phi - phiX) * lift * 1.25;
  }

  void main() {
    float u = fract(aR.x + uTime * uSpeed * (0.8 + 0.4 * aR.y));
    vec3 p = bez(u);
    vec3 tg = normalize(bezD(u) + vec3(1e-5, 2e-5, 3e-5));
    vec3 upv = abs(tg.y) > 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 n1 = normalize(cross(tg, upv));
    vec3 n2 = cross(tg, n1);
    float lane = fract(aR.x * 7.13 + aR.w * 3.71);
    float tube = mix(0.2, 0.025, u) * (0.1 + 0.9 * lane * lane);
    float ang = aR.z * 6.2831853 + u * 11.0 + uTime * 0.9;
    vec3 swirl = n1 * cos(ang) + n2 * sin(ang);
    p += swirl * tube;

    vec3 col = mix(uWarmA, uWarmB, aR.w);
    float vis = smoothstep(0.0, 0.07, u);
    vis *= 1.0 - smoothstep(uReach - 0.07, uReach, u);
    vis *= smoothstep(uTail, uTail + 0.1, u);
    // brighter as it closes in, and a lit head at the swarm's front
    vis *= mix(0.45, 1.0, u);
    float hd = (uReach - u) / 0.035;
    float head = (1.0 - step(0.999, uReach)) * exp(-hd * hd) * step(u, uReach);
    float spark = 0.0;
    float K = 0.0;

    float skim = 0.0;
    bool hasHit = aHit <= 1.0;
    vec3 sh = vec3(0.0, 0.0, 1.0);
    vec3 st = vec3(1.0, 0.0, 0.0);
    float phiX = 1.0;
    float th = 0.0;
    float lift = uR + 0.05 + 0.08 * aR.y;
    if (hasHit) shellPath(sh, st, phiX, th);
    if (hasHit && u > aHit) {
      K = clamp((uShield - (th / uRim) * 0.55) / 0.45, 0.0, 1.0);
      K = K * K * (3.0 - 2.0 * K);
      K *= 1.0 - smoothstep(uRim - 0.05, uRim + 0.12, th);
      float s = (u - aHit) / max(1.0 - aHit, 1e-3);
      vec3 q = onShell(sh, st, phiX, lift, s, skim) + swirl * 0.07 * s;
      p = mix(p, q, K);
      col = mix(col, uIce, K * smoothstep(0.0, 0.12, s));
      spark = K * exp(-s * 14.0);
      skim *= K;
      vis *= 1.0 - K * smoothstep(0.5, 1.0, s);
    }
    // without the shield, the stream pours into the page and goes out there
    vis *= 1.0 - smoothstep(0.955, 1.0, u) * (1.0 - K);

    // members: dissolve into ice dust around the shield, then condense into the orbits
    float memberW = 0.0;
    float bead = aO.w;
    if (aO.x > 0.5) {
      float m = clamp((uOrbit - aO.y * 0.4) / 0.6, 0.0, 1.0);
      m = m * m * (3.0 - 2.0 * m);
      float isB = step(1.5, aO.x);
      float rr = mix(uRingR.x, uRingR.y, isB) + (aR.y - 0.5) * mix(0.3, 0.1, isB) * (1.0 - bead);
      float a = aO.z * 6.2831853 + uTime * mix(uRingW.x, uRingW.y, isB);
      vec3 lp = vec3(cos(a) * rr, sin(a) * rr, (aR.w - 0.5) * mix(0.09, 0.03, isB) * (1.0 - bead));
      vec3 rp = uRingC + (isB > 0.5 ? uRingB * lp : uRingA * lp);
      // the dust hangs where this particle's sparks dissolved off the shell
      float da = aO.z * 6.2831853;
      vec3 dir = normalize(vec3(cos(da), sin(da), (aR.y - 0.5) * 1.4 + 0.3));
      float sk2;
      vec3 dust = hasHit ? onShell(sh, st, phiX, lift, 0.72 + 0.28 * aR.w, sk2) : uRingC + dir * (uR * 0.9 + 0.5 + aR.w * 1.6);
      dust += vec3(sin(uTime * 0.3 + aR.z * 9.0), cos(uTime * 0.26 + aR.x * 9.0), sin(uTime * 0.2 + aR.w * 7.0)) * 0.1;
      float fly = 4.0 * m * (1.0 - m);
      vec3 op = mix(dust, rp, m) + swirl * fly * 0.45;
      memberW = smoothstep(0.0, 0.2, uOrbit);
      p = mix(p, op, memberW);
      vis = mix(vis, mix(0.5, 1.0, m), memberW);
      col = mix(col, mix(uIce, uWhite, max(bead, 0.35 * m)), memberW);
    }

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    if (uPointerK > 0.001) {
      vec4 cp = projectionMatrix * mv;
      vec2 ndc = cp.xy / max(cp.w, 1e-3);
      vec2 d = (ndc - uPointer) * vec2(uAspect, 1.0);
      float dl = length(d);
      float f = 1.0 - smoothstep(0.0, 0.3, dl);
      // repulse (the attack) ... or a gentle lean toward the cursor (the watch)
      vec2 push = (d / max(dl, 1e-3)) * f * f * 0.17 * (1.0 - memberW) - d * f * 0.28 * memberW;
      push *= uPointerK;
      mv.x += (push.x / uAspect) * cp.w / projectionMatrix[0][0];
      mv.y += push.y * cp.w / projectionMatrix[1][1];
    }

    float sz = uSize * (0.55 + 0.9 * aR.y) * (1.0 + bead * 2.4 * memberW) * (1.0 + spark * 0.9 + head * 0.8 * (1.0 - memberW));
    gl_PointSize = clamp(sz * projectionMatrix[1][1] * 0.5 * uPx / max(-mv.z, 0.05), 1.0, 44.0);
    gl_Position = projectionMatrix * mv;
    float tw = 0.8 + 0.2 * sin(uTime * (1.2 + aR.w * 1.6) + aR.z * 20.0);
    vCol = col * (1.0 + spark * 2.0 + skim * 0.6 * (1.0 - memberW) + head * 1.6 * (1.0 - memberW) + bead * memberW * 1.5) * tw;
    vA = vis * uOpacity;
  }
`

const FRAG = /* glsl */ `
  varying vec3 vCol;
  varying float vA;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float soft = 1.0 - smoothstep(0.0, 0.5, d);
    float a = (soft * soft + exp(-d * d * 70.0) * 0.5) * vA;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(vCol * a, 1.0);
  }
`

export interface SwarmOpts {
  count: number
  /** dome sphere centre / radius / cap half-angle */
  center: THREE.Vector3
  radius: number
  rim: number
  /** the pane the streams pour into (w, h at z = front) */
  paneW: number
  paneH: number
  front: number
  /** subject → camera direction and the camera's right / up (for placing sources off-frame) */
  toCam: THREE.Vector3
  right: THREE.Vector3
  up: THREE.Vector3
  streams: number
  /** portrait: pull the sources in so the streams cross the narrow frame */
  compact?: boolean
  seed?: number
}

export interface StreamInfo {
  /** unit direction from the dome centre to where the stream's centreline pierces the shell */
  dir: THREE.Vector3
  /** param along the stream where it pierces */
  u: number
  /** polar angle of the hit (radians from the dome axis) */
  theta: number
}

export class Swarm {
  points: THREE.Points
  streams: StreamInfo[] = []
  rings = new THREE.Group()
  ringA = new THREE.Matrix3()
  ringB = new THREE.Matrix3()
  private lineA: THREE.LineLoop
  private lineB: THREE.LineLoop
  private lineMatA: THREE.LineBasicMaterial
  private lineMatB: THREE.LineBasicMaterial
  u = {
    uTime: { value: 0 },
    uSpeed: { value: 0.12 },
    uReach: { value: 0 },
    uTail: { value: 0 },
    uShield: { value: 0 },
    uOrbit: { value: 0 },
    uSize: { value: 0.021 },
    uPx: { value: 900 },
    uOpacity: { value: 1 },
    uC: { value: new THREE.Vector3() },
    uView: { value: new THREE.Vector3(0, 0, 1) },
    uR: { value: 1 },
    uRim: { value: 1 },
    uWarmA: { value: new THREE.Color(G.ember).multiplyScalar(1.25) },
    uWarmB: { value: new THREE.Color(G.rose).multiplyScalar(1.1) },
    uIce: { value: new THREE.Color(G.ice).multiplyScalar(1.25) },
    uWhite: { value: new THREE.Color(G.white).multiplyScalar(1.6) },
    uPointer: { value: new THREE.Vector2(9, 9) },
    uPointerK: { value: 0 },
    uAspect: { value: 1.6 },
    uRingA: { value: new THREE.Matrix3() },
    uRingB: { value: new THREE.Matrix3() },
    uRingC: { value: new THREE.Vector3() },
    uRingR: { value: new THREE.Vector2(3.05, 3.5) },
    uRingW: { value: new THREE.Vector2(0.12, -0.075) },
  }

  constructor(o: SwarmOpts) {
    const n = o.count
    const R = rng(o.seed ?? 77)
    this.u.uC.value.copy(o.center)
    this.u.uView.value.copy(o.toCam).normalize()
    this.u.uR.value = o.radius
    this.u.uRim.value = o.rim

    // ---- the streams (centrelines)
    type S = { S: THREE.Vector3; C1: THREE.Vector3; C2: THREE.Vector3; T: THREE.Vector3 }
    const lines: S[] = []
    const subj = new THREE.Vector3(0, 0, 0.3)
    for (let i = 0; i < o.streams; i++) {
      // sources ring the frame's right, top and bottom (the copy sits left), at mixed depths
      const a = -1.85 + (3.7 * (i + 0.5)) / o.streams + (R() - 0.5) * 0.22
      const rad = (3.8 + R() * 1.5) * (o.compact ? 0.62 : 1)
      const src = subj.clone().addScaledVector(o.right, Math.cos(a) * rad + (o.compact ? 0.5 : 0.9)).addScaledVector(o.up, Math.sin(a) * rad * (o.compact ? 1.25 : 0.85))
      src.addScaledVector(o.toCam, -3.2 + R() * 3.4)
      const T = new THREE.Vector3((R() - 0.5) * o.paneW * 0.6, (R() - 0.5) * o.paneH * 0.55, o.front)
      const chord = T.clone().sub(src)
      const side = new THREE.Vector3().crossVectors(chord, o.toCam).normalize()
      if (side.lengthSq() < 0.1) side.copy(o.up)
      const amp = (i % 2 ? 1 : -1) * (1.7 + R() * 0.9)
      const C1 = src.clone().addScaledVector(chord, 0.35).addScaledVector(side, amp).addScaledVector(o.toCam, 0.8)
      // the dive comes from the front-right, so the shell meets it on its right-hand side
      const dive = (i % 3) - 1 + (R() - 0.5) * 0.5
      const approach = o.toCam.clone().multiplyScalar(0.62).addScaledVector(o.right, 0.58).addScaledVector(o.up, dive * 0.55).normalize()
      const C2 = T.clone().addScaledVector(approach, 2.6).addScaledVector(side, -amp * 0.45)
      lines.push({ S: src, C1, C2, T })
    }

    // ---- particles
    const aS = new Float32Array(n * 3)
    const aC1 = new Float32Array(n * 3)
    const aC2 = new Float32Array(n * 3)
    const aT = new Float32Array(n * 3)
    const aR = new Float32Array(n * 4)
    const aO = new Float32Array(n * 4)
    const aHit = new Float32Array(n)
    const bez = (s: S, t: number, out: THREE.Vector3) => {
      const it = 1 - t
      out.set(0, 0, 0)
      out.addScaledVector(s.S, it * it * it)
      out.addScaledVector(s.C1, 3 * it * it * t)
      out.addScaledVector(s.C2, 3 * it * t * t)
      out.addScaledVector(s.T, t * t * t)
      return out
    }
    const tmp = new THREE.Vector3()
    const hitOf = (s: S) => {
      for (let k = 0; k <= 160; k++) {
        const t = k / 160
        if (bez(s, t, tmp).distanceTo(o.center) < o.radius) return t
      }
      return 2
    }
    for (const s of lines) {
      const u = hitOf(s)
      const dir = u <= 1 ? bez(s, u, new THREE.Vector3()).sub(o.center).normalize() : new THREE.Vector3(0, 0, 1)
      this.streams.push({ dir, u, theta: Math.acos(Math.min(1, dir.z)) })
    }
    let beadsA = 0
    let beadsB = 0
    const jit = (v: THREE.Vector3, k: number) => v.set(v.x + (R() - 0.5) * k, v.y + (R() - 0.5) * k, v.z + (R() - 0.5) * k)
    const one: S = { S: new THREE.Vector3(), C1: new THREE.Vector3(), C2: new THREE.Vector3(), T: new THREE.Vector3() }
    for (let i = 0; i < n; i++) {
      const s = lines[i % lines.length]
      const dT = new THREE.Vector3((R() - 0.5) * 0.6, (R() - 0.5) * 0.4, 0)
      one.S.copy(s.S)
      jit(one.S, 0.14)
      one.C1.copy(s.C1)
      jit(one.C1, 0.1)
      one.C2.copy(s.C2).addScaledVector(dT, 0.3)
      jit(one.C2, 0.08)
      one.T.copy(s.T).add(dT)
      one.T.x = Math.max(-o.paneW * 0.46, Math.min(o.paneW * 0.46, one.T.x))
      one.T.y = Math.max(-o.paneH * 0.44, Math.min(o.paneH * 0.44, one.T.y))
      one.S.toArray(aS, i * 3)
      one.C1.toArray(aC1, i * 3)
      one.C2.toArray(aC2, i * 3)
      one.T.toArray(aT, i * 3)
      aHit[i] = hitOf(one)
      aR[i * 4] = R()
      aR[i * 4 + 1] = R()
      aR[i * 4 + 2] = R()
      aR[i * 4 + 3] = R()
      // members of the watch: ~44% (70% on the main orbit)
      const r = R()
      if (r < 0.44) {
        const onB = r < 0.44 * 0.3
        aO[i * 4] = onB ? 2 : 1
        aO[i * 4 + 1] = R()
        aO[i * 4 + 2] = R()
        let bead = 0
        if (!onB && beadsA < 4) {
          bead = 1
          aO[i * 4 + 2] = beadsA / 4 + 0.06
          beadsA++
        } else if (onB && beadsB < 2) {
          bead = 1
          aO[i * 4 + 2] = beadsB / 2 + 0.2
          beadsB++
        }
        aO[i * 4 + 3] = bead
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
    g.setAttribute('aS', new THREE.BufferAttribute(aS, 3))
    g.setAttribute('aC1', new THREE.BufferAttribute(aC1, 3))
    g.setAttribute('aC2', new THREE.BufferAttribute(aC2, 3))
    g.setAttribute('aT', new THREE.BufferAttribute(aT, 3))
    g.setAttribute('aR', new THREE.BufferAttribute(aR, 4))
    g.setAttribute('aO', new THREE.BufferAttribute(aO, 4))
    g.setAttribute('aHit', new THREE.BufferAttribute(aHit, 1))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
    const mat = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    this.points = new THREE.Points(g, mat)
    this.points.frustumCulled = false
    this.points.renderOrder = 5

    // ---- the orbits: tilted rings around the shield (+ faint orbit lines)
    const ringC = new THREE.Vector3(0, 0, 0.45)
    this.u.uRingC.value.copy(ringC)
    const mA = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(1.2, 0.18, 0.3, 'ZXY'))
    const mB = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-1.05, -0.5, -0.55, 'ZXY'))
    this.ringA.setFromMatrix4(mA)
    this.ringB.setFromMatrix4(mB)
    this.u.uRingA.value.copy(this.ringA)
    this.u.uRingB.value.copy(this.ringB)
    const loop = (r: number, m: THREE.Matrix4, mat: THREE.LineBasicMaterial) => {
      const pts: THREE.Vector3[] = []
      for (let k = 0; k < 160; k++) {
        const a = (k / 160) * Math.PI * 2
        pts.push(new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0))
      }
      const l = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), mat)
      l.applyMatrix4(m)
      l.position.copy(ringC)
      l.frustumCulled = false
      return l
    }
    const lm = () => new THREE.LineBasicMaterial({ color: new THREE.Color(G.ice), transparent: true, opacity: 0, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, toneMapped: false })
    this.lineMatA = lm()
    this.lineMatB = lm()
    this.lineA = loop(this.u.uRingR.value.x, mA, this.lineMatA)
    this.lineB = loop(this.u.uRingR.value.y, mB, this.lineMatB)
    this.rings.add(this.lineA, this.lineB)
  }

  set(o: {
    time: number
    speed: number
    reach: number
    tail: number
    shield: number
    orbit: number
    px: number
    aspect: number
    pointer: THREE.Vector2 | null
    pointerK: number
    opacity?: number
    lines: number
  }) {
    const u = this.u
    u.uTime.value = o.time
    u.uSpeed.value = o.speed
    u.uReach.value = o.reach
    u.uTail.value = o.tail
    u.uShield.value = o.shield
    u.uOrbit.value = o.orbit
    u.uPx.value = o.px
    u.uAspect.value = o.aspect
    u.uOpacity.value = o.opacity ?? 1
    if (o.pointer) u.uPointer.value.copy(o.pointer)
    u.uPointerK.value = o.pointer ? o.pointerK : 0
    this.lineMatA.opacity = 0.2 * o.lines
    this.lineMatB.opacity = 0.12 * o.lines
    this.rings.visible = o.lines > 0.002
  }
}
