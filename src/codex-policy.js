import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveSpawnTarget } from "./win-shim.js";

export const MIN_CODEX_VERSION = "0.144.4";
export const TESTED_CODEX_VERSION = "0.144.4";
export const CODEX_PROFILE_REVISION = "2026-07-24-v3";
export const CODEX_READ_PROFILE = "riffn_bridge_read_v1";
export const CODEX_WRITE_PROFILE = "riffn_bridge_write_v1";
export const CODEX_PROBE_RECORD = "codex-security-probe.json";
export const DIRECT_CODEX_DISABLED = true;
export const DIRECT_CODEX_DISABLED_DETAIL =
  "Direct Codex bridges are disabled because native Windows shell subprocesses can bypass " +
  "Codex file-read denials. Use the Claude Code bridge; an OpenAI model may be routed through " +
  "an Anthropic-compatible gateway such as LiteLLM.";

export function assertDirectCodexEnabled() {
  if (DIRECT_CODEX_DISABLED) {
    throw new Error(`Codex bridge disabled (disabled-by-policy): ${DIRECT_CODEX_DISABLED_DETAIL}`);
  }
}

export function parseCodexVersionOutput(stdout) {
  const value = String(stdout || "").trim();
  const number = "(0|[1-9][0-9]*)";
  const match = new RegExp(`^codex-cli ${number}\\.${number}\\.${number}$`).exec(value);
  if (!match) return null;
  return {
    output: value,
    version: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`,
    parts: match.slice(1).map(Number),
  };
}

export function compareVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta) return Math.sign(delta);
  }
  return 0;
}

export function readProbeRecord(envDir) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(envDir, CODEX_PROBE_RECORD), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Codex 0.145.0 has no project-config ignore flag. Worse, any loaded legacy sandbox_mode disables
// permission profiles before a CLI trust override can suppress the project layer. Refuse every
// project-like .codex/config.toml at or above the working directory; the one user-level config is
// excluded because --ignore-user-config handles that layer. This is repeated per turn in agent.js
// so a config added after bridge startup cannot silently replace the pinned profile.
export function findProjectCodexConfig(cwd, options = {}) {
  if (!cwd) return null;
  const codexHome = path.resolve(
    options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
  );
  const userConfig = path.join(codexHome, "config.toml");
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, ".codex", "config.toml");
    if (!samePath(candidate, userConfig) && existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function assertNoProjectCodexConfig(cwd) {
  if (findProjectCodexConfig(cwd)) {
    throw new Error(
      "Codex bridge disabled (project-config-refused): remove or rename the project .codex/config.toml."
    );
  }
}

// The dormant compatibility gate is kept intact so a future Codex release (or a WSL2 build) can
// be probed without rebuilding the policy. Product startup calls inspectCodexPolicy below, which
// adds the current decision-of-record kill switch before any Codex process is launched.
export function inspectCodexCompatibility({ codexBin, envDir, cwd }, options = {}) {
  const projectConfig = findProjectCodexConfig(cwd);
  if (projectConfig) {
    return {
      ready: false,
      status: "project-config-refused",
      version: null,
      output: "",
      detail: "Remove or rename the project .codex/config.toml before enabling the Codex bridge.",
    };
  }
  const runner = options.runner || spawnSync;
  const { bin, prefixArgs } = resolveSpawnTarget(codexBin);
  const result = runner(bin, [...prefixArgs, "--version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    return {
      ready: false,
      status: "unavailable",
      version: null,
      output: String(result.stdout || "").trim(),
      detail: result.error?.message || String(result.stderr || "").trim() || `exit ${result.status}`,
    };
  }
  const parsed = parseCodexVersionOutput(result.stdout);
  if (!parsed) {
    return {
      ready: false,
      status: "malformed-version",
      version: null,
      output: String(result.stdout || "").trim(),
      detail: "Expected exactly: codex-cli MAJOR.MINOR.PATCH",
    };
  }
  if (compareVersions(parsed.version, MIN_CODEX_VERSION) < 0) {
    return {
      ready: false,
      status: "below-version-floor",
      version: parsed.version,
      output: parsed.output,
      detail: `Requires Codex CLI ${MIN_CODEX_VERSION} or newer.`,
    };
  }
  const record = readProbeRecord(envDir);
  if (!record) {
    return {
      ready: false,
      status: "probe-required",
      version: parsed.version,
      output: parsed.output,
      detail: "Run the Codex security probe before enabling the bridge.",
    };
  }
  if (record.profileRevision !== CODEX_PROFILE_REVISION) {
    return {
      ready: false,
      status: "profile-reprobe-required",
      version: parsed.version,
      output: parsed.output,
      detail: "The permission profile changed after the last successful probe.",
    };
  }
  if (record.codexVersion !== parsed.version || record.codexVersionOutput !== parsed.output) {
    return {
      ready: false,
      status: "version-reprobe-required",
      version: parsed.version,
      output: parsed.output,
      detail: "The installed Codex CLI differs from the last successfully probed version.",
    };
  }
  return {
    ready: true,
    status: "ready",
    version: parsed.version,
    output: parsed.output,
    detail: `Probe passed at ${record.probedAt}.`,
    probedAt: record.probedAt,
  };
}

export function inspectCodexPolicy(config, options) {
  if (DIRECT_CODEX_DISABLED) {
    return {
      ready: false,
      status: "disabled-by-policy",
      version: null,
      output: "",
      detail: DIRECT_CODEX_DISABLED_DETAIL,
    };
  }
  return inspectCodexCompatibility(config, options);
}

export function enforceCodexPolicy(cfg, options) {
  const policy = inspectCodexPolicy(cfg, options);
  if (!policy.ready) {
    throw new Error(`Codex bridge disabled (${policy.status}): ${policy.detail}`);
  }
  return policy;
}

export function writeCodexProbeRecord(envDir, policy) {
  if (!policy?.version || !policy?.output) throw new Error("Cannot record a probe without an exact Codex version.");
  const target = path.join(envDir, CODEX_PROBE_RECORD);
  const temporary = `${target}.${randomUUID()}.tmp`;
  const record = {
    schemaVersion: 1,
    profileRevision: CODEX_PROFILE_REVISION,
    codexVersion: policy.version,
    codexVersionOutput: policy.output,
    probedAt: new Date().toISOString(),
  };
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, target);
  return record;
}
