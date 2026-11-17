// The everyday wardrobe as patterns: a general top (tee, henley, tank), trousers (chinos, cargo
// shorts), an A-line skirt and the evening gown. Same conventions as drafts.ts: metres, x across the
// piece, y up from its hem, fronts drawn with +x towards the body's left, backs from behind.

import type { Vec3 } from '../body/bodySet'
import type { Piece, Seam } from './assemble'
import { ARM, BodyFrame, LOWER, TORSO, add, cross, lerp3, mirror, norm, scale, smooth01, sub } from './drafts'
import type { P2 } from './mesh2d'
import { vertexNormals } from '../math/mesh'

type Draft = { pieces: Piece[]; seams: Seam[]; band: [string, number][] }

const range = (n: number) => Array.from({ length: n }, (_, i) => i)
const chain = (name: string, edges: number[]) => edges.map((e) => [name, e] as [string, number])

/** `n` heights from `lo` to `hi` inclusive, evenly spaced. */
const levels = (lo: number, hi: number, n: number) => range(n).map((i) => lo + ((hi - lo) * i) / (n - 1))

/**
 * A pair of set-in sleeves. Each is a tube round the arm, its top `capH` a cap shaped to the
 * armhole; it starts `top` m down the arm from the shoulder joint and covers `length` m of it
 * (past the elbow, it follows the forearm). The right sleeve is the left one mirrored, outline and
 * all, so its faces point outwards too.
 * Edges: 0 hem, 1 underarm (+x), 2 cap (+x), 3 cap (−x), 4 underarm (−x).
 */
export function sleevePair(f: BodyFrame, o: { top: number; length: number; capH: number; half: number; hemHalf: number; clear: number }): Piece[] {
  const sh = f.J['upperarm01.L'], el = f.J['lowerarm01.L'], wr = f.J['wrist.L']
  const l1 = Math.hypot(...sub(el, sh))
  const Lp = o.length
  const body = Lp - o.capH
  const outline: P2[] = [[-o.hemHalf, 0], [o.hemHalf, 0], [o.half, body], [0, Lp], [-o.half, body]]
  const curves = [0, 0, -0.012, -0.012, 0]
  const frame = (a: Vec3, b: Vec3) => {
    const d = norm(sub(b, a))
    const up = norm(sub([0, 1, 0], scale(d, d[1])))
    return { d, o: up, w: cross(up, d) }
  }
  const upper = frame(sh, el), lower = frame(el, wr)
  const placeL = (x: number, y: number): Vec3 => {
    const along = o.top + (Lp - y)
    // girth follows the outline's width, so both underarm edges start under the arm
    const width = y > body ? o.half : o.hemHalf + (o.half - o.hemHalf) * (y / body)
    const R = width / Math.PI + o.clear
    const t = (x / width) * Math.PI
    const at = (fr: typeof upper, base: Vec3, s: number) => add(add(base, scale(fr.d, s)), add(scale(fr.o, R * Math.cos(t)), scale(fr.w, R * Math.sin(t))))
    return lerp3(at(upper, sh, along), at(lower, el, along - l1), smooth01((along - l1 + 0.04) / 0.08))
  }
  const placeR = (x: number, y: number): Vec3 => {
    const p = placeL(-x, y)
    return [-p[0], p[1], p[2]]
  }
  const [outR, curR] = mirror(outline, curves)
  return [
    { name: 'sleeveL', outline, curves, place: placeL, anchor: ARM },
    { name: 'sleeveR', outline: outR, curves: curR, place: placeR, anchor: ARM },
  ]
}

