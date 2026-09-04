// Turning an agent's failure into something a driver can ACT on.
//
// The problem this solves, from a real dogfood session (31 Aug): a repo agent's Claude login had
// expired. The agent said so plainly — "Failed to authenticate: OAuth session expired and could not
// be refreshed" — and every layer above it threw that away. The job path replaced it with "the agent
// reported an error"; the chat path replaced it with "Agent error (Error)". It took four rounds of
// guessing to recover a fact the machine had known instantly, and the fix ("sign in again") is one
// the user could have performed immediately.
//
// ⚠ WHY A CODE AND NOT THE TEXT. Agent error output is agent output: it routinely carries file
// paths, command lines, repo names and occasionally key material. §10.10 keeps it on the machine.
// So the machine classifies LOCALLY into the closed set below, and only the code crosses. A code is
// not agent output — it is this bridge's diagnosis, drawn from a fixed vocabulary the phone already
// knows. That also makes it speakable in the brand voice: a fixed set maps to fixed strings, and
// fixed strings are the only thing a pre-recorded Adam clip can ever be.
//
// Adding a code is a WIRE CHANGE in the tolerant direction: an old phone ignores a field it does not
// know and falls back to its generic line, so a new bridge never breaks an old app.

/**
 * The closed set. Every value here must have a spoken line on the phone
 * (BridgeJobClient.spokenStatus) and, ideally, an Adam clip.
 *
 * Ordered roughly by how actionable they are: the first few tell the user exactly what to do.
 */
export const FAILURE_CODES = Object.freeze({
  /** The agent CLI is not logged in, or its session expired. The user must re-authenticate. */
  SIGNED_OUT: "signed_out",
  /** Usage limit / rate limit. Waiting fixes it; nothing else will. */
  RATE_LIMITED: "rate_limited",
  /** Billing: no credit, quota exhausted, payment needed. Waiting will NOT fix it. */
  OUT_OF_CREDIT: "out_of_credit",
  /** The provider is up but overloaded. Retrying shortly usually works. */
  SERVICE_BUSY: "service_busy",
  /** The agent machine could not reach the network. */
  OFFLINE: "offline",
  /** The agent could not launch at all (binary missing, bad permissions). */
  LAUNCH_FAILED: "launch_failed",
  /** The agent ran, understood the task, and declined or failed on its own terms. */
  AGENT_REFUSED: "agent_refused",
  /** Ran past the time limit and was stopped. */
  TIMED_OUT: "timed_out",
  /** Classified as nothing more specific. The honest fallback — never a guess. */
  UNKNOWN: "unknown",
});

/**
 * An HTTP status code, but only where something nearby marks it AS a status.
 *
 * ⚠ A bare /\b402\b/ matches "the billing test failed on line 402" and a bare /\b401\b/ matches any
 * stack trace that happens to reach that line. Agent output is full of line numbers, so a raw
 * three-digit match is close to a coin flip. Requiring a status word within a few characters is what
 * makes these safe enough to keep as a backstop for providers that print nothing but a number.
 */
const STATUS = (n) => new RegExp(String.raw`\b(?:http|https|status|code|error)\b\W{0,12}${n}\b`, "i");

