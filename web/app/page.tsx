import Link from "next/link";
import {
  getScanMetrics,
  getStrategies,
  getTopOpportunityRows,
  hasDatabase,
  listRecentRuns,
  listRecentScans,
  type DashboardRun,
  type MarketScanRun,
  type OpportunityRow,
  type StrategyRow,
} from "../lib/db";

type Mode = "overall" | "arb" | "maker" | "momentum";

function fmtN(v: number | null | undefined, digits = 3) {
  if (v === null || v === undefined || Number.isNaN(v)) return "n/a";
  return v.toFixed(digits);
}

function fmtPct(v: number | null | undefined, digits = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return "n/a";
  return `${(v * 100).toFixed(digits)}%`;
}

function fmtTs(v: string | null) {
  if (!v) return "n/a";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString();
}

function pnlClass(v: number | null | undefined) {
  if (v === null || v === undefined || Number.isNaN(v)) return "";
  if (v > 0) return "good";
  if (v < 0) return "bad";
  return "";
}

function kpi(label: string, value: string) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

function modeLabel(mode: Mode) {
  if (mode === "arb") return "Arbitrage";
  if (mode === "maker") return "Maker Spread";
  if (mode === "momentum") return "Momentum";
  return "Overall";
}

function modeHref(scanId: string, mode: Mode) {
  return `/?scan=${encodeURIComponent(scanId)}&mode=${mode}`;
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ run?: string; scan?: string; mode?: string }>;
}) {
  if (!hasDatabase()) {
    return (
      <main className="page">
        <section className="hero">
          <h1>Polymarket Profit Lab</h1>
          <p>
            Neon is not configured yet. Add <span className="mono">DATABASE_URL</span>, then run{" "}
            <span className="mono">npm run db:init</span>, <span className="mono">npm run db:upload-scan</span>,
            and redeploy.
          </p>
        </section>
      </main>
    );
  }

  const params = await searchParams;
  const mode: Mode = (["overall", "arb", "maker", "momentum"].includes(params.mode || "")
    ? params.mode
    : "overall") as Mode;

  const scans = await listRecentScans(10);
  const runs = await listRecentRuns(10);

  const activeScan: MarketScanRun | undefined = params.scan
    ? scans.find((s) => s.scan_id === params.scan)
    : scans[0];
  const activeRun: DashboardRun | undefined = params.run
    ? runs.find((r) => r.run_id === params.run)
    : runs[0];

  const scanMetrics = activeScan ? await getScanMetrics(activeScan.scan_id) : null;
  const opportunities: OpportunityRow[] = activeScan
    ? await getTopOpportunityRows(activeScan.scan_id, mode, 30)
    : [];
  const strategies: StrategyRow[] = activeRun ? await getStrategies(activeRun.run_id, 12) : [];

  return (
    <main className="page">
      <section className="hero">
        <h1>Polymarket Profit Lab</h1>
        <p>Scans all active markets, scores potential edges, and tracks backtest outcomes.</p>
        <p className="note">
          Results rank opportunities; they do not guarantee profit. Trade only with strict risk controls.
        </p>
      </section>

      <section className="grid">
        <article className="card runs">
          <h2>Scan Runs</h2>
          {scans.length === 0 ? (
            <p className="empty">No market scans uploaded yet.</p>
          ) : (
            <ul>
              {scans.map((scan) => {
                const active = activeScan?.scan_id === scan.scan_id;
                return (
                  <li key={scan.scan_id} className={`run-item ${active ? "active" : ""}`}>
                    <div className="run-top">
                      <strong className="mono">{scan.scan_id}</strong>
                      <span>{fmtTs(scan.created_at)}</span>
                    </div>
                    <div>
                      {scan.market_count} markets | deep priced {scan.deep_priced_count}
                    </div>
                    <div>
                      <Link href={modeHref(scan.scan_id, mode)}>Open</Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </article>

        <article className="card details">
          <h2>Opportunity Board</h2>
          {!activeScan ? (
            <p className="empty">Upload a scan to see opportunity rankings.</p>
          ) : (
            <>
              <div className="subnav">
                <Link className={mode === "overall" ? "pill active-pill" : "pill"} href={modeHref(activeScan.scan_id, "overall")}>
                  Overall
                </Link>
                <Link className={mode === "arb" ? "pill active-pill" : "pill"} href={modeHref(activeScan.scan_id, "arb")}>
                  Arbitrage
                </Link>
                <Link className={mode === "maker" ? "pill active-pill" : "pill"} href={modeHref(activeScan.scan_id, "maker")}>
                  Maker Spread
                </Link>
                <Link
                  className={mode === "momentum" ? "pill active-pill" : "pill"}
                  href={modeHref(activeScan.scan_id, "momentum")}
                >
                  Momentum
                </Link>
              </div>

              <div className="kpis">
                {kpi("Markets", String(activeScan.market_count))}
                {kpi("Deep Priced", String(activeScan.deep_priced_count))}
                {kpi("Buy-Both Arb > 0", String(activeScan.positive_buy_arb_count))}
                {kpi("Sell-Both Arb > 0", String(activeScan.positive_sell_arb_count))}
                {kpi("Buy-Both Arb Fresh", String(activeScan.positive_buy_arb_fresh_count))}
                {kpi("Sell-Both Arb Fresh", String(activeScan.positive_sell_arb_fresh_count))}
                {kpi("Avg Spread", fmtN(scanMetrics?.avg_spread ?? null, 4))}
                {kpi("Fresh Book Ratio", fmtPct(scanMetrics?.fresh_book_ratio ?? null, 1))}
              </div>

              <h3>Top {modeLabel(mode)} Opportunities</h3>
              {opportunities.length === 0 ? (
                <p className="empty">No rows found.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Market</th>
                      <th>Recommendation</th>
                      <th>Score</th>
                      <th>Spread</th>
                      <th>Vol24h</th>
                      <th>BuyBoth Edge</th>
                      <th>SellBoth Edge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {opportunities.map((row, idx) => (
                      <tr key={`${row.slug}-${idx}`}>
                        <td title={row.question ?? ""}>{row.slug ?? "n/a"}</td>
                        <td>{row.recommendation ?? "n/a"}</td>
                        <td>{fmtN(row.base_score, 3)}</td>
                        <td>{fmtN(row.spread, 4)}</td>
                        <td>{fmtN(row.volume24hr, 1)}</td>
                        <td className={pnlClass(row.arb_buy_both_edge)}>{fmtN(row.arb_buy_both_edge, 4)}</td>
                        <td className={pnlClass(row.arb_sell_both_edge)}>{fmtN(row.arb_sell_both_edge, 4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </article>
      </section>

      <section className="grid section-gap">
        <article className="card details full">
          <h2>Lag Backtest History</h2>
          {!activeRun ? (
            <p className="empty">No backtest runs uploaded.</p>
          ) : (
            <>
              <p>
                Active run <span className="mono">{activeRun.run_id}</span> | {fmtTs(activeRun.created_at)} |{" "}
                {activeRun.market_slug ?? "n/a"}
              </p>
              <div className="kpis">
                {kpi("Samples", String(activeRun.sample_count ?? "n/a"))}
                {kpi("Duration (s)", String(activeRun.duration_seconds ?? "n/a"))}
                {kpi("Book Age p95 (ms)", fmtN(activeRun.pm_book_age_abs_ms_p95, 1))}
                {kpi("Avg Up Mid", fmtN(activeRun.up_mid_avg, 4))}
                {kpi("Avg Down Mid", fmtN(activeRun.down_mid_avg, 4))}
                {kpi("Avg BTC Mid", fmtN(activeRun.btc_mid_avg, 2))}
              </div>

              {strategies.length === 0 ? (
                <p className="empty">No strategy rows for this run.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Params</th>
                      <th>Train Trades</th>
                      <th>Train PnL</th>
                      <th>Test Trades</th>
                      <th>Test PnL</th>
                      <th>Test Win %</th>
                      <th>Test Sharpe-like</th>
                    </tr>
                  </thead>
                  <tbody>
                    {strategies.map((row, idx) => (
                      <tr key={idx}>
                        <td className="mono">
                          L{row.lookback_seconds}/H{row.hold_seconds}/T{row.threshold_bps}/P{row.max_entry_prob}
                        </td>
                        <td>{row.train_trades}</td>
                        <td className={pnlClass(row.train_total_pnl)}>{fmtN(row.train_total_pnl, 5)}</td>
                        <td>{row.test_trades}</td>
                        <td className={pnlClass(row.test_total_pnl)}>{fmtN(row.test_total_pnl, 5)}</td>
                        <td>{fmtN((row.test_win_rate ?? 0) * 100, 1)}%</td>
                        <td>{fmtN(row.test_sharpe_like, 3)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </article>
      </section>
    </main>
  );
}
