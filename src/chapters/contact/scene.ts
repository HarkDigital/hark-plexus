import * as THREE from 'three'
import { G, crystal, glass, glassLogo, type GlassLogo } from '../../kit/glass'
import { Morph, ringShape } from '../../kit/particles'
import { logoShapes } from '../../logo/logo'
import { clamp, rng, smoothstep } from '../../core/math'
import { Segments, Sprites } from './plexus'
import type { Rect } from './hud'

/*
 * CONNECT · the set. Everything lives in one rig whose origin is the glass
 * mark and whose unit is the mark's height (the chapter places and scales it
 * where the card leaves room), so every layout reads the same.
 *
 *   the mark        glassLogo with its own ice crystal core (the core and its
 *                   light answer the address and the copy button)
 *   the network     ~110 nodes (64 on phones) drifting over the whole frame,
 *                   linked to near neighbours (alpha by distance), some of
 *                   them REACHING to the mark's outline — beams grow from the
 *                   node to the glass, then carry small packets of light in
 *   the visitor     the pointer is a warm peach node: beams reach from it to
 *                   the nodes nearby (grab) and the nodes part around it
 *                   (repulse). Touch screens get a gentle wandering visitor.
 *   the halo        three tilted orbits of fine dust that begin as a loose
 *                   cloud and CONDENSE into rings; the nodes glide onto them
 *                   (staggered, swirling) — the network settles as a halo
 *
 * Story state comes from `local` only. Ambient state (drift, the repel
 * offsets, orbit spin, packet clocks) advances with dt, which is 0 while
 * the visitor has paused motion.
 */

export interface ConnectInput {
  local: number
  time: number
  /** 0 while motion is paused */
  dt: number
  /** reduced motion or paused: no pointer interaction, slow drift */
  calm: boolean
  rm: boolean
  W: number
  H: number
  /** drawing-buffer px per CSS px */
  dpr: number
  resX: number
  resY: number
  /** the mark's height in CSS px, and its centre */
  unitPx: number
  cx: number
  cy: number
  /** camera distance to the rig plane, world per CSS px there */
  D: number
  wpp: number
  /** the visitor's node in CSS px, strength 0..1 */
  visitor: { x: number; y: number; k: number }
  panel: Rect | null
  /** the address is hovered/focused (damped 0..1) */
  hot: number
  ctaFrom: { x: number; y: number } | null
  /** 0..1 progress of the copy pulse (0 = none) */
  pulse: number
  /** 0..1: the nodes and the mark come up out of the cut */
  presence: number
}

interface RingDef {
  r: number
  tx: number
  ty: number
  speed: number
  share: number
  colorA: string
  colorB: string
  dust: number
}

/* The halo: three orbits. Radii in mark heights. */
const RINGS: RingDef[] = [
  { r: 0.86, tx: 0.26, ty: -0.34, speed: 0.06, share: 0.26, colorA: '#8b7bff', colorB: '#d4e9ff', dust: 0.62 },
  { r: 1.14, tx: -0.4, ty: 0.28, speed: -0.042, share: 0.33, colorA: '#88c4ff', colorB: '#9fd0ff', dust: 0.58 },
  { r: 1.46, tx: 0.86, ty: 0.22, speed: 0.03, share: 0.41, colorA: '#6a5ee0', colorB: '#a99bff', dust: 0.6 },
]
/** nothing sits inside this radius (the glass) */
const R0 = 0.74

const C = {
  violet: new THREE.Color(G.violet),
  ice: new THREE.Color(G.ice),
  white: new THREE.Color('#e6f2ff'),
  peach: new THREE.Color(G.peach),
  rose: new THREE.Color(G.rose),
}

export interface ConnectScene {
  rig: THREE.Group
  mark: GlassLogo
  coreMat: THREE.MeshPhysicalMaterial
  update(i: ConnectInput): void
}

