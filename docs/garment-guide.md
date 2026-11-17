# Garment guide: how to build and render clothes that drape well

Use this standard for every new garment, and to bring the existing ones up to it. It is drawn from
the outfits that fit and drape best today. Read it with [quality-gaps.md](quality-gaps.md) (what's
still short of `model_guides/`) and the Lessons section of [AGENTS.md](../AGENTS.md).

## 1. The benchmark

Compared on 2026-11-07, size M, relaxed pose, front, side and back:

| Rank | Outfit | Page | Why it ranks here |
|---|---|---|---|
| 1 | Tank & shorts | main | One layer, close ease, hangs from the shoulders; nothing to fight |
| 2 | Tee & chinos | main | Set-in short sleeves, a straight fall, a soft break at the ankle |
| 3 | Stripes & charcoal | outfits | Gored maxi skirt hangs in clean panels; overshirt layers over the turtleneck |
| 4 | Trench & denim | outfits | Render-only collars and belt, inner layers sunk, details on the settled drape |
| 5 | Off-shoulder dress | main | Body-skimming, but bunches at the waist |
| 6 | Henley & chinos | main | Was let down by tube sleeves and a moiré knit, both since fixed |
| 7 | Tank & skirt | main | Skirt fine; a small hole in the tank's back |
| 8 | Camp shirt & shorts | main | Collar reads as a V-neck and stands up at the back |
| 9 | Brown pinstripe suit | outfits | Shapeless jacket, ragged simulated collar, very baggy trousers |
| 10 | Evening gown | main | Over-full skirt crumples; glossy and chaotic |
| 11 | Navy brocade suit | outfits | Cropped blazer bunches at the shoulders and hangs like a cape |

What the top four share: few pieces, each drafted from the body's own cross-sections; ease that
matches the fabric; cloth tethered only where a real garment is held up; stiff parts left out of the
simulation; and inner layers that can never show through outer ones.

## 2. Pattern rules

1. **Draft from the body, never from size names.** Use `BodyFrame` (`torso(y)`, `quarter`,
   `aroundTorso`, `leg(y)`) and `top()`, `trousers()` and `goredSkirt` (`src/outfits/drafts.ts`) as
   templates. Custom measurements are the product goal, so a garment must fit any fitted body.
2. **Ease by garment type** (m out from the skin):

   | Type | Ease |
   |---|---|
   | Close knits and tanks | 0.008 – 0.015 |
   | Tees, henleys | 0.02 – 0.025 |
   | Shirts | 0.022 – 0.03 |
   | Overshirts | 0.04 – 0.05 |
   | Coats | the clearance underneath + 1.5 cm or more |

   Trousers take `hipEase` 0.016 – 0.022. Leg ease is 0.10 for chinos and 0.16 – 0.22 for wide legs.
   Legs taper from thigh to hem (see the Lessons in AGENTS.md).
3. **Let hems hang.** Tether only what a real garment hangs from: necklines, shoulder seams and
   waistbands (`band`). Never tether an open edge such as a coat front or a lapel line: pinned to
   their flat rest shape, the blazer fronts crumpled into lumps.
4. **Cut sleeves a little long.** Long sleeves run 1–2 cm past the wrist so cloth stacks there. Cut to
   the arm's length, they hang as stiff tubes.
5. **Spend mesh only where it shows.** The default is 3.2 cm (2.5 cm for a maxi skirt or turtleneck).
   Narrow or curved pieces get `Piece.spacing`: 2 cm for sleeves, 1.6 cm for collars and lapels. A whole
   coat at 2.2 cm doubled the solver's cost, which grows with particle count.
6. **Closed inner tops use the main wardrobe's `top()`** (shirts, turtlenecks). Drafted as open tailored
   fronts, the outfit shirts tore into shards under the suit jackets; cut with `top()` they drape as
   cleanly as the main page's tees. Keep `tailored()` for garments that really are open: coats and
   blazers.
7. **Mirror pieces with `mirror()`**, front pieces drawn from outside and backs from behind. Number
   each piece's edges in a comment.

## 3. What not to simulate

Stiff, interfaced parts are drawn as render-only geometry bound to cloth particles
(`src/outfits/details.ts`). Simulated, they shred or flop.

