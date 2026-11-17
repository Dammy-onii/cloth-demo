import type { Crop } from '../pattern/photoMap'
// Turn any clothing photo into a garment texture: segment the garment, crop to it and
// fill everything outside the mask with the garment's mean colour so no background bleeds in.

type Segmenter = (input: string) => Promise<{ label: string; mask: { data: Uint8Array | Uint8ClampedArray; width: number; height: number } }[]>

let segmenterPromise: Promise<Segmenter> | null = null

/** SegFormer-B2 fine-tuned on clothes (ATR labels), quantised ONNX, runs in the browser via WASM. */
function getSegmenter(): Promise<Segmenter> {
  segmenterPromise ??= import('@huggingface/transformers').then(async ({ pipeline }) =>
    (await pipeline('image-segmentation', 'Xenova/segformer_b2_clothes', { dtype: 'q8' })) as unknown as Segmenter,
  )
  return segmenterPromise
}

// every garment: Claude's outline then picks out each one (bottoms were left out, and an outfit photo lost its trousers)
const TOP_LABELS = ['Upper-clothes', 'Dress', 'Skirt', 'Pants', 'Belt', 'Scarf']
const MAX_SIDE = 768

export interface GarmentPhoto {
  /** Cropped garment with background replaced by the mean colour */
  texture: HTMLCanvasElement
  /** Downscaled original as a JPEG data URL, sent to Claude */
  jpeg: string
  meanColor: string
  maskSource: 'segformer' | 'background'
  /** Torso left/right edges as fractions of the crop width, measured near the hem */
  torso: [number, number]
  /** where the texture was cut from the photo Claude sees (pixels), to place its landmarks */
  crop: Crop
  /** the scaled photo and the garment mask, kept to re-cut it once Claude has looked */
  source: HTMLCanvasElement
  mask: Uint8Array
}

export async function processGarmentPhoto(file: File, onStatus: (s: string) => void): Promise<GarmentPhoto> {
  const canvas = await loadScaled(file)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const { width: w, height: h } = canvas
  const img = ctx.getImageData(0, 0, w, h)
  const jpeg = canvas.toDataURL('image/jpeg', 0.88)

  onStatus('Segmenting garment (first run downloads a 29 MB model)…')
  let mask: Uint8Array = new Uint8Array(w * h)
  let maskSource: GarmentPhoto['maskSource'] = 'segformer'
  try {
    const segments = await (await getSegmenter())(jpeg)
    for (const s of segments.filter((s) => TOP_LABELS.includes(s.label))) {
      const m = s.mask
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          if (m.data[Math.floor((y * m.height) / h) * m.width + Math.floor((x * m.width) / w)] > 127) mask[y * w + x] = 1
        }
    }
  } catch (err) {
    console.warn('Segmentation model failed, using background removal', err)
  }
  if (count(mask) < w * h * 0.03) {
    // Flat-lays on plain backgrounds often aren't recognised as "worn" clothes; fall back.
    mask = backgroundFloodMask(img)
    maskSource = 'background'
  }

  return compose(canvas, img, jpeg, mask, maskSource)
}

/** Crop the photo to the mask, filling everything outside it with `fill` (a tiled swatch) or the mean colour. */
function compose(source: HTMLCanvasElement, img: ImageData, jpeg: string, mask: Uint8Array, maskSource: GarmentPhoto['maskSource'], fill?: HTMLCanvasElement): GarmentPhoto {
  const { width: w, height: h } = source
  const { x0, y0, x1, y1 } = bbox(mask, w, h)
  const mean = meanColor(img, mask)
  const out = document.createElement('canvas')
  out.width = x1 - x0 + 1
  out.height = y1 - y0 + 1
  const octx = out.getContext('2d', { willReadFrequently: true })!
  octx.fillStyle = fill ? octx.createPattern(fill, 'repeat')! : toHex(mean)
  octx.fillRect(0, 0, out.width, out.height)
  const crop = octx.getImageData(0, 0, out.width, out.height)
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      if (!mask[y * w + x]) continue
      const si = (y * w + x) * 4, di = ((y - y0) * out.width + (x - x0)) * 4
      for (let c = 0; c < 3; c++) crop.data[di + c] = img.data[si + c]
    }
  octx.putImageData(crop, 0, 0)
  return { texture: out, jpeg, meanColor: toHex(mean), maskSource, torso: torsoSpan(mask, w, { x0, y0, x1, y1 }), crop: { x0, y0, w: out.width, h: out.height, W: w, H: h }, source, mask }
}

