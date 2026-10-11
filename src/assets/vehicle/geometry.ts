import { BoxGeometry, BufferGeometry, CylinderGeometry, ExtrudeGeometry, LatheGeometry, Matrix4, Quaternion, Shape, TorusGeometry, Vector2, Vector3 } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { VEHICLE } from '../../mission/constants'

/**
 * Parametric geometry for the two-stage vehicle.
 *
 * Conventions (metres): each stage's origin is its engine exit plane, +Y is
 * the flight axis, the heat-shield ("belly", windward) side faces -Z.
 * All geometry is pre-translated into stage-local space so shaders can use
 * the raw `position` attribute for effects like tank frost bands.
 */

export interface EngineSpec {
  exitR: number
  throatR: number
  bellLength: number
}
export const RAPTOR_SL: EngineSpec = { exitR: 0.63, throatR: 0.2, bellLength: 1.6 }
export const RAPTOR_SL_BOOSTER: EngineSpec = { exitR: 0.59, throatR: 0.19, bellLength: 1.55 }
export const RAPTOR_VAC: EngineSpec = { exitR: 1.15, throatR: 0.2, bellLength: 3.3 }

export interface EngineSlot {
  x: number
  z: number
  spec: EngineSpec
  /** plume group this engine feeds */
  group: 'booster' | 'boostback' | 'shipSL' | 'shipVac'
  /** exit-plane height in stage coordinates (default -0.15) */
  y?: number
}

const polar = (r: number, deg: number): [number, number] => [r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180)]

export function boosterEngineLayout(): EngineSlot[] {
  const slots: EngineSlot[] = []
  for (let i = 0; i < 3; i++) {
    const [x, z] = polar(1.05, 90 + i * 120)
    slots.push({ x, z, spec: RAPTOR_SL_BOOSTER, group: 'boostback' })
  }
  for (let i = 0; i < 10; i++) {
    const [x, z] = polar(2.45, i * 36 + 18)
    slots.push({ x, z, spec: RAPTOR_SL_BOOSTER, group: 'boostback' })
  }
  for (let i = 0; i < 20; i++) {
    const [x, z] = polar(3.8, i * 18)
    slots.push({ x, z, spec: RAPTOR_SL_BOOSTER, group: 'booster' })
  }
  return slots
}

export function shipEngineLayout(): EngineSlot[] {
  const slots: EngineSlot[] = []
  for (let i = 0; i < 3; i++) {
    const [x, z] = polar(1.05, 90 + i * 120)
    slots.push({ x, z, spec: RAPTOR_SL, group: 'shipSL' })
  }
  for (let i = 0; i < 3; i++) {
    const [x, z] = polar(3.0, 30 + i * 120)
    slots.push({ x, z, spec: RAPTOR_VAC, group: 'shipVac' })
  }
  return slots
}

/** Nozzle bell profile (lathe), exit plane at y = 0, throat at y = bellLength. */
export function bellGeometry(spec: EngineSpec, inset = 0) {
  const pts: Vector2[] = []
  const N = 28
  for (let i = 0; i <= N; i++) {
    const f = i / N
    const y = spec.bellLength * (1 - f)
    const r = spec.throatR + (spec.exitR - spec.throatR) * (1 - Math.pow(1 - f, 2.3))
    pts.push(new Vector2(Math.max(0.01, r - inset), y))
  }
  // thin exit lip
  pts.push(new Vector2(spec.exitR + 0.03 - inset, 0))
  const g = new LatheGeometry(pts, 40)
  return g
}

/** Combustion chamber, turbopumps, manifolds and plumbing merged into one mesh. */
export function powerheadGeometry(spec: EngineSpec) {
  const L = spec.bellLength
  const parts: BufferGeometry[] = []
  const chamber = new CylinderGeometry(spec.throatR * 1.55, spec.throatR * 1.15, 0.75, 20)
  chamber.translate(0, L + 0.37, 0)
  parts.push(chamber)
  const dome = new CylinderGeometry(0.28, spec.throatR * 1.55, 0.25, 20)
  dome.translate(0, L + 0.87, 0)
  parts.push(dome)
  for (const s of [-1, 1]) {
    const pump = new CylinderGeometry(0.19, 0.17, 0.95, 16)
    pump.translate(s * 0.36, L + 0.85, 0.05)
    parts.push(pump)
    const pipe = new CylinderGeometry(0.07, 0.07, 0.9, 10)
    pipe.rotateZ(s * 0.9)
    pipe.translate(s * 0.22, L + 0.25, 0.15)
    parts.push(pipe)
  }
  const manifold = new TorusGeometry(spec.throatR * 1.9, 0.065, 8, 28)
  manifold.rotateX(Math.PI / 2)
  manifold.translate(0, L - 0.12, 0)
  parts.push(manifold)
  const ring2 = new TorusGeometry(Math.min(spec.exitR * 0.55, 0.5), 0.045, 6, 28)
  ring2.rotateX(Math.PI / 2)
  ring2.translate(0, L * 0.55, 0)
  parts.push(ring2)
  return mergeGeometries(parts.map((p) => p.toNonIndexed()))!
}

