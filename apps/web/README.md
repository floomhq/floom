# Workeros Web App

This is the Next.js frontend for Workeros. It talks to the FastAPI backend in
`apps/api` and provides the UI for workers, runs, approvals, connections,
contexts, and settings.

## Local Development

From the repository root, the easiest path is:

```bash
./scripts/setup.sh
./scripts/dev.sh
```

On Windows PowerShell:

```powershell
.\scripts\setup.ps1
.\scripts\dev.ps1
```

To run the web app directly:

```bash
cd apps/web
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:3000`. The default `.env.example` points the frontend at
the local API on `http://localhost:8000`.

## Useful Commands

```bash
npm run lint
npm test
npm run build
```

Run these from `apps/web`. Root-level shortcuts are also available:

```bash
npm run lint:web
npm run test:web
npm run build:web
```

## Deployment

Build the app with `npm run build` and deploy the generated Next.js application
with any hosting provider that supports Next.js. Set `FLOOM_API_BASE` and
`NEXT_PUBLIC_API_BASE` to the URL of your Workeros API.
