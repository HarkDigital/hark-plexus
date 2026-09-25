import * as THREE from 'three'

/*
 * "Your site": a minimal website etched into a floating pane of clear glass.
 *
 * The etch is a plane INSIDE the pane rendered in three's OPAQUE list with
 * additive blending (transparent: false, no depth writes): the transmission
 * pass captures opaque objects, so the pane — and the hex dome that later
 * closes in front of it — refract the site instead of hiding it.
 *
 * The texture packs three masks, tinted by uniform in the shader:
 *   R = neutral lines (frame, bars, text)
 *   G = accent (buttons, the little constellation, icons)
 *   B = alert-only marks (a warning badge, an error banner) — shown while
 *       the site is infected
 * The infection is a uniform too: accents go ember, bands of the page slip
 * sideways (smoothly, never stepped), and a restore scan line sweeps down
 * the page as the shield takes over, leaving the healthy page behind it.
 */

/** Rounded-rect path (Safari 15 has no CanvasRenderingContext2D.roundRect). */
function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const q = Math.min(r, w / 2, h / 2)
  g.beginPath()
  g.moveTo(x + q, y)
  g.lineTo(x + w - q, y)
  g.arcTo(x + w, y, x + w, y + q, q)
  g.lineTo(x + w, y + h - q)
  g.arcTo(x + w, y + h, x + w - q, y + h, q)
  g.lineTo(x + q, y + h)
  g.arcTo(x, y + h, x, y + h - q, q)
  g.lineTo(x, y + q)
  g.arcTo(x, y, x + q, y, q)
  g.closePath()
}

/** Board: 1500 x 975 (the pane's 3.0 x 1.95 units at 500 px per unit). */
export const SITE_W = 3.0
export const SITE_H = 1.95

function drawSite(cv: HTMLCanvasElement) {
  const g = cv.getContext('2d')!
  const s = cv.width / 1500
  g.globalCompositeOperation = 'source-over'
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.fillStyle = '#000'
  g.fillRect(0, 0, cv.width, cv.height)
  g.setTransform(s, 0, 0, s, 0, 0)
  g.globalCompositeOperation = 'lighter'
  g.lineCap = 'round'
  g.lineJoin = 'round'
  const N = (v: number) => `rgb(${v},0,0)`
  const A = (v: number) => `rgb(0,${v},0)`
  const X = (v: number) => `rgb(0,0,${v})`
  const fillR = (x: number, y: number, w: number, h: number, r: number, c: string) => {
    rr(g, x, y, w, h, r)
    g.fillStyle = c
    g.fill()
  }
  const strokeR = (x: number, y: number, w: number, h: number, r: number, c: string, lw: number) => {
    rr(g, x, y, w, h, r)
    g.strokeStyle = c
    g.lineWidth = lw
    g.stroke()
  }
  const bar = (x: number, y: number, w: number, h: number, c: string) => fillR(x, y - h / 2, w, h, h / 2, c)
  const dot = (x: number, y: number, r: number, c: string) => {
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fillStyle = c
    g.fill()
  }
  const line = (x0: number, y0: number, x1: number, y1: number, c: string, lw: number) => {
    g.beginPath()
    g.moveTo(x0, y0)
    g.lineTo(x1, y1)
    g.strokeStyle = c
    g.lineWidth = lw
    g.stroke()
  }

  // browser frame + title bar
  strokeR(16, 16, 1468, 943, 54, N(80), 3)
  for (const [i, x] of [58, 86, 114].entries()) dot(x, 56, 8, N(i === 0 ? 170 : 115))
  strokeR(520, 36, 460, 40, 20, N(100), 3)
  // a small padlock before the address
  strokeR(560, 51, 16, 13, 3, N(150), 3)
  g.beginPath()
  g.arc(568, 51, 5.5, Math.PI, 0)
  g.strokeStyle = N(150)
  g.lineWidth = 3
  g.stroke()
  g.fillStyle = N(170)
  g.font = `500 21px 'DM Mono', ui-monospace, monospace`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText('yoursite.com', 758, 57)
  line(38, 96, 1462, 96, N(58), 2)

  // nav: a glowing bead + wordmark, links, a CTA pill
  dot(102, 150, 11, A(255))
  bar(126, 150, 116, 13, N(205))
  for (const x of [830, 918, 1006, 1094]) bar(x, 150, 60, 9, N(130))
  strokeR(1212, 130, 196, 40, 20, A(215), 3)
  bar(1256, 150, 108, 8, N(150))

  // an error banner (alert only)
  fillR(92, 198, 1316, 34, 17, X(70))
  bar(118, 215, 18, 18, X(230))
  bar(150, 215, 380, 9, X(200))

  // hero, left: headline, sub-lines, buttons
  fillR(92, 262, 590, 54, 15, N(215))
  fillR(92, 334, 440, 54, 15, N(215))
  bar(92, 442, 540, 12, N(118))
  bar(92, 468, 490, 12, N(118))
  bar(92, 494, 360, 12, N(118))
  fillR(92, 542, 216, 54, 27, A(225))
  bar(138, 569, 124, 10, N(60))
  strokeR(326, 542, 180, 54, 27, N(140), 3)
  bar(364, 569, 104, 10, N(130))

  // hero, right: a card with a small constellation (the Plexus touch)
  strokeR(812, 256, 596, 360, 26, N(110), 3)
  bar(852, 296, 140, 11, N(150))
  bar(852, 320, 90, 8, N(90))
  const nodes: [number, number][] = [
    [880, 540],
    [948, 470],
    [1030, 510],
    [1090, 420],
    [1160, 470],
    [1232, 392],
    [1300, 440],
    [1360, 370],
    [1000, 580],
    [1200, 560],
    [1320, 540],
  ]
  const links = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 6],
    [6, 7],
    [0, 8],
    [8, 2],
    [4, 9],
    [9, 10],
    [10, 6],
    [2, 4],
  ]
  for (const [a, b] of links) line(nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1], A(120), 3)
  for (const [i, [x, y]] of nodes.entries()) dot(x, y, i % 3 === 0 ? 9 : 6, A(255))
  // a warning badge over the card (alert only)
  g.beginPath()
  g.moveTo(1110, 312)
  g.lineTo(1150, 382)
  g.lineTo(1070, 382)
  g.closePath()
  g.strokeStyle = X(255)
  g.lineWidth = 6
  g.stroke()
  bar(1107, 346, 6, 22, X(255))
  dot(1110, 368, 4, X(255))

  // three feature cards with icon tiles
  for (const x of [92, 566, 1040]) {
    strokeR(x, 668, 368, 250, 24, N(92), 3)
    strokeR(x + 32, 700, 46, 46, 13, A(205), 3)
    bar(x + 32, 792, 210, 16, N(195))
    bar(x + 32, 834, 300, 10, N(96))
    bar(x + 32, 858, 262, 10, N(96))
    bar(x + 32, 882, 282, 10, N(96))
  }
}

