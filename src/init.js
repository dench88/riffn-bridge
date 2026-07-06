// `riffn-bridge init` — the minimal Phase 1.5 onboarding wizard (bridge_plan.md §7.1).
// Detect one agent → generate a token → write .env → verify Tailscale → print the QR → run
// FOREGROUND (no service install in this cut). Read/plan-only; Tailscale-only.

import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { existsSync } from "node:fs";
import { loadEnvFile, writeEnvVar, generateToken } from "./env-file.js";
import { readConfig } from "./config.js";
import { detect, instructions, magicDNSName } from "./tailscale.js";
import { printPairing, clearPairingFromTerminal } from "./qr.js";
import { startServer } from "./server.js";

function binPresent(bin) {
  // Present if the process launched at all (error is set — e.g. ENOENT — only when it can't run).
  // A non-zero `--version` exit still counts as present.
  try {
    const r = spawnSync(bin, ["--version"], { timeout: 5000, stdio: "ignore" });
    return r.error === undefined;
  } catch {
    return false;
  }
}

// Detect one CLI agent. Preference: an explicit RIFFIN_BRIDGE_AGENT, else claude, else codex.
function detectAgent() {
  const explicit = (process.env.RIFFIN_BRIDGE_AGENT || "").toLowerCase();
  if (explicit === "claude" || explicit === "codex") return explicit;
  if (binPresent(process.env.RIFFIN_BRIDGE_CLAUDE_BIN || "claude")) return "claude";
  if (binPresent(process.env.RIFFIN_BRIDGE_CODEX_BIN || "codex")) return "codex";
  return null;
}

// Probe up to 10 ports starting at `startPort` and return the first that binds on `host`.
function findFreePort(host, startPort) {
  const tryPort = (port) => new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
  return (async () => {
    for (let port = startPort; port < startPort + 10; port++) {
      if (await tryPort(port)) return port;
    }
    return null;
  })();
}

function ask(question, def) {
  if (!process.stdin.isTTY) return Promise.resolve(def); // non-interactive → accept defaults
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question}${def ? ` [${def}]` : ""}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || def);
    });
  });
}

