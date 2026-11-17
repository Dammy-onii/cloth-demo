import type { BodySet, Pose, Size, Vec3 } from '../body/bodySet'
import type { Garment } from '../cloth/buildGarment'
import { vertexNormals } from '../math/mesh'
import { assemble, bodyLookup, type Piece, type Seam } from '../pattern/assemble'
import { BodyFrame, TORSO, mirror, smooth01 } from '../pattern/drafts'
import { sleevePair, top, trousers } from '../pattern/garments'
import type { P2 } from '../pattern/mesh2d'
import type { Cut } from './catalog'

type Draft = { pieces: Piece[]; seams: Seam[]; band?: [string, number][] }

function highRise(d: Draft, f: BodyFrame, hemY: number) {
  const oldTop = f.hipY + 0.11, newTop = f.waistY(f.J['upperarm01.L'][1] - 0.1) - 0.015
  const start = f.hipY + 0.015, rise = Math.max(0, newTop - oldTop)
  const waistScale = f.quarter(newTop, 0.014) / f.quarter(oldTop, 0.014)
  const weight = (y: number) => smooth01((y + hemY - start) / (oldTop - start))
  const height = (y: number) => y + rise * weight(y)
  const width = (y: number) => 1 + (waistScale - 1) * weight(y)
  for (const p of d.pieces) {
    const place = p.place
    p.outline = p.outline.map(([x, y]) => [x * width(y), height(y)])
    p.place = (x, y) => {
      let lo = y - rise, hi = y
      for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (height(mid) < y) lo = mid; else hi = mid }
      const oldY = (lo + hi) / 2, q = place(x / width(oldY), oldY)
      const before = f.torso(oldY + hemY), after = f.torso(y + hemY), w = weight(oldY)
      return [q[0] * (1 + (after.a / before.a - 1) * w), y + hemY, q[2] + ((q[2] - before.cz) * (after.b / before.b - 1) + after.cz - before.cz) * w]
    }
  }
}

/** A flared skirt cut in eight gores. Vary each panel's width with the ellipse
 * so the excess cloth falls along the grain, rather than stacking at the hip. */
function goredSkirt(f: BodyFrame, body: BodySet, size: Size, pose: Pose): Draft {
  const hemY = 0.10, hipY = f.hipY + 0.035
  const topY = f.waistY(f.J['upperarm01.L'][1] - 0.1) - 0.035
  const hip = f.torso(hipY), waist = f.torso(topY)
  const count = 8, arc = 2 * Math.PI / count
  const sections = [
    { y: hemY, a: hip.a + 0.092, b: hip.b + 0.075, cz: hip.cz },
    { y: hipY, a: hip.a + 0.022, b: hip.b + 0.029, cz: hip.cz },
    { y: topY, a: waist.a + 0.020, b: waist.b + 0.024, cz: waist.cz },
  ]
  const section = (y: number) => {
    const j = y < hipY ? 0 : 1
    const A = sections[j], B = sections[j + 1]
    const t = (y - A.y) / (B.y - A.y)
    const w = j === 0 ? t : smooth01(t)
    return { a: A.a + (B.a - A.a) * w, b: A.b + (B.b - A.b) * w, cz: A.cz + (B.cz - A.cz) * t }
  }
  const depthEase = [0, 0]
  let widthEase = 0
  if (pose !== 'apose') {
    const posed = body.positions(size, pose)
    const labels = ['torso', 'upperleg', 'lowerleg'].map(name => body.segment(name))
    const belowWaist = (y: number) => smooth01((topY - y) / 0.16)
    body.labels.forEach((label, v) => {
      const i = v * 3, y = posed[i + 1]
      if (y < hemY || y > topY || !labels.includes(label)) return
      widthEase = Math.max(widthEase, (Math.abs(posed[i]) + 0.010 - section(y).a) / Math.max(0.5, belowWaist(y)))
    })
    body.labels.forEach((label, v) => {
      const i = v * 3, y = posed[i + 1]
      if (y < hemY || y > topY || !labels.includes(label)) return
      const { a, b, cz } = section(y)
      const weight = smooth01((topY - y) / 0.32), z = posed[i + 2] - cz
      const depth = Math.max(0.16, 1 - (posed[i] / (a + widthEase * belowWaist(y))) ** 2) ** 0.41
      const required = ((Math.abs(z) + 0.009) / depth - b) / Math.max(0.5, weight)
      const side = z >= 0 ? 0 : 1
      depthEase[side] = Math.max(depthEase[side], required)
    })
  }
  const pieces: Piece[] = [], seams: Seam[] = [], band: NonNullable<Draft['band']> = []
  for (let k = 0; k < count; k++) {
    const name = 'gore' + k, next = 'gore' + ((k + 1) % count)
    const center = k * arc
    const width = sections.map(({ a, b }, index) => {
      let length = 0
      for (let j = 0; j < 8; j++) {
        const theta = center + arc * ((j + 0.5) / 8 - 0.5)
        length += Math.hypot(a * Math.cos(theta), b * Math.sin(theta)) * arc / 8
      }
      return length * (index === 0 ? 1.015 : 1.005) / 2
    })
    const [lo, mid, hi] = width
    const h = hipY - hemY, H = topY - hemY
    const outline: P2[] = [[-lo, 0], [lo, 0], [mid, h], [hi, H], [-hi, H], [-mid, h]]
    pieces.push({ name, outline, anchor: ['torso', 'upperleg'], noTurn: true,
      place: (x, y) => {
        const j = y < h ? 0 : 1
        const A = sections[j], B = sections[j + 1]
        const t = (y + hemY - A.y) / (B.y - A.y)
        const mix = (a: number, b: number) => a + (b - a) * t
        const u = x / (2 * mix(width[j], width[j + 1]))
        const theta = center + u * arc
        const fold = 0.010 * Math.cos(u * 2 * Math.PI) * Math.max(0, 1 - y / h)
        const { a, b, cz } = section(hemY + y)
        const sin = Math.sin(theta), cos = Math.cos(theta)
        const weight = smooth01((topY - hemY - y) / 0.16)
        const stanceEase = pose === 'hips' ? 0.024 * smooth01((hipY - hemY - y) / 0.28) : 0
        return [(a + widthEase * weight + stanceEase + fold) * sin, hemY + y, cz + (b + depthEase[cos >= 0 ? 0 : 1] * smooth01((topY - hemY - y) / 0.32) + fold) * Math.sign(cos) * Math.abs(cos) ** 0.82]
      } })
    seams.push({ a: [[name, 1], [name, 2]], b: [[next, 5, true], [next, 4, true]] })
    band.push([name, 3])
  }
  return { pieces, seams, band }
}

