// Loads the mannequins exported by tools/anny-export/export.py.
// One binary per gender: [positions of every size×pose variant][triangle indices][segment label per vertex].

export type Gender = 'female' | 'male'
export type Size = 'S' | 'M' | 'L' | 'XL'
export type Pose = 'apose' | 'relaxed' | 'hips' | 'stride' | 'onehip'
export type Vec3 = [number, number, number]

export const SIZES: Size[] = ['S', 'M', 'L', 'XL']
export const POSES: { id: Pose; label: string }[] = [
  { id: 'apose', label: 'A-pose' },
  { id: 'relaxed', label: 'Relaxed' },
  { id: 'hips', label: 'Hands on hips' },
  { id: 'stride', label: 'Step' },
  { id: 'onehip', label: 'Hand on hip' },
]

export interface Measurements {
  height: number
  bust: number
  waist: number
  hip: number
}

interface VariantInfo {
  size: Size
  pose: Pose
  offset: number
  joints: Record<string, Vec3>
  measurements?: Measurements
  chart?: Omit<Measurements, 'height'>
}

interface GenderManifest {
  file: string
  vertexCount: number
  indexCount: number
  indexOffset: number
  labelOffset: number
  segments: string[]
  variants: VariantInfo[]
}

export interface BodySet {
  gender: Gender
  vertexCount: number
  index: Uint32Array
  /** Dominant body segment per vertex; see `segment()` */
  labels: Uint8Array
  segments: string[]
  variants: VariantInfo[]
  positions(size: Size, pose: Pose): Float32Array
  joints(size: Size, pose: Pose): Record<string, Vec3>
  measurements(size: Size): { fitted: Measurements; chart: Omit<Measurements, 'height'> }
  segment(name: string): number
}

let manifestPromise: Promise<{ genders: Record<Gender, GenderManifest> }> | null = null
const cache = new Map<Gender, Promise<BodySet>>()

export function loadBodySet(gender: Gender): Promise<BodySet> {
  if (!cache.has(gender)) cache.set(gender, fetchBodySet(gender))
  return cache.get(gender)!
}

async function fetchBodySet(gender: Gender): Promise<BodySet> {
  // revalidate: a re-export changes the binary layout, and a cached binary with a new manifest is garbage
  manifestPromise ??= fetch('/models/manifest.json', { cache: 'no-cache' }).then((r) => r.json())
  const g = (await manifestPromise).genders[gender]
  const buffer = await (await fetch(`/models/${g.file}`, { cache: 'no-cache' })).arrayBuffer()
  const floatsPerVariant = g.vertexCount * 3
  const find = (size: Size, pose: Pose) => {
    const v = g.variants.find((x) => x.size === size && x.pose === pose)
    if (!v) throw new Error(`No ${gender} ${size} ${pose} variant`)
    return v
  }
  return {
    gender,
    vertexCount: g.vertexCount,
    index: new Uint32Array(buffer, g.indexOffset, g.indexCount),
    labels: new Uint8Array(buffer, g.labelOffset, g.vertexCount),
    segments: g.segments,
    variants: g.variants,
    positions: (size, pose) => new Float32Array(buffer, find(size, pose).offset, floatsPerVariant),
    joints: (size, pose) => find(size, pose).joints,
    measurements: (size) => {
      const v = find(size, 'apose')
      return { fitted: v.measurements!, chart: v.chart! }
    },
    segment: (name) => g.segments.indexOf(name),
  }
}
