import type { RootState } from '@react-three/fiber'
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer'
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer'
import { renderMissionAudio } from '../audio/offline'
import { runtime, useMission } from '../mission/store'

/**
 * Offline film renderer.
 *
 * Because the whole mission is a pure function of time, every output frame can
 * be rendered exactly, as slowly as the GPU needs:
 *  - each 24/30 fps frame is the average of N sub-frames spread across a 180°
 *    shutter → true motion blur on everything that moves, plus supersampling;
 *  - frames are encoded in the browser with WebCodecs (H.264 MP4, or VP9 WebM
 *    where H.264 encoding is unavailable) and downloaded as a file;
 *  - the soundtrack is the live sound design rendered offline for the same range
 *    (OfflineAudioContext, cinematic microphones) and encoded as AAC (MP4) or
 *    Opus (WebM). Without WebCodecs audio the film is exported silent.
 */

export interface FilmOptions {
  width: number
  height: number
  fps: number
  samples: number // motion-blur sub-frames per frame
  start: number // mission seconds
  end: number
  shutter: number // fraction of the frame interval the shutter is open (0.5 = 180°)
}

export interface FilmProgress {
  frame: number
  frames: number
  elapsed: number
  eta: number
  codec: string
}

let getState: (() => RootState) | null = null
export const registerFilmBridge = (g: () => RootState) => (getState = g)

let cancelFlag = false
export const cancelFilm = () => (cancelFlag = true)

async function pickCodec(w: number, h: number, fps: number) {
  const bitrate = Math.round(w * h * fps * 0.35)
  const candidates = [
    { codec: 'avc1.640034', container: 'mp4' as const },
    { codec: 'avc1.4d0034', container: 'mp4' as const },
    { codec: 'vp09.00.51.08', container: 'webm' as const },
    { codec: 'vp8', container: 'webm' as const },
  ]
  for (const c of candidates) {
    const config: VideoEncoderConfig = { codec: c.codec, width: w, height: h, bitrate, framerate: fps }
    try {
      const r = await VideoEncoder.isConfigSupported(config)
      if (r.supported) return { ...c, config }
    } catch {
      /* try next */
    }
  }
  throw new Error('This browser cannot encode video (WebCodecs unavailable).')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const AUDIO_SR = 48000
async function pickAudioCodec(container: 'mp4' | 'webm') {
  if (typeof AudioEncoder === 'undefined') return null
  const candidates =
    container === 'mp4'
      ? [{ codec: 'mp4a.40.2', mux: 'aac' as const, label: 'AAC' }, { codec: 'opus', mux: 'opus' as const, label: 'Opus' }]
      : [{ codec: 'opus', mux: 'opus' as const, label: 'Opus' }]
  for (const c of candidates) {
    const config: AudioEncoderConfig = { codec: c.codec, sampleRate: AUDIO_SR, numberOfChannels: 2, bitrate: 192000 }
    try {
      if ((await AudioEncoder.isConfigSupported(config)).supported) return { ...c, config }
    } catch {
      /* try next */
    }
  }
  return null
}

/** Renders the soundtrack offline and encodes it; returns the encoded chunks in timestamp order. */
async function encodeSoundtrack(start: number, end: number, config: AudioEncoderConfig, onStage: (f: number) => void) {
  const buf = await renderMissionAudio(start, end, { sampleRate: AUDIO_SR, onProgress: onStage })
  const chunks: { chunk: EncodedAudioChunk; meta?: EncodedAudioChunkMetadata }[] = []
  let err: unknown = null
  const enc = new AudioEncoder({ output: (chunk, meta) => chunks.push({ chunk, meta }), error: (e) => (err = e) })
  enc.configure(config)
  const L = buf.getChannelData(0)
  const R = buf.getChannelData(1)
  const N = 4800
  for (let i = 0; i < buf.length; i += N) {
    const n = Math.min(N, buf.length - i)
    const data = new Float32Array(n * 2)
    data.set(L.subarray(i, i + n), 0)
    data.set(R.subarray(i, i + n), n)
    const ad = new AudioData({ format: 'f32-planar', sampleRate: AUDIO_SR, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / AUDIO_SR) * 1e6), data })
    enc.encode(ad)
    ad.close()
    if (enc.encodeQueueSize > 32) await sleep(1)
  }
  await enc.flush()
  enc.close()
  if (err) throw err
  return chunks
}

