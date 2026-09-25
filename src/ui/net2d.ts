/*
 * A small particles.js-style network on a 2D canvas, for the DOM layers that
 * sit above the WebGL scene (the loader, the menu sheet). It follows the
 * owner's reference components:
 *
 *   Constellation   nodes drift and bounce off the edges, lines join near
 *                   neighbours with alpha by distance, the mouse repels
 *                   nodes, each node wears a soft glow
 *   Particles       fine dust with per-dot magnetism toward the mouse
 *
 * Plus the Plexus move: any node can be given a target and a pull (0..1);
 * as the pull rises it SWIRLS in along a closing spiral and CONDENSES onto
 * the target (chaos → order). burst() scatters everything outward again.
 *
 * Calm mode (reduced motion, Motion off): no drift, no pointer, no swirl;
 * nodes sit where the story puts them. The pointer is mouse only (touch is
 * calm). Links are batched into a few alpha buckets, so a frame is a handful
 * of strokes, not one per line.
 */

export type RGB = [number, number, number]

export interface NetOptions {
  count: number
  /** link distance (CSS px) between free nodes */
  link: number
  /** link distance once both nodes have condensed onto targets */
  linkTo?: number
  /** max line alpha */
  lineAlpha: number
  /** node radius range (CSS px) */
  size: [number, number]
  /** drift speed (CSS px / s) */
  speed: number
  /** pointer repel radius (CSS px); 0 = none */
  repel: number
  /** fine dust motes (no links) with magnetism toward the pointer */
  dust?: number
  /** line colour (ice by default) */
  line?: RGB
}

export interface NetNode {
  /** free (drifting) position */
  x: number
  y: number
  vx: number
  vy: number
  r: number
  /** target + pull */
  tx: number
  ty: number
  w: number
  /** repel offset */
  ox: number
  oy: number
  /** drawn position */
  px: number
  py: number
  seed: number
  spin: number
  alpha: number
  tint: number
}

interface Mote {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  a: number
  mag: number
  tx: number
  ty: number
}

const ICE: RGB = [136, 196, 255]
const TINTS: RGB[] = [
  [214, 236, 255], // ice white
  [168, 156, 255], // violet
  [255, 190, 150], // peach (rare)
]
const BUCKETS = 6
/** NaN-safe: anything not > 0 is 0 */
const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0)
const ease = (t: number) => t * t * (3 - 2 * t)

