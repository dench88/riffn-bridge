import { appendFileSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export const CODEX_AUDIT_FILE = "codex-turns.jsonl";

function append(cfg, entry) {
  mkdirSync(cfg.envDir, { recursive: true, mode: 0o700 });
  appendFileSync(
    path.join(cfg.envDir, CODEX_AUDIT_FILE),
    `${JSON.stringify(entry)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

export function commandHash(command) {
  return createHash("sha256")
    .update(JSON.stringify({ bin: command.bin, args: command.args }))
    .digest("hex");
}

export function beginCodexTurn(cfg, command) {
  const turn = {
    turnId: randomUUID(),
    startedAt: new Date().toISOString(),
    editMode: cfg.editMode,
    argvSha256: commandHash(command),
  };
  append(cfg, { ...turn, event: "started" });
  return turn;
}

export function finishCodexTurn(cfg, turn, {
  outcome,
  snapshotRef = null,
  filesChanged = [],
  error = null,
}) {
  append(cfg, {
    turnId: turn.turnId,
    startedAt: turn.startedAt,
    finishedAt: new Date().toISOString(),
    editMode: turn.editMode,
    argvSha256: turn.argvSha256,
    event: "finished",
    outcome,
    snapshotRef,
    filesChanged: [...new Set(filesChanged)].sort(),
    error,
  });
}
