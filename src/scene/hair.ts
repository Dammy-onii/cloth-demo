// Procedural hair, grown on the head as it is now (like the sneakers). Thousands of strands
// (strands.ts) carry the look; under them a dark shell over the scalp, inside a hairline found from
// the eyes, reads as the dense hair between them. Female: sleek, combed back into a low twisted bun.
// Male: a fade (stubble darkening the skin, growing denser upwards) with a textured top.

import * as THREE from 'three'
import type { BodySet, Size } from '../body/bodySet'
import { vertexNormals } from '../math/mesh'
import { BROW, faceStrands } from './face'
import { ScalpGrid, StrandMesh, add, cross, dot, norm, rng, scale, sub, tangent, type Strand, type V3 } from './strands'

export type HairStyle = 'default' | 'none' | 'afro' | 'braids'

const HAIR_COLOR = new THREE.Color('#1c1511')
/** the under-layer: darker than the strands, as hair is deeper in */
const SHELL_COLOR = HAIR_COLOR.clone().multiplyScalar(0.5)

const smooth01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

/** Smooth wavy noise in about [-1, 1] (a few crossed sine waves): clumps of the textured top. */
function waves(x: number, y: number, z: number) {
  return (Math.sin(x * 61 + z * 23) * Math.sin(z * 53 - y * 31) + 0.6 * Math.sin(x * 97 - y * 71 + z * 41)) / 1.6
}

/** Hairline height (m relative to the eyes) by angle from the front (radians, 0..π), per head height. */
function hairline(theta: number, headH: number, male: boolean) {
  const deg = (theta * 180) / Math.PI
  // forehead, temples, above the ears, behind the ears, nape
  const keys: [number, number][] = male
    ? [[0, 0.66], [35, 0.6], [70, 0.36], [100, 0.14], [135, -0.25], [180, -0.55]]
    // (arching well above the ear: strands combed back across it ringed it in black)
    : [[0, 0.74], [30, 0.72], [55, 0.6], [75, 0.42], [97, 0.33], [116, 0.12], [140, -0.3], [180, -0.62]]
  for (let k = 1; k < keys.length; k++)
    if (deg <= keys[k][0]) {
      const [a, ha] = keys[k - 1], [b, hb] = keys[k]
      return headH * (ha + (hb - ha) * smooth01((deg - a) / (b - a)))
    }
  return headH * keys[keys.length - 1][1]
}

interface HeadFrame {
  cx: number
  cz: number
  eyeY: number
  topY: number
}

export class Hair {
  private readonly verts: number[] = []
  private readonly faces: number[] = []
  /** per shell vertex: thickness (m), hair cover 0..1, strand coordinate across and along */
  private readonly thick: number[] = []
  private readonly cover: number[] = []
  private readonly strand: number[] = []
  /** height above the hairline (m): the shader cuts the hair where this crosses zero */
  private readonly line: number[] = []
  private readonly male: boolean
  /** how the shell is laid and shaded: the sleek bun, or a short style combed up and down the head */
  private readonly kind: 'sleek' | 'short'
  private readonly frame: HeadFrame
  private skin = new THREE.Color('#a87a5a')
  /** body positions the strands were grown on */
  private readonly rest: Float32Array
  private readonly strandMesh: StrandMesh

