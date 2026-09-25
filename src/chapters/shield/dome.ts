import * as THREE from 'three'
import { G, edgeGlow, glass, sharpTransmission, smoothExtrude } from '../../kit/glass'
import { rng } from '../../core/math'

/*
 * The shield: a geodesic cap of hexagonal glass tiles standing in front of
 * the site, like a honeycomb force field made solid.
 *
 * Tile sites are the vertices of a subdivided icosphere inside a spherical
 * cap (the dual of a geodesic sphere is a hex honeycomb), so tiles sit almost
 * evenly with a hairline of air between them. Each tile is a real bevelled
 * glass prism (ONE InstancedMesh → one transmissive draw); a hairline of ice
 * light outlines each cell (a second InstancedMesh, additive, its own
 * material); a fresnel shell gives the dome a luminous silhouette.
 *
 * Assembly (chaos → order): tiles start scattered far outside the shell,
 * tumbling, and converge on their seats ring by ring from the pole outward;
 * each cell's outline glows as it locks. Everything is a pure function of
 * `assembly` (scroll), so any jumped-to local is exact.
 */

export interface DomeOpts {
  /** sphere radius */
  radius: number
  /** sphere centre (the cap faces +z) */
  center: THREE.Vector3
  /** cap half-angle (radians) */
  rim: number
  mobile: boolean
}

export interface Tile {
  home: THREE.Vector3
  normal: THREE.Vector3
  quat: THREE.Quaternion
  size: number
  /** polar angle from the dome axis / rim (0 at the pole, 1 at the rim) */
  t: number
  start: THREE.Vector3
  startQuat: THREE.Quaternion
  delay: number
  /** smoothed extra light (hits, pointer) */
  glow: number
  hot: number
}

const HEX_DEPTH = 0.3

function hexShape(r: number, hole = 0): THREE.Shape {
  const s = new THREE.Shape()
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 6 + (k * Math.PI) / 3
    const x = Math.cos(a) * r
    const y = Math.sin(a) * r
    if (k === 0) s.moveTo(x, y)
    else s.lineTo(x, y)
  }
  s.closePath()
  if (hole > 0) {
    const h = new THREE.Path()
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 6 - (k * Math.PI) / 3
      const x = Math.cos(a) * hole
      const y = Math.sin(a) * hole
      if (k === 0) h.moveTo(x, y)
      else h.lineTo(x, y)
    }
    h.closePath()
    s.holes.push(h)
  }
  return s
}

export class Dome {
  group = new THREE.Group()
  tiles: Tile[] = []
  glassMesh!: THREE.InstancedMesh
  lineMesh!: THREE.InstancedMesh
  shell!: THREE.Mesh
  private shellMat!: THREE.ShaderMaterial
  private m = new THREE.Matrix4()
  private q = new THREE.Quaternion()
  private p = new THREE.Vector3()
  private sc = new THREE.Vector3()
  private col = new THREE.Color()
  private ice = new THREE.Color(G.ice)
  private white = new THREE.Color(G.white)
  private peach = new THREE.Color(G.peach)
  private ember = new THREE.Color(G.ember)
  private warmC = new THREE.Color()
  private proj = new THREE.Vector3()
  private lift = new THREE.Matrix4()
  /** the tile front face, in tile units (the outline sits just in front of it) */
  private front = 0
  /** a click ripple: origin direction + start time */
  private rip = { dir: new THREE.Vector3(0, 0, 1), t0: -100, on: false }

  constructor(readonly o: DomeOpts) {
    this.build()
  }

