import assert from "node:assert/strict";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { agentCommand } from "../src/agent.js";
import {
  CODEX_PROFILE_REVISION,
  CODEX_READ_PROFILE,
  CODEX_WRITE_PROFILE,
  findProjectCodexConfig,
  inspectCodexCompatibility,
  inspectCodexPolicy,
  parseCodexVersionOutput,
  writeCodexProbeRecord,
} from "../src/codex-policy.js";
import { codexPolicyHealth } from "../src/config.js";
import { resolveSpawnTarget } from "../src/win-shim.js";
import { startServer } from "../src/server.js";
import { beginCodexTurn, finishCodexTurn } from "../src/audit.js";
import {
  assertStateOutsideWorkspace, defaultStateDir, projectKey,
} from "../src/state.js";

const DISABLED_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "hooks",
  "in_app_browser",
  "multi_agent",
  "plugins",
  "plugin_sharing",
  "remote_plugin",
  "skill_mcp_dependency_install",
  "workspace_dependencies",
];

function cfg(editMode, cwd) {
  return { agent: "codex", codexBin: "codex", editMode, cwd, codexProbeMode: true };
}

function expectedArgs(editMode, cwd, prompt = "hello") {
  const profile = editMode === "ungated" ? CODEX_WRITE_PROFILE : CODEX_READ_PROFILE;
  const access = editMode === "ungated" ? "write" : "read";
  const workspaceRules = [
    `"." = "${access}"`,
    `".venv" = "read"`,
    `".vscode" = "read"`,
    `".claude" = "read"`,
    `".agents" = "read"`,
    `"node_modules" = "read"`,
    `"workers/node_modules" = "read"`,
    `".env" = "deny"`,
    `"*.env" = "deny"`,
    `"**/*.env" = "deny"`,
    `"workers/.dev.vars*" = "deny"`,
  ].join(", ");
  const overrides = [
    `projects.${JSON.stringify(path.resolve(cwd))}.trust_level="untrusted"`,
    `default_permissions="${profile}"`,
    `permissions.${profile}.description="Riffn bridge pinned ${access} profile"`,
    `permissions.${profile}.extends=":workspace"`,
    `permissions.${profile}.filesystem={ ":root" = "deny", ":minimal" = "read", glob_scan_max_depth = 64, ":workspace_roots" = { ${workspaceRules} } }`,
    `permissions.${profile}.network.enabled=false`,
    `approval_policy="never"`,
    `shell_environment_policy.inherit="core"`,
    `windows.sandbox="elevated"`,
    `web_search="disabled"`,
    `mcp_servers={}`,
    ...DISABLED_FEATURES.map((feature) => `features.${feature}=false`),
  ];
  return [
    "exec",
    "--ignore-user-config",
    "--strict-config",
    "--ignore-rules",
    "--ephemeral",
    ...overrides.flatMap((override) => ["-c", override]),
    prompt,
  ];
}

for (const editMode of ["disabled", "limited", "ungated"]) {
  test(`Codex ${editMode} argv exactly pins the permission posture`, () => {
    const cwd = path.resolve("codex-policy-fixture");
    const command = agentCommand(cfg(editMode, cwd), "hello");
    assert.equal(command.bin, "codex");
    assert.deepEqual(command.args, expectedArgs(editMode, cwd));
    assert.equal(command.args.includes("--sandbox"), false);
    assert.equal(command.args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
    assert.equal(command.args.includes("--dangerously-bypass-hook-trust"), false);
    const expectedProfile = editMode === "ungated" ? CODEX_WRITE_PROFILE : CODEX_READ_PROFILE;
    assert.ok(command.args.includes(`default_permissions="${expectedProfile}"`));
    if (editMode !== "ungated") {
      assert.equal(command.args.some((arg) => arg.includes(CODEX_WRITE_PROFILE)), false);
    }
  });
}

test("Codex refuses project config before constructing an agent command", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "riffn-project-config-"));
  const workspace = path.join(root, "workspace");
  const nested = path.join(workspace, "nested");
  const projectConfig = path.join(workspace, ".codex", "config.toml");
  mkdirSync(path.dirname(projectConfig), { recursive: true });
  mkdirSync(nested, { recursive: true });
  writeFileSync(projectConfig, 'sandbox_mode = "danger-full-access"\n');
  try {
    assert.equal(findProjectCodexConfig(nested), projectConfig);
    assert.throws(
      () => agentCommand(cfg("ungated", nested), "hello"),
      /project-config-refused/
    );
    const policy = inspectCodexCompatibility({
      codexBin: "codex",
      envDir: root,
      cwd: nested,
    });
    assert.equal(policy.status, "project-config-refused");
    assert.equal(policy.ready, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normal agent command construction refuses direct Codex", () => {
  const direct = cfg("disabled", path.resolve("codex-policy-fixture"));
  delete direct.codexProbeMode;
  assert.throws(() => agentCommand(direct, "hello"), /disabled-by-policy/);
});

