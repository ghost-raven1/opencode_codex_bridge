# Layered companions

`manifest.json` is the runtime contract: seven rigs, 32 independent transparent
body/head/arm/hair/prop layers and seven 18-frame facial sheets, all on a 256×384
canvas. Neck coordinates are `(128,120)`, feet baseline `368`. Layer order is z
order; joint pivots use top-left source pixels. There is one bind pose per rig.
Continuous transforms do not count as extra drawn frames.

The three new silhouettes are deliberately different: DESIGNER has a high bun,
long braid and asymmetrical artist's apron; DEVOPS has an undercut, work overalls
and diagnostic meter; TESTER has short spiky hair, glasses and a controller.
DESIGNER includes independent braid and two arm layers. DEVOPS has a hip arm
and meter arm. TESTER's two controller forearms are one coupled layer.

LEAD, CODE, RESEARCH and REVIEW reuse the original drawn working arms/props in
row 3 of the existing layered atlases. Their heads and facial overlays remain
the original row-0 head registration. Torso regions behind the extracted hands,
book, laptop and tablets were painted with ImageGen. Only those hidden areas
are filled with the new underpainting. There are no whole-character flipbooks.

ImageGen authored the new characters, underpainting and 54 facial expressions.
The retained source PNGs are in `source/`; rejected designer/devops v1 references
and the incompatible old DevOps face sheet were removed. The old TESTER reference
was RGB with a baked checkerboard: the preparation uses measured silhouette seeds
and GrabCut to remove it. New ImageGen sources have real alpha, which is retained;
only near-invisible detached matte noise is cleared. No mouths, eyes or clothing
were drawn procedurally. `face-registration.json` records each facial source.

Reproduce with Python 3, Pillow, NumPy and OpenCV (the latter is installed only
inside the ignored project Python environment):

```sh
python3 packages/companions/assets/expansion/prepare.py
python3 packages/companions/assets/expansion/prepare_faces.py
python3 packages/companions/assets/expansion/prepare_core.py
python3 packages/companions/assets/expansion/qa.py
```

The sequence matters: specialist preparation starts the manifest; core preparation
extends it. `runtimeFiles` lists exactly the 39 image resources for the native
bundle. Source art, Python scripts, reports, voice models and QA composites do not
belong in that bundle. Regenerable light/dark and joint-limit comparisons are in
ignored `qa/` and role `qa-*.png` files.

`qa-native.mjs` captures the built macOS app at five measured work-clip phases,
both gesture styles, light/dark backgrounds and scales 0.5/2. It copies the app
to an isolated temporary bundle, disables speech/dictation and reaps its process.
Run it after `companion:build`; optional positional rig IDs narrow a follow-up:

```sh
node packages/companions/assets/expansion/qa-native.mjs
node packages/companions/assets/expansion/qa-native.mjs code tester
```

Native QA exposed a checkerboard island beside TESTER's jaw and a white fringe
on CODE's inherited sleeve. Preparation clears only the corresponding matte
areas, protects facial lights/purple cloth, and leaves all six root atlases intact.
`tests/specialist-artwork.test.ts` preserves the reproduced pixel regressions.

## Local fictional voices

`voices/profiles.json` defines `designer-local`, `devops-local`, `tester-local`.
Each uses an original VoiceDesign-generated reference, not another person's
recording and not a pitch-shifted CustomVoice preset. The free Apache-2.0 models
are pinned in `voices/models.json`; their weights live only in `.local/tts/models`.
The downloaded Base model directory is `qwen3-1.7b-base-4bit`.

`voices/generate.py` supports `download`, `design`, `clone`, `validate`. VoiceDesign
and Base run sequentially. Reference texts, descriptions, sample lengths and
generation measurements are saved in JSON beside the WAVs. Three references and
six Base-cloned phrases were generated successfully with `lang_code='Russian'`.
The file checks confirm non-empty valid PCM and finite samples; they do not claim
an independent ASR transcript or subjective listening approval. Runtime/OpenCode
playback validation is recorded separately by the main task.
