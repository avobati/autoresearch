import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests

GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets"
CLOB_PRICE_URL = "https://clob.polymarket.com/price"
CLOB_BOOK_URL = "https://clob.polymarket.com/book"
COINBASE_TICKER_URL = "https://api.exchange.coinbase.com/products/{product}/ticker"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_json_array(value: Any) -> List[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            return []
    return []


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def iter_active_markets(
    session: requests.Session,
    *,
    max_pages: int = 20,
    page_size: int = 500,
) -> Iterable[Dict[str, Any]]:
    offset = 0
    for _ in range(max_pages):
        params = {
            "active": "true",
            "closed": "false",
            "limit": page_size,
            "offset": offset,
        }
        response = session.get(GAMMA_MARKETS_URL, params=params, timeout=20)
        response.raise_for_status()
        rows = response.json()
        if not rows:
            break
        for row in rows:
            outcomes = [str(x) for x in _parse_json_array(row.get("outcomes"))]
            token_ids = [str(x) for x in _parse_json_array(row.get("clobTokenIds"))]
            row = dict(row)
            row["outcomes_parsed"] = outcomes
            row["token_ids_parsed"] = token_ids
            row["volume24hr_num"] = _as_float(row.get("volume24hr"), 0.0)
            yield row
        if len(rows) < page_size:
            break
        offset += page_size


def find_candidate_markets(
    session: requests.Session,
    pattern: str,
    *,
    max_pages: int = 20,
    limit: int = 25,
) -> List[Dict[str, Any]]:
    rx = re.compile(pattern, re.IGNORECASE)
    matches: List[Dict[str, Any]] = []
    for market in iter_active_markets(session, max_pages=max_pages):
        question = str(market.get("question", ""))
        slug = str(market.get("slug", ""))
        if rx.search(question) or rx.search(slug):
            if market.get("token_ids_parsed"):
                matches.append(market)
    matches.sort(
        key=lambda m: (m.get("volume24hr_num", 0.0), str(m.get("endDate", ""))),
        reverse=True,
    )
    return matches[:limit]


def _token_map(market: Dict[str, Any]) -> Dict[str, str]:
    outcomes = market.get("outcomes_parsed", [])
    token_ids = market.get("token_ids_parsed", [])
    return {str(outcome).strip().lower(): str(token_id) for outcome, token_id in zip(outcomes, token_ids)}


def infer_up_down_token_ids(market: Dict[str, Any]) -> Tuple[str, str]:
    mapping = _token_map(market)
    if "up" in mapping and "down" in mapping:
        return mapping["up"], mapping["down"]
    if "higher" in mapping and "lower" in mapping:
        return mapping["higher"], mapping["lower"]

    if "yes" in mapping and "no" in mapping:
        question = str(market.get("question", "")).lower()
        if "up or down" in question or "higher or lower" in question:
            raise ValueError("Outcomes are Yes/No but question is symmetric; provide token IDs explicitly.")
        up_cues = (" up ", " higher ", " above ", " increase ", " gain ")
        down_cues = (" down ", " lower ", " below ", " decrease ", " drop ", " fall ")
        padded = f" {question} "
        if any(cue in padded for cue in up_cues):
            return mapping["yes"], mapping["no"]
        if any(cue in padded for cue in down_cues):
            return mapping["no"], mapping["yes"]
        raise ValueError("Cannot infer Up/Down mapping from Yes/No outcomes.")

    raise ValueError(
        "Could not infer Up/Down outcomes. Pass --up-token-id and --down-token-id explicitly."
    )


def fetch_price(session: requests.Session, token_id: str, side: str) -> Optional[float]:
    response = session.get(
        CLOB_PRICE_URL,
        params={"token_id": token_id, "side": side},
        timeout=10,
    )
    if response.status_code != 200:
        return None
    payload = response.json()
    return _as_float(payload.get("price"), default=float("nan"))


def fetch_book_top(session: requests.Session, token_id: str) -> Dict[str, Optional[float]]:
    response = session.get(CLOB_BOOK_URL, params={"token_id": token_id}, timeout=10)
    if response.status_code != 200:
        return {
            "bid": None,
            "ask": None,
            "bid_size": None,
            "ask_size": None,
            "book_ts_ms": None,
        }
    payload = response.json()
    bids = payload.get("bids") or []
    asks = payload.get("asks") or []

    bid_levels: List[Tuple[float, float]] = []
    for row in bids:
        price = _as_float(row.get("price"), default=float("nan"))
        size = _as_float(row.get("size"), default=float("nan"))
        if price == price and size == size:
            bid_levels.append((price, size))

    ask_levels: List[Tuple[float, float]] = []
    for row in asks:
        price = _as_float(row.get("price"), default=float("nan"))
        size = _as_float(row.get("size"), default=float("nan"))
        if price == price and size == size:
            ask_levels.append((price, size))

    best_bid = max(bid_levels, key=lambda x: x[0]) if bid_levels else None
    best_ask = min(ask_levels, key=lambda x: x[0]) if ask_levels else None

    return {
        "bid": best_bid[0] if best_bid else None,
        "ask": best_ask[0] if best_ask else None,
        "bid_size": best_bid[1] if best_bid else None,
        "ask_size": best_ask[1] if best_ask else None,
        "book_ts_ms": _as_float(payload.get("timestamp"), default=float("nan")) if payload.get("timestamp") else None,
    }


def mid_from_bid_ask(bid: Optional[float], ask: Optional[float]) -> Optional[float]:
    if bid is None or ask is None:
        return None
    if bid != bid or ask != ask:  # NaN check
        return None
    return 0.5 * (bid + ask)


def fetch_coinbase_ticker(session: requests.Session, product: str = "BTC-USD") -> Dict[str, Optional[float]]:
    response = session.get(COINBASE_TICKER_URL.format(product=product), timeout=10)
    response.raise_for_status()
    payload = response.json()
    return {
        "product_id": product,
        "price": _as_float(payload.get("price"), default=float("nan")),
        "bid": _as_float(payload.get("bid"), default=float("nan")),
        "ask": _as_float(payload.get("ask"), default=float("nan")),
        "trade_id": _as_float(payload.get("trade_id"), default=float("nan")),
        "size": _as_float(payload.get("size"), default=float("nan")),
        "exchange_time": payload.get("time"),
    }
