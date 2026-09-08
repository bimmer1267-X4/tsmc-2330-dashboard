<#
  抓取台積電(2330)盤中即時報價（TWSE MIS API），更新 data\data.json 的 liveQuote 欄位。
  只更新這一個欄位，其餘資料（日K、ADR、匯率、技術指標...）維持不動，交給每日完整流程處理。
  供交易日盤中排程（例如每5分鐘）使用，邏輯與 fetch-live-quote.mjs 對等。
#>

$ErrorActionPreference = "Stop"
$UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
$DataPath = Join-Path $PSScriptRoot "..\data\data.json"

# 實測發現 TWSE MIS API 三不五時會出現連線層級的暫時性錯誤（連線被對方重置），跟
# 「非交易時段沒有報價」是不同性質的問題——這種屬於偶發的網路抖動，通常隔幾秒
# 重試就會恢復，不該讓整個 workflow 直接失敗。加上簡單的重試+退避，多給幾次機會；
# 如果重試完還是失敗，才讓錯誤往外拋，交由呼叫端判定為真正的異常。
$FetchMaxAttempts = 3
$FetchRetryDelaySec = 3

function ConvertTo-Num($s) {
    if ($null -eq $s) { return $null }
    $t = ($s -replace ",", "").Trim()
    if ($t -eq "" -or $t -eq "-") { return $null }
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

# 目前台北時間對應的yyyy-MM-dd，不依賴本機系統時區設定。
function Get-TaipeiTodayIso {
    $tz = [System.TimeZoneInfo]::FindSystemTimeZoneById("Taipei Standard Time")
    $taipeiNow = [System.TimeZoneInfo]::ConvertTimeFromUtc((Get-Date).ToUniversalTime(), $tz)
    return $taipeiNow.ToString("yyyy-MM-dd")
}

# 對 TWSE MIS API 發出請求並解析 JSON，遇到連線層級的暫時性錯誤或 HTTP 失敗時
# 會重試最多 $FetchMaxAttempts 次（每次間隔遞增），全部重試完仍失敗才把最後一次
# 的錯誤往外拋。
function Get-StockInfoJson($url) {
    $lastErr = $null
    for ($attempt = 1; $attempt -le $FetchMaxAttempts; $attempt++) {
        try {
            $resp = Invoke-WebRequest -Uri $url -UserAgent $UA -TimeoutSec 30 -UseBasicParsing
            $bytes = $resp.RawContentStream.ToArray()
            $text = [System.Text.Encoding]::UTF8.GetString($bytes)
            return ($text | ConvertFrom-Json)
        } catch {
            $lastErr = $_
            if ($attempt -lt $FetchMaxAttempts) {
                Write-Warning "抓取即時報價第${attempt}次嘗試失敗（$($_.Exception.Message)），$($FetchRetryDelaySec * $attempt)秒後重試..."
                Start-Sleep -Seconds ($FetchRetryDelaySec * $attempt)
            }
        }
    }
    throw $lastErr
}

# 主要來源：TWSE MIS 即時報價（mis.twse.com.tw）。回傳 $null 代表「目前沒有可用報價」
# （例如根本不是交易日，或msgArray/z/y都是空的這種正常但沒資料的情況），不是錯誤。
# 連線本身若重試完仍失敗，讓例外往外拋，交給 Get-LiveQuote() 判斷要不要改走備援。
function Get-LiveQuoteViaMis {
    $url = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw&json=1&delay=0"
    $json = Get-StockInfoJson $url

    if (-not $json.msgArray -or $json.msgArray.Count -eq 0) {
        return $null
    }
    $item = $json.msgArray[0]

    # z = 成交價；盤中尚無成交時 z 會是 "-"，退回昨收 y
    $price = ConvertTo-Num $item.z
    if ($null -eq $price) { $price = ConvertTo-Num $item.y }
    if ($null -eq $price) { return $null }

    $d = $item.d
    if ($null -eq $d -or $d.Length -ne 8) { return $null }
    $date = "{0}-{1}-{2}" -f $d.Substring(0,4), $d.Substring(4,2), $d.Substring(6,2)

    return [PSCustomObject]@{
        date  = $date
        time  = $item.t
        price = $price
    }
}

# 備援來源：即時查詢 TWSE STOCK_DAY 日K報表（www.twse.com.tw，跟MIS是完全不同的
# 網域/系統）取得今天的收盤價。這支報表跟「近6個月K線圖」卡片(update-dashboard.ps1
# 的日K抓取)用的是同一個API，實測MIS連續多次連線失敗期間，這支報表持續正常運作，
# 資料本質上可共用——只是它是「官方日K收盤」，不是「盤中即時成交價」，時間固定寫
# 官方收盤時間13:30:00，只有在「今天」這筆已經公告時才有意義。
# 回傳 $null 代表TWSE還沒把今天的資料結算公告完成（正常情況，非錯誤）；HTTP/連線
# 層級的錯誤照樣往外拋。
function Get-LiveQuoteViaStockDayFallback($TodayIso) {
    $today = Get-Date
    $dateParam = $today.ToString("yyyyMM") + "01"
    $url = "https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=$dateParam&stockNo=2330"
    $resp = Invoke-WebRequest -Uri $url -UserAgent $UA -TimeoutSec 30 -UseBasicParsing
    $bytes = $resp.RawContentStream.ToArray()
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    $json = $text | ConvertFrom-Json

    if ($json.stat -ne "OK" -or -not $json.data) { return $null }

    $row = $json.data | Where-Object { (ConvertFrom-RocDate $_[0]) -eq $TodayIso } | Select-Object -First 1
    if ($null -eq $row) { return $null } # 今天的資料還沒公告，非錯誤

    $price = ConvertTo-Num $row[6] # 收盤價
    if ($null -eq $price) { return $null }

    return [PSCustomObject]@{
        date  = $TodayIso
        time  = "13:30:00"
        price = $price
    }
}

# 三層取得順序：
#   1. TWSE MIS 即時報價（含自身的連線重試）——唯一能反映「盤中」成交價的來源。
#   2. 若MIS重試後仍徹底失敗：先看 data.json 裡「近6個月K線圖」卡片(daily)是不是
#      已經有今天這筆收盤資料（例如今天稍早已經成功跑過一次完整流程）——有的話
#      直接沿用，不必再發任何網路請求。
#   3. 本地也沒有的話，才即時重新查詢同一支STOCK_DAY報表（不同網域，通常不受
#      MIS本身的連線問題牽連）。
# 只有「MIS失敗、且備援也是真的連線/HTTP錯誤」才會讓錯誤最終往外拋、使workflow
# 顯示失敗；MIS或備援回應正常但單純還沒有資料，一律視為「目前沒有可用報價」安靜跳過。
function Get-LiveQuote($Raw) {
    try {
        return Get-LiveQuoteViaMis
    } catch {
        $misErr = $_
        Write-Warning "主要來源(TWSE MIS)重試後仍失敗（$($misErr.Exception.Message)），改嘗試備援來源..."

        $todayIso = Get-TaipeiTodayIso
        $localToday = $null
        if ($Raw.daily) {
            $localToday = $Raw.daily | Where-Object { $_.date -eq $todayIso } | Select-Object -First 1
        }
        if ($null -ne $localToday -and $null -ne $localToday.close) {
            Write-Host "備援：沿用 data.json 既有「近6個月K線圖」資料中今天($todayIso)的收盤價，不需額外連線。"
            return [PSCustomObject]@{
                date  = $todayIso
                time  = "13:30:00"
                price = $localToday.close
            }
        }

        try {
            $viaFallback = Get-LiveQuoteViaStockDayFallback $todayIso
            if ($null -ne $viaFallback) {
                Write-Host "備援：即時查詢TWSE STOCK_DAY取得今天收盤價: $($viaFallback.price)"
                return $viaFallback
            }
            Write-Host "主要來源與備援來源目前都還沒有今天的收盤資料，本次先跳過。"
            return $null
        } catch {
            Write-Warning "備援來源(TWSE STOCK_DAY)也失敗: $($_.Exception.Message)"
            throw $misErr
        }
    }
}

$raw = Get-Content $DataPath -Raw -Encoding UTF8 | ConvertFrom-Json

$liveQuote = Get-LiveQuote $raw
if ($null -eq $liveQuote) {
    Write-Host "目前沒有可用的即時報價（可能不是交易日，或尚未開盤），本次跳過。"
} else {
    $raw | Add-Member -MemberType NoteProperty -Name "liveQuote" -Value $liveQuote -Force
    Write-Host "已更新 liveQuote: $($liveQuote.date) $($liveQuote.time) $($liveQuote.price)"
    $raw | ConvertTo-Json -Depth 8 -Compress | Out-File -FilePath $DataPath -Encoding utf8
}
