// Anny's 129 face controls as morphs (public/models/face-<gender>.*, from tools/anny-export/face_export.py).
// Each control moves the head by one shape for +1 and another for −1, each linear; a face is a mix of them.
import type { BodySet, Gender, Pose, Size } from '../body/bodySet'

export interface FaceMorphs {
  labels: string[]
  /** body vertices the face controls move */
  vertices: Uint32Array
  /** row of each body vertex in the morphs, or −1 */
  row: Int32Array
  /** [control][vertex][xyz] for +1 and for −1, metres, three.js axes */
  plus: Float32Array
  minus: Float32Array
}

const cache = new Map<Gender, Promise<FaceMorphs>>()

export function loadFaceMorphs(gender: Gender, vertexCount: number): Promise<FaceMorphs> {
  if (!cache.has(gender)) cache.set(gender, (async () => {
    const meta = await (await fetch(`/models/face-${gender}.json`)).json() as { labels: string[]; vertices: number[]; scales: [number, number][] }
    const raw = new Int16Array(await (await fetch(`/models/face-${gender}.bin`)).arrayBuffer())
    const K = meta.labels.length, N = meta.vertices.length
    const plus = new Float32Array(K * N * 3), minus = new Float32Array(K * N * 3)
    for (let k = 0; k < K; k++) for (let side = 0; side < 2; side++) {
      const s = meta.scales[k][side], src = (k * 2 + side) * N * 3, dst = side ? minus : plus
      for (let i = 0; i < N * 3; i++) dst[k * N * 3 + i] = raw[src + i] * s
    }
    const row = new Int32Array(vertexCount).fill(-1)
    meta.vertices.forEach((v, i) => (row[v] = i))
    return { labels: meta.labels, vertices: Uint32Array.from(meta.vertices), row, plus, minus }
  })())
  return cache.get(gender)!
}

/** A face: how far each control is pushed each way (0..1.2), as fitted by `fitFace`. */
export interface FaceShape { plus: Float32Array; minus: Float32Array }

/** The head's offset for a face, per morph vertex ([vertex][xyz]). */
export function faceOffset(m: FaceMorphs, face: FaceShape): Float32Array {
  const N = m.vertices.length, out = new Float32Array(N * 3)
  for (let k = 0; k < m.labels.length; k++) {
    const a = face.plus[k], b = face.minus[k]
    if (a) for (let i = 0; i < N * 3; i++) out[i] += a * m.plus[k * N * 3 + i]
    if (b) for (let i = 0; i < N * 3; i++) out[i] += b * m.minus[k * N * 3 + i]
  }
  return out
}

/**
 * The body with this face: every size and pose gets the same head offset (the head barely changes
 * between them). Everything that reads the body (cloth, hair, eyes, brows) follows.
 */
export function withFace(body: BodySet, m: FaceMorphs, offset: Float32Array): BodySet {
  const memo = new Map<string, Float32Array>()
  return {
    ...body,
    positions(size: Size, pose: Pose) {
      const key = `${size}:${pose}`
      if (!memo.has(key)) {
        const p = body.positions(size, pose).slice()
        m.vertices.forEach((v, i) => { p[v * 3] += offset[i * 3]; p[v * 3 + 1] += offset[i * 3 + 1]; p[v * 3 + 2] += offset[i * 3 + 2] })
        memo.set(key, p)
      }
      return memo.get(key)!
    },
  }
}
