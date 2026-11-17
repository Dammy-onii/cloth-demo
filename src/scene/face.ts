// Face detail: eyebrows and eyelashes as strands (drawn with the hair), and glossy eyes: a thin
// shell over each eyeball with a procedural iris and a clear coat that catches the studio lights.

import * as THREE from 'three'
import type { BodySet } from '../body/bodySet'
import { ScalpGrid, add, cross, norm, rng, scale, sub, tangent, type Strand, type V3 } from './strands'

/** brow hair (dark brown, lighter than the scalp hair reads) and lashes (near black) */
export const BROW = new THREE.Color('#33241a')
const LASH = new THREE.Color('#0e0a08')

const smooth01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

export interface EyeInfo {
  ids: number[]
  c: V3
  r: number
  /** +1 for the body's left eye (+x), −1 for the right */
  side: 1 | -1
}

/** The two eyeballs: their vertices, centres and radii. */
export function findEyes(body: BodySet, pos: Float32Array): EyeInfo[] {
  const eye = body.segment('eye')
  return ([1, -1] as const).map((side) => {
    const ids = [...body.labels.keys()].filter((v) => body.labels[v] === eye && pos[v * 3] * side > 0)
    const c = [0, 1, 2].map((k) => ids.reduce((t, v) => t + pos[v * 3 + k], 0) / Math.max(ids.length, 1)) as V3
    const r = ids.reduce((t, v) => t + Math.hypot(pos[v * 3] - c[0], pos[v * 3 + 1] - c[1], pos[v * 3 + 2] - c[2]), 0) / Math.max(ids.length, 1)
    return { ids, c, r, side }
  })
}

/**
 * The eyelid margins: head vertices lying on the eyeball in front, split into the upper and lower
 * lid. Per narrow column across the eye, the upper lid's lowest vertex and the lower lid's highest
 * one, smoothed into a curve.
 */
function lidMargins(body: BodySet, pos: Float32Array, e: EyeInfo) {
  const head = body.segment('head')
  const cols = 14
  const upper: (V3 | undefined)[] = Array(cols).fill(undefined), lower: (V3 | undefined)[] = Array(cols).fill(undefined)
  const half = e.r * 1.05
  for (let v = 0; v < body.vertexCount; v++) {
    if (body.labels[v] !== head) continue
    const p: V3 = [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]
    const d = sub(p, e.c)
    const dist = Math.hypot(...d)
    if (dist > e.r + 0.003 || d[2] < e.r * 0.25 || Math.abs(d[0]) > half) continue
    const k = Math.min(cols - 1, Math.max(0, Math.floor(((d[0] + half) / (2 * half)) * cols)))
    if (d[1] > 0) { if (!upper[k] || p[1] < upper[k]![1]) upper[k] = p }
    else if (!lower[k] || p[1] > lower[k]![1]) lower[k] = p
  }
  const curve = (pts: (V3 | undefined)[]) => {
    const got = pts.filter((p): p is V3 => !!p).sort((a, b) => a[0] - b[0])
    // light smoothing along the lid
    return got.map((p, i) => {
      const a = got[Math.max(0, i - 1)], b = got[Math.min(got.length - 1, i + 1)]
      return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4, (a[2] + 2 * p[2] + b[2]) / 4] as V3
    })
  }
  return { upper: curve(upper), lower: curve(lower) }
}

/** A point along a polyline, t in 0..1 by arc length. */
function along(pts: V3[], t: number): V3 {
  const seg = pts.slice(1).map((p, i) => Math.hypot(...sub(p, pts[i])))
  let s = t * seg.reduce((a, b) => a + b, 0)
  for (let i = 0; i < seg.length; i++) {
    if (s <= seg[i] || i === seg.length - 1) {
      const u = seg[i] ? Math.min(1, s / seg[i]) : 0
      return add(pts[i], scale(sub(pts[i + 1], pts[i]), u))
    }
    s -= seg[i]
  }
  return pts[0]
}

/**
 * Eyebrows and eyelashes. Brows: short strands in an arched band above each eye, thicker at the
 * inner end, lying along the skin, pointing up at the start and out towards the tail. Lashes: from
 * the lid margins, curving up (upper) or down (lower) as they come forward.
 */
