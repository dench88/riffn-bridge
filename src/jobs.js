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
import { fileAsk, fileCompleted, stripAsk } from "./inbox.js";
import { captureProfile } from "./inbox-routing.js";
import { classifyFailure, operatorHint, FAILURE_CODES } from "./failure-codes.js";
import { summariseForWire } from "./ask-marker.js";

/** Cap on the retained stderr tail (see the drain handler). Enough for a stack trace, never a leak. */
const STDERR_TAIL_BYTES = 4096;
import { snapshotRepo, snapshotRepoRing } from "./git.js";
import {
  EDIT_JOB_ALLOWED_TOOLS, EDIT_JOB_DISALLOWED_TOOLS, READ_JOB_ALLOWED_TOOLS,
} from "./edit-policy.js";
import { childEnv } from "./agent.js";
import { resolveSpawnTarget } from "./win-shim.js";

// Absolute path to the PreToolUse hook script (resolved relative to THIS file, so it works no
// matter what cwd claude is spawned in).
const EDIT_GUARD_HOOK = fileURLToPath(new URL("./edit-guard-hook.js", import.meta.url));

// The edit-job tool policy (EDIT_JOB_ALLOWED_TOOLS / EDIT_JOB_DISALLOWED_TOOLS) lives in
// edit-policy.js so the PreToolUse hook shares it. Re-exported here for the existing tests +
// callers that import from jobs.js.
export { EDIT_JOB_ALLOWED_TOOLS, EDIT_JOB_DISALLOWED_TOOLS, READ_JOB_ALLOWED_TOOLS };

