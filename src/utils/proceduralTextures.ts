import { CanvasTexture, ClampToEdgeWrapping, Data3DTexture, DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RedFormat, RGBAFormat, RepeatWrapping, SRGBColorSpace, UnsignedByteType, type Texture } from 'three'
import { rng } from './math'

/**
 * Procedurally painted textures (Canvas2D, generated once at startup).
 * No external image assets are needed for the vehicle — every seam, tile and
 * vent is parametric, so the hardware can be re-proportioned freely.
 */

function canvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  return { c, ctx }
}

function finish(c: HTMLCanvasElement, srgb: boolean, repeat = true): Texture {
  const t = new CanvasTexture(c)
  t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace
  t.wrapS = t.wrapT = repeat ? RepeatWrapping : ClampToEdgeWrapping
  t.minFilter = LinearMipmapLinearFilter
  t.anisotropy = 8
  t.needsUpdate = true
  return t
}

/** cheap value-noise for the 2D painters */
function makeNoise(seed: number) {
  const r = rng(seed)
  const N = 256
  const g = new Float32Array(N * N)
  for (let i = 0; i < g.length; i++) g[i] = r()
  const at = (x: number, y: number) => g[(((y % N) + N) % N) * N + (((x % N) + N) % N)]
  return (x: number, y: number) => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const fx = x - xi
    const fy = y - yi
    const ux = fx * fx * (3 - 2 * fx)
    const uy = fy * fy * (3 - 2 * fy)
    const a = at(xi, yi)
    const b = at(xi + 1, yi)
    const c = at(xi, yi + 1)
    const d = at(xi + 1, yi + 1)
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
  }
}

// ---------------------------------------------------------------------------
// Stainless steel: weld rings every barrel section, faint vertical grain,
// handling marks and slight heat/oxidation tint. One texture = RINGS barrels.
// ---------------------------------------------------------------------------
export const STEEL_RINGS_PER_TEXTURE = 8

export function makeSteelTextures() {
  const W = 512
  const H = 2048
  const rough = canvas(W, H)
  const bump = canvas(W, H)
  const color = canvas(W, H)
  const n = makeNoise(7)
  const r = rng(11)
  const ri = rough.ctx.createImageData(W, H)
  const bi = bump.ctx.createImageData(W, H)
  const ci = color.ctx.createImageData(W, H)
  const ringH = H / STEEL_RINGS_PER_TEXTURE
  // random vertical stringer seams per barrel
  const seams: number[][] = []
  for (let k = 0; k < STEEL_RINGS_PER_TEXTURE; k++) seams.push([r() * W, r() * W, r() * W])
  for (let y = 0; y < H; y++) {
    const ringY = y % ringH
    const barrel = Math.floor(y / ringH)
    const dWeld = Math.min(ringY, ringH - ringY)
    const weld = Math.exp(-(dWeld * dWeld) / 6)
    const weldHalo = Math.exp(-(dWeld * dWeld) / 180)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      const grain = n(x * 0.9, y * 0.02) * 0.6 + n(x * 3.1, y * 0.05) * 0.4
      const blotch = n(x * 0.02 + barrel * 13, y * 0.01)
      let seam = 0
      for (const s of seams[barrel]) {
        const dx = Math.abs(x - s)
        seam = Math.max(seam, Math.exp(-(dx * dx) / 3) * 0.6)
      }
      // roughness: polished sheet with brushed grain; welds are rougher
      const rv = 0.2 + grain * 0.1 + blotch * 0.12 + weld * 0.35 + seam * 0.2
      const rr = Math.min(255, rv * 255)
      ri.data[i] = ri.data[i + 1] = ri.data[i + 2] = rr
      ri.data[i + 3] = 255
      // bump: raised weld bead with slight sheet "pillowing" between welds
      const pillow = Math.sin((ringY / ringH) * Math.PI) * 0.35
      const bv = 0.5 + weld * 0.45 - weldHalo * 0.12 + pillow * 0.15 + seam * 0.2 + (n(x * 0.05, y * 0.05) - 0.5) * 0.1
      bi.data[i] = bi.data[i + 1] = bi.data[i + 2] = Math.max(0, Math.min(255, bv * 255))
      bi.data[i + 3] = 255
      // colour: neutral steel, welds darker/straw-tinted from heat
      const base = 0.78 + blotch * 0.12 + grain * 0.05 - weld * 0.28
      const straw = weldHalo * 0.08
      ci.data[i] = Math.min(255, (base + straw) * 255)
      ci.data[i + 1] = Math.min(255, (base + straw * 0.6) * 255)
      ci.data[i + 2] = Math.min(255, (base - straw * 0.3 + 0.02) * 255)
      ci.data[i + 3] = 255
    }
  }
  rough.ctx.putImageData(ri, 0, 0)
  bump.ctx.putImageData(bi, 0, 0)
  color.ctx.putImageData(ci, 0, 0)
  return { map: finish(color.c, true), roughnessMap: finish(rough.c, false), bumpMap: finish(bump.c, false) }
}

