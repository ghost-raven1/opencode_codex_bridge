# LEAD and REVIEW animation v3 sources

This folder and `../review/` contain six original built-in ImageGen outputs:
20 activity drawings, 20 reaction drawings, and 18 facial drawings per character.
Exact generation prompts are preserved as `*-prompt.txt`; output provenance is
recorded in `../lead-review-provenance.json`. These are 116 new drawings, not
copies of previous poses moved or warped to inflate the frame count.

The original RGB images use a solid magenta background. `prepare.py` removes
the chroma key, removes detached decorative marks, and unmattes boundary pixels.
It preserves neutral silver hair and gray clothing instead of applying a gray
background mask. Character artwork is not procedurally drawn.

Run from the repository root with Python 3, Pillow and NumPy:

```sh
python3 packages/companions/assets/source/animation-v3/lead/prepare.py
```

The script prepares both LEAD and REVIEW. The `animation-v2/prepare.py` helper
is used only for body registration, retaining the common 256×384 cell geometry.

Each `activity-registered.png` and `reactions-registered.png` is a 4×5 sheet of
256×384 RGBA cells. Row-major indices are:

- Activity: working 0–9, thinking 10–19.
- Reactions: success 0–7, waiting 8–13, error 14–19.

Each `face-registered.png` has one column and 18 rows of 256×384 transparent
overlays, aligned to the original `team-atlas.png` idle face:

- Mouth 0–7: closed, parted, A, O, E, I, U, smiling speech.
- Eyes/brows 8–13: open, quarter, half, three-quarter, closed, reopening.
- Inner face 14–17: smile, concern, focus, surprise.

Face overlays contain actual newly generated pixels. They are registered using
the pupil and mouth landmarks, matched to the original skin palette, and masked
inside facial features with a 0.65px inward feather. Original hair, costume and
the LEAD microphone remain in the original base sprite. Facial expressions are
illustrative mouth/eyelid shapes, not measured phonetic or viseme timing.

`registration.json` records source boxes, transformations, masks and hashes.
Dark/white body contacts and `face-before-after.png` provide visual QA.
`../lead-review-validation.json` records 116 unique output cells, transparent
body borders, soles ending at pixel367 (baseline368), and zero key-magenta pixels.
`../lead-review-faces-preview.gif` previews all 18 face overlays on fixed heads.

These assets are prepared for the root assembler. This art step does not itself
verify native runtime playback or replace the mixed-outfit constructor layers.
