<#
  抓取「股市經理人視角」的補充參考資訊，合併進 data\data.json：
    - marginTrading：台積電(2330)融資融券餘額 (TWSE OpenAPI MI_MARGN)
    - soxIndex / taiexIndex：費城半導體指數(SOX)、加權指數(TAIEX) (Yahoo Finance)
    - institutionalNet：三大法人（外資/投信/合計）買賣超 (TWSE 舊版 rwd/zh/fund/T86)
    - exDividend：近期除權息預告 (TWSE OpenAPI TWT48U_ALL)
    - optionsMarket：台指選擇權(TXO)未平倉 Put/Call Ratio (TAIFEX OpenAPI)
    - chipTrend：規則式（非AI）籌碼面趨勢判讀（偏多/中性/偏空 + 理由），根據以上欄位加權計分
  每段資料來源獨立 try/catch，單一來源失敗不影響其他欄位，邏輯與
  fetch-market-context.mjs 對等。
#>

$ErrorActionPreference = "Stop"
$StockNo = "2330"
$UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
$DataPath = Join-Path $PSScriptRoot "..\data\data.json"

function ConvertTo-Num($s) {
    if ($null -eq $s) { return $null }
    $t = ($s -replace ",", "").Trim()
    if ($t -eq "" -or $t -eq "--" -or $t -eq "X" -or $t -eq "-") { return $null }
    [double]$v = 0
    if ([double]::TryParse($t, [ref]$v)) { return $v }
    return $null
}

function ConvertFrom-RocCompact($s) {
    if ($null -eq $s -or $s.Length -ne 7) { return $null }
    $year = [int]$s.Substring(0,3) + 1911
    return "{0}-{1}-{2}" -f $year, $s.Substring(3,2), $s.Substring(5,2)
}

function Invoke-JsonGet($url) {
    $resp = Invoke-WebRequest -Uri $url -UserAgent $UA -TimeoutSec 30 -UseBasicParsing
    $bytes = $resp.RawContentStream.ToArray()
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    return $text | ConvertFrom-Json
}

function Get-MarginTrading {
    $rows = Invoke-JsonGet "https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN"
    $row = $rows | Where-Object { $_.'股票代號' -eq $StockNo } | Select-Object -First 1
    if (-not $row) { throw "MI_MARGN 找不到股票代號 $StockNo" }
    return [PSCustomObject]@{
        marginBuy         = ConvertTo-Num $row.'融資買進'
        marginSell        = ConvertTo-Num $row.'融資賣出'
        marginBalance     = ConvertTo-Num $row.'融資今日餘額'
        marginBalancePrev = ConvertTo-Num $row.'融資前日餘額'
        shortBuy          = ConvertTo-Num $row.'融券買進'
        shortSell         = ConvertTo-Num $row.'融券賣出'
        shortBalance      = ConvertTo-Num $row.'融券今日餘額'
        shortBalancePrev  = ConvertTo-Num $row.'融券前日餘額'
    }
}

function Get-YahooIndex($symbol) {
    $url = "https://query1.finance.yahoo.com/v8/finance/chart/$([uri]::EscapeDataString($symbol))?interval=1d&range=5d"
    $json = Invoke-JsonGet $url
    $result = $json.chart.result[0]
    if (-not $result.meta) { throw "Yahoo Finance 無資料: $symbol" }
    $closes = @($result.indicators.quote[0].close | Where-Object { $null -ne $_ })
    $price = $result.meta.regularMarketPrice
    if ($closes.Count -ge 2) {
        $previousClose = $closes[$closes.Count - 2]
    } else {
        $previousClose = $result.meta.previousClose
        if (-not $previousClose) { $previousClose = $result.meta.chartPreviousClose }
    }
    $changePct = $null
    if ($previousClose) { $changePct = [math]::Round((($price / $previousClose) - 1) * 100, 2) }
    $quoteTime = [DateTimeOffset]::FromUnixTimeSeconds($result.meta.regularMarketTime).UtcDateTime.ToString("o")
    return [PSCustomObject]@{ price = $price; changePct = $changePct; quoteTime = $quoteTime }
}

