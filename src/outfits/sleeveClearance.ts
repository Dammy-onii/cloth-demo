import { Vector3 } from 'three'
import type { Vec3 } from '../body/bodySet'
import type { Garment } from '../cloth/buildGarment'
import type { Layer } from '../scene/stage'

const BINS = 20
const SIDES = 12

/** Match sleeve clearance along each posed bone, rather than by world height. */
export class SleeveClearance {
  private readonly radius = new Float32Array(BINS * 4 * SIDES)
  private readonly skin: Pick<Garment, 'src' | 'noTurn'>
  private readonly bones: { start: Vector3; axis: Vector3; normal: Vector3; tangent: Vector3; length: number }[]
  constructor(joints: Record<string, Vec3>, private readonly inner: Layer | undefined, private readonly labels: Uint8Array, private readonly upper: number, private readonly fore: number, private readonly apose: Float32Array, private readonly body: Float32Array) {
    this.skin = { src: Uint32Array.from(labels, (_, index) => index) }
    this.bones = ['L', 'R'].flatMap(side => {
      const shoulder = new Vector3(...joints[`upperarm01.${side}`])
      const elbow = new Vector3(...joints[`lowerarm01.${side}`])
      const wrist = new Vector3(...joints[`wrist.${side}`])
      return [[shoulder, elbow], [elbow, wrist]].map(([start, end]) => {
        const axis = end.clone().sub(start).normalize()
        const normal = new Vector3(0, 0, 1).cross(axis).normalize()
        return { start, axis, normal, tangent: axis.clone().cross(normal), length: end.distanceTo(start) }
      })
    })
  }

  project(cloth: Float32Array, outer: Garment) {
    const inner = this.inner?.garment, points = this.inner?.sim?.x
    this.radius.fill(0)
    const visit = (positions: Float32Array, garment: Pick<Garment, 'src' | 'noTurn'>, push: boolean) => {
      garment.src.forEach((source, i) => {
        const label = this.labels[source]
        if (garment.noTurn?.[i] || (label !== this.upper && label !== this.fore)) return
        const side = this.apose[source * 3] >= 0 ? 0 : 2
        const p = i * 3
        let b = side, along = 0, rx = 0, ry = 0, rz = 0, closest = Infinity
        for (let bone = side; bone < side + 2; bone++) {
          const { start, axis, length } = this.bones[bone]
          const x = positions[p] - start.x, y = positions[p + 1] - start.y, z = positions[p + 2] - start.z
          const t = Math.max(0, Math.min(length, x * axis.x + y * axis.y + z * axis.z))
          const dx = x - t * axis.x, dy = y - t * axis.y, dz = z - t * axis.z
          const distance = dx * dx + dy * dy + dz * dz
          if (distance < closest) { closest = distance; b = bone; along = t; rx = dx; ry = dy; rz = dz }
        }
        const bin = Math.round(along / this.bones[b].length * (BINS - 1))
        const { normal, tangent } = this.bones[b]
        const theta = Math.atan2(rx * tangent.x + ry * tangent.y + rz * tangent.z, rx * normal.x + ry * normal.y + rz * normal.z)
        const angle = Math.round((theta / (2 * Math.PI) + 0.5) * SIDES) % SIDES
        const key = (b * BINS + bin) * SIDES + angle
        const r = Math.hypot(rx, ry, rz)
        if (!push) this.radius[key] = Math.max(this.radius[key], Math.min(0.095, r))
        else {
          let min = 0
          for (let j = -2; j <= 2; j++) {
            const sample = (b - side) * BINS + bin + j
            if (sample < 0 || sample >= BINS * 2) continue
            for (let d = -1; d <= 1; d++) {
              const adjacent = (angle + d + SIDES) % SIDES
              const contact = this.radius[(side * BINS + sample) * SIDES + adjacent]
              if (contact) min = Math.max(min, contact + 0.008 - 0.002 * (Math.abs(j) + Math.abs(d)))
            }
          }
          if (r < 0.004 || r >= min) return
          const scale = min / r - 1
          positions[p] += rx * scale; positions[p + 1] += ry * scale; positions[p + 2] += rz * scale
        }
      })
    }
    visit(this.body, this.skin, false)
    if (inner && points) visit(points, inner, false)
    visit(cloth, outer, true)
  }
}
