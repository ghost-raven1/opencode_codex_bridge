#!/usr/bin/env python3
"""Register ImageGen clothing repairs; preserve original pixels outside removed head regions."""
from pathlib import Path
import hashlib
import json

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "packages/companions/assets"
SOURCE = ASSETS / "source/layered-bodies"
CELL = (256, 384)
ROLES = ["lead", "code", "research", "review"]
STATES = ["idle", "talking", "blink", "working"]
# Measured top of the neck and soles in the unmodified ImageGen repair atlas.
ANCHORS = [
    [(130, 65, 334), (384, 68, 336), (639, 70, 334), (896, 68, 334)],
    [(130, 420, 686), (384, 422, 689), (639, 416, 687), (896, 421, 686)],
    [(131, 772, 1038), (384, 775, 1038), (639, 773, 1039), (896, 775, 1038)],
    [(131, 1128, 1396), (384, 1127, 1397), (639, 1123, 1395), (896, 1127, 1396)],
]


def cell(image, column, row):
    return image.crop((column * 256, row * 384, (column + 1) * 256, (row + 1) * 384))


def polygon(points):
    mask = Image.new("L", CELL)
    ImageDraw.Draw(mask).polygon(points, fill=255)
    return mask


def head_region(column, row):
    """Trace hair and skin; collars belong to the outfit, headphones to the head."""
    if column == 0:
        return polygon([(0, 0), (256, 0), (256, 99), (148, 99), (141, 98),
                        (134, 101), (127, 103), (117, 99), (109, 103), (0, 103)])
    if column == 2:
        if row == 3:
            return polygon([(0, 0), (256, 0), (256, 100), (177, 98), (181, 114),
                            (174, 124), (158, 117), (143, 111), (140, 104),
                            (131, 105), (121, 103), (116, 101), (111, 112), (0, 112)])
        return polygon([(0, 0), (256, 0), (256, 113), (145, 113), (140, 104),
                        (131, 105), (121, 103), (116, 101), (115, 112), (0, 112)])
    if column == 3:
        return polygon([(0, 0), (256, 0), (256, 100), (146, 100), (137, 105),
                        (124, 104), (117, 99), (114, 109), (113, 116), (0, 116)])
    if row != 3:
        return Image.new("L", CELL, 255)
    # Working CODE's old head polygon swallowed the upper sleeve. Follow the
    # visible hair/hoodie boundary instead; restore the real sleeve to the body.
    main = polygon([(0, 0), (256, 0), (256, 93), (164, 93), (156, 99),
                    (150, 113), (133, 116), (113, 114), (103, 110), (99, 101),
                    (91, 100), (88, 98), (74, 95), (0, 95)])
    tail = polygon([(164, 85), (256, 85), (256, 256), (183, 233), (175, 213),
                    (185, 207), (179, 195), (186, 183), (189, 170), (183, 151),
                    (179, 134), (177, 119), (174, 111), (164, 101)])
    return ImageChops.lighter(main, tail)


def extract_background(image):
    """Remove the neutral checkerboard without changing warm cloth/skin colors."""
    image = image.convert("RGBA")
    width, height = image.size
    pixels = image.load()
    alpha = Image.new("L", image.size, 255)
    mask = alpha.load()
    for y in range(height):
        for x in range(width):
            red, green, blue, _ = pixels[x, y]
            if min(red, green, blue) > 175 and max(red, green, blue) - min(red, green, blue) < 10:
                mask[x, y] = 0
    image.putalpha(alpha)
    return image


def register(image, anchor):
    neck_x, neck_y, foot_y = anchor
    scale_y = (368 - 98) / (foot_y - neck_y)
    result = image.transform(CELL, Image.Transform.AFFINE,
                             (1, 0, neck_x - 128, 0, 1 / scale_y, neck_y - 98 / scale_y),
                             resample=Image.Resampling.NEAREST)
    a = result.getchannel("A")
    crop = Image.new("L", CELL)
    ImageDraw.Draw(crop).rectangle((35, 96, 221, 369), fill=255)
    result.putalpha(ImageChops.darker(a, crop))
    return result


