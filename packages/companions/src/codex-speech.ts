import { z } from "zod";

const schema = z.object({
  runId: z.string().min(1).max(200),
  threadId: z.string().min(1).max(200),
  state: z.enum(["running", "completed", "failed", "interrupted"]),
  messages: z.array(z.object({
    messageId: z.string().min(1).max(200), text: z.string().max(4 * 1024 * 1024), state: z.literal("completed"),
  })).max(256),
});

/** Only the bridge's explicit public-message namespace can become Codex speech. */
export function readCodexSpeech(value: unknown): z.infer<typeof schema> | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
