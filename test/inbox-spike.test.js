// Phase 0 deliverable 13 — THE RISK SPIKE.
//
// "A working prototype of one bridge question/reply round trip under each permission mode."
// The rows of phase0_routing_matrix.md §2 are the test cases; §6 of that file lists them.
//
// What this proves:
//   1. An agent can ask (RIFFN_ASK/1:), and the marker never reaches the user's ears.
//   2. Untrusted payloads degrade to a generic item instead of leaking paths/keys to the worker.
//   3. A reply routes back under the FILING-time profile, per mode, with the right confirmations.
//   4. Authority is never raised — limited never resumes, codex is refused, custom is honest.
//   5. Every refusal has something to SAY.
//
// Zero-dep: node's built-in test runner (`npm test`).

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAsk, createAdherenceCounter, GENERIC_ASK, MAX_ASK_BYTES } from "../src/ask-marker.js";
import { captureProfile, profileMatches, routeReply } from "../src/inbox-routing.js";

// Minimal cfg shaped like the real one. agentCapabilities() reads exactly these fields.
const cfg = (agent, editMode) => ({
  mode: "cli",
  agent,
  editMode,
  allowEditJobs: editMode !== "disabled",
  customAgentBin: agent === "custom" ? "/usr/bin/analyst" : undefined,
});

// ── 1. The marker ────────────────────────────────────────────────────────────────────────────

test("marker: a plain turn files nothing", () => {
  assert.equal(parseAsk("I've finished the refactor and all tests pass.").found, false);
});

test("marker: the ask is captured and STRIPPED from what gets spoken", () => {
  const r = parseAsk("I hit a fork in the migration.\nRIFFN_ASK/1: Should I drop the legacy column?");
  assert.equal(r.found, true);
  assert.equal(r.ask, "Should I drop the legacy column?");
  assert.equal(r.redacted, false);
  // §10: strip it from ordinary spoken output. The user hears prose, never protocol.
  assert.equal(r.spoken, "I hit a fork in the migration.");
  assert.ok(!r.spoken.includes("RIFFN_ASK"));
});

test("marker: must be line-start and versioned — a mention mid-sentence is not a marker", () => {
  assert.equal(parseAsk("You could emit RIFFN_ASK/1: like this to ask me.").found, false);
  assert.equal(parseAsk("RIFFN_ASK: no version means no match").found, false);
  assert.equal(parseAsk("RIFFN_ASK/2: a future version this bridge cannot parse").found, false);
});

test("marker: only the FIRST wins, and later ones are still stripped from speech", () => {
  const r = parseAsk("RIFFN_ASK/1: first\nRIFFN_ASK/1: second");
  assert.equal(r.ask, "first");
  assert.equal(r.spoken, "");
});

test("marker: an oversized payload degrades to generic rather than truncating", () => {
  const r = parseAsk(`RIFFN_ASK/1: ${"x".repeat(MAX_ASK_BYTES + 1)}`);
  assert.equal(r.ask, GENERIC_ASK);
  assert.equal(r.reason, "too_long");
});

test("marker: payloads that look sensitive never leave the machine", () => {
  // Each of these would otherwise cross to the worker and through Apple's push infrastructure.
  const leaky = [
    "RIFFN_ASK/1: Should I commit C:\\Users\\rselv\\secrets.env?",
    "RIFFN_ASK/1: Is /home/dench/.ssh/id_rsa the right key?",
    "RIFFN_ASK/1: Use sk-abc123def456ghi789 for the call?",
    "RIFFN_ASK/1: Email the report to dench@example.com?",
  ];
  for (const raw of leaky) {
    const r = parseAsk(raw);
    assert.equal(r.ask, GENERIC_ASK, `should have redacted: ${raw}`);
    assert.equal(r.redacted, true);
  }
});

test("marker: an empty payload still signals — the agent wants a human", () => {
  const r = parseAsk("RIFFN_ASK/1:");
  assert.equal(r.found, true);
  assert.equal(r.ask, GENERIC_ASK);
  assert.equal(r.reason, "empty_payload");
});

test("adherence is counted per adapter, without payloads", () => {
  const c = createAdherenceCounter();
  c.record("claude", parseAsk("RIFFN_ASK/1: ok?"));
  c.record("claude", parseAsk("no marker here"));
  c.record("custom", parseAsk("custom agents often never emit one"));
  const snap = c.snapshot();
  assert.deepEqual(snap.claude, { turns: 2, asks: 1, redacted: 0 });
  // The honest way to discover an adapter does not support the feature.
  assert.deepEqual(snap.custom, { turns: 1, asks: 0, redacted: 0 });
  assert.ok(!JSON.stringify(snap).includes("ok?"));
});

// ── 2. The routing matrix, row by row ────────────────────────────────────────────────────────

