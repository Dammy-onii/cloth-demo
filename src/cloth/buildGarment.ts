// Cut a garment out of the mannequin's own surface, then inflate it into cloth.
//
// Using the body's topology means a top or a pair of trousers starts as a perfectly-fitting shell
// with sleeves, shoulders and legs already in the right place; ease + gravity + collision in the
// XPBD solver then make it hang like fabric. Skirts and gowns add an A-line tube extruded from the
// cut's lowest edge. Each garment vertex remembers the body vertex it sits over (`src`) so the
// cloth can be carried along when the body changes size or pose.

import type { BodySet, Size, Vec3 } from '../body/bodySet'
import { boundaryLoops, largestComponent, vertexAdjacency, vertexNormals, walkToNearest } from '../math/mesh'
import { FIT_EASE, SLEEVE_T, type BottomSpec, type GarmentSpec } from './garmentSpec'

export interface Garment {
  rest: Float32Array
  index: Uint32Array
  /** Indices [0, frontCount) are front-facing triangles, the rest are the back */
  frontCount: number
  uv: Float32Array
  src: Uint32Array
  /** Skin-to-cloth clearance (m) at each body vertex it was cut from, 0 elsewhere: what a garment
   *  layered over this one has to clear */
  covers: Float32Array
  /** Extra skin clearance per body vertex (a garment underneath), if layered */
  lift?: Float32Array
  /** Body vertices the cloth passes through instead of colliding with */
  ignore?: Uint8Array
  /** if set, only these garment vertices pass through `ignore` (a shirt's body panels, not its sleeves) */
  ignoreOnly?: Uint8Array
  /** garment vertices carried along by translation only on body changes (loose torso panels) */
  noTurn?: Uint8Array
  /** Garment vertices of an elastic band (a waistband): edges between them rest shorter */
  band?: Uint8Array
  /** how hard band vertices are held at their skin height, per substep (default BAND_TETHER) */
  bandTether?: number
  /** Distance of each vertex from the neckline, for a contrast trim along it */
  trimDistance?: Float32Array
  /** Pattern garments: each vertex's flat pattern position (rest lengths come from the flat fabric)… */
  flat?: Float32Array
  /** …and the seams: pairs of vertices sewn together */
  seams?: Uint32Array
  /** an uploaded photo projected from the front, on a pattern garment whose own UVs stay in
   *  metres for the weave (drawn from the second UV set) */
  photoUV?: Float32Array
  /** collision friction (default FRICTION in xpbd.ts): fitted garments grip the skin, or a tight tube
   *  slid up the hips to the waist and piled there */
  friction?: number
  /** per vertex, how hard it is held at the height of the skin it was placed over, each substep: static
   *  friction for fitted cloth, which otherwise slid down to the waist and piled there */
  grip?: Float32Array
}

/** How the texture maps: a garment photo projected from the front, or a fabric swatch tiled in metres. */
export type UVMode = { kind: 'photo'; torso?: [number, number] } | { kind: 'tiled' }

