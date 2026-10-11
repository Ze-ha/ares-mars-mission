import { useFrame, useLoader } from '@react-three/fiber'
import { useMemo } from 'react'
import {
  Box3, BufferAttribute, Color, Group, Matrix4, Mesh, MeshStandardMaterial, Object3D, Vector3, type Material,
} from 'three'
import { type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { DEG } from '../../utils/math'
import { runtime } from '../../mission/store'
import { AnyGLTFLoader, binUrl } from '../../utils/binary'
import { boosterEngineLayout, RAPTOR_SL, RAPTOR_VAC, type EngineSlot } from './geometry'
import { vehicleMaterials } from './materials'

/**
 * Detailed Starship Block 3 + Super Heavy model.
 *
 * Model: "SpaceX Starship Block 3" by Clarence365 — CC BY 4.0
 * https://sketchfab.com/3d-models/spacex-starship-block-3-6f6c6f88a3eb4b4d822fdca66733fbb2
 * (via github.com/haskaomni/blueprint). Company logo, serial number and engine
 * labels are replaced with plain surfaces here.
 *
 * The GLB is split at load time into two stage templates that follow the
 * project's conventions (origin = engine exit plane, +Y = flight axis,
 * heat-shield belly = -Z, metres). Flaps are re-parented onto hinge pivots so
 * they can actuate; a per-vertex "vehicle height" attribute drives the
 * cryogenic frost bands on the propellant tanks.
 */

export const MODEL_URL = `${import.meta.env.BASE_URL}models/starship-block3.glb`
export const MODEL_CREDIT = 'Starship Block 3 model by Clarence365 (CC BY 4.0)'

const MODEL_HEIGHT = 25.15 // model units, full stack
const STACK_HEIGHT_M = 124.4
const S = STACK_HEIGHT_M / MODEL_HEIGHT
const STAGE_SPLIT = 14.55 // model y of the booster/ship interface
const AXIS = new Vector3(0.045, 0, 0.03) // model-space vehicle axis offset

export interface StageTemplate {
  root: Group
  flaps: { name: string; sign: number; kind: 'fwd' | 'aft' }[]
  slots: EngineSlot[]
}

interface Prepared {
  ship: StageTemplate
  booster: StageTemplate
}

let prepared: Prepared | null = null

/** model point → stage-local metres (rotated so the model's belly −X maps to −Z) */
function toStage(p: Vector3, baseY: number, out = new Vector3()) {
  const x = (p.x - AXIS.x) * S
  const y = (p.y - baseY) * S
  const z = (p.z - AXIS.z) * S
  // rotate −90° about Y: (x, z) → (−z, x)
  return out.set(-z, y, x)
}

type HeatGroup = 'shipVac' | 'shipSL' | 'booster'

function remapMaterial(src: Material, cache: Map<string, Material>, heat?: HeatGroup): Material {
  const key = heat ? `${src.uuid}:${heat}` : src.uuid
  const hit = cache.get(key)
  if (hit) return hit
  const m = src as MeshStandardMaterial
  const vm = vehicleMaterials()
  let out: Material = m
  const name = m.name ?? ''
  const isSteel = (m.metalness ?? 0) > 0.9 && !m.map
  if (name === 'Logo' || name === 'Serial_Number') {
    out = steelFrom(m, vm.boosterSteel.userData.uniforms.uFrost)
    ;(out as MeshStandardMaterial).map = null
  } else if (name === 'Material.511') {
    const c = m.clone()
    c.map = null
    c.color = new Color(0.07, 0.07, 0.075)
    out = c
  } else if (name === 'Heatshield_Tiles') {
    const c = tileMaterial(m)
    vm.modelTiles.push(c)
    out = c
  } else if (isSteel) {
    out = steelFrom(m, vm.boosterSteel.userData.uniforms.uFrost)
  } else {
    const c = m.clone()
    c.envMapIntensity = 0.8
    out = c
  }
  if (heat && !(name === 'Heatshield_Tiles')) out = heatedNozzle(out as MeshStandardMaterial, heat)
  out.side = 2 // DoubleSide, as authored (several hull shells have inward-facing normals)
  out.shadowSide = 1 // BackSide in the shadow pass limits self-shadow acne
  cache.set(key, out)
  return out
}

/** Shared surface-state uniforms (entry weathering of the ship's steel). */
export const surfaceUniforms = { uWear: { value: 0 } }

const SURFACE_GLSL = /* glsl */ `
float sh1(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float sn2(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(sh1(i),sh1(i+vec2(1,0)),u.x),mix(sh1(i+vec2(0,1)),sh1(i+vec2(1,1)),u.x),u.y); }
float sfbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<4;i++){ s+=a*sn2(p); p*=2.03; a*=0.5; } return s; }
// hexagonal tiling (pointy-top): returns cell centre (xy) and distance to the cell edge (z, 0 at edge)
vec3 hexCell(vec2 p){
  const vec2 r = vec2(1.0, 1.7320508);
  vec2 h = r * 0.5;
  vec2 a = mod(p, r) - h;
  vec2 b = mod(p - h, r) - h;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  vec2 id = p - g;
  vec2 q = abs(g);
  float edge = 0.5 - max(dot(q, normalize(vec2(1.0, 1.7320508))), q.x);
  return vec3(id, edge);
}
`

/**
 * Heat-shield tiles, procedural at true scale: ~0.3 m hexagonal ceramic tiles,
 * black with slight per-tile tone and gloss differences, hairline dark gaps,
 * the odd lighter replacement tile, and whitish ablation streaks after entry.
 * Detail fades out with distance (fwidth) so it never shimmers.
 */
function tileMaterial(src: MeshStandardMaterial) {
  const c = src.clone()
  c.map = null
  c.color = new Color(1, 1, 1)
  c.roughness = 0.72
  c.metalness = 0
  c.emissive = new Color(1.0, 0.32, 0.08)
  c.emissiveIntensity = 0
  c.envMapIntensity = 0.9
  c.onBeforeCompile = (sh) => {
    sh.uniforms.uWear = surfaceUniforms.uWear
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aMP;\nvarying vec3 vMPm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMPm = aMP;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uWear; varying vec3 vMPm;\n' + SURFACE_GLSL)
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
float tR = length(vMPm.xz);
vec2 tUV = (tR > 3.6 && tR < 5.2) ? vec2(atan(vMPm.z, -vMPm.x) * 4.5, vMPm.y) : vec2(vMPm.z, vMPm.y);
vec2 tp = tUV / 0.31;
vec3 hc = hexCell(tp);
float tw = fwidth(tp.x) + fwidth(tp.y);
float detail = 1.0 - smoothstep(0.15, 0.6, tw);        // fade detail when tiles shrink below a few pixels
float gap = 1.0 - smoothstep(0.012, 0.012 + tw * 0.9 + 0.01, hc.z);
float tId = sh1(hc.xy);
float tone = 0.05 + 0.016 * (tId - 0.5) * 2.0;
if (tId > 0.992) tone = 0.11;                           // lighter replacement tile
float soot = sfbm(tUV * 0.9);
tone *= mix(1.0, 0.8 + 0.35 * soot, 0.6);
vec3 tileCol = vec3(tone) * vec3(1.0, 0.99, 0.97);
// after entry: whitish ablation deposits streaked along the flow (towards the aft)
float streak = sfbm(vec2(tUV.x * 3.5, tUV.y * 0.25)) * sfbm(tUV * 1.3);
tileCol = mix(tileCol, vec3(0.16, 0.15, 0.14), uWear * smoothstep(0.32, 0.6, streak) * 0.55);
vec3 far = vec3(0.052);
diffuseColor.rgb = mix(far, mix(tileCol, vec3(0.012), gap * 0.85), detail);
float tRough = mix(0.46, 0.72, tId);`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(0.6, mix(tRough, 0.95, gap), detail);')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
// entry heating is not uniform paint: the windward centreline, nose cap and flap leading
// edges run hottest; each tile sits at a slightly different temperature; gaps stay cooler
float wind = pow(max(cos(atan(vMPm.z, -vMPm.x)), 0.0), 1.5);
float nose = smoothstep(95.0, 118.0, vMPm.y);
float heat = (0.35 + 0.65 * wind) * (0.8 + 0.5 * nose) * (0.7 + 0.6 * tId) * (1.0 - 0.6 * gap * detail);
float flow = 0.85 + 0.3 * sfbm(vec2(tUV.x * 0.8, tUV.y * 0.15 + uWear * 3.0));
totalEmissiveRadiance *= heat * flow;`,
      )
  }
  c.customProgramCacheKey = () => 'model-tiles-v3'
  return c
}

