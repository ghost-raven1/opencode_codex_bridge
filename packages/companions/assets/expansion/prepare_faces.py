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


def region(target, kind, role, index=0):
    left,right,mouth=[tuple(p) for p in target]
    result=Image.new('L',SIZE);draw=ImageDraw.Draw(result)
    if role=='tester':
        if kind in ('mouth','emotion'):
            draw.ellipse((mouth[0]-3.8,mouth[1]-3,mouth[0]+4,mouth[1]+3.2),fill=255)
        if kind=='eyes' or (kind=='emotion' and index!=16):
            for x,y in (left,right):draw.ellipse((x-4,y-3,x+4,y+3),fill=255)
        if kind=='emotion':
            for x,y in (left,right):draw.rectangle((x-4,y-6,x+4,y-3.5),fill=255)
        return result.filter(ImageFilter.GaussianBlur(.35))
    if kind=='mouth':
        draw.ellipse((mouth[0]-6,mouth[1]-5,mouth[0]+7,mouth[1]+5),fill=255)
    elif kind=='eyes':
        for x,y in (left,right):draw.ellipse((x-8,y-7,x+8,y+7),fill=255)
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


# Measured per-cell anchors of the approved v2 identity. The last row has four
# smaller cells; ImageGen's extra neutral at row 5 column 3 is deliberately unused.
TESTER_CELLS=[
 [[118,159],[182,142],[155,198]],[[465,159],[528,143],[501,199]],[[813,159],[876,143],[852,200]],
 [[118,413],[183,397],[155,452]],[[465,413],[528,397],[501,453]],[[813,413],[877,397],[852,454]],
 [[118,667],[183,651],[155,707]],[[465,667],[529,651],[501,708]],[[813,667],[877,651],[852,708]],
 [[118,921],[183,905],[155,962]],[[465,921],[529,905],[501,962]],[[813,921],[877,905],[852,962]],
 [[118,1174],[183,1158],[155,1216]],[[465,1174],[529,1158],[501,1216]],
 [[83,1422],[145,1402],[118,1457]],[[340,1422],[400,1402],[375,1457]],
 [[596,1420],[655,1401],[629,1457]],[[850,1420],[911,1400],[882,1457]],
]


def main():
    report={}
    for role,spec in SPECS.items():
        filename='tester-v2-faces.png' if role=='tester' else f'{role}-faces-v2.png' if role=='devops' else f'{role}-faces.png'
        sheet=Image.open(SOURCE/filename).convert('RGBA')
        head=Image.open(HERE/role/'head.png').convert('RGBA')
        target=[point(spec,p) for p in spec['faceTarget']]
        atlas=Image.new('RGBA',(256,384*18));metrics=[]
        for index,label in enumerate(LABELS):
            kind='mouth' if index<8 else 'eyes' if index<14 else 'emotion'
            source_name=filename;source_index=index
            if role=='tester':
                anchors=TESTER_CELLS[index]
                source_index=index if index<14 else index+1
            else:
                row,col=divmod(index,3);offsets=spec['faceOffsets']
                sx,sy=offsets[0][col],offsets[1][row]
                anchors=[(p[0]+sx,p[1]+sy)for p in spec['faceSource']]
            mask=region(target,kind,role,index)
            if role=='tester' and index==0:
                # Preserve the approved native face exactly; do not repaint its neutral mouth.
                source_name=spec['source'];source_index=0
                face=head.copy();face.putalpha(Image.fromarray(np.minimum(np.array(mask),np.array(head)[:,:,3])))
                face=canonical(face)
            else:
                face=match_skin(affine(sheet,anchors,target),head,mask)
            atlas.alpha_composite(face,(0,index*384))
            metrics.append({'row':index,'label':label,'source':source_name,'sourceIndex':source_index,
                            'sourceAnchors':anchors,'targetAnchors':target,
                            'sha256':hashlib.sha256(face.tobytes()).hexdigest()})
        assert len({r['sha256'] for r in metrics})==18,role
        atlas.save(HERE/role/'facial.png',optimize=True)
        if role!='tester':
            head.alpha_composite(atlas.crop((0,0,256,384)))
            head.save(HERE/role/'head.png')
        preview=Image.new('RGBA',(6*256,3*160),'#f4efe8')
        for i in range(18):
            composed=head.copy();composed.alpha_composite(atlas.crop((0,384*i,256,384*(i+1))))
            preview.alpha_composite(composed.crop((0,0,256,160)),((i%6)*256,(i//6)*160))
            ImageDraw.Draw(preview).text(((i%6)*256+12,(i//6)*160+138),f'{i} {LABELS[i]}',fill='#555555')
        preview.convert('RGB').save(HERE/role/'qa-face.png')
        report[role]=metrics
    (HERE/'face-registration.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':main()
