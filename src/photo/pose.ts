// The wearer's joints in a clothes photo, from MediaPipe Pose running in the browser (local files in
// public/mediapipe: the WebAssembly runtime and the lite pose model). Claude's own joint estimates were a
// few percent off, which moved hems, cut-outs and slits by centimetres.
import type { Mark } from '../cloth/garmentSpec'

export interface Joints {
  /** image-left and image-right of each pair, as fractions of the photo (x right, y down) */
  shoulder: [Mark, Mark]
  elbow: [Mark, Mark]
  wrist: [Mark, Mark]
  hip: [Mark, Mark]
  knee: [Mark, Mark]
  ankle: [Mark, Mark]
  nose: Mark
  /** each joint's visibility (0..1): low where the photo crops or hides it */
  seen: { knee: number; ankle: number }
}

type Landmarker = { detect(image: HTMLCanvasElement | HTMLImageElement): { landmarks: { x: number; y: number; visibility?: number }[][] } }
let landmarker: Promise<Landmarker> | null = null

function load(): Promise<Landmarker> {
  landmarker ??= import('@mediapipe/tasks-vision').then(async ({ FilesetResolver, PoseLandmarker }) => {
    const files = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
    return PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: '/mediapipe/pose_landmarker_lite.task', delegate: 'CPU' },
      runningMode: 'IMAGE',
      numPoses: 1,
    }) as unknown as Landmarker
  })
  return landmarker
}

/** The wearer's joints, or undefined when no person is in the photo (a flat-lay or hanger). */
export async function detectJoints(image: HTMLCanvasElement): Promise<Joints | undefined> {
  try {
    const result = (await load()).detect(image)
    const lm = result.landmarks[0]
    if (!lm) return undefined
    const p = (i: number): Mark => [lm[i].x, lm[i].y]
    // MediaPipe numbers the person's own left and right; order each pair by image side
    const pair = (a: number, b: number): [Mark, Mark] => (lm[a].x <= lm[b].x ? [p(a), p(b)] : [p(b), p(a)])
    const vis = (a: number, b: number) => Math.min(lm[a].visibility ?? 1, lm[b].visibility ?? 1)
    // a person must at least show shoulders and hips
    if (vis(11, 12) < 0.5 || vis(23, 24) < 0.5) return undefined
    return {
      shoulder: pair(11, 12), elbow: pair(13, 14), wrist: pair(15, 16), hip: pair(23, 24), knee: pair(25, 26), ankle: pair(27, 28),
      nose: p(0), seen: { knee: vis(25, 26), ankle: vis(27, 28) },
    }
  } catch (e) {
    console.warn('Pose detection failed', e)
    return undefined
  }
}

/** Where the head is in an image (pixels): its centre and ear-to-ear width, from the pose detector's face points. */
export async function detectHead(image: HTMLCanvasElement | HTMLImageElement): Promise<{ cx: number; cy: number; width: number } | undefined> {
  try {
    const lm = (await load()).detect(image).landmarks[0]
    if (!lm) return undefined
    const W = 'naturalWidth' in image ? image.naturalWidth : image.width, H = 'naturalHeight' in image ? image.naturalHeight : image.height
    // nose 0, eyes 2 and 5, ears 7 and 8
    const pts = [0, 2, 5, 7, 8].map((i) => [lm[i].x * W, lm[i].y * H])
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
    const width = Math.max(Math.hypot(pts[3][0] - pts[4][0], pts[3][1] - pts[4][1]), Math.hypot(pts[1][0] - pts[2][0], pts[1][1] - pts[2][1]) * 2)
    return { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2, width }
  } catch {
    return undefined
  }
}
