// How an inbox reply gets dispatched back into an agent.
// Implements phase0_routing_matrix.md (Phase 0 deliverable 3) as executable rules.
//
// Phase 0 risk spike (deliverable 13). Pure and UNWIRED — server.js does not import this yet.
//
// The governing invariant, from agent_inbox_plan.md §2:
//     Authority may be preserved or reduced by a reply. NEVER raised.
//
// Everything below exists to make that mechanical rather than remembered.

import { agentCapabilities } from "./agent.js";

/**
 * The routing context captured when an item is FILED, stored locally with the item.
 *
 * ⚠ Why filing-time and not answer-time (routing matrix §3.1): a user can answer an hour later,
 * having switched agents in between. Dispatching their answer into a DIFFERENT agent under
 * DIFFERENT permissions is exactly the authority-raising the invariant forbids. The plan already
 * makes a job's execution profile immutable for its lifetime; the inbox extends that across time.
 *
 * Stays on the machine — never sent to the worker (plan §3 privacy boundary).
 */
export function captureProfile(cfg, { repoFingerprint = null, snapshotRef = null } = {}) {
  const caps = agentCapabilities(cfg);
  return {
    agent: cfg.agent,
    // Derived values only. Never the raw env var: an edit mode armed for one agent is silently
    // downgraded to "disabled" when the agent changes (config.js:92), and routing that read the raw
    // value would act on a permission the bridge has already revoked.
    editMode: cfg.editMode || "disabled",
    chatWrites: caps ? caps.chatWrites : null,
    editJobs: caps ? caps.editJobs : false,
    repoFingerprint,
    snapshotRef,
  };
}

/**
 * Does the machine still look like it did when the item was filed?
 * A mismatch is REFUSED, never silently re-routed (routing matrix §3.1).
 */
export function profileMatches(stored, cfg) {
  if (!stored) return false;
  const current = captureProfile(cfg, {
    repoFingerprint: stored.repoFingerprint,  // compared by the caller; not re-derived here
    snapshotRef: stored.snapshotRef,
  });
  return (
    stored.agent === current.agent &&
    stored.editMode === current.editMode &&
    stored.chatWrites === current.chatWrites &&
    stored.editJobs === current.editJobs
  );
}

/**
 * The matrix itself. Returns a dispatch decision for a reply to an item filed under `stored`.
 *
 *   { action: "resume", requiresVoiceConfirm: false }
 *   { action: "fresh",  requiresVoiceConfirm: true|false, capsUnknown?: true }
 *   { action: "refuse", reason, spoken }        — always with something to SAY, never silent
 *
 * `spoken` exists on every refusal on purpose. decisions.md 29 Aug: ship no voice path whose
 * failure mode is silence.
 */
export function routeReply(stored, cfg) {
  if (!profileMatches(stored, cfg)) {
    return {
      action: "refuse",
      reason: "profile_mismatch",
      // Deliberately vague about WHAT changed: the user did not necessarily make the change, and a
      // spoken diff of permission internals is noise. Tell them the actionable part.
      spoken: "That machine's setup changed since the question was asked, so I didn't send your answer. Ask again to start fresh.",
    };
  }

  // Codex is refused, not degraded (routing matrix §2.3). Its shell subprocesses can bypass
  // file-read denials, which is why it is disabled by policy rather than run read-only.
  if (stored.agent === "codex") {
    return {
      action: "refuse",
      reason: "disabled_by_policy",
      spoken: "That agent can't take replies on this machine.",
    };
  }

  // Custom agents are stateless — no session exists to resume — and the bridge enforces nothing on
  // them. chatWrites is null (an honest "unknown"), never false: reporting a custom agent as
  // read-only would imply a boundary that is not there.
  if (stored.agent === "custom") {
    return { action: "fresh", requiresVoiceConfirm: false, capsUnknown: true };
  }

  // ── claude ────────────────────────────────────────────────────────────────────────────────
  //
  // ⚠ The one row that must never resume. `--resume` inherits the resumed session's established,
  // unrestricted permission context — the tool-lockdown flags and the PreToolUse hook only bind at
  // session CREATION (dogfood finding, jobs.js, 2026-07-12). A session created under "limited"
  // would therefore carry its own context and the fresh containment would not re-bind.
  //
  // "ungated" is safe to resume for the opposite reason: the session store is mode-stamped
  // (session.js:36), so any session it returns for ungated was CREATED ungated — born with that
  // containment from turn one.
  if (stored.editMode === "limited") {
    return {
      action: "fresh",
      requiresVoiceConfirm: true,
      // The spoken confirmation dispatchEditJob already uses. A limited-edit reply is the only
      // path where answering a question can write to disk, so it re-asks every time.
      confirmPrompt: "This resumes an edit task on that machine. Proceed?",
    };
  }

  // disabled → resume read-only. ungated → resume, writes permitted.
  return { action: "resume", requiresVoiceConfirm: false };
}