export interface TopOptions {
  /** ease out from the skin all round (m); also where the pattern is placed */
  ease: number
  /** hem height relative to the hip joints (m, negative = below) */
  hem: number
  sleeve: 'none' | 'short' | 'long'
  /** neckline: half-width beyond the neck, and how far it dips at the front and back centre (m) */
  neck: { width: number; front: number; back: number }
  /** sleeveless: shoulder strap width (m) */
  strap?: number
  /** sleeve length from the shoulder (m), instead of the set short or long length */
  sleeveLength?: number
  /** thickness of the garment underneath at height y (m): the top keeps clear of it */
  under?: (y: number) => number
  /** ease at each height (m), instead of `ease` everywhere: a garment's silhouette read from a photo */
  easeAt?: (y: number) => number
  /** fitted sleeves: narrowing to the wrist on the skin */
  slimSleeves?: boolean
  /** half the sleeve hem's girth (m): wide for a bell sleeve */
  sleeveHemHalf?: number
  /** how far the front hem drops below the hem line (m) across the front, u from −1 (body right) to 1:
   *  an asymmetric or curved hem. The side corners stay on the hem line. */
  hemDrop?: (u: number) => number
}

/**
 * A top with a front, a back and (optionally) set-in sleeves; the sides follow the body's own
 * cross-sections every ~7 cm, so a tight fit hugs the bust and waist and a loose one hangs evenly.
 */
