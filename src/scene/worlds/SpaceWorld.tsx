import { useFrame, useThree } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import { Color, FogExp2, Group, Vector3 } from 'three'
import { Earth, Mars, Moon } from '../../assets/planets/Planets'
import { frameGlare, limitingMagnitude, Starfield, SunSprite, type GlareCapsule, type GlareSphere } from '../../assets/planets/Sky'
import { vehicleMaterials } from '../../assets/vehicle/materials'
import { Starship, SuperHeavy, createVehicleControls } from '../../assets/vehicle/Vehicle'
import { StagingEffects } from '../../effects/Emitters'
import { RcsJets } from '../../effects/RcsJets'
import { EARTH_RADIUS_KM, MARS_RADIUS_KM, VEHICLE } from '../../mission/constants'
import { lighting } from '../../mission/lighting'
import { runtime } from '../../mission/store'
import { smoothstep } from '../../utils/math'
import { rig } from '../sceneRefs'

const KM = 0.001

/** Camera exposure for the sky: a sunlit planet in frame forces short exposures; in deep cruise the stars come up. */
function skyExposure() {
  const t = runtime.state.t
  const deep = Math.min(1, Math.max(0, (t - 124) / 6)) * (1 - Math.min(1, Math.max(0, (t - 150) / 6)))
  return 1.1 + deep * 1.8
}

// --- exposure-limited star field: sunlit Earth / Mars / hull in frame -> short exposure -> fewer stars
const glareSpheres: GlareSphere[] = [
  { c: new Vector3(), r: EARTH_RADIUS_KM, albedo: 0.35 },
  { c: new Vector3(), r: MARS_RADIUS_KM, albedo: 0.25 },
]
const glareCaps: GlareCapsule[] = [
  { a: new Vector3(), axis: new Vector3(), len: 0, r: 0.0046, albedo: 0.5 },
  { a: new Vector3(), axis: new Vector3(), len: VEHICLE.boosterLength * KM, r: 0.0046, albedo: 0.5 },
]
const skyGlare = { value: 0, init: false }
const skyLimMag = () => limitingMagnitude(skyGlare.value, runtime.exposureEV)
const tmp = new Vector3()
const tmp2 = new Vector3()
const Y = new Vector3(0, 1, 0)

/** Fraction of the sun visible from the origin given a planet (soft umbra edge). */
function sunVisibility(center: Vector3, radius: number, sun: Vector3) {
  tmp.copy(center).negate() // ship relative to planet centre
  const b = tmp.dot(sun)
  if (b > 0) return 1
  const d = tmp2.copy(tmp).addScaledVector(sun, -b).length()
  return smoothstep(radius * 0.995, radius * 1.012, d)
}

/**
 * Space world — kilometres, floating origin: the ship's centre is always at
 * (0,0,0). Planets, sun and booster move around it. This keeps float precision
 * perfect for a 50 m vehicle next to a 12,742 km planet.
 */
