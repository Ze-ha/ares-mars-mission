import { NOISE_GLSL } from './noise'

/**
 * VFX shaders: engine jets (per-nozzle, with Mach diamonds), the merged
 * turbulent plume, nozzle heat glow, GPU particles and re-entry plasma.
 * All are additive/emissive HDR so bloom picks them up naturally.
 */

const LOG_V = `#include <common>\n#include <logdepthbuf_pars_vertex>\n`
const LOG_F = `#include <common>\n#include <logdepthbuf_pars_fragment>\n`

/**
 * Exhaust plumes are emission-only volumes, ray-marched inside a bounding
 * solid of revolution (back faces only, so the camera may sit inside one).
 * Frame: metres, nozzle exit (or cluster exit plane) at the origin, flow
 * toward -y. The camera is carried into that frame per instance, so the same
 * code works in the metre worlds and the km-scaled space world.
 *
 * Physics that shapes them (uniforms computed on the CPU from ambient pressure):
 *  - under-expansion U = p_exit / p_ambient sets the barrel width (~√U),
 *    Mach-disc distance and shock-cell spacing; diamonds fade as U grows
 *  - afterburning of the fuel-rich exhaust in entrained air makes the bright
 *    orange-yellow mixing layer; the supersonic core stays nearly transparent
 *  - in vacuum the gas expands to a wide, faint fan: only the exit glows
 */
const PLUME_COMMON = /* glsl */ `
uniform float uLength;
uniform float uR0;      // radius at the exit plane
uniform float uRMax;    // pressure-matched barrel radius
uniform float uLs;      // distance over which the barrel opens
uniform float uSpread;  // turbulent mixing growth dr/ds
uniform float uGround;  // distance to the ground along the axis (1e6 = none)
uniform float uWall;    // radial spreading near the ground
float plumeR(float s){
  float r = uR0 + (uRMax - uR0) * (1.0 - exp(-s / uLs)) + uSpread * s;
  return r + uWall * max(0.0, s - uGround + 2.5 * uR0);
}
`

const PLUME_VERT = /* glsl */ `
${LOG_V}
${PLUME_COMMON}
uniform float uBound;
varying vec3 vLocal;
varying vec3 vCam;
varying float vSeed;
void main(){
  mat4 im = modelMatrix;
  vSeed = 0.37;
  #ifdef USE_INSTANCING
    im = modelMatrix * instanceMatrix;
    vSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
  #endif
  float L = min(uLength, uGround + uR0) * (0.93 + 0.14 * vSeed);
  float s = clamp(-position.y, 0.0, 1.0) * L;
  float r = plumeR(s) * uBound + 0.1 * uR0;
  vec3 p = vec3(position.x * r, -s, position.z * r);
  vLocal = p;
  vCam = (inverse(im) * vec4(cameraPosition, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * im * vec4(p, 1.0);
  #include <logdepthbuf_vertex>
}
`

/** Shared fragment prologue: ray setup, entry into the bounding cylinder, jitter. */
const PLUME_FRAG_HEAD = /* glsl */ `
${LOG_F}
${PLUME_COMMON}
precision highp sampler3D;
uniform sampler3D tNoise;
uniform float uTime;
uniform float uThrottle;
uniform float uIntensity;
uniform float uBound;
uniform float uFlow;      // apparent downstream advection of turbulence (m/s)
uniform float uAfter;     // afterburning / mixing-layer luminosity
uniform float uVac;       // 0 dense air … 1 vacuum
uniform vec3 uColCore;
uniform vec3 uColShock;
uniform vec3 uColHot;
uniform vec3 uColCool;
varying vec3 vLocal;
varying vec3 vCam;
varying float vSeed;
float nz(vec3 p){ return texture(tNoise, p).r; }
// ray [tEn, tEx] inside the bounding cylinder (radius Rb, y in [-L, 0])
bool plumeRay(float L, float Rb, out vec3 ro, out vec3 rd, out float tEn, out float tEx){
  ro = vCam;
  vec3 d = vLocal - ro;
  tEx = length(d);
  rd = d / tEx;
  tEn = 0.0;
  if (abs(rd.y) > 1e-5) {
    float a = (0.0 - ro.y) / rd.y, b = (-L - ro.y) / rd.y;
    tEn = max(tEn, min(a, b));
  }
  float A = dot(rd.xz, rd.xz);
  if (A > 1e-6) {
    float B = dot(ro.xz, rd.xz);
    float C = dot(ro.xz, ro.xz) - Rb * Rb;
    float D = B * B - A * C;
    if (D > 0.0) tEn = max(tEn, (-B - sqrt(D)) / A);
  }
  tEn = min(tEn, tEx);
  return tEx - tEn > 1e-4;
}
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`

