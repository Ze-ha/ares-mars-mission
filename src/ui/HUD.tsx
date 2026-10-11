import { useProgress } from '@react-three/drei'
import { useEffect, useMemo, useRef, useState } from 'react'
import { boosterEngineLayout, shipEngineLayout } from '../assets/vehicle/geometry'
import { EVENTS, PHASES, TIMELINE_END, phaseEnd } from '../mission/phases'
import { QUALITY, runtime, useMission, type Focus, type Quality } from '../mission/store'
import { unlockAudio } from '../audio/engine'
import { FilmPanel } from './FilmPanel'
import { ExploreHUD } from './ExploreHUD'
import { exploreSky, nightCameraYaw, rover, sunsetCameraYaw } from '../explore/exploreState'
import { formatDistance, formatMET, formatSpeed, formatUTC } from './format'
import { utcAt } from '../mission/ephemeris'

/**
 * Minimal aerospace HUD. Every per-frame number is written straight to the DOM
 * from a rAF loop reading `runtime.state` — React only re-renders on user
 * actions and phase changes.
 */

function useRaf(cb: () => void) {
  const ref = useRef(cb)
  ref.current = cb
  useEffect(() => {
    let id = 0
    const loop = () => {
      ref.current()
      id = requestAnimationFrame(loop)
    }
    id = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(id)
  }, [])
}

