import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'

/*
 * Post-processing for Hark Plexus: Render → Sanitize (NaN guard) → Bloom →
 * Output → FINAL.
 *
 * FINAL is a clean lens (faint aberration, vignette, fine grain, flash, fade)
 * plus two effects:
 *  - FROST (params.frost 0..1): the frame seen through frosted glass — a
 *    grainy spiral blur with a pale sheen (depth / focus moments).
 *  - THE PARTICLE CUT: approaching a chapter boundary the image breaks into a
 *    field of glowing dots (each dot takes the colour of the image under it),
 *    the dots shrink and drift apart, and at the boundary only a faint
 *    glitter remains (hiding the swap); after it, the next chapter's dots
 *    gather and fuse back into the picture. uCutSide says which half.
 *
 * Keep the Post API (params / resetParams / setSize / render / compileAsync /
 * setFadeTone / cutSide) and the uTransition / uFade / uFlash / uGlitch
 * uniforms — the engine drives them.
 */

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uDpr: { value: 1 },
    uTransition: { value: 0 },
    uCutSide: { value: 1 },
    uGlitch: { value: 0 },
    uAberration: { value: 0.0012 },
    uGrain: { value: 0.022 },
    uVignette: { value: 0.3 },
    uFlash: { value: 0 },
    uFade: { value: 0 },
    uFrost: { value: 0 },
    uTint: { value: new THREE.Color('#dfe7ff') },
    uFadeColor: { value: new THREE.Color('#080a22') },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uDpr, uTransition, uCutSide, uGlitch, uAberration, uGrain, uVignette, uFlash, uFade, uFrost;
    uniform vec2 uResolution;
    uniform vec3 uTint, uFadeColor;
    varying vec2 vUv;

    float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    vec2 hash2(vec2 p) { return vec2(hash(p), hash(p + 19.19)); }

    vec3 frosted(vec2 uv, float radiusPx) {
      vec2 px = 1.0 / uResolution;
      float a0 = hash(gl_FragCoord.xy) * 6.2831853;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < 14; i++) {
        float fi = float(i);
        float r = sqrt((fi + 0.5) / 14.0) * radiusPx;
        float a = a0 + fi * 2.3999632;
        acc += texture2D(tDiffuse, uv + vec2(cos(a), sin(a)) * r * px).rgb;
      }
      return acc / 14.0;
    }

    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float g = clamp(uGlitch, 0.0, 1.0);
      uv += g * 0.005 * vec2(sin(uv.y * 40.0 + uTime * 6.0), cos(uv.x * 33.0 - uTime * 5.0));

      vec3 col;
      col.r = texture2D(tDiffuse, uv + c * uAberration).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - c * uAberration).b;

      float fr = clamp(uFrost, 0.0, 1.0);
      float t = clamp(uTransition, 0.0, 1.0);
      if (fr > 0.002 && t < 0.5) {
        vec3 f = frosted(uv, 26.0 * uDpr * fr * 1.4);
        f = mix(f, uTint, 0.1 * fr) + 0.03 * fr;
        col = mix(col, f, smoothstep(0.0, 0.35, fr));
      }

      // ---- THE PARTICLE CUT
      if (t > 0.001) {
        vec2 css = gl_FragCoord.xy / uDpr;
        float S = 9.0;                                   // dot pitch (CSS px)
        vec2 cell = floor(css / S);
        vec2 h = hash2(cell);
        float e = t * t * (3.0 - 2.0 * t);
        // dots drift apart (outward from the centre + their own direction), less after the boundary
        vec2 fromC = (cell * S / (uResolution / uDpr)) - 0.5;
        vec2 drift = (normalize(fromC + 1e-4) * 0.6 + (h - 0.5) * 1.4) * S * 0.45 * e;
        vec2 centre = (cell + 0.5 + (h - 0.5) * 0.25) * S + drift * (uCutSide < 0.0 ? 1.0 : 0.6);
        vec2 suv = (centre - drift) * uDpr / uResolution;   // the dot keeps the colour of where it came from
        vec3 dc = texture2D(tDiffuse, clamp(suv, 0.0, 1.0)).rgb;
        float d = length(css - centre);
        float r = S * 0.55 * (1.0 - e * 0.82);
        float dot1 = 1.0 - smoothstep(r * 0.55, r, d);
        // survivors: as t -> 1 most dots go out, a glitter remains
        float alive = step(e * 0.93, h.x);
        float tw = 0.75 + 0.25 * sin(uTime * 9.0 + h.y * 30.0);
        vec3 dots = dc * (1.25 + e * 1.4) * dot1 * mix(1.0, alive * tw, smoothstep(0.35, 0.9, e));
        dots += vec3(0.8, 0.88, 1.0) * dot1 * alive * 0.05 * e;
        col = mix(col, dots + uFadeColor * (1.0 - dot1) * 0.9, smoothstep(0.0, 0.3, t));
      }

      col = mix(col, vec3(1.0), clamp(uFlash, 0.0, 1.0));
      float v = 1.0 - smoothstep(0.35, 1.05, length(c * vec2(1.0, 0.9)) * 1.4);
      col *= mix(1.0, 0.6 + 0.4 * v, uVignette);
      col += (hash(vUv * uResolution + fract(uTime * 7.13) * 91.0) - 0.5) * uGrain;
      col = mix(col, uFadeColor, clamp(uFade, 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);
    }
  `,
}

/** minimum seconds between two white-flash onsets (WCAG 2.3.1) */
const FLASH_GAP = 0.4

export type PostParams = {
  bloomStrength: number
  bloomRadius: number
  bloomThreshold: number
  aberration: number
  grain: number
  vignette: number
  /** wobble 0..1 */
  glitch: number
  /** white wash 0..1 */
  flash: number
  exposure: number
  /** whole-frame frosted glass 0..1 */
  frost: number
}

/** Bloom only catches HDR (> ~1.0): emissive lamps, LEDs, speculars. */
export const POST_DEFAULTS: PostParams = {
  bloomStrength: 0.5,
  bloomRadius: 0.5,
  bloomThreshold: 0.95,
  aberration: 0.0012,
  grain: 0.022,
  vignette: 0.3,
  glitch: 0,
  flash: 0,
  exposure: 1,
  frost: 0,
}

/**
 * Scrubs NaN/Inf and clamps runaway HDR right after the scene render. A single
 * bad fragment would otherwise smear across the whole frame through bloom.
 */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      if (any(isnan(c)) || any(isinf(c))) c = vec4(0.0, 0.0, 0.0, 1.0);
      gl_FragColor = vec4(clamp(c.rgb, 0.0, 64.0), c.a);
    }
  `,
}

