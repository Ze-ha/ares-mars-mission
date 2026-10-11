import { rng } from '../utils/math'
import type { AudioControls } from './controls'
import type { Heard } from './events'

/**
 * Procedural Web Audio graph. Everything is built from deterministic noise
 * buffers, filters, oscillators, waveshapers and convolution; no samples.
 * Continuous layers are native nodes whose parameters follow AudioControls;
 * discrete events are short-lived voices. Works on AudioContext and
 * OfflineAudioContext alike, so the film soundtrack equals the live mix.
 */

// ---------------------------------------------------------------- buffers
interface Buffers {
  white: AudioBuffer
  pink: AudioBuffer
  brown: AudioBuffer
  crackle: AudioBuffer
  grit: AudioBuffer
  lfo: AudioBuffer
  irEarth: AudioBuffer
  irMars: AudioBuffer
}
const cache = new Map<number, Buffers>()

function norm(d: Float32Array, rms: number) {
  let s = 0
  for (let i = 0; i < d.length; i++) s += d[i] * d[i]
  const k = rms / Math.sqrt(s / d.length || 1)
  for (let i = 0; i < d.length; i++) d[i] *= k
}
/** Equal-power crossfade of the tail into the head so the buffer loops without a seam. */
function seamless(src: Float32Array, n: number, fade: number) {
  const out = new Float32Array(n)
  out.set(src.subarray(0, n))
  for (let i = 0; i < fade; i++) {
    const a = (i / fade) * Math.PI * 0.5
    out[i] = src[i] * Math.sin(a) + src[n + i] * Math.cos(a)
  }
  return out
}
function makeBuffer(sr: number, seconds: number, channels: number, gen: (r: () => number, n: number) => Float32Array, seed: number) {
  const n = Math.round(seconds * sr)
  const b = new AudioBuffer({ length: n, numberOfChannels: channels, sampleRate: sr })
  const fade = Math.round(sr * 0.25)
  for (let c = 0; c < channels; c++) b.copyToChannel(seamless(gen(rng(seed + c * 7919), n + fade), n, fade) as Float32Array<ArrayBuffer>, c)
  return b
}

function buffers(sr: number): Buffers {
  const hit = cache.get(sr)
  if (hit) return hit
  const white = (r: () => number, n: number) => {
    const d = new Float32Array(n)
    for (let i = 0; i < n; i++) d[i] = r() * 2 - 1
    norm(d, 0.3)
    return d
  }
  const pink = (r: () => number, n: number) => {
    // Paul Kellet's refined pink filter
    const d = new Float32Array(n)
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
    for (let i = 0; i < n; i++) {
      const w = r() * 2 - 1
      b0 = 0.99886 * b0 + w * 0.0555179
      b1 = 0.99332 * b1 + w * 0.0750759
      b2 = 0.969 * b2 + w * 0.153852
      b3 = 0.8665 * b3 + w * 0.3104856
      b4 = 0.55 * b4 + w * 0.5329522
      b5 = -0.7616 * b5 - w * 0.016898
      d[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362
      b6 = w * 0.115926
    }
    norm(d, 0.3)
    return d
  }
  const brown = (r: () => number, n: number) => {
    const d = new Float32Array(n)
    let y = 0
    const leak = Math.exp(-2 * Math.PI * 8 / sr) // ~8 Hz corner: no DC drift
    for (let i = 0; i < n; i++) {
      y = y * leak + (r() * 2 - 1) * 0.05
      d[i] = y
    }
    norm(d, 0.3)
    return d
  }
  // rocket "crackle": sparse, positively skewed shock impulses (steep rise, slow N-wave recovery)
  const crackle = (r: () => number, n: number) => {
    const d = new Float32Array(n)
    const rate = 55 / sr
    for (let i = 0; i < n; ) {
      i += Math.ceil(-Math.log(1 - r()) / rate)
      const a = 0.06 + 0.94 * Math.pow(r(), 5)
      const len = Math.round(sr * (0.0004 + r() * 0.0014))
      for (let k = 0; k < len * 1.6 && i + k < n; k++) {
        const x = k / len
        d[i + k] += a * (x < 1 ? 1 - 1.35 * x : -0.35 * (1 - (x - 1) / 0.6))
      }
    }
    norm(d, 0.1)
    return d
  }
  // granular regolith impacts: dense tiny clicks with random polarity and size
  const grit = (r: () => number, n: number) => {
    const d = new Float32Array(n)
    const rate = 700 / sr
    for (let i = 0; i < n; ) {
      i += Math.ceil(-Math.log(1 - r()) / rate)
      const a = Math.pow(r(), 3) * (r() < 0.5 ? -1 : 1)
      for (let k = 0; k < 6 && i + k < n; k++) d[i + k] += a * Math.exp(-k * 0.9) * (k % 2 ? -0.6 : 1)
    }
    norm(d, 0.1)
    return d
  }
  // slow turbulence / gust modulator (smooth value noise, a few octaves between 0.5 and 9 Hz)
  const lfo = (r: () => number, n: number) => {
    const d = new Float32Array(n)
    for (const [hz, amp] of [[0.6, 1], [2.2, 0.7], [5.5, 0.45], [9, 0.25]]) {
      const step = sr / hz
      let a = r() * 2 - 1
      let b = r() * 2 - 1
      let next = step
      for (let i = 0; i < n; i++) {
        if (i >= next) {
          a = b
          b = r() * 2 - 1
          next += step
        }
        const f = 1 - (next - i) / step
        d[i] += amp * (a + (b - a) * f * f * (3 - 2 * f))
      }
    }
    let m = 0
    for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(d[i]))
    for (let i = 0; i < n; i++) d[i] /= m
    return d
  }
  const b: Buffers = {
    white: makeBuffer(sr, 7, 2, white, 11),
    pink: makeBuffer(sr, 9, 2, pink, 23),
    brown: makeBuffer(sr, 8, 2, brown, 37),
    crackle: makeBuffer(sr, 10, 2, crackle, 41),
    grit: makeBuffer(sr, 6, 2, grit, 53),
    lfo: makeBuffer(sr, 31, 1, lfo, 67),
    irEarth: impulse(sr, 3.6, 2.6, [0.019, 0.034, 0.052, 0.071, 0.097, 0.13, 0.17, 0.23, 0.31], 6500, 0.9, 101),
    irMars: impulse(sr, 1.3, 0.9, [0.028, 0.061, 0.11], 1600, 0.3, 131),
  }
  cache.set(sr, b)
  return b
}

