import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { BloomEffect, BlendFunction, Effect, EffectAttribute, EffectComposer, EffectPass, NoiseEffect, RenderPass, VignetteEffect } from 'postprocessing'
import { lighting } from '../mission/lighting'
import { HalfFloatType, Uniform, Vector2, Vector3 } from 'three'
import { QUALITY, runtime, useMission } from '../mission/store'

/**
 * Post stack (rendered HDR → display):
 *   1. Heat haze   — screen-space refraction along the projected exhaust plume
 *   2. Bloom       — mip-chain bloom on HDR highlights only (engines, sun, plasma)
 *   3. Grade       — exposure, ACES filmic tonemap, per-world contrast/tint
 *   4. Vignette + film grain
 * plus a lens pass modelled on real camera glass: lateral chromatic aberration toward
 * the frame edge, and faint aperture ghosts along the axis when the sun is in frame.
 */

class LensEffect extends Effect {
  constructor() {
    super(
      'Lens',
      /* glsl */ `
uniform vec2 uSun;
uniform float uSunOn;
uniform float uCA;
uniform float uAspect;
float hexd(vec2 q){ q = abs(q); return max(q.x * 0.866 + q.y * 0.5, q.y); }
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
  // lateral chromatic aberration grows with the square of the field radius
  vec2 d = uv - 0.5;
  vec2 off = d * dot(d, d) * uCA;
  vec3 c = vec3(texture2D(inputBuffer, uv - off).r, inputColor.g, texture2D(inputBuffer, uv + off).b);
  if (uSunOn > 0.0) {
    // ghosts only when the sun itself is actually visible (not behind a planet or the hull)
    float L = dot(texture2D(inputBuffer, uSun).rgb, vec3(0.3, 0.5, 0.2));
    float k = smoothstep(5.0, 30.0, L) * uSunOn;
    if (k > 0.0) {
      vec2 axis = vec2(0.5) - uSun;
      for (int i = 0; i < 6; i++) {
        float fi = float(i);
        float f = 0.45 + fi * 0.33 + (i > 2 ? 0.15 : 0.0);
        float rad = 0.018 + fract(fi * 0.618) * 0.05;
        vec2 q = uv - (uSun + axis * f);
        q.x *= uAspect;
        float h = hexd(q);
        float disc = smoothstep(rad, rad * 0.82, h) * (0.6 + 0.4 * smoothstep(rad * 0.5, rad, h));
        vec3 tint = mix(vec3(0.55, 0.85, 1.0), vec3(1.0, 0.75, 0.45), fract(fi * 0.41));
        c += tint * disc * k * 0.035;
      }
      // aperture diffraction: a six-bladed iris throws a 6-spike starburst from the sun
      vec2 q = uv - uSun;
      q.x *= uAspect;
      float r = length(q);
      float spikes = 0.0;
      for (int i = 0; i < 3; i++) {
        float a = 0.26 + float(i) * 1.0472;
        vec2 dir = vec2(cos(a), sin(a));
        float along = dot(q, dir);
        float perp = length(q - dir * along);
        spikes += exp(-pow(perp / (0.0012 + 0.006 * abs(along)), 2.0)) * exp(-abs(along) * 5.5);
      }
      c += vec3(1.0, 0.96, 0.9) * spikes * k * 6.0 / (1.0 + r * 30.0);
    }
  }
  outputColor = vec4(c, inputColor.a);
}`,
      {
        attributes: EffectAttribute.CONVOLUTION,
        uniforms: new Map<string, Uniform>([
          ['uSun', new Uniform(new Vector2())],
          ['uSunOn', new Uniform(0)],
          ['uCA', new Uniform(0.004)],
          ['uAspect', new Uniform(1)],
        ]),
      },
    )
  }
}

/**
 * Guard at the head of the chain: one NaN or Inf pixel from any shader (a zero-length vector, a
 * half-float overflow) would be smeared over the whole screen by the bloom mip chain and the
 * tone-mapper turns it black — the frame flashes black. Replace such pixels and clamp to the
 * half-float range before anything blurs them.
 */
