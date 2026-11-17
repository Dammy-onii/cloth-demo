import type { Garment } from '../cloth/buildGarment'

/** Fit the sleeve cap to its sewn armhole before applying gravity. Spread the cap correction
 * over the upper sleeve, leaving the elbow and cuff on their posed arm. */
export function fitArmholes(garment: Garment): Garment {
  const { seams, noTurn, rest } = garment
  if (!seams || !noTurn) return garment
  const cap = new Map<number, number[]>()
  for (let i = 0; i < seams.length; i += 2) {
    let a = seams[i], b = seams[i + 1]
    if (!!noTurn[a] === !!noTurn[b]) continue
    if (noTurn[a]) [a, b] = [b, a]
    const ends = cap.get(a) ?? []
    ends.push(b)
    cap.set(a, ends)
  }
  if (!cap.size) return garment
  const delta = [...cap].map(([a, ends]) => {
    const i = a * 3
    const average = (k: number) => ends.reduce((sum, b) => sum + rest[b * 3 + k], 0) / ends.length
    return { a, x: average(0) - rest[i], y: average(1) - rest[i + 1], z: average(2) - rest[i + 2] }
  })
  const fitted = rest.slice()
  for (let vertex = 0; vertex < garment.src.length; vertex++) {
    if (noTurn[vertex]) continue
    const i = vertex * 3
    let x = 0, y = 0, z = 0, weights = 0, strongest = 0
    for (const move of delta) {
      const p = move.a * 3
      const distance = Math.hypot(rest[i] - rest[p], rest[i + 1] - rest[p + 1], rest[i + 2] - rest[p + 2])
      if (distance < 1e-6) { x = move.x; y = move.y; z = move.z; weights = strongest = 1; break }
      if (distance >= 0.105) continue
      const taper = (1 - distance / 0.105) ** 2
      const w = taper / (distance * distance)
      x += move.x * w; y += move.y * w; z += move.z * w
      weights += w
      strongest = Math.max(strongest, taper)
    }
    if (!weights) continue
    const scale = strongest / weights
    fitted[i] += x * scale; fitted[i + 1] += y * scale; fitted[i + 2] += z * scale
  }
  return { ...garment, rest: fitted }
}