  constructor(
    body: BodySet,
    size: Size,
    private readonly geometry: THREE.BufferGeometry,
    private readonly material: THREE.Material,
    strandGeometry: THREE.BufferGeometry,
    strandMaterial: THREE.Material,
    /** 'none': a bald head with only brows and lashes (the head studio, and a new head before its hair is chosen);
     *  'afro': short dense coils; 'braids': cornrows over the head, hanging down the back */
    style: HairStyle = 'default',
    /** the 3D brows; off when a photo of the face is painted on, whose own brows they doubled */
    brows = true,
  ) {
    this.male = body.gender === 'male'
    this.kind = style === 'afro' || style === 'braids' || (style !== 'none' && this.male) ? 'short' : 'sleek'
    const pos = body.positions(size, 'apose')
    const head = body.segment('head'), eye = body.segment('eye'), neck = body.segment('neck')
    let cx = 0, cz = 0, n = 0, eyeY = 0, ne = 0, topY = -Infinity
    for (let v = 0; v < body.vertexCount; v++) {
      const l = body.labels[v]
      if (l === head) { cx += pos[v * 3]; cz += pos[v * 3 + 2]; n++; topY = Math.max(topY, pos[v * 3 + 1]) }
      if (l === eye) { eyeY += pos[v * 3 + 1]; ne++ }
    }
    this.frame = { cx: cx / n, cz: cz / n, eyeY: ne ? eyeY / ne : topY - 0.11, topY }
    const f = this.frame, headH = f.topY - f.eyeY
    // shell vertices: head (and the top of the neck at the nape) above the hairline
    const keep = new Int32Array(body.vertexCount).fill(-1)
    const above = new Float32Array(body.vertexCount)
    for (let v = 0; v < body.vertexCount; v++) {
      const l = body.labels[v]
      if (l !== head && l !== neck) continue
      const x = pos[v * 3] - f.cx, y = pos[v * 3 + 1] - f.eyeY, z = pos[v * 3 + 2] - f.cz
      const theta = Math.abs(Math.atan2(x, z))
      above[v] = y - hairline(theta, headH, this.male || style === 'afro' || style === 'braids')
      // keep a band below the line too: the shader cuts along the interpolated zero crossing, a
      // smooth line where whole triangles came out stair-stepped
      if (above[v] > -0.02) {
        keep[v] = this.verts.length
        this.verts.push(v)
      }
    }
    const index = body.index
    for (let t = 0; t < index.length; t += 3) {
      const a = keep[index[t]], b = keep[index[t + 1]], c = keep[index[t + 2]]
      if (a >= 0 && b >= 0 && c >= 0) this.faces.push(a, b, c)
    }
    for (const v of this.verts) {
      const x = pos[v * 3] - f.cx, y = pos[v * 3 + 1] - f.eyeY, z = pos[v * 3 + 2] - f.cz
      const edge = smooth01(above[v] / 0.012)
      if (style === 'afro') {
        // short coils, a little rounded on top: about 2 cm deep on the crown, under 1 cm over the ears and
        // nape (3.5 cm on the crown read as a big round afro next to the owner's photo of short coils)
        const top = smooth01((y - headH * 0.1) / (headH * 0.7))
        this.line.push(above[v])
        this.thick.push(0.002 + edge * (0.006 + 0.012 * top))
        this.cover.push(1)
        this.strand.push(Math.atan2(x, z) * 0.3 + y * 0.6, y * 2)
      } else if (style === 'braids') {
        // cornrows lie tight to the scalp: only a thin dark base between the rows
        this.line.push(above[v] - 0.004)
        this.thick.push(0.0008 + edge * 0.0012)
        // full cover, dark: partly covered it blended with the skin into a brown cap
        this.cover.push(1)
        this.strand.push(Math.atan2(x, z) * 0.12, y)
      } else if (this.male) {
        // fade: stubble low on the head, growing denser up to the textured top; the shell is only
        // its base, the strands give the top its volume
        const top = topWeight(x, y, z, headH)
        this.line.push(above[v])
        this.thick.push(0.0006 + edge * (0.001 + top * (0.005 + 0.002 * waves(x, y, z))))
        this.cover.push(0.35 + 0.65 * smooth01((y - headH * 0.1) / (headH * 0.45)))
        this.strand.push(Math.atan2(x, z) * 0.12 + y * 0.3, y)
      } else {
        // the under-layer stops a few mm inside the hairline, where the strands thin out over skin
        const crown = smooth01((y - headH * 0.3) / (headH * 0.6))
        this.line.push(above[v] - 0.005)
        this.thick.push(0.0006 + edge * (0.0015 + 0.002 * crown))
        this.cover.push(1)
        this.strand.push(0, 0) // filled per frame from the bun direction
      }
    }

    this.rest = pos
    this.strandMesh = new StrandMesh(strandGeometry)
    const nrm = vertexNormals(pos, body.index)
    const grid = new ScalpGrid({ verts: this.verts, pos, nrm })
    const roots = new RootSampler(this.verts, this.faces, pos, nrm, above, this.thick)
    const strands = style === 'none' ? [] : style === 'afro' ? growAfro(roots) : style === 'braids' ? growBraids(f, pos, nrm, this.verts, above, body)
      : this.male ? growCrop(f, roots) : growSleek(f, grid, roots, this.bunAt(pos))
    this.geometry.setDrawRange(0, style === 'none' ? 0 : Infinity)
    // eyebrows and eyelashes are drawn with the hair
    strands.push(...faceStrands(body, pos, nrm, this.male).filter((t) => brows || t.color !== BROW))
    this.strandMesh.build(strands, HAIR_COLOR)
    this.strandMesh.aim([f.cx, f.eyeY + headH * 0.3, f.cz])
    ;(strandMaterial.userData.gloss as { value: number }).value = this.kind === 'short' ? 0.35 : 1
    ;(strandMaterial as THREE.MeshStandardMaterial).roughness = this.kind === 'short' ? 0.8 : 0.6
  }

