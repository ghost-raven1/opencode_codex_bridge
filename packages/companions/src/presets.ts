import { createHash } from "node:crypto";
import type { Role } from "./config.js";

export const presets: Record<Role, { column: number; label: string; accent: string; accessories: string[] }> = {
  coordinator: { column: 0, label: "LEAD", accent: "#edc8b0", accessories: ["headset", "tablet"] },
  developer: { column: 1, label: "CODE", accent: "#ba83e6", accessories: ["headphones", "laptop"] },
  researcher: { column: 2, label: "RESEARCH", accent: "#9ccfb4", accessories: ["glasses", "book"] },
  reviewer: { column: 3, label: "REVIEW", accent: "#e78e61", accessories: ["tablet", "stylus"] },
};

/** Stable identity is independent of message order or process restarts. */
export function appearanceFor(characterId: string, role: Role) {
  return { ...presets[role], role,
    seed: createHash("sha256").update(characterId).digest("hex").slice(0, 8) };
}
