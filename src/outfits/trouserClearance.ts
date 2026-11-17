import type { BodySet } from '../body/bodySet'

/** Front and rear contact for the seat and thighs. A nearest-vertex normal can
 * point into the other thigh at the crotch, pulling the seat through the body. */
export class TrouserClearance {
  private readonly columns = 64
  private readonly rows = 76
  private readonly front = new Float32Array(this.columns * this.rows).fill(-Infinity)
  private readonly back = new Float32Array(this.columns * this.rows).fill(Infinity)
  private readonly origin: number

  constructor(body: BodySet, positions: Float32Array, private readonly hip: number) {
    this.origin = hip - 0.52
    const labels = ['torso', 'upperleg', 'lowerleg'].map(name => body.segment(name))
    body.labels.forEach((label, i) => {
      if (!labels.includes(label)) return
      const p = i * 3, y = this.row(positions[p + 1]), x = this.column(positions[p])
      if (y < 0 || y >= this.rows || x < 0 || x >= this.columns) return
      const k = y * this.columns + x
      this.front[k] = Math.max(this.front[k], positions[p + 2])
      this.back[k] = Math.min(this.back[k], positions[p + 2])
    })
  }

  private row(y: number) { return Math.round((y - this.origin) / 0.012) }
  private column(x: number) { return Math.round(x / 0.012 + this.columns / 2) }

  project(points: Float32Array, rest: Float32Array) {
    for (let i = 0; i < points.length; i += 3) {
      if (rest[i + 1] > this.hip + 0.22 || rest[i + 1] < this.hip - 0.29) continue
      const y = this.row(points[i + 1]), x = this.column(points[i])
      if (y <= 0 || y >= this.rows - 1 || x <= 0 || x >= this.columns - 1) continue
      let front = -Infinity, back = Infinity
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const k = (y + dy) * this.columns + x + dx
        front = Math.max(front, this.front[k])
        back = Math.min(back, this.back[k])
      }
      if (!Number.isFinite(front) || front - back < 0.035) continue
      const mid = (front + back) / 2
      // Leave side seams free. They need lateral clearance, not a front/back push.
      const face = Math.abs(rest[i + 2] - mid)
      if (face < (front - back) * 0.24) continue
      if (rest[i + 2] > mid) points[i + 2] = Math.max(points[i + 2], front + 0.007)
      else points[i + 2] = Math.min(points[i + 2], back - 0.007)
    }
  }
}
