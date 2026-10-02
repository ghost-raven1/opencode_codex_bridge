# Layered companions

`manifest.json` is the runtime contract: seven rigs, 33 independent transparent
body/head/arm/hair/prop layers and seven 18-frame facial sheets, all on a 256×384
canvas. Feet baseline is `368`; `(128,120)` is only the legacy fallback neck default.
Each layer's measured pivot is authoritative. All seven characters use one
uniform affine for the whole figure, with its source/scale/offset recorded in
`registration`; head and body never receive different axis scales. Layer order
is z order; joint pivots use top-left source pixels. There is one bind pose per rig.
Continuous transforms do not count as extra drawn frames.

The three new silhouettes are deliberately different: DESIGNER has a high bun,
long braid and asymmetrical artist's apron; DEVOPS has an undercut, work overalls
and diagnostic meter; TESTER has short spiky hair, glasses and a controller.
TESTER v2 has an adult face, fitted cropped jacket, cream top and tapered cargo
trousers; her approved source proportions and neutral face are preserved.
DESIGNER includes independent braid and two arm layers. DEVOPS has a hip arm
and meter arm. TESTER's two controller forearms are one coupled layer.

LEAD, CODE, RESEARCH and REVIEW use the approved `source/core-v2.png` redraw,
with adult proportions matching the direction of TESTER v2. Each keeps its own
hair, clothes and working prop: stylus/tablet, laptop, book and review tablet.
`prepare_core.py` registers each full figure uniformly, then extracts independent
head, arms and prop layers. Two ImageGen backing sheets fill only the holes hidden
behind those moving layers. The previous core underpainting was replaced and
removed. CODE also has a separate `hair-back` layer behind clothing; its source
laptop occlusion is restored from `core-v2-code-hair-backing.png`. Her hood and
sleeve stay with the body when another outfit uses her head. There are no
whole-character flipbooks.

ImageGen authored the new characters, underpainting and facial expression art.
The three specialists export 54 facial patches. TESTER's neutral mouth comes
from the approved reference itself, with 17 other patches registered from her
new facial sheet using individually measured cell landmarks. Focus leaves the
original pupils intact. No generated neutral patch is baked into her head.
`prepare_core_faces.py` registers the 72 existing core expression patches against
the new faces. Neutral mouth and open-eye patches copy the approved new head;
blink masks protect its eyebrows and glasses, while focus preserves its pupils.
The retained source PNGs are in `source/`; rejected designer/devops v1 references
and the incompatible old DevOps face sheet were removed. TESTER v1 and its three
obsolete face sheets were replaced and removed; they remain in Git history.
All current character references have real alpha, which is retained;
only near-invisible detached matte noise is cleared. No mouths, eyes or clothing
were drawn procedurally. `face-registration.json` records each facial source.

Reproduce with Python 3, Pillow and NumPy:

```sh
python3 packages/companions/assets/expansion/prepare.py
python3 packages/companions/assets/expansion/prepare_faces.py
python3 packages/companions/assets/expansion/prepare_core.py
python3 packages/companions/assets/expansion/qa.py
```

The sequence matters: specialist preparation starts the manifest; core preparation
extends it. `runtimeFiles` lists exactly the 40 image resources for the native
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

`tests/specialist-artwork.test.ts` checks uniform source-to-export geometry for
all seven rigs, real transparency, protected details, neutral identity and focus
pupils, including the CODE hoodie/hair ownership regression. Technical cleanup
clears near-invisible alpha noise and its hidden RGB;
it does not replace the approved character artwork. The old TESTER RGB matte
workaround was retired with v1. All six root atlases remain intact.

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