test("row: claude/disabled → resume, read-only, no confirmation", () => {
  const c = cfg("claude", "disabled");
  const d = routeReply(captureProfile(c), c);
  assert.equal(d.action, "resume");
  assert.equal(d.requiresVoiceConfirm, false);
});

test("row: claude/limited → FRESH with a spoken confirmation, and never resume", () => {
  const c = cfg("claude", "limited");
  const d = routeReply(captureProfile(c), c);
  // The load-bearing assertion of this whole spike. --resume would inherit the resumed session's
  // unrestricted permission context (jobs.js dogfood finding, 2026-07-12).
  assert.notEqual(d.action, "resume");
  assert.equal(d.action, "fresh");
  assert.equal(d.requiresVoiceConfirm, true);
  assert.ok(d.confirmPrompt.length > 0);
});

test("row: claude/ungated → resume is safe, because sessions are mode-stamped at creation", () => {
  const c = cfg("claude", "ungated");
  const p = captureProfile(c);
  assert.equal(p.chatWrites, true);
  assert.equal(routeReply(p, c).action, "resume");
});

test("row: codex → refused with something to say, not degraded to read-only", () => {
  const c = cfg("codex", "disabled");
  const d = routeReply(captureProfile(c), c);
  assert.equal(d.action, "refuse");
  assert.equal(d.reason, "disabled_by_policy");
  assert.ok(d.spoken.length > 0);
});

test("row: custom → fresh, and capabilities are reported UNKNOWN rather than safe", () => {
  const c = cfg("custom", "disabled");
  const p = captureProfile(c);
  // null, never false. The bridge cannot enforce read-only on an arbitrary CLI, and claiming
  // otherwise would imply a boundary that is not there.
  assert.equal(p.chatWrites, null);
  const d = routeReply(p, c);
  assert.equal(d.action, "fresh");
  assert.equal(d.capsUnknown, true);
});

// ── 3. The invariant: authority may be reduced, never raised ─────────────────────────────────

test("⚠ answering after switching agents is REFUSED, not re-routed", () => {
  // Filed while a read-only Claude was active...
  const filed = captureProfile(cfg("claude", "disabled"));
  // ...answered an hour later, with the machine now on an ungated Claude.
  const now = cfg("claude", "ungated");
  const d = routeReply(filed, now);
  assert.equal(d.action, "refuse");
  assert.equal(d.reason, "profile_mismatch");
  assert.ok(d.spoken.length > 0, "a refusal the user cannot hear is the failure we are avoiding");
});

test("⚠ a reply can never be dispatched into a DIFFERENT agent", () => {
  const filed = captureProfile(cfg("claude", "disabled"));
  assert.equal(routeReply(filed, cfg("custom", "disabled")).reason, "profile_mismatch");
  assert.equal(routeReply(filed, cfg("codex", "disabled")).reason, "profile_mismatch");
});

test("⚠ narrowing permissions is refused too — no guessing in either direction", () => {
  // Not strictly an authority RAISE, but the stored profile no longer describes the machine, and
  // the rule is refuse-and-say-so rather than infer what the user would have wanted.
  const filed = captureProfile(cfg("claude", "ungated"));
  assert.equal(routeReply(filed, cfg("claude", "disabled")).reason, "profile_mismatch");
});

test("profileMatches: identical config matches, so the happy path is reachable", () => {
  const c = cfg("claude", "limited");
  assert.equal(profileMatches(captureProfile(c), c), true);
  assert.equal(profileMatches(null, c), false);
});

// ── 4. The whole round trip, end to end, under each mode ─────────────────────────────────────

test("round trip: ask → file → answer → dispatch, under every permission mode", () => {
  const expected = {
    "claude/disabled": "resume",
    "claude/limited": "fresh",
    "claude/ungated": "resume",
    "custom/disabled": "fresh",
    "codex/disabled": "refuse",
  };

  for (const [key, action] of Object.entries(expected)) {
    const [agent, editMode] = key.split("/");
    const c = cfg(agent, editMode);

    // 1. The agent asks, mid-turn.
    const turn = "Looked at the schema.\nRIFFN_ASK/1: Rename the column or add a new one?";
    const parsed = parseAsk(turn);
    assert.equal(parsed.found, true, `${key}: marker not detected`);
    assert.ok(!parsed.spoken.includes("RIFFN_ASK"), `${key}: protocol leaked into speech`);

    // 2. The item is filed, capturing the profile AT FILING TIME.
    const filed = captureProfile(c, { repoFingerprint: "abc123", snapshotRef: "snap-1" });

    // 3. The user answers later; the reply is routed under the stored profile.
    const decision = routeReply(filed, c);
    assert.equal(decision.action, action, `${key}: expected ${action}, got ${decision.action}`);

    // 4. Whatever happens, there is always either a dispatch or something to say.
    if (decision.action === "refuse") {
      assert.ok(decision.spoken, `${key}: refused silently`);
    } else {
      assert.equal(typeof decision.requiresVoiceConfirm, "boolean");
    }
  }
});
