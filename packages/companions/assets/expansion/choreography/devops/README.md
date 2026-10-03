# DEVOPS choreography

Sixteen authored working, turning, walking and rock-dance poses for the existing
adult DEVOPS companion. The built-in ImageGen tool preserves her blue undercut,
cyan lock, orange headphones and meter, navy technician outfit and gloved hands.
Originals are immutable in `source/choreography-v1/devops*.png`; prompts are saved
beside the drawings.

`manifest.json` follows `RigManifest` v1, with independent body, head and arm
cutouts and separate work props. Generic `arm-left` and `arm-right` IDs match the
runtime work-joint mapping. The four dance frames change the actual drawn legs
and arms; movement does not depend on rotating a standing image.

`spec.json` records measured silhouette components, source polygons, joints and
eye landmarks. `prepare.py` registers each pose with one uniform scale, preserving
the current DEVOPS eye separation where visible. Profiles and closed-eye poses
have explicit measured scales. Seated and kneeling figures retain their natural
height; sole baseline is y=368. Motion limits are 0.35–0.85 degrees and narrow
two-pixel authored seam underlaps keep bounded movements connected.

The gradient visible in the raw source preview is hidden RGB with alpha zero.
The exporter clears invisible RGB and detached flecks; it preserves DEVOPS's
real cyan/navy pixels and full gloved silhouettes. Rest composition must remain
pixel-identical to the uniformly registered source. The shared 18-frame facial
atlas is empty: side/back drawings keep their real faces; use the original front
rig for narration.

Run with Python containing Pillow and NumPy:

```sh
python3 packages/companions/assets/expansion/choreography/devops/prepare.py
python3 packages/companions/assets/expansion/choreography/devops/validate.py
```

Contact sheets, cutout boards and bounded microanimation previews are written to
`.local/choreography-qa/devops/`. These are resource/raster checks; native AppKit
integration is verified separately by the parent task.

`walk-left` and `walk-right` are separately drawn wide-stride and raised-knee
passing phases. Both face right, preserve one scale and share their neck axis.
The validator checks the head height and distinct drawn leg silhouettes, then
exports light/dark walking comparisons and an authored two-phase preview.

The first three work views use the anatomy-corrected
`devops-working-v2.png` and `devops-working-profile-v2.png` drawings. A measured
uniform scale preserves the original adult stature and head size. Headphones
and collars remain on the body, outside the movable skull mask. The other
thirteen poses have measured `headCrop` boundaries with clothing and headphones
retained on the outfit. The raised forearm in `dance-3` is assigned to its arm,
and hidden authored skin at the neck keeps mixed identities connected. These
cutout changes preserve each registered drawing's exact neutral RGBA.

Native face comparison confirmed small physical skulls in `work-kneeling` and
`work-desk`. Their whole drawings receive uniform multipliers of 1.35 and 1.25,
respectively, retaining y=368 soles and independent axes of equal scale. The
resulting skull bounds are 63×53 and 63×51 native pixels, close to the standing
62×55 skull. The three corrected upright views remain byte-identical. The
validator checks these physical sizes plus 384 frames of bounded rotation and
0.75-pixel translation. The bundle contains 75 runtime PNGs.
