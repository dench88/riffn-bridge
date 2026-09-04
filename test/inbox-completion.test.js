// Filing what a job DID, not just what it asked.
//
// Without a `completed` item, "what did Bob build this morning?" needs that specific machine
// reachable and selected, and "what did my agents do today?" is unanswerable at any price. Filing a
// bounded summary under the SAME task_id as the question puts the outcome beside the question, on
// the worker, where the phone can reach both with every machine asleep.
//
// What this holds:
//   1. The summary is bounded and screened by the SAME policy as an ask — one leak check, not two.
//   2. A failed job's summary comes from the failure-code vocabulary, never the agent's own words.
//   3. The task state is reported BEFORE the item, or the worker refuses it.
//   4. Filing stays best-effort: nothing here can turn a finished job into a failed one.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  summariseForWire, screenForWire, GENERIC_COMPLETION, MAX_ASK_BYTES,
} from "../src/ask-marker.js";
import { fileCompleted } from "../src/inbox.js";

const cfg = { inboxToken: "rif_x", inboxURL: "https://riffn.test", cwd: "C:\\dev\\GitHub\\riffn" };

// ── 1. The summary is screened by the same policy as an ask ──────────────────────────────────

test("an ordinary result passes through as the summary", () => {
  const out = summariseForWire("Renamed the handler and updated the tests.");
  assert.equal(out.summary, "Renamed the handler and updated the tests.");
  assert.equal(out.redacted, false);
});

test("a multi-line result is flattened rather than refused", () => {
  // ⚠ The one place completions differ in SHAPE from asks: a real job result is prose across
  // several lines, and the ask path refuses multiline outright. Refusing here would make every
  // completion generic, which is the same as not having the feature.
  const out = summariseForWire("Done.\n\n  - renamed the handler\n  - updated the tests\n");
  assert.equal(out.summary, "Done. - renamed the handler - updated the tests");
  assert.equal(out.redacted, false);
});

test("a leaky result never reaches the worker", () => {
  const out = summariseForWire("Wrote the key to C:\\Users\\rselv\\secrets.env and restarted.");
  assert.equal(out.summary, GENERIC_COMPLETION);
  assert.equal(out.redacted, true);
  assert.equal(out.reason, "looks_sensitive");
  assert.ok(!out.summary.includes("rselv"));
});

test("a leak hiding PAST the truncation point is still caught", () => {
  // The screen runs on what actually crosses, after truncation — so a path beyond the cut is
  // removed by the truncation, and one inside it still trips the check. This pins the second case,
  // which is the one a naive "screen the raw text first" order would get right by accident and a
  // "truncate then forget to screen" order would miss entirely.
  const out = summariseForWire("Updated /home/rselv/app/config.ts. " + "x".repeat(900));
  assert.equal(out.summary, GENERIC_COMPLETION);
  assert.equal(out.reason, "looks_sensitive");
});

test("a long result is truncated visibly, not silently", () => {
  const long = "Refactored the auth module. " + "It took a while. ".repeat(80);
  const out = summariseForWire(long);
  assert.ok(Buffer.byteLength(out.summary, "utf8") <= MAX_ASK_BYTES);
  assert.ok(out.summary.endsWith("…"), "the cut must be visible to the reader");
  assert.equal(out.redacted, true);
  assert.equal(out.reason, "truncated");
});

test("an empty or missing result falls back rather than filing nothing", () => {
  for (const bad of ["", "   ", null, undefined]) {
    const out = summariseForWire(bad);
    assert.equal(out.summary, GENERIC_COMPLETION);
    assert.equal(out.reason, "empty_result");
  }
});

test("asks and completions share ONE screen", () => {
  // The regression this guards: a second copy of the leak patterns drifting from the first. If
  // these ever disagree, one of them is weaker, and the weaker one is the one that leaks.
  assert.equal(screenForWire("C:\\Users\\me\\x").safe, false);
  assert.equal(summariseForWire("C:\\Users\\me\\x").summary, GENERIC_COMPLETION);
});

// ── 2 & 3. The wire call: order, shape, and the privacy boundary ─────────────────────────────

test("the task state is reported BEFORE the item is filed", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ path: String(url).replace("https://riffn.test", ""), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ item_id: "itm_9" }), { status: 200 });
  });

  await fileCompleted(cfg, "job-7", "Renamed the handler.");
  // ⚠ Reversed, the worker rejects the item as `task_state_unknown` — a completed item may not
  // exist for a task it has never seen finish.
  assert.deepEqual(calls.map(c => c.path), [
    "/v1/agent/tasks/job-7/state",
    "/v1/agent/items",
  ]);
  assert.equal(calls[0].body.task_state, "COMPLETED");
});

test("the item carries kind=completed under the SAME task id as the question", async (t) => {
  let filed = null;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).endsWith("/v1/agent/items")) filed = body;
    return new Response(JSON.stringify({ item_id: "itm_9" }), { status: 200 });
  });

  await fileCompleted(cfg, "job-7", "Renamed the handler.");
  assert.equal(filed.kind, "completed");
  // The join. A question filed during this job used exactly this task_id.
  assert.equal(filed.task_id, "job-7");
  // §3: the repo BASENAME crosses, never the path.
  assert.equal(filed.location, "riffn");
  assert.ok(!JSON.stringify(filed).includes("GitHub"));
});

test("a failed task reports FAILED, not COMPLETED", async (t) => {
  const states = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.task_state) states.push(body.task_state);
    return new Response(JSON.stringify({ item_id: "itm_9" }), { status: 200 });
  });

  await fileCompleted(cfg, "job-7", "Task stopped — that machine's agent is signed out.", "FAILED");
  assert.deepEqual(states, ["FAILED"]);
});

// ── 4. Best-effort in every direction ────────────────────────────────────────────────────────

test("filing is a no-op when the inbox is switched off", async () => {
  assert.equal(await fileCompleted({ inboxToken: "" }, "job-7", "anything"), null);
});

test("an unreachable Riffn resolves null instead of throwing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("ENOTFOUND"); });
  // The close handler detaches this with a bare .catch(), so a throw would surface as an unhandled
  // rejection — and a job that produced good work would be reported as a failure.
  assert.equal(await fileCompleted(cfg, "job-7", "Renamed the handler."), null);
});

test("a rejected filing resolves null rather than surfacing an error", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ error: { code: "task_state_unknown" } }), { status: 409 })
  );
  assert.equal(await fileCompleted(cfg, "job-7", "Renamed the handler."), null);
});
