import { useTexture } from '@react-three/drei'
import { useFrame, useLoader } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { BufferAttribute, BufferGeometry, Color, IcosahedronGeometry, NoColorSpace, RepeatWrapping, SRGBColorSpace, type Texture, Vector4, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three'
import { QUALITY, runtime, useMission } from '../../mission/store'
import { rng } from '../../utils/math'
import { mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { BinaryLoader, binUrl } from '../../utils/binary'

/**
 * Mars landing site (metres, pad at the origin).
 *
 * Terrain is a *polar* grid: rings spaced geometrically from 1.5 m to 70 km.
 * That gives a natural LOD — centimetre-scale detail under the ship and
 * kilometre-scale facets at the horizon — in a single ~60k-vertex mesh.
 * Heights come from a deterministic CPU function so the ship, rocks and
 * dust all agree on where the ground is.
 */

// ---------------------------------------------------------------- height field
const N = 256
const perm = (() => {
  const r = rng(99)
  const g = new Float32Array(N * N)
  for (let i = 0; i < g.length; i++) g[i] = r()
  return g
})()
function vnoise(x: number, y: number) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const fx = x - xi
  const fy = y - yi
  const at = (a: number, b: number) => perm[(((b % N) + N) % N) * N + (((a % N) + N) % N)]
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const a = at(xi, yi)
  const b = at(xi + 1, yi)
  const c = at(xi, yi + 1)
  const d = at(xi + 1, yi + 1)
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
}
function fbm(x: number, y: number, oct: number) {
  let s = 0
  let a = 0.5
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x, y)
    x = x * 2.03 + 17.1
    y = y * 2.03 + 3.7
    a *= 0.5
  }
  return s
}

interface Crater {
  x: number
  z: number
  r: number
}
const CRATERS: Crater[] = (() => {
  const r = rng(7)
  const list: Crater[] = []
  for (let i = 0; i < 220; i++) {
    const d = 60 + Math.pow(r(), 1.3) * 4000
    const a = r() * Math.PI * 2
    list.push({ x: Math.cos(a) * d, z: Math.sin(a) * d, r: 3 + Math.pow(r(), 3) * 65 })
  }
  return list
})()

function craterProfile(d: number) {
  // d = distance / radius
  if (d < 1) return (d * d - 1) * 0.22 + 0.06 * Math.exp(-Math.pow((d - 1) * 5, 2))
  return 0.06 * Math.exp(-Math.pow((d - 1) * 3.2, 2))
}

// ---------------------------------------------------------------- real Jezero heightfield
interface Grid { n: number; half: number; res: number; min: number; max: number; data: Uint16Array }
let real: { core: Grid; far: Grid; near?: Grid } | null = null

function sampleGrid(g: Grid, x: number, z: number) {
  const fx = (x + g.half) / g.res - 0.5
  const fz = (z + g.half) / g.res - 0.5
  if (fx < 0 || fz < 0 || fx > g.n - 1.001 || fz > g.n - 1.001) return NaN
  const i = Math.floor(fx)
  const j = Math.floor(fz)
  const u = fx - i
  const v = fz - j
  const d = g.data
  const n = g.n
  const h00 = d[j * n + i]
  const h10 = d[j * n + i + 1]
  const h01 = d[(j + 1) * n + i]
  const h11 = d[(j + 1) * n + i + 1]
  const q = h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h01 * (1 - u) * v + h11 * u * v
  return g.min + (q / 65535) * (g.max - g.min)
}

/** NASA terrain (metres relative to the landing site): 40 m HiRISE/MOLA core, 400 m MOLA beyond. */
function realHeight(x: number, z: number) {
  if (!real) return NaN
  const c = sampleGrid(real.core, x, z)
  const f = sampleGrid(real.far, x, z)
  if (Number.isNaN(c)) return Number.isNaN(f) ? 0 : f
  // feather the core into the far grid near its edge
  const e = Math.max(Math.abs(x), Math.abs(z))
  const k = Math.min(1, Math.max(0, (e - (real.core.half - 3000)) / 2500))
  return Number.isNaN(f) ? c : c * (1 - k) + f * k
}

