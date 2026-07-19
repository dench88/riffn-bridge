// `riffn-bridge init` — the minimal Phase 1.5 onboarding wizard (bridge_plan.md §7.1).
// Detect one agent → generate a token → write .env → verify Tailscale → print the QR → run
// FOREGROUND (no service install in this cut). Read/plan-only; Tailscale-only.

import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { existsSync } from "node:fs";
import { loadEnvFile, writeEnvVar, generateToken } from "./env-file.js";
import { readConfig, resolveEditMode } from "./config.js";
import { detect, instructions, magicDNSName } from "./tailscale.js";
import { printPairing, clearPairingFromTerminal } from "./qr.js";
import { startServer } from "./server.js";
import { resolveSpawnTarget } from "./win-shim.js";

function binPresent(bin) {
  // Present if the process launched at all (error is set — e.g. ENOENT — only when it can't run).
  // A non-zero `--version` exit still counts as present. Resolve through win-shim.js first: on
  // Windows an npm-global install puts `bin` on PATH as a `.cmd` shim, which spawnSync can't
  // launch directly — this check must resolve the same way the real turn-execution spawn does,
  // or `init` would report an agent "missing" that actually runs fine (or vice versa).
  try {
    const { bin: resolvedBin, prefixArgs } = resolveSpawnTarget(bin);
    const r = spawnSync(resolvedBin, [...prefixArgs, "--version"], { timeout: 5000, stdio: "ignore" });
    return r.error === undefined;
  } catch {
    return false;
  }
}

// Detect one CLI agent. Preference: --agent flag, else an explicit RIFFIN_BRIDGE_AGENT, else
// claude, else codex. The flag exists because env-var selection proved undiscoverable — even
// the maintainer had to ask how to point a bridge at Codex (2026-07).
function detectAgent(flagAgent) {
  if (flagAgent === "claude" || flagAgent === "codex") return flagAgent;
  const explicit = (process.env.RIFFIN_BRIDGE_AGENT || "").toLowerCase();
  if (explicit === "claude" || explicit === "codex") return explicit;
  if (binPresent(process.env.RIFFIN_BRIDGE_CLAUDE_BIN || "claude")) return "claude";
  if (binPresent(process.env.RIFFIN_BRIDGE_CODEX_BIN || "codex")) return "codex";
  return null;
}

// Parse `--agent <name>` / `--agent=<name>` from argv. Returns lowercased value or null.
// Exits loudly on an unsupported value — a typo silently falling back to detection would
// pair the phone to the wrong agent.
function parseAgentFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    let value = null;
    if (argv[i] === "--agent") value = argv[i + 1] ?? "";
    else if (argv[i].startsWith("--agent=")) value = argv[i].slice("--agent=".length);
    if (value === null) continue;
    const agent = value.toLowerCase();
    if (agent !== "claude" && agent !== "codex") {
      console.error(`✖ Unsupported --agent '${value}' (expected 'claude' or 'codex').`);
      console.error("  For any other CLI, set RIFFIN_BRIDGE_AGENT=custom with RIFFIN_BRIDGE_AGENT_BIN/_ARGS.");
      process.exit(1);
    }
    return agent;
  }
  return null;
}

// Parse `--edit-mode <tier>` / `--edit-mode=<tier>` (edit_mode_plan.md). Skips the interactive
// 3-way prompt; the ungated typed acknowledgement is NEVER skipped (see the 2b block). Exits
// loudly on an unsupported value — same fail-closed posture as --agent (a typo must not fall
// through to a prompt the operator thinks they already answered). Deprecated spellings are
// rejected here rather than aliased: the flag is new, so there's no muscle memory to honor.
function parseEditModeFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    let value = null;
    if (argv[i] === "--edit-mode") value = argv[i + 1] ?? "";
    else if (argv[i].startsWith("--edit-mode=")) value = argv[i].slice("--edit-mode=".length);
    if (value === null) continue;
    const mode = value.toLowerCase();
    if (!["disabled", "limited", "ungated"].includes(mode)) {
      console.error(`✖ Unsupported --edit-mode '${value}' (expected 'disabled', 'limited', or 'ungated').`);
      process.exit(1);
    }
    return mode;
  }
  return null;
}

