import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import {
  BoxGeometry, CircleGeometry, Color, DoubleSide, Group, InstancedMesh, LatheGeometry, Matrix4, Mesh, MeshBasicMaterial, Quaternion,
  MeshStandardMaterial, NoColorSpace, PlaneGeometry, RepeatWrapping, SRGBColorSpace, ShaderMaterial, SphereGeometry, TextureLoader,
  Vector2, Vector3, type Texture,
} from 'three'
import { MOUNT_HEIGHT } from '../../mission/constants'
import { runtime } from '../../mission/store'
import { cloudLayerShader } from '../../shaders/sky'
import { rng } from '../../utils/math'
import { makeTankTextures } from '../../utils/proceduralTextures'
import { beamMatrix } from '../vehicle/geometry'

/**
 * Coastal launch site: lattice tower with chopstick arms and ship quick-
 * disconnect, launch mount, tank farm, integration buildings, service trucks,
 * a procedural ground (concrete / tidal flats / dunes / beach / ocean) and a
 * drifting cumulus deck. All procedural — no model files.
 */

export const TOWER_POS = new Vector3(0, 0, -24)
const TOWER_HALF = 6
const TOWER_HEIGHT = 146

// ---------------------------------------------------------------------------
// CC0 PBR sets (ambientCG / Poly Haven), mapped in world space. Each set is a
// colour map + a packed map (RG = OpenGL normal XY, B = roughness). Until the
// images arrive the materials fall back to their flat parameters.
// ---------------------------------------------------------------------------
type PbrSet = 'concrete' | 'steel' | 'rust' | 'sand' | 'mud' | 'gravel'
const PBR_SETS: PbrSet[] = ['concrete', 'steel', 'rust', 'sand', 'mud', 'gravel']
const pbrOn = { value: 0 }
type PbrTex = Record<PbrSet, { c: Texture; n: Texture }>
let pbrTex: PbrTex | null = null
function pbr() {
  if (pbrTex) return pbrTex
  const loader = new TextureLoader()
  let pending = PBR_SETS.length * 2
  const done = () => void (--pending === 0 && (pbrOn.value = 1))
  const load = (f: string, srgb: boolean) => {
    const t = loader.load(`${import.meta.env.BASE_URL}textures/pbr/${f}`, done, undefined, done)
    t.wrapS = t.wrapT = RepeatWrapping
    t.colorSpace = srgb ? SRGBColorSpace : NoColorSpace
    t.anisotropy = 8
    return t
  }
  pbrTex = Object.fromEntries(PBR_SETS.map((k) => [k, { c: load(`${k}_color.jpg`, true), n: load(`${k}_nr.jpg`, false) }])) as PbrTex
  return pbrTex
}

/** Triplanar blend weights and samplers shared by the site materials. */
const TRI_GLSL = /* glsl */ `
vec3 triW(vec3 n){ vec3 w = pow(abs(n), vec3(4.0)); return w / (w.x + w.y + w.z); }
vec4 triTex(sampler2D t, vec3 p, vec3 w){ return texture2D(t, p.zy) * w.x + texture2D(t, p.xz) * w.y + texture2D(t, p.xy) * w.z; }
// whiteout-blended triplanar normal (world space); packed map: RG normal, B roughness
vec3 triNrm(sampler2D t, vec3 p, vec3 n, vec3 w, float k, out float rough){
  vec4 a = texture2D(t, p.zy); vec4 b = texture2D(t, p.xz); vec4 c = texture2D(t, p.xy);
  rough = a.b * w.x + b.b * w.y + c.b * w.z;
  vec2 ax = (a.xy * 2.0 - 1.0) * k; vec2 by = (b.xy * 2.0 - 1.0) * k; vec2 cz = (c.xy * 2.0 - 1.0) * k;
  vec3 tx = vec3(ax + n.zy, n.x); vec3 ty = vec3(by + n.xz, n.y); vec3 tz = vec3(cz + n.xy, n.z);
  return normalize(tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z);
}
float sh1(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float sn3(vec3 p){ vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(sh1(i), sh1(i + vec3(1,0,0)), f.x), mix(sh1(i + vec3(0,1,0)), sh1(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(sh1(i + vec3(0,0,1)), sh1(i + vec3(1,0,1)), f.x), mix(sh1(i + vec3(0,1,1)), sh1(i + vec3(1,1,1)), f.x), f.y), f.z); }
`

