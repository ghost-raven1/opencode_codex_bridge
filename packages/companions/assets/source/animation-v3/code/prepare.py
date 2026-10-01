"""Register generated CODE/RESEARCH artwork; technical extraction only, no synthetic drawings."""
from pathlib import Path
import importlib.util
import hashlib
import json

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT.parents[1]
spec = importlib.util.spec_from_file_location('extract_v2', ROOT.parent/'animation-v2'/'prepare.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
CELL = (256, 384)
ROLE_COLUMNS = {'code': 1, 'research': 2}
FACE_LABELS = ['close', 'slightly-open', 'A', 'O', 'E', 'I', 'U', 'smile-speaking',
               'open', 'quarter', 'half', 'three-quarter', 'closed', 'reopen',
               'smile', 'concern', 'focus', 'surprise']


def colored(image):
    rgb = np.asarray(image.convert('RGB')).astype('int16')
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    return ~((r > 65) & (b-r >= -4) & (b-r < 22) & (g-r >= -5) & (g-r < 16))


def row_cuts(image, rows):
    counts = colored(image).sum(axis=1)
    cuts = [0]
    for n in range(1, rows):
        expected = round(image.height*n/rows)
        lo, hi = expected-48, expected+49
        values = counts[lo:hi]
        candidates = np.nonzero(values == values.min())[0] + lo
        cuts.append(int(candidates[len(candidates)//2]))
    return cuts + [image.height]


def source_cells(image, columns, rows):
    cuts = row_cuts(image, rows)
    for index in range(columns*rows):
        row, col = divmod(index, columns)
        box = (round(col*image.width/columns), cuts[row], round((col+1)*image.width/columns), cuts[row+1])
        yield index, box, image.crop(box)


def register_body(role, kind):
    image = Image.open(ROOT/role/f'{kind}-raw.png')
    atlas = Image.new('RGBA', (1024, 1920))
    metrics = []
    for index, box, crop in source_cells(image, 4, 5):
        sprite = helper.extract(crop, role)
        if role == 'code' and kind == 'activity' and index == 15:
            # Generator added an isolated orange emphasis stroke; it is not character artwork.
            pixels = np.asarray(sprite).copy()
            alpha = pixels[:, :, 3] > 0
            ys, xs = np.nonzero(alpha)
            seed = int(np.argmin((xs-crop.width*.5)**2 + (ys-crop.height*.55)**2))
            seen = np.zeros(alpha.shape, dtype=bool)
            queue = [(int(ys[seed]), int(xs[seed]))]
            while queue:
                y, x = queue.pop()
                if seen[y, x]: continue
                seen[y, x] = True
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        yy, xx = y+dy, x+dx
                        if 0 <= yy < alpha.shape[0] and 0 <= xx < alpha.shape[1] and alpha[yy, xx] and not seen[yy, xx]:
                            queue.append((yy, xx))
            pixels[~seen] = 0
            sprite = Image.fromarray(pixels)
        bounds = sprite.getbbox()
        assert bounds, (role, kind, index)
        alpha = np.asarray(sprite)[:, :, 3]
        soles = np.nonzero(alpha[max(0, bounds[3]-18):bounds[3]])[1]
        center = float((soles.min()+soles.max())/2)
        registered = helper.register(sprite, center, bounds)
        clean_bounds = registered.getbbox()
        assert clean_bounds and clean_bounds[0] >= 3 and clean_bounds[2] <= 253, (role, kind, index, clean_bounds)
        assert 366 <= clean_bounds[3] <= 369, (role, kind, index, clean_bounds)
        row, col = divmod(index, 4)
        atlas.alpha_composite(registered, (col*256, row*384))
        group = ('working' if index < 10 else 'thinking') if kind == 'activity' else ('success' if index < 8 else 'waiting' if index < 14 else 'error')
        metrics.append({'index': index, 'state': group, 'sourceBox': box, 'sourceBounds': bounds,
                        'sourceCenter': center, 'bounds': clean_bounds, 'sha256': hashlib.sha256(registered.tobytes()).hexdigest()})
    assert len({frame['sha256'] for frame in metrics}) == 20
    atlas.save(ROOT/role/f'{kind}-registered.png', optimize=True)
    for theme, background in [('dark', '#17202f'), ('light', '#f2eee7')]:
        contact = Image.new('RGBA', atlas.size, background)
        contact.alpha_composite(atlas)
        contact.convert('RGB').save(ROOT/role/f'{kind}-{theme}.png')
    return metrics


def face_masks(role):
    mouth = Image.new('L', CELL)
    eyes = Image.new('L', CELL)
    emotion = Image.new('L', CELL)
    if role == 'code':
        ImageDraw.Draw(mouth).ellipse((128, 84, 145, 95), fill=255)
        draw = ImageDraw.Draw(eyes)
        draw.polygon([(109, 71), (113, 65), (126, 64), (134, 69), (135, 79), (129, 83), (114, 81)], fill=255)
        draw.polygon([(141, 77), (147, 73), (155, 74), (155, 83), (145, 88), (139, 84)], fill=255)
        ImageDraw.Draw(emotion).polygon([(112, 68), (132, 68), (138, 79), (147, 75), (155, 75),
                                        (155, 87), (145, 93), (137, 97), (124, 93), (112, 85)], fill=255)
    else:
        ImageDraw.Draw(mouth).ellipse((122, 90, 143, 102), fill=255)
        draw = ImageDraw.Draw(eyes)
        draw.polygon([(112, 75), (117, 72), (126, 73), (130, 77), (129, 84), (123, 87), (115, 84)], fill=255)
        draw.polygon([(140, 80), (147, 80), (151, 85), (148, 90), (141, 90), (138, 86)], fill=255)
        draw.polygon([(116, 68), (127, 68), (132, 72), (118, 73)], fill=255)
        ImageDraw.Draw(emotion).polygon([(111, 74), (129, 71), (139, 81), (152, 81), (151, 94),
                                        (141, 101), (130, 104), (117, 98), (111, 90)], fill=255)
    rims = Image.new('L', CELL)
    if role == 'research':
        draw = ImageDraw.Draw(rims)
        for points in [
            [(109, 72), (115, 71), (123, 72), (129, 75), (132, 79), (130, 87), (124, 90), (115, 87), (110, 83), (109, 72)],
            [(136, 79), (143, 78), (151, 80), (155, 84), (152, 91), (147, 94), (139, 91), (135, 87), (136, 79)],
            [(131, 80), (137, 81)],
        ]: draw.line(points, fill=255, width=2)
    masks = []
    for original in [mouth, eyes, emotion]:
        # One-pixel feather entirely inside the requested region.
        blurred = np.asarray(original.filter(ImageFilter.GaussianBlur(0.65)))
        masked = np.where(np.asarray(original) > 0, blurred, 0).astype('uint8')
        masked[np.asarray(rims) > 0] = 0
        masks.append(Image.fromarray(masked))
    return masks


def register_faces(role, base):
    image = Image.open(ROOT/role/'face-raw.png').convert('RGBA')
    crops = list(source_cells(image, 3, 6))
    reference_bounds = Image.fromarray((colored(crops[0][2])*255).astype('uint8')).getbbox()
    if role == 'code':
        source = [(195, 123), (248, 133), (222, 160)]
        target = [(122, 75), (147, 80), (136, 89)]
        rect = (105, 59, 160, 101)
    else:
        source = [(177, 141), (239, 155), (207, 185)]
        target = [(121, 79), (145, 85), (132, 95)]
        rect = (105, 64, 159, 107)
    matrix = np.linalg.solve(np.array([[x, y, 1] for x, y in target], dtype=float), np.array(source, dtype=float)).T
    masks = face_masks(role)
    atlas = Image.new('RGBA', (256, 18*384))
    qa = Image.new('RGBA', (1080, 1080), '#17202f')
    pixels_base = np.asarray(base)
    metrics = []
    for index, box, crop in crops:
        bounds = Image.fromarray((colored(crop)*255).astype('uint8')).getbbox()
        sx = (bounds[2]-bounds[0])/(reference_bounds[2]-reference_bounds[0])
        sy = (bounds[3]-bounds[1])/(reference_bounds[3]-reference_bounds[1])
        normalize = (sx, 0, bounds[0]-reference_bounds[0]*sx, 0, sy, bounds[1]-reference_bounds[1]*sy)
        normalized = crop.transform(crops[0][2].size, Image.Transform.AFFINE, normalize, resample=Image.Resampling.BICUBIC)
        transformed = normalized.transform(CELL, Image.Transform.AFFINE, tuple(matrix.flatten()), resample=Image.Resampling.NEAREST)
        pixels = np.asarray(transformed).copy()
        mask = np.asarray(masks[0 if index < 8 else 1 if index < 14 else 2]).copy()
        # Match the original skin palette without drawing or moving facial features.
        region = np.zeros(CELL[::-1], dtype=bool); region[rect[1]:rect[3], rect[0]:rect[2]] = True
        def skin(values):
            rgb = values[:, :, :3].astype('int16')
            return region & (rgb[:, :, 0] > 155) & (rgb[:, :, 0]-rgb[:, :, 1] > 15) & (rgb[:, :, 0]-rgb[:, :, 2] > 30)
        adjustment = np.median(pixels_base[skin(pixels_base), :3], axis=0) - np.median(pixels[skin(pixels), :3], axis=0)
        adjustment = np.clip(adjustment, -25, 25)
        pixels[:, :, :3] = np.clip(pixels[:, :, :3].astype(float)+adjustment, 0, 255).astype('uint8')
        pixels[:, :, 3] = mask
        pixels[mask == 0] = 0
        patch = Image.fromarray(pixels)
        atlas.alpha_composite(patch, (0, index*384))
        after = base.copy(); after.alpha_composite(patch)
        col, row = index % 6, index // 6
        for offset, frame in [(0, base), (174, after)]:
            face = frame.crop((90, 40, 175, 120)).resize((170, 160), Image.Resampling.NEAREST)
            qa.alpha_composite(face, (col*180+5, row*360+18+offset))
        ImageDraw.Draw(qa).text((col*180+5, row*360+1), f'{index:02d} {FACE_LABELS[index]}', fill='white')
        metrics.append({'index': index, 'name': FACE_LABELS[index], 'sourceBox': box, 'sourceBounds': bounds,
                        'normalize': normalize, 'maskBounds': patch.getbbox(), 'skinAdjustment': adjustment.tolist(),
                        'sha256': hashlib.sha256(patch.tobytes()).hexdigest()})
    assert len({frame['sha256'] for frame in metrics}) == 18
    atlas.save(ROOT/role/'face-registered.png', optimize=True)
    qa.convert('RGB').save(ROOT/role/'face-before-after.png')
    return {'sourceLandmarks': source, 'targetLandmarks': target, 'sourceFromTargetAffine': matrix.tolist(), 'frames': metrics}


def main():
    original = Image.open(ASSETS/'team-atlas.png').convert('RGBA')
    for role, column in ROLE_COLUMNS.items():
        body = {kind: register_body(role, kind) for kind in ['activity', 'reactions']}
        base = original.crop((column*256, 0, (column+1)*256, 384))
        faces = register_faces(role, base)
        metadata = {'version': 3, 'role': role, 'cell': {'width': 256, 'height': 384},
                    'feetBaseline': 368, 'bodyGrid': [4, 5], 'faceGrid': [1, 18],
                    'newBodyDrawings': 40, 'newFaceDrawings': 18, 'source': 'builtin ImageGen',
                    'body': body, 'faces': faces}
        metadata['rawSources'] = {name: {'file': f'{name}-raw.png',
            'sha256': hashlib.sha256((ROOT/role/f'{name}-raw.png').read_bytes()).hexdigest(),
            'mode': 'RGB with generated checker background'} for name in ['activity', 'reactions', 'face']}
        metadata['extractor'] = {'file': '../../animation-v2/prepare.py',
            'sha256': hashlib.sha256((ROOT.parent/'animation-v2/prepare.py').read_bytes()).hexdigest()}
        metadata['promptFile'] = 'prompts.json'
        metadata['referenceFile'] = 'reference.png'
        metadata['faceOverlayRules'] = {'mouth': list(range(8)), 'eyes': list(range(8, 14)),
            'emotion': list(range(14, 18)), 'alignedTo': 'original team-atlas idle column',
            'outsideMasksTransparent': True, 'featherPx': 0.65, 'researchGlassesRimsPreserved': role == 'research'}
        (ROOT/role/'registration.json').write_text(json.dumps(metadata, indent=2)+'\n')
        print(role, 'registered 40 body /18 face; distinct hashes verified')


if __name__ == '__main__':
    main()
