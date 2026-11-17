// Fit Anny's face controls to the face in a photo. The model's face is turned as the photo's head is turned,
// and its landmarks (the head vertices MediaPipe's 478 points land on: public/models/face-map-*.json) are
// compared with the photo's in the picture plane. Then the mix of controls that best closes the gap is
// solved: each control's +1 and −1 shapes are separate amounts in 0..1, held back by a penalty so noise
// and expressions can't push the face out of shape. Depth isn't compared: MediaPipe's per-point depth was
// 12.8 mm off on our own model's render, where x and y were 1.5 mm off.
import type { FaceScan } from '../photo/face'
import type { FaceMorphs, FaceShape } from './morphs'

// What a face-on photo can't show, or isn't face shape: the ears, the back of the skull, and the whole head
// moved on the neck. Fitted, they soaked up noise (the back of the skull was pushed to its limit).
const UNSEEN = /ear|head-back|head-trans|head-angle|head-age/

// lips move with expression (a smile, an open mouth): they count for less than the face's bony structure
const LIPS = new Set([13, 14, 78, 308, 80, 81, 82, 87, 88, 95, 178, 191, 310, 311, 312, 317, 318, 324, 402, 415])

export interface FaceFit {
  face: FaceShape
  /** mean gap between the photo's points and the model's, before and after fitting (m) */
  start: number
  error: number
  /** where each model vertex lands in the photo (pixels), for painting the photo on: [vertex] → [x, y] */
  toPhoto: (p: [number, number, number]) => [number, number]
  /** the camera's estimated distance from the face (m; Infinity: far) */
  distance: number
  /**
   * The rest of the way to the photo: for a head already shaped by the controls (`shaped`, A-pose size M), an
   * offset per morph vertex that moves every landmark exactly onto the photo's point as seen face on, with the
   * surface round each landmark following smoothly and fading out away from the face. The controls alone move
   * features a few millimetres and couldn't make a long, narrow face from a wide one.
   */
  warp: (shaped: Float32Array) => Float32Array
}

/**
 * @param base the body's A-pose positions (the shape the morphs were measured on)
 * @param map for each of the 478 landmarks, the head vertex it lands on (−1: none)
 * @param offsets from that vertex to the landmark itself ([landmark][xyz], m): pinned to the vertex alone,
 *   the model's own face read 2.6 mm off and the fit "corrected" it
 */
