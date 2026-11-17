import * as THREE from 'three'
import type { BodySet, Size, Vec3 } from '../body/bodySet'
import type { GuideOutfit } from './catalog'
import { BodyFrame } from '../pattern/drafts'
import { Layer } from '../scene/stage'
import { vertexNormals } from '../math/mesh'

type Binding = { vertex: number; offset: Vec3 }
type Bound = Binding

const add = (p: Vec3, d: Vec3, s: number): Vec3 => [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s]
/** two unit vectors across a surface with normal n */
function tangents(n: Vec3): [Vec3, Vec3] {
  const a: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]
  const u: Vec3 = [a[1] * n[2] - a[2] * n[1], a[2] * n[0] - a[0] * n[2], a[0] * n[1] - a[1] * n[0]]
  const l = Math.hypot(...u) || 1
  const v = u.map(q => q / l) as Vec3
  return [v, [n[1] * v[2] - n[2] * v[1], n[2] * v[0] - n[0] * v[2], n[0] * v[1] - n[1] * v[0]]]
}
/**
 * The garment as its cloth is now: details are placed against the settled drape. Placed against the
 * cut's rest shape they missed by the few centimetres the cloth drops (a collar floated over the
 * back of the neck, a belt sank into the jeans).
 */
const settled = (layer: Layer) => layer.garment && { ...layer.garment, rest: layer.sim ? Float32Array.from(layer.sim.x) : layer.garment.rest }

/** Outward normals of a garment's rest shape (pieces are drawn counter-clockwise from outside). */
function outwardNormals(g: { rest: Float32Array; index: Uint32Array }) {
  return vertexNormals(g.rest, g.index)
}

/** Points on a garment's own (posed) rest surface, found by body segment and flat-pattern position. */
class ClothSurface {
  private readonly n: Float32Array
  private readonly seg: number[]
  constructor(private readonly g: { rest: Float32Array; index: Uint32Array; src: Uint32Array | number[]; flat?: Float32Array }, private readonly body: BodySet) {
    this.n = outwardNormals(g)
    this.seg = Array.from(g.src as ArrayLike<number>, b => body.labels[b])
  }
  private at(i: number) { const j = i * 3; return { p: [this.g.rest[j], this.g.rest[j + 1], this.g.rest[j + 2]] as Vec3, n: [this.n[j], this.n[j + 1], this.n[j + 2]] as Vec3 } }
  /** a 4.5 × 6 cm strap on the outer side of the sleeve, 8–14 cm above the cuff */
  sleeveTab(side: number) {
    const fore = this.body.segment('forearm'), flat = this.g.flat
    if (!flat) return undefined
    const pick = (fx: number, fy: number) => {
      let best = -1, d = Infinity
      for (let i = 0; i < this.seg.length; i++) {
        if (this.seg[i] !== fore || this.g.rest[i * 3] * side < 0) continue
        const e = (flat[i * 3] - fx) ** 2 + (flat[i * 3 + 1] - fy) ** 2
        if (e < d) { d = e; best = i }
      }
      return best < 0 ? undefined : this.at(best)
    }
    const c = [pick(-0.022, 0.08), pick(0.022, 0.08), pick(0.022, 0.14), pick(-0.022, 0.14)]
    const b = pick(0, 0.125)
    if (c.some(q => !q) || !b) return undefined
    return { corners: c.map(q => add(q!.p, q!.n, 0.004)), button: b }
  }
}

/** Render-only tailoring attached to cloth particles, never to the mannequin. */
export class Tailoring {
  readonly cloth = new Layer()
  readonly hardware = new Layer()
  readonly neckwear = new Layer()
  /** jeans belt (leather), its buckle (metal) and shirt buttons: each bound to its own garment */
  readonly belt = new Layer()
  readonly buckle = new Layer()
  readonly buttons = new Layer()
  readonly shirtCollar = new Layer()
  readonly coatCollar = new Layer()
  private groups: { layer: Layer; source: Layer; bind: Binding[]; pos: Float32Array; index: Uint32Array; normals: Float32Array }[] = []

  /** every layer this class draws */
  get all() { return [this.cloth, this.hardware, this.neckwear, this.belt, this.buckle, this.buttons, this.shirtCollar, this.coatCollar] }

  clear() { this.groups = []; for (const l of this.all) l.clear() }

