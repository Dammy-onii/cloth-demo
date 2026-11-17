// Hair strands: polylines grown from the scalp, drawn as thin ribbons that turn to face the camera
// (in the vertex shader) and lit along their length (Kajiya–Kay), darker towards the root.

import * as THREE from 'three'

export type V3 = [number, number, number]

/** The scalp the strands grow on: its vertices (body indices), positions and normals at rest. */
export interface Scalp {
  verts: number[]
  pos: Float32Array
  nrm: Float32Array
}

export interface Strand {
  points: V3[]
  /** body vertex the strand moves with */
  root: number
  width: number
  /** colour multiplier */
  tint: number
  /** own colour, instead of the mesh's (eyebrows, lashes) */
  color?: THREE.Color
}

/** Deterministic random numbers (mulberry32), so a body always gets the same hair. */
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Nearest scalp vertex by a uniform grid (cells of 1.5 cm), searched outward. */
export class ScalpGrid {
  private readonly cells = new Map<string, number[]>()
  constructor(private readonly s: Scalp, private readonly cell = 0.015) {
    s.verts.forEach((v, i) => {
      const k = this.key(s.pos[v * 3], s.pos[v * 3 + 1], s.pos[v * 3 + 2])
      if (!this.cells.has(k)) this.cells.set(k, [])
      this.cells.get(k)!.push(i)
    })
  }
  private key(x: number, y: number, z: number) {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)},${Math.floor(z / this.cell)}`
  }
  /** index into `verts` of the nearest scalp vertex */
  nearest(p: V3) {
    const { pos, verts } = this.s
    const c = p.map((q) => Math.floor(q / this.cell))
    let best = 0, bestD = Infinity
    for (let r = 1; r < 6 && bestD === Infinity; r++)
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++)
        for (const s of this.cells.get(`${c[0] + i},${c[1] + j},${c[2] + k}`) ?? []) {
          const v = verts[s]
          const d = (pos[v * 3] - p[0]) ** 2 + (pos[v * 3 + 1] - p[1]) ** 2 + (pos[v * 3 + 2] - p[2]) ** 2
          if (d < bestD) { bestD = d; best = s }
        }
    return best
  }
  /** `p` moved to `h` m above the scalp along the nearest vertex's normal; returns that normal */
  lift(p: V3, h: number): V3 {
    const { pos, nrm, verts } = this.s
    const v = verts[this.nearest(p)]
    const n: V3 = [nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]]
    const d = (p[0] - pos[v * 3]) * n[0] + (p[1] - pos[v * 3 + 1]) * n[1] + (p[2] - pos[v * 3 + 2]) * n[2]
    for (let k = 0; k < 3; k++) p[k] -= n[k] * (d - h)
    return n
  }
}

export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const norm = (a: V3): V3 => scale(a, 1 / (Math.hypot(...a) || 1))
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
/** `d` with its component along `n` removed */
export const tangent = (d: V3, n: V3): V3 => sub(d, scale(n, dot(d, n)))

/**
 * Ribbon geometry for the strands: two vertices per point (side ±1), offset sideways in the shader.
 */
export class StrandMesh {
  private centre = new Float32Array(0)
  private roots = new Uint32Array(0)
  constructor(readonly geometry: THREE.BufferGeometry) {}

  build(strands: Strand[], color: THREE.Color) {
    const count = strands.reduce((t, s) => t + s.points.length, 0)
    const pos = new Float32Array(count * 6), tan = new Float32Array(count * 6), side = new Float32Array(count * 2)
    const width = new Float32Array(count * 2), shade = new Float32Array(count * 2), col = new Float32Array(count * 6)
    const roots = new Uint32Array(count * 2)
    const index: number[] = []
    let o = 0
    for (const s of strands) {
      const n = s.points.length
      for (let i = 0; i < n; i++) {
        const p = s.points[i], q = s.points[Math.min(n - 1, i + 1)], r = s.points[Math.max(0, i - 1)]
        const t = norm(sub(q, r))
        const u = i / (n - 1)
        for (let k = 0; k < 2; k++) {
          const w = o * 2 + k
          pos.set(p, w * 3)
          tan.set(t, w * 3)
          side[w] = k ? 1 : -1
          width[w] = s.width * (1 - 0.6 * u * u) // tapers to the tip
          // darker in at the root (light doesn't reach under the other hair)
          shade[w] = 0.5 + 0.5 * Math.min(1, u * 2.5)
          const c = s.color ?? color
          col[w * 3] = c.r * s.tint
          col[w * 3 + 1] = c.g * s.tint
          col[w * 3 + 2] = c.b * s.tint
          roots[w] = s.root
        }
        if (i < n - 1) {
          const a = o * 2
          index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
        }
        o++
      }
    }
    const g = this.geometry
    g.setIndex(index)
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('strandTangent', new THREE.BufferAttribute(tan, 3))
    g.setAttribute('strandSide', new THREE.BufferAttribute(side, 1))
    g.setAttribute('strandWidth', new THREE.BufferAttribute(width, 1))
    g.setAttribute('strandShade', new THREE.BufferAttribute(shade, 1))
    g.setAttribute('color', new THREE.BufferAttribute(col, 3))
    // lit as a soft volume: normals point out from the head's centre
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(pos.length), 3))
    this.centre = pos.slice()
    this.roots = roots
    g.computeBoundingSphere()
  }

  /** Normals out from `c` (the head centre). */
  aim(c: V3) {
    const pos = this.geometry.getAttribute('position').array as Float32Array
    const nrm = this.geometry.getAttribute('normal').array as Float32Array
    for (let i = 0; i < pos.length; i += 3) {
      const d = norm([pos[i] - c[0], pos[i + 1] - c[1], pos[i + 2] - c[2]])
      nrm[i] = d[0]; nrm[i + 1] = d[1]; nrm[i + 2] = d[2]
    }
  }

  /** Follow the body: each point moves as its root vertex has moved since the strands were grown. */
  move(rest: Float32Array, now: Float32Array) {
    const attr = this.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
    if (!attr) return
    const pos = attr.array as Float32Array
    const c = this.centre, r = this.roots
    for (let w = 0; w < r.length; w++) {
      const v = r[w] * 3
      pos[w * 3] = c[w * 3] + now[v] - rest[v]
      pos[w * 3 + 1] = c[w * 3 + 1] + now[v + 1] - rest[v + 1]
      pos[w * 3 + 2] = c[w * 3 + 2] + now[v + 2] - rest[v + 2]
    }
    attr.needsUpdate = true
    this.geometry.computeBoundingSphere()
  }
}

/** Strand material: camera-facing ribbons, a primary white and a secondary tinted highlight along the strand. */
export function strandMaterial() {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0, side: THREE.DoubleSide })
  m.userData.gloss = { value: 1 }
  m.onBeforeCompile = (shader) => {
    shader.uniforms.keyDir = { value: new THREE.Vector3(2.2, 4.2, 3).normalize() }
    shader.uniforms.gloss = m.userData.gloss
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 strandTangent;
attribute float strandSide;
attribute float strandWidth;
attribute float strandShade;
uniform vec3 keyDir;
varying vec3 vT;
varying vec3 vL;
varying float vShade;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
// turn the ribbon to face the camera (the mesh sits at the world origin)
vec3 toCam = normalize(cameraPosition - transformed);
transformed += normalize(cross(strandTangent, toCam)) * strandWidth * strandSide;
vT = normalize((modelViewMatrix * vec4(strandTangent, 0.0)).xyz);
vL = normalize((viewMatrix * vec4(keyDir, 0.0)).xyz);
vShade = strandShade;`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float gloss;
varying vec3 vT;
varying vec3 vL;
varying float vShade;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
diffuseColor.rgb *= vShade;`)
      .replace('#include <opaque_fragment>', `vec3 V = normalize(vViewPosition);
vec3 T = normalize(vT);
// primary highlight (white, along the cuticle) and secondary (tinted, shifted towards the root)
float t1 = dot(T, normalize(vL + V));
float t2 = dot(normalize(T + 0.12 * vec3(0.0, 1.0, 0.0)), normalize(vL + V));
float s1 = pow(sqrt(max(0.0, 1.0 - t1 * t1)), 120.0);
float s2 = pow(sqrt(max(0.0, 1.0 - t2 * t2)), 30.0);
outgoingLight += (vec3(s1) * 0.07 + s2 * diffuseColor.rgb * 2.2) * vShade * gloss;
#include <opaque_fragment>`)
  }
  return m
}
