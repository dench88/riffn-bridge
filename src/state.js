import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function normalizedAbsolute(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function projectKey(cwd) {
  const resolved = normalizedAbsolute(cwd);
  const slug = path.basename(resolved).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "project";
  const digest = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return `${slug}-${digest}`;
}

export function defaultStateDir(cwd) {
  return path.join(os.homedir(), ".riffin-bridge", projectKey(cwd));
}

export function resolveStateDir(cwd, env = process.env) {
  return path.resolve(env.RIFFIN_BRIDGE_STATE_DIR || defaultStateDir(cwd));
}

export function isPathInside(candidate, parent) {
  const child = normalizedAbsolute(candidate);
  const root = normalizedAbsolute(parent);
  const relative = path.relative(root, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function assertStateOutsideWorkspace(stateDir, cwd) {
  if (isPathInside(stateDir, cwd)) {
    throw new Error(
      `Bridge state must be outside the agent workspace. Refusing state directory '${stateDir}'.`
    );
  }
}

export function stateEnvPath(cwd, env = process.env) {
  return path.join(resolveStateDir(cwd, env), ".env");
}

export function ensureStateDir(stateDir) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
}

export function assertNoLegacyEnv(launchDir, stateDir) {
  const legacy = path.join(path.resolve(launchDir), ".env");
  if (existsSync(legacy) && path.resolve(legacy) !== path.join(path.resolve(stateDir), ".env")) {
    throw new Error(
      `Legacy bridge state detected at '${legacy}'. It is inside the launch/workspace tree and will not be migrated automatically. ` +
      "See dev_resources/NOW/security_review_repo_model_sandbox_escape_2026-07-23.html. " +
      "After preserving anything you still need, delete that legacy .env and run 'riffn-bridge init' again."
    );
  }
}
