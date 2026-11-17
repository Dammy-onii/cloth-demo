// Extended Position-Based Dynamics cloth (Macklin et al. 2016) with "small steps"
// (Macklin et al. 2019): many substeps, λ reset per substep; a few stretch passes, one bend pass.
//
// Per substep h:   v += g·h;  x* = x + v·h;  bend pass; stretch passes, each followed by collision;  v = (x - x_prev)/h
// Distance constraint C = |xi − xj| − L, compliance α (m/N), α̃ = α/h²:
//   Δλ = −C / (wi + wj + α̃),   Δxi = +wi·Δλ·n,   Δxj = −wj·Δλ·n,   n = (xi − xj)/|xi − xj|

import { edgesAndBendPairs, walkToNearest } from '../math/mesh'
import type { Garment } from './buildGarment'
import { FABRIC, type Fabric } from './garmentSpec'

export interface BodyCollider {
  positions: Float32Array
  normals: Float32Array
  adjacency: { start: Uint32Array; adj: Uint32Array }
}

const GRAVITY = -9.81
const SUBSTEPS = 16
// Stretch passes per substep. With one, the stretch constraints never converged under the shirt's
// weight: the neckline opened ~47%, the top slid 4 cm down the neck while the hem held, and the
// slack bunched into pinches under a full bust. Eight bring the neckline to ~7%.
const STRETCH_ITERATIONS = 8
const COLLISION_MARGIN = 0.004
const FRICTION = 0.35
// pattern garments: how long the seams take to pull closed after the pieces are placed (s)
const SEW_SECONDS = 0.8
// rest length of an elastic band's edges relative to the cut (a waistband grips 10% under its size)
const ELASTIC_BAND = 0.9
// Per-substep pull of each band particle towards the height of the skin point it was cut over, like
// belt loops. Collision projected last always wins over band tension, so on wide hips (male XL) an
// elastic band alone was forced 17% open and slid down; friction on a real body does this job.
const BAND_TETHER = 0.05

export class ClothSim {
  readonly x: Float32Array
  private readonly prev: Float32Array
  private readonly v: Float32Array
  private readonly edges: Uint32Array
  private readonly edgeRest: Float32Array
  private readonly bends: Uint32Array
  private readonly bendRest: Float32Array
  /** Nearest body vertex per particle, refined by walking the body mesh each substep */
  private readonly nearest: Uint32Array
  /** Band particles and the body vertex each is tethered to */
  private readonly tethers: [number, number][] = []
  private gripOffset?: Float32Array
  private readonly params: (typeof FABRIC)[Fabric]
  private readonly meanEdge: number
  private readonly meanBend: number
  /** seam pairs, and their gap when the pieces were placed */
  private readonly seams: Uint32Array
  private readonly seamStart: Float32Array
  /** time since the garment was put on: seams close over SEW_SECONDS while gravity eases in */
  private sewClock = 0
  private settledFor = 0
  private awakeFor = 0
  frozen = false
  /** the drape has settled enough to look at (it keeps simulating: see the end of step) */
  quiet = false

  constructor(private readonly garment: Garment, fabric: Fabric) {
    this.x = garment.rest.slice()
    this.prev = garment.rest.slice()
    this.v = new Float32Array(this.x.length)
    this.params = FABRIC[fabric]
    const { edges, bends } = edgesAndBendPairs(garment.index)
    this.edges = edges
    this.bends = bends
    // pattern garments rest flat: lengths from the pattern, not from the shape it was placed in
    const shape = garment.flat ?? this.x
    this.edgeRest = restLengths(shape, edges)
    const band = garment.band
    if (band) for (let c = 0; c < this.edgeRest.length; c++) if (band[edges[c * 2]] && band[edges[c * 2 + 1]]) this.edgeRest[c] *= ELASTIC_BAND
    this.bendRest = restLengths(shape, bends)
    this.seams = garment.seams ?? new Uint32Array(0)
    this.seamStart = restLengths(this.x, this.seams)
    if (band) band.forEach((b, i) => b && this.tethers.push([i, garment.src[i]]))
    this.nearest = garment.src.slice()

    this.meanEdge = mean(this.edgeRest)
    this.meanBend = mean(this.bendRest)
  }

  wake() {
    this.frozen = false
    this.quiet = false
    this.settledFor = 0
    this.awakeFor = 0
  }

