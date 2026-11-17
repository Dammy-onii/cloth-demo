// A garment read from a photo (GarmentRead), drafted as a pattern on this body: every length is a
// body landmark (hem at the knee, sleeve to the elbow) placed on this mannequin's own knee and elbow.
import type { BodySet, Size } from '../body/bodySet'
import { planarUV, type Garment } from '../cloth/buildGarment'
import { LEVELS, type GarmentRead } from '../cloth/garmentRead'
import type { Landmarks } from '../cloth/garmentSpec'
import { assemble, bodyLookup, type Piece, type Seam } from './assemble'
import { BodyFrame, offShoulderDress } from './drafts'
import { aSkirt, dress, gown, petticoat, top, trousers } from './garments'
import { underFrom } from './index'
import { landmarkUV, type Crop } from './photoMap'
import { chartDraft } from './chart'

const SPACING = 0.02
// tight sits on the skin (a bodycon dress or a fitted knit); 8 mm still read as loose
const EASE = { tight: 0.003, regular: 0.018, relaxed: 0.03, oversized: 0.045 } as const
const NECK = {
  crew: { width: 0.012, front: 0.07, back: 0.02 },
  turtleneck: { width: 0.004, front: 0.03, back: 0.015 },
  collar: { width: 0.012, front: 0.06, back: 0.02 },
  scoop: { width: 0.03, front: 0.13, back: 0.04 },
  v: { width: 0.02, front: 0.16, back: 0.03 },
  boat: { width: 0.05, front: 0.035, back: 0.03 },
} as const

/** This body's height (m) at each of LEVELS. */
export function levelHeights(f: BodyFrame): number[] {
  const sh = f.J['upperarm01.L'][1]
  const hps = f.neckY - 0.004
  const waist = f.waistY(sh - 0.1)
  const bust = f.bustY(waist, sh - 0.04)
  // the knee is ~0.55 of the hip joint's height (no knee joint is exported), the ankle bone ~8.5 cm up
  const knee = 0.55 * f.hipY, ankle = 0.085
  // a hem "at the crotch" just covers it: level with the crotch point, the underwear showed below it
  const ys = [hps, hps - 0.045, bust - 0.07, waist, (waist + f.hipY) / 2, f.hipY, f.crotchY - 0.035, (f.crotchY + knee) / 2, knee + 0.06, knee, knee - 0.06, (knee + ankle) / 2, ankle, 0.02]
  for (let i = 1; i < ys.length; i++) ys[i] = Math.min(ys[i], ys[i - 1] - 0.01)
  return ys
}

export const at = (ys: number[], p: number) => {
  const i = Math.max(0, Math.min(LEVELS.length - 2, Math.floor(p))), t = Math.max(0, Math.min(1, p - i))
  return ys[i] + (ys[i + 1] - ys[i]) * t
}

/** The position on LEVELS of height y on this body (the inverse of `at`). */
const positionOf = (ys: number[], y: number) => {
  for (let i = 0; i < ys.length - 1; i++) if (y >= ys[i + 1]) return i + Math.max(0, (ys[i] - y) / (ys[i] - ys[i + 1]))
  return ys.length - 1
}

/**
 * Ease at each height from how the garment sat on the wearer in the photo: its width over the body's at
 * the levels Claude measured, applied to this body's own width at the same levels. A bodycon dress
 * (≈1.0) sits on the skin; a boxy tunic (1.2+) stands off it. Undefined without measurements.
 */
function easeFromPhoto(g: GarmentRead, f: BodyFrame, ys: number[]) {
  const w = g.widths
  if (!w) return undefined
  const ratio = (p: number) => {
    if (p <= w[0].at) return w[0].ratio
    if (p >= w[w.length - 1].at) return w[w.length - 1].ratio
    const k = w.findIndex((e) => e.at > p)
    const a = w[k - 1], b = w[k]
    return a.ratio + (b.ratio - a.ratio) * (p - a.at) / (b.at - a.at || 1)
  }
  return (y: number) => Math.min(0.15, Math.max(0.002, (ratio(positionOf(ys, y)) - 1) * f.torso(y).a))
}

/** Sleeve length (m from the shoulder joint) for a position down the arm (0 shoulder, 1 elbow, 2 wrist). */
export function armLength(f: BodyFrame, a: number) {
  const sh = f.J['upperarm01.L'], el = f.J['lowerarm01.L'], wr = f.J['wrist.L']
  const l1 = Math.hypot(el[0] - sh[0], el[1] - sh[1], el[2] - sh[2]), l2 = Math.hypot(wr[0] - el[0], wr[1] - el[1], wr[2] - el[2])
  return a <= 1 ? a * l1 : l1 + (a - 1) * l2
}

