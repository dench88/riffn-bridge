// Phase 4A, reply side — the dispatcher.
//
// inbox-spike.test.js proves the routing TABLE in isolation; inbox-wiring.test.js proves the filing
// half. This file proves the half that can actually do damage: taking an answer off the worker and
// putting it back into an agent.
//
// What it holds:
//   1. ⚠ `limited` NEVER resumes, and today never writes at all — it fails closed for want of a
//      confirmation the bridge cannot obtain.
//   2. The ack happens strictly AFTER dispatch, never before.
//   3. An interrupted dispatch is never replayed.
//   4. A refusal is terminal, reasoned, and hands the answer back.
//   5. A cancellation never reaches the model.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createReplyDispatcher } from "../src/inbox-dispatch.js";
import { createPendingStore } from "../src/inbox-pending.js";
import { captureProfile } from "../src/inbox-routing.js";

// ── harness ──────────────────────────────────────────────────────────────────────────────────

function makeCfg(agent, editMode, envDir) {
  return {
    mode: "cli",
    agent,
    editMode,
    allowEditJobs: editMode !== "disabled",
    customAgentBin: agent === "custom" ? "/usr/bin/analyst" : undefined,
    envDir,
    cwd: "/repo",
    inboxToken: "rif_test",
    inboxURL: "https://riffn.test",
  };
}

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "riffn-dispatch-"));
}

/** Records every jobs.start() call so a test can assert what would have been spawned. */
function fakeJobs({ start } = {}) {
  const calls = [];
  return {
    calls,
    isRunning: () => false,
    start: (prompt, systemPrompt, caps) => {
      calls.push({ prompt, systemPrompt, caps });
      if (start) return start(prompt, systemPrompt, caps);
      return { id: "job-1", status: "running" };
    },
  };
}

/**
 * Stand in for the worker. `replies` is drained on the first lease so a poll terminates; every
 * request is recorded so ordering can be asserted.
 */
