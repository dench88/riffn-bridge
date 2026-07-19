// Configuration derived from the environment (after .env is loaded). Read once via readConfig().

import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")).version || "0";
  } catch {
    return "0";
  }
})();

export const MAX_BODY_BYTES = 1_000_000; // 1 MB cap on request bodies (threat A1)

// Tailscale assigns a 100.64.0.0/10 (CGNAT) address. Binding there makes the helper reachable over
// the tailnet but NOT on the LAN or the public internet.
export function tailscaleIPv4() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) {
        const [first, second] = a.address.split(".").map(Number);
        if (first === 100 && second >= 64 && second <= 127) return a.address; // 100.64.0.0/10
      }
    }
  }
  return null;
}

// A privacy-safe rendering of the working directory for /health: basename only, never the full path
// (bridge_plan.md §10.4/§10.6 — don't leak a filesystem path into pairing/health metadata).
export function redactedCwd(cwd) {
  const base = path.basename(cwd || "");
  return base ? `…/${base}` : "…";
}

// Edit mode (edit_mode_plan.md): one operator control, same meaning for every agent.
//   disabled — chat and jobs are read/plan-only (default)
//   limited  — chat stays read-only; a voice-confirmed edit TASK may write (execute_jobs_plan.md)
//   ungated  — the per-task confirmation gate is OFF: any turn may edit files (Codex: sandboxed
//              shell + workspace edits, accept-and-label — see the plan's "Codex write tiers").
//              Named for what it actually removes (the gate) — edits are permitted every turn,
//              not performed every turn.
// "full-access" / "always-edit" are deprecated spellings (each shipped briefly, 2026-07-16/17).
// Legacy alias: RIFFIN_BRIDGE_ALLOW_EDIT_JOBS=1 with EDIT_MODE unset means "limited" — but ONLY
// for Claude: that boolean was written by a Claude-only init prompt, and a hand-edited agent
// switch must never carry an arming decision to an agent it was not made for (review finding #7).
// Unknown values fall back to DISABLED (fail-closed) — a typo must never land on a permissive tier.
export function resolveEditMode(env = process.env, agent = "claude") {
  const raw = (env.RIFFIN_BRIDGE_EDIT_MODE || "").toLowerCase().trim();
  if (raw === "full-access" || raw === "always-edit") return "ungated";
  if (["disabled", "limited", "ungated"].includes(raw)) return raw;
  if (raw === "" && agent === "claude" && env.RIFFIN_BRIDGE_ALLOW_EDIT_JOBS === "1") return "limited";
  return "disabled";
}

export function readConfig() {
  const port = Number(process.env.RIFFIN_BRIDGE_PORT || 8765);
  const agent = (process.env.RIFFIN_BRIDGE_AGENT || "claude").toLowerCase();
  const llmUrl = process.env.RIFFIN_BRIDGE_LLM_URL || "";
  const ttsUrl = process.env.RIFFIN_BRIDGE_TTS_URL || "";
  const ttsCmd = process.env.RIFFIN_BRIDGE_TTS_CMD || "";
  // Agent-bound edit mode (edit_mode_plan.md, review finding #7): init stamps WHICH agent the
  // mode was chosen for. A hand-edited RIFFIN_BRIDGE_AGENT switch under a non-disabled mode
  // degrades to disabled (never carry an arming decision to an agent it wasn't made for) — the
  // mismatch flag lets the startup banner explain instead of failing silently.
  const rawEditMode = resolveEditMode(process.env, agent);
  const editModeAgentStamp = (process.env.RIFFIN_BRIDGE_EDIT_MODE_AGENT || "").toLowerCase().trim();
  const editModeAgentMismatch = rawEditMode !== "disabled" && editModeAgentStamp !== "" && editModeAgentStamp !== agent;
  const editMode = editModeAgentMismatch ? "disabled" : rawEditMode;

  return {
    port,
    host: process.env.RIFFIN_BRIDGE_HOST || tailscaleIPv4(),
    allowPublic: process.env.RIFFIN_BRIDGE_ALLOW_PUBLIC === "1",
    // Directory the helper was launched from — where .env and the persistent session file live.
    // (Distinct from `cwd` below, which is the AGENT's working directory, e.g. the repo it reasons
    // about.)
    envDir: process.cwd(),

    token: process.env.RIFFIN_BRIDGE_TOKEN || "",
    cwd: process.env.RIFFIN_BRIDGE_CWD || process.cwd(),
    // Edit mode (see resolveEditMode above). `allowEditJobs` is kept as the derived boolean the
    // jobs/server gates already consume: any tier above disabled arms the workstation half of the
    // two-key edit-task gate. A leaked bearer token alone must never be able to unlock file writes.
    editMode,
    editModeAgentMismatch,
    allowEditJobs: editMode !== "disabled",
    timeoutMs: Number(process.env.RIFFIN_BRIDGE_TIMEOUT_MS || 120_000),
    // Jobs (§13) get a much longer ceiling than a chat turn — a real agent task runs for minutes.
    jobTimeoutMs: Number(process.env.RIFFIN_BRIDGE_JOB_TIMEOUT_MS || 30 * 60_000),

    // LLM source: HTTP proxy (Mode B) if LLM_URL set, else drive the CLI agent (Mode A).
    llmUrl,
    llmKey: process.env.RIFFIN_BRIDGE_LLM_KEY || "",
    llmModel: process.env.RIFFIN_BRIDGE_LLM_MODEL || "",
    agent,
    claudeBin: process.env.RIFFIN_BRIDGE_CLAUDE_BIN || "claude",
    codexBin: process.env.RIFFIN_BRIDGE_CODEX_BIN || "codex",
    // Custom CLI agent (RIFFIN_BRIDGE_AGENT=custom): any coding-agent CLI (aider, opencode, a
    // future GLM-based tool). BIN is the binary; ARGS is a whitespace-split template where a
    // literal {prompt} token becomes ONE argv element (never a shell string). No {prompt} → the
    // prompt is appended as the final argument.
    customAgentBin: process.env.RIFFIN_BRIDGE_AGENT_BIN || "",
    customAgentArgs: (process.env.RIFFIN_BRIDGE_AGENT_ARGS || "").trim(),
    modelId: process.env.RIFFIN_BRIDGE_MODEL || "riffn-bridge",

    // TTS (optional; Mode B). Text-only if neither is set.
    ttsUrl,
    ttsKey: process.env.RIFFIN_BRIDGE_TTS_KEY || "",
    ttsModel: process.env.RIFFIN_BRIDGE_TTS_MODEL || "tts-1",
    ttsVoice: process.env.RIFFIN_BRIDGE_TTS_VOICE || "default",
    ttsFormat: process.env.RIFFIN_BRIDGE_TTS_FORMAT || "mp3",
    ttsCmd,
    ttsConfigured: Boolean(ttsUrl || ttsCmd),

    // Reported mode for /health: "llm" when proxying an HTTP LLM, else "cli" (agent).
    mode: llmUrl ? "llm" : "cli",
  };
}
