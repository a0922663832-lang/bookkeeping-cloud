# deploy.ps1
# 把本機 bookkeeping-cloud 改動推到遠端 10.0.1.168 並 restart container.
#
# 用法:
#   ./deploy.ps1               # 推自 HEAD 以來的 working-tree 改動 (推薦)
#   ./deploy.ps1 -All          # 推所有 tracked 檔案 (force sync, 例如新 deploy 主機)
#   ./deploy.ps1 -Since HEAD~3 # 推某個 ref 之後的改動

param(
  [switch]$All,
  [string]$Since = "HEAD"
)

$REMOTE = "nester@10.0.1.168"
$REMOTE_DIR = "/root/bookkeeping-cloud"
$LOCAL_DIR = "C:\Users\nest\Desktop\AI\bookkeeping-cloud"

$ErrorActionPreference = "Stop"

Write-Host "=== bookkeeping-cloud deploy ===" -ForegroundColor Cyan

# 1. 列出要推的檔案
if ($All) {
  $files = git -C $LOCAL_DIR ls-files
  Write-Host "Mode: All tracked files (force sync)"
} else {
  $files = git -C $LOCAL_DIR diff --name-only $Since
  if (-not $files) {
    Write-Host "No diff vs $Since. Nothing to deploy." -ForegroundColor Yellow
    Write-Host "(Try -All to force-sync all files, or check 'git status')"
    exit 0
  }
  Write-Host "Mode: diff since $Since"
}

# 過濾 ignored 模式 (保險: git diff 通常不會回這些)
$files = $files | Where-Object { $_ -notmatch '^(node_modules|data|\.env$|.*\.log)' }

Write-Host "Files to deploy ($(($files | Measure-Object).Count)):"
$files | ForEach-Object { Write-Host "  $_" }
Write-Host ""

# 2. 收集需要建的遠端子資料夾, 一次性建好
$remoteDirs = @{}
foreach ($f in $files) {
  $rel = $f.Replace('\', '/')
  $dir = Split-Path -Parent $rel
  if ($dir) { $remoteDirs[$dir] = $true }
}
foreach ($d in $remoteDirs.Keys) {
  ssh $REMOTE "mkdir -p $REMOTE_DIR/$d" 2>$null
}

# 3. scp 各檔
foreach ($f in $files) {
  $local = Join-Path $LOCAL_DIR $f
  if (-not (Test-Path $local)) {
    Write-Host "  SKIP (not found): $f" -ForegroundColor Yellow
    continue
  }
  $remote = "${REMOTE}:${REMOTE_DIR}/$($f.Replace('\','/'))"
  Write-Host "  scp $f"
  scp -q $local $remote
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
  Write-Host "`n[OK] Deploy successful." -ForegroundColor Green
} else {
  Write-Host "`n[WARN] Health check did not return ok. Check logs:" -ForegroundColor Red
  Write-Host "  ssh $REMOTE 'docker logs bookkeeping-cloud-app 2>&1 | tail -20'"
  exit 1
}
