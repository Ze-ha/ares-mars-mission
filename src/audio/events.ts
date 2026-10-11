import { RCS_EVENTS, SHUTDOWNS } from '../mission/trajectory'
import { rng } from '../utils/math'

/**
 * Discrete sound events, derived from the mission schedule (emission times in
 * experience seconds). Each carries an airborne and a structure-borne amplitude:
 * a listener hears whichever paths physically reach it.
 */

export type EventKind =
  | 'creak' | 'clunk' | 'heavy' | 'valve' | 'spinstart' | 'pop' | 'shutdown' | 'ignite' | 'sep' | 'rcs' | 'touchdown' | 'tick' | 'latch'

export interface SoundEvent {
  t: number
  kind: EventKind
  /** airborne amplitude (radiated into the air around the vehicle) */
  air: number
  /** structure-borne amplitude (felt by cameras bolted to the vehicle) */
  struct: number
  vehicle: 'stack' | 'ship' | 'booster'
  /** duration (s) for sustained events such as RCS valve pulses */
  dur: number
  /** per-event variation seed (0..1) */
  seed: number
  /** kind-specific pitch hint (Hz) */
  f: number
}

/** Hot staging: booster and ship become separate bodies. */
export const SEPARATION_T = 52.35
/** RCS valve pulse train, as drawn by RcsJets (on / off seconds). */
const RCS_PULSE = { ullage: [0.28, 0.06], slew: [0.1, 0.16], trim: [0.1, 0.16] } as const

export const SOUND_EVENTS: SoundEvent[] = (() => {
  const r = rng(4242)
  const ev: SoundEvent[] = []
  const add = (t: number, kind: EventKind, air: number, struct: number, vehicle: SoundEvent['vehicle'] = 'ship', dur = 0, f = 0) =>
    ev.push({ t, kind, air, struct, vehicle, dur, seed: r(), f })

  // ---- pad: cryogenic tanks groaning as they chill and pressurise, QD retract, vent valves
  for (const [t, f] of [[2.3, 190], [5.1, 240], [7.8, 160], [9.6, 280], [12.9, 210], [14.7, 175]]) add(t, 'creak', 0.35, 0.3, 'stack', 0.8, f)
  add(12.0, 'clunk', 0.35, 0.5, 'stack')
  add(15.5, 'latch', 0.25, 0.4, 'stack')
  add(14.2, 'valve', 0.3, 0.3, 'stack')
  add(15.1, 'valve', 0.22, 0.25, 'stack')
  // ---- ignition: spin-start gas, then 33 engines lighting centre-out (3 → 10 → 20)
  add(15.85, 'spinstart', 0.2, 0.4, 'stack', 0.6)
  const starts: number[] = []
  for (let i = 0; i < 3; i++) starts.push(16.4 + i * 0.035 + r() * 0.01)
  for (let i = 0; i < 10; i++) starts.push(16.52 + i * 0.02 + r() * 0.03)
  for (let i = 0; i < 20; i++) starts.push(16.7 + i * 0.016 + r() * 0.03)
  // each engine is 1/33 of the cluster: its light-up is a felt whump well under the building roar
  for (const t of starts) add(t, 'pop', 0.05, 0.1, 'stack', 0, 34 + r() * 16)
  add(20.0, 'heavy', 0.6, 1, 'stack') // hold-down clamps release
  // ---- staging
  add(51.6, 'shutdown', 0.4, 0.5, 'stack') // MECO
  add(52.0, 'ignite', 0.5, 1, 'stack') // ship lights on top of the booster (hot staging)
  add(SEPARATION_T, 'sep', 0.4, 0.9, 'ship')
  // ---- ship burns: ignition jolts and cut-offs, felt through the structure
  add(101.1, 'ignite', 0.3, 0.7)
  add(124.4, 'ignite', 0.15, 0.35)
  add(133.2, 'ignite', 0.12, 0.3)
  add(141.9, 'ignite', 0.1, 0.25)
  const shutAmp = [0.5, 0.5, 0.3, 0.25, 0.2]
  SHUTDOWNS.forEach((t, i) => add(t, 'shutdown', 0.3, shutAmp[i]))
  // ---- RCS: every valve pulse of every firing
  for (const e of RCS_EVENTS) {
    const [on, off] = RCS_PULSE[e.kind]
    const amp = e.kind === 'ullage' ? 0.32 : e.kind === 'trim' ? 0.14 : 0.24
    for (let p = e.t0; p <= e.t1; p += on + off) add(p, 'rcs', 0.2, amp, e.vehicle, Math.min(on, e.t1 - p + 0.02))
  }
  // ---- Mars: thermal-stress creaks through entry, landing burn, legs, touchdown, cut-off
  for (let t = 175.5; t < 191; t += 1.1 + r() * 1.6) add(t, 'creak', 0, 0.28, 'ship', 0.6 + r() * 0.5, 230 + r() * 180)
  add(203.3, 'ignite', 0.6, 0.9)
  add(211.5, 'clunk', 0.25, 0.45)
  add(213.8, 'latch', 0.35, 0.6)
  add(217.6, 'touchdown', 0.5, 1)
  add(217.7, 'shutdown', 0.5, 0.7)
  add(218.25, 'creak', 0.4, 0.45, 'ship', 1.0, 150)
  // ---- cooling: sparse metallic ticks, slowing down as the engine bay cools
  let t = 218.9
  while (t < 600) {
    add(t, 'tick', 0.5 + r() * 0.5, 0.5, 'ship', 0, 900 + r() * 2600)
    t += (0.3 + r() * 1.6) * (1 + (t - 218) / 22)
  }
  return ev.sort((a, b) => a.t - b.t)
})()

