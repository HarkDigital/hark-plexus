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
 * bright stars of a constellation: each carries its site's screenshot on the
 * front face (crisp at any glass-buffer scale) and refracts the living
 * network behind it. Glowing links join them (plugged into each tile's glass
 * rim), and a signal of particles flows along every link in story order
 * (01 → 06). Nine small stars (the rest of the portfolio) hang around the
 * chain, each a tiny particles.js constellation of its own: a core and a few
 * drifting nodes, joined by thin lines whenever two come close.
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
 *   0.830–0.956  "Nine more, all live.": the list; the six tiles step back
 *                (smaller, faded to glass) and the nine stars take the stage,
 *                named in space; the chosen one (scroll row, or hover a row /
 *                a star) opens its little constellation with an orbit ring,
 *                its links light, and a small glass card beside it shows the site
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
const setPhase = (out: Phase, kind: PhaseKind, k: number, p: number) => {
  out.kind = kind
  out.k = k
  out.p = p
  return out
}
/** the story phase at l (written into `out`: no per-frame allocation) */
function phaseOf(l: number, out: Phase): Phase {
  if (l < F0) return setPhase(out, 'intro', -1, clamp(l / F0))
  if (l < F1) {
    const k = Math.min(NF - 1, Math.floor((l - F0) / SPAN))
    return setPhase(out, 'item', k, clamp((l - itemStart(k)) / SPAN))
  }
  if (l < LIST_OUT) return setPhase(out, 'list', NF, clamp((l - F1) / (LIST_OUT - F1)))
  return setPhase(out, 'out', NF, clamp((l - LIST_OUT) / (1 - LIST_OUT)))
}

/* the studio turn's start / end for tile k (alternating direction) */
const turnStart = (k: number, amp: number) => TURN_C - (k % 2 === 0 ? amp : -amp)
const turnEnd = (k: number, amp: number) => TURN_C + (k % 2 === 0 ? amp : -amp)

/** 0..1: how much featured tile k is "the one" at local l */
function activeW(k: number, l: number) {
  const s = itemStart(k)
  const inn = settle((l - (s + TURN_A * SPAN)) / ((TURN_B - TURN_A) * SPAN))
  const next = k < NF - 1 ? itemStart(k + 1) : F1
  const out = ease.inOutCubic(clamp((l - next) / (0.3 * SPAN)))
  return inn * (1 - out)
}

/** intro: the light runs star to star along the chain */
function introPulse(ph: Phase, k: number) {
  if (ph.kind !== 'intro') return 0
  const x = (ph.p - (0.42 + k * 0.1)) / 0.11
  return Math.exp(-x * x)
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

/** a screen box (CSS px) for the label collision test; v = the card's visibility */
interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
  v: number
}
const box = (): Box => ({ x0: 0, y0: 0, x1: 0, y1: 0, v: 0 })
const setBox = (b: Box, x0: number, y0: number, x1: number, y1: number, v = 1) => {
  b.x0 = x0
  b.y0 = y0
  b.x1 = x1
  b.y1 = y1
  b.v = v
}

/** the list beat: the six tiles step back so the nine stars carry it */
const LIST_TILE_SCALE = 0.6
const LIST_TILE_SHOT = 0.25
/** a label's height (CSS px) and its gap from the star */
const LABEL_H = 22
const PAD = 16
/** where a star's name may sit: [side (-1 left, 0 centred, +1 right), dy] in order of preference */
const CAND: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, -26],
  [0, 26],
  [1, -22],
  [1, 22],
  [-1, -22],
  [-1, 22],
]

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
const _dir = new THREE.Vector3()
const _cor = new THREE.Vector3()

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

