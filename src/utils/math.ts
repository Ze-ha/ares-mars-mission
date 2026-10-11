/**
 * Small, allocation-free math helpers used by the mission timeline,
 * the camera director and the effects.
 */

export const DEG = Math.PI / 180

export const clamp = (x: number, a = 0, b = 1) => (x < a ? a : x > b ? b : x)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
/** 0..1 progress of x inside [a, b], clamped. */
export const progress = (x: number, a: number, b: number) => clamp((x - a) / (b - a))
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}
export const smootherstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a))
  return t * t * t * (t * (t * 6 - 15) + 10)
}
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
export const easeInCubic = (t: number) => t * t * t
export const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2

/** Triangular pulse that is 1 at `c` and 0 outside c ± w. */
export const pulse = (x: number, c: number, w: number) => clamp(1 - Math.abs(x - c) / w)
/** Trapezoid envelope: ramps 0→1 over [a, b], holds, ramps 1→0 over [c, d]. */
export const envelope = (x: number, a: number, b: number, c: number, d: number) =>
  Math.min(smoothstep(a, b, x), 1 - smoothstep(c, d, x))

/** Deterministic hash → [0, 1). Used for seeded particle attributes. */
export function hash1(n: number) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123
  return s - Math.floor(s)
}

/** Mulberry32 seeded PRNG — reproducible procedural content. */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Monotone cubic keyframe track (Fritsch–Carlson).
 * Smooth like a spline but never overshoots — essential for altitudes,
 * velocities and distances that must stay physically plausible.
 * `log` mode interpolates in log-space: ideal for distances that span
 * many orders of magnitude (6,500 km → 100,000,000 km).
 */
export class Track {
  private xs: number[]
  private ys: number[]
  private ms: number[]
  private log: boolean

  constructor(keys: [number, number][], mode: 'linear' | 'log' = 'linear') {
    this.log = mode === 'log'
    keys = [...keys].sort((a, b) => a[0] - b[0])
    this.xs = keys.map((k) => k[0])
    this.ys = keys.map((k) => (this.log ? Math.log(Math.max(k[1], 1e-9)) : k[1]))
    const n = keys.length
    const d: number[] = []
    for (let i = 0; i < n - 1; i++) d.push((this.ys[i + 1] - this.ys[i]) / (this.xs[i + 1] - this.xs[i]))
    const m: number[] = new Array(n).fill(0)
    if (n > 1) {
      m[0] = d[0]
      m[n - 1] = d[n - 2]
      for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2
      for (let i = 0; i < n - 1; i++) {
        if (d[i] === 0) {
          m[i] = 0
          m[i + 1] = 0
          continue
        }
        const a = m[i] / d[i]
        const b = m[i + 1] / d[i]
        const s = a * a + b * b
        if (s > 9) {
          const tau = 3 / Math.sqrt(s)
          m[i] = tau * a * d[i]
          m[i + 1] = tau * b * d[i]
        }
      }
      // flat tangents at the ends: every segment eases in and out of the hold
      m[0] = 0
      m[n - 1] = 0
    }
    this.ms = m
  }

  at(x: number): number {
    const { xs, ys, ms } = this
    const n = xs.length
    let y: number
    if (x <= xs[0]) y = ys[0]
    else if (x >= xs[n - 1]) y = ys[n - 1]
    else {
      let i = 0
      while (i < n - 2 && x > xs[i + 1]) i++
      const h = xs[i + 1] - xs[i]
      const t = (x - xs[i]) / h
      const t2 = t * t
      const t3 = t2 * t
      y =
        (2 * t3 - 3 * t2 + 1) * ys[i] +
        (t3 - 2 * t2 + t) * h * ms[i] +
        (-2 * t3 + 3 * t2) * ys[i + 1] +
        (t3 - t2) * h * ms[i + 1]
    }
    return this.log ? Math.exp(y) : y
  }
}

/** Frame-rate independent exponential damping. */
export const damp = (current: number, target: number, lambda: number, dt: number) =>
  lerp(current, target, 1 - Math.exp(-lambda * dt))

/** Smooth 1D value noise (for camera shake, flicker). */
export function noise1(x: number) {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  return lerp(hash1(i), hash1(i + 1), u) * 2 - 1
}