/** HiRISE DTM relief below 60 m (small craters, ridges, bedrock steps) within ±1.8 km; weight fades at the edge. */
function nearDetail(x: number, z: number): [number, number] {
  const g = real?.near
  if (!g) return [0, 0]
  const h = sampleGrid(g, x, z)
  if (Number.isNaN(h)) return [0, 0]
  const e = Math.max(Math.abs(x), Math.abs(z))
  const w = Math.min(1, Math.max(0, (g.half - 20 - e) / 250))
  return [h * w, w]
}

/** Sub-40 m relief the orbital data cannot resolve: small fresh craters, ripples, roughness. */
function microRelief(x: number, z: number) {
  const [nd, nw] = nearDetail(x, z)
  let h = nd
  for (const c of CRATERS) {
    if (c.r > 70 || nw > 0.5) continue
    const dx = x - c.x
    const dz = z - c.z
    const d2 = dx * dx + dz * dz
    if (d2 > c.r * c.r * 6) continue
    h += craterProfile(Math.sqrt(d2) / c.r) * c.r
  }
  const duneMask = Math.max(0, fbm(x / 600 + 3, z / 600, 3) - 0.5) * 4
  h += Math.max(0, Math.sin((x * 0.8 + z * 0.6) / 18 + fbm(x / 90, z / 90, 2) * 6)) * 1.6 * Math.min(duneMask, 1)
  h += (fbm(x / 30, z / 30, 3) - 0.5) * 1.6 * (1 - nw * 0.8) + (fbm(x / 8, z / 8, 2) - 0.5) * 0.35
  return h
}

/** Mars' curvature: the ground falls away r²/2R below the site's tangent plane (720 m at 70 km). */
const MARS_R_M = 3389500
export function marsHeight(x: number, z: number) {
  return siteHeight(x, z) - (x * x + z * z) / (2 * MARS_R_M)
}
function siteHeight(x: number, z: number) {
  const d = Math.sqrt(x * x + z * z)
  // landing zone: a small, genuinely flat patch of crater floor
  const k = Math.min(1, Math.max(0, (d - 35) / 180))
  const flat = k * k * (3 - 2 * k)
  if (real) return realHeight(x, z) * (0.35 + 0.65 * flat) + microRelief(x, z) * flat
  return proceduralHeight(x, z) * flat
}

/** Fallback when the NASA data is not loaded (and the source of the original look). */
function proceduralHeight(x: number, z: number) {
  let h = (fbm(x / 4200, z / 4200, 5) - 0.5) * 160
  const rr = 1 - Math.abs(fbm(x / 2300 + 40, z / 2300, 4) * 2 - 1)
  h += rr * rr * 55
  for (const c of CRATERS) {
    const dx = x - c.x
    const dz = z - c.z
    const d2 = dx * dx + dz * dz
    if (d2 > c.r * c.r * 6) continue
    h += craterProfile(Math.sqrt(d2) / c.r) * c.r
  }
  return h + microRelief(x, z) * 0.5
}

