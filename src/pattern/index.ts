// Pattern garments: draft from the body, assemble the pieces, hand the result to the cloth solver.
import type { BodySet, Size } from '../body/bodySet'
import type { Garment } from '../cloth/buildGarment'
import { assemble, bodyLookup, type Piece, type Seam } from './assemble'
import { BodyFrame, campShirt, offShoulderDress } from './drafts'
import { aSkirt, gown, petticoat, top, trousers } from './garments'

export type PatternKind = 'campShirt' | 'wideShorts' | 'offShoulderDress' | 'tee' | 'henley' | 'tank' | 'chinos' | 'cargoShorts' | 'aSkirt' | 'gown'

// mesh spacing (m): fine enough for folds, coarse enough to simulate at interactive rates
const SPACING = 0.02

export function buildPattern(kind: PatternKind, body: BodySet, size: Size, lift?: Float32Array): Garment {
  const frame = new BodyFrame(body, size)
  const lookup = bodyLookup(body.positions(size, 'apose'), body.labels, body.segments)
  const hands = ['forearm', 'hand'].map((n) => body.segment(n))
  if (kind === 'offShoulderDress') {
    const { pieces, seams, band } = offShoulderDress(frame)
    // the off-shoulder elastic has to hold the bodice up on its own: no shoulders to hang from
    return { ...assemble(pieces, seams, { spacing: SPACING, band }, lookup), lift, ignore: body.labels.map((l) => (hands.includes(l) ? 1 : 0)), bandTether: 0.25 }
  }
  const handsIgnore = body.labels.map((l) => (hands.includes(l) ? 1 : 0))
  const arms = ['upperarm', 'forearm', 'hand'].map((n) => body.segment(n))
  const armsIgnore = body.labels.map((l) => (arms.includes(l) ? 1 : 0))
  const under = underFrom(body, size, lift)
  const sew = (d: { pieces: Piece[]; seams: Seam[]; band?: [string, number][] }) => assemble(d.pieces, d.seams, { spacing: SPACING, band: d.band }, lookup)
  switch (kind) {
    case 'tee':
      return { ...sew(top(frame, { ease: 0.025, hem: -0.05, sleeve: 'short', neck: { width: 0.012, front: 0.07, back: 0.02 }, under })), lift, ignore: handsIgnore }
    case 'henley':
      return { ...sew(top(frame, { ease: 0.02, hem: -0.07, sleeve: 'long', neck: { width: 0.012, front: 0.08, back: 0.02 }, under })), lift, ignore: handsIgnore }
    case 'tank':
      return { ...sew(top(frame, { ease: 0.008, hem: -0.02, sleeve: 'none', neck: { width: 0.035, front: 0.14, back: 0.06 }, strap: 0.045, under })), lift, ignore: handsIgnore }
    // bottoms pass through the arms (hands at the hips sit inside the ease)
    case 'wideShorts':
      return { ...sew(trousers(frame, { hemY: 0.56 * frame.hipY, legEase: 0.12, hemGirth: frame.thigh * 1.4, hipEase: 0.02, drop: 0.045 })), lift, ignore: armsIgnore }
    // chinos: a slight break where the hem meets the shoe
    case 'chinos':
      return { ...sew(trousers(frame, { hemY: 0.085, legEase: 0.1, hemGirth: 0.4, hipEase: 0.016, drop: 0.03 })), lift, ignore: armsIgnore }
    case 'cargoShorts':
      return { ...sew(trousers(frame, { hemY: 0.6 * frame.hipY, legEase: 0.14, hemGirth: 0.5, hipEase: 0.016, drop: 0.04 })), lift, ignore: armsIgnore }
    case 'aSkirt':
      return { ...sew(aSkirt(frame, { hemY: 0.28 * frame.hipY, hemGirth: 1.8 * frame.hip })), lift, ignore: armsIgnore }
    // a strapless bodice has to be held up by its top edge alone
    case 'gown':
      return {
        ...sew(gown(frame)),
        lift: petticoat(frame, body.positions(size, 'apose'), body.index, body.labels, ['upperleg', 'lowerleg'].map((n) => body.segment(n))),
        ignore: handsIgnore,
        bandTether: 0.25,
      }
  }
  const { pieces, seams } = campShirt(frame)
  return { ...assemble(pieces, seams, { spacing: SPACING }, lookup), lift, ignore: handsIgnore }
}

/** Thickness of the bottom underneath (its skin clearance) by height, for a top to clear. */
export function underFrom(body: BodySet, size: Size, lift?: Float32Array) {
  if (!lift) return undefined
  const pos = body.positions(size, 'apose'), torso = body.segment('torso'), bins = new Float32Array(100)
  for (let v = 0; v < lift.length; v++) {
    if (body.labels[v] !== torso || !lift[v]) continue
    const i = Math.min(99, Math.max(0, Math.round(pos[v * 3 + 1] / 0.02)))
    bins[i] = Math.max(bins[i], lift[v])
  }
  // smoothed over ±4 cm so the top eases out over the waistband instead of stepping
  return (y: number) => {
    const i = Math.round(y / 0.02)
    let m = 0
    for (let k = -2; k <= 2; k++) m = Math.max(m, (bins[Math.min(99, Math.max(0, i + k))] ?? 0) * (1 - Math.abs(k) / 3))
    return m
  }
}
