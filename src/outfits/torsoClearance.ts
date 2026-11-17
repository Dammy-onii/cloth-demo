const SIDES = 48
const ROWS = 85
const row = (y: number) => Math.max(0, Math.min(ROWS - 1, Math.round(y / 0.022)))
const sector = (x: number, z: number) => Math.round((Math.atan2(z, x) / (2 * Math.PI) + 0.5) * SIDES) % SIDES

/** Posed torso skin surface for panels whose nearest body point can instead be an arm. */
export class TorsoClearance {
  private readonly radius = new Float32Array(ROWS * SIDES)

  constructor(positions: Float32Array, labels: Uint8Array, torso: number, neck: number) {
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] !== torso && labels[i] !== neck) continue
      const x = positions[i * 3], z = positions[i * 3 + 2]
      const k = row(positions[i * 3 + 1]) * SIDES + sector(x, z)
      this.radius[k] = Math.max(this.radius[k], Math.hypot(x, z))
    }
  }

  project(cloth: Float32Array, panel: Uint8Array) {
    for (let i = 0; i < cloth.length; i += 3) {
      if (!panel[i / 3]) continue
      const x = cloth[i], z = cloth[i + 2], r = Math.hypot(x, z)
      if (r < 0.004) continue
      const y = row(cloth[i + 1]), a = sector(x, z)
      let edge = 0
      for (let dy = -1; dy <= 1; dy++) {
        if (y + dy < 0 || y + dy >= ROWS) continue
        for (let da = -2; da <= 2; da++) {
          const d = this.radius[(y + dy) * SIDES + (a + da + SIDES) % SIDES]
          if (d) edge = Math.max(edge, d + 0.011 - 0.002 * (Math.abs(dy) + Math.abs(da)))
        }
      }
      if (edge > r) { cloth[i] *= edge / r; cloth[i + 2] *= edge / r }
    }
  }
}
