// The bridge's side of the agent inbox — filing questions and collecting the answers.
//
//   dev_resources/NOW/agent_inbox_plan.md §10   the RIFFN_ASK marker
//   dev_resources/NOW/phase0_schemas.md §2, §3  the wire format
//   dev_resources/NOW/phase0_turn_contracts.md  why replies are never auto-replayed
//
// ⚠ Every function here is BEST-EFFORT and must stay that way. A turn that produced a good answer
// must not fail because Riffn was unreachable, the token was revoked, or the inbox is switched off.
// The user still hears the reply; they simply do not get an item filed.

import { createHash } from "node:crypto";

import { parseAsk } from "./ask-marker.js";
import { log } from "./log.js";

/** A question is a request for a human's attention. Filing forty in a minute is a bug, not a need. */
const FILE_TIMEOUT_MS = 10_000;

function ulidish() {
  // The worker only requires uniqueness per agent, and this is never a security token.
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.toUpperCase();
}

async function call(cfg, path, body) {
  if (!cfg.inboxToken) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FILE_TIMEOUT_MS);
  try {
    const response = await fetch(`${cfg.inboxURL}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.inboxToken}`,
        "content-type": "application/json",
        // Retrying a file must not create a second item.
        "idempotency-key": ulidish(),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) {
      // 404 is the inbox being switched off, which is the normal state — not worth a warning.
      if (response.status !== 404) {
        log.debug("inbox_rejected", `${path} ${response.status} ${parsed?.error?.code ?? ""}`);
      }
      return null;
    }
    return parsed;
  } catch (err) {
    log.debug("inbox_unreachable", `${path}: ${errText(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const errText = (err) => (err && err.name === "AbortError" ? "timed out" : String(err?.message ?? err));

/**
 * Inspect a finished turn for a `RIFFN_ASK/1:` marker and file it if present.
 *
 * Returns the text that should actually be SPOKEN — the marker line stripped out — so the caller
 * uses this in place of the raw result whether or not anything was filed. ⚠ The user must never
 * hear the protocol.
 *
 * @param {object} cfg
 * @param {string} finalResult  the agent's FINAL message only (§10: never the whole transcript,
 *                              or a marker quoted mid-reasoning files a phantom item)
 * @param {string} taskId       stable per agent task, so a re-ask groups with its predecessor
 */
export async function maybeFileAsk(cfg, finalResult, taskId) {
  const { spoken, ask } = stripAsk(finalResult);
  if (!ask) return { spoken, filed: false };
  const result = await fileAsk(cfg, ask, taskId);
  return { spoken, filed: Boolean(result), itemId: result };
}

/**
 * SYNCHRONOUS. Returns what should be spoken, and the question if there was one.
 *
 * ⚠ Split out from the filing deliberately. Stripping the marker is a CORRECTNESS requirement — the
 * user must never hear the protocol — while filing is a best-effort network call. An earlier
 * version did both in one async function, so the caller assigned the stripped text inside a
 * `.then()`; that left a window in which the raw result, marker and all, could be read and spoken.
 * Keep the strip synchronous and nothing can observe the marker.
 */
export function stripAsk(finalResult) {
  const parsed = parseAsk(finalResult);
  if (!parsed.found) return { spoken: finalResult, ask: null, redacted: false };
  // Speak the prose regardless of whether filing works: an agent that asked something deserves to
  // be heard even when Riffn is unreachable.
  return { spoken: parsed.spoken || parsed.ask, ask: parsed.ask, redacted: parsed.redacted };
}

/** Best-effort. Returns the item id, or null for every failure including the inbox being off. */
export async function fileAsk(cfg, ask, taskId) {
  if (!cfg.inboxToken) return null;
  const result = await call(cfg, "/v1/agent/items", {
    task_id: taskId,
    context_id: taskId,
    // Monotonic per task, so a late report can never overwrite a newer one (phase0_state_machines §2).
    seq: Date.now(),
    kind: "question",
    summary: ask,
    // The repo basename, never a path: §3's boundary is that no filesystem detail crosses.
    location: cfg.cwd ? cfg.cwd.split(/[\\/]/).filter(Boolean).pop() : undefined,
    parts: [{ type: "text", text: ask }],
  });

  if (result?.item_id) log.debug("inbox_filed", `item=${result.item_id}`);
  return result?.item_id ?? null;
}

/**
 * Tell Riffn the task moved on, so an item stops being shown for a question the agent is no longer
 * waiting on. Silent on every failure — a state report is not worth failing a turn over.
 */
export async function reportTaskState(cfg, taskId, taskState) {
  if (!cfg.inboxToken) return;
  await call(cfg, `/v1/agent/tasks/${encodeURIComponent(taskId)}/state`, {
    seq: Date.now(),
    task_state: taskState,
  });
}

/**
 * File what a finished job actually did, as a `completed` item.
 *
 * ⚠ WHY THIS EXISTS. Without it, "what did Bob build this morning?" is only answerable by reaching
 * into that specific machine — so it needs the machine, the network and the right agent selected,
 * and it cannot answer "what did my agents do today?" at all. Filing a bounded summary puts the
 * outcome beside the question that produced it, under the SAME task_id, where the phone can reach
 * both without any machine being involved.
 *
 * ⚠ ORDER MATTERS. The worker refuses a `completed` item for a task it has never seen reach a
 * terminal state (items.ts: `task_state_unknown`) — otherwise `kind` and the task's own history
 * would contradict each other. So the state report goes first and is awaited.
 *
 * ⚠ Only the bounded summary crosses (plan §4.5). The full result stays in the job file on the
 * machine, exactly as it did before.
 *
 * Best-effort in every direction, like everything else here: a job that produced good work must not
 * be marked failed because Riffn was unreachable.
 */
export async function fileCompleted(cfg, taskId, summary, taskState = "COMPLETED") {
  if (!cfg.inboxToken) return null;
  await reportTaskState(cfg, taskId, taskState);
  const result = await call(cfg, "/v1/agent/items", {
    task_id: taskId,
    context_id: taskId,
    seq: Date.now(),
    kind: "completed",
    summary,
    location: cfg.cwd ? cfg.cwd.split(/[\\/]/).filter(Boolean).pop() : undefined,
    parts: [{ type: "text", text: summary }],
  });
  if (result?.item_id) log.debug("inbox_completed", `item=${result.item_id} task=${taskId}`);
  return result?.item_id ?? null;
}

/**
 * Collect answers. Returns leased replies, each of which MUST be acknowledged after it has been
 * successfully dispatched — never before.
 *
 * ⚠ The lease is the whole point: marking delivered on read loses replies when the bridge crashes,
 * and not marking them repeats them forever.
 */
export async function leaseReplies(cfg, max = 10) {
  const result = await call(cfg, "/v1/agent/replies/lease", { max });
  return result?.leased ?? [];
}

/**
 * Settle a leased reply.
 *
 * @param {string|null} refusalReason  one of profile_mismatch | disabled_by_policy | unknown_item |
 *   declined_by_user. Pass it when routing REFUSED the reply, so the answer is recorded as declined
 *   rather than delivered and comes back to the user with something actionable to say.
 *
 * ⚠ Only ever call this AFTER dispatch has succeeded or been terminally refused. Acking early is
 * the failure §5.1 exists to prevent: the reply is gone and the user's spoken answer never ran.
 */
export async function ackReply(cfg, replyId, refusalReason = null) {
  const body = { reply_id: replyId };
  if (refusalReason) {
    body.outcome = "refused";
    body.reason = refusalReason;
  }
  const result = await call(cfg, "/v1/agent/replies/ack", body);
  return Boolean(result);
}

/**
 * Cancellations: the user cleared the item or it expired, so the agent should stop waiting.
 *
 * ⚠ Deliberately a SEPARATE queue from replies, and it must stay separate. A reply carries user
 * text meant for the model; a cancellation must never reach a model as if a human had said it.
 */
export async function leaseCancellations(cfg, max = 10) {
  const result = await call(cfg, "/v1/agent/cancellations/lease", { max });
  return result?.leased ?? [];
}

export async function ackCancellation(cfg, cancellationId) {
  const result = await call(cfg, "/v1/agent/cancellations/ack", { cancellation_id: cancellationId });
  return Boolean(result);
}

/**
 * A stable, opaque task id for a chat turn, so a re-ask in the same conversation groups with its
 * predecessor instead of filing an unrelated second item.
 *
 * ⚠ HASHED, never the raw session id. §3's boundary is that no local identifier crosses to the
 * worker, and a Claude Code session id is exactly that — it names a transcript on this machine.
 * The hash gives the worker the only property it actually needs, sameness.
 */
export function chatTaskId(sessionId) {
  if (!sessionId) return `chat-${ulidish()}`;
  return `chat-${createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 24)}`;
}

export const inboxEnabled = (cfg) => Boolean(cfg.inboxToken);
