import * as THREE from 'three'

/*
 * Echoes (voices) — the chapter's own particle pieces.
 *
 *   EchoWave    a luminous sound-wave ribbon of particles across the frame.
 *               Its shape is procedural (a voice signature: amplitude,
 *               frequency, strands, travel speed, a second harmonic), so it
 *               travels like real sound; setVoices(a, b, mix) morphs between
 *               two signatures on staggered, swirling paths that start at the
 *               lens and ripple outward. The pointer plucks it (repel + swell).
 *   EchoRings   faint concentric ripple rings of particles that expand from
 *               the lens, plus one ring a click can send out (an echo).
 *
 * Both are additive sprites, so three's transmission pass can't refract them.
 * They fake it instead: a particle whose screen position falls inside the
 * glass lens's silhouette is drawn where the lens would show it — magnified
 * about the lens centre (a cylindrical lens: more across than up), hidden if
 * that lands outside the rim, with a rainbow split toward the edges. So the
 * wave is visibly broken and enlarged by the glass, like the network behind.
 */

export interface VoiceSig {
  /** amplitude, in lens units */
  amp: number
  /** radians per lens unit */
  freq: number
  /** interleaved strands (1..7) */
  strands: number
  /** travel speed, radians per second */
  speed: number
  /** 0..1 mix of a second harmonic */
  harm: number
  /** the second harmonic's frequency ratio */
  ratio: number
  /** envelope half-width around the lens, lens units */
  env: number
  /** phase offset between strands */
  spread: number
  /** the voice's two strand colours (outer → inner) */
  c0: string
  c1: string
}

/** Screen-space lens shared by every particle piece (set per frame by the chapter). */
export function lensUniforms() {
  return {
    /** centre (x·aspect, y in NDC) and the silhouette's radii (an ellipse) */
    uLens: { value: new THREE.Vector4(0, 0, 0.3, 0.3) },
    /** magnification across / up */
    uLensMag: { value: new THREE.Vector2(1.34, 1.34) },
    uLensOn: { value: 1 },
    uAspect: { value: 1.6 },
  }
}
export type LensUniforms = ReturnType<typeof lensUniforms>

const LENS_GLSL = /* glsl */ `
  uniform vec4 uLens;
  uniform vec2 uLensMag;
  uniform float uLensOn, uAspect;
  varying float vGlass;
  varying float vDisp;

  // approximate signed distance to the lens's elliptical silhouette
  float lensSD(vec2 p) {
    vec2 r = max(uLens.zw, vec2(1e-4));
    vec2 q = (p - uLens.xy) / r;
    return (length(q) - 1.0) * min(r.x, r.y);
  }

  // Bend a clip-space position as if seen through the glass lens.
  // Returns an alpha multiplier; sizeK scales the sprite.
  float bend(inout vec4 clip, out float sizeK) {
    vGlass = 0.0;
    vDisp = 0.0;
    sizeK = 1.0;
    float w = max(clip.w, 1e-4);
    vec2 ndc = clip.xy / w;
    vec2 p = vec2(ndc.x * uAspect, ndc.y);
    float behind = (1.0 - step(0.0, lensSD(p))) * step(0.001, uLensOn);
    vec2 M = mix(vec2(1.0), uLensMag, uLensOn);
    vec2 pm = uLens.xy + (p - uLens.xy) * M;
    float dOut = lensSD(pm);
    vec2 q = mix(p, pm, behind);
    clip.xy = vec2(q.x / uAspect, q.y) * w;
    vGlass = behind * uLensOn;
    vDisp = behind * clamp((pm.x - uLens.x) / max(uLens.z, 1e-4), -1.0, 1.0);
    sizeK = mix(1.0, (M.x + M.y) * 0.5, behind);
    return 1.0 - behind * uLensOn * smoothstep(-0.02, 0.0, dOut);
  }
`

const SPRITE_FRAG = /* glsl */ `
  uniform vec3 uIce, uPeach;
  varying vec3 vCol;
  varying float vA;
  varying float vGlass;
  varying float vDisp;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float core = 1.0 - smoothstep(0.0, 0.5, d);
    float a = core * core * vA;
    if (a <= 0.003) discard;
    // through the glass: a little brighter, a rainbow split toward the rim
    float e = vDisp * vDisp;
    vec3 disp = mix(uPeach, uIce, vDisp * 0.5 + 0.5);
    vec3 col = vCol * (1.0 + 0.18 * vGlass);
    col = mix(col, disp * max(max(col.r, col.g), col.b), vGlass * e * 0.55);
    gl_FragColor = vec4(col * a, 1.0);
  }
`

/* ------------------------------------------------------------------ wave */

