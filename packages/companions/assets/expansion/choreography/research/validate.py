"""Validate cutout registration and exact neutral assembly without editing assets."""
from pathlib import Path
import json
import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
EXPANSION = HERE.parent.parent
ROOT = EXPANSION.parents[3]
POSES = ['work-three-quarter','work-profile','work-back-three-quarter','work-seated',
         'dance-1','dance-2','dance-3','dance-4','work-right-three-quarter',
         'work-right-profile','work-back','walk-left','walk-right','work-kneeling',
         'work-leaning','work-desk']


def main():
    manifest = json.loads((HERE/'manifest.json').read_text())
    specs = json.loads((HERE/'spec.json').read_text())
    assert manifest['version'] == 1
    assert manifest['canvas'] == {'width':256,'height':384}
    assert manifest['feetBaseline'] == 368
    assert set(manifest['characters']) == {f'research/{pose}' for pose in POSES}
    assert not any(spec.get('flip') for spec in specs.values())
    for key,rig in manifest['characters'].items():
        ids = [layer['id'] for layer in rig['layers']]
        assert len(ids) == len(set(ids)) and 'body' in ids and 'head' in ids
        assert any(layer['motion'] == 'arm' for layer in rig['layers'])
        register = rig['registration']
        assert register['scaleX'] == register['scaleY'] and register['targetFeet'] == 368
        assert not register['flipped']
        composed = Image.new('RGBA',(256,384))
        for layer in rig['layers']:
            image = Image.open(EXPANSION/layer['file'])
            assert image.mode == 'RGBA' and image.size == (256,384) and image.getbbox()
            assert len(layer['pivot']) == 2
            assert 0 <= layer['pivot'][0] <= 256 and 0 <= layer['pivot'][1] <= 384
            assert 0 <= layer['amplitudeDegrees'] <= 3
            box = image.getbbox()
            assert box[0] > 0 and box[1] > 0 and box[2] < 256 and box[3] < 384
            composed.alpha_composite(image)
        reference = Image.open(ROOT/f".local/choreography-qa/research/{key.split('/')[1]}-registered.png")
        assert np.array_equal(np.array(composed),np.array(reference)),key
        assert composed.getbbox()[3] in [368,369]
        face = Image.open(EXPANSION/rig['face']['file'])
        assert face.size == (256,384*18) and face.mode == 'RGBA' and face.getbbox() is None
        assert len(rig['face']['frames']) == 18 and rig['face']['neutralOnly']
    assert len(manifest['runtimeFiles']) == len(set(manifest['runtimeFiles']))
    assert all((EXPANSION/path).is_file() for path in manifest['runtimeFiles'])
    # Measured source landmarks reproduce the garment/hair ownership regressions.
    for sample in json.loads((HERE/'ownership.json').read_text())['samples']:
        rig = manifest['characters'][f"research/{sample['pose']}"]
        layers = {layer['id']:Image.open(EXPANSION/layer['file']) for layer in rig['layers']}
        point = tuple(sample['point'])
        assert layers[sample['owner']].getpixel(point)[3] >= 250, sample
        assert all(layers[name].getpixel(point)[3] == 0 for name in sample['exclude']), sample
    print('PASS: 16 measured rigs; exact neutral assembly; alpha, scale, baseline, joints, layers and shared facial atlas.')

if __name__ == '__main__': main()
