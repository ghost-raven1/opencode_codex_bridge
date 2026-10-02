"""Register ImageGen art and extract true rig layers; no procedural character drawing."""
from pathlib import Path
import json
import numpy as np
from PIL import Image, ImageDraw, ImageChops

HERE = Path(__file__).resolve().parent

SIZE = (256, 384)
SOURCE = HERE/'source'
LABELS = ['close', 'slightly-open', 'A', 'O', 'E', 'I', 'U', 'smile-speaking',
          'open', 'quarter', 'half', 'three-quarter', 'closed', 'reopen',
          'smile', 'concern', 'focus', 'surprise']
SPECS = {
 'designer': {
  'source': 'designer-v2.png', 'anchor': [538,304,13,1510], 'scaleX': .27,
  'head': [(0,0),(1024,0),(1024,281),(599,281),(563,301),(532,301),(501,296),(478,294),(421,313),(348,311),(0,310)],
  'parts': [
   {'id':'arm-left','pivot':[367,503],'motion':'arm','amplitudeDegrees':3.0,'points':[(272,244),(352,249),(380,439),(406,481),(424,496),(427,536),(410,562),(375,572),(328,558),(303,522),(283,410)]},
   {'id':'arm-right','pivot':[669,523],'motion':'arm','amplitudeDegrees':2.6,'points':[(681,303),(710,303),(790,323),(805,357),(768,407),(770,446),(735,484),(717,556),(675,585),(646,568),(636,540),(652,509),(671,461),(682,409)]},
   {'id':'braid','pivot':[487,295],'motion':'hair','amplitudeDegrees':1.8,'parent':'head','points':[(427,295),(508,279),(496,335),(470,365),(455,405),(441,436),(422,477),(419,501),(438,570),(443,627),(419,653),(415,705),(395,782),(373,779),(365,730),(334,693),(357,621),(367,555),(374,509),(388,473),(391,430),(407,398),(392,378),(411,345)]},
  ],
  'patchAnchor':[304,43,979], 'patchScale':.34,
  'faceSource': [[151,178],[220,157],[192,207]],
  'faceTarget': [[455,224],[534,208],[501,258]], 'faceOffsets':[[0,319,638],[0,243,485,729,972,1217]],
 },
 'devops': {
  'source':'devops-v2.png','anchor':[531,311,28,1507],'scaleX':.27,
  'head':[(0,0),(1024,0),(1024,220),(579,221),(567,240),(550,251),(527,247),(506,240),(490,236),(474,235),(455,254),(423,259),(0,267)],
  'parts':[
   {'id':'hip-arm','pivot':[305,436],'motion':'arm','amplitudeDegrees':1.5,'points':[(267,408),(331,434),(345,461),(334,481),(372,526),(389,552),(420,543),(443,538),(469,540),(493,555),(504,584),(481,608),(443,622),(398,626),(365,611),(335,583),(286,555),(249,534),(225,510),(226,480)]},
   {'id':'tool-arm','pivot':[700,490],'motion':'arm','amplitudeDegrees':2.1,'points':[(680,479),(722,468),(729,496),(746,476),(794,344),(839,344),(889,363),(925,465),(930,628),(886,739),(823,740),(785,659),(760,579),(733,566),(707,582),(680,564),(662,525)]},
  ],
  'patchAnchor':[764,62,976], 'patchScale':.38,
  'faceSource':[[174,164],[239,142],[213,196]],
  'faceTarget':[[451,190],[516,165],[499,218]], 'faceOffsets':[[0,307,615],[0,256,512,768,1024,1280]],
 },
 'tester': {
  'source':'tester-v2.png','anchor':[575,279,28,1508], 'headPivot':[527,279],
  'head':[(0,0),(1024,0),(1024,236),(593,236),(568,253),(547,265),(524,274),(505,265),(485,256),(451,263),(426,278),(0,278)],
  'parts':[{'id':'controller-arms','pivot':[510,553],'motion':'arm','amplitudeDegrees':1.7,
   'points':[(373,509),(350,510),(337,521),(333,542),(339,555),(359,566),(364,570),(367,580),(380,587),(399,586),(414,581),(436,565),(469,565),(483,579),(505,589),(529,586),(550,579),(568,581),(595,583),(629,586),(657,585),(670,573),(671,551),(664,539),(648,529),(639,528),(607,538),(575,541),(545,541),(525,529),(511,522),(496,515),(478,512),(464,513),(463,519),(435,520),(408,513),(401,509),(389,515),(381,519)]}],
  'faceTarget':[[455,189],[520,168],[497,226]],
 },
}


def mask(size, points):
    result = Image.new('L', size)
    ImageDraw.Draw(result).polygon(points, fill=255)
    return result


def extract(role, spec):
    """All retained ImageGen references now have real alpha; no chroma/GrabCut approximation."""
    supplied=Image.open(SOURCE/spec['source'])
    assert supplied.mode=='RGBA' and supplied.getchannel('A').getextrema()[0]==0,role
    return canonical(supplied)


def registration(spec):
    """Use one isotropic affine for the entire figure, preserving the authored anatomy."""
    center,_,top,foot=spec['anchor']
    scale=344/(foot-top)
    return {'kind':'uniform','scaleX':scale,'scaleY':scale,'offsetX':128-center*scale,
            'offsetY':368-foot*scale,'sourceTop':top,'sourceFeet':foot,'targetTop':24,'targetFeet':368}


def point(spec, p):
    transform=registration(spec)
    return [round(p[0]*transform['scaleX']+transform['offsetX'],3),
            round(p[1]*transform['scaleY']+transform['offsetY'],3)]


