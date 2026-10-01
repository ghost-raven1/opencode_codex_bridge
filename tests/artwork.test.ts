import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cell, rgbaPng } from "./helpers/rgba-png.js";

const directory = fileURLToPath(new URL("../packages/companions/assets/", import.meta.url));
const hash = (pixels: Buffer) => createHash("sha256").update(pixels).digest("hex");
const roles = ["lead", "code", "research", "review"];
const manifests = [2, 3].map(version => JSON.parse(readFileSync(`${directory}animation-v${version}.json`, "utf8")));

describe("reviewed companion artwork", () => {
  it("ships sixty distinct drawn body frames per role with transparent borders and registered feet", () => {
    const hashes = roles.map(() => new Set<string>());
    for (const manifest of manifests) {
      for (const clip of Object.values(manifest.clips) as { atlas: string; frames: number[]; durationMs: number }[]) {
        const image = rgbaPng(directory + clip.atlas);
        expect(image.width).toBe(1024); expect(clip.durationMs).toBeGreaterThan(0);
        for (const row of clip.frames) {
          expect((row + 1) * 384).toBeLessThanOrEqual(image.height);
          for (let column = 0; column < 4; column++) {
            const pixels = cell(image, column, row), digest = hash(pixels);
            expect(hashes[column]!.has(digest), `${roles[column]} ${clip.atlas} ${row}`).toBe(false);
            hashes[column]!.add(digest);
            let bottom = 0;
            for (let y = 0; y < 384; y++) for (let x = 0; x < 256; x++) {
              if (!pixels[(y * 256 + x) * 4 + 3]) continue;
              if (!x || x === 255 || !y || y === 383) throw new Error(`Clipped cell: ${clip.atlas}/${column}/${row}`);
              bottom = y;
            }
            expect(bottom).toBeGreaterThanOrEqual(367); expect(bottom).toBeLessThanOrEqual(369);
          }
        }
      }
    }
    expect(hashes.map(set => set.size)).toEqual([60, 60, 60, 60]);
  });

  it("ships eighteen separate face patches per role and confines them to the original face", () => {
    const image = rgbaPng(directory + "facial-v3.png");
    expect([image.width, image.height]).toEqual([1024, 6912]);
    for (let column = 0; column < 4; column++) {
      const hashes = new Set<string>();
      for (let row = 0; row < 18; row++) {
        const pixels = cell(image, column, row); hashes.add(hash(pixels));
        let visible = 0;
        for (let y = 0; y < 384; y++) for (let x = 0; x < 256; x++) {
          if (!pixels[(y * 256 + x) * 4 + 3]) continue;
          if (x < 80 || x > 185 || y < 40 || y > 118) throw new Error(`Face overlay changes silhouette: ${column}/${row}`);
          visible++;
        }
        expect(visible).toBeGreaterThan(8);
      }
      expect(hashes.size).toBe(18);
    }
  });

  it("retains CODE's working sleeve when another head is selected", () => {
    const pixels = cell(rgbaPng(directory + "mixed-body-atlas.png"), 1, 3);
    let visible = 0;
    for (let y = 120; y < 150; y++) for (let x = 150; x < 180; x++) if (pixels[(y * 256 + x) * 4 + 3]! > 200) visible++;
    // The old head mask left only80 of these900 sleeve pixels.
    expect(visible).toBeGreaterThan(850);
  });
});
