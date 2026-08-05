<#
  抓取台積電(2330)盤中即時報價（TWSE MIS API），更新 data\data.json 的 liveQuote 欄位。
  只更新這一個欄位，其餘資料（日K、ADR、匯率、技術指標...）維持不動，交給每日完整流程處理。
  供交易日盤中排程（例如每5分鐘）使用，邏輯與 fetch-live-quote.mjs 對等。
#>

$ErrorActionPreference = "Stop"
$UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
$DataPath = Join-Path $PSScriptRoot "..\data\data.json"

function ConvertTo-Num($s) {
    if ($null -eq $s) { return $null }
    $t = ($s -replace ",", "").Trim()
    if ($t -eq "" -or $t -eq "-") { return $null }
    [double]$v = 0
    if ([double]::TryParse($t, [ref]$v)) { return $v }
    return $null
}

# 回傳 $null 代表「今天大概不是交易日／目前沒有可用報價」，這是預期內會發生的情況
# （例如國定假日排程照樣每5分鐘觸發一次），呼叫端應該安靜跳過，不要當成錯誤讓
# workflow 失敗——不然遇到連續假期，Actions 頁面會整天被同一個原因的紅色 X 洗版。
# 真正的錯誤（HTTP 失敗、JSON 格式不對）還是照樣 throw，讓 workflow 顯示失敗，
# 因為那種才是真的需要留意的異常。
function Get-LiveQuote {
    $url = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw&json=1&delay=0"
    $resp = Invoke-WebRequest -Uri $url -UserAgent $UA -TimeoutSec 30 -UseBasicParsing
    $bytes = $resp.RawContentStream.ToArray()
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    $json = $text | ConvertFrom-Json

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

# 台指期(TX)近月合約盤後(夜盤)收盤價的「校正」：fetch-market-context.ps1在06:00當天第一次
# 抓的時候，官方結算價(SettlementPrice)通常還沒算出來(要併入08:45後的一般交易時段才會有
# 值)，只能先用當時的最後成交價(Last)頂著，跟官方結算價可能有落差(曾實測差到197點)。這裡
# 趁交易時段每5分鐘都會執行一次的機會，重抓同一支API，一旦SettlementPrice出現就自動覆蓋掉
# 暫定的Last值；date沒變就代表還是同一個夜盤，changePct(相對前一天)維持原本算好的值不動，
# 只換掉close本身。
function Invoke-JsonGet($url) {
    $resp = Invoke-WebRequest -Uri $url -UserAgent $UA -TimeoutSec 30 -UseBasicParsing
    $bytes = $resp.RawContentStream.ToArray()
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    return $text | ConvertFrom-Json
}

# 改用futDataDown端點取代openapi.taifex.com.tw——原因見fetch-market-context.ps1的
# Get-TaifexNightClose同一段註解(openapi那支「即時」API實測是每日批次更新一次，夜盤
# 交易時段內完全不會變；futDataDown才會即時反映夜盤交易中的最新成交)。
try {
    Add-Type -AssemblyName System.Text.Encoding.CodePages -ErrorAction SilentlyContinue
    [System.Text.Encoding]::RegisterProvider([System.Text.CodePagesEncodingProvider]::Instance)
} catch {
    # Windows PowerShell 5.1沒有這個組件、或Provider已經註冊過，兩種情況都安全忽略
}

function Update-TaifexNightClose($Raw) {
    $nowTaipei = (Get-Date).ToUniversalTime().AddHours(8)
    $endStr = $nowTaipei.ToString("yyyy/MM/dd")
    $startStr = $nowTaipei.AddDays(-5).ToString("yyyy/MM/dd")
    $body = "down_type=1&commodity_id=TX&commodity_id2=&queryStartDate=$startStr&queryEndDate=$endStr"
    $resp = Invoke-WebRequest -Uri "https://www.taifex.com.tw/cht/3/futDataDown" -Method Post `
        -Body $body -ContentType "application/x-www-form-urlencoded" -UserAgent $UA -TimeoutSec 30 -UseBasicParsing
    $bytes = $resp.RawContentStream.ToArray()
    $text = [System.Text.Encoding]::GetEncoding(950).GetString($bytes)
    $lines = $text -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 }
    if ($lines.Count -lt 2) { return $false }
    # 欄位順序驗證見fetch-market-context.ps1的Get-TaifexFutDataDownRows同一段註解。
    $night = $lines[1..($lines.Count - 1)] | ForEach-Object {
        $c = $_ -split ","
        [PSCustomObject]@{
            date = $c[0]; contract = $c[1]; contractMonth = $c[2].Trim()
            open = (ConvertTo-Num $c[3]); high = (ConvertTo-Num $c[4]); low = (ConvertTo-Num $c[5]); close = (ConvertTo-Num $c[6])
            volume = (ConvertTo-Num $c[9]); settlement = (ConvertTo-Num $c[10]); session = $c[17]
        }
    } | Where-Object { $_.contract -eq "TX" -and $_.session -eq "盤後" -and $_.contractMonth -notlike "*/*" }
    if (-not $night -or $night.Count -eq 0) { return $false }
    $maxDate = ($night | Sort-Object date -Descending | Select-Object -First 1).date
    $row = $night | Where-Object { $_.date -eq $maxDate } | Sort-Object contractMonth | Select-Object -First 1

    $close = $row.settlement
    if (-not $close) { $close = $row.close }
    if (-not $close) { return $false }
    $open = $row.open; $high = $row.high; $low = $row.low; $volume = $row.volume
    if (-not $row.date) { return $false }
    $isoDate = $row.date -replace "/", "-"

    $prev = $Raw.taifexNightClose
    if (-not $prev -or $prev.date -ne $isoDate) {
        $changePct = $null; $changePts = $null
        if ($prev -and $prev.close) {
            $changePct = [math]::Round((($close / $prev.close) - 1) * 100, 2)
            $changePts = [math]::Round($close - $prev.close, 2)
        }
        $Raw | Add-Member -MemberType NoteProperty -Name "taifexNightClose" -Value ([PSCustomObject]@{
            contractMonth = $row.contractMonth; close = $close; changePct = $changePct; changePts = $changePts
            open = $open; high = $high; low = $low; volume = $volume; date = $isoDate
        }) -Force
        return $true
    } elseif ($prev.close -ne $close -or $prev.open -ne $open -or $prev.high -ne $high -or $prev.low -ne $low -or $prev.volume -ne $volume) {
        $prev.close = $close; $prev.open = $open; $prev.high = $high; $prev.low = $low; $prev.volume = $volume
        if ($row.contractMonth) { $prev.contractMonth = $row.contractMonth }
        Write-Host "已校正 taifexNightClose: 收盤 -> $close"
        return $true
    }
    return $false
}

function Invoke-Safe-NightClose($Raw) {
    try { return Update-TaifexNightClose $Raw }
    catch {
        Write-Host "台指期夜盤收盤校正失敗（略過，不影響其他欄位）: $($_.Exception.Message)"
        return $false
    }
}

$raw = Get-Content $DataPath -Raw -Encoding UTF8 | ConvertFrom-Json
$changed = $false

$liveQuote = Get-LiveQuote
if ($null -eq $liveQuote) {
    Write-Host "目前沒有可用的即時報價（可能不是交易日，或尚未開盤），本次跳過。"
} else {
    $raw | Add-Member -MemberType NoteProperty -Name "liveQuote" -Value $liveQuote -Force
    $changed = $true
    Write-Host "已更新 liveQuote: $($liveQuote.date) $($liveQuote.time) $($liveQuote.price)"
}

if (Invoke-Safe-NightClose $raw) { $changed = $true }

if ($changed) {
    $raw | ConvertTo-Json -Depth 8 -Compress | Out-File -FilePath $DataPath -Encoding utf8
}
