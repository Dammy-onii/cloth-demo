// Fabric detail for the garment shader: a woven or knitted surface (a tiling normal map per fabric
// type, sized in metres), and the construction lines of a pattern garment, worked out from its flat
// pieces: a pressed seam with a topstitch beside each sewn edge, and a folded, stitched hem along
// each free edge (hems, necklines, cuffs).

import * as THREE from 'three'
import type { Garment } from '../cloth/buildGarment'
import type { Fabric } from '../cloth/garmentSpec'

/** Weave structure per fabric, and how big one tile of it is (m). */
const WEAVES: Record<Fabric, { kind: 'plain' | 'twill' | 'knit' | 'satin'; tile: number; strength: number }> = {
  cotton: { kind: 'twill', tile: 0.006, strength: 0.55 },
  denim: { kind: 'twill', tile: 0.005, strength: 0.9 },
  linen: { kind: 'plain', tile: 0.007, strength: 0.75 },
  jersey: { kind: 'knit', tile: 0.006, strength: 0.6 },
  // fine, shallow ribs: at 1 cm and full strength the knit broke into moiré stripes at a distance
  knit: { kind: 'knit', tile: 0.006, strength: 0.45 },
  silk: { kind: 'satin', tile: 0.006, strength: 0.18 },
  synthetic: { kind: 'plain', tile: 0.004, strength: 0.35 },
  wool: { kind: 'twill', tile: 0.009, strength: 0.35 },
}

const SIZE = 128
const cache = new Map<string, THREE.DataTexture>()

/** A tiling normal map of the fabric's weave; `repeat` set so one tile is the weave's size in metres. */
export function weaveNormalMap(fabric: Fabric) {
  const w = WEAVES[fabric]
  let tex = cache.get(w.kind)
  if (!tex) {
    const h = new Float32Array(SIZE * SIZE)
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const u = x / SIZE, v = y / SIZE
        h[y * SIZE + x] = height(w.kind, u, v)
      }
    const data = new Uint8Array(SIZE * SIZE * 4)
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const at = (i: number, j: number) => h[((j + SIZE) % SIZE) * SIZE + ((i + SIZE) % SIZE)]
        const dx = (at(x + 1, y) - at(x - 1, y)) * 2, dy = (at(x, y + 1) - at(x, y - 1)) * 2
        const l = Math.hypot(dx, dy, 1)
        const o = (y * SIZE + x) * 4
        data[o] = ((-dx / l) * 0.5 + 0.5) * 255
        data[o + 1] = ((-dy / l) * 0.5 + 0.5) * 255
        data[o + 2] = ((1 / l) * 0.5 + 0.5) * 255
        data[o + 3] = 255
      }
    tex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat)
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.magFilter = THREE.LinearFilter
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.generateMipmaps = true
    tex.anisotropy = 8
    tex.needsUpdate = true
    cache.set(w.kind, tex)
  }
  const t = tex.clone()
  t.repeat.set(1 / w.tile, 1 / w.tile)
  t.needsUpdate = true
  return { map: t, strength: w.strength }
}

/** Thread height (0..1) at (u, v) in one tile of the weave. */
function height(kind: 'plain' | 'twill' | 'knit' | 'satin', u: number, v: number) {
  const threads = 4 // threads across one tile
  const x = u * threads, y = v * threads
  const fx = x - Math.floor(x), fy = y - Math.floor(y)
  const ix = Math.floor(x), iy = Math.floor(y)
  const round = (f: number) => Math.sin(Math.PI * f) // a round thread's cross-section
  if (kind === 'knit') {
    // columns of V-shaped loops (a stocking stitch): each loop two leaning legs
    const col = u * threads * 2, row = v * threads * 3
    const fc = col - Math.floor(col), fr = row - Math.floor(row)
    const lean = (Math.floor(col) % 2 ? 1 : -1) * (fr - 0.5) * 0.6
    return round(Math.min(1, Math.max(0, fc + lean))) * (0.75 + 0.25 * round(fr))
  }
  if (kind === 'satin') return 0.5 + 0.5 * round(fy) * 0.4 + 0.1 * round(fx) // long smooth floats
  // which thread is on top at this crossing: warp (vertical) or weft (horizontal)
  const warpUp = kind === 'twill' ? (ix + iy) % 3 !== 0 : (ix + iy) % 2 === 0
  // the thread on top bulges across its float, the one under barely shows
  return warpUp ? 0.35 + 0.65 * round(fx) * (0.6 + 0.4 * round(fy)) : 0.35 + 0.65 * round(fy) * (0.6 + 0.4 * round(fx))
}

