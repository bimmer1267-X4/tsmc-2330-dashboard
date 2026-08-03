<#
  合併 ADR / 匯率資料（由 Claude 透過 WebFetch 交叉比對兩來源後取得；若省略參數則自動
  改用 Yahoo Finance 單一來源抓取，供排程自動化使用）進 data.json，
  並依「估值分區框架」計算目前價格所屬區間：便宜價／甜甜價／正常／超貴價。
  同時用近1年 ADR/匯率/台股歷史資料訓練「ADR隔夜漲跌% + ADR溢價偏離% + ADR歷史相近價位
  類比估計缺口%」三變數OLS迴歸，套用在今天的ADR變動/溢價狀態/類比估計上，機率性推估
  台股開盤價（含68%/95%信賴區間、上漲機率、模型信心指數＝調整後R²）。套牢價、ADR歷史
  相近價位類比估計卡片本身這兩個既有功能仍只看近6個月。
  另外會把ADR溢價率逐日累積寫進 data\adr-premium-history.json（永久保留，不像
  data.json只留近6個月滾動視窗），是雙變數迴歸模型的訓練資料來源之一。
  同時把每天的開盤價預測、以及後續回填的實際開盤/收盤結果，永久累積寫進
  data\prediction-accuracy-history.json，供長期追蹤模型的方向命中率/誤差(偏誤)/
  信賴區間覆蓋率是否符合預期，聚合摘要寫進 data.json 的 predictionAccuracySummary。

  用法（手動交叉比對）：
    .\merge-and-classify.ps1 -AdrPrice 424.61 -AdrChangePct 5.55 -AdrQuoteTime "2026-07-21T16:00:00-04:00" `
        -UsdTwd 32.325 -FxQuoteTime "2026-07-22T08:02:00+08:00"

  用法（排程自動化，省略參數即自動從 Yahoo Finance 抓取 ADR/匯率）：
    .\merge-and-classify.ps1
#>
param(
    [double]$AdrPrice,
    [double]$AdrChangePct,
    [string]$AdrQuoteTime,
    [double]$UsdTwd,
    [string]$FxQuoteTime,
    [double]$AdrRatio = 5
)

$ErrorActionPreference = "Stop"
# ADR/匯率序列固定抓1年：「套牢價」「ADR歷史相近價位類比估計」這兩個既有功能仍然只看
# 近6個月(用Get-RecentMonthsSeries從這份1年資料裡篩出6個月子集，維持原本文案/行為不變)，
# 只有「開盤價機率預估」的雙變數迴歸(ADR漲跌%+溢價偏離%)改用完整1年資料訓練。
$RegressionWindowMonths = 12
$MinRegressionSamples = 20
$MinRegressionSamplesV2 = 60
$MinRegressionSamplesV3 = 80
$PremiumRollWindowDays = 60
$PremiumHistoryPath = Join-Path $PSScriptRoot "..\data\adr-premium-history.json"
$PredictionHistoryPath = Join-Path $PSScriptRoot "..\data\prediction-accuracy-history.json"
# 開盤價預測準確度追蹤：統計區間樣本數低於這個門檻就不顯示；前端折線圖只取最近這麼多筆
# 已解析的紀錄(有界)；資料庫是空檔案時，用最近這麼多個歷史訓練配對回溯種一批初始樣本。
$MinAccuracySamples = 10
$AccuracyRecentSeriesLimit = 120
$AccuracySeedCount = 15

# 抓取 Yahoo Finance 每日收盤序列。除了回傳最新報價(price/changePct/quoteTime)，也回傳
# 完整每日收盤序列(Series)，供「ADR vs 開盤缺口」迴歸訓練使用，避免重複發送請求。
function Get-YahooDaily([string]$Symbol, [string]$Range = "1y") {
    $url = "https://query1.finance.yahoo.com/v8/finance/chart/$Symbol`?interval=1d&range=$Range"
    $resp = Invoke-RestMethod -Uri $url -Headers @{ "User-Agent" = "Mozilla/5.0 (compatible; tsmc-2330-dashboard/1.0)" }
    $result = $resp.chart.result[0]
    $meta = $result.meta
    if ($null -eq $meta) { throw "Yahoo Finance 無資料: $Symbol" }

    $timestamps = @($result.timestamp)
    $rawCloses = @($result.indicators.quote[0].close)
    $tz = [System.TimeZoneInfo]::FindSystemTimeZoneById("America/New_York")
    $series = New-Object System.Collections.Generic.List[PSCustomObject]
    for ($i = 0; $i -lt $timestamps.Count; $i++) {
        if ($null -eq $rawCloses[$i]) { continue }
        $utc = [datetimeoffset]::FromUnixTimeSeconds($timestamps[$i]).UtcDateTime
        $local = [System.TimeZoneInfo]::ConvertTimeFromUtc($utc, $tz)
        $series.Add([PSCustomObject]@{ date = $local.ToString("yyyy-MM-dd"); close = $rawCloses[$i] })
    }

    $price = $meta.regularMarketPrice
    # meta.previousClose 常缺失，meta.chartPreviousClose 是查詢範圍(range)起點之前的收盤價，
    # 不一定是「前一個交易日」，用它算漲跌%可能落差好幾天而算錯。但也不能單純假設「序列裡
    # 倒數第二筆」就是前一交易日：如果跟regularMarketTime同一天的那筆因為null被排除在
    # series之外，陣列會整體往前偏移一格，「倒數第二」實際上會變成大前天的收盤價。改成
    # 明確比對日期：從最新往回找，跳過跟regularMarketTime同一天的項目，取第一個「不同一天」
    # 的有效收盤價，確保漲跌%永遠是真正的逐日比較。
    $latestLocal = [System.TimeZoneInfo]::ConvertTimeFromUtc(([datetimeoffset]::FromUnixTimeSeconds($meta.regularMarketTime)).UtcDateTime, $tz)
    $latestDateStr = $latestLocal.ToString("yyyy-MM-dd")
    $prevClose = $null
    for ($i = $series.Count - 1; $i -ge 0; $i--) {
        if ($series[$i].date -ne $latestDateStr) { $prevClose = $series[$i].close; break }
    }
    if (-not $prevClose) {
        $prevClose = if ($meta.previousClose) { $meta.previousClose } else { $meta.chartPreviousClose }
    }
    $changePct = if ($prevClose) { [math]::Round(($price / $prevClose - 1) * 100, 2) } else { $null }
    $quoteTime = ([datetimeoffset]::FromUnixTimeSeconds($meta.regularMarketTime)).UtcDateTime.ToString("o")
    return [PSCustomObject]@{ price = $price; changePct = $changePct; quoteTime = $quoteTime; series = $series }
}

# ---- 統計小工具 ----
function Get-Mean([double[]]$a) { ($a | Measure-Object -Average).Average }
function Get-StdDev([double[]]$a) {
    $m = Get-Mean $a
    [math]::Sqrt((Get-Mean ($a | ForEach-Object { ($_ - $m) * ($_ - $m) })))
}
function Get-OlsRegression([double[]]$xs, [double[]]$ys) {
    $n = $xs.Count
    $mx = Get-Mean $xs; $my = Get-Mean $ys
    $sxy = 0.0; $sxx = 0.0; $syy = 0.0
    for ($i = 0; $i -lt $n; $i++) {
        $dx = $xs[$i] - $mx; $dy = $ys[$i] - $my
        $sxy += $dx * $dy; $sxx += $dx * $dx; $syy += $dy * $dy
    }
    $beta = $sxy / $sxx
    $alpha = $my - $beta * $mx
    $r = $sxy / [math]::Sqrt($sxx * $syy)
    return [PSCustomObject]@{ beta = $beta; alpha = $alpha; r = $r; r2 = $r * $r; n = $n }
}

# 二元線性迴歸 y = b0 + b1*x1 + b2*x2（附標準誤/t值/p值/調整後R²），用於
# 「開盤缺口% ~ ADR漲跌% + 溢價偏離%」雙變數模型。跟Get-OlsRegression同樣用中心化
# (離均差)平方和/交叉乘積的封閉解算係數；p值用常態分布近似t分布(樣本數門檻夠大時
# 這個近似不會有實質誤差)。
function Get-OlsRegression2([double[]]$xs1, [double[]]$xs2, [double[]]$ys) {
    $n = $xs1.Count
    $mx1 = Get-Mean $xs1; $mx2 = Get-Mean $xs2; $my = Get-Mean $ys
    $Sx1x1 = 0.0; $Sx2x2 = 0.0; $Sx1x2 = 0.0; $Sx1y = 0.0; $Sx2y = 0.0; $Syy = 0.0
    for ($i = 0; $i -lt $n; $i++) {
        $d1 = $xs1[$i] - $mx1; $d2 = $xs2[$i] - $mx2; $dy = $ys[$i] - $my
        $Sx1x1 += $d1 * $d1; $Sx2x2 += $d2 * $d2; $Sx1x2 += $d1 * $d2
        $Sx1y += $d1 * $dy; $Sx2y += $d2 * $dy; $Syy += $dy * $dy
    }
    $det = $Sx1x1 * $Sx2x2 - $Sx1x2 * $Sx1x2
    $b1 = ($Sx1y * $Sx2x2 - $Sx2y * $Sx1x2) / $det
    $b2 = ($Sx2y * $Sx1x1 - $Sx1y * $Sx1x2) / $det
    $b0 = $my - $b1 * $mx1 - $b2 * $mx2

    $ssRes = 0.0
    for ($i = 0; $i -lt $n; $i++) {
        $pred = $b0 + $b1 * $xs1[$i] + $b2 * $xs2[$i]
        $ssRes += ($ys[$i] - $pred) * ($ys[$i] - $pred)
    }
    $r2 = 1 - $ssRes / $Syy
    $k = 3
    $dof = $n - $k
    $sigma2 = $ssRes / $dof
    $seB1 = [math]::Sqrt(($sigma2 * $Sx2x2) / $det)
    $seB2 = [math]::Sqrt(($sigma2 * $Sx1x1) / $det)
    $tB1 = $b1 / $seB1; $tB2 = $b2 / $seB2
    $pB1 = 2 * (1 - (Get-NormalCdf ([math]::Abs($tB1))))
    $pB2 = 2 * (1 - (Get-NormalCdf ([math]::Abs($tB2))))
    $adjR2 = 1 - (1 - $r2) * ($n - 1) / $dof

    return [PSCustomObject]@{
        b0 = $b0; b1 = $b1; b2 = $b2; r2 = $r2; adjR2 = $adjR2; n = $n; dof = $dof
        seB1 = $seB1; seB2 = $seB2; tB1 = $tB1; tB2 = $tB2; pB1 = $pB1; pB2 = $pB2
    }
}
# 高斯-喬丹消去法求反矩陣，供 Get-OlsRegressionN 算 (X'X)⁻¹ 用。
function Get-InvertMatrix($M) {
    $p = $M.Count
    $A = New-Object 'object[,]' $p, (2 * $p)
    for ($i = 0; $i -lt $p; $i++) {
        for ($j = 0; $j -lt $p; $j++) { $A[$i, $j] = $M[$i][$j] }
        for ($j = 0; $j -lt $p; $j++) { $A[$i, $p + $j] = if ($i -eq $j) { 1.0 } else { 0.0 } }
    }
    for ($col = 0; $col -lt $p; $col++) {
        $pivot = $col
        for ($r = $col + 1; $r -lt $p; $r++) { if ([math]::Abs($A[$r, $col]) -gt [math]::Abs($A[$pivot, $col])) { $pivot = $r } }
        if ($pivot -ne $col) {
            for ($c = 0; $c -lt 2 * $p; $c++) { $tmp = $A[$col, $c]; $A[$col, $c] = $A[$pivot, $c]; $A[$pivot, $c] = $tmp }
        }
        $pv = $A[$col, $col]
        for ($c = 0; $c -lt 2 * $p; $c++) { $A[$col, $c] = $A[$col, $c] / $pv }
        for ($r = 0; $r -lt $p; $r++) {
            if ($r -eq $col) { continue }
            $f = $A[$r, $col]
            for ($c = 0; $c -lt 2 * $p; $c++) { $A[$r, $c] = $A[$r, $c] - $f * $A[$col, $c] }
        }
    }
    $inv = New-Object 'object[,]' $p, $p
    for ($i = 0; $i -lt $p; $i++) { for ($j = 0; $j -lt $p; $j++) { $inv[$i, $j] = $A[$i, $p + $j] } }
    return $inv
}