  build(outfit: GuideOutfit, slots: Layer[], body: BodySet, size: Size) {
    this.clear()
    if (outfit.id === 'trench') this.buildDenimSet(outfit, slots)
    const shirtAt = outfit.pieces.findIndex(p => p.cut === 'shirt'), coatAt = outfit.pieces.findIndex(p => p.cut === 'trench')
    // a point collar on a 3 cm stand, its tips reaching down onto the chest
    if (shirtAt >= 0) this.collar(this.shirtCollar, slots[shirtAt], outfit.pieces[shirtAt].color, { stand: 0.03, fall: 0.042, flare: 0.022, open: 6, tip: 0.035 })
    // the coat's wide collar, ending where the lapels take over
    if (coatAt >= 0) this.collar(this.coatCollar, slots[coatAt], outfit.pieces[coatAt].color, { stand: 0.018, fall: 0.05, flare: 0.022, open: 38, tip: 0.012 })
    const source = slots[outfit.pieces.length - 1], g = settled(source)!
    const f = new BodyFrame(body, size), cut = outfit.pieces.at(-1)!.cut
    if (!['trench', 'croppedBlazer', 'doubleBlazer'].includes(cut)) return
    const waist = f.hipY + 0.14
    const nearest = (p: Vec3) => {
      let best = 0, distance = Infinity
      for (let i = 0; i < g.src.length; i++) {
        const d = (g.rest[i * 3] - p[0]) ** 2 + (g.rest[i * 3 + 1] - p[1]) ** 2 + (g.rest[i * 3 + 2] - p[2]) ** 2
        if (d < distance) { best = i; distance = d }
      }
      return best
    }
    const surface = (x: number, y: number, back = false): Vec3 => f.aroundTorso(x, y, back, 0.075)
    const clothPos: Vec3[] = [], clothIndex: number[] = [], hardwarePos: Vec3[] = [], hardwareIndex: number[] = []
    const patch = (points: Vec3[]) => { const start = clothPos.length; clothPos.push(...points); for (let i = 1; i < points.length - 1; i++) clothIndex.push(start, start + i, start + i + 1) }
    if (cut === 'trench') {
      // No storm flap or back half-belt: the guide coat has neither, and placed from the body frame
      // they floated off the taller bodies' backs as dark patches.
      // Epaulettes and buttoned sleeve tabs, as on the guide coat. Placed on the coat's own surface
      // (its rest shape is posed), since body-frame points missed the sleeves outside the A-pose.
      const on = new ClothSurface(g, body)
      const button = (p: Vec3, n: Vec3, r: number) => {
        const start = hardwarePos.length, [u, w] = tangents(n)
        hardwarePos.push(add(p, n, 0.004))
        for (let k = 0; k <= 12; k++) { const a = k / 12 * Math.PI * 2; hardwarePos.push(add(add(add(p, n, 0.002), u, r * Math.cos(a)), w, r * Math.sin(a))) }
        for (let k = 0; k < 12; k++) hardwareIndex.push(start, start + k + 1, start + k + 2)
      }
      // (no epaulettes: placed on the cloth's shoulder they found the collar or nothing, and left
      // shards and stray buttons)
      for (const side of [-1, 1]) {
        const tab = on.sleeveTab(side)
        if (tab) { patch(tab.corners); button(tab.button.p, tab.button.n, 0.0065) }
      }
    }
    if (cut !== 'croppedBlazer' && cut !== 'trench') for (const side of [-1, 1]) for (let row = 0; row < 3; row++) {
      const p = surface(side * 0.075, waist + 0.11 - row * 0.09)
      p[2] += 0.009
      const start = hardwarePos.length
      hardwarePos.push(p)
      for (let k = 0; k <= 12; k++) hardwarePos.push([p[0] + 0.007 * Math.cos(k / 12 * Math.PI * 2), p[1] + 0.007 * Math.sin(k / 12 * Math.PI * 2), p[2] - 0.002])
      for (let k = 0; k < 12; k++) hardwareIndex.push(start, start + k + 1, start + k + 2)
    }
    for (const [layer, points, faces, color] of [[this.cloth, clothPos, clothIndex, outfit.pieces.at(-1)!.color], [this.hardware, hardwarePos, hardwareIndex, '#b59869']] as const) {
      const bind = points.map(p => {
        const vertex = nearest(p)
        return { vertex, offset: [p[0] - g.rest[vertex * 3], p[1] - g.rest[vertex * 3 + 1], p[2] - g.rest[vertex * 3 + 2]] as Vec3 }
      })
      const pos = new Float32Array(points.length * 3), index = Uint32Array.from(faces), normals = new Float32Array(pos.length)
      layer.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      layer.geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
      layer.geometry.setIndex(new THREE.BufferAttribute(index, 1)); layer.geometry.clearGroups(); layer.geometry.addGroup(0, index.length, 0)
      layer.geometry.setDrawRange(0, index.length)
      layer.front.onBeforeCompile = () => {}; layer.front.color.set(cut === 'trench' && layer === this.hardware ? '#24170f' : color); layer.front.roughness = layer === this.hardware ? 0.4 : 0.85
      this.groups.push({ layer, source, bind, pos, index, normals })
    }
    if (outfit.id === 'navy' || outfit.id === 'brown') this.buildTie(slots[0], f, outfit.id === 'navy' ? '#213d64' : '#817337')
    this.update()
  }

