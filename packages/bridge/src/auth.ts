import type { AuthHook } from "@opencode-ai/plugin";
import { CODEX_AUTH_MARKER, CODEX_PROVIDER_ID, readCodexSession } from "./auth-session.js";
import { createCodexFetch } from "./auth-provider.js";
import { beginCodexLogin } from "./auth-login.js";
export { beginCodexLogin } from "./auth-login.js";
export { connectCodex, CODEX_AUTH_MARKER, CODEX_PROVIDER_ID } from "./auth-session.js";
export type { CodexModel } from "./auth-session.js";

/** OpenCode stores a non-secret marker; Codex remains the only owner of refresh credentials. */
export function createCodexAuthHook(): AuthHook {
  return {
    provider: CODEX_PROVIDER_ID,
    async loader() {
      await readCodexSession();
      return { apiKey: CODEX_AUTH_MARKER, baseURL: "https://chatgpt.com/backend-api/codex", fetch: createCodexFetch() };
    },
    methods: [{
      type: "api", label: "Use current Codex ChatGPT login through the bridge",
      async authorize() {
        await readCodexSession();
        return { type: "success", key: CODEX_AUTH_MARKER };
      },
    }, { type: "oauth", label: "Sign into ChatGPT through Codex", authorize: () => beginCodexLogin() }],
  };
}
