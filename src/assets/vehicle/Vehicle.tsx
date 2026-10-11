import { useFrame } from '@react-three/fiber'
import { forwardRef, useMemo, useRef } from 'react'
import {
  AdditiveBlending, BoxGeometry, BufferGeometry, TorusGeometry, CircleGeometry, CylinderGeometry, DoubleSide, FrontSide, Group, LatheGeometry, Mesh, Quaternion, ShaderMaterial, Vector3, type Side,
} from 'three'
import { VEHICLE } from '../../mission/constants'
import { runtime, useMission } from '../../mission/store'
import { useStageInstance, useVehicleModel } from './StarshipModel'
import { plasmaShader } from '../../shaders/effects'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { DEG } from '../../utils/math'
import { EngineCluster, type PlumeControls } from './EngineCluster'
import { boosterEngineLayout, flapGeometry, gridFinGeometry, noseProfile, noseRadiusAt, shipEngineLayout } from './geometry'
import { vehicleMaterials } from './materials'

/**
 * Model hierarchy (every node has a clean pivot for animation):
 *
 *  Booster (origin = engine exit plane)
 *   ├─ body (steel, frost band)          ├─ hot-staging vent ring (emissive)
 *   ├─ grid fins ×4                       ├─ raceway, lift pins
 *   └─ EngineCluster: 33 engines + merged plume
 *
 *  Ship (origin = engine exit plane, belly/heat-shield = -Z)
 *   ├─ body: tiles half + steel half      ├─ nose: tangent ogive, tiles/steel
 *   ├─ aft flaps ×2 (hinge pivots)        ├─ forward flaps ×2 (hinge pivots, canted)
 *   ├─ landing legs ×6 (optional)         ├─ plasma sheath + wake (optional)
 *   └─ EngineCluster: 3 sea-level + 3 vacuum engines
 */

export interface VehicleControls extends PlumeControls {
  flapFwd: number
  flapAft: number
  legs: number
  plasma: number
}

export const createVehicleControls = (): VehicleControls => ({
  throttle: { booster: 0, boostback: 0, shipSL: 0, shipVac: 0 },
  expansion: 0,
  clearance: Infinity,
  flapFwd: 0,
  flapAft: 0,
  legs: 0,
  plasma: 0,
})

const R = VEHICLE.radius
const TILE_START = Math.PI * 0.45
const TILE_LEN = Math.PI * 1.1

let shipGeoCache: ReturnType<typeof buildShipGeometry> | null = null
function buildShipGeometry() {
  const H = VEHICLE.shipBodyLength
  const L = VEHICLE.shipNoseLength
  const bodyTiles = new CylinderGeometry(R, R, H, 128, 1, true, TILE_START, TILE_LEN).translate(0, H / 2, 0)
  const bodySteel = new CylinderGeometry(R, R, H, 96, 1, true, TILE_START + TILE_LEN, Math.PI * 2 - TILE_LEN).translate(0, H / 2, 0)
  const prof = noseProfile(R, L)
  const noseTiles = new LatheGeometry(prof, 128, TILE_START, TILE_LEN).translate(0, H, 0)
  const noseSteel = new LatheGeometry(prof, 96, TILE_START + TILE_LEN, Math.PI * 2 - TILE_LEN).translate(0, H, 0)
  const shield = new CircleGeometry(R - 0.04, 64).rotateX(Math.PI / 2).translate(0, 2.3, 0)
  const raceway = new BoxGeometry(0.7, H - 3, 0.38).translate(0, H / 2 + 1, R + 0.15)
  const aftW = flapGeometry(9.8, 5.4, 3.9, 2.6, 0.5, 'windward')
  const aftL = flapGeometry(9.8, 5.4, 3.9, 2.6, 0.5, 'leeward')
  const fwdW = flapGeometry(7.2, 3.0, 2.7, 3.4, 0.36, 'windward')
  const fwdL = flapGeometry(7.2, 3.0, 2.7, 3.4, 0.36, 'leeward')
  // plasma sheath: a slightly inflated copy of the hull
  const sheathBody = new CylinderGeometry(R * 1.16, R * 1.2, H + 2, 64, 8, true).translate(0, H / 2 - 1, 0)
  const sheathNose = new LatheGeometry(noseProfile(R * 1.16, L + 1.2, 1.2), 64).translate(0, H - 0.2, 0)
  const wake = new CylinderGeometry(95, 20, 260, 48, 24, true).rotateX(Math.PI / 2).translate(0, 0, 128)
  return { bodyTiles, bodySteel, noseTiles, noseSteel, shield, raceway, aftW, aftL, fwdW, fwdL, sheathBody, sheathNose, wake }
}
const shipGeo = () => (shipGeoCache ??= buildShipGeometry())

