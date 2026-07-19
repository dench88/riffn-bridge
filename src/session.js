// Persistent agent session — "one persistent thread per machine" (bridge_plan.md §9 #5, promoted
// from deferred to implemented). Stores the Claude Code `session_id` for the configured working
// directory, so each turn resumes the SAME on-machine conversation via `claude --resume` instead of
// re-flattening the whole transcript into a fresh, memory-less session every time.
//
// Local-only file, next to .env (never sent to the phone, never a secret like the bearer token, but
// still local machine state — gitignored). Keyed by `cwd` so pointing the bridge at a different
// repo starts a clean session rather than resuming into the wrong project's context — and by
// `editMode` (edit_mode_plan.md, review finding #4): the 2026-07-12 dogfood proved Claude's
// lockdown flags/hooks bind at session CREATION, so a session may only ever be resumed under the
// edit mode it was born with. A mode change (either direction) makes the stored session stale —
// a permissive session must never leak into a stricter mode, nor a pre-lockdown one into ungated.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

function sessionFilePath(envDir) {
  return path.join(envDir, ".riffn-bridge-session.json");
}

function load(envDir, cwd, editMode) {
  const file = sessionFilePath(envDir);
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data.cwd !== cwd) return null; // stale — cwd changed, don't resume into the wrong repo
    // Sessions written before mode stamping existed have no editMode field — treat as created
    // under "disabled" (every pre-stamping session was), so they refuse to resume into ungated.
    if ((data.editMode ?? "disabled") !== editMode) return null;
    return typeof data.sessionId === "string" ? data.sessionId : null;
  } catch {
    return null;
  }
}

function save(envDir, cwd, sessionId, editMode) {
  writeFileSync(sessionFilePath(envDir), JSON.stringify({ cwd, sessionId, editMode }, null, 2));
}

function clear(envDir) {
  const file = sessionFilePath(envDir);
  if (existsSync(file)) writeFileSync(file, "{}");
}

// Diagnostics: read the session file WITHOUT the cwd-match guard, so callers can detect (and warn
// about) a different agent's session sitting in the same envDir — the signature of two bridge
// processes sharing a launch folder and colliding over one session file.
export function peekRaw(envDir) {
  const file = sessionFilePath(envDir);
  if (!existsSync(file)) return null;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return typeof data.cwd === "string" && typeof data.sessionId === "string" ? data : null;
  } catch {
    return null;
  }
}

// Factory so callers don't pass (envDir, cwd, editMode) around everywhere. `editMode` defaults to
// "disabled" for callers that predate mode stamping (e.g. `riffn-bridge health`'s sessionActive
// probe) — matching what un-stamped session files are treated as.
export function createSessionStore(envDir, cwd, editMode = "disabled") {
  return {
    get: () => load(envDir, cwd, editMode),
    set: (sessionId) => { if (sessionId) save(envDir, cwd, sessionId, editMode); },
    clear: () => clear(envDir),
  };
}
