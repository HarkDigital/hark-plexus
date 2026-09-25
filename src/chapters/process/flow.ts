import * as THREE from 'three'
import type { FlowData } from './layout'

/*
 * FLOW — one particle system that passes through the whole process.
 *
 * Six shapes live in the geometry at once (see layout.ts); `uStage` walks
 * through them (0 chaos, 1 wave, 2 wireframe, 3 blocks, 4 ring, 5 stream).
 * Between two shapes every particle travels on its own staggered, spiralling
 * path, so a transition reads as a stream flowing from one glass pane to the
 * next. Everything is a pure function of (uStage, uTime): screenshots can jump
 * to any scroll position.
 *
 * Particles are additive and ignore depth (they glow in front of the glass).
 * Glass is faked for them instead: a particle BEHIND a pane or behind the
 * finished glass form is dimmed, softened and cooled, as if seen through
 * thick glass — the stream visibly passes through each pane.
 *
 * The pointer (mouse only) parts the particles like a hand through smoke:
 * a soft radial push with a slight swirl, and a brighter rim where it bites.
 */

const VERT = /* glsl */ `
  attribute vec3 aS1;
  attribute vec3 aS2;
  attribute vec3 aS3;
  attribute vec3 aS4;
  attribute vec3 aS5;
  attribute vec4 aRand;
  attribute vec4 aRole;

  uniform float uStage, uTime, uSize, uPx, uOpacity, uYaw, uBeat, uComet, uSolid, uRingR;
  uniform vec3 uForm[4];
  uniform vec3 uProduct;
  uniform vec4 uGlass[5];
  uniform vec3 uGlassH[5];
  uniform vec3 uPtr;
  uniform float uPtrK;
  uniform vec4 uLine;     // x0, x1, arc depth, y
  uniform vec3 uIce, uViolet, uWhite, uPeach, uRose;

  varying vec3 vCol;
  varying float vA;

  const float TAU = 6.2831853;

  vec3 rotY(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }
  vec3 rotX(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z); }
  vec3 rotZ(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z); }

  // pos, colour, alpha, size of shape k for this particle
  void shape(float k, out vec3 p, out vec3 c, out float a, out float s) {
    vec4 r = aRand;
    float t = uTime;
    if (k < 0.5) {
      // CHAOS: noise wandering in a big box
      vec3 w = vec3(
        sin(t * (0.11 + 0.1 * r.y) + r.z * TAU),
        cos(t * (0.09 + 0.08 * r.x) + r.w * TAU),
        sin(t * (0.07 + 0.06 * r.w) + r.x * TAU));
      p = position + w * (0.22 + 0.32 * r.w);
      c = mix(mix(uIce, uViolet, r.w), uWhite, 0.25 * r.x);
      a = 0.5 + 0.4 * r.y;
      s = 1.55;
    } else if (k < 1.5) {
      // LISTEN: a five-strand sound wave, breathing
      float x = aS1.x * 1.34;
      float row = aS1.y;
      float env = exp(-x * x * 1.3);
      float amp = 0.36 * (0.86 + 0.14 * sin(t * 0.8));
      float y = sin(x * 4.4 + t * 1.25 + row * 1.2) * 0.55
              + sin(x * 8.7 - t * 0.95 + row * 2.6) * 0.22
              + sin(x * 2.1 + t * 0.5 + row * 0.4) * 0.3;
      y *= amp * env * (1.0 - row * 0.5);
      vec3 l = vec3(x, y + aS1.z * 0.01, (row - 0.5) * 0.24);
      p = uForm[0] + rotY(l, uYaw);
      c = mix(uIce, uWhite, 0.25 + 0.55 * env * (1.0 - row));
      c = mix(c, uViolet, row * 0.55);
      a = 0.62 + 0.3 * env;
      s = 0.9 + 0.3 * env;
    } else if (k < 2.5) {
      // PROTOTYPE: the wireframe page (hairlines, the design grid, the button)
      vec3 l = aS2 + vec3(sin(t * 0.9 + r.z * 20.0), cos(t * 0.8 + r.w * 20.0), 0.0) * 0.0035;
      p = uForm[1] + rotY(l, uYaw);
      if (aRole.x > 1.5) { c = uPeach; a = 0.95; s = 0.95; }
      else if (aRole.x > 0.5) { c = uViolet * 0.9; a = 0.5; s = 0.62; }
      else { c = mix(uIce, uWhite, 0.3 * r.y); a = 0.78; s = 0.72; }
    } else if (k < 3.5) {
      // BUILD: the same page, filled into dense blocks
      vec3 l = aS3 + vec3(sin(t * 0.7 + r.z * 20.0), cos(t * 0.6 + r.w * 20.0), 0.0) * 0.002;
      p = uForm[2] + rotY(l, uYaw);
      if (aRole.y > 1.5) { c = uWhite; a = 0.75; s = 0.8; }
      else if (aRole.y > 0.5) { c = uPeach; a = 0.85; s = 0.95; }
      else { c = mix(uIce, uWhite, 0.5 + 0.25 * r.y); a = mix(0.46, 0.3, uSolid); s = 1.0; }
    } else if (k < 4.5) {
      // SUPPORT: a steady orbit around the finished form (a slow heartbeat)
      if (aRole.z > 0.5) {
        p = uProduct + rotY(aS3, uYaw);
        c = mix(uIce, uWhite, r.y);
        a = 0.26 + 0.1 * uBeat;
        s = 0.55;
      } else {
        float ang = aS4.x + t * 0.16;
        float R = uRingR * (1.0 + 0.022 * uBeat) + aS4.y;
        vec3 l = vec3(cos(ang) * R, aS4.z, sin(ang) * R);
        l = rotX(l, 0.36);
        l = rotZ(l, 0.14);
        p = uProduct + rotY(l, uYaw);
        // a comet runs round the ring: the watch that never sleeps
        float d = abs(fract((ang - uComet) / TAU + 0.5) - 0.5);
        float comet = exp(-d * d * 900.0);
        float tail = exp(-fract((uComet - ang) / TAU) * 14.0);
        c = mix(uIce, uViolet, 0.5 + 0.5 * sin(ang));
        c = mix(c, uPeach, clamp(comet + tail * 0.35, 0.0, 1.0));
        a = (0.58 + 0.34 * r.y) * (1.0 + 0.16 * uBeat) + comet * 0.6;
        s = 0.8 + comet * 0.6;
      }
    } else {
      // RESULTS: one flow through all four panes
      if (aRole.z > 0.5) {
        p = uProduct + rotY(aS3, uYaw);
        c = mix(uIce, uWhite, r.y);
        a = 0.26;
        s = 0.55;
      } else {
        float u = fract(aS5.x + t * 0.011);
        float x = mix(uLine.x, uLine.y, u);
        float q = clamp((x - uForm[0].x) / max(uForm[3].x - uForm[0].x, 0.001), 0.0, 1.0);
        float y = uLine.w + 0.3 * sin(u * 11.0 - t * 0.32) + 0.12 * sin(u * 23.0 + t * 0.21);
        float z = uForm[0].z - uLine.z * sin(3.14159 * q) - 0.35;
        float ang = aS5.y + u * 40.0 + t * 0.4;
        vec3 tube = vec3(0.0, cos(ang), sin(ang)) * aS5.z;
        p = vec3(x, y, z) + tube;
        vec3 g1 = mix(uIce, uViolet, smoothstep(0.1, 0.55, u));
        c = mix(g1, uPeach, smoothstep(0.55, 0.95, u));
        float ends = smoothstep(0.0, 0.07, u) * (1.0 - smoothstep(0.9, 1.0, u));
        float core = 1.0 - smoothstep(0.02, 0.1, aS5.z);
        a = (0.62 + 0.3 * r.y + 0.5 * core) * ends * (1.0 - 0.5 * aS5.z / 0.28);
        s = 1.4 + 0.3 * core;
      }
    }
  }

  float stagger(float k) {
    if (k < 0.5) return clamp(length(position - uForm[0]) / 8.0, 0.0, 1.0) * 0.75 + aRand.x * 0.25;
    if (k < 1.5) return (0.5 - aS1.x * 0.5) * 0.65 + aRand.x * 0.35;
    if (k < 3.5) return aRand.x;
    return fract(aS4.x / TAU) * 0.6 + aRand.x * 0.4;
  }
  float spreadOf(float k) {
    if (k < 0.5) return 0.62;
    if (k < 1.5) return 0.55;
    if (k < 2.5) return 0.24;
    if (k < 3.5) return 0.5;
    return 0.55;
  }

  void main() {
    float st = clamp(uStage, 0.0, 5.0);
    float k = min(floor(st), 4.0);
    float f = st - k;
    vec3 pA; vec3 cA; float aA; float sA;
    vec3 pB; vec3 cB; float aB; float sB;
    shape(k, pA, cA, aA, sA);
    shape(k + 1.0, pB, cB, aB, sB);
    float sp = spreadOf(k);
    float m = clamp((f - stagger(k) * sp) / (1.0 - sp), 0.0, 1.0);
    m = m * m * m * (m * (m * 6.0 - 15.0) + 10.0);
    vec3 p = mix(pA, pB, m);
    vec3 col = mix(cA, cB, m);
    float al = mix(aA, aB, m);
    float sz = mix(sA, sB, m);

    // the journey between panes: a spiralling stream, never a straight line
    float fly = sin(3.14159 * m);
    vec4 r = aRand;
    if (k < 0.5) {
      float a0 = r.z * TAU + uTime * 0.5;
      p += vec3(sin(a0 + p.y * 1.7), cos(a0 * 1.3 + p.x * 1.3), sin(a0 * 0.7 + p.z)) * fly * (0.25 + 0.4 * r.y);
    } else {
      float wind = (k < 2.5 && k > 1.5) ? 0.35 : 1.0;
      float ang = r.z * TAU + m * 7.0 * wind;
      float rad = (0.18 + 0.5 * r.y) * fly * wind;
      // dip behind the next pane and come through it
      float dip = (k < 1.5 || (k > 2.5 && k < 3.5)) ? 1.15 * r.w : 0.25 * r.w;
      p += rotY(vec3(0.0, cos(ang) * rad, sin(ang) * rad - dip * fly), uYaw);
      sz *= 1.0 + 0.25 * fly;
    }

    // the pointer parts the particles (mouse only; off when calm)
    if (uPtrK > 0.001) {
      vec3 d = p - uPtr;
      float rr = length(d.xy);
      float fk = uPtrK * (1.0 - smoothstep(0.0, 0.72, rr));
      fk *= fk;
      vec2 dir = d.xy / max(rr, 0.001);
      p.xy += dir * fk * 0.3 + vec2(-dir.y, dir.x) * fk * 0.12;
      p.z += fk * 0.2;
      al *= 1.0 + fk * 0.8;
    }

    // behind glass: dimmer, softer, cooler (the stream passes THROUGH the panes)
    float g = 0.0;
    for (int i = 0; i < 5; i++) {
      vec3 l = rotY(p - uGlass[i].xyz, -uGlass[i].w);
      vec3 h = uGlassH[i];
      float inside = (1.0 - smoothstep(h.x - 0.1, h.x + 0.02, abs(l.x))) * (1.0 - smoothstep(h.y - 0.1, h.y + 0.02, abs(l.y)));
      float behind = 1.0 - smoothstep(-h.z - 0.05, -h.z + 0.02, l.z);
      g = max(g, inside * behind);
    }
    al *= mix(1.0, 0.3, g);
    sz *= mix(1.0, 1.8, g);
    col = mix(col, col * vec3(0.72, 0.86, 1.1) + vec3(0.01, 0.02, 0.05), g);

    float tw = 0.78 + 0.22 * sin(uTime * (1.4 + r.w * 2.0) + r.z * 20.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float ps = uSize * sz * (0.6 + r.y * 0.8) * projectionMatrix[1][1] * 0.5 * uPx / max(-mv.z, 0.05);
    // sub-pixel sprites fade instead of shimmering
    float fade = clamp(ps / 1.8, 0.2, 1.0);
    gl_PointSize = clamp(ps, 1.8, 48.0);
    vCol = col;
    vA = al * tw * fade * uOpacity;
    gl_Position = projectionMatrix * mv;
  }
`

