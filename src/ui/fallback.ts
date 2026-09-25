import { BRAND, CONTACT } from '../content'
import { CHAPTER_COPY_IDS, buildChapterCopy } from '../core/srContent'
import { CHAPTERS } from '../chapters/index'
import { CONCEPT_TAG, WORDMARK, markSvg } from './mark'
import { unmountRotateGate } from './rotate'
import { releaseInert } from './inert'

/*
 * The plain HTML version: for browsers without WebGL2, the "Read as a page"
 * link (?read), and the last resort if boot fails. Every chapter's copy, in
 * story order, visible, as a quiet typographic page made of the same night
 * glass as the live site: a still particle network drawn once in SVG behind
 * it (decorative), the brand and the primary nav in glass capsules, and one
 * frosted card per chapter. Same copy as the live site, verbatim, from
 * srContent (buildChapterCopy). Styled by the .fb-* rules in ui.css.
 *
 * Landmarks: the banner <header> sits just before <main id="track">, so
 * "Skip to content" (#track) lands on the story itself, past the navigation.
 */

const BUSINESS: Record<string, string> = {
  hero: 'Home',
  work: 'Work',
  services: 'Services',
  voices: 'Clients',
  shield: 'Security',
  process: 'Process',
  contact: 'Contact',
}
const pad = (n: number) => String(n).padStart(2, '0')

/** a still constellation: seeded nodes, lines between near neighbours (alpha by distance) */
function starfield(): string {
  let s = 20240917
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
  const W = 1600
  const H = 1000
  const L = 150
  const nodes = Array.from({ length: 70 }, () => [rand() * W, rand() * H, 0.8 + rand() * 1.6] as const)
  let lines = ''
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const d = Math.hypot(nodes[i][0] - nodes[j][0], nodes[i][1] - nodes[j][1])
      if (d < L)
        lines += `<line x1="${nodes[i][0].toFixed(0)}" y1="${nodes[i][1].toFixed(0)}" x2="${nodes[j][0].toFixed(0)}" y2="${nodes[j][1].toFixed(0)}" stroke-opacity="${((1 - d / L) * 0.5).toFixed(2)}"/>`
    }
  const dots = nodes.map(n => `<circle cx="${n[0].toFixed(0)}" cy="${n[1].toFixed(0)}" r="${n[2].toFixed(1)}"/>`).join('')
  const halos = nodes
    .filter((_, i) => i % 5 === 0)
    .map(n => `<circle cx="${n[0].toFixed(0)}" cy="${n[1].toFixed(0)}" r="${(n[2] * 5).toFixed(1)}"/>`)
    .join('')
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice" focusable="false">
    <g class="fb-net-l">${lines}</g><g class="fb-net-h">${halos}</g><g class="fb-net-n">${dots}</g></svg>`
}

export function renderFallback(root: HTMLElement) {
  document.documentElement.classList.add('no-webgl')
  unmountRotateGate()
  // boot can fail while the loader or the menu still holds the page inert: let go
  releaseInert('loader')
  releaseInert('menu')
  document.getElementById('loader')?.remove()
  document.getElementById('gl')?.remove()
  root.style.pointerEvents = 'auto'

  // the backdrop (decorative) and the banner, around <main>
  document.querySelector('.fb-bg')?.remove()
  document.getElementById('fb-head')?.remove()
  const bg = document.createElement('div')
  bg.className = 'fb-bg'
  bg.setAttribute('aria-hidden', 'true')
  bg.innerHTML = starfield()
  document.body.prepend(bg)

  // opened from "Read as a page" in a browser that can run the live site: offer the way back
  const params = new URLSearchParams(location.search)
  let live = ''
  if (params.has('read')) {
    params.delete('read')
    const q = params.toString()
    live = `<a class="fb-live" href="${location.pathname}${q ? `?${q}` : ''}">View the live site</a>`
  }

  const header = document.createElement('header')
  header.className = 'fb-head'
  header.id = 'fb-head'
  header.innerHTML = `
    <a class="fb-brand fb-glass" href="#hero" aria-label="${BRAND.name}, top of page">
      <span class="fb-node" aria-hidden="true">${markSvg('fb-mark')}</span>
      <span class="fb-brand-text" aria-hidden="true">${WORDMARK}${CONCEPT_TAG}</span>
    </a>
    <nav class="fb-nav fb-glass" aria-label="Primary">
      <a class="fb-link" href="#work">Work</a>
      <a class="fb-link" href="#services">Services</a>
      <a class="fb-link" href="#contact">Contact</a>
      <a class="hud-btn fb-cta" href="${CONTACT.href}">Start a project</a>
    </nav>
    ${live}`
  root.parentNode?.insertBefore(header, root)

  root.innerHTML = ''
  root.classList.add('fb')
  const order = CHAPTERS.map(c => c.id).filter(id => CHAPTER_COPY_IDS.includes(id))
  for (const id of CHAPTER_COPY_IDS) if (!order.includes(id)) order.push(id)
  order.forEach((id, i) => {
    const copy = buildChapterCopy(id, true)
    if (!copy) return
    // heading Tab stops only drive the live story
    copy.querySelectorAll('h1[tabindex], h2[tabindex]').forEach(h => h.removeAttribute('tabindex'))
    // item "stops" only steer the live story; here they're just headings
    copy.querySelectorAll<HTMLAnchorElement>('a[data-anchor][href^="#"]:not([data-land])').forEach(a => {
      const span = document.createElement('span')
      span.textContent = a.textContent
      a.replaceWith(span)
    })
    const label = CHAPTERS.find(c => c.id === id)?.label ?? ''
    const sec = document.createElement('section')
    sec.className = `fb-sec fb-sec--${id}`
    sec.id = id
    const heading = copy.querySelector<HTMLElement>('h1, h2')
    if (heading) {
      heading.id = `fb-${id}-title`
      sec.setAttribute('aria-labelledby', heading.id)
    }
    const kicker = document.createElement('p')
    kicker.className = 'fb-k'
    kicker.setAttribute('aria-hidden', 'true')
    kicker.innerHTML = `<span class="fb-k-n">${pad(i + 1)}</span><i></i><span class="fb-k-l">${label}</span><span class="fb-k-b">${BUSINESS[id] ?? ''}</span>`
    const card = document.createElement('div')
    card.className = id === 'hero' ? 'fb-hero' : 'fb-card'
    card.appendChild(copy)
    sec.append(kicker, card)
    root.appendChild(sec)
  })
}
