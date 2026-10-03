# CODE choreography

Sixteen authored views and poses for the existing adult CODE companion. The
drawings were made with the built-in ImageGen tool; original generation files
are immutable under `../../source/choreography-v1/code*.png`.

`manifest.json` uses the existing `RigManifest` contract. Paths are relative to
the expansion directory. Each pose has independent body, head and arm cutouts;
most also have hair and a held-prop cutout. The dance poses change the actual
drawn arms and legs. They do not depend on rotating a standing image.

`spec.json` records measured connected-figure bounds, face landmarks, polygons
and pivots in source pixels. `prepare.py` performs one uniform registration per
pose. It preserves the current CODE eye separation where both eyes are visible,
keeps profile/back scales explicit, and puts the source sole baseline at y=368.
Sitting and kneeling figures retain their physical proportions.

The exporter removes detached sheet flecks and neutralizes only saturated red
or blue contour scribbles. It retains fingers, hair and antialiased alpha. Up to
two pixels of authored adjacent seam color extend behind opaque moving parts;
the rest composition is pixel-identical to the registered source. Joint angles
are deliberately bounded at 0.35–1 degree. Large limb motion comes from the four
different authored dance poses rather than oversized rotations across cut seams.

Measured `headCrop` contours keep collars, hoodie shoulders and neck headphones
on the body. `neckUnderlap` duplicates only opaque authored skin beneath the
original neck; the neutral RGBA composition stays exact. The seated ponytail is
an independent `hair-back` layer, and the raised-hand tip in `dance-2` belongs to
the arm rather than the head. Upper-neck anchors use the same anatomical joint,
not the lower skin/wardrobe neckline; neck headphones remain with the outfit.
The bundle contains 103 runtime PNGs.

Ten `body-under-hair` layers restore confirmed costume surfaces concealed by
the long ponytail. `code-foundations-v1.png` was drawn with ImageGen from the
fixed 16-pose reference; the exact edit prompt is saved beside it. The exporter
preserves generated alpha and clips each foundation to measured real garment
edges and opaque original hair. It never fills the complete ponytail silhouette.
Foundations are body children and precede the original hair at rest, preserving
the complete neutral RGBA drawing. Mixed outfits retain their costume foundation.
The back/waist seam and ponytail layer ownership have permanent exporter checks.

The one shared `facial.png` is an empty 18-frame atlas. These working views keep
their authored side/rear face. Use the original front-facing rig for narration;
do not put front-facing expression patches on a profile or back view.

Rebuild with a Python environment containing Pillow and NumPy:

```sh
python3 packages/companions/assets/expansion/choreography/code/prepare.py
python3 packages/companions/assets/expansion/choreography/code/validate.py
python3 packages/companions/assets/expansion/choreography/code/mixed_qa.py
```

QA contact sheets, layer views, bounded motion previews and validation output
are saved outside Git in `.local/choreography-qa/code/`. Prompt sets are saved in
`source/choreography-v1/code-generation-prompts.json`, `code-right-prompt.json`
and `code-walk-prompts.json`.
The foundation edit is recorded in `code-foundations-prompt.json`; its fixed
reference is `code-foundation-reference.png`.

`walk-left` and `walk-right` are a wide stride and a raised-knee passing phase,
authored with one camera and fixed adult proportions. Both face right and use
the same uniform scale and neck axis. They are not mirrored images. The
validator checks head height, neck alignment and distinct drawn leg silhouettes;
`walk-pair-light.png`, `walk-pair-dark.png` and `walk-authored.gif` show the result.

Validation exercises 384 frames with joint rotation and translations bounded
to 0.75 native pixels. It also retains the mixed `dance-4` regression: garment
points `(124,201)` and `(159,201)` must have body alpha 255 and head alpha 0.
`mixed_qa.py` renders all 12 core head/outfit combinations and 768 bounded samples
involving CODE in both directions, on light and dark backgrounds. These Python
composites complement the separate native AppKit verification.
