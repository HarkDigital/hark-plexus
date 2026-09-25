import { BRAND } from '../content'
import { holdInert, releaseInert } from './inert'
import { MARK_H, MARK_W, markSvg, sampleMarkOutline } from './mark'
import { Net2D } from './net2d'

/*
 * Boot screen: "the network finds its shape".
 *
 * A particles.js constellation on the night field: ~60 glowing nodes drift,
 * link to their near neighbours (alpha by distance) and shy away from the
 * mouse. As progress() rises, node after node is drawn in along a closing
 * spiral and condenses onto the outline of the Hark mark, until the whole
 * mark is drawn in linked light. A tiny mono percentage counts underneath.
 *
 * finish(): the last nodes lock in, the mark itself lights once (one soft
 * swell of white, never a strobe), then the particles burst gently outward
 * and the night field fades (~0.8 s) onto the live scene. finish() resolves
 * as the fade begins (main.ts fires 'hark:reveal', so the hero's words come
 * into focus with it); the node removes itself once it is gone.
 *
 * Rules: shows at least ~1.2 s, never hangs (every wait is a timer, never an
 * animation frame, so a background tab still finishes), the page behind is
 * inert while it's up, skip (?nointro) removes it at once. Reduced motion:
 * no drift, swirl, pointer or burst; nodes step into place and it fades.
 *
 * API used by main.ts: createLoader(root, { skip }) → { progress(0..1), finish() }.
 */

const MIN_MS = 1300
/** once finish() is called: the last nodes lock in */
const CLOSE_MS = 480
/** the mark's soft light-up */
const FLASH_MS = 260
/** the fade onto the scene (keep in step with ui.css) */
const OUT_MS = 820

const wait = (ms: number) => new Promise<void>(r => window.setTimeout(r, ms))
const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0)

/**
 * Star-to-star links that trace the mark: the diamond's four corners in a
 * ring, then each loop contour in sampling order (a long jump between two
 * samples starts a new contour; each contour closes on itself).
 */
function traceChain(pts: [number, number][]): [number, number][] {
  const out: [number, number][] = []
  if (pts.length < 8) return out
  for (let i = 0; i < 4; i++) out.push([i, (i + 1) % 4])
  const d = (a: number, b: number) => Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1])
  const gaps: number[] = []
  for (let i = 4; i < pts.length - 1; i++) gaps.push(d(i, i + 1))
  const sorted = [...gaps].sort((a, b) => a - b)
  const step = sorted[Math.floor(sorted.length / 2)] || 1
  let first = 4
  for (let i = 4; i < pts.length; i++) {
    const last = i === pts.length - 1 || d(i, i + 1) > step * 2.4
    if (!last) out.push([i, i + 1])
    else {
      if (i - first >= 2 && d(i, first) < step * 2.4) out.push([i, first])
      first = i + 1
    }
  }
  return out
}

