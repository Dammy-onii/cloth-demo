// What Claude reads from an uploaded photo: every garment in it, measured against the body. Lengths
// are body landmarks (a hem "between the knee and the ankle"), not centimetres or size words, so the
// same reading drafts the garment to fit any mannequin: on a worn photo they come from where the hem
// and cuffs actually fall against the wearer's own knees, ankles, elbows and wrists.
import type { Fabric, Fit, Mark } from './garmentSpec'

/** Heights down the body. A position is an index into this list plus a fraction towards the next. */
export const LEVELS = ['neck', 'shoulder', 'underbust', 'waist', 'high_hip', 'hip', 'crotch', 'mid_thigh', 'above_knee', 'knee', 'below_knee', 'mid_calf', 'ankle', 'floor'] as const
export type Level = (typeof LEVELS)[number]
/** Down the arm: 0 the shoulder point, 1 the elbow, 2 the wrist. */
export const SLEEVE_ENDS = { none: -1, cap: 0.15, bicep: 0.5, elbow: 1, forearm: 1.5, wrist: 2, knuckles: 2.2 } as const
export type SleeveEnd = keyof typeof SLEEVE_ENDS

export type Slot = 'top' | 'bottom' | 'dress' | 'outer'
export type Neckline = 'crew' | 'v' | 'scoop' | 'boat' | 'collar' | 'strapless' | 'off_shoulder' | 'turtleneck'
export type Legs = 'skinny' | 'straight' | 'wide' | 'flared'
export type BottomKind = 'trousers' | 'shorts' | 'skirt'
export type Silhouette = 'straight' | 'aline' | 'full'
export type Print = 'plain' | 'allover' | 'placed'

export interface GarmentRead {
  slot: Slot
  type: string
  description: string
  fit: Fit
  fabric: Fabric
  primaryColor: string
  neckline: Neckline
  sleeve: SleeveEnd
  /** where the garment's top edge sits (bottoms: the waistband) and where its hem falls */
  top: number
  hem: number
  /** a dress's waist seam */
  waistSeam: number
  /** sleeve end down the arm (0 shoulder, 1 elbow, 2 wrist; −1 none) */
  sleeveAt: number
  bottomKind: BottomKind
  legs: Legs
  skirt: Silhouette
  print: Print
  /** a box of plain fabric (x0, y0, x1, y1 as fractions of the photo) and its real width (cm) */
  swatch?: [number, number, number, number]
  swatchCm: number
  /** the garment's edge in the photo */
  outline?: Mark[]
  /** points on the garment for placing a print: neck, shoulders, waist, hem, sleeve ends */
  landmarks?: Record<string, Mark | undefined>
  /** collar, buttons, belt, open front, cut-out, wrap, ruching, pockets… (shown, not yet modelled) */
  details: string[]
  /** how the garment sits on the wearer in the photo: its width over the body's at body positions (worn
   *  photos). The model wears it as snugly or loosely at the same levels. */
  widths?: { at: number; ratio: number }[]
  sleeveWidth: 'fitted' | 'regular' | 'loose'
  /** this garment's own structure, traced in the photo */
  structure?: Structure
  /** the wearer's joints in the photo (MediaPipe), when a person wears it */
  joints?: import('../photo/pose').Joints
  /** Claude's reply for this garment as it came, sent back with the render for Claude to correct */
  raw: Record<string, unknown>
  /** corrections on top of the trace, from Claude's check or the user's edits */
  adjust: { easeScale?: number; hem?: number; sleeveAt?: number }
}

/**
 * The garment as traced in the photo (fractions of the image, x right, y down; L/R are image sides).
 * Drawn onto the model through body coordinates by `chartDraft` (src/pattern/chart.ts).
 */
export interface Sleeve { end: Mark; width: 'fitted' | 'regular' | 'loose'; /** across the hem opening, fraction of the image width */ hemWidth?: number }

