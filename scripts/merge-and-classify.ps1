<#
  合併 ADR / 匯率資料（由 Claude 透過 WebFetch 交叉比對兩來源後取得；若省略參數則自動
  改用 Yahoo Finance 單一來源抓取，供排程自動化使用）進 data.json，
  並依「估值分區框架」計算目前價格所屬區間：便宜價／甜甜價／正常／超貴價。
  同時用近1年 ADR/匯率/台股歷史資料訓練「ADR隔夜漲跌% + ADR溢價偏離%」雙變數OLS迴歸，
  套用在今天的ADR變動與溢價狀態上，機率性推估台股開盤價（含68%/95%信賴區間、上漲機率、
  模型信心指數＝調整後R²）。套牢價、ADR歷史相近價位類比估計這兩個既有功能仍只看近6個月。
  另外會把ADR溢價率逐日累積寫進 data\adr-premium-history.json（永久保留，不像
  data.json只留近6個月滾動視窗），是雙變數迴歸模型的訓練資料來源之一。

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
$PremiumRollWindowDays = 60
$PremiumHistoryPath = Join-Path $PSScriptRoot "..\data\adr-premium-history.json"

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
        $pairsByTwDate[$T.date] = [PSCustomObject]@{ adrChangePct = $adrChangePct; twOpenGapPct = $twOpenGapPct }
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

    return [PSCustomObject]@{ beta = $reg.beta; alpha = $reg.alpha; r = $reg.r; r2 = $reg.r2; n = $reg.n; residualStd = $residualStd; hitRate = $hitRate }
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

        $pairsByTwDate[$T.date] = [PSCustomObject]@{ adrChangePct = $adrChangePct; premiumDev = $premiumDev; twOpenGapPct = $twOpenGapPct }
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

    return [PSCustomObject]@{
        b0 = $reg.b0; b1 = $reg.b1; b2 = $reg.b2; r2 = $reg.r2; adjR2 = $reg.adjR2; n = $reg.n
        tB1 = $reg.tB1; tB2 = $reg.tB2; pB1 = $reg.pB1; pB2 = $reg.pB2
        residualStd = $residualStd; hitRate = $hitRate
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

# ---- 台股開盤價機率預估（依近1年「ADR漲跌% + ADR溢價偏離%」雙變數迴歸模型） ----
# 優先用雙變數模型；如果溢價歷史還不夠長(移動平均暖機期、樣本數不足MinRegressionSamplesV2)
# 就退回只用ADR漲跌%的單變數模型，不要整張卡片直接消失。這個退回路徑理論上只有在資料
# 還在累積的最初期間才會用到，這次1年回填後樣本數已經足夠，正常情況下應該都會走雙變數模型。
$openPrediction = $null
if ($adrDaily -and $fxDaily) {
    try {
        $twForModel = if ($twDaily1y.Count -gt 0) { $twDaily1y } else { $d.daily }
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
                    method = "OLS雙變數迴歸（開盤缺口% ~ ADR漲跌% + 溢價偏離%）"
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
            Write-Host "開盤價機率預估(雙變數): 缺口$($openPrediction.predictedGapPct)%  預估開盤價$($openPrediction.predictedOpen)  上漲機率$($probUpPct)%（調整後R²=$([math]::Round($model2.adjR2,3)), n=$($model2.n), 溢價偏離t值=$([math]::Round($model2.tB2,2))）"
        } else {
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
                        method = "OLS單變數迴歸（開盤缺口% ~ ADR漲跌%，溢價率樣本數不足時的退回版本）"
                        beta = [math]::Round($model.beta, 4); alpha = [math]::Round($model.alpha, 4); r2 = [math]::Round($model.r2, 4)
                        residualStd = [math]::Round($model.residualStd, 4); hitRatePct = [math]::Round($model.hitRate * 100, 1)
                        sampleSize = $model.n; windowMonths = $RegressionWindowMonths
                    }
                }
                $d | Add-Member -NotePropertyName openPrediction -NotePropertyValue $openPrediction -Force
                Write-Host "開盤價機率預估(單變數退回): 缺口$($openPrediction.predictedGapPct)%  預估開盤價$($openPrediction.predictedOpen)  上漲機率$($probUpPct)%（R²=$([math]::Round($model.r2,2)), n=$($model.n)）"
            } else {
                Write-Warning "雙變數與單變數模型可用樣本數都不足，略過開盤價機率預估"
            }
        }
    } catch {
        Write-Warning "開盤價機率預估計算失敗，略過: $($_.Exception.Message)"
    }
}

# ---- ADR歷史相近價位類比估計 ----
if ($adrDaily6mo -and $fxDaily6mo) {
    try {
        $analog = Get-AnalogMatches $AdrPrice $adrDaily6mo.series $fxDaily6mo.series $d.daily
        if ($analog) {
            $d | Add-Member -NotePropertyName adrAnalogMatches -NotePropertyValue $analog -Force
            Write-Host "歷史相近ADR價位比對: $($analog.count)筆 (±$($analog.tolerancePct)%)  平均對應台股開盤價: $($analog.avgTwOpen)"
        } else {
            Write-Warning "近6個月無相近ADR價位可比對，略過類比估計"
        }
    } catch {
        Write-Warning "歷史相近ADR價位比對計算失敗，略過: $($_.Exception.Message)"
    }
}

$d | ConvertTo-Json -Depth 8 -Compress | Out-File -FilePath $path -Encoding utf8
Write-Host "ADR換算價: $impliedTwd  溢價: $premiumPct%  Trailing分區: $zone"
Write-Host ($reasons -join "; ")
Write-Host "Trailing分區價格門檻: 便宜<$($zoneThresholds.cheapMax) 甜甜<$($zoneThresholds.sweetMax) 正常<$($zoneThresholds.normalMax) 超貴>=$($zoneThresholds.normalMax)"
if ($d.officialForecast) {
    Write-Host "Forward PE: $($d.officialForecast.forwardPE)  PEG: $($d.officialForecast.peg)  Forward分區: $($d.officialForecast.zone)"
}