class SanitizeEffect extends Effect {
  constructor() {
    super(
      'Sanitize',
      /* glsl */ `
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
  vec3 c = inputColor.rgb;
  float s = abs(c.r) + abs(c.g) + abs(c.b);
  bool bad = any(isnan(c)) || any(isinf(c)) || !(s < 1.0e30);
  c = bad ? vec3(0.0) : clamp(c, vec3(0.0), vec3(6.0e4));
  outputColor = vec4(c, 1.0);
}`,
    )
  }
}

class HeatHazeEffect extends Effect {
  constructor() {
    super(
      'HeatHaze',
      /* glsl */ `
uniform vec2 uA;
uniform vec2 uB;
uniform float uStrength;
uniform float uWidth;
uniform float uAspect;
uniform float uT;
void mainUv(inout vec2 uv){
  if (uStrength <= 0.0) return;
  vec2 ab = uB - uA;
  float h = clamp(dot(uv - uA, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  vec2 d = uv - uA - ab * h;
  d.x *= uAspect;
  float w = uWidth * (0.5 + h * 1.4);
  float m = (1.0 - smoothstep(0.0, w, length(d))) * uStrength * (1.0 - h * 0.6);
  vec2 off = vec2(sin(uv.y * 170.0 - uT * 31.0) + 0.6 * sin(uv.y * 71.0 + uT * 17.0),
                  cos(uv.x * 150.0 + uT * 27.0) + 0.5 * sin(uv.y * 90.0 - uT * 23.0));
  uv += off * 0.0022 * m;
}`,
      {
        uniforms: new Map<string, Uniform>([
          ['uA', new Uniform(new Vector2())],
          ['uB', new Uniform(new Vector2())],
          ['uStrength', new Uniform(0)],
          ['uWidth', new Uniform(0.05)],
          ['uAspect', new Uniform(1)],
          ['uT', new Uniform(0)],
        ]),
      },
    )
  }
}

class GradeEffect extends Effect {
  constructor() {
    super(
      'Grade',
      /* glsl */ `
uniform float uExposure;
uniform float uSaturation;
uniform float uContrast;
uniform vec3 uTint;
uniform vec3 uFade;
uniform float uFadeAmt;
vec3 acesFit(vec3 v){
  // Narkowicz ACES approximation
  v *= 0.6;
  return clamp((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14), 0.0, 1.0);
}
void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor){
  vec3 c = acesFit(inputColor.rgb * uExposure);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  c = clamp((c - 0.18) * uContrast + 0.18, 0.0, 1.0);
  c *= uTint;
  c = mix(c, uFade, uFadeAmt);
  outputColor = vec4(c, inputColor.a);
}`,
      {
        uniforms: new Map<string, Uniform>([
          ['uExposure', new Uniform(1)],
          ['uSaturation', new Uniform(1)],
          ['uContrast', new Uniform(1)],
          ['uTint', new Uniform(new Vector3(1, 1, 1))],
          ['uFade', new Uniform(new Vector3(0, 0, 0))],
          ['uFadeAmt', new Uniform(0)],
        ]),
      },
    )
  }
}

/** Per-world grading: exposure / saturation / contrast / tint. */
const GRADES = {
  earth: { exposure: 0.95, saturation: 0.92, contrast: 1.04, tint: [1.0, 0.99, 0.97] },
  space: { exposure: 1.0, saturation: 1.0, contrast: 1.06, tint: [1.0, 1.0, 1.0] },
  mars: { exposure: 1.05, saturation: 0.95, contrast: 1.05, tint: [1.02, 0.99, 0.95] },
} as const

const tmp = new Vector3()