const THICKNESS = 0.004
// Enough smoothing passes for the fabric to bridge fully under the bust and across the spine.
const SHRINK_WRAP_ITERATIONS = 200
const FLOOR_CLEARANCE = 0.03
// strapless edge below the shoulder joint (m)
const STRAPLESS_BELOW_SHOULDER = 0.045
// sideways reach of the neckline cut from the neck's axis (m)
const NECKLINE_RADIUS = 0.075
// Hem height as a fraction of the hip-joint → neck span, how far the hem hangs past the cut (m, or
// down to the floor), and the flare as a fraction of that drop; `power` 2 eases a hem out gently,
// 1 is a straight A-line. `seam` makes the cut's edge a waist seam that holds the skirt up.
type Hem = { at: number; drop: number | 'floor'; flare: number; power: number; seam?: boolean; pleats?: Pleats }
/** Radial folds built into an extruded skirt: `count` round the hem, `depth` (m) at the floor */
type Pleats = { count: number; depth: number }
const HEM: Record<GarmentSpec['length'], Hem> = {
  cropped: { at: 0.4, drop: 0, flare: 0, power: 2 },
  waist: { at: 0.27, drop: 0.01, flare: 0.05, power: 2 },
  hip: { at: 0.02, drop: 0.05, flare: 0.08, power: 2 },
  tunic: { at: 0.02, drop: 0.2, flare: 0.18, power: 2 },
  // uploaded dresses are pattern garments (src/pattern/custom.ts); these only keep the extruded
  // cut working if one is ever asked for
  mini: { at: 0.3, drop: 0.3, flare: 0.25, power: 1.5, seam: true },
  knee: { at: 0.3, drop: 0.45, flare: 0.3, power: 1.5, seam: true },
  midi: { at: 0.3, drop: 0.65, flare: 0.35, power: 1.2, seam: true },
  // a gown: bodice fitted to the natural waist, then a full skirt to the floor whose extra width is
  // built in as pleats, so it drapes in folds like a gathered ball skirt rather than a smooth cone
  floor: { at: 0.3, drop: 'floor', flare: 0.5, power: 0.85, seam: true, pleats: { count: 16, depth: 0.06 } },
}
// Bottoms: waistband height (fraction of hip-joint → neck: the natural waist, narrowest girth; lower,
// on the female lower belly, the skin faces down and pushed the band off), leg hems as a fraction
// of hip-joint height above the floor, and the skirt: yoke down to the hip joint, then an A-line
// to the knee.
// The waistband is snug: ease grows from none at the waistband to the fit's full ease WAIST_EASE_DROP
// below it (with full ease all round, the waistband was ~18 cm bigger than the hips and slid off).
const WAIST_AT = 0.3
const WAIST_EASE_DROP = 0.12
const LEG_HEM = { trousers: 0.1, shorts: 0.6 }
const SKIRT = { hem: 0.5, flare: 0.3 }

export function buildTop(body: BodySet, size: Size, spec: GarmentSpec, uvMode: UVMode, lift?: Float32Array): Garment {
  const pos = body.positions(size, 'apose')
  const J = body.joints(size, 'apose')
  const seg = segments(body)
  const neck = J['neck01']
  const neckY = neck[1]
  const hipY = hipHeight(J)
  const hem = HEM[spec.length]
  const hemY = hipY + hem.at * (neckY - hipY)
  const sleeveT = SLEEVE_T[spec.sleeve]
  // sleeveless armhole: the torso outboard of the shoulder joint's inside edge, down past the armpit
  // (only just past it for a fitted top: a tight tank hugs the side of the bust)
  const shoulder = J['upperarm01.L']
  const armholeX = Math.abs(shoulder[0]) - 0.025
  const armholeY = shoulder[1] - (spec.fit === 'tight' ? 0.09 : 0.13)
  // strapless: a sweetheart edge just above the bust, dipping between the breasts at the front
  const strapless = spec.neckline === 'strapless'
  const topEdge = (x: number, front: boolean) =>
    shoulder[1] - STRAPLESS_BELOW_SHOULDER - (front ? 0.035 * smoothstep(1 - Math.abs(x) / 0.06) : 0.01)

  const armT = (v: number, side: 'L' | 'R') => {
    const s = J[`upperarm01.${side}`], w = J[`wrist.${side}`]
    const a: Vec3 = [w[0] - s[0], w[1] - s[1], w[2] - s[2]]
    const d = (pos[v * 3] - s[0]) * a[0] + (pos[v * 3 + 1] - s[1]) * a[1] + (pos[v * 3 + 2] - s[2]) * a[2]
    return d / (a[0] ** 2 + a[1] ** 2 + a[2] ** 2)
  }

  const necklineDrop = (x: number, front: boolean) => {
    if (!front) return 0.012
    switch (spec.neckline) {
      case 'v': return 0.02 + 0.13 * Math.max(0, 1 - Math.abs(x) / 0.1)
      case 'scoop': return 0.02 + 0.07 * Math.max(0, 1 - (x / 0.12) ** 2)
      case 'boat': return 0.006
      default: return 0.015
    }
  }

  const keep = new Uint8Array(body.vertexCount)
  for (let v = 0; v < body.vertexCount; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2]
    const label = body.labels[v]
    const side = x > 0 ? 'L' : 'R'
    // the base of the neck carries tank straps on narrow shoulders, so it counts as torso below the neckline
    if (label === seg.torso || label === seg.neck) {
      if (y < hemY) continue
      if (strapless) {
        if (y < topEdge(x, z > 0)) keep[v] = 1
        continue
      }
      // the neckline is cut across the neck's width only: female shoulder tops sit nearly at
      // neck-joint height (measured sideways, so a V or scoop still runs down the chest). Its depth
      // tapers out over the last 2 cm so the edge meets the shoulder without a step.
      const taper = smoothstep((NECKLINE_RADIUS - Math.abs(x - neck[0])) / 0.02)
      if (taper > 0 && y > neckY - taper * necklineDrop(x, z > 0)) continue
      if (sleeveT < 0 && Math.abs(x) > armholeX && y > armholeY) continue // sleeveless: open the armhole
      keep[v] = 1
    } else if (label === seg.upperarm || label === seg.forearm) {
      if (armT(v, side) <= sleeveT) keep[v] = 1
    }
  }
  const drop = hem.drop === 'floor' ? hemY - FLOOR_CLEARANCE : hem.drop
  const ease = THICKNESS + FIT_EASE[spec.fit]
  // a fitted top's hem hangs straight: flaring it left a tight tank loose at the bottom
  const flare = spec.fit === 'tight' && hem.drop !== 'floor' ? 0 : hem.flare * drop
  const g = finish(body, pos, keep, () => ease, { drop, flare, power: hem.power, seam: hem.seam, pleats: hem.pleats }, uvMode, lift)
  // a strapless top edge is held like a waistband (elastic + tethered to the skin)
  if (strapless) g.band = topBand(g, g.band)
  return spec.trimColor ? { ...g, trimDistance: trimDistance(g) } : g
}

