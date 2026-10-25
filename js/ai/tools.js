// Tools the travel agent can call. They run in the browser against the trip
// state (via `env`, supplied by app.js) and the map provider.

export const SYSTEM_PROMPT = `You are the travel assistant inside Wayfinder, a map-based trip planner the user runs on their iPhone. You help them plan and adjust their trip by reading and editing it with your tools.

How to work:
- Call get_trip before answering anything that depends on the itinerary. Days and stops are numbered from 1.
- Digesting input: when the user pastes or photographs bookings, confirmations, itineraries, blog posts, notes or lists, pull out the places, dates, times and intentions. Find each place with search_places (near the trip's city), then add_stops to the right day in a sensible order. When something happens at a set time (a reservation, a tour, a check-in), give that stop arrive_at so the schedule waits for it. Put other details (booking references, flight numbers, ticket info) in that stop's note. If the dates need more days than the trip has, use add_days. Afterwards, summarise briefly what you added and anything you could not place.
- Only state facts that come from tool results. Never invent places, ratings, opening status, prices or travel times. Ratings, price level, open-now and parking options come from Google results. Anything else, such as parking rates, entry fees or set-menu prices, must come from web_search; mention where it came from and that it can change.
- Driving and parking: when the user is driving or asks about parking, check the destination's own parking options, call search_nearby with types parking_lot and parking_garage near the stop, and use web_search for the rates (per hour, daily caps, evening or weekend rules). Pick the best car park plus 2 alternatives, estimating each cost for the user's arrival time and stay length and noting the walk to the destination. Present them with show_recommendations, best first, with the cost in price_note. Then offer to save the chosen car park in the stop's note.
- Food and nearby: consider when the user will be there (from the schedule in get_trip), such as lunch from 11:30 to 14:00 or dinner from 18:00 to 21:00, along with rating, open status, distance and stated preferences. Present picks with show_recommendations.
- Small additions can just be done. Before removing stops or rewriting a whole day, ask first.
- Your replies are read on a phone: keep them short, in plain sentences with at most a few bullet points, no tables or headings. Use the destination's local currency.`;

// Shared shape for "where" inputs.
const LOCATION = {
  type: 'object',
  description: 'A location: a stop in the trip (day + stop, 1-based), a place_id from earlier results, or lat/lng. Omit to use the area the user is looking at on the map.',
  properties: {
    day: { type: 'integer' },
    stop: { type: 'integer' },
    place_id: { type: 'string' },
    lat: { type: 'number' },
    lng: { type: 'number' },
  },
};

const DEFINITIONS = [
  {
    name: 'get_trip',
    description: 'Get the current trip: destination, dates, and for each day the travel mode, start time and stops with scheduled arrival/departure times, stay length, notes and travel time to the next stop.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_places',
    description: 'Search Google Places by text, e.g. "ramen", "Hotel Gracery Shinjuku", "rooftop bar", "teamLab Planets". Results are biased towards `near` and include place_id, rating, price level, open-now, parking options and distance.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        near: LOCATION,
        radius_m: { type: 'integer', description: 'Bias radius in metres (default 5000).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_nearby',
    description: 'Find the nearest places of specific Google place types, ranked by distance. Useful types: parking_lot, parking_garage, restaurant, cafe, bakery, bar, convenience_store, supermarket, gas_station, electric_vehicle_charging_station, pharmacy, atm, tourist_attraction, museum, park, shopping_mall.',
    input_schema: {
      type: 'object',
      properties: {
        types: { type: 'array', items: { type: 'string' } },
        near: LOCATION,
        radius_m: { type: 'integer', description: 'Search radius in metres (default 800).' },
      },
      required: ['types'],
    },
  },
  {
    name: 'get_travel_time',
    description: 'Travel time and distance between two locations by WALK, TRANSIT or DRIVE.',
    input_schema: {
      type: 'object',
      properties: {
        from: LOCATION,
        to: LOCATION,
        mode: { type: 'string', enum: ['WALK', 'TRANSIT', 'DRIVE'] },
      },
      required: ['from', 'to', 'mode'],
    },
  },
  {
    name: 'add_stops',
    description: 'Add places (by place_id from search results) to a day of the trip. Appends by default, or inserts at `position` (1-based).',
    input_schema: {
      type: 'object',
      properties: {
        day: { type: 'integer' },
        places: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              place_id: { type: 'string' },
              stay_minutes: { type: 'integer' },
              note: { type: 'string', description: 'Short note shown under the stop, e.g. booking ref, parking choice.' },
              arrive_at: { type: 'string', description: 'Fixed arrival time HH:MM (24h) for bookings; the schedule waits until then.' },
            },
            required: ['place_id'],
          },
        },
        position: { type: 'integer' },
      },
      required: ['day', 'places'],
    },
  },
  {
    name: 'edit_stop',
    description: 'Change one stop: stay length, note or fixed arrival time (empty string clears either), move it (to another day and/or position), or remove it.',
    input_schema: {
      type: 'object',
      properties: {
        day: { type: 'integer' },
        stop: { type: 'integer' },
        stay_minutes: { type: 'integer' },
        note: { type: 'string' },
        arrive_at: { type: 'string', description: 'HH:MM (24h)' },
        move_to_day: { type: 'integer' },
        move_to_position: { type: 'integer' },
        remove: { type: 'boolean' },
      },
      required: ['day', 'stop'],
    },
  },
  {
    name: 'edit_day',
    description: "Set a day's travel mode and/or start time (HH:MM, 24h).",
    input_schema: {
      type: 'object',
      properties: {
        day: { type: 'integer' },
        mode: { type: 'string', enum: ['WALK', 'TRANSIT', 'DRIVE'] },
        start_time: { type: 'string' },
      },
      required: ['day'],
    },
  },
  {
    name: 'add_days',
    description: 'Add empty days to the end of the trip.',
    input_schema: {
      type: 'object',
      properties: { count: { type: 'integer' } },
      required: ['count'],
    },
  },
  {
    name: 'show_recommendations',
    description: 'Show suggested places to the user as cards pinned on the map, each with an Add button. Use this for any set of suggestions (parking options, food, sights), best first.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              place_id: { type: 'string' },
              reason: { type: 'string', description: 'One short sentence on why.' },
              price_note: { type: 'string', description: 'Cost info, e.g. "S$2.18/30 min, ~S$9 for 2 h (source: MBS site)".' },
            },
            required: ['place_id', 'reason'],
          },
        },
      },
      required: ['title', 'items'],
    },
  },
].map((t) => ({ ...t, eager_input_streaming: true }));