export function buildScene(o: { mobile: boolean }): ConnectScene {
  const mobile = o.mobile
  const rig = new THREE.Group()
  rig.name = 'connect-rig'

  /* ---------------------------------------------------------- the mark */
  const mark = glassLogo({ depth: 0.26, material: glass({ thickness: 1.0, ior: 1.5, dispersion: 0.5, coat: 0.35, sharp: true }) })
  // our own core material: its glow is animated (the kit caches and shares crystals)
  const coreMat = crystal(G.ice, 2.2).clone()
  mark.core.material = coreMat
  rig.add(mark.root)

  /*
   * The lamp: a ring of lit dots just behind the glass. It is OPAQUE (drawn
   * with depth, no blending), so three's transmission pass captures it and
   * the glass loops bend and split it — the clearest 'this is glass' read.
   */
  const LAMP = mobile ? 150 : 260
  const lampPos = new Float32Array(LAMP * 3)
  const lampRnd = new Float32Array(LAMP)
  {
    const lr = rng(91)
    for (let i = 0; i < LAMP; i++) {
      // two rings: one hidden behind the loops (seen only through the glass), one framing the mark
      const inner = i < LAMP * 0.4
      const n = inner ? LAMP * 0.4 : LAMP * 0.6
      const j = inner ? i : i - LAMP * 0.4
      const a = (j / n) * Math.PI * 2
      const rad = inner ? 0.37 + (lr() - 0.5) * 0.04 : 0.67
      lampPos[i * 3] = Math.cos(a) * rad
      lampPos[i * 3 + 1] = Math.sin(a) * rad
      lampPos[i * 3 + 2] = inner ? (lr() - 0.5) * 0.06 : 0
      // aRnd < 0 marks the crisp outer ring (even, small dots)
      lampRnd[i] = inner ? lr() : -1
    }
  }
  const lampGeo = new THREE.BufferGeometry()
  lampGeo.setAttribute('position', new THREE.BufferAttribute(lampPos, 3))
  lampGeo.setAttribute('aRnd', new THREE.BufferAttribute(lampRnd, 1))
  lampGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
  const lampU = {
    uSize: { value: 0 },
    uDpr: { value: 1 },
    uRefZ: { value: 10 },
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(G.ice).multiplyScalar(2.4) },
    uWarm: { value: new THREE.Color(G.violet).multiplyScalar(2.0) },
  }
  const lamp = new THREE.Points(
    lampGeo,
    new THREE.ShaderMaterial({
      uniforms: lampU,
      toneMapped: false,
      vertexShader: /* glsl */ `
        attribute float aRnd;
        uniform float uSize, uDpr, uRefZ, uTime;
        varying float vR;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float r = max(aRnd, 0.0);
          float tw = aRnd < 0.0 ? 0.62 : (0.8 + 0.5 * r) * (0.8 + 0.2 * sin(uTime * (0.8 + r * 1.5) + r * 30.0));
          gl_PointSize = clamp(uSize * tw * uDpr * uRefZ / max(-mv.z, 0.05), 0.0, 48.0);
          vR = aRnd;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor, uWarm;
        varying float vR;
        void main() {
          if (length(gl_PointCoord - 0.5) > 0.5) discard;
          gl_FragColor = vec4(mix(uColor, uWarm, step(0.8, vR)), 1.0);
        }
      `,
    }),
  )
  lamp.frustumCulled = false
  const lampSpin = new THREE.Group()
  lampSpin.position.z = -0.52
  lampSpin.add(lamp)
  rig.add(lampSpin)

  // anchors on the mark's OUTER contours (the beams land on the glass edge, never in a hole)
  const anchorsLocal: number[] = []
  for (const s of logoShapes()) for (const p of s.getSpacedPoints(mobile ? 36 : 56)) anchorsLocal.push(p.x, p.y)
  const NA = anchorsLocal.length / 2
  const anchors = new Float32Array(NA * 3)
  const tmpV = new THREE.Vector3()

  /* ---------------------------------------------------------- the halo (dust orbits) */
  const R = rng(41)
  const rings = RINGS.map((d, k) => {
    const tilt = new THREE.Group()
    tilt.rotation.set(d.tx, d.ty, 0)
    const spin = new THREE.Group()
    tilt.add(spin)
    const count = Math.round((mobile ? 1100 : 2600) * (d.r / 1.14))
    const morph = new Morph(count, { size: 0.01, colorA: d.colorA, colorB: d.colorB, seed: 11 + k * 7 })
    // shape b: the orbit
    morph.to('b', ringShape(count, d.r, { thickness: 0.018, seed: 5 + k }))
    // shape a: a loose cloud around the mark (built in rig space, then undone by the tilt)
    const inv = new THREE.Matrix4().makeRotationFromEuler(tilt.rotation).invert()
    const a = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const ang = R() * Math.PI * 2
      const rad = 0.9 + Math.pow(R(), 0.7) * 2.6
      tmpV.set(Math.cos(ang) * rad * 1.25, Math.sin(ang) * rad * 0.8, -1.1 + R() * 1.5).applyMatrix4(inv)
      a[i * 3] = tmpV.x
      a[i * 3 + 1] = tmpV.y
      a[i * 3 + 2] = tmpV.z
    }
    morph.to('a', a)
    spin.add(morph.points)
    rig.add(tilt)
    const mat = new THREE.Matrix4().makeRotationFromEuler(tilt.rotation)
    return { def: d, tilt, spin, morph, mat, phase: k * 1.7 }
  })

  /* ---------------------------------------------------------- the network */
  const N = mobile ? 64 : 110
  const rr = rng(7)
  const ux = new Float32Array(N)
  const uy = new Float32Array(N)
  const uz = new Float32Array(N)
  const f1 = new Float32Array(N)
  const f2 = new Float32Array(N)
  const f3 = new Float32Array(N)
  const p1 = new Float32Array(N)
  const p2 = new Float32Array(N)
  const amp = new Float32Array(N)
  const size = new Float32Array(N)
  const rnd = new Float32Array(N)
  const linker = new Uint8Array(N)
  const disc = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    disc[i] = i % 2
    if (disc[i]) {
      // around the mark (rig units), uniform in area
      const a = rr() * Math.PI * 2
      const r = Math.sqrt(0.9 * 0.9 + rr() * (2.5 * 2.5 - 0.9 * 0.9))
      ux[i] = Math.cos(a) * r * 1.2
      uy[i] = Math.sin(a) * r * 0.92
    } else {
      ux[i] = rr() * 2 - 1
      uy[i] = rr() * 2 - 1
    }
    uz[i] = -1.1 + rr() * 1.55
    f1[i] = 0.1 + rr() * 0.26
    f2[i] = 0.09 + rr() * 0.24
    f3[i] = 0.12 + rr() * 0.2
    p1[i] = rr() * 6.283
    p2[i] = rr() * 6.283
    amp[i] = 0.12 + rr() * 0.16
    size[i] = (mobile ? 14 : 16) + rr() * rr() * 16
    rnd[i] = rr()
    linker[i] = rr() < 0.72 ? 1 : 0
  }
  // halo slots, assigned per layout: ring index (-1 = the loose outer shell) and angle
  const slotRing = new Int8Array(N)
  const slotAng = new Float32Array(N)
  const slotRad = new Float32Array(N)
  const slotZ = new Float32Array(N)
  let slotKey = ''

  const pos = new Float32Array(N * 3)
  const off = new Float32Array(N * 2)
  const sx = new Float32Array(N)
  const sy = new Float32Array(N)
  const bright = new Float32Array(N)
  const col: THREE.Color[] = Array.from({ length: N }, () => new THREE.Color())

  const segs = new Segments(N * 6 + 40)
  const sprites = new Sprites(N * 2 + 40)
  const net = new THREE.Group()
  net.add(segs.mesh, sprites.points)
  rig.add(net)
  // draw order: dust, then beams, then nodes (all additive)
  segs.mesh.renderOrder = 2
  sprites.points.renderOrder = 3

  /* ---------------------------------------------------------- the copy pulse (a soft ring) */
  const pulseU = { uAlpha: { value: 0 }, uColor: { value: C.ice.clone() } }
  const pulse = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShaderMaterial({
      uniforms: pulseU,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uAlpha; uniform vec3 uColor; varying vec2 vUv;
        void main() {
          float d = length(vUv - 0.5) * 2.0;
          float e1 = (d - 0.8) * 22.0;
          float e2 = (d - 0.8) * 7.0;
          float ring = exp(-e1 * e1) + 0.25 * exp(-e2 * e2);
          float a = ring * uAlpha * (1.0 - smoothstep(0.92, 1.0, d));
          if (a <= 0.002) discard;
          gl_FragColor = vec4(uColor * a, 1.0);
        }
      `,
    }),
  )
  pulse.renderOrder = 4
  rig.add(pulse)

  // scratch
  const cTmp = new THREE.Color()
  const v = new THREE.Vector3()
  let pclock = 0

  /** free (drifting) position of node i, without drift if t is null */
  const freeAt = (i: number, t: number | null, drift: number, scx: number, scy: number, hw: number, hh: number, gath: number, out: THREE.Vector3) => {
    let x = disc[i] ? ux[i] : scx + ux[i] * hw
    let y = disc[i] ? uy[i] : scy + uy[i] * hh
    let z = uz[i]
    if (t !== null) {
      x += amp[i] * drift * Math.sin(t * f1[i] + p1[i])
      y += amp[i] * drift * Math.sin(t * f2[i] + p2[i])
      z += 0.1 * drift * Math.sin(t * f3[i] + p1[i] * 1.3)
    }
    const r2 = x * x + y * y
    const s = Math.sqrt(r2 + R0 * R0) / Math.sqrt(Math.max(r2, 1e-6))
    return out.set(x * s * gath, y * s * gath, z)
  }

  /** assign halo slots from the free layout: nearest nodes to the inner orbit, in angular order */
  const assignSlots = (scx: number, scy: number, hw: number, hh: number) => {
    const order = Array.from({ length: N }, (_, i) => i)
    const rad = new Float32Array(N)
    const ang = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      freeAt(i, null, 0, scx, scy, hw, hh, 1, v)
      rad[i] = Math.hypot(v.x, v.y)
      ang[i] = Math.atan2(v.y, v.x)
    }
    order.sort((a, b) => rad[a] - rad[b])
    const onRings = Math.round(N * 0.8)
    let cursor = 0
    RINGS.forEach((d, k) => {
      const n = k === RINGS.length - 1 ? onRings - cursor : Math.round(onRings * d.share)
      const members = order.slice(cursor, cursor + n).sort((a, b) => ang[a] - ang[b])
      members.forEach((i, j) => {
        slotRing[i] = k
        slotAng[i] = ang[members[0]] + (j / n) * Math.PI * 2 + (rnd[i] - 0.5) * 0.25 * ((Math.PI * 2) / n)
        slotRad[i] = d.r
        slotZ[i] = (rnd[i] - 0.5) * 0.03
      })
      cursor += n
    })
    for (let j = cursor; j < N; j++) {
      const i = order[j]
      slotRing[i] = -1
      slotAng[i] = ang[i]
      slotRad[i] = 1.8 + ((j - cursor) / Math.max(1, N - cursor)) * 0.5
      slotZ[i] = -0.5 + rnd[i] * 0.6
    }
  }

  const update = (I: ConnectInput) => {
    const { local, time: t, dt, calm, W, H, unitPx, cx, cy, D, wpp } = I
    const S = unitPx * wpp
    rig.position.set((cx - W / 2) * wpp, (H / 2 - cy) * wpp, 0)
    rig.scale.setScalar(S)

    // the visible frame, in rig units (centre relative to the mark, half extents)
    const scx = (W / 2 - cx) / unitPx
    const scy = (cy - H / 2) / unitPx
    const hw = (W / 2 / unitPx) * 1.08
    const hh = (H / 2 / unitPx) * 1.1
    const key = `${W}|${H}|${Math.round(cx)}|${Math.round(cy)}|${Math.round(unitPx)}`
    if (key !== slotKey) {
      slotKey = key
      assignSlots(scx, scy, hw, hh)
    }

    /* ---- story values (from local) */
    const quiet = smoothstep(0.8, 0.94, local)
    const settle = smoothstep(0.5, 0.87, local)
    const gath = 1 - 0.14 * smoothstep(0.1, 0.55, local)
    const reach = smoothstep(0.05, 0.3, local)
    const drift = (calm ? 0.35 : 1) * (1 - 0.75 * quiet)
    const slow = I.rm ? 0.15 : 1

    /* ---- the mark: a slow turn that ends front-on, idle float */
    const faceY = -Math.atan2(rig.position.x, D)
    const faceX = Math.atan2(rig.position.y, D)
    const idle = (I.rm ? 0.2 : 1) * (1 - 0.8 * quiet)
    const turn = -0.38 * (1 - smoothstep(0.02, 0.86, local))
    mark.root.rotation.set(
      faceX + 0.06 * Math.sin(t * 0.3 * slow) * idle,
      faceY + turn + 0.1 * Math.sin(t * 0.37 * slow + 0.6) * idle,
      0.025 * Math.sin(t * 0.23 * slow) * idle,
    )
    mark.root.position.set(0, 0.025 * Math.sin(t * 0.55 * slow) * idle, -0.25 * (1 - I.presence))
    mark.root.updateMatrix()
    // the crystal core: brighter as the network connects, a swell on hover and on copy
    const copySwell = I.pulse > 0 ? Math.sin(Math.min(1, I.pulse * 1.4) * Math.PI) : 0
    coreMat.emissiveIntensity = 1.5 + 0.9 * reach + 0.8 * settle + 0.7 * I.hot + 0.9 * copySwell
    mark.glow.intensity = 0.8 + 0.8 * settle + 0.6 * I.hot + 0.8 * copySwell

    // anchors in rig space (front face of the glass)
    for (let a = 0; a < NA; a++) {
      v.set(anchorsLocal[a * 2], anchorsLocal[a * 2 + 1], 0.13).applyMatrix4(mark.root.matrix)
      anchors[a * 3] = v.x
      anchors[a * 3 + 1] = v.y
      anchors[a * 3 + 2] = v.z
    }

    /* ---- the lamp behind the glass: dots grow in as the network reaches the mark */
    // centred behind the mark along the view ray
    lampSpin.position.set((rig.position.x * 0.52) / D, (rig.position.y * 0.52) / D, -0.52)
    lampSpin.rotation.set(faceX, faceY, rings[0].phase * 0.7)
    lampU.uSize.value = (mobile ? 3.2 : 3.6) * smoothstep(0.03, 0.26, local) * (0.85 + 0.15 * settle)
    lampU.uDpr.value = I.dpr
    lampU.uRefZ.value = D
    lampU.uTime.value = t * slow

    /* ---- the orbits spin (ambient); calmer for the final still */
    for (const r of rings) {
      r.phase += dt * r.def.speed * (1 - 0.7 * quiet) * (I.rm ? 0.25 : 1)
      r.spin.rotation.z = r.phase
      const mix = smoothstep(0.46, 0.86, local)
      r.morph.set({
        mix,
        time: t * slow,
        size: (mobile ? 2.6 : 2.3) * wpp,
        opacity: (r.def.dust + (0.95 - r.def.dust) * smoothstep(0.55, 0.9, local)) * (0.4 + 0.6 * I.presence),
        swirl: I.rm ? 0 : 0.5,
        px: I.resY,
      })
    }

    /* ---- nodes */
    const vx = I.visitor.x
    const vy = I.visitor.y
    const vk = calm ? 0 : I.visitor.k
    const repelPx = mobile ? 90 : 120
    const pushPx = (mobile ? 34 : 58) * (1 - 0.45 * quiet)
    const kOff = 1 - Math.exp(-7 * dt)
    const persp = (z: number) => D / Math.max(0.5, D - z * S)
    const panel = I.panel
    for (let i = 0; i < N; i++) {
      const i3 = i * 3
      freeAt(i, t * slow, drift, scx, scy, hw, hh, gath, v)
      let x = v.x
      let y = v.y
      let z = v.z
      // glide onto the halo: staggered, swirling
      const e0 = clamp((settle - rnd[i] * 0.3) / 0.7)
      const e = e0 * e0 * (3 - 2 * e0)
      if (e > 0) {
        let hx: number, hy: number, hz: number
        const k = slotRing[i]
        if (k >= 0) {
          const ring = rings[k]
          const a = slotAng[i] + ring.phase
          v.set(Math.cos(a) * slotRad[i], Math.sin(a) * slotRad[i], slotZ[i]).applyMatrix4(ring.mat)
          hx = v.x
          hy = v.y
          hz = v.z
        } else {
          const a = slotAng[i] + rings[2].phase * 0.5
          const w = 0.05 * drift
          hx = Math.cos(a) * slotRad[i] * 1.12 + w * Math.sin(t * slow * f1[i] + p1[i])
          hy = Math.sin(a) * slotRad[i] * 0.86 + w * Math.sin(t * slow * f2[i] + p2[i])
          hz = slotZ[i]
        }
        x += (hx - x) * e
        y += (hy - y) * e
        z += (hz - z) * e
        // mid-flight swirl around the mark
        const sw = (I.rm ? 0 : 0.9) * 4 * e * (1 - e) * (rnd[i] < 0.5 ? 1 : -1)
        if (sw !== 0) {
          const cs = Math.cos(sw)
          const sn = Math.sin(sw)
          const nx = x * cs - y * sn
          y = x * sn + y * cs
          x = nx
        }
      }
      // screen position (CSS px) — the camera looks straight at the rig plane
      const wx = rig.position.x + x * S
      const wy = rig.position.y + y * S
      const pk = persp(z)
      let px = W / 2 + (wx * pk) / wpp
      let py = H / 2 - (wy * pk) / wpp
      // the visitor parts the network (repulse), damped
      let tx = 0
      let ty = 0
      if (vk > 0.01) {
        const dx = px - vx
        const dy = py - vy
        const d = Math.hypot(dx, dy)
        if (d < repelPx && d > 0.5) {
          const f = (1 - d / repelPx) ** 2 * pushPx * vk
          tx = ((dx / d) * f) / unitPx
          ty = (-(dy / d) * f) / unitPx
        }
      }
      off[i * 2] += (tx - off[i * 2]) * kOff
      off[i * 2 + 1] += (ty - off[i * 2 + 1]) * kOff
      x += off[i * 2]
      y += off[i * 2 + 1]
      px += off[i * 2] * unitPx * pk
      py -= off[i * 2 + 1] * unitPx * pk
      pos[i3] = x
      pos[i3 + 1] = y
      pos[i3 + 2] = z
      sx[i] = px
      sy[i] = py
      // brightness: depth, nearness to the mark, a soft twinkle; dim behind the card
      const rm = Math.hypot(x, y)
      const near = smoothstep(2.8, 0.8, rm)
      let b = (0.5 + 0.5 * smoothstep(-1.1, 0.45, z)) * (0.86 + 0.14 * Math.sin(t * (0.9 + rnd[i] * 1.6) + rnd[i] * 20))
      if (panel && px > panel.x0 - 12 && px < panel.x1 + 12 && py > panel.y0 - 12 && py < panel.y1 + 12) b *= 0.38
      bright[i] = b * I.presence
      col[i].copy(C.violet).lerp(C.ice, near).lerp(C.white, near * near * 0.45)
    }

    segs.begin()
    sprites.begin()

    /* ---- links between near neighbours (particles.js: alpha by distance) */
    const area = 4 * hw * hh
    const Lfree = 1.32 * Math.sqrt(area / N)
    const L = Lfree + (0.36 - Lfree) * settle
    const L2 = L * L
    const lineA = 0.5 + 0.12 * settle
    for (let i = 0; i < N; i++) {
      const bi = bright[i]
      if (bi < 0.02) continue
      const i3 = i * 3
      for (let j = i + 1; j < N; j++) {
        const j3 = j * 3
        const dx = pos[i3] - pos[j3]
        const dy = pos[i3 + 1] - pos[j3 + 1]
        const dz = (pos[i3 + 2] - pos[j3 + 2]) * 0.6
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 > L2) continue
        const a = (1 - Math.sqrt(d2) / L) * lineA
        segs.push(pos[i3], pos[i3 + 1], pos[i3 + 2], pos[j3], pos[j3 + 1], pos[j3 + 2], col[i], a * bi, col[j], a * bright[j])
      }
    }

    /* ---- beams to the mark: grow from the node to the glass, then carry packets in */
    const Mlink = 1.55 - 0.9 * settle
    const hotK = 1 + 1.6 * I.hot
    pclock += dt * (calm ? 0.35 : 1) * (1 - 0.35 * quiet) * (1 + 1.3 * I.hot)
    for (let i = 0; i < N; i++) {
      if (!linker[i] || bright[i] < 0.02) continue
      const i3 = i * 3
      const x = pos[i3]
      const y = pos[i3 + 1]
      const z = pos[i3 + 2]
      if (x * x + y * y > 3.2 * 3.2) continue
      let best = 1e9
      let ba = 0
      for (let a = 0; a < NA; a++) {
        const dx = x - anchors[a * 3]
        const dy = y - anchors[a * 3 + 1]
        const dz = z - anchors[a * 3 + 2]
        const d2 = dx * dx + dy * dy + dz * dz * 0.5
        if (d2 < best) {
          best = d2
          ba = a
        }
      }
      const d = Math.sqrt(best)
      if (d > Mlink) continue
      const g0 = clamp((local - 0.06 - rnd[i] * 0.14) / 0.12)
      const grow = g0 * g0 * (3 - 2 * g0)
      if (grow <= 0) continue
      const a = Math.pow(1 - d / Mlink, 0.75) * 0.72 * bright[i] * Math.min(1.6, hotK * 0.8 + 0.2)
      const ax = anchors[ba * 3]
      const ay = anchors[ba * 3 + 1]
      const az = anchors[ba * 3 + 2]
      const ex = x + (ax - x) * grow
      const ey = y + (ay - y) * grow
      const ez = z + (az - z) * grow
      segs.push(x, y, z, ex, ey, ez, col[i], a * 0.8, C.white, a * (0.5 + 0.5 * grow))
      // the reaching tip
      if (grow < 0.999) sprites.push(ex, ey, ez, C.white, a * 1.6, 9)
      else if (!I.rm) {
        const ph = (pclock * (0.24 + rnd[i] * 0.22) + rnd[i] * 7.3) % 1
        const q = ph * ph
        const k = Math.sin(ph * Math.PI) * a * 2.2
        sprites.push(x + (ax - x) * q, y + (ay - y) * q, z + (az - z) * q, C.white, k, 8)
      }
    }

    /* ---- nodes */
    for (let i = 0; i < N; i++) {
      const i3 = i * 3
      sprites.push(pos[i3], pos[i3 + 1], pos[i3 + 2], col[i], bright[i] * 1.5, size[i])
      // a few hubs wear a faint ring (the particles.js 'grab' highlight)
      if (rnd[i] > 0.91) sprites.push(pos[i3], pos[i3 + 1], pos[i3 + 2], col[i], bright[i] * 0.32, size[i] * (mobile ? 1.55 : 1.9), 1)
    }

    /* ---- the visitor: a warm node that grabs its neighbours */
    if (I.visitor.k > 0.01) {
      const k = I.visitor.k * I.presence
      const ox = (vx - cx) / unitPx
      const oy = (cy - vy) / unitPx
      const G_PX = mobile ? 150 : 200
      for (let i = 0; i < N; i++) {
        const dx = sx[i] - vx
        const dy = sy[i] - vy
        const d = Math.hypot(dx, dy)
        if (d > G_PX || bright[i] < 0.02) continue
        const a = Math.pow(1 - d / G_PX, 1.1) * 0.95 * k
        const i3 = i * 3
        segs.push(ox, oy, 0, pos[i3], pos[i3 + 1], pos[i3 + 2], C.peach, a, col[i], a * bright[i])
      }
      const breath = I.rm ? 0 : Math.sin(t * 1.3) * 5
      sprites.push(ox, oy, 0, C.peach, k * 1.7, 20)
      sprites.push(ox, oy, 0, C.peach, k * 0.5, 46 + breath, 1)
    }

    /* ---- the address routes to the mark while it has the pointer */
    if (I.ctaFrom && I.hot > 0.01) {
      const k = I.hot * I.presence
      const ox = (I.ctaFrom.x - cx) / unitPx
      const oy = (cy - I.ctaFrom.y) / unitPx
      let best = 1e9
      let ba = 0
      for (let a = 0; a < NA; a++) {
        const d2 = (ox - anchors[a * 3]) ** 2 + (oy - anchors[a * 3 + 1]) ** 2
        if (d2 < best) {
          best = d2
          ba = a
        }
      }
      const ax = anchors[ba * 3]
      const ay = anchors[ba * 3 + 1]
      const az = anchors[ba * 3 + 2]
      const g = smoothstep(0, 1, I.hot)
      const ex = ox + (ax - ox) * g
      const ey = oy + (ay - oy) * g
      const ez = az * g
      segs.push(ox, oy, 0, ex, ey, ez, C.peach, 0.9 * k, C.white, 0.95 * k)
      sprites.push(ox, oy, 0, C.peach, 1.4 * k, 16)
      if (!I.rm) {
        for (let j = 0; j < 3; j++) {
          const ph = (pclock * 0.55 + j / 3) % 1
          const q = ph * ph * g
          cTmp.copy(C.peach).lerp(C.white, ph)
          sprites.push(ox + (ax - ox) * q, oy + (ay - oy) * q, az * q, cTmp, Math.sin(ph * Math.PI) * 1.8 * k, 9)
        }
      }
    }

    const px2 = I.dpr
    segs.end(I.resX, I.resY, (mobile ? 1.15 : 1.3) * px2)
    sprites.end(I.dpr, D)

    /* ---- the copy pulse: one soft ring out of the mark */
    const pl = I.pulse
    const live = pl > 0 && pl < 1 && !I.rm
    pulse.scale.setScalar(1.2 + 2.6 * (1 - (1 - pl) * (1 - pl)))
    pulseU.uAlpha.value = live ? (1 - pl) * (1 - pl) * 0.9 * I.presence : 0
  }

  return { rig, mark, coreMat, update }
}
