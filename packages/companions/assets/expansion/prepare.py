"""Register ImageGen art and extract true rig layers; no procedural character drawing."""
from pathlib import Path
import hashlib
import json
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageChops

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
sys.path.append(str(ROOT/'.local/tts/.venv/lib/python3.12/site-packages'))
import cv2

SIZE = (256, 384)
SOURCE = HERE/'source'
LABELS = ['close', 'slightly-open', 'A', 'O', 'E', 'I', 'U', 'smile-speaking',
          'open', 'quarter', 'half', 'three-quarter', 'closed', 'reopen',
          'smile', 'concern', 'focus', 'surprise']
SPECS = {
 'designer': {
  'source': 'designer-v2.png', 'anchor': [538,304,13,1510], 'scaleX': .27,
  'outline': [(543,14),(597,15),(644,44),(644,130),(622,150),(642,194),(633,250),(594,273),(596,293),(574,302),(583,313),(640,322),(666,364),(685,396),(696,383),(681,312),(705,307),(730,313),(739,310),(769,330),(789,350),(765,374),(753,401),(759,418),(736,449),(723,488),(703,542),(675,578),(635,571),(650,602),(705,627),(705,681),(679,716),(701,767),(740,825),(725,850),(733,907),(758,967),(810,1024),(852,1101),(872,1171),(908,1266),(878,1304),(823,1294),(779,1321),(708,1349),(693,1427),(680,1487),(628,1512),(596,1499),(595,1468),(610,1390),(625,1354),(562,1339),(530,1320),(456,1325),(409,1350),(406,1418),(399,1453),(357,1454),(303,1474),(229,1468),(227,1451),(272,1420),(322,1358),(344,1305),(334,1281),(366,1190),(322,1191),(353,1091),(385,968),(402,894),(389,858),(404,817),(395,782),(380,780),(374,746),(352,698),(336,692),(354,629),(356,594),(357,566),(342,558),(322,531),(318,486),(307,440),(301,404),(286,377),(286,348),(308,315),(300,267),(305,260),(315,270),(329,315),(341,315),(348,340),(341,395),(356,442),(370,477),(385,448),(393,421),(404,393),(394,376),(407,342),(423,322),(416,304),(388,304),(374,271),(358,260),(364,211),(359,196),(373,165),(397,132),(423,106),(449,87),(480,69),(500,38)],
  'holes': [[(347,400),(368,468),(385,431),(412,356),(396,341),(365,367)],[(667,397),(674,465),(687,439),(690,407)],[(491,1337),(538,1345),(590,1379),(576,1460),(534,1478),(490,1470)]],
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
  'outline':[(431,62),(476,36),(548,28),(602,52),(577,69),(608,80),(593,132),(585,147),(595,166),(574,194),(565,231),(603,236),(624,261),(638,299),(673,307),(695,352),(699,387),(718,424),(726,467),(713,481),(726,499),(747,483),(770,427),(802,354),(825,351),(870,362),(882,382),(869,415),(888,430),(904,473),(916,554),(911,624),(890,691),(866,725),(831,727),(806,693),(786,637),(766,576),(748,551),(719,566),(696,570),(710,615),(732,652),(747,701),(746,730),(777,755),(783,835),(755,865),(743,916),(735,973),(730,1031),(730,1084),(754,1137),(765,1175),(741,1223),(727,1263),(716,1339),(759,1400),(808,1417),(831,1446),(830,1481),(781,1494),(723,1481),(650,1468),(597,1457),(596,1431),(607,1394),(634,1350),(631,1280),(615,1227),(596,1171),(584,1092),(582,1036),(587,963),(572,861),(565,798),(548,746),(540,712),(501,809),(464,883),(444,959),(407,1034),(382,1131),(365,1214),(354,1281),(358,1340),(345,1398),(384,1434),(379,1477),(340,1494),(288,1507),(226,1498),(222,1474),(244,1437),(279,1408),(282,1324),(269,1277),(275,1232),(285,1194),(280,1160),(294,1115),(311,1050),(334,986),(344,906),(360,827),(341,798),(346,743),(369,669),(399,620),(365,611),(349,594),(294,559),(255,531),(231,503),(229,482),(254,441),(270,411),(261,384),(282,365),(289,339),(316,320),(340,306),(356,285),(386,281),(429,296),(445,279),(438,254),(413,249),(397,226),(378,220),(366,185),(369,151),(391,114),(387,99)],
  'holes':[[(333,470),(362,509),(382,550),(427,518),(445,533),(450,481),(413,433),(385,421)],[(794,552),(812,609),(825,651),(846,675),(865,661),(886,610),(887,545),(876,480),(866,449),(854,478),(853,529),(830,549)]],
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
  'source':'tester.png','anchor':[528,352,81,1439],'scaleX':.31,
  'outline':[(478,95),(508,80),(546,90),(575,119),(607,128),(637,159),(623,181),(639,207),(628,257),(596,291),(594,314),(631,321),(655,363),(681,401),(697,447),(699,477),(721,507),(734,537),(726,569),(708,600),(675,624),(654,626),(656,653),(670,700),(694,748),(675,777),(660,785),(653,837),(672,895),(693,952),(712,1021),(719,1084),(720,1150),(730,1189),(751,1217),(752,1251),(736,1283),(744,1332),(773,1373),(783,1408),(778,1436),(739,1440),(699,1428),(676,1404),(657,1358),(645,1311),(613,1285),(595,1241),(576,1190),(564,1135),(563,1083),(563,1039),(550,984),(522,895),(502,825),(496,782),(478,849),(466,912),(463,973),(463,1036),(469,1099),(477,1136),(472,1183),(477,1232),(499,1267),(498,1303),(487,1335),(480,1371),(460,1394),(430,1397),(410,1422),(372,1428),(333,1424),(312,1414),(313,1395),(326,1371),(361,1336),(384,1282),(369,1225),(369,1177),(375,1126),(374,1071),(376,1018),(364,959),(359,906),(354,853),(338,845),(331,814),(333,763),(320,765),(295,747),(297,732),(324,686),(337,638),(331,619),(313,601),(300,574),(301,539),(317,506),(322,467),(339,425),(370,390),(398,362),(437,336),(461,325),(442,314),(413,318),(389,296),(375,270),(355,263),(354,241),(365,224),(369,193),(387,174),(373,158),(402,157),(426,122),(459,107)],
  'holes':[[(481,1022),(502,1057),(530,1143),(548,1236),(574,1312),(610,1406),(526,1446),(485,1388),(512,1285),(491,1190)]],
  'head':[(0,0),(1024,0),(1024,304),(600,304),(575,330),(548,351),(522,357),(495,346),(467,329),(440,323),(0,322)],
  'parts':[{'id':'controller-arms','pivot':[520,560],'motion':'arm','amplitudeDegrees':1.7,'points':[(345,542),(361,534),(377,542),(398,536),(444,535),(452,541),(460,532),(490,536),(517,551),(545,562),(599,563),(620,550),(638,552),(652,575),(652,603),(633,613),(605,612),(560,609),(530,610),(510,609),(490,611),(472,606),(458,598),(447,580),(417,580),(408,598),(394,610),(366,613),(345,605),(333,591),(328,571),(331,554)]}],
  'patchAnchor':[1234,73,966], 'patchScale':.39,
  'faceSource':[[164,181],[236,160],[207,219]],
  'faceTarget':[[461,247],[532,227],[507,292]], 'faceOffsets':[[0,314,628],[0,249,499,749,999]],
 },
}


