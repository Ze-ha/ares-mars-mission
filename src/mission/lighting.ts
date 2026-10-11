import { Color, Vector3 } from 'three'

/**
 * Per-frame lighting environment shared by custom shaders (particles, clouds)
 * so they sit in the same light as the PBR meshes. Written by the active world
 * controller, read by effects. Units follow the active world.
 */
export const lighting = {
  sunDir: new Vector3(0, 1, 0),
  sunColor: new Color(1, 1, 1),
  ambient: new Color(0.2, 0.25, 0.3),
  hazeColor: new Color(0.6, 0.7, 0.85),
  /** engine light (orange glow on smoke / pad / hull) */
  glowPos: new Vector3(),
  glowColor: new Color(0, 0, 0),
  glowRadius: 60,
  /** the flame is a line source: glowPos is its top, it runs this far straight down (0 = point) */
  glowLen: 0,
}