export function buildBottom(body: BodySet, size: Size, spec: BottomSpec, lift?: Float32Array): Garment {
  const pos = body.positions(size, 'apose')
  const J = body.joints(size, 'apose')
  const seg = segments(body)
  const hipY = hipHeight(J)
  const waistY = hipY + WAIST_AT * (J['neck01'][1] - hipY)

  const keep = new Uint8Array(body.vertexCount)
  for (let v = 0; v < body.vertexCount; v++) {
    const y = pos[v * 3 + 1], label = body.labels[v]
    if (label === seg.torso) keep[v] = y < waistY && (spec.style !== 'skirt' || y > hipY) ? 1 : 0
    else if (spec.style === 'skirt') continue
    else if (label === seg.upperleg || (spec.style === 'trousers' && label === seg.lowerleg)) keep[v] = y > LEG_HEM[spec.style] * hipY ? 1 : 0
  }
  const drop = hipY - SKIRT.hem * hipY
  const skirt = spec.style === 'skirt' ? { drop, flare: SKIRT.flare * drop, power: 1 } : undefined
  const ease = (v: number) => THICKNESS + FIT_EASE[spec.fit] * smoothstep((waistY - pos[v * 3 + 1]) / WAIST_EASE_DROP)
  // Arms and hands pass through: hanging or resting on the hips they sit inside the ease, and
  // colliding with them pushed the waistband down and off.
  const arms = [seg.upperarm, seg.forearm, seg.hand]
  const g = finish(body, pos, keep, ease, skirt, { kind: 'tiled' }, lift)
  // The waistband is the highest opening. Made elastic, it grips the waist all round, so contact
  // friction holds it; loose, it stretched under the garment's weight and slid over the hips.
  return { ...g, ignore: body.labels.map((l) => (arms.includes(l) ? 1 : 0)), band: topBand(g) }
}

const smoothstep = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

function segments(body: BodySet) {
  return Object.fromEntries(body.segments.map((s, i) => [s, i])) as Record<string, number>
}

function hipHeight(J: Record<string, Vec3>) {
  return (J['upperleg01.L'][1] + J['upperleg01.R'][1]) / 2
}

/**
 * Shared tail: cut the kept faces out, inflate by `ease` (skin clearance per body vertex), extend a
 * hem tube, shrink-wrap, split and map.
 */
