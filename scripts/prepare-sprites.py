#!/usr/bin/env python3
"""Remove the generated checkerboard and register existing art; never synthesize new art."""
from __future__ import annotations

import json
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "packages/companions/assets"
CELL = (256, 384)
NECK = (128, 120)
FOOT = 368
ROLES = ["lead", "code", "research", "review"]
STATES = ["idle", "talking", "blink", "working"]
# Measured anchors in the unmodified generated source: neck x/y, head top, soles.
ANCHORS = [
    [(174, 149, 65, 350), (489, 157, 63, 350), (777, 147, 66, 350), (1090, 147, 65, 350)],
    [(173, 456, 374, 660), (489, 465, 371, 661), (777, 457, 374, 660), (1090, 456, 375, 661)],
    [(173, 768, 685, 974), (489, 776, 681, 974), (777, 769, 686, 974), (1090, 768, 686, 974)],
    [(172, 1079, 997, 1248), (486, 1084, 991, 1248), (775, 1080, 996, 1248), (1090, 1082, 997, 1248)],
]
# The lower edge follows existing collar/hair seams. Upper canvas is transparent.
HEAD_POLYGONS = [
    [(90, 40), (260, 40), (260, 139), (205, 139), (193, 141), (186, 144),
     (181, 151), (171, 154), (160, 149), (158, 143), (135, 149), (90, 146)],
    [(390, 40), (570, 40), (570, 133), (522, 133), (518, 140), (516, 148),
     (511, 155), (500, 160), (488, 160), (480, 155), (469, 151), (462, 147),
     (458, 142), (447, 141), (440, 145), (443, 151), (437, 158), (432, 169),
     (427, 178), (424, 184), (425, 188), (418, 201), (420, 207), (390, 207)],
    [(701, 45), (853, 45), (853, 108), (825, 108), (806, 110), (800, 117),
     (800, 124), (803, 132), (810, 138), (814, 144), (788, 145),
     (778, 147), (769, 149), (758, 143),
     (745, 144), (719, 143), (701, 133)],
    [(1001, 40), (1165, 40), (1165, 132), (1124, 132), (1113, 136),
     (1107, 143), (1101, 149), (1086, 151), (1076, 144), (1074, 139),
     (1061, 147), (1034, 145), (1001, 135)],
]
WORK_CODE_HEAD = [
    (425, 980), (565, 980), (565, 1160), (530, 1160), (522, 1147),
    (518, 1135), (515, 1121), (510, 1113), (506, 1107), (508, 1093),
    (502, 1080), (499, 1077), (494, 1083), (485, 1087), (474, 1085),
    (464, 1080), (456, 1074), (425, 1073),
]


def flood_from_edges(candidate: np.ndarray) -> np.ndarray:
    """Preserve neutral clothing enclosed by the character's dark outline."""
    height, width = candidate.shape
    seen = np.zeros_like(candidate)
    queue: deque[tuple[int, int]] = deque()
    for y, x in ([(y, x) for y in range(height) for x in (0, width - 1)]
                 + [(y, x) for x in range(width) for y in (0, height - 1)]):
        if candidate[y, x] and not seen[y, x]:
            seen[y, x] = True
            queue.append((y, x))
    while queue:
        y, x = queue.popleft()
        for yy, xx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= yy < height and 0 <= xx < width and candidate[yy, xx] and not seen[yy, xx]:
                seen[yy, xx] = True
                queue.append((yy, xx))
    return seen


def remove_checkerboard(source: Image.Image) -> Image.Image:
    """Matte the measured blue-neutral background; retain skin and warm white fabric."""
    rgb = np.asarray(source).astype(np.int16)
    red, green, blue = (rgb[:, :, channel] for channel in range(3))
    neutral = ((red > 60) & (blue - red >= -3) & (blue - red < 23)
               & (green - red >= -5) & (green - red < 16))
    background = flood_from_edges(neutral)
    # Openings enclosed by ponytail strands contain the same checkerboard colors.
    openings = ((red > 92) & (red < 225) & (blue - red >= 0) & (blue - red < 15)
                & (green - red >= -1) & (green - red < 12))
    alpha = np.where(background | openings, 0, 255).astype(np.uint8)
    result = source.convert("RGBA")
    result.putalpha(Image.fromarray(alpha))
    return result


def register(source: Image.Image, anchor: tuple[int, int, int, int]) -> Image.Image:
    """Align neck and soles, keeping a stable horizontal scale across animation frames."""
    neck_x, neck_y, top, soles = anchor
    result = Image.new("RGBA", CELL)
    scale_x = 1.2
    for start, end, scale_y in ((0, NECK[1], (NECK[1] - 24) / (neck_y - top)),
                                (NECK[1], CELL[1], (FOOT - NECK[1]) / (soles - neck_y))):
        transform = (1 / scale_x, 0, neck_x - NECK[0] / scale_x,
                     0, 1 / scale_y, neck_y + (start - NECK[1]) / scale_y)
        band = source.transform((CELL[0], end - start), Image.Transform.AFFINE,
                                transform, resample=Image.Resampling.NEAREST)
        result.paste(band, (0, start))
    return result


