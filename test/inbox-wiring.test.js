// Phase 4A — the WIRING, as opposed to the parser the spike already proved.
//
// inbox-spike.test.js proves parseAsk() and the routing table in isolation. This file proves the
// thing that actually broke in review: that the two obligations of a finished turn — strip the
// marker, file the question — stay separated, and that the second one failing cannot damage the
// first.
//
//   dev_resources/NOW/agent_inbox_plan.md §10       the marker
//   dev_resources/NOW/phase0_schemas.md §2, §3      the wire format and the privacy boundary
//   dev_resources/NOW/phase0_turn_contracts.md §3   why the close handler must not await

import { test } from "node:test";
import assert from "node:assert/strict";

import { chatTaskId, fileAsk, stripAsk, inboxEnabled } from "../src/inbox.js";

const ASK = "RIFFN_ASK/1: Should I drop the legacy column?";

// ── stripAsk: synchronous, total, and never leaks the protocol ───────────────────────────────

test("an ordinary turn is passed through untouched and files nothing", () => {
  const out = stripAsk("Renamed the handler and the tests pass.");
  assert.equal(out.spoken, "Renamed the handler and the tests pass.");
  assert.equal(out.ask, null);
});

test("the marker is stripped from what gets spoken", () => {
  const out = stripAsk(`Migration is ready.\n${ASK}`);
  assert.equal(out.spoken, "Migration is ready.");
  assert.equal(out.ask, "Should I drop the legacy column?");
  // ⚠ The regression this file exists for: the caller reads `spoken` with no await, so nothing can
  // observe the raw text. A promise-based strip left a window where a poll got the marker.
  assert.ok(!out.spoken.includes("RIFFN_ASK"));
});

test("a marker-only turn still speaks the question rather than silence", () => {
  const out = stripAsk(ASK);
  assert.equal(out.spoken, "Should I drop the legacy column?");
  assert.equal(out.ask, "Should I drop the legacy column?");
});

test("a leaky payload is redacted before it can cross to the worker", () => {
  const out = stripAsk("Done.\nRIFFN_ASK/1: Overwrite C:\\Users\\rselv\\secrets.env?");
  assert.equal(out.spoken, "Done.");
  assert.equal(out.redacted, true);
  assert.ok(!out.ask.includes("rselv"), "the path must not reach the worker");
});

test("stripAsk tolerates the empty and non-string results a crashed agent can produce", () => {
  for (const bad of ["", null, undefined]) {
    const out = stripAsk(bad);
    assert.equal(out.ask, null);
    assert.equal(out.spoken, bad);
  }
});

// ── fileAsk: best-effort in every direction ──────────────────────────────────────────────────

test("filing is a no-op when the inbox is switched off", async () => {
  const cfg = { inboxToken: "", inboxURL: "https://example.invalid" };
  assert.equal(inboxEnabled(cfg), false);
  assert.equal(await fileAsk(cfg, "anything?", "job-1"), null);
});

test("an unreachable Riffn resolves null instead of throwing", async (t) => {
  const cfg = { inboxToken: "rif_x", inboxURL: "https://example.invalid" };
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("ENOTFOUND");
  });
  // The point is the absence of a rejection: the close handler detaches this with a bare .catch(),
  // so a throw here would surface as an unhandled rejection and take the process down under
  // --unhandled-rejections=throw.
  assert.equal(await fileAsk(cfg, "still there?", "job-1"), null);
});

test("a rejected filing resolves null rather than surfacing an error", async (t) => {
  const cfg = { inboxToken: "rif_revoked", inboxURL: "https://riffn.test" };
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({ error: { code: "AGENT_REVOKED" } }), { status: 403 })
  );
  assert.equal(await fileAsk(cfg, "may I?", "job-1"), null);
});

test("a filed item sends the question, an idempotency key, and no filesystem path", async (t) => {
  const cfg = { inboxToken: "rif_x", inboxURL: "https://riffn.test", cwd: "C:\\dev\\GitHub\\riffn" };
  let seen = null;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    seen = { url: String(url), headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ item_id: "itm_42" }), { status: 200 });
  });

  assert.equal(await fileAsk(cfg, "Drop the column?", "job-7"), "itm_42");
  assert.equal(seen.url, "https://riffn.test/v1/agent/items");
  assert.equal(seen.headers.authorization, "Bearer rif_x");
  assert.ok(seen.headers["idempotency-key"], "a retry must not create a second item");
  assert.equal(seen.body.summary, "Drop the column?");
  assert.equal(seen.body.task_id, "job-7");
  // §3: the repo BASENAME crosses, never the path.
  assert.equal(seen.body.location, "riffn");
  assert.ok(!JSON.stringify(seen.body).includes("GitHub"));
});

// ── chatTaskId: stable grouping without exporting a local identifier ─────────────────────────

test("the same chat session groups, a different one does not", () => {
  assert.equal(chatTaskId("sess-abc"), chatTaskId("sess-abc"));
  assert.notEqual(chatTaskId("sess-abc"), chatTaskId("sess-def"));
});

test("the raw session id never appears in the task id", () => {
  assert.ok(!chatTaskId("sess-abc").includes("sess-abc"));
});

test("no session still yields a usable id", () => {
  assert.match(chatTaskId(null), /^chat-.+/);
  assert.notEqual(chatTaskId(null), chatTaskId(null), "unlinked turns must not collide as one task");
});
