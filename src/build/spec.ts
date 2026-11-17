// A pattern described as data instead of code (docs/pattern-spec.md): pieces drawn in body coordinates,
// which this turns into the same Piece objects the pattern library makes. Nothing in a spec is run.
import type { Vec3 } from '../body/bodySet'
import type { Fabric } from '../cloth/garmentSpec'
import type { Piece, Seam } from '../pattern/assemble'
import { ARM, LOWER, TORSO, mirror } from '../pattern/drafts'
import type { P2 } from '../pattern/mesh2d'
import type { Kit, Print, ProgramGarment } from './kit'

export interface SpecPiece {
  name: string
  /** torso pieces wrap the body front or back; arm and leg pieces are tubes round one limb */
  on: 'front' | 'back' | 'armL' | 'armR' | 'legL' | 'legR'
  /** corners [u, h], counter-clockwise seen from outside. Torso: u −1..1 from side seam to side seam
   *  (front: +1 the body's left; back, drawn from behind: +1 the body's right), h a body level position.
   *  Arm: u −1..1 round the arm (±1 the underarm seam), h down the arm (0 shoulder, 1 elbow, 2 wrist).
   *  Leg: u −1..1 round the leg (0 its front, ±1 the back seam), h a body level position. */
  outline: [number, number][]
  /** cloth off the body (m): one value, or [h, ease] pairs down the piece */
  ease?: number | [number, number][]
  /** openings inside the piece, in the same [u, h] coordinates */
  holes?: [number, number][][]
}

export interface SpecGarment {
  name: string
  layer: number
  kind: ProgramGarment['kind']
  fabric: Fabric
  color: string
  color2?: string
  print?: Print
  fit?: ProgramGarment['fit']
  hold?: ProgramGarment['hold']
  pieces: SpecPiece[]
  seams: { a: [string, number][]; b: [string, number][] }[]
  band?: [string, number][]
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const norm = (a: Vec3): Vec3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

export function specToProgram(k: Kit, spec: { garments: SpecGarment[] }): ProgramGarment[] {
  const { f } = k
  return spec.garments.map((g) => ({
    name: g.name, layer: g.layer, kind: g.kind, fabric: g.fabric, color: g.color, color2: g.color2, print: g.print, fit: g.fit, hold: g.hold,
    pieces: g.pieces.map((p) => piece(k, f, p)),
    seams: g.seams as Seam[],
    band: g.band,
  }))
}

function easeOf(e: SpecPiece['ease'], h: number) {
  if (e === undefined) return 0.012
  if (typeof e === 'number') return e
  const pts = e.slice().sort((a, b) => a[0] - b[0])
  if (!pts.length) return 0.012
  if (h <= pts[0][0]) return pts[0][1]
  if (h >= pts[pts.length - 1][0]) return pts[pts.length - 1][1]
  const i = pts.findIndex((q) => q[0] > h)
  const [h0, e0] = pts[i - 1], [h1, e1] = pts[i]
  return e0 + (e1 - e0) * (h - h0) / (h1 - h0 || 1)
}

function piece(k: Kit, f: Kit['f'], p: SpecPiece): Piece {
  const ease = (h: number) => Math.max(0.001, easeOf(p.ease, h))
  if (p.on === 'front' || p.on === 'back') {
    const isBack = p.on === 'back'
    // h down the body → height; inverse by bisection (heights fall as h grows)
    const Y = (h: number) => k.level(h)
    const hOf = (y: number) => { let lo = 0, hi = 13; for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (Y(m) > y) lo = m; else hi = m } return (lo + hi) / 2 }
    const Q = (h: number) => f.quarter(Y(h), ease(h))
    const base = Math.min(...p.outline.map(([, h]) => Y(h)))
    const flat = ([u, h]: [number, number]): P2 => [u * Q(h), Y(h) - base]
    return {
      name: p.name, outline: p.outline.map(flat), holes: p.holes?.map((r) => r.map(flat)),
      place: (x, y) => f.aroundTorso(x, base + y, isBack, ease(hOf(base + y))),
      passThrough: true, anchor: TORSO, noTurn: true,
    }
  }
  if (p.on === 'armL' || p.on === 'armR') {
    const sh = f.J['upperarm01.L'], el = f.J['lowerarm01.L'], wr = f.J['wrist.L']
    const l1 = Math.hypot(...sub(el, sh)), l2 = Math.hypot(...sub(wr, el))
    const along = (h: number) => (h <= 1 ? h * l1 : l1 + (h - 1) * l2)
    const hOf = (a: number) => (a <= l1 ? a / l1 : 1 + (a - l1) / l2)
    const radius = (h: number) => f.armR + (f.wristR - f.armR) * Math.min(1, Math.max(0, h / 2)) + ease(h)
    const bottom = Math.max(...p.outline.map(([, h]) => h))
    // y up the piece from its lowest point down the arm
    const flat = ([u, h]: [number, number]): P2 => [u * Math.PI * radius(h), along(bottom) - along(h)]
    const frame = (a: Vec3, b: Vec3) => { const d = norm(sub(b, a)); const up = norm(sub([0, 1, 0], [d[0] * d[1], d[1] * d[1], d[2] * d[1]])); return { d, o: up, w: cross(up, d) } }
    const upper = frame(sh, el), lower = frame(el, wr)
    const placeL = (x: number, y: number): Vec3 => {
      const a = along(bottom) - y, h = hOf(a), R = radius(h), t = x / R
      const fr = h <= 1 ? upper : lower, origin = h <= 1 ? sh : el, s = h <= 1 ? a : a - l1
      return [0, 1, 2].map((i) => origin[i] + fr.d[i] * s + fr.o[i] * R * Math.cos(t) + fr.w[i] * R * Math.sin(t)) as Vec3
    }
    const outline = p.outline.map(flat), holes = p.holes?.map((r) => r.map(flat))
    if (p.on === 'armL') return { name: p.name, outline, holes, place: placeL, anchor: ARM }
    // the right arm is the left one mirrored, outline and all, so its faces still point outwards
    const [out] = mirror(outline, outline.map(() => 0))
    return { name: p.name, outline: out, holes: holes?.map((r) => r.map(([x, y]) => [-x, y] as P2)), place: (x, y) => { const q = placeL(-x, y); return [-q[0], q[1], q[2]] }, anchor: ARM }
  }
  // legs: a tube round one leg, by its own cross-section at each height
  const Y = (h: number) => k.level(h)
  const hOf = (y: number) => { let lo = 0, hi = 13; for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (Y(m) > y) lo = m; else hi = m } return (lo + hi) / 2 }
  const base = Math.min(...p.outline.map(([, h]) => Y(h)))
  const flat = ([u, h]: [number, number]): P2 => [u * Math.PI * (f.leg(Y(h)).r + ease(h)), Y(h) - base]
  const placeL = (x: number, y: number): Vec3 => {
    const wy = base + y, s = f.leg(wy), R = s.r + ease(hOf(wy)), t = x / R
    return [s.cx + R * Math.sin(t), wy, s.cz + R * Math.cos(t)]
  }
  const outline = p.outline.map(flat), holes = p.holes?.map((r) => r.map(flat))
  if (p.on === 'legL') return { name: p.name, outline, holes, place: placeL, anchor: LOWER }
  const [out] = mirror(outline, outline.map(() => 0))
  return { name: p.name, outline: out, holes: holes?.map((r) => r.map(([x, y]) => [-x, y] as P2)), place: (x, y) => { const q = placeL(-x, y); return [-q[0], q[1], q[2]] }, anchor: LOWER }
}
