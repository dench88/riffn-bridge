// RIFFN_ASK — the agent's way of saying "I need the human" (agent_inbox_plan.md §10).
//
// Phase 0 risk spike (deliverable 13). Pure and UNWIRED: nothing in server.js imports this yet.
// Wiring it is Phase 4A. It lives here rather than in test/ because it is the real parser the
// production path will use, and the spike's whole point is to prove that parser is sound.
//
// §10 settled the shape and, more importantly, what NOT to build: no output-judging fallback, no
// second-model judge, no question-mark heuristic. Those add false interruptions, cost and privacy
// exposure while still missing intent. So detection is EXACT or it does not happen — an agent that
// does not emit the marker simply never files an item, and that is the accepted trade.

// Versioned and line-start anchored. The version is in the marker itself so a future format change
// is detectable rather than silently mis-parsed by an old bridge.
const MARKER = /^RIFFN_ASK\/1:[ \t]*(.*)$/;

// Matches `summary`'s byte cap in phase0_schemas.md §2.3 — roughly one spoken breath. A marker over
// the limit is REFUSED, never truncated: a half-sentence question is worse than no question, and
// silent truncation is the failure class recorded against Paseo in competitors.md §9.
export const MAX_ASK_BYTES = 600;

// Contents are untrusted ALWAYS (§10). These patterns do not try to be a secret scanner — they are a
// coarse "this looks like it leaked something" tripwire. On a hit we file a GENERIC item and keep the
// detail on the machine, which is the §10 rule and also the privacy boundary in §3: no repository
// content, no filesystem paths, no tool output ever reaches the worker.
const LOOKS_SENSITIVE = [
  /\b[A-Za-z]:\\/,                    // Windows absolute path
  /(^|\s)\/(home|Users|etc|var|root)\//,  // POSIX absolute path in a meaningful root
  /\b(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{8,}/,  // common key prefixes
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,  // bare email
  /\bBearer\s+[A-Za-z0-9._-]{12,}/i,
];

export const GENERIC_ASK = "Agent needs you — check the machine.";

/** Stand-in when a finished job's own words cannot safely cross. */
export const GENERIC_COMPLETION = "Task finished — check the machine.";

/**
 * Is this payload fit to put on the wire?
 *
 * ⚠ Extracted from parseAsk so the completion path CANNOT drift into a second policy. Two
 * independent "is this safe to send" checks is how one of them ends up weaker than the other, and
 * the weaker one is the one that leaks. Same patterns, same bound, one place.
 *
 * @returns {{safe: true}|{safe: false, reason: string}}
 */
export function screenForWire(payload) {
  // The agent emitted a marker but said nothing. Something is wrong on its side.
  if (payload === "") return { safe: false, reason: "empty_payload" };
  // Single line by construction for an ask, but an escaped newline would still render as two lines
  // on the phone. Refuse rather than reflow.
  if (/[\r\n]/.test(payload)) return { safe: false, reason: "multiline_payload" };
  if (Buffer.byteLength(payload, "utf8") > MAX_ASK_BYTES) return { safe: false, reason: "too_long" };
  for (const pattern of LOOKS_SENSITIVE) {
    if (pattern.test(payload)) return { safe: false, reason: "looks_sensitive" };
  }
  return { safe: true };
}

/**
 * Turn a finished job's result into a bounded one-line summary safe to file as a `completed` item.
 *
 * ⚠ Deliberately unlike an ask, in one respect. An over-long ASK is REFUSED, because half a question
 * is worse than no question. An over-long RESULT is TRUNCATED, because half a summary still tells
 * you what happened — and it is cut at a sentence boundary with an ellipsis, so the truncation is
 * visible rather than silent. Everything else is identical: same sensitivity screen, same bound, and
 * a trip means the generic line with the detail staying on the machine.
 *
 * @returns {{summary: string, redacted: boolean, reason?: string}}
 */
export function summariseForWire(result) {
  if (typeof result !== "string" || result.trim() === "") {
    return { summary: GENERIC_COMPLETION, redacted: true, reason: "empty_result" };
  }
  // One line: a card shows a line, and the multiline refusal above would otherwise reject every
  // real job result, which are prose.
  const flat = result.replace(/\s+/g, " ").trim();

  let candidate = flat;
  if (Buffer.byteLength(flat, "utf8") > MAX_ASK_BYTES) {
    // Cut well inside the byte budget, then back up to the last sentence end so the summary stops
    // somewhere a human would. Slicing by characters under a byte budget is safe in this direction:
    // a shorter character count can never exceed the byte count it came from.
    const room = Math.min(flat.length, MAX_ASK_BYTES - 8);
    const cut = flat.slice(0, room);
    const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    candidate = (lastStop > room * 0.4 ? cut.slice(0, lastStop + 1) : cut.trimEnd()) + "…";
  }

  const screened = screenForWire(candidate);
  if (!screened.safe) {
    return { summary: GENERIC_COMPLETION, redacted: true, reason: screened.reason };
  }
  return { summary: candidate, redacted: candidate !== flat, ...(candidate !== flat ? { reason: "truncated" } : {}) };
}

/**
 * Parse the FINAL assistant result only (§10). Passing the whole transcript is a bug: an agent that
 * quoted the marker mid-reasoning would file a phantom item, and the marker is meant to be a
 * deliberate act at the end of a turn.
 *
 * Returns:
 *   { found: false }                                     — no marker, ordinary turn
 *   { found: true, ask, spoken, redacted, reason? }      — file an item with `ask`, speak `spoken`
 *
 * `spoken` is the result with every marker line REMOVED (§10: "strip it from ordinary spoken
 * output"). The user hears the agent's actual words, never the protocol.
 */
export function parseAsk(finalResult) {
  if (typeof finalResult !== "string" || finalResult === "") return { found: false };

  const lines = finalResult.split(/\r?\n/);
  const kept = [];
  let payload = null;

  for (const line of lines) {
    const m = MARKER.exec(line);
    // Only the FIRST marker counts. A turn asking two questions is a protocol violation, and taking
    // the last would let trailing text silently override the first — the opposite of fail-closed.
    if (m && payload === null) payload = m[1].trim();
    else if (!m) kept.push(line);
    // A second+ marker line is dropped from `spoken` too: it is protocol, not speech.
  }

  if (payload === null) return { found: false };

  const spoken = kept.join("\n").trim();

  // ⚠ An unsafe ask is REFUSED, not trimmed: the generic item goes up and the detail stays on the
  // machine. The agent clearly wants the human, so the signal is kept even when its words cannot be.
  const screened = screenForWire(payload);
  if (!screened.safe) {
    return { found: true, ask: GENERIC_ASK, spoken, redacted: true, reason: screened.reason };
  }

  return { found: true, ask: payload, spoken, redacted: false };
}

// §10: "Record marker adherence per adapter, so best-effort is measured rather than assumed."
// Counts only — never payloads, per the §3 boundary. A `custom` agent that never emits the marker
// shows up here as asks:0 across many turns, which is the honest way to discover that an adapter
// does not support the feature rather than assuming it does.
export function createAdherenceCounter() {
  const byAdapter = new Map();
  return {
    record(adapter, result) {
      const row = byAdapter.get(adapter) ?? { turns: 0, asks: 0, redacted: 0 };
      row.turns += 1;
      if (result.found) row.asks += 1;
      if (result.redacted) row.redacted += 1;
      byAdapter.set(adapter, row);
    },
    snapshot: () => Object.fromEntries(byAdapter),
  };
}
