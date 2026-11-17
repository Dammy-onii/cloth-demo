"""Export Anny (NAVER, Apache 2.0) mannequins for the web viewer.

For each gender we fit S/M/L/XL to size-chart height and waist, solve three poses,
give them a blank mannequin head and a sculpted bust, and write one binary blob of
positions (all variants) + triangle indices, plus a JSON manifest with measurements.

Anny is Z-up with -Y facing forward; we convert to three.js Y-up, +Z forward, feet at y=0.
"""
import json
import math
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")

import numpy as np
import scipy.sparse as sp
import scipy.sparse.csgraph
import scipy.sparse.linalg
import scipy.spatial
import scipy.spatial.transform
import torch
import anny

OUT = Path(__file__).resolve().parents[2] / "public" / "models"
AGE_YOUNG_ADULT = 2 / 3  # anchors: newborn -1/3, baby 0, child 1/3, young 2/3, old 1

# Height (m) and tape-measure girths (cm) the fit aims for. Heights are fashion-model stature
# (the quality bar is model_guides/), still within the normal range.
SIZE_CHARTS = {
    "female": {"gender": 1.0, "height": 1.72, "sizes": {
        "S": {"waist": 69, "bust": 87, "hip": 94},
        "M": {"waist": 74, "bust": 92, "hip": 99},
        "L": {"waist": 81, "bust": 99, "hip": 106},
        "XL": {"waist": 89, "bust": 107, "hip": 114},
    }},
    "male": {"gender": 0.0, "height": 1.85, "sizes": {
        "S": {"waist": 76, "bust": 91, "hip": 92},
        "M": {"waist": 84, "bust": 99, "hip": 99},
        "L": {"waist": 94, "bust": 107, "hip": 106},
        "XL": {"waist": 104, "bust": 117, "hip": 113},
    }},
}
POSES = ["apose", "relaxed", "hips", "stride", "onehip"]
# poses that borrow another pose's leg stance
STANCE_OF = {"onehip": "relaxed"}
# Hands at rest curl: straight, splayed fingers read as a mannequin's next to the model_guides
# renders. Flex (rad) at the knuckle, middle and end joints; the little finger curls most. Positive
# rotation about each finger bone's local y bends it towards the palm (probed in the relaxed pose).
FINGER_CURL = {1: (0.08, 0.15, 0.12), 2: (0.14, 0.32, 0.22), 3: (0.18, 0.38, 0.26), 4: (0.22, 0.42, 0.28), 5: (0.26, 0.46, 0.3)}
# bump to re-solve the cached leg stances after changing Exporter.STANCES
LEGS_VERSION = 3
# "face": Anny's own head (a real face; hair comes later); "dome": the blank display-mannequin head
HEAD = "face"
NECK_CUT = 0.2  # cut plane position along neck01 → head joint; everything above becomes the dome
DOME_RINGS = 28
NECK_SEAM = 0.05  # m of neck below the cut that is smoothed together with the dome's base
# Head shape: Anny's head outline sampled on a sphere of directions, then smoothed on the sphere.
HEAD_CLIP = 0.003  # features standing out > 3 mm from a broad (22°) smoothing (nose, lips, ears) are clipped
HEAD_SMOOTH = (22, 10)  # degrees: broad pass for the clip, final pass for the surface
# Fibreglass bust (female): breast depth and base radius (m) per size. Anny's own breasts only
# stand ~2 cm proud of the chest and end in a nipple cone, so we resculpt them; the ribcage under
# them is then narrowed with Anny's `measure-bust-circ-incr` until the tape bust hits the chart.
# (depth, base radius, reshaped region radius)
BUST_SHAPE = {"S": (0.040, 0.068, 0.10), "M": (0.044, 0.072, 0.11), "L": (0.049, 0.077, 0.12), "XL": (0.055, 0.083, 0.135)}
# Anny's own local shape control: fibreglass mannequins have a flat navel.
MANNEQUIN_LOCAL_CHANGES = {"stomach-navel-out": 0.6}
# Female mannequin curves: Anny's shape at a given girth is fairly straight (broad shoulders, V-shaped
# torso, little waist or seat), so the female mannequin read as male. These give a waist, flared hips,
# a fuller seat and thighs, and narrower shoulders; the size fit then rebalances weight so the tape
# girths still match the chart (which deepens the waist further). Stronger hip and thigh boosts
# pushed the hips 6-10 cm over the chart.
FEMALE_CURVES = {"measure-shoulder-dist-incr": -0.5, "torso-vshape-incr": -0.6, "buttocks-volume-incr": 0.5,
                 "hip-scale-horiz-incr": 0.1, "measure-waist-circ-incr": -0.4,
                 "l-upperleg-fat-incr": 0.15, "r-upperleg-fat-incr": 0.15}
# Face sculpt: Anny's neutral face read as a blank mannequin beside the model_guides renders.
# Towards defined fashion-model features: higher cheekbones, a firmer jaw and chin, slightly larger
# almond eyes with lifted outer corners, fuller lips with a clear cupid's bow, more arched brows.
# Nose width and other ethnic markers are left alone; skin tone is chosen separately.
FACE = {
    "female": {"cheek-bones-incr": 0.4, "cheek-inner-incr": -0.15, "eye-scale-incr": 0.25, "eye-corner2-up": 0.35,
               "chin-prominent-incr": 0.2, "chin-width-incr": -0.25, "mouth-cupidsbow-incr": 0.5,
               "mouth-upperlip-volume-incr": 0.25, "mouth-lowerlip-volume-incr": 0.2, "eyebrows-angle-up": 0.3},
    "male": {"cheek-bones-incr": 0.45, "cheek-inner-incr": -0.3, "eye-scale-incr": 0.25, "eye-corner2-up": 0.15,
             "chin-prominent-incr": 0.35, "chin-bones-incr": 0.45, "chin-width-incr": 0.15,
             "mouth-cupidsbow-incr": 0.3, "mouth-upperlip-volume-incr": 0.1},
}


