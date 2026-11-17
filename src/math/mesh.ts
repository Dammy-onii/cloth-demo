// Small triangle-mesh helpers on flat typed arrays (xyz interleaved).

/** Area-weighted vertex normals: sum of unnormalised face normals (|n| = 2·area), then normalise. */
export function vertexNormals(pos: Float32Array, index: ArrayLike<number>, out: Float32Array = new Float32Array(pos.length)) {
  out.fill(0)
  for (let f = 0; f < index.length; f += 3) {
    const a = index[f] * 3, b = index[f + 1] * 3, c = index[f + 2] * 3
    const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2]
    const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2]
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x
    for (const v of [a, b, c]) {
      out[v] += nx
      out[v + 1] += ny
      out[v + 2] += nz
    }
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1
    out[i] /= l
    out[i + 1] /= l
    out[i + 2] /= l
  }
  return out
}

const edgeKey = (a: number, b: number) => (a < b ? a * 0x100000 + b : b * 0x100000 + a)

/**
 * Unique edges, plus "bend pairs": for every interior edge (a,b) shared by triangles (a,b,c) and (a,b,d),
 * the pair (c,d). A distance constraint on (c,d) resists folding about the edge — the cheap
 * isometric-bending stand-in commonly used with PBD cloth.
 */
export function edgesAndBendPairs(index: ArrayLike<number>) {
  const opposite = new Map<number, number>()
  const edges: number[] = []
  const bends: number[] = []
  for (let f = 0; f < index.length; f += 3) {
    for (let k = 0; k < 3; k++) {
      const a = index[f + k], b = index[f + ((k + 1) % 3)], c = index[f + ((k + 2) % 3)]
      const key = edgeKey(a, b)
      const other = opposite.get(key)
      if (other === undefined) {
        opposite.set(key, c)
        edges.push(a, b)
      } else if (other >= 0) {
        bends.push(other, c)
        opposite.set(key, -1) // non-manifold edges beyond two faces are ignored
      }
    }
  }
  return { edges: Uint32Array.from(edges), bends: Uint32Array.from(bends) }
}

/** Vertex adjacency in CSR form: neighbours of v are `adj[start[v] .. start[v+1])`. */
export function vertexAdjacency(index: ArrayLike<number>, vertexCount: number) {
  const sets = Array.from({ length: vertexCount }, () => new Set<number>())
  for (let f = 0; f < index.length; f += 3) {
    for (let k = 0; k < 3; k++) {
      const a = index[f + k], b = index[f + ((k + 1) % 3)]
      sets[a].add(b)
      sets[b].add(a)
    }
  }
  const start = new Uint32Array(vertexCount + 1)
  for (let v = 0; v < vertexCount; v++) start[v + 1] = start[v] + sets[v].size
  const adj = new Uint32Array(start[vertexCount])
  sets.forEach((s, v) => adj.set([...s], start[v]))
  return { start, adj }
}

/**
 * Nearest mesh vertex to (x, y, z) by greedy descent over neighbours, starting from `from`.
 * O(walk length); exact on a smooth surface once the start is near, as for cloth particles that
 * move a little per step.
 */
export function walkToNearest(
  pos: Float32Array, { start, adj }: { start: Uint32Array; adj: Uint32Array },
  from: number, x: number, y: number, z: number, maxSteps = 8,
) {
  const d2 = (i: number) => (pos[i * 3] - x) ** 2 + (pos[i * 3 + 1] - y) ** 2 + (pos[i * 3 + 2] - z) ** 2
  let best = from
  let bestD = d2(best)
  for (let improved = true, guard = 0; improved && guard < maxSteps; guard++) {
    improved = false
    for (let k = start[best]; k < start[best + 1]; k++) {
      const d = d2(adj[k])
      if (d < bestD) {
        bestD = d
        best = adj[k]
        improved = true
      }
    }
  }
  return best
}

/**
 * Closed boundary loops (edges used by exactly one face), each as an ordered vertex list.
 * Openings of a cut-out garment: neck, hem, sleeve ends.
 */
export function boundaryLoops(index: ArrayLike<number>): number[][] {
  const count = new Map<number, number>()
  for (let f = 0; f < index.length; f += 3)
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(index[f + k], index[f + ((k + 1) % 3)])
      count.set(key, (count.get(key) ?? 0) + 1)
    }
  const next = new Map<number, number>()
  for (let f = 0; f < index.length; f += 3)
    for (let k = 0; k < 3; k++) {
      const a = index[f + k], b = index[f + ((k + 1) % 3)]
      if (count.get(edgeKey(a, b)) === 1) next.set(a, b) // keeps face winding, so loops are consistently oriented
    }
  const loops: number[][] = []
  const seen = new Set<number>()
  for (const startV of next.keys()) {
    if (seen.has(startV)) continue
    const loop: number[] = []
    let v: number | undefined = startV
    while (v !== undefined && !seen.has(v)) {
      seen.add(v)
      loop.push(v)
      v = next.get(v)
    }
    if (loop.length > 2) loops.push(loop)
  }
  return loops
}

/** Keep only the faces of the largest edge-connected component (drops stray islands after cutting). */
export function largestComponent(index: Uint32Array): Uint32Array {
  const faces = index.length / 3
  const parent = Int32Array.from({ length: faces }, (_, i) => i)
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])))
  const owner = new Map<number, number>()
  for (let f = 0; f < faces; f++) {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(index[f * 3 + k], index[f * 3 + ((k + 1) % 3)])
      const g = owner.get(key)
      if (g === undefined) owner.set(key, f)
      else parent[find(g)] = find(f)
    }
  }
  const counts = new Map<number, number>()
  for (let f = 0; f < faces; f++) counts.set(find(f), (counts.get(find(f)) ?? 0) + 1)
  const biggest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const out: number[] = []
  for (let f = 0; f < faces; f++) if (find(f) === biggest) out.push(index[f * 3], index[f * 3 + 1], index[f * 3 + 2])
  return Uint32Array.from(out)
}
