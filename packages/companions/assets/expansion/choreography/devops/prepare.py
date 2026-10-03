"""Export measured DEVOPS choreography cutouts without changing ImageGen originals."""
from collections import deque
from hashlib import sha256
from pathlib import Path
import json
import math

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
EXPANSION = HERE.parent.parent
SOURCES = EXPANSION / 'source' / 'choreography-v1'
QA = EXPANSION.parents[3] / '.local' / 'choreography-qa' / 'devops'
SIZE = (256, 384)
FACES = ['close', 'slightly-open', 'A', 'O', 'E', 'I', 'U', 'smile-speaking',
         'open', 'quarter', 'half', 'three-quarter', 'closed', 'reopen', 'smile',
         'concern', 'focus', 'surprise']


def canonical(image):
    """Preserve antialiasing; make near-opaque interiors opaque and clear invisible RGB."""
    pixels = np.array(image.convert('RGBA'))
    pixels[pixels[:, :, 3] < 8] = 0
    pixels[pixels[:, :, 3] >= 245, 3] = 255
    return Image.fromarray(pixels)


def components(image):
    """Identify full authored figures independently of the sheet's irregular grid gaps."""
    remaining = np.array(image.getchannel('A')) > 32
    height, width = remaining.shape
    labels = np.zeros(remaining.shape, dtype=np.uint16)
    found = []
    identifier = 0
    for y in range(height):
        for x in range(width):
            if not remaining[y, x]:
                continue
            identifier += 1
            queue = deque([(x, y)])
            remaining[y, x] = False
            bounds = [x, y, x, y]
            count = 0
            while queue:
                xx, yy = queue.popleft()
                labels[yy, xx] = identifier
                count += 1
                bounds[0] = min(bounds[0], xx)
                bounds[1] = min(bounds[1], yy)
                bounds[2] = max(bounds[2], xx)
                bounds[3] = max(bounds[3], yy)
                for nx, ny in [(xx-1, yy), (xx+1, yy), (xx, yy-1), (xx, yy+1)]:
                    if 0 <= nx < width and 0 <= ny < height and remaining[ny, nx]:
                        remaining[ny, nx] = False
                        queue.append((nx, ny))
            if count > 1000:
                found.append({'id': identifier, 'pixels': count,
                              'bounds': [*bounds[:2], bounds[2]+1, bounds[3]+1]})
    return labels, found


def clean_figure(image, labels, component):
    """Preserve navy/cyan linework; drop detached flecks and alpha-zero background RGB."""
    selected = Image.fromarray(((labels == component['id']) * 255).astype('uint8'))
    selected = selected.filter(ImageFilter.MaxFilter(3))
    figure = image.copy()
    figure.putalpha(ImageChops.darker(figure.getchannel('A'), selected))
    return canonical(figure), 0


def polygon(size, points):
    image = Image.new('L', size)
    ImageDraw.Draw(image).polygon(points, fill=255)
    return image


def underlap(body, foreground):
    """Extend authored nearby seam pixels two pixels behind opaque moving joints only."""
    original = np.array(body)
    result = original.copy()
    occlusion = np.array(foreground.getchannel('A')) == 255
    # These are hidden copies of the same authored clothing/neck edge, never a
    # painted replacement, large body patch or retained duplicate moving arm.
    for dx, dy in [(0, 1), (1, 0), (-1, 0), (0, -1), (0, 2), (2, 0), (-2, 0), (0, -2)]:
        donor = np.roll(original, (dy, dx), axis=(0, 1))
        if dx > 0: donor[:, :dx] = 0
        if dx < 0: donor[:, dx:] = 0
        if dy > 0: donor[:dy] = 0
        if dy < 0: donor[dy:] = 0
        needed = (result[:, :, 3] == 0) & occlusion & (donor[:, :, 3] == 255)
        result[needed] = donor[needed]
    return canonical(Image.fromarray(result))


def compose(images, definition):
    image = Image.new('RGBA', SIZE)
    for layer in definition['layers']:
        image.alpha_composite(images[layer['id']])
    return canonical(image)


