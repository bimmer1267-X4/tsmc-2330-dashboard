<#
  抓取台積電(2330)近6個月日K + 本益比/殖利率/股價淨值比 + 最新季度EPS，
  並計算 MA5/20/60、RSI(14)、MACD(12,26,9)、布林通道(20,2)、KD(9,3,3) 等技術指標，
  輸出 data\data.json，供 dashboard.html 樣板注入使用。

  ADR / 匯率資料不在本腳本抓取範圍內（需要瀏覽器級渲染或即時查證），
  由 Claude 在合併步驟另行以 WebFetch/WebSearch 取得後 merge 進 data.json。
#>

$ErrorActionPreference = "Stop"
$StockNo = "2330"
$UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
$OutDir = Join-Path $PSScriptRoot "..\data"
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

function Invoke-TwseJson($url) {
    $resp = Invoke-WebRequest -Uri $url -UserAgent $UA -TimeoutSec 30 -UseBasicParsing
    $bytes = $resp.RawContentStream.ToArray()
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    return $text | ConvertFrom-Json
}

function ConvertTo-Num($s) {
    if ($null -eq $s) { return $null }
    $t = ($s -replace ",", "").Trim()
    if ($t -eq "" -or $t -eq "--" -or $t -eq "X" -or $t -eq "-") { return $null }
    $t = $t -replace "^\+", ""
    [double]$v = 0
    if ([double]::TryParse($t, [ref]$v)) { return $v }
    return $null
}

function ConvertFrom-RocDate($rocDate) {
    # "115/07/21" -> "2026-07-21"
    $parts = $rocDate -split "/"
    $y = [int]$parts[0] + 1911
    return "{0:D4}-{1}-{2}" -f $y, $parts[1], $parts[2]
}

Write-Host "[1/4] 抓取 TWSE STOCK_DAY 近6個月日K..."
$daily = @()
$today = Get-Date
for ($i = 5; $i -ge 0; $i--) {
    $monthDate = $today.AddMonths(-$i)
    $dateParam = $monthDate.ToString("yyyyMM") + "01"
    $url = "https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=$dateParam&stockNo=$StockNo"
    try {
        $resp = Invoke-TwseJson $url
        if ($resp.stat -eq "OK" -and $resp.data) {
            foreach ($row in $resp.data) {
                $daily += [PSCustomObject]@{
                    date   = ConvertFrom-RocDate $row[0]
                    volume = ConvertTo-Num $row[1]
                    open   = ConvertTo-Num $row[3]
                    high   = ConvertTo-Num $row[4]
                    low    = ConvertTo-Num $row[5]
                    close  = ConvertTo-Num $row[6]
                }
            }
        }
    } catch {
        Write-Warning "STOCK_DAY $dateParam 抓取失敗: $_"
    }
    Start-Sleep -Milliseconds 600
}
$daily = $daily | Where-Object { $_.close -ne $null } | Sort-Object date -Unique
Write-Host "  取得 $($daily.Count) 個交易日"

Write-Host "[2/4] 抓取本益比/殖利率/股價淨值比..."
# BWIBBU_d 通常比STOCK_DAY慢一個交易日發布，從最新交易日往前找，最多回溯5個交易日
$peRow = $null
$peDateUsed = $null
for ($back = 0; $back -lt 5 -and $peRow -eq $null; $back++) {
    $tryIdx = $daily.Count - 1 - $back
    if ($tryIdx -lt 0) { break }
    $tryDate = $daily[$tryIdx].date -replace "-", ""
    $peUrl = "https://www.twse.com.tw/exchangeReport/BWIBBU_d?response=json&date=$tryDate&stockNo=$StockNo"
    $peResp = Invoke-TwseJson $peUrl
    if ($peResp.stat -eq "OK" -and $peResp.data) {
        $peRow = $peResp.data | Where-Object { $_[0] -eq $StockNo } | Select-Object -First 1
        if ($peRow) { $peDateUsed = $daily[$tryIdx].date }
    }
    Start-Sleep -Milliseconds 400
}
if (-not $peRow) { throw "BWIBBU_d 回溯5個交易日仍查無資料" }
Write-Host "  採用 $peDateUsed 的本益比資料（可能落後最新股價日期，因TWSE此報表發布較慢）"
$valuation = [PSCustomObject]@{
    date          = $peDateUsed
    closePrice    = ConvertTo-Num $peRow[2]
    dividendYield = ConvertTo-Num $peRow[3]
    peRatio       = ConvertTo-Num $peRow[5]
    pbRatio       = ConvertTo-Num $peRow[6]
    epsPeriod     = $peRow[7]
}