/**
 * Stereo reverb impulse: discrete early reflections (pad deck, tower, tanks /
 * nearby rocks) then a diffuse tail that darkens as it decays (air absorption).
 */
function impulse(sr: number, len: number, rt60: number, taps: number[], f0: number, fTau: number, seed: number) {
  const n = Math.round(len * sr)
  const b = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr })
  for (let c = 0; c < 2; c++) {
    const r = rng(seed + c)
    const d = new Float32Array(n)
    taps.forEach((tp, k) => {
      const i = Math.round(tp * (c ? 1.07 : 1) * sr)
      const g = 0.55 * Math.pow(0.8, k) * (r() < 0.3 ? -1 : 1)
      for (let j = 0; j < 4 && i + j < n; j++) d[i + j] += g * (1 - j * 0.25)
    })
    let y = 0
    const onset = Math.round(0.035 * sr)
    for (let i = onset; i < n; i++) {
      const t = i / sr
      const fc = f0 * Math.exp(-t / fTau) + 180
      const a = Math.exp((-2 * Math.PI * fc) / sr)
      y = a * y + (1 - a) * (r() * 2 - 1)
      const env = Math.exp((-6.91 * t) / rt60) * Math.min(1, (i - onset) / (0.05 * sr))
      d[i] += y * env * 1.6
    }
    let s = 0
    for (let i = 0; i < n; i++) s += d[i] * d[i]
    const k = 1 / Math.sqrt(s)
    for (let i = 0; i < n; i++) d[i] *= k
    b.copyToChannel(d as Float32Array<ArrayBuffer>, c)
  }
  return b
}

// ---------------------------------------------------------------- graph
/** Level of each layer at control value 1 (linear). */
const UNIT = {
  rumble: 1.0, roar: 1.1, crackle: 1.0, deluge: 1.5, vent: 0.8, struct: 1.6, res: 12, rattle: 3, ring: 20, systems: 0.15,
  aero: 2, aeroHarsh: 0.8, aeroLow: 1.2, wind: 0.1, pump: 0.02, dust: 0.25, grit: 0.3, servo: 0.1, room: 0.001,
}
const VOICE = { air: 1.5, struct: 0.8 }
export const MASTER = 0.55