function finish(
  body: BodySet, pos: Float32Array, keep: Uint8Array, ease: (v: number) => number,
  hem: { drop: number; flare: number; power: number; seam?: boolean; pleats?: Pleats } | undefined, uvMode: UVMode, lift?: Float32Array,
): Garment {
  const normals = vertexNormals(pos, body.index)
  let faces: number[] = []
  const bi = body.index
  for (let f = 0; f < bi.length; f += 3) if (keep[bi[f]] && keep[bi[f + 1]] && keep[bi[f + 2]]) faces.push(bi[f], bi[f + 1], bi[f + 2])
  const cut = largestComponent(Uint32Array.from(faces))

  // Re-index to a compact garment mesh and inflate along the body normal.
  const remap = new Map<number, number>()
  const src: number[] = []
  const rest: number[] = []
  const covers = new Float32Array(body.vertexCount)
  const clearance = (v: number) => ease(v) + (lift?.[v] ?? 0)
  for (const v of cut) {
    if (remap.has(v)) continue
    remap.set(v, src.length)
    src.push(v)
    const d = clearance(v)
    covers[v] = d
    rest.push(pos[v * 3] + normals[v * 3] * d, pos[v * 3 + 1] + normals[v * 3 + 1] * d, pos[v * 3 + 2] + normals[v * 3 + 2] * d)
  }
  faces = Array.from(cut, (v) => remap.get(v)!)

  const tube = hem && hem.drop > 0 ? extendHem(rest, faces, src, hem.drop, hem.flare, hem.power, hem.pleats) : []
  const restArr = Float32Array.from(rest)
  // Shrink-wrapping slides vertices along the skin (up to ~9 cm near the neck), so it re-anchors
  // `src` to the skin point each now sits over, for carrying it with the body and for collisions.
  shrinkWrap(restArr, faces, src, pos, normals, vertexAdjacency(body.index, body.vertexCount), clearance, tube)
  const { index, frontCount } = splitFrontBack(restArr, faces)
  const uv = uvMode.kind === 'photo' ? planarUV(restArr, uvMode.torso) : tiledUV(restArr, index)
  // a waist seam is held like a waistband (elastic + tethered), so a long skirt can't drag the bodice down
  const band = hem?.seam && tube.length ? new Uint8Array(src.length) : undefined
  if (band) for (const t of tube) band[t.base] = 1
  return { rest: restArr, index, frontCount, uv, src: Uint32Array.from(src), covers, lift, band }
}

interface TubeVertex {
  v: number
  /** vertex of the cut's edge it was extruded from */
  base: number
  /** its offset from that vertex */
  dx: number
  dy: number
  dz: number
}

/**
 * Extrude the lowest boundary loop downward in rings (2 cm apart), flaring outward from the body
 * axis by `flare`·tᵖ at fraction t of the drop. Returns the extruded vertices with their offsets.
 */
function extendHem(rest: number[], faces: number[], src: number[], drop: number, flare: number, power: number, pleats?: Pleats): TubeVertex[] {
  const loops = boundaryLoops(faces)
  const meanY = (l: number[]) => l.reduce((s, v) => s + rest[v * 3 + 1], 0) / l.length
  const hem = loops.sort((a, b) => meanY(a) - meanY(b))[0]
  if (!hem) return []
  const cx = hem.reduce((s, v) => s + rest[v * 3], 0) / hem.length
  const cz = hem.reduce((s, v) => s + rest[v * 3 + 2], 0) / hem.length
  const rings = Math.max(1, Math.round(drop / 0.02))
  const tube: TubeVertex[] = []
  let prev = hem
  for (let r = 1; r <= rings; r++) {
    const t = r / rings
    const ring = hem.map((v) => {
      const dx = rest[v * 3] - cx, dz = rest[v * 3 + 2] - cz
      const len = Math.hypot(dx, dz) || 1
      // pleats: a radial wave round the hem, growing with the flare
      const wave = pleats ? pleats.depth * t ** power * Math.cos(pleats.count * Math.atan2(dz, dx)) : 0
      const out = flare * t ** power + wave
      const id = src.length
      src.push(src[v])
      const off = { dx: (dx / len) * out, dy: -drop * t, dz: (dz / len) * out }
      rest.push(rest[v * 3] + off.dx, rest[v * 3 + 1] + off.dy, rest[v * 3 + 2] + off.dz)
      tube.push({ v: id, base: v, ...off })
      return id
    })
    for (let i = 0; i < hem.length; i++) {
      const j = (i + 1) % hem.length
      // boundary loops follow face winding, so this ordering keeps the extension's normals outward
      faces.push(prev[i], ring[i], prev[j], prev[j], ring[i], ring[j])
    }
    prev = ring
  }
  return tube
}

