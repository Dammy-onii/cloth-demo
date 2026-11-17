// The person under the clothes: skin tone with natural variation and shaded eyes, and sneakers.
import * as THREE from 'three'
import type { BodySet, Size } from '../body/bodySet'

/** Skin tones, deep to fair: [label, sRGB colour] */
export const SKIN_TONES: [string, string][] = [
  ['Deep', '#3f281d'], ['Dark', '#5e3b2a'], ['Brown', '#7d5039'], ['Tan', '#9a6a4f'],
  ['Medium', '#b8866a'], ['Light', '#cfa186'], ['Fair', '#e3c0a8'], ['Pale', '#f0d9c8'],
]
const SCLERA = new THREE.Color('#e6e1d9')
const IRIS = new THREE.Color('#3d2619')
const PUPIL = new THREE.Color('#0b0908')
// tints mixed into the base tone: blood showing through (lips, cheeks, ears, knees, elbows), and
// the lighter, pinker palms
const FLUSH = new THREE.Color('#b0433a')
const PALM = new THREE.Color('#e9b8a2')
// default underwear, painted on the skin (see underwear())
const UNDERWEAR = new THREE.Color('#2e2c2f')

// Value noise in object space for the skin shader: low-frequency mottling of the colour and a
// fine pore-scale bump, so the skin isn't one flat painted colour.
const NOISE_GLSL = /* glsl */ `
float skinHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float skinNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(skinHash(i), skinHash(i + vec3(1,0,0)), f.x), mix(skinHash(i + vec3(0,1,0)), skinHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(skinHash(i + vec3(0,0,1)), skinHash(i + vec3(1,0,1)), f.x), mix(skinHash(i + vec3(0,1,1)), skinHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
varying vec3 vSkinPos;`

/**
 * Skin: soft and matte with a faint sheen on the high points, and light that seems to pass through
 * it: a warm red glow where light rolls off into shadow and at thin edges (ears, nose), as real
 * skin scatters light under its surface; without it, shadows on the skin went flat grey.
 */
