// Redact-by-default logger (bridge_plan.md §10.10, threat A7).
//
// At default verbosity the helper NEVER writes: the bearer token, prompt/reply text, code or file
// contents, the working directory, subprocess argument arrays, or tunnel/URL hostnames. Only
// non-sensitive operational data is logged (timestamps, methods/paths, status codes, coarse timings,
// error *types*). Set RIFFIN_BRIDGE_VERBOSE=1 for diagnostic logging — which may capture sensitive
// data and is intended for local debugging only.

const VERBOSE = process.env.RIFFIN_BRIDGE_VERBOSE === "1";

function ts() {
  return new Date().toISOString();
}

// The class name of an error, without its (potentially sensitive) message.
export function errorType(err) {
  if (!err) return "UnknownError";
  return err.name || err.constructor?.name || "Error";
}

export const log = {
  verbose: VERBOSE,

  info(event, fields = {}) {
    // fields must already be non-sensitive; callers pass status/timing/type only.
    process.stdout.write(`${ts()} ${event} ${JSON.stringify(fields)}\n`);
  },

  // Log an error by TYPE only at default verbosity; include the message only when verbose.
  error(event, err) {
    if (VERBOSE) {
      process.stderr.write(`${ts()} ${event} ${errorType(err)}: ${err?.message ?? ""}\n`);
    } else {
      process.stderr.write(`${ts()} ${event} ${errorType(err)}\n`);
    }
  },

  // Diagnostic detail — only emitted when verbose, and prefixed so it's obvious it may be sensitive.
  debug(event, detail) {
    if (!VERBOSE) return;
    process.stderr.write(`${ts()} [verbose] ${event} ${detail}\n`);
  },
};

export function warnVerboseIfEnabled() {
  if (VERBOSE) {
    process.stderr.write(
      "⚠️  RIFFIN_BRIDGE_VERBOSE=1 — diagnostic logging is ON and MAY capture prompts, code, and\n" +
      "    other sensitive data. Use only for local debugging; never in shared/production logs.\n"
    );
  }
}
