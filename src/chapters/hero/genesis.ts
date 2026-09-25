import * as THREE from 'three'
import { markShape } from '../../kit/particles'
import { logoOutlinePoints } from '../../logo/logo'
import { rng } from '../../core/math'
import { G } from '../../kit/glass'

/*
 * GENESIS CLOUD — one particle system, three forms, all driven by uniforms:
 *
 *   A  the NEBULA   a three-armed spiral disc (warm-white heart, ice arms
 *                   cooling to violet), tilted toward the camera, turning
 *                   slowly with a twist that winds and unwinds (frame.time)
 *   B  the MARK     the Hark mark: area-uniform on its face, a quarter of the
 *                   particles tracing its outline for crisp edges
 *   C  the HALO     a tilted orbit ring (thin bright core band + soft band,
 *                   differential spin) and a sparse shell
 *
 * A → B (uCondense): every particle SPIRALS in around the view axis (polar
 * interpolation, inner stars first) — chaos condensing into the mark.
 * B → C (uFront): a crystallization front sweeps diagonally across the mark;
 * as it passes, particles flare, a few are absorbed into the glass, and the
 * rest lift off and spiral out into the orbit ring.
 *
 * B → D (uTextT): a quarter of them instead stream off the mark into the
 * headline's accent word ('listen.'), placed in VIEW space from the word's
 * measured screen box (so the particle word sits exactly where the DOM word
 * will crossfade in, whatever the camera or its parallax does), then drift
 * apart and fade as the DOM word takes over. setWord() fills the glyph
 * targets once the display font is ready; until then they stay in the ring.
 *
 * Pointer: particles near the cursor are pushed aside with a slight vortex
 * (screen space, stateless — correct at any jumped-to scroll position); a
 * click sends a soft ring out through them.
 *
 * The same geometry is drawn twice: a BEHIND copy in three's opaque list
 * (additive, so the transmission pass captures it and the glass mark REFRACTS
 * the particles behind it) and a FRONT copy in the transparent list (drawn
 * over the glass). The split is the view depth of the mark's centre.
 */

