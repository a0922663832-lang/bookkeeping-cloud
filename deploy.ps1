# deploy.ps1
# Push local bookkeeping-cloud changes to remote 10.0.1.168 and restart container.
#
# Usage:
#   ./deploy.ps1       # push modified + untracked files (recommended)
#   ./deploy.ps1 -All  # push all tracked files (force sync, e.g. for new host)

param(
  [switch]$All
)

$REMOTE = "nester@10.0.1.168"
$REMOTE_DIR = "/root/bookkeeping-cloud"
$LOCAL_DIR = "C:\Users\nest\Desktop\AI\bookkeeping-cloud"

$ErrorActionPreference = "Stop"

Write-Host "=== bookkeeping-cloud deploy ===" -ForegroundColor Cyan

# 1. list files to push
if ($All) {
  $files = git -C $LOCAL_DIR ls-files
  Write-Host "Mode: All tracked files (force sync)"
} else {
  # Modified vs HEAD + untracked (but not gitignored)
  $modified = git -C $LOCAL_DIR diff --name-only HEAD
  $untracked = git -C $LOCAL_DIR ls-files --others --exclude-standard
  $files = @()
  if ($modified) { $files += $modified }
  if ($untracked) { $files += $untracked }
  $files = $files | Where-Object { $_ -and ($_ -notmatch '^(node_modules|data|\.env$|.*\.log)') }
  $files = $files | Sort-Object -Unique
  if (($files | Measure-Object).Count -eq 0) {
    Write-Host "No modified or untracked files. Nothing to deploy." -ForegroundColor Yellow
    exit 0
  }
  Write-Host "Mode: diff HEAD + untracked"
}

$fileCount = ($files | Measure-Object).Count
Write-Host "Files to deploy ($fileCount):"
$files | ForEach-Object { Write-Host "  $_" }
Write-Host ""

# 2. collect remote dirs to mkdir
$remoteDirs = @{}
foreach ($f in $files) {
  $rel = $f.Replace('\', '/')
  $dir = Split-Path -Parent $rel
  if ($dir) { $remoteDirs[$dir] = $true }
}
foreach ($d in $remoteDirs.Keys) {
  ssh $REMOTE "mkdir -p $REMOTE_DIR/$d" 2>$null
}

# 3. scp each file ($dest uses different name from $REMOTE to avoid case-insensitive clash)
foreach ($f in $files) {
  $local = Join-Path $LOCAL_DIR $f
  if (-not (Test-Path $local)) {
    Write-Host "  SKIP (not found): $f" -ForegroundColor Yellow
    continue
  }
  $dest = "${REMOTE}:${REMOTE_DIR}/$($f.Replace('\','/'))"
  Write-Host "  scp $f"
  scp -q $local $dest
}

# 4. restart container
Write-Host ""
Write-Host "Restarting bookkeeping-cloud-app..." -ForegroundColor Cyan
ssh $REMOTE "docker restart bookkeeping-cloud-app"

# 5. wait + health check
Write-Host "Waiting 4s for app to start..."
Start-Sleep -Seconds 4
Write-Host "Health check:"
$health = curl.exe -s -m 10 http://10.0.1.168:3001/health
Write-Host $health

if ($health -match '"status":"ok"') {
  Write-Host ""
  Write-Host "[OK] Deploy successful." -ForegroundColor Green
} else {
  Write-Host ""
  Write-Host "[WARN] Health check did not return ok. Check logs:" -ForegroundColor Red
  Write-Host "  ssh $REMOTE 'docker logs bookkeeping-cloud-app 2>&1 | tail -20'"
  exit 1
}
