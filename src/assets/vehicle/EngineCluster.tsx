import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { AdditiveBlending, BackSide, Color, CylinderGeometry, InstancedMesh, Matrix4, PlaneGeometry, Quaternion, ShaderMaterial, Vector3, type Mesh } from 'three'
import { runtime } from '../../mission/store'
import type { MissionState } from '../../mission/trajectory'
import { lerp, smoothstep } from '../../utils/math'
import { makeNoise3D } from '../../utils/proceduralTextures'
import { impingeShader, nozzleGlowShader, plumeJetShader, plumeVolumeShader } from '../../shaders/effects'
import { bellGeometry, powerheadGeometry, type EngineSlot, type EngineSpec } from './geometry'
import { vehicleMaterials } from './materials'

export interface PlumeControls {
  throttle: { booster: number; boostback: number; shipSL: number; shipVac: number }
  /** 0 = sea level, 1 = vacuum */
  expansion: number
  /** distance from the engine exit plane to the ground along the plume (m); Infinity in space */
  clearance: number
  /** ignition transient 0..1 (brief over-bright start-up) */
  flash?: number
}

export const createPlumeControls = (): PlumeControls => ({
  throttle: { booster: 0, boostback: 0, shipSL: 0, shipVac: 0 },
  expansion: 0,
  clearance: Infinity,
})

/** Unit capped cylinder (y from 0 at the exit plane to -1 at the tail), reshaped in the vertex shader. */
const unitVolume = (() => {
  const g = new CylinderGeometry(1, 1, 1, 28, 20, false)
  g.translate(0, -0.5, 0)
  return g
})()
const impingeGeo = new PlaneGeometry(2, 2).rotateX(-Math.PI / 2)

/** Ambient pressure (bar) around the vehicle, from the mission altitude (scale heights 7 km Earth, 11 km Mars). */
export function ambientPressure(s: MissionState) {
  const h = Math.max(0, s.altitudeKm)
  if (s.world === 'mars' || s.altitudeRef === 'MARS') return 0.0072 * Math.exp(-h / 11)
  return 1.013 * Math.exp(-h / 7)
}
const onMars = (s: MissionState) => s.world === 'mars' || s.altitudeRef === 'MARS'

interface JetPhys { U: number; vac: number; rMax: number; ls: number; spread: number; cell: number; diamond: number; coreLen: number; length: number }
/**
 * Pressure-driven jet shape. U = p_exit / p_ambient: the barrel opens ~√U, the
 * Mach disc and cell spacing move downstream ~√U, and above U ~ 10³ the jet is a
 * free (vacuum) expansion. Exit pressure follows chamber pressure (throttle).
 */
function jetPhysics(r0: number, th: number, pa: number, vacNozzle: boolean): JetPhys {
  const pe = (vacNozzle ? 0.25 : 0.9) * Math.max(0.35, th)
  const U = pa > 1e-9 ? pe / pa : 1e9
  const vac = smoothstep(1.6, 4.2, Math.log10(U))
  const d = 2 * r0
  const sq = Math.sqrt(Math.max(U, 0.5))
  const rMax = r0 * (U < 1 ? 0.9 + 0.1 * U : Math.min(Math.pow(U, 0.45), 30))
  return {
    U, vac, rMax,
    ls: Math.min(d * 0.7 * Math.max(1, sq), 60 * r0),
    spread: 0.07 * (1 - vac),
    cell: d * (1 + 0.6 * Math.min(sq, 12)),
    diamond: (1 - vac) / (1 + Math.pow(U / 10, 1.5)),
    coreLen: d * (4 + 1.5 * Math.min(sq, 5)),
    length: d * lerp(18 + 6 * Math.min(sq, 4), 7, vac),
  }
}

