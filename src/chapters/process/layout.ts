import { rng } from '../../core/math'

/*
 * FLOW (process) — the shapes the one particle system passes through, built
 * on the CPU once at init. Everything here is in FORM-LOCAL units (x right,
 * y up, +z toward the viewer) unless noted; the shader places each form in
 * front of its glass pane.
 *
 *   chaos   noise in a big box (world units)             — before Listen
 *   wave    a multi-strand sound wave (procedural)       — 01 Listen
 *   wire    a web page wireframe + its design grid       — 02 Prototype
 *   blocks  the same page, filled into dense blocks      — 03 Build
 *   ring    an orbit around the finished form            — 04 Support
 *   stream  one flow through all four panes (procedural) — results
 *
 * Consecutive shapes are ALIGNED (particle i keeps a similar place in each),
 * so the layout travels intact and tightens, the blocks unwind into the ring
 * in order, and the ring unspools into the stream by angle.
 */

/** the page (a browser window) that Prototype draws and Build fills */
export const PAGE_W = 1.9
export const PAGE_H = 1.35

/** axis-aligned rects in form-local units: [x0, y0, x1, y1] */
export type Rect = [number, number, number, number]

/** the glass slabs Build leaves behind (header, image, three cards) */
export const SLABS: Rect[] = [
  [-0.95, 0.5, 0.95, 0.675],
  [0.12, -0.2, 0.82, 0.38],
  [-0.82, -0.6, -0.3, -0.3],
  [-0.26, -0.6, 0.26, -0.3],
  [0.3, -0.6, 0.82, -0.3],
]
/** the call-to-action button (peach — the one warm accent) */
const BUTTON: Rect = [-0.82, -0.13, -0.48, -0.03]
/** hero headline bars and body lines */
const BARS: Rect[] = [
  [-0.82, 0.265, 0.02, 0.335],
  [-0.82, 0.16, -0.22, 0.23],
]
const LINES: Rect[] = [
  [-0.82, 0.075, -0.08, 0.095],
  [-0.82, 0.025, -0.3, 0.045],
]

export interface FlowData {
  n: number
  /** world-space chaos positions (the 'position' attribute) */
  chaos: Float32Array
  /** wave params: x (-1..1), strand (0..1), jitter (-1..1) */
  wave: Float32Array
  /** form-local positions */
  wire: Float32Array
  blocks: Float32Array
  /** ring params: angle0, radial jitter, vertical jitter */
  ring: Float32Array
  /** stream params: u0 (0..1), tube angle, tube radius */
  stream: Float32Array
  rand: Float32Array
  /** x: wire role (0 line, 1 grid, 2 button) · y: block role (0 slab, 1 button, 2 text) · z: stays in the product (0/1) · w: unused */
  role: Float32Array
}

const RES = 280 // canvas px per form unit

/** sample `n` points from a canvas drawing in form units (white on transparent) */
function sampleDrawing(draw: (g: CanvasRenderingContext2D, u: (x: number) => number, v: (y: number) => number, s: number) => void, n: number, r: () => number): Float32Array {
  const W = Math.round(PAGE_W * RES) + 8
  const H = Math.round(PAGE_H * RES) + 8
  const cv = document.createElement('canvas')
  cv.width = W
  cv.height = H
  const g = cv.getContext('2d', { willReadFrequently: true })!
  g.fillStyle = '#fff'
  g.strokeStyle = '#fff'
  g.lineCap = 'round'
  g.lineJoin = 'round'
  const u = (x: number) => (x + PAGE_W / 2) * RES + 4
  const v = (y: number) => (PAGE_H / 2 - y) * RES + 4
  draw(g, u, v, RES)
  const data = g.getImageData(0, 0, W, H).data
  const hits: number[] = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (data[(y * W + x) * 4 + 3] > 110) hits.push(x, y)
  const out = new Float32Array(n * 2)
  const count = hits.length / 2
  for (let i = 0; i < n; i++) {
    const k = count ? Math.floor(r() * count) : 0
    const px = count ? hits[k * 2] + r() : W / 2
    const py = count ? hits[k * 2 + 1] + r() : H / 2
    out[i * 2] = (px - 4) / RES - PAGE_W / 2
    out[i * 2 + 1] = PAGE_H / 2 - (py - 4) / RES
  }
  return out
}