export function top(f: BodyFrame, o: TopOptions): Draft {
  const sh = f.J['upperarm01.L']
  const hps = f.neckY - 0.004
  const hemY = f.hipY + o.hem
  const H = hps - hemY
  const sleeveless = o.sleeve === 'none'
  const underY = sh[1] - (sleeveless ? 0.11 : 0.09)
  const n = Math.max(4, Math.ceil((underY - hemY) / 0.07))
  const ys = levels(hemY, underY, n)
  // where it lies over a bottom the top has to clear the bottom's thickness (pressed onto shorts, a
  // tight tank hem rolled up above the waist); a fixed 3 cm there flared the tank like a peplum
  // (stepping with the bottom's thickness height by height notched the hem): one smooth ramp down
  // from 4 cm above the bottom's top edge
  const under = o.under ?? (() => 0)
  let underTop = -1, underMax = 0
  for (let y = hemY; y < underY; y += 0.01) if (under(y) > 0.001) { underTop = y; underMax = Math.max(underMax, under(y)) }
  const base = o.easeAt ?? (() => o.ease)
  const ease = (y: number) => base(y) + Math.max(0, underMax + 0.008 - base(y)) * (underTop < 0 ? 0 : smooth01((underTop + 0.04 - y) / 0.1))
  const q = (y: number) => f.quarter(y, ease(y))
  const nw = f.neckHalfWidth + o.neck.width
  const tipY = hps - 0.045
  const tip = sleeveless ? nw + (o.strap ?? 0.05) : f.arcTo(tipY, Math.abs(sh[0]) + 0.01, o.ease)

  // corners: hem L, hem R, right side up to the underarm, shoulder tip R, neck R, neck L, shoulder
  // tip L, left side down. Edges: 0 hem; 1..n−1 side (+x); n armhole (+x); n+1 shoulder (+x);
  // n+2 neckline; n+3 shoulder (−x); n+4 armhole (−x); n+5..2n+3 side (−x)
  const panel = (neckDip: number, extra: number) => {
    const right = ys.map((y) => [q(y), y - hemY] as P2)
    const outline: P2[] = [[-right[0][0], 0], ...right, [tip, tipY - hemY], [nw, H + extra], [-nw, H + extra], [-tip, tipY - hemY], ...right.slice(1).reverse().map(([x, y]) => [-x, y] as P2)]
    const curves = outline.map(() => 0)
    const scoop = sleeveless ? 0.035 : 0.016 // armholes curve in (a tank's deeply)
    curves[n] = scoop
    curves[n + 4] = scoop
    curves[n + 2] = neckDip
    return { outline, curves }
  }
  const front = panel(o.neck.front, 0), back = panel(o.neck.back, 0.01)
  let frontHemPath: P2[] | undefined
  if (o.hemDrop) {
    const r0 = front.outline[1][0]
    frontHemPath = range(15).map((i) => { const u = -1 + (2 * (i + 1)) / 16; return [u * r0, -o.hemDrop!(u)] as P2 })
  }
  // Over a belly or bust the front centre is longer than its height: cut by height, the hem rode
  // up above the waistband on curvy and heavy bodies. The difference, from the body's own front
  // profile, goes into a hem that dips at the centre front (as a real pattern's would).
  const profile = (isBack: boolean) => {
    let len = 0, prev = NaN
    for (let y = hemY; y <= underY; y += 0.02) {
      const s = f.torso(y), z = isBack ? s.cz - s.b : s.cz + s.b
      if (!Number.isNaN(prev)) len += Math.hypot(0.02, z - prev)
      prev = z
    }
    return Math.max(0, len - (underY - hemY))
  }
  front.curves[0] = -profile(false)
  back.curves[0] = -profile(true)
  const place = (isBack: boolean) => (x: number, y: number) => f.aroundTorso(x, hemY + y, isBack, ease(hemY + y))
  const pieces: Piece[] = [
    // body panels pass through the forearms and hands (hands on hips sit inside the ease)
    { name: 'front', outline: front.outline, curves: front.curves, paths: frontHemPath && { 0: frontHemPath }, place: place(false), passThrough: true, anchor: TORSO, noTurn: true },
    { name: 'back', outline: back.outline, curves: back.curves, place: place(true), passThrough: true, anchor: TORSO, noTurn: true },
  ]
  const sideP = range(n - 1).map((i) => 1 + i), sideM = range(n - 1).map((i) => n + 5 + i)
  const seams: Seam[] = [
    { a: chain('front', sideP), b: chain('back', sideM) },
    { a: chain('front', sideM), b: chain('back', sideP) },
    { a: [['front', n + 1]], b: [['back', n + 3]] },
    { a: [['front', n + 3]], b: [['back', n + 1]] },
  ]
  const band: [string, number][] = [['front', n + 2], ['back', n + 2]]
  if (sleeveless) band.push(['front', n], ['front', n + 4], ['back', n], ['back', n + 4])
  else {
    const armhole = Math.hypot(tip - q(underY), tipY - underY) * 1.04
    const capH = 0.075
    const half = Math.sqrt(Math.max(armhole ** 2 - capH ** 2, 0.004))
    const long = o.sleeve === 'long'
    const armLen = Math.hypot(...sub(f.J['lowerarm01.L'], sh)) + Math.hypot(...sub(f.J['wrist.L'], f.J['lowerarm01.L']))
    const cuff = Math.PI * (f.wristR + (o.slimSleeves ? 0.007 : 0.018))
    // Long sleeves run 1.5 cm past the wrist so a little cloth stacks there (cut short, they hung as
    // stiff tubes), and sleeves get a finer mesh: at 3 cm they shaded in coarse diagonal bands.
    const length = o.sleeveLength ?? (long ? armLen + 0.015 : 0.2)
    // a sleeve's hem narrows from the bicep towards the cuff as it runs down the arm
    const toCuff = Math.min(1, Math.max(0, (length - 0.2) / (armLen - 0.2)))
    const hemHalf = o.sleeveHemHalf ?? (o.sleeveLength === undefined ? (long ? Math.min(half, cuff) : half * 0.94) : half * 0.94 + (Math.min(half, cuff) - half * 0.94) * toCuff)
    const sleeves = sleevePair(f, { top: 0.02, length, capH, half, hemHalf, clear: 0.01 })
    for (const p of sleeves) p.spacing = 0.02
    pieces.push(...sleeves)
    seams.push(
      { a: [['sleeveL', 1]], b: [['sleeveL', 4]] },
      { a: [['sleeveR', 1]], b: [['sleeveR', 4]] },
      { a: [['sleeveL', 2], ['sleeveL', 3]], b: [['back', n + 4, true], ['front', n, true]] },
      { a: [['sleeveR', 2], ['sleeveR', 3]], b: [['front', n + 4, true], ['back', n, true]] },
    )
    if (long) band.push(['sleeveL', 0], ['sleeveR', 0])
  }
  return { pieces, seams, band }
}

