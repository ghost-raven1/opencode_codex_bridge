# RESEARCH choreography artwork

Sixteen independently drawn poses exported as registered RGBA cutout rigs, compatible with the 256 × 384 native canvas and feet baseline 368.

- Four first-sheet working views: left three-quarter, left profile, rear three-quarter with an over-shoulder look, seated reading.
- Four distinct swing/Charleston drawings: poised hands, wide diagonal step, raised-arm heel lift, opposite raised-foot step.
- Extra actions: right three-quarter, right profile, back, two walking phases, kneel, lean on desk, seated desk work.
- The left profile and right three-quarter are separately authored ImageGen views. No final rig uses a reflected source.
- `walk-left` / `walk-right` are compatibility keys for a right-facing contact / passing pair. Both face right, with visibly different leg poses. They must alternate without a facing change. The final contact drawing was authored from the passing reference to keep the head, costume and vertical scale consistent.
- Every rig has body, head and at least one separate arm. Most have two arms and a separate book. Head size is comparable to the original RESEARCH rig (standing head bbox 78 × 69); seated and kneeling figures preserve physical scale instead of being stretched to standing height.
- Legs remain in the body layer. Major dancing and walking changes come from four and two separately drawn poses, respectively; this export does not introduce an articulated leg skeleton.
- The facial overlay is one shared empty 18-row atlas. `face.neutralOnly` preserves the authored angle. Speech should use the existing front rig and its expressions.
- Work/walk arm limits are about 1–2 degrees; dance arm limits are 2.2–2.6 degrees. Six-pixel hidden underlap is restricted to the original opaque silhouette and uses adjacent authored pixels. Detached arm/page flecks are excluded from the head layer and returned to the body.
- Source alpha is preserved. Alpha below 8 is canonicalized to zero RGBA; alpha 250+ becomes 255 before partitioning. Confirmed saturated matte flecks are removed only at the perimeter, with opaque interior art protected. Raw originals remain unchanged.
- The head owns hair, face, neck skin, glasses and earrings. Collar and shoulders stay in the body; the chin-supporting hand stays in its arm. Measured neckline and arm contours preserve exact neutral RGBA. `ownership.json` records 24 source landmarks for regression checks, including the raised-arm/hair seam in `dance-3`, five bob-tip landmarks and two chin-edge points in `work-three-quarter`. That pose includes its faint hair fringe and chin edge explicitly and excludes the head-only area from body underlap, so mixed heads cannot expose green strands or copied chin pixels in the outfit.

Reproduce with Python 3, Pillow and NumPy:

```sh
python3 packages/companions/assets/expansion/choreography/research/prepare.py
python3 packages/companions/assets/expansion/choreography/research/validate.py
python3 packages/companions/assets/expansion/choreography/research/audit_masks.py
```

For a repair of one existing pose, append `--pose work-three-quarter` to the export command. This preserves the other rigs, shared facial atlas and source files; its contact sheet and report receive the pose suffix.

`spec.json` contains measured rectangles, pivots and polygons. `manifest.json` has 16 keys and 74 referenced runtime PNGs; paths are relative to the expansion asset directory. No shared manifest or old rig is changed.

Raw drawings and built-in ImageGen prompt records live in `source/choreography-v1/research*`. Final sources are `research.png`, `research-extra.png`, `research-right-three-quarter-original.png`, `research-left-profile-original.png`, `research-walk-contact-matched-original.png` and `research-walk-passing-original.png`. Earlier walk attempts are source references only and are not runtime files.

Static validation passed for all 16 rigs: RGBA dimensions, nonempty layers, pivots/parents, uniform scale, no reflection, baseline, shared neutral facial atlas and exact byte-for-byte neutral reassembly. Light/dark contact sheets and both maximum-angle previews live in project `.local/choreography-qa/research`. Native projection, mixed appearance and live music playback are verified separately by the parent integration task.
