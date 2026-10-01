"""Key magenta and register new LEAD/REVIEW drawings; no synthetic character art."""
from pathlib import Path
import hashlib
import importlib.util
import json

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT.parents[1]
CELL = (256, 384)
ROLES = {'lead': 0, 'review': 3}
spec = importlib.util.spec_from_file_location('registration_v2', ROOT.parent/'animation-v2/prepare.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
FACE_LABELS = ['close', 'slightly-open', 'A', 'O', 'E', 'I', 'U', 'smile-speaking',
               'open', 'quarter', 'half', 'three-quarter', 'closed', 'reopen',
               'smile', 'concern', 'focus', 'surprise']


def foreground(image):
    rgb = np.asarray(image.convert('RGB')).astype('int16')
    return np.minimum(rgb[:,:,0], rgb[:,:,2])-rgb[:,:,1] < 80


def source_cells(image, columns, rows):
    """Locate actual empty row gutters; generated sheets are not perfectly uniform."""
    occupied = foreground(image).sum(axis=1) > 4
    gaps = []
    start = None
    for y, value in enumerate(occupied):
        if not value and start is None:
            start = y
        if value and start is not None:
            if y-start >= 4:
                gaps.append((start, y))
            start = None
    internal = [(a+b)//2 for a,b in gaps if a > 5 and b < image.height-5]
    if len(internal) != rows-1:
        counts = foreground(image).sum(axis=1)
        internal = []
        for n in range(1, rows):
            expected = round(image.height*n/rows)
            lo, hi = expected-60, expected+61
            candidates = np.nonzero(counts[lo:hi] == counts[lo:hi].min())[0]+lo
            internal.append(int(candidates[len(candidates)//2]))
    cuts = [0]+internal+[image.height]
    for index in range(columns*rows):
        row, col = divmod(index, columns)
        box = (round(col*image.width/columns), cuts[row], round((col+1)*image.width/columns), cuts[row+1])
        yield index, box, image.crop(box)


def key_magenta(crop):
    """Remove key color, then unmatte the one-pixel chromatic fringe at the contour."""
    rgb = np.asarray(crop.convert('RGB')).astype(float)
    excess = np.minimum(rgb[:,:,0], rgb[:,:,2])-rgb[:,:,1]
    alpha = (excess < 80).astype(float)
    # The chroma estimate is used only next to empty background, not inside silver hair.
    padded = np.pad(alpha == 0, 1)
    boundary = np.zeros(alpha.shape, dtype=bool)
    for dy in range(3):
        for dx in range(3):
            boundary |= padded[dy:dy+crop.height, dx:dx+crop.width]
    fringe = boundary & (alpha > 0) & (excess > 12)
    alpha[fringe] = np.clip(1-(excess[fringe]-12)/243, 0, 1)
    matte = np.array([255., 0., 255.])
    rgb[fringe] = np.clip((rgb[fringe]-(1-alpha[fringe,None])*matte)/alpha[fringe,None], 0, 255)
    # Keep the character component. Detached breath clouds/marks were not requested.
    mask = alpha > .1
    seen = np.zeros(mask.shape, dtype=bool)
    components = []
    h, w = mask.shape
    for sy,sx in zip(*np.nonzero(mask)):
        if seen[sy,sx]:
            continue
        points, queue = [], [(sy,sx)]
        seen[sy,sx] = True
        while queue:
            y,x = queue.pop(); points.append((y,x))
            for dy in (-1,0,1):
                for dx in (-1,0,1):
                    yy,xx = y+dy,x+dx
                    if 0 <= yy < h and 0 <= xx < w and mask[yy,xx] and not seen[yy,xx]:
                        seen[yy,xx] = True; queue.append((yy,xx))
        components.append(points)
    keep = np.zeros(mask.shape, dtype=bool)
    for y,x in max(components,key=len):
        keep[y,x] = True
    alpha[~keep] = 0
    pixels = np.concatenate([rgb, (alpha*255)[:,:,None]], axis=2).astype('uint8')
    pixels[pixels[:,:,3] == 0] = 0
    return Image.fromarray(pixels)


def body(role, kind):
    image = Image.open(ROOT/role/f'{kind}-generated.png')
    atlas = Image.new('RGBA',(1024,1920))
    metrics = []
    for index,box,crop in source_cells(image,4,5):
        clean = key_magenta(crop); bounds = clean.getbbox()
        alpha = np.asarray(clean)[:,:,3]
        soles = np.nonzero(alpha[max(0,bounds[3]-18):bounds[3]])[1]
        center = float((soles.min()+soles.max())/2)
        sprite = helper.register(clean,center,bounds)
        result_bounds = sprite.getbbox()
        assert result_bounds[0] > 2 and result_bounds[2] < 254, (role,kind,index,result_bounds)
        assert result_bounds[3] == 368, (role,kind,index,result_bounds)
        row,col = divmod(index,4); atlas.alpha_composite(sprite,(col*256,row*384))
        state = ('working' if index<10 else 'thinking') if kind=='activity' else ('success' if index<8 else 'waiting' if index<14 else 'error')
        metrics.append({'index':index,'state':state,'sourceBox':box,'sourceBounds':bounds,'sourceCenter':center,
                        'bounds':result_bounds,'sha256':hashlib.sha256(sprite.tobytes()).hexdigest()})
    assert len({f['sha256'] for f in metrics}) == 20
    atlas.save(ROOT/role/f'{kind}-registered.png', optimize=True)
    for name,color in [('dark','#17202f'),('light','#ffffff')]:
        contact = Image.new('RGBA',atlas.size,color); contact.alpha_composite(atlas)
        contact.convert('RGB').save(ROOT/role/f'{kind}-{name}.png')
    return metrics


def masks(role):
    mouth,eyes,emotion = [Image.new('L',CELL) for _ in range(3)]
    if role == 'lead':
        ImageDraw.Draw(mouth).ellipse((116,88,137,100),fill=255)
        polygons = [[(98,76),(111,73),(117,78),(119,86),(109,90),(99,85)],
                    [(126,68),(144,63),(150,67),(151,78),(139,84),(127,79)]]
        lower = [(99,83),(116,82),(121,85),(126,79),(148,78),(146,89),(135,100),(124,103),(108,97)]
    else:
        ImageDraw.Draw(mouth).ellipse((113,88,134,100),fill=255)
        polygons = [[(101,79),(111,77),(116,80),(117,85),(111,90),(102,87)],
                    [(121,68),(140,62),(147,67),(145,77),(132,83),(121,78)]]
        lower = [(102,84),(115,82),(120,86),(124,79),(148,77),(146,91),(133,101),(119,103),(105,94)]
    for polygon in polygons:
        ImageDraw.Draw(eyes).polygon(polygon,fill=255)
        ImageDraw.Draw(emotion).polygon(polygon,fill=255)
    ImageDraw.Draw(emotion).polygon(lower,fill=255)
    result = []
    for mask in [mouth,eyes,emotion]:
        blurred = np.asarray(mask.filter(ImageFilter.GaussianBlur(.65)))
        result.append(Image.fromarray(np.where(np.asarray(mask)>0,blurred,0).astype('uint8')))
    return result


def faces(role, base):
    image = Image.open(ROOT/role/'face-generated.png').convert('RGBA')
    crops = list(source_cells(image,3,6))
    reference_bounds = Image.fromarray((foreground(crops[0][2])*255).astype('uint8')).getbbox()
    if role == 'lead':
        source = [(118,153),(185,140),(153,186)]
        target = [(110,82),(138,75),(126,94)]
    else:
        source = [(115,157),(175,138),(149,186)]
        target = [(108,81),(133,73),(123,94)]
    affine = np.linalg.solve(np.array([[x,y,1] for x,y in target],float),np.array(source,float)).T
    overlays = Image.new('RGBA',(256,18*384)); qa = Image.new('RGBA',(1080,1080),'#17202f')
    base_pixels = np.asarray(base); face_masks = masks(role); metrics=[]
    region = np.zeros(CELL[::-1],bool); region[65:102,98:151] = True
    def skin(pixels):
        rgb=pixels[:,:,:3].astype('int16')
        return region & (rgb[:,:,0]>155) & (rgb[:,:,0]-rgb[:,:,1]>15) & (rgb[:,:,0]-rgb[:,:,2]>30)
    for index,box,crop in crops:
        bounds = Image.fromarray((foreground(crop)*255).astype('uint8')).getbbox()
        sx=(bounds[2]-bounds[0])/(reference_bounds[2]-reference_bounds[0]);sy=(bounds[3]-bounds[1])/(reference_bounds[3]-reference_bounds[1])
        normalize=(sx,0,bounds[0]-reference_bounds[0]*sx,0,sy,bounds[1]-reference_bounds[1]*sy)
        normalized=crop.transform(crops[0][2].size,Image.Transform.AFFINE,normalize,resample=Image.Resampling.BICUBIC)
        transformed=normalized.transform(CELL,Image.Transform.AFFINE,tuple(affine.flatten()),resample=Image.Resampling.NEAREST)
        pixels=np.asarray(transformed).copy();mask=np.asarray(face_masks[0 if index<8 else 1 if index<14 else 2]).copy()
        if role == 'lead':
            # Keep the original headset boom where it touches the right cheek.
            microphone=np.zeros(CELL[::-1],bool);microphone[87:100,133:153]=True
            microphone &= (base_pixels[:,:,:3].max(axis=2)<90)
            mask[microphone]=0
        adjustment=np.clip(np.median(base_pixels[skin(base_pixels),:3],axis=0)-np.median(pixels[skin(pixels),:3],axis=0),-25,25)
        pixels[:,:,:3]=np.clip(pixels[:,:,:3].astype(float)+adjustment,0,255).astype('uint8')
        pixels[:,:,3]=mask;pixels[mask==0]=0;patch=Image.fromarray(pixels)
        overlays.alpha_composite(patch,(0,index*384));after=base.copy();after.alpha_composite(patch)
        col,row=index%6,index//6
        for offset,frame in [(0,base),(174,after)]:
            face=frame.crop((85,40,175,120)).resize((180,160),Image.Resampling.NEAREST)
            qa.alpha_composite(face,(col*180,row*360+18+offset))
        ImageDraw.Draw(qa).text((col*180+5,row*360+1),f'{index:02d} {FACE_LABELS[index]}',fill='white')
        metrics.append({'index':index,'name':FACE_LABELS[index],'sourceBox':box,'sourceBounds':bounds,
                        'normalize':normalize,'maskBounds':patch.getbbox(),'skinAdjustment':adjustment.tolist(),
                        'sha256':hashlib.sha256(patch.tobytes()).hexdigest()})
    assert len({f['sha256'] for f in metrics})==18
    overlays.save(ROOT/role/'face-registered.png',optimize=True);qa.convert('RGB').save(ROOT/role/'face-before-after.png')
    return {'sourceLandmarks':source,'targetLandmarks':target,'sourceFromTargetAffine':affine.tolist(),'frames':metrics}


def main():
    original=Image.open(ASSETS/'team-atlas.png').convert('RGBA')
    for role,column in ROLES.items():
        body_meta={kind:body(role,kind) for kind in ['activity','reactions']}
        face_meta=faces(role,original.crop((column*256,0,(column+1)*256,384)))
        metadata={'version':3,'role':role,'cell':{'width':256,'height':384},'feetBaseline':368,
                  'bodyGrid':[4,5],'faceGrid':[1,18],'newBodyDrawings':40,'newFaceDrawings':18,
                  'source':'builtin ImageGen','body':body_meta,'faces':face_meta,
                  'faceOverlayRules':{'mouth':list(range(8)),'eyes':list(range(8,14)),'emotion':list(range(14,18)),
                     'alignedTo':'original team-atlas idle column','outsideMasksTransparent':True,'featherPx':.65},
                  'rawSources':{kind:{'file':f'{kind}-generated.png','sha256':hashlib.sha256((ROOT/role/f'{kind}-generated.png').read_bytes()).hexdigest(),
                                     'mode':'RGB with solid magenta key'} for kind in ['activity','reactions','face']}}
        (ROOT/role/'registration.json').write_text(json.dumps(metadata,indent=2)+'\n')
        print(role,'40 body +18 face registered, unique hashes, complete silhouettes')


if __name__=='__main__':
    main()
