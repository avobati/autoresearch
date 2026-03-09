# Web Dashboard (Vercel + Neon)

This app visualizes uploaded delay-research runs from Neon.

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
```

