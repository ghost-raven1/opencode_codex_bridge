"""Build four working rigs from authored arm/prop art and newly painted torso underlays."""
from pathlib import Path
import json
import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE=Path(__file__).resolve().parent
ASSETS=HERE.parent
SIZE=(256,384)
SPECS={
 'lead':{'column':0,'anchor':[256,65,728],'scale':.36,
  'arm-left':[(65,115),(70,114),(88,128),(92,128),(99,142),(94,150),(86,155),(90,166),(89,174),(82,179),(73,175),(68,165),(73,149),(73,141)],
  'arm-right':[(130,158),(138,158),(145,166),(154,170),(164,169),(169,179),(168,190),(162,192),(151,188),(133,184),(125,180),(121,174),(123,167)],
  'prop':[(84,146),(132,140),(149,184),(98,192)],'pivots':[[81,171],[163,180],[126,177]]},
 'code':{'column':1,'anchor':[781,61,730],'scale':.38,
  'arm-left':[(66,166),(77,166),(85,169),(84,178),(78,183),(68,181),(64,176)],
  'arm-right':[(110,146),(119,142),(129,145),(132,148),(142,151),(145,169),(129,167),(122,160),(111,164),(107,158)],
  'prop':[(42,110),(99,110),(113,159),(145,162),(145,174),(41,174),(35,166)],'pivots':[[74,177],[140,162],[100,170]]},
 'research':{'column':2,'anchor':[1290,66,733],'scale':.35,
  'arm-left':[(99,159),(110,155),(117,143),(126,139),(135,141),(137,146),(129,149),(137,151),(137,157),(129,159),(124,168),(111,175),(100,181),(97,176)],
  'arm-right':[(154,151),(162,153),(166,148),(171,152),(171,139),(176,139),(177,154),(174,166),(172,180),(167,184),(158,180),(156,171),(151,164)],
  'prop':[(127,110),(168,127),(190,110),(203,112),(196,139),(181,174),(160,180),(113,173),(113,150)],'pivots':[[101,172],[167,176],[151,172]]},
 'review':{'column':3,'anchor':[1800,64,732],'scale':.36,
  'arm-left':[(68,149),(75,147),(77,153),(85,151),(89,155),(87,161),(90,166),(85,174),(86,184),(81,190),(72,188),(69,180),(66,172),(65,161)],
  'arm-right':[(110,135),(117,135),(126,140),(136,155),(136,164),(145,167),(164,168),(176,174),(176,191),(163,189),(139,178),(131,168),(119,163),(114,154),(112,148),(105,150),(104,141)],
  'prop':[(53,121),(93,117),(118,179),(84,181)],'pivots':[[77,183],[164,181],[89,173]]},
}


def polygon(points):
    image=Image.new('L',SIZE);ImageDraw.Draw(image).polygon(points,fill=255)
    return image


def clean(image):
    pixels=np.array(image);pixels[pixels[:,:,3]<8]=0
    return Image.fromarray(pixels)


def clean_code_sleeve(image):
    """Remove inherited neutral matte pixels only outside the purple right sleeve."""
    pixels=np.array(image);rgb=pixels[:,:,:3].astype('int16')
    border=np.array(image.getchannel('A').filter(ImageFilter.MinFilter(5)))==0
    region=np.zeros(SIZE[::-1],dtype=bool);region[105:203,165:205]=True
    matte=(rgb.min(2)>70)&(rgb.max(2)-rgb.min(2)<45)
    pixels[region&border&matte]=0
    return Image.fromarray(pixels)


def main():
    manifest=json.loads((HERE/'manifest.json').read_text())
    bodies=Image.open(ASSETS/'mixed-body-atlas.png').convert('RGBA')
    heads=Image.open(ASSETS/'mixed-head-atlas.png').convert('RGBA')
    faces=Image.open(ASSETS/'facial-v3.png').convert('RGBA')
    paint=Image.open(HERE/'source/core-underpaint.png').convert('RGBA')
    for role,spec in SPECS.items():
        col=spec['column'];folder=HERE/role;folder.mkdir(exist_ok=True)
        source=bodies.crop((col*256,1152,(col+1)*256,1536))
        remaining=source.getchannel('A');removed=Image.new('L',SIZE)
        for part in ['arm-left','arm-right','prop']:
            selected=ImageChops.darker(remaining,polygon(spec[part]))
            if role=='code' and part=='prop':
                rgb=np.array(source)[:,:,:3].astype('int16');a=np.array(selected)
                purple=(rgb[:,:,0]>rgb[:,:,1]*1.4)&(rgb[:,:,2]>rgb[:,:,1]*1.3)
                purple[118:156,52:96]=False
                a[purple]=0;selected=Image.fromarray(a)
            layer=source.copy();layer.putalpha(selected);clean(layer).save(folder/f'{part}.png')
            removed=ImageChops.lighter(removed,selected)
            remaining=ImageChops.subtract(remaining,selected)
        body=source.copy();body.putalpha(remaining)
        x,y,sole=spec['anchor'];sx=spec['scale'];sy=268/(sole-y)
        patch=paint.transform(SIZE,Image.Transform.AFFINE,(1/sx,0,x-128/sx,0,1/sy,y-100/sy),Image.Resampling.BICUBIC)
        patch.putalpha(ImageChops.darker(patch.getchannel('A'),removed))
        patch.alpha_composite(body)
        if role=='code':patch=clean_code_sleeve(patch)
        clean(patch).save(folder/'body.png')
        clean(heads.crop((col*256,0,(col+1)*256,384))).save(folder/'head.png')
        clean(faces.crop((col*256,0,(col+1)*256,6912))).save(folder/'facial.png')
        layers=[{'id':'body','file':f'{role}/body.png','parent':None,'pivot':[128,368],'motion':'body','amplitudeDegrees':0}]
        for part in ['prop','arm-left','arm-right']:
            pivot=spec['pivots'][['arm-left','arm-right','prop'].index(part)]
            layers.append({'id':part,'file':f'{role}/{part}.png','parent':'body','pivot':pivot,'motion':'prop' if part=='prop' else 'arm',
                           'amplitudeDegrees':1.2 if part=='prop' else 2.5})
        layers.append({'id':'head','file':f'{role}/head.png','parent':'body','pivot':[128,120],'motion':'head','amplitudeDegrees':1.5})
        labels=manifest['characters']['designer']['face']['frames']
        manifest['characters'][role]={'name':role.upper(),'roleHint':role,'layers':layers,
          'face':{'file':f'{role}/facial.png','frameHeight':384,'frames':labels},
          'motion':{'breathSeconds':4.6,'gestureSeconds':4.0,'gestureIntervalSeconds':[8,15]}}
    manifest['runtimeFiles']=[l['file'] for d in manifest['characters'].values() for l in d['layers']]+[d['face']['file'] for d in manifest['characters'].values()]
    (HERE/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':main()
