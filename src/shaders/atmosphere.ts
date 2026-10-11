import { Vector3 } from 'three'
import { EARTH_ATMO_KM, EARTH_RADIUS_KM, MARS_ATMO_KM, MARS_RADIUS_KM } from '../mission/constants'

/**
 * Physically based single-scattering atmosphere (Nishita-style ray march,
 * Rayleigh + Mie with exponential density profiles and planet shadowing).
 *
 * One GLSL implementation is shared by:
 *   - the Earth sky dome seen from the launch pad and during ascent,
 *   - Earth's limb glow + aerial perspective from orbit,
 *   - Mars' dusty butterscotch sky and its thin limb haze.
 * Only the coefficients change — so every view of each planet is consistent.
 *
 * All distances are kilometres.
 */

export interface AtmosphereParams {
  planetR: number
  atmoR: number
  betaR: Vector3 // Rayleigh scattering (1/km)
  betaM: Vector3 // Mie scattering (1/km)
  betaMExt: Vector3 // Mie extinction (1/km)
  hR: number
  hM: number
  g: number
  /** optional per-channel Mie asymmetry (dust: blue scattered into a tighter forward lobe) */
  gRGB?: Vector3
  sunI: number
  /** ozone absorption (1/km), tent profile centred at 25 km */
  betaO?: Vector3
}

export const EARTH_ATMO: AtmosphereParams = {
  planetR: EARTH_RADIUS_KM,
  atmoR: EARTH_RADIUS_KM + EARTH_ATMO_KM,
  betaR: new Vector3(5.802e-3, 13.558e-3, 33.1e-3),
  betaM: new Vector3(3.996e-3, 3.996e-3, 3.996e-3),
  betaMExt: new Vector3(4.44e-3, 4.44e-3, 4.44e-3),
  hR: 8.0,
  hM: 1.2,
  g: 0.8,
  sunI: 22,
  betaO: new Vector3(0.65e-3, 1.881e-3, 0.085e-3),
}

/**
 * Mars: thin CO2 (weak Rayleigh) + suspended iron-oxide dust. The dust absorbs
 * blue and scatters red broadly, but its strong forward peak favours blue near
 * the sun — giving butterscotch daytime skies and famous blue sunsets.
 */
export const MARS_ATMO: AtmosphereParams = {
  planetR: MARS_RADIUS_KM,
  atmoR: MARS_RADIUS_KM + MARS_ATMO_KM,
  betaR: new Vector3(0.19e-3, 0.44e-3, 1.02e-3),
  betaM: new Vector3(0.066, 0.043, 0.028),
  betaMExt: new Vector3(0.075, 0.062, 0.058),
  hR: 11.1,
  hM: 8.0,
  g: 0.72,
  // Martian dust (r_eff ~1.5 µm) sends blue into a narrow forward lobe and red broadly (Lemmon et al.):
  // same total scattering per channel, but a blue aureole round the sun — the blue Martian sunset
  gRGB: new Vector3(0.68, 0.73, 0.8),
  // photographic calibration: rover images show the dusty sky about as bright as the lit ground
  sunI: 30,
}

export function atmosphereUniforms(p: AtmosphereParams) {
  return {
    uPlanetR: { value: p.planetR },
    uAtmoR: { value: p.atmoR },
    uBetaR: { value: p.betaR.clone() },
    uBetaM: { value: p.betaM.clone() },
    uBetaMExt: { value: p.betaMExt.clone() },
    uHR: { value: p.hR },
    uHM: { value: p.hM },
    uMieG: { value: p.g },
    uMieG3: { value: (p.gRGB ?? new Vector3(p.g, p.g, p.g)).clone() },
    uSunI: { value: p.sunI },
    uBetaO: { value: (p.betaO ?? new Vector3()).clone() },
  }
}

