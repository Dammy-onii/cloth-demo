// White off-shoulder mini dress with long fitted sleeves, a waist cut-out on the body's right and a wrap hem.
// (Reference: a studio photo of a bodycon jersey mini; the neckline runs across the upper arms, a triangular
// cut-out opens the right side of the waist, and the wrapped skirt lifts towards the centre front.)
function build(kit) {
  const { f, L, level, arm, offShoulderDress } = kit
  const hemY = level(L.crotch) - 0.03
  // The front is cut level with the back (ruche 1): cut longer to suggest the ruching, its spare length
  // folded into a ledge across the hips, and the dress read as a separate bodice and skirt.
  const d = offShoulderDress(f, { hemY, sleeveLength: arm(2.05), ruche: 1, tight: true })
  const front = d.pieces.find((p) => p.name === 'front')
  // cut level, the front's pattern y is simply the height above the hem
  const py = (y) => y - hemY
  const q = Math.max(...front.outline.map((p) => p[0]))
  const waist = level(L.waist)
  // the cut-out: a triangle from the body-right side seam (front −x) in towards the navel
  front.holes = [[[-0.92 * q, py(waist - 0.035)], [-0.3 * q, py(waist + 0.02)], [-0.92 * q, py(waist + 0.07)]]]
  // the wrap: the hem lifts 3.5 cm towards the left of centre where the two layers cross
  front.paths = { 0: [[-0.6 * q, 0], [-0.15 * q, 0.035], [0.3 * q, 0]] }
  return [{ name: 'Off-shoulder cut-out mini dress', layer: 0, kind: 'dress', fabric: 'jersey', color: '#f1eee8', fit: 'tight', hold: 'neckline', ...d }]
}
