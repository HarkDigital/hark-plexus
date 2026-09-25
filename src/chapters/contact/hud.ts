import { el, rise } from '../../core/dom'
import { BRAND, CONTACT, OTHER_CONCEPTS } from '../../content'

/*
 * CONNECT · the contact card. One frosted glass panel (left and vertically
 * centred on landscape, along the bottom on portrait): the eyebrow, "Say
 * hello.", the body, the address as the big primary action, Copy email, the
 * sister concepts as small glass pills (each with a lit node), Back to top
 * and the colophon.
 *
 * Layout is MEASURED on resize / font load / size change (never per frame)
 * so the 3D can sit in whatever space the card leaves: `art` is that free
 * rectangle in CSS px, `ctaFrom` is where the address's link line leaves
 * the card. Short screens step the card down through fit levels.
 */

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface Hud {
  stage: HTMLElement
  probe: HTMLElement
  wrap: HTMLElement
  panel: HTMLElement
  title: HTMLElement
  mail: HTMLAnchorElement
  copyBtn: HTMLButtonElement
  signoff: HTMLElement
  dirty: boolean
  /** performance.now() of the last successful copy (drives a soft swell of the core) */
  copiedAt: number
  /** pointer or focus is on the address / the copy button */
  hover: boolean
}

export interface HudLayout {
  W: number
  H: number
  portrait: boolean
  /** free area for the 3D, CSS px */
  art: Rect
  panel: Rect
  /** where the address's line leaves the card (CSS px) */
  ctaFrom: { x: number; y: number }
}

const ICON_MAIL =
  '<svg class="ct-ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="5.5" width="18" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m4.8 7.6 7.2 5.3 7.2-5.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** Portrait layout (card along the bottom). Keep in sync with contact.css. */
export const PORTRAIT_QUERY = '(max-width: 767px) and (orientation: portrait), (max-width: 767px) and (min-height: 501px), (max-aspect-ratio: 9/10)'

