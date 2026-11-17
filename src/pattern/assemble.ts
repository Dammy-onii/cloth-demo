// Assemble a pattern garment: mesh each flat piece, place it around the body, and pair up the
// points along each seam so the solver can sew them. The result is a `Garment` the XPBD solver
// drapes like any other, with rest lengths taken from the flat pattern.

import type { Vec3 } from '../body/bodySet'
import type { Garment } from '../cloth/buildGarment'
import { meshPiece, polylineLength, type P2 } from './mesh2d'

export interface Piece {
  name: string
  /** corners, counter-clockwise as seen from outside the garment; edge k runs corner k → k+1 */
  outline: P2[]
  /** sideways bulge per edge (m, positive bulges inward): armholes, sleeve caps, necklines */
  curves?: number[]
  /** per edge, the points between its two corners: an edge of any shape (a photo's hem or neckline) */
  paths?: Record<number, P2[]>
  /** openings inside the piece (cut-outs), as polygons in pattern coordinates */
  holes?: P2[][]
  /** pattern point → its starting position around the body */
  place: (x: number, y: number) => Vec3
  /** passes through the garment's `ignore` body parts (a shirt's body panels through the hands) */
  passThrough?: boolean
  /**
   * body segments its points follow on a pose change (default: any). A shirt's side panels next to
   * the armpit were anchored to the upper arm, and lowering the arms hitched the shirt up.
   */
  anchor?: string[]
  /** carried by translation only on pose changes (loose torso panels; see ClothSim.carry) */
  noTurn?: boolean
  /** distance (m) of a pattern point from the edge a contrast trim runs along, if the piece has one */
  trim?: (x: number, y: number) => number
  /** mesh spacing (m) for this piece only: a fine collar or lapel without paying for a fine coat */
  spacing?: number
  /** negative ease: the cloth's rest width is this fraction narrower than the cut, so it is stretched
   *  round the body (a bodycon knit). Cut to the body exactly, a tight dress sagged and buckled at the waist. */
  stretch?: number
}

/**
 * Sew chain `a` to chain `b`. Each is a continuous path of [piece name, edge index, reversed?]
 * (an edge runs corner k → k+1 unless reversed); which ends meet is matched automatically.
 */
export type Chain = [string, number, boolean?][]
export interface Seam {
  a: Chain
  b: Chain
}

export interface PatternOptions {
  /** target mesh spacing (m) */
  spacing: number
  /** vertices of an elastic band (a waistband), by [piece, edge] */
  band?: [string, number][]
}

/** Body positions and a lookup for the nearest body vertex to any point, optionally among some segments. */
export interface BodyLookup {
  positions: Float32Array
  nearest: (p: Vec3, segments?: string[]) => number
}

