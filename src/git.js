// Pre-job repo snapshot (execute_jobs_plan.md invariant 3): before ANY edit-capable job, the
// HELPER (never the agent — same trust split as notes.js) captures the full working-tree state,
// INCLUDING uncommitted and untracked files, as a commit object reachable from
// refs/riffn/snapshot-<jobid8>. Nothing visible moves: HEAD, the branch, the index, and the
// working tree are all untouched — the ref is pure insurance, recoverable at the desk with
// ordinary git (`git diff <ref>`, `git restore --source <ref> -- .`).
//
// Mechanism: a TEMPORARY index file (GIT_INDEX_FILE) seeded from HEAD, `git add -A` into it,
// write-tree → commit-tree → update-ref. `git stash create` was the plan's first idea but it
// skips untracked files; the temp-index route covers them while keeping the same "no side
// effects" property. Failure here REFUSES the job (caller's responsibility) — a write-enabled
// run without its undo point is exactly what the plan forbids.
//
// All git invocations use argument arrays via spawnSync — never a shell string. spawnSync is
// deliberate: snapshots run once per job dispatch on an operator-owned single-user helper, and a
// synchronous call keeps jobs.start() atomic (no half-started job racing its own snapshot).

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Run one git command in `cwd`. Returns trimmed stdout; throws with a short, non-sensitive
// message on failure (stderr may contain paths — that's fine for a local error, and the caller
// logs it at error level only).
function git(cwd, args, env) {
  const r = spawnSync("git", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
  if (r.error) throw new Error(`git not available (${r.error.code || r.error.message})`);
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || "").trim() || `exit ${r.status}`}`);
  return (r.stdout || "").trim();
}

// Capture the repo state under refs/riffn/<prefix>-<shortId>. Returns { ref, commit }.
// Throws if cwd is not a git work tree or any step fails — callers must treat that as
// "refuse the edit job", never "run without the snapshot". `prefix` separates the per-task
// namespace ("snapshot", edit jobs — deliberate undo points, never auto-pruned) from the ring
// namespace ("ring", ungated turns — see snapshotRepoRing).
export function snapshotRepo(cwd, jobId, prefix = "snapshot") {
  const shortId = String(jobId).replace(/[^a-zA-Z0-9]/g, "").slice(0, 16) || "job";
  const ref = `refs/riffn/${prefix}-${shortId}`;

  if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    throw new Error("not a git work tree");
  }

  // HEAD may not exist yet (fresh repo, no commits) — snapshot still works, just parentless.
  let head = null;
  try { head = git(cwd, ["rev-parse", "--verify", "HEAD"]); } catch { /* unborn branch */ }

  // Temp index in the OS tmpdir (NOT inside the repo — `add -A` must never see its own index).
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "riffn-snap-"));
  const tmpIndex = path.join(tmpDir, "index");
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    if (head) git(cwd, ["read-tree", "HEAD"], env);
    else git(cwd, ["read-tree", "--empty"], env);
    // Everything the operator could lose: modified tracked files AND untracked (gitignore still
    // honored — ignored build artifacts are not the operator's work product).
    git(cwd, ["add", "-A"], env);
    const tree = git(cwd, ["write-tree"], env);
    const msgArgs = ["commit-tree", tree, "-m", `riffn-bridge snapshot before edit job ${shortId}`];
    if (head) msgArgs.splice(2, 0, "-p", head);
    const commit = git(cwd, msgArgs, env);
    git(cwd, ["update-ref", ref, commit]);
    return { ref, commit };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Snapshot ring bound (edit_mode_plan.md, review finding #6): ungated mode snapshots EVERY
// write-capable turn, and a chatty commute would otherwise accumulate refs without limit. ~20
// keeps hours of recent undo points while staying prunable in one pass.
export const SNAPSHOT_RING_SIZE = 20;

// Ring snapshots get a FIXED-WIDTH, time-ordered name (base36 ms + per-process sequence), so
// "newest first" is a plain refname sort — committer timestamps only have 1-second resolution,
// which made date-sorted pruning nondeterministic for turns landing in the same second.
let ringSeq = 0;
function ringStamp() {
  const ms = Date.now().toString(36).padStart(9, "0");
  const seq = (ringSeq++ % 100).toString().padStart(2, "0");
  return ms + seq;
}

// Snapshot + prune, refs/riffn/ring-* only: capture this turn's ref, then delete the oldest
// beyond `keep`. The per-task "snapshot-" namespace (limited-tier edit jobs — deliberate undo
// points) is never touched by the ring's pruning. Prune failures are swallowed — an unpruned
// ring is clutter, but failing the TURN over cleanup would invert the fail-closed rule (only the
// snapshot itself is load-bearing; the caller still refuses the turn's write capability if THAT
// throws).
export function snapshotRepoRing(cwd, keep = SNAPSHOT_RING_SIZE) {
  const snap = snapshotRepo(cwd, ringStamp(), "ring");
  try {
    const out = git(cwd, [
      "for-each-ref", "--sort=-refname", "--format=%(refname)", "refs/riffn/ring-*",
    ]);
    const refs = out ? out.split("\n").filter(Boolean) : [];
    for (const stale of refs.slice(keep)) {
      git(cwd, ["update-ref", "-d", stale]);
    }
  } catch { /* prune is best-effort — see above */ }
  return snap;
}