let terrainCache: { geo: BufferGeometry; res: number; key: string; cx: number; cz: number } | null = null
function ringRadii(res: number) {
  const rings: number[] = [0]
  let rad = 1.5
  while (rad < 70000) {
    rings.push(rad)
    rad *= 1 + 0.045 / res
  }
  rings.push(70000)
  return rings
}
/** Fill a polar-grid position buffer centred on (cx, cz): finest rings under the centre. */
function fillTerrain(pos: Float32Array, res: number, cx: number, cz: number) {
  const seg = Math.round(256 * res)
  const rings = ringRadii(res)
  pos.set([cx, marsHeight(cx, cz), cz], 0)
  let v = 1
  for (let i = 1; i < rings.length; i++) {
    const r = rings[i]
    for (let s = 0; s < seg; s++) {
      const a = (s / seg) * Math.PI * 2 + (i % 2) * (Math.PI / seg)
      const x = cx + Math.cos(a) * r
      const z = cz + Math.sin(a) * r
      pos[v * 3] = x
      pos[v * 3 + 1] = marsHeight(x, z)
      pos[v * 3 + 2] = z
      v++
    }
  }
}
function buildTerrain(res: number, cx = 0, cz = 0) {
  const seg = Math.round(256 * res)
  const rings = ringRadii(res)
  const nv = 1 + (rings.length - 1) * seg
  const pos = new Float32Array(nv * 3)
  fillTerrain(pos, res, cx, cz)
  const idx: number[] = []
  for (let s = 0; s < seg; s++) idx.push(0, 1 + ((s + 1) % seg), 1 + s)
  for (let i = 1; i < rings.length - 1; i++) {
    const a0 = 1 + (i - 1) * seg
    const b0 = 1 + i * seg
    for (let s = 0; s < seg; s++) {
      const a = a0 + s
      const a1 = a0 + ((s + 1) % seg)
      const b = b0 + s
      const b1 = b0 + ((s + 1) % seg)
      idx.push(a, a1, b, a1, b1, b)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}
function terrain(res: number, key: string) {
  if (!terrainCache || terrainCache.res !== res || terrainCache.key !== key) terrainCache = { geo: buildTerrain(res), res, key, cx: 0, cz: 0 }
  return terrainCache.geo
}

/**
 * Explore mode: move the fine rings of the terrain under a moving point (same topology,
 * positions rewritten in place). Returns true if it re-centred.
 */
export function recenterTerrain(x: number, z: number, threshold = 22) {
  const c = terrainCache
  if (!c) return false
  if (Math.hypot(x - c.cx, z - c.cz) < threshold) return false
  const attr = c.geo.getAttribute('position') as BufferAttribute
  fillTerrain(attr.array as Float32Array, c.res, x, z)
  attr.needsUpdate = true
  c.geo.computeVertexNormals()
  c.geo.computeBoundingSphere()
  c.cx = x
  c.cz = z
  return true
}

/** Height of the rendered terrain surface (the polar mesh), for things that must sit exactly on it. */
export function renderedHeight(x: number, z: number) {
  const c = terrainCache
  if (!c) return marsHeight(x, z)
  const seg = Math.round(256 * c.res)
  const rings = ringRadii(c.res)
  const dx = x - c.cx
  const dz = z - c.cz
  const r = Math.hypot(dx, dz)
  if (r < rings[1]) return marsHeight(x, z)
  // ring index by bisection
  let lo = 1
  let hi = rings.length - 1
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1
    if (rings[m] <= r) lo = m
    else hi = m
  }
  const pos = (c.geo.getAttribute('position') as BufferAttribute).array as Float32Array
  const ang = (Math.atan2(dz, dx) + Math.PI * 2) % (Math.PI * 2)
  const sample = (i: number) => {
    const off = (i % 2) * (Math.PI / seg)
    const f = (((ang - off) / (Math.PI * 2)) * seg + seg) % seg
    const s0 = Math.floor(f)
    const t = f - s0
    const base = 1 + (i - 1) * seg
    const h0 = pos[(base + s0) * 3 + 1]
    const h1 = pos[(base + ((s0 + 1) % seg)) * 3 + 1]
    return h0 + (h1 - h0) * t
  }
  const u = (r - rings[lo]) / (rings[hi] - rings[lo])
  return sample(lo) + (sample(hi) - sample(lo)) * u
}

// ---------------------------------------------------------------- material
/**
 * Real orbital imagery of Jezero (NASA/JPL/USGS Mars 2020 mosaics, resampled into the
 * site frame by scripts: x east, z south, row 0 = north), used as the albedo pattern:
 *  - HiRISE, ~1.2 m/px, 5 × 5 km around the landing site
 *  - CTX, ~20 m/px, ±30 km (Viking colour fills its western edge)
 *  - Viking MDIM, ~215 m/px, ±110 km
 * Stored gamma-encoded with the scene mean at 0.5.
 */
export const JEZERO_IMAGERY = { hirise: [-1626.85, 3363.92, -2352.85, 2637.36] as const, ctxHalf: 30000, farHalf: 110000 }

export function makeMarsGroundMaterial() {
  const m = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 })
  const uniforms = {
    uBlast: { value: 0 },
    uImgHi: { value: null as Texture | null },
    uImgCtx: { value: null as Texture | null },
    uImgFar: { value: null as Texture | null },
    uImgOn: { value: 0 },
    uHiBounds: { value: new Vector4(...JEZERO_IMAGERY.hirise) },
    // near-field regolith: real CC0 gravel/sand scans (ambientCG / Poly Haven), used as detail only
    uGravC: { value: null as Texture | null },
    uGravN: { value: null as Texture | null },
    uSandC: { value: null as Texture | null },
    uSandN: { value: null as Texture | null },
    uDetOn: { value: 0 },
  }
  m.userData.uniforms = uniforms
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms)
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vW; varying vec3 vN;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz; vN = normal;')
    s.fragmentShader = s.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vW; varying vec3 vN;