export class Post {
  composer: EffectComposer
  bloom: UnrealBloomPass
  final: ShaderPass
  /**
   * Chapters write targets here every frame (the engine resets them to
   * defaults first); values are damped so nothing pops at a cut.
   */
  params: PostParams = { ...POST_DEFAULTS }
  private current: PostParams = { ...POST_DEFAULTS }
  transition = 0
  /** -1 while approaching a chapter boundary, +1 after it (engine-driven) */
  cutSide = 1
  fade = 0
  private lastFlashAt = -1e9
  private flashLive = false
  private flashOk = true

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    /** skip MSAA (retina / mobile: already supersampled; MSAA half-float targets are huge) */
    noMsaa: boolean,
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: noMsaa ? 0 : 4,
    })
    this.composer = new EffectComposer(renderer, rt)
    this.composer.addPass(new RenderPass(scene, camera))
    this.composer.addPass(new ShaderPass(SanitizeShader))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.45, 0.4, 1.0)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())
    this.final = new ShaderPass(FinalShader)
    this.composer.addPass(this.final)
  }

  /** Colour behind the dots at the cut and of the reduced-motion fade. */
  setCutColor(color: THREE.ColorRepresentation) {
    ;(this.final.uniforms.uFadeColor.value as THREE.Color).set(color)
  }

  /** Engine hook (kept for compatibility; themes may tint the fade by scene tone). */
  setFadeTone(_tone: number) {}

  resetParams() {
    Object.assign(this.params, POST_DEFAULTS)
  }

  /**
   * Compile every post-processing shader in parallel so the first composer
   * render doesn't block on synchronous links.
   */
  compileAsync(): Promise<unknown> {
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2))
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const b = this.bloom as unknown as Record<string, unknown>
    const mats: THREE.Material[] = []
    const add = (m: unknown) => {
      if (m && (m as THREE.Material).isMaterial) mats.push(m as THREE.Material)
    }
    for (const pass of this.composer.passes) add((pass as unknown as { material?: unknown }).material)
    for (const m of (b.separableBlurMaterials as unknown[]) ?? []) add(m)
    add(b.compositeMaterial)
    add(b.blendMaterial)
    add(b.materialHighPassFilter)
    add(b.copyMaterial)
    return Promise.all(mats.map(m => this.renderer.compileAsync(new THREE.Mesh(quad.geometry, m), cam).catch(() => {})))
  }

  setSize(w: number, h: number, dpr: number) {
    this.composer.setPixelRatio(dpr)
    this.composer.setSize(w, h)
    this.bloom.resolution.set((w * dpr) / 2, (h * dpr) / 2)
    this.final.uniforms.uResolution.value.set(w * dpr, h * dpr)
    this.final.uniforms.uDpr.value = dpr
  }

  render(dt: number, time: number) {
    const k = 1 - Math.exp(-6 * dt)
    const c = this.current
    const p = this.params
    for (const key of Object.keys(p) as (keyof PostParams)[]) {
      // flash & glitch respond instantly so chapters can punch them
      c[key] = key === 'flash' || key === 'glitch' ? p[key] : c[key] + (p[key] - c[key]) * k
    }
    // flash budget (WCAG 2.3.1): a flash starting within FLASH_GAP of the last is dropped
    if (c.flash > 0.02) {
      if (!this.flashLive) {
        this.flashLive = true
        this.flashOk = time - this.lastFlashAt >= FLASH_GAP
        if (this.flashOk) this.lastFlashAt = time
      }
      if (!this.flashOk) c.flash = 0
    } else this.flashLive = false
    this.bloom.strength = c.bloomStrength
    this.bloom.radius = c.bloomRadius
    this.bloom.threshold = c.bloomThreshold
    this.renderer.toneMappingExposure = c.exposure
    const u = this.final.uniforms
    u.uTime.value = time
    u.uTransition.value = this.transition
    u.uGlitch.value = c.glitch
    u.uAberration.value = c.aberration
    u.uGrain.value = c.grain
    u.uVignette.value = c.vignette
    u.uFlash.value = c.flash
    u.uFrost.value = c.frost
    u.uCutSide.value = this.cutSide
    u.uFade.value = this.fade
    this.composer.render(dt)
  }
}
