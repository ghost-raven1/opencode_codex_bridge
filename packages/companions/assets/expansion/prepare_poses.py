"""Prepare fourteen independently articulated, uniformly registered companion poses."""
from pathlib import Path
import argparse
import json
import math
import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter
from pose_specs import SPECS

HERE = Path(__file__).resolve().parent
SIZE = (256, 384)


def canonical(image, source_key=None):
    """Remove transparent RGB noise and the one independently confirmed detached fleck."""
    pixels = np.array(image.convert('RGBA'))
    pixels[pixels[:, :, 3] < 8] = 0
    if source_key == 'devops/reclining':
        # This disconnected grey-white component is above/right of the boot.
        # It is present in the saved ImageGen original, which remains immutable.
        pixels[973:1007, 1190:1236] = 0
    return Image.fromarray(pixels)


def polygon_mask(size, polygons):
    result = Image.new('L', size)
    for points in polygons:
        ImageDraw.Draw(result).polygon(points, fill=255)
    return result


def affine(image, size, scale, dx, dy):
    return canonical(image.transform(size, Image.Transform.AFFINE,
        (1/scale, 0, -dx/scale, 0, 1/scale, -dy/scale), Image.Resampling.BICUBIC))


def joint_underlap(body, head, joint_region=None, depth=4):
    """Extend authored joint-edge pixels behind the head, never its visible outline."""
    source = np.array(body); result = source.copy(); occlusion = np.array(head)[:,:,3]
    if joint_region is not None: occlusion = np.minimum(occlusion, np.array(joint_region))
    # Looking downward samples neck/own clothing, not pixels from the cut head.
    # The overlap is confined to the existing head silhouette and four native
    # pixels, enough for the bounded translation/rotation tested by native QA.
    for distance in range(1, depth+1):
        donor = np.zeros_like(source); donor[:-distance] = source[distance:]
        needed = (result[:,:,3] < 245) & (occlusion > 16) & (donor[:,:,3] >= 245)
        result[needed] = donor[needed]
    return canonical(Image.fromarray(result))


def facial_atlas(role, rig, spec, point, head, face_registration):
    """Register expression patches, preserving the pose's neutral facial drawing."""
    old = face_registration[role][0]['targetAnchors']
    target = [point(xy) for xy in [*spec['eyes'], spec['mouth']]]
    # Only authored expression patches use this landmark map. The head, hair,
    # body and their silhouette remain the uniformly registered pose drawing.
    inverse = np.linalg.solve(np.array([[*xy, 1] for xy in target]), np.array(old))
    matrix = tuple(inverse[:, 0])+tuple(inverse[:, 1])
    faces = Image.open(HERE/rig['face']['file']).convert('RGBA')
    atlas = Image.new('RGBA', (SIZE[0], SIZE[1]*18))
    for row in range(18):
        frame = canonical(faces.crop((0, row*384, 256, (row+1)*384)).transform(
            SIZE, Image.Transform.AFFINE, matrix, Image.Resampling.BICUBIC))
        frame.putalpha(ImageChops.darker(frame.getchannel('A'), head.getchannel('A')))
        if row in [0, 8]:
            native = head.copy(); native.putalpha(frame.getchannel('A')); frame = native
        atlas.paste(canonical(frame), (0, row*384))
    return atlas, target


def compose(definition):
    image = Image.new('RGBA', SIZE)
    for layer in definition['layers']:
        image.alpha_composite(Image.open(HERE/layer['file']).convert('RGBA'))
    return image