uniform float uBlast;
uniform sampler2D uImgHi; uniform sampler2D uImgCtx; uniform sampler2D uImgFar; uniform float uImgOn; uniform vec4 uHiBounds;
uniform sampler2D uGravC; uniform sampler2D uGravN; uniform sampler2D uSandC; uniform sampler2D uSandN; uniform float uDetOn;
float imgDec(float g){ return pow(g, 2.2) * 2.0; }
float edgeW(vec2 uv, float f){ vec2 e = min(uv, 1.0 - uv); return smoothstep(0.0, f, min(e.x, e.y)); }
/** orbital albedo pattern, mean ≈ 1 */
float imagery(vec2 p){
  vec2 uf = (p + ${JEZERO_IMAGERY.farHalf.toFixed(1)}) / ${(2 * JEZERO_IMAGERY.farHalf).toFixed(1)};
  vec2 uc = (p + ${JEZERO_IMAGERY.ctxHalf.toFixed(1)}) / ${(2 * JEZERO_IMAGERY.ctxHalf).toFixed(1)};
  vec2 uh = vec2((p.x - uHiBounds.x) / (uHiBounds.y - uHiBounds.x), (p.y - uHiBounds.z) / (uHiBounds.w - uHiBounds.z));
  float I = imgDec(texture2D(uImgFar, uf).r);
  float wc = edgeW(uc, 0.04);
  if (wc > 0.0) I = mix(I, imgDec(texture2D(uImgCtx, uc).r), wc);
  float wh = edgeW(uh, 0.05);
  if (wh > 0.0) I = mix(I, imgDec(texture2D(uImgHi, uh).r), wh);
  return I;
}
float mh(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float mn(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(mh(i),mh(i+vec2(1,0)),u.x),mix(mh(i+vec2(0,1)),mh(i+vec2(1,1)),u.x),u.y); }
float mf(vec2 p){ float a=0.5,s=0.0; for(int i=0;i<5;i++){ s+=a*mn(p); p=p*2.07+vec2(3.3,1.9); a*=0.5; } return s; }`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
float dist = length(vW - cameraPosition);
float slope = 1.0 - clamp(normalize(vN).y, 0.0, 1.0);
vec2 p = vW.xz;
float big = mf(p * 0.0005);
float mid = mf(p * 0.018);
float fineFade = 1.0 - smoothstep(60.0, 500.0, dist);
float fine = mix(0.5, mf(p * 1.6), fineFade);
// Perseverance-like palette (linear): butterscotch dust, dark basaltic sand, grey-brown rock, pale bedrock
vec3 dustC = vec3(0.36, 0.225, 0.14);
vec3 sandC = vec3(0.16, 0.105, 0.075);
vec3 rockC = vec3(0.21, 0.165, 0.13);
vec3 bedC  = vec3(0.33, 0.25, 0.19);
float I = mix(1.0, pow(max(imagery(p), 0.05), 0.72), uImgOn);
// dark units (basaltic sand, Máaz lava) vs bright dusty / bedrock units, from the real imagery
float sandMask = mix(smoothstep(0.52, 0.66, big + mid * 0.35), smoothstep(0.9, 0.62, I) * 0.8, uImgOn);
vec3 alb = mix(dustC, sandC, sandMask * 0.8);
alb *= mix(1.0, clamp(I, 0.35, 2.0) / mix(1.0, 0.7, sandMask * 0.8), uImgOn);
// aeolian ripples in the sand patches
float rip = sin(dot(p, vec2(0.83, 0.56)) * 3.1 + mf(p * 0.25) * 6.0) * 0.5 + 0.5;
alb *= 1.0 - sandMask * fineFade * 0.18 * rip;
// fractured bedrock exposures (polygonal cracks, lighter plates)
float bedMask = smoothstep(0.6, 0.72, mf(p * 0.006 + 11.0) + mid * 0.2 + uImgOn * (I - 1.1) * 0.5) * (1.0 - sandMask);
vec2 cp = p * 0.55;
vec2 ci = floor(cp); vec2 cf = fract(cp);
float d1 = 9.0; float d2 = 9.0;
for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
  vec2 g = vec2(float(i), float(j));
  vec2 o = vec2(mh(ci + g), mh(ci + g + 17.0));
  float d = length(g + o - cf);
  if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
}
float crack = 1.0 - smoothstep(0.0, 0.07, d2 - d1);
alb = mix(alb, bedC * (0.85 + 0.3 * mh(ci)), bedMask);
alb *= 1.0 - crack * bedMask * fineFade * 0.55;
alb = mix(alb, rockC, smoothstep(0.1, 0.4, slope));
alb *= mix(0.84 + 0.26 * mid, 0.95 + 0.1 * mid, uImgOn) + 0.24 * (fine - 0.5);
// scattered pebbles and granules
float peb = step(0.8, mn(p * 7.0)) * fineFade;
alb = mix(alb, rockC * 0.8, peb * 0.55);
// dust scoured away by the landing burn exposes darker regolith
float r = length(vW.xz);
float blast = uBlast * (1.0 - smoothstep(16.0, 75.0, r + (mid - 0.5) * 30.0));
alb = mix(alb, alb * vec3(0.6, 0.56, 0.54), blast);
// close range: real regolith grain from photo-scanned gravel / sand, as a luminance pattern on the Martian palette
float near = uDetOn * (1.0 - smoothstep(14.0, 55.0, dist));
vec2 uvG = p / 1.7;
vec2 uvS = mat2(0.8, -0.6, 0.6, 0.8) * p / 3.4 + 0.37;
if (near > 0.001) {
  float gL = dot(texture2D(uGravC, uvG).rgb, vec3(0.3, 0.5, 0.2)) / 0.2;
  float sL = dot(texture2D(uSandC, uvS).rgb, vec3(0.3, 0.5, 0.2)) / 0.23;
  float det = mix(gL, sL, clamp(sandMask * 1.3, 0.0, 1.0));
  // Martian fines soften the scan's contrast: pebbles poke through a dust-filled matrix
  alb *= mix(1.0, clamp(pow(det, 0.5), 0.6, 1.45), near * (1.0 - bedMask * 0.55));
}
diffuseColor.rgb = alb;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
{
  float e = 0.35;
  float h0 = mf(p * 0.9);
  float hx = mf((p + vec2(e, 0.0)) * 0.9);
  float hz = mf((p + vec2(0.0, e)) * 0.9);
  vec3 dn = normalize(vec3(-(hx - h0) * 1.6, 1.0, -(hz - h0) * 1.6));
  vec3 dnV = normalize((viewMatrix * vec4(dn, 0.0)).xyz);
  normal = normalize(normal + (dnV - normalize((viewMatrix * vec4(0.0,1.0,0.0,0.0)).xyz)) * fineFade);
  if (near > 0.001) {
    // photo-scanned micro-relief (OpenGL normal maps; ground tangent frame: u = +x, v = +z)
    vec3 ng = texture2D(uGravN, uvG).xyz * 2.0 - 1.0;
    vec3 ns = texture2D(uSandN, uvS).xyz * 2.0 - 1.0;
    ns.xy = mat2(0.8, 0.6, -0.6, 0.8) * ns.xy;
    vec3 nm = normalize(mix(ng, ns, clamp(sandMask * 1.3, 0.0, 1.0)));
    vec3 dW = normalize(vec3(nm.x, nm.z, nm.y));
    vec3 dV2 = normalize((viewMatrix * vec4(dW, 0.0)).xyz);
    normal = normalize(normal + (dV2 - normalize((viewMatrix * vec4(0.0,1.0,0.0,0.0)).xyz)) * near * 0.45);
  }
}`,
      )
  }
  m.customProgramCacheKey = () => 'mars-ground-img-det'
  return m
}

