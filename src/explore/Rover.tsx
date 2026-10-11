import { useFrame, useLoader, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  Box3, BufferAttribute, BufferGeometry, Group, Matrix3, Matrix4, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Object3D, PerspectiveCamera, Quaternion, Vector3, type Material,
} from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { recenterTerrain, renderedHeight, ROCK_OBSTACLES } from '../assets/mars/MarsSite'
import { runtime, useMission } from '../mission/store'
import { AnyGLTFLoader, binUrl } from '../utils/binary'
import { rover, ROVER_TRUE_VMAX, TIMELAPSE } from './exploreState'
import { Tracks } from './Tracks'

/**
 * NASA's Mars 2020 Perseverance model (NASA 3D Resources), driven over the real
 * Jezero terrain. Six wheels sample the rendered ground; the body settles on the
 * plane through them (a rocker-bogie in spirit), each wheel follows its own
 * contact within the suspension's travel, and the wheels roll with distance.
 * Speed is the real rover's (~4 cm/s) shown in time-lapse.
 */
export const ROVER_URL = `${import.meta.env.BASE_URL}models/perseverance.glb`
const RANGE = 1750 // m from the ship: the HiRISE-resolution terrain

interface Wheel { obj: Object3D; x: number; y: number; z: number; r: number; lift: number }
interface Prepared { root: Group; wheels: Wheel[]; head: Object3D | null; wheelBottom: number; halfLen: number; halfWidth: number }

const DUST = new Vector3(0.55, 0.36, 0.22)

/** Mars dust settles on every upward-facing surface. */
function dusty(m: Material) {
  const src = m as MeshStandardMaterial
  if (!src.isMeshStandardMaterial) return m
  const c = src.clone() as MeshStandardMaterial
  if ((c as MeshPhysicalMaterial).isMeshPhysicalMaterial) {
    const p = c as MeshPhysicalMaterial
    p.transmission = 0 // no transmission pass; the few glass parts read fine as glossy
    p.clearcoat = Math.min(p.clearcoat, 0.3)
  }
  c.envMapIntensity = 0.9
  c.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `#include <normal_fragment_maps>
{
  vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  float up = dot(normal, upV);
  float dust = smoothstep(0.15, 0.85, up) * 0.55 + 0.1;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${DUST.x}, ${DUST.y}, ${DUST.z}), dust);
  roughnessFactor = mix(roughnessFactor, 0.92, dust);
  metalnessFactor = mix(metalnessFactor, 0.0, dust);
}`,
    )
  }
  c.customProgramCacheKey = () => `rover-dust-${src.uuid}`
  return c
}