  /** Brown leather belt with a gold buckle on the jeans, and the shirt's placket buttons. */
  private buildDenimSet(outfit: GuideOutfit, slots: Layer[]) {
    const jeans = slots[outfit.pieces.findIndex(p => p.cut === 'jeans')], shirt = slots[outfit.pieces.findIndex(p => p.cut === 'shirt')]
    if (jeans?.garment) {
      const g = settled(jeans)!, rest = g.rest
      let top = -Infinity
      for (let i = 1; i < rest.length; i += 3) top = Math.max(top, rest[i])
      const ring = (y: number, out: number) => {
        // around the waistband at height y: the outermost jeans vertex in each direction
        let cx = 0, cz = 0, count = 0
        for (let i = 0; i < rest.length; i += 3) if (Math.abs(rest[i + 1] - y) < 0.015) { cx += rest[i]; cz += rest[i + 2]; count++ }
        cx /= count; cz /= count
        const hits = Array.from({ length: 49 }, (_, k) => {
          const a = k / 48 * Math.PI * 2, dx = Math.sin(a), dz = Math.cos(a)
          let best = 0, far = -Infinity
          for (let i = 0; i < rest.length; i += 3) {
            if (Math.abs(rest[i + 1] - y) > 0.012) continue
            const along = (rest[i] - cx) * dx + (rest[i + 2] - cz) * dz, off = Math.abs((rest[i] - cx) * dz - (rest[i + 2] - cz) * dx)
            if (off < 0.02 && along > far) { far = along; best = i / 3 }
          }
          return { best, far, dx, dz }
        })
        // the radius steps between cloth folds (on XL the strip twisted into black slivers): take the
        // largest of each sample's neighbours, so the belt passes over the folds as a real one does
        return hits.map(({ best, dx, dz }, k): Bound => {
          const far = Math.max(...[-2, -1, 0, 1, 2].map(d => hits[(k + d + 48) % 48].far))
          const j = best * 3
          return { vertex: best, offset: [cx + dx * (far + out) - rest[j], y - rest[j + 1], cz + dz * (far + out) - rest[j + 2]] }
        })
      }
      // belt 3.5 cm wide, just under the top of the waistband, standing 8 mm off the settled jeans
      const hi = ring(top - 0.012, 0.008), lo = ring(top - 0.047, 0.008), faces: number[] = []
      for (let k = 0; k < 48; k++) faces.push(k, 49 + k, k + 1, k + 1, 49 + k, 50 + k)
      this.bound(this.belt, jeans, [...hi, ...lo], faces, '#4a2a1a', 0.55)
      // buckle: a gold frame at the front (k = 0 faces forward), 1 cm proud of the belt
      const at = (b: Bound, dx: number, dy: number, dz: number): Bound => ({ vertex: b.vertex, offset: [b.offset[0] + dx, b.offset[1] + dy, b.offset[2] + dz] })
      const front = ring(top - 0.0295, 0.013)[0]
      const box = (x0: number, y0: number, x1: number, y1: number) => [at(front, x0, y0, 0), at(front, x1, y0, 0), at(front, x1, y1, 0), at(front, x0, y1, 0)]
      const bars = [box(-0.022, -0.02, 0.022, -0.014), box(-0.022, 0.014, 0.022, 0.02), box(-0.022, -0.02, -0.016, 0.02), box(0.016, -0.02, 0.022, 0.02), box(-0.003, -0.014, 0.003, 0.014)]
      this.bound(this.buckle, jeans, bars.flat(), bars.flatMap((_, i) => [i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3]), '#d8b46a', 0.35, 0.45)
    }
    if (shirt?.garment) {
      const g = settled(shirt)!, rest = g.rest, n = outwardNormals(g)
      let top = -Infinity
      for (let i = 1; i < rest.length; i += 3) top = Math.max(top, rest[i])
      const binds: Bound[] = [], faces: number[] = []
      // placket buttons every 8.5 cm down the centre front, from under the collar to the waistband
      for (let y = top - 0.075; y > top - 0.5; y -= 0.085) {
        let best = -1, d = Infinity
        for (let i = 0; i < rest.length; i += 3) {
          if (n[i + 2] < 0.6) continue
          const e = rest[i] ** 2 + (rest[i + 1] - y) ** 2
          if (e < d && rest[i + 2] > 0) { d = e; best = i / 3 }
        }
        if (best < 0) continue
        const j = best * 3, start = binds.length
        binds.push({ vertex: best, offset: [-rest[j], y - rest[j + 1], 0.003] })
        for (let k = 0; k <= 10; k++) { const a = k / 10 * Math.PI * 2; binds.push({ vertex: best, offset: [-rest[j] + 0.0055 * Math.cos(a), y - rest[j + 1] + 0.0055 * Math.sin(a), 0.002] }) }
        for (let k = 0; k < 10; k++) faces.push(start, start + k + 1, start + k + 2)
      }
      this.bound(this.buttons, shirt, binds, faces, '#eef1f4', 0.25)
    }
  }

