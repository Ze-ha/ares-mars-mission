import { useFrame, useThree } from '@react-three/fiber'
import { useEffect } from 'react'
import { runtime, useMission } from '../mission/store'
import type { ListenerSpec } from './controls'
import { audioEngine } from './engine'
import './offline' // registers the ?audiotest hook
import { prebuildSources } from './physics'
import { exploreSky, rover, ROVER_TRUE_VMAX, TIMELAPSE } from '../explore/exploreState'
import { Vector3 } from 'three'

const CINEMATIC: ListenerSpec = { kind: 'cinematic' }
const EXPLORE: ListenerSpec = { kind: 'fixed', ear: 'ground', pos: new Vector3() }

/** Drives the realtime sound design from inside the R3F frame loop (after the camera director). */
export function AudioMount() {
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    // the context can only start from a user gesture
    const unlock = () => {
      if (useMission.getState().audioOn) audioEngine.unlock()
    }
    window.addEventListener('pointerdown', unlock, true)
    window.addEventListener('keydown', unlock, true)
    // warm the source table in idle slices so the first seconds never hitch
    let id = 0
    const warm = () => {
      if (!prebuildSources(4)) id = window.setTimeout(warm, 30)
    }
    id = window.setTimeout(warm, 1500)
    return () => {
      window.removeEventListener('pointerdown', unlock, true)
      window.removeEventListener('keydown', unlock, true)
      clearTimeout(id)
    }
  }, [])

  useFrame(() => {
    const m = useMission.getState()
    if (m.exploring) {
      // rover traverse: Mars air around the camera; the rover heard up close on the mast, faintly from the chase camera
      ;(EXPLORE as { pos: Vector3 }).pos.copy(camera.position)
      const v = Math.min(1, Math.abs(rover.speed) / (ROVER_TRUE_VMAX * TIMELAPSE))
      const onMast = rover.view === 'mast'
      const near = onMast ? 1 : Math.min(1, 6 / Math.max(6, camera.position.distanceTo(rover.pos))) * 0.35
      audioEngine.frame(runtime.state.t, runtime.state, EXPLORE, {
        active: m.audioOn && !m.filming,
        speed: 1,
        volume: 1,
        seekNonce: runtime.seekNonce,
        override: (c) => {
          c.servo = 0.35 * v * near
          c.grit = 0.4 * v * near
          c.dust = 0.05 * v * near
          c.wind = 0.06 * (1 - 0.5 * exploreSky.night)
          c.windLP = 380
          c.systems = onMast ? 0.02 : 0
        },
      })
      return
    }
    const spec: ListenerSpec = m.cameraMode === 'free' ? { kind: 'free', pos: camera.position } : CINEMATIC
    const active = m.audioOn && !m.filming && (m.status === 'running' || m.status === 'complete')
    audioEngine.frame(runtime.state.t, runtime.state, spec, { active, speed: m.status === 'complete' ? 1 : m.speed, volume: 1, seekNonce: runtime.seekNonce })
  })
  return null
}
