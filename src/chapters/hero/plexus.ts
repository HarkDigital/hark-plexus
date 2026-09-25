import * as THREE from 'three'
import { dotTexture } from '../../kit/particles'
import { rng } from '../../core/math'
import { G } from '../../kit/glass'

/*
 * THE PLEXUS RING — the particles.js network, woven into the orbit around the
 * glass mark. Nodes ride the ring band (each at its own radius and speed, so
 * links form and break as they pass each other), lines join neighbours closer
 * than `link` with alpha by distance, the pointer pushes nodes aside
 * (particles.js 'repulse') and throws faint lines to the nodes around it
 * ('grab').
 *
 * Positions come from time + scroll only (no simulation state), so the ring
 * is exact at any jumped-to scroll position and holds still when motion is off.
 * Like the particles, links and nodes are split at the mark's depth: the ones
 * behind go in three's opaque list (the glass refracts them), the ones in
 * front are drawn over the glass.
 */

interface Layer {
  lines: THREE.LineSegments
  linePos: Float32Array
  lineCol: Float32Array
  dots: THREE.Points
  dotPos: Float32Array
  dotCol: Float32Array
}

export class PlexusRing {
  group = new THREE.Group()
  private n: number
  private rad: Float32Array
  private ang: Float32Array
  private h: Float32Array
  private spd: Float32Array
  private wob: Float32Array
  private bright: Float32Array
  private pos: Float32Array
  private depth: Float32Array
  private maxLinks: number
  private back: Layer
  private front: Layer
  private cLine = new THREE.Color(G.ice)
  private cLine2 = new THREE.Color(G.violet)
  private cNode = new THREE.Color('#d6ebff')
  private cGrab = new THREE.Color(G.white)
  private tmp = new THREE.Vector3()
  private kb = 0
  private kf = 0

