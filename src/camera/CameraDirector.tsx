import { OrbitControls } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { PerspectiveCamera, Vector3 } from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { EARTH_RADIUS_KM, MARS_RADIUS_KM } from '../mission/constants'
import { runtime, useMission, type Focus } from '../mission/store'
import type { MissionState } from '../mission/trajectory'
import { easeInOutCubic, noise1, progress } from '../utils/math'
import { WORLD_UNITS } from '../scene/sceneRefs'
import { SHOTS, idlePose, shotIndexAt, type Pose } from './shots'

const BLEND = 3.4
const mkPose = (): Pose => ({ pos: new Vector3(), target: new Vector3(), fov: 40 })
const Y = new Vector3(0, 1, 0)

/** Where each focus target lives in the currently active world. */
function focusPoint(s: MissionState, focus: Focus, out: Vector3) {
  if (s.world === 'earth') {
    if (focus === 'earth') return out.set(0, 20, 0)
    return out.copy(Y).applyQuaternion(s.stackQuat).multiplyScalar(60).add(s.stackBase)
  }
  if (s.world === 'mars') return out.copy(Y).applyQuaternion(s.landerQuat).multiplyScalar(24).add(s.landerBase)
  if (focus === 'earth') return out.copy(s.earthCenter)
  if (focus === 'mars') return out.copy(s.marsCenter)
  return out.set(0, 0, 0)
}
function focusDistance(s: MissionState, focus: Focus) {
  if (s.world === 'space' && focus === 'earth') return EARTH_RADIUS_KM * 3.2
  if (s.world === 'space' && focus === 'mars') return MARS_RADIUS_KM * 3.2
  if (s.world === 'earth' && focus === 'earth') return 2600
  return WORLD_UNITS[s.world].vehicleDist
}

/**
 * Camera director: evaluates the cinematic shot list with eased cross-blends
 * and procedural shake, or hands control to a free orbit camera that keeps
 * following the chosen focus object while the mission keeps running.
 */
