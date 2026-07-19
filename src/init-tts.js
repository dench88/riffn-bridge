// `riffn-bridge tts` — one-command voice pairing (tts_profiles_plan.md Phase 4). Mirrors `init`'s
// shape (ask → verify → token → Tailscale → QR → run FOREGROUND) but scoped to TTS only, so a
// machine that's just a TTS box (no coding agent wanted) needs nothing but this: go to the
// machine running Kokoro/Orpheus/etc, run `npx @riffn/bridge tts`, answer two prompts, scan.
//
// Deliberately does NOT require a prior `riffn-bridge init` — RIFFIN_BRIDGE_TTS_URL is asked for
// interactively here (unlike the chat agent, which init detects). A machine that already ran
// `init` for a coding agent and just wants to ALSO offer voice reuses that .env/token untouched.

import path from "node:path";
import { loadEnvFile, writeEnvVar, generateToken } from "./env-file.js";
import { readConfig } from "./config.js";
import { detect, instructions, magicDNSName } from "./tailscale.js";
import { printPairing, pairingPayloadTTS, clearPairingFromTerminal } from "./qr.js";
import { startServer } from "./server.js";
import { ask, findFreePort } from "./init.js";

// POSTs a short synth request at the given endpoint/model/voice/key and returns true only on a
// real audio response — catches a wrong URL, wrong model name, or unreachable server BEFORE a
// QR is printed and handed to the phone, rather than after a failed pairing scan.
async function verifyTTSEndpoint(url, model, voice, key) {
  try {
    const headers = { "Content-Type": "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input: "Riffn voice link verified.", voice, response_format: "mp3" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return false;
    const buf = await resp.arrayBuffer();
    return buf.byteLength > 0;
  } catch {
    return false;
  }
}

export async function runInitTTS(argv) {
  const yes = argv.includes("--yes") || argv.includes("-y");
  const envPath = path.join(process.cwd(), ".env");
  loadEnvFile(envPath);

  console.log("\nriffn-bridge tts — link this machine's TTS server as a Riffn voice (Tailscale).\n");

  // 1. TTS URL — the one thing init never asks for. Keep an existing value as the default so
  // re-running `tts` (or a machine that already has RIFFIN_BRIDGE_TTS_URL from a hand-edited
  // .env) doesn't need to retype it. BUG FIXED (maintainer-reported 2026-07-14): only prompt
  // when we DON'T already have a URL — the old `|| !yes` re-prompted even when the URL was
  // supplied as an argument, which combined badly with `npx` sometimes not forwarding stdin to
  // the interactive prompt (readline gets an immediate empty answer, silently discarding a
  // perfectly good argument). Passing the URL as an argument now always skips the prompt.
  const urlFlag = argv.find((a) => !a.startsWith("-"));
  let ttsUrl = urlFlag || process.env.RIFFIN_BRIDGE_TTS_URL || "";
  if (!ttsUrl) {
    ttsUrl = await ask(
      "TTS server URL (OpenAI-compatible /v1/audio/speech, e.g. http://127.0.0.1:8880/v1/audio/speech)",
      undefined
    );
  }
  if (!ttsUrl) {
    console.error("✖ A TTS URL is required. Re-run with the URL, e.g.:  riffn-bridge tts http://127.0.0.1:8880/v1/audio/speech");
    process.exit(1);
  }

  let ttsModel = process.env.RIFFIN_BRIDGE_TTS_MODEL || "kokoro";
  let ttsVoice = process.env.RIFFIN_BRIDGE_TTS_VOICE || "af_heart";
  if (!yes) {
    ttsModel = await ask("Model name (as your server expects it)", ttsModel);
    ttsVoice = await ask("Default voice id", ttsVoice);
  }
  const ttsKey = process.env.RIFFIN_BRIDGE_TTS_KEY || "";

  // 2. Verify BEFORE writing anything or printing a QR — a typo'd URL should fail loudly here,
  // not as a mystery "couldn't verify" on the phone three steps later.
  console.log("\nVerifying the TTS endpoint…");
  const verified = await verifyTTSEndpoint(ttsUrl, ttsModel, ttsVoice, ttsKey);
  if (!verified) {
    console.error(`✖ ${ttsUrl} didn't return audio for model "${ttsModel}". Check the server is running and the model/voice names match, then try again.`);
    process.exit(1);
  }
  console.log("✓ TTS endpoint responded with audio.");

  writeEnvVar(envPath, "RIFFIN_BRIDGE_TTS_URL", ttsUrl);
  writeEnvVar(envPath, "RIFFIN_BRIDGE_TTS_MODEL", ttsModel);
  writeEnvVar(envPath, "RIFFIN_BRIDGE_TTS_VOICE", ttsVoice);

  // 3. Token — reuse an existing one (e.g. this machine already runs a coding-agent bridge too)
  // so pairing voice never invalidates an already-scanned coding-agent QR.
  let token = process.env.RIFFIN_BRIDGE_TOKEN;
  if (!token) {
    token = generateToken();
    writeEnvVar(envPath, "RIFFIN_BRIDGE_TOKEN", token);
    console.log("✓ Generated a new bearer token (saved to .env).");
  } else {
    console.log("✓ Using the existing bearer token from .env.");
  }

  // 4. Tailscale: detect → instruct → verify. Same posture as init — never run privileged
  // commands ourselves.
  const ts = detect();
  if (ts.state !== "up") {
    console.log("\n⚠️  Not ready to pair yet:\n");
    for (const line of instructions(ts.state)) console.log(`   ${line}`);
    console.log("");
    process.exit(ts.state === "missing" ? 2 : 3);
  }
  console.log(`✓ Tailscale is up (${ts.ip}).`);

  // 5. Reload config, pick a free port (persisted, same rationale as init: the pairing URL must
  // stay stable across restarts), print the QR, and run in the foreground.
  loadEnvFile(envPath);
  process.env.RIFFIN_BRIDGE_TOKEN = token;
  const cfg = readConfig();
  cfg.host = cfg.host || ts.ip;

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
  printPairing(url, token, {
    payload: pairingPayloadTTS(url, token, ttsModel, ttsVoice),
    screen: "Settings → Voice → Voice on My Machine",
    tokenNote:
      "⚠️  This token grants access to this bridge (voice, and chat if configured) — treat it like\n" +
      "    a password. Don't screenshot, paste, or commit it. Rotate any time with:  riffn-bridge rotate",
  });

  // Same scrollback-hygiene contract as init (§10.6 B3): clear the QR/token on the first
  // authenticated request, or after 5 minutes unused either way.
  const afterClearStatus =
    `riffn-bridge (voice) listening on http://${cfg.host}:${cfg.port}  (pid ${process.pid})\n` +
    `  Press Ctrl-C to stop.`;
  let qrTimeout = setTimeout(() => {
    qrTimeout = null;
    clearPairingFromTerminal(
      "⏱  Pairing QR cleared after 5 minutes unused. The token is unchanged — re-run" +
      " `riffn-bridge tts` for a fresh QR, or `riffn-bridge rotate` to invalidate it.\n\n" +
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
