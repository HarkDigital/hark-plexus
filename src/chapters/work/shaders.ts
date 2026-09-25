/*
 * GLSL for the Constellation (work) set. Every particle / line material here
 * is drawn in the OPAQUE pass with additive blending (transparent: false,
 * depthWrite: false): three's transmission pass captures opaque objects, so
 * the glass tiles refract the links, the flowing signal and the stars behind
 * them, not only the world's backdrop network.
 *
 * Shared vertex helpers:
 *   repel(clip)  pushes a clip-space position away from the pointer in
 *                screen space (the particles.js 'repulse' mode); uPtrK = 0
 *                on touch devices, under reduced motion and with Motion off.
 *   worldSize()  world-unit sprite sizes (sprites scale with distance).
 *
 * GLSL safety: no pow() on a possibly-negative base, ascending smoothstep
 * edges only, constant loop bounds, no derivatives.
 */

/** Max link count (uniform array size for per-edge glow / phase / draw-on). */
export const MAX_EDGES = 28
/** The nine small stars. */
export const MAX_STARS = 9

const REPEL = /* glsl */ `
  uniform vec2 uPtr;
  uniform float uPtrK;
  uniform float uAspect;
  vec4 repel(vec4 clip) {
    if (uPtrK < 0.001 || clip.w < 0.05) return clip;
    vec2 ndc = clip.xy / clip.w;
    vec2 d = (ndc - uPtr) * vec2(uAspect, 1.0);
    float r = length(d);
    float k = uPtrK * (1.0 - smoothstep(0.0, 0.26, r));
    vec2 dir = d / max(r, 1e-4);
    ndc += dir / vec2(uAspect, 1.0) * k * 0.075;
    clip.xy = ndc * clip.w;
    return clip;
  }
  float worldSize(float size, vec4 mv, float px) {
    return size * projectionMatrix[1][1] * 0.5 * px / max(-mv.z, 0.05);
  }
`

/* ------------------------------------------------------------------ links */

export const LINK_VERT = /* glsl */ `
  /* x: side (-1 / +1), y: end (0 = A, 1 = B), z: edge index */
  attribute vec3 aInfo;
  uniform vec3 uA[${MAX_EDGES}];
  uniform vec3 uB[${MAX_EDGES}];
  /* x: glow, y: draw-on (0..1), z: flow phase (0..1) */
  uniform vec4 uEdge[${MAX_EDGES}];
  uniform vec2 uRes;
  uniform float uWidth;
  varying float vSide;
  varying float vS;
  varying float vGlow;
  varying float vDraw;
  void main() {
    int e = int(aInfo.z + 0.5);
    vGlow = uEdge[e].x;
    vDraw = uEdge[e].y;
    vSide = aInfo.x;
    vec4 va = modelViewMatrix * vec4(uA[e], 1.0);
    vec4 vb = modelViewMatrix * vec4(uB[e], 1.0);
    const float nearZ = -0.12;
    float sa = 0.0;
    float sb = 1.0;
    if (va.z > nearZ && vb.z > nearZ) {
      vS = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    // clip the segment to the near plane so it never projects through the camera
    if (va.z > nearZ) {
      float t = (nearZ - va.z) / (vb.z - va.z);
      va = mix(va, vb, t);
      sa = t;
    } else if (vb.z > nearZ) {
      float t = (nearZ - vb.z) / (va.z - vb.z);
      vb = mix(vb, va, t);
      sb = 1.0 - t;
    }
    vec4 ca = projectionMatrix * va;
    vec4 cb = projectionMatrix * vb;
    vec2 na = ca.xy / ca.w;
    vec2 nb = cb.xy / cb.w;
    float aspect = uRes.x / max(uRes.y, 1.0);
    vec2 dir = (nb - na) * vec2(aspect, 1.0);
    float L = length(dir);
    dir = L > 1e-6 ? dir / L : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    vec4 c = aInfo.y > 0.5 ? cb : ca;
    c.xy += nrm / vec2(aspect, 1.0) * (uWidth / max(uRes.y, 1.0) * 2.0) * aInfo.x * c.w;
    vS = aInfo.y > 0.5 ? sb : sa;
    gl_Position = c;
  }
`

