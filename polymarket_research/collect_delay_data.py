import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import requests

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.append(str(Path(__file__).resolve().parents[1]))

from polymarket_research.common import (
    fetch_book_top,
    fetch_coinbase_ticker,
    find_candidate_markets,
    infer_up_down_token_ids,
    mid_from_bid_ask,
)


def _resolve_market_and_tokens(
    session: requests.Session,
    *,
    market_slug: Optional[str],
    pattern: str,
    max_pages: int,
    up_token_id: Optional[str],
    down_token_id: Optional[str],
) -> Tuple[Optional[Dict[str, Any]], str, str]:
    if up_token_id and down_token_id:
        market = None
        if market_slug:
            matches = find_candidate_markets(session, rf"^{market_slug}$", max_pages=max_pages, limit=1)
            market = matches[0] if matches else None
        return market, up_token_id, down_token_id

    if market_slug:
        matches = find_candidate_markets(session, rf"^{market_slug}$", max_pages=max_pages, limit=1)
    else:
        matches = find_candidate_markets(session, pattern, max_pages=max_pages, limit=5)

    if not matches:
        raise RuntimeError("No matching active market found. Use find_markets.py or pass token IDs explicitly.")

    market = matches[0]
    inferred_up, inferred_down = infer_up_down_token_ids(market)
    return market, inferred_up, inferred_down


def _safe_ms(ts_value: Any) -> Optional[int]:
    try:
        return int(float(ts_value))
    except (TypeError, ValueError):
        return None


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Collect synchronized Polymarket + BTC reference snapshots for delay analysis."
    )
    parser.add_argument("--pattern", default=r"bitcoin up or down|btc up or down")
    parser.add_argument("--market-slug", default=None, help="Exact market slug to target.")
    parser.add_argument("--up-token-id", default=None, help="Token ID for the Up (or first) outcome.")
    parser.add_argument("--down-token-id", default=None, help="Token ID for the Down (or second) outcome.")
    parser.add_argument("--seconds", type=int, default=1800, help="Collection duration in seconds.")
    parser.add_argument("--interval-ms", type=int, default=500, help="Sampling interval in milliseconds.")
    parser.add_argument("--output", default="data/polymarket_delay/snapshots.jsonl")
    parser.add_argument("--max-pages", type=int, default=30)
    parser.add_argument("--coinbase-product", default="BTC-USD")
    parser.add_argument("--print-every", type=int, default=20, help="Print every N samples.")
    args = parser.parse_args()

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    session = requests.Session()
    market, up_token_id, down_token_id = _resolve_market_and_tokens(
        session,
        market_slug=args.market_slug,
        pattern=args.pattern,
        max_pages=args.max_pages,
        up_token_id=args.up_token_id,
        down_token_id=args.down_token_id,
    )

    market_slug = market.get("slug") if market else (args.market_slug or "manual-token-ids")
    market_question = market.get("question") if market else None
    market_seconds_delay = market.get("seconds_delay") if market else None
    print(f"Collecting market slug={market_slug}")
    if market_question:
        print(f"Question: {market_question}")
    print(f"Up token:   {up_token_id}")
    print(f"Down token: {down_token_id}")
    print(f"Writing snapshots to: {output_path}")

    start = time.time()
    deadline = start + max(args.seconds, 0)
    sample_idx = 0
    errors = 0

    with output_path.open("a", encoding="utf-8") as f:
        while True:
            now = datetime.now(timezone.utc)
            now_ms = int(now.timestamp() * 1000)
            if args.seconds > 0 and time.time() >= deadline:
                break

            try:
                up_book = fetch_book_top(session, up_token_id)
                down_book = fetch_book_top(session, down_token_id)
                btc = fetch_coinbase_ticker(session, args.coinbase_product)
            except Exception as exc:
                errors += 1
                print(f"[warn] sample error: {exc}")
                time.sleep(max(args.interval_ms / 1000.0, 0.05))
                continue

            up_mid = mid_from_bid_ask(up_book["bid"], up_book["ask"])
            down_mid = mid_from_bid_ask(down_book["bid"], down_book["ask"])
            btc_mid = mid_from_bid_ask(btc["bid"], btc["ask"])
            up_book_ts_ms = _safe_ms(up_book.get("book_ts_ms"))
            down_book_ts_ms = _safe_ms(down_book.get("book_ts_ms"))
            youngest_book_ts_ms = None
            if up_book_ts_ms is not None and down_book_ts_ms is not None:
                youngest_book_ts_ms = max(up_book_ts_ms, down_book_ts_ms)
            elif up_book_ts_ms is not None:
                youngest_book_ts_ms = up_book_ts_ms
            elif down_book_ts_ms is not None:
                youngest_book_ts_ms = down_book_ts_ms

            book_age_ms = None if youngest_book_ts_ms is None else (now_ms - youngest_book_ts_ms)
            book_age_abs_ms = None if book_age_ms is None else abs(book_age_ms)

            row = {
                "ts_iso": now.isoformat(),
                "ts_ms": now_ms,
                "market_slug": market_slug,
                "market_question": market_question,
                "market_seconds_delay": market_seconds_delay,
                "up_token_id": up_token_id,
                "down_token_id": down_token_id,
                "up_bid": up_book["bid"],
                "up_ask": up_book["ask"],
                "up_bid_size": up_book["bid_size"],
                "up_ask_size": up_book["ask_size"],
                "up_book_ts_ms": up_book_ts_ms,
                "up_mid": up_mid,
                "down_bid": down_book["bid"],
                "down_ask": down_book["ask"],
                "down_bid_size": down_book["bid_size"],
                "down_ask_size": down_book["ask_size"],
                "down_book_ts_ms": down_book_ts_ms,
                "down_mid": down_mid,
                "pm_mid_gap_to_one": None if up_mid is None or down_mid is None else (up_mid + down_mid - 1.0),
                "pm_book_age_ms": book_age_ms,
                "pm_book_age_abs_ms": book_age_abs_ms,
                "btc_product_id": btc.get("product_id"),
                "btc_last": btc.get("price"),
                "btc_bid": btc.get("bid"),
                "btc_ask": btc.get("ask"),
                "btc_mid": btc_mid,
                "btc_exchange_time": btc.get("exchange_time"),
                "collector_errors_so_far": errors,
            }
            f.write(json.dumps(row) + "\n")
            f.flush()

            sample_idx += 1
            if sample_idx % max(args.print_every, 1) == 0:
                print(
                    f"[{sample_idx}] up_mid={up_mid} down_mid={down_mid} "
                    f"btc_mid={btc_mid} book_age_ms={book_age_ms}"
                )

            elapsed = time.time() - start
            target_elapsed = sample_idx * (args.interval_ms / 1000.0)
            sleep_seconds = max(0.0, target_elapsed - elapsed)
            time.sleep(sleep_seconds)

    print(f"Done. Wrote {sample_idx} samples with {errors} request errors.")


if __name__ == "__main__":
    main()