# 通用矩陣版 OLS（任意變數數，含截距），用於三變數模型（開盤缺口% ~ ADR漲跌% + 溢價偏離%
# + ADR歷史相近價位類比估計缺口%）。Get-OlsRegression/Get-OlsRegression2 是手推的封閉解，
# 只適用剛好1或2個變數；再加第3個變數硬推封閉解會變得很繁瑣，改用矩陣運算(X為n×p設計
# 矩陣，第一欄全為1即截距)的話不管未來加幾個變數都是同一套邏輯，不用每次重新手推公式。
# X: 每列是[1, x1, x2, ...]；y: 目標值陣列。回傳係數/標準誤/t值/p值都是跟X欄位順序對齊的陣列。
function Get-OlsRegressionN($X, [double[]]$y) {
    $n = $X.Count; $p = $X[0].Count
    $XtX = New-Object 'double[][]' $p
    for ($a = 0; $a -lt $p; $a++) { $XtX[$a] = New-Object double[] $p }
    $Xty = New-Object double[] $p
    for ($i = 0; $i -lt $n; $i++) {
        for ($a = 0; $a -lt $p; $a++) {
            $Xty[$a] += $X[$i][$a] * $y[$i]
            for ($b = 0; $b -lt $p; $b++) { $XtX[$a][$b] += $X[$i][$a] * $X[$i][$b] }
        }
    }
    $inv = Get-InvertMatrix $XtX
    $beta = New-Object double[] $p
    for ($a = 0; $a -lt $p; $a++) { for ($b = 0; $b -lt $p; $b++) { $beta[$a] += $inv[$a, $b] * $Xty[$b] } }

    $my = Get-Mean $y
    $ssRes = 0.0; $ssTot = 0.0
    for ($i = 0; $i -lt $n; $i++) {
        $pred = 0.0
        for ($a = 0; $a -lt $p; $a++) { $pred += $beta[$a] * $X[$i][$a] }
        $ssRes += ($y[$i] - $pred) * ($y[$i] - $pred)
        $ssTot += ($y[$i] - $my) * ($y[$i] - $my)
    }
    $r2 = 1 - $ssRes / $ssTot
    $dof = $n - $p
    $sigma2 = $ssRes / $dof
    $se = New-Object double[] $p
    for ($a = 0; $a -lt $p; $a++) { $se[$a] = [math]::Sqrt($sigma2 * $inv[$a, $a]) }
    $t = New-Object double[] $p
    $pval = New-Object double[] $p
    for ($a = 0; $a -lt $p; $a++) { $t[$a] = $beta[$a] / $se[$a]; $pval[$a] = 2 * (1 - (Get-NormalCdf ([math]::Abs($t[$a])))) }
    $adjR2 = 1 - (1 - $r2) * ($n - 1) / $dof

    return [PSCustomObject]@{ beta = $beta; se = $se; t = $t; p = $pval; r2 = $r2; adjR2 = $adjR2; n = $n; dof = $dof }
}

# 標準常態分布 CDF（Abramowitz & Stegun 7.1.26 近似），把「預估缺口% / 殘差標準差」換算成機率。
function Get-Erf([double]$x) {
    $sign = if ($x -lt 0) { -1 } else { 1 }
    $x = [math]::Abs($x)
    $a1=0.254829592; $a2=-0.284496736; $a3=1.421413741; $a4=-1.453152027; $a5=1.061405429; $p=0.3275911
    $t = 1 / (1 + $p * $x)
    $y = 1 - (((((($a5*$t+$a4)*$t)+$a3)*$t+$a2)*$t+$a1)*$t*[math]::Exp(-$x*$x))
    return $sign * $y
}
function Get-NormalCdf([double]$z) { return 0.5 * (1 + (Get-Erf ($z / [math]::Sqrt(2)))) }

function Find-NearestOnOrBefore($map, [string[]]$sortedDates, [string]$date) {
    $lo = 0; $hi = $sortedDates.Count - 1; $ans = $null
    while ($lo -le $hi) {
        $mid = [math]::Floor(($lo + $hi) / 2)
        if ($sortedDates[$mid] -le $date) { $ans = $sortedDates[$mid]; $lo = $mid + 1 } else { $hi = $mid - 1 }
    }
    if ($null -eq $ans) { return $null }
    return $map[$ans]
}

function ConvertFrom-RocDateM($rocDate) {
    # "115/07/21" -> "2026-07-21"
    $parts = $rocDate -split "/"
    $y = [int]$parts[0] + 1911
    return "{0:D4}-{1}-{2}" -f $y, $parts[1], $parts[2]
}

function Invoke-TwseJsonM($url) {
    $resp = Invoke-WebRequest -Uri $url -UserAgent "Mozilla/5.0 (compatible; tsmc-2330-dashboard/1.0)" -TimeoutSec 30 -UseBasicParsing
    $bytes = $resp.RawContentStream.ToArray()
    $text = [System.Text.Encoding]::UTF8.GetString($bytes)
    return $text | ConvertFrom-Json
}

# 抓近N個月的TWSE STOCK_DAY(月度報表)，只取「開盤價機率預估」雙變數迴歸需要的
# date/open/close——跟update-dashboard.ps1的同一段抓取邏輯是同一支API、同一種逐月
# 請求方式，但那邊固定近6個月是給K線圖/估值分區這些「顯示用」欄位，語意不能隨便改；
# 這裡另外獨立抓一份較長區間，只給統計模型訓練用，兩邊互不影響。
function Get-TwseDailyRange([int]$Months) {
    $daily = @()
    $today = Get-Date
    for ($i = $Months - 1; $i -ge 0; $i--) {
        $monthDate = $today.AddMonths(-$i)
        $dateParam = $monthDate.ToString("yyyyMM") + "01"
        $url = "https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=$dateParam&stockNo=2330"
        try {
            $resp = Invoke-TwseJsonM $url
            if ($resp.stat -eq "OK" -and $resp.data) {
                foreach ($row in $resp.data) {
                    $open = [double]($row[3] -replace ",", ""); $close = [double]($row[6] -replace ",", "")
                    if (-not [double]::IsNaN($open) -and -not [double]::IsNaN($close)) {
                        $daily += [PSCustomObject]@{ date = ConvertFrom-RocDateM $row[0]; open = $open; close = $close }
                    }
                }
            }
        } catch {
            Write-Warning "STOCK_DAY($Months 個月範圍) $dateParam 抓取失敗: $_"
        }
        Start-Sleep -Milliseconds 600
    }
    $seen = @{}
    $uniq = @($daily | Sort-Object date | Where-Object { if ($seen.ContainsKey($_.date)) { $false } else { $seen[$_.date] = $true; $true } })
    return $uniq
}

# 從一份日期已排序的{date, close, ...}序列裡，篩出「以序列最後一天為基準」往前推N個月
# 的子集——用來在已經抓了1年的ADR/匯率資料時，還原出原本「近6個月」語意的子集合，讓
# 套牢價、ADR歷史相近價位類比估計這兩個既有功能的行為/文案完全不受影響。
function Get-RecentMonthsSeries($Series, [int]$Months) {
    if ($Series.Count -eq 0) { return $Series }
    $latest = [datetime]::Parse($Series[-1].date)
    $cutoff = $latest.AddMonths(-$Months)
    $cutoffStr = $cutoff.ToString("yyyy-MM-dd")
    return @($Series | Where-Object { $_.date -ge $cutoffStr })
}

# ADR溢價率歷史序列，永久保留、逐日累積（不像data.json的daily只保留近6個月滾動視窗，
# 這份會一直長下去），供回測「溢價率相對自身歷史均值的偏離，對台股開盤缺口是否有額外
# 預測力」使用，也是「開盤價機率預估」雙變數模型的訓練資料來源之一。
#
# 時區對應：ADR(美股)的收盤時間換算成台北時間，落在台股「隔天凌晨」，所以「美股日期
# 字串D」這根K棒，實際上是在台股「D的隔天」開盤前就已經收盤、屬於已知資訊，正確的
# 配對方式是「ADR日期D → 之後第一個台股交易日T」，跟下面Get-OpenGapModel()的配對邏輯
# 完全一致(沿用同一套時區對應規則，不是另外發明一套)。
#
# 之前的版本誤用Find-NearestOnOrBefore(用台股日期去找「日期<=台股日期」的ADR資料)——
# 這個方向反了：只要Yahoo後來把「美股日期字串剛好等於台股日期」那根K棒也補進資料(回填
# 較舊歷史時幾乎必然發生)，就會誤判命中，實際上配到了時間上晚於台股T當天開盤、causally
# 不可能已知的ADR收盤價，因果順序顛倒。現在改成跟Get-OpenGapModel()一樣的配對方向。
#
# 假日不對應空值：美股/台股假日行事曆不同步，兩邊都只用「這個市場有開盤的那些日期」
# 比對(找不到就continue跳過，不塞null或用0代替)，長假會自然對應到假期結束後的下一個
# 台股交易日。
function Update-AdrPremiumHistory($TwDaily, $AdrDaily, $FxDaily, [double]$Ratio) {
    if ($null -eq $AdrDaily -or $null -eq $FxDaily) {
        Write-Host "ADR/匯率歷史序列缺失，略過ADR溢價率歷史紀錄更新"
        return @()
    }
    $history = @()
    if (Test-Path $PremiumHistoryPath) {
        try { $history = @(Get-Content $PremiumHistoryPath -Raw -Encoding UTF8 | ConvertFrom-Json) }
        catch { $history = @() }
    }
    $byDate = @{}
    foreach ($h in $history) { $byDate[$h.date] = $h }

    $adrMap = @{}; foreach ($s in $AdrDaily.series) { $adrMap[$s.date] = $s.close }
    $adrDates = @($AdrDaily.series | ForEach-Object { $_.date } | Sort-Object)
    $fxMap = @{}; foreach ($s in $FxDaily.series) { $fxMap[$s.date] = $s.close }
    $fxDates = @($FxDaily.series | ForEach-Object { $_.date } | Sort-Object)

    $touched = 0
    foreach ($D in $adrDates) {
        $adrClose = $adrMap[$D]
        $fx = Find-NearestOnOrBefore $fxMap $fxDates $D
        if ($null -eq $fx) { continue }

        $tIdx = -1
        for ($j = 0; $j -lt $TwDaily.Count; $j++) {
            if ($TwDaily[$j].date -gt $D) { $tIdx = $j; break }
        }
        if ($tIdx -lt 0) { continue }
        $day = $TwDaily[$tIdx]

        $impliedTwd = [math]::Round(($adrClose / $Ratio) * $fx, 2)
        $premiumPct = [math]::Round((($impliedTwd - $day.close) / $day.close) * 100, 2)
        $byDate[$day.date] = [PSCustomObject]@{
            date = $day.date; twClose = $day.close; adrClose = $adrClose; usdTwd = $fx
            adrRatio = $Ratio; impliedTwd = $impliedTwd; premiumPct = $premiumPct; adrDate = $D
        }
        $touched++
    }

    $merged = @($byDate.Values | Sort-Object date)
    $merged | ConvertTo-Json -Depth 4 -Compress | Out-File -FilePath $PremiumHistoryPath -Encoding utf8
    Write-Host "已更新ADR溢價率歷史紀錄: $PremiumHistoryPath（累計 $($merged.Count) 筆，本次範圍內更新 $touched 筆）"
    return $merged
}