export const ATMOSPHERE_GLSL = /* glsl */ `
#ifndef ATMO_STEPS
#define ATMO_STEPS 16
#endif
#ifndef ATMO_LSTEPS
#define ATMO_LSTEPS 6
#endif
uniform float uPlanetR;
uniform float uAtmoR;
uniform vec3 uBetaR;
uniform vec3 uBetaM;
uniform vec3 uBetaMExt;
uniform float uHR;
uniform float uHM;
uniform float uMieG;
uniform vec3 uMieG3;
uniform float uSunI;
uniform vec3 uBetaO;
float ozone(float h){ return max(0.0, 1.0 - abs(h - 25.0) / 15.0); }

vec2 raySphere(vec3 ro, vec3 rd, float r){
  float b=dot(ro,rd); float c=dot(ro,ro)-r*r; float d=b*b-c;
  if(d<0.0) return vec2(1e20,-1e20);
  d=sqrt(d); return vec2(-b-d,-b+d);
}

vec3 opticalDepthToSun3(vec3 p, vec3 sunDir){
  vec2 a=raySphere(p,sunDir,uAtmoR);
  float L=max(a.y,0.0);
  float seg=L/float(ATMO_LSTEPS);
  vec3 od=vec3(0.0);
  for(int j=0;j<ATMO_LSTEPS;j++){
    vec3 q=p+sunDir*(seg*(float(j)+0.5));
    float h=max(length(q)-uPlanetR,0.0);
    od+=vec3(exp(-h/uHR),exp(-h/uHM),ozone(h))*seg;
  }
  return od;
}

/* Soft planet shadow (penumbra) for a point p relative to planet centre. */
float planetShadow(vec3 p, vec3 sunDir){
  float b=dot(p,sunDir);
  if(b>0.0) return 1.0;
  float d=length(p-sunDir*b);
  return smoothstep(uPlanetR*0.997,uPlanetR*1.006,d);
}

/* Colour of sunlight arriving at point p (after atmospheric extinction). */
vec3 sunTransmittance(vec3 p, vec3 sunDir){
  vec3 od=opticalDepthToSun3(p,sunDir);
  return exp(-(uBetaR*od.x+uBetaMExt*od.y+uBetaO*od.z))*planetShadow(p,sunDir);
}

/* In-scattered radiance along ro + rd*t, t in [0, tMax]. ro relative to planet centre. */
vec3 atmoScatter(vec3 ro, vec3 rd, float tMax, vec3 sunDir, out vec3 transmittance){
  transmittance=vec3(1.0);
  vec2 a=raySphere(ro,rd,uAtmoR);
  float t0=max(a.x,0.0);
  float t1=min(a.y,tMax);
  if(t1<=t0) return vec3(0.0);
  float L=t1-t0;
  // inside the atmosphere: concentrate samples near the viewer where density is highest
  bool inside=dot(ro,ro)<uAtmoR*uAtmoR;
  float mu=dot(rd,sunDir);
  float pR=0.0596831*(1.0+mu*mu);
  vec3 g=uMieG3; vec3 g2=g*g;
  vec3 pM=0.1193662*((1.0-g2)*(1.0+mu*mu))/((2.0+g2)*pow(max(1.0+g2-2.0*g*mu,vec3(1e-4)),vec3(1.5)));
  vec3 sR=vec3(0.0); vec3 sM=vec3(0.0); vec3 od=vec3(0.0);
  for(int i=0;i<ATMO_STEPS;i++){
    float x=(float(i)+0.5)/float(ATMO_STEPS);
    float tt, dt;
    if(inside){ tt=t0+L*x*x; dt=L*2.0*x/float(ATMO_STEPS); }
    else { tt=t0+L*x; dt=L/float(ATMO_STEPS); }
    vec3 p=ro+rd*tt;
    float h=max(length(p)-uPlanetR,0.0);
    vec3 dd=vec3(exp(-h/uHR),exp(-h/uHM),ozone(h))*dt;
    od+=dd;
    float sh=planetShadow(p,sunDir);
    if(sh>0.0){
      vec3 odl=opticalDepthToSun3(p,sunDir);
      vec3 tau=uBetaR*(od.x+odl.x)+uBetaMExt*(od.y+odl.y)+uBetaO*(od.z+odl.z);
      vec3 att=exp(-tau)*sh;
      sR+=att*dd.x; sM+=att*dd.y;
    }
  }
  transmittance=exp(-(uBetaR*od.x+uBetaMExt*od.y+uBetaO*od.z));
  return uSunI*(sR*uBetaR*pR+sM*uBetaM*pM);
}
`

