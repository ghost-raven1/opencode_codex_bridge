"""Validate authored rig geometry and preview layer transforms on light/dark canvases."""
from pathlib import Path
import hashlib
import json
import math
import numpy as np
from PIL import Image, ImageDraw

HERE=Path(__file__).resolve().parent
SIZE=(256,384)


def composite(definition, phase=0, expression=0):
    output=Image.new('RGBA',SIZE)
    head=next(layer for layer in definition['layers'] if layer['id']=='head')
    for layer in definition['layers']:
        image=Image.open(HERE/layer['file']).convert('RGBA')
        if layer['id']=='head':
            face=Image.open(HERE/definition['face']['file'])
            image.alpha_composite(face.crop((0,384*expression,256,384*(expression+1))))
        if layer['motion'] in ('arm','hair','prop'):
            image=image.rotate(phase*layer['amplitudeDegrees'],Image.Resampling.BICUBIC,center=layer['pivot'])
        if layer['motion']=='head' or layer['parent']=='head':
            image=image.rotate(phase*head['amplitudeDegrees'],Image.Resampling.BICUBIC,center=head['pivot'])
        output.alpha_composite(image)
    return output


def main():
    manifest=json.loads((HERE/'manifest.json').read_text())
    qa=HERE/'qa';qa.mkdir(exist_ok=True)
    report={}
    for role,definition in manifest['characters'].items():
        metrics=[]
        for layer in definition['layers']:
            im=Image.open(HERE/layer['file'])
            assert im.mode=='RGBA' and im.size==SIZE,(role,layer['id'])
            a=np.array(im)[:,:,3]
            assert a.min()==0 and a.max()>200
            assert not np.any(a[0]) and not np.any(a[-1])
            assert not np.any(a[:,0]) and not np.any(a[:,-1])
            metrics.append({'id':layer['id'],'bounds':im.getbbox(),'sha256':hashlib.sha256(im.tobytes()).hexdigest()})
        face=Image.open(HERE/definition['face']['file'])
        assert face.size==(256,6912)
        hashes=[hashlib.sha256(face.crop((0,i*384,256,(i+1)*384)).tobytes()).hexdigest() for i in range(18)]
        assert len(set(hashes))==18
        report[role]={'layers':metrics,'facialDrawings':18,'facialHashes':hashes,'basePoses':1,
                      'motion':'continuous affine layers; no duplicated generated frames'}
    for theme,color in [('light','#f7f3ed'),('dark','#17202f')]:
        sheet=Image.new('RGBA',(256*7,416),color)
        bodies=Image.open(HERE.parent/'mixed-body-atlas.png')
        heads=Image.open(HERE.parent/'mixed-head-atlas.png')
        for col,name in enumerate(['lead','code','research','review']):
            sheet.alpha_composite(bodies.crop((col*256,0,(col+1)*256,384)),(col*256,32))
            sheet.alpha_composite(heads.crop((col*256,0,(col+1)*256,384)),(col*256,32))
            ImageDraw.Draw(sheet).text((col*256+95,10),name,fill='#a6a6a6')
        for col,(role,definition) in enumerate([(r,d) for r,d in manifest['characters'].items() if r in ('designer','devops','tester')],4):
            sheet.alpha_composite(composite(definition),(col*256,32))
            ImageDraw.Draw(sheet).text((col*256+95,10),role,fill='#a6a6a6')
        sheet.convert('RGB').save(qa/f'team-{theme}.png')
        extremes=Image.new('RGBA',(256*3,384*len(manifest['characters'])),color)
        for row,(role,definition) in enumerate(manifest['characters'].items()):
            for col,phase in enumerate([-1,0,1]):extremes.alpha_composite(composite(definition,phase),(col*256,row*384))
        extremes.convert('RGB').save(qa/f'joints-{theme}.png')
    (HERE/'validation.json').write_text(json.dumps(report,indent=2)+'\n')
    print(f"PASS: {sum(len(d['layers']) for d in manifest['characters'].values())} rig layers; {len(report)*18} facial patches; transparent canvas boundaries.")


if __name__=='__main__':main()