export const marsGround = makeMarsGroundMaterial()

// ---------------------------------------------------------------- rocks
/** Angular, faceted rock: low-poly base with noisy displacement (breaks the "blob" look). */
function rockGeometry(seed: number, detail = 1) {
  // one subdivision finer than asked: rounded weathered surfaces + clean fracture faces
  const ico = new IcosahedronGeometry(1, detail + 1)
  ico.deleteAttribute('normal')
  ico.deleteAttribute('uv')
  // shared vertices → smooth shading on weathered surfaces
  const g = mergeVertices(ico)
  const p = g.attributes.position as BufferAttribute
  const r = rng(seed)
  // Jezero's rocks are fractured blocks (basaltic Máaz, olivine-rich Séítah): many flat breaks
  const cuts: { n: Vector3; d: number }[] = []
  for (let i = 0; i < 8; i++) cuts.push({ n: new Vector3(r() - 0.5, r() - 0.25, r() - 0.5).normalize(), d: 0.5 + r() * 0.2 })
  const squash = 0.45 + r() * 0.4 // tabular slabs to chunky blocks
  const v = new Vector3()
  const o = [r() * 10, r() * 10, r() * 10]
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i)
    let k = 0.82 + 0.26 * Math.sin(v.x * 2.7 + seed) * Math.cos(v.z * 3.1 - seed)
    k += (fbm(v.x * 2.2 + o[0], v.z * 2.2 + v.y * 1.7 + o[1], 3) - 0.5) * 0.18 + (fbm(v.y * 6 + o[2], v.x * 6 - v.z * 4, 2) - 0.5) * 0.06
    // fracture planes: clip vertices beyond random planes → flat broken faces, sharp edges
    for (const c of cuts) {
      const d = v.dot(c.n) * k
      if (d > c.d) k *= c.d / d
    }
    v.multiplyScalar(k)
    v.y *= squash
    p.setXYZ(i, v.x, v.y, v.z)
  }
  // weathered faces shade smoothly, fracture edges stay sharp
  return toCreasedNormals(g, (32 * Math.PI) / 180)
}