  /**
   * Carry particles along with the body so size/pose changes don't have to be resolved by
   * collisions alone: each particle keeps its offset from its source skin vertex, turned by the
   * minimal rotation between that vertex's normals before and after (so a sleeve turns with the
   * arm instead of being left sticking out). Moves x and prev together: no velocity. `noTurn`
   * particles only translate: the torso skin by the armpits twists with the arm, and turning a
   * loose shirt panel's 5–10 cm offset with it flung the sides up into the armpits.
   */
  carry(bodyBefore: Float32Array, bodyAfter: Float32Array, normalsBefore: Float32Array, normalsAfter: Float32Array) {
    const { src, noTurn } = this.garment
    for (let i = 0; i < src.length; i++) {
      const s = src[i] * 3
      if (noTurn?.[i]) {
        for (let k = 0; k < 3; k++) {
          const d = bodyAfter[s + k] - bodyBefore[s + k]
          this.x[i * 3 + k] += d
          this.prev[i * 3 + k] += d
        }
        continue
      }
      const ax = normalsBefore[s], ay = normalsBefore[s + 1], az = normalsBefore[s + 2]
      const bx = normalsAfter[s], by = normalsAfter[s + 1], bz = normalsAfter[s + 2]
      // Rodrigues with k = a × b (|k| = sin θ), c = a · b: v' = c·v + k × v + k (k · v) / (1 + c)
      const kx = ay * bz - az * by, ky = az * bx - ax * bz, kz = ax * by - ay * bx
      const c = ax * bx + ay * by + az * bz
      const vx = this.x[i * 3] - bodyBefore[s], vy = this.x[i * 3 + 1] - bodyBefore[s + 1], vz = this.x[i * 3 + 2] - bodyBefore[s + 2]
      const kv = c > -0.9 ? (kx * vx + ky * vy + kz * vz) / (1 + c) : 0
      const r = c > -0.9
        ? [c * vx + ky * vz - kz * vy + kx * kv, c * vy + kz * vx - kx * vz + ky * kv, c * vz + kx * vy - ky * vx + kz * kv]
        : [vx, vy, vz]
      for (let k = 0; k < 3; k++) {
        const d = bodyAfter[s + k] + r[k] - this.x[i * 3 + k]
        this.x[i * 3 + k] += d
        this.prev[i * 3 + k] += d
      }
    }
  }

  /** Move the cloth a fraction `w` of the way to `target`, x and prev together (no velocity). */
  blendTo(target: Float32Array, w: number) {
    for (let i = 0; i < this.x.length; i++) {
      const d = (target[i] - this.x[i]) * w
      this.x[i] += d
      this.prev[i] += d
    }
  }

  step(dt: number, body: BodyCollider) {
    if (this.frozen || !(dt > 0)) return // a zero first-frame dt would make v = 0/0
    // clocks advance by simulated time: a long first frame after page load (seconds) otherwise
    // closed every seam in one jump and flung the sleeves off
    const simDt = Math.min(dt, 1 / 30)
    const h = simDt / SUBSTEPS
    const { x, prev, v } = this
    const n = x.length / 3
    const damping = 1 - this.params.damping
    let maxSpeed = 0
    const sewing = this.seams.length > 0 && this.sewClock < SEW_SECONDS
    const close = Math.max(0, 1 - this.sewClock / SEW_SECONDS)
    const gravity = GRAVITY * (this.seams.length ? Math.min(1, 0.15 + this.sewClock / SEW_SECONDS) : 1)
    for (let s = 0; s < SUBSTEPS; s++) {
      for (let i = 0; i < n; i++) {
        v[i * 3 + 1] += gravity * h
        for (let k = 0; k < 3; k++) {
          prev[i * 3 + k] = x[i * 3 + k]
          x[i * 3 + k] += v[i * 3 + k] * h
        }
      }
      solveDistances(x, this.bends, this.bendRest, this.params.bend / (h * h) / this.meanBend)
      // Collide after every stretch pass, not once at the end: projected last, collisions won and
      // stretched a waistband ~9% as it slid over the hips. The first pass also searches for the
      // nearest skin vertex and applies friction.
      for (let k = 0; k < STRETCH_ITERATIONS; k++) {
        solveDistances(x, this.edges, this.edgeRest, this.params.stretch / (h * h) / this.meanEdge)
        if (this.seams.length) sew(x, this.seams, this.seamStart, close)
        this.collide(body, k === 0, k === 0)
      }
      // gripped cloth keeps the height it first settled at relative to the skin it was cut over
      // (Garment.grip): taken on the first step, then carried with the body through pose changes
      const grip = this.garment.grip
      if (grip) {
        const src = this.garment.src
        if (!this.gripOffset) {
          this.gripOffset = new Float32Array(grip.length)
          for (let i = 0; i < grip.length; i++) this.gripOffset[i] = x[i * 3 + 1] - body.positions[src[i] * 3 + 1]
        }
        for (let i = 0; i < grip.length; i++) {
          if (!grip[i]) continue
          const target = body.positions[src[i] * 3 + 1] + this.gripOffset[i]
          x[i * 3 + 1] += (target - x[i * 3 + 1]) * grip[i]
        }
      }
      for (const [i, b] of this.tethers) {
        const target = body.positions[b * 3 + 1] + body.normals[b * 3 + 1] * this.garment.covers[b]
        x[i * 3 + 1] += (target - x[i * 3 + 1]) * (this.garment.bandTether ?? BAND_TETHER)
      }
      maxSpeed = 0
      for (let i = 0; i < x.length; i++) {
        v[i] = ((x[i] - prev[i]) / h) * damping
        maxSpeed = Math.max(maxSpeed, Math.abs(v[i]))
      }
    }
    // The cloth never freezes: it keeps moving and balancing, as real cloth does. Frozen once it
    // slowed (3 cm/s, or a 6 s cap) it stopped mid-fold and kept those awkward wrinkles. `quiet` only
    // says the drape has settled enough to look at (or for Claude to check).
    this.awakeFor += simDt
    this.sewClock += simDt
    this.settledFor = maxSpeed < 0.02 && !sewing ? this.settledFor + simDt : 0
    this.quiet = this.settledFor > 0.8 || this.awakeFor > 12
  }

