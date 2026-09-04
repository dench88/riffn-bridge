// The failure classifier — turning an agent's error into something a driver can act on.
//
// The governing rule of this file: a WRONG code is worse than UNKNOWN. A wrong code sends the user
// to fix something that isn't broken, at 70mph, which is worse than telling them nothing. So the
// "must not misclassify" tests below matter more than the "must classify" ones.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyFailure, operatorHint, FAILURE_CODES } from "../src/failure-codes.js";

// ── The one that started it ──────────────────────────────────────────────────────────────────

test("the real dogfood string classifies as signed out", () => {
  // Verbatim from dench-llm-workstation, 31 Aug 2026. This is the regression anchor: it cost four
  // rounds of guessing because every layer above the agent discarded it.
  assert.equal(
    classifyFailure("Failed to authenticate: OAuth session expired and could not be refreshed"),
    FAILURE_CODES.SIGNED_OUT
  );
});

// ── Each code is reachable ───────────────────────────────────────────────────────────────────

const CASES = [
  [FAILURE_CODES.SIGNED_OUT, "Invalid API key · Please run /login"],
  [FAILURE_CODES.SIGNED_OUT, "API Error: 401 Unauthorized"],
  [FAILURE_CODES.SIGNED_OUT, "Not authenticated. Run `claude` to sign in."],
  [FAILURE_CODES.OUT_OF_CREDIT, "Your credit balance is too low to access the API"],
  [FAILURE_CODES.RATE_LIMITED, "API Error: 429 rate_limit_error"],
  [FAILURE_CODES.RATE_LIMITED, "You have reached your usage limit for this period"],
  [FAILURE_CODES.SERVICE_BUSY, "API Error: 529 overloaded_error"],
  [FAILURE_CODES.OFFLINE, "getaddrinfo ENOTFOUND api.anthropic.com"],
  [FAILURE_CODES.OFFLINE, "TypeError: fetch failed"],
  [FAILURE_CODES.LAUNCH_FAILED, "spawn claude ENOENT"],
  [FAILURE_CODES.LAUNCH_FAILED, "/bin/sh: 1: claude: command not found"],
];

for (const [expected, text] of CASES) {
  test(`"${text.slice(0, 46)}" → ${expected}`, () => {
    assert.equal(classifyFailure(text), expected);
  });
}

// ── Precedence: the orderings that were chosen deliberately ──────────────────────────────────

test("a billing failure is never spoken as a rate limit", () => {
  // Both vocabularies contain "quota" and "limit". Getting this backwards would tell the user to
  // wait for something that never clears on its own.
  assert.equal(
    classifyFailure("insufficient quota — check your billing settings"),
    FAILURE_CODES.OUT_OF_CREDIT
  );
});

test("an auth failure mentioning a rate limit still reads as signed out", () => {
  assert.equal(
    classifyFailure("401 Unauthorized (rate limit headers present)"),
    FAILURE_CODES.SIGNED_OUT
  );
});

// ── Must NOT misclassify ─────────────────────────────────────────────────────────────────────

test("an ordinary agent refusal is UNKNOWN, not an auth problem", () => {
  // The word "authenticate" appears, but as the SUBJECT of the work, not the failure. Sending this
  // user to /login would be actively misleading.
  assert.equal(
    classifyFailure("I couldn't find the authenticate() helper you mentioned."),
    FAILURE_CODES.UNKNOWN
  );
});

test("a task about billing code is not an out-of-credit failure", () => {
  assert.equal(
    classifyFailure("The test for the billing module failed on line 12."),
    FAILURE_CODES.UNKNOWN
  );
});

test("a line number that happens to look like a status code is UNKNOWN", () => {
  // Agent output is full of line numbers. A bare three-digit match is close to a coin flip, which
  // is why the status patterns require a status word nearby.
  assert.equal(classifyFailure("Assertion failed at parser.js:401"), FAILURE_CODES.UNKNOWN);
  assert.equal(classifyFailure("The billing test failed on line 402."), FAILURE_CODES.UNKNOWN);
  assert.equal(classifyFailure("Refactored 429 call sites."), FAILURE_CODES.UNKNOWN);
});

test("a genuine status line still classifies", () => {
  assert.equal(classifyFailure("HTTP 429"), FAILURE_CODES.RATE_LIMITED);
  assert.equal(classifyFailure("status: 529"), FAILURE_CODES.SERVICE_BUSY);
});

test("empty, blank and non-string input is UNKNOWN and never throws", () => {
  for (const bad of ["", "   ", null, undefined, 42, {}, []]) {
    assert.equal(classifyFailure(bad), FAILURE_CODES.UNKNOWN);
  }
});

// ── The operator hint ────────────────────────────────────────────────────────────────────────

test("the signed-out hint names the actual agent binary", () => {
  assert.match(operatorHint(FAILURE_CODES.SIGNED_OUT, "claude"), /claude/);
  assert.match(operatorHint(FAILURE_CODES.SIGNED_OUT, "codex"), /codex/);
});

test("out of credit does not tell the user to wait", () => {
  // RATE_LIMITED says "try again shortly"; OUT_OF_CREDIT must not, because it never clears.
  assert.doesNotMatch(operatorHint(FAILURE_CODES.OUT_OF_CREDIT), /shortly|try again/i);
});

test("UNKNOWN has no hint rather than a vague one", () => {
  assert.equal(operatorHint(FAILURE_CODES.UNKNOWN), null);
  assert.equal(operatorHint(FAILURE_CODES.AGENT_REFUSED), null);
});

test("every code is a distinct string", () => {
  const values = Object.values(FAILURE_CODES);
  assert.equal(new Set(values).size, values.length);
});
