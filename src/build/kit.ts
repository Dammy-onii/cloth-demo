// What a pattern program gets to work with: the pattern library the workshop outfits are drafted with,
// measured on the body it is cut for. Programs are written by hand (src/build/programs) or by Claude from
// an uploaded photo (server/claude-bridge.mjs), and run in a worker (worker.ts). See docs/pattern-api.md.
import type { BodySet, Size } from '../body/bodySet'
import type { Fabric } from '../cloth/garmentSpec'
import { LEVELS } from '../cloth/garmentRead'
import type { Piece, Seam } from '../pattern/assemble'
import { at, armLength, levelHeights } from '../pattern/custom'
import { ARM, BodyFrame, LOWER, TORSO, mirror, offShoulderDress, offShoulderSleeves, smooth01 } from '../pattern/drafts'
import { aSkirt, dress, gown, sleevePair, top, trousers } from '../pattern/garments'

export type Print = 'denim' | 'rib' | 'crochet' | 'stripe' | 'pinstripe' | 'brocade' | 'plaid' | 'check'

/** One garment a program returns. Garments are worn in `layer` order, skin outward. */
export interface ProgramGarment {
  name: string
  /** 0 next to the skin; higher layers drape over lower ones */
  layer: number
  /** what it covers, for which skin it may pass through: a bottom ignores the arms, a top the hands */
  kind: 'top' | 'bottom' | 'dress' | 'outer'
  fabric: Fabric
  color: string
  /** a print's second colour (plaid and check lines, stripes) */
  color2?: string
  print?: Print
  /** 'tight' is stretched on and grips the skin (bodycon); looser fits hang */
  fit?: 'tight' | 'regular' | 'relaxed' | 'oversized'
  /** where it hangs from: shoulders, an elastic top edge (strapless, off-shoulder) or a waistband */
  hold?: 'shoulders' | 'neckline' | 'waist'
  pieces: Piece[]
  seams: Seam[]
  /** elastic edges (necklines, waistbands, cuffs): [piece name, edge] */
  band?: [string, number][]
}

export function makeKit(body: BodySet, size: Size) {
  const f = new BodyFrame(body, size)
  const ys = levelHeights(f)
  const sh = f.J['upperarm01.L']
  return {
    /** the body's measurements and cross-sections (see BodyFrame in src/pattern/drafts.ts) */
    f,
    /** body levels by name, as positions: L.knee, L.waist… (0 neck … 13 floor; fractions between) */
    L: Object.fromEntries(LEVELS.map((n, i) => [n, i])) as Record<(typeof LEVELS)[number], number>,
    /** height (m) of a level position on this body */
    level: (p: number) => at(ys, p),
    /** length (m) down the arm from the shoulder joint: 0 shoulder, 1 elbow, 2 wrist */
    arm: (t: number) => armLength(f, t),
    /** useful heights (m) */
    y: { neck: f.neckY - 0.004, shoulder: sh[1], hip: f.hipY, crotch: f.crotchY, knee: 0.55 * f.hipY, ankle: 0.085 },
    // drafts (src/pattern/garments.ts and drafts.ts)
    top, dress, gown, trousers, aSkirt, offShoulderDress, offShoulderSleeves, sleevePair,
    mirror, smooth01, TORSO, LOWER, ARM,
    clamp: (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v)),
  }
}
export type Kit = ReturnType<typeof makeKit>
