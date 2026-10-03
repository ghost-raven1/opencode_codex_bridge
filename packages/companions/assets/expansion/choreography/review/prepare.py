"""Export REVIEW's authored choreography to measured, independently moving RGBA layers.

Run with the bundled Codex Python (Pillow and numpy). Source art is immutable;
only this role's choreography directory and its local QA directory are written.
"""
from pathlib import Path
from collections import deque
import json
import math
import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
EXPANSION = HERE.parents[1]
SOURCES = EXPANSION / "source" / "choreography-v1"
QA = HERE.parents[5] / ".local" / "choreography-qa" / "review"
SIZE = (256, 384)
FACE_FRAMES = [
    "close", "slightly-open", "A", "O", "E", "I", "U", "smile-speaking",
    "open", "quarter", "half", "three-quarter", "closed", "reopen",
    "smile", "concern", "focus", "surprise"
]


def canonical(image, cutoff=8):
    """Clear invisible RGB fringe without changing opaque painted anatomy."""
    pixels = np.array(image.convert("RGBA"))
    pixels[pixels[:, :, 3] < cutoff] = 0
    return Image.fromarray(pixels)


def mask(polygons):
    """Rasterize measured cut contours in the registered canvas coordinates."""
    result = Image.new("L", SIZE)
    draw = ImageDraw.Draw(result)
    for polygon in polygons:
        draw.polygon([tuple(point) for point in polygon], fill=255)
    return result


