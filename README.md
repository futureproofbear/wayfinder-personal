# Wayfinder

A personal, map-first trip planner for Asia. Plan a trip, optimise each day's
route around opening hours, and see it on an embedded map, with mainland China
supported through AMap and Baidu.

- [Architecture](docs/ARCHITECTURE.md): design, map provider adapter, China notes
- [Roadmap](docs/ROADMAP.md): Gate 1 feasibility checklist and what comes next

## Tonight mode (`/`)

The home page plans an evening out, entirely in the browser: search places
near you, add up to 7 stops, and it orders them around today's opening hours
and travel time, preferring meal → dessert/coffee → drinks. The route is drawn
on the embedded map, and **Navigate in Google Maps** hands off turn-by-turn.

It works with **no API keys**: places come from OpenStreetMap (Overpass),
walking and driving times from the FOSSGIS OSRM servers, and map tiles from
OpenFreeMap. Public transport times are estimates. Set
`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` at build time to switch to Google Maps,
Google Places (ratings, better coverage) and Google routing, including transit.

### Put it online

The build is a static site in `frontend/out/`, so any static host works.

- **Netlify Drop (no git, about 1 minute):** run `npm run build` in `frontend`,
  then drag the `out` folder onto https://app.netlify.com/drop. Sign in
  (free) so the site doesn't expire.
- **Vercel:** import this repo at https://vercel.com/new with
  **Root Directory** set to `frontend`. Add the Google key as an environment
  variable if you have one.

On your phone, open the URL and choose *Add to Home Screen*.

### Google key (optional)

In Google Cloud Console, enable **Maps JavaScript API**, **Places API (New)**
and **Routes API**, create an API key restricted to your site's domain
(HTTP referrers) and those APIs, and set it as `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`.

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
