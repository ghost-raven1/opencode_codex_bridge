"""Export measured RESEARCH cutouts; --pose limits a repair to one rig."""
from pathlib import Path
import argparse
import json
import math
import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
EXPANSION = HERE.parent.parent
ROOT = EXPANSION.parents[3]
SOURCE = EXPANSION / 'source/choreography-v1'
QA = ROOT / '.local/choreography-qa/research'
SIZE = (256, 384)
FRAMES = ['close','slightly-open','A','O','E','I','U','smile-speaking',
          'open','quarter','half','three-quarter','closed','reopen',
          'smile','concern','focus','surprise']


def canonical(image):
    """Canonicalize invisible RGB and nearly opaque interior alpha for cutout seams."""
    pixels = np.array(image.convert('RGBA'))
    pixels[pixels[:,:,3] < 8] = 0
    pixels[pixels[:,:,3] >= 250,3] = 255
    return Image.fromarray(pixels)


def clean(image):
    """Clear confirmed saturated matte flecks while protecting opaque interior art."""
    pixels = np.array(image.convert('RGBA'))
    r,g,b = pixels[:,:,:3].astype(int).transpose(2,0,1)
    alpha = pixels[:,:,3]
    extreme = ((r > 210)&(g < 75)&(b < 85)) | ((r < 100)&(g > 225)&(b < 115)) | ((r > 210)&(g > 210)&(b < 85))
    interior = np.array(Image.fromarray(alpha).filter(ImageFilter.MinFilter(5))) >= 200
    noise = extreme & ~interior & (alpha > 0)
    pixels[noise] = 0
    return canonical(Image.fromarray(pixels)), int(noise.sum())


def head_component(alpha):
    """Keep one connected head; detached arm/page flecks remain in the body."""
    pending = np.array(alpha) > 24
    h,w = pending.shape
    largest = []
    for yy,xx in np.argwhere(pending):
        if not pending[yy,xx]: continue
        queue = [(int(xx),int(yy))]; pending[yy,xx] = False
        component = []
        while queue:
            x,y = queue.pop(); component.append((x,y))
            for dx,dy in [(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)]:
                nx,ny = x+dx,y+dy
                if 0 <= nx < w and 0 <= ny < h and pending[ny,nx]:
                    pending[ny,nx] = False; queue.append((nx,ny))
        if len(component) > len(largest): largest = component
    keep = np.zeros_like(pending,dtype=np.uint8)
    for x,y in largest: keep[y,x] = 255
    return ImageChops.darker(alpha,Image.fromarray(keep).filter(ImageFilter.MaxFilter(3)))


def polygon_mask(polygons):
    mask = Image.new('L', SIZE)
    draw = ImageDraw.Draw(mask)
    for polygon in polygons: draw.polygon(polygon, fill=255)
    return mask


def register(source, spec):
    image = source.crop(spec['crop'])
    if spec.get('clearTop'): ImageDraw.Draw(image).rectangle(spec['clearTop'],fill=(0,0,0,0))
    if spec.get('flip'): image = image.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    bounds = image.getchannel('A').getbbox()
    scale = min(spec.get('nominalScale',.62), 232 / (bounds[2]-bounds[0]), 346 / (bounds[3]-bounds[1]))
    dx = 128 - (bounds[0]+bounds[2]-1)/2 * scale
    dy = 368 - (bounds[3]-1)*scale
    image = canonical(image.transform(SIZE, Image.Transform.AFFINE,
        (1/scale,0,-dx/scale,0,1/scale,-dy/scale),Image.Resampling.BICUBIC))
    metadata = {'kind':'uniform','source':f"source/choreography-v1/{spec['source']}",
                'crop':spec['crop'],'flipped':spec.get('flip',False),
                'scaleX':scale,'scaleY':scale,'offsetX':dx,'offsetY':dy,
                'sourceFeet':bounds[3]-1,'targetFeet':368}
    return image, metadata


