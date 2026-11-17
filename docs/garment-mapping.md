# Garment mapping: from any photo to the model

The owner's specification for uploaded clothes, with the additions agreed on 2026-11-07 and how the code
implements it. Read it before changing the upload path (`src/photo/`, `src/cloth/garmentRead.ts`,
`src/pattern/custom.ts`, `server/claude-bridge.mjs`).

## The rule

**Don't simplify, normalise, symmetrise or "repair" unusual designs.** Read the specific garment: its
silhouette, neckline, sleeves, seams, openings, cut-outs, slits, layers, asymmetry and hem. Map exactly that
onto the model. The garment type ("dress", "top") is a label, never a template: two dresses can have
completely different anchors.

## What must be preserved

- **Silhouette, proportions and fit:** how far the garment stands off the body at each height.
- **Necklines:** every kind (deep V, plunge, off-shoulder, strapless, one-shoulder, halter, crossover,
  asymmetric), with anchors wherever the edge changes direction. The exposed area stays exposed.
- **Openings and cut-outs:** negative space with its own boundary, kept at the same place on the body. Never
  filled with fabric.
- **Asymmetry:** left and right detected separately and never mirrored. Diagonal hems, one sleeve, one
  shoulder, uneven lengths.
- **Slits:** separate edges, never sewn shut. The body shows through.
- **Draping, gathering, ruching, wraps:** the anchors that control the fabric (wrap origin, crossing point,
  tension points), not every wrinkle.
- **Lower body:** waist, hips, crotch, inner and outer leg seams, knees, hems, slits. Trousers and skirts sit
  differently.

## Anchors

Detected per garment, as many as it needs:

| Kind | Examples |
|---|---|
| Primary | Shoulder seams, neck points, waistline, hips: where the garment sits on the body |
| Structural | Side seams, armholes, sleeve joins, centre seams, corners, changes of direction |
| Feature | V-neck origins and lowest point, cut-out corners, slit top and edges, wrap crossing |
| Boundary | Points along every edge: outer outline, each opening, each slit side |
| Tension (added) | Where the garment hangs from or is held: shoulders, neckline elastic, waistband, wrap tie |

## Additions to the specification

1. **Hidden versus open.** In a worn photo an arm or hand over the garment looks like a cut-out. Every gap is
   labelled as an intentional opening or as occluded. Occluded areas are fabric.
2. **The back.** A front photo can't show the back. Claude infers it (plain, open back, back slit), and an
   optional second photo of the back replaces the guess.
3. **Geometry from pixels, meaning from Claude.** Edges come from the segmentation mask; Claude labels what
   each edge is and where the features are. Body joints come from MediaPipe Pose in the browser; Claude's own
   estimates were a few percent off.
4. **Tension points** hold the garment in the simulation, so fitted garments neither slide down nor ride up.
5. **Wrinkles aren't structure.** Gathering is recorded as extra fabric between anchors (ruched 1.3×), and the
   physics makes the folds.
6. **Confidence.** Each detected feature carries one, and the app shows uncertain ones for the user to confirm.

## How it's built: body coordinates

Every photo point is turned into body coordinates, which don't depend on the photo's pose or the wearer's
build:

- **Height:** the photo's y is mapped piecewise between the wearer's joints (shoulders, hips, knees, ankles,
  from MediaPipe) onto the same joints of the model. A point halfway from hip to knee in the photo is halfway
  from hip to knee on the model.
- **Across:** `u`, from −1 at the garment's right side seam (the image's left) to +1 at its left side seam,
  at that height. Ease (how far the side seams stand off the body) comes from the garment's width over the
  body's width at each level.
- **Sleeves:** along the arm (0 shoulder, 1 elbow, 2 wrist, from the wearer's own joints) and around it.

The front panel's outline (hem curve, side seams, armholes, neckline curve) is drawn in these coordinates
straight from the photo's anchors. Openings are holes in the mesh; slits are notches in the hem. The back is
the inferred or photographed back, sharing the side seams. The panels are placed round the model's own
cross-sections (`BodyFrame.aroundTorso`) and draped. The photo prints through the same mapping, so every
anchor lands where it was.

## Stages

1. **Stage 1:**
   - MediaPipe landmarks; body coordinates.
   - Front outline from the photo: hem curve, neckline curve and asymmetry.
   - Cut-outs as holes; slits.
   - Inferred back; the anchor-based hold.
   - Photo printing through the mapping.
2. **Stage 2:** wraps and overlapping layers, ruching amounts, an optional back photo, confidence in the UI, and
   trousers drawn from their own outline.
3. **Stage 3:** layering (a jacket over a top), using the outfits page's layered stage.

## Validation

After draping, check automatically:
- every opening still shows skin, and no slit has closed;
- left and right hem heights match the photo;
- the neckline sits where it should.

Then Claude compares the render with the photo and corrects what's off.
