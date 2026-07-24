<#
  將 data\data.json 的內容注入 dashboard.template.html 的 __DASHBOARD_DATA__ 佔位符，
  產出可直接發布為 Artifact 的 dashboard.html。
#>
$ErrorActionPreference = "Stop"
$root = Join-Path $PSScriptRoot ".."
$dataPath = Join-Path $root "data\data.json"
$templatePath = Join-Path $root "dashboard.template.html"
$outPath = Join-Path $root "dashboard.html"

$dataJson = Get-Content $dataPath -Raw -Encoding UTF8
$template = Get-Content $templatePath -Raw -Encoding UTF8
$final = $template.Replace("__DASHBOARD_DATA__", $dataJson)

$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($outPath, $final, $enc)
Write-Host "已產出: $outPath"