function roundRect(g: CanvasRenderingContext2D, u: (x: number) => number, v: (y: number) => number, [x0, y0, x1, y1]: Rect, rad: number, s: number) {
  const x = u(x0)
  const y = v(y1)
  const w = (x1 - x0) * s
  const h = (y1 - y0) * s
  const r = Math.min(rad * s, w / 2, h / 2)
  g.beginPath()
  g.moveTo(x + r, y)
  g.arcTo(x + w, y, x + w, y + h, r)
  g.arcTo(x + w, y + h, x, y + h, r)
  g.arcTo(x, y + h, x, y, r)
  g.arcTo(x, y, x + w, y, r)
  g.closePath()
}

/** the prototype: a browser window drawn in hairlines (without the button) */
function drawWire(g: CanvasRenderingContext2D, u: (x: number) => number, v: (y: number) => number, s: number) {
  const lw = 0.011 * s
  g.lineWidth = lw
  // window + header rule
  roundRect(g, u, v, [-PAGE_W / 2 + 0.01, -PAGE_H / 2 + 0.01, PAGE_W / 2 - 0.01, PAGE_H / 2 - 0.01], 0.07, s)
  g.stroke()
  g.beginPath()
  g.moveTo(u(-0.94), v(0.5))
  g.lineTo(u(0.94), v(0.5))
  g.stroke()
  // traffic lights, address pill, nav
  for (let i = 0; i < 3; i++) {
    g.beginPath()
    g.arc(u(-0.86 + i * 0.055), v(0.588), 0.017 * s, 0, Math.PI * 2)
    g.fill()
  }
  roundRect(g, u, v, [-0.6, 0.555, 0.12, 0.62], 0.03, s)
  g.stroke()
  for (const [a, b] of [
    [0.36, 0.48],
    [0.54, 0.66],
    [0.72, 0.84],
  ]) {
    g.beginPath()
    g.moveTo(u(a), v(0.588))
    g.lineTo(u(b), v(0.588))
    g.stroke()
  }
  // hero: headline bars (outlined), body lines
  for (const b of BARS) {
    roundRect(g, u, v, b, 0.03, s)
    g.stroke()
  }
  for (const [x0, , x1, y1] of LINES) {
    g.beginPath()
    g.moveTo(u(x0), v(y1 - 0.01))
    g.lineTo(u(x1), v(y1 - 0.01))
    g.stroke()
  }
  // image placeholder: frame, cross, sun, hills
  const [ix0, iy0, ix1, iy1] = SLABS[1]
  roundRect(g, u, v, SLABS[1], 0.03, s)
  g.stroke()
  g.save()
  g.globalAlpha = 0.9
  g.beginPath()
  g.moveTo(u(ix0), v(iy1))
  g.lineTo(u(ix1), v(iy0))
  g.moveTo(u(ix0), v(iy0))
  g.lineTo(u(ix1), v(iy1))
  g.stroke()
  g.restore()
  g.beginPath()
  g.arc(u(0.66), v(0.26), 0.05 * s, 0, Math.PI * 2)
  g.stroke()
  // three cards, each with a title line
  for (let i = 2; i < 5; i++) {
    const c = SLABS[i]
    roundRect(g, u, v, c, 0.03, s)
    g.stroke()
    g.beginPath()
    g.moveTo(u(c[0] + 0.06), v(c[3] - 0.08))
    g.lineTo(u(c[0] + 0.3), v(c[3] - 0.08))
    g.moveTo(u(c[0] + 0.06), v(c[3] - 0.15))
    g.lineTo(u(c[2] - 0.1), v(c[3] - 0.15))
    g.stroke()
  }
}

function drawButtonWire(g: CanvasRenderingContext2D, u: (x: number) => number, v: (y: number) => number, s: number) {
  g.lineWidth = 0.013 * s
  roundRect(g, u, v, BUTTON, 0.05, s)
  g.stroke()
  // the label inside the button
  g.beginPath()
  g.moveTo(u(BUTTON[0] + 0.07), v((BUTTON[1] + BUTTON[3]) / 2))
  g.lineTo(u(BUTTON[2] - 0.07), v((BUTTON[1] + BUTTON[3]) / 2))
  g.stroke()
}

/**
 * Even fill of rects (a jittered grid per rect, cells shaped to the rect so
 * thin bars stay even too), area-weighted: dense blocks read as SOLID, not as
 * static. `pill` keeps points inside a capsule.
 */
