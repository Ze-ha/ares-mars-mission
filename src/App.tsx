import { Canvas } from '@react-three/fiber'
import { Suspense, useEffect } from 'react'
import { NoToneMapping } from 'three'
import { QUALITY, runtime, useMission } from './mission/store'
import { Experience } from './scene/Experience'
import { HUD, Loader } from './ui/HUD'

/** Test/deep-link hooks: ?t=120 jumps to a mission time, &paused=1 freezes it, &free=1 frees the camera. */
function useDeepLink() {
  useEffect(() => {
    const p = new URLSearchParams(location.search)
    const t = p.get('t')
    if (t !== null) {
      const m = useMission.getState()
      m.seek(Number(t))
      if (p.get('paused')) useMission.setState({ status: 'paused' })
      if (p.get('free')) m.setCameraMode('free')
      runtime.ambient = Number(p.get('ambient') ?? 0)
    }
  }, [])
}

export default function App() {
  const quality = useMission((s) => s.quality)
  useDeepLink()
  const dpr = Math.min(QUALITY[quality].dpr, window.devicePixelRatio || 1)
  return (
    <>
      <Canvas
        shadows
        dpr={dpr}
        flat
        gl={{ logarithmicDepthBuffer: true, antialias: false, powerPreference: 'high-performance', toneMapping: NoToneMapping, stencil: false }}
        camera={{ position: [-420, 14, 380], fov: 34, near: 0.5, far: 2.5e6 }}
      >
        <Suspense fallback={null}>
          <Experience />
        </Suspense>
      </Canvas>
      <HUD />
      <Loader />
    </>
  )
}