def canonical(image):
    image.putdata([pixel if pixel[3] else (0, 0, 0, 0) for pixel in image.getdata()])
    return image


def previews(heads, bodies, prefix):
    """All sixteen pairings in each state, on both light and dark backgrounds."""
    for row, state in enumerate(STATES):
        for background, color in [("light", "#eeeeee"), ("dark", "#17202f")]:
            preview = Image.new("RGBA", (1024, 1536), color)
            for hi in range(4):
                for bi in range(4):
                    target = (bi * 256, hi * 384)
                    preview.alpha_composite(cell(bodies, bi, row), target)
                    preview.alpha_composite(cell(heads, hi, row), target)
            preview.convert("RGB").save(SOURCE / f"{prefix}-{state}-{background}.png")


def main():
    team = Image.open(ASSETS / "team-atlas.png").convert("RGBA")
    old_heads = Image.open(ASSETS / "head-atlas.png").convert("RGBA")
    old_bodies = Image.open(ASSETS / "body-atlas.png").convert("RGBA")
    repair = extract_background(Image.open(SOURCE / "generated.png"))
    heads = Image.new("RGBA", team.size)
    bodies = Image.new("RGBA", team.size)
    repaired = []
    for row, state in enumerate(STATES):
        for column, role in enumerate(ROLES):
            original = cell(team, column, row)
            head = original.copy() if column == 2 and row == 3 else cell(old_heads, column, row)
            head.putalpha(ImageChops.darker(head.getchannel("A"), head_region(column, row)))
            body = original.copy()
            body.putalpha(ImageChops.subtract(original.getchannel("A"), head.getchannel("A")))
            patch = register(repair, ANCHORS[row][column])
            # New clothing is visible only inside the area removed with the head.
            # Existing hands, props, legs, sleeve pixels and torso remain untouched.
            patch_mask = ImageChops.darker(head.getchannel("A"), patch.getchannel("A"))
            patch.putalpha(patch_mask)
            body.alpha_composite(patch)
            # Enforce the surgical edit boundary: no replaced pixel outside the
            # removed head, and all original artwork below the repairs retained.
            for source_pixel, body_pixel, head_alpha in zip(original.getdata(), body.getdata(), head.getchannel("A").getdata()):
                if head_alpha == 0 and source_pixel[3]:
                    assert source_pixel == body_pixel, (role, state, "changed intact outfit")
            assert body.crop((0, 260, 256, 384)).tobytes() == original.crop((0, 260, 256, 384)).tobytes()
            heads.paste(canonical(head), (column * 256, row * 384))
            bodies.paste(canonical(body), (column * 256, row * 384))
            repaired.append({"role": role, "state": state,
                             "patchPixels": sum(value > 0 for value in patch_mask.getdata())})
    heads.save(ASSETS / "mixed-head-atlas.png", optimize=True)
    bodies.save(ASSETS / "mixed-body-atlas.png", optimize=True)
    previews(old_heads, old_bodies, "before")
    previews(heads, bodies, "after")
    (SOURCE / "registration.json").write_text(json.dumps({
        "cell": {"width": 256, "height": 384}, "columns": ROLES, "rows": STATES,
        "source": "generated.png", "anchors": ANCHORS, "repairs": repaired,
        "inputs": {name: hashlib.sha256((ASSETS / name).read_bytes()).hexdigest()
                   for name in ["team-atlas.png", "head-atlas.png", "body-atlas.png"]},
        "output": {name: hashlib.sha256((ASSETS / name).read_bytes()).hexdigest()
                   for name in ["mixed-head-atlas.png", "mixed-body-atlas.png"]},
    }, indent=2) + "\n")
    print("Prepared mixed head/body atlases; 16 pairings × 4 states × 2 backgrounds saved for review.")


if __name__ == "__main__":
    main()