def overlap(body, occluded, depth=6):
    """Extend authored seam pixels a few pixels beneath the moving cutout only."""
    original = np.array(body); result = original.copy()
    cover = np.array(occluded) == 255
    for distance in range(1,depth+1):
        for dx,dy in [(distance,0),(-distance,0),(0,distance),(0,-distance)]:
            donor = np.roll(original,(dy,dx),(0,1))
            if dx > 0: donor[:,:dx] = 0
            if dx < 0: donor[:,dx:] = 0
            if dy > 0: donor[:dy] = 0
            if dy < 0: donor[dy:] = 0
            needed = cover & (result[:,:,3] < 240) & (donor[:,:,3] >= 240)
            result[needed] = donor[needed]
    return canonical(Image.fromarray(result))


def compose(layers, angles=None):
    canvas = Image.new('RGBA', SIZE)
    angles = angles or {}
    for layer,image in layers:
        angle = angles.get(layer['id'],0)
        if angle: image = canonical(image.rotate(-angle,Image.Resampling.BICUBIC,center=tuple(layer['pivot'])))
        canvas.alpha_composite(image)
    return canvas


def grid(image):
    out = image.copy(); draw = ImageDraw.Draw(out)
    for x in range(0,256,32):
        draw.line([(x,0),(x,384)],fill=(240,80,130,120)); draw.text((x+1,3),str(x),fill='red')
    for y in range(0,384,32):
        draw.line([(0,y),(256,y)],fill=(240,80,130,120)); draw.text((1,y+2),str(y),fill='red')
    return out


