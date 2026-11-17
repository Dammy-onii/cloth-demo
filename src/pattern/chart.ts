// A garment drawn from its photo, not from a template (docs/garment-mapping.md). Every traced point is
// carried into body coordinates:
//   - height: between the wearer's own joints in the photo (MediaPipe), onto the model's joints;
//   - across: from the garment's right side seam (−1, the image's left) to its left one (+1).
// The front panel's outline is then the photo's own hem, side seams and neckline, each side at its own
// height. Openings are holes in the mesh and slits are notches in the hem. The back is inferred and
// shares the side seams. Panels wrap round the model's cross-sections (BodyFrame.aroundTorso) at the
// ease the photo shows: the garment's width over the body's at each height.
import type { Garment } from '../cloth/buildGarment'
import type { GarmentRead, Structure } from '../cloth/garmentRead'
import type { Mark } from '../cloth/garmentSpec'
import type { Joints } from '../photo/pose'
import type { Piece, Seam } from './assemble'
import { at, armLength, levelHeights } from './custom'
import { BodyFrame, TORSO, offShoulderSleeves } from './drafts'
import { sleevePair } from './garments'
import type { P2 } from './mesh2d'
import type { Crop } from './photoMap'

type Draft = { pieces: Piece[]; seams: Seam[]; band: [string, number][] }
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Piecewise-linear map through sorted (from, to) pairs, carried on past both ends. */
function piecewise(pairs: [number, number][]) {
  const p = pairs.slice().sort((a, b) => a[0] - b[0])
  return (v: number) => {
    let k = p.findIndex((q) => q[0] > v) - 1
    if (k < 0) k = v <= p[0][0] ? 0 : p.length - 2
    k = clamp(k, 0, p.length - 2)
    const [a0, b0] = p[k], [a1, b1] = p[k + 1]
    return b0 + (b1 - b0) * (v - a0) / (a1 - a0 || 1e-6)
  }
}

export interface ChartResult extends Draft {
  /** where each garment vertex was in the photo, as texture coordinates over the crop */
  photoUV: (g: Garment, crop: Crop) => Float32Array
  /** the garment hangs from an elastic top edge (strapless, off-shoulder) or a waistband */
  elastic: boolean
}

