"""Register and composite ImageGen facial patches onto unchanged base sprites for stable loops."""
from pathlib import Path
import json
import numpy as np
from PIL import Image,ImageDraw,ImageFilter
import sys
sys.dont_write_bytecode = True
ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'.local/animation-study'
OUT.mkdir(parents=True, exist_ok=True)
base=Image.open(ROOT/'packages/companions/assets/team-atlas.png').convert('RGBA')
raw=Image.open(OUT/'transitions-fullbody.png').convert('RGBA')
result=Image.new('RGBA',(1024,1920))
# Restrict technical registration to facial features; silhouettes and clothing remain original.
rects=[(95,61,150,106),(112,60,161,104),(100,64,158,111),(119,58,165,110)]
registrations=[]
for col,rect in enumerate(rects):
 original=base.crop((col*256,0,(col+1)*256,384))
 neutral=raw.crop((col*256,0,(col+1)*256,384))
 mask=Image.new('L',(256,384));ImageDraw.Draw(mask).ellipse(rect,fill=255)
 selection=np.asarray(mask)>0;target=np.asarray(original).astype('int16')
 best=None
 for dx in range(-16,17):
  for dy in range(-12,13):
   shifted=Image.new('RGBA',original.size);shifted.paste(neutral,(dx,dy))
   candidate=np.asarray(shifted).astype('int16')
   error=np.mean(np.abs(candidate[:,:,:3][selection]-target[:,:,:3][selection]))
   if best is None or error<best[0]:best=(error,dx,dy)
 _,dx,dy=best
 mask=mask.filter(ImageFilter.GaussianBlur(1.0))
 for row in range(5):
  source=raw if row<3 else base
  source_row=row if row<3 else 2 if row==3 else 1
  candidate=source.crop((col*256,source_row*384,(col+1)*256,(source_row+1)*384))
  shifted=Image.new('RGBA',original.size);shifted.paste(candidate,(dx,dy) if row<3 else (0,0))
  cell=Image.composite(shifted,original,mask)
  # Composite alpha is exactly the original sprite: no face-cut holes or changed silhouette.
  cell.putalpha(original.getchannel('A'))
  result.paste(cell,(col*256,row*384))
 registrations.append({'role':['lead','code','research','review'][col],'faceRect':rect,'translation':[dx,dy],'meanColorError':round(float(best[0]),2)})
result.save(OUT/'transitions-stable.png',optimize=True)
result.save(OUT/'transitions.png',optimize=True)
preview=Image.new('RGBA',result.size,'#17202f');preview.alpha_composite(result);preview.convert('RGB').save(OUT/'transitions-stable-contact.png');preview.convert('RGB').save(OUT/'transitions-contact.png')
(OUT/'face-registration.json').write_text(json.dumps(registrations,indent=2)+'\n')
print(registrations)