  /**
   * A stiff collar standing on a garment's neckline: up the neck by `stand`, then folded over and
   * down by `fall`, flaring out by `flare`. It runs round the back to `open` degrees either side of
   * the centre front, where the front ends drop `tip` lower into points. Each row binds to the
   * neckline vertex under it, so it rides with the cloth.
   */
  private collar(layer: Layer, source: Layer, color: string, o: { stand: number; fall: number; flare: number; open: number; tip: number }) {
    const g = settled(source)
    if (!g) return
    const r = g.rest
    let top = -Infinity
    for (let i = 1; i < r.length; i += 3) top = Math.max(top, r[i])
    // the neckline is a free edge: vertices on edges used by only one triangle. (frontCount splits
    // body-front from body-back triangles, not outside from inside; counting only those missed the back.)
    const uses = new Map<number, number>(), n = r.length / 3
    for (let f = 0; f < g.index.length; f += 3) for (let e = 0; e < 3; e++) {
      const a = g.index[f + e], b = g.index[f + (e + 1) % 3], key = Math.min(a, b) * n + Math.max(a, b)
      uses.set(key, (uses.get(key) ?? 0) + 1)
    }
    const edge = new Uint8Array(n)
    for (const [key, c] of uses) if (c === 1) { edge[Math.floor(key / n)] = 1; edge[key % n] = 1 }
    const near: number[] = []
    // the back neckline settles lower than the front's highest point: search the top 16 cm
    for (let i = 0; i < n; i++) if (edge[i] && r[i * 3 + 1] > top - 0.16) near.push(i)
    if (!near.length) return
    let cx = 0, cz = 0
    for (const v of near) { cx += r[v * 3]; cz += r[v * 3 + 2] }
    cx /= near.length; cz /= near.length
    const N = 40, rows: Bound[][] = [[], [], [], []]
    const dirs = Array.from({ length: N + 1 }, (_, k) => {
      // from the right front end, round the back, to the left front end (θ = 0 faces forward)
      const th = -(o.open + (360 - 2 * o.open) * k / N) * Math.PI / 180
      return [Math.sin(th), Math.cos(th)]
    })
    // the neckline in each direction: the highest cloth within a few degrees of it
    const found = dirs.map(([dx, dz]) => {
      let best = -1, y = -Infinity
      for (const v of near) {
        const x = r[v * 3] - cx, z = r[v * 3 + 2] - cz, l = Math.hypot(x, z) || 1
        if ((x * dx + z * dz) / l < Math.cos(12 * Math.PI / 180)) continue
        if (r[v * 3 + 1] > y) { y = r[v * 3 + 1]; best = v }
      }
      return best
    })
    if (found.every(v => v < 0)) return
    // an open front leaves directions with no cloth: borrow the nearest sample that has some
    for (let k = 0; k <= N; k++) if (found[k] < 0) {
      for (let d = 1; d <= N; d++) { const v = found[k - d] ?? -1, w = found[k + d] ?? -1; if (v >= 0 || w >= 0) { found[k] = v >= 0 ? v : w; break } }
    }
    // smooth the line, which still steps between neighbouring cloth vertices; offsets are taken from
    // the smoothed point, so the collar rides on its vertex without the zig-zag
    const at = (k: number): Vec3 => { const j = found[Math.max(0, Math.min(N, k))] * 3; return [r[j], r[j + 1], r[j + 2]] }
    const smooth = (k: number): Vec3 => {
      const q: Vec3 = [0, 0, 0]
      for (let d = -2; d <= 2; d++) { const a = at(k + d); for (let i = 0; i < 3; i++) q[i] += a[i] / 5 }
      return q
    }
    for (let k = 0; k <= N; k++) {
      const [dx, dz] = dirs[k], best = found[k]
      const j = best * 3, p = smooth(k), base: Vec3 = [r[j], r[j + 1], r[j + 2]]
      const end = Math.min(k, N - k) / N, tip = o.tip * Math.max(0, 1 - end / 0.08)
      const pts: Vec3[] = [
        [p[0] + dx * 0.002, p[1], p[2] + dz * 0.002],
        [p[0] + dx * 0.006, p[1] + o.stand, p[2] + dz * 0.006],
        [p[0] + dx * (0.012 + o.flare * 0.4), p[1] + o.stand - o.fall * 0.35, p[2] + dz * (0.012 + o.flare * 0.4)],
        [p[0] + dx * (0.01 + o.flare), p[1] + o.stand - o.fall - tip, p[2] + dz * (0.01 + o.flare)],
      ]
      pts.forEach((q, i) => rows[i].push({ vertex: best, offset: [q[0] - base[0], q[1] - base[1], q[2] - base[2]] }))
    }
    const faces: number[] = [], W = N + 1
    for (let i = 0; i < 3; i++) for (let k = 0; k < N; k++) {
      const a = i * W + k, b = a + 1, c = a + W, d = c + 1
      faces.push(a, c, b, b, c, d)
    }
    this.bound(layer, source, rows.flat(), faces, color, 0.8)
  }