interface SiteMatOpts {
  set: PbrSet
  /** metres per texture repeat */
  size: number
  color: Color
  metalness: number
  roughness: number
  /** multiplies the texture colour (the textures are neutral-ish) */
  tint?: Color
  normal?: number
  /** amount of rust bleeding in (0..1) */
  rust?: number
  /** exhaust soot: radius (m) around the mount axis where it is heaviest, and strength */
  soot?: [number, number]
}

/** MeshStandardMaterial with world-space triplanar PBR, macro variation, rust and soot. */
function siteMaterial(o: SiteMatOpts) {
  const m = new MeshStandardMaterial({ color: o.color, metalness: o.metalness, roughness: o.roughness })
  const t = pbr()
  const uniforms = {
    tC: { value: t[o.set].c }, tN: { value: t[o.set].n }, tRC: { value: t.rust.c }, tRN: { value: t.rust.n },
    uOn: pbrOn, uSize: { value: o.size }, uTint: { value: o.tint ?? new Color(1, 1, 1) }, uNrm: { value: o.normal ?? 1 },
    uRust: { value: o.rust ?? 0 }, uSoot: { value: new Vector2(...(o.soot ?? [1, 0])) },
  }
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms)
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPW;\nvarying vec3 vNW;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vec4 pw = vec4(transformed, 1.0);
vec3 nw = objectNormal;
#ifdef USE_INSTANCING
  pw = instanceMatrix * pw;
  nw = mat3(instanceMatrix) * nw;
