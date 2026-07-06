// Tailscale transport: DETECT → INSTRUCT → VERIFY only. We NEVER run privileged `tailscale`
// commands ourselves and NEVER capture/store Tailscale credentials (bridge_plan.md §2.2/§3). The
// user authenticates in their own Tailscale client; we only read state and tell them what to do.

import { spawnSync } from "node:child_process";
import { tailscaleIPv4 } from "./config.js";

function tailscaleCliPresent() {
  try {
    const r = spawnSync("tailscale", ["version"], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

// The machine's MagicDNS name (e.g. "dench-ws.tailXXXX.ts.net"). iOS App Transport Security only
// allows cleartext HTTP to `.ts.net` hostnames, NOT to raw 100.x IPs — so the pairing URL MUST use
// this hostname, or the app can't connect over plain HTTP. Returns null if unavailable.
export function magicDNSName() {
  try {
    const r = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8", maxBuffer: 8_000_000 });
    if (r.status !== 0 || !r.stdout) return null;
    const dns = JSON.parse(r.stdout)?.Self?.DNSName;
    if (typeof dns !== "string" || !dns) return null;
    return dns.replace(/\.$/, ""); // strip the trailing dot MagicDNS includes
  } catch {
    return null;
  }
}

// Returns one of:
//   { state: "up", ip }              — a tailnet IP is present; ready to bind/serve
//   { state: "installed-down" }      — CLI present but no tailnet address (needs `tailscale up`)
//   { state: "missing" }             — Tailscale not detected at all
export function detect() {
  const ip = tailscaleIPv4();
  if (ip) return { state: "up", ip };
  if (tailscaleCliPresent()) return { state: "installed-down" };
  return { state: "missing" };
}

// Human-readable guidance for a non-"up" state. Returns an array of lines (no side effects).
export function instructions(state) {
  if (state === "installed-down") {
    return [
      "Tailscale is installed but this machine has no tailnet address yet.",
      "Bring it up in your own client (this wizard will NOT run it for you):",
      "  tailscale up",
      "Then re-run:  riffn-bridge init",
    ];
  }
  return [
    "Tailscale was not detected. It gives you a private, encrypted path from your phone to this",
    "machine with no server in the middle.",
    "  1. Install Tailscale on THIS machine:  https://tailscale.com/download",
    "  2. Install Tailscale on your PHONE and sign in with the same account.",
    "  3. Bring this machine up:  tailscale up",
    "  4. Re-run:  riffn-bridge init",
    "",
    "We never run these privileged commands for you and never see your Tailscale login.",
  ];
}

// Verify a specific host is a usable tailnet address (used after the user says they've run up).
export function verifyHost(host) {
  if (host === "127.0.0.1" || host === "localhost") return true; // explicit local (e.g. tailscale serve)
  const ip = tailscaleIPv4();
  return Boolean(ip) && (!host || host === ip);
}