def remove_speckles(alpha: np.ndarray) -> np.ndarray:
    """Discard detached matting artifacts, retaining all intentional connected artwork."""
    height, width = alpha.shape
    seen = np.zeros(alpha.shape, dtype=bool)
    result = alpha.copy()
    for y in range(height):
        for x in range(width):
            if not alpha[y, x] or seen[y, x]:
                continue
            queue = deque([(y, x)])
            seen[y, x] = True
            component = []
            while queue:
                yy, xx = queue.popleft()
                component.append((yy, xx))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = yy + dy, xx + dx
                        if 0 <= ny < height and 0 <= nx < width and alpha[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            queue.append((ny, nx))
            if len(component) < 8:
                for yy, xx in component:
                    result[yy, xx] = 0
    return result


def main() -> None:
    source = Image.open(ASSETS / "source/team-generated-rgb.png").convert("RGB")
    extracted = remove_checkerboard(source)
    atlases = {name: Image.new("RGBA", (CELL[0] * 4, CELL[1] * 4))
               for name in ("team", "head", "body")}
    frames = []
    for row, state in enumerate(STATES):
        for column, role in enumerate(ROLES):
            anchor = ANCHORS[row][column]
            base_anchor = ANCHORS[0][column]
            delta_x, delta_y = anchor[0] - base_anchor[0], anchor[1] - base_anchor[1]
            polygon = [(x + delta_x, y + delta_y) for x, y in HEAD_POLYGONS[column]]
            if row == 3 and column == 1:
                polygon = WORK_CODE_HEAD
            head_mask = Image.new("L", source.size)
            ImageDraw.Draw(head_mask).polygon(polygon, fill=255)
            original_alpha = np.asarray(extracted.getchannel("A"))
            mask = np.asarray(head_mask) > 0
            head = extracted.copy()
            head.putalpha(Image.fromarray(np.where(mask, original_alpha, 0).astype(np.uint8)))
            body = extracted.copy()
            body.putalpha(Image.fromarray(np.where(mask, 0, original_alpha).astype(np.uint8)))
            parts = {"team": register(extracted, anchor), "head": register(head, anchor),
                     "body": register(body, anchor)}
            # The source has nearby rows; clip each cell to its own measured sprite.
            for part in parts.values():
                a = np.asarray(part.getchannel("A")).copy()
                a[:20, :] = 0
                a[FOOT + 1:, :] = 0
                part.putalpha(Image.fromarray(a))
            clean_alpha = remove_speckles(np.asarray(parts["team"].getchannel("A")))
            for part in parts.values():
                part.putalpha(Image.fromarray(np.minimum(np.asarray(part.getchannel("A")), clean_alpha)))
            reconstructed = Image.alpha_composite(parts["body"], parts["head"])
            assert np.array_equal(np.asarray(reconstructed), np.asarray(parts["team"])), (role, state)
            for name, part in parts.items():
                atlases[name].paste(part, (column * CELL[0], row * CELL[1]))
            bbox = parts["team"].getbbox()
            assert bbox and bbox[0] > 2 and bbox[2] < CELL[0] - 2, (role, state, bbox)
            frames.append({"role": role, "state": state, "column": column, "row": row,
                           "bounds": list(bbox), "sourceAnchor": list(anchor)})
    for name, atlas in atlases.items():
        # Canonical zero RGB in transparent pixels makes diffs and consumers predictable.
        pixels = np.asarray(atlas).copy()
        pixels[pixels[:, :, 3] == 0] = 0
        Image.fromarray(pixels).save(ASSETS / f"{name}-atlas.png", optimize=True)
    manifest = {
        "version": 1, "columns": ROLES, "rows": STATES, "cell": {"width": 256, "height": 384},
        "coordinates": "pixels, origin top-left", "neckAnchor": {"x": 128, "y": 120},
        "feetBaseline": FOOT, "headSplitRatio": 120 / 384,
        "atlases": {name: f"{name}-atlas.png" for name in atlases},
        "compositeOrder": ["body", "head"],
        "appearance": {"headColumn": "hair, face and integrated face accessories",
                       "bodyColumn": "outfit, hands and held props",
                       "independentAccessories": False},
        "frames": frames,
    }
    (ASSETS / "atlas.json").write_text(json.dumps(manifest, indent=2) + "\n")
    preview = Image.new("RGBA", atlases["team"].size, "#17202f")
    preview.alpha_composite(atlases["team"])
    preview.convert("RGB").save(ASSETS / "preview-dark.png")
    mixed = Image.new("RGBA", (CELL[0] * 4, CELL[1] * 4), "#17202f")
    for head_column in range(4):
        for body_column in range(4):
            destination = (body_column * CELL[0], head_column * CELL[1])
            for name, column in (("body", body_column), ("head", head_column)):
                part = atlases[name].crop((column * CELL[0], 0, (column + 1) * CELL[0], CELL[1]))
                mixed.alpha_composite(part, destination)
    mixed.convert("RGB").save(ASSETS / "preview-combinations.png")
    alpha = np.asarray(atlases["team"])[:, :, 3]
    print(f"Prepared RGBA atlas {atlases['team'].size}; transparent pixels {np.mean(alpha == 0):.1%}")
    print("Verified all 16 frames reconstruct exactly from head + body; inspect both preview PNGs.")


if __name__ == "__main__":
    main()