- **Collars and stands:** `Tailoring.collar()`, which runs along the garment's free neckline edge.
- **Belts, buckles, buttons and tabs:** `buildDenimSet()`, `ClothSurface.sleeveTab()`.
- **Always place against the settled drape** (`settled(layer)`), never the cut's rest shape. The cloth
  drops a few cm as it settles, and details placed on the rest shape floated off or sank in.
- **Find surfaces from the cloth itself:** free edges are edges used by one triangle across the
  *whole* index, and `frontCount` splits body-front from body-back faces. Body-frame offsets miss on
  posed arms and on other body sizes.

## 4. Layers

- **Order pieces from skin outward** in `GUIDE_OUTFITS`. Each layer's lift is the running maximum of
  the clearances under it.
- **Sink inner tops:** 1 cm under any tailored layer (coat, waistcoat, blazer, overshirt), 6 mm under a
  plain top (`Layer.sunk`). At 6 mm a shirt showed through a waistcoat's chest in patches. Never sink
  trousers: they sit close to the thighs, and the skin shows through. A maxi skirt stands off the legs
  and sinks 6 mm under an overshirt's hem.
- **Clip a tucked shirt** 2.5 cm below the waistband, and its buttons with it.
- **Underwear is painted on the skin** and sinks with it. A garment that bares the shoulders (strapless,
  off-shoulder) shows the bra straps and needs strapless underwear.

## 5. Materials

- **Pick the fabric that matches the real garment:**
  - `denim`: jeans.
  - `cotton`: shirting.
  - `knit`: tees, henleys, turtlenecks.
  - `wool`: coats.
  - `synthetic`: suiting.
  - `linen` or `silk`: when they fit.

  Each has its own surface (`SURFACE` in `stage.ts`), weave (`WEAVES` in `fabric.ts`) and solver
  stiffness (`FABRIC` in `garmentSpec.ts`).
- **Prints and washes are procedural canvases** on the pattern UVs, which are in metres
  (`materials.ts`). A wash can be placed by height up the piece, like faded knees on denim.
- **Keep normal maps shallow and fine.** The knit at 1 cm and full strength broke into moiré at a
  distance; it is now 6 mm at 0.45. Seam and hem lines fade out when they're finer than a pixel.
- **Contrast thread is per fabric** (`THREAD`), such as orange on denim.

## 6. Presentation

- **The default pose is relaxed**, with upright posture (`POSTURE` in `export.py`) and a natural finger
  curl. The other poses are A-pose (the drafting base), hands on hips, Step and Hand on hip.
- **Shoes match the outfit** (`GuideOutfit.shoes`).
- **The outfit drapes off screen** and appears settled, behind a "Draping…" badge.

## 7. Verification standard

A garment isn't done until its renders pass. Use `fit.mjs` and `shot.mjs` (outfits page), or
`main.mjs` and `bare.mjs` (main page), with Playwright.

1. **Scope:**
   - S, M and XL.
   - Both genders where the outfit applies.
   - Every pose.
   - The front, side and back views.
   - Close-ups of `shoulders`, `armR`, `handR` and `headback`.
2. **Pass when all of these hold:**
   - No background or skin through the cloth: a hole is a cloth bug.
   - No dark shards at collars, lapels or underarms.
   - Hems are level unless the design isn't.
   - Layers are in order: no inner layer showing through.
   - Details sit on the cloth.
   - Seams and hems don't alias into dashes.
   - Sleeves and legs fold at the joints rather than standing as tubes.
3. **Compare against the benchmark:** put each new outfit on a contact sheet next to Tank & shorts and
   Trench & denim at size M, relaxed.
4. **Report plainly what wasn't checked.**

## 8. Bringing the others up to standard

| Outfit | What's needed |
|---|---|
| Navy brocade suit | Cropped blazer: render-only collar and lapels, release the shoulder bunching (as for the blazer fronts), finer sleeves |
| Brown pinstripe suit | The same as the navy suit, plus narrower trouser legs (wide-leg ease) |
| Evening gown | Less skirt fullness or a stiffer fabric so it hangs in long folds; strapless underwear |
| Off-shoulder dress | Strapless underwear; ease the waist so it doesn't bunch |
| Camp shirt | Swap the simulated collar for the render-only collar, as on the trench shirt |
| (done) Outfit shirts | Now cut with `top()`; the trench shirts drape cleanly |
| Tank & skirt | Find and close the hole in the tank's back |
