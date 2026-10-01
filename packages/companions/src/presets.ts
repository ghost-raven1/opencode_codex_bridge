import { createHash } from "node:crypto";
import type { AppearanceConfig, Role } from "./config.js";

export const presets: Record<Role, { column: number; label: string; accent: string; accessories: string[] }> = {
  coordinator: { column: 0, label: "LEAD", accent: "#edc8b0", accessories: ["headset", "tablet"] },
  developer: { column: 1, label: "CODE", accent: "#ba83e6", accessories: ["headphones", "laptop"] },
  researcher: { column: 2, label: "RESEARCH", accent: "#9ccfb4", accessories: ["glasses", "book"] },
  reviewer: { column: 3, label: "REVIEW", accent: "#e78e61", accessories: ["tablet", "stylus"] },
};
const headAccessories = [["headset"], ["headphones"], ["glasses"], []];
const outfitAccessories = [["tablet"], ["laptop"], ["book"], ["tablet", "stylus"]];

/** Stable head/outfit selection; accessories remain part of the drawn pieces, not separate toggles. */
export function appearanceFor(characterId: string, role: Role, config?: AppearanceConfig) {
  const digest = createHash("sha256").update(characterId).digest();
  const override = config?.roles[role];
  const headColumn = override?.head ? presets[override.head].column
    : config?.mode === "seeded" ? digest[0]! % 4 : presets[role].column;
  const bodyColumn = override?.outfit ? presets[override.outfit].column
    : config?.mode === "seeded" ? digest[1]! % 4 : presets[role].column;
  return { ...presets[role], role, headColumn, bodyColumn,
    accessories: [...headAccessories[headColumn]!, ...outfitAccessories[bodyColumn]!],
    seed: digest.toString("hex").slice(0, 8) };
}
