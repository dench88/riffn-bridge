// The HTTP server: an OpenAI-compatible shim with tailnet-only binding, bearer-token auth,
// single-flight concurrency, cancel-on-disconnect, and redact-by-default request logging.

import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { MAX_BODY_BYTES, VERSION, redactedCwd } from "./config.js";
import { log, errorType, warnVerboseIfEnabled } from "./log.js";
import { generateText, agentCaps, customAgentCapsWarning, extractSystemPrompt } from "./agent.js";
import { synthesize, mimeForFormat } from "./tts.js";
import { createSessionStore, peekRaw as peekRawSession } from "./session.js";
import { createJobStore } from "./jobs.js";
import { saveNote } from "./notes.js";

function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}
function sendError(res, status, message) {
  send(res, status, { error: { message, type: "riffin_bridge_error" } });
}

function authorized(req, token) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers["authorization"] || "");
  if (!m) return false;
  const provided = Buffer.from(m[1]);
  const expected = Buffer.from(token);
  // Constant-time compare; length check first (timingSafeEqual throws on length mismatch).
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function readJsonBody(req, res, cb) {
  let raw = "", bytes = 0, tooBig = false;
  // Stateful UTF-8 decode: without setEncoding, each Buffer chunk is decoded independently and a
  // multibyte character split across chunk boundaries becomes mojibake. Track the cap in BYTES
  // (the wire size), not decoded string length.
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    bytes += Buffer.byteLength(chunk);
    raw += chunk;
    if (bytes > MAX_BODY_BYTES) { tooBig = true; req.destroy(); }
  });
  req.on("end", () => {
    if (tooBig) return sendError(res, 413, "Request body too large.");
    let body;
    try { body = JSON.parse(raw); } catch { return sendError(res, 400, "Invalid JSON body."); }
    cb(body);
  });
}

