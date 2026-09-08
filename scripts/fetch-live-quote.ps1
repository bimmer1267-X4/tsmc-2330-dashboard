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

# 回傳 $null 代表「今天大概不是交易日／目前沒有可用報價」，這是預期內會發生的情況
# （例如國定假日排程照樣每5分鐘觸發一次），呼叫端應該安靜跳過，不要當成錯誤讓
# workflow 失敗——不然遇到連續假期，Actions 頁面會整天被同一個原因的紅色 X 洗版。
# 真正的錯誤（重試後仍HTTP失敗、JSON格式不對）還是照樣 throw，讓 workflow 顯示
# 失敗，因為那種才是真的需要留意的異常。
function Get-LiveQuote {
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

$raw = Get-Content $DataPath -Raw -Encoding UTF8 | ConvertFrom-Json

$liveQuote = Get-LiveQuote
if ($null -eq $liveQuote) {
    Write-Host "目前沒有可用的即時報價（可能不是交易日，或尚未開盤），本次跳過。"
} else {
    $raw | Add-Member -MemberType NoteProperty -Name "liveQuote" -Value $liveQuote -Force
    Write-Host "已更新 liveQuote: $($liveQuote.date) $($liveQuote.time) $($liveQuote.price)"
    $raw | ConvertTo-Json -Depth 8 -Compress | Out-File -FilePath $DataPath -Encoding utf8
}