  /** The low bun: against the scalp at the back of the head, just above the nape. */
  private bunAt(body: Float32Array): V3 {
    const f = this.frame, headH = f.topY - f.eyeY
    const bunY = f.eyeY - headH * 0.3
    let back = Infinity
    for (const v of this.verts)
      if (Math.abs(body[v * 3 + 1] - bunY) < 0.02 && Math.abs(body[v * 3] - f.cx) < 0.03) back = Math.min(back, body[v * 3 + 2])
    if (!Number.isFinite(back)) back = f.cz - 0.09
    return [f.cx, bunY, back + 0.006]
  }

  setSkin(tone: string) {
    this.skin.set(tone)
  }

  /** Rebuild from the body as it is now. */
  update(body: Float32Array, normals: Float32Array) {
    const f = this.frame
    const p: number[] = [], c: number[] = [], tan: number[] = [], uv: number[] = [], cov: number[] = [], line: number[] = []
    const headH = f.topY - f.eyeY
    const bun = this.bunAt(body)
    this.strandMesh.move(this.rest, body)
    const skin = this.skin
    this.verts.forEach((v, i) => {
      const nx = normals[v * 3], ny = normals[v * 3 + 1], nz = normals[v * 3 + 2]
      const t = this.thick[i]
      const x = body[v * 3] + nx * t, y = body[v * 3 + 1] + ny * t, z = body[v * 3 + 2] + nz * t
      p.push(x, y, z)
      const k = this.cover[i]
      cov.push(k)
      line.push(this.line[i])
      c.push(skin.r, skin.g, skin.b)
      // strand direction on the surface: towards the bun (female), up and forward on top / down
      // the sides (male)
      let dx: number, dy: number, dz: number
      if (this.kind === 'short') {
        const top = this.thick[i] > 0.008
        ;[dx, dy, dz] = top ? [0, 0.5, 1] : [0, -1, -0.2]
      } else {
        ;[dx, dy, dz] = [bun[0] - x, bun[1] - y, bun[2] - z]
      }
      const dn = dx * nx + dy * ny + dz * nz
      dx -= nx * dn; dy -= ny * dn; dz -= nz * dn
      const l = Math.hypot(dx, dy, dz) || 1
      tan.push(dx / l, dy / l, dz / l)
      if (this.kind === 'short') uv.push(this.strand[i * 2], this.strand[i * 2 + 1])
      else {
        // across: angle round the axis from the head centre to the bun; along: distance to the bun
        const ax = bun[0] - f.cx, ay = bun[1] - (f.eyeY + headH * 0.2), az = bun[2] - f.cz
        const al = Math.hypot(ax, ay, az)
        const qx = x - f.cx, qy = y - (f.eyeY + headH * 0.2), qz = z - f.cz
        // basis ⟂ the axis
        const e1 = [1, 0, 0], d1 = (e1[0] * ax) / al
        const u1 = [e1[0] - (ax / al) * d1, -(ay / al) * d1, -(az / al) * d1]
        const ul = Math.hypot(...u1)
        const u = u1.map((q) => q / ul)
        const w = [(ay * u[2] - az * u[1]) / al, (az * u[0] - ax * u[2]) / al, (ax * u[1] - ay * u[0]) / al]
        const phi = Math.atan2(qx * w[0] + qy * w[1] + qz * w[2], qx * u[0] + qy * u[1] + qz * u[2])
        uv.push(phi * 0.09, Math.hypot(x - bun[0], y - bun[1], z - bun[2]))
      }
    })
    const faces = [...this.faces]
    if (this.kind === "sleek") this.addBun(bun, p, c, tan, uv, faces)
    // the shell is the deep, shadowed layer: the strands carry the shine
    ;(this.material.userData.gloss as { value: number }).value = 0.25
    ;(this.material as THREE.MeshStandardMaterial).roughness = this.male ? 0.85 : 0.55
    while (cov.length < p.length / 3) cov.push(1)
    while (line.length < p.length / 3) line.push(1)
    const g = this.geometry
    g.setIndex(faces)
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3))
    g.setAttribute('strandTangent', new THREE.Float32BufferAttribute(tan, 3))
    g.setAttribute('strandUV', new THREE.Float32BufferAttribute(uv, 2))
    g.setAttribute('hairCover', new THREE.Float32BufferAttribute(cov, 1))
    g.setAttribute('hairLine', new THREE.Float32BufferAttribute(line, 1))
    g.computeVertexNormals()
    g.computeBoundingSphere()
  }

  /** A low bun: a twisted, slightly flattened knot of hair at `at`, its strands wrapping round it. */
  private addBun(at: [number, number, number], p: number[], c: number[], tan: number[], uv: number[], faces: number[]) {
    const base = p.length / 3
    const R = 0.046, r = 0.022 // coil radius, tube radius (inside the bun's strands)
    const U = 40, V = 14
    for (let i = 0; i <= U; i++) {
      const a = (i / U) * Math.PI * 2
      for (let j = 0; j <= V; j++) {
        const b = (j / V) * Math.PI * 2
        // torus lying against the back of the head (axis along z), filled in the middle
        const rr = R * 0.55 + r * Math.cos(b)
        const x = at[0] + rr * Math.cos(a) * 1.05
        const y = at[1] + rr * Math.sin(a) * 0.82
        const z = at[2] - 0.012 - r * Math.sin(b) * 0.9
        p.push(x, y, z)
        c.push(this.skin.r, this.skin.g, this.skin.b)
        // strands wrap round the coil
        tan.push(-Math.sin(a), Math.cos(a), 0)
        uv.push(b * 0.05 + a * 0.01, a * 0.05)
      }
    }
    for (let i = 0; i < U; i++)
      for (let j = 0; j < V; j++) {
        const a = base + i * (V + 1) + j, b = a + V + 1
        faces.push(a, a + 1, b, b, a + 1, b + 1)
      }
  }
}