# 把 $OpenPrediction（三/雙/單變數三種形狀之一）攤平成「開盤價預測準確度追蹤」歷史紀錄
# 的固定schema。basisPremiumDevPct/basisAnalogGapPct/confidenceIndexPct在單變數(甚至雙
# 變數)版本可能不存在——PowerShell存取PSCustomObject不存在的屬性會直接回傳$null，效果
# 跟.mjs版本的 ?? null 一樣，不用另外判斷。$AnalogMatches(即$d.adrAnalogMatches，「ADR
# 歷史相近價位類比估計」卡片本身的資料)是另一個獨立追蹤對象——不是OLS模型的一部分，
# 是同一張卡片上另一種估計方式，額外存一份analogEstimate，回填時會一併算出這個估計法
# 自己的誤差/命中率，讓使用者能比較兩種方法誰比較準，不是只看模型。
function New-PredictionHistoryEntry($OpenPrediction, [int]$ModelTier, [string]$PredictedDateStr, [string]$PredictedAt, [bool]$Seeded = $false, $AnalogMatches = $null) {
    $m = $OpenPrediction.model
    $analogEstimate = if ($AnalogMatches) {
        [PSCustomObject]@{ avgTwOpen = $AnalogMatches.avgTwOpen; avgTwOpenAdjusted = $AnalogMatches.avgTwOpenAdjusted; tolerancePct = $AnalogMatches.tolerancePct; count = $AnalogMatches.count; actual = $null }
    } else { $null }
    return [PSCustomObject]@{
        date = $PredictedDateStr
        predictedAt = $PredictedAt
        modelTier = $ModelTier
        predictedGapPct = $OpenPrediction.predictedGapPct
        predictedOpen = $OpenPrediction.predictedOpen
        ci68 = [PSCustomObject]@{ low = $OpenPrediction.ci68.low; high = $OpenPrediction.ci68.high }
        ci95 = [PSCustomObject]@{ low = $OpenPrediction.ci95.low; high = $OpenPrediction.ci95.high }
        probUpPct = $OpenPrediction.probUpPct
        basisAdrChangePct = $OpenPrediction.basisAdrChangePct
        basisPremiumDevPct = $OpenPrediction.basisPremiumDevPct
        basisAnalogGapPct = $OpenPrediction.basisAnalogGapPct
        basisPrevClose = $OpenPrediction.basisPrevClose
        residualStd = $m.residualStd
        confidenceIndexPct = $m.confidenceIndexPct
        seeded = $Seeded
        analogEstimate = $analogEstimate
        actual = $null
    }
}

# 依模型層級把訓練配對(Pair: {adrChangePct, premiumDev?, analogGapPct?})套進對應的迴歸公式，
# 算出「如果那天用這個(已經擬合好的)模型會預測出的開盤缺口%」——只給「種子回溯」使用，
# 邏輯跟main()裡即時預測套用係數的算法完全一致，只是輸入換成歷史配對而不是「今天」的值。
function Get-PredictedGapPctForTier($Pair, [int]$ModelTier, $Model) {
    if ($ModelTier -eq 3) {
        return $Model.beta[0] + $Model.beta[1] * $Pair.adrChangePct + $Model.beta[2] * $Pair.premiumDev + $Model.beta[3] * $Pair.analogGapPct
    }
    if ($ModelTier -eq 2) {
        return $Model.b0 + $Model.b1 * $Pair.adrChangePct + $Model.b2 * $Pair.premiumDev
    }
    return $Model.beta * $Pair.adrChangePct + $Model.alpha
}

# 開盤價預測準確度追蹤：資料庫是空檔案時，借用訓練配對(ModelPairs)裡最近AccuracySeedCount
# 筆，套用這次擬合好的模型係數反推出「如果那天這樣預測，結果會是多少」，直接連同已知的
# 實際結果一起寫入，標記seeded:true。⚠️ 限制：這幾筆用的是「看過完整1年資料後」擬合出的
# 係數回推，係數本身有看過這幾天(輕微樣本內偏差)，不是真正blind的即時預測——之後每天
# 新增的才是真正的即時預測，前端會分開標示。
# 「準確度」刻意拿收盤價($Pair.actualClose)驗證，不是開盤價($Pair.actualOpen)——雖然「盤前
# 股價預測」跟「ADR歷史相近價位類比估計」這兩個方法本身預測的目標是開盤價，但這裡改用
# 當日收盤價當最終驗證基準，誤差/命中率因此包含了開盤後到收盤的盤中變動。
#
# analogEstimate(「ADR歷史相近價位類比估計」卡片本身的估計)：直接對每筆種子樣本的日期D，
# 套用跟那張卡片完全相同的Get-AnalogMatches+近6個月窗口(Get-RecentMonthsSeries)，不是從
# 模型的3rd迴歸變數($Pair.analogGapPct，那個用的是1年因果裁切窗口，是模型自己的訓練
# 特徵，跟卡片本身的6個月窗口不是同一份計算)去反推近似值——用同一套函式、同一套窗口
# 邏輯，才是「跟卡片當天會顯示的值完全一致」。不依賴$ModelTier(V1/V2/V3都能算)。
function New-PredictionHistorySeeds($History, $ModelPairs, [int]$ModelTier, $Model, $AdrSeries, $FxSeries, $TwDaily) {
    if ($History.Count -gt 0 -or $null -eq $ModelPairs -or $ModelPairs.Count -eq 0) { return @() }
    $count = [math]::Min($AccuracySeedCount, $ModelPairs.Count)
    $seeds = @($ModelPairs[($ModelPairs.Count - $count)..($ModelPairs.Count - 1)])
    $now = (Get-Date).ToUniversalTime().ToString("o")
    $result = @()
    foreach ($pair in $seeds) {
        $predictedGapPct = [math]::Round((Get-PredictedGapPctForTier $pair $ModelTier $Model), 2)
        $priceAt = { param($gapPct) [math]::Round($pair.prevClose * (1 + $gapPct / 100), 2) }
        $probUpPct = [math]::Round((Get-NormalCdf ($predictedGapPct / $Model.residualStd)) * 100, 1)
        $actualGapPct = [math]::Round(($pair.actualClose / $pair.prevClose - 1) * 100, 2)
        $errorPct = [math]::Round($predictedGapPct - $actualGapPct, 2)
        $ci68 = [PSCustomObject]@{ low = (& $priceAt ($predictedGapPct - $Model.residualStd)); high = (& $priceAt ($predictedGapPct + $Model.residualStd)) }
        $ci95 = [PSCustomObject]@{ low = (& $priceAt ($predictedGapPct - 1.96 * $Model.residualStd)); high = (& $priceAt ($predictedGapPct + 1.96 * $Model.residualStd)) }
        $confidenceIndexPct = if ($ModelTier -ge 2) { [math]::Round(([math]::Max(0, $Model.adjR2)) * 100, 1) } else { $null }

        $analogEstimate = $null
        if ($AdrSeries -and $FxSeries -and $TwDaily -and $pair.adrDate) {
            $adrTrunc = Get-RecentMonthsSeries (@($AdrSeries | Where-Object { $_.date -le $pair.adrDate })) 6
            $fxTrunc = Get-RecentMonthsSeries (@($FxSeries | Where-Object { $_.date -le $pair.adrDate })) 6
            $twTrunc = @($TwDaily | Where-Object { $_.date -lt $pair.twDate })
            $analog = Get-AnalogMatches $pair.adrClose $adrTrunc $fxTrunc $twTrunc
            if ($analog) {
                # 種子樣本當時的「目標匯率」＝那個歷史日期D當下已知的最新匯率(跟卡片即時運算
                # 用「今天」的匯率是同一個概念，只是這裡的「今天」是歷史上的那一天)。fxTrunc
                # 已經篩到date<=pair.adrDate，用Find-NearestOnOrBefore取D當時最近一筆匯率報價。
                $fxDatesTrunc = @($fxTrunc | ForEach-Object { $_.date } | Sort-Object)
                $fxMapTrunc = @{}
                foreach ($s in $fxTrunc) { $fxMapTrunc[$s.date] = $s.close }
                $seedTodayFx = Find-NearestOnOrBefore $fxMapTrunc $fxDatesTrunc $pair.adrDate
                $avgTwOpenAdjusted = Get-AdjustedAvgTwOpen $analog.matches $seedTodayFx
                $analogPrice = if ($null -ne $avgTwOpenAdjusted) { $avgTwOpenAdjusted } else { $analog.avgTwOpen }
                $analogGapPct = [math]::Round(($analogPrice / $pair.prevClose - 1) * 100, 2)
                $analogErrorPct = [math]::Round($analogGapPct - $actualGapPct, 2)
                $analogEstimate = [PSCustomObject]@{
                    avgTwOpen = $analog.avgTwOpen
                    avgTwOpenAdjusted = $avgTwOpenAdjusted
                    tolerancePct = $analog.tolerancePct
                    count = $analog.count
                    actual = [PSCustomObject]@{
                        analogGapPct = $analogGapPct
                        errorPct = $analogErrorPct
                        absErrorPct = [math]::Round([math]::Abs($analogErrorPct), 2)
                        directionHit = ([math]::Sign($analogGapPct) -eq [math]::Sign($actualGapPct))
                        resolvedAt = $now
                    }
                }
            }
        }

        $entry = [PSCustomObject]@{
            date = $pair.twDate
            predictedAt = $now
            modelTier = $ModelTier
            predictedGapPct = $predictedGapPct
            predictedOpen = (& $priceAt $predictedGapPct)
            ci68 = $ci68
            ci95 = $ci95
            probUpPct = $probUpPct
            basisAdrChangePct = [math]::Round($pair.adrChangePct, 2)
            basisPremiumDevPct = if ($ModelTier -ge 2) { [math]::Round($pair.premiumDev, 2) } else { $null }
            basisAnalogGapPct = if ($ModelTier -ge 3) { [math]::Round($pair.analogGapPct, 2) } else { $null }
            basisPrevClose = $pair.prevClose
            residualStd = [math]::Round($Model.residualStd, 4)
            confidenceIndexPct = $confidenceIndexPct
            seeded = $true
            analogEstimate = $analogEstimate
            actual = [PSCustomObject]@{
                open = $pair.actualOpen
                close = $pair.actualClose
                actualGapPct = $actualGapPct
                errorPct = $errorPct
                absErrorPct = [math]::Round([math]::Abs($errorPct), 2)
                directionHit = ([math]::Sign($predictedGapPct) -eq [math]::Sign($actualGapPct))
                withinCi68 = ($pair.actualClose -ge $ci68.low -and $pair.actualClose -le $ci68.high)
                withinCi95 = ($pair.actualClose -ge $ci95.low -and $pair.actualClose -le $ci95.high)
                resolvedAt = $now
            }
        }
        $result += $entry
    }
    return $result
}

