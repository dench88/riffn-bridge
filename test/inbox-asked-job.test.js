// A job that ASKS is INPUT_REQUIRED, and stays that way until the user is heard.
//
// Found on the first real device test (19 Sep 2026): the close handler filed the question and, in
// the same tick, reported the same task COMPLETED for the completion item. The worker mirrors a
// task state onto the task's open items, so whenever the report landed second the question left
// the inbox the instant it was filed — no push, nothing in Switchboard.
//
// What this holds, driving the REAL job store with a fake agent binary:
//   1. An asked job files the question and reports NO terminal state at close.
//   2. heard() — the app spoke the question inline — waits for the filing, forgets the pending
//      context, and only THEN files the outcome (state report before completed item, same as an
//      un-asked job). Once, however many times it is called.
//   3. An ordinary un-asked job files NOTHING — its task is unknown to the worker, which refused
//      the completion every time (404 unknown_task_id, then 409 task_state_unknown).
//   4. A reply-dispatch job continues the ANSWERED task (inboxTaskId): its completion files under
//      that task, state report first — the "task finished" leg of the loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createJobStore } from "../src/jobs.js";
import { createPendingStore } from "../src/inbox-pending.js";

// A stand-in for `claude -p … --output-format stream-json`: ignores its arguments and prints the
// result the test put in RIFFN_TEST_FAKE_RESULT. Reached through the same npm-shim shape on Windows
// that win-shim.js resolves for the real CLI, and a plain sh wrapper elsewhere.
function makeFakeAgent(dir) {
  const script = path.join(dir, "fake-claude.js");
  writeFileSync(script, [
    "const result = process.env.RIFFN_TEST_FAKE_RESULT || '';",
    "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'result', result }) + '\\n');",
  ].join("\n"));
  if (process.platform === "win32") {
    const shim = path.join(dir, "fake-claude.cmd");
    writeFileSync(shim, `@SETLOCAL\r\n@SET "_prog=node"\r\n@SET "dp0=%~dp0"\r\n"%_prog%"  "%dp0%\\fake-claude.js" %*\r\n`);
    return shim;
  }
  const wrapper = path.join(dir, "fake-claude");
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function makeCfg(dir) {
  return {
    token: "t", host: "127.0.0.1", port: 0, mode: "cli", agent: "claude",
    claudeBin: makeFakeAgent(dir), cwd: dir, envDir: dir,
    timeoutMs: 5000, jobTimeoutMs: 5000, allowEditJobs: false,
    inboxToken: "rif_x", inboxURL: "https://riffn.test",
  };
}

/** Records every worker call in order and answers like the real inbox would. */
function mockWorker(t) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    const p = new URL(url).pathname;
    calls.push({ path: p, body });
    if (p === "/v1/agent/items") {
      return new Response(JSON.stringify({ item_id: `ITEM-${calls.length}` }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
  return calls;
}

async function runToEnd(jobs, prompt, options = {}) {
  const started = jobs.start(prompt, "", "read", options);
  assert.equal(started.status, "running");
  const deadline = Date.now() + 4000;
  while (jobs.current().status === "running" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  // Let the detached filings settle.
  await new Promise((r) => setTimeout(r, 50));
  return jobs.current();
}

function withFixture(fn) {
  return async (t) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "riffn-asked-job-"));
    const cfg = makeCfg(dir);
    const pending = createPendingStore(cfg);
    const jobs = createJobStore(cfg, null, pending);
    const calls = mockWorker(t);
    try {
      await fn({ jobs, pending, calls });
    } finally {
      delete process.env.RIFFN_TEST_FAKE_RESULT;
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const stateReports = (calls) => calls.filter((c) => /\/v1\/agent\/tasks\/.+\/state$/.test(c.path));
const items = (calls, kind) => calls.filter((c) => c.path === "/v1/agent/items" && c.body.kind === kind);

test("a job that asks files the question and reports no terminal state at close", withFixture(async ({ jobs, pending, calls }) => {
  process.env.RIFFN_TEST_FAKE_RESULT = "Looked at the schema.\nRIFFN_ASK/1: Drop the legacy column?";
  const view = await runToEnd(jobs, "check the schema");

  assert.equal(view.status, "done");
  assert.equal(view.asked, true);
  assert.equal(view.result, "Looked at the schema.", "the marker never reaches the spoken result");

  assert.equal(items(calls, "question").length, 1);
  assert.equal(items(calls, "question")[0].body.summary, "Drop the legacy column?");
  // ⚠ The regression: a COMPLETED report here buries the question on the worker.
  assert.equal(stateReports(calls).length, 0, "an asked job must not report a terminal state");
  assert.equal(items(calls, "completed").length, 0);
  assert.equal(pending.size, 1, "the question's context is remembered for a later inbox reply");
}));

test("heard(): retires the question after the filing landed, then files the outcome once", withFixture(async ({ jobs, pending, calls }) => {
  process.env.RIFFN_TEST_FAKE_RESULT = "Looked at the schema.\nRIFFN_ASK/1: Drop the legacy column?";
  await runToEnd(jobs, "check the schema");
  const before = calls.length;

  const view = await jobs.heard();
  assert.equal(view.asked, true);
  assert.equal(pending.size, 0, "a question answered aloud must not be re-run by a late inbox reply");

  const after = calls.slice(before);
  assert.equal(after.length, 2, "one state report and one completed item");
  assert.match(after[0].path, /\/v1\/agent\/tasks\/job-.+\/state$/);
  assert.equal(after[0].body.task_state, "COMPLETED");
  assert.equal(after[1].path, "/v1/agent/items");
  assert.equal(after[1].body.kind, "completed");
  assert.equal(after[1].body.task_id, items(calls, "question")[0].body.task_id, "same task as the question");

  // Idempotent: the app fires this without waiting, so a retry must be harmless.
  await jobs.heard();
  assert.equal(calls.length, before + 2);
}));

test("an ordinary job without an ask files nothing, and heard() is a no-op", withFixture(async ({ jobs, calls }) => {
  process.env.RIFFN_TEST_FAKE_RESULT = "Renamed the handler and the tests pass.";
  const view = await runToEnd(jobs, "rename it");

  assert.equal(view.status, "done");
  assert.equal(view.asked, false);
  // The worker has never heard of job-<id> (a task is born INPUT_REQUIRED), so the state report
  // and the completed item were refused on every spoken turn — two wasted calls, no history row.
  assert.equal(calls.length, 0, "no worker call for a task the worker cannot accept");

  const heard = await jobs.heard();
  assert.equal(heard.asked, false);
  assert.equal(calls.length, 0);
}));

test("a job continuing an answered task files its completion under THAT task, state first", withFixture(async ({ jobs, calls }) => {
  process.env.RIFFN_TEST_FAKE_RESULT = "Dropped the legacy column and updated the migration.";
  const view = await runToEnd(jobs, "the user said: drop it", { inboxTaskId: "job-original" });

  assert.equal(view.status, "done");
  assert.equal(view.asked, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, "/v1/agent/tasks/job-original/state");
  assert.equal(calls[0].body.task_state, "COMPLETED");
  assert.equal(calls[1].path, "/v1/agent/items");
  assert.equal(calls[1].body.kind, "completed");
  assert.equal(calls[1].body.task_id, "job-original", "the completion sits beside the question it answers");
}));

test("a re-ask from a continued task stays on the original task id", withFixture(async ({ jobs, calls, pending }) => {
  process.env.RIFFN_TEST_FAKE_RESULT = "Nearly there.\nRIFFN_ASK/1: Also drop the index?";
  const view = await runToEnd(jobs, "the user said: drop it", { inboxTaskId: "job-original" });

  assert.equal(view.asked, true);
  assert.equal(items(calls, "question").length, 1);
  assert.equal(items(calls, "question")[0].body.task_id, "job-original");
  assert.equal(stateReports(calls).length, 0, "still INPUT_REQUIRED — no terminal report");
  assert.equal(pending.size, 1);
}));

test("heard() with no job at all answers null rather than throwing", withFixture(async ({ jobs }) => {
  assert.equal(await jobs.heard(), null);
}));
