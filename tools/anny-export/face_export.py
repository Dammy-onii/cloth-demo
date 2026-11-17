"""Anny's face-shape controls as morphs the browser can mix live (src/face/morphs.ts).

Each control is signed: +1 and -1 move the head by two different (each linear) shapes, so both are
saved. Measured on size M in the exported A-pose (same posture, fingers and leg stance as export.py),
in three.js axes. The head barely changes between sizes and poses, so one set per gender serves all.

Writes public/models/face-<gender>.bin (int16 deltas, scaled per control and side) and
public/models/face-<gender>.json (labels, vertex indices, scales, layout). Run after export.py:
    .venv/bin/python face_export.py
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).parent))
import export as E  # noqa: E402

OUT = Path(__file__).resolve().parents[2] / "public" / "models"
# head and face controls; ears included (they show from the side)
FACE = re.compile(r"(l-|r-)?(head|ear|eye|eyebrows|nose|mouth|chin|cheek|forehead)")


def axes(d):
    """Anny (x left, -y forward, z up) to three.js (y up, +z forward), as export.to_three without the floor."""
    return np.stack([d[:, 0], d[:, 2], -d[:, 1]], axis=1)


def main():
    ex = E.Exporter()
    cache = torch.load(Path(__file__).with_name(".fit-cache.pt"))
    labels = [l for l in ex.model.local_change_labels if FACE.match(l)]
    for name, chart in E.SIZE_CHARTS.items():
        c = cache[f"{name}-M"]
        phen, local = c["phen"], c["local"]
        pose = {**c["poses"]["apose"], **c.get("legs", {}).get("apose", {}), **E.finger_pose(), **E.posture_pose()}
        with torch.no_grad():
            base = ex.run(phen, pose, local)["vertices"][0].numpy().astype(np.float64)
            deltas = []
            for i, l in enumerate(labels):
                pair = []
                for w in (1.0, -1.0):
                    # on top of whatever the fitted body already sets for this control
                    v = ex.run(phen, pose, {**local, l: float(local.get(l, 0)) + w})["vertices"][0].numpy().astype(np.float64)
                    pair.append(axes(v - base))
                deltas.append(pair)
                print(f"{name} {i + 1}/{len(labels)} {l}", flush=True)
        d = np.array(deltas)  # control, side, vertex, xyz
        # The head, eyes and neck, plus the torso where the neck joins it. Anny re-fits its skeleton when the
        # head changes, so the hands and arms also shifted by up to a millimetre: not part of a face.
        seg = ex.segment_labels()
        names = list(E.SEGMENTS)
        face = np.isin(seg, [names.index(n) for n in ("head", "eye", "neck")])
        reach = np.linalg.norm(d, axis=3).max(axis=(0, 1))
        neck_base = (seg == names.index("torso")) & (reach > 1e-3)
        moved = np.where((face & (reach > 2e-5)) | neck_base)[0]
        d = d[:, :, moved]
        scale = np.maximum(np.abs(d).max(axis=(2, 3)), 1e-9) / 32767  # per control and side
        q = np.round(d / scale[:, :, None, None]).astype(np.int16)
        (OUT / f"face-{name}.bin").write_bytes(q.tobytes())
        (OUT / f"face-{name}.json").write_text(json.dumps({
            "labels": labels,
            "vertices": moved.astype(int).tolist(),
            "scales": scale.round(10).tolist(),
            "layout": "int16 [control][side: +1, -1][vertex][xyz] times scales[control][side], metres, three.js axes",
        }))
        print(f"{name}: {len(labels)} controls, {len(moved)} vertices, {q.nbytes / 1e6:.1f} MB", flush=True)


if __name__ == "__main__":
    main()
