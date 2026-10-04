#!/usr/bin/env python3
"""Export bone/skin metadata from existing cutouts. Read PNGs; never change artwork."""
import hashlib
import json
from pathlib import Path
from PIL import Image

ASSETS = Path(__file__).resolve().parents[1] / "packages/companions/assets/expansion"
UPRIGHT = {"work-three-quarter", "work-profile", "work-back-three-quarter", "work-right-three-quarter",
           "work-right-profile", "work-back", "walk-left", "walk-right", "dance-1", "dance-2", "dance-3", "dance-4"}
# Hip, knee, ankle landmarks measured on each standing outfit, in source pixels.
STANDING = {
    "lead": (((108, 176), (99, 268), (94, 334)), ((128, 176), (146, 272), (173, 338))),
    "code": (((122, 187), (114, 265), (102, 330)), ((144, 188), (157, 263), (182, 331))),
    "research": (((109, 200), (97, 278), (85, 331)), ((135, 205), (142, 277), (141, 332))),
    "review": (((113, 181), (115, 261), (108, 331)), ((139, 181), (153, 269), (174, 332))),
    "designer": (((119, 192), (115, 277), (90, 342)), ((141, 194), (150, 280), (153, 345))),
    "devops": (((112, 178), (101, 264), (83, 337)), ((137, 178), (157, 266), (174, 337))),
    "tester": (((107, 180), (105, 265), (94, 334)), ((130, 180), (149, 268), (167, 334))),
}

# Lifted/crossed legs cannot be recovered by splitting the bottom silhouette in half.
POSE_LEGS = {
    "research/dance-3": (((116, 209), (144, 251), (80, 268)), ((135, 213), (130, 284), (115, 337))),
    "tester/dance-4": (((142, 190), (163, 240), (88, 233)), ((157, 189), (161, 281), (167, 335))),
}


def silhouette_landmarks(image, neck):
    """Each authored upright pose gets its own leg landmarks, including the lifted walking shoe."""
    alpha = image.getchannel("A")
    center = neck[0]
    sides = []
    for lo, hi in ((0, int(center)), (int(center), 256)):
        points = [(x, y) for y in range(int(neck[1] + (368 - neck[1]) * .65), 384)
                  for x in range(lo, hi) if alpha.getpixel((x, y)) > 160]
        assert points, "Upright pose has no leg silhouette"
        sole = max(y for _, y in points)
        shoe = [x for x, y in points if y >= sole - 18]
        sides.append((sum(shoe) / len(shoe), sole - 26))
    hip_y = neck[1] + (min(a[1] for a in sides) - neck[1]) * .39
    legs = []
    for index, ankle in enumerate(sides):
        hip = (center + (-12 if index == 0 else 12), hip_y)
        knee_y = hip_y + (ankle[1] - hip_y) * .55
        lo, hi = (0, int(center)) if index == 0 else (int(center), 256)
        xs = [x for y in range(int(knee_y) - 2, int(knee_y) + 3) for x in range(lo, hi)
              if alpha.getpixel((x, y)) > 160]
        knee_x = sum(xs) / len(xs) if xs else (hip[0] + ankle[0]) / 2
        legs.append((hip, (knee_x, knee_y), ankle))
    return legs