/** Copy text: async Clipboard API first, then a hidden-textarea fallback. */
export async function copyText(text: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* denied or unsupported: fall through */
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.setAttribute('aria-hidden', 'true')
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;'
  const active = document.activeElement as HTMLElement | null
  document.body.appendChild(ta)
  ta.select()
  ta.setSelectionRange(0, text.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  active?.focus?.({ preventScroll: true })
  return ok
}

/** A polite live region OUTSIDE the aria-hidden stage, so the copy result is announced. */
function liveRegion() {
  const id = 'ct-copy-live'
  let node = document.getElementById(id)
  if (!node) {
    node = document.createElement('p')
    node.id = id
    node.className = 'sr-only'
    node.setAttribute('role', 'status')
    node.setAttribute('aria-live', 'polite')
    document.body.appendChild(node)
  }
  return node
}

export function buildHud(stage: HTMLElement): Hud {
  const probe = el('div', 'ct-probe', undefined, stage)
  const wrap = el('div', 'ct-wrap', undefined, stage)
  const panel = el('div', 'hud-panel hud-panel--strong ct-panel', undefined, wrap)

  el('p', 'hud-eyebrow ct-eyebrow', CONTACT.eyebrow, panel)
  const words = CONTACT.title.split(' ')
  const last = words.pop() ?? ''
  const title = rise(el('h2', 'hud-title ct-title', undefined, panel), `${words.join(' ')} <em>${last}</em>`)
  el('p', 'hud-body ct-body', CONTACT.body, panel)

  const cta = el('div', 'ct-cta', undefined, panel)
  const mail = el('a', 'hud-btn ct-mail', undefined, cta)
  mail.href = CONTACT.href
  mail.innerHTML = `${ICON_MAIL}<span class="ct-mail-addr"></span><span class="ct-go" aria-hidden="true">→</span>`
  mail.querySelector('.ct-mail-addr')!.textContent = BRAND.email

  const copyBtn = el('button', 'hud-btn hud-btn--ghost ct-copy', undefined, cta)
  copyBtn.type = 'button'
  copyBtn.innerHTML =
    '<span class="ct-copy-idle">Copy<span class="ct-copy-more"> email</span></span><span class="ct-copy-done" aria-hidden="true">Copied</span><span class="ct-copy-fail" aria-hidden="true">Copy failed</span>'
  // a local status line too (the stage is aria-hidden; the real announcement is the body-level region)
  const status = el('span', 'sr-only', undefined, cta)
  status.setAttribute('aria-live', 'polite')

  el('hr', 'hud-rule ct-rule', undefined, panel)

  const more = el('div', 'ct-more', undefined, panel)
  el('p', 'hud-label ct-more-label', 'Other concepts', more)
  const list = el('ul', 'ct-links', undefined, more)
  for (const c of OTHER_CONCEPTS) {
    const li = el('li', '', undefined, list)
    const a = el('a', 'ct-link', undefined, li)
    a.href = c.url
    a.target = '_blank'
    a.rel = 'noopener'
    el('span', 'ct-node', undefined, a).setAttribute('aria-hidden', 'true')
    el('span', '', c.name, a)
    el('span', 'ct-arr', '↗', a).setAttribute('aria-hidden', 'true')
  }

  const foot = el('div', 'ct-foot', undefined, panel)
  const top = el('button', 'ct-top', undefined, foot)
  top.type = 'button'
  el('span', '', 'Back to top', top)
  el('span', 'ct-arr', '↑', top).setAttribute('aria-hidden', 'true')
  top.addEventListener('click', e => {
    const hark = window.__hark
    if (!hark) return
    hark.land('hero')
    if (e.detail === 0) hark.engine?.focusChapter('hero')
  })
  const legal = el('p', 'ct-legal', undefined, foot)
  el('span', 'ct-nw', `© ${new Date().getFullYear()} ${BRAND.name}`, legal)
  // the locale is its own run so the shortest phones can keep the colophon on one line
  const locale = el('span', 'ct-locale', undefined, legal)
  for (const p of BRAND.locale.split(' · ')) {
    locale.append(' · ')
    el('span', 'ct-nw', p, locale)
  }

  // the sign-off under the halo: the tagline (verbatim) as a display line that
  // bookends Genesis. Particles write it first (scene.ts), then the type
  // crossfades in. Each word is its own box so the particles can match it.
  const signoff = el('p', 'hud-h2 ct-signoff', undefined, stage)
  signoff.setAttribute('aria-hidden', 'true')
  const tw = BRAND.tagline.split(' ')
  tw.forEach((w, i) => {
    if (i) signoff.append(' ')
    if (i === tw.length - 1) el('span', 'ct-sw', w, el('em', '', undefined, signoff))
    else el('span', 'ct-sw', w, signoff)
  })

  const hud: Hud = { stage, probe, wrap, panel, title, mail, copyBtn, signoff, dirty: true, copiedAt: -1e9, hover: false }

  // the scene answers the address: the network routes to the mark while it's hovered
  let over = 0
  const on = () => {
    over++
    hud.hover = true
  }
  const off = () => {
    over = Math.max(0, over - 1)
    hud.hover = over > 0
  }
  for (const n of [mail, copyBtn]) {
    n.addEventListener('pointerenter', on)
    n.addEventListener('pointerleave', off)
    n.addEventListener('focus', on)
    n.addEventListener('blur', off)
  }

  const live = liveRegion()
  let resetT = 0
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(BRAND.email)
    window.clearTimeout(resetT)
    copyBtn.classList.toggle('is-copied', ok)
    copyBtn.classList.toggle('is-failed', !ok)
    if (ok) hud.copiedAt = performance.now()
    const msg = ok ? `Copied ${BRAND.email} to the clipboard.` : `Copy failed. The address is ${BRAND.email}.`
    live.textContent = msg
    status.textContent = msg
    resetT = window.setTimeout(() => {
      copyBtn.classList.remove('is-copied', 'is-failed')
      live.textContent = ''
      status.textContent = ''
    }, 1900)
  })

  const dirty = () => (hud.dirty = true)
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(dirty)
    ro.observe(probe)
    ro.observe(panel)
  }
  window.addEventListener('resize', dirty)
  document.fonts?.ready.then(dirty).catch(() => {})
  return hud
}

