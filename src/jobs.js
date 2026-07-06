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
import path from "node:path";
import { log } from "./log.js";

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

    // Start a job. Returns the public view immediately; the run continues in the background.
    // Rejects (returns null) if one is already running — one job per bridge (§11.3 cwd guarantee).
    start(prompt, appendSystemPrompt) {
      if (live) return null;
      const id = randomUUID();
      const existingSession = session?.get();
      const job = {
        id, status: "running", startedAt: Date.now(), finishedAt: null,
        steps: 0, lastActivity: null, result: null, error: null,
        // prompt is intentionally NOT persisted — it may contain sensitive content (§10.10).
      };
      persist(job);

      const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
      if (existingSession) args.push("--resume", existingSession);
      if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);

      log.debug("job_start", `id=${id} cwd=${cfg.cwd} resume=${existingSession || "none"}`);
      const child = spawn(cfg.claudeBin, args, { cwd: cfg.cwd, env: process.env });
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
        if (newSessionId) session?.set(newSessionId);
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
        log.debug("job_end", `id=${id} status=${job.status} steps=${job.steps}`);
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