// ---------------------------------------------------------------------------
// Hexagonal heat-shield tiles (black, with individual tone variation and
// light grout gaps). One texture tile = TILE_COLS x TILE_ROWS hex tiles.
// ---------------------------------------------------------------------------
export const TILE_COLS = 24
export const TILE_ROWS = 28
/** real hex tile flat-to-flat width in metres */
export const TILE_SIZE = 0.34

export function makeTileTextures() {
  const W = 1024
  const H = Math.round((W * (TILE_ROWS * 0.75 * 2)) / (TILE_COLS * Math.sqrt(3)))
  const col = canvas(W, H)
  const rough = canvas(W, H)
  const bump = canvas(W, H)
  const glow = canvas(W, H)
  const r = rng(3)
  const cw = W / TILE_COLS // hex width (pointy-top)
  const s = cw / Math.sqrt(3) // hex radius
  const rowH = H / TILE_ROWS
  const bg = (ctx: CanvasRenderingContext2D, c: string) => {
    ctx.fillStyle = c
    ctx.fillRect(0, 0, W, H)
  }
  bg(col.ctx, '#4a4a4a')
  bg(rough.ctx, '#b0b0b0')
  bg(bump.ctx, '#303030')
  bg(glow.ctx, '#000')
  const hex = (ctx: CanvasRenderingContext2D, cx: number, cy: number, rad: number) => {
    ctx.beginPath()
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k + Math.PI / 6
      const x = cx + rad * Math.cos(a)
      const y = cy + rad * Math.sin(a) * (rowH / (s * 1.5))
      if (k === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
  }
  for (let row = -1; row <= TILE_ROWS; row++) {
    for (let c = -1; c <= TILE_COLS; c++) {
      const cx = c * cw + (row % 2 ? cw / 2 : 0)
      const cy = row * rowH + rowH / 2
      const v = r()
      const tone = 18 + Math.floor(v * 16) + (r() < 0.04 ? 22 : 0) // a few replacement tiles are lighter
      const inner = s * 0.9
      for (const [ctx, fill] of [
        [col.ctx, `rgb(${tone},${tone},${tone + 2})`],
        [rough.ctx, `rgb(${170 + v * 60},${170 + v * 60},${170 + v * 60})`],
        [bump.ctx, `rgb(${200 + v * 40},${200 + v * 40},${200 + v * 40})`],
        [glow.ctx, `rgb(${120 + v * 135},${120 + v * 135},${120 + v * 135})`],
      ] as [CanvasRenderingContext2D, string][]) {
        hex(ctx, cx, cy, inner)
        ctx.fillStyle = fill
        ctx.fill()
      }
    }
  }
  return {
    map: finish(col.c, true),
    roughnessMap: finish(rough.c, false),
    bumpMap: finish(bump.c, false),
    emissiveMap: finish(glow.c, true),
    aspect: W / H,
  }
}

// ---------------------------------------------------------------------------
// Hot-staging ring: steel band with rectangular vents (emissive mask glows
// orange when the ship lights its engines while still attached).
// ---------------------------------------------------------------------------
export function makeHotStageTextures() {
  const W = 2048
  const H = 128
  const col = canvas(W, H)
  const emi = canvas(W, H)
  col.ctx.fillStyle = '#b9bcc0'
  col.ctx.fillRect(0, 0, W, H)
  emi.ctx.fillStyle = '#000'
  emi.ctx.fillRect(0, 0, W, H)
  const N = 48
  for (let i = 0; i < N; i++) {
    const x = (i + 0.5) * (W / N)
    const w = (W / N) * 0.55
    col.ctx.fillStyle = '#0b0b0c'
    col.ctx.fillRect(x - w / 2, H * 0.18, w, H * 0.64)
    emi.ctx.fillStyle = '#ffffff'
    emi.ctx.fillRect(x - w / 2, H * 0.18, w, H * 0.64)
  }
  // top & bottom rails
  col.ctx.fillStyle = '#8d9094'
  col.ctx.fillRect(0, 0, W, H * 0.08)
  col.ctx.fillRect(0, H * 0.92, W, H * 0.08)
  return { map: finish(col.c, true), emissiveMap: finish(emi.c, true) }
}

// ---------------------------------------------------------------------------
// Soft billowing puff atlas (2×2) for smoke, steam and dust particles.
// ---------------------------------------------------------------------------
export function makePuffAtlas() {
  // Four billow sprites, each a cluster of overlapping sphere caps (cauliflower convection cells) with fine
  // turbulent detail — the structure real exhaust/deluge clouds show. Stored as a data texture (no canvas
  // premultiplication): RG = surface normal (sprite space), B = relative height/thickness, A = density.
  const S = 256
  const W = S * 2
  const data = new Uint8Array(W * W * 4)
  const hBuf = new Float32Array(S * S)
  for (let k = 0; k < 4; k++) {
    const n = makeNoise(100 + k * 17)
    const r = rng(500 + k * 13)
    const caps: [number, number, number][] = [[0, 0.05, 0.36 + 0.08 * r()]]
    const nc = 9 + Math.floor(r() * 5)
    for (let i = 0; i < nc; i++) {
      const a = r() * Math.PI * 2
      const rr = 0.2 + 0.4 * Math.sqrt(r())
      const rad = 0.16 + 0.24 * r() * (1 - rr * 0.6)
      // billows bulge more on the upper side (buoyant tops), flatter underside
      caps.push([Math.cos(a) * rr, Math.sin(a) * rr * 0.85 - 0.04, rad])
    }
    // a second, finer generation of cells budding off the big ones: billows on billows
    const big = caps.length
    for (let i = 0; i < 26; i++) {
      const [bx, by, br] = caps[Math.floor(r() * big)]
      const a = r() * Math.PI * 2
      const rad = 0.05 + 0.08 * r()
      const px = bx + Math.cos(a) * br * 0.9
      const py = by + Math.sin(a) * br * 0.9
      if (Math.hypot(px, py) + rad < 0.97) caps.push([px, py, rad])
    }
    const ox = (k % 2) * S
    const oy = Math.floor(k / 2) * S
    const fbm = (x: number, y: number) => {
      let f = 0
      let am = 0.5
      let fr = 6
      for (let o = 0; o < 4; o++) {
        f += am * n(x * fr * 8 + k * 31, y * fr * 8)
        am *= 0.5
        fr *= 2
      }
      return f
    }
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const u = (x / S) * 2 - 1
        const v = (y / S) * 2 - 1
        let h = 0
        for (const [cx, cy, cr] of caps) {
          const d2 = (u - cx) * (u - cx) + (v - cy) * (v - cy)
          if (d2 < cr * cr) h = Math.max(h, Math.sqrt(cr * cr - d2))
        }
        // small-scale turbulence rides on the billows
        h += (fbm(x / S, y / S) - 0.45) * 0.07 * Math.min(1, h * 6)
        // keep everything inside the quad
        const d = Math.sqrt(u * u + v * v)
        h *= 1 - Math.pow(Math.min(1, d / 0.98), 8)
        hBuf[y * S + x] = Math.max(0, h)
      }
    }
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const h = hBuf[y * S + x]
        const hx = hBuf[y * S + Math.min(S - 1, x + 1)] - hBuf[y * S + Math.max(0, x - 1)]
        const hy = hBuf[Math.min(S - 1, y + 1) * S + x] - hBuf[Math.max(0, y - 1) * S + x]
        const sc = S / 4
        let nx = -hx * sc
        let ny = -hy * sc
        const nl = Math.hypot(nx, ny, 1)
        nx /= nl
        ny /= nl
        // soft, turbulent-eroded margins (no hard cut-out silhouette)
        const e = h - 0.035 * n(x * 0.21 + k * 50, y * 0.21)
        const t0 = Math.min(1, Math.max(0, e / 0.11))
        const dens = t0 * t0 * (3 - 2 * t0)
        const i = ((oy + y) * W + ox + x) * 4
        data[i] = Math.round((nx * 0.5 + 0.5) * 255)
        data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255)
        data[i + 2] = Math.round(Math.min(1, h / 0.6) * 255)
        data[i + 3] = Math.round(dens * 255)
      }
    }
  }
  const t = new DataTexture(data, W, W, RGBAFormat)
  t.colorSpace = NoColorSpace
  t.wrapS = t.wrapT = ClampToEdgeWrapping
  t.minFilter = LinearMipmapLinearFilter
  t.magFilter = LinearFilter
  t.generateMipmaps = true
  t.needsUpdate = true
  return t
}

