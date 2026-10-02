"""Register the approved adult core-v2 artwork as independently movable cutout rigs."""
from pathlib import Path
import json
import numpy as np
from PIL import Image, ImageChops, ImageDraw

HERE = Path(__file__).resolve().parent
SIZE = (256, 384)
ROLES = ['lead', 'code', 'research', 'review']
# Measured in a 512 x 768 source column; one uniform affine preserves anatomy.
SPECS = {
 'lead': {'top':16,'feet':753,'center':311.5,'neck':[282,149],
  'face':[[254,104],[293,94],[277,124]],'backing':[9,29],
  'head':[(0,0),(512,0),(512,135),(344,135),(318,140),(307,139),(293,151),(283,158),(277,161),(264,157),(250,151),(236,154),(210,151),(184,144),(0,145)],
  'arm-right':[(180,165),(222,193),(224,211),(216,228),(214,251),(207,272),(193,276),(177,265),(178,245),(188,228),(184,215),(184,200),(190,188)],
  'arm-left':[(282,239),(299,238),(309,246),(319,250),(339,254),(348,259),(350,276),(339,282),(319,279),(307,278),(284,272),(271,266),(269,259),(277,255),(271,251),(276,246)],
  'prop':[(199,218),(281,209),(309,281),(224,291)],'pivots':[[341,267],[199,260],[271,275]]},
 'code': {'top':8,'feet':750,'center':256,'neck':[276,157],
  'face':[[267,92],[305,104],[281,123]],'backing':[0,30],
  # Follow the ponytail's inner edge and headphone cups. Hood and lower sleeve
  # stay on the body so mixed heads cannot carry their original outfit with them.
  'head':[(0,0),(512,0),(512,137),(330,138),(330,143),(331,159),(327,172),(322,177),(313,178),(310,175),(302,170),(300,166),(286,157),(273,153),(261,155),(252,172),(245,178),(235,180),(226,177),(217,169),(216,161),(216,152),(212,145),(199,149),(193,156),(190,168),(185,175),(183,186),(178,197),(176,210),(168,227),(164,250),(155,276),(151,292),(147,306),(137,316),(122,326),(110,330),(0,350)],
  'hair-back':[(0,0),(234,0),(234,45),(230,63),(229,96),(217,127),(212,145),(199,149),(193,156),(190,168),(185,175),(183,186),(178,197),(176,210),(168,227),(164,250),(155,276),(151,292),(147,306),(137,316),(122,326),(110,330),(0,350)],
  'arm-left':[(183,285),(198,286),(207,289),(217,288),(217,300),(211,307),(201,312),(194,311),(185,305),(182,297)],
  'arm-right':[(252,255),(263,250),(275,250),(286,253),(292,257),(304,259),(319,268),(321,281),(315,286),(299,283),(289,279),(279,278),(273,271),(266,271),(261,267),(255,270),(250,266)],
  'prop':[(118,211),(231,211),(248,272),(316,280),(316,295),(148,297),(140,277)],'pivots':[[198,308],[316,277],[246,286]]},
 'research': {'top':16,'feet':752,'center':249,'neck':[229,148],
  'face':[[222,98],[259,107],[236,126]],'backing':[-6,30],
  'head':[(0,0),(512,0),(512,141),(315,146),(312,159),(284,163),(261,150),(237,139),(227,143),(211,145),(198,143),(179,153),(158,155),(143,146),(0,148)],
  'arm-left':[(187,250),(208,240),(222,227),(234,225),(241,230),(250,230),(254,235),(249,239),(253,242),(251,247),(243,249),(250,252),(247,257),(236,258),(228,267),(210,274),(186,283),(181,271)],
  'arm-right':[(298,239),(306,241),(311,247),(317,247),(327,237),(332,239),(331,256),(328,267),(320,278),(319,291),(307,294),(296,285),(294,274),(288,268),(291,262),(298,263),(293,255),(294,250)],
  'prop':[(249,187),(288,188),(327,208),(362,184),(385,187),(360,236),(335,279),(293,284),(223,267),(227,229)],'pivots':[[190,266],[314,283],[302,269]]},
 'review': {'top':16,'feet':753,'center':219,'neck':[213,144],
  'face':[[184,104],[221,92],[205,124]],'backing':[-15,31],
  'head':[(0,0),(512,0),(512,142),(271,139),(262,139),(241,140),(225,143),(212,149),(204,150),(190,141),(175,142),(154,165),(126,153),(108,151),(0,151)],
  'arm-left':[(121,243),(130,238),(139,240),(144,246),(145,256),(141,259),(143,264),(139,270),(145,277),(143,287),(137,294),(123,294),(114,282),(108,274),(110,261),(116,252)],
  'arm-right':[(180,218),(191,215),(199,221),(202,227),(211,230),(213,238),(224,251),(238,259),(274,264),(290,269),(290,288),(285,296),(271,296),(251,288),(227,279),(216,270),(209,261),(200,256),(195,248),(190,240),(181,238),(180,232),(185,227),(176,225)],
  'prop':[(86,199),(108,197),(108,180),(121,180),(130,196),(159,194),(202,282),(120,291)],'pivots':[[126,287],[285,282],[169,279]]},
}


