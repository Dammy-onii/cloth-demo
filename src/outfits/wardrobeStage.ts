import type { BodySet, Pose, Size } from '../body/bodySet'
import { SmoothBody } from '../scene/smoothBody'
import { Stage, Layer } from '../scene/stage'
import type { GuideOutfit } from './catalog'
import { draftOutfitPiece } from './drafts'
import { outfitLook } from './materials'
import { Tailoring } from './details'
import * as THREE from 'three'
import { seamAllowance } from './seamAllowance'
import { vertexNormals } from '../math/mesh'
import { TrouserClearance } from './trouserClearance'
import { TorsoClearance } from './torsoClearance'
import { SleeveClearance } from './sleeveClearance'
import { LayerClearance } from './layerClearance'
import { SkirtClearance } from './skirtClearance'
import { fitArmholes } from './fitArmholes'
import { posePattern } from './posePattern'
import { SupportedCloth } from './supportedCloth'

/** Drape the way the main wardrobe does (cut in the A-pose, a plain ClothSim carried onto the pose)?
 * Tried on 2026-11-07 and kept off: open coats slid off the shoulders, cropped blazers fell into a
 * heap at the back and tucked shirts tore open. Open fronts have no closed neckline to hang from. */
const PLAIN_DRAPE = false

/** Opt-in adapter only. Stage already iterates its public layers for carry, stepping and rendering. */
export class WardrobeStage extends Stage {
  readonly slots: Layer[]
  private readonly tailoring = new Tailoring()
  private request?: { body: BodySet; size: Size; outfit: GuideOutfit; pose: Pose }
  private fitted?: { body: BodySet; size: Size; outfit: GuideOutfit }
  error?: string

  constructor() {
    super()
    // Install a stable set before React mounts Viewer; no runtime mesh registration is needed.
    const extra = { middle: new Layer(), outer: new Layer() }
    Object.assign(this.layers, extra)
    Object.assign(this.layers, { tailoring: this.tailoring.cloth, hardware: this.tailoring.hardware, neckwear: this.tailoring.neckwear,
      belt: this.tailoring.belt, buckle: this.tailoring.buckle, buttons: this.tailoring.buttons,
      shirtCollar: this.tailoring.shirtCollar, coatCollar: this.tailoring.coatCollar })
    this.slots = [this.layers.bottom, this.layers.top, extra.middle, extra.outer]
  }

  clearGuide() {
    this.error = undefined
    this.fitted = undefined
    this.tailored = true
    for (const layer of this.slots) { layer.clear(); layer.sunk = 0; layer.front.clippingPlanes = layer.back.clippingPlanes = null }
    this.tailoring.clear()
    this.tailoring.buttons.front.clippingPlanes = null
  }

  configure(body: BodySet, size: Size, pose: Pose, outfit: GuideOutfit) {
    if (this.fitted?.body === body && this.fitted.size === size && this.fitted.outfit === outfit) {
      for (const layer of this.slots) {
        if (layer.sim instanceof SupportedCloth) layer.sim.followTarget = body.positions(size, pose)
      }
    } else {
      this.clearGuide()
    }
    this.error = undefined
    this.builder = undefined // a newer request replaces a build still in progress
    this.request = { body, size, pose, outfit }
    super.setBody(body, size, pose)
    this.setShoes(outfit.shoes)
  }

  override get idle(): boolean { return !this.request && !this.builder && this.drawing && this.tailored && super.idle }

  override update(dt: number) {
    super.update(dt)
    if (this.request && super.idle) {
      // hide only a new outfit; a pose change re-fits the one already shown, so keep it in view
      if (!this.fitted) this.showCloth(false)
      this.builder = this.build(this.request)
      this.request = undefined
    }
    if (this.builder) {
      try {
        if (this.builder.next().done) this.builder = undefined
      } catch (e) {
        this.builder = undefined
        this.clearGuide()
        this.error = String(e)
        this.showCloth(true)
      }
    } else if (this.fitted && !this.tailored && super.idle) {
      // place the tailoring against the settled drape (see details.ts), then show it all
      this.tailoring.build(this.fitted.outfit, this.slots, this.fitted.body, this.fitted.size)
      this.tailored = true
      this.showCloth(true)
    } else if (this.drawing === false) {
      // Settle off screen: all layers sewing at once, each pulled to its supports every frame,
      // looked chaotic on screen. Step in ~40 ms slices between frames and show the result.
      const until = performance.now() + 40
      while (!super.idle && performance.now() < until) super.update(1 / 30)
    }
    this.tailoring.update()
  }

