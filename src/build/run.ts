// The page's side of pattern programs: send the body and a program (or spec) to the worker, get sewn
// garments back. See worker.ts and docs/pattern-api.md.
import type { BodySet, Gender, Size, Vec3 } from '../body/bodySet'
import type { Garment } from '../cloth/buildGarment'
import type { ProgramGarment } from './kit'

export interface BodySnapshot {
  gender: Gender
  size: Size
  vertexCount: number
  index: Uint32Array
  labels: Uint8Array
  segments: string[]
  positions: Float32Array
  joints: Record<string, Vec3>
  measurements: ReturnType<BodySet['measurements']>
}

export interface BuildRequest { id: number; mode: 'code' | 'spec'; source: string; body: BodySnapshot }

export interface BuiltGarment extends Omit<ProgramGarment, 'pieces' | 'seams' | 'band'> {
  garment: Garment
}

let worker: Worker | undefined
let next = 0
const waiting = new Map<number, { resolve: (b: BuiltGarment[]) => void; reject: (e: Error) => void }>()

function spawn() {
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e) => {
    const { id, ok, built, error } = e.data
    const w = waiting.get(id)
    waiting.delete(id)
    if (ok) w?.resolve(built)
    else w?.reject(new Error(error))
  }
  return worker
}

/** Sew a pattern program (`mode: 'code'`) or spec (`'spec'`) for this body, in the A-pose. */
export function buildPattern(mode: 'code' | 'spec', source: string, body: BodySet, size: Size, timeoutMs = 20000): Promise<BuiltGarment[]> {
  const w = worker ?? spawn()
  const id = ++next
  const snap: BodySnapshot = {
    gender: body.gender, size, vertexCount: body.vertexCount, index: body.index, labels: body.labels, segments: body.segments,
    positions: body.positions(size, 'apose'), joints: body.joints(size, 'apose'), measurements: body.measurements(size),
  }
  return new Promise((resolve, reject) => {
    // a program that never returns (an endless loop) is stopped, and the worker replaced
    const timer = setTimeout(() => {
      waiting.delete(id)
      worker?.terminate()
      worker = undefined
      reject(new Error(`the pattern took longer than ${timeoutMs / 1000} s and was stopped`))
    }, timeoutMs)
    waiting.set(id, { resolve: (b) => { clearTimeout(timer); resolve(b) }, reject: (e) => { clearTimeout(timer); reject(e) } })
    w.postMessage({ id, mode, source, body: snap } satisfies BuildRequest)
  })
}