/** Rock material with dust settled on upward-facing surfaces and pitted texture. */
const rockMat = (() => {
  const m = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 })
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWN; varying vec3 vWP;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal); vWP = (modelMatrix * instanceMatrix * vec4(transformed,1.0)).xyz;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWN; varying vec3 vWP;
float rh(vec3 p){ p=fract(p*0.3183+0.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float rn(vec3 p){ vec3 i=floor(p); vec3 f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(rh(i),rh(i+vec3(1,0,0)),f.x),mix(rh(i+vec3(0,1,0)),rh(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(rh(i+vec3(0,0,1)),rh(i+vec3(1,0,1)),f.x),mix(rh(i+vec3(0,1,1)),rh(i+vec3(1,1,1)),f.x),f.y),f.z); }
float rf(vec3 p){ return rn(p)*0.5 + rn(p*2.03+1.7)*0.25 + rn(p*4.1+3.1)*0.125 + rn(p*8.3+5.3)*0.0625; }
// vesicles: small round pits (cellular)
float ves(vec3 p){ vec3 i=floor(p); vec3 f=fract(p); float d=9.0;
  for(int z=-1;z<=1;z++) for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){ vec3 g=vec3(x,y,z); vec3 o=vec3(rh(i+g),rh(i+g+11.0),rh(i+g+23.0)); d=min(d,length(g+o-f)); }
  return d; }
float rockH;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float up = smoothstep(0.35, 0.85, vWN.y);
float n1 = rf(vWP * 2.3);
float n2 = rf(vWP * 11.0);
float vd = ves(vWP * 16.0);
float pit = (1.0 - smoothstep(0.1, 0.18, vd)) * step(0.55, rn(vWP * 3.0));
// fine layering (Jezero's sedimentary and igneous units) + mottled weathering rind
float strata = 0.5 + 0.5 * sin(vWP.y * 38.0 + n1 * 5.0);
diffuseColor.rgb *= (0.78 + 0.44 * n1) * (0.93 + 0.07 * strata) * (1.0 - pit * 0.4);
rockH = n2 * 0.6 + n1 * 0.4 - pit * 0.25 + strata * 0.08;
// dust on upward faces and in the pits
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.36, 0.225, 0.14), clamp(up * (0.45 + 0.4 * n2) + pit * 0.2, 0.0, 0.85));`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  // derivative bump (Mikkelsen): grain, pits and layering catch the low sun
  vec3 sx = dFdx(-vViewPosition); vec3 sy = dFdy(-vViewPosition);
  vec3 R1 = cross(sy, normal); vec3 R2 = cross(normal, sx);
  float det = dot(sx, R1);
  float bump = 0.012 * (1.0 - smoothstep(8.0, 60.0, length(vViewPosition)));
  vec3 grad = sign(det) * (dFdx(rockH) * R1 + dFdy(rockH) * R2);
  normal = normalize(abs(det) * normal - grad * bump);
}`)
  }
  m.customProgramCacheKey = () => 'mars-rock-v2'
  return m
})()