# 開盤價預測準確度歷史：永久保留、逐日累積(跟Update-AdrPremiumHistory同一套
# Test-Path/try-catch→hashtable upsert-by-date→sort→write模式)。每次執行做兩件事：
# (1)回填先前已經記錄、但當時台股還沒收盤所以actual還是$null的舊項目；(2)如果這次有
# 算出新預測(NewEntry非$null)，以actual:$null的狀態upsert進去，等未來的執行回填。
function Update-PredictionAccuracyHistory($TwDaily, $NewEntry) {
    $history = @()
    if (Test-Path $PredictionHistoryPath) {
        try { $history = @(Get-Content $PredictionHistoryPath -Raw -Encoding UTF8 | ConvertFrom-Json) }
        catch { $history = @() }
    }
    $byDate = @{}
    foreach ($h in $history) { $byDate[$h.date] = $h }

    $twByDate = @{}
    foreach ($t in $TwDaily) { $twByDate[$t.date] = $t }

    $backfilled = 0
    foreach ($entry in @($byDate.Values)) {
        if ($null -ne $entry.actual) { continue }
        if (-not $twByDate.ContainsKey($entry.date)) { continue }
        $day = $twByDate[$entry.date]
        # 用當日收盤價驗證(不是開盤價)：「盤前股價預測」跟「ADR歷史相近價位類比估計」預測的
        # 目標都是開盤價，但這裡改用收盤價當最終驗證基準，所以誤差/命中率會包含開盤後到收盤
        # 的盤中變動，不是純粹的開盤價預測誤差；open/close兩個原始值都照樣存起來供參考。
        $actualGapPct = [math]::Round(($day.close / $entry.basisPrevClose - 1) * 100, 2)
        $errorPct = [math]::Round($entry.predictedGapPct - $actualGapPct, 2)
        $resolvedAt = (Get-Date).ToUniversalTime().ToString("o")
        $entry.actual = [PSCustomObject]@{
            open = $day.open
            close = $day.close
            actualGapPct = $actualGapPct
            errorPct = $errorPct
            absErrorPct = [math]::Round([math]::Abs($errorPct), 2)
            directionHit = ([math]::Sign($entry.predictedGapPct) -eq [math]::Sign($actualGapPct))
            withinCi68 = ($day.close -ge $entry.ci68.low -and $day.close -le $entry.ci68.high)
            withinCi95 = ($day.close -ge $entry.ci95.low -and $day.close -le $entry.ci95.high)
            resolvedAt = $resolvedAt
        }
        # 「ADR歷史相近價位類比估計」是另一種獨立估計法(不是OLS模型)，同一天有記錄到的話
        # 也一併算出它自己的缺口%/誤差/方向命中，跟模型的準確度分開比較。PowerShell對$null
        # 取屬性(GET)是安全的會回傳$null，但對$null.屬性做SET會丟例外，所以要先判斷
        # $entry.analogEstimate存在才能寫入.actual。
        if ($entry.analogEstimate) {
            $analogPrice = if ($null -ne $entry.analogEstimate.avgTwOpenAdjusted) { $entry.analogEstimate.avgTwOpenAdjusted } else { $entry.analogEstimate.avgTwOpen }
            $analogGapPct = [math]::Round(($analogPrice / $entry.basisPrevClose - 1) * 100, 2)
            $analogErrorPct = [math]::Round($analogGapPct - $actualGapPct, 2)
            $entry.analogEstimate.actual = [PSCustomObject]@{
                analogGapPct = $analogGapPct
                errorPct = $analogErrorPct
                absErrorPct = [math]::Round([math]::Abs($analogErrorPct), 2)
                directionHit = ([math]::Sign($analogGapPct) -eq [math]::Sign($actualGapPct))
                resolvedAt = $resolvedAt
            }
        }
        $backfilled++
    }

    if ($null -ne $NewEntry) {
        $existingActual = if ($byDate.ContainsKey($NewEntry.date)) { $byDate[$NewEntry.date].actual } else { $null }
        $NewEntry.actual = $existingActual
        $byDate[$NewEntry.date] = $NewEntry
    }

    $merged = @($byDate.Values | Sort-Object date)
    $merged | ConvertTo-Json -Depth 6 -Compress | Out-File -FilePath $PredictionHistoryPath -Encoding utf8
    $newNote = if ($NewEntry) { "，新增今日1筆" } else { "" }
    Write-Host "已更新開盤價預測準確度歷史紀錄: $PredictionHistoryPath（累計 $($merged.Count) 筆，本次回填 $backfilled 筆$newNote）"
    return $merged
}

# 把歷史紀錄彙總成前端要顯示的統計摘要：近30/近90個交易日、累計至今三個區間，各自算
# 方向命中率/平均誤差(偏誤方向)/平均絕對誤差/68%與95%信賴區間覆蓋率。樣本數低於
# MinAccuracySamples的區間回傳$null，前端對應區塊要隱藏，避免樣本太少時的統計沒有代表性。
function Get-PredictionAccuracySummary($History) {
    $resolved = @($History | Where-Object { $null -ne $_.actual } | Sort-Object date)
    if ($resolved.Count -eq 0) { return $null }

    $lookbacks = @(
        @{ key = "last30"; label = "近30個交易日"; tradingDays = 30 },
        @{ key = "last90"; label = "近90個交易日"; tradingDays = 90 },
        @{ key = "sinceInception"; label = "累計至今"; tradingDays = [double]::PositiveInfinity }
    )

    $windows = [ordered]@{}
    foreach ($w in $lookbacks) {
        $slice = if ([double]::IsPositiveInfinity($w.tradingDays)) {
            $resolved
        } else {
            $n = [math]::Min([int]$w.tradingDays, $resolved.Count)
            @($resolved[($resolved.Count - $n)..($resolved.Count - 1)])
        }
        if ($slice.Count -lt $MinAccuracySamples) { $windows[$w.key] = $null; continue }

        # 「ADR歷史相近價位類比估計」是獨立於OLS模型之外的另一種估計法，同一區間內只有
        # 部分紀錄有這項資料(種子樣本沒有、抓取失敗的日子也可能沒有)，樣本數不足時analog
        # 欄位整個回傳$null，不勉強算一個代表性不足的統計數字，也不影響模型本身的統計。
        $analogResolved = @($slice | Where-Object { $_.analogEstimate -and $_.analogEstimate.actual })
        $analog = if ($analogResolved.Count -lt $MinAccuracySamples) { $null } else {
            [PSCustomObject]@{
                sampleSize = $analogResolved.Count
                directionHitRatePct = [math]::Round((Get-Mean ($analogResolved | ForEach-Object { if ($_.analogEstimate.actual.directionHit) { 100.0 } else { 0.0 } })), 1)
                meanErrorPct = [math]::Round((Get-Mean ($analogResolved | ForEach-Object { $_.analogEstimate.actual.errorPct })), 2)
                meanAbsErrorPct = [math]::Round((Get-Mean ($analogResolved | ForEach-Object { $_.analogEstimate.actual.absErrorPct })), 2)
            }
        }

        $windows[$w.key] = [PSCustomObject]@{
            label = $w.label
            sampleSize = $slice.Count
            directionHitRatePct = [math]::Round((Get-Mean ($slice | ForEach-Object { if ($_.actual.directionHit) { 100.0 } else { 0.0 } })), 1)
            meanErrorPct = [math]::Round((Get-Mean ($slice | ForEach-Object { $_.actual.errorPct })), 2)
            meanAbsErrorPct = [math]::Round((Get-Mean ($slice | ForEach-Object { $_.actual.absErrorPct })), 2)
            ci68CoveragePct = [math]::Round((Get-Mean ($slice | ForEach-Object { if ($_.actual.withinCi68) { 100.0 } else { 0.0 } })), 1)
            ci95CoveragePct = [math]::Round((Get-Mean ($slice | ForEach-Object { if ($_.actual.withinCi95) { 100.0 } else { 0.0 } })), 1)
            analog = $analog
        }
    }

    $anyVisible = $false
    foreach ($k in $windows.Keys) { if ($null -ne $windows[$k]) { $anyVisible = $true } }
    if (-not $anyVisible) { return $null }

    # 走勢圖改用實際價位(元)而不是缺口%——「盤前股價預測」「ADR歷史相近價位類比估計」都已經
    # 有現成的價格欄位(predictedOpen/analogEstimate.avgTwOpen)，「收盤價」也已經存在
    # actual.close，直接三條線都用價位表示，比缺口%更直觀。缺口%欄位還是保留供tooltip參考。
    $seriesCount = [math]::Min($AccuracyRecentSeriesLimit, $resolved.Count)
    $recentSeries = @($resolved[($resolved.Count - $seriesCount)..($resolved.Count - 1)] | ForEach-Object {
        $analogGapPct = if ($_.analogEstimate -and $_.analogEstimate.actual) { $_.analogEstimate.actual.analogGapPct } else { $null }
        $analogPrice = if ($_.analogEstimate) { if ($null -ne $_.analogEstimate.avgTwOpenAdjusted) { $_.analogEstimate.avgTwOpenAdjusted } else { $_.analogEstimate.avgTwOpen } } else { $null }
        [PSCustomObject]@{
            date = $_.date
            predictedPrice = $_.predictedOpen
            predictedGapPct = $_.predictedGapPct
            analogPrice = $analogPrice
            analogGapPct = $analogGapPct
            actualPrice = $_.actual.close
            actualGapPct = $_.actual.actualGapPct
            directionHit = $_.actual.directionHit
            seeded = ($_.seeded -eq $true)
        }
    })

    return [PSCustomObject]@{ resolvedSampleSize = $resolved.Count; windows = $windows; recentSeries = $recentSeries }
}