def neck_underlap(body, register, head, mask):
    """Keep authored skin behind an opaque neck so a narrower mixed head has a seam."""
    pixels = np.array(register)
    red, green, blue = pixels[:, :, :3].astype(float).transpose(2, 0, 1)
    skin = (red > 120) & (green > 90) & (blue > 75) & (red-green > 10) & (green-blue > -6) & (red-blue > 25)
    hidden = (np.array(head.getchannel('A')) == 255) & (np.array(mask) == 255) & skin
    result = np.array(body)
    result[hidden] = pixels[hidden]
    return canonical(Image.fromarray(result))


def export_pose(key, spec, sources):
    source, labels, found = sources[spec['source']]
    component = next(item for item in found if item['bounds'] == spec['componentBounds'])
    figure, neutralized = clean_figure(source, labels, component)
    bounds = figure.getchannel('A').getbbox()
    # Eye spacing registers comparable frontal faces; the first three upright
    # redraws use measured equal-height scales to avoid side-view foreshortening.
    # Never stretch a crouched, kneeling or seated figure to standing height.
    anchors = json.loads((EXPANSION/'face-registration.json').read_text())['devops'][0]['targetAnchors']
    reference_eye_pixels = math.dist(*anchors[:2])
    requested_scale = reference_eye_pixels/math.dist(*spec['eyes']) if 'eyes' in spec else spec['scale']
    # Verified kneeling/desk skulls need a uniform correction; never change axes independently.
    requested_scale *= spec.get('scaleMultiplier', 1)
    scale = min(requested_scale, 236/(bounds[2]-bounds[0]), 348/(bounds[3]-bounds[1]))
    # A matched gait anchors the neck, not the changing wide/narrow foot span.
    dx = 128 - spec.get('anchorX', (bounds[0]+bounds[2]-1)/2)*scale
    feet = component['bounds'][3]-1
    dy = 368 - feet*scale
    register = canonical(figure.transform(SIZE, Image.Transform.AFFINE,
        (1/scale, 0, -dx/scale, 0, 1/scale, -dy/scale), Image.Resampling.BICUBIC))
    point = lambda xy: [round(xy[0]*scale+dx, 3), round(xy[1]*scale+dy, 3)]
    remaining = register.getchannel('A')
    images = {}
    moving = Image.new('RGBA', SIZE)
    # The masks are cut AFTER uniform registration: their rest composition is
    # pixel-identical to the registered drawing, including antialiased edges.
    parts = spec['parts']
    for name, part in parts.items():
        mask = polygon(SIZE, [tuple(point(xy)) for xy in part['polygon']])
        selected = ImageChops.darker(remaining, mask)
        image = register.copy()
        image.putalpha(selected)
        images[name] = canonical(image)
        # Back hair is drawn BEFORE clothing; filling clothing across that cut
        # would cover authored visible strands at rest.
        if name != 'hair-back': moving.alpha_composite(image)
        remaining = ImageChops.subtract(remaining, selected)
    head_mask = polygon(SIZE, [tuple(point(xy)) for xy in spec['head']])
    if 'headCrop' in spec:
        head_mask = ImageChops.darker(head_mask, polygon(SIZE, [tuple(point(xy)) for xy in spec['headCrop']]))
    selected = ImageChops.darker(remaining, head_mask)
    head = register.copy()
    head.putalpha(selected)
    images['head'] = canonical(head)
    moving.alpha_composite(head)
    remaining = ImageChops.subtract(remaining, selected)
    body = register.copy()
    body.putalpha(remaining)
    body = canonical(body)
    if 'neckUnderlap' in spec:
        body = neck_underlap(body, register, head, polygon(SIZE, [tuple(point(xy)) for xy in spec['neckUnderlap']]))
    images['body'] = underlap(body, moving)
    prefix = f'choreography/devops/{key}'
    layers = [{'id': 'body', 'file': f'{prefix}/body.png', 'parent': None,
               'pivot': [128, 368], 'motion': 'body', 'amplitudeDegrees': 0}]
    for name, part in parts.items():
        layer = {'id': name, 'file': f'{prefix}/{name}.png', 'parent': part.get('parent', 'body'),
                 'pivot': point(part['pivot']), 'motion': part.get('motion', 'arm'),
                 'amplitudeDegrees': part.get('limit', .6)}
        if name == 'hair-back': layers.insert(0, layer)
        else: layers.append(layer)
    layers.append({'id': 'head', 'file': f'{prefix}/head.png', 'parent': 'body',
                   'pivot': point(spec['neck']), 'motion': 'head', 'amplitudeDegrees': .55})
    definition = {'name': f'DEVOPS {key}', 'roleHint': 'code',
        'registration': {'kind': 'uniform', 'source': f'choreography-v1/{spec["source"]}',
                         'componentBounds': component['bounds'], 'scaleX': scale, 'scaleY': scale,
                         'offsetX': dx, 'offsetY': dy, 'sourceFeet': feet, 'targetFeet': 368},
        'layers': layers,
        'face': {'file': 'choreography/devops/facial.png', 'frameHeight': 384, 'frames': FACES},
        'motion': {'breathSeconds': 4.6, 'gestureSeconds': 4, 'gestureIntervalSeconds': [8, 15]}}
    folder = HERE/key
    folder.mkdir(parents=True, exist_ok=True)
    for name, image in images.items():
        assert image.getchannel('A').getbbox(), (key, name, 'empty cutout')
        image.save(folder/f'{name}.png', optimize=True)
    composed = compose(images, definition)
    assert np.array_equal(np.array(composed), np.array(register)), (key, 'rest composition changed')
    QA.mkdir(parents=True, exist_ok=True)
    composed.save(QA/f'{key}-transparent.png')
    for theme, color in [('light', '#f7f3ed'), ('dark', '#17202f')]:
        preview = Image.new('RGBA', SIZE, color)
        preview.alpha_composite(composed)
        preview.resize((512, 768), Image.Resampling.NEAREST).convert('RGB').save(QA/f'{key}-{theme}.png')
    return definition, {'key': key, 'neutralizedContourPixels': neutralized,
                        'layers': len(layers), 'restCompositionIdentical': True,
                        'nativeBounds': composed.getchannel('A').getbbox()}


