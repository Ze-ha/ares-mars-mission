import { Matrix4, Quaternion, Vector3 } from 'three'
import { DEG, Track, clamp, envelope, progress, pulse, smootherstep, smoothstep } from '../utils/math'
import { EARTH_RADIUS_KM, LANDING_SITE, LAUNCH_SITE, MARS_RADIUS_KM, MOUNT_HEIGHT, SUN_LAUNCH, SUN_MARS_SURFACE, VEHICLE } from './constants'
import { LANDING_DATE, LAUNCH_DATE, SKY_QUAT_EARTH, SKY_QUAT_MARS, moonOffsetKm } from './ephemeris'
import { WORLD_SWITCH, phaseEnd, phaseIndexAt, PHASES, worldAt, type WorldId } from './phases'

/**
 * The mission is a pure function of experience time `t`:  sampleMission(t) → MissionState.
 *
 * Nothing is integrated frame-by-frame, so scrubbing, pausing, speeding up and
 * jumping between phases are always exact and deterministic. Motion comes from
 * monotone-cubic keyframe tracks (no overshoot) plus a few analytic curves
 * (liftoff acceleration, booster separation kinematics).
 */

export interface MissionState {
  t: number
  phase: number
  phaseProgress: number
  world: WorldId
  // ---------- telemetry ----------
  met: number
  timewarp: number
  altitudeKm: number
  altitudeRef: 'EARTH' | 'MARS'
  velocity: number
  distEarthKm: number
  distMarsKm: number
  stage: string
  boosterEnginesLit: number
  shipSLLit: boolean
  shipVacLit: boolean
  // ---------- vehicle controls ----------
  boosterThrottle: number
  boosterBoostback: number
  shipThrottleSL: number
  shipThrottleVac: number
  plumeExpansion: number
  frost: number
  venting: number
  qdArm: number
  hotStage: number
  boosterRCS: number
  tileGlow: number
  plasma: number
  flapFwd: number
  flapAft: number
  legs: number
  dust: number
  shake: number
  tcm: number
  heatVac: number
  heatSL: number
  heatBooster: number
  ignitionFlash: number
  fade: number
  fadeColor: 'black' | 'ember'
  // ---------- Earth launch world (metres) ----------
  stackBase: Vector3
  stackQuat: Quaternion
  // ---------- space world (km, ship-centred floating origin) ----------
  shipQuat: Quaternion
  /** direction the air moves past the ship (space world, entry) */
  flowDir: Vector3
  booster: { attached: boolean; pos: Vector3; quat: Quaternion }
  earthCenter: Vector3
  earthQuat: Quaternion
  marsCenter: Vector3
  marsQuat: Quaternion
  sunDir: Vector3
  skyQuat: Quaternion
  moonCenter: Vector3
  // ---------- Mars landing world (metres) ----------
  landerBase: Vector3
  landerQuat: Quaternion
}