# 用近6個月 ADR(TSM)/USD-TWD/台股日K，訓練「ADR單日漲跌% → 台股隔日開盤缺口%」OLS迴歸。
function Get-OpenGapModel($adrSeries, $fxSeries, $twDaily) {
    $adrMap = @{}; foreach ($s in $adrSeries) { $adrMap[$s.date] = $s.close }
    $adrDates = @($adrSeries | ForEach-Object { $_.date })
    $fxMap = @{}; foreach ($s in $fxSeries) { $fxMap[$s.date] = $s.close }
    $fxDates = @($fxSeries | ForEach-Object { $_.date } | Sort-Object)

    $pairsByTwDate = @{}
    for ($i = 1; $i -lt $adrDates.Count; $i++) {
        $D = $adrDates[$i]; $Dprev = $adrDates[$i - 1]
        $adrClose = $adrMap[$D]; $adrClosePrev = $adrMap[$Dprev]
        $adrChangePct = ($adrClose / $adrClosePrev - 1) * 100

        $fx = Find-NearestOnOrBefore $fxMap $fxDates $D
        if ($null -eq $fx) { continue }

        $tIdx = -1
        for ($j = 0; $j -lt $twDaily.Count; $j++) {
            if ($twDaily[$j].date -gt $D) { $tIdx = $j; break }
        }
        if ($tIdx -le 0) { continue }
        $T = $twDaily[$tIdx]; $Tprev = $twDaily[$tIdx - 1]
        $twOpenGapPct = ($T.open / $Tprev.close - 1) * 100

        # 同一台股交易日可能對應多個ADR日期，只留每個台股交易日最後一筆
        $pairsByTwDate[$T.date] = [PSCustomObject]@{ adrDate = $D; adrClose = $adrClose; adrChangePct = $adrChangePct; twOpenGapPct = $twOpenGapPct; prevClose = $Tprev.close; actualOpen = $T.open; actualClose = $T.close }
    }

    $uniq = @($pairsByTwDate.Values)
    if ($uniq.Count -lt $MinRegressionSamples) { return $null }

    $xs = @($uniq | ForEach-Object { $_.adrChangePct })
    $ys = @($uniq | ForEach-Object { $_.twOpenGapPct })
    $reg = Get-OlsRegression $xs $ys
    $residuals = @($uniq | ForEach-Object { $_.twOpenGapPct - ($reg.beta * $_.adrChangePct + $reg.alpha) })
    $residualStd = Get-StdDev $residuals
    $hitCount = @($uniq | Where-Object { [math]::Sign($_.adrChangePct) -eq [math]::Sign($_.twOpenGapPct) -and $_.adrChangePct -ne 0 }).Count
    $hitRate = $hitCount / $uniq.Count

    # pairs依twDate排序後回傳，供「開盤價預測準確度追蹤」的種子回溯邏輯取「最近幾筆」用。
    $pairsSorted = @($uniq | Sort-Object twDate)
    return [PSCustomObject]@{ beta = $reg.beta; alpha = $reg.alpha; r = $reg.r; r2 = $reg.r2; n = $reg.n; residualStd = $residualStd; hitRate = $hitRate; pairs = $pairsSorted }
}

# 雙變數版本：「ADR單日漲跌% + ADR溢價率偏離近期均值」→ 台股隔日開盤缺口%。配對邏輯
# (ADR日期D找之後第一個台股交易日T)跟Get-OpenGapModel()完全一致，只是多帶一個「溢價
# 偏離」特徵：用T的前一個台股交易日Tprev在PremiumHistory裡的溢價率，相對Tprev當時往前
# RollWindowDays天的移動平均，算出偏離值。用Tprev(T的前一天)而不是T自己的溢價率，是
# 因為T自己的溢價率要等T收盤才算得出來，用它"預測"T的開盤缺口會有look-ahead bias；
# Tprev收盤時的溢價率在T開盤前就已經是確定的已知資訊，這樣配對才站得住腳。
function Get-OpenGapModelV2($adrSeries, $fxSeries, $twDaily, $PremiumHistory, [int]$RollWindowDays) {
    $adrMap = @{}; foreach ($s in $adrSeries) { $adrMap[$s.date] = $s.close }
    $adrDates = @($adrSeries | ForEach-Object { $_.date })
    $fxMap = @{}; foreach ($s in $fxSeries) { $fxMap[$s.date] = $s.close }
    $fxDates = @($fxSeries | ForEach-Object { $_.date } | Sort-Object)

    $premiumSorted = @($PremiumHistory | Sort-Object date)
    $premiumByDate = @{}; foreach ($h in $premiumSorted) { $premiumByDate[$h.date] = $h.premiumPct }
    $premiumIndexByDate = @{}
    for ($i = 0; $i -lt $premiumSorted.Count; $i++) { $premiumIndexByDate[$premiumSorted[$i].date] = $i }

    $pairsByTwDate = @{}
    for ($i = 1; $i -lt $adrDates.Count; $i++) {
        $D = $adrDates[$i]; $Dprev = $adrDates[$i - 1]
        $adrClose = $adrMap[$D]; $adrClosePrev = $adrMap[$Dprev]
        $adrChangePct = ($adrClose / $adrClosePrev - 1) * 100

        $fx = Find-NearestOnOrBefore $fxMap $fxDates $D
        if ($null -eq $fx) { continue }

        $tIdx = -1
        for ($j = 0; $j -lt $twDaily.Count; $j++) {
            if ($twDaily[$j].date -gt $D) { $tIdx = $j; break }
        }
        if ($tIdx -le 0) { continue }
        $T = $twDaily[$tIdx]; $Tprev = $twDaily[$tIdx - 1]
        $twOpenGapPct = ($T.open / $Tprev.close - 1) * 100

        if (-not $premiumIndexByDate.ContainsKey($Tprev.date)) { continue }
        $pIdx = $premiumIndexByDate[$Tprev.date]
        $windowStart = [math]::Max(0, $pIdx - $RollWindowDays + 1)
        $window = @($premiumSorted[$windowStart..$pIdx] | ForEach-Object { $_.premiumPct })
        if ($window.Count -lt [math]::Min($RollWindowDays, 20)) { continue }
        $rollMean = Get-Mean $window
        $premiumDev = $premiumByDate[$Tprev.date] - $rollMean

        $pairsByTwDate[$T.date] = [PSCustomObject]@{ adrDate = $D; adrClose = $adrClose; adrChangePct = $adrChangePct; premiumDev = $premiumDev; twOpenGapPct = $twOpenGapPct; prevClose = $Tprev.close; actualOpen = $T.open; actualClose = $T.close }
    }

    $uniq = @($pairsByTwDate.Values)
    if ($uniq.Count -lt $MinRegressionSamplesV2) { return $null }

    $xs1 = @($uniq | ForEach-Object { $_.adrChangePct })
    $xs2 = @($uniq | ForEach-Object { $_.premiumDev })
    $ys = @($uniq | ForEach-Object { $_.twOpenGapPct })
    $reg = Get-OlsRegression2 $xs1 $xs2 $ys
    $residuals = @($uniq | ForEach-Object { $_.twOpenGapPct - ($reg.b0 + $reg.b1 * $_.adrChangePct + $reg.b2 * $_.premiumDev) })
    $residualStd = Get-StdDev $residuals
    $hitCount = @($uniq | Where-Object { [math]::Sign($_.adrChangePct) -eq [math]::Sign($_.twOpenGapPct) -and $_.adrChangePct -ne 0 }).Count
    $hitRate = $hitCount / $uniq.Count

    $pairsSorted = @($uniq | Sort-Object twDate)
    return [PSCustomObject]@{
        b0 = $reg.b0; b1 = $reg.b1; b2 = $reg.b2; r2 = $reg.r2; adjR2 = $reg.adjR2; n = $reg.n
        tB1 = $reg.tB1; tB2 = $reg.tB2; pB1 = $reg.pB1; pB2 = $reg.pB2
        residualStd = $residualStd; hitRate = $hitRate; pairs = $pairsSorted
    }
}

$AnalogToleranceTiers = @(1.5, 2.5, 4, 6)
$AnalogMinMatches = 3

# 歷史相近ADR價位類比法：今天ADR收盤價為X，在近6個月歷史中找ADR收盤價與X相差在容忍度內的
# 交易日，取當時的匯率換算台股價、以及對應台股交易日的開盤價，最後取這些開盤價的平均值，
# 當作「開盤價機率預估」(OLS迴歸)之外的另一種類比估計。容忍度由窄到寬逐級嘗試，確保至少
# 抓到 AnalogMinMatches 筆比對，避免股價創新高/新低時完全找不到歷史相近值。
function Get-AnalogMatchesAtTolerance($todayAdrPrice, $adrSeries, $fxSeries, $twDaily, [double]$TolerancePct) {
    $adrDates = @($adrSeries | ForEach-Object { $_.date } | Sort-Object)
    $adrMap = @{}; foreach ($s in $adrSeries) { $adrMap[$s.date] = $s.close }
    $fxMap = @{}; foreach ($s in $fxSeries) { $fxMap[$s.date] = $s.close }
    $fxDates = @($fxSeries | ForEach-Object { $_.date } | Sort-Object)
    $todayDate = $adrDates[$adrDates.Count - 1]

    $matchesByTwDate = @{}
    foreach ($D in $adrDates) {
        if ($D -eq $todayDate) { continue }
        $adrClose = $adrMap[$D]
        $diffPct = ($adrClose / $todayAdrPrice - 1) * 100
        if ([math]::Abs($diffPct) -gt $TolerancePct) { continue }

        $fx = Find-NearestOnOrBefore $fxMap $fxDates $D
        if ($null -eq $fx) { continue }

        $tIdx = -1
        for ($j = 0; $j -lt $twDaily.Count; $j++) {
            if ($twDaily[$j].date -gt $D) { $tIdx = $j; break }
        }
        if ($tIdx -lt 0) { continue }
        $T = $twDaily[$tIdx]

        # 同一台股交易日可能對應多個ADR日期，只留每個台股交易日最後一筆
        $matchesByTwDate[$T.date] = [PSCustomObject]@{
            adrDate = $D; adrPrice = [math]::Round($adrClose, 2); diffPct = [math]::Round($diffPct, 2)
            fxRate = [math]::Round($fx, 3); impliedTwd = [math]::Round(($adrClose / 5) * $fx, 2)
            twDate = $T.date; twOpen = $T.open
        }
    }
    return @($matchesByTwDate.Values | Sort-Object twDate)
}

function Get-AnalogMatches($todayAdrPrice, $adrSeries, $fxSeries, $twDaily) {
    $best = @(); $usedTolerance = $AnalogToleranceTiers[$AnalogToleranceTiers.Count - 1]
    foreach ($tolerancePct in $AnalogToleranceTiers) {
        $uniq = Get-AnalogMatchesAtTolerance $todayAdrPrice $adrSeries $fxSeries $twDaily $tolerancePct
        $best = $uniq; $usedTolerance = $tolerancePct
        if ($uniq.Count -ge $AnalogMinMatches) { break }
    }
    if ($best.Count -eq 0) { return $null }
    $avgTwOpen = [math]::Round((Get-Mean ($best | ForEach-Object { $_.twOpen })), 2)
    return [PSCustomObject]@{ tolerancePct = $usedTolerance; todayAdrPrice = [math]::Round($todayAdrPrice, 2); matches = $best; avgTwOpen = $avgTwOpen; count = $best.Count }
}

# 把類比比對到的每一筆歷史開盤價，先用「當時的匯率」換算回等值ADR美元，再用「目標匯率」換回
# 台幣後取平均——排除掉匯率波動本身的干擾，只反映ADR股價位階的類比，跟avgTwOpen(原始歷史
# 開盤價直接平均、不管匯率)是不同版本。卡片上顯示給使用者看的數字用的就是這個調整後版本，
# 所以準確度追蹤/近30日走勢圖也要統一用這個版本，才會跟卡片實際看到的數字完全一致。
function Get-AdjustedAvgTwOpen($Matches, $TargetFxUsdTwd) {
    if (-not $Matches -or $Matches.Count -eq 0 -or $null -eq $TargetFxUsdTwd) { return $null }
    $adjusted = @($Matches | ForEach-Object { ($_.twOpen / $_.fxRate) * $TargetFxUsdTwd })
    return [math]::Round((Get-Mean $adjusted), 2)
}

