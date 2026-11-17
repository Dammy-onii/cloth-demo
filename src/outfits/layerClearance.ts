import type { Layer } from '../scene/stage'

const SECTORS = 32
const ROWS = 80
const row = (y: number) => Math.max(0, Math.min(ROWS - 1, Math.round(y / 0.025)))
const sector = (x: number, z: number) => Math.round((Math.atan2(z, x) / (2 * Math.PI) + 0.5) * SECTORS) % SECTORS

/** Local torso contact from the current inner cloth. Sleeves have their own body collisions. */
export class LayerClearance {
  private readonly radius = new Float32Array(ROWS * SECTORS)
  constructor(private readonly inner: readonly { layer: Layer; bottom: boolean }[]) {}

  project(cloth: Float32Array, rest: Float32Array, torso: Uint8Array) {
    this.radius.fill(0)
    for (const { layer, bottom } of this.inner) {
      const garment = layer.garment, points = layer.sim?.x
      if (!garment || !points) continue
      for (let i = 0; i < points.length; i += 3) {
        if (!bottom && !garment.noTurn?.[i / 3]) continue
        const x = points[i], y = points[i + 1], z = points[i + 2]
        const key = row(y) * SECTORS + sector(x, z)
        this.radius[key] = Math.max(this.radius[key], Math.hypot(x, z))
      }
    }
    for (let i = 0; i < cloth.length; i += 3) {
      if (!torso[i / 3]) continue
      const x = cloth[i], z = cloth[i + 2], r = Math.hypot(x, z)
      if (r < 0.005) continue
      const y = row(cloth[i + 1]), theta = sector(x, z)
      let target = 0
      for (let dy = -1; dy <= 1; dy++) {
        const j = y + dy
        if (j < 0 || j >= ROWS) continue
        for (let da = -1; da <= 1; da++) {
          const inside = this.radius[j * SECTORS + (theta + da + SECTORS) % SECTORS]
          if (inside) target = Math.max(target, inside + 0.012 - 0.003 * (Math.abs(dy) + Math.abs(da)))
        }
      }
      // Reject isolated folds far outside this panel's intended silhouette.
      target = Math.min(target, Math.hypot(rest[i], rest[i + 2]) + 0.075)
      if (target > r) {
        cloth[i] *= target / r
        cloth[i + 2] *= target / r
      }
    }
  }
}
