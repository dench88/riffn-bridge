# Security Policy

riffn-bridge is RCE-shaped software by design: it accepts authenticated requests from your
phone and drives a coding agent on your machine. We treat its security accordingly —
read/plan-only agent defaults, tailnet-only binding, bearer-token auth with rotation,
argument-array subprocess execution (never a shell string), redact-by-default logging, and
zero runtime dependencies. Details are in the README's security section.

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
- The write-path boundary (edit tasks may only write inside the working directory) is lexical
  containment against a confused agent, not a kernel sandbox: escapes via symlinks/junctions
  inside the repo are an accepted, documented residual in v1.

## Supported versions

The latest published minor version. Pin your install (`npx @riffn/bridge@x.y.z`) and update
deliberately.