export const LINK_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform float uOpacity;
  varying float vSide;
  varying float vS;
  varying float vGlow;
  varying float vDraw;
  void main() {
    // a thin particles.js line (line_linked): the flowing dots carry the light
    float d = abs(vSide);
    float core = 1.0 - smoothstep(0.2, 0.75, d);
    float halo = 1.0 - smoothstep(0.0, 1.0, d);
    halo *= halo;
    float ends = smoothstep(0.0, 0.05, vS) * (1.0 - smoothstep(0.95, 1.0, vS));
    float drawn = 1.0 - smoothstep(vDraw, vDraw + 0.03, vS);
    float g = vGlow;
    vec3 col = mix(uColor, uHot, clamp(g - 0.8, 0.0, 1.0));
    float a = (core * 0.5 + halo * 0.12) * (0.35 + 0.65 * g) * g * ends * drawn * uOpacity;
    if (a < 0.002) discard;
    gl_FragColor = vec4(col * a, 1.0);
  }
`

/* ------------------------------------------------------- flowing signal */

export const FLOW_VERT = /* glsl */ `
  ${REPEL}
  /* x: phase offset, y: size / stagger, z, w: lateral jitter */
  attribute vec4 aRand;
  /* x: edge index, y: tail index (0 = head) */
  attribute vec2 aInfo;
  uniform vec3 uA[${MAX_EDGES}];
  uniform vec3 uB[${MAX_EDGES}];
  uniform vec4 uEdge[${MAX_EDGES}];
  uniform float uTime;
  uniform float uSize;
  uniform float uPx;
  uniform float uMaxPx;
  uniform float uGather;
  uniform float uTail;
  varying float vA;
  varying float vHead;
  void main() {
    int e = int(aInfo.x + 0.5);
    vec4 ed = uEdge[e];
    vec3 A = uA[e];
    vec3 ab = uB[e] - A;
    float len = max(length(ab), 0.1);
    float s = fract(aRand.x + ed.z);
    float st = s - aInfo.y * uTail / len;
    vec3 p = A + ab * st;
    vec3 s1 = normalize(cross(ab, vec3(0.31, 1.0, 0.17)));
    vec3 s2 = normalize(cross(ab, s1));
    float wob = sin(uTime * 1.1 + aRand.w * 31.0) * 0.008;
    p += s1 * ((aRand.z - 0.5) * 0.045 + wob) + s2 * (aRand.w - 0.5) * 0.045;
    // intro: a loose cloud swirls in and condenses onto the links (chaos -> order)
    float g = clamp((uGather - aRand.y * 0.4) / 0.6, 0.0, 1.0);
    g = g * g * (3.0 - 2.0 * g);
    vec3 scatter = p + (aRand.zwx - 0.5) * vec3(5.0, 3.2, 3.0);
    float fly = 4.0 * g * (1.0 - g);
    float an = aRand.x * 6.2831 + uTime * 0.5;
    p = mix(scatter, p, g) + vec3(sin(an), cos(an * 1.3), sin(an * 0.7)) * fly * 0.45;
    // not drawn past the link's own draw-on front
    float drawn = 1.0 - smoothstep(ed.y, ed.y + 0.03, st);
    float ends = smoothstep(0.0, 0.06, st) * (1.0 - smoothstep(0.93, 1.0, st));
    float tail = 1.0 - aInfo.y * 0.32;
    vA = ends * tail * ed.x * drawn * (0.25 + 0.75 * g);
    vHead = 1.0 - min(aInfo.y, 1.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = clamp(worldSize(uSize * (1.0 - aInfo.y * 0.22) * (0.7 + 0.6 * aRand.y), mv, uPx), 1.0, uMaxPx);
    gl_Position = repel(projectionMatrix * mv);
  }
`

export const DOT_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform float uOpacity;
  varying float vA;
  varying float vHead;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    float core = 1.0 - smoothstep(0.0, 1.0, d);
    float a = core * core * vA * uOpacity;
    if (a < 0.003) discard;
    gl_FragColor = vec4(mix(uColor, uHot, vHead * 0.6) * a, 1.0);
  }
`

/* -------------------------------------------------------- the nine stars */

/**
 * Each of the nine stars is a small particles.js constellation of its own: a
 * bright core (node 0, still) and a handful of nodes drifting around it, and
 * every pair of nodes closer than a link distance is joined by a thin line
 * whose opacity falls with distance (particles.js line_linked). The points
 * and the lines share this one node function, so a line always meets its dots.
 *   h.xyz: the node's home in a unit disc (0 for the core), h.w: phase 0..1
 */
const STAR_NODE = /* glsl */ `
  vec3 starNode(vec4 h, float t, float lit) {
    float live = step(0.001, dot(h.xyz, h.xyz));
    float R = 0.34 * (1.0 + 0.6 * lit);
    float ph = h.w * 6.2831;
    float ang = t * 0.06 + h.w * 0.4;
    float ca = cos(ang);
    float sa = sin(ang);
    vec3 home = vec3(h.x * ca - h.y * sa, h.x * sa + h.y * ca, h.z) * R;
    vec3 drift = vec3(sin(t * 0.41 + ph), cos(t * 0.33 + ph * 1.7), sin(t * 0.29 + ph * 2.3)) * (0.2 * R);
    return (home + drift) * live;
  }
  float starLinkDist(float lit) {
    return 0.36 * (1.0 + 0.6 * lit);
  }
`

export const STAR_VERT = /* glsl */ `
  ${REPEL}
  ${STAR_NODE}
  /* a node's home (kind 0), or the ring particle's offsets (kind 2) */
  attribute vec3 aOff;
  /* x: speed, y: size, z: phase, w: hue */
  attribute vec4 aRand;
  /* x: star index, y: kind (0 = node, 1 = core, 2 = orbit ring) */
  attribute vec2 aInfo;
  uniform vec3 uStarPos[${MAX_STARS}];
  uniform float uLit[${MAX_STARS}];
  uniform float uRing[${MAX_STARS}];
  uniform float uTime;
  uniform float uSize;
  uniform float uPx;
  uniform float uFade;
  uniform float uMaxPx;
  varying float vA;
  varying float vCore;
  varying float vHue;
  varying float vNode;
  void main() {
    int i = int(aInfo.x + 0.5);
    float lit = uLit[i];
    vec3 centre = uStarPos[i];
    vec3 p;
    float tw = 0.6 + 0.4 * sin(uTime * (1.2 + aRand.y * 2.2) + aRand.z * 40.0);
    float sz;
    vNode = 0.0;
    if (aInfo.y > 1.5) {
      // an orbit ring (the Orbits look): a tilted ellipse of particles circling the chosen star
      float ring = uRing[i];
      float ang = aRand.z * 6.2831 + uTime * (0.5 + aRand.x * 0.25);
      float rad = (0.68 + 0.07 * aOff.x) * (0.55 + 0.45 * ring) * (1.0 + 0.35 * lit);
      vec3 q = vec3(cos(ang) * rad, sin(ang) * rad * 0.34, sin(ang) * rad * 0.2);
      float tilt = 0.45 + aOff.y * 0.25;
      p = centre + vec3(q.x * cos(tilt) - q.y * sin(tilt), q.x * sin(tilt) + q.y * cos(tilt), q.z);
      vA = uFade * ring * (0.55 + 0.45 * tw);
      sz = uSize * (0.75 + 0.6 * aRand.y);
      vCore = 0.0;
    } else if (aInfo.y > 0.5) {
      // the core: the star itself, with a four-point glint
      p = centre;
      vCore = 1.0;
      vA = uFade * (0.75 + 0.9 * lit) * (0.88 + 0.12 * tw);
      sz = uSize * (3.6 + 2.4 * lit);
    } else {
      // a node of the star's own little constellation
      p = centre + starNode(vec4(aOff, aRand.z), uTime, lit);
      vCore = 0.0;
      vNode = 1.0;
      vA = uFade * (0.8 + 0.4 * min(lit, 1.2)) * (0.82 + 0.18 * tw);
      sz = uSize * (1.5 + 0.6 * aRand.y) * (1.0 + 0.25 * lit);
    }
    vHue = aRand.w;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = clamp(worldSize(sz, mv, uPx), vNode > 0.5 ? 3.0 : 1.5, vCore > 0.5 ? uMaxPx * 4.0 : uMaxPx);
    gl_Position = repel(projectionMatrix * mv);
  }
`

export const STAR_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uAlt;
  varying float vA;
  varying float vCore;
  varying float vHue;
  varying float vNode;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    float soft = 1.0 - smoothstep(0.0, 1.0, d);
    float a = soft * soft;
    // a node is a crisp particles.js dot with a faint glow
    float disc = 1.0 - smoothstep(0.42, 0.62, d);
    a = mix(a, disc * 0.9 + a * 0.35, vNode);
    // the core carries a small four-point glint
    float glint = (1.0 - smoothstep(0.0, 0.07, abs(c.x))) * (1.0 - smoothstep(0.1, 0.5, abs(c.y)))
                + (1.0 - smoothstep(0.0, 0.07, abs(c.y))) * (1.0 - smoothstep(0.1, 0.5, abs(c.x)));
    float hot = 1.0 - smoothstep(0.0, 0.22, d);
    a = mix(a, a * 0.55 + glint * 0.5 + hot * 0.9, vCore);
    a *= vA;
    if (a < 0.003) discard;
    vec3 col = mix(uColor, uAlt, step(0.72, vHue) * (1.0 - vCore));
    col = mix(col, vec3(1.0), vCore * hot);
    gl_FragColor = vec4(col * a, 1.0);
  }
