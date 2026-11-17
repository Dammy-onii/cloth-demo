# Pattern programs: drafting a garment in code

A pattern program drafts one outfit for whatever body it's given, in the same way the workshop outfits
are drafted. Claude writes one from an uploaded photo (the "pattern code" button); the outfits in
`src/build/programs/` are written by hand and are the worked examples. Read
[garment-guide.md](garment-guide.md) for the rules the pattern must follow.

## Form

Plain JavaScript: one function named `build` that takes `kit` and returns a list of garments.

- No imports, no `fetch`, no DOM: it runs in a worker with those removed, and is stopped after 20 s.
- Never hard-code a body's size. Everything comes from `kit`, so the pattern fits every size and
  gender.

```js
function build(kit) {
  const { f, L, level, arm, top } = kit
  const tee = top(f, { ease: 0.02, hem: level(L.high_hip) - f.hipY, sleeve: 'short', neck: { width: 0.012, front: 0.07, back: 0.02 } })
  return [{ name: 'White tee', layer: 0, kind: 'top', fabric: 'jersey', color: '#f2f0ea', fit: 'regular', hold: 'shoulders', ...tee }]
}
```

## Units and directions

- **Units:** metres. The model stands at the origin: y is up, +x is the body's left, +z is forward. Drafts
  use the A-pose, and the cloth is carried to the pose afterwards.
- **A piece** is a flat outline. Corners are counter-clockwise as seen from outside, x across the piece and
  y up from its lowest point.
  - Fronts are drawn as seen from the front: +x is the body's left.
  - Backs are drawn from behind: +x is the body's right.
  - Right-hand copies of left pieces are made with `mirror()`.
- **Edges:** edge k runs from corner k to corner k + 1.
- **A seam** sews chains of edges: `{ a: [['front', 1]], b: [['back', 7]] }`. A third element `true` reverses
  an edge. The sewing direction is found automatically.
- **Optional `Piece` fields:**
  - `holes`: openings, as polygons in the piece's own coordinates.
  - `paths`: `{ [edge]: points }`, so an edge follows any polyline (asymmetric hems, a V-neck).
  - `stretch`: negative ease across the piece, for tight knits.
  - `spacing`: mesh spacing, finer for narrow pieces.

## What a program returns

Each garment:

| Field | Meaning |
|---|---|
| `name` | Shown in the app |
| `layer` | 0 is next to the skin; higher layers drape over lower ones (a bolero over a dress) |
| `kind` | `top`, `bottom`, `dress` or `outer`. Bottoms pass through the arms; the rest pass through the hands |
| `fabric` | `jersey`, `cotton`, `linen`, `silk`, `denim`, `knit`, `synthetic` or `wool` |
| `color` | `#rrggbb` |
| `print` | Optional: `denim` (washed), `rib`, `crochet` (open, see-through), `plaid`, `check`, `stripe`, `pinstripe` or `brocade` |
| `color2` | The print's second colour (plaid and check bands), `#rrggbb` |
| `fit` | `tight` is stretched on and grips the skin (bodycon, fitted knits). Otherwise `regular`, `relaxed` or `oversized` |
| `hold` | Where it hangs from: `shoulders`, `neckline` (strapless or off-shoulder elastic) or `waist` (skirts, trousers) |
| `pieces`, `seams`, `band` | The pattern. `band` lists elastic edges (necklines, waistbands, cuffs). Spreading a draft's result (`...top(f, {...})`) fills all three |

## `kit`

| Member | What it is |
|---|---|
| `f` | `BodyFrame` (src/pattern/drafts.ts): `f.hipY`, `f.crotchY`, `f.neckY`, `f.J[joint]` (joints: `upperarm01.L`, `lowerarm01.L`, `wrist.L`, `upperleg01.L`, `neck01`, …), `f.torso(y)` (cross-section `{a, b, cz}`), `f.leg(y)`, `f.quarter(y, ease)` (arc from front centre to the side), `f.aroundTorso(x, y, isBack, ease)` (a point on the body at arc x), `f.waistY(top)`, `f.bust`, `f.waist`, `f.hip` (girths in m), `f.armR`, `f.wristR`, `f.neckHalfWidth` |
| `L` | Body levels: `neck` 0, `shoulder` 1, `underbust` 2, `waist` 3, `high_hip` 4, `hip` 5, `crotch` 6, `mid_thigh` 7, `above_knee` 8, `knee` 9, `below_knee` 10, `mid_calf` 11, `ankle` 12, `floor` 13. Fractions fall between levels (`L.knee + 0.5`) |
| `level(p)` | The height (m) of a level position on this body |
| `arm(t)` | Length (m) down the arm from the shoulder joint: 0 shoulder, 1 elbow, 2 wrist (2.2 past it) |
| `y` | `{ neck, shoulder, hip, crotch, knee, ankle }` heights (m) |
| `clamp`, `smooth01`, `mirror` | Helpers |

