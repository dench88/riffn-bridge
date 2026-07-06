#!/usr/bin/env node
// riffn-bridge — voice-drive your OWN agents/models from Riffn, over your own machine.
//
// An OpenAI-compatible HTTP shim over a local CLI agent (Claude Code `claude -p`, or Codex), or an
// HTTP LLM proxy. Riffn already speaks OpenAI-compatible HTTP to a pasted Model URL over Tailscale,
// so pointing Riffn at this helper lets you talk to the agent on your OWN machine — no app changes,
// no worker changes, no deploy. See dev_resources/bridge_plan.md.
//
// Commands:
//   riffn-bridge init        Interactive setup: detect agent, generate token, verify Tailscale,
//                            print the pairing QR, and run in the foreground. (Phase 1.5 cut.)
//   riffn-bridge start       Start the bridge using existing .env / environment.
//   riffn-bridge rotate      Generate a new bearer token (invalidates the old QR/token).
//   riffn-bridge reset-session  Clear the persistent agent session (start a fresh thread).
//   riffn-bridge health      Print the effective config (redacted) without starting the server.
//   riffn-bridge help        Show this help.
//
// Security posture (v1): READ/PLAN-ONLY agent, tailnet-only bind, bearer token, argument-array exec,
// single-flight, redact-by-default logs. Zero runtime dependencies (Node 18+ built-ins only).

import path from "node:path";
import { loadEnvFile, rotateToken } from "./src/env-file.js";

const envPath = path.join(process.cwd(), ".env");
const [cmd, ...rest] = process.argv.slice(2);

async function main() {
  switch ((cmd || "start").toLowerCase()) {
    case "init": {
      const { runInit } = await import("./src/init.js");
      await runInit(rest);
      break;
    }
    case "start": {
      loadEnvFile(envPath);
      const { readConfig } = await import("./src/config.js");
      const { startServer } = await import("./src/server.js");
      startServer(readConfig());
      break;
    }
    case "rotate": {
      loadEnvFile(envPath);
      // Deliberately NOT echoed to the terminal (§10.6: the token must never sit in scrollback;
      // that's the exact exposure rotate exists to fix). It's saved to .env; pairing happens via
      // the QR, which encodes it without displaying it.
      rotateToken(envPath);
      console.log("✓ New bearer token generated and saved to .env (not shown — see .env if you truly need it).");
      console.log("  Re-pair Riffn (the previous token/QR no longer works). Get a fresh QR with:");
      console.log("    riffn-bridge init");
      break;
    }
    case "health": {
      loadEnvFile(envPath);
      const { readConfig, redactedCwd, VERSION } = await import("./src/config.js");
      const { createSessionStore } = await import("./src/session.js");
      const { agentCaps } = await import("./src/agent.js");
      const cfg = readConfig();
      const session = cfg.mode === "cli" && cfg.agent === "claude"
        ? createSessionStore(cfg.envDir, cfg.cwd)
        : null;
      console.log(JSON.stringify({
        version: VERSION,
        mode: cfg.mode,
        agent: cfg.mode === "cli" ? cfg.agent : "llm-proxy",
        cwd: redactedCwd(cfg.cwd),
        host: cfg.host || "(no tailnet address)",
        port: cfg.port,
        tts: cfg.ttsConfigured,
        tokenSet: Boolean(cfg.token),
        // Same honesty rule as the HTTP /health: custom agents are operator-defined, not read-plan.
        caps: agentCaps(cfg),
        sessionActive: Boolean(session?.get()),
      }, null, 2));
      break;
    }
    case "reset-session": {
      loadEnvFile(envPath);
      const { readConfig } = await import("./src/config.js");
      const { createSessionStore } = await import("./src/session.js");
      const cfg = readConfig();
      createSessionStore(cfg.envDir, cfg.cwd).clear();
      console.log("✓ Cleared the persistent agent session. The next turn starts a fresh thread.");
      break;
    }
    case "help":
    case "-h":
    case "--help":
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      printHelp();
      process.exit(1);
  }
}

function printHelp() {
  console.log(`riffn-bridge — link Riffn to your own agent/model over Tailscale (read/plan-only).

Usage:
  riffn-bridge init        Setup wizard: detect agent, token, verify Tailscale, print QR, run.
  riffn-bridge start       Start using existing .env / environment.
  riffn-bridge rotate      New bearer token (invalidates the old QR).
  riffn-bridge reset-session  Clear the persistent agent session (fresh thread next turn).
  riffn-bridge health      Print effective config (redacted), don't start.
  riffn-bridge help        This help.

Docs: dev_resources/bridge_plan.md`);
}

main().catch((err) => {
  console.error(`✖ ${err?.message || err}`);
  process.exit(1);
});
