import { Vector3 } from 'three'
import type { Ear } from '../camera/shots'
import { audioControls, makeControls, type AudioControls, type ListenerSpec } from './controls'
import { EventScheduler, SOUND_EVENTS, type Heard } from './events'
import { makeSource, sourceAt } from './physics'
import { MissionSynth } from './synth'

/**
 * Offline soundtrack: the same graph as the live mix, rendered in an
 * OfflineAudioContext, driven by audioControls sampled densely (120 Hz curves)
 * and the same event scheduler. Used by the film exporter and the ?audiotest hook.
 */

export interface OfflineAudioOptions {
  sampleRate?: number
  spec?: ListenerSpec
  /** control sampling rate (Hz) */
  rate?: number
  /** seconds rendered before `start` so reverb tails and running events are in place */
  preroll?: number
  onProgress?: (fraction: number) => void
}

const CINEMATIC: ListenerSpec = { kind: 'cinematic' }

export async function renderMissionAudio(start: number, end: number, opt: OfflineAudioOptions = {}): Promise<AudioBuffer> {
  const sr = opt.sampleRate ?? 48000
  const rate = opt.rate ?? 120
  const spec = opt.spec ?? CINEMATIC
  const pre = Math.max(0, Math.min(opt.preroll ?? 1.5, start))
  const t0 = start - pre
  const dur = end - t0
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(dur * sr), sampleRate: sr })
  const synth = new MissionSynth(ctx)
  const keys = synth.keys
  const steps = Math.ceil(dur * rate) + 1
  const curves = new Map(keys.map((k) => [k, new Float32Array(steps)] as [keyof AudioControls, Float32Array]))
  const c = makeControls()
  const sched = new EventScheduler()
  const heard: Heard[] = []
  for (let i = 0; i < steps; i++) {
    const t = t0 + i / rate
    audioControls(t, spec, undefined, c)
    for (const [k, arr] of curves) arr[i] = c[k] as number
    if (i === 0) sched.reset(t, c)
    else sched.step(t, c, heard)
    if (i % 480 === 0) {
      opt.onProgress?.((0.5 * i) / steps)
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  synth.applyCurves(curves, 0, (steps - 1) / rate)
  for (const h of heard) synth.voice(h, h.tObs - t0)
  const buf = await ctx.startRendering()
  opt.onProgress?.(1)
  const off = Math.round(pre * sr)
  const n = Math.max(1, Math.round((end - start) * sr))
  const out = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr })
  for (let ch = 0; ch < 2; ch++) out.copyToChannel(buf.getChannelData(ch).subarray(off, off + n), ch)
  return out
}

/** 16-bit PCM WAV. */
export function encodeWav(b: AudioBuffer) {
  const n = b.length
  const ch = b.numberOfChannels
  const view = new DataView(new ArrayBuffer(44 + n * ch * 2))
  const str = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  view.setUint32(4, 36 + n * ch * 2, true)
  str(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, ch, true)
  view.setUint32(24, b.sampleRate, true)
  view.setUint32(28, b.sampleRate * ch * 2, true)
  view.setUint16(32, ch * 2, true)
  view.setUint16(34, 16, true)
  str(36, 'data')
  view.setUint32(40, n * ch * 2, true)
  const data = Array.from({ length: ch }, (_, i) => b.getChannelData(i))
  let o = 44
  for (let i = 0; i < n; i++)
    for (let c = 0; c < ch; c++) {
      view.setInt16(o, Math.max(-1, Math.min(1, data[c][i])) * 32767, true)
      o += 2
    }
  return view.buffer
}

// ---------------------------------------------------------------- ?audiotest hook
interface TestOpts {
  sampleRate?: number
  /** fixed microphone override */
  ear?: Ear
  pos?: [number, number, number]
  comoving?: boolean
}
if (typeof window !== 'undefined' && new URLSearchParams(location.search).has('audiotest')) {
  const specOf = (o: TestOpts): ListenerSpec =>
    o.ear && o.pos ? { kind: 'fixed', ear: o.ear, pos: new Vector3(...o.pos), comoving: o.comoving } : CINEMATIC
  Object.assign(window, {
    /** renders [start, end] and returns a base64 WAV */
    __renderAudio: async (start: number, end: number, o: TestOpts = {}) => {
      const b = await renderMissionAudio(start, end, { sampleRate: o.sampleRate ?? 48000, spec: specOf(o) })
      const bytes = new Uint8Array(encodeWav(b))
      let s = ''
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return btoa(s)
    },
    __audioControls: (t: number, o: TestOpts = {}) => ({ ...audioControls(t, specOf(o)) }),
    __audioSource: (t: number) => ({ ...sourceAt(t, makeSource()) }),
    __audioEvents: () => SOUND_EVENTS.map((e) => ({ t: e.t, kind: e.kind, air: e.air, struct: e.struct })),
  })
}