/** Rocks too big for a rover to climb (> ~0.6 m), per field, for explore-mode collisions. */
export const ROCK_OBSTACLES = new Map<number, { x: number; z: number; r: number }[]>()

function RockField({ count, seed, minR, maxR, sizeMin, sizePow, sizeMax, geoSeed, flat = false }: {
  count: number; seed: number; minR: number; maxR: number; sizeMin: number; sizeMax: number; sizePow: number; geoSeed: number; flat?: boolean
}) {
  const ref = useRef<InstancedMesh>(null!)
  // bedrock plates are just very flat fractured rocks — irregular outlines, no prisms
  const geo = useMemo(() => rockGeometry(geoSeed, flat ? 2 : 1), [geoSeed, flat])
  useLayoutEffect(() => {
    const r = rng(seed)
    const m = new Matrix4()
    const q = new Quaternion()
    const sc = new Vector3()
    const pos = new Vector3()
    const col = new Color()
    let i = 0
    let guard = 0
    const obstacles: { x: number; z: number; r: number }[] = []
    ROCK_OBSTACLES.set(seed, obstacles)
    while (i < count && guard++ < count * 20) {
      const d = minR + Math.pow(r(), 1.6) * (maxR - minR)
      const a = r() * Math.PI * 2
      const x = Math.cos(a) * d
      const z = Math.sin(a) * d
      // clustered, not uniform: rock density follows a noise field (rock gardens vs. clean sand)
      const cluster = fbm(x / 60 + seed, z / 60, 3)
      if (r() > Math.pow(cluster, 2.2) * 2.4) continue
      const size = sizeMin + Math.pow(r(), sizePow) * (sizeMax - sizeMin)
      if (flat) sc.set(size * (1 + r()), size * (0.12 + r() * 0.12), size * (0.8 + r()))
      else sc.set(size * (0.7 + r() * 0.7), size * (0.55 + r() * 0.6), size * (0.7 + r() * 0.7))
      q.setFromAxisAngle(new Vector3(r() - 0.5, 2, r() - 0.5).normalize(), r() * 6.28)
      // partly buried: sink 20–45 % of the height
      pos.set(x, marsHeight(x, z) + sc.y * (flat ? -0.05 : 0.72 - 0.25 * r()) - sc.y * 0.45, z)
      m.compose(pos, q, sc)
      ref.current.setMatrixAt(i, m)
      if (!flat && sc.y * 0.55 > 0.35) obstacles.push({ x, z, r: Math.max(sc.x, sc.z) * 0.85 })
      // as in Perseverance's images: dark grey basalt, grey-brown, the odd pale block; dust does the rest
      const t = r()
      if (t < 0.5) col.setRGB(0.12, 0.112, 0.105)
      else if (t < 0.82) col.setRGB(0.18, 0.155, 0.135)
      else if (t < 0.93) col.setRGB(0.15, 0.155, 0.13)
      else col.setRGB(0.29, 0.25, 0.21)
      col.multiplyScalar(0.8 + r() * 0.45)
      ref.current.setColorAt(i, col)
      i++
    }
    ref.current.count = i
    ref.current.instanceMatrix.needsUpdate = true
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true
    ref.current.computeBoundingSphere()
  }, [count, seed, minR, maxR, sizeMin, sizeMax, sizePow, flat])
  return <instancedMesh ref={ref} args={[geo, rockMat, count]} castShadow receiveShadow key={count} />
}

