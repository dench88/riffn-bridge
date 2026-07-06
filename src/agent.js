// Turning a chat request into reply text — either by driving a local CLI agent (Mode A: Claude Code
// / Codex) or by proxying an HTTP OpenAI-compatible LLM (Mode B).
//
// SECURITY — v1 is READ/PLAN-ONLY (bridge_plan.md §10.3). The CLI agent is invoked with NO
// write/execute permission flags. `acceptEdits` and any RIFFIN_BRIDGE_AGENT_CAPS=write/exec are
// deliberately NOT wired here: enabling the agent to modify files or run commands requires the
// separate, security-reviewed voice-approval project (§11.1), not a flag. All subprocesses are
// invoked with ARGUMENT ARRAYS, never a shell string.
//
// SESSION CONTINUITY (Claude only) — "one persistent agent thread per machine" (bridge_plan.md §9
// #5). Claude Code's `claude -p --resume <session_id>` genuinely continues the SAME on-machine
// conversation across separate process invocations, so once a session exists we send only the
// newest user turn instead of re-flattening the whole transcript. Codex has no resume wiring here
// yet and stays stateless (documented limitation, not an oversight).

import { spawn } from "node:child_process";
import { errorType, log } from "./log.js";

function contentText(content) {
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof c === "string" ? c : c?.text || "")).join("")
      : "";
}

// Fresh-session prompt (Codex, or fallback for any agent): flatten the whole OpenAI message list,
// including system content, into one blob. Codex has no separate system-prompt flag wired here, so
// this is its only path. For Claude this is used only as a last resort (see buildTurnsOnly below).
export function buildPrompt(messages) {
  let system = "";
  const turns = [];
  for (const msg of messages) {
    const content = contentText(msg.content);
    if (msg.role === "system") system += content + "\n";
    else if (msg.role === "assistant") turns.push(`Assistant: ${content}`);
    else turns.push(`User: ${content}`);
  }
  return (system ? system.trim() + "\n\n" : "") + turns.join("\n\n");
}

// Claude path: system content travels via `--append-system-prompt` (a real system-role parameter),
// NOT flattened into the same text blob as the turns — flattening it as plain text meant Claude had
// no strong reason to honor Riffn's "no markdown, spoken style" instructions, since they read as
// just more conversation text rather than an actual system directive. Keeping it as `--append-*`
// (not `--system-prompt`, which REPLACES the default) preserves Claude Code's own default system
// prompt — including its CLAUDE.md/repo-awareness, which is a feature here, not a bug.
export function extractSystemPrompt(messages) {
  const parts = messages.filter((m) => m.role === "system").map((m) => contentText(m.content));
  return parts.join("\n").trim();
}

function buildTurnsOnly(messages) {
  const turns = [];
  for (const msg of messages) {
    if (msg.role === "system") continue;
    const content = contentText(msg.content);
    turns.push(msg.role === "assistant" ? `Assistant: ${content}` : `User: ${content}`);
  }
  return turns.join("\n\n");
}

// Resumed-session prompt: Claude Code's own session already holds the prior turns, so only the
// newest user message needs to travel — resending the full transcript would duplicate context the
// session already has and grow the prompt (and cost) unboundedly.
function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return contentText(messages[i].content);
  }
  return "";
}

// Build the agent command. For claude/codex: READ/PLAN-ONLY — no permission-escalation flags are
// ever added here. For a CUSTOM agent the helper cannot enforce that (the operator's own agent
// config decides what it may do) — see customAgentCapsWarning/agentCaps.
function agentCommand(cfg, prompt, sessionId, appendSystemPrompt) {
  if (cfg.agent === "claude") {
    // Headless `claude -p` cannot answer interactive permission prompts, so tool actions requiring
    // permission are denied by default — which is exactly the read/plan-only posture we want in v1.
    const args = ["-p", prompt, "--output-format", "json"];
    if (sessionId) args.push("--resume", sessionId);
    if (appendSystemPrompt) args.push("--append-system-prompt", appendSystemPrompt);
    return { bin: cfg.claudeBin, args };
  }
  if (cfg.agent === "codex") {
    return { bin: cfg.codexBin, args: ["exec", prompt] };
  }
  if (cfg.agent === "custom") {
    if (!cfg.customAgentBin) {
      throw new Error("RIFFIN_BRIDGE_AGENT=custom requires RIFFIN_BRIDGE_AGENT_BIN.");
    }
    // Whitespace-split template; each {prompt} token becomes ONE argv element (never a shell
    // string, so the prompt can't inject). Without a {prompt} token, append the prompt last.
    const template = cfg.customAgentArgs ? cfg.customAgentArgs.split(/\s+/) : [];
    const args = template.map((t) => (t === "{prompt}" ? prompt : t));
    if (!template.includes("{prompt}")) args.push(prompt);
    return { bin: cfg.customAgentBin, args };
  }
  throw new Error(`Unknown RIFFIN_BRIDGE_AGENT '${cfg.agent}' (expected 'claude', 'codex', or 'custom').`);
}

// What /health reports as `caps`. Honest per agent: headless claude denies permission prompts by
// default (read/plan-only guaranteed); codex exec likewise runs without our escalation flags. A
// CUSTOM agent's permissions are whatever the operator configured — claiming "read-plan" for it
// would be a lie the phone then displays, so report "operator-defined" instead (§10.3).
export function agentCaps(cfg) {
  if (cfg.mode !== "cli") return "n/a";
  return cfg.agent === "custom" ? "operator-defined" : "read-plan";
}