/* portrait intro heading (yaw, pitch) at u = 0 and u = 1: along the chain and from above, so it recedes up the tall frame */
const PORTRAIT_INTRO: readonly [readonly [number, number], readonly [number, number]] = [
  [-1.45, 0.5],
  [-1.37, 0.46],
]

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
  /** the star names / cards are live (hit-testable); false = hidden and inert */
  private labelsLive = true
  /** short portrait screens: the chosen star's card lies beside it, image and name in a row */
  private peekCompact = false
  // label collision boxes (reused every frame)
  private sx = new Float32Array(NR)
  private sy = new Float32Array(NR)
  private okS = new Uint8Array(NR)
  private cardBoxes: Box[] = REST.map(box)
  private nCards = 0
  private tileBoxes: Box[] = FEATURED.map(box)
  private placedBoxes: Box[] = REST.map(box)
  private nPlaced = 0

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
  private fitCam = new THREE.PerspectiveCamera(FOV, 1, 0.1, 400)
  /** portrait: the intro framed on the tiles' real projected extent (u = 0, u = 1) */
  private introFit: [Shot, Shot] = [shot(), shot()]
  private introFitted = false
  private regs: (Region | undefined)[] = []
  private fitPts: THREE.Vector3[] = Array.from({ length: NF * 4 }, () => new THREE.Vector3())
  /** live node positions (the chain, drawing together into the compact map for the list) */
  private tileAt: THREE.Vector3[] = TILE_POS.map(p => new THREE.Vector3().fromArray(p))
  private starAt: THREE.Vector3[] = STAR_POS.map(p => new THREE.Vector3().fromArray(p))

  // ambient / UI state (never story state)
  private lastT = -1
  private phase = new Array(NE).fill(0)
  private tilt = new THREE.Vector2()
  private ptrK = 0
  private sel: number[] = REST.map(() => 0)
  /** the stars' own clock (slower under reduced motion; frozen with Motion off) */
  private starClock = 0
  private wAct = new Float32Array(NF)
  private ph: Phase = { kind: 'intro', k: -1, p: 0 }
  private phS: Phase = { kind: 'intro', k: -1, p: 0 }

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
      // desktop: the sources' native 1280 (the shot sits on the face, sharp at DPR 2)
      loadScreenshot(workImage(FEATURED[k].id), { width: this.mobile ? 960 : 1280 })
        .then(tex => {
          tex.anisotropy = 8
          try {
            this.ctx.renderer.initTexture(tex)
          } catch {
            /* uploads on first use instead */
          }
          const u = this.C.tiles[k].shotMat.uniforms.uMap
          const old = u.value
          u.value = tex
          old.dispose()
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
    // the names are a pointer shortcut that mirrors the list rows (the rows
    // are the keyboard / screen-reader path), so they stay out of the tab order
    this.labelsBox.setAttribute('aria-hidden', 'true')
    REST.forEach((w, j) => {
      const a = el('a', 'wk-star', undefined, this.labelsBox)
      a.href = w.url
      a.target = '_blank'
      a.rel = 'noopener'
      a.tabIndex = -1
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
    this.regs.length = 0
    // the per-item shots (and so each tile's facing) depend only on the layout
    for (let k = 0; k < NF; k++) {
      this.itemShot(k, 0, this.itemShots[k])
      _c.fromArray(TILE_POS[k])
      this.faceTo(this.itemShots[k].pos, _c, 0.07 * (k % 2 === 0 ? 1 : -1), this.faceQ[k])
    }
    this.listShot(0, this.sa)
    for (let k = 0; k < NF; k++) this.faceTo(this.sa.pos, listPos(TILE_POS[k], portrait, _c), 0, this.listQ[k])
    // portrait intro: aim, turn the tiles toward it, then frame the tiles'
    // real projected extent (twice: the turn depends on the shot)
    this.introFitted = false
    this.introShot(0.5, this.sa)
    for (let k = 0; k < NF; k++) this.faceTo(this.sa.pos, _c.fromArray(TILE_POS[k]), 0, this.introQ[k])
    if (portrait) {
      for (let pass = 0; pass < 2; pass++) {
        this.fitIntro()
        this.introShot(0.5, this.sa)
        for (let k = 0; k < NF; k++) this.faceTo(this.sa.pos, _c.fromArray(TILE_POS[k]), 0, this.introQ[k])
      }
      this.fitIntro()
    }
    this.layoutPeeks()
    return this.lay
  }

  /**
   * Short portrait screens leave little room above the list for the chosen
   * star's card: there it switches to a compact row (thumbnail + name) that
   * sits beside the star, and never reaches into the list panel.
   */
  private layoutPeeks() {
    const L = this.lay!
    const reg = this.region('list', 0)
    for (const p of this.peeks) p.root.classList.remove('is-compact')
    const full = this.peeks[0]?.root.offsetHeight ?? 0
    this.peekCompact = L.portrait && full > 0 && reg.y1 - reg.y0 < full + 12
    for (const p of this.peeks) {
      p.root.classList.toggle('is-compact', this.peekCompact)
      p.stem.classList.toggle('is-h', this.peekCompact)
      p.w = p.root.offsetWidth
      p.h = p.root.offsetHeight
    }
  }

  /** the intro tiles' corners, in their intro pose (portrait turn) */
  private introCorners() {
    const e = 0.03
    for (let k = 0; k < NF; k++) {
      _q.copy(this.C.tiles[k].restQ).slerp(this.introQ[k], 0.62)
      for (let c = 0; c < 4; c++) {
        this.fitPts[k * 4 + c]
          .set((c & 1 ? 1 : -1) * (TW / 2 + e), (c & 2 ? 1 : -1) * (TH / 2 + e), 0)
          .applyQuaternion(_q)
          .add(_c.fromArray(TILE_POS[k]))
      }
    }
    return this.fitPts
  }

  private fitIntro() {
    const L = this.lay!
    const reg = this.region('intro', 0)
    const pts = this.introCorners()
    const [a, b] = PORTRAIT_INTRO
    this.fitShot(this.introFit[0], pts, a[0], a[1], reg, L.W, L.H)
    this.fitShot(this.introFit[1], pts, b[0], b[1], reg, L.W, L.H)
    this.introFitted = true
  }

  /**
   * Aim a camera (yaw, pitch) so the projected bounds of `pts` fill the
   * screen region `reg` (CSS px): a few rounds of re-centre and dolly, which
   * converge under perspective where a subject box alone cannot.
   */
  private fitShot(out: Shot, pts: THREE.Vector3[], yaw: number, pitch: number, reg: Region, W: number, H: number) {
    const cam = this.fitCam
    const aspect = W / Math.max(1, H)
    cam.fov = FOV
    cam.aspect = aspect
    cam.updateProjectionMatrix()
    const tanH = Math.tan((FOV * DEG) / 2)
    // a first guess from the points' world bounds
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    _v.set(0, 0, 0)
    for (const p of pts) {
      _v.add(p)
      x0 = Math.min(x0, p.x)
      x1 = Math.max(x1, p.x)
      y0 = Math.min(y0, p.y)
      y1 = Math.max(y1, p.y)
    }
    _v.multiplyScalar(1 / pts.length)
    frameTo(out, _v, (x1 - x0) * 0.7, y1 - y0, yaw, pitch, FOV, reg, W, H)
    _dir.set(-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
    _r.crossVectors(_dir, UP).normalize()
    _u.crossVectors(_r, _dir).normalize()
    const rx0 = (reg.x0 / W) * 2 - 1
    const rx1 = (reg.x1 / W) * 2 - 1
    const ry0 = 1 - (reg.y1 / H) * 2
    const ry1 = 1 - (reg.y0 / H) * 2
    let D = 1
    for (let it = 0; it < 14; it++) {
      cam.position.copy(out.pos)
      cam.lookAt(_p.copy(out.pos).add(_dir))
      cam.updateMatrixWorld()
      D = _c.subVectors(_v, out.pos).dot(_dir)
      let behind = D < 0.5
      x0 = y0 = Infinity
      x1 = y1 = -Infinity
      for (const p of pts) {
        _cor.subVectors(p, out.pos)
        if (_cor.dot(_dir) < 0.3) behind = true
        _cor.copy(p).project(cam)
        x0 = Math.min(x0, _cor.x)
        x1 = Math.max(x1, _cor.x)
        y0 = Math.min(y0, _cor.y)
        y1 = Math.max(y1, _cor.y)
      }
      if (behind || !Number.isFinite(x0 + x1 + y0 + y1)) {
        out.pos.addScaledVector(_dir, -Math.max(1, D * 0.3))
        continue
      }
      const sc = clamp(Math.max((x1 - x0) / (rx1 - rx0), (y1 - y0) / (ry1 - ry0)), 0.6, 1.6)
      const hh = D * tanH
      out.pos.addScaledVector(_r, ((x0 + x1) / 2 - (rx0 + rx1) / 2) * hh * aspect).addScaledVector(_u, ((y0 + y1) / 2 - (ry0 + ry1) / 2) * hh)
      out.pos.addScaledVector(_dir, D - D * sc)
    }
    D = Math.max(0.5, _c.subVectors(_v, out.pos).dot(_dir))
    out.tgt.copy(out.pos).addScaledVector(_dir, D)
    out.fov = FOV
    out.cx = (rx0 + rx1) / 2
    out.cy = (ry0 + ry1) / 2
    return out
  }

  /** orientation that turns a tile at C to face `eye` (plus a slight yaw so its bevel catches light) */
  private faceTo(eye: THREE.Vector3, C: THREE.Vector3, yawBias: number, out: THREE.Quaternion) {
    _m.lookAt(eye, C, UP)
    out.setFromRotationMatrix(_m)
    out.multiply(_q.setFromEuler(_e.set(0, yawBias, 0)))
    return out
  }

  /** the screen region a shot frames into (cached per layout: no per-frame allocation) */
  private region(kind: 'item' | 'list' | 'intro', k: number): Region {
    const i = kind === 'item' ? k : kind === 'intro' ? NF : NF + 1
    return (this.regs[i] ??= this.computeRegion(kind, k))
  }

  private computeRegion(kind: 'item' | 'list' | 'intro', k: number): Region {
    const L = this.lay!
    const s = L.safe
    if (kind === 'intro') {
      // portrait: the tiles' real extent, 16px clear of every screen edge
      if (L.portrait) return { x0: PAD, x1: L.W - PAD, y0: Math.min(L.introB + PAD, L.H * 0.6), y1: Math.max(L.H * 0.6 + 80, s.y1 - 4) }
      return { x0: L.W * 0.08, x1: L.W * 0.99, y0: Math.min(L.introB + L.H * 0.01, L.H * 0.52), y1: s.y1 + L.H * 0.04 }
    }
    if (L.portrait) {
      // never taller than the room above the card / the list panel
      const top = kind === 'item' ? L.cardTop[k] : L.listTop
      const y1 = Math.max(60, top - 14)
      return { x0: 4, x1: L.W - 4, y0: Math.min(s.y0 + 6, y1 - 56), y1 }
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
      // portrait: from above and along the chain (it recedes up the tall
      // frame), framed on the tiles' real projected extent
      if (this.introFitted) {
        const a = this.introFit[0]
        const b = this.introFit[1]
        const e = clamp(u)
        out.pos.lerpVectors(a.pos, b.pos, e)
        out.tgt.lerpVectors(a.tgt, b.tgt, e)
        out.fov = FOV
        out.cx = lerp(a.cx, b.cx, e)
        out.cy = lerp(a.cy, b.cy, e)
        return out
      }
      // (a first guess, before the fit: it only seeds the tiles' intro turn)
      const [pa, pb] = PORTRAIT_INTRO
      _c.set(0.7, 0.1, -0.2)
      frameTo(out, _c, 9, 6.4, lerp(pa[0], pb[0], u), lerp(pa[1], pb[1], u), FOV, this.region('intro', 0), L.W, L.H)
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
    const ph = phaseOf(l, this.phS)
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
    const I0 = turnStart(0, amp) - 0.9
    const I1 = turnStart(0, amp) - 0.12
    if (l < F0) return lerp(I0, I1, smoothstep(0, 1, l / F0))
    if (l < F1) {
      const k = Math.min(NF - 1, Math.floor((l - F0) / SPAN))
      const p = clamp((l - itemStart(k)) / SPAN)
      const prev = k === 0 ? I1 : turnEnd(k - 1, amp)
      if (p < SWEEP_A) return lerp(prev, turnStart(k, amp), smoothstep(0, SWEEP_A, p))
      return lerp(turnStart(k, amp), turnEnd(k, amp), ease.inOutCubic(clamp((p - SWEEP_A) / (SWEEP_B - SWEEP_A))))
    }
    const e5 = turnEnd(NF - 1, amp)
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
    const ph = phaseOf(l, this.ph)
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
    const w = this.wAct
    for (let k = 0; k < NF; k++) w[k] = activeW(k, l)
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
    this.ptrUniforms(C.flow.u, frame.pointerRaw, aspect)
    this.ptrUniforms(C.stars.u, frame.pointerRaw, aspect)
    this.ptrUniforms(C.starLinks.u, frame.pointerRaw, aspect)

    // ---- tiles
    const landscape = !L.portrait
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
      // docks: it steps back and fades to clear glass (never a dark slab)
      const next = k < NF - 1 ? itemStart(k + 1) : F1
      const gone = landscape ? smoothstep(next, next + 0.3 * SPAN, l) * (1 - listW) : 0
      const pu = introPulse(ph, k)
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
      // the list: the six step back (smaller, faded to glass) so the nine stars carry it
      t.root.scale.setScalar(lerp(1, LIST_TILE_SCALE, listM) * (1 - 0.18 * gone))
      t.pivot.position.z = lerp(-0.25 * d, 0.1, wk)
      // the screenshot fades by opacity (revealing the glass), never by darkening
      const su = t.shotMat.uniforms
      const op = lerp(lerp(lerp(0.95, 0.5, d), 1, wk), LIST_TILE_SHOT, listM) * (1 - gone)
      su.uOpacity.value = op
      su.uBright.value = 0.84 + 0.04 * wk + pu * 0.12
      t.shot.visible = op > 0.004
      // the studio light sweeps the face as the tile turns in (alternating direction)
      const sp = ease.inOutCubic(clamp(((l - itemStart(k)) / SPAN - SWEEP_A) / (SWEEP_B - SWEEP_A)))
      su.uSheen.value = k % 2 === 0 ? lerp(-0.45, 1.45, sp) : lerp(1.45, -0.45, sp)
      su.uSheenK.value = (reduced ? 0.08 : 0.15) * wk
      t.glassMat.envMapIntensity = (lerp(lerp(0.95, 0.6, d), 1.25, wk) + pu * 0.5 + listW * 0.1) * (1 - 0.35 * gone) * ENV
      t.rimMat.uniforms.uStrength.value = (lerp(lerp(0.28, 0.12, d), 0.6, wk) + pu * 0.6 + listW * 0.14) * (1 - 0.75 * gone) * lerp(1, 0.6, listM)
      t.haloMat.uniforms.uStrength.value = (lerp(lerp(0.16, 0.06, d), 0.34, wk) + pu * 0.45 + listW * 0.12) * (1 - 0.9 * gone) * lerp(0.4, 1, gather) * lerp(1, 0.35, listM)
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
      const n0 = EDGES[e][0]
      const n1 = EDGES[e][1]
      this.nodeCentre(n0.kind, n0.i, _v)
      this.nodeCentre(n1.kind, n1.i, _c)
      if (n0.kind === 't') this.rimPoint(n0.i, _c, C.edgeA[e])
      else C.edgeA[e].copy(_v)
      if (n1.kind === 't') this.rimPoint(n1.i, _v, C.edgeB[e])
      else C.edgeB[e].copy(_c)
    }
    for (let e = 0; e < NE; e++) {
      const n0 = EDGES[e][0]
      const n1 = EDGES[e][1]
      const chain = n0.kind === 't' && n1.kind === 't'
      let g = chain ? 0.95 : 0.6
      // intro: the pulse runs along the chain
      if (ph.kind === 'intro' && chain) g += (introPulse(ph, n0.i) + introPulse(ph, n1.i)) * 0.7
      // items: the active tile's links light up, the rest dim
      let act = 0
      for (let k = 0; k < NF; k++) if ((n0.kind === 't' && n0.i === k) || (n1.kind === 't' && n1.i === k)) act = Math.max(act, w[k])
      const dimL = dimAll * (1 - act)
      g = lerp(g, g * 0.5, dimL) + act * 0.9
      // list: a calm, even constellation; the chosen star's links light
      if (listW > 0) {
        let hot = 0
        for (let j = 0; j < NR; j++) if ((n0.kind === 's' && n0.i === j) || (n1.kind === 's' && n1.i === j)) hot = Math.max(hot, this.sel[j])
        g = lerp(g, chain ? 0.95 : 0.66, listW) + hot * listW * 0.75
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
    C.link.u.uWidth.value = (this.mobile ? 1.5 : 1.7) * scaleR
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
        const n0 = EDGES[e][0]
      const n1 = EDGES[e][1]
        const isJ = (n0.kind === 's' && n0.i === j) || (n1.kind === 's' && n1.i === j)
        if (!isJ) continue
        const tn = n0.kind === 't' ? n0 : n1.kind === 't' ? n1 : null
        if (tn) v = Math.max(v, 0.2 + 0.35 * w[tn.i])
      }
      v = lerp(v, 0.34, listW) + this.sel[j] * 0.75
      lit[j] = v
      ring[j] = this.sel[j] * listW
    }
    // the stars' own clock: calmer under reduced motion, still with Motion off
    this.starClock += dt * (reduced ? 0.35 : 1)
    const fade = lerp(0.3, 1, gather)
    C.stars.u.uTime.value = this.starClock
    C.stars.u.uPx.value = px
    C.stars.u.uFade.value = fade
    C.stars.u.uSize.value = this.mobile ? 0.046 : 0.04
    C.stars.u.uMaxPx.value = (this.mobile ? 8 : 10) * scaleR
    // their little constellations' lines (particles.js line_linked)
    const sl = C.starLinks.u
    sl.uTime.value = this.starClock
    sl.uFade.value = fade
    sl.uRes.value.set(ctx.renderer.domElement.width, px)
    sl.uWidth.value = (this.mobile ? 1.1 : 1.25) * scaleR

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

  private ptrUniforms(u: { uPtr: { value: THREE.Vector2 }; uPtrK: { value: number }; uAspect: { value: number } }, ptr: THREE.Vector2, aspect: number) {
    u.uPtr.value.copy(ptr)
    u.uPtrK.value = this.ptrK
    u.uAspect.value = aspect
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

  /** hide every name / card / stem and take the box out of hit-testing */
  private hideLabels() {
    // the attribute (not only the property) so the CSS fallback also holds
    // where inert is unsupported (Safari < 15.5)
    this.labelsBox.toggleAttribute('inert', true)
    const off = (n: HTMLElement) => {
      n.style.opacity = '0'
      n.style.visibility = 'hidden'
    }
    for (const a of this.labels) off(a)
    for (const p of this.peeks) {
      off(p.root)
      off(p.stem)
    }
    this.labelsLive = false
  }

  /** the screen boxes of the six tiles (CSS px), so no star name reads as a tile's caption */
  private projectTiles(L: Layout) {
    const vc = this.vcam
    for (let k = 0; k < NF; k++) {
      const t = this.C.tiles[k]
      const sc = t.root.scale.x
      let x0 = Infinity
      let y0 = Infinity
      let x1 = -Infinity
      let y1 = -Infinity
      for (let c = 0; c < 4; c++) {
        _cor
          .set((c & 1 ? 1 : -1) * (TW / 2) * sc, (c & 2 ? 1 : -1) * (TH / 2) * sc, 0)
          .applyQuaternion(t.pivot.quaternion)
          .add(t.root.position)
          .add(t.pivot.position)
          .project(vc)
        const x = (_cor.x * 0.5 + 0.5) * L.W
        const y = (-_cor.y * 0.5 + 0.5) * L.H
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
      // a little clear air around it, more below (where a caption would sit)
      const b = this.tileBoxes[k]
      if (Number.isFinite(x0 + x1 + y0 + y1)) setBox(b, x0 - 8, y0 - 8, x1 + 8, y1 + 20)
      else setBox(b, 0, 0, 0, 0, 0)
    }
  }

  /** does a label box sit over any other visible star? */
  private coversStar(j: number, x0: number, y0: number, x1: number, y1: number) {
    for (let i = 0; i < NR; i++) {
      if (i === j || !this.okS[i]) continue
      const x = this.sx[i]
      const y = this.sy[i]
      if (x > x0 - 10 && x < x1 + 10 && y > y0 - 8 && y < y1 + 8) return true
    }
    return false
  }

  private hits(x0: number, y0: number, x1: number, y1: number) {
    for (let i = 0; i < this.nCards; i++) {
      const c = this.cardBoxes[i]
      if (c.v > 0.5 && x0 < c.x1 && x1 > c.x0 && y0 < c.y1 && y1 > c.y0) return true
    }
    for (let k = 0; k < NF; k++) {
      const c = this.tileBoxes[k]
      if (c.v > 0 && x0 < c.x1 && x1 > c.x0 && y0 < c.y1 && y1 > c.y0) return true
    }
    for (let i = 0; i < this.nPlaced; i++) {
      const r = this.placedBoxes[i]
      if (x0 < r.x1 && x1 > r.x0 && y0 < r.y1 && y1 > r.y0) return true
    }
    return false
  }

  /** the nine stars' names in space, and the chosen one's glass card */
  private placeLabels(listV: number, L: Layout) {
    reveal(this.labelsBox, listV, 0)
    // off-beat: every name and card hidden AND inert (a child's inline
    // visibility would otherwise outlive its hidden box and catch clicks)
    if (listV <= 0.01) {
      if (this.labelsLive) this.hideLabels()
      return
    }
    if (!this.labelsLive) {
      this.labelsBox.toggleAttribute('inert', false)
      this.labelsLive = true
    }
    const vc = this.vcam
    const reg = this.region('list', 0)
    const m = 10
    const { sx, sy, okS: ok } = this
    this.projectTiles(L)
    // 1) the glass cards (the chosen star's, and one fading out)
    this.nCards = 0
    for (let j = 0; j < NR; j++) {
      _c.copy(this.starAt[j]).project(vc)
      sx[j] = (_c.x * 0.5 + 0.5) * L.W
      sy[j] = (-_c.y * 0.5 + 0.5) * L.H
      ok[j] = _c.z < 1 && Number.isFinite(sx[j] + sy[j]) ? 1 : 0
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
      const lift = (1 - pv) * 8
      let left: number
      let top: number
      if (this.peekCompact) {
        // short screens: a compact row beside the star, on its roomier side,
        // wholly inside the band above the list
        const toLeft = x > (reg.x0 + reg.x1) / 2
        left = toLeft ? x - 24 - pw : x + 24
        left = Math.min(Math.max(left, reg.x0 + m), Math.max(reg.x0 + m, reg.x1 - m - pw))
        top = Math.min(Math.max(y - ph / 2, reg.y0 + 2), Math.max(reg.y0 + 2, reg.y1 - ph))
        pk.root.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top + lift)}px, 0)`
        const xa = toLeft ? left + pw : x + 7
        const xb = toLeft ? x - 7 : left
        pk.stem.style.transform = `translate3d(${Math.round(xa)}px, ${Math.round(y)}px, 0) scaleX(${Math.max(0, xb - xa).toFixed(1)})`
      } else {
        // above the star (below when there's no room), inside the free region;
        // scaled down if the region is shorter than the card
        const room = reg.y1 - reg.y0 - 4
        const fit = ph > room ? Math.max(0.55, room / ph) : 1
        const h = ph * fit
        const wv = pw * fit
        top = y - 30 - h
        let above = true
        if (top < reg.y0 + 2) {
          top = y + 30
          above = false
        }
        top = Math.min(Math.max(top, reg.y0 + 2), Math.max(reg.y0 + 2, reg.y1 - h))
        left = Math.min(Math.max(x - wv / 2, reg.x0 + m), Math.max(reg.x0 + m, reg.x1 - m - wv))
        pk.root.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top + lift)}px, 0)${fit < 1 ? ` scale(${fit.toFixed(3)})` : ''}`
        // the stem: from the card's edge to just short of the star
        const sx0 = Math.min(Math.max(x, left + 14), left + wv - 14)
        const ya = above ? top + h + lift : y + 7
        const yb = above ? y - 7 : top + lift
        pk.stem.style.transform = `translate3d(${Math.round(sx0)}px, ${Math.round(ya)}px, 0) scaleY(${Math.max(0, yb - ya).toFixed(1)})`
        setBox(this.cardBoxes[this.nCards++], left - 6, top - 6, left + wv + 6, top + h + 6, pv)
        continue
      }
      setBox(this.cardBoxes[this.nCards++], left - 6, top - 6, left + pw + 6, top + ph + 6, pv)
    }
    // 2) the names: all nine on wide screens, never under the list panel, a
    // card, a tile or another name: right of the star, then left, above,
    // below, else hidden
    this.nPlaced = 0
    // the chosen star's name first (it stays lit and under the cursor that chose it)
    let chosen = -1
    for (let j = 0; j < NR; j++) if (this.sel[j] > (chosen >= 0 ? this.sel[chosen] : 0.01)) chosen = j
    const slackX = L.W * 0.01
    for (let n = 0; n < NR; n++) {
      const j = chosen < 0 ? n : n === 0 ? chosen : n <= chosen ? n - 1 : n
      const a = this.labels[j]
      const x = sx[j]
      const y = sy[j]
      const inside = ok[j] === 1 && x > reg.x0 - 4 && x < reg.x1 + 4 && y > reg.y0 - 4 && y < reg.y1 + 4
      const lw = this.labelW[j] || a.offsetWidth
      let o = inside && !L.narrow ? lerp(0.86, 1, this.sel[j]) : 0
      let lx = x + 14
      let ly = y - 11
      let flip = false
      let mid = false
      if (o > 0.01) {
        // candidates: right, left, above, below, then the four diagonals (the
        // first that fits, is clear, and covers no other star)
        let found = false
        for (let c = 0; c < CAND.length && !found; c++) {
          const hx = CAND[c][0]
          const vy = CAND[c][1]
          const cx = hx > 0 ? x + 14 : hx < 0 ? x - 14 - lw : x - lw / 2
          const cy = y - 11 + vy
          const fits = cx > reg.x0 - 4 && cx + lw < reg.x1 + slackX && cy > reg.y0 - 4 && cy + LABEL_H < reg.y1 + 4
          if (!fits || this.coversStar(j, cx, cy, cx + lw, cy + LABEL_H)) continue
          // (the chosen name is placed first, so this only keeps it off its card and the tiles)
          if (this.hits(cx - 4, cy - 1, cx + lw + 4, cy + LABEL_H + 1)) continue
          lx = cx
          ly = cy
          flip = hx < 0
          mid = hx === 0
          found = true
        }
        if (!found && j === chosen) {
          // the chosen name falls back to its side of the star
          lx = x + 14 + lw < reg.x1 + slackX ? x + 14 : x - 14 - lw
          flip = lx < x
          found = true
        }
        if (!found) o = 0
        if (o > 0.01 && j !== chosen) {
          for (let i = 0; i < this.nCards; i++) {
            const c = this.cardBoxes[i]
            if (c.v <= 0.5 && lx < c.x1 && lx + lw > c.x0 && ly + LABEL_H > c.y0 && ly < c.y1) o *= 1 - c.v
          }
        }
      }
      if (o > 0.01 && this.nPlaced < NR) setBox(this.placedBoxes[this.nPlaced++], lx - 4, ly - 1, lx + lw + 4, ly + LABEL_H + 1)
      a.style.transform = `translate3d(${Math.round(lx)}px, ${Math.round(ly)}px, 0)`
      a.classList.toggle('is-flip', flip)
      a.classList.toggle('is-mid', mid)
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
