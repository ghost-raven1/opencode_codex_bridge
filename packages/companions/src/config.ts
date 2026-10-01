import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const roleSchema = z.enum(["coordinator", "developer", "researcher", "reviewer"]);
export type Role = z.infer<typeof roleSchema>;
export const appearanceSchema = z.object({
  mode: z.enum(["presets", "seeded"]).default("presets"),
  roles: z.record(roleSchema, z.object({ head: roleSchema.optional(), outfit: roleSchema.optional() })).default({}),
}).default({});
export type AppearanceConfig = z.infer<typeof appearanceSchema>;
export const configSchema = z.object({
  enabled: z.boolean().default(false),
  showOnStart: z.boolean().default(true),
  dictation: z.boolean().default(true),
  speech: z.enum(["off", "coordinator-only", "all"]).default("coordinator-only"),
  workingPhrase: z.string().max(200).default("Задача в работе."),
  maxSpeechLength: z.number().int().min(100).max(8000).default(1600),
  maxVisible: z.number().int().min(1).max(4).default(4),
  scale: z.number().min(0.5).max(2).default(1),
  language: z.string().default("ru-RU"),
  voiceIdentifier: z.string().min(1).optional(),
  appearance: appearanceSchema,
  // Explicit overrides only; built-in names are fallbacks after task-based detection.
  agentRoles: z.record(roleSchema).default({}),
});
export type CompanionConfig = z.infer<typeof configSchema>;

/** Explicit project opt-in: loading the plugin alone never opens a window or starts speech. */
export async function readConfig(directory: string): Promise<CompanionConfig> {
  try { return configSchema.parse(JSON.parse(await readFile(join(directory, ".opencode", "companions.json"), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const profile = process.env.OPENCODE_CONFIG_DIR;
      if (!profile) return configSchema.parse({});
      try { return configSchema.parse(JSON.parse(await readFile(join(profile, "companions.json"), "utf8"))); }
      catch (fallback) {
        if ((fallback as NodeJS.ErrnoException).code === "ENOENT") return configSchema.parse({});
        throw fallback;
      }
    }
    throw error;
  }
}
