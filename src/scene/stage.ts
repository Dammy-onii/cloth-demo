// Imperative scene state shared by the React components: the animated mannequin and the cloth.
import * as THREE from 'three'
import type { BodySet, Pose, Size } from '../body/bodySet'
import { buildBottom, buildTop, type Garment, type UVMode } from '../cloth/buildGarment'
import type { Crop } from '../pattern/photoMap'
import { buildPattern, type PatternKind } from '../pattern'
import { baresShoulders, buildCustom, type CustomPhoto } from '../pattern/custom'
import type { GarmentRead } from '../cloth/garmentRead'
import type { BottomSpec, Fabric, GarmentSpec } from '../cloth/garmentSpec'
import { ClothSim, type BodyCollider } from '../cloth/xpbd'
import { vertexAdjacency, vertexNormals } from '../math/mesh'
import { Shoes, skinColors, skinMaterial, SKIN_TONES, underwearShape, WHITE_SNEAKERS, type ShoePalette } from './figure'
import { Eyes, eyeMaterial } from './face'
import { CONSTRUCTION_GLSL, constructionLines, weaveNormalMap } from './fabric'
import { Hair, hairMaterial, type HairStyle } from './hair'
import { SmoothBody } from './smoothBody'
import { strandMaterial } from './strands'

const MORPH_SECONDS = 0.9
// Air gap between a garment and the one over it (m)
const LAYER_GAP = 0.003
// width of a neckline trim band (the gown's draped edge), m
const TRIM_WIDTH = 0.055
const smoothstep = (t: number) => t * t * (3 - 2 * t)
// How light plays on the fabric: matte weaves and knits, glossy satin with a bright sheen
type Surface = { roughness: number; sheen: number; sheenRoughness: number }
const MATTE: Surface = { roughness: 0.78, sheen: 0.55, sheenRoughness: 0.65 }
// One shared matte surface made denim, shirting, wool and suiting read as the same plastic.
const SURFACE: Partial<Record<Fabric, Surface>> = {
  silk: { roughness: 0.32, sheen: 1, sheenRoughness: 0.3 },
  denim: { roughness: 0.9, sheen: 0.3, sheenRoughness: 0.7 },
  cotton: { roughness: 0.7, sheen: 0.4, sheenRoughness: 0.5 },
  // brushed coating wool: no specular, a soft fibre halo at grazing angles
  wool: { roughness: 0.96, sheen: 1, sheenRoughness: 0.42 },
  synthetic: { roughness: 0.6, sheen: 0.45, sheenRoughness: 0.45 },
  knit: { roughness: 0.92, sheen: 0.75, sheenRoughness: 0.6 },
}
/** Topstitching thread that contrasts with the cloth, as on jeans; others use a shade of the cloth. */
const THREAD: Partial<Record<Fabric, string>> = { denim: '#c98a3e' }

/** A fabric texture: a garment photo projected from the front, or a seamless swatch tiled every `tile` metres. */
export type Look = { texture: THREE.Texture; uv: 'photo'; torso?: [number, number]; printOnBack: boolean; landmarks?: Record<string, [number, number] | undefined>; crop?: Crop } | { texture: THREE.Texture; uv: 'tiled'; tile: number; /** see-through where the texture is transparent (open crochet) */ cutout?: boolean }

/** What the mannequin wears: a top (or a dress, which is a top with a floor-length hem) over a bottom. */
/** A garment sewn from a pattern program, worn in a layered outfit (see src/build). */
export interface LayeredGarment {
  garment: Garment
  fabric: Fabric
  color: string
  look?: Look
  kind: 'top' | 'bottom' | 'dress' | 'outer'
  fit: 'tight' | 'regular' | 'relaxed' | 'oversized'
  hold: 'shoulders' | 'neckline' | 'waist'
}

export interface Outfit {
  /** worn skin outward in this order, replacing top and bottom */
  layers?: LayeredGarment[]
  /** `custom`: a garment read from an uploaded photo (drafted by buildCustom) */
  top?: { spec: GarmentSpec; look?: Look; pattern?: PatternKind; custom?: GarmentRead }
  bottom?: { spec: BottomSpec; look?: Look; pattern?: PatternKind; custom?: GarmentRead }
}

