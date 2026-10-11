import { ATMOSPHERE_GLSL } from './atmosphere'
import { NOISE_GLSL } from './noise'

/**
 * Sky dome for the surface worlds (Earth launch site, Mars landing site).
 * Uses the same scattering integral as the planets seen from space; the camera
 * altitude drives it, so the sky darkens to black naturally during ascent.
 * Rendered additively over the starfield, so stars emerge as the air thins.
 */
export const skyDomeShader = {
  vertexShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorldPos;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`,
  fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${ATMOSPHERE_GLSL}
${NOISE_GLSL}
uniform vec3 uSunDir;
uniform float uCamAltKm;
uniform vec2 uCamOffKm;      // camera's horizontal offset from the site (km): the dome sits on the curved planet below it
uniform vec3 uGroundAlbedo;
uniform float uSunDisk;
uniform float uExposure;
#ifdef EARTH_GROUND
#ifndef CLOUD_CH
#define CLOUD_CH b
#endif
// the real planet below the horizon: same maps and shading as the globe seen from orbit
uniform sampler2D uDay;
uniform sampler2D uClouds;
uniform mat3 uSiteToObj;
uniform float uGroundE;
uniform float uCloudShift;
vec2 sphereUv(vec3 d){
  return vec2(fract(atan(d.z, -d.x) / 6.2831853), 1.0 - acos(clamp(d.y, -1.0, 1.0)) / 3.1415927);
}
// equirect lookup without the dashed mip seam at the u wrap: wrap the screen-space u derivative too
vec4 texEq(sampler2D t, vec2 uv){
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  dx.x -= floor(dx.x + 0.5);
  dy.x -= floor(dy.x + 0.5);
  return textureGrad(t, uv, dx, dy);
}
#endif
varying vec3 vWorldPos;
void main(){
  #include <logdepthbuf_fragment>
  vec3 rd = normalize(vWorldPos - cameraPosition);
  vec3 ro = normalize(vec3(uCamOffKm.x, uPlanetR, uCamOffKm.y)) * (uPlanetR + max(uCamAltKm, 0.002));
  vec3 L = normalize(uSunDir);
  vec2 ph = raySphere(ro, rd, uPlanetR);
  bool hitGround = ph.x > 0.0;
  float tMax = hitGround ? ph.x : 1e20;
  vec3 trans;
  vec3 col = atmoScatter(ro, rd, tMax, L, trans);
  if (hitGround) {
    vec3 gp = ro + rd * ph.x;
    vec3 gn = normalize(gp);
    float gl = max(dot(gn, L), 0.0);
#ifdef EARTH_GROUND
    vec2 uv = sphereUv(uSiteToObj * gn);
    vec3 alb = texEq(uDay, uv).rgb;
    float cA = pow(clamp(texEq(uClouds, uv + vec2(uCloudShift, 0.0)).CLOUD_CH / 0.82, 0.0, 1.0), 1.25);
    vec3 sunG = sunTransmittance(gn * (uPlanetR + 0.2), L) * uGroundE;
    vec3 gcol = mix(alb * gl, vec3(0.9, 0.91, 0.93) * clamp((dot(gn, L) + 0.35) / 1.35, 0.0, 1.0), cA) * sunG;
    col += gcol * trans;
#else
    col += uGroundAlbedo * sunTransmittance(gp, L) * gl * uSunI * 0.09 * trans;
#endif
  } else {
    // sun disk with limb darkening
    float c = dot(rd, L);
    float r = acos(clamp(c, -1.0, 1.0)) / 0.00465;
    if (r < 1.0) {
      float limb = 1.0 - 0.6 * (1.0 - sqrt(max(1.0 - r * r, 0.0)));
      col += trans * uSunDisk * limb;
    }
  }
  // keep the sun's aureole finite in the half-float buffer (no Inf/NaN rings after the blur passes)
  col = min(col, vec3(500.0));
  gl_FragColor = vec4(col * uExposure, 1.0);
}
`,
}

/** Procedural cumulus deck for the launch site (two stacked sheets = parallax/thickness). */
export const cloudLayerShader = {
  vertexShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorldPos;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`,
  fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
${NOISE_GLSL}
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uHaze;
uniform float uCoverage;
uniform float uTime;
uniform float uLayer;
varying vec3 vWorldPos;
void main(){
  #include <logdepthbuf_fragment>
  vec2 p = vWorldPos.xz * 0.00022 + vec2(uTime * 0.0015, uLayer * 3.1);
  float n = fbm2(p, 6);
  float d = smoothstep(uCoverage, uCoverage + 0.22, n);
  if (d < 0.01) discard;
  // pseudo-thickness lighting: sample toward the sun for self-shadow
  float ns = fbm2(p + uSunDir.xz * 0.02, 5);
  float shade = clamp(0.55 + (n - ns) * 5.0, 0.25, 1.15);
  vec3 col = uSunColor * shade * 0.85 + uAmbient;
  float dist = length(vWorldPos - cameraPosition);
  float haze = 1.0 - exp(-dist * 0.000018);
  col = mix(col, uHaze, haze);
  float fadeFar = 1.0 - smoothstep(60000.0, 110000.0, dist);
  gl_FragColor = vec4(col * d * 0.92 * fadeFar, d * 0.92 * fadeFar);
}
`,
}