// ---------------------------------------------------------------- tracks
// touchdown happens at the real landing time used for the Jezero sun (entry interface 7 min earlier)
const LANDING_MET = (LANDING_DATE.getTime() - LAUNCH_DATE.getTime()) / 1000
const EI_MET = LANDING_MET - 420
const tMET = new Track([
  [0, -20], [20, 0], [28, 8], [36, 45], [44, 95], [52, 158], [58, 168], [66, 240], [72, 520],
  [100, 2700], [108, 3400], [116, 4200], [146, EI_MET - 3 * 86400], [172, EI_MET], [193, EI_MET + 240], [217.6, LANDING_MET], [240, LANDING_MET + 22],
])
const tAltEarth = new Track([
  [20, 0], [24, 0.025], [28, 0.102], [32, 0.4], [36, 1.5], [40, 6], [44, 20], [48, 42], [52, 65], [58, 95], [66, 140], [72, 190],
  [100, 200], [103, 215], [108, 420], [114, 2400], [116, 9000],
])
const tEarthDist = new Track([[116, 9000], [120, 2.6e4], [124, 9e4], [130, 6e5], [136, 4e6], [146, 3e7], [172, 1.2e8], [240, 1.21e8]], 'log')
const tMarsAlt = new Track([
  [0, 1.02e8], [116, 1.0e8], [136, 3e7], [146, 8e6], [150, 1.5e6], [154, 3e5], [157, 7e4], [160, 3.2e4], [166, 1.7e4], [169.5, 3500], [172, 125], [178, 80], [184, 48], [190, 24], [193, 7],
], 'log')
const tVel = new Track([
  [20, 0], [24, 20], [28, 55], [32, 150], [36, 380], [40, 650], [44, 900], [52, 1600], [58, 2600], [66, 5200], [72, 7800], [100, 7790],
  [102, 7800], [114, 11300], [116, 11100], [124, 4200], [146, 3050], [158, 3400], [166, 4300], [172, 7500], [180, 5200], [186, 1800],
  [193, 420], [203, 190], [207, 120], [214, 30], [217.5, 0],
])
const tPitch = new Track([[29, 0], [34, 3], [38, 10], [44, 28], [52, 55], [58, 70], [66, 86], [72, 90]])
const tRoll = new Track([[58, 0], [70, 90]])
const tDownrange = new Track([[30, 0], [34, 40], [38, 450], [41, 2500], [44, 8000]])
const tTheta = new Track([[20, 0], [44, 0.5], [52, 1.5], [66, 8], [72, 14], [100, 118], [108, 160], [116, 178]])
const tThetaMars = new Track([[166, 0], [172, 10], [182, 21], [193, 26]])
const tEntryBeta = new Track([[167, 0], [172, 62], [188, 70], [193, 72]])

const tBoosterThrottle = new Track([[16.4, 0], [17.2, 0.35], [18.6, 0.92], [20, 1], [46, 1], [48, 0.75], [51.2, 0.7], [51.6, 0]])
const tBoostback = new Track([[63.5, 0], [64.4, 0.8], [69.5, 0.8], [70.5, 0]])
const tShipSL = new Track([
  [141.9, 0], [142.2, 0.18], [142.8, 0.18], [143.0, 0],
  [52.0, 0], [52.6, 1], [72, 1], [72.4, 0], [101, 0], [102, 1], [113.6, 1], [114.2, 0],
  [203.3, 0], [203.9, 1], [207.5, 1], [209, 0.72], [215, 0.55], [217.4, 0.45], [217.7, 0],
])
const tShipVac = new Track([[52.1, 0], [53.2, 1], [71.7, 1], [72.2, 0], [101.2, 0], [102, 1], [113.8, 1], [114.2, 0],
  [124.4, 0], [124.9, 0.32], [126.4, 0.32], [126.8, 0], [133.2, 0], [133.6, 0.22], [134.6, 0.22], [134.9, 0]])
const tTileGlow = new Track([[172, 0], [175, 0.6], [179, 1], [187, 0.6], [193, 0.1], [196, 0]])
const tPlasma = new Track([[172, 0], [174, 0.45], [178, 1], [186, 0.75], [191, 0.15], [193, 0]])
const tLegs = new Track([[211.5, 0], [213.8, 1]])
const tDust = new Track([[212.5, 0], [214, 0.55], [217.5, 1], [219.5, 0.35], [224, 0]])

// Mars landing world (metres): altitude of the ship base above the pad, downrange offset, flip angle
const tLanderAlt = new Track([[193, 6500], [198, 3600], [203, 1250], [205, 800], [207, 520], [210, 240], [213, 90], [215.5, 22], [217.6, 0]])
const tLanderX = new Track([[193, -3200], [198, -1500], [203, -420], [207, -120], [212, -15], [217.6, 0]])
const tFlip = new Track([[203.3, 0], [206.2, 97], [207.4, 89.5], [208.5, 90]])

// ---------------------------------------------------------------- frames
const X = new Vector3(1, 0, 0)
const Y = new Vector3(0, 1, 0)
const Z = new Vector3(0, 0, 1)
const _q = new Quaternion()
const _q2 = new Quaternion()
const _v = new Vector3()
const _m = new Matrix4()

