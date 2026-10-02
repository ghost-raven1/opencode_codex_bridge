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

  it("removes CODE's inherited white sleeve fringe while preserving adjacent purple pixels", () => {
    const image = rgbaPng(directory + "code/body.png");
    const alpha = (x: number, y: number) => image.pixels[(y * 256 + x) * 4 + 3];
    // These edge samples were opaque white/gray in row 3 of the old body atlas.
    for (const [x, y] of [[185, 129], [187, 137], [191, 148], [198, 169]]) expect(alpha(x!, y!)).toBe(0);
    for (const [x, y] of [[181, 129], [184, 137], [188, 148], [195, 169]]) expect(alpha(x!, y!)).toBe(255);
  });

  it.each(["designer", "devops", "tester"])("preserves the source silhouette aspect ratio with one uniform affine for %s", role => {
    const rig = manifest.characters[role], transform = rig.registration;
    expect(transform.kind).toBe("uniform");
    expect(transform.scaleX).toBe(transform.scaleY);
    expect(transform.sourceFeet * transform.scaleY + transform.offsetY).toBeCloseTo(368, 6);
    const source = rgbaPng(directory + "source/" + transform.source);
    const union = { width: 256, height: 384, pixels: Buffer.alloc(256 * 384 * 4) };
    for (const layer of rig.layers) {
      const image = rgbaPng(directory + layer.file);
      for (let at = 3; at < union.pixels.length; at += 4) union.pixels[at] = Math.max(union.pixels[at]!, image.pixels[at]!);
    }
    const original = opaqueBounds(source), actual = opaqueBounds(union);
    const expected = [original[0] * transform.scaleX + transform.offsetX,
      original[1] * transform.scaleY + transform.offsetY,
      original[2] * transform.scaleX + transform.offsetX,
      original[3] * transform.scaleY + transform.offsetY];
    // Verify the actual exported pixels, not just the declared transform. The former
    // separate X / upper-Y / lower-Y scaling widened the body by more than 30%.
    for (let edge = 0; edge < 4; edge++) expect(Math.abs(actual[edge]! - expected[edge]!)).toBeLessThanOrEqual(2.5);
  });

  it("keeps TESTER v2's real alpha, authored details and approved neutral face", () => {
    const rig = manifest.characters.tester, transform = rig.registration;
    const source = rgbaPng(directory + "source/" + transform.source);
    const body = rgbaPng(directory + "tester/body.png"), head = rgbaPng(directory + "tester/head.png");
    const atSource = (image: ReturnType<typeof rgbaPng>, x: number, y: number) => {
      const px = Math.round(x * transform.scaleX + transform.offsetX), py = Math.round(y * transform.scaleY + transform.offsetY);
      return image.pixels[(py * 256 + px) * 4 + 3]!;
    };
    // Coordinates were measured on the new source: exterior cuff/leg gaps, then
    // eyes, badge/cargo trim and footwear. Old v1-anatomy fixtures no longer apply.
    for (const [x, y] of [[315, 560], [698, 623], [800, 1100], [555, 1260]]) {
      expect(source.pixels[(y! * source.width + x!) * 4 + 3]).toBeLessThan(8);
      expect(atSource(body, x!, y!)).toBe(0);
    }
    for (const [x, y] of [[455, 189], [520, 168], [497, 226]]) expect(atSource(head, x!, y!)).toBeGreaterThan(245);
    for (const [x, y] of [[585, 665], [638, 865], [733, 1445]]) expect(atSource(body, x!, y!)).toBeGreaterThan(245);
    const neutral = cell(rgbaPng(directory + rig.face.file), 0, 0);
    for (let at = 0; at < neutral.length; at += 4) {
      if (!neutral[at + 3]) continue;
      for (let channel = 0; channel < 3; channel++) expect(Math.abs(neutral[at + channel]! - head.pixels[at + channel]!)).toBeLessThanOrEqual(1);
    }
    const focus = cell(rgbaPng(directory + rig.face.file), 0, 16);
    for (const [x, y] of [[455, 189], [520, 168]]) {
      const px = Math.round(x! * transform.scaleX + transform.offsetX), py = Math.round(y! * transform.scaleY + transform.offsetY);
      expect(focus[(py * 256 + px) * 4 + 3], "focus must preserve the approved original pupils").toBe(0);
    }
  });
});

/** Bounding geometry of actual exported opaque pixels, used to catch hidden anisotropic rescaling. */
function opaqueBounds(image: ReturnType<typeof rgbaPng>): [number, number, number, number] {
  let left = image.width, top = image.height, right = -1, bottom = -1;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (image.pixels[(y * image.width + x) * 4 + 3]! < 200) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return [left, top, right, bottom];
}
