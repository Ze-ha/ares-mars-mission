import { Vector3 } from 'three'
import type { MissionState } from '../mission/trajectory'
import type { WorldId } from '../mission/phases'
import { SUN_MARS_SURFACE, VEHICLE } from '../mission/constants'
import { easeInOutSine, lerp } from '../utils/math'
import { marsHeight } from '../assets/mars/MarsSite'

/**
 * Cinematic shot list — documentary camera language: long lenses from fixed
 * tracking sites on the ground, vehicle-mounted "engineering" cameras, and
 * slow, heavy observational moves in space. Each shot is a pure function of
 * mission time returning a pose; the director cross-blends consecutive shots
 * with a slow ease, `cut: true` marks deliberate hard cuts.
 *
 * Units follow the world: metres (earth, mars) or kilometres (space).
 */

export interface Pose {
  pos: Vector3
  target: Vector3
  fov: number
}
/** What kind of microphone the shot implies (drives the sound design, see src/audio). */
export type Ear = 'ground' | 'mounted' | 'onboard' | 'external'
export interface Shot {
  name: string
  start: number
  end: number
  world: WorldId
  cut?: boolean
  /** exposure offset in stops, set per shot like a camera operator would */
  ev?: number
  /** listener model; defaults to 'external' */
  ear?: Ear
  eval: (s: MissionState, u: number, out: Pose) => void
}

const KM = 0.001
const Y = new Vector3(0, 1, 0)
const a = new Vector3()
const b = new Vector3()
const c = new Vector3()

const stackAxis = (s: MissionState) => a.copy(Y).applyQuaternion(s.stackQuat)
const stackPoint = (s: MissionState, along: number, out: Vector3) => out.copy(s.stackBase).addScaledVector(stackAxis(s), along)
const landerCenter = (s: MissionState, out: Vector3) => out.copy(Y).applyQuaternion(s.landerQuat).multiplyScalar(24).add(s.landerBase)
/** A point in the ship's local frame (metres, origin at engine plane) → space-world km (ship centre at origin). */
const shipLocal = (s: MissionState, x: number, y: number, z: number, out: Vector3) =>
  out.set(x, y - VEHICLE.shipLength / 2, z).applyQuaternion(s.shipQuat).multiplyScalar(KM)
/** Same for the lander in the Mars world (metres). */
const landerLocal = (s: MissionState, x: number, y: number, z: number, out: Vector3) => out.set(x, y, z).applyQuaternion(s.landerQuat).add(s.landerBase)
/** FOV (deg) that frames `size` units at distance `d` */
const frameFov = (size: number, d: number, min = 1.5, max = 60) => Math.min(max, Math.max(min, (2 * Math.atan(size / 2 / d) * 180) / Math.PI))
const ease = easeInOutSine
/** terrain height under a Mars-world point, so ground cameras stand on the real terrain */
/** ground camera for the landing burn: 535 m out, 55° off the sun's azimuth (sun over the operator's shoulder) */
const LANDING_CAM = (() => {
  const h = new Vector3(SUN_MARS_SURFACE.x, 0, SUN_MARS_SURFACE.z).normalize().applyAxisAngle(new Vector3(0, 1, 0), 0.96)
  return h.multiplyScalar(535)
})()
const ground = (x: number, z: number) => Math.max(marsHeight(x, z), 0) + Math.max(0, marsHeight(x * 0.97, z * 0.97) - marsHeight(x, z))

