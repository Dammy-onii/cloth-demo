# Guide for the next coding agent

Read this first, then [README.md](README.md) (architecture, per-stage detail, credits). This file is
the working brief: what the project is for, how to run and verify changes, the conventions, what's
done, what's broken, and the next task.

## The project and the owner's preferences

A **local, free** fashion try-on demo: pick a mannequin (female/male, sizes S–XL, four poses), dress
it from a wardrobe or a photo of a top, and watch the clothes drape with real-time cloth physics in
the browser (three.js via @react-three/fiber, an XPBD cloth solver).

- **Free and local only.** No paid APIs, no GPU hosting. Claude is reached only through the
  owner's local CLI login (`claude -p`, see `server/claude-bridge.mjs`); never add API keys.
- **Hardware:** a 2019 Intel MacBook, no CUDA. Heavy ML runs in the browser or not at all; keep an
  eye on frame time (strand hair already costs about 25% per render).
- **Ask clarifying questions as selectable options** (a multiple-choice picker), batched, with the
  recommended option first, not as a long prose list.
- **Downloads need explicit approval** (name, source and size). Wardrobe photos come from Wikimedia
  Commons with credits in the README.
- **Quality bar:** the 3D fashion renders in `model_guides/` (realistic figure, hair, skin and
  clothes). `guides/` holds the outfit references: fashion photos, plus one unrelated cartoon.
- The owner reviews visually. **Verify every visual change with renders** (front, side and back)
  before calling it done, and say plainly what you couldn't check.
- **Nothing is committed yet** (the repo has no commits). Commit only when the owner asks.

## Run and verify

```bash
npm install
npm run dev              # Vite on http://127.0.0.1:5173 plus the Claude bridge on :8787
npx tsc --noEmit -p .    # type-check: keep it clean
```

Dev-only hooks in the page (from `SnapshotHook` in `src/scene/Viewer.tsx`):

- `window.__stage`: the `Stage` (body, layers, `describe()`, `idle`, `update(dt)`).
- `window.__snapshot(view)`: finishes any running morph or drape, then renders a 900×1200 still
  from a fixed camera and returns a JPEG data URL. Views include `front`, `side`, `sideR`, `back`,
  `head`, `headhi` (male height), `face`, `eyes`, `eyesM`, `chest`, `shoulders`, `feet`, `feetback`,
  `thighs`, `thighsback`, `earback`. Add more there as needed.
- `POST /api/snapshot` with `{ image, name }` saves it to `$TMPDIR/cloth-demo-<name>.jpg`, so you can
  open it as an image.

Drive the UI by clicking buttons by their text (`Female`/`Male`, `S`–`XL`, `A-pose`/`Relaxed`/
`Hands on hips`/`Step`, outfit names). Gotchas found the hard way:

- **A hidden browser tab throttles `setTimeout`/`requestAnimationFrame`.** Wait with a MessageChannel
  tick instead: `new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0) })`.
  `__snapshot` steps the simulation itself, so renders still finish.
- **After `location.reload()`** the page may not mount until it's shown on screen. Wait for
  `typeof __snapshot === 'function' && __stage?.layers.top.sim` before running a script; a script
  sent too early runs on the old page.
- A `__stage.idle` getter override (`Object.defineProperty(st, 'idle', { get: () => true })`) plus
  manual `st.update(1/30)` calls lets you snapshot mid-transition, frame by frame.
- Body changes (gender, size, pose) morph over 0.9 s; outfit cuts wait for the morph to end.

## Rebuilding the mannequins (offline, Python)

`tools/anny-export/export.py` fits the Anny body model to size charts, solves arm and leg poses by
IK, and writes `public/models/*.bin` and `manifest.json`. Setup steps are in the README. Fits and
poses are cached in `tools/anny-export/.fit-cache.pt`; a full re-export takes about 4 minutes.

- Arm poses: `relaxed_pose` and `hips_pose` (IK with a contact penalty).
- Leg stances: `Exporter.STANCES`. Bump `LEGS_VERSION` to re-solve them. `stride` (the Step pose)
  reuses the relaxed arms.
- Hands: `FINGER_CURL`/`finger_pose()` curl the fingers in every pose (flex is +local y per finger bone,
  the thumb tucks on +z).
- Face: `FACE`/`face_changes()` sculpt Anny's neutral face (cheekbones, jaw, eyes, lips) per gender.
- Anny's axes: +x is the body's left, −y forward, +z up. three.js: y up, +z forward.
- Anny has no ethnicity controls: one neutral face, with skin tone chosen separately.