  private build() {
    const { radius: R, center: C, rim, mobile } = this.o
    // icosphere vertices (deduplicated)
    const ico = new THREE.IcosahedronGeometry(1, mobile ? 3 : 4)
    const pos = ico.getAttribute('position') as THREE.BufferAttribute
    const seen = new Map<string, THREE.Vector3>()
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i).normalize()
      const key = `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`
      if (!seen.has(key)) seen.set(key, v)
    }
    ico.dispose()
    let verts = [...seen.values()]
    // aim the cap axis at a hexagonal site near the centre of a face (never a
    // pentagon at the pole): the vertex closest to the first face's centroid
    const f0 = new THREE.Vector3(0, 0, 0)
    {
      const g = new THREE.IcosahedronGeometry(1, 0)
      const a = new THREE.Vector3().fromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute, 0)
      const b = new THREE.Vector3().fromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute, 1)
      const c = new THREE.Vector3().fromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute, 2)
      f0.add(a).add(b).add(c).normalize()
      g.dispose()
    }
    let axis = verts[0]
    let best = -2
    for (const v of verts) {
      const d = v.dot(f0)
      if (d > best) {
        best = d
        axis = v
      }
    }
    const toZ = new THREE.Quaternion().setFromUnitVectors(axis, new THREE.Vector3(0, 0, 1))
    verts = verts.map(v => v.clone().applyQuaternion(toZ))
    const cosRim = Math.cos(rim)
    const cap = verts.filter(v => v.z >= cosRim)
    // neighbour spacing
    const R0 = rng(41)
    const Z = new THREE.Vector3(0, 0, 1)
    const X = new THREE.Vector3()
    for (const v of cap) {
      let dmin = Infinity
      let nb: THREE.Vector3 | null = null
      for (const w of verts) {
        if (w === v) continue
        const d = v.distanceTo(w)
        if (d < dmin) {
          dmin = d
          nb = w
        }
      }
      const normal = v.clone()
      const home = C.clone().addScaledVector(normal, R)
      // orient: tile +z along the normal, a flat side toward the nearest neighbour
      const q = new THREE.Quaternion().setFromUnitVectors(Z, normal)
      const localX = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
      const toNb = nb!.clone().sub(v)
      toNb.addScaledVector(normal, -toNb.dot(normal)).normalize()
      const ang = Math.atan2(X.crossVectors(localX, toNb).dot(normal), localX.dot(toNb))
      q.premultiply(new THREE.Quaternion().setFromAxisAngle(normal, ang))
      // apothem = half the spacing (minus a hairline of air)
      const size = ((dmin * R) / 2 / Math.cos(Math.PI / 6)) * 0.93
      const t = Math.acos(Math.min(1, normal.z)) / rim
      // scattered start: far outside the shell, off to the sides, tumbling
      const out = normal.clone()
      out.x += (R0() - 0.5) * 1.2
      out.y += (R0() - 0.5) * 1.2
      out.z = Math.abs(out.z) * 0.6 + 0.2
      out.normalize()
      const start = home.clone().addScaledVector(out, 3.2 + R0() * 3.4)
      start.x += 2.4 + R0() * 1.6
      const startQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler((R0() - 0.5) * 5, (R0() - 0.5) * 5, (R0() - 0.5) * 5))
      this.tiles.push({ home, normal, quat: q, size, t, start, startQuat, delay: t * 0.55 + R0() * 0.08, glow: 0, hot: 0 })
    }

    // geometry: a hex prism of circumradius 1 (scaled per instance)
    const geo = smoothExtrude(hexShape(1), { depth: HEX_DEPTH, bevel: 0.1, bevelSegments: mobile ? 2 : 4, curveSegments: 1, crease: 0.5 })
    geo.computeBoundingBox()
    this.front = (geo.boundingBox?.max.z ?? HEX_DEPTH / 2) + 0.012
    this.lift.makeTranslation(0, 0, this.front)
    // clear, faintly iridescent glass that keeps the site crisp behind it.
    // Its own material (cloned): never shared with a plain Mesh elsewhere.
    const mat = glass({ thickness: 0.32, ior: 1.46, dispersion: 0.42, env: 1.25, coat: mobile ? 0 : 0.6, iridescence: mobile ? 0 : 0.35 }).clone()
    sharpTransmission(mat)
    this.glassMesh = new THREE.InstancedMesh(geo, mat, this.tiles.length)
    this.glassMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.glassMesh.frustumCulled = false

    // outlines: a thin hex ring on each tile's face
    const ring = new THREE.ShapeGeometry(hexShape(0.985, 0.945), 1)
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })
    this.lineMesh = new THREE.InstancedMesh(ring, lineMat, this.tiles.length)
    this.lineMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.lineMesh.frustumCulled = false
    for (let i = 0; i < this.tiles.length; i++) this.lineMesh.setColorAt(i, this.col.setRGB(0, 0, 0))
    this.lineMesh.instanceColor!.setUsage(THREE.DynamicDrawUsage)
    this.lineMesh.renderOrder = 2

    // the fresnel shell: a luminous silhouette just outside the tiles
    this.shellMat = edgeGlow(G.ice, 3, 0)
    this.shellMat.depthTest = true
    const shellGeo = new THREE.SphereGeometry(R + 0.06, mobile ? 40 : 64, mobile ? 14 : 22, 0, Math.PI * 2, 0, rim + 0.02)
    shellGeo.rotateX(Math.PI / 2)
    this.shell = new THREE.Mesh(shellGeo, this.shellMat)
    this.shell.position.copy(C)
    this.shell.renderOrder = 1

    this.group.add(this.glassMesh, this.lineMesh, this.shell)
  }

  /** Start a ripple of light from `dir` (unit, from the centre). False if one is still running. */
  ripple(dir: THREE.Vector3, time: number): boolean {
    if (this.rip.on && time - this.rip.t0 < 0.45) return false
    this.rip.dir.copy(dir)
    this.rip.t0 = time
    this.rip.on = true
    return true
  }

  /**
   * assembly 0..1 (scroll), plus per-frame light: `base` outline strength,
   * `scan` (0..1 position of a scan ring from pole to rim, <0 = none),
   * hits (unit directions from the centre where streams strike, with a weight),
   * pointer (NDC, or null), camera for the pointer's hover test.
   */
  update(o: {
    assembly: number
    base: number
    scan: number
    shell: number
    hits: { dir: THREE.Vector3; w: number }[]
    pointer: THREE.Vector2 | null
    camera: THREE.Camera
    aspect: number
    dt: number
    time: number
  }) {
    const n = this.tiles.length
    let any = false
    const ripAge = o.time - this.rip.t0
    if (this.rip.on && (ripAge > 2.2 || ripAge < 0)) this.rip.on = false
    for (let i = 0; i < n; i++) {
      const T = this.tiles[i]
      const e0 = Math.min(1, Math.max(0, (o.assembly - T.delay) / 0.38))
      // long settling ease-out
      const e = 1 - Math.pow(1 - e0, 3)
      if (e0 <= 0) {
        this.m.makeScale(0, 0, 0)
        this.glassMesh.setMatrixAt(i, this.m)
        this.lineMesh.setMatrixAt(i, this.m)
        this.lineMesh.setColorAt(i, this.col.setRGB(0, 0, 0))
        continue
      }
      any = true
      // a curved approach (swings in from the side, not a straight line)
      this.p.lerpVectors(T.start, T.home, e)
      const arc = Math.sin(e * Math.PI) * (1 - e) * 1.2
      this.p.addScaledVector(T.normal, arc)
      this.q.slerpQuaternions(T.startQuat, T.quat, e)
      const s = T.size * (0.35 + 0.65 * e)
      this.sc.set(s, s, s)
      this.m.compose(this.p, this.q, this.sc)
      this.glassMesh.setMatrixAt(i, this.m)
      // the outline rides on the tile's front face
      this.m.multiply(this.lift)
      this.lineMesh.setMatrixAt(i, this.m)

      // light: locks with a soft glow; hits warm it; the scan ring; the pointer
      const lockT = (e0 - 0.97) / 0.07
      const lock = e0 > 0.8 ? Math.exp(-lockT * lockT) * 1.3 : 0
      let hit = 0
      for (const h of o.hits) {
        if (h.w <= 0.002) continue
        const c = T.normal.dot(h.dir)
        if (c > 0.93) hit += h.w * Math.pow((c - 0.93) / 0.07, 2)
      }
      hit = Math.min(1, hit) * e
      let hover = 0
      if (o.pointer) {
        this.proj.copy(T.home).project(o.camera)
        const dx = (this.proj.x - o.pointer.x) * o.aspect
        const dy = this.proj.y - o.pointer.y
        const d2 = dx * dx + dy * dy
        hover = Math.exp(-d2 / 0.024) * e
      }
      const k = 1 - Math.exp(-6 * o.dt)
      T.glow += (hover - T.glow) * k
      T.hot += (hit - T.hot) * (1 - Math.exp(-4 * o.dt))
      let scan = 0
      if (o.scan >= 0) {
        const d = (T.t - o.scan) / 0.14
        scan = Math.exp(-d * d) * 0.9
      }
      let ripple = 0
      if (this.rip.on) {
        const ang = Math.acos(Math.min(1, Math.max(-1, T.normal.dot(this.rip.dir))))
        const d = (ang - ripAge * 0.85) / 0.12
        ripple = Math.exp(-d * d) * Math.exp(-ripAge * 1.2) * 4
      }
      const shimmer = 0.85 + 0.15 * Math.sin(o.time * 0.9 + T.home.x * 3.1 + T.home.y * 2.3)
      const cool = (o.base * shimmer * (0.55 + 0.45 * e) + lock + scan + ripple + T.glow * 6.5) * e
      // ice light, warming toward peach/ember where streams strike
      this.col.copy(this.ice).multiplyScalar(cool)
      if (T.hot > 0.002) {
        // a struck cell burns peach → ember (replacing the ice, not tinting it pink)
        this.warmC.copy(this.peach).lerp(this.ember, 0.45).multiplyScalar(0.5 + 1.1 * T.hot)
        this.col.lerp(this.warmC, Math.min(1, T.hot * 1.4))
      }
      if (T.glow > 0.01) this.col.lerp(this.white, Math.min(0.6, T.glow * 0.6))
      this.lineMesh.setColorAt(i, this.col)
    }
    this.glassMesh.visible = any
    this.lineMesh.visible = any
    this.glassMesh.instanceMatrix.needsUpdate = true
    this.lineMesh.instanceMatrix.needsUpdate = true
    this.lineMesh.instanceColor!.needsUpdate = true
    this.shellMat.uniforms.uStrength.value = o.shell
    this.shell.visible = o.shell > 0.002
  }
}