// Containing an EDIT job's tool surface (execute_jobs_plan.md invariant 4) is DEFENCE IN DEPTH —
// the first dogfood (2026-07-12) proved no single CLI flag suffices (--allowedTools isn't
// exclusive; a denylist can't name every tool). Four independent layers, each of which alone
// blocks the CronList/Monitor class:
//
//  1. PreToolUse HOOK (edit-guard-hook.js, matcher "*") — THE GUARANTEE. Per the Claude Code docs
//     a hook "runs before every other step" and its deny "applies even in bypassPermissions mode",
//     so it vetoes EVERY non-allowlisted tool regardless of how the CLI classifies it. Loaded via
//     --settings (see guardHookSettings). Fails closed (unreadable request → deny).
//  2. `--permission-mode dontAsk` + `--allowedTools` — the documented "locked-down agent" recipe:
//     anything not on the allowlist is denied outright (canUseTool never called). Fails closed.
//  3. `--strict-mcp-config` + empty config → zero MCP servers loaded (the external-side-effect
//     class: Gmail/Drive/Calendar/RemoteTrigger). Confirmed working in the dogfood.
//  4. `--disallowedTools` for named built-in exec/delegation tools — deny applies even in bypass.
//
// A settings JSON registering the guard for PreToolUse, matcher "*" (every tool). Read turns use
// the same guard in read-only mode, so operator/global Claude permissions cannot re-enable shell,
// MCP, writes, outside-workspace reads, or secret reads.
function guardHookSettings(mode) {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{
            type: "command",
            command: `node "${EDIT_GUARD_HOOK}"${mode === "read" ? " read" : ""}`,
          }],
        },
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
// containment flags without spawning anything. `security` carries the generated empty MCP config
// and mode-specific hook settings paths.
// "ungated" (edit_mode_plan.md) gets the identical containment set as "edit" — the tiers differ
// in ceremony (gate, session, snapshot cadence), never in what the agent is allowed to touch.
export function buildJobArgs(prompt, appendSystemPrompt, caps, sessionId, security) {
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (!security) throw new SnapshotError("Claude tool containment was not prepared");
  const writeCapable = caps === "edit" || caps === "ungated";
  const settingsPath = writeCapable ? security.editSettingsPath : security.readSettingsPath;
  const allowedTools = writeCapable ? EDIT_JOB_ALLOWED_TOOLS : READ_JOB_ALLOWED_TOOLS;
  // The hook is the guarantee; dontAsk+allow, strict-mcp, and deny are fail-closed backup.
  args.push("--settings", settingsPath);
  args.push("--permission-mode", "dontAsk");
  args.push("--strict-mcp-config", "--mcp-config", security.mcpConfigPath);
  args.push("--allowedTools", ...allowedTools);
  args.push("--disallowedTools", ...EDIT_JOB_DISALLOWED_TOOLS);
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

// `pending` is the local pending-context store (inbox-pending.js). Optional: a bridge with no
// worker token files nothing, so there is nothing to remember.
export function createJobStore(cfg, session, pending = null) {
  const file = path.join(cfg.envDir, JOB_FILE);
  const historyFile = path.join(cfg.envDir, HISTORY_FILE);

  // The three config files Claude turns reference: an empty MCP config (--strict-mcp-config) and
  // read/edit settings files carrying the PreToolUse guard hook (--settings). Written to the OS tmpdir (NOT
  // the repo — they must never litter the user's working tree), keyed by pid so concurrent bridges
  // don't collide. Lazily (re)created so a wiped tmp still works. If EITHER can't be written we
  // cannot guarantee the tool lockdown, so the turn is REFUSED (SnapshotError → caller 503s),
  // never run degraded.
  const emptyMcpConfigPath = path.join(os.tmpdir(), `riffn-bridge-empty-mcp-${process.pid}.json`);
  const editSettingsPath = path.join(os.tmpdir(), `riffn-bridge-edit-settings-${process.pid}.json`);
  const readSettingsPath = path.join(os.tmpdir(), `riffn-bridge-read-settings-${process.pid}.json`);
  function ensureToolConfigs() {
    try {
      if (!existsSync(emptyMcpConfigPath)) {
        writeFileSync(emptyMcpConfigPath, JSON.stringify({ mcpServers: {} }));
      }
      // Rewrite the settings every time (cheap) — the hook's absolute path must always be current.
      writeFileSync(editSettingsPath, JSON.stringify(guardHookSettings("edit")));
      writeFileSync(readSettingsPath, JSON.stringify(guardHookSettings("read")));
      return { mcpConfigPath: emptyMcpConfigPath, editSettingsPath, readSettingsPath };
    } catch (e) {
      log.error("tool_config_write_failed", e);
      throw new SnapshotError("couldn't lock down the agent's tools before a turn");
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

  /**
   * The wire summary for a finished job, and the task state that must be reported with it.
   *
   * ⚠ Two different sources, on purpose. A job that SUCCEEDED summarises its own result, screened
   * and bounded by summariseForWire. A job that FAILED does NOT — its summary is built from the
   * failure code, which is this bridge's diagnosis drawn from a closed set, never the agent's text.
   * Sending an agent's error prose to the worker would undo the whole point of failure-codes.js.
   */
  function outcomeSummary(job) {
    if (job.status === "done") {
      return { taskState: "COMPLETED", ...summariseForWire(job.result) };
    }
    if (job.status === "cancelled") {
      return { taskState: "CANCELED", summary: "Task was stopped before it finished.", redacted: false };
    }
    const spoken = {
      [FAILURE_CODES.SIGNED_OUT]:    "Task stopped — that machine's agent is signed out.",
      [FAILURE_CODES.RATE_LIMITED]:  "Task stopped — the agent hit its usage limit.",
      [FAILURE_CODES.OUT_OF_CREDIT]: "Task stopped — the agent's account is out of credit.",
      [FAILURE_CODES.SERVICE_BUSY]:  "Task stopped — the provider was overloaded.",
      [FAILURE_CODES.OFFLINE]:       "Task stopped — that machine couldn't reach the network.",
      [FAILURE_CODES.LAUNCH_FAILED]: "Task stopped — the agent couldn't start on that machine.",
      [FAILURE_CODES.TIMED_OUT]:     "Task ran past its time limit and was stopped.",
      [FAILURE_CODES.AGENT_REFUSED]: "The agent declined that task.",
    }[job.errorCode] ?? "Task didn't finish. Check the machine.";
    return { taskState: "FAILED", summary: spoken, redacted: false };
  }

  /** Best-effort, detached. Never throws into the close handler. */
  async function fileJobOutcome(job) {
    const { taskState, summary } = outcomeSummary(job);
    await fileCompleted(cfg, `job-${job.id}`, summary, taskState);
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
      // A code from the CLOSED set in failure-codes.js — this bridge's diagnosis, never the agent's
      // words. The phone turns it into a fixed spoken line ("sign in again"), which is the only
      // shape a pre-recorded clip can take. An older app ignores this field and keeps its generic
      // line, so sending it cannot break anyone.
      errorCode: job.status === "error" ? (job.errorCode ?? FAILURE_CODES.UNKNOWN) : null,
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
    securityConfigs: () => ensureToolConfigs(),
    editConfigs: () => ensureToolConfigs(), // compatibility alias for older internal callers

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
      const securityConfigs = ensureToolConfigs(); // every Claude turn is pinned, including read
      if (caps === "edit" || caps === "ungated") {
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

      const args = buildJobArgs(prompt, appendSystemPrompt, caps, existingSession, securityConfigs);

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
          if (evt.is_error) {
            // ⚠ Two audiences, and they get different amounts of detail on purpose.
            //
            // `job.error` goes over the wire to the phone, so it stays a fixed generic phrase:
            // §10.10 says agent output never crosses, and an error message is agent output — it
            // routinely carries paths, file names and command lines.
            //
            // `job.errorDetail` is LOCAL ONLY (the job file and this machine's terminal, the same
            // trust boundary as the snapshot ref below). It used to be thrown away: the ternary
            // here read the agent's own explanation and then substituted the generic phrase for
            // it, so the one machine allowed to see why the job failed was the one place we
            // deleted it. publicView() is an explicit allowlist, so this field cannot leak.
            job.error = "the agent reported an error";
            if (typeof evt.result === "string" && evt.result.trim()) {
              job.errorDetail = evt.result.trim();
              // Classified LOCALLY from the detail; only the resulting code crosses to the phone.
              job.errorCode = classifyFailure(job.errorDetail);
            }
          }
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

      // ⚠ MUST be drained. stdio pipes stderr, and until this handler existed nothing read it: an
      // unread pipe fills its OS buffer (~64 KB) and the child then BLOCKS FOREVER on its next
      // write, so a chatty failure hung the job until the timeout killed it and reported the wrong
      // cause. Draining also gives us the only explanation a non-zero exit ever produces.
      //
      // Bounded on purpose — a runaway agent must not be able to grow the bridge's memory. Keeping
      // the TAIL rather than the head because the fatal message is what comes last.
      let stderrTail = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => {
        stderrTail = (stderrTail + d).slice(-STDERR_TAIL_BYTES);
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        live = null;
        job.status = "error";
        job.error = `failed to launch: ${err.code || err.name}`;
        job.errorCode = FAILURE_CODES.LAUNCH_FAILED;
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
          job.errorCode = FAILURE_CODES.TIMED_OUT;
        } else if (signal === "SIGKILL") {
          job.status = "cancelled"; // killed from outside the helper — closest honest status
        } else if (code === 0 && finalResult !== null) {
          job.status = "done";
          // Two different obligations, deliberately not run together.
          //
          // Stripping the marker is a CORRECTNESS requirement and so it happens SYNCHRONOUSLY,
          // before job.result is ever readable: the marker must never be spoken, and a job whose
          // stored result still held it would read the protocol out loud on every replay. Doing the
          // strip inside the filing promise left a window where a poll landing first got the raw
          // text, and where the late assignment could land after persist() and recordHistory().
          //
          // Filing is BEST-EFFORT and is detached on purpose. This handler is what releases the
          // shared single-flight (phase0_turn_contracts §3), so it must not await a network call —
          // and an unreachable inbox must never turn a completed job into a failed one.
          const asked = stripAsk(finalResult);
          job.result = asked.spoken;
          if (asked.ask) {
            // ⚠ Captured HERE, synchronously, not inside the .then() below. "The filing-time
            // profile" has to mean the profile as it was when the question was asked
            // (phase0_routing_matrix.md §3.1); reading cfg after an await would quietly make it
            // "whenever the network got back to us", which is a different and weaker claim.
            const profile = captureProfile(cfg, { snapshotRef: job.snapshotRef ?? null });
            // An EDIT job ran in a throwaway fresh session that is deliberately never stored, so
            // there is no session this question belongs to — null, never the chat session, which
            // resuming would drop the answer into the wrong conversation at the wrong permissions.
            const sessionId = caps === "edit" ? null : (session?.get() ?? null);
            const taskId = `job-${id}`;
            fileAsk(cfg, asked.ask, taskId)
              .then((itemId) => {
                if (itemId) {
                  pending?.remember(itemId, profile, { taskId, question: asked.ask, sessionId });
                }
              })
              .catch(() => {});
          }
        } else {
          job.status = "error";
          job.error = job.error || `agent exited with code ${code}`;
          // A non-zero exit with no `result` event means the agent died before it could report.
          // stderr is the only account of it that exists, so classify from there.
          if (!job.errorCode) {
            if (stderrTail.trim() && !job.errorDetail) job.errorDetail = stderrTail.trim();
            job.errorCode = classifyFailure(job.errorDetail || stderrTail);
          }
        }
        job.finishedAt = Date.now();
        persist(job);
        recordHistory(job);
        log.debug("job_end", `id=${id} status=${job.status} steps=${job.steps} caps=${job.caps} edits=${job.edits}`);
        // File what this job DID, under the same task_id the question used, so the answer to "what
        // did Bob build?" sits beside "what did Bob ask?" and neither needs this machine to be
        // reachable later. Detached and best-effort: a job that produced good work must never be
        // reported as failed because Riffn was unavailable.
        //
        // ⚠ A FAILED job files too, and its summary comes from the closed failure-code vocabulary
        // rather than the agent's words. That is the 31 Aug lesson applied in the other direction:
        // the agent's own text stays on this machine, and what crosses is this bridge's diagnosis.
        fileJobOutcome(job).catch(() => {});
        // Operator-facing recovery pointer for edit jobs — full ref is fine on the local terminal
        // (different trust boundary than the wire). Printed at every edit-job end, not just verbose.
        if (job.caps === "edit" && job.snapshotRef) {
          // ⚠ ALWAYS print job.error on a failure. This line used to show only the status, so a
          // failed edit job read as "edit job error: 0 file edit(s)" and the operator had to go
          // query /v1/jobs to learn whether the agent had failed to launch, exited non-zero, or
          // timed out. The reason was already recorded — it just never reached the one place
          // anybody was looking (dogfood, 2026-08-31).
          const why = job.status === "error" && job.error ? ` — ${job.error}` : "";
          console.log(`  edit job ${job.status}${why}: ${job.edits} file edit(s). Pre-job snapshot: ${job.snapshotRef}`);
          // The agent's own words, terminal only. This is the line that actually says what broke.
          if (job.errorDetail) console.log(`    agent said: ${job.errorDetail}`);
          // And what to DO about it, for the person sitting at the machine that can fix it.
          const hint = operatorHint(job.errorCode, cfg.agent);
          if (hint) console.log(`    ⚠ ${hint}`);
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