## Map of the code

| Area | Files |
|---|---|
| Scene, layers, outfit cut, skin sinking | `src/scene/stage.ts` |
| Skin, colours, default underwear, sneakers and socks | `src/scene/figure.ts` |
| Hair (strands over an under-layer shell) | `src/scene/hair.ts`, `src/scene/strands.ts` |
| Brows, lashes, glossy eyes | `src/scene/face.ts` |
| Smoothed render-only body | `src/scene/smoothBody.ts` |
| Fabric weave, seams and hems | `src/scene/fabric.ts` |
| Studio, snapshot hooks | `src/scene/Viewer.tsx` |
| Cloth solver | `src/cloth/xpbd.ts` |
| Guide outfits (layered, `/outfits` page) | `src/outfits/` |
| Cut-from-body garments (uploaded tops only) | `src/cloth/buildGarment.ts` |
| Uploaded dresses (pattern dress plus the photo projected from the front) | `buildDress` in `src/pattern/index.ts`, `dress()` in `src/pattern/garments.ts` |
| Photo segmentation, Claude bridge, upload tips | `src/photo/garmentPhoto.ts`, `server/claude-bridge.mjs`, `PhotoGuide` in `src/App.tsx` |
| Pattern garments (the whole wardrobe) | `src/pattern/` (`drafts.ts`, `garments.ts`, `assemble.ts`, `mesh2d.ts`, `index.ts`) |
| Wardrobe items and preset outfits | `src/wardrobe/catalog.ts` |
| UI | `src/App.tsx` |

## Conventions

- Match the surrounding code: dense, terse TypeScript; comments explain **why**, often naming the
  failure a choice fixed ("a fixed hip width bunched into lumps at the side seams"). Keep that style.
- Units are metres everywhere. Pattern coordinates: x across the piece, y up from its hem.
  - Fronts are drawn as seen from outside, with +x towards the body's left.
  - Backs are drawn from behind (+x is the body's right).
  - Each draft lists its edge numbering in a comment; seams name `[piece, edge, reversed?]` chains.
- Mirror pieces with `mirror()` (`drafts.ts`) and mirror placements too. An unmirrored outline
  placed mirror-wise comes out inside-out and shades badly.
- Pattern pieces flagged `passThrough` ignore the forearms and hands; `noTurn` panels follow the
  body by translation only; `anchor` limits which body segments a piece follows.
- Anything sewn from a pattern automatically gets the fabric weave and stitched seams and hems from
  `garment.flat`, `garment.seams` and `garment.index`. Keep those meanings stable.

## Lessons learned (don't repeat these)

- **Solver clocks must advance by simulated time.** A long first frame once closed every seam in
  one jump and flung sleeves off.
- **Don't let shirt panels skip collision whenever the nearest skin is an arm**, and don't
  restrict the nearest-skin search to the torso. Both made shirts sink into or slide off the body.
- **Turning a loose panel's offset with the twisting armpit skin** flung shirt sides up; hence
  `noTurn` for torso panels.
- **Blending straight between two arms-down poses** drags the arms through the shirt sides. Pose
  changes now go through the A-pose, where cloth eases back into a cached clean A-pose drape.
- **Seams pick their sewing direction by the total gap over every pair** (`assemble.ts`), not by
  the end points: a sleeve cap's two ends meet under the arm, and the end test sewed one sleeve on
  back to front.
- **`covers` is each garment's real distance from the skin**, not a fixed 1.2 cm: a bottom cut
  with more ease pushed out through the top's hem. Tops clear it with one smooth ramp down from
  the bottom's top edge; stepping height by height notched the hem.
- **Trouser legs are placed by how far across the piece a point is, inseam to side seam, with
  one radius for the front and back of a leg.** Placed from a fixed leg centre, the legs ballooned
  over the hips; with a radius per piece, the side seams sewed into ridges.
- **Legs taper from thigh to hem.** Holding the hem width all the way up made stiff boxy tubes.
- **The gown's petticoat lifts only outward-facing leg skin.** Lifting the inner thighs (normals
  towards the other leg) flung the skirt sideways on XL.
- **Default underwear is drawn by the skin shader** (`underwearShape` + `UNDERWEAR_GLSL` in `figure.ts`),
  from each point's A-pose position (`restPos`), so it sinks with covered skin and never shows through.
  Painted per vertex, its edges zig-zagged between the coarse body's vertices.
