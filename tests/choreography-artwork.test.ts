import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rgbaPng } from "./helpers/rgba-png.js";

const directory = fileURLToPath(new URL("../packages/companions/assets/expansion/", import.meta.url));
const manifest = JSON.parse(readFileSync(directory + "choreography.json", "utf8"));
const roles = ["lead", "code", "research", "review", "designer", "devops", "tester"];
const poses = ["work-three-quarter", "work-profile", "work-back-three-quarter", "work-seated", "dance-1", "dance-2", "dance-3", "dance-4",
  "work-right-three-quarter", "work-right-profile", "work-back", "walk-left", "walk-right", "work-kneeling", "work-leaning", "work-desk"];
type Layer = { id: string; file: string; parent: string | null; motion: string; pivot: number[]; amplitudeDegrees: number };
type OwnershipSample = { pose: string; point: [number, number]; owner: string; exclude: string[]; landmark: string };

describe("authored layered choreography", () => {
  it("ships sixteen real poses per role and no unreferenced runtime PNGs", () => {
    expect(manifest).toMatchObject({ version: 1, canvas: { width: 256, height: 384 }, feetBaseline: 368 });
    expect(Object.keys(manifest.characters).sort()).toEqual(roles.flatMap(role => poses.map(pose => `${role}/${pose}`)).sort());
    const files = new Set<string>();
    for (const rig of Object.values(manifest.characters) as any[]) {
      for (const layer of rig.layers) files.add(layer.file);
      files.add(rig.face.file);
    }
    expect([...files].sort()).toEqual([...manifest.runtimeFiles].sort());
    const actual = readdirSync(directory + "choreography", { recursive: true })
      .filter(file => file.endsWith(".png")).map(file => "choreography/" + file);
    expect(actual.sort(), "Unused cutouts should not enter the distribution").toEqual([...files].sort());
    expect(manifest.clips.dance).toMatchObject({ beatsPerPose: 2, transitionSeconds: 0.22 });
    expect(manifest.clips.work).toMatchObject({ holdSeconds: [8, 14], turnSeconds: 0.3, settleSeconds: 0.55 });
    expect(manifest.clips.walk).toMatchObject({ stepSeconds: 0.65, durationSeconds: 2.6, transitionSeconds: 0.22,
      phases: ["contact", "passing"], facing: "right" });
  });

  it("retains CODE's neckline when its head is replaced", () => {
    const layers = manifest.characters["code/dance-4"].layers as Layer[];
    const body = rgbaPng(directory + layers.find(layer => layer.id === "body")!.file);
    const head = rgbaPng(directory + layers.find(layer => layer.id === "head")!.file);
    // These garment pixels used to leave two transparent wedges in the CODE / RESEARCH mix.
    for (const [x, y] of [[124, 201], [159, 201]] as const) {
      const alpha = (y * 256 + x) * 4 + 3;
      expect(body.pixels[alpha], `Missing neckline at ${x},${y}`).toBe(255);
      expect(head.pixels[alpha], `Clothing still belongs to the head at ${x},${y}`).toBe(0);
    }
  });

  it("keeps CODE's back-view ponytail off the transferable outfit", () => {
    const layers = manifest.characters["code/work-back"].layers as Layer[];
    const body = rgbaPng(directory + layers.find(layer => layer.id === "body")!.file);
    const hair = layers.filter(layer => layer.motion === "head" || layer.parent === "head")
      .map(layer => rgbaPng(directory + layer.file));
    // This source-confirmed curl used to stay behind when RESEARCH replaced CODE's head.
    const curl = (108 * 256 + 134) * 4 + 3;
    expect(body.pixels[curl], "Hair remains in the outfit at 134,108").toBe(0);
    expect(Math.max(...hair.map(image => image.pixels[curl]!))).toBeGreaterThanOrEqual(250);
    // Purple sleeve/notebook edges at these nearby points are not hair; preserve their real owners.
    for (const [id, x, y, rgba] of [
      ["prop", 88, 122, [28, 11, 41, 255]],
      ["arm-left", 88, 168, [113, 35, 140, 255]],
    ] as const) {
      const image = rgbaPng(directory + layers.find(layer => layer.id === id)!.file);
      expect([...image.pixels.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)]).toEqual([...rgba]);
    }
  });

  it("keeps LEAD's kneeling collar on the outfit while preserving nearby hair", () => {
    const layers = manifest.characters["lead/work-kneeling"].layers as Layer[];
    const body = rgbaPng(directory + layers.find(layer => layer.id === "body")!.file);
    const head = rgbaPng(directory + layers.find(layer => layer.id === "head")!.file);
    // The old head carried these teal and beige garment pixels across role changes.
    for (const [x, y] of [[132, 182], [139, 185]] as const) {
      const alpha = (y * 256 + x) * 4 + 3;
      expect(body.pixels[alpha]).toBeGreaterThanOrEqual(250);
      expect(head.pixels[alpha]).toBe(0);
    }
    for (const [x, y] of [[135, 178], [136, 178]] as const) {
      expect(head.pixels[(y * 256 + x) * 4 + 3]).toBeGreaterThan(0);
    }
  });

  it("covers REVIEW's moving neck with measured collar pixels and preserves its head", () => {
    const fixtures = JSON.parse(readFileSync(directory + "choreography/review/neck-underlap-fixture.json", "utf8"));
    const layers = manifest.characters["review/work-three-quarter"].layers as Layer[];
    const body = rgbaPng(directory + layers.find(layer => layer.id === "body")!.file);
    const head = rgbaPng(directory + layers.find(layer => layer.id === "head")!.file);
    const pixel = (image: ReturnType<typeof rgbaPng>, point: [number, number]) =>
      [...image.pixels.subarray((point[1] * 256 + point[0]) * 4, (point[1] * 256 + point[0]) * 4 + 4)];
    expect(fixtures.maxNeutralRgbaDelta).toBe(4);
    expect(fixtures.underlap).toHaveLength(52);
    for (const sample of fixtures.underlap) {
      expect(pixel(body, sample.point)).toEqual(sample.bodyRgba);
      expect(pixel(body, sample.donor), "Underlap must come from the existing collar").toEqual(sample.bodyRgba);
      expect(pixel(head, sample.point), "The original neck and hair changed").toEqual(sample.headRgba);
    }
  });

  it("keeps CODE's exposed chest on the body rather than the transferable neck", () => {
    const layers = manifest.characters["code/work-three-quarter"].layers as Layer[];
    const body = rgbaPng(directory + layers.find(layer => layer.id === "body")!.file);
    const head = rgbaPng(directory + layers.find(layer => layer.id === "head")!.file);
    // A lower chest anchor previously raised this head 14px over RESEARCH's high collar.
    const alpha = (106 * 256 + 125) * 4 + 3;
    expect(body.pixels[alpha]).toBe(255);
    expect(head.pixels[alpha]).toBe(0);
    expect(layers.find(layer => layer.id === "head")!.pivot[1]).toBeLessThanOrEqual(98);
  });

  it.each(["research", "designer"])("keeps measured clothing and hair landmarks on their own layers for %s", role => {
    const fixtures = JSON.parse(readFileSync(directory + `choreography/${role}/ownership.json`, "utf8"));
    const images = new Map<string, ReturnType<typeof rgbaPng>>();
    for (const sample of fixtures.samples as OwnershipSample[]) {
      const layers = manifest.characters[`${role}/${sample.pose}`].layers as Layer[];
      const alphaAt = (id: string) => {
        const file = layers.find(layer => layer.id === id)!.file;
        if (!images.has(file)) images.set(file, rgbaPng(directory + file));
        return images.get(file)!.pixels[(sample.point[1] * 256 + sample.point[0]) * 4 + 3]!;
      };
      const message = `${role}/${sample.pose}: ${sample.landmark} at ${sample.point.join(",")}`;
      expect(alphaAt(sample.owner), message).toBeGreaterThanOrEqual(250);
      for (const layer of sample.exclude) expect(alphaAt(layer), message).toBe(0);
    }
  });

  it.each(roles)("retains real alpha, independent joints and uniform anatomy for %s", role => {
    const hashes = new Set<string>();
    for (const pose of poses) {
      const key = `${role}/${pose}`, rig = manifest.characters[key];
      expect(rig.face.neutralOnly, "Profile artwork must not gain a frontal facial patch").toBe(true);
      expect(rig.registration.kind).toBe("uniform");
      expect(rig.registration.scaleX).toBe(rig.registration.scaleY);
      expect(rig.registration.sourceFeet * rig.registration.scaleY + rig.registration.offsetY).toBeCloseTo(368, 4);
      expect(new Set(rig.layers.map((layer: Layer) => layer.id)).size).toBe(rig.layers.length);
      expect(rig.layers.some((layer: Layer) => layer.motion === "arm")).toBe(true);
      expect(rig.layers.find((layer: Layer) => layer.id === "head")).toMatchObject({ parent: "body", motion: "head" });
      const union = Buffer.alloc(256 * 384);
      for (const layer of rig.layers as Layer[]) {
        expect(layer.file.startsWith(`choreography/${role}/`)).toBe(true);
        expect(layer.pivot).toHaveLength(2);
        expect(layer.pivot.every(Number.isFinite)).toBe(true);
        const image = rgbaPng(directory + layer.file);
        expect([image.width, image.height]).toEqual([256, 384]);
        let painted = 0, matte = 0, clipped = 0;
        for (let at = 0; at < image.pixels.length; at += 4) {
          const alpha = image.pixels[at + 3]!, pixel = at / 4;
          if (!alpha) { if (image.pixels[at] || image.pixels[at + 1] || image.pixels[at + 2]) matte++; continue; }
          painted++; union[pixel] = Math.max(union[pixel]!, alpha);
          const x = pixel % 256, y = Math.floor(pixel / 256);
          if (x < 2 || x > 253 || y < 2 || y > 381) clipped++;
        }
        expect(painted, `${key}/${layer.id} is an empty layer`).toBeGreaterThan(20);
        expect(matte, `${key}/${layer.id} retains invisible colored matte`).toBe(0);
        expect(clipped, `${key}/${layer.id} is clipped by its canvas`).toBe(0);
      }
      if (pose.startsWith("dance-")) hashes.add(createHash("sha256").update(union).digest("hex"));
    }
    expect(hashes.size, "Dance poses must change the actual silhouette").toBe(4);
    const face = rgbaPng(directory + manifest.characters[`${role}/work-profile`].face.file);
    expect([face.width, face.height]).toEqual([256, 384 * 18]);
    expect(face.pixels.every(value => value === 0), "A profile borrowed another face").toBe(true);
  });
});
