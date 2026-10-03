"""Validate CODE rig resources and produce bounded layer-motion QA previews."""
import json
import math

import numpy as np
from PIL import Image, ImageDraw
from prepare import HERE, EXPANSION, QA, SIZE, FACES, compose, canonical


def transform(image, layer, phase):
    """Rotate each authored cutout around its measured joint, inside its safe limit."""
    angle = math.sin(phase)*layer['amplitudeDegrees']
    radians = math.radians(angle)
    c, s = math.cos(radians), math.sin(radians)
    x, y = layer['pivot']
    tx = .75*math.sin(phase) if layer['motion'] in ('head', 'arm') else 0
    ty = .75*math.cos(phase) if layer['motion'] in ('head', 'arm') else 0
    # PIL inverse affine, in top-left coordinates. A head child follows the
    # same head transform below, matching the existing LayeredRig hierarchy.
    return canonical(image.transform(SIZE, Image.Transform.AFFINE,
        (c, s, x-c*x-s*y-c*tx-s*ty, -s, c, y+s*x-c*y+s*tx-c*ty), Image.Resampling.BICUBIC))


def draw_motion(definition, images, phase):
    head = next(layer for layer in definition['layers'] if layer['id'] == 'head')
    frame = Image.new('RGBA', SIZE)
    for layer in definition['layers']:
        image = transform(images[layer['id']], layer, phase)
        if layer['parent'] == 'head': image = transform(image, head, phase)
        frame.alpha_composite(image)
    return canonical(frame)


def validate_walk(manifest):
    """Keep paired gait phases aligned while requiring real changes to the legs."""
    role = HERE.name
    definitions = [manifest['characters'][f'{role}/{name}'] for name in ('walk-left', 'walk-right')]
    frames = [Image.open(QA/f'{name}-transparent.png').convert('RGBA') for name in ('walk-left', 'walk-right')]
    bounds = [frame.getchannel('A').getbbox() for frame in frames]
    heads = [next(layer['pivot'] for layer in definition['layers'] if layer['id'] == 'head') for definition in definitions]
    scales = [definition['registration']['scaleX'] for definition in definitions]
    assert scales[0] == scales[1], 'walking phases must preserve the same physical scale'
    assert abs(heads[0][0]-heads[1][0]) < 0.01, 'walking phases must share their neck axis'
    assert abs(heads[0][1]-heads[1][1]) <= 4, 'walking phases must not jump vertically'
    assert abs(bounds[0][1]-bounds[1][1]) <= 4, 'walking silhouettes must retain adult height'
    arrays = [np.array(frame) for frame in frames]
    leg_difference = int(np.count_nonzero(arrays[0][210:, :, 3] != arrays[1][210:, :, 3]))
    assert leg_difference > 2500, 'walking phases must change actual drawn legs'
    for theme, color, ink in (('light', '#f7f3ed', '#222222'), ('dark', '#17202f', '#eee8e0')):
        board = Image.new('RGBA', (512, 408), color)
        draw = ImageDraw.Draw(board)
        for column, frame in enumerate(frames):
            board.alpha_composite(frame, (column*256, 0))
            draw.text((column*256+8, 387), ('wide stride', 'passing knee')[column], fill=ink)
        board.convert('RGB').save(QA/f'walk-pair-{theme}.png')
    motion = []
    for frame in frames:
        bg = Image.new('RGBA', SIZE, '#f7f3ed')
        bg.alpha_composite(frame)
        motion.append(bg.convert('RGB'))
    motion[0].save(QA/'walk-authored.gif', save_all=True, append_images=motion[1:], duration=600, loop=0)
    return {'sameScale': scales[0], 'headPivots': heads, 'bounds': bounds,
        'headTopDelta': abs(bounds[0][1]-bounds[1][1]), 'drawnLegAlphaDifference': leg_difference}


def validate_mixed_neck(manifest):
    """Wardrobe stays with the outfit even when another role's narrower head is used."""
    definition = manifest['characters']['code/dance-4']
    images = {layer['id']: Image.open(EXPANSION/layer['file']).convert('RGBA') for layer in definition['layers']}
    points = [(124, 201), (159, 201)]
    for xy in points:
        assert images['body'].getpixel(xy)[3] == 255, (xy, 'hoodie/neck underlap disappeared')
        assert images['head'].getpixel(xy)[3] == 0, (xy, 'hoodie assigned to transferable head')
    return {'nativeGarmentPoints': points, 'bodyAlpha': 255, 'headAlpha': 0}


