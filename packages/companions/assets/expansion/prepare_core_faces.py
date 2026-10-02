"""Register retained authored expressions to the new core-v2 eye and mouth landmarks."""
import hashlib
import json
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from prepare_core import HERE, SIZE, SPECS, ROLES, point, canonical


def prepare_faces(role, labels):
    registration = json.loads((HERE.parent/'source/animation-v3'/role/'registration.json').read_text())
    old_points = registration['faces']['targetLandmarks']
    target = [point(role,p) for p in SPECS[role]['face']]
    source = Image.open(HERE.parent/'source/animation-v3'/role/'face-registered.png').convert('RGBA')
    head = Image.open(HERE/role/'head.png').convert('RGBA')
    matrix = np.array([[x,y,1] for x,y in target])
    inverse = tuple(np.linalg.solve(matrix,[p[0] for p in old_points])) + tuple(np.linalg.solve(matrix,[p[1] for p in old_points]))
    atlas = Image.new('RGBA',(256,384*18)); metrics = []
    for index,label in enumerate(labels):
        frame = source.crop((0,index*384,256,(index+1)*384)).transform(SIZE,Image.Transform.AFFINE,inverse,Image.Resampling.BICUBIC)
        pixels = np.array(frame); base = np.array(head); region = pixels[:,:,3]>64
        rgb = pixels[:,:,:3].astype(float); original = base[:,:,:3].astype(float)
        skin = region & (rgb[:,:,0]>160) & (rgb[:,:,1]>90) & (rgb[:,:,0]>rgb[:,:,1]+10)
        original_skin = region & (original[:,:,0]>160) & (original[:,:,1]>90) & (original[:,:,0]>original[:,:,1]+10)
        if skin.sum()>5 and original_skin.sum()>5:
            shift = np.median(original[original_skin],axis=0)-np.median(rgb[skin],axis=0)
            rgb[skin] = np.clip(rgb[skin]+shift,0,255); pixels[:,:,:3] = rgb.astype('uint8')
        # Neutral mouth and fully open eyes belong to the approved new identity.
        if index in [0,8]: pixels[:,:,:3] = base[:,:,:3]
        if index>=8:
            # Old sheets include old eyebrow geometry; only eyelids and mouth are
            # re-registered. Native brows/glasses stay fixed instead of doubling.
            features=Image.new('L',SIZE);draw=ImageDraw.Draw(features)
            if index!=16:
                rx,ry=(6.0,3.9) if role=='research' else (7.4,4.8)
                for x,y in target[:2]:draw.ellipse((x-rx,y-ry,x+rx,y+ry),fill=255)
            if index>=14:
                x,y=target[2];draw.ellipse((x-6,y-4,x+6,y+4),fill=255)
            pixels[:,:,3]=np.minimum(pixels[:,:,3],np.array(features.filter(ImageFilter.GaussianBlur(.35))))
        pixels[:,:,3] = np.minimum(pixels[:,:,3],base[:,:,3])
        face = canonical(Image.fromarray(pixels)); atlas.alpha_composite(face,(0,index*384))
        native=index in [0,8]
        anchors=[[x+ROLES.index(role)*512,y] for x,y in SPECS[role]['face']] if native else old_points
        metrics.append({'row':index,'label':label,'source':'core-v2.png' if native else f'../../source/animation-v3/{role}/face-registered.png',
            'sourceIndex':ROLES.index(role) if native else index,'sourceAnchors':anchors,'targetAnchors':target,
            'sha256':hashlib.sha256(face.tobytes()).hexdigest()})
    assert len({row['sha256'] for row in metrics})==18,role
    atlas.save(HERE/role/'facial.png',optimize=True)
    preview = Image.new('RGBA',(6*180,3*150),'#f7f3ed')
    for index,label in enumerate(labels):
        composed = head.copy(); composed.alpha_composite(atlas.crop((0,index*384,256,(index+1)*384)))
        preview.alpha_composite(composed.crop((65,10,195,110)).resize((180,138),Image.Resampling.NEAREST),((index%6)*180,(index//6)*150))
        ImageDraw.Draw(preview).text(((index%6)*180+5,(index//6)*150+138),f'{index} {label}',fill='#444444')
    preview.convert('RGB').save(HERE/role/'qa-face.png')
    return metrics