/** Rotation that puts (lat, lon) of an equirectangular-textured THREE.SphereGeometry at +Y, local east at +X. */
function siteOrientation(lat: number, lon: number) {
  const la = lat * DEG
  const ph = (lon + 180) * DEG
  const up = new Vector3(-Math.cos(ph) * Math.cos(la), Math.sin(la), Math.sin(ph) * Math.cos(la))
  const east = new Vector3(Math.sin(ph), 0, Math.cos(ph)).normalize()
  const south = new Vector3().crossVectors(east, up)
  _m.set(east.x, east.y, east.z, 0, up.x, up.y, up.z, 0, south.x, south.y, south.z, 0, 0, 0, 0, 1)
  return new Quaternion().setFromRotationMatrix(_m)
}
const EARTH_Q0 = siteOrientation(LAUNCH_SITE.lat, LAUNCH_SITE.lon)
const MARS_Q0 = siteOrientation(LANDING_SITE.lat, LANDING_SITE.lon)
/** Horizontal cruise attitude: nose +X, heat-shield belly facing -Y. */
const Q_ORBIT = new Quaternion().setFromAxisAngle(X, -90 * DEG).multiply(new Quaternion().setFromAxisAngle(Z, -90 * DEG))
/** Star-catalogue orientation in the launch and landing frames (real sidereal geometry). */
const Q_EARTH_SKY = SKY_QUAT_EARTH.clone()
const Q_MARS_SKY = SKY_QUAT_MARS.clone()
const _moon = new Vector3()
const THETA_MARS_END = 26
const MARS_DIR_FAR = new Vector3(1, 0.08, -0.22).normalize()
// Earth centre sits at -dir * distance: behind, below and to the side, sunlit ~70% (gibbous) as we leave
const EARTH_DIR_BEHIND = new Vector3(-0.35, 0.5, 0.8).normalize()
const FLOW_ENTRY = new Vector3(-1, 0.12, 0).normalize()
/** TCM slews: [start, burnStart, burnEnd, end, axis, angle°] */
const TCMS: [number, number, number, number, Vector3, number][] = [
  [120.5, 124.2, 126.8, 130, new Vector3(0.2, 1, 0.3).normalize(), 58],
  [130.2, 133.0, 135.0, 138, new Vector3(0.6, 0.2, 1).normalize(), -34],
  [139.2, 141.7, 143.1, 145.5, new Vector3(0, 0.3, 1).normalize(), 22],
]

const rotZ = (deg: number, out: Quaternion) => out.setFromAxisAngle(Z, deg * DEG)

/**
 * Bang–coast–bang attitude profile (what reaction-control systems actually do):
 * thrusters fire to spin up (fraction `fa` of the manoeuvre), the vehicle coasts at
 * constant rate with no gas at all, then opposing thrusters fire to stop it.
 * Returns the fraction of the total angle reached at normalised time u.
 */
export function bangCoast(u: number, fa: number) {
  u = Math.min(1, Math.max(0, u))
  const w = 1 / (1 - fa)
  if (u < fa) return 0.5 * (w / fa) * u * u
  if (u < 1 - fa) return 0.5 * w * fa + w * (u - fa)
  return 1 - 0.5 * (w / fa) * (1 - u) * (1 - u)
}

const SLEW_FA = 0.2
const FLIP = { t0: 52.35 + 3.0, t1: 52.35 + 11.0, fa: 0.28 }

/** Every reaction-control firing, derived from the same manoeuvres that move the vehicle. */
export interface RcsEvent {
  t0: number
  t1: number
  vehicle: 'ship' | 'booster'
  kind: 'slew' | 'ullage' | 'trim'
  /** rotation axis (world) and sense (+1 spin-up, −1 braking) for slew firings */
  axis?: Vector3
  sense?: number
}
export const RCS_EVENTS: RcsEvent[] = (() => {
  const ev: RcsEvent[] = []
  for (const [a, b, c, d, axis, ang] of TCMS) {
    const out1 = b - 0.6
    const T1 = out1 - a
    const T2 = d - (c + 0.4)
    const sgn = Math.sign(ang)
    ev.push({ t0: a, t1: a + SLEW_FA * T1, vehicle: 'ship', kind: 'slew', axis, sense: sgn })
    ev.push({ t0: out1 - SLEW_FA * T1, t1: out1, vehicle: 'ship', kind: 'slew', axis, sense: -sgn })
    ev.push({ t0: b - 0.55, t1: b + 0.1, vehicle: 'ship', kind: 'ullage' })
    ev.push({ t0: b + 0.9, t1: b + 0.98, vehicle: 'ship', kind: 'trim', axis, sense: 1 })
    ev.push({ t0: c + 0.4, t1: c + 0.4 + SLEW_FA * T2, vehicle: 'ship', kind: 'slew', axis, sense: -sgn })
    ev.push({ t0: d - SLEW_FA * T2, t1: d, vehicle: 'ship', kind: 'slew', axis, sense: sgn })
  }
  ev.push({ t0: 99.4, t1: 101.1, vehicle: 'ship', kind: 'ullage' })
  const fT = FLIP.t1 - FLIP.t0
  ev.push({ t0: FLIP.t0, t1: FLIP.t0 + FLIP.fa * fT, vehicle: 'booster', kind: 'slew', axis: Z.clone(), sense: 1 })
  ev.push({ t0: FLIP.t1 - FLIP.fa * fT, t1: FLIP.t1, vehicle: 'booster', kind: 'slew', axis: Z.clone(), sense: -1 })
  return ev
})()

