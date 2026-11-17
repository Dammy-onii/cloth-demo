import { Quaternion, Vector3 } from 'three'
import type { BodySet, Pose, Size } from '../body/bodySet'
import type { Garment } from '../cloth/buildGarment'

/** Place sleeves on the upper arm and forearm bones before sewing. Skin normals alone can
 * rotate opposite sides of the same cuff in opposite directions in an arms-down pose. */
export function posePattern(garment: Garment, body: BodySet, size: Size, pose: Pose, beforeNormals: Float32Array, afterNormals: Float32Array) {
  if (pose === 'apose') return garment
  const before = body.positions(size, 'apose'), after = body.positions(size, pose)
  const from = body.joints(size, 'apose'), to = body.joints(size, pose)
  const makeBone = (start: string, end: string) => {
    const a = new Vector3(...from[start]), b = new Vector3(...from[end])
    const A = new Vector3(...to[start]), B = new Vector3(...to[end])
    const axis = b.clone().sub(a).normalize()
    return { a, A, axis, length: a.distanceTo(b), turn: new Quaternion().setFromUnitVectors(axis, B.sub(A).normalize()) }
  }
  const arms = ['L', 'R'].map(side => [
    makeBone(`upperarm01.${side}`, `lowerarm01.${side}`),
    makeBone(`lowerarm01.${side}`, `wrist.${side}`),
  ])
  const upper = body.segment('upperarm'), fore = body.segment('forearm')
  const points = garment.rest.slice()
  const p = new Vector3(), q = new Vector3(), r = new Vector3(), n = new Vector3(), m = new Vector3()
  const turn = new Quaternion()
  garment.src.forEach((source, vertex) => {
    const i = vertex * 3, s = source * 3, label = body.labels[source]
    p.fromArray(garment.rest, i)
    if (!garment.noTurn?.[vertex] && (label === upper || label === fore)) {
      const [arm, lower] = arms[before[s] >= 0 ? 0 : 1]
      const along = q.copy(p).sub(arm.a).dot(arm.axis) - arm.length
      const weight = Math.max(0, Math.min(1, (along + 0.055) / 0.11))
      q.copy(p).sub(arm.a).applyQuaternion(arm.turn).add(arm.A)
      r.copy(p).sub(lower.a).applyQuaternion(lower.turn).add(lower.A)
      q.lerp(r, weight * weight * (3 - 2 * weight))
    } else {
      q.fromArray(before, s)
      p.sub(q)
      if (!garment.noTurn?.[vertex]) {
        n.fromArray(beforeNormals, s); m.fromArray(afterNormals, s)
        if (n.dot(m) > -0.9) p.applyQuaternion(turn.setFromUnitVectors(n, m))
      }
      q.fromArray(after, s).add(p)
    }
    q.toArray(points, i)
  })
  return { ...garment, rest: points }
}
