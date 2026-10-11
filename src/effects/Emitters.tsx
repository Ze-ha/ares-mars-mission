import { useMemo } from 'react'
import { Color, Quaternion, Vector3 } from 'three'
import { MOUNT_HEIGHT, VEHICLE } from '../mission/constants'
import { runtime } from '../mission/store'
import { createMissionState, RCS_EVENTS, sampleMission, SHUTDOWNS } from '../mission/trajectory'
import { Emitter, type EmitterConfig } from './Particles'

/**
 * All particle emitters, configured per world. Trajectory-dependent emitters
 * query the pure mission function at each particle's spawn time, so the smoke
 * trail lies exactly where the rocket actually was.
 */

const probe = createMissionState()

// ------------------------------------------------------------ Earth launch site
export function LaunchSmoke() {
  const cfgs = useMemo<EmitterConfig[]>(() => {
    const deluge: EmitterConfig = {
      id: 'deluge',
      split: true,
      count: 1500,
      seed: 21,
      color: new Color(0.84, 0.82, 0.8),
      opacity: 0.9,
      drag: 0.26,
      buoyancy: 1.9,
      wind: new Vector3(2.8, 0, 1.2),
      groundY: 0,
      build: (u, r) => {
        const spawn = 16.6 + 17 * Math.pow(u, 1.7)
        const a = r() * Math.PI * 2
        const lifted = Math.max(0, spawn - 20)
        const speed = (22 + 60 * r()) * (1 - Math.min(lifted / 14, 0.6))
        const r0 = 5 + r() * 7
        return {
          spawn,
          life: 14 + 16 * r(),
          origin: [Math.cos(a) * r0, 3 + r() * 5, Math.sin(a) * r0],
          vel: [Math.cos(a) * speed, 2 + r() * 12, Math.sin(a) * speed],
          size0: 6 + 6 * r(),
          size1: 34 + 42 * r(),
        }
      },
    }
    // plume wash rising up around the vehicle at liftoff
    const billow: EmitterConfig = {
      id: 'billow',
      split: true,
      count: 500,
      seed: 22,
      color: new Color(0.86, 0.84, 0.82),
      opacity: 0.75,
      drag: 0.5,
      buoyancy: 2.6,
      wind: new Vector3(2.5, 0, 1),
      groundY: 0,
      build: (u, r) => {
        const spawn = 17.5 + 9 * u
        const a = r() * Math.PI * 2
        const r0 = 14 + r() * 20
        return {
          spawn,
          life: 10 + 10 * r(),
          origin: [Math.cos(a) * r0, 4 + r() * 10, Math.sin(a) * r0],
          vel: [Math.cos(a) * 10, 10 + r() * 16, Math.sin(a) * 10],
          size0: 10,
          size1: 40 + 30 * r(),
        }
      },
    }
    // exhaust column left behind the ascending vehicle
    const trail: EmitterConfig = {
      id: 'trail',
      billow: 0.6,
      split: true,
      count: 700,
      seed: 23,
      color: new Color(0.9, 0.88, 0.86),
      opacity: 0.38,
      drag: 0.6,
      buoyancy: 0.3,
      wind: new Vector3(3, 0, 1.5),
      groundY: 0,
      build: (u, r) => {
        const spawn = 20.5 + 14 * Math.pow(u, 1.2)
        sampleMission(spawn, probe)
        const b = probe.stackBase
        const axis = new Vector3(0, 1, 0).applyQuaternion(probe.stackQuat)
        const h = b.y - MOUNT_HEIGHT
        const back = Math.min(60 + h * 0.2, 140) * (0.3 + 0.7 * r())
        const o = b.clone().addScaledVector(axis, -back)
        const spread = 3 + Math.min(h * 0.02, 20)
        return {
          spawn,
          life: 9 + 10 * r(),
          origin: [o.x + (r() - 0.5) * spread, Math.max(o.y, 4), o.z + (r() - 0.5) * spread],
          vel: [(r() - 0.5) * 8 - axis.x * 12, -6 * r(), (r() - 0.5) * 8],
          size0: 6 + h * 0.004,
          size1: 26 + Math.min(h * 0.03, 70) + 20 * r(),
        }
      },
      master: () => (runtime.t < 36 ? 1 : 1 - Math.min((runtime.t - 36) / 6, 1)),
    }
    // cryogenic boil-off venting (ambient loop while on the pad)
    const vents: [Vector3, Vector3][] = [
      [new Vector3(4.7, MOUNT_HEIGHT + 60, 0.5), new Vector3(1, -0.2, 0)],
      [new Vector3(-4.7, MOUNT_HEIGHT + 38, -0.5), new Vector3(-1, -0.2, 0)],
      [new Vector3(0, MOUNT_HEIGHT + 69.5, 4.7), new Vector3(0, -0.1, 1)],
      [new Vector3(3.2, MOUNT_HEIGHT + 71 + 28, 3.2), new Vector3(0.7, -0.2, 0.7)],
      [new Vector3(-3.3, MOUNT_HEIGHT + 71 + 44, 2.4), new Vector3(-0.8, 0, 0.6)],
      [new Vector3(7.5, MOUNT_HEIGHT - 1.5, 4.5), new Vector3(0.6, -0.4, 0.4)],
      [new Vector3(-6, MOUNT_HEIGHT - 2, -6), new Vector3(-0.5, -0.5, -0.5)],
    ]
    const venting: EmitterConfig = {
      id: 'venting',
      billow: 0.35,
      count: 1800,
      seed: 24,
      color: new Color(0.95, 0.97, 1.0),
      opacity: 0.32,
      drag: 0.9,
      buoyancy: -0.35,
      wind: new Vector3(1.6, 0, 0.8),
      loop: 6,
      groundY: 0,
      build: (u, r) => {
        const [p, d] = vents[Math.floor(r() * vents.length)]
        // a cold, dense jet: shoots out a few metres, then streams down the tank wall in wisps
        const sp = 2.5 + r() * 4
        return {
          spawn: r() * 6,
          life: 2.2 + r() * 2.8,
          origin: [p.x + (r() - 0.5) * 0.6, p.y + (r() - 0.5) * 1.2, p.z + (r() - 0.5) * 0.6],
          vel: [d.x * sp + (r() - 0.5) * 0.6, d.y * sp - 1.5 - r() * 2, d.z * sp + (r() - 0.5) * 0.6],
          size0: 0.35 + 0.5 * r(),
          size1: 2.2 + r() * 3.2,
        }
      },
      master: () => runtime.state.venting,
    }
    return [deluge, billow, trail, venting]
  }, [])
  return (
    <>
      {cfgs.map((c) => (
        <Emitter key={c.id} config={c} />
      ))}
    </>
  )
}