function Get-InstitutionalNet($Daily) {
    for ($back = 0; $back -lt 5; $back++) {
        $idx = $Daily.Count - 1 - $back
        if ($idx -lt 0) { break }
        $tryDate = $Daily[$idx].date -replace "-", ""
        $url = "https://www.twse.com.tw/rwd/zh/fund/T86?date=$tryDate&selectType=ALL&response=json"
        $resp = Invoke-JsonGet $url
        if ($resp.stat -eq "OK" -and $resp.data) {
            $row = $resp.data | Where-Object { $_[0] -eq $StockNo } | Select-Object -First 1
            if ($row) {
                $foreignNet = 0.0
                $v4 = ConvertTo-Num $row[4]; if ($v4) { $foreignNet += $v4 }
                $v7 = ConvertTo-Num $row[7]; if ($v7) { $foreignNet += $v7 }
                $trustNet = ConvertTo-Num $row[10]
                $totalNet = ConvertTo-Num $row[18]
                return [PSCustomObject]@{
                    date           = $Daily[$idx].date
                    foreignNetLots = [math]::Round($foreignNet / 1000)
                    trustNetLots   = $(if ($null -ne $trustNet) { [math]::Round($trustNet / 1000) } else { $null })
                    totalNetLots   = $(if ($null -ne $totalNet) { [math]::Round($totalNet / 1000) } else { $null })
                }
            }
        }
        Start-Sleep -Milliseconds 400
    }
    throw "T86 回溯5個交易日仍查無2330資料"
}

function Get-ExDividend {
    $rows = Invoke-JsonGet "https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL"
    $matches = @($rows | Where-Object { $_.Code -eq $StockNo } | Sort-Object Date)
    if ($matches.Count -eq 0) { return $null }
    $row = $matches[0]
    return [PSCustomObject]@{
        date               = ConvertFrom-RocCompact $row.Date
        type               = $row.Exdividend
        cashDividend       = ConvertTo-Num $row.CashDividend
        stockDividendRatio = ConvertTo-Num $row.StockDividendRatio
    }
}

function Get-OptionsMarket {
    $rows = Invoke-JsonGet "https://openapi.taifex.com.tw/v1/DailyMarketReportOpt"
    if (-not $rows -or $rows.Count -eq 0) { throw "DailyMarketReportOpt 回傳空資料" }
    $txo = $rows | Where-Object { $_.Contract -eq "TXO" -and $_.TradingSession -eq "一般" }
    if (-not $txo -or $txo.Count -eq 0) { throw "找不到 TXO 一般時段資料" }
    $callOI = 0.0; $putOI = 0.0; $date = $null
    foreach ($r in $txo) {
        $oi = ConvertTo-Num $r.OpenInterest
        if (-not $oi) { $oi = 0 }
        if ($r.CallPut -eq "買權") { $callOI += $oi }
        elseif ($r.CallPut -eq "賣權") { $putOI += $oi }
        if (-not $date) { $date = $r.Date }
    }
    $isoDate = $null
    if ($date -and $date.Length -eq 8) {
        $isoDate = "{0}-{1}-{2}" -f $date.Substring(0,4), $date.Substring(4,2), $date.Substring(6,2)
    }
    $ratio = $null
    if ($callOI -gt 0) { $ratio = [math]::Round($putOI / $callOI, 4) }
    return [PSCustomObject]@{ date = $isoDate; callOI = $callOI; putOI = $putOI; putCallRatio = $ratio }
}

