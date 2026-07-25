<#
  合併 ADR / 匯率資料（由 Claude 透過 WebFetch 交叉比對兩來源後取得；若省略參數則自動
  改用 Yahoo Finance 單一來源抓取，供排程自動化使用）進 data.json，
  並依「估值分區框架」計算目前價格所屬區間：便宜價／甜甜價／正常／超貴價。
  同時用近6個月 ADR/匯率/台股歷史資料訓練「ADR隔夜漲跌% → 台股開盤缺口%」OLS迴歸，
  套用在今天的ADR變動上，機率性推估台股開盤價（含68%/95%信賴區間、上漲機率）。

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
$RegressionWindowMonths = 6
$MinRegressionSamples = 20

# 抓取 Yahoo Finance 每日收盤序列。除了回傳最新報價(price/changePct/quoteTime)，也回傳
# 完整每日收盤序列(Series)，供「ADR vs 開盤缺口」迴歸訓練使用，避免重複發送請求。
function Get-YahooDaily([string]$Symbol, [string]$Range = "6mo") {
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
    # 不一定是「前一個交易日」，用它算漲跌%可能落差好幾天而算錯。改為直接從每日收盤價序列
    # 取倒數第二個有效值（= 真正的前一交易日收盤），確保漲跌%永遠是逐日比較。
    $closes = @($series | ForEach-Object { $_.close })
    if ($closes.Count -ge 2) {
        $prevClose = $closes[$closes.Count - 2]
    } else {
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

# 近6個月 ADR/匯率歷史序列：無論今天的ADR/匯率是手動交叉比對還是自動抓取，都需要這份
# 歷史資料來訓練「ADR vs 台股開盤缺口」迴歸模型，所以固定抓取。
$adrDaily = $null; $fxDaily = $null
try {
    $adrDaily = Get-YahooDaily "TSM"
    $fxDaily = Get-YahooDaily "TWD=X"
} catch {
    Write-Warning "抓取 ADR/匯率近6個月歷史序列失敗，將略過開盤價機率預估: $($_.Exception.Message)"
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

# ADR近6個月最高收盤價(美元)，取自本次一併抓取的ADR歷史序列(供開盤價迴歸訓練用)。
if ($adrDaily) {
    $adrSixMonthHighUsd = [math]::Round(($adrDaily.series | Measure-Object -Property close -Maximum).Maximum, 2)
    $d | Add-Member -NotePropertyName adrSixMonthHighUsd -NotePropertyValue $adrSixMonthHighUsd -Force
}

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

# ---- 台股開盤價機率預估（依近6個月「ADR漲跌% → 開盤缺口%」迴歸模型） ----
$openPrediction = $null
if ($adrDaily -and $fxDaily) {
    try {
        $model = Get-OpenGapModel $adrDaily.series $fxDaily.series $d.daily
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
                    beta = [math]::Round($model.beta, 4); alpha = [math]::Round($model.alpha, 4); r2 = [math]::Round($model.r2, 4)
                    residualStd = [math]::Round($model.residualStd, 4); hitRatePct = [math]::Round($model.hitRate * 100, 1)
                    sampleSize = $model.n; windowMonths = $RegressionWindowMonths
                }
            }
            $d | Add-Member -NotePropertyName openPrediction -NotePropertyValue $openPrediction -Force
            Write-Host "開盤價機率預估: 缺口$($openPrediction.predictedGapPct)%  預估開盤價$($openPrediction.predictedOpen)  上漲機率$($probUpPct)%（R²=$([math]::Round($model.r2,2)), n=$($model.n)）"
        } else {
            Write-Warning "可用配對樣本數不足(<$MinRegressionSamples)，略過開盤價機率預估"
        }
    } catch {
        Write-Warning "開盤價機率預估計算失敗，略過: $($_.Exception.Message)"
    }
}

# ---- ADR歷史相近價位類比估計 ----
if ($adrDaily -and $fxDaily) {
    try {
        $analog = Get-AnalogMatches $AdrPrice $adrDaily.series $fxDaily.series $d.daily
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
