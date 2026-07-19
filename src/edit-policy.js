// The single source of truth for what an EDIT job's agent may touch (execute_jobs_plan.md
// invariant 4). Imported by BOTH jobs.js (to build the claude flags) and edit-guard-hook.js (the
// PreToolUse hook that enforces it per-call) so the flag policy and the runtime veto can never
// drift apart. Kept a dependency-free leaf module: the hook re-imports it in a fresh process on
// every single tool call, so it must stay cheap.
//
// WHY A HOOK AT ALL — the first dogfood (2026-07-12) proved CLI allow/deny FLAGS are not
// sufficient on their own: `--allowedTools` is not exclusive (an unlisted `CronList` still ran),
// and a denylist can't name every present-and-future tool. Per the Claude Code docs, a PreToolUse
// hook is the ONLY control that "runs before every other step" and whose deny "applies even in
// bypassPermissions mode" — i.e. it sees EVERY tool call and can veto regardless of tool
// classification. That hook is the actual guarantee; the flags below are fail-closed backup.

import path from "node:path";

// Exactly "read the repo, edit the repo, look things up on the web" (web is the maintainer's
// 2026-07-12 decision). NO command execution, NO subagents, NO git, NO MCP.
export const EDIT_JOB_ALLOWED_TOOLS = [
  "Read", "Edit", "Write", "MultiEdit", "NotebookEdit", // touch the repo
  "Glob", "Grep", "LS",                                 // navigate the repo
  "WebFetch", "WebSearch",                              // look things up (allowed by decision)
];

// Named execution/delegation built-ins, denied as an extra backstop (deny rules apply even in
// bypass mode). Not the guarantee — the hook is — but cheap insurance against the specific tools
// the dogfood surfaced.
export const EDIT_JOB_DISALLOWED_TOOLS = ["Bash", "BashOutput", "KillShell", "Task", "Agent", "Monitor", "TaskOutput"];

// The allow decision, shared by the hook. A tool is permitted iff its bare name is on the
// allowlist. MCP tools (mcp__server__action) are never on it, so they're denied — matching the
// --strict-mcp-config intent even if that flag is absent on some CLI version.
export function isEditToolAllowed(toolName) {
  return EDIT_JOB_ALLOWED_TOOLS.includes(toolName);
}

// The write-capable tools and the tool_input field naming their target. Read/Glob/Grep/web stay
// path-unrestricted — the boundary is on WRITES, because the hook's explicit "allow" bypasses
// Claude Code's own outside-cwd permission check (the gap this closes: without it, an ungated or
// edit turn could Write anywhere the OS user can, and the snapshot ring only covers the repo).
const WRITE_TOOL_PATH_FIELDS = {
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

// Path boundary for write tools: the target must resolve INSIDE the job's working directory.
// Fail-closed like everything else here — a write tool with a missing/unreadable path is denied.
// This is containment against a confused agent, not a kernel sandbox: symlink escapes are out of
// scope (SECURITY.md), and non-write tools return true (no path to judge).
export function isEditPathAllowed(toolName, toolInput, cwd) {
  const field = WRITE_TOOL_PATH_FIELDS[toolName];
  if (!field) return true;
  const target = toolInput?.[field];
  if (typeof target !== "string" || !target) return false;
  if (typeof cwd !== "string" || !cwd) return false;
  const root = path.resolve(cwd);
  // path.relative is case-insensitive on win32, so "c:\repo" vs "C:\Repo" still compares inside.
  const rel = path.relative(root, path.resolve(root, target));
  // Outside iff the walk starts with a ".." segment (a "..foo" FILE inside the root is fine) or
  // relative() had to fall back to an absolute path (different drive/UNC root on Windows).
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
