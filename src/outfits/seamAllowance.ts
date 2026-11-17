import type { Garment } from '../cloth/buildGarment'

/** Render the small strip between sewn panel edges. Collision can separate coincident seam
 * particles; the simulation keeps its original topology, while this allowance closes the view. */
export function seamAllowance(g: Garment): Uint32Array {
  const partners = new Map<number, number[]>()
  for (let i = 0; i < (g.seams?.length ?? 0); i += 2) {
    const a = g.seams![i], b = g.seams![i + 1]
    partners.set(a, [...(partners.get(a) ?? []), b]); partners.set(b, [...(partners.get(b) ?? []), a])
  }
  const key = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`
  const edges = new Map<string, { a: number; b: number; count: number }>()
  for (let i = 0; i < g.index.length; i += 3) for (let j = 0; j < 3; j++) {
    const a = g.index[i + j], b = g.index[i + (j + 1) % 3], k = key(a, b), entry = edges.get(k)
    if (entry) entry.count++; else edges.set(k, { a, b, count: 1 })
  }
  const extra: number[] = [], seen = new Set<string>()
  for (const { a, b, count } of edges.values()) if (count === 1) {
    for (const c of partners.get(a) ?? []) for (const d of partners.get(b) ?? []) {
      if (edges.get(key(c, d))?.count !== 1) continue
      const pair = [key(a, b), key(c, d)].sort().join('/')
      if (seen.has(pair)) continue
      seen.add(pair); extra.push(a, b, d, a, d, c)
    }
  }
  return Uint32Array.from([...g.index, ...extra])
}
