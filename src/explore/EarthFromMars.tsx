import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import { AdditiveBlending, BufferAttribute, BufferGeometry, Points, ShaderMaterial } from 'three'
import { exploreSky } from './exploreState'

/**
 * Earth as seen from Jezero: a bright blue-white point (about magnitude −1 to −2),
 * at its real position for the date and hour. Visible once the sky darkens.
 */
export function EarthFromMars() {
  const ref = useRef<Points>(null!)
  const geo = useMemo(() => {
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0]), 3))
    return g
  }, [])
  const mat = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: { uB: { value: 0 }, uPx: { value: 1 } },
        vertexShader: `uniform float uPx; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_Position.z = gl_Position.w * 0.99999; gl_PointSize = 3.2 * uPx; }`,
        fragmentShader: `uniform float uB; void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float g = exp(-d * d * 3.5); gl_FragColor = vec4(vec3(0.78, 0.87, 1.0) * uB * g, 1.0); }`,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: AdditiveBlending,
      }),
    [],
  )
  useFrame(({ camera }) => {
    const p = ref.current
    const e = exploreSky.earth
    p.position.copy(camera.position).addScaledVector(e, 800)
    // same photometric scale as the catalogue stars (mag 1 → 1)
    const flux = Math.pow(10, -0.4 * (exploreSky.earthMag - 1))
    const vis = Math.max(0, exploreSky.night * 1.1 - 0.05) * (e.y > -0.02 ? 1 : 0)
    mat.uniforms.uB.value = (flux * vis * 1.5) / (3.2 * 3.2 / 4)
    mat.uniforms.uPx.value = Math.min(window.devicePixelRatio || 1, 2)
    p.visible = vis > 0.001
  })
  return <points ref={ref} geometry={geo} material={mat} frustumCulled={false} renderOrder={-99} />
}
