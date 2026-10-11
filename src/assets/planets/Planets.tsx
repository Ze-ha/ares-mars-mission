import { useTexture } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import {
  AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, Color, Group, LinearMipmapLinearFilter, Matrix3, Points, RedFormat, ShaderMaterial, SphereGeometry,
  SRGBColorSpace, Vector3, type Texture,
} from 'three'
import { EARTH_RADIUS_KM, MARS_RADIUS_KM } from '../../mission/constants'
import { QUALITY, runtime, useMission } from '../../mission/store'
import { atmosphereUniforms, EARTH_ATMO, MARS_ATMO } from '../../shaders/atmosphere'
import { atmosphereShellShader, earthSurfaceShader, marsSurfaceShader } from '../../shaders/planets'

/**
 * Earth and Mars for the space world (km, floating origin).
 * Each planet = textured surface sphere with aerial perspective +
 * a ray-marched atmosphere shell + a point impostor for when it shrinks
 * below a few pixels (the "pale blue dot").
 */

const TEX = (name: string) => `${import.meta.env.BASE_URL}textures/${name}`

function prep(t: Texture, srgb: boolean, aniso = 8) {
  t.colorSpace = srgb ? SRGBColorSpace : ''
  t.anisotropy = aniso
  t.minFilter = LinearMipmapLinearFilter
  t.needsUpdate = true
  return t
}

const sphereCache = new Map<string, SphereGeometry>()
const sphere = (r: number, w: number, h: number) => {
  const k = `${r}-${w}-${h}`
  if (!sphereCache.has(k)) sphereCache.set(k, new SphereGeometry(r, w, h))
  return sphereCache.get(k)!
}

function useDefines() {
  const q = useMission((s) => s.quality)
  return useMemo(() => ({ ATMO_STEPS: QUALITY[q].atmoSteps, ATMO_LSTEPS: QUALITY[q].atmoLightSteps }), [q])
}