export interface Structure {
  /** the photo's width over its height: photo fractions in x and y are different lengths */
  aspect: number
  /** body edges and this garment's edges, top to hem (garment null above its side seams) */
  rows: { y: number; body: [number, number]; garment?: [number, number] }[]
  /** the front's top edge (neckline), image-left to right */
  topLine: Mark[]
  top: { L: 'shoulder' | 'under_arm'; R: 'shoulder' | 'under_arm' }
  /** the hem, image-left to right */
  hemLine: Mark[]
  openings: { kind: string; points: Mark[]; confidence: number }[]
  slits: { top: Mark; hem: Mark; confidence: number }[]
  occluded: Mark[][]
  sleeves: { L?: Sleeve; R?: Sleeve }
  back: { neckDepth: number; openBack?: { top: number; bottom: number; width: number }; slitTop?: number }
  hold: 'shoulders' | 'neckline' | 'waist'
}

export interface PhotoRead {
  view: 'worn' | 'flat' | 'hanger' | 'mannequin' | 'other'
  garments: GarmentRead[]
}

/** The wearer's joints in the photo (MediaPipe), shared by every garment read from it. */
export type PhotoJoints = import('../photo/pose').Joints

const pickOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => {
  const s = String(v ?? '').toLowerCase().replace(/[\s-]/g, '_')
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback
}
const num = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback
}
const unit = (v: unknown) => typeof v === 'number' && v >= 0 && v <= 1
const mark = (v: unknown): Mark | undefined => Array.isArray(v) && v.length === 2 && v.every(unit) ? [v[0], v[1]] : undefined
const levelOf = (v: unknown, fallback: number) => {
  const i = LEVELS.indexOf(pickOf(v, LEVELS, LEVELS[Math.round(fallback)]))
  return i < 0 ? fallback : i
}

type Body = Record<string, Mark | undefined>

/**
 * Where a photo y falls on the body, as a position on LEVELS, from the wearer's own landmarks:
 * piecewise linear between the levels Claude found on the person.
 */
function bodyPosition(y: number, body: Body): number | undefined {
  const at = (k: string, j: string) => { const a = body[k], b = body[j]; return a && b ? (a[1] + b[1]) / 2 : a?.[1] ?? b?.[1] }
  const pairs: [number, number | undefined][] = [
    [LEVELS.indexOf('neck'), body.neck?.[1]],
    [LEVELS.indexOf('shoulder'), at('shoulderL', 'shoulderR')],
    [LEVELS.indexOf('waist'), at('waistL', 'waistR')],
    [LEVELS.indexOf('hip'), at('hipL', 'hipR')],
    [LEVELS.indexOf('knee'), at('kneeL', 'kneeR')],
    [LEVELS.indexOf('ankle'), at('ankleL', 'ankleR')],
  ]
  const known = pairs.filter((p): p is [number, number] => p[1] !== undefined).sort((a, b) => a[1] - b[1])
  if (known.length < 3) return undefined
  // reject a body whose landmarks are out of order (Claude misread the pose)
  for (let i = 1; i < known.length; i++) if (known[i][0] <= known[i - 1][0]) return undefined
  let k = known.findIndex((p) => p[1] > y) - 1
  if (k < 0) k = y <= known[0][1] ? 0 : known.length - 2
  const [l0, y0] = known[k], [l1, y1] = known[k + 1]
  return Math.max(0, Math.min(LEVELS.length - 1, l0 + ((y - y0) / (y1 - y0 || 1)) * (l1 - l0)))
}

/** Sleeve end down the wearer's own arm: shoulder → elbow → wrist, from the photo. */
function armPosition(end: Mark, body: Body, side: 'L' | 'R'): number | undefined {
  const s = body['shoulder' + side], e = body['elbow' + side], w = body['wrist' + side]
  if (!s || !e || !w) return undefined
  const along = (a: Mark, b: Mark) => {
    const d = [b[0] - a[0], b[1] - a[1]], l2 = d[0] * d[0] + d[1] * d[1] || 1
    const t = ((end[0] - a[0]) * d[0] + (end[1] - a[1]) * d[1]) / l2
    return { t, dist: Math.hypot(end[0] - (a[0] + d[0] * t), end[1] - (a[1] + d[1] * t)) }
  }
  const up = along(s, e), lo = along(e, w)
  const t = up.t <= 1 && (up.dist <= lo.dist || lo.t < 0) ? up.t : 1 + lo.t
  return Math.max(0, Math.min(2.3, t))
}

