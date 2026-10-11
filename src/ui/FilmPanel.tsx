import { useState } from 'react'
import { cancelFilm, renderFilm, type FilmProgress } from '../film/film'
import { PHASES, TIMELINE_END, phaseEnd } from '../mission/phases'
import { useMission } from '../mission/store'

const RES = { '1080p': [1920, 1080], '1440p': [2560, 1440], '4K': [3840, 2160] } as const
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/**
 * "Render film" dialog: exports the mission (or one phase) as a video file,
 * rendered offline with true motion blur. Runs entirely on the viewer's GPU.
 */
export function FilmPanel({ onClose }: { onClose: () => void }) {
  const [res, setRes] = useState<keyof typeof RES>('1080p')
  const [samples, setSamples] = useState(8)
  const [fps, setFps] = useState(24)
  const [range, setRange] = useState<'all' | number>('all')
  const [prog, setProg] = useState<FilmProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [out, setOut] = useState<{ url: string; name: string; audio: string | null } | null>(null)
  const canAudio = typeof AudioEncoder !== 'undefined'
  const phase = useMission((s) => s.phase)

  const start = range === 'all' ? 0 : PHASES[range].start
  const end = range === 'all' ? TIMELINE_END : phaseEnd(range)
  const frames = Math.round((end - start) * fps)

  const go = async () => {
    setErr('')
    setOut(null)
    setBusy(true)
    try {
      const [w, h] = RES[res]
      useMission.getState().setQuality('ultra') // offline: time is free, use the finest settings
      await new Promise((r) => setTimeout(r, 400))
      const r = await renderFilm({ width: w, height: h, fps, samples, start, end, shutter: 0.5 }, setProg)
      if (r) setOut({ url: URL.createObjectURL(r.blob), name: r.name, audio: r.audio })
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="film-backdrop">
      <div className="film-panel" role="dialog" aria-label="Render film">
        <div className="film-head">
          <div>
            <div className="kicker">Offline render</div>
            <h3>Render film</h3>
          </div>
          {!busy && (
            <button className="ctl" onClick={onClose} aria-label="Close">Close</button>
          )}
        </div>
        <p className="film-note">
          Renders every frame exactly, as slowly as your GPU needs, with true motion blur ({samples} sub-frames per frame, 180° shutter), then saves a video file.
          The page is busy while it renders.
        </p>
        <p className="film-note">
          {canAudio
            ? 'The soundtrack is rendered offline from the same sound design and camera microphones, and muxed as AAC (MP4) or Opus (WebM).'
            : 'This browser cannot encode audio (no WebCodecs AudioEncoder): the film will be exported without sound.'}
        </p>
        {!busy && !out && (
          <div className="film-grid">
            <label>Range
              <select className="ctl" value={range} onChange={(e) => setRange(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
                <option value="all">Full mission (4:00)</option>
                {PHASES.map((p) => (
                  <option key={p.id} value={p.index}>{p.label}{p.index === phase ? ' (current)' : ''}</option>
                ))}
              </select>
            </label>
            <label>Resolution
              <select className="ctl" value={res} onChange={(e) => setRes(e.target.value as keyof typeof RES)}>
                {Object.keys(RES).map((k) => <option key={k}>{k}</option>)}
              </select>
            </label>
            <label>Frame rate
              <select className="ctl" value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                <option value={24}>24 fps (cinema)</option>
                <option value={30}>30 fps</option>
              </select>
            </label>
            <label>Motion blur
              <select className="ctl" value={samples} onChange={(e) => setSamples(Number(e.target.value))}>
                <option value={1}>Off</option>
                <option value={4}>4 samples</option>
                <option value={8}>8 samples</option>
                <option value={16}>16 samples (best)</option>
              </select>
            </label>
            <div className="film-sum mono">{frames.toLocaleString('en-US')} frames · {(frames * samples).toLocaleString('en-US')} renders</div>
            <button className="intro-start" onClick={go}>Render</button>
          </div>
        )}
        {busy && prog && (
          <div className="film-prog">
            <div className="loader-bar wide"><div style={{ width: `${(prog.frame / prog.frames) * 100}%` }} /></div>
            <div className="mono film-sum">
              frame {prog.frame} / {prog.frames} · elapsed {fmt(prog.elapsed)} · remaining ~{fmt(prog.eta)} · {prog.codec}
            </div>
            <button className="ctl" onClick={cancelFilm}>Cancel</button>
          </div>
        )}
        {busy && !prog && <div className="film-sum mono">Preparing…</div>}
        {out && (
          <div className="film-prog">
            <a className="intro-start" href={out.url} download={out.name}>Download {out.name.endsWith('mp4') ? 'MP4' : 'WebM'}</a>
            <div className="film-sum mono">{out.name} · {out.audio ? `${out.audio} soundtrack` : 'video only (no audio encoder)'}</div>
          </div>
        )}
        {err && <div className="film-err">{err}</div>}
      </div>
    </div>
  )
}
