# Roadmap

Development is staged so the riskiest parts (China maps and connectivity) are
proven before anything else is built on them.

## Gate 1 — Technical feasibility (current)

Goal: prove the hard parts work end to end.

- [x] Repo scaffold: Next.js PWA, FastAPI, PostGIS schema, docker-compose
- [x] `MapProvider` adapter interface + provider registry with fallback
- [x] Mock provider for offline/degraded mode and tests
- [x] Google adapter (Places API (New), Geocoding, Routes, Route Matrix)
- [x] AMap Web Service adapter (search, geocode, walking/driving routes)
- [x] Baidu adapter (search, geocode, walking/driving/transit routes)
- [x] WGS-84 ⇄ GCJ-02 ⇄ BD-09 conversions with round-trip tests
- [x] OR-Tools day planner: time windows, mandatory/optional stops, travel cap
- [x] `POST /itinerary/optimise-day` returning schedule + leg geometry
- [x] Map-first UI with MapLibre, sample Singapore and Shanghai days
- [x] Offline: last plan cached in the browser; markers render without tiles
- [x] Tonight mode: browser-only planner with Google Maps or keyless
      OpenStreetMap (Overpass + OSRM), opening-hours ordering, evening-order
      preference, Google Maps hand-off; static export for any host
- [ ] Verify Google, AMap and Baidu adapters against live keys
- [ ] AMap JS renderer (overseas endpoint) for CN, Baidu JS renderer as fallback
- [ ] AMap transit routing (needs city codes)
- [ ] Native matrix endpoints (AMap `/v3/distance`, Baidu `routematrix`) to cut calls
- [ ] Basic LLM itinerary generation (brief → preferences → candidate stops)
- [ ] Tests from China on international eSIMs (app, API, map providers, LLM)

**Exit criterion:** a working Shanghai day and a Singapore day, planned and
drawn with live providers, usable from China on an international eSIM.

## Gate 2 — Personal MVP

- Trip CRUD on PostGIS (trips, days, items), auth with passkeys or email link
- Multi-day planning; move a stop between days and re-optimise both
- Destination store with confidence scores and provider refs
- AI recommendations with feedback loop (save / remove / visit / rate)
- Service worker: offline itinerary, queued edits, PDF export
- Calendar export (ICS), shareable read-only trip links for the travel group
- Redis caching of route matrices and searches
- Deploy to a Singapore VM with TLS and nightly backups

## Later

- Offline map tiles for saved areas
- Meal-break windows, per-mode restrictions, candidate-route comparison
- Collaborative editing for the travel group
- More markets: Vietnam and Indonesia once providers are validated
- *(Only if it becomes a product)* bookings and affiliate links, SaaS
  multi-tenancy, the commercial AWS layout