/** Engine burns (experience time) used for ignition transients and nozzle heating. */
const BURNS = {
  shipVac: [[52.1, 72.0], [101.2, 114.2], [124.4, 126.8], [133.2, 134.9]],
  shipSL: [[52.0, 72.4], [101, 114.2], [141.9, 143.0], [203.3, 217.7]],
  booster: [[16.4, 51.6], [63.5, 70.5]],
} as const
export const SHUTDOWNS = [72.2, 114.2, 126.8, 134.9, 143.0]
/** Radiatively cooled nozzle temperature proxy: heats while firing, cools slowly afterwards. */
function nozzleHeat(t: number, burns: readonly (readonly number[])[], tr: number, td: number) {
  let h = 0
  for (const [a, b] of burns) {
    if (t < a) continue
    const hEnd = 1 - Math.exp(-(Math.min(t, b) - a) / tr)
    h = Math.max(h, t <= b ? hEnd : hEnd * Math.exp(-(t - b) / td))
  }
  return h
}

export function createMissionState(): MissionState {
  return {
    t: 0, phase: 0, phaseProgress: 0, world: 'earth', met: -20, timewarp: 1, altitudeKm: 0, altitudeRef: 'EARTH', velocity: 0,
    distEarthKm: 0, distMarsKm: 1e8, stage: '', boosterEnginesLit: 0, shipSLLit: false, shipVacLit: false,
    boosterThrottle: 0, boosterBoostback: 0, shipThrottleSL: 0, shipThrottleVac: 0, plumeExpansion: 0, frost: 1, venting: 1, qdArm: 0,
    hotStage: 0, boosterRCS: 0, tileGlow: 0, plasma: 0, flapFwd: 0, flapAft: 0, legs: 0, dust: 0, shake: 0, tcm: 0, heatVac: 0, heatSL: 0, heatBooster: 0, ignitionFlash: 0, fade: 0, fadeColor: 'black',
    stackBase: new Vector3(0, MOUNT_HEIGHT, 0), stackQuat: new Quaternion(),
    shipQuat: new Quaternion(), flowDir: FLOW_ENTRY.clone(), booster: { attached: true, pos: new Vector3(), quat: new Quaternion() },
    earthCenter: new Vector3(), earthQuat: new Quaternion(), marsCenter: new Vector3(), marsQuat: new Quaternion(),
    sunDir: SUN_LAUNCH.clone(), skyQuat: new Quaternion(), moonCenter: new Vector3(),
    landerBase: new Vector3(), landerQuat: new Quaternion(),
  }
}

/** Ship pitch/roll attitude for the ascent and orbit (both worlds share it). */
function ascentAttitude(t: number, out: Quaternion) {
  const pitch = tPitch.at(t)
  const roll = tRoll.at(t)
  out.setFromAxisAngle(X, -roll * DEG).multiply(_q2.setFromAxisAngle(Z, -pitch * DEG))
  return out
}