// Emit the reply as a single OpenAI-compatible SSE chunk sequence. The CLI agent returns the whole
// answer at once, so this is not token-by-token streaming (true streaming is Phase 3, plan §11.2) —
// it just lets the app's existing SSE/BYO path consume a bridge reply unchanged. The app still
// splits the text into sentences and fires TTS per sentence on its side.
function sendChatSSE(res, text, model) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta, finish) => `data: ${JSON.stringify({
    id, object: "chat.completion.chunk", created, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
  res.write(chunk({ role: "assistant", content: text }, null));
  res.write(chunk({}, "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
}

function completion(text, model, audio) {
  const message = { role: "assistant", content: text };
  if (audio) message.audio = audio;
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export function startServer(cfg) {
  if (!cfg.token) {
    console.error("✖ No RIFFIN_BRIDGE_TOKEN set. Run `riffn-bridge init` to generate one and pair.");
    process.exit(1);
  }
  if (!cfg.host) {
    if (cfg.allowPublic) {
      cfg.host = "0.0.0.0";
      console.warn(
        "⚠️  No Tailscale address found; RIFFIN_BRIDGE_ALLOW_PUBLIC=1 → binding 0.0.0.0 (PUBLIC).\n" +
        "    This exposes remote code execution to your whole network. Prefer a tunnel."
      );
    } else {
      console.error("✖ No Tailscale (100.64.0.0/10) address found and RIFFIN_BRIDGE_HOST not set.");
      console.error("  Start Tailscale, or set RIFFIN_BRIDGE_HOST=<tailnet-ip|127.0.0.1>. Refusing to");
      console.error("  bind 0.0.0.0 by default (set RIFFIN_BRIDGE_ALLOW_PUBLIC=1 to override).");
      process.exit(1);
    }
  }

  // Single-flight: a bridge serves one operator. A second concurrent chat gets a clean 429 rather
  // than spawning a second agent against the same working directory (bridge_plan.md §11.3).
  let inFlight = false;

  // First-authenticated-request latch for the §10.6 QR-clear (see below).
  let firstAuthSeen = false;

  // Persistent agent session ("one thread per machine", §9 #5) — Claude-only (see agent.js).
  const session = cfg.mode === "cli" && cfg.agent === "claude"
    ? createSessionStore(cfg.envDir, cfg.cwd)
    : null;

  // Durable jobs (§13) — Claude-only (needs stream-json progress). Shares the session store so a
  // job continues the same on-machine thread as chat turns.
  const jobs = cfg.mode === "cli" && cfg.agent === "claude"
    ? createJobStore(cfg, session)
    : null;

  // DIAGNOSTIC: if a session file already exists in this launch folder for a DIFFERENT cwd, that's
  // the signature of two bridge instances sharing an envDir and colliding over one session file —
  // print it loudly rather than silently self-correcting, so a mixed-up multi-agent setup gets
  // caught at startup instead of surfacing later as a confusing cross-topic reply.
  if (session) {
    const raw = peekRawSession(cfg.envDir);
    if (raw && raw.cwd !== cfg.cwd) {
      console.warn(
        `⚠️  Found a saved session for a DIFFERENT working directory in this launch folder:\n` +
        `      this launch folder (envDir): ${cfg.envDir}\n` +
        `      saved session's cwd:         ${raw.cwd}\n` +
        `      this bridge's cwd:           ${cfg.cwd}\n` +
        `    This is safe (a fresh session starts for THIS cwd), but if you run more than one\n` +
        `    riffn-bridge, launch each from ITS OWN folder — sharing a launch folder means they\n` +
        `    fight over the same session file. See dev_resources/bridge_plan.md diagnostics.`
      );
    }
  }

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const path = new URL(req.url, `http://${cfg.host}:${cfg.port}`).pathname;
    // Redacted access log: method + path + status + ms only. No token, no query, no body.
    res.on("finish", () => log.info("req", { m: req.method, p: path, s: res.statusCode, ms: Date.now() - started }));

    // Public bare liveness — no secrets, no detail.
    if (req.method === "GET" && path === "/") {
      return send(res, 200, { status: "ok", version: VERSION });
    }

    // Everything below requires the bearer token.
    if (!authorized(req, cfg.token)) return sendError(res, 401, "Missing or invalid bearer token.");

    // First authenticated request = the phone has paired (or was already paired). Init uses this
    // to clear the QR/token from the terminal (§10.6 B3 — don't leave the secret in scrollback).
    if (!firstAuthSeen) {
      firstAuthSeen = true;
      cfg.onFirstAuthorized?.();
    }

    // Authenticated health: what the app shows on the "Link my machine" screen after pairing.
    // pid/port are safe to always include (not sensitive, no filesystem/content leak) and are the
    // fastest way to confirm — from the phone — exactly which running process answered: cross-check
    // against `riffn-bridge health` or the process's own startup banner on the machine's terminal.
    if (req.method === "GET" && path === "/health") {
      return send(res, 200, {
        status: "ok",
        version: VERSION,
        mode: cfg.mode,                                   // "cli" | "llm"
        agent: cfg.mode === "cli" ? cfg.agent : "llm-proxy",
        cwd: redactedCwd(cfg.cwd),                         // basename only — never the full path
        tts: cfg.ttsConfigured,
        // "What TTS" detail (§12 leftover): model/voice NAMES only — never the TTS URL or any
        // hostname (§10.10). Absent when TTS isn't configured.
        ttsModel: cfg.ttsConfigured ? cfg.ttsModel : undefined,
        ttsVoice: cfg.ttsConfigured ? cfg.ttsVoice : undefined,
        caps: agentCaps(cfg),                              // read-plan | operator-defined (§10.3/§12)
        sessionActive: Boolean(session?.get()),            // persistent thread already established?
        jobs: Boolean(jobs),                               // does this bridge support §13 jobs?
        notes: true,                                       // POST /v1/notes (helper-written riffn-notes/)
        job: jobs?.current() ?? null,                      // latest job's public view (or null)
        pid: process.pid,
        port: cfg.port,
      });
    }

    if (req.method === "GET" && path === "/v1/models") {
      return send(res, 200, { object: "list", data: [{ id: cfg.modelId, object: "model", owned_by: "riffn-bridge" }] });
    }

    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      if (inFlight) return sendError(res, 429, "Bridge busy — one turn at a time. Try again in a moment.");
      // Chat and jobs share ONE single-flight: both spawn `claude` against the same cwd (and may
      // --resume the same session), so a chat turn during a running job would double-run the agent —
      // exactly the §11.3/§3 collision the single-flight exists to prevent.
      if (jobs?.isRunning()) {
        return sendError(res, 429, "A task is running on this machine — chat resumes when it finishes. Ask for its status, or cancel it.");
      }
      readJsonBody(req, res, async (body) => {
        const messages = Array.isArray(body?.messages) ? body.messages : null;
        if (!messages || messages.length === 0) return sendError(res, 400, "`messages` must be a non-empty array.");
        const wantsAudio = Array.isArray(body?.modalities) ? body.modalities.includes("audio") : Boolean(body?.audio);

        // Cancel-on-disconnect: abort the agent/LLM/TTS only if the response closes BEFORE it
        // finished (a real client disconnect). res 'close' fires after a normal finish too, so we
        // gate on writableFinished. (req 'close' is wrong here — it fires once the body is read.)
        const ac = new AbortController();
        res.on("close", () => { if (!res.writableFinished) ac.abort(); });

        inFlight = true;
        try {
          const text = await generateText(cfg, messages, body?.model, ac.signal, session);
          if (res.writableEnded) return;
          // The app always requests stream:true → emit SSE so its existing streaming path consumes
          // the reply unchanged. Plain (non-stream) callers get a normal JSON completion.
          if (body?.stream === true) {
            sendChatSSE(res, text, body?.model || cfg.modelId);
            return;
          }
          let audio = null;
          if (wantsAudio && cfg.ttsConfigured) {
            const voice = body?.audio?.voice || cfg.ttsVoice;
            const format = body?.audio?.format || cfg.ttsFormat;
            try {
              const bytes = await synthesize(cfg, text, voice, format, ac.signal);
              audio = { data: bytes.toString("base64"), transcript: text, format };
            } catch (ttsErr) {
              // A broken TTS must never break the reply — return text only; the app falls back.
              log.error("tts_error_text_only", ttsErr);
            }
          }
          send(res, 200, completion(text, body?.model || cfg.modelId, audio));
        } catch (err) {
          log.error("agent_error", err);
          if (!res.writableEnded) sendError(res, 502, `Agent error (${errorType(err)}).`);
        } finally {
          inFlight = false;
        }
      });
      return;
    }

    // ── Jobs (§13): dispatch a long agent task, poll it, cancel it ──────────────────────────────
    // POST /v1/jobs        { messages } → start a job, return its id + status immediately
    // GET  /v1/jobs        → the current/latest job's status (+ result when done)
    // POST /v1/jobs/cancel → stop the running job
    if (path.startsWith("/v1/jobs")) {
      // Distinct from the plain 404 an OLD bridge (predating /v1/jobs) returns: this bridge is
      // current but its agent can't run jobs (they need Claude's stream-json progress). The app
      // maps 501 to an honest "that agent doesn't support tasks" instead of "update your bridge".
      if (!jobs) {
        return sendError(res, 501, "This bridge's agent doesn't support background tasks (tasks need Claude Code).");
      }
      if (req.method === "GET" && path === "/v1/jobs") {
        return send(res, 200, { job: jobs.current() });
      }
      // Rolling terminal-job history (§13 build #3), newest first — feeds the app's
      // "what did my tasks do today" voice surface. Redaction-safe public views only.
      if (req.method === "GET" && path === "/v1/jobs/history") {
        return send(res, 200, { jobs: jobs.history() });
      }
      if (req.method === "POST" && path === "/v1/jobs/cancel") {
        const view = jobs.cancel();
        return view ? send(res, 200, { job: view }) : send(res, 409, { error: { message: "No job is running.", type: "riffin_bridge_error" } });
      }
      if (req.method === "POST" && path === "/v1/jobs") {
        if (jobs.isRunning()) {
          return sendError(res, 409, "A job is already running. Ask for its status, or cancel it first.");
        }
        // Mirror of the chat-side guard above: one agent run at a time, whatever kind it is.
        if (inFlight) {
          return sendError(res, 409, "A chat turn is in flight on this machine — try again in a moment.");
        }
        return readJsonBody(req, res, (body) => {
          const messages = Array.isArray(body?.messages) ? body.messages : null;
          if (!messages || messages.length === 0) return sendError(res, 400, "`messages` must be a non-empty array.");
          // Flatten to a single prompt (a job is a one-shot dispatch, resumed thread aside), and pass
          // system content via --append-system-prompt exactly like chat turns.
          const prompt = messages.filter((m) => m.role !== "system")
            .map((m) => (m.role === "assistant" ? "Assistant: " : "User: ") +
              (typeof m.content === "string" ? m.content : ""))
            .join("\n\n");
          const view = jobs.start(prompt, extractSystemPrompt(messages));
          if (!view) return sendError(res, 409, "A job is already running.");
          return send(res, 202, { job: view });
        });
      }
      return sendError(res, 404, `Not found: ${req.method} ${path}`);
    }

    // ── Voice notes: POST /v1/notes { text } → 201 { note: { file } } ──────────────────────────
    // The helper writes riffn-notes/<date>-<slug>.md under cwd itself (notes.js) — no agent
    // involvement, caps stay read-plan, and no single-flight gate needed (it's just a file write,
    // safe alongside a running chat turn or job). Works in every mode, cli and llm alike.
    if (req.method === "POST" && path === "/v1/notes") {
      return readJsonBody(req, res, (body) => {
        const text = typeof body?.text === "string" ? body.text.trim() : "";
        if (!text) return sendError(res, 400, "`text` must be a non-empty string.");
        try {
          const note = saveNote(cfg, text);
          log.debug("note_saved", note.file);
          return send(res, 201, { note });
        } catch (err) {
          log.error("note_write_failed", err);
          return sendError(res, 500, "Couldn't write the note file.");
        }
      });
    }

    if (req.method === "POST" && path === "/v1/audio/speech") {
      if (!cfg.ttsConfigured) return sendError(res, 503, "No TTS configured on this helper.");
      readJsonBody(req, res, async (body) => {
        const input = typeof body?.input === "string" ? body.input : "";
        if (!input.trim()) return sendError(res, 400, "`input` (text to speak) is required.");
        const voice = body?.voice || cfg.ttsVoice;
        const format = body?.response_format || cfg.ttsFormat;
        const ac = new AbortController();
        res.on("close", () => { if (!res.writableFinished) ac.abort(); });
        try {
          const bytes = await synthesize(cfg, input, voice, format, ac.signal);
          if (!res.writableEnded) { res.writeHead(200, { "Content-Type": mimeForFormat(format) }); res.end(bytes); }
        } catch (err) {
          log.error("tts_error", err);
          if (!res.writableEnded) sendError(res, 502, `TTS error (${errorType(err)}).`);
        }
      });
      return;
    }

    sendError(res, 404, `Not found: ${req.method} ${path}`);
  });

  // Port already taken = almost certainly another riffn-bridge (they all default to 8765, and a
  // multi-agent fleet on one box is the normal case now — §12). Detect → instruct; never silently
  // move an explicitly configured port out from under an existing QR pairing.
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`✖ Port ${cfg.port} on ${cfg.host} is already in use — likely another riffn-bridge.`);
      console.error(`  Each bridge needs its own port (and its own launch folder). Either stop the other`);
      console.error(`  process, or give this one a different port:`);
      console.error(`    RIFFIN_BRIDGE_PORT=${cfg.port + 1} riffn-bridge start   (or set it in .env / re-run init)`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(cfg.port, cfg.host, () => {
    warnVerboseIfEnabled();
    const capsLabel = agentCaps(cfg) === "read-plan" ? "read/plan-only" : agentCaps(cfg);
    const agentLabel = cfg.agent === "custom" ? `custom '${cfg.customAgentBin}'` : `'${cfg.agent}'`;
    console.log(`riffn-bridge v${VERSION} listening on http://${cfg.host}:${cfg.port}  (pid ${process.pid})`);
    console.log(`  mode: ${cfg.mode === "cli" ? `CLI agent ${agentLabel}` : "HTTP LLM proxy"}   caps: ${capsLabel}`);
    const capsWarning = customAgentCapsWarning(cfg);
    if (capsWarning) console.warn(capsWarning);
    // Full, unredacted paths here are fine — this is the operator's own terminal, not the wire to
    // the phone. Printed on EVERY start (not just verbose) because "which folder is this bridge
    // actually running in / launched from" is exactly the question that's hard to answer once you
    // have more than one bridge running — see bridge_plan.md diagnostics.
    console.log(`  agent cwd: ${cfg.cwd}`);
    console.log(`  launch dir (session state lives here): ${cfg.envDir}`);
    console.log(`  tts:  ${cfg.ttsConfigured ? "configured" : "not configured — text only"}`);
    console.log(`  Model URL for Riffn:  http://${cfg.host}:${cfg.port}/v1`);
  });
  return server;
}
