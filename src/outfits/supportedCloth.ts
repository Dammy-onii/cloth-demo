import type { TrouserClearance } from './trouserClearance'
import type { TorsoClearance } from './torsoClearance'
import type { SleeveClearance } from './sleeveClearance'
import type { LayerClearance } from './layerClearance'
import type { SkirtClearance } from './skirtClearance'
import type { Garment } from '../cloth/buildGarment'
import type { Fabric } from '../cloth/garmentSpec'
import { ClothSim, type BodyCollider } from '../cloth/xpbd'
import { vertexAdjacency, walkToNearest } from '../math/mesh'

/** Preview-only stays at waistbands and shoulder seams. The shared solver is unchanged. Long
 * open fronts need support in the tangent plane as well as the solver's vertical band tether. */
export class SupportedCloth extends ClothSim {
  private readonly supported: Float32Array
  private readonly offsets: Float32Array
  private readonly restNormals: Float32Array
  private supportClock = 0
  private readonly near: Uint32Array
  private readonly neckline: number
  private readonly seamGroups: number[][]
  private readonly neighbors: ReturnType<typeof vertexAdjacency>
  private readonly relaxed: Float32Array
  private readonly edgeLimits: Float32Array

  constructor(private readonly cut: Garment, fabric: Fabric, restBody: Float32Array, restNormals: Float32Array, private readonly support: 'coat' | 'waist' | 'inner' | 'tailored' | 'standard', private readonly skirt?: { clearance: SkirtClearance; hipY: number }, private readonly layers?: LayerClearance, private readonly sleeves?: SleeveClearance, private readonly torso?: TorsoClearance, private readonly trousers?: TrouserClearance, private readonly quickFit = false) {
    const g = cut
    super(g, fabric)
    this.supported = new Float32Array(this.x.length)
    this.relaxed = new Float32Array(this.x.length)
    this.neighbors = vertexAdjacency(g.index, g.src.length)
    const { start, adj } = this.neighbors
    this.edgeLimits = new Float32Array(adj.length)
    const flat = g.flat ?? g.rest
    for (let v = 0; v < g.src.length; v++) for (let a = start[v]; a < start[v + 1]; a++) {
      const i = v * 3, j = adj[a] * 3
      const cutLength = Math.hypot(flat[i] - flat[j], flat[i + 1] - flat[j + 1], flat[i + 2] - flat[j + 2])
      const fittedLength = Math.hypot(g.rest[i] - g.rest[j], g.rest[i + 1] - g.rest[j + 1], g.rest[i + 2] - g.rest[j + 2])
      this.edgeLimits[a] = Math.max(cutLength * 1.45, fittedLength * 1.18) + 0.004
    }
    this.offsets = new Float32Array(this.x.length)
    this.restNormals = restNormals
    this.near = g.src.slice()
    let high = 0
    for (let i = 1; i < g.rest.length; i += 3) high = Math.max(high, g.rest[i])
    this.neckline = high
    // A shoulder corner can belong to three pieces. Weld the full group at once so closing
    // the armhole cannot reopen the side or shoulder seam.
    const parent = new Map<number, number>()
    const root = (vertex: number): number => {
      const next = parent.get(vertex)
      if (next === undefined || next === vertex) return vertex
      const head = root(next)
      parent.set(vertex, head)
      return head
    }
    for (let i = 0; i < (g.seams?.length ?? 0); i += 2) {
      const a = g.seams![i], b = g.seams![i + 1]
      if (!parent.has(a)) parent.set(a, a)
      if (!parent.has(b)) parent.set(b, b)
      parent.set(root(b), root(a))
    }
    const groups = new Map<number, number[]>()
    for (const vertex of parent.keys()) {
      const key = root(vertex)
      const group = groups.get(key) ?? []
      group.push(vertex)
      groups.set(key, group)
    }
    this.seamGroups = [...groups.values()].filter(group => group.length > 1)
    g.src.forEach((b, i) => { for (let k = 0; k < 3; k++) this.offsets[i * 3 + k] = g.rest[i * 3 + k] - restBody[b * 3 + k] })
  }

