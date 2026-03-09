# Polymarket Delay Research (Paper Trading)

This folder scaffolds a data-driven workflow to test whether Polymarket prices lag short-horizon BTC moves.

It does **not** guarantee profit and is meant for research/paper trading first.

## 1) Find candidate markets and token IDs

```bash
uv run python polymarket_research/find_markets.py --pattern "bitcoin|btc|up or down"
```

Use the output to identify the active market and the correct `Up`/`Down` token IDs.

## 2) Collect synchronized snapshots

```bash
uv run python polymarket_research/collect_delay_data.py \
  --market-slug "your-market-slug" \
  --up-token-id "UP_TOKEN_ID" \
  --down-token-id "DOWN_TOKEN_ID" \
  --seconds 1800 \
  --interval-ms 500 \
  --output data/polymarket_delay/snapshots.jsonl
```

Captured row fields include:
- Polymarket top-of-book and mids for both tokens
- Polymarket book timestamp age (`pm_book_age_ms`)
- Coinbase BTC ticker reference (bid/ask/mid)

## 3) Backtest the lag hypothesis

Single parameter run:

```bash
uv run python polymarket_research/backtest_delay.py \
  --input data/polymarket_delay/snapshots.jsonl \
  --lookback-seconds 3 \
  --hold-seconds 8 \
  --threshold-bps 4 \
  --max-entry-prob 0.62
```

Grid search with train/test split:

```bash
uv run python polymarket_research/backtest_delay.py \
  --input data/polymarket_delay/snapshots.jsonl \
  --grid \
  --lookback-grid "1,2,3,5,8" \
  --hold-grid "3,5,8,12" \
  --threshold-grid "2,3,4,5,6" \
  --max-prob-grid "0.55,0.6,0.65" \
  --results-csv data/polymarket_delay/grid_results.csv
```

## Suggested success gate

Before live capital, require:
- positive **out-of-sample** PnL after fees/slippage assumptions
- enough sample size (e.g. > 200 trades)
- acceptable max drawdown
- paper-trading forward validation

