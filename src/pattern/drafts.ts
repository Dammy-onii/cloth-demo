// Garment patterns drafted from the body's measurements, and where each piece starts around the
// body. Pattern coordinates are metres, x across the piece, y up from its hem; pieces are drawn as
// seen from outside (fronts with x towards the body's left, backs with x towards its right).

import type { BodySet, Size, Vec3 } from '../body/bodySet'
import type { Piece, Seam } from './assemble'
import { sleevePair } from './garments'
import type { P2 } from './mesh2d'

export const smooth01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/** What drafting needs from a body: joints, tape girths (m) and torso cross-sections by height. */
export class BodyFrame {
  readonly J: Record<string, Vec3>
  readonly bust: number
  readonly waist: number
  readonly hip: number
  readonly hipY: number
  readonly crotchY: number
  readonly neckY: number
  /** half-width of the neck at its base (m) */
  readonly neckHalfWidth: number
  /** mean radius of the upper arm and of the forearm by the wrist (m) */
  readonly armR: number
  readonly wristR: number
  /** torso half-width, half-depth and centre depth, every 2 cm up from the floor */
  private readonly slabs: { a: number; b: number; cz: number }[] = []
  private readonly legs: { r: number; cx: number; cz: number }[] = []

  constructor(body: BodySet, size: Size) {
    const pos = body.positions(size, 'apose')
    this.J = body.joints(size, 'apose')
    const m = body.measurements(size).fitted
    this.bust = m.bust / 100
    this.waist = m.waist / 100
    this.hip = m.hip / 100
    this.hipY = (this.J['upperleg01.L'][1] + this.J['upperleg01.R'][1]) / 2
    this.neckY = this.J['neck01'][1]
    const torso = body.segment('torso'), neck = body.segment('neck'), upper = body.segment('upperleg'), lower = body.segment('lowerleg')
    let crotch = this.hipY
    let neckHalf = 0
    const slab = Array.from({ length: 100 }, () => ({ x: 0, zMin: Infinity, zMax: -Infinity }))
    const leg = Array.from({ length: 100 }, () => ({ xMin: Infinity, xMax: -Infinity, zMin: Infinity, zMax: -Infinity }))
    for (let v = 0; v < body.vertexCount; v++) {
      const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2], l = body.labels[v]
      const i = Math.min(99, Math.max(0, Math.round(y / 0.02)))
      // cross-sections take in the thighs too: below the hip joint the torso skin alone is just the
      // crotch, and a shirt hem wrapped round that crumpled
      if (l === torso || l === neck || l === upper) {
        slab[i].x = Math.max(slab[i].x, Math.abs(x)); slab[i].zMin = Math.min(slab[i].zMin, z); slab[i].zMax = Math.max(slab[i].zMax, z)
        if (l === torso && Math.abs(x) < 0.03) crotch = Math.min(crotch, y)
      }
      if (l === neck && Math.abs(y - this.neckY) < 0.02) neckHalf = Math.max(neckHalf, Math.abs(x))
      if ((l === upper || l === lower) && x > 0) {
        leg[i].xMin = Math.min(leg[i].xMin, x); leg[i].xMax = Math.max(leg[i].xMax, x); leg[i].zMin = Math.min(leg[i].zMin, z); leg[i].zMax = Math.max(leg[i].zMax, z)
      }
    }
    this.crotchY = crotch
    // arm radii: mean distance of the left arm's skin from its bone axis
    const radius = (seg: number, a: Vec3, b: Vec3, near?: Vec3) => {
      const d = norm(sub(b, a)), len = Math.hypot(...sub(b, a))
      let sum = 0, n = 0
      for (let v = 0; v < body.vertexCount; v++) {
        if (body.labels[v] !== seg || pos[v * 3] < 0) continue
        const p: Vec3 = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]
        if (near && Math.hypot(...sub(p, near)) > 0.06) continue
        const r = sub(p, a), s = dot(r, d)
        if (s < 0.2 * len || s > 0.95 * len) continue
        sum += Math.hypot(...sub(r, scale(d, s)))
        n++
      }
      return n ? sum / n : 0.045
    }
    this.armR = radius(body.segment('upperarm'), this.J['upperarm01.L'], this.J['lowerarm01.L'])
    this.wristR = radius(body.segment('forearm'), this.J['lowerarm01.L'], this.J['wrist.L'], this.J['wrist.L'])
    this.neckHalfWidth = neckHalf || 0.055
    this.slabs = slab.map((s) => ({ a: s.x || 0.15, b: Number.isFinite(s.zMin) ? (s.zMax - s.zMin) / 2 : 0.1, cz: Number.isFinite(s.zMin) ? (s.zMax + s.zMin) / 2 : 0 }))
    this.legs = leg.map((s) => ({ r: Number.isFinite(s.xMin) ? Math.max(s.xMax - s.xMin, s.zMax - s.zMin) / 2 : 0.07, cx: Number.isFinite(s.xMin) ? (s.xMax + s.xMin) / 2 : 0.09, cz: Number.isFinite(s.zMin) ? (s.zMax + s.zMin) / 2 : 0 }))
  }

  torso(y: number) {
    return this.slabs[Math.min(99, Math.max(0, Math.round(y / 0.02)))]
  }

  leg(y: number) {
    return this.legs[Math.min(99, Math.max(0, Math.round(y / 0.02)))]
  }

  /** Thigh girth just below the crotch (m) */
  get thigh() {
    return 2 * Math.PI * this.leg(this.crotchY - 0.05).r
  }

  /** Arc from the front (or back) centre round to the side at height y, `gap` out from the skin (m). */
  quarter(y: number, gap: number) {
    const s = this.torso(y)
    return (Math.PI * (s.a + s.b + 2 * gap)) / 4
  }

  /** Height of the bust line: the deepest torso between the waist and the underarm. */
  bustY(waist: number, under: number) {
    let best = (waist + under) / 2, d = 0
    for (let y = waist + 0.04; y < under; y += 0.02) if (this.torso(y).b > d) { d = this.torso(y).b; best = y }
    return best
  }

  /** Arc from the front centre to world x = X at height y, `gap` out from the skin (m). */
  arcTo(y: number, X: number, gap: number) {
    const s = this.torso(y)
    return Math.asin(Math.min(1, X / (s.a + gap))) * ((s.a + s.b) / 2 + gap)
  }

  /** Height of the natural waist: the narrowest torso between the hips and the underarm. */
  waistY(top: number) {
    let best = this.hipY + 0.08, w = Infinity
    for (let y = this.hipY + 0.08; y < top - 0.08; y += 0.02) if (this.torso(y).a < w) { w = this.torso(y).a; best = y }
    return best
  }

  /** A point on an ellipse around the torso at height y, x metres of arc from the front (or back) centre. */
  aroundTorso(x: number, y: number, back: boolean, gap: number): Vec3 {
    const s = this.torso(y), a = s.a + gap, b = s.b + gap
    const t = (back ? -x : x) / ((a + b) / 2)
    return [a * Math.sin(t), y, s.cz + (back ? -1 : 1) * b * Math.cos(t)]
  }
}

