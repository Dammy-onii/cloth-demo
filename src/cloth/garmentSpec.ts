// What Claude (or the manual controls) tell us about a garment photo.

export type Sleeve = 'none' | 'cap' | 'short' | 'elbow' | 'three_quarter' | 'long'
export type Neckline = 'crew' | 'v' | 'scoop' | 'boat' | 'collar' | 'strapless'
export type Length = 'cropped' | 'waist' | 'hip' | 'tunic' | 'mini' | 'knee' | 'midi' | 'floor'
/** A dress's skirt: close to the legs, an A-line, or a full circle */
export type Skirt = 'straight' | 'aline' | 'full'
export type Kind = 'top' | 'dress'
export type Fit = 'tight' | 'regular' | 'relaxed' | 'oversized'
export type Fabric = 'jersey' | 'cotton' | 'linen' | 'silk' | 'denim' | 'knit' | 'synthetic' | 'wool'

/** Points on the garment in the photo, as fractions of the full image (x from the left, y from the
 * top); L and R are the image's left and right. */
export type Mark = [number, number]
export interface Landmarks { neck: Mark; shoulderL: Mark; shoulderR: Mark; waistL: Mark; waistR: Mark; hemL: Mark; hemR: Mark; sleeveL?: Mark; sleeveR?: Mark }
// (uploaded garments are read as GarmentRead in garmentRead.ts)

export interface GarmentSpec {
  category: string
  /** a dress is one piece, shoulders to hem, worn without a bottom */
  kind?: Kind
  skirt?: Skirt
  sleeve: Sleeve
  neckline: Neckline
  length: Length
  fit: Fit
  fabric: Fabric
  primaryColor: string
  printOnBack: boolean
  description: string
  /** contrast band along the neckline (a draped or folded trim), if any */
  trimColor?: string
}

export const DEFAULT_SPEC: GarmentSpec = {
  category: 'tshirt',
  kind: 'top',
  skirt: 'aline',
  sleeve: 'short',
  neckline: 'crew',
  length: 'hip',
  fit: 'regular',
  fabric: 'jersey',
  primaryColor: '#3f5272',
  printOnBack: false,
  description: 'Plain T-shirt',
}

export const OPTIONS = {
  sleeve: ['none', 'cap', 'short', 'elbow', 'three_quarter', 'long'],
  neckline: ['crew', 'v', 'scoop', 'boat', 'collar', 'strapless'],
  length: ['cropped', 'waist', 'hip', 'tunic', 'mini', 'knee', 'midi', 'floor'],
  kind: ['top', 'dress'],
  skirt: ['straight', 'aline', 'full'],
  fit: ['tight', 'regular', 'relaxed', 'oversized'],
  fabric: ['jersey', 'cotton', 'linen', 'silk', 'denim', 'knit', 'synthetic', 'wool'],
} as const

export type BottomStyle = 'trousers' | 'shorts' | 'skirt'

/** Trousers, shorts and skirts: cut from the waist down, or flared from a hip yoke (skirts). */
export interface BottomSpec {
  style: BottomStyle
  fit: Fit
  fabric: Fabric
  primaryColor: string
}

/** Fraction of the shoulder→wrist axis the sleeve covers. */
export const SLEEVE_T: Record<Sleeve, number> = {
  none: -1, cap: 0.1, short: 0.32, elbow: 0.5, three_quarter: 0.72, long: 0.97,
}

/** Gap between skin and cloth (m) before gravity takes over. */
export const FIT_EASE: Record<Fit, number> = { tight: 0.004, regular: 0.012, relaxed: 0.024, oversized: 0.04 }

/**
 * XPBD compliances (inverse stiffness, m/N). Stretch is near-inextensible for woven fabrics,
 * softer for knits; bend compliance controls how readily the fabric folds.
 */
export const FABRIC: Record<Fabric, { stretch: number; bend: number; damping: number }> = {
  jersey: { stretch: 2e-7, bend: 6e-4, damping: 0.02 },
  knit: { stretch: 8e-7, bend: 4e-4, damping: 0.03 },
  cotton: { stretch: 6e-8, bend: 2.5e-4, damping: 0.02 },
  linen: { stretch: 3e-8, bend: 1e-4, damping: 0.02 },
  silk: { stretch: 6e-8, bend: 2e-3, damping: 0.01 },
  denim: { stretch: 1e-8, bend: 2e-5, damping: 0.03 },
  synthetic: { stretch: 1e-7, bend: 5e-4, damping: 0.02 },
  // coating wool: heavy and springy, so it hangs in a few broad folds rather than many small ones
  wool: { stretch: 5e-8, bend: 1.5e-4, damping: 0.04 },
}

/** Coerce whatever came back from Claude into a valid spec. */
export function sanitizeSpec(raw: Partial<Record<keyof GarmentSpec, unknown>>): GarmentSpec {
  const pick = <K extends keyof typeof OPTIONS>(k: K): (typeof OPTIONS)[K][number] => {
    const v = String(raw[k] ?? '').toLowerCase().replace(/[\s-]/g, '_')
    return ((OPTIONS[k] as readonly string[]).includes(v) ? v : DEFAULT_SPEC[k]) as (typeof OPTIONS)[K][number]
  }
  const color = String(raw.primaryColor ?? '')
  return {
    category: String(raw.category ?? DEFAULT_SPEC.category),
    kind: pick('kind'),
    skirt: pick('skirt'),
    sleeve: pick('sleeve'),
    neckline: pick('neckline'),
    length: pick('length'),
    fit: pick('fit'),
    fabric: pick('fabric'),
    primaryColor: /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_SPEC.primaryColor,
    printOnBack: Boolean(raw.printOnBack),
    description: String(raw.description ?? ''),
  }
}
