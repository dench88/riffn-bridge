// Phase 4A, reply side — the loop that takes an answer off the worker and puts it back into the
// agent that asked.
//
//   dev_resources/NOW/agent_inbox_plan.md §2, §5        routing invariant, lease/dispatch/ack
//   dev_resources/NOW/phase0_routing_matrix.md §2, §3   the matrix and the authority invariant
//   dev_resources/NOW/phase0_turn_contracts.md §3.2     why a reply is NEVER auto-replayed
//   dev_resources/NOW/phase0_delivery_and_context.md    the on-reply sequence, §8 session storage
//
// Until this file existed the inbox was half a circuit: a question could be filed and an answer
// stored, and nothing carried the answer back. `inbox-routing.js` had the rules but was pure and
// unwired; this is what wires them.
//
// ⚠ THE ONE RULE THIS FILE EXISTS TO ENFORCE. An agent in `limited` edit mode must never have its
// reply dispatched with `--resume`. `--resume` inherits the resumed session's established permission
// context — the tool-lockdown flags and the PreToolUse guard hook bind only at session CREATION
// (dogfood, 2026-07-12) — so resuming would silently restore exactly the authority the restriction
// removed. Everything here routes through routeReply() and then ASSERTS the result again at the
// spawn boundary, because a rule that is only checked once is a rule that gets refactored away.

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";

import { log } from "./log.js";
import { routeReply } from "./inbox-routing.js";
import { leaseReplies, ackReply, leaseCancellations, ackCancellation } from "./inbox.js";
import { generateText } from "./agent.js";
import { SnapshotError } from "./jobs.js";

/**
 * The durable dispatch journal (phase0_turn_contracts §3.2 / §4: `dispatching` is a durable state,
 * not an in-memory flag — it must survive `kill -9`).
 */
const DISPATCH_FILE = ".riffn-bridge-dispatch.json";

/** How often to ask the worker for work. Deliberately unhurried: a human is on the other end. */
const DEFAULT_POLL_MS = 15_000;

/** Stranded records are diagnostics, not a queue. Keep enough to explain, not enough to grow. */
const MAX_STRANDED = 50;

/**
 * Map the FILING-TIME edit mode to the job capability that implements it.
 *
 * ⚠ This is the security-critical table, and it is written as data so it can be read in one glance:
 *
 *   disabled → read job   → resumes the chat session, cannot write.               (matrix row 1)
 *   limited  → edit job   → FRESH session every time, write-capable, snapshotted. (matrix row 2)
 *   ungated  → ungated job→ resumes; safe because the session store is mode-stamped, so any session
 *                           it returns for ungated was CREATED ungated.           (matrix row 3)
 *
 * `jobs.start()` derives fresh-versus-resume from exactly this value (`caps === "edit"` is its only
 * fresh path), which is why the assertion below can check the two against each other.
 */
const JOB_CAPS_FOR_EDIT_MODE = Object.freeze({
  disabled: undefined,   // undefined, not "read" — jobs.start()'s own spelling for a read job
  limited: "edit",
  ungated: "ungated",
});

/**
 * Rebuild what the agent is told. Used for BOTH resume and fresh dispatches on purpose.
 *
 * A fresh session has no memory of the question, so sending the bare answer would arrive as a
 * non-sequitur ("yes, the second one" — to what?). A resumed session does remember, but restating
 * costs a few tokens and removes a whole class of "which question was this?" ambiguity when the
 * session has moved on since. One shape, no branch.
 *
 * ⚠ The reply text is USER speech meant for the model, and it stays that way. It is never
 * reinterpreted as an instruction to the bridge, and a CANCELLATION never comes through here — that
 * is the entire reason cancellations are a separate queue with a separate route.
 */
function replyPrompt(question, answer) {
  return [
    "You asked the person you are working for a question, and they have answered.",
    "",
    `Your question: ${question}`,
    "",
    `Their answer: ${answer}`,
    "",
    "Continue from here, acting on their answer.",
  ].join("\n");
}

/**
 * @param {object} cfg
 * @param {object} deps
 * @param {object}   deps.pending  the local pending-context store (inbox-pending.js)
 * @param {object=}  deps.jobs     the job store — Claude only; absent for custom/codex bridges
 * @param {Function} deps.isBusy   () => boolean. The SHARED single-flight: a dispatch spawns the
 *                                 agent against the same cwd as chat and jobs, so it must queue
 *                                 behind them rather than double-run the agent (§11.3).
 * @param {Function=} deps.beginFlight  Take the single-flight for the duration of a dispatch.
 * @param {Function=} deps.endFlight    Release it.
 *
 * ⚠ begin/endFlight are not belt-and-braces. A Claude dispatch marks the agent busy on its own
 * (jobs.start() sets the job store's live handle, which the chat route already checks), but a CUSTOM
 * agent has no job engine — its dispatch is a plain turn, and without an explicit lock a chat
 * request arriving mid-dispatch would spawn a second agent against the same working directory.
 */
