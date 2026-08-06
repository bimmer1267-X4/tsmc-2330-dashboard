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
param(
    [switch]$SkipMarketContext
)

$ErrorActionPreference = "Stop"
$StockNo = "2330"
$UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
$DataPath = Join-Path $PSScriptRoot "..\data\data.json"
$TxNightHistoryPath = Join-Path $PSScriptRoot "..\data\taifex-night-history.json"

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
    $timestamps = @($result.timestamp)
    $rawCloses = @($result.indicators.quote[0].close)
    $price = $result.meta.regularMarketPrice
    # 不能單純假設「倒數第二個有效收盤價」就是前一交易日：如果當天(跟regularMarketTime
    # 同一天)那筆是null會被過濾掉，導致陣列整體往前偏移一格，「倒數第二」實際上會變成
    # 大前天的收盤價，算出的漲跌%會是好幾天的累積變化。改成明確比對日期：從最新往回找，
    # 跳過跟regularMarketTime同一天的項目，取第一個「不同一天」的有效收盤價。
    $previousClose = $null
    if ($result.meta.regularMarketTime) {
        $latestDateKey = [DateTimeOffset]::FromUnixTimeSeconds($result.meta.regularMarketTime).UtcDateTime.ToString("yyyy-MM-dd")
    } else {
        $latestDateKey = $null
    }
    for ($i = $timestamps.Count - 1; $i -ge 0; $i--) {
        $c = $rawCloses[$i]
        if ($null -eq $c) { continue }
        $dateKey = [DateTimeOffset]::FromUnixTimeSeconds($timestamps[$i]).UtcDateTime.ToString("yyyy-MM-dd")
        if ($latestDateKey -and $dateKey -eq $latestDateKey) { continue }
        $previousClose = $c
        break
    }
    if (-not $previousClose) {
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

# 台指期(TX)近月合約盤後交易時段(夜盤)最新成交/收盤價。
#
# 原本用openapi.taifex.com.tw/v1/DailyMarketReportFut，2026-08-05實測發現這個「即時」
# API其實是「每日批次更新一次」，不是真即時：同一天19:40(距離當晚夜盤05:00收盤還有
# 9小時多、夜盤才剛開盤4.5小時)重複查詢，回傳的還是前一場已經收盤超過13小時的舊資料，
# 一個位元都沒變過。這就是「抓到的是前一日夜盤收盤價」問題的根本原因——不是抓取邏輯的
# bug，是這個特定API端點本身沒有在夜盤交易時段內更新。
#
# 改用TAIFEX官方網站自己在用的「期貨每日交易行情下載」表單背後的端點
# (https://www.taifex.com.tw/cht/3/futDataDown，POST表單，回傳Big5編碼CSV)。同一個
# 19:40時間點實測：這個端點查得到的TX近月合約盤後列，"交易日期"已經是當天、"收盤價"
# (實際上是最後成交價，結算價欄位還是"-"表示尚未結算)持續反映當晚夜盤最新成交，證實
# 是真正跟得上進度的資料源。表頭欄位、資料格式都已用實際回傳驗證過(2026-08-05
# GitHub Actions run)：
#   交易日期,契約,到期月份(週別),開盤價,最高價,最低價,收盤價,漲跌價,漲跌%,成交量,
#   結算價,未沖銷契約數,最後最佳買價,最後最佳賣價,歷史最高價,歷史最低價,
#   是否因訊息面暫停交易,交易時段,價差對單式委託成交量
# "交易時段"欄位是"一般"(日盤)或"盤後"(夜盤)，同一天同一合約各一列。
#
# .NET Core/PowerShell 7在不註冊CodePagesEncodingProvider的情況下無法解析Big5(950)，
# Windows PowerShell 5.1則原生支援；這裡統一先嘗試註冊，失敗就當作已經內建，不影響後續。
try {
    Add-Type -AssemblyName System.Text.Encoding.CodePages -ErrorAction SilentlyContinue
    [System.Text.Encoding]::RegisterProvider([System.Text.CodePagesEncodingProvider]::Instance)
} catch {
    # Windows PowerShell 5.1沒有這個組件、或Provider已經註冊過，兩種情況都安全忽略
}

function Get-TaifexFutDataDownRows($StartDate, $EndDate) {
    $body = "down_type=1&commodity_id=TX&commodity_id2=&queryStartDate=$StartDate&queryEndDate=$EndDate"
    $resp = Invoke-WebRequest -Uri "https://www.taifex.com.tw/cht/3/futDataDown" -Method Post `
        -Body $body -ContentType "application/x-www-form-urlencoded" -UserAgent $UA -TimeoutSec 30 -UseBasicParsing
    $bytes = $resp.RawContentStream.ToArray()
    $text = [System.Text.Encoding]::GetEncoding(950).GetString($bytes)
    $lines = $text -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 }
    if ($lines.Count -lt 2) { throw "futDataDown回傳內容為空或格式不符：$($text.Substring(0, [Math]::Min(200, $text.Length)))" }
    return $lines[1..($lines.Count - 1)] | ForEach-Object {
        $c = $_ -split ","
        [PSCustomObject]@{
            date = $c[0]; contract = $c[1]; contractMonth = $c[2].Trim()
            open = (ConvertTo-Num $c[3]); high = (ConvertTo-Num $c[4]); low = (ConvertTo-Num $c[5]); close = (ConvertTo-Num $c[6])
            volume = (ConvertTo-Num $c[9]); settlement = (ConvertTo-Num $c[10]); session = $c[17]
        }
    }
}

function Select-LatestNightRow($Rows) {
    $night = $Rows | Where-Object { $_.contract -eq "TX" -and $_.session -eq "盤後" -and $_.contractMonth -notlike "*/*" }
    if (-not $night -or $night.Count -eq 0) { return $null }
    $maxDate = ($night | Sort-Object date -Descending | Select-Object -First 1).date
    return $night | Where-Object { $_.date -eq $maxDate } | Sort-Object contractMonth | Select-Object -First 1
}

# openapi.taifex.com.tw僅提供「最新一個交易日」、futDataDown則是依日期範圍查詢，沒辦法
# 直接跟API要前一天的收盤價來算漲跌%。改成把上一次寫進data.json的taifexNightClose當作
# 前一天的基準，跟這次新抓到的比較；date有變才代表換到新一場夜盤，重新計算漲跌%。
#
# date沒變(還是同一場夜盤，例如同一天內這個workflow被手動重複觸發、或renew-2330這種
# 補跑)時，不能拿「這場」跟「自己」比出漲跌%——但也不能就此把changePct/changePts重置
# 成null，否則每次手動補跑都會把稍早已經算好的漲跌%洗掉。date沒變時保留$Previous裡
# 原本的值。
function Get-TaifexNightClose($Previous) {
    $nowTaipei = (Get-Date).ToUniversalTime().AddHours(8)
    $endStr = $nowTaipei.ToString("yyyy/MM/dd")
    $startStr = $nowTaipei.AddDays(-5).ToString("yyyy/MM/dd")
    $rows = Get-TaifexFutDataDownRows $startStr $endStr
    $row = Select-LatestNightRow $rows
    if (-not $row) { throw "futDataDown找不到TX盤後(夜盤)資料，查詢範圍=$startStr~$endStr" }
    $close = $row.settlement
    if (-not $close) { $close = $row.close }
    if (-not $close) { throw "TX盤後資料找到但無法解析收盤價欄位，原始資料=$($row | ConvertTo-Json -Compress)" }
    $isoDate = $row.date -replace "/", "-"
    $changePct = $null; $changePts = $null
    if ($Previous -and $Previous.close -and $Previous.date -and $isoDate) {
        if ($Previous.date -ne $isoDate) {
            $changePct = [math]::Round((($close / $Previous.close) - 1) * 100, 2)
            $changePts = [math]::Round($close - $Previous.close, 2)
        } else {
            $changePct = $Previous.changePct
            $changePts = $Previous.changePts
        }
    }
    return [PSCustomObject]@{
        contractMonth = $row.contractMonth; close = $close; changePct = $changePct; changePts = $changePts
        open = $row.open; high = $row.high; low = $row.low; volume = $row.volume; date = $isoDate
    }
}

# 各因子權重由重到輕：夜盤台指期(1.4) > SOX費半指數(1.2) > 選擇權Put/Call Ratio(1.0，
# 錨點) > 外資買賣超(0.8) > 投信買賣超(0.6) > 加權指數(0.4)，以Put/Call Ratio原本的
# 1.0為錨點、上下各用0.2等差排開。理由：台灣產業結構偏重科技半導體，且台股「一日
# 一市」，收盤後到隔天開盤前唯一還在跳動的兩個訊號就是夜盤台指期跟SOX費半指數，比
# 隔天才公布的三大法人買賣超更即時、也比加權指數(本身已經是落後一天的收盤資訊)更有
# 前瞻性。
function Get-ChipTrend($Raw) {
    $score = 0.0; $weightSum = 0.0
    $reasons = @()
    $risk = @()

    if ($Raw.taifexNightClose -and $null -ne $Raw.taifexNightClose.changePct) {
        $score += [math]::Sign($Raw.taifexNightClose.changePct) * 1.4; $weightSum += 1.4
        $dir = if ($Raw.taifexNightClose.changePct -ge 0) { "上漲" } else { "下跌" }
        $reasons += "台指期夜盤$dir$([math]::Abs($Raw.taifexNightClose.changePct).ToString('F2'))%"
    }
    if ($Raw.soxIndex -and $null -ne $Raw.soxIndex.changePct) {
        $score += [math]::Sign($Raw.soxIndex.changePct) * 1.2; $weightSum += 1.2
        $dir = if ($Raw.soxIndex.changePct -ge 0) { "上漲" } else { "下跌" }
        $reasons += "SOX費半指數$dir$([math]::Abs($Raw.soxIndex.changePct).ToString('F2'))%"
    }
    if ($Raw.institutionalNet) {
        $inet = $Raw.institutionalNet
        if ($null -ne $inet.foreignNetLots) {
            $score += [math]::Sign($inet.foreignNetLots) * 0.8; $weightSum += 0.8
            $dir = if ($inet.foreignNetLots -ge 0) { "買超" } else { "賣超" }
            $reasons += "外資$dir$([math]::Abs($inet.foreignNetLots).ToString('N0'))張"
        }
        if ($null -ne $inet.trustNetLots) {
            $score += [math]::Sign($inet.trustNetLots) * 0.6; $weightSum += 0.6
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

# 台指期(TX)夜盤歷史序列：永久保留、逐日累積(跟merge-and-classify.ps1的
# Update-AdrPremiumHistory同一套read-try/catch→Map upsert-by-date→sort→write模式)，
# 供「開盤價機率預估」四變數模型(Get-OpenGapModelV4)訓練用。只在「換日」那一刻
# ($Previous.date -ne $Current.date)才把$Previous這筆append進去——因為$Previous換日後
# 就確定不會再被Get-TaifexNightClose的校正邏輯改動(校正只發生在「同一個date」的情況)，
# 此時才是它真正定案、可以永久寫入的時間點；$raw.taifexNightClose目前這筆(還在今天)
# 則留給明天換日時才寫入，避免把還可能被SettlementPrice校正的暫定值寫死進歷史。
function Update-TaifexNightHistory($Previous, $Current) {
    if (-not $Previous -or $null -eq $Previous.close -or $null -eq $Previous.date) { return }
    if (-not $Current -or $null -eq $Current.date -or $Current.date -eq $Previous.date) { return }
    $history = @()
    try {
        $history = Get-Content $TxNightHistoryPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        # 檔案不存在或格式壞掉，視為空歷史，從頭建立
    }
    $byDate = @{}
    foreach ($h in $history) { $byDate[$h.date] = $h }
    # open/high/low/volume是後來才加的欄位，種子歷史(使用者提供的CSV回填那384筆)沒有這幾
    # 個值，統一存$null讓欄位形狀固定，前端渲染K線圖時再自行判斷要不要退化處理。
    $byDate[$Previous.date] = [PSCustomObject]@{
        date = $Previous.date; close = $Previous.close; changePct = $Previous.changePct; changePts = $Previous.changePts
        open = $Previous.open; high = $Previous.high; low = $Previous.low; volume = $Previous.volume
    }
    $merged = @($byDate.Values | Sort-Object date)
    $merged | ConvertTo-Json -Depth 8 -Compress | Out-File -FilePath $TxNightHistoryPath -Encoding utf8
    Write-Host "已更新台指期夜盤歷史紀錄: $TxNightHistoryPath（累計 $($merged.Count) 筆，新增/更新 $($Previous.date)）"
}

function Invoke-Safe($label, [scriptblock]$fn) {
    try { return & $fn }
    catch {
        Write-Warning "[market-context] $label 失敗，該欄位維持 null: $($_.Exception.Message)"
        return $null
    }
}

$raw = Get-Content $DataPath -Raw -Encoding UTF8 | ConvertFrom-Json

# -SkipMarketContext：跟merge-and-classify.ps1的-BackfillOnly同一套鎖定時間窗邏輯
# (見update-dashboard.yml)，手動觸發且落在鎖定時間窗內時使用。台指期夜盤
# (taifexNightClose)不受這個旗標影響，鎖定期間依然照常更新。
if (-not $SkipMarketContext) {
    $raw | Add-Member -MemberType NoteProperty -Name "marginTrading" -Value (Invoke-Safe "融資融券餘額" { Get-MarginTrading }) -Force
    $raw | Add-Member -MemberType NoteProperty -Name "soxIndex" -Value (Invoke-Safe "SOX指數" { Get-YahooIndex "^SOX" }) -Force
    $raw | Add-Member -MemberType NoteProperty -Name "taiexIndex" -Value (Invoke-Safe "TAIEX指數" { Get-YahooIndex "^TWII" }) -Force
} else {
    Write-Host "手動觸發且落在鎖定時間窗內，籌碼面/大盤指數維持上一次的值，只更新夜盤資料"
}

$previousTaifexNightClose = $raw.taifexNightClose
$raw | Add-Member -MemberType NoteProperty -Name "taifexNightClose" -Value (Invoke-Safe "台指期夜盤收盤" { Get-TaifexNightClose $previousTaifexNightClose }) -Force
Invoke-Safe "台指期夜盤歷史紀錄累積" { Update-TaifexNightHistory $previousTaifexNightClose $raw.taifexNightClose } | Out-Null

if (-not $SkipMarketContext) {
    $raw | Add-Member -MemberType NoteProperty -Name "institutionalNet" -Value (Invoke-Safe "三大法人買賣超" { Get-InstitutionalNet $raw.daily }) -Force
    $raw | Add-Member -MemberType NoteProperty -Name "exDividend" -Value (Invoke-Safe "除權息預告" { Get-ExDividend }) -Force
    $raw | Add-Member -MemberType NoteProperty -Name "optionsMarket" -Value (Invoke-Safe "選擇權未平倉" { Get-OptionsMarket }) -Force
    $raw | Add-Member -MemberType NoteProperty -Name "chipTrend" -Value (Invoke-Safe "籌碼面趨勢判讀" { Get-ChipTrend $raw }) -Force
}

$raw | ConvertTo-Json -Depth 8 -Compress | Out-File -FilePath $DataPath -Encoding utf8
if ($SkipMarketContext) {
    Write-Host "已更新 taifexNightClose（籌碼面/大盤指數本次略過）"
} else {
    Write-Host "已更新 marginTrading / soxIndex / taiexIndex / taifexNightClose / institutionalNet / exDividend / optionsMarket / chipTrend"
}
