// Durable, observable JOBS — the §13 change: an agent run is not a chat turn. A long Claude Code
// task (10–40 min) can't fit a synchronous request, so a job returns an id immediately, runs in the
// background, streams progress, and stores its result — the phone dispatches, pockets, and asks
// "how's it going?" / "read me the result" later. This is what makes the bridge an operator's
// cockpit, not a chat toy.
//
// SCOPE (kept deliberately small, per §13): ONE current job per bridge (preserves the single-flight
// cwd guarantee, §11.3); state persisted locally next to .env (survives a helper restart so status
// queries still answer); no server-side queue, no push, no multi-job history. Claude only — jobs
// need stream-json progress; Codex/custom stay synchronous chat.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";
import { snapshotRepo, snapshotRepoRing } from "./git.js";
import { EDIT_JOB_ALLOWED_TOOLS, EDIT_JOB_DISALLOWED_TOOLS } from "./edit-policy.js";
import { childEnv } from "./agent.js";
import { resolveSpawnTarget } from "./win-shim.js";

// Absolute path to the PreToolUse hook script (resolved relative to THIS file, so it works no
// matter what cwd claude is spawned in).
const EDIT_GUARD_HOOK = fileURLToPath(new URL("./edit-guard-hook.js", import.meta.url));

// The edit-job tool policy (EDIT_JOB_ALLOWED_TOOLS / EDIT_JOB_DISALLOWED_TOOLS) lives in
// edit-policy.js so the PreToolUse hook shares it. Re-exported here for the existing tests +
// callers that import from jobs.js.
export { EDIT_JOB_ALLOWED_TOOLS, EDIT_JOB_DISALLOWED_TOOLS };

// Containing an EDIT job's tool surface (execute_jobs_plan.md invariant 4) is DEFENCE IN DEPTH —
// the first dogfood (2026-07-12) proved no single CLI flag suffices (--allowedTools isn't
// exclusive; a denylist can't name every tool). Four independent layers, each of which alone
// blocks the CronList/Monitor class:
//
//  1. PreToolUse HOOK (edit-guard-hook.js, matcher "*") — THE GUARANTEE. Per the Claude Code docs
//     a hook "runs before every other step" and its deny "applies even in bypassPermissions mode",
//     so it vetoes EVERY non-allowlisted tool regardless of how the CLI classifies it. Loaded via
//     --settings (see writeEditSettings). Fails closed (unreadable request → deny).
//  2. `--permission-mode dontAsk` + `--allowedTools` — the documented "locked-down agent" recipe:
//     anything not on the allowlist is denied outright (canUseTool never called). Fails closed.
//  3. `--strict-mcp-config` + empty config → zero MCP servers loaded (the external-side-effect
//     class: Gmail/Drive/Calendar/RemoteTrigger). Confirmed working in the dogfood.
//  4. `--disallowedTools` for named built-in exec/delegation tools — deny applies even in bypass.
//
// A build-hook JSON registering the guard for PreToolUse, matcher "*" (every tool).
function editHookSettings() {
  return {
    hooks: {
      PreToolUse: [
        { matcher: "*", hooks: [{ type: "command", command: `node "${EDIT_GUARD_HOOK}"` }] },
      ],
    },
  };
}

// Thrown when the pre-job snapshot can't be taken — the caller must REFUSE the edit job
// (a write-enabled run without its undo point is what the plan forbids), never degrade.
export class SnapshotError extends Error {
  constructor(message) { super(message); this.name = "SnapshotError"; }
}

