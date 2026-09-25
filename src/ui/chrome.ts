import type { Engine, EngineState } from '../core/Engine'
import type { Frame } from '../core/types'
import type { Sound } from './sound'
import { BRAND, MICROCOPY } from '../content'
import { CONCEPT_TAG, WORDMARK, markSvg } from './mark'
import { holdInert, releaseInert } from './inert'
import { mountRotateGate } from './rotate'
import { bindScene, holdScene, releaseScene } from './scene'
import { Net2D } from './net2d'

/*
 * Persistent chrome, in frosted glass, wired like a particle network.
 *
 *   top-left      a glass capsule: the Hark mark (white) inside a small lit
 *                 glass node, the real "Hark.Digital" wordmark (its dot is a
 *                 lit node) and a small "Concept · Plexus" tag (→ the start)
 *   top-right     a glass capsule with Work · Services · Contact and an ice
 *                 glass "Start a project" pill. A LINK — a hairline with a
 *                 lit node at each end — glides under the link you point at
 *                 (or rests under the chapter you're in). ≤ 720px: a "Menu"
 *                 pill opens a full-screen frosted sheet with its own slow
 *                 particle network behind a big nav (a real modal dialog:
 *                 focus trap, Escape, inert background with a fallback,
 *                 focus returns to Menu), 'Start a project', 'Read as a page'
 *                 (?read) and the Sound / Motion switches
 *   bottom-left   Sound: five dots that ride the actual audio while it plays
 *                 (aria-pressed); Motion: a three-node constellation that is
 *                 linked while motion is on (aria-pressed). Motion off sets
 *                 html.motion-off and engine.motion = false (the scene's idle
 *                 motion freezes), is remembered for the session and starts
 *                 off under prefers-reduced-motion. ≤ 560px both become
 *                 round icon pills
 *   bottom-right  the readout "03 / 07 · Nodes · Services" beside the seven
 *                 chapters drawn as a tiny CONSTELLATION: dots joined by
 *                 hairlines, the path lighting up ice as the story travels
 *                 along it, the current star lit and haloed. Every star is a
 *                 ≥ 24px button
 *
 * Every text sits on a night-glass fill dense enough for ≥ 4.5:1 over the
 * brightest node the network can put behind it. The always-visible chrome
 * has no backdrop-filter (it would make the compositor wait on every WebGL
 * frame); only the menu sheet frosts for real (and not under html.lowfx).
 *
 * API used by main.ts: createChrome(root, engine, sound) → { update(frame, state) }.
 * Navigation always uses engine.land(id) (lands on settled copy; long jumps cut).
 */

/** Plain business names beside each chapter's poetic label. */
const BUSINESS: Record<string, string> = {
  hero: 'Home',
  work: 'Work',
  services: 'Services',
  voices: 'Clients',
  shield: 'Security',
  process: 'Process',
  contact: 'Contact',
}
const NAV = ['work', 'services', 'contact']
const MENU_QUERY = '(max-width: 720px)'
const MOTION_LABEL = 'Motion'
const MOTION_KEY = 'hark-plexus:motion'
/** the pip constellation: one cell per chapter; each star's height in its cell (0..1) */
const SKY_Y = [0.64, 0.3, 0.56, 0.24, 0.62, 0.36, 0.5]

const readMotion = (fallback: boolean) => {
  try {
    const v = sessionStorage.getItem(MOTION_KEY)
    if (v === '1') return true
    if (v === '0') return false
  } catch {
    /* blocked storage: the default for this visit */
  }
  return fallback
}
const rememberMotion = (on: boolean) => {
  try {
    sessionStorage.setItem(MOTION_KEY, on ? '1' : '0')
  } catch {
    /* blocked storage: the choice lasts until reload */
  }
}
const pad = (n: number) => String(n).padStart(2, '0')
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