function Get-ChipTrend($Raw) {
    $score = 0.0; $weightSum = 0.0
    $reasons = @()
    $risk = @()

    if ($Raw.institutionalNet) {
        $inet = $Raw.institutionalNet
        if ($null -ne $inet.foreignNetLots) {
            $score += [math]::Sign($inet.foreignNetLots) * 1.5; $weightSum += 1.5
            $dir = if ($inet.foreignNetLots -ge 0) { "買超" } else { "賣超" }
            $reasons += "外資$dir$([math]::Abs($inet.foreignNetLots).ToString('N0'))張"
        }
        if ($null -ne $inet.trustNetLots) {
            $score += [math]::Sign($inet.trustNetLots) * 0.8; $weightSum += 0.8
            $dir = if ($inet.trustNetLots -ge 0) { "買超" } else { "賣超" }
            $reasons += "投信$dir$([math]::Abs($inet.trustNetLots).ToString('N0'))張"
        }
    }
    if ($Raw.optionsMarket -and $null -ne $Raw.optionsMarket.putCallRatio) {
        $ratio = $Raw.optionsMarket.putCallRatio
        $s = if ($ratio -gt 1.05) { -1 } elseif ($ratio -lt 0.95) { 1 } else { 0 }
        $score += $s; $weightSum += 1
        $note = if ($s -gt 0) { "（看多氣氛較濃）" } elseif ($s -lt 0) { "（避險氣氛較濃）" } else { "（中性）" }
        $reasons += "選擇權Put/Call Ratio $($ratio.ToString('F2'))$note"
    }
    if ($Raw.soxIndex -and $null -ne $Raw.soxIndex.changePct) {
        $score += [math]::Sign($Raw.soxIndex.changePct) * 0.6; $weightSum += 0.6
        $dir = if ($Raw.soxIndex.changePct -ge 0) { "上漲" } else { "下跌" }
        $reasons += "SOX費半指數$dir$([math]::Abs($Raw.soxIndex.changePct).ToString('F2'))%"
    }
    if ($Raw.taiexIndex -and $null -ne $Raw.taiexIndex.changePct) {
        $score += [math]::Sign($Raw.taiexIndex.changePct) * 0.4; $weightSum += 0.4
        $dir = if ($Raw.taiexIndex.changePct -ge 0) { "上漲" } else { "下跌" }
        $reasons += "加權指數$dir$([math]::Abs($Raw.taiexIndex.changePct).ToString('F2'))%"
    }
    if ($Raw.marginTrading) {
        $mt = $Raw.marginTrading
        if ($null -ne $mt.marginBalance -and $null -ne $mt.marginBalancePrev) {
            $chg = $mt.marginBalance - $mt.marginBalancePrev
            if ($chg -gt 0) { $risk += "融資餘額增加$($chg.ToString('N0'))張（槓桿部位上升，留意回檔時的斷頭賣壓）" }
            elseif ($chg -lt 0) { $risk += "融資餘額減少$([math]::Abs($chg).ToString('N0'))張（籌碼去化中）" }
        }
        if ($null -ne $mt.shortBalance -and $null -ne $mt.shortBalancePrev) {
            $chg = $mt.shortBalance - $mt.shortBalancePrev
            if ($chg -gt 0) { $risk += "融券餘額增加$($chg.ToString('N0'))張（空方力道增溫，亦可能成為軋空燃料）" }
        }
    }

    if ($weightSum -eq 0) { return $null }
    $avg = $score / $weightSum
    $verdict = if ($avg -ge 0.34) { "偏多" } elseif ($avg -le -0.34) { "偏空" } else { "中性" }
    $cls = if ($avg -ge 0.34) { "up" } elseif ($avg -le -0.34) { "down" } else { "" }
    return [PSCustomObject]@{ verdict = $verdict; cls = $cls; reasons = $reasons; risk = $risk }
}

function Invoke-Safe($label, [scriptblock]$fn) {
    try { return & $fn }
    catch {
        Write-Warning "[market-context] $label 失敗，該欄位維持 null: $($_.Exception.Message)"
        return $null
    }
}

$raw = Get-Content $DataPath -Raw -Encoding UTF8 | ConvertFrom-Json

$raw | Add-Member -MemberType NoteProperty -Name "marginTrading" -Value (Invoke-Safe "融資融券餘額" { Get-MarginTrading }) -Force
$raw | Add-Member -MemberType NoteProperty -Name "soxIndex" -Value (Invoke-Safe "SOX指數" { Get-YahooIndex "^SOX" }) -Force
$raw | Add-Member -MemberType NoteProperty -Name "taiexIndex" -Value (Invoke-Safe "TAIEX指數" { Get-YahooIndex "^TWII" }) -Force
$raw | Add-Member -MemberType NoteProperty -Name "institutionalNet" -Value (Invoke-Safe "三大法人買賣超" { Get-InstitutionalNet $raw.daily }) -Force
$raw | Add-Member -MemberType NoteProperty -Name "exDividend" -Value (Invoke-Safe "除權息預告" { Get-ExDividend }) -Force
$raw | Add-Member -MemberType NoteProperty -Name "optionsMarket" -Value (Invoke-Safe "選擇權未平倉" { Get-OptionsMarket }) -Force
$raw | Add-Member -MemberType NoteProperty -Name "chipTrend" -Value (Invoke-Safe "籌碼面趨勢判讀" { Get-ChipTrend $raw }) -Force

$raw | ConvertTo-Json -Depth 8 -Compress | Out-File -FilePath $DataPath -Encoding utf8
Write-Host "已更新 marginTrading / soxIndex / taiexIndex / institutionalNet / exDividend / optionsMarket / chipTrend"