// ---------------------------------------------------------------- gauges
function Gauge({ label, valueRef, unitRef, arcRef }: { label: string; valueRef: React.RefObject<HTMLSpanElement | null>; unitRef: React.RefObject<HTMLSpanElement | null>; arcRef: React.RefObject<SVGCircleElement | null> }) {
  const C = 2 * Math.PI * 44
  return (
    <div className="gauge">
      <svg viewBox="0 0 100 100" aria-hidden>
        <circle cx="50" cy="50" r="44" className="gauge-track" strokeDasharray={`${C * 0.75} ${C}`} transform="rotate(135 50 50)" />
        <circle ref={arcRef} cx="50" cy="50" r="44" className="gauge-arc" strokeDasharray={`0 ${C}`} transform="rotate(135 50 50)" />
      </svg>
      <div className="gauge-read">
        <span className="gauge-label">{label}</span>
        <span ref={valueRef} className="gauge-value">0</span>
        <span ref={unitRef} className="gauge-unit" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- engine map
function EngineMap({ lit }: { lit: React.RefObject<{ b: SVGGElement | null; bi: SVGGElement | null; sl: SVGGElement | null; vac: SVGGElement | null }> }) {
  const b = useMemo(() => boosterEngineLayout(), [])
  const s = useMemo(() => shipEngineLayout(), [])
  return (
    <div className="engines" aria-label="Engine status">
      <svg viewBox="-5 -5 10 10" className="engine-svg">
        <circle r="4.6" className="engine-ring" />
        <g ref={(el) => void (lit.current.b = el)}>
          {b.filter((e) => e.group === 'booster').map((e, i) => (
            <circle key={i} cx={e.x} cy={e.z} r={0.52} className="engine-dot" />
          ))}
        </g>
        <g ref={(el) => void (lit.current.bi = el)}>
          {b.filter((e) => e.group === 'boostback').map((e, i) => (
            <circle key={i} cx={e.x} cy={e.z} r={0.52} className="engine-dot" />
          ))}
        </g>
      </svg>
      <span className="engines-label">BOOSTER</span>
      <svg viewBox="-5 -5 10 10" className="engine-svg">
        <circle r="4.6" className="engine-ring" />
        <g ref={(el) => void (lit.current.sl = el)}>
          {s.filter((e) => e.group === 'shipSL').map((e, i) => (
            <circle key={i} cx={e.x} cy={e.z} r={0.6} className="engine-dot" />
          ))}
        </g>
        <g ref={(el) => void (lit.current.vac = el)}>
          {s.filter((e) => e.group === 'shipVac').map((e, i) => (
            <circle key={i} cx={e.x} cy={e.z} r={1.1} className="engine-dot" />
          ))}
        </g>
      </svg>
      <span className="engines-label">SHIP</span>
    </div>
  )
}

// ---------------------------------------------------------------- timeline
function Timeline() {
  const phase = useMission((s) => s.phase)
  const seek = useMission((s) => s.seek)
  const fill = useRef<HTMLDivElement>(null)
  useRaf(() => {
    if (fill.current) fill.current.style.width = `${(Math.min(runtime.t, TIMELINE_END) / TIMELINE_END) * 100}%`
  })
  return (
    <div className="timeline" role="navigation" aria-label="Mission phases">
      <div className="timeline-bar">
        <div ref={fill} className="timeline-fill" />
      </div>
      <div className="timeline-phases">
        {PHASES.map((p) => (
          <button
            key={p.id}
            className={`tl-phase ${p.index === phase ? 'is-current' : ''} ${p.index < phase ? 'is-done' : ''}`}
            style={{ flexGrow: phaseEnd(p.index) - p.start }}
            onClick={() => seek(p.start + 0.01)}
            title={p.label}
          >
            <span className="tl-tick" />
            <span className="tl-label">{p.short}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- controls
const SPEEDS = [0.5, 1, 2, 4]
function Controls({ onFilm }: { onFilm: () => void }) {
  const { status, speed, cameraMode, focus, showTelemetry, cinematic, quality, world, audioOn } = useMission()
  const m = useMission.getState()
  const focusOk = (f: Focus) => f === 'vehicle' || (f === 'earth' && world !== 'mars') || (f === 'mars' && world === 'space')
  return (
    <div className="controls">
      <div className="ctl-group">
        <button className="ctl" onClick={m.togglePause} aria-label="Play or pause">
          {status === 'running' ? 'Pause' : status === 'paused' ? 'Resume' : status === 'complete' ? 'Replay' : 'Launch'}
        </button>
        <button className="ctl" onClick={m.restart} aria-label="Restart mission">Restart</button>
        <button className="ctl mono" onClick={() => m.setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])} aria-label="Playback speed">
          {speed}×
        </button>
      </div>
      <div className="ctl-group">
        <button className={`ctl ${cameraMode === 'cinematic' ? 'on' : ''}`} onClick={() => m.setCameraMode('cinematic')}>Cinematic cam</button>
        <button className={`ctl ${cameraMode === 'free' ? 'on' : ''}`} onClick={() => m.setCameraMode('free')}>Free orbit</button>
      </div>
      <div className="ctl-group">
        {(['vehicle', 'earth', 'mars'] as Focus[]).map((f) => (
          <button key={f} disabled={!focusOk(f)} className={`ctl ${cameraMode === 'free' && focus === f ? 'on' : ''}`} onClick={() => m.setFocus(f)}>
            {f === 'vehicle' ? 'Rocket' : f === 'earth' ? 'Earth' : 'Mars'}
          </button>
        ))}
      </div>
      <div className="ctl-group">
        <button className={`ctl ${showTelemetry ? 'on' : ''}`} onClick={m.toggleTelemetry}>Telemetry</button>
        <button className={`ctl ${cinematic ? 'on' : ''}`} onClick={m.toggleCinematic}>Cinema</button>
        <button
          className={`ctl ${audioOn ? 'on' : ''}`}
          onClick={() => {
            if (!audioOn) unlockAudio()
            m.toggleAudio()
          }}
          aria-label="Sound on or off"
          aria-pressed={audioOn}
        >
          Sound
        </button>
        <button className="ctl" onClick={onFilm}>Film</button>
        <select className="ctl mono" value={quality} onChange={(e) => m.setQuality(e.target.value as Quality)} aria-label="Render quality">
          {(Object.keys(QUALITY) as Quality[]).map((q) => (
            <option key={q} value={q}>{q}</option>
          ))}
        </select>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- main HUD
export function HUD() {
  const { status, showTelemetry, cinematic, phase, filming, exploring, world } = useMission()
  // ?explore opens straight into the rover traverse
  useEffect(() => {
    const q = new URLSearchParams(location.search)
    if (q.has('explore')) {
      useMission.getState().setExploring(true)
      if (q.has('mast')) rover.view = 'mast'
      if (q.has('mastsun')) {
        // test hook: point Mastcam at the sun (lens flare / starburst checks)
        rover.view = 'mast'
        rover.mastYaw = Math.atan2(exploreSky.sun.x, exploreSky.sun.z) - rover.heading
        rover.mastPitch = Math.asin(exploreSky.sun.y)
      }
      if (q.has('sunset')) {
        useMission.getState().toggleSunset()
        exploreSky.jump = true
        rover.camPitch = 0.05
        rover.camYaw = sunsetCameraYaw()
        rover.camDist = 9
      }
      if (q.has('night')) {
        useMission.getState().toggleNight()
        exploreSky.jump = true
        rover.camPitch = -0.12
      rover.camYaw = nightCameraYaw()
        rover.camDist = 11
      }
    }
  }, [])
  const [filmOpen, setFilmOpen] = useState(false)
  const start = useMission((s) => s.start)
  const refs = {
    met: useRef<HTMLDivElement>(null),
    utc: useRef<HTMLDivElement>(null),
    warp: useRef<HTMLDivElement>(null),
    spV: useRef<HTMLSpanElement>(null),
    spU: useRef<HTMLSpanElement>(null),
    spA: useRef<SVGCircleElement>(null),
    alV: useRef<HTMLSpanElement>(null),
    alU: useRef<HTMLSpanElement>(null),
    alA: useRef<SVGCircleElement>(null),
    alL: useRef<HTMLSpanElement>(null),
    dE: useRef<HTMLSpanElement>(null),
    dM: useRef<HTMLSpanElement>(null),
    stage: useRef<HTMLSpanElement>(null),
    event: useRef<HTMLDivElement>(null),
  }
  const lit = useRef<{ b: SVGGElement | null; bi: SVGGElement | null; sl: SVGGElement | null; vac: SVGGElement | null }>({ b: null, bi: null, sl: null, vac: null })
  const lastEvent = useRef('')

  useRaf(() => {
    const s = runtime.state
    const C = 2 * Math.PI * 44 * 0.75
    const set = (r: React.RefObject<HTMLElement | null>, v: string) => {
      if (r.current && r.current.textContent !== v) r.current.textContent = v
    }
    set(refs.met, formatMET(s.met))
    set(refs.utc, formatUTC(utcAt(s.met)))
    set(refs.warp, s.timewarp > 1.5 ? `TIME ×${s.timewarp >= 1000 ? Math.round(s.timewarp).toLocaleString('en-US') : s.timewarp.toFixed(s.timewarp < 10 ? 1 : 0)}` : 'REAL TIME')
    const sp = formatSpeed(s.velocity)
    set(refs.spV, sp.v)
    set(refs.spU, sp.u)
    refs.spA.current?.setAttribute('stroke-dasharray', `${C * Math.min(1, Math.log10(1 + s.velocity) / Math.log10(12000))} 999`)
    const al = formatDistance(s.altitudeKm)
    set(refs.alV, al.v)
    set(refs.alU, al.u)
    set(refs.alL, `ALTITUDE · ${s.altitudeRef}`)
    refs.alA.current?.setAttribute('stroke-dasharray', `${C * Math.min(1, Math.log10(1 + s.altitudeKm * 1000) / 11)} 999`)
    const de = formatDistance(s.distEarthKm)
    const dm = formatDistance(s.distMarsKm)
    set(refs.dE, `${de.v} ${de.u}`)
    set(refs.dM, `${dm.v} ${dm.u}`)
    set(refs.stage, s.stage)
    const l = lit.current
    l.b?.classList.toggle('lit', s.boosterThrottle > 0.04)
    l.bi?.classList.toggle('lit', s.boosterThrottle > 0.04 || s.boosterBoostback > 0.04)
    l.sl?.classList.toggle('lit', s.shipSLLit)
    l.vac?.classList.toggle('lit', s.shipVacLit)
    // event callouts
    let ev = ''
    for (const e of EVENTS) if (s.t >= e.t && s.t < e.t + 4.5) ev = e.label
    if (ev !== lastEvent.current && refs.event.current) {
      lastEvent.current = ev
      refs.event.current.textContent = ev
      refs.event.current.classList.remove('show')
      if (ev) {
        void refs.event.current.offsetWidth
        refs.event.current.classList.add('show')
      }
    }
  })

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'SELECT') return
      const m = useMission.getState()
      if (m.exploring) {
        if (e.key === 'm') m.toggleAudio()
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        m.togglePause()
      } else if (e.key === 'c') m.setCameraMode(m.cameraMode === 'cinematic' ? 'free' : 'cinematic')
      else if (e.key === 't') m.toggleTelemetry()
      else if (e.key === 'h') m.toggleCinematic()
      else if (e.key === 'm') m.toggleAudio()
      else if (e.key === 'r') m.restart()
      else if (/^[0-9]$/.test(e.key)) {
        const i = e.key === '0' ? 9 : Number(e.key) - 1
        if (PHASES[i]) m.seek(PHASES[i].start + 0.01)
      } else if (e.key === '-' || e.key === '=') m.setSpeed(Math.max(0.5, Math.min(4, m.speed * (e.key === '=' ? 2 : 0.5))))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const p = PHASES[phase]
  const hideUi = cinematic
  if (filming && !filmOpen) return null
  if (exploring) return (
    <div className={`hud ${hideUi ? 'hud-cinema' : ''}`}>
      <ExploreHUD />
    </div>
  )
  const landed = world === 'mars' && phase === PHASES.length - 1
  return (
    <div className={`hud ${hideUi ? 'hud-cinema' : ''} ${filming ? 'hud-filming' : ''} status-${status}`}>
      {filmOpen && <FilmPanel onClose={() => setFilmOpen(false)} />}
      <div className="letterbox top" />
      <div className="letterbox bottom" />

      {status === 'idle' && (
        <div className="intro">
          <div className="intro-kicker">Interplanetary transfer · Mission 01</div>
          <h1 className="intro-title">ARES</h1>
          <p className="intro-sub">Starbase, Texas to Jezero Crater, Mars. The real 2026 transfer window: 186 days, four minutes.</p>
          <button
            className="intro-start"
            onClick={() => {
              if (useMission.getState().audioOn) unlockAudio()
              start()
            }}
          >
            Start mission
          </button>
          <p className="intro-hint">Drag to look around at any time · Space to pause · 1–0 jump to a phase</p>
          <p className="intro-credits">Vehicle model: “SpaceX Starship Block 3” by Clarence365, CC BY 4.0 (company markings removed) · Jezero terrain: NASA/JPL-Caltech/USGS/UArizona HiRISE DTM + MGS MOLA · Jezero imagery: NASA/JPL/USGS Mars 2020 HiRISE & CTX mosaics · Perseverance rover model: NASA 3D Resources · Earth, Mars and Moon maps: NASA (8K Earth clouds: Solar System Scope, CC BY 4.0) · Milky Way: ESA/Gaia/DPAC, CC BY-SA 3.0 IGO · Star catalogue: HYG v4.1 · Ephemerides: Astronomy Engine</p>
        </div>
      )}

      {status !== 'idle' && (
        <>
          <header className="phase-block">
            <div className="kicker">ARES · Mission 01</div>
            <h2 className="phase-title" key={p.id}>{p.label}</h2>
            <div className="phase-sub">{p.subtitle}</div>
            <div ref={refs.event} className="event" />
          </header>

          <Controls onFilm={() => setFilmOpen(true)} />

          <footer className={`bottom ${showTelemetry ? '' : 'no-telemetry'}`}>
            {showTelemetry && (
              <div className="telemetry left">
                <Gauge label="SPEED" valueRef={refs.spV} unitRef={refs.spU} arcRef={refs.spA} />
                <div className="gauge-wrap">
                  <Gauge label="ALTITUDE" valueRef={refs.alV} unitRef={refs.alU} arcRef={refs.alA} />
                  <span ref={refs.alL} className="gauge-caption" />
                </div>
              </div>
            )}
            <div className="center">
              <div ref={refs.met} className="met">T− 00:00:20</div>
              <div ref={refs.utc} className="utc" />
              <div ref={refs.warp} className="warp">REAL TIME</div>
              {landed && (
                <button className="intro-start explore-go" onClick={() => useMission.getState().setExploring(true)}>
                  Explore Mars
                </button>
              )}
              <Timeline />
            </div>
            {showTelemetry && (
              <div className="telemetry right">
                <EngineMap lit={lit} />
                <dl className="readouts">
                  <div><dt>To Earth</dt><dd ref={refs.dE} className="mono" /></div>
                  <div><dt>To Mars</dt><dd ref={refs.dM} className="mono" /></div>
                  <div><dt>Stage</dt><dd ref={refs.stage} /></div>
                </dl>
              </div>
            )}
          </footer>
        </>
      )}
    </div>
  )
}

export function Loader() {
  const { progress, active } = useProgress()
  const [gone, setGone] = useState(false)
  useEffect(() => {
    if (!active && progress >= 100) {
      const id = setTimeout(() => setGone(true), 900)
      return () => clearTimeout(id)
    }
  }, [active, progress])
  if (gone) return null
  return (
    <div className={`loader ${!active && progress >= 100 ? 'done' : ''}`}>
      <div className="loader-title">ARES</div>
      <div className="loader-bar"><div style={{ width: `${progress}%` }} /></div>
      <div className="loader-text">Loading planetary data · {Math.round(progress)}%</div>
    </div>
  )
}