// ---------------------------------------------------------------------------
// Grid-fin / truss alpha lattice
// ---------------------------------------------------------------------------
export function makeLatticeTexture(cells = 8) {
  const S = 512
  const { c, ctx } = canvas(S, S)
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, S, S)
  ctx.strokeStyle = '#fff'
  ctx.lineWidth = S / cells / 5
  for (let i = -cells; i <= cells * 2; i++) {
    const o = (i * S) / cells
    ctx.beginPath()
    ctx.moveTo(o, 0)
    ctx.lineTo(o + S, S)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(o, S)
    ctx.lineTo(o + S, 0)
    ctx.stroke()
  }
  ctx.lineWidth = S / 14
  ctx.strokeRect(0, 0, S, S)
  return finish(c, false, false)
}

// ---------------------------------------------------------------------------
// Painted-steel GSE tank: butt-welded courses, staggered vertical seams,
// rain streaks from the top and grime/splash near the base. u wraps around
// the shell, v runs bottom → top. Returns colour + roughness maps.
// ---------------------------------------------------------------------------
export function makeTankTextures(courses = 11, seams = 6) {
  const W = 1024
  const H = 1024
  const col = canvas(W, H)
  const rough = canvas(W, H)
  const n = makeNoise(77)
  const r = rng(78)
  const ci = col.ctx.createImageData(W, H)
  const ri = rough.ctx.createImageData(W, H)
  // rain streaks: a handful of long vertical runs of darker grime from course seams
  const streak = new Float32Array(W)
  for (let k = 0; k < 90; k++) {
    const x = Math.floor(r() * W)
    const w = 1 + Math.floor(r() * 5)
    const a = 0.2 + r() * 0.8
    for (let dx = -w; dx <= w; dx++) streak[(x + dx + W) % W] = Math.max(streak[(x + dx + W) % W], a * (1 - Math.abs(dx) / (w + 1)))
  }
  for (let y = 0; y < H; y++) {
    const v = 1 - y / H // canvas top = tank top (flipY)
    const course = v * courses
    const cf = course - Math.floor(course)
    const weldY = Math.min(cf, 1 - cf) * (H / courses)
    for (let x = 0; x < W; x++) {
      const u = x / W
      const off = (Math.floor(course) % 2) * 0.5
      const sf = (u * seams + off) % 1
      const weldX = Math.min(sf, 1 - sf) * (W / seams)
      const weld = Math.max(weldY < 1.6 ? 1 - weldY / 1.6 : 0, weldX < 1.4 ? 1 - weldX / 1.4 : 0)
      const mottle = n(x * 0.02, y * 0.02) * 0.6 + n(x * 0.11, y * 0.11) * 0.4
      // streaks fade out down the shell, broken up by noise
      const st = streak[x] * (0.35 + 0.65 * n(x * 0.05, y * 0.004)) * (0.25 + 0.75 * v) * 0.09
      const base = Math.pow(1 - v, 5) * 0.22 * (0.6 + 0.8 * n(x * 0.03 + 9, y * 0.03)) // splash / dust at the foot
      let g = 0.86 - 0.05 * mottle - st - base - weld * 0.06
      g = Math.max(0, Math.min(1, g))
      const i = (y * W + x) * 4
      // slightly warm grime on a cool white paint
      ci.data[i] = 255 * g * (1 - base * 0.1)
      ci.data[i + 1] = 255 * g * (1 - base * 0.25)
      ci.data[i + 2] = 255 * g * (1.02 - st * 0.8 - base * 0.45)
      ci.data[i + 3] = 255
      const ro = 0.42 + 0.14 * mottle + st * 2.2 + base * 0.9 + weld * 0.18
      ri.data[i] = ri.data[i + 1] = ri.data[i + 2] = 255 * Math.min(1, ro)
      ri.data[i + 3] = 255
    }
  }
  col.ctx.putImageData(ci, 0, 0)
  rough.ctx.putImageData(ri, 0, 0)
  return { map: finish(col.c, true), roughnessMap: finish(rough.c, false) }
}