/**
 * Hair material: vertex colours (blended into the skin at a soft hairline), fine streaks along the
 * strands, and a Kajiya–Kay highlight that runs across the strands as real hair's sheen does.
 */
export function hairMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 })
  // glossy for the sleek style, matte for the textured crop (set by Hair.update)
  m.userData.gloss = { value: 1 }
  m.onBeforeCompile = (shader) => {
    shader.uniforms.keyDir = { value: new THREE.Vector3(2.2, 4.2, 3).normalize() }
    shader.uniforms.hairColor = { value: SHELL_COLOR }
    shader.uniforms.gloss = m.userData.gloss
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 strandTangent;\nattribute vec2 strandUV;\nattribute float hairCover;\nattribute float hairLine;\nvarying float vLine;\nvarying vec3 vPos;\nuniform vec3 keyDir;\nvarying vec3 vT;\nvarying vec3 vL;\nvarying vec2 vS;\nvarying float vCover;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvT = normalize((modelViewMatrix * vec4(strandTangent, 0.0)).xyz);\nvL = normalize((viewMatrix * vec4(keyDir, 0.0)).xyz);\nvS = strandUV;\nvCover = hairCover;\nvLine = hairLine;\nvPos = position;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vT;
varying vec3 vL;
varying vec2 vS;
varying float vCover;
varying float vLine;
varying vec3 vPos;
uniform vec3 hairColor;
uniform float gloss;
float hh(float n) { return fract(sin(n) * 43758.5453); }
float strandNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hh(i.x + i.y * 57.0), b = hh(i.x + 1.0 + i.y * 57.0), c = hh(i.x + (i.y + 1.0) * 57.0), d = hh(i.x + 1.0 + (i.y + 1.0) * 57.0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
// the hairline, a little ragged at the strand scale
if (vLine < 0.0015 * (strandNoise(vec2(vS.x * 700.0, vS.y * 40.0)) - 0.5)) discard;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
float streak = 0.55 * strandNoise(vec2(vS.x * 900.0, vS.y * 18.0)) + 0.45 * strandNoise(vec2(vS.x * 260.0, vS.y * 6.0));
// where cover is partial (a fade) the hair is stubble: the skin darkens with it (specks finer
// than a pixel averaged out to bare skin), with a little grain
float speck = strandNoise(vec2((vPos.x + vPos.z) * 500.0, vPos.y * 500.0));
float hairMask = clamp((vCover - 0.3) * 1.6 + (speck - 0.5) * 0.25, 0.0, 1.0);
diffuseColor.rgb = mix(diffuseColor.rgb, hairColor * mix(0.6, 1.25, streak), hairMask);`)
      .replace('#include <opaque_fragment>', `vec3 V = normalize(vViewPosition);
vec3 H = normalize(vL + V);
float tdh = dot(normalize(vT), H);
float sinTH = sqrt(max(0.0, 1.0 - tdh * tdh));
// only where there is hair: the blend into the skin at the hairline stays skin
float spec = (pow(sinTH, 90.0) * 0.22 + pow(sinTH, 18.0) * 0.06) * hairMask * gloss;
outgoingLight += vec3(spec) * mix(0.5, 1.0, streak) * diffuseColor.rgb * 6.0 + vec3(pow(sinTH, 90.0) * 0.05 * hairMask * gloss);
#include <opaque_fragment>`)
  }
  return m
}

