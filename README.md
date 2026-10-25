# Wayfinder (personal)

A map-first trip planner for Asia, built for iPhone (Safari, or installed to the home screen as a PWA).
It's the "Gate 1" technical demonstrator from the Asia Travel Planner architecture: an embedded map,
place discovery, multi-stop day itineraries, route optimisation and in-app directions.

## Features

- **Trips & days**: create a trip (destination, start date, number of days); each day has its own stops.
- **Discover**: search or tap a category (Sights, Food, Cafés, Museums…). Results show rating and open/closed status. Tap ＋ to add.
- **Schedule**: set the day's start time and how long you stay at each stop. Arrival and departure times are computed from real travel times.
- **Routes**: walk, transit or drive, drawn on the map. Tap a leg to get step-by-step directions, including train and bus lines.
- **Optimise order**: reorders the middle stops to minimise travel time. The first and last stops stay fixed (e.g. your hotel).
- **Offline**: trips are stored on the device, and the app shell is cached by a service worker, so your itinerary and its timings open without a connection (the map needs a connection).
- **iPhone**: safe-area aware, a draggable bottom sheet, no zoom on focus, follows dark mode, and installs to the home screen.
- **Fixed times**: a stop can have a set arrival time (📌, e.g. a dinner booking). The schedule waits for it and flags the stop in red if you'd arrive late.
- **Stop actions**: tap a stop for 🅿️ Parking, 🍜 Food nearby, ☕ Coffee, ✨ Ask AI and 🧭 Navigate. In Drive mode, every stop has a 🅿️ button.

### ✨ AI travel assistant (Claude)

- **Digest anything**: paste or photograph bookings, confirmation emails, blog itineraries or notes. The assistant finds each place, adds it to the right day with a fixed time where there's a booking, and puts references in the stop's note. It adds days when needed.
- **Parking**: for a stop you're driving to, it compares the best car park and two alternatives, with walking distance and the cost for your arrival time and stay length. Rates come from a web search, and it says where they came from.
- **Food & nearby**: picks for the meal you'll be there for, using ratings, open status and distance.
- **Plans and edits**: "plan Day 2, relaxed pace", "move the museum to Friday", "where's the nearest EV charger?"
- Suggestions appear as cards pinned on the map, each with ＋ to add. Trip edits apply live.

The assistant uses Claude (Opus 5.5 by default; Sonnet 5.5 or Haiku 5.5 are cheaper) with tools for
Google Places (text and nearby search), Routes, trip editing, and Claude's built-in web search.
Places, ratings and open status come from Google; prices it can't get there come from web search.

## Architecture

```
index.html, styles.css
js/app.js                    UI, state, scheduling (provider-agnostic)
js/store.js                  localStorage persistence
js/providers/mapProvider.js  Map Provider Adapter contract + provider selection by country
js/providers/google.js       Google: Maps JS (render), Places API (New), Routes API
js/ai/agent.js               Claude agent loop (streaming, tool calls, web search, cancel)
js/ai/tools.js               Assistant tools + system prompt (trip edits, Places, Routes, recommendations)
sw.js, manifest.webmanifest  PWA
```

`app.js` never calls Google directly. AMap, Baidu or a Japan transit provider can be added as another
provider implementing the same contract (see the header comment in `mapProvider.js`).

## Setup

1. In Google Cloud Console, enable **Maps JavaScript API**, **Places API (New)** and **Routes API**.
2. `cp config.example.js config.js` and fill in the keys. `config.js` is git-ignored.
   - `googleMapsApiKey`: renders the map (Maps JavaScript API).
   - `googleServicesApiKey`: search and routing (Places API (New) + Routes API). It can be the same key.
3. **Restrict both keys** (Credentials → key → *Website restrictions*) to your domains, e.g.
   `http://localhost:8765/*` and `https://<you>.github.io/*`. Browser keys are visible to anyone who
   opens the site, so the referrer restriction is what protects your billing.
4. **AI assistant (optional)**: in the app, tap ✨ → ⚙︎ Settings and paste a Claude API key from
   [console.anthropic.com](https://console.anthropic.com/settings/keys). The key is stored only in that
   browser's local storage, never in the repo or on the site, and requests go straight from the phone to
   Anthropic. Set a monthly spend limit in the Anthropic Console. Without a key, the stop actions fall
   back to plain nearby searches.

## Run locally

```sh
python -m http.server 8765
# open http://localhost:8765
```

To use it on an iPhone you need HTTPS (geolocation and the service worker require it). Host it on
GitHub Pages, Netlify or Cloudflare Pages. Then in Safari, tap Share → **Add to Home Screen**.

## Known limits

- **China & Vietnam**: Google Maps Platform can't be used there. Trips in those countries show a
  notice and disable search and routing until an AMap/Baidu adapter is built.
- **Japan transit**: Google's Routes API returns no train or bus data for Japan, so transit legs fall
  back to walking times. The "Google Maps ↗" button hands off to the Google Maps app for live train routes.
- Transit can't be optimised directly, so the order is optimised by driving time and each leg is then routed by transit.
- Place details are stored only as needed for the itinerary (ID, name, coordinates). Respect Google's
  caching terms if this becomes a commercial product.
