#!/usr/bin/env node
// PreToolUse hook for EDIT jobs — the airtight tool veto (execute_jobs_plan.md invariant 4).
//
// Claude Code runs this as a shell-command hook before EVERY tool call in an edit job (the job's
// --settings file registers it with matcher "*"). It reads the tool-call JSON on stdin, and:
//   - allows the call (exit 0, empty output) iff the tool is on the edit allowlist;
//   - DENIES it otherwise, by printing the documented deny object and exiting 0.
//
// Per the Claude Code permission docs this deny "applies even in bypassPermissions mode" and runs
// "before every other step", so it is the one control that catches tools the CLI would otherwise
// treat as safe/auto-allowed (the `CronList`/`Monitor` class the first dogfood exposed). It has NO
// dependency on --allowedTools being exclusive.
//
// Fail-CLOSED: any malformed input, parse error, or unexpected shape → DENY. A hook that can't
// understand the request must not let it through.

import { isEditToolAllowed, isEditPathAllowed } from "./edit-policy.js";

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function allow() {
  // Explicit allow so the edit/read/web tools run without a prompt regardless of permission mode.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
  }));
  process.exit(0);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return deny("edit-task tool guard: unreadable tool request");
  }
  const toolName = input?.tool_name;
  if (typeof toolName !== "string" || !toolName) {
    return deny("edit-task tool guard: missing tool name");
  }
  if (!isEditToolAllowed(toolName)) {
    return deny(
      `Edit tasks may only read and edit files (and search the web) — the '${toolName}' tool is ` +
      `blocked. Command execution, git, subagents, and external services are not available in an ` +
      `edit task.`
    );
  }
  // Second gate, write tools only: the target must live inside the working directory. Needed
  // because our explicit allow below bypasses Claude Code's own outside-cwd permission check.
  // The hook payload's `cwd` is the session's working directory (= the repo the bridge pinned);
  // fall back to the hook process's own cwd, which Claude Code also runs in the session dir.
  if (!isEditPathAllowed(toolName, input?.tool_input, input?.cwd || process.cwd())) {
    return deny(
      `Edit tasks may only write files inside the working directory — that '${toolName}' target ` +
      `is outside it (or missing). Work within the repo the bridge is pointed at.`
    );
  }
  return allow();
});
// If stdin never closes (shouldn't happen for a hook), fail closed on the timeout side too.
process.stdin.on("error", () => deny("edit-task tool guard: input error"));
