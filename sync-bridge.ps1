# Sync the bridge source from the riffin monorepo (this folder) into the standalone publish
# mirror repo (riffn-bridge, expected as a sibling of the monorepo folder). Part of the release
# checklist in README.md "Releasing (maintainers)" — the mirror is write-only; develop here.
#
# robocopy /MIR deletes mirror files that no longer exist in the source, EXCEPT the excluded
# ones — /XD and /XF apply to both sides, so the mirror's own .git, node_modules, .env, logs,
# and session/job state are neither copied nor deleted.
$src = $PSScriptRoot
$dst = Join-Path $PSScriptRoot "..\..\..\riffn-bridge"
if (-not (Test-Path $dst)) {
    Write-Error "Mirror not found at $dst — clone https://github.com/dench88/riffn-bridge.git next to the riffin folder first."
    exit 1
}
$dst = (Resolve-Path $dst).Path
robocopy $src $dst /MIR /XD node_modules .git /XF .env wizard.log .riffn-bridge-session.json .riffn-bridge-job.json .riffn-bridge-history.jsonl
# robocopy exit codes 0-7 are success variants; 8+ means something failed to copy.
if ($LASTEXITCODE -ge 8) {
    Write-Error "robocopy reported failures (exit $LASTEXITCODE)"
    exit 1
}
Write-Host ""
Write-Host "Synced $src -> $dst"
Write-Host "Next: cd $dst ; npm test ; git status ; git add -A ; git commit -m `"riffn-bridge X.Y.Z`" ; git tag vX.Y.Z ; git push origin main --tags"
exit 0
