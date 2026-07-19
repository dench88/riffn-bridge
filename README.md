# @riffn/bridge

Voice-drive **your own** agent from Riffn. A tiny, **zero-dependency** Node helper that presents an
**OpenAI-compatible** `/v1/chat/completions` endpoint and forwards each turn to a local CLI agent —
**Claude Code** (`claude -p`) or **Codex** — on your own always-on machine, reached over Tailscale.

Because Riffn already talks OpenAI-compatible HTTP to a pasted **Model URL**, you point Riffn at this
helper and talk to the agent on your own machine — **no app changes, no worker changes, no deploy.**

> ⚠️ This is **remote code execution into your machine.** It stays on your tailnet, requires a
> bearer token, and runs the agent **read/plan-only** by default. What it may write is one
> explicit choice, made on this machine, never from the phone — `RIFFIN_BRIDGE_EDIT_MODE`:
> **disabled** (default: no writes anywhere), **limited** (one voice-confirmed edit task at a
> time, snapshot-first), or **ungated** (any turn may edit — requires typing an acknowledgement
> at `init`). See "Edit modes" below, including what each tier honestly means on Codex.

This is the **Phase 1.5 minimal cut** of the bridge plan: link + trust, deliberately small.

---

## Requirements

- Node 18+
- An agent CLI installed: `claude` (Claude Code) or `codex`
- [Tailscale](https://tailscale.com/) running on this machine **and** on your phone

## Quick start

In the repo (working directory) you want to talk to:

```bash
npx @riffn/bridge@0.4.3 init
```

**Pin the version** (as above) rather than running a floating `npx @riffn/bridge` — you're
executing code that drives an agent on your machine; pinning means the code you audited is the
code you run. Update deliberately.

Running from a clone instead (dev / audit-first):

```bash
node index.js init
```

## What leaves my machine?

**Nothing goes to Riffn's servers — they are never in the path.** Your phone talks straight to
this helper over your own tailnet, and the helper drives the agent CLI you already installed:

- Prompts and replies go to **your** model provider (Anthropic / OpenAI) via **your** CLI and
  **your** API account — exactly the same data flow as typing into Claude Code in a terminal.
- The helper sends your phone only what you asked for: the reply text, job status (step counts
  and activity *categories*, never file contents), and the redacted health summary.
- No telemetry, no analytics, no crash reporting. Logs stay on your machine and redact the
  token, prompts, code, and paths by default.
- The one new trust surface is this helper itself — which is why it's ~100 KB of dependency-free
  source you can read before running, published from CI with npm provenance.

## Keeping it running

v1 is deliberately a **foreground process** — no background service is installed on your
machine (that's a feature until you decide otherwise). Practical recipes:

- **tmux / screen:** `tmux new -s riffn-bridge`, run `npx @riffn/bridge@0.4.3 start`, detach
  (`Ctrl-B D`). Survives closing the terminal window; not a reboot.
- **Keep the machine awake:** macOS `caffeinate -s`, Windows *Settings → Power → never sleep
  when plugged in* (or `powercfg /change standby-timeout-ac 0`), Linux inhibit as you prefer.
- If the machine does sleep or the helper stops, nothing breaks: Riffn shows the machine as
  offline and your phone falls back to hosted chat; restart the helper and "switch to" it again.
  A job left running when the helper dies is honestly reported as `interrupted`, never lost as
  forever-"running".

`init` will: detect your agent → generate a bearer token → check Tailscale → print a **pairing QR** →
run in the **foreground** (Ctrl-C to stop). Then in Riffn: **Link my machine → scan the QR.**

(If `qrencode` isn't installed it prints the pairing payload as text instead; install `qrencode` for
a scannable code, or paste the payload into Riffn's manual-link field.)

## Commands

| Command | What it does |
|---|---|
| `riffn-bridge init` | Setup wizard: detect agent, token, verify Tailscale, print QR, run foreground. `--agent claude\|codex` picks the CLI agent explicitly (persisted to `.env`); otherwise detection prefers Claude. `--edit-mode disabled\|limited\|ungated` skips the edit-capability prompt (ungated still requires the typed acknowledgement — see "Edit modes"). |
| `riffn-bridge start` | Start using existing `.env` / environment. |
| `riffn-bridge rotate` | Generate a new bearer token (invalidates the old QR). |
| `riffn-bridge reset-session` | Clear the persistent agent session (next turn starts fresh). |
| `riffn-bridge health` | Print effective config (redacted) without starting. |
| `riffn-bridge help` | Usage. |

## Endpoints

- `GET /` — public liveness (`{status, version}`), no secrets.
- `GET /health` — **authenticated**; returns `{mode, agent, cwd (redacted), tts, caps, capabilities,
  version}`. `capabilities` is the structured permission report — `{editMode, chatWrites, editJobs,
  shell, snapshotPolicy}` — because file-edit permission and shell permission are independent axes
  one `caps` string can't carry (Codex runs a sandboxed shell even read-only; Claude never runs one).
  This is what the app shows after pairing.
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

- **Read/plan-only by default** — chat turns and plain jobs never get write permission unless the
  operator chose an edit mode on this machine (see "Edit modes" below): `limited` is two-key armed
  (workstation opt-in + per-task spoken confirmation), `ungated` requires a typed acknowledgement
  at `init`. Claude never gets command execution at any tier; Codex's sandbox contains what
  commands can do, not whether they run — stated honestly per tier below.
- **Which model answers is your CLI's choice, not the bridge's** — the bridge never passes a model
  flag. Claude uses your Claude Code install's configured default; Codex (run with an isolated
  config — see the Codex note below) uses its built-in default. If model cost matters to you, set
  your CLI's default deliberately before pairing.
- **Tailnet-only bind** by default; refuses `0.0.0.0` unless `RIFFIN_BRIDGE_ALLOW_PUBLIC=1`.
- **Bearer token** on every request (constant-time compare); 1 MB body cap.
- Agent/TTS invoked with **argument arrays**, never a shell string.
- **Single-flight** + per-request **timeout & cancel**.
- **Redact-by-default logs** — token, prompts, code, cwd, subprocess args, and URLs are never logged
  at default verbosity. `RIFFIN_BRIDGE_VERBOSE=1` enables diagnostics (may capture sensitive data).
- **Zero runtime dependencies** (Node built-ins only).
- Releases are published **from CI only, with npm provenance** — verify the attestation on the
  package's npm page. Vulnerability reports: see [SECURITY.md](SECURITY.md) (please don't open
  public issues for security findings). License: [Apache-2.0](LICENSE).
- Disclaimer: this helper executes an agent on **your** machine; you control its permissions —
  run at your own risk.

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

## Edit modes — disabled / limited / ungated

One operator control, chosen at `init` (or `RIFFIN_BRIDGE_EDIT_MODE` in `.env`), same meaning for
every agent. It can never be changed from the phone — a paired phone, or a stolen token, cannot
raise its own permissions.

| Mode | What a turn may do |
|---|---|
| `disabled` (default) | Nothing writes, ever. |
| `limited` | Chat stays read-only; ONE voice-confirmed edit **task** at a time may edit files (Claude only). |
| `ungated` | The confirmation gate is off: **any turn** may edit files. Permitted every turn — not performed every turn. |

(`full-access` / `always-edit` are deprecated spellings of `ungated` and warn on start. The old
`RIFFIN_BRIDGE_ALLOW_EDIT_JOBS=1` boolean still reads as `limited` — for Claude only; an arming
decision never carries to a different agent, which is also why `init` stamps the mode with the
agent it was chosen for and degrades to `disabled` if you later switch agents by hand.)

### `limited` — voice-confirmed edit tasks (Claude only)

Talk through a plan with the agent, then say *"execute the plan"* — after a spoken confirmation,
the agent runs ONE task with permission to **edit files** in the working directory. It still can
NOT run commands (no tests, no installs), has no git access (can never commit or push), no
subagents, and no MCP/external tools (no email, calendar, remote triggers).

**How that's enforced (defence in depth):** the edit task runs under a **PreToolUse hook**
(`src/edit-guard-hook.js`) that Claude Code consults before *every* tool call — it allows only
Read/Edit/Write/Glob/Grep/web and denies everything else, and a hook deny holds even in bypass
mode. Write tools are additionally denied any target outside the working directory (a path
boundary, fail-closed on a missing path — reads and web stay unrestricted). Backed by `--permission-mode dontAsk` + an explicit allowlist, `--strict-mcp-config` (zero
MCP servers), and a deny list for known exec tools. Any tool outside the allowlist — named or not,
now or in a future CLI — is denied because it isn't allowed, not because we remembered it.

Arming is **two-key**, and both keys are yours: (1) this machine — choose `limited` at `init`;
(2) your voice — the app dispatches an edit task only after you say "execute the plan" AND confirm
the spoken warning. A `caps:"edit"` dispatch without the workstation key gets a 403.

### `ungated` — no per-task gate

Every turn (chat or job) runs write-capable, no ceremony. Enabling it requires typing
`yes i understand` at `init` — a script, `--yes`, or `--edit-mode ungated` in a non-interactive
terminal can never arm it. What it means differs by agent, and the warning says so:

- **Claude:** the SAME containment as `limited` (hook allowlist, no commands, no git, no MCP) —
  ungated removes the per-task confirmation, it does not move the command-execution boundary.
  Every write-capable turn snapshots the repo first into a pruned ring
  (`refs/riffn/ring-*`, last 20 kept), and the persistent session is stamped with the mode it was
  created under — flipping the mode starts a fresh thread, so a permissive session can never leak
  into a stricter mode (or vice versa).
- **Codex:** honestly, **sandboxed shell + workspace edits** (`--sandbox workspace-write`) —
  Codex's sandbox scopes what model-run commands can *do*, not *whether* they run. No automatic
  snapshots; rely on your own git discipline.

### Snapshots and recovery

Before any write-capable Claude run, the helper (never the agent) captures the full repo state —
including uncommitted and untracked files — as a ref. Nothing visible changes (no commit on your
branch, no stash entry). If the snapshot can't be taken (not a git repo, git missing), the run is
**refused**, not run unprotected. `limited` tasks keep one ref per task
(`refs/riffn/snapshot-<jobid>`, never auto-pruned); `ungated` turns cycle through the ring.

```bash
git diff <ref>                     # review MODIFIED tracked files
git status                         # files the run CREATED show here, not in diff
git restore --source <ref> -- .    # put every tracked file back
git for-each-ref refs/riffn        # list all snapshot/ring refs; delete with update-ref -d
```

Job status reports the **count** of file edits only — never file names or contents (§10.10).

### A note on Codex containment (all modes)

`codex exec` has no deny-by-default, so the bridge pins the whole posture on every turn:
`--sandbox` (read-only below ungated), `--ignore-user-config` (your `~/.codex/config.toml` — MCP
servers, hooks, web search, and your model choice — never loads under the bridge; auth still works),
`approval_policy=never`, and a core-only shell environment. Bridge secrets (`RIFFIN_BRIDGE_*`)
are stripped from every spawned agent's environment, Claude included. A Codex CLI too old for
these flags fails the turn rather than running uncontained.

## Voice notes

Capture ideas into the repo hands-free: `POST /v1/notes` `{text}` writes
`riffn-notes/<date>-<slug>.md` under the bridge's working directory and returns the file path
(201). The **helper** writes the file — the agent's read/plan-only caps are untouched, and the
model never chooses a path. The folder name is fixed on purpose (nothing to misconfigure); commit
the notes or `.gitignore` the folder per repo, your call. By voice: *"take a note: …"* (dictated
content), or *"make a note"* / *"note that"* (saves the last exchange).

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

## Run it on GLM (or any Anthropic-compatible backend)

The `claude` CLI doesn't have to talk to Anthropic: it honors standard env vars that redirect it
to any Anthropic-compatible endpoint — Z.ai's GLM models, OpenRouter, a local proxy. The bridge
follows along for free: it spawns *your* `claude` install, passes your environment through, and
never picks a model itself. Net effect: voice-driving a ~$3/M-token model in your own repo, from
your phone.

Add the redirect to the **bridge's `.env`** (scoped to this one bridge — loaded at start and passed
to the spawned agent), or to the `env` block of `~/.claude/settings.json` (machine-wide). Direct
to Z.ai, for example (check their docs for current model ids):

```
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_AUTH_TOKEN=<your Z.ai API key>
ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.2
ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.2
ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-4.5-air
```

Via OpenRouter instead: `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, model ids like
`z-ai/glm-5.2`, and **pin the Z.ai provider in your OpenRouter account settings** — otherwise
requests may silently route to cheaper quantized third-party hosts of the same model.

Notes:

- **Set the HAIKU model too.** Claude Code sends small background tasks to it; left unset, those
  go to Anthropic with your redirected token and fail.
- **Containment is unchanged.** Edit modes, the hook allowlist, snapshots, and denied shell/git
  are enforced by the Claude Code harness on your machine, not by the model — every tier behaves
  identically on any backend.
- **Fleets compose.** Because the `.env` is per-bridge, one repo can answer on GLM while another
  answers on Anthropic, side by side on the same machine.
- Claude agent only — Codex under the bridge runs with an isolated config (see the Codex note)
  and its own built-in default.
- If turns stall or come back malformed, suspect the backend model's tool-calling before the
  bridge: `claude -p "hello" --output-format json` in the working directory shows the raw error.

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
