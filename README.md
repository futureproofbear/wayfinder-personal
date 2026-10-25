# Wayfinder

A personal, map-first trip planner for Asia. Plan a trip, optimise each day's
route around opening hours, and see it on an embedded map, with mainland China
supported through AMap and Baidu.

- [Architecture](docs/ARCHITECTURE.md): design, map provider adapter, China notes
- [Roadmap](docs/ROADMAP.md): Gate 1 feasibility checklist and what comes next

## Tonight mode (`/`)

The home page plans an evening out, entirely in the browser with Google Maps:
search places near you, add up to 7 stops, and it orders them around today's
opening hours and travel time, preferring meal → dessert/coffee → drinks.
The route is drawn on an embedded Google map, and **Navigate in Google Maps**
hands off turn-by-turn. No backend is needed, so it deploys as a static site.

### Deploy it to your phone (about 10 minutes)

1. **Google key.** In [Google Cloud Console](https://console.cloud.google.com/),
   create a project with billing, enable **Maps JavaScript API**,
   **Places API (New)** and **Routes API**, then create an API key. Restrict it
   to *HTTP referrers* (`https://*.vercel.app/*`, or your own domain) and to
   those three APIs.
2. **Host.** On [Vercel](https://vercel.com/new), import this repo, set
   **Root Directory** to `frontend`, add the environment variable
   `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, and deploy.
3. Open the URL on your phone and choose *Add to Home Screen*.

The sample-days page that uses the Python backend is at `/demo`.

## Layout

```
backend/    FastAPI API, map provider adapters, OR-Tools day planner, PostGIS schema
frontend/   Next.js PWA, MapLibre map behind a renderer interface
docs/       Architecture and roadmap
```

## Run locally

Runs without any API keys: the backend falls back to a mock provider that
estimates routes from straight-line distance.

```bash
# API on :8000
cd backend
cp .env.example .env        # optional: add Google / AMap / Baidu keys
uv sync
uv run uvicorn app.main:app --reload

# Web on :3000
cd frontend
npm install
npm run dev
```

Open http://localhost:3000, pick a sample day and click **Optimise day**.

Or run everything, including PostGIS and Redis, with `docker compose up --build`.

## Checks

```bash
cd backend && uv run ruff check . && uv run pytest
cd frontend && npx tsc --noEmit && npm run lint && npm run build
```
