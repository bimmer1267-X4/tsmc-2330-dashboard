<#
  在本機（非 GitHub Actions）手動跑一次收盤後更新，等同 post-close-update.yml：
  更新即時報價(liveQuote)卡片、回填盤前預測準確度追蹤。

  用途：GitHub Actions runner 的共用IP被上游(TWSE)暫時封鎖/限流、或想立刻確認收盤價卡片
  沒問題時，改用你自己電腦的網路環境執行，跑完直接 git commit + push 到 main，完全繞開
  GitHub Actions。

  使用方式：
    cd C:\path\to\tsmc-2330-dashboard
    .\scripts\local-run-post-close.ps1

  需求：PowerShell 7+（.NET內建 Invoke-WebRequest），已 clone 這個 repo 且能直接 push 到
  main（個人PAT/SSH key已設定好）。

  邏輯跟 .github/workflows/post-close-update.yml 對等，包含同一套push撞車重試機制
  （最多3次，撞車時reset到最新main重新產生資料再試）。
#>

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$MaxAttempts = 3
for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    Write-Host "[嘗試 $attempt/$MaxAttempts] 抓取即時報價..."
    & node scripts/fetch-live-quote.mjs
    if ($LASTEXITCODE -ne 0) { throw "fetch-live-quote.mjs 失敗" }

    Write-Host "[嘗試 $attempt/$MaxAttempts] 回填準確度追蹤..."
    & node scripts/merge-and-classify.mjs --backfill-only
    if ($LASTEXITCODE -ne 0) { throw "merge-and-classify.mjs 失敗" }

    Write-Host "[嘗試 $attempt/$MaxAttempts] 重新產生dashboard.html/index.html..."
    & node scripts/build.mjs
    if ($LASTEXITCODE -ne 0) { throw "build.mjs 失敗" }

    git add data/data.json data/prediction-accuracy-history.json dashboard.html index.html
    git diff --cached --quiet
    $hasChanges = ($LASTEXITCODE -ne 0)
    if (-not $hasChanges) {
        Write-Host "資料沒有變更，跳過commit。"
        break
    }

    git commit -m "chore: post-close update (live quote + accuracy backfill) (本地手動執行，繞開GitHub Actions)"
    git push
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Push成功(第${attempt}次嘗試)"
        break
    }

    if ($attempt -eq $MaxAttempts) {
        throw "Push連續失敗${MaxAttempts}次，放棄(可能是持續性衝突，非單純撞車)"
    }
    Write-Host "Push被拒絕(可能跟其他來源撞車)，重新同步main後重試..."
    git fetch origin main
    git reset --hard origin/main
    Start-Sleep -Seconds (Get-Random -Minimum 3 -Maximum 8)
}
