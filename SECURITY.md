# Security Policy

riffn-bridge is RCE-shaped software by design: it accepts authenticated requests from your
phone and drives a coding agent on your machine. We treat its security accordingly —
read/plan-only agent defaults, tailnet-only binding, bearer-token auth with rotation,
argument-array subprocess execution (never a shell string), redact-by-default logging, and
zero runtime dependencies. Details are in the README's security section.

Direct Codex bridges are disabled by policy. On native Windows, Codex file-read denials apply to
direct file tools but do not reliably constrain shell subprocess reads. `--agent codex` and
`RIFFIN_BRIDGE_AGENT=codex` therefore fail closed. WSL2 support is postponed; users wanting an
OpenAI model should route it through the supported Claude Code harness.

## Reporting a vulnerability

**Please do not open a public issue for security reports.**

- Preferred: use GitHub's private vulnerability reporting — the **Security** tab of this
  repository → **Report a vulnerability**.
- Alternative: the contact form at <https://riffn.io>.

## What to expect

- Acknowledgement within **72 hours**.
- An assessment and remediation plan (or a reasoned "not a vulnerability") within **14 days**.
- Credit in the release notes if you'd like it, once a fix ships.

## Scope notes

- The bearer token is intentionally a bearer credential (no per-request signing in v1) — an
  accepted, documented residual. Reports about consequences that assume a *leaked* token are
  still welcome if they show an escalation beyond the documented blast radius.
- The agent runs with the permissions the operator configured. Reports that the agent can do
  what the operator allowed it to do are not vulnerabilities; reports that it can do MORE than
  that absolutely are.
- Agent output is untrusted until the operator has reviewed its recorded snapshot diff. Source
  files, package manifests, and test configuration remain editable by design, so
  unsandboxed host commands, development servers, tests, package scripts, and extension reloads
  must not consume unreviewed agent output.
- Claude edit turns deny shell, Git, MCP, subagents, outside-workspace file access, secret-file
  access, and writes to known host-consumed automation/dependency subtrees. Editable source remains
  a host-handoff risk: review changes before running tests, builds, package scripts, or extensions.
- The live bridge package directory is write-protected, including when the helper is run from
  source inside the bridged workspace, so a turn cannot weaken its own hook mid-session.
- File-path containment is lexical, not a kernel sandbox. Escapes via symlinks/junctions inside
  the repo remain an accepted residual.
- An Anthropic-compatible gateway sends repo content to its configured model provider and holds
  provider credentials. Keep gateway credentials outside the workspace and treat the gateway as
  part of the trusted local computing base.

## Supported versions

The latest published minor version. Pin your install (`npx @riffn/bridge@x.y.z`) and update
deliberately.

## Direct Codex re-enable checklist

Direct Codex remains parked unless all of these are complete:

1. Review current Codex release notes and security advisories.
2. Update the pinned profiles, disabled surfaces, and minimum version if required.
3. Pass the bridge security/unit tests in CI.
4. Run the complete disposable security probe against the exact installed version, including the
   maintainer-only Git cases.
5. Change the product kill switch only after the probe writes a successful exact-version record.