export async function runInit(argv) {
  const yes = argv.includes("--yes") || argv.includes("-y");
  const envPath = path.join(process.cwd(), ".env");
  loadEnvFile(envPath);

  console.log("\nriffn-bridge init — link this machine to Riffn (read/plan-only, Tailscale).\n");

  // 1. Agent
  const agent = detectAgent();
  if (!agent) {
    console.error("✖ No agent found. Install Claude Code (`claude`) or Codex (`codex`) and re-run.");
    console.error("  (Local-LLM/TTS proxy mode is a later phase; this cut drives a CLI agent.)");
    process.exit(1);
  }
  console.log(`✓ Detected agent: ${agent}`);
  writeEnvVar(envPath, "RIFFIN_BRIDGE_AGENT", agent);

  // 2. Working directory the agent operates in
  const defaultCwd = process.env.RIFFIN_BRIDGE_CWD || process.cwd();
  const cwd = yes ? defaultCwd : await ask("Working directory for the agent", defaultCwd);
  if (!existsSync(cwd)) {
    console.error(`✖ Directory does not exist: ${cwd}`);
    process.exit(1);
  }
  writeEnvVar(envPath, "RIFFIN_BRIDGE_CWD", cwd);
  console.log(`✓ Working directory: ${cwd}`);

  // 3. Token (keep an existing one; otherwise generate + persist)
  let token = process.env.RIFFIN_BRIDGE_TOKEN;
  if (!token) {
    token = generateToken();
    writeEnvVar(envPath, "RIFFIN_BRIDGE_TOKEN", token);
    console.log("✓ Generated a new bearer token (saved to .env).");
  } else {
    console.log("✓ Using the existing bearer token from .env.");
  }

  // 4. Tailscale: detect → instruct → verify. We never run privileged commands.
  const ts = detect();
  if (ts.state !== "up") {
    console.log("\n⚠️  Not ready to pair yet:\n");
    for (const line of instructions(ts.state)) console.log(`   ${line}`);
    console.log("");
    process.exit(ts.state === "missing" ? 2 : 3);
  }
  console.log(`✓ Tailscale is up (${ts.ip}).`);

  // 5. Reload config with everything written, print pairing QR, and run foreground.
  loadEnvFile(envPath); // no-op for already-set keys; ensures token/cwd/agent are in env
  process.env.RIFFIN_BRIDGE_TOKEN = token;
  process.env.RIFFIN_BRIDGE_CWD = cwd;
  process.env.RIFFIN_BRIDGE_AGENT = agent;
  const cfg = readConfig();
  cfg.host = cfg.host || ts.ip; // bind to the numeric tailnet IP

  // 5b. Port: a multi-agent fleet on one box is the normal case (§12), and every bridge defaults
  // to 8765 — so probe for a free port and PERSIST it (the QR/pairing URL must stay stable across
  // restarts; a port that silently moved would strand the paired phone). init generating its own
  // config is safe to automate; `start` with an explicitly busy port still fails loudly instead.
  const freePort = await findFreePort(cfg.host, cfg.port);
  if (freePort === null) {
    console.error(`✖ No free port found near ${cfg.port} on ${cfg.host}. Stop an old bridge or set RIFFIN_BRIDGE_PORT.`);
    process.exit(1);
  }
  if (freePort !== cfg.port) {
    console.log(`✓ Port ${cfg.port} is busy (another bridge?) — using ${freePort} instead (saved to .env).`);
    cfg.port = freePort;
  }
  writeEnvVar(envPath, "RIFFIN_BRIDGE_PORT", String(cfg.port));
  process.env.RIFFIN_BRIDGE_PORT = String(cfg.port);

  // The pairing URL must use the MagicDNS hostname, NOT the raw 100.x IP: iOS App Transport Security
  // only permits cleartext HTTP to `.ts.net` hostnames. Fall back to the IP with a warning.
  const dns = magicDNSName();
  const urlHost = dns || cfg.host;
  const url = `http://${urlHost}:${cfg.port}/v1`;
  if (!dns) {
    console.log(
      "⚠️  Couldn't determine this machine's .ts.net hostname, so the pairing URL uses the raw\n" +
      "    Tailscale IP. iOS may refuse a plain-HTTP connection to an IP — if pairing fails, front\n" +
      "    the bridge with `tailscale serve` (HTTPS) or use the machine's .ts.net hostname.\n"
    );
  }
  printPairing(url, token);

  // §10.6 B3 — the QR/token must NOT sit in terminal scrollback forever. Clear it on the first
  // authenticated request (pair confirmed — or an already-paired phone checking in, at which
  // point the QR is redundant anyway), or after 5 minutes unused. Display lifetime only: the
  // token stays valid either way. Re-run `init` for a fresh QR; `riffn-bridge rotate` to
  // actually invalidate it.
  const afterClearStatus =
    `riffn-bridge listening on http://${cfg.host}:${cfg.port}  (pid ${process.pid})\n` +
    `  agent cwd: ${cfg.cwd}\n` +
    `  Press Ctrl-C to stop.`;
  let qrTimeout = setTimeout(() => {
    qrTimeout = null;
    clearPairingFromTerminal(
      "⏱  Pairing QR cleared after 5 minutes unused. The token is unchanged — re-run" +
      " `riffn-bridge init` for a fresh QR, or `riffn-bridge rotate` to invalidate it.\n\n" +
      afterClearStatus
    );
  }, 5 * 60_000);
  cfg.onFirstAuthorized = () => {
    if (qrTimeout) { clearTimeout(qrTimeout); qrTimeout = null; }
    clearPairingFromTerminal("✓ Phone connected — pairing QR cleared from the terminal.\n\n" + afterClearStatus);
  };

  console.log("Starting the bridge in the foreground. Press Ctrl-C to stop.\n");
  startServer(cfg);
}