/** A box of the photo (fractions of the image), resampled square: one tile of the fabric. */
export function swatchCanvas(photo: GarmentPhoto, box: [number, number, number, number]) {
  const { width: W, height: H } = photo.source
  const bw = (box[2] - box[0]) * W, bh = (box[3] - box[1]) * H, side = Math.max(8, Math.min(bw, bh))
  const cx = (box[0] + box[2]) / 2 * W, cy = (box[1] + box[3]) / 2 * H
  const c = document.createElement('canvas')
  c.width = c.height = 2 * Math.round(Math.min(128, Math.max(32, side)))
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(photo.source, cx - side / 2, cy - side / 2, side, side, 0, 0, c.width, c.height)
  // Seamless: cross-fade towards the edges into a copy shifted half a tile, whose middle is
  // continuous across the tile's edges. Mirroring each tile instead turned plaid into a kaleidoscope.
  const n = c.width, src = ctx.getImageData(0, 0, n, n), out = ctx.createImageData(n, n)
  flattenLight(src.data, n)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const edge = Math.min(x, n - 1 - x, y, n - 1 - y) / (n / 2)
    const w = Math.min(1, edge / 0.35)
    const i = (y * n + x) * 4, j = (((y + n / 2) % n) * n + ((x + n / 2) % n)) * 4
    for (let k = 0; k < 3; k++) out.data[i + k] = src.data[i + k] * w + src.data[j + k] * (1 - w)
    out.data[i + 3] = 255
  }
  ctx.putImageData(out, 0, 0)
  // the tile's share of the box's width, to scale Claude's real width onto the square tile
  return { canvas: c, widthShare: side / Math.max(1, bw) }
}

/**
 * Re-cut the garment with what Claude saw: only pixels inside its traced outline count as the garment
 * (segmentation alone took a skirt worn underneath, or the room behind, as part of a dress), and
 * whatever the photo hides is filled with the fabric swatch rather than a flat colour.
 */
export function refineWithClaude(photo: GarmentPhoto, outline?: [number, number][], swatch?: HTMLCanvasElement): GarmentPhoto {
  const { source, mask: seg } = photo
  const { width: w, height: h } = source
  const img = source.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h)
  let mask = seg
  if (outline && outline.length >= 4) {
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.beginPath()
    outline.forEach(([x, y], i) => (i ? ctx.lineTo(x * w, y * h) : ctx.moveTo(x * w, y * h)))
    ctx.closePath()
    ctx.fill()
    const a = ctx.getImageData(0, 0, w, h).data
    const poly = new Uint8Array(w * h).map((_, i) => (a[i * 4 + 3] > 127 ? 1 : 0))
    const both = seg.map((v, i) => v & poly[i])
    // where segmentation found little of what Claude outlined, trust the outline
    mask = count(both) > count(poly) * 0.3 ? both : poly
  }
  if (count(mask) < w * h * 0.01) return photo
  return compose(source, img, photo.jpeg, mask, photo.maskSource, swatch)
}

async function loadScaled(file: File) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const c = document.createElement('canvas')
  c.width = Math.round(bitmap.width * scale)
  c.height = Math.round(bitmap.height * scale)
  c.getContext('2d')!.drawImage(bitmap, 0, 0, c.width, c.height)
  return c
}

/**
 * Background = everything 4-connected to the image border whose colour is within a threshold of
 * the median border colour. Whatever the flood can't reach is the garment.
 */