#endif
vPW = (modelMatrix * pw).xyz;
vNW = normalize(mat3(modelMatrix) * nw);`,
      )
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vPW;
varying vec3 vNW;
uniform sampler2D tC; uniform sampler2D tN; uniform sampler2D tRC; uniform sampler2D tRN;
uniform float uOn; uniform float uSize; uniform vec3 uTint; uniform float uNrm; uniform float uRust; uniform vec2 uSoot;
${TRI_GLSL}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
vec3 sN = normalize(vNW);
vec3 sW = triW(sN);
vec3 sP = vPW / uSize;
float sDist = length(vPW - cameraPosition);
// macro variation breaks up the repeat; detail fades to the mip average far away
float sMacro = sn3(vPW * 0.045) * 0.6 + sn3(vPW * 0.19) * 0.4;
vec3 sCol = triTex(tC, sP, sW).rgb * uTint;
float sRustM = uRust > 0.0 ? smoothstep(0.6, 0.92, sMacro + sn3(vPW * 0.9) * 0.25 + (1.0 - smoothstep(0.0, 25.0, vPW.y)) * 0.15) * uRust : 0.0;
sCol = mix(sCol, triTex(tRC, vPW / 2.2, sW).rgb, sRustM);
float sSootR = length(vPW.xz);
float sSoot = uSoot.y * (1.0 - smoothstep(uSoot.x * 0.4, uSoot.x, sSootR + sMacro * uSoot.x * 0.3));
sCol *= mix(1.0, 0.18, clamp(sSoot, 0.0, 1.0));
sCol *= 0.86 + 0.28 * sMacro;
diffuseColor.rgb = mix(diffuseColor.rgb, sCol, uOn);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
float sRough;
vec3 sNW = triNrm(tN, sP, sN, sW, uNrm * (1.0 - smoothstep(60.0, 900.0, sDist)), sRough);
float sRR; vec3 sRN = triNrm(tRN, vPW / 2.2, sN, sW, 1.0, sRR);
sNW = normalize(mix(sNW, sRN, sRustM));
sRough = mix(sRough, sRR, sRustM);
roughnessFactor = mix(roughnessFactor, clamp(sRough * roughness * 1.6 + sSoot * 0.2, 0.04, 1.0), uOn);`,
      )
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor *= 1.0 - max(sRustM, sSoot * 0.7) * uOn;')
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
if (uOn > 0.5) normal = normalize((viewMatrix * vec4(sNW, 0.0)).xyz) * (gl_FrontFacing ? 1.0 : -1.0);`,
      )
  }
  m.customProgramCacheKey = () => `site-${o.set}-${o.rust ? 1 : 0}`
  return m
}

// Starbase: dark grey painted structural steel (a dielectric coat, not bare metal), light salt-air rust
const towerMat = siteMaterial({ set: 'steel', size: 3.2, color: new Color(0.19, 0.2, 0.21), metalness: 0.25, roughness: 0.75, tint: new Color(0.8, 0.82, 0.85), rust: 0.12 })
const plateMat = siteMaterial({ set: 'steel', size: 2.1, color: new Color(0.16, 0.17, 0.18), metalness: 0.3, roughness: 0.7, tint: new Color(0.7, 0.72, 0.75), rust: 0.2 })
const mountMat = siteMaterial({ set: 'steel', size: 3.6, color: new Color(0.3, 0.3, 0.3), metalness: 0.35, roughness: 0.75, tint: new Color(1.25, 1.24, 1.22), rust: 0.25, soot: [15, 0.8] })
const concreteMat = siteMaterial({ set: 'concrete', size: 5, color: new Color(0.5, 0.49, 0.46), metalness: 0, roughness: 0.9, tint: new Color(0.95, 0.93, 0.9), soot: [18, 0.7] })
const deckMat = siteMaterial({ set: 'steel', size: 4, color: new Color(0.3, 0.29, 0.28), metalness: 0.3, roughness: 0.8, tint: new Color(0.9, 0.88, 0.86), rust: 0.3, soot: [13, 0.85] })
const tankTex = makeTankTextures()
const tankMat = new MeshStandardMaterial({ color: new Color(0.92, 0.93, 0.94), metalness: 0.15, roughness: 1, map: tankTex.map, roughnessMap: tankTex.roughnessMap })
const buildingMat = new MeshStandardMaterial({ color: new Color(0.72, 0.73, 0.74), metalness: 0.3, roughness: 0.6 })
const truckMat = new MeshStandardMaterial({ color: new Color(0.8, 0.8, 0.78), metalness: 0.3, roughness: 0.45 })
const redLight = new MeshBasicMaterial({ color: new Color(12, 0.4, 0.2) })
const whiteLight = new MeshBasicMaterial({ color: new Color(9, 9, 8) })

// ---------------------------------------------------------------------------
function towerBeams() {
  const list: Matrix4[] = []
  const add = (a: Vector3, b: Vector3, w: number) => list.push(beamMatrix(a, b, w, w))
  const c = TOWER_POS
  const h = TOWER_HALF
  const corners = [new Vector2(-h, -h), new Vector2(h, -h), new Vector2(h, h), new Vector2(-h, h)]
  const levels = 16
  const dy = TOWER_HEIGHT / levels
  for (let l = 0; l < levels; l++) {
    const y0 = l * dy
    const y1 = (l + 1) * dy
    for (let k = 0; k < 4; k++) {
      const p = corners[k]
      const q = corners[(k + 1) % 4]
      const A0 = new Vector3(c.x + p.x, y0, c.z + p.y)
      const A1 = new Vector3(c.x + p.x, y1, c.z + p.y)
      const B0 = new Vector3(c.x + q.x, y0, c.z + q.y)
      const B1 = new Vector3(c.x + q.x, y1, c.z + q.y)
      add(A0, A1, 1.15) // column
      add(A1, B1, 0.62) // girt
      add(A0, B1, 0.42) // X-brace
      add(B0, A1, 0.42)
    }
  }
  // top platform + mast
  add(new Vector3(c.x, TOWER_HEIGHT, c.z), new Vector3(c.x, TOWER_HEIGHT + 16, c.z), 0.5)
  add(new Vector3(c.x - h, TOWER_HEIGHT + 3, c.z - h), new Vector3(c.x + h, TOWER_HEIGHT + 3, c.z + h), 0.4)

  // chopstick arms (open), riding on a carriage
  const carriageY = 72
  for (const s of [-1, 1]) {
    const root = new Vector3(c.x + s * (h + 0.6), carriageY, c.z + h + 0.6)
    const dir = new Vector3(s * Math.sin((52 * Math.PI) / 180), 0, Math.cos((52 * Math.PI) / 180))
    const len = 34
    const perp = new Vector3(-dir.z, 0, dir.x)
    const chords: [number, number][] = [[0, 0], [0, 3.6], [1.9, 0], [1.9, 3.6]]
    for (const [o, y] of chords) {
      const a = root.clone().addScaledVector(perp, o - 0.95).setY(carriageY + y)
      add(a, a.clone().addScaledVector(dir, len), 0.5)
    }
    const bays = 10
    for (let i = 0; i < bays; i++) {
      for (const o of [-0.95, 0.95]) {
        const a = root.clone().addScaledVector(perp, o).addScaledVector(dir, (i * len) / bays).setY(carriageY)
        const b = root.clone().addScaledVector(perp, o).addScaledVector(dir, ((i + 1) * len) / bays).setY(carriageY + 3.6)
        add(a, b, 0.28)
      }
    }
  }
  return list
}

/** Column splice collars and gusset plates at every lattice node. */
function towerPlates() {
  const list: Matrix4[] = []
  const c = TOWER_POS
  const h = TOWER_HALF
  const corners = [new Vector2(-h, -h), new Vector2(h, -h), new Vector2(h, h), new Vector2(-h, h)]
  const levels = 16
  const dy = TOWER_HEIGHT / levels
  const up = new Vector3(0, 1, 0)
  for (let l = 1; l <= levels; l++) {
    const y = l * dy
    for (let k = 0; k < 4; k++) {
      const p = corners[k]
      const node = new Vector3(c.x + p.x, y, c.z + p.y)
      list.push(new Matrix4().compose(node, new Quaternion(), new Vector3(1.45, 0.55, 1.45)))
      for (const q of [corners[(k + 1) % 4], corners[(k + 3) % 4]]) {
        const dir = new Vector3(q.x - p.x, 0, q.y - p.y).normalize()
        const n = new Vector3(p.x + q.x, 0, p.y + q.y).normalize()
        const rot = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(dir, up, n))
        const pos = node.clone().addScaledVector(dir, 1.05).addScaledVector(n, 0.6).setY(y - 0.35)
        list.push(new Matrix4().compose(pos, rot, new Vector3(2.1, 1.9, 0.06)))
      }
    }
  }
  return list
}

function Instanced({ mats, material }: { mats: Matrix4[]; material: MeshStandardMaterial }) {
  const ref = useRef<InstancedMesh>(null!)
  const box = useMemo(() => new BoxGeometry(1, 1, 1), [])
  useLayoutEffect(() => {
    mats.forEach((m, i) => ref.current.setMatrixAt(i, m))
    ref.current.instanceMatrix.needsUpdate = true
    ref.current.computeBoundingSphere()
  }, [mats])
  return <instancedMesh ref={ref} args={[box, material, mats.length]} castShadow receiveShadow />
}

function Tower() {
  const ref = useRef<InstancedMesh>(null!)
  const beams = useMemo(towerBeams, [])
  const plates = useMemo(towerPlates, [])
  const box = useMemo(() => new BoxGeometry(1, 1, 1), [])
  useLayoutEffect(() => {
    beams.forEach((m, i) => ref.current.setMatrixAt(i, m))
    ref.current.instanceMatrix.needsUpdate = true
    ref.current.computeBoundingSphere()
  }, [beams])
  const c = TOWER_POS
  return (
    <group>
      <instancedMesh ref={ref} args={[box, towerMat, beams.length]} castShadow receiveShadow />
      <Instanced mats={plates} material={plateMat} />
      {/* carriage around the tower */}
      <mesh position={[c.x, 74, c.z]} castShadow receiveShadow material={towerMat}>
        <boxGeometry args={[TOWER_HALF * 2 + 2.6, 5, TOWER_HALF * 2 + 2.6]} />
      </mesh>
      {/* equipment huts at the base */}
      <mesh position={[c.x, 5, c.z]} castShadow receiveShadow material={concreteMat}>
        <boxGeometry args={[TOWER_HALF * 2 - 1, 10, TOWER_HALF * 2 - 1]} />
      </mesh>
      <QdArm />
      <BlinkLights />
    </group>
  )
}

/** Ship quick-disconnect arm: swings away before ignition. */
function QdArm() {
  const pivot = useRef<Group>(null!)
  const c = TOWER_POS
  useFrame(() => {
    pivot.current.rotation.y = runtime.state.qdArm * 1.3
  })
  const y = MOUNT_HEIGHT + 71 + 4
  const len = 12.5
  return (
    <group position={[c.x + TOWER_HALF, y, c.z + TOWER_HALF]} ref={pivot}>
      <mesh position={[-TOWER_HALF + 1.4, 0, len / 2]} material={towerMat} castShadow>
        <boxGeometry args={[2.6, 2.6, len]} />
      </mesh>
      <mesh position={[-TOWER_HALF + 1.4, -0.4, len + 0.6]} material={mountMat} castShadow>
        <boxGeometry args={[3.2, 3.4, 1.4]} />
      </mesh>
    </group>
  )
}

function BlinkLights() {
  const g = useRef<Group>(null!)
  const geo = useMemo(() => new SphereGeometry(0.55, 12, 8), [])
  useFrame(() => {
    const on = Math.sin(runtime.ambient * Math.PI * 1.1) > 0.35
    g.current.children.forEach((c, i) => (c.visible = i < 3 ? on : Math.sin(runtime.ambient * 4 + i) > 0.9))
  })
  const c = TOWER_POS
  return (
    <group ref={g}>
      <mesh geometry={geo} material={redLight} position={[c.x, TOWER_HEIGHT + 16.5, c.z]} />
      <mesh geometry={geo} material={redLight} position={[c.x - TOWER_HALF, TOWER_HEIGHT + 0.8, c.z + TOWER_HALF]} />
      <mesh geometry={geo} material={redLight} position={[c.x + TOWER_HALF, TOWER_HEIGHT + 0.8, c.z - TOWER_HALF]} />
      <mesh geometry={geo} material={whiteLight} position={[10.5, MOUNT_HEIGHT + 0.6, 6]} />
      <mesh geometry={geo} material={whiteLight} position={[-10.5, MOUNT_HEIGHT + 0.6, -6]} />
    </group>
  )
}

// ---------------------------------------------------------------------------
function LaunchMount() {
  const table = useMemo(() => {
    const pts = [new Vector2(5.2, 16.2), new Vector2(11.8, 16.2), new Vector2(11.8, MOUNT_HEIGHT), new Vector2(5.2, MOUNT_HEIGHT), new Vector2(5.2, 16.2)]
    return new LatheGeometry(pts, 72)
  }, [])
  const clamps = useMemo(() => {
    const l: [number, number, number, number][] = []
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2
      l.push([Math.cos(a) * 5.6, MOUNT_HEIGHT + 0.5, Math.sin(a) * 5.6, -a])
    }
    return l
  }, [])
  return (
    <group>
      <mesh geometry={table} material={mountMat} castShadow receiveShadow />
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6
        return (
          <mesh key={i} position={[Math.cos(a) * 9.8, 8.1, Math.sin(a) * 9.8]} rotation-y={-a} material={concreteMat} castShadow receiveShadow>
            <boxGeometry args={[3.2, 16.2, 2.6]} />
          </mesh>
        )
      })}
      {clamps.map(([x, y, z, r], i) => (
        <mesh key={i} position={[x, y, z]} rotation-y={r} material={mountMat} castShadow>
          <boxGeometry args={[1.1, 1.2, 0.9]} />
        </mesh>
      ))}
      {/* steel deluge plate + foundation */}
      <mesh position={[0, 0.2, 0]} rotation-x={-Math.PI / 2} receiveShadow material={deckMat}>
        <circleGeometry args={[12, 64]} />
      </mesh>
      {/* booster quick-disconnect */}
      <mesh position={[7.4, 18.2, 4.5]} material={towerMat} castShadow>
        <boxGeometry args={[3, 3.6, 3]} />
      </mesh>
    </group>
  )
}

// ---------------------------------------------------------------------------
function TankFarm() {
  const items = useMemo(() => {
    const r = rng(42)
    const v: { p: [number, number, number]; s: [number, number, number]; horiz?: boolean }[] = []
    for (let i = 0; i < 9; i++) v.push({ p: [-300 + (i % 3) * 16, 0, 20 + Math.floor(i / 3) * 16], s: [5.2, 24 + r() * 8, 5.2] })
    for (let i = 0; i < 6; i++) v.push({ p: [-360 + i * 11, 3.4, 110], s: [3.2, 28, 3.2], horiz: true })
    return v
  }, [])
  return (
    <group>
      {items.map((it, i) => (
        <mesh
          key={i}
          position={it.horiz ? [it.p[0], it.p[1], it.p[2]] : [it.p[0], it.s[1] / 2, it.p[2]]}
          rotation-x={it.horiz ? Math.PI / 2 : 0}
          material={tankMat}
          castShadow
          receiveShadow
        >
          <cylinderGeometry args={[it.s[0], it.s[0], it.s[1], 32]} />
        </mesh>
      ))}
      <mesh position={[-290, 0.15, 60]} rotation-x={-Math.PI / 2} receiveShadow material={concreteMat}>
        <planeGeometry args={[140, 130]} />
      </mesh>
    </group>
  )
}

function Buildings() {
  const list: [number, number, number, number, number, number][] = [
    [-2650, 0, 420, 70, 92, 46],
    [-2560, 0, 520, 50, 64, 40],
    [-2800, 0, 300, 120, 22, 60],
    [-1800, 0, -900, 40, 18, 30],
    [-1450, 0, 1250, 30, 12, 24],
  ]
  return (
    <group>
      {list.map(([x, y, z, w, h, d], i) => (
        <mesh key={i} position={[x, y + h / 2, z]} material={buildingMat} castShadow receiveShadow>
          <boxGeometry args={[w, h, d]} />
        </mesh>
      ))}
    </group>
  )
}

/** Service trucks and light poles — human-scale references next to a 121 m rocket. */
function ScaleProps() {
  const trucks: [number, number, number][] = [
    [48, 0, 64], [55, 0, 70], [-70, 0, 30], [-120, 0, 8], [-160, 0, -6],
  ]
  const poles = useMemo(() => {
    const l: [number, number][] = []
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.3
      l.push([Math.cos(a) * 140, Math.sin(a) * 140])
    }
    return l
  }, [])
  return (
    <group>
      {trucks.map((p, i) => (
        <group key={i} position={p} rotation-y={i * 0.7}>
          <mesh position={[0, 1.1, 0]} material={truckMat} castShadow>
            <boxGeometry args={[5.4, 1.6, 2.1]} />
          </mesh>
          <mesh position={[1.4, 2.2, 0]} material={truckMat} castShadow>
            <boxGeometry args={[2.2, 1.0, 2.0]} />
          </mesh>
        </group>
      ))}
      {poles.map(([x, z], i) => (
        <group key={i} position={[x, 0, z]}>
          <mesh position={[0, 12, 0]} material={towerMat} castShadow>
            <cylinderGeometry args={[0.25, 0.35, 24, 8]} />
          </mesh>
          <mesh position={[0, 24.4, 0]} material={whiteLight}>
            <boxGeometry args={[2.4, 0.5, 1.2]} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

// ---------------------------------------------------------------------------
/**
 * Ground: weathered concrete pad, gravel apron, Boca Chica tidal flats (grey-brown
 * sand, wet mud, sparse scrub, standing water), beach and open ocean. Close up it
 * is textured with CC0 scans at two rotated scales; far away it fades to the
 * textures' mean colour so the repeat never shows.
 */
function makeGroundMaterial() {
  const m = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 })
  const t = pbr()
  const uniforms = {
    uTime: { value: 0 }, uOn: pbrOn,
    tSandC: { value: t.sand.c }, tSandN: { value: t.sand.n }, tMudC: { value: t.mud.c }, tMudN: { value: t.mud.n },
    tGravC: { value: t.gravel.c }, tGravN: { value: t.gravel.n }, tConcC: { value: t.concrete.c }, tConcN: { value: t.concrete.n },
  }
  m.userData.uniforms = uniforms
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms)
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vW;
uniform float uTime;
uniform float uOn;
uniform sampler2D tSandC; uniform sampler2D tSandN; uniform sampler2D tMudC; uniform sampler2D tMudN;
uniform sampler2D tGravC; uniform sampler2D tGravN; uniform sampler2D tConcC; uniform sampler2D tConcN;
float gh(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float gn(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(gh(i),gh(i+vec2(1,0)),u.x),mix(gh(i+vec2(0,1)),gh(i+vec2(1,1)),u.x),u.y); }
float gf(vec2 p){ float a=0.5,s=0.0; for(int i=0;i<5;i++){ s+=a*gn(p); p=p*2.03+vec2(1.3,7.1); a*=0.5; } return s; }
float shoreX(float z){ return 1500.0 + 220.0*sin(z/1800.0) + 160.0*(gf(vec2(z/700.0, 3.1))-0.5); }
float sx0(vec2 p){ return shoreX(p.y); }
mat2 gRot(float a){ float c=cos(a), s=sin(a); return mat2(c,-s,s,c); }
// texture detail with a mip-average fallback (k = 0 far away)
vec3 gTex(sampler2D t, vec2 uv, float k){ return mix(textureLod(t, vec2(0.5), 12.0).rgb, texture2D(t, uv).rgb, k); }
vec3 gNrm(sampler2D t, vec2 uv, out float r){ vec4 n = texture2D(t, uv); r = n.b; return vec3(n.xy * 2.0 - 1.0, 0.0); }
// layer weights shared by albedo, roughness and normals
struct GL { float conc; float grav; float mud; float scrub; float water; float beach; float pad; float d; float macro; };
GL gLayers(vec2 p){
  GL L;
  L.d = length(p);
  float big = gf(p * 0.0012);
  float mid = gf(p * 0.011);
  L.macro = gf(p * 0.035) * 0.6 + mid * 0.4;
  L.scrub = smoothstep(0.47, 0.62, big + mid * 0.3) * 0.8;
  L.mud = smoothstep(0.48, 0.66, gf(p * 0.004 + 7.0) + (mid - 0.5) * 0.25);
  // tidal-flat standing water (reflective sheets), shallow puddles even near the pad apron
  float puddle = smoothstep(0.62, 0.66, gf(p * 0.0035 + 13.0) + mid * 0.08) * smoothstep(250.0, 600.0, L.d);
  // a few shallow puddles on the flats beyond the apron (not a rash of pools around the pad)
  puddle = max(puddle, smoothstep(0.76, 0.79, gf(p * 0.02 + 3.0) + mid * 0.1) * smoothstep(300.0, 450.0, L.d) * 0.7);
  float sx = shoreX(p.y);
  L.beach = smoothstep(sx - 120.0, sx - 20.0, p.x);
  float ocean = smoothstep(sx - 10.0, sx + 25.0, p.x);
  L.water = max(puddle * (1.0 - L.beach), ocean);
  L.pad = 1.0 - smoothstep(92.0, 96.0, L.d);
  float apron = step(abs(p.x + 290.0), 70.0) * step(abs(p.y - 60.0), 65.0);
  float roadC = abs(p.y - 4.0 + sin(p.x * 0.002) * 30.0);
  float onRoad = step(p.x, -20.0) * step(-3200.0, p.x);
  float road = step(roadC, 7.0) * onRoad;
  L.conc = max(max(L.pad, apron), road);
  // gravel: pad perimeter, road shoulders, around the tank farm
  float ring = (1.0 - smoothstep(128.0, 142.0, L.d + (mid - 0.5) * 30.0));
  float shoulder = (1.0 - smoothstep(9.0, 14.0, roadC + (mid - 0.5) * 4.0)) * onRoad;
  float farm = step(abs(p.x + 290.0), 84.0) * step(abs(p.y - 60.0), 80.0);
  L.grav = max(max(ring, shoulder), farm) * (1.0 - L.conc);
  L.water *= 1.0 - max(L.conc, L.grav);
  return L;
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
vec2 gP = vW.xz;
float gDist = length(vW - cameraPosition);
float gK = uOn * (1.0 - smoothstep(700.0, 4500.0, gDist));
GL gL = gLayers(gP);
// sand flats at two rotated scales, blended by noise so neither repeat shows
vec2 uvA = gP / 11.0;
vec2 uvB = gRot(0.7) * gP / 29.0;
float gBlend = smoothstep(0.3, 0.7, gn(gP * 0.03));
vec3 sandT = mix(gTex(tSandC, uvA, gK), gTex(tSandC, uvB, gK), gBlend);
vec3 flats = sandT * vec3(0.86, 0.84, 0.8);
vec3 mudT = gTex(tMudC, gRot(1.9) * gP / 17.0, gK) * vec3(1.25, 1.2, 1.12);
flats = mix(flats, mudT, gL.mud * 0.75);
// sparse, dull salt-marsh scrub
vec3 scrubC = flats * vec3(0.72, 0.78, 0.55) * (0.75 + 0.5 * gn(gP * 0.9));
flats = mix(flats, scrubC, gL.scrub * smoothstep(0.35, 0.7, gn(gP * 0.21) + gn(gP * 1.3) * 0.3));
vec3 gAlb = flats * (0.8 + 0.4 * gL.macro);
gAlb = mix(gAlb, vec3(0.74, 0.68, 0.55) * (0.9 + gL.macro * 0.2), gL.beach);
vec3 gravT = gTex(tGravC, gP / 2.6, gK) * vec3(0.78, 0.77, 0.74) * (0.85 + 0.3 * gL.macro);
gAlb = mix(gAlb, gravT, gL.grav);
vec3 concT = mix(gTex(tConcC, gP / 5.0, gK), gTex(tConcC, gRot(1.2) * gP / 13.0, gK), 0.35) * vec3(0.98, 0.96, 0.93);
// expansion joints, slab-to-slab tone shifts, soot and heat staining around the mount
vec2 gj = abs(fract(gP / 6.0) - 0.5);
concT *= 1.0 - 0.3 * (1.0 - smoothstep(0.0, 0.015, min(gj.x, gj.y))) * gL.pad;
concT *= 0.88 + 0.24 * gh(floor(gP / 6.0));
float scorch = 1.0 - smoothstep(10.0, 40.0, gL.d + (gL.macro - 0.5) * 18.0);
concT *= mix(1.0, 0.22, scorch);
concT = mix(concT, concT * vec3(1.08, 0.95, 0.82), smoothstep(40.0, 25.0, gL.d) * (1.0 - scorch) * 0.6);
gAlb = mix(gAlb, concT, gL.conc);
// without the scans, keep the old flat tones
vec3 gOld = mix(vec3(0.34, 0.32, 0.28), vec3(0.52, 0.51, 0.48), gL.conc);
gAlb = mix(gOld, gAlb, uOn);
float gWater = gL.water;
vec3 deep = vec3(0.015, 0.05, 0.07);
// shallow water over mud stays brown
vec3 shallow = gAlb * vec3(0.35, 0.37, 0.38);
float gSx = sx0(gP);
diffuseColor.rgb = mix(gAlb, mix(shallow, deep, smoothstep(gSx - 10.0, gSx + 40.0, gP.x)), gWater);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
float rS, rM, rG, rC;
vec3 nS = gNrm(tSandN, uvA, rS);
vec3 nM = gNrm(tMudN, gRot(1.9) * gP / 17.0, rM);
vec3 nG = gNrm(tGravN, gP / 2.6, rG);
vec3 nC = gNrm(tConcN, gP / 5.0, rC);
float gRough = mix(mix(0.95 * rS + 0.1, 0.55 * rM + 0.15, gL.mud * 0.75), 0.9, gL.scrub * 0.3);
gRough = mix(gRough, rG * 0.8 + 0.2, gL.grav);
gRough = mix(gRough, rC * 0.7 + 0.25, gL.conc);
gRough = mix(0.9, clamp(gRough, 0.3, 1.0), uOn);
vec2 gTn = (nS.xy * (1.0 - gL.mud * 0.75) + nM.xy * gL.mud * 0.75);
gTn = mix(gTn, nG.xy * 1.3, gL.grav);
gTn = mix(gTn, nC.xy, gL.conc);
gTn *= gK * (1.0 - smoothstep(40.0, 600.0, gDist));
roughnessFactor = mix(gRough, mix(0.16, 0.06, 1.0 - smoothstep(300.0, 4000.0, gDist)), gWater);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
// planar xz mapping: tangent = +x, bitangent = +z
vec3 gNw = normalize(vec3(gTn.x, 1.0, gTn.y));
normal = normalize(mix(normal, normalize((viewMatrix * vec4(gNw, 0.0)).xyz), 1.0 - gWater));
float waveFade = 1.0 - smoothstep(150.0, 2200.0, gDist);
if (gWater > 0.01 && waveFade > 0.001) {
  vec2 wp = vW.xz;
  float t = uTime;
  vec2 grad = vec2(0.0);
  grad += vec2(0.8, 0.6) * cos(dot(wp, vec2(0.8, 0.6)) * 0.09 + t * 1.3) * 0.09;
  grad += vec2(-0.3, 0.95) * cos(dot(wp, vec2(-0.3, 0.95)) * 0.21 + t * 1.9) * 0.05;
  grad += vec2(0.95, -0.2) * cos(dot(wp, vec2(0.95, -0.2)) * 0.53 + t * 2.7) * 0.03;
  grad += (vec2(gn(wp * 0.35 + t * 0.4), gn(wp * 0.35 - t * 0.4 + 9.0)) - 0.5) * 0.12;
  vec3 wn = normalize(vec3(-grad.x, 1.0, -grad.y));
  vec3 wnV = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
  normal = normalize(mix(normal, wnV, gWater * waveFade));
}`,
      )
  }
  m.customProgramCacheKey = () => 'ground-launch-pbr'
  return m
}