Write-Host "[3/4] 抓取最新季度EPS (t187ap14_L)..."
# 季度EPS只用來算「全年預估EPS估值」卡片，不是股價/K線/技術指標這些核心資料。
# t187ap14_L是「當季」彙總表，換季空窗期可能暫時查不到2330，這種情況不該讓
# 整條pipeline失敗、連帶擋下當天原本抓得到的股價資料——抓不到就讓$epsInfo
# 維持$null，讓後續官方預估區塊照既有邏輯優雅地略過即可。
$epsInfo = $null
try {
    $epsResp = Invoke-TwseJson "https://openapi.twse.com.tw/v1/opendata/t187ap14_L"
    $epsRow = $epsResp | Where-Object { $_.公司代號 -eq $StockNo } | Select-Object -First 1
    if (-not $epsRow) { throw "t187ap14_L 查無2330資料" }
    $epsInfo = [PSCustomObject]@{
        year    = $epsRow.年度
        season  = $epsRow.季別
        eps     = ConvertTo-Num $epsRow.'基本每股盈餘(元)'
        revenue = ConvertTo-Num $epsRow.營業收入
        netIncome = ConvertTo-Num $epsRow.稅後淨利
    }
} catch {
    Write-Host "  季度EPS抓取失敗，epsInfo維持null: $($_.Exception.Message)"
}

Write-Host "[4/4] 計算技術指標..."
$closes = $daily.close
$n = $closes.Count

function Get-SMA($arr, $idx, $period) {
    if ($idx -lt $period - 1) { return $null }
    $slice = $arr[($idx - $period + 1)..$idx]
    return ($slice | Measure-Object -Average).Average
}

function Get-StdDev($arr, $idx, $period) {
    if ($idx -lt $period - 1) { return $null }
    $slice = $arr[($idx - $period + 1)..$idx]
    $mean = ($slice | Measure-Object -Average).Average
    $sumSq = 0.0
    foreach ($v in $slice) { $sumSq += [math]::Pow($v - $mean, 2) }
    return [math]::Sqrt($sumSq / $period)
}

# EMA series (seed = SMA of first `period` values)
function Get-EmaSeries($arr, $period) {
    $n = $arr.Count
    $ema = New-Object 'double[]' $n
    $k = 2.0 / ($period + 1)
    for ($i = 0; $i -lt $n; $i++) {
        if ($i -lt $period - 1) {
            $ema[$i] = [double]::NaN
        } elseif ($i -eq $period - 1) {
            $ema[$i] = ($arr[0..$i] | Measure-Object -Average).Average
        } else {
            $ema[$i] = ($arr[$i] - $ema[$i-1]) * $k + $ema[$i-1]
        }
    }
    return $ema
}

$ema12 = Get-EmaSeries $closes 12
$ema26 = Get-EmaSeries $closes 26
$macdLine = New-Object 'double[]' $n
for ($i = 0; $i -lt $n; $i++) {
    if ([double]::IsNaN($ema12[$i]) -or [double]::IsNaN($ema26[$i])) { $macdLine[$i] = [double]::NaN }
    else { $macdLine[$i] = $ema12[$i] - $ema26[$i] }
}
$validMacd = $macdLine | Where-Object { -not [double]::IsNaN($_) }
$macdSignalPartial = Get-EmaSeries $validMacd 9
$signalLine = New-Object 'double[]' $n
$offset = $n - $validMacd.Count
for ($i = 0; $i -lt $n; $i++) { $signalLine[$i] = [double]::NaN }
for ($i = 0; $i -lt $macdSignalPartial.Count; $i++) { $signalLine[$offset + $i] = $macdSignalPartial[$i] }

