import { useTexture } from '@react-three/drei'
import { useFrame, useLoader } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import {
  AdditiveBlending, BackSide, BufferAttribute, BufferGeometry, Color, Group, Matrix3, Mesh, PlaneGeometry, Quaternion, RepeatWrapping, ShaderMaterial, SphereGeometry, SRGBColorSpace, Vector2, Vector3,
  type Camera, type PerspectiveCamera, type Texture,
} from 'three'
import { QUALITY, useMission } from '../../mission/store'
import { BinaryLoader, binUrl } from '../../utils/binary'
import { atmosphereUniforms, type AtmosphereParams } from '../../shaders/atmosphere'
import { glowSpriteShader } from '../../shaders/effects'
import { NOISE_GLSL } from '../../shaders/noise'
import { skyDomeShader } from '../../shaders/sky'

const TEX = (name: string) => `${import.meta.env.BASE_URL}textures/${name}`

/**
 * Astronomical sky built from real data:
 *  - diffuse galactic light from the Tycho all-sky star map (NASA), stars removed,
 *  - ~45k point stars placed with a density that follows that same map, with a
 *    realistic magnitude distribution (counts grow ×2.2 per magnitude) and
 *    stellar colour temperatures. Mostly black, no sparkle, no nebula art.
 * Rendered at infinity: the group follows the camera, depth test off.
 */
/**
 * `getLimMag` is the camera's limiting magnitude: a bright sunlit rocket or planet
 * in frame forces a short exposure, so faint stars drop out first and the Milky Way
 * (surface brightness ~ mag 5-6 stars) goes with them. Dark frames reveal everything.
 */
export function Starfield({ getIntensity, getQuat, getLimMag = () => 8 }: { getIntensity: () => number; getQuat?: () => Quaternion; getLimMag?: () => number }) {
  const ref = useRef<Group>(null!)
  const glow = useTexture(TEX('milkyway_gaia.jpg'))
  // HYG v4.1 catalogue, all stars to magnitude 7.2 (19,115), J2000 positions, colour from B–V
  const buf = useLoader(BinaryLoader, binUrl(`${import.meta.env.BASE_URL}data/stars_hyg_m72.bin`)) as unknown as ArrayBuffer
  const { geo, mat } = useMemo(() => {
    glow.colorSpace = SRGBColorSpace
    glow.wrapS = RepeatWrapping
    glow.needsUpdate = true
    const f = new Float32Array(buf)
    const N = f.length / 7
    const pos = new Float32Array(N * 3)
    const col = new Float32Array(N * 3)
    const mag = new Float32Array(N)
    const vmag = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      pos[i * 3] = f[i * 7] * 1000
      pos[i * 3 + 1] = f[i * 7 + 1] * 1000
      pos[i * 3 + 2] = f[i * 7 + 2] * 1000
      mag[i] = Math.pow(10, -0.4 * (f[i * 7 + 3] - 1))
      vmag[i] = f[i * 7 + 3]
      col[i * 3] = f[i * 7 + 4]
      col[i * 3 + 1] = f[i * 7 + 5]
      col[i * 3 + 2] = f[i * 7 + 6]
    }
    const g = new BufferGeometry()
    g.setAttribute('position', new BufferAttribute(pos, 3))
    g.setAttribute('color', new BufferAttribute(col, 3))
    g.setAttribute('aMag', new BufferAttribute(mag, 1))
    g.setAttribute('aVMag', new BufferAttribute(vmag, 1))
    const material = new ShaderMaterial({
      uniforms: { uIntensity: { value: 1 }, uPx: { value: 1 }, uLim: { value: 8 } },
      vertexShader: /* glsl */ `
attribute float aMag;
attribute float aVMag;
attribute vec3 color;
uniform float uIntensity;
uniform float uPx;
uniform float uLim;
varying vec3 vCol;
varying float vB;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w * 0.99999;
  // energy-conserving: faint stars are 1px, brightness goes into intensity, only the brightest grow
  float size = 1.0 + clamp(log(1.0 + aMag) * 0.9, 0.0, 2.4);
  gl_PointSize = size * uPx;
  // exposure-limited: stars fainter than the limiting magnitude fade out (faint first)
  float vis = smoothstep(uLim + 0.3, uLim - 1.2, aVMag);
  vB = aMag * uIntensity / (size * size) * 1.5 * vis;
  if (vis <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vCol = color;
}`,
      fragmentShader: /* glsl */ `
varying vec3 vCol;
varying float vB;
void main(){
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float g = exp(-d * d * 3.5);
  gl_FragColor = vec4(vCol * vB * g, 1.0);
}`,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: AdditiveBlending,
    })
    return { geo: g, mat: material }
  }, [glow, buf])
  useFrame(({ camera }) => {
    ref.current.position.copy(camera.position)
    if (getQuat) ref.current.quaternion.copy(getQuat())
    const I = getIntensity()
    const lim = getLimMag()
    mat.uniforms.uIntensity.value = I
    mat.uniforms.uLim.value = lim
    mat.uniforms.uPx.value = Math.min(window.devicePixelRatio || 1, 2)
    ref.current.visible = I > 0.001 && lim > -1.5
  })
  // the galactic glow needs a long exposure: gone below ~mag 4.5, full by ~6.8
  const mwI = () => getIntensity() * smoothstep01((getLimMag() - 4.5) / 2.3)
  return (
    <group ref={ref}>
      <points geometry={geo} material={mat} frustumCulled={false} renderOrder={-100} />
      <MilkyWay getIntensity={mwI} tex={glow} />
    </group>
  )
}