export interface TrouserOptions {
  /** hem height (m) */
  hemY: number
  /** ease round each leg (m of girth) */
  legEase: number
  /** least hem girth (m) */
  hemGirth: number
  /** ease out from the skin round the hips and seat (m) */
  hipEase: number
  /** how far the crotch seam hangs below the body's crotch (m) */
  drop: number
}

/**
 * Trousers or shorts: a front and back piece per leg, sewn at centre front and back, inseams and
 * side seams, with an elastic waistband. Above the crotch the sides follow the body's hip
 * cross-sections every 5 cm (a fixed hip width bunched into lumps at the side seams); below it
 * each leg follows the leg's girth every ~9 cm. The crotch seam hangs `drop` below the body and
 * the back has a longer crotch extension for the seat: cut tight into the crotch, the seam was
 * pulled up between the thighs and they showed through it.
 */
export function trousers(f: BodyFrame, o: TrouserOptions): Draft {
  const topY = f.hipY + 0.11
  const crotchY = f.crotchY - o.drop
  const hx = Math.abs(f.J['upperleg01.L'][0])
  const hemY = o.hemY
  const m = Math.max(1, Math.round((crotchY - 0.07 - hemY) / 0.09))
  // inseam / side corner heights below the crotch, top to bottom
  const legYs = m === 1 ? [crotchY - 0.07] : levels(hemY + 0.04, crotchY - 0.07, m).reverse()
  // side corner heights from hip level up, bottom to top (the last is the waist); between the
  // crotch and hip level the side runs straight up from the leg (the torso cross-section there
  // spans both thighs, and following it puffed the side seams out)
  const hipLevel = Math.max(crotchY + 0.05, f.hipY - 0.03)
  const hipYs = levels(hipLevel, topY, Math.max(3, Math.ceil((topY - hipLevel) / 0.05)))
  const girth = (y: number) => 2 * Math.PI * f.leg(y).r + o.legEase
  // each leg tapers straight from the thigh to the hem width, never tighter than the leg plus
  // ease (held at the hem width all the way up, the legs were stiff boxy tubes)
  const hemHalf = Math.max(girth(hemY), o.hemGirth) / 2, thighHalf = girth(crotchY - 0.05) / 2
  const halfW = (y: number) => Math.max(girth(y) / 2, hemHalf + (thighHalf - hemHalf) * Math.min(1, Math.max(0, (y - hemY) / (crotchY - 0.05 - hemY))))
  // ease over the hips, easing in to a snug elastic waist
  const gap = (y: number) => o.hipEase - (o.hipEase - 0.008) * smooth01((y - (topY - 0.06)) / 0.06)
  const draft = (isBack: boolean) => {
    const split = isBack ? 0.012 : -0.012 // the back is cut fuller, over the seat
    const ext = isBack ? 0.1 : 0.05
    const rise = isBack ? 0.04 : 0
    const w = (y: number) => halfW(y) + (isBack ? 0.01 : -0.01)
    const Y = (wy: number) => wy - hemY
    const hemW = w(hemY)
    // CF/CB top → crotch → inseam corners → inner hem → outer hem → leg side → hip side → waist side
    const outline: P2[] = [
      [0, Y(topY + rise)], [-ext, Y(crotchY)],
      ...legYs.map((y) => [hx - w(y) / 2, Y(y)] as P2),
      [hx - hemW / 2, 0], [hx + hemW / 2, 0],
      ...[...legYs].reverse().map((y) => [hx + w(y) / 2, Y(y)] as P2),
      [hx + w(crotchY) / 2, Y(crotchY)],
      // only up to the hips is the side held out to the leg width; held out at the waist too, the
      // waistband was too wide there and its side corners stuck up through the top's hem
      ...hipYs.map((y) => [y < f.hipY + 0.03 ? Math.max(f.quarter(y, gap(y)) + split, hx + w(crotchY) / 2 - 0.01) : f.quarter(y, gap(y)) + split, Y(y)] as P2),
    ]
    const curves = outline.map(() => 0)
    curves[0] = isBack ? 0.03 : 0.025 // the crotch curve
    // the piece's inner edge (centre seam above the crotch, inseam below) and side edge, by height
    const inner = [outline[0], outline[1], ...outline.slice(2, m + 3)].reverse() // hem → crotch → top
    const sideEdge = outline.slice(m + 3) // hem → waist
    return { outline, curves, inner, sideEdge }
  }
  const fl = draft(false), bk = draft(true)
  /** x of a polyline (listed bottom to top) at height y, clamped to its ends */
  const xAt = (line: P2[], y: number) => {
    if (y <= line[0][1]) return line[0][0]
    for (let i = 1; i < line.length; i++)
      if (y <= line[i][1]) return line[i - 1][0] + ((line[i][0] - line[i - 1][0]) * (y - line[i - 1][1])) / (line[i][1] - line[i - 1][1] || 1)
    return line[line.length - 1][0]
  }
  // Around the leg, a point goes by how far across the piece it is, inseam (0) to side seam (1),
  // so the side seam lands at the side of the leg at every height. Placed by distance from a
  // fixed leg centre instead, the side seam overshot where the pattern widens over the hips and
  // the leg ballooned out there.
  const placeLeg = (side: 1 | -1, d: typeof fl, isBack: boolean, other: typeof fl) => (x: number, y: number): Vec3 => {
    const wy = hemY + y
    const xin = xAt(d.inner, y), xout = xAt(d.sideEdge, y)
    const frac = Math.min(1, Math.max(0, (x - xin) / (xout - xin || 1)))
    const legY = Math.min(wy, crotchY)
    // one radius for the front and back of a leg, from both widths: each from its own, the two
    // edges of a seam started at different radii and sewed into a ridge
    const R = (Math.abs(xout - xin) + Math.abs(xAt(other.sideEdge, y) - xAt(other.inner, y))) / (2 * Math.PI) + 0.006
    const legC = f.leg(legY)
    const t = side * (frac - 0.5) * Math.PI
    const onLeg: Vec3 = [side * legC.cx + R * Math.sin(t), wy, legC.cz + (isBack ? -1 : 1) * R * Math.cos(t)]
    const onHips = f.aroundTorso(x, wy, isBack, gap(wy))
    return lerp3(onLeg, onHips, smooth01((wy - crotchY + 0.02) / 0.12))
  }
  const mirrored = (d: typeof fl): typeof fl => {
    const [outline, curves] = mirror(d.outline, d.curves)
    return { outline, curves, inner: d.inner.map(([x, y]) => [-x, y] as P2), sideEdge: d.sideEdge.map(([x, y]) => [-x, y] as P2) }
  }
  const fr = mirrored(fl), bl = mirrored(bk)
  const pieces: Piece[] = [
    { name: 'frontL', outline: fl.outline, curves: fl.curves, place: placeLeg(1, fl, false, bl), anchor: LOWER },
    { name: 'frontR', outline: fr.outline, curves: fr.curves, place: placeLeg(-1, fr, false, bk), anchor: LOWER },
    { name: 'backL', outline: bl.outline, curves: bl.curves, place: placeLeg(1, bl, true, fl), anchor: LOWER },
    { name: 'backR', outline: bk.outline, curves: bk.curves, place: placeLeg(-1, bk, true, fr), anchor: LOWER },
  ]
  // edges: 0 centre rise; 1..m+1 inseam; m+2 hem; m+3.. side up to the waist corner; last waist
  const k = fl.outline.length
  const inseam = range(m + 1).map((i) => 1 + i), side = range(k - 1 - (m + 3)).map((i) => m + 3 + i), waist = k - 1
  const seams: Seam[] = [
    { a: [['frontL', 0]], b: [['frontR', 0]] },
    { a: [['backL', 0]], b: [['backR', 0]] },
    { a: chain('frontL', inseam), b: chain('backL', inseam) },
    { a: chain('frontR', inseam), b: chain('backR', inseam) },
    { a: chain('frontL', side), b: chain('backL', side) },
    { a: chain('frontR', side), b: chain('backR', side) },
  ]
  return { pieces, seams, band: [['frontL', waist], ['frontR', waist], ['backL', waist], ['backR', waist]] }
}