export interface CustomPhoto { uv: 'photo'; landmarks?: Record<string, [number, number] | undefined>; crop?: Crop; torso?: [number, number] }

/** True when the garment leaves the shoulders bare (a bandeau bra underneath, no straps). */
export const baresShoulders = (g: GarmentRead) => g.slot !== 'bottom' && (g.neckline === 'strapless' || g.neckline === 'off_shoulder')

export function buildCustom(g: GarmentRead, body: BodySet, size: Size, photo?: CustomPhoto, lift?: Float32Array): Garment {
  const f = new BodyFrame(body, size)
  const ys = levelHeights(f)
  const lookup = bodyLookup(body.positions(size, 'apose'), body.labels, body.segments)
  const ignoreOf = (names: string[]) => { const s = names.map((n) => body.segment(n)); return body.labels.map((l) => (s.includes(l) ? 1 : 0)) }
  const hands = ignoreOf(['forearm', 'hand']), arms = ignoreOf(['upperarm', 'forearm', 'hand'])
  // tight knits are cut smaller than the body and stretched on (Piece.stretch); fitted sleeves too
  const stretchy = ['jersey', 'knit', 'synthetic', 'silk'].includes(g.fabric)
  const sew = (d: { pieces: Piece[]; seams: Seam[]; band?: [string, number][] }) => {
    for (const p of d.pieces) {
      const sleevePiece = p.name.startsWith('sleeve')
      if (sleevePiece ? g.sleeveWidth === 'fitted' : g.fit === 'tight') p.stretch = stretchy ? 0.05 : 0.02
    }
    return assemble(d.pieces, d.seams, { spacing: SPACING, band: d.band }, lookup)
  }
  const hemY = Math.max(0.1, at(ys, g.hem))
  const ease = EASE[g.fit] + (g.slot === 'outer' ? 0.02 : 0)
  const easeAt = easeFromPhoto(g, f, ys)
  const slimSleeves = g.sleeveWidth === 'fitted'
  // a skirt's hem as wide as the photo shows it: the body's own width there times the garment's ratio
  const girthAt = (y: number, fallback: number) => {
    if (!easeAt) return fallback
    const s0 = f.torso(y), e = easeAt(y)
    return Math.PI * (s0.a + s0.b + 2 * e)
  }
  const sleeveLen = g.sleeveAt < 0.1 ? 0 : armLength(f, g.sleeveAt)
  const sleeve = sleeveLen === 0 ? 'none' : g.sleeveAt > 1.6 ? 'long' : 'short'

  if (g.slot === 'bottom') {
    if (g.bottomKind === 'skirt') {
      const room = f.hip + 0.06 + 0.5 * Math.max(0, f.crotchY - 0.14 - hemY)
      const girth = Math.max(room, f.hip * (g.skirt === 'straight' ? 1 : g.skirt === 'full' ? 2.2 : 1.5))
      return { ...sew(aSkirt(f, { hemY, hemGirth: girth })), lift, ignore: arms }
    }
    // the leg's own girth at the hem, plus room by cut
    const legGirth = 2 * Math.PI * f.leg(hemY).r
    const cut = { skinny: { ease: 0.035, hem: legGirth + 0.05 }, straight: { ease: 0.08, hem: 0.42 }, wide: { ease: 0.16, hem: 0.7 }, flared: { ease: 0.09, hem: 0.62 } }[g.legs]
    const shorts = hemY > 0.3
    const hemGirth = Math.max(cut.hem, legGirth + (shorts ? 0.1 : 0.06), shorts ? f.thigh * 1.2 : 0)
    const d = trousers(f, { hemY, legEase: cut.ease + (g.fit === 'oversized' ? 0.04 : 0), hemGirth, hipEase: g.fit === 'tight' ? 0.012 : 0.018, drop: 0.035 })
    return { ...sew(d), lift, ignore: arms }
  }

  const under = underFrom(body, size, lift)
  let garment: Garment
  const grip = g.fit === 'tight' ? 0.75 : undefined
  // drawn from the photo's own structure when Claude traced it (docs/garment-mapping.md)
  if (g.structure) {
    const ch = chartDraft(f, g, g.structure, g.joints)
    garment = { ...sew(ch), lift, ignore: hands, bandTether: ch.elastic ? 0.25 : undefined, friction: grip }
    // fitted cloth grips the skin down the whole body panel, not just at its top edge
    if (grip) garment.grip = Float32Array.from(garment.noTurn ?? [], (t) => (t ? 0.04 : 0))
    if (photo?.crop) garment.photoUV = ch.photoUV(garment, photo.crop)
    return garment
  }
  let waistY = at(ys, g.slot === 'dress' ? g.waistSeam : LEVELS.indexOf('waist'))
  const bare = baresShoulders(g)
  if (bare && sleeve !== 'none') {
    // off the shoulder with sleeves: the bodice sits across the upper arms; gathered if the photo shows ruching
    // ruched at 1.35× the front tore open across the waist: a little gathering reads as drape
    // the front cut longer than the back (ruching) tore open across the waist when sewn: cut level
    garment = { ...sew(offShoulderDress(f, { hemY, sleeveLength: sleeveLen, ruche: 1, tight: g.fit === 'tight' || slimSleeves, gapAt: easeAt })), lift, ignore: hands, bandTether: 0.25 }
  } else if (bare) {
    // strapless: the gown's boned bodice, with a skirt to the hem (a short one on a top)
    const room = f.hip + 0.06 + 0.5 * Math.max(0, f.crotchY - 0.14 - hemY)
    const full = g.skirt === 'full' ? 2.2 : g.skirt === 'straight' ? 1 : 1.5
    const girth = Math.max(room, f.hip * full)
    const h = g.slot === 'dress' ? hemY : Math.min(hemY, waistY - 0.06)
    garment = { ...sew(gown(f, { hemY: h, hemGirth: girth })), lift: girth > 2 * f.hip && h < 0.35 ? petticoat(f, body.positions(size, 'apose'), body.index, body.labels, ['upperleg', 'lowerleg'].map((n) => body.segment(n))) : lift, ignore: hands, bandTether: 0.25 }
  } else if (g.slot === 'dress') {
    // a drop waist stays above the skirt's hip line
    waistY = Math.max(f.hipY + 0.04, waistY)
    const room = f.hip + 0.06 + 0.5 * Math.max(0, f.crotchY - 0.14 - hemY)
    // two panels gathered past 2.4× the hip crumpled in heaps at the floor
    const girth = Math.max(easeAt ? 0 : room, girthAt(hemY, f.hip * (g.skirt === 'straight' ? 1 : g.skirt === 'full' ? 2.2 : 1.5)))
    const neck = sleeve === 'none' ? { width: 0.035, front: Math.max(0.14, NECK[g.neckline as keyof typeof NECK].front), back: 0.06 } : NECK[g.neckline as keyof typeof NECK]
    const d = dress(f, { ease, sleeve, sleeveLength: sleeveLen || undefined, neck, strap: sleeve === 'none' ? 0.04 : undefined, hemY, hemGirth: girth, waistY, easeAt, slimSleeves })
    const full = girth > 2 * f.hip && hemY < 0.35
    garment = { ...sew(d), lift: full ? petticoat(f, body.positions(size, 'apose'), body.index, body.labels, ['upperleg', 'lowerleg'].map((n) => body.segment(n))) : lift, ignore: hands }
  } else {
    const neck = sleeve === 'none' ? { width: 0.035, front: Math.max(0.12, NECK[g.neckline as keyof typeof NECK].front), back: 0.06 } : NECK[g.neckline as keyof typeof NECK]
    const d = top(f, { ease, hem: hemY - f.hipY, sleeve, sleeveLength: sleeveLen || undefined, neck, strap: sleeve === 'none' ? 0.045 : undefined, under, easeAt, slimSleeves })
    garment = { ...sew(d), lift, ignore: hands }
  }
  if (photo) garment.photoUV = photoUV(garment, f, photo, { waistY, hemY, sleeveLength: sleeveLen })
  return garment
}

