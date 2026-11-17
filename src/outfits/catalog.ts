import type { Gender } from '../body/bodySet'
import type { Fabric } from '../cloth/garmentSpec'
import type { ShoePalette } from '../scene/figure'

export type Cut = 'shirt' | 'jeans' | 'trench' | 'turtleneck' | 'overshirt' | 'maxi' | 'waistcoat' | 'croppedBlazer' | 'pleatedTrousers' | 'doubleBlazer' | 'flaredTrousers'
export type Print = 'stripe' | 'pinstripe' | 'brocade'
export interface PieceStyle { cut: Cut; name: string; color: string; fabric: Fabric; print?: Print }
export interface GuideOutfit { id: string; name: string; reference: string; genders: Gender[]; pieces: PieceStyle[]; shoes?: ShoePalette }

// Ordered from skin outward. Tucked shirts precede trousers so the waistband clears their hem.
export const GUIDE_OUTFITS: GuideOutfit[] = [
  // the guide's chunky taupe runners with cream midsoles
  { id: 'trench', name: 'Trench & denim', reference: '736690451593714112.jpeg', genders: ['female', 'male'],
    shoes: { upper: '#cfc4b6', panel: '#a99a8a', sole: '#ece6da', soleLine: '#b9ae9e', laces: '#e6dfd3' }, pieces: [
    { cut: 'shirt', name: 'Blue button shirt', color: '#b7d0e1', fabric: 'cotton' },
    { cut: 'jeans', name: 'Wide-leg jeans', color: '#547b9a', fabric: 'denim' },
    { cut: 'trench', name: 'Chocolate wool coat', color: '#3a2720', fabric: 'wool' },
  ] },
  { id: 'stripes', name: 'Stripes & charcoal', reference: '531072981083768866.jpeg', genders: ['female'], pieces: [
    { cut: 'turtleneck', name: 'Brown turtleneck', color: '#30291e', fabric: 'knit' },
    { cut: 'maxi', name: 'Pleated maxi skirt', color: '#373637', fabric: 'linen' },
    { cut: 'overshirt', name: 'Striped overshirt', color: '#684436', fabric: 'cotton', print: 'stripe' },
  ] },
  { id: 'navy', name: 'Navy brocade suit', reference: '1008947122800140531.jpeg', genders: ['male', 'female'], pieces: [
    { cut: 'shirt', name: 'Blue button shirt', color: '#b7c7d6', fabric: 'cotton' },
    { cut: 'pleatedTrousers', name: 'Pleated navy trousers', color: '#1d304b', fabric: 'synthetic' },
    { cut: 'waistcoat', name: 'Navy waistcoat', color: '#1d304b', fabric: 'synthetic' },
    { cut: 'croppedBlazer', name: 'Cropped brocade blazer', color: '#1d304b', fabric: 'synthetic', print: 'brocade' },
  ] },
  { id: 'brown', name: 'Brown pinstripe suit', reference: '301670875065678004.jpeg', genders: ['male'], pieces: [
    { cut: 'shirt', name: 'Ivory button shirt', color: '#e7e2d8', fabric: 'cotton' },
    { cut: 'flaredTrousers', name: 'Flared pinstripe trousers', color: '#634139', fabric: 'synthetic', print: 'pinstripe' },
    { cut: 'doubleBlazer', name: 'Double-breasted blazer', color: '#634139', fabric: 'synthetic', print: 'pinstripe' },
  ] },
]