/** The model's six wheels are one mesh: split it into rolling wheels by clustering triangles. */
function splitWheels(mesh: Mesh, into: Group): Wheel[] {
  const g = mesh.geometry
  const pos = g.getAttribute('position')
  const nrm = g.getAttribute('normal')
  const uv = g.getAttribute('uv')
  const idx = g.getIndex()
  const M = mesh.matrixWorld
  const N = new Matrix3().getNormalMatrix(M)
  const triCount = idx ? idx.count / 3 : pos.count / 3
  const vi = (t: number, k: number) => (idx ? idx.getX(t * 3 + k) : t * 3 + k)
  const P = new Vector3()
  const cent: { x: number; z: number }[] = []
  for (let t = 0; t < triCount; t++) {
    let cx = 0
    let cz = 0
    for (let k = 0; k < 3; k++) {
      P.fromBufferAttribute(pos, vi(t, k)).applyMatrix4(M)
      cx += P.x / 3
      cz += P.z / 3
    }
    cent.push({ x: cx, z: cz })
  }
  // 1-D k-means on z (front / middle / rear), then split by side
  let cs = [Math.min(...cent.map((c) => c.z)), 0, Math.max(...cent.map((c) => c.z))]
  cs[1] = (cs[0] + cs[2]) / 2
  const lab = new Int8Array(triCount)
  for (let it = 0; it < 12; it++) {
    const sum = [0, 0, 0]
    const n = [0, 0, 0]
    for (let t = 0; t < triCount; t++) {
      let b = 0
      for (let j = 1; j < 3; j++) if (Math.abs(cent[t].z - cs[j]) < Math.abs(cent[t].z - cs[b])) b = j
      lab[t] = b
      sum[b] += cent[t].z
      n[b]++
    }
    cs = cs.map((c, j) => (n[j] ? sum[j] / n[j] : c))
  }
  const wheels: Wheel[] = []
  for (let band = 0; band < 3; band++) {
    for (const side of [-1, 1]) {
      const tris: number[] = []
      for (let t = 0; t < triCount; t++) if (lab[t] === band && Math.sign(cent[t].x) === side) tris.push(t)
      if (!tris.length) continue
      const box = new Box3()
      for (const t of tris) for (let k = 0; k < 3; k++) box.expandByPoint(P.fromBufferAttribute(pos, vi(t, k)).applyMatrix4(M))
      const c = box.getCenter(new Vector3())
      const size = box.getSize(new Vector3())
      const p = new Float32Array(tris.length * 9)
      const nn = new Float32Array(tris.length * 9)
      const uu = uv ? new Float32Array(tris.length * 6) : null
      const Nv = new Vector3()
      tris.forEach((t, i) => {
        for (let k = 0; k < 3; k++) {
          const v = vi(t, k)
          P.fromBufferAttribute(pos, v).applyMatrix4(M).sub(c)
          p.set([P.x, P.y, P.z], (i * 3 + k) * 3)
          if (nrm) {
            Nv.fromBufferAttribute(nrm, v).applyMatrix3(N).normalize()
            nn.set([Nv.x, Nv.y, Nv.z], (i * 3 + k) * 3)
          }
          if (uu && uv) uu.set([uv.getX(v), uv.getY(v)], (i * 3 + k) * 2)
        }
      })
      const wg = new BufferGeometry()
      wg.setAttribute('position', new BufferAttribute(p, 3))
      if (nrm) wg.setAttribute('normal', new BufferAttribute(nn, 3))
      else wg.computeVertexNormals()
      if (uu) wg.setAttribute('uv', new BufferAttribute(uu, 2))
      const wm = new Mesh(wg, mesh.material)
      wm.castShadow = wm.receiveShadow = true
      const holder = new Object3D()
      holder.position.copy(c)
      holder.add(wm)
      into.add(holder)
      wheels.push({ obj: wm, x: c.x, y: c.y, z: c.z, r: Math.max(size.y, size.z) / 2, lift: 0 })
    }
  }
  return wheels
}

function prepare(gltf: GLTF): Prepared {
  const scene = gltf.scene
  scene.updateMatrixWorld(true)
  const cache = new Map<string, Material>()
  let wheelsMesh: Mesh | null = null
  let head: Object3D | null = null
  scene.traverse((o) => {
    if (o.name === 'head') head = o
    const m = o as Mesh
    if (!m.isMesh) return
    if (o.name === 'Wheels_objs') wheelsMesh = m
    m.castShadow = true
    m.receiveShadow = true
    m.frustumCulled = false
    const swap = (x: Material) => cache.get(x.uuid) ?? cache.set(x.uuid, dusty(x)).get(x.uuid)!
    m.material = Array.isArray(m.material) ? m.material.map(swap) : swap(m.material)
  })
  const root = new Group()
  root.add(scene)
  let wheels: Wheel[] = []
  if (wheelsMesh) {
    const wm = wheelsMesh as Mesh
    const holder = new Group()
    root.add(holder)
    wheels = splitWheels(wm, holder)
    wm.visible = false
  }
  const box = new Box3().setFromObject(scene)
  const wheelBottom = wheels.length ? Math.min(...wheels.map((w) => w.y - w.r)) : box.min.y
  const zs = wheels.map((w) => w.z)
  const xs = wheels.map((w) => w.x)
  return {
    root,
    wheels,
    head,
    wheelBottom,
    halfLen: wheels.length ? (Math.max(...zs) - Math.min(...zs)) / 2 : 1.2,
    halfWidth: wheels.length ? (Math.max(...xs) - Math.min(...xs)) / 2 : 1.3,
  }
}

let preparedCache: Prepared | null = null

const tmp = { f: new Vector3(), r: new Vector3(), u: new Vector3(), m: new Matrix4(), q: new Quaternion(), p: new Vector3(), c: new Vector3(), t: new Vector3(), look: new Vector3() }

