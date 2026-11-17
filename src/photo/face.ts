// The face in a photo, from MediaPipe's Face Landmarker running in the browser (local files in
// public/mediapipe: the shared WebAssembly runtime and face_landmarker.task, approved 2026-11-09).
// 478 points and the head's rotation, about a second on the CPU. Its per-point depth was measured 12.8 mm
// off on our own model's render (x and y: 1.5 mm), so only x, y and the head's rotation are used.
type Point = { x: number; y: number; z: number }
type Detection = { faceLandmarks: Point[][]; facialTransformationMatrixes?: { data: number[] }[] }
type Landmarker = { detect(image: HTMLCanvasElement | HTMLImageElement): Detection }
let landmarker: Promise<Landmarker> | null = null

function load(): Promise<Landmarker> {
  landmarker ??= import('@mediapipe/tasks-vision').then(async ({ FilesetResolver, FaceLandmarker }) => {
    const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
    return FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: '/mediapipe/face_landmarker.task', delegate: 'CPU' },
      runningMode: 'IMAGE',
      numFaces: 1,
      outputFacialTransformationMatrixes: true,
    }) as unknown as Landmarker
  })
  return landmarker
}

export interface FaceScan {
  /** 478 points in the original image, as pixels (x right, y down) */
  points: [number, number][]
  /** the head's rotation (row-major 3×3; y up, z towards the camera, like the model's axes) */
  rotation: number[]
  /** the image the face was found in (the close-up crop, if it had to be cropped) and where the crop sat */
  crop: { x: number; y: number; size: number }
  width: number
  height: number
}

const sizeOf = (image: HTMLCanvasElement | HTMLImageElement) => 'naturalWidth' in image ? [image.naturalWidth, image.naturalHeight] : [image.width, image.height]

function run(lm: Landmarker, image: HTMLCanvasElement | HTMLImageElement) {
  const r = lm.detect(image)
  const pts = r.faceLandmarks[0]
  if (!pts?.length) return undefined
  const m = r.facialTransformationMatrixes?.[0]?.data
  // MediaPipe's matrix is column-major 4×4: the rotation's rows are m[0], m[4], m[8] …
  const rotation = m ? [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]] : [1, 0, 0, 0, 1, 0, 0, 0, 1]
  return { pts, rotation }
}

/**
 * The face in an image, or undefined when there is none. The detector only finds faces that fill a fair
 * part of the frame (it is the short-range, selfie one): in a full-length photo the head is found first
 * by the pose detector, then cropped into a close-up.
 */
export async function detectFace(image: HTMLCanvasElement | HTMLImageElement): Promise<FaceScan | undefined> {
  const lm = await load()
  const [W, H] = sizeOf(image)
  const direct = run(lm, image)
  if (direct) return { points: direct.pts.map((p) => [p.x * W, p.y * H]), rotation: direct.rotation, crop: { x: 0, y: 0, size: Math.max(W, H) }, width: W, height: H }
  const { detectHead } = await import('./pose')
  const head = await detectHead(image)
  if (!head) return undefined
  // a square round the head, about three times the ear-to-ear width, drawn up to 640 px
  const size = Math.max(40, head.width * 3), x = head.cx - size / 2, y = head.cy - size / 2
  const c = document.createElement('canvas')
  c.width = c.height = 640
  c.getContext('2d')!.drawImage(image, x, y, size, size, 0, 0, 640, 640)
  const found = run(lm, c)
  if (!found) return undefined
  return { points: found.pts.map((p) => [x + p.x * size, y + p.y * size]), rotation: found.rotation, crop: { x, y, size }, width: W, height: H }
}
