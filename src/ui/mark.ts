import { SITE } from '../content'
import { MARK_SVG } from '../logo/svgSource'

/*
 * The Hark mark as inline-SVG path data for the DOM layer (chrome, loader,
 * rotate card, fallback). Pulled from the same Illustrator source the 3D
 * geometry uses, minus the three hairline slivers. The rotated <rect> diamond
 * is baked into a plain path so it can be stroked / sampled like the loops.
 *
 * The brand is the monochrome mark: it is always drawn white here. Plexus's
 * ice / violet accents live around it (the chrome's node lens, the loader's
 * constellation), never in it.
 */

export const MARK_VIEWBOX = '0 0 1889.6 1889.9'
export const MARK_W = 1889.6
export const MARK_H = 1889.9

function parseMark() {
  const loops = [...MARK_SVG.matchAll(/<path d="([^"]+)"/g)].map(m => m[1]).filter(d => d.length > 200)

  // <rect x y w h transform="translate(tx ty) rotate(-45)">
  const r = MARK_SVG.match(
    /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" transform="translate\(([-\d.]+) ([-\d.]+)\) rotate\(([-\d.]+)\)"/,
  )
  let diamond = ''
  let corners: [number, number][] = []
  if (r) {
    const [x, y, w, h, tx, ty, deg] = r.slice(1).map(Number)
    const a = (deg * Math.PI) / 180
    const c = Math.cos(a)
    const s = Math.sin(a)
    corners = [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ].map(([px, py]) => [px * c - py * s + tx, px * s + py * c + ty] as [number, number])
    diamond = `M${corners.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('L')}Z`
  }
  return { loops, diamond, corners }
}

export const MARK_PATHS = parseMark()

/**
 * The real wordmark, "Hark.Digital" (BRAND.short): the dot is a tiny lit
 * node of the network. The period stays in the markup (clipped) so
 * copy/paste and find-in-page still read "Hark.Digital". Styled by the .wm
 * rules in ui.css.
 */
export const WORDMARK = `<span class="wm"><span class="wm-a">Hark</span><span class="wm-dot">.</span><span class="wm-b">Digital</span></span>`

/** This site is a concept direction, not a rebrand: a small tag, never part of the name. */
export const CONCEPT_TAG = `<span class="wm-tag"><span class="wm-tag-k">Concept</span><b aria-hidden="true">·</b><em>${SITE.name}</em></span>`

/** Inline SVG markup for the mark: loops and diamond fill with currentColor (white). */
export function markSvg(className = '', { title }: { title?: string } = {}) {
  const a11y = title ? `role="img" aria-label="${title}"` : 'aria-hidden="true" focusable="false"'
  return `<svg class="${className}" viewBox="${MARK_VIEWBOX}" ${a11y} xmlns="http://www.w3.org/2000/svg">${MARK_PATHS.loops
    .map(d => `<path class="mk-loop" d="${d}"/>`)
    .join('')}<path class="mk-diamond" d="${MARK_PATHS.diamond}"/></svg>`
}

/**
 * Points along the mark's outline, in viewBox units (0..MARK_W, 0..MARK_H).
 * The diamond gets its four corners; the loops share the rest, spaced evenly
 * by arc length over every contour (outer edges and holes). Sampled with the
 * browser's own SVG geometry (getPointAtLength), so no 3D code is pulled into
 * the boot bundle. Returns [] if the browser can't measure SVG paths.
 */
export function sampleMarkOutline(count: number): [number, number][] {
  const out: [number, number][] = MARK_PATHS.corners.map(c => [c[0], c[1]])
  const n = Math.max(0, count - out.length)
  if (!n || typeof document === 'undefined') return out
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', MARK_VIEWBOX)
  svg.setAttribute('aria-hidden', 'true')
  svg.style.cssText = 'position:absolute;left:-9999px;top:0;width:10px;height:10px;visibility:hidden;pointer-events:none'
  const paths = MARK_PATHS.loops.map(d => {
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('d', d)
    svg.appendChild(p)
    return p
  })
  document.body.appendChild(svg)
  try {
    const lens = paths.map(p => p.getTotalLength())
    const total = lens.reduce((a, b) => a + b, 0)
    if (!(total > 0)) return out
    const step = total / n
    let pi = 0
    let acc = 0
    for (let i = 0; i < n; i++) {
      const at = (i + 0.5) * step
      while (pi < paths.length - 1 && acc + lens[pi] < at) {
        acc += lens[pi]
        pi++
      }
      const pt = paths[pi].getPointAtLength(Math.min(lens[pi], at - acc))
      out.push([pt.x, pt.y])
    }
  } catch {
    /* no SVG geometry: the loader falls back to a ring */
  } finally {
    svg.remove()
  }
  return out
}