def face_changes(gender):
    """FACE as Anny local changes: cheek and eye controls are per side (l-/r-)."""
    sided = ("cheek-", "eye-")
    out = {}
    for k, v in FACE["female" if gender > 0.5 else "male"].items():
        for name in ([f"l-{k}", f"r-{k}"] if k.startswith(sided) else [k]):
            out[name] = v
    return out


# Soft priors (mean, sd) so the size fit stays a natural body instead of exploiting extremes; the
# female muscle mean is lower, as high muscle also squares the shoulders and straightens the torso.
# Proportions run from uncommon (0) to idealised (1). A mean of 0 gave short-legged, average figures
# beside the fashion renders in model_guides/; the tape girths still pin each size to its chart.
SHAPE_PRIORS = {"muscle": (0.5, 0.12), "proportions": (0.85, 0.12)}
FEMALE_PRIORS = {**SHAPE_PRIORS, "muscle": (0.3, 0.12)}
# Order matters: the index is the label value the web app reads.
SEGMENTS = {
    "torso": ("root", "spine", "pelvis", "clavicle", "shoulder"),
    "neck": ("neck01",),
    "head": ("neck02", "neck03", "head"),
    "upperarm": ("upperarm",),
    "forearm": ("lowerarm",),
    "hand": ("wrist", "finger", "metacarpal"),
    "upperleg": ("upperleg",),
    "lowerleg": ("lowerleg", "foot", "toe"),
    "eye": ("eye",),  # eyeballs, shaded as eyes rather than skin
}
JOINTS = ["root", "spine03", "neck01", "head", "upperarm01.L", "upperarm01.R", "lowerarm01.L",
          "lowerarm01.R", "wrist.L", "wrist.R", "upperleg01.L", "upperleg01.R"]


def boundary_loops(faces):
    """Ordered boundary loops (edges used by one face), following face winding."""
    directed = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    lo, hi = directed.min(1), directed.max(1)
    key = lo * (int(faces.max()) + 1) + hi
    keys, counts = np.unique(key, return_counts=True)
    boundary = directed[np.isin(key, keys[counts == 1])]
    nxt = dict(zip(boundary[:, 0].tolist(), boundary[:, 1].tolist()))
    loops, seen = [], set()
    for start in list(nxt):
        loop, v = [], start
        while v not in seen and v in nxt:
            seen.add(v)
            loop.append(v)
            v = nxt[v]
        if len(loop) > 2:
            loops.append(np.array(loop))
    return loops