/** A separate tailoring family; the original wardrobe drafts remain untouched. */
function tailored(f: BodyFrame, cut: Cut, clearance: number): Draft {
  const shirt = cut === 'shirt', vest = cut === 'waistcoat', coat = cut === 'trench', loose = cut === 'overshirt'
  const cropped = cut === 'croppedBlazer'
  const waistY = f.waistY(f.J['upperarm01.L'][1] - 0.1)
  const hemY = coat ? 0.3 : cropped ? waistY - 0.045 : vest ? f.hipY + 0.025 : shirt ? Math.max(f.hipY + 0.025, waistY - 0.115) : loose ? f.hipY - 0.07 : cut === 'doubleBlazer' ? f.hipY - 0.13 : waistY - 0.145
  const hps = f.neckY - 0.004, H = hps - hemY
  const gap = loose ? Math.max(0.04, Math.min(0.05, clearance + 0.02)) : Math.max(shirt ? 0.022 : vest ? 0.023 : 0.045, clearance + (shirt ? 0.008 : 0.015))
  const underY = f.J['upperarm01.L'][1] - (loose || coat ? 0.12 : 0.09)
  const W = f.quarter(underY, gap)
  const hip = f.torso(f.hipY)
  const Wh = coat ? f.quarter(f.hipY, gap) + 0.06 : f.quarter(hemY, gap + (vest ? 0.015 : 0))
  const nw = f.neckHalfWidth + 0.015
  const shoulderX = Math.abs(f.J['upperarm01.L'][0]) + (loose ? 0.013 : 0.008)
  const hs = H - 0.045, ah = underY - hemY
  const nf: P2 = [nw * 0.65, H - 0.05]
  const v = H - (shirt ? 0.08 : loose ? 0.22 : vest ? 0.27 : 0.26)
  // front edges: 0 hem, 1 side, 2 armhole, 3 shoulder, 4 neck, 5 opening, 6 centre.
  const frontHem = loose ? 0.022 : 0
  const front: P2[] = [[0, frontHem], [Wh, 0], [W, ah], [shoulderX, hs], [nw, H], nf, [0, v]]
  const fc = [0, 0, 0.014, 0, 0.004, 0, 0]
  const back: P2[] = [[-Wh, 0], [Wh, 0], [W, ah], [shoulderX, hs], [nw, H + 0.01], [-nw, H + 0.01], [-shoulderX, hs], [-W, ah]]
  const bc = [0, 0, 0.014, 0, 0.012, 0, 0.014, 0]
  const place = (isBack: boolean) => (x: number, y: number): Vec3 => {
    const wy = hemY + y
    if (!coat) return f.aroundTorso(x, wy, isBack, gap)
    const hipEase = 0.065 * (1 - smooth01((wy - f.hipY) / 0.20))
    // Keep the front and back side edges on the same meridian as the coat widens.
    const panelWidth = Wh + (W - Wh) * Math.min(1, Math.max(0, y / ah))
    const angle = (isBack ? -x : x) / panelWidth * Math.PI / 2
    if (wy >= underY) return f.aroundTorso(x, wy, isBack, gap + hipEase)
    const side = isBack ? -1 : 1
    const section = f.torso(Math.max(wy, f.hipY)), shell = gap + hipEase
    const upper: Vec3 = [(section.a + shell) * Math.sin(angle), wy, section.cz + side * (section.b + shell) * Math.cos(angle)]
    // A coat hangs from the hips, rather than narrowing round each leg below the seat.
    const flare = 0.085 * Math.max(0, f.hipY - wy) / (f.hipY - hemY)
    const a = hip.a + gap + hipEase + flare, b = hip.b + gap + hipEase + flare
    const lower: Vec3 = [a * Math.sin(angle), wy, hip.cz + side * b * Math.cos(angle)]
    // blend the two over 12 cm: switching at the hip line left a horizontal crease across the back
    const w = smooth01((f.hipY + 0.06 - wy) / 0.12)
    return [upper[0] + (lower[0] - upper[0]) * w, wy, upper[2] + (lower[2] - upper[2]) * w]
  }
  const [fr, frc] = mirror(front, fc)
  const frontPlace = (side: number) => (x: number, y: number): Vec3 => {
    const q = place(false)(x, y)
    if (coat || cropped) q[0] += side * 0.045 * smooth01((H - y) / 0.24) * Math.exp(-Math.abs(x) / 0.08)
    return q
  }
  const pieces: Piece[] = [
    { name: 'frontL', outline: front, curves: fc, place: frontPlace(1), anchor: TORSO, noTurn: true, passThrough: true },
    { name: 'frontR', outline: fr, curves: frc, place: frontPlace(-1), anchor: TORSO, noTurn: true, passThrough: true },
    { name: 'back', outline: back, curves: bc, place: place(true), anchor: TORSO, noTurn: true, passThrough: true },
  ]
  const seams: Seam[] = [
    { a: [['frontL', 1]], b: [['back', 7]] }, { a: [['frontR', 1]], b: [['back', 1]] },
    { a: [['frontL', 3]], b: [['back', 5]] }, { a: [['frontR', 3]], b: [['back', 3]] },
  ]
  if (!coat && !cropped) seams.push({ a: [['frontL', 6]], b: [['frontR', 6]] })
  if (!vest) {
    const armhole = Math.hypot(shoulderX - W, hs - ah) * 1.04, capH = 0.075
    const half = Math.sqrt(Math.max(armhole ** 2 - capH ** 2, 0.004)) * (shirt ? 0.88 : 1)
    const sh = f.J['upperarm01.L'], el = f.J['lowerarm01.L'], wr = f.J['wrist.L']
    const length = Math.hypot(...sh.map((q, k) => q - el[k])) + Math.hypot(...el.map((q, k) => q - wr[k])) - 0.035
    pieces.push(...sleevePair(f, { top: 0.02, length: length + (coat ? 0.025 : 0), capH, half, hemHalf: Math.min(half, Math.PI * (f.wristR + (shirt ? 0.014 : loose ? 0.014 : 0.025))), clear: shirt ? 0.004 : coat || cropped || cut === 'doubleBlazer' ? 0.019 : 0.008 }))
    seams.push(
      { a: [['sleeveL', 1]], b: [['sleeveL', 4]] }, { a: [['sleeveR', 1]], b: [['sleeveR', 4]] },
      { a: [['sleeveL', 2], ['sleeveL', 3]], b: [['back', 6, true], ['frontL', 2, true]] },
      { a: [['sleeveR', 2], ['sleeveR', 3]], b: [['frontR', 2], ['back', 2, true]] },
    )
    const frontNeck = Math.hypot(nw - nf[0], H - nf[1])
    const backNeck = 2 * nw * 1.15
    const neckRun = 2 * frontNeck + backNeck
    const width = loose ? 0.034 : shirt ? 0.045 : 0.065
    // Coats and shirts get a stiff render-only collar instead (Tailoring.collar): sewn on as cloth,
    // a band this narrow folded over on itself and crumpled into dark shards.
    if (!coat && !shirt) pieces.push({ name: 'collar', outline: [[0, 0], [neckRun, 0], [neckRun, width], [0, width]], anchor: ['neck', 'torso'], noTurn: true,
      place: (x, y) => {
        let p: Vec3
        if (x < frontNeck || x > frontNeck + backNeck) {
          const right = x < frontNeck, side = right ? -1 : 1
          const t = (right ? x : neckRun - x) / frontNeck
          p = frontPlace(side)(side * (nf[0] + (nw - nf[0]) * t), nf[1] + (H - nf[1]) * t)
        } else {
          const t = (x - frontNeck) / backNeck
          p = place(true)(nw * (1 - 2 * t), H + 0.01 - 0.012 * 4 * t * (1 - t))
        }
        const z = p[2] - f.torso(hps).cz, r = Math.hypot(p[0], z) || 1
        return [p[0] + y * p[0] / r * 0.65, p[1] - y * 0.46, p[2] + y * z / r * 0.65]
      } })
    if (!coat && !shirt) seams.push({ a: [['collar', 0]], b: [['frontR', 4, true], ['back', 4], ['frontL', 4]] })
  }
  if (coat || cropped || cut === 'doubleBlazer') {
    // Sew the roll line into each front. The free edge turns outward and tapers to the break.
    const run = Math.hypot(nf[0], nf[1] - v)
    const lapelWidth = coat ? 0.105 : 0.081
    const outline: P2[] = [[0, 0], [run, 0], [run * 0.9, lapelWidth * 0.72], [run * 0.68, lapelWidth]]
    for (const side of [1, -1]) {
      const suffix = side === 1 ? 'L' : 'R'
      pieces.push({
        name: 'lapel' + suffix, outline: side === 1 ? outline : mirror(outline, [0, 0, 0, 0])[0],
        anchor: TORSO, noTurn: true, passThrough: true,
        place: (x, y) => {
          const t = Math.abs(x) / run
          const q = frontPlace(side)(side * (t * nf[0] + y), v + t * (nf[1] - v) - y * 0.25)
          q[2] += y * 0.9 // rest the lapel clear above the front, not flat on it: lying on the panel it bunched into chest lumps
          return q
        },
      })
      seams.push({ a: [['lapel' + suffix, 0]], b: [['front' + suffix, 5]] })
    }
  }
  // Open fronts have no closed neckline to carry the long coat's weight. Shoulder stays use the
  // existing elastic-edge tether so the garment remains supported while the body moves.
  const band: [string, number][] = [['frontL', 3], ['frontR', 3], ['back', 3], ['back', 5]]
  if (coat) band.push(['frontL', 4], ['frontR', 4])
  // Tethering the opening edge (5) as well pinned each front to its flat rest and crumpled the chest.
  else if (cropped || loose) band.push(['frontL', 4], ['frontR', 4])
  return { pieces, seams, band }
}

