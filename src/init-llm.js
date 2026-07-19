// `riffn-bridge init --llm` / `init --openclaw` — one-command Custom Agents linking
// (custom_agents_plan.md, "One-click linking" + "UX surface" sections). Shapes:
//
//   init --llm                 Probe local Ollama, multi-select models, run the Mode B proxy. (UC1/UC2)
//   init --llm <url>           Front any OpenAI-compatible endpoint with the proxy.           (UC3)
//   init --openclaw            OpenClaw adapter: consent-enable its chat endpoint, proxy it.  (UC4)
//   ... --link-only            Print a QR pointing DIRECTLY at the target and exit — no proxy
//                              process, nothing persisted. Needs a phone-reachable target.
//
// PROXY MODE IS THE DEFAULT everywhere because it solves the three first-link killers at once:
// the bridge generates the bearer token (the user never mints one), the bridge binds the tailnet
// IP (Ollama/OpenClaw stay loopback-only — no OLLAMA_HOST/bind surgery), and /health keeps
// working for the app's status checks. For OpenClaw the proxy ALSO keeps the gateway token — an
// owner-level credential per their docs — on this machine; the phone only ever holds the
// bridge's own token.
//
// RIFFIN_BRIDGE_LLM_MODEL is deliberately NEVER written here: leaving it unset makes Mode B pass
// the phone's requested model through (agent.js: `cfg.llmModel || requestedModel`), so ONE
// bridge serves every entry in a multi-entry QR — model strings are opaque routing selectors
// (a real Ollama model id, an ignored placeholder for a custom harness, or `openclaw/<agentId>`).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvFile, writeEnvVar, generateToken } from "./env-file.js";
import { readConfig } from "./config.js";
import { detect, instructions, magicDNSName } from "./tailscale.js";
import { printPairing, pairingPayloadLLM, clearPairingFromTerminal } from "./qr.js";
import { startServer } from "./server.js";
import { ask, findFreePort } from "./init.js";

const OLLAMA_DEFAULT = "http://127.0.0.1:11434";
const OPENCLAW_DEFAULT_PORT = 18789;

// ── Small pure helpers (exported for tests) ─────────────────────────────────────────────────

// Mirror of the app's SettingsStore.bridgeChatURL normalization: bare host:port (or /v1) gets
// /v1/chat/completions appended; a URL that already ends in /chat/completions is left alone; any
// other path gets /chat/completions appended (a harness serving a nonstandard prefix).
export function normalizeChatURL(raw) {
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const p = u.pathname;
  if (p === "" || p === "/" || p === "/v1" || p === "/v1/") u.pathname = "/v1/chat/completions";
  else if (!p.endsWith("/chat/completions")) u.pathname = p.replace(/\/$/, "") + "/chat/completions";
  return u;
}

// "strategy-coach:latest" → "Strategy Coach", "gpt-oss:20b" → "Gpt Oss 20b",
// "huihui_ai/glm-4.7-flash-abliterated:q4_K" → "Glm 4.7 Flash Abliterated Q4 K".
// Only a DEFAULT — every name stays editable on the phone, and the pairing sheet says so.
export function prettyName(model) {
  let s = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  s = s.replace(/:latest$/, "").replace(/[:_-]+/g, " ").trim();
  if (!s) return model;
  return s
    .split(/\s+/)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

// Parse "1,3" / "1 3" / "a"/"all"/"" (= all) against a list length. Returns 0-based indices,
// or null on anything unparseable — the caller re-asks rather than guessing.
export function parseSelection(text, count) {
  const t = (text || "").trim().toLowerCase();
  if (t === "" || t === "a" || t === "all") return Array.from({ length: count }, (_, i) => i);
  const picked = new Set();
  for (const part of t.split(/[\s,]+/).filter(Boolean)) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > count) return null;
    picked.add(n - 1);
  }
  return picked.size ? [...picked].sort((x, y) => x - y) : null;
}

// ── Reachability (best-effort, never hard-blocks) ───────────────────────────────────────────

