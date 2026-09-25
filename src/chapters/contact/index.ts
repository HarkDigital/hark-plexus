import * as THREE from 'three'
import type { Chapter, ChapterContext } from '../../core/types'
import { reveal, setRise } from '../../core/dom'
import { clamp, damp, ease, lerp, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { buildHud, measureHud, measureSignoff, type Hud, type HudLayout, type Rect } from './hud'
import { buildScene, HALO_Y, type ConnectInput, type ConnectScene, type FinaleLayout } from './scene'
import './contact.css'

/*
 * CONTACT · "Connect" — the final chapter.
 *
 * The glass Hark mark returns beside the card, its ice crystal core lit. The
 * whole backdrop network GATHERS toward it, and a foreground constellation
 * reaches for it: beams grow from the nodes to the glass and carry small
 * packets of light in. The visitor's pointer is a node too — a warm peach
 * one: beams reach from it to the nodes nearby and the network parts around
 * it (particles.js grab + repulse; touch screens get a gentle wandering
 * visitor). Hovering the address routes a beam from the card to the mark.
 * Then the scene resolves: a loose cloud of dust condenses into three tilted
 * orbits and the nodes glide onto them. For the finale the glass mark steps
 * forward inside its halo while the scaffolding dims, and dust peels off the
 * halo to WRITE the sign-off — "Make the internet listen.", bookending
 * Genesis — before the type itself crossfades in. The last frame is still.
 *
 *   0.00–0.06  calm in-beat under the particle cut (frosted, the mark at 3/4)
 *   0.04–0.15  focus pull: the frame clears, the card comes up, "Say hello."
 *   0.05–0.32  the network reaches for the mark (beams grow, packets begin)
 *   0.30       landing / intro: everything settled and alive
 *   0.46–0.87  the dust condenses into orbits, nodes glide onto the halo
 *   0.66–0.88  one last light sweep across the glass
 *   0.74–0.88  the halo makes room for the line; the mark grows x1.4 into a
 *              3/4 view; beams, lamp and core bloom fall back
 *   0.80–0.94  dust from the halo writes the sign-off, left to right
 *   0.92–0.975 the type crossfades in, the dust lets go
 *   0.975–1.00 the final still
 */

const FOV = 30
const DIST = 10
const TAN = Math.tan(THREE.MathUtils.degToRad(FOV / 2))

export default function create(): Chapter {
  const group = new THREE.Group()
  let hud: Hud
  let set: ConnectScene
  let lay: HudLayout | null = null
  let lastW = 0
  let lastH = 0
  // the mark's centre and height, CSS px (this frame: base → finale)
  let cx = 0
  let cy = 0
  let unitPx = 200
  let hot = 0
  // the settled layout, and the finale's (the halo steps up, the sign-off beneath)
  const base = { cx: 0, cy: 0, u: 200 }
  const fin: FinaleLayout = { cx: 0, cy: 0, u: 200, sx: 0, sy: 0 }
  const signRect: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 }
  let signOk = false
  let layoutId = 0
  let input: ConnectInput | null = null
  // the visitor node
  let mouse = false
  let visInit = false
  const vis = { x: 0, y: 0, k: 0 }
  const touch = typeof matchMedia !== 'undefined' && !matchMedia('(hover: hover) and (pointer: fine)').matches
  const shortLandscape = () => matchMedia('(orientation: landscape) and (max-height: 500px)').matches

  const relayout = (W: number, H: number) => {
    lay = measureHud(hud, W, H, !shortLandscape())
    hud.dirty = false
    lastW = W
    lastH = H
    const a = lay.art
    const aw = Math.max(40, a.x1 - a.x0)
    const ah = Math.max(40, a.y1 - a.y0)
    // the halo's height and width budgets (portrait lets it rise into the top band's middle)
    const kh = lay.portrait ? 0.46 : 0.34
    const kw = lay.portrait ? 0.29 : 0.28
    base.u = Math.min(ah * kh, aw * kw)
    base.cx = (a.x0 + a.x1) / 2
    base.cy = (a.y0 + a.y1) / 2

    // the finale: the halo and the sign-off beneath it share the art area, centred as a group
    const sp = measureSignoff(hud)
    signOk = false
    if (sp) {
      const gap = Math.max(10, sp.h * 0.4)
      const u1 = Math.min(aw * kw, (ah - sp.h - gap) * kh)
      const group = 2 * HALO_Y * u1 + gap + sp.h
      const top = a.y0 + (ah - group) / 2
      const lo = (lay.portrait ? 16 : a.x0) + sp.w / 2
      const hi = (lay.portrait ? W - 16 : a.x1) - sp.w / 2
      const sy = top + 2 * HALO_Y * u1 + gap + sp.h / 2
      const limit = lay.portrait ? lay.panel.y0 - 4 : H - 64
      if (lo <= hi && u1 >= Math.max(36, base.u * 0.6) && sy + sp.h / 2 <= limit) {
        signOk = true
        fin.u = u1
        fin.cx = base.cx
        fin.cy = top + HALO_Y * u1
        fin.sx = clamp(base.cx, lo, hi)
        fin.sy = sy
        signRect.x0 = fin.sx - sp.w / 2
        signRect.x1 = fin.sx + sp.w / 2
        signRect.y0 = sy - sp.h / 2
        signRect.y1 = sy + sp.h / 2
        hud.signoff.style.transform = `translate3d(${signRect.x0.toFixed(1)}px, ${signRect.y0.toFixed(1)}px, 0)`
      }
    }
    if (!signOk) {
      fin.u = base.u
      fin.cx = base.cx
      fin.cy = base.cy
    }
    set.layoutText(signOk ? sp : null, W, H, fin)
    layoutId++
  }

  /** camera distance for this local: a slow push-in toward the final still */
  const distFor = (local: number) => DIST * (1.04 - 0.06 * ease.inOutCubic(clamp(local / 0.9)))

  return {
    id: 'contact',
    group,
    anchors: [0.3],

    async init(ctx: ChapterContext) {
      hud = buildHud(ctx.stage)
      window.addEventListener('pointermove', e => {
        mouse = e.pointerType === 'mouse'
      })
      document.documentElement.addEventListener('pointerleave', () => (mouse = false))
      await nextFrame()
      set = buildScene({ mobile: ctx.mobile })
      group.add(set.root)
      // one input object, refilled every frame
      input = {
        local: 0,
        time: 0,
        dt: 0,
        calm: false,
        rm: false,
        W: 1,
        H: 1,
        dpr: 1,
        resX: 1,
        resY: 1,
        unitPx,
        cx,
        cy,
        D: DIST,
        wpp: 0.01,
        visitor: vis,
        panel: null,
        hot: 0,
        ctaFrom: null,
        pulse: 0,
        presence: 1,
        layoutId: 0,
        sign: null,
      }
      await nextFrame()
    },

    update(local, frame, ctx) {
      const W = frame.width
      const H = frame.height
      if (hud.dirty || W !== lastW || H !== lastH || !lay) relayout(W, H)
      const L = lay!

      const rm = frame.reducedMotion
      const calm = rm || !!frame.still
      const D = distFor(local)
      const wpp = (2 * D * TAN) / H
      const presence = 0.6 + 0.4 * smoothstep(0.0, 0.1, local)
      const settle = smoothstep(0.5, 0.87, local)
      const quiet = smoothstep(0.8, 0.94, local)
      const finK = smoothstep(0.74, 0.88, local)
      const end = smoothstep(0.9, 1.0, local)
      // the halo makes room for the sign-off
      const lk = signOk ? finK : 0
      cx = lerp(base.cx, fin.cx, lk)
      cy = lerp(base.cy, fin.cy, lk)
      unitPx = lerp(base.u, fin.u, lk)

      // ---- the visitor: the mouse, or a gentle wanderer on touch screens
      let tx = vis.x
      let ty = vis.y
      let tk = 0
      if (mouse && !touch) {
        tx = (frame.pointerRaw.x * 0.5 + 0.5) * W
        ty = (0.5 - frame.pointerRaw.y * 0.5) * H
        const p = L.panel
        const inCard = tx > p.x0 && tx < p.x1 && ty > p.y0 && ty < p.y1
        // resting on the sign-off, the visitor steps back so the line stays clean
        const s = signRect
        const inSign = signOk && tx > s.x0 - 24 && tx < s.x1 + 24 && ty > s.y0 - 24 && ty < s.y1 + 24
        tk = inCard ? 0.18 : inSign ? 1 - 0.8 * finK : 1
      } else if (touch || !mouse) {
        const t = frame.time
        tx = cx + unitPx * 1.3 * Math.cos(t * 0.16 + 0.6)
        ty = cy - unitPx * 0.95 * Math.sin(t * 0.23 + 1.4)
        // the wandering visitor rests for the final still
        tk = touch ? 0.75 * (1 - end) : 0
      }
      if (calm) tk = 0
      if (!visInit) {
        vis.x = tx
        vis.y = ty
        visInit = true
      }
      const kp = mouse && !touch ? 16 : 3
      vis.x = damp(vis.x, tx, kp, frame.dt)
      vis.y = damp(vis.y, ty, kp, frame.dt)
      vis.k = damp(vis.k, tk, 4, frame.dt)

      hot = damp(hot, hud.hover ? 1 : 0, 5, frame.dt)
      const since = (performance.now() - hud.copiedAt) / 1000
      const pulse = since >= 0 && since < 1.5 ? since / 1.5 : 0

      const I = input!
      I.local = local
      I.time = frame.time
      I.dt = frame.still ? 0 : frame.dt
      I.calm = calm
      I.rm = rm
      I.W = W
      I.H = H
      I.dpr = ctx.renderer.domElement.height / Math.max(1, H)
      I.resX = ctx.renderer.domElement.width
      I.resY = ctx.renderer.domElement.height
      I.unitPx = unitPx
      I.cx = cx
      I.cy = cy
      I.D = D
      I.wpp = wpp
      I.panel = L.panel
      I.hot = hot
      I.ctaFrom = L.ctaFrom
      I.pulse = pulse
      I.presence = presence
      I.layoutId = layoutId
      I.sign = signOk ? signRect : null
      set.update(I)

      // ---- the world: the network gathers behind the mark (the glass refracts it)
      const wp = ctx.world.params
      const aspect = W / H
      wp.focus.set(((cx / W) * 2 - 1) * aspect, 1 - (cy / H) * 2)
      // (kept small: World's gather moves far nodes out of their 3x3 cell window and
      // clips them into hard-edged half dots above ~0.05 — see coreChangeRequests)
      wp.gather = 0.045 * smoothstep(0.08, 0.7, local)
      // the backdrop steps back for the final beat (the sign-off and the glass carry it)
      wp.net = 0.62 - 0.2 * quiet - 0.06 * end
      wp.speed = rm ? 0.3 : lerp(1, 0.45, quiet)
      wp.pointer = 0.5
      wp.a = '#6a5cd6'
      wp.b = '#3a86e0'
      wp.env = 1.5
      // light sweeps across the glass (scroll-driven, so reduced motion keeps it too): a
      // warm glint passes as the network reaches the mark, white edge light for the
      // landing, then clear front faces for the still (past ~1.0 the studio strips
      // flood the flat faces, so the path never goes there)
      wp.envTurn = -0.6 + 1.2 * smoothstep(0.06, 0.3, local) + 0.3 * smoothstep(0.66, 0.88, local)
      wp.keyDir.set(-0.35, 0.75, 0.6)
      wp.key = 1.35

      // ---- post: the focus pull out of the cut; the halo glows
      const pp = ctx.post.params
      pp.frost = 0.3 * (1 - smoothstep(0.03, 0.15, local))
      pp.bloomStrength = 0.6 + 0.14 * settle - 0.24 * finK
      pp.bloomRadius = 0.55
      pp.bloomThreshold = 0.9
      pp.vignette = 0.32

      // ---- copy
      reveal(hud.panel, smoothstep(0.05, 0.14, local))
      setRise(hud.title, local > 0.08)
      // the type resolves out of the dust (scene.ts writes it first)
      reveal(hud.signoff, signOk ? smoothstep(0.92, 0.975, local) : 0, 0)
    },

    camera(local, _frame, out) {
      out.position.set(0, 0, distFor(local))
      out.target.set(0, 0, 0)
      out.fov = FOV
      out.roll = 0
      // the finale settles (and the written line stays registered with the type)
      out.parallax = 0.22 * (1 - 0.75 * smoothstep(0.74, 0.9, local))
    },
  }
}