export function siteTexture(mobile: boolean): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = mobile ? 1024 : 1500
  cv.height = Math.round((cv.width * 975) / 1500)
  drawSite(cv)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.NoColorSpace
  tex.anisotropy = 8
  // the address is DM Mono: redraw once the web fonts are in
  document.fonts?.ready.then(() => {
    drawSite(cv)
    tex.needsUpdate = true
  })
  return tex
}

export interface SiteUniforms {
  [uniform: string]: THREE.IUniform
  uMap: { value: THREE.Texture }
  uNeutral: { value: THREE.Color }
  uAccent: { value: THREE.Color }
  uHot: { value: THREE.Color }
  uAlert: { value: THREE.Color }
  /** 0..1 how infected the page is */
  uInfect: { value: number }
  /** 0..1 band slip (glitch) amount */
  uSlip: { value: number }
  /** restore line position, 0 = top of the page, 1 = bottom (everything above is healthy) */
  uHeal: { value: number }
  uScan: { value: THREE.Color }
  uTime: { value: number }
}

/** The etched site: R/G/B masks tinted by uniform, added to what's behind. */
export function siteMaterial(map: THREE.Texture): THREE.ShaderMaterial & { uniforms: SiteUniforms } {
  const uniforms: SiteUniforms = {
    uMap: { value: map },
    uNeutral: { value: new THREE.Color() },
    uAccent: { value: new THREE.Color() },
    uHot: { value: new THREE.Color() },
    uAlert: { value: new THREE.Color() },
    uInfect: { value: 0 },
    uSlip: { value: 0 },
    uHeal: { value: 0 },
    uScan: { value: new THREE.Color() },
    uTime: { value: 0 },
  }
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uNeutral, uAccent, uHot, uAlert, uScan;
      uniform float uInfect, uSlip, uHeal, uTime;
      varying vec2 vUv;
      void main() {
        // page coordinate from the top (0) to the bottom (1)
        float fromTop = 1.0 - vUv.y;
        // infected below the restore line (soft edge)
        float sick = uInfect * smoothstep(uHeal - 0.03, uHeal + 0.03, fromTop);
        // some bands slip sideways, smoothly (never stepped: no strobing)
        float band = floor(vUv.y * 26.0);
        float pick = step(0.58, fract(band * 0.6180339 + 0.13));
        float wob = sin(band * 12.9898 + uTime * 1.3) * sin(band * 4.137 + uTime * 0.71);
        vec2 uv = vUv + vec2(wob * 0.022 * uSlip * sick * pick, 0.0);
        vec3 t = texture2D(uMap, uv).rgb;
        vec3 neutral = mix(uNeutral, uNeutral * vec3(1.15, 0.62, 0.62), sick);
        vec3 accent = mix(uAccent, uHot, sick);
        vec3 col = t.r * neutral + t.g * accent + t.b * uAlert * sick;
        // the restore line: a thin bright scan while it travels
        float scanOn = uInfect * step(0.001, uHeal) * (1.0 - step(0.999, uHeal));
        float d = (fromTop - uHeal) * 60.0;
        col += uScan * exp(-d * d) * scanOn * 0.9;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    blending: THREE.AdditiveBlending,
    transparent: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  }) as THREE.ShaderMaterial & { uniforms: SiteUniforms }
}
