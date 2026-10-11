import { Quaternion, Vector3 } from 'three'
import { SUN_MARS_SURFACE } from '../mission/constants'
import { jezeroHoursAtSunEl, jezeroSkyAt, SKY_QUAT_MARS } from '../mission/ephemeris'

/**
 * Explore mode state shared by the rover, the Mars world and the HUD
 * (plain mutable objects, like `runtime`, so nothing re-renders per frame).
 */

/** Real Perseverance top speed on flat ground, m/s, and the time-lapse the view runs at. */
export const ROVER_TRUE_VMAX = 0.042
export const TIMELAPSE = 60

export const rover = {
  pos: new Vector3(24, 0, 18),
  heading: -2.2, // rad, 0 = +z; facing roughly west-north-west, toward the delta
  speed: 0, // m/s as displayed (true × TIMELAPSE)
  quat: new Quaternion(),
  odometer: 0, // true metres driven
  wheelSpin: 0,
  blocked: '' as string,
  /** view: chase camera or the mast camera */
  view: 'chase' as 'chase' | 'mast',
  camYaw: 2.6,
  camPitch: 0.28,
  camDist: 9,
  /** extra upward tilt of the chase camera (night sky framing), rad */
  lookUp: 0,
  mastYaw: 0,
  mastPitch: -0.12,
  input: { fwd: 0, turn: 0 },
}

export function resetRover() {
  rover.pos.set(24, 0, 18)
  rover.heading = -2.2
  rover.speed = 0
  rover.odometer = 0
  rover.view = 'chase'
  rover.camYaw = 2.6
  rover.camPitch = 0.28
  rover.camDist = 9
  rover.lookUp = 0
}

/** Sky over Jezero in explore mode; `night` animates 0 (landing afternoon) … 1 (astronomical night). */
export const exploreSky = {
  hours: 0,
  sun: SUN_MARS_SURFACE.clone(),
  quat: SKY_QUAT_MARS.clone(),
  earth: new Vector3(0, 1, 0),
  earthMag: 0,
  date: new Date(),
  night: 0,
  changed: true,
  /** skip the sunset animation once (URL ?night, tests) */
  jump: false,
}

/** Galactic centre (J2000 RA 266.405°, Dec −28.936°) in the sky catalogue frame (EQJ x, z, −y). */
const GC = (() => {
  const ra = (266.405 * Math.PI) / 180
  const dec = (-28.936 * Math.PI) / 180
  const x = Math.cos(dec) * Math.cos(ra)
  const y = Math.cos(dec) * Math.sin(ra)
  const z = Math.sin(dec)
  return new Vector3(x, z, -y)
})()

let nightHours: number | null = null
/**
 * "Night" = the hour of this night, between astronomical dusk and dawn, when the
 * Milky Way's core stands highest over Jezero — when you'd go out to look.
 */
function findNightHours() {
  const dusk = jezeroHoursAtSunEl(-22, 0)
  const dawn = jezeroHoursAtSunEl(-22, dusk + 1, true)
  let best = dusk
  let bestEl = -2
  for (let h = dusk; h <= dawn; h += 0.25) {
    const el = GC.clone().applyQuaternion(jezeroSkyAt(h).skyQuat).y
    if (el > bestEl) {
      bestEl = el
      best = h
    }
  }
  return best
}
const init = jezeroSkyAt(0)
exploreSky.earth.copy(init.earth)
exploreSky.earthMag = init.earthMag
exploreSky.date = init.date

/** Advance the sky toward day or night (sun sets/rises along its real path). */
let sunsetHours: number | null = null
/** Sunset: the sun 2° above the horizon, when the dust's forward lobe turns the sky round it blue. */
function findSunsetHours() {
  return jezeroHoursAtSunEl(3.5, 0)
}

export function stepExploreSky(dt: number, wantNight: boolean, wantSunset = false) {
  nightHours ??= findNightHours()
  sunsetHours ??= findSunsetHours()
  const target = wantNight ? nightHours : wantSunset ? sunsetHours : 0
  const d = target - exploreSky.hours
  exploreSky.changed = Math.abs(d) > 1e-4
  if (!exploreSky.changed) return
  const rate = 1.25 // sky hours per second of viewing
  exploreSky.hours += exploreSky.jump ? d : Math.sign(d) * Math.min(Math.abs(d), rate * dt)
  exploreSky.jump = false
  const s = jezeroSkyAt(exploreSky.hours)
  exploreSky.sun.copy(s.sun)
  exploreSky.quat.copy(s.skyQuat)
  exploreSky.earth.copy(s.earth)
  exploreSky.earthMag = s.earthMag
  exploreSky.date = s.date
  // darkness from the sun's depression: civil twilight to astronomical night
  const el = (Math.asin(s.sun.y) * 180) / Math.PI
  const k = Math.min(1, Math.max(0, (-el - 1) / 17))
  exploreSky.night = k * k * (3 - 2 * k)
}

export function resetExploreSky() {
  exploreSky.hours = 0
  exploreSky.sun.copy(SUN_MARS_SURFACE)
  exploreSky.quat.copy(SKY_QUAT_MARS)
  exploreSky.night = 0
  exploreSky.changed = true
}

/** Chase-camera yaw that looks into the sunset, the rover in the foreground against the glow. */
export function sunsetCameraYaw() {
  sunsetHours ??= findSunsetHours()
  const d = jezeroSkyAt(sunsetHours).sun
  rover.lookUp = 0.04
  // sun a third of the way across the frame, not dead centre (and clear of the ship parked beside the rover)
  return Math.atan2(-d.x, -d.z) - rover.heading + 0.3
}

/** Chase-camera yaw (relative to the rover) that looks toward the Milky Way's core at night. */
export function nightCameraYaw() {
  nightHours ??= findNightHours()
  const q = jezeroSkyAt(nightHours).skyQuat
  const d = GC.clone().applyQuaternion(q)
  // camera sits opposite the look direction; tilt up so the rover sits low in frame under the core
  rover.lookUp = Math.max(0, Math.min(0.9, Math.asin(d.y) - 0.3))
  return Math.atan2(-d.x, -d.z) - rover.heading
}
