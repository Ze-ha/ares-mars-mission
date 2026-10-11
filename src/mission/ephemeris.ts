import * as Astronomy from 'astronomy-engine'
import { Matrix4, Quaternion, Vector3 } from 'three'

/**
 * Real ephemerides (astronomy-engine, VSOP87 / NOVAS-grade, fully offline).
 *
 * The mission is pinned to the real late-2026 Earth→Mars transfer window:
 *  - launch from Starbase, Texas, on 2026-11-27 in the early-morning sun,
 *  - 186-day transfer,
 *  - landing at Jezero Crater near Perseverance's landing site in the Martian afternoon.
 *
 * Everything that depends on "where things really are" comes from here:
 * sun direction at the pad and at Jezero, the orientation of the real star
 * catalogue in each world, and the Moon's position relative to Earth.
 *
 * World frames used by the scene: x = east, y = up, z = south (right-handed).
 * The sky frame of the star catalogue is J2000 equatorial remapped as
 * (X, Z, −Y), i.e. celestial north pole = +y.
 */

export const LAUNCH_SITE_GEO = { lat: 25.9972, lon: -97.1566, height: 5 } // Starbase pad
export const JEZERO = { lat: 18.4447, lon: 77.4508 } // Perseverance landing site (Octavia E. Butler Landing)
export const TRANSFER_DAYS = 186
const LAUNCH_DAY = new Date(Date.UTC(2026, 10, 27, 12, 0, 0)) // 2026-11-27, search from 06:00 local
const TARGET_LAUNCH_SUN_EL = 16 // degrees above the horizon, sun rising
const TARGET_LANDING_SUN_EL = 27 // degrees, Martian afternoon

const AU_KM = Astronomy.KM_PER_AU

// ---------------------------------------------------------------- helpers
const v3 = (v: { x: number; y: number; z: number }) => new Vector3(v.x, v.y, v.z)
/** rows = world axes (east, up, south) expressed in EQJ → matrix mapping EQJ → world */
function frameMatrix(east: Vector3, up: Vector3, south: Vector3) {
  return new Matrix4().set(east.x, east.y, east.z, 0, up.x, up.y, up.z, 0, south.x, south.y, south.z, 0, 0, 0, 0, 1)
}
/** sky frame (X, Z, −Y) → EQJ */
const SKY_TO_EQJ = new Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1)

// ---------------------------------------------------------------- Earth
const observer = new Astronomy.Observer(LAUNCH_SITE_GEO.lat, LAUNCH_SITE_GEO.lon, LAUNCH_SITE_GEO.height)

function earthFrame(time: Astronomy.AstroTime) {
  // astronomy-engine HOR: x = north, y = west, z = zenith
  const rot = Astronomy.Rotation_EQJ_HOR(time, observer)
  const r = rot.rot // r[col][row]
  const toHor = (v: Vector3) =>
    new Vector3(r[0][0] * v.x + r[1][0] * v.y + r[2][0] * v.z, r[0][1] * v.x + r[1][1] * v.y + r[2][1] * v.z, r[0][2] * v.x + r[1][2] * v.y + r[2][2] * v.z)
  // world = (east, up, south) = (−west, zenith, −north)
  const eqjToWorld = (v: Vector3) => {
    const h = toHor(v)
    return new Vector3(-h.y, h.z, -h.x)
  }
  // build the EQJ→world matrix from the images of the basis vectors
  const ex = eqjToWorld(new Vector3(1, 0, 0))
  const ey = eqjToWorld(new Vector3(0, 1, 0))
  const ez = eqjToWorld(new Vector3(0, 0, 1))
  return new Matrix4().set(ex.x, ey.x, ez.x, 0, ex.y, ey.y, ez.y, 0, ex.z, ey.z, ez.z, 0, 0, 0, 0, 1)
}

function sunElevationAtPad(time: Astronomy.AstroTime) {
  const eq = Astronomy.Equator(Astronomy.Body.Sun, time, observer, true, true)
  return Astronomy.Horizon(time, observer, eq.ra, eq.dec, 'normal').altitude
}