# RSI(14) Wilder
$rsi = New-Object 'double[]' $n
for ($i = 0; $i -lt $n; $i++) { $rsi[$i] = [double]::NaN }
if ($n -gt 14) {
    $gains = @(); $losses = @()
    for ($i = 1; $i -le 14; $i++) {
        $d = $closes[$i] - $closes[$i-1]
        $gains += [math]::Max($d, 0); $losses += [math]::Max(-$d, 0)
    }
    $avgGain = ($gains | Measure-Object -Average).Average
    $avgLoss = ($losses | Measure-Object -Average).Average
    $rsi[14] = if ($avgLoss -eq 0) { 100 } else { 100 - (100 / (1 + ($avgGain / $avgLoss))) }
    for ($i = 15; $i -lt $n; $i++) {
        $d = $closes[$i] - $closes[$i-1]
        $gain = [math]::Max($d, 0); $loss = [math]::Max(-$d, 0)
        $avgGain = ($avgGain * 13 + $gain) / 14
        $avgLoss = ($avgLoss * 13 + $loss) / 14
        $rsi[$i] = if ($avgLoss -eq 0) { 100 } else { 100 - (100 / (1 + ($avgGain / $avgLoss))) }
    }
}

# KD隨機指標(9,3,3)：RSV = (收盤 - 近9日最低價) / (近9日最高價 - 近9日最低價) * 100，
# K/D 用 2/3 前值 + 1/3 新值 平滑，起始基準值採慣例的 50。
$kdPeriod = 9
$kArr = New-Object 'double[]' $n
$dArr = New-Object 'double[]' $n
for ($i = 0; $i -lt $n; $i++) { $kArr[$i] = [double]::NaN; $dArr[$i] = [double]::NaN }
$prevK = 50.0; $prevD = 50.0
for ($i = $kdPeriod - 1; $i -lt $n; $i++) {
    $hh = [double]::NegativeInfinity; $ll = [double]::PositiveInfinity
    for ($j = $i - $kdPeriod + 1; $j -le $i; $j++) {
        $hh = [math]::Max($hh, $daily[$j].high)
        $ll = [math]::Min($ll, $daily[$j].low)
    }
    $rsv = if ($hh -eq $ll) { 50.0 } else { (($daily[$i].close - $ll) / ($hh - $ll)) * 100 }
    $kVal = ($prevK * 2 + $rsv) / 3
    $dVal = ($prevD * 2 + $kVal) / 3
    $kArr[$i] = $kVal; $dArr[$i] = $dVal
    $prevK = $kVal; $prevD = $dVal
}

$indicators = @()
for ($i = 0; $i -lt $n; $i++) {
    $ma5 = Get-SMA $closes $i 5
    $ma20 = Get-SMA $closes $i 20
    $ma60 = Get-SMA $closes $i 60
    $bbMid = $ma20
    $sd = Get-StdDev $closes $i 20
    $bbUpper = if ($bbMid -ne $null -and $sd -ne $null) { $bbMid + 2 * $sd } else { $null }
    $bbLower = if ($bbMid -ne $null -and $sd -ne $null) { $bbMid - 2 * $sd } else { $null }
    $indicators += [PSCustomObject]@{
        date     = $daily[$i].date
        ma5      = $ma5
        ma20     = $ma20
        ma60     = $ma60
        bbUpper  = $bbUpper
        bbMid    = $bbMid
        bbLower  = $bbLower
        rsi14    = $(if ([double]::IsNaN($rsi[$i])) { $null } else { $rsi[$i] })
        macd     = $(if ([double]::IsNaN($macdLine[$i])) { $null } else { $macdLine[$i] })
        signal   = $(if ([double]::IsNaN($signalLine[$i])) { $null } else { $signalLine[$i] })
        histogram= $(if ([double]::IsNaN($macdLine[$i]) -or [double]::IsNaN($signalLine[$i])) { $null } else { $macdLine[$i] - $signalLine[$i] })
        k        = $(if ([double]::IsNaN($kArr[$i])) { $null } else { $kArr[$i] })
        d        = $(if ([double]::IsNaN($dArr[$i])) { $null } else { $dArr[$i] })
    }
}

$latestRsi = ($indicators | Where-Object { $_.rsi14 -ne $null } | Select-Object -Last 1).rsi14

$result = [PSCustomObject]@{
    generatedAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
    stockNo     = $StockNo
    daily       = $daily
    indicators  = $indicators
    valuation   = $valuation
    epsInfo     = $epsInfo
    latestRsi   = $latestRsi
    adr         = $null   # 由 Claude 於合併步驟填入 (stockanalysis.com + Yahoo Finance 交叉比對)
    fxRate      = $null   # 由 Claude 於合併步驟填入 (央行/Yahoo 交叉比對)
}

$outFile = Join-Path $OutDir "data.json"
$result | ConvertTo-Json -Depth 6 -Compress | Out-File -FilePath $outFile -Encoding utf8
Write-Host "已輸出: $outFile"
