import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

export const roleSchema = z.enum(["coordinator", "developer", "researcher", "reviewer"]);
export type Role = z.infer<typeof roleSchema>;
export const localVoiceSchema = z.enum(["Serena", "Vivian", "Sohee", "Ono_Anna", "designer-local", "devops-local", "tester-local"]);
export const specialistVoices: Record<string, string> = { designer: "designer-local", devops: "devops-local", tester: "tester-local" };
export const voiceDefaults = { coordinator: "Serena", developer: "Vivian", researcher: "Sohee", reviewer: "Ono_Anna" } as const;
export const appearanceSchema = z.object({
  mode: z.enum(["presets", "seeded"]).default("presets"),
  roles: z.record(roleSchema, z.object({ head: roleSchema.optional(), outfit: roleSchema.optional() })).default({}),
}).default({});
export type AppearanceConfig = z.infer<typeof appearanceSchema>;
export const configSchema = z.object({
  enabled: z.boolean().default(false),
  // Legacy configuration is accepted, but startup never creates demonstration agents.
  showOnStart: z.boolean().default(false),
  dictation: z.boolean().default(true),
  wakeWord: z.boolean().default(false),
  speech: z.enum(["off", "coordinator-only", "all"]).default("all"),
  tts: z.object({
    engine: z.enum(["macos", "local"]).default("macos"),
    voices: z.object({
      coordinator: localVoiceSchema.default(voiceDefaults.coordinator),
      developer: localVoiceSchema.default(voiceDefaults.developer),
      researcher: localVoiceSchema.default(voiceDefaults.researcher),
      reviewer: localVoiceSchema.default(voiceDefaults.reviewer),
    }).default({}),
  }).default({}),
  workingPhrase: z.string().max(200).default("").transform(text => /^Задача в работе[.!]?$/i.test(text.trim()) ? "" : text),
  modelOpenings: z.boolean().default(true),
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