// body segments pieces follow on pose changes
export const TORSO = ['torso', 'neck', 'upperleg']
export const ARM = ['upperarm', 'forearm']
export const LOWER = ['torso', 'upperleg', 'lowerleg']

/** Mirror a piece across x = 0 (left ↔ right), keeping corner order and edge numbers. */
export function mirror(outline: P2[], curves: number[]): [P2[], number[]] {
  return [outline.map(([x, y]) => [-x, y]), curves.map((c) => -c)]
}

/**
 * Camp-collar shirt (guide 1): boxy, dropped shoulder, short wide sleeves, an open V front closed
 * below by the button placket (sewn here), and a collar band round the neckline.
 */
export function campShirt(f: BodyFrame): { pieces: Piece[]; seams: Seam[] } {
  const chest = f.bust + 0.26
  const W = chest / 4
  // the hem has to clear the hips: on curvy bodies a chest-width hem rode up to the waist
  const Wh = Math.max(W, (f.hip + 0.2) / 4)
  const shoulderX = Math.abs(f.J['upperarm01.L'][0]) + 0.035
  const hps = f.neckY - 0.004
  const hemY = f.hipY - 0.06
  const H = hps - hemY
  const hs = H - 0.045 // shoulder tip, sloping down from the neck point
  const ah = f.J['upperarm01.L'][1] - 0.13 - hemY // armpit (deep: dropped shoulder)
  // neckline from the body's own neck base: a fixed male-sized one sat loose on the slimmer female
  // neck and slid off her sloped shoulders
  const nw = f.neckHalfWidth + 0.014
  const nf: P2 = [nw * 0.7, H - 0.05]
  const v = H - 0.17 // the V where the buttons start
  const gap = 0.035
  // front-left: CF hem → side hem → armpit → shoulder tip → neck point → front neck → V → CF
  const front: P2[] = [[0, 0], [Wh, 0], [W, ah], [shoulderX, hs], [nw, H], nf, [0, v]]
  const frontCurves = [0, 0, 0.018, 0, 0.004, 0, 0]
  const back: P2[] = [[-Wh, 0], [Wh, 0], [W, ah], [shoulderX, hs], [nw, H + 0.01], [-nw, H + 0.01], [-shoulderX, hs], [-W, ah]]
  const backCurves = [0, 0, 0.016, 0, 0.012, 0, 0.016, 0]
  const torsoPlace = (isBack: boolean) => (x: number, y: number) => f.aroundTorso(x, hemY + y, isBack, gap)

  // sleeve: around the arm, cap matching the armhole
  const armhole = Math.hypot(shoulderX - W, hs - ah) * 1.04
  const capH = 0.06
  const half = Math.sqrt(Math.max(armhole ** 2 - capH ** 2, 0.01))

  // collar band: round the neckline from one front neck point to the other
  const neckRun = 2 * Math.hypot(nw - nf[0], H - nf[1]) + 2 * nw * 1.15
  const collarW = 0.075
  const collar: P2[] = [[0, 0], [neckRun, 0], [neckRun, collarW], [0, collarW]]
  const collarPlace = (x: number, y: number): Vec3 => {
    const R = nw + 0.02
    const t = Math.PI * 0.85 * (2 * x / neckRun - 1)
    // mirrored so the band's outside faces away from the neck
    return [-R * Math.sin(t), hps + 0.005 + y * 0.8, f.torso(hps).cz - R * Math.cos(t)]
  }

  const [fr, frc] = mirror(front, frontCurves)
  const pieces: Piece[] = [
    // body panels pass through the forearms and hands (with hands on hips they sit inside the
    // shirt's ease, and colliding with them crushed it); sleeves still collide with the arms
    { name: 'frontL', outline: front, curves: frontCurves, place: torsoPlace(false), passThrough: true, anchor: TORSO, noTurn: true },
    { name: 'frontR', outline: fr, curves: frc, place: torsoPlace(false), passThrough: true, anchor: TORSO, noTurn: true },
    { name: 'back', outline: back, curves: backCurves, place: torsoPlace(true), passThrough: true, anchor: TORSO, noTurn: true },
    ...sleevePair(f, { top: 0.02, length: 0.25, capH, half, hemHalf: half * 0.94, clear: 0.012 }),
    { name: 'collar', outline: collar, place: collarPlace, anchor: ['neck', 'torso'], noTurn: true },
  ]
  // back edges: 0 hem, 1 side (body right), 2 armhole R, 3 shoulder R, 4 neck, 5 shoulder L, 6 armhole L, 7 side L
  const seams: Seam[] = [
    { a: [['frontL', 6]], b: [['frontR', 6]] }, // placket, below the V
    { a: [['frontL', 1]], b: [['back', 7]] },
    { a: [['frontR', 1]], b: [['back', 1]] },
    { a: [['frontL', 3]], b: [['back', 5]] },
    { a: [['frontR', 3]], b: [['back', 3]] },
    { a: [['sleeveL', 1]], b: [['sleeveL', 4]] }, // underarm seams close the sleeve tubes
    { a: [['sleeveR', 1]], b: [['sleeveR', 4]] },
    { a: [['sleeveL', 2], ['sleeveL', 3]], b: [['back', 6, true], ['frontL', 2, true]] },
    { a: [['sleeveR', 2], ['sleeveR', 3]], b: [['frontR', 2], ['back', 2, true]] },
    { a: [['collar', 0]], b: [['frontR', 4, true], ['back', 4], ['frontL', 4]] },
  ]
  return { pieces, seams }
}