/** first time after sunrise on the launch day when the sun reaches the target elevation */
function findLaunchTime() {
  let t = Astronomy.MakeTime(LAUNCH_DAY)
  for (let i = 0; i < 24 * 60; i++) {
    if (sunElevationAtPad(t) >= TARGET_LAUNCH_SUN_EL) return t
    t = t.AddDays(1 / (24 * 60))
  }
  return t
}

// ---------------------------------------------------------------- Mars
function marsFrame(time: Astronomy.AstroTime, lat: number, lon: number) {
  const ax = Astronomy.RotationAxis(Astronomy.Body.Mars, time)
  const pole = v3(ax.north).normalize()
  // ascending node of Mars' equator on the ICRF equator, then prime meridian at angle W (IAU)
  const node = new Vector3(0, 0, 1).cross(pole).normalize()
  const W = (ax.spin * Math.PI) / 180
  const q = new Vector3().crossVectors(pole, node)
  const pm = node.clone().multiplyScalar(Math.cos(W)).addScaledVector(q, Math.sin(W))
  const yb = new Vector3().crossVectors(pole, pm)
  const la = (lat * Math.PI) / 180
  const lo = (lon * Math.PI) / 180
  const up = pm.clone().multiplyScalar(Math.cos(la) * Math.cos(lo)).addScaledVector(yb, Math.cos(la) * Math.sin(lo)).addScaledVector(pole, Math.sin(la)).normalize()
  const east = pm.clone().multiplyScalar(-Math.sin(lo)).addScaledVector(yb, Math.cos(lo)).normalize()
  const north = new Vector3().crossVectors(up, east).normalize()
  return frameMatrix(east, up, north.clone().negate())
}

function sunFromMarsEqj(time: Astronomy.AstroTime) {
  return v3(Astronomy.HelioVector(Astronomy.Body.Mars, time)).negate().normalize()
}

/** afternoon time on the landing sol when the sun has descended to the target elevation */
function findLandingTime(arrival: Astronomy.AstroTime) {
  let best = arrival
  let prevEl = -99
  let t = arrival
  const step = 1 / (24 * 60) // 1 minute
  for (let i = 0; i < 25 * 60 * 1.03; i++) {
    const s = sunFromMarsEqj(t).applyMatrix4(marsFrame(t, JEZERO.lat, JEZERO.lon))
    const el = (Math.asin(s.y) * 180) / Math.PI
    if (prevEl > TARGET_LANDING_SUN_EL && el <= TARGET_LANDING_SUN_EL) {
      best = t
      break
    }
    prevEl = el
    t = t.AddDays(step)
  }
  return best
}

// ---------------------------------------------------------------- compute once
const launchTime = findLaunchTime()
const landingTime = findLandingTime(launchTime.AddDays(TRANSFER_DAYS))

const E_EQJ_TO_WORLD = earthFrame(launchTime)
const M_EQJ_TO_WORLD = marsFrame(landingTime, JEZERO.lat, JEZERO.lon)

export const LAUNCH_DATE = launchTime.date
export const LANDING_DATE = landingTime.date

/** Sun direction in the Starbase world frame at launch. */
export const SUN_AT_LAUNCH = v3(Astronomy.GeoVector(Astronomy.Body.Sun, launchTime, true)).normalize().applyMatrix4(E_EQJ_TO_WORLD).normalize()
/** Sun direction in the Jezero world frame at landing. */
export const SUN_AT_JEZERO = sunFromMarsEqj(landingTime).applyMatrix4(M_EQJ_TO_WORLD).normalize()

/** Orientation of the star catalogue (sky frame) in each world. */
export const SKY_QUAT_EARTH = new Quaternion().setFromRotationMatrix(E_EQJ_TO_WORLD.clone().multiply(SKY_TO_EQJ))
export const SKY_QUAT_MARS = new Quaternion().setFromRotationMatrix(M_EQJ_TO_WORLD.clone().multiply(SKY_TO_EQJ))

