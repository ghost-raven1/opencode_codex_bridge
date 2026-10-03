# DESIGNER choreography artwork

Sixteen independently drawn adult DESIGNER poses exported as registered RGBA cutout rigs on the 256 × 384 native canvas, with feet baseline 368.

- Working views include left/right three-quarter, left/right profile, rear three-quarter, back, seated tablet work, kneeling, leaning at a desk and seated desk work.
- Four distinct J-pop dance drawings have different arms, leg support and movement of the thick braid and asymmetrical apron.
- `walk-left` / `walk-right` are compatibility keys for two right-facing phases: open contact step and lifted-knee passing. They alternate without a direction change.
- A right three-quarter view was separately authored in ImageGen. None of the final views are reflected. Costume, pink hair/bun, thick braid, teal bow, dark long clothing, asymmetrical apron and tools retain the DESIGNER identity.
- Work/walk rigs have seven layers: body, two forearms, tablet/stylus, braid, apron and head. Dance rigs have six layers without a held tablet. Measured pivots and low rotation limits preserve seams: work arms around 1 degree, dancing arms 2.2 degrees, braid 0.5–0.9 degrees, apron 0.25–0.5 degrees.
- Physical scale is comparable to the original DESIGNER head (68 × 69). Each source drawing has one uniform affine registration; seated/kneeling artwork is not inflated to standing height. Different hairstyles and perspective change the pixel bounds naturally.
- Legs remain in the authored body pose; major movement comes from distinct drawings. No new articulated leg skeleton is included.
- One shared transparent 18-frame facial atlas has `neutralOnly: true`. It protects the side/rear views from front-facing expression patches. Speech should use the original front rig.
- Source sheets already have true alpha; apparent RGB gradient in raw previews is under invisible pixels. Canonicalization clears invisible RGB and normalizes nearly opaque alpha before masking. The eight-cell sheets require measured component isolation to remove neighboring-cell apron/arm fragments.
- Head masks retain the connected head and exclude detached limb fragments. Original pixels excluded from a moving head remain in the body; the neutral assembly is exact. Hidden seam underlap is limited to six pixels inside the original opaque silhouette, with no added outside border.
- The head owns hair, face and neck skin; collar and shoulders remain in the body. Measured braid contours exclude adjacent dark clothing. Colour protection is restricted to annotated cut regions and two small hair-tip areas, preserving the pink braid and teal ribbons. `ownership.json` records 26 source landmarks that check these boundaries and legitimate hair tips.

Reproduce with Python 3, Pillow and NumPy:

```sh
python3 packages/companions/assets/expansion/choreography/designer/prepare.py
python3 packages/companions/assets/expansion/choreography/designer/validate.py
python3 packages/companions/assets/expansion/choreography/designer/audit_masks.py
```

`spec.json` records measured source bounds, polygons and pivots. `manifest.json` has 16 keys and 109 referenced runtime PNGs, with paths relative to the expansion directory. Shared manifests and old rigs are unchanged.

Raw artwork and built-in ImageGen prompts live in `source/choreography-v1/designer*`. Final sources are `designer.png`, `designer-extra.png`, `designer-right-three-quarter-original.png`, `designer-walk-contact-original.png` and `designer-walk-passing-original.png`. Duplicate stride attempts remain source-only and are excluded from runtime files.

Static validation passed for all 16 rigs: nonempty RGBA layers, correct dimensions, valid pivots and parents, uniform scale, no reflection, baseline, neutral facial atlas, exact neutral reassembly and existing/unique runtime paths. Project `.local/choreography-qa/designer` contains light/dark contacts, measured coordinate grids, isolated-head preview and neutral/positive/negative maximum-angle renderings. Native projection, mixed-head behavior and live choreography are verified separately by the parent integration task.