def canonical(image):
    """Drop only the almost transparent outside halo, preserving the authored contour."""
    pixels = np.array(image); pixels[pixels[:, :, 3] < 8] = 0
    return Image.fromarray(pixels)


def mask(points):
    result = Image.new('L', (512, 768)); ImageDraw.Draw(result).polygon(points, fill=255)
    return result


def registration(role):
    spec = SPECS[role]; scale = 344 / (spec['feet'] - spec['top'])
    return {'kind':'uniform','source':'core-v2.png','sourceRect':[ROLES.index(role)*512,0,512,768],
            'scaleX':scale,'scaleY':scale,'offsetX':128-spec['center']*scale,
            'offsetY':368-spec['feet']*scale,'sourceTop':spec['top'],'sourceFeet':spec['feet'],
            'targetTop':24,'targetFeet':368,'coordinateSpace':'sourceRect'}


def point(role, value):
    r = registration(role)
    return [round(value[0]*r['scaleX']+r['offsetX'],3),round(value[1]*r['scaleY']+r['offsetY'],3)]


def register(image, role):
    r = registration(role); s = r['scaleX']
    return canonical(image.transform(SIZE,Image.Transform.AFFINE,
        (1/s,0,-r['offsetX']/s,0,1/s,-r['offsetY']/s),Image.Resampling.BICUBIC))


