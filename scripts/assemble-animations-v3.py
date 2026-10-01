#!/usr/bin/env python3
"""Pack reviewed ImageGen drawings into role-column atlases; never fabricate frames."""
from pathlib import Path
import hashlib
import json
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'packages/companions/assets'
SOURCE = ASSETS / 'source/animation-v3'
ROLES = ['lead', 'code', 'research', 'review']
CELL = (256, 384)
SPECS = [('working', 'activity', 0, 10, 4000), ('thinking', 'activity', 10, 10, 4500),
         ('success', 'reactions', 0, 8, 3200), ('waiting', 'reactions', 8, 6, 3600),
         ('error', 'reactions', 14, 6, 3200)]


def digest(image):
    return hashlib.sha256(image.tobytes()).hexdigest()


def prepared_cell(image, index):
    x, y = index % 4 * 256, index // 4 * 384
    return image.crop((x, y, x + 256, y + 384))


def validate(image, role, kind, index):
    assert image.mode == 'RGBA' and image.size == CELL, (role, kind, index, 'format')
    bounds = image.getbbox()
    assert bounds and 0 < bounds[0] < bounds[2] < 256 and 0 < bounds[1] < bounds[3] < 384, (role, kind, index, bounds)
    if kind != 'face':
        assert 367 <= bounds[3] - 1 <= 369, (role, kind, index, 'feet', bounds)
    return bounds


def main():
    clips, records = {}, []
    counts = {role: {'body': 20, 'face': 0} for role in ROLES}
    unique = {role: set() for role in ROLES}
    previous = json.loads((ASSETS / 'animation-v2.json').read_text())
    # Validate the sixty actual RGBA cells, including the twenty existing drawings.
    for clip in previous['clips'].values():
        image = Image.open(ASSETS / clip['atlas']).convert('RGBA')
        for col, role in enumerate(ROLES):
            for row in clip['frames']:
                unique[role].add(digest(image.crop((col * 256, row * 384, col * 256 + 256, row * 384 + 384))))
    inputs = {}
    for role in ROLES:
        for kind in ['activity', 'reactions']:
            path = SOURCE / role / f'{kind}-registered.png'
            image = Image.open(path)
            assert image.mode == 'RGBA' and image.size == (1024, 1920), path
            inputs[(role, kind)] = image
    for name, source, start, count, duration in SPECS:
        atlas = Image.new('RGBA', (1024, 384 * count))
        for col, role in enumerate(ROLES):
            for row in range(count):
                frame = prepared_cell(inputs[(role, source)], start + row)
                bounds = validate(frame, role, name, row)
                sha = digest(frame)
                assert sha not in unique[role], (role, name, row, 'duplicate body drawing')
                unique[role].add(sha); counts[role]['body'] += 1
                atlas.paste(frame, (col * 256, row * 384))
                records.append({'role': role, 'clip': name, 'row': row, 'column': col,
                                'bounds': bounds, 'sha256': sha, 'source': f'{role}/{source}-registered.png',
                                'sourceIndex': start + row})
        filename = f'{name}-v3.png'
        atlas.save(ASSETS / filename, optimize=True)
        clips[name] = {'atlas': filename, 'frames': list(range(count)), 'durationMs': duration}
        for background, color in [('dark', '#17202f'), ('light', '#ffffff')]:
            contact = Image.new('RGBA', atlas.size, color); contact.alpha_composite(atlas)
            contact.convert('RGB').save(SOURCE / f'{name}-{background}.png')
        frames = []
        for row in range(count):
            frame = Image.new('RGBA', (1024, 384), '#17202f')
            frame.alpha_composite(atlas.crop((0, row * 384, 1024, row * 384 + 384)))
            frames.append(frame.convert('RGB'))
        frames[0].save(SOURCE / f'{name}-preview.gif', save_all=True, append_images=frames[1:],
                       duration=round(duration/count), loop=0, disposal=2)
    faces = Image.new('RGBA', (1024, 6912))
    for col, role in enumerate(ROLES):
        image = Image.open(SOURCE / role / 'face-registered.png')
        assert image.mode == 'RGBA' and image.size == (256, 6912), role
        seen = set()
        for row in range(18):
            frame = image.crop((0, row * 384, 256, row * 384 + 384))
            bounds = validate(frame, role, 'face', row); sha = digest(frame)
            assert sha not in seen, (role, 'duplicate face patch', row)
            seen.add(sha); counts[role]['face'] += 1
            records.append({'role': role, 'clip': 'face', 'row': row, 'column': col,
                            'bounds': bounds, 'sha256': sha, 'source': f'{role}/face-registered.png'})
        faces.paste(image, (col * 256, 0))
    faces.save(ASSETS / 'facial-v3.png', optimize=True)
    base = Image.open(ASSETS / 'team-atlas.png').convert('RGBA')
    preview = []
    for row in range(18):
        strip = Image.new('RGBA', (864, 168), '#17202f')
        for column in range(4):
            character = base.crop((column * 256, 0, column * 256 + 256, 384))
            character.alpha_composite(faces.crop((column * 256, row * 384, column * 256 + 256, row * 384 + 384)))
            closeup = character.crop((60, 25, 195, 130)).resize((216, 168), Image.Resampling.NEAREST)
            strip.alpha_composite(closeup, (column * 216, 0))
        preview.append(strip.convert('RGB'))
    preview[0].save(SOURCE / 'facial-preview.gif', save_all=True, append_images=preview[1:],
                    duration=[180] * 8 + [80] * 6 + [350] * 4, loop=0, disposal=2)
    assert all(value == {'body': 60, 'face': 18} for value in counts.values()), counts
    manifest = {'version': 3, 'cell': {'width': 256, 'height': 384}, 'columns': ROLES,
                'feetBaseline': 368, 'clips': clips,
                'facial': {'atlas': 'facial-v3.png', 'mouth': list(range(8)), 'blink': list(range(8, 14)),
                           'emotion': list(range(14, 18)), 'registration': 'base idle inner-face patches'},
                'counts': counts, 'frames': records}
    (ASSETS / 'animation-v3.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'verifiedUniqueDrawings': counts, 'totalBody': 240, 'totalFacial': 72}))


if __name__ == '__main__':
    main()