function Ground() {
  const mat = useMemo(makeGroundMaterial, [])
  const geo = useMemo(() => new CircleGeometry(160000, 96).rotateX(-Math.PI / 2), [])
  useFrame(() => {
    mat.userData.uniforms.uTime.value = runtime.ambient
  })
  return <mesh geometry={geo} material={mat} receiveShadow />
}

// ---------------------------------------------------------------------------
export const cloudMaterials = [0, 1].map(
  (layer) =>
    new ShaderMaterial({
      ...cloudLayerShader,
      uniforms: {
        uSunDir: { value: new Vector3(0, 1, 0) },
        uSunColor: { value: new Color(1, 1, 1) },
        uAmbient: { value: new Color(0.3, 0.35, 0.45) },
        uHaze: { value: new Color(0.6, 0.7, 0.85) },
        uCoverage: { value: 0.56 + layer * 0.02 },
        uTime: { value: 0 },
        uLayer: { value: layer },
      },
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      side: DoubleSide,
    }),
)

function CloudDeck() {
  const geo = useMemo(() => new PlaneGeometry(260000, 260000).rotateX(-Math.PI / 2), [])
  const refs = useRef<Mesh[]>([])
  useFrame(() => {
    for (const m of cloudMaterials) m.uniforms.uTime.value = runtime.ambient
  })
  return (
    <group>
      {cloudMaterials.map((m, i) => (
        <mesh key={i} ref={(el) => void (el && (refs.current[i] = el))} geometry={geo} material={m} position-y={2300 + i * 220} renderOrder={2} />
      ))}
    </group>
  )
}

export function LaunchSite() {
  return (
    <group>
      <Ground />
      <LaunchMount />
      <Tower />
      <TankFarm />
      <Buildings />
      <ScaleProps />
      <CloudDeck />
    </group>
  )
}

