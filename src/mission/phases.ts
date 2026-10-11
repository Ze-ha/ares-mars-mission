/**
 * Mission phase table — the single source of truth for the experience timeline.
 *
 * `start` is in *experience seconds* (what the viewer watches at 1× speed).
 * Real mission-elapsed time (MET) is derived separately in trajectory.ts, so
 * the ascent can play near real-time while the 6-month cruise is compressed.
 */

export type WorldId = 'earth' | 'space' | 'mars'

export interface Phase {
  id: string
  index: number
  label: string
  subtitle: string
  start: number
  /** Short label for the timeline scrubber. */
  short: string
}

const P = (id: string, label: string, short: string, subtitle: string, start: number) => ({ id, label, short, subtitle, start })

const RAW = [
  P('prelaunch', 'Pre-Launch', 'Pad', 'Terminal count · propellant load complete · vehicle venting', 0),
  P('ignition', 'Engine Ignition', 'Ignition', '33 main engines startup sequence', 16),
  P('liftoff', 'Liftoff', 'Liftoff', 'Tower clear · 7,590 tf of thrust', 20),
  P('ascent', 'Atmospheric Ascent', 'Ascent', 'Gravity turn · through Max-Q', 28),
  P('separation', 'Stage Separation', 'Staging', 'Hot staging · booster boostback', 52),
  P('orbit', 'Earth Orbit', 'Orbit', 'Parking orbit · 200 km · 7.8 km/s', 66),
  P('tmi', 'Trans-Mars Injection', 'TMI', 'Departure burn · escaping Earth', 100),
  P('cruise', 'Deep-Space Cruise', 'Cruise', '186-day heliocentric transfer · trajectory corrections', 116),
  P('approach', 'Mars Approach', 'Approach', 'Mars arrival · final targeting', 146),
  P('edl', 'Entry, Descent & Landing', 'EDL', 'Aerobraking entry at 7.5 km/s', 172),
  P('landed', 'Touchdown', 'Landed', 'Jezero Crater, Mars · beside Perseverance\'s landing site', 218),
]

export const PHASES: Phase[] = RAW.map((p, index) => ({ ...p, index }))

/** Where the experience timeline ends (the landed scene keeps living after this). */
export const TIMELINE_END = 240

/** World switch points (experience seconds). */
export const WORLD_SWITCH = { earthToSpace: 44, spaceToMars: 193 } as const

export function worldAt(t: number): WorldId {
  if (t < WORLD_SWITCH.earthToSpace) return 'earth'
  if (t < WORLD_SWITCH.spaceToMars) return 'space'
  return 'mars'
}

export function phaseIndexAt(t: number): number {
  let i = 0
  while (i < PHASES.length - 1 && t >= PHASES[i + 1].start) i++
  return i
}

export function phaseEnd(i: number) {
  return i < PHASES.length - 1 ? PHASES[i + 1].start : TIMELINE_END
}

/** Discrete mission events — shown as brief callouts in the HUD. */
export const EVENTS: { t: number; label: string }[] = [
  { t: 12, label: 'Ship quick-disconnect retract' },
  { t: 16.4, label: 'Engine startup' },
  { t: 20, label: 'Liftoff' },
  { t: 27, label: 'Tower cleared' },
  { t: 38.5, label: 'Max-Q' },
  { t: 51.6, label: 'MECO' },
  { t: 52.0, label: 'Hot staging · ship ignition' },
  { t: 52.4, label: 'Stage separation confirmed' },
  { t: 55.4, label: 'Booster flip · cold-gas thrusters' },
  { t: 63.6, label: 'Booster boostback burn' },
  { t: 72, label: 'SECO · orbit achieved' },
  { t: 101, label: 'TMI burn start' },
  { t: 114, label: 'TMI cutoff · Earth escape' },
  { t: 121, label: 'TCM-1 · attitude slew' },
  { t: 124.5, label: 'TCM-1 burn · Δv 4.2 m/s' },
  { t: 130.5, label: 'TCM-2 · attitude slew' },
  { t: 133.3, label: 'TCM-2 burn · Δv 1.1 m/s' },
  { t: 139.5, label: 'TCM-3 · attitude slew' },
  { t: 142, label: 'TCM-3 burn · Δv 0.3 m/s' },
  { t: 158, label: 'Mars in full view · 32,000 km' },
  { t: 172, label: 'Entry interface · 125 km' },
  { t: 178, label: 'Peak heating' },
  { t: 203.5, label: 'Flip maneuver · engine relight' },
  { t: 211.5, label: 'Landing legs deploy' },
  { t: 217.6, label: 'Touchdown confirmed' },
]