function photoUV(g: Garment, f: BodyFrame, photo: CustomPhoto, o: { waistY: number; hemY: number; sleeveLength: number }) {
  const m = photo.landmarks
  const keys = ['neck', 'shoulderL', 'shoulderR', 'waistL', 'waistR', 'hemL', 'hemR'] as const
  if (!m || !photo.crop || keys.some((k) => !m[k])) return planarUV(g.rest, photo.torso)
  const sh = f.J['upperarm01.L'], wr = f.J['wrist.L']
  const len = Math.hypot(wr[0] - sh[0], wr[1] - sh[1]) || 1
  const hps = f.neckY - 0.004
  // sleeves are the pieces that turn with the arms; body panels and skirts don't
  const sleeve = (v: number) => o.sleeveLength > 0 && !g.noTurn?.[v] && g.rest[v * 3 + 1] > o.waistY
  return landmarkUV(g.rest, sleeve, {
    neckY: hps, shoulderY: hps - 0.045, shoulderX: Math.abs(sh[0]) + 0.01, waistY: Math.min(Math.max(o.waistY, o.hemY + 0.03), hps - 0.1), hemY: o.hemY,
    arm: [(wr[0] - sh[0]) / len, (wr[1] - sh[1]) / len], sleeveLength: Math.max(0.05, o.sleeveLength),
  }, m as unknown as Landmarks, photo.crop)
}
