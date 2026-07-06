// Optional local TTS (Mode B). HTTP mode (preferred) forwards to an OpenAI-compatible
// /v1/audio/speech; CLI mode (fallback) invokes a command (argument array, never a shell string)
// that reads text on STDIN and writes audio bytes to STDOUT. Text-only if neither is configured.

import { spawn } from "node:child_process";

export function mimeForFormat(format) {
  switch ((format || "").toLowerCase()) {
    case "mp3": return "audio/mpeg";
    case "aac": return "audio/aac";
    case "wav": return "audio/wav";
    case "opus": return "audio/ogg";
    case "flac": return "audio/flac";
    default: return "application/octet-stream";
  }
}

export async function synthesize(cfg, text, voice, format, signal) {
  if (cfg.ttsUrl) {
    const headers = { "Content-Type": "application/json" };
    if (cfg.ttsKey) headers.Authorization = `Bearer ${cfg.ttsKey}`;
    const resp = await fetch(cfg.ttsUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.ttsModel, input: text, voice, response_format: format }),
      signal: signal ?? AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!resp.ok) {
      const err = new Error(`TTS endpoint returned ${resp.status}`);
      err.name = "TTSUpstreamError";
      throw err;
    }
    return Buffer.from(await resp.arrayBuffer());
  }
  if (cfg.ttsCmd) return synthesizeViaCmd(cfg, text, signal);
  throw new Error("No TTS configured (set RIFFIN_BRIDGE_TTS_URL or RIFFIN_BRIDGE_TTS_CMD).");
}

function synthesizeViaCmd(cfg, text, signal) {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = cfg.ttsCmd.split(/\s+/);
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let stderr = "", settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(arg);
    };
    const onAbort = () => { child.kill("SIGKILL"); finish(reject, new Error("cancelled")); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(reject, new Error(`TTS command timed out after ${cfg.timeoutMs} ms.`)); }, cfg.timeoutMs);
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
    // stdout is BINARY audio — never setEncoding it; stderr is text, decode statefully.
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => finish(reject, new Error(`Failed to launch TTS '${bin}': ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return finish(reject, new Error(stderr.trim() || `TTS command exited ${code}.`));
      finish(resolve, Buffer.concat(chunks));
    });
    child.stdin.end(text);
  });
}
