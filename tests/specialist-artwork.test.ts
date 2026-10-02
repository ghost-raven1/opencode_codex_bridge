import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cell, rgbaPng } from "./helpers/rgba-png.js";

const directory = fileURLToPath(new URL("../packages/companions/assets/expansion/", import.meta.url));
const manifest = JSON.parse(readFileSync(directory + "manifest.json", "utf8"));

describe("authored specialist layers", () => {
  it.each(["lead", "code", "research", "review", "designer", "devops", "tester"])("ships independently movable, transparent layers and 18 distinct face patches for %s", name => {
    const rig = manifest.characters[name];
    expect(rig.layers.some((layer: { motion: string }) => layer.motion === "arm")).toBe(true);
    for (const layer of rig.layers) {
      const image = rgbaPng(directory + layer.file);
      expect([image.width, image.height]).toEqual([256, 384]);
      let opaque = 0;
      for (let y = 0; y < 384; y++) for (let x = 0; x < 256; x++) {
        if (!image.pixels[(y * 256 + x) * 4 + 3]) continue;
        expect(x > 0 && x < 255 && y > 0 && y < 383, `${name}/${layer.id} clipped edge`).toBe(true);
        opaque++;
      }
      expect(opaque).toBeGreaterThan(20);
    }
    const faces = rgbaPng(directory + rig.face.file), hashes = new Set<string>();
    expect([faces.width, faces.height]).toEqual([256, 384 * 18]);
    for (let row = 0; row < 18; row++) {
      const pixels = cell(faces, 0, row);
      hashes.add(createHash("sha256").update(pixels).digest("hex"));
      for (let y = 0; y < 384; y++) for (let x = 0; x < 256; x++) {
        if (!pixels[(y * 256 + x) * 4 + 3]) continue;
        expect(y < 125 && x > 60 && x < 195, `${name} facial patch changes clothing or silhouette`).toBe(true);
      }
    }
    expect(hashes.size).toBe(18);
  });

  it("removes TESTER's baked checkerboard beside the jaw without erasing facial artwork", () => {
    const image = rgbaPng(directory + "tester/head.png");
    const pixel = (x: number, y: number) => [...image.pixels.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)];
    // Native dark-background QA exposed these opaque neutral checkerboard pixels in the RGB source.
    for (const [x, y] of [[144, 102], [106, 102], [111, 108], [112, 109], [114, 108]]) expect(pixel(x!, y!), `checkerboard at ${x},${y}`).toEqual([0, 0, 0, 0]);
    for (const [x, y] of [[105, 83], [128, 74], [111, 91], [121, 99], [137, 96]]) {
      expect(pixel(x!, y!)[3], `protected glasses/eyes/skin at ${x},${y}`).toBe(255);
    }
  });

  it("removes CODE's inherited white sleeve fringe while preserving adjacent purple pixels", () => {
    const image = rgbaPng(directory + "code/body.png");
    const alpha = (x: number, y: number) => image.pixels[(y * 256 + x) * 4 + 3];
    // These edge samples were opaque white/gray in row 3 of the old body atlas.
    for (const [x, y] of [[185, 129], [187, 137], [191, 148], [198, 169]]) expect(alpha(x!, y!)).toBe(0);
    for (const [x, y] of [[181, 129], [184, 137], [188, 148], [195, 169]]) expect(alpha(x!, y!)).toBe(255);
  });
});
