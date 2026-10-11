import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import { AdditiveBlending, CylinderGeometry, DoubleSide, InstancedMesh, Matrix4, Quaternion, ShaderMaterial, Vector3 } from 'three'
import { VEHICLE } from '../mission/constants'
import { lighting } from '../mission/lighting'
import { runtime } from '../mission/store'
import { RCS_EVENTS } from '../mission/trajectory'

/**
 * Reaction-control jets as they look in orbital footage: short, sharp, translucent
 * cones that flick on and off with each valve pulse, visible only in sunlight.
 * Driven by the same firing schedule (RCS_EVENTS) that rotates the vehicles, and
 * placed on the thruster that actually produces the required torque.
 * Rendered in the vehicle's local frame (metres).
 */
const MAX = 8
const Y = new Vector3(0, 1, 0)

const geo = (() => {
  const g = new CylinderGeometry(1, 0.08, 1, 20, 12, true)
  g.translate(0, 0.5, 0) // nozzle at y = 0, jet along +y
  return g
})()

const mat = new ShaderMaterial({
  uniforms: { uSun: { value: 1 }, uTime: { value: 0 } },
  vertexShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying float vS; varying vec3 vN; varying vec3 vV; varying float vA;
void main(){
  vS = position.y;
  vA = atan(position.z, position.x);
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}`,
  fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uSun; uniform float uTime;
varying float vS; varying vec3 vN; varying vec3 vV; varying float vA;
float h(float n){ return fract(sin(n) * 43758.5453); }
void main(){
  #include <logdepthbuf_fragment>
  float facing = abs(dot(normalize(vN), normalize(vV)));
  float core = pow(facing, 1.8);
  float along = exp(-vS * 4.0) * smoothstep(0.0, 0.04, vS);
  float streak = 0.75 + 0.25 * h(floor(vA * 5.0) + floor(uTime * 30.0));
  // gas is visible by scattered sunlight only; a faint floor keeps it readable in earthshine
  float I = core * along * streak * (0.05 + uSun) * 0.45;
  gl_FragColor = vec4(vec3(0.9, 0.94, 1.0) * I, 1.0);
}`,
  transparent: true,
  depthWrite: false,
  blending: AdditiveBlending,
  side: DoubleSide,
})

export function RcsJets({ vehicle }: { vehicle: 'ship' | 'booster' }) {
  const ref = useRef<InstancedMesh>(null!)
  const tmp = useMemo(() => ({ m: new Matrix4(), q: new Quaternion(), inv: new Quaternion(), s: new Vector3(), p: new Vector3(), a: new Vector3(), g: new Vector3(), r: new Vector3() }), [])
  const events = useMemo(() => RCS_EVENTS.filter((e) => e.vehicle === vehicle), [vehicle])

  useFrame(() => {
    const st = runtime.state
    const t = st.t
    let n = 0
    const vq = vehicle === 'ship' ? st.shipQuat : st.booster.quat
    tmp.inv.copy(vq).invert()
    const add = (pos: Vector3, dir: Vector3, len: number, width: number) => {
      if (n >= MAX) return
      tmp.q.setFromUnitVectors(Y, dir)
      tmp.s.set(width, len, width)
      tmp.m.compose(pos, tmp.q, tmp.s)
      ref.current.setMatrixAt(n++, tmp.m)
    }
    for (const e of events) {
      if (t < e.t0 || t > e.t1) continue
      const pl = e.kind === 'ullage' ? 0.28 : 0.1
      const gap = e.kind === 'ullage' ? 0.06 : 0.16
      const phase = (t - e.t0) % (pl + gap)
      if (phase > pl) continue // valve closed between pulses
      const k = Math.min(1, phase / 0.03) // rise within 30 ms
      if (vehicle === 'booster') {
        tmp.a.copy(e.axis!).applyQuaternion(tmp.inv)
        tmp.g.copy(tmp.a).cross(Y).multiplyScalar(-(e.sense ?? 1)).normalize()
        tmp.p.copy(tmp.g).multiplyScalar(VEHICLE.radius + 0.15).add(tmp.r.set(0, 66.5, 0))
        add(tmp.p, tmp.g, 12 * k, 2.6)
        continue
      }
      if (e.kind === 'ullage') {
        for (const sx of [-1, 1]) {
          tmp.p.set(sx * (VEHICLE.radius + 0.15), 3, 1.2)
          tmp.g.set(sx * 0.25, -1, 0).normalize()
          add(tmp.p.clone(), tmp.g.clone(), 11 * k, 2.4)
        }
        continue
      }
      tmp.a.copy(e.axis!).applyQuaternion(tmp.inv)
      for (const end of [1, -1]) {
        tmp.r.copy(Y).multiplyScalar(end)
        tmp.g.copy(tmp.a).cross(tmp.r).multiplyScalar(-(e.sense ?? 1))
        if (tmp.g.lengthSq() < 1e-4) continue
        tmp.g.normalize()
        const y = end > 0 ? VEHICLE.shipLength - 3 : 3
        tmp.p.copy(tmp.g).multiplyScalar(VEHICLE.radius + 0.15).add(tmp.r.set(0, y, 0))
        add(tmp.p.clone(), tmp.g.clone(), (e.kind === 'trim' ? 5 : 9) * k, e.kind === 'trim' ? 1.2 : 2.2)
        if (e.kind === 'trim') break
      }
    }
    ref.current.count = n
    ref.current.instanceMatrix.needsUpdate = true
    ref.current.visible = n > 0
    mat.uniforms.uSun.value = Math.min(1.2, lighting.sunColor.r / 2.4)
    mat.uniforms.uTime.value = runtime.ambient
  })

  return <instancedMesh ref={ref} args={[geo, mat, MAX]} frustumCulled={false} renderOrder={9} />
}
