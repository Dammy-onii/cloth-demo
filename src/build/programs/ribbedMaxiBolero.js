// Brown ribbed strapless maxi dress under a cream crochet bolero with long bell sleeves.
// (Reference outfit: a flat-lay of a strapless rib-knit dress, ruched at the bust, flaring gently to the
// ankle, and a cropped open-knit shrug that only covers the shoulders and upper chest.)
function build(kit) {
  const { f, L, level, arm, gown, top, y } = kit
  // The dress: the gown's boned strapless bodice holds it up by its elastic top edge; its skirt flares
  // gently (1.7× the hip girth at the hem) to just above the ankle.
  const dress = gown(f, { hemY: level(L.ankle) + 0.05, hemGirth: f.hip * 1.7 })
  // The bolero: a wide boat-neck top cropped 3.5 cm under the arms, so it covers only the shoulders and
  // the top of the chest, with bell sleeves running past the wrist and opening to 42 cm round.
  const underY = y.shoulder - 0.09
  const bolero = top(f, {
    ease: 0.03, hem: underY - 0.035 - f.hipY, sleeve: 'long', sleeveLength: arm(2.15), sleeveHemHalf: 0.21,
    neck: { width: 0.06, front: 0.03, back: 0.02 },
  })
  return [
    { name: 'Ribbed strapless maxi dress', layer: 0, kind: 'dress', fabric: 'knit', color: '#5b3826', print: 'rib', fit: 'tight', hold: 'neckline', ...dress },
    { name: 'Crochet bolero', layer: 1, kind: 'outer', fabric: 'knit', color: '#e6d9c0', print: 'crochet', fit: 'relaxed', hold: 'shoulders', ...bolero },
  ]
}