// ---------------------------------------------------------------------------
// CPU port (few samples) — used to derive fog / haze colours so that meshes
// using standard materials sit inside the same atmosphere as the sky shader.
// ---------------------------------------------------------------------------
const tmp = new Vector3()
function raySphereJS(ro: Vector3, rd: Vector3, r: number): [number, number] {
  const b = ro.dot(rd)
  const c = ro.dot(ro) - r * r
  let d = b * b - c
  if (d < 0) return [1e20, -1e20]
  d = Math.sqrt(d)
  return [-b - d, -b + d]
}

export function scatterJS(p: AtmosphereParams, ro: Vector3, rd: Vector3, tMax: number, sun: Vector3, out: Vector3) {
  const [a0, a1] = raySphereJS(ro, rd, p.atmoR)
  const t0 = Math.max(a0, 0)
  const t1 = Math.min(a1, tMax)
  out.set(0, 0, 0)
  if (t1 <= t0) return out
  const N = 12
  const L = t1 - t0
  const mu = rd.dot(sun)
  const pR = 0.0596831 * (1 + mu * mu)
  const gs = p.gRGB ? [p.gRGB.x, p.gRGB.y, p.gRGB.z] : [p.g, p.g, p.g]
  const pMc = gs.map((g) => (0.1193662 * ((1 - g * g) * (1 + mu * mu))) / ((2 + g * g) * Math.pow(Math.max(1 + g * g - 2 * g * mu, 1e-4), 1.5)))
  let odR = 0
  let odM = 0
  const sR = [0, 0, 0]
  const sM = [0, 0, 0]
  const bR = [p.betaR.x, p.betaR.y, p.betaR.z]
  const bM = [p.betaM.x, p.betaM.y, p.betaM.z]
  const bE = [p.betaMExt.x, p.betaMExt.y, p.betaMExt.z]
  for (let i = 0; i < N; i++) {
    const x = (i + 0.5) / N
    const tt = t0 + L * x * x
    const dt = (L * 2 * x) / N
    tmp.copy(ro).addScaledVector(rd, tt)
    const h = Math.max(tmp.length() - p.planetR, 0)
    const dR = Math.exp(-h / p.hR) * dt
    const dM = Math.exp(-h / p.hM) * dt
    odR += dR
    odM += dM
    const [, l1] = raySphereJS(tmp, sun, p.atmoR)
    const seg = Math.max(l1, 0) / 4
    let lR = 0
    let lM = 0
    const q = new Vector3()
    for (let j = 0; j < 4; j++) {
      q.copy(tmp).addScaledVector(sun, seg * (j + 0.5))
      const hl = Math.max(q.length() - p.planetR, 0)
      lR += Math.exp(-hl / p.hR) * seg
      lM += Math.exp(-hl / p.hM) * seg
    }
    for (let c = 0; c < 3; c++) {
      const att = Math.exp(-(bR[c] * (odR + lR) + bE[c] * (odM + lM)))
      sR[c] += att * dR
      sM[c] += att * dM
    }
  }
  out.set(
    p.sunI * (sR[0] * bR[0] * pR + sM[0] * bM[0] * pMc[0]),
    p.sunI * (sR[1] * bR[1] * pR + sM[1] * bM[1] * pMc[1]),
    p.sunI * (sR[2] * bR[2] * pR + sM[2] * bM[2] * pMc[2]),
  )
  return out
}

/** Transmittance of sunlight reaching altitude hKm with sun elevation given by `sun` (local up = +Y). */
export function sunColorJS(p: AtmosphereParams, hKm: number, sun: Vector3, out: Vector3) {
  const ro = new Vector3(0, p.planetR + hKm, 0)
  const [, l1] = raySphereJS(ro, sun, p.atmoR)
  const seg = Math.max(l1, 0) / 16
  let lR = 0
  let lM = 0
  const q = new Vector3()
  for (let j = 0; j < 16; j++) {
    q.copy(ro).addScaledVector(sun, seg * (j + 0.5))
    const hl = Math.max(q.length() - p.planetR, 0)
    lR += Math.exp(-hl / p.hR) * seg
    lM += Math.exp(-hl / p.hM) * seg
  }
  out.set(
    Math.exp(-(p.betaR.x * lR + p.betaMExt.x * lM)),
    Math.exp(-(p.betaR.y * lR + p.betaMExt.y * lM)),
    Math.exp(-(p.betaR.z * lR + p.betaMExt.z * lM)),
  )
  return out
}