/** Tangent-ogive nose profile. */
export function noseProfile(R: number, L: number, tipR = 0.55, n = 40) {
  const rho = (R * R + L * L) / (2 * R)
  const pts: Vector2[] = []
  for (let i = 0; i <= n; i++) {
    const y = (i / n) * L
    let r = Math.sqrt(Math.max(rho * rho - y * y, 0)) + R - rho
    if (r < tipR) r = tipR * Math.cos(((tipR - r) / tipR) * 1.2)
    pts.push(new Vector2(Math.max(r, 0.02), y))
  }
  pts.push(new Vector2(0.001, L + 0.25))
  return pts
}

export function noseRadiusAt(y: number) {
  const R = VEHICLE.radius
  const L = VEHICLE.shipNoseLength
  const rho = (R * R + L * L) / (2 * R)
  return Math.sqrt(Math.max(rho * rho - y * y, 0)) + R - rho
}

/** Flap planform extruded; hinge along local +Y at x = 0, extends toward +X. */
export function flapGeometry(root: number, tip: number, span: number, sweep: number, thickness: number, side: 'windward' | 'leeward') {
  const s = new Shape()
  s.moveTo(0, 0)
  s.lineTo(span * 0.85, sweep)
  s.quadraticCurveTo(span, sweep + 0.1, span, sweep + 0.6)
  s.lineTo(span, sweep + tip - 0.5)
  s.quadraticCurveTo(span, sweep + tip, span * 0.85, sweep + tip + 0.05)
  s.lineTo(0, root)
  s.closePath()
  const g = new ExtrudeGeometry(s, { depth: thickness / 2, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.06, bevelSegments: 2, curveSegments: 8 })
  if (side === 'windward') g.translate(0, 0, -thickness / 2)
  g.computeVertexNormals()
  return g
}

/** A beam (box) spanning from a to b — used by the lattice tower, grid fins and trusses. */
export function beamMatrix(a: Vector3, b: Vector3, w: number, d: number, out = new Matrix4()) {
  const dir = new Vector3().subVectors(b, a)
  const len = dir.length()
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize())
  const mid = new Vector3().addVectors(a, b).multiplyScalar(0.5)
  return out.compose(mid, q, new Vector3(w, len, d))
}

/** Grid fin: frame + diagonal lattice, merged. Lies in XY plane, root edge at x = 0. */
export function gridFinGeometry(width = 3.6, height = 3.2, depth = 0.55, cells = 7) {
  const parts: BufferGeometry[] = []
  const bar = 0.07
  const frame = 0.16
  const addBeam = (ax: number, ay: number, bx: number, by: number, t: number) => {
    const g = new BoxGeometry(1, 1, 1)
    g.applyMatrix4(beamMatrix(new Vector3(ax, ay, 0), new Vector3(bx, by, 0), t, depth))
    parts.push(g.toNonIndexed())
  }
  addBeam(0, 0, width, 0, frame)
  addBeam(0, height, width, height, frame)
  addBeam(0, 0, 0, height, frame)
  addBeam(width, 0, width, height, frame)
  // diagonal lattice clipped to the rectangle
  const step = (width + height) / cells
  for (let k = -cells; k <= cells * 2; k++) {
    for (const dirSign of [1, -1]) {
      // line: y = dirSign * x + c
      const c = k * step * 0.5 - (dirSign < 0 ? 0 : height)
      const pts: [number, number][] = []
      const tryPt = (x: number, y: number) => {
        if (x >= -1e-6 && x <= width + 1e-6 && y >= -1e-6 && y <= height + 1e-6) pts.push([x, y])
      }
      tryPt(0, c)
      tryPt(width, dirSign * width + c)
      tryPt(dirSign * (0 - c), 0)
      tryPt(dirSign * (height - c), height)
      if (pts.length >= 2) {
        pts.sort((p, q) => p[0] - q[0])
        const [p0, p1] = [pts[0], pts[pts.length - 1]]
        if (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) > 0.2) addBeam(p0[0], p0[1], p1[0], p1[1], bar)
      }
    }
  }
  return mergeGeometries(parts)!
}
