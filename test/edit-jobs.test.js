// Edit-capable jobs (execute_jobs_plan.md) — the security-load-bearing paths:
//   1. snapshotRepo captures tracked + untracked state without touching the working tree,
//      and refuses outside a git repo.
//   2. buildJobArgs: an edit job differs from a read job by EXACTLY acceptEdits + the denylist.
//   3. The server's two-key gate: caps:"edit" without the workstation flag → 403; with the flag
//      but an un-snapshottable cwd → 503 and NO job started. (Neither path spawns claude.)
// Zero-dep: node's built-in test runner (`npm test`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { snapshotRepo } from "../src/git.js";
import { buildJobArgs, EDIT_JOB_ALLOWED_TOOLS, EDIT_JOB_DISALLOWED_TOOLS, createJobStore, SnapshotError } from "../src/jobs.js";
import { isEditToolAllowed, isEditPathAllowed } from "../src/edit-policy.js";
import { agentCaps, agentCommand, childEnv, effectiveCaps } from "../src/agent.js";
import { resolveEditMode } from "../src/config.js";
import { snapshotRepoRing } from "../src/git.js";
import { createSessionStore } from "../src/session.js";
import { startServer } from "../src/server.js";
import { fileURLToPath } from "node:url";
import { spawnSync as spawnSyncNode } from "node:child_process";

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "riffn-test-repo-"));
  git(dir, "init");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(path.join(dir, "a.txt"), "original\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "base");
  return dir;
}

// Minimal cfg for createJobStore/startServer — only the fields those paths read.
function makeCfg(overrides = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "riffn-test-env-"));
  return {
    token: "test-token", host: "127.0.0.1", port: 0,
    mode: "cli", agent: "claude", claudeBin: "claude-definitely-not-installed",
    cwd: dir, envDir: dir,
    timeoutMs: 5000, jobTimeoutMs: 5000,
    ttsConfigured: false, modelId: "riffn-bridge", allowEditJobs: false,
    ...overrides,
  };
}