# 三變數版本：「ADR單日漲跌% + ADR溢價率偏離近期均值 + ADR歷史相近價位類比估計缺口%」
# → 台股隔日開盤缺口%。前兩個變數的配對邏輯跟Get-OpenGapModelV2完全一致；第三個變數
# 直接重用Get-AnalogMatches——正式上線時這個函式也是拿同一套邏輯算「今天」的類比估計，
# 這裡只是把它套用在每一個歷史配對(D, T)上，差別只在於：傳進去的AdrSeries/FxSeries要
# 裁到只剩「D當時或更早」的資料，TwDaily要裁到只剩「早於T」的資料，確保每個歷史訓練
# 樣本都只用到「當時已經知道」的資訊，不會用T自己的開盤價回頭去比對自己(look-ahead bias)。
function Get-OpenGapModelV3($adrSeries, $fxSeries, $twDaily, $PremiumHistory, [int]$RollWindowDays) {
    $adrMap = @{}; foreach ($s in $adrSeries) { $adrMap[$s.date] = $s.close }
    $adrDates = @($adrSeries | ForEach-Object { $_.date })
    $fxMap = @{}; foreach ($s in $fxSeries) { $fxMap[$s.date] = $s.close }
    $fxDates = @($fxSeries | ForEach-Object { $_.date } | Sort-Object)

    $premiumSorted = @($PremiumHistory | Sort-Object date)
    $premiumByDate = @{}; foreach ($h in $premiumSorted) { $premiumByDate[$h.date] = $h.premiumPct }
    $premiumIndexByDate = @{}
    for ($i = 0; $i -lt $premiumSorted.Count; $i++) { $premiumIndexByDate[$premiumSorted[$i].date] = $i }

    $pairsByTwDate = @{}
    for ($i = 1; $i -lt $adrDates.Count; $i++) {
        $D = $adrDates[$i]; $Dprev = $adrDates[$i - 1]
        $adrClose = $adrMap[$D]; $adrClosePrev = $adrMap[$Dprev]
        $adrChangePct = ($adrClose / $adrClosePrev - 1) * 100

        $fx = Find-NearestOnOrBefore $fxMap $fxDates $D
        if ($null -eq $fx) { continue }

        $tIdx = -1
        for ($j = 0; $j -lt $twDaily.Count; $j++) {
            if ($twDaily[$j].date -gt $D) { $tIdx = $j; break }
        }
        if ($tIdx -le 0) { continue }
        $T = $twDaily[$tIdx]; $Tprev = $twDaily[$tIdx - 1]
        $twOpenGapPct = ($T.open / $Tprev.close - 1) * 100

        if (-not $premiumIndexByDate.ContainsKey($Tprev.date)) { continue }
        $pIdx = $premiumIndexByDate[$Tprev.date]
        $windowStart = [math]::Max(0, $pIdx - $RollWindowDays + 1)
        $window = @($premiumSorted[$windowStart..$pIdx] | ForEach-Object { $_.premiumPct })
        if ($window.Count -lt [math]::Min($RollWindowDays, 20)) { continue }
        $rollMean = Get-Mean $window
        $premiumDev = $premiumByDate[$Tprev.date] - $rollMean

        $adrTrunc = @($adrSeries | Where-Object { $_.date -le $D })
        $fxTrunc = @($fxSeries | Where-Object { $_.date -le $D })
        $twTrunc = @($twDaily | Where-Object { $_.date -lt $T.date })
        $analog = Get-AnalogMatches $adrClose $adrTrunc $fxTrunc $twTrunc
        if ($null -eq $analog) { continue }
        $analogGapPct = ($analog.avgTwOpen / $Tprev.close - 1) * 100

        $pairsByTwDate[$T.date] = [PSCustomObject]@{ adrDate = $D; adrClose = $adrClose; adrChangePct = $adrChangePct; premiumDev = $premiumDev; analogGapPct = $analogGapPct; twOpenGapPct = $twOpenGapPct; prevClose = $Tprev.close; actualOpen = $T.open; actualClose = $T.close }
    }

    $uniq = @($pairsByTwDate.Values)
    if ($uniq.Count -lt $MinRegressionSamplesV3) { return $null }

    $X = @($uniq | ForEach-Object { , @(1.0, $_.adrChangePct, $_.premiumDev, $_.analogGapPct) })
    $y = @($uniq | ForEach-Object { $_.twOpenGapPct })
    $reg = Get-OlsRegressionN $X $y
    $residuals = @($uniq | ForEach-Object { $_.twOpenGapPct - ($reg.beta[0] + $reg.beta[1] * $_.adrChangePct + $reg.beta[2] * $_.premiumDev + $reg.beta[3] * $_.analogGapPct) })
    $residualStd = Get-StdDev $residuals
    $hitCount = @($uniq | Where-Object { [math]::Sign($_.adrChangePct) -eq [math]::Sign($_.twOpenGapPct) -and $_.adrChangePct -ne 0 }).Count
    $hitRate = $hitCount / $uniq.Count

    $pairsSorted = @($uniq | Sort-Object twDate)
    return [PSCustomObject]@{
        beta = $reg.beta; se = $reg.se; t = $reg.t; p = $reg.p; r2 = $reg.r2; adjR2 = $reg.adjR2; n = $reg.n
        residualStd = $residualStd; hitRate = $hitRate; pairs = $pairsSorted
    }
}

$sources = @("stockanalysis.com", "finance.yahoo.com")
$fxSource = "tw.stock.yahoo.com USDTWD=X"

# 近1年 ADR/匯率歷史序列：無論今天的ADR/匯率是手動交叉比對還是自動抓取，都需要這份
# 歷史資料來訓練「ADR vs 台股開盤缺口」迴歸模型，所以固定抓取。套牢價、ADR歷史相近
# 價位類比估計這兩個既有功能仍然只看近6個月，稍後會從這份1年資料篩出6個月子集給它們
# 用，行為/文案完全不變。
$adrDaily = $null; $fxDaily = $null
try {
    $adrDaily = Get-YahooDaily "TSM"
    $fxDaily = Get-YahooDaily "TWD=X"
} catch {
    Write-Warning "抓取 ADR/匯率近1年歷史序列失敗，將略過開盤價機率預估: $($_.Exception.Message)"
}

if (-not $AdrPrice -or -not $AdrQuoteTime -or -not $UsdTwd -or -not $FxQuoteTime) {
    if ($null -eq $adrDaily -or $null -eq $fxDaily) {
        throw "缺少必要參數且自動抓取失敗：-AdrPrice -AdrChangePct -AdrQuoteTime -UsdTwd -FxQuoteTime"
    }
    Write-Host "未提供 -AdrPrice/-UsdTwd 等參數，改用 Yahoo Finance 自動抓取 ADR(TSM) 與 USD/TWD..."
    $AdrPrice = $adrDaily.price
    $AdrChangePct = $adrDaily.changePct
    $AdrQuoteTime = $adrDaily.quoteTime
    $UsdTwd = $fxDaily.price
    $FxQuoteTime = $fxDaily.quoteTime
    $sources = @("query1.finance.yahoo.com (TSM)")
    $fxSource = "query1.finance.yahoo.com (TWD=X)"
}

$path = Join-Path $PSScriptRoot "..\data\data.json"
$d = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json

$d.adr = [PSCustomObject]@{
    price     = $AdrPrice
    changePct = $AdrChangePct
    quoteTime = $AdrQuoteTime
    sources   = $sources
    ratio     = $AdrRatio
}
$d.fxRate = [PSCustomObject]@{
    usdTwd    = $UsdTwd
    quoteTime = $FxQuoteTime
    source    = $fxSource
}

# 從近1年的ADR/匯率序列篩出近6個月子集，維持「套牢價」「ADR歷史相近價位類比估計」
# 這兩個既有功能原本的6個月語意不變。
$adrDaily6mo = $null; $fxDaily6mo = $null
if ($adrDaily) { $adrDaily6mo = [PSCustomObject]@{ price = $adrDaily.price; changePct = $adrDaily.changePct; quoteTime = $adrDaily.quoteTime; series = (Get-RecentMonthsSeries $adrDaily.series 6) } }
if ($fxDaily) { $fxDaily6mo = [PSCustomObject]@{ price = $fxDaily.price; changePct = $fxDaily.changePct; quoteTime = $fxDaily.quoteTime; series = (Get-RecentMonthsSeries $fxDaily.series 6) } }

# ADR近6個月最高收盤價(美元)。
if ($adrDaily6mo) {
    $adrSixMonthHighUsd = [math]::Round(($adrDaily6mo.series | Measure-Object -Property close -Maximum).Maximum, 2)
    $d | Add-Member -NotePropertyName adrSixMonthHighUsd -NotePropertyValue $adrSixMonthHighUsd -Force
}

# 近1年台股日K（只取date/open/close，供開盤價機率預估雙變數模型訓練用；跟data.json的
# daily欄位——那份固定近6個月、給K線圖/估值分區顯示用——是完全獨立的兩份資料，互不影響）。
$twDaily1y = @()
try {
    $twDaily1y = Get-TwseDailyRange $RegressionWindowMonths
} catch {
    Write-Warning "抓取近1年台股日K(供開盤價機率預估用)失敗: $($_.Exception.Message)"
}

$premiumHistory = Update-AdrPremiumHistory $twDaily1y $adrDaily $fxDaily $AdrRatio

$impliedTwd = [math]::Round(($AdrPrice / $AdrRatio) * $UsdTwd, 2)
$premiumPct = [math]::Round((($impliedTwd - $d.valuation.closePrice) / $d.valuation.closePrice) * 100, 2)

# ---- 估值分區框架 ----
# 便宜價：PE < 20，或 (價格貼近/跌破布林下軌 且 PE < 22)
# 甜甜價：PE 20~24，價格靠近MA60支撐，ADR溢價 < 8%
# 正常：  PE 24~28，價格在布林通道內
# 超貴價：PE > 28，或 RSI > 75，或 ADR溢價 > 12%，或創6個月新高後短線急漲
# 同一套門檻邏輯分別套用在 trailing PE（反推TTM EPS）與 forward PE（使用者/法人預估全年EPS）
function Get-ZoneClassification($pe, $rsi, $premiumPct, $atSixMonthHigh, $nearBbLower, $nearMa60, $peLabel) {
    $reasons = @()
    if ($pe -gt 28) { $reasons += "$peLabel $pe 倍 > 28倍上緣" }
    if ($rsi -ne $null -and $rsi -gt 75) { $reasons += "RSI $([math]::Round($rsi,1)) 超買(>75)" }
    if ($premiumPct -gt 12) { $reasons += "ADR溢價 $premiumPct% > 12%" }
    if ($atSixMonthHigh -and $pe -gt 24) { $reasons += "股價貼近6個月高點且評價不便宜" }

    if ($reasons.Count -gt 0) {
        $zone = "超貴價"
    } elseif ($pe -lt 20 -or ($nearBbLower -and $pe -lt 22)) {
        $zone = "便宜價"
        $reasons += if ($pe -lt 20) { "$peLabel $pe 倍 < 20倍" } else { "價格貼近布林下軌且$peLabel<22" }
    } elseif ($pe -ge 20 -and $pe -le 24 -and $nearMa60 -and $premiumPct -lt 8) {
        $zone = "甜甜價"
        $reasons += "$peLabel 落在20~24倍，價格靠近MA60支撐，ADR溢價未過熱"
    } else {
        $zone = "正常"
        $reasons += "$peLabel $pe 倍落在24~28倍區間，未觸發便宜或超貴條件"
    }
    return [PSCustomObject]@{ zone = $zone; reasons = $reasons }
}

