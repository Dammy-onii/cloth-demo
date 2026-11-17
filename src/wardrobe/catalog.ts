// The wardrobe: casual tops and bottoms for both mannequins, plus a skirt and an evening gown for
// the female one. Each piece takes its fabric from a Wikimedia Commons photo (swatch + card made by
// tools/wardrobe/prepare.py); `tile` is the real-world size of one swatch repeat in metres.

import type { Gender } from '../body/bodySet'
import { DEFAULT_SPEC, type BottomSpec, type GarmentSpec } from '../cloth/garmentSpec'
import type { PatternKind } from '../pattern'

export interface Credit {
  title: string
  author: string
  license: string
  url: string
}

interface Base {
  id: string
  name: string
  genders: Gender[]
  /** fabric texture: public/wardrobe/<id>-swatch.jpg, card public/wardrobe/<id>-card.jpg */
  photo?: { tile: number; credit: Credit }
  /** sewn from a pattern (worn cloth that flows with the body) instead of cut from the body */
  pattern?: PatternKind
}

export type TopItem = Base & { slot: 'top' | 'dress'; spec: GarmentSpec }
export type BottomItem = Base & { slot: 'bottom'; spec: BottomSpec }
export type WardrobeItem = TopItem | BottomItem

const BOTH: Gender[] = ['female', 'male']
const commons = (file: string) => `https://commons.wikimedia.org/wiki/File:${file}`

export const WARDROBE: WardrobeItem[] = [
  { id: 'tee', name: 'Plain tee', slot: 'top', genders: BOTH, pattern: 'tee', spec: DEFAULT_SPEC },
  {
    id: 'campShirt', name: 'Camp-collar shirt', slot: 'top', genders: BOTH, pattern: 'campShirt',
    spec: { ...DEFAULT_SPEC, category: 'camp shirt', sleeve: 'short', neckline: 'collar', fit: 'relaxed', fabric: 'synthetic', primaryColor: '#1c1c1e', description: 'Black camp-collar shirt, boxy with short sleeves' },
  },
  {
    id: 'henley', name: 'Long-sleeve henley', slot: 'top', genders: BOTH, pattern: 'henley',
    spec: { ...DEFAULT_SPEC, category: 'henley', sleeve: 'long', fabric: 'knit', primaryColor: '#e7e4dc', description: 'Ribbed long-sleeve henley' },
    photo: { tile: 0.08, credit: { title: 'Klassisches Henley Shirt.jpg', author: 'Bwilke', license: 'CC BY-SA 4.0', url: commons('Klassisches_Henley_Shirt.jpg') } },
  },
  {
    id: 'tank', name: 'Tank top', slot: 'top', genders: BOTH, pattern: 'tank',
    spec: { ...DEFAULT_SPEC, category: 'tank', sleeve: 'none', neckline: 'scoop', fit: 'tight', primaryColor: '#f2a516', description: 'Fitted yellow cotton-jersey tank top' },
    photo: { tile: 0.2, credit: { title: 'Tagless yellow shirt.jpg', author: 'Talinee', license: 'CC BY-SA 3.0', url: commons('Tagless_yellow_shirt.jpg') } },
  },
  {
    id: 'wideShorts', name: 'Wide shorts', slot: 'bottom', genders: BOTH, pattern: 'wideShorts',
    spec: { style: 'shorts', fit: 'relaxed', fabric: 'cotton', primaryColor: '#1d1d20' },
  },
  {
    id: 'chinos', name: 'Chinos', slot: 'bottom', genders: BOTH, pattern: 'chinos',
    spec: { style: 'trousers', fit: 'relaxed', fabric: 'cotton', primaryColor: '#bdb8a6' },
    photo: { tile: 0.15, credit: { title: 'Chino pants.jpg', author: 'Kuha455405', license: 'CC BY-SA 3.0', url: commons('Chino_pants.jpg') } },
  },
  {
    id: 'shorts', name: 'Cargo shorts', slot: 'bottom', genders: BOTH, pattern: 'cargoShorts',
    spec: { style: 'shorts', fit: 'relaxed', fabric: 'cotton', primaryColor: '#b8954f' },
    photo: { tile: 0.12, credit: { title: 'Cargo shorts.jpg', author: 'Punker1999', license: 'CC0', url: commons('Cargo_shorts.jpg') } },
  },
  {
    id: 'skirt', name: 'Floral A-line skirt', slot: 'bottom', genders: ['female'], pattern: 'aSkirt',
    spec: { style: 'skirt', fit: 'regular', fabric: 'linen', primaryColor: '#efe8ea' },
    photo: { tile: 0.3, credit: { title: 'Longskirt(Flaretype Flourpattern).jpg', author: '芹丘智美', license: 'CC BY-SA 4.0', url: commons('Longskirt(Flaretype_Flourpattern).jpg') } },
  },
  {
    id: 'offShoulder', name: 'Off-shoulder dress', slot: 'dress', genders: ['female'], pattern: 'offShoulderDress',
    spec: { ...DEFAULT_SPEC, category: 'off-shoulder dress', sleeve: 'long', neckline: 'boat', length: 'tunic', fit: 'tight', fabric: 'jersey', primaryColor: '#6e1a2a', description: 'Burgundy jersey off-shoulder mini dress: long gathered sleeves, ruched front skirt' },
  },
  {
    id: 'gown', name: 'Evening gown', slot: 'dress', genders: ['female'], pattern: 'gown',
    spec: { ...DEFAULT_SPEC, category: 'gown', sleeve: 'none', neckline: 'strapless', length: 'floor', fit: 'tight', fabric: 'silk', primaryColor: '#b3121a', trimColor: '#ead2c4', description: 'Red satin ball gown after House of Worth: strapless sweetheart bodice with a pale draped neckline band, full pleated skirt' },
    photo: { tile: 0.15, credit: { title: 'Ball gown - MET C.I.57.17.9a, b.jpg', author: 'House of Worth (The Metropolitan Museum of Art)', license: 'CC0', url: commons('Ball_gown_-_MET_C.I.57.17.9a,_b.jpg') } },
  },
]

/** Preset outfits per mannequin: [label, top or dress id, bottom id]. */
export const OUTFITS: Record<Gender, [string, string, string?][]> = {
  female: [['Camp shirt & shorts', 'campShirt', 'wideShorts'], ['Henley & chinos', 'henley', 'chinos'], ['Tank & shorts', 'tank', 'shorts'], ['Tank & skirt', 'tank', 'skirt'], ['Off-shoulder dress', 'offShoulder'], ['Evening gown', 'gown']],
  male: [['Camp shirt & shorts', 'campShirt', 'wideShorts'], ['Henley & chinos', 'henley', 'chinos'], ['Tank & shorts', 'tank', 'shorts'], ['Tee & chinos', 'tee', 'chinos']],
}

export const item = (id: string) => WARDROBE.find((w) => w.id === id)
