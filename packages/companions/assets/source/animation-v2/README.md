# Animation artwork v2

The four `*-generated.png` files are original, unmodified outputs of the built-in
ImageGen tool. Each was generated from the corresponding `*-reference.png`
identity strip; exact prompts and original output filenames are in `prompts.json`.
Reference strips are technical crops of existing base/pose artwork, not new frames.

The source sheets contain 81 newly drawn figures: LEAD has an extra wave in row 4,
while CODE, RESEARCH and REVIEW contain 20 each. The preparation script selects 20
per character. No existing animation frames, mirrored copies or synthetic body
transforms were counted as new drawings.

## Reproduce

Use Python 3 with Pillow and NumPy, from the repository root:

```sh
python3 packages/companions/assets/source/animation-v2/prepare.py
```

The script reads only these saved sources. It removes the generated checkerboard,
cleans detached matte fragments, protects white shoes, registers whole figures,
and writes the three new atlases, manifest, dark contacts and GIF. It does not
draw characters, facial features, clothing or new poses. Technical background
removal and alignment were explicitly authorized in the task.

## Output contract

All atlas cells are 256×384 RGBA. Columns are LEAD, CODE, RESEARCH, REVIEW.
Top-left pixel coordinates; complete soles meet y368; each cell has transparent
outer padding. Ambient has 8 rows (1024×3072); entrance and transform each have 6
rows (1024×2304). There are 80 distinct registered sprite hashes in the manifest.

`animation-v2.json` exports `clips.ambient`, `clips.entrance` and
`clips.transform`, each with `atlas`, sequential row `frames`, and `durationMs`
(1200/600/700 respectively, as agreed with the native runtime owner).
Ambient contains calm prop interaction, small head/hand changes and blinks.
Entrance contains a settling step, greeting wave and welcoming gesture.
Transform is a turnaround: front, right three-quarter, right profile, back,
left profile, left three-quarter. It is not a wardrobe morph or magical effect.

## Visual checks and limits

`*-contact.png` composites every frame on the native dark background.
`animation-v2-preview.gif` is a 20-frame animated four-character preview.
The originals have baked RGB checkerboards; genuine alpha is created by the
technical preparation, not supplied by the generator. All final cells have
transparent borders and unclipped feet. White garments, silver hair, skin and
the purple ponytail are retained. Silhouette pixels are not blurred.

The generated drawings retain each adult character's identity and costume, but
are independently drawn full-body poses, with modest pose/proportion variation.
They are for the four native presets; mixed head/outfit combinations must keep
using the existing separate head/body layers. These sheets do not expose new
independently removable accessories or phoneme mouth shapes.

## Follow-up matte cleanup

`registration.json` freezes the original 80 source bounds, so mask repairs do not
change sprite scale or position. Enclosed head-region checker islands require
both neutral color and two distinct background tones; silver and mint hair use
a stricter chroma threshold. The CODE face region is excluded from the ponytail
gap mask, restoring original eye-white pixels. Opaque RGB artwork is unchanged.
`cleanup-report.json` records removed/restored alpha pixels and final hashes.
Before/after dark and white comparisons are saved under `.local/sprite-cleanup-v2/`.
The script deliberately preserves ambiguous silver/mint highlights instead of
applying a global gray-removal mask. Fine dark pixel outlines remain.