/** How much of the male textured top a scalp point is under (head-local x, y above the eyes, z). */
function topWeight(x: number, y: number, z: number, headH: number) {
  return smooth01((y - headH * 0.36) / (headH * 0.42)) * (Math.atan2(x, z) ** 2 < 2.6 ? 1 : 0.4)
}

/** Random points on the shell faces, by area, with the scalp position, normal and hairline height there. */
class RootSampler {
  private readonly cum: number[] = []
  constructor(
    private readonly verts: number[],
    private readonly faces: number[],
    private readonly pos: Float32Array,
    private readonly nrm: Float32Array,
    private readonly above: Float32Array,
    private readonly thick: number[],
  ) {
    let t = 0
    for (let f = 0; f < faces.length; f += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => this.p(verts[faces[f + k]]))
      t += Math.hypot(...cross(sub(b, a), sub(c, a))) / 2
      this.cum.push(t)
    }
  }
  private p(v: number): V3 {
    return [this.pos[v * 3], this.pos[v * 3 + 1], this.pos[v * 3 + 2]]
  }
  sample(r: () => number) {
    const x = r() * this.cum[this.cum.length - 1]
    let lo = 0, hi = this.cum.length - 1
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.cum[m] < x) lo = m + 1; else hi = m }
    let u = r(), w = r()
    if (u + w > 1) { u = 1 - u; w = 1 - w }
    const ids = [0, 1, 2].map((k) => this.faces[lo * 3 + k])
    const bw = [1 - u - w, u, w]
    const mix = (get: (i: number) => number) => ids.reduce((t, i, k) => t + get(i) * bw[k], 0)
    const vs = ids.map((i) => this.verts[i])
    const p: V3 = [0, 1, 2].map((k) => mix((i) => this.pos[this.verts[i] * 3 + k])) as V3
    const n = norm([0, 1, 2].map((k) => mix((i) => this.nrm[this.verts[i] * 3 + k])) as V3)
    return { p, n, root: vs[bw.indexOf(Math.max(...bw))], above: mix((i) => this.above[this.verts[i]]), thick: mix((i) => this.thick[i]) }
  }
}