const VERT = /* glsl */ `
  attribute vec3 aNeb;   // nebula: r (0..~1), angle, height (x nebula radius)
  attribute vec3 aMark;  // mark position
  attribute vec4 aHalo;  // ring: (r, angle, h, 0 core | 0.25 soft) | shell: (x, y, z, 1)
  attribute vec4 aRand;
  attribute vec4 aText;  // word: glyph (x from the word's left, y from its mid-line) in em, is-word flag, departure delay
  uniform float uTextT, uTextFade, uTextOn, uTextD, uTextW, uTextSize, uTextA, uTextDrift;
  uniform vec2 uTextC, uTextK;
  uniform vec3 uGradA, uGradB, uGradC;
  uniform float uTime, uCondense, uFront, uTravel, uHot, uSize, uPx, uOpacity, uReveal, uSwirl;
  uniform float uNebR, uNebSpin, uRingSpin, uRingR, uShellSpin, uHaloK, uNearFade;
  uniform mat3 uNebRot, uRingRot;
  uniform vec2 uDir, uPtr;
  uniform vec3 uClick;
  uniform float uPtrK, uPtrR, uAspect, uSide, uSplitZ;
  uniform vec3 uIce, uViolet, uPeach, uWhite;
  varying vec3 vCol;
  varying float vA;

  const float TAU = 6.2831853;

  // interpolate a → b around the view axis (counter-clockwise), plus whole turns
  vec3 spiral(vec3 a, vec3 b, float t, float turns) {
    float ra = length(a.xy);
    float rb = length(b.xy);
    float aa = atan(a.y, a.x + 1e-5);
    float ab = atan(b.y, b.x + 1e-5);
    float d = mod(ab - aa, TAU) + turns * TAU;
    float an = aa + d * t;
    float r = mix(ra, rb, t);
    return vec3(cos(an) * r, sin(an) * r, mix(a.z, b.z, t));
  }

  void main() {
    // ---- A: nebula
    float rn = aNeb.x;
    // rigid spin + a slow twist that winds and unwinds (arms never smear out)
    float an = aNeb.y + uNebSpin + 0.26 * (1.0 - min(rn, 1.0)) * sin(uTime * 0.3 + rn * 5.0);
    float breathe = 1.0 + 0.025 * sin(uTime * 0.55 + aNeb.y * 3.0 + rn * 7.0);
    float R = rn * uNebR * breathe;
    vec3 pn = uNebRot * vec3(cos(an) * R, aNeb.z * uNebR, sin(an) * R);
    // the reveal: stars breathe in from a wider, darker cloud
    float rv = clamp(uReveal * 1.6 - aRand.y * 0.6, 0.0, 1.0);
    rv = rv * rv * (3.0 - 2.0 * rv);
    pn *= 1.0 + (1.0 - rv) * (0.45 + aRand.z * 0.7);

    // ---- B: the mark (with a faint idle shimmer)
    vec3 pm = aMark + vec3(sin(uTime * (0.7 + aRand.y) + aRand.z * 9.0), cos(uTime * (0.6 + aRand.x) + aRand.w * 9.0), 0.0) * 0.005;

    // ---- C: the halo (ring bands + shell)
    vec3 ph;
    if (aHalo.w < 0.5) {
      float r = aHalo.x;
      float a = aHalo.y + uRingSpin * (1.5 / (0.5 + r / uRingR));
      ph = uRingRot * vec3(cos(a) * r, aHalo.z, sin(a) * r);
    } else {
      float c = cos(uShellSpin);
      float sn = sin(uShellSpin);
      ph = vec3(aHalo.x * c + aHalo.z * sn, aHalo.y, -aHalo.x * sn + aHalo.z * c);
    }
    ph *= uHaloK;

    // ---- A → B: spiral in (inner stars first)
    float e1 = clamp((uCondense - (min(rn, 1.0) * 0.2 + aRand.x * 0.2)) / 0.6, 0.0, 1.0);
    e1 = e1 * e1 * (3.0 - 2.0 * e1);
    vec3 p = spiral(pn, pm, e1, step(0.55, aRand.z));
    float fly1 = 4.0 * e1 * (1.0 - e1);
    float sw = aRand.z * TAU + uTime * 0.5;
    p += vec3(sin(sw + p.y * 1.3), cos(sw * 1.2 + p.x * 1.1), sin(sw * 0.7)) * fly1 * uSwirl * (0.3 + aRand.y * 0.5);

    // ---- B → C: the crystallization front
    float s = dot(aMark.xy, uDir);
    float past = uFront - s;
    float absorbed = step(aRand.w, 0.16);
    float isWord = aText.z * uTextOn;
    float e2 = clamp((past - aRand.x * uTravel * 0.3) / uTravel, 0.0, 1.0);
    e2 = e2 * e2 * (3.0 - 2.0 * e2) * (1.0 - absorbed) * (1.0 - isWord);
    float hot = smoothstep(-uHot, 0.0, past) * (1.0 - smoothstep(0.0, uHot * 2.5, past));
    p = spiral(p, ph, e2, 0.0);
    float fly2 = 4.0 * e2 * (1.0 - e2);
    p += vec3(sin(sw * 1.3 + p.y), cos(sw + p.x * 1.4), sin(sw * 0.9 + 1.7)) * fly2 * uSwirl * 0.35 * (0.3 + aRand.y * 0.5);

    // ---- colour + alpha per form
    // nebula: a warm-white heart, ice arms cooling to violet at the rim, a few white stars
    vec3 cn = mix(uIce, uViolet, smoothstep(0.3, 0.95, rn) * (0.35 + 0.65 * aRand.y));
    cn = mix(mix(uWhite, uPeach, 0.2 + 0.45 * aRand.z), cn, smoothstep(0.03, 0.28, rn));
    cn = mix(cn, uWhite, step(0.95, aRand.w) * 0.8);
    vec3 cm = mix(uIce, uWhite, 0.35 + 0.55 * aRand.y);
    // ring: a white-ice core band, ice → violet around it, a rare peach spark
    float coreBand = 1.0 - step(0.1, aHalo.w);
    vec3 ch = mix(uIce, uViolet, aRand.y * 0.8 * (1.0 - coreBand * 0.7));
    ch = mix(ch, uWhite, coreBand * 0.4);
    ch = mix(ch, uPeach, step(0.97, aRand.z));
    vec3 col = mix(mix(cn, cm, e1), ch, e2);
    col = mix(col, uWhite, hot * 0.75);

    float ringK = aHalo.w < 0.1 ? 1.25 : (aHalo.w < 0.5 ? 0.75 : 0.5);
    // nebula: the arms burn brighter toward the heart
    float nebK = rv * (1.15 - 0.35 * smoothstep(0.2, 1.0, rn));
    float a = mix(mix(nebK, 0.95, e1), 0.75 * ringK, e2) * (0.4 + 0.6 * aRand.w);
    a *= 1.0 + hot * 0.9;
    a *= 1.0 - absorbed * smoothstep(0.0, uHot * 2.5, past);
    a *= 0.8 + 0.2 * sin(uTime * (1.3 + aRand.w * 2.0) + aRand.z * 20.0);
    a *= uOpacity;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);

    // ---- B → D: stream off the mark into the headline's accent word (view space)
    float e3 = 0.0;
    float sizeK = 1.0;
    if (isWord > 0.5) {
      e3 = clamp((uTextT - aText.w) / 0.58, 0.0, 1.0);
      e3 = e3 * e3 * e3 * (e3 * (e3 * 6.0 - 15.0) + 10.0);
      vec2 ndcT = uTextC + aText.xy * uTextK;
      vec3 tv = vec3(ndcT.x * uTextD / projectionMatrix[0][0], ndcT.y * uTextD / projectionMatrix[1][1], -uTextD);
      // once the DOM word is in, the particles drift apart as they fade
      tv.xy += (aRand.zw - 0.5) * uTextDrift * uTextFade * uTextD / projectionMatrix[1][1];
      vec3 dv = tv - mv.xyz;
      float bow = sin(3.14159265 * e3);
      vec2 side = vec2(-dv.y, dv.x);
      vec3 q = mix(mv.xyz, tv, e3);
      q.xy += side * (aRand.y - 0.5) * 0.42 * bow;
      q += vec3(sin(sw * 1.1 + aRand.x * 7.0), cos(sw * 0.9 + aRand.z * 5.0), 0.0) * bow * uSwirl * 0.05 * length(dv.xy);
      mv.xyz = q;
      // the word's gradient: ice → violet → peach, left to right (the <em>'s own)
      float gx = clamp(aText.x / uTextW, 0.0, 1.0);
      vec3 cw = gx < 0.52 ? mix(uGradA, uGradB, gx / 0.52) : mix(uGradB, uGradC, (gx - 0.52) / 0.48);
      col = mix(col, cw, e3);
      a = mix(a, uTextA * (0.6 + 0.4 * aRand.y) * uOpacity, e3) * (1.0 - uTextFade * smoothstep(0.0, 1.0, e3));
      sizeK = mix(1.0, uTextSize, e3);
    }

    // ---- pointer: push aside with a slight vortex (screen space)
    vec4 clip = projectionMatrix * mv;
    vec2 ndc = clip.xy / max(clip.w, 1e-3);
    vec2 dd = (ndc - uPtr) * vec2(uAspect, 1.0);
    float dist = length(dd);
    float f = (1.0 - smoothstep(0.0, uPtrR, dist)) * uPtrK;
    vec2 dir = dd / max(dist, 1e-4);
    vec2 push = (dir * 0.42 + vec2(-dir.y, dir.x) * 0.22) * f * uPtrR;
    mv.xy += push * (-mv.z) / projectionMatrix[1][1];
    a *= 1.0 + f * 0.35;
    // click: a soft shock ring runs out from the click point
    vec2 dc = (ndc - uClick.xy) * vec2(uAspect, 1.0);
    float dcl = length(dc);
    float wv = (dcl - uClick.z * 0.9) / 0.07;
    float band = exp(-wv * wv) * (1.0 - smoothstep(0.15, 1.3, uClick.z));
    mv.xy += dc / max(dcl, 1e-4) * band * 0.045 * (-mv.z) / projectionMatrix[1][1];
    a *= 1.0 + band * 0.7;

    // ---- near the lens: soften (the final dive)
    a *= smoothstep(uNearFade * 0.4, uNearFade, -mv.z);

    // ---- which copy draws this particle (behind / in front of the glass)
    float front = step(uSplitZ, mv.z);
    float keep = uSide > 0.0 ? front : 1.0 - front;

    vCol = col;
    vA = a;
    float size = uSize * (0.55 + aRand.y * 0.9) * (1.0 + (step(0.95, aRand.w) * 0.6 + 0.2) * (1.0 - e1)) * (1.0 + hot * 0.4) * sizeK;
    gl_PointSize = clamp(size * projectionMatrix[1][1] * 0.5 * uPx / max(-mv.z, 0.05), 1.0, 48.0);
    gl_Position = keep > 0.5 && a > 0.002 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
  }
`