export function fitFace(m: FaceMorphs, base: Float32Array, map: Int32Array, offsets: Float32Array, scan: FaceScan, opt: { lambda?: number; sweeps?: number; modelRotation?: number[] } = {}): FaceFit {
  const lambda = opt.lambda ?? 3e-4
  // The photo's head turn relative to the model's own head (MediaPipe reads the model's posture tilt too):
  // R = R_photo · R_modelᵀ. Turned by R_photo alone, the tilt was counted twice and the forehead and skull
  // depth controls bent to make up for it.
  const R = relativeRotation(scan.rotation, opt.modelRotation)
  const S: number[] = []
  for (let j = 0; j < 468; j++) if (map[j] >= 0 && m.row[map[j]] >= 0) S.push(j)
  // The camera's distance from the face (m), estimated: from half a metre a nose looks bigger next to the
  // cheeks than in a flat projection, and fitted flat that read as a deeper skull and a different forehead.
  // The distance that best explains the photo before any shape change is kept.
  // perspective scales about the face's own centre (scaled about the floor, the face 1.5 m up, every finite
  // distance looked wrong and the fit stayed flat)
  const ref = [0, 0, 0]
  S.forEach((j) => { const v = map[j] * 3; for (let a = 0; a < 3; a++) ref[a] += R[a * 3] * base[v] + R[a * 3 + 1] * base[v + 1] + R[a * 3 + 2] * base[v + 2] })
  const [xRef, yRef, zRef] = ref.map((t) => t / S.length)
  let distance = Infinity
  const turn = (x: number, y: number, z: number): [number, number] => {
    const k = Number.isFinite(distance) ? distance / (distance - (R[6] * x + R[7] * y + R[8] * z - zRef)) : 1
    return [xRef + (R[0] * x + R[1] * y + R[2] * z - xRef) * k, yRef + (R[3] * x + R[4] * y + R[5] * z - yRef) * k]
  }
  // the same for an offset (a control's shape) at a landmark: scaled by its landmark's perspective
  const turnAt = (p: [number, number, number], d: [number, number, number]): [number, number] => {
    const k = Number.isFinite(distance) ? distance / (distance - (R[6] * p[0] + R[7] * p[1] + R[8] * p[2] - zRef)) : 1
    return [(R[0] * d[0] + R[1] * d[1] + R[2] * d[2]) * k, (R[3] * d[0] + R[4] * d[1] + R[5] * d[2]) * k]
  }
  const K = m.labels.length, N = m.vertices.length, n = S.length
  const weight = S.map((j) => (LIPS.has(j) ? 0.3 : 1))
  const landmark = (j: number): [number, number, number] => { const v = map[j] * 3, o = j * 3; return [base[v] + offsets[o], base[v + 1] + offsets[o + 1], base[v + 2] + offsets[o + 2]] }
  const photo = new Float32Array(n * 2)
  S.forEach((j, s) => { photo[s * 2] = scan.points[j][0]; photo[s * 2 + 1] = -scan.points[j][1] })
  const gap = (T: Float32Array, M: Float32Array) => { let t = 0; for (let s = 0; s < n; s++) t += Math.hypot(T[s * 2] - M[s * 2], T[s * 2 + 1] - M[s * 2 + 1]); return t / n }
  const neutral = () => { const out = new Float32Array(n * 2); S.forEach((j, s) => { const [x, y] = turn(...landmark(j)); out[s * 2] = x; out[s * 2 + 1] = y }); return out }
  let best = Infinity, bestD = Infinity
  for (const d of [0.3, 0.4, 0.5, 0.65, 0.8, 1, 1.3, 1.7, 2.5, 4, Infinity]) {
    distance = d
    const M = neutral(), g = gap(similarity2D(photo, M, weight).apply(photo), M)
    if (g < best) { best = g; bestD = d }
  }
  distance = bestD
  // the controls' effect at the landmarks, turned with the head and seen face on: columns 2n long
  const cols: Float32Array[] = []
  for (let k = 0; k < K; k++) for (const src of [m.plus, m.minus]) {
    const c = new Float32Array(n * 2)
    if (UNSEEN.test(m.labels[k])) { cols.push(c); continue }
    S.forEach((j, s) => {
      const i = (k * N + m.row[map[j]]) * 3
      const [x, y] = turnAt(landmark(j), [src[i], src[i + 1], src[i + 2]])
      c[s * 2] = x * weight[s]; c[s * 2 + 1] = y * weight[s]
    })
    cols.push(c)
  }
  const norms = cols.map((c) => c.reduce((t, v) => t + v * v, 0))
  const w = new Float32Array(K * 2)
  const model = () => {
    const out = new Float32Array(n * 2)
    S.forEach((j, s) => { const [x, y] = turn(...landmark(j)); out[s * 2] = x; out[s * 2 + 1] = y })
    for (let c = 0; c < cols.length; c++) if (w[c]) for (let i = 0; i < n * 2; i++) out[i] += (w[c] * cols[c][i]) / weight[i >> 1]
    return out
  }
  let start = 0, error = 0, align = similarity2D(photo, model(), weight)
  for (let round = 0; round < 5; round++) {
    const M = model()
    align = similarity2D(photo, M, weight)
    const T = align.apply(photo)
    if (round === 0) start = gap(T, M)
    const r = new Float32Array(n * 2)
    for (let i = 0; i < n * 2; i++) r[i] = (T[i] - M[i]) * weight[i >> 1]
    for (let sweep = 0; sweep < (opt.sweeps ?? 25); sweep++) for (let c = 0; c < cols.length; c++) {
      if (!norms[c]) continue
      const col = cols[c]
      let dot = 0
      for (let i = 0; i < n * 2; i++) dot += col[i] * r[i]
      const next = Math.min(1, Math.max(0, (dot + norms[c] * w[c]) / (norms[c] + lambda)))
      const d = next - w[c]
      if (!d) continue
      for (let i = 0; i < n * 2; i++) r[i] -= d * col[i]
      w[c] = next
    }
    error = gap(align.apply(photo), model())
  }
  const face: FaceShape = { plus: new Float32Array(K), minus: new Float32Array(K) }
  for (let k = 0; k < K; k++) { face.plus[k] = w[k * 2]; face.minus[k] = w[k * 2 + 1] }
  // model point → photo pixel: turn with the head, then undo the photo's alignment
  const inverse = align.invert()
  const toPhoto = (p: [number, number, number]): [number, number] => {
    const [x, y] = turn(p[0], p[1], p[2])
    const q = inverse([x, y])
    return [q[0], -q[1]]
  }
  const target = align.apply(photo)
  const warp = (shaped: Float32Array) => {
    // each landmark's move, in the head's own axes: the face-on gap turned back by the head's rotation
    const at: number[][] = [], move: number[][] = []
    S.forEach((j, s) => {
      const v = map[j] * 3, o = j * 3
      const p: [number, number, number] = [shaped[v] + offsets[o], shaped[v + 1] + offsets[o + 1], shaped[v + 2] + offsets[o + 2]]
      const [x, y] = turn(p[0], p[1], p[2])
      let dx = target[s * 2] - x, dy = target[s * 2 + 1] - y
      // a misread point (hair across the face, a shadow) mustn't drag the surface: at most 1.5 cm
      const l = Math.hypot(dx, dy)
      if (l > 0.015) { dx *= 0.015 / l; dy *= 0.015 / l }
      at.push(p)
      move.push([R[0] * dx + R[3] * dy, R[1] * dx + R[4] * dy, R[2] * dx + R[5] * dy])
    })
    // spread over the surface: a Gaussian average of the nearby landmarks' moves (σ 1.2 cm, about their
    // spacing), full strength where landmarks are dense and none towards the back of the head and the neck
    const out = new Float32Array(N * 3), s2 = 2 * 0.012 ** 2
    m.vertices.forEach((v, i) => {
      let wsum = 0, x = 0, y = 0, z = 0
      for (let k = 0; k < at.length; k++) {
        const d2 = (shaped[v * 3] - at[k][0]) ** 2 + (shaped[v * 3 + 1] - at[k][1]) ** 2 + (shaped[v * 3 + 2] - at[k][2]) ** 2
        if (d2 > 9 * s2) continue
        const w = Math.exp(-d2 / s2)
        wsum += w; x += w * move[k][0]; y += w * move[k][1]; z += w * move[k][2]
      }
      if (wsum < 1e-6) return
      const cover = Math.min(1, wsum / 0.6)
      out[i * 3] = (x / wsum) * cover; out[i * 3 + 1] = (y / wsum) * cover; out[i * 3 + 2] = (z / wsum) * cover
    })
    return out
  }
  return { face, start, error, toPhoto, distance, warp }
}

