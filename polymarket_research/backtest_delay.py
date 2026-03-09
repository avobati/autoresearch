import argparse
import itertools
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional

import numpy as np
import pandas as pd


@dataclass
class StrategyParams:
    lookback_seconds: int
    hold_seconds: int
    threshold_bps: float
    max_entry_prob: float
    fee_bps: float
    slippage_bps: float
    direction: str  # up | down | both
    max_book_age_ms: Optional[float]


def parse_grid(value: str, cast=float) -> List:
    return [cast(item.strip()) for item in value.split(",") if item.strip()]


def load_snapshots(path: Path) -> pd.DataFrame:
    df = pd.read_json(path, lines=True)
    if df.empty:
        raise RuntimeError("Snapshot file is empty.")
    df["ts"] = pd.to_datetime(df["ts_iso"], utc=True, errors="coerce")
    df = df.sort_values("ts").reset_index(drop=True)
    keep_cols = [
        "ts",
        "btc_mid",
        "up_ask",
        "up_bid",
        "down_ask",
        "down_bid",
        "pm_book_age_ms",
        "pm_book_age_abs_ms",
    ]
    for col in keep_cols:
        if col not in df.columns:
            df[col] = np.nan
    return df


def simulate(df: pd.DataFrame, params: StrategyParams) -> Dict[str, float]:
    data = df.copy()
    data = data.dropna(subset=["ts", "btc_mid"]).reset_index(drop=True)
    if len(data) < 10:
        return {"num_trades": 0}

    ts_ns = data["ts"].astype("int64").to_numpy()
    btc = data["btc_mid"].to_numpy(dtype=float)
    up_ask = data["up_ask"].to_numpy(dtype=float)
    up_bid = data["up_bid"].to_numpy(dtype=float)
    down_ask = data["down_ask"].to_numpy(dtype=float)
    down_bid = data["down_bid"].to_numpy(dtype=float)
    if "pm_book_age_abs_ms" in data.columns:
        book_age = data["pm_book_age_abs_ms"].to_numpy(dtype=float)
    else:
        book_age = np.abs(data["pm_book_age_ms"].to_numpy(dtype=float))

    lookback_ns = int(params.lookback_seconds * 1_000_000_000)
    hold_ns = int(params.hold_seconds * 1_000_000_000)
    threshold = params.threshold_bps
    fee_mult = params.fee_bps / 1e4
    slip_mult = params.slippage_bps / 1e4

    trades: List[float] = []
    i = 0
    n = len(data)
    while i < n:
        entry_ts = ts_ns[i]
        if params.max_book_age_ms is not None and book_age[i] == book_age[i]:
            if book_age[i] > params.max_book_age_ms:
                i += 1
                continue

        j_prev = np.searchsorted(ts_ns, entry_ts - lookback_ns, side="right") - 1
        if j_prev < 0:
            i += 1
            continue
        if btc[j_prev] <= 0 or btc[i] <= 0:
            i += 1
            continue
        ret_bps = (btc[i] / btc[j_prev] - 1.0) * 1e4

        signal = None
        if params.direction in ("up", "both"):
            if ret_bps >= threshold and up_ask[i] == up_ask[i] and up_ask[i] <= params.max_entry_prob:
                signal = "up"
        if signal is None and params.direction in ("down", "both"):
            if ret_bps <= -threshold and down_ask[i] == down_ask[i] and down_ask[i] <= params.max_entry_prob:
                signal = "down"
        if signal is None:
            i += 1
            continue

        j_exit = np.searchsorted(ts_ns, entry_ts + hold_ns, side="left")
        if j_exit >= n:
            break

        if signal == "up":
            if up_bid[j_exit] != up_bid[j_exit] or up_ask[i] != up_ask[i]:
                i += 1
                continue
            entry_px = up_ask[i] * (1.0 + slip_mult)
            exit_px = up_bid[j_exit] * (1.0 - slip_mult)
        else:
            if down_bid[j_exit] != down_bid[j_exit] or down_ask[i] != down_ask[i]:
                i += 1
                continue
            entry_px = down_ask[i] * (1.0 + slip_mult)
            exit_px = down_bid[j_exit] * (1.0 - slip_mult)

        fees = fee_mult * (entry_px + exit_px)
        pnl = exit_px - entry_px - fees
        trades.append(float(pnl))
        i = j_exit + 1

    if not trades:
        return {"num_trades": 0}

    pnl_arr = np.array(trades, dtype=float)
    cum = np.cumsum(pnl_arr)
    peak = np.maximum.accumulate(cum)
    drawdown = cum - peak
    duration_hours = max((ts_ns[-1] - ts_ns[0]) / 3_600_000_000_000.0, 1e-9)
    win_rate = float(np.mean(pnl_arr > 0))
    avg = float(np.mean(pnl_arr))
    std = float(np.std(pnl_arr))
    sharpe_like = (avg / std) * np.sqrt(len(pnl_arr)) if std > 0 else 0.0
    return {
        "num_trades": int(len(pnl_arr)),
        "win_rate": win_rate,
        "avg_pnl": avg,
        "median_pnl": float(np.median(pnl_arr)),
        "total_pnl": float(np.sum(pnl_arr)),
        "pnl_per_hour": float(np.sum(pnl_arr) / duration_hours),
        "max_drawdown": float(np.min(drawdown)),
        "sharpe_like": float(sharpe_like),
    }


