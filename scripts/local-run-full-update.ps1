<#
  在本機（非 GitHub Actions）手動跑一次完整的每日資料更新，等同 update-dashboard.yml。

  用途：GitHub Actions runner 的共用IP被上游(TWSE/Yahoo等)暫時封鎖/限流時，改用你自己
  電腦的網路環境執行同一套流程，跑完直接 git commit + push 到 main，繞開 GitHub Actions
  完全不經過它的runner。

  使用方式：
    cd C:\path\to\tsmc-2330-dashboard
    .\scripts\local-run-full-update.ps1

  需求：PowerShell 7+（.NET內建 Invoke-WebRequest），已 clone 這個 repo 且能直接 push 到
  main（個人PAT/SSH key已設定好）。

  邏輯跟 .github/workflows/update-dashboard.yml 完全對等，包含同一套「手動觸發時間鎖定
  窗」判斷（13:30~隔日05:50台北時間內執行，籌碼面/大盤指數與盤前預測/ADR類比估計會維持
  上次的值，只回填收盤價相關資料）——本地執行時一律視為手動觸發，永遠套用這套判斷。
#>

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

Write-Host "[1/4] 抓取TWSE近6個月日K + 本益比/殖利率/股價淨值比 + 技術指標..."
& node scripts/update-dashboard.mjs
if ($LASTEXITCODE -ne 0) { throw "update-dashboard.mjs 失敗" }

$taipeiNow = [System.TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTime]::UtcNow, "Taipei Standard Time")
$hourMin = [int]($taipeiNow.ToString("HHmm"))

if ($hourMin -ge 1330 -or $hourMin -lt 550) {
    Write-Host "[2/4] 目前台北時間 $hourMin 落在鎖定時間窗(13:30~隔日05:50)內，籌碼面/大盤指數維持上次的值，只更新夜盤資料..."
    & node scripts/fetch-market-context.mjs --skip-market-context
    if ($LASTEXITCODE -ne 0) { throw "fetch-market-context.mjs 失敗" }
    Write-Host "[3/4] 同一鎖定時間窗內，只回填收盤價相關資料，不重算盤前預測/ADR類比估計..."
    & node scripts/merge-and-classify.mjs --backfill-only
    if ($LASTEXITCODE -ne 0) { throw "merge-and-classify.mjs 失敗" }
} else {
    Write-Host "[2/4] 抓取融資融券/SOX+TAIEX/除權息/選擇權未平倉..."
    & node scripts/fetch-market-context.mjs
    if ($LASTEXITCODE -ne 0) { throw "fetch-market-context.mjs 失敗" }
    Write-Host "[3/4] 合併ADR/匯率、計算估值分區、訓練開盤價預測模型..."
    & node scripts/merge-and-classify.mjs
    if ($LASTEXITCODE -ne 0) { throw "merge-and-classify.mjs 失敗" }
}

Write-Host "[4/4] 重新產生dashboard.html/index.html..."
& node scripts/build.mjs
if ($LASTEXITCODE -ne 0) { throw "build.mjs 失敗" }

git add data/data.json data/adr-premium-history.json data/prediction-accuracy-history.json data/taifex-night-history.json dashboard.html index.html
git diff --cached --quiet
$hasChanges = ($LASTEXITCODE -ne 0)
if (-not $hasChanges) {
    Write-Host "資料沒有變更，跳過commit。"
} else {
    git commit -m "chore: automated daily data update (本地手動執行，繞開GitHub Actions)"
    git push
    Write-Host "已commit並push。"
}
