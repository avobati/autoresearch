import Link from "next/link";
import { getStrategies, hasDatabase, listRecentRuns, type DashboardRun, type StrategyRow } from "../lib/db";

function fmtN(v: number | null | undefined, digits = 3) {
  if (v === null || v === undefined || Number.isNaN(v)) return "n/a";
  return v.toFixed(digits);
}

function fmtTs(v: string | null) {
  if (!v) return "n/a";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString();
}

function pnlClass(v: number) {
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

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  if (!hasDatabase()) {
    return (
      <main className="page">
        <section className="hero">
          <h1>Autoresearch Results Dashboard</h1>
          <p>
            This deployment is live, but <span className="mono">DATABASE_URL</span> is not set yet.
          </p>
          <p>
            Set Neon connection in Vercel env, run <span className="mono">npm run db:init</span> and{" "}
            <span className="mono">npm run db:upload</span>, then redeploy.
          </p>
        </section>
      </main>
    );
  }

  const runs = await listRecentRuns(15);
  if (runs.length === 0) {
    return (
      <main className="page">
        <section className="hero">
          <h1>Autoresearch Results Dashboard</h1>
          <p>Connected to Neon, but no research runs were uploaded yet.</p>
        </section>
      </main>
    );
  }

  const params = await searchParams;
  const chosen = params.run ? runs.find((r) => r.run_id === params.run) : undefined;
  const activeRun: DashboardRun = chosen ?? runs[0];
  const strategies: StrategyRow[] = await getStrategies(activeRun.run_id, 20);

  return (
    <main className="page">
      <section className="hero">
        <h1>Autoresearch Delay Results</h1>
        <p>
          Market: <strong>{activeRun.market_slug ?? "n/a"}</strong>
        </p>
        <p>Latest run: {fmtTs(activeRun.created_at)}</p>
      </section>

      <section className="grid">
        <article className="card runs">
          <h2>Runs</h2>
          <ul>
            {runs.map((run) => {
              const active = run.run_id === activeRun.run_id;
              return (
                <li key={run.run_id} className={`run-item ${active ? "active" : ""}`}>
                  <div className="run-top">
                    <strong className="mono">{run.run_id}</strong>
                    <span>{fmtTs(run.created_at)}</span>
                  </div>
                  <div>{run.market_slug}</div>
                  <div>
                    <Link href={`/?run=${encodeURIComponent(run.run_id)}`}>Open</Link>
                  </div>
                </li>
              );
            })}
          </ul>
        </article>

        <article className="card details">
          <h2>Run Summary</h2>
          <div className="kpis">
            {kpi("Samples", String(activeRun.sample_count ?? "n/a"))}
            {kpi("Duration (s)", String(activeRun.duration_seconds ?? "n/a"))}
            {kpi("Book Age p95 (ms)", fmtN(activeRun.pm_book_age_abs_ms_p95, 1))}
            {kpi("Avg Up Mid", fmtN(activeRun.up_mid_avg, 4))}
            {kpi("Avg Down Mid", fmtN(activeRun.down_mid_avg, 4))}
            {kpi("Avg BTC Mid", fmtN(activeRun.btc_mid_avg, 2))}
          </div>

          <h3>Top Strategy Rows</h3>
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
        </article>
      </section>
    </main>
  );
}

