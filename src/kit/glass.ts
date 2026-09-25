import * as THREE from 'three'
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'
import { logoParts } from '../logo/logo'

/*
 * Hark Glass kit — one visual language for every chapter.
 *
 *   G                          palette by name (hex strings)
 *   glass(opts)                cached MeshPhysicalMaterial: real transmission,
 *                              thickness, IOR, dispersion (desktop), optional
 *                              frost (roughness), tint (attenuation), iridescence
 *   GLASS.clear / .frost / .tinted(color) / .ice / .smoke   presets
 *   crystal(color, strength)   a glowing crystal core (the mark's diamond; ice-white by default)
 *   glassLogo(opts)            the Hark mark as a thick, bevelled glass object:
 *                              two glass loops + a glowing crystal core. Smooth
 *                              (creased) normals so highlights run clean.
 *   pane(w, h, opts)           rounded glass slab (cards, displays, shields)
 *   smoothExtrude(shapes, o)   extrude + bevel + creased normals (any shape)
 *   etch(text, opts)           frosted/etched text or glyphs on a plane, to sit
 *                              on or inside glass
 *   edgeGlow(color, power)     fresnel rim material (additive) — an outline of
 *                              light for an object's silhouette
 *   caustic(opts)              soft additive light pool for "floors" under glass
 *
 * Rules that make glass read:
 *  - glass needs something behind it to bend: the world light field, a
 *    colourful plane, or text. Put glass in front of colour, not black.
 *  - reflections come from the studio environment (world.params.env /
 *    envTurn). Sweep envTurn to run a highlight across the glass.
 *  - keep glass objects few and big; three's transmission pass renders the
 *    opaque scene once per frame for all of them (glass does not see other
 *    glass — put opaque colour between layers if you need depth).
 *  - dispersion (rainbow edges) is desktop-only; phones get plain refraction.
 */

export const G = {
  ink: '#06071a',
  night: '#0c0f2e',
  indigo: '#1c2166',
  mist: '#c9d6ff',
  white: '#f4f7ff',
  /** the Plexus accents: ice blue (the constellation), violet, and a warm peach counterpoint */
  ice: '#88c4ff',
  violet: '#8b7bff',
  peach: '#ffb38a',
  rose: '#ff7eb6',
  cyan: '#56e0ff',
  ember: '#ff5a5a',
} as const

const mobile = typeof window !== 'undefined' && (matchMedia('(pointer: coarse)').matches || window.innerWidth < 768)

export interface GlassOpts {
  /** tint by absorption (colour deepens with thickness) */
  tint?: THREE.ColorRepresentation
  /** how far light travels before taking the full tint (world units) */
  tintDistance?: number
  /** 0 = clear, 0.2 = satin, 0.5 = frosted */
  frost?: number
  /** optical thickness for refraction (world units) */
  thickness?: number
  ior?: number
  /** rainbow edge split (desktop only) */
  dispersion?: number
  /** thin-film sheen 0..1 */
  iridescence?: number
  /** reflection strength multiplier */
  env?: number
  /** clearcoat for an extra sharp reflection layer */
  coat?: number
  /**
   * sample what's behind at full sharpness (three blurs transmission slightly
   * even at roughness 0): use for glass that must show a screenshot or text
   * crisply through it. Ignored when frost > 0.
   */
  sharp?: boolean
  side?: THREE.Side
}

const cache = new Map<string, THREE.MeshPhysicalMaterial>()

/** Cached physical glass. Same options → same material (share freely). */
export function glass(o: GlassOpts = {}): THREE.MeshPhysicalMaterial {
  const key = JSON.stringify(o)
  const hit = cache.get(key)
  if (hit) return hit
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    metalness: 0,
    roughness: o.frost ?? 0.02,
    transmission: 1,
    thickness: o.thickness ?? 0.6,
    ior: o.ior ?? 1.5,
    specularIntensity: 1,
    specularColor: new THREE.Color(0xffffff),
    // per-object multiplier of world.params.env — only honoured for materials
    // a chapter hands to ctx.world.adopt(group) (see World.adopt); otherwise
    // three uses world.params.env for every glass object
    envMapIntensity: o.env ?? 1,
    clearcoat: o.coat ?? 0,
    clearcoatRoughness: 0.04,
    side: o.side ?? THREE.FrontSide,
  })
  m.dispersion = mobile ? 0 : (o.dispersion ?? 0.35)
  if (o.tint !== undefined) {
    m.attenuationColor = new THREE.Color(o.tint)
    m.attenuationDistance = o.tintDistance ?? 1.2
  }
  if (o.sharp && !o.frost) sharpTransmission(m)
  if (o.iridescence) {
    m.iridescence = o.iridescence
    m.iridescenceIOR = 1.3
    m.iridescenceThicknessRange = [120, 420]
  }
  cache.set(key, m)
  return m
}

const LOD_RE = /float lod = log2\( transmissionSamplerSize\.x \) \* applyIorToRoughness\( roughness, ior \);\s*return textureBicubic\( transmissionSamplerMap, fragCoord\.xy, lod \);/

