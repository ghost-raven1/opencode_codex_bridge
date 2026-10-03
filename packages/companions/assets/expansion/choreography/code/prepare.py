"""Export measured CODE choreography cutouts without changing ImageGen originals."""
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
QA = EXPANSION.parents[3] / '.local' / 'choreography-qa' / 'code'
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
    """Drop disconnected export flecks and neutralize confirmed red/blue contour scribbles."""
    selected = Image.fromarray(((labels == component['id']) * 255).astype('uint8'))
    # Include the source's own antialiasing adjacent to its connected silhouette.
    selected = selected.filter(ImageFilter.MaxFilter(3))
    figure = image.copy()
    figure.putalpha(ImageChops.darker(figure.getchannel('A'), selected))
    pixels = np.array(figure)
    rgb = pixels[:, :, :3].astype(float)
    red, green, blue = rgb.transpose(2, 0, 1)
    rim = np.array(figure.getchannel('A').filter(ImageFilter.MinFilter(7))) < 32
    # CODE has no saturated red/cyan wardrobe. Only outside contour pixels are
    # touched: purple hair, skin, highlights, fingers and alpha remain intact.
    annotations = ((red > 175) & (green < 65) & (blue < 100)) | (
        (blue > 180) & (red < 105) & (green < 80))
    annotations &= rim & (pixels[:, :, 3] >= 8)
    pixels[annotations, :3] = [35, 25, 43]
    return canonical(Image.fromarray(pixels)), int(annotations.sum())


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


def neck_underlap(body, register, head, mask):
    """Keep authored skin behind an opaque neck so a narrower mixed head has a seam."""
    pixels = np.array(register)
    red, green, blue = pixels[:, :, :3].astype(float).transpose(2, 0, 1)
    skin = (red > 120) & (green > 90) & (blue > 75) & (red-green > 10) & (green-blue > -6) & (red-blue > 25)
    hidden = (np.array(head.getchannel('A')) == 255) & (np.array(mask) == 255) & skin
    result = np.array(body)
    result[hidden] = pixels[hidden]
    return canonical(Image.fromarray(result))


def skin_mask(register):
    """Select original warm skin, leaving the dark neck headphones and collar in the outfit."""
    pixels = np.array(register)
    red, green, blue = pixels[:, :, :3].astype(float).transpose(2, 0, 1)
    selected = (red > 120) & (green > 90) & (blue > 75) & (red-green > 10) & (green-blue > -6) & (red-blue > 25)
    return Image.fromarray(selected.astype('uint8')*255)


def hair_underlap(hair, register, spec, point, definitions):
    """Reuse authored ponytail pixels only behind the original opaque arm occlusion."""
    result = np.array(hair)
    original = np.array(register)
    for patch in spec.get('hairUnderlap', []):
        donor_definition = definitions[f'code/{patch["pose"]}']
        donor_head = next(layer for layer in donor_definition['layers'] if layer['id'] == 'head')
        donor_file = next(layer['file'] for layer in donor_definition['layers'] if layer['id'] == 'hair-back')
        anchor = point(spec['neck'])
        dx, dy = [anchor[index]-donor_head['pivot'][index] for index in range(2)]
        donor = Image.open(EXPANSION/donor_file).convert('RGBA').transform(SIZE, Image.Transform.AFFINE,
            (1, 0, -dx, 0, 1, -dy), Image.Resampling.BICUBIC)
        allowed = np.array(polygon(SIZE, [tuple(point(xy)) for xy in patch['polygon']])) == 255
        hidden = allowed & (original[:, :, 3] == 255) & (result[:, :, 3] == 0)
        pixels = np.array(donor)
        hidden &= pixels[:, :, 3] > 0
        result[hidden] = pixels[hidden]
    return canonical(Image.fromarray(result))


def compose(images, definition):
    image = Image.new('RGBA', SIZE)
    for layer in definition['layers']:
        image.alpha_composite(images[layer['id']])
    return canonical(image)