/**
 * Wide knee shorts (guide 1): a front and a back piece per leg with proper crotch curves, sewn at
 * centre front and back, inseams and side seams; the waistband (top edges) is elastic.
 */
export function wideShorts(f: BodyFrame): { pieces: Piece[]; seams: Seam[]; band: [string, number][] } {
  const hipEase = 0.16
  const topY = f.hipY + 0.11
  const hemY = 0.56 * f.hipY
  const crotchY = f.crotchY - 0.02
  const hipLevel = f.hipY - 0.03
  const hx = Math.abs(f.J['upperleg01.L'][0])
  const hem = f.thigh * 1.45
  const draft = (isBack: boolean) => {
    const wHip = (f.hip + hipEase) / 4 + (isBack ? 0.012 : -0.012)
    const wTop = (f.waist + 0.06) / 4 + (isBack ? 0.01 : -0.01)
    const ext = isBack ? 0.085 : 0.045
    const rise = isBack ? 0.035 : 0
    const hemW = hem / 2 + (isBack ? 0.01 : -0.01)
    const xi = hx - hemW / 2
    const Y = (wy: number) => wy - hemY
    // CF/CB top → crotch → inner hem → outer hem → side at hip → side at top
    const o: P2[] = [[0, Y(topY + rise)], [-ext, Y(crotchY)], [xi, 0], [xi + hemW, 0], [wHip, Y(hipLevel)], [wTop, Y(topY)]]
    const c = [isBack ? 0.025 : 0.02, 0, 0, 0, 0, 0]
    return { o, c }
  }
  const placeLeg = (side: 1 | -1, isBack: boolean) => (x: number, y: number): Vec3 => {
    const wy = hemY + y
    const xw = isBack ? -x : x // pattern x towards the world's +x on fronts, −x on backs
    const R = hem / 2 / Math.PI + 0.01
    const legC = f.leg(Math.min(wy, crotchY))
    const t = (xw - side * hx) / R
    const onLeg: Vec3 = [side * hx + R * Math.sin(t), wy, legC.cz + (isBack ? -1 : 1) * R * Math.cos(t)]
    const onHips = f.aroundTorso(x, wy, isBack, 0.02)
    return lerp3(onLeg, onHips, smooth01((wy - crotchY + 0.02) / 0.14))
  }
  const fl = draft(false), bk = draft(true)
  const [frO, frC] = mirror(fl.o, fl.c)
  const [blO, blC] = mirror(bk.o, bk.c)
  const pieces: Piece[] = [
    { name: 'frontL', outline: fl.o, curves: fl.c, place: placeLeg(1, false), anchor: LOWER },
    { name: 'frontR', outline: frO, curves: frC, place: placeLeg(-1, false), anchor: LOWER },
    // backs are drawn from behind: the body's left is the pattern's −x
    { name: 'backL', outline: blO, curves: blC, place: placeLeg(1, true), anchor: LOWER },
    { name: 'backR', outline: bk.o, curves: bk.c, place: placeLeg(-1, true), anchor: LOWER },
  ]
  // edges: 0 centre rise, 1 inseam, 2 hem, 3 side lower, 4 side upper, 5 waist
  const seams: Seam[] = [
    { a: [['frontL', 0]], b: [['frontR', 0]] },
    { a: [['backL', 0]], b: [['backR', 0]] },
    { a: [['frontL', 1]], b: [['backL', 1]] },
    { a: [['frontR', 1]], b: [['backR', 1]] },
    { a: [['frontL', 3], ['frontL', 4]], b: [['backL', 3], ['backL', 4]] },
    { a: [['frontR', 3], ['frontR', 4]], b: [['backR', 3], ['backR', 4]] },
  ]
  return { pieces, seams, band: [['frontL', 5], ['frontR', 5], ['backL', 5], ['backR', 5]] }
}