def definition(key, value):
    layers = value["layers"]
    head = next(layer for layer in layers if layer["id"] == "head")
    neck = head["pivot"]
    body = next(layer for layer in layers if layer["id"] == "body")
    image = Image.open(ASSETS / body["file"]).convert("RGBA")
    legs = STANDING[key] if key in STANDING else POSE_LEGS[key] if key in POSE_LEGS else silhouette_landmarks(image, neck)
    pelvis = tuple(sum(leg[0][i] for leg in legs) / 2 for i in (0, 1))
    chest = (neck[0], neck[1] + 22)
    spine = ((chest[0] + pelvis[0]) / 2, (chest[1] + pelvis[1]) / 2)
    bones, skins = [], []

    def bone(name, parent, point, limit):
        assert all(0 <= c <= edge for c, edge in zip(point, (256, 384))), (key, name, point)
        bones.append({"id": name, "parent": parent, "origin": [round(c, 3) for c in point], "limit": limit})

    bone("pelvis", None, pelvis, 6)
    bone("spine", "pelvis", spine, 4)
    bone("chest", "spine", chest, 4)
    bone("neck", "chest", neck, 3)
    bone("head", "neck", neck, head["amplitudeDegrees"])
    arms = [layer for layer in layers if layer["motion"] == "arm"]
    arm_ids = {}
    for index, side in enumerate(("left", "right")):
        # The coupled controller layer supplies both hands; split its actual silhouette around the neck.
        candidates = [layer for layer in arms if ("left" if side == "left" else "right") in layer["id"]]
        layer = candidates[0] if candidates else arms[min(index, len(arms) - 1)]
        wrist = layer["pivot"]
        if len(arms) == 1:
            alpha = Image.open(ASSETS / layer["file"]).getchannel("A")
            xs = range(0, int(neck[0])) if side == "left" else range(int(neck[0]), 256)
            points = [(x, y) for y in range(384) for x in xs if alpha.getpixel((x, y)) > 128]
            if points: wrist = tuple(sum(p[i] for p in points) / len(points) for i in (0, 1))
        sign = -1 if wrist[0] < neck[0] else 1
        shoulder = (chest[0] + sign * 23, chest[1] - 4)
        elbow = ((shoulder[0] + wrist[0]) / 2 + sign * 4, (shoulder[1] + wrist[1]) / 2)
        bone(f"upper-arm-{side}", "chest", shoulder, 8)
        bone(f"forearm-{side}", f"upper-arm-{side}", elbow, 12)
        bone(f"hand-{side}", f"forearm-{side}", wrist, 8)
        arm_ids.setdefault(layer["id"], []).append([f"upper-arm-{side}", f"forearm-{side}", f"hand-{side}"])
    for side, chain in zip(("left", "right"), legs):
        bone(f"thigh-{side}", "pelvis", chain[0], 30)
        bone(f"shin-{side}", f"thigh-{side}", chain[1], 40)
        bone(f"foot-{side}", f"shin-{side}", chain[2], 40)
    body_chains = [["pelvis", "spine", "chest", "neck"],
                   ["upper-arm-left", "forearm-left", "hand-left"], ["upper-arm-right", "forearm-right", "hand-right"],
                   ["thigh-left", "shin-left", "foot-left"], ["thigh-right", "shin-right", "foot-right"]]
    for layer in layers:
        if layer["id"] in arm_ids: chains = arm_ids[layer["id"]]
        elif layer["motion"] == "head" or layer.get("parent") == "head": chains = [["head"]]
        elif layer["motion"] == "prop":
            wrists = [b for b in bones if b["id"].startswith("hand-")]
            hand = min(wrists, key=lambda b: sum((a - c) ** 2 for a, c in zip(b["origin"], layer["pivot"])))
            bone(layer["id"], hand["id"], layer["pivot"], max(1, layer["amplitudeDegrees"]))
            chains = [[layer["id"]]]
        else: chains = body_chains
        skins.append({"layer": layer["id"], "chains": chains})
    return {"bones": bones, "skins": skins}


def main():
    characters, inputs = {}, {}
    for name in ("manifest.json", "choreography.json"):
        manifest = json.loads((ASSETS / name).read_text())
        for key, value in manifest["characters"].items():
            if key not in STANDING and key.split("/")[-1] not in UPRIGHT: continue
            for layer in value["layers"]:
                inputs[layer["file"]] = hashlib.sha256((ASSETS / layer["file"]).read_bytes()).hexdigest()
            characters[key] = definition(key, value)
    for file, expected in inputs.items():
        assert hashlib.sha256((ASSETS / file).read_bytes()).hexdigest() == expected, "Skeleton export modified artwork"
    data = {"version": 1, "canvas": {"width": 256, "height": 384}, "coordinates": "top-left",
            "characters": characters}
    (ASSETS / "skeletons.json").write_text(json.dumps(data, indent=2) + "\n")
    print(f"Prepared {len(characters)} full skeletons; {len(inputs)} original PNGs unchanged")


if __name__ == "__main__": main()