/**
 * Where a flared skirt hangs at height y: an ellipse round the body that grows from the hip
 * cross-section at `startY` out to a circle of radius `hemR` at `hemY` (bulging out early, as a
 * flared skirt does), never closer than `gap` to the body.
 */
function flare(f: BodyFrame, startY: number, hemY: number, hemR: number, gap: number) {
  const s0 = f.torso(startY), cz = s0.cz
  return (y: number) => {
    const u = smooth01(Math.max(0, (startY - y) / (startY - hemY))) ** 0.85
    const s = f.torso(Math.max(y, f.crotchY - 0.1))
    const a = Math.max(s.a + gap, s0.a + gap + (hemR - s0.a - gap) * u)
    const b = Math.max(s.b + gap, s0.b + gap + (hemR - s0.b - gap) * u)
    return { a, b, cz }
  }
}

/** A point at pattern x (−w..w spans the front or back half) on an ellipse. */
const onEllipse = (e: { a: number; b: number; cz: number }, x: number, w: number, y: number, isBack: boolean): Vec3 => {
  const t = (x / w) * (Math.PI / 2) * (isBack ? -1 : 1)
  return [e.a * Math.sin(t), y, e.cz + (isBack ? -1 : 1) * e.b * Math.cos(t)]
}

/** Skirt panels from `topY` down, eased `topEase` at the top and at least 1.8 cm over the hips, then
 * flared to `hemGirth`. Edges: 0 hem, 1 side lower (+x), 2 side upper (+x), 3 top, 4 side upper (−x), 5 side lower (−x). */