  /**
   * Body collision against the skin's nearest vertex + normal (a local signed-distance estimate).
   * The nearest vertex is tracked by greedy descent over body-mesh neighbours: O(1) per particle.
   */
  private collide(body: BodyCollider, search: boolean, friction: boolean) {
    const { x, prev, nearest } = this
    const { positions: bp, normals: bn, adjacency } = body
    const { lift, ignore, ignoreOnly } = this.garment
    const mu = this.garment.friction ?? FRICTION
    for (let i = 0; i < nearest.length; i++) {
      const px = x[i * 3], py = x[i * 3 + 1], pz = x[i * 3 + 2]
      const best = search ? walkToNearest(bp, adjacency, nearest[i], px, py, pz) : nearest[i]
      nearest[i] = best
      if (ignore?.[best] && (!ignoreOnly || ignoreOnly[i])) continue
      const b = best * 3
      const nx = bn[b], ny = bn[b + 1], nz = bn[b + 2]
      const depth = (px - bp[b]) * nx + (py - bp[b + 1]) * ny + (pz - bp[b + 2]) * nz
      // a garment underneath (trousers under a top) adds its thickness to the clearance
      const margin = COLLISION_MARGIN + (lift ? lift[best] : 0)
      if (depth >= margin) continue
      const push = margin - depth
      x[i * 3] += nx * push
      x[i * 3 + 1] += ny * push
      x[i * 3 + 2] += nz * push
      if (!friction) continue
      // Coulomb-ish friction: cancel a fraction of the tangential motion this substep.
      const tx = x[i * 3] - prev[i * 3], ty = x[i * 3 + 1] - prev[i * 3 + 1], tz = x[i * 3 + 2] - prev[i * 3 + 2]
      const tn = tx * nx + ty * ny + tz * nz
      x[i * 3] -= (tx - tn * nx) * mu
      x[i * 3 + 1] -= (ty - tn * ny) * mu
      x[i * 3 + 2] -= (tz - tn * nz) * mu
    }
  }
}

/**
 * A spring of rest length L made of the same material has stiffness k ∝ 1/L, i.e. compliance α ∝ L.
 * `alphaPerLength` is α̃/L̄; scaling by each rest length keeps dense mesh patches (where the body
 * mesh had fine detail) from behaving like a stiffer fabric and puckering.
 */
function solveDistances(x: Float32Array, pairs: Uint32Array, rest: Float32Array, alphaPerLength: number) {
  // Unit masses, so wi = wj = 1.
  for (let c = 0; c < rest.length; c++) {
    const alphaTilde = alphaPerLength * rest[c]
    const a = pairs[c * 2] * 3, b = pairs[c * 2 + 1] * 3
    const dx = x[a] - x[b], dy = x[a + 1] - x[b + 1], dz = x[a + 2] - x[b + 2]
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (len < 1e-9) continue
    const dLambda = -(len - rest[c]) / (2 + alphaTilde)
    const s = dLambda / len
    x[a] += dx * s; x[a + 1] += dy * s; x[a + 2] += dz * s
    x[b] -= dx * s; x[b + 1] -= dy * s; x[b + 2] -= dz * s
  }
}

function mean(a: Float32Array) {
  return a.reduce((s, v) => s + v, 0) / Math.max(1, a.length)
}

/** Pull each seam pair to `close` × its starting gap (0 once sewn), half each way. */
function sew(x: Float32Array, pairs: Uint32Array, start: Float32Array, close: number) {
  for (let c = 0; c < start.length; c++) {
    const a = pairs[c * 2] * 3, b = pairs[c * 2 + 1] * 3
    const dx = x[a] - x[b], dy = x[a + 1] - x[b + 1], dz = x[a + 2] - x[b + 2]
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    const target = start[c] * close
    if (len <= target || len < 1e-9) continue
    const s = (0.5 * (len - target)) / len
    x[a] -= dx * s; x[a + 1] -= dy * s; x[a + 2] -= dz * s
    x[b] += dx * s; x[b + 1] += dy * s; x[b + 2] += dz * s
  }
}

function restLengths(x: Float32Array, pairs: Uint32Array) {
  const out = new Float32Array(pairs.length / 2)
  for (let c = 0; c < out.length; c++) {
    const a = pairs[c * 2] * 3, b = pairs[c * 2 + 1] * 3
    out[c] = Math.hypot(x[a] - x[b], x[a + 1] - x[b + 1], x[a + 2] - x[b + 2])
  }
  return out
}
