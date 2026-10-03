import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Merge independently authored role manifests; never modify drawings or older rigs.
const directory = fileURLToPath(new URL("../packages/companions/assets/expansion/", import.meta.url));
const roles = ["lead", "code", "research", "review", "designer", "devops", "tester"];
const poses = ["work-three-quarter", "work-profile", "work-back-three-quarter", "work-seated",
  "dance-1", "dance-2", "dance-3", "dance-4", "work-right-three-quarter", "work-right-profile", "work-back",
  "walk-left", "walk-right", "work-kneeling", "work-leaning", "work-desk"];
const frames = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")).characters.lead.face.frames;
const characters = {}, files = new Set();
for (const role of roles) {
  const manifest = JSON.parse(readFileSync(join(directory, "choreography", role, "manifest.json"), "utf8"));
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.canvas, { width: 256, height: 384 });
  assert.deepEqual(Object.keys(manifest.characters).sort(), poses.map(pose => `${role}/${pose}`).sort());
  for (const [key, value] of Object.entries(manifest.characters)) {
    assert.equal(new Set(value.layers.map(layer => layer.id)).size, value.layers.length, key);
    assert(value.layers.some(layer => layer.id === "body") && value.layers.some(layer => layer.id === "head"), key);
    assert(value.layers.some(layer => layer.motion === "arm"), `${key}: independently moving arm is required`);
    assert.deepEqual(value.face.frames, frames, key);
    for (const file of [...value.layers.map(layer => layer.file), value.face.file]) {
      assert(file.startsWith(`choreography/${role}/`) && !file.split("/").includes(".."), `Unsafe asset path: ${file}`);
      const png = readFileSync(join(directory, file));
      assert.equal(png.toString("ascii", 12, 16), "IHDR", file);
      assert.equal(png.readUInt32BE(16), 256, file);
      assert.equal(png.readUInt32BE(20), file === value.face.file ? 384 * 18 : 384, file);
      assert.equal(png[24], 8, file); assert.equal(png[25], 6, `${file}: RGBA required`);
      files.add(file);
    }
    // Neutral profile/back faces never receive a frontal mouth or a 7 MiB blank decode.
    characters[key] = { ...value, face: { ...value.face, neutralOnly: true },
      motion: { ...value.motion, translationLimit: 0.75, projectedJoints: false } };
  }
}
const clips = {
  work: { selection: "activity", holdSeconds: [8, 14], turnSeconds: 0.3, settleSeconds: 0.55 },
  dance: { selection: "measured-beat", beatsPerPose: 2, transitionSeconds: 0.22, poses: ["dance-1", "dance-2", "dance-3", "dance-4"] },
  walk: { stepSeconds: 0.65, durationSeconds: 2.6, transitionSeconds: 0.22, poses: ["walk-left", "walk-right"],
    phases: ["contact", "passing"], facing: "right" },
};
writeFileSync(join(directory, "choreography.json"), JSON.stringify({
  version: 1, canvas: { width: 256, height: 384 }, coordinates: "top-left", feetBaseline: 368,
  characters, clips, runtimeFiles: [...files].sort(),
}, null, 2) + "\n");
console.log(`Prepared ${Object.keys(characters).length} layered poses for ${roles.length} characters, ${files.size} runtime images`);