/** Read the transmission buffer at mip 0 (no roughness blur) — crisp text/images through glass. */
export function sharpTransmission(m: THREE.MeshPhysicalMaterial) {
  const chunk = THREE.ShaderChunk.transmission_pars_fragment
  if (!LOD_RE.test(chunk)) {
    if (import.meta.env.DEV) console.warn('[hark] sharpTransmission: three transmission chunk changed; glass will blur')
    return
  }
  const sharp = chunk.replace(LOD_RE, 'return textureLod( transmissionSamplerMap, fragCoord.xy, 0.0 );')
  m.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <transmission_pars_fragment>', sharp)
  }
  m.customProgramCacheKey = () => 'glass-sharp-transmission'
}

export const GLASS = {
  /** clear and crisp: text / screenshots behind stay sharp */
  sharp: () => glass({ thickness: 0.5, dispersion: 0.2, sharp: true }),
  /** crystal-clear, thick, rainbow edges */
  clear: () => glass({ thickness: 0.9, dispersion: 0.4 }),
  /** satin frosted panel */
  frost: () => glass({ frost: 0.42, thickness: 0.3, dispersion: 0, env: 0.9 }),
  /** light frost: legible things behind, softened */
  satin: () => glass({ frost: 0.18, thickness: 0.4, dispersion: 0.15 }),
  /** faintly green, like thick float glass */
  ice: () => glass({ tint: '#c9ffe6', tintDistance: 2.4, thickness: 1.1, dispersion: 0.3 }),
  /** a coloured glass */
  tinted: (tint: THREE.ColorRepresentation, distance = 0.9) => glass({ tint, tintDistance: distance, thickness: 0.8, dispersion: 0.25 }),
  /** dark smoked glass */
  smoke: () => glass({ tint: '#3a4150', tintDistance: 0.6, thickness: 0.6, frost: 0.05, dispersion: 0.1 }),
  /** thin-film sheen on clear glass */
  opal: () => glass({ thickness: 0.7, dispersion: 0.3, iridescence: 0.8 }),
}

/** A glowing crystal: the mark's diamond, status lights. Ice-white by default (never brand green). */
export function crystal(color: THREE.ColorRepresentation = G.ice, strength = 2.2): THREE.MeshPhysicalMaterial {
  const key = `crystal:${new THREE.Color(color).getHexString()}:${strength}`
  const hit = cache.get(key)
  if (hit) return hit
  const m = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    emissive: new THREE.Color(color),
    emissiveIntensity: strength,
    metalness: 0,
    roughness: 0.08,
    transmission: 0.35,
    thickness: 0.3,
    ior: 1.6,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    envMapIntensity: 1.2,
  })
  cache.set(key, m)
  return m
}

export interface ExtrudeOpts {
  depth?: number
  bevel?: number
  bevelSegments?: number
  curveSegments?: number
  /** normals smoothed across edges flatter than this (radians) */
  crease?: number
}

/** Extrude with a rounded bevel and creased (smooth) normals, centred in z. */
export function smoothExtrude(shapes: THREE.Shape | THREE.Shape[], o: ExtrudeOpts = {}): THREE.BufferGeometry {
  const depth = o.depth ?? 0.2
  const bevel = o.bevel ?? 0.03
  const g = new THREE.ExtrudeGeometry(shapes, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel * 0.85,
    bevelSegments: o.bevelSegments ?? (mobile ? 3 : 5),
    curveSegments: o.curveSegments ?? 24,
    steps: 1,
  })
  g.translate(0, 0, -depth / 2)
  const out = toCreasedNormals(g, o.crease ?? Math.PI / 5)
  g.dispose()
  out.computeBoundingBox()
  out.computeBoundingSphere()
  return out
}

export interface GlassLogo {
  root: THREE.Group
  loopA: THREE.Mesh
  loopB: THREE.Mesh
  core: THREE.Mesh
  /** a soft point light inside the core (green glow cast on nearby glass) */
  glow: THREE.PointLight
}

/**
 * The Hark mark in glass: two thick glass loops and the diamond as a glowing
 * crystal core. 1 unit tall, centred, facing +z. Animate the parts freely.
 */
export function glassLogo(o: { depth?: number; material?: THREE.Material; coreStrength?: number; coreColor?: THREE.ColorRepresentation; light?: boolean } = {}): GlassLogo {
  const parts = logoParts()
  const depth = o.depth ?? 0.24
  const mat = o.material ?? GLASS.clear()
  const loopA = new THREE.Mesh(smoothExtrude(parts.loopA, { depth, bevel: 0.035 }), mat)
  const loopB = new THREE.Mesh(smoothExtrude(parts.loopB, { depth, bevel: 0.035 }), mat)
  const core = new THREE.Mesh(smoothExtrude(parts.diamond, { depth: depth * 0.9, bevel: 0.02, crease: 0.2 }), crystal(o.coreColor ?? G.ice, o.coreStrength ?? 2.2))
  const root = new THREE.Group()
  root.add(loopA, loopB, core)
  const glow = new THREE.PointLight(o.coreColor ?? G.ice, o.light === false ? 0 : 1.2, 2.2, 2)
  root.add(glow)
  return { root, loopA, loopB, core, glow }
}