function evenFill(rects: Rect[], n: number, seed: number, pill = false): Float32Array {
  const out = new Float32Array(n * 2)
  const areas = rects.map(([x0, y0, x1, y1]) => (x1 - x0) * (y1 - y0))
  const total = areas.reduce((a, b) => a + b, 0)
  const r = rng(seed * 31 + 5)
  let i = 0
  for (let q = 0; q < rects.length && i < n; q++) {
    const want = q === rects.length - 1 ? n - i : Math.min(n - i, Math.round((n * areas[q]) / total))
    const [x0, y0, x1, y1] = rects[q]
    const w = x1 - x0
    const h = y1 - y0
    // a capsule loses its corners: ask for a few more cells than we keep
    const cellsWanted = pill ? Math.ceil(want * 1.3) : want
    const cols = Math.max(1, Math.round(Math.sqrt((cellsWanted * w) / h)))
    const rows = Math.max(1, Math.ceil(cellsWanted / cols))
    const cells: number[] = []
    for (let c = 0; c < cols * rows; c++) {
      const cx = x0 + ((c % cols) + 0.5) * (w / cols)
      const cy = y0 + (Math.floor(c / cols) + 0.5) * (h / rows)
      if (pill) {
        const rr = h / 2
        const px = Math.min(x1 - rr, Math.max(x0 + rr, cx))
        if ((cx - px) ** 2 + (cy - (y0 + rr)) ** 2 > rr * rr) continue
      }
      cells.push(c)
    }
    // shuffle, keep `want` (repeat cells if a capsule came up short)
    for (let a = cells.length - 1; a > 0; a--) {
      const b = Math.floor(r() * (a + 1))
      const t = cells[a]
      cells[a] = cells[b]
      cells[b] = t
    }
    for (let k = 0; k < want && cells.length; k++, i++) {
      const c = cells[k % cells.length]
      out[i * 2] = x0 + ((c % cols) + 0.15 + r() * 0.7) * (w / cols)
      out[i * 2 + 1] = y0 + (Math.floor(c / cols) + 0.15 + r() * 0.7) * (h / rows)
    }
  }
  for (; i < n; i++) {
    out[i * 2] = (rects[0][0] + rects[0][2]) / 2
    out[i * 2 + 1] = (rects[0][1] + rects[0][3]) / 2
  }
  return out
}

/** argsort (stable enough for our use) */
function argsort(keys: Float32Array): Uint32Array {
  const idx = new Uint32Array(keys.length)
  for (let i = 0; i < idx.length; i++) idx[i] = i
  idx.sort((a, b) => keys[a] - keys[b])
  return idx
}

/**
 * For particles `who` (indices), whose current key is prevKey(i), pick
 * points from `pool` (indices into the next shape, keyed by nextKey) so that
 * rank order is preserved. Returns next-shape index per particle.
 */
function alignSubset(who: Uint32Array, prevKey: (i: number) => number, pool: Uint32Array, nextKey: (j: number) => number): Map<number, number> {
  const a = new Float32Array(who.length)
  for (let i = 0; i < who.length; i++) a[i] = prevKey(who[i])
  const b = new Float32Array(pool.length)
  for (let j = 0; j < pool.length; j++) b[j] = nextKey(pool[j])
  const ra = argsort(a)
  const rb = argsort(b)
  const out = new Map<number, number>()
  for (let r = 0; r < who.length; r++) out.set(who[ra[r]], pool[rb[Math.min(rb.length - 1, Math.floor((r * rb.length) / who.length))]])
  return out
}

/** Hilbert index on a 256 grid (spatial locality for the wire → blocks match) */
function hilbert(xf: number, yf: number): number {
  const n = 256
  let x = Math.max(0, Math.min(n - 1, Math.floor(((xf + PAGE_W / 2) / PAGE_W) * n)))
  let y = Math.max(0, Math.min(n - 1, Math.floor(((yf + PAGE_H / 2) / PAGE_H) * n)))
  let d = 0
  for (let s = n >> 1; s > 0; s >>= 1) {
    const rx = (x & s) > 0 ? 1 : 0
    const ry = (y & s) > 0 ? 1 : 0
    d += s * s * ((3 * rx) ^ ry)
    if (ry === 0) {
      if (rx === 1) {
        x = n - 1 - x
        y = n - 1 - y
      }
      const t = x
      x = y
      y = t
    }
  }
  return d
}

export interface ChaosBox {
  min: [number, number, number]
  max: [number, number, number]
}