/** The sign-off line as laid out by CSS: box size, font and each word's box (CSS px, line-relative). */
export interface SignSpec {
  w: number
  h: number
  fontPx: number
  weight: string
  family: string
  /** letter-spacing, px */
  spacing: number
  words: { text: string; x: number; w: number; accent: boolean }[]
}

/** Measure the sign-off (on layout only). Null when CSS hides it. */
export function measureSignoff(hud: Hud): SignSpec | null {
  const n = hud.signoff
  const w = n.offsetWidth
  const h = n.offsetHeight
  if (!w || !h) return null
  const cs = getComputedStyle(n)
  const fontPx = parseFloat(cs.fontSize) || 32
  const ls = parseFloat(cs.letterSpacing)
  const words: SignSpec['words'] = []
  n.querySelectorAll<HTMLElement>('.ct-sw').forEach(s => {
    // the line is absolutely positioned, so it is each word's offsetParent
    words.push({ text: s.textContent ?? '', x: s.offsetLeft, w: s.offsetWidth, accent: !!s.closest('em') })
  })
  return { w, h, fontPx, weight: cs.fontWeight || '560', family: cs.fontFamily, spacing: Number.isFinite(ls) ? ls : 0, words }
}

const FIT = ['ct-fit-1', 'ct-fit-2', 'ct-fit-3'] as const

export function measureHud(hud: Hud, W: number, H: number, allowFit = true): HudLayout {
  const stage = hud.stage
  const portrait = matchMedia(PORTRAIT_QUERY).matches
  stage.classList.remove(...FIT)
  const band = hud.probe.getBoundingClientRect()
  const bandH = Math.max(1, band.height)
  // portrait: the card may take most of the band, the mark lives above it
  const limit = portrait ? bandH * (W < 420 ? 0.74 : 0.64) : bandH
  if (allowFit) for (let i = 0; i < FIT.length && hud.panel.offsetHeight > limit; i++) stage.classList.add(FIT[i])

  // offset* ignore the reveal transform, so the measure is stable mid-reveal
  const w = hud.wrap.getBoundingClientRect()
  const x0 = w.left + hud.panel.offsetLeft
  const y0 = w.top + hud.panel.offsetTop
  const panel = { x0, y0, x1: x0 + hud.panel.offsetWidth, y1: y0 + hud.panel.offsetHeight }

  // the address pill, in the card's own frame (offsetParent chain up to the panel)
  let mx = 0
  let my = 0
  let n: HTMLElement | null = hud.mail
  while (n && n !== hud.panel) {
    mx += n.offsetLeft
    my += n.offsetTop
    n = n.offsetParent as HTMLElement | null
  }
  const mail = { x0: x0 + mx, y0: y0 + my, x1: x0 + mx + hud.mail.offsetWidth, y1: y0 + my + hud.mail.offsetHeight }

  let art: Rect
  let ctaFrom: { x: number; y: number }
  if (!portrait) {
    const gap = Math.max(24, W * 0.025)
    art = { x0: panel.x1 + gap, x1: band.right, y0: band.top, y1: band.bottom }
    ctaFrom = { x: panel.x1, y: (mail.y0 + mail.y1) / 2 }
  } else {
    const gap = Math.max(12, H * 0.018)
    // the mark may rise into the top band's empty middle (brand left, menu right)
    const top = Math.max(band.top * 0.62, 40)
    art = { x0: band.left, x1: band.right, y0: top, y1: Math.max(top + 90, panel.y0 - gap) }
    ctaFrom = { x: (mail.x0 + mail.x1) / 2, y: panel.y0 }
  }
  return { W, H, portrait, art, panel, ctaFrom }
}