export function chartDraft(f: BodyFrame, g: GarmentRead, s: Structure, joints?: Joints): ChartResult {
  const ys = levelHeights(f)
  const sh = f.J['upperarm01.L']
  const hps = f.neckY - 0.004
  const kneeY = 0.55 * f.hipY

  // ---- height: photo y → model y, through the wearer's joints
  const avgY = (p: [Mark, Mark]) => (p[0][1] + p[1][1]) / 2
  const pairs: [number, number][] = []
  if (joints) {
    pairs.push([avgY(joints.shoulder), sh[1]], [avgY(joints.hip), f.hipY])
    if (joints.seen.knee > 0.5) pairs.push([avgY(joints.knee), kneeY])
    if (joints.seen.ankle > 0.5) pairs.push([avgY(joints.ankle), 0.085])
  }
  // metres per photo unit (photo heights; x is scaled by the aspect): from the wearer's shoulders, or on a
  // flat-lay from the garment's own shoulders, matched to the model's
  const lm = g.landmarks ?? {}
  const flat = pairs.length < 2
  const span = (a?: Mark, b?: Mark) => (a && b ? Math.hypot((b[0] - a[0]) * s.aspect, b[1] - a[1]) : 0)
  const garmentShoulders = span(lm.shoulderL, lm.shoulderR) || span(s.topLine[0], s.topLine[s.topLine.length - 1])
  const scale = joints && !flat ? 2 * Math.abs(sh[0]) / (span(joints.shoulder[0], joints.shoulder[1]) || 1)
    : 2 * (Math.abs(sh[0]) + 0.01) / (garmentShoulders || 0.3)
  if (flat) {
    // a flat-lay or hanger: the garment keeps its own proportions, its neck at the model's neck. (Placed by
    // Claude's level labels, a top came out cropped well above where it really ends.)
    const neckPy = lm.neck?.[1] ?? Math.min(...s.topLine.map((p) => p[1]))
    pairs.length = 0
    pairs.push([neckPy, hps], [neckPy + 1, hps - scale])
  }
  const toY = piecewise(pairs)
  const fromY = piecewise(pairs.map(([a, b]) => [b, a] as [number, number]))

  // ---- across: the body's and the garment's edges at each photo height
  const rows = s.rows
  const interp = (py: number, get: (r: (typeof rows)[number]) => number | undefined) => {
    const pts = rows.flatMap((r) => { const v = get(r); return v === undefined ? [] : [[r.y, v] as [number, number]] })
    if (!pts.length) return undefined
    if (pts.length === 1) return pts[0][1]
    if (py <= pts[0][0]) return pts[0][1]
    if (py >= pts[pts.length - 1][0]) return pts[pts.length - 1][1]
    const k = pts.findIndex((q) => q[0] > py)
    return lerp(pts[k - 1][1], pts[k][1], (py - pts[k - 1][0]) / (pts[k][0] - pts[k - 1][0] || 1e-6))
  }
  const bodyC = (py: number) => interp(py, (r) => (r.body[0] + r.body[1]) / 2)!
  const bodyH = (py: number) => interp(py, (r) => (r.body[1] - r.body[0]) / 2)!
  const ratio = (py: number) => interp(py, (r) => (r.garment ? (r.garment[1] - r.garment[0]) / (r.body[1] - r.body[0]) : undefined)) ?? 1
  const garC = (py: number) => interp(py, (r) => (r.garment ? (r.garment[0] + r.garment[1]) / 2 : undefined)) ?? bodyC(py)
  const garH = (py: number) => bodyH(py) * ratio(py)
  // ease at each model height: how far the garment stood off the body there (tight is stretched on, see custom.ts)
  // A flat-lay shows half the garment's girth as its width, so its half-width is the arc from front centre to
  // side seam (Q) itself. A worn photo shows the garment's width against the body's.
  const k = g.adjust.easeScale ?? 1
  const ease = (Y: number) => {
    const t = f.torso(Y)
    const e = flat ? (4 * garH(fromY(Y)) * s.aspect * scale / Math.PI - t.a - t.b) / 2 : (ratio(fromY(Y)) - 1) * t.a
    return clamp(e * k, 0.002, 0.2)
  }
  const Q = (Y: number) => f.quarter(Y, ease(Y))
  /** a photo point in pattern coordinates (before the hem offset) */
  const toPanel = (p: Mark): P2 => {
    const Y = toY(p[1])
    return [clamp((p[0] - garC(p[1])) / garH(p[1]), -1.3, 1.3) * Q(Y), Y]
  }

  // ---- the front's outline, in model heights first
  let hem = s.hemLine.map(toPanel)
  if (g.adjust.hem !== undefined) {
    // moved as a whole: an asymmetric hem keeps its slant
    const dy = at(ys, g.adjust.hem) - Math.min(...hem.map((p) => p[1]))
    hem = hem.map(([x, y]) => [x, y + dy])
  }
  const top = s.topLine.map(toPanel)
  const garmentRows = rows.filter((r) => r.garment)
  const sideTop = toY(garmentRows[0].y)
  // the side seams end at the underarm: at the arm crease for straps and sleeves, lower under an
  // off-shoulder or strapless top edge
  const under = { L: 0, R: 0 }
  const mode = { L: s.top.L, R: s.top.R } // L/R: image sides (L = the body's right, front −x)
  for (const k of ['L', 'R'] as const) {
    const end = k === 'L' ? top[0] : top[top.length - 1]
    under[k] = mode[k] === 'shoulder' ? clamp(sideTop, sh[1] - 0.12, sh[1] - 0.07) : Math.min(clamp(sideTop, sh[1] - 0.16, sh[1] - 0.08), end[1] - 0.04)
  }
  const hemL = hem[0][1], hemR = hem[hem.length - 1][1]
  const n = Math.max(3, Math.ceil(Math.max(under.L - hemL, under.R - hemR) / 0.07))
  const sideYs = (lo: number, hi: number) => Array.from({ length: n + 1 }, (_, i) => lo + (hi - lo) * i / n)
  const ysL = sideYs(hemL, under.L), ysR = sideYs(hemR, under.R)
  const base = Math.min(...hem.map((p) => p[1]), hemL, hemR) - 0.001

  // shoulders: the model's own neck point and shoulder tip where the garment goes over them
  const sleeves = { L: s.sleeves.L, R: s.sleeves.R }
  const nw = f.neckHalfWidth + 0.012
  const tipY = hps - 0.045
  const tipX = (k: 'L' | 'R') => sleeves[k] ? f.arcTo(tipY, Math.abs(sh[0]) + 0.01, ease(tipY)) : 0
  const neckPoint = (k: 'L' | 'R', end: P2): P2 => {
    const tip = sleeves[k] ? tipX(k) : Math.abs(end[0]) + 0.05
    return [Math.sign(k === 'L' ? -1 : 1) * clamp(Math.abs(end[0]), nw, tip - 0.03), Math.min(end[1], hps)]
  }
  const strapTip = (k: 'L' | 'R', neck: P2): P2 => [Math.sign(neck[0]) * (sleeves[k] ? tipX(k) : Math.abs(neck[0]) + 0.045), tipY]

  // hem: the photo's hem between the side corners, with each slit cut up into it as a notch
  const hemPath: P2[] = hem.slice(1, -1).map(([x, y]) => [clamp(x, -Q(y) + 0.005, Q(y) - 0.005), y])
  const hemAt = (x: number) => {
    const pts = hem.slice().sort((a, b) => a[0] - b[0])
    const k = pts.findIndex((p) => p[0] > x)
    if (k <= 0) return pts[k < 0 ? pts.length - 1 : 0][1]
    return lerp(pts[k - 1][1], pts[k][1], (x - pts[k - 1][0]) / (pts[k][0] - pts[k - 1][0] || 1e-6))
  }
  for (const slit of s.slits.filter((q) => q.confidence >= 0.5)) {
    const shift = hem[0][1] - toPanel(s.hemLine[0])[1]
    const h0 = toPanel(slit.hem), t0 = toPanel(slit.top)
    const h: P2 = [h0[0], h0[1] + shift], t: P2 = [t0[0], t0[1] + shift]
    const x = clamp(h[0], -Q(h[1]) + 0.03, Q(h[1]) - 0.03)
    const y0 = hemAt(x)
    hemPath.push([x - 0.008, y0], [clamp(t[0], x - 0.05, x + 0.05), Math.max(y0 + 0.03, t[1])], [x + 0.008, y0])
  }
  // keep the notch's three points together while sorting the hem left to right
  hemPath.sort((a, b) => a[0] - b[0] || a[1] - b[1])

  type Edge = 'hem' | 'side+' | 'side-' | 'arm+' | 'arm-' | 'shoulder+' | 'shoulder-' | 'neck'
  const corners: P2[] = [], tags: Edge[] = [], paths: Record<number, P2[]> = {}
  const add = (p: P2, tag: Edge, path?: P2[]) => {
    if (path?.length) paths[corners.length] = path.map(([x, y]) => [x, y - base])
    corners.push([p[0], p[1] - base]); tags.push(tag)
  }
  // body left is the image's right (front +x); drawn counter-clockwise from outside
  const front = (() => {
    corners.length = 0; tags.length = 0
    for (const k in paths) delete paths[+k]
    add([-Q(ysL[0]), ysL[0]], 'hem', hemPath)
    for (let i = 0; i < n; i++) add([Q(ysR[i]), ysR[i]], 'side+')
    const endR = top[top.length - 1], endL = top[0]
    const topInner = top.slice(1, -1).map(([x, y]): P2 => [x, Math.min(y, hps)]).reverse()
    if (mode.R === 'shoulder') {
      const neck = neckPoint('R', endR)
      add([Q(ysR[n]), ysR[n]], 'arm+')
      add(strapTip('R', neck), 'shoulder+')
      add(neck, 'neck', topInner)
    } else {
      add([Q(ysR[n]), ysR[n]], 'arm+')
      add([Math.min(endR[0], Q(endR[1]) + 0.04), endR[1]], 'neck', topInner)
    }
    if (mode.L === 'shoulder') {
      const neck = neckPoint('L', endL)
      add(neck, 'shoulder-')
      add(strapTip('L', neck), 'arm-')
    } else add([Math.max(endL[0], -Q(endL[1]) - 0.04), endL[1]], 'arm-')
    for (let i = n; i >= 1; i--) add([-Q(ysL[i]), ysL[i]], 'side-')
    return { outline: corners.slice(), tags: tags.slice(), paths: { ...paths } }
  })()

  // ---- the back: inferred, sharing the side seams. Drawn from behind, so its +x is the body's right
  // (the front's −x, image left), and its hem runs straight between the side corners.
  const back = (() => {
    corners.length = 0; tags.length = 0
    for (const k in paths) delete paths[+k]
    const slitTop = s.back.slitTop !== undefined ? at(ys, s.back.slitTop) : undefined
    const hemB: P2[] = slitTop !== undefined
      ? [[-0.008, lerp(ysR[0], ysL[0], 0.5)], [0, Math.max(lerp(ysR[0], ysL[0], 0.5) + 0.03, slitTop)], [0.008, lerp(ysR[0], ysL[0], 0.5)]] : []
    add([-Q(ysR[0]), ysR[0]], 'hem', hemB)
    for (let i = 0; i < n; i++) add([Q(ysL[i]), ysL[i]], 'side+')
    const endBodyRight = top[0], endBodyLeft = top[top.length - 1]
    const depth = clamp(hps - at(ys, Math.max(s.back.neckDepth, 1)), 0.015, 0.6)
    const neckDip = (y: number) => Math.min(y, hps - depth)
    if (mode.L === 'shoulder') {
      const neck = neckPoint('L', endBodyRight), x = Math.abs(neck[0])
      add([Q(ysL[n]), ysL[n]], 'arm+')
      add([Math.abs(strapTip('L', neck)[0]), tipY], 'shoulder+')
      add([x, hps + 0.01], 'neck', [[0, neckDip(hps)]])
    } else {
      add([Q(ysL[n]), ysL[n]], 'arm+')
      add([Math.min(-endBodyRight[0], Q(endBodyRight[1]) + 0.04), endBodyRight[1]], 'neck', [[0, neckDip(Math.min(endBodyRight[1], endBodyLeft[1]))]])
    }
    if (mode.R === 'shoulder') {
      const neck = neckPoint('R', endBodyLeft), x = Math.abs(neck[0])
      add([-x, hps + 0.01], 'shoulder-')
      add([-Math.abs(strapTip('R', neck)[0]), tipY], 'arm-')
    } else add([Math.max(-endBodyLeft[0], -Q(endBodyLeft[1]) - 0.04), endBodyLeft[1]], 'arm-')
    for (let i = n; i >= 1; i--) add([-Q(ysR[i]), ysR[i]], 'side-')
    return { outline: corners.slice(), tags: tags.slice(), paths: { ...paths } }
  })()

  // ---- openings: holes in the front (only those Claude is fairly sure are intentional), and an open back
  const inside = (Y: number, lo: number, hi: number) => Y > lo + 0.02 && Y < hi - 0.02
  const frontHoles = s.openings.filter((o) => o.confidence >= 0.5).map((o) => o.points.map(toPanel)
    .map(([x, y]): P2 => [clamp(x, -Q(y) + 0.015, Q(y) - 0.015), y - base]))
    .filter((h) => h.every(([, y]) => inside(y + base, base, Math.max(under.L, under.R) + 0.1)))
  const backHoles: P2[][] = []
  if (s.back.openBack) {
    const yTop = at(ys, s.back.openBack.top), yBot = at(ys, s.back.openBack.bottom)
    if (yTop - yBot > 0.04) {
      const ring: P2[] = []
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * 2 * Math.PI, y = lerp(yBot, yTop, 0.5 + 0.5 * Math.sin(a))
        ring.push([Math.cos(a) * s.back.openBack.width * Q(y) * 0.85, y - base])
      }
      backHoles.push(ring)
    }
  }

  const place = (isBack: boolean) => (x: number, y: number) => f.aroundTorso(x, base + y, isBack, ease(base + y))
  const pieces: Piece[] = [
    { name: 'front', outline: front.outline, paths: front.paths, holes: frontHoles, place: place(false), passThrough: true, anchor: TORSO, noTurn: true },
    { name: 'back', outline: back.outline, paths: back.paths, holes: backHoles, place: place(true), passThrough: true, anchor: TORSO, noTurn: true },
  ]
  const edges = (o: { tags: Edge[] }, tag: Edge) => o.tags.flatMap((t, i) => (t === tag ? [i] : []))
  const chain = (name: string, list: number[]) => list.map((e) => [name, e] as [string, number])
  // body left: front +x, back −x; body right: front −x, back +x
  const seams: Seam[] = [
    { a: chain('front', edges(front, 'side+')), b: chain('back', edges(back, 'side-')) },
    { a: chain('front', edges(front, 'side-')), b: chain('back', edges(back, 'side+')) },
  ]
  if (mode.R === 'shoulder') seams.push({ a: chain('front', edges(front, 'shoulder+')), b: chain('back', edges(back, 'shoulder-')) })
  if (mode.L === 'shoulder') seams.push({ a: chain('front', edges(front, 'shoulder-')), b: chain('back', edges(back, 'shoulder+')) })
  const band: [string, number][] = []
  const elastic = mode.L === 'under_arm' || mode.R === 'under_arm' || s.hold !== 'shoulders'
  if (elastic || s.hold === 'shoulders') band.push(['front', edges(front, 'neck')[0]], ['back', edges(back, 'neck')[0]])

  // ---- sleeves, per side: set in under a shoulder, or off the shoulder carrying the neckline
  const armReach = (k: 'L' | 'R') => {
    if (g.adjust.sleeveAt !== undefined) return armLength(f, Math.max(0.1, g.adjust.sleeveAt))
    const end = sleeves[k]!.end
    if (flat) {
      // a flat-lay: the sleeve as long, shoulder to hem, as the photo shows it
      const shoulder = k === 'L' ? lm.shoulderL ?? s.topLine[0] : lm.shoulderR ?? s.topLine[s.topLine.length - 1]
      return clamp(span(shoulder, end) * scale, 0.05, armLength(f, 2.3))
    }
    if (joints) {
      const i = k === 'L' ? 0 : 1
      const S = joints.shoulder[i], E = joints.elbow[i], W = joints.wrist[i]
      const proj = (a: Mark, b: Mark) => {
        const d = [b[0] - a[0], b[1] - a[1]], l2 = d[0] ** 2 + d[1] ** 2 || 1
        const t = ((end[0] - a[0]) * d[0] + (end[1] - a[1]) * d[1]) / l2
        return { t, dist: Math.hypot(end[0] - a[0] - d[0] * t, end[1] - a[1] - d[1] * t) }
      }
      const u = proj(S, E), l = proj(E, W)
      const t = u.t <= 1 && (u.dist <= l.dist || l.t < 0) ? u.t : 1 + l.t
      return armLength(f, clamp(t, 0.1, 2.3))
    }
    return armLength(f, Math.max(0.1, g.sleeveAt))
  }
  for (const k of ['L', 'R'] as const) {
    const sv = sleeves[k]
    if (!sv) continue
    // image L is the body's right: sleeveR, sewn to the front's −x and the back's +x armholes
    const name = k === 'L' ? 'sleeveR' : 'sleeveL'
    const frontArm = edges(front, k === 'L' ? 'arm-' : 'arm+')[0], backArm = edges(back, k === 'L' ? 'arm+' : 'arm-')[0]
    const fitted = sv.width === 'fitted'
    if (mode[k] === 'shoulder') {
      const fo = front.outline, j = frontArm
      const armhole = Math.hypot(fo[j + 1][0] - fo[j][0], fo[j + 1][1] - fo[j][1]) * 1.04, capH = 0.075
      const half = Math.sqrt(Math.max(armhole ** 2 - capH ** 2, 0.004)) * (fitted ? 0.9 : sv.width === 'loose' ? 1.1 : 1)
      const length = armReach(k)
      const toCuff = clamp((length - 0.2) / (armLength(f, 2) - 0.2), 0, 1)
      const cuff = Math.PI * (f.wristR + (fitted ? 0.007 : 0.018))
      // the hem opening as wide as the photo shows it (a bell sleeve), else narrowing towards the wrist.
      // Flat, the photo shows half its girth; worn, about its diameter.
      const d = sv.hemWidth !== undefined ? sv.hemWidth * s.aspect * scale : undefined
      const traced = d === undefined ? undefined : clamp(flat ? d : Math.PI * d / 2, Math.PI * (f.wristR + 0.005), 0.45)
      const hemHalf = traced ?? half * 0.94 + (Math.min(half, cuff) - half * 0.94) * toCuff
      const piece = sleevePair(f, { top: 0.02, length, capH, half: Math.max(half, traced ? Math.min(traced, half * 1.2) : 0), hemHalf, clear: fitted ? 0.004 : 0.01 })
        .find((p) => p.name === name)!
      piece.spacing = 0.02
      pieces.push(piece)
      seams.push({ a: [[name, 1]], b: [[name, 4]] })
      seams.push(name === 'sleeveL'
        ? { a: [[name, 2], [name, 3]], b: [['back', backArm, true], ['front', frontArm, true]] }
        : { a: [[name, 2], [name, 3]], b: [['front', frontArm, true], ['back', backArm, true]] })
    } else {
      const endY = (k === 'L' ? top[0] : top[top.length - 1])[1]
      const os = offShoulderSleeves(f, { topY: endY, underY: under[k], reach: armReach(k), tight: fitted })
      const piece = os.pieces.find((p) => p.name === name)!
      piece.spacing = 0.02
      pieces.push(piece)
      seams.push({ a: [[name, 1]], b: [[name, 5]] })
      seams.push({ a: [[name, os.capFront ? 2 : 4]], b: [['front', frontArm]] }, { a: [[name, os.capFront ? 4 : 2]], b: [['back', backArm]] })
      band.push([name, 3])
    }
    if (armReach(k) > armLength(f, 1.6)) band.push([name, 0])
  }

  // ---- the print: every panel vertex back to the photo point it came from
  const photoUV = (gm: Garment, crop: Crop) => {
    const uv = new Float32Array(gm.src.length * 2)
    const toUV = (px: number, py: number, v: number) => {
      uv[v * 2] = (px * crop.W - crop.x0) / crop.w
      uv[v * 2 + 1] = 1 - (py * crop.H - crop.y0) / crop.h
    }
    for (let v = 0; v < gm.src.length; v++) {
      if (gm.noTurn?.[v]) {
        // pattern coordinates (gm.uv holds them, unstretched): across and up the panel
        const x = gm.uv[v * 2], Y = gm.uv[v * 2 + 1] + base
        const py = fromY(Y)
        toUV(garC(py) + (x / Q(Y)) * garH(py), py, v)
      } else {
        // a sleeve: down the arm from the photo's shoulder to its sleeve end
        const p = gm.rest, side = p[v * 3] >= 0 ? 'R' : 'L', sv = sleeves[side]
        const sPhoto: Mark = joints ? joints.shoulder[side === 'L' ? 0 : 1] : [garC(fromY(sh[1])) + (side === 'L' ? -1 : 1) * garH(fromY(sh[1])), fromY(sh[1])]
        const ePhoto = sv?.end ?? sPhoto
        const s3: P2 = [Math.sign(p[v * 3]) * Math.abs(sh[0]), sh[1]]
        const reach = sv ? armReach(side) : 0.2
        const wr = f.J['wrist.L'], len = Math.hypot(wr[0] - sh[0], wr[1] - sh[1]) || 1
        const e3: P2 = [s3[0] + Math.sign(p[v * 3]) * Math.abs(wr[0] - sh[0]) / len * reach, s3[1] + (wr[1] - sh[1]) / len * reach]
        // the similarity taking the model's shoulder→sleeve end onto the photo's
        const d3: P2 = [e3[0] - s3[0], -(e3[1] - s3[1])], dp: P2 = [(ePhoto[0] - sPhoto[0]) * crop.W, (ePhoto[1] - sPhoto[1]) * crop.H]
        const q: P2 = [p[v * 3] - s3[0], -(p[v * 3 + 1] - s3[1])]
        const den = d3[0] ** 2 + d3[1] ** 2 || 1
        const re = (q[0] * d3[0] + q[1] * d3[1]) / den, im = (q[1] * d3[0] - q[0] * d3[1]) / den
        const px = sPhoto[0] * crop.W + re * dp[0] - im * dp[1], py = sPhoto[1] * crop.H + re * dp[1] + im * dp[0]
        uv[v * 2] = (px - crop.x0) / crop.w
        uv[v * 2 + 1] = 1 - (py - crop.y0) / crop.h
      }
    }
    return uv
  }

  return { pieces, seams, band, photoUV, elastic }
}

