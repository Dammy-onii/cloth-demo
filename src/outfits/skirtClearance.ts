/** A skirt spans both legs. Project it outside their horizontal envelope without changing height. */
export class SkirtClearance {
  private readonly bins = new Float32Array(64 * 4)
  private readonly legs: number[] = []

  constructor(labels: Uint8Array, upperLeg: number, lowerLeg: number) {
    labels.forEach((label, i) => {
      if (label === upperLeg || label === lowerLeg) this.legs.push(i * 3)
    })
  }

  project(cloth: Float32Array, body: Float32Array, hipY: number) {
    const bin = (y: number) => Math.max(0, Math.min(63, Math.round(y / 0.025))) * 4
    const ranges = this.bins
    for (let k = 0; k < ranges.length; k += 4) {
      ranges[k] = ranges[k + 2] = Infinity
      ranges[k + 1] = ranges[k + 3] = -Infinity
    }
    for (const i of this.legs) {
      const k = bin(body[i + 1])
      ranges[k] = Math.min(ranges[k], body[i])
      ranges[k + 1] = Math.max(ranges[k + 1], body[i])
      ranges[k + 2] = Math.min(ranges[k + 2], body[i + 2])
      ranges[k + 3] = Math.max(ranges[k + 3], body[i + 2])
    }
    for (let i = 0; i < cloth.length; i += 3) {
      const y = cloth[i + 1]
      if (y > hipY) continue
      const k = bin(y)
      if (!Number.isFinite(ranges[k])) continue
      const cx = (ranges[k] + ranges[k + 1]) * 0.5
      const cz = (ranges[k + 2] + ranges[k + 3]) * 0.5
      // Ellipse enclosing the hip and both thighs, with a small clearance for the rendered skin.
      const a = (ranges[k + 1] - ranges[k]) * 0.63 + 0.018
      const b = (ranges[k + 3] - ranges[k + 2]) * 0.63 + 0.018
      const dx = cloth[i] - cx, dz = cloth[i + 2] - cz
      const radius = Math.hypot(dx / a, dz / b)
      if (radius > 0.001 && radius < 1) {
        cloth[i] = cx + dx / radius
        cloth[i + 2] = cz + dz / radius
      }
    }
  }
}
