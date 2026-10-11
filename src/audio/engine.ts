import type { MissionState } from '../mission/trajectory'
import { audioControls, makeControls, type AudioControls, type ListenerSpec } from './controls'
import { EventScheduler, type Heard } from './events'
import { MASTER, MissionSynth } from './synth'

/**
 * Realtime player. The AudioContext is created on the first user gesture; each
 * frame the pure controls are evaluated for the current mission time and camera
 * and every parameter glides to them, while events are scheduled on the audio
 * clock. Speed changes stay pitch-neutral (nothing is sample playback); fast
 * speeds are ducked, pause fades out and suspends the context.
 */

export interface FrameInfo {
  /** adjust the computed controls before they are applied (explore mode) */
  override?: (c: AudioControls) => void
  active: boolean
  speed: number
  volume: number
  seekNonce: number
}

/** Fixed output latency so events keep their exact relative timing. */
const LATENCY = 0.04

class RealtimeAudio {
  ctx: AudioContext | null = null
  private synth: MissionSynth | null = null
  private sched = new EventScheduler()
  private c = makeControls()
  private heard: Heard[] = []
  private nonce = -1
  private wasActive = false
  private idleSince = 0

  /** Must be called from a user gesture (autoplay policy). */
  unlock() {
    if (typeof AudioContext === 'undefined') return
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext({ latencyHint: 'playback', sampleRate: 48000 })
      } catch {
        this.ctx = new AudioContext({ latencyHint: 'playback' })
      }
      this.synth = new MissionSynth(this.ctx)
      this.synth.master.gain.value = 0
      if (new URLSearchParams(location.search).has('audiotest')) {
        // test probe: live output level in dBFS
        const an = new AnalyserNode(this.ctx, { fftSize: 8192 })
        this.synth.master.connect(an)
        const buf = new Float32Array(an.fftSize)
        Object.assign(window, {
          __audioLevel: () => {
            an.getFloatTimeDomainData(buf)
            let s = 0
            for (const x of buf) s += x * x
            return { state: this.ctx?.state, db: 10 * Math.log10(s / buf.length + 1e-12) }
          },
        })
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  frame(t: number, state: MissionState, spec: ListenerSpec, f: FrameInfo) {
    const ctx = this.ctx
    const synth = this.synth
    if (!ctx || !synth) return
    const now = ctx.currentTime
    if (!f.active) {
      if (this.wasActive) {
        synth.master.gain.setTargetAtTime(0, now, 0.06)
        this.idleSince = performance.now()
      }
      this.wasActive = false
      if (ctx.state === 'running' && performance.now() - this.idleSince > 600) void ctx.suspend()
      return
    }
    if (ctx.state === 'suspended') void ctx.resume()
    const c = audioControls(t, spec, state, this.c)
    f.override?.(c)
    const duck = f.speed > 1.01 ? Math.pow(10, (-4 * Math.log2(f.speed)) / 20) : 1
    if (!this.wasActive || f.seekNonce !== this.nonce) {
      // resume / jump: restart the event clock here and glide in without a click
      this.sched.reset(t, c)
      this.nonce = f.seekNonce
      synth.master.gain.cancelScheduledValues(now)
      synth.master.gain.setValueAtTime(0, now)
      synth.applySmooth(c, now, 0.005)
    }
    this.wasActive = true
    synth.master.gain.setTargetAtTime(MASTER * f.volume * duck, now + 0.02, 0.05)
    synth.applySmooth(c, now + LATENCY, 0.025)
    this.heard.length = 0
    this.sched.step(t, c, this.heard)
    for (const h of this.heard) synth.voice(h, now + LATENCY + (h.tObs - t) / Math.max(0.25, f.speed))
  }
}

export const audioEngine = new RealtimeAudio()
export const unlockAudio = () => audioEngine.unlock()
