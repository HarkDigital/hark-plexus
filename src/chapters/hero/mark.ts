import * as THREE from 'three'
import { glass, glassLogo, type GlassLogo } from '../../kit/glass'
import { Heart } from './heart'

/*
 * THE GLASS MARK — glassLogo() dressed for Plexus:
 *
 *   loops     clear, thick crystal glass with a faint ice absorption, rainbow
 *             dispersion and a clearcoat (desktop; phones get plain
 *             refraction); they refract the network and the particles
 *   walls     each loop's far wall: its own geometry, back faces only, as an
 *             additive studio sheen in the opaque list (reaches the glass
 *             buffer, so a loop shows depth without double-sided glass)
 *   rims      a whisper of fresnel light on the grazing edges
 *   heart     NOT a glowing crystal: a live mini-constellation (heart.ts) —
 *             a node in each hook's eye and a hub where the diamond sat,
 *             linked, twinkling, with satellites and pulses; the loops
 *             refract it
 *
 * The glass is clipped by one plane — the crystallization front. Keep points
 * with dot(p, dir) <= front; move the plane far away once the sweep is done
 * (never remove it: the program variant would change mid-scroll). The heart
 * follows the same front with its own ignition.
 */

export interface GlassMark {
  pivot: THREE.Group
  logo: GlassLogo
  plane: THREE.Plane
  loopMat: THREE.MeshPhysicalMaterial
  /** the loops' clearcoat as built (0 on phones) */
  coat: number
  /** additive: its opacity scales the sheen */
  wallMat: THREE.MeshStandardMaterial
  rimMat: THREE.ShaderMaterial
  /** the mini-constellation at the mark's heart */
  heart: Heart
  /** the heart's hub (where the diamond sat) in mark units (mark is 1 tall before scaling) */
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

/** mobile: build-time only (no dispersion / clearcoat on phones); S: the mark's world scale */
export function buildGlassMark(mobile: boolean, S: number): GlassMark {
  const plane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), -1e4)
  const clip = [plane]

  const coat = mobile ? 0 : 0.45
  const loopMat = glass({ thickness: 0.5, ior: 1.5, dispersion: 0.6, coat, tint: '#d8e8ff', tintDistance: 2.8 }).clone()
  loopMat.dispersion = mobile ? 0 : 0.6
  loopMat.clippingPlanes = clip
  const logo = glassLogo({ depth: 0.27, material: loopMat, light: false })

  // the diamond is not drawn: its place is the constellation's hub
  logo.core.geometry.computeBoundingBox()
  const coreCentre = logo.core.geometry.boundingBox!.getCenter(new THREE.Vector3())
  coreCentre.z = 0
  logo.root.remove(logo.core)
  logo.core.geometry.dispose()

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
  const heart = new Heart(S, coreCentre, mobile)
  logo.root.add(heart.group)
  // the glow light lives outside the pivot (the pivot is hidden before the
  // sweep; a light's visibility must never change — intensity only)
  logo.root.remove(logo.glow)
  const pivot = new THREE.Group()
  pivot.add(logo.root)
  return { pivot, logo, plane, loopMat, coat, wallMat, rimMat, heart, coreCentre }
}