/**
 * Real fabric bridges hollows (between the breasts, the small of the back) instead of following
 * the skin. Alternate a Laplacian smoothing step (which flattens bumps and pulls the cloth taut
 * across concavities) with a push-out step that keeps every vertex at least `clearance` above the
 * nearest skin point (tracked in `src`). The fixed point is a smooth envelope: a balloon
 * shrink-wrapped onto the body. Boundary vertices are smoothed only along their own loop (Taubin
 * λ/μ, so without shrinking it), which straightens hems and necklines. An extruded hem tube follows the cut's edge rigidly instead:
 * smoothing a wide skirt would shrink it ring by ring onto the legs.
 */
function shrinkWrap(
  x: Float32Array, faces: number[], src: number[], body: Float32Array, bodyN: Float32Array,
  bodyAdj: { start: Uint32Array; adj: Uint32Array }, clearance: (v: number) => number, tube: TubeVertex[],
) {
  const n = x.length / 3
  const { start, adj } = vertexAdjacency(faces, n)
  const loops = boundaryLoops(faces)
  const loopNeighbours = new Map<number, [number, number]>()
  for (const loop of loops)
    loop.forEach((v, i) => loopNeighbours.set(v, [loop[(i + loop.length - 1) % loop.length], loop[(i + 1) % loop.length]]))
  const inTube = new Uint8Array(n)
  for (const t of tube) inTube[t.v] = 1
  const tmp = new Float32Array(x.length)
  for (let it = 0; it < SHRINK_WRAP_ITERATIONS; it++) {
    for (let v = 0; v < n; v++) {
      if (inTube[v]) continue
      const ring = loopNeighbours.get(v)
      let cx = 0, cy = 0, cz = 0, k = 0
      const add = (u: number) => { cx += x[u * 3]; cy += x[u * 3 + 1]; cz += x[u * 3 + 2]; k++ }
      if (ring) ring.forEach(add)
      else for (let e = start[v]; e < start[v + 1]; e++) add(adj[e])
      // Openings use Taubin's alternating λ/μ: it straightens a hem or neckline without shortening
      // the loop (plain smoothing slid a tank's armhole and neckline off the shoulder, taking the straps)
      const lambda = ring && it % 2 ? -0.53 : 0.5
      for (let c = 0; c < 3; c++) tmp[v * 3 + c] = x[v * 3 + c] + lambda * ([cx, cy, cz][c] / k - x[v * 3 + c])
    }
    for (const t of tube) {
      tmp[t.v * 3] = tmp[t.base * 3] + t.dx
      tmp[t.v * 3 + 1] = tmp[t.base * 3 + 1] + t.dy
      tmp[t.v * 3 + 2] = tmp[t.base * 3 + 2] + t.dz
    }
    x.set(tmp)
    for (let v = 0; v < n; v++) {
      // against the nearest skin point, not the one it was cut from: a vertex cut from the fold
      // under the bust is smoothed up into the breast's lower curve, where its own plane can't see it
      src[v] = walkToNearest(body, bodyAdj, src[v], x[v * 3], x[v * 3 + 1], x[v * 3 + 2], inTube[v] ? 64 : 8)
      const s = src[v] * 3
      const d = (x[v * 3] - body[s]) * bodyN[s] + (x[v * 3 + 1] - body[s + 1]) * bodyN[s + 1] + (x[v * 3 + 2] - body[s + 2]) * bodyN[s + 2]
      const c = clearance(src[v])
      if (d < c) for (let k = 0; k < 3; k++) x[v * 3 + k] += (c - d) * bodyN[s + k]
    }
  }
}

/** Band mask with the highest opening (a waistband, a strapless edge) added to `band`. */
function topBand(g: Garment, band: Uint8Array = new Uint8Array(g.src.length)) {
  const meanY = (l: number[]) => l.reduce((t, v) => t + g.rest[v * 3 + 1], 0) / l.length
  for (const v of boundaryLoops(g.index).sort((a, b) => meanY(b) - meanY(a))[0] ?? []) band[v] = 1
  return band
}