const STATUS = {
  get_trip: () => '📋 Reading your trip',
  search_places: (i) => `🔎 Searching: ${i.query}`,
  search_nearby: (i) => `📍 Looking nearby: ${i.types.join(', ').replace(/_/g, ' ')}`,
  get_travel_time: (i) => `⏱ Checking ${i.mode.toLowerCase()} time`,
  add_stops: (i) => `➕ Adding ${i.places.length} stop${i.places.length > 1 ? 's' : ''} to Day ${i.day}`,
  edit_stop: (i) => `✏️ ${i.remove ? 'Removing' : 'Updating'} Day ${i.day} stop ${i.stop}`,
  edit_day: (i) => `✏️ Updating Day ${i.day}`,
  add_days: (i) => `➕ Adding ${i.count} day${i.count > 1 ? 's' : ''}`,
};

// Minimal JSON-schema check. Streamed tool inputs aren't validated server-side,
// so required fields and basic types are checked before anything runs.
function check(schema, value, path) {
  const types = {
    object: (v) => v && typeof v === 'object' && !Array.isArray(v),
    array: Array.isArray,
    string: (v) => typeof v === 'string',
    integer: Number.isInteger,
    number: (v) => typeof v === 'number' && Number.isFinite(v),
    boolean: (v) => typeof v === 'boolean',
  };
  if (!types[schema.type](value)) return `${path} should be ${schema.type}`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(', ')}`;
  if (schema.type === 'array') {
    for (let i = 0; i < value.length; i++) {
      const err = check(schema.items, value[i], `${path}[${i}]`);
      if (err) return err;
    }
  }
  if (schema.type === 'object') {
    for (const key of schema.required || []) if (value[key] === undefined) return `${path}.${key} is required`;
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (value[key] === undefined) continue;
      const err = check(sub, value[key], `${path}.${key}`);
      if (err) return err;
    }
  }
  return null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function metres(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

export function createTools(env) {
  const seen = new Map(); // place_id -> place, from every search this conversation

  const remember = (places) => places.forEach((p) => seen.set(p.placeId, p));
  const services = () => {
    const map = env.provider();
    if (!map) throw new Error('Map services are offline.');
    if (env.restricted()) throw new Error("Google search and routing aren't available for this trip's country.");
    return map;
  };
  const dayAt = (n) => {
    const d = env.trip()?.days[n - 1];
    if (!d) throw new Error(`There is no day ${n}.`);
    return d;
  };
  const findPlace = (id) => {
    if (seen.has(id)) return seen.get(id);
    for (const d of env.trip()?.days ?? []) {
      const s = d.stops.find((x) => x.placeId === id);
      if (s) return { ...s, placeId: s.placeId };
    }
    return null;
  };
  const resolve = (loc) => {
    if (loc?.day != null && loc?.stop != null) {
      const s = dayAt(loc.day).stops[loc.stop - 1];
      if (!s) throw new Error(`There is no stop ${loc.stop} on day ${loc.day}.`);
      return s;
    }
    if (loc?.place_id) {
      const p = findPlace(loc.place_id);
      if (!p) throw new Error(`Unknown place_id ${loc.place_id} — search for it first.`);
      return p;
    }
    if (loc?.lat != null && loc?.lng != null) return { lat: loc.lat, lng: loc.lng };
    return env.mapCenter() || env.trip()?.center;
  };
  const brief = (from) => (p) => ({
    place_id: p.placeId,
    name: p.name,
    type: p.type || undefined,
    rating: p.rating,
    reviews: p.ratings,
    price_level: p.priceLevel,
    open_now: p.openNow,
    parking: p.parking?.length ? p.parking : undefined,
    distance_m: from ? metres(from, p) : undefined,
    address: p.address,
  });

  const run = {
    get_trip() {
      const t = env.trip();
      if (!t) return { error: 'No trip yet — ask the user to create one with the Trips button.' };
      return {
        destination: t.name,
        country: t.countryCode,
        start_date: t.startDate || null,
        viewing_day: t.activeDay + 1,
        days: t.days.map((d, i) => {
          const times = env.schedule(d);
          return {
            day: i + 1,
            date: env.dayDate(t, i) || null,
            mode: d.mode,
            start_time: d.start,
            stops: d.stops.map((s, j) => ({
              stop: j + 1,
              name: s.name,
              place_id: s.placeId,
              address: s.address,
              arrive: env.fmtTime(times[j].arrive),
              leave: env.fmtTime(times[j].leave),
              stay_minutes: s.stayMin,
              fixed_time: s.at || undefined,
              late: times[j].late || undefined,
              note: s.note || undefined,
              to_next: d.legs[j]
                ? `${Math.round(d.legs[j].durationSec / 60)} min ${(d.legs[j].fallback || d.mode).toLowerCase()}`
                : undefined,
            })),
          };
        }),
      };
    },

    async search_places({ query, near, radius_m }) {
      const map = services();
      const from = resolve(near);
      const places = await map.searchPlaces(query, { near: from, radiusM: Math.min(radius_m || 5000, 50000), max: 8 });
      remember(places);
      return places.map(brief(from));
    },

    async search_nearby({ types, near, radius_m }) {
      const map = services();
      const from = resolve(near);
      const places = await map.searchNearby(types, from, { radiusM: Math.min(radius_m || 800, 50000), max: 10 });
      remember(places);
      return places.map(brief(from));
    },

    async get_travel_time({ from, to, mode }) {
      const map = services();
      const { legs } = await map.calculateRoute([resolve(from), resolve(to)], mode);
      const leg = legs[0];
      return {
        minutes: Math.round(leg.durationSec / 60),
        distance_m: leg.distanceM,
        mode: leg.fallback || mode,
        ...(leg.fallback ? { note: 'No transit route found; walking time shown.' } : {}),
      };
    },

    add_stops({ day, places, position }) {
      dayAt(day);
      const unknown = places.filter((p) => !findPlace(p.place_id)).map((p) => p.place_id);
      if (unknown.length) throw new Error(`Unknown place_id(s): ${unknown.join(', ')} — use ids from search results.`);
      if (places.some((p) => p.arrive_at && !HHMM.test(p.arrive_at))) throw new Error('arrive_at must be HH:MM (24h).');
      const count = env.addStops(day - 1, places.map((p) => ({
        place: findPlace(p.place_id), stayMin: p.stay_minutes, note: p.note, at: p.arrive_at,
      })), position);
      return { ok: true, day, stops_on_day: count };
    },

    edit_stop({ day, stop, ...changes }) {
      if (!dayAt(day).stops[stop - 1]) throw new Error(`There is no stop ${stop} on day ${day}.`);
      if (changes.move_to_day) dayAt(changes.move_to_day);
      if (changes.arrive_at && !HHMM.test(changes.arrive_at)) throw new Error('arrive_at must be HH:MM (24h).');
      env.editStop(day - 1, stop - 1, changes);
      return { ok: true };
    },

    edit_day({ day, mode, start_time }) {
      dayAt(day);
      if (start_time && !HHMM.test(start_time)) throw new Error('start_time must be HH:MM (24h).');
      env.editDay(day - 1, { mode, start: start_time });
      return { ok: true };
    },

    add_days({ count }) {
      if (count < 1 || count > 14) throw new Error('count must be 1–14.');
      return { ok: true, total_days: env.addDays(count) };
    },

    show_recommendations({ title, items }) {
      const cards = items
        .map((it) => ({ place: findPlace(it.place_id), reason: it.reason, priceNote: it.price_note }))
        .filter((c) => c.place);
      if (!cards.length) throw new Error('None of those place_ids are known — search first.');
      env.recommend(title, cards);
      return { shown: cards.length };
    },
  };

  const byName = Object.fromEntries(DEFINITIONS.map((d) => [d.name, d]));

  return {
    definitions: DEFINITIONS,
    validate(name, input) {
      if (!byName[name]) return `Unknown tool ${name}.`;
      return check(byName[name].input_schema, input, 'input');
    },
    async execute(name, input) {
      const label = STATUS[name]?.(input);
      if (label) env.status(label);
      return run[name](input);
    },
  };
}