/**
 * Off-shoulder ruched mini dress (guide 2): a fitted jersey bodice whose elastic neckline runs
 * across the upper arms, long sleeves cut longer than the arm so they gather, and a front skirt cut
 * longer than its side seams so it ruches into folds across the hips.
 */
/** `tight`: skin-tight, a bodycon dress with no flare and slim sleeves. */
export function offShoulderDress(f: BodyFrame, o: { hemY?: number; sleeveLength?: number; ruche?: number; tight?: boolean; gapAt?: (y: number) => number } = {}): { pieces: Piece[]; seams: Seam[]; band: [string, number][] } {
  const sh = f.J['upperarm01.L'], el = f.J['lowerarm01.L'], wr = f.J['wrist.L']
  const neckY = sh[1] - 0.05 // across the upper arms, below the shoulder points: shoulders bare
  const underY = sh[1] - 0.125
  const hemY = o.hemY ?? f.crotchY - 0.14 // mini: mid-thigh
  const waistY = f.waistY(underY)
  const RUCHE = o.ruche ?? 1.35 // front skirt length per seam length
  // fitted: the jersey hugs the body; skin-tight it sits on it and the skirt doesn't flare
  // (cut with the original ease and flare, a bodycon mini came out as a loose, boxy tunic)
  const gap = o.tight ? 0.002 : 0.008
  const skirtGap = o.gapAt ?? ((y: number) => gap + (o.tight ? 0.006 : 0.025) * smooth01((waistY - y) / (waistY - hemY)))

  // side seam corners every ~7 cm from the hem to the underarm
  const n = Math.max(4, Math.ceil((underY - hemY) / 0.07))
  const levels = Array.from({ length: n }, (_, i) => hemY + ((underY - hemY) * i) / (n - 1))
  const q = (y: number) => f.quarter(y, skirtGap(y))
  // the bodice front stops at the arm crease; the sleeves take over the shoulders
  const neckQ = (() => {
    const s = f.torso(neckY), r = (s.a + s.b) / 2 + gap
    return Math.asin(Math.min(1, (sh[0] - f.armR * 0.9) / (s.a + gap))) * r
  })()

  // front pattern height per world height: 1 above the waist, easing up to RUCHE over 12 cm below
  // it (a sudden change made a tuck at the waist like a pocket slit)
  const gather = (y: number) => 1 + (RUCHE - 1) * smooth01((waistY - y) / 0.12)
  const table: number[] = [0] // pattern y at world y = hemY + i mm
  for (let i = 1, y = hemY; y < neckY + 0.01; i++, y += 0.001) table.push(table[i - 1] + 0.001 * gather(y + 0.0005))
  const frontY = (y: number) => {
    const t = (y - hemY) / 0.001, i = Math.min(table.length - 2, Math.max(0, Math.floor(t)))
    return table[i] + (table[i + 1] - table[i]) * (t - i)
  }
  const frontWorld = (yp: number) => {
    let lo = 0, hi = table.length - 1
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (table[m] < yp) lo = m; else hi = m }
    return hemY + 0.001 * (lo + (yp - table[lo]) / (table[hi] - table[lo] || 1))
  }
  const panel = (py: (y: number) => number) => {
    // corners: hem L, hem R, right side up, neck R, neck L, left side down (see edge list below)
    const right = levels.map((y) => [q(y), py(y)] as P2)
    const o: P2[] = [[-right[0][0], 0], ...right, [neckQ, py(neckY)], [-neckQ, py(neckY)], ...right.slice(1).reverse().map(([x, y]) => [-x, y] as P2)]
    const c = o.map(() => 0)
    c[n] = 0.012 // armhole scoops in
    c[n + 1] = 0.012 // neckline dips a little at the centre
    c[n + 2] = 0.012
    return { o, c }
  }
  // edges: 0 hem; 1..n−1 side (+x); n armhole (+x); n+1 neckline; n+2 armhole (−x); n+3..2n+1 side (−x)
  const sideP = Array.from({ length: n - 1 }, (_, i) => 1 + i)
  const sideM = Array.from({ length: n - 1 }, (_, i) => n + 3 + i)
  const front = panel(frontY), back = panel((y) => y - hemY)
  const torsoPlace = (isBack: boolean) => (x: number, yp: number) => {
    const y = isBack ? hemY + yp : frontWorld(yp)
    return f.aroundTorso(x, y, isBack, skirtGap(y))
  }

  // sleeve: a tube round the arm; above the underarm only its top half (the cap) runs up to the
  // neckline, its two slanted edges sewn to the bodice armholes
  const C = 2 * Math.PI * (f.armR + (o.tight ? 0.005 : 0.012))
  const capH = neckY - underY
  const l1 = Math.hypot(...sub(el, sh)), l2 = Math.hypot(...sub(wr, el))
  const SLEEVE_RUCHE = o.tight ? 1.04 : 1.15
  // the sleeve tops start this far down the arm, leaving the shoulder points bare; any lower and,
  // with the arms hanging, they dragged the neckline down past the bust
  const DROP = 0.07
  // sleeve length from the shoulder joint down the arm (to the wrist unless asked otherwise)
  const reach = Math.max(DROP + capH + 0.06, Math.min(l1 + l2, o.sleeveLength ?? l1 + l2))
  const L = SLEEVE_RUCHE * (reach - DROP - capH - 0.02)
  // half the cuff width: round the wrist, or as wide as the cap on a short sleeve
  const wristEase = o.tight ? 0.007 : 0.02
  const cuff = Math.PI * (f.wristR + wristEase) + (C / 2 - Math.PI * (f.wristR + wristEase)) * Math.max(0, Math.min(1, 1 - (reach - l1 * 0.5) / (l1 + l2 - l1 * 0.5)))
  const sleeve: P2[] = [[-cuff, 0], [cuff, 0], [C / 2, L], [C / 4, L + capH], [-C / 4, L + capH], [-C / 2, L]]
  // edges: 0 cuff, 1 underarm (+x), 2 cap (+x), 3 top (neckline), 4 cap (−x), 5 underarm (−x)
  const placeL = (() => {
    const s0 = sh, e0 = el, w0 = wr
    const frame = (a: Vec3, b: Vec3) => {
      const d = norm(sub(b, a))
      const o = norm(sub([0, 1, 0], scale(d, d[1])))
      return { d, o, w: cross(o, d) }
    }
    const up = frame(s0, e0), lo = frame(e0, w0)
    return (x: number, y: number): Vec3 => {
      const along = DROP + (y > L ? L + capH - y : capH + (L - y) / SLEEVE_RUCHE)
      // the tube's girth follows the outline's width, so both underarm edges start under the arm
      const R = (y > L ? C : 2 * cuff + (C - 2 * cuff) * (y / L)) / (2 * Math.PI)
      const t = x / R
      const at = (fr: typeof up, base: Vec3, s: number) => add(add(base, scale(fr.d, s)), add(scale(fr.o, R * Math.cos(t)), scale(fr.w, R * Math.sin(t))))
      const p1 = at(up, s0, along), p2 = at(lo, e0, along - l1)
      return lerp3(p1, p2, smooth01((along - l1 + 0.04) / 0.08))
    }
  })()
  // the right sleeve is the left one mirrored, outline and all (so its faces still point outwards):
  // an unmirrored outline placed mirror-wise came out inside out and shaded with a dark streak
  const placeR = (x: number, y: number): Vec3 => {
    const p = placeL(-x, y)
    return [-p[0], p[1], p[2]]
  }
  const [sleeveR] = mirror(sleeve, sleeve.map(() => 0))
  // which cap edge faces the front: the +x cap corner of the left sleeve, in front of the shoulder?
  const capPFrontL = placeL(C / 4, L + capH)[2] > sh[2]
  const capPFrontR = capPFrontL

  const [blO, blC] = [back.o, back.c]
  const pieces: Piece[] = [
    { name: 'front', outline: front.o, curves: front.c, place: torsoPlace(false), passThrough: true, anchor: TORSO, noTurn: true },
    { name: 'back', outline: blO, curves: blC, place: torsoPlace(true), passThrough: true, anchor: TORSO, noTurn: true },
    { name: 'sleeveL', outline: sleeve, place: placeL, anchor: ARM },
    { name: 'sleeveR', outline: sleeveR, place: placeR, anchor: ARM },
  ]
  const chain = (name: string, edges: number[]) => edges.map((e) => [name, e] as [string, number])
  // front +x is the body's left; the back is drawn from behind, so its −x side is the body's left
  const seams: Seam[] = [
    { a: chain('front', sideP), b: chain('back', sideM) },
    { a: chain('front', sideM), b: chain('back', sideP) },
    { a: [['sleeveL', 1]], b: [['sleeveL', 5]] },
    { a: [['sleeveR', 1]], b: [['sleeveR', 5]] },
    { a: [['sleeveL', capPFrontL ? 2 : 4]], b: [['front', n]] },
    { a: [['sleeveL', capPFrontL ? 4 : 2]], b: [['back', n + 2]] },
    { a: [['sleeveR', capPFrontR ? 2 : 4]], b: [['front', n + 2]] },
    { a: [['sleeveR', capPFrontR ? 4 : 2]], b: [['back', n]] },
  ]
  const band: [string, number][] = [['front', n + 1], ['back', n + 1], ['sleeveL', 3], ['sleeveR', 3], ['sleeveL', 0], ['sleeveR', 0]]
  return { pieces, seams, band }
}

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
export const norm = (a: Vec3): Vec3 => scale(a, 1 / (Math.hypot(...a) || 1))
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

