# Quality gaps: our renders vs `model_guides/`

The quality bar is the five renders in `model_guides/`: offline digital-fashion renders (CLO3D /
Marvelous-style, path traced, 5–10 mm cloth meshes, hand-modelled trims). We render live in a
browser on a 2019 Intel Mac, so the aim is "reads as the same kind of image", not pixel parity.

Compared on 2026-11-07 against the `/outfits` render audit (A-pose, size M, front/side/back).
Severity: **High** = a viewer notices it first; **Med** = noticeable side by side; **Low** = polish.

## 1. Mannequin

| Gap | Guides | Ours | Sev | Where to fix |
|---|---|---|---|---|
| Pose | Relaxed contrapposto, weight on one leg, hands in pockets or loose at the sides | Audit and default view use a rigid A-pose with arms out | High | Default the showcase to `relaxed`; a contrapposto stance in `Exporter.STANCES` |
| Proportions | Long-legged fashion figures (8–9 heads tall), narrow waist, defined shoulders | Size-chart average bodies, shorter legs, softer torso | Med | `tools/anny-export/export.py` (Anny height and limb phenotypes) |
| Skin | Subsurface scattering, specular sheen on cheekbones and shoulders, muscle definition | Plausible tone, flatter; little definition | Med | `src/scene/figure.ts` (transmission/sheen, normal detail) |
| Hair | Sharp fades, braids, slicked hair with flyaways | Sleek cap and bun, short crop; good at distance | Low | `src/scene/hair.ts` |
| Hands | Relaxed, curled fingers | Flat, splayed in the A-pose | Med | Finger curl in the exported poses |
| Footwear | Matched per outfit: loafers, platform heels, chunky sneakers | One white sneaker with every outfit | Med | `src/scene/figure.ts`: a shoe style per outfit |

## 2. Garments

| Gap | Guides | Ours | Sev | Where to fix |
|---|---|---|---|---|
| Silhouette | Crisp, intended shapes: boxy bomber, straight wide leg, sharp camp collar | Roughly right, but edges sag and fronts lump | High | `src/outfits/drafts.ts` |
| Collars and lapels | Stiff, interfaced, a clean roll line | Separate soft strips that flop or crumple | High | Stiffer pieces, finer mesh, roll-line folds |
| Fold quality | Folds where cloth puts them: hem stacking, knee pulls, soft waist gathers | Faceted crumples from a 2–3 cm mesh, especially on trousers | High | Finer mesh where it shows; smoothing in render |
| Construction trims | Plackets, pockets, zips, cuffs, ribbing, belt loops, belts | Stitch lines and buttons only | High | Render-only geometry in `src/outfits/details.ts` |
| Fit across sizes and poses | — | Holes at the XL crotch; shirts ride up on XL; bunching in hands-on-hips (see AGENTS.md) | High | Cloth and clearance modules |
| Layer contact | Outer layers rest on inner ones with soft contact shadows | Layers clip at the V of the navy waistcoat; layers look pasted on | Med | `layerClearance.ts`, render-side contact darkening |

## 3. Materials

| Gap | Guides | Ours | Sev | Where to fix |
|---|---|---|---|---|
| Per-fabric look | Leather sheen and grain, knit ribbing, denim fading and whiskers, satin highlights | Every fabric shares one matte surface (`MATTE` in `stage.ts`); only silk differs | High | `SURFACE` in `src/scene/stage.ts`, per-fabric colour variation |
| Denim | Indigo twill with fading at the seat, knees and seams, orange topstitching | Flat mid-blue with a weave normal map | High | Procedural wash over pattern UVs; thread colour per fabric |
| Wool suiting and coats | Soft, slightly fuzzy surface; deep, soft shadows | Reads as plastic or felt | Med | Higher roughness, a sheen tuned for wool, a fibre normal |
| Prints | Crisp at any distance | Fine at medium range, alias at a distance | Low | Mipmapped canvas textures, larger tiles |

## 4. Lighting and render