/** Coerce Claude's reply into a reading; lengths measured on a worn photo override its labels. */
export function sanitizeRead(raw: unknown): PhotoRead {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const view = pickOf(r.view, ['worn', 'flat', 'hanger', 'mannequin', 'other'] as const, 'other')
  const body = (r.body && typeof r.body === 'object' ? Object.fromEntries(Object.entries(r.body as object).map(([k, v]) => [k, mark(v)])) : {}) as Body
  const list = Array.isArray(r.garments) ? r.garments : []
  const garments = list.slice(0, 4).map((g0): GarmentRead => {
    const g = (g0 && typeof g0 === 'object' ? g0 : {}) as Record<string, unknown>
    const slot = pickOf(g.slot, ['top', 'bottom', 'dress', 'outer'] as const, 'top')
    const lm = g.landmarks && typeof g.landmarks === 'object' ? Object.fromEntries(Object.entries(g.landmarks as object).map(([k, v]) => [k, mark(v)])) : undefined
    const outline = Array.isArray(g.outline) ? (g.outline as unknown[]).map(mark).filter((p): p is Mark => !!p) : []
    const b = g.swatch
    const swatch = Array.isArray(b) && b.length === 4 && b.every(unit) && b[2] - b[0] > 0.015 && b[3] - b[1] > 0.015 ? (b as [number, number, number, number]) : undefined
    const bottom = slot === 'bottom'
    let top = levelOf(g.topAt, bottom ? LEVELS.indexOf('waist') : 0)
    let hem = levelOf(g.hemAt, bottom ? LEVELS.indexOf('ankle') : LEVELS.indexOf('high_hip'))
    let sleeveAt: number = SLEEVE_ENDS[pickOf(g.sleeveEnd, Object.keys(SLEEVE_ENDS) as SleeveEnd[], bottom ? 'none' : 'elbow')]
    // a worn photo: measure where the hem and cuffs fall against the wearer's body
    if (view === 'worn') {
      const hemY = lm?.hemL && lm?.hemR ? (lm.hemL[1] + lm.hemR[1]) / 2 : outline.length ? Math.max(...outline.map((p) => p[1])) : undefined
      const measured = hemY !== undefined ? bodyPosition(hemY, body) : undefined
      if (measured !== undefined) hem = measured
      const topY = bottom && lm?.waistL && lm?.waistR ? (lm.waistL[1] + lm.waistR[1]) / 2 : undefined
      const measuredTop = topY !== undefined ? bodyPosition(topY, body) : undefined
      if (measuredTop !== undefined) top = measuredTop
      if (sleeveAt >= 0) {
        const ends = (['L', 'R'] as const).flatMap((side) => {
          const end = lm?.['sleeve' + side]
          const p = end ? armPosition(end, body, side) : undefined
          return p === undefined ? [] : [p]
        })
        if (ends.length) sleeveAt = Math.max(0.1, ends.reduce((a, c) => a + c, 0) / ends.length)
      }
    }
    if (hem <= top + 0.5) hem = top + 1
    const color = String(g.primaryColor ?? '')
    return {
      slot,
      type: String(g.type ?? slot).slice(0, 40),
      description: String(g.description ?? '').slice(0, 200),
      fit: pickOf(g.fit, ['tight', 'regular', 'relaxed', 'oversized'] as const, 'regular'),
      fabric: pickOf(g.fabric, ['jersey', 'cotton', 'linen', 'silk', 'denim', 'knit', 'synthetic', 'wool'] as const, 'cotton'),
      primaryColor: /^#[0-9a-f]{6}$/i.test(color) ? color : '#808080',
      neckline: pickOf(g.neckline, ['crew', 'v', 'scoop', 'boat', 'collar', 'strapless', 'off_shoulder', 'turtleneck'] as const, 'crew'),
      sleeve: (Object.entries(SLEEVE_ENDS).reduce((best, [k, v]) => Math.abs(v - sleeveAt) < Math.abs(SLEEVE_ENDS[best] - sleeveAt) ? (k as SleeveEnd) : best, 'none' as SleeveEnd)),
      top, hem,
      waistSeam: levelOf(g.waistSeamAt, LEVELS.indexOf('waist')),
      sleeveAt,
      bottomKind: pickOf(g.bottomKind, ['trousers', 'shorts', 'skirt'] as const, 'trousers'),
      legs: pickOf(g.legs, ['skinny', 'straight', 'wide', 'flared'] as const, 'straight'),
      skirt: pickOf(g.skirt, ['straight', 'aline', 'full'] as const, 'aline'),
      print: pickOf(g.print, ['plain', 'allover', 'placed'] as const, swatch ? 'allover' : 'plain'),
      swatch, swatchCm: num(g.swatchCm, 2, 80, 10),
      outline: outline.length >= 4 ? outline : undefined,
      landmarks: lm,
      details: Array.isArray(g.details) ? g.details.map(String).slice(0, 8) : [],
      widths: widthsOf(g.silhouette),
      structure: structureOf(g, slot),
      raw: g,
      adjust: { easeScale: g.fitScale !== undefined ? num(g.fitScale, 0.4, 2, 1) : undefined },
      sleeveWidth: pickOf(g.sleeveWidth, ['fitted', 'regular', 'loose'] as const, g.fit === 'tight' ? 'fitted' : 'regular'),
    }
  })
  return { view, garments }
}

