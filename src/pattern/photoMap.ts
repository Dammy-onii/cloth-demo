// Print an uploaded photo onto a pattern garment by matching Claude's landmarks in the photo (neck,
// shoulders, waist, hem, sleeve ends) to the same points on the drafted garment. A bounding-box
// projection put the photo's background, or whatever the wearer had on underneath, onto the cloth
// whenever the garment didn't fill the frame (a mirror selfie, a dress worn open over a skirt).
import type { Landmarks, Mark } from '../cloth/garmentSpec'

/** Where the texture was cut from the photo: crop box and full size, in the photo's pixels. */
export interface Crop { x0: number; y0: number; w: number; h: number; W: number; H: number }

/** The same landmarks on the A-pose garment (m). Sleeves run from the shoulder point along `arm`. */
export interface Anchors {
  neckY: number
  shoulderY: number
  shoulderX: number
  waistY: number
  hemY: number
  /** unit direction of the left arm in the front view (x, y) */
  arm: [number, number]
  sleeveLength: number
}

type C = [number, number]
const sub = (a: C, b: C): C => [a[0] - b[0], a[1] - b[1]]
const mul = (a: C, b: C): C => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]]
const div = (a: C, b: C): C => { const d = b[0] * b[0] + b[1] * b[1] || 1; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d] }

/** UVs (0..1 over the cropped texture) for every garment vertex. `sleeve` flags sleeve vertices. */
export function landmarkUV(rest: Float32Array, sleeve: (v: number) => boolean, a: Anchors, m: Landmarks, crop: Crop): Float32Array {
  // photo points in crop pixels (image y down)
  const px = (p: Mark): C => [p[0] * crop.W - crop.x0, p[1] * crop.H - crop.y0]
  const P = { neck: px(m.neck), sL: px(m.shoulderL), sR: px(m.shoulderR), wL: px(m.waistL), wR: px(m.waistR), hL: px(m.hemL), hR: px(m.hemR) }
  const n = rest.length / 3

  // half-widths of the drafted garment at the waist and hem, from the body panels themselves
  const halfAt = (y: number) => {
    let w = 0
    for (let v = 0; v < n; v++) if (!sleeve(v) && Math.abs(rest[v * 3 + 1] - y) < 0.02) w = Math.max(w, Math.abs(rest[v * 3]))
    return w || a.shoulderX
  }
  const ys3 = [a.hemY, a.waistY, a.shoulderY, a.neckY]
  const hw3 = [halfAt(a.hemY + 0.01), halfAt(a.waistY), a.shoulderX, a.shoulderX]
  const ysP = [(P.hL[1] + P.hR[1]) / 2, (P.wL[1] + P.wR[1]) / 2, (P.sL[1] + P.sR[1]) / 2, P.neck[1]]
  const left = [P.hL[0], P.wL[0], P.sL[0], P.sL[0]], right = [P.hR[0], P.wR[0], P.sR[0], P.sR[0]]
  // piecewise linear in height, carried on past the ends
  const seg = (y: number) => {
    const k = y < ys3[1] ? 0 : y < ys3[2] ? 1 : 2
    return { k, t: (y - ys3[k]) / (ys3[k + 1] - ys3[k] || 1) }
  }
  const lerp = (arr: number[], k: number, t: number) => arr[k] + (arr[k + 1] - arr[k]) * t

  // a sleeve maps by the similarity that takes the 3D shoulder→sleeve-end onto the photo's
  const sleeveMap = (side: 1 | -1) => {
    const mark = side === 1 ? m.sleeveR : m.sleeveL
    if (!mark) return undefined
    const A = side === 1 ? P.sR : P.sL, B = px(mark)
    // 3D in image orientation: x as seen from the front (the body's left is the image's right), y down
    const S: C = [side * a.shoulderX, -a.shoulderY]
    const d: C = [side * a.arm[0] * a.sleeveLength, -a.arm[1] * a.sleeveLength]
    const scale = div(sub(B, A), d)
    return (x: number, y: number): C => { const r = mul(sub([x, -y], S), scale); return [A[0] + r[0], A[1] + r[1]] }
  }
  const sleeves = { [1]: sleeveMap(1), [-1]: sleeveMap(-1) } as Record<number, ReturnType<typeof sleeveMap>>

  const uv = new Float32Array(n * 2)
  for (let v = 0; v < n; v++) {
    const x = rest[v * 3], y = rest[v * 3 + 1]
    let p: C
    const arm = sleeve(v) ? sleeves[x >= 0 ? 1 : -1] : undefined
    if (arm) p = arm(x, y)
    else {
      const { k, t } = seg(y)
      const hw = Math.max(0.02, lerp(hw3, k, t)), L = lerp(left, k, t), R = lerp(right, k, t)
      p = [L + ((x + hw) / (2 * hw)) * (R - L), lerp(ysP, k, t)]
    }
    uv[v * 2] = p[0] / crop.w
    uv[v * 2 + 1] = 1 - p[1] / crop.h
  }
  return uv
}
