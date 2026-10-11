import { Vector3 } from 'three'
import { VEHICLE } from '../mission/constants'
import { createMissionState, sampleMission } from '../mission/trajectory'
import { smoothstep } from '../utils/math'

/**
 * Acoustic physics shared by the realtime engine and the offline renderer:
 * the propagation medium (Earth / Mars air, vacuum) and a lazily built table of
 * the sound *sources* over mission time, so retarded-time lookups (what the
 * vehicle was doing d/c seconds ago) stay cheap.
 */

export type Planet = 'earth' | 'mars'
const RHO0 = 1.225

export interface Medium {
  planet: Planet
  /** density kg/m³ */
  rho: number
  /** density relative to Earth sea level */
  rhoN: number
  /** speed of sound m/s */
  c: number
  /** airborne coupling gain (0 in vacuum) */
  gain: number
}

/** Earth: 8.5 km scale height. Mars: thin CO2, ~0.020 kg/m³ at Jezero, 11.1 km scale height. */
export function mediumAt(planet: Planet, hKm: number, out: Medium): Medium {
  const h = Math.max(0, hKm)
  out.planet = planet
  if (planet === 'earth') {
    out.rho = 1.225 * Math.exp(-h / 8.5)
    out.c = 343
  } else {
    out.rho = 0.02 * Math.exp(-h / 11.1)
    out.c = 240
  }
  out.rhoN = out.rho / RHO0
  // radiated pressure ∝ sqrt(ρc); physical dB differences are applied at ~55% (film-mix dynamic range),
  // and the path fades to true silence where air becomes too thin to carry sound
  const taper = planet === 'earth' ? 1 - smoothstep(30, 62, h) : 1 - smoothstep(55, 100, h)
  out.gain = Math.pow(out.rhoN, 0.28) * taper
  return out
}
export const makeMedium = (): Medium => ({ planet: 'earth', rho: 0, rhoN: 0, c: 343, gain: 0 })

/**
 * Air absorption as a low-pass cutoff (Hz) for a path of `d` metres.
 * Earth: classical + O2/N2 relaxation (≈ 30 dB/km at 4 kHz) — cutoff scales with √ρ in thin air.
 * Mars: CO2 relaxation kills everything above a few hundred Hz within tens of metres.
 */
export function absorptionHz(m: Medium, d: number) {
  if (m.planet === 'earth') {
    const f = 16000 * Math.pow(Math.max(d, 50) / 50, -0.6) * Math.sqrt(Math.min(1, Math.max(m.rhoN, 1e-4)))
    return Math.min(16000, Math.max(160, f))
  }
  const f = 5200 * Math.pow(Math.max(d, 8) / 10, -0.65)
  return Math.min(9000, Math.max(110, f))
}

/** Aerodynamic noise level from dynamic pressure q (Pa); 1 ≈ 35 kPa (a real Max-Q), soft-limited. */
export function aeroLevel(q: number, planet: Planet) {
  const x = Math.pow(Math.max(q, 0) / 35000, 0.6)
  return 1.4 * Math.tanh(x / 1.4) * (planet === 'mars' ? 1.8 : 1)
}

// ---------------------------------------------------------------- source table
/** Engine-noise centroid sits a few metres into the plume, below the engine plane. */
const PLUME = 8
const HZ = 20
const T_MAX = 300
const N = T_MAX * HZ + 2
const COLS = ['ex', 'ey', 'ez', 'mx', 'my', 'mz', 'sx', 'sy', 'sz', 'bThr', 'bBack', 'sSL', 'sVac', 'alt', 'vel', 'plasma', 'glow', 'dust', 'landerAlt', 'venting'] as const
type Col = (typeof COLS)[number]
const table = Object.fromEntries(COLS.map((c) => [c, new Float32Array(N)])) as Record<Col, Float32Array>
const built = new Uint8Array(Math.ceil(N / HZ))
const scratch = createMissionState()
const Y = new Vector3(0, 1, 0)
const v = new Vector3()

function buildChunk(k: number) {
  if (built[k]) return
  built[k] = 1
  for (let i = k * HZ; i < Math.min(N, (k + 1) * HZ); i++) {
    const s = sampleMission(i / HZ, scratch)
    v.copy(Y).applyQuaternion(s.stackQuat)
    table.ex[i] = s.stackBase.x - v.x * PLUME
    table.ey[i] = s.stackBase.y - v.y * PLUME
    table.ez[i] = s.stackBase.z - v.z * PLUME
    v.copy(Y).applyQuaternion(s.landerQuat)
    table.mx[i] = s.landerBase.x - v.x * PLUME
    table.my[i] = s.landerBase.y - v.y * PLUME
    table.mz[i] = s.landerBase.z - v.z * PLUME
    // ship engine plane in the space world (km, ship centre at the origin)
    v.set(0, -VEHICLE.shipLength / 2 - PLUME, 0).applyQuaternion(s.shipQuat).multiplyScalar(0.001)
    table.sx[i] = v.x
    table.sy[i] = v.y
    table.sz[i] = v.z
    table.bThr[i] = s.boosterThrottle
    table.bBack[i] = s.boosterBoostback
    table.sSL[i] = s.shipThrottleSL
    table.sVac[i] = s.shipThrottleVac
    table.alt[i] = s.altitudeKm
    table.vel[i] = s.velocity
    table.plasma[i] = s.plasma
    table.glow[i] = s.tileGlow
    table.dust[i] = s.dust
    table.landerAlt[i] = Math.max(0, s.landerBase.y - VEHICLE.legReach)
    table.venting[i] = s.venting
  }
}

export type SourceSample = { t: number } & Record<Col, number>
export const makeSource = (): SourceSample => Object.fromEntries([['t', 0], ...COLS.map((c) => [c, 0])]) as SourceSample

/** Linearly interpolated source state at time t (deterministic, cached at 20 Hz). */
export function sourceAt(t: number, out: SourceSample): SourceSample {
  const x = Math.min(Math.max(t, 0), T_MAX) * HZ
  const i = Math.min(Math.floor(x), N - 2)
  const f = x - i
  buildChunk(Math.floor(i / HZ))
  buildChunk(Math.floor((i + 1) / HZ))
  out.t = t
  for (const c of COLS) out[c] = table[c][i] * (1 - f) + table[c][i + 1] * f
  return out
}

/** Builds table chunks within a time budget (ms); returns true when complete. Used during idle time. */
export function prebuildSources(budgetMs: number) {
  const t0 = performance.now()
  for (let k = 0; k < built.length; k++) {
    if (built[k]) continue
    buildChunk(k)
    if (performance.now() - t0 > budgetMs) return false
  }
  return true
}