const polygon = (v: unknown): Mark[] => Array.isArray(v) ? v.map(mark).filter((p): p is Mark => !!p) : []
const confidence = (v: unknown) => num(v, 0, 1, 0.7)

/** The traced structure, when Claude gave enough of it to draw the garment from. */
function structureOf(g: Record<string, unknown>, slot: Slot): Structure | undefined {
  const rows = (Array.isArray(g.rows) ? g.rows : []).flatMap((r0) => {
    const r = (r0 && typeof r0 === 'object' ? r0 : {}) as Record<string, unknown>
    const pair = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(unit) && Number(v[1]) > Number(v[0]) ? [Number(v[0]), Number(v[1])] as [number, number] : undefined
    const body = pair(r.body), y = Number(r.y)
    return body && unit(y) ? [{ y, body, garment: pair(r.garment) }] : []
  }).sort((a, b) => a.y - b.y)
  const topLine = polygon(g.topLine).sort((a, b) => a[0] - b[0]), hemLine = polygon(g.hemLine).sort((a, b) => a[0] - b[0])
  // too little traced to draw from: fall back to the template drafts
  if (slot === 'bottom' || rows.filter((r) => r.garment).length < 2 || hemLine.length < 2 || topLine.length < 2) return undefined
  const t = (g.top && typeof g.top === 'object' ? g.top : {}) as Record<string, unknown>
  const side = (v: unknown) => pickOf(v, ['shoulder', 'under_arm'] as const, 'shoulder')
  const sl = (g.sleeves && typeof g.sleeves === 'object' ? g.sleeves : {}) as Record<string, unknown>
  const sleeve = (v: unknown) => {
    const o = (v && typeof v === 'object' ? v : undefined) as Record<string, unknown> | undefined
    const end = o && mark(o.end)
    const hw = Number(o?.hemWidth)
    return end ? { end, width: pickOf(o!.width, ['fitted', 'regular', 'loose'] as const, 'regular'), hemWidth: hw > 0 && hw < 0.6 ? hw : undefined } : undefined
  }
  const b = (g.back && typeof g.back === 'object' ? g.back : {}) as Record<string, unknown>
  const ob = (b.openBack && typeof b.openBack === 'object' ? b.openBack : undefined) as Record<string, unknown> | undefined
  const sb = (b.slit && typeof b.slit === 'object' ? b.slit : undefined) as Record<string, unknown> | undefined
  return {
    aspect: 1, rows, topLine, hemLine,
    top: { L: side(t.L), R: side(t.R) },
    openings: (Array.isArray(g.openings) ? g.openings : []).flatMap((o0) => {
      const o = (o0 && typeof o0 === 'object' ? o0 : {}) as Record<string, unknown>
      const points = polygon(o.points)
      return points.length >= 3 ? [{ kind: String(o.kind ?? 'cut-out'), points, confidence: confidence(o.confidence) }] : []
    }),
    slits: (Array.isArray(g.slits) ? g.slits : []).flatMap((o0) => {
      const o = (o0 && typeof o0 === 'object' ? o0 : {}) as Record<string, unknown>
      const top = mark(o.top), hem = mark(o.hem)
      return top && hem && hem[1] > top[1] ? [{ top, hem, confidence: confidence(o.confidence) }] : []
    }),
    occluded: (Array.isArray(g.occluded) ? g.occluded : []).map(polygon).filter((p) => p.length >= 3),
    sleeves: { L: sleeve(sl.L), R: sleeve(sl.R) },
    back: {
      neckDepth: levelOf(b.neckDepthAt, LEVELS.indexOf('shoulder')),
      openBack: ob ? { top: levelOf(ob.topAt, 2), bottom: levelOf(ob.bottomAt, 3), width: num(ob.width, 0.1, 1, 0.5) } : undefined,
      slitTop: sb ? levelOf(sb.topAt, LEVELS.indexOf('above_knee')) : undefined,
    },
    hold: pickOf(g.hold, ['shoulders', 'neckline', 'waist'] as const, 'shoulders'),
  }
}