/** Build every shape for `n` particles. Cheap (tens of ms for 10k). */
export function buildFlow(n: number, box: ChaosBox, seed = 41): FlowData {
  const r = rng(seed)
  const rand = new Float32Array(n * 4)
  for (let i = 0; i < rand.length; i++) rand[i] = r()
  const role = new Float32Array(n * 4)

  // ---- chaos (world units): eddies and filaments of noise, not an even fog
  const chaos = new Float32Array(n * 3)
  const EDDIES = 26
  const eddy: number[] = []
  for (let e = 0; e < EDDIES; e++) {
    for (let a = 0; a < 3; a++) eddy.push(box.min[a] + (0.1 + r() * 0.8) * (box.max[a] - box.min[a]))
    eddy.push(0.25 + r() * 0.65) // spread
    eddy.push(r() * Math.PI) // filament direction
  }
  const gauss = () => (r() + r() + r() - 1.5) / 1.5
  for (let i = 0; i < n; i++) {
    if (r() < 0.34) {
      for (let a = 0; a < 3; a++) chaos[i * 3 + a] = box.min[a] + r() * (box.max[a] - box.min[a])
      continue
    }
    const e = Math.floor(r() * EDDIES) * 5
    const sp = eddy[e + 3]
    // stretched along a direction: wisps rather than balls
    const along = gauss() * sp * 2.2
    const dir = eddy[e + 4]
    chaos[i * 3] = eddy[e] + Math.cos(dir) * along + gauss() * sp * 0.5
    chaos[i * 3 + 1] = eddy[e + 1] + Math.sin(dir) * along * 0.6 + gauss() * sp * 0.45
    chaos[i * 3 + 2] = eddy[e + 2] + gauss() * sp
  }

  // ---- wave: x, strand, jitter — matched to chaos by x (left stays left)
  const STRANDS = 5
  const waveRaw = new Float32Array(n * 3)
  for (let j = 0; j < n; j++) {
    // a little denser toward the middle, where the wave is loudest
    const t = r() * 2 - 1
    waveRaw[j * 3] = Math.sign(t) * Math.pow(Math.abs(t), 1.15)
    waveRaw[j * 3 + 1] = Math.floor(r() * STRANDS) / (STRANDS - 1)
    waveRaw[j * 3 + 2] = r() * 2 - 1
  }
  const all = new Uint32Array(n)
  for (let i = 0; i < n; i++) all[i] = i
  const mWave = alignSubset(all, i => chaos[i * 3], all, j => waveRaw[j * 3])
  const wave = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const j = mWave.get(i)!
    wave[i * 3] = waveRaw[j * 3]
    wave[i * 3 + 1] = waveRaw[j * 3 + 1]
    wave[i * 3 + 2] = waveRaw[j * 3 + 2]
  }

  // ---- wire: hairlines + button + a fine design grid — matched to the wave by x
  const nGrid = Math.round(n * 0.12)
  const nButton = Math.round(n * 0.05)
  const nLine = n - nGrid - nButton
  const wirePts = new Float32Array(n * 3)
  const wireRole = new Float32Array(n)
  const lines = sampleDrawing(drawWire, nLine, r)
  for (let j = 0; j < nLine; j++) {
    wirePts[j * 3] = lines[j * 2]
    wirePts[j * 3 + 1] = lines[j * 2 + 1]
    wirePts[j * 3 + 2] = (r() - 0.5) * 0.02
  }
  const btn = sampleDrawing(drawButtonWire, nButton, r)
  for (let k = 0; k < nButton; k++) {
    const j = nLine + k
    wirePts[j * 3] = btn[k * 2]
    wirePts[j * 3 + 1] = btn[k * 2 + 1]
    wirePts[j * 3 + 2] = (r() - 0.5) * 0.02
    wireRole[j] = 2
  }
  // the design grid: evenly spaced dots inside the window
  const cols = Math.max(4, Math.round(Math.sqrt((nGrid * PAGE_W) / PAGE_H)))
  const rows = Math.max(3, Math.ceil(nGrid / cols))
  for (let k = 0; k < nGrid; k++) {
    const j = nLine + nButton + k
    const c = k % cols
    const rr = Math.floor(k / cols)
    wirePts[j * 3] = (c / (cols - 1) - 0.5) * (PAGE_W - 0.16)
    wirePts[j * 3 + 1] = (0.5 - rr / Math.max(1, rows - 1)) * (PAGE_H - 0.16)
    wirePts[j * 3 + 2] = -0.02
    wireRole[j] = 1
  }
  const mWire = alignSubset(all, i => wave[i * 3], all, j => wirePts[j * 3])
  const wire = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const j = mWire.get(i)!
    wire[i * 3] = wirePts[j * 3]
    wire[i * 3 + 1] = wirePts[j * 3 + 1]
    wire[i * 3 + 2] = wirePts[j * 3 + 2]
    role[i * 4] = wireRole[j]
  }

  // ---- blocks: the button stays the button; everything else by Hilbert order
  const blocks = new Float32Array(n * 3)
  const btnWho: number[] = []
  const restWho: number[] = []
  for (let i = 0; i < n; i++) (role[i * 4] === 2 ? btnWho : restWho).push(i)
  const bFill = evenFill([BUTTON], btnWho.length, 3, true)
  const nText = Math.round(restWho.length * 0.11)
  const nSlab = restWho.length - nText
  const sFill = evenFill(SLABS, nSlab, 1)
  const tFill = evenFill([...BARS, ...LINES], nText, 2)
  const restPts = new Float32Array(restWho.length * 3)
  const restRole = new Float32Array(restWho.length)
  for (let k = 0; k < nSlab; k++) {
    restPts[k * 3] = sFill[k * 2]
    restPts[k * 3 + 1] = sFill[k * 2 + 1]
    // inside the slab's thickness, biased toward its front face
    restPts[k * 3 + 2] = -0.04 + Math.sqrt(r()) * 0.12
  }
  for (let k = 0; k < nText; k++) {
    const j = nSlab + k
    restPts[j * 3] = tFill[k * 2]
    restPts[j * 3 + 1] = tFill[k * 2 + 1]
    restPts[j * 3 + 2] = 0.02 + r() * 0.03
    restRole[j] = 2
  }
  const restIdx = new Uint32Array(restWho.length)
  for (let k = 0; k < restIdx.length; k++) restIdx[k] = k
  const mBlocks = alignSubset(
    Uint32Array.from(restWho),
    i => hilbert(wire[i * 3], wire[i * 3 + 1]),
    restIdx,
    j => hilbert(restPts[j * 3], restPts[j * 3 + 1]),
  )
  for (const i of restWho) {
    const j = mBlocks.get(i)!
    blocks[i * 3] = restPts[j * 3]
    blocks[i * 3 + 1] = restPts[j * 3 + 1]
    blocks[i * 3 + 2] = restPts[j * 3 + 2]
    role[i * 4 + 1] = restRole[j]
  }
  btnWho.forEach((i, k) => {
    blocks[i * 3] = bFill[k * 2]
    blocks[i * 3 + 1] = bFill[k * 2 + 1]
    blocks[i * 3 + 2] = 0.03 + r() * 0.04
    role[i * 4 + 1] = 1
  })

  // ---- ring: ~9% of the slab particles stay as the product's inner light;
  // the rest unwind into the orbit by angle
  const ringWho: number[] = []
  for (let i = 0; i < n; i++) {
    if (role[i * 4 + 1] === 0 && rand[i * 4 + 3] < 0.09) role[i * 4 + 2] = 1
    else ringWho.push(i)
  }
  const ringRaw = new Float32Array(ringWho.length * 3)
  for (let k = 0; k < ringWho.length; k++) {
    ringRaw[k * 3] = r() * Math.PI * 2
    const rad = r() + r() - 1 // triangular: a crisp core with a soft spread
    ringRaw[k * 3 + 1] = rad * 0.09
    ringRaw[k * 3 + 2] = (r() + r() - 1) * 0.05
  }
  const ringIdx = new Uint32Array(ringWho.length)
  for (let k = 0; k < ringIdx.length; k++) ringIdx[k] = k
  const mRing = alignSubset(
    Uint32Array.from(ringWho),
    i => Math.atan2(blocks[i * 3 + 1], blocks[i * 3]),
    ringIdx,
    j => ((ringRaw[j * 3] + Math.PI) % (Math.PI * 2)) - Math.PI,
  )
  const ring = new Float32Array(n * 3)
  for (const i of ringWho) {
    const j = mRing.get(i)!
    ring[i * 3] = ringRaw[j * 3]
    ring[i * 3 + 1] = ringRaw[j * 3 + 1]
    ring[i * 3 + 2] = ringRaw[j * 3 + 2]
  }

  // ---- stream: the ring unspools into the flow by angle
  const streamRaw = new Float32Array(ringWho.length * 3)
  for (let k = 0; k < ringWho.length; k++) {
    streamRaw[k * 3] = r()
    streamRaw[k * 3 + 1] = r() * Math.PI * 2
    const t = r()
    streamRaw[k * 3 + 2] = 0.02 + t * t * 0.26
  }
  const mStream = alignSubset(Uint32Array.from(ringWho), i => ring[i * 3], ringIdx, j => streamRaw[j * 3])
  const stream = new Float32Array(n * 3)
  for (const i of ringWho) {
    const j = mStream.get(i)!
    stream[i * 3] = streamRaw[j * 3]
    stream[i * 3 + 1] = streamRaw[j * 3 + 1]
    stream[i * 3 + 2] = streamRaw[j * 3 + 2]
  }

  return { n, chaos, wave, wire, blocks, ring, stream, rand, role }
}
