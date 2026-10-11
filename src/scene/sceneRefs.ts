import type { DirectionalLight, HemisphereLight, PointLight, Texture } from 'three'

/**
 * One fixed light rig shared by all worlds. Keeping the light *count* constant
 * means switching worlds never triggers shader recompilation (a common source
 * of mid-experience hitches in three.js).
 */
export const rig = {
  sun: null as DirectionalLight | null,
  hemi: null as HemisphereLight | null,
  engine: null as PointLight | null,
  env: {} as Record<string, Texture>,
}

/** Per-world scale & focus helpers used by the camera and the free-orbit controller. */
export const WORLD_UNITS = {
  earth: { near: 0.5, far: 2.5e6, vehicleDist: 260 },
  space: { near: 0.0003, far: 1e10, vehicleDist: 0.16 },
  mars: { near: 0.3, far: 2.5e6, vehicleDist: 160 },
} as const