/**
 * Sleek hair combed back into a low bun: strands rise from the scalp (thinning out over the last
 * centimetre to the hairline), run over it a few millimetres up, in layers, towards the bun and
 * tuck under it; the bun itself is strands coiled round a twisted knot.
 */
function growSleek(f: HeadFrame, grid: ScalpGrid, roots: RootSampler, bun: V3): Strand[] {
  const r = rng(7)
  const out: Strand[] = []
  const headH = f.topY - f.eyeY
  const centre: V3 = [f.cx, f.eyeY + headH * 0.25, f.cz]
  for (let tries = 0; out.length < 4600 && tries < 40000; tries++) {
    const s = roots.sample(r)
    // fewer strands right at the hairline: a soft edge, not a painted line
    if (s.above < 0 || r() > smooth01(s.above / 0.012) * 0.85 + 0.15 * smooth01(s.above / 0.004)) continue
    const crown = smooth01((s.p[1] - f.eyeY - headH * 0.3) / (headH * 0.6))
    let h = 0.0015 + r() * 0.003 + crown * 0.002
    // no stray strands: lifted off the surface they drew loops off the crown, and the guides' sleek
    // styles have none
    r()
    let p: V3 = add(s.p, scale(s.n, 0.0005))
    let n = s.n
    const pts: V3[] = [p]
    const wob = 0.35 * Math.sin(s.p[0] * 210 + s.p[1] * 90) + (r() - 0.5) * 0.15
    const phase = s.p[0] * 160 + s.p[2] * 120
    let len = 0
    for (let k = 0; k < 40; k++) {
      const toBun = sub(bun, p)
      if (Math.hypot(...toBun) < 0.034) break
      // along the great circle over the head from here to the bun (heading straight for the bun
      // combed the front hair down the forehead first): straight back over the crown from the
      // front, back above the ears at the sides, up from the nape
      const pc = sub(p, centre), bc = sub(bun, centre)
      let d = norm(tangent(cross(cross(pc, bc), pc), n))
      // a slight, slow sway across the comb direction, shared by neighbouring strands so the
      // hair lies in locks
      d = norm(add(d, scale(cross(n, d), wob * Math.sin(phase + len * 30) * 0.15)))
      p = add(p, scale(d, 0.009))
      len += 0.009
      n = grid.lift(p, 0.0005 + (h - 0.0005) * smooth01(len / 0.025))
      pts.push([...p] as V3)
    }
    if (pts.length > 2) out.push({ points: pts, root: s.root, width: 0.0006, tint: 0.78 + r() * 0.4 })
  }
  // the bun: strands wound ~1¼ turns round a torus lying against the head, twisting as they go
  const root = roots.sample(rng(3)).root
  const R = 0.028, rt = 0.022
  for (let i = 0; i < 1800; i++) {
    const a0 = r() * Math.PI * 2, b0 = r() * Math.PI * 2
    const rr = rt * (0.9 + r() * 0.14)
    const turns = 1.1 + r() * 0.4
    const pts: V3[] = []
    for (let k = 0; k <= 26; k++) {
      const a = a0 + (k / 26) * turns * Math.PI * 2
      const b = b0 + (a - a0) * 0.45
      const ring = R + rr * Math.cos(b)
      pts.push([bun[0] + ring * Math.cos(a) * 1.05, bun[1] + ring * Math.sin(a) * 0.84, bun[2] - 0.012 - rr * Math.sin(b) * 0.9])
    }
    out.push({ points: pts, root, width: 0.0006, tint: 0.72 + r() * 0.4 })
  }
  return out
}