/**
 * Per vertex of a pattern garment: distance (m, in its flat piece) to the nearest sewn edge and to
 * the nearest free edge, for the seams and hems drawn in the shader. Without a flat pattern (a
 * garment cut from the body) both are far.
 */
export function constructionLines(g: Garment) {
  const n = g.rest.length / 3
  const seam = new Float32Array(n).fill(1), hem = new Float32Array(n).fill(1)
  const flat = g.flat
  if (!flat) return { seam, hem }
  // pieces: connected parts of the flat mesh (their flat coordinates overlap one another)
  const parent = Int32Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const idx = g.index
  const count = new Map<number, number>()
  for (let f = 0; f < idx.length; f += 3)
    for (let k = 0; k < 3; k++) {
      const a = idx[f + k], b = idx[f + ((k + 1) % 3)]
      parent[find(a)] = find(b)
      const key = a < b ? a * n + b : b * n + a
      count.set(key, (count.get(key) ?? 0) + 1)
    }
  const sewn = new Uint8Array(n)
  const pairs = g.seams ?? new Uint32Array(0)
  for (let i = 0; i < pairs.length; i++) sewn[pairs[i]] = 1
  // boundary edges, split into sewn and free; their points sampled every ~3 mm
  const seamPts = new Map<number, number[]>(), hemPts = new Map<number, number[]>()
  for (const [key, c] of count) {
    if (c !== 1) continue
    const a = Math.floor(key / n), b = key % n
    const into = sewn[a] && sewn[b] ? seamPts : hemPts
    const piece = find(a)
    if (!into.has(piece)) into.set(piece, [])
    const list = into.get(piece)!
    const ax = flat[a * 3], ay = flat[a * 3 + 1], bx = flat[b * 3], by = flat[b * 3 + 1]
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.003))
    for (let s = 0; s <= steps; s++) list.push(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps)
  }
  for (let v = 0; v < n; v++) {
    const piece = find(v), x = flat[v * 3], y = flat[v * 3 + 1]
    const near = (pts?: number[]) => {
      let d = 1
      if (pts) for (let i = 0; i < pts.length; i += 2) d = Math.min(d, Math.hypot(pts[i] - x, pts[i + 1] - y))
      return d
    }
    seam[v] = near(seamPts.get(piece))
    hem[v] = near(hemPts.get(piece))
  }
  return { seam, hem }
}

/** Shader code for the construction lines (needs attributes seamDist and hemDist, varyings set). */
export const CONSTRUCTION_GLSL = /* glsl */ `
// seams: pressed open, so a shallow valley along the seam with a topstitch 4 mm off it; hems: a
// 2 cm turned-up fold (a crease where it turns), a topstitch line just inside it, and the folded
// edge itself catching the light
float lineAt(float d, float at, float w) { return 1.0 - smoothstep(w * 0.5, w, abs(d - at)); }
// Lines finer than a pixel fade out: at full-body distance a 0.7 mm stitch aliased into jagged
// black-and-white dashes along every hem and seam.
float lineFade(float d, float w) { return 1.0 - smoothstep(w * 0.6, w * 2.0, fwidth(d)); }
float constructionHeight(float seamD, float hemD) {
  float h = -0.6 * (1.0 - smoothstep(0.0, 0.0035, seamD)) * lineFade(seamD, 0.0035);
  h += 0.5 * lineAt(seamD, 0.004, 0.0009) * lineFade(seamD, 0.0009);
  h += (-0.8 * lineAt(hemD, 0.02, 0.0016) + 0.45 * lineAt(hemD, 0.016, 0.0008) * lineFade(hemD, 0.0008)) * lineFade(hemD, 0.0016);
  h += 0.4 * (1.0 - smoothstep(0.0, 0.003, hemD)) * lineFade(hemD, 0.003);
  return h;
}
float stitchMask(float seamD, float hemD) {
  return max(lineAt(seamD, 0.004, 0.0007) * lineFade(seamD, 0.0007), lineAt(hemD, 0.016, 0.0007) * lineFade(hemD, 0.0007));
}`
