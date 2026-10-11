import { create } from 'zustand'
import { createMissionState, sampleMission, type MissionState } from './trajectory'
import { TIMELINE_END, type WorldId } from './phases'

export type Status = 'idle' | 'running' | 'paused' | 'complete'
export type CameraMode = 'cinematic' | 'free'
export type Focus = 'vehicle' | 'earth' | 'mars'
export type Quality = 'low' | 'medium' | 'high' | 'ultra'

/**
 * Two layers of state:
 *
 *  1. `runtime` — a plain mutable object written every frame by the mission
 *     clock and read by every animated component inside useFrame. It never
 *     triggers React renders (this is what keeps 60 fps with a rich scene).
 *
 *  2. `useMission` — a small zustand store for UI-level state (play/pause,
 *     camera mode, toggles, current world/phase). It only changes on user
 *     action or at phase/world boundaries, so React re-renders are rare.
 */
export const runtime = {
  t: 0,
  /** wall-clock seconds that keep ticking while idle (ocean, venting, idle camera) */
  ambient: 0,
  state: sampleMission(0, createMissionState()) as MissionState,
  /** set by seek(); tells the camera director to cut instead of blend */
  seekNonce: 0,
  /** incremented whenever the user grabs the camera */
  userInteractNonce: 0,
  /** current camera exposure offset (stops), eased by the director */
  exposureEV: 0,
  /** film render: fixed timestep override (seconds) when rendering offline */
  fixedDt: 0,
}

interface MissionStore {
  status: Status
  speed: number
  cameraMode: CameraMode
  focus: Focus
  showTelemetry: boolean
  cinematic: boolean
  quality: Quality
  world: WorldId
  /** offline film render in progress */
  filming: boolean
  /** post-landing rover exploration */
  exploring: boolean
  /** explore mode: night requested (the sky animates toward it) */
  night: boolean
  /** explore mode: sunset requested (sun a couple of degrees above the rim) */
  sunset: boolean
  setExploring: (on: boolean) => void
  toggleNight: () => void
  toggleSunset: () => void
  /** sound on/off (?mute=1 starts muted) */
  audioOn: boolean
  toggleAudio: () => void
  phase: number
  start: () => void
  togglePause: () => void
  restart: () => void
  seek: (t: number) => void
  setSpeed: (s: number) => void
  setCameraMode: (m: CameraMode) => void
  setFocus: (f: Focus) => void
  toggleTelemetry: () => void
  toggleCinematic: () => void
  setQuality: (q: Quality) => void
  /** called by the clock when the sampled world/phase changes */
  _sync: (world: WorldId, phase: number) => void
  _complete: () => void
}

const initialQuality = (): Quality => {
  const q = new URLSearchParams(location.search).get('quality')
  if (q === 'low' || q === 'medium' || q === 'high' || q === 'ultra') return q
  return 'high'
}

export const useMission = create<MissionStore>((set, get) => ({
  status: 'idle',
  speed: 1,
  cameraMode: 'cinematic',
  focus: 'vehicle',
  showTelemetry: true,
  cinematic: false,
  quality: initialQuality(),
  filming: false,
  exploring: false,
  night: false,
  sunset: false,
  audioOn: !new URLSearchParams(location.search).has('mute'),
  toggleAudio: () => set({ audioOn: !get().audioOn }),
  world: 'earth',
  phase: 0,
  start: () => {
    runtime.t = 0
    runtime.seekNonce++
    set({ status: 'running', cameraMode: 'cinematic' })
  },
  togglePause: () => {
    const s = get().status
    if (s === 'running') set({ status: 'paused' })
    else if (s === 'paused') set({ status: 'running' })
    else if (s === 'idle') get().start()
    else if (s === 'complete') get().restart()
  },
  restart: () => {
    runtime.t = 0
    runtime.seekNonce++
    set({ status: 'running', cameraMode: 'cinematic', focus: 'vehicle' })
  },
  seek: (t) => {
    runtime.t = Math.max(0, Math.min(TIMELINE_END, t))
    runtime.seekNonce++
    const st = get().status
    set({ status: st === 'idle' || st === 'complete' ? 'running' : st, focus: 'vehicle' })
  },
  setSpeed: (speed) => set({ speed }),
  setCameraMode: (cameraMode) => set({ cameraMode }),
  setFocus: (focus) => set({ focus, cameraMode: 'free' }),
  toggleTelemetry: () => set({ showTelemetry: !get().showTelemetry }),
  toggleCinematic: () => set({ cinematic: !get().cinematic }),
  setQuality: (quality) => set({ quality }),
  _sync: (world, phase) => set({ world, phase }),
  setExploring: (on) => {
    if (on) {
      runtime.t = TIMELINE_END
      runtime.seekNonce++
      set({ exploring: true, status: 'complete', cameraMode: 'cinematic', night: false, sunset: false })
    } else set({ exploring: false, night: false, sunset: false })
  },
  toggleNight: () => set({ night: !get().night, sunset: false }),
  toggleSunset: () => set({ sunset: !get().sunset, night: false }),
  _complete: () => set({ status: 'complete' }),
}))

/** Quality presets — every expensive knob lives here. */
export const QUALITY = {
  low: { dpr: 0.75, shadowMap: 1024, atmoSteps: 8, atmoLightSteps: 3, particles: 0.45, bloom: true, haze: false, terrainRes: 0.55 },
  medium: { dpr: 1, shadowMap: 2048, atmoSteps: 12, atmoLightSteps: 4, particles: 0.75, bloom: true, haze: true, terrainRes: 0.8 },
  high: { dpr: 1.5, shadowMap: 4096, atmoSteps: 16, atmoLightSteps: 6, particles: 1, bloom: true, haze: true, terrainRes: 1 },
  /** for a discrete GPU: native-resolution rendering, 8K shadows, finer terrain and sky */
  ultra: { dpr: 2, shadowMap: 8192, atmoSteps: 24, atmoLightSteps: 8, particles: 1.25, bloom: true, haze: true, terrainRes: 1.35 },
} as const