export function PostFX() {
  const { gl, scene, camera, size } = useThree()
  const quality = useMission((s) => s.quality)
  const q = QUALITY[quality]
  const { composer, haze, grade, lens, noise, bloom } = useMemo(() => {
    const composer = new EffectComposer(gl, { frameBufferType: HalfFloatType, multisampling: quality === 'low' ? 0 : 4 })
    composer.addPass(new RenderPass(scene, camera))
    const haze = new HeatHazeEffect()
    // only true highlights (sun, engines, plasma) bloom: sunlit cloud decks must not veil the frame
    const bloom = new BloomEffect({ mipmapBlur: true, intensity: 0.8, luminanceThreshold: 6, luminanceSmoothing: 0.6, radius: 0.5, levels: 6 })
    const grade = new GradeEffect()
    const vignette = new VignetteEffect({ offset: 0.28, darkness: 0.62 })
    const noise = new NoiseEffect({ premultiply: true, blendFunction: BlendFunction.SCREEN })
    noise.blendMode.opacity.value = 0.045
    const lens = new LensEffect()
    composer.addPass(new EffectPass(camera, new SanitizeEffect()))
    if (q.haze) composer.addPass(new EffectPass(camera, haze))
    composer.addPass(new EffectPass(camera, lens))
    composer.addPass(new EffectPass(camera, bloom, grade, vignette, noise))
    return { composer, haze, grade, lens, noise, bloom }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, scene, camera, quality])

  useEffect(() => {
    composer.setSize(size.width, size.height)
  }, [composer, size])
  useEffect(() => () => composer.dispose(), [composer])

  useFrame((_, dt) => {
    const s = runtime.state
    // ---- heat haze along the dominant plume
    const hu = haze.uniforms
    let strength = 0
    const a = new Vector3()
    const b = new Vector3()
    if (s.world === 'earth' && s.boosterThrottle > 0.02) {
      const axis = tmp.set(0, 1, 0).applyQuaternion(s.stackQuat)
      a.copy(s.stackBase).addScaledVector(axis, -1)
      b.copy(s.stackBase).addScaledVector(axis, -Math.min(70, s.stackBase.y + 5))
      strength = s.boosterThrottle * (1 - s.plumeExpansion)
    } else if (s.world === 'mars' && s.shipThrottleSL > 0.02) {
      const axis = tmp.set(0, 1, 0).applyQuaternion(s.landerQuat)
      a.copy(s.landerBase).addScaledVector(axis, -1)
      b.copy(s.landerBase).addScaledVector(axis, -30)
      strength = s.shipThrottleSL * 0.7
    }
    if (strength > 0) {
      a.project(camera)
      b.project(camera)
      if (a.z < 1 && b.z < 1) {
        hu.get('uA')!.value.set(a.x * 0.5 + 0.5, a.y * 0.5 + 0.5)
        hu.get('uB')!.value.set(b.x * 0.5 + 0.5, b.y * 0.5 + 0.5)
        const len = Math.hypot(a.x - b.x, a.y - b.y)
        hu.get('uWidth')!.value = Math.max(0.01, len * 0.12)
      } else strength = 0
    }
    hu.get('uStrength')!.value = strength
    hu.get('uAspect')!.value = size.width / size.height
    hu.get('uT')!.value = runtime.ambient

    // ---- grade
    const g = GRADES[s.world]
    const gu = grade.uniforms
    const expo = g.exposure * Math.pow(2, runtime.exposureEV)
    gu.get('uExposure')!.value = expo
    // bloom models sensor/lens glare, so it keys off the *exposed* image: a camera stopped down
    // for the sun blooms only the sun, not the whole bright sky around it
    bloom.luminanceMaterial.threshold = 6 / Math.max(expo, 1e-3)
    bloom.luminanceMaterial.smoothing = 0.6 / Math.max(expo, 1e-3)
    gu.get('uSaturation')!.value = g.saturation
    gu.get('uContrast')!.value = g.contrast
    gu.get('uTint')!.value.set(g.tint[0], g.tint[1], g.tint[2])
    gu.get('uFadeAmt')!.value = s.fade
    if (s.fadeColor === 'ember') gu.get('uFade')!.value.set(0.35, 0.12, 0.05)
    else gu.get('uFade')!.value.set(0, 0, 0)

    // ---- lens: sun ghosts when the sun is in frame; sensor grain rises with exposure (gain)
    const lu = lens.uniforms
    const sp = tmp.copy(camera.position).addScaledVector(lighting.sunDir, 1e5).project(camera)
    const onScreen = sp.z < 1 && Math.abs(sp.x) < 1.05 && Math.abs(sp.y) < 1.05
    lu.get('uSunOn')!.value = onScreen ? 1 : 0
    lu.get('uSun')!.value.set(sp.x * 0.5 + 0.5, sp.y * 0.5 + 0.5)
    lu.get('uAspect')!.value = size.width / size.height
    noise.blendMode.opacity.value = 0.035 + 0.022 * Math.max(0, runtime.exposureEV)

    composer.render(dt)
  }, 1)

  return null
}

