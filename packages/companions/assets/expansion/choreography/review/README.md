# REVIEW choreography

Sixteen authored drawings use 256 × 384 RGBA layered rigs, top-left pivots and
a shared foot baseline at y = 368. Seated/kneeling poses retain their physical
head scale instead of expanding to standing height. Every rig includes body,
head and independently moving forearms/hands. The four dance drawings provide
the large diagonal pose changes; safe distal joint accents avoid exposing the
hidden torso beneath a removed shoulder. Side/back views keep their actual
drawn face and use one shared empty 18-frame facial atlas.

Immutable ImageGen sources and exact prompt JSON files are in
`../../source/choreography-v1/`:

- `review.png` — first four work views and four dance drawings.
- `review-more-v1.png` — eight additional work/turnaround views.
- `review-right-profile-v2.png`, `review-right-profile-v3.png` — a separately
  drawn true right-facing profile and its proportion adjustment.
- `review-walk-phases-v3.png` — a wide contact step and bent-knee passing step,
  both facing right with the same camera and matched head scale.

The walking keys identify gait phases, rather than opposite camera directions.

`review-canonical.png` is a technical derivative of `review.png`: only RGB
under alpha zero is cleared, and the original alpha plane is preserved exactly.
The apparent gradient in the raw preview belongs to hidden transparent RGB;
the numerical alpha check found 1,061,444 fully transparent pixels. The source
is composited on a real background in local QA to avoid misleading raw previews.

All new art used the built-in `image_gen.imagegen`, with no CLI/API fallback.
The exact prompts/references are saved next to each source; unused iterations
remain available without being bundled as runtime images.

Rebuild this character from the repository root:

```sh
/Users/aleksejstarodubcev/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 packages/companions/assets/expansion/choreography/review/prepare.py
```

`spec.json` contains measured source rectangles, uniform scales, pivots and cut
polygons. Runtime interpolation clears source alpha below 24 and canonicalizes
exported alpha below 8. Cut-edge fragments are transferred to adjacent moving
layers; joint underlap extends only existing occluded edge pixels by four pixels.
No exposed face or body features are painted by the preparation script.
`headLowerEdge` and measured `headBodyPixels` exclude fabric while retaining
hair, face, neck skin and earrings. The leaning hand is separate from the
silver hair behind it. Corrected cuts use only fully opaque occluded joint
underlap to preserve exact neutral RGBA. The four-pixel pseudo-prop of the back
view is merged into its holding arm and excluded from the runtime inventory.

Runtime paths in `manifest.json` are relative to expansion: 75 unique PNG files.
Local QA lives in
`.local/choreography-qa/review/`: light/dark contact sheets, compositions,
positive/negative joint-limit previews and composition difference metrics.
Final native playback/renderer verification is handled by the parent task.

Run `test_layers.py` with the same Python for eight regression tests. Immutable
`ownership-fixtures.json` records fabric/body ownership, retained head features
and separate hair/hand ownership in the leaning pose. Source-based neutral
composition checks prevent destructive pixel cleanup. `prepare.py` does not
rewrite these independent expectations.
