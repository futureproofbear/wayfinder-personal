# Wayfinder

A personal, map-first trip planner for Asia. Plan a trip, optimise each day's
route around opening hours, and see it on an embedded map, with mainland China
supported through AMap and Baidu.

- [Architecture](docs/ARCHITECTURE.md): design, map provider adapter, China notes
- [Roadmap](docs/ROADMAP.md): Gate 1 feasibility checklist and what comes next

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
