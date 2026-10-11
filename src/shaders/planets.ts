import { ATMOSPHERE_GLSL } from './atmosphere'
import { NOISE_GLSL } from './noise'

/**
 * Planet surface + atmosphere-shell shaders for the space world.
 * All in kilometres. Logarithmic depth chunks are included so a 50 m ship and
 * a 12,742 km planet share one depth buffer without z-fighting.
 */

const COMMON_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorldPos;
varying vec3 vObjPos;
varying vec3 vTangent;
varying vec2 vUv;
void main(){
  vUv = uv;
  vObjPos = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vTangent = normalize(mat3(modelMatrix) * vec3(position.z, 0.0, -position.x));
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`

export const earthSurfaceShader = {
  vertexShader: COMMON_VERT,
  fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMOSPHERE_GLSL}
${NOISE_GLSL}
#ifndef CLOUD_CH
#define CLOUD_CH b
#endif
uniform sampler2D uDay;
uniform sampler2D uNight;
uniform sampler2D uBRC;      // R: elevation, G: land mask, B: clouds
uniform sampler2D uNormal;
uniform sampler2D uClouds;   // cloud reflectance (CLOUD_CH channel)
uniform vec3 uSunDir;
uniform vec3 uCenter;
uniform float uCloudShift;
uniform float uSunE;
uniform float uNightI;
varying vec3 vWorldPos;
varying vec3 vObjPos;
varying vec3 vTangent;
varying vec2 vUv;

float cosLat;
vec3 gT, gB;
// uv offset for a displacement (km) on the tangent plane: T = east (+u), B = north (+v)
vec2 kmToUv(vec3 off){
  return vec2(dot(off, gT) / (6.2831853 * uPlanetR * max(cosLat, 0.03)), dot(off, gB) / (3.1415927 * uPlanetR));
}
float cloudTex(vec2 uv, float bias){ return texture2D(uClouds, uv, bias).CLOUD_CH; }
// B-spline bicubic from 4 bilinear taps: magnified cloud texels read as soft, rounded masses, not squares
vec4 cubicW(float v){
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v; vec4 s = n * n * n;
  float x = s.x, y = s.y - 4.0 * s.x, z = s.z - 4.0 * s.y + 6.0 * s.x;
  return vec4(x, y, z, 6.0 - x - y - z) * (1.0 / 6.0);
}
float cloudCubic(vec2 uv){
  vec2 ts = vec2(textureSize(uClouds, 0));
  vec2 st = uv * ts - 0.5; vec2 i = floor(st); vec2 f = st - i;
  vec4 xc = cubicW(f.x), yc = cubicW(f.y);
  vec4 c = i.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 o = (c + vec4(xc.yw, yc.yw) / s) / ts.xxyy;
  float a = texture2D(uClouds, o.xz).CLOUD_CH, b = texture2D(uClouds, o.yz).CLOUD_CH;
  float d = texture2D(uClouds, o.xw).CLOUD_CH, e = texture2D(uClouds, o.yw).CLOUD_CH;
  float sx = s.x / (s.x + s.y), sy = s.z / (s.z + s.w);
  return mix(mix(e, d, sx), mix(b, a, sx), sy);
}
// cloud-top height (km): thin sheets sit low, thick cores / frontal bands tower
float cloudTop(float c, float cl){ return 1.5 + 6.0 * smoothstep(0.15, 0.85, cl) + 5.0 * c * sqrt(c); }
// optical opacity of the layer from its reflectance
float cloudAlpha(float c){ return pow(clamp(c / 0.82, 0.0, 1.0), 1.25); }

void main(){
  #include <logdepthbuf_fragment>
  vec3 p = vWorldPos - uCenter;
  vec3 n0 = normalize(p);
  vec3 T = normalize(vTangent - n0 * dot(vTangent, n0));
  vec3 B = cross(n0, T);
  gT = T; gB = B;
  vec3 L = normalize(uSunDir);
  vec3 camRel = cameraPosition - uCenter;
  float dist = length(vWorldPos - cameraPosition);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 dir = normalize(vObjPos);
  cosLat = sqrt(max(1.0 - dir.y * dir.y, 0.0));

  // --- terrain normal from the relief normal map
  vec3 nm = texture2D(uNormal, vUv).xyz * 2.0 - 1.0;
  vec3 n = normalize(T * nm.x * 0.9 + B * nm.y * 0.9 + n0 * nm.z);

  vec3 brc = texture2D(uBRC, vUv).rgb;
  float land = smoothstep(0.35, 0.65, brc.g);
  float ocean = 1.0 - land;

  // --- close-range detail so the planet holds up from 20 km altitude
  float detailFade = 1.0 - smoothstep(400.0, 2500.0, dist);
  float det = detailFade > 0.001 ? fbm3(dir * 700.0, 4) : 0.0;

  float mu = dot(n0, L);

  // ================= clouds: a height field above the ground =================
  vec2 cuv = vUv + vec2(uCloudShift, 0.0);
  // blurred density (mip bias) = large-scale thickness -> cloud-top height
  float cl0 = cloudTex(cuv, 4.0);
  float h0 = cloudTop(cl0, cl0);
  // parallax: where the view ray actually crosses the cloud tops
  vec2 tc = raySphere(camRel, -V, uPlanetR + h0);
  vec3 pc = tc.x > 0.0 && tc.x < dist ? camRel - V * tc.x : p + n0 * h0;
  vec2 puv = cuv + kmToUv(pc - p);
  float cRaw = cloudCubic(puv);
  float cl = cloudTex(puv, 4.0);
  // sub-texel structure (the map's texels are ~5 km): cells and wisps down to ~1 km, eroding
  // the cloud from its thin edges; clear sky stays clear (no speckle)
  vec3 pd = normalize(pc);
  float fd1 = 1.0 - smoothstep(700.0, 3000.0, dist);
  float fd2 = 1.0 - smoothstep(60.0, 700.0, dist);
  float nd = 0.0;
  if (fd1 > 0.001) nd += fbm3(pd * 900.0 + 3.0, 4) * fd1;
  if (fd2 > 0.001) nd += fbm3(pd * 3000.0 + 7.0, 2) * 0.35 * fd2;
  // from low orbit (photos from the ISS / Starship at ~200 km) cumulus fields resolve into ~1 km cells
  float fd3 = 1.0 - smoothstep(40.0, 450.0, dist);
  if (fd3 > 0.001) nd += fbm3(pd * 9500.0 + 11.0, 3) * 0.32 * fd3;
  float c = clamp(cRaw + nd * 0.85 * cRaw * (1.0 - 0.55 * cRaw), 0.0, 1.0);
  // crisp cell margins against the dark ocean at close range, not a soft veil
  c = mix(c, smoothstep(0.12, 0.6, c) * max(c, 0.35), 0.55 * fd2);
  float cA = cloudAlpha(c);
  float hc = cloudTop(c, cl);

  // relief: cloud-top normal from the height-field gradient (sunlit flanks, dark lee sides)
  const float STEP = 9.0; // km
  vec2 dU = kmToUv(T * STEP), dV = kmToUv(B * STEP);
  float hE = cloudTop(cloudTex(puv + dU, 0.8), cl), hW = cloudTop(cloudTex(puv - dU, 0.8), cl);
  float hN = cloudTop(cloudTex(puv + dV, 0.8), cl), hS = cloudTop(cloudTex(puv - dV, 0.8), cl);
  vec2 g = vec2(hE - hW, hN - hS) / (2.0 * STEP);
  vec3 nc = normalize(n0 - (T * g.x + B * g.y) * 1.6);
  // billowed tops at close range: bump the cloud normal with the detail field (perturbNormalArb)
  float hd = nd * cRaw * 0.9;
  vec3 dpx = dFdx(vWorldPos), dpy = dFdy(vWorldPos);
  vec3 r1 = cross(dpy, nc), r2 = cross(nc, dpx);
  float dt = dot(dpx, r1);
  vec3 bg = sign(dt) * (dFdx(hd) * r1 + dFdy(hd) * r2);
  nc = normalize(abs(dt) * nc - bg);
  // self-shadowing along the sun azimuth: tall towers shade their neighbours near the terminator
  vec3 Lt = L - n0 * mu;
  float lt = length(Lt);
  float occl = 0.0;
  Lt /= max(lt, 1e-3);
  float tanE = mu / max(lt, 1e-3);
  for (int i = 1; i <= 3; i++) {
    float d = STEP * 1.8 * float(i * i);
    float hs = cloudTop(cloudTex(puv + kmToUv(Lt * d), 1.0), cl);
    occl = max(occl, smoothstep(0.0, 1.5, hs - (hc + d * tanE)));
  }
  occl *= smoothstep(0.45, 0.15, mu) * smoothstep(-0.1, 0.0, mu);
  // multiple scattering keeps the dark sides luminous: wrapped diffuse, normalised to the flat case
  float wrapK = 0.25;
  float difC = clamp((dot(nc, L) + wrapK) / (1.0 + wrapK), 0.0, 1.0);
  float difF = clamp((mu + wrapK) / (1.0 + wrapK), 0.0, 1.0);
  float relief = difC * (1.0 - 0.75 * occl);
  vec3 sunCloud = sunTransmittance(n0 * (uPlanetR + hc), L) * uSunE;
  // thick cores a little greyer where the sun is low (deep, self-shadowed towers)
  float thick = smoothstep(0.55, 1.0, cl);
  // optically thin cloud reflects less (the rest of its opacity is forward-scattered to the ground)
  vec3 cAlb = mix(vec3(0.84, 0.85, 0.87), vec3(0.7, 0.72, 0.76), thick * (1.0 - smoothstep(0.1, 0.6, mu))) * mix(0.8, 1.0, smoothstep(0.2, 0.7, c));
  vec3 cloudCol = cAlb * sunCloud * relief;
  cloudCol += cAlb * vec3(0.035, 0.05, 0.08) * smoothstep(-0.15, 0.3, mu) * uSunE; // blue skylight

  // cloud shadow on the ground, cast along the true sun direction
  float cs = cloudTex(cuv + kmToUv(L * (h0 / max(mu, 0.06))), 0.5);
  float sh = cloudAlpha(cs) * 0.85 * smoothstep(-0.05, 0.08, mu);

  // ================= ground =================
  // NASA Blue Marble albedo
  vec3 day = texture2D(uDay, vUv).rgb;
  day *= 1.0 + det * 0.22 * land * detailFade;
  day = mix(day, day * vec3(0.92, 0.97, 1.05), ocean);

  float NdotL = max(dot(n, L), 0.0);
  vec3 sunCol = sunTransmittance(n0 * (uPlanetR + 0.2), L) * uSunE;

  vec3 H = normalize(L + V);
  // ocean sun glint: sharp core + broad sheen, Fresnel-weighted
  float nh = max(dot(n0, H), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n0, V), 0.0), 5.0);
  // wind-roughened sea: glint width varies with a large-scale 'wind' field
  float wind = 0.5 + 0.5 * snoise(dir * 40.0);
  float sharp = mix(1400.0, 260.0, wind);
  float glint = (pow(nh, sharp) * mix(9.0, 3.0, wind) + pow(nh, 60.0) * 0.28) * ocean * (1.0 - cA) * (1.0 - sh);
  vec3 ground = day * NdotL * sunCol * (1.0 - sh);
  ground += sunCol * glint * step(0.0, mu) + fres * ocean * vec3(0.02, 0.04, 0.08) * max(mu, 0.0) * uSunE;

  vec3 surf = mix(ground, cloudCol, cA);

  // --- city lights: only once the ground itself is dark, dimmed by overlying cloud
  float night = smoothstep(0.02, -0.1, mu);
  vec3 lights = texture2D(uNight, vUv).rgb;
  lights = pow(lights, vec3(1.8)) * vec3(1.0, 0.74, 0.44) * uNightI;
  surf += lights * night * (1.0 - cA * 0.85);

  // --- aerial perspective through the real atmosphere
  vec3 trans;
  vec3 inscatter = atmoScatter(camRel, -V, dist, L, trans);
  vec3 col = surf * trans + inscatter;
  gl_FragColor = vec4(col, 1.0);
}
`,
}