/** Distance to the nearest unclimbable rock edge. */
function rockClearance(x: number, z: number) {
  let m = 1e9
  for (const list of ROCK_OBSTACLES.values()) for (const o of list) m = Math.min(m, Math.hypot(x - o.x, z - o.z) - o.r)
  return m
}

/** First spot near the start with open ground around it and a clear lane ahead. */
function findClearStart() {
  const h0 = rover.heading
  for (let i = 0; i < 400; i++) {
    const a = i * 2.39996
    const d = Math.sqrt(i) * 2.2
    const x = 24 + Math.cos(a) * d
    const z = 18 + Math.sin(a) * d
    if (Math.hypot(x, z) < 16) continue
    let ok = rockClearance(x, z) > 3.5
    for (let k = 2; ok && k <= 14; k += 2) ok = rockClearance(x + Math.sin(h0) * k, z + Math.cos(h0) * k) > 2.2
    if (ok) {
      rover.pos.set(x, 0, z)
      return
    }
  }
}

/** Mastcam-Z head, rover-local metres (top of the remote-sensing mast). */
const MAST = new Vector3(-0.47, 2.0, 0.84)

/** Ground height under a point in rover-local (x, z). */
function contact(x: number, z: number) {
  const s = Math.sin(rover.heading)
  const c = Math.cos(rover.heading)
  const wx = rover.pos.x + x * c + z * s
  const wz = rover.pos.z - x * s + z * c
  return renderedHeight(wx, wz)
}

