// Dark denim top with an asymmetric hem and wide bell sleeves, over cream wide-leg trousers.
// (Reference: a flat-lay of a fitted crew-neck denim top whose hem slants from the waist on the body's
// left down to a point at the right hip, with flared sleeves past the wrist.)
function build(kit) {
  const { f, L, level, arm, top, trousers } = kit
  // The hem line sits at the high hip on the short (body-left) side; across the front it slants down to a
  // point 15 cm lower just inside the body-right side seam (u = −1 is the body's right).
  const hemDrop = (u) => {
    const slant = Math.min(1, Math.max(0, (1 - u) / 1.85))
    const tip = u < -0.85 ? (u + 1) / 0.15 : 1
    return 0.15 * slant * tip
  }
  const denimTop = top(f, {
    ease: 0.016, hem: level(L.high_hip) - f.hipY, sleeve: 'long', sleeveLength: arm(2.2), sleeveHemHalf: 0.19,
    neck: { width: 0.008, front: 0.045, back: 0.015 }, hemDrop,
  })
  const wideLegs = trousers(f, { hemY: 0.09, legEase: 0.16, hemGirth: 0.66, hipEase: 0.02, drop: 0.05 })
  return [
    { name: 'Cream wide-leg trousers', layer: 0, kind: 'bottom', fabric: 'cotton', color: '#e7dfcf', fit: 'relaxed', hold: 'waist', ...wideLegs },
    { name: 'Denim bell-sleeve top', layer: 1, kind: 'top', fabric: 'denim', color: '#1f2c4f', print: 'denim', fit: 'regular', hold: 'shoulders', ...denimTop },
  ]
}
