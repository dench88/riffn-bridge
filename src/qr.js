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
export function printPairing(url, token) {
  const payload = pairingPayload(url, token);
  const qr = tryQrencode(payload);

  console.log("\n── Pair with Riffn ─────────────────────────────────────────────");
  if (qr.rendered) {
    console.log("Scan this QR in Riffn → “Link my machine”:\n");
    console.log(qr.text);
  } else {
    console.log("Scan-to-link needs the `qrencode` tool (not found). Two options:");
    console.log("  • install it (Debian/Ubuntu: `sudo apt install qrencode`, macOS: `brew install qrencode`), or");
    console.log("  • paste the pairing payload below into Riffn’s manual-link field.\n");
    console.log("Pairing payload (contains a secret — treat like a password):");
    console.log(`  ${payload}`);
  }
  console.log("\n⚠️  This token grants access to run code on this machine — treat it like a password.");
  console.log("    Don’t screenshot, paste, or commit it. Rotate any time with:  riffn-bridge rotate");
  console.log("────────────────────────────────────────────────────────────────\n");
}
