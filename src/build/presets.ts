// Outfits drafted as pattern programs, in the same form Claude writes them from a photo (docs/pattern-api.md).
// They are both wardrobe outfits and the examples Claude is shown.
import ribbedMaxiBolero from './programs/ribbedMaxiBolero.js?raw'
import denimBellTop from './programs/denimBellTop.js?raw'
import whiteCutoutMini from './programs/whiteCutoutMini.js?raw'
import type { Gender } from '../body/bodySet'

export interface ProgramOutfit { id: string; name: string; genders: Gender[]; source: string }

export const PROGRAM_OUTFITS: ProgramOutfit[] = [
  { id: 'ribbedMaxiBolero', name: 'Ribbed maxi & crochet bolero', genders: ['female'], source: ribbedMaxiBolero },
  { id: 'denimBellTop', name: 'Denim bell-sleeve top', genders: ['female', 'male'], source: denimBellTop },
  { id: 'whiteCutoutMini', name: 'White cut-out mini', genders: ['female'], source: whiteCutoutMini },
]
