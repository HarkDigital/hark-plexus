import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { el, reveal, rise, setRise } from '../../core/dom'
import { clamp, ease, lerp, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { SECTIONS, WORK, workImage, type WorkItem } from '../../content'
import { G } from '../../kit/glass'
import { loadScreenshot, whenRevealed } from '../../kit/images'
import { EDGES, LIST_CENTRE, NE, STAR_POS, TH, TILE_POS, TW, buildConstellation, listPos, type Constellation } from './scene'
import './work.css'

/*
 * CONSTELLATION (Selected work) — the portfolio as a constellation of glass.
 *
 * Six featured projects are thin glass tiles floating in a loose zig-zag, the
 * bright stars of a constellation: each holds its site's screenshot just
 * inside the front face and refracts the living network behind it. Glowing
 * links join them (plugged into each tile's glass rim), and a signal of
 * particles flows along every link in story order (01 → 06). Nine small stars
 * (the rest of the portfolio) hang around the chain as twinkling clusters.
 *
 *   0.000–0.140  intro: the particles swirl in and condense onto the links
 *                (under the cut), then a pulse of light runs star to star
 *                behind "Built to be heard." (lands at 0.06 / 0.12)
 *   0.140–0.790  six items (~0.108 each): glide 0–34%, the tile turns to face
 *                the camera 6–42%, a light sweep crosses it 16–62%; its links
 *                brighten and the signal speeds up, the others dim; a frosted
 *                card names it 17–99%. The pointer tilts the tile and parts
 *                the particles (mouse only).
 *   0.790–0.830  the constellation draws together into a compact map as the
 *                camera pulls back (a brief focus pull)
 *   0.830–0.956  "Nine more, all live.": the list; the nine stars are named in
 *                space, the chosen one (scroll row, or hover a row / a star)
 *                blooms with an orbit ring, its links light, and a small glass
 *                card beside it shows the site
 *   0.956–1.000  out: a slow pull back and up
 *
 * Everything story-shaped derives from `local`. frame.time drives only the
 * ambient life (float, twinkle, the flow along the links), so Motion off /
 * reduced motion hold it still.
 */

const FEATURED = WORK.filter(w => w.featured)
const REST = WORK.filter(w => !w.featured)
const NF = FEATURED.length
const NR = REST.length

const F0 = 0.14
const F1 = 0.79
const SPAN = (F1 - F0) / NF
const LIST_IN = 0.83
const ROW0 = 0.836
const ROW1 = 0.946
const LIST_OUT = 0.956

/* inside one item (phase p 0..1) */
const TRAVEL = 0.34
const TURN_A = 0.06
const TURN_B = 0.42
const SWEEP_A = 0.16
const SWEEP_B = 0.62

const itemStart = (k: number) => F0 + SPAN * k
const T0A = F0 - 0.014
const TRAVEL0 = 0.22
const T0B = F0 + TRAVEL0 * SPAN
const rowAt = (j: number) => ROW0 + ((j + 0.5) * (ROW1 - ROW0)) / NR

const settle = (t: number) => 1 - Math.pow(1 - clamp(t), 4)

const FOV = 32
const DEG = Math.PI / 180
const UP = new THREE.Vector3(0, 1, 0)
const ENV = 1.15

const WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve']
const pad = (n: number) => String(n).padStart(2, '0')
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const emLast = (s: string) => {
  const parts = s.split(' ')
  if (parts.length < 2) return `<em>${esc(s)}</em>`
  const last = parts.pop()!
  return `${esc(parts.join(' '))} <em>${esc(last)}</em>`
}
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
/** City Line Capital (harktest.com) is a pre-launch build: never signal it as live. */
const isPreview = (url: string) => {
  try {
    return /(^|\.)harktest\.com$/i.test(new URL(url).hostname)
  } catch {
    return false
  }
}

type PhaseKind = 'intro' | 'item' | 'list' | 'out'
interface Phase {
  kind: PhaseKind
  k: number
  p: number
}
function phaseOf(l: number): Phase {
  if (l < F0) return { kind: 'intro', k: -1, p: clamp(l / F0) }
  if (l < F1) {
    const k = Math.min(NF - 1, Math.floor((l - F0) / SPAN))
    return { kind: 'item', k, p: clamp((l - itemStart(k)) / SPAN) }
  }
  if (l < LIST_OUT) return { kind: 'list', k: NF, p: clamp((l - F1) / (LIST_OUT - F1)) }
  return { kind: 'out', k: NF, p: clamp((l - LIST_OUT) / (1 - LIST_OUT)) }
}

/** 0..1: how much featured tile k is "the one" at local l */
function activeW(k: number, l: number) {
  const s = itemStart(k)
  const inn = settle((l - (s + TURN_A * SPAN)) / ((TURN_B - TURN_A) * SPAN))
  const next = k < NF - 1 ? itemStart(k + 1) : F1
  const out = ease.inOutCubic(clamp((l - next) / (0.3 * SPAN)))
  return inn * (1 - out)
}

/** 0..1: the constellation drawing together into its compact map */
const listMorph = (l: number) => ease.inOutCubic(smoothstep(F1 - 0.004, LIST_IN - 0.002, l))

interface Region {
  x0: number
  y0: number
  x1: number
  y1: number
}
interface Shot {
  pos: THREE.Vector3
  tgt: THREE.Vector3
  fov: number
  /** subject centre in NDC */
  cx: number
  cy: number
}
const shot = (): Shot => ({ pos: new THREE.Vector3(), tgt: new THREE.Vector3(), fov: FOV, cx: 0, cy: 0 })

interface Layout {
  key: string
  W: number
  H: number
  portrait: boolean
  narrow: boolean
  safe: Region
  dockR: number
  cardTop: number[]
  listR: number
  listTop: number
  introB: number
}

interface CardEl {
  root: HTMLElement
  name: HTMLElement
}

interface Peek {
  root: HTMLElement
  img: HTMLImageElement
  /** a hairline from the card to its star */
  stem: HTMLElement
  w: number
  h: number
}

const _d = new THREE.Vector3()
const _r = new THREE.Vector3()
const _u = new THREE.Vector3()
const _c = new THREE.Vector3()
const _v = new THREE.Vector3()
const _p = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _m = new THREE.Matrix4()
const _e = new THREE.Euler()
const _rp = new THREE.Vector3()
const _rl = new THREE.Vector3()
const _rq = new THREE.Quaternion()
const _zero2 = new THREE.Vector2()

/** static centre-to-centre length of each link (the flow phase is normalised by it) */
const EDGE_LEN = EDGES.map(([a, b]) =>
  new THREE.Vector3().fromArray(a.kind === 't' ? TILE_POS[a.i] : STAR_POS[a.i]).distanceTo(new THREE.Vector3().fromArray(b.kind === 't' ? TILE_POS[b.i] : STAR_POS[b.i])),
)

/**
 * Aim a camera (yaw, pitch) so a w×h subject centred at C fills the screen
 * region `reg` (CSS px).
 */
function frameTo(out: Shot, C: THREE.Vector3, w: number, h: number, yaw: number, pitch: number, fov: number, reg: Region, W: number, H: number) {
  _d.set(-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
  const aspect = W / Math.max(1, H)
  const tanH = Math.tan((fov * DEG) / 2)
  const fw = Math.max(0.08, (reg.x1 - reg.x0) / W)
  const fh = Math.max(0.08, (reg.y1 - reg.y0) / H)
  const cx = ((reg.x0 + reg.x1) / 2 / W) * 2 - 1
  const cy = 1 - ((reg.y0 + reg.y1) / 2 / H) * 2
  const dist = Math.max(w / 2 / (fw * tanH * aspect), h / 2 / (fh * tanH))
  const hh = dist * tanH
  const hwid = hh * aspect
  _r.crossVectors(_d, UP).normalize()
  _u.crossVectors(_r, _d).normalize()
  out.pos.copy(C).addScaledVector(_d, -dist).addScaledVector(_r, -cx * hwid).addScaledVector(_u, -cy * hh)
  out.tgt.copy(out.pos).addScaledVector(_d, dist)
  out.fov = fov
  out.cx = cx
  out.cy = cy
  return out
}

/* per-item camera headings: a gentle alternation so the constellation reads in depth */
const ITEM_YAW = [0.16, -0.12, 0.14, -0.14, 0.12, -0.16]
const ITEM_PITCH = [0.05, 0.1, 0.04, 0.1, 0.05, 0.09]

/* studio turn: where a tall key strip crosses a tile's face, the sweep's reach */
const TURN_C = -0.9
const TURN_AMP = 0.42

class Work implements Chapter {
  id = 'work'
  group = new THREE.Group()
  anchors = [...FEATURED.map((_, k) => itemStart(k) + SPAN * 0.55), ...REST.map((_, j) => rowAt(j))]

  private ctx!: ChapterContext
  private C!: Constellation
  private mobile = false
  private reduced = false

  // DOM
  private safe!: HTMLElement
  private intro!: HTMLElement
  private introTitle!: HTMLElement
  private dock!: HTMLElement
  private cards: CardEl[] = []
  private listDock!: HTMLElement
  private list!: HTMLElement
  private listTitle!: HTMLElement
  private rows: HTMLAnchorElement[] = []
  private labelsBox!: HTMLElement
  private labels: HTMLAnchorElement[] = []
  private labelW: number[] = REST.map(() => 0)
  private peeks: Peek[] = []
  private hoverRow = -1
  private curRow = -2
  private mouse = false

  // layout / camera
  private lay: Layout | null = null
  private layDirty = true
  private cur = shot()
  private sa = shot()
  private sb = shot()
  private tmp = new THREE.Vector3()
  private itemShots: Shot[] = FEATURED.map(() => shot())
  private faceQ: THREE.Quaternion[] = FEATURED.map(() => new THREE.Quaternion())
  private listQ: THREE.Quaternion[] = FEATURED.map(() => new THREE.Quaternion())
  private introQ: THREE.Quaternion[] = FEATURED.map(() => new THREE.Quaternion())
  private vcam = new THREE.PerspectiveCamera(FOV, 1, 0.1, 400)
  /** live node positions (the chain, drawing together into the compact map for the list) */
  private tileAt: THREE.Vector3[] = TILE_POS.map(p => new THREE.Vector3().fromArray(p))
  private starAt: THREE.Vector3[] = STAR_POS.map(p => new THREE.Vector3().fromArray(p))

  // ambient / UI state (never story state)
  private lastT = -1
  private phase = new Array(NE).fill(0)
  private tilt = new THREE.Vector2()
  private ptrK = 0
  private sel: number[] = REST.map(() => 0)

  /** glass materials carrying their own envMap so per-tile envMapIntensity is honoured */
  private envMats: THREE.MeshPhysicalMaterial[] = []

  async init(ctx: ChapterContext) {
    this.ctx = ctx
    this.mobile = ctx.mobile
    this.reduced = ctx.reducedMotion
    this.buildDom(ctx.stage)
    await nextFrame()
    this.C = buildConstellation(this.mobile)
    this.group.add(this.C.root)
    const env = ctx.world.envMap
    if (env) {
      for (const t of this.C.tiles) {
        t.glassMat.envMap = env
        this.envMats.push(t.glassMat)
      }
    }
    await nextFrame()
    window.addEventListener('resize', () => (this.layDirty = true))
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => (this.layDirty = true))
      for (const c of this.cards) ro.observe(c.root)
      ro.observe(this.list)
      ro.observe(this.intro)
      ro.observe(this.safe)
      const lo = new ResizeObserver(entries => {
        for (const en of entries) {
          const t = en.target as HTMLElement
          const j = this.labels.indexOf(t as HTMLAnchorElement)
          if (j >= 0) this.labelW[j] = t.offsetWidth
          const k = this.peeks.findIndex(p => p.root === t)
          if (k >= 0) {
            this.peeks[k].w = t.offsetWidth
            this.peeks[k].h = t.offsetHeight
          }
        }
      })
      for (const a of this.labels) lo.observe(a)
      for (const p of this.peeks) lo.observe(p.root)
    }
    document.fonts?.ready.then(() => (this.layDirty = true))
    window.addEventListener('pointermove', e => {
      this.mouse = e.pointerType === 'mouse'
    })
    document.documentElement.addEventListener('pointerleave', () => (this.mouse = false))

    // screenshots: the first tile now, the rest once the site is revealed
    const load = (k: number) =>
      loadScreenshot(workImage(FEATURED[k].id), { width: 960 })
        .then(tex => {
          tex.anisotropy = 8
          try {
            this.ctx.renderer.initTexture(tex)
          } catch {
            /* uploads on first use instead */
          }
          const m = this.C.tiles[k].shotMat
          const old = m.map
          m.map = tex
          old?.dispose()
        })
        .catch(err => console.warn(`[work] missing screenshot for ${FEATURED[k].id}`, err))
    load(0)
    whenRevealed().then(async () => {
      for (let k = 1; k < NF; k++) {
        await load(k)
        await nextFrame()
      }
      // the nine peek cards' thumbnails, last (small, decoded off the main thread)
      for (let j = 0; j < NR; j++) {
        const img = this.peeks[j].img
        img.decoding = 'async'
        img.src = workImage(REST[j].id)
      }
    })
  }

  // ------------------------------------------------------------------ DOM

  private buildDom(stage: HTMLElement) {
    this.safe = el('div', 'wk-safe', undefined, stage)

    // intro
    this.intro = el('div', 'wk-intro', undefined, stage)
    el('p', 'hud-eyebrow', SECTIONS.work.eyebrow, this.intro)
    const title = SECTIONS.work.title
    const cut = title.lastIndexOf(' ')
    this.introTitle = rise(
      el('h2', 'hud-h2 wk-title', undefined, this.intro),
      cut > 0 ? `${esc(title.slice(0, cut))} <em>${esc(title.slice(cut + 1))}</em>` : `<em>${esc(title)}</em>`,
    )
    const count = el('p', 'wk-count', undefined, this.intro)
    count.innerHTML = [`${WORK.length} sites`, `${NF} featured`, `${NR} more`].map(s => `<span>${esc(s)}</span>`).join('<i aria-hidden="true"></i>')

    // one frosted card per tile, docked left (bottom on portrait)
    this.dock = el('div', 'wk-dock', undefined, stage)
    FEATURED.forEach((w, k) => this.cards.push(this.buildCard(this.dock, w, k)))

    // the nine stars: a name in space each, and a small glass card for the chosen one
    this.labelsBox = el('div', 'wk-stars', undefined, stage)
    REST.forEach((w, j) => {
      const a = el('a', 'wk-star', undefined, this.labelsBox)
      a.href = w.url
      a.target = '_blank'
      a.rel = 'noopener'
      a.innerHTML = `<i></i><span>${esc(w.name)}</span>`
      this.hoverable(a, j)
      this.labels.push(a)
    })
    REST.forEach(w => {
      const stem = el('div', 'wk-stem', undefined, this.labelsBox)
      const root = el('div', 'wk-peek', undefined, this.labelsBox)
      const frame = el('div', 'wk-peek-img', undefined, root)
      const img = el('img', '', undefined, frame)
      img.alt = ''
      img.width = 320
      img.height = 200
      const cap = el('div', 'wk-peek-cap', undefined, root)
      el('span', 'wk-peek-name', w.name, cap)
      el('span', 'wk-peek-ind', w.industry, cap)
      this.peeks.push({ root, img, stem, w: 0, h: 0 })
    })

    // the other nine: the list
    this.listDock = el('div', 'wk-dock wk-dock--list', undefined, stage)
    this.list = el('section', 'wk-list hud-panel hud-panel--strong', undefined, this.listDock)
    const meta = el('div', 'wk-meta', undefined, this.list)
    el('span', 'wk-num', `${pad(NF + 1)}–${pad(NF + NR)} / ${pad(WORK.length)}`, meta)
    el('span', 'hud-label wk-ind', 'More work', meta)
    const allLive = REST.every(w => !isPreview(w.url))
    const count9 = WORDS[NR] ?? String(NR)
    this.listTitle = rise(el('h3', 'hud-h2 wk-list-title', undefined, this.list), allLive ? `${esc(count9)} more, <em>all live.</em>` : `${esc(count9)} <em>more.</em>`)
    const ol = el('ol', 'wk-rows', undefined, this.list)
    REST.forEach((w, j) => {
      const li = el('li', '', undefined, ol)
      const a = el('a', 'wk-row', undefined, li)
      a.href = w.url
      a.target = '_blank'
      a.rel = 'noopener'
      const pre = isPreview(w.url)
      a.innerHTML = `<span class="wk-no">${pad(NF + j + 1)}</span><span class="wk-rname">${esc(w.name)}${
        pre ? ' <small class="wk-pre">Preview</small>' : ''
      }</span><span class="wk-rind">${esc(w.industry)}</span><span class="wk-arrow" aria-hidden="true">↗</span>`
      this.hoverable(a, j)
      this.rows.push(a)
    })
    const cta = el('div', 'wk-cta', undefined, this.list)
    const hello = el('button', 'hud-btn', 'Say hello', cta)
    hello.type = 'button'
    hello.addEventListener('click', () => window.__hark?.land('contact'))
  }

  private hoverable(a: HTMLElement, j: number) {
    const on = () => (this.hoverRow = j)
    const off = () => {
      if (this.hoverRow === j) this.hoverRow = -1
    }
    a.addEventListener('pointerenter', on)
    a.addEventListener('pointerleave', off)
    a.addEventListener('focus', on)
    a.addEventListener('blur', off)
  }

  /** A tiny map of the six stars, the current one lit (the card's place in the constellation). */
  private miniMap(k: number) {
    const xs = TILE_POS.map(p => p[0])
    const ys = TILE_POS.map(p => p[1])
    const x0 = Math.min(...xs)
    const x1 = Math.max(...xs)
    const y0 = Math.min(...ys)
    const y1 = Math.max(...ys)
    const px = (x: number) => 5 + ((x - x0) / (x1 - x0)) * 62
    const py = (y: number) => 17 - ((y - y0) / (y1 - y0)) * 12
    const lines = EDGES.filter(([a, b]) => a.kind === 't' && b.kind === 't')
      .map(([a, b]) => `<line x1="${px(TILE_POS[a.i][0]).toFixed(1)}" y1="${py(TILE_POS[a.i][1]).toFixed(1)}" x2="${px(TILE_POS[b.i][0]).toFixed(1)}" y2="${py(TILE_POS[b.i][1]).toFixed(1)}"/>`)
      .join('')
    const dots = TILE_POS.map((p, i) => `<circle cx="${px(p[0]).toFixed(1)}" cy="${py(p[1]).toFixed(1)}" r="${i === k ? 3 : 1.7}"${i === k ? ' class="on"' : ''}/>`).join('')
    return `<svg class="wk-map" viewBox="0 0 72 22" aria-hidden="true" focusable="false">${lines}${dots}</svg>`
  }

  private buildCard(parent: HTMLElement, w: WorkItem, k: number): CardEl {
    const root = el('article', 'wk-card hud-panel hud-panel--strong', undefined, parent)
    const pre = isPreview(w.url)
    const meta = el('div', 'wk-meta', undefined, root)
    el('span', 'wk-num', `${pad(k + 1)} / ${pad(NF)}`, meta)
    meta.insertAdjacentHTML('beforeend', this.miniMap(k))
    el('span', 'hud-label wk-ind', w.industry, meta)
    if (pre) el('span', 'wk-badge', 'Preview', meta)
    const name = rise(el('h3', 'hud-h2 wk-name', undefined, root), emLast(w.name))
    el('p', 'hud-body wk-blurb', w.blurb, root)
    const tags = el('ul', 'hud-tags wk-tags', undefined, root)
    for (const t of w.tags) el('li', 'hud-tag', t, tags)
    const cta = el('div', 'wk-cta', undefined, root)
    const a = el('a', 'hud-btn hud-btn--ghost wk-visit', pre ? 'Preview site ↗' : 'Visit site ↗', cta)
    a.href = w.url
    a.target = '_blank'
    a.rel = 'noopener'
    el('span', 'hud-label wk-host', pre ? 'Pre-launch build' : hostOf(w.url), cta)
    return { root, name }
  }

  // ------------------------------------------------------------------ layout

  private ensureLayout(f: Frame): Layout {
    const key = `${f.width}x${f.height}`
    if (this.lay && this.lay.key === key && !this.layDirty) return this.lay
    this.layDirty = false
    const W = f.width
    const H = f.height
    const portrait = typeof matchMedia === 'function' ? matchMedia('(max-aspect-ratio: 10/9)').matches : W / H < 1.1
    const s = this.safe.getBoundingClientRect()
    const safe = s.width > 0 ? { x0: s.left, y0: s.top, x1: s.right, y1: s.bottom } : { x0: 24, y0: 90, x1: W - 24, y1: H - 90 }
    // offset* metrics ignore the reveal() translate on hidden cards / the list
    const dock = this.dock
    const ld = this.listDock
    const list = this.list
    const measured = dock.offsetWidth > 0
    this.lay = {
      key,
      W,
      H,
      portrait,
      // narrow or short screens: only the chosen star is named (by its card)
      narrow: W < 700 || H < 520,
      safe,
      dockR: measured ? dock.offsetLeft + dock.offsetWidth : W * 0.38,
      cardTop: this.cards.map(c => (measured && c.root.offsetHeight > 0 ? dock.offsetTop + c.root.offsetTop : H * 0.55)),
      listR: list.offsetWidth > 0 ? ld.offsetLeft + list.offsetLeft + list.offsetWidth : W * 0.4,
      listTop: list.offsetHeight > 0 ? ld.offsetTop + list.offsetTop : H * 0.45,
      introB: this.intro.offsetHeight > 0 ? this.intro.offsetTop + this.intro.offsetHeight : H * 0.35,
    }
    // the per-item shots (and so each tile's facing) depend only on the layout
    for (let k = 0; k < NF; k++) {
      this.itemShot(k, 0, this.itemShots[k])
      _c.fromArray(TILE_POS[k])
      this.faceTo(this.itemShots[k].pos, _c, 0.07 * (k % 2 === 0 ? 1 : -1), this.faceQ[k])
    }
    this.listShot(0, this.sa)
    for (let k = 0; k < NF; k++) this.faceTo(this.sa.pos, listPos(TILE_POS[k], portrait, _c), 0, this.listQ[k])
    this.introShot(0.5, this.sa)
    for (let k = 0; k < NF; k++) this.faceTo(this.sa.pos, _c.fromArray(TILE_POS[k]), 0, this.introQ[k])
    return this.lay
  }

  /** orientation that turns a tile at C to face `eye` (plus a slight yaw so its bevel catches light) */
  private faceTo(eye: THREE.Vector3, C: THREE.Vector3, yawBias: number, out: THREE.Quaternion) {
    _m.lookAt(eye, C, UP)
    out.setFromRotationMatrix(_m)
    out.multiply(_q.setFromEuler(_e.set(0, yawBias, 0)))
    return out
  }

  private region(kind: 'item' | 'list' | 'intro', k: number): Region {
    const L = this.lay!
    const s = L.safe
    if (kind === 'intro') {
      if (L.portrait) return { x0: 0, x1: L.W, y0: Math.min(L.introB + 20, L.H * 0.6), y1: s.y1 }
      return { x0: L.W * 0.08, x1: L.W * 0.99, y0: Math.min(L.introB + L.H * 0.01, L.H * 0.52), y1: s.y1 + L.H * 0.04 }
    }
    if (L.portrait) {
      const top = kind === 'item' ? L.cardTop[k] : L.listTop
      return { x0: 4, x1: L.W - 4, y0: s.y0 + 6, y1: Math.max(s.y0 + 90, top - 14) }
    }
    const right = kind === 'item' ? L.dockR : L.listR
    return { x0: right + L.W * 0.035, x1: s.x1 + L.W * 0.005, y0: s.y0, y1: s.y1 }
  }

  // ------------------------------------------------------------------ shots

  private itemShot(k: number, drift: number, out: Shot) {
    const L = this.lay!
    _c.fromArray(TILE_POS[k])
    const port = L.portrait
    frameTo(out, _c, TW + (port ? 0.16 : 0.62), TH + (port ? 0.2 : 0.5), ITEM_YAW[k] + drift * 0.03, ITEM_PITCH[k], FOV, this.region('item', k), L.W, L.H)
    out.pos.lerp(out.tgt, drift * 0.04)
    return out
  }

  private introShot(u: number, out: Shot) {
    const L = this.lay!
    const port = L.portrait
    if (port) {
      // portrait: closer and from higher up, so the chain recedes up the tall frame
      _c.set(-4.1, 0.1, -0.9)
      frameTo(out, _c, 4.7, 6.4, lerp(-0.98, -0.92, u), lerp(0.2, 0.18, u), FOV, this.region('intro', 0), L.W, L.H)
      return out
    }
    _c.set(-0.8, 0.1, -0.2)
    frameTo(out, _c, 12.5, 3.6, lerp(-0.52, -0.46, u), lerp(0.1, 0.085, u), FOV, this.region('intro', 0), L.W, L.H)
    return out
  }

  /** the whole constellation drawn together into its compact map, seen a little from above */
  private listShot(drift: number, out: Shot) {
    const L = this.lay!
    const port = L.portrait
    _c.copy(LIST_CENTRE)
    _c.y += port ? 0.1 : 0.05
    frameTo(out, _c, port ? 9.6 : 12.2, port ? 6.9 : 6.7, 0.1 - drift * 0.06, 0.2, FOV, this.region('list', 0), L.W, L.H)
    out.pos.lerp(out.tgt, drift * 0.04)
    return out
  }

  private outShot(out: Shot) {
    this.listShot(1, out)
    this.tmp.subVectors(out.pos, out.tgt)
    out.pos.copy(out.tgt).addScaledVector(this.tmp, 1.25)
    out.pos.y += 1.2
    return out
  }

  private travel(a: Shot, b: Shot, t: number, pull: number, out: Shot) {
    const e = ease.inOutCubic(clamp(t))
    out.pos.lerpVectors(a.pos, b.pos, e)
    out.tgt.lerpVectors(a.tgt, b.tgt, e)
    out.fov = lerp(a.fov, b.fov, e)
    out.cx = lerp(a.cx, b.cx, e)
    out.cy = lerp(a.cy, b.cy, e)
    const bump = Math.sin(Math.PI * clamp(t)) * pull
    this.tmp.subVectors(out.pos, out.tgt).normalize()
    out.pos.addScaledVector(this.tmp, bump)
    out.pos.y += bump * 0.15
    return out
  }

  private shotAt(l: number, out: Shot) {
    if (l < T0A) return this.introShot(l / T0A, out)
    if (l < T0B) return this.travel(this.introShot(1, this.sa), this.itemShot(0, 0, this.sb), (l - T0A) / (T0B - T0A), 0.3, out)
    const ph = phaseOf(l)
    if (ph.kind === 'item') {
      const k = ph.k
      if (k > 0 && ph.p < TRAVEL) return this.travel(this.itemShot(k - 1, 1, this.sa), this.itemShot(k, 0, this.sb), ph.p / TRAVEL, 0.9, out)
      const tr = k === 0 ? TRAVEL0 : TRAVEL
      return this.itemShot(k, clamp((ph.p - tr) / (1 - tr)), out)
    }
    if (l < LIST_IN) return this.travel(this.itemShot(NF - 1, 1, this.sa), this.listShot(0, this.sb), (l - F1) / (LIST_IN - F1), 1.2, out)
    if (l < LIST_OUT) return this.listShot((l - LIST_IN) / (LIST_OUT - LIST_IN), out)
    return this.travel(this.listShot(1, this.sa), this.outShot(this.sb), (l - LIST_OUT) / (1 - LIST_OUT), 0, out)
  }

  // ------------------------------------------------------------------ light

  /**
   * The studio's rotation (world.params.envTurn): a slow drift in the intro,
   * then one sweep across each tile as it arrives (alternating direction so
   * the value stays continuous), then a slow drift for the list.
   */
  private turnAt(l: number) {
    const amp = this.reduced ? TURN_AMP * 0.45 : TURN_AMP
    const startOf = (k: number) => TURN_C - (k % 2 === 0 ? amp : -amp)
    const endOf = (k: number) => TURN_C + (k % 2 === 0 ? amp : -amp)
    const I0 = startOf(0) - 0.9
    const I1 = startOf(0) - 0.12
    if (l < F0) return lerp(I0, I1, smoothstep(0, 1, l / F0))
    if (l < F1) {
      const k = Math.min(NF - 1, Math.floor((l - F0) / SPAN))
      const p = clamp((l - itemStart(k)) / SPAN)
      const prev = k === 0 ? I1 : endOf(k - 1)
      if (p < SWEEP_A) return lerp(prev, startOf(k), smoothstep(0, SWEEP_A, p))
      return lerp(startOf(k), endOf(k), ease.inOutCubic(clamp((p - SWEEP_A) / (SWEEP_B - SWEEP_A))))
    }
    const e5 = endOf(NF - 1)
    return lerp(e5, e5 + 0.6, smoothstep(F1, 1, l))
  }

  // ------------------------------------------------------------------ frame

  update(local: number, frame: Frame, ctx: ChapterContext) {
    const l = clamp(local)
    const time = frame.time
    const dt = this.lastT < 0 ? 0 : Math.min(0.1, Math.max(0, time - this.lastT))
    this.lastT = time
    const reduced = this.reduced || frame.reducedMotion
    const calm = reduced || !!frame.still
    const L = this.ensureLayout(frame)
    const ph = phaseOf(l)
    const C = this.C

    // ---- camera shot (camera() copies it) + a virtual copy for projections
    this.shotAt(l, this.cur)
    const s = this.cur
    const vc = this.vcam
    const aspect = frame.width / Math.max(1, frame.height)
    if (vc.fov !== s.fov || vc.aspect !== aspect) {
      vc.fov = s.fov
      vc.aspect = aspect
      vc.updateProjectionMatrix()
    }
    vc.position.copy(s.pos)
    vc.lookAt(s.tgt)
    vc.updateMatrixWorld()

    const kAct = ph.kind === 'item' ? ph.k : -1
    const w = FEATURED.map((_, k) => activeW(k, l))
    const listW = smoothstep(F1 + 0.01, LIST_IN, l)
    const listM = listMorph(l)
    const gather = smoothstep(0.004, 0.058, l)
    const introW = 1 - smoothstep(T0A, T0B, l)

    // ---- live node positions: the chain, drawing together for the list
    for (let k = 0; k < NF; k++) {
      listPos(TILE_POS[k], L.portrait, _p)
      this.tileAt[k].fromArray(TILE_POS[k]).lerp(_p, listM)
    }
    for (let j = 0; j < NR; j++) {
      listPos(STAR_POS[j], L.portrait, _p)
      this.starAt[j].fromArray(STAR_POS[j]).lerp(_p, listM)
      C.stars.u.uStarPos.value[j].copy(this.starAt[j])
    }

    // ---- world: deep night blue; the backdrop network steps back (finer,
    // dimmer) so the foreground constellation is THE constellation, but stays
    // behind the glass to be refracted
    const wp = ctx.world.params
    wp.top = G.night
    wp.bottom = G.ink
    wp.a = G.violet
    wp.b = '#56b4ff'
    wp.node = '#a9c2ee'
    wp.line = '#6f9fe0'
    wp.net = lerp(lerp(0.44, 0.6, 1 - introW), 0.42, listW)
    wp.density = 1.4
    wp.speed = reduced ? 0.4 : 0.9
    wp.gather = kAct >= 0 ? 0.1 * w[kAct] : 0
    wp.pointer = calm ? 0 : 0.8
    _d.subVectors(s.tgt, s.pos).normalize()
    const yawW = Math.atan2(_d.x, -_d.z)
    const pitchW = Math.asin(clamp(_d.y, -1, 1))
    wp.focus.set(s.cx * aspect + Math.sin(yawW) * 0.35, s.cy + pitchW * 0.3)
    wp.env = ENV
    wp.envTurn = this.turnAt(l)
    wp.key = 1.4
    wp.keyDir.set(-0.5, 0.8, 0.5)
    wp.fill = 0.3
    const scene = this.group.parent as THREE.Scene | null
    if (scene && scene.isScene) for (const m of this.envMats) m.envMapRotation.copy(scene.environmentRotation)

    // ---- post: a brief focus pull while the constellation draws together
    const pp = ctx.post.params
    const fp = clamp((l - F1) / (LIST_IN - F1 + 0.01))
    pp.frost = Math.sin(Math.PI * fp) * (reduced ? 0.1 : 0.2)
    pp.bloomStrength = 0.62
    pp.bloomRadius = 0.55
    // stars, signal heads and hot links bloom — never a screenshot
    pp.bloomThreshold = 1.0
    pp.vignette = 0.34

    // ---- pointer (mouse only; calm on touch, reduced motion and Motion off)
    const usePtr = this.mouse && !calm && !this.mobile
    this.ptrK += ((usePtr ? 1 : 0) - this.ptrK) * (1 - Math.exp(-6 * frame.dt))
    if (!usePtr && this.ptrK < 0.002) this.ptrK = 0
    const px = ctx.renderer.domElement.height
    const scaleR = px / Math.max(1, frame.height)
    for (const u of [C.flow.u, C.stars.u]) {
      u.uPtr.value.copy(frame.pointerRaw)
      u.uPtrK.value = this.ptrK
      u.uAspect.value = aspect
    }

    // ---- tiles
    const landscape = !L.portrait
    const introPulse = (k: number) => {
      // intro: the light runs star to star along the chain
      if (ph.kind !== 'intro') return 0
      const c = 0.42 + k * 0.1
      const x = (ph.p - c) / 0.11
      return Math.exp(-x * x)
    }
    const floatA = reduced ? 0.004 : 0.02
    const tiltTarget = usePtr ? frame.pointer : _zero2
    this.tilt.x += (tiltTarget.x - this.tilt.x) * (1 - Math.exp(-5 * frame.dt))
    this.tilt.y += (tiltTarget.y - this.tilt.y) * (1 - Math.exp(-5 * frame.dt))
    const dimAll = smoothstep(F0, F0 + 0.25 * SPAN, l) * (1 - listW)
    for (let k = 0; k < NF; k++) {
      const t = C.tiles[k]
      const wk = w[k]
      const d = dimAll * (1 - wk)
      // on landscape a tile the story has moved past rests where the card
      // docks: take it right down so no site text sits beside the card's text
      const next = k < NF - 1 ? itemStart(k + 1) : F1
      const gone = landscape ? smoothstep(next, next + 0.3 * SPAN, l) * (1 - listW) : 0
      const pu = introPulse(k)
      // pose: rest → facing its item shot (→ mostly facing the list camera)
      t.pivot.quaternion.copy(t.restQ)
      // intro: the tiles half-turn toward the camera (more on portrait, where it looks along the chain)
      if (introW > 0) t.pivot.quaternion.slerp(this.introQ[k], introW * (L.portrait ? 0.62 : 0.3))
      t.pivot.quaternion.slerp(this.faceQ[k], wk)
      if (listM > 0) t.pivot.quaternion.slerp(this.listQ[k], listM * 0.7)
      if (wk > 0.01 && this.ptrK > 0) {
        _q.setFromEuler(_e.set(-this.tilt.y * 0.12 * wk * this.ptrK, this.tilt.x * 0.16 * wk * this.ptrK, 0))
        t.pivot.quaternion.multiply(_q)
      }
      t.root.position.copy(this.tileAt[k])
      t.root.position.y += Math.sin(time * 0.55 + k * 1.7) * floatA * (1 - wk * 0.6)
      t.root.scale.setScalar(1 + 0.12 * listM)
      t.pivot.position.z = lerp(-0.25 * d, 0.1, wk)
      const shotB = lerp(lerp(lerp(0.62, 0.3, d), 0.86, wk), 0.72, listW) * (1 - 0.88 * gone) + pu * 0.12
      t.shotMat.color.setScalar(shotB)
      t.shot.visible = shotB > 0.003
      t.glassMat.envMapIntensity = (lerp(lerp(0.95, 0.6, d), 1.25, wk) + pu * 0.5 + listW * 0.1) * (1 - 0.35 * gone) * ENV
      t.rimMat.uniforms.uStrength.value = (lerp(lerp(0.28, 0.12, d), 0.6, wk) + pu * 0.6 + listW * 0.14) * (1 - 0.6 * gone)
      t.haloMat.uniforms.uStrength.value = (lerp(lerp(0.16, 0.06, d), 0.34, wk) + pu * 0.45 + listW * 0.12) * (1 - 0.8 * gone) * lerp(0.4, 1, gather)
    }

    // ---- the chosen one of the nine (hover wins, else the scroll row): UI
    // state, damped with the real frame delta so it responds with Motion off
    const listSel = listW > 0.5 ? this.selIdx(l) : -1
    const kS = reduced ? 1 : 1 - Math.exp(-7 * frame.dt)
    for (let j = 0; j < NR; j++) {
      const target = j === listSel ? 1 : 0
      this.sel[j] += (target - this.sel[j]) * kS
      if (Math.abs(target - this.sel[j]) < 1e-3) this.sel[j] = target
    }

    // ---- links + the flowing signal
    // endpoints: a star's centre, or the point on a tile's glass rim that faces
    // the other end (the signal plugs into the edge of the glass, never
    // crossing in front of a screenshot)
    for (let e = 0; e < NE; e++) {
      const [n0, n1] = EDGES[e]
      this.nodeCentre(n0.kind, n0.i, _v)
      this.nodeCentre(n1.kind, n1.i, _c)
      if (n0.kind === 't') this.rimPoint(n0.i, _c, C.edgeA[e])
      else C.edgeA[e].copy(_v)
      if (n1.kind === 't') this.rimPoint(n1.i, _v, C.edgeB[e])
      else C.edgeB[e].copy(_c)
    }
    for (let e = 0; e < NE; e++) {
      const [n0, n1] = EDGES[e]
      const chain = n0.kind === 't' && n1.kind === 't'
      let g = chain ? 0.95 : 0.6
      // intro: the pulse runs along the chain
      if (ph.kind === 'intro' && chain) g += (introPulse(n0.i) + introPulse(n1.i)) * 0.7
      // items: the active tile's links light up, the rest dim
      let act = 0
      for (let k = 0; k < NF; k++) if ((n0.kind === 't' && n0.i === k) || (n1.kind === 't' && n1.i === k)) act = Math.max(act, w[k])
      const dimL = dimAll * (1 - act)
      g = lerp(g, g * 0.5, dimL) + act * 0.9
      // list: a calm, even constellation; the chosen star's links light
      if (listW > 0) {
        let hot = 0
        for (let j = 0; j < NR; j++) if ((n0.kind === 's' && n0.i === j) || (n1.kind === 's' && n1.i === j)) hot = Math.max(hot, this.sel[j])
        g = lerp(g, chain ? 0.95 : 0.66, listW) + hot * listW * 1.1
      }
      const ed = C.edge[e]
      ed.x = g
      // the links draw on (A → B) as the particles condense
      ed.y = smoothstep(0.004 + (e % 7) * 0.003, 0.05 + (e % 7) * 0.002, l)
      // the flow speeds up on lit links (ambient: integrated from frame.time)
      const speed = (0.2 + Math.min(1.2, Math.max(0, g - 0.9)) * 0.4) * (reduced ? 0.35 : 1)
      this.phase[e] = (this.phase[e] + (dt * speed) / EDGE_LEN[e]) % 1
      ed.z = this.phase[e]
    }
    C.link.u.uRes.value.set(ctx.renderer.domElement.width, px)
    C.link.u.uWidth.value = (this.mobile ? 2.8 : 3.4) * scaleR
    C.link.u.uOpacity.value = lerp(0.3, 1, gather)
    C.flow.u.uTime.value = time
    C.flow.u.uPx.value = px
    C.flow.u.uMaxPx.value = (this.mobile ? 9 : 11) * scaleR
    C.flow.u.uGather.value = gather
    C.flow.u.uSize.value = this.mobile ? 0.05 : 0.04

    // ---- the nine stars
    const lit = C.stars.u.uLit.value
    const ring = C.stars.u.uRing.value
    for (let j = 0; j < NR; j++) {
      let v = 0.2
      // the stars tied to the active tile glow with it
      for (let e = 0; e < NE; e++) {
        const [n0, n1] = EDGES[e]
        const isJ = (n0.kind === 's' && n0.i === j) || (n1.kind === 's' && n1.i === j)
        if (!isJ) continue
        const tn = n0.kind === 't' ? n0 : n1.kind === 't' ? n1 : null
        if (tn) v = Math.max(v, 0.2 + 0.35 * w[tn.i])
      }
      v = lerp(v, 0.34, listW) + this.sel[j] * 0.75
      lit[j] = v
      ring[j] = this.sel[j] * listW
    }
    C.stars.u.uTime.value = time
    C.stars.u.uPx.value = px
    C.stars.u.uFade.value = lerp(0.3, 1, gather)
    C.stars.u.uSize.value = this.mobile ? 0.05 : 0.042
    C.stars.u.uMaxPx.value = (this.mobile ? 8 : 10) * scaleR

    // ---- ambient dust (magnetism toward the pointer, mouse only)
    C.dust.update(time, usePtr ? frame.pointer : _zero2, lerp(0.35, 0.9, gather))

    // ---- DOM
    const introV = 1 - smoothstep(F0 - 0.006, F0 + 0.008, l)
    reveal(this.intro, introV, 0)
    setRise(this.introTitle, l > 0.006 && l < F0 + 0.002)
    for (let k = 0; k < NF; k++) {
      // a card names its tile from the moment it has turned in until the
      // camera actually starts gliding away (a little into the next span)
      const st = itemStart(k)
      const next = k < NF - 1 ? itemStart(k + 1) : F1
      const inA = st + (k === 0 ? 0.12 : 0.17) * SPAN
      const v = smoothstep(inA, inA + 0.08 * SPAN, l) * (1 - smoothstep(next + 0.02 * SPAN, next + 0.08 * SPAN, l))
      reveal(this.cards[k].root, v, 10)
      setRise(this.cards[k].name, v > 0.35)
    }
    const listV = smoothstep(F1 + 0.026, LIST_IN + 0.002, l) * (1 - smoothstep(LIST_OUT - 0.002, LIST_OUT + 0.008, l))
    reveal(this.listDock, listV, 10)
    // a list that hides under a still cursor never gets its pointerleave
    if (listV <= 0.01) this.hoverRow = -1
    setRise(this.listTitle, listV > 0.35)
    if (listSel !== this.curRow) {
      this.rows.forEach((r, j) => r.classList.toggle('is-cur', j === listSel))
      this.labels.forEach((r, j) => r.classList.toggle('is-cur', j === listSel))
      this.curRow = listSel
    }
    this.placeLabels(listV, L)
  }

  /** a node's live centre (tiles float and step forward as they activate) */
  private nodeCentre(kind: 't' | 's', i: number, out: THREE.Vector3) {
    if (kind === 's') return out.copy(this.starAt[i])
    const t = this.C.tiles[i]
    return out.copy(t.root.position).add(t.pivot.position)
  }

  /** the point on tile k's rim (in its current pose) in the direction of `toward` */
  private rimPoint(k: number, toward: THREE.Vector3, out: THREE.Vector3) {
    const t = this.C.tiles[k]
    this.nodeCentre('t', k, _rp)
    _rq.copy(t.pivot.quaternion).invert()
    _rl.subVectors(toward, _rp).applyQuaternion(_rq)
    let dx = _rl.x
    let dy = _rl.y
    if (Math.abs(dx) + Math.abs(dy) < 1e-5) dx = 1
    const sc = t.root.scale.x
    const hw = (TW / 2 - 0.02) * sc
    const hh = (TH / 2 - 0.02) * sc
    const f = Math.min(hw / Math.max(Math.abs(dx), 1e-6), hh / Math.max(Math.abs(dy), 1e-6))
    out.set(dx * f, dy * f, 0).applyQuaternion(t.pivot.quaternion).add(_rp)
    return out
  }

  /** the chosen row of the nine: hover wins, else the scroll row */
  private selIdx(l: number) {
    if (this.hoverRow >= 0) return this.hoverRow
    if (l < LIST_IN - 0.004 || l >= LIST_OUT) return -1
    return clamp(Math.floor(((l - ROW0) / (ROW1 - ROW0)) * NR), 0, NR - 1)
  }

  /** the nine stars' names in space, and the chosen one's glass card */
  private placeLabels(listV: number, L: Layout) {
    reveal(this.labelsBox, listV, 0)
    if (listV <= 0.01) return
    const vc = this.vcam
    const reg = this.region('list', 0)
    const m = 10
    // 1) the glass cards (the chosen star's, and one fading out)
    const cards: { x0: number; y0: number; x1: number; y1: number; v: number }[] = []
    const sx: number[] = []
    const sy: number[] = []
    const ok: boolean[] = []
    for (let j = 0; j < NR; j++) {
      _c.copy(this.starAt[j]).project(vc)
      sx[j] = (_c.x * 0.5 + 0.5) * L.W
      sy[j] = (-_c.y * 0.5 + 0.5) * L.H
      ok[j] = _c.z < 1 && Number.isFinite(sx[j] + sy[j])
      const pk = this.peeks[j]
      const pv = ok[j] ? smoothstep(0.15, 0.85, this.sel[j]) : 0
      const pvs = pv.toFixed(2)
      if (pk.root.style.opacity !== pvs) {
        pk.root.style.opacity = pvs
        pk.root.style.visibility = pv > 0.01 ? 'visible' : 'hidden'
        pk.stem.style.opacity = pvs
        pk.stem.style.visibility = pv > 0.01 ? 'visible' : 'hidden'
      }
      if (pv <= 0.01) continue
      const x = sx[j]
      const y = sy[j]
      const pw = pk.w || pk.root.offsetWidth
      const ph = pk.h || pk.root.offsetHeight
      // above the star (below when there's no room), inside the free region
      let top = y - 30 - ph
      let above = true
      if (top < reg.y0 + 2) {
        top = y + 30
        above = false
      }
      top = Math.min(Math.max(top, reg.y0 + 2), Math.max(reg.y0 + 2, reg.y1 - ph))
      const left = Math.min(Math.max(x - pw / 2, reg.x0 + m), Math.max(reg.x0 + m, reg.x1 - m - pw))
      const lift = (1 - pv) * 8
      pk.root.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top + lift)}px, 0)`
      // the stem: from the card's edge to just short of the star
      const sx0 = Math.min(Math.max(x, left + 14), left + pw - 14)
      const ya = above ? top + ph + lift : y + 7
      const yb = above ? y - 7 : top + lift
      const len = Math.max(0, yb - ya)
      pk.stem.style.transform = `translate3d(${Math.round(sx0)}px, ${Math.round(ya)}px, 0) scaleY(${len.toFixed(1)})`
      cards.push({ x0: left - 6, y0: top - 6, x1: left + pw + 6, y1: top + ph + 6, v: pv })
    }
    // 2) the names: all nine on wide screens (never under the list panel, a
    // card or another name: try the right of the star, then the left, else hide)
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = []
    const hits = (x0: number, y0: number, x1: number, y1: number) =>
      cards.some(c => c.v > 0.5 && x0 < c.x1 && x1 > c.x0 && y0 < c.y1 && y1 > c.y0) || placed.some(r => x0 < r.x1 && x1 > r.x0 && y0 < r.y1 && y1 > r.y0)
    // the chosen star's name first (it stays lit and under the cursor that chose it)
    const chosen = this.sel.reduce((b, v, j) => (v > (b >= 0 ? this.sel[b] : 0.01) ? j : b), -1)
    for (let n = 0; n < NR; n++) {
      const j = chosen < 0 ? n : n === 0 ? chosen : n <= chosen ? n - 1 : n
      const a = this.labels[j]
      const x = sx[j]
      const y = sy[j]
      const inside = ok[j] && x > reg.x0 - 4 && x < reg.x1 + 4 && y > reg.y0 - 4 && y < reg.y1 + 4
      const lw = this.labelW[j] || a.offsetWidth
      const y0 = y - 12
      const y1 = y + 12
      const rightX = x + 14
      const leftX = x - 14 - lw
      const fitsR = rightX + lw < reg.x1 + L.W * 0.01
      const fitsL = leftX > reg.x0 - 4
      let lx = fitsR ? rightX : leftX
      let o = inside && !L.narrow ? lerp(0.86, 1, this.sel[j]) : 0
      if (o > 0.01 && j !== chosen) {
        if (hits(lx, y0, lx + lw, y1)) {
          const alt = lx === rightX ? leftX : rightX
          const altFits = alt === rightX ? fitsR : fitsL
          if (altFits && !hits(alt, y0, alt + lw, y1)) lx = alt
          else o = 0
        }
        for (const c of cards) if (c.v <= 0.5 && lx < c.x1 && lx + lw > c.x0 && y1 > c.y0 && y0 < c.y1) o *= 1 - c.v
      }
      if (o > 0.01) placed.push({ x0: lx - 4, y0, x1: lx + lw + 4, y1 })
      a.style.transform = `translate3d(${Math.round(lx)}px, ${Math.round(y - 11)}px, 0)`
      a.classList.toggle('is-flip', lx < x)
      const os = o.toFixed(2)
      if (a.style.opacity !== os) {
        a.style.opacity = os
        a.style.visibility = o > 0.01 ? 'visible' : 'hidden'
      }
    }
  }

  camera(_local: number, _frame: Frame, out: CameraPose) {
    out.position.copy(this.cur.pos)
    out.target.copy(this.cur.tgt)
    out.fov = this.cur.fov
    out.parallax = this.reduced ? 0 : 0.14
  }
}

export default function create(): Chapter {
  return new Work()
}