def costume_foundation(hair, spec):
    """Expose generated clothing only under opaque authored hair inside measured garment edges."""
    config = spec['foundation']
    source = Image.open(SOURCES/config['source']).convert('RGBA')
    x, y = config['cell']
    garment = source.crop((x*256, y*384, (x+1)*256, (y+1)*384))
    dx, dy = config.get('offset', [0, 0])
    scale = config.get('scale', 1)
    garment = garment.transform(SIZE, Image.Transform.AFFINE,
        (1/scale, 0, -dx/scale, 0, 1/scale, -dy/scale), Image.Resampling.BICUBIC)
    safe = np.array(hair.getchannel('A')) == 255
    allowed = np.array(polygon(SIZE, config['garmentPolygon'])) == 255
    pixels = np.array(canonical(garment))
    pixels[:, :, 3] *= (safe & allowed).astype('uint8')
    pixels[pixels[:, :, 3] == 0] = 0
    return Image.fromarray(pixels)


def export_pose(key, spec, sources, definitions=None):
    source, labels, found = sources[spec['source']]
    component = next(item for item in found if item['bounds'] == spec['componentBounds'])
    figure, neutralized = clean_figure(source, labels, component)
    bounds = figure.getchannel('A').getbbox()
    # The reference eye separation is measured on the current code/head.png.
    # Never stretch a crouched, kneeling or seated figure to standing height.
    reference = json.loads((EXPANSION/'manifest.json').read_text())['characters']['code']['registration']
    reference_eye_pixels = math.dist((267, 92), (305, 104))*reference['scaleX']
    requested_scale = reference_eye_pixels/math.dist(*spec['eyes']) if 'eyes' in spec else spec['scale']
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
        for extra in part.get('extraPolygons', []):
            mask = ImageChops.lighter(mask, polygon(SIZE, [tuple(point(xy)) for xy in extra]))
        if part.get('hairOnlyExtras'):
            pixels = np.array(register)
            red, green, blue = pixels[:, :, :3].astype(float).transpose(2, 0, 1)
            authored_hair = Image.fromarray(((red < blue*.83) & (blue > green*1.4)).astype('uint8')*255)
            for extra in part['hairOnlyExtras']:
                region = polygon(SIZE, [tuple(point(xy)) for xy in extra])
                mask = ImageChops.lighter(mask, ImageChops.darker(region, authored_hair))
        if part.get('skinOnlyExtras'):
            pixels = np.array(register)
            red, green, blue = pixels[:, :, :3].astype(float).transpose(2, 0, 1)
            skin = (red-green > 20) & (red-blue > 35) & (red > 125) & (green > 70)
            skin = Image.fromarray(skin.astype('uint8')*255).filter(ImageFilter.MaxFilter(3))
            for extra in part['skinOnlyExtras']:
                region = polygon(SIZE, [tuple(point(xy)) for xy in extra])
                mask = ImageChops.lighter(mask, ImageChops.darker(region, skin))
        selected = ImageChops.darker(remaining, mask)
        image = register.copy()
        image.putalpha(selected)
        images[name] = canonical(image)
        # Back hair is drawn BEFORE clothing; filling clothing across that cut
        # would cover authored visible strands at rest.
        if name != 'hair-back': moving.alpha_composite(image)
        remaining = ImageChops.subtract(remaining, selected)
    # The corrected contour is the complete head envelope, rather than an
    # intersection that left detached ears and side hair in the outfit.
    head_mask = polygon(SIZE, [tuple(point(xy)) for xy in spec.get('headCrop', spec['head'])])
    if 'neckSkin' in spec:
        skin = skin_mask(register)
        neckline = polygon(SIZE, [tuple(point(xy)) for xy in spec['neckSkin']])
        head_mask = ImageChops.lighter(head_mask, ImageChops.darker(skin, neckline))
        phones = polygon(SIZE, [tuple(point(xy)) for xy in spec['neckPhones']])
        head_mask = ImageChops.subtract(head_mask, ImageChops.subtract(phones, skin))
    selected = ImageChops.darker(remaining, head_mask)
    head = register.copy()
    head.putalpha(selected)
    images['head'] = canonical(head)
    moving.alpha_composite(head)
    remaining = ImageChops.subtract(remaining, selected)
    body = register.copy()
    body.putalpha(remaining)
    if 'foundation' in spec:
        foundation = costume_foundation(images['hair-back'], spec)
        if np.count_nonzero(np.array(foundation.getchannel('A'))) > 20:
            images['body-under-hair'] = foundation
    if spec.get('hairUnderlap'):
        images['hair-back'] = hair_underlap(images['hair-back'], register, spec, point, definitions)
    body = canonical(body)
    if 'neckUnderlap' in spec:
        neck = polygon(SIZE, [tuple(point(xy)) for xy in spec['neckUnderlap']])
        if 'neckSkin' in spec:
            neck = ImageChops.lighter(neck, polygon(SIZE, [tuple(point(xy)) for xy in spec['neckSkin']]))
        body = neck_underlap(body, register, head, neck)
    images['body'] = underlap(body, moving)
    prefix = f'choreography/code/{key}'
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
    if 'body-under-hair' in images:
        layers.insert(0, {'id': 'body-under-hair', 'file': f'{prefix}/body-under-hair.png',
            'parent': 'body', 'pivot': [128, 368], 'motion': 'body', 'amplitudeDegrees': 0})
    definition = {'name': f'CODE {key}', 'roleHint': 'code',
        'registration': {'kind': 'uniform', 'source': f'choreography-v1/{spec["source"]}',
                         'componentBounds': component['bounds'], 'scaleX': scale, 'scaleY': scale,
                         'offsetX': dx, 'offsetY': dy, 'sourceFeet': feet, 'targetFeet': 368},
        'layers': layers,
        'face': {'file': 'choreography/code/facial.png', 'frameHeight': 384, 'frames': FACES},
        'motion': {'breathSeconds': 4.6, 'gestureSeconds': 4, 'gestureIntervalSeconds': [8, 15]}}
    folder = HERE/key
    folder.mkdir(parents=True, exist_ok=True)
    for name, image in images.items():
        assert image.getchannel('A').getbbox(), (key, name, 'empty cutout')
        if name == 'body-under-hair':
            assert np.count_nonzero(np.array(image.getchannel('A'))) > 20, (key, 'unnecessary tiny foundation')
        image.save(folder/f'{name}.png', optimize=True)
    # Remove only obsolete foundations produced by this exporter.
    stale_foundation = folder/'body-under-hair.png'
    if 'body-under-hair' not in images and stale_foundation.exists():
        stale_foundation.unlink()
    composed = compose(images, definition)
    assert np.array_equal(np.array(composed), np.array(register)), (key, 'rest composition changed')
    for witness in spec.get('ownershipWitnesses', []):
        xy = tuple(witness['point'])
        assert images[witness['layer']].getpixel(xy) == tuple(witness['rgba']), (key, xy, 'source ownership changed')
        for excluded in witness.get('exclude', []):
            assert images[excluded].getpixel(xy)[3] == 0, (key, xy, excluded, 'retained transferred fragment')
    QA.mkdir(parents=True, exist_ok=True)
    composed.save(QA/f'{key}-transparent.png')
    for theme, color in [('light', '#f7f3ed'), ('dark', '#17202f')]:
        preview = Image.new('RGBA', SIZE, color)
        preview.alpha_composite(composed)
        preview.resize((512, 768), Image.Resampling.NEAREST).convert('RGB').save(QA/f'{key}-{theme}.png')
    return definition, {'key': key, 'neutralizedContourPixels': neutralized,
                        'layers': len(layers), 'restCompositionIdentical': True,
                        'nativeBounds': composed.getchannel('A').getbbox(),
                        'foundationPixels': int(np.count_nonzero(np.array(images['body-under-hair'].getchannel('A')))) if 'body-under-hair' in images else 0,
                        'foundationBounds': images['body-under-hair'].getchannel('A').getbbox() if 'body-under-hair' in images else None}


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
    for name in {spec['foundation']['source'] for spec in specs.values() if 'foundation' in spec}:
        hashes[name] = sha256((SOURCES/name).read_bytes()).hexdigest()
    manifest = {'version': 1, 'canvas': {'width': 256, 'height': 384},
                'coordinates': 'top-left', 'feetBaseline': 368, 'characters': {}}
    report = []
    for key, spec in specs.items():
        definition, result = export_pose(key, spec, sources, manifest['characters'])
        manifest['characters'][f'code/{key}'] = definition
        report.append(result)
    Image.new('RGBA', (256, 384*18)).save(HERE/'facial.png', optimize=True)
    manifest['runtimeFiles'] = sorted({layer['file'] for d in manifest['characters'].values() for layer in d['layers']} | {'choreography/code/facial.png'})
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
    print(f'PASS {len(report)} CODE layered poses, exact rest composition, uniform registration; QA {QA}')


if __name__ == '__main__':
    main()