def legacy_point(spec,p):
    """Map existing repair masks to the same source-space anatomy before uniform placement."""
    x,y,top,foot=spec['anchor'];sy=96/(y-top) if p[1]<=120 else 248/(foot-y)
    return point(spec,[x+(p[0]-128)/spec['scaleX'],y+(p[1]-120)/sy])


def register(source, spec):
    transform=registration(spec);s=transform['scaleX']
    return source.transform(SIZE,Image.Transform.AFFINE,
        (1/s,0,-transform['offsetX']/s,0,1/s,-transform['offsetY']/s),Image.Resampling.BICUBIC)


def canonical(image):
    pixels = np.array(image)
    pixels[pixels[:,:,3]<8]=0
    pixels[pixels[:,:,3] == 0] = 0
    return Image.fromarray(pixels)


def main():
    characters = {}
    underpaint = Image.open(SOURCE/'body-underpaint.png').convert('RGBA')
    for role,spec in SPECS.items():
        folder=HERE/role; folder.mkdir(exist_ok=True)
        extracted=extract(role,spec)
        remaining=extracted.getchannel('A')
        layers=[]
        # Extract hair before arms where a braid overlaps the sleeve.
        parts=sorted(spec['parts'],key=lambda p:p['motion'] != 'hair')
        for part in parts:
            selected=ImageChops.darker(remaining,mask(extracted.size,part['points']))
            layer=extracted.copy();layer.putalpha(selected)
            remaining=ImageChops.subtract(remaining,selected)
            canonical(register(layer,spec)).save(folder/f"{part['id']}.png")
        hmask=ImageChops.darker(remaining,mask(extracted.size,spec['head']))
        head=extracted.copy();head.putalpha(hmask)
        canonical(register(head,spec)).save(folder/'head.png')
        remaining=ImageChops.subtract(remaining,hmask)
        body=extracted.copy();body.putalpha(remaining)
        body=register(body,spec)
        # Underpaint is restricted to hidden torso pixels behind the extracted limbs.
        if role=='tester':
            raw_patch=Image.open(SOURCE/'tester-v2-underpaint.png').convert('RGBA')
            # Only the area behind the original hands is used from this authored plate.
            raw_repair=mask(extracted.size,[(363,510),(548,509),(558,538),(640,538),(670,563),
                                           (659,587),(497,594),(425,572),(382,590),(342,557)])
            raw_patch.putalpha(ImageChops.darker(raw_patch.getchannel('A'),raw_repair))
            patch=register(raw_patch,spec)
        else:
            px,py,pfoot=spec['patchAnchor'];neck=point(spec,spec['anchor'][:2]);s=registration(spec)['scaleX']
            sx=spec['patchScale']*s/spec['scaleX'];sy=s*(spec['anchor'][3]-spec['anchor'][1])/(pfoot-py)
            patch=underpaint.transform(SIZE,Image.Transform.AFFINE,
                (1/sx,0,px-neck[0]/sx,0,1/sy,py-neck[1]/sy),Image.Resampling.BICUBIC)
            repair=Image.new('L',SIZE)
            polygons=([[(96,120),(123,120),(119,170),(107,191),(98,183)],[(82,163),(96,169),(93,184),(81,181)]]
                      if role=='designer' else [[(102,167),(123,167),(125,187),(106,187)],[(162,157),(174,157),(174,175),(164,177)]])
            for polygon in polygons:ImageDraw.Draw(repair).polygon([tuple(legacy_point(spec,p))for p in polygon],fill=255)
            patch.putalpha(ImageChops.darker(patch.getchannel('A'),repair))
        patch.alpha_composite(body);body=canonical(patch)
        body.save(folder/'body.png')
        layers.append({'id':'body','file':f'{role}/body.png','parent':None,'pivot':[128,368],'motion':'body','amplitudeDegrees':0})
        for part in spec['parts']:
            layers.append({'id':part['id'],'file':f"{role}/{part['id']}.png",'parent':part.get('parent','body'),
                           'pivot':point(spec,part['pivot']),'motion':part['motion'],'amplitudeDegrees':part['amplitudeDegrees']})
        layers.append({'id':'head','file':f'{role}/head.png','parent':'body','pivot':point(spec,spec.get('headPivot',spec['anchor'][:2])),'motion':'head','amplitudeDegrees':1.5})
        characters[role]={'name':role.upper(),'registration':dict(registration(spec),source=spec['source']),'roleHint':{'designer':'lead','devops':'code','tester':'review'}[role],
                          'layers':layers,'face':{'file':f'{role}/facial.png','frameHeight':384,'frames':LABELS},
                          'motion':{'breathSeconds':{'designer':4.8,'devops':5.4,'tester':3.8}[role],'gestureSeconds':3.6,'gestureIntervalSeconds':[8,15]}}
        composite=Image.new('RGBA',SIZE)
        for layer in layers: composite.alpha_composite(Image.open(HERE/layer['file']))
        for theme,color in [('light','#f7f3ed'),('dark','#17202f')]:
            preview=Image.new('RGBA',SIZE,color);preview.alpha_composite(composite)
            preview.resize((512,768),Image.Resampling.NEAREST).convert('RGB').save(folder/f'qa-{theme}.png')
    (HERE/'manifest.json').write_text(json.dumps({'version':1,'canvas':{'width':256,'height':384},'coordinates':'top-left',
      'neckAnchor':[128,120],'neckAnchorUsage':'Legacy/core default; each rig layer pivot is authoritative','feetBaseline':368,'characters':characters,
      'runtimeFiles':[layer['file'] for character in characters.values() for layer in character['layers']]
                     +[character['face']['file'] for character in characters.values()]},ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':main()