// ------------------------------------------------------------ space: staging
export function StagingEffects() {
  const cfgs = useMemo<EmitterConfig[]>(() => {
    const km = 0.001
    // hot staging: the ship's engines fire into the vented interstage — a brief ring of flame and gas
    const hot: EmitterConfig = {
      id: 'hotstage',
      // in vacuum the gas free-expands into a thin translucent fan — no convective billows
      billow: 0.2,
      count: 170,
      seed: 31,
      color: new Color(0.5, 0.46, 0.43),
      opacity: 0.4,
      drag: 1.2,
      buoyancy: 0,
      emissive: 1.1,
      build: (u, r) => {
        const spawn = 52.0 + 1.2 * Math.pow(u, 1.2)
        sampleMission(spawn, probe)
        const b = probe.booster
        const axis = new Vector3(0, 1, 0).applyQuaternion(b.quat)
        const top = b.pos.clone().addScaledVector(axis, (VEHICLE.boosterLength - 0.9) * km)
        const a = r() * Math.PI * 2
        const side = new Vector3(Math.cos(a), 0, Math.sin(a)).applyQuaternion(b.quat)
        const sp = (45 + 70 * r()) * km
        const o = top.clone().addScaledVector(side, VEHICLE.radius * km)
        return {
          spawn,
          life: 0.8 + 1.2 * r(),
          origin: [o.x, o.y, o.z],
          vel: [side.x * sp - axis.x * 0.012, side.y * sp - axis.y * 0.012, side.z * sp - axis.z * 0.012],
          size0: 0.0025,
          size1: 0.008 + 0.006 * r(),
        }
      },
    }
    // ---- reaction control: every jet comes from the same firing schedule that turns the vehicles
    interface Jet { t: number; origin: Vector3; dir: Vector3 }
    const jets: Jet[] = []
    const Yv = new Vector3(0, 1, 0)
    const inv = new Quaternion()
    for (const e of RCS_EVENTS) {
      // pulsed firing: short valve openings, not a continuous stream
      const pulseLen = e.kind === 'ullage' ? 0.28 : 0.1
      const gap = e.kind === 'ullage' ? 0.06 : 0.16
      for (let t = e.t0; t < e.t1; t += pulseLen + gap) {
        sampleMission(t, probe)
        if (e.vehicle === 'booster') {
          const q = probe.booster.quat
          inv.copy(q).invert()
          const axisL = e.axis!.clone().applyQuaternion(inv)
          const g = axisL.clone().cross(Yv).multiplyScalar(-(e.sense ?? 1)).normalize()
          const pL = g.clone().multiplyScalar(VEHICLE.radius + 0.2).add(new Vector3(0, 66.5, 0))
          jets.push({ t, origin: pL.multiplyScalar(km).applyQuaternion(q).add(probe.booster.pos), dir: g.applyQuaternion(q) })
          continue
        }
        const q = probe.shipQuat
        inv.copy(q).invert()
        const half = VEHICLE.shipLength / 2
        if (e.kind === 'ullage') {
          // forward thrust to settle propellant: aft thrusters exhaust rearward
          for (const sx of [-1, 1]) {
            const pL = new Vector3(sx * (VEHICLE.radius + 0.2), 3 - half, 1.2)
            const dL = new Vector3(sx * 0.25, -1, 0).normalize()
            jets.push({ t, origin: pL.multiplyScalar(km).applyQuaternion(q), dir: dL.applyQuaternion(q) })
          }
          continue
        }
        const axisL = e.axis!.clone().applyQuaternion(inv)
        // a couple: fore and aft thrusters on opposite sides produce pure torque about the axis
        for (const end of [1, -1]) {
          const r = Yv.clone().multiplyScalar(end)
          const g = axisL.clone().cross(r).multiplyScalar(-(e.sense ?? 1)).normalize()
          if (!Number.isFinite(g.x) || g.lengthSq() < 0.5) continue
          const pL = g.clone().multiplyScalar(VEHICLE.radius + 0.2).addScaledVector(r, half - 3)
          jets.push({ t, origin: pL.multiplyScalar(km).applyQuaternion(q), dir: g.applyQuaternion(q) })
          if (e.kind === 'trim') break
        }
      }
    }
    const PER_JET = 46
    const rcs: EmitterConfig = {
      id: 'rcs-jets',
      // in vacuum the gas free-expands into a thin translucent fan — no convective billows
      billow: 0.1,
      count: Math.max(8, jets.length * PER_JET),
      seed: 32,
      color: new Color(0.95, 0.97, 1.0),
      opacity: 0.55,
      drag: 0.0,
      buoyancy: 0,
      build: (u, r) => {
        const j = jets[Math.min(jets.length - 1, Math.floor(u * jets.length))]
        if (!j) return { spawn: -1e9, life: 0.01, origin: [0, 0, 0], vel: [0, 0, 0], size0: 0, size1: 0 }
        // narrow cone (~12°), fast (N2 at ~0.25 km/s), gone in a fraction of a second
        const spread = new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(0.3)
        const d = j.dir.clone().add(spread).normalize().multiplyScalar(0.17 + 0.12 * r()) // km/s
        // a fine spray, not a cloud: small particles, gone within ~0.3 s and ~80 m
        return { spawn: j.t + r() * 0.1, life: 0.1 + 0.2 * r(), origin: [j.origin.x, j.origin.y, j.origin.z], vel: [d.x, d.y, d.z], size0: 0.00025, size1: 0.0018 + 0.0014 * r() }
      },
    }
    const rcsIce: EmitterConfig = {
      id: 'rcs-ice',
      count: Math.max(8, jets.length * 4),
      seed: 34,
      color: new Color(1, 1, 1),
      opacity: 1,
      drag: 0,
      buoyancy: 0,
      sparkle: true,
      build: (u, r) => {
        const j = jets[Math.min(jets.length - 1, Math.floor(u * jets.length))]
        if (!j) return { spawn: -1e9, life: 0.01, origin: [0, 0, 0], vel: [0, 0, 0], size0: 0, size1: 0 }
        const d = j.dir.clone().add(new Vector3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(0.9)).normalize().multiplyScalar(0.004 + 0.01 * r())
        return { spawn: j.t + r() * 0.15, life: 1.2 + 1.8 * r(), origin: [j.origin.x, j.origin.y, j.origin.z], vel: [d.x, d.y, d.z], size0: 0.00035, size1: 0.0003 }
      },
    }
    // ---- engine shutdown: a puff of frozen propellant drifts off the nozzles and glints in the sun
    const snow: EmitterConfig = {
      id: 'shutdown-snow',
      // in vacuum the gas free-expands into a thin translucent fan — no convective billows
      billow: 0.1,
      count: SHUTDOWNS.length * 55,
      seed: 35,
      color: new Color(1, 1, 1),
      opacity: 1,
      drag: 0.05,
      buoyancy: 0,
      sparkle: true,
      build: (u, r) => {
        const t = SHUTDOWNS[Math.min(SHUTDOWNS.length - 1, Math.floor(u * SHUTDOWNS.length))] + r() * 0.5
        sampleMission(t, probe)
        const q = probe.shipQuat
        const a = r() * Math.PI * 2
        const rr = r() * 3.2
        const pL = new Vector3(Math.cos(a) * rr, -VEHICLE.shipLength / 2 - 1, Math.sin(a) * rr)
        const dL = new Vector3((r() - 0.5) * 0.9, -0.3 - r(), (r() - 0.5) * 0.9).normalize().multiplyScalar(0.004 + 0.012 * r())
        const o = pL.multiplyScalar(km).applyQuaternion(q)
        const d = dL.applyQuaternion(q)
        return { spawn: t, life: 2.5 + 3.5 * r(), origin: [o.x, o.y, o.z], vel: [d.x, d.y, d.z], size0: 0.00022, size1: 0.00018 }
      },
    }
    void rcs // the gas itself is drawn as pulsed jet cones (RcsJets); particles carry only the ice glints
    return [hot, rcsIce, snow]
  }, [])
  return (
    <>
      {cfgs.map((c) => (
        <Emitter key={c.id} config={c} />
      ))}
    </>
  )
}

