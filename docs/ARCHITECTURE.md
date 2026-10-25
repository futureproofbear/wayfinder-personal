# Wayfinder — Architecture

A map-centric, AI-assisted trip planner for Asia. Plan a whole trip, discover
places, optimise each day's route and navigate between stops without leaving
the app.

**Ownership model: A — personal tool.** Built for one owner and their travel
group, not a public SaaS. The original plan was costed for a commercial team
(≈S$300k MVP). This document keeps its technical design but drops the
commercial overhead: no billing, no multi-tenancy, no booking/affiliate work,
single-host deployment. Commercial-only items are marked *(deferred)*.

## 1. Design principles

1. **Web-first, mobile-browser optimised.** Responsive Next.js PWA, installable
   on iPhone and Android.
2. **Embedded maps and routing.** Users never get bounced to an external map app.
3. **Multi-country, China first-class.** Adding Japan, Korea, Thailand, Taiwan,
   Malaysia or Indonesia must not need a redesign.
4. **Singapore-hosted app, regional map providers.**

A PWA is not a native app: background location, push and offline maps vary by
browser. **Offline itinerary access is guaranteed; offline navigation is a
later enhancement.**

## 2. Core workflow

1. **Create a trip:** country, cities, dates, travellers, budget.
2. **Discover:** attractions, food, shopping, experiences, accommodation areas.
3. **Generate:** AI proposes a day-by-day plan from preferences, opening hours
   and proximity.
4. **Optimise:** walking/driving/transit routes; reorder stops to cut travel.
5. **Customise:** drag stops between days, change durations; affected days are
   re-optimised.
6. **Travel:** itinerary, embedded map and directions, including offline.

## 3. Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js + React + TypeScript, PWA | `frontend/` |
| Map rendering | MapLibre GL (global); AMap / Baidu JS APIs (China) | MapLibre needs a tile service: OpenFreeMap by default |
| Backend | Python + FastAPI | `backend/` |
| Optimisation | Google OR-Tools | `backend/app/optimiser/` |
| Database | PostgreSQL + PostGIS | `backend/app/db/schema.sql` |
| Cache | Redis | route matrices, sessions, hot POIs |
| Hosting | One small VM in Singapore running `docker compose` | see §8 |

## 4. Logical architecture

```
            ┌──────────────── Next.js PWA ────────────────┐
            │ Trip planner UI · MapRenderer interface     │
            │   MapLibre │ AMap JS │ Baidu JS             │
            └───────────────┬─────────────────────────────┘
                            │ HTTPS (JSON, WGS-84 everywhere)
            ┌───────────────▼─────────────────────────────┐
            │ FastAPI                                     │
            │  Trip service · Itinerary engine · Scoring  │
            │  LLM interface (model-agnostic)             │
            │  ── MapProvider adapter ──────────────────  │
            │   Google │ AMap │ Baidu │ Mock (offline)    │
            └──────┬───────────────────┬──────────────────┘
                   │                   │
           PostgreSQL+PostGIS        Redis
```

### 4.1 Map Provider Adapter (the key component)

The itinerary engine requests "a route between these points" and gets a
standard result. It never knows which provider answered.

`backend/app/maps/base.py` defines `MapProvider`:

- `search_places()`, `geocode()`, `reverse_geocode()`
- `calculate_route()`, `calculate_route_matrix()`, `get_nearby_places()`

The frontend mirrors this with `MapRenderer` (`frontend/src/lib/maps/`):
`mount()`, `setMarkers()`, `setRoute()`, `fitTo()`.

**Provider selection** (`backend/app/maps/registry.py`):

| Market | Preference | Why |
|---|---|---|
| Mainland China (CN) | AMap → Baidu | Google is on Google Maps Platform's prohibited-territory list |
| Vietnam (VN) | none yet → mock | Also prohibited for Google; provider to be validated |
| Everywhere else | Google | |
| Any, key missing or provider down | Mock (straight-line estimates) | Degraded mode keeps the app usable |

Requests fall through the list on error and the response reports
`provider` and `degraded`.

These are integration candidates, not guarantees of equal coverage, terms or
routing quality. AMap's JS API has an overseas (Singapore) endpoint; its
overseas Web Service API is a separately provisioned commercial service. Check
Baidu's developer terms for your use.

### 4.2 Coordinates

- Canonical storage and every API boundary use **WGS-84**.
- AMap uses **GCJ-02**, Baidu uses **BD-09**. Adapters convert on the way in
  and out (`backend/app/geo/coords.py`, round-trip error < 0.5 m).
- Frontend renderers on offset base maps (AMap/Baidu) must convert WGS-84
  before drawing.
- Store provider place IDs in `destination_provider_refs`, not copies of
  provider coordinates. For mainland China, storage and transformation must
  follow provider and regulatory requirements (see §7).

## 5. Data model

See `backend/app/db/schema.sql`. Main entities: `travellers`, `preferences`,
`destinations`, `destination_provider_refs`, `trips`, `trip_days`,
`itinerary_items`, `recommendation_feedback`.

Each destination carries English and local names, country/city, categories and
tags, location, opening hours, typical visit duration and cost, accessibility,
source, last-verified date, and a **confidence score** (0–1), so a verified
provider listing isn't treated the same as an old manual entry.

**Provider content is not freely reusable.** Don't harvest Google, AMap or
Baidu listings into a permanent POI database. Respect each provider's storage,
caching, attribution and display terms.

## 6. Planning engine