### Drafts

Each draft returns `{ pieces, seams, band }`. You can change its pieces before returning them: add `holes`
or `paths`, or set `stretch`.

**`top(f, o)`**: a front, a back and optional set-in sleeves. Pieces are `front`, `back`, `sleeveL` and `sleeveR`.

| Option | Meaning |
|---|---|
| `ease` | Ease at every height (m); `easeAt(y)` varies it |
| `hem` | Hem height relative to `f.hipY` (negative is below) |
| `sleeve` | `'none'`, `'short'` or `'long'` |
| `sleeveLength` | Sleeve length (m), measured from the shoulder joint |
| `sleeveHemHalf` | Half the sleeve hem's girth: about 0.2 for a bell sleeve |
| `slimSleeves` | Fitted sleeves |
| `neck` | `{ width, front, back }`: half-width past the neck, and the dips at the front and back centre |
| `strap` | Shoulder strap width for sleeveless tops |
| `hemDrop(u)` | How far the front hem drops (m) across the front, u from −1 (body right) to 1. For asymmetric and curved hems |

Front and back edges: 0 hem; 1…n−1 side (+x); n armhole (+x); n+1 shoulder (+x); n+2 neckline;
n+3 shoulder (−x); n+4 armhole (−x); then the side down (−x).

**`dress(f, o)`**: a `top()` bodice cut at the waist with a skirt sewn on. It takes `top`'s options, plus:
- `hemY`: hem height (m);
- `hemGirth`: girth round the hem;
- `waistY`: the waist seam's height.

**`gown(f, { hemY, hemGirth })`**: a boned strapless bodice and a gathered skirt. Use `hold: 'neckline'`.

**`offShoulderDress(f, { hemY, sleeveLength, ruche, tight })`**: the neckline runs across the upper arms.
- The sleeves are gathered tubes.
- `ruche` is the front's extra length (1 for flat, up to about 1.2).
- `tight` makes a bodycon cut.
- Use `hold: 'neckline'`.
- Front edges: 0 hem; 1…n−1 side (+x); n armhole (+x); n+1 neckline; n+2 armhole (−x); the rest the side.

**`trousers(f, { hemY, legEase, hemGirth, hipEase, drop })`**: four leg pieces with a waistband.
- `legEase` is about 0.10 for chinos and 0.16–0.22 for wide legs.
- `hemGirth` is the least hem girth.
- Use `hold: 'waist'`.

**`aSkirt(f, { hemY, hemGirth })`**: front and back panels from the waist. Use `hold: 'waist'`.

**`sleevePair(f, { top, length, capH, half, hemHalf, clear })`** and **`offShoulderSleeves(f, { topY, underY, reach, tight })`**
make sleeves for pieces you draft yourself.

## Rules

From [garment-guide.md](garment-guide.md):

- **Ease by type:**
  - close knits 0.008–0.015;
  - tees 0.02–0.025;
  - shirts 0.022–0.03;
  - overshirts 0.04–0.05;
  - coats: the clearance underneath plus 1.5 cm.
- **Fit:** a bodycon or fitted knit is `fit: 'tight'`. Don't fake it with tiny ease.
- **Long sleeves:** cut 1–2 cm past the wrist.
- **Tethers:** only where a real garment hangs. Never tether an open front.
- **Openings and asymmetry:** keep them (`holes`, `paths`, `hemDrop`). Never symmetrise or fill a design
  feature.
- **Layers:** worn skin outward. Something over a dress or top is `kind: 'outer'` with a higher `layer`.

## Examples

`src/build/programs/`:
- `whiteCutoutMini.js`: off-shoulder, a cut-out as a hole, a wrap hem as a path.
- `denimBellTop.js`: an asymmetric hem, bell sleeves, with trousers.
- `ribbedMaxiBolero.js`: a strapless dress under an outer layer.
