<#
  合併 ADR / 匯率資料（由 Claude 透過 WebFetch 交叉比對兩來源後取得）進 data.json，
  並依「估值分區框架」計算目前價格所屬區間：便宜價／甜甜價／正常／超貴價。

  用法：
    .\merge-and-classify.ps1 -AdrPrice 424.61 -AdrChangePct 5.55 -AdrQuoteTime "2026-07-21T16:00:00-04:00" `
        -UsdTwd 32.325 -FxQuoteTime "2026-07-22T08:02:00+08:00"
#>
param(
    [Parameter(Mandatory=$true)][double]$AdrPrice,
    [Parameter(Mandatory=$true)][double]$AdrChangePct,
    [Parameter(Mandatory=$true)][string]$AdrQuoteTime,
    [Parameter(Mandatory=$true)][double]$UsdTwd,
    [Parameter(Mandatory=$true)][string]$FxQuoteTime,
    [double]$AdrRatio = 5
)

$ErrorActionPreference = "Stop"
$path = Join-Path $PSScriptRoot "..\data\data.json"
$d = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json

$d.adr = [PSCustomObject]@{
    price     = $AdrPrice
    changePct = $AdrChangePct
    quoteTime = $AdrQuoteTime
    sources   = @("stockanalysis.com", "finance.yahoo.com")
    ratio     = $AdrRatio
}
$d.fxRate = [PSCustomObject]@{
    usdTwd    = $UsdTwd
    quoteTime = $FxQuoteTime
    source    = "tw.stock.yahoo.com USDTWD=X"
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

$d | ConvertTo-Json -Depth 8 -Compress | Out-File -FilePath $path -Encoding utf8
Write-Host "ADR換算價: $impliedTwd  溢價: $premiumPct%  Trailing分區: $zone"
Write-Host ($reasons -join "; ")
Write-Host "Trailing分區價格門檻: 便宜<$($zoneThresholds.cheapMax) 甜甜<$($zoneThresholds.sweetMax) 正常<$($zoneThresholds.normalMax) 超貴>=$($zoneThresholds.normalMax)"
if ($d.officialForecast) {
    Write-Host "Forward PE: $($d.officialForecast.forwardPE)  PEG: $($d.officialForecast.peg)  Forward分區: $($d.officialForecast.zone)"
}
