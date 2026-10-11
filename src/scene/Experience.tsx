import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import {
  BackSide, Color, DirectionalLight, FogExp2, HemisphereLight, Mesh, PMREMGenerator, PointLight, Scene, ShaderMaterial, SphereGeometry,
  WebGLRenderTarget,
  FloatType,
} from 'three'
import { makeEnvSkyMaterial } from '../assets/planets/Sky'
import { AudioMount } from '../audio/AudioMount'
import { CameraDirector } from '../camera/CameraDirector'
import { PostFX } from '../effects/PostFX'
import { SUN_LAUNCH, SUN_MARS_SURFACE } from '../mission/constants'
import { TIMELINE_END } from '../mission/phases'
import { QUALITY, runtime, useMission } from '../mission/store'
import { sampleMission } from '../mission/trajectory'
import { EARTH_ATMO, MARS_ATMO } from '../shaders/atmosphere'
import { rig } from './sceneRefs'
import { registerFilmBridge } from '../film/film'
import { EarthWorld } from './worlds/EarthWorld'
import { MarsWorld } from './worlds/MarsWorld'
import { SpaceWorld } from './worlds/SpaceWorld'

/** Advances mission time and samples the mission state — runs before everything else each frame. */
function MissionClock() {
  useFrame((_, rawDt) => {
    const dt = runtime.fixedDt || Math.min(rawDt, 0.1)
    const st = useMission.getState()
    if (st.status !== 'paused') runtime.ambient += dt
    if (st.status === 'running') {
      runtime.t += dt * st.speed
      if (runtime.t >= TIMELINE_END) {
        runtime.t = TIMELINE_END
        st._complete()
      }
    }
    if (st.status === 'complete') runtime.t = Math.min(runtime.t + dt, 1e6) // finale camera keeps drifting
    const s = sampleMission(Math.min(runtime.t, TIMELINE_END + 1e5), runtime.state)
    if (s.world !== st.world || s.phase !== st.phase) st._sync(s.world, s.phase)
  }, -3)
  return null
}

/** Fixed light rig (constant light count ⇒ no shader recompiles between worlds). */
function LightRig() {
  const quality = useMission((s) => s.quality)
  const sun = useRef<DirectionalLight>(null!)
  const hemi = useRef<HemisphereLight>(null!)
  const engine = useRef<PointLight>(null!)
  useEffect(() => {
    rig.sun = sun.current
    rig.hemi = hemi.current
    rig.engine = engine.current
  }, [])
  const size = QUALITY[quality].shadowMap
  return (
    <>
      <directionalLight ref={sun} castShadow shadow-mapSize={[size, size]} shadow-bias={-0.0003} shadow-normalBias={0.02} intensity={3} />
      <hemisphereLight ref={hemi} args={[new Color(0.3, 0.35, 0.45), new Color(0.1, 0.09, 0.08), 1]} />
      <pointLight ref={engine} intensity={0} decay={2} />
    </>
  )
}

/** Pre-bakes reflection environments (PMREM) for every world from the same atmosphere model. */
function EnvironmentBaker() {
  const { gl } = useThree()
  useEffect(() => {
    const pm = new PMREMGenerator(gl)
    const bake = (mat: ShaderMaterial) => {
      const sc = new Scene()
      sc.add(new Mesh(new SphereGeometry(100, 64, 32), mat))
      const tex = pm.fromScene(sc, 0.02, 0.1, 1000).texture
      mat.dispose()
      return tex
    }
    const gradient = (low: Color, high: Color) =>
      new ShaderMaterial({
        uniforms: { uLow: { value: low }, uHigh: { value: high } },
        vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'uniform vec3 uLow; uniform vec3 uHigh; varying vec3 vD; void main(){ float k = smoothstep(0.35, -0.7, vD.y); gl_FragColor = vec4(mix(uHigh, uLow, k), 1.0); }',
        side: BackSide,
      })
    rig.env.earthGround = bake(makeEnvSkyMaterial(EARTH_ATMO, SUN_LAUNCH, 0.01, new Color(0.08, 0.08, 0.07)))
    rig.env.earthHigh = bake(makeEnvSkyMaterial(EARTH_ATMO, SUN_LAUNCH, 16, new Color(0.08, 0.08, 0.07)))
    rig.env.earthOrbit = bake(gradient(new Color(0.16, 0.24, 0.36), new Color(0.004, 0.005, 0.008)))
    rig.env.deep = bake(gradient(new Color(0.01, 0.01, 0.012), new Color(0.003, 0.003, 0.004)))
    rig.env.marsOrbit = bake(gradient(new Color(0.3, 0.16, 0.08), new Color(0.004, 0.004, 0.005)))
    rig.env.marsGround = bake(makeEnvSkyMaterial(MARS_ATMO, SUN_MARS_SURFACE, 0.01, new Color(0.25, 0.14, 0.08)))
    pm.dispose()
  }, [gl])
  return null
}

/** Compile every world's shaders once up front so world switches never stutter. */
function Precompiler() {
  const { gl, scene, camera } = useThree()
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const hidden: { visible: boolean }[] = []
      scene.traverse((o) => {
        if (!o.visible) {
          hidden.push(o)
          o.visible = true
        }
      })
      try {
        gl.compile(scene, camera)
      } finally {
        hidden.forEach((o) => (o.visible = false))
      }
    })
    return () => cancelAnimationFrame(id)
  }, [gl, scene, camera])
  return null
}

/** Gives the offline film renderer access to the R3F root (size, dpr, manual advance). */
function FilmBridge() {
  const get = useThree((s) => s.get)
  useEffect(() => {
    registerFilmBridge(get)
    // debug hook for automated inspection (?debug)
    if (new URLSearchParams(location.search).has('debug')) (window as unknown as { __r3f: typeof get }).__r3f = get
    if (new URLSearchParams(location.search).has('debug')) (window as unknown as { __RT: unknown }).__RT = { WebGLRenderTarget, FloatType }
  }, [get])
  return null
}

export function Experience() {
  const { scene } = useThree()
  useEffect(() => {
    scene.fog = new FogExp2(new Color(0.6, 0.7, 0.8), 0)
    scene.background = new Color(0, 0, 0)
  }, [scene])
  return (
    <>
      <MissionClock />
      <LightRig />
      <EnvironmentBaker />
      <EarthWorld />
      <SpaceWorld />
      <MarsWorld />
      <CameraDirector />
      <AudioMount />
      <Precompiler />
      <PostFX />
      <FilmBridge />
    </>
  )
}