type Binding = { key: keyof AudioControls; param: AudioParam; f: (v: number) => number }

export class MissionSynth {
  readonly ctx: BaseAudioContext
  readonly master: GainNode
  private b: Buffers
  private airPre: GainNode
  private structIn: GainNode
  /** event voices enter through the listener's path gain, so a cut also cuts their tails */
  private airVoices: GainNode
  private structVoices: GainNode
  private bindings: Binding[] = []
  private sources: AudioScheduledSourceNode[] = []

  constructor(ctx: BaseAudioContext, destination: AudioNode = ctx.destination) {
    this.ctx = ctx
    const b = (this.b = buffers(ctx.sampleRate))
    // peak limiter only: the mix itself keeps its dynamics (quiet pad → ignition is a ~25 dB jump)
    const limiter = new DynamicsCompressorNode(ctx, { threshold: -4, knee: 4, ratio: 12, attack: 0.002, release: 0.25 })
    this.master = new GainNode(ctx, { gain: MASTER })
    this.master.connect(limiter).connect(destination)
    const M = this.master

    // ---- helpers
    const loop = (buf: AudioBuffer, offset: number, rate = 1) => {
      const s = new AudioBufferSourceNode(ctx, { buffer: buf, loop: true, playbackRate: rate })
      s.start(0, offset % buf.duration)
      this.sources.push(s)
      return s
    }
    const osc = (frequency: number) => {
      const o = new OscillatorNode(ctx, { frequency })
      o.start(0)
      this.sources.push(o)
      return o
    }
    const filt = (type: BiquadFilterType, frequency: number, Q = 0.707, gain = 0) => new BiquadFilterNode(ctx, { type, frequency, Q, gain })
    const gain = (g = 0) => new GainNode(ctx, { gain: g })
    const bind = (key: keyof AudioControls, param: AudioParam, f: (v: number) => number = (v) => v) => this.bindings.push({ key, param, f })
    const layer = (key: keyof typeof UNIT & keyof AudioControls) => {
      const g = gain()
      bind(key, g.gain, (v) => v * UNIT[key])
      return g
    }
    const shaper = (drive: number) => {
      const curve = new Float32Array(1024)
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1
        curve[i] = Math.tanh(drive * x) / Math.tanh(drive)
      }
      return new WaveShaperNode(ctx, { curve, oversample: '2x' })
    }
    /** modulator: lfo · depth added onto an AM gain's intrinsic 1 */
    const am = (rate: number, offset: number, key?: keyof AudioControls, depth = 0.3) => {
      const node = gain(1)
      const d = gain(depth)
      loop(b.lfo, offset, rate).connect(d).connect(node.gain)
      if (key) bind(key, d.gain)
      return node
    }

    // ---- airborne bus: vehicle noise → air absorption → thin-air shelf → out + reverb
    this.airPre = gain(1)
    const airLP1 = filt('lowpass', 4000, 0.5)
    const airLP2 = filt('lowpass', 4000, 0.6)
    const shelf = filt('lowshelf', 140, 0.707, 0)
    const airPost = gain(1)
    this.airPre.connect(airLP1).connect(airLP2).connect(shelf).connect(airPost)
    bind('airLP', airLP1.frequency)
    bind('airLP', airLP2.frequency)
    bind('airShelf', shelf.gain)
    airPost.connect(M)
    const convE = new ConvolverNode(ctx, { buffer: b.irEarth, disableNormalization: true })
    const convM = new ConvolverNode(ctx, { buffer: b.irMars, disableNormalization: true })
    airPost.connect(layerSend('revE')).connect(convE).connect(M)
    airPost.connect(layerSend('revM')).connect(convM).connect(M)
    function layerSend(key: 'revE' | 'revM') {
      const g = new GainNode(ctx, { gain: 0 })
      bind(key, g.gain)
      return g
    }