function skirtPanels(f: BodyFrame, o: { topY: number; topEase: number; hemY: number; hemGirth: number; front: string; back: string }): Draft {
  const { topY, hemY } = o
  const hipLevel = f.hipY - 0.02, hipEase = Math.max(0.018, o.topEase)
  const wTop = f.quarter(topY, o.topEase), wHip = f.quarter(hipLevel, hipEase), wHem = Math.max(o.hemGirth / 4, wHip)
  const at = flare(f, hipLevel, hemY, o.hemGirth / (2 * Math.PI) * 0.92, hipEase)
  const piece = (): P2[] => [[-wHem, 0], [wHem, 0], [wHip, hipLevel - hemY], [wTop, topY - hemY], [-wTop, topY - hemY], [-wHip, hipLevel - hemY]]
  const place = (isBack: boolean) => (x: number, y: number): Vec3 => {
    const wy = hemY + y
    if (wy >= hipLevel) return f.aroundTorso(x, wy, isBack, o.topEase + (hipEase - o.topEase) * smooth01((topY - wy) / (topY - hipLevel)))
    const w = wHip + (wHem - wHip) * ((hipLevel - wy) / (hipLevel - hemY))
    return onEllipse(at(wy), x, w, wy, isBack)
  }
  const pieces: Piece[] = [
    { name: o.front, outline: piece(), place: place(false), anchor: LOWER },
    { name: o.back, outline: piece(), place: place(true), anchor: LOWER },
  ]
  const seams: Seam[] = [
    { a: chain(o.front, [1, 2]), b: chain(o.back, [4, 5]) },
    { a: chain(o.front, [4, 5]), b: chain(o.back, [1, 2]) },
  ]
  return { pieces, seams, band: [] }
}

/** A-line skirt from the waist: a front and back piece, flared below the hips, elastic waistband. */
export function aSkirt(f: BodyFrame, o: { hemY: number; hemGirth: number }): Draft {
  const topY = f.waistY(f.J['upperarm01.L'][1] - 0.1) - 0.02
  const d = skirtPanels(f, { topY, topEase: 0.006, hemY: o.hemY, hemGirth: o.hemGirth, front: 'front', back: 'back' })
  return { ...d, band: [['front', 3], ['back', 3]] }
}