export const atmosphereShellShader = {
  vertexShader: COMMON_VERT,
  fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMOSPHERE_GLSL}
uniform vec3 uSunDir;
uniform vec3 uCenter;
uniform float uIntensity;
varying vec3 vWorldPos;
varying vec3 vObjPos;
varying vec3 vTangent;
varying vec2 vUv;
void main(){
  #include <logdepthbuf_fragment>
  vec3 ro = cameraPosition - uCenter;
  vec3 rd = normalize(vWorldPos - cameraPosition);
  vec2 ph = raySphere(ro, rd, uPlanetR);
  // over the disk the planet's own shader already applies aerial perspective along this
  // ray: the shell only draws the limb (plus a thin blend band hiding the mesh silhouette)
  float b = dot(ro, rd);
  float rMin = sqrt(max(dot(ro, ro) - b * b, 0.0));
  float disk = ph.x > 0.0 ? 1.0 - smoothstep(uPlanetR * 0.996, uPlanetR * 0.9995, rMin) : 0.0;
  if (disk >= 1.0) discard;
  float tMax = ph.x > 0.0 ? ph.x : 1e20;
  vec3 trans;
  vec3 col = atmoScatter(ro, rd, tMax, normalize(uSunDir), trans) * uIntensity * (1.0 - disk);
  gl_FragColor = vec4(col, 1.0);
}
`,
}

export const marsSurfaceShader = {
  vertexShader: COMMON_VERT,
  fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMOSPHERE_GLSL}
${NOISE_GLSL}
uniform sampler2D uColor;
uniform sampler2D uBump;
uniform sampler2D uNormal;   // MOLA relief normals (R east, G north, B up), used when uNormalK > 0
uniform float uNormalK;
uniform float uBumpK;        // global bump-map weight (0 when the normal map carries the relief)
uniform float uPolar;        // synthetic polar caps (only for maps without them)
uniform float uAlbK;
uniform float uSat;
uniform vec3 uSunDir;
uniform vec3 uCenter;
uniform float uSunE;
varying vec3 vWorldPos;
varying vec3 vObjPos;
varying vec3 vTangent;
varying vec2 vUv;

float surfaceHeight(vec3 dir, float dist, out float craterMask){
  // the 1K bump map is 0..360 E; the colour/normal maps are -180..180
  float h = texture2D(uBump, vUv + vec2(0.5, 0.0)).r * 1.2 * uBumpK;
  // octave fading keeps sub-pixel detail from shimmering
  float f1 = 1.0 - smoothstep(4000.0, 12000.0, dist);
  float f2 = 1.0 - smoothstep(900.0, 3500.0, dist);
  float f3 = 1.0 - smoothstep(150.0, 700.0, dist);
  float c = 0.0;
  // with real MOLA relief the large synthetic craters are toned down (they would sit in made-up places)
  if (f1 > 0.0) { c += craters(dir * 38.0) * 0.8 * f1 * mix(0.2, 1.0, uBumpK); h += fbm3(dir * 60.0, 4) * 0.25 * f1; }
  if (f2 > 0.0) { c += craters(dir * 260.0) * 0.35 * f2; h += ridged3(dir * 180.0, 3) * 0.18 * f2; }
  if (f3 > 0.0) { c += craters(dir * 1600.0) * 0.07 * f3; h += fbm3(dir * 2400.0, 3) * 0.05 * f3; }
  craterMask = c;
  return h + c;
}

void main(){
  #include <logdepthbuf_fragment>
  vec3 p = vWorldPos - uCenter;
  vec3 n0 = normalize(p);
  vec3 L = normalize(uSunDir);
  vec3 camRel = cameraPosition - uCenter;
  float dist = length(vWorldPos - cameraPosition);
  vec3 dir = normalize(vObjPos);

  vec3 T = normalize(vTangent - n0 * dot(vTangent, n0));
  vec3 Bt = cross(n0, T);
  // real relief (Tharsis, Valles Marineris, Hellas, crater rims) from MOLA; the map is x18 exaggerated
  vec3 nm = texture2D(uNormal, vUv).xyz * 2.0 - 1.0;
  vec3 nBase = normalize(n0 + (T * nm.x + Bt * nm.y) / max(nm.z, 0.2) * uNormalK);
  float cm;
  float h = surfaceHeight(dir, dist, cm);
  // bump mapping from screen-space derivatives (three.js perturbNormalArb)
  vec3 dpx = dFdx(vWorldPos); vec3 dpy = dFdy(vWorldPos);
  float dhx = dFdx(h); float dhy = dFdy(h);
  vec3 r1 = cross(dpy, nBase); vec3 r2 = cross(nBase, dpx);
  float det = dot(dpx, r1);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  float bumpScale = 1.6;
  vec3 n = normalize(abs(det) * nBase - grad * bumpScale);

  // NASA global mosaic: muted butterscotch, tan, rust and dark basaltic regions
  vec3 alb = texture2D(uColor, vUv).rgb;
  float lum = dot(alb, vec3(0.3, 0.55, 0.15));
  alb = mix(vec3(lum), alb, uSat) * uAlbK;
  float dust = fbm3(dir * 120.0, 3);
  alb *= 0.92 + 0.16 * dust;
  alb = mix(alb, alb * vec3(1.18, 1.08, 1.0), smoothstep(0.02, 0.12, cm));   // bright ejecta
  alb = mix(alb, alb * vec3(0.7, 0.66, 0.64), smoothstep(-0.02, -0.15, cm)); // shadowed crater floors
  // polar caps (bright CO2/H2O ice)
  float polar = smoothstep(0.93, 0.97, abs(dir.y));
  alb = mix(alb, vec3(0.85, 0.83, 0.8), polar * 0.6 * uPolar);

  float mu = dot(n0, L);
  float NdotL = max(dot(n, L), 0.0) * smoothstep(-0.04, 0.06, mu);
  // Oren–Nayar-ish flattening: Mars regolith is rough and back-scattering
  float V_dot = max(dot(n0, normalize(cameraPosition - vWorldPos)), 0.0);
  float rough = mix(1.0, 0.75 + 0.25 * V_dot, 0.6);
  vec3 sunCol = sunTransmittance(n0 * (uPlanetR + 0.5), L) * uSunE;
  vec3 surf = alb * NdotL * sunCol * rough;
  // faint skylight from the dusty atmosphere
  surf += alb * vec3(0.05, 0.03, 0.02) * smoothstep(-0.1, 0.3, mu) * uSunE;

  vec3 trans;
  vec3 inscatter = atmoScatter(camRel, normalize(vWorldPos - cameraPosition), dist, L, trans);
  gl_FragColor = vec4(surf * trans + inscatter, 1.0);
}
`,
}