def vertex_normals(v, faces):
    """Area-weighted vertex normals."""
    fn = np.cross(v[faces[:, 1]] - v[faces[:, 0]], v[faces[:, 2]] - v[faces[:, 0]])
    n = np.zeros_like(v)
    for k in range(3):
        np.add.at(n, faces[:, k], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


# Posture: Anny stands with the head ~4 cm ahead of the neck and a rounded upper back, which read as a
# slouch beside the model_guides figures. Lift the chest, draw the shoulders back and bring the head
# up over the spine, the chin kept level (local axis-angles; −x extends the spine and neck, +z on the
# left collarbone draws that shoulder back, mirrored on the right).
# (The first values, twice these, arched the body back and tipped the chin up.)
POSTURE = {"spine02": (-0.015, 0, 0), "spine01": (-0.035, 0, 0), "neck01": (-0.08, 0, 0), "neck02": (-0.03, 0, 0),
           "head": (0.1, 0, 0), "clavicle.L": (0, 0, 0.08), "clavicle.R": (0, 0, -0.08)}


def posture_pose():
    return {b: axis_angle(torch.tensor(v, dtype=torch.float32)) for b, v in POSTURE.items()}


def finger_pose():
    """Local axis-angles curling both hands' fingers (FINGER_CURL), the right mirrored like the arms."""
    pose = {}
    for finger, flex in FINGER_CURL.items():
        for joint, angle in enumerate(flex, 1):
            # the thumb also swings in towards the index finger (+z; −z swung it further out);
            # splayed, it stuck out sideways
            tuck = 0.4 if finger == 1 and joint == 1 else 0.0
            pose[f"finger{finger}-{joint}.L"] = axis_angle(torch.tensor([0.0, angle, tuck]))
            pose[f"finger{finger}-{joint}.R"] = axis_angle(torch.tensor([0.0, -angle, -tuck]))
    return pose


def arm_params(pose):
    """Left-arm axis-angles (upperarm, lowerarm, wrist) of a solved pose, to start the IK from."""
    return torch.tensor(np.stack([scipy.spatial.transform.Rotation.from_matrix(pose[b][0, :3, :3].numpy()).as_rotvec()
                                  for b in ["upperarm01.L", "lowerarm01.L", "wrist.L"]]), dtype=torch.float32)


def axis_angle(v):
    """Rodrigues: axis-angle (3,) -> homogeneous (1,4,4), differentiable."""
    th = v.norm() + 1e-9
    k = v / th
    K = torch.zeros(3, 3)
    K[0, 1], K[0, 2], K[1, 0] = -k[2], k[1], k[2]
    K[1, 2], K[2, 0], K[2, 1] = -k[0], -k[1], k[0]
    R = torch.eye(3) + torch.sin(th) * K + (1 - torch.cos(th)) * (K @ K)
    M = torch.eye(4).clone()
    M[:3, :3] = R
    return M[None]


class Exporter:
    def __init__(self):
        self.model = anny.Anny(phenotypes="all", extrapolate_phenotypes=True, local_changes="default")
        self.anthro = anny.Anthropometry(self.model)
        self.labels = self.model.bone_labels
        self.vertex_count = self.model.vertex_bone_weights.shape[0]
        self.faces = self.model.faces.numpy().astype(np.int64)
        w, i = self.model.vertex_bone_weights, self.model.vertex_bone_indices
        self.bone_weight = lambda names: sum(
            ((i == self.labels.index(n)) * w).sum(-1) for n in names
        ).numpy()
        side_bones = lambda *keys: [b for b in self.labels if b.endswith((".L", ".R")) and any(k in b for k in keys)]
        self.arm_mask = self.bone_weight(side_bones("arm", "wrist", "finger", "metacarpal")) > 0.5
        # Forearm + hand only: the upper arm always touches the torso at the armpit.
        self.lower_arm_mask = self.bone_weight(side_bones("lowerarm", "wrist", "finger", "metacarpal")) > 0.5
        self.torso_mask = self.bone_weight(
            [b for b in self.labels if b.startswith(("spine", "pelvis", "root"))]) > 0.5
        self.head_weight = np.clip(self.bone_weight(["head", "eye.L", "eye.R"]), 0, 1)
        if HEAD == "dome":
            self.faces = self.replace_head_with_dome(self.faces)
        else:
            self.above = np.where(self.head_region())[0]
            self.faces = self.faces.astype(np.uint32)  # the web app reads 32-bit indices
        self.init_bust()
        n = self.vertex_count
        e = self.faces.astype(np.int64)
        e = np.concatenate([e[:, [0, 1]], e[:, [1, 2]], e[:, [2, 0]]])
        adj = sp.coo_matrix((np.ones(2 * len(e)), (np.r_[e[:, 0], e[:, 1]], np.r_[e[:, 1], e[:, 0]])),
                            shape=(n, n)).tocsr()
        adj.data[:] = 1
        self.umbrella = sp.diags(1 / np.maximum(np.asarray(adj.sum(1)).ravel(), 1)) @ adj  # neighbour average
        # Directions on the unit sphere (Fibonacci lattice) the head outline is sampled along.
        k = np.arange(4000) + 0.5
        z = 1 - 2 * k / len(k)
        t = np.pi * (1 + 5 ** 0.5) * k
        self.sphere = np.stack([np.sqrt(1 - z * z) * np.cos(t), np.sqrt(1 - z * z) * np.sin(t), z], 1)

    def init_bust(self):
        """Nipple vertex per side on the average female: the most forward torso point at bust height."""
        with torch.no_grad():
            v = self.model(phenotype_kwargs={"gender": 1.0, "age": AGE_YOUNG_ADULT})["rest_vertices"][0].numpy()
        cand = np.where(self.torso_mask & ~self.arm_mask)[0]
        fz = (v[cand, 2] - v[:, 2].min()) / np.ptp(v[:, 2])
        self.nipples = [int(c[np.argmin(v[c, 1])]) for c in
                        (cand[(v[cand, 0] * sgn > 0.03) & (fz > 0.66) & (fz < 0.78)] for sgn in (1, -1))]

    def head_region(self, full=False):
        """Template vertices above a plane across the upper neck, perpendicular to neck01 → head."""
        with torch.no_grad():
            out = self.model(phenotype_kwargs={"age": AGE_YOUNG_ADULT})
        v = out["rest_vertices"][0].numpy()
        heads = out["rest_bone_heads"][0].numpy()
        neck, head = heads[self.labels.index("neck01")], heads[self.labels.index("head")]
        axis = (head - neck) / np.linalg.norm(head - neck)
        above = (v - (neck + NECK_CUT * (head - neck))) @ axis > 0
        return (above, v, axis) if full else above

    def replace_head_with_dome(self, faces):
        """Swap Anny's face for an abstract blank head, the classic display-mannequin look.

        Cut the template with a plane across the upper neck, perpendicular to the neck axis
        (neck01 → head joint), deleting every face entirely above it; the eyeballs and mouth interior
        go with it. That leaves one boundary loop around the neck. Stitch a dome of DOME_RINGS rings
        (+ a crown vertex) onto it, reusing the freed head vertices so every exported variant keeps
        the same vertex layout. Positions are set per variant in `mannequin_head`."""
        above, v, axis = self.head_region(full=True)
        self.above = np.where(above)[0]  # sampled per variant for the head outline
        faces = faces[~above[faces].all(1)]
        n = self.vertex_count
        e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]]])
        _, comp = scipy.sparse.csgraph.connected_components(
            sp.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)), directed=False)
        faces = faces[comp[faces[:, 0]] == np.bincount(comp[faces[:, 0]]).argmax()]
        ring0 = max(boundary_loops(faces), key=lambda l: (v[l] @ axis).mean())
        free = np.setdiff1d(np.where(above)[0], np.unique(faces))
        m = len(ring0)
        assert len(free) >= DOME_RINGS * m + 1, "not enough freed head vertices for the dome"
        rings = [ring0] + [free[i * m:(i + 1) * m] for i in range(DOME_RINGS)]
        crown = free[DOME_RINGS * m]
        tris = []
        for lower, upper in zip(rings[:-1], rings[1:]):
            for j in range(m):
                k = (j + 1) % m
                # ring0 runs along the remaining faces' winding, so the dome uses the opposite order
                tris += [[lower[k], lower[j], upper[j]], [lower[k], upper[j], upper[k]]]
        tris += [[rings[-1][(j + 1) % m], rings[-1][j], crown] for j in range(m)]
        self.dome = (rings, crown)
        return np.concatenate([faces, np.array(tris)]).astype(np.uint32)

    def run(self, phen, pose=None, local=None):
        curves = FEMALE_CURVES if float(phen["gender"]) > 0.5 else {}
        return self.model(pose_parameters=pose or None, phenotype_kwargs=phen,
                          local_changes_kwargs={**MANNEQUIN_LOCAL_CHANGES, **curves, **face_changes(float(phen["gender"])), **(local or {})})

    def joint(self, out, name):
        return out["bone_poses"][0, self.labels.index(name), :3, 3]

    # --- shape fitting -------------------------------------------------------
    def tape_rings(self, gender):
        """Vertex loops a tape measure would touch at bust/waist/hip on an average body.

        Convex hulls are not differentiable, so we pick the hull vertices once and then measure
        those same loops (ordered by angle) on every candidate shape, which is smooth in the shape."""
        with torch.no_grad():
            v = self.to_three(self.run({"gender": gender, "age": AGE_YOUNG_ADULT})["rest_vertices"][0].numpy())
        height = float(v[:, 1].max())
        ids = np.arange(len(v))
        rings = {}
        for name, (lo, hi, pick) in {"bust": (0.70, 0.76, max), "waist": (0.58, 0.64, min),
                                     "hip": (0.47, 0.53, max)}.items():
            heights = np.linspace(lo, hi, 13) * height
            best = pick(heights, key=lambda h: self.girth(v, h))
            sel = ids[(~self.arm_mask) & (np.abs(v[:, 1] - best) < 0.005)]
            hull = sel[scipy.spatial.ConvexHull(v[sel][:, [0, 2]]).vertices]
            c = v[hull][:, [0, 2]].mean(0)
            order = np.argsort(np.arctan2(v[hull, 2] - c[1], v[hull, 0] - c[0]))
            rings[name] = torch.as_tensor(hull[order])
        return rings

    @staticmethod
    def ring_length(rest_vertices, ring):
        p = rest_vertices[0, ring][:, :2]  # Anny is z-up: horizontal girth lives in x, y
        return (p - torch.roll(p, 1, 0)).norm(dim=-1).sum()

    def fit_size(self, gender, height_m, targets, rings):
        """Adam over (weight, muscle, proportions, height) so the tape loops and stature match the
        size chart. Weight may extrapolate past 1 for the larger sizes. Cup size stays fixed: the
        female bust is resculpted afterwards (see sculpt_bust) and the bust target accounts for it."""
        names = ["weight", "muscle", "proportions", "height"]
        upper = torch.tensor([1.6, 1.0, 1.0, 1.0])
        z = torch.zeros(len(names), requires_grad=True)
        opt = torch.optim.Adam([z], lr=0.05)
        fixed = {"gender": gender, "age": AGE_YOUNG_ADULT, "cupsize": 0.5 if gender > 0.5 else 0.0}
        phen = lambda x: {**fixed, **{n: x[i][None] for i, n in enumerate(names)}}
        for _ in range(300):
            x = torch.sigmoid(z) * upper
            rv = self.run(phen(x))["rest_vertices"]
            loss = sum(((self.ring_length(rv, rings[k]) * 100 - targets[k]) / 3) ** 2 for k in rings)
            loss = loss + ((self.anthro.height(rv)[0] - height_m) * 100) ** 2
            priors = FEMALE_PRIORS if gender > 0.5 else SHAPE_PRIORS
            loss = loss + sum(((x[names.index(k)] - mu) / sd) ** 2 for k, (mu, sd) in priors.items() if k in names)
            opt.zero_grad()
            loss.backward()
            opt.step()
        x = (torch.sigmoid(z) * upper).detach()
        return {**fixed, **{n: float(x[i]) for i, n in enumerate(names)}}

    # --- pose solving --------------------------------------------------------
    def solve_arm(self, phen, objective, local=None, steps=300, init=None):
        """Gradient-descent IK for the left arm (shoulder, elbow, wrist axis-angles), mirrored to the right.

        objective(out, joint) returns the pose-specific loss; on top of it a contact term keeps the
        forearm and hand outside the body: every forearm/hand vertex a must satisfy
        (a − t)·n_t ≥ margin against its nearest torso/leg vertex t (normal n_t, taken at rest)."""
        rest = self.run(phen, local=local)
        rv = rest["vertices"][0].detach()
        body = np.where(~self.arm_mask & (self.head_weight < 0.5))[0]
        body = torch.as_tensor(body[np.isin(body, self.above, invert=True)])
        normals = torch.as_tensor(vertex_normals(rv.numpy().astype(np.float64), self.faces), dtype=rv.dtype)
        tv, tn = rv[body], normals[body]
        hand = torch.as_tensor(np.where(self.lower_arm_mask & (rv[:, 0].numpy() > 0))[0][::2])
        joint = lambda out, name: out["bone_poses"][0, self.labels.index(name), :3, 3]
        params = (torch.zeros(3, 3) if init is None else init.clone()).requires_grad_(True)
        opt = torch.optim.Adam([params], lr=0.03)
        bones = ["upperarm01.L", "lowerarm01.L", "wrist.L"]
        for step in range(steps):
            out = self.run(phen, {b: axis_angle(params[i] + 1e-4) for i, b in enumerate(bones)}, local)
            a = out["vertices"][0, hand]
            with torch.no_grad():
                nearest = torch.cdist(a, tv).argmin(1)
            depth = ((a - tv[nearest]) * tn[nearest]).sum(-1)
            loss, margin = objective(out, lambda n: joint(out, n), rv)
            score = float(loss)
            # contact phases in after the arm has swung near its target (else it blocks the path)
            loss = loss + 4000 * min(step / 100, 1) * torch.relu(margin - depth).pow(2).sum() + 0.02 * params[2].pow(2).sum()
            opt.zero_grad()
            loss.backward()
            opt.step()
        p = params.detach()
        mirror = torch.tensor([1., -1., -1.])  # reflect axis-angle across the x=0 plane
        pose = {b: axis_angle(p[i]) for i, b in enumerate(bones)}
        pose.update({b.replace(".L", ".R"): axis_angle(p[i] * mirror) for i, b in enumerate(bones)})
        return pose, score

    @staticmethod
    def direction(a, b):
        return (b - a) / (b - a).norm()

    def relaxed_pose(self, phen, local=None, init=None):
        """Arms hanging naturally: upper arm ~9° out from vertical, elbow softly bent, palm facing
        the thigh (thumb forward), forearm and hand kept ≥ 2.5 cm off the hips and thighs.
        Anny axes: +x = body left, −y = forward, +z = up."""
        upper = torch.tensor([0.16, 0.02, -0.987])
        fore = torch.tensor([0.06, -0.2, -0.978])
        fore = fore / fore.norm()

        def objective(out, j, rv):
            d = self.direction
            loss = 20 * (d(j("upperarm01.L"), j("lowerarm01.L")) - upper).pow(2).sum()
            loss = loss + 20 * (d(j("lowerarm01.L"), j("wrist.L")) - fore).pow(2).sum()
            # palm inward: thumb base ahead of the middle finger (−y), fingers pointing down
            loss = loss + 5 * torch.relu(j("finger1-1.L")[1] - j("finger3-1.L")[1] + 0.02) ** 2 * 100
            loss = loss + 5 * (d(j("wrist.L"), j("finger3-1.L")) - torch.tensor([0.0, 0.0, -1.0])).pow(2).sum()
            return loss, 0.025
        # From the A-pose the solver can stall with the arms still out (male M did); also try
        # starting from a neighbouring size's solution and keep whichever matches the pose better.
        tries = [self.solve_arm(phen, objective, local)]
        if init is not None:
            tries.append(self.solve_arm(phen, objective, local, init=arm_params(init)))
        return min(tries, key=lambda t: t[1])[0]

    def hips_pose(self, phen, local=None, init=None):
        """Hands on hips: wrist resting on the side of the waist, elbow out and slightly back,
        the hand lying on the body surface (contact margin 6 mm) instead of sinking into it.
        `init` (the relaxed pose) starts the arm down at the side: from the A-pose, heavy bodies
        get stuck with the forearm blocked by the belly and the hand left out in the air."""
        rest = self.run(phen, local=local)
        rv0 = rest["vertices"][0].detach()
        waist = rv0[self.anthro.waist_vertex_indices]
        side = waist[waist[:, 0].argmax()]  # outermost waist point, left side (+x)
        wrist_target = side + torch.tensor([0.035, 0.0, 0.03])
        shoulder = self.joint(rest, "upperarm01.L").detach()
        # elbow out past the wrist so the forearm angles in to the waist, whatever the body width
        elbow_target = torch.tensor([max(shoulder[0] + 0.2, wrist_target[0] + 0.1), shoulder[1] + 0.06, shoulder[2] - 0.22])

        def objective(out, j, rv):
            loss = (j("wrist.L") - wrist_target).pow(2).sum() * 50 + (j("lowerarm01.L") - elbow_target).pow(2).sum() * 10
            # fingers wrap forward and down over the hip bone
            loss = loss + 2 * (self.direction(j("wrist.L"), j("finger3-1.L")) - torch.tensor([0.25, -0.55, -0.8])).pow(2).sum()
            return loss, 0.006
        return self.solve_arm(phen, objective, local, init=None if init is None else arm_params(init))[0]

    # Model stances for the legs (Anny axes: +x = body left, −y = forward, +z = up), as offsets from
    # each joint's rest position (m) and how far each foot turns out (degrees). The feet stay flat
    # (the sneakers are built flat on the floor); a bent knee lifts its foot at most ~1.5 cm, inside
    # the shoe.
    STANCES = {
        # contrapposto: weight on the right leg, the left knee softly bent forward and in, its foot
        # a little ahead and turned out
        "relaxed": {"L": {"knee": (-0.035, -0.11, 0.008), "ankle": (-0.03, -0.09, 0.014), "turn": 24},
                    "R": {"knee": (0.012, 0.0, 0.0), "ankle": (0.03, 0.0, 0.0), "turn": 8}},
        # hands on hips: feet wider, the left one stepped forward
        "hips": {"L": {"knee": (0.03, -0.1, 0.004), "ankle": (0.035, -0.16, 0.013), "turn": 22},
                 "R": {"knee": (-0.025, 0.012, 0.0), "ankle": (-0.04, 0.03, 0.008), "turn": 14}},
        # a catwalk pause, as the model_guides figures stand: the left foot a step ahead and in
        # towards the midline, its knee soft; weight on the straight right leg, which turns out a little
        "stride": {"L": {"knee": (-0.03, -0.13, 0.008), "ankle": (-0.07, -0.21, 0.014), "turn": 16},
                   "R": {"knee": (0.008, 0.02, 0.0), "ankle": (0.02, 0.04, 0.0), "turn": 12}},
    }

    def leg_pose(self, phen, local, stance, steps=250):
        """Gradient-descent IK for both legs (hip, knee, ankle axis-angles) to a stance: knee and
        ankle joints to their targets, the foot level and turned out by the stance's angle."""
        rest = self.run(phen, local=local)
        with torch.no_grad():
            j0 = {b: self.joint(rest, b).clone() for s in "LR" for b in (f"lowerleg01.{s}", f"foot.{s}", f"toe3-1.{s}")}
        bones = [f"{b}.{s}" for s in "LR" for b in ("upperleg01", "lowerleg01", "foot")]
        targets = {}
        for s, sign in (("L", 1), ("R", -1)):
            st = stance[s]
            targets[s] = {"knee": j0[f"lowerleg01.{s}"] + torch.tensor(st["knee"]),
                          "ankle": j0[f"foot.{s}"] + torch.tensor(st["ankle"])}
            # rest foot direction (heel joint → middle toe), yawed outwards about +z
            d = j0[f"toe3-1.{s}"] - j0[f"foot.{s}"]
            a = np.radians(st["turn"]) * sign
            targets[s]["foot"] = torch.tensor([d[0] * np.cos(a) - d[1] * np.sin(a), d[0] * np.sin(a) + d[1] * np.cos(a), d[2]]) / d.norm()
        params = torch.zeros(len(bones), 3, requires_grad=True)
        opt = torch.optim.Adam([params], lr=0.02)
        for _ in range(steps):
            out = self.run(phen, {b: axis_angle(params[i] + 1e-4) for i, b in enumerate(bones)}, local)
            loss = 0.002 * params.pow(2).sum()
            for s in "LR":
                t = targets[s]
                loss = loss + 400 * (self.joint(out, f"foot.{s}") - t["ankle"]).pow(2).sum()
                loss = loss + 100 * (self.joint(out, f"lowerleg01.{s}") - t["knee"]).pow(2).sum()
                loss = loss + 5 * (self.direction(self.joint(out, f"foot.{s}"), self.joint(out, f"toe3-1.{s}")) - t["foot"]).pow(2).sum()
            opt.zero_grad()
            loss.backward()
            opt.step()
        p = params.detach()
        return {b: axis_angle(p[i]) for i, b in enumerate(bones)}

    # --- mannequin head + measurements ---------------------------------------
    def mannequin_finish(self, v, bust=None):
        """Finished body: the abstract dome head if HEAD == "dome", and a smooth sculpted bust (depth,
        radius) for female bodies (the navel is flattened by local changes)."""
        if HEAD == "dome":
            v = self.mannequin_head(v)
        return self.sculpt_bust(v, *bust) if bust else v

    def fit_ribcage(self, phen, bust, target_cm):
        """Bisect Anny's `measure-bust-circ-incr` so the finished (sculpted) bust tapes at the chart value."""
        return self.fit_girth(phen, bust, "measure-bust-circ-incr", "bust", target_cm)

    def fit_hips(self, phen, bust, local, target_cm):
        """Bisect `measure-hips-circ-incr` (with the bust fit `local` kept) so the hips tape at the chart:
        the size fit balances bust, waist, hips and height and left the curvy female hips 6-8 cm over."""
        return self.fit_girth(phen, bust, "measure-hips-circ-incr", "hip", target_cm, local)

    def fit_girth(self, phen, bust, control, ring, target_cm, local=None):
        lo, hi = -1.0, 0.5
        for _ in range(10):
            mid = (lo + hi) / 2
            with torch.no_grad():
                raw = self.run(phen, local={**(local or {}), control: mid})["vertices"][0].numpy().astype(np.float64)
            girth = self.measure(self.to_three(self.sculpt_bust(raw, *bust) if bust else raw))[ring]
            lo, hi = (mid, hi) if girth < target_cm else (lo, mid)
        return {control: round((lo + hi) / 2, 3)}

    def sculpt_bust(self, p, depth, radius, region):
        """Replace Anny's breasts with a smooth display-mannequin bust, one side at a time.

        Frame: around the nipple take the disc of torso vertices within `region` (m); its least-variance
        direction (PCA) is the chest normal n, `up` is world-up projected off n.
        1. Chest: fit a quadratic height field z = q(x, y) over the disc's outer band (3 cm) by least
           squares: the smooth chest the breast sits on (connectivity-free, so Anny's dense, irregular
           nipple mesh leaves no kink).
        2. Breast: on top of it a height field h = depth·(1 − ρ²)^k, with ρ an elliptical radius
           (taller above the apex than below) and k easing from 0.55 below (a full, round lower pole
           and a crisp fold) to 1.85 above (a long gentle slope up to the collarbone).
        Inside the band, vertices are re-spaced in the tangent plane by a Tutte embedding (each
        vertex at the mean of its neighbours, band fixed): Anny's nipple cone would otherwise project
        onto overlapping positions and fold. Heights blend from Anny's (disc edge, and near the arm)
        to the new surface over the outer band."""
        p = p.copy()
        arm = p[self.arm_mask]
        for k in self.nipples:
            dist = np.linalg.norm(p - p[k], axis=1)
            idx = np.where(~self.arm_mask & (dist < region))[0]
            q = p[idx] - p[k]
            n = np.linalg.svd(q - q.mean(0), full_matrices=False)[2][2]
            n *= -np.sign(n[1])  # Anny faces −y
            up = np.array([0, 0, 1.0]) - n[2] * n
            up /= np.linalg.norm(up)
            side = np.cross(up, n)
            w = np.clip((region - dist[idx]) / 0.03, 0, 1)
            w = np.minimum(w, np.clip(scipy.spatial.cKDTree(arm).query(p[idx])[0] / 0.03 - 0.3, 0, 1))
            w = w * w * (3 - 2 * w)
            xy = (p - p[k]) @ np.stack([side, up], 1)
            free = idx[w == 1]
            if len(free):
                rest = np.setdiff1d(np.arange(self.vertex_count), free)
                M = (sp.eye(self.vertex_count, format="csr") - self.umbrella)[free]
                xy[free] = scipy.sparse.linalg.spsolve(M[:, free].tocsc(), -(M[:, rest] @ xy[rest]))
            x, y, z = xy[idx, 0], xy[idx, 1], q @ n
            basis = lambda x, y: np.stack([np.ones_like(x), x, y, x * x, x * y, y * y], 1)
            band = dist[idx] > region - 0.03
            coef = np.linalg.lstsq(basis(x[band], y[band]), z[band], rcond=None)[0]
            # breast centred a little above the nipple (base centre), radius taller above than below
            bx, by = x, y - 0.012
            rho2 = (bx / radius) ** 2 + (by / np.where(by > 0, radius * 1.35, radius * 0.95)) ** 2
            s = np.clip(by / (radius * 0.8) * 0.5 + 0.5, 0, 1)
            s = s * s * (3 - 2 * s)
            target = basis(x, y) @ coef + depth * np.maximum(0, 1 - rho2) ** (0.55 + 1.3 * s)
            p[idx] = p[k] + x[:, None] * side + y[:, None] * up + (z + w * (target - z))[:, None] * n
        return p

    def sphere_smooth(self, values, valid, dirs, sigma_deg):
        """Gaussian (von Mises) kernel average of values sampled on self.sphere, evaluated at dirs."""
        w = np.exp((dirs @ self.sphere[valid].T - 1) / np.radians(sigma_deg) ** 2)
        return (w @ values[valid]) / np.maximum(w.sum(1), 1e-12)

    def mannequin_head(self, v):
        """Place the dome on this body's own head outline with the features smoothed away.

        Outline: from a centre on the neck axis, the head's radial extent r(u) along each sphere
        direction u is the furthest neck/head vertex within 6° (vertices inside the skull, like the
        mouth and eyeballs, never win). Anything that stands out more than HEAD_CLIP from a broad
        spherical smoothing (nose, lips, ears, brows) is clipped back, then a finer smoothing gives
        the surface: skull, jaw and chin keep their real proportions, the face becomes blank.
        Ring i of the dome sits at polar angle θ = θ_neck·(1 − i/N) about the crown axis."""
        rings, crown = self.dome
        v = v.copy()
        c = v[rings[0]].mean(0)
        c[2] = v[self.head_weight > 0.5][:, 2].mean()  # head-centre height, on the neck axis
        d = v[self.above] - c
        r = np.linalg.norm(d, axis=1)
        cos = self.sphere @ (d / r[:, None]).T
        extent = np.where(cos > np.cos(np.radians(6)), r[None] * cos, -1).max(1)
        valid = extent > 0
        broad, fine = HEAD_SMOOTH
        extent = np.minimum(extent, self.sphere_smooth(extent, valid, self.sphere, broad) + HEAD_CLIP)
        d0 = v[rings[0]] - c
        r_neck = np.linalg.norm(d0, axis=1)
        up = np.array([0.0, 0.08, 1.0]) / np.linalg.norm([0.0, 0.08, 1.0])  # crown, tilted slightly back (Anny: z up, -y forward)
        e1 = np.cross(up, [1.0, 0, 0])
        e1 /= np.linalg.norm(e1)
        e2 = np.cross(up, e1)
        phi = np.arctan2(d0 @ e2, d0 @ e1)
        theta0 = np.arccos(np.clip((d0 @ up) / r_neck, -1, 1))
        for i, ring in enumerate(rings[1:], start=1):
            theta = theta0 * (1 - i / DOME_RINGS)
            u = np.sin(theta)[:, None] * (np.cos(phi)[:, None] * e1 + np.sin(phi)[:, None] * e2) + np.cos(theta)[:, None] * up
            s = min(i / 3, 1.0)  # ease off the exact neck loop over the first rings
            s = s * s * (3 - 2 * s)
            v[ring] = c + u * ((1 - s) * r_neck + s * self.sphere_smooth(extent, valid, u, fine))[:, None]
        v[crown] = c + up * self.sphere_smooth(extent, valid, up[None], fine)[0]
        # Iron the seam: Taubin smoothing (λ/μ, no shrinkage) over the upper neck and the dome's
        # lowest rings removes the jagged cut line and Anny's neck creases.
        axis = v[crown] - v[rings[0]].mean(0)
        axis /= np.linalg.norm(axis)
        rel = v - v[rings[0]].mean(0)
        seam = np.zeros(self.vertex_count, bool)
        seam[np.where((rel @ axis > -NECK_SEAM) & (rel @ axis < 0.02) & (np.linalg.norm(rel, axis=1) < 0.12))[0]] = True
        seam[np.concatenate(rings[1:7])] = True
        seam[self.above] &= np.isin(self.above, np.concatenate(rings))  # leftover head vertices are unused
        idx = np.where(seam)[0]
        for _ in range(30):
            for f in (0.5, -0.53):
                v[idx] += f * (self.umbrella[idx] @ v - v[idx])
        return v

    def girth(self, v, height):
        """Tape-measure girth: perimeter of the 2D convex hull of the body (arms excluded)
        in a thin horizontal slab, i.e. the tape bridges concavities like a real one."""
        # ±1 cm: Anny's mesh is sparse enough that a thinner slab can miss part of the body
        slab = v[(~self.arm_mask) & (np.abs(v[:, 1] - height) < 0.01)][:, [0, 2]]
        return scipy.spatial.ConvexHull(slab).area if len(slab) >= 3 else 0.0  # 2D "area" = perimeter

    def measure(self, v):
        height = float(v[:, 1].max())
        band = lambda lo, hi: [self.girth(v, height * t) for t in np.linspace(lo, hi, 13)]
        return {
            "height": round(height * 100, 1),
            "bust": round(max(band(0.70, 0.76)) * 100, 1),
            "waist": round(min(band(0.58, 0.64)) * 100, 1),
            "hip": round(max(band(0.47, 0.53)) * 100, 1),
        }

    @staticmethod
    def to_three(v, floor=None):
        v = np.stack([v[:, 0], v[:, 2], -v[:, 1]], axis=1)
        v[:, 1] -= v[:, 1].min() if floor is None else floor
        return v.astype(np.float32)

    def segment_labels(self):
        """Dominant body segment per vertex (uint8), used to cut garments out of the body surface."""
        w = np.stack([self.bone_weight([b for b in self.labels if any(b.startswith(p) for p in prefixes)])
                      for prefixes in SEGMENTS.values()], axis=1)
        return w.argmax(1).astype(np.uint8)

    def export_gender(self, name, chart, cache):
        variants, blobs = [], []
        rings = self.tape_rings(chart["gender"])
        female = chart["gender"] > 0.5
        prev_relaxed = None
        for size, targets in chart["sizes"].items():
            key = f"{name}-{size}"
            bust = BUST_SHAPE[size] if female else None
            if "poses" not in cache.get(key, {}) or "local" not in cache[key]:
                phen = cache[key]["phen"] if key in cache else self.fit_size(chart["gender"], chart["height"], targets, rings)
                local = self.fit_ribcage(phen, bust, targets["bust"]) if female else {}
                cache[key] = {"phen": phen, "local": local, "poses": {"apose": {}, "relaxed": self.relaxed_pose(phen, local)}}
            c = cache[key]
            if female and "measure-hips-circ-incr" not in c["local"]:
                c["local"] = {**c["local"], **self.fit_hips(c["phen"], bust, c["local"], targets["hip"])}
                c.pop("relaxed_from", None)  # the body changed: re-solve the poses
            if c.get("relaxed_from") != "best":
                c["poses"]["relaxed"] = self.relaxed_pose(c["phen"], c["local"], init=prev_relaxed)
                c["relaxed_from"] = "best"
                c.pop("hips_from", None)
            prev_relaxed = c["poses"]["relaxed"]
            if c.get("hips_from") != "relaxed":
                c["poses"]["hips"] = self.hips_pose(c["phen"], c["local"], init=c["poses"]["relaxed"])
                c["hips_from"] = "relaxed"
            # the step keeps the relaxed arms; only the legs differ
            c["poses"]["stride"] = c["poses"]["relaxed"]
            # a model's hand on hip: the right hand on the hip of the weight-bearing right leg, the left
            # arm relaxed (the arm solves are mirrored, so each side is taken from its own pose)
            c["poses"]["onehip"] = {**{b: m for b, m in c["poses"]["relaxed"].items() if b.endswith(".L")},
                                    **{b: m for b, m in c["poses"]["hips"].items() if b.endswith(".R")}}
            if c.get("legs_v") != LEGS_VERSION:
                c["legs"] = {name: self.leg_pose(c["phen"], c["local"], st) for name, st in self.STANCES.items()}
                c["legs_v"] = LEGS_VERSION
            phen, local, poses = cache[key]["phen"], cache[key]["local"], cache[key]["poses"]
            for pose_name in POSES:
                with torch.no_grad():
                    out = self.run(phen, {**poses[pose_name], **c["legs"].get(STANCE_OF.get(pose_name, pose_name), {}), **finger_pose(), **posture_pose()}, local)
                raw = out["vertices"][0].numpy().astype(np.float64)
                floor = float(raw[:, 2].min())  # feet on the ground in three.js space
                v = self.to_three(self.mannequin_finish(raw, bust), floor)
                joints = self.to_three(out["bone_poses"][0, [self.labels.index(j) for j in JOINTS], :3, 3]
                                       .detach().numpy(), floor)
                entry = {"size": size, "pose": pose_name, "offset": sum(b.nbytes for b in blobs),
                         "phenotype": {k: round(float(x), 4) for k, x in phen.items()},
                         "joints": {j: [round(float(c), 4) for c in p] for j, p in zip(JOINTS, joints)}}
                if local:
                    entry["localChanges"] = local
                if pose_name == "apose":
                    entry["measurements"] = self.measure(v)  # tape measure on the finished mannequin
                    entry["chart"] = targets
                variants.append(entry)
                blobs.append(v.ravel())
                print(f"{name} {size} {pose_name}", entry.get("measurements", ""), flush=True)
        index_offset = sum(b.nbytes for b in blobs)
        label_offset = index_offset + self.faces.nbytes
        blob = np.concatenate([b.view(np.uint8) for b in blobs]
                              + [self.faces.ravel().view(np.uint8), self.segment_labels()])
        (OUT / f"{name}.bin").write_bytes(blob.tobytes())
        return {"file": f"{name}.bin", "vertexCount": int(blobs[0].size // 3),
                "indexCount": int(self.faces.size), "indexOffset": index_offset,
                "labelOffset": label_offset, "segments": list(SEGMENTS), "variants": variants}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    ex = Exporter()
    # Fitted phenotypes + poses are cached so head/finish tweaks re-export in seconds; --refit redoes them.
    cache_file = Path(__file__).with_name(".fit-cache.pt")
    cache = torch.load(cache_file) if cache_file.exists() and "--refit" not in sys.argv else {}
    manifest = {"source": "Anny body model, NAVER LABS Europe, Apache-2.0",
                "units": "metres, y-up, +z forward",
                "genders": {name: ex.export_gender(name, chart, cache) for name, chart in SIZE_CHARTS.items()}}
    torch.save(cache, cache_file)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))


if __name__ == "__main__":
    main()
