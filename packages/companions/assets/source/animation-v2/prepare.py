#!/usr/bin/env python3
"""Extract and register 80 newly generated drawings; never synthesize character art."""
from pathlib import Path
from collections import deque
import hashlib
import json

import numpy as np
from PIL import Image, ImageDraw

SOURCE = Path(__file__).resolve().parent
ASSETS = SOURCE.parent / 'full-body-clips'
PREVIEWS = SOURCE.parents[4] / '.local/artwork-previews/animation-v2'
ROLES = ['lead', 'code', 'research', 'review']
CELL = (256, 384)
CLIPS = {'ambient': (0, 8, 3200), 'entrance': (8, 6, 1200), 'transform': (14, 6, 1400)}
REGISTRATION = json.loads((SOURCE/'registration.json').read_text())
ROWS = {
    'lead': [0, 315, 628, 934, 1232, 1536],
    'code': [0, 322, 639, 952, 1258, 1536],
    'research': [0, 316, 620, 905, 1198, 1536],
    'review': [0, 316, 628, 935, 1234, 1536],
}
# Chest axes measured from the original art, independent of hand/prop silhouette.
CENTERS = {
    'lead': [[144, 398, 647, 895], [145, 396, 645, 893], [158, 402, 650, 896], [118, 526, 737, 927], [136, 381, 635, 895]],
    'code': [[163, 403, 650, 894], [162, 405, 650, 895], [162, 403, 650, 894], [160, 405, 650, 897], [175, 405, 646, 894]],
    'research': [[165, 403, 635, 869], [166, 404, 636, 870], [166, 404, 637, 870], [164, 403, 637, 874], [170, 405, 642, 871]],
    'review': [[145, 388, 633, 878], [145, 389, 634, 879], [126, 393, 636, 881], [129, 391, 636, 887], [135, 393, 641, 886]],
}


def connected_background(candidate):
    """Flood only neutral pixels reachable from crop edges, retaining white fabric."""
    h, w = candidate.shape
    seen = np.zeros_like(candidate)
    queue = deque()
    for y, x in [(y, x) for y in range(h) for x in (0, w-1)] + [(y, x) for x in range(w) for y in (0, h-1)]:
        if candidate[y, x] and not seen[y, x]:
            seen[y, x] = True
            queue.append((y, x))
    while queue:
        y, x = queue.popleft()
        for yy, xx in [(y-1, x), (y+1, x), (y, x-1), (y, x+1)]:
            if 0 <= yy < h and 0 <= xx < w and candidate[yy, xx] and not seen[yy, xx]:
                seen[yy, xx] = True
                queue.append((yy, xx))
    return seen


