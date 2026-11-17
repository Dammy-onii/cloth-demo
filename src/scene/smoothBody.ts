// A finer, smoother body for drawing only: each triangle split into four, the new points curved out
// to the surface the vertex normals describe (Phong tessellation). The original vertices stay
// where they are, so the cloth, hair, shoes and eyes, all built on the coarse body, still sit on
// the drawn skin; only silhouettes and shading (knees, collarbones, hands) get smoother.

const ALPHA = 0.75 // how far the new points move towards the curved surface

export class SmoothBody {
  /** the fine mesh's triangles */
  readonly index: Uint32Array
  readonly vertexCount: number
  private readonly edges: Uint32Array

  constructor(coarse: ArrayLike<number>, readonly coarseCount: number) {
    const ids = new Map<number, number>()
    const edges: number[] = []
    const edge = (a: number, b: number) => {
      const key = a < b ? a * coarseCount + b : b * coarseCount + a
      let e = ids.get(key)
      if (e === undefined) {
        e = edges.length / 2
        ids.set(key, e)
        edges.push(a, b)
      }
      return coarseCount + e
    }
    const index: number[] = []
    for (let f = 0; f < coarse.length; f += 3) {
      const a = coarse[f], b = coarse[f + 1], c = coarse[f + 2]
      const ab = edge(a, b), bc = edge(b, c), ca = edge(c, a)
      index.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca)
    }
    this.edges = Uint32Array.from(edges)
    this.index = Uint32Array.from(index)
    this.vertexCount = coarseCount + edges.length / 2
  }

  /** Fine positions from the coarse body and its vertex normals. */
  positions(pos: Float32Array, nrm: Float32Array, out: Float32Array) {
    out.set(pos)
    const e = this.edges, n = this.coarseCount
    for (let i = 0; i < e.length / 2; i++) {
      const a = e[i * 2] * 3, b = e[i * 2 + 1] * 3, o = (n + i) * 3
      const mx = (pos[a] + pos[b]) / 2, my = (pos[a + 1] + pos[b + 1]) / 2, mz = (pos[a + 2] + pos[b + 2]) / 2
      // the midpoint projected onto each end's tangent plane, averaged
      const da = (mx - pos[a]) * nrm[a] + (my - pos[a + 1]) * nrm[a + 1] + (mz - pos[a + 2]) * nrm[a + 2]
      const db = (mx - pos[b]) * nrm[b] + (my - pos[b + 1]) * nrm[b + 1] + (mz - pos[b + 2]) * nrm[b + 2]
      out[o] = mx - ALPHA * 0.5 * (da * nrm[a] + db * nrm[b])
      out[o + 1] = my - ALPHA * 0.5 * (da * nrm[a + 1] + db * nrm[b + 1])
      out[o + 2] = mz - ALPHA * 0.5 * (da * nrm[a + 2] + db * nrm[b + 2])
    }
  }

  /** Fine per-vertex scalars: new points take the average of their edge's ends. */
  scalars(val: Float32Array, out: Float32Array) {
    out.set(val)
    const e = this.edges, n = this.coarseCount
    for (let i = 0; i < e.length / 2; i++) out[n + i] = (val[e[i * 2]] + val[e[i * 2 + 1]]) / 2
  }

  /** Fine per-vertex colours: new points take the average of their edge's ends. */
  colors(col: Float32Array, out: Float32Array) {
    out.set(col)
    const e = this.edges, n = this.coarseCount
    for (let i = 0; i < e.length / 2; i++) {
      const a = e[i * 2] * 3, b = e[i * 2 + 1] * 3, o = (n + i) * 3
      for (let k = 0; k < 3; k++) out[o + k] = (col[a + k] + col[b + k]) / 2
    }
  }
}