/** One draped garment: its mesh, front/back materials and the cloth simulation. */
export class Layer {
  readonly geometry = new THREE.BufferGeometry()
  readonly front = new THREE.MeshPhysicalMaterial({ roughness: 0.82, sheen: 0.6, sheenRoughness: 0.8, side: THREE.DoubleSide })
  readonly back = new THREE.MeshPhysicalMaterial({ roughness: 0.82, sheen: 0.6, sheenRoughness: 0.8, side: THREE.DoubleSide })
  /** contrast trim along the neckline: colour, and how far down from the edge it reaches (m) */
  private readonly trim = { trimColor: { value: new THREE.Color() }, trimWidth: { value: 0 }, threadColor: { value: new THREE.Color() }, threadOn: { value: 0 }, sink: { value: 0 } }
  sim?: ClothSim
  /**
   * The drape as it settled in the A-pose. Carried from pose to pose the cloth picks up damage (an
   * arm swept through a shirt's side hitches it up, and it stays hitched); going back through the
   * A-pose it eases into this clean drape instead.
   */
  apose?: Float32Array

  constructor() {
    for (const m of [this.front, this.back]) m.onBeforeCompile = (shader) => this.addTrim(shader)
  }

  /**
   * Paint the trim over the fabric where the interpolated distance from the neckline is under its
   * width, and draw the construction: pressed seams and stitched hems (bumped into the surface by
   * the screen-space gradient of their height, as a bump map does) with lighter topstitching.
   */
  private addTrim(shader: THREE.WebGLProgramParametersWithUniforms) {
    Object.assign(shader.uniforms, this.trim)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float sink;\nattribute float trimDistance;\nvarying float vTrimDistance;\nattribute float seamDist;\nattribute float hemDist;\nvarying float vSeam;\nvarying float vHem;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed -= objectNormal * sink;\nvTrimDistance = trimDistance;\nvSeam = seamDist;\nvHem = hemDist;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec3 trimColor;\nuniform float trimWidth;\nuniform vec3 threadColor;\nuniform float threadOn;\nvarying float vTrimDistance;\nvarying float vSeam;\nvarying float vHem;\n${CONSTRUCTION_GLSL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
diffuseColor.rgb = mix(trimColor, diffuseColor.rgb, smoothstep(trimWidth - 0.003, trimWidth + 0.003, vTrimDistance));
{
  // thread a little lighter than the cloth (darker on pale cloth), creases a little darker
  float luma = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
  vec3 thread = luma < 0.35 ? diffuseColor.rgb * 1.6 + 0.05 : diffuseColor.rgb * 0.75;
  thread = mix(thread, threadColor, threadOn);
  diffuseColor.rgb = mix(diffuseColor.rgb, thread, 0.8 * stitchMask(vSeam, vHem));
  diffuseColor.rgb *= 1.0 + 0.25 * min(constructionHeight(vSeam, vHem), 0.0);
}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  float h = constructionHeight(vSeam, vHem);
  vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition);
  vec3 r1 = cross(dpdy, normal), r2 = cross(normal, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2) * 0.0012;
  normal = normalize(abs(det) * normal - grad);
}`)
  }
  garment?: Garment
  /**
   * Draw the cloth this far (m) inside its simulated surface. A garment worn under another is sunk,
   * as skin under clothes is, so where the two nearly touch (an XL shirt at a coat's shoulders) the
   * inner one can't show through.
   */
  set sunk(metres: number) { this.trim.sink.value = metres }

  set(garment: Garment, sim: ClothSim, color: string, fabric: Fabric, look?: Look, trimColor?: string) {
    this.trim.trimColor.value.set(trimColor ?? color)
    this.trim.trimWidth.value = garment.trimDistance ? TRIM_WIDTH : 0
    this.trim.threadOn.value = THREAD[fabric] ? 1 : 0
    if (THREAD[fabric]) this.trim.threadColor.value.set(THREAD[fabric]!)
    this.garment = garment
    this.sim = sim
    this.apose = undefined
    const g = this.geometry
    g.setIndex(new THREE.BufferAttribute(garment.index, 1))
    g.setAttribute('position', new THREE.BufferAttribute(sim.x, 3))
    g.setAttribute('normal', new THREE.BufferAttribute(vertexNormals(sim.x, garment.index), 3))
    g.setAttribute('uv', new THREE.BufferAttribute(garment.uv, 2))
    if (garment.photoUV) g.setAttribute('uv1', new THREE.BufferAttribute(garment.photoUV, 2))
    else g.deleteAttribute('uv1')
    g.setAttribute('trimDistance', new THREE.BufferAttribute(garment.trimDistance ?? new Float32Array(garment.src.length).fill(1), 1))
    const lines = constructionLines(garment)
    g.setAttribute('seamDist', new THREE.BufferAttribute(lines.seam, 1))
    g.setAttribute('hemDist', new THREE.BufferAttribute(lines.hem, 1))
    g.clearGroups()
    g.addGroup(0, garment.frontCount, 0)
    g.addGroup(garment.frontCount, garment.index.length - garment.frontCount, 1)
    g.setDrawRange(0, Infinity)
    g.computeBoundingSphere()

    const tex = look?.texture ?? null
    if (tex) {
      const channel = look?.uv === 'photo' && garment.photoUV ? 1 : 0
      if (tex.channel !== channel) { tex.channel = channel; tex.needsUpdate = true }
    }
    if (look?.uv === 'tiled') {
      look.texture.wrapS = look.texture.wrapT = THREE.RepeatWrapping
      look.texture.repeat.set(1 / look.tile, 1 / look.tile)
      look.texture.needsUpdate = true
    }
    const onBack = look?.uv === 'tiled' || (look?.uv === 'photo' && look.printOnBack)
    this.front.map = tex
    this.front.color.set(tex ? '#ffffff' : color)
    this.back.map = onBack ? tex : null
    this.back.color.set(onBack ? '#ffffff' : color)
    // the weave, where the UVs are in metres (pattern garments and tiled swatches)
    const weave = garment.flat || look?.uv === 'tiled' ? weaveNormalMap(fabric) : undefined
    // sheen in a lightened fabric colour (the default black sheen left dark cloth flat, its folds
    // unreadable)
    const sheen = new THREE.Color(tex ? '#ffffff' : color).lerp(new THREE.Color('#ffffff'), 0.28)
    for (const m of [this.front, this.back]) {
      Object.assign(m, SURFACE[fabric] ?? MATTE)
      m.alphaTest = look?.uv === 'tiled' && look.cutout ? 0.5 : 0
      m.sheenColor.copy(sheen)
      m.normalMap = weave?.map ?? null
      m.normalScale.setScalar(weave?.strength ?? 1)
    }
    this.front.needsUpdate = this.back.needsUpdate = true
  }

  clear() {
    this.garment = this.sim = this.apose = undefined
    this.geometry.setDrawRange(0, 0)
  }

  /** Step the cloth and refresh the mesh; true when it has just settled (or frozen). */
  step(dt: number, collider: BodyCollider) {
    if (!this.sim || this.sim.frozen) return false
    const wasQuiet = this.sim.quiet
    this.sim.step(dt, collider)
    const g = this.geometry
    const normals = g.attributes.normal.array as Float32Array
    vertexNormals(this.sim.x, g.index!.array, normals)
    // shade across seams as one surface (the two sides are separate vertices)
    const seams = this.garment?.seams
    if (seams)
      for (let c = 0; c < seams.length; c += 2)
        for (let k = 0; k < 3; k++) {
          const a = seams[c] * 3 + k, b = seams[c + 1] * 3 + k
          normals[a] = normals[b] = (normals[a] + normals[b]) / 2
        }
    g.attributes.position.needsUpdate = g.attributes.normal.needsUpdate = true
    return this.sim.frozen || (this.sim.quiet && !wasQuiet)
  }
}

export class Stage {
  readonly bodyGeometry = new THREE.BufferGeometry()
  readonly skin = skinMaterial()
  /** Sneakers shaped over the feet */
  readonly shoeGeometry = new THREE.BufferGeometry()
  // double-sided: the inside of the collar shows as the shoe's lining
  readonly shoe = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.55, clearcoat: 0.15, clearcoatRoughness: 0.5, side: THREE.DoubleSide })
  private shoes?: Shoes
  /** Hair styled for the mannequin (rebuilt with gender and size) */
  readonly hairGeometry = new THREE.BufferGeometry()
  readonly hair = hairMaterial()
  readonly strandGeometry = new THREE.BufferGeometry()
  readonly strands = strandMaterial()
  private hairStyle?: Hair
  private hairFor?: [BodySet, Size]
  /** Glossy eyes over the eyeballs */
  readonly eyeGeometry = new THREE.BufferGeometry()
  readonly eyeMat = eyeMaterial()
  private eyes?: Eyes
  private tone = SKIN_TONES[4][1]
  /** Bottom first: the top is draped over it */
  // outer layers carry garments worn over the top (a bolero over a dress) in layered outfits
  readonly layers = { bottom: new Layer(), top: new Layer(), outer1: new Layer(), outer2: new Layer() }
  onSettled?: () => void

  private body?: BodySet
  private size: Size = 'M'
  private pose: Pose = 'apose'
  private current: Float32Array = new Float32Array(0)
  private before: Float32Array = new Float32Array(0)
  private beforeNormals: Float32Array = new Float32Array(0)
  private from: Float32Array = new Float32Array(0)
  private target: Float32Array = new Float32Array(0)
  private morphT = 1
  private lastT = 1
  private collider?: BodyCollider
  /** the drawn body: the coarse one (simulated against) split and curved for smoother shading */
  private smooth?: SmoothBody
  private fine = { pos: new Float32Array(0), nrm: new Float32Array(0), col: new Float32Array(0), coarseCol: new Float32Array(0), covered: new Float32Array(0), rest: new Float32Array(0), face: new Float32Array(0) }
  /** Outfit to cut once the body morph finishes */
  private pending?: Outfit
  /** pose to morph on to once the current morph (to the A-pose) finishes */
  private then?: Pose

  /** Morph the mannequin to a new gender/size/pose; the cloth is carried along and re-drapes. */
  setBody(body: BodySet, size: Size, pose: Pose) {
    const first = !this.body
    const topologyChanged = this.body?.vertexCount !== body.vertexCount
    // Between two arms-down poses, swing out through the A-pose: blended straight across, the arms
    // passed through the shirt's sides, and once inside the cloth they shoved it up over themselves.
    this.then = undefined
    if (!first && !topologyChanged && body === this.body && size === this.size && pose !== this.pose && pose !== 'apose' && this.pose !== 'apose') {
      this.then = pose
      pose = 'apose'
    }
    this.body = body
    this.size = size
    this.pose = pose
    this.target = body.positions(size, pose)
    if (first || topologyChanged) {
      this.current = this.target.slice()
      this.before = this.target.slice()
      this.beforeNormals = new Float32Array(this.target.length)
      this.morphT = 1
      this.shoes = new Shoes(body, size, this.shoeGeometry)
      this.shoes.palette = this.shoePalette
      this.collider = {
        positions: this.current,
        normals: vertexNormals(this.current, body.index),
        adjacency: vertexAdjacency(body.index, body.vertexCount),
      }
      this.smooth = new SmoothBody(body.index, body.vertexCount)
      const n = this.smooth.vertexCount * 3
      this.fine = { pos: new Float32Array(n), nrm: new Float32Array(n), col: new Float32Array(n), coarseCol: new Float32Array(body.vertexCount * 3), covered: new Float32Array(n / 3), rest: new Float32Array(n), face: new Float32Array(n) }
      this.bodyGeometry.setIndex(new THREE.BufferAttribute(this.smooth.index, 1))
      this.bodyGeometry.setAttribute('position', new THREE.BufferAttribute(this.fine.pos, 3))
      this.bodyGeometry.setAttribute('normal', new THREE.BufferAttribute(this.fine.nrm, 3))
      this.bodyGeometry.setAttribute('color', new THREE.BufferAttribute(this.fine.col, 3))
      this.bodyGeometry.setAttribute('covered', new THREE.BufferAttribute(this.fine.covered, 1))
      this.bodyGeometry.setAttribute('restPos', new THREE.BufferAttribute(this.fine.rest, 3))
      this.bodyGeometry.setAttribute('facePhoto', new THREE.BufferAttribute(this.fine.face, 3))
      if (this.facePaint) this.setFacePhoto(this.facePaint)
      this.refreshBody()
      this.updateShoes()
    } else {
      this.from = this.current.slice()
      this.morphT = 0
    }
    if (first || topologyChanged || body !== this.hairFor?.[0] || size !== this.hairFor?.[1]) {
      this.hairStyle = new Hair(body, size, this.hairGeometry, this.hair, this.strandGeometry, this.strands, this.hairMode, this.browsOn)
      this.eyes = new Eyes(body, body.positions(size, 'apose'), this.eyeGeometry)
      this.hairFor = [body, size]
      this.updateShoes()
    }
    for (const l of this.sims()) l.wake()
    this.setSkin(this.tone)
  }

  private hairMode: HairStyle = 'default'
  private browsOn = true
  /** 'none' takes the hair off (a new head has no hair until one is chosen); brows and lashes stay unless `brows` is false */
  setHairStyle(mode: HairStyle, brows = true) {
    if (mode === this.hairMode && brows === this.browsOn) return
    this.hairMode = mode
    this.browsOn = brows
    if (this.body) {
      this.hairStyle = new Hair(this.body, this.size, this.hairGeometry, this.hair, this.strandGeometry, this.strands, mode, brows)
      this.hairStyle.setSkin(this.tone)
      this.updateShoes()
    }
  }

  /** Renders a still from a camera (set by the Viewer): the head studio's views for Claude. */
  renderView?: (eye: number[], target: number[], width?: number, height?: number) => string

  /** The head studio: only the head and neck, bald, for fitting a face (the viewer frames it; see Viewer). */
  studio = false
  setHeadStudio(on: boolean) {
    this.studio = on
    if (on && this.body) {
      const neck = this.body.segment('neck')
      let low = Infinity
      for (let v = 0; v < this.body.vertexCount; v++) if (this.body.labels[v] === neck) low = Math.min(low, this.current[v * 3 + 1])
      // cut at the base of the neck: lower, the shoulders and the bra straps came into the studio
      this.skin.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -(low + 0.01))]
    } else this.skin.clippingPlanes = null
    this.skin.needsUpdate = true
  }

  /** The middle of the head as it stands now (for framing it). */
  headCentre(): [number, number, number] {
    if (!this.body) return [0, 1.55, 0]
    const head = this.body.segment('head')
    let x = 0, y = 0, z = 0, n = 0
    for (let v = 0; v < this.body.vertexCount; v++) if (this.body.labels[v] === head) { x += this.current[v * 3]; y += this.current[v * 3 + 1]; z += this.current[v * 3 + 2]; n++ }
    return n ? [x / n, y / n, z / n] : [0, 1.55, 0]
  }

  /** The irises' colour (sRGB hex). */
  setEyeColor(hex: string) {
    ;(this.eyeMat.userData.irisColor as { value: THREE.Color }).value.set(hex)
  }

  private facePaint?: { texture: THREE.Texture; paint: Float32Array }
  /**
   * Paint a photo on the face: `paint` holds, per body vertex, its place in the photo (u, v) and how much of
   * the photo shows there (0..1); see src/face/paint.ts. Undefined takes it off.
   */
  setFacePhoto(face?: { texture: THREE.Texture; paint: Float32Array }) {
    this.facePaint = face
    const uw = this.skin.userData.underwear
    uw.faceMap.value = face?.texture ?? null
    if (!face) uw.faceOn.value = 0
    if (!this.smooth || !this.body) return
    const coarse = new Float32Array(this.body.vertexCount), fine = new Float32Array(this.fine.face.length / 3)
    for (let k = 0; k < 3; k++) {
      for (let v = 0; v < coarse.length; v++) coarse[v] = face ? face.paint[v * 3 + k] : 0
      this.smooth.scalars(coarse, fine)
      for (let i = 0; i < fine.length; i++) this.fine.face[i * 3 + k] = fine[i]
    }
    ;(this.bodyGeometry.getAttribute('facePhoto') as THREE.BufferAttribute).needsUpdate = true
  }

  /** Show or hide the photo painted on the face (the shape fitted to it stays). */
  showFacePhoto(on: boolean) {
    this.skin.userData.underwear.faceOn.value = on && this.facePaint ? 1 : 0
  }

  /** Skin tone (sRGB hex); the eyes keep their own colours. */
  setSkin(tone: string) {
    this.tone = tone
    if (!this.body) return
    const attr = this.bodyGeometry.getAttribute('color') as THREE.BufferAttribute
    skinColors(this.body, this.size, tone, this.fine.coarseCol)
    this.smooth?.colors(this.fine.coarseCol, this.fine.col)
    attr.needsUpdate = true
    // the underwear is drawn from each point's A-pose position (see underwearShape)
    if (this.smooth) {
      const rest = this.body.positions(this.size, 'apose')
      this.smooth.positions(rest, vertexNormals(rest, this.body.index), this.fine.rest)
      ;(this.bodyGeometry.getAttribute('restPos') as THREE.BufferAttribute).needsUpdate = true
      const shape = underwearShape(this.body, this.size), uw = this.skin.userData.underwear
      uw.uwA.value.copy(shape.a); uw.uwB.value.copy(shape.b); uw.uwBL.value.copy(shape.bustL); uw.uwBR.value.copy(shape.bustR)
    }
    // the hairline blends into the skin
    this.hairStyle?.setSkin(tone)
    this.updateShoes()
  }

  /** Redraw the smooth body from the coarse one as it is now. */
  private refreshBody() {
    if (!this.smooth || !this.collider) return
    this.smooth.positions(this.current, this.collider.normals, this.fine.pos)
    vertexNormals(this.fine.pos, this.smooth.index, this.fine.nrm)
    const a = this.bodyGeometry.attributes
    a.position.needsUpdate = a.normal.needsUpdate = true
    this.bodyGeometry.computeBoundingSphere()
  }

  private shoePalette: ShoePalette = WHITE_SNEAKERS
  /** Restyle the sneakers (a guide outfit's own pair) and redraw them now. */
  setShoes(palette: ShoePalette = WHITE_SNEAKERS) {
    this.shoePalette = palette
    if (this.shoes) { this.shoes.palette = palette; this.shoes.update(this.current, this.collider?.normals) }
  }

  private updateShoes() {
    this.shoes?.update(this.current, this.collider?.normals)
    if (this.collider) this.hairStyle?.update(this.current, this.collider.normals)
    this.eyes?.update(this.current)
  }

  /**
   * Cut + inflate the outfit on the current body, bottom first, then let it drape. During a size or
   * gender morph the cut waits for the finished body: draped onto a body still growing under it, a
   * waistband slipped off the hips.
   */
  setOutfit(outfit: Outfit) {
    const body = this.body
    if (!body) return
    if (this.morphT < 1) {
      this.pending = outfit
      return
    }
    this.pending = undefined
    if (outfit.layers) return this.setLayers(outfit.layers)
    this.layers.outer1.clear(); this.layers.outer2.clear()
    for (const l of Object.values(this.layers)) l.sunk = 0
    const { bottom, top } = this.layers
    let lift: Float32Array | undefined
    if (outfit.bottom) {
      const g = outfit.bottom.custom ? buildCustom(outfit.bottom.custom, body, this.size, photoOf(outfit.bottom.look))
        : outfit.bottom.pattern ? buildPattern(outfit.bottom.pattern, body, this.size) : buildBottom(body, this.size, outfit.bottom.spec)
      bottom.set(g, this.drape(g, outfit.bottom.spec.fabric), outfit.bottom.spec.primaryColor, outfit.bottom.spec.fabric, outfit.bottom.look)
      lift = new Float32Array(body.vertexCount)
      for (let v = 0; v < lift.length; v++) if (g.covers[v]) lift[v] = g.covers[v] + LAYER_GAP
    } else bottom.clear()
    if (outfit.top) {
      const look = outfit.top.look
      const uv: UVMode = look?.uv === 'photo' ? { kind: 'photo', torso: look.torso } : look ? { kind: 'tiled' } : { kind: 'photo' }
      const g = outfit.top.custom ? buildCustom(outfit.top.custom, body, this.size, photoOf(look), lift)
        : outfit.top.pattern ? buildPattern(outfit.top.pattern, body, this.size, lift)
          : buildTop(body, this.size, outfit.top.spec, uv, lift)
      top.set(g, this.drape(g, outfit.top.spec.fabric), outfit.top.spec.primaryColor, outfit.top.spec.fabric, look, outfit.top.spec.trimColor)
    } else top.clear()
    // a bandeau bra (no straps) under clothes that bare the shoulders
    const bare = outfit.top && (outfit.top.custom ? baresShoulders(outfit.top.custom) : outfit.top.pattern === 'gown' || outfit.top.pattern === 'offShoulderDress')
    this.skin.userData.underwear.uwStraps.value = bare ? 0 : 1
    this.markCovered()
  }

  /**
   * A layered outfit: each garment, skin outward, drapes over the ones under it (their cloth lifts the
   * skin it collides with), and is drawn sunk under the ones over it so it can't show through.
   */
  private setLayers(list: LayeredGarment[]) {
    const body = this.body!
    const slots = [this.layers.bottom, this.layers.top, this.layers.outer1, this.layers.outer2]
    let lift: Float32Array | undefined
    const ignoreOf = (names: string[]) => { const ids = names.map((n) => body.segment(n)); return body.labels.map((l) => (ids.includes(l) ? 1 : 0)) }
    list.slice(0, slots.length).forEach((item, i) => {
      const g: Garment = { ...item.garment, lift: lift?.slice(), ignore: ignoreOf(item.kind === 'bottom' ? ['upperarm', 'forearm', 'hand'] : ['forearm', 'hand']) }
      // an elastic top edge or waistband holds the garment up; fitted cloth grips the skin all over
      if (item.hold !== 'shoulders') g.bandTether = 0.25
      if (item.fit === 'tight') {
        g.friction = 0.75
        g.grip = Float32Array.from(g.noTurn ?? [], (t) => (t ? 0.04 : 0))
      }
      slots[i].set(g, this.drape(g, item.fabric), item.color, item.fabric, item.look)
      const over = list.slice(i + 1)
      slots[i].sunk = item.kind === 'bottom' ? 0 : over.some((o) => o.kind === 'outer') ? 0.01 : over.some((o) => o.kind !== 'bottom') ? 0.006 : 0
      lift ??= new Float32Array(body.vertexCount)
      for (let v = 0; v < lift.length; v++) if (g.covers[v]) lift[v] = Math.max(lift[v], g.covers[v] + LAYER_GAP)
    })
    for (const l of slots.slice(list.length)) { l.clear(); l.sunk = 0 }
    // straps off when the garment next to the skin is held up by its own elastic top edge (a strapless
    // dress under an open crochet bolero would still show them)
    const inner = list.find((l) => l.kind !== 'bottom')
    this.skin.userData.underwear.uwStraps.value = inner?.hold === 'neckline' ? 0 : 1
    this.markCovered()
  }

  /**
   * Skin under a worn garment is drawn sunk 5 mm into the body (the skin shader reads `covered`):
   * where XL thighs touch, the cloth can't fit between them, and collision alone let skin show
   * through. Head, hands and feet stay put, so nothing shows at the openings.
   */
  private markCovered() {
    const body = this.body
    if (!body || !this.smooth) return
    const coarse = new Float32Array(body.vertexCount)
    const skip = ['head', 'eye', 'hand'].map((n) => body.segment(n))
    const leg = body.segment('lowerleg')
    const rest = body.positions(this.size, 'apose')
    for (const l of Object.values(this.layers)) {
      const covers = l.garment?.covers
      if (!covers) continue
      for (let v = 0; v < coarse.length; v++)
        if (covers[v] > 0 && !skip.includes(body.labels[v]) && !(body.labels[v] === leg && rest[v * 3 + 1] < 0.16)) coarse[v] = 1
    }
    this.smooth.scalars(coarse, this.fine.covered)
    ;(this.bodyGeometry.getAttribute('covered') as THREE.BufferAttribute).needsUpdate = true
  }

  /** A new simulation for the garment, cut in the A-pose and carried onto the body as it is now. */
  protected drape(garment: Garment, fabric: GarmentSpec['fabric']) {
    const body = this.body!
    const sim = new ClothSim(garment, fabric)
    const apose = body.positions(this.size, 'apose')
    sim.carry(apose, this.current, vertexNormals(apose, body.index), this.collider!.normals)
    return sim
  }

  private sims() {
    return Object.values(this.layers).flatMap((l) => (l.sim ? [l.sim] : []))
  }

  /** No body morph in progress and the cloth has frozen. */
  get idle() {
    return this.morphT >= 1 && this.settled
  }

  /** Every drape has settled (main-page cloth keeps simulating after that; see ClothSim.quiet). */
  get settled() {
    return this.sims().every((s) => s.frozen || s.quiet)
  }

  update(dt: number) {
    if (!this.body || !this.collider) return
    const bodyMoving = this.morphT < 1
    if (bodyMoving) {
      this.before.set(this.current)
      this.beforeNormals.set(this.collider.normals)
      this.lastT = this.morphT
      this.morphT = Math.min(1, this.morphT + dt / MORPH_SECONDS)
      const s = smoothstep(this.morphT)
      for (let i = 0; i < this.current.length; i++) this.current[i] = this.from[i] + (this.target[i] - this.from[i]) * s
      vertexNormals(this.current, this.body.index, this.collider.normals)
      this.refreshBody()
      for (const sim of this.sims()) sim.carry(this.before, this.current, this.beforeNormals, this.collider.normals)
      // heading for the A-pose: over the second half of the move, ease into the clean A-pose drape
      // (w is this frame's share of what is left, so it lands exactly when the body does)
      if (this.pose === 'apose') {
        const prevT = smoothstep(Math.max(0, (this.lastT - 0.5) / 0.5)), t = smoothstep(Math.max(0, (this.morphT - 0.5) / 0.5))
        const w = prevT >= 1 ? 1 : (t - prevT) / (1 - prevT)
        if (w > 0) for (const l of Object.values(this.layers)) if (l.sim && l.apose) l.sim.blendTo(l.apose, w)
      }
      this.updateShoes()
      if (this.morphT >= 1 && this.then) this.setBody(this.body, this.size, this.then)
      else if (this.morphT >= 1 && this.pending) this.setOutfit(this.pending)
    }
    let froze = false
    for (const l of Object.values(this.layers)) froze = l.step(dt, this.collider) || froze
    if (!bodyMoving && this.pose === 'apose' && !this.then)
      for (const l of Object.values(this.layers)) if ((l.sim?.frozen || l.sim?.quiet) && !l.apose) l.apose = l.sim.x.slice()
    if (froze && this.settled) this.onSettled?.()
  }

  describe() {
    return { size: this.size, pose: this.pose, gender: this.body?.gender }
  }
}

/** A placed photo print on a garment read from a photo: where its landmarks put it. */
const photoOf = (look?: Look): CustomPhoto | undefined => look?.uv === 'photo' ? { uv: 'photo', landmarks: look.landmarks, crop: look.crop, torso: look.torso } : undefined
