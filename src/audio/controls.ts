import { Vector3 } from 'three'
import { SHOTS, shotIndexAt, type Ear, type Pose } from '../camera/shots'
import { EARTH_RADIUS_KM, MARS_RADIUS_KM, MOUNT_HEIGHT } from '../mission/constants'
import type { WorldId } from '../mission/phases'
import { createMissionState, sampleMission, type MissionState } from '../mission/trajectory'
import { clamp, envelope, lerp, progress, smoothstep } from '../utils/math'
import { SEPARATION_T, type EarSample } from './events'
import { absorptionHz, aeroLevel, makeMedium, makeSource, mediumAt, sourceAt, type Medium } from './physics'

/**
 * audioControls(t, listener) — the whole sound design as a pure function of
 * mission time and microphone, exactly like the visuals are a pure function of t.
 *
 * Governing rule: "what could this camera physically hear from here?"
 *  - ground:   Earth/Mars air; distance attenuation, propagation delay d/c (handled
 *              as retarded time, so delay changes never bend pitch), air absorption,
 *              pad / terrain reflections, ambient wind.
 *  - mounted:  bolted to the hull. In air: its own aerodynamic noise + airborne engine
 *              noise (until the vehicle outruns its own sound) + structure-borne
 *              vibration. In vacuum: only the muffled structure path.
 *  - onboard:  sealed interior; structure path + life support (fans, pumps, hum).
 *  - external: free-flying, co-moving camera. Vacuum → silence. Air → like ground,
 *              plus the flow over the camera itself.
 */

export type ListenerSpec =
  | { kind: 'cinematic' }
  /** free-orbit camera: position in current world units */
  | { kind: 'free'; pos: Vector3 }
  /** test / override: a fixed microphone (world units) */
  | { kind: 'fixed'; ear: Ear; pos: Vector3; comoving?: boolean }

export interface AudioControls extends EarSample {
  // airborne vehicle sound (through the medium)
  rumble: number
  roar: number
  crackle: number
  deluge: number
  vent: number
  rumbleLP: number
  roarLP: number
  airLP: number
  crackleLP: number
  airShelf: number
  revE: number
  revM: number
  // structure-borne
  struct: number
  structLP: number
  res: number
  resF: number
  rattle: number
  ring: number
  systems: number
  // local to the microphone
  aero: number
  aeroHarsh: number
  aeroLow: number
  aeroF: number
  aeroQ: number
  buffet: number
  wind: number
  windLP: number
  pump: number
  dust: number
  grit: number
  servo: number
  room: number
}

export const GAIN_KEYS = [
  'rumble', 'roar', 'crackle', 'deluge', 'vent', 'revE', 'revM', 'struct', 'res', 'rattle', 'ring', 'systems',
  'aero', 'aeroHarsh', 'aeroLow', 'buffet', 'wind', 'pump', 'dust', 'grit', 'servo', 'room', 'airAmp', 'structAmp',
] as const
export const HZ_KEYS = ['rumbleLP', 'roarLP', 'airLP', 'crackleLP', 'structLP', 'resF', 'aeroF', 'windLP'] as const
const HZ_DEFAULT: Record<(typeof HZ_KEYS)[number], number> = {
  rumbleLP: 100, roarLP: 1400, airLP: 4000, crackleLP: 8000, structLP: 250, resF: 30, aeroF: 800, windLP: 500,
}

export function makeControls(): AudioControls {
  const o = { key: -1, tr: 0, airShelf: 0, aeroQ: 0.6 } as AudioControls
  for (const k of GAIN_KEYS) o[k] = 0
  for (const k of HZ_KEYS) o[k] = HZ_DEFAULT[k]
  return o
}
function zero(o: AudioControls) {
  for (const k of GAIN_KEYS) o[k] = 0
  for (const k of HZ_KEYS) o[k] = HZ_DEFAULT[k]
  o.airShelf = 0
  o.aeroQ = 0.6
}

// ---------------------------------------------------------------- listener
interface Listener {
  key: number
  ear: Ear
  world: WorldId
  pos: Vector3
  comoving: boolean
  dist: number
  distPad: number
  medium: Medium
  tr: number
}
const mkListener = (): Listener => ({ key: 0, ear: 'external', world: 'earth', pos: new Vector3(), comoving: false, dist: 0, distPad: 0, medium: makeMedium(), tr: 0 })
const PAD = new Vector3(0, MOUNT_HEIGHT, 0)
const _src = makeSource()
const _v = new Vector3()

