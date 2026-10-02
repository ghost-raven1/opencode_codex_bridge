"""Register genuine drawn expressions as small facial patches, never repeat frames."""
from pathlib import Path
import hashlib
import json
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from prepare import HERE, SOURCE, SIZE, SPECS, LABELS, point, canonical


def affine(source, src, dst):
    a=np.array([[p[0],p[1],1] for p in dst],dtype=float)
    x=np.linalg.solve(a,np.array([p[0] for p in src]))
    y=np.linalg.solve(a,np.array([p[1] for p in src]))
    return source.transform(SIZE,Image.Transform.AFFINE,tuple(x)+tuple(y),Image.Resampling.BICUBIC)


def region(target, kind, role):
    left,right,mouth=[tuple(p) for p in target]
    result=Image.new('L',SIZE);draw=ImageDraw.Draw(result)
    if kind=='mouth':
        draw.ellipse((mouth[0]-6,mouth[1]-5,mouth[0]+7,mouth[1]+5),fill=255)
    elif kind=='eyes':
        # Preserve original glasses by registering both frames identically; patch includes rims.
        for x,y in (left,right):
            rx,ry=(6,5) if role=='tester' else (8,7)
            draw.ellipse((x-rx,y-ry,x+rx,y+ry),fill=255)
    elif role=='tester':
        for x,y in (left,right):
            draw.ellipse((x-6,y-5,x+6,y+5),fill=255)
            draw.rectangle((x-7,y-12,x+7,y-6),fill=255)
        draw.ellipse((mouth[0]-6,mouth[1]-5,mouth[0]+7,mouth[1]+5),fill=255)
    else:
        draw.polygon([(left[0]-8,left[1]-9),(right[0]+8,right[1]-9),(right[0]+10,right[1]+8),
                      (mouth[0]+9,mouth[1]+5),(mouth[0]-9,mouth[1]+5),(left[0]-9,left[1]+5)],fill=255)
    return result.filter(ImageFilter.GaussianBlur(.65))


def match_skin(image, head, mask):
    """Match the generated cheek palette while keeping dark eyes, outlines and mouth unchanged."""
    pixels=np.array(image);base=np.array(head);m=np.array(mask)>80
    p=pixels[:,:,:3].astype(float);b=base[:,:,:3].astype(float)
    skin=m&(p[:,:,0]>165)&(p[:,:,1]>95)&(p[:,:,2]<210)&(p[:,:,0]>p[:,:,1]+10)
    target=m&(b[:,:,0]>165)&(b[:,:,1]>95)&(b[:,:,2]<210)&(b[:,:,0]>b[:,:,1]+10)
    if skin.sum()>8 and target.sum()>8:
        shift=np.median(b[target],axis=0)-np.median(p[skin],axis=0)
        p[skin]=np.clip(p[skin]+shift,0,255);pixels[:,:,:3]=p.astype('uint8')
    pixels[:,:,3]=np.minimum(np.array(mask),base[:,:,3])
    return canonical(Image.fromarray(pixels))


def main():
    report={}
    for role,spec in SPECS.items():
        filename=f'{role}-faces-v2.png' if role=='devops' else f'{role}-faces.png'
        sheet=Image.open(SOURCE/filename).convert('RGBA')
        head=Image.open(HERE/role/'head.png').convert('RGBA')
        target=[point(spec,p) for p in spec['faceTarget']]
        atlas=Image.new('RGBA',(256,384*18));metrics=[]
        for index,label in enumerate(LABELS):
            kind='mouth' if index<8 else 'eyes' if index<14 else 'emotion'
            source=sheet
            source_name=filename
            source_index=index
            if role=='tester':
                # The first generated sheet had 15 heads; use a separate six-head blink sheet.
                if 8<=index<14:
                    source=Image.open(SOURCE/'tester-blink.png').convert('RGBA')
                    source_name='tester-blink.png';source_index=index-8
                    row,col=divmod(index-8,2)
                    offsets=([0,486],[0,486,972])
                    anchors=[[201,315],[312,282],[268,376]]
                elif index>=14:
                    source=Image.open(SOURCE/'tester-emotions.png').convert('RGBA')
                    source_name='tester-emotions.png';source_index=index-14
                    row,col=divmod(index-14,2)
                    offsets=([0,603],[0,630])
                    anchors=[[238,375],[383,337],[315,455]]
                else:
                    source_index={7:11}.get(index,index)
                    row,col=divmod(source_index,3);offsets=spec['faceOffsets'];anchors=spec['faceSource']
            else:
                row,col=divmod(index,3);offsets=spec['faceOffsets'];anchors=spec['faceSource']
            sx,sy=offsets[0][col],offsets[1][row]
            registered=affine(source,[(p[0]+sx,p[1]+sy) for p in anchors],target)
            face=match_skin(registered,head,region(target,kind,role))
            atlas.alpha_composite(face,(0,index*384))
            metrics.append({'row':index,'label':label,'source':source_name,
                            'sourceIndex':source_index,'sha256':hashlib.sha256(face.tobytes()).hexdigest()})
        assert len({r['sha256'] for r in metrics})==18,role
        atlas.save(HERE/role/'facial.png',optimize=True)
        # Neutral mouth belongs to the head, so blinking does not expose an old open mouth.
        head.alpha_composite(atlas.crop((0,0,256,384)))
        head.save(HERE/role/'head.png')
        preview=Image.new('RGBA',(6*256,3*160),'#f4efe8')
        for i in range(18):
            composed=head.copy();composed.alpha_composite(atlas.crop((0,384*i,256,384*(i+1))))
            preview.alpha_composite(composed.crop((0,0,256,160)),((i%6)*256,(i//6)*160))
        preview.convert('RGB').save(HERE/role/'qa-face.png')
        report[role]=metrics
    (HERE/'face-registration.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':main()