The AI and the optimiser are deliberately separate. The LLM understands
preferences and suggests experiences; a constraint solver produces feasible
schedules. **The AI never invents opening hours, prices or travel times.**
Facts come from the database and live provider APIs.

### 6.1 Three stages

1. **Interpret preferences (LLM).** Natural language → structured preferences
   (e.g. family, architecture, tech museums, local food, moderate walking).
2. **Select destinations.** Query DB and providers; rank with the score below.
3. **Optimise (OR-Tools).** Order stops, allocate time, minimise travel.

### 6.2 Recommendation score

`S = w_i·I + w_r·R + w_p·P + w_g·G + w_b·B + w_c·C` (`backend/app/scoring.py`)

I interest match · R review quality · P popularity · G geographic convenience ·
B budget fit · C data confidence/freshness. Weights are starting hypotheses,
calibrated from feedback (saved → visited/removed → rated).

### 6.3 Day optimisation

`backend/app/optimiser/day_planner.py` solves a TSP with time windows per day
(the single-vehicle case of VRPTW):

- opening/closing hours, visit durations, day start/end
- mandatory stops vs optional stops with priority-weighted drop penalties
- optional maximum daily travel time
- start (and optionally end) at the hotel

Planned extensions: meal-break windows, per-mode restrictions, multi-day
balancing (moving a stop between days and re-solving both), and comparing
several candidate routes rather than the first provider answer. Shortest is not
always best: a slightly longer trip to a worthwhile place can win.

### 6.4 Route request flow

1. Frontend sends start + stop IDs/locations.
2. Backend resolves country → provider list.
3. Provider builds the travel-time matrix (cached).
4. OR-Tools picks order and times.
5. Provider returns per-leg geometry and instructions.
6. Frontend draws it; the user can reorder and recalculate.

### 6.5 LLM interface

Model-agnostic: one internal interface (`interpret_preferences`,
`suggest_destinations`, `explain_itinerary`, `regenerate_day`), so the
provider can change without touching the itinerary engine. Check that the
chosen LLM endpoint is reachable from mainland China (§7).

## 7. China connectivity and regulation

A Singapore-hosted app *can* be reachable from China, but choosing Singapore
doesn't guarantee it. Design for three levels:

| Level | Behaviour |
|---|---|
| 1 Normal | Singapore API over HTTPS; direct calls to authorised map providers; AI endpoints verified from China |
| 2 Degraded | Cached trip and POI data; fewer API calls; maps load independently of itinerary content; edits queued locally until sync |
| 3 Offline | Saved schedules, destination details, route summaries, Chinese-language addresses, PDF export |

Already in the scaffold: system fonts only (no Google Fonts), the map shows
markers even if tiles fail to load, the last plan is cached for offline
reading, and the mock provider gives estimates when live providers fail.

Test several international eSIM providers in China: routing, DNS and access to
overseas services differ.

**Regulation.** China's Map Administration Regulations require surveying and
mapping qualifications for some public map services, and require servers
storing internet map data to be in mainland China. Keep these separate:

- this Singapore-hosted planner
- the licensed Chinese provider's map data infrastructure
- the itinerary database
- any user location data

Don't assume map data from Chinese providers can be stored in Singapore. Even
for personal use, check provider terms; get advice before opening it to others.

## 8. Deployment (personal)

One small Singapore VM (for example AWS Lightsail or EC2 in `ap-southeast-1`)
running `docker-compose.yml`: PostGIS, Redis, API, web. Add a reverse proxy
with TLS (Caddy or similar) and nightly `pg_dump` to object storage.

The commercial layout (CloudFront, WAF, ALB, ECS Fargate, RDS, ElastiCache,
Secrets Manager, CloudWatch) is *(deferred)*. The containers move to it unchanged
if the project ever becomes model B/C.

## 9. Rollout

Singapore (home, dev and testing) → China (Shanghai, Beijing, Shenzhen,
Guangzhou, Chengdu) → Japan (Tokyo, Osaka, Kyoto, Fukuoka) → South Korea
(Seoul, Busan) → Thailand (Bangkok, Chiang Mai, Phuket). Vietnam and Indonesia
after provider coverage and terms are validated. For a personal tool, add
markets as trips come up.

## 10. Risks

| Risk | Mitigation |
|---|---|
| AMap/Baidu access from outside China, overseas service terms | Gate 1 must prove both work before more investment |
| Connectivity from China (eSIM routing, blocked overseas services) | Three-level degradation; test on real eSIMs |
| China map data localisation rules | Keep provider map data on provider infrastructure; store IDs only |
| Provider content storage limits | Store IDs and our own data; respect caching/attribution |
| AI hallucinating facts | AI never supplies hours, prices or travel times |
| PWA limitations on iOS | Guarantee offline itinerary only |
| API cost spikes | Cache matrices; MapLibre + free tiles outside China; budget alerts |

## 11. Costs (personal)

The original estimates (S$25–40k feasibility gate, ≈S$300k commercial MVP,
S$4–8k/month operations) assumed a paid team and commercial traffic. They
don't apply to a self-built personal tool. Expect:

- **Hosting:** one small VM plus backups. Low tens of S$ per month.
- **Maps:** Google Maps Platform is usage-based with monthly free usage per
  Essentials SKU (published examples: Dynamic Maps US$7 and Routes Essentials
  US$5 per 1,000 events in the first paid tier). Rendering with MapLibre and
  free tiles avoids map-load charges outside China. Get AMap overseas and Baidu
  pricing from the providers.
- **LLM:** pay-per-use; small at personal volumes.

These are planning assumptions, not quotes.
