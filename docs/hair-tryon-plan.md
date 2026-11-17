# Hairstyle try-on: plan

Drafted 2026-11-14 for the owner's review. Nothing in it is built yet unless marked "exists".

## The use case

1. A user uploads a portrait of their face and head. The app builds their head in 3D.
2. They upload photos of hairstyles they're considering. The app builds each hairstyle on their head.
3. They turn the head and look from every angle, to see how the style will look on them before
   they cut or plait their hair.

The result has to be good enough to make a real decision from. That sets two bars:

- **The head** must be recognisably theirs from the front and three-quarter view, and believable from the
  side and back.
- **The hair** must match the reference photo in the things a barber or braider would be asked for:
  the cut's shape and lengths, the fade's height, the number and direction of rows, the thickness
  and length of braids, and the colour.

## What the user sees: a new page, `/hair`

A page of its own, separate from the clothes pages. The head fills the view.

| Panel | What it does |
|---|---|
| 1. Your portrait | Upload a face photo, choose the female or male base model, and build the head. Two build buttons to compare: "From the photo's face points" and "Claude builds it" |
| 2. Hairstyles | Upload one or more hairstyle photos. Each becomes a saved look in a list; click one to wear it. Each look shows its settings (rows, direction, length and so on), which can be adjusted by hand |
| 3. View | Preset angles (front, left, right, back, top) and a turntable. Toggles for the photo painted on the face and for skin tone |

The head is shown as a bust: head, neck and the tops of the shoulders, so braids that hang to the
shoulders can be judged.

## What exists today

| Piece | State |
|---|---|
| Finding the face (MediaPipe, 478 points) | Exists, checked |
| Fitting the head to the photo and painting the photo on | Exists. Reads as the person from the front and three-quarter view on two test photos |
| Claude building the head by eye | Exists. Clean but more generic |
| Head studio (head alone, turnable) | Exists, inside the clothes page |
| Hairstyles | Four fixed styles: sleek bun, short crop, short afro, straight-back cornrows. None is adjustable |
| Reading a hairstyle from a photo | Not built. Claude only names the hair it sees in the face photo |

Known faults to fix along the way:

- **Skull distortion:** the head fit reshapes the whole skull from a face photo (a pinched, cone-shaped
  head on a close selfie).
- **Close-up selfies:** they distort the face (large nose and chin), and the app doesn't warn about them.
- **Cornrows:** flat and blocky.
- **Skin:** too glossy.

## How a hairstyle photo becomes hair

Claude can't model hair strand by strand, but it reads a photo into a precise description well.
So each family of styles is built as an adjustable generator, and Claude fills in its settings.

1. **Claude reads the hairstyle photo** and returns the family and its settings (below), plus the
   hair colour. The photo can be of anyone, from any angle.
2. **The generator grows the hair** on the user's own head from those settings.
3. **Claude checks it:** it compares renders of the head (front, side, back) with the reference photo
   and corrects the settings, for up to two rounds.
4. **The user can adjust** any setting by hand afterwards.

### The two families to build first (the owner's choice)

**Cuts: fades and low cuts**

| Setting | Range |
|---|---|
| Length on top | 1 mm (skin-close) to about 5 cm |
| Fade | None, low, mid, high; how gradually it blends |
| Sides and back length | Skin to the same as the top |
| Texture | Tight coils, waves, or straight |
| Line-up | Natural hairline or a sharp, squared edge |
| Shape on top | Flat, rounded, or longer at the front |
| Colour | Any |

**Cornrows and stitch braids**

| Setting | Range |
|---|---|
| Number of rows | 2 to about 20 |
| Direction | Straight back, swept to one side, curved, or zigzag |
| Row thickness | Thin to chunky |
| Parting | Whether the scalp shows between rows, and how wide |
| Ends | Finished at the nape, or hanging: length from the nape to the waist |
| Colour | Any, including a second colour for added hair |

Later families, not in this plan: box braids and twists, afros and puffs, locs, long loose hair.

## Stages

Each stage ends with renders I check and show, and a plain list of what wasn't checked.

### Stage 1: a head worth putting hair on

- Stop the fit reshaping the skull; fit face features only.
- Detect close-up selfies and warn, asking for a photo from about a metre away at eye level.
- Tone down the skin gloss.
- Show the bust (head, neck, shoulder tops).

**Done when:** the two test portraits and a close selfie all give a normal-shaped head.

### Stage 2: adjustable hair

- Rebuild the crop and afro as one "cut" generator with the settings above.
- Rebuild the cornrows with rounder plaits and the settings above.
- Hair colour.

**Done when:** a sheet of renders shows each setting changing the hair as described, on both base
models, from the front, side and back.

### Stage 3: hairstyle photos

- Claude reads a hairstyle photo into settings.
- Claude's check-and-correct loop against the photo.
- Saved looks, each adjustable.

**Done when:** for at least three cut photos and three cornrow photos, the rendered hair matches the
photo's shape, lengths, row count and direction, shown side by side.

### Stage 4: the `/hair` page

- The three panels above, preset angles and the turntable.
- The face code shared with the clothes page, not copied.

**Done when:** the whole flow works in the page from a fresh load: portrait, two hairstyle photos,
switching between looks, all five angles.

## Limits to expect

- **The side and back of the head are estimated.** One portrait can't show them. A second photo
  from the side would improve this and could be added later.
- **Hair is matched to the two families first.** A photo of a style outside them gets the nearest one, and the app
  says so.
- **Hair doesn't move.** It's fixed to the head; hanging braids don't swing or drape over shoulders.
- **The user's own current hair isn't removed from the portrait's painted face.** Hair across the
  forehead in the portrait will show on the skin. The photo tips will ask for hair pulled back.
- **Speed on the Intel Mac isn't measured.** Each Claude step takes roughly 15 to 40 seconds.

## Open questions for the owner

1. Should a look be saveable between visits (kept in the browser), or only for the session?
2. Should the page export pictures (a sheet of all five angles) to show a barber or braider?
3. Is a second portrait from the side worth asking users for, for a truer profile?