export function draftOutfitPiece(cut: Cut, body: BodySet, size: Size, lift?: Float32Array, pose: Pose = 'apose'): Garment {
  const f = new BodyFrame(body, size), pos = body.positions(size, 'apose')
  const torso = body.segment('torso')
  let clearance = 0
  if (lift) for (let i = 0; i < lift.length; i++) if (body.labels[i] === torso && pos[i * 3 + 1] > f.hipY + 0.22) clearance = Math.max(clearance, Math.min(0.055, lift[i]))
  let d: Draft
  const bottom = ['jeans', 'pleatedTrousers', 'flaredTrousers', 'maxi'].includes(cut)
  if (bottom && lift) {
    clearance = 0
    for (let i = 0; i < lift.length; i++) if (body.labels[i] === torso && Math.abs(pos[i * 3 + 1] - f.hipY - 0.11) < 0.04) clearance = Math.max(clearance, Math.min(0.035, lift[i]))
  }
  if (cut === 'jeans' || cut === 'pleatedTrousers' || cut === 'flaredTrousers') {
    d = trousers(f, { hemY: 0.09, legEase: cut === 'jeans' ? 0.16 : 0.22, hemGirth: cut === 'flaredTrousers' ? 0.64 : 0.7, hipEase: Math.max(0.022, clearance + 0.008), drop: 0.065 })
    highRise(d, f, 0.09)
  } else if (cut === 'maxi') {
    d = goredSkirt(f, body, size, pose)
  } else if (cut === 'turtleneck') {
    d = top(f, { ease: 0.024, hem: 0.06, sleeve: 'long', neck: { width: 0.005, front: 0.012, back: 0.008 } })
    const neckF = d.band!.find(([name]) => name === 'front')![1], neckB = d.band!.find(([name]) => name === 'back')![1]
    const radius = f.neckHalfWidth + 0.006
    const girth = 2 * Math.PI * radius
    d.pieces.push({ name: 'neck', outline: [[0, 0], [girth, 0], [girth, 0.041], [0, 0.041]], anchor: ['neck'], noTurn: true,
      place: (x, y) => {
        const t = Math.PI / 2 - x / girth * Math.PI * 2
        const wy = f.neckY - 0.014 + y
        const low = f.torso(f.neckY), high = f.torso(f.neckY + 0.025)
        const w = smooth01(y / 0.041)
        const a = radius + (high.a + 0.007 - radius) * w
        const b = low.b + (high.b - low.b) * w + 0.007
        return [Math.sin(t) * a, wy, low.cz + (high.cz - low.cz) * w + Math.cos(t) * b]
      } })
    d.band!.push(['neck', 2])
    d.seams.push({ a: [['neck', 1]], b: [['neck', 3]] }, { a: [['neck', 0]], b: [['front', neckF], ['back', neckB]] })
  } else if (cut === 'shirt') {
    // Cut as the main wardrobe's tops are (a closed front and back with set-in sleeves): drafted as an
    // open tailored front, the shirt tore into shards under the suit jackets. The collar and placket
    // are render-only (Tailoring), placed on the settled cloth.
    const waistY = f.waistY(f.J['upperarm01.L'][1] - 0.1)
    d = top(f, { ease: Math.max(0.022, clearance + 0.008), hem: Math.max(0.025, waistY - 0.115 - f.hipY), sleeve: 'long', neck: { width: 0.012, front: 0.075, back: 0.02 } })
  } else d = tailored(f, cut, clearance)
  // Lapels and collars are only ~8 cm wide: at 3 cm spacing they were three particles across and
  // crumpled. Only they get a fine mesh; a whole coat at 2.2 cm doubled the solver's cost.
  for (const p of d.pieces) if (p.name === 'collar' || p.name.startsWith('lapel')) p.spacing = 0.016
  const g = assemble(d.pieces, d.seams, { spacing: cut === 'maxi' || cut === 'turtleneck' ? 0.025 : 0.032, band: d.band }, bodyLookup(pos, body.labels, body.segments))
  const ignore = (bottom || cut === 'trench' ? ['upperarm', 'forearm', 'hand'] : ['forearm', 'hand']).map(n => body.segment(n))
  // Covers from the original assembler cap at 4 cm. Preserve the actual outward clearance for
  // these new outer garments without changing that contract for the existing wardrobe.
  const normals = vertexNormals(pos, body.index)
  g.src.forEach((b, i) => {
    const s = b * 3, j = i * 3
    const outward = (g.rest[j] - pos[s]) * normals[s] + (g.rest[j + 1] - pos[s + 1]) * normals[s + 1] + (g.rest[j + 2] - pos[s + 2]) * normals[s + 2]
    const cap = ['trench', 'croppedBlazer', 'doubleBlazer', 'overshirt'].includes(cut) ? 0.06 : 0.035
    g.covers[b] = Math.min(cap, Math.max(g.covers[b], outward))
  })
  const skirtLegs = [body.segment('upperleg'), body.segment('lowerleg')]
  const ignoredSkin = body.labels.map((label, i) =>
    ignore.includes(label) || (cut === 'maxi' && skirtLegs.includes(label) && pos[i * 3 + 1] < f.hipY + 0.035) ? 1 : 0)
  const collisionLift = cut === 'overshirt' ? lift?.map(value => Math.min(value, 0.022)) : lift
  return { ...g, lift: collisionLift, ignore: ignoredSkin, bandTether: bottom ? 0.08 : 0.2 }
}