export function createReplyDispatcher(cfg, {
  pending, jobs = null, isBusy = () => false, beginFlight = () => {}, endFlight = () => {},
} = {}) {
  const file = path.join(cfg.envDir, DISPATCH_FILE);
  const pollMs = Number(process.env.RIFFIN_BRIDGE_INBOX_POLL_MS || DEFAULT_POLL_MS);

  /** @type {{ inflight: object|null, stranded: object[] }} */
  let journal = { inflight: null, stranded: [] };
  let timer = null;
  let running = false;
  let stopped = false;

  function persist() {
    try {
      // 0600: the journal names item and reply ids, and sits beside .env under the same posture.
      writeFileSync(file, JSON.stringify(journal, null, 2), { mode: 0o600 });
    } catch (e) {
      log.error("dispatch_journal_persist_failed", e);
    }
  }

  function loadJournal() {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      journal = {
        inflight: raw?.inflight ?? null,
        stranded: Array.isArray(raw?.stranded) ? raw.stranded : [],
      };
    } catch {
      // Absent or corrupt is the ordinary first-run case, and a journal that will not parse must
      // never stop the bridge. The cost of starting clean is that an interrupted dispatch is
      // forgotten rather than surfaced — the safe direction, since forgetting can only ever cause a
      // reply to be re-offered, never re-run.
      journal = { inflight: null, stranded: [] };
    }
  }

  /**
   * ⚠ THE RESTART RULE (phase0_turn_contracts §3.2). A record still marked `dispatching` means the
   * helper died between handing a reply to the agent and hearing back. We cannot know whether the
   * agent acted on it. A stable reply_id does NOT make a CLI idempotent, so replaying is capable of
   * running the same instruction — a file edit, in `limited` and `ungated` — twice.
   *
   * So it is NEVER replayed. It is moved to `stranded`, refused a second dispatch for as long as
   * this journal exists, and left un-acked so the worker's own attempt counter eventually
   * dead-letters it and the phone tells the user their answer did not get through. A lost reply is
   * an inconvenience; a doubled one can be destructive.
   */
  function reconcileOnBoot() {
    if (!journal.inflight) return;
    const record = { ...journal.inflight, state: "stranded", strandedAt: Date.now() };
    journal.stranded.push(record);
    if (journal.stranded.length > MAX_STRANDED) {
      journal.stranded = journal.stranded.slice(-MAX_STRANDED);
    }
    journal.inflight = null;
    persist();
    // The operator's own terminal is the one place allowed to see this, and the one place someone
    // can act on it. The phone only ever learns "your answer didn't get through".
    console.warn(
      `⚠️  An inbox reply was being dispatched when this bridge last stopped, and it will NOT be\n` +
      `    retried automatically — we cannot tell whether the agent already acted on it.\n` +
      `      reply:  ${record.replyId}\n` +
      `      item:   ${record.itemId}\n` +
      `      mode:   ${record.agent}/${record.editMode}\n` +
      `    Ask the question again from the app if the answer needs to land.`
    );
  }

  const isStranded = (replyId) => journal.stranded.some((r) => r.replyId === replyId);

  function beginDispatch(reply, entry, decision) {
    journal.inflight = {
      replyId: reply.reply_id,
      itemId: reply.item_id,
      taskId: reply.task_id,
      action: decision.action,
      agent: entry.profile?.agent ?? "unknown",
      editMode: entry.profile?.editMode ?? "unknown",
      startedAt: Date.now(),
      state: "dispatching",
    };
    persist();
  }

  function endDispatch() {
    journal.inflight = null;
    persist();
  }

  /**
   * Hand one reply to the agent. Resolves when the agent has ACCEPTED it (a job is started, or a
   * chat turn has returned) — which is what "successful dispatch" means for the ack contract.
   *
   * Throws on a failure where nothing was handed over; the caller then clears the journal and lets
   * the lease lapse for a clean retry.
   */
  async function handToAgent(decision, entry, reply) {
    const prompt = replyPrompt(entry.question, reply.text);
    const profile = entry.profile ?? {};

    // Custom agents are stateless: there is no session, so every dispatch is fresh by necessity and
    // the bridge enforces nothing about what they may touch (matrix §2.2 — report honestly, never
    // imply a boundary that is not there). A plain turn is the whole mechanism available.
    if (profile.agent === "custom") {
      await generateText(cfg, [{ role: "user", content: prompt }], undefined, undefined, null);
      return "chat";
    }

    if (!jobs) throw new Error("this bridge has no job engine to dispatch a reply into");

    const caps = JOB_CAPS_FOR_EDIT_MODE[profile.editMode];
    // An edit mode we do not recognise is not a reason to guess. Fail closed.
    if (!(profile.editMode in JOB_CAPS_FOR_EDIT_MODE)) {
      throw new Error(`unrecognised filing-time edit mode: ${profile.editMode}`);
    }

    // ⚠ THE ASSERTION. routeReply() already decided resume-versus-fresh from the matrix; this checks
    // that the capability we are about to spawn with IMPLEMENTS that decision, because the two are
    // derived independently and a refactor to either one must not be able to silently disagree.
    //
    // `caps === "edit"` is jobs.start()'s only fresh-session path, so it must be exactly the cases
    // routeReply called "fresh" — and `limited` must be one of them.
    const spawnsFresh = caps === "edit";
    if (spawnsFresh !== (decision.action === "fresh")) {
      throw new Error(
        `refusing to dispatch: routing said ${decision.action} but caps ${caps ?? "read"} would ` +
        `spawn ${spawnsFresh ? "fresh" : "resumed"}`
      );
    }
    if (profile.editMode === "limited" && !spawnsFresh) {
      throw new Error("refusing to dispatch: a limited-mode reply must never resume a session");
    }

    const view = jobs.start(prompt, undefined, caps);
    // null means the single-flight beat us between the isBusy() check and here. Nothing started.
    if (!view) throw new SnapshotError("the agent was busy when the reply was dispatched");
    return `job ${view.id}`;
  }

  /** Process one leased reply, start to finish. Never throws. */
  async function handleReply(reply) {
    // The restart rule: a reply we may already have run is offered no second dispatch, and is not
    // acked either — the worker's attempt counter is what eventually tells the user.
    if (isStranded(reply.reply_id)) {
      log.debug("reply_stranded_skip", `reply=${reply.reply_id}`);
      return;
    }

    const entry = pending.get(reply.item_id);

    // No local record: the state was wiped, the item aged out, or this reply belongs to a different
    // machine's question. Refuse plainly rather than reconstruct from the summary — the summary is a
    // bounded description written for a human, not a specification (delivery_and_context §11).
    if (!entry) {
      log.debug("reply_unknown_item", `item=${reply.item_id}`);
      await ackReply(cfg, reply.reply_id, "unknown_item");
      return;
    }

    const decision = routeReply(entry.profile, cfg);
    if (decision.action === "refuse") {
      // REFUSED is terminal and distinct from dead-letter: it got here and was declined for a stated
      // reason, so the phone can say something actionable instead of "couldn't be delivered".
      log.debug("reply_refused", `reply=${reply.reply_id} reason=${decision.reason}`);
      await ackReply(cfg, reply.reply_id, decision.reason);
      pending.forget(reply.item_id);
      return;
    }

    // ⚠ THE CONFIRMATION GATE, and the reason it lives here rather than in routeReply().
    //
    // routeReply() is the matrix, and the matrix is right: a `limited` reply is dispatched FRESH and
    // needs a new spoken confirmation every time ("this resumes an edit task on that machine —
    // proceed?"). That confirmation authorises a write happening NOW, possibly hours after the
    // question, possibly while driving — which is exactly why it is not satisfied by the user having
    // answered at all.
    //
    // The phone now proves it: `confirmed` rides on the reply, set only when the user gave a fresh
    // yes at the moment of answering (worker migration 0039). So the gate became a CHECK rather
    // than a blanket refusal — but every part of the old reasoning still holds for a reply that
    // arrives without one, and that is still the common case for any client that predates this.
    //
    // ⚠ THE DIRECTION OF TRUST. `requiresVoiceConfirm` comes from THIS machine's own filing-time
    // record; `confirmed` comes over the wire. The local record decides whether permission was
    // needed, the wire only reports whether a human gave it. A worker that lied about `confirmed`
    // could not widen what this reply is allowed to do — routeReply already fixed that from local
    // state — it could only skip a prompt the user would otherwise have seen. Never invert these.
    if (decision.requiresVoiceConfirm && reply.confirmed !== true) {
      log.debug("reply_needs_confirmation", `reply=${reply.reply_id} mode=${entry.profile?.editMode}`);
      await ackReply(cfg, reply.reply_id, "needs_confirmation");
      // Deliberately NOT forgotten: the question is still open and the user may answer it again with
      // a confirmation. Forgetting would turn the retry into `unknown_item`.
      return;
    }
    if (decision.requiresVoiceConfirm) {
      // Worth its own line in the log: this is the one path where a spoken yes, made on another
      // device, is what authorised a write on this machine. If a file changes unexpectedly, this
      // is the record that says why.
      log.debug("reply_confirmed", `reply=${reply.reply_id} mode=${entry.profile?.editMode}`);
    }

    // ⚠ Persist BEFORE dispatch, always (plan §5). The window this closes is the helper dying
    // between the agent starting and the ack landing.
    beginDispatch(reply, entry, decision);
    let handed = null;
    try {
      beginFlight();
      try {
        handed = await handToAgent(decision, entry, reply);
      } finally {
        // Released as soon as the agent has TAKEN the reply. For a job that is the moment it starts
        // — the job store's own live handle holds the flight from there. For a custom agent's plain
        // turn it is the moment the turn returns, which is when the agent is genuinely free again.
        endFlight();
      }
    } catch (err) {
      // Nothing was handed over, so this is unambiguous and safe to retry: clear the journal and
      // leave the reply un-acked. Its lease lapses and it comes back PENDING.
      endDispatch();
      log.error("reply_dispatch_failed", err);
      return;
    }

    // Dispatched. Only now is it safe to ack — acking earlier is the exact failure the lease exists
    // to prevent: the reply is gone and the user's spoken answer never ran.
    endDispatch();
    const acked = await ackReply(cfg, reply.reply_id);
    // A failed ack is not a failed dispatch. The reply already ran; if the ack does not land the
    // lease lapses and the worker offers it again — which the journal cannot catch, because the
    // record was cleared. Accepting that is deliberate: the alternative is keeping every dispatched
    // reply forever. Logged so a pattern of it is visible.
    if (!acked) log.debug("reply_ack_failed", `reply=${reply.reply_id} (dispatched as ${handed})`);
    else log.debug("reply_dispatched", `reply=${reply.reply_id} → ${handed}`);
    pending.forget(reply.item_id);
  }

  /**
   * Cancellations: the user cleared the item or it expired.
   *
   * ⚠ A cancellation NEVER reaches the model. It is not routed, not prompted, not dispatched — it
   * only drops the local pending context, which is what makes a later reply for the same item refuse
   * as `unknown_item` rather than run. The agent's turn already ended when it filed the question, so
   * there is nothing running to stop; the state is all that needs clearing.
   */
  async function handleCancellation(cancellation) {
    pending.forget(cancellation.item_id);
    await ackCancellation(cfg, cancellation.cancellation_id);
    log.debug("cancellation_acked", `item=${cancellation.item_id} reason=${cancellation.reason}`);
  }

  async function tick() {
    if (stopped || running) return;
    // Queue behind chat and jobs rather than racing them — they share one agent and one cwd.
    if (isBusy()) return;
    running = true;
    try {
      // Cancellations first: clearing a stale item before dispatching anything means an item the
      // user just cleared cannot be answered into the agent a moment later.
      for (const cancellation of await leaseCancellations(cfg)) {
        await handleCancellation(cancellation);
      }
      // ⚠ ONE. Not the default ten. A lease is a promise to deliver within its window, and this
      // machine runs one agent turn at a time — so leasing a batch would leave nine replies sitting
      // leased behind a single-flight they cannot enter, lapsing one delivery ATTEMPT each. Five
      // lapses dead-letters a reply, so a burst of answers could report itself undeliverable purely
      // because we claimed more than we could run.
      for (const reply of await leaseReplies(cfg, 1)) {
        await handleReply(reply);
      }
    } catch (err) {
      // The loop is best-effort in every direction — an unreachable worker or a malformed row must
      // never take the bridge down with it.
      log.error("inbox_poll_failed", err);
    } finally {
      running = false;
    }
  }

  return {
    /** Interrupted dispatches, for /health and the startup banner. Never a queue to retry. */
    stranded: () => journal.stranded.map((r) => ({ replyId: r.replyId, itemId: r.itemId, strandedAt: r.strandedAt })),

    start() {
      loadJournal();
      reconcileOnBoot();
      if (!cfg.inboxToken) {
        // The ordinary state for a machine paired before the inbox existed. Not an error.
        log.debug("inbox_dispatch_idle", "no worker token — reply collection is off");
        return;
      }
      stopped = false;
      timer = setInterval(() => { tick().catch(() => {}); }, pollMs);
      // Don't hold the process open just to poll.
      timer.unref?.();
      log.debug("inbox_dispatch_started", `every ${Math.round(pollMs / 1000)}s`);
    },

    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },

    /** Test seam: run one poll synchronously rather than waiting for the interval. */
    tick,

    /** Test seam: drop the journal entirely. */
    reset() {
      journal = { inflight: null, stranded: [] };
      try { unlinkSync(file); } catch { /* already gone */ }
    },
  };
}