/** One exhaust jet per engine (instanced): transparent core, Mach diamonds, afterburning mixing layer. */
export const plumeJetShader = {
  vertexShader: PLUME_VERT,
  fragmentShader: /* glsl */ `
${PLUME_FRAG_HEAD}
uniform float uCell;      // shock-cell length (m)
uniform float uDiamond;   // shock-diamond luminosity
uniform float uCoreLen;   // supersonic potential-core length (m)
vec3 jetEmit(vec3 q, float L){
  float s = -q.y;
  float R = plumeR(s);
  float rho = length(q.xz);
  float sr = s / uR0;
  // turbulence advected downstream; each engine has its own phase
  vec3 nq = vec3(q.x, q.y + uFlow * uTime, q.z) * (0.55 / uR0) + vSeed * 31.0;
  float n = nz(nq * 0.23 + vec3(0.0, uTime * 0.9, 0.0));
  float x = rho / R;
  float xr = x * (1.0 + (n - 0.5) * 0.45 * smoothstep(1.0, 6.0, sr) * (1.0 - uVac));
  float tail = 1.0 - smoothstep(0.45 * L, L, s);
  // supersonic core: nearly transparent, faint blue-violet (CH*/CO2 bands), shrinking downstream
  float cw = max(0.08, 0.8 * (1.0 - s / uCoreLen));
  float core = exp(-xr * xr / (cw * cw)) * (1.0 - smoothstep(0.6 * uCoreLen, uCoreLen, s));
  // shock diamonds: Mach disc then a knot of shock-heated gas in each cell, decaying downstream
  float ph = s / uCell - 0.55;
  float k = floor(ph);
  float f = ph - k;
  float dec = ph < 0.0 ? 0.0 : exp(-k * 0.42) * step(k, 6.0);
  float knot = exp(-pow((f - 0.32) / 0.17, 2.0)) * exp(-xr * xr / 0.2);
  float disc = exp(-pow((f - 0.07) / 0.035, 2.0)) * exp(-xr * xr / 0.3) * exp(-k * 0.9);
  float shock = (knot + 1.3 * disc) * dec * uDiamond;
  // afterburning mixing layer: born thin at the lip, thickening and flickering downstream
  float w = mix(0.1, 0.5, smoothstep(0.0, 14.0, sr));
  float shell = exp(-pow((xr - 1.0) / w, 2.0)) + 0.35 * exp(-xr * xr * 2.0) * smoothstep(4.0, 16.0, sr);
  float grow = smoothstep(0.0, 2.2, sr);
  float turb = 0.3 + 1.4 * n;
  float mixE = shell * grow * turb * uAfter;
  // vacuum: free expansion, luminosity falls with the flow area — only the exit glows
  float area = (uR0 * uR0) / (R * R);
  // in vacuum the core thins with the expanding flow area as well
  core *= mix(1.0, area, uVac);
  float vac = exp(-xr * xr * 1.6) * area * exp(-sr * 0.22) * uVac;
  vec3 hot = mix(uColHot, uColCool, smoothstep(0.0, L, s));
  vec3 c = uColCore * core + uColShock * shock + hot * mixE + mix(uColCore, uColShock, 0.35) * vac * 2.5;
  return c * tail * step(0.0, s) * step(s, uGround);
}
void main(){
  #include <logdepthbuf_fragment>
  if (uThrottle <= 0.001) discard;
  float L = min(uLength, uGround + uR0) * (0.93 + 0.14 * vSeed);
  vec3 ro, rd; float tEn, tEx;
  if (!plumeRay(L, plumeR(L) * uBound + 0.1 * uR0, ro, rd, tEn, tEx)) discard;
  const int N = 12;
  float dt = (tEx - tEn) / float(N);
  float j = ign(gl_FragCoord.xy);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < N; i++) acc += jetEmit(ro + rd * (tEn + (float(i) + j) * dt), L);
  // per-engine brightness and a slight combustion flicker
  float flick = (0.9 + 0.2 * vSeed) * (0.94 + 0.06 * sin(uTime * 43.0 + vSeed * 60.0));
  gl_FragColor = vec4(acc * dt / uR0 * uIntensity * uThrottle * flick, 1.0);
}
`,
}

