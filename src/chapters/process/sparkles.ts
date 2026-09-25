import { rng } from '../../core/math'

/*
 * Sparkles that SETTLE on the stat tiles — the particles.js look in the DOM
 * layer. A single canvas over the tiles: points drift down out of the scene
 * and come to rest along each tile's lit top edge (a few hover just above
 * it), then join into a faint constellation along the rim. The mouse nudges
 * them aside. Pure function of (local, time): no simulation state.
 */

interface Pt {
  tile: number
  /** target as a fraction of the tile width + px offset from its top edge */
  fx: number
  oy: number
  /** start offset from the target (px) */
  sx: number
  sy: number
  delay: number
  size: number
  seed: number
  sprite: number
  hover: boolean
}

const COLORS = ['#f4f7ff', '#9fd0ff', '#b3a8ff', '#ffc4a3']

function makeSprite(color: string): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = 32
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.18, color)
  grad.addColorStop(0.45, color + '55')
  grad.addColorStop(1, color + '00')
  g.fillStyle = grad
  g.fillRect(0, 0, 32, 32)
  return c
}

/** the rim constellation's line colour (ice) */
const LINK = 'rgb(159, 208, 255)'

const PAD_X = 40
const PAD_TOP = 150
const PAD_BOTTOM = 8

export class TileSparkles {
  canvas: HTMLCanvasElement
  private g: CanvasRenderingContext2D
  private sprites: HTMLCanvasElement[]
  private pts: Pt[] = []
  private rects: { x: number; y: number; w: number; h: number }[] = []
  private cw = 0
  private ch = 0
  private dpr = 1
  private clear = true
  private px = new Float32Array(0)
  private py = new Float32Array(0)
  private pa = new Float32Array(0)
  /** the canvas's viewport position (cached on resize; the stage is fixed) */
  private left = 0
  private top = 0
  private stacked = false

