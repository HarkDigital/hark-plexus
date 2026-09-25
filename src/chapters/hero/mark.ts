import * as THREE from 'three'
import { G, crystal, glass, glassLogo, type GlassLogo } from '../../kit/glass'

/*
 * THE GLASS MARK — glassLogo() dressed for Plexus:
 *
 *   loops     clear, thick crystal glass with a faint ice absorption, rainbow
 *             dispersion (desktop) and a clearcoat; they refract the network
 *             and the particles behind them
 *   walls     each loop's far wall: its own geometry, back faces only, as an
 *             additive studio sheen in the opaque list (reaches the glass
 *             buffer, so a loop shows depth without double-sided glass)
 *   rims      a whisper of fresnel light on the grazing edges
 *   core      an OPAQUE ice crystal (the loops refract it; a transmissive core
 *             would vanish behind them), brightest at its heart
 *
 * Every part is clipped by one plane — the crystallization front. Keep points
 * with dot(p, dir) <= front; move the plane far away once the sweep is done
 * (never remove it: the program variant would change mid-scroll).
 */

export interface GlassMark {
  pivot: THREE.Group
  logo: GlassLogo
  plane: THREE.Plane
  loopMat: THREE.MeshPhysicalMaterial
  coreMat: THREE.MeshPhysicalMaterial
  wallMat: THREE.MeshStandardMaterial
  rimMat: THREE.ShaderMaterial
  /** the core's centre in mark units (mark is 1 tall before scaling) */
  coreCentre: THREE.Vector3
}

function rimMaterial(color: THREE.ColorRepresentation, strength: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    clipping: true,
    uniforms: { uColor: { value: new THREE.Color(color) }, uStrength: { value: strength } },
    vertexShader: /* glsl */ `
      #include <clipping_planes_pars_vertex>
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mvPosition.xyz);
        gl_Position = projectionMatrix * mvPosition;
        #include <clipping_planes_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <clipping_planes_pars_fragment>
      uniform vec3 uColor; uniform float uStrength;
      varying vec3 vN; varying vec3 vV;
      void main() {
        #include <clipping_planes_fragment>
        float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float r = f * f * f;
        gl_FragColor = vec4(uColor * r * uStrength, 1.0);
      }
    `,
  })
}

export function buildGlassMark(mobile: boolean): GlassMark {
  const plane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), -1e4)
  const clip = [plane]

  const loopMat = glass({ thickness: 0.5, ior: 1.5, dispersion: 0.6, coat: 0.45, tint: '#d8e8ff', tintDistance: 2.8 }).clone()
  loopMat.dispersion = mobile ? 0 : 0.6
  loopMat.clippingPlanes = clip
  const logo = glassLogo({ depth: 0.27, material: loopMat, coreColor: G.ice, coreStrength: 2.2 })

  // an OPAQUE ice crystal: the loops refract it
  const coreMat = crystal(G.ice, 2.2).clone()
  coreMat.transmission = 0
  coreMat.roughness = 0.06
  coreMat.clippingPlanes = clip
  logo.core.material = coreMat
  logo.core.geometry.computeBoundingBox()
  const cb = logo.core.geometry.boundingBox!
  const coreCentre = cb.getCenter(new THREE.Vector3())
  const cr = Math.max(cb.max.x - cb.min.x, cb.max.y - cb.min.y) * 0.5
  coreMat.onBeforeCompile = sh => {
    sh.uniforms.uCoreC = { value: new THREE.Vector2(coreCentre.x, coreCentre.y) }
    sh.uniforms.uCoreR = { value: cr }
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCoreP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCoreP = position;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCoreP;\nuniform vec2 uCoreC;\nuniform float uCoreR;')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n{ float rr = clamp(length(vCoreP.xy - uCoreC) / uCoreR, 0.0, 1.0); totalEmissiveRadiance *= mix(1.6, 0.3, rr * rr); }',
      )
  }
  coreMat.customProgramCacheKey = () => 'plexus-hero-core'

  // the loops' far walls + fresnel rims
  const wallMat = new THREE.MeshStandardMaterial({
    color: 0x000000,
    roughness: 0.1,
    metalness: 0,
    side: THREE.BackSide,
    transparent: false,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    clippingPlanes: clip,
  })
  const rimMat = rimMaterial('#dcecff', 0)
  rimMat.clippingPlanes = clip
  for (const loop of [logo.loopA, logo.loopB]) {
    const wall = new THREE.Mesh(loop.geometry, wallMat)
    wall.renderOrder = -1
    loop.add(wall)
    const rim = new THREE.Mesh(loop.geometry, rimMat)
    rim.renderOrder = 3
    loop.add(rim)
  }
  // the glow light lives outside the pivot (the pivot is hidden before the
  // sweep; a light's visibility must never change — intensity only)
  logo.root.remove(logo.glow)
  const pivot = new THREE.Group()
  pivot.add(logo.root)
  return { pivot, logo, plane, loopMat, coreMat, wallMat, rimMat, coreCentre }
}