    // engine rumble: deep, broad LF (the 33-engine cluster behaves like one huge jet)
    const rLP = filt('lowpass', 100, 0.8)
    bind('rumbleLP', rLP.frequency)
    loop(b.brown, 0.3).connect(rLP).connect(filt('peaking', 32, 1.2, 4)).connect(layer('rumble')).connect(this.airPre)
    // turbulent exhaust roar, lightly saturated for density
    const roLP = filt('lowpass', 1400, 0.5)
    bind('roarLP', roLP.frequency)
    loop(b.pink, 1.7).connect(filt('highpass', 45)).connect(roLP).connect(shaper(1.6)).connect(layer('roar')).connect(this.airPre)
    // crackle: shock impulses keep their edge (nonlinear steepening), so they bypass most absorption
    const cLP = filt('lowpass', 8000, 0.5)
    bind('crackleLP', cLP.frequency)
    loop(b.crackle, 0.9).connect(filt('highpass', 450)).connect(cLP).connect(layer('crackle')).connect(airPost)
    // pad deluge water
    loop(b.white, 2.9).connect(filt('bandpass', 1400, 0.5)).connect(layer('deluge')).connect(this.airPre)
    // cryogenic venting hiss, puffing with the lfo
    loop(b.white, 4.4).connect(filt('highpass', 2200)).connect(am(0.5, 3, undefined, 0.35)).connect(layer('vent')).connect(this.airPre)

    // ---- structure-borne bus
    this.structIn = gain(1)
    const sLP = filt('lowpass', 250, 0.6)
    bind('structLP', sLP.frequency)
    const buffetS = am(1, 11, 'buffet')
    this.structIn.connect(sLP).connect(M)
    this.airVoices = gain(0)
    this.airVoices.connect(this.airPre)
    bind('airAmp', this.airVoices.gain)
    this.structVoices = gain(0)
    this.structVoices.connect(this.structIn)
    bind('structAmp', this.structVoices.gain)
    loop(b.brown, 4.1).connect(filt('lowpass', 300, 0.7)).connect(filt('peaking', 38, 2, 6)).connect(filt('peaking', 76, 3, 3)).connect(layer('struct')).connect(buffetS).connect(this.structIn)
    // hull resonance: a few low structural modes rung by broadband load
    const resG = layer('res')
    for (const [k, ratio] of [[0, 1], [1, 1.62], [2, 2.55]]) {
      const bp = filt('bandpass', 30 * ratio, 14)
      bind('resF', bp.frequency, (v) => v * ratio)
      loop(b.pink, 2.3 + k * 1.9).connect(bp).connect(resG)
    }
    resG.connect(buffetS)
    // rattle of fittings and brackets
    loop(b.crackle, 5.3).connect(filt('bandpass', 1900, 1.5)).connect(layer('rattle')).connect(this.structIn)
    // metallic response to thermal / aerodynamic stress (bypasses the muffling LP)
    const ringG = layer('ring')
    for (const [k, f] of [[0, 530], [1, 870], [2, 1370]]) loop(b.pink, 6.1 + k).connect(filt('bandpass', f, 40)).connect(ringG)
    ringG.connect(am(0.7, 17, undefined, 0.8)).connect(M)
    // life support: ventilation, pumps, 400 Hz power hum
    const sys = layer('systems')
    loop(b.pink, 3.3).connect(filt('bandpass', 520, 0.8)).connect(sys)
    for (const [f, a] of [[400, 0.012], [800, 0.004], [120, 0.01]]) osc(f).connect(gain(a)).connect(sys)
    sys.connect(M)
    // actuators (flaps, legs) heard through the airframe
    loop(b.pink, 7.7).connect(filt('bandpass', 760, 5)).connect(filt('lowpass', 1500)).connect(layer('servo')).connect(M)