def main():
    specs = json.loads((HERE/'spec.json').read_text())
    sources = {}
    hashes = {}
    for name in {spec['source'] for spec in specs.values()}:
        path = SOURCES/name
        source = Image.open(path).convert('RGBA')
        labels, found = components(source)
        assert len(found) >= 2, (name, len(found), 'expected an authored sheet, not a flattened crop')
        sources[name] = source, labels, found
        hashes[name] = sha256(path.read_bytes()).hexdigest()
    manifest = {'version': 1, 'canvas': {'width': 256, 'height': 384},
                'coordinates': 'top-left', 'feetBaseline': 368, 'characters': {}}
    report = []
    for key, spec in specs.items():
        definition, result = export_pose(key, spec, sources)
        manifest['characters'][f'devops/{key}'] = definition
        report.append(result)
    Image.new('RGBA', (256, 384*18)).save(HERE/'facial.png', optimize=True)
    manifest['runtimeFiles'] = sorted({layer['file'] for d in manifest['characters'].values() for layer in d['layers']} | {'choreography/devops/facial.png'})
    (HERE/'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')
    for theme, color in [('light', '#f7f3ed'), ('dark', '#17202f')]:
        sheet = Image.new('RGB', (256*4, 412*4), color)
        draw = ImageDraw.Draw(sheet)
        for index, key in enumerate(specs):
            x, y = index % 4*256, index//4*412
            image = Image.open(QA/f'{key}-transparent.png').convert('RGBA')
            sheet.paste(image, (x, y), image)
            draw.text((x+8, y+389), key, fill='#23232c' if theme == 'light' else '#e6e6ef')
        sheet.save(QA/f'contact-{theme}.png')
    (QA/'report.json').write_text(json.dumps({'poses': report, 'sourceSHA256': hashes,
        'facialAnimation': 'Blank 18-frame atlas; preserve authored side/back face, return to base front rig for speech.',
        'jointUnderlapPixels': 2, 'passed': True}, indent=2)+'\n')
    print(f'PASS {len(report)} DEVOPS layered poses, exact rest composition, uniform registration; QA {QA}')


if __name__ == '__main__':
    main()
