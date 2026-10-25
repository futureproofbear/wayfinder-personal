import OpeningHours from "opening_hours";
import type { LatLng, TravelMode } from "@/lib/api";
import { estimateS, haversineM, type FoundPlace, type Leg, type PlacesProvider } from "./types";

// Keyless provider built on OpenStreetMap services:
//   search  Overpass API (places with OSM opening_hours)
//   routing FOSSGIS OSRM servers (foot and car profiles)
// Public instances with fair-use limits, fine for personal use. Transit has
// no free router, so it falls back to estimates and the Google Maps hand-off.

const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const OSRM: Partial<Record<TravelMode, string>> = {
  walking: "https://routing.openstreetmap.de/routed-foot",
  driving: "https://routing.openstreetmap.de/routed-car",
};
const RADIUS_M = 2500;

// Quick searches map to OSM tags instead of name matching.
const CATEGORY: Record<string, (A: string) => string> = {
  dinner: (A) => `${A}["amenity"~"^(restaurant|food_court)$"];`,
  "hawker centre": (A) => `${A}["amenity"="food_court"];${A}["name"~"hawker|food centre|food center",i];`,
  dessert: (A) => `${A}["amenity"="ice_cream"];${A}["cuisine"~"dessert|ice_cream|cake",i];${A}["shop"~"^(pastry|confectionery)$"];`,
  coffee: (A) => `${A}["amenity"="cafe"];`,
  "cocktail bar": (A) => `${A}["amenity"~"^(bar|pub)$"];`,
  "night view": (A) => `${A}["tourism"~"^(viewpoint|attraction)$"];`,
};

interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\"]/g, "\\$&");
}

function buildQuery(query: string, near: LatLng): string {
  const A = `nwr(around:${RADIUS_M},${near.lat.toFixed(6)},${near.lng.toFixed(6)})`;
  const category = CATEGORY[query.trim().toLowerCase()];
  const q = escapeRegex(query.trim());
  const body = category
    ? category(A)
    : `${A}["name"~"${q}",i][~"^(amenity|shop|tourism|leisure)$"~"."];` +
      `${A}["cuisine"~"${q}",i];`;
  return `[out:json][timeout:20];(${body});out center tags 120;`;
}

/** Today's opening interval from an OSM opening_hours string, if parseable. */
export function todayHoursFromOsm(
  spec: string | undefined,
  at: LatLng,
  now: Date = new Date(),
): FoundPlace["todayHours"] {
  if (!spec) return undefined;
  try {
    const oh = new OpeningHours(spec, {
      lat: at.lat,
      lon: at.lng,
      address: { country_code: "", state: "" },
    });
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
    const toMin = (d: Date) => Math.round((d.getTime() - dayStart.getTime()) / 60000);
    // Look a little past midnight so a 17:00–02:00 bar reads as closing at 26:00.
    const intervals = oh
      .getOpenIntervals(dayStart, new Date(dayEnd.getTime() + 6 * 3600 * 1000))
      .map(([from, to]) => ({ open: toMin(from), close: toMin(to) }))
      .filter((i) => i.open < 24 * 60);
    if (!intervals.length) return { open: 0, close: 0 };
    // Open from midnight through the whole look-ahead window: open all day.
    if (intervals[0].open === 0 && intervals[0].close >= 30 * 60) return { open: 0, close: 24 * 60 };
    const nowMin = toMin(now);
    return intervals.find((i) => i.close > nowMin) ?? intervals[intervals.length - 1];
  } catch {
    return undefined;
  }
}

function describe(tags: Record<string, string>): string | undefined {
  const kind = tags.amenity ?? tags.shop ?? tags.tourism ?? tags.leisure;
  const cuisine = tags.cuisine?.split(";")[0]?.replaceAll("_", " ");
  const label = kind?.replaceAll("_", " ");
  if (cuisine && label) return `${cuisine} ${label}`;
  return label ?? cuisine;
}

function address(tags: Record<string, string>): string {
  return [tags["addr:housenumber"], tags["addr:street"], tags["addr:unit"]]
    .filter(Boolean)
    .join(" ");
}

async function overpass(query: string): Promise<OsmElement[]> {
  let lastError: unknown;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
      });
      if (!res.ok) throw new Error(`Place search failed (${res.status})`);
      return ((await res.json()) as { elements: OsmElement[] }).elements;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Place search failed");
}

export const osmProvider: PlacesProvider = {
  name: "osm",
  attribution: "Places and routes © OpenStreetMap contributors",

  async search(query, near) {
    const elements = await overpass(buildQuery(query, near));
    const now = new Date();
    const seen = new Set<string>();
    return elements
      .flatMap((e) => {
        const lat = e.lat ?? e.center?.lat;
        const lng = e.lon ?? e.center?.lon;
        const tags = e.tags ?? {};
        const name = tags["name:en"] ?? tags.name;
        if (lat == null || lng == null || !name) return [];
        const location = { lat, lng };
        return [
          {
            id: `osm:${e.type}/${e.id}`,
            name,
            address: address(tags),
            location,
            type: describe(tags),
            mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
              `${name} ${lat},${lng}`,
            )}`,
            todayHours: todayHoursFromOsm(tags.opening_hours, location, now),
          } satisfies FoundPlace,
        ];
      })
      .filter((p) => {
        const key = p.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((p) => ({ p, d: haversineM(near, p.location) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 15)
      .map(({ p }) => p);
  },

  async matrix(points, mode) {
    const base = OSRM[mode];
    if (!base) return points.map((a) => points.map((b) => estimateS(a, b, mode)));
    const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
    const res = await fetch(`${base}/table/v1/driving/${coords}?annotations=duration`);
    const data = (await res.json()) as { code: string; durations?: (number | null)[][] };
    if (data.code !== "Ok" || !data.durations) throw new Error("Routing unavailable");
    return data.durations;
  },

  async leg(from, to, mode): Promise<Leg> {
    const base = OSRM[mode];
    if (!base) {
      return { path: [from, to], durationS: estimateS(from, to, mode), distanceM: haversineM(from, to) };
    }
    const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
    const res = await fetch(
      `${base}/route/v1/driving/${coords}?overview=full&geometries=geojson`,
    );
    const data = (await res.json()) as {
      code: string;
      routes?: { duration: number; distance: number; geometry: { coordinates: [number, number][] } }[];
    };
    const r = data.routes?.[0];
    if (data.code !== "Ok" || !r) throw new Error("No route found");
    return {
      path: r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
      durationS: r.duration,
      distanceM: r.distance,
    };
  },
};