| Gap | Guides | Ours | Sev | Where to fix |
|---|---|---|---|---|
| Ambient occlusion | Deep contact shadows in folds and between layers | GTAO is already in (`Viewer.tsx`) but subtle: radius 0.18, scale 1.2 | Med | Tune GTAO; add contact darkening between layers |
| Lighting design | A large soft key, gentle falloff, gradient backdrop | Even grey studio; the key and rim are fine, the backdrop is flat | Low | `Viewer.tsx` lights and backdrop |
| Antialiasing | Clean edges | Clean on a real GPU; the audit's reduced views have no MSAA | Low | Audit only |

## Mannequin pass (2026-11-07)

Done:
- **Hands:** relaxed curl in every pose (`FINGER_CURL` and `finger_pose()` in `export.py`, stronger towards
  the little finger), with the thumb tucked towards the index finger. Flex is +local y on each finger
  bone; the thumb tuck is +local z (−z swung it out).
- **Lips:** separate upper and lower lip tones (`skinColors`), centred from the mesh: the most forward
  point 5–11 cm below the eyes, not a fixed drop.
- **Eyes:** shade in the upper lid crease.
- **Skin:** glossier (roughness 0.46, clearcoat 0.22), so the forehead, nose and cheekbones catch
  highlights as in the guides.
- **Pose:** the outfits page opens in the relaxed pose, as the guides stand.

Then:
- **Face sculpt:** Anny local changes (`FACE` in `export.py`): cheekbones, firmer jaw and chin, slightly larger
  almond eyes, fuller lips with a cupid's bow, arched brows. Nose width is untouched.
- **Cheek colour:** the flush now fades in; it was a step that drew a line down each cheek.
- **Step pose:** a catwalk pause with the left foot ahead and in.
- **Sleek hair:** no stray strands; they drew loops off the crown.

Still open:
- **Face shape:** Anny's neutral face (no ethnicity controls). There's no expression or asymmetry, so it
  still reads as a mannequin up close.
- **Hair:** only the sleek bun and the short crop; the guides have fades, braids and flyaways.
- **Skin:** may now be slightly too glossy; check on a real GPU.

## 5. Custom measurements (the product goal)

Users should enter their own measurements and dress an exact replica of their body. Today the bodies
are pre-fitted offline to four size charts (S–XL) and shipped as files, so this doesn't exist yet.

- First inputs: height, bust, waist and hip (what `fit_size` in `tools/anny-export/export.py` uses).
- Design still open: Anny shape controls as morph targets fitted in the browser (live, needs a
  feasibility check), or the exporter run as a local fit service (about 30–60 s per body).
- The current S–XL bodies are idealised stand-ins: 1.72 m / 1.85 m with a `proportions` prior of 0.85.
- Garment drafts must stay driven by `BodyFrame` measurements, never by size names.

## 6. Not reachable live on this hardware

- Path-traced global illumination and true subsurface scattering.
- Cloth meshes of 5 mm or finer on whole garments. The solver cost grows with the particle count; spend
  density on hems, collars and lapels only.
- Hand-modelled hardware such as zips with teeth. Use simplified render-only meshes.

## Status: trench & denim pilot (2026-11-07)

Verified front, side and back on S, M and XL, both genders, in all three poses (18 fits).

Done:
- Wool coat fabric (soft, matte surface with a fibre sheen).
- Per-fabric surfaces for denim, cotton, synthetic and knit.
- Washed denim (slub streaks, faded knees and thighs, dark hem) with orange topstitching.
- Brown leather belt with a gold buckle on the jeans.
- Shirt placket buttons.
- Buttoned sleeve tabs on the coat.
- Tucked shirt clipped below the waistband, so it no longer pokes through the fly.
- Taupe runner sneakers; shoes now follow a lifted foot (toes had come through on the taller bodies).
- Finer mesh (2.2 cm) on the coat and shirt.
- Stronger AO and a dimmer fill light.
- Idealised stand-in bodies.

Second pass (same day):
- **Outfits page draping:** each garment is drafted on its own frame, and the outfit drapes hidden
  behind a "Draping…" badge, then appears settled. Shader error checks run in development only.
  Worst frame 1.6 s → 0.5 s.
