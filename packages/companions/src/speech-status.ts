/** Text-free state for the native voice menu; phases follow observed queue/player events. */
export interface SpeechStatus {
  phase: "idle" | "synthesizing" | "queued" | "local" | "system" | "muted" | "dictating" | "error" | "recovering";
  pending: number;
  reason?: SpeechReason;
  canRecover: boolean;
}
export type SpeechReason = "local-unavailable" | "local-slow" | "playback-failed" | "system-unavailable"
  | "system-selected" | "restored" | "recovery-failed" | "stopped" | "queue-full" | "disabled";