  private bound(layer: Layer, source: Layer, bind: Bound[], faces: number[], color: string, roughness: number, metalness = 0) {
    const pos = new Float32Array(bind.length * 3), index = Uint32Array.from(faces), normals = new Float32Array(pos.length)
    layer.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    layer.geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    layer.geometry.setIndex(new THREE.BufferAttribute(index, 1)); layer.geometry.clearGroups(); layer.geometry.addGroup(0, index.length, 0)
    layer.geometry.setDrawRange(0, index.length)
    layer.front.onBeforeCompile = () => {}
    layer.front.normalMap = null; layer.front.map = null
    layer.front.color.set(color); layer.front.roughness = roughness; layer.front.metalness = metalness; layer.front.sheen = 0
    layer.front.needsUpdate = true
    this.groups.push({ layer, source, bind, pos, index, normals })
  }

  private buildTie(source: Layer, body: BodyFrame, color: string) {
    const shirt = settled(source)!
    const rows = [
      [0.015, 0.014], [0.044, 0.018], [0.077, 0.009],
      [0.11, 0.012], [0.17, 0.018], [0.23, 0.024], [0.265, 0],
    ]
    const faces: number[] = [], bind: Binding[] = []
    rows.forEach(([drop, width], row) => {
      for (const side of [-1, 1]) {
        const y = body.neckY - drop
        const p = body.aroundTorso(side * width, y, false, 0.027)
        let vertex = 0, closest = Infinity
        shirt.src.forEach((_, i) => {
          const j = i * 3
          const d = (shirt.rest[j] - p[0]) ** 2 + (shirt.rest[j + 1] - p[1]) ** 2 + (shirt.rest[j + 2] - p[2]) ** 2
          if (d < closest) { vertex = i; closest = d }
        })
        const j = vertex * 3
        bind.push({ vertex, offset: [p[0] - shirt.rest[j], p[1] - shirt.rest[j + 1], Math.max(0.009, p[2] - shirt.rest[j + 2])] })
      }
      const i = row * 2
      if (row) faces.push(i - 2, i, i - 1, i - 1, i, i + 1)
    })
    const pos = new Float32Array(bind.length * 3), normals = new Float32Array(pos.length), index = Uint32Array.from(faces)
    const layer = this.neckwear
    layer.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    layer.geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
    layer.geometry.setIndex(new THREE.BufferAttribute(index, 1))
    layer.geometry.clearGroups()
    layer.geometry.addGroup(0, index.length, 0)
    layer.geometry.setDrawRange(0, index.length)
    layer.front.onBeforeCompile = () => {}
    layer.front.color.set(color)
    this.groups.push({ layer, source, bind, pos, index, normals })
  }

  update() {
    for (const { layer, source, bind, pos, index, normals } of this.groups) {
      if (!source.sim) continue
      bind.forEach(({ vertex, offset }, i) => { for (let k = 0; k < 3; k++) pos[i * 3 + k] = source.sim!.x[vertex * 3 + k] + offset[k] })
      vertexNormals(pos, index, normals)
      layer.geometry.attributes.position.needsUpdate = layer.geometry.attributes.normal.needsUpdate = true
      layer.geometry.computeBoundingSphere()
    }
  }
}