    // ---- local to the microphone
    const buffetA = am(1.15, 5, 'buffet')
    buffetA.connect(M)
    const aF = filt('bandpass', 800, 0.6)
    bind('aeroF', aF.frequency)
    bind('aeroQ', aF.Q)
    loop(b.pink, 5.5).connect(aF).connect(layer('aero')).connect(buffetA)
    const hF = filt('bandpass', 1200, 2.2)
    bind('aeroF', hF.frequency, (v) => v * 1.6)
    loop(b.pink, 8.1).connect(hF).connect(gain(5)).connect(shaper(3)).connect(filt('highpass', 400)).connect(layer('aeroHarsh')).connect(buffetA)
    loop(b.brown, 6.6).connect(filt('lowpass', 70, 0.9)).connect(layer('aeroLow')).connect(buffetA)
    const wLP = filt('lowpass', 500, 0.6)
    bind('windLP', wLP.frequency)
    loop(b.pink, 0.4).connect(wLP).connect(am(0.12, 1, undefined, 0.6)).connect(layer('wind')).connect(M)
    // ground-support pumps: 29.5 Hz shaft hum with harmonics, chugging at ~1.1 Hz
    const pump = layer('pump')
    const chug = gain(0.7)
    osc(1.1).connect(gain(0.3)).connect(chug.gain)
    for (const [f, a] of [[29.5, 1], [59, 0.6], [88.5, 0.35], [147.5, 0.12]]) osc(f).connect(gain(a)).connect(chug)
    loop(b.brown, 1.2).connect(filt('lowpass', 260)).connect(gain(3)).connect(chug)
    chug.connect(pump).connect(M)
    // regolith: dust hiss and grit
    loop(b.white, 5.1).connect(filt('bandpass', 3200, 0.7)).connect(am(0.8, 23, undefined, 0.4)).connect(layer('dust')).connect(M)
    loop(b.grit, 2.2).connect(filt('highpass', 1200)).connect(layer('grit')).connect(M)
    // room tone: the recorder's own noise floor, far below audibility (≈ −74 dBFS)
    loop(b.pink, 4.8).connect(filt('lowpass', 900)).connect(layer('room')).connect(M)
  }

  /** Realtime: glide every parameter to its new value. */
  applySmooth(c: AudioControls, when: number, tau = 0.03) {
    for (const bd of this.bindings) bd.param.setTargetAtTime(this.safe(bd, bd.f(c[bd.key] as number)), when, tau)
  }

  /** keep filter frequencies below Nyquist (the offline test renders at 24 kHz) */
  private safe(bd: Binding, v: number) {
    return bd.param.maxValue > 1000 && bd.param.maxValue < 1e5 ? Math.min(v, bd.param.maxValue * 0.95) : v
  }

  /** Offline: write dense control curves (one sample per step) starting at `t0` (context time). */
  applyCurves(curves: Map<keyof AudioControls, Float32Array>, t0: number, duration: number) {
    for (const bd of this.bindings) {
      const src = curves.get(bd.key)!
      const v = new Float32Array(src.length)
      for (let i = 0; i < src.length; i++) v[i] = this.safe(bd, bd.f(src[i]))
      bd.param.value = v[0]
      bd.param.setValueCurveAtTime(v, t0, duration)
    }
  }

  /** Keys the graph reads (the offline renderer records only these). */
  get keys() {
    return [...new Set(this.bindings.map((b) => b.key))]
  }

  // ---------------------------------------------------------------- event voices
  voice(h: Heard, when: number) {
    const ctx = this.ctx
    when = Math.max(when, 'currentTime' in ctx ? ctx.currentTime : 0)
    const dest = h.bus === 'air' ? this.airVoices : this.structVoices
    const out = new GainNode(ctx, { gain: h.gain * VOICE[h.bus] })
    out.connect(dest)
    const ev = h.ev
    const seed = ev.seed
    const white = this.b.white
    let end = when
    const noise = (type: BiquadFilterType, f: number, Q: number, peak: number, a: number, tau: number, at = when, hold = 0, fEnd = 0, sweep = 0) => {
      const s = new AudioBufferSourceNode(ctx, { buffer: white })
      const bq = new BiquadFilterNode(ctx, { type, frequency: f, Q })
      if (fEnd) {
        bq.frequency.setValueAtTime(f, at)
        bq.frequency.exponentialRampToValueAtTime(fEnd, at + sweep)
      }
      const g = new GainNode(ctx, { gain: 0 })
      g.gain.setValueAtTime(0, at)
      g.gain.linearRampToValueAtTime(peak, at + a)
      if (hold) g.gain.setValueAtTime(peak, at + a + hold)
      g.gain.setTargetAtTime(0, at + a + hold, tau)
      const stop = at + a + hold + tau * 7
      s.connect(bq).connect(g).connect(out)
      s.start(at, (seed * 5.3 + at * 0.37) % (white.duration - 1))
      s.stop(stop)
      end = Math.max(end, stop)
    }
    const tone = (f0: number, f1: number, glide: number, peak: number, a: number, tau: number, at = when, type: OscillatorType = 'sine') => {
      const o = new OscillatorNode(ctx, { type, frequency: f0 })
      o.frequency.setValueAtTime(f0, at)
      o.frequency.exponentialRampToValueAtTime(f1, at + glide)
      const g = new GainNode(ctx, { gain: 0 })
      g.gain.setValueAtTime(0, at)
      g.gain.linearRampToValueAtTime(peak, at + a)
      g.gain.setTargetAtTime(0, at + a, tau)
      const stop = at + a + tau * 7
      o.connect(g).connect(out)
      o.start(at)
      o.stop(stop)
      end = Math.max(end, stop)
    }
    const clunk = (k: number, at = when) => {
      tone(58 + seed * 10, 44, 0.25, 1 * k, 0.003, 0.09, at)
      noise('bandpass', 320, 1.2, 0.9 * k, 0.002, 0.03, at)
      noise('bandpass', 440 + seed * 90, 35, 5 * k, 0.002, 0.22, at)
      noise('bandpass', 1170 + seed * 200, 40, 3 * k, 0.002, 0.15, at)
    }
    const creak = (f: number, dur: number, k: number, at = when) => noise('bandpass', f, 28, 7 * k, dur * 0.3, 0.12, at, dur * 0.5, f * 1.3, dur)

    switch (ev.kind) {
      case 'pop': // one engine lighting: a soft low whump, not a bang
        tone(ev.f * 1.8, ev.f, 0.2, 0.9, 0.004, 0.07)
        noise('lowpass', 500, 0.7, 0.8, 0.003, 0.05)
        noise('bandpass', 1800, 1, 0.12, 0.002, 0.02)
        break
      case 'spinstart': // turbopump spin-start gas: rising hiss and a faint whine
        noise('bandpass', 900, 0.8, 0.9, 0.5, 0.25)
        tone(180, 720, 0.6, 0.06, 0.4, 0.2, when, 'sawtooth')
        break
      case 'clunk':
        clunk(0.8)
        break
      case 'latch':
        clunk(0.6)
        clunk(0.35, when + 0.07)
        break
      case 'heavy': // hold-down release / separation: two heavy clunks and a ringing structure
      case 'sep':
        clunk(1)
        clunk(0.6, when + 0.055)
        tone(33, 30, 0.3, 0.8, 0.005, 0.2)
        break
      case 'valve':
        noise('bandpass', 1500, 0.6, 1, 0.001, 0.012)
        noise('bandpass', 2300 + seed * 400, 30, 4, 0.001, 0.12)
        break
      case 'shutdown': // valve closure, then the vibration dies out
        noise('bandpass', 900, 3, 0.5, 0.001, 0.015)
        tone(44, 36, 0.3, 0.4, 0.004, 0.12)
        noise('lowpass', 180, 0.8, 0.5, 0.01, 0.22)
        break
      case 'ignite': // the thrust structure taking load
        noise('lowpass', 220, 0.8, 1, 0.03, 0.2)
        tone(38, 48, 0.3, 0.6, 0.02, 0.15)
        break
      case 'rcs': // valve pulse: tock, muffled buzz for the pulse length, closing tick
        noise('bandpass', 190, 2, 3, 0.002, 0.018)
        tone(95, 70, 0.05, 0.5, 0.002, 0.02)
        noise('lowpass', 320, 0.7, 1, 0.015, 0.02, when, Math.max(0, ev.dur - 0.035))
        noise('bandpass', 1500, 4, 0.8, 0.001, 0.006, when + ev.dur)
        break
      case 'creak':
        creak(ev.f || 200, ev.dur || 0.8, 1)
        break
      case 'touchdown': // gear compression, structural load, a short low thump, then settling
        noise('lowpass', 160, 0.8, 1, 0.06, 0.12)
        tone(46, 34, 0.25, 1, 0.006, 0.1)
        noise('bandpass', 300, 1.5, 0.4, 0.01, 0.05)
        noise('bandpass', 610, 40, 2.5, 0.01, 0.35)
        creak(210, 0.9, 0.5, when + 0.35)
        break
      case 'tick': // thermal contraction: a tiny metallic ping with a dull body
        noise('bandpass', ev.f, 14, 5, 0.0005, 0.004)
        noise('bandpass', ev.f / 5, 6, 1.5, 0.0005, 0.01)
        break
    }
    const ref = out
    const stopper = new ConstantSourceNode(ctx, { offset: 0 })
    stopper.connect(ref)
    stopper.onended = () => ref.disconnect()
    stopper.start(when)
    stopper.stop(end + 0.05)
  }

  dispose() {
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {
        /* already stopped */
      }
    }
    this.master.disconnect()
  }
}