const MENU_IC = `<svg viewBox="0 0 18 12" aria-hidden="true" focusable="false"><path d="M2 2.5h14M2 9.5h14"/><circle cx="2" cy="2.5" r="1.6"/><circle cx="16" cy="9.5" r="1.6"/></svg>`
const CLOSE_IC = `<svg viewBox="0 0 18 12" aria-hidden="true" focusable="false"><path d="M4 1l10 10M14 1L4 11"/><circle cx="4" cy="1" r="1.4"/><circle cx="14" cy="11" r="1.4"/><circle cx="14" cy="1" r="1.4"/><circle cx="4" cy="11" r="1.4"/></svg>`
const MOTION_IC = `<svg class="ch-tri" viewBox="0 0 18 18" aria-hidden="true" focusable="false"><path class="ch-tri-l" d="M3.2 13.6L9 3.4l5.8 9.4z"/><circle cx="3.2" cy="13.6" r="2"/><circle cx="9" cy="3.4" r="2"/><circle cx="14.8" cy="12.8" r="2"/></svg>`

export function createChrome(root: HTMLElement, engine: Engine, sound: Sound) {
  const slots = engine.slots
  const total = slots.length
  const indexOf = (id: string) => slots.findIndex(s => s.def.id === id)
  const biz = (id: string, fallback = '') => BUSINESS[id] ?? fallback
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

  // the rotate card and the menu sheet both freeze the frame behind their glass
  bindScene(engine)
  mountRotateGate(shown => (shown ? holdScene('rotate') : releaseScene('rotate')))

  // ---------------------------------------------------------------- markup

  const brandInner = `<span class="ch-node" aria-hidden="true">${markSvg('ch-mark-svg')}</span>
      <span class="ch-brand-text" aria-hidden="true">${WORDMARK}${CONCEPT_TAG}</span>`

  const links = NAV.filter(id => indexOf(id) >= 0)
    .map(id => `<li><a class="ch-link" href="#${id}" data-go="${id}"><span class="ch-link-t">${biz(id)}</span></a></li>`)
    .join('')

  // the constellation: cell centres, joined in story order
  const CELL = 26
  const SKY_H = 30
  const W = CELL * total
  const pts = slots.map((_, i) => [CELL * i + CELL / 2, 4 + (SKY_H - 8) * (SKY_Y[i % SKY_Y.length] ?? 0.5)] as [number, number])
  const cum = [0]
  for (let i = 1; i < pts.length; i++)
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  const skyLen = cum[cum.length - 1] || 1
  const poly = pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  // two faint cross-links make it read as a constellation, not a chart
  const cross = [
    [1, 3],
    [4, 6],
  ]
    .filter(([a, b]) => pts[a] && pts[b])
    .map(([a, b]) => `<line class="ch-sky-x" x1="${pts[a][0]}" y1="${pts[a][1]}" x2="${pts[b][0]}" y2="${pts[b][1]}"/>`)
    .join('')

  const pips = slots
    .map(
      (s, i) =>
        `<li><button class="ch-pip" type="button" data-go="${s.def.id}" data-i="${i}" style="--y:${pts[i][1].toFixed(1)}px" aria-label="${esc(biz(s.def.id, s.def.label))}: chapter ${i + 1} of ${total}, ${esc(s.def.label)}"><i aria-hidden="true"></i></button></li>`,
    )
    .join('')

  const menuItems = slots
    .map(
      (s, i) =>
        `<li style="--i:${i}"><a class="ch-ml" href="#${s.def.id}" data-go="${s.def.id}" aria-label="${esc(biz(s.def.id, s.def.label))}, chapter ${i + 1} of ${total}: ${esc(s.def.label)}">
          <span class="ch-ml-n" aria-hidden="true">${pad(i + 1)}</span>
          <span class="ch-ml-name" aria-hidden="true">${esc(biz(s.def.id, s.def.label))}</span>
          <span class="ch-ml-lab" aria-hidden="true">${esc(s.def.label)}</span>
        </a></li>`,
    )
    .join('')

  let motionOn = readMotion(!reduced)
  const soundBtn = (extra = '') =>
    `<button class="ch-tgl ch-sound ch-glass${extra}" type="button" data-sound-toggle aria-pressed="false"><span class="ch-dots" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span class="ch-tgl-k">${MICROCOPY.audio}</span><span class="ch-tgl-st" aria-hidden="true">${MICROCOPY.audioOff}</span></button>`
  const motionBtn = (extra = '') =>
    `<button class="ch-tgl ch-motion ch-glass${extra}" type="button" data-motion-toggle aria-pressed="${motionOn}">${MOTION_IC}<span class="ch-tgl-k">${MOTION_LABEL}</span><span class="ch-tgl-st" aria-hidden="true">${motionOn ? MICROCOPY.audioOn : MICROCOPY.audioOff}</span></button>`

  root.innerHTML = `
  <div class="chr">
    <header class="ch-top">
      <a class="ch-brand ch-glass" href="#hero" data-go="hero" aria-label="${esc(BRAND.name)}, back to the start">
        ${brandInner}
      </a>
      <nav class="ch-nav ch-glass" aria-label="Primary">
        <div class="ch-links-wrap"><span class="ch-wire" aria-hidden="true"></span><ul class="ch-links">${links}</ul></div>
        <a class="hud-btn ch-cta" href="#contact" data-go="contact" data-focus>Start a project</a>
      </nav>
      <button class="ch-menu-btn ch-glass" type="button" aria-expanded="false" aria-controls="ch-menu" aria-haspopup="dialog">
        <span class="ch-menu-t">Menu</span><span class="ch-menu-ic">${MENU_IC}</span>
      </button>
    </header>

    <div class="ch-bottom">
      <div class="ch-togs">${soundBtn()}${motionBtn()}</div>
      <div class="ch-prog ch-glass">
        <p class="ch-read" aria-hidden="true"><span class="ch-read-n"></span><span class="ch-read-l"></span><span class="ch-read-b"></span></p>
        <nav class="ch-pips" aria-label="Chapters" style="--sky-w:${W}px;--sky-h:${SKY_H}px">
          <svg class="ch-sky" viewBox="0 0 ${W} ${SKY_H}" aria-hidden="true" focusable="false">
            ${cross}
            <polyline class="ch-sky-base" points="${poly}"/>
            <polyline class="ch-sky-lit" points="${poly}"/>
          </svg>
          <ol>${pips}</ol>
        </nav>
      </div>
    </div>

    <div class="ch-menu" id="ch-menu" role="dialog" aria-modal="true" aria-labelledby="ch-menu-title" data-lenis-prevent hidden>
      <canvas class="ch-menu-net" aria-hidden="true"></canvas>
      <div class="ch-menu-top">
        <span class="ch-brand ch-glass ch-menu-brand" aria-hidden="true">${brandInner}</span>
        <button class="ch-menu-btn ch-menu-close ch-glass" type="button">
          <span class="ch-menu-t">Close</span><span class="ch-menu-ic">${CLOSE_IC}</span>
        </button>
      </div>
      <div class="ch-menu-body">
        <p class="hud-eyebrow ch-menu-eyebrow" id="ch-menu-title">Menu</p>
        <nav class="ch-menu-nav" aria-label="Chapters"><ol class="ch-menu-list">${menuItems}</ol></nav>
        <div class="ch-menu-foot">
          <a class="hud-btn ch-menu-cta" href="#contact" data-go="contact">Start a project</a>
          <a class="hud-btn hud-btn--ghost ch-menu-read" href="?read">Read as a page</a>
        </div>
        <div class="ch-menu-togs">${soundBtn(' ch-menu-sound')}${motionBtn(' ch-menu-motion')}</div>
        <p class="ch-menu-mail"><a href="mailto:${BRAND.email}">${BRAND.email}</a></p>
      </div>
    </div>
  </div>`

  const $ = <T extends Element = HTMLElement>(s: string) => root.querySelector<T>(s)!
  const chr = $('.chr')
  const top = $('.ch-top')
  const bottom = $('.ch-bottom')
  const menu = $('.ch-menu')
  const menuBtn = $<HTMLButtonElement>('.ch-top .ch-menu-btn')
  const menuClose = $<HTMLButtonElement>('.ch-menu-close')
  const wrapEl = $('.ch-links-wrap')
  const wire = $('.ch-wire')
  const navEls = [...root.querySelectorAll<HTMLAnchorElement>('.ch-link')]
  const pipEls = [...root.querySelectorAll<HTMLButtonElement>('.ch-pip')]
  const menuLinks = [...root.querySelectorAll<HTMLAnchorElement>('.ch-ml')]
  const soundBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-sound-toggle]')]
  const motionBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-motion-toggle]')]
  const dots = [...root.querySelectorAll<HTMLElement>('.ch-togs .ch-sound .ch-dots i')]
  const readN = $('.ch-read-n')
  const readL = $('.ch-read-l')
  const readB = $('.ch-read-b')
  const lit = $<SVGPolylineElement>('.ch-sky-lit')
  const prog = $('.ch-prog')
  const readEl = $('.ch-read')
  lit.style.strokeDasharray = `${skyLen} ${skyLen}`
  lit.style.strokeDashoffset = String(skyLen)

  // ---------------------------------------------------------------- navigation

  const go = (id: string) => {
    if (indexOf(id) >= 0) engine.land(id)
  }

  root.addEventListener('click', e => {
    const a = (e.target as Element).closest<HTMLElement>('[data-go]')
    if (!a || !root.contains(a)) return
    e.preventDefault()
    const id = a.dataset.go!
    const fromMenu = menuOpen && menu.contains(a)
    if (menuOpen) closeMenu(false)
    sound.blip(a.matches('.ch-cta, .ch-menu-cta') ? 5 : Math.max(0, indexOf(id)))
    go(id)
    // menu links always hand focus on (the sheet they lived in is gone); the top
    // nav, CTA, brand and stars do it for keyboard activation (click.detail 0)
    if (fromMenu || (e.detail === 0 && (a.matches('.ch-link, .ch-pip, .ch-brand') || a.hasAttribute('data-focus'))))
      engine.focusChapter(id)
  })

  // ------------------------------------------------ the gliding link under the nav

  let activeId = ''
  let hoverLink: HTMLElement | null = null
  let wirePlaced = false
  const placeWire = () => {
    const el = hoverLink ?? navEls.find(a => a.dataset.go === activeId) ?? null
    const t = el?.querySelector<HTMLElement>('.ch-link-t')
    if (!el || !t || !t.offsetWidth) {
      wire.classList.remove('is-on')
      return
    }
    const w = t.offsetWidth + 10
    // the link is positioned, so its offsetLeft is already relative to the wrap
    const x = el.offsetLeft + t.offsetLeft - 5
    wire.style.width = `${w}px`
    wire.style.transform = `translate3d(${x}px, 0, 0)`
    if (!wirePlaced) {
      // first placement: appear in place, no slide in from the left
      wirePlaced = true
      wire.classList.add('is-instant')
      void wire.offsetWidth
      wire.classList.remove('is-instant')
    }
    wire.classList.add('is-on')
    wire.classList.toggle('is-hover', !!hoverLink && hoverLink.dataset.go !== activeId)
  }
  navEls.forEach(a => {
    const on = () => {
      hoverLink = a
      placeWire()
    }
    const off = () => {
      if (hoverLink === a) hoverLink = null
      placeWire()
    }
    a.addEventListener('pointerenter', on)
    a.addEventListener('focus', on)
    a.addEventListener('blur', off)
  })
  wrapEl.addEventListener('pointerleave', () => {
    hoverLink = null
    placeWire()
  })
  window.addEventListener('resize', placeWire)
  document.fonts?.ready.then(placeWire).catch(() => {})

  // ------------------------------------------------------------- the readout

  let lastIndex = -1
  let cueIndex = -1
  const showReadout = (i: number, cue = false) => {
    const s = slots[i]
    if (!s) return
    readN.textContent = cue ? `Go to ${pad(i + 1)}` : `${pad(i + 1)} / ${pad(total)}`
    readL.textContent = s.def.label
    readB.textContent = biz(s.def.id, s.def.label)
    chr.classList.toggle('is-cue', cue)
  }
  pipEls.forEach((b, i) => {
    const cue = () => {
      cueIndex = i
      showReadout(i, i !== lastIndex)
    }
    b.addEventListener('pointerenter', e => {
      if ((e as PointerEvent).pointerType !== 'touch') cue()
    })
    b.addEventListener('focus', cue)
    const uncue = () => {
      if (cueIndex !== i) return
      cueIndex = -1
      if (lastIndex >= 0) showReadout(lastIndex)
    }
    b.addEventListener('pointerleave', uncue)
    b.addEventListener('blur', uncue)
  })

  // --------------------------------------------------------------------- sound

  const syncSound = (on: boolean) => {
    for (const b of soundBtns) {
      b.setAttribute('aria-pressed', String(on))
      const st = b.querySelector('.ch-tgl-st')
      if (st) st.textContent = on ? MICROCOPY.audioOn : MICROCOPY.audioOff
    }
    chr.classList.toggle('is-sound', on)
    if (!on) for (const d of dots) d.style.transform = ''
  }
  for (const b of soundBtns) b.addEventListener('click', () => sound.toggle())
  sound.onChange.push(syncSound)
  syncSound(sound.enabled)

  // -------------------------------------------------------------------- motion

  const syncMotion = () => {
    document.documentElement.classList.toggle('motion-off', !motionOn)
    engine.motion = motionOn
    chr.classList.toggle('is-still', !motionOn)
    for (const b of motionBtns) {
      b.setAttribute('aria-pressed', String(motionOn))
      const st = b.querySelector('.ch-tgl-st')
      if (st) st.textContent = motionOn ? MICROCOPY.audioOn : MICROCOPY.audioOff
    }
    window.dispatchEvent(new CustomEvent('hark:motion', { detail: { on: motionOn } }))
    if (menuOpen) netKick()
  }
  for (const b of motionBtns)
    b.addEventListener('click', () => {
      motionOn = !motionOn
      rememberMotion(motionOn)
      sound.blip(motionOn ? 4 : 1)
      syncMotion()
    })

  // --------------------------------------------------------------- menu sheet

  let menuOpen = false
  let hideTimer = 0
  // the sheet's own slow particle network (drawn only while the sheet is open)
  const netCanvas = $<HTMLCanvasElement>('.ch-menu-net')
  const net = new Net2D(netCanvas, { count: 34, link: 118, lineAlpha: 0.4, size: [0.9, 1.9], speed: 9, repel: 0, dust: 30 })
  let netRaf = 0
  let netLast = 0
  let netTime = 0
  const netFrame = (ms: number) => {
    netRaf = 0
    if (!menuOpen) return
    const dt = netLast ? Math.min(0.05, (ms - netLast) / 1000) : 0
    netLast = ms
    const calm = reduced || !motionOn
    netTime += calm ? 0 : dt
    try {
      net.resize()
      net.step(dt, netTime, null, calm)
      net.draw()
    } catch {
      return // decoration only: a failed canvas just leaves the frosted sheet
    }
    // a still network is drawn once; a moving one keeps going while the sheet is up
    if (!calm) netRaf = requestAnimationFrame(netFrame)
  }
  const netKick = () => {
    if (netRaf) cancelAnimationFrame(netRaf)
    netLast = 0
    netRaf = requestAnimationFrame(netFrame)
  }
  window.addEventListener('resize', () => {
    if (menuOpen) netKick()
  })

  const focusables = () =>
    [...menu.querySelectorAll<HTMLElement>('a[href], button')].filter(el => !el.hidden && el.getClientRects().length > 0)
  const openMenu = () => {
    if (menuOpen) return
    menuOpen = true
    clearTimeout(hideTimer)
    menu.hidden = false
    // flush the closed state so the entrance runs
    void menu.offsetWidth
    chr.classList.add('is-menu')
    menuBtn.setAttribute('aria-expanded', 'true')
    holdInert('menu', [
      document.getElementById('stages'),
      document.getElementById('track'),
      document.querySelector<HTMLElement>('.skip-link'),
      top,
      bottom,
    ])
    engine.lenis.stop()
    netKick()
    // freeze the frame once the sheet is up (it frosts a still image)
    hideTimer = window.setTimeout(
      () => {
        if (menuOpen) holdScene('menu')
      },
      reduced ? 0 : 420,
    )
    menu.scrollTop = 0
    const now = menuLinks[lastIndex] ?? menuLinks[0]
    now?.focus({ preventScroll: true })
  }
  const closeMenu = (restoreFocus = true) => {
    if (!menuOpen) return
    menuOpen = false
    clearTimeout(hideTimer)
    chr.classList.remove('is-menu')
    menuBtn.setAttribute('aria-expanded', 'false')
    releaseInert('menu')
    releaseScene('menu')
    engine.lenis.start()
    if (netRaf) cancelAnimationFrame(netRaf)
    netRaf = 0
    hideTimer = window.setTimeout(
      () => {
        if (!menuOpen) menu.hidden = true
      },
      reduced ? 20 : 380,
    )
    if (restoreFocus) menuBtn.focus({ preventScroll: true })
  }
  menuBtn.addEventListener('click', () => (menuOpen ? closeMenu() : openMenu()))
  menuClose.addEventListener('click', () => closeMenu())
  // capture: the dialog's own trap runs ahead of the no-`inert` fallback in inert.ts
  window.addEventListener(
    'keydown',
    e => {
      if (!menuOpen) return
      if (e.key === 'Escape') {
        e.preventDefault()
        closeMenu()
      } else if (e.key === 'Tab') {
        const f = focusables()
        if (!f.length) return
        const i = f.indexOf(document.activeElement as HTMLElement)
        const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : i < 0 || i === f.length - 1 ? 0 : i + 1
        e.preventDefault()
        f[next].focus()
      }
    },
    true,
  )
  const narrow = matchMedia(MENU_QUERY)
  narrow.addEventListener?.('change', e => {
    if (!e.matches) closeMenu(false)
    placeWire()
  })

  syncMotion()

  // -------------------------------------------------------------------- update

  let lastFill = -1
  const lv = [0, 0, 0, 0, 0]
  const rest = [0.35, 0.7, 1, 0.6, 0.3]

  return {
    update(frame: Frame, state: EngineState) {
      const slot = state.slots[state.index]
      if (!slot) return

      if (state.index !== lastIndex) {
        const first = lastIndex < 0
        lastIndex = state.index
        // a star still under the pointer keeps its cue, but "Go to" only while it is elsewhere
        if (cueIndex < 0) showReadout(state.index)
        else showReadout(cueIndex, cueIndex !== state.index)
        const calm = reduced || !motionOn
        pipEls.forEach((p, i) => {
          p.classList.toggle('is-on', i === state.index)
          p.classList.toggle('is-past', i < state.index)
          p.classList.remove('is-arrive')
          if (i === state.index) p.setAttribute('aria-current', 'step')
          else p.removeAttribute('aria-current')
        })
        if (!first && !calm) {
          // the star we reached lights with one soft ring; the name pulls into focus
          const p = pipEls[state.index]
          void p.offsetWidth
          p.classList.add('is-arrive')
          if (typeof readEl.animate === 'function')
            readEl.animate([{ filter: 'blur(3px)', opacity: 0.3 }, { filter: 'blur(0px)', opacity: 1 }], {
              duration: 600,
              easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
            })
        }
        activeId = slot.def.id
        navEls.forEach(a => {
          const on = a.dataset.go === activeId
          a.classList.toggle('is-active', on)
          if (on) a.setAttribute('aria-current', 'location')
          else a.removeAttribute('aria-current')
        })
        menuLinks.forEach((a, i) => {
          a.classList.toggle('is-now', i === state.index)
          if (i === state.index) a.setAttribute('aria-current', 'location')
          else a.removeAttribute('aria-current')
        })
        chr.dataset.chapter = activeId
        prog.dataset.chapter = activeId
        placeWire()
      }

      // the light travels the constellation: it reaches a star as its chapter
      // begins and runs on toward the next one as the chapter plays
      const i = state.index
      const l = Math.min(1, Math.max(0, state.local))
      const along = i < pts.length - 1 ? cum[i] + (cum[i + 1] - cum[i]) * l : skyLen
      const fill = Math.round(along * 10) / 10
      if (fill !== lastFill) {
        lastFill = fill
        lit.style.strokeDashoffset = String(skyLen - fill)
      }

      // sound dots ride the real signal (a calm fixed shape when motion is off)
      if (sound.enabled && dots.length) {
        if (!reduced && motionOn && sound.meter(lv)) {
          for (let k = 0; k < 5; k++) {
            const idle = Math.sin(frame.time * (1.3 + k * 0.41) + k * 1.9)
            const v = Math.min(1, lv[k] * lv[k] * 1.4 + 0.15)
            const y = -(v * 5.5 + idle * 0.8) * (0.6 + rest[k] * 0.4)
            dots[k].style.transform = `translate3d(0, ${y.toFixed(2)}px, 0)`
          }
        } else for (let k = 0; k < 5; k++) dots[k].style.transform = `translate3d(0, ${(-rest[k] * 3.5).toFixed(2)}px, 0)`
      }
    },
  }
}