  constructor(
    count: number,
    private ringR: number,
    private ringRot: THREE.Matrix3,
    private link: number,
    nodeSize: number,
  ) {
    const n = (this.n = count)
    const r = rng(113)
    this.rad = new Float32Array(n)
    this.ang = new Float32Array(n)
    this.h = new Float32Array(n)
    this.spd = new Float32Array(n)
    this.wob = new Float32Array(n)
    this.bright = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      this.rad[i] = ringR * (0.8 + 0.42 * r())
      this.ang[i] = (i / n) * Math.PI * 2 + (r() - 0.5) * 0.5
      this.h[i] = (r() - 0.5) * ringR * 0.34
      this.spd[i] = (0.75 + 0.5 * r()) * (1.4 / (0.5 + this.rad[i] / ringR))
      this.wob[i] = r() * Math.PI * 2
      this.bright[i] = 0.55 + 0.45 * r()
    }
    this.pos = new Float32Array(n * 3)
    this.depth = new Float32Array(n)
    this.maxLinks = n * 4 + n
    this.back = this.layer(false, nodeSize)
    this.front = this.layer(true, nodeSize)
    this.front.lines.renderOrder = 4
    this.front.dots.renderOrder = 5
  }

  private layer(transparent: boolean, nodeSize: number): Layer {
    const linePos = new Float32Array(this.maxLinks * 6)
    const lineCol = new Float32Array(this.maxLinks * 6)
    const lg = new THREE.BufferGeometry()
    lg.setAttribute('position', new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage))
    lg.setAttribute('color', new THREE.BufferAttribute(lineCol, 3).setUsage(THREE.DynamicDrawUsage))
    lg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
    const lines = new THREE.LineSegments(
      lg,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
    )
    lines.frustumCulled = false
    const dotPos = new Float32Array(this.n * 3)
    const dotCol = new Float32Array(this.n * 3)
    const dg = new THREE.BufferGeometry()
    dg.setAttribute('position', new THREE.BufferAttribute(dotPos, 3).setUsage(THREE.DynamicDrawUsage))
    dg.setAttribute('color', new THREE.BufferAttribute(dotCol, 3).setUsage(THREE.DynamicDrawUsage))
    dg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4)
    const dots = new THREE.Points(
      dg,
      new THREE.PointsMaterial({
        size: nodeSize,
        sizeAttenuation: true,
        vertexColors: true,
        map: dotTexture(),
        transparent,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    )
    dots.frustumCulled = false
    this.group.add(lines, dots)
    return { lines, linePos, lineCol, dots, dotPos, dotCol }
  }

  /**
   * spin: ring angle (time-driven); grow 0..1 (nodes spread out from the centre);
   * strength 0..1; ptr: pointer point on the mark's plane (group-local) or null;
   * cam: camera position (group-local) and view direction (group-local, unit);
   * centreDepth: view depth of the group origin (the split plane).
   */
  update(time: number, spin: number, grow: number, strength: number, ptr: THREE.Vector3 | null, ptrK: number, repel: number, cam: THREE.Vector3, view: THREE.Vector3, split: boolean) {
    const n = this.n
    const p = this.pos
    const m = this.ringRot.elements
    const centreDepth = -cam.dot(view)
    const R = this.ringR
    for (let i = 0; i < n; i++) {
      const a = this.ang[i] + spin * this.spd[i]
      const rr = this.rad[i] * (0.25 + 0.75 * grow)
      const x = Math.cos(a) * rr
      const y = this.h[i] * grow + Math.sin(time * 0.5 + this.wob[i]) * R * 0.025
      const z = Math.sin(a) * rr
      // ringRot (column-major Matrix3)
      let px = m[0] * x + m[3] * y + m[6] * z
      let py = m[1] * x + m[4] * y + m[7] * z
      let pz = m[2] * x + m[5] * y + m[8] * z
      if (ptr && ptrK > 0) {
        // push away from the pointer across the view plane
        let dx = px - ptr.x
        let dy = py - ptr.y
        let dz = pz - ptr.z
        const along = dx * view.x + dy * view.y + dz * view.z
        dx -= view.x * along
        dy -= view.y * along
        dz -= view.z * along
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (d < repel && d > 1e-4) {
          const f = (1 - d / repel) ** 2 * repel * 0.55 * ptrK
          px += (dx / d) * f
          py += (dy / d) * f
          pz += (dz / d) * f
        }
      }
      p[i * 3] = px
      p[i * 3 + 1] = py
      p[i * 3 + 2] = pz
      this.depth[i] = (px - cam.x) * view.x + (py - cam.y) * view.y + (pz - cam.z) * view.z
    }

    this.kb = 0
    this.kf = 0
    let db = 0
    let df = 0
    const B = this.back
    const F = this.front
    const L = this.link * (0.6 + 0.4 * grow)
    const L2 = L * L
    const push = this.push
    if (strength > 0.002) {
      for (let i = 0; i < n; i++) {
        const ix = i * 3
        for (let j = i + 1; j < n; j++) {
          const jx = j * 3
          const dx = p[ix] - p[jx]
          const dy = p[ix + 1] - p[jx + 1]
          const dz = p[ix + 2] - p[jx + 2]
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 > L2) continue
          const t = 1 - Math.sqrt(d2) / L
          const k = t * (0.35 + 0.65 * t) * 0.95 * strength
          const behind = split && (this.depth[i] + this.depth[j]) * 0.5 > centreDepth
          push(p[ix], p[ix + 1], p[ix + 2], p[jx], p[jx + 1], p[jx + 2], (i + j) % 3 === 0 ? this.cLine2 : this.cLine, k, behind)
        }
      }
      // grab: faint lines from the pointer to the nodes around it
      if (ptr && ptrK > 0.01) {
        const grab = this.link * 1.5
        for (let i = 0; i < n; i++) {
          const ix = i * 3
          const d = this.tmp.set(p[ix] - ptr.x, p[ix + 1] - ptr.y, p[ix + 2] - ptr.z).length()
          if (d > grab) continue
          const t = 1 - d / grab
          push(ptr.x, ptr.y, ptr.z, p[ix], p[ix + 1], p[ix + 2], this.cGrab, t * 0.7 * ptrK * strength, split && this.depth[i] > centreDepth)
        }
      }
      for (let i = 0; i < n; i++) {
        const behind = split && this.depth[i] > centreDepth
        const Ly = behind ? B : F
        const o = (behind ? db++ : df++) * 3
        Ly.dotPos[o] = p[i * 3]
        Ly.dotPos[o + 1] = p[i * 3 + 1]
        Ly.dotPos[o + 2] = p[i * 3 + 2]
        const tw = 0.8 + 0.2 * Math.sin(time * (1.1 + this.wob[i] * 0.3) + this.wob[i] * 5)
        const k = this.bright[i] * tw * strength * 2.2
        Ly.dotCol[o] = this.cNode.r * k
        Ly.dotCol[o + 1] = this.cNode.g * k
        Ly.dotCol[o + 2] = this.cNode.b * k
      }
    }
    this.flush(B, this.kb, db)
    this.flush(F, this.kf, df)
  }

  /** append a link to the behind / front layer (counts in kb / kf) */
  private push = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: THREE.Color, k: number, behind: boolean) => {
    const Ly = behind ? this.back : this.front
    const idx = behind ? this.kb : this.kf
    if (idx >= this.maxLinks) return
    const o = idx * 6
    Ly.linePos[o] = x0
    Ly.linePos[o + 1] = y0
    Ly.linePos[o + 2] = z0
    Ly.linePos[o + 3] = x1
    Ly.linePos[o + 4] = y1
    Ly.linePos[o + 5] = z1
    Ly.lineCol[o] = Ly.lineCol[o + 3] = c.r * k
    Ly.lineCol[o + 1] = Ly.lineCol[o + 4] = c.g * k
    Ly.lineCol[o + 2] = Ly.lineCol[o + 5] = c.b * k
    if (behind) this.kb++
    else this.kf++
  }

  private flush(Ly: Layer, links: number, dots: number) {
    const lg = Ly.lines.geometry
    lg.setDrawRange(0, links * 2)
    ;(lg.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(lg.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true
    const dg = Ly.dots.geometry
    dg.setDrawRange(0, dots)
    ;(dg.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(dg.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true
  }
}
