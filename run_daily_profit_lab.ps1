param(
    [int]$ScanPages = 12,
    [int]$DeepLimit = 120,
    [int]$CollectSeconds = 180,
    [int]$CollectIntervalMs = 500
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

# Ensure uv is available in this shell.
$env:Path = "C:\Users\avoba\.local\bin;$env:Path"

Write-Host "==[1/5] Scan all active markets=="
uv run python polymarket_research/scan_all_markets.py --max-pages $ScanPages --deep-limit $DeepLimit --out-dir data/polymarket_scan

Write-Host "==[2/5] Collect delay snapshots (BTC proxy market)=="
uv run python polymarket_research/collect_delay_data.py `
  --market-slug "will-bitcoin-hit-1m-before-gta-vi-872" `
  --up-token-id "105267568073659068217311993901927962476298440625043565106676088842803600775810" `
  --down-token-id "91863162118308663069733924043159186005106558783397508844234610341221325526200" `
  --seconds $CollectSeconds `
  --interval-ms $CollectIntervalMs `
  --output data/polymarket_delay/snapshots.jsonl

Write-Host "==[3/5] Run lag backtest grid=="
uv run python polymarket_research/backtest_delay.py `
  --input data/polymarket_delay/snapshots.jsonl `
  --grid `
  --lookback-grid "1,2,3,5,8" `
  --hold-grid "2,3,5,8,12" `
  --threshold-grid "1,2,3,4,5,8" `
  --max-prob-grid "0.55,0.6,0.65,0.7" `
  --min-trades 4 `
  --results-csv data/polymarket_delay/grid_results.csv

Write-Host "==[4/5] Upload market scan + backtest data to Neon=="
Push-Location web
npm run db:init
npm run db:upload-scan
npm run db:upload
Pop-Location

Write-Host "==[5/5] Daily run complete=="
Write-Host "Dashboard: https://web-kappa-ivory-72.vercel.app"