export interface DressOptions {
  ease: number
  sleeve: TopOptions['sleeve']
  neck: TopOptions['neck']
  strap?: number
  /** hem height above the floor (m) and its girth (m) */
  hemY: number
  hemGirth: number
  /** waist seam height (m); the natural waist if unset */
  waistY?: number
  sleeveLength?: number
  easeAt?: (y: number) => number
  slimSleeves?: boolean
}

/**
 * A day dress: a `top()` bodice cut off at the natural waist with a skirt sewn on. The bodice hangs
 * from the shoulders as a top does, so the skirt needs no waistband of its own.
 */
export function dress(f: BodyFrame, o: DressOptions): Draft {
  const waistY = o.waistY ?? f.waistY(f.J['upperarm01.L'][1] - 0.1)
  const bodice = top(f, { ease: o.ease, hem: waistY - f.hipY, sleeve: o.sleeve, neck: o.neck, strap: o.strap, sleeveLength: o.sleeveLength, easeAt: o.easeAt, slimSleeves: o.slimSleeves })
  // a top's hem dips at the centre front over the bust; sewn to a skirt the waist seam stays level
  for (const p of bodice.pieces) if ((p.name === 'front' || p.name === 'back') && p.curves) p.curves[0] = 0
  const skirt = skirtPanels(f, { topY: waistY, topEase: o.easeAt ? o.easeAt(waistY) : o.ease, hemY: o.hemY, hemGirth: o.hemGirth, front: 'skirtF', back: 'skirtB' })
  return {
    pieces: [...bodice.pieces, ...skirt.pieces],
    seams: [...bodice.seams, ...skirt.seams, { a: [['front', 0]], b: [['skirtF', 3]] }, { a: [['back', 0]], b: [['skirtB', 3]] }],
    band: bodice.band,
  }
}

/**
 * Evening gown after House of Worth: a boned strapless bodice with a sweetheart top edge (its pale
 * band is drawn as a trim) and a floor-length skirt cut half as wide again as the bodice's waist
 * and gathered into it, so it falls in deep folds.
 */