  constructor(
    private host: HTMLElement,
    private tiles: HTMLElement[],
    perTile: number,
    /** local where the first points start to settle (all are down ~0.087 later) */
    private settleAt = 0.79,
  ) {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'pr-sparkles'
    this.canvas.setAttribute('aria-hidden', 'true')
    host.appendChild(this.canvas)
    this.g = this.canvas.getContext('2d')!
    this.sprites = COLORS.map(makeSprite)
    const r = rng(77)
    for (let t = 0; t < tiles.length; t++) {
      for (let i = 0; i < perTile; i++) {
        const k = r()
        const hover = k > 0.72
        this.pts.push({
          tile: t,
          fx: 0.05 + r() * 0.9,
          // on the rim (a hair above/below the edge) or hovering just above it
          oy: hover ? -(5 + r() * 20) : (r() - 0.5) * 2.5,
          sx: (r() - 0.5) * 160,
          sy: -(50 + r() * 120),
          delay: r(),
          size: hover ? 8 + r() * 7 : 9 + r() * 9,
          seed: r() * 100,
          sprite: r() < 0.12 ? 3 : r() < 0.5 ? 1 : r() < 0.75 ? 2 : 0,
          hover,
        })
      }
    }
    const n = this.pts.length
    this.px = new Float32Array(n)
    this.py = new Float32Array(n)
    this.pa = new Float32Array(n)
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.measure()).observe(host)
    window.addEventListener('resize', () => this.measure())
    this.measure()
  }

  /** layout reads: only on resize */
  measure() {
    const w = this.host.offsetWidth + PAD_X * 2
    const h = this.host.offsetHeight + PAD_TOP + PAD_BOTTOM
    this.dpr = Math.min(2, window.devicePixelRatio || 1)
    this.cw = w
    this.ch = h
    this.canvas.width = Math.max(1, Math.round(w * this.dpr))
    this.canvas.height = Math.max(1, Math.round(h * this.dpr))
    const b = this.host.getBoundingClientRect()
    this.left = b.left - PAD_X
    this.top = b.top - PAD_TOP
    this.rects = this.tiles.map(t => ({ x: t.offsetLeft + PAD_X, y: t.offsetTop + PAD_TOP, w: t.offsetWidth, h: t.offsetHeight }))
    // stacked tiles (portrait): everything settles on the top rim of the stack,
    // never in the gaps between tiles (it would sit on the text above)
    this.stacked = this.rects.length > 1 && this.rects[1].y > this.rects[0].y + 8
    this.clear = false
  }

  /**
   * vis: 0..1 visibility · settle: local-driven 0..1 base (per-point delays
   * spread it) · time: seconds (frozen when motion is off) · pointer: CSS px
   * in viewport space or null · calm: reduced motion (settled, still)
   */
  draw(vis: number, local: number, time: number, pointer: { x: number; y: number } | null, calm: boolean) {
    const g = this.g
    if (vis <= 0.001 || !this.rects.length) {
      if (!this.clear) {
        g.setTransform(1, 0, 0, 1, 0, 0)
        g.clearRect(0, 0, this.canvas.width, this.canvas.height)
        this.clear = true
      }
      return
    }
    this.clear = false
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.clearRect(0, 0, this.cw, this.ch)
    let ox = 0
    let oy = 0
    if (pointer) {
      ox = pointer.x - this.left
      oy = pointer.y - this.top
    }
    const pts = this.pts
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      const R = this.rects[this.stacked ? 0 : p.tile]
      const tx = R.x + p.fx * R.w
      const ty = R.y + p.oy
      const raw = calm ? (local > this.settleAt + 0.01 ? 1 : 0) : Math.min(1, Math.max(0, (local - (this.settleAt + p.delay * 0.045)) / 0.042))
      const e = 1 - Math.pow(1 - raw, 3)
      let x = tx + p.sx * (1 - e) + Math.sin(e * Math.PI) * 14 * Math.sin(p.seed)
      let y = ty + p.sy * (1 - e)
      if (!calm && p.hover) {
        x += Math.sin(time * 0.6 + p.seed) * 3
        y += Math.cos(time * 0.5 + p.seed * 1.3) * 2.5
      }
      if (pointer) {
        const dx = x - ox
        const dy = y - oy
        const d = Math.sqrt(dx * dx + dy * dy)
        if (d < 80 && d > 0.01) {
          const f = (1 - d / 80) * (1 - d / 80) * 22
          x += (dx / d) * f
          y += (dy / d) * f
        }
      }
      const tw = calm ? 0.85 : 0.6 + 0.4 * Math.sin(time * (1.1 + (p.seed % 1) * 1.8) + p.seed)
      const a = Math.min(1, raw * 4) * (0.4 + 0.6 * e) * tw * vis
      this.px[i] = x
      this.py[i] = y
      this.pa[i] = raw >= 1 ? a : 0
      if (a < 0.01) continue
      g.globalAlpha = a
      const s = p.size
      g.drawImage(this.sprites[p.sprite], x - s / 2, y - s / 2, s, s)
    }
    // a faint constellation along each rim (settled points only; alpha per
    // line through globalAlpha, so no colour string is built per frame)
    g.lineWidth = 0.75
    g.strokeStyle = LINK
    const L = 46
    for (let i = 0; i < pts.length; i++) {
      if (this.pa[i] < 0.02) continue
      for (let j = i + 1; j < pts.length; j++) {
        if (!this.stacked && pts[j].tile !== pts[i].tile) break
        if (this.pa[j] < 0.02) continue
        const dx = this.px[i] - this.px[j]
        const dy = this.py[i] - this.py[j]
        const d2 = dx * dx + dy * dy
        if (d2 > L * L) continue
        g.globalAlpha = (1 - Math.sqrt(d2) / L) * 0.55 * Math.min(this.pa[i], this.pa[j])
        g.beginPath()
        g.moveTo(this.px[i], this.py[i])
        g.lineTo(this.px[j], this.py[j])
        g.stroke()
      }
    }
  }
}