`

/**
 * The thin lines of each star's constellation: one screen-space ribbon per
 * node pair, faded by the pair's distance (culled when out of range), pushed
 * by the pointer with the same repel() as the dots.
 */
export const STAR_LINK_VERT = /* glsl */ `
  ${REPEL}
  ${STAR_NODE}
  /* the two nodes (home xyz, phase) */
  attribute vec4 aA;
  attribute vec4 aB;
  /* x: star index, y: side (-1 / +1), z: end (0 = A, 1 = B) */
  attribute vec3 aInfo;
  uniform vec3 uStarPos[${MAX_STARS}];
  uniform float uLit[${MAX_STARS}];
  uniform float uTime;
  uniform float uFade;
  uniform vec2 uRes;
  uniform float uWidth;
  varying float vSide;
  varying float vA;
  void main() {
    int i = int(aInfo.x + 0.5);
    float lit = uLit[i];
    vec3 centre = uStarPos[i];
    vec3 pa = centre + starNode(aA, uTime, lit);
    vec3 pb = centre + starNode(aB, uTime, lit);
    float k = clamp(1.0 - distance(pa, pb) / starLinkDist(lit), 0.0, 1.0);
    vA = k * uFade * (0.55 + 0.5 * min(lit, 1.2));
    vSide = aInfo.y;
    vec4 ca = repel(projectionMatrix * modelViewMatrix * vec4(pa, 1.0));
    vec4 cb = repel(projectionMatrix * modelViewMatrix * vec4(pb, 1.0));
    if (vA < 0.004 || ca.w < 0.05 || cb.w < 0.05) {
      vA = 0.0;
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    vec2 na = ca.xy / ca.w;
    vec2 nb = cb.xy / cb.w;
    float aspect = uRes.x / max(uRes.y, 1.0);
    vec2 dir = (nb - na) * vec2(aspect, 1.0);
    float L = length(dir);
    dir = L > 1e-6 ? dir / L : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    vec4 c = aInfo.z > 0.5 ? cb : ca;
    c.xy += nrm / vec2(aspect, 1.0) * (uWidth / max(uRes.y, 1.0) * 2.0) * aInfo.y * c.w;
    gl_Position = c;
  }
`

export const STAR_LINK_FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying float vSide;
  varying float vA;
  void main() {
    float d = abs(vSide);
    float a = (1.0 - smoothstep(0.25, 1.0, d)) * vA;
    if (a < 0.002) discard;
    gl_FragColor = vec4(uColor * a, 1.0);
  }
`

/* ------------------------------------------------- a tile's screenshot */

/**
 * The screenshot sits ON the tile's front face (crisp at any transmission
 * scale). It fades by opacity, never by darkening, so a tile in the
 * background reads as glass, not as a dark slab; a soft diagonal sheen runs
 * across it as the studio light sweeps the tile, and the top edge carries a
 * faint lift, so it reads as the face of the glass.
 */
export const SHOT_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const SHOT_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uBright;
  uniform float uOpacity;
  uniform float uSheen;
  uniform float uSheenK;
  varying vec2 vUv;
  void main() {
    vec3 col = texture2D(uMap, vUv).rgb * uBright;
    float diag = vUv.x * 0.72 + (1.0 - vUv.y) * 0.28;
    float b = (diag - uSheen) / 0.13;
    float band = exp(-b * b) * uSheenK;
    float top = smoothstep(0.86, 1.0, vUv.y) * 0.05;
    col += vec3(0.86, 0.93, 1.0) * (band + top);
    gl_FragColor = vec4(col, uOpacity);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

/* ------------------------------------------ backlight halo behind a tile */

export const HALO_VERT = /* glsl */ `
  varying vec2 vP;
  uniform vec2 uPlane;
  void main() {
    vP = (uv - 0.5) * uPlane;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

export const HALO_FRAG = /* glsl */ `
  uniform vec2 uPlane;
  uniform vec3 uColor;
  uniform float uStrength;
  uniform vec2 uHalf;
  uniform float uRadius;
  varying vec2 vP;
  void main() {
    vec2 q = abs(vP) - uHalf + uRadius;
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
    float o = max(d, 0.0);
    float g = exp(-o * 5.5) * 0.55 + exp(-o * 18.0) * 0.45;
    // keep the plane's own edge invisible
    vec2 e = abs(vP) / (uPlane * 0.5);
    g *= 1.0 - smoothstep(0.7, 1.0, max(e.x, e.y));
    float a = g * uStrength;
    if (a < 0.002) discard;
    gl_FragColor = vec4(uColor * a, 1.0);
  }
`