export function faceStrands(body: BodySet, pos: Float32Array, nrm: Float32Array, male: boolean): Strand[] {
  const eyes = findEyes(body, pos)
  if (!eyes.every((e) => e.ids.length)) return []
  const head = body.segment('head')
  const r = rng(23)
  const out: Strand[] = []
  // the face skin, for brow roots
  const faceVerts: number[] = []
  for (let v = 0; v < body.vertexCount; v++) if (body.labels[v] === head && nrm[v * 3 + 2] > 0.2 && pos[v * 3 + 1] > eyes[0].c[1] - 0.02) faceVerts.push(v)
  const grid = new ScalpGrid({ verts: faceVerts, pos, nrm }, 0.006)
  for (const e of eyes) {
    // eyebrow: thinning out at every edge (a filled band with a hard outline read as paint), each
    // hair arcing up off the skin and back down, its direction jittered
    const target = male ? 950 : 700
    for (let made = 0, tries = 0; made < target && tries < target * 6; tries++) {
      const u = r() // 0 inner end, 1 tail
      const v = r() * 2 - 1 // across the brow
      const density = smooth01((1 - Math.abs(v)) / 0.55) * smooth01(u / 0.14) * smooth01((1 - u) / 0.22)
      if (r() > density) continue
      made++
      const dx = -0.006 + u * 0.05 // outwards from just inside the eye's centre
      const arch = 0.017 + 0.006 * Math.sin(Math.PI * Math.min(1, u * 1.35)) - 0.004 * smooth01((u - 0.75) / 0.25)
      const thick = (male ? 0.009 : 0.0065) * (1 - 0.55 * u)
      const p: V3 = [e.c[0] + e.side * dx, e.c[1] + arch + v * thick * 0.5, e.c[2] + 0.03]
      grid.lift(p, 0.0002)
      const n = grid.lift(p, 0.0002)
      // inner hairs point up, the rest out and a little up, the tail down
      const base: V3 = [e.side * (0.35 + 0.65 * smooth01(u / 0.3)), 1.15 - 1.1 * smooth01(u / 0.35) - 0.5 * smooth01((u - 0.7) / 0.3) - 0.25 * v, 0]
      let t = norm(tangent(norm(base), n))
      const jitter = (r() - 0.5) * 0.7
      t = norm(add(scale(t, Math.cos(jitter)), scale(cross(n, t), Math.sin(jitter))))
      let d = norm(add(t, scale(n, 0.5)))
      const edge = density
      const L = (0.0045 + 0.0045 * r()) * (0.7 + 0.3 * edge) * (male ? 1.15 : 1)
      const pts: V3[] = [p]
      let q = p
      for (let k = 0; k < 4; k++) {
        q = add(q, scale(d, L / 4))
        d = norm(add(d, scale(n, -0.28))) // arcs back down onto the skin
        pts.push(q)
      }
      out.push({ points: pts, root: nearestVertex(faceVerts, pos, p), width: (0.00013 + 0.00007 * r()) * (0.75 + 0.25 * edge), tint: 0.75 + r() * 0.5, color: BROW })
    }
    // eyelashes: in small clumps that meet at the tips, longest at the middle and outer lid,
    // sweeping out and curling up
    const { upper, lower } = lidMargins(body, pos, e)
    const lash = (lid: V3[], clumps: number, len: number, up: 1 | -1, width = 0.00017) => {
      if (lid.length < 3) return
      for (let c = 0; c < clumps; c++) {
        const tc = 0.05 + 0.9 * r()
        const L0 = len * (0.5 + 0.5 * Math.sin(Math.PI * Math.min(1, tc * 1.2))) * (0.85 + r() * 0.3)
        const tipLid = along(lid, tc)
        const tipOut = norm(sub(tipLid, e.c))
        // where the clump's lashes meet
        let dd = norm(add(scale(tipOut, 0.6), [e.side * 0.45 * (tc - 0.35), 0.6 * up, 0]))
        let tip = add(tipLid, scale(tipOut, 0.0004))
        for (let k = 0; k < 5; k++) { tip = add(tip, scale(dd, L0 / 5)); dd = norm(add(dd, [0, (0.3 + 0.2 * k) * up, 0])) }
        const m = 2 + Math.floor(r() * 3)
        for (let i = 0; i < m; i++) {
          const t = Math.min(0.97, Math.max(0.03, tc + (r() - 0.5) * 0.06))
          const root = add(along(lid, t), [0, -0.0005 * up, 0])
          const out0 = norm(sub(root, e.c))
          // out of the lid forward, then sweeping up (from the front the tips sit above the lid line;
          // lashes reaching straight forward lay across the iris)
          // and fanning out towards the outer corner
          let d = norm(add(scale(out0, 0.6), [e.side * 0.45 * (t - 0.35), 0.6 * up, 0]))
          let q = add(root, scale(out0, 0.0004))
          const pts: V3[] = [q]
          const L = L0 * (0.85 + r() * 0.25)
          for (let k = 0; k < 5; k++) {
            q = add(q, scale(d, L / 5))
            d = norm(add(d, [0, (0.3 + 0.2 * k) * up, 0]))
            // drawn in towards the clump's tip over the last part
            const w = smooth01((k - 1) / 3) * 0.35
            q = add(scale(q, 1 - w), scale(add(tip, [0, 0, 0]), w))
            pts.push(q)
          }
          out.push({ points: pts, root: nearestVertex(faceVerts, pos, root), width, tint: 0.8 + r() * 0.3, color: LASH })
        }
      }
    }
    lash(upper, male ? 28 : 40, male ? 0.0085 : 0.011, 1)
    lash(lower, male ? 5 : 9, 0.0038, -1, 0.0001)
    // the lash line: a dense row of short lashes right along the upper lid's edge, which is what
    // frames a real eye (long lashes alone stood up like separate sticks)
    if (upper.length >= 3)
      for (let i = 0; i < (male ? 90 : 130); i++) {
        const t = 0.04 + 0.92 * r()
        const root = add(along(upper, t), [0, -0.0004, 0])
        const out0 = norm(sub(root, e.c))
        const L = (male ? 0.0022 : 0.003) * (0.7 + r() * 0.6)
        const d0 = norm(add(scale(out0, 0.8), [e.side * 0.2 * (t - 0.4), 0.45, 0]))
        const mid = add(root, scale(d0, L / 2))
        const tip = add(mid, scale(norm(add(d0, [0, 0.5, 0])), L / 2))
        out.push({ points: [root, mid, tip], root: nearestVertex(faceVerts, pos, root), width: 0.00016, tint: 0.7 + r() * 0.3, color: LASH })
      }
  }
  return out
}