export function skinMaterial() {
  const m = new THREE.MeshPhysicalMaterial({
    // a little glossier than first tuned: next to the guides' skin, with its highlights on the
    // forehead, nose and cheekbones, ours read as matte plastic
    vertexColors: true, roughness: 0.46, sheen: 0.25, sheenRoughness: 0.6, sheenColor: new THREE.Color('#d9a090'),
    clearcoat: 0.22, clearcoatRoughness: 0.36,
  })
  // underwear uniforms: set by Stage from underwearShape()
  const uw = { uwA: { value: new THREE.Vector4() }, uwB: { value: new THREE.Vector4() }, uwBL: { value: new THREE.Vector3() }, uwBR: { value: new THREE.Vector3() }, uwColor: { value: UNDERWEAR.clone() }, uwStraps: { value: 1 },
    // a photo painted on the face (src/face/paint.ts): facePhoto per vertex is its place in the photo (u, v) and weight
    faceMap: { value: null as THREE.Texture | null }, faceOn: { value: 0 } }
  m.userData.underwear = uw
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uw)
    shader.uniforms.keyDir = { value: new THREE.Vector3(2.2, 4.2, 3).normalize() }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSkinPos;\nvarying vec3 vKey;\nuniform vec3 keyDir;\nattribute float covered;\nattribute vec3 restPos;\nvarying vec3 vRest;\nattribute vec3 facePhoto;\nvarying vec3 vFace;')
      // skin under worn clothes sinks 5 mm (see Stage.markCovered), so it never draws through them
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed -= objectNormal * covered * 0.005;\nvSkinPos = position;\nvRest = restPos;\nvFace = facePhoto;\nvKey = normalize((viewMatrix * vec4(keyDir, 0.0)).xyz);')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE_GLSL}\n${UNDERWEAR_GLSL}\nvarying vec3 vKey;\nvarying vec3 vFace;\nuniform sampler2D faceMap;\nuniform float faceOn;`)
      // mottling: brightness ±3% over a few cm and ±2% over ~1 cm, and a faint shift between
      // redder and more yellow patches
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= 1.0 + 0.06 * (skinNoise(vSkinPos * 30.0) - 0.5) + 0.04 * (skinNoise(vSkinPos * 110.0) - 0.5);
        diffuseColor.rgb *= mix(vec3(1.0), vec3(1.035, 0.975, 0.96), skinNoise(vSkinPos * 18.0 + 7.0));
        // the user's own face, painted from their photo where it was fitted (the toggle in the app)
        if (faceOn > 0.0 && vFace.z > 0.0) diffuseColor.rgb = mix(diffuseColor.rgb, texture2D(faceMap, vFace.xy).rgb, vFace.z * faceOn);
        uwMask = underwearAt(vRest);
        diffuseColor.rgb = mix(diffuseColor.rgb, uwColor, uwMask);`)
      // the underwear is matte fabric: no skin gloss, sheen or scattering on it
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.85, uwMask);')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_CLEARCOAT\nmaterial.clearcoat *= 1.0 - uwMask;\n#endif\n#ifdef USE_SHEEN\nmaterial.sheenColor *= 1.0 - 0.6 * uwMask;\n#endif')
      .replace('#include <opaque_fragment>', `{
          // under-surface scattering, approximated: a warm band at the light's terminator and a
          // thin-edge glow towards grazing angles, both in the skin's own (deepened) colour
          vec3 N = normalize(normal), V = normalize(vViewPosition);
          float nl = dot(N, vKey);
          float band = smoothstep(-0.35, 0.15, nl) * (1.0 - smoothstep(0.15, 0.7, nl));
          float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
          vec3 deep = diffuseColor.rgb * vec3(1.25, 0.55, 0.42);
          outgoingLight += deep * (0.22 * band + 0.1 * rim) * (1.0 - uwMask);
        }
        #include <opaque_fragment>`)
      // pores: bump the normal by the screen-space gradient of a ~1 mm noise (as three's bump map does)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          // fine and gentle: a stronger, coarser bump read as orange peel in close-ups
          float h = 0.35 * skinNoise(vSkinPos * 1100.0) + 0.65 * skinNoise(vSkinPos * 2600.0);
          vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition);
          vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
          float det = dot(dpdx, r1);
          vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2) * 0.00009 * (1.0 - uwMask);
          normal = normalize(abs(det) * normal - grad);
        }`)
  }
  return m
}

const gauss = (d2: number, r: number) => Math.exp(-d2 / (r * r))

/**
 * Per-vertex colour: the skin tone with natural variation, from the A-pose: flushed lips, cheeks,
 * ears, knees and elbows, lighter palms; the eyeballs get sclera, iris and pupil by the angle from
 * each eye's centre against the forward axis (+z). Face landmarks are placed from the eyes.
 */
export function skinColors(body: BodySet, size: Size, tone: string, out: Float32Array = new Float32Array(body.vertexCount * 3)) {
  const base = new THREE.Color(tone)
  const pos = body.positions(size, 'apose')
  const J = body.joints(size, 'apose')
  const normals = computeNormals(pos, body.index)
  const seg = (name: string) => body.segment(name)
  const eye = seg('eye')
  const eyes = [1, -1].map((side) => {
    const ids = [...body.labels.keys()].filter((v) => body.labels[v] === eye && pos[v * 3] * side > 0)
    return { ids, c: [0, 1, 2].map((k) => ids.reduce((t, v) => t + pos[v * 3 + k], 0) / Math.max(ids.length, 1)) }
  })
  const hasEyes = eyes.every((e) => e.ids.length)
  const mid = hasEyes ? [0, 1, 2].map((k) => (eyes[0].c[k] + eyes[1].c[k]) / 2) : [0, 0, 0]
  const eyeX = hasEyes ? Math.abs(eyes[0].c[0]) : 0.032
  // the mouth: the most forward point of the face 5–11 cm below the eyes (the lips stand out
  // there). A fixed drop below the eyes missed them, and the lip tint landed on the chin.
  const mouth = [0, mid[1] - 0.068, mid[2] + 0.012]
  if (hasEyes) {
    let front = -Infinity
    for (let v = 0; v < body.vertexCount; v++) {
      if (body.labels[v] !== seg('head') || Math.abs(pos[v * 3]) > 0.012) continue
      const y = pos[v * 3 + 1], z = pos[v * 3 + 2]
      if (y < mid[1] - 0.11 || y > mid[1] - 0.05 || z <= front) continue
      front = z; mouth[1] = y; mouth[2] = z - 0.006
    }
  }
  const hipY = (J['upperleg01.L'][1] + J['upperleg01.R'][1]) / 2
  const kneeY = 0.52 * hipY
  const elbows = ['lowerarm01.L', 'lowerarm01.R'].map((j) => J[j])
  const c = new THREE.Color()
  // lips: the skin tone deepened and pulled towards rose (mauve on deep tones, pink on fair)
  const lipTone = base.clone().multiply(new THREE.Color(0.72, 0.5, 0.52)).lerp(FLUSH, 0.2)
  for (let v = 0; v < body.vertexCount; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2]
    const label = body.labels[v]
    let flush = 0, palm = 0, lip = 0, lid = 0
    if (hasEyes && label === seg('head')) {
      // lips get their own deeper tone: a flush alone left them the colour of the face
      // upper and lower lip, below the most forward point, and only where they stand forward of
      // the face: one wide patch tinted the skin between nose and mouth and missed the lower lip
      lip = Math.max(...[0.003, 0.016].map(drop => gauss(((x - mouth[0]) / 2.2) ** 2 + (y - mouth[1] + drop) ** 2, 0.0085))) * smooth01((z - mouth[2] + 0.02) / 0.008)
      flush += 0.3 * lip
      // a little shade in the upper lid crease and the inner corners gives the eyes depth
      for (const s of [1, -1]) lid += gauss(((x - s * eyeX) / 1.6) ** 2 + (y - mid[1] - 0.008) ** 2, 0.012) * (z > mid[2] - 0.03 ? 1 : 0)
      for (const s of [1, -1]) flush += 0.12 * gauss((x - s * eyeX * 1.25) ** 2 + (y - mid[1] + 0.035) ** 2, 0.025) * (z > mid[2] - 0.04 ? 1 : 0)
      // faded in over 2 cm: as a hard step it drew a vertical line down each cheek
      flush += 0.12 * smooth01((Math.abs(x) - eyeX - 0.025) / 0.02) * smooth01((mid[2] - 0.02 - z) / 0.02)
    }
    if (label === seg('upperleg') || label === seg('lowerleg')) flush += 0.08 * gauss((y - kneeY) ** 2, 0.04) * (normals[v * 3 + 2] > 0.3 ? 1 : 0)
    if (label === seg('upperarm') || label === seg('forearm'))
      for (const e of elbows) flush += 0.08 * gauss((x - e[0]) ** 2 + (y - e[1]) ** 2 + (z - e[2]) ** 2, 0.035) * (normals[v * 3 + 2] < -0.2 ? 1 : 0)
    // A-pose palms face down and in
    if (label === seg('hand') && normals[v * 3 + 1] < -0.35) palm = 0.35
    c.copy(base).lerp(FLUSH, Math.min(flush, 0.6) * 0.35).lerp(PALM, palm * (1 - base.getHSL({ h: 0, s: 0, l: 0 }).l))
    c.lerp(lipTone, Math.min(lip * 1.3, 1) * 0.8).multiplyScalar(1 - 0.12 * Math.min(lid, 1))
    c.toArray(out, v * 3)
  }
  for (const { ids, c: centre } of hasEyes ? eyes : []) {
    for (const v of ids) {
      const d = [0, 1, 2].map((k) => pos[v * 3 + k] - centre[k])
      const cos = d[2] / (Math.hypot(...d) || 1)
      ;(cos > 0.96 ? PUPIL : cos > 0.84 ? IRIS : SCLERA).toArray(out, v * 3)
    }
  }
  return out
}

/**
 * Default underwear, drawn by the skin shader (UNDERWEAR_GLSL) from each point's A-pose position:
 * briefs (high-cut on the female, short trunks on the male) and, on the female, a bra with a band and
 * straps. Shaded on the skin, not modelled: skin under clothes is drawn sunk, so the underwear sinks
 * with it and never shows through a garment. Painted per vertex, its edges zig-zagged between the
 * coarse body's vertices. This measures the body for the shader's uniforms.
 */
export function underwearShape(body: BodySet, size: Size) {
  const pos = body.positions(size, 'apose'), J = body.joints(size, 'apose'), n = body.vertexCount
  const torso = body.segment('torso')
  const hipY = (J['upperleg01.L'][1] + J['upperleg01.R'][1]) / 2
  const female = body.gender === 'female'
  let crotchY = Infinity, cz = 0, count = 0, hipHalf = 0
  for (let v = 0; v < n; v++) {
    if (body.labels[v] !== torso) continue
    const x = pos[v * 3], y = pos[v * 3 + 1]
    if (Math.abs(x) < 0.02) crotchY = Math.min(crotchY, y)
    if (Math.abs(y - hipY) < 0.03) { cz += pos[v * 3 + 2]; count++; hipHalf = Math.max(hipHalf, Math.abs(x)) }
  }
  cz /= Math.max(count, 1)
  const bust = [1, -1].map(side => {
    let b = -1
    for (let v = 0; v < n; v++) {
      if (!female || body.labels[v] !== torso || pos[v * 3] * side <= 0) continue
      const y = pos[v * 3 + 1]
      if (y < hipY + 0.25 || y > hipY + 0.45) continue
      if (b < 0 || pos[v * 3 + 2] > pos[b * 3 + 2]) b = v
    }
    return b < 0 ? new THREE.Vector3(side * 0.09, hipY + 0.35, 0.1) : new THREE.Vector3(pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2])
  })
  // the band's half width: the chest under the bust
  let chestHalf = 0
  for (let v = 0; v < n; v++) if (body.labels[v] === torso && Math.abs(pos[v * 3 + 1] - (bust[0].y - 0.08)) < 0.015) chestHalf = Math.max(chestHalf, Math.abs(pos[v * 3]))
  return {
    a: new THREE.Vector4(hipY, crotchY, cz, hipY + (female ? 0.07 : 0.06)),
    // cup radius grows with the chest: fixed at the M size, XL cups left a crescent of skin at the sides
    b: new THREE.Vector4(female ? 1 : 0, hipHalf + 0.012, chestHalf + 0.006, Math.min(0.1, Math.max(0.07, chestHalf * 0.56))),
    bustL: bust[0], bustR: bust[1],
  }
}

/** Underwear mask (0..1) at an A-pose position, with crisp 3 mm edges. Uniforms from underwearShape. */
const UNDERWEAR_GLSL = /* glsl */ `
uniform vec4 uwA; // hip height, crotch height, hip depth centre, briefs top
uniform vec4 uwB; // female, hip half width, chest half width, cup radius
uniform vec3 uwBL, uwBR; // bust points
uniform vec3 uwColor;
uniform float uwStraps; // 0 under strapless and off-shoulder clothes: a bandeau bra
varying vec3 vRest;
float uwMask;
float uwEdge(float d) { return smoothstep(-0.0015, 0.0015, d); }
float underwearAt(vec3 p) {
  float x = abs(p.x), y = p.y;
  bool female = uwB.x > 0.5;
  // leg opening: dips to the crotch at the midline; on the female it rises towards the hip, higher
  // at the front than over the seat
  // (front and back cuts blended across the side: switched outright, the line stepped at the hip)
  float fb = smoothstep(-0.03, 0.03, p.z - uwA.z);
  float frontLeg = uwA.y - 0.006 + (uwA.x + 0.035 - uwA.y) * smoothstep(0.0, 1.0, (x - 0.035) / 0.12);
  float backLeg = uwA.y - 0.006 + (uwA.x - 0.02 - uwA.y) * smoothstep(0.0, 1.0, (x - 0.035) / 0.14);
  float leg = female ? mix(backLeg, frontLeg, fb) : uwA.y - 0.06;
  float m = min(min(uwEdge(uwA.w - y), uwEdge(y - leg)), uwEdge(uwB.y - x));
  if (female) for (int i = 0; i < 2; i++) {
    vec3 b = i == 0 ? uwBL : uwBR;
    // cup, the band under the bust, a strap over each shoulder
    // the cup wraps as far back as it is wide: a fixed depth left the sides of XL cups bare
    bool front = p.z > b.z - uwB.w * 1.25;
    // the cup: round above the bust point, full width down to the band below it (round all over,
    // it floated with skin between it and the band), joined to the other cup by a centre panel
    float cup = p.x * b.x > 0.0 && front ? uwEdge(uwB.w - length(vec3(p.xy - b.xy, (p.z - b.z) * 0.7))) : 0.0;
    float under = front ? min(min(uwEdge(b.y - y), uwEdge(y - b.y + 0.065)), uwEdge(uwB.w - 0.003 - abs(p.x - b.x))) : 0.0;
    float gore = front ? min(min(uwEdge(b.y - 0.015 - y), uwEdge(y - b.y + 0.065)), uwEdge(0.02 - x)) : 0.0;
    float band = min(min(uwEdge(y - (b.y - 0.1)), uwEdge(b.y - 0.06 - y)), uwEdge(uwB.z - x));
    // straps from the top of the cup, over the shoulder and down the back to the band
    float strap = uwStraps * min(min(uwEdge(y - (front ? b.y + 0.03 : b.y - 0.07)), uwEdge(b.y + 0.26 - y)), uwEdge(0.009 - abs(x - (abs(b.x) - 0.005))));
    cup = max(cup, max(under, gore));
    // a bandeau (no straps) under bare shoulders: just the cups below the bust line. Its band showed
    // through a dress's waist cut-out as a black strip
    cup *= mix(uwEdge(b.y + 0.01 - y) * uwEdge(y - b.y + 0.05), 1.0, uwStraps);
    band *= uwStraps;
    m = max(m, max(cup, max(band, strap)));
  }
  return m;
}`

function computeNormals(pos: Float32Array, index: Uint32Array) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  g.setIndex(new THREE.BufferAttribute(index, 1))
  g.computeVertexNormals()
  return g.getAttribute('normal').array as Float32Array
}

// Sneakers, built around each foot rather than shrink-wrapped onto it (the toes showed through as
// lumps): along the foot's length axis, rounded-box cross sections as wide as the foot plus the
// upper, on a midsole that flares out a little; a closed, rounded heel (an open heel ring let you
// see straight through the shoe from behind), a padded collar the ankle goes into, a tongue, lace
// bars over the vamp and a rounded toe box. Low white crew socks cover the ankle above them.
const FOOT_TOP = 0.06 // foot skin used to measure the foot (m above the floor)
const UPPER_ALLOWANCE = 0.009
const SOLE_HEIGHT = 0.026
const SOLE_FLARE = 0.004
const SLICES = 64
const SECTION = 24
const SOCK_TOP = 0.135
/** Sneaker colours. Every outfit wore the same white pair; a guide outfit can restyle them. */
export type ShoePalette = { upper: string; panel: string; sole: string; soleLine: string; laces: string }
export const WHITE_SNEAKERS: ShoePalette = { upper: '#f1f0ec', panel: '#e4e2dc', sole: '#ebe8e1', soleLine: '#8d877d', laces: '#dedad2' }
const SOCK = new THREE.Color('#f1f0ec')

const paletteColors = (p: ShoePalette) => ({ upper: new THREE.Color(p.upper), panel: new THREE.Color(p.panel), sole: new THREE.Color(p.sole), soleLine: new THREE.Color(p.soleLine), laces: new THREE.Color(p.laces) })

type Foot = { heel: number[]; axis: number[]; side: number[]; length: number; width: number; lift: number }

export class Shoes {
  private readonly feet: number[][]
  private colors = paletteColors(WHITE_SNEAKERS)
  set palette(p: ShoePalette) { this.colors = paletteColors(p) }
  /** sock shell: body vertices, faces (local), and how far each rest vertex sits above the sock top */
  private readonly sock: { verts: number[]; faces: number[]; over: number[] }

  /** Fills `geometry` (owned by the caller, so the mesh rendering it can stay the same object). */
  constructor(body: BodySet, size: Size, private readonly geometry: THREE.BufferGeometry) {
    const pos = body.positions(size, 'apose')
    const leg = body.segment('lowerleg')
    this.feet = [1, -1].map((s) => [...body.labels.keys()].filter((v) => body.labels[v] === leg && pos[v * 3 + 1] < FOOT_TOP && pos[v * 3] * s > 0))
    const local = new Int32Array(body.vertexCount).fill(-1)
    const verts: number[] = [], over: number[] = []
    for (let v = 0; v < body.vertexCount; v++)
      if (body.labels[v] === leg && pos[v * 3 + 1] < SOCK_TOP + 0.025) {
        local[v] = verts.length
        verts.push(v)
        over.push(Math.max(0, pos[v * 3 + 1] - SOCK_TOP))
      }
    const faces: number[] = []
    for (let t = 0; t < body.index.length; t += 3) {
      const a = local[body.index[t]], b = local[body.index[t + 1]], c = local[body.index[t + 2]]
      if (a >= 0 && b >= 0 && c >= 0) faces.push(a, b, c)
    }
    this.sock = { verts, faces, over }
  }

  /** Rebuild from the body as it is now. */
  update(body: Float32Array, normals?: Float32Array) {
    const p: number[] = [], c: number[] = [], idx: number[] = []
    if (normals) this.buildSock(body, normals, p, c, idx)
    for (const ids of this.feet) if (ids.length) this.build(measure(body, ids), p, c, idx)
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
    this.geometry.setAttribute('color', new THREE.Float32BufferAttribute(c, 3))
    this.geometry.setIndex(idx)
    this.geometry.computeVertexNormals()
    this.geometry.computeBoundingSphere()
  }

  /** The sock: the ankle skin pushed out 1.5 mm, its top row pulled down level to the cuff line. */
  private buildSock(body: Float32Array, normals: Float32Array, p: number[], col: number[], idx: number[]) {
    const base = p.length / 3
    const { verts, faces, over } = this.sock
    verts.forEach((v, i) => {
      const t = 0.0015
      p.push(body[v * 3] + normals[v * 3] * t, body[v * 3 + 1] + normals[v * 3 + 1] * t - over[i], body[v * 3 + 2] + normals[v * 3 + 2] * t)
      // a ribbed cuff band just under the top
      const y = body[v * 3 + 1] - over[i]
      ;(y > SOCK_TOP - 0.018 ? SOCK.clone().multiplyScalar(0.95) : SOCK).toArray(col, col.length)
    })
    for (const f of faces) idx.push(base + f)
  }

  /**
   * One shoe: a midsole slab (rounded-rectangle sections, flat walls) and the upper as an arch
   * over it, lofted along the foot. Both close to a point at the rounded heel and toe.
   */
  private build(f: Foot, p: number[], col: number[], idx: number[]) {
    const at = (along: number, x: number, y: number) =>
      [f.heel[0] + f.axis[0] * along + f.side[0] * x, y + f.lift, f.heel[2] + f.axis[2] * along + f.side[2] * x]
    const plan = (u: number) => {
      const heel = Math.sqrt(Math.max(0, 1 - (1 - Math.min(1, u / 0.12)) ** 2))
      const toe = u > 0.62 ? Math.sqrt(Math.max(0, 1 - ((u - 0.62) / 0.38) ** 4)) : 1
      // a smooth shoe last scaled to the foot (the foot's own slice widths are noisy and made the
      // sides ripple): narrow heel, widest at the ball, rounding off at the toe
      const last = 0.68 + 0.32 * smooth01((u - 0.06) / 0.58)
      return { w: ((f.width * last) / 2 + UPPER_ALLOWANCE) * heel * toe, end: Math.min(heel, toe) }
    }
    // upper height: heel counter, the collar line, the tongue over the instep, down to the toe box
    const keys: [number, number][] = [[0, 0.074], [0.2, 0.068], [0.34, 0.082], [0.55, 0.064], [0.8, 0.05], [1, 0.038]]
    const height = (u: number) => {
      for (let k = 1; k < keys.length; k++)
        if (u <= keys[k][0]) return keys[k - 1][1] + (keys[k][1] - keys[k - 1][1]) * smooth01((u - keys[k - 1][0]) / (keys[k][0] - keys[k - 1][0]))
      return keys[keys.length - 1][1]
    }
    const loft = (ring: (u: number) => { pts: number[][]; cols: THREE.Color[] }, closed: boolean, skip?: (u: number, j: number, n: number) => boolean) => {
      const base = p.length / 3
      let n = 0
      for (let i = 0; i <= SLICES; i++) {
        const u = i / SLICES
        const r = ring(u)
        n = r.pts.length
        r.pts.forEach((q, k) => { p.push(...q); r.cols[k].toArray(col, col.length) })
      }
      const m = closed ? n : n - 1
      for (let i = 0; i < SLICES; i++)
        for (let j = 0; j < m; j++) {
          if (skip?.((i + 0.5) / SLICES, j, n)) continue
          const a = base + i * n + j, b = base + i * n + ((j + 1) % n), c = a + n, d = b + n
          idx.push(a, c, b, b, c, d)
        }
    }
    const len = f.length + 0.03
    // midsole: a rounded-rectangle section, standing out a little from the upper
    loft((u) => {
      const { w, end } = plan(u)
      const W = w + SOLE_FLARE * end, H = SOLE_HEIGHT, rr = 0.007
      const along = -0.012 + u * len
      const pts: number[][] = [], cols: THREE.Color[] = []
      const corner = (cx: number, cy: number, a0: number) => {
        for (let k = 0; k <= 4; k++) {
          const a = a0 + (k / 4) * (Math.PI / 2)
          pts.push(at(along, cx + Math.cos(a) * Math.min(rr, W), cy + Math.sin(a) * rr))
          cols.push(cy + Math.sin(a) * rr > H - 0.004 ? this.colors.soleLine : this.colors.sole)
        }
      }
      corner(W - rr, rr, -Math.PI / 2)
      corner(W - rr, H - rr, 0)
      corner(-(W - rr), H - rr, Math.PI / 2)
      corner(-(W - rr), rr, Math.PI)
      return { pts, cols }
    }, true)
    // upper: an arch from one side of the midsole over the foot to the other
    loft(
      (u) => {
        const { w, end } = plan(u)
        const h = Math.max(SOLE_HEIGHT + 0.004, SOLE_HEIGHT + (height(u) - SOLE_HEIGHT) * Math.max(end, 0.5))
        const along = -0.012 + u * len
        const pts: number[][] = [], cols: THREE.Color[] = []
        for (let j = 0; j <= SECTION; j++) {
          const t = (j / SECTION) * Math.PI
          const ct = Math.cos(t), st = Math.sin(t)
          pts.push(at(along, Math.sign(ct) * Math.abs(ct) ** 0.55 * w, SOLE_HEIGHT - 0.003 + (h - SOLE_HEIGHT + 0.003) * st ** 0.55))
          const laces = st > 0.82 && u > 0.34 && u < 0.7
          cols.push(laces ? this.colors.laces : u > 0.84 || (u < 0.17 && st < 0.75) ? this.colors.panel : this.colors.upper)
        }
        return { pts, cols }
      },
      false,
      // the collar opening the ankle goes into
      (u, j, n) => u > 0.04 && u < 0.3 && Math.sin(((j + 0.5) / (n - 1)) * Math.PI) > 0.5,
    )
  }
}

const smooth01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t))

/** Heel point, length axis (horizontal, heel → toe), side axis, length and width per slice. */
function measure(body: Float32Array, ids: number[]): Foot {
  const xz = ids.map((v) => [body[v * 3], body[v * 3 + 2]])
  const m = [0, 1].map((k) => xz.reduce((t, q) => t + q[k], 0) / xz.length)
  // principal horizontal direction; the toes point forward (+z)
  let sxx = 0, sxz = 0, szz = 0
  for (const [x, z] of xz) { sxx += (x - m[0]) ** 2; sxz += (x - m[0]) * (z - m[1]); szz += (z - m[1]) ** 2 }
  const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz)
  let ax = [Math.cos(ang), Math.sin(ang)]
  if (ax[1] < 0) ax = [-ax[0], -ax[1]]
  const along = xz.map(([x, z]) => (x - m[0]) * ax[0] + (z - m[1]) * ax[1])
  const across = xz.map(([x, z]) => -(x - m[0]) * ax[1] + (z - m[1]) * ax[0])
  const lo = Math.min(...along), hi = Math.max(...along)
  const widths = Array.from({ length: 12 }, (_, k) => {
    const a = lo + ((k + 0.5) / 12) * (hi - lo)
    const near = across.filter((_, i) => Math.abs(along[i] - a) < (hi - lo) / 12)
    return near.length ? Math.max(...near) - Math.min(...near) : 0
  })
  const centre = across.reduce((t, q) => t + q, 0) / across.length
  // A bent knee lifts its foot. Built on the floor regardless, the shoe let the toes of the taller
  // bodies' forward foot rise out through the upper, so the shoe follows the foot's lowest point.
  let low = Infinity
  for (const v of ids) low = Math.min(low, body[v * 3 + 1])
  return {
    lift: Math.max(0, low - 0.004),
    heel: [m[0] + ax[0] * lo - ax[1] * centre, 0, m[1] + ax[1] * lo + ax[0] * centre],
    axis: [ax[0], 0, ax[1]], side: [-ax[1], 0, ax[0]], length: hi - lo,
    width: Math.max(...widths) || 0.09,
  }
}
