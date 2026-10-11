import { useFrame, useThree } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import { Color, FogExp2, Group, Vector3 } from 'three'
import { LaunchSite, cloudMaterials } from '../../assets/launchsite/LaunchSite'
import { cloudShift, siteToObject, useEarthMaps } from '../../assets/planets/Planets'
import { frameGlare, limitingMagnitude, SkyDome, Starfield, type DomeGround, type GlareCapsule, type GlareSphere } from '../../assets/planets/Sky'
import { vehicleMaterials } from '../../assets/vehicle/materials'
import { Starship, SuperHeavy, createVehicleControls } from '../../assets/vehicle/Vehicle'
import { LaunchSmoke } from '../../effects/Emitters'
import { EARTH_RADIUS_KM, LAUNCH_SITE, SUN_LAUNCH } from '../../mission/constants'
import { lighting } from '../../mission/lighting'
import { SKY_QUAT_EARTH } from '../../mission/ephemeris'
import { runtime } from '../../mission/store'
import { EARTH_ATMO, scatterJS, sunColorJS } from '../../shaders/atmosphere'
import { smoothstep } from '../../utils/math'
import { rig } from '../sceneRefs'

const GROUND = new Color(0.07, 0.075, 0.07)
const tmpV = new Vector3()
const tmpC = new Vector3()
const Y = new Vector3(0, 1, 0)
// exposure-limited stars: the sunlit stack and the ground below set the exposure (metres)
const glareSpheres: GlareSphere[] = [{ c: new Vector3(0, -EARTH_RADIUS_KM * 1000, 0), r: EARTH_RADIUS_KM * 1000, albedo: 0.2 }]
const glareCaps: GlareCapsule[] = [{ a: new Vector3(), axis: new Vector3(), len: 123, r: 4.6, albedo: 0.5 }]
const glare = { value: 0, init: false }