test("init refuses --agent codex before creating a bridge environment", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "riffn-init-codex-disabled-"));
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  mkdirSync(workspace);
  try {
    const result = spawnSync(process.execPath, [
      path.resolve("index.js"), "init", "--agent", "codex", "--yes", "--cwd", workspace,
    ], {
      cwd: root,
      env: { ...process.env, RIFFIN_BRIDGE_STATE_DIR: stateDir },
      encoding: "utf8",
      shell: false,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /disabled-by-policy/);
    assert.equal(existsSync(path.join(stateDir, ".env")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex version output parser is exact", () => {
  assert.equal(parseCodexVersionOutput("codex-cli 0.144.4\n")?.version, "0.144.4");
  for (const output of ["", "0.144.4", "codex 0.144.4", "codex-cli 0.144", "codex-cli 0.144.4 extra"]) {
    assert.equal(parseCodexVersionOutput(output), null);
  }
});

test("dormant Codex compatibility gate handles versions while product policy stays disabled", () => {
  const envDir = mkdtempSync(path.join(os.tmpdir(), "riffn-codex-policy-"));
  const base = { codexBin: path.join(envDir, "codex.exe"), envDir };
  const runner = (result) => () => result;
  try {
    assert.equal(inspectCodexPolicy(base).status, "disabled-by-policy");
    assert.equal(inspectCodexPolicy(base).ready, false);
    assert.equal(inspectCodexCompatibility(base, { runner: runner({ error: new Error("ENOENT"), status: null }) }).status, "unavailable");
    assert.equal(inspectCodexCompatibility(base, { runner: runner({ status: 0, stdout: "codex 0.144.4" }) }).status, "malformed-version");
    assert.equal(inspectCodexCompatibility(base, { runner: runner({ status: 0, stdout: "codex-cli 0.138.0\n" }) }).status, "below-version-floor");
    assert.equal(inspectCodexCompatibility(base, { runner: runner({ status: 0, stdout: "codex-cli 0.144.4\n" }) }).status, "probe-required");

    writeCodexProbeRecord(envDir, { version: "0.144.4", output: "codex-cli 0.144.4" });
    const ready = inspectCodexCompatibility(base, { runner: runner({ status: 0, stdout: "codex-cli 0.144.4\n" }) });
    assert.equal(ready.status, "ready");
    assert.equal(ready.ready, true);
    assert.equal(inspectCodexCompatibility(base, { runner: runner({ status: 0, stdout: "codex-cli 0.145.0\n" }) }).status, "version-reprobe-required");
  } finally {
    rmSync(envDir, { recursive: true, force: true });
  }
});

test("Codex health exposes the disabled product policy only in Codex CLI mode", () => {
  const policy = inspectCodexPolicy({});
  assert.deepEqual(codexPolicyHealth({
    mode: "cli", agent: "codex", editMode: "ungated", codexPolicy: policy,
  }), {
    status: "disabled-by-policy",
    ready: false,
    version: null,
    versionOutput: null,
    detail: policy.detail,
    profile: null,
    dormantProfile: CODEX_WRITE_PROFILE,
  });
  assert.equal(codexPolicyHealth({ mode: "cli", agent: "claude" }), undefined);
  assert.equal(codexPolicyHealth({ mode: "llm", agent: "codex" }), undefined);
  assert.equal(typeof CODEX_PROFILE_REVISION, "string");
});

test("authenticated HTTP health reports direct Codex as disabled", async () => {
  const envDir = mkdtempSync(path.join(os.tmpdir(), "riffn-http-health-"));
  const cfgValue = {
    mode: "cli",
    agent: "codex",
    editMode: "disabled",
    allowEditJobs: false,
    editModeAgentMismatch: false,
    codexPolicy: inspectCodexPolicy({}),
    host: "127.0.0.1",
    port: 0,
    token: "test-token",
    cwd: path.resolve("codex-policy-fixture"),
    envDir,
    ttsConfigured: false,
    modelId: "test",
  };
  const server = startServer(cfgValue, { quiet: true });
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/health`, {
      headers: { Authorization: "Bearer test-token" },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.codexPolicy.status, "disabled-by-policy");
    assert.equal(body.codexPolicy.version, null);
    assert.equal(body.codexPolicy.profile, null);
    assert.equal(body.codexPolicy.dormantProfile, CODEX_READ_PROFILE);
    assert.equal(body.codexPolicy.ready, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(envDir, { recursive: true, force: true });
  }
});

test("CLI health reports direct Codex as disabled without accepting a probe record", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "riffn-cli-health-"));
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  mkdirSync(workspace);
  mkdirSync(stateDir);
  const fakeJs = path.join(root, "fake-codex.js");
  writeFileSync(fakeJs, 'if (process.argv.includes("--version")) console.log("codex-cli 0.144.4");\n');
  let fakeBin;
  if (process.platform === "win32") {
    fakeBin = path.join(root, "codex.cmd");
    writeFileSync(fakeBin, '@ECHO off\r\n"%dp0%\\fake-codex.js" %*\r\n');
  } else {
    fakeBin = path.join(root, "codex");
    writeFileSync(fakeBin, `#!${process.execPath}\nif (process.argv.includes("--version")) console.log("codex-cli 0.144.4");\n`);
    chmodSync(fakeBin, 0o700);
  }
  writeFileSync(path.join(stateDir, ".env"), [
    "RIFFIN_BRIDGE_AGENT=codex",
    `RIFFIN_BRIDGE_CWD=${workspace}`,
    `RIFFIN_BRIDGE_CODEX_BIN=${fakeBin}`,
    "RIFFIN_BRIDGE_EDIT_MODE=disabled",
    "RIFFIN_BRIDGE_TOKEN=fake-token",
    "",
  ].join("\n"));
  writeCodexProbeRecord(stateDir, { version: "0.144.4", output: "codex-cli 0.144.4" });
  try {
    const result = spawnSync(process.execPath, [
      path.resolve("index.js"), "health", "--cwd", workspace,
    ], {
      cwd: root,
      env: { ...process.env, RIFFIN_BRIDGE_STATE_DIR: stateDir },
      encoding: "utf8",
      shell: false,
    });
    assert.equal(result.status, 0, result.stderr);
    const health = JSON.parse(result.stdout);
    assert.equal(health.codexPolicy.status, "disabled-by-policy");
    assert.equal(health.codexPolicy.version, null);
    assert.equal(health.codexPolicy.profile, null);
    assert.equal(health.codexPolicy.dormantProfile, CODEX_READ_PROFILE);
    assert.equal(health.codexPolicy.ready, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows npm .cmd resolution uses the shim target without a shell", {
  skip: process.platform !== "win32",
}, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "riffn-win-shim-"));
  const jsPath = path.join(dir, "codex.js");
  const cmdPath = path.join(dir, "codex.cmd");
  const oldPath = process.env.PATH;
  const oldPathExt = process.env.PATHEXT;
  try {
    writeFileSync(jsPath, "process.exit(0);\n");
    writeFileSync(cmdPath, '@ECHO off\r\n"%dp0%\\codex.js" %*\r\n');
    process.env.PATH = dir;
    process.env.PATHEXT = ".CMD";
    assert.deepEqual(resolveSpawnTarget("codex"), {
      bin: process.execPath,
      prefixArgs: [jsPath],
    });
  } finally {
    process.env.PATH = oldPath;
    process.env.PATHEXT = oldPathExt;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project-keyed state is stable, distinct, and rejected inside the workspace", () => {
  const first = path.resolve("fixture-a");
  const second = path.resolve("fixture-b");
  assert.equal(projectKey(first), projectKey(first));
  assert.notEqual(projectKey(first), projectKey(second));
  assertStateOutsideWorkspace(defaultStateDir(first), first);
  assert.throws(
    () => assertStateOutsideWorkspace(path.join(first, ".bridge-state"), first),
    /outside the agent workspace/
  );
});

test("Codex turn audit records hashes and changed paths without storing the prompt", () => {
  const envDir = mkdtempSync(path.join(os.tmpdir(), "riffn-audit-"));
  const cfgValue = { envDir, editMode: "ungated" };
  try {
    const turn = beginCodexTurn(cfgValue, {
      bin: "codex",
      args: ["exec", "SUPER_SECRET_PROMPT"],
    });
    finishCodexTurn(cfgValue, turn, {
      outcome: "succeeded",
      snapshotRef: "refs/riffn/ring-test",
      filesChanged: ["b.js", "a.js", "a.js"],
    });
    const audit = readFileSync(path.join(envDir, "codex-turns.jsonl"), "utf8");
    assert.equal(audit.includes("SUPER_SECRET_PROMPT"), false);
    const entries = audit.trim().split("\n").map(JSON.parse);
    assert.equal(entries.length, 2);
    assert.match(entries[0].argvSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(entries[1].filesChanged, ["a.js", "b.js"]);
    assert.equal(entries[1].snapshotRef, "refs/riffn/ring-test");
  } finally {
    rmSync(envDir, { recursive: true, force: true });
  }
});
