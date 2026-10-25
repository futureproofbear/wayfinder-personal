import type { LatLng, TravelMode } from "@/lib/api";

export interface FoundPlace {
  id: string;
  name: string;
  address: string;
  location: LatLng;
  rating?: number;
  ratingCount?: number;
  type?: string;
  mapsUrl?: string;
  /** Today's hours as minutes since midnight; close may exceed 1440. */
  todayHours?: { open: number; close: number };
}

export interface Leg {
  path: LatLng[];
  durationS: number;
  distanceM: number;
}

/** Browser-side place search and routing, so the app runs as a static site. */
export interface PlacesProvider {
  readonly name: string;
  /** Short label for the attribution line. */
  readonly attribution: string;
  search(query: string, near: LatLng): Promise<FoundPlace[]>;
  /** Travel time in seconds between every pair of points; null if no route. */
  matrix(points: LatLng[], mode: TravelMode): Promise<(number | null)[][]>;
  leg(from: LatLng, to: LatLng, mode: TravelMode): Promise<Leg>;
}

/** Deep link that opens turn-by-turn navigation in the Google Maps app. */
export function googleMapsDirectionsUrl(
  origin: LatLng,
  stops: LatLng[],
  mode: TravelMode,
): string {
  const fmt = (p: LatLng) => `${p.lat},${p.lng}`;
  const params = new URLSearchParams({
    api: "1",
    origin: fmt(origin),
    destination: fmt(stops[stops.length - 1]),
    travelmode: mode,
  });
  if (stops.length > 1) params.set("waypoints", stops.slice(0, -1).map(fmt).join("|"));
  return `https://www.google.com/maps/dir/?${params}`;
}

export function haversineM(a: LatLng, b: LatLng): number {
  const R = 6371008.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Straight-line estimate in seconds when routing is unavailable. */
export function estimateS(a: LatLng, b: LatLng, mode: TravelMode): number {
  const metres = haversineM(a, b) * 1.3;
  const speed = { walking: 1.3, driving: 8, transit: 6 }[mode];
  return metres / speed + (mode === "transit" && metres > 0 ? 300 : 0);
}