def source_component(image):
    """Keep one complete authored silhouette where source sheet cells overlap."""
    occupied = np.array(image)[:, :, 3] > 24
    height, width = occupied.shape
    seen = np.zeros(occupied.shape, dtype=bool)
    biggest = []
    for y, x in zip(*np.nonzero(occupied)):
        if seen[y, x]: continue
        queue = deque([(y, x)]); seen[y, x] = True; pixels = []
        while queue:
            cy, cx = queue.popleft(); pixels.append((cx, cy))
            for dy, dx in [(0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1)]:
                ny, nx = cy + dy, cx + dx
                if 0 <= nx < width and 0 <= ny < height and occupied[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True; queue.append((ny, nx))
        if len(pixels) > len(biggest): biggest = pixels
    region = Image.new("L", image.size); draw = ImageDraw.Draw(region)
    for point in biggest: draw.point(point, fill=255)
    # Two source pixels retain antialias and nearby loose hair tips.
    region = region.filter(ImageFilter.MaxFilter(5))
    image.putalpha(ImageChops.darker(image.getchannel("A"), region))
    return canonical(image)


def registered(spec):
    """Use one uniform scale for the entire authored pose; feet stay at 368."""
    original = canonical(Image.open(SOURCES / spec["source"]), 24)
    crop = original.crop(spec["sourceRect"])
    if spec.get("isolate"): crop = source_component(crop)
    bounds = crop.getchannel("A").getbbox()
    if bounds is None:
        raise ValueError("Empty source pose")
    scale = min(spec["scale"], 228 / (bounds[2] - bounds[0]))
    dx = 128 - (bounds[0] + bounds[2] - 1) * scale / 2
    dy = 368 - (bounds[3] - 1) * scale
    if bounds[1] * scale + dy < 14:
        raise ValueError("Measured pose leaves insufficient head motion margin")
    image = canonical(crop.transform(SIZE, Image.Transform.AFFINE,
        (1 / scale, 0, -dx / scale, 0, 1 / scale, -dy / scale),
        Image.Resampling.BICUBIC))
    return image, {
        "kind": "uniform", "source": "source/choreography-v1/" + spec["source"],
        "sourceRect": spec["sourceRect"], "coordinateSpace": "sourceRect",
        "scaleX": scale, "scaleY": scale, "offsetX": dx, "offsetY": dy,
        "sourceFeet": bounds[3] - 1, "targetFeet": 368,
        "measuredScale": spec["scale"]
    }


def joint_underlap(body, parts, opaque_only=False):
    """Extend existing joint edge pixels at most four pixels behind cut layers.

    This is restricted to opaque occluded joint pixels. It does not invent face
    features or repaint an exposed body area, and the source silhouette survives.
    """
    source = np.array(body)
    result = source.copy()
    for layer in parts:
        alpha = np.array(layer)[:, :, 3]
        allowed = alpha == 255 if opaque_only else alpha > 245
        for distance in range(1, 5):
            for sx, sy in [(0, distance), (0, -distance), (distance, 0), (-distance, 0)]:
                donor = np.roll(source, (sy, sx), axis=(0, 1))
                if sy > 0: donor[:sy] = 0
                elif sy < 0: donor[sy:] = 0
                if sx > 0: donor[:, :sx] = 0
                elif sx < 0: donor[:, sx:] = 0
                needed = (result[:, :, 3] < 245) & allowed & (donor[:, :, 3] >= 245)
                result[needed] = donor[needed]
    return canonical(Image.fromarray(result))


def transfer_cut_edges(image, remaining, exported):
    """Transfer detached cut-edge pixels to their neighboring moving layer.

    No painted pixels are discarded. A fragment must be smaller than 300 pixels,
    above the hips and within five pixels of an authored layer boundary.
    """
    occupied = np.array(remaining) > 24
    seen = np.zeros(occupied.shape, dtype=bool)
    component_masks = []
    for y, x in zip(*np.nonzero(occupied)):
        if seen[y, x]: continue
        queue = deque([(y, x)]); seen[y, x] = True; pixels = []
        while queue:
            cy, cx = queue.popleft(); pixels.append((cx, cy))
            for dy, dx in [(0, 1), (0, -1), (1, 0), (-1, 0)]:
                ny, nx = cy + dy, cx + dx
                if 0 <= nx < 256 and 0 <= ny < 384 and occupied[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True; queue.append((ny, nx))
        if len(pixels) > 300 or max(y for _, y in pixels) > 220: continue
        region = Image.new("L", SIZE)
        draw = ImageDraw.Draw(region)
        for point in pixels: draw.point(point, fill=255)
        component_masks.append(region)
    for region in component_masks:
        closest = None
        for distance in range(1, 6):
            for name, layer in exported.items():
                expanded = layer.getchannel("A").filter(ImageFilter.MaxFilter(distance * 2 + 1))
                if ImageChops.darker(expanded, region).getbbox():
                    closest = name; break
            if closest: break
        if not closest: continue
        selected = ImageChops.darker(remaining, region)
        addition = image.copy(); addition.putalpha(selected)
        exported[closest].alpha_composite(addition)
        remaining = ImageChops.subtract(remaining, selected)
    return remaining


def cut_layers(image, spec):
    """Separate foreground hands before props, then head; preserve source RGB."""
    remaining = image.getchannel("A")
    exported = {}
    parts = spec["parts"]
    order = [name for name in parts if name != "prop"] + (["prop"] if "prop" in parts else [])
    for name in order:
        selected = ImageChops.darker(remaining, mask(parts[name]["polygons"]))
        layer = image.copy()
        layer.putalpha(selected)
        exported[name] = canonical(layer)
        remaining = ImageChops.subtract(remaining, selected)
    selected = ImageChops.darker(remaining, mask([spec["head"]]))
    head = image.copy()
    head.putalpha(selected)
    exported["head"] = canonical(head)
    remaining = ImageChops.subtract(remaining, selected)
    preserve_rest = spec.get("preserveRestPixels", False)
    if not preserve_rest:
        remaining = transfer_cut_edges(image, remaining, exported)
    edge = spec.get("headLowerEdge")
    if edge:
        head_alpha = exported["head"].getchannel("A")
        above_edge = mask([[[0, 0], [256, 0]] + list(reversed(edge))])
        retained = ImageChops.darker(head_alpha, above_edge)
        remaining = ImageChops.add(remaining, ImageChops.subtract(head_alpha, retained))
        exported["head"].putalpha(retained)
        exported["head"] = canonical(exported["head"])
    fabric_points = spec.get("headBodyPixels", [])
    if fabric_points:
        fabric = Image.new("L", SIZE)
        draw = ImageDraw.Draw(fabric)
        for point in fabric_points:
            draw.point(tuple(point), fill=255)
        head_alpha = exported["head"].getchannel("A")
        moved = ImageChops.darker(head_alpha, fabric)
        remaining = ImageChops.add(remaining, moved)
        exported["head"].putalpha(ImageChops.subtract(head_alpha, moved))
        exported["head"] = canonical(exported["head"])
    body = image.copy()
    body.putalpha(remaining)
    moving = [exported["head"]] + [exported[name] for name in parts]
    exported["body"] = joint_underlap(body, moving, opaque_only=preserve_rest or bool(edge) or bool(fabric_points))
    if spec.get("hiddenHeadUnderlap"):
        # Measured collar pixels fill the moving neck seam under nearly opaque
        # source alpha. The immutable fixture permits only this small RGBA delta.
        pixels = np.array(exported["body"])
        donors = pixels.copy()
        head_alpha = np.array(exported["head"])[:, :, 3]
        for patch in spec["hiddenHeadUnderlap"]:
            x, y = patch["point"]
            sx, sy = patch["donor"]
            if head_alpha[y, x] < 245 or pixels[y, x, 3] != 0 or donors[sy, sx, 3] < 245:
                raise ValueError("Measured neck underlap is no longer hidden behind the head")
            pixels[y, x] = donors[sy, sx]
        exported["body"] = canonical(Image.fromarray(pixels))
    return exported


def compose(layers, definitions, angles=False):
    """Build a preview from runtime layers, optionally at their motion limits."""
    image = Image.new("RGBA", SIZE)
    for layer in definitions:
        art = layers[layer["id"]]
        if angles and layer["motion"] in ["arm", "head"]:
            art = art.rotate(layer["amplitudeDegrees"] * angles, Image.Resampling.BICUBIC,
                             center=tuple(layer["pivot"]))
        image.alpha_composite(art)
    return canonical(image)


def export(name, spec):
    image, registration = registered(spec)
    layers = cut_layers(image, spec)
    directory = HERE / name
    directory.mkdir(parents=True, exist_ok=True)
    prefix = "choreography/review/" + name
    definitions = [{
        "id": "body", "file": prefix + "/body.png", "parent": None,
        "pivot": [128, 368], "motion": "body", "amplitudeDegrees": 0
    }]
    # Props remain under their authored fingers; the face retains actual view art.
    order = (["prop"] if "prop" in spec["parts"] else []) + [
        part for part in spec["parts"] if part != "prop"
    ] + ["head"]
    for part in order:
        item = spec["parts"].get(part, {})
        definitions.append({
            "id": part, "file": prefix + "/" + part + ".png", "parent": "body",
            "pivot": spec["neck"] if part == "head" else item["pivot"],
            "motion": "head" if part == "head" else item.get("motion", "arm"),
            "amplitudeDegrees": 0.8 if part == "head" else item["amplitude"]
        })
    for part, art in layers.items():
        if np.count_nonzero(np.array(art)[:, :, 3]) <= 20:
            raise ValueError(f"{name}/{part}: empty or nearly empty cut layer")
        canonical(art).save(directory / (part + ".png"), optimize=True)
    unused_prop = directory / "prop.png"
    if "prop" not in layers and unused_prop.exists():
        unused_prop.unlink()
    definition = {
        "name": "REVIEW " + name, "roleHint": "review", "registration": registration,
        "neutralOnly": True, "layers": definitions,
        "face": {"file": "choreography/review/facial.png", "frameHeight": 384,
                 "frames": FACE_FRAMES},
        "motion": {"breathSeconds": 4.6, "gestureSeconds": 4.0,
                   "gestureIntervalSeconds": [8, 15]}
    }
    composite = compose(layers, definitions)
    max_pose = compose(layers, definitions, True)
    min_pose = compose(layers, definitions, -1)
    bounds = composite.getchannel("A").getbbox()
    if bounds[0] < 8 or bounds[2] > 248 or bounds[1] < 14 or bounds[3] > 370:
        raise ValueError(f"{name}: insufficient silhouette margin {bounds}")
    QA.mkdir(parents=True, exist_ok=True)
    canonical(image).save(QA / (name + "-registered.png"))
    composite.save(QA / (name + "-composed.png"))
    max_pose.save(QA / (name + "-max-motion.png"))
    min_pose.save(QA / (name + "-min-motion.png"))
    diff = np.abs(np.array(composite).astype(int) - np.array(image).astype(int))
    report = {"name": name, "source": spec["source"], "bounds": bounds,
              "layers": len(layers), "maxRestPixelDifference": int(diff.max()),
              "meanRestPixelDifference": round(float(diff.mean()), 5)}
    return definition, report, composite


def main():
    spec = json.loads((HERE / "spec.json").read_text())
    Image.new("RGBA", (256, 384 * 18)).save(HERE / "facial.png", optimize=True)
    manifest = {"version": 1, "canvas": {"width": 256, "height": 384},
                "coordinates": "top-left", "feetBaseline": 368, "characters": {}}
    report, composites = [], []
    for name, pose in spec["poses"].items():
        definition, check, composite = export(name, pose)
        manifest["characters"]["review/" + name] = definition
        report.append(check)
        composites.append((name, composite))
    manifest["runtimeFiles"] = list(dict.fromkeys(
        [layer["file"] for definition in manifest["characters"].values()
         for layer in definition["layers"]] + ["choreography/review/facial.png"]))
    (HERE / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    (QA / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    for theme, color in [("light", "#f7f3ed"), ("dark", "#17202f")]:
        contact = Image.new("RGB", (256 * 4, 410 * math.ceil(len(composites) / 4)), color)
        draw = ImageDraw.Draw(contact)
        for i, (name, image) in enumerate(composites):
            canvas = Image.new("RGBA", SIZE, color)
            canvas.alpha_composite(image)
            x, y = (i % 4) * 256, (i // 4) * 410
            contact.paste(canvas.convert("RGB"), (x, y + 24))
            draw.text((x + 4, y + 4), name, fill="#17202f" if theme == "light" else "white")
        contact.save(QA / ("contact-" + theme + ".png"))
    print(json.dumps({"characters": len(composites), "runtimeFiles": len(manifest["runtimeFiles"]),
                      "qa": str(QA)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