function glowSprite(rgb: RGB) {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.55)`)
  grad.addColorStop(0.35, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.16)`)
  grad.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`)
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  return c
}

export class Net2D {
  nodes: NetNode[] = []
  motes: Mote[] = []
  w = 0
  h = 0
  dpr = 1
  /** 0..1 multiplier on everything drawn */
  opacity = 1
  /**
   * Constellation-art links: pairs of node indices that join once BOTH have
   * condensed (alpha follows the pull), drawn a little brighter than the
   * distance links, so a shape is traced star to star.
   */
  chain: [number, number][] = []
  private ctx: CanvasRenderingContext2D | null
  private sprites: HTMLCanvasElement[] = []
  private bursting = false

  constructor(
    public canvas: HTMLCanvasElement,
    public o: NetOptions,
    private rand: () => number = Math.random,
  ) {
    this.ctx = canvas.getContext('2d')
    if (this.ctx) this.sprites = TINTS.map(glowSprite)
  }

  get ok() {
    return !!this.ctx
  }

  /** Match the canvas's CSS box; seeds the nodes the first time, rescales them after. */
  resize() {
    const w = Math.max(1, this.canvas.clientWidth)
    const h = Math.max(1, this.canvas.clientHeight)
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (w === this.w && h === this.h && dpr === this.dpr) return
    const sx = this.w ? w / this.w : 1
    const sy = this.h ? h / this.h : 1
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    this.dpr = dpr
    if (!this.nodes.length) {
      this.w = w
      this.h = h
      this.seed()
      return
    }
    for (const n of this.nodes) {
      n.x *= sx
      n.y *= sy
    }
    for (const m of this.motes) {
      m.x *= sx
      m.y *= sy
    }
    this.w = w
    this.h = h
  }

  private seed() {
    const R = this.rand
    const [r0, r1] = this.o.size
    for (let i = 0; i < this.o.count; i++) {
      const a = R() * Math.PI * 2
      const sp = this.o.speed * (0.4 + R() * 0.6)
      const t = R()
      this.nodes.push({
        x: R() * this.w,
        y: R() * this.h,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        r: r0 + R() * (r1 - r0),
        tx: 0,
        ty: 0,
        w: 0,
        ox: 0,
        oy: 0,
        px: 0,
        py: 0,
        seed: R(),
        spin: (R() < 0.5 ? -1 : 1) * (0.9 + R() * 0.9),
        alpha: 1,
        tint: t < 0.8 ? 0 : t < 0.96 ? 1 : 2,
      })
    }
    for (let i = 0; i < (this.o.dust ?? 0); i++) {
      this.motes.push({
        x: R() * this.w,
        y: R() * this.h,
        vx: (R() - 0.5) * 7,
        vy: (R() - 0.5) * 7,
        r: 0.5 + R() * 1.1,
        a: 0.12 + R() * 0.45,
        mag: 0.1 + R() * 4,
        tx: 0,
        ty: 0,
      })
    }
    for (const n of this.nodes) {
      n.px = n.x
      n.py = n.y
    }
  }

  /** Scatter every node outward from (cx, cy) and let go of the targets. */
  burst(cx: number, cy: number, speed = 220) {
    this.bursting = true
    const R = this.rand
    for (const n of this.nodes) {
      n.x = n.px
      n.y = n.py
      n.w = 0
      n.ox = n.oy = 0
      const dx = n.px - cx
      const dy = n.py - cy
      const d = Math.hypot(dx, dy) || 1
      const s = speed * (0.55 + R() * 0.7)
      n.vx = (dx / d) * s + (R() - 0.5) * 40
      n.vy = (dy / d) * s + (R() - 0.5) * 40
    }
  }

  /**
   * Advance the simulation. `pointer` is in CSS px (null = none / touch);
   * `calm` freezes drift, swirl and the pointer.
   */
  step(dt: number, time: number, pointer: { x: number; y: number } | null, calm: boolean) {
    const { w, h } = this
    const R = this.rand
    const repel = calm ? 0 : this.o.repel
    const base = this.o.speed
    for (const n of this.nodes) {
      if (!calm) {
        // particles.js drift: a little random walk, damped toward cruising speed
        n.vx += (R() - 0.5) * base * 1.2 * dt
        n.vy += (R() - 0.5) * base * 1.2 * dt
        const sp = Math.hypot(n.vx, n.vy)
        const cruise = this.bursting ? 0 : base
        if (sp > cruise * 1.6) {
          const k = Math.exp(-dt * (this.bursting ? 1.6 : 0.9))
          n.vx *= k
          n.vy *= k
        }
        n.x += n.vx * dt
        n.y += n.vy * dt
        if (!this.bursting) {
          if (n.x < 0 || n.x > w) {
            n.vx *= -1
            n.x = Math.max(0, Math.min(w, n.x))
          }
          if (n.y < 0 || n.y > h) {
            n.vy *= -1
            n.y = Math.max(0, Math.min(h, n.y))
          }
        }
      }
      // condense: a closing spiral from the free position onto the target
      const e = ease(clamp01(n.w))
      let px = n.x
      let py = n.y
      if (e > 0) {
        const dx = n.x - n.tx
        const dy = n.y - n.ty
        const th = calm ? 0 : (1 - e) * n.spin * 1.35
        const c = Math.cos(th)
        const s = Math.sin(th)
        const k = 1 - e
        px = n.tx + (dx * c - dy * s) * k
        py = n.ty + (dx * s + dy * c) * k
        if (!calm) {
          // a condensed node still breathes a little
          px += Math.sin(time * 0.9 + n.seed * 40) * 1.3 * e
          py += Math.cos(time * 0.7 + n.seed * 31) * 1.3 * e
        }
      }
      // mouse repulsion (an offset that springs back)
      let gx = 0
      let gy = 0
      if (repel > 0 && pointer) {
        const dx = px - pointer.x
        const dy = py - pointer.y
        const d = Math.hypot(dx, dy)
        if (d < repel && d > 0.01) {
          const f = (1 - d / repel) ** 2 * repel * 0.42
          gx = (dx / d) * f
          gy = (dy / d) * f
        }
      }
      const k = 1 - Math.exp(-dt * 7)
      n.ox += (gx - n.ox) * k
      n.oy += (gy - n.oy) * k
      n.px = px + n.ox
      n.py = py + n.oy
    }
    // dust: slow drift + magnetism toward the pointer (Particles.tsx)
    const mx = pointer && !calm ? pointer.x - w / 2 : 0
    const my = pointer && !calm ? pointer.y - h / 2 : 0
    for (const m of this.motes) {
      if (!calm) {
        m.x += m.vx * dt
        m.y += m.vy * dt
        if (m.x < -4) m.x = w + 4
        else if (m.x > w + 4) m.x = -4
        if (m.y < -4) m.y = h + 4
        else if (m.y > h + 4) m.y = -4
      }
      const k = 1 - Math.exp(-dt * 1.4)
      m.tx += ((mx * m.mag) / 50 - m.tx) * k
      m.ty += ((my * m.mag) / 50 - m.ty) * k
    }
  }

  draw() {
    const g = this.ctx
    if (!g) return
    const { dpr } = this
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, this.w, this.h)
    const op = this.opacity
    if (op <= 0.002) return
    const nodes = this.nodes
    const L0 = this.o.link
    const L1 = this.o.linkTo ?? L0
    const lc = this.o.line ?? ICE

    // links, bucketed by alpha
    const paths = Array.from({ length: BUCKETS }, () => new Path2D())
    const used = new Uint8Array(BUCKETS)
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]
      if (a.alpha <= 0.01) continue
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]
        if (b.alpha <= 0.01) continue
        const L = L0 + (L1 - L0) * Math.min(ease(clamp01(a.w)), ease(clamp01(b.w)))
        const dx = a.px - b.px
        if (dx > L || dx < -L) continue
        const dy = a.py - b.py
        if (dy > L || dy < -L) continue
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d >= L) continue
        const v = (1 - d / L) * Math.min(a.alpha, b.alpha)
        const bi = Math.min(BUCKETS - 1, Math.floor(v * BUCKETS))
        if (!(bi >= 0)) continue
        paths[bi].moveTo(a.px, a.py)
        paths[bi].lineTo(b.px, b.py)
        used[bi] = 1
      }
    }
    g.lineWidth = 1
    g.strokeStyle = `rgb(${lc[0]},${lc[1]},${lc[2]})`
    for (let b = 0; b < BUCKETS; b++) {
      if (!used[b]) continue
      g.globalAlpha = ((b + 0.5) / BUCKETS) * this.o.lineAlpha * op
      g.stroke(paths[b])
    }

    // the traced shape (chain links), bucketed by how far both ends have condensed
    if (this.chain.length) {
      const cp = Array.from({ length: BUCKETS }, () => new Path2D())
      const cu = new Uint8Array(BUCKETS)
      for (const [i, j] of this.chain) {
        const a = nodes[i]
        const b = nodes[j]
        if (!a || !b) continue
        let v = Math.min(ease(clamp01(a.w)), ease(clamp01(b.w))) * Math.min(a.alpha, b.alpha)
        if (v <= 0.02) continue
        // a link snaps in as its two stars arrive: only once it is near its final length
        const d = Math.hypot(a.px - b.px, a.py - b.py)
        const d0 = Math.hypot(a.tx - b.tx, a.ty - b.ty) || 1
        v *= clamp01(1 - (d - d0) / (d0 * 1.2))
        if (v <= 0.02) continue
        const bi = Math.min(BUCKETS - 1, Math.floor(v * BUCKETS))
        cp[bi].moveTo(a.px, a.py)
        cp[bi].lineTo(b.px, b.py)
        cu[bi] = 1
      }
      g.lineWidth = 1.25
      g.strokeStyle = 'rgb(200,228,255)'
      for (let b = 0; b < BUCKETS; b++) {
        if (!cu[b]) continue
        g.globalAlpha = ((b + 1) / BUCKETS) * 0.85 * op
        g.stroke(cp[b])
      }
      g.lineWidth = 1
    }

    // dust
    g.fillStyle = 'rgb(214,236,255)'
    for (const m of this.motes) {
      g.globalAlpha = m.a * op
      g.beginPath()
      g.arc(m.x + m.tx, m.y + m.ty, m.r, 0, Math.PI * 2)
      g.fill()
    }

    // nodes: a soft glow, then a bright core
    for (const n of nodes) {
      if (n.alpha <= 0.01) continue
      const s = n.r * 9
      g.globalAlpha = n.alpha * op
      g.drawImage(this.sprites[n.tint], n.px - s / 2, n.py - s / 2, s, s)
    }
    for (const n of nodes) {
      if (n.alpha <= 0.01) continue
      const t = TINTS[n.tint]
      g.globalAlpha = n.alpha * op
      g.fillStyle = n.tint === 0 ? '#f4f9ff' : `rgb(${t[0]},${t[1]},${t[2]})`
      g.beginPath()
      g.arc(n.px, n.py, n.r, 0, Math.PI * 2)
      g.fill()
    }
    g.globalAlpha = 1
  }
}