/** Source position (m, or km in the space world) at time tr, in the listener's world. */
function srcPos(world: WorldId, tr: number, out: Vector3) {
  const s = sourceAt(tr, _src)
  if (world === 'earth') return out.set(s.ex, s.ey, s.ez)
  if (world === 'mars') return out.set(s.mx, s.my, s.mz)
  return out.set(s.sx, s.sy, s.sz)
}
const unitM = (w: WorldId) => (w === 'space' ? 1000 : 1)
const distAt = (L: Listener, tr: number) => L.pos.distanceTo(srcPos(L.world, tr, _v)) * unitM(L.world)
const minTr = (w: WorldId) => (w === 'mars' ? 193 : w === 'space' ? 44 : 0)

function resolve(L: Listener, t: number, s: MissionState) {
  // medium around the microphone
  if (L.world === 'earth') mediumAt('earth', L.pos.y / 1000, L.medium)
  else if (L.world === 'mars') mediumAt('mars', L.pos.y / 1000, L.medium)
  else {
    // space world: whichever planet's air is densest where the camera is
    const hE = L.pos.distanceTo(s.earthCenter) - EARTH_RADIUS_KM
    const hM = L.pos.distanceTo(s.marsCenter) - MARS_RADIUS_KM
    const e = mediumAt('earth', hE, L.medium).gain
    if (mediumAt('mars', hM, L.medium).gain < e) mediumAt('earth', hE, L.medium)
  }
  L.distPad = L.world === 'earth' ? L.pos.distanceTo(PAD) : 1e9
  L.dist = distAt(L, t)
  // retarded time: solve tr + d(tr)/c = t (Newton; the source may recede supersonically)
  let tr = t - L.dist / L.medium.c
  if (L.medium.gain > 0) {
    for (let i = 0; i < 4; i++) {
      const d = distAt(L, tr)
      const g = tr + d / L.medium.c - t
      const dg = 1 + (distAt(L, tr + 0.02) - distAt(L, tr - 0.02)) / (0.04 * L.medium.c)
      tr -= g / Math.max(0.2, dg)
    }
    L.dist = distAt(L, tr)
  } else tr = t
  L.tr = Math.max(Math.min(tr, t), minTr(L.world))
}

const _pose: Pose = { pos: new Vector3(), target: new Vector3(), fov: 40 }
function shotListener(i: number, t: number, s: MissionState, L: Listener, clampU: boolean) {
  const sh = SHOTS[i]
  const u = clampU ? progress(t, sh.start, sh.end) : (t - sh.start) / (sh.end - sh.start)
  sh.eval(s, u, _pose)
  L.key = i
  L.ear = sh.ear ?? 'external'
  L.world = sh.world
  L.pos.copy(_pose.pos)
  L.comoving = L.ear !== 'ground' && s.t >= 20
  resolve(L, t, s)
}