/** Garment width over body width at each level Claude measured, sorted down the body. */
function widthsOf(raw: unknown): GarmentRead['widths'] {
  if (!Array.isArray(raw)) return undefined
  const out = raw.flatMap((e) => {
    const r = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
    const at = LEVELS.indexOf(pickOf(r.level, LEVELS, 'neck'))
    const g = r.garment, b = r.body
    // the neckline and shoulders are drafted by the pattern (an off-shoulder band measures the arms)
    if (at < LEVELS.indexOf('underbust') || !Array.isArray(g) || !Array.isArray(b) || !g.every(unit) || !b.every(unit)) return []
    const bw = Number(b[1]) - Number(b[0]), gw = Number(g[1]) - Number(g[0])
    if (bw < 0.01 || gw <= 0) return []
    return [{ at, ratio: Math.min(3, Math.max(0.92, gw / bw)) }]
  }).sort((p, q) => p.at - q.at)
  // a median over neighbouring levels: one wide reading (a cut-out or a hand at the waist read as
  // garment) put a band of spare cloth round a bodycon dress's waist that buckled into a fold
  const smooth = out.map((e, i) => {
    const near = out.slice(Math.max(0, i - 1), i + 2).map((n) => n.ratio).sort((a, b) => a - b)
    return { ...e, ratio: near[(near.length - 1) >> 1] }
  })
  return smooth.length >= 2 ? smooth : undefined
}

/** A position on LEVELS as a name for the UI ("knee", or "knee → below knee"). */
export const levelName = (p: number) => {
  const i = Math.floor(p), t = p - i
  return t < 0.2 || i >= LEVELS.length - 1 ? LEVELS[Math.min(i, LEVELS.length - 1)].replace('_', ' ') : t > 0.8 ? LEVELS[i + 1].replace('_', ' ') : `${LEVELS[i].replace('_', ' ')} → ${LEVELS[i + 1].replace('_', ' ')}`
}