function fakeWorker({ replies = [], cancellations = [] } = {}) {
  const requests = [];
  let repliesLeft = replies;
  let cancellationsLeft = cancellations;
  const fetchImpl = async (url, init) => {
    const path = String(url).replace("https://riffn.test", "");
    const body = init?.body ? JSON.parse(init.body) : {};
    requests.push({ path, body });
    if (path === "/v1/agent/replies/lease") {
      const out = repliesLeft; repliesLeft = [];
      return new Response(JSON.stringify({ leased: out }), { status: 200 });
    }
    if (path === "/v1/agent/cancellations/lease") {
      const out = cancellationsLeft; cancellationsLeft = [];
      return new Response(JSON.stringify({ leased: out }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  return {
    requests,
    fetchImpl,
    /** Just the acks, in order, as {replyId, outcome, reason}. */
    acks: () => requests.filter(r => r.path === "/v1/agent/replies/ack")
      .map(r => ({ replyId: r.body.reply_id, outcome: r.body.outcome ?? "delivered", reason: r.body.reason ?? null })),
  };
}

const REPLY = {
  reply_id: "rep_1", item_id: "itm_1", task_id: "job-7",
  text: "Yes, delete it.", lease_until: "2026-09-01T12:00:00.000Z",
};

/** Set up a machine that already asked a question under `editMode`, and is now being answered. */
function scenario(t, { agent = "claude", editMode = "disabled", jobs = fakeJobs(), worker } = {}) {
  const envDir = tempDir();
  t.after(() => rmSync(envDir, { recursive: true, force: true }));
  const cfg = makeCfg(agent, editMode, envDir);
  const pending = createPendingStore(cfg);
  pending.load();
  pending.remember("itm_1", captureProfile(cfg), {
    taskId: "job-7", question: "Should I delete the backfill script?", sessionId: "sess-abc",
  });
  const w = worker ?? fakeWorker({ replies: [REPLY] });
  t.mock.method(globalThis, "fetch", w.fetchImpl);
  const dispatcher = createReplyDispatcher(cfg, { pending, jobs });
  dispatcher.start();
  return { cfg, pending, jobs, worker: w, dispatcher, envDir };
}

// ── 1. THE RULE: limited never resumes, and today never writes ───────────────────────────────

test("limited: the reply is refused for want of a confirmation, and NOTHING is spawned", async (t) => {
  const s = scenario(t, { editMode: "limited" });
  await s.dispatcher.tick();

  assert.deepEqual(s.jobs.calls, [], "a limited reply must not reach the agent unconfirmed");
  assert.deepEqual(s.worker.acks(), [
    { replyId: "rep_1", outcome: "refused", reason: "needs_confirmation" },
  ]);
});

test("limited: the pending context SURVIVES the refusal, so the user can answer again", async (t) => {
  const s = scenario(t, { editMode: "limited" });
  await s.dispatcher.tick();
  // Forgetting here would turn the retry into `unknown_item` — a worse and less honest message.
  assert.ok(s.pending.get("itm_1"), "the question is still open");
});

test("limited: the session id is never even STORED, so resuming is unavailable", (t) => {
  const envDir = tempDir();
  t.after(() => rmSync(envDir, { recursive: true, force: true }));
  const cfg = makeCfg("claude", "limited", envDir);
  const pending = createPendingStore(cfg);
  pending.load();
  pending.remember("itm_9", captureProfile(cfg), {
    taskId: "job-9", question: "?", sessionId: "sess-secret",
  });
  assert.equal(pending.get("itm_9").sessionId, null,
    "phase0_delivery_and_context §8: for limited it is null, always");
});

// ── 2. The rows that DO dispatch ─────────────────────────────────────────────────────────────

test("disabled: dispatches a read job, which resumes the session read-only", async (t) => {
  const s = scenario(t, { editMode: "disabled" });
  await s.dispatcher.tick();

  assert.equal(s.jobs.calls.length, 1);
  assert.equal(s.jobs.calls[0].caps, undefined, "undefined is jobs.start's spelling for a read job");
  assert.deepEqual(s.worker.acks(), [{ replyId: "rep_1", outcome: "delivered", reason: null }]);
});

test("ungated: dispatches write-capable, resuming a session that was BORN ungated", async (t) => {
  const s = scenario(t, { editMode: "ungated" });
  await s.dispatcher.tick();

  assert.equal(s.jobs.calls[0].caps, "ungated");
  assert.deepEqual(s.worker.acks(), [{ replyId: "rep_1", outcome: "delivered", reason: null }]);
});

test("the prompt restates the question, so a fresh session is not answering a non-sequitur", async (t) => {
  const s = scenario(t, { editMode: "disabled" });
  await s.dispatcher.tick();

  const { prompt } = s.jobs.calls[0];
  assert.match(prompt, /Should I delete the backfill script\?/);
  assert.match(prompt, /Yes, delete it\./);
});

// ── 3. Refusals are terminal, reasoned, and never silent ─────────────────────────────────────

test("codex is refused by policy rather than degraded to read-only", async (t) => {
  const s = scenario(t, { agent: "codex" });
  await s.dispatcher.tick();

  assert.deepEqual(s.jobs.calls, []);
  assert.deepEqual(s.worker.acks(), [
    { replyId: "rep_1", outcome: "refused", reason: "disabled_by_policy" },
  ]);
});

test("a profile that changed since filing is refused, never silently re-routed", async (t) => {
  const s = scenario(t, { editMode: "disabled" });
  // The operator armed ungated between the question and the answer. Running the answer under the
  // NEW permissions is exactly the authority-raising the invariant forbids.
  s.cfg.editMode = "ungated";
  s.cfg.allowEditJobs = true;
  await s.dispatcher.tick();

  assert.deepEqual(s.jobs.calls, []);
  assert.deepEqual(s.worker.acks(), [
    { replyId: "rep_1", outcome: "refused", reason: "profile_mismatch" },
  ]);
});

test("an item with no local record is refused as unknown, never reconstructed from the summary", async (t) => {
  const s = scenario(t, { editMode: "disabled" });
  s.pending.forget("itm_1");
  await s.dispatcher.tick();

  assert.deepEqual(s.jobs.calls, []);
  assert.deepEqual(s.worker.acks(), [
    { replyId: "rep_1", outcome: "refused", reason: "unknown_item" },
  ]);
});

// ── 4. The ack contract ──────────────────────────────────────────────────────────────────────

test("the ack lands strictly AFTER the agent has taken the reply", async (t) => {
  const order = [];
  const jobs = fakeJobs({ start: () => { order.push("dispatch"); return { id: "job-1" }; } });
  const s = scenario(t, { editMode: "disabled", jobs });
  await s.dispatcher.tick();
  for (const r of s.worker.requests) {
    if (r.path === "/v1/agent/replies/ack") order.push("ack");
  }
  // Acking first is the failure the lease exists to prevent: the reply is gone and the user's
  // spoken answer never ran.
  assert.deepEqual(order, ["dispatch", "ack"]);
});

test("a dispatch that never started is NOT acked, so the lease can lapse and retry", async (t) => {
  const jobs = fakeJobs({ start: () => { throw new Error("couldn't snapshot the repo"); } });
  const s = scenario(t, { editMode: "ungated", jobs });
  await s.dispatcher.tick();

  assert.deepEqual(s.worker.acks(), [], "nothing ran, so nothing may be marked delivered");
});

test("the single-flight beating us to the agent is not an ack either", async (t) => {
  const jobs = fakeJobs({ start: () => null });   // jobs.start returns null when one is running
  const s = scenario(t, { editMode: "disabled", jobs });
  await s.dispatcher.tick();

  assert.deepEqual(s.worker.acks(), []);
});

test("only ONE reply is leased per poll, so a burst cannot lapse its own attempts", async (t) => {
  const s = scenario(t, { editMode: "disabled" });
  await s.dispatcher.tick();

  const lease = s.worker.requests.find(r => r.path === "/v1/agent/replies/lease");
  // Leasing ten when only one can run leaves nine sitting behind the single-flight, burning one
  // delivery attempt each; five lapses dead-letters a reply that was never actually undeliverable.
  assert.equal(lease.body.max, 1);
});

test("the dispatch takes and releases the single-flight around the agent", async (t) => {
  const marks = [];
  const envDir = tempDir();
  t.after(() => rmSync(envDir, { recursive: true, force: true }));
  const cfg = makeCfg("claude", "disabled", envDir);
  const pending = createPendingStore(cfg);
  pending.load();
  pending.remember("itm_1", captureProfile(cfg), { taskId: "job-7", question: "?", sessionId: "s" });
  const jobs = fakeJobs({ start: () => { marks.push("agent"); return { id: "job-1" }; } });
  const worker = fakeWorker({ replies: [REPLY] });
  t.mock.method(globalThis, "fetch", worker.fetchImpl);
  const dispatcher = createReplyDispatcher(cfg, {
    pending, jobs,
    beginFlight: () => marks.push("begin"),
    endFlight: () => marks.push("end"),
  });
  dispatcher.start();
  await dispatcher.tick();

  // A custom agent has no job engine to mark it busy, so this lock is the only thing stopping a
  // chat request from spawning a second agent against the same working directory mid-dispatch.
  assert.deepEqual(marks, ["begin", "agent", "end"]);
});

test("a dispatch is not attempted at all while chat or a job holds the agent", async (t) => {
  const envDir = tempDir();
  t.after(() => rmSync(envDir, { recursive: true, force: true }));
  const cfg = makeCfg("claude", "disabled", envDir);
  const pending = createPendingStore(cfg);
  pending.load();
  const jobs = fakeJobs();
  const worker = fakeWorker({ replies: [REPLY] });
  t.mock.method(globalThis, "fetch", worker.fetchImpl);
  const dispatcher = createReplyDispatcher(cfg, { pending, jobs, isBusy: () => true });
  dispatcher.start();
  await dispatcher.tick();

  assert.deepEqual(worker.requests, [], "not even a lease — a leased reply we cannot run is a wasted attempt");
});

// ── 5. ⚠ Restart: an interrupted dispatch is NEVER replayed ──────────────────────────────────

test("a reply interrupted mid-dispatch is stranded on reboot, not re-run", async (t) => {
  const envDir = tempDir();
  t.after(() => rmSync(envDir, { recursive: true, force: true }));
  const cfg = makeCfg("claude", "ungated", envDir);
  const pending = createPendingStore(cfg);
  pending.load();
  pending.remember("itm_1", captureProfile(cfg), {
    taskId: "job-7", question: "Should I delete it?", sessionId: "sess-abc",
  });

  // First life: the agent takes the reply and the process is SIGKILLed before the ack — so the
  // journal is left saying `dispatching` with no further information. That is the whole scenario:
  // an ordinary throw would have cleared it (nothing started, safe to retry), and it is precisely
  // the cases we CANNOT distinguish that must not be replayed.
  writeFileSync(path.join(envDir, ".riffn-bridge-dispatch.json"), JSON.stringify({
    inflight: { replyId: "rep_1", itemId: "itm_1", taskId: "job-7", action: "resume",
                agent: "claude", editMode: "ungated", startedAt: Date.now(), state: "dispatching" },
    stranded: [],
  }));

  // Second life: the same reply comes back because its lease lapsed.
  const jobs2 = fakeJobs();
  const worker2 = fakeWorker({ replies: [REPLY] });
  t.mock.method(globalThis, "fetch", worker2.fetchImpl);
  const second = createReplyDispatcher(cfg, { pending, jobs: jobs2 });
  second.start();
  await second.tick();

  assert.equal(second.stranded().length, 1, "the interrupted dispatch is surfaced");
  assert.deepEqual(jobs2.calls, [], "⚠ a stable reply id does not make a CLI idempotent");
  assert.deepEqual(worker2.acks(), [], "not acked either — the worker's counter tells the user");
});

// ── 6. Cancellations never reach the model ───────────────────────────────────────────────────

test("a cancellation clears the local context and is acked, and is never prompted into the agent", async (t) => {
  const worker = fakeWorker({
    replies: [],
    cancellations: [{ cancellation_id: "can_1", item_id: "itm_1", task_id: "job-7", reason: "user_cleared" }],
  });
  const s = scenario(t, { editMode: "ungated", worker });
  await s.dispatcher.tick();

  assert.deepEqual(s.jobs.calls, [], "a cancellation must never arrive as if a human had said it");
  assert.equal(s.pending.get("itm_1"), null, "the context is dropped, so a later reply is unknown_item");
  assert.ok(s.worker.requests.some(r => r.path === "/v1/agent/cancellations/ack"));
});

test("clearing an item makes a reply that arrives afterwards refuse rather than run", async (t) => {
  const worker = fakeWorker({
    replies: [REPLY],
    cancellations: [{ cancellation_id: "can_1", item_id: "itm_1", task_id: "job-7", reason: "user_cleared" }],
  });
  const s = scenario(t, { editMode: "ungated", worker });
  await s.dispatcher.tick();

  // Cancellations are drained first for exactly this reason.
  assert.deepEqual(s.jobs.calls, []);
  assert.deepEqual(s.worker.acks(), [
    { replyId: "rep_1", outcome: "refused", reason: "unknown_item" },
  ]);
});

// ── 7. The inbox being off is a normal state, not an error ───────────────────────────────────

test("a bridge with no worker token polls nothing and stays silent", async (t) => {
  const envDir = tempDir();
  t.after(() => rmSync(envDir, { recursive: true, force: true }));
  const cfg = { ...makeCfg("claude", "disabled", envDir), inboxToken: "" };
  const pending = createPendingStore(cfg);
  pending.load();
  const worker = fakeWorker({ replies: [REPLY] });
  t.mock.method(globalThis, "fetch", worker.fetchImpl);
  const dispatcher = createReplyDispatcher(cfg, { pending, jobs: fakeJobs() });
  dispatcher.start();
  await dispatcher.tick();

  assert.deepEqual(worker.requests, []);
});