// The exact argv a job spawns `claude` with — exported (and kept pure) so tests can pin the
// edit-caps flags without spawning anything. For write-capable jobs ("edit" and "ungated"), `edit`
// carries the two written file paths the flags reference: { mcpConfigPath, settingsPath }.
// "ungated" (edit_mode_plan.md) gets the identical containment set as "edit" — the tiers differ
// in ceremony (gate, session, snapshot cadence), never in what the agent is allowed to touch.
export function buildJobArgs(prompt, appendSystemPrompt, caps, sessionId, edit) {
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (caps === "edit" || caps === "ungated") {
    // The four defence-in-depth controls (see editHookSettings comment). The --settings hook is
    // the guarantee; dontAsk+allow, strict-mcp, and deny are fail-closed backup.
    args.push("--settings", edit.settingsPath);
    args.push("--permission-mode", "dontAsk");
    args.push("--strict-mcp-config", "--mcp-config", edit.mcpConfigPath);
    args.push("--allowedTools", ...EDIT_JOB_ALLOWED_TOOLS);
    args.push("--disallowedTools", ...EDIT_JOB_DISALLOWED_TOOLS);
  }
  if (sessionId) args.push("--resume", sessionId);
  if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);
  return args;
}

const JOB_FILE = ".riffn-bridge-job.json";
// Rolling job history (§13 build #3): the last HISTORY_CAP terminal jobs, one public view per
// line (JSONL), newest last on disk. Same local-only/redacted posture as the job file — it holds
// results (the operator asked for them) but never prompts. Feeds GET /v1/jobs/history and the
// "what did my tasks do today" voice surface.
const HISTORY_FILE = ".riffn-bridge-history.jsonl";
const HISTORY_CAP = 50;

// Map a Claude tool name to a non-sensitive, speakable progress category (§10.10 — never the tool's
// arguments, just what kind of work it is).
function toolCategory(name) {
  switch (name) {
    case "Read": case "Glob": case "Grep": case "NotebookRead": return "reading files";
    case "Edit": case "Write": case "NotebookEdit": return "editing files";
    case "Bash": case "BashOutput": case "KillShell": return "running commands";
    case "WebFetch": case "WebSearch": return "searching the web";
    case "Task": return "delegating a sub-task";
    default: return "working";
  }
}