/** Stainless steel: keeps the model's mottled roughness map, adds frost bands driven by the shared uniform. */
function steelFrom(src: MeshStandardMaterial, uFrost: { value: number }) {
  const c = src.clone()
  c.color = new Color(0.64, 0.645, 0.655)
  c.metalness = 1
  c.roughness = 1
  c.envMapIntensity = 1.15
  c.onBeforeCompile = (sh) => {
    sh.uniforms.uFrost = uFrost
    sh.uniforms.uWear = surfaceUniforms.uWear
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aVehY;\nattribute vec3 aMP;\nvarying float vVehY;\nvarying vec3 vMP;\nvarying vec3 vMPm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvVehY = aVehY;\nvMP = position;\nvMPm = aMP;')
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uFrost; uniform float uWear; varying float vVehY; varying vec3 vMP; varying vec3 vMPm;
${SURFACE_GLSL}
float fh2(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float fn2(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(fh2(i),fh2(i+vec2(1,0)),u.x),mix(fh2(i+vec2(0,1)),fh2(i+vec2(1,1)),u.x),u.y); }
float frostMask(){
  if (uFrost <= 0.001 || vVehY < -0.5) return 0.0;
  // propellant tanks: booster 3–64 m, ship 76–101 m (stack coordinates). On the pad photos the loaded
  // tanks read as white frost sheets with vertical run-off streaks; the common domes leave a thin clear ring
  float band = max(smoothstep(3.0, 5.0, vVehY) * (1.0 - smoothstep(62.0, 64.0, vVehY)),
                   smoothstep(76.0, 78.0, vVehY) * (1.0 - smoothstep(99.0, 101.0, vVehY)));
  band *= 1.0 - 0.85 * (1.0 - smoothstep(0.3, 0.9, abs(vVehY - 41.0))) - 0.85 * (1.0 - smoothstep(0.3, 0.8, abs(vVehY - 88.5)));
  float ang = atan(vMP.z, vMP.x);
  float streak = fn2(vec2(ang * 30.0, vVehY * 0.22)) * 0.6 + fn2(vec2(ang * 110.0, vVehY * 0.9)) * 0.4;
  float patches = fn2(vec2(ang * 6.0, vVehY * 0.08));
  // colder, wetter low on each tank: heavier frost there
  float low = 1.0 - smoothstep(0.0, 1.0, fract((vVehY - 3.0) / 38.0));
  float solid = smoothstep(0.4, 0.62, streak * 0.7 + patches * 0.5 + low * 0.18);
  float m = max(solid * 0.93, 0.3 + 0.15 * streak) * band;
  return m * smoothstep(0.0, 0.6, uFrost - (1.0 - streak) * 0.35);
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
float frost = frostMask();
// sheet-metal patchwork: 1.83 m rings, three sheets per ring, each rolled slightly differently
float sAng = atan(vMPm.z, -vMPm.x);
float sArc = sAng * 4.5;
float ringY = vMPm.y / 1.83;
vec2 panel = vec2(floor(ringY), floor((sAng + 3.14159) / 2.0944 + sh1(vec2(floor(ringY), 3.0)) * 3.0));
float pId = sh1(panel);
float pw = fwidth(ringY) * 6.0;
float weldH = 1.0 - smoothstep(0.0, 0.012 + pw, abs(fract(ringY + 0.5) - 0.5) * 1.83);
float seamA = fract((sAng + 3.14159) / 2.0944 + sh1(vec2(floor(ringY), 3.0)) * 3.0);
float weldV = 1.0 - smoothstep(0.0, 0.01 + pw, min(seamA, 1.0 - seamA) * 9.42);
float weld = max(weldH, weldV) * (1.0 - smoothstep(0.2, 1.2, pw * 6.0));
vec3 steelTone = vec3(1.0) * (0.95 + 0.1 * pId);
// grain: faint vertical streaks from rolling
float grain = sn2(vec2(sArc * 40.0, vMPm.y * 1.5));
steelTone *= 0.97 + 0.05 * grain;
// weld heat tint: straw → bronze band either side of every seam
float tintW = max(1.0 - smoothstep(0.0, 0.06 + pw, abs(fract(ringY + 0.5) - 0.5) * 1.83), 0.0);
steelTone *= mix(vec3(1.0), vec3(1.0, 0.88, 0.68), tintW * 0.35);
steelTone *= mix(1.0, 0.82, weld);
// entry weathering (ship only): straw/bronze/blue oxidation fading up from the tile line on the leeward side
float lee = smoothstep(-0.2, 0.9, cos(sAng + 3.14159));
float ox = sfbm(vec2(sArc * 0.35, vMPm.y * 0.12));
float wearMask = uWear * step(70.0, vVehY) * clamp(lee * 0.6 + 0.4 * ox, 0.0, 1.0);
vec3 oxCol = mix(vec3(0.95, 0.78, 0.5), vec3(0.62, 0.42, 0.3), smoothstep(0.4, 0.75, ox));
oxCol = mix(oxCol, vec3(0.5, 0.55, 0.72), smoothstep(0.7, 0.9, ox) * 0.6);
steelTone = mix(steelTone, steelTone * oxCol, wearMask * 0.45);
diffuseColor.rgb *= steelTone;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.86, 0.9), frost);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor * 0.85 + 0.08, 0.12, 0.6);
roughnessFactor = clamp(roughnessFactor + (pId - 0.5) * 0.14 + weld * 0.1 + wearMask * 0.12, 0.08, 0.75);
roughnessFactor = mix(roughnessFactor, 0.9, frost);`,
      )
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(1.0, 0.0, frost);')
  }
  c.customProgramCacheKey = () => 'model-steel-frost-v3'
  return c
}

/** Engine material that glows as the nozzle heats: dull red → orange → yellow, strongest on the nozzle extension. */
function heatedNozzle(base: MeshStandardMaterial, group: HeatGroup) {
  const c = base.clone()
  const uHeat = vehicleMaterials().nozzleHeat[group]
  const prev = c.onBeforeCompile
  c.onBeforeCompile = (sh, r) => {
    prev?.call(c, sh, r)
    sh.uniforms.uHeat = uHeat
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aNoz;\nvarying float vNoz;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvNoz = aNoz;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uHeat; varying float vNoz;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  // bell: 0 at the exit plane → ~0.7 at the throat; the radiatively cooled extension glows
  float bell = smoothstep(0.0, 0.08, vNoz) * (1.0 - smoothstep(0.55, 0.72, vNoz));
  float T = uHeat * mix(0.75, 1.0, smoothstep(0.1, 0.6, vNoz));
  vec3 col = mix(vec3(0.5, 0.04, 0.0), vec3(1.0, 0.36, 0.06), smoothstep(0.35, 0.75, T));
  col = mix(col, vec3(1.0, 0.72, 0.35), smoothstep(0.82, 1.0, T));
  totalEmissiveRadiance += col * bell * T * T * 5.0;
}`,
      )
  }
  c.customProgramCacheKey = () => `nozzle-heat-${group}-${base.name}`
  return c
}