export function SpaceWorld() {
  const { scene, camera } = useThree()
  const group = useRef<Group>(null!)
  const shipRef = useRef<Group>(null!)
  const boosterRef = useRef<Group>(null!)
  const ship = useMemo(createVehicleControls, [])
  const booster = useMemo(createVehicleControls, [])

  useFrame((_, delta) => {
    const s = runtime.state
    const active = s.world === 'space'
    group.current.visible = active
    if (!active) {
      skyGlare.init = false
      return
    }
    const m = vehicleMaterials()
    const t = s.t

    // ship: centre of the vehicle sits at the origin
    shipRef.current.quaternion.copy(s.shipQuat)
    shipRef.current.position.copy(Y).applyQuaternion(s.shipQuat).multiplyScalar(-(VEHICLE.shipLength / 2) * KM)
    ship.throttle.shipSL = s.shipThrottleSL
    ship.throttle.shipVac = s.shipThrottleVac
    ship.expansion = s.plumeExpansion
    ship.clearance = Infinity
    ship.flapFwd = s.flapFwd
    ship.flapAft = s.flapAft
    ship.plasma = s.plasma
    ship.flash = s.ignitionFlash
    m.nozzleHeat.shipVac.value = s.heatVac
    m.nozzleHeat.shipSL.value = s.heatSL
    m.nozzleHeat.booster.value = s.heatBooster
    boosterRef.current.position.copy(s.booster.pos)
    boosterRef.current.quaternion.copy(s.booster.quat)
    boosterRef.current.visible = t < 75
    booster.throttle.booster = s.boosterThrottle
    booster.throttle.boostback = s.boosterBoostback
    booster.expansion = s.plumeExpansion

    m.boosterSteel.userData.uniforms.uFrost.value = 0
    m.shipSteel.userData.uniforms.uFrost.value = 0
    m.hotStage.emissiveIntensity = s.hotStage * 14
    for (const tm of [m.bodyTiles, m.noseTiles, m.flapTiles, ...m.modelTiles]) tm.emissiveIntensity = s.tileGlow * 1.1

    // --- light: the sun is eclipsed by whichever planet is between it and us
    const sun = s.sunDir
    const nearEarth = s.earthCenter.length() < EARTH_RADIUS_KM * 4
    const nearMars = s.marsCenter.length() < MARS_RADIUS_KM * 4
    let vis = 1
    if (nearEarth) vis = Math.min(vis, sunVisibility(s.earthCenter, EARTH_RADIUS_KM, sun))
    if (nearMars) vis = Math.min(vis, sunVisibility(s.marsCenter, MARS_RADIUS_KM, sun))
    if (rig.sun) {
      rig.sun.color.setRGB(1, 0.98, 0.95)
      rig.sun.intensity = 4.2 * vis
      rig.sun.target.position.set(0, 0, 0)
      rig.sun.position.copy(sun).multiplyScalar(0.5)
      rig.sun.target.updateMatrixWorld()
      const cam = rig.sun.shadow.camera
      const ext = t < 67 ? 0.09 : 0.045
      cam.left = cam.bottom = -ext
      cam.right = cam.top = ext
      cam.near = 0.01
      cam.far = 1.2
      cam.updateProjectionMatrix()
    }
    // --- planet-shine from below (blue earthshine / rusty marsshine)
    if (rig.hemi) {
      const eD = s.earthCenter.length()
      const mD = s.marsCenter.length()
      const eSolid = Math.min(1, Math.pow(EARTH_RADIUS_KM / eD, 2))
      const mSolid = Math.min(1, Math.pow(MARS_RADIUS_KM / mD, 2))
      const ePhase = 0.5 * (1 + tmp.copy(s.earthCenter).negate().normalize().dot(sun))
      const mPhase = 0.5 * (1 + tmp.copy(s.marsCenter).negate().normalize().dot(sun))
      rig.hemi.color.setRGB(0.012, 0.014, 0.02)
      rig.hemi.groundColor.setRGB(0.3, 0.42, 0.6).multiplyScalar(eSolid * ePhase * 1.4)
      rig.hemi.groundColor.r += 0.55 * mSolid * mPhase * 1.2
      rig.hemi.groundColor.g += 0.3 * mSolid * mPhase * 1.2
      rig.hemi.groundColor.b += 0.2 * mSolid * mPhase * 1.2
      rig.hemi.intensity = 1
    }
    // --- engine / plasma light
    const shipTh = Math.max(s.shipThrottleSL, s.shipThrottleVac)
    if (rig.engine) {
      if (s.plasma > 0.01) {
        rig.engine.position.set(0, -0.012, 0.01)
        rig.engine.color.setRGB(1, 0.45, 0.4)
        rig.engine.intensity = s.plasma * 0.004
      } else if (s.hotStage > 0.01 || s.boosterThrottle > 0.01) {
        rig.engine.position.copy(s.booster.pos).addScaledVector(tmp.copy(Y).applyQuaternion(s.booster.quat), 71 * KM)
        rig.engine.color.setRGB(1, 0.55, 0.25)
        rig.engine.intensity = Math.max(s.hotStage, 0.2) * 0.012
      } else {
        rig.engine.position.copy(Y).applyQuaternion(s.shipQuat).multiplyScalar(-0.03)
        rig.engine.color.setRGB(0.85, 0.7, 1)
        rig.engine.intensity = shipTh * 0.0025
      }
      rig.engine.distance = 0
    }
    // scene glare for the stars' limiting magnitude (eased like an auto-exposure loop)
    glareSpheres[0].c.copy(s.earthCenter)
    glareSpheres[1].c.copy(s.marsCenter)
    const ax = glareCaps[0].axis.copy(Y).applyQuaternion(s.shipQuat)
    glareCaps[0].len = VEHICLE.shipLength * KM
    glareCaps[0].a.copy(ax).multiplyScalar(-glareCaps[0].len / 2)
    glareCaps[1].axis.copy(Y).applyQuaternion(s.booster.quat)
    glareCaps[1].a.copy(s.booster.pos)
    glareCaps[1].r = t < 75 ? 0.0046 : 0
    camera.updateMatrixWorld()
    const gNow = frameGlare(camera, sun, glareSpheres, glareCaps, vis)
    skyGlare.value = skyGlare.init ? skyGlare.value + (gNow - skyGlare.value) * (1 - Math.exp(-4 * Math.min(delta, 0.1))) : gNow
    skyGlare.init = true

    lighting.sunDir.copy(sun)
    lighting.sunColor.setRGB(2.4, 2.35, 2.3).multiplyScalar(vis)
    lighting.ambient.setRGB(0.04, 0.05, 0.07)
    lighting.glowPos.copy(s.booster.pos).addScaledVector(tmp.copy(Y).applyQuaternion(s.booster.quat), 71 * KM)
    lighting.glowColor.setRGB(3, 1.3, 0.4).multiplyScalar(s.hotStage * 3)
    lighting.glowRadius = 0.02
    lighting.glowLen = 0

    const fog = (scene.fog as FogExp2 | null) ?? { color: new Color(), density: 0 }
    fog.density = 0
    scene.environment = (t > 150 ? rig.env.marsOrbit : t > 120 ? rig.env.deep : rig.env.earthOrbit) ?? null
  })

  return (
    <group ref={group}>
      <Starfield getIntensity={skyExposure} getQuat={() => runtime.state.skyQuat} getLimMag={skyLimMag} />
      <SunSprite getDir={() => runtime.state.sunDir} />
      <Earth />
      <Mars />
      <Moon />
      <group ref={shipRef}>
        <group scale={KM}>
          <Starship controls={ship} plasma />
          <RcsJets vehicle="ship" />
        </group>
      </group>
      <group ref={boosterRef}>
        <group scale={KM}>
          <SuperHeavy controls={booster} />
          <RcsJets vehicle="booster" />
        </group>
      </group>
      <StagingEffects />
    </group>
  )
}