// ---------------------------------------------------------------- per-listener mix
const _r = makeSource()
const _d = makeSource()
function forListener(t: number, s: MissionState, L: Listener, o: AudioControls) {
  zero(o)
  o.key = L.key
  o.tr = L.tr
  const m = L.medium
  const mars = m.planet === 'mars'
  const r = sourceAt(L.tr, _r)
  const mounted = L.ear === 'mounted'
  const onboard = L.ear === 'onboard'
  const onVehicle = mounted || onboard
  const air = m.gain > 0 && !onboard

  // ---- engines as heard through the air (retarded time)
  const boosterOn = L.world === 'earth' || L.tr < SEPARATION_T
  const Pb = boosterOn ? r.bThr + (r.bBack * 13) / 33 : 0
  const Ps = (3 * r.sSL + 3 * r.sVac) / 33
  const P = Pb + Ps
  const cluster = P > 1e-4 ? Pb / P : 0
  const hSrc = L.world === 'mars' ? r.landerAlt : L.world === 'earth' ? r.ey + 8 - MOUNT_HEIGHT : 1e9
  // plume hitting the ground: reflections, impingement roar and surface interaction
  const groundK = 1 + 1.2 * Math.exp(-Math.max(0, hSrc) / 35)
  const distG = Math.pow(25 / Math.max(L.dist, 25), 0.55)
  // a camera moving with a supersonic vehicle outruns the engine noise
  const M = L.comoving ? s.velocity / m.c : 0
  const machSup = 1 - 0.92 * smoothstep(0.85, 1.2, M)
  // Mars: thin CO2 carries ~19 dB less; the mix gives a few dB back so the landing still lands
  const amp = air ? m.gain * distG * machSup * (mars ? 3 : 1) : 0
  o.airAmp = amp
  const qSrc = 0.5 * (mars ? 0.02 * Math.exp(-r.alt / 11.1) : 1.225 * Math.exp(-r.alt / 8.5)) * r.vel * r.vel
  const aeroSrc = L.world === 'earth' ? 0 : aeroLevel(qSrc, m.planet)
  // radiated power ∝ jet power, so amplitude ∝ √P: the startup ramps up like the thrust does
  const eng = Math.sqrt(P) * groundK
  if (air) {
    o.rumble = amp * (0.55 * eng + 0.3 * aeroSrc)
    o.roar = amp * 0.42 * eng * (mars ? 0.75 : 1)
    const far = L.ear === 'mounted' ? 0.3 : 1
    o.crackle = amp * eng * 0.55 * smoothstep(0.55, 0.95, P) * smoothstep(40, 450, L.dist) * (mars ? 0.5 : 1) * far
    if (L.world === 'earth') {
      const padG = m.gain * Math.pow(25 / Math.max(L.distPad, 25), 0.62)
      o.deluge = padG * 0.07 * envelope(L.tr, 15.7, 16.4, 22, 31)
      o.vent = amp * 0.1 * r.venting
      o.revE = L.ear === 'mounted' ? 0 : 0.08 + 0.4 * Math.exp(-Math.max(0, hSrc) / 400) + 0.22 * smoothstep(300, 3000, L.dist)
      if (L.ear === 'external') o.revE *= 0.2
    } else if (L.world === 'mars' && L.ear !== 'mounted') {
      o.revM = 0.08 + 0.3 * Math.exp(-Math.max(0, hSrc) / 80)
    }
  }
  o.rumbleLP = lerp(135, 70, cluster)
  o.roarLP = lerp(1900, 950, cluster)
  o.airLP = absorptionHz(m, L.dist)
  o.crackleLP = Math.min(14000, o.airLP * 2.6)
  o.airShelf = mars ? -4 : 0

  // ---- flow over the microphone itself (co-moving or hull-mounted, in air)
  let aN = 0
  let transonic = 0
  const v = s.velocity
  const qCam = 0.5 * m.rho * v * v
  if ((L.comoving || onVehicle) && qCam > 2) {
    aN = aeroLevel(qCam, m.planet) * smoothstep(2, 25, qCam)
    const w = mounted ? 0.34 : onboard ? 0.1 : 0.22
    const Mv = v / m.c
    transonic = Math.exp(-(((Mv - 1.02) / 0.22) ** 2))
    o.aero = aN * w * (mars ? 0.55 : 1)
    o.aeroHarsh = aN * w * (mars ? 0.8 : 0.1)
    o.aeroF = onboard ? 180 : mars ? clamp(700 + 0.4 * v, 700, 3600) : clamp(220 + 0.8 * v, 220, 2200)
    o.aeroQ = mars ? 1.3 : 0.55
    o.aeroLow = aN * (mounted ? 0.42 : onboard ? 0.25 : 0.14) * (mars ? 0.45 : 1)
    o.buffet = clamp(0.22 + 0.5 * transonic + 0.45 * s.plasma + 0.6 * s.shake, 0, 0.85)
  }

  // ---- structure-borne (instantaneous: the camera rides the vehicle)
  if (onVehicle) {
    const attached = L.world === 'earth' || t < SEPARATION_T
    const V = (attached ? s.boosterThrottle + (s.boosterBoostback * 13) / 33 : 0) + (2.2 * (3 * s.shipThrottleSL + 3 * s.shipThrottleVac)) / 33
    const vA = Math.pow(V, 0.38)
    const inAir = m.gain > 0.05
    o.structAmp = mounted ? 1 : 0.75
    o.struct = (mounted ? 0.3 : 0.24) * (vA + 0.5 * aN)
    o.structLP = inAir ? (mounted ? 420 : 220) : mounted ? 230 : 170
    o.res = (mounted ? 0.5 : 0.35) * (0.22 * vA + aN * (0.35 + 0.65 * transonic) + 0.5 * s.plasma * Math.min(1, aN * 3))
    o.resF = attached ? 23 : 34
    o.rattle = (mounted ? 0.07 : 0.03) * (vA + aN)
    o.ring = (mounted ? 0.06 : 0.04) * (s.tileGlow + 0.5 * aN)
    o.systems = mounted ? 0.15 : 1
    // flap and leg actuators, heard through the airframe
    o.servo = (mounted ? 0.5 : 0.3) * (envelope(t, 170, 173, 203, 205.5) * 0.35 + envelope(t, 211.5, 211.8, 213.4, 213.8))
    if (L.world === 'mars') o.grit = 0.05 * sourceAt(t - 0.3, _d).dust * Math.exp(-r.landerAlt / 60)
  }

  // ---- the microphone's surroundings
  if (L.ear === 'ground') {
    if (L.world === 'earth') {
      o.wind = 0.7
      o.windLP = 650
      // ground-support equipment: pumps and chillers at the pad, fading as loading ends
      o.pump = (0.15 + Math.exp(-L.distPad / 250)) * (1 - smoothstep(13.5, 16.5, t))
    } else {
      o.wind = 0.3
      o.windLP = 230
    }
  }
  // regolith: debris and dust blown out by the plume reach the camera ~0.8 s later
  if (L.world === 'mars' && !onVehicle) {
    const dd = sourceAt(t - 0.8, _d)
    const near = Math.exp(-L.dist / 260)
    const P2 = (3 * dd.sSL) / 33
    o.dust = near * dd.dust * (0.25 + 2.5 * P2)
    o.grit = near * dd.dust * 3 * P2
  }
  o.room = 1
}