export function CameraDirector() {
  const { camera, gl } = useThree()
  const cam = camera as PerspectiveCamera
  const controls = useRef<OrbitControlsImpl>(null!)
  const mode = useMission((s) => s.cameraMode)
  const focus = useMission((s) => s.focus)
  const status = useMission((s) => s.status)
  const st = useMemo(
    () => ({
      cur: mkPose(), prev: mkPose(), out: mkPose(),
      lastShot: -1, blendStart: -1e9, lastSeek: -1, lastWorld: '' as string, snap: true, sPos: new Vector3(), sTarget: new Vector3(), sFov: 40,
      lastFocus: new Vector3(), fly: 1, flyFrom: new Vector3(), flyTo: new Vector3(), flyTargetFrom: new Vector3(), flyStart: 0,
    }),
    [],
  )

  // grabbing the view in cinematic mode switches to free orbit (the mission keeps playing)
  useEffect(() => {
    const el = gl.domElement
    let down: { x: number; y: number } | null = null
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY })
    const onMove = (e: PointerEvent) => {
      if (!down || useMission.getState().cameraMode !== 'cinematic' || useMission.getState().exploring) return
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) {
        useMission.getState().setCameraMode('free')
        down = null
      }
    }
    const onUp = () => (down = null)
    const onWheel = () => {
      if (useMission.getState().cameraMode === 'cinematic' && useMission.getState().status !== 'idle' && !useMission.getState().exploring) useMission.getState().setCameraMode('free')
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      el.removeEventListener('wheel', onWheel)
    }
  }, [gl])

  // entering free mode / changing focus: fly smoothly to the new subject
  useEffect(() => {
    if (mode !== 'free' || !controls.current) return
    const s = runtime.state
    const p = focusPoint(s, focus, new Vector3())
    st.flyTargetFrom.copy(controls.current.target)
    st.flyFrom.copy(cam.position)
    const dir = new Vector3().subVectors(cam.position, focusPoint(s, focus === 'vehicle' ? 'vehicle' : focus, new Vector3())).normalize()
    if (!isFinite(dir.x) || dir.lengthSq() < 0.5) dir.set(-0.6, 0.25, 0.75).normalize()
    const d = focusDistance(s, focus)
    const curD = cam.position.distanceTo(p)
    st.flyTo.copy(p).addScaledVector(dir, focus === 'vehicle' && curD < d * 3 ? curD : d)
    st.fly = 0
    st.flyStart = performance.now()
    st.lastFocus.copy(p)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, focus])

  useFrame((_, rawDelta) => {
    // explore mode: the rover's cameras own the view
    if (useMission.getState().exploring) {
      st.snap = true
      return
    }
    const delta = runtime.fixedDt || rawDelta
    const s = runtime.state
    const units = WORLD_UNITS[s.world]
    if (cam.near !== units.near || cam.far !== units.far) {
      cam.near = units.near
      cam.far = units.far
      cam.updateProjectionMatrix()
    }

    if (mode === 'free' && controls.current) {
      const c = controls.current
      const p = focusPoint(s, focus, new Vector3())
      if (st.lastWorld !== s.world) {
        // world changed under us: re-frame the vehicle
        st.lastWorld = s.world
        st.snap = true
        useMission.getState().setFocus('vehicle')
        cam.position.copy(p).add(new Vector3(-0.6, 0.25, 0.75).multiplyScalar(units.vehicleDist))
        c.target.copy(p)
        st.lastFocus.copy(p)
        st.fly = 1
      }
      if (st.fly < 1) {
        st.fly = Math.min(1, (performance.now() - st.flyStart) / 1400)
        const e = easeInOutCubic(st.fly)
        c.target.lerpVectors(st.flyTargetFrom, p, e)
        cam.position.lerpVectors(st.flyFrom, st.flyTo, e)
      } else {
        // follow the moving subject
        const delta = new Vector3().subVectors(p, st.lastFocus)
        cam.position.add(delta)
        c.target.copy(p)
      }
      st.lastFocus.copy(p)
      const d = cam.position.distanceTo(c.target)
      c.minDistance = focus === 'vehicle' ? units.vehicleDist * 0.15 : (focus === 'earth' ? EARTH_RADIUS_KM : MARS_RADIUS_KM) * (s.world === 'space' ? 1.02 : 0.001)
      c.maxDistance = Math.max(d * 1.01, s.world === 'space' ? 5e5 : 60000)
      if (Math.abs(cam.fov - 45) > 0.01) {
        cam.fov += (45 - cam.fov) * 0.1
        cam.updateProjectionMatrix()
      }
      c.update()
      return
    }
    st.lastWorld = s.world

    // ---------------- cinematic
    const t = s.t
    const pose = st.out
    let targetEV = 0
    if (status === 'idle') {
      idlePose(runtime.ambient, pose)
    } else {
      const i = shotIndexAt(t)
      const shot = SHOTS[i]
      if (runtime.seekNonce !== st.lastSeek) st.snap = true // any jump in time is a hard cut
      if (i !== st.lastShot) {
        const seeked = runtime.seekNonce !== st.lastSeek
        const worldChange = st.lastShot >= 0 && SHOTS[st.lastShot].world !== shot.world
        const hard = shot.cut || seeked || worldChange || st.lastShot < 0
        st.blendStart = hard ? -1e9 : t
        if (hard) st.snap = true
        st.lastShot = i
      }
      st.lastSeek = runtime.seekNonce
      shot.eval(s, progress(t, shot.start, shot.end), st.cur)
      targetEV = shot.ev ?? 0
      const k = (t - st.blendStart) / BLEND
      if (k >= 0 && k < 1 && i > 0) {
        const p = SHOTS[i - 1]
        p.eval(s, (t - p.start) / (p.end - p.start), st.prev)
        const e = easeInOutCubic(k)
        pose.pos.lerpVectors(st.prev.pos, st.cur.pos, e)
        pose.target.lerpVectors(st.prev.target, st.cur.target, e)
        pose.fov = st.prev.fov + (st.cur.fov - st.prev.fov) * e
        targetEV = (p.ev ?? 0) + ((shot.ev ?? 0) - (p.ev ?? 0)) * e
      } else {
        pose.pos.copy(st.cur.pos)
        pose.target.copy(st.cur.target)
        pose.fov = st.cur.fov
      }
    }

    // procedural handheld shake: two octaves of smooth noise, scaled by distance to subject
    // heavy camera: a light critically-damped follow gives mass to every move (snaps on cuts)
    if (st.snap || status === 'idle') {
      st.sPos.copy(pose.pos)
      st.sTarget.copy(pose.target)
      st.sFov = pose.fov
      st.snap = false
    } else {
      const k = 1 - Math.exp(-7 * Math.min(delta, 0.1))
      st.sPos.lerp(pose.pos, k)
      st.sTarget.lerp(pose.target, k)
      st.sFov += (pose.fov - st.sFov) * k
    }
    pose.pos.copy(st.sPos)
    pose.target.copy(st.sTarget)
    pose.fov = st.sFov
    const dist = pose.pos.distanceTo(pose.target)
    const amp = s.shake * Math.min(dist, 400 * (s.world === 'space' ? 0.001 : 1)) * 0.009
    const tt = runtime.ambient
    cam.position.copy(pose.pos)
    cam.position.x += noise1(tt * 9.1) * amp + noise1(tt * 23.7 + 5) * amp * 0.4
    cam.position.y += noise1(tt * 8.3 + 11) * amp + noise1(tt * 27.1 + 3) * amp * 0.4
    cam.position.z += noise1(tt * 7.7 + 21) * amp * 0.6
    // subtle breathing on otherwise static shots
    const breath = dist * 0.0008
    cam.position.y += Math.sin(tt * 0.6) * breath
    cam.up.set(0, 1, 0)
    cam.lookAt(pose.target)
    if (Math.abs(cam.fov - pose.fov) > 1e-3) {
      cam.fov = pose.fov
      cam.updateProjectionMatrix()
    }
    if (controls.current) controls.current.target.copy(pose.target)
    runtime.exposureEV += (targetEV - runtime.exposureEV) * (1 - Math.exp(-3 * Math.min(delta, 0.1)))
  }, -1)

  const exploring = useMission((s) => s.exploring)
  return <OrbitControls ref={controls as never} enabled={mode === 'free' && !exploring} enableDamping dampingFactor={0.08} rotateSpeed={0.6} zoomSpeed={0.9} makeDefault={false} />
}
