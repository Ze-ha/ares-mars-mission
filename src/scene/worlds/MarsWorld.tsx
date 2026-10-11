import { useFrame, useThree } from '@react-three/fiber'
import { Suspense, useMemo, useRef } from 'react'
import { AdditiveBlending, Color, FogExp2, Group, Mesh, PlaneGeometry, ShaderMaterial, Vector3 } from 'three'
import { MarsSite } from '../../assets/mars/MarsSite'
import { SkyDome, Starfield } from '../../assets/planets/Sky'
import { vehicleMaterials } from '../../assets/vehicle/materials'
import { Starship, createVehicleControls } from '../../assets/vehicle/Vehicle'
import { LandingDust } from '../../effects/Emitters'
import { MARS_RADIUS_KM, SUN_MARS_SURFACE } from '../../mission/constants'
import { lighting } from '../../mission/lighting'
import { SKY_QUAT_MARS } from '../../mission/ephemeris'
import { runtime, useMission } from '../../mission/store'
import { Rover } from '../../explore/Rover'
import { EarthFromMars } from '../../explore/EarthFromMars'
import { DustDevils } from '../../explore/DustDevils'
import { exploreSky, rover, stepExploreSky } from '../../explore/exploreState'
import { MARS_ATMO, scatterJS, sunColorJS } from '../../shaders/atmosphere'
import { rig } from '../sceneRefs'

const GROUND = new Color(0.25, 0.14, 0.08)
const tmp = new Vector3()
const Y = new Vector3(0, 1, 0)

/** Mars landing world — metres, landing pad at the origin. */
export function MarsWorld() {
  const { scene, camera } = useThree()
  const group = useRef<Group>(null!)
  const lander = useRef<Group>(null!)
  const ctl = useMemo(createVehicleControls, [])
  const cache = useMemo(() => ({ lastAlt: -1, fog: new Color(), sky: new Color(), sun: new Vector3() }), [])
  const exploring = useMission((m) => m.exploring)
  // the sun (and sky) in use: fixed at landing, or following the real sol in explore mode
  const sunNow = () => (useMission.getState().exploring ? exploreSky.sun : SUN_MARS_SURFACE)
  const camAlt = () => Math.max(0.002, camera.position.y / 1000)
  // engine light pooling on the ground beneath the landing burn
  const glowRef = useRef<Mesh>(null!)
  const glowGeo = useMemo(() => new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), [])
  const glow = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: { uIntensity: { value: 0 }, uRadius: { value: 20 } },
        vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uRadius; varying vec2 vP;
void main(){ vP = position.xz * 2.0; vec3 p = position * uRadius * 4.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
#include <logdepthbuf_vertex>
}`,
        fragmentShader: `#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uIntensity; varying vec2 vP;