/** Moon position relative to Earth's centre, launch-world frame, km (at a given mission-elapsed time). */
export function moonOffsetKm(metSeconds: number, out: Vector3) {
  const t = launchTime.AddDays(metSeconds / 86400)
  return out.copy(v3(Astronomy.GeoMoon(t))).multiplyScalar(AU_KM).applyMatrix4(E_EQJ_TO_WORLD)
}

/** UTC wall-clock date for a mission-elapsed time. */
export function utcAt(metSeconds: number) {
  return new Date(launchTime.date.getTime() + metSeconds * 1000)
}

/** Geometry summary (useful for the README / debugging). */
export const EPHEMERIS_SUMMARY = {
  launchUTC: launchTime.date.toISOString(),
  landingUTC: landingTime.date.toISOString(),
  sunElevationAtLaunch: (Math.asin(SUN_AT_LAUNCH.y) * 180) / Math.PI,
  sunAzimuthAtLaunch: ((Math.atan2(SUN_AT_LAUNCH.x, -SUN_AT_LAUNCH.z) * 180) / Math.PI + 360) % 360,
  sunElevationAtJezero: (Math.asin(SUN_AT_JEZERO.y) * 180) / Math.PI,
  sunAzimuthAtJezero: ((Math.atan2(SUN_AT_JEZERO.x, -SUN_AT_JEZERO.z) * 180) / Math.PI + 360) % 360,
}

// ---------------------------------------------------------------- Jezero sky over the following sols (explore mode)
export interface JezeroSky {
  /** sun direction, landing-site frame */
  sun: Vector3
  /** star catalogue orientation */
  skyQuat: Quaternion
  /** direction to Earth, and its apparent magnitude from Mars */
  earth: Vector3
  earthMag: number
  /** local date */
  date: Date
}
/** Real sky over Jezero `hours` after touchdown: the sun and stars turn with Mars' rotation. */
export function jezeroSkyAt(hours: number): JezeroSky {
  const t = landingTime.AddDays(hours / 24)
  const F = marsFrame(t, JEZERO.lat, JEZERO.lon)
  const sun = sunFromMarsEqj(t).applyMatrix4(F).normalize()
  const skyQuat = new Quaternion().setFromRotationMatrix(F.clone().multiply(SKY_TO_EQJ))
  const e = v3(Astronomy.HelioVector(Astronomy.Body.Earth, t)).sub(v3(Astronomy.HelioVector(Astronomy.Body.Mars, t)))
  const dAU = e.length()
  const earth = e.normalize().applyMatrix4(F).normalize()
  // phase angle Sun–Earth–Mars → approximate apparent magnitude (Earth H ≈ −3.99)
  const sunFromEarth = v3(Astronomy.HelioVector(Astronomy.Body.Earth, t)).negate().normalize()
  const toMars = v3(Astronomy.HelioVector(Astronomy.Body.Mars, t)).sub(v3(Astronomy.HelioVector(Astronomy.Body.Earth, t))).normalize()
  const phase = Math.acos(Math.max(-1, Math.min(1, sunFromEarth.dot(toMars))))
  const rE = v3(Astronomy.HelioVector(Astronomy.Body.Earth, t)).length()
  const earthMag = -3.99 + 5 * Math.log10(rE * dAU) + 0.0205 * (phase * 180 / Math.PI)
  return { sun, skyQuat, earth, earthMag, date: t.date }
}

/** Hours after touchdown when the sun is at `el` degrees, searching forward (setting or rising). */
export function jezeroHoursAtSunEl(el: number, from = 0, rising = false) {
  let prev = jezeroSkyAt(from).sun.y
  const target = Math.sin((el * Math.PI) / 180)
  for (let h = from + 0.05; h < from + 26; h += 0.05) {
    const y = jezeroSkyAt(h).sun.y
    if (!rising && prev > target && y <= target) return h
    if (rising && prev < target && y >= target) return h
    prev = y
  }
  return from
}