const FRAG = /* glsl */ `
  varying vec3 vCol;
  varying float vA;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    float core = 1.0 - smoothstep(0.0, 0.5, d);
    float hot = 1.0 - smoothstep(0.0, 0.17, d);
    float a = (core * core * 0.72 + hot * 0.38) * vA;
    if (a <= 0.003) discard;
    gl_FragColor = vec4(vCol * a, 1.0);
  }
`

export interface FlowUniforms {
  [k: string]: THREE.IUniform
  uStage: { value: number }
  uTime: { value: number }
  uSize: { value: number }
  uPx: { value: number }
  uOpacity: { value: number }
  uYaw: { value: number }
  uBeat: { value: number }
  uComet: { value: number }
  uSolid: { value: number }
  uRingR: { value: number }
  uForm: { value: THREE.Vector3[] }
  uProduct: { value: THREE.Vector3 }
  uGlass: { value: THREE.Vector4[] }
  uGlassH: { value: THREE.Vector3[] }
  uPtr: { value: THREE.Vector3 }
  uPtrK: { value: number }
  uLine: { value: THREE.Vector4 }
  uIce: { value: THREE.Color }
  uViolet: { value: THREE.Color }
  uWhite: { value: THREE.Color }
  uPeach: { value: THREE.Color }
  uRose: { value: THREE.Color }
}

