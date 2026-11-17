# Cloth Demo

Local, free virtual try-on prototype: pick a mannequin (female/male, S–XL, three poses), dress it
from the wardrobe (casual tops and bottoms for both, plus a skirt, an off-shoulder dress and an evening gown for the
female mannequin) or upload a photo of a top, and watch it drape on the body with real-time cloth
physics. Claude (through your
local Claude Code login, no API key) reads the photo to work out the garment's cut and fabric, and
can review the final render for realism.

## Run

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5173. `npm run dev` starts both the Vite app and the Claude bridge (port 8787).

### Claude (optional, no API key)

The bridge shells out to the Claude Code CLI in headless mode (`claude -p`), using your Claude
subscription login. Install and log in once:

```bash
npm install -g --prefix ~/.local @anthropic-ai/claude-code
~/.local/bin/claude      # then type /login and finish signing in
```

Without Claude the app still works: set sleeve / neckline / length / fit / fabric by hand.
This setup is for personal local use; a hosted version would need a Claude API key.

## How it works

| Stage | Where | What |
|---|---|---|
| Mannequins | `tools/anny-export/export.py` (offline, Python) | [Anny](https://gh.hhj520.top/naver/anny) body model (Apache-2.0). Phenotype parameters are fitted with Adam so tape-measure loops hit ASTM-style size charts, with soft priors that keep muscle and proportions natural; the female mannequin carries fixed curve shaping (Anny's waist, seat, hip, thigh, shoulder-width and V-taper controls, lower muscle) that the fit works around, so she has a waist and hips rather than a straight torso. Poses are solved with gradient-descent IK (shoulder, elbow, wrist) plus a contact penalty that keeps the forearm and hand outside the body; relaxed also tries starting from the previous size's solution (keeping the closer match) and hands-on-hips starts from the relaxed pose, so the solver doesn't stall with the arms out. The legs take model stances by the same kind of IK (hip, knee, ankle to knee and ankle targets, feet level and turned out; `Exporter.STANCES`): relaxed stands in contrapposto, weight on the right leg with the left knee softly bent; hands-on-hips widens the stance with the left foot stepped forward. Bump `LEGS_VERSION` after changing a stance to re-solve the cached legs. Finish: Anny's own head and face are kept (`HEAD = "face"`; `"dome"` swaps in a blank display-mannequin head placed on the body's own head outline), with the eyes as their own segment; the female bust is resculpted as a smooth height field over a fitted chest surface, and Anny's `measure-bust-circ-incr` narrows the ribcage so the taped bust still matches the chart. Output: `public/models/*.bin` + `manifest.json`. |
| Figure | `src/scene/figure.ts`, `src/scene/hair.ts`, `src/scene/strands.ts`, `src/scene/face.ts`, `src/scene/smoothBody.ts`, `src/scene/Viewer.tsx` | **Skin** in 8 tones with tone variation, fine pores and an approximation of light scattering under the skin (a warm band at the light's terminator and a thin-edge glow). The drawn body is the simulated one split once and curved (Phong tessellation): smoother silhouettes and shading, while the cloth, hair, shoes and eyes still sit on the coarse vertices. **Hair** is strands (female: sleek, combed back along great circles over the head into a coiled low bun; male: a fade with a textured top), grown from the scalp inside a hairline found from the eyes and thinning out towards it, drawn as camera-facing ribbons with a Kajiya–Kay highlight over a dark under-layer shell. **Face:** eyebrows (thinning at the edges, hairs arcing off the skin), clumped and curled eyelashes plus a lash line along the lid margin, and glossy eyes (a clear-coated shell with a procedural iris, limbal ring and pupil). **Sneakers:** a flat-walled midsole and an upper lofted along a smooth shoe last, closed at the heel, with laces, toe cap and heel counter, over low white crew socks. **Set:** grey seamless backdrop, soft key light with soft shadows, fill and rim lights, ambient occlusion. |
| Garment photo | `src/photo/garmentPhoto.ts` (browser) | SegFormer clothes segmentation via transformers.js (falls back to border flood-fill for flat-lays), crop, background → mean colour, torso-width detection. |
| Garment analysis | `server/claude-bridge.mjs` → Claude Code | Returns sleeve, neckline, length, fit, fabric as JSON. |
| Wardrobe | `src/wardrobe/catalog.ts`, `tools/wardrobe/prepare.py` | Tops, bottoms and dresses with preset outfits, picked from the side panel. Each takes its fabric from a Wikimedia Commons photo (`tools/wardrobe/source/`): `prepare.py` crops a clean patch, divides out the photo's lighting, makes it seamless, corrects exposure towards the fabric's own colour and writes `public/wardrobe/*-swatch.jpg` (tiled on the garment in metres) and `*-card.jpg`. |
| Pattern garments | `src/pattern/` | The whole wardrobe: worn clothes sewn from flat pattern pieces drafted from the body's own measurements and cross-sections — the camp-collar shirt, wide shorts and off-shoulder ruched dress (`drafts.ts`), and a general top (tee, henley, tank), trousers (chinos, cargo shorts), the A-line skirt and the evening gown (`garments.ts`). Sides and legs follow the body every 6–9 cm, so fit is set by ease alone. The gown's skirt is cut half as wide again as its bodice waist and gathered in, hangs over a petticoat (extra collision clearance on the outward-facing leg skin), and its sweetheart edge carries the pale trim. Seams sew in whichever direction starts closest over their whole length. Wide shorts, chinos and cargo shorts share one trousers draft: the crotch seam hangs 3–4.5 cm below the body with a longer back extension for the seat, the legs taper from thigh to hem, and above the crotch the sides follow the hips every 5 cm. Each garment records its real distance from the skin, and a top clears whatever is under it with one smooth ramp; top hems dip at the front and back centre by however much longer the body's profile is than its height, so they cover the waistband over a belly. Each piece is meshed flat (`mesh2d.ts`), placed around the body, and its seams are sewn shut by the solver over the first 0.8 s (`assemble.ts`); rest lengths come from the flat pattern, so cutting a piece longer than its seam (the dress's front skirt, its sleeves) gathers it into ruching. Elastic edges (waistband, off-shoulder neckline, cuffs) rest shorter and are held at their skin height. Torso panels follow the body by translation on pose changes; changes between two arms-down poses swing through the A-pose, where the cloth eases back into its clean A-pose drape. |
| Garment mesh | `src/cloth/buildGarment.ts` | Cuts the garment out of the mannequin surface by skinning segment + joint-axis projection: tops from the neckline down (sleeves, or an armhole for sleeveless), bottoms from a snug elastic waistband down the legs; skirts and the gown extrude an A-line tube from the hip or waist seam (the gown's with pleats built in, so it falls in folds); a strapless top edge and the gown's waist seam are held like a waistband. A neckline trim (the gown's pale band) is drawn in the shader from each vertex's distance to the edge, so its line stays smooth. Inflates by ease, then shrink-wraps (Laplacian + push-out against the nearest skin point; openings Taubin-smoothed so they straighten without shrinking) so it bridges hollows. A top over a bottom keeps the bottom's thickness clear. Photo tops use piecewise planar UVs that line the photo's torso and sleeves up with the garment's. |
| Fabric look | `src/scene/fabric.ts`, `src/scene/stage.ts` | Each fabric type gets a tiling weave normal map sized in metres (twill for cotton and denim, plain weave for linen, stocking-stitch knit for jersey and knits, smooth satin floats for silk) and a sheen in a lightened fabric colour, so folds read even on black. Pattern garments also show their construction, worked out from the flat pieces: a pressed seam with a topstitch beside every sewn edge, and a folded, topstitched hem along every free edge (hems, necklines, cuffs), bumped into the surface in the shader. |
| Cloth | `src/cloth/xpbd.ts`, `src/scene/stage.ts` | XPBD with small steps: bending, then 8 stretch passes per substep each followed by collision (so a neckline or waistband holds the garment's weight), body collision via nearest-vertex tracking on the skin (bottoms pass through the arms), friction, carry-along on pose changes (offsets turn with the skin normal, so sleeves follow the arms), freezes once settled. Up to two layers, bottom then top; on a size or gender change the outfit is re-cut once the body morph finishes. Skin under a worn garment is drawn 5 mm sunk into the body (`Stage.markCovered`, read by the skin shader), so where XL thighs touch and the cloth can't fit between them, skin still never draws through it; head, hands and feet are left alone so nothing shows at the openings. |
| Review | Claude Code | Scores mannequin + garment realism from a screenshot (and the original photo), and its fit/length/sleeve fixes are applied automatically. |

## Development

- Status, known issues and next tasks: [AGENTS.md](AGENTS.md).
- Type-check: `npx tsc --noEmit -p .`
- Dev-only hooks in the browser console: `window.__stage` (the scene state) and `window.__snapshot(view)`, which finishes any running morph or drape and renders a 900×1200 still from a fixed camera (views in `SnapshotHook`, `src/scene/Viewer.tsx`: `front`, `side`, `back`, `head`, `face`, `eyes`, `chest`, `shoulders`, `feet`, `thighs`, …). `POST /api/snapshot` with `{ image, name }` saves it as `$TMPDIR/cloth-demo-<name>.jpg`.

### Rebuilding the mannequins

```bash
python3 -m venv .tools && .tools/bin/pip install uv
cd tools/anny-export && ../../.tools/bin/uv venv -p 3.11 .venv
../../.tools/bin/uv pip install -p .venv "torch==2.2.2" "numpy<2" anny scipy
cd ../.. && npm run export-bodies             # add -- --refit to redo the size fits
```

Size fits and poses are cached in `tools/anny-export/.fit-cache.pt`, so changes to the mannequin finish re-export quickly.

To rebuild the wardrobe textures after changing a crop in `tools/wardrobe/prepare.py`:

```bash
tools/anny-export/.venv/bin/python -I tools/wardrobe/prepare.py
```

## Credits

- Body model: Anny, NAVER LABS Europe (Apache-2.0)
- Wardrobe fabrics, from Wikimedia Commons: [Klassisches Henley Shirt](https://commons.wikimedia.org/wiki/File:Klassisches_Henley_Shirt.jpg) by Bwilke (CC BY-SA 4.0); [Tagless yellow shirt](https://commons.wikimedia.org/wiki/File:Tagless_yellow_shirt.jpg) by Talinee (CC BY-SA 3.0); [Chino pants](https://commons.wikimedia.org/wiki/File:Chino_pants.jpg) by Kuha455405 (CC BY-SA 3.0); [Cargo shorts](https://commons.wikimedia.org/wiki/File:Cargo_shorts.jpg) by Punker1999 (CC0); [Longskirt (Flaretype Flourpattern)](https://commons.wikimedia.org/wiki/File:Longskirt(Flaretype_Flourpattern).jpg) by 芹丘智美 (CC BY-SA 4.0); [Ball gown, MET C.I.57.17.9a, b](https://commons.wikimedia.org/wiki/File:Ball_gown_-_MET_C.I.57.17.9a,_b.jpg), House of Worth, The Metropolitan Museum of Art (CC0). The swatches and cards in `public/wardrobe/` are derived from these and carry the same licences.
- Clothes segmentation: `Xenova/segformer_b2_clothes` (ONNX port of `mattmdjaga/segformer_b2_clothes`; check its licence before any commercial use)