/** Merge a list of transformed primitive geometries into one mesh (one draw call). */
function merged(parts: BufferGeometry[]) {
  return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))!
}
const ring = (r: number, tube: number, y: number) => new TorusGeometry(r, tube, 6, 160).rotateX(Math.PI / 2).translate(0, y, 0)
const boxAt = (w: number, h: number, d: number, x: number, y: number, z: number, rotY = 0) => new BoxGeometry(w, h, d).rotateY(rotY).translate(x, y, z)
const polar = (r: number, a: number): [number, number] => [r * Math.sin(a), r * Math.cos(a)]

/** Structural detail read at close range: dome welds, chines, clamps, hardpoints, RCS pods, stringers. */
let shipDetailCache: { steel: BufferGeometry; dark: BufferGeometry } | null = null
function shipDetail() {
  if (shipDetailCache) return shipDetailCache
  const H = VEHICLE.shipBodyLength
  const steel: BufferGeometry[] = []
  const dark: BufferGeometry[] = []
  // circumferential dome / tank welds (slightly proud bands)
  for (const y of [4.6, 20.4, 21.0, 29.6, H - 0.1]) steel.push(ring(R + 0.015, 0.045, y))
  // aft chines along the tile/steel boundary, fairing the flap roots
  for (const a of [TILE_START, TILE_START + TILE_LEN]) {
    const [x, z] = polar(R + 0.28, a)
    const g = new BoxGeometry(0.55, 13, 0.5)
    g.rotateY(a).translate(x, 7.2, z)
    steel.push(g)
    const [x2, z2] = polar(R + 0.12, a)
    steel.push(new BoxGeometry(0.3, 18, 0.25).rotateY(a).translate(x2, 22, z2))
  }
  // raceway clamps every 2.4 m
  for (let y = 3; y < H - 1; y += 2.4) steel.push(boxAt(1.0, 0.14, 0.55, 0, y, R + 0.2))
  // chopstick catch hardpoints
  for (const sx of [-1, 1]) steel.push(boxAt(0.9, 1.1, 1.3, sx * (R + 0.35), H - 3.2, 0.4))
  // RCS thruster pods (fore and aft, leeward quadrants)
  for (const [a, y] of [[0.55, H - 1.5], [-0.55, H - 1.5], [0.7, 2.6], [-0.7, 2.6]] as [number, number][]) {
    const [x, z] = polar(R + 0.12, a)
    dark.push(boxAt(0.7, 0.55, 0.3, x, y, z, a))
  }
  // aft skirt umbilical / quick-disconnect plate
  dark.push(boxAt(2.2, 1.6, 0.12, 0, 1.4, R + 0.05))
  // skirt stringers near the engine bay
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2
    const [x, z] = polar(R + 0.03, a)
    steel.push(boxAt(0.1, 2.2, 0.06, x, 1.1, z, a))
  }
  shipDetailCache = { steel: merged(steel), dark: merged(dark) }
  return shipDetailCache
}

let boosterDetailCache: { steel: BufferGeometry; dark: BufferGeometry } | null = null
function boosterDetail() {
  if (boosterDetailCache) return boosterDetailCache
  const H = VEHICLE.boosterLength
  const steel: BufferGeometry[] = []
  const dark: BufferGeometry[] = []
  for (const y of [5.2, 40.6, 41.2, 66.8, H - 1.85]) steel.push(ring(R + 0.015, 0.05, y))
  for (let y = 5; y < H - 8; y += 2.4) steel.push(boxAt(1.15, 0.15, 0.62, 0, y, R + 0.22))
  // second, smaller conduit on the opposite side
  steel.push(boxAt(0.45, H - 20, 0.25, 0, (H - 20) / 2 + 8, -(R + 0.1)))
  // aft skirt stringers + engine-bay access panels
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * Math.PI * 2
    const [x, z] = polar(R + 0.03, a)
    steel.push(boxAt(0.1, 3.2, 0.07, x, 1.6, z, a))
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.3
    const [x, z] = polar(R + 0.06, a)
    dark.push(boxAt(1.4, 1.1, 0.1, x, 4.2, z, a))
  }
  // vent ports near the top of the LOX tank
  for (const a of [1.2, 4.3]) {
    const [x, z] = polar(R + 0.04, a)
    dark.push(boxAt(0.8, 0.5, 0.08, x, 64.5, z, a))
  }
  boosterDetailCache = { steel: merged(steel), dark: merged(dark) }
  return boosterDetailCache
}