def mask(size, points):
    result = Image.new('L', size)
    ImageDraw.Draw(result).polygon(points, fill=255)
    return result


def extract(role, spec):
    """Measured silhouette provides GrabCut seeds; no AI pixels are painted by code."""
    supplied=Image.open(SOURCE/spec['source'])
    if supplied.mode=='RGBA' and supplied.getchannel('A').getextrema()[0]==0:
        pixels=np.array(supplied)
        # ImageGen stores a few almost invisible matte speckles outside the real silhouette.
        pixels[pixels[:,:,3]<8]=0
        return Image.fromarray(pixels)
    raw = supplied.convert('RGB')
    polygon = np.array(mask(raw.size, spec['outline']))
    for hole in spec['holes']:
        polygon[np.array(mask(raw.size, hole)) > 0] = 0
    kernel = np.ones((15,15), np.uint8)
    core = cv2.erode(polygon, kernel)
    outer = cv2.dilate(polygon, kernel)
    seeds = np.where(outer == 0, cv2.GC_BGD, cv2.GC_PR_BGD).astype('uint8')
    seeds[polygon > 0] = cv2.GC_PR_FGD
    seeds[core > 0] = cv2.GC_FGD
    cv2.setRNGSeed(1)
    cv2.grabCut(np.array(raw), seeds, None, np.zeros((1,65)), np.zeros((1,65)), 4, cv2.GC_INIT_WITH_MASK)
    alpha = np.where((seeds == cv2.GC_FGD)|(seeds == cv2.GC_PR_FGD), 255, 0).astype('uint8')
    if role == 'tester':
        rgb=np.array(raw).astype('int16')
        neutral=(rgb.max(2)-rgb.min(2)<20)&(rgb.min(2)>70)
        # Protect the real light eye/teeth pixels, not a rectangle that also covers
        # the baked checkerboard between hair, jaw and neck.
        protected=Image.new('L',raw.size)
        draw=ImageDraw.Draw(protected)
        draw.polygon([(430,224),(479,226),(485,256),(463,275),(439,266)],fill=255)
        draw.polygon([(500,209),(550,207),(558,233),(543,250),(505,248)],fill=255)
        draw.polygon([(482,278),(529,275),(531,298),(505,308),(484,298)],fill=255)
        neutral[np.array(protected)>0]=False
        border=cv2.dilate((alpha==0).astype('uint8'),np.ones((35,35),np.uint8))>0
        # A checkerboard island enclosed by jaw/hair/collar is not an outer edge.
        # This head has warm hair and skin; the only intentional neutral lights are
        # the protected facial features. Keep this rule away from the pale shirt.
        head_region=np.zeros(alpha.shape,dtype=bool);head_region[:335]=True
        head_matte=(rgb.max(2)-rgb.min(2)<40)&(rgb.min(2)>55)&(np.array(protected)==0)
        alpha[(neutral&border)|(head_matte&head_region)]=0
        # Trouser/cuff folds can put an exterior checkerboard island deeper than the
        # border radius. Follow only neutral pixels connected to transparency;
        # the authored dark outline separates real gray cloth/hardware from it.
        _,matte_labels=cv2.connectedComponents(((alpha==0)|neutral).astype('uint8'),8)
        outside_labels=np.unique(matte_labels[alpha==0])
        clothing=np.zeros(alpha.shape,dtype=bool);clothing[335:1320]=True
        alpha[clothing&neutral&np.isin(matte_labels,outside_labels)]=0
    # Connected thin outlines count as artwork; detached matte speckles do not.
    count, labels, stats, _ = cv2.connectedComponentsWithStats(alpha, 8)
    for index in range(1, count):
        if stats[index,cv2.CC_STAT_AREA] < 40: alpha[labels == index] = 0
    out = raw.convert('RGBA'); out.putalpha(Image.fromarray(alpha))
    return out