/**
 * Distance (m) of each vertex from the top opening, for a contrast trim (the gown's draped
 * neckline band) drawn where it is under TRIM_WIDTH. The shader thresholds the interpolated
 * distance, so the band's lower edge is a smooth line whatever the triangles look like (picking
 * whole faces gave a saw-tooth edge across the bodice's sliver triangles).
 */
function trimDistance(g: Garment) {
  const meanY = (l: number[]) => l.reduce((t, v) => t + g.rest[v * 3 + 1], 0) / l.length
  const edge = boundaryLoops(g.index).sort((a, b) => meanY(b) - meanY(a))[0] ?? []
  return Float32Array.from({ length: g.src.length }, (_, v) =>
    Math.min(...edge.map((e) => Math.hypot(g.rest[v * 3] - g.rest[e * 3], g.rest[v * 3 + 1] - g.rest[e * 3 + 1], g.rest[v * 3 + 2] - g.rest[e * 3 + 2]))))
}

function splitFrontBack(rest: Float32Array, faces: number[]) {
  const front: number[] = []
  const back: number[] = []
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f], b = faces[f + 1], c = faces[f + 2]
    // z-component of the face normal: (b-a) × (c-a)
    const nz = (rest[b * 3] - rest[a * 3]) * (rest[c * 3 + 1] - rest[a * 3 + 1]) -
      (rest[b * 3 + 1] - rest[a * 3 + 1]) * (rest[c * 3] - rest[a * 3])
    ;(nz >= 0 ? front : back).push(a, b, c)
  }
  return { index: Uint32Array.from([...front, ...back]), frontCount: front.length }
}

/**
 * Orthographic front projection (what a flat-lay photo sees), piecewise-linear in x:
 * [minX, torsoMinX] → [0, l],  [torsoMinX, torsoMaxX] → [l, r],  [torsoMaxX, maxX] → [r, 1].
 * Torso extent is measured near the hem, where no sleeves are in the way.
 */
export function planarUV(rest: Float32Array, photoTorso?: [number, number]) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < rest.length; i += 3) {
    minX = Math.min(minX, rest[i]); maxX = Math.max(maxX, rest[i])
    minY = Math.min(minY, rest[i + 1]); maxY = Math.max(maxY, rest[i + 1])
  }
  let tMin = Infinity, tMax = -Infinity
  const hemBand = minY + (maxY - minY) * 0.15
  for (let i = 0; i < rest.length; i += 3)
    if (rest[i + 1] < hemBand) {
      tMin = Math.min(tMin, rest[i]); tMax = Math.max(tMax, rest[i])
    }
  const [l, r] = photoTorso ?? [(tMin - minX) / (maxX - minX), (tMax - minX) / (maxX - minX)]
  const u = (x: number) =>
    x < tMin ? (l * (x - minX)) / (tMin - minX || 1)
      : x > tMax ? r + ((1 - r) * (x - tMax)) / (maxX - tMax || 1)
        : l + ((r - l) * (x - tMin)) / (tMax - tMin)
  const uv = new Float32Array((rest.length / 3) * 2)
  for (let v = 0; v < rest.length / 3; v++) {
    uv[v * 2] = u(rest[v * 3])
    uv[v * 2 + 1] = (rest[v * 3 + 1] - minY) / (maxY - minY)
  }
  return uv
}

/**
 * Fabric coordinates in metres for a tiled swatch: height for v, and for u whichever horizontal
 * axis the surface faces across (x on the front and back, z on the sides), so the weave keeps its
 * scale all the way round; the texture's repeat sets the swatch size.
 */
function tiledUV(rest: Float32Array, index: Uint32Array) {
  const n = vertexNormals(rest, index)
  const uv = new Float32Array((rest.length / 3) * 2)
  for (let v = 0; v < rest.length / 3; v++) {
    uv[v * 2] = Math.abs(n[v * 3]) > Math.abs(n[v * 3 + 2]) ? rest[v * 3 + 2] : rest[v * 3]
    uv[v * 2 + 1] = rest[v * 3 + 1]
  }
  return uv
}