export function createLoader(root: HTMLElement, { skip = false } = {}) {
  if (skip) {
    root.remove()
    return { progress() {}, finish: () => Promise.resolve() }
  }

  // calm under reduced motion, or when the visitor switched Motion off earlier this session
  let motionOff = false
  try {
    motionOff = sessionStorage.getItem('hark-plexus:motion') === '0'
  } catch {
    /* blocked storage */
  }
  const reduced = motionOff || matchMedia('(prefers-reduced-motion: reduce)').matches
  const mobile = matchMedia('(pointer: coarse)').matches || window.innerWidth < 768
  root.innerHTML = `
  <div class="ld${reduced ? ' is-reduced' : ''}">
    <canvas class="ld-net" aria-hidden="true"></canvas>
    <p class="sr-only" role="status">Loading ${BRAND.name}</p>
    <div class="ld-core" aria-hidden="true">
      <div class="ld-mark">${markSvg('ld-mark-svg')}</div>
      <p class="ld-pct"><span class="ld-num">0</span><span class="ld-unit">%</span></p>
    </div>
  </div>`
  holdInert('loader', [
    document.getElementById('track'),
    document.getElementById('stages'),
    document.getElementById('chrome'),
    document.querySelector<HTMLElement>('.skip-link'),
  ])

  const wrap = root.querySelector<HTMLElement>('.ld')!
  const canvas = root.querySelector<HTMLCanvasElement>('.ld-net')!
  const markBox = root.querySelector<HTMLElement>('.ld-mark')!
  const num = root.querySelector<HTMLElement>('.ld-num')!

  const COUNT = mobile ? 58 : 72
  const outline = sampleMarkOutline(COUNT)
  const net = new Net2D(canvas, {
    count: COUNT,
    link: mobile ? 104 : 138,
    lineAlpha: 0.62,
    size: [1.1, 2.3],
    speed: 16,
    repel: mobile ? 0 : 120,
    dust: mobile ? 26 : 54,
  })
  if (!net.ok) wrap.classList.add('no-canvas')
  net.chain = traceChain(outline)

  let size = 0
  let cx = 0
  let cy = 0
  const place = () => {
    net.resize()
    const r = markBox.getBoundingClientRect()
    const c = canvas.getBoundingClientRect()
    size = r.width
    cx = r.left - c.left + r.width / 2
    cy = r.top - c.top + r.height / 2
    // neighbours along the outline link up; a touch longer ties the loop bands together
    net.o.linkTo = size * 0.15
    net.nodes.forEach((n, i) => {
      const p = outline[i]
      if (p) {
        n.tx = r.left - c.left + (p[0] / MARK_W) * r.width
        n.ty = r.top - c.top + (p[1] / MARK_H) * r.height
      } else {
        // no SVG geometry: a ring stands in for the mark
        const a = (i / net.nodes.length) * Math.PI * 2
        n.tx = cx + Math.cos(a) * size * 0.42
        n.ty = cy + Math.sin(a) * size * 0.42
      }
    })
  }
  place()
  window.addEventListener('resize', place)
  // each node is pulled in on its own schedule: a staggered, swirling assembly
  const order = net.nodes.map(() => Math.random() * 0.55)

  let pointer: { x: number; y: number } | null = null
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return
    pointer = { x: e.clientX, y: e.clientY }
  }
  const onLeave = () => (pointer = null)
  window.addEventListener('pointermove', onMove, { passive: true })
  document.addEventListener('pointerleave', onLeave)

  const start = performance.now()
  let target = 0
  let shown = 0
  let finishing = false
  let bursting = false
  let lastPct = -1
  let lastT = start
  let time = 0
  let raf = 0
  let alive = true

  const apply = () => {
    for (let i = 0; i < net.nodes.length; i++) net.nodes[i].w = bursting ? 0 : clamp01((shown - (order[i] ?? 0)) / 0.4)
    const pct = Math.round(shown * 100)
    if (pct !== lastPct) {
      lastPct = pct
      num.textContent = String(pct)
    }
  }

  const frame = (ms: number) => {
    raf = 0
    if (!alive) return
    const dt = Math.min(0.05, Math.max(0, (ms - lastT) / 1000))
    lastT = ms
    time += dt
    // cosmetic easing toward the real progress; before finish() it may only
    // creep toward ~92% at the pace of the minimum time, so the mark always
    // has time to draw and 100 always means "done"
    const cap = finishing ? 1 : Math.min(0.92, ((ms - start) / MIN_MS) * 0.92)
    const goal = Math.min(finishing ? 1 : target, cap)
    shown += (goal - shown) * (1 - Math.exp(-dt * (finishing ? 7 : 3.2)))
    if (Math.abs(goal - shown) < 0.002) shown = goal
    apply()
    if (!paint(dt, reduced ? null : pointer, reduced)) return
    raf = requestAnimationFrame(frame)
  }
  // the network is decoration: if the canvas ever fails, the mark stands in
  // and boot carries on
  const paint = (dt: number, p: { x: number; y: number } | null, calm: boolean) => {
    try {
      net.step(dt, time, p, calm)
      net.draw()
      return true
    } catch (err) {
      console.warn('[hark] loader network off', err)
      wrap.classList.add('no-canvas')
      return false
    }
  }
  // paint once now, so the very first frame already shows the network
  apply()
  if (paint(0, null, true)) raf = requestAnimationFrame(frame)

  const teardown = () => {
    alive = false
    if (raf) cancelAnimationFrame(raf)
    window.removeEventListener('resize', place)
    window.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerleave', onLeave)
    root.remove()
  }

  return {
    progress(p: number) {
      const v = clamp01(Number.isFinite(p) ? p : 0)
      target = Math.max(target, v)
    },
    async finish(): Promise<void> {
      const left = MIN_MS - (performance.now() - start)
      if (left > 0) await wait(left)
      // the last nodes lock in
      finishing = true
      target = 1
      await wait(reduced ? 200 : CLOSE_MS)
      shown = 1
      apply()
      // the mark lights once (reduced motion: the traced constellation simply fades)
      if (!reduced) {
        wrap.classList.add('is-lit')
        await wait(FLASH_MS)
      }
      // the particles scatter and the night clears onto the live scene
      if (!reduced) {
        bursting = true
        net.burst(cx, cy, mobile ? 170 : 240)
      }
      wrap.classList.add('is-out')
      releaseInert('loader')
      window.setTimeout(teardown, (reduced ? 420 : OUT_MS) + 140)
      // hand over a beat into the fade, so the scene's own reveal rides it
      await wait(reduced ? 60 : 180)
    },
  }
}