let boosterGeoCache: ReturnType<typeof buildBoosterGeometry> | null = null
function buildBoosterGeometry() {
  const H = VEHICLE.boosterLength
  const body = new CylinderGeometry(R, R, H - 1.8, 128, 1, true).translate(0, (H - 1.8) / 2, 0)
  const ring = new CylinderGeometry(R * 0.99, R * 0.99, 1.8, 128, 1, true).translate(0, H - 0.9, 0)
  const cap = new CircleGeometry(R * 0.99, 64).rotateX(-Math.PI / 2).translate(0, H - 0.05, 0)
  const shield = new CircleGeometry(R - 0.04, 64).rotateX(Math.PI / 2).translate(0, 1.6, 0)
  const fin = gridFinGeometry(3.3, 3.8, 0.55, 7)
  fin.rotateX(Math.PI / 2)
  fin.translate(0, 0, -1.9)
  const finRoot = new BoxGeometry(0.9, 1.4, 2.2)
  const raceway = new BoxGeometry(0.85, H - 12, 0.46).translate(0, (H - 12) / 2 + 4, R + 0.18)
  const pin = new BoxGeometry(1.1, 0.9, 1.0)
  return { body, ring, cap, shield, fin, finRoot, raceway, pin }
}
const boosterGeo = () => (boosterGeoCache ??= buildBoosterGeometry())

// ---------------------------------------------------------------------------
const ProceduralSuperHeavy = forwardRef<Group, { controls: PlumeControls; shadows?: boolean }>(function ProceduralSuperHeavy({ controls, shadows = true }, ref) {
  const g = boosterGeo()
  const m = vehicleMaterials()
  const slots = useMemo(() => boosterEngineLayout(), [])
  const H = VEHICLE.boosterLength
  return (
    <group ref={ref}>
      <mesh geometry={g.body} material={m.boosterSteel} castShadow={shadows} receiveShadow={shadows} />
      <mesh geometry={g.ring} material={m.hotStage} castShadow={shadows} />
      <mesh geometry={g.cap} material={m.darkShield} />
      <mesh geometry={g.shield} material={m.darkShield} />
      <mesh geometry={g.raceway} material={m.plainSteel} castShadow={shadows} />
      <mesh geometry={boosterDetail().steel} material={m.plainSteel} castShadow={shadows} receiveShadow={shadows} />
      <mesh geometry={boosterDetail().dark} material={m.darkShield} />
      {[45, 135, 225, 315].map((a) => (
        <group key={a} rotation-y={a * DEG} position-y={H - 7.8}>
          <mesh geometry={g.fin} material={m.gridFin} position-x={R + 0.55} castShadow={shadows} />
          <mesh geometry={g.finRoot} material={m.plainSteel} position={[R + 0.3, 0.2, 0]} castShadow={shadows} />
        </group>
      ))}
      {[0, 180].map((a) => (
        <mesh key={a} geometry={g.pin} material={m.plainSteel} rotation-y={a * DEG} position={[Math.cos(a * DEG) * (R + 0.4), H - 4.5, 0]} castShadow={shadows} />
      ))}
      <EngineCluster slots={slots} controls={controls} merged={{ radius: 4.3, kind: 'booster' }} />
    </group>
  )
})

