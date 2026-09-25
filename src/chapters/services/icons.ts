import { glyphShape } from '../../kit/particles'

/*
 * Nodes — the eleven service icons, drawn once on a canvas and sampled into
 * particles (kit glyphShape). Each glyph is designed in a 100 x 100 box
 * centred on 0,0 (y down): stroke only, one line weight, round caps and
 * joins, so every icon is the same visual language when it condenses out of
 * the particle stream.
 */

type Ctx = CanvasRenderingContext2D
type Pt = [number, number]

function poly(g: Ctx, pts: Pt[], close = false) {
  g.beginPath()
  g.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1])
  if (close) g.closePath()
  g.stroke()
}

function circle(g: Ctx, x: number, y: number, r: number, fill = false) {
  g.beginPath()
  g.arc(x, y, r, 0, Math.PI * 2)
  if (fill) g.fill()
  else g.stroke()
}

function rrect(g: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  g.beginPath()
  g.moveTo(x + rr, y)
  g.arcTo(x + w, y, x + w, y + h, rr)
  g.arcTo(x + w, y + h, x, y + h, rr)
  g.arcTo(x, y + h, x, y, rr)
  g.arcTo(x, y, x + w, y, rr)
  g.closePath()
  g.stroke()
}

/** a four-point sparkle (concave star) centred on x,y */
function sparkle(g: Ctx, x: number, y: number, r: number) {
  const k = r * 0.18
  g.beginPath()
  g.moveTo(x, y - r)
  g.quadraticCurveTo(x + k, y - k, x + r, y)
  g.quadraticCurveTo(x + k, y + k, x, y + r)
  g.quadraticCurveTo(x - k, y + k, x - r, y)
  g.quadraticCurveTo(x - k, y - k, x, y - r)
  g.closePath()
  g.stroke()
}

/** One glyph per service slug. */
export const GLYPHS: Record<string, (g: Ctx) => void> = {
  // </> — code
  'software-development': g => {
    poly(g, [[-18, -24], [-42, 0], [-18, 24]])
    poly(g, [[18, -24], [42, 0], [18, 24]])
    poly(g, [[9, -34], [-9, 34]])
  },
  // a browser window with a layout grid
  'web-design': g => {
    rrect(g, -44, -34, 88, 68, 8)
    poly(g, [[-44, -17], [44, -17]])
    circle(g, -34, -25.5, 2.2, true)
    circle(g, -26, -25.5, 2.2, true)
    poly(g, [[-12, -17], [-12, 34]])
    poly(g, [[-12, 8], [44, 8]])
  },
  // a cart
  ecommerce: g => {
    poly(g, [[-46, -32], [-34, -32], [-24, 12], [30, 12], [39, -20], [-30, -20]])
    circle(g, -15, 28, 6)
    circle(g, 22, 28, 6)
  },
  // a magnifier with a spark in the lens (search + generative answers)
  'seo-geo': g => {
    circle(g, -8, -8, 27)
    poly(g, [[12, 12], [40, 40]])
    sparkle(g, -8, -8, 13)
  },
  // a lightning bolt
  'page-speed': g => {
    poly(g, [[8, -46], [-24, 6], [-2, 6], [-10, 46], [24, -8], [2, -8]], true)
  },
  // AI: a large sparkle and two small ones
  'ai-consulting': g => {
    sparkle(g, -6, 6, 34)
    sparkle(g, 30, -26, 13)
    sparkle(g, 32, 30, 8)
  },
  // a quadcopter, top-down
  'aerial-media': g => {
    rrect(g, -10, -10, 20, 20, 6)
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as Pt[]) {
      poly(g, [[sx * 9, sy * 9], [sx * 21, sy * 21]])
      circle(g, sx * 30, sy * 30, 13)
      circle(g, sx * 30, sy * 30, 2.4, true)
    }
  },
  // a bandage: repair
  'hack-remediation': g => {
    g.save()
    g.rotate(-Math.PI / 4)
    rrect(g, -46, -16, 92, 32, 16)
    rrect(g, -14, -16, 28, 32, 3)
    for (const [x, y] of [
      [-30, -6],
      [-30, 6],
      [-22, 0],
      [30, -6],
      [30, 6],
      [22, 0],
    ] as Pt[])
      circle(g, x, y, 2.2, true)
    g.restore()
  },
  // a shield with a check
  security: g => {
    g.beginPath()
    g.moveTo(0, -44)
    g.bezierCurveTo(14, -34, 26, -32, 38, -31)
    g.lineTo(38, 0)
    g.bezierCurveTo(38, 22, 20, 36, 0, 46)
    g.bezierCurveTo(-20, 36, -38, 22, -38, 0)
    g.lineTo(-38, -31)
    g.bezierCurveTo(-26, -32, -14, -34, 0, -44)
    g.closePath()
    g.stroke()
    poly(g, [[-15, 2], [-4, 13], [16, -11]])
  },
  // the accessibility figure
  'ada-accessibility': g => {
    circle(g, 0, 0, 44)
    circle(g, 0, -24, 6, true)
    poly(g, [[-25, -11], [0, -6], [25, -11]])
    poly(g, [[0, -6], [0, 10]])
    poly(g, [[-14, 33], [0, 10], [14, 33]])
  },
  // W in a ring
  wordpress: g => {
    circle(g, 0, 0, 44)
    poly(g, [[-29, -17], [-16, 23], [0, -9], [16, 23], [29, -17]])
  },
}

/**
 * `n` particles on the glyph for `slug`, `size` world units across, centred
 * on the origin in the XY plane (y up), with a little depth.
 */
export function iconPoints(slug: string, n: number, size: number, seed = 3): Float32Array {
  const draw = GLYPHS[slug] ?? GLYPHS.wordpress
  return glyphShape(
    (g, w, h) => {
      g.translate(w / 2, h / 2)
      const s = w / 112
      g.scale(s, s)
      g.lineJoin = 'round'
      g.lineCap = 'round'
      g.lineWidth = 7.2
      draw(g)
    },
    n,
    { size, w: 256, h: 256, depth: size * 0.12, seed },
  )
}