/** The merged cluster plume: the column the jets become downstream, ballooning as the air thins. */
export const plumeVolumeShader = {
  vertexShader: PLUME_VERT,
  fragmentShader: /* glsl */ `
${PLUME_FRAG_HEAD}
uniform float uStart;     // where the individual jets have merged (m)
uniform float uDecay;     // e-folding length of luminosity (m)
uniform float uFill;      // 0: luminous skin (mixing layer) … 1: filled glowing body
uniform float uImpinge;   // brightening where the jet strikes the ground
vec3 volEmit(vec3 q, float L){
  float s = -q.y;
  float R = plumeR(s);
  float rho = length(q.xz);
  vec3 a = vec3(q.x, q.y + uFlow * uTime, q.z);
  float n1 = nz(a / (5.0 * uR0) + vec3(0.0, uTime * 0.21, 0.0));
  float n2 = nz(a / (1.9 * uR0) + vec3(uTime * 0.13, uTime * 0.5, 0.0) + 7.3);
  float n = n1 * 0.62 + n2 * 0.38;
  float x = rho / R * (1.0 + (n - 0.5) * 0.7);
  float fill = exp(-x * x * 2.4);
  float skin = exp(-pow((x - 0.85) / 0.28, 2.0));
  float body = mix(skin, fill, uFill);
  float start = smoothstep(0.35 * uStart, 1.3 * uStart, s);
  float tail = 1.0 - smoothstep(0.4 * L, L, s);
  float axial = exp(-s / uDecay);
  float area = pow(uR0 / R, 0.9);
  float turb = pow(0.2 + 1.35 * n, 1.6);
  float imp = 1.0 + uImpinge * exp(-(uGround - s) / (0.6 * uR0));
  vec3 col = mix(uColHot, uColCool, smoothstep(0.0, 0.7 * L, s));
  float e = body * start * tail * axial * area * turb * imp * step(0.0, s) * step(s, uGround);
  return col * e * uAfter + uColCore * fill * area * uVac * exp(-s / (2.0 * uR0)) * 0.6;
}
void main(){
  #include <logdepthbuf_fragment>
  if (uThrottle <= 0.001) discard;
  float L = min(uLength, uGround + uR0);
  vec3 ro, rd; float tEn, tEx;
  if (!plumeRay(L, plumeR(L) * uBound + 0.1 * uR0, ro, rd, tEn, tEx)) discard;
  const int N = 22;
  float dt = (tEx - tEn) / float(N);
  float j = ign(gl_FragCoord.xy);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < N; i++) acc += volEmit(ro + rd * (tEn + (float(i) + j) * dt), L);
  gl_FragColor = vec4(acc * dt / uR0 * uIntensity * uThrottle, 1.0);
}
`,
}

/**
 * Jet impingement on the ground: a hot stagnation spot and the thin radial
 * wall jet streaming outward from it. Drawn as a disc lying on the surface;
 * brighter at grazing view angles, where the sheet is seen edge-on.
 */
export const impingeShader = {
  vertexShader: /* glsl */ `
${LOG_V}
varying vec2 vP;
varying vec3 vW;
void main(){
  vP = position.xz * 2.0;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}
`,
  fragmentShader: /* glsl */ `
${LOG_F}
precision highp sampler3D;
uniform sampler3D tNoise;
uniform float uIntensity;
uniform float uTime;
uniform float uCore;      // stagnation-spot radius as a fraction of the disc
uniform vec3 uColHot;
uniform vec3 uColWall;
varying vec2 vP;
varying vec3 vW;
void main(){
  #include <logdepthbuf_fragment>
  if (uIntensity <= 0.001) discard;
  float d = length(vP);
  if (d > 1.0) discard;
  float a = atan(vP.y, vP.x);
  // streaks advected outward; angular coordinate wrapped onto a circle so it tiles
  vec3 c = vec3(cos(a), sin(a), 0.0) * 1.3;
  float n = texture(tNoise, c + vec3(0.0, 0.0, d * 1.6 - uTime * 2.2)).r;
  float n2 = texture(tNoise, c * 2.7 + vec3(0.5, 0.0, d * 3.1 - uTime * 3.7)).r;
  float rays = pow(0.25 + 1.2 * (n * 0.6 + n2 * 0.4), 2.0);
  float spot = exp(-d * d / (uCore * uCore));
  float wall = exp(-d * 3.2) * smoothstep(1.0, 0.55, d) * rays * smoothstep(0.0, uCore * 1.2, d);
  float graze = 1.0 / max(abs(normalize(cameraPosition - vW).y), 0.18);
  vec3 col = uColHot * spot * 3.0 + uColWall * wall * graze;
  gl_FragColor = vec4(col * uIntensity, 1.0);
}
`,
}