// Matched in order; FIRST hit wins, so the specific patterns must precede the general ones.
//
// ⚠ These are deliberately COARSE and deliberately incomplete. A wrong-but-confident code is worse
// than UNKNOWN: it sends the user to fix something that isn't broken. Every pattern here was chosen
// because its phrasing is unambiguous about the CAUSE — anything that could plausibly mean two
// different things is left to fall through to UNKNOWN on purpose.
const PATTERNS = [
  // Auth. "expired" and "refresh" are the tell for an OAuth session; the others cover a missing or
  // rejected credential. Ordered first because it is both the most common and the most actionable.
  [FAILURE_CODES.SIGNED_OUT, [
    /\boauth\b[^.]*\bexpired\b/i,
    /\bsession expired\b/i,
    /\bcould not be refreshed\b/i,
    /\bfailed to authenticate\b/i,
    /\bnot authenticated\b/i,
    /\bplease (?:run )?["`']?\/?login\b/i,
    /\bauthentication_error\b/i,
    /\binvalid[_ ]api[_ ]key\b/i,
    /\bunauthorized\b/i,
    STATUS(401),
  ]],
  // Billing before rate limits: "quota" and "limit" appear in both vocabularies, but credit and
  // payment wording is unambiguous, so claiming it first prevents a billing failure being spoken as
  // "wait a while" — advice that would never come true.
  [FAILURE_CODES.OUT_OF_CREDIT, [
    /\bcredit balance\b/i,
    /\binsufficient (?:credit|funds|balance|quota)\b/i,
    // ⚠ NOT a bare /billing/. An agent asked to work on a billing module reports "the billing tests
    // failed", and classifying that as a payment problem would send the user to their card details
    // over a broken unit test. The word only counts when it is the SUBJECT of the failure.
    /\bbilling (?:error|issue|problem)\b/i,
    /\bcheck your billing\b/i,
    /\bpayment (?:required|method)\b/i,
    STATUS(402),
  ]],
  [FAILURE_CODES.RATE_LIMITED, [
    /\brate[_ ]?limit/i,
    /\busage limit\b/i,
    /\btoo many requests\b/i,
    STATUS(429),
  ]],
  [FAILURE_CODES.SERVICE_BUSY, [
    /\boverloaded\b/i,
    /\bservice unavailable\b/i,
    /\btemporarily unavailable\b/i,
    STATUS(529),
    STATUS(503),
  ]],
  [FAILURE_CODES.OFFLINE, [
    /\bENOTFOUND\b/,
    /\bECONNREFUSED\b/,
    /\bECONNRESET\b/,
    /\bEAI_AGAIN\b/,
    /\bfetch failed\b/i,
    /\bnetwork (?:error|is unreachable)\b/i,
    /\bgetaddrinfo\b/i,
  ]],
  [FAILURE_CODES.LAUNCH_FAILED, [
    /\bENOENT\b/,
    /\bEACCES\b/,
    /\bcommand not found\b/i,
    /\bfailed to launch\b/i,
    /\bis not recognized as\b/i,
  ]],
];

/**
 * Classify an agent failure from whatever text the machine has locally.
 *
 * @param {unknown} text  the agent's own error output, an Error message, or stderr — LOCAL ONLY;
 *                        it is read here and never returned or forwarded.
 * @returns {string} one of FAILURE_CODES. Never throws; unrecognised input is UNKNOWN.
 */
export function classifyFailure(text) {
  if (typeof text !== "string" || !text.trim()) return FAILURE_CODES.UNKNOWN;
  for (const [code, patterns] of PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(text)) return code;
    }
  }
  return FAILURE_CODES.UNKNOWN;
}

/**
 * The operator-facing hint printed on the agent machine's own terminal, where the person who can
 * actually fix it is sitting. The phone gets the code; the terminal gets the instruction.
 */
export function operatorHint(code, agent = "claude") {
  switch (code) {
    case FAILURE_CODES.SIGNED_OUT:
      return `the agent is signed out — run \`${agent}\` here and use /login, then retry (no bridge restart needed)`;
    case FAILURE_CODES.OUT_OF_CREDIT:
      return "the agent's account is out of credit — waiting will not clear this";
    case FAILURE_CODES.RATE_LIMITED:
      return "rate limited — this clears on its own, try again shortly";
    case FAILURE_CODES.SERVICE_BUSY:
      return "the provider is overloaded — retry shortly";
    case FAILURE_CODES.OFFLINE:
      return "this machine could not reach the network";
    case FAILURE_CODES.LAUNCH_FAILED:
      return `the agent binary could not be started — check that \`${agent}\` is on PATH for this user`;
    default:
      return null;
  }
}
