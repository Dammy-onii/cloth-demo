import { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { loadBodySet, POSES, SIZES, type BodySet, type Gender, type Pose, type Size } from './body/bodySet'
import { LEVELS, SLEEVE_ENDS, levelName, sanitizeRead, type GarmentRead, type SleeveEnd } from './cloth/garmentRead'
import { DEFAULT_SPEC, type BottomSpec, type GarmentSpec } from './cloth/garmentSpec'
import { analyzeGarment, buildWithClaude, claudeHealth, refineBuild, refineRender, sculptFace, type Review } from './claude'
import { buildPattern, type BuiltGarment } from './build/run'
import { detectFace, type FaceScan } from './photo/face'
import { faceOffset, loadFaceMorphs, withFace, type FaceMorphs } from './face/morphs'
import { fitFace, type FaceFit } from './face/fit'
import { delight, facePaint, skinTone } from './face/paint'
import { PROGRAM_OUTFITS } from './build/presets'
import { programLook } from './build/looks'
import { processGarmentPhoto, refineWithClaude, swatchCanvas, type GarmentPhoto } from './photo/garmentPhoto'
import { detectJoints } from './photo/pose'
import { SKIN_TONES } from './scene/figure'
import type { HairStyle } from './scene/hair'
import { Stage, type Look, type Outfit } from './scene/stage'
import { Viewer } from './scene/Viewer'
import { item, OUTFITS, WARDROBE, type BottomItem, type TopItem, type WardrobeItem } from './wardrobe/catalog'

type ClaudeState = { ok: boolean; version?: string; error?: string } | null

/** Clothes from an uploaded photo stand in for a wardrobe top and/or bottom */
const CUSTOM = 'custom'
const swatches = new Map<string, THREE.Texture>()
function swatch(id: string) {
  if (!swatches.has(id)) {
    const t = new THREE.TextureLoader().load(`/wardrobe/${id}-swatch.jpg`)
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = 4
    swatches.set(id, t)
  }
  return swatches.get(id)!
}

/** A garment Claude found in the uploaded photo, with how to print it. */
interface Found {
  read: GarmentRead
  wear: boolean
  /** cut from the photo by Claude's outline: shown as a thumbnail, printed when the print is placed */
  cut: GarmentPhoto
  /** the fabric swatch, tiled at its real size for all-over prints */
  fabric?: { texture: THREE.Texture; tile: number }
  photoTexture: THREE.Texture
  /** the photo it came from: each garment is checked against its own (a top and trousers can come from two) */
  source: GarmentPhoto
}

const canvasTexture = (c: HTMLCanvasElement) => {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 4
  return t
}

function lookOf(f: Found): Look | undefined {
  const r = f.read
  if (r.print === 'allover' && f.fabric) return { texture: f.fabric.texture, uv: 'tiled', tile: f.fabric.tile }
  if (r.print === 'placed' && r.slot !== 'bottom') return { texture: f.photoTexture, uv: 'photo', torso: f.cut.torso, printOnBack: false, landmarks: r.landmarks, crop: f.cut.crop }
  // a placed print on bottoms can't be positioned yet: tile its fabric instead
  if (r.print === 'placed' && f.fabric) return { texture: f.fabric.texture, uv: 'tiled', tile: f.fabric.tile }
  return undefined
}

const specOf = (r: GarmentRead): GarmentSpec => ({ ...DEFAULT_SPEC, category: r.type, fabric: r.fabric, primaryColor: r.primaryColor, description: r.description })
const bottomSpecOf = (r: GarmentRead): BottomSpec => ({ style: r.bottomKind, fit: r.fit, fabric: r.fabric, primaryColor: r.primaryColor })

export default function App() {
  const stage = useMemo(() => new Stage(), [])
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [gender, setGender] = useState<Gender>('female')
  const [size, setSize] = useState<Size>('M')
  const [pose, setPose] = useState<Pose>('apose')
  const [tone, setTone] = useState(SKIN_TONES[4][1])
  const [body, setBody] = useState<BodySet | null>(null)
  const [turntable, setTurntable] = useState(false)
  const [showGarment, setShowGarment] = useState(true)
  const [topId, setTopId] = useState(OUTFITS.female[0][1])
  const [bottomId, setBottomId] = useState<string | undefined>(OUTFITS.female[0][2])
  const [found, setFound] = useState<Found[]>([])
  /** photos uploaded for Claude to draft an outfit from (a top in one, bottoms in another, say) */
  const [photos, setPhotos] = useState<GarmentPhoto[]>([])
  /** an outfit drafted as a pattern program or spec (docs/pattern-api.md): hand-drafted or Claude's */
  const [program, setProgram] = useState<{ mode: 'code' | 'spec'; source: string; name: string; from: 'preset' | 'claude' } | null>(null)
  const [built, setBuilt] = useState<BuiltGarment[] | null>(null)
  const builtFor = useRef<string | null>(null)
  // the latest list, for uploads run one after another (each sees the garments the last one added)
  const foundRef = useRef<Found[]>([])
  useEffect(() => void (foundRef.current = found), [found])
  const [editing, setEditing] = useState(0)
  const [autoCheck, setAutoCheck] = useState(true)
  const [status, setStatus] = useState('Loading mannequin…')
  const [claude, setClaude] = useState<ClaudeState>(null)
  const [review, setReview] = useState<Review | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => void claudeHealth().then(setClaude), [])

  useEffect(() => {
    let cancelled = false
    loadBodySet(gender).then((b) => {
      if (cancelled) return
      setBody(b)
      setStatus('')
    })
    return () => void (cancelled = true)
  }, [gender])

  // The user's face (src/face). A photo opens the head studio: the bald head alone, fitted to the photo's
  // landmarks (MediaPipe), then sculpted by Claude, who compares renders of the head with the photo and
  // sets the face controls. Applied, it goes on the body (and the old hair comes off).
  /** a head being made: by the landmark fit (`fit`, `scan`) then Claude, or by Claude alone (no fit: no photo painting) */
  type FaceWork = { gender: Gender; morphs: FaceMorphs; values: Record<string, number>; fit?: FaceFit; scan?: FaceScan; photo: HTMLCanvasElement; crop: string; texture?: THREE.Texture; tone: string; eyeColor?: string; hair?: HairStyle; method: 'landmarks' | 'claude'; note: string }
  const [candidate, setCandidate] = useState<FaceWork | null>(null)
  const [face, setFace] = useState<(FaceWork & { offset: Float32Array; paint: Float32Array }) | null>(null)
  const [studio, setStudio] = useState(false)
  const [facePhotoOn, setFacePhotoOn] = useState(true)
  const [faceToneOn, setFaceToneOn] = useState(true)
  const shapeOf = (w: FaceWork) => {
    const plus = new Float32Array(w.morphs.labels.length), minus = new Float32Array(w.morphs.labels.length)
    w.morphs.labels.forEach((l, k) => { const v = w.values[l] ?? 0; if (v > 0) plus[k] = v; else minus[k] = -v })
    const controls = faceOffset(w.morphs, { plus, minus })
    if (!w.fit) return controls
    // then the rest of the way onto the photo's own landmarks (the controls alone move features millimetres)
    const shaped = withFace(body!, w.morphs, controls).positions('M', 'apose')
    const rest = w.fit.warp(shaped)
    for (let i = 0; i < controls.length; i++) controls[i] += rest[i]
    return controls
  }
  const candidateOffset = useMemo(() => (candidate ? shapeOf(candidate) : null), [candidate])
  const stageBody = useMemo(() => {
    if (!body) return body
    if (studio && candidate && candidateOffset && candidate.gender === body.gender) return withFace(body, candidate.morphs, candidateOffset)
    if (face && face.gender === body.gender) return withFace(body, face.morphs, face.offset)
    return body
  }, [body, face, studio, candidate, candidateOffset])
  const shown = studio ? candidate : face

  // Gender or size changes re-cut the garment for the new body; pose changes just carry it.
  useEffect(() => {
    if (!stageBody || stageBody.gender !== gender) return
    stage.setBody(stageBody, size, pose)
  }, [stage, stageBody, gender, size, pose])

  useEffect(() => {
    stage.setHeadStudio(studio)
    // a new head has no hair until one is chosen
    // painted on, the photo's own brows replace the 3D ones (both showed, doubled)
    const work = studio ? candidate : face
    // the studio is bald; a new head on the body wears the hair read from its photo (none until chosen)
    stage.setHairStyle(studio ? 'none' : face && face.gender === gender ? face.hair ?? 'none' : 'default', !(work && work.gender === gender && facePhotoOn))
  }, [stage, studio, face, candidate, gender, stageBody, facePhotoOn])

  useEffect(() => {
    const work = shown && shown.gender === gender ? shown : null
    // only a head fitted to the photo's landmarks can have the photo painted on (Claude alone has no points)
    if (work && body && work.fit && work.scan && work.texture) {
      const offset = studio ? candidateOffset! : (work as typeof face)!.offset
      const shaped = withFace(body, work.morphs, offset).positions('M', 'apose')
      stage.setFacePhoto({ texture: work.texture, paint: facePaint(body, shaped, work.fit, work.scan) })
    } else stage.setFacePhoto(undefined)
    stage.setEyeColor(work?.eyeColor ?? '#4a2c1a')
    stage.showFacePhoto(!!work && facePhotoOn)
  }, [stage, shown, gender, facePhotoOn, stageBody, studio, candidateOffset, body])

  useEffect(() => stage.setSkin(shown && faceToneOn && shown.gender === gender ? shown.tone : tone), [stage, tone, shown, faceToneOn, gender])

  async function onFace(file: File) {
    if (!body) return
    setBusy(true)
    try {
      setStatus('Finding the face…')
      const bitmap = await createImageBitmap(file)
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale)
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const scan = await detectFace(canvas)
      if (!scan) { setStatus('No face found in that photo. A clear, front-on face works best.'); return }
      setStatus('Fitting the head to the face\'s landmarks…')
      const morphs = await loadFaceMorphs(body.gender, body.vertexCount)
      const fm = await (await fetch(`/models/face-map-${body.gender}.json`)).json() as { map: number[]; offsets: number[][]; rotation: number[] }
      const fit = fitFace(morphs, body.positions('M', 'apose'), Int32Array.from(fm.map), Float32Array.from(fm.offsets.flat()), scan, { modelRotation: fm.rotation })
      const values: Record<string, number> = {}
      morphs.labels.forEach((l, k) => { const v = fit.face.plus[k] - fit.face.minus[k]; if (Math.abs(v) > 0.005) values[l] = +v.toFixed(2) })
      const texture = new THREE.CanvasTexture(delight(canvas, scan))
      texture.colorSpace = THREE.SRGBColorSpace
      texture.anisotropy = 8
      let work: FaceWork = { gender: body.gender, morphs, values, fit, scan, photo: canvas, crop: faceCrop(canvas, scan), texture, tone: skinTone(canvas, scan), method: 'landmarks',
        note: `Landmark fit: the gap went from ${(fit.start * 1000).toFixed(1)} to ${(fit.error * 1000).toFixed(1)} mm.` }
      setCandidate(work)
      setStudio(true)
      setStatus(work.note)
      if (claude?.ok) work = await sculptRounds(work, 1)
    } catch (e) {
      setStatus(`Couldn't fit the face: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  /** Claude builds the head entirely from the photo: no landmarks, it sets every control over four rounds. */
  async function onFaceClaude(file: File) {
    if (!body || !claude?.ok) return
    setBusy(true)
    try {
      const bitmap = await createImageBitmap(file)
      const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale)
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const morphs = await loadFaceMorphs(body.gender, body.vertexCount)
      const work: FaceWork = { gender: body.gender, morphs, values: {}, photo: canvas, crop: canvas.toDataURL('image/jpeg', 0.9), tone, method: 'claude', note: 'Claude is building the head from the photo…' }
      setCandidate(work)
      setStudio(true)
      await sculptRounds(work, 4)
    } catch (e) {
      setStatus(`Claude couldn't build the head: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  /** Claude compares studio renders of the head with the photo and sets the controls, up to `rounds` times. */
  async function sculptRounds(start: FaceWork, rounds: number) {
    let work = start
    const full = start.method === 'claude'
    for (let round = 1; round <= rounds; round++) {
      // let the head take its new shape (a body change morphs over 0.9 s), then look from three sides
      await new Promise((r) => setTimeout(r, 1300))
      const c = stage.headCentre()
      const at = (dx: number, dz: number) => stage.renderView!([c[0] + dx, c[1] + 0.02, c[2] + dz], c)
      const views = { front: at(0, 0.62), three: at(0.42, 0.46), side: at(0.62, 0) }
      setStatus(`Claude is ${full ? 'building the head from the photo' : 'comparing the head with the photo and sculpting it'} (round ${round} of ${rounds})…`)
      // Claude only refines depth, in small steps: the face-on proportions come from the photo's own points
      // (the landmark warp). Free to set any control by whole steps, it distorted the face (an over-tall mouth,
      // a wide jaw, bulging eyes): judging shape by eye from renders isn't that precise.
      // Claude alone sets every control (but moving a head on the neck), up to 0.5 a round
      const allowed = work.morphs.labels.filter((l) => (full ? !/head-trans|head-angle|head-age/.test(l) : DEPTH.test(l)))
      const step = full ? 0.5 : 0.25
      const r = await sculptFace(work.crop, views, Object.fromEntries(allowed.map((l) => [l, +(work.values[l] ?? 0).toFixed(2)])), round, full ? 'full' : 'depth')
      const values = { ...work.values }
      for (const [l, v] of Object.entries(r.controls ?? {})) {
        if (!allowed.includes(l) || !Number.isFinite(v)) continue
        const was = values[l] ?? 0
        values[l] = Math.max(-1, Math.min(1, was + Math.max(-step, Math.min(step, Number(v) - was))))
      }
      const eye = r.features?.eyeColor && /^#[0-9a-f]{6}$/i.test(r.features.eyeColor) ? r.features.eyeColor : work.eyeColor
      // the hair Claude read, as one of the styles there are (more to come)
      const said = r.features?.hair ?? ''
      const hair: HairStyle | undefined = /braid|cornrow/i.test(said) ? 'braids' : /afro|coil|kink|curl|twa/i.test(said) ? 'afro' : work.hair
      const changed = Object.keys(r.controls ?? {}).length
      const skin = full && r.features?.skinColor && /^#[0-9a-f]{6}$/i.test(r.features.skinColor) ? r.features.skinColor : work.tone
      work = { ...work, values, eyeColor: eye, hair, tone: skin, note: `Claude, round ${round}: ${r.score}/10. ${r.verdict}${r.features?.hair ? ` Hair: ${r.features.hair}.` : ''}` }
      setCandidate(work)
      setStatus(`${work.note} (${changed} control${changed === 1 ? '' : 's'} changed)`)
      if (r.score >= 8 || !changed) break
    }
    return work
  }

  async function refineHead() {
    if (!candidate) return
    setBusy(true)
    try { await sculptRounds(candidate, 1) } catch (e) { setStatus(`Claude couldn't sculpt it: ${(e as Error).message}`) } finally { setBusy(false) }
  }

  function applyHead() {
    if (!candidate) return
    setFace({ ...candidate, offset: shapeOf(candidate), paint: new Float32Array(0) })
    setStudio(false)
    setStatus('The new head is on the body. Its hair is off until one is chosen.')
  }

  // Gender changes swap to that mannequin's first outfit when the current one doesn't fit it.
  useEffect(() => {
    const fits = (id?: string) => !id || id === CUSTOM || item(id)!.genders.includes(gender)
    if (!fits(topId) || !fits(bottomId)) wearOutfit(OUTFITS[gender][0])
  }, [gender]) // eslint-disable-line react-hooks/exhaustive-deps

  // the worn garments from the photo: a dress (or the outermost top) and a bottom
  const customTop = (() => {
    const worn = found.filter((f) => f.wear && f.read.slot !== 'bottom')
    return worn.find((f) => f.read.slot === 'dress') ?? worn.at(-1)
  })()
  const customBottom = found.find((f) => f.wear && f.read.slot === 'bottom')

  // sew the pattern program for this body whenever it, the size or the gender changes
  useEffect(() => {
    if (!program || !body || body.gender !== gender) { setBuilt(null); return }
    let cancelled = false
    buildPattern(program.mode, program.source, body, size)
      .then((b) => { if (cancelled) return; builtFor.current = program.source; setBuilt(b.sort((x, y) => x.layer - y.layer)) })
      .catch((e) => { if (cancelled) return; builtFor.current = program.source; setBuilt(null); setStatus(`The pattern didn't sew: ${(e as Error).message}`) })
    return () => void (cancelled = true)
  }, [program, body, gender, size])

  const outfit = useMemo<Outfit>(() => {
    if (program && built) return { layers: built.map((g) => ({ garment: g.garment, fabric: g.fabric, color: g.color, look: programLook(g), kind: g.kind, fit: g.fit ?? 'regular', hold: g.hold ?? 'shoulders' })) }
    const top = topId === CUSTOM ? undefined : item(topId) as TopItem | undefined
    const topPart: Outfit['top'] = topId === CUSTOM
      ? customTop && { spec: specOf(customTop.read), look: lookOf(customTop), custom: customTop.read }
      : top && { spec: top.spec, look: top.photo && { texture: swatch(top.id), uv: 'tiled', tile: top.photo.tile }, pattern: top.pattern }
    // a dress is worn on its own
    // a dress is worn on its own, unless the photo layered it over bottoms (an open dress over a skirt)
    const dress = topId === CUSTOM ? customTop?.read.slot === 'dress' && bottomId !== CUSTOM : top?.slot === 'dress'
    const bottom = bottomId && bottomId !== CUSTOM ? (item(bottomId) as BottomItem) : undefined
    const bottomPart: Outfit['bottom'] = dress ? undefined : bottomId === CUSTOM
      ? customBottom && { spec: bottomSpecOf(customBottom.read), look: lookOf(customBottom), custom: customBottom.read }
      : bottom && { spec: bottom.spec, look: bottom.photo && { texture: swatch(bottom.id), uv: 'tiled', tile: bottom.photo.tile }, pattern: bottom.pattern }
    return { top: topPart, bottom: bottomPart }
  }, [topId, bottomId, customTop, customBottom, program, built])

  useEffect(() => {
    if (!body || body.gender !== gender) return
    stage.setOutfit(outfit)
  }, [stage, body, gender, size, outfit])

  function wearTop(t: TopItem) {
    setProgram(null)
    setTopId(t.id)
    if (t.slot === 'dress') setBottomId(undefined)
    else if (!bottomId) setBottomId(OUTFITS[gender][0][2])
  }

  function wearBottom(b: BottomItem | undefined) {
    setProgram(null)
    setBottomId(b?.id)
    if (b && item(topId)?.slot === 'dress') wearTop(item('tee') as TopItem)
  }

  function wearOutfit([, topOrDress, bottom]: [string, string, string?]) {
    setProgram(null)
    setTopId(item(topOrDress)!.id)
    setBottomId(bottom)
  }

  /** Put on what was found: custom pieces replace the wardrobe's, a dress takes the bottom off. */
  function wearFound(list: Found[]) {
    setProgram(null)
    const worn = list.filter((f) => f.wear)
    const hasTop = worn.some((f) => f.read.slot !== 'bottom'), hasBottom = worn.some((f) => f.read.slot === 'bottom')
    const dress = worn.some((f) => f.read.slot === 'dress')
    if (hasTop) setTopId(CUSTOM)
    else if (topId === CUSTOM) setTopId(OUTFITS[gender][0][1])
    if (hasBottom) setBottomId(CUSTOM)
    else if (dress) setBottomId(undefined)
    else if (bottomId === CUSTOM || !bottomId) setBottomId(OUTFITS[gender][0][2])
  }

  function updateFound(i: number, change: Partial<GarmentRead> | { wear: boolean }) {
    setFound((list) => {
      const edit = (r: GarmentRead, c: Partial<GarmentRead>): GarmentRead => {
        const next = { ...r, ...c, adjust: { ...r.adjust } }
        // a garment drawn from its trace takes the edit as an adjustment on top of it
        if (c.hem !== undefined) next.adjust.hem = c.hem
        if (c.sleeveAt !== undefined) next.adjust.sleeveAt = c.sleeveAt
        if (c.fit && c.fit !== r.fit) {
          const order = ['tight', 'regular', 'relaxed', 'oversized']
          next.adjust.easeScale = (r.adjust.easeScale ?? 1) * (order.indexOf(c.fit) < order.indexOf(r.fit) ? 0.5 : 1.8)
        }
        return next
      }
      const next = list.map((f, k) => (k !== i ? f : 'wear' in change ? { ...f, wear: change.wear } : { ...f, read: edit(f.read, change) }))
      // only one dress, top and bottom at a time
      if ('wear' in change && change.wear) {
        const slot = next[i].read.slot
        next.forEach((f, k) => {
          if (k === i || !f.wear) return
          // one top layer and one bottom: a dress can go over a bottom, as it was worn in the photo
          const clash = slot === 'bottom' ? f.read.slot === 'bottom'
            : f.read.slot !== 'bottom'
          if (clash) next[k] = { ...f, wear: false }
        })
      }
      wearFound(next)
      return next
    })
  }

  /** Add a photo; Claude drafts the outfit from all of them when asked (one of the build buttons). */
  async function onUpload(file: File) {
    setBusy(true)
    try {
      setStatus('Reading photo…')
      const processed = await processGarmentPhoto(file, setStatus)
      setPhotos((list) => [...list, processed])
      setStatus('Photo added. Add more (a top and bottoms, say), then choose how Claude builds the outfit.')
    } catch (e) {
      setStatus(`Could not read the photo: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  /** The tracing method: Claude traces each garment's outline and the app draws it (see docs/garment-mapping.md). */
  async function traceAll() {
    setBusy(true)
    setReview(null)
    try { for (const p of photos) await traceOne(p) } finally { setBusy(false) }
  }

  /**
   * Claude drafts the outfit in the photos itself, as the workshop outfits are drafted: a pattern program
   * (`code`, run sandboxed) or a pattern spec (`spec`, data only). Then it checks the render against the
   * photos and corrects its own pattern.
   */
  async function draftWithClaude(mode: 'code' | 'spec') {
    if (!photos.length) return
    const started = performance.now()
    setBusy(true)
    setReview(null)
    try {
      const jpegs = photos.map((p) => p.jpeg)
      setStatus(`Claude is studying the photo${photos.length > 1 ? 's' : ''} and drafting the pattern ${mode === 'code' ? 'program' : 'spec'} (1–3 min)…`)
      const r = await buildWithClaude(mode, jpegs)
      const source = mode === 'code' ? r.program : JSON.stringify(r)
      if (!source) throw new Error('Claude returned no pattern')
      const names = mode === 'spec' ? ((r as { garments?: { name?: string }[] }).garments ?? []).map((g) => g.name).filter(Boolean).join(' + ') : ''
      const name = (mode === 'code' ? r.note : names) || 'Claude\'s pattern'
      builtFor.current = null
      setProgram({ mode, source, name, from: 'claude' })
      setStatus(`Claude drafted: ${name} (${((performance.now() - started) / 1000).toFixed(0)} s)`)
      if (autoCheck) await correctDraft(mode, source, jpegs)
    } catch (e) {
      setStatus(`Claude couldn't draft it: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  /** Claude compares the render with the photos and rewrites its pattern where it's off: up to two rounds. */
  async function correctDraft(mode: 'code' | 'spec', source: string, jpegs: string[]) {
    let current = source
    for (let round = 1; round <= 2; round++) {
      // the cloth never stops moving: look once this pattern is sewn and the drape has taken shape
      setStatus(`Letting the cloth take shape (check ${round})…`)
      await waitFor(() => builtFor.current === current, 60000)
      await new Promise((r) => setTimeout(r, 500))
      await waitFor(() => stage.settled, 4000)
      await new Promise((r) => requestAnimationFrame(r))
      const render = canvasRef.current!.toDataURL('image/png')
      setStatus(`Claude is comparing the result with the photo${jpegs.length > 1 ? 's' : ''} (check ${round})…`)
      const r = await refineBuild(mode, jpegs, render, current)
      const next = mode === 'code' ? r.program : r.spec ? JSON.stringify(r.spec) : null
      const verdict = (mode === 'code' ? r.note?.replace(/^SCORE\s*\d+\/10:?\s*/i, '') : r.verdict) ?? ''
      const score = Number(r.score ?? 0)
      setReview({ score, verdict, issues: [] })
      if (!next || score >= 8) { setStatus(`Claude: ${verdict}`); return }
      current = next
      builtFor.current = null
      setProgram((p) => p && { ...p, source: next })
      setStatus(`Claude corrected its pattern (check ${round}, ${score}/10): ${verdict}`)
    }
  }

  async function traceOne(processed: GarmentPhoto) {
    const started = performance.now()
    try {
      if (!claude?.ok) {
        setStatus('Claude bridge unavailable: it reads what the clothes are and where they sit on the body. Start it with `npm run dev`.')
        return
      }
      setStatus('Claude is tracing each garment; MediaPipe is finding the body\'s joints…')
      // Claude reads the garments' structure; MediaPipe finds the wearer's joints precisely
      const [raw, joints] = await Promise.all([analyzeGarment(processed.jpeg), detectJoints(processed.source)])
      const read = sanitizeRead(raw)
      for (const g of read.garments) {
        g.joints = joints
        if (g.structure) g.structure.aspect = processed.source.width / processed.source.height
      }
      if (!read.garments.length) {
        setStatus('Claude found no garment to try on in this photo.')
        return
      }
      // each garment is cut from the photo by Claude's outline; its swatch fills what the photo hides
      const list: Found[] = read.garments.map((g) => {
        const sw = g.swatch && swatchCanvas(processed, g.swatch)
        const cut = refineWithClaude(processed, g.outline, sw?.canvas)
        // plain cloth keeps Claude's colour: the photo's average pixel includes the shading, and turned white grey
        const read = g
        return { read, wear: false, cut, source: processed, photoTexture: canvasTexture(cut.texture), fabric: sw ? { texture: canvasTexture(sw.canvas), tile: g.swatchCm / 100 * sw.widthShare } : undefined }
      })
      // dress the model as the photo is dressed: a dress (or the outermost top), with the bottoms if it
      // was worn over them; a flat-lay of separates is worn together too
      const dress = list.findIndex((f) => f.read.slot === 'dress')
      const tops = list.map((f, i) => [f, i] as const).filter(([f]) => f.read.slot !== 'bottom')
      if (dress >= 0) list[dress].wear = true
      else if (tops.length) list[tops.at(-1)![1]].wear = true
      const bottom = list.findIndex((f) => f.read.slot === 'bottom')
      if (bottom >= 0 && (dress < 0 || read.view === 'worn')) list[bottom].wear = true
      // added to what's already there: a top from one photo, trousers from another. What this photo puts on
      // replaces the same layer from earlier photos
      const prev = foundRef.current.map((f) => {
        const clash = list.some((n) => n.wear && (n.read.slot === 'bottom' ? f.read.slot === 'bottom' : f.read.slot !== 'bottom'))
        return clash ? { ...f, wear: false } : f
      })
      const all = [...prev, ...list]
      foundRef.current = all
      setFound(all)
      setEditing(Math.max(0, prev.length + list.findIndex((f) => f.wear)))
      wearFound(all)
      setStatus(`Claude found ${list.map((f) => f.read.type + (f.read.structure ? '' : ' (template)')).join(', ')} (${read.view} photo${joints ? ', joints found' : ''}, read in ${((performance.now() - started) / 1000).toFixed(0)} s)`)
      if (autoCheck) {
        // look again once it has draped: compare the render with the photo and correct what's off
        await new Promise((r) => setTimeout(r, 300))
        await check(all)
      }
    } catch (e) {
      setStatus(`Could not read the photo: ${(e as Error).message}`)
    }
  }

  /**
   * Claude compares the draped render with the photo and sends back corrected traces, which redraw the
   * garments; up to two rounds while it still finds something wrong. (Corrected as labels only, as it
   * first was, a check couldn't change a garment drawn from its trace.)
   */
  async function check(list = found) {
    if (!canvasRef.current || !body) return
    if (!list.some((f) => f.wear)) {
      setStatus('Upload a photo of clothes first: Claude checks the model against it.')
      return
    }
    let current = list
    for (let round = 1; round <= 2; round++) {
      // the cloth keeps moving; Claude looks once the drape has taken shape (a few seconds), not after it stops
      setStatus(round === 1 ? 'Letting the cloth take shape…' : 'Redrawn: letting the cloth take shape…')
      await new Promise((r) => setTimeout(r, 500))
      await waitFor(() => stage.settled, 4000)
      await new Promise((r) => requestAnimationFrame(r))
      const render = canvasRef.current.toDataURL('image/png')
      setStatus(`Claude is comparing the result with the photo (round ${round})…`)
      const worn = current.map((f, index) => ({ f, index })).filter(({ f }) => f.wear)
      // one comparison per photo the worn garments came from
      const sources = [...new Set(worn.map(({ f }) => f.source))]
      const replies = await Promise.all(sources.map((src) => refineRender(render, src.jpeg,
        worn.filter(({ f }) => f.source === src).map(({ f, index }) => ({ index, ...f.read.raw })), pose)))
      const score = Math.min(...replies.map((r) => r.score))
      const r = { score, verdict: replies.map((q) => q.verdict).join(' '), issues: replies.flatMap((q) => q.issues ?? []), garments: replies.flatMap((q) => q.garments ?? []) }
      setReview({ score: r.score, verdict: r.verdict, issues: r.issues })
      const fixes = r.garments.filter((g) => worn.some(({ index }) => index === g.index))
      if (!fixes.length || r.score >= 8) { setStatus(`Claude: ${r.verdict}`); return }
      current = current.map((f, i) => {
        const fix = fixes.find((g) => g.index === i)
        if (!fix) return f
        const { index: _, ...rawFix } = fix
        // the corrected trace, read like the first one; the photo's joints, swatch and cut stay
        const merged = { ...f.read.raw, ...rawFix }
        // (read as 'other': the joints' measurements come from MediaPipe, kept below)
        const again = sanitizeRead({ view: 'other', garments: [merged] }).garments[0]
        if (!again) return f
        if (again.structure && f.read.structure) again.structure.aspect = f.read.structure.aspect
        return { ...f, read: { ...again, joints: f.read.joints, print: f.read.print, primaryColor: f.read.primaryColor } }
      })
      setFound(current)
      setStatus(`Claude corrected ${fixes.length} garment${fixes.length > 1 ? 's' : ''} (round ${round}): ${r.verdict}`)
    }
  }

  async function onReview() {
    setBusy(true)
    try { if (program?.from === 'claude') await correctDraft(program.mode, program.source, photos.map((p) => p.jpeg)); else await check() } catch (e) { setStatus(`Review failed: ${(e as Error).message}`) } finally { setBusy(false) }
  }

  const m = body?.measurements(size)
  const wardrobe = (slot: WardrobeItem['slot']) => WARDROBE.filter((w) => w.slot === slot && w.genders.includes(gender))
  const edit = found[editing]

  return (
    <div className="app">
      <aside className="panel">
        <h1>Cloth Demo</h1>
        <a href="/outfits">Outfit workshop</a>

        <section>
          <h2>Mannequin</h2>
          <Segmented value={gender} options={[['female', 'Female'], ['male', 'Male']]} onChange={setGender} />
          <Segmented value={size} options={SIZES.map((s) => [s, s])} onChange={setSize} />
          <Segmented value={pose} options={POSES.map((p) => [p.id, p.label])} onChange={setPose} />
          <div className="tones" role="radiogroup" aria-label="Skin tone">
            {SKIN_TONES.map(([label, hex]) => (
              <button key={hex} role="radio" aria-checked={hex === tone} title={label} className={hex === tone ? 'active' : ''} style={{ background: hex }} onClick={() => setTone(hex)} />
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={turntable} onChange={(e) => setTurntable(e.target.checked)} /> Turntable
          </label>
          <h3>Your face</h3>
          <label className={`upload ${busy ? 'disabled' : ''}`}>
            <input type="file" accept="image/*" disabled={busy} onChange={(e) => e.target.files?.[0] && onFace(e.target.files[0])} />
            {candidate || face ? 'Use another face photo' : 'Upload a photo of your face'}
          </label>
          <label className={`upload ${busy || !claude?.ok ? 'disabled' : ''}`}>
            <input type="file" accept="image/*" disabled={busy || !claude?.ok} onChange={(e) => e.target.files?.[0] && onFaceClaude(e.target.files[0])} />
            Claude builds the head (no landmarks)
          </label>
          <p className="hint">Front-on, even light, nothing across the face. The head studio opens: the head alone, fitted to the photo, then sculpted by Claude. Turn it to check it, then put it on the body.</p>
          {studio && candidate && (
            <div className="studio">
              <img src={candidate.crop} alt="Your photo" />
              <p className="hint">{candidate.note}</p>
              <div className="row builds">
                <button disabled={busy || !claude?.ok} onClick={refineHead}>Claude: sculpt again</button>
                <button disabled={busy} onClick={applyHead}>Apply to body</button>
                <button disabled={busy} className="link" onClick={() => { setStudio(false); setCandidate(null) }}>Discard</button>
              </div>
            </div>
          )}
          {!studio && candidate && <button className="link" onClick={() => setStudio(true)}>Open the head studio</button>}
          {shown && shown.gender === gender && (
            <>
              <label className="check"><input type="checkbox" checked={facePhotoOn} onChange={(e) => setFacePhotoOn(e.target.checked)} /> Paint the photo on the face</label>
              <label className="check"><input type="checkbox" checked={faceToneOn} onChange={(e) => setFaceToneOn(e.target.checked)} /> Skin tone from the photo <span className="swatch-dot" style={{ background: shown.tone }} /></label>
              {face && !studio && (
                <label className="field"><span>Hair</span>
                  <select value={face.hair ?? 'none'} onChange={(e) => setFace({ ...face, hair: e.target.value as HairStyle })}>
                    <option value="none">None</option>
                    <option value="afro">Afro / short coils</option>
                    <option value="braids">Braids / cornrows</option>
                    <option value="default">The model's own</option>
                  </select>
                </label>
              )}
              {face && !studio && <button className="link" onClick={() => setFace(null)}>Take the face off</button>}
            </>
          )}
          {m && (
            <table className="measure">
              <thead><tr><th /><th>Model</th><th>Chart</th></tr></thead>
              <tbody>
                {(['bust', 'waist', 'hip'] as const).map((k) => (
                  <tr key={k}><td>{k}</td><td>{m.fitted[k].toFixed(0)} cm</td><td>{m.chart[k]} cm</td></tr>
                ))}
                <tr><td>height</td><td>{m.fitted.height.toFixed(0)} cm</td><td /></tr>
              </tbody>
            </table>
          )}
        </section>

        <section>
          <h2>Wardrobe</h2>
          <div className="outfits">
            {OUTFITS[gender].map((o) => (
              <button key={o[0]} className={o[1] === topId && o[2] === bottomId ? 'active' : ''} onClick={() => wearOutfit(o)}>{o[0]}</button>
            ))}
          </div>
          <h3>Drafted from guide photos</h3>
          <div className="outfits">
            {PROGRAM_OUTFITS.filter((o) => o.genders.includes(gender)).map((o) => (
              <button key={o.id} className={program?.source === o.source ? 'active' : ''} onClick={() => { builtFor.current = null; setProgram({ mode: 'code', source: o.source, name: o.name, from: 'preset' }) }}>{o.name}</button>
            ))}
          </div>
          <Cards title="Tops" items={wardrobe('top')} active={topId} onPick={(i) => wearTop(i as TopItem)} />
          <Cards title="Bottoms" items={wardrobe('bottom')} active={bottomId} onPick={(i) => wearBottom(i as BottomItem)} none={() => wearBottom(undefined)} />
          {wardrobe('dress').length > 0 && <Cards title="Dresses" items={wardrobe('dress')} active={topId} onPick={(i) => wearTop(i as TopItem)} />}
          <Credits ids={[topId, bottomId]} />
        </section>

        <section>
          <h2>Your own clothes</h2>
          <label className={`upload ${busy ? 'disabled' : ''}`}>
            <input type="file" accept="image/*" multiple disabled={busy} onChange={async (e) => {
              const files = [...(e.target.files ?? [])]
              for (const file of files) await onUpload(file)
            }} />
            {photos.length ? 'Add another photo (top, bottoms…)' : 'Upload photos of any clothes'}
          </label>
          <PhotoGuide />
          {photos.length > 0 && (
            <>
              <div className="photos">{photos.map((p, i) => <img key={i} src={p.jpeg} alt={`Upload ${i + 1}`} />)}</div>
              <p className="hint">Build the outfit in {photos.length > 1 ? 'these photos' : 'this photo'}:</p>
              <div className="row builds">
                <button disabled={busy || !claude?.ok} onClick={() => draftWithClaude('code')} title="Claude writes a pattern program, as the workshop outfits are drafted">Claude: pattern code</button>
                <button disabled={busy || !claude?.ok} onClick={() => draftWithClaude('spec')} title="Claude describes the pieces in the pattern spec format">Claude: pattern spec</button>
                <button disabled={busy || !claude?.ok} onClick={traceAll} title="Claude traces each garment; the app draws it">Trace</button>
                <button disabled={busy} className="link" onClick={() => { setPhotos([]); setFound([]); setProgram(null) }}>Clear</button>
              </div>
            </>
          )}
          {program && (
            <details className="guide">
              <summary>{program.from === 'claude' ? `Claude's pattern ${program.mode === 'code' ? 'program' : 'spec'}` : 'Pattern program'}: {program.name}</summary>
              <pre className="source">{program.source}</pre>
            </details>
          )}
          <label className="check">
            <input type="checkbox" checked={autoCheck} onChange={(e) => setAutoCheck(e.target.checked)} /> Let Claude check the result against the photo and correct it
          </label>
          {found.length > 0 && <button className="link" onClick={() => { setFound([]); wearFound([]) }}>Clear uploaded clothes</button>}
          {found.length > 0 && (
            <ul className="found">
              {found.map((f, i) => (
                <li key={i} className={i === editing ? 'active' : ''}>
                  <label className="check">
                    <input type="checkbox" checked={f.wear} onChange={(e) => updateFound(i, { wear: e.target.checked })} />
                  </label>
                  <img src={f.cut.texture.toDataURL()} alt="" />
                  <button className="link" onClick={() => setEditing(i)}>
                    <b>{f.read.type}</b>
                    <span>{f.read.slot} · {f.read.slot === 'bottom' ? `${levelName(f.read.top)} to ${levelName(f.read.hem)}` : `to ${levelName(f.read.hem)}`}{f.read.slot !== 'bottom' && f.read.sleeve !== 'none' ? ` · sleeves to ${f.read.sleeve}` : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {edit && (
            <div className="editor">
              <Field label="Hem at" value={String(Math.round(edit.read.hem))} options={LEVELS.map((l, i) => [String(i), l.replace('_', ' ')])} onChange={(v) => updateFound(editing, { hem: Number(v) })} />
              {edit.read.slot === 'bottom' ? (
                <>
                  <Field label="Kind" value={edit.read.bottomKind} options={['trousers', 'shorts', 'skirt'].map((v) => [v, v])} onChange={(v) => updateFound(editing, { bottomKind: v as GarmentRead['bottomKind'] })} />
                  {edit.read.bottomKind === 'skirt'
                    ? <Field label="Skirt" value={edit.read.skirt} options={['straight', 'aline', 'full'].map((v) => [v, v])} onChange={(v) => updateFound(editing, { skirt: v as GarmentRead['skirt'] })} />
                    : <Field label="Legs" value={edit.read.legs} options={['skinny', 'straight', 'wide', 'flared'].map((v) => [v, v])} onChange={(v) => updateFound(editing, { legs: v as GarmentRead['legs'] })} />}
                </>
              ) : (
                <>
                  <Field label="Sleeves to" value={edit.read.sleeve} options={Object.keys(SLEEVE_ENDS).map((v) => [v, v])} onChange={(v) => updateFound(editing, { sleeve: v as SleeveEnd, sleeveAt: SLEEVE_ENDS[v as SleeveEnd] })} />
                  <Field label="Neckline" value={edit.read.neckline} options={['crew', 'v', 'scoop', 'boat', 'collar', 'turtleneck', 'off_shoulder', 'strapless'].map((v) => [v, v.replace('_', ' ')])} onChange={(v) => updateFound(editing, { neckline: v as GarmentRead['neckline'] })} />
                  {edit.read.slot === 'dress' && <Field label="Skirt" value={edit.read.skirt} options={['straight', 'aline', 'full'].map((v) => [v, v])} onChange={(v) => updateFound(editing, { skirt: v as GarmentRead['skirt'] })} />}
                </>
              )}
              <Field label="Fit" value={edit.read.fit} options={['tight', 'regular', 'relaxed', 'oversized'].map((v) => [v, v])} onChange={(v) => updateFound(editing, { fit: v as GarmentRead['fit'] })} />
              <Field label="Print" value={edit.read.print} options={[['plain', 'plain colour'], ...(edit.fabric ? [['allover', 'fabric from photo']] : []), ...(edit.read.slot !== 'bottom' ? [['placed', 'photo as printed']] : [])] as [string, string][]} onChange={(v) => updateFound(editing, { print: v as GarmentRead['print'] })} />
              {edit.read.print === 'plain' && (
                <label className="field"><span>Colour</span><input type="color" value={edit.read.primaryColor} onChange={(e) => updateFound(editing, { primaryColor: e.target.value })} /></label>
              )}
              {edit.read.details.length > 0 && <p className="hint">Not modelled yet: {edit.read.details.join(', ')}.</p>}
            </div>
          )}
          <div className="row">
            <button onClick={() => stage.setOutfit(outfit)}>Re-drape</button>
            <label className="check">
              <input type="checkbox" checked={showGarment} onChange={(e) => setShowGarment(e.target.checked)} /> Show
            </label>
          </div>
        </section>

        <section>
          <h2>Claude</h2>
          <p className={`pill ${claude?.ok ? 'ok' : 'off'}`}>
            {claude === null ? 'Checking…' : claude.ok ? `Connected · ${claude.version}` : 'Not connected'}
          </p>
          {claude && !claude.ok && <p className="hint">{claude.error}</p>}
          <button disabled={!claude?.ok || busy} onClick={onReview}>Ask Claude to check and correct</button>
          {review && (
            <div className="review">
              <p>Match <b>{review.score}/10</b></p>
              <p>{review.verdict}</p>
              <ul>{review.issues.map((i) => <li key={i}>{i}</li>)}</ul>
            </div>
          )}
        </section>

        {status && <p className="status">{status}</p>}
        <p className="credit">Body model: Anny (NAVER LABS Europe, Apache-2.0)</p>
      </aside>
      <main className="stage">
        <Viewer stage={stage} turntable={turntable} garmentVisible={showGarment} focus={studio ? 'head' : 'body'} onCanvas={(c) => (canvasRef.current = c)} />
      </main>
    </div>
  )
}

function Field({ label, value, options, onChange }: { label: string; value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  )
}

function Cards({ title, items, active, onPick, none }: {
  title: string
  items: WardrobeItem[]
  active?: string
  onPick: (item: WardrobeItem) => void
  none?: () => void
}) {
  return (
    <div className="cards-group">
      <h3>{title}</h3>
      <div className="cards">
        {items.map((i) => (
          <button key={i.id} className={`card ${i.id === active ? 'active' : ''}`} onClick={() => onPick(i)} title={i.name}>
            {i.photo ? <img src={`/wardrobe/${i.id}-card.jpg`} alt="" /> : <span className="swatch" style={{ background: i.spec.primaryColor }} />}
            <span>{i.name}</span>
          </button>
        ))}
        {none && (
          <button className={`card ${active ? '' : 'active'}`} onClick={none}>
            <span className="swatch none" />
            <span>None</span>
          </button>
        )}
      </div>
    </div>
  )
}

function Credits({ ids }: { ids: (string | undefined)[] }) {
  const credits = ids.flatMap((id) => (id && item(id)?.photo ? [item(id)!.photo!.credit] : []))
  if (!credits.length) return null
  return (
    <p className="hint">
      Fabric from Wikimedia Commons:{' '}
      {credits.map((c, k) => (
        <span key={c.url}>{k > 0 && '; '}<a href={c.url} target="_blank" rel="noreferrer">{c.title}</a> by {c.author} ({c.license})</span>
      ))}
    </p>
  )
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map(([v, label]) => (
        <button key={v} className={v === value ? 'active' : ''} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  )
}

function waitFor(cond: () => boolean, timeoutMs = 8000) {
  return new Promise<void>((resolve) => {
    const t0 = performance.now()
    const tick = () => (cond() || performance.now() - t0 > timeoutMs ? resolve() : requestAnimationFrame(tick))
    tick()
  })
}

/** What makes a clothes photo work, and how long it takes. */
function PhotoGuide() {
  return (
    <details className="guide">
      <summary>Photo tips · takes about 30–60 s</summary>
      <ul>
        <li><b>Any clothes:</b> tops, trousers, shorts, skirts, dresses, jackets, or a whole outfit in one photo. Claude finds each garment and you choose what to wear.</li>
        <li><b>Worn photos measure best:</b> show the person from neck to feet, standing, front-on, so Claude can see where each hem and sleeve ends against the knees, ankles, elbows and wrists.</li>
        <li><b>Flat-lays and hangers work too:</b> lay the garment out whole and straight, sleeves out, nothing folded under.</li>
        <li><b>Even light, nothing in front:</b> bags, hair, hands or a phone over the clothes hide the fabric.</li>
        <li><b>Sharp and at least 600 px</b> tall. JPEG, PNG or WebP.</li>
      </ul>
      <p>
        Finding the clothes takes a few seconds (the first upload also downloads a 29 MB model once), Claude
        reads and measures them in about 15–25 s, the cloth drapes, and Claude then checks the result
        against your photo in another 15–25 s and corrects what's off.
      </p>
      <p>Not modelled yet: collars, buttons, belts, open fronts, cut-outs, wraps, and layering a jacket over a top.</p>
    </details>
  )
}

/** What Claude may refine on a head: how far features stand out, which one face-on photo can't show. */
const DEPTH = /nose-(trans-forward|scale-depth|hump|curve|greek|point-up|septumangle|volume)|mouth-(scale-depth|trans-forward|upperlip-volume|lowerlip-volume)|eyebrows-trans-forward|forehead-(trans-forward|nubian)|chin-(prominent|prognathism)|cheek-(volume|bones)|eye-push|head-scale-depth/

/** The face cut from the photo, a little wider than its landmarks: what Claude compares the head with. */
function faceCrop(canvas: HTMLCanvasElement, scan: FaceScan) {
  const xs = scan.points.map((p) => p[0]), ys = scan.points.map((p) => p[1])
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.6
  const c = document.createElement('canvas')
  c.width = c.height = 512
  c.getContext('2d')!.drawImage(canvas, cx - size / 2, cy - size / 2, size, size, 0, 0, 512, 512)
  return c.toDataURL('image/jpeg', 0.9)
}
