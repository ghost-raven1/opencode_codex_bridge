"""Technical registration of ImageGen artwork; no procedural drawing of character art."""
from pathlib import Path
import importlib.util, json, sys
sys.dont_write_bytecode=True
import numpy as np
from PIL import Image, ImageDraw

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.local/animation-study'
OUT.mkdir(parents=True, exist_ok=True)
spec=importlib.util.spec_from_file_location('base_sprite_prepare', ROOT/'scripts/prepare-sprites.py')
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)
CELL=(256,384); NECK=(128,120); FOOT=368
ROLES=['lead','code','research','review']
POSE_STATES=['thinking','working_alt','success','waiting','error']
TRANS_STATES=['idle_shift','blink_half','speech_half']
POSE_ANCHORS=[
 [(132,111,16,350),(366,125,12,351),(579,115,17,351),(799,114,17,351)],
 [(130,463,369,703),(364,477,365,705),(578,466,369,707),(799,466,369,705)],
 [(130,815,723,1057),(365,831,718,1059),(578,818,723,1060),(799,819,723,1058)],
 [(131,1165,1076,1401),(365,1180,1072,1402),(578,1171,1076,1400),(799,1170,1075,1401)],
 [(131,1494,1407,1713),(365,1504,1405,1714),(578,1500,1408,1714),(799,1498,1408,1714)],
]
TRANS_ANCHORS=[
 [(152,143,24,425),(451,148,24,427),(746,145,26,425),(1031,142,24,425)],
 [(152,589,467,869),(451,594,467,869),(746,589,469,869),(1031,587,467,869)],
 [(152,1030,910,1312),(451,1037,910,1312),(746,1032,910,1312),(1031,1030,910,1312)],
]

def register(source,anchor,scale_x,row_bounds,column):
 neck_x,neck_y,top,soles=anchor
 # Isolate source cell so adjacent sprites cannot leak into registration padding.
 isolated=Image.new('RGBA',source.size)
 left=int(column*source.width/4);right=int((column+1)*source.width/4)
 box=(left,row_bounds[0],right,row_bounds[1]);isolated.paste(source.crop(box),box[:2])
 result=Image.new('RGBA',CELL)
 for start,end,scale_y in [(0,120,96/(neck_y-top)),(120,384,248/(soles-neck_y))]:
  transform=(1/scale_x,0,neck_x-128/scale_x,0,1/scale_y,neck_y+(start-120)/scale_y)
  band=isolated.transform((256,end-start),Image.Transform.AFFINE,transform,resample=Image.Resampling.NEAREST)
  result.paste(band,(0,start))
 alpha=np.asarray(result.getchannel('A')).copy();alpha[:18]=0;alpha[370:]=0
 pixels=np.asarray(result).copy();rgb=pixels[:,:,:3].astype('int16')
 red,green,blue=rgb[:,:,0],rgb[:,:,1],rgb[:,:,2]
 # Neutral white islands enclosed by the purple ponytail are the generated backdrop.
 if column==1:
  holes=(red>=220)&(blue-red>=0)&(green-red>=-3)&(rgb.max(axis=2)-rgb.min(axis=2)<18)
  holes[240:]=False;alpha[holes]=0
 # Remove the grey/white antialias matte at the silhouette, retaining warm ivory fabric.
 for threshold in [100,160]:
  padded=np.pad(alpha>0,1)
  interior=np.ones(alpha.shape,dtype=bool)
  for dy in range(3):
   for dx in range(3):interior &= padded[dy:dy+384,dx:dx+256]
  edge=(alpha>0)&~interior
  matte=(red>threshold)&(blue>=red-4)&(rgb.max(axis=2)-rgb.min(axis=2)<40)
  alpha[edge&matte]=0
 alpha=base.remove_speckles(alpha);pixels[:,:,3]=alpha;pixels[alpha==0]=0
 return Image.fromarray(pixels)

atlases={};metrics=[]
for name,states,anchors,row_edges,scales in [
 ('poses',POSE_STATES,POSE_ANCHORS,[0,359,713,1067,1404,1717],[1.05]*4),
 ('transitions',TRANS_STATES,TRANS_ANCHORS,[0,447,892,1330],[0.88,0.86,0.84,0.84])]:
 source=Image.open(ROOT/f'packages/companions/assets/source/{name}-generated.png').convert('RGB')
 extracted=base.remove_checkerboard(source)
 atlas=Image.new('RGBA',(1024,len(states)*384))
 for row,state in enumerate(states):
  for col,role in enumerate(ROLES):
   cell=register(extracted,anchors[row][col],scales[col],row_edges[row:row+2],col)
   bbox=cell.getbbox();assert bbox and bbox[0]>0 and bbox[2]<256,(name,state,role,bbox)
   atlas.paste(cell,(col*256,row*384))
   metrics.append({'atlas':name,'state':state,'role':role,'row':row,'column':col,'bounds':bbox,'sourceAnchor':anchors[row][col]})
 atlas.save(OUT/f'{name}.png',optimize=True)
 if name=='transitions': atlas.save(OUT/'transitions-fullbody.png',optimize=True)
 if name=='transitions':atlas.save(OUT/'transitions-fullbody.png',optimize=True)
 dark=Image.new('RGBA',atlas.size,'#17202f');dark.alpha_composite(atlas)
 dark.convert('RGB').save(OUT/f'{name}-contact.png')
 atlases[name]=atlas
manifest={'version':1,'status':'candidate','cell':{'width':256,'height':384},'columns':ROLES,'neckAnchor':{'x':128,'y':120},'feetBaseline':368,'coordinates':'pixels, top-left','atlases':{'poses':{'file':'poses.png','rows':POSE_STATES},'transitions':{'file':'transitions.png','rows':TRANS_STATES}},'frames':metrics}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Prepared 32 RGBA candidate frames, 256x384 cells; full-body artwork only, not layered.')
