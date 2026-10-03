"""Review measured ownership contours, exact neutral assembly and bounded joint seams."""
from pathlib import Path
import json
import hashlib
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
EXPANSION = HERE.parent.parent
ROOT = EXPANSION.parents[3]
ROLE = HERE.name
QA = ROOT / '.local/choreography-qa' / ROLE / 'mask-audit'
SIZE = (256,384)


def render(definition, images, angle=0, x=0, y=0):
    """Apply the measured joint angle and a shared bounded head transform to its hair."""
    result = Image.new('RGBA',SIZE)
    head = next(layer for layer in definition['layers'] if layer['id']=='head')
    for layer in definition['layers']:
        image = images[layer['id']]
        if angle and layer['motion']!='body':
            sign = -angle if layer['id']=='arm-left' else angle
            image = image.rotate(-sign*layer['amplitudeDegrees'],Image.Resampling.BICUBIC,center=tuple(layer['pivot']))
            if layer['parent']=='head':
                image = image.rotate(-angle*head['amplitudeDegrees'],Image.Resampling.BICUBIC,center=tuple(head['pivot']))
        if (x or y) and (layer['motion']=='head' or layer['parent']=='head'):
            image = image.transform(SIZE,Image.Transform.AFFINE,(1,0,-x,0,1,-y),Image.Resampling.BICUBIC)
        result.alpha_composite(image)
    return result


def contact_cell(board, image, x, y, width=224, height=164):
    crop = image.crop(image.getchannel('A').getbbox())
    scale = min((width-20)/crop.width,height/crop.height,4)
    crop = crop.resize((round(crop.width*scale),round(crop.height*scale)),Image.Resampling.NEAREST)
    board.alpha_composite(crop,(x+(width-crop.width)//2,y+(height-crop.height)//2))


def main():
    QA.mkdir(parents=True,exist_ok=True)
    manifest = json.loads((HERE/'manifest.json').read_text())
    heads = Image.new('RGBA',(896,864),'#f7f3ed'); hd = ImageDraw.Draw(heads)
    braids = Image.new('RGBA',(896,1152),'#f7f3ed'); bd = ImageDraw.Draw(braids)
    report = []
    for index,(key,definition) in enumerate(manifest['characters'].items()):
        pose = key.split('/')[1]; row,col = divmod(index,4)
        images = {layer['id']:Image.open(EXPANSION/layer['file']).convert('RGBA') for layer in definition['layers']}
        neutral = render(definition,images)
        reference = Image.open(QA.parent/f'{pose}-registered.png').convert('RGBA')
        assert np.array_equal(np.array(neutral),np.array(reference)), (pose,'neutral RGBA changed')
        previous = QA/f'before-{pose}-neutral.png'
        if previous.exists():
            assert np.array_equal(np.array(neutral),np.array(Image.open(previous).convert('RGBA'))), (pose,'pre-fix drawing changed')
        head = images['head']; head.save(QA/f'after-{pose}-head.png')
        contact_cell(heads,head,col*224,row*216+24)
        hd.text((col*224+4,row*216+6),str(index+1)+' '+pose,fill='#222222')
        hd.text((col*224+4,row*216+194),str(head.getchannel('A').getbbox()),fill='#222222')
        if 'braid' in images:
            contact_cell(braids,images['braid'],col*224,row*288+24,height=236)
            bd.text((col*224+4,row*288+6),str(index+1)+' '+pose,fill='#222222')
        frames = [neutral]
        gaps = []
        eroded = np.array(neutral.getchannel('A').filter(ImageFilter.MinFilter(5)))>250
        for sign in [1,-1]:
            for x,y in [(.75,.75),(.75,-.75),(-.75,.75),(-.75,-.75)]:
                image = render(definition,images,sign,x,y)
                frames.append(image)
                lost = eroded & (np.array(image.getchannel('A'))<64)
                yy,xx = np.where(lost)
                gaps.append({'angleSign':sign,'headXY':[x,y],'interiorLossPixels':int(lost.sum()),
                    'bounds':None if not len(xx) else [int(xx.min()),int(yy.min()),int(xx.max()+1),int(yy.max()+1)]})
        boxes = [image.getchannel('A').getbbox() for name,image in images.items() if name in ('head','arm-left','arm-right')]
        crop_box = (max(0,min(b[0] for b in boxes)-5),max(0,min(b[1] for b in boxes)-5),
                    min(256,max(b[2] for b in boxes)+5),min(384,max(b[3] for b in boxes)+5))
        for theme,color,ink in [('light','#f7f3ed','#222222'),('dark','#17202f','#eeeeee')]:
            board = Image.new('RGBA',(576,720),color); draw = ImageDraw.Draw(board)
            for n,image in enumerate(frames):
                r,c = divmod(n,3); cut = image.crop(crop_box)
                scale = min(186/cut.width,208/cut.height,3)
                cut = cut.resize((round(cut.width*scale),round(cut.height*scale)),Image.Resampling.NEAREST)
                board.alpha_composite(cut,(c*192+(192-cut.width)//2,r*240+28+(208-cut.height)//2))
                label = 'neutral' if n==0 else str(gaps[n-1]['angleSign'])+' '+str(gaps[n-1]['headXY'])
                draw.text((c*192+4,r*240+6),label,fill=ink)
            board.convert('RGB').save(QA/f'{pose}-bounded-{theme}.png')
        report.append({'pose':pose,'neutralExact':True,'headBounds':head.getchannel('A').getbbox(),
            'neckPivot':next(layer['pivot'] for layer in definition['layers'] if layer['id']=='head'),
            'layerHashes':{layer['id']:hashlib.sha256((EXPANSION/layer['file']).read_bytes()).hexdigest() for layer in definition['layers']},
            'boundedSamples':gaps})
    heads.convert('RGB').save(QA/'after-all-heads-light.png')
    if ROLE=='designer': braids.convert('RGB').save(QA/'after-all-braids-light.png')
    (QA/'after-report.json').write_text(json.dumps({'role':ROLE,'passedNeutralRGBA':True,'nativeRuntimeVerified':False,'poses':report},indent=2)+'\n')
    print(f'PASS {ROLE}: 16 exact RGBA assemblies, 128 authored-angle/.75px seam samples; native playback separate.')


if __name__=='__main__': main()