  /** Builds the outfit's garments one per call to `next()`, inner to outer. */
  private *build({ body, size, pose, outfit }: NonNullable<WardrobeStage['request']>): Generator<void, void, void> {
      const rest = body.positions(size, 'apose'), posed = body.positions(size, pose)
      const restNormals = vertexNormals(rest, body.index)
      const posedNormals = pose === 'apose' ? restNormals : vertexNormals(posed, body.index)
      let lift = new Float32Array(body.vertexCount)
      const torso = new TorsoClearance(posed, body.labels, body.segment('torso'), body.segment('neck'))
      const joints = body.joints(size, pose)
      const hipY = (joints['upperleg01.L'][1] + joints['upperleg01.R'][1]) / 2 + 0.035
      for (const [i, piece] of outfit.pieces.entries()) {
        const draft = draftOutfitPiece(piece.cut, body, size, i ? lift.slice() : undefined, PLAIN_DRAPE ? 'apose' : pose)
        // The skirt hangs from the waist. Carrying each gore with the closest
        // thigh puts a sharp crease down the front as the legs change stance.
        const garment = PLAIN_DRAPE || piece.cut === 'maxi' ? draft : fitArmholes(posePattern(draft, body, size, pose, restNormals, posedNormals))
        const skirt = piece.cut === 'maxi' ? {
          clearance: new SkirtClearance(body.labels, body.segment('upperleg'), body.segment('lowerleg')),
          hipY,
        } : undefined
        const layers = ['trench', 'overshirt', 'croppedBlazer', 'doubleBlazer', 'waistcoat'].includes(piece.cut)
          ? new LayerClearance(outfit.pieces.slice(0, i).map((inner, index) => ({
            layer: this.slots[index], bottom: ['jeans', 'maxi', 'pleatedTrousers', 'flaredTrousers'].includes(inner.cut),
          }))) : undefined
        const sleeves = ['shirt', 'turtleneck', 'trench', 'overshirt', 'croppedBlazer', 'doubleBlazer'].includes(piece.cut)
          ? new SleeveClearance(joints, i > 0 ? this.slots[0] : undefined, body.labels, body.segment('upperarm'), body.segment('forearm'), rest, posed) : undefined
        const trousers = ['jeans', 'pleatedTrousers', 'flaredTrousers'].includes(piece.cut)
          ? new TrouserClearance(body, posed, hipY) : undefined
        const cloth = PLAIN_DRAPE ? this.drape(garment, piece.fabric) : new SupportedCloth(garment, piece.fabric, posed, posedNormals, piece.cut === 'trench' ? 'coat' : piece.cut === 'maxi' ? 'waist' : i === 0 ? 'inner' : layers ? 'tailored' : 'standard', skirt, layers, sleeves, torso, trousers, outfit.id === 'stripes')
        this.slots[i].set(garment, cloth, piece.color, piece.fabric, outfitLook(piece))
        const renderIndex = seamAllowance(garment)
        const geometry = this.slots[i].geometry
        geometry.setIndex(new THREE.BufferAttribute(renderIndex, 1))
        geometry.clearGroups(); geometry.addGroup(0, renderIndex.length, 0)
        for (let v = 0; v < lift.length; v++) if (garment.covers[v]) lift[v] = Math.max(lift[v], garment.covers[v] + 0.003)
        // A sparse nearest-vertex map leaves gaps between cloth samples. Fill by height within
        // each body segment, so the next layer cannot fall through those empty collision cells.
        const pos = body.positions(size, 'apose'), bins = new Map<string, number>()
        for (let v = 0; v < lift.length; v++) if (lift[v]) {
          const key = `${body.labels[v]}:${Math.round(pos[v * 3 + 1] / 0.025)}`
          bins.set(key, Math.max(bins.get(key) ?? 0, lift[v]))
        }
        lift = lift.map((value, v) => {
          const y = Math.round(pos[v * 3 + 1] / 0.025)
          return Math.max(value, ...[-1, 0, 1].map(d => (bins.get(`${body.labels[v]}:${y + d}`) ?? 0) * (d ? 0.85 : 1)))
        })
        // one garment per frame: drafting all of them at once stalled the page for ~1.7 s
        yield
      }
      for (const layer of this.slots.slice(outfit.pieces.length)) layer.clear()
      // Each garment worn under an outer one is drawn sunk (see Layer.sunk): 1 cm under a coat, whose
      // clearance is radial and misses the tops of the shoulders, where an XL shirt came through.
      const bottoms = ['jeans', 'maxi', 'pleatedTrousers', 'flaredTrousers']
      // Bottoms are never sunk: jeans sit close to the thighs, and sunk 6 mm the skin came through.
      outfit.pieces.forEach((piece, i) => {
        const over = outfit.pieces.slice(i + 1).filter(p => !bottoms.includes(p.cut))
        // a maxi skirt stands off the legs, so it can sink a little under an overshirt's hem
        if (bottoms.includes(piece.cut)) this.slots[i].sunk = piece.cut === 'maxi' && over.length ? 0.006 : 0
        // 6 mm let a shirt show through a waistcoat's chest in patches: 1 cm under any tailored layer
        else this.slots[i].sunk = over.some(p => ['trench', 'waistcoat', 'croppedBlazer', 'doubleBlazer', 'overshirt'].includes(p.cut)) ? 0.01 : over.length ? 0.006 : 0
      })
      // A tucked shirt is never seen below the waistband, but its hem flares and pokes through the
      // jeans' front. Don't draw it more than 2.5 cm below the top of the trousers.
      const tucked = outfit.pieces.findIndex(p => p.cut === 'shirt')
      const trousers = outfit.pieces.findIndex(p => ['jeans', 'pleatedTrousers', 'flaredTrousers'].includes(p.cut))
      if (tucked >= 0 && trousers > tucked) {
        const rest = this.slots[trousers].garment!.rest
        let top = -Infinity
        for (let i = 1; i < rest.length; i += 3) top = Math.max(top, rest[i])
        const layer = this.slots[tucked]
        layer.front.clippingPlanes = layer.back.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -(top - 0.025))]
        // and its buttons with it, or they showed on the jeans' fly
        this.tailoring.buttons.front.clippingPlanes = layer.front.clippingPlanes
      }
      this.tailoring.build(outfit, this.slots, body, size)
      this.tailored = false
      this.fitted = { body, size, outfit }
      // Use the same 5 mm render inset as the regular wardrobe for skin under the cloth.
      const covered = this.bodyGeometry.getAttribute('covered')
      const coarse = new Float32Array(body.vertexCount)
      const open = ['head', 'eye', 'hand'].map(name => body.segment(name))
      const leg = body.segment('lowerleg')
      for (const slot of this.slots) slot.garment?.covers.forEach((value, v) => {
        const label = body.labels[v]
        if (value > 0 && !open.includes(label) && (label !== leg || rest[v * 3 + 1] >= 0.16)) coarse[v] = 1
      })
      new SmoothBody(body.index, body.vertexCount).scalars(coarse, covered.array as Float32Array)
      covered.needsUpdate = true
  }

  private drawing = true
  /** whether the tailoring has been placed against the settled cloth */
  private tailored = true
  private builder?: Generator<void, void, void>
  /** Hide or show every garment and its tailoring while an outfit drapes off screen. */
  private showCloth(on: boolean) {
    this.drawing = on
    for (const layer of [...this.slots, ...this.tailoring.all])
      layer.front.visible = layer.back.visible = on
  }

  /** True while an outfit is being drafted or is draping off screen. */
  get draping() { return !!this.request || !!this.builder || !this.drawing }
}