export function sampleMission(t: number, s: MissionState): MissionState {
  s.t = t
  s.phase = phaseIndexAt(t)
  s.phaseProgress = progress(t, PHASES[s.phase].start, phaseEnd(s.phase))
  s.world = worldAt(t)

  // ---------------- telemetry
  s.met = tMET.at(t)
  s.timewarp = Math.max(1, (tMET.at(t + 0.25) - tMET.at(t - 0.25)) / 0.5)
  if (t < 20) s.timewarp = 1
  s.velocity = tVel.at(t)
  const marsAlt = t < WORLD_SWITCH.spaceToMars ? tMarsAlt.at(t) : tLanderAlt.at(t) / 1000
  const earthAlt = t <= 116 ? tAltEarth.at(t) : tEarthDist.at(t)
  s.distEarthKm = earthAlt
  s.distMarsKm = marsAlt
  s.altitudeRef = t < 133 ? 'EARTH' : 'MARS'
  s.altitudeKm = s.altitudeRef === 'EARTH' ? earthAlt : marsAlt

  // ---------------- engines & vehicle systems
  s.boosterThrottle = clamp(tBoosterThrottle.at(t))
  s.boosterBoostback = clamp(tBoostback.at(t))
  s.shipThrottleSL = clamp(tShipSL.at(t))
  s.shipThrottleVac = clamp(tShipVac.at(t))
  s.boosterEnginesLit = s.boosterThrottle > 0.04 ? 33 : s.boosterBoostback > 0.04 ? 13 : 0
  s.shipSLLit = s.shipThrottleSL > 0.04
  s.shipVacLit = s.shipThrottleVac > 0.04
  s.frost = 1 - smoothstep(20, 32, t)
  s.venting = 1 - smoothstep(18.2, 21, t)
  s.qdArm = smoothstep(12, 15.5, t)
  s.hotStage = envelope(t, 51.95, 52.25, 52.9, 53.8)
  s.boosterRCS = 0
  for (const e of RCS_EVENTS) if (e.vehicle === 'booster' && t >= e.t0 && t <= e.t1) s.boosterRCS = 1
  // nozzle extensions heat over the first seconds of a long burn and radiate it away within seconds of cut-off
  s.heatVac = nozzleHeat(t, BURNS.shipVac, 5, 3.5) * Math.min(1, 0.35 + 0.65 * s.shipThrottleVac + (t > 115 && t < 150 ? -0.2 : 0))
  s.heatSL = nozzleHeat(t, BURNS.shipSL, 7, 4) * 0.45
  s.heatBooster = nozzleHeat(t, BURNS.booster, 12, 5) * 0.3
  s.ignitionFlash = Math.max(pulse(t, 52.1, 0.3), pulse(t, 101.1, 0.3), pulse(t, 124.5, 0.25), pulse(t, 133.3, 0.25), pulse(t, 142.0, 0.25), pulse(t, 203.4, 0.3))
  s.tileGlow = clamp(tTileGlow.at(t))
  s.plasma = clamp(tPlasma.at(t))
  s.legs = clamp(tLegs.at(t))
  s.dust = clamp(tDust.at(t))

  if (s.world === 'earth') s.plumeExpansion = smoothstep(1.2, 20, earthAlt) * 0.6
  else if (s.world === 'space') s.plumeExpansion = 0.55 + smoothstep(20, 90, earthAlt) * 0.45
  else s.plumeExpansion = 0.72

  // flaps: stowed for launch, active during entry/belly-flop, forward pair folds for the flip
  const flutter = Math.sin(t * 2.3) * 3 + Math.sin(t * 5.1) * 1.5
  const active = envelope(t, 170, 173, 203, 205)
  // flaps: neutral (radial) for launch and cruise, actively trimming through entry and the belly-flop,
  // forward pair folds leeward for the flip
  s.flapFwd = active * (6 + flutter) + smoothstep(203.2, 205.5, t) * 55
  s.flapAft = active * (4 - flutter * 0.7) - smoothstep(203.2, 205.5, t) * 8
  if (t < 170) {
    s.flapFwd = 0
    s.flapAft = 0
  }

  // camera shake budget
  s.shake =
    envelope(t, 16.4, 17.5, 19.5, 20.2) * 0.35 +
    envelope(t, 20, 20.5, 24, 30) * 0.55 +
    pulse(t, 38.5, 3) * 0.25 +
    pulse(t, 52.2, 1.2) * 0.45 +
    envelope(t, 101.5, 102.5, 113, 114) * 0.05 +
    envelope(t, 173, 176, 186, 190) * 0.3 +
    envelope(t, 203.4, 204, 206, 207) * 0.3 +
    envelope(t, 207, 208, 216.5, 217.6) * 0.22 +
    pulse(t, 217.7, 0.7) * 0.5

  // world transitions: a brief, intentional dip
  s.fade = Math.max(pulse(t, WORLD_SWITCH.earthToSpace, 0.5), pulse(t, WORLD_SWITCH.spaceToMars, 0.7))
  s.fadeColor = t > 150 ? 'ember' : 'black'

  s.stage =
    t < 20 ? 'Stack on pad' : t < 51.6 ? 'Booster · 33 engines' : t < 52.4 ? 'MECO' : t < 72 ? 'Ship · 6 engines' : t < 101 ? 'Ship · coast' :
    t < 114.2 ? 'Ship · TMI burn' : t < 146 ? (s.tcm > 0.05 ? 'Ship · correction burn' : 'Ship · cruise') : t < 172 ? 'Ship · Mars arrival' : t < 203.4 ? 'Ship · aerobraking' : t < 217.7 ? 'Ship · landing burn' : 'Ship · landed'

  // ---------------- Earth launch world (metres)
  {
    const tau = t - 20
    let h = 0
    if (tau > 0) h = tau < 8 ? 0.5 * 3.2 * tau * tau : tAltEarth.at(t) * 1000
    if (tau > 7 && tau < 9) {
      // blend the analytic liftoff curve into the ascent track
      const k = smootherstep(7, 9, tau)
      h = (1 - k) * 0.5 * 3.2 * tau * tau + k * tAltEarth.at(t) * 1000
    }
    s.stackBase.set(tDownrange.at(t), MOUNT_HEIGHT + h, 0)
    s.stackQuat.setFromAxisAngle(Z, -tPitch.at(t) * DEG)
  }

  // ---------------- space world (km, floating origin at the ship)
  {
    const theta = t <= 116 ? tTheta.at(t) : tTheta.at(116)
    // ship attitude
    if (t < 167) ascentAttitude(t, s.shipQuat)
    else s.shipQuat.copy(rotZ(tEntryBeta.at(t), _q)).multiply(Q_ORBIT)
    s.tcm = 0
    if (t > 116 && t < 167) {
      // slow, lonely attitude drift during the cruise
      const k = envelope(t, 116, 122, 158, 166)
      _q.setFromAxisAngle(X, Math.sin(t * 0.05) * 0.04 * k)
      s.shipQuat.premultiply(_q)
      // trajectory-correction manoeuvres: slew to the burn attitude, brief burn, slew back
      for (const [a, b, c, d, axis, ang] of TCMS) {
        if (t < a || t > d) continue
        const k2 = t < b ? bangCoast(progress(t, a, b - 0.6), SLEW_FA) : t < c ? 1 : 1 - bangCoast(progress(t, c + 0.4, d), SLEW_FA)
        _q.setFromAxisAngle(axis, ang * DEG * k2)
        s.shipQuat.premultiply(_q)
        s.tcm = envelope(t, b, b + 0.3, c - 0.3, c)
      }
    }
    s.flowDir.copy(FLOW_ENTRY)

    // Earth: floating below during ascent/orbit, receding behind after TMI
    rotZ(theta, _q)
    s.earthQuat.copy(_q).multiply(EARTH_Q0)
    if (t <= 104) {
      s.earthCenter.set(0, -(EARTH_RADIUS_KM + tAltEarth.at(t)), 0)
    } else {
      const k = smootherstep(104, 124, t)
      _v.set(0, 1, 0).lerp(EARTH_DIR_BEHIND, k).normalize()
      const d = EARTH_RADIUS_KM + (t <= 116 ? tAltEarth.at(t) : tEarthDist.at(t))
      s.earthCenter.copy(_v).multiplyScalar(-d)
    }

    // Sun / star frame: rotates with the orbit, then hands over to the Mars frame on approach
    // real sky: stars and sun ride with the orbital frame, then hand over to the Jezero frame on approach
    const qOrbit = rotZ(theta, new Quaternion())
    const thetaM = tThetaMars.at(t)
    const qMarsOrbit = rotZ(thetaM - THETA_MARS_END, new Quaternion())
    const hand = smootherstep(144, 164, t)
    s.skyQuat.copy(qOrbit).multiply(Q_EARTH_SKY).slerp(new Quaternion().copy(qMarsOrbit).multiply(Q_MARS_SKY), hand)
    const sunE = SUN_LAUNCH.clone().applyQuaternion(qOrbit)
    const sunM = SUN_MARS_SURFACE.clone().applyQuaternion(qMarsOrbit)
    s.sunDir.copy(sunE).lerp(sunM, hand).normalize()
    // the real Moon, riding with Earth
    moonOffsetKm(s.met, _moon).applyQuaternion(qOrbit)
    s.moonCenter.copy(s.earthCenter).add(_moon)

    // Mars: a red star far ahead, swinging beneath the ship on arrival
    const dM = MARS_RADIUS_KM + tMarsAlt.at(t)
    const kd = smootherstep(154, 171, t)
    _v.copy(MARS_DIR_FAR).lerp(Y.clone().negate(), kd).normalize()
    s.marsCenter.copy(_v).multiplyScalar(dM)
    rotZ(thetaM - THETA_MARS_END, _q)
    s.marsQuat.copy(_q).multiply(MARS_Q0)

    // Booster: attached until hot staging, then falls away, flips and boosts back
    const tau = t - 52.35
    const b = s.booster
    const km = 0.001
    if (tau <= 0) {
      b.attached = true
      b.quat.copy(s.shipQuat)
      // booster origin (engine plane) sits one booster-length below the ship base
      _v.set(0, -(VEHICLE.shipLength / 2 + VEHICLE.boosterLength) * km, 0).applyQuaternion(s.shipQuat)
      b.pos.copy(_v)
    } else {
      b.attached = false
      const sepQ = ascentAttitude(52.35, _q)
      const axis = new Vector3(0, 1, 0).applyQuaternion(sepQ)
      // relative motion: the ship pulls away at ~1.3 g while the unpowered booster coasts;
      // the ship's plume pushes the booster slightly aside, then the flip starts on cold gas
      const sep = (0.5 * 12.5 * tau * tau + 1.2 * tau) * km // metres → km
      _v.set(0, -(VEHICLE.shipLength / 2 + VEHICLE.boosterLength) * km, 0).applyQuaternion(sepQ)
      b.pos.copy(_v).addScaledVector(axis, -sep)
      b.pos.y -= 0.5 * 1.4 * tau * tau * km
      b.pos.z += (0.6 * tau + 0.02 * tau * tau) * km
      // slow, massive rotation: small tip-off wobble, then a 13 s flip about the centre of mass
      const tip = Math.sin(Math.min(tau, 3) * 1.1) * 2.5 * (1 - progress(tau, 2, 4))
      const flip = bangCoast(progress(tau + 52.35, FLIP.t0, FLIP.t1), FLIP.fa) * 172
      _q2.setFromAxisAngle(Z, (flip + tip) * DEG)
      const roll = new Quaternion().setFromAxisAngle(Y, progress(tau, 3, 16) * 0.35)
      b.quat.copy(_q2).multiply(sepQ).multiply(roll)
      const com = 0.4 * VEHICLE.boosterLength * km
      const before = new Vector3(0, com, 0).applyQuaternion(sepQ)
      const after = new Vector3(0, com, 0).applyQuaternion(b.quat)
      b.pos.add(before.sub(after))
    }
  }

  // ---------------- Mars landing world (metres)
  {
    const alt = tLanderAlt.at(t)
    s.landerBase.set(tLanderX.at(t), alt + VEHICLE.legReach, Math.sin(t * 0.21) * 12 * (1 - smoothstep(203, 212, t)))
    const flip = tFlip.at(t)
    const wobble = (1 - smoothstep(200, 204, t)) * Math.sin(t * 0.9) * 2.5
    s.landerQuat.copy(rotZ(flip, _q)).multiply(Q_ORBIT)
    _q2.setFromAxisAngle(X, wobble * DEG)
    s.landerQuat.premultiply(_q2)
    if (t < WORLD_SWITCH.spaceToMars) s.landerBase.set(-3200, 6500, 0)
  }
  return s
}