const FRAG = /* glsl */ `
  varying vec3 vCol;
  varying float vA;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    float core = 1.0 - smoothstep(0.0, 1.0, d);
    float a = core * core * vA;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(vCol * a, 1.0);
  }
`

export interface GenesisCloud {
  group: THREE.Group
  u: Record<string, THREE.IUniform>
  /** sweep axis (mark plane) and the extent of the mark along it */
  dir: THREE.Vector2
  sMin: number
  sMax: number
  /** ring rotation (shared with the plexus nodes) */
  ringRot: THREE.Matrix3
  ringR: number
  /**
   * Give the word particles their glyph targets: `pts` holds (x, y) pairs in
   * em (x from the word's left edge, y up from its mid-line), `width` the
   * word's advance in em. Particles that leave the mark first (lowest along
   * the sweep) take the leftmost glyph points, so the word writes itself left
   * to right as the front crosses the mark.
   */
  setWord(pts: Float32Array, width: number): void
  /** how many particles form the word (sample that many glyph points) */
  wordCount: number
}

/** wordShare: the fraction of eligible particles that form the headline's accent word */
export function buildGenesis(o: { count: number; S: number; nebR: number; mobile: boolean; wordShare: number }): GenesisCloud {
  const { count: n, S, nebR } = o
  const r = rng(71)
  const gauss = () => {
    let u = 0
    for (let i = 0; i < 3; i++) u += r()
    return (u - 1.5) / 0.5
  }
  const sgn = () => (r() < 0.5 ? -1 : 1)

  // ---- A: the nebula — three tight arms with power-law scatter (most stars
  // hug the arm, a few stray), a small bulge, and a whisper of haze
  const neb = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const k = r()
    let x: number
    let z: number
    let h: number
    if (k < 0.08) {
      const rb = 0.075 * Math.sqrt(-Math.log(Math.max(1e-4, r())))
      const th = r() * Math.PI * 2
      x = Math.cos(th) * rb
      z = Math.sin(th) * rb
      h = gauss() * 0.025
    } else if (k < 0.93) {
      const rn = 0.03 + 0.97 * Math.pow(r(), 1.1)
      const th = (Math.floor(r() * 3) * Math.PI * 2) / 3 + rn * 5.4
      const sc = 0.03 + 0.26 * rn
      x = Math.cos(th) * rn + Math.pow(r(), 3) * sgn() * sc
      z = Math.sin(th) * rn + Math.pow(r(), 3) * sgn() * sc
      h = Math.pow(r(), 3) * sgn() * 0.08 * rn + gauss() * 0.006
    } else {
      const rn = Math.pow(r(), 0.7)
      const th = r() * Math.PI * 2
      x = Math.cos(th) * rn
      z = Math.sin(th) * rn
      h = gauss() * 0.02
    }
    neb[i * 3] = Math.min(1.15, Math.hypot(x, z))
    neb[i * 3 + 1] = Math.atan2(z, x)
    neb[i * 3 + 2] = h
  }

  // ---- B: the mark — face samples, a quarter moved onto the outline
  const mark = markShape(n, { size: S, depth: 0.05, seed: 9 })
  const edgeN = Math.floor(n * 0.25)
  const edge = logoOutlinePoints(edgeN)
  for (let i = 0; i < edgeN; i++) {
    const j = Math.floor(r() * n)
    mark[j * 3] = edge[i * 3] * S + gauss() * 0.004 * S
    mark[j * 3 + 1] = edge[i * 3 + 1] * S + gauss() * 0.004 * S
  }

  // ---- C: the halo — a thin bright core band, a soft band around it, a sparse shell
  const ringR = S * 0.9
  const halo = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    const o4 = i * 4
    const k = r()
    if (k < 0.72) {
      const core = k < 0.42
      halo[o4] = ringR * (1 + gauss() * (core ? 0.022 : 0.085))
      halo[o4 + 1] = r() * Math.PI * 2
      halo[o4 + 2] = gauss() * S * (core ? 0.008 : 0.028)
      halo[o4 + 3] = core ? 0 : 0.25
    } else {
      const u = r() * 2 - 1
      const t = r() * Math.PI * 2
      const q = Math.sqrt(1 - u * u)
      const rad = S * (1.1 + 0.55 * r() * r())
      halo[o4] = q * Math.cos(t) * rad
      halo[o4 + 1] = u * rad * 0.8
      halo[o4 + 2] = q * Math.sin(t) * rad
      halo[o4 + 3] = 1
    }
  }

  const rand = new Float32Array(n * 4)
  for (let i = 0; i < rand.length; i++) rand[i] = r()

  // ---- D: the word — about a quarter of the particles (never the absorbed
  // ones, never the rare white stars) stream off the mark into the headline
  const text = new Float32Array(n * 4)

  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3))
  g.setAttribute('aNeb', new THREE.BufferAttribute(neb, 3))
  g.setAttribute('aMark', new THREE.BufferAttribute(mark, 3))
  g.setAttribute('aHalo', new THREE.BufferAttribute(halo, 4))
  g.setAttribute('aRand', new THREE.BufferAttribute(rand, 4))
  const textAttr = new THREE.BufferAttribute(text, 4)
  g.setAttribute('aText', textAttr)
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)

  // sweep diagonally across the mark: lower-left → upper-right
  const dir = new THREE.Vector2(1, 0.8).normalize()
  let sMin = Infinity
  let sMax = -Infinity
  for (let i = 0; i < n; i++) {
    const s = mark[i * 3] * dir.x + mark[i * 3 + 1] * dir.y
    if (s < sMin) sMin = s
    if (s > sMax) sMax = s
  }

  // word particles in departure order: along the sweep (+ a little noise)
  const wordIdx: number[] = []
  for (let i = 0; i < n; i++) {
    const w = rand[i * 4 + 3]
    if (w >= 0.16 && w < 0.95 && r() < o.wordShare) wordIdx.push(i)
  }
  const sOf = (i: number) => mark[i * 3] * dir.x + mark[i * 3 + 1] * dir.y
  const wordKey = new Map<number, number>()
  for (const i of wordIdx) wordKey.set(i, (sOf(i) - sMin) / Math.max(1e-5, sMax - sMin) + (r() - 0.5) * 0.12)
  wordIdx.sort((a, b) => wordKey.get(a)! - wordKey.get(b)!)
  const setWord = (pts: Float32Array, width: number) => {
    const m = Math.min(wordIdx.length, pts.length / 2)
    if (!m) return
    // glyph points by x (+ noise), paired with the departure order
    const order = Array.from({ length: pts.length / 2 }, (_, k) => k)
    const key = new Float32Array(order.length)
    for (let k = 0; k < order.length; k++) key[k] = pts[k * 2] / Math.max(1e-3, width) + (r() - 0.5) * 0.14
    order.sort((a, b) => key[a] - key[b])
    for (let k = 0; k < wordIdx.length; k++) {
      const i = wordIdx[k]
      const o4 = i * 4
      if (k >= m) {
        text[o4 + 2] = 0
        continue
      }
      const g2 = order[Math.floor((k / m) * order.length)] * 2
      const s01 = k / Math.max(1, m - 1)
      text[o4] = pts[g2]
      text[o4 + 1] = pts[g2 + 1]
      text[o4 + 2] = 1
      // departure: follows the front across the mark
      text[o4 + 3] = s01 * 0.34 + rand[i * 4] * 0.06
    }
    u.uTextW.value = width
    textAttr.needsUpdate = true
  }

  // the nebula disc: tilted ~45° from face-on, major axis rolled
  const nebRot = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.78, 0, -0.32, 'ZYX')))
  // the orbit ring: open ellipse, rolled against the mark's diagonal
  const ringRot = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.46, 0, -0.26, 'ZYX')))

  const c = (hex: string) => new THREE.Color(hex)
  const u: Record<string, THREE.IUniform> = {
    uTime: { value: 0 },
    uCondense: { value: 0 },
    uFront: { value: sMin - 10 },
    uTravel: { value: S * 0.9 },
    uHot: { value: S * 0.07 },
    uSize: { value: o.mobile ? 0.03 : 0.022 },
    uPx: { value: 900 },
    uOpacity: { value: 1 },
    uReveal: { value: 0 },
    uSwirl: { value: 0.6 },
    uNebR: { value: nebR },
    uNebSpin: { value: 0 },
    uRingSpin: { value: 0 },
    uRingR: { value: ringR },
    uShellSpin: { value: 0 },
    uHaloK: { value: 1 },
    uNearFade: { value: 0.9 },
    uNebRot: { value: nebRot },
    uRingRot: { value: ringRot },
    uDir: { value: dir },
    uPtr: { value: new THREE.Vector2(9, 9) },
    uClick: { value: new THREE.Vector3(9, 9, 99) },
    uPtrK: { value: 0 },
    uPtrR: { value: 0.2 },
    uAspect: { value: 1.6 },
    uSide: { value: -1 },
    uSplitZ: { value: 1e6 },
    uIce: { value: c(G.ice) },
    uViolet: { value: c(G.violet) },
    uPeach: { value: c(G.peach) },
    uWhite: { value: c(G.white) },
    // the word
    uTextT: { value: 0 },
    uTextFade: { value: 0 },
    uTextOn: { value: 0 },
    uTextD: { value: 8 },
    uTextW: { value: 3 },
    uTextSize: { value: 0.78 },
    uTextA: { value: 0.95 },
    uTextDrift: { value: 0.12 },
    uTextC: { value: new THREE.Vector2() },
    uTextK: { value: new THREE.Vector2(0.1, 0.1) },
    uGradA: { value: c('#8fd0ff') },
    uGradB: { value: c('#a99bff') },
    uGradC: { value: c(G.peach) },
  }
  const make = (side: number, list: 'opaque' | 'transparent') => {
    const uniforms = { ...u, uSide: { value: side } }
    const m = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: list === 'transparent',
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    const pts = new THREE.Points(g, m)
    pts.frustumCulled = false
    // the glass buffer is smaller than the frame: keep sprites the same apparent size in it
    pts.onBeforeRender = renderer => {
      const rt = renderer.getRenderTarget()
      const px = rt ? rt.height : renderer.domElement.height
      if (u.uPx.value !== px) {
        u.uPx.value = px
        m.uniformsNeedUpdate = true
      }
    }
    return pts
  }
  const group = new THREE.Group()
  const behind = make(-1, 'opaque')
  const front = make(1, 'transparent')
  front.renderOrder = 4
  group.add(behind, front)
  return { group, u, dir, sMin, sMax, ringRot, ringR, setWord, wordCount: wordIdx.length }
}