const WAVE_VERT = /* glsl */ `
  attribute vec4 aSeed;  // x: position along the wave (-1..1, denser near the lens), y: strand, z: jitter, w: spray
  attribute vec4 aRand;  // x: stagger, y: size, z: swirl phase, w: twinkle / tint
  uniform float uTime, uMix, uSwirl, uSize, uPx, uOpacity, uScatter, uPhase, uUnit, uY, uZ;
  uniform vec4 uVA, uVB;   // amp, freq, strands, speed
  uniform vec4 uHA, uHB;   // harm, ratio, env, spread
  uniform vec3 uSpan;      // lens x, left edge x, right edge x (world)
  uniform vec4 uPtr;       // pointer on the wave plane (xyz), strength
  uniform vec2 uSwell;     // x of a swell (world), strength
  uniform vec3 uA0, uA1, uB0, uB1, uWhiteC, uPeachC;
  varying vec3 vCol;
  varying float vA;
  ${LENS_GLSL}

  vec2 voice(float xu, float s, vec4 V, vec4 H, float t, out float env) {
    float strands = max(V.z, 1.0);
    float k = floor(s * strands);
    float kn = strands > 1.5 ? k / (strands - 1.0) : 0.5;
    float e = xu / max(H.z, 0.1);
    env = exp(-e * e);
    float ph = t * V.w + uPhase + k * H.w;
    float y1 = sin(xu * V.y - ph);
    float y2 = sin(xu * V.y * H.y - ph * 1.31 + k * 0.9);
    float taper = 1.0 - 0.72 * abs(kn * 2.0 - 1.0);
    return vec2(mix(y1, y2, H.x) * V.x * env * taper, kn);
  }

  void main() {
    float xn = aSeed.x;
    float xw = xn < 0.0 ? uSpan.x + xn * (uSpan.x - uSpan.y) : uSpan.x + xn * (uSpan.z - uSpan.x);
    float xu = (xw - uSpan.x) / uUnit;
    float t = uTime;

    // the pointer's swell: the wave rises under the cursor, like a voice picked up
    float sx = (xw - uSwell.x) / uUnit;
    float swell = 1.0 + 0.65 * uSwell.y * exp(-sx * sx * 1.6);

    float envA, envB;
    vec2 a = voice(xu, aSeed.y, uVA, uHA, t, envA);
    vec2 b = voice(xu, aSeed.y, uVB, uHB, t, envB);

    // staggered morph: particles at the lens change voice first, the change ripples outward
    float dist = abs(xn);
    // (spatial only, so neighbours travel together: a clean front, not a cloud)
    float st = min(dist, 1.0) * 0.42 + aRand.x * 0.03;
    float m = clamp((uMix - st) / 0.55, 0.0, 1.0);
    m = m * m * (3.0 - 2.0 * m);
    float y = mix(a.x, b.x, m) * swell;
    float kn = mix(a.y, b.y, m);
    float env = mix(envA, envB, m);

    vec3 p = vec3(xw, uY + y * uUnit, uZ + (kn - 0.5) * 0.3 * uUnit);
    // the ribbon's grain: a hair of thickness, more where it's loud
    p.y += (aSeed.z - 0.5) * 0.028 * uUnit * (0.5 + env);
    // spray: a few particles float off the crest (the sparkle)
    float spray = step(0.955, aSeed.w);
    float drift = sin(t * (0.25 + aRand.y * 0.3) + aRand.z * 6.2831);
    p.y += spray * ((aSeed.z - 0.5) * 1.1 * (0.12 + 0.6 * env) + drift * 0.1) * uUnit;
    p.z += spray * (aRand.w - 0.5) * 0.9 * uUnit;
    p.x += spray * cos(t * 0.2 + aRand.z * 9.0) * 0.08 * uUnit;

    // mid-flight: the ribbon twists into a helix (strands wind around its axis
    // at their own phase), then unwinds into the next voice
    float fly = 4.0 * m * (1.0 - m);
    float th = xu * 1.3 - t * 1.6 + kn * 6.2831;
    float hr = uSwirl * fly * uUnit * (0.25 + 0.75 * max(env, 0.15)) * 0.55;
    p.y += cos(th) * hr;
    p.z += sin(th) * hr * 1.4;
    p += (vec3(aRand.z, aRand.w, aRand.x) - 0.5) * 0.06 * uUnit * uSwirl * fly;

    // the pointer plucks the ribbon: particles part around it (particles.js repulse)
    vec2 dp = p.xy - uPtr.xy;
    float r = length(dp);
    float R = 0.95 * uUnit;
    float f = (1.0 - smoothstep(0.0, R, r)) * uPtr.w;
    p.xy += (dp / max(r, 1e-4)) * f * 0.36 * uUnit * (0.45 + aRand.y);

    // dissolve: the ribbon comes apart into drifting dust (chaos <-> order)
    float sc = uScatter * uScatter;
    p += (vec3(aRand.z, aSeed.z, aRand.w) - 0.5) * vec3(5.0, 3.2, 3.0) * uUnit * sc;
    p.y += sin(aRand.x * 40.0 + t * 0.5) * 0.25 * uUnit * uScatter;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vec4 clip = projectionMatrix * mv;
    float sizeK;
    float vis = bend(clip, sizeK);
    gl_Position = clip;

    float tw = 0.72 + 0.28 * sin(t * (1.4 + aRand.w * 2.2) + aRand.z * 20.0);
    float loud = 0.4 + 0.6 * env;
    vA = uOpacity * vis * tw * loud * (1.0 + 0.55 * f) * (1.0 - 0.55 * uScatter) * (spray > 0.5 ? 0.8 - 0.4 * vGlass : 1.0);

    float kc = smoothstep(0.1, 0.9, kn);
    vec3 base = mix(mix(uA0, uA1, kc), mix(uB0, uB1, kc), m);
    base = mix(base, uWhiteC, 0.45 * env * (1.0 - abs(kn * 2.0 - 1.0)));
    vec3 sprayC = aRand.w > 0.8 ? uPeachC : uWhiteC;
    vCol = mix(base, sprayC, spray) + uWhiteC * f * 0.2;

    float px = uSize * (0.55 + aRand.y * 0.9) * (1.0 + spray * 0.4) * sizeK;
    gl_PointSize = clamp(px * projectionMatrix[1][1] * 0.5 * uPx / max(-mv.z, 0.05), 1.0, 48.0);
  }
`

