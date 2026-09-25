import { rng } from '../../core/math'

/*
 * THE WORD — glyph targets for the particles that become the headline's
 * accent word. The word is set on a canvas in the headline's own face,
 * weight and tracking, and `n` points are sampled on its ink:
 *
 *   x  in em, from the word's left edge (the DOM <em>'s left edge)
 *   y  in em, up from the mid-line of the word's content box (the DOM <em>'s
 *      vertical centre: canvas fontBoundingBox metrics are the ones layout uses)
 *
 * so the particle word lands exactly on the box the DOM word will fill.
 */

export interface WordSample {
  pts: Float32Array
  /** advance width in em (tracking included, like the DOM box without padding) */
  width: number
}

export function sampleWord(text: string, n: number, o: { family: string; weight: number; tracking: number; seed?: number }): WordSample {
  const px = 160
  const cv = document.createElement('canvas')
  const g = cv.getContext('2d', { willReadFrequently: true })!
  const setup = () => {
    g.font = `${o.weight} ${px}px ${o.family}`
    // older engines ignore canvas tracking; the caller fits the width to the DOM box
    if ('letterSpacing' in g) g.letterSpacing = `${(o.tracking * px).toFixed(2)}px`
    g.textBaseline = 'alphabetic'
    g.textAlign = 'left'
    g.fillStyle = '#fff'
  }
  setup()
  const m = g.measureText(text)
  const asc = m.fontBoundingBoxAscent || px * 0.95
  const desc = m.fontBoundingBoxDescent || px * 0.25
  const pad = Math.ceil(px * 0.12)
  cv.width = Math.ceil(m.width + pad * 2 + px * 0.2)
  cv.height = Math.ceil(asc + desc + pad * 2)
  // resizing resets the context
  setup()
  const x0 = pad
  const y0 = pad + asc
  g.fillText(text, x0, y0)
  const mid = y0 - (asc - desc) / 2

  const W = cv.width
  const H = cv.height
  const data = g.getImageData(0, 0, W, H).data
  const hits: number[] = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (data[(y * W + x) * 4 + 3] > 140) hits.push(x, y)
  const r = rng(o.seed ?? 37)
  const pts = new Float32Array(n * 2)
  const count = hits.length / 2
  for (let i = 0; i < n; i++) {
    const k = count ? Math.floor(r() * count) : 0
    const x = count ? hits[k * 2] + r() : x0
    const y = count ? hits[k * 2 + 1] + r() : mid
    pts[i * 2] = (x - x0) / px
    pts[i * 2 + 1] = (mid - y) / px
  }
  return { pts, width: m.width / px }
}
