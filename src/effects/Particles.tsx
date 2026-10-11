import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import { AdditiveBlending, Color, Float32BufferAttribute, NormalBlending, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, ShaderMaterial, Vector3 } from 'three'
import { lighting } from '../mission/lighting'
import { QUALITY, runtime, useMission } from '../mission/store'
import { particleShader } from '../shaders/effects'
import { makePuffAtlas } from '../utils/proceduralTextures'
import { rng } from '../utils/math'

let atlas: ReturnType<typeof makePuffAtlas> | null = null
const getAtlas = () => (atlas ??= makePuffAtlas())

export interface Particle {
  spawn: number
  life: number
  origin: [number, number, number]
  vel: [number, number, number]
  size0: number
  size1: number
  rot?: number
}

export interface EmitterConfig {
  /** stable id — changing it rebuilds the buffers */
  id: string
  count: number
  seed: number
  build: (i: number, r: () => number) => Particle
  color: Color
  opacity: number
  drag: number
  buoyancy: number
  wind?: Vector3
  emissive?: number
  /** > 0 → ambient looping emitter (period in seconds, driven by wall-clock time) */
  loop?: number
  groundY?: number
  /** master intensity each frame (0 hides the system) */
  master?: () => number
  /** render as glinting ice crystals */
  sparkle?: boolean
  /** smoke around an exhaust plume: draw the part behind the flame before it, the part in front after it */
  split?: boolean
  /** 1 = dense cauliflower billows (default), 0 = soft diffuse haze */
  billow?: number
}

/**
 * GPU particle emitter. Particles are pre-seeded on the CPU once (spawn time,
 * origin, velocity, size), then animated analytically in the vertex shader.
 * Mission-time driven emitters are therefore exactly reproducible when the
 * user scrubs, pauses or replays a phase.
 */
export function Emitter({ config }: { config: EmitterConfig }) {
  const ref = useRef<Mesh>(null!)
  const quality = useMission((s) => s.quality)
  const scale = QUALITY[quality].particles
  const geo = useMemo(() => {
    const n = Math.max(8, Math.floor(config.count * scale))
    const g = new InstancedBufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3))
    g.setAttribute('corner', new Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, 1], 2))
    g.setIndex([0, 1, 2, 0, 2, 3])
    const spawn = new Float32Array(n)
    const life = new Float32Array(n)
    const origin = new Float32Array(n * 3)
    const vel = new Float32Array(n * 3)
    const misc = new Float32Array(n * 4)
    const r = rng(config.seed)
    for (let i = 0; i < n; i++) {
      const p = config.build(i / n, r)
      spawn[i] = p.spawn
      life[i] = p.life
      origin.set(p.origin, i * 3)
      vel.set(p.vel, i * 3)
      misc.set([r(), p.size0, p.size1, (p.rot ?? (r() - 0.5) * 0.4)], i * 4)
    }
    g.setAttribute('aSpawn', new InstancedBufferAttribute(spawn, 1))
    g.setAttribute('aLife', new InstancedBufferAttribute(life, 1))
    g.setAttribute('aOrigin', new InstancedBufferAttribute(origin, 3))
    g.setAttribute('aVel', new InstancedBufferAttribute(vel, 3))
    g.setAttribute('aMisc', new InstancedBufferAttribute(misc, 4))
    g.instanceCount = n
    return g
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.id, scale])

  const mat = useMemo(
    () =>
      new ShaderMaterial({
        ...particleShader,
        uniforms: {
          uSplitP: { value: new Vector3() },
          uSplitN: { value: new Vector3(0, 0, 1) },
          uSplitSide: { value: config.split ? -1 : 0 },
          uTime: { value: 0 },
          uDrag: { value: config.drag },
          uBuoyancy: { value: config.buoyancy },
          uWind: { value: config.wind ?? new Vector3() },
          uLoop: { value: config.loop ?? 0 },
          uAtlas: { value: getAtlas() },
          uColor: { value: config.color },
          uSunDirV: { value: new Vector3(0, 1, 0) },
          uSunColor: { value: new Color(1, 1, 1) },
          uAmbient: { value: new Color(0.3, 0.3, 0.3) },
          uGlowPos: { value: new Vector3() },
          uGlowColor: { value: new Color(0, 0, 0) },
          uGlowRadius: { value: 50 },
          uGlowLen: { value: 0 },
          uBillow: { value: config.billow ?? 1 },
          uOpacity: { value: config.opacity },
          uEmissive: { value: config.emissive ?? 0 },
          uGroundY: { value: config.groundY ?? -1e9 },
          uMaster: { value: 1 },
          uSparkle: { value: config.sparkle ? 1 : 0 },
          uTimeF: { value: 0 },
        },
        transparent: true,
        premultipliedAlpha: true,
        depthWrite: false,
        blending: config.sparkle ? AdditiveBlending : NormalBlending,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.id],
  )
  // the behind-the-flame half shares every uniform except the side
  const matBack = useMemo(() => {
    if (!config.split) return null
    const m = mat.clone()
    m.uniforms = { ...mat.uniforms, uSplitSide: { value: 1 } }
    return m
  }, [mat, config.split])
  const refBack = useRef<Mesh>(null)

  useFrame(({ camera }) => {
    const u = mat.uniforms
    u.uTime.value = config.loop ? runtime.ambient : runtime.t
    u.uTimeF.value = runtime.ambient
    u.uSunDirV.value.copy(lighting.sunDir).transformDirection(camera.matrixWorldInverse)
    u.uSunColor.value.copy(lighting.sunColor)
    u.uAmbient.value.copy(lighting.ambient)
    u.uGlowPos.value.copy(lighting.glowPos)
    u.uGlowColor.value.copy(lighting.glowColor)
    u.uGlowRadius.value = lighting.glowRadius
    u.uGlowLen.value = lighting.glowLen
    u.uSplitP.value.copy(lighting.glowPos)
    u.uSplitN.value.copy(lighting.glowPos).sub(camera.position).normalize()
    const m = config.master ? config.master() : 1
    u.uMaster.value = m
    ref.current.visible = m > 0.001
    if (refBack.current) refBack.current.visible = m > 0.001
  })

  return (
    <>
      <mesh ref={ref} geometry={geo} material={mat} frustumCulled={false} renderOrder={9} />
      {matBack && <mesh ref={refBack} geometry={geo} material={matBack} frustumCulled={false} renderOrder={3} />}
    </>
  )
}
