"""Publish reviewed technical cleanup candidates and refresh their recorded hashes."""
from pathlib import Path
import hashlib
import json
import shutil
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'packages/companions/assets'
CANDIDATES = ROOT / '.local/animation-study'
for name in ['poses.png', 'transitions.png', 'face-registration.json', 'poses-contact.png', 'transitions-contact.png']:
    shutil.copyfile(CANDIDATES / name, ASSETS / name)
manifest = json.loads((ASSETS / 'animation.json').read_text())
manifest['sha256'] = {name: hashlib.sha256((ASSETS / name).read_bytes()).hexdigest()
                      for name in ['poses.png', 'transitions.png']}
(ASSETS / 'animation.json').write_text(json.dumps(manifest, indent=2) + '\n')
frames = []
for name, rows in [('team-atlas.png', [0]), ('transitions.png', [0,1,3,1,0,2,4,2,0]), ('poses.png', list(range(5)))]:
    image = Image.open(ASSETS / name)
    for row in rows:
        frame = Image.new('RGBA', (1024, 384), '#17202f')
        frame.alpha_composite(image.crop((0,row*384,1024,row*384+384)))
        frames.append(frame.convert('RGB'))
frames[0].save(ASSETS / 'animation-preview.gif', save_all=True, append_images=frames[1:], duration=180, loop=0)
print('Published reviewed legacy atlas cleanup and updated hashes/previews')
