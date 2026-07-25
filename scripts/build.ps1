<#
  將 data\data.json 的內容注入 dashboard.template.html 的 __DASHBOARD_DATA__ 佔位符，
  產出可直接發布為 Artifact 的 dashboard.html，同時複製一份 index.html 供 GitHub Pages
  (serve from main branch root) 自動抓取，兩者內容永遠一致。
#>
$ErrorActionPreference = "Stop"
$root = Join-Path $PSScriptRoot ".."
$dataPath = Join-Path $root "data\data.json"
$templatePath = Join-Path $root "dashboard.template.html"
$outPath = Join-Path $root "dashboard.html"
$pagesOutPath = Join-Path $root "index.html"

$dataJson = Get-Content $dataPath -Raw -Encoding UTF8
$template = Get-Content $templatePath -Raw -Encoding UTF8
$final = $template.Replace("__DASHBOARD_DATA__", $dataJson)

$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($outPath, $final, $enc)
[System.IO.File]::WriteAllText($pagesOutPath, $final, $enc)
Write-Host "已產出: $outPath"
Write-Host "已產出: $pagesOutPath"
