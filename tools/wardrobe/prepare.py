"""Turn the Wikimedia Commons reference photos in source/ into wardrobe textures.

Each garment gets a fabric swatch: a clean patch cropped from the photo (box as fractions of the
image: x0, y0, x1, y1), with the photo's lighting gradient divided out (a large blur is the
illumination estimate), its edges made to wrap so it tiles evenly, and its exposure corrected
towards the fabric's own colour, plus a small card thumbnail of the photo for the wardrobe panel. Output goes to public/wardrobe/. Run with the anny-export venv:

    tools/anny-export/.venv/bin/python -I tools/wardrobe/prepare.py
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / "public" / "wardrobe"
SWATCH = 512
CARD = 240

# crop: the swatch patch; garment: a larger box inside the garment for its overall exposure;
# blur: lighting blur as a fraction of the patch, small for plain fabrics (flattens creases and
# folds too), large for a print so its motifs survive; detail: how much of the patch's texture
# (rib shadows, creases) to keep around its mean colour
CROPS = {
    "henley": dict(crop=(0.40, 0.55, 0.60, 0.80), garment=(0.40, 0.60, 0.60, 0.95), blur=1 / 16, detail=0.3),
    "tank": dict(crop=(0.32, 0.50, 0.68, 0.82), garment=(0.28, 0.40, 0.72, 0.90), blur=1 / 16, detail=1.0),
    "chinos": dict(crop=(0.30, 0.36, 0.44, 0.70), garment=(0.32, 0.40, 0.42, 0.80), blur=1 / 16, detail=1.0),
    "shorts": dict(crop=(0.62, 0.30, 0.76, 0.40), garment=(0.15, 0.25, 0.85, 0.65), blur=1 / 24, detail=0.5),
    "skirt": dict(crop=(0.32, 0.40, 0.76, 0.86), garment=(0.25, 0.25, 0.80, 0.90), blur=1 / 6, detail=1.0),
    "gown": dict(crop=(0.45, 0.70, 0.58, 0.83), garment=(0.38, 0.55, 0.65, 0.92), blur=1 / 24, detail=1.0),
}
# A photo's pixels are fabric colour × the light it was shot in (a white henley reads mid-grey, a red
# gown maroon). Scale so the garment's lit parts (75th-percentile luminance) reach this level,
# never darkening and at most this much brighter.
LIT = 225
MAX_GAIN = 1.8


def even_lighting(img: Image.Image, blur: float) -> Image.Image:
    a = np.asarray(img, np.float32)
    light = np.asarray(img.filter(ImageFilter.GaussianBlur(img.width * blur)), np.float32)
    # keep the patch's mean colour; divide out only the slow brightness variation
    out = a / np.maximum(light.mean(2, keepdims=True), 1) * a.mean((0, 1)).mean()
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


def seamless(img: Image.Image) -> Image.Image:
    """Blend the patch with itself shifted by half a tile, weighted towards the shifted copy at the
    edges (where the shifted copy is continuous across the wrap) and the original in the middle."""
    a = np.asarray(img, np.float32)
    shifted = np.roll(a, (a.shape[0] // 2, a.shape[1] // 2), (0, 1))
    ramp = lambda n: 1 - np.abs(np.linspace(-1, 1, n))
    w = np.minimum(ramp(a.shape[0])[:, None], ramp(a.shape[1])[None, :])[..., None] ** 0.5
    return Image.fromarray(np.clip(a * w + shifted * (1 - w), 0, 255).astype(np.uint8))


LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)


def garment_luma(photo: Image.Image, box):
    w, h = photo.size
    a = np.asarray(photo.crop((round(box[0] * w), round(box[1] * h), round(box[2] * w), round(box[3] * h))), np.float32)
    return a @ LUMA


def exposure_gain(photo: Image.Image, box) -> float:
    return float(np.clip(LIT / max(np.percentile(garment_luma(photo, box), 75), 1), 1, MAX_GAIN))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, c in CROPS.items():
        photo = Image.open(HERE / "source" / f"{name}.jpg").convert("RGB")
        w, h = photo.size
        x0, y0, x1, y1 = c["crop"]
        patch = photo.crop((round(x0 * w), round(y0 * h), round(x1 * w), round(y1 * h)))
        side = min(patch.size)
        patch = patch.crop((0, 0, side, side)).resize((SWATCH, SWATCH), Image.LANCZOS)
        a = np.asarray(seamless(even_lighting(patch, c["blur"])), np.float32)
        # the patch may sit in shadow (the henley's chest): match the garment's median brightness
        a *= np.median(garment_luma(photo, c["garment"])) / max(float((a @ LUMA).mean()), 1)
        mean = a.reshape(-1, 3).mean(0)
        # capped so no channel clips, which would shift the hue (a golden tank turned lemon)
        gain = min(exposure_gain(photo, c["garment"]), 245 / max(mean.max(), 1))
        a = (mean + c["detail"] * (a - mean)) * gain
        Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(OUT / f"{name}-swatch.jpg", quality=88)
        card = photo.copy()
        card.thumbnail((CARD, CARD), Image.LANCZOS)
        card.save(OUT / f"{name}-card.jpg", quality=85)
        print(name, photo.size, f"gain {gain:.2f}", "->", f"{name}-swatch.jpg")


if __name__ == "__main__":
    main()
