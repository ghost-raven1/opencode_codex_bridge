#!/usr/bin/env python3
"""Register pose size/ground without changing source PNGs or bending a seated silhouette upright."""
import json
from pathlib import Path
from PIL import Image, ImageChops

ASSETS = Path(__file__).resolve().parents[1] / "packages/companions/assets/expansion"
UPRIGHT = {"work-three-quarter", "work-profile", "work-back-three-quarter", "work-back",
           "work-right-three-quarter", "work-right-profile", "walk-left", "walk-right"}


def geometry(character):
    """Ignore transparent feather pixels and held props when measuring the body's ground."""
    alpha = Image.new("L", (256, 384))
    for layer in character["layers"]:
        if layer["motion"] == "prop":
            continue
        part = Image.open(ASSETS / layer["file"]).getchannel("A").point(lambda value: 255 if value > 160 else 0)
        alpha = ImageChops.lighter(alpha, part)
    head = next(layer for layer in character["layers"] if layer["id"] == "head")
    face = Image.open(ASSETS / head["file"]).getchannel("A").point(lambda value: 255 if value > 160 else 0).getbbox()
    bounds = alpha.getbbox()
    assert bounds and face and face[3] > face[1]
    return {"feet": bounds[3], "height": bounds[3] - face[1], "head": face[3] - face[1],
            "neck": head["pivot"][1], "crown": face[1]}


def main():
    manifests = {name: json.loads((ASSETS / name).read_text()) for name in ("manifest.json", "poses.json", "choreography.json")}
    references = {role: geometry(character) for role, character in manifests["manifest.json"]["characters"].items()}
    count = 0
    for name, manifest in manifests.items():
        for key, character in manifest["characters"].items():
            role, _, pose = key.partition("/")
            measured, reference = geometry(character), references[role]
            # Straight work views share stature; bent/sitting/dance poses share portrait size, not a bounding-box height.
            head_scale = reference["head"] / measured["head"]
            body_span = measured["feet"] - measured["neck"]
            crown_span = (measured["neck"] - measured["crown"]) * head_scale
            standing_scale = (reference["height"] - crown_span) / body_span
            # Keep the same portrait and anatomical stature; a bent pose may be lower, never a larger person.
            scale = standing_scale if pose in UPRIGHT else min(head_scale, standing_scale) if pose else 1.0
            assert 0.5 <= scale <= 2, (key, scale)
            assert 0.5 <= head_scale / scale <= 2, (key, head_scale / scale)
            character["renderScale"] = round(scale, 6)
            character["renderHeadScale"] = round(head_scale / scale, 6)
            character["renderFeet"] = measured["feet"]
            count += 1
        (ASSETS / name).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    print(f"Registered {count} poses: shared stature/portrait size and planted ground; source PNGs unchanged")


if __name__ == "__main__":
    main()
