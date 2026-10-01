import { readFile } from "node:fs/promises";

/** Reject generated checkerboard RGB images before opening a supposedly transparent overlay. */
export async function validateAtlas(path: string): Promise<void> {
  const data = await readFile(path);
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Atlas must be PNG");
  if (data.length < 33 || ![4, 6].includes(data[25]!)) throw new Error("Character atlas has no alpha channel; transparent assets are still pending");
  if (data.readUInt32BE(16) % 4 || data.readUInt32BE(20) % 4) throw new Error("Character atlas must contain a uniform 4 by 4 grid");
}