export const SHOTS: Shot[] = [
  // ============================================================ EARTH (m)
  {
    name: 'Establishing — long lens across the flats', ear: 'ground', start: 0, end: 6, world: 'earth',
    eval: (_s, u, o) => {
      o.pos.set(lerp(-980, -940, ease(u)), 4.5, lerp(820, 790, ease(u)))
      o.target.set(0, lerp(68, 74, u), 0)
      o.fov = 13.5
    },
  },
  {
    name: 'Crane up the booster through the venting', ear: 'ground', start: 6, end: 11, world: 'earth',
    eval: (_s, u, o) => {
      const e = ease(u)
      o.pos.set(26, lerp(12, 54, e), 34)
      o.target.set(0, lerp(38, 96, e), 0)
      o.fov = 42
    },
  },
  {
    name: 'Tower top — ship nose & chopsticks', ear: 'ground', ev: 0.5, start: 11, end: 16, world: 'earth',
    eval: (_s, u, o) => {
      const e = ease(u)
      // from the tower's sunward corner: low morning sun rakes across the frosted steel instead of backlighting it
      o.pos.set(lerp(25, 19, e), 159, lerp(-35, -29, e))
      o.target.set(0, lerp(134, 106, e), 0)
      o.fov = 44
    },
  },
  {
    name: 'Under the engines — ignition', ear: 'ground', ev: -0.7, start: 16, end: 18.4, world: 'earth', cut: true,
    eval: (_s, u, o) => {
      o.pos.set(lerp(5, 5.6, u), 2.2, lerp(8, 9, u))
      o.target.set(0, 22, 0)
      o.fov = 70
    },
  },
  {
    name: 'Pad camera — hold-down release', ear: 'ground', ev: -0.3, start: 18.4, end: 20.6, world: 'earth', cut: true,
    eval: (s, _u, o) => {
      o.pos.set(250, 3.2, 320)
      stackPoint(s, 50, o.target)
      o.fov = 27
    },
  },
  {
    name: 'Liftoff — long-lens tracking site', ear: 'ground', start: 20.6, end: 28, world: 'earth',
    eval: (s, u, o) => {
      o.pos.set(-1450, 9, 1220)
      stackPoint(s, 55, o.target)
      o.fov = lerp(11.5, 9.5, ease(u))
    },
  },
  {
    name: 'Ascent — tracking telescope', ear: 'ground', start: 28, end: 34, world: 'earth',
    eval: (s, _u, o) => {
      o.pos.set(-2600, 22, 2150)
      stackPoint(s, 45, o.target)
      o.fov = frameFov(380, o.pos.distanceTo(o.target))
    },
  },
  {
    name: 'Booster engineering camera', ear: 'mounted', start: 34, end: 39.5, world: 'earth',
    eval: (s, u, o) => {
      const ax = stackAxis(s).clone()
      stackPoint(s, 0, o.pos)
      o.pos.add(b.set(lerp(20, 24, u), 0, 28)).addScaledVector(ax, -24)
      stackPoint(s, 70, o.target)
      o.fov = 48
    },
  },
  {
    name: 'Side ascent — sky turning dark', ear: 'external', start: 39.5, end: 44, world: 'earth',
    eval: (s, u, o) => {
      stackPoint(s, 60, o.target)
      o.pos.copy(o.target).add(b.set(lerp(-160, -125, u), lerp(-25, 15, u), 215))
      o.fov = 34
    },
  },
  // ============================================================ SPACE (km, ship at origin)
  {
    // SIGNATURE: camera bolted to the ship's side, looking down past the hull at the curving Earth
    name: 'Side-mounted camera — looking down at Earth', ear: 'mounted', ev: -0.2, start: 44, end: 52, world: 'space', cut: true,
    eval: (s, u, o) => {
      // mounted on the belly quadrant, between the flaps, like the real onboard cameras
      shipLocal(s, 3.9, 40, -3.9, o.pos)
      shipLocal(s, 3.4, -80, -3.4, b)
      c.subVectors(b, o.pos).normalize()
      c.lerp(Y.clone().negate(), lerp(0.14, 0.2, u)).normalize()
      o.target.copy(o.pos).addScaledVector(c, 1)
      o.fov = 74
    },
  },
  {
    name: 'Stage separation — wide, both vehicles', ear: 'external', ev: 0.2, start: 52, end: 58.5, world: 'space',
    eval: (s, u, o) => {
      o.target.copy(s.booster.pos).multiplyScalar(0.42)
      o.pos.set(lerp(0.2, 0.17, u), lerp(-0.04, -0.02, u), 0.4).add(b.copy(o.target))
      o.fov = lerp(34, 38, u)
    },
  },
  {
    name: 'Looking back from the ship — booster flip', ear: 'mounted', start: 58.5, end: 66, world: 'space',
    eval: (s, u, o) => {
      shipLocal(s, VEHICLE.radius + 9, 6, 14, o.pos)
      c.copy(s.booster.pos).add(b.copy(Y).applyQuaternion(s.booster.quat).multiplyScalar(0.035))
      o.target.copy(c)
      o.fov = lerp(30, 22, ease(u))
    },
  },
  {
    name: 'Orbital reveal', ear: 'external', start: 66, end: 81, world: 'space',
    eval: (_s, u, o) => {
      const e = ease(u)
      o.pos.set(lerp(0.035, -0.12, e), lerp(0.012, 0.055, e), lerp(0.075, 0.28, e))
      o.target.set(lerp(0.0, 0.03, e), lerp(0, -0.015, e), 0)
      o.fov = lerp(40, 50, e)
    },
  },
  {
    name: 'Overhead — ship against the clouds', ear: 'external', start: 81, end: 91, world: 'space',
    eval: (_s, u, o) => {
      o.pos.set(lerp(-0.05, 0.02, u), 0.15, 0.06)
      o.target.set(0, -0.03, 0)
      o.fov = 46
    },
  },
  {
    name: 'Chasing the terminator', ear: 'external', start: 91, end: 101, world: 'space',
    eval: (_s, u, o) => {
      o.pos.set(-0.13, lerp(0.012, 0.02, u), 0.04)
      o.target.set(0.15, -0.02, 0)
      o.fov = 44
    },
  },
  {
    name: 'TMI burn — from behind', ear: 'external', start: 101, end: 107, world: 'space',
    eval: (_s, u, o) => {
      o.pos.set(lerp(-0.11, -0.15, u), lerp(0.02, 0.03, u), lerp(0.055, 0.075, u))
      o.target.set(0.015, 0, 0)
      o.fov = 42
    },
  },
  {
    // SIGNATURE 2: departure — side camera looking back down the hull at Earth falling away
    name: 'Side-mounted camera — leaving Earth', ear: 'mounted', start: 107, end: 116, world: 'space',
    eval: (s, u, o) => {
      shipLocal(s, 3.9, 38, -3.9, o.pos)
      b.copy(s.earthCenter).normalize()
      shipLocal(s, 3.4, -60, -3.4, c)
      c.sub(o.pos).normalize()
      c.lerp(b, lerp(0.5, 0.62, u)).normalize()
      o.target.copy(o.pos).addScaledVector(c, 1)
      o.fov = 70
    },
  },
  {
    name: 'Looking back — Earth shrinking', ear: 'external', ev: -0.2, start: 116, end: 123, world: 'space', cut: true,
    eval: (s, u, o) => {
      b.copy(s.earthCenter).normalize()
      // camera just off the ship's shoulder, Earth behind the ship
      o.pos.copy(b).multiplyScalar(-0.09).add(c.set(0.02, 0.03, 0.05))
      o.target.copy(b).multiplyScalar(0.25)
      o.fov = lerp(52, 40, ease(u))
    },
  },
  {
    name: 'TCM-1 — slew and burn', ear: 'external', ev: 0.5, start: 123, end: 130, world: 'space',
    eval: (_s, u, o) => {
      const ang = lerp(2.2, 2.6, u)
      o.pos.set(Math.cos(ang) * 0.22, 0.06, Math.sin(ang) * 0.22)
      o.target.set(0, 0, 0)
      o.fov = 30
    },
  },
  {
    name: 'Earth — a distant world', ear: 'external', ev: 0.6, start: 130, end: 137.5, world: 'space',
    eval: (s, u, o) => {
      b.copy(s.earthCenter).normalize()
      c.crossVectors(b, Y).normalize()
      o.pos.copy(b).multiplyScalar(-0.12).addScaledVector(c, 0.03).add(a.set(0, 0.02, 0))
      o.target.copy(b).multiplyScalar(1).addScaledVector(c, lerp(-0.08, -0.06, u))
      o.fov = 34
    },
  },
  {
    name: 'Alone in the dark — TCM-3', ear: 'external', ev: 0.8, start: 137.5, end: 146, world: 'space',
    eval: (_s, u, o) => {
      const ang = lerp(0.35, 0.8, u)
      o.pos.set(Math.cos(ang) * 0.6, 0.13, Math.sin(ang) * 0.6)
      o.target.set(0, 0, 0)
      o.fov = 24
    },
  },
  {
    name: 'Over the shoulder — the red point ahead', ear: 'external', ev: 0.6, start: 146, end: 153, world: 'space', cut: true,
    eval: (s, u, o) => {
      o.pos.set(lerp(-0.075, -0.068, u), 0.004, 0.036)
      o.target.copy(s.marsCenter).normalize().add(b.set(0, -0.08, -0.22)).normalize()
      o.fov = 44
    },
  },
  {
    name: 'Mars growing', ear: 'external', start: 153, end: 158, world: 'space',
    eval: (s, u, o) => {
      b.copy(s.marsCenter).normalize()
      c.crossVectors(b, Y).normalize()
      o.pos.copy(b).multiplyScalar(-0.07).addScaledVector(c, 0.035).add(a.set(0, 0.015, 0))
      o.target.copy(b).multiplyScalar(0.6)
      o.fov = lerp(40, 44, u)
    },
  },
  {
    // the full-planet reveal: third-person from well behind the ship; the vehicle is a small
    // silhouette against the whole disk of Mars
    name: 'Full-planet reveal', ear: 'external', start: 158, end: 167, world: 'space',
    eval: (s, u, o) => {
      b.copy(s.marsCenter).normalize()
      c.crossVectors(b, Y).normalize()
      const up = a.crossVectors(c, b).normalize()
      const back = lerp(1.25, 1.45, ease(u))
      o.pos.copy(b).multiplyScalar(-back).addScaledVector(c, 0.28).addScaledVector(up, 0.16)
      o.target.copy(b).multiplyScalar(3).addScaledVector(c, 0.12)
      o.fov = 44
    },
  },
  {
    name: 'Arrival — Mars below', ear: 'external', start: 167, end: 172, world: 'space',
    eval: (_s, u, o) => {
      o.pos.set(lerp(0.06, 0.04, u), 0.075, 0.13)
      o.target.set(0, -0.045, 0)
      o.fov = 50
    },
  },
  {
    name: 'Entry — shock layer on the heat shield', ear: 'external', ev: -0.5, start: 172, end: 183, world: 'space',
    eval: (_s, u, o) => {
      o.pos.set(lerp(0.075, 0.055, u), 0.004, 0.11)
      o.target.set(0, -0.012, 0)
      o.fov = 44
    },
  },
  {
    name: 'Entry — plasma wake from above', ear: 'external', ev: -0.3, start: 183, end: 193, world: 'space',
    eval: (_s, u, o) => {
      o.pos.set(-0.12, lerp(0.07, 0.05, u), 0.06)
      o.target.set(0.02, -0.01, 0)
      o.fov = 44
    },
  },
  // ============================================================ MARS (m)
  {
    name: 'Belly-flop over the plains', ear: 'external', start: 193, end: 199, world: 'mars', cut: true,
    eval: (s, u, o) => {
      landerCenter(s, o.target)
      o.pos.copy(o.target).add(b.set(lerp(-70, -45, u), lerp(14, 20, u), 115))
      o.fov = 40
    },
  },
  {
    // SIGNATURE 3: side-mounted camera looking down past the heat shield at Mars below
    name: 'Side-mounted camera — Mars below', ear: 'mounted', start: 199, end: 203.3, world: 'mars',
    eval: (s, u, o) => {
      landerLocal(s, 3.9, 38, -3.9, o.pos)
      landerLocal(s, 3.3, -30, -3.6, b)
      c.subVectors(b, o.pos).normalize()
      c.lerp(Y.clone().negate(), lerp(0.3, 0.38, u)).normalize()
      o.target.copy(o.pos).add(c)
      o.fov = 72
    },
  },
  {
    name: 'The flip', ear: 'external', start: 203.3, end: 208.5, world: 'mars', cut: true,
    eval: (s, u, o) => {
      landerCenter(s, o.target)
      o.pos.copy(o.target).add(b.set(lerp(-62, -70, u), lerp(-10, -20, u), 72))
      o.fov = 46
    },
  },
  {
    name: 'Landing burn — long lens from the ground', ear: 'ground', start: 208.5, end: 214, world: 'mars',
    eval: (s, _u, o) => {
      // tracking site placed with the sun behind-left of the operator: no shooting into the sun
      o.pos.copy(LANDING_CAM)
      o.pos.y = ground(o.pos.x, o.pos.z) + 2.2
      landerCenter(s, o.target)
      o.fov = frameFov(95, o.pos.distanceTo(o.target), 5, 40)
    },
  },
  {
    name: 'Touchdown — low and close', ear: 'ground', start: 214, end: 221, world: 'mars',
    eval: (s, u, o) => {
      o.pos.set(lerp(78, 72, u), 0, lerp(86, 80, u))
      o.pos.y = ground(o.pos.x, o.pos.z) + 2.3
      o.target.set(s.landerBase.x, lerp(15, 19, u), s.landerBase.z)
      o.fov = 40
    },
  },
  {
    name: 'Finale — standing on Mars', ear: 'ground', ev: 0.1, start: 221, end: 1e9, world: 'mars',
    eval: (s, _u, o) => finalePose(s.t, o),
  },
]