def validate_foundations(manifest):
    """Keep the costume beneath original hair and preserve the repaired back-waist seam."""
    count = 0
    for key, definition in manifest['characters'].items():
        layers = definition['layers']
        foundation = next((layer for layer in layers if layer['id'] == 'body-under-hair'), None)
        if foundation is None:
            continue
        assert layers[0]['id'] == 'body-under-hair', (key, 'foundation must remain beneath own hair')
        assert foundation['motion'] == 'body' and foundation['parent'] == 'body', key
        patch = np.array(Image.open(EXPANSION/foundation['file']).convert('RGBA'))
        hair = np.array(Image.open(EXPANSION/next(layer['file'] for layer in layers if layer['id'] == 'hair-back')).convert('RGBA'))
        assert np.count_nonzero(patch[:, :, 3]) > 20, key
        assert np.all(hair[:, :, 3][patch[:, :, 3] > 0] == 255), (key, 'foundation outside opaque hair')
        assert np.all(patch[:, :, :3][patch[:, :, 3] == 0] == 0), key
        count += 1
    back = Image.open(HERE/'work-back/body-under-hair.png').convert('RGBA')
    for xy in [(125, 182), (127, 180)]:
        assert back.getpixel(xy)[3] == 255, (xy, 'back waist garment gap returned')
    hair = Image.open(HERE/'work-back-three-quarter/hair-back.png').convert('RGBA')
    body = Image.open(HERE/'work-back-three-quarter/body.png').convert('RGBA')
    assert hair.getpixel((82, 176))[3] == 255 and body.getpixel((82, 176))[3] == 0, 'ponytail tip returned to wardrobe'
    return {'layers': count, 'backWaistPoints': [[125, 182], [127, 180]], 'hairOwnershipPoint': [82, 176]}


def main():
    manifest = json.loads((HERE/'manifest.json').read_text())
    assert manifest['version'] == 1 and manifest['canvas'] == {'width': 256, 'height': 384}
    assert len(manifest['characters']) == 16
    assert manifest['feetBaseline'] == 368
    face = Image.open(HERE/'facial.png').convert('RGBA')
    assert face.size == (256, 384*18) and face.getchannel('A').getbbox() is None
    report = []
    for key, definition in manifest['characters'].items():
        images = {}
        ids = {layer['id'] for layer in definition['layers']}
        assert {'body', 'head', 'arm-left', 'arm-right'} <= ids, key
        assert len(ids) == len(definition['layers']), key
        for layer in definition['layers']:
            image = Image.open(EXPANSION/layer['file']).convert('RGBA')
            assert image.size == SIZE and image.getchannel('A').getbbox(), (key, layer['id'])
            assert 0 <= layer['pivot'][0] <= 256 and 0 <= layer['pivot'][1] <= 384
            assert 0 <= layer['amplitudeDegrees'] <= 1
            images[layer['id']] = image
        registration = definition['registration']
        assert registration['scaleX'] == registration['scaleY'], key
        assert abs(registration['sourceFeet']*registration['scaleY']+registration['offsetY']-368) < 1e-8
        assert definition['face']['frames'] == FACES and definition['face']['frameHeight'] == 384
        combined = compose(images, definition)
        expected = Image.open(QA/f'{key.split("/")[1]}-transparent.png').convert('RGBA')
        assert np.array_equal(np.array(combined), np.array(expected)), key
        bounds = combined.getchannel('A').getbbox()
        assert bounds[0] > 0 and bounds[1] > 0 and bounds[2] < 256 and bounds[3] < 384, (key, bounds)
        assert np.count_nonzero(np.array(images['body'].getchannel('A'))) < np.count_nonzero(np.array(combined.getchannel('A'))), key
        frames = []
        for index in range(24):
            foreground = draw_motion(definition, images, index/24*2*math.pi)
            bg = Image.new('RGBA', SIZE, '#17202f')
            bg.alpha_composite(foreground)
            frames.append(bg.convert('RGB'))
        name = key.split('/')[1]
        frames[0].save(QA/f'{name}-micro.gif', save_all=True, append_images=frames[1:], duration=85, loop=0)
        layers = Image.new('RGBA', (256*len(images), 384), '#f7f3ed')
        draw = ImageDraw.Draw(layers)
        for column, (part, image) in enumerate(images.items()):
            layers.alpha_composite(image, (column*256, 0))
            draw.text((column*256+8, 8), part, fill='#222222')
        layers.convert('RGB').save(QA/f'{name}-layers.png')
        report.append({'key': key, 'layerCount': len(images), 'bounds': bounds, 'boundedMotionFrames': 24})
    dance = []
    for index in range(4):
        definition = manifest['characters'][f'code/dance-{index+1}']
        images = {layer['id']: Image.open(EXPANSION/layer['file']).convert('RGBA') for layer in definition['layers']}
        for frame in range(16):
            bg = Image.new('RGBA', SIZE, '#f7f3ed')
            bg.alpha_composite(draw_motion(definition, images, frame/16*2*math.pi))
            dance.append(bg.convert('RGB'))
    dance[0].save(QA/'dance-authored.gif', save_all=True, append_images=dance[1:], duration=65, loop=0)
    walking = validate_walk(manifest)
    neck = validate_mixed_neck(manifest)
    foundations = validate_foundations(manifest)
    (QA/'validation.json').write_text(json.dumps({'passed': True, 'poses': report, 'walking': walking, 'mixedNeck': neck,
        'boundedTranslationPixels': .75,
        'foundations': foundations,
        'runtimeFiles': len(manifest['runtimeFiles']), 'emptySharedFace': True,
        'nativeRuntimeVerified': False}, indent=2)+'\n')
    print(f'PASS 16 CODE cutout rigs, {len(manifest["runtimeFiles"])} resources, 384 bounded motion frames; native integration remains parent task')


if __name__ == '__main__': main()
