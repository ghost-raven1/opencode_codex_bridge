import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cell, rgbaPng } from "./helpers/rgba-png.js";

const directory = fileURLToPath(new URL("../packages/companions/assets/expansion/", import.meta.url));
const manifest = JSON.parse(readFileSync(directory + "poses.json", "utf8"));
const standing = JSON.parse(readFileSync(directory + "manifest.json", "utf8"));
const names = ["lead", "code", "research", "review", "designer", "devops", "tester"];
const keys = names.flatMap(role => [role + "/seated", role + "/reclining"]);
type Pixels = ReturnType<typeof rgbaPng>;
type Layer = { id: string; file: string; parent: string | null; motion: string; pivot: number[]; amplitudeDegrees: number };

describe("layered companion poses", () => {
  it("ships exactly two additional poses per role and packages only their referenced layers", () => {
    expect(manifest).toMatchObject({ version: 1, canvas: { width: 256, height: 384 }, feetBaseline: 368 });
    expect(Object.keys(manifest.characters).sort()).toEqual([...keys].sort());
    const files = keys.flatMap(key => {
      const rig = manifest.characters[key];
      return [...rig.layers.map((layer: Layer) => layer.file), rig.face.file];
    });
    expect(new Set(files).size).toBe(files.length);
    expect([...manifest.runtimeFiles].sort()).toEqual([...files].sort());
    const actual = readdirSync(directory + "poses", { recursive: true })
      .filter(file => file.endsWith(".png")).map(file => "poses/" + file);
    expect(actual.sort(), "Unreferenced QA or superseded layers remain in runtime assets").toEqual([...files].sort());
  });

  it.each(keys)("preserves anatomy, independent layers, transparency and registered expressions: %s", key => {
    const rig = manifest.characters[key];
    expect(rig, "Missing authored pose").toBeDefined();
    const role = key.split("/")[0]!;
    expect(rig.face.frames).toEqual(standing.characters[role].face.frames);
    expect(rig.layers.some((layer: Layer) => layer.motion === "arm")).toBe(true);
    const union: Pixels = { width: 256, height: 384, pixels: Buffer.alloc(256 * 384 * 4) };
    let head: Pixels | undefined;
    for (const layer of rig.layers as Layer[]) {
      expect(layer.file.startsWith("poses/" + key + "/")).toBe(true);
      const image = rgbaPng(directory + layer.file);
      expect([image.width, image.height]).toEqual([256, 384]);
      let opaque = 0, mattePixels = 0, clippedPixels = 0;
      for (let at = 0; at < image.pixels.length; at += 4) {
        const alpha = image.pixels[at + 3]!;
        union.pixels[at + 3] = Math.max(union.pixels[at + 3]!, alpha);
        if (!alpha) {
          if (image.pixels[at]! | image.pixels[at + 1]! | image.pixels[at + 2]!) mattePixels++;
          continue;
        }
        const x = (at / 4) % 256, y = Math.floor(at / 4 / 256);
        if (x <= 1 || x >= 254 || y === 0 || y >= 383) clippedPixels++;
        opaque++;
      }
      expect(opaque).toBeGreaterThan(20);
      expect(mattePixels, `${layer.id} contains transparent matte RGB`).toBe(0);
      expect(clippedPixels, `${layer.id} clips the canvas`).toBe(0);
      if (layer.id === "head") head = image;
    }
    expect(head).toBeDefined();
    const registration = rig.registration;
    expect(registration.kind).toBe("uniform");
    expect(registration.scaleX).toBe(registration.scaleY);
    expect(registration.sourceFeet * registration.scaleY + registration.offsetY).toBeCloseTo(368, 5);
    const source = rgbaPng(directory + "source/" + registration.source);
    // The one detached DEVOPS speck is intentionally excluded from the source silhouette.
    const original = bounds(source, key === "devops/reclining" ? [1190, 973, 1236, 1007] : undefined);
    const actual = bounds(union);
    const expected = original.map((edge, index) => edge * registration.scaleX + (index % 2 ? registration.offsetY : registration.offsetX));
    for (let edge = 0; edge < 4; edge++) expect(Math.abs(actual[edge]! - expected[edge]!)).toBeLessThanOrEqual(2.5);
    expect(expected[0], "Source lost a left extremity during export").toBeGreaterThan(2);
    expect(expected[2], "Source lost a right extremity during export").toBeLessThan(254);

    const atlas = rgbaPng(directory + rig.face.file), hashes = new Set<string>();
    expect([atlas.width, atlas.height]).toEqual([256, 384 * 18]);
    for (let row = 0; row < 18; row++) {
      const patch = cell(atlas, 0, row);
      hashes.add(createHash("sha256").update(patch).digest("hex"));
      let painted = 0;
      for (let at = 0; at < patch.length; at += 4) {
        if (!patch[at + 3]) continue;
        expect(head!.pixels[at + 3], "Expression escaped its own head silhouette").toBeGreaterThan(0);
        if (row === 0 || row === 8) {
          for (let channel = 0; channel < 3; channel++) expect(patch[at + channel]).toBe(head!.pixels[at + channel]);
        }
        painted++;
      }
      expect(painted).toBeGreaterThan(5);
    }
    expect(hashes.size).toBe(18);
  });

  it("covers LEAD reclining's real pupils when blinking and places speech on her actual mouth", () => {
    const rig = manifest.characters["lead/reclining"], atlas = rgbaPng(directory + rig.face.file);
    // Measured on the original drawing, independently of the export's facialAnchors.
    for (const [x, y] of [[727, 282], [812, 251]]) {
      const [px, py] = registered(rig.registration, x!, y!);
      expect(alpha(atlas, px, py + 12 * 384), "Closed lid leaves the original green pupil visible").toBeGreaterThan(245);
    }
    const [x, y] = registered(rig.registration, 778, 326);
    expect(alpha(atlas, x, y + 2 * 384), "Speech mouth is above the original mouth").toBeGreaterThan(180);
  });

  it("fills hidden LEAD reclining clothing instead of leaving another painted hand under the moving one", () => {
    const rig = manifest.characters["lead/reclining"], body = rgbaPng(directory + "poses/lead/reclining/body.png");
    for (const [x, y] of [[575, 745], [600, 760]]) {
      const [px, py] = registered(rig.registration, x!, y!), at = (py * 256 + px) * 4;
      expect(body.pixels[at + 3]).toBeGreaterThan(245);
      expect(Math.max(...body.pixels.subarray(at, at + 3)), "Skin from the old hand remains in the backing").toBeLessThan(130);
    }
  });

  it("keeps opaque neck overlap under LEAD's head at the formerly open joint pixels", () => {
    for (const [pose, points] of [
      ["seated", [[137, 191], [123, 195], [130, 196]]],
      ["reclining", [[168, 195], [153, 201], [159, 203]]],
    ] as const) {
      const body = rgbaPng(directory + `poses/lead/${pose}/body.png`);
      for (const [x, y] of points) expect(alpha(body, x, y), `${pose}: transparent neck seam`).toBeGreaterThanOrEqual(245);
    }
  });

  it("keeps CODE's own neck and clothing behind the detachable headphones in both mixed poses", () => {
    for (const [pose, points] of [
      ["seated", [[520, 411], [660, 419]]],
      ["reclining", [[411, 492], [530, 515]]],
    ] as const) {
      const rig = manifest.characters[`code/${pose}`];
      const body = rgbaPng(directory + `poses/code/${pose}/body.png`);
      const head = rgbaPng(directory + `poses/code/${pose}/head.png`);
      for (const [x, y] of points) {
        const [px, py] = registered(rig.registration, x, y);
        expect(alpha(head, px, py), "CODE lost her headphones").toBeGreaterThan(245);
        expect(alpha(body, px, py), `${pose}: another head exposes a headphone-shaped hole in the outfit`).toBeGreaterThan(245);
      }
    }
  });

  it("restores CODE's headphone cup while keeping the touching fingers on the moving arm", () => {
    const rig = manifest.characters["code/reclining"];
    const head = rgbaPng(directory + "poses/code/reclining/head.png");
    const arm = rgbaPng(directory + "poses/code/reclining/arm-right.png");
    const [x, y] = registered(rig.registration, 525, 450), at = (y * 256 + x) * 4;
    expect(head.pixels[at + 3], "Hand-shaped hole in the headphone cup").toBeGreaterThan(245);
    expect(Math.max(...head.pixels.subarray(at, at + 3)), "Skin remains on the detached headphones").toBeLessThan(95);
    for (const [sx, sy] of [[590, 438], [609, 448]]) {
      const [px, py] = registered(rig.registration, sx!, sy!);
      expect(alpha(head, px, py), "Fingers float under a mixed head").toBe(0);
      expect(alpha(arm, px, py), "Removing head artefacts also removed the actual fingers").toBeGreaterThan(180);
    }
  });

  it("keeps RESEARCH and REVIEW's head details out of a different agent's outfit", () => {
    // Actual source colours are independent of the old body's faulty downward donor sampling.
    // Some old 'hair' pixels covered an earring or a dark outline in the original drawing.
    const samples = {
      "research/seated": [[143, 193, [95, 156, 137], [91, 151, 132]], [89, 190, [106, 163, 140], [41, 72, 64]]],
      "research/reclining": [[121, 192, [94, 156, 139], [105, 161, 145]], [73, 192, [100, 174, 157], [103, 164, 147]]],
      "review/seated": [[114, 197, [172, 160, 180], [179, 166, 185]], [118, 190, [98, 83, 111], [241, 125, 54]]],
      "review/reclining": [[171, 224, [125, 114, 143], [21, 14, 14]], [214, 212, [128, 114, 145], [114, 100, 135]]],
    } as const;
    for (const [key, points] of Object.entries(samples)) {
      const layers = manifest.characters[key].layers as Layer[];
      const body = rgbaPng(directory + layers.find(layer => layer.id === "body")!.file);
      const heads = layers.filter(layer => layer.id === "head" || layer.parent === "head").map(layer => rgbaPng(directory + layer.file));
      for (const [x, y, oldHairRGB, sourceRGB] of points) {
        const at = (y * 256 + x) * 4;
        const moving = heads.reduce((a, b) => a.pixels[at + 3]! >= b.pixels[at + 3]! ? a : b);
        expect(moving.pixels[at + 3], `${key} head detail did not move with the head`).toBeGreaterThan(180);
        for (let channel = 0; channel < 3; channel++) expect(Math.abs(moving.pixels[at + channel]! - sourceRGB[channel]!)).toBeLessThan(3);
        const difference = Math.max(...oldHairRGB.map((value, channel) => Math.abs(body.pixels[at + channel]! - value)));
        expect(body.pixels[at + 3]! < 20 || difference > 20, `${key} outfit retains its previous hair colour`).toBe(true);
      }
    }
  });

  it("removes the detached DEVOPS shoe fleck while retaining the original source for reproduction", () => {
    const rig = manifest.characters["devops/reclining"], registration = rig.registration;
    const original = rgbaPng(directory + "source/poses/devops-reclining.png");
    let originalPixels = 0;
    for (let y = 974; y <= 1005; y++) for (let x = 1191; x <= 1234; x++) {
      if (alpha(original, x, y) > 128) originalPixels++;
    }
    expect(originalPixels).toBeGreaterThan(200);
    const start = registered(registration, 1198, 980), end = registered(registration, 1227, 1000);
    for (const layer of rig.layers as Layer[]) {
      const image = rgbaPng(directory + layer.file);
      for (let y = start[1]; y <= end[1]; y++) for (let x = start[0]; x <= end[0]; x++) {
        expect(alpha(image, x, y), `${layer.id} retains the detached fleck`).toBe(0);
      }
    }
  });

  it("moves the entire DEVOPS supporting forearm and glove without leaving a fixed outline", () => {
    const body = rgbaPng(directory + "poses/devops/reclining/body.png");
    const arm = rgbaPng(directory + "poses/devops/reclining/hip-arm.png");
    for (const [x, y] of [[30, 329], [40, 329], [49, 327]]) {
      expect(alpha(body, x!, y!), "Stationary glove outline remains below the moving hand").toBe(0);
      expect(alpha(arm, x!, y!), "The original hand contour was erased instead of moving with the arm").toBeGreaterThan(200);
    }
  });

  it("moves RESEARCH's book edge with the book instead of leaving a stationary serrated outline", () => {
    const body = rgbaPng(directory + "poses/research/seated/body.png");
    const book = rgbaPng(directory + "poses/research/seated/prop.png");
    for (const [x, y] of [[189, 242], [186, 246], [181, 254], [178, 258]]) {
      expect(alpha(body, x!, y!), "Book outline stays behind when the prop moves").toBe(0);
      expect(alpha(book, x!, y!), "The original book edge was erased instead of moving with the prop").toBeGreaterThan(200);
    }
  });

  it("makes specialist props follow the same pivot and idle movement as their holding hands", () => {
    for (const [role, hand] of [["devops", "tool-arm"], ["tester", "controller-arms"]]) {
      for (const pose of ["seated", "reclining"]) {
        const layers = manifest.characters[`${role}/${pose}`].layers as Layer[];
        const arm = layers.find(layer => layer.id === hand), prop = layers.find(layer => layer.id === "prop");
        expect(prop).toBeDefined(); expect(arm).toBeDefined();
        expect(prop).toMatchObject({ pivot: arm!.pivot, parent: arm!.parent, motion: "arm", amplitudeDegrees: arm!.amplitudeDegrees });
      }
    }
  });
});

/** Read actual exported geometry, so a correct-looking manifest cannot conceal distorted pixels. */
function bounds(image: Pixels, excluded?: number[]): number[] {
  let left = image.width, top = image.height, right = -1, bottom = -1;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (excluded && x >= excluded[0]! && y >= excluded[1]! && x < excluded[2]! && y < excluded[3]!) continue;
    if (alpha(image, x, y) < 200) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return [left, top, right + 1, bottom + 1];
}

function alpha(image: Pixels, x: number, y: number): number { return image.pixels[(y * image.width + x) * 4 + 3]!; }

function registered(registration: { scaleX: number; scaleY: number; offsetX: number; offsetY: number }, x: number, y: number): [number, number] {
  return [Math.round(x * registration.scaleX + registration.offsetX), Math.round(y * registration.scaleY + registration.offsetY)];
}
