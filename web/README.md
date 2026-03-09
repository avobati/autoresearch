# Web Dashboard (Vercel + Neon)

This app visualizes:

- all-market Polymarket opportunity scans
- lag backtest runs

## Local setup

```bash
cd web
npm install
```

Create `.env.local`:

```bash
DATABASE_URL=postgresql://<user>:<password>@<host>/<db>?sslmode=require
```

Initialize schema and upload latest run data:

```bash
npm run db:init
npm run db:upload
npm run db:upload-scan
npm run queue:refresh
```

Run locally:

```bash
npm run dev
```

## Deploy to Vercel

From `web/`:

```bash
npx vercel --yes
npx vercel env add DATABASE_URL production
npx vercel --prod --yes
```

Then upload run data from your local machine:

```bash
cd web
npm run db:init
npm run db:upload
npm run db:upload-scan
npm run queue:refresh

```

## Market scan workflow

From repository root:

```bash
uv run python polymarket_research/scan_all_markets.py --max-pages 12 --deep-limit 120 --out-dir data/polymarket_scan
```

Then from `web/`:

```bash
npm run db:upload-scan
```

## Funding workflow

Record a confirmed funding event:

```bash
npm run db:fund -- --type deposit --amount 200 --source "manual" --notes "Initial capital"
```

Generate pending opportunity tasks based on latest scan + available capital:

```bash
npm run queue:refresh
```
