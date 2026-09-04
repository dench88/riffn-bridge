// Local pending context — the machine's memory of what it asked and under what authority.
//
//   dev_resources/NOW/agent_inbox_plan.md §7.6        local pending context
//   dev_resources/NOW/phase0_routing_matrix.md §3.1   why the profile is captured at FILING time
//
// ⚠ WHY THIS FILE EXISTS AT ALL. A reply can arrive an hour after the question, and in that hour the
// user may have switched agents, changed edit mode, or restarted the bridge. Routing the answer
// under whatever the machine looks like NOW would dispatch it into a different agent under different
// permissions — the authority-raising that §2's invariant forbids. So the profile is captured when
// the item is FILED and stored here, and the reply is routed against that.
//
// ⚠ AND WHY IT IS LOCAL. The profile describes this machine's permissions and agent configuration.
// The worker never sees it (plan §3): it holds the item and the answer, never the authority under
// which the answer will run. That split is what stops a compromised worker from escalating an agent.

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";

import { log } from "./log.js";

const PENDING_FILE = ".riffn-bridge-pending.json";

/**
 * Bounded on purpose. An agent that files hundreds of questions nobody answers must not grow this
 * file without limit; the oldest entries are dropped first because the newest question is the one
 * the user is most likely to still be thinking about.
 */
const MAX_PENDING = 200;

/**
 * How long a pending entry is worth keeping. Past this the item has almost certainly expired on the
 * worker too, and routing an answer against a week-old profile is not a kindness.
 */
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createPendingStore(cfg) {
  const file = path.join(cfg.envDir, PENDING_FILE);
  /** @type {Map<string, object>} itemId → entry */
  let entries = new Map();

  function load() {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(raw?.entries)) {
        entries = new Map(raw.entries.map((e) => [e.itemId, e]));
      }
    } catch {
      // Absent or corrupt is the ordinary first-run case. A pending store that fails to load must
      // never stop the bridge starting — the cost is that in-flight replies get refused as
      // "unknown item", which is the safe direction.
      entries = new Map();
    }
    prune();
  }

  function persist() {
    try {
      writeFileSync(file, JSON.stringify({ entries: [...entries.values()] }, null, 2), { mode: 0o600 });
    } catch (e) {
      log.error("pending_persist_failed", e);
    }
  }

  /** Drop expired and over-cap entries. Called on load and after every write. */
  function prune() {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [id, e] of entries) {
      if (!e?.filedAt || e.filedAt < cutoff) entries.delete(id);
    }
    if (entries.size > MAX_PENDING) {
      const sorted = [...entries.values()].sort((a, b) => a.filedAt - b.filedAt);
      for (const e of sorted.slice(0, entries.size - MAX_PENDING)) entries.delete(e.itemId);
    }
  }

  return {
    /**
     * Record what we asked and the authority we asked it under.
     *
     * @param {string} itemId   the worker's id for the filed item
     * @param {object} profile  from captureProfile() — permissions, agent, edit mode
     * @param {object} context  { taskId, question, sessionId }
     */
    remember(itemId, profile, { taskId, question, sessionId = null }) {
      if (!itemId) return;
      entries.set(itemId, {
        itemId,
        taskId,
        profile,
        // Kept so a `fresh` dispatch can restate what was asked: a new session has no memory of the
        // question, so sending only the answer would arrive as a non-sequitur.
        question,
        // The session the question was asked in. Only ever used for a `resume` decision — the
        // routing matrix decides whether resuming is permitted, never this file.
        //
        // ⚠ NEVER for `limited` (phase0_delivery_and_context.md §8). Resuming a limited session is
        // the hole the whole routing matrix exists to close — `--resume` inherits the session's
        // established, unrestricted permission context because the lockdown flags and the PreToolUse
        // hook bind only at session creation. Dropping the id here makes that path UNAVAILABLE
        // rather than merely forbidden: there is nothing to resume even if a future caller tried.
        sessionId: profile?.editMode === "limited" ? null : sessionId,
        filedAt: Date.now(),
      });
      prune();
      persist();
    },

    /** The stored context for an item, or null if we never filed it (or it aged out). */
    get(itemId) {
      return entries.get(itemId) ?? null;
    },

    /** Called once a reply has been dispatched or terminally refused. */
    forget(itemId) {
      if (entries.delete(itemId)) persist();
    },

    get size() {
      return entries.size;
    },

    /** Test seam: drop everything, including the file. */
    reset() {
      entries = new Map();
      try { unlinkSync(file); } catch { /* already gone */ }
    },

    load,
  };
}