void main(){
#include <logdepthbuf_fragment>
if (uIntensity <= 0.001) discard;
float d = length(vP); float g = exp(-d * d * 9.0);
gl_FragColor = vec4(vec3(1.0, 0.55, 0.25) * g * uIntensity, 1.0); }`,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    [],
  )

  useFrame((_, rawDt) => {
    const s = runtime.state
    const active = s.world === 'mars'
    group.current.visible = active
    if (!active) return
    const ms = useMission.getState()
    if (ms.exploring) stepExploreSky(Math.min(0.1, runtime.fixedDt || rawDt), ms.night, ms.sunset)
    const SUN = sunNow()
    const night = ms.exploring ? exploreSky.night : 0
    const dayK = Math.min(1, Math.max(0, (SUN.y + 0.03) / 0.09))
    const m = vehicleMaterials()
    lander.current.position.copy(s.landerBase)
    lander.current.quaternion.copy(s.landerQuat)
    ctl.throttle.shipSL = s.shipThrottleSL
    ctl.throttle.shipVac = 0
    ctl.expansion = s.plumeExpansion
    const axisY = tmp.copy(Y).applyQuaternion(s.landerQuat).y
    ctl.clearance = axisY > 0.6 ? Math.max(0.3, (s.landerBase.y - 0.2) / axisY) : Infinity
    ctl.flapFwd = s.flapFwd
    ctl.flapAft = s.flapAft
    ctl.legs = s.legs
    ctl.plasma = 0
    ctl.flash = s.ignitionFlash
    m.nozzleHeat.shipVac.value = 0
    m.nozzleHeat.shipSL.value = s.heatSL
    m.shipSteel.userData.uniforms.uFrost.value = 0
    for (const tm of [m.bodyTiles, m.noseTiles, m.flapTiles, ...m.modelTiles]) tm.emissiveIntensity = s.tileGlow * 2.0

    const altKm = camAlt()
    if (Math.abs(altKm - cache.lastAlt) > 0.05 * Math.max(altKm, 0.2) || (ms.exploring && exploreSky.changed)) {
      cache.lastAlt = altKm
      const ro = new Vector3(0, MARS_RADIUS_KM + altKm, 0)
      const horiz = new Vector3(SUN.z, 0.04, -SUN.x).normalize()
      scatterJS(MARS_ATMO, ro, horiz, 1e9, SUN, tmp)
      cache.fog.setRGB(tmp.x, tmp.y, tmp.z)
      scatterJS(MARS_ATMO, ro, Y, 1e9, SUN, tmp)
      cache.sky.setRGB(tmp.x, tmp.y, tmp.z)
      sunColorJS(MARS_ATMO, altKm, SUN, cache.sun)
    }
    const fog = (scene.fog as FogExp2 | null) ?? { color: new Color(), density: 0 }
    fog.color.copy(cache.fog)
    fog.density = 2.6e-5 * (0.3 + 0.7 * Math.exp(-altKm / 6))

    if (rig.sun) {
      rig.sun.color.setRGB(cache.sun.x, cache.sun.y, cache.sun.z)
      rig.sun.intensity = 3.6 * dayK
      // centre the shadow map on where the ship's shadow falls — its approach reads altitude
      const c = ms.exploring ? tmp.copy(rover.pos).setY(Math.max(1, rover.pos.y + 1)) : tmp.copy(s.landerBase).addScaledVector(Y.clone().applyQuaternion(s.landerQuat), 25)
      const focus = new Vector3().copy(c).addScaledVector(SUN, -c.y / Math.max(SUN.y, 0.08))
      focus.lerp(c.setY(0), 0.5)
      rig.sun.target.position.copy(focus)
      rig.sun.position.copy(focus).addScaledVector(SUN, 2500)
      rig.sun.target.updateMatrixWorld()
      const cam = rig.sun.shadow.camera
      const ext = ms.exploring ? 45 : 130
      cam.left = cam.bottom = -ext
      cam.right = cam.top = ext
      cam.near = 10
      cam.far = 5000
      cam.updateProjectionMatrix()
    }
    if (rig.hemi) {
      rig.hemi.color.copy(cache.sky).multiplyScalar(0.3)
      rig.hemi.groundColor.setRGB(0.22, 0.12, 0.07)
      rig.hemi.intensity = 1
      // night: faint starlight / skyglow so the ground still reads in a long exposure
      if (night > 0) rig.hemi.color.lerp(new Color(0.05, 0.055, 0.075), night)
      if (night > 0) rig.hemi.groundColor.multiplyScalar(1 - 0.94 * night)
    }
    const th = s.shipThrottleSL
    if (rig.engine) {
      rig.engine.position.copy(s.landerBase).addScaledVector(tmp.copy(Y).applyQuaternion(s.landerQuat), -5)
      rig.engine.color.setRGB(1, 0.6, 0.32)
      const alt = Math.max(2, s.landerBase.y)
      rig.engine.intensity = th * 26000 * (0.92 + Math.random() * 0.16) * Math.min(1, 60 / alt + 0.15)
      glow.uniforms.uIntensity.value = th * Math.max(0, 1 - alt / 260) * 4.5
      glowRef.current.position.set(s.landerBase.x, 0.15, s.landerBase.z)
      glow.uniforms.uRadius.value = 12 + alt * 0.25
      rig.engine.distance = 0
    }
    lighting.sunDir.copy(SUN)
    lighting.sunColor.setRGB(cache.sun.x, cache.sun.y, cache.sun.z).multiplyScalar(2.4)
    lighting.ambient.copy(cache.sky).multiplyScalar(0.6)
    lighting.glowPos.copy(s.landerBase)
    lighting.glowLen = Math.max(0, Math.min(s.landerBase.y, 80))
    lighting.glowColor.setRGB(3, 1.4, 0.5).multiplyScalar(th * 1.4)
    lighting.glowRadius = 30
    scene.environment = rig.env.marsGround ?? null
    scene.environmentIntensity = Math.max(0.004, 1 - night * 1.05)
    if (ms.exploring) {
      // auto-exposure like the rover's cameras: stop down when the bright sun-aureole fills the frame
      const cosA = camera.getWorldDirection(tmp).dot(SUN)
      const glare = Math.min(1, Math.max(0, (cosA - 0.72) / 0.27)) * (1 - night) * Math.min(1, Math.max(0, SUN.y * 8))
      runtime.exposureEV = -0.1 + 2.4 * night - 3.4 * glare * glare * (3 - 2 * glare)
    }
  })

  return (
    <group ref={group}>
      <Starfield
        getIntensity={() => (useMission.getState().exploring ? 0.04 + 1.1 * exploreSky.night : 0.04)}
        getQuat={() => (useMission.getState().exploring ? exploreSky.quat : SKY_QUAT_MARS)}
        getLimMag={() => (useMission.getState().exploring ? 1.5 + 6.3 * exploreSky.night : 8)}
      />
      <SkyDome params={MARS_ATMO} getSun={sunNow} getAltKm={camAlt} groundAlbedo={GROUND} sunDisk={18} />
      {exploring && <EarthFromMars />}
      {exploring && <DustDevils />}
      {exploring && (
        <Suspense fallback={null}>
          <Rover />
        </Suspense>
      )}
      <MarsSite />
      <group ref={lander}>
        <Starship controls={ctl} legs />
      </group>
      <mesh ref={glowRef} geometry={glowGeo} material={glow} renderOrder={6} />
      {/* by the time the rover drives off, the landing dust has long settled (the frozen t would pin it in the air) */}
      {!exploring && <LandingDust />}
    </group>
  )
}