export async function renderFilm(opt: FilmOptions, onProgress: (p: FilmProgress) => void): Promise<{ blob: Blob; name: string; audio: string | null } | null> {
  if (!getState) throw new Error('Renderer not ready')
  if (typeof VideoEncoder === 'undefined') throw new Error('This browser does not support WebCodecs video encoding. Use a current Chrome or Edge.')
  cancelFlag = false
  const state = getState()
  const store = useMission.getState()
  const prev = { status: store.status, cameraMode: store.cameraMode, dpr: state.viewport.dpr, size: { ...state.size }, frameloop: state.frameloop }

  // lock the experience into a deterministic, offline state
  useMission.setState({ status: 'paused', cameraMode: 'cinematic', filming: true } as never)
  state.setFrameloop('never')
  state.setDpr(1)
  state.setSize(opt.width, opt.height)
  await sleep(50)

  const { codec, container, config } = await pickCodec(opt.width, opt.height, opt.fps)
  const frames = Math.max(1, Math.round((opt.end - opt.start) * opt.fps))

  // soundtrack first (same microphones the director uses), so it can be interleaved with the video
  let aud = await pickAudioCodec(container)
  let audioChunks: Awaited<ReturnType<typeof encodeSoundtrack>> = []
  if (aud) {
    try {
      const t0 = performance.now()
      audioChunks = await encodeSoundtrack(opt.start, opt.start + frames / opt.fps, aud.config, (f) =>
        onProgress({ frame: 0, frames, elapsed: (performance.now() - t0) / 1000, eta: 0, codec: `soundtrack ${Math.round(f * 100)}%` }),
      )
    } catch (e) {
      console.warn('Soundtrack failed, exporting video only', e)
      aud = null
    }
  }
  const audioOpt = aud ? { numberOfChannels: 2, sampleRate: AUDIO_SR } : undefined
  const mux =
    container === 'mp4'
      ? new Mp4Muxer({
          target: new Mp4Target(),
          video: { codec: 'avc', width: opt.width, height: opt.height, frameRate: opt.fps },
          audio: audioOpt && aud ? { ...audioOpt, codec: aud.mux } : undefined,
          fastStart: 'in-memory',
          firstTimestampBehavior: 'offset',
        })
      : new WebmMuxer({
          target: new WebmTarget(),
          video: { codec: codec.startsWith('vp09') ? 'V_VP9' : 'V_VP8', width: opt.width, height: opt.height, frameRate: opt.fps },
          audio: audioOpt ? { ...audioOpt, codec: 'A_OPUS' } : undefined,
          firstTimestampBehavior: 'offset',
        })
  const m = mux as {
    addVideoChunk: (c: EncodedVideoChunk, m?: EncodedVideoChunkMetadata) => void
    addAudioChunk: (c: EncodedAudioChunk, m?: EncodedAudioChunkMetadata) => void
  }
  let ai = 0
  /** interleave: every audio chunk up to the video timestamp goes in first */
  const pumpAudio = (upTo: number) => {
    for (; ai < audioChunks.length && audioChunks[ai].chunk.timestamp <= upTo; ai++) m.addAudioChunk(audioChunks[ai].chunk, audioChunks[ai].meta)
  }
  const codecLabel = aud ? `${codec} + ${aud.label}` : `${codec} · no audio`
  let encodeError: unknown = null
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      pumpAudio(chunk.timestamp)
      m.addVideoChunk(chunk, meta)
    },
    error: (e) => (encodeError = e),
  })
  encoder.configure(config)

  const acc = document.createElement('canvas')
  acc.width = opt.width
  acc.height = opt.height
  const ctx = acc.getContext('2d', { alpha: false })!
  const gl = state.gl.domElement

  const t0 = performance.now()
  const ambient0 = runtime.ambient
  runtime.seekNonce++
  // warm-up: let the camera director settle on the first shot without damping lag
  runtime.t = opt.start
  runtime.fixedDt = 1 / opt.fps
  for (let i = 0; i < 3; i++) state.advance(performance.now())

  try {
    for (let f = 0; f < frames; f++) {
      if (cancelFlag) break
      if (encodeError) throw encodeError
      runtime.fixedDt = 1 / (opt.fps * opt.samples)
      for (let s = 0; s < opt.samples; s++) {
        const sub = opt.samples > 1 ? (s / (opt.samples - 1) - 0.5) * opt.shutter : 0
        const tt = opt.start + (f + sub) / opt.fps
        runtime.t = tt
        runtime.ambient = ambient0 + (tt - opt.start)
        state.advance(performance.now())
        ctx.globalAlpha = 1 / (s + 1)
        ctx.drawImage(gl, 0, 0, opt.width, opt.height)
      }
      const vf = new VideoFrame(acc, { timestamp: Math.round((f * 1e6) / opt.fps), duration: Math.round(1e6 / opt.fps) })
      encoder.encode(vf, { keyFrame: f % (opt.fps * 2) === 0 })
      vf.close()
      while (encoder.encodeQueueSize > 6) await sleep(4)
      if (f % 2 === 0) {
        const el = (performance.now() - t0) / 1000
        onProgress({ frame: f + 1, frames, elapsed: el, eta: (el / (f + 1)) * (frames - f - 1), codec: codecLabel })
        await sleep(0)
      }
    }
    await encoder.flush()
    if (!cancelFlag) pumpAudio(Infinity)
    mux.finalize()
    if (cancelFlag) return null
    const buf = (mux.target as { buffer: ArrayBuffer }).buffer
    const type = container === 'mp4' ? 'video/mp4' : 'video/webm'
    const name = `ares-mission_${opt.width}x${opt.height}_${opt.fps}fps_t${Math.round(opt.start)}-${Math.round(opt.end)}.${container}`
    return { blob: new Blob([buf], { type }), name, audio: aud ? aud.label : null }
  } finally {
    encoder.close()
    runtime.fixedDt = 0
    state.setSize(prev.size.width, prev.size.height)
    state.setDpr(prev.dpr)
    state.setFrameloop(prev.frameloop)
    useMission.setState({ status: 'paused', cameraMode: prev.cameraMode, filming: false } as never)
  }
}

// test hook: ?filmtest exposes the renderer for automated verification
if (typeof window !== 'undefined' && new URLSearchParams(location.search).has('filmtest')) (window as unknown as { __renderFilm: typeof renderFilm }).__renderFilm = renderFilm