function backgroundFloodMask(img: ImageData): Uint8Array {
  const { width: w, height: h, data } = img
  const border: number[][] = []
  for (let x = 0; x < w; x++) border.push(px(data, x, 0, w), px(data, x, h - 1, w))
  for (let y = 0; y < h; y++) border.push(px(data, 0, y, w), px(data, w - 1, y, w))
  const bg = [0, 1, 2].map((c) => median(border.map((p) => p[c])))
  const isBg = (i: number) => Math.hypot(data[i * 4] - bg[0], data[i * 4 + 1] - bg[1], data[i * 4 + 2] - bg[2]) < 42
  const visited = new Uint8Array(w * h)
  const stack: number[] = []
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x)
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1)
  while (stack.length) {
    const i = stack.pop()!
    if (visited[i] || !isBg(i)) continue
    visited[i] = 1
    const x = i % w, y = (i / w) | 0
    if (x > 0) stack.push(i - 1)
    if (x < w - 1) stack.push(i + 1)
    if (y > 0) stack.push(i - w)
    if (y < h - 1) stack.push(i + w)
  }
  return visited.map((v) => 1 - v)
}

const px = (d: Uint8ClampedArray, x: number, y: number, w: number) => [d[(y * w + x) * 4], d[(y * w + x) * 4 + 1], d[(y * w + x) * 4 + 2]]
const median = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1]
const count = (m: Uint8Array) => m.reduce((s, v) => s + v, 0)
const toHex = (c: number[]) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

function bbox(mask: Uint8Array, w: number, h: number) {
  let x0 = w, y0 = h, x1 = 0, y1 = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x)
        y0 = Math.min(y0, y); y1 = Math.max(y1, y)
      }
  return x1 >= x0 ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: w - 1, y1: h - 1 }
}

/** Widest masked run in rows 85–95% down the garment: the body of the shirt, below the sleeves. */
function torsoSpan(mask: Uint8Array, w: number, b: { x0: number; y0: number; x1: number; y1: number }): [number, number] {
  let left = b.x1, right = b.x0
  for (let y = Math.round(b.y0 + (b.y1 - b.y0) * 0.85); y <= b.y0 + (b.y1 - b.y0) * 0.95; y++)
    for (let x = b.x0; x <= b.x1; x++)
      if (mask[y * w + x]) {
        left = Math.min(left, x); right = Math.max(right, x)
      }
  const width = b.x1 - b.x0 || 1
  return right > left ? [(left - b.x0) / width, (right - b.x0) / width] : [0, 1]
}

function meanColor(img: ImageData, mask: Uint8Array) {
  const sum = [0, 0, 0]
  let n = 0
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) {
      for (let c = 0; c < 3; c++) sum[c] += img.data[i * 4 + c]
      n++
    }
  return sum.map((s) => (n ? s / n : 200))
}

/**
 * Take the photo's lighting out of a swatch: fit a plane to its brightness (light falling off across the
 * patch) and divide it out, keeping the patch's mean. A plane, not a blur: tiled as photographed a silk
 * swatch's shading repeated as stripes, but blurring away the light also blurred away a plaid's own bands.
 */
function flattenLight(d: Uint8ClampedArray, n: number) {
  let s0 = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sl = 0, sxl = 0, syl = 0
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = (y * n + x) * 4, l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] + 1
    const u = x / n - 0.5, v = y / n - 0.5
    s0++; sx += u; sy += v; sxx += u * u; syy += v * v; sl += l; sxl += u * l; syl += v * l
  }
  // centred coordinates: the cross terms vanish, so each slope is independent
  const mean = sl / s0, gx = (sxl - sx * mean) / (sxx || 1), gy = (syl - sy * mean) / (syy || 1)
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const plane = mean + gx * (x / n - 0.5) + gy * (y / n - 0.5)
    const g = Math.min(2, Math.max(0.5, mean / Math.max(1, plane))), i = (y * n + x) * 4
    for (let c = 0; c < 3; c++) d[i + c] = Math.min(255, d[i + c] * g)
  }
}
