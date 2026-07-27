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
export const READ_JOB_ALLOWED_TOOLS = [
  "Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch",
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

export function isReadToolAllowed(toolName) {
  return READ_JOB_ALLOWED_TOOLS.includes(toolName);
}

// File tools and the tool_input field naming their target. Glob/Grep/LS may omit the path, which
// means the pinned cwd. Every other file tool fails closed when its target is absent. The hook's
// explicit allow bypasses Claude Code's own outside-cwd prompt, so both reads and writes need this
// bridge-side boundary.
const FILE_TOOL_PATHS = {
  Read: { field: "file_path", write: false, optional: false },
  Glob: { field: "path", write: false, optional: true },
  Grep: { field: "path", write: false, optional: true },
  LS: { field: "path", write: false, optional: true },
  Edit: { field: "file_path", write: true, optional: false },
  Write: { field: "file_path", write: true, optional: false },
  MultiEdit: { field: "file_path", write: true, optional: false },
  NotebookEdit: { field: "notebook_path", write: true, optional: false },
};

const PROTECTED_WRITE_SEGMENTS = new Set([
  ".venv", ".vscode", ".claude", ".codex", ".agents", "node_modules",
]);

function relativeInside(root, target) {
  const rel = path.relative(root, path.resolve(root, target));
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel : null;
}

function isSensitiveRelativePath(relative) {
  const parts = relative.split(path.sep).filter(Boolean);
  const basename = (parts.at(-1) || "").toLowerCase();
  if (basename === ".env" || basename.endsWith(".env") || basename.startsWith(".env.")) return true;
  return parts.length >= 2
    && parts.at(-2).toLowerCase() === "workers"
    && basename.startsWith(".dev.vars");
}

function isProtectedWritePath(relative) {
  return relative.split(path.sep).filter(Boolean)
    .some((segment) => PROTECTED_WRITE_SEGMENTS.has(segment.toLowerCase()));
}

// Path boundary for all file tools: targets stay inside cwd, secret files cannot be read or
// written, and host-consumed automation subtrees cannot be written. This is lexical containment,
// not a kernel sandbox; symlink/junction escapes remain an accepted limitation in SECURITY.md.
export function isEditPathAllowed(toolName, toolInput, cwd, options = {}) {
  const spec = FILE_TOOL_PATHS[toolName];
  if (!spec) return true; // Web tools have no filesystem target.
  if (typeof cwd !== "string" || !cwd) return false;
  const target = toolInput?.[spec.field];
  if ((target === undefined || target === null || target === "") && spec.optional) return true;
  if (typeof target !== "string" || !target) return false;
  const root = path.resolve(cwd);
  const absoluteTarget = path.resolve(root, target);
  const relative = relativeInside(root, absoluteTarget);
  if (relative === null || isSensitiveRelativePath(relative)) return false;
  if (spec.write && (options.protectedRoots || []).some(
    (protectedRoot) => relativeInside(path.resolve(protectedRoot), absoluteTarget) !== null
  )) return false;
  return !spec.write || !isProtectedWritePath(relative);
}