const smoothstep01 = (x: number) => {
  const k = Math.min(1, Math.max(0, x))
  return k * k * (3 - 2 * k)
}

/** Diffuse galactic light from real all-sky photometry, kept faint so space stays black. */
function MilkyWay({ getIntensity, tex }: { getIntensity: () => number; tex: Texture }) {
  const mat = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: { uTex: { value: tex }, uI: { value: 1 } },
        vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p; gl_Position.z = gl_Position.w * 0.99999; }`,
        fragmentShader: /* glsl */ `
${NOISE_GLSL}
uniform sampler2D uTex; uniform float uI; varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  // ESA Gaia EDR3 all-sky map, reprojected to equatorial: u = RA/360° + 0.5, v = (Dec + 90°)/180°
  vec2 uv = vec2(atan(-d.z, d.x) / 6.2831853 + 0.5, asin(clamp(d.y, -1.0, 1.0)) / 3.1415926 + 0.5);
  // seam-safe mip selection (Tarini): at the u = 0/1 wrap the derivative jumps and the GPU would pick the
  // coarsest mip for that 2x2 quad, drawing a dashed line along the RA 12h meridian; use the u that is continuous here
  float u1 = fract(uv.x);
  float u2 = fract(uv.x + 0.5) - 0.5;
  uv.x = fwidth(u1) < fwidth(u2) - 0.001 ? u1 : u2;
  vec3 c = texture2D(uTex, uv).rgb;
  // drop the faint all-sky stellar background so space stays black; deepen the dust lanes
  c = pow(max(c - 0.025, 0.0), vec3(1.12));
  // a touch of unresolved-star grain below the map's resolution
  float n = fbm3(d * 220.0, 3) * 0.5 + 0.5;
  c *= 0.94 + 0.12 * n;
  // real colour, slightly muted: warm bulge, neutral disc
  float l = dot(c, vec3(0.3, 0.5, 0.2));
  c = mix(vec3(l), c, 0.7);
  gl_FragColor = vec4(c * 0.05 * uI, 1.0);
}`,
        side: BackSide,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: AdditiveBlending,
      }),
    [tex],
  )
  useFrame(() => {
    mat.uniforms.uI.value = getIntensity()
  })
  const geo = useMemo(() => new SphereGeometry(900, 96, 48), [])
  return <mesh geometry={geo} material={mat} frustumCulled={false} renderOrder={-101} />
}

/** The Sun as seen from space: HDR disk + soft corona, occluded by planets via depth. */
export function SunSprite({ getDir }: { getDir: () => Vector3 }) {
  const core = useRef<Mesh>(null!)
  const halo = useRef<Mesh>(null!)
  const plane = useMemo(() => new PlaneGeometry(1, 1), [])
  const mk = (color: Color, intensity: number, falloff: number, size: number) =>
    new ShaderMaterial({
      ...glowSpriteShader,
      uniforms: { uColor: { value: color }, uIntensity: { value: intensity }, uFalloff: { value: falloff }, uSize: { value: size } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    })
  const D = 1.2e8
  const coreMat = useMemo(() => mk(new Color(1.0, 0.97, 0.92), 60, 3.5, D * 0.0105), [])
  const haloMat = useMemo(() => mk(new Color(1.0, 0.9, 0.78), 1.6, 9, D * 0.22), [])
  useFrame(({ camera }) => {
    const d = getDir()
    for (const m of [core.current, halo.current]) m.position.copy(camera.position).addScaledVector(d, D)
  })
  return (
    <group>
      <mesh ref={halo} geometry={plane} material={haloMat} frustumCulled={false} renderOrder={2} />
      <mesh ref={core} geometry={plane} material={coreMat} frustumCulled={false} renderOrder={2} />
    </group>
  )
}

/** Real planet surface under the sky dome's horizon (Earth: the same maps as the globe from orbit). */
export interface DomeGround { day: Texture; clouds: Texture; cloudCh: 'r' | 'b'; siteToObj: Matrix3; groundE: number; getCloudShift: () => number }

/** Sky dome for the surface worlds; follows the camera. `worldScale` = world units per km (1000 for metre worlds). */
export function SkyDome({ params, getSun, getAltKm, groundAlbedo, sunDisk = 40, exposure = 1, ground, worldScale = 1000 }: {
  params: AtmosphereParams
  getSun: () => Vector3
  getAltKm: () => number
  groundAlbedo: Color
  sunDisk?: number
  exposure?: number
  ground?: DomeGround
  worldScale?: number
}) {
  const ref = useRef<Mesh>(null!)
  const q = useMission((s) => s.quality)
  const mat = useMemo(
    () =>
      new ShaderMaterial({
        ...skyDomeShader,
        defines: {
          ATMO_STEPS: QUALITY[q].atmoSteps,
          ATMO_LSTEPS: QUALITY[q].atmoLightSteps,
          ...(ground ? { EARTH_GROUND: 1, CLOUD_CH: ground.cloudCh } : {}),
        },
        uniforms: {
          ...atmosphereUniforms(params),
          uSunDir: { value: new Vector3(0, 1, 0) },
          uCamAltKm: { value: 0 },
          uCamOffKm: { value: new Vector2() },
          uGroundAlbedo: { value: groundAlbedo },
          uSunDisk: { value: sunDisk },
          uExposure: { value: exposure },
          uDay: { value: ground?.day ?? null },
          uClouds: { value: ground?.clouds ?? null },
          uSiteToObj: { value: ground?.siteToObj ?? new Matrix3() },
          uGroundE: { value: ground?.groundE ?? 1 },
          uCloudShift: { value: 0 },
        },
        side: BackSide,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    [params, groundAlbedo, sunDisk, exposure, q, ground],
  )
  const geo = useMemo(() => new SphereGeometry(400000, 96, 48), [])
  useFrame(({ camera }) => {
    ref.current.position.copy(camera.position)
    mat.uniforms.uSunDir.value.copy(getSun())
    mat.uniforms.uCamAltKm.value = getAltKm()
    if (ground) {
      mat.uniforms.uCamOffKm.value.set(camera.position.x / worldScale, camera.position.z / worldScale)
      mat.uniforms.uCloudShift.value = ground.getCloudShift()
    }
  })
  return <mesh ref={ref} geometry={geo} material={mat} frustumCulled={false} renderOrder={-50} />
}

/** Standalone sky material used when rendering environment (reflection) maps. */
export function makeEnvSkyMaterial(params: AtmosphereParams, sun: Vector3, altKm: number, groundAlbedo: Color) {
  return new ShaderMaterial({
    ...skyDomeShader,
    defines: { ATMO_STEPS: 12, ATMO_LSTEPS: 4 },
    uniforms: {
      ...atmosphereUniforms(params),
      uSunDir: { value: sun.clone() },
      uCamAltKm: { value: altKm },
      uCamOffKm: { value: new Vector2() },
      uGroundAlbedo: { value: groundAlbedo },
      uSunDisk: { value: 0 },
      uExposure: { value: 1 },
    },
    side: BackSide,
    depthWrite: false,
  })
}


// ---------------------------------------------------------------------------
// Auto-exposure proxy for the star field
// ---------------------------------------------------------------------------
export interface GlareSphere { c: Vector3; r: number; albedo: number }
export interface GlareCapsule { a: Vector3; axis: Vector3; len: number; r: number; albedo: number }
const _rd = new Vector3()
const _oc = new Vector3()
const _w = new Vector3()
const GX = 32
const GY = 18

function sphereT(o: Vector3, d: Vector3, c: Vector3, r: number) {
  _oc.copy(o).sub(c)
  const b = _oc.dot(d)
  const q = _oc.lengthSq() - r * r
  const h = b * b - q
  if (h < 0) return -1
  const t = -b - Math.sqrt(h)
  return t > 0 ? t : -1
}

/** Ray vs capsule (segment a..a+axis*len, radius r): true if the ray passes within r of the segment. */
function capsuleHit(o: Vector3, d: Vector3, cap: GlareCapsule) {
  _w.copy(o).sub(cap.a)
  const b = d.dot(cap.axis)
  const dd = d.dot(_w)
  const e = cap.axis.dot(_w)
  const den = 1 - b * b
  let s = den > 1e-6 ? (e - b * dd) / den : e
  s = Math.min(cap.len, Math.max(0, s))
  const t = Math.max(0, s * b - dd)
  _oc.copy(o).addScaledVector(d, t).sub(cap.a).addScaledVector(cap.axis, -s)
  return _oc.length() < cap.r
}

/**
 * Mean scene luminance (albedo x sun cosine, 0..1) over a 32x18 ray grid: how much of the
 * frame is filled by sunlit planet or vehicle. Drives the stars' limiting magnitude.
 */
export function frameGlare(camera: Camera, sun: Vector3, spheres: GlareSphere[], capsules: GlareCapsule[], sunVis = 1) {
  let sum = 0
  const o = camera.position
  for (let j = 0; j < GY; j++) {
    for (let i = 0; i < GX; i++) {
      _rd.set(((i + 0.5) / GX) * 2 - 1, ((j + 0.5) / GY) * 2 - 1, 0.5).unproject(camera).sub(o).normalize()
      let best = Infinity
      let lum = 0
      for (const sp of spheres) {
        const t = sphereT(o, _rd, sp.c, sp.r)
        if (t > 0 && t < best) {
          best = t
          _w.copy(o).addScaledVector(_rd, t).sub(sp.c).normalize()
          lum = sp.albedo * Math.max(0, _w.dot(sun))
        }
      }
      for (const cp of capsules) if (capsuleHit(o, _rd, cp)) lum = Math.max(lum, cp.albedo * sunVis)
      sum += lum
    }
  }
  // the sun itself in (or just outside) the frame floods the sensor
  _rd.copy(sun).applyQuaternion(_qInv.copy(camera.quaternion).invert())
  const fov = ((camera as PerspectiveCamera).fov ?? 40) * (Math.PI / 180)
  const off = Math.acos(Math.min(1, Math.max(-1, -_rd.z)))
  const sunIn = sunVis * (1 - Math.min(1, Math.max(0, (off - fov * 0.5) / (fov * 0.5))))
  return sum / (GX * GY) + sunIn * 0.5
}
const _qInv = new Quaternion()

/** Limiting magnitude for a given scene glare and exposure offset (EV). */
export function limitingMagnitude(glare: number, ev: number) {
  return 7.2 + 0.75 * ev - 2.5 * Math.log10(1 + 400 * glare)
}
