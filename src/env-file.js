// Zero-dependency .env handling: load, write a single key, and generate/rotate the bearer token.
// We avoid `dotenv` on purpose — zero runtime dependencies is a stated supply-chain control
// (bridge_plan.md §10.5). This parser is intentionally small and only supports `KEY=value` lines.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

// Parse a .env file into [ {key, value} ] preserving nothing fancy (no export, no interpolation).
function parse(text) {
  const out = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip a single layer of surrounding quotes if present.
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    if (key) out.push({ key, value });
  }
  return out;
}

// Load a .env file into process.env WITHOUT overriding values already set in the environment
// (explicit env wins over the file, matching dotenv's default).
export function loadEnvFile(path) {
  if (!existsSync(path)) return false;
  for (const { key, value } of parse(readFileSync(path, "utf8"))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

// Write (or replace) a single KEY=value in the .env file, preserving other lines and comments.
export function writeEnvVar(path, key, value) {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const rendered = `${key}=${value}`;
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq !== -1 && t.slice(0, eq).trim() === key) {
      lines[i] = rendered;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    if (lines.length && lines.at(-1) !== "") lines.push("");
    lines.push(rendered);
  }
  writeFileSync(path, lines.join("\n"), { mode: 0o600 });
}

// 192-bit random bearer token, URL-safe. Treated like a password (bridge_plan.md §10.6).
export function generateToken() {
  return randomBytes(24).toString("base64url");
}

// Rotate: generate a new token, persist it, return it. Invalidates any previously-paired QR/token.
export function rotateToken(path) {
  const token = generateToken();
  writeEnvVar(path, "RIFFIN_BRIDGE_TOKEN", token);
  return token;
}