- **Skin under clothes is drawn 5 mm sunk** (`Stage.markCovered`). So a hole in a garment now shows
  the background, not skin: holes are cloth bugs.
- **The outfits page can't drape like the main page.** Plain `ClothSim` carried from the A-pose
  (`PLAIN_DRAPE` in `wardrobeStage.ts`) let open coats slide off, dropped cropped blazers into a heap
  and tore tucked shirts. Open fronts need `SupportedCloth`'s shoulder and neckline supports.
- **A photo on a pattern garment goes on the second UV set** (`Garment.photoUV`, `texture.channel = 1`):
  the first stays in metres for the weave and seam lines.
- **Outfit shirts are cut with the main wardrobe's `top()`.** Drafted as open tailored fronts, they
  tore into shards under the suit jackets.
- **Garments from photos are drawn from their own trace, not templates** (docs/garment-mapping.md).
  Template fits with a few numbers changed couldn't express cut-outs, slits, asymmetry or a bodycon fit.
- **A cloth shrunk lengthwise rides up.** `Piece.stretch` narrows the rest width only. Shrunk both ways,
  a tube dress climbed off the hips and piled at the waist.
- **Cloth freezes only when it's really at rest** (`xpbd.ts`): under 1 cm/s for 1.2 s, with a 20 s cap and
  extra damping from 8 s on. Frozen at 3 cm/s, or by a 6 s cap, it stopped mid-fold with awkward wrinkles.
  It costs more frames per change on the Intel Mac.
- **A check has to be able to change what it judges.** Claude's review first corrected labels that garments
  drawn from a trace ignore, so its scores changed nothing. It now corrects the trace itself.
- **Hair combs along great circles to the bun.** Heading straight for the bun combs the front hair
  down the forehead.

## Status

Done:
- All wardrobe items are pattern garments.
- Fitted bottoms with a dropped crotch.
- Leg stances in the poses.
- Strand hair, brows and lashes.
- Glossy eyes, realistic skin shading, the smoothed body.
- Sneakers with socks.
- Fabric weave, seams, hems and sheen.
- Skin sinking under clothes.

Known issues, roughly by priority:

1. **Holes at the crotch and inner-thigh seams of shorts on XL**, worst in relaxed and hands on hips.
   You see the background through them (views `thighs`/`thighsback`).
2. **The camp shirt rides up at the back on XL** (all stances), and XL tops ride up a little in
   relaxed.
3. **The camp shirt bunches up in hands-on-hips** on female S and XL.
4. **The off-shoulder dress hasn't been re-verified** since the latest pattern changes.
5. **Lashes stand up a little evenly** in close-ups; the lash line is subtle.
6. **Live frame rate isn't measured** on the Intel Mac. Strand counts are in `growSleek` and
   `growCrop` (`hair.ts`) if it's slow.

## Pattern programs: Claude drafts outfits like the workshop's (newest, unverified)

Outfits can be drafted as a **pattern program** (JavaScript using the pattern library, `docs/pattern-api.md`)
or a **pattern spec** (JSON pieces in body coordinates, `docs/pattern-spec.md`).

- **Code:** `src/build/`:
  - `kit.ts`: what programs get;
  - `spec.ts`: the spec interpreter;
  - `worker.ts`: a sandboxed worker with the network and storage removed, and a 20 s limit;
  - `run.ts`: the page side;
  - `looks.ts`: the prints, adding rib, crochet with real holes, plaid and check;
  - `programs/`: three hand-drafted outfits from the owner's photos, shown as wardrobe outfits and as
    Claude's examples.
- **Main page:**
  - **Layering:** `Stage.setLayers`, with `outer1` and `outer2` slots.
  - **Uploads collect photos:** several make one outfit, such as a top from one photo and trousers from
    another.
  - **Build buttons:** "Claude: pattern code", "Claude: pattern spec" and the older "Trace".
- **Bridge routes:** `build-code`, `build-spec`, `refine-code` and `refine-spec`. Claude reads the guide, the
  format doc and the examples, drafts, then checks renders and rewrites its own pattern (up to two rounds).
- **Cloth never freezes now.** `ClothSim.quiet` marks a settled drape; `Stage.settled` and `idle` use it.

**Verified:**
- Claude drafted the plaid selfie in 52 s as code and 82 s as spec, and the bolero outfit in 33 s.
- `whiteCutoutMini` sews (2,154 vertices).

**Not yet rendered or checked:** the other programs, Claude's drafts, the correction loop, layering, and
the cost of never-frozen cloth on the Intel Mac. Don't edit files while a Playwright render is running:
hot reload breaks it.

