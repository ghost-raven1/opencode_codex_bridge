"""Render all core outfit/head pairs with the native mixed-layer ordering."""
import json
from itertools import permutations

import numpy as np
from PIL import Image, ImageDraw

from prepare import HERE, EXPANSION, QA, SIZE, canonical
from validate import transform


def mixed_frame(body, head, phase=None):
    """Align measured neck anchors while retaining the chosen outfit's foundation."""
    body_anchor = next(layer['pivot'] for layer in body['layers'] if layer['id'] == 'head')
    head_anchor = next(layer['pivot'] for layer in head['layers'] if layer['id'] == 'head')
    dx, dy = [body_anchor[index]-head_anchor[index] for index in range(2)]
    incoming = [layer for layer in head['layers'] if layer['motion'] == 'head' or layer['parent'] == 'head']
    outfit = [layer for layer in body['layers'] if layer['motion'] != 'head' and layer['parent'] != 'head']
    entries = [(layer, True) for layer in incoming if layer['id'] == 'hair-back']
    entries += [(layer, False) for layer in outfit]
    entries += [(layer, True) for layer in incoming if layer['id'] != 'hair-back']
    frame = Image.new('RGBA', SIZE)
    head_joint = next(layer for layer in head['layers'] if layer['id'] == 'head')
    for layer, translated in entries:
        image = Image.open(EXPANSION/layer['file']).convert('RGBA')
        if phase is not None:
            image = transform(image, layer, phase)
            if translated and layer['parent'] == 'head':
                image = transform(image, head_joint, phase)
        if translated:
            image = image.transform(SIZE, Image.Transform.AFFINE,
                (1, 0, -dx, 0, 1, -dy), Image.Resampling.BICUBIC)
        frame.alpha_composite(image)
    return canonical(frame)


def bounded_contacts(manifests, poses, out):
    """Capture CODE in both directions with every other core role at eight joint extremes."""
    count = 0
    for body_role, head_role in permutations(manifests, 2):
        if 'code' not in (body_role, head_role):
            continue
        for page in range(4):
            boards = {theme: Image.new('RGB', (768, 432), color) for theme, color in [('light', '#f7f3ed'), ('dark', '#17202f')]}
            for row, pose in enumerate(poses[page*4:page*4+4]):
                body = manifests[body_role]['characters'][f'{body_role}/{pose}']
                head = manifests[head_role]['characters'][f'{head_role}/{pose}']
                anchor = next(layer['pivot'] for layer in body['layers'] if layer['id'] == 'head')
                box = (round(anchor[0])-48, round(anchor[1])-65, round(anchor[0])+48, round(anchor[1])+31)
                for column in range(8):
                    frame = mixed_frame(body, head, column/8*2*np.pi).crop(box)
                    for theme, board in boards.items():
                        board.paste(frame, (column*96, row*108), frame)
                        ink = '#222' if theme == 'light' else '#eee'
                        ImageDraw.Draw(board).text((column*96+2, row*108+97), f'{pose[:9]} {column}', fill=ink)
                    count += 1
            for theme, board in boards.items():
                board.save(out/f'{body_role}-body-{head_role}-head-bounded-{page}-{theme}.png')
    return count


def main():
    """Export read-only light/dark contacts and preserve original neutral comparisons."""
    roles = ['lead', 'code', 'research', 'review']
    manifests = {role: json.loads((EXPANSION/f'choreography/{role}/manifest.json').read_text()) for role in roles}
    poses = [key.split('/')[1] for key in manifests['code']['characters']]
    out = QA/'mixed-final'
    out.mkdir(parents=True, exist_ok=True)
    results = []
    for body_role, head_role in permutations(roles, 2):
        frames = []
        for pose in poses:
            body = manifests[body_role]['characters'][f'{body_role}/{pose}']
            head = manifests[head_role]['characters'][f'{head_role}/{pose}']
            frame = mixed_frame(body, head)
            assert frame.getchannel('A').getbbox(), (body_role, head_role, pose)
            frames.append(frame)
        for theme, color, ink in [('light', '#f7f3ed', '#222'), ('dark', '#17202f', '#eee')]:
            board = Image.new('RGB', (1024, 1648), color)
            draw = ImageDraw.Draw(board)
            for index, (pose, frame) in enumerate(zip(poses, frames)):
                x, y = index%4*256, index//4*412
                board.paste(frame, (x, y), frame)
                draw.text((x+8, y+389), pose, fill=ink)
            board.save(out/f'{body_role}-body-{head_role}-head-{theme}.png')
        results.append({'outfit': body_role, 'head': head_role, 'poses': len(frames)})
    unchanged = []
    before = QA/'mixed-mask-audit'
    for pose in poses:
        original = np.array(Image.open(before/f'code-{pose}-neutral-before.png').convert('RGBA'))
        final = np.array(Image.open(QA/f'{pose}-transparent.png').convert('RGBA'))
        assert np.array_equal(original, final), (pose, 'authored neutral drawing changed')
        unchanged.append(pose)
    bounded = bounded_contacts(manifests, poses, out)
    (out/'report.json').write_text(json.dumps({'corePairs': results, 'neutralRGBAExact': unchanged,
        'renderedMixedFrames': 192, 'boundedMixedSamples': bounded, 'jointTranslationLimit': .75,
        'nativeRuntimeVerified': False}, indent=2)+'\n')
    print(f'PASS 12 core pairs / 192 mixed frames / {bounded} bounded samples; all 16 CODE neutrals byte-identical in RGBA. QA {out}')


if __name__ == '__main__':
    main()