/** Point sprite shown when a planet is too small to resolve. */
function Impostor({ color, planetR, getCenter }: { color: Color; planetR: number; getCenter: () => { x: number; y: number; z: number } }) {
  const ref = useRef<Points>(null!)
  const { camera, size } = useThree()
  const mat = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: { uColor: { value: color }, uAlpha: { value: 0 }, uSize: { value: 3 } },
        vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uSize; void main(){ gl_PointSize = uSize; gl_Position = projectionMatrix * modelViewMatrix * vec4(0.0,0.0,0.0,1.0);
#include <logdepthbuf_vertex>
}`,
        fragmentShader: `#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor; uniform float uAlpha; void main(){
#include <logdepthbuf_fragment>
float d = length(gl_PointCoord - 0.5) * 2.0; float g = exp(-d*d*4.0); gl_FragColor = vec4(uColor * g * uAlpha, 1.0); }`,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    [color],
  )
  const geo = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0]), 3))
    return g
  }, [])
  useFrame(() => {
    const c = getCenter()
    ref.current.position.set(c.x, c.y, c.z)
    const d = camera.position.distanceTo(ref.current.position)
    const fov = ((camera as { fov?: number }).fov ?? 40) * (Math.PI / 180)
    const px = ((2 * planetR) / d / fov) * size.height
    mat.uniforms.uAlpha.value = Math.max(0, 1 - px / 4) * 2.2
    mat.uniforms.uSize.value = 4 * (window.devicePixelRatio || 1)
  })
  return <points ref={ref} geometry={geo} material={mat} frustumCulled={false} renderOrder={1} />
}

/**
 * Earth day + cloud maps. 8K only at quality 'high' (GPU memory); medium/low keep the 4K set.
 * Shared by the globe and the launch-world sky dome, so the planet below the ascent is the same one seen from orbit.
 */
export function useEarthMaps() {
  const hi = ['high', 'ultra'].includes(useMission((s) => s.quality))
  const [day, brc, clouds] = useTexture([
    hi ? TEX('earth_day_8k.jpg') : TEX('earth_day_4096.jpg'),
    TEX('earth_bump_roughness_clouds_4096.jpg'),
    hi ? TEX('earth_clouds_8k.jpg') : TEX('earth_bump_roughness_clouds_4096.jpg'),
  ])
  return useMemo(() => {
    prep(day, true, 16)
    prep(brc, false, 16)
    const single = clouds !== brc
    if (single && clouds.format !== RedFormat) {
      // single-channel 8K cloud map: R8 on the GPU (a quarter of RGBA)
      prep(clouds, false, 16)
      clouds.format = RedFormat
      clouds.internalFormat = 'R8'
    }
    return { day, brc, clouds, cloudCh: (single ? 'r' : 'b') as 'r' | 'b' }
  }, [day, brc, clouds])
}

/** Slow cloud drift (uv units), shared by the globe and the sky dome. */
export const cloudShift = () => runtime.ambient * 0.00004

/** Rotation from the site's local frame (x east, y up, z south) to the globe's object space (same as trajectory's siteOrientation). */
export function siteToObject(latDeg: number, lonDeg: number) {
  const la = (latDeg * Math.PI) / 180
  const ph = ((lonDeg + 180) * Math.PI) / 180
  const up = new Vector3(-Math.cos(ph) * Math.cos(la), Math.sin(la), Math.sin(ph) * Math.cos(la))
  const east = new Vector3(Math.sin(ph), 0, Math.cos(ph)).normalize()
  const south = new Vector3().crossVectors(east, up)
  return new Matrix3().set(east.x, up.x, south.x, east.y, up.y, south.y, east.z, up.z, south.z)
}

export function Earth() {
  const { day, brc, clouds, cloudCh } = useEarthMaps()
  const [night, normal] = useTexture([TEX('earth_night_4096.jpg'), TEX('earth_normal_2048.jpg')])
  const defines = useDefines()
  const group = useRef<Group>(null!)
  const surface = useMemo(() => {
    prep(night, true)
    prep(normal, false)
    return new ShaderMaterial({
      ...earthSurfaceShader,
      defines: { ...defines, CLOUD_CH: cloudCh },
      uniforms: {
        ...atmosphereUniforms(EARTH_ATMO),
        uDay: { value: day },
        uNight: { value: night },
        uBRC: { value: brc },
        uNormal: { value: normal },
        uClouds: { value: clouds },
        uSunDir: { value: runtime.state.sunDir.clone() },
        uCenter: { value: runtime.state.earthCenter.clone() },
        uCloudShift: { value: 0 },
        uSunE: { value: 5.5 }, // ground & cloud irradiance, in balance with the atmosphere's in-scatter (was 3.2: haze swamped the ocean)
        uNightI: { value: 2.2 },
      },
    })
  }, [day, night, brc, normal, clouds, cloudCh, defines])
  const shell = useMemo(
    () =>
      new ShaderMaterial({
        ...atmosphereShellShader,
        defines,
        uniforms: { ...atmosphereUniforms(EARTH_ATMO), uSunDir: { value: runtime.state.sunDir.clone() }, uCenter: { value: runtime.state.earthCenter.clone() }, uIntensity: { value: 1 } },
        side: BackSide,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    [defines],
  )
  useFrame(() => {
    const s = runtime.state
    group.current.position.copy(s.earthCenter)
    group.current.quaternion.copy(s.earthQuat)
    for (const m of [surface, shell]) {
      m.uniforms.uSunDir.value.copy(s.sunDir)
      m.uniforms.uCenter.value.copy(s.earthCenter)
    }
    surface.uniforms.uCloudShift.value = cloudShift()
  })
  const color = useMemo(() => new Color(0.55, 0.7, 1.0), [])
  return (
    <>
      <group ref={group}>
        <mesh geometry={sphere(EARTH_RADIUS_KM, 512, 256)} material={surface} renderOrder={0} />
        <mesh geometry={sphere(EARTH_ATMO.atmoR * 1.01, 160, 80)} material={shell} renderOrder={3} />
      </group>
      <Impostor color={color} planetR={EARTH_RADIUS_KM} getCenter={() => runtime.state.earthCenter} />
    </>
  )
}

export function Mars() {
  const hi = ['high', 'ultra'].includes(useMission((s) => s.quality))
  // high: Viking MDIM2.1 colour 8K (rebalanced to true-colour butterscotch) + MOLA relief normals
  const [color, bump, normal] = useTexture(
    hi ? [TEX('mars_color_8k.jpg'), TEX('mars_bump_1k.jpg'), TEX('mars_normal_4k.jpg')] : [TEX('mars_color_nasa.jpg'), TEX('mars_bump_1k.jpg'), TEX('mars_bump_1k.jpg')],
  )
  const defines = useDefines()
  const group = useRef<Group>(null!)
  const surface = useMemo(() => {
    prep(color, true, 16)
    prep(bump, false, 16)
    if (hi) prep(normal, false, 16)
    return new ShaderMaterial({
      ...marsSurfaceShader,
      defines,
      uniforms: {
        ...atmosphereUniforms(MARS_ATMO),
        uColor: { value: color },
        uBump: { value: bump },
        uNormal: { value: normal },
        uNormalK: { value: hi ? 0.3 : 0 },
        uBumpK: { value: hi ? 0 : 1 },
        uPolar: { value: hi ? 0 : 1 },
        uAlbK: { value: hi ? 1.0 : 0.78 },
        uSat: { value: hi ? 1.0 : 0.85 },
        uSunDir: { value: runtime.state.sunDir.clone() },
        uCenter: { value: runtime.state.marsCenter.clone() },
        uSunE: { value: 3.0 },
      },
      extensions: { derivatives: true } as never,
    })
  }, [color, bump, normal, hi, defines])
  const shell = useMemo(
    () =>
      new ShaderMaterial({
        ...atmosphereShellShader,
        defines,
        uniforms: { ...atmosphereUniforms(MARS_ATMO), uSunDir: { value: runtime.state.sunDir.clone() }, uCenter: { value: runtime.state.marsCenter.clone() }, uIntensity: { value: 1 } },
        side: BackSide,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    [defines],
  )
  useFrame(() => {
    const s = runtime.state
    group.current.position.copy(s.marsCenter)
    group.current.quaternion.copy(s.marsQuat)
    for (const m of [surface, shell]) {
      m.uniforms.uSunDir.value.copy(s.sunDir)
      m.uniforms.uCenter.value.copy(s.marsCenter)
    }
  })
  const c = useMemo(() => new Color(1.0, 0.55, 0.35), [])
  return (
    <>
      <group ref={group}>
        <mesh geometry={sphere(MARS_RADIUS_KM, 512, 256)} material={surface} renderOrder={0} />
        <mesh geometry={sphere(MARS_ATMO.atmoR * 1.01, 160, 80)} material={shell} renderOrder={3} />
      </group>
      <Impostor color={c} planetR={MARS_RADIUS_KM} getCenter={() => runtime.state.marsCenter} />
    </>
  )
}

/** The Moon at its real position relative to Earth (Lambertian regolith, lit by the real sun). */
export function Moon() {
  const tex = useTexture(TEX('moon_1024.jpg'))
  const ref = useRef<Group>(null!)
  const mat = useMemo(() => {
    prep(tex, true, 8)
    return new ShaderMaterial({
      uniforms: { uMap: { value: tex }, uSunDir: { value: runtime.state.sunDir.clone() } },
      vertexShader: `#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv; varying vec3 vN;
void main(){ vUv = uv; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
#include <logdepthbuf_vertex>
}`,
      fragmentShader: `#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap; uniform vec3 uSunDir; varying vec2 vUv; varying vec3 vN;
void main(){
#include <logdepthbuf_fragment>
vec3 a = texture2D(uMap, vUv).rgb * 0.62;
float l = max(dot(normalize(vN), normalize(uSunDir)), 0.0);
gl_FragColor = vec4(a * l * 3.2, 1.0); }`,
    })
  }, [tex])
  useFrame(() => {
    const s = runtime.state
    ref.current.position.copy(s.moonCenter)
    mat.uniforms.uSunDir.value.copy(s.sunDir)
    ref.current.visible = s.t < 150
  })
  const c = useMemo(() => new Color(0.7, 0.7, 0.68), [])
  return (
    <>
      <group ref={ref}>
        <mesh geometry={sphere(1737.4, 128, 64)} material={mat} />
      </group>
      <Impostor color={c} planetR={1737.4} getCenter={() => runtime.state.moonCenter} />
    </>
  )
}
