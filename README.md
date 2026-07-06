# @riffn/bridge

Voice-drive **your own** agent from Riffn. A tiny, **zero-dependency** Node helper that presents an
**OpenAI-compatible** `/v1/chat/completions` endpoint and forwards each turn to a local CLI agent —
**Claude Code** (`claude -p`) or **Codex** — on your own always-on machine, reached over Tailscale.

Because Riffn already talks OpenAI-compatible HTTP to a pasted **Model URL**, you point Riffn at this
helper and talk to the agent on your own machine — **no app changes, no worker changes, no deploy.**

> ⚠️ This is **remote code execution into your machine.** It stays on your tailnet, requires a bearer
> token, and — in this version — runs the agent **read/plan-only** (no file writes, no command
> execution). Enabling write/exec is a separate, security-reviewed project; see the plan.

This is the **Phase 1.5 minimal cut** — see [`../../dev_resources/bridge_plan.md`](../../dev_resources/bridge_plan.md) §7.1.

---

## Requirements

- Node 18+
- An agent CLI installed: `claude` (Claude Code) or `codex`
- [Tailscale](https://tailscale.com/) running on this machine **and** on your phone

## Quick start

```bash
cd tools/riffn-bridge     # (repo folder is tools/riffin-bridge)
node index.js init
```

`init` will: detect your agent → generate a bearer token → check Tailscale → print a **pairing QR** →
run in the **foreground** (Ctrl-C to stop). Then in Riffn: **Link my machine → scan the QR.**

(If `qrencode` isn't installed it prints the pairing payload as text instead; install `qrencode` for
a scannable code, or paste the payload into Riffn's manual-link field.)

## Commands

| Command | What it does |
|---|---|
| `riffn-bridge init` | Setup wizard: detect agent, token, verify Tailscale, print QR, run foreground. |
| `riffn-bridge start` | Start using existing `.env` / environment. |
| `riffn-bridge rotate` | Generate a new bearer token (invalidates the old QR). |
| `riffn-bridge reset-session` | Clear the persistent agent session (next turn starts fresh). |
| `riffn-bridge health` | Print effective config (redacted) without starting. |
| `riffn-bridge help` | Usage. |

## Endpoints

- `GET /` — public liveness (`{status, version}`), no secrets.
- `GET /health` — **authenticated**; returns `{mode, agent, cwd (redacted), tts, caps, version}`. This
  is what the app shows after pairing.
- `POST /v1/chat/completions` — the chat turn. **Single-flight**: a second concurrent turn gets `429`
  rather than spawning a second agent against the same directory. Cancels the agent if the client
  disconnects.
- `GET /v1/models`, `POST /v1/audio/speech` — OpenAI-compatible model list / optional TTS.
- `POST /v1/notes` — save a voice note into `riffn-notes/` (see **Voice notes** below).

## HTTPS via `tailscale serve` (recommended for iOS)

iOS prefers HTTPS. Bind loopback and let Tailscale terminate TLS on your `.ts.net` name:

```bash
RIFFIN_BRIDGE_HOST=127.0.0.1 node index.js start
# in another shell:
tailscale serve --bg 8765
```

Use `https://<machine>.<tailnet>.ts.net/v1` as the Model URL.

## Security posture (v1)

- **Read/plan-only** — the agent is never granted write/execute permission (no `acceptEdits`, no
  `RIFFIN_BRIDGE_AGENT_CAPS`). Write/exec + a voice-approval gate is a separate, gated project.
- **Tailnet-only bind** by default; refuses `0.0.0.0` unless `RIFFIN_BRIDGE_ALLOW_PUBLIC=1`.
- **Bearer token** on every request (constant-time compare); 1 MB body cap.
- Agent/TTS invoked with **argument arrays**, never a shell string.
- **Single-flight** + per-request **timeout & cancel**.
- **Redact-by-default logs** — token, prompts, code, cwd, subprocess args, and URLs are never logged
  at default verbosity. `RIFFIN_BRIDGE_VERBOSE=1` enables diagnostics (may capture sensitive data).
- **Zero runtime dependencies** (Node built-ins only).

## Agent jobs (Claude only)

Short questions answer synchronously (the chat path). For a **long task** the app dispatches a
**job** — the agent runs in the background while you pocket the phone, and Riffn tells you when it's
done. Endpoints:

- `POST /v1/jobs` `{messages}` → starts a job, returns its id + status immediately (202).
- `GET /v1/jobs` → the current/latest job's status, progress (step count + activity *category* only,
  never file contents), and the result once done.
- `POST /v1/jobs/cancel` → stop the running job.

One job at a time per bridge (same cwd-safety as chat). Job state is a small local file
(`.riffn-bridge-job.json`, next to `.env` — gitignored); a job left running when the helper is
restarted is reported as `interrupted`, not a forever-"running" lie. By voice: *"run a task: …"*,
*"how's my task going?"*, *"read me the result"*, *"stop my task"*.

## Voice notes

Capture ideas into the repo hands-free: `POST /v1/notes` `{text}` writes
`riffn-notes/<date>-<slug>.md` under the bridge's working directory and returns the file path
(201). The **helper** writes the file — the agent's read/plan-only caps are untouched, and the
model never chooses a path. The folder name is fixed on purpose (nothing to misconfigure); commit
the notes or `.gitignore` the folder per repo, your call. By voice: *"take a note: …"* (dictated
content) or *"note that"* (saves the last exchange).

## Persistent agent session (Claude only)

Once you're paired, the bridge keeps **one continuing Claude Code conversation** on this machine —
each turn resumes it via `claude --resume`, instead of starting a memory-less session every time.
The session survives helper restarts (it's a small local file, `.riffn-bridge-session.json`, next to
`.env` — gitignored, never sent to the phone). Point the bridge at a different working directory and
it starts a fresh thread automatically. If a resume ever fails (corrupted/expired session), the
helper self-heals by starting a new thread rather than erroring. Run `riffn-bridge reset-session`
any time you want to start over on purpose. Codex doesn't have this wired yet — it stays stateless.

Note this is a session on **this machine**, not this terminal/IDE — it's a separate `claude -p`
process each turn, so it won't show up in an interactive `claude` session you have open elsewhere.

## Custom CLI agents (any model working on a repo)

Beyond Claude Code and Codex, any coding-agent CLI works via `RIFFIN_BRIDGE_AGENT=custom` +
`RIFFIN_BRIDGE_AGENT_BIN` + `RIFFIN_BRIDGE_AGENT_ARGS` (a template where `{prompt}` becomes one
argument — argument array, never a shell). Example for aider against any OpenAI-compatible endpoint:

```
RIFFIN_BRIDGE_AGENT=custom
RIFFIN_BRIDGE_AGENT_BIN=aider
RIFFIN_BRIDGE_AGENT_ARGS=--message {prompt} --no-auto-commits
```

⚠️ riffn-bridge **cannot enforce read-only on an arbitrary CLI** — whatever permissions that tool
has, voice turns have. Configure the tool itself; `/health` reports `caps: operator-defined` so the
app shows the honest state. Custom agents are stateless (no session continuity yet).

## Running several bridges on one machine

Each bridge needs its **own launch folder** (session state lives there) and its **own port** —
`init` auto-picks a free port and saves it; `start` on a busy port fails with instructions. Give
each machine a **speakable name** when pairing: "Switch to *name*" changes machines by voice.

## Not in this cut

Service install, tunnel auto-config, cloudflared, a "Bridge profile" abstraction, Mode B
streaming/audio, and write/exec are later phases (see the plan). This cut is the onboarding proof:
link, trust, talk (read/plan-only), over Tailscale.

## Troubleshooting

- **"No agent found"** — install `claude` or `codex` (or set `RIFFIN_BRIDGE_CLAUDE_BIN`).
- **"Not ready to pair" / Tailscale** — the wizard tells you exactly what to run (`tailscale up`); it
  never runs privileged commands for you.
- **401 from Riffn** — the paired token must exactly match `RIFFIN_BRIDGE_TOKEN`. Rotated it? Re-pair.
- **429 busy** — a turn is already in flight; the bridge serves one turn at a time.
- **Agent error** — run `claude -p "hello" --output-format json` by hand in your working directory to
  see the real error, or set `RIFFIN_BRIDGE_VERBOSE=1` for the message.
