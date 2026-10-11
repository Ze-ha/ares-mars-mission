import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, ShaderMaterial } from 'three'
import { marsHeight } from '../assets/mars/MarsSite'
import { rover } from './exploreState'

/**
 * Wheel tracks pressed into the regolith: two bands (left and right wheel rows),
 * each ~0.4 m wide, with the chevron grouser pattern of the Mars 2020 wheels.
 * Laid as a ribbon that follows the ground; oldest segments recycle.
 */
const MAX = 3000 // segments per side
const STEP = 0.25 // m between cross-sections
const W = 0.2 // half width of a wheel track

export function Tracks({ halfTrack }: { halfTrack: number }) {
  const ref = useRef<Mesh>(null!)
  const st = useMemo(() => ({ n: 0, last: null as null | { x: number; z: number }, dist: 0 }), [])
  const geo = useMemo(() => {
    const g = new BufferGeometry()
    // per side: MAX cross-sections × 2 vertices; quads between consecutive sections
    const verts = 2 * MAX * 2
    g.setAttribute('position', new BufferAttribute(new Float32Array(verts * 3), 3))
    g.setAttribute('aUv', new BufferAttribute(new Float32Array(verts * 2), 2))
    // 1 = written section; 0 = empty or the ring's oldest slot (so the write head never joins the tail)
    g.setAttribute('aValid', new BufferAttribute(new Float32Array(verts), 1))
    const idx: number[] = []
    for (let side = 0; side < 2; side++)
      for (let i = 0; i < MAX - 1; i++) {
        const a = (side * MAX + i) * 2
        const b = a + 2
        idx.push(a, b, a + 1, a + 1, b, b + 1)
      }
    g.setIndex(idx)
    return g
  }, [])
  const mat = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec2 aUv; attribute float aValid; varying vec2 vUv; varying float vValid;
void main(){ vUv = aUv; vValid = aValid; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
#include <logdepthbuf_vertex>
}`,
        fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec2 vUv; varying float vValid;
void main(){
  #include <logdepthbuf_fragment>
  if (vValid < 0.999) discard;
  // across: 0..1 over the wheel width; along: metres driven
  float x = vUv.x * 2.0 - 1.0;
  float edge = smoothstep(1.0, 0.8, abs(x));
  // chevron grousers every ~0.14 m
  float ch = fract(vUv.y / 0.14 + abs(x) * 0.35);
  float grouser = smoothstep(0.0, 0.08, ch) * (1.0 - smoothstep(0.18, 0.3, ch));
  // compacted soil reads darker; the pressed grouser ridges a little darker still
  float a = edge * (0.22 + 0.2 * grouser);
  gl_FragColor = vec4(vec3(0.0), a);
}`,
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    [],
  )

  useFrame(() => {
    const p = rover.pos
    if (!st.last) {
      st.last = { x: p.x, z: p.z }
      return
    }
    const d = Math.hypot(p.x - st.last.x, p.z - st.last.z)
    if (d < STEP) return
    st.dist += d
    st.last = { x: p.x, z: p.z }
    const pos = geo.getAttribute('position') as BufferAttribute
    const uv = geo.getAttribute('aUv') as BufferAttribute
    const valid = geo.getAttribute('aValid') as BufferAttribute
    const i = st.n % MAX
    const nx = (i + 1) % MAX
    const c = Math.cos(rover.heading)
    const s = Math.sin(rover.heading)
    for (let side = 0; side < 2; side++) {
      const off = side === 0 ? halfTrack : -halfTrack
      for (let k = 0; k < 2; k++) {
        const lx = off + (k === 0 ? -W : W)
        const x = p.x + lx * c
        const z = p.z - lx * s
        const v = (side * MAX + i) * 2 + k
        pos.setXYZ(v, x, marsHeight(x, z) + 0.035, z)
        uv.setXY(v, k, st.dist)
        valid.setX(v, 1)
        valid.setX((side * MAX + nx) * 2 + k, 0)
      }
    }
    // the section after the write head must not join the ring's oldest point
    st.n++
    pos.needsUpdate = true
    uv.needsUpdate = true
    valid.needsUpdate = true
    ref.current.visible = st.n > 1
  })
  return <mesh ref={ref} geometry={geo} material={mat} frustumCulled={false} renderOrder={1} visible={false} />
}
