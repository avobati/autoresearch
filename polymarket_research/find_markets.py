import argparse
import json
import sys
from pathlib import Path
from typing import Dict, List

import requests

if str(Path(__file__).resolve().parents[1]) not in sys.path:
    sys.path.append(str(Path(__file__).resolve().parents[1]))

from polymarket_research.common import find_candidate_markets


def _token_pairs(market: Dict) -> List[str]:
    outcomes = market.get("outcomes_parsed", [])
    token_ids = market.get("token_ids_parsed", [])
    return [f"{outcome}:{token_id}" for outcome, token_id in zip(outcomes, token_ids)]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Find active Polymarket markets and print token IDs for outcome mapping."
    )
    parser.add_argument(
        "--pattern",
        default=r"bitcoin|btc",
        help="Regex against question and slug (default: bitcoin|btc).",
    )
    parser.add_argument("--limit", type=int, default=20, help="Max matches to print.")
    parser.add_argument("--max-pages", type=int, default=30, help="Max Gamma pages to scan.")
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print raw JSON instead of human-readable lines.",
    )
    args = parser.parse_args()

    session = requests.Session()
    markets = find_candidate_markets(
        session,
        args.pattern,
        max_pages=args.max_pages,
        limit=args.limit,
    )

    if args.json:
        print(json.dumps(markets, indent=2))
        return

    if not markets:
        print("No active matches found. Try a broader --pattern or larger --max-pages.")
        return

    for idx, market in enumerate(markets, start=1):
        print(f"[{idx}] {market.get('question')}")
        print(f"    slug: {market.get('slug')}")
        print(f"    end: {market.get('endDate')} | volume24hr: {market.get('volume24hr')}")
        print(f"    seconds_delay: {market.get('seconds_delay')}")
        print(f"    outcomes: {', '.join(_token_pairs(market))}")
        print()

    first = markets[0]
    outcomes = first.get("outcomes_parsed", [])
    token_ids = first.get("token_ids_parsed", [])
    if len(token_ids) >= 2:
        print("Example collector command using the top result:")
        print(
            "uv run python polymarket_research/collect_delay_data.py "
            f"--market-slug \"{first.get('slug')}\" "
            f"--up-token-id \"{token_ids[0]}\" --down-token-id \"{token_ids[1]}\" "
            "--seconds 1800 --interval-ms 500"
        )
        if outcomes:
            print(f"Token order is: {outcomes} (map these explicitly to your Up/Down hypothesis).")


if __name__ == "__main__":
    main()