def main():
    specs = json.loads((HERE/'spec.json').read_text())
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pose', choices=list(specs), help='Export only this existing rig.')
    args = parser.parse_args()
    if args.pose:
        specs = {args.pose: specs[args.pose]}
    QA.mkdir(parents=True,exist_ok=True)
    sources = {}
    clean_counts = {}
    for source in {spec['source'] for spec in specs.values()}:
        image, count = clean(Image.open(SOURCE/source))
        if not args.pose: image.save(SOURCE/source.replace('.png','-clean.png'),optimize=True)
        sources[source] = image; clean_counts[source] = count
    if args.pose:
        manifest = json.loads((HERE/'manifest.json').read_text())
    else:
        Image.new('RGBA',(256,384*18)).save(HERE/'facial.png',optimize=True)
        manifest = {'version':1,'canvas':{'width':256,'height':384},'coordinates':'top-left',
                    'feetBaseline':368,'characters':{},'runtimeFiles':[]}
    previews = []
    reports = []
    for pose,spec in specs.items():
        image,registration = register(sources[spec['source']],spec)
        folder = HERE/pose; folder.mkdir(exist_ok=True)
        image.save(QA/f'{pose}-registered.png')
        grid(image).resize((512,768),Image.Resampling.NEAREST).save(QA/f'{pose}-grid.png')
        if 'head' not in spec:
            previews.append((pose,image)); continue
        alpha = image.getchannel('A'); remaining = alpha.copy()
        removed = Image.new('L',SIZE); exported = {}; layer_defs = []
        for name,part in spec.get('parts',{}).items():
            selected = ImageChops.darker(remaining,polygon_mask(part['polygons']))
            part_image = image.copy(); part_image.putalpha(selected)
            exported[name] = canonical(part_image)
            remaining = ImageChops.subtract(remaining,selected)
            removed = ImageChops.lighter(removed,selected)
        head_mask = head_component(ImageChops.darker(remaining,polygon_mask([spec['head']])))
        # Measured head additions preserve the chin edge and faint bob fringe.
        if spec.get('headIncludePolygons'):
            head_mask = ImageChops.lighter(head_mask,ImageChops.darker(remaining,
                polygon_mask(spec['headIncludePolygons'])))
        head = image.copy(); head.putalpha(head_mask)
        exported['head'] = canonical(head)
        remaining = ImageChops.subtract(remaining,head_mask)
        body = image.copy(); body.putalpha(remaining)
        covered = ImageChops.lighter(removed,head_mask)
        if spec.get('bodyOverlapExclude'):
            covered = ImageChops.subtract(covered,polygon_mask(spec['bodyOverlapExclude']))
        exported['body'] = overlap(canonical(body),covered)
        prefix = f'choreography/research/{pose}'
        layer_defs.append({'id':'body','file':f'{prefix}/body.png','parent':None,'pivot':[128,368],
                           'motion':'body','amplitudeDegrees':0})
        for name,part in spec.get('parts',{}).items():
            layer_defs.append({'id':name,'file':f'{prefix}/{name}.png','parent':part.get('parent','body'),
                              'pivot':part['pivot'],'motion':part.get('motion','arm'),
                              'amplitudeDegrees':part.get('amplitude',1.2)})
        layer_defs.append({'id':'head','file':f'{prefix}/head.png','parent':'body','pivot':spec['neck'],
                           'motion':'head','amplitudeDegrees':1.0})
        # All layers are exported at exactly the same affine registration.
        for name,img in exported.items(): img.save(folder/f'{name}.png',optimize=True)
        old_face = folder/'facial.png'
        if old_face.exists(): old_face.unlink()
        definition = {'name':f'RESEARCH {pose}','roleHint':'research','registration':registration,
                      'layers':layer_defs,'face':{'file':'choreography/research/facial.png','frameHeight':384,'frames':FRAMES,'neutralOnly':True},
                      'motion':{'breathSeconds':4.9,'gestureSeconds':3.8,'gestureIntervalSeconds':[8,15]},
                      'facialAnimation':'none-preserve-authored-view'}
        manifest['characters'][f'research/{pose}'] = definition
        manifest['runtimeFiles'].extend([layer['file'] for layer in layer_defs]+[definition['face']['file']])
        ordered = [(layer,exported[layer['id']]) for layer in layer_defs]
        full = compose(ordered)
        error = np.abs(np.array(full).astype(int)-np.array(image).astype(int))
        preview_steps = [('neutral',{}),('positive',{l['id']:l['amplitudeDegrees'] for l in layer_defs}),
                         ('negative',{l['id']:-l['amplitudeDegrees'] for l in layer_defs})]
        for theme,color in [('light','#f7f3ed'),('dark','#17202f')]:
            sheet = Image.new('RGBA',(256*3,384),color)
            for column,(name,angles) in enumerate(preview_steps):
                sheet.alpha_composite(compose(ordered,angles),(256*column,0))
            sheet.resize((1536,768),Image.Resampling.NEAREST).convert('RGB').save(QA/f'{pose}-{theme}.png')
        previews.append((pose,full))
        reports.append({'pose':pose,'layers':len(layer_defs),'nonempty':all(img.getbbox() for img in exported.values()),
                        'neutralMaxDifference':int(error.max()),'neutralChangedPixels':int(np.count_nonzero(error.max(axis=2)>4)),
                        'bbox':full.getbbox(),'scale':registration['scaleX'],
                        'maxAngles':{layer['id']:layer['amplitudeDegrees'] for layer in layer_defs}})
    manifest['runtimeFiles'] = list(dict.fromkeys(manifest['runtimeFiles']))
    (HERE/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    suffix = f'-{args.pose}' if args.pose else ''
    for theme,color in [('light','#f7f3ed'),('dark','#17202f')]:
        sheet = Image.new('RGBA',(256*4,416*4),color);draw=ImageDraw.Draw(sheet)
        for index,(pose,image) in enumerate(previews):
            x=index%4*256;y=index//4*416
            sheet.alpha_composite(image,(x,y));draw.text((x+4,y+389),pose,fill='#9c9c9c')
        sheet.convert('RGB').save(QA/f'contact-{theme}{suffix}.png')
    (QA/f'report{suffix}.json').write_text(json.dumps({'cleanup':clean_counts,'rigs':reports},indent=2)+'\n')
    print(json.dumps({'rigs':len(manifest['characters']),'exported':len(reports),'cleanup':clean_counts,'qa':str(QA)}))

if __name__ == '__main__': main()
