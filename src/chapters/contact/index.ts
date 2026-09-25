import * as THREE from 'three'
import type { Chapter, ChapterContext } from '../../core/types'
import { reveal, setRise } from '../../core/dom'
import { clamp, damp, ease, lerp, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { buildHud, measureHud, type Hud, type HudLayout } from './hud'
import { buildScene, type ConnectScene } from './scene'
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
 * orbits, the nodes glide onto them, and by ~0.87 it is a calm, conclusive
 * still — the mark bright inside a soft halo of light.
 *
 *   0.00–0.06  calm in-beat under the particle cut (frosted, the mark at 3/4)
 *   0.04–0.15  focus pull: the frame clears, the card comes up, "Say hello."
 *   0.05–0.32  the network reaches for the mark (beams grow, packets begin)
 *   0.30       landing / intro: everything settled and alive
 *   0.46–0.87  the dust condenses into orbits, nodes glide onto the halo
 *   0.70–0.88  one last light sweep across the glass; the mark turns front-on
 *   0.86–1.00  the final still (the tagline signs off beneath the halo)
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
  // the mark's centre and height, CSS px
  let cx = 0
  let cy = 0
  let unitPx = 200
  let hot = 0
  let signoffOk = true
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
    if (!lay.portrait) {
      unitPx = Math.min(ah * 0.34, aw * 0.28)
      cx = (a.x0 + a.x1) / 2
      cy = (a.y0 + a.y1) / 2
    } else {
      unitPx = Math.min(ah * 0.46, aw * 0.29)
      cx = (a.x0 + a.x1) / 2
      cy = (a.y0 + a.y1) / 2
    }
    // the sign-off sits under the halo when there is room for it
    const sy = cy + unitPx * 1.56
    // clear of the card (portrait) or of the chrome's bottom readout (landscape)
    signoffOk = sy + 16 < (lay.portrait ? lay.panel.y0 - 8 : H - 72)
    hud.signoff.style.transform = `translate3d(${cx.toFixed(1)}px, ${sy.toFixed(1)}px, 0) translateX(-50%)`
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
      group.add(set.rig)
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

      // ---- the visitor: the mouse, or a gentle wanderer on touch screens
      let tx = vis.x
      let ty = vis.y
      let tk = 0
      if (mouse && !touch) {
        tx = (frame.pointerRaw.x * 0.5 + 0.5) * W
        ty = (0.5 - frame.pointerRaw.y * 0.5) * H
        const p = L.panel
        const inCard = tx > p.x0 && tx < p.x1 && ty > p.y0 && ty < p.y1
        tk = inCard ? 0.18 : 1
      } else if (touch || !mouse) {
        const t = frame.time
        tx = cx + unitPx * 1.3 * Math.cos(t * 0.16 + 0.6)
        ty = cy - unitPx * 0.95 * Math.sin(t * 0.23 + 1.4)
        tk = touch ? 0.75 : 0
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

      set.update({
        local,
        time: frame.time,
        dt: frame.still ? 0 : frame.dt,
        calm,
        rm,
        W,
        H,
        dpr: ctx.renderer.domElement.height / Math.max(1, H),
        resX: ctx.renderer.domElement.width,
        resY: ctx.renderer.domElement.height,
        unitPx,
        cx,
        cy,
        D,
        wpp,
        visitor: vis,
        panel: L.panel,
        hot,
        ctaFrom: L.ctaFrom,
        pulse,
        presence,
      })

      // ---- the world: the network gathers behind the mark (the glass refracts it)
      const wp = ctx.world.params
      const aspect = W / H
      wp.focus.set(((cx / W) * 2 - 1) * aspect, 1 - (cy / H) * 2)
      // (kept small: World's gather moves far nodes out of their 3x3 cell window and
      // clips them into hard-edged half dots above ~0.05 — see coreChangeRequests)
      wp.gather = 0.045 * smoothstep(0.08, 0.7, local)
      wp.net = 0.62 - 0.24 * quiet
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
      pp.bloomStrength = 0.6 + 0.14 * settle
      pp.bloomRadius = 0.55
      pp.bloomThreshold = 0.9
      pp.vignette = 0.32

      // ---- copy
      reveal(hud.panel, smoothstep(0.05, 0.14, local))
      setRise(hud.title, local > 0.08)
      reveal(hud.signoff, signoffOk ? smoothstep(0.84, 0.92, local) : 0, 0)
    },

    camera(local, _frame, out) {
      out.position.set(0, 0, distFor(local))
      out.target.set(0, 0, 0)
      out.fov = FOV
      out.roll = 0
      out.parallax = 0.22
    },
  }
}