// ---------------------------------------------------------------------------
// Tileable 3D fbm noise (R8, 64³) for volumetric exhaust turbulence. One
// hardware-filtered fetch replaces several ALU simplex evaluations per step.
// ---------------------------------------------------------------------------
let noise3D: Data3DTexture | null = null
export function makeNoise3D() {
  if (noise3D) return noise3D
  const N = 64
  const data = new Uint8Array(N * N * N)
  const acc = new Float32Array(N * N * N)
  const r = rng(913)
  let amp = 1
  let norm = 0
  for (const cells of [4, 8, 16, 32]) {
    // periodic value lattice, smooth (quintic) trilinear interpolation
    const lat = new Float32Array(cells * cells * cells)
    for (let i = 0; i < lat.length; i++) lat[i] = r()
    const L = (x: number, y: number, z: number) => lat[((z % cells) * cells + (y % cells)) * cells + (x % cells)]
    const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
    const k = cells / N
    for (let z = 0; z < N; z++) {
      const fz = z * k
      const z0 = Math.floor(fz)
      const tz = fade(fz - z0)
      for (let y = 0; y < N; y++) {
        const fy = y * k
        const y0 = Math.floor(fy)
        const ty = fade(fy - y0)
        for (let x = 0; x < N; x++) {
          const fx = x * k
          const x0 = Math.floor(fx)
          const tx = fade(fx - x0)
          const c00 = L(x0, y0, z0) + (L(x0 + 1, y0, z0) - L(x0, y0, z0)) * tx
          const c10 = L(x0, y0 + 1, z0) + (L(x0 + 1, y0 + 1, z0) - L(x0, y0 + 1, z0)) * tx
          const c01 = L(x0, y0, z0 + 1) + (L(x0 + 1, y0, z0 + 1) - L(x0, y0, z0 + 1)) * tx
          const c11 = L(x0, y0 + 1, z0 + 1) + (L(x0 + 1, y0 + 1, z0 + 1) - L(x0, y0 + 1, z0 + 1)) * tx
          const c0 = c00 + (c10 - c00) * ty
          const c1 = c01 + (c11 - c01) * ty
          acc[(z * N + y) * N + x] += amp * (c0 + (c1 - c0) * tz)
        }
      }
    }
    norm += amp
    amp *= 0.5
  }
  // stretch the contrast (fbm piles up around 0.5)
  for (let i = 0; i < acc.length; i++) data[i] = Math.max(0, Math.min(255, ((acc[i] / norm - 0.5) * 2.1 + 0.5) * 255))
  const t = new Data3DTexture(data, N, N, N)
  t.format = RedFormat
  t.type = UnsignedByteType
  t.minFilter = t.magFilter = LinearFilter
  t.wrapS = t.wrapT = t.wrapR = RepeatWrapping
  t.unpackAlignment = 1
  t.needsUpdate = true
  noise3D = t
  return t
}
