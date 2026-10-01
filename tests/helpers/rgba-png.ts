import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

/** Decode our non-interlaced RGBA8 atlas fixtures, including all five PNG row filters. */
export function rgbaPng(path: string): { width: number; height: number; pixels: Buffer } {
  const file = readFileSync(path), chunks: Buffer[] = [];
  if (!file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(`Not PNG: ${path}`);
  let width = 0, height = 0;
  for (let cursor = 8; cursor < file.length;) {
    const length = file.readUInt32BE(cursor), type = file.toString("ascii", cursor + 4, cursor + 8);
    const data = file.subarray(cursor + 8, cursor + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error(`Expected RGBA8, no interlace: ${path}`);
    }
    if (type === "IDAT") chunks.push(data);
    cursor += length + 12;
  }
  const packed = inflateSync(Buffer.concat(chunks)), stride = width * 4, pixels = Buffer.alloc(stride * height);
  if (packed.length !== (stride + 1) * height) throw new Error(`Unexpected raster size: ${path}`);
  for (let y = 0; y < height; y++) {
    const filter = packed[y * (stride + 1)]!;
    if (filter > 4) throw new Error(`Unknown PNG filter: ${filter}`);
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x, left = x >= 4 ? pixels[at - 4]! : 0;
      const up = y ? pixels[at - stride]! : 0, corner = y && x >= 4 ? pixels[at - stride - 4]! : 0;
      const p = left + up - corner, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner);
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3
        ? Math.floor((left + up) / 2) : a <= b && a <= c ? left : b <= c ? up : corner;
      pixels[at] = (packed[y * (stride + 1) + 1 + x]! + predictor) & 255;
    }
  }
  return { width, height, pixels };
}

export function cell(image: ReturnType<typeof rgbaPng>, column: number, row: number): Buffer {
  const result = Buffer.alloc(256 * 384 * 4);
  for (let y = 0; y < 384; y++) {
    const offset = ((row * 384 + y) * image.width + column * 256) * 4;
    image.pixels.copy(result, y * 1024, offset, offset + 1024);
  }
  return result;
}
