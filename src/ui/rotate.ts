import { holdInert, releaseInert } from './inert'
import { SITE } from '../content'

/*
 * Phone-landscape suggestion: a frosted glass card over the (paused) scene.
 * Plexus is framed in portrait on phones, so a short, touch-first landscape
 * viewport is offered "Turn your phone upright" beside a phone drawn as a
 * little constellation (four corner nodes, linked) that turns upright once,
 * plus "Continue anyway". Tablets and laptops in landscape are taller than
 * 500px and never see it.
 *
 * It is a suggestion, never a lock (WCAG 1.3.4): "Continue anyway" releases
 * it for the rest of the session. While it shows, the skip link and the
 * linear copy layer in #track stay reachable (and their focus pills paint
 * above the card: it sits at z 25, under #track:focus-within and the skip
 * link); only the chrome and the stages behind it are inert.
 *
 * API: mountRotateGate(onChange?) / unmountRotateGate(). Safe to call more
 * than once: later calls just add their onChange listener.
 */

export const ROTATE_QUERY = '(orientation: landscape) and (max-height: 500px) and (pointer: coarse)'

const DISMISS_KEY = 'hark-plexus:rotate-ok'
const wasDismissed = () => {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}
const rememberDismissed = () => {
  try {
    sessionStorage.setItem(DISMISS_KEY, '1')
  } catch {
    /* blocked storage: the choice lasts until reload */
  }
}

// a phone as a constellation: corner nodes, hairline links, a few inner stars
const PHONE = `<svg class="rot-phone" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
  <g class="rot-phone-g">
    <path class="rot-l" d="M20 6h24a4 4 0 0 1 4 4v44a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4V10a4 4 0 0 1 4-4z"/>
    <path class="rot-l rot-l--in" d="M22 16l10 8 9-4M32 24l-4 14 12 6M28 38l-6 8"/>
    <circle class="rot-n" cx="16.6" cy="7" r="2.2"/><circle class="rot-n" cx="47.4" cy="7" r="2.2"/>
    <circle class="rot-n" cx="47.4" cy="57" r="2.2"/><circle class="rot-n" cx="16.6" cy="57" r="2.2"/>
    <circle class="rot-s" cx="22" cy="16" r="1.4"/><circle class="rot-s" cx="32" cy="24" r="1.8"/><circle class="rot-s" cx="41" cy="20" r="1.3"/>
    <circle class="rot-s" cx="28" cy="38" r="1.5"/><circle class="rot-s" cx="40" cy="44" r="1.3"/><circle class="rot-s" cx="22" cy="46" r="1.2"/>
  </g>
</svg>`

let gate: {
  el: HTMLElement
  mq: MediaQueryList
  sync: () => void
  listeners: ((shown: boolean) => void)[]
  on: () => boolean
} | null = null

export function mountRotateGate(onChange?: (shown: boolean) => void) {
  if (gate) {
    if (onChange) {
      gate.listeners.push(onChange)
      onChange(gate.on())
    }
    return
  }
  if (typeof matchMedia === 'undefined') return
  let dismissed = wasDismissed()
  const el = document.createElement('div')
  el.className = 'rot'
  // non-modal: the copy layer behind it stays in reach
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-labelledby', 'rot-title')
  el.setAttribute('aria-describedby', 'rot-sub')
  el.tabIndex = -1
  el.innerHTML = `
    <div class="rot-card">
      <div class="rot-art" aria-hidden="true">${PHONE}</div>
      <div class="rot-text">
        <h2 class="rot-title" id="rot-title">Turn your phone <em>upright</em></h2>
        <p class="rot-sub" id="rot-sub">${SITE.name} is framed for portrait.</p>
        <p class="rot-actions"><button class="hud-btn hud-btn--ghost rot-go" type="button">Continue anyway</button></p>
      </div>
    </div>
    <p class="sr-only" aria-live="assertive" data-rot-live></p>`
  // right after the skip link: Tab goes skip link → this card → the page
  const skip = document.querySelector('.skip-link')
  if (skip && skip.parentNode === document.body) skip.after(el)
  else document.body.prepend(el)

  const live = el.querySelector<HTMLElement>('[data-rot-live]')!
  const go = el.querySelector<HTMLButtonElement>('.rot-go')!
  const mq = matchMedia(ROTATE_QUERY)
  const listeners: ((shown: boolean) => void)[] = onChange ? [onChange] : []
  let on = false
  const sync = () => {
    const want = mq.matches && !dismissed
    if (want === on) return
    on = want
    el.classList.toggle('is-on', on)
    document.documentElement.classList.toggle('is-rotate', on)
    if (on) {
      // only the layers the card hides; the skip link and #track stay reachable
      holdInert('rotate', ['chrome', 'stages'].map(id => document.getElementById(id)))
      // focus stranded in a now-inert layer (or on <body>) comes to the card;
      // a reader already in the copy layer or on the skip link stays put
      const a = document.activeElement
      const keep = a instanceof HTMLElement && a !== document.body && (a.closest('#track') || a.matches('.skip-link'))
      if (!keep) el.focus({ preventScroll: true })
      // a live region only speaks when its text changes after it is shown
      requestAnimationFrame(() => {
        if (on) live.textContent = `Turn your phone upright. ${SITE.name} is framed for portrait.`
      })
    } else {
      releaseInert('rotate')
      live.textContent = ''
    }
    for (const fn of listeners) fn(on)
  }

  go.addEventListener('click', () => {
    const hadFocus = el.contains(document.activeElement)
    dismissed = true
    rememberDismissed()
    sync()
    if (!hadFocus) return
    // the card is gone: hand focus to the story, like the skip link does
    const main = document.getElementById('track')
    if (main && !main.closest('[inert], [aria-hidden="true"]')) main.focus({ preventScroll: true })
    else (document.activeElement as HTMLElement | null)?.blur?.()
  })

  mq.addEventListener?.('change', sync)
  gate = { el, mq, sync, listeners, on: () => on }
  sync()
}

/** The plain HTML page reads fine in any orientation. */
export function unmountRotateGate() {
  if (!gate) return
  const was = gate.on()
  gate.mq.removeEventListener?.('change', gate.sync)
  gate.el.remove()
  document.documentElement.classList.remove('is-rotate')
  releaseInert('rotate')
  if (was) for (const fn of gate.listeners) fn(false)
  gate = null
}