export function customAgentCapsWarning(cfg) {
  if (cfg.mode !== "cli" || cfg.agent !== "custom") return null;
  return (
    `⚠️  Custom agent '${cfg.customAgentBin}': riffn-bridge cannot enforce read/plan-only on an\n` +
    `    arbitrary CLI — whatever permissions that tool has, voice turns have. Configure the\n` +
    `    agent itself to be read-only if that's what you want. /health reports caps=operator-defined.`
  );
}

export function extractResult(stdout) {
  // `claude -p --output-format json` prints one JSON result object; the final text is in `.result`,
  // and `.session_id` is what makes `--resume` possible on the next turn. Defensive: fall back to
  // raw stdout (no session_id) if the shape changes or it isn't JSON (e.g. Codex).
  const trimmed = stdout.trim();
  if (!trimmed) return { text: "", sessionId: undefined };
  try {
    const obj = JSON.parse(trimmed);
    if (obj.is_error) throw new Error(typeof obj.result === "string" ? obj.result : "agent reported an error");
    const text = typeof obj.result === "string" ? obj.result
      : typeof obj.text === "string" ? obj.text
      : Array.isArray(obj.content) ? obj.content.map((c) => c?.text || "").join("")
      : trimmed;
    const sessionId = typeof obj.session_id === "string" ? obj.session_id : undefined;
    return { text, sessionId };
  } catch (e) {
    if (e instanceof SyntaxError) return { text: trimmed, sessionId: undefined }; // not JSON
    throw e;
  }
}

// Run the CLI agent. Honors an AbortSignal so the caller can cancel on client disconnect/timeout —
// the child is SIGKILLed and its output discarded. Resolves { text, sessionId }.
function runAgent(cfg, prompt, signal, sessionId, appendSystemPrompt) {
  return new Promise((resolve, reject) => {
    const { bin, args } = agentCommand(cfg, prompt, sessionId, appendSystemPrompt);
    const child = spawn(bin, args, { cwd: cfg.cwd, env: process.env });
    let stdout = "", stderr = "", settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn(arg);
    };
    const onAbort = () => { child.kill("SIGKILL"); finish(reject, new Error("cancelled")); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(reject, new Error(`Agent timed out after ${cfg.timeoutMs} ms.`)); }, cfg.timeoutMs);

    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    }
    // Stateful UTF-8 decode — without setEncoding, a multibyte character split across chunk
    // boundaries is decoded per-chunk and corrupts (mojibake in non-ASCII replies).
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (err) => finish(reject, new Error(`Failed to launch '${bin}': ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return finish(reject, new Error(stderr.trim() || `Agent exited with code ${code}.`));
      try { finish(resolve, extractResult(stdout)); }
      catch (e) { finish(reject, e); }
    });
  });
}

// Produce reply text from either the HTTP LLM (Mode B proxy) or the CLI agent (Mode A). `session`
// (from session.js) is the persistent-thread store; pass null/undefined for stateless behavior
// (Mode B, or Codex).
export async function generateText(cfg, messages, requestedModel, signal, session) {
  // Diagnostic trace (RIFFIN_BRIDGE_VERBOSE=1 only) — answers "which physical bridge/directory/
  // session actually served this turn," the exact question a cross-topic reply raises. cwd is the
  // full path here (not the redacted basename /health sends to the phone) because this is a local
  // terminal log, a different trust boundary than the wire.
  log.debug("turn_start", `pid=${process.pid} port=${cfg.port} mode=${cfg.mode} agent=${cfg.agent} cwd=${cfg.cwd}`);

  if (cfg.llmUrl) {
    const headers = { "Content-Type": "application/json" };
    if (cfg.llmKey) headers.Authorization = `Bearer ${cfg.llmKey}`;
    const resp = await fetch(cfg.llmUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.llmModel || requestedModel || cfg.modelId, messages, stream: false }),
      signal: signal ?? AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!resp.ok) {
      // Include only the status — the body may echo prompt content (kept out of default logs).
      const err = new Error(`LLM endpoint returned ${resp.status}`);
      err.name = "LLMUpstreamError";
      throw err;
    }
    const data = await resp.json().catch(() => null);
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("LLM response missing choices[0].message.content.");
    return text;
  }

  if (cfg.agent !== "claude" || !session) {
    // Codex, or no session store configured: stateless flatten every turn (Phase 1 behavior). No
    // --append-system-prompt wiring for Codex yet, so system content stays in the flattened blob.
    const { text } = await runAgent(cfg, buildPrompt(messages), signal, undefined);
    return text;
  }

  // Claude: system content ALWAYS travels via --append-system-prompt, every turn (resumed or
  // fresh) — so formatting rules like "no markdown, spoken style" hold for the life of the session,
  // not just its first turn.
  const appendSystemPrompt = extractSystemPrompt(messages);

  const existingId = session.get();
  if (existingId) {
    log.debug("session_resume", `cwd=${cfg.cwd} session=${existingId}`);
    try {
      const { text, sessionId } = await runAgent(
        cfg, lastUserMessage(messages), signal, existingId, appendSystemPrompt
      );
      session.set(sessionId || existingId);
      return text;
    } catch (err) {
      // Resume failed (expired/corrupted session, agent restarted, etc.) — self-heal ONCE: drop the
      // stale session and retry fresh with the full flattened prompt, rather than surfacing a
      // confusing resume error. If the fresh attempt also fails, that error propagates normally.
      log.error("session_resume_failed_retrying_fresh", err);
      session.clear();
    }
  }
  log.debug("session_fresh", `cwd=${cfg.cwd}`);
  const { text, sessionId } = await runAgent(
    cfg, buildTurnsOnly(messages), signal, undefined, appendSystemPrompt
  );
  log.debug("session_started", `cwd=${cfg.cwd} newSession=${sessionId}`);
  session.set(sessionId);
  return text;
}

export { errorType };