def prepare(key, standing, face_registration):
    role, pose = key.split('/')
    spec = SPECS[key]
    source_name = spec.get('source', f'{role}-{pose}.png')
    original = canonical(Image.open(HERE/'source/poses'/source_name), key)
    rig = standing['characters'][role]
    old_eyes = face_registration[role][0]['targetAnchors'][:2]
    bounds = original.getchannel('A').getbbox()
    eye_scale = math.dist(*old_eyes)/math.dist(*spec['eyes'])
    # Preserve physical head size; only a narrow motion margin may cap it.
    scale = min(eye_scale, 244/(bounds[2]-bounds[0]))
    dx = 128-(bounds[0]+bounds[2]-1)/2*scale
    dy = 368-(bounds[3]-1)*scale
    register = lambda image: affine(image, SIZE, scale, dx, dy)
    point = lambda xy: [round(xy[0]*scale+dx, 3), round(xy[1]*scale+dy, 3)]
    neck = point(spec['neck'])
    folder = HERE/'poses'/role/pose
    folder.mkdir(parents=True, exist_ok=True)
    prefix = f'poses/{role}/{pose}'
    remaining = original.getchannel('A')
    removed = Image.new('L', original.size)
    exported = {}
    # Select fingers before the prop so shared pixels remain with the moving hand.
    for name, part in spec['parts'].items():
        region = polygon_mask(original.size, part['polygons'])
        if part.get('margin'): region = region.filter(ImageFilter.MaxFilter(1+part['margin']*2))
        selected = ImageChops.darker(remaining, region)
        layer = original.copy(); layer.putalpha(selected)
        exported[name] = register(layer)
        remaining = ImageChops.subtract(remaining, selected)
        if part.get('repair', True): removed = ImageChops.lighter(removed, selected)
    head_region = polygon_mask(original.size, [spec['head'], *spec.get('headExtra',[])])
    if spec.get('hairEdges'):
        # Preserve the authored hair colors at measured shoulder-edge cutouts;
        # these residual strands belong to the head, not the clothing donor.
        rgb = np.array(original)[:,:,:3].astype(float); red, green, blue = rgb.transpose(2,0,1)
        colors = ((green > red*1.12) & (blue > red*1.07) & (green > 55)) if role == 'research' else (
            (red-green > 7) & (blue-red > 2) & (red > 65))
        regions = Image.new('L',original.size); draw = ImageDraw.Draw(regions)
        for box in spec['hairEdges']: draw.rectangle(box,fill=255)
        hairs = Image.fromarray((colors*255).astype('uint8'))
        hairs = ImageChops.darker(hairs,regions).filter(ImageFilter.MaxFilter(3))
        head_region = ImageChops.lighter(head_region,hairs)
    head_mask = ImageChops.darker(remaining, head_region)
    head = original.copy(); head.putalpha(head_mask)
    for repair in spec.get('headRepairs',[]):
        patch = canonical(Image.open(HERE/'source/poses'/repair['source']))
        region = ImageChops.darker(head_region, polygon_mask(original.size,[repair['polygon']]))
        # Replace, rather than alpha-composite, so an authored transparent gap
        # clears old fingers as well as filling the headphone beneath them.
        replacement = patch.copy(); replacement.putalpha(ImageChops.darker(patch.getchannel('A'),region))
        head.putalpha(ImageChops.subtract(head.getchannel('A'),region)); head.alpha_composite(replacement)
    remaining = ImageChops.subtract(remaining, head_mask)
    body = original.copy(); body.putalpha(remaining)
    # The new hidden clothing is authored by ImageGen. It only fills pixels
    # originally occluded by movable hands/props, never redraws visible anatomy.
    backing = canonical(Image.open(HERE/'source/poses'/spec.get('backingSource',f'{role}-backing.png')))
    width = backing.width//2
    backing = backing.crop((0 if pose == 'seated' else width, 0,
                            width if pose == 'seated' else backing.width, backing.height))
    backing = affine(backing, original.size, *spec['backing'])
    backing.putalpha(ImageChops.darker(backing.getchannel('A'), removed))
    backing.alpha_composite(body)
    if spec.get('neckPlate'):
        plate = spec['neckPlate']
        patch = canonical(Image.open(HERE/'source/poses'/plate['source']))
        region = ImageChops.darker(head_mask,polygon_mask(original.size,[plate['polygon']]))
        # Exact-source edits avoid importing another pose's hair into the neck.
        patch.putalpha(ImageChops.darker(patch.getchannel('A'),region))
        backing.alpha_composite(patch)
    exported['body'] = register(backing)
    exported['head'] = register(head)
    joint_region = None
    if spec.get('jointBounds'):
        box = spec['jointBounds']; joint_region = Image.new('L',SIZE)
        ImageDraw.Draw(joint_region).rectangle([*point(box[:2]),*point(box[2:])],fill=255)
    exported['body'] = joint_underlap(exported['body'], exported['head'], joint_region)
    layers = [{'id':'body','file':f'{prefix}/body.png','parent':None,'pivot':[128,368],
               'motion':'body','amplitudeDegrees':0}]
    for name in ['prop', *[name for name in spec['parts'] if name != 'prop']]:
        if name not in spec['parts']: continue
        part = spec['parts'][name]
        layer = {'id':name,'file':f'{prefix}/{name}.png','parent':part.get('parent','body'),
                 'pivot':point(part['pivot']),'motion':part.get('motion','prop' if name == 'prop' else 'arm'),
                 'amplitudeDegrees':part.get('amplitude', 0.7 if name == 'prop' else 1.2)}
        if name == 'hair-back': layers.insert(0, layer)
        else: layers.append(layer)
    layers.append({'id':'head','file':f'{prefix}/head.png','parent':'body','pivot':neck,
                   'motion':'head','amplitudeDegrees':1.1})
    foreground = [layer for layer in layers if spec['parts'].get(layer['id'],{}).get('foreground')]
    layers = [layer for layer in layers if layer not in foreground]+foreground
    for name, image in exported.items():
        canonical(image).save(folder/f'{name}.png', optimize=True)
    atlas, anchors = facial_atlas(role, rig, spec, point, exported['head'], face_registration)
    atlas.save(folder/'facial.png', optimize=True)
    definition = {'name':f'{role.upper()} {pose}', 'roleHint':rig['roleHint'],
        'registration':{'kind':'uniform','source':f'poses/{source_name}',
                        'scaleX':scale,'scaleY':scale,'offsetX':dx,'offsetY':dy,
                        'sourceFeet':bounds[3]-1,'targetFeet':368,
                        'facialSource':rig['face']['file'],'facialAnchors':anchors,
                        'eyeScale':eye_scale,'backingSource':spec.get('backingSource',f'{role}-backing.png')},
        'layers':layers,'face':{'file':f'{prefix}/facial.png','frameHeight':384,'frames':rig['face']['frames']},
        'motion':{'breathSeconds':5.1 if pose == 'reclining' else 4.7,
                  'gestureSeconds':4.4,'gestureIntervalSeconds':[8,15]}}
    image = compose(definition)
    qa_folder = HERE.parents[3]/'.local/pose-artwork-qa/rigs'/role/pose
    qa_folder.mkdir(parents=True, exist_ok=True)
    for theme, color in [('light','#f7f3ed'),('dark','#17202f')]:
        preview = Image.new('RGBA', SIZE, color); preview.alpha_composite(image)
        preview.resize((512,768), Image.Resampling.NEAREST).convert('RGB').save(qa_folder/f'qa-{theme}.png')
    return definition


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--role', action='append')
    args = parser.parse_args()
    standing = json.loads((HERE/'manifest.json').read_text())
    face_registration = json.loads((HERE/'face-registration.json').read_text())
    path = HERE/'poses.json'
    manifest = json.loads(path.read_text()) if path.exists() else {
        'version':1,'canvas':{'width':256,'height':384},'coordinates':'top-left',
        'feetBaseline':368,'characters':{}}
    for key in SPECS:
        if args.role and key.split('/')[0] not in args.role: continue
        manifest['characters'][key] = prepare(key, standing, face_registration)
    manifest['runtimeFiles'] = [layer['file'] for rig in manifest['characters'].values() for layer in rig['layers']]
    manifest['runtimeFiles'] += [rig['face']['file'] for rig in manifest['characters'].values()]
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n')


if __name__ == '__main__': main()