// Same posture as the app's probeReachable: any HTTP response counts (404/405 from a chat path
// is fine — plenty of OpenAI-compatible servers reject HEAD yet answer POST); only a network
// error means unreachable.
async function probeReachable(chatURL) {
  try {
    await fetch(chatURL, { method: "HEAD", signal: AbortSignal.timeout(4000) });
    return true;
  } catch {
    /* fall through to a root GET */
  }
  try {
    await fetch(new URL("/", chatURL), { signal: AbortSignal.timeout(4000) });
    return true;
  } catch {
    return false;
  }
}

function isLoopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

// ── Target resolvers: each returns { chatURL, key, entries, label } ─────────────────────────

function parseLLMURL(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--llm") {
      const next = argv[i + 1];
      return next && !next.startsWith("-") ? next : null;
    }
    if (argv[i].startsWith("--llm=")) return argv[i].slice("--llm=".length) || null;
  }
  return null;
}

// UC3: any OpenAI-compatible endpoint the user points at (their own harness, LM Studio, …).
async function resolveExplicitURL(rawURL, yes) {
  const chatURL = normalizeChatURL(rawURL);
  if (!chatURL) {
    console.error(`✖ '${rawURL}' isn't a valid http(s) URL.`);
    process.exit(1);
  }
  console.log(`✓ Target endpoint: ${chatURL.href}`);
  if (!(await probeReachable(chatURL.href))) {
    console.log("⚠️  Couldn't reach that URL from this machine (it may still answer chat requests).");
    const goOn = yes ? "y" : await ask("Continue anyway? (y/N)", "N");
    if (!/^y/i.test(goOn)) process.exit(1);
  }
  const defName = prettyName(chatURL.hostname.split(".")[0] || "Custom Agent");
  const name = yes ? defName : await ask("Name for this agent (you'll say “switch to <name>”)", defName);
  // Opaque routing selector — many harnesses ignore it entirely, but the app requires it non-empty.
  const model = yes ? "default" : await ask("Model string to send (many custom agents ignore this)", "default");
  return { chatURL, key: "", entries: [{ name, model }], label: chatURL.host };
}

// UC1/UC2: probe local Ollama and let the user pick which installed models go on the phone.
// Modelfile persona agents show up here too — they ARE Ollama models.
async function resolveOllama(yes) {
  const base = process.env.RIFFIN_BRIDGE_OLLAMA_URL || OLLAMA_DEFAULT;
  let tags;
  try {
    const resp = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
    tags = await resp.json();
  } catch {
    console.error(`✖ No Ollama found at ${base} (GET /api/tags failed).`);
    console.error("   • Ollama on another port/host: set RIFFIN_BRIDGE_OLLAMA_URL and re-run.");
    console.error("   • Not Ollama at all (your own agent server, LM Studio, …): riffn-bridge init --llm <url>");
    process.exit(1);
  }
  const all = Array.isArray(tags?.models) ? tags.models : [];
  // Dedupe by digest: `gpt-oss:latest` and `gpt-oss:20b` can be the SAME blob under two names —
  // offering both would mint two roster entries for one model.
  const seen = new Set();
  const models = all.filter((m) => {
    const d = m?.digest || m?.name;
    if (!m?.name || seen.has(d)) return false;
    seen.add(d);
    return true;
  });
  if (!models.length) {
    console.error(`✖ Ollama at ${base} has no models. Pull one first (e.g. \`ollama pull llama3.2\`).`);
    process.exit(1);
  }

  console.log(`✓ Found Ollama at ${base} with ${models.length} model${models.length === 1 ? "" : "s"}:\n`);
  models.forEach((m, i) => console.log(`   ${i + 1}. ${m.name}`));
  console.log("");

  let indices = null;
  while (indices === null) {
    const answer = yes ? "a" : await ask("Which go on your phone? (numbers like 1,3 — or Enter for all)", "a");
    indices = parseSelection(answer, models.length);
    if (indices === null) console.log("   Didn't catch that — numbers between 1 and " + models.length
      + ", comma-separated, or Enter for all.");
  }

  const entries = [];
  for (const i of indices) {
    const def = prettyName(models[i].name);
    const name = yes ? def : await ask(`Name for ${models[i].name} (you'll say “switch to <name>”)`, def);
    entries.push({ name, model: models[i].name });
  }
  return { chatURL: normalizeChatURL(base), key: "", entries, label: "Ollama" };
}