function Rocks() {
  const quality = useMission((s) => s.quality)
  const k = QUALITY[quality].particles
  return (
    <>
      {/* gravel & cobbles — most rocks at Jezero are fist-sized or smaller */}
      <RockField count={Math.round(9000 * k)} seed={17} minR={9} maxR={260} sizeMin={0.04} sizeMax={0.55} sizePow={3} geoSeed={3} />
      <RockField count={Math.round(4000 * k)} seed={19} minR={12} maxR={260} sizeMin={0.05} sizeMax={0.4} sizePow={2.5} geoSeed={7} />
      {/* boulders out to the mid-ground */}
      <RockField count={Math.round(1400 * k)} seed={23} minR={18} maxR={1400} sizeMin={0.35} sizeMax={2.8} sizePow={3.5} geoSeed={11} />
      {/* flat, fractured bedrock slabs */}
      <RockField count={Math.round(260 * k)} seed={29} minR={30} maxR={700} sizeMin={0.6} sizeMax={2.2} sizePow={2.5} geoSeed={13} flat />
    </>
  )
}

const TEX = (f: string) => `${import.meta.env.BASE_URL}textures/${f}`
const DATA = (f: string) => `${import.meta.env.BASE_URL}data/${f}`

export function MarsSite() {
  const quality = useMission((s) => s.quality)
  const [coreBuf, farBuf, nearBuf, metaTxt] = useLoader(BinaryLoader, [binUrl(DATA('jezero_core.u16')), binUrl(DATA('jezero_far.u16')), binUrl(DATA('jezero_near.u16')), DATA('jezero_meta.json')]) as unknown as ArrayBuffer[]
  useMemo(() => {
    const meta = JSON.parse(new TextDecoder().decode(metaTxt))
    real = {
      core: { ...meta.core, data: new Uint16Array(coreBuf) },
      far: { ...meta.far, data: new Uint16Array(farBuf) },
      near: { ...meta.near, data: new Uint16Array(nearBuf) },
    }
  }, [coreBuf, farBuf, nearBuf, metaTxt])
  const imgs = useTexture([TEX('jezero_hirise.jpg'), TEX('jezero_ctx.jpg'), TEX('jezero_far.jpg')])
  const det = useTexture([TEX('pbr/gravel_color.jpg'), TEX('pbr/gravel_nr.jpg'), TEX('pbr/sand_color.jpg'), TEX('pbr/sand_nr.jpg')])
  useMemo(() => {
    det.forEach((t, i) => {
      t.wrapS = t.wrapT = RepeatWrapping
      t.colorSpace = i % 2 === 0 ? SRGBColorSpace : NoColorSpace
      t.anisotropy = 8
      t.needsUpdate = true
    })
    const u = marsGround.userData.uniforms
    ;[u.uGravC.value, u.uGravN.value, u.uSandC.value, u.uSandN.value] = det
    u.uDetOn.value = 1
  }, [det])
  useMemo(() => {
    for (const t of imgs) {
      t.flipY = false
      t.colorSpace = NoColorSpace
      t.anisotropy = 8
      t.needsUpdate = true
    }
    const u = marsGround.userData.uniforms
    u.uImgHi.value = imgs[0]
    u.uImgCtx.value = imgs[1]
    u.uImgFar.value = imgs[2]
    u.uImgOn.value = 1
  }, [imgs])
  const geo = terrain(QUALITY[quality].terrainRes, 'jezero')
  useFrame(() => {
    const t = runtime.t
    marsGround.userData.uniforms.uBlast.value = Math.min(1, Math.max(0, (t - 214) / 4))
  })
  return (
    <group>
      <mesh geometry={geo} material={marsGround} receiveShadow />
      <Rocks />
    </group>
  )
}