export class Flow {
  points: THREE.Points
  u: FlowUniforms
  constructor(data: FlowData) {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(data.chaos, 3))
    g.setAttribute('aS1', new THREE.BufferAttribute(data.wave, 3))
    g.setAttribute('aS2', new THREE.BufferAttribute(data.wire, 3))
    g.setAttribute('aS3', new THREE.BufferAttribute(data.blocks, 3))
    g.setAttribute('aS4', new THREE.BufferAttribute(data.ring, 3))
    g.setAttribute('aS5', new THREE.BufferAttribute(data.stream, 3))
    g.setAttribute('aRand', new THREE.BufferAttribute(data.rand, 4))
    g.setAttribute('aRole', new THREE.BufferAttribute(data.role, 4))
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
    this.u = {
      uStage: { value: 0 },
      uTime: { value: 0 },
      uSize: { value: 0.026 },
      uPx: { value: 900 },
      uOpacity: { value: 1 },
      uYaw: { value: 0 },
      uBeat: { value: 0 },
      uComet: { value: 0 },
      uSolid: { value: 0 },
      uRingR: { value: 1.5 },
      uForm: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) },
      uProduct: { value: new THREE.Vector3() },
      uGlass: { value: [0, 1, 2, 3, 4].map(() => new THREE.Vector4()) },
      uGlassH: { value: [0, 1, 2, 3, 4].map(() => new THREE.Vector3(-1, -1, 0)) },
      uPtr: { value: new THREE.Vector3(1e3, 1e3, 0) },
      uPtrK: { value: 0 },
      uLine: { value: new THREE.Vector4() },
      uIce: { value: new THREE.Color('#88c4ff') },
      uViolet: { value: new THREE.Color('#8b7bff') },
      uWhite: { value: new THREE.Color('#f4f7ff') },
      uPeach: { value: new THREE.Color('#ffb38a') },
      uRose: { value: new THREE.Color('#ff7eb6') },
    }
    const m = new THREE.ShaderMaterial({
      uniforms: this.u,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    })
    this.points = new THREE.Points(g, m)
    this.points.frustumCulled = false
    this.points.renderOrder = 20
  }
}
