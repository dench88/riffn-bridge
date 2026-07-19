// QR pairing rendering. The QR encodes ONLY {v,url,token} (bridge_plan.md §2.1) — never the working
// directory or other metadata (the app fetches those from authenticated /health after pairing).
//
// Zero-dependency stance (§10.5): we do NOT bundle an npm QR library. We render the QR with the
// `qrencode` system tool if present; otherwise we print a clear text fallback with the compact
// payload so the user can still pair (and can install qrencode for a scannable code).
//
// FOLLOW-UP (flagged in the plan): for an always-available in-terminal QR with zero npm deps,
// decide between (a) requiring the `qrencode` system tool, or (b) vendoring a single reviewed
// pure-JS QR file into this repo. Ship (a)+fallback now.

import { spawnSync } from "node:child_process";

export function pairingPayload(url, token) {
  return JSON.stringify({ v: 1, url, token });
}

// Custom-agent pairing payload (custom_agents_plan.md "QR payload spec v2"). v:2 on purpose:
// the shipped coding-agent parser hard-requires v==1, so old app versions cleanly REJECT this
// QR instead of mis-linking an LLM endpoint as a coding bridge. `entries` is 1..n {name, model}
// — one scan can mint several named roster entries (the multi-persona-on-one-Ollama case).
// `token` may be empty (link-only against a no-auth endpoint).
export function pairingPayloadLLM(url, token, entries) {
  return JSON.stringify({ v: 2, kind: "llm", url, token, entries });
}

// Voice pairing payload (tts_profiles_plan.md Phase 4). v:2 + kind:"tts" so neither shipped
// parser (coding-agent requires v==1, custom-agent requires kind=="llm") can mis-consume it.
// The URL is the BRIDGE's own /v1 root — the app completes it to /v1/audio/speech, and the
// bridge proxies to the operator's configured TTS upstream, whose URL never leaves this machine.
export function pairingPayloadTTS(url, token, model, defaultVoice) {
  return JSON.stringify({ v: 2, kind: "tts", url, token, model, defaultVoice });
}

// Returns { rendered: boolean, text: string } — text is the ANSI/UTF8 QR if qrencode is available.
function tryQrencode(payload) {
  try {
    const r = spawnSync("qrencode", ["-t", "UTF8", "-m", "1", payload], { encoding: "utf8" });
    if (r.status === 0 && r.stdout) return { rendered: true, text: r.stdout };
  } catch {
    /* qrencode not installed — fall through */
  }
  return { rendered: false, text: "" };
}

// Clear the pairing QR/token from the terminal (§10.6 B3: the QR must not sit in scrollback
// forever). \x1b[2J clears the visible screen, \x1b[3J clears SCROLLBACK (best-effort — honored
// by Windows Terminal and xterm-likes; harmlessly ignored elsewhere), \x1b[H homes the cursor.
// The bearer token itself is untouched — this is display lifetime, not rotation.
export function clearPairingFromTerminal(message) {
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  if (message) console.log(message);
}

// Print the pairing block to the console. `warn` reminds the user the token is a secret.
// opts.payload overrides the encoded payload (LLM pairing); opts.screen names the app screen
// the user should scan from; opts.tokenNote replaces the default run-code-on-this-machine
// warning (an LLM link grants chat access, not code execution — the default wording would
// overstate it, but the token is still a secret when present).
export function printPairing(url, token, opts = {}) {
  const payload = opts.payload || pairingPayload(url, token);
  const screen = opts.screen || "Link my machine";
  const qr = tryQrencode(payload);

  console.log("\n── Pair with Riffn ─────────────────────────────────────────────");
  if (qr.rendered) {
    console.log(`Scan this QR in Riffn → “${screen}”:\n`);
    console.log(qr.text);
  } else {
    console.log("Scan-to-link needs the `qrencode` tool (not found). Two options:");
    console.log("  • install it (Debian/Ubuntu: `sudo apt install qrencode`, macOS: `brew install qrencode`), or");
    console.log("  • paste the pairing payload below into Riffn’s manual-link field.\n");
    console.log("Pairing payload (contains a secret — treat like a password):");
    console.log(`  ${payload}`);
  }
  if (opts.tokenNote !== undefined) {
    if (opts.tokenNote) console.log(`\n${opts.tokenNote}`);
  } else {
    console.log("\n⚠️  This token grants access to run code on this machine — treat it like a password.");
    console.log("    Don’t screenshot, paste, or commit it. Rotate any time with:  riffn-bridge rotate");
  }
  console.log("────────────────────────────────────────────────────────────────\n");
}