def print_result(label: str, metrics: Dict[str, float]) -> None:
    if metrics.get("num_trades", 0) == 0:
        print(f"{label}: no trades")
        return
    print(
        f"{label}: trades={metrics['num_trades']}, win_rate={metrics['win_rate']:.2%}, "
        f"avg_pnl={metrics['avg_pnl']:.5f}, total_pnl={metrics['total_pnl']:.5f}, "
        f"pnl_per_hour={metrics['pnl_per_hour']:.5f}, max_drawdown={metrics['max_drawdown']:.5f}, "
        f"sharpe_like={metrics['sharpe_like']:.3f}"
    )


def iterate_grid(args: argparse.Namespace) -> Iterable[StrategyParams]:
    lookbacks = parse_grid(args.lookback_grid, int)
    holds = parse_grid(args.hold_grid, int)
    thresholds = parse_grid(args.threshold_grid, float)
    max_probs = parse_grid(args.max_prob_grid, float)
    for lookback, hold, threshold, max_prob in itertools.product(lookbacks, holds, thresholds, max_probs):
        yield StrategyParams(
            lookback_seconds=lookback,
            hold_seconds=hold,
            threshold_bps=threshold,
            max_entry_prob=max_prob,
            fee_bps=args.fee_bps,
            slippage_bps=args.slippage_bps,
            direction=args.direction,
            max_book_age_ms=args.max_book_age_ms,
        )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backtest a simple lag strategy from collected Polymarket/BTC snapshots."
    )
    parser.add_argument("--input", default="data/polymarket_delay/snapshots.jsonl")
    parser.add_argument("--direction", choices=["up", "down", "both"], default="both")
    parser.add_argument("--lookback-seconds", type=int, default=3)
    parser.add_argument("--hold-seconds", type=int, default=8)
    parser.add_argument("--threshold-bps", type=float, default=4.0)
    parser.add_argument("--max-entry-prob", type=float, default=0.62)
    parser.add_argument("--fee-bps", type=float, default=2.0)
    parser.add_argument("--slippage-bps", type=float, default=1.0)
    parser.add_argument("--max-book-age-ms", type=float, default=2500.0)
    parser.add_argument("--grid", action="store_true")
    parser.add_argument("--lookback-grid", default="1,2,3,5,8")
    parser.add_argument("--hold-grid", default="3,5,8,12")
    parser.add_argument("--threshold-grid", default="2,3,4,5,6")
    parser.add_argument("--max-prob-grid", default="0.55,0.6,0.65")
    parser.add_argument("--train-fraction", type=float, default=0.7)
    parser.add_argument("--min-trades", type=int, default=20)
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--results-csv", default=None)
    args = parser.parse_args()

    df = load_snapshots(Path(args.input))
    print(f"Loaded {len(df)} rows from {args.input}")

    if not args.grid:
        params = StrategyParams(
            lookback_seconds=args.lookback_seconds,
            hold_seconds=args.hold_seconds,
            threshold_bps=args.threshold_bps,
            max_entry_prob=args.max_entry_prob,
            fee_bps=args.fee_bps,
            slippage_bps=args.slippage_bps,
            direction=args.direction,
            max_book_age_ms=args.max_book_age_ms,
        )
        metrics = simulate(df, params)
        print_result("single-run", metrics)
        return

    split_idx = int(len(df) * args.train_fraction)
    df_train = df.iloc[:split_idx].copy()
    df_test = df.iloc[split_idx:].copy()
    if df_train.empty or df_test.empty:
        raise RuntimeError("Train/test split produced an empty partition.")

    rows: List[Dict[str, float]] = []
    for params in iterate_grid(args):
        train_metrics = simulate(df_train, params)
        if train_metrics.get("num_trades", 0) < args.min_trades:
            continue
        test_metrics = simulate(df_test, params)
        row = {
            "lookback_seconds": params.lookback_seconds,
            "hold_seconds": params.hold_seconds,
            "threshold_bps": params.threshold_bps,
            "max_entry_prob": params.max_entry_prob,
            "train_trades": train_metrics.get("num_trades", 0),
            "train_total_pnl": train_metrics.get("total_pnl", 0.0),
            "train_win_rate": train_metrics.get("win_rate", 0.0),
            "test_trades": test_metrics.get("num_trades", 0),
            "test_total_pnl": test_metrics.get("total_pnl", 0.0),
            "test_win_rate": test_metrics.get("win_rate", 0.0),
            "test_sharpe_like": test_metrics.get("sharpe_like", 0.0),
            "test_max_drawdown": test_metrics.get("max_drawdown", 0.0),
        }
        rows.append(row)

    if not rows:
        print("No viable grid configurations produced enough trades.")
        return

    results = pd.DataFrame(rows)
    results = results.sort_values(
        ["test_total_pnl", "test_sharpe_like", "test_win_rate"],
        ascending=False,
    ).reset_index(drop=True)
    print(results.head(args.top_k).to_string(index=False))

    if args.results_csv:
        out_path = Path(args.results_csv)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        results.to_csv(out_path, index=False)
        print(f"Wrote full grid results to: {out_path}")


if __name__ == "__main__":
    main()