$pe = $d.valuation.peRatio
$rsi = $d.latestRsi
$lastInd = $d.indicators[-1]
$lastClose = $d.valuation.closePrice
$sixMonthHigh = ($d.daily | Measure-Object -Property close -Maximum).Maximum
$nearBbLower = ($lastInd.bbLower -ne $null) -and ($lastClose -le $lastInd.bbLower * 1.01)
$nearMa60 = ($lastInd.ma60 -ne $null) -and ([math]::Abs($lastClose - $lastInd.ma60) / $lastInd.ma60 -le 0.03)
$atSixMonthHigh = $lastClose -ge $sixMonthHigh * 0.99

$trailing = Get-ZoneClassification $pe $rsi $premiumPct $atSixMonthHigh $nearBbLower $nearMa60 "Trailing PE"
$zone = $trailing.zone
$reasons = $trailing.reasons

# 反推市場實際採用的TTM EPS基準（= 收盤價 / 本益比），用來換算各分區的價格門檻
$ttmEpsImplied = [math]::Round($lastClose / $pe, 4)
$zoneThresholds = [PSCustomObject]@{
    ttmEpsImplied = $ttmEpsImplied
    cheapMax      = [math]::Round(20 * $ttmEpsImplied, 1)   # 便宜價上限 (PE=20)
    sweetMax      = [math]::Round(24 * $ttmEpsImplied, 1)   # 甜甜價上限 (PE=24)
    normalMax     = [math]::Round(28 * $ttmEpsImplied, 1)   # 正常上限 (PE=28)，之上為超貴價
}

$d | Add-Member -NotePropertyName adrImpliedTwd -NotePropertyValue $impliedTwd -Force
$d | Add-Member -NotePropertyName adrPremiumPct -NotePropertyValue $premiumPct -Force
$d | Add-Member -NotePropertyName valuationZone -NotePropertyValue $zone -Force
$d | Add-Member -NotePropertyName valuationReasons -NotePropertyValue $reasons -Force
$d | Add-Member -NotePropertyName zoneThresholds -NotePropertyValue $zoneThresholds -Force
$d | Add-Member -NotePropertyName technicalFlags -NotePropertyValue ([PSCustomObject]@{
    rsi14 = $rsi; premiumPct = $premiumPct; atSixMonthHigh = $atSixMonthHigh; nearBbLower = $nearBbLower; nearMa60 = $nearMa60
}) -Force

# ---- 官方全年預估EPS（來自 config.json，可請Claude更新） ----
$configPath = Join-Path $PSScriptRoot "..\data\config.json"
if (Test-Path $configPath) {
    $cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $epsFullYear = $cfg.forecastEpsFullYear

    # H1實際EPS = TWSE官方Q1 + config補充的Q2(法說會數字，尚未正式入TWSE財報)
    $h1Actual = 0.0
    if ($d.epsInfo.season -eq "1") { $h1Actual += [double]$d.epsInfo.eps }
    foreach ($q in $cfg.supplementalQuarterlyEps) {
        if ($q.season -eq 2) { $h1Actual += [double]$q.eps }
    }
    $impliedH2 = [math]::Round($epsFullYear - $h1Actual, 2)
    $impliedFullYearGrowth = [math]::Round(($epsFullYear / $cfg.priorYearFullEps - 1) * 100, 1)
    $impliedH2Growth = [math]::Round(($impliedH2 / $cfg.priorYearH2Eps - 1) * 100, 1)
    $h1ActualGrowth = [math]::Round(($h1Actual / $cfg.priorYearH1Eps - 1) * 100, 1)

    $forwardPE = [math]::Round($lastClose / $epsFullYear, 2)
    $peg = if ($impliedFullYearGrowth -gt 0) { [math]::Round($forwardPE / $impliedFullYearGrowth, 2) } else { $null }

    $forward = Get-ZoneClassification $forwardPE $rsi $premiumPct $atSixMonthHigh $nearBbLower $nearMa60 "Forward PE"
    $forwardThresholds = [PSCustomObject]@{
        cheapMax  = [math]::Round(20 * $epsFullYear, 1)
        sweetMax  = [math]::Round(24 * $epsFullYear, 1)
        normalMax = [math]::Round(28 * $epsFullYear, 1)
    }

    # 合理性檢查：隱含H2成長率若與H1實際成長率落差過大（>25個百分點），標記警示
    $growthGapWarning = $null
    if ([math]::Abs($impliedH2Growth - $h1ActualGrowth) -gt 25) {
        $growthGapWarning = "您輸入的全年預估EPS $epsFullYear 元，隱含下半年年增率 $impliedH2Growth%，與上半年實際年增率 $h1ActualGrowth% 落差達 $([math]::Round([math]::Abs($impliedH2Growth-$h1ActualGrowth),1)) 個百分點，請確認此預估是否合理"
    }

    $officialForecast = [PSCustomObject]@{
        epsFullYear          = $epsFullYear
        forecastSource       = $cfg.forecastSource
        priorYearFullEps     = $cfg.priorYearFullEps
        priorYearH1Eps       = $cfg.priorYearH1Eps
        priorYearH2Eps       = $cfg.priorYearH2Eps
        h1ActualEps          = [math]::Round($h1Actual,2)
        impliedH2Eps         = $impliedH2
        impliedFullYearGrowthPct = $impliedFullYearGrowth
        h1ActualGrowthPct    = $h1ActualGrowth
        impliedH2GrowthPct   = $impliedH2Growth
        forwardPE            = $forwardPE
        peg                  = $peg
        zone                 = $forward.zone
        reasons              = $forward.reasons
        thresholds           = $forwardThresholds
        growthGapWarning     = $growthGapWarning
        updatedAt            = $cfg.updatedAt
    }
    $d | Add-Member -NotePropertyName officialForecast -NotePropertyValue $officialForecast -Force
}

