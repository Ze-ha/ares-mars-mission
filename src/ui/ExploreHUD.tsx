import { useEffect, useRef } from 'react'
import { useMission } from '../mission/store'
import { exploreSky, nightCameraYaw, sunsetCameraYaw, resetExploreSky, resetRover, rover, ROVER_TRUE_VMAX, TIMELAPSE } from '../explore/exploreState'

/** Rover explore mode HUD: honest readouts (true speed, time-lapse), view and sky toggles, touch drive pad. */
export function ExploreHUD() {
  const night = useMission((s) => s.night)
  const sunset = useMission((s) => s.sunset)
  const refs = {
    speed: useRef<HTMLSpanElement>(null),
    odo: useRef<HTMLSpanElement>(null),
    ship: useRef<HTMLSpanElement>(null),
    hdg: useRef<HTMLSpanElement>(null),
    time: useRef<HTMLSpanElement>(null),
    earth: useRef<HTMLSpanElement>(null),
    note: useRef<HTMLDivElement>(null),
    view: useRef<HTMLButtonElement>(null),
  }
  useEffect(() => {
    let id = 0
    const set = (r: React.RefObject<HTMLElement | null>, v: string) => {
      if (r.current && r.current.textContent !== v) r.current.textContent = v
    }
    const loop = () => {
      const v = Math.abs(rover.speed) / TIMELAPSE
      set(refs.speed, `${(v * 100).toFixed(1)} cm/s`)
      set(refs.odo, rover.odometer < 1000 ? `${rover.odometer.toFixed(0)} m` : `${(rover.odometer / 1000).toFixed(2)} km`)
      set(refs.ship, `${Math.max(0, Math.hypot(rover.pos.x, rover.pos.z) - 5).toFixed(0)} m`)
      const deg = (((Math.atan2(Math.sin(rover.heading), -Math.cos(rover.heading)) * 180) / Math.PI) + 360) % 360
      const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
      set(refs.hdg, `${deg.toFixed(0).padStart(3, '0')}° ${dirs[Math.round(deg / 45) % 8]}`)
      const d = exploreSky.date
      set(refs.time, `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`)
      const el = (Math.asin(Math.max(-1, Math.min(1, exploreSky.earth.y))) * 180) / Math.PI
      set(refs.earth, el > 0 ? `${el.toFixed(0)}° up · mag ${exploreSky.earthMag.toFixed(1)}` : 'below horizon')
      set(refs.note, rover.blocked)
      set(refs.view, rover.view === 'chase' ? 'Mastcam view' : 'Chase view')
      id = requestAnimationFrame(loop)
    }
    id = requestAnimationFrame(loop)
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyN') toggleNight()
      if (e.code === 'KeyB') toggleSunset()
      if (e.code === 'Escape') exit()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(id)
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // going to night: lower the camera toward the horizon so the sky fills the frame
  function toggleNight() {
    const m = useMission.getState()
    if (!m.night && rover.view === 'chase') {
      rover.camPitch = -0.12
      rover.camYaw = nightCameraYaw()
      rover.camDist = Math.max(rover.camDist, 11)
    }
    else if (m.night) rover.lookUp = 0
    m.toggleNight()
  }
  // sunset: turn to face the low sun, camera near the ground so the rover stands against the glow
  function toggleSunset() {
    const m = useMission.getState()
    if (!m.sunset && rover.view === 'chase') {
      rover.camPitch = 0.05
      rover.camYaw = sunsetCameraYaw()
      rover.camDist = Math.max(rover.camDist, 9)
    } else if (m.sunset) rover.lookUp = 0
    m.toggleSunset()
  }
  const exit = () => {
    useMission.getState().setExploring(false)
    resetExploreSky()
    resetRover()
  }
  const hold = (fwd: number, turn: number) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      rover.input.fwd = fwd
      rover.input.turn = turn
    },
    onPointerUp: () => {
      rover.input.fwd = 0
      rover.input.turn = 0
    },
    onPointerCancel: () => {
      rover.input.fwd = 0
      rover.input.turn = 0
    },
  })

  return (
    <div className="explore">
      <header className="phase-block">
        <div className="kicker">Surface operations · Jezero Crater</div>
        <h2 className="phase-title">Rover traverse</h2>
        <div className="phase-sub">NASA Perseverance model on the real HiRISE terrain · true speed shown ×{TIMELAPSE}</div>
      </header>
      <div className="ctl-group explore-ctl">
        <button ref={refs.view} className="ctl" onClick={() => (rover.view = rover.view === 'chase' ? 'mast' : 'chase')}>Mastcam view</button>
        <button className={`ctl ${sunset ? 'on' : ''}`} onClick={toggleSunset}>Sunset</button>
        <button className={`ctl ${night ? 'on' : ''}`} onClick={toggleNight}>Night sky</button>
        <button className="ctl" onClick={exit}>Back to mission</button>
      </div>
      <footer className="explore-foot">
        <dl className="readouts explore-read">
          <div><dt>Speed</dt><dd ref={refs.speed} className="mono" /></div>
          <div><dt>Driven</dt><dd ref={refs.odo} className="mono" /></div>
          <div><dt>To Starship</dt><dd ref={refs.ship} className="mono" /></div>
          <div><dt>Heading</dt><dd ref={refs.hdg} className="mono" /></div>
          <div><dt>Time</dt><dd ref={refs.time} className="mono" /></div>
          <div><dt>Earth</dt><dd ref={refs.earth} className="mono" /></div>
        </dl>
        <div ref={refs.note} className="explore-note" />
        <div className="drive-pad" aria-label="Drive controls">
          <button className="ctl" aria-label="Forward" {...hold(1, 0)}>▲</button>
          <div>
            <button className="ctl" aria-label="Turn left" {...hold(0, 1)}>◀</button>
            <button className="ctl" aria-label="Reverse" {...hold(-1, 0)}>▼</button>
            <button className="ctl" aria-label="Turn right" {...hold(0, -1)}>▶</button>
          </div>
        </div>
        <p className="explore-hint">Arrow keys / WASD drive · drag to look · scroll to zoom · V camera · B sunset · N night sky · Esc exit · top speed {(ROVER_TRUE_VMAX * 100).toFixed(1)} cm/s, like the real rover</p>
      </footer>
    </div>
  )
}