def main():
    from prepare_core_faces import prepare_faces
    manifest = json.loads((HERE/'manifest.json').read_text())
    source = Image.open(HERE/'source/core-v2.png').convert('RGBA')
    hidden = Image.open(HERE/'source/core-v2-underpaint.png').convert('RGBA')
    backing = Image.open(HERE/'source/core-v2-body-backing.png').convert('RGBA')
    hair_backing = Image.open(HERE/'source/core-v2-code-hair-backing.png').convert('RGBA')
    labels = manifest['characters']['tester']['face']['frames']
    report = json.loads((HERE/'face-registration.json').read_text())
    for column,role in enumerate(ROLES):
        spec = SPECS[role]; folder = HERE/role; folder.mkdir(exist_ok=True)
        box = (column*512,0,(column+1)*512,768)
        original = canonical(source.crop(box)); remaining = original.getchannel('A')
        arm_removed = Image.new('L',original.size)
        for part in ['arm-left','arm-right','prop']:
            selected = ImageChops.darker(remaining,mask(spec[part]))
            layer = original.copy(); layer.putalpha(selected)
            register(layer,role).save(folder/f'{part}.png',optimize=True)
            arm_removed = ImageChops.lighter(arm_removed,selected)
            remaining = ImageChops.subtract(remaining,selected)
        head_mask = ImageChops.darker(remaining,mask(spec['head']))
        head = original.copy(); head.putalpha(head_mask)
        if role == 'code':
            # The ponytail belongs behind clothing in every outfit. Its source
            # laptop occlusion is filled by authored hair, never a clothing patch.
            hair_mask = ImageChops.darker(head_mask,mask(spec['hair-back']))
            hair = original.copy(); hair.putalpha(hair_mask)
            missing = original.copy(); missing.putalpha(arm_removed)
            restored = canonical(hair_backing.transform(SIZE,Image.Transform.AFFINE,
                (4,0,8,0,4,72),Image.Resampling.BICUBIC))
            restored.putalpha(ImageChops.darker(restored.getchannel('A'),register(missing,role).getchannel('A')))
            restored.alpha_composite(register(hair,role))
            canonical(restored).save(folder/'hair-back.png',optimize=True)
            head.putalpha(ImageChops.subtract(head_mask,hair_mask))
        register(head,role).save(folder/'head.png',optimize=True)
        remaining = ImageChops.subtract(remaining,head_mask)
        body = original.copy(); body.putalpha(remaining)
        repair = canonical(hidden.crop(box)); repair.putalpha(ImageChops.darker(repair.getchannel('A'),arm_removed))
        dx,dy = spec['backing']
        neck_backing = backing.crop(box).transform(original.size,Image.Transform.AFFINE,
            (1,0,-dx,0,1,-dy),Image.Resampling.BICUBIC)
        neck_backing.putalpha(ImageChops.darker(neck_backing.getchannel('A'),head_mask))
        neck_backing.alpha_composite(repair); neck_backing.alpha_composite(body)
        register(neck_backing,role).save(folder/'body.png',optimize=True)
        layers = [{'id':'body','file':f'{role}/body.png','parent':None,'pivot':[128,368],'motion':'body','amplitudeDegrees':0}]
        if role == 'code':
            layers.insert(0,{'id':'hair-back','file':'code/hair-back.png','parent':'head',
                            'pivot':point(role,spec['neck']),'motion':'hair','amplitudeDegrees':0})
        for part in ['prop','arm-left','arm-right']:
            pivot = spec['pivots'][['arm-left','arm-right','prop'].index(part)]
            layers.append({'id':part,'file':f'{role}/{part}.png','parent':'body','pivot':point(role,pivot),
                           'motion':'prop' if part=='prop' else 'arm','amplitudeDegrees':1.2 if part=='prop' else 2.5})
        layers.append({'id':'head','file':f'{role}/head.png','parent':'body','pivot':point(role,spec['neck']),
                       'motion':'head','amplitudeDegrees':1.5})
        manifest['characters'][role] = {'name':role.upper(),'roleHint':role,'registration':registration(role),'layers':layers,
            'face':{'file':f'{role}/facial.png','frameHeight':384,'frames':labels},
            'motion':{'breathSeconds':4.6,'gestureSeconds':4.0,'gestureIntervalSeconds':[8,15]}}
        report[role] = prepare_faces(role,labels)
        composed = Image.new('RGBA',SIZE)
        for layer in layers: composed.alpha_composite(Image.open(HERE/layer['file']))
        for theme,color in [('light','#f7f3ed'),('dark','#17202f')]:
            preview = Image.new('RGBA',SIZE,color); preview.alpha_composite(composed)
            preview.resize((512,768),Image.Resampling.NEAREST).convert('RGB').save(folder/f'qa-{theme}.png')
    manifest['neckAnchorUsage'] = 'Legacy fallback only; each rig layer pivot is authoritative'
    manifest['runtimeFiles'] = [l['file'] for d in manifest['characters'].values() for l in d['layers']] + [d['face']['file'] for d in manifest['characters'].values()]
    (HERE/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    (HERE/'face-registration.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')


if __name__ == '__main__': main()