/**
 * Off-shoulder sleeves for a garment drawn from a photo (chart.ts): a tube round each arm whose top edge
 * carries on the neckline, its cap edges sewn to the bodice's armholes, which run from the underarm (`underY`)
 * up to the neckline's end at the arm (`topY`). As in offShoulderDress.
 * Edges: 0 cuff, 1 underarm (+x), 2 cap (+x), 3 top (the neckline), 4 cap (−x), 5 underarm (−x).
 * `capFront`: whether edge 2 is the cap edge in front of the shoulder.
 */
export function offShoulderSleeves(f: BodyFrame, o: { topY: number; underY: number; reach: number; tight: boolean }): { pieces: Piece[]; capFront: boolean } {
  const sh = f.J['upperarm01.L'], el = f.J['lowerarm01.L'], wr = f.J['wrist.L']
  const C = 2 * Math.PI * (f.armR + (o.tight ? 0.005 : 0.012))
  const capH = Math.max(0.03, o.topY - o.underY)
  const l1 = Math.hypot(...sub(el, sh)), l2 = Math.hypot(...sub(wr, el))
  const RUCHE = o.tight ? 1.04 : 1.15
  const DROP = Math.max(0.03, sh[1] - o.topY + 0.02)
  const reach = Math.max(DROP + capH + 0.06, Math.min(l1 + l2, o.reach))
  const L = RUCHE * (reach - DROP - capH - 0.02)
  const wristEase = o.tight ? 0.007 : 0.02
  const cuff = Math.PI * (f.wristR + wristEase) + (C / 2 - Math.PI * (f.wristR + wristEase)) * Math.max(0, Math.min(1, 1 - (reach - l1 * 0.5) / (l1 + l2 - l1 * 0.5)))
  const sleeve: P2[] = [[-cuff, 0], [cuff, 0], [C / 2, L], [C / 4, L + capH], [-C / 4, L + capH], [-C / 2, L]]
  const frame = (a: Vec3, b: Vec3) => {
    const d = norm(sub(b, a))
    const up = norm(sub([0, 1, 0], scale(d, d[1])))
    return { d, o: up, w: cross(up, d) }
  }
  const up = frame(sh, el), lo = frame(el, wr)
  const placeL = (x: number, y: number): Vec3 => {
    const along = DROP + (y > L ? L + capH - y : capH + (L - y) / RUCHE)
    const R = (y > L ? C : 2 * cuff + (C - 2 * cuff) * (y / L)) / (2 * Math.PI)
    const t = x / R
    const at = (fr: typeof up, base: Vec3, s: number) => add(add(base, scale(fr.d, s)), add(scale(fr.o, R * Math.cos(t)), scale(fr.w, R * Math.sin(t))))
    return lerp3(at(up, sh, along), at(lo, el, along - l1), smooth01((along - l1 + 0.04) / 0.08))
  }
  const placeR = (x: number, y: number): Vec3 => { const p = placeL(-x, y); return [-p[0], p[1], p[2]] }
  const [sleeveR] = mirror(sleeve, sleeve.map(() => 0))
  return {
    pieces: [
      { name: 'sleeveL', outline: sleeve, place: placeL, anchor: ARM },
      { name: 'sleeveR', outline: sleeveR, place: placeR, anchor: ARM },
    ],
    capFront: placeL(C / 4, L + capH)[2] > sh[2],
  }
}
