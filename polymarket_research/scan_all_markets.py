import argparse
import csv
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import requests

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.append(str(Path(__file__).resolve().parents[1]))

from polymarket_research.common import fetch_book_top, fetch_price

GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets"


def _as_float(value: Any, default: float = float("nan")) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _parse_json_list(value: Any) -> List[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        txt = value.strip()
        if not txt:
            return []
        try:
            parsed = json.loads(txt)
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            return []
    return []


def _safe_log10p(x: float) -> float:
    if not math.isfinite(x) or x <= 0:
        return 0.0
    return math.log10(1.0 + x)


def fetch_all_active_markets(session: requests.Session, *, page_size: int, max_pages: int) -> List[Dict[str, Any]]:
    all_rows: List[Dict[str, Any]] = []
    offset = 0
    for _ in range(max_pages):
        params = {
            "active": "true",
            "closed": "false",
            "limit": page_size,
            "offset": offset,
        }
        response = session.get(GAMMA_MARKETS_URL, params=params, timeout=30)
        response.raise_for_status()
        rows = response.json()
        if not rows:
            break
        all_rows.extend(rows)
        if len(rows) < page_size:
            break
        offset += page_size
    return all_rows


def stage1_enrich(markets: List[Dict[str, Any]], *, taker_fee_bps: float) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    fee_prob = taker_fee_bps / 10000.0
    for m in markets:
        outcomes = [str(x) for x in _parse_json_list(m.get("outcomes"))]
        token_ids = [str(x) for x in _parse_json_list(m.get("clobTokenIds"))]
        prices = [_as_float(x) for x in _parse_json_list(m.get("outcomePrices"))]

        if len(token_ids) != 2:
            continue
        if len(prices) != 2 or not all(math.isfinite(p) for p in prices):
            continue

        p1, p2 = prices
        spread = _as_float(m.get("spread"), 0.0)
        vol24 = _as_float(m.get("volume24hr"), 0.0)
        liq = _as_float(m.get("liquidity"), 0.0)
        one_hour = _as_float(m.get("oneHourPriceChange"), 0.0)
        one_day = _as_float(m.get("oneDayPriceChange"), 0.0)
        best_bid = _as_float(m.get("bestBid"), float("nan"))
        best_ask = _as_float(m.get("bestAsk"), float("nan"))

        mid_sum = p1 + p2
        complement_gap = 1.0 - mid_sum
        movement_to_spread = abs(one_hour) / max(spread, 0.001)
        maker_edge_est = spread - (2 * fee_prob)
        taker_reversion_est = abs(complement_gap) - (2 * fee_prob)
        liquidity_score = _safe_log10p(liq)
        activity_score = _safe_log10p(vol24)
        confidence = min(1.0, (liquidity_score + activity_score) / 8.0)

        base_score = (
            (movement_to_spread * 0.35)
            + (max(maker_edge_est, 0.0) * 100.0 * 0.25)
            + (max(taker_reversion_est, 0.0) * 100.0 * 0.20)
            + (activity_score * 0.12)
            + (liquidity_score * 0.08)
        ) * confidence

        recommendation = "No clear edge"
        if maker_edge_est > 0.001 and vol24 > 5000:
            recommendation = "Spread capture (maker)"
        if taker_reversion_est > 0.001:
            recommendation = "Cross-outcome mean reversion"
        if movement_to_spread > 10 and spread <= 0.02 and vol24 > 3000:
            recommendation = "Momentum follow-through"

        out.append(
            {
                "market_id": str(m.get("id")),
                "slug": m.get("slug"),
                "question": m.get("question"),
                "end_date": m.get("endDate"),
                "outcome_1": outcomes[0] if outcomes else "Outcome1",
                "outcome_2": outcomes[1] if len(outcomes) > 1 else "Outcome2",
                "token_1": token_ids[0],
                "token_2": token_ids[1],
                "mid_1": p1,
                "mid_2": p2,
                "mid_sum": mid_sum,
                "complement_gap": complement_gap,
                "best_bid_single": best_bid if math.isfinite(best_bid) else None,
                "best_ask_single": best_ask if math.isfinite(best_ask) else None,
                "spread": spread,
                "volume24hr": vol24,
                "liquidity": liq,
                "one_hour_change": one_hour,
                "one_day_change": one_day,
                "movement_to_spread": movement_to_spread,
                "maker_edge_est": maker_edge_est,
                "taker_reversion_est": taker_reversion_est,
                "liquidity_score": liquidity_score,
                "activity_score": activity_score,
                "confidence": confidence,
                "base_score": base_score,
                "recommendation": recommendation,
            }
        )
    return out


def stage2_deep_price(
    session: requests.Session,
    candidates: List[Dict[str, Any]],
    *,
    deep_limit: int,
    taker_fee_bps: float,
    max_book_age_ms: int,
) -> None:
    fee_prob = taker_fee_bps / 10000.0
    ranked = sorted(
        candidates,
        key=lambda r: (r["base_score"], r["volume24hr"], r["liquidity"]),
        reverse=True,
    )
    for row in ranked[:deep_limit]:
        t1 = row["token_1"]
        t2 = row["token_2"]
        b1 = fetch_book_top(session, t1)
        b2 = fetch_book_top(session, t2)
        t1_buy = fetch_price(session, t1, "buy")
        t1_sell = fetch_price(session, t1, "sell")
        t2_buy = fetch_price(session, t2, "buy")
        t2_sell = fetch_price(session, t2, "sell")

        row["token_1_bid"] = b1["bid"]
        row["token_1_ask"] = b1["ask"]
        row["token_2_bid"] = b2["bid"]
        row["token_2_ask"] = b2["ask"]
        row["token_1_bid_size"] = b1["bid_size"]
        row["token_1_ask_size"] = b1["ask_size"]
        row["token_2_bid_size"] = b2["bid_size"]
        row["token_2_ask_size"] = b2["ask_size"]
        row["token_1_buy_px"] = t1_buy
        row["token_1_sell_px"] = t1_sell
        row["token_2_buy_px"] = t2_buy
        row["token_2_sell_px"] = t2_sell

        buy_both_cost = None
        sell_both_credit = None
        if t1_buy is not None and t2_buy is not None and math.isfinite(t1_buy) and math.isfinite(t2_buy):
            buy_both_cost = t1_buy + t2_buy
        if t1_sell is not None and t2_sell is not None and math.isfinite(t1_sell) and math.isfinite(t2_sell):
            sell_both_credit = t1_sell + t2_sell

        row["buy_both_cost"] = buy_both_cost
        row["sell_both_credit"] = sell_both_credit
        row["arb_buy_both_edge"] = None
        row["arb_sell_both_edge"] = None
        complement_sane = abs(float(row.get("mid_sum", 0.0)) - 1.0) <= 0.08
        book_shape_sane = all(
            isinstance(row.get(k), float) and 0.0 <= float(row.get(k)) <= 1.0
            for k in ("token_1_bid", "token_1_ask", "token_2_bid", "token_2_ask")
        )
        book_spread_sane = (
            book_shape_sane
            and float(row["token_1_bid"]) <= float(row["token_1_ask"])
            and float(row["token_2_bid"]) <= float(row["token_2_ask"])
        )
        price_alignment_sane = True
        if t1_buy is not None and row.get("token_1_ask") is not None and math.isfinite(float(row["token_1_ask"])):
            price_alignment_sane = price_alignment_sane and (abs(t1_buy - float(row["token_1_ask"])) <= 0.03)
        if t2_buy is not None and row.get("token_2_ask") is not None and math.isfinite(float(row["token_2_ask"])):
            price_alignment_sane = price_alignment_sane and (abs(t2_buy - float(row["token_2_ask"])) <= 0.03)
        if t1_sell is not None and row.get("token_1_bid") is not None and math.isfinite(float(row["token_1_bid"])):
            price_alignment_sane = price_alignment_sane and (abs(t1_sell - float(row["token_1_bid"])) <= 0.03)
        if t2_sell is not None and row.get("token_2_bid") is not None and math.isfinite(float(row["token_2_bid"])):
            price_alignment_sane = price_alignment_sane and (abs(t2_sell - float(row["token_2_bid"])) <= 0.03)

        row["arb_sanity_ok"] = complement_sane and book_spread_sane and price_alignment_sane
        if row["arb_sanity_ok"] and buy_both_cost is not None:
            row["arb_buy_both_edge"] = 1.0 - buy_both_cost - (2 * fee_prob)
        if row["arb_sanity_ok"] and sell_both_credit is not None:
            row["arb_sell_both_edge"] = sell_both_credit - 1.0 - (2 * fee_prob)

        ts1 = b1.get("book_ts_ms")
        ts2 = b2.get("book_ts_ms")
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        age1 = None if ts1 is None else abs(now_ms - int(ts1))
        age2 = None if ts2 is None else abs(now_ms - int(ts2))
        ages = [a for a in [age1, age2] if a is not None]
        row["book_age_ms"] = max(ages) if ages else None
        row["book_fresh"] = bool(ages) and (max(ages) <= max_book_age_ms)

        if row["arb_buy_both_edge"] is not None and row["arb_buy_both_edge"] > 0 and row["book_fresh"]:
            row["recommendation"] = "Cross-outcome arbitrage (buy both)"
        elif row["arb_sell_both_edge"] is not None and row["arb_sell_both_edge"] > 0 and row["book_fresh"]:
            row["recommendation"] = "Cross-outcome arbitrage (sell both)"


def write_outputs(rows: List[Dict[str, Any]], out_dir: Path) -> Tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    csv_path = out_dir / f"market_scan_{ts}.csv"
    summary_path = out_dir / f"market_scan_{ts}_summary.json"

    if not rows:
        csv_path.write_text("", encoding="utf-8")
        summary_path.write_text(json.dumps({"error": "no rows"}, indent=2), encoding="utf-8")
        return csv_path, summary_path

    keys = sorted({k for row in rows for k in row.keys()})
    with csv_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=keys)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)

    arb_buy = [r for r in rows if isinstance(r.get("arb_buy_both_edge"), float) and r["arb_buy_both_edge"] > 0]
    arb_sell = [r for r in rows if isinstance(r.get("arb_sell_both_edge"), float) and r["arb_sell_both_edge"] > 0]
    arb_buy_fresh = [r for r in arb_buy if r.get("book_fresh")]
    arb_sell_fresh = [r for r in arb_sell if r.get("book_fresh")]
    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "rows_total": len(rows),
        "rows_deep_priced": sum(1 for r in rows if r.get("buy_both_cost") is not None),
        "positive_buy_both_arb_count": len(arb_buy),
        "positive_sell_both_arb_count": len(arb_sell),
        "positive_buy_both_arb_fresh_count": len(arb_buy_fresh),
        "positive_sell_both_arb_fresh_count": len(arb_sell_fresh),
        "top_base_score": sorted(rows, key=lambda r: r.get("base_score", 0.0), reverse=True)[:10],
        "top_buy_both_arb": sorted(arb_buy, key=lambda r: r.get("arb_buy_both_edge", -999), reverse=True)[:10],
        "top_sell_both_arb": sorted(arb_sell, key=lambda r: r.get("arb_sell_both_edge", -999), reverse=True)[:10],
        "top_buy_both_arb_fresh": sorted(
            arb_buy_fresh, key=lambda r: r.get("arb_buy_both_edge", -999), reverse=True
        )[:10],
        "top_sell_both_arb_fresh": sorted(
            arb_sell_fresh, key=lambda r: r.get("arb_sell_both_edge", -999), reverse=True
        )[:10],
    }
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return csv_path, summary_path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scan all active Polymarket markets and rank edge opportunities."
    )
    parser.add_argument("--page-size", type=int, default=500)
    parser.add_argument("--max-pages", type=int, default=12)
    parser.add_argument("--deep-limit", type=int, default=120)
    parser.add_argument("--taker-fee-bps", type=float, default=2.0)
    parser.add_argument("--max-book-age-ms", type=int, default=8000)
    parser.add_argument("--out-dir", default="data/polymarket_scan")
    args = parser.parse_args()

    session = requests.Session()
    markets = fetch_all_active_markets(
        session,
        page_size=args.page_size,
        max_pages=args.max_pages,
    )
    print(f"Fetched {len(markets)} active markets from Gamma.")

    rows = stage1_enrich(markets, taker_fee_bps=args.taker_fee_bps)
    print(f"Stage1 usable binary markets: {len(rows)}")

    stage2_deep_price(
        session,
        rows,
        deep_limit=args.deep_limit,
        taker_fee_bps=args.taker_fee_bps,
        max_book_age_ms=args.max_book_age_ms,
    )
    print(f"Stage2 deep-priced top {min(args.deep_limit, len(rows))} markets.")

    csv_path, summary_path = write_outputs(rows, Path(args.out_dir))
    print(f"Wrote CSV: {csv_path}")
    print(f"Wrote summary JSON: {summary_path}")


if __name__ == "__main__":
    main()