export function assemble(pieces: Piece[], seams: Seam[], opt: PatternOptions, body: BodyLookup): Garment {
  const byName = new Map(pieces.map((p, i) => [p.name, i]))
  const edgeLen = (pi: number, e: number) => {
    const p = pieces[pi], a = p.outline[e], b = p.outline[(e + 1) % p.outline.length]
    if (p.paths?.[e]?.length) return polylineLength([a, ...p.paths[e], b])
    const bulge = p.curves?.[e] ?? 0
    const pts: P2[] = []
    for (let i = 0; i <= 16; i++) {
      const t = i / 16
      const nx = -(b[1] - a[1]), ny = b[0] - a[0], l = Math.hypot(nx, ny) || 1
      pts.push([a[0] + (b[0] - a[0]) * t + (nx / l) * bulge * 4 * t * (1 - t), a[1] + (b[1] - a[1]) * t + (ny / l) * bulge * 4 * t * (1 - t)])
    }
    return polylineLength(pts)
  }
  // samples per edge: free edges by length; seam chains share one total, split by length
  const spacing = (pi: number) => pieces[pi].spacing ?? opt.spacing
  const counts = pieces.map((p, pi) => p.outline.map((_, e) => Math.max(1, Math.round(edgeLen(pi, e) / spacing(pi)))))
  const chain = (c: Chain) => c.map(([n, e, r]) => [byName.get(n)!, e, !!r] as [number, number, boolean])
  for (const s of seams) {
    const a = chain(s.a), b = chain(s.b)
    const la = a.map(([p, e]) => edgeLen(p, e)), lb = b.map(([p, e]) => edgeLen(p, e))
    // the finer side sets the stitch count, so a fine collar sews onto a coarse neckline point for point
    const fine = Math.min(...[...a, ...b].map(([pi]) => spacing(pi)))
    const total = Math.max(a.length, b.length, Math.round(Math.max(sum(la), sum(lb)) / fine))
    for (const [c, l] of [[a, la], [b, lb]] as const) split(total, l).forEach((n, i) => (counts[c[i][0]][c[i][1]] = n))
  }

  const rest: number[] = [], flat: number[] = [], uv: number[] = [], index: number[] = [], through: number[] = [], still: number[] = [], trim: number[] = []
  const anchors: (string[] | undefined)[] = []
  const edgeVerts: number[][][] = []
  pieces.forEach((p, pi) => {
    const m = meshPiece(p.outline, counts[pi], spacing(pi), p.curves, p.outline.map((_, e) => p.paths?.[e]), p.holes)
    const base = rest.length / 3
    for (const [x, y] of m.points) {
      rest.push(...p.place(x, y))
      const k = 1 - (p.stretch ?? 0)
      // across only: shrunk lengthwise too, a tube dress rode up off the hips and piled at the waist
      flat.push(x * k, y, 0)
      uv.push(x, y)
      through.push(p.passThrough ? 1 : 0)
      still.push(p.noTurn ? 1 : 0)
      trim.push(p.trim ? p.trim(x, y) : 1)
      anchors.push(p.anchor)
    }
    for (const t of m.triangles) index.push(base + t)
    edgeVerts.push(m.edges.map((e) => e.map((v) => base + v)))
  })

  const pairs: number[] = []
  const pt = (v: number): Vec3 => [rest[v * 3], rest[v * 3 + 1], rest[v * 3 + 2]]
  const d = (a: number, b: number) => Math.hypot(...pt(a).map((q, k) => q - pt(b)[k]))
  for (const s of seams) {
    const run = (c: [number, number, boolean][]) =>
      c.flatMap(([p, e, r], i) => {
        const v = r ? [...edgeVerts[p][e]].reverse() : edgeVerts[p][e]
        return i ? v.slice(1) : v
      })
    const a = run(chain(s.a))
    let b = run(chain(s.b))
    // sew in whichever direction starts out closest over the whole seam: comparing only the ends
    // failed on a sleeve cap, whose two ends meet under the arm, and sewed it on back to front
    const m = Math.min(a.length, b.length)
    let same = 0, flipped = 0
    for (let i = 0; i < m; i++) { same += d(a[i], b[i]); flipped += d(a[i], b[b.length - 1 - i]) }
    if (flipped < same) b = b.reverse()
    for (let i = 0; i < m; i++) pairs.push(a[i], b[i])
  }

  const restArr = Float32Array.from(rest)
  const n = restArr.length / 3
  const src = Uint32Array.from({ length: n }, (_, v) => body.nearest(pt(v), anchors[v]))
  const band = opt.band ? new Uint8Array(n) : undefined
  for (const [name, e] of opt.band ?? []) for (const v of edgeVerts[byName.get(name)!][e]) band![v] = 1
  // clearance a garment worn over this one has to keep: how far this one starts out from the skin
  // (a fixed 1.2 cm let a bottom cut with more ease push out through the top's hem)
  const covers = new Float32Array(body.positions.length / 3)
  src.forEach((v, i) => {
    const d = Math.hypot(restArr[i * 3] - body.positions[v * 3], restArr[i * 3 + 1] - body.positions[v * 3 + 1], restArr[i * 3 + 2] - body.positions[v * 3 + 2])
    covers[v] = Math.max(covers[v], Math.min(0.04, Math.max(PATTERN_CLEARANCE, d)))
  })
  const { faces, frontCount } = splitFrontBack(restArr, index)
  const ignoreOnly = through.some((t) => t) ? Uint8Array.from(through) : undefined
  const noTurn = still.some((t) => t) ? Uint8Array.from(still) : undefined
  const trimDistance = pieces.some((p) => p.trim) ? Float32Array.from(trim) : undefined
  return { rest: restArr, flat: Float32Array.from(flat), seams: Uint32Array.from(pairs), index: faces, frontCount, uv: Float32Array.from(uv), src, covers, band, ignoreOnly, noTurn, trimDistance }
}

/** Skin clearance recorded for a garment worn under another (m) */
const PATTERN_CLEARANCE = 0.012

const sum = (a: number[]) => a.reduce((t, x) => t + x, 0)

/** Split `total` segments over parts proportionally to their lengths, at least 1 each. */
function split(total: number, lengths: number[]) {
  const all = sum(lengths) || 1
  const n = lengths.map((l) => Math.max(1, Math.round((total * l) / all)))
  let diff = total - sum(n)
  for (let i = 0; diff !== 0; i = (i + 1) % n.length) {
    if (diff > 0) { n[i]++; diff-- } else if (n[i] > 1) { n[i]--; diff++ }
  }
  return n
}

function splitFrontBack(rest: Float32Array, faces: number[]) {
  const front: number[] = [], back: number[] = []
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f], b = faces[f + 1], c = faces[f + 2]
    const nz = (rest[b * 3] - rest[a * 3]) * (rest[c * 3 + 1] - rest[a * 3 + 1]) - (rest[b * 3 + 1] - rest[a * 3 + 1]) * (rest[c * 3] - rest[a * 3])
    ;(nz >= 0 ? front : back).push(a, b, c)
  }
  return { faces: Uint32Array.from([...front, ...back]), frontCount: front.length }
}

/** Nearest body vertex by a uniform grid over the body (cells of `cell` m), searched outward. */
export function bodyLookup(positions: Float32Array, labels: Uint8Array, segments: string[], cell = 0.04): BodyLookup {
  const grid = new Map<string, number[]>()
  const key = (i: number, j: number, k: number) => `${i},${j},${k}`
  for (let v = 0; v < positions.length / 3; v++) {
    const k = key(Math.floor(positions[v * 3] / cell), Math.floor(positions[v * 3 + 1] / cell), Math.floor(positions[v * 3 + 2] / cell))
    if (!grid.has(k)) grid.set(k, [])
    grid.get(k)!.push(v)
  }
  return {
    positions,
    nearest: (p, only) => {
      const allow = only?.map((n) => segments.indexOf(n))
      const c = p.map((q) => Math.floor(q / cell))
      let best = 0, bestD = Infinity
      for (let r = 1; r < 12 && bestD === Infinity; r++)
        for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++)
          for (const v of grid.get(key(c[0] + i, c[1] + j, c[2] + k)) ?? []) {
            if (allow && !allow.includes(labels[v])) continue
            const dd = (positions[v * 3] - p[0]) ** 2 + (positions[v * 3 + 1] - p[1]) ** 2 + (positions[v * 3 + 2] - p[2]) ** 2
            if (dd < bestD) { bestD = dd; best = v }
          }
      return best
    },
  }
}