export function createJobStore(cfg, session) {
  const file = path.join(cfg.envDir, JOB_FILE);
  const historyFile = path.join(cfg.envDir, HISTORY_FILE);

  // The two config files edit jobs reference: an empty MCP config (--strict-mcp-config) and a
  // settings file carrying the PreToolUse guard hook (--settings). Written to the OS tmpdir (NOT
  // the repo — they must never litter the user's working tree), keyed by pid so concurrent bridges
  // don't collide. Lazily (re)created so a wiped tmp still works. If EITHER can't be written we
  // cannot guarantee the tool lockdown, so the edit job is REFUSED (SnapshotError → caller 503s),
  // never run degraded.
  const emptyMcpConfigPath = path.join(os.tmpdir(), `riffn-bridge-empty-mcp-${process.pid}.json`);
  const editSettingsPath = path.join(os.tmpdir(), `riffn-bridge-edit-settings-${process.pid}.json`);
  function ensureEditConfigs() {
    try {
      if (!existsSync(emptyMcpConfigPath)) {
        writeFileSync(emptyMcpConfigPath, JSON.stringify({ mcpServers: {} }));
      }
      // Rewrite the settings every time (cheap) — the hook's absolute path must always be current.
      writeFileSync(editSettingsPath, JSON.stringify(editHookSettings()));
      return { mcpConfigPath: emptyMcpConfigPath, settingsPath: editSettingsPath };
    } catch (e) {
      log.error("edit_config_write_failed", e);
      throw new SnapshotError("couldn't lock down the agent's tools before an edit task");
    }
  }

  // Append a TERMINAL job to the rolling history. Defensive throughout — a corrupt or missing
  // history file must never affect the job itself (same posture as load() below).
  function recordHistory(job) {
    try {
      const entries = loadHistory();
      entries.push(publicView(job));
      const trimmed = entries.slice(-HISTORY_CAP);
      writeFileSync(historyFile, trimmed.map((e) => JSON.stringify(e)).join("\n") + "\n");
    } catch (e) {
      log.error("job_history_write_failed", e);
    }
  }

  // Oldest → newest, skipping unparseable lines.
  function loadHistory() {
    if (!existsSync(historyFile)) return [];
    try {
      return readFileSync(historyFile, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  // In-memory handle to the live child (only meaningful within THIS process). The persisted record
  // is the source of truth for status; `job` here is the SAME object the run mutates, so cancel and
  // the run's own progress/close handlers always see one state (a disk re-load in cancel() could be
  // overwritten back to "running" by a progress event racing the kill).
  let live = null; // { id, child, job }

  function persist(job) {
    try { writeFileSync(file, JSON.stringify(job, null, 2)); } catch (e) { log.error("job_persist_failed", e); }
  }

  function load() {
    if (!existsSync(file)) return null;
    try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  }

  // Public, redaction-safe view of a job (never the prompt text or raw result-on-disk beyond what
  // the caller already owns). `result` IS returned — the operator asked for it — but prompts and
  // per-step detail are not.
  function publicView(job) {
    if (!job) return null;
    return {
      id: job.id,
      // "cancelling" is an internal transition (kill sent, close pending) the app doesn't know;
      // report it as still-running — it becomes "cancelled" the moment the child actually exits.
      status: job.status === "cancelling" ? "running" : job.status, // running | done | error | cancelled | interrupted
      startedAt: job.startedAt,
      finishedAt: job.finishedAt ?? null,
      steps: job.steps ?? 0,
      lastActivity: job.lastActivity ?? null,   // e.g. "running commands" — category only
      caps: job.caps ?? "read",                 // "read" | "edit" — what this job was armed with
      // COUNT of file-edit tool events, never names (speech redaction: "made 4 file edits").
      // Only meaningful for caps:"edit" jobs; read jobs report 0.
      edits: job.edits ?? 0,
      // True when a pre-job repo snapshot ref exists (the ref itself stays in the local job file +
      // terminal log — the phone only needs to know the undo point is there).
      snapshotted: Boolean(job.snapshotRef),
      result: job.status === "done" ? (job.result ?? "") : null,
      error: job.status === "error" ? (job.error ?? "failed") : null,
    };
  }

  // On startup, a persisted "running" job whose process died with the previous helper instance is
  // no longer running — mark it interrupted so status is honest rather than a forever-"running" lie.
  function reconcileOnBoot() {
    const job = load();
    if (job && (job.status === "running" || job.status === "cancelling")) {
      // "cancelling" on disk means the helper died between persisting the cancel and the child's
      // close event — the kill was sent, so "cancelled" is the honest terminal state for it.
      job.status = job.status === "cancelling" ? "cancelled" : "interrupted";
      job.finishedAt = Date.now();
      persist(job);
      recordHistory(job);
    }
  }
  reconcileOnBoot();

  return {
    current: () => publicView(load()),
    isRunning: () => Boolean(live),
    // Terminal jobs, NEWEST FIRST (the wire order the app speaks them in).
    history: () => loadHistory().reverse(),
    // The ungated CHAT path (server.js fallback for non-jobs clients) runs under the same
    // containment files as write-capable jobs; throws SnapshotError if they can't be written.
    editConfigs: () => ensureEditConfigs(),

    // Start a job. Returns the public view immediately; the run continues in the background.
    // Rejects (returns null) if one is already running — one job per bridge (§11.3 cwd guarantee).
    // caps: "edit" arms the run with file-write permission (execute_jobs_plan.md). The CALLER
    // (server.js) enforces the two-key gate (cfg.allowEditJobs + the phone's explicit request);
    // this store just refuses to run an edit job without its snapshot — throws SnapshotError,
    // leaving no job record behind (nothing started).
    start(prompt, appendSystemPrompt, caps) {
      if (live) return null;
      const id = randomUUID();
      // SECURITY (execute_jobs_plan.md): an EDIT job must NEVER resume the chat session. The
      // dogfood (2026-07-12) proved that --resume inherits the resumed session's ESTABLISHED,
      // unrestricted permission context — the tool-lockdown flags and the PreToolUse guard hook
      // only bind at session creation, so a resumed session silently kept full tool access
      // (CronList/Monitor still ran). A fresh session applies the lockdown from turn one. The
      // trade-off — a fresh session has none of the planning context — is handled by the app
      // sending the plan transcript in the job's messages (see dispatchEditJob).
      //
      // "ungated" DOES resume (edit_mode_plan.md): the session store is mode-stamped, so any
      // session it returns was CREATED under ungated — i.e. born with this same containment set
      // bound from turn one. The dogfood hole was resuming a session created WITHOUT lockdown;
      // that can't happen here (a mode change makes the stored session stale automatically).
      const existingSession = caps === "edit" ? null : session?.get();

      // Snapshot BEFORE the job record exists: if this throws, no job started, state is clean.
      // Same for locking down the tool surface — both must succeed or a write-capable run is
      // refused. Cadence per tier: "edit" keeps one ref per task; "ungated" snapshots every turn
      // into the pruned ring (review finding #6 — bounded, still fail-closed on capture).
      let snapshotRef = null;
      let editConfigs = null;
      if (caps === "edit" || caps === "ungated") {
        editConfigs = ensureEditConfigs(); // throws SnapshotError → caller refuses
        try {
          snapshotRef = (caps === "ungated"
            ? snapshotRepoRing(cfg.cwd)
            : snapshotRepo(cfg.cwd, id)).ref;
          log.debug("job_snapshot", `id=${id} ref=${snapshotRef}`);
        } catch (e) {
          log.error("job_snapshot_failed", e);
          throw new SnapshotError("couldn't snapshot the repo before an edit task");
        }
      }

      const job = {
        id, status: "running", startedAt: Date.now(), finishedAt: null,
        steps: 0, lastActivity: null, result: null, error: null,
        // Public caps vocabulary stays "read" | "edit" (the wire the app already speaks): an
        // ungated job IS write-capable, and machine-level ungated-ness travels via /health
        // capabilities, not per-job.
        caps: caps === "edit" || caps === "ungated" ? "edit" : "read", edits: 0, snapshotRef,
        // prompt is intentionally NOT persisted — it may contain sensitive content (§10.10).
      };
      persist(job);

      const args = buildJobArgs(prompt, appendSystemPrompt, caps, existingSession, editConfigs);

      log.debug("job_start", `id=${id} cwd=${cfg.cwd} caps=${job.caps} resume=${existingSession || "none"}`);
      // Windows: cfg.claudeBin may be an npm .cmd shim — resolve to a directly-spawnable target
      // (see win-shim.js) rather than shell:true, which would be unsafe with untrusted prompt text.
      const { bin: resolvedClaudeBin, prefixArgs } = resolveSpawnTarget(cfg.claudeBin);
      // stdin: "ignore" — see the matching comment in agent.js's runAgent for why an open/piped
      // stdin (Node's spawn default) risks a hang some agent CLIs won't recover from on their own.
      // childEnv: bridge secrets (RIFFIN_BRIDGE_*) never reach the agent process (review finding #2).
      const child = spawn(resolvedClaudeBin, [...prefixArgs, ...args], {
        cwd: cfg.cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"]
      });
      live = { id, child, job };

      let stdoutBuf = "";
      let finalResult = null;
      let newSessionId = null;
      let timedOut = false;

      const timer = setTimeout(() => {
        // Remember WHY we killed it: without this flag the close handler would map the SIGKILL to
        // "cancelled" and the operator would hear their task was cancelled when it actually timed out.
        timedOut = true;
        log.debug("job_timeout", `id=${id}`);
        child.kill("SIGKILL");
      }, cfg.jobTimeoutMs);

      const handleEvent = (evt) => {
        if (evt.type === "system" && evt.subtype === "init" && evt.session_id) {
          newSessionId = evt.session_id;
        } else if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
          // Each tool_use is one step of visible progress; text blocks update nothing user-facing
          // here (the final result carries the answer).
          for (const block of evt.message.content) {
            if (block.type === "tool_use") {
              job.steps += 1;
              job.lastActivity = toolCategory(block.name);
              // Count of edit EVENTS (not distinct files — names never cross the wire, §10.10),
              // so completion speech can say "made N file edits".
              if (block.name === "Edit" || block.name === "Write" || block.name === "NotebookEdit") {
                job.edits += 1;
              }
            }
          }
          persist(job);
        } else if (evt.type === "result") {
          if (evt.is_error) job.error = typeof evt.result === "string" ? "the agent reported an error" : "failed";
          else finalResult = typeof evt.result === "string" ? evt.result : "";
          if (typeof evt.session_id === "string") newSessionId = evt.session_id;
        }
      };

      // Stateful UTF-8 decode — without this, a multibyte character split across chunk boundaries
      // is decoded per-chunk and corrupts (mojibake in the result/progress JSON).
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => {
        stdoutBuf += d;
        // NDJSON: process complete lines, keep the remainder buffered.
        let nl;
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          try { handleEvent(JSON.parse(line)); } catch { /* skip partial/non-JSON */ }
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        live = null;
        job.status = "error";
        job.error = `failed to launch: ${err.code || err.name}`;
        job.finishedAt = Date.now();
        persist(job);
        recordHistory(job);
        log.error("job_launch_error", err);
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const wasCancelled = job.status === "cancelling";
        live = null;
        // An EDIT job's session is a throwaway (see the fresh-session note above): never let it
        // become the persistent chat thread, or the NEXT chat turn would resume a restricted
        // session — and, worse, a later edit job would resume THIS one and re-inherit its context.
        // Read jobs still continue the one chat thread as before.
        if (newSessionId && caps !== "edit") session?.set(newSessionId);
        if (wasCancelled) {
          job.status = "cancelled";
        } else if (timedOut) {
          job.status = "error";
          job.error = `it ran past the ${Math.round(cfg.jobTimeoutMs / 60_000)}-minute time limit and was stopped`;
        } else if (signal === "SIGKILL") {
          job.status = "cancelled"; // killed from outside the helper — closest honest status
        } else if (code === 0 && finalResult !== null) {
          job.status = "done";
          job.result = finalResult;
        } else {
          job.status = "error";
          job.error = job.error || `agent exited with code ${code}`;
        }
        job.finishedAt = Date.now();
        persist(job);
        recordHistory(job);
        log.debug("job_end", `id=${id} status=${job.status} steps=${job.steps} caps=${job.caps} edits=${job.edits}`);
        // Operator-facing recovery pointer for edit jobs — full ref is fine on the local terminal
        // (different trust boundary than the wire). Printed at every edit-job end, not just verbose.
        if (job.caps === "edit" && job.snapshotRef) {
          console.log(`  edit job ${job.status}: ${job.edits} file edit(s). Pre-job snapshot: ${job.snapshotRef}`);
          // git diff only covers TRACKED files — a file the job CREATED is untracked and shows in
          // status, not diff (verified in first dogfood, 2026-07-12).
          console.log(`    review:  git diff ${job.snapshotRef}   (modified files)  +  git status   (created files)`);
          console.log(`    undo:    git restore --source ${job.snapshotRef} -- .   (then delete unwanted created files)`);
        }
      });

      return publicView(job);
    },

    // Cancel the running job (if any). Returns the public view, or null if nothing's running.
    // Mutates the LIVE job object (not a disk re-load) so the close handler's cancelled-check and
    // any in-flight progress persist can't race this back to "running".
    cancel() {
      if (!live) return null;
      live.job.status = "cancelling";
      persist(live.job);
      live.child.kill("SIGKILL");
      return publicView(live.job);
    },
  };
}