// UC4: OpenClaw. Reads ~/.openclaw/openclaw.json, asks consent before enabling the (default-off)
// chat-completions endpoint — the gateway hot-reloads its config, so no restart — and collects
// the gateway token + agent ids. Schema handling is deliberately defensive: agents often live
// behind a `$include`, token behind `${ENV_VAR}` substitution, so every lookup has an ask()
// fallback instead of a hard failure.
async function resolveOpenClaw(yes) {
  const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  if (!existsSync(cfgPath)) {
    console.error(`✖ No OpenClaw config found at ${cfgPath}.`);
    process.exit(1);
  }
  let oc;
  try {
    oc = JSON.parse(readFileSync(cfgPath, "utf8"));
  } catch {
    console.error(`✖ Couldn't parse ${cfgPath} as JSON (comments/JSON5 aren't supported by this helper).`);
    console.error("   Enable gateway.http.endpoints.chatCompletions.enabled yourself, then re-run with --llm <url>.");
    process.exit(1);
  }

  if (oc.gateway?.http?.endpoints?.chatCompletions?.enabled !== true) {
    console.log("OpenClaw's OpenAI chat endpoint is disabled (its shipped default).");
    const consent = yes ? "y" : await ask("Enable it in openclaw.json now? (y/N)", "N");
    if (!/^y/i.test(consent)) {
      console.log("Left disabled. Enable gateway.http.endpoints.chatCompletions.enabled and re-run.");
      process.exit(0);
    }
    oc.gateway = oc.gateway || {};
    oc.gateway.http = oc.gateway.http || {};
    oc.gateway.http.endpoints = oc.gateway.http.endpoints || {};
    oc.gateway.http.endpoints.chatCompletions = {
      ...(oc.gateway.http.endpoints.chatCompletions || {}),
      enabled: true,
    };
    writeFileSync(cfgPath, JSON.stringify(oc, null, 2) + "\n");
    console.log("✓ Enabled. (OpenClaw hot-reloads its config — no restart needed.)");
  } else {
    console.log("✓ OpenClaw's chat endpoint is already enabled.");
  }

  // Gateway token — an OWNER-level credential per OpenClaw's docs. `${VAR}` indirection resolved
  // from this process's environment; auth mode "none" legitimately means no token.
  let key = typeof oc.gateway?.auth?.token === "string" ? oc.gateway.auth.token : "";
  const env = /^\$\{(\w+)\}$/.exec(key);
  if (env) key = process.env[env[1]] || "";
  if (!key && oc.gateway?.auth?.mode !== "none") {
    key = await ask("OpenClaw gateway token (from gateway.auth in openclaw.json; blank if none)", "");
  }

  const port = Number(oc.gateway?.port) || OPENCLAW_DEFAULT_PORT;
  const chatURL = new URL(`http://127.0.0.1:${port}/v1/chat/completions`);

  // Agent ids → one roster entry each, routed via the model string (openclaw/<agentId>). The
  // config's agents section is frequently a `$include`, so enumeration is best-effort + confirm.
  let ids = [];
  const agents = oc.agents;
  if (Array.isArray(agents)) ids = agents.map((a) => a?.id).filter(Boolean);
  else if (agents && typeof agents === "object" && !agents.$include) {
    ids = Object.keys(agents).filter((k) => k !== "defaults" && k !== "$include");
  }
  const idText = yes ? ids.join(",") : await ask("OpenClaw agent ids to link (comma-separated; blank = default agent only)", ids.join(","));
  const entries = [{ name: "OpenClaw", model: "openclaw/default" }];
  for (const id of (idText || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (id === "default") continue;
    entries.push({ name: prettyName(id), model: `openclaw/${id}` });
  }

  console.log(
    "\n⚠️  OpenClaw treats its gateway token as an owner-level credential. Proxy mode (the\n" +
    "    default) keeps it on this machine — your phone only receives this bridge's own token.\n"
  );
  return { chatURL, key, entries, label: "OpenClaw" };
}

// ── The two exits: run the Mode B proxy (default), or print a direct link-only QR ───────────

async function runProxy(target, envPath, yes) {
  // Converting a coding-agent bridge in place would strand the phone profile paired to this
  // directory (same port, different behavior) — make that explicit instead of silent.
  if (existsSync(envPath) && process.env.RIFFIN_BRIDGE_AGENT && !process.env.RIFFIN_BRIDGE_LLM_URL) {
    console.log("⚠️  This directory's .env already configures a coding-agent bridge. Adding an LLM URL");
    console.log("    CONVERTS it — the coding-agent pairing that used this directory stops working.");
    const goOn = yes ? "y" : await ask("Convert this directory's bridge to an LLM proxy? (y/N)", "N");
    if (!/^y/i.test(goOn)) {
      console.log("Aborted. Run `riffn-bridge init --llm` from a different directory to keep both.");
      process.exit(0);
    }
  }

  // Bearer token: keep an existing one, else generate — identical to the coding-agent init.
  let token = process.env.RIFFIN_BRIDGE_TOKEN;
  if (!token) {
    token = generateToken();
    writeEnvVar(envPath, "RIFFIN_BRIDGE_TOKEN", token);
    console.log("✓ Generated a new bearer token (saved to .env).");
  } else {
    console.log("✓ Using the existing bearer token from .env.");
  }

  const ts = detect();
  if (ts.state !== "up") {
    console.log("\n⚠️  Not ready to pair yet:\n");
    for (const line of instructions(ts.state)) console.log(`   ${line}`);
    console.log("");
    process.exit(ts.state === "missing" ? 2 : 3);
  }
  console.log(`✓ Tailscale is up (${ts.ip}).`);

  writeEnvVar(envPath, "RIFFIN_BRIDGE_LLM_URL", target.chatURL.href);
  process.env.RIFFIN_BRIDGE_LLM_URL = target.chatURL.href;
  if (target.key) {
    writeEnvVar(envPath, "RIFFIN_BRIDGE_LLM_KEY", target.key);
    process.env.RIFFIN_BRIDGE_LLM_KEY = target.key;
  }
  process.env.RIFFIN_BRIDGE_TOKEN = token;

  const cfg = readConfig();
  cfg.host = cfg.host || ts.ip;

  // Same stable-port contract as the coding-agent init: probe near the default and PERSIST, so
  // the pairing URL survives restarts (a silently moved port would strand the paired phone).
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

  // MagicDNS hostname, not the raw 100.x IP — iOS ATS only permits cleartext HTTP to .ts.net.
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

  const names = target.entries.map((e) => e.name).join(", ");
  console.log(`✓ Linking ${target.entries.length} agent${target.entries.length === 1 ? "" : "s"}: ${names}\n`);
  printPairing(url, token, {
    payload: pairingPayloadLLM(url, token, target.entries),
    screen: "My Custom Agents",
    tokenNote:
      "⚠️  This token grants chat access to the models behind this bridge — treat it like a password.\n" +
      "    Don’t screenshot, paste, or commit it. Rotate any time with:  riffn-bridge rotate",
  });

  // Same QR display-lifetime rules as the coding-agent init (§10.6 B3): clear on first
  // authenticated request, or after 5 minutes unused. The token stays valid either way.
  const afterClearStatus =
    `riffn-bridge listening on http://${cfg.host}:${cfg.port}  (pid ${process.pid})\n` +
    `  LLM proxy → ${target.chatURL.href}\n` +
    `  Press Ctrl-C to stop.`;
  let qrTimeout = setTimeout(() => {
    qrTimeout = null;
    clearPairingFromTerminal(
      "⏱  Pairing QR cleared after 5 minutes unused. The token is unchanged — re-run" +
      " `riffn-bridge init --llm` for a fresh QR, or `riffn-bridge rotate` to invalidate it.\n\n" +
      afterClearStatus
    );
  }, 5 * 60_000);
  cfg.onFirstAuthorized = () => {
    if (qrTimeout) {
      clearTimeout(qrTimeout);
      qrTimeout = null;
    }
    clearPairingFromTerminal("✓ Phone connected — pairing QR cleared from the terminal.\n\n" + afterClearStatus);
  };

  console.log(`Starting the LLM proxy (→ ${target.chatURL.href}) in the foreground. Press Ctrl-C to stop.`);
  console.log(
    "Tip: your phone can only reach this while it's running. Keep it alive in tmux, or as a\n" +
    "     systemd service running `riffn-bridge start` in THIS folder — pairing survives\n" +
    "     restarts (`start` reuses the saved token/port; `init` is only for pairing).\n"
  );
  startServer(cfg);
}

// Link-only: stateless QR generator — nothing persisted, no process left running. The phone
// talks STRAIGHT to the target, so the target must be reachable from the phone (tailnet) and
// must be listening on that interface — the exact traps proxy mode exists to remove, which is
// why this is the flagged option and not the default.
async function printLinkOnly(target) {
  if (isLoopback(target.chatURL.hostname)) {
    const dns = magicDNSName();
    const ts = detect();
    const host = dns || (ts.state === "up" ? ts.ip : null);
    if (!host) {
      console.error("✖ --link-only needs a phone-reachable URL, but the target is loopback and Tailscale isn't up.");
      console.error("   Drop --link-only to run the proxy instead — it handles loopback targets.");
      process.exit(1);
    }
    target.chatURL.hostname = host;
    console.log(`⚠️  Rewrote the loopback target to ${target.chatURL.hostname} for the phone. This only works if`);
    console.log(`    ${target.label} is actually LISTENING on the tailnet interface (Ollama: OLLAMA_HOST;`);
    console.log("    OpenClaw: gateway bind). If the link fails, drop --link-only and use the proxy.");
  }

  // The app stores a BASE url and re-appends /chat/completions itself.
  const base = target.chatURL.href.replace(/\/chat\/completions$/, "");
  const key = target.key || "";
  const names = target.entries.map((e) => e.name).join(", ");
  console.log(`✓ Link-only QR for ${target.entries.length} agent${target.entries.length === 1 ? "" : "s"}: ${names}\n`);
  printPairing(base, key, {
    payload: pairingPayloadLLM(base, key, target.entries),
    screen: "My Custom Agents",
    tokenNote: key
      ? "⚠️  This code contains the target's own access token — treat it like a password."
      : "", // no secret in a tokenless payload — skip the scary warning
  });

  // No server to clear the QR on first auth — offer a manual clear so a secret-bearing QR
  // doesn't sit in scrollback (same §10.6 concern, hand-operated).
  if (process.stdin.isTTY) {
    await ask("Press Enter after pairing to clear the QR from this terminal", "");
    clearPairingFromTerminal("✓ Pairing block cleared. (Nothing is running — this was a link-only QR.)");
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────────────────────

export async function runInitLLM(argv) {
  const yes = argv.includes("--yes") || argv.includes("-y");
  const linkOnly = argv.includes("--link-only");
  const envPath = path.join(process.cwd(), ".env");
  loadEnvFile(envPath);

  console.log("\nriffn-bridge init --llm — put your own models/agents on your phone (Riffn → My Custom Agents).\n");

  let target;
  if (argv.includes("--openclaw")) {
    target = await resolveOpenClaw(yes);
  } else {
    const rawURL = parseLLMURL(argv);
    target = rawURL ? await resolveExplicitURL(rawURL, yes) : await resolveOllama(yes);
  }

  if (linkOnly) return printLinkOnly(target);
  return runProxy(target, envPath, yes);
}
