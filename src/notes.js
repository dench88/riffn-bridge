// Voice notes — the HELPER writes the file, never the agent. This is the deliberate §10.3-friendly
// design: the CLI agent keeps its read/plan-only caps untouched, the model never chooses a path or
// touches the filesystem, and even a fully prompt-injected agent could at worst put odd CONTENT in
// a note (composed text travels through the app), never write outside this folder or alter code.
//
// Folder is HARDCODED to riffn-notes/ under the bridge's cwd (the repo it serves) — a fixed,
// predictable location beats configurability here: nothing to misconfigure, nothing to validate,
// and every Riffn user's repo keeps its voice notes in the same place. Filenames are derived here
// (date + slug of the first line), never by a model.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

export const NOTES_DIR = "riffn-notes";

// "Gate the paid tier on bridge usage!" → "gate-the-paid-tier-on-bridge" — lowercase ASCII words
// joined by dashes, capped to 6 words / 48 chars so spoken run-ons stay readable as filenames.
export function slugFrom(text) {
  const firstLine = text.split("\n").find((line) => line.trim()) || "";
  const slug = firstLine
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "note";
}

// Write one note; returns { file } with the repo-relative path ("riffn-notes/2026-07-06-….md").
// Same-day same-slug collisions get -2, -3… suffixes rather than appending into an earlier note —
// each spoken capture is its own file, so git history and reviews stay one-idea-per-diff.
export function saveNote(cfg, text, now = new Date()) {
  const dir = path.join(cfg.cwd, NOTES_DIR);
  mkdirSync(dir, { recursive: true });
  const day = now.toISOString().slice(0, 10);
  const base = `${day}-${slugFrom(text)}`;
  let file = `${base}.md`;
  for (let n = 2; existsSync(path.join(dir, file)); n++) file = `${base}-${n}.md`;
  const stamp = now.toISOString().replace("T", " ").slice(0, 16);
  writeFileSync(path.join(dir, file), `# Riffn note — ${stamp} UTC\n\n${text.trim()}\n`);
  return { file: `${NOTES_DIR}/${file}` };
}