function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => (s = (s * 16807) % 2147483647) / 2147483647
}

const sigVec = (s: VoiceSig, v: THREE.Vector4, h: THREE.Vector4) => {
  v.set(s.amp * 0.9, s.freq, s.strands, s.speed)
  h.set(s.harm, s.ratio, s.env, s.spread)
}

export class EchoWave {
  points: THREE.Points
  u = {
    uTime: { value: 0 },
    uMix: { value: 0 },
    uSwirl: { value: 0.6 },
    uSize: { value: 0.03 },
    uPx: { value: 900 },
    uOpacity: { value: 1 },
    uScatter: { value: 0 },
    uPhase: { value: 0 },
    uUnit: { value: 1 },
    uY: { value: 0 },
    uZ: { value: 0 },
    uVA: { value: new THREE.Vector4() },
    uVB: { value: new THREE.Vector4() },
    uHA: { value: new THREE.Vector4() },
    uHB: { value: new THREE.Vector4() },
    uSpan: { value: new THREE.Vector3(0, -5, 5) },
    uPtr: { value: new THREE.Vector4(0, 0, 0, 0) },
    uSwell: { value: new THREE.Vector2(0, 0) },
    uA0: { value: new THREE.Color('#88c4ff') },
    uA1: { value: new THREE.Color('#8b7bff') },
    uB0: { value: new THREE.Color('#88c4ff') },
    uB1: { value: new THREE.Color('#8b7bff') },
    uWhiteC: { value: new THREE.Color('#f4f7ff') },
    uPeachC: { value: new THREE.Color('#ffb38a') },
    uIce: { value: new THREE.Color('#88c4ff') },
    uPeach: { value: new THREE.Color('#ffb38a') },
  }
  constructor(count: number, lens: LensUniforms, seed = 41) {
    const r = rng(seed)
    const seedA = new Float32Array(count * 4)
    const rand = new Float32Array(count * 4)
    for (let i = 0; i < count; i++) {
      // half the particles spread evenly edge to edge, half crowd the lens
      const k = r()
      const u = r() * 2 - 1
      const xn = k < 0.5 ? u : u * u * u * 0.55 + (r() - 0.5) * 0.04
      seedA[i * 4] = Math.max(-1, Math.min(1, xn))
      seedA[i * 4 + 1] = r()
      seedA[i * 4 + 2] = r()
      seedA[i * 4 + 3] = r()
      for (let j = 0; j < 4; j++) rand[i * 4 + j] = r()
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
    g.setAttribute('aSeed', new THREE.BufferAttribute(seedA, 4))
    g.setAttribute('aRand', new THREE.BufferAttribute(rand, 4))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
    const m = new THREE.ShaderMaterial({
      uniforms: { ...this.u, ...lens },
      vertexShader: WAVE_VERT,
      fragmentShader: SPRITE_FRAG,
      transparent: true,
      depthWrite: false,
      // drawn over the glass: the lens "shows" it through the fake refraction
      depthTest: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    this.points = new THREE.Points(g, m)
    this.points.frustumCulled = false
    this.points.renderOrder = 4
  }
  /** Morph from signature a (mix 0) to b (mix 1). */
  setVoices(a: VoiceSig, b: VoiceSig, mix: number) {
    sigVec(a, this.u.uVA.value, this.u.uHA.value)
    sigVec(b, this.u.uVB.value, this.u.uHB.value)
    this.u.uA0.value.set(a.c0)
    this.u.uA1.value.set(a.c1)
    this.u.uB0.value.set(b.c0)
    this.u.uB1.value.set(b.c1)
    this.u.uMix.value = mix
  }
}

/* ----------------------------------------------------------------- rings */

const RINGS = 3

const RING_VERT = /* glsl */ `
  attribute vec4 aRing;  // x: angle, y: ring index (0..RINGS, RINGS = the click echo), z: jitter, w: twinkle
  uniform float uTime, uSize, uPx, uOpacity, uUnit, uR0, uR1, uSpeed, uSquash;
  uniform vec3 uCenter;
  uniform vec4 uClick;    // xyz = origin, w = age in seconds (< 0: none)
  uniform vec3 uIceC, uVioletC, uWhiteC;
  varying vec3 vCol;
  varying float vA;
  ${LENS_GLSL}

  void main() {
    float idx = aRing.y;
    float th = aRing.x;
    float isClick = step(${RINGS}.0 - 0.5, idx);
    float ph = fract(uTime * uSpeed + idx / ${RINGS}.0);
    // echoes: the rings ease out as they grow (fast from the lens, then lingering)
    float grow = 1.0 - (1.0 - ph) * (1.0 - ph);
    float rad = mix(uR0, uR1, grow) * uUnit;
    float life = sin(3.14159 * ph);
    vec3 c = uCenter;
    float ca = 0.0;
    if (isClick > 0.5) {
      float age = uClick.w;
      float k = clamp(age / 2.6, 0.0, 1.0);
      rad = mix(0.12, 2.6, 1.0 - (1.0 - k) * (1.0 - k)) * uUnit;
      life = age < 0.0 ? 0.0 : (1.0 - k) * smoothstep(0.0, 0.18, age);
      c = uClick.xyz;
      ca = 1.0;
    }
    // a faint 'sound' wobble on each ring
    rad *= 1.0 + 0.018 * sin(th * 7.0 + uTime * 0.8 + idx * 2.0);
    rad += (aRing.z - 0.5) * 0.05 * uUnit;
    vec3 p = c + vec3(cos(th) * rad, sin(th) * rad * uSquash, (aRing.z - 0.5) * 0.08 * uUnit);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vec4 clip = projectionMatrix * mv;
    float sizeK;
    float vis = bend(clip, sizeK);
    gl_Position = clip;

    float tw = 0.65 + 0.35 * sin(uTime * (1.1 + aRing.w * 2.0) + aRing.w * 30.0);
    vA = uOpacity * life * vis * tw * mix(1.0, 1.6, ca);
    vCol = mix(mix(uIceC, uVioletC, 0.5 + 0.5 * sin(th + idx)), uWhiteC, 0.25 + 0.35 * ca);
    float px = uSize * (0.6 + aRing.w * 0.8) * sizeK;
    gl_PointSize = clamp(px * projectionMatrix[1][1] * 0.5 * uPx / max(-mv.z, 0.05), 1.0, 32.0);
  }
`

export class EchoRings {
  points: THREE.Points
  u = {
    uTime: { value: 0 },
    uSize: { value: 0.022 },
    uPx: { value: 900 },
    uOpacity: { value: 0.5 },
    uUnit: { value: 1 },
    uR0: { value: 0.7 },
    uR1: { value: 5 },
    uSpeed: { value: 0.045 },
    uSquash: { value: 1 },
    uCenter: { value: new THREE.Vector3() },
    uClick: { value: new THREE.Vector4(0, 0, 0, -1) },
    uIceC: { value: new THREE.Color('#88c4ff') },
    uVioletC: { value: new THREE.Color('#8b7bff') },
    uWhiteC: { value: new THREE.Color('#f4f7ff') },
    uIce: { value: new THREE.Color('#88c4ff') },
    uPeach: { value: new THREE.Color('#ffb38a') },
  }
  constructor(perRing: number, lens: LensUniforms, seed = 77) {
    const r = rng(seed)
    const n = perRing * (RINGS + 1)
    const a = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) {
      const ring = Math.floor(i / perRing)
      // even angular spacing with a little jitter: a dotted ring, not a smear
      const j = i % perRing
      a[i * 4] = ((j + r() * 0.6) / perRing) * Math.PI * 2
      a[i * 4 + 1] = ring
      a[i * 4 + 2] = r()
      a[i * 4 + 3] = r()
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
    g.setAttribute('aRing', new THREE.BufferAttribute(a, 4))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
    const m = new THREE.ShaderMaterial({
      uniforms: { ...this.u, ...lens },
      vertexShader: RING_VERT,
      fragmentShader: SPRITE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    this.points = new THREE.Points(g, m)
    this.points.frustumCulled = false
    this.points.renderOrder = 3
  }
}