/** bottom-centre and radius of a part's bounds, in model space */
function partExit(o: Object3D) {
  const b = new Box3().setFromObject(o)
  const c = b.getCenter(new Vector3())
  const s = b.getSize(new Vector3())
  return { p: new Vector3(c.x, b.min.y, c.z), r: Math.min(s.x, s.z) / 2 }
}

function prepare(gltf: GLTF): Prepared {
  const scene = gltf.scene
  scene.updateMatrixWorld(true)
  const matCache = new Map<string, Material>()

  // --- classify named parts
  const parts: Object3D[] = []
  scene.traverse((o) => {
    if (o.name && !o.name.startsWith('Object_') && o.children.some((c) => (c as Mesh).isMesh || c.children.length) && /Starship|Superheavy|Flap|Door|Raptor|Grid/.test(o.name)) parts.push(o)
  })
  const stageOf = (o: Object3D) => {
    if (/Superheavy|Grid/.test(o.name)) return 'booster'
    if (/Starship|Flap|Door/.test(o.name)) return 'ship'
    const b = new Box3().setFromObject(o)
    return b.getCenter(new Vector3()).y > STAGE_SPLIT ? 'ship' : 'booster'
  }

  const make = (kind: 'ship' | 'booster'): StageTemplate => {
    const baseY = kind === 'ship' ? STAGE_SPLIT : 0
    const root = new Group()
    root.name = `stage-${kind}`
    // model space → stage space
    const fix = new Group()
    fix.scale.setScalar(S)
    fix.rotation.y = -Math.PI / 2
    fix.position.copy(toStage(new Vector3(0, 0, 0), baseY))
    root.add(fix)
    const flaps: StageTemplate['flaps'] = []
    const slots: EngineSlot[] = []

    for (const part of parts) {
      if (stageOf(part) !== kind) continue
      const isFlap = /Flap/.test(part.name)
      let parent: Object3D = fix
      let pivotInv = new Matrix4()
      if (isFlap) {
        // hinge = the flap edge closest to the vehicle axis; rotation axis = vehicle axis
        const b = new Box3().setFromObject(part)
        const c = b.getCenter(new Vector3())
        const side = Math.sign(c.z - AXIS.z) || 1
        const inner = side > 0 ? b.min.z : b.max.z
        const hinge = new Vector3(c.x, c.y, inner)
        const pivot = new Group()
        pivot.name = `pivot-${part.name}`
        pivot.position.copy(hinge)
        fix.add(pivot)
        parent = pivot
        pivotInv = new Matrix4().makeTranslation(-hinge.x, -hinge.y, -hinge.z)
        flaps.push({ name: pivot.name, sign: side, kind: /Foward|Forward/.test(part.name) ? 'fwd' : 'aft' })
      }
      if (/Raptor/.test(part.name)) {
        const { p, r } = partExit(part)
        const sp = toStage(p, baseY)
        const vac = /Vac/.test(part.name)
        slots.push({ x: sp.x, z: sp.z, y: sp.y + 0.05, spec: vac ? { ...RAPTOR_VAC, exitR: r * S * 0.92 } : { ...RAPTOR_SL, exitR: r * S * 0.9 }, group: kind === 'booster' ? 'boostback' : vac ? 'shipVac' : 'shipSL' })
      }
      const partSet = new Set(parts)
      const walk = (o: Object3D, fn: (o: Object3D) => void) => {
        fn(o)
        for (const c of o.children) if (!partSet.has(c)) walk(c, fn)
      }
      walk(part, (o) => {
        const mesh = o as Mesh
        if (!mesh.isMesh) return
        const heat: HeatGroup | undefined = /Raptor/.test(part.name) ? (kind === 'booster' ? 'booster' : /Vac/.test(part.name) ? 'shipVac' : 'shipSL') : undefined
        if (heat && !mesh.geometry.getAttribute('aNoz')) {
          // normalised height within the engine: 0 at the nozzle exit, 1 at the top of the powerhead
          const pb = new Box3().setFromObject(part)
          const pos = mesh.geometry.getAttribute('position')
          const arr = new Float32Array(pos.count)
          const v = new Vector3()
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
            arr[i] = (v.y - pb.min.y) / Math.max(1e-6, pb.max.y - pb.min.y)
          }
          mesh.geometry.setAttribute('aNoz', new BufferAttribute(arr, 1))
        }
        const m = new Mesh(mesh.geometry, Array.isArray(mesh.material) ? mesh.material.map((x) => remapMaterial(x, matCache, heat)) : remapMaterial(mesh.material, matCache, heat))
        m.matrixAutoUpdate = false
        m.matrix.copy(pivotInv).multiply(mesh.matrixWorld)
        m.castShadow = true
        m.receiveShadow = true
        m.frustumCulled = false
        // per-vertex height along the stack (metres) for tank frost
        const g = mesh.geometry
        if (!g.getAttribute('aVehY')) {
          const pos = g.getAttribute('position')
          const arr = new Float32Array(pos.count)
          const v = new Vector3()
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
            arr[i] = /Raptor|Grid|Flap|Door/.test(part.name) ? -1 : v.y * S
          }
          g.setAttribute('aVehY', new BufferAttribute(arr, 1))
        }
        if (!g.getAttribute('aMP')) {
          // model-space position in metres relative to the vehicle axis (belly = −x)
          const pos = g.getAttribute('position')
          const arr = new Float32Array(pos.count * 3)
          const v = new Vector3()
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
            arr[i * 3] = (v.x - AXIS.x) * S
            arr[i * 3 + 1] = v.y * S
            arr[i * 3 + 2] = (v.z - AXIS.z) * S
          }
          g.setAttribute('aMP', new BufferAttribute(arr, 3))
        }
        parent.add(m)
      })
    }

    if (kind === 'booster') {
      // the 20 fixed outer engines are part of the booster hull mesh: plumes only
      const ring = boosterEngineLayout().filter((e) => e.group === 'booster')
      for (const e of ring) slots.push({ ...e, y: 0.1 })
    }
    return { root, flaps, slots }
  }

  return { ship: make('ship'), booster: make('booster') }
}

export function useVehicleModel() {
  const gltf = useLoader(AnyGLTFLoader, binUrl(MODEL_URL), (loader) => {
    ;(loader as AnyGLTFLoader).setMeshoptDecoder(MeshoptDecoder)
  })
  return useMemo(() => (prepared ??= prepare(gltf)), [gltf])
}

/** Per-instance clone of a stage with live flap actuation. */
export function useStageInstance(t: StageTemplate, getFlaps?: () => { fwd: number; aft: number }) {
  const inst = useMemo(() => {
    const root = t.root.clone(true)
    const pivots = t.flaps.map((f) => ({ ...f, obj: root.getObjectByName(f.name)! }))
    return { root, pivots }
  }, [t])
  useFrame(() => {
    const tt = runtime.state.t
    surfaceUniforms.uWear.value = Math.min(1, Math.max(0, (tt - 176) / 16))
    if (!getFlaps) return
    const f = getFlaps()
    for (const p of inst.pivots) {
      // positive = toward the leeward side (model +X); pivot axis is the vehicle axis
      const a = (p.kind === 'fwd' ? f.fwd : f.aft) * DEG
      p.obj.rotation.y = a * p.sign
    }
  })
  return inst.root
}