## Hairstyle try-on (planned, awaiting the owner's go-ahead)

[docs/hair-tryon-plan.md](docs/hair-tryon-plan.md): a `/hair` page where a user builds their head from a
portrait, adds hairstyles from photos (cuts and cornrows first) and checks them from every angle. Four
stages, none started. Don't build ahead of the owner's approval of the plan.

## The user's face from a photo (main page, "Your face")

**MediaPipe Face Landmarker** runs in the browser (`src/photo/face.ts`; `public/mediapipe/face_landmarker.task`,
3.76 MB, approved 2026-11-09). It finds 478 points and the head's rotation. In full-length photos the head is
found first with the pose model (`detectHead`) and cropped into a close-up, because the face detector is
the short-range one.

**Face controls as morphs:**
- `tools/anny-export/face_export.py` saves Anny's 129 face controls, at +1 and −1 each, as int16 deltas over
  the head, eyes and neck (`public/models/face-<gender>.*`, 7.6 MB each, about 4,900 vertices).
- Anny re-fits its skeleton when the head changes, so the hands moved up to 1 mm. Those vertices are left out.
- `src/face/morphs.ts` mixes the controls; `withFace()` wraps the body, so hair, eyes and cloth follow.

**Correspondence** (`public/models/face-map-<gender>.json`, made by `facemap.mjs` in the session scratchpad):
the model is rendered straight on, its face is detected, and each point is traced to the front-most head
vertex under it. It stores:
- an offset from that vertex to the point itself;
- MediaPipe's reading of the model's own head rotation.

Checked by drawing the points over the render: median 3 px, about 1 mm.

**Fitting** (`src/face/fit.ts`) is done in the picture plane.
1. The model's face is turned by the photo's rotation relative to the model's own.
2. The camera distance is estimated (perspective, about the face's centre).
3. The photo is aligned in 2D by scale, turn and shift.
4. The controls (each side 0..1, with a penalty) are solved by coordinate descent.

The ears, back of the skull and head movement on the neck aren't fitted. Self-test on the model's own render:
the camera read 0.65 m against the real 0.55–0.65 m, a 0.5 mm gap, and almost no change.

Lessons from getting it right:
- **MediaPipe's per-point depth is off by 12.8 mm** on our render, against 1.5 mm in x and y, so depth isn't fitted.
- **Pinning points to bare vertices left a 2.6 mm bias**, which the fit "corrected" into a different face.
- **Turning by the photo's absolute rotation counted the model's posture tilt twice.**
- **Perspective must scale about the face's centre, not the floor.**

**The head studio** (main page → Your face). A face photo opens a view of the head alone: bald, the body cut
at the neck (`Stage.setHeadStudio`), framed close by the viewer (`focus="head"`), with the photo beside it. The
user applies the head to the body when it looks right. Building the head:
1. **Landmark fit** of the controls (above).
2. **Dense warp** (`FaceFit.warp`): every landmark vertex is moved onto the photo's point as seen face on, and
   the surface around it follows (Gaussian, σ 1.2 cm, fading away from the face). This moves the face up to
   about 15 mm, where the controls alone move it about 3 mm, and it's what makes the face read as the person.
3. **Claude's depth pass** (`POST /api/sculpt-face`, one round): only depth controls (`DEPTH` in `App.tsx`: nose
   projection, lips, brow ridge, cheeks, chin), at most ±0.25 each. Claude also reads eye colour and hair.
   Free to set any control by whole steps, it distorted the face, so it's held to this.
4. **The photo painted on** (on by default), with its lighting removed (`delight`: divided by its blurred
   brightness, shine squashed), and the 3D brows hidden while it shows.