/** The 2D similarity (scale, turn, shift) taking P onto M, by weighted least squares. */
function similarity2D(P: Float32Array, M: Float32Array, weight: number[]) {
  const n = P.length / 2
  let W = 0, px = 0, py = 0, mx = 0, my = 0
  for (let s = 0; s < n; s++) { W += weight[s]; px += P[s * 2] * weight[s]; py += P[s * 2 + 1] * weight[s]; mx += M[s * 2] * weight[s]; my += M[s * 2 + 1] * weight[s] }
  px /= W; py /= W; mx /= W; my /= W
  let a = 0, b = 0, pp = 0
  for (let s = 0; s < n; s++) {
    const x = P[s * 2] - px, y = P[s * 2 + 1] - py, u = M[s * 2] - mx, v = M[s * 2 + 1] - my
    a += weight[s] * (x * u + y * v); b += weight[s] * (x * v - y * u); pp += weight[s] * (x * x + y * y)
  }
  const ca = a / (pp || 1), sb = b / (pp || 1) // scale·cos and scale·sin
  return {
    apply(Q: Float32Array) {
      const out = new Float32Array(Q.length)
      for (let s = 0; s < Q.length / 2; s++) {
        const x = Q[s * 2] - px, y = Q[s * 2 + 1] - py
        out[s * 2] = mx + ca * x - sb * y; out[s * 2 + 1] = my + sb * x + ca * y
      }
      return out
    },
    invert() {
      const d = ca * ca + sb * sb || 1
      return ([u, v]: [number, number]): [number, number] => {
        const x = u - mx, y = v - my
        return [px + (ca * x + sb * y) / d, py + (-sb * x + ca * y) / d]
      }
    },
  }
}

/** a · bᵀ for row-major 3×3 rotations (b: identity when not given) */
function relativeRotation(a: number[], b?: number[]) {
  if (!b) return a
  const out = new Array(9).fill(0)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i * 3 + j] += a[i * 3 + k] * b[j * 3 + k]
  return out
}