export function gown(f: BodyFrame, o: { hemY?: number; hemGirth?: number } = {}): Draft {
  const sh = f.J['upperarm01.L']
  // the bust peaks only ~9 cm below the shoulder joints: the top edge is set from those, not from
  // the underarm (cut from there it sat under the bust)
  const waistY = f.waistY(sh[1] - 0.11)
  const bustY = f.bustY(waistY, sh[1] - 0.04)
  const sideTop = sh[1] - 0.065
  const centreTop = bustY + 0.035
  const gap = 0.006
  const n = Math.max(3, Math.ceil((sideTop - waistY) / 0.06))
  const ys = levels(waistY, sideTop, n)
  const q = (y: number) => f.quarter(y, gap)
  const H = (y: number) => y - waistY
  const right = ys.map((y) => [q(y), H(y)] as P2)
  const left = right.slice(1).reverse().map(([x, y]) => [-x, y] as P2)
  // front: waist L, waist R, side up, centre top, side down. Edges: 0 waist; 1..n−1 side (+x);
  // n top (+x); n+1 top (−x); n+2..2n side (−x)
  const qT = right[n - 1][0]
  const front: P2[] = [[-right[0][0], 0], ...right, [0, H(centreTop)], ...left]
  const fCurves = front.map(() => 0)
  const HUMP = 0.03 // each half of the sweetheart edge rises over the bust
  fCurves[n] = -HUMP
  fCurves[n + 1] = -HUMP
  // back: straight top a little lower. Edges: 0 waist; 1..n−1 side (+x); n top; n+1..2n−1 side (−x)
  const backTop = sideTop - 0.01
  const back: P2[] = [[-right[0][0], 0], ...right.slice(0, -1), [qT, H(backTop)], [-qT, H(backTop)], ...left.slice(1)]
  // distance below the top edge, for the trim band
  const frontTop = (x: number) => {
    const u = 1 - Math.min(1, Math.abs(x) / qT)
    return H(sideTop) + (H(centreTop) - H(sideTop)) * u + HUMP * 4 * u * (1 - u)
  }
  const bodicePlace = (isBack: boolean) => (x: number, y: number) => f.aroundTorso(x, waistY + y, isBack, gap)

  // skirt: waist to just off the floor
  const hemY = o.hemY ?? 0.11 // the silk stretches a few cm under its weight: hemmed at the floor it pooled
  const Ls = waistY - hemY
  const wW = right[0][0] * 1.5, wH = Math.max(wW, (o.hemGirth ?? 3.0) / 4)
  const at = flare(f, waistY, hemY, o.hemGirth ? o.hemGirth / (2 * Math.PI) * 0.92 : 0.44, 0.03)
  const skirt: P2[] = [[-wH, 0], [wH, 0], [wW, Ls], [-wW, Ls]]
  const skirtPlace = (isBack: boolean) => (x: number, y: number): Vec3 => {
    const wy = hemY + y
    const w = wH + (wW - wH) * (y / Ls)
    return onEllipse(at(wy), x, w, wy, isBack)
  }
  const pieces: Piece[] = [
    { name: 'front', outline: front, curves: fCurves, place: bodicePlace(false), passThrough: true, anchor: TORSO, noTurn: true, trim: (x, y) => frontTop(x) - y },
    { name: 'back', outline: back, place: bodicePlace(true), passThrough: true, anchor: TORSO, noTurn: true, trim: (_, y) => H(backTop) - y },
    { name: 'skirtF', outline: skirt, place: skirtPlace(false), passThrough: true, anchor: LOWER },
    { name: 'skirtB', outline: skirt, place: skirtPlace(true), passThrough: true, anchor: LOWER },
  ]
  const seams: Seam[] = [
    { a: chain('front', range(n - 1).map((i) => 1 + i)), b: chain('back', range(n - 1).map((i) => n + 1 + i)) },
    { a: chain('front', range(n - 1).map((i) => n + 2 + i)), b: chain('back', range(n - 1).map((i) => 1 + i)) },
    { a: [['front', 0]], b: [['skirtF', 2]] },
    { a: [['back', 0]], b: [['skirtB', 2]] },
    { a: [['skirtF', 1]], b: [['skirtB', 3]] },
    { a: [['skirtF', 3]], b: [['skirtB', 1]] },
  ]
  return { pieces, seams, band: [['front', n], ['front', n + 1], ['back', n]] }
}

/**
 * The gown's petticoat, as extra collision clearance on the leg skin (per body vertex, so it
 * follows the legs through poses): the skirt is held out on a bell from the hips to the floor
 * instead of slumping onto the legs below the knee and crumpling there.
 */
export function petticoat(f: BodyFrame, positions: Float32Array, index: Uint32Array, labels: Uint8Array, legs: number[]) {
  const top = f.hipY, hem = 0.07, cz = f.torso(f.hipY).cz
  const normals = vertexNormals(positions, index)
  const lift = new Float32Array(labels.length)
  for (let v = 0; v < labels.length; v++) {
    if (!legs.includes(labels[v])) continue
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2] - cz
    if (y > top) continue
    // outward-facing skin only: collision pushes along the skin normal, and lifting the inner
    // thighs (normals towards the other leg) flung the skirt sideways on broad bodies
    const r = Math.hypot(x, z) || 1
    if ((normals[v * 3] * x + normals[v * 3 + 2] * z) / r < 0.4) continue
    const bell = f.torso(top).a + 0.03 + 0.2 * smooth01((top - y) / (top - hem)) ** 0.8
    lift[v] = Math.min(0.25, Math.max(0, bell - r))
  }
  return lift
}