/** Rounded-rectangle glass slab, w x h, centred, facing +z. */
export function pane(
  w: number,
  h: number,
  o: { radius?: number; depth?: number; bevel?: number; material?: THREE.Material } = {},
): THREE.Mesh {
  const r = Math.min(o.radius ?? Math.min(w, h) * 0.08, w / 2, h / 2)
  const s = new THREE.Shape()
  const x = -w / 2
  const y = -h / 2
  s.moveTo(x + r, y)
  s.lineTo(x + w - r, y)
  s.quadraticCurveTo(x + w, y, x + w, y + r)
  s.lineTo(x + w, y + h - r)
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  s.lineTo(x + r, y + h)
  s.quadraticCurveTo(x, y + h, x, y + h - r)
  s.lineTo(x, y + r)
  s.quadraticCurveTo(x, y, x + r, y)
  const bevel = o.bevel ?? Math.min(0.04, (o.depth ?? 0.08) * 0.45)
  return new THREE.Mesh(smoothExtrude(s, { depth: o.depth ?? 0.08, bevel, curveSegments: 10 }), o.material ?? GLASS.clear())
}

/**
 * Etched / frosted text on a plane (canvas texture). Put it just inside or
 * behind a glass face; `glow` > 1 makes it an emissive light line that blooms.
 * Returns a mesh `height` world units tall, width from the text.
 */
export function etch(
  text: string,
  o: { height?: number; font?: string; weight?: number; color?: THREE.ColorRepresentation; glow?: number; opacity?: number; letterSpacing?: number } = {},
): THREE.Mesh {
  const px = 128
  const font = `${o.weight ?? 500} ${px}px ${o.font ?? "'Geist Variable', 'Geist', system-ui, sans-serif"}`
  const cv = document.createElement('canvas')
  const g = cv.getContext('2d')!
  g.font = font
  const ls = (o.letterSpacing ?? 0) * px
  const w = Math.ceil(g.measureText(text).width + ls * Math.max(0, text.length - 1)) + 16
  const h = Math.ceil(px * 1.3)
  cv.width = w
  cv.height = h
  const draw = () => {
    g.clearRect(0, 0, w, h)
    g.font = font
    g.textBaseline = 'middle'
    g.fillStyle = '#ffffff'
    if (ls) {
      let cx = 8
      for (const ch of text) {
        g.fillText(ch, cx, h / 2)
        cx += g.measureText(ch).width + ls
      }
    } else g.fillText(text, 8, h / 2)
  }
  draw()
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  document.fonts?.ready.then(() => {
    draw()
    tex.needsUpdate = true
  })
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    color: new THREE.Color(o.color ?? G.white).multiplyScalar(o.glow ?? 1),
    transparent: true,
    opacity: o.opacity ?? 0.85,
    depthWrite: false,
    toneMapped: (o.glow ?? 1) <= 1,
  })
  const height = o.height ?? 0.2
  return new THREE.Mesh(new THREE.PlaneGeometry((height * w) / h, height), mat)
}

/** Fresnel rim: add as a slightly larger / same-geometry mesh for a light outline. */
export function edgeGlow(color: THREE.ColorRepresentation = G.ice, power = 2.5, strength = 1.2): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    uniforms: { uColor: { value: new THREE.Color(color) }, uPower: { value: power }, uStrength: { value: strength } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uPower, uStrength;
      varying vec3 vN; varying vec3 vV;
      void main() {
        float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float r = f * f * f;                 // no pow() on a possibly-negative base
        r = mix(r, f * f * f * f, clamp(uPower - 3.0, 0.0, 1.0));
        gl_FragColor = vec4(uColor * r * uStrength, 1.0);
      }
    `,
  })
}

/** Soft additive light pool (a caustic-like glow on a floor or wall plane). */
export function caustic(o: { size?: number; color?: THREE.ColorRepresentation; strength?: number } = {}): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    uniforms: { uColor: { value: new THREE.Color(o.color ?? G.ice) }, uStrength: { value: o.strength ?? 0.8 }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uStrength, uTime; varying vec2 vUv;
      void main() {
        vec2 p = vUv - 0.5;
        float r = length(p) * 2.0;
        float pool = exp(-r * r * 3.0);
        float ripple = 0.75 + 0.25 * sin(r * 22.0 - uTime * 1.5) * sin(atan(p.y, p.x + 1e-4) * 5.0 + uTime * 0.7);
        gl_FragColor = vec4(uColor * pool * ripple * uStrength, 1.0);
      }
    `,
  })
  const m = new THREE.Mesh(new THREE.PlaneGeometry(o.size ?? 3, o.size ?? 3), mat)
  m.rotation.x = -Math.PI / 2
  return m
}
