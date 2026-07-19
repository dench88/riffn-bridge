// Windows npm-shim resolution. `npm install -g` puts CLI tools like `claude`/`codex` on PATH as
// generated `.cmd`/`.bat` batch shims (there's no `.exe`). `child_process.spawn`/`spawnSync`
// cannot execute a `.bat`/`.cmd` file directly on Windows without `shell: true` — and turning on
// `shell: true` here would be unsafe: turn text (an untrusted, voice-transcribed prompt) becomes
// part of the args, and cmd.exe re-parses shell metacharacters even when Node is given an argv
// array, defeating the "argument arrays, never a shell string" invariant this project otherwise
// holds everywhere (bridge_plan.md §10.3/README "Security posture").
//
// Instead of shelling out, this resolves what the shim itself would run — npm's own `cmd-shim`
// generator has used the same stable template for years:
//   "%_prog%"  "%dp0%\<relative path to the real .js entry point>" %*
// — and spawns that script directly with `node`, via a normal argv array. Same safety profile as
// every other spawn() in this codebase. Non-Windows, or a bin that isn't a .cmd/.bat (a real
// .exe, or a Mac/Linux binary), passes through unchanged.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Walks PATH (+ PATHEXT on Windows) to find where `bin` resolves, without shelling out — asking a
// shell to resolve it would hit the exact problem this module exists to work around.
function findOnPath(bin) {
  if (path.isAbsolute(bin)) return existsSync(bin) ? bin : null;
  const dirs = (process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const name = ext && bin.toLowerCase().endsWith(ext.toLowerCase()) ? bin : bin + ext;
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// Extracts the real `.js` entry point from an npm-generated `.cmd` shim's text. Returns null if
// the file doesn't match the expected template (npm changed it, or it's a hand-written .cmd).
function extractShimTarget(cmdPath) {
  let text;
  try {
    text = readFileSync(cmdPath, "utf8");
  } catch {
    return null;
  }
  const match = text.match(/"%dp0%\\(.+?\.js)"\s*%\*/);
  if (!match) return null;
  const target = path.join(path.dirname(cmdPath), match[1]);
  return existsSync(target) ? target : null;
}

// Resolves a CLI name/path to something `spawn()` can execute directly with a plain argv array —
// never through a shell. Returns { bin, prefixArgs }: prepend `prefixArgs` to the real args and
// spawn `bin` as normal (e.g. `spawn(bin, [...prefixArgs, ...args], opts)`).
export function resolveSpawnTarget(bin) {
  if (process.platform !== "win32") return { bin, prefixArgs: [] };
  const resolved = findOnPath(bin);
  if (!resolved) return { bin, prefixArgs: [] }; // not found — let spawn's own ENOENT report it
  if (path.extname(resolved).toLowerCase() !== ".cmd" && path.extname(resolved).toLowerCase() !== ".bat") {
    return { bin: resolved, prefixArgs: [] }; // a real .exe (or already resolved) — spawn directly
  }
  const target = extractShimTarget(resolved);
  if (!target) return { bin: resolved, prefixArgs: [] }; // unrecognized shim shape — best effort
  return { bin: process.execPath, prefixArgs: [target] };
}