/**
 * Fade with a textured top: on top, short strands (1–3.5 cm) rise off the scalp, combed forward
 * and up in clumps that curve over; lower down, stubble strands a few millimetres long lie down
 * the head, sparser towards the bottom of the fade.
 */
function growCrop(f: HeadFrame, roots: RootSampler): Strand[] {
  const r = rng(11)
  const out: Strand[] = []
  const headH = f.topY - f.eyeY
  const local = (p: V3) => [p[0] - f.cx, p[1] - f.eyeY, p[2] - f.cz] as const
  let top = 0, stubble = 0
  for (let tries = 0; (top < 6000 || stubble < 12000) && tries < 120000; tries++) {
    const s = roots.sample(r)
    if (s.above < 0.001) continue
    const [x, y, z] = local(s.p)
    const w = topWeight(x, y, z, headH) * smooth01(s.above / 0.01)
    if (w > 0.25 && top < 6000 && r() < w) {
      top++
      // comb forward and up, turned this way and that by the clump it is in
      const clump = waves(x, y, z) * 0.8 + (r() - 0.5) * 0.5
      let comb = norm(tangent([0, 0.35, 1], s.n))
      const side = cross(s.n, comb)
      comb = norm(add(scale(comb, Math.cos(clump)), scale(side, Math.sin(clump))))
      let d = norm(add(scale(s.n, 0.55), scale(comb, 0.45)))
      const L = (0.01 + 0.025 * w) * (0.75 + r() * 0.5)
      let p: V3 = add(s.p, scale(s.n, s.thick * 0.7))
      const pts: V3[] = [p]
      const curl = (r() - 0.5) * 0.6
      for (let k = 0; k < 7; k++) {
        // bends over under its own weight and curls a little
        d = norm(add(d, add(scale(comb, 0.16), add([0, -0.06, 0], scale(cross(d, s.n), curl * 0.2)))))
        p = add(p, scale(d, L / 7))
        const lift = dot(sub(p, s.p), s.n)
        if (lift < 0.003) p = add(p, scale(s.n, 0.003 - lift))
        pts.push(p)
      }
      out.push({ points: pts, root: s.root, width: 0.0007, tint: 0.75 + r() * 0.45 })
    } else if (stubble < 12000) {
      // stubble, denser up the fade
      const dense = 0.3 + 0.7 * smooth01((y - headH * 0.05) / (headH * 0.5))
      if (r() > dense) continue
      stubble++
      const L = 0.0015 + 0.005 * dense
      const d = norm(add(scale(norm(tangent([0, -1, -0.3], s.n)), 0.8), scale(s.n, 0.35)))
      const p: V3 = add(s.p, scale(s.n, 0.0007))
      out.push({ points: [p, add(p, scale(d, L / 2)), add(p, scale(d, L))], root: s.root, width: 0.00035, tint: 0.7 + r() * 0.4 })
    }
  }
  return out
}

/**
 * Afro / short coils: thousands of tightly coiled strands springing off the outside of the thick shell,
 * which gives the mass its rounded volume; the coils give its edge the fuzz of real coily hair.
 */
function growAfro(roots: RootSampler): Strand[] {
  const r = rng(23)
  const out: Strand[] = []
  for (let tries = 0; out.length < 16000 && tries < 90000; tries++) {
    const s = roots.sample(r)
    if (s.above < 0.002) continue
    // out from the shell's surface, tipped a little this way and that
    const t = norm(tangent([r() - 0.5, r() - 0.5, r() - 0.5], s.n))
    const axis = norm(add(s.n, scale(t, 0.5 * r())))
    const side = norm(cross(axis, t)), up = cross(side, axis)
    const L = 0.003 + 0.005 * r(), R = 0.001 + 0.0006 * r(), turns = 1.5 + r()
    const base = add(s.p, scale(s.n, s.thick * 0.88))
    const pts: V3[] = []
    for (let k = 0; k <= 8; k++) {
      const a = (k / 8) * turns * Math.PI * 2 + r() * 0.3
      pts.push(add(add(base, scale(axis, (L * k) / 8)), add(scale(side, R * Math.cos(a)), scale(up, R * Math.sin(a)))))
    }
    out.push({ points: pts, root: s.root, width: 0.0005, tint: 0.65 + r() * 0.55 })
  }
  return out
}