**"Claude builds the head (no landmarks)"**, a second upload for comparison: Claude alone sets every face and
head control (not the head's placement on the neck), from the neutral face, over four rounds of photo against
front, three-quarter and side renders, moving each control at most 0.5 a round (`sculpt-face` with
`mode: 'full'`). It also reads skin, eye colour and hair. With no landmarks the photo can't be painted on.
Tried on the owner's two photos: clean and plausible (Claude scored 6–7/10), but generic next to the landmark
method. It doesn't place features precisely, and facial hair and skin detail only come with the painted photo.

**Hair:** a new head wears the hairstyle Claude read (`HairStyle` in `hair.ts`), or none:
- `afro`: short coils, a thin rounded shell plus about 16,000 coiled strands;
- `braids`: cornrow rows traced over the scalp by angle, three woven strands each, hanging down the back.

Checked on the owner's two photos (a girl with braids and green eyes, a man with short coils): the faces read as
them, front and three-quarter.

**Still rough:**
- the braids are flat and blocky;
- the skin is glossy;
- the profile is estimated;
- other hairstyles (locs, long hair) aren't built;
- not checked in every size and pose.

## Photo uploads (any clothes)

The owner's specification is [docs/garment-mapping.md](docs/garment-mapping.md): read the garment's own
structure and map it onto the model, never force it into a template. Stage 1 of it is built.

1. **Segmentation** (SegFormer, in the browser) masks every clothing label.
2. **MediaPipe Pose**, in the browser, finds the wearer's joints (`src/photo/pose.ts`). Its files are local in
   `public/mediapipe`: a 14.6 MB WebAssembly runtime and the 5.8 MB lite model, approved on 2026-11-07.
3. **Claude traces each garment** (`ANALYZE_PROMPT`, about 25–40 s) into `GarmentRead.structure`:
   - rows of body edges and garment edges, from the top edge to the hem;
   - the top edge (neckline), including whether each shoulder is over or under the arm;
   - the hem line;
   - openings and slits, each with a confidence, plus occluded areas;
   - sleeves per side;
   - the inferred back;
   - where the garment hangs from.
4. **`chartDraft`** (`src/pattern/chart.ts`) draws the panels from that trace in body coordinates:
   - height between the joints;
   - across from side seam to side seam;
   - ease from the garment's width over the body's.

   The hem and neckline are polylines on the edges (`Piece.paths`). Openings are mesh holes (`Piece.holes`);
   slits are hem notches. Sleeves are set in under a shoulder (`sleevePair`) or off the shoulder
   (`offShoulderSleeves`). Without a trace it falls back to the templates in `buildCustom`.
5. **Printing.** Plain cloth uses Claude's colour; allover prints tile the swatch; placed prints go through
   the same mapping (`ChartResult.photoUV`).
6. **Fitted garments** (`fit: 'tight'`):
   - are stretched on (`Piece.stretch`, across only);
   - grip the skin (`Garment.grip`, `Garment.friction`).

   Without grip a bodycon dress slid up off the thighs and piled at the waist.
7. **Claude checks and corrects** (`refinePrompt`, `POST /api/refine`). It gets the photo, the render and the
   trace that drew it, and returns corrected traces plus an optional `fitScale`. These redraw the garment,
   for up to two rounds while its score is under 8. Hand edits (hem, sleeves, fit) are adjustments on top of
   the trace (`GarmentRead.adjust`).
8. **Flat-lays** keep the garment's own proportions: it is scaled from its shoulder width to the model's, its
   width is read as half its girth, and its sleeves take their traced length and hem width (bell sleeves).

Known gaps:
- wraps and ruching aren't modelled;
- there's no back photo yet;
- trousers still use the template;
- a jacket over a top isn't layered;
- a sliver of skin can show where an off-shoulder sleeve meets the bodice.

Not measured: drape time on a real GPU. Headless SwiftShader takes 4–7 minutes.

## Garment guide

Build and verify every new garment against [docs/garment-guide.md](docs/garment-guide.md): the
standard drawn from the best-draping outfits, with the render checks a garment must pass.

## Quality gaps

[docs/quality-gaps.md](docs/quality-gaps.md) lists every gap between our renders and
`model_guides/`, with severity and where to fix it. The trench & denim outfit is the pilot.

## Guide outfits (built, unverified): the `/outfits` page

`src/outfits/` holds the guide outfits, shown on http://127.0.0.1:5173/outfits (`Workshop.tsx`,
`wardrobeStage.ts`, N ordered layers, per-layer clearance modules, render-only `details.ts`).
`catalog.ts` lists four outfits, each tied to its reference photo in `guides/`:

| Outfit | Reference |
|---|---|
| Trench & denim | `736690451593714112.jpeg` |
| Stripes & charcoal | `531072981083768866.jpeg` |
| Navy brocade suit | `1008947122800140531.jpeg` |
| Brown pinstripe suit | `301670875065678004.jpeg` |

`Search Code on Shein - ZCM5253.jpeg` is plaid-and-denim jeans, not part of any outfit.

Still to do: run the render audit (`renderAudit.ts`, 10 views per fit) and check sync on S/M/XL,
all four stances: layers clear each other, tucked shirts sit under trousers, nothing lags the
pose. Then decide whether the main app's two-slot `Stage` should move to the layered one.