export function Rover() {
  const gltf = useLoader(AnyGLTFLoader, binUrl(ROVER_URL), (l) => void (l as AnyGLTFLoader).setMeshoptDecoder(MeshoptDecoder)) as GLTF
  const P = useMemo(() => (preparedCache ??= prepare(gltf)), [gltf])
  const group = useRef<Group>(null!)
  const exploring = useMission((s) => s.exploring)
  const { camera, gl } = useThree()
  const st = useMemo(() => ({ y: 0, settled: false, quat: new Quaternion(), camPos: new Vector3(), camInit: false, lookUp: 0 }), [])

  // keyboard: arrows / WASD drive, V switches camera
  useEffect(() => {
    if (!exploring) return
    const keys = new Set<string>()
    const upd = () => {
      rover.input.fwd = (keys.has('ArrowUp') || keys.has('KeyW') ? 1 : 0) - (keys.has('ArrowDown') || keys.has('KeyS') ? 1 : 0)
      rover.input.turn = (keys.has('ArrowLeft') || keys.has('KeyA') ? 1 : 0) - (keys.has('ArrowRight') || keys.has('KeyD') ? 1 : 0)
    }
    const down = (e: KeyboardEvent) => {
      if (/^(Arrow|Key[WASD])/.test(e.code)) {
        e.preventDefault()
        keys.add(e.code)
        upd()
      }
      if (e.code === 'KeyV') rover.view = rover.view === 'chase' ? 'mast' : 'chase'
    }
    const up = (e: KeyboardEvent) => {
      keys.delete(e.code)
      upd()
    }
    const blur = () => {
      keys.clear()
      upd()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    // drag to look, wheel to zoom
    const el = gl.domElement
    let drag: { x: number; y: number } | null = null
    const pd = (e: PointerEvent) => (drag = { x: e.clientX, y: e.clientY })
    const pm = (e: PointerEvent) => {
      if (!drag) return
      const dx = (e.clientX - drag.x) / el.clientHeight
      const dy = (e.clientY - drag.y) / el.clientHeight
      drag = { x: e.clientX, y: e.clientY }
      if (rover.view === 'chase') {
        rover.camYaw -= dx * 3
        rover.camPitch = Math.min(1.3, Math.max(-0.2, rover.camPitch + dy * 2))
        rover.lookUp = Math.min(0.9, Math.max(0, rover.lookUp - dy * 1.5))
      } else {
        rover.mastYaw -= dx * 1.6
        rover.mastPitch = Math.min(0.8, Math.max(-1.0, rover.mastPitch - dy * 1.6))
      }
    }
    const pu = () => (drag = null)
    const wh = (e: WheelEvent) => {
      if (rover.view === 'chase') rover.camDist = Math.min(60, Math.max(4.5, rover.camDist * Math.exp(e.deltaY * 0.0012)))
    }
    el.addEventListener('pointerdown', pd)
    window.addEventListener('pointermove', pm)
    window.addEventListener('pointerup', pu)
    el.addEventListener('wheel', wh, { passive: true })
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      el.removeEventListener('pointerdown', pd)
      window.removeEventListener('pointermove', pm)
      window.removeEventListener('pointerup', pu)
      el.removeEventListener('wheel', wh)
      rover.input.fwd = rover.input.turn = 0
    }
  }, [exploring, gl])

  useFrame((_, rawDt) => {
    const g = group.current
    g.visible = exploring && runtime.state.world === 'mars'
    if (!g.visible) {
      st.camInit = false
      st.settled = false
      return
    }
    const dt = Math.min(0.05, runtime.fixedDt || rawDt)
    if (!st.settled && rover.odometer === 0 && ROCK_OBSTACLES.size) findClearStart()
    // ---- drive: heavy, deliberate — gentle acceleration, turn in place or on the move
    const vmax = ROVER_TRUE_VMAX * TIMELAPSE
    const target = rover.input.fwd * vmax
    const acc = 0.9 * dt
    rover.speed += Math.max(-acc, Math.min(acc, target - rover.speed))
    const turnRate = 0.32 * (Math.abs(rover.speed) > 0.05 ? Math.sign(rover.speed) : 1)
    rover.heading += rover.input.turn * turnRate * dt
    const step = rover.speed * dt
    if (Math.abs(step) > 1e-6) {
      const nx = rover.pos.x + Math.sin(rover.heading) * step
      const nz = rover.pos.z + Math.cos(rover.heading) * step
      // obstacles: the ship's legs, big rocks, too-steep ground, range limit
      let block = ''
      if (Math.hypot(nx, nz) < 9) block = 'Starship ahead'
      else if (Math.hypot(nx, nz) > RANGE) block = 'Edge of the mapped area'
      else {
        for (const list of ROCK_OBSTACLES.values())
          for (const o of list) {
            const d = Math.hypot(nx - o.x, nz - o.z)
            if (d < o.r + 1.25 && Math.hypot(rover.pos.x - o.x, rover.pos.z - o.z) > d) {
              block = 'Rock too large to climb'
              break
            }
          }
        if (!block) {
          const ahead = renderedHeight(nx + Math.sin(rover.heading) * Math.sign(step) * 1.5, nz + Math.cos(rover.heading) * Math.sign(step) * 1.5)
          const here = renderedHeight(nx, nz)
          if (Math.abs(ahead - here) / 1.5 > Math.tan((30 * Math.PI) / 180)) block = 'Slope over 30°'
        }
      }
      rover.blocked = block
      if (block) rover.speed = 0
      else {
        rover.pos.x = nx
        rover.pos.z = nz
        rover.odometer += Math.abs(step) / TIMELAPSE
        rover.wheelSpin += step
      }
    } else rover.blocked = ''
    recenterTerrain(rover.pos.x, rover.pos.z)

    // ---- settle on the six contacts
    const W = P.wheels
    const hs = W.map((w) => contact(w.x, w.z))
    const front = W.filter((w) => w.z > 0.3)
    const rear = W.filter((w) => w.z < -0.3)
    const avg = (arr: Wheel[]) => arr.reduce((s, w) => s + hs[W.indexOf(w)], 0) / Math.max(1, arr.length)
    const dz = (front.reduce((s, w) => s + w.z, 0) / Math.max(1, front.length)) - (rear.reduce((s, w) => s + w.z, 0) / Math.max(1, rear.length))
    const pitchSlope = (avg(front) - avg(rear)) / Math.max(0.5, dz)
    const left = W.filter((w) => w.x > 0)
    const right = W.filter((w) => w.x < 0)
    const dx = (left.reduce((s, w) => s + w.x, 0) / Math.max(1, left.length)) - (right.reduce((s, w) => s + w.x, 0) / Math.max(1, right.length))
    const rollSlope = (avg(left) - avg(right)) / Math.max(0.5, dx)
    const mean = hs.reduce((a, b) => a + b, 0) / Math.max(1, hs.length)
    // body frame from heading + fitted plane
    const f = tmp.f.set(Math.sin(rover.heading), 0, Math.cos(rover.heading))
    const rgt = tmp.r.set(Math.cos(rover.heading), 0, -Math.sin(rover.heading))
    f.y = pitchSlope
    f.normalize()
    rgt.y = rollSlope
    rgt.normalize()
    const u = tmp.u.crossVectors(f, rgt).normalize()
    if (u.y < 0) u.negate()
    rgt.crossVectors(u, f).normalize()
    tmp.m.makeBasis(rgt, u, f)
    tmp.q.setFromRotationMatrix(tmp.m)
    const k = 1 - Math.exp(-dt * 6)
    st.quat.slerp(tmp.q, st.settled ? k : 1)
    const yT = mean - P.wheelBottom
    st.y = st.settled ? st.y + (yT - st.y) * k : yT
    st.settled = true
    rover.pos.y = st.y
    rover.quat.copy(st.quat)
    g.position.copy(rover.pos)
    g.quaternion.copy(st.quat)
    // each wheel rides its own contact within ±25 cm of suspension travel, and rolls
    W.forEach((w, i) => {
      const planeH = mean + pitchSlope * w.z + rollSlope * w.x - (pitchSlope * (W.reduce((s, q) => s + q.z, 0) / W.length) + rollSlope * (W.reduce((s, q) => s + q.x, 0) / W.length))
      w.lift += (Math.max(-0.25, Math.min(0.25, hs[i] - planeH)) - w.lift) * k
      w.obj.position.y = w.lift
      w.obj.rotation.x = rover.wheelSpin / w.r
    })

    // ---- camera
    const cam = camera as PerspectiveCamera
    if (cam.near !== 0.2 || cam.far !== 2.5e6) {
      cam.near = 0.2
      cam.far = 2.5e6 // the sky dome sits at 400 km
      cam.updateProjectionMatrix()
    }
    if (rover.view === 'mast') {
      tmp.p.copy(MAST).applyQuaternion(st.quat).add(rover.pos)
      const yaw = rover.heading + rover.mastYaw
      tmp.look.set(Math.sin(yaw) * Math.cos(rover.mastPitch), Math.sin(rover.mastPitch), Math.cos(yaw) * Math.cos(rover.mastPitch))
      cam.position.copy(tmp.p).addScaledVector(tmp.look, 0.25)
      cam.lookAt(tmp.t.copy(cam.position).add(tmp.look))
      if (Math.abs(cam.fov - 34) > 0.01) {
        cam.fov = 34
        cam.updateProjectionMatrix()
      }
      st.camInit = false
    } else {
      const yaw = rover.heading + rover.camYaw
      const d = rover.camDist
      const tgt = tmp.t.copy(rover.pos).add(tmp.c.set(0, 1.3, 0))
      const want = tmp.p.set(Math.sin(yaw) * Math.cos(rover.camPitch) * d, Math.sin(rover.camPitch) * d, Math.cos(yaw) * Math.cos(rover.camPitch) * d).add(tgt)
      want.y = Math.max(want.y, renderedHeight(want.x, want.z) + 0.6)
      if (!st.camInit) {
        st.camPos.copy(want)
        st.camInit = true
      }
      // a heavy, damped follow — a camera operator walking behind, not a drone
      st.camPos.lerp(want, 1 - Math.exp(-dt * 3))
      cam.position.copy(st.camPos)
      cam.lookAt(tgt)
      st.lookUp += (rover.lookUp - st.lookUp) * (1 - Math.exp(-dt * 1.5))
      if (st.lookUp > 1e-3) cam.rotateX(st.lookUp)
      const fov = 42 + 14 * Math.min(1, st.lookUp / 0.5)
      if (Math.abs(cam.fov - fov) > 0.01) {
        cam.fov = fov
        cam.updateProjectionMatrix()
      }
    }
  })

  return (
    <>
    <group ref={group} visible={false}>
      <primitive object={P.root} />
    </group>
    <Tracks halfTrack={P.halfWidth} />
    </>
  )
}