/**
 * Braids: cornrows running from the front hairline over the head to the nape, each three strands woven
 * round one another, then hanging down the back as loose braids (as in the owner's reference photo).
 */
function growBraids(f: HeadFrame, pos: Float32Array, nrm: Float32Array, verts: number[], above: Float32Array, body: BodySet): Strand[] {
  const r = rng(31)
  const out: Strand[] = []
  const headH = f.topY - f.eyeY
  const cy = f.eyeY + headH * 0.15
  // the scalp's vertices above the hairline, for laying each row on it
  const scalp = verts.filter((v) => above[v] > -0.002)
  const halfW = Math.max(...scalp.map((v) => Math.abs(pos[v * 3] - f.cx)))
  const rows = 9
  for (let i = 0; i < rows; i++) {
    const x = f.cx + (((i + 0.5) / rows) * 2 - 1) * halfW * 0.86
    // The row's line over the scalp: the scalp vertices in a thin slice at x, ordered by their angle round
    // the head from the forehead over the crown to the nape, keeping the outermost one every 3°. (Searching
    // for the furthest vertex in each direction lost most rows.)
    const slice = scalp.filter((v) => Math.abs(pos[v * 3] - x) < 0.009 && above[v] > 0.003)
    const bins = new Map<number, number>()
    for (const v of slice) {
      const dy = pos[v * 3 + 1] - cy, dz = pos[v * 3 + 2] - f.cz
      const k = Math.round(Math.atan2(dy, dz) * 180 / Math.PI / 3)
      const prev = bins.get(k)
      if (prev === undefined || Math.hypot(dy, dz) > Math.hypot(pos[prev * 3 + 1] - cy, pos[prev * 3 + 2] - f.cz)) bins.set(k, v)
    }
    const path: { p: V3; n: V3; v: number }[] = []
    // angles run from the front (small) up over the top (90°) to the back and down (past 180°)
    const order = [...bins.entries()].map(([k, v]) => [k < -30 ? k + 120 : k, v] as const).sort((a, b) => a[0] - b[0])
    for (const [, v] of order) {
      const n: V3 = [nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]]
      const p: V3 = [x, pos[v * 3 + 1], pos[v * 3 + 2]]
      if (path.length && Math.hypot(...sub(p, path[path.length - 1].p)) < 0.004) continue
      path.push({ p: add(p, scale(n, 0.003)), n, v })
    }
    if (path.length < 4) continue
    // hanging braids: from the nape, down the back of the neck and shoulders, standing off the skin
    const end = path[path.length - 1]
    const hang = 0.12 + 0.1 * r()
    for (let k = 1; k <= 12; k++) {
      const p: V3 = add(end.p, [0, -hang * (k / 12), -0.01 - 0.012 * (k / 12)])
      path.push({ p, n: [0, 0, -1], v: end.v })
    }
    // three strands woven round the row's line
    let along = 0
    for (let phase = 0; phase < 3; phase++) {
      const pts: V3[] = []
      along = 0
      for (let k = 0; k < path.length; k++) {
        const a = path[k], b = path[Math.min(path.length - 1, k + 1)], z = path[Math.max(0, k - 1)]
        const t = norm(sub(b.p, z.p)), side = norm(cross(t, a.n))
        if (k) along += Math.hypot(...sub(a.p, path[k - 1].p))
        const th = (along / 0.012) * Math.PI * 2 + (phase * Math.PI * 2) / 3
        pts.push(add(a.p, add(scale(side, 0.0035 * Math.cos(th)), scale(a.n, 0.0018 * (Math.sin(th) + 1)))))
      }
      out.push({ points: pts, root: end.v, width: 0.0032, tint: 0.8 + r() * 0.3 })
    }
  }
  void body
  return out
}