function nearestVertex(verts: number[], pos: Float32Array, p: V3) {
  let best = verts[0], d = Infinity
  for (const v of verts) {
    const q = (pos[v * 3] - p[0]) ** 2 + (pos[v * 3 + 1] - p[1]) ** 2 + (pos[v * 3 + 2] - p[2]) ** 2
    if (q < d) { d = q; best = v }
  }
  return best
}

/**
 * Glossy eyes: the eyeball faces again, 0.3 mm proud, with a procedural eye (sclera, iris fibres,
 * limbal ring, pupil) by direction from the eye's centre, and a clear coat for the catchlights.
 */
export class Eyes {
  private readonly verts: number[] = []
  private readonly dirs: number[] = []

  constructor(body: BodySet, pos: Float32Array, readonly geometry: THREE.BufferGeometry) {
    const eyes = findEyes(body, pos)
    const local = new Int32Array(body.vertexCount).fill(-1)
    for (const e of eyes)
      for (const v of e.ids) {
        local[v] = this.verts.length
        this.verts.push(v)
        const d = norm(sub([pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]], e.c))
        this.dirs.push(...d)
      }
    const faces: number[] = []
    for (let t = 0; t < body.index.length; t += 3) {
      const a = local[body.index[t]], b = local[body.index[t + 1]], c = local[body.index[t + 2]]
      if (a >= 0 && b >= 0 && c >= 0) faces.push(a, b, c)
    }
    geometry.setIndex(faces)
    geometry.setAttribute('eyeDir', new THREE.Float32BufferAttribute(this.dirs, 3))
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(this.verts.length * 3), 3))
  }

  update(body: Float32Array) {
    const attr = this.geometry.getAttribute('position') as THREE.BufferAttribute
    const p = attr.array as Float32Array
    this.verts.forEach((v, i) => {
      for (let k = 0; k < 3; k++) p[i * 3 + k] = body[v * 3 + k] + this.dirs[i * 3 + k] * 0.0003
    })
    attr.needsUpdate = true
    this.geometry.computeVertexNormals()
    this.geometry.computeBoundingSphere()
  }
}

/** The eye surface: wet (clear coat), with the eye painted by direction in the shader. */
export function eyeMaterial() {
  const m = new THREE.MeshPhysicalMaterial({ roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.03, color: '#ffffff' })
  // the iris colour, settable after compiling (a fitted face's eyes, read from the photo)
  m.userData.irisColor = { value: new THREE.Color('#4a2c1a') }
  m.onBeforeCompile = (shader) => {
    shader.uniforms.irisColor = m.userData.irisColor
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 eyeDir;\nvarying vec3 vEyeDir;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEyeDir = eyeDir;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 irisColor;
varying vec3 vEyeDir;
float eh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float en(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(eh(i), eh(i + vec2(1, 0)), f.x), mix(eh(i + vec2(0, 1)), eh(i + vec2(1, 1)), f.x), f.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec3 d = normalize(vEyeDir);
  float c = d.z; // the eyes look forward (+z)
  float rho = sqrt(max(0.0, 1.0 - c * c)); // distance from the visual axis, 0..1
  float phi = atan(d.y, d.x);
  // sclera: warm white, pinker and a little darker towards the corners
  vec3 sclera = mix(vec3(0.86, 0.80, 0.76), vec3(0.93, 0.90, 0.86), smoothstep(0.2, 0.9, c));
  sclera *= 0.97 + 0.03 * en(vec2(phi * 12.0, rho * 30.0));
  // iris: radial fibres, lighter round the pupil, a dark limbal ring at its edge
  float fib = en(vec2(phi * 38.0, rho * 6.0)) * 0.6 + en(vec2(phi * 90.0, rho * 14.0)) * 0.4;
  vec3 iris = irisColor * (0.6 + 0.8 * fib) * mix(1.5, 0.75, smoothstep(0.12, 0.46, rho));
  float irisR = 0.47, pupilR = 0.16;
  vec3 eye = mix(iris, sclera, smoothstep(irisR - 0.02, irisR + 0.02, rho));
  eye *= 1.0 - 0.55 * exp(-pow((rho - irisR + 0.01) / 0.03, 2.0)); // limbal ring
  eye = mix(vec3(0.015), eye, smoothstep(pupilR - 0.012, pupilR + 0.012, rho));
  diffuseColor.rgb = eye;
}`)
  }
  return m
}