test("snapshotRepo captures modified + untracked files without touching the tree", () => {
  const repo = makeRepo();
  try {
    writeFileSync(path.join(repo, "a.txt"), "modified\n");        // tracked, dirty
    writeFileSync(path.join(repo, "new.txt"), "untracked\n");     // untracked
    const { ref, commit } = snapshotRepo(repo, "abc12345-rest-truncated-here");

    assert.equal(ref, "refs/riffn/snapshot-abc12345resttrun");
    assert.equal(git(repo, "rev-parse", ref), commit);
    // Snapshot holds BOTH the dirty edit and the untracked file.
    assert.equal(git(repo, "show", `${ref}:a.txt`), "modified");
    assert.equal(git(repo, "show", `${ref}:new.txt`), "untracked");
    // Working tree, index, and HEAD are untouched.
    assert.equal(readFileSync(path.join(repo, "a.txt"), "utf8"), "modified\n");
    assert.match(git(repo, "status", "--porcelain"), /^\s?M a\.txt\n\?\? new\.txt$/m);
    assert.equal(git(repo, "log", "--oneline").split("\n").length, 1); // history unchanged
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("snapshotRepo throws outside a git work tree", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "riffn-test-norepo-"));
  try {
    assert.throws(() => snapshotRepo(dir, "deadbeef"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildJobArgs: edit caps add the four containment controls; read caps add none", () => {
  const read = buildJobArgs("do it", "sys", undefined, "sess1");
  const edit = buildJobArgs("do it", "sys", "edit", "sess1",
    { mcpConfigPath: "/tmp/empty-mcp.json", settingsPath: "/tmp/edit-settings.json" });

  assert.deepEqual(read, [
    "-p", "do it", "--output-format", "stream-json", "--verbose",
    "--resume", "sess1", "--append-system-prompt", "sys",
  ]);
  assert.deepEqual(edit, [
    "-p", "do it", "--output-format", "stream-json", "--verbose",
    "--settings", "/tmp/edit-settings.json",
    "--permission-mode", "dontAsk",
    "--strict-mcp-config", "--mcp-config", "/tmp/empty-mcp.json",
    "--allowedTools", ...EDIT_JOB_ALLOWED_TOOLS,
    "--disallowedTools", ...EDIT_JOB_DISALLOWED_TOOLS,
    "--resume", "sess1", "--append-system-prompt", "sys",
  ]);
  // The PreToolUse hook (--settings) is the guarantee; dontAsk makes the allowlist exclusive.
  assert.ok(edit.includes("--settings"));
  assert.equal(edit[edit.indexOf("--permission-mode") + 1], "dontAsk");
  // No execution/delegation tool may appear on the allowlist; all stay on the backstop denylist.
  for (const tool of ["Bash", "BashOutput", "KillShell", "Task", "Agent", "Monitor", "TaskOutput"]) {
    assert.ok(!EDIT_JOB_ALLOWED_TOOLS.includes(tool), `${tool} must NOT be on the edit-job allowlist`);
    assert.ok(EDIT_JOB_DISALLOWED_TOOLS.includes(tool), `${tool} must stay on the backstop denylist`);
  }
});

// The hook is the guarantee — test it end to end by piping tool requests through the real script,
// exactly as Claude Code invokes it. Denied tools must produce permissionDecision "deny".
test("edit-guard-hook denies non-allowlisted tools and allows repo tools (fail-closed)", () => {
  const hookPath = fileURLToPath(new URL("../src/edit-guard-hook.js", import.meta.url));
  const runHook = (stdin) =>
    spawnSyncNode(process.execPath, [hookPath], { input: stdin, encoding: "utf8" });

  const repoCwd = mkdtempSync(path.join(os.tmpdir(), "riffn-test-hookcwd-"));
  const decisionFor = (toolName, toolInput = {}) => {
    const r = runHook(JSON.stringify({
      hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, cwd: repoCwd,
    }));
    assert.equal(r.status, 0, "hook must always exit 0");
    return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
  };
  try {
    // Allowlisted read/web tools → allow (no path boundary on reads).
    for (const t of ["Read", "Glob", "Grep", "WebFetch"]) {
      assert.equal(decisionFor(t), "allow", `${t} should be allowed`);
    }
    // Allowlisted WRITE tools → allow only with an in-repo target (fail closed without one).
    const inside = path.join(repoCwd, "notes.md");
    assert.equal(decisionFor("Edit", { file_path: inside }), "allow");
    assert.equal(decisionFor("Write", { file_path: "relative-inside.md" }), "allow");
    assert.equal(decisionFor("Write", {}), "deny", "write tool with no path must fail closed");
    assert.equal(decisionFor("Edit", { file_path: path.join(repoCwd, "..", "escape.md") }), "deny");
    assert.equal(decisionFor("NotebookEdit", { notebook_path: path.join(os.tmpdir(), "outside.ipynb") }), "deny");
    // Everything else — exec, subagents, the CronList/Monitor class, MCP tools → deny.
    for (const t of ["Bash", "Monitor", "CronList", "Task", "Agent", "mcp__claude_ai_Gmail__send", "RemoteTrigger"]) {
      assert.equal(decisionFor(t), "deny", `${t} MUST be denied`);
    }
    // Fail closed: malformed input and missing tool name → deny.
    assert.equal(JSON.parse(runHook("not json").stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(JSON.parse(runHook("{}").stdout).hookSpecificOutput.permissionDecision, "deny");

    // Sanity: the pure policy predicate agrees with the hook.
    assert.ok(isEditToolAllowed("Edit"));
    assert.ok(!isEditToolAllowed("Bash"));
    assert.ok(!isEditToolAllowed("CronList"));
  } finally {
    rmSync(repoCwd, { recursive: true, force: true });
  }
});

// The path boundary itself (pure function): write targets must resolve inside cwd; everything
// about a write that can't be judged is denied; non-write tools carry no path to judge.
test("isEditPathAllowed: write tools are confined to the working directory, fail-closed", () => {
  const root = path.join(os.tmpdir(), "riffn-boundary-root");

  // Inside: absolute, relative, nested, and a dot-prefixed FILE name that merely looks like "..".
  assert.ok(isEditPathAllowed("Edit", { file_path: path.join(root, "a.txt") }, root));
  assert.ok(isEditPathAllowed("Write", { file_path: "sub/dir/new.txt" }, root));
  assert.ok(isEditPathAllowed("MultiEdit", { file_path: path.join(root, "sub", "b.js") }, root));
  assert.ok(isEditPathAllowed("NotebookEdit", { notebook_path: path.join(root, "n.ipynb") }, root));
  assert.ok(isEditPathAllowed("Write", { file_path: "..weird-but-inside.txt" }, root));

  // Outside: parent escape (absolute and relative), sibling dir, different root.
  assert.ok(!isEditPathAllowed("Edit", { file_path: path.join(root, "..", "escape.txt") }, root));
  assert.ok(!isEditPathAllowed("Write", { file_path: "../escape.txt" }, root));
  assert.ok(!isEditPathAllowed("Write", { file_path: `${root}-sibling/x.txt` }, root));
  assert.ok(!isEditPathAllowed("NotebookEdit", { notebook_path: path.join(os.tmpdir(), "n.ipynb") }, root));
  if (process.platform === "win32") {
    assert.ok(!isEditPathAllowed("Write", { file_path: "Q:\\other-drive\\x.txt" }, root));
    // Windows paths compare case-insensitively — a case-twiddled root is still inside.
    assert.ok(isEditPathAllowed("Write", { file_path: path.join(root.toUpperCase(), "a.txt") }, root));
  }

  // Fail closed: missing/empty/non-string path or cwd on a write tool.
  assert.ok(!isEditPathAllowed("Write", {}, root));
  assert.ok(!isEditPathAllowed("Write", undefined, root));
  assert.ok(!isEditPathAllowed("Edit", { file_path: 42 }, root));
  assert.ok(!isEditPathAllowed("Edit", { file_path: "" }, root));
  assert.ok(!isEditPathAllowed("Write", { file_path: "a.txt" }, ""));

  // Non-write tools have no path boundary (reads/search/web stay unrestricted).
  assert.ok(isEditPathAllowed("Read", { file_path: path.join(os.tmpdir(), "anywhere.txt") }, root));
  assert.ok(isEditPathAllowed("Grep", {}, root));
  assert.ok(isEditPathAllowed("WebFetch", { url: "https://example.com" }, root));
});

test("edit-job dispatch writes the MCP config and the guard-hook settings before spawning", async () => {
  // Exercise the store's start() far enough to trigger ensureEditConfigs, in a real repo so the
  // snapshot succeeds and the (non-existent) claudeBin only fails AFTER the files are written.
  const repo = makeRepo();
  const cfg = makeCfg({ cwd: repo, allowEditJobs: true });
  try {
    const jobs = createJobStore(cfg, null);
    const view = jobs.start("go", "", "edit"); // spawns a doomed child, but writes configs first
    assert.equal(view.caps, "edit");
    assert.equal(view.snapshotted, true);

    const mcpPath = path.join(os.tmpdir(), `riffn-bridge-empty-mcp-${process.pid}.json`);
    assert.ok(existsSync(mcpPath), "empty MCP config must be written before an edit job spawns");
    assert.deepEqual(JSON.parse(readFileSync(mcpPath, "utf8")), { mcpServers: {} });

    const settingsPath = path.join(os.tmpdir(), `riffn-bridge-edit-settings-${process.pid}.json`);
    assert.ok(existsSync(settingsPath), "edit settings (guard hook) must be written before spawn");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const hookCmd = settings.hooks.PreToolUse[0].hooks[0].command;
    assert.equal(settings.hooks.PreToolUse[0].matcher, "*", "hook must match EVERY tool");
    assert.match(hookCmd, /edit-guard-hook\.js/, "hook must invoke the guard script");
    // The referenced hook script must actually exist on disk (a dangling path = fail-open).
    const hookFile = hookCmd.match(/"([^"]+)"/)[1];
    assert.ok(existsSync(hookFile), "guard hook script referenced by settings must exist");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(cfg.envDir, { recursive: true, force: true });
  }
});

test("jobs.start with edit caps refuses (SnapshotError) outside a repo, leaving no job record", () => {
  const cfg = makeCfg(); // cwd is a plain temp dir, not a repo
  try {
    const jobs = createJobStore(cfg, null);
    assert.throws(() => jobs.start("prompt", "", "edit"), SnapshotError);
    assert.equal(jobs.current(), null, "no job record may exist after a refused edit job");
    assert.equal(existsSync(path.join(cfg.envDir, ".riffn-bridge-job.json")), false);
  } finally {
    rmSync(cfg.envDir, { recursive: true, force: true });
  }
});

test("agentCaps reports edit-jobs arming honestly (claude-only)", () => {
  assert.equal(agentCaps(makeCfg()), "read-plan");
  assert.equal(agentCaps(makeCfg({ allowEditJobs: true })), "read-plan+edit-jobs");
  assert.equal(agentCaps(makeCfg({ agent: "codex", allowEditJobs: true })), "read-plan");
  assert.equal(agentCaps(makeCfg({ agent: "custom", allowEditJobs: true })), "operator-defined");
});

// edit_mode_plan.md step 1 (hardened per the 2026-07-16 review): the codex chat path must pin the
// ENTIRE posture every turn — sandbox, isolated config, approval policy, shell env policy — since
// a bare `codex exec` inherits the operator's own ~/.codex/config.toml (how the dogfood edited
// files while /health said read-plan). read-only unless always-edit was chosen; caps must say so.
const CODEX_HARDENING = ["--ignore-user-config", "-c", "approval_policy=never", "-c", "shell_environment_policy.inherit=core"];
test("codex posture is pinned per edit mode, and caps report ungated honestly", () => {
  const readOnly = agentCommand(makeCfg({ agent: "codex", codexBin: "codex" }), "hi");
  assert.deepEqual(readOnly.args, ["exec", "--sandbox", "read-only", ...CODEX_HARDENING, "hi"]);

  const limited = agentCommand(makeCfg({ agent: "codex", codexBin: "codex", editMode: "limited" }), "hi");
  assert.deepEqual(limited.args, ["exec", "--sandbox", "read-only", ...CODEX_HARDENING, "hi"], "limited chat stays read-only");

  const ungated = agentCommand(makeCfg({ agent: "codex", codexBin: "codex", editMode: "ungated" }), "hi");
  assert.deepEqual(ungated.args, ["exec", "--sandbox", "workspace-write", ...CODEX_HARDENING, "hi"]);

  assert.equal(agentCaps(makeCfg({ agent: "codex", editMode: "ungated", allowEditJobs: true })), "ungated");
  assert.equal(agentCaps(makeCfg({ agent: "codex", editMode: "limited", allowEditJobs: true })), "read-plan");
  assert.equal(agentCaps(makeCfg({ editMode: "ungated", allowEditJobs: true })), "ungated", "claude ungated caps");
});

// Unknown/typo'd values must land on DISABLED, never a permissive tier. The legacy boolean aliases
// to limited only when EDIT_MODE is unset AND the agent is claude (the boolean was written by a
// Claude-only init prompt; switching agents by hand must not carry the arming decision along).
test("resolveEditMode: fail-closed parsing, deprecated spellings, agent-bound legacy alias", () => {
  assert.equal(resolveEditMode({}), "disabled");
  assert.equal(resolveEditMode({ RIFFIN_BRIDGE_EDIT_MODE: "ungated" }), "ungated");
  assert.equal(resolveEditMode({ RIFFIN_BRIDGE_EDIT_MODE: "full-access" }), "ungated", "deprecated spelling maps to ungated");
  assert.equal(resolveEditMode({ RIFFIN_BRIDGE_EDIT_MODE: "always-edit" }), "ungated", "deprecated spelling maps to ungated");
  assert.equal(resolveEditMode({ RIFFIN_BRIDGE_EDIT_MODE: "LIMITED" }), "limited");
  assert.equal(resolveEditMode({ RIFFIN_BRIDGE_EDIT_MODE: "un gated" }), "disabled", "typos fail closed");
  assert.equal(resolveEditMode({ RIFFIN_BRIDGE_ALLOW_EDIT_JOBS: "1" }, "claude"), "limited");
  assert.equal(resolveEditMode({ RIFFIN_BRIDGE_ALLOW_EDIT_JOBS: "1" }, "codex"), "disabled", "legacy boolean never arms a non-claude agent");
  assert.equal(
    resolveEditMode({ RIFFIN_BRIDGE_EDIT_MODE: "disabled", RIFFIN_BRIDGE_ALLOW_EDIT_JOBS: "1" }, "claude"),
    "disabled",
    "an explicit EDIT_MODE wins over the legacy boolean",
  );
});

// Central derivation (edit_mode_plan.md): both server handlers consult this one function, so its
// matrix IS the permission model. Ungated applies to every claude turn, requested or not; limited
// honors only an explicit armed request; codex/custom/llm never derive a write tier here.
test("effectiveCaps: the (mode × request × agent) permission matrix", () => {
  assert.equal(effectiveCaps(makeCfg(), undefined), "read");
  assert.equal(effectiveCaps(makeCfg(), "edit"), "read", "unarmed edit request derives read (server 403s it first)");
  assert.equal(effectiveCaps(makeCfg({ allowEditJobs: true }), "edit"), "edit");
  assert.equal(effectiveCaps(makeCfg({ allowEditJobs: true }), undefined), "read", "limited never writes without an explicit request");
  assert.equal(effectiveCaps(makeCfg({ editMode: "ungated", allowEditJobs: true }), undefined), "ungated");
  assert.equal(effectiveCaps(makeCfg({ editMode: "ungated", allowEditJobs: true }), "edit"), "ungated", "an explicit request under ungated stays on ungated semantics");
  assert.equal(effectiveCaps(makeCfg({ agent: "codex", editMode: "ungated", allowEditJobs: true }), undefined), "read", "codex writes are the sandbox flag's job, never a claude-shaped caps tier");
});

// Ungated jobs get the IDENTICAL containment argv as edit jobs — the tiers differ in session and
// snapshot semantics only — and, unlike edit jobs, they may carry --resume (the mode-stamped
// session store guarantees any resumed session was created under ungated, i.e. born locked-down).
test("buildJobArgs: ungated = edit containment + resumable session", () => {
  const edit = { mcpConfigPath: "/tmp/m.json", settingsPath: "/tmp/s.json" };
  const editArgs = buildJobArgs("p", "", "edit", null, edit);
  const ungatedArgs = buildJobArgs("p", "", "ungated", null, edit);
  assert.deepEqual(ungatedArgs, editArgs, "same containment flags, nothing more, nothing less");

  const resumed = buildJobArgs("p", "", "ungated", "sess-1", edit);
  assert.ok(resumed.includes("--resume"), "ungated jobs resume the mode-stamped session");
  assert.ok(resumed.includes("--settings"), "containment still present on resume");
});

// The ring keeps the newest `keep` snapshot refs and prunes older ones (review finding #6) —
// bounded undo for a chatty ungated commute, capture still fail-closed (snapshotRepo's throw
// propagates; only pruning is best-effort).
test("snapshotRepoRing prunes beyond the keep bound, newest kept", () => {
  const repo = makeRepo();
  try {
    const refs = [];
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(repo, "a.txt"), `turn ${i}\n`);
      refs.push(snapshotRepoRing(repo, 3).ref);
    }
    const out = spawnSync("git", ["for-each-ref", "--format=%(refname)", "refs/riffn/"], { cwd: repo, encoding: "utf8" }).stdout;
    const kept = out.split("\n").filter(Boolean);
    assert.equal(kept.length, 3, "ring holds exactly `keep` refs");
    assert.ok(kept.includes(refs[4]), "newest snapshot survives");
    assert.ok(!kept.includes(refs[0]) && !kept.includes(refs[1]), "oldest snapshots pruned");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// Mode-stamped sessions (review finding #4): a session only resumes under the edit mode it was
// created with — flipping the mode makes the stored session stale, in BOTH directions, and
// pre-stamping session files (no editMode field) are treated as created under "disabled".
test("session store: mode stamping blocks cross-mode resume", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "riffn-test-session-"));
  try {
    const ungatedStore = createSessionStore(dir, "/repo", "ungated");
    ungatedStore.set("sess-ungated");
    assert.equal(ungatedStore.get(), "sess-ungated", "same mode resumes");
    assert.equal(createSessionStore(dir, "/repo", "disabled").get(), null, "stricter mode refuses a permissive session");

    const disabledStore = createSessionStore(dir, "/repo", "disabled");
    disabledStore.set("sess-plain");
    assert.equal(createSessionStore(dir, "/repo", "ungated").get(), null, "ungated refuses a pre-lockdown session");

    // Legacy file without a mode stamp → treated as disabled.
    writeFileSync(path.join(dir, ".riffn-bridge-session.json"), JSON.stringify({ cwd: "/repo", sessionId: "old" }));
    assert.equal(createSessionStore(dir, "/repo", "disabled").get(), "old");
    assert.equal(createSessionStore(dir, "/repo", "ungated").get(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// End-to-end over HTTP: on an ungated claude bridge, a PLAIN job dispatch (no caps field) runs
// write-capable — edit containment, snapshotted — and /health reports the tier on both the legacy
// string and the structured capabilities object.
test("ungated bridge: plain job dispatch is write-capable + snapshotted; /health reports it", async () => {
  const repo = makeRepo();
  const cfg = makeCfg({ cwd: repo, editMode: "ungated", allowEditJobs: true });
  try {
    await withServer(cfg, async (base) => {
      const res = await fetch(`${base}/v1/jobs`, {
        method: "POST", headers: authed,
        body: JSON.stringify({ messages: [{ role: "user", content: "go" }] }),
      });
      assert.equal(res.status, 202);
      const { job } = await res.json();
      assert.equal(job.caps, "edit", "wire caps vocabulary stays read|edit");
      assert.equal(job.snapshotted, true, "every ungated turn snapshots first");

      const health = await (await fetch(`${base}/health`, { headers: authed })).json();
      assert.equal(health.caps, "ungated");
      assert.equal(health.capabilities.editMode, "ungated");
      assert.equal(health.capabilities.chatWrites, true);
      assert.equal(health.capabilities.shell, "none");
      assert.equal(health.capabilities.snapshotPolicy, "per-turn-ring");
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(cfg.envDir, { recursive: true, force: true });
  }
});

// Bridge secrets must never reach a spawned agent (review finding #2): the pairing token and any
// provider keys are RIFFIN_BRIDGE_-prefixed, and Codex runs a sandboxed shell even at read-only.
test("childEnv strips every RIFFIN_BRIDGE_* var and keeps everything else", () => {
  const env = childEnv({ PATH: "/bin", HOME: "/h", RIFFIN_BRIDGE_TOKEN: "secret", RIFFIN_BRIDGE_TTS_KEY: "k" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/h" });
});

// Agent-bound arming (review finding #7): the EDIT_MODE_AGENT stamp written by init degrades a
// non-disabled mode to disabled when the running agent no longer matches — via readConfig, since
// the stamp check lives there (resolveEditMode alone stays a pure value parser).
test("readConfig degrades a stamped edit mode to disabled on agent mismatch", async () => {
  const { readConfig } = await import("../src/config.js");
  const saved = {};
  const vars = {
    RIFFIN_BRIDGE_AGENT: "codex",
    RIFFIN_BRIDGE_EDIT_MODE: "ungated",
    RIFFIN_BRIDGE_EDIT_MODE_AGENT: "claude", // chosen for claude, running codex
  };
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  try {
    let cfg = readConfig();
    assert.equal(cfg.editMode, "disabled", "mismatched stamp degrades to disabled");
    assert.equal(cfg.editModeAgentMismatch, true);

    process.env.RIFFIN_BRIDGE_EDIT_MODE_AGENT = "codex"; // stamp matches → mode honored
    cfg = readConfig();
    assert.equal(cfg.editMode, "ungated");
    assert.equal(cfg.editModeAgentMismatch, false);

    delete process.env.RIFFIN_BRIDGE_EDIT_MODE_AGENT;    // no stamp (hand-written .env) → honored
    cfg = readConfig();
    assert.equal(cfg.editMode, "ungated");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    delete process.env.RIFFIN_BRIDGE_EDIT_MODE_AGENT;
    if (saved.RIFFIN_BRIDGE_EDIT_MODE_AGENT !== undefined) process.env.RIFFIN_BRIDGE_EDIT_MODE_AGENT = saved.RIFFIN_BRIDGE_EDIT_MODE_AGENT;
  }
});

// Spin the real server on an ephemeral port and drive the two-key gate over HTTP.
async function withServer(cfg, fn) {
  const server = startServer(cfg);
  await new Promise((resolve) => server.on("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

const authed = { "Authorization": "Bearer test-token", "Content-Type": "application/json" };
const editJobBody = JSON.stringify({ caps: "edit", messages: [{ role: "user", content: "go" }] });

test("POST /v1/jobs caps:edit without the workstation flag → 403, speakable", async () => {
  const cfg = makeCfg(); // allowEditJobs: false
  try {
    await withServer(cfg, async (base) => {
      const res = await fetch(`${base}/v1/jobs`, { method: "POST", headers: authed, body: editJobBody });
      assert.equal(res.status, 403);
      const { error } = await res.json();
      assert.match(error.message, /hasn't enabled edit tasks/);
      // And /health still says the honest caps.
      const health = await (await fetch(`${base}/health`, { headers: authed })).json();
      assert.equal(health.caps, "read-plan");
    });
  } finally {
    rmSync(cfg.envDir, { recursive: true, force: true });
  }
});

test("POST /v1/jobs caps:edit with flag but un-snapshottable cwd → 503, no job started", async () => {
  const cfg = makeCfg({ allowEditJobs: true }); // cwd is not a git repo
  try {
    await withServer(cfg, async (base) => {
      const res = await fetch(`${base}/v1/jobs`, { method: "POST", headers: authed, body: editJobBody });
      assert.equal(res.status, 503);
      const { error } = await res.json();
      assert.match(error.message, /Couldn't snapshot the repo/);
      const jobRes = await (await fetch(`${base}/v1/jobs`, { headers: authed })).json();
      assert.equal(jobRes.job, null, "refused edit job must not leave a job record");
      const health = await (await fetch(`${base}/health`, { headers: authed })).json();
      assert.equal(health.caps, "read-plan+edit-jobs");
    });
  } finally {
    rmSync(cfg.envDir, { recursive: true, force: true });
  }
});

test("edit jobs never resume the chat session (fresh session; no --resume)", () => {
  // With an existing chat session present, a READ job resumes it but an EDIT job must not — the
  // fresh-session rule is the fix for the resume-inherits-permissions dogfood finding.
  const sessionStub = { _id: "chat-session-123", get() { return this._id; }, set(v) { this._id = v; }, clear() { this._id = null; } };
  const repo = makeRepo();
  const cfg = makeCfg({ cwd: repo, allowEditJobs: true });
  try {
    // Read job: buildJobArgs (via the same code path) would include --resume; assert the store
    // passes the existing session through for read but not for edit by checking buildJobArgs.
    const readArgs = buildJobArgs("p", "", undefined, sessionStub.get());
    assert.ok(readArgs.includes("--resume"), "read jobs still resume the chat session");

    // Edit path passes sessionId=null (fresh) — assert buildJobArgs omits --resume when null.
    const editArgs = buildJobArgs("p", "", "edit", null,
      { mcpConfigPath: "/tmp/m.json", settingsPath: "/tmp/s.json" });
    assert.ok(!editArgs.includes("--resume"), "edit jobs must NOT resume any session");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(cfg.envDir, { recursive: true, force: true });
  }
});

test("plain (read) job dispatch is unaffected by the caps field being absent", async () => {
  // claudeBin doesn't exist, so the job errors AFTER starting — proving the read path still
  // dispatches (the gate only intercepts caps:"edit").
  const cfg = makeCfg({ allowEditJobs: true });
  try {
    await withServer(cfg, async (base) => {
      const res = await fetch(`${base}/v1/jobs`, {
        method: "POST", headers: authed,
        body: JSON.stringify({ messages: [{ role: "user", content: "go" }] }),
      });
      assert.equal(res.status, 202);
      const { job } = await res.json();
      assert.equal(job.caps, "read");
      assert.equal(job.snapshotted, false);
    });
  } finally {
    rmSync(cfg.envDir, { recursive: true, force: true });
  }
});