// ---------------------------------------------------------------------------
const ProceduralStarship = forwardRef<Group, { controls: VehicleControls; legs?: boolean; plasma?: boolean; shadows?: boolean }>(function ProceduralStarship(
  { controls, legs = false, plasma = false, shadows = true },
  ref,
) {
  const g = shipGeo()
  const m = vehicleMaterials()
  const slots = useMemo(() => shipEngineLayout(), [])
  const aftR = useRef<Group>(null!)
  const aftLft = useRef<Group>(null!)
  const fwdR = useRef<Group>(null!)
  const fwdLft = useRef<Group>(null!)
  const H = VEHICLE.shipBodyLength

  // forward flap hinge follows the ogive surface
  const fwdY = 2.2
  const fwdRootR = noseRadiusAt(fwdY + 3.6) + 0.05
  const tilt = Math.atan2(noseRadiusAt(fwdY) - noseRadiusAt(fwdY + 7.2), 7.2)
  const cant = 20 * DEG

  useFrame(() => {
    const a = controls.flapAft * DEG
    const f = controls.flapFwd * DEG
    aftR.current.rotation.y = -a
    aftLft.current.rotation.y = -a
    fwdR.current.rotation.y = -f
    fwdLft.current.rotation.y = -f
  })

  const flap = (w: typeof g.aftW, l: typeof g.aftL) => (
    <>
      <mesh geometry={w} material={m.flapTiles} castShadow={shadows} receiveShadow={shadows} />
      <mesh geometry={l} material={m.plainSteel} castShadow={shadows} receiveShadow={shadows} />
    </>
  )

  return (
    <group ref={ref}>
      <mesh geometry={g.bodyTiles} material={m.bodyTiles} castShadow={shadows} receiveShadow={shadows} />
      <mesh geometry={g.bodySteel} material={m.shipSteel} castShadow={shadows} receiveShadow={shadows} />
      <mesh geometry={g.noseTiles} material={m.noseTiles} castShadow={shadows} receiveShadow={shadows} />
      <mesh geometry={g.noseSteel} material={m.noseSteel} castShadow={shadows} receiveShadow={shadows} />
      <mesh geometry={g.shield} material={m.darkShield} />
      <mesh geometry={g.raceway} material={m.plainSteel} castShadow={shadows} />
      <mesh geometry={shipDetail().steel} material={m.plainSteel} castShadow={shadows} receiveShadow={shadows} />
      <mesh geometry={shipDetail().dark} material={m.darkShield} />

      {/* aft flaps: hinge line on the tile/steel boundary */}
      <group position={[R - 0.12, 1.0, 0]}>
        <group ref={aftR}>{flap(g.aftW, g.aftL)}</group>
      </group>
      <group position={[-(R - 0.12), 1.0, 0]} scale={[-1, 1, 1]}>
        <group ref={aftLft}>{flap(g.aftW, g.aftL)}</group>
      </group>

      {/* forward flaps: canted toward the leeward side, tilted to follow the nose */}
      <group position-y={H + fwdY} rotation-y={-cant}>
        <group position-x={fwdRootR - 0.05} rotation-z={tilt}>
          <group ref={fwdR}>{flap(g.fwdW, g.fwdL)}</group>
        </group>
      </group>
      <group position-y={H + fwdY} rotation-y={cant} scale={[-1, 1, 1]}>
        <group position-x={fwdRootR - 0.05} rotation-z={tilt}>
          <group ref={fwdLft}>{flap(g.fwdW, g.fwdL)}</group>
        </group>
      </group>

      <EngineCluster slots={slots} controls={controls} merged={{ radius: 4.0, kind: 'ship' }} />
      {legs && <LandingLegs controls={controls} />}
      {plasma && <PlasmaSheath controls={controls} />}
    </group>
  )
})

// ---------------------------------------------------------------------------
// Public components: the detailed Block 3 model on medium/high quality,
// the lightweight procedural vehicle on low quality.
// ---------------------------------------------------------------------------
const useDetailed = () => useMission((s) => s.quality) !== 'low'

function ModelSuperHeavy({ controls }: { controls: PlumeControls }) {
  const model = useVehicleModel()
  const root = useStageInstance(model.booster)
  return (
    <group>
      <primitive object={root} />
      <EngineCluster slots={model.booster.slots} controls={controls} merged={{ radius: 4.3, kind: 'booster' }} hardware={false} />
    </group>
  )
}

function ModelStarship({ controls, legs, plasma }: { controls: VehicleControls; legs?: boolean; plasma?: boolean }) {
  const model = useVehicleModel()
  const root = useStageInstance(model.ship, () => ({ fwd: controls.flapFwd, aft: controls.flapAft }))
  return (
    <group>
      <primitive object={root} />
      <EngineCluster slots={model.ship.slots} controls={controls} merged={{ radius: 4.0, kind: 'ship' }} hardware={false} />
      {legs && <LandingLegs controls={controls} />}
      {plasma && <PlasmaSheath controls={controls} />}
    </group>
  )
}

export const SuperHeavy = forwardRef<Group, { controls: PlumeControls; shadows?: boolean }>(function SuperHeavy(props, ref) {
  const detailed = useDetailed()
  return <group ref={ref}>{detailed ? <ModelSuperHeavy controls={props.controls} /> : <ProceduralSuperHeavy {...props} />}</group>
})

export const Starship = forwardRef<Group, { controls: VehicleControls; legs?: boolean; plasma?: boolean; shadows?: boolean }>(function Starship(props, ref) {
  const detailed = useDetailed()
  return <group ref={ref}>{detailed ? <ModelStarship controls={props.controls} legs={props.legs} plasma={props.plasma} /> : <ProceduralStarship {...props} />}</group>
})