/** First index with t > x. */
function upper(x: number) {
  let lo = 0
  let hi = SOUND_EVENTS.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (SOUND_EVENTS[m].t <= x) lo = m + 1
    else hi = m
  }
  return lo
}

export interface Heard {
  /** observation time (mission s) at which the sound reaches the camera */
  tObs: number
  ev: SoundEvent
  /** source amplitude; the path gain (airAmp / structAmp) is applied on the voice bus, so cuts silence tails */
  gain: number
  bus: 'air' | 'struct'
}

/** What the scheduler needs from the listener at one instant (subset of AudioControls). */
export interface EarSample {
  key: number
  tr: number
  airAmp: number
  structAmp: number
}

/**
 * Deterministic event scheduler, advanced step by step by both the realtime
 * engine (per frame) and the offline renderer (120 Hz).
 *  - structure path: instantaneous, fires when t crosses the event time;
 *  - air path: fires when the listener's retarded time crosses it (arrival = t + d/c),
 *    interpolated inside the step for exact timing. Each emission is heard at most
 *    once; a cut to a nearer camera skips what "happened during the cut".
 */
export class EventScheduler {
  private t = 0
  private trLast = 0
  private trMax = 0
  private key = -1

  reset(t: number, c: EarSample) {
    this.t = t
    this.trLast = c.tr
    this.trMax = c.tr
    this.key = c.key
  }

  step(t: number, c: EarSample, out: Heard[]) {
    if (t <= this.t) {
      if (t < this.t - 1e-6) this.reset(t, c)
      return out
    }
    if (c.structAmp > 1e-4) {
      for (let i = upper(this.t); i < SOUND_EVENTS.length && SOUND_EVENTS[i].t <= t; i++) {
        const ev = SOUND_EVENTS[i]
        if (ev.struct <= 0 || (ev.vehicle === 'booster' && ev.t >= SEPARATION_T)) continue
        out.push({ tObs: ev.t, ev, gain: ev.struct, bus: 'struct' })
      }
    }
    if (c.key !== this.key) {
      this.trMax = Math.max(this.trMax, c.tr)
    } else if (c.tr > this.trMax) {
      const span = c.tr - this.trLast
      for (let i = upper(this.trMax); i < SOUND_EVENTS.length && SOUND_EVENTS[i].t <= c.tr; i++) {
        const ev = SOUND_EVENTS[i]
        if (ev.air <= 0 || c.airAmp < 1e-5) continue
        const k = span > 1e-9 ? (ev.t - this.trLast) / span : 1
        out.push({ tObs: this.t + Math.min(1, Math.max(0, k)) * (t - this.t), ev, gain: ev.air, bus: 'air' })
      }
      this.trMax = c.tr
    }
    this.t = t
    this.trLast = c.tr
    this.key = c.key
    return out
  }
}