def discard_speckles(alpha):
    """Discard disconnected matte noise, not small detail attached to the figure."""
    h, w = alpha.shape
    seen = np.zeros_like(alpha, dtype=bool)
    for y, x in zip(*np.nonzero(alpha)):
        if seen[y, x]:
            continue
        points = []
        queue = [(y, x)]
        seen[y, x] = True
        while queue:
            yy, xx = queue.pop()
            points.append((yy, xx))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = yy+dy, xx+dx
                    if 0 <= ny < h and 0 <= nx < w and alpha[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        queue.append((ny, nx))
        if len(points) < 40:
            for yy, xx in points:
                alpha[yy, xx] = 0
    return alpha


def enclosed_checker(rgb, background, protected, role):
    """Find neutral checker islands with both background shades, not flat highlights."""
    r = rgb[:, :, 0]
    spread = 14 if role == 'lead' else 6
    candidate = (r > 85) & (rgb.max(axis=2)-rgb.min(axis=2) < spread) & ~protected & ~background
    candidate[int(rgb.shape[0]*.38):] = False
    seen = np.zeros(candidate.shape, dtype=bool)
    removed = np.zeros(candidate.shape, dtype=bool)
    h, w = candidate.shape
    for sy, sx in zip(*np.nonzero(candidate)):
        if seen[sy, sx]:
            continue
        points, queue = [], [(sy, sx)]
        seen[sy, sx] = True
        while queue:
            y, x = queue.pop()
            points.append((y, x))
            for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                ny, nx = y+dy, x+dx
                if 0 <= ny < h and 0 <= nx < w and candidate[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    queue.append((ny, nx))
        ys, xs = np.asarray(points).T
        values = r[ys, xs]
        # A background island contains two checker tones; silver highlights do not.
        if 6 <= len(points) <= 250 and np.percentile(values, 90)-np.percentile(values, 10) > 43:
            removed[ys, xs] = True
    return removed


def extract(image, role):
    pixels = np.asarray(image.convert('RGBA')).copy()
    rgb = pixels[:, :, :3].astype('int16')
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    neutral = (r > 65) & (b-r >= -4) & (b-r < 22) & (g-r >= -5) & (g-r < 16)
    candidate = neutral.copy()
    if role == 'code':
        # Close tiny outline gaps around white sneakers before flooding the matte.
        ink = np.pad(~neutral, 1)
        closed = np.zeros(neutral.shape, dtype=bool)
        for dy in range(3):
            for dx in range(3):
                closed |= ink[dy:dy+image.height, dx:dx+image.width]
        candidate[int(image.height*.80):] &= ~closed[int(image.height*.80):]
    background = connected_background(candidate)
    # Keep the eye whites and the neutral highlights enclosed by the face outline.
    protected = np.zeros(background.shape, dtype=bool)
    skin = (r > 140) & (r-g > 20) & (r-b > 35) & (g > 70)
    skin[int(image.height*.37):] = False
    sy, sx = np.nonzero(skin)
    if len(sy):
        protected[sy.min():sy.max()+1, sx.min():sx.max()+1] = True
    # Hair gaps retain disconnected checkerboard islands. Purple has no neutral-white fabric.
    if role == 'code':
        hair_gaps = (r > 120) & (rgb.max(axis=2)-rgb.min(axis=2) < 12)
        hair_gaps[int(image.height*.65):] = False
        background |= hair_gaps & ~protected
    background |= enclosed_checker(rgb, background, protected, role)
    alpha = np.where(background, 0, 255).astype('uint8')
    # Remove the two-pixel neutral matte at silhouettes without blurring the ink line.
    for threshold in (100, 145):
        padded = np.pad(alpha > 0, 1)
        interior = np.ones(alpha.shape, dtype=bool)
        for dy in range(3):
            for dx in range(3):
                interior &= padded[dy:dy+image.height, dx:dx+image.width]
        edge = (alpha > 0) & ~interior
        matte = (r > threshold) & (b >= r-24) & (rgb.max(axis=2)-rgb.min(axis=2) < 40)
        alpha[edge & matte] = 0
    pixels[:, :, 3] = discard_speckles(alpha)
    pixels[pixels[:, :, 3] == 0] = 0
    return Image.fromarray(pixels)


def source_box(role, index):
    row, col = divmod(index, 4)
    left, right = col*256, (col+1)*256
    if role == 'lead' and row == 3:
        # The generator drew five figures in this row. Skip redundant second wave.
        bounds = [(0, 213), (426, 627), (627, 833), (833, 1024)]
        left, right = bounds[col]
    return (left, ROWS[role][row], right, ROWS[role][row+1])


def register(crop, source_center, bounds):
    assert bounds, 'Empty generated cell'
    left, top, right, bottom = bounds
    scale = 344 / (bottom-top)
    # Fit occasional outstretched hands as a whole; no clipping of fingertips.
    scale_x = min(scale, 120/max(source_center-left, right-source_center))
    transform = (1/scale_x, 0, source_center-128/scale_x, 0, 1/scale, top-24/scale)
    result = crop.transform(CELL, Image.Transform.AFFINE, transform, resample=Image.Resampling.NEAREST)
    pixels = np.asarray(result).copy()
    pixels[pixels[:, :, 3] == 0] = 0
    return Image.fromarray(pixels)


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    PREVIEWS.mkdir(parents=True, exist_ok=True)
    frames = {role: [] for role in ROLES}
    metrics = []
    for role in ROLES:
        source = Image.open(SOURCE/f'{role}-generated.png')
        for index in range(20):
            # LEAD/REVIEW generated the two profile views in reverse order.
            source_index = {16: 18, 18: 16}.get(index, index) if role in ('lead', 'review') else index
            box = source_box(role, source_index)
            row, col = divmod(source_index, 4)
            crop = extract(source.crop(box), role)
            sprite = register(crop, CENTERS[role][row][col]-box[0], REGISTRATION[role][source_index])
            bounds = sprite.getbbox()
            assert bounds and bounds[0] >= 4 and bounds[2] <= 252, (role, index, bounds)
            assert 365 <= bounds[3] <= 369 and bounds[1] >= 20, (role, index, bounds)
            frames[role].append(sprite)
            metrics.append({'role': role, 'index': index, 'sourceIndex': source_index, 'sourceBox': box, 'bounds': bounds, 'sha256': hashlib.sha256(sprite.tobytes()).hexdigest()})
    assert len({m['sha256'] for m in metrics}) == 80
    clips = {}
    previews, durations = [], []
    for name, (start, count, duration) in CLIPS.items():
        atlas = Image.new('RGBA', (1024, count*384))
        for row in range(count):
            scene = Image.new('RGBA', (1024, 416), '#17202f')
            for col, role in enumerate(ROLES):
                cell = frames[role][start+row]
                atlas.paste(cell, (col*256, row*384))
                scene.alpha_composite(cell, (col*256, 24))
            ImageDraw.Draw(scene).text((16, 8), f'{name.upper()} {row+1}/{count} | LEAD / CODE / RESEARCH / REVIEW', fill='#c6d1df')
            previews.append(scene.convert('RGB'))
            durations.append(round(duration / count))
        atlas.save(ASSETS/f'{name}-v2.png', optimize=True)
        contact = Image.new('RGBA', atlas.size, '#17202f')
        contact.alpha_composite(atlas)
        contact.convert('RGB').save(PREVIEWS/f'{name}-contact.png')
        clips[name] = {'atlas': f'{name}-v2.png', 'frames': list(range(count)), 'durationMs': duration}
    palette = previews[0].quantize(colors=256)
    gif_frames = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in previews]
    gif_frames[0].save(PREVIEWS/'animation-v2-preview.gif', save_all=True, append_images=gif_frames[1:], duration=durations, loop=0, disposal=2)
    manifest = {
        'version': 2, 'cell': {'width': 256, 'height': 384}, 'columns': ROLES,
        'coordinates': 'pixels, origin top-left', 'feetBaseline': 368,
        'clips': clips, 'frameCount': 80, 'uniqueDrawings': 80,
        'appearance': 'Complete figures for native role presets; use original head/body layers for mixed outfits.',
        'source': 'source/animation-v2/', 'frames': metrics,
    }
    (ASSETS/'animation-v2.json').write_text(json.dumps(manifest, indent=2)+'\n')
    print('Prepared 80 unique RGBA frames; all complete silhouettes inside cells, soles at y=368.')
    for name in CLIPS:
        path = ASSETS/f'{name}-v2.png'
        image = np.asarray(Image.open(path))
        print(path.name, hashlib.sha256(path.read_bytes()).hexdigest(), f'transparent={np.mean(image[:,:,3]==0):.1%}')


if __name__ == '__main__':
    main()