const COL = {
  core: new Color(0.3, 0.34, 1.0).multiplyScalar(0.55),
  shock: new Color(1.0, 0.84, 0.78),
  hot: new Color(1.0, 0.7, 0.34),
  cool: new Color(1.0, 0.4, 0.13),
  marsHot: new Color(1.0, 0.6, 0.42),
  marsCool: new Color(0.75, 0.42, 0.42),
  vacCore: new Color(0.5, 0.56, 1.0).multiplyScalar(0.6),
  vacShock: new Color(0.78, 0.84, 1.0),
  impHot: new Color(1.0, 0.78, 0.5),
  wall: new Color(1.0, 0.5, 0.2),
  marsWall: new Color(0.85, 0.5, 0.32),
}

function makePlumeMaterial(shader: { vertexShader: string; fragmentShader: string }, extra: Record<string, { value: unknown }> = {}) {
  return new ShaderMaterial({
    ...shader,
    uniforms: {
      tNoise: { value: makeNoise3D() },
      uTime: { value: 0 }, uThrottle: { value: 0 }, uIntensity: { value: 1 }, uBound: { value: 1.3 },
      uLength: { value: 10 }, uR0: { value: 1 }, uRMax: { value: 1 }, uLs: { value: 1 }, uSpread: { value: 0 },
      uGround: { value: 1e6 }, uWall: { value: 0 }, uFlow: { value: 120 }, uAfter: { value: 1 }, uVac: { value: 0 },
      uColCore: { value: COL.core.clone() }, uColShock: { value: COL.shock.clone() }, uColHot: { value: COL.hot.clone() }, uColCool: { value: COL.cool.clone() },
      ...extra,
    },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: BackSide,
  })
}

const bellCache = new Map<EngineSpec, ReturnType<typeof bellGeometry>>()
const glowCache = new Map<EngineSpec, ReturnType<typeof bellGeometry>>()
const headCache = new Map<EngineSpec, ReturnType<typeof powerheadGeometry>>()
const bellGeo = (s: EngineSpec) => bellCache.get(s) ?? bellCache.set(s, bellGeometry(s)).get(s)!
const glowGeo = (s: EngineSpec) => glowCache.get(s) ?? glowCache.set(s, bellGeometry(s, 0.03)).get(s)!
const headGeo = (s: EngineSpec) => headCache.get(s) ?? headCache.set(s, powerheadGeometry(s)).get(s)!

/** Throttle for an engine group — inner booster engines also run during the main burn. */
const groupThrottle = (c: PlumeControls, g: EngineSlot['group']) =>
  g === 'boostback' ? Math.max(c.throttle.booster, c.throttle.boostback) : c.throttle[g]

interface Bucket {
  key: string
  spec: EngineSpec
  group: EngineSlot['group']
  slots: EngineSlot[]
}

/**
 * Engine cluster: instanced nozzle bells + powerheads + interior heat glow +
 * one exhaust jet per engine (with shock diamonds) + an optional merged
 * cluster plume. Everything is instanced per (engine type, throttle group).
 */
export function EngineCluster({ slots, controls, merged, hardware = true }: { slots: EngineSlot[]; controls: PlumeControls; merged?: { radius: number; kind: 'booster' | 'ship' }; hardware?: boolean }) {
  const mats = vehicleMaterials()
  const buckets = useMemo(() => {
    const map = new Map<string, Bucket>()
    for (const s of slots) {
      const key = `${s.spec.exitR}-${s.group}`
      if (!map.has(key)) map.set(key, { key, spec: s.spec, group: s.group, slots: [] })
      map.get(key)!.slots.push(s)
    }
    return [...map.values()]
  }, [slots])

  return (
    <group>
      {buckets.map((b) => (
        <EngineBucket key={b.key} bucket={b} controls={controls} mats={mats} hardware={hardware} />
      ))}
      {merged && <MergedPlume controls={controls} slots={slots} kind={merged.kind} />}
    </group>
  )
}