/** Glow on the inside of the nozzle when the engine is running. */
export const nozzleGlowShader = {
  vertexShader: /* glsl */ `
${LOG_V}
uniform float uBellLength;
varying float vH;
void main(){
  vH = position.y / uBellLength;
  vec4 mv;
  #ifdef USE_INSTANCING
    mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  #else
    mv = modelViewMatrix * vec4(position, 1.0);
  #endif
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`,
  fragmentShader: /* glsl */ `
${LOG_F}
uniform float uThrottle;
uniform float uTime;
varying float vH;
void main(){
  #include <logdepthbuf_fragment>
  if (uThrottle <= 0.001) discard;
  float flick = 0.92 + 0.08 * sin(uTime * 60.0 + vH * 10.0);
  vec3 hot = mix(vec3(1.0, 0.45, 0.15), vec3(1.0, 0.85, 0.6), vH);
  float I = mix(1.5, 9.0, vH * vH) * uThrottle * flick;
  gl_FragColor = vec4(hot * I, 1.0);
}
`,
}

/**
 * Deterministic GPU particles: every particle's state is a closed-form
 * function of (time - spawn). No CPU simulation, exact under scrubbing.
 */
export const particleShader = {
  vertexShader: /* glsl */ `
${LOG_V}
attribute vec2 corner;
attribute float aSpawn;
attribute float aLife;
attribute vec3 aOrigin;
attribute vec3 aVel;
attribute vec4 aMisc;   // x: seed, y: size0, z: size1, w: rotation speed
uniform float uTime;
uniform float uDrag;
uniform float uBuoyancy;
uniform vec3 uWind;
uniform float uLoop;     // > 0: particles recycle with this period (ambient emitters)
uniform vec3 uSplitP;    // plane through the exhaust plume, facing the camera:
uniform vec3 uSplitN;    //   the smoke behind it draws before the (additive) flame, the smoke in front after it
uniform float uSplitSide;
varying vec2 vUv;
varying float vRot;
varying float vAge;
varying float vSeed;
varying vec3 vWorld;
varying float vSize;
void main(){
  float age = uTime - aSpawn;
  if (uLoop > 0.0) age = mod(age, uLoop);
  vAge = age / aLife;
  vSeed = aMisc.x;
  if (age < 0.0 || age > aLife) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float k = max(uDrag, 1e-4);
  vec3 disp = aVel * (1.0 - exp(-k * age)) / k;
  disp.y += uBuoyancy * pow(age, 1.25);
  disp += uWind * age;
  vec3 wp = (modelMatrix * vec4(aOrigin + disp, 1.0)).xyz;
  vWorld = wp;
  float sd = dot(wp - uSplitP, uSplitN);
  if ((uSplitSide > 0.5 && sd < 0.0) || (uSplitSide < -0.5 && sd >= 0.0)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float x = vAge;
  float size = mix(aMisc.y, aMisc.z, 1.0 - pow(1.0 - x, 2.2));
  vSize = size;
  float rot = aMisc.x * 6.28 + aMisc.w * age;
  vRot = rot;
  vec2 c = vec2(cos(rot) * corner.x - sin(rot) * corner.y, sin(rot) * corner.x + cos(rot) * corner.y);
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  mv.xy += c * size;
  vUv = corner * 0.5 + 0.5;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`,
  fragmentShader: /* glsl */ `
${LOG_F}
uniform sampler2D uAtlas;
uniform vec3 uColor;
uniform vec3 uSunDirV;     // view-space sun direction
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uGlowPos;     // world-space position of the engine light
uniform vec3 uGlowColor;
uniform float uGlowRadius;
uniform float uGlowLen;
uniform float uBillow;    // 1: dense cauliflower billows (steam, exhaust cloud) … 0: soft diffuse haze (fine dust)
uniform float uOpacity;
uniform float uEmissive;   // hot gas that cools with age
uniform float uGroundY;
uniform float uMaster;
uniform float uSparkle;   // ice crystals: tiny, hard, glinting
uniform float uTimeF;
varying vec2 vUv;
varying float vAge;
varying float vSeed;
varying vec3 vWorld;
varying float vSize;
varying float vRot;
void main(){
  #include <logdepthbuf_fragment>
  if (uSparkle > 0.5) {
    float d = length(vUv - 0.5) * 2.0;
    float core = exp(-d * d * 10.0);
    float glint = step(0.62, fract(sin(vSeed * 91.7 + floor(uTimeF * 14.0 + vSeed * 40.0)) * 43758.5453));
    float a = core * (0.25 + 1.5 * glint) * (1.0 - vAge) * uMaster;
    vec3 c = uColor * (uSunColor * 1.4 + uAmbient);
    gl_FragColor = vec4(c * a, a * 0.6);
    return;
  }
  float v = floor(vSeed * 4.0);
  vec2 off = vec2(mod(v, 2.0), floor(v / 2.0)) * 0.5;
  vec4 tex = texture2D(uAtlas, off + vUv * 0.5);
  vec2 qq = vUv * 2.0 - 1.0;
  float soft = (1.0 - smoothstep(0.15, 1.0, length(qq))) * (0.5 + 0.5 * tex.a);
  float dens = mix(soft, tex.a, uBillow);
  if (dens < 0.01) discard;
  // billow normals from the atlas (cauliflower cells), blended with the puff's overall roundness,
  // turned with the sprite into view space
  vec2 q = vUv * 2.0 - 1.0;
  vec2 nt = tex.rg * 2.0 - 1.0;
  vec3 nd = vec3(nt, sqrt(max(1.0 - dot(nt, nt), 0.02)));
  vec3 ns = vec3(q * 0.75, sqrt(max(1.0 - dot(q, q) * 0.5625, 0.05)));
  vec3 n = normalize(mix(ns, nd, 0.78 * uBillow));
  float cr = cos(vRot), sr = sin(vRot);
  n.xy = vec2(cr * n.x - sr * n.y, sr * n.x + cr * n.y);
  vec3 L = normalize(uSunDirV);
  // wrapped diffuse (dense cloud multiple-scatters light round into the terminator)
  float lam = clamp(dot(n, L) * 0.62 + 0.42, 0.0, 1.0);
  float h = tex.b;
  // the folds between billows see less sky and less sun
  float ao = mix(0.5, 1.0, smoothstep(0.0, 0.55, h));
  // forward scattering: vapour and dust glow when back-lit instead of turning dark
  float fwd = pow(max(-L.z, 0.0), 3.0) * (1.0 - h * 0.5);
  vec3 col = uColor * (uSunColor * (lam * ao + fwd * 0.9) + uAmbient * 1.25 * ao);
  // engine light: the flame is a line source down the plume axis; billows facing it light up
  vec3 fp = vec3(uGlowPos.x, clamp(vWorld.y, uGlowPos.y - uGlowLen, uGlowPos.y), uGlowPos.z);
  vec3 toF = fp - vWorld;
  float gd = length(toF);
  float gk = 1.0 / (1.0 + pow(gd / uGlowRadius, 2.0));
  // steam is translucent: a fire inside the cloud shows through its near side too, strongest on the faces toward it
  float gl = mix(0.55, 1.0, clamp(dot(n, mat3(viewMatrix) * toF / max(gd, 1e-3)) * 0.5 + 0.5, 0.0, 1.0));
  col += uColor * uGlowColor * gk * (0.3 + 0.7 * gk) * gl * mix(0.6, 1.0, ao);
  col += vec3(1.0, 0.5, 0.18) * uEmissive * exp(-vAge * 6.0) * 6.0;
  float fadeIn = smoothstep(0.0, 0.06, vAge);
  float fadeOut = pow(1.0 - vAge, 1.4);
  float ground = smoothstep(uGroundY - vSize * 0.2, uGroundY + vSize * 0.15, vWorld.y + vSize * 0.2);
  float a = dens * uOpacity * fadeIn * fadeOut * ground * uMaster;
  gl_FragColor = vec4(col * a, a);
}
`,
}

