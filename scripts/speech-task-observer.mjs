import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

// Installed only in the isolated QA profile. Observe the production plugin without replacing it.
const runtime = process.env.CODEXBRIDGE_QA_RUNTIME;
const trace = process.env.CODEXBRIDGE_QA_TRACE;
const moduleAt = name => import(pathToFileURL(join(runtime, "packages/companions/dist", name)).href);
const [{ default: Companions }, { SpeechRouter }, { LocalTts }] = await Promise.all([
  moduleAt("plugin.js"), moduleAt("speech-router.js"), moduleAt("local-tts.js"),
]);
const record = (channel, event) => {
  const { type, id, audioId, characterId, phase, state, voice, code, pending, reason, canRecover } = event;
  appendFileSync(trace, JSON.stringify({ at: Date.now(), channel, type, id, audioId, characterId,
    phase, state, voice, code, pending, reason, canRecover, characters: event.text?.length, ...event.metrics }) + "\n");
};
let currentRouter, recovered = false;
const publishStatus = SpeechRouter.prototype.publishStatus;
SpeechRouter.prototype.publishStatus = function () {
  currentRouter = this;
  const previous = this.lastStatus;
  const result = publishStatus.call(this);
  if (this.lastStatus && this.lastStatus !== previous) record("status", { type: "speech-status", ...JSON.parse(this.lastStatus) });
  return result;
};
if (process.env.CODEXBRIDGE_QA_RECOVER === "1") {
  // Only the isolated smoke writes this marker, after observing a drained queue.
  const marker = join(runtime, "recover-speech");
  setInterval(() => {
    if (!existsSync(marker) || !currentRouter?.status().canRecover) return;
    unlinkSync(marker);
    record("qa", { type: "explicit-recovery" });
    currentRouter.receive({ type: "speech-control", action: "recover" });
  }, 100).unref();
}
for (const method of ["event", "receive"]) {
  const original = SpeechRouter.prototype[method];
  SpeechRouter.prototype[method] = function (event) {
    if (!this.observed) {
      this.observed = true;
      const send = this.send;
      this.send = event => {
        if (event.type === "reset-speech") recovered = true;
        record("native-send", event); send(event);
      };
      const log = this.log;
      this.log = message => { record("router", { type: "warning", metrics: { message } }); log(message); };
    }
    record(method === "event" ? "director" : "native-receive", { ...event,
      ...(event.type === "audio-finished" ? { metrics: { queued: this.queue.length,
        nextReady: Boolean(this.queue[0]?.audio) } } : {}) });
    return original.call(this, event);
  };
}
const notify = SpeechRouter.prototype.notify;
SpeechRouter.prototype.notify = function () {
  record("router", { type: "pending", metrics: { count: this.queue.length + Number(Boolean(this.active)) } });
  return notify.call(this);
};
const synthesize = LocalTts.prototype.synthesize;
let requests = 0;
LocalTts.prototype.synthesize = async function (request) {
  const started = Date.now();
  record("tts", { type: "start", ...request });
  try {
    const requestNumber = ++requests, failureAt = Number(process.env.CODEXBRIDGE_QA_FAIL_REQUEST ?? 0);
    if (requestNumber === failureAt || (process.env.CODEXBRIDGE_QA_RECOVER === "1" && requestNumber >= failureAt && !recovered)) {
      record("tts", { type: "injected-failure", id: request.id });
      throw new Error("QA injected generation failure");
    }
    const audio = await synthesize.call(this, request);
    record("tts", { type: "audio", id: request.id, voice: request.voice,
      metrics: { generationMs: Date.now() - started, seconds: audio.duration, workerPID: this.child?.pid } });
    return audio;
  } catch (error) {
    record("tts", { type: "error", id: request.id, metrics: { message: error.message, generationMs: Date.now() - started } });
    throw error;
  }
};
export default async input => {
  const hooks = await Companions(input);
  record("plugin", { type: "loaded" });
  return hooks;
};