// Probe up to 10 ports starting at `startPort` and return the first that binds on `host`.
// Exported for init-llm.js (the `init --llm` wizard shares the port/prompt plumbing).
export function findFreePort(host, startPort) {
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

export function ask(question, def) {
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
  // `init --llm [url]` / `init --openclaw` — the Custom Agents wizard (custom_agents_plan.md
  // "One-click linking") lives in its own module; everything below is the coding-agent path.
  if (argv.includes("--openclaw") || argv.some((a) => a === "--llm" || a.startsWith("--llm="))) {
    const { runInitLLM } = await import("./init-llm.js");
    return runInitLLM(argv);
  }

  const yes = argv.includes("--yes") || argv.includes("-y");
  const envPath = path.join(process.cwd(), ".env");
  loadEnvFile(envPath);

  console.log("\nriffn-bridge init — link this machine to Riffn (read/plan-only, Tailscale).\n");

  // 1. Agent — `--agent codex` overrides detection (and persists, so plain `start` keeps it).
  const flagAgent = parseAgentFlag(argv);
  const agent = detectAgent(flagAgent);
  if (!agent) {
    console.error("✖ No agent found. Install Claude Code (`claude`) or Codex (`codex`) and re-run.");
    console.error("  (Local-LLM/TTS proxy mode is a later phase; this cut drives a CLI agent.)");
    process.exit(1);
  }
  if (flagAgent && !binPresent(flagAgent === "claude" ? (process.env.RIFFIN_BRIDGE_CLAUDE_BIN || "claude") : (process.env.RIFFIN_BRIDGE_CODEX_BIN || "codex"))) {
    console.error(`✖ --agent ${flagAgent} requested but the '${flagAgent}' CLI isn't on PATH.`);
    process.exit(1);
  }
  console.log(flagAgent ? `✓ Agent (from --agent): ${agent}` : `✓ Detected agent: ${agent}`);
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

  // 2b. Edit mode (edit_mode_plan.md) — the workstation half of the arming; the phone's spoken
  // confirm (limited tier) is the other half. NEVER escalated silently: `--yes` and non-TTY runs
  // keep the existing value AND SAY SO (the silent skip bit a real operator once, 2026-07-16);
  // choosing ungated requires typing an exact acknowledgement, and a botched attempt lands on
  // disabled — never on a middle tier the operator didn't pick.
  {
    const current = resolveEditMode(process.env, agent);
    const flagMode = parseEditModeFlag(argv);
    let editMode = current;
    if (flagMode !== null) {
      editMode = flagMode;
    } else if (!yes && process.stdin.isTTY) {
      console.log(
        "\nEdit capability for this bridge:\n" +
        "  1) disabled — read/plan-only (recommended default)\n" +
        "  2) limited  — chat stays read-only; a voice-confirmed task (\"execute the plan\") may\n" +
        "                edit files, snapshotted first" + (agent === "claude" ? "" : " (Claude only — arms nothing on this agent)") + "\n" +
        "  3) ungated  — the confirmation gate is OFF: any message may edit files immediately"
      );
      const def = current === "ungated" ? "3" : current === "limited" ? "2" : "1";
      const choice = ((await ask("Choice (1/2/3)", def)) || "").trim();
      editMode = choice === "3" ? "ungated" : choice === "2" ? "limited" : "disabled";
    } else {
      console.log(`(non-interactive: keeping existing edit-mode '${current}')`);
    }
    // The ungated acknowledgement is NEVER skipped — not by --edit-mode, not by --yes. Arming
    // the most permissive tier requires a human typing the exact phrase at this terminal; a
    // non-TTY/scripted run requesting ungated keeps the EXISTING mode (loudly) rather than
    // either arming silently or downgrading a setting the operator already confirmed once.
    if (editMode === "ungated" && current !== "ungated") {
      if (!process.stdin.isTTY) {
        console.warn("⚠️  --edit-mode ungated needs an interactive terminal for the typed acknowledgement —");
        console.warn(`    keeping existing edit-mode '${current}'. Re-run init in a real terminal to enable it.`);
        editMode = current;
      } else {
        console.log(
          "\n⚠️  UNGATED means every message from a paired phone can edit files in this repo — no\n" +
          "    per-task confirmation, no \"execute the plan\" gate. Anyone holding your phone, or\n" +
          "    anyone who obtains a leaked pairing token, can modify code here at will." +
          (agent === "codex"
            ? "\n    On Codex this also means SANDBOXED SHELL: model-run commands execute, contained\n" +
              "    to the working directory. No automatic snapshots — rely on your own git discipline."
            : "\n    Command execution and git stay denied. Every write-capable turn snapshots the repo\n" +
              "    first (refs/riffn/ring-*, last ~20 kept).")
        );
        const ack = ((await ask('Type "yes i understand" to enable, anything else to cancel', "")) || "").trim().toLowerCase();
        if (ack !== "yes i understand") {
          editMode = "disabled";
          console.log("✓ Not enabled — edit mode set to disabled.");
        }
      }
    }
    writeEnvVar(envPath, "RIFFIN_BRIDGE_EDIT_MODE", editMode);
    // Agent stamp (review finding #7): the mode was chosen FOR this agent; a hand-edited agent
    // switch degrades to disabled until re-confirmed here (see readConfig's mismatch check).
    writeEnvVar(envPath, "RIFFIN_BRIDGE_EDIT_MODE_AGENT", agent);
    // Keep the legacy boolean in sync so an older bridge build reading this .env agrees.
    writeEnvVar(envPath, "RIFFIN_BRIDGE_ALLOW_EDIT_JOBS", editMode === "disabled" ? "0" : "1");
    process.env.RIFFIN_BRIDGE_EDIT_MODE = editMode;
    process.env.RIFFIN_BRIDGE_EDIT_MODE_AGENT = agent;
    process.env.RIFFIN_BRIDGE_ALLOW_EDIT_JOBS = editMode === "disabled" ? "0" : "1";
    const label = editMode === "ungated" ? "UNGATED — any turn may edit files"
      : editMode === "limited" ? "limited (voice-confirmed edit tasks)"
      : "disabled (read/plan-only)";
    console.log(`✓ Edit mode: ${label} (saved to .env — RIFFIN_BRIDGE_EDIT_MODE).`);
    if (editMode !== "disabled" && agent === "claude") {
      // Snapshots refuse to run outside a git repo — surface that now, not mid-commute.
      const inRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8" });
      if (inRepo.error || inRepo.status !== 0 || inRepo.stdout.trim() !== "true") {
        console.warn(
          "⚠️  The working directory is NOT a git repository (or git isn't installed). Write-capable\n" +
          "    turns/tasks will be refused there — the pre-write snapshot has nowhere to go. Run\n" +
          "    `git init` or pick a repo directory if you want edits to actually run."
        );
      }
    }
  }

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