/**
 * Re-entry plasma. Physically: a detached bow shock forms ahead of the windward
 * (heat-shield) surfaces; the shock layer is hottest at the stagnation region and
 * the ionised gas flows *around* the hull and streams downstream into a long wake.
 * uFlowL = direction the air moves relative to the ship, in ship-local space.
 */
export const plasmaShader = {
  vertexShader: /* glsl */ `
${LOG_V}
varying vec3 vNormalV;
varying vec3 vViewV;
varying vec3 vLocal;
varying vec3 vNormalL;
void main(){
  vLocal = position;
  vNormalL = normal;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormalV = normalize(normalMatrix * normal);
  vViewV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`,
  fragmentShader: /* glsl */ `
${LOG_F}
${NOISE_GLSL}
uniform float uTime;
uniform float uIntensity;
uniform float uMode;   // 0 = shock layer around the hull, 1 = downstream wake
uniform vec3 uFlowL;
varying vec3 vNormalV;
varying vec3 vViewV;
varying vec3 vLocal;
varying vec3 vNormalL;
void main(){
  #include <logdepthbuf_fragment>
  if (uIntensity <= 0.001) discard;
  float facing = abs(dot(normalize(vNormalV), normalize(vViewV)));
  vec3 flow = normalize(uFlowL);
  // Mars' CO2 shock layer: white-yellow at stagnation (hot CO/C2 + incandescent surfaces),
  // orange as it cools around the hull, a dull red with a faint blue CO glow in the far wake
  // (not the pink-violet of nitrogen/oxygen air)
  vec3 core = vec3(1.0, 0.9, 0.74);
  vec3 hot = vec3(1.0, 0.6, 0.3);
  vec3 pink = vec3(0.85, 0.42, 0.26);
  vec3 violet = vec3(0.42, 0.4, 0.62);
  float I;
  vec3 col;
  if (uMode < 0.5) {
    float into = -dot(normalize(vNormalL), flow);           // 1 where the surface faces the oncoming air
    float stag = pow(clamp(into, 0.0, 1.0), 2.2);
    float side = smoothstep(-0.25, 0.35, into) * (1.0 - stag);
    // turbulence advected *with* the flow (never forward)
    vec3 adv = vLocal * 0.12 - flow * uTime * 6.0;
    float n = snoise(adv) * 0.5 + snoise(adv * 2.7 + 3.0) * 0.25;
    float rim = pow(1.0 - facing, 1.3) * smoothstep(-0.4, 0.2, into);
    I = (stag * 2.2 + side * (0.25 + 0.35 * n) + rim * 0.35) * uIntensity;
    col = mix(pink, hot, clamp(stag * 1.4 + n * 0.3, 0.0, 1.0));
    col = mix(col, core, stag * stag);
  } else {
    // wake cone: local +Z is downstream
    float along = clamp(vLocal.z / 260.0, 0.0, 1.0);
    float ang = atan(vLocal.y, vLocal.x);
    float streak = snoise(vec3(ang * 3.0, along * 2.5 - uTime * 3.5, uTime * 0.5)) * 0.5 + 0.5;
    streak = pow(streak, 2.2);
    float head = smoothstep(0.02, 0.16, along);
    I = pow(facing, 1.4) * pow(1.0 - along, 1.6) * head * (0.25 + streak) * uIntensity * 1.1;
    col = mix(hot, mix(pink, violet, along), smoothstep(0.0, 0.4, along));
  }
  gl_FragColor = vec4(col * I, 1.0);
}
`,
}

/** Hot, soft billboard glow (engine cluster, impingement, sun core). */
export const glowSpriteShader = {
  vertexShader: /* glsl */ `
${LOG_V}
uniform float uSize;
varying vec2 vUv;
void main(){
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  mv.xy += (uv - 0.5) * uSize;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`,
  fragmentShader: /* glsl */ `
${LOG_F}
uniform vec3 uColor;
uniform float uIntensity;
uniform float uFalloff;
varying vec2 vUv;
void main(){
  #include <logdepthbuf_fragment>
  if (uIntensity <= 0.001) discard;
  float d = length(vUv - 0.5) * 2.0;
  float g = exp(-d * d * uFalloff) * (1.0 - smoothstep(0.85, 1.0, d));
  gl_FragColor = vec4(uColor * g * uIntensity, 1.0);
}
`,
}
