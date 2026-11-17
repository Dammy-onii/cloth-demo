# Pattern specs: drafting a garment as data

A pattern spec describes an outfit's pieces as JSON (the "pattern spec" button). The app turns it into
pieces like the pattern library's (`src/build/spec.ts`); nothing in it is run. It's simpler than a
[pattern program](pattern-api.md) and can only draw what the format below allows. Follow
[garment-guide.md](garment-guide.md).

## Form

```json
{ "garments": [ {
  "name": "Strapless tube dress", "layer": 0, "kind": "dress",
  "fabric": "jersey", "color": "#7a1f2b", "fit": "tight", "hold": "neckline",
  "pieces": [
    { "name": "front", "on": "front", "outline": [[-1, 10], [1, 10], [1, 2], [-1, 2]], "ease": [[2, 0.004], [5, 0.02], [10, 0.1]] },
    { "name": "back", "on": "back", "outline": [[-1, 10], [1, 10], [1, 2], [-1, 2]], "ease": [[2, 0.004], [5, 0.02], [10, 0.1]] }
  ],
  "seams": [ { "a": [["front", 1]], "b": [["back", 3]] }, { "a": [["front", 3]], "b": [["back", 1]] } ],
  "band": [["front", 2], ["back", 2]]
} ] }
```

The garment fields are those of a pattern program: `name`, `layer`, `kind`, `fabric`, `color`, `print`,
`fit` and `hold`. See [pattern-api.md](pattern-api.md#what-a-program-returns).

## Pieces

| Field | Meaning |
|---|---|
| `on` | `front` or `back` wrap the torso, and below the crotch both legs together, which is how skirts and dresses hang. `armL` and `armR` are tubes round one arm. `legL` and `legR` are tubes round one leg |
| `outline` | Corners `[u, h]`, counter-clockwise as seen from outside. Edge k runs from corner k to k + 1 |
| `ease` | Cloth off the body (m): one number, or `[h, ease]` pairs down the piece (a flared skirt grows towards its hem) |
| `holes` | Openings (cut-outs) in the same `[u, h]` coordinates |

### Coordinates

**On `front` and `back`:**
- `u` runs from −1 to 1, side seam to side seam. On the front +1 is the body's left; on the back, drawn from
  behind, +1 is the body's right. So the front's +1 side seam sews to the back's −1.
- `h` is a body level:

  | Level | h |
  |---|---|
  | `neck` | 0 |
  | `shoulder` | 1 |
  | `underbust` | 2 |
  | `waist` | 3 |
  | `high_hip` | 4 |
  | `hip` | 5 |
  | `crotch` | 6 |
  | `mid_thigh` | 7 |
  | `above_knee` | 8 |
  | `knee` | 9 |
  | `below_knee` | 10 |
  | `mid_calf` | 11 |
  | `ankle` | 12 |
  | `floor` | 13 |

  Fractions fall between levels. A point's height on any body comes from that body's own levels.

**On `armL` and `armR`:**
- `u` runs from −1 to 1 round the arm; ±1 is the underarm seam.
- `h` runs down the arm: 0 is the shoulder joint, 1 the elbow, 2 the wrist.

**On `legL` and `legR`:**
- `u` runs from −1 to 1 round the leg: 0 is the front and ±1 the back seam.
- `h` is a body level.

## Seams and bands

- **Seams:** `{ "a": [[piece, edge], …], "b": [[piece, edge], …] }`. Each side lists edges in order; the
  sewing direction is found automatically.
- **Bands:** `band` lists elastic edges (necklines, waistbands, cuffs) that hold the garment up.

## Limits

- No set-in sleeve caps: join arm tubes to the torso along straight edges.
- No collars or buttons.

For anything the format can't draw, use a pattern program.
