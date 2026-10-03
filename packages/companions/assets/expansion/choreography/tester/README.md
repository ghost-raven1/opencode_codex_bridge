# TESTER choreography

Sixteen authored drawings are exported as transparent 256 × 384 layered rigs.
Every rig has independent body, head, left/right forearms or hands; work poses
also separate the controller beneath its original fingers. Top-left pivots and
a common foot baseline at y = 368 match the native rig contract.

Six straight working views use uniform scale 0.49, bringing their top bounds to
y = 24–30 instead of y = 52–58. Their head is about 8–9% larger than at scale
0.45; this avoids a large height jump from the original TESTER v2 standing rig.
Both walking phases use scale 0.345 and retain the same head scale/direction.
Seated, kneeling and dance poses retain scale 0.45 and their lower height.
Right-side views are newly
drawn, rather than mirrored. `walk-left` and `walk-right` name two leg phases
facing the same direction: a wide contact stride and a bent-knee passing stride.
The four shuffle drawings provide the large dance pose changes. Forearm accents
stay within 2–2.5 degrees for dancing and 0.5–1 degree for work/walking.

Immutable built-in ImageGen outputs and exact prompt JSON files are retained in
`../../source/choreography-v1/`:

- `tester.png` — the initial four work views and four shuffle dance drawings.
- `tester-more-v1.png` — right-side work, back, kneeling, leaning and desk poses.
- `tester-walk-phases-v2.png` — two separately drawn complete walking phases.

The raw previews contain color gradients in invisible RGB. Actual RGBA
composition is checked on both backgrounds. Source alpha below 24 is cleared
before interpolation; runtime alpha below 8 is fully canonicalized, including
hidden RGB. Measured rectangles and a largest-silhouette component pass separate
overlapping source-sheet cells without clipping adjacent boots or hands.

Only uniform scaling is used. Polygon cuts preserve the source colors and
anatomy. Detached cut-edge pixels are transferred to their adjacent moving layer.
Joint underlap extends existing opaque body-edge pixels at most four pixels
behind a cut layer; exposed face/body artwork is never painted by this script.
New views keep their drawn faces and share one empty 18-frame facial atlas with
`neutralOnly`, so frontal mouth overlays cannot appear on a profile or back view.
`headLowerEdge` traces the actual hair/neck boundary; measured `headBodyPixels`
return confirmed yellow fabric corners to the body without changing their RGB.
Corrected joint underlap uses fully opaque occluded pixels so the neutral RGBA
composition remains exactly equal to the registered source.

Rebuild this character from the repository root:

```sh
/Users/aleksejstarodubcev/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 packages/companions/assets/expansion/choreography/tester/prepare.py
```

`spec.json` stores source rectangles, scales, measured pivots and cut polygons.
`manifest.json` contains 16 keys and 77 unique PNG paths relative to expansion.
QA is written to `.local/choreography-qa/tester/`: light/dark contact sheets,
registered/composed art, joint-limit previews and composition-difference reports.
The parent task handles final native integration, playback verification and build.

Run `test_layers.py` with the same Python for five regression tests. Immutable
`ownership-fixtures.json` covers eleven corrected head masks, retained facial
features/glasses, and the kneeling collar corner. The tests compare corrected
neutral compositions with their source. Expectations are independent of
`prepare.py` and are not overwritten on re-export.