// ---------------------------------------------------------------- public
const XF_SOFT = 0.25
const XF_CUT = 0.1
const Ls = { cur: mkListener(), prev: mkListener() }
const Cs = { prev: makeControls() }
const _state = createMissionState()

/**
 * Pure sound-design state for mission time t heard by `spec`. `state` may be
 * passed when the caller already holds sampleMission(t) (the realtime engine).
 */
export function audioControls(t: number, spec: ListenerSpec, state?: MissionState, out = makeControls()): AudioControls {
  const s = state && Math.abs(state.t - t) < 1e-9 ? state : sampleMission(t, _state)
  if (spec.kind === 'cinematic') {
    const i = shotIndexAt(t)
    shotListener(i, t, s, Ls.cur, true)
    forListener(t, s, Ls.cur, out)
    const sh = SHOTS[i]
    const xf = sh.cut || (i > 0 && SHOTS[i - 1].world !== sh.world) ? XF_CUT : XF_SOFT
    const w = (t - sh.start) / xf
    if (i > 0 && w < 1) {
      shotListener(i - 1, t, s, Ls.prev, false)
      forListener(t, s, Ls.prev, Cs.prev)
      mixControls(Cs.prev, out, smoothstep(0, 1, w), out)
    }
    return out
  }
  const L = Ls.cur
  L.key = spec.kind === 'free' ? 1000 : 1001
  L.ear = spec.kind === 'free' ? 'external' : spec.ear
  L.world = s.world
  L.pos.copy(spec.pos)
  L.comoving = spec.kind === 'free' ? s.t >= 20 : !!spec.comoving
  resolve(L, t, s)
  forListener(t, s, L, out)
  return out
}

/** out = a·(1−w) + b·w — gains linear, frequencies geometric. Listener identity follows b. */
export function mixControls(a: AudioControls, b: AudioControls, w: number, out: AudioControls) {
  for (const k of GAIN_KEYS) out[k] = a[k] + (b[k] - a[k]) * w
  for (const k of HZ_KEYS) out[k] = a[k] * Math.pow(b[k] / a[k], w)
  out.airShelf = a.airShelf + (b.airShelf - a.airShelf) * w
  out.aeroQ = a.aeroQ + (b.aeroQ - a.aeroQ) * w
  out.key = b.key
  out.tr = b.tr
  return out
}