// ---------------------------------------------------------------------------
function LandingLegs({ controls }: { controls: VehicleControls }) {
  const m = vehicleMaterials()
  const sleeves = useRef<Mesh[]>([])
  const rods = useRef<Mesh[]>([])
  const feet = useRef<Mesh[]>([])
  const geo = useMemo(
    () => ({
      sleeve: new CylinderGeometry(0.32, 0.36, 1, 16).translate(0, 0.5, 0),
      rod: new CylinderGeometry(0.2, 0.2, 1, 12).translate(0, 0.5, 0),
      foot: new CylinderGeometry(0.8, 0.95, 0.28, 24),
    }),
    [],
  )
  const angles = [30, 90, 150, 210, 270, 330]
  const up = useMemo(() => new Vector3(0, 1, 0), [])
  const tmp = useMemo(() => ({ a: new Vector3(), f: new Vector3(), d: new Vector3() }), [])

  useFrame(() => {
    const k = controls.legs
    angles.forEach((deg, i) => {
      const c = Math.cos(deg * DEG)
      const s = Math.sin(deg * DEG)
      const anchorR = 4.05
      const footR = 4.3 + (6.3 - 4.3) * k
      const footY = 0.9 + (-VEHICLE.legReach + 0.14 - 0.9) * k
      tmp.a.set(anchorR * c, 5.2, anchorR * s)
      tmp.f.set(footR * c, footY, footR * s)
      tmp.d.subVectors(tmp.f, tmp.a)
      const len = tmp.d.length()
      tmp.d.normalize()
      const sl = sleeves.current[i]
      const rd = rods.current[i]
      const ft = feet.current[i]
      if (!sl || !rd || !ft) return
      sl.position.copy(tmp.a)
      sl.quaternion.setFromUnitVectors(up, tmp.d)
      sl.scale.set(1, Math.min(3.6, len), 1)
      rd.position.copy(tmp.a)
      rd.quaternion.copy(sl.quaternion)
      rd.scale.set(1, len, 1)
      ft.position.copy(tmp.f)
      sl.visible = rd.visible = ft.visible = k > 0.01
    })
  })

  return (
    <group>
      {angles.map((a, i) => (
        <group key={a}>
          <mesh ref={(el) => void (el && (sleeves.current[i] = el))} geometry={geo.sleeve} material={m.plainSteel} castShadow />
          <mesh ref={(el) => void (el && (rods.current[i] = el))} geometry={geo.rod} material={m.legMetal} castShadow />
          <mesh ref={(el) => void (el && (feet.current[i] = el))} geometry={geo.foot} material={m.darkShield} castShadow receiveShadow />
        </group>
      ))}
    </group>
  )
}

// ---------------------------------------------------------------------------
function PlasmaSheath({ controls }: { controls: VehicleControls }) {
  const g = shipGeo()
  const mk = (mode: number, side: Side) =>
    new ShaderMaterial({
      ...plasmaShader,
      uniforms: { uTime: { value: 0 }, uIntensity: { value: 0 }, uMode: { value: mode }, uFlowL: { value: new Vector3(0, 0, 1) } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side,
    })
  const sheath = useMemo(() => mk(0, FrontSide), [])
  const wake = useMemo(() => mk(1, DoubleSide), [])
  const group = useRef<Group>(null!)
  const wakeRef = useRef<Group>(null!)
  const inv = useMemo(() => new Quaternion(), [])
  const Zp = useMemo(() => new Vector3(0, 0, 1), [])
  useFrame(() => {
    const p = controls.plasma
    group.current.visible = p > 0.002
    if (p <= 0.002) return
    const s = runtime.state
    // world airflow → ship-local
    inv.copy(s.shipQuat).invert()
    const flowL = sheath.uniforms.uFlowL.value.copy(s.flowDir).applyQuaternion(inv).normalize()
    wake.uniforms.uFlowL.value.copy(flowL)
    wakeRef.current.quaternion.setFromUnitVectors(Zp, flowL)
    for (const mat of [sheath, wake]) {
      mat.uniforms.uTime.value = runtime.t
      mat.uniforms.uIntensity.value = p
    }
  })
  return (
    <group ref={group}>
      <mesh geometry={g.sheathBody} material={sheath} renderOrder={7} />
      <mesh geometry={g.sheathNose} material={sheath} renderOrder={7} />
      <group ref={wakeRef} position={[0, 25, 0]}>
        <mesh geometry={g.wake} material={wake} renderOrder={8} />
      </group>
    </group>
  )
}