/** Earth launch world — metres, pad at the origin. Active from T-20 s to ~T+95 s. */
export function EarthWorld() {
  const { scene, camera } = useThree()
  const group = useRef<Group>(null!)
  const stack = useRef<Group>(null!)
  const booster = useMemo(createVehicleControls, [])
  const ship = useMemo(createVehicleControls, [])
  const camAlt = () => Math.max(0.002, camera.position.y / 1000)
  const cache = useMemo(() => ({ lastAlt: -1, fog: new Color(), sky: new Color(), sun: new Vector3(1, 1, 1) }), [])
  // the real, curved Earth (same maps as the orbital globe) fills the dome below the horizon
  const maps = useEarthMaps()
  const domeGround = useMemo<DomeGround>(
    () => ({ day: maps.day, clouds: maps.clouds, cloudCh: maps.cloudCh, siteToObj: siteToObject(LAUNCH_SITE.lat, LAUNCH_SITE.lon), groundE: 3.2, getCloudShift: cloudShift }),
    [maps],
  )

  useFrame((_, delta) => {
    const s = runtime.state
    const active = s.world === 'earth'
    group.current.visible = active
    if (!active) {
      glare.init = false
      return
    }
    const m = vehicleMaterials()

    stack.current.position.copy(s.stackBase)
    stack.current.quaternion.copy(s.stackQuat)
    booster.throttle.booster = s.boosterThrottle
    booster.throttle.boostback = 0
    booster.expansion = s.plumeExpansion
    booster.clearance = Math.max(0.5, s.stackBase.y - 0.3)
    ship.expansion = s.plumeExpansion
    m.nozzleHeat.shipVac.value = 0
    m.nozzleHeat.shipSL.value = 0
    m.nozzleHeat.booster.value = s.heatBooster * 0.6
    m.boosterSteel.userData.uniforms.uFrost.value = s.frost
    m.shipSteel.userData.uniforms.uFrost.value = s.frost
    m.hotStage.emissiveIntensity = 0
    for (const t of [m.bodyTiles, m.noseTiles, m.flapTiles, ...m.modelTiles]) t.emissiveIntensity = 0

    // --- atmosphere-consistent lighting (recomputed only when altitude changes noticeably)
    const altKm = Math.max(0.002, camera.position.y / 1000)
    if (Math.abs(altKm - cache.lastAlt) > 0.05 * Math.max(altKm, 0.2)) {
      cache.lastAlt = altKm
      const ro = tmpV.set(0, EARTH_RADIUS_KM + altKm, 0)
      const horiz = new Vector3(-SUN_LAUNCH.x, 0.03, -SUN_LAUNCH.z).normalize()
      scatterJS(EARTH_ATMO, ro, horiz, 1e9, SUN_LAUNCH, tmpC)
      cache.fog.setRGB(tmpC.x, tmpC.y, tmpC.z).multiplyScalar(0.9)
      scatterJS(EARTH_ATMO, ro, Y, 1e9, SUN_LAUNCH, tmpC)
      cache.sky.setRGB(tmpC.x, tmpC.y, tmpC.z)
      sunColorJS(EARTH_ATMO, altKm, SUN_LAUNCH, cache.sun)
    }
    const fog = (scene.fog as FogExp2 | null) ?? { color: new Color(), density: 0 }
    fog.color.copy(cache.fog)
    fog.density = 4.2e-5 * (0.12 + 0.88 * Math.exp(-altKm / 2.5))

    const sunI = 3.4
    if (rig.sun) {
      rig.sun.color.setRGB(cache.sun.x, cache.sun.y, cache.sun.z)
      rig.sun.intensity = sunI
      const focus = tmpV.copy(s.stackBase).addScaledVector(Y.clone().applyQuaternion(s.stackQuat), 55)
      rig.sun.target.position.copy(focus)
      rig.sun.position.copy(focus).addScaledVector(SUN_LAUNCH, 700)
      rig.sun.target.updateMatrixWorld()
      const cam = rig.sun.shadow.camera
      cam.left = cam.bottom = -170
      cam.right = cam.top = 170
      cam.near = 10
      cam.far = 1600
      cam.updateProjectionMatrix()
    }
    if (rig.hemi) {
      rig.hemi.color.copy(cache.sky).multiplyScalar(0.22)
      rig.hemi.groundColor.setRGB(0.16, 0.14, 0.11).multiplyScalar(smoothstep(20, 0, altKm) + 0.2)
      rig.hemi.intensity = 1
    }
    const th = s.boosterThrottle
    if (rig.engine) {
      rig.engine.position.copy(s.stackBase).add(tmpC.set(0, -6, 0))
      rig.engine.color.setRGB(1, 0.62, 0.3)
      rig.engine.intensity = th * 22000 * (0.9 + Math.random() * 0.2)
      rig.engine.distance = 0
    }
    glareCaps[0].a.copy(s.stackBase)
    glareCaps[0].axis.copy(Y).applyQuaternion(s.stackQuat)
    camera.updateMatrixWorld()
    const gNow = frameGlare(camera, SUN_LAUNCH, glareSpheres, glareCaps)
    glare.value = glare.init ? glare.value + (gNow - glare.value) * (1 - Math.exp(-4 * Math.min(delta, 0.1))) : gNow
    glare.init = true

    lighting.sunDir.copy(SUN_LAUNCH)
    lighting.sunColor.setRGB(cache.sun.x, cache.sun.y, cache.sun.z).multiplyScalar(2.6)
    lighting.ambient.copy(cache.sky).multiplyScalar(0.45)
    // the flame as a line source from the engine exits down to where it strikes the deck / ground
    lighting.glowPos.copy(s.stackBase).add(tmpC.set(0, -2, 0))
    lighting.glowLen = Math.max(0, Math.min(s.stackBase.y - 2, 120))
    // a 7,500-tf fire: steam next to it is lit harder than by the morning sun (launch photos burn out orange-white)
    lighting.glowColor.setRGB(3.2, 1.6, 0.6).multiplyScalar(th * 6.5)
    lighting.glowRadius = 48
    for (const cm of cloudMaterials) {
      cm.uniforms.uSunDir.value.copy(SUN_LAUNCH)
      cm.uniforms.uSunColor.value.setRGB(cache.sun.x, cache.sun.y, cache.sun.z).multiplyScalar(2.2)
      cm.uniforms.uAmbient.value.copy(cache.sky).multiplyScalar(0.55)
      cm.uniforms.uHaze.value.copy(cache.fog)
    }
    scene.environment = altKm > 6 ? rig.env.earthHigh ?? null : rig.env.earthGround ?? null
  })

  return (
    <group ref={group}>
      <Starfield
        getIntensity={() => smoothstep(9, 32, camAlt())}
        getQuat={() => SKY_QUAT_EARTH}
        getLimMag={() => limitingMagnitude(glare.value, runtime.exposureEV) - 3 * (1 - smoothstep(20, 60, camAlt()))}
      />
      <SkyDome params={EARTH_ATMO} getSun={() => SUN_LAUNCH} getAltKm={camAlt} groundAlbedo={GROUND} sunDisk={30} ground={domeGround} />
      <LaunchSite />
      <group ref={stack}>
        <SuperHeavy controls={booster} />
        <group position-y={71}>
          <Starship controls={ship} />
        </group>
      </group>
      <LaunchSmoke />
    </group>
  )
}