  followTarget?: Float32Array
  private frames = 0

  override wake() {
    super.wake()
    this.frames = 0
  }

  override carry(before: Float32Array, after: Float32Array, beforeNormals: Float32Array, afterNormals: Float32Array) {
    if (!this.followTarget || !this.skirt || !this.quickFit) {
      super.carry(before, after, beforeNormals, afterNormals)
      return
    }
    // Share the sideways movement across each gore so two neighbouring
    // vertices attached to different thighs do not form a ridge.
    this.relaxed.set(this.x)
    super.carry(before, after, beforeNormals, afterNormals)
    this.supported.set(this.x)
    const { start, adj } = this.neighbors
    for (let v = 0; v < this.cut.src.length; v++) {
      const count = start[v + 1] - start[v]
      if (!count || this.cut.band?.[v]) continue
      for (const axis of [0, 2]) {
        const i = v * 3 + axis
        let sum = 0
        for (let a = start[v]; a < start[v + 1]; a++) {
          const j = adj[a] * 3 + axis
          sum += this.x[j] - this.relaxed[j]
        }
        this.supported[i] = this.x[i] * 0.25 + (this.relaxed[i] + sum / count) * 0.75
      }
    }
    this.blendTo(this.supported, 1)
  }

  override step(dt: number, body: BodyCollider) {
    if (!(dt > 0) || this.frozen) return
    if (this.followTarget) {
      // Stage carries the visible particles each frame. Collision constraints
      // from the previous pose would pull them back towards the old sleeves.
      this.supported.set(this.x)
      if (this.skirt && this.quickFit) {
        // The gores hang from the waist. A moving knee should not pull the
        // nearest panel up and bunch the hem.
        for (let i = 1; i < this.supported.length; i += 3) this.supported[i] = this.cut.rest[i]
      }
      this.weldSeams()
      this.blendTo(this.supported, 1)
      const target = this.followTarget
      this.frozen = body.positions.every((value, i) => Math.abs(value - target[i]) < 1e-6)
      return
    }
    if (this.skirt && this.quickFit) {
      // The gores are placed in their hanging shape. Close their seams
      // without letting a gravity solve collapse the supported silhouette.
      this.supported.set(this.cut.rest)
      this.weldSeams()
      this.blendTo(this.supported, 1)
      this.frozen = true
      return
    }
    // Use a fixed simulation step so the sewing ramp finishes in the same number of passes.
    const step = 1 / 30
    super.step(step, body)
    this.supportClock += step
    this.supported.set(this.x)
    for (let i = 0; i < this.cut.src.length; i++) {
      const b = this.cut.src[i] * 3, p = i * 3
      let x = this.offsets[p], y = this.offsets[p + 1], z = this.offsets[p + 2]
      if (!this.cut.noTurn?.[i]) {
        const ax = this.restNormals[b], ay = this.restNormals[b + 1], az = this.restNormals[b + 2]
        const bx = body.normals[b], by = body.normals[b + 1], bz = body.normals[b + 2]
        const kx = ay * bz - az * by, ky = az * bx - ax * bz, kz = ax * by - ay * bx, c = ax * bx + ay * by + az * bz
        if (c > -0.9) {
          const d = (kx * x + ky * y + kz * z) / (1 + c)
          ;[x, y, z] = [c * x + ky * z - kz * y + kx * d, c * y + kz * x - kx * z + ky * d, c * z + kx * y - ky * x + kz * d]
        }
      }
      // Interfaced shoulders and sleeve heads retain their cut. Leave the coat skirt free
      // to drape, and give the maxi skirt no vertical support below the waistband.
      const shoulder = Math.max(0, Math.min(1, (this.cut.rest[p + 1] - this.neckline + 0.42) / 0.19))
      const tailoring = this.support === 'inner' && !this.cut.noTurn?.[i] ? 0.88 : this.sleeves ? 0.16 + shoulder * 0.62 : 0.12
      const weight = this.cut.band?.[i] ? (this.sleeves && this.support !== 'inner' ? 0.9 : 0.5)
        : this.support === 'waist' ? 0.24 : tailoring
      const offset = [x, y, z]
      for (let k = 0; k < 3; k++) {
        if (k === 1 && this.support === 'waist' && !this.cut.band?.[i]) continue
        this.supported[p + k] += (body.positions[b + k] + offset[k] - this.supported[p + k]) * weight
      }
    }
    // Facings resist collapse in this isolated preview. Close the sewn pairs after the support
    // correction so it cannot reopen their initial placement gap.
    const seams = this.cut.seams
    if (seams) for (let s = 0; s < seams.length; s += 2) for (let k = 0; k < 3; k++) {
      const a = seams[s] * 3 + k, b = seams[s + 1] * 3 + k
      const delta = (this.supported[b] - this.supported[a]) * 0.5 * Math.min(1, this.supportClock / (this.quickFit ? 0.24 : 0.8))
      this.supported[a] += delta; this.supported[b] -= delta
    }
    // The ellipse used for initial placement can lie inside a full bust. Support must not undo
    // body collision; project its correction back outside the skin and the inner-layer envelope.
    for (let i = 0; i < this.near.length; i++) {
      const p = i * 3, b = walkToNearest(body.positions, body.adjacency, this.near[i], this.supported[p], this.supported[p + 1], this.supported[p + 2])
      this.near[i] = b
      if (this.cut.ignore?.[b] && (!this.cut.ignoreOnly || this.cut.ignoreOnly[i])) continue
      const s = b * 3
      let depth = 0
      for (let k = 0; k < 3; k++) depth += (this.supported[p + k] - body.positions[s + k]) * body.normals[s + k]
      const push = 0.005 + (this.cut.lift?.[b] ?? 0) - depth
      if (push > 0) for (let k = 0; k < 3; k++) this.supported[p + k] += body.normals[s + k] * push
    }
    if (this.layers && this.cut.noTurn) this.layers.project(this.supported, this.cut.rest, this.cut.noTurn)
    if (this.sleeves || this.support === 'tailored' || this.support === 'inner') for (let i = 0; i < this.cut.src.length; i++) {
      const panel = this.cut.noTurn?.[i]
      if (panel && this.support !== 'coat' && this.support !== 'tailored' && this.support !== 'inner') continue
      const p = i * 3
      if (panel && (this.support === 'coat' || this.support === 'tailored')) {
        // The hem hangs from the shoulders. A close elbow can push it sideways,
        // but cannot carry half the coat up with it.
        const y = this.cut.rest[p + 1]
        this.supported[p + 1] = Math.max(y - 0.06, Math.min(y + (this.support === 'coat' ? 0.05 : 0.035), this.supported[p + 1]))
        continue
      }
      const dx = this.supported[p] - this.cut.rest[p]
      const dy = this.supported[p + 1] - this.cut.rest[p + 1]
      const dz = this.supported[p + 2] - this.cut.rest[p + 2]
      const displacement = Math.hypot(dx, dy, dz)
      const maxTravel = this.support === 'inner' && !panel ? 0.018 : 0.045
      if (displacement <= maxTravel) continue
      const limit = maxTravel / displacement
      this.supported[p] = this.cut.rest[p] + dx * limit
      this.supported[p + 1] = this.cut.rest[p + 1] + dy * limit
      this.supported[p + 2] = this.cut.rest[p + 2] + dz * limit
    }
    // Smooth displacement rather than the cut itself, so a collision spike relaxes
    // across its neighbors while the intended pleats, lapel roll and seams survive.
    const { start, adj } = this.neighbors
    const rest = this.cut.rest
    this.relaxed.set(this.supported)
    for (let v = 0; v < this.cut.src.length; v++) {
      const count = start[v + 1] - start[v]
      if (this.trousers || !count || this.cut.band?.[v]) continue
      for (let axis = 0; axis < 3; axis++) {
        const i = v * 3 + axis
        let sum = 0
        for (let a = start[v]; a < start[v + 1]; a++) {
          const n = adj[a] * 3 + axis
          sum += this.supported[n] - rest[n]
        }
        const amount = this.skirt && axis === 1 ? 0.48 : 0.30
        this.relaxed[i] += amount * (rest[i] + sum / count - this.supported[i])
      }
    }
    this.supported.set(this.relaxed)
    this.trousers?.project(this.supported, rest)
    this.sleeves?.project(this.supported, this.cut)
    if (this.torso && this.cut.noTurn) this.torso.project(this.supported, this.cut.noTurn)
    if (this.skirt) this.skirt.clearance.project(this.supported, body.positions, this.skirt.hipY)
    // The contact pass can stretch a triangle after XPBD has finished. Share only
    // that excess along the seam or panel instead of leaving a sharp spike.
    for (let v = 0; v < this.cut.src.length; v++) for (let a = start[v]; a < start[v + 1]; a++) {
      const neighbor = adj[a]
      if (neighbor <= v) continue
      const i = v * 3, j = neighbor * 3
      const dx = this.supported[j] - this.supported[i]
      const dy = this.supported[j + 1] - this.supported[i + 1]
      const dz = this.supported[j + 2] - this.supported[i + 2]
      const length = Math.hypot(dx, dy, dz)
      if (length <= this.edgeLimits[a]) continue
      const excess = 0.40 * (length - this.edgeLimits[a]) / length
      const left = this.cut.band?.[v] ? 0 : excess
      const right = this.cut.band?.[neighbor] ? 0 : excess
      this.supported[i] += dx * left; this.supported[i + 1] += dy * left; this.supported[i + 2] += dz * left
      this.supported[j] -= dx * right; this.supported[j + 1] -= dy * right; this.supported[j + 2] -= dz * right
    }
    if (this.quickFit && this.support === 'inner') {
      // Keep the knit rim on the measured neck. The torso contact envelope
      // includes the wider shoulder rows and can otherwise lift the rim.
      for (let v = 0; v < this.cut.src.length; v++) {
        const i = v * 3
        if (!this.cut.band?.[v] || rest[i + 1] < this.neckline - 0.012) continue
        for (let k = 0; k < 3; k++) this.supported[i + k] += (rest[i + k] - this.supported[i + k]) * 0.85
      }
    }
    if (this.supportClock >= (this.quickFit ? 0.24 : 0.8)) this.weldSeams()
    // blendTo translates current and previous positions together, avoiding injected velocity.
    this.blendTo(this.supported, 1)
    if (++this.frames >= (this.quickFit ? 20 : this.support === 'waist' ? 48 : 34)) this.frozen = true
  }

  private weldSeams() {
    for (const group of this.seamGroups) {
      let x = 0, y = 0, z = 0, outer = group[0], maxRadius = 0
      let panel = false, sleeve = false
      for (const vertex of group) {
        const i = vertex * 3
        x += this.supported[i]; y += this.supported[i + 1]; z += this.supported[i + 2]
        const radius = Math.hypot(this.supported[i], this.supported[i + 2])
        if (radius > maxRadius) { outer = vertex; maxRadius = radius }
        if (this.cut.noTurn?.[vertex]) panel = true
        else sleeve = true
      }
      const n = group.length, out = outer * 3
      // At an armhole use the exterior position when the torso and sleeve collision
      // corrections disagree. Averaging through the arm lets the shirt show again.
      const armhole = this.sleeves && panel && sleeve
      x = armhole ? (x / n + this.supported[out]) * 0.5 : x / n
      z = armhole ? (z / n + this.supported[out + 2]) * 0.5 : z / n
      for (const vertex of group) {
        const i = vertex * 3
        this.supported[i] = x
        this.supported[i + 1] = y / n
        this.supported[i + 2] = z
      }
    }
  }
}
