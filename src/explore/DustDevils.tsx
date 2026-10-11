import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import { CylinderGeometry, DoubleSide, Group, Mesh, ShaderMaterial, Vector3 } from 'three'
import { marsHeight } from '../assets/mars/MarsSite'
import { lighting } from '../mission/lighting'
import { runtime } from '../mission/store'
import { exploreSky } from './exploreState'

/**
 * Dust devils: Perseverance's cameras caught dozens crossing Jezero's floor in the
 * afternoon — tall, thin, low-contrast columns of lofted dust drifting with the wind.
 * Each is a tapered, swirling translucent column; they come and go on ~1-2 minute cycles.
 */
const N = 4
const geo = (() => {
  const g = new CylinderGeometry(1, 1, 1, 28, 40, true)
  g.translate(0, 0.5, 0)
  return g
})()

function makeMat() {
  return new ShaderMaterial({
    uniforms: { uT: { value: 0 }, uA: { value: 0 }, uSun: { value: new Vector3(1, 1, 1) }, uSeed: { value: 0 } },
    vertexShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uT; uniform float uSeed;
varying vec3 vP; varying vec3 vN; varying vec3 vV;
void main(){
  vec3 p = position;
  // funnel: narrow skirt at the ground, widening and bending with height
  float y = p.y;
  float r = mix(0.35, 1.0, smoothstep(0.0, 0.5, y)) * (1.0 + 0.6 * y);
  p.xz *= r;
  p.x += sin(y * 3.0 + uT * 0.4 + uSeed) * 0.25 * y;
  vP = vec3(position.xz, y);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`,
    fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uT; uniform float uA; uniform vec3 uSun; uniform float uSeed;
varying vec3 vP; varying vec3 vN; varying vec3 vV;
float h1(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h1(i), h1(i + vec2(1, 0)), f.x), mix(h1(i + vec2(0, 1)), h1(i + vec2(1, 1)), f.x), f.y); }
void main(){
  #include <logdepthbuf_fragment>
  float ang = atan(vP.y, vP.x);
  float y = vP.z;
  // swirling dust streaks winding up the column
  float s = n2(vec2(ang * 3.0 + y * 9.0 - uT * 2.2 + uSeed, y * 6.0 - uT * 0.8)) * 0.65 + n2(vec2(ang * 7.0 - uT * 3.1, y * 17.0)) * 0.35;
  float edge = pow(abs(dot(normalize(vN), normalize(vV))), 0.6);
  float prof = smoothstep(0.0, 0.06, y) * (1.0 - smoothstep(0.55, 1.0, y));
  float a = s * s * prof * (0.35 + 0.65 * (1.0 - edge)) * uA;
  vec3 dust = vec3(0.55, 0.4, 0.28) * (0.35 + uSun);
  gl_FragColor = vec4(dust, a);
}`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
  })
}

export function DustDevils() {
  const group = useRef<Group>(null!)
  const devils = useMemo(
    () =>
      Array.from({ length: N }, (_, i) => {
        const r = (k: number) => {
          const x = Math.sin((i + 1) * 12.9898 + k * 78.233) * 43758.5453
          return x - Math.floor(x)
        }
        return {
          mat: makeMat(),
          ref: { current: null as Mesh | null },
          period: 70 + r(1) * 70,
          phase: r(2) * 200,
          dist: 450 + r(3) * 1900,
          az: r(4) * Math.PI * 2,
          height: 120 + r(5) * 380,
          width: 6 + r(6) * 16,
          seed: r(7) * 50,
        }
      }),
    [],
  )
  const wind = useMemo(() => new Vector3(1, 0, -0.45).normalize(), [])
  useFrame(() => {
    const t = runtime.ambient
    // afternoon convection only: gone at dusk and at night
    const day = Math.max(0, 1 - exploreSky.night * 3) * Math.min(1, Math.max(0, exploreSky.sun.y * 4))
    group.current.visible = day > 0.01
    if (!group.current.visible) return
    const sunI = Math.min(1.4, (lighting.sunColor.r + lighting.sunColor.g) / 4)
    for (const d of devils) {
      const m = d.ref.current
      if (!m) continue
      const cyc = (t + d.phase) / d.period
      const k = cyc - Math.floor(cyc)
      const life = Math.sin(Math.PI * k)
      const x = Math.cos(d.az) * d.dist + wind.x * (k - 0.5) * 360
      const z = Math.sin(d.az) * d.dist + wind.z * (k - 0.5) * 360
      m.position.set(x, marsHeight(x, z) - 1, z)
      m.scale.set(d.width, d.height * (0.7 + 0.3 * life), d.width)
      m.rotation.y = t * 0.6 + d.seed
      d.mat.uniforms.uT.value = t + d.seed
      d.mat.uniforms.uA.value = 0.32 * life * life * day
      d.mat.uniforms.uSeed.value = d.seed
      d.mat.uniforms.uSun.value.setScalar(sunI)
    }
  })
  return (
    <group ref={group}>
      {devils.map((d, i) => (
        <mesh key={i} ref={(m) => void (d.ref.current = m)} geometry={geo} material={d.mat} frustumCulled={false} renderOrder={7} />
      ))}
    </group>
  )
}
