// Paint the user's photo on their fitted face (the toggle in the app), and read their skin tone from it.
// Each face vertex goes through the same fit that shaped the face (FaceFit.toPhoto) to its place in the
// photo; the photo shows fully inside the face outline MediaPipe found, fading out towards its edge and on
// surfaces turned away from the camera, so the neck, ears and hairline keep the model's own skin.
import type { BodySet } from '../body/bodySet'
import { vertexNormals } from '../math/mesh'
import type { FaceScan } from '../photo/face'
import type { FaceFit } from './fit'

// MediaPipe's face outline, round the jaw and over the forehead
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
// the middle of each cheek, for the skin tone
const CHEEKS = [50, 280, 205, 425, 187, 411]

const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t) }

/**
 * Per body vertex: its place in the photo (u, v) and how much of the photo shows (0..1).
 * @param shaped the A-pose positions of size M with the fitted face (what the fit was measured on)
 */
export function facePaint(body: BodySet, shaped: Float32Array, fit: FaceFit, scan: FaceScan): Float32Array {
  const out = new Float32Array(body.vertexCount * 3)
  const outline = OVAL.map((i) => scan.points[i])
  const span = Math.max(...outline.map((p) => p[0])) - Math.min(...outline.map((p) => p[0]))
  const normals = vertexNormals(shaped, body.index)
  const face = ['head', 'neck'].map((n) => body.segment(n))
  for (let v = 0; v < body.vertexCount; v++) {
    if (!face.includes(body.labels[v])) continue
    const p: [number, number, number] = [shaped[v * 3], shaped[v * 3 + 1], shaped[v * 3 + 2]]
    const [x, y] = fit.toPhoto(p)
    // Every head and neck vertex keeps its true place in the photo, painted or not: left at (0, 0), the
    // edge triangles blended their photo coordinates towards the image's corner and drew zigzags of
    // background across the cheeks. Only the weight fades: from 3% inside the outline to 12% in, and
    // on surfaces turning away from the camera.
    const d = signedDistance([x, y], outline)
    out[v * 3] = x / scan.width
    out[v * 3 + 1] = 1 - y / scan.height
    out[v * 3 + 2] = smooth(span * 0.03, span * 0.12, d) * smooth(0.2, 0.5, normals[v * 3 + 2])
  }
  return out
}

/** The skin's colour, averaged over both cheeks in the photo (sRGB hex). */
export function skinTone(image: HTMLCanvasElement | HTMLImageElement, scan: FaceScan): string {
  const c = document.createElement('canvas')
  c.width = scan.width; c.height = scan.height
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(image, 0, 0)
  const span = Math.hypot(scan.points[234][0] - scan.points[454][0], scan.points[234][1] - scan.points[454][1])
  const r = Math.max(2, Math.round(span * 0.04))
  const sum = [0, 0, 0]
  let n = 0
  for (const i of CHEEKS) {
    const [cx, cy] = scan.points[i]
    const d = ctx.getImageData(Math.round(cx - r), Math.round(cy - r), r * 2, r * 2).data
    for (let k = 0; k < d.length; k += 4) { sum[0] += d[k]; sum[1] += d[k + 1]; sum[2] += d[k + 2]; n++ }
  }
  return '#' + sum.map((t) => Math.round(t / Math.max(1, n)).toString(16).padStart(2, '0')).join('')
}

/** Distance (px) from a point to a polygon's edge: positive inside, negative outside. */
function signedDistance(p: [number, number], poly: [number, number][]) {
  let inside = false, d = Infinity
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
    const dx = xi - xj, dy = yi - yj, t = Math.max(0, Math.min(1, ((p[0] - xj) * dx + (p[1] - yj) * dy) / (dx * dx + dy * dy || 1)))
    d = Math.min(d, Math.hypot(p[0] - xj - dx * t, p[1] - yj - dy * t))
  }
  return inside ? d : -d
}

/**
 * The photo with its lighting taken out, for painting on the face: each pixel divided by the brightness of
 * its surroundings (a blur over 8% of the face's width), brought back to the face's mean, with highlights
 * compressed. Painted as photographed, the sun and sweat highlights doubled with the studio's own lighting
 * and the face looked muddy and dark. Fine detail (brows, lashes, lips, pores) and colour stay.
 */
export function delight(canvas: HTMLCanvasElement, scan: FaceScan): HTMLCanvasElement {
  const W = canvas.width, H = canvas.height
  const span = Math.hypot(scan.points[234][0] - scan.points[454][0], scan.points[234][1] - scan.points[454][1])
  const blur = document.createElement('canvas')
  blur.width = W; blur.height = H
  const b = blur.getContext('2d', { willReadFrequently: true })!
  b.filter = `blur(${Math.max(2, Math.round(span * 0.08))}px)`
  b.drawImage(canvas, 0, 0)
  const src = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, W, H)
  const low = b.getImageData(0, 0, W, H)
  const lum = (d: Uint8ClampedArray, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] + 1
  // the face's mean brightness, over its landmarks
  let mean = 0
  for (const [x, y] of scan.points) mean += lum(low.data, (Math.round(y) * W + Math.round(x)) * 4)
  mean /= scan.points.length
  const out = document.createElement('canvas')
  out.width = W; out.height = H
  const o = out.getContext('2d')!
  const img = o.createImageData(W, H)
  for (let i = 0; i < src.data.length; i += 4) {
    let g = Math.min(1.8, Math.max(0.55, mean / lum(low.data, i)))
    const l = lum(src.data, i) * g
    if (l > mean * 1.3) g *= (mean * 1.3 + (l - mean * 1.3) * 0.25) / l // squash shine
    for (let c = 0; c < 3; c++) img.data[i + c] = Math.min(255, src.data[i + c] * g)
    img.data[i + 3] = 255
  }
  o.putImageData(img, 0, 0)
  return out
}