- **Mesh:** only collars and lapels get a fine mesh (per-piece `spacing` in `assemble`); the rest is
  back to 3.2 cm.
- **Render-only collars:** stiff collars ride on the shirt and coat necklines (a pointed shirt collar
  on a stand, a lower coat collar), placed against the settled cloth. The simulated collars shredded.
- **Settled placement:** all tailoring is placed against the settled drape, not the cut's rest shape.
- **Sinking:** garments under a coat draw 1 cm sunk, under other layers 6 mm (`Layer.sunk`).
- **Belt:** follows folds without twisting.
- **Coat back:** no hip crease. Epaulettes, the storm flap and the back belt were removed.
- **Fill light:** raised a little; dark arm shadows on the coat looked like holes.
- **Measured cost:** the profile showed the base XPBD solver dominates (collide and step); the
  outfit-only correction passes cost little.

Still open, worst first:
- **XL coat lapels:** they crumple and tear where they join the fronts, so the shirt shows through at
  the shoulders.
- **XL coat front:** balloons forward in relaxed.
- **Coat back:** plain; the guide coat's back isn't shown, so it's unconfirmed.
- **Male S fit:** misses the chart at 1.85 m (bust 97.6 cm vs 91, hips 100 vs 92). It's a side effect
  of the idealised stand-ins and needs a decision.
- **Draping time:** on the headless renderer an outfit still takes ~45 s to appear. That's mostly
  software rendering; it isn't measured on the Intel Mac yet.

## 5. Custom measurements (the product goal)

Users should enter their own measurements and dress an exact replica of their body. Today the bodies
are pre-fitted offline to four size charts (S–XL) and shipped as files, so this doesn't exist yet.

- First inputs: height, bust, waist and hip (what `fit_size` in `tools/anny-export/export.py` uses).
- Design still open: Anny shape controls as morph targets fitted in the browser (live, needs a
  feasibility check), or the exporter run as a local fit service (about 30–60 s per body).
- The current S–XL bodies are idealised stand-ins: 1.72 m / 1.85 m with a `proportions` prior of 0.85.
- Garment drafts must stay driven by `BodyFrame` measurements, never by size names.

## 6. Not reachable live on this hardware

- Path-traced global illumination and true subsurface scattering.
- Cloth meshes of 5 mm or finer on whole garments. The solver cost grows with the particle count; spend
  density on hems, collars and lapels only.
- Hand-modelled hardware such as zips with teeth. Use simplified render-only meshes.

## Status: trench & denim pilot (2026-11-07)

Verified front, side and back on S, M and XL, both genders, in all three poses (18 fits).

Done:
- Wool coat fabric (soft, matte surface with a fibre sheen).
- Per-fabric surfaces for denim, cotton, synthetic and knit.
- Washed denim (slub streaks, faded knees and thighs, dark hem) with orange topstitching.
- Brown leather belt with a gold buckle on the jeans.
- Shirt placket buttons.
- Buttoned sleeve tabs on the coat.
- Tucked shirt clipped below the waistband, so it no longer pokes through the fly.
- Taupe runner sneakers; shoes now follow a lifted foot (toes had come through on the taller bodies).
- Finer mesh (2.2 cm) on the coat and shirt.
- Stronger AO and a dimmer fill light.
- Idealised stand-in bodies.

Still open, worst first:
- **Shirt collar:** the shirt has no visible collar; it reads as a V-neck. The reference has a pointed collar on a stand.
- **Coat collar corners:** they flip up as dark shards at the shoulders, seen from the front and back.
- **Coat back:** a featureless dark sack, with a horizontal crease at the hip on the male bodies.
- **XL relaxed:** the coat drags and bulges at the sides.
- **Side views:** a dark ragged patch on the coat's side in A-pose, probably the coat's inside face showing through.
- **Epaulettes:** not visible; the strap placement finds no upward-facing shoulder cloth.
- **Male S fit:** misses the chart at the new 1.85 m height (bust 97.6 cm vs 91, hips 100 vs 92).
- **Outfits page draping:** slower and messier than the main page. Each frame costs about 2.7× the main
  page's (correction passes), and all garments are drafted in one ~1.7 s frame.