/**
 * Finale: first a "rover mast-cam" photograph — 2 m high, long lens, from a few
 * hundred metres — then a slow, heavy crane out to a wide environmental view.
 */
export function finalePose(t: number, o: Pose) {
  const k = Math.min(1, Math.max(0, (t - 233) / 16))
  const e = ease(k)
  const drift = (t - 221) * 0.006
  const ang = 2.55 + drift + e * 0.5
  const r = lerp(205, 330, e)
  o.pos.set(Math.cos(ang) * r, 0, Math.sin(ang) * r)
  o.pos.y = ground(o.pos.x, o.pos.z) + lerp(3.2, 42, e)
  o.target.set(0, lerp(24, 14, e), 0)
  o.fov = lerp(19, 34, e)
}

export function idlePose(ambient: number, o: Pose) {
  const ang = 2.35 + ambient * 0.02
  const r = 520
  o.pos.set(Math.cos(ang) * r, 10, Math.sin(ang) * r)
  // keep the vehicle right of centre so the title card has room
  const right = b.set(-Math.sin(ang), 0, Math.cos(ang))
  o.target.set(0, 70, 0).addScaledVector(right, 70)
  o.fov = 28
}

export function shotIndexAt(t: number) {
  for (let i = SHOTS.length - 1; i >= 0; i--) if (t >= SHOTS[i].start) return i
  return 0
}
