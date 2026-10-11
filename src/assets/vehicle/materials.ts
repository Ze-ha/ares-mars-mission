import { Color, DoubleSide, MeshStandardMaterial, type Texture } from 'three'
import { makeHotStageTextures, makeSteelTextures, makeTileTextures, STEEL_RINGS_PER_TEXTURE, TILE_COLS, TILE_ROWS, TILE_SIZE } from '../../utils/proceduralTextures'

/**
 * Shared PBR materials for the vehicle. Created once (module singletons) and
 * reused by every vehicle instance in every world — so shader programs are
 * compiled once and textures uploaded once.
 */

/** Barrel section height (m) — spacing of the circumferential weld rings. */
export const BARREL_HEIGHT = 1.83

let cache: ReturnType<typeof build> | null = null

export function vehicleMaterials() {
  if (!cache) cache = build()
  return cache
}

/** Stainless steel with an animatable cryogenic frost layer over the propellant tanks. */
function steel(tex: ReturnType<typeof makeSteelTextures>, frostMin: number, frostMax: number, repeatY: number, circumference: number) {
  const map = tex.map.clone()
  const rough = tex.roughnessMap.clone()
  const bump = tex.bumpMap.clone()
  for (const t of [map, rough, bump]) {
    t.repeat.set(circumference / 28, repeatY)
    t.needsUpdate = true
  }
  const m = new MeshStandardMaterial({
    color: new Color(0.62, 0.62, 0.63),
    map,
    metalness: 1,
    roughness: 0.95,
    roughnessMap: rough,
    bumpMap: bump,
    bumpScale: 1.4,
    envMapIntensity: 1.15,
  })
  const uniforms = { uFrost: { value: 1 }, uFrostMin: { value: frostMin }, uFrostMax: { value: frostMax } }
  m.userData.uniforms = uniforms
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLocal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vLocal;
uniform float uFrost; uniform float uFrostMin; uniform float uFrostMax;
float fh(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
float fn(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(fh(i),fh(i+vec2(1,0)),u.x),mix(fh(i+vec2(0,1)),fh(i+vec2(1,1)),u.x),u.y); }
float frostMask(){
  if(uFrost<=0.001) return 0.0;
  float ang = atan(vLocal.z, vLocal.x);
  float band = smoothstep(uFrostMin, uFrostMin+1.5, vLocal.y) * (1.0 - smoothstep(uFrostMax-1.0, uFrostMax, vLocal.y));
  // real tank frost: vertical rivulets and patches, thicker low on each tank, thin haze elsewhere
  float streak = fn(vec2(ang*30.0, vLocal.y*0.22)) * 0.6 + fn(vec2(ang*110.0, vLocal.y*0.9)) * 0.4;
  float patches = fn(vec2(ang*6.0, vLocal.y*0.08));
  float lowBias = smoothstep(uFrostMax, uFrostMin, vLocal.y) * 0.25;
  float solid = smoothstep(0.52, 0.72, streak * 0.7 + patches * 0.5 + lowBias);
  float haze = 0.18 + 0.12 * streak;
  float m = max(solid * 0.85, haze) * band;
  return m * smoothstep(0.0, 0.6, uFrost - (1.0 - streak) * 0.35);
}`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
float frost = frostMask();
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.86, 0.9), frost);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.9, frost);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, 0.0, frost);`,
      )
  }
  m.customProgramCacheKey = () => 'steel-frost'
  return m
}

function tiles(tex: ReturnType<typeof makeTileTextures>, arcLength: number, height: number) {
  const repX = arcLength / (TILE_COLS * TILE_SIZE)
  const repY = height / ((TILE_ROWS * 1.5 * TILE_SIZE) / Math.sqrt(3))
  const clone = (t: Texture) => {
    const c = t.clone()
    c.repeat.set(repX, repY)
    c.needsUpdate = true
    return c
  }
  return new MeshStandardMaterial({
    color: 0xffffff,
    map: clone(tex.map),
    roughnessMap: clone(tex.roughnessMap),
    roughness: 1,
    metalness: 0.0,
    bumpMap: clone(tex.bumpMap),
    bumpScale: 2.2,
    emissive: new Color(1.0, 0.32, 0.08),
    emissiveMap: clone(tex.emissiveMap),
    emissiveIntensity: 0,
    envMapIntensity: 0.6,
  })
}

function build() {
  const steelTex = makeSteelTextures()
  const tileTex = makeTileTextures()
  const hs = makeHotStageTextures()
  const R = 4.5
  const circ = 2 * Math.PI * R
  const texHeight = BARREL_HEIGHT * STEEL_RINGS_PER_TEXTURE

  const boosterSteel = steel(steelTex, 3, 63, 69 / texHeight, circ)
  const shipSteel = steel(steelTex, 4, 29, 34 / texHeight, circ * 0.45)
  const noseSteel = steel(steelTex, 999, 999, 16 / texHeight, circ * 0.45)
  noseSteel.userData.uniforms.uFrost.value = 0
  const plainSteel = new MeshStandardMaterial({ color: new Color(0.6, 0.6, 0.61), metalness: 1, roughness: 0.32, envMapIntensity: 1.1 })

  const bodyTiles = tiles(tileTex, circ * 0.55, 34)
  const noseTiles = tiles(tileTex, circ * 0.55, 17)
  const flapTiles = tiles(tileTex, 4, 10)

  const hotStage = new MeshStandardMaterial({
    map: hs.map,
    metalness: 0.9,
    roughness: 0.4,
    emissive: new Color(1.0, 0.45, 0.12),
    emissiveMap: hs.emissiveMap,
    emissiveIntensity: 0,
    envMapIntensity: 1.0,
  })
  hs.map.repeat.set(1, 1)

  const engineBell = new MeshStandardMaterial({ color: new Color(0.23, 0.22, 0.21), metalness: 0.85, roughness: 0.42, side: DoubleSide, envMapIntensity: 0.8 })
  const enginePowerhead = new MeshStandardMaterial({ color: new Color(0.52, 0.47, 0.4), metalness: 0.9, roughness: 0.38, envMapIntensity: 0.9 })
  const darkShield = new MeshStandardMaterial({ color: new Color(0.035, 0.035, 0.037), metalness: 0.2, roughness: 0.85 })
  const gridFin = new MeshStandardMaterial({ color: new Color(0.3, 0.3, 0.31), metalness: 0.9, roughness: 0.45, envMapIntensity: 0.8 })
  const legMetal = new MeshStandardMaterial({ color: new Color(0.5, 0.5, 0.52), metalness: 1, roughness: 0.3 })

  /** heat-shield materials of the detailed GLB model (entry glow is driven through this list too) */
  const modelTiles: MeshStandardMaterial[] = []
  /** nozzle temperature proxies (0..1) per engine group, shared by the model's engine materials */
  const nozzleHeat = { shipVac: { value: 0 }, shipSL: { value: 0 }, booster: { value: 0 } }
  return { boosterSteel, shipSteel, noseSteel, plainSteel, bodyTiles, noseTiles, flapTiles, hotStage, engineBell, enginePowerhead, darkShield, gridFin, legMetal, modelTiles, nozzleHeat }
}