def point(spec, p):
    x,y,top,foot = spec['anchor']
    sy = 96/(y-top) if p[1] <= y else 248/(foot-y)
    return [round(128+(p[0]-x)*spec['scaleX'],3),round(120+(p[1]-y)*sy,3)]


def register(source, spec):
    x,y,top,foot = spec['anchor']
    output = Image.new('RGBA', SIZE)
    for start,end,sy in [(0,120,96/(y-top)),(120,384,248/(foot-y))]:
        band = source.transform((256,end-start), Image.Transform.AFFINE,
          (1/spec['scaleX'],0,x-128/spec['scaleX'],0,1/sy,y+(start-120)/sy),Image.Resampling.BICUBIC)
        output.paste(band,(0,start))
    return output


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
        original=register(extracted,spec)
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
        # Underpaint is restricted to holes inside the removed limbs/hair, behind original pixels.
        px,py,pfoot=spec['patchAnchor'];sx=spec['patchScale'];sy=248/(pfoot-py)
        patch=underpaint.transform(SIZE,Image.Transform.AFFINE,(1/sx,0,px-128/sx,0,1/sy,py-120/sy),Image.Resampling.BICUBIC)
        repair=Image.new('L',SIZE)
        if role=='designer': polygons=[[(96,120),(123,120),(119,170),(107,191),(98,183)],[(82,163),(96,169),(93,184),(81,181)]]
        elif role=='devops': polygons=[[(102,167),(123,167),(125,187),(106,187)],[(162,157),(174,157),(174,175),(164,177)]]
        else: polygons=[[(64,156),(156,156),(176,165),(176,187),(66,187)]]
        for polygon in polygons: ImageDraw.Draw(repair).polygon(polygon,fill=255)
        patch.putalpha(ImageChops.darker(patch.getchannel('A'),repair))
        patch.alpha_composite(body);body=canonical(patch)
        body.save(folder/'body.png')
        layers.append({'id':'body','file':f'{role}/body.png','parent':None,'pivot':[128,368],'motion':'body','amplitudeDegrees':0})
        for part in spec['parts']:
            layers.append({'id':part['id'],'file':f"{role}/{part['id']}.png",'parent':part.get('parent','body'),
                           'pivot':point(spec,part['pivot']),'motion':part['motion'],'amplitudeDegrees':part['amplitudeDegrees']})
        layers.append({'id':'head','file':f'{role}/head.png','parent':'body','pivot':[128,120],'motion':'head','amplitudeDegrees':1.5})
        characters[role]={'name':role.upper(),'roleHint':{'designer':'lead','devops':'code','tester':'review'}[role],
                          'layers':layers,'face':{'file':f'{role}/facial.png','frameHeight':384,'frames':LABELS},
                          'motion':{'breathSeconds':{'designer':4.8,'devops':5.4,'tester':3.8}[role],'gestureSeconds':3.6,'gestureIntervalSeconds':[8,15]}}
        composite=Image.new('RGBA',SIZE)
        for layer in layers: composite.alpha_composite(Image.open(HERE/layer['file']))
        for theme,color in [('light','#f7f3ed'),('dark','#17202f')]:
            preview=Image.new('RGBA',SIZE,color);preview.alpha_composite(composite)
            preview.resize((512,768),Image.Resampling.NEAREST).convert('RGB').save(folder/f'qa-{theme}.png')
    (HERE/'manifest.json').write_text(json.dumps({'version':1,'canvas':{'width':256,'height':384},'coordinates':'top-left',
      'neckAnchor':[128,120],'feetBaseline':368,'characters':characters,
      'runtimeFiles':[layer['file'] for character in characters.values() for layer in character['layers']]
                     +[character['face']['file'] for character in characters.values()]},ensure_ascii=False,indent=2)+'\n')


if __name__=='__main__':main()