// ------------------------------------------------------------ Mars: landing dust
/**
 * Plume–surface interaction at ~7 mbar. The thin CO2 barely drags on the grains,
 * so the jet throws a fast, low radial sheet that runs out a few hundred metres
 * instead of billowing; there is little buoyant rise. After engine cut-off no new
 * dust is lifted and the fine fraction settles and drifts downwind.
 */
export function LandingDust() {
  const cfgs = useMemo<EmitterConfig[]>(() => {
    const ONSET = 170 // m: jet starts eroding the regolith
    const erosion = (t: number) => {
      sampleMission(t, probe)
      const alt = Math.max(0, probe.landerBase.y - VEHICLE.legReach)
      return { alt, k: Math.pow(1 - Math.min(alt / ONSET, 1), 1.3) * Math.min(1, probe.shipThrottleSL * 1.6) }
    }
    const sheet: EmitterConfig = {
      id: 'dust-sheet',
      billow: 0.2,
      split: true,
      count: 2600,
      seed: 41,
      color: new Color(0.5, 0.38, 0.28),
      opacity: 0.5,
      drag: 0.45,
      buoyancy: -0.2,
      wind: new Vector3(1.0, 0, -0.5),
      groundY: 0,
      build: (u, r) => {
        const spawn = 211.0 + 6.65 * Math.pow(u, 0.7)
        const { alt, k } = erosion(spawn)
        const a = r() * Math.PI * 2
        // leaves the ground at the edge of the impingement zone
        const r0 = 2.5 + alt * 0.12 + r() * 3
        const sp = (55 + 115 * r()) * (0.3 + 0.7 * k)
        return {
          spawn,
          life: 4.5 + 7 * r(),
          origin: [probe.landerBase.x + Math.cos(a) * r0, 0.3 + r() * 0.8, probe.landerBase.z + Math.sin(a) * r0],
          vel: [Math.cos(a) * sp, (0.6 + r() * 3.2) * (0.5 + k), Math.sin(a) * sp],
          size0: (0.6 + 1.4 * r()) * (0.4 + 0.6 * k),
          size1: (6 + 12 * r()) * (0.35 + 0.65 * k),
        }
      },
    }
    // a shallow turbulent roll where the wall jet separates: low, not a tall column
    const roll: EmitterConfig = {
      id: 'dust-roll',
      billow: 0.45,
      split: true,
      count: 340,
      seed: 42,
      color: new Color(0.54, 0.41, 0.3),
      opacity: 0.45,
      drag: 0.9,
      buoyancy: 0.22,
      wind: new Vector3(1.2, 0, -0.6),
      groundY: 0,
      build: (u, r) => {
        const spawn = 213.2 + 4.5 * Math.pow(u, 0.8)
        const { alt, k } = erosion(spawn)
        const a = r() * Math.PI * 2
        const r0 = 4 + alt * 0.1 + r() * 10
        const sp = 8 + 16 * r()
        return {
          spawn,
          life: 6 + 6 * r(),
          origin: [probe.landerBase.x + Math.cos(a) * r0, 0.5 + r() * 1.5, probe.landerBase.z + Math.sin(a) * r0],
          vel: [Math.cos(a) * sp, (1.5 + r() * 4) * k, Math.sin(a) * sp],
          size0: 2.5,
          size1: (9 + 10 * r()) * (0.4 + 0.6 * k),
        }
      },
    }
    // the fine fraction that stays aloft after cut-off, settling and drifting downwind
    const settle: EmitterConfig = {
      id: 'dust-settle',
      billow: 0.1,
      count: 300,
      seed: 43,
      color: new Color(0.58, 0.45, 0.34),
      opacity: 0.12,
      drag: 0.6,
      buoyancy: -0.07,
      wind: new Vector3(1.6, 0, -0.9),
      groundY: 0,
      build: (u, r) => {
        const spawn = 215.5 + 3.5 * u
        const a = r() * Math.PI * 2
        const r0 = 12 + Math.pow(r(), 0.7) * 110
        return {
          spawn,
          life: 16 + 16 * r(),
          origin: [Math.cos(a) * r0, 1 + r() * 6, Math.sin(a) * r0],
          vel: [Math.cos(a) * 6 * r(), 0.5 + r() * 1.2, Math.sin(a) * 6 * r()],
          size0: 8,
          size1: 24 + 20 * r(),
        }
      },
    }
    return [sheet, roll, settle]
  }, [])
  return (
    <>
      {cfgs.map((c) => (
        <Emitter key={c.id} config={c} />
      ))}
    </>
  )
}