function EngineBucket({ bucket, controls, mats, hardware }: { bucket: Bucket; controls: PlumeControls; mats: ReturnType<typeof vehicleMaterials>; hardware: boolean }) {
  const bellRef = useRef<InstancedMesh>(null!)
  const headRef = useRef<InstancedMesh>(null!)
  const glowRef = useRef<InstancedMesh>(null!)
  const jetRef = useRef<InstancedMesh>(null!)
  const { spec, slots, group } = bucket
  const isVac = group === 'shipVac'
  const glowMat = useMemo(
    () =>
      new ShaderMaterial({
        ...nozzleGlowShader,
        uniforms: { uThrottle: { value: 0 }, uTime: { value: 0 }, uBellLength: { value: spec.bellLength } },
        side: BackSide,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    [spec],
  )
  const jetMat = useMemo(() => makePlumeMaterial(plumeJetShader, { uCell: { value: 2 }, uDiamond: { value: 1 }, uCoreLen: { value: 6 } }), [])

  useLayoutEffect(() => {
    const m = new Matrix4()
    slots.forEach((s, i) => {
      const y = s.y ?? -0.15
      m.makeTranslation(s.x, y, s.z)
      bellRef.current.setMatrixAt(i, m)
      headRef.current.setMatrixAt(i, m)
      glowRef.current.setMatrixAt(i, m)
      m.makeTranslation(s.x, y + 0.05, s.z)
      jetRef.current.setMatrixAt(i, m)
    })
    for (const r of [bellRef, headRef, glowRef, jetRef]) {
      r.current.instanceMatrix.needsUpdate = true
      r.current.computeBoundingSphere()
    }
  }, [slots])

  useFrame(() => {
    const th = groupThrottle(controls, group)
    const t = runtime.t
    glowMat.uniforms.uThrottle.value = th
    glowMat.uniforms.uTime.value = t
    jetRef.current.visible = th > 0.001
    glowRef.current.visible = th > 0.001
    if (th <= 0.001) return
    const st = runtime.state
    const pa = ambientPressure(st)
    const mars = onMars(st)
    const r0 = spec.exitR * 0.97
    const P = jetPhysics(r0, th, pa, isVac)
    const u = jetMat.uniforms
    u.uThrottle.value = th
    u.uTime.value = t
    u.uR0.value = r0
    u.uRMax.value = P.rMax
    u.uLs.value = P.ls
    u.uSpread.value = P.spread
    u.uCell.value = P.cell
    u.uDiamond.value = P.diamond * (mars ? 0.7 : 1)
    u.uCoreLen.value = P.coreLen
    // chamber pressure sets how far the luminous jet reaches: a low-throttle trim burn is short
    u.uLength.value = P.length * (0.45 + 0.55 * th)
    u.uGround.value = Number.isFinite(controls.clearance) ? controls.clearance : 1e6
    u.uFlow.value = 90 + 60 * P.vac
    // afterburning needs entrained oxygen: none in vacuum, none in Mars' CO2
    u.uAfter.value = Math.pow(1 - P.vac, 0.7) * (mars ? 0.12 : 1)
    u.uVac.value = Math.max(P.vac, mars ? 0.35 : 0)
    u.uColCore.value.copy(isVac ? COL.vacCore : COL.core)
    u.uColShock.value.copy(isVac ? COL.vacShock : COL.shock)
    u.uColHot.value.copy(mars ? COL.marsHot : COL.hot)
    u.uColCool.value.copy(mars ? COL.marsCool : COL.cool)
    const fl = 1 + 1.8 * (controls.flash ?? 0)
    u.uIntensity.value = (isVac ? 2.2 : 3.2) * fl
  })

  const n = slots.length
  return (
    <group>
      <instancedMesh ref={bellRef} args={[bellGeo(spec), mats.engineBell, n]} castShadow receiveShadow frustumCulled={false} visible={hardware} />
      <instancedMesh ref={headRef} args={[headGeo(spec), mats.enginePowerhead, n]} castShadow frustumCulled={false} visible={hardware} />
      <instancedMesh ref={glowRef} args={[glowGeo(spec), glowMat, n]} frustumCulled={false} renderOrder={5} />
      <instancedMesh ref={jetRef} args={[unitVolume, jetMat, n]} frustumCulled={false} renderOrder={6} />
    </group>
  )
}

/**
 * The merged cluster plume. Downstream of the engines the jets coalesce into one
 * column; as ambient pressure falls the whole cluster's envelope balloons into a
 * single huge, softer glow, and in vacuum it all but vanishes. Where the column
 * reaches the ground it spreads into a radial wall jet with a hot stagnation spot.
 */
function MergedPlume({ controls, slots, kind }: { controls: PlumeControls; slots: EngineSlot[]; kind: 'booster' | 'ship' }) {
  const ref = useRef<Mesh>(null!)
  const impRef = useRef<Mesh>(null!)
  const mat = useMemo(() => makePlumeMaterial(plumeVolumeShader, { uStart: { value: 5 }, uDecay: { value: 40 }, uFill: { value: 0.6 }, uImpinge: { value: 0 } }), [])
  const imp = useMemo(
    () =>
      new ShaderMaterial({
        ...impingeShader,
        uniforms: {
          tNoise: { value: makeNoise3D() }, uIntensity: { value: 0 }, uTime: { value: 0 }, uCore: { value: 0.2 },
          uColHot: { value: new Color(1.0, 0.78, 0.5) }, uColWall: { value: new Color(1.0, 0.5, 0.2) },
        },
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    [],
  )
  // cluster radius per throttle group (outermost exit rim) and the exit-plane height
  const geo = useMemo(() => {
    const rOf = (f: (s: EngineSlot) => boolean) => Math.max(0.5, ...slots.filter(f).map((s) => Math.hypot(s.x, s.z) + s.spec.exitR))
    const y = slots.reduce((m, s) => Math.min(m, s.y ?? -0.15), 0)
    return { all: rOf(() => true), inner: rOf((s) => s.group !== 'booster'), sl: rOf((s) => s.group === 'shipSL'), y }
  }, [slots])
  const tmp = useMemo(() => ({ c: new Vector3(), a: new Vector3(), q: new Quaternion(), sc: new Vector3(), m: new Matrix4() }), [])
  const imp$ = useRef({ dist: 0, radius: 1, scale: 1 })

  useFrame(() => {
    const c = controls
    const st = runtime.state
    const boost = kind === 'booster'
    const th = boost ? Math.max(c.throttle.booster, c.throttle.boostback * 0.6) : Math.max(c.throttle.shipSL * 0.85, c.throttle.shipVac)
    ref.current.visible = th > 0.001
    impRef.current.visible = false
    if (th <= 0.001) return
    const pa = ambientPressure(st)
    const mars = onMars(st)
    const Rc = boost ? (c.throttle.booster > 0.01 ? geo.all : geo.inner) : c.throttle.shipVac > 0.01 ? geo.all : geo.sl
    const P = jetPhysics(Rc, th, pa, !boost && c.throttle.shipVac > c.throttle.shipSL)
    const u = mat.uniforms
    const R0 = Rc * 0.9
    // envelope: the jets' own barrels plus the cluster footprint, capped at ~20 cluster radii
    const rMax = P.U < 1 ? Rc : Rc * (1 + 0.5 * (Math.min(Math.pow(P.U, 0.45), 40) - 1))
    const base = boost ? 260 : 70
    const L = Math.min(boost ? 520 : 260, Math.max(base, 3.4 * rMax)) * (0.35 + 0.65 * th)
    const ground = Number.isFinite(c.clearance) ? c.clearance : 1e6
    u.uThrottle.value = th
    u.uTime.value = runtime.t
    u.uR0.value = R0
    u.uRMax.value = rMax
    u.uLs.value = 1.1 * rMax + 4
    // sea-level Raptor clusters stay well collimated for a vehicle length or more (launch photography)
    u.uSpread.value = 0.055 * (1 - P.vac)
    u.uLength.value = L
    u.uGround.value = ground
    u.uWall.value = ground < L ? 1.4 : 0
    u.uStart.value = lerp(boost ? 7 : 4, 1.5, smoothstep(0, 2.5, Math.log10(Math.max(P.U, 1))))
    u.uDecay.value = L * (0.72 + 0.1 * P.vac)
    u.uFill.value = lerp(0.55, 0.9, smoothstep(0, 2, Math.log10(Math.max(P.U, 1))))
    u.uImpinge.value = ground < L ? 2.5 : 0
    u.uFlow.value = 140 + 160 * smoothstep(0, 3, Math.log10(Math.max(P.U, 1)))
    u.uAfter.value = Math.pow(1 - P.vac, 0.6) * (mars ? 0.18 : 1)
    u.uVac.value = P.vac
    u.uColHot.value.copy(mars ? COL.marsHot : COL.hot)
    u.uColCool.value.copy(mars ? COL.marsCool : COL.cool)
    u.uColCore.value.copy(COL.vacCore)
    // a ballooning envelope spreads the same light over more area: soften it a little, not all the way
    const soft = 1 / (1 + 0.15 * Math.max(0, rMax / Rc - 1))
    // a free vacuum expansion is almost invisible: only the dense core near the exits radiates
    const dense = mars ? 1 : lerp(1, 3.2, Math.max(0, 1 - P.vac * 1.3))
    u.uIntensity.value = (boost ? 1.6 : 1.0) * dense * (0.55 + 0.45 * soft) * (1 + 1.5 * (c.flash ?? 0)) * lerp(1, 0.05, P.vac)
    // ground interaction
    if (ground < L) {
      const s = ground
      const Rg = R0 + (rMax - R0) * (1 - Math.exp(-s / (1.1 * rMax + 4))) + 0.085 * (1 - P.vac) * s
      imp$.current.dist = s
      imp$.current.radius = Rg * 2.8 + 6
      const k = 1 - smoothstep(0.35 * L, L, s)
      imp.uniforms.uIntensity.value = th * k * (mars ? 1.1 : 2.4) * (1 + 1.5 * (c.flash ?? 0))
      imp.uniforms.uTime.value = runtime.t
      imp.uniforms.uCore.value = Math.min(0.5, Rg / imp$.current.radius)
      imp.uniforms.uColWall.value.copy(mars ? COL.marsWall : COL.wall)
      imp.uniforms.uColHot.value.copy(mars ? COL.marsHot : COL.impHot)
      impRef.current.visible = k > 0.001
    }
  })

  // place the impingement disc on the world ground plane where the plume axis meets it
  const onBeforeRender = useMemo(
    () => (_r: unknown, _s: unknown, _c: unknown) => {
      const g = ref.current
      if (!g) return
      g.matrixWorld.decompose(tmp.c, tmp.q, tmp.sc)
      const scale = tmp.sc.x
      tmp.a.set(0, -1, 0).applyQuaternion(tmp.q)
      const drop = tmp.c.y - 0.25
      const t = tmp.a.y < -0.2 ? drop / -tmp.a.y : imp$.current.dist * scale
      const hit = tmp.c.addScaledVector(tmp.a, t)
      hit.y = 0.25
      const r = imp$.current.radius * scale
      impRef.current.matrixWorld.compose(hit, tmp.q.identity(), tmp.sc.set(r, r, r))
    },
    [tmp],
  )

  return (
    <group>
      <mesh ref={ref} geometry={unitVolume} material={mat} position={[0, geo.y, 0]} frustumCulled={false} renderOrder={4} />
      <mesh ref={impRef} geometry={impingeGeo} material={imp} matrixAutoUpdate={false} matrixWorldAutoUpdate={false} frustumCulled={false} renderOrder={4} onBeforeRender={onBeforeRender} />
    </group>
  )
}
