// Meshing a flat pattern piece: its outline is resampled edge by edge (so a seam's two sides get
// matching points), the inside is filled with an even, slightly jittered grid, and everything is
// Delaunay-triangulated (Bowyer–Watson) with the triangles outside the outline dropped.

export type P2 = [number, number]

export interface PieceMesh {
  /** 2D points in metres (the pattern's own coordinates: also the texture coordinates) */
  points: P2[]
  triangles: number[]
  /** point indices along each outline edge, start to end (shared corners appear in both) */
  edges: number[][]
}

/**
 * @param outline polygon corners, counter-clockwise; edge k runs corner k → k+1
 * @param counts samples per edge (≥ 1 segments), so seams can be matched
 * @param spacing target interior point spacing (m)
 * @param curves optional bulge per edge: points are pushed sideways by bulge·4t(1−t) (a gentle curve)
 * @param paths optional polyline per edge (the points between its two corners): any shape, such as a
 *   photo's asymmetric hem or a V-neck, while the edge keeps its number for seams
 * @param holes openings inside the piece (cut-outs), each a polygon: no cloth inside, a free edge round it
 */
export function meshPiece(outline: P2[], counts: number[], spacing: number, curves: number[] = [], paths: (P2[] | undefined)[] = [], holes: P2[][] = []): PieceMesh {
  const points: P2[] = []
  const edges: number[][] = []
  const n = outline.length
  const boundary: P2[] = []
  for (let k = 0; k < n; k++) {
    const a = outline[k], b = outline[(k + 1) % n]
    const nx = -(b[1] - a[1]), ny = b[0] - a[0]
    const len = Math.hypot(nx, ny) || 1
    const bulge = curves[k] ?? 0
    const ids: number[] = []
    const path = paths[k] && paths[k]!.length ? [a, ...paths[k]!, b] : undefined
    const along = path && alongPolyline(path)
    for (let i = 0; i <= counts[k]; i++) {
      const t = i / counts[k]
      const off = bulge * 4 * t * (1 - t)
      const p: P2 = along ? along(t) : [a[0] + (b[0] - a[0]) * t + (nx / len) * off, a[1] + (b[1] - a[1]) * t + (ny / len) * off]
      if (i === 0 && k > 0) { ids.push(edges[k - 1][edges[k - 1].length - 1]); continue }
      if (i === counts[k] && k === n - 1) { ids.push(edges[0][0]); continue }
      ids.push(points.length)
      points.push(p)
      boundary.push(p)
    }
    edges.push(ids)
  }
  // each opening's edge, sampled at the mesh spacing
  const rings = holes.filter((h) => h.length >= 3).map((h) => {
    const along = alongPolyline([...h, h[0]]), n = Math.max(6, Math.round(polylineLength([...h, h[0]]) / spacing))
    const ring: P2[] = []
    for (let i = 0; i < n; i++) { const q = along(i / n); ring.push(q); points.push(q) }
    return ring
  })
  const inHole = (p: P2) => rings.some((r) => inside(p, r))
  const nearHole = (p: P2) => rings.some((r) => distanceToOutline(p, r) < spacing * 0.55)
  // interior: a hexagonal grid, jittered a little so Delaunay has no ties, kept off the outline
  const xs = boundary.map((p) => p[0]), ys = boundary.map((p) => p[1])
  const rowH = spacing * 0.866
  let row = 0
  for (let y = Math.min(...ys) + rowH / 2; y < Math.max(...ys); y += rowH, row++)
    for (let x = Math.min(...xs) + (row % 2 ? spacing / 2 : 0); x < Math.max(...xs); x += spacing) {
      const p: P2 = [x + (hash(x, y) - 0.5) * spacing * 0.1, y + (hash(y, x) - 0.5) * spacing * 0.1]
      if (inside(p, boundary) && distanceToOutline(p, boundary) > spacing * 0.55 && !inHole(p) && !nearHole(p)) points.push(p)
    }
  const triangles = delaunay(points).filter((t) => {
    const c: P2 = [(points[t[0]][0] + points[t[1]][0] + points[t[2]][0]) / 3, (points[t[0]][1] + points[t[1]][1] + points[t[2]][1]) / 3]
    return inside(c, boundary) && !inHole(c)
  })
  return { points, triangles: triangles.flat(), edges }
}

/** The point a fraction t of the way along a polyline, by length. */
export function alongPolyline(pts: P2[]) {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  const total = cum[cum.length - 1] || 1
  return (t: number): P2 => {
    const d = Math.max(0, Math.min(1, t)) * total
    let i = 1
    while (i < pts.length - 1 && cum[i] < d) i++
    const u = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1)
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u]
  }
}

export function polylineLength(pts: P2[]) {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return l
}

const hash = (a: number, b: number) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return s - Math.floor(s)
}

function inside(p: P2, poly: P2[]) {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}

function distanceToOutline(p: P2, poly: P2[]) {
  let d = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i]
    const dx = bx - ax, dy = by - ay
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy || 1)))
    d = Math.min(d, Math.hypot(p[0] - ax - dx * t, p[1] - ay - dy * t))
  }
  return d
}

/** Bowyer–Watson Delaunay triangulation of a point set. */
function delaunay(pts: P2[]): [number, number, number][] {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const r = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 10 + 1
  const all: P2[] = [...pts, [cx - r, cy - r], [cx + r, cy - r], [cx, cy + r]]
  const s = pts.length
  type Tri = { v: [number, number, number]; cx: number; cy: number; r2: number }
  const circum = (a: number, b: number, c: number): Tri => {
    const [ax, ay] = all[a], [bx, by] = all[b], [qx, qy] = all[c]
    const d = 2 * (ax * (by - qy) + bx * (qy - ay) + qx * (ay - by))
    const ux = ((ax * ax + ay * ay) * (by - qy) + (bx * bx + by * by) * (qy - ay) + (qx * qx + qy * qy) * (ay - by)) / d
    const uy = ((ax * ax + ay * ay) * (qx - bx) + (bx * bx + by * by) * (ax - qx) + (qx * qx + qy * qy) * (bx - ax)) / d
    return { v: [a, b, c], cx: ux, cy: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 }
  }
  let tris: Tri[] = [circum(s, s + 1, s + 2)]
  for (let i = 0; i < s; i++) {
    const [px, py] = all[i]
    const bad: Tri[] = [], keep: Tri[] = []
    for (const t of tris) ((px - t.cx) ** 2 + (py - t.cy) ** 2 < t.r2 ? bad : keep).push(t)
    // boundary of the cavity: edges of bad triangles not shared with another bad triangle
    const count = new Map<string, [number, number]>()
    const seen = new Map<string, number>()
    for (const t of bad)
      for (let k = 0; k < 3; k++) {
        const a = t.v[k], b = t.v[(k + 1) % 3]
        const key = a < b ? `${a},${b}` : `${b},${a}`
        seen.set(key, (seen.get(key) ?? 0) + 1)
        count.set(key, [a, b])
      }
    tris = keep
    for (const [key, [a, b]] of count) if (seen.get(key) === 1) tris.push(circum(a, b, i))
  }
  return tris.filter((t) => t.v.every((v) => v < s)).map((t) => {
    const [a, b, c] = t.v
    // counter-clockwise
    const cross = (all[b][0] - all[a][0]) * (all[c][1] - all[a][1]) - (all[b][1] - all[a][1]) * (all[c][0] - all[a][0])
    return cross > 0 ? [a, b, c] : [a, c, b]
  })
}