# ---- 台股開盤價機率預估 ----
# 三層退回：優先用三變數模型(ADR漲跌% + 溢價偏離% + ADR歷史相近價位類比估計缺口%)；
# 樣本數不足(MinRegressionSamplesV3)或今天剛好找不到任何類比比對時，退回只帶溢價偏離的
# 雙變數模型；溢價歷史也不夠長的話再退回僅ADR漲跌%的單變數模型。不管哪一層都不讓卡片
# 直接消失——這些退回路徑理論上只有在資料還在累積的最初期間才會用到，1年回填後樣本數
# 已經足夠，正常情況下應該都會走三變數模型。
$openPrediction = $null
$predicted = $false
$predictionTier = $null
$predictionModel = $null
if ($adrDaily -and $fxDaily) {
    $twForModel = if ($twDaily1y.Count -gt 0) { $twDaily1y } else { $d.daily }

    try {
        $model3 = if ($twDaily1y.Count -gt 0) { Get-OpenGapModelV3 $adrDaily.series $fxDaily.series $twDaily1y $premiumHistory $PremiumRollWindowDays } else { $null }
        # 「今天」的類比估計缺口%要用跟訓練時同一套函式(Get-AnalogMatches)、同一份完整
        # 1年序列現算，這樣訓練特徵跟預測當下用的特徵才是同一種算法，不會兩邊邏輯不一致。
        $analogNow = if ($model3) { Get-AnalogMatches $AdrPrice $adrDaily.series $fxDaily.series $twDaily1y } else { $null }

        if ($model3 -and $analogNow) {
            $premiumSorted = @($premiumHistory | Sort-Object date)
            $latestPremium = $premiumSorted[-1]
            $rollStart = [math]::Max(0, $premiumSorted.Count - $PremiumRollWindowDays)
            $rollWindow = @($premiumSorted[$rollStart..($premiumSorted.Count - 1)] | ForEach-Object { $_.premiumPct })
            $premiumDevNow = $latestPremium.premiumPct - (Get-Mean $rollWindow)
            $base = $d.valuation.closePrice
            $analogGapNowPct = ($analogNow.avgTwOpen / $base - 1) * 100

            $b0 = $model3.beta[0]; $b1 = $model3.beta[1]; $b2 = $model3.beta[2]; $b3 = $model3.beta[3]
            $predictedGapPct = $b0 + $b1 * $AdrChangePct + $b2 * $premiumDevNow + $b3 * $analogGapNowPct
            $priceAt = { param($gapPct) [math]::Round($base * (1 + $gapPct / 100), 2) }
            $probUpPct = [math]::Round((Get-NormalCdf ($predictedGapPct / $model3.residualStd)) * 100, 1)
            $confidenceIndexPct = [math]::Round(([math]::Max(0, $model3.adjR2)) * 100, 1)

            $openPrediction = [PSCustomObject]@{
                predictedGapPct = [math]::Round($predictedGapPct, 2)
                predictedOpen   = (& $priceAt $predictedGapPct)
                ci68            = [PSCustomObject]@{ low = (& $priceAt ($predictedGapPct - $model3.residualStd)); high = (& $priceAt ($predictedGapPct + $model3.residualStd)) }
                ci95            = [PSCustomObject]@{ low = (& $priceAt ($predictedGapPct - 1.96 * $model3.residualStd)); high = (& $priceAt ($predictedGapPct + 1.96 * $model3.residualStd)) }
                probUpPct       = $probUpPct
                basisAdrChangePct = $AdrChangePct
                basisPremiumDevPct = [math]::Round($premiumDevNow, 2)
                basisAnalogGapPct = [math]::Round($analogGapNowPct, 2)
                basisPrevClose  = $base
                model           = [PSCustomObject]@{
                    method = "OLS三變數迴歸（開盤缺口% ~ ADR漲跌% + 溢價偏離% + ADR歷史相近價位類比估計缺口%）"
                    interceptB0 = [math]::Round($b0, 4); adrChangeCoefB1 = [math]::Round($b1, 4); premiumDevCoefB2 = [math]::Round($b2, 4); analogGapCoefB3 = [math]::Round($b3, 4)
                    r2 = [math]::Round($model3.r2, 4); adjR2 = [math]::Round($model3.adjR2, 4)
                    tAdrChange = [math]::Round($model3.t[1], 2); tPremiumDev = [math]::Round($model3.t[2], 2); tAnalogGap = [math]::Round($model3.t[3], 2)
                    pAdrChange = [math]::Round($model3.p[1], 4); pPremiumDev = [math]::Round($model3.p[2], 4); pAnalogGap = [math]::Round($model3.p[3], 4)
                    residualStd = [math]::Round($model3.residualStd, 4); hitRatePct = [math]::Round($model3.hitRate * 100, 1)
                    sampleSize = $model3.n; windowMonths = $RegressionWindowMonths; premiumRollWindowDays = $PremiumRollWindowDays
                    analogTolerancePct = $analogNow.tolerancePct
                    confidenceIndexPct = $confidenceIndexPct
                }
            }
            $d | Add-Member -NotePropertyName openPrediction -NotePropertyValue $openPrediction -Force
            $predicted = $true
            $predictionTier = 3
            $predictionModel = $model3
            Write-Host "開盤價機率預估(三變數): 缺口$($openPrediction.predictedGapPct)%  預估開盤價$($openPrediction.predictedOpen)  上漲機率$($probUpPct)%（調整後R²=$([math]::Round($model3.adjR2,3)), n=$($model3.n), 類比缺口t值=$([math]::Round($model3.t[3],2))）"
        }
    } catch {
        Write-Warning "三變數開盤價機率預估計算失敗，將嘗試雙變數版本: $($_.Exception.Message)"
    }

    if (-not $predicted) {
        try {
            $model2 = if ($twDaily1y.Count -gt 0) { Get-OpenGapModelV2 $adrDaily.series $fxDaily.series $twDaily1y $premiumHistory $PremiumRollWindowDays } else { $null }

            if ($model2) {
                $premiumSorted = @($premiumHistory | Sort-Object date)
                $latestPremium = $premiumSorted[-1]
                $rollStart = [math]::Max(0, $premiumSorted.Count - $PremiumRollWindowDays)
                $rollWindow = @($premiumSorted[$rollStart..($premiumSorted.Count - 1)] | ForEach-Object { $_.premiumPct })
                $premiumDevNow = $latestPremium.premiumPct - (Get-Mean $rollWindow)

                $predictedGapPct = $model2.b0 + $model2.b1 * $AdrChangePct + $model2.b2 * $premiumDevNow
                $base = $d.valuation.closePrice
                $priceAt = { param($gapPct) [math]::Round($base * (1 + $gapPct / 100), 2) }
                $probUpPct = [math]::Round((Get-NormalCdf ($predictedGapPct / $model2.residualStd)) * 100, 1)
                $confidenceIndexPct = [math]::Round(([math]::Max(0, $model2.adjR2)) * 100, 1)

                $openPrediction = [PSCustomObject]@{
                    predictedGapPct = [math]::Round($predictedGapPct, 2)
                    predictedOpen   = (& $priceAt $predictedGapPct)
                    ci68            = [PSCustomObject]@{ low = (& $priceAt ($predictedGapPct - $model2.residualStd)); high = (& $priceAt ($predictedGapPct + $model2.residualStd)) }
                    ci95            = [PSCustomObject]@{ low = (& $priceAt ($predictedGapPct - 1.96 * $model2.residualStd)); high = (& $priceAt ($predictedGapPct + 1.96 * $model2.residualStd)) }
                    probUpPct       = $probUpPct
                    basisAdrChangePct = $AdrChangePct
                    basisPremiumDevPct = [math]::Round($premiumDevNow, 2)
                    basisPrevClose  = $base
                    model           = [PSCustomObject]@{
                        method = "OLS雙變數迴歸（開盤缺口% ~ ADR漲跌% + 溢價偏離%，類比估計樣本數不足時的退回版本）"
                        interceptB0 = [math]::Round($model2.b0, 4); adrChangeCoefB1 = [math]::Round($model2.b1, 4); premiumDevCoefB2 = [math]::Round($model2.b2, 4)
                        r2 = [math]::Round($model2.r2, 4); adjR2 = [math]::Round($model2.adjR2, 4)
                        tAdrChange = [math]::Round($model2.tB1, 2); tPremiumDev = [math]::Round($model2.tB2, 2)
                        pAdrChange = [math]::Round($model2.pB1, 4); pPremiumDev = [math]::Round($model2.pB2, 4)
                        residualStd = [math]::Round($model2.residualStd, 4); hitRatePct = [math]::Round($model2.hitRate * 100, 1)
                        sampleSize = $model2.n; windowMonths = $RegressionWindowMonths; premiumRollWindowDays = $PremiumRollWindowDays
                        confidenceIndexPct = $confidenceIndexPct
                    }
                }
                $d | Add-Member -NotePropertyName openPrediction -NotePropertyValue $openPrediction -Force
                $predicted = $true
                $predictionTier = 2
                $predictionModel = $model2
                Write-Host "開盤價機率預估(雙變數退回): 缺口$($openPrediction.predictedGapPct)%  預估開盤價$($openPrediction.predictedOpen)  上漲機率$($probUpPct)%（調整後R²=$([math]::Round($model2.adjR2,3)), n=$($model2.n)）"
            }
        } catch {
            Write-Warning "雙變數開盤價機率預估計算失敗，將嘗試單變數版本: $($_.Exception.Message)"
        }
    }

    if (-not $predicted) {
        try {
            $model = Get-OpenGapModel $adrDaily.series $fxDaily.series $twForModel
            if ($model) {
                $predictedGapPct = $model.beta * $AdrChangePct + $model.alpha
                $base = $d.valuation.closePrice
                $priceAt = { param($gapPct) [math]::Round($base * (1 + $gapPct / 100), 2) }
                $probUpPct = [math]::Round((Get-NormalCdf ($predictedGapPct / $model.residualStd)) * 100, 1)

                $openPrediction = [PSCustomObject]@{
                    predictedGapPct = [math]::Round($predictedGapPct, 2)
                    predictedOpen   = (& $priceAt $predictedGapPct)
                    ci68            = [PSCustomObject]@{ low = (& $priceAt ($predictedGapPct - $model.residualStd)); high = (& $priceAt ($predictedGapPct + $model.residualStd)) }
                    ci95            = [PSCustomObject]@{ low = (& $priceAt ($predictedGapPct - 1.96 * $model.residualStd)); high = (& $priceAt ($predictedGapPct + 1.96 * $model.residualStd)) }
                    probUpPct       = $probUpPct
                    basisAdrChangePct = $AdrChangePct
                    basisPrevClose  = $base
                    model           = [PSCustomObject]@{
                        method = "OLS單變數迴歸（開盤缺口% ~ ADR漲跌%，溢價率/類比估計樣本數不足時的退回版本）"
                        beta = [math]::Round($model.beta, 4); alpha = [math]::Round($model.alpha, 4); r2 = [math]::Round($model.r2, 4)
                        residualStd = [math]::Round($model.residualStd, 4); hitRatePct = [math]::Round($model.hitRate * 100, 1)
                        sampleSize = $model.n; windowMonths = $RegressionWindowMonths
                    }
                }
                $d | Add-Member -NotePropertyName openPrediction -NotePropertyValue $openPrediction -Force
                $predicted = $true
                $predictionTier = 1
                $predictionModel = $model
                Write-Host "開盤價機率預估(單變數退回): 缺口$($openPrediction.predictedGapPct)%  預估開盤價$($openPrediction.predictedOpen)  上漲機率$($probUpPct)%（R²=$([math]::Round($model.r2,2)), n=$($model.n)）"
            }
        } catch {
            Write-Warning "開盤價機率預估計算失敗，略過: $($_.Exception.Message)"
        }
    }

    if (-not $predicted) {
        Write-Warning "三/雙/單變數模型可用樣本數皆不足，略過開盤價機率預估"
    }
}

# ---- ADR歷史相近價位類比估計 ----
# 這個區塊要放在「開盤價預測準確度追蹤」之前執行：準確度追蹤要把今天的$analog一併存進
# 歷史紀錄(供之後也追蹤類比估計本身的準不準)，必須先算出來才能用。
if ($adrDaily6mo -and $fxDaily6mo) {
    try {
        $analog = Get-AnalogMatches $AdrPrice $adrDaily6mo.series $fxDaily6mo.series $d.daily
        if ($analog) {
            $avgTwOpenAdjusted = Get-AdjustedAvgTwOpen $analog.matches $UsdTwd
            $analog | Add-Member -NotePropertyName avgTwOpenAdjusted -NotePropertyValue $avgTwOpenAdjusted -Force
            $d | Add-Member -NotePropertyName adrAnalogMatches -NotePropertyValue $analog -Force
            Write-Host "歷史相近ADR價位比對: $($analog.count)筆 (±$($analog.tolerancePct)%)  平均對應台股開盤價: $($analog.avgTwOpen)（匯率調整後: $($analog.avgTwOpenAdjusted)）"
        } else {
            Write-Warning "近6個月無相近ADR價位可比對，略過類比估計"
        }
    } catch {
        Write-Warning "歷史相近ADR價位比對計算失敗，略過: $($_.Exception.Message)"
    }
}

# ---- 開盤價預測準確度追蹤 ----
# 不論這次是否成功算出新預測，只要有抓到近1年台股日K，就先回填先前未解析的舊紀錄
# （所以特意放在if ($adrDaily -and $fxDaily)區塊外面，即使ADR/匯率當次抓取失敗，仍然
# 可以用這次的台股日K把之前累積的未解析紀錄回填掉，不用等到下次ADR恢復正常才回填）；
# 今天的新預測（若有算出來）另外併入同一次寫檔。資料庫還是空檔案時，先用最近幾筆訓練
# 配對種一批初始樣本，讓卡片一上線就有資料可看。同時把$analog(若有)一併存進紀錄，讓
# 「ADR歷史相近價位類比估計」這個既有功能本身的準確度也能被長期追蹤，不是只追蹤OLS模型。
if ($twDaily1y.Count -gt 0) {
    try {
        $history = @()
        if (Test-Path $PredictionHistoryPath) {
            try { $history = @(Get-Content $PredictionHistoryPath -Raw -Encoding UTF8 | ConvertFrom-Json) }
            catch { $history = @() }
        }
        $seeds = if ($predictionModel) { New-PredictionHistorySeeds $history $predictionModel.pairs $predictionTier $predictionModel $adrDaily.series $fxDaily.series $twDaily1y } else { @() }

        # 用DateTimeOffset::Parse明確解析ISO時間字串裡的時區資訊(而不是Get-Date隱含依賴
        # 系統當地文化/時區設定)，確保不論執行環境的系統時區為何，都能正確換算成UTC後
        # +8小時得到台北日期，行為跟.mjs版本(new Date(...).getTime() + 8*3600*1000)一致。
        $predictedDateStr = ([datetimeoffset]::Parse($d.generatedAt)).UtcDateTime.AddHours(8).ToString("yyyy-MM-dd")
        $newEntry = if ($predicted) { New-PredictionHistoryEntry $openPrediction $predictionTier $predictedDateStr $d.generatedAt $false $analog } else { $null }

        # 種子樣本直接寫進同一份歷史（在Update-PredictionAccuracyHistory做回填/upsert之前），
        # 這樣今天這次執行內，種子樣本也會一併被回填邏輯掃過（雖然種子樣本本來就已經有
        # actual了，掃過也不會被覆蓋，因為回填邏輯只處理actual為$null的項目）。種子樣本本身
        # 沒有對應的「當時6個月類比估計」可回溯，所以種子樣本的analogEstimate固定是$null，
        # 之後每天新增的才會有。
        if ($seeds.Count -gt 0) {
            $history = @($history) + @($seeds)
            $history | ConvertTo-Json -Depth 6 -Compress | Out-File -FilePath $PredictionHistoryPath -Encoding utf8
            Write-Host "開盤價預測準確度歷史紀錄為空，已用最近$($seeds.Count)筆訓練配對回溯種子樣本（標記seeded:true）"
        }

        $predictionHistory = Update-PredictionAccuracyHistory $twDaily1y $newEntry
        $summary = Get-PredictionAccuracySummary $predictionHistory
        if ($summary) { $d | Add-Member -NotePropertyName predictionAccuracySummary -NotePropertyValue $summary -Force }
    } catch {
        Write-Warning "開盤價預測準確度歷史紀錄更新失敗，略過: $($_.Exception.Message)"
    }
}

$d | ConvertTo-Json -Depth 8 -Compress | Out-File -FilePath $path -Encoding utf8
Write-Host "ADR換算價: $impliedTwd  溢價: $premiumPct%  Trailing分區: $zone"
Write-Host ($reasons -join "; ")
Write-Host "Trailing分區價格門檻: 便宜<$($zoneThresholds.cheapMax) 甜甜<$($zoneThresholds.sweetMax) 正常<$($zoneThresholds.normalMax) 超貴>=$($zoneThresholds.normalMax)"
if ($d.officialForecast) {
    Write-Host "Forward PE: $($d.officialForecast.forwardPE)  PEG: $($d.officialForecast.peg)  Forward分區: $($d.officialForecast.zone)"
}
