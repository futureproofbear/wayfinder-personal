/// <reference types="google.maps" />
import type { LatLng, TravelMode } from "@/lib/api";
import { loadGoogleMaps } from "@/lib/maps/googleLoader";

// Browser-side Google Places (New) and Routes calls via the Maps JS API, so the
// planner can run as a static site with no backend.

export interface FoundPlace {
  id: string;
  name: string;
  address: string;
  location: LatLng;
  rating?: number;
  ratingCount?: number;
  priceLevel?: string;
  type?: string;
  mapsUrl?: string;
  /** Today's hours as minutes since midnight; close may exceed 1440. */
  todayHours?: { open: number; close: number };
}

const MODES: Record<TravelMode, google.maps.TravelModeString> = {
  walking: "WALKING",
  driving: "DRIVING",
  transit: "TRANSIT",
};

function todayHours(
  hours: google.maps.places.OpeningHours | null | undefined,
  now: Date,
): FoundPlace["todayHours"] {
  const periods = hours?.periods;
  if (!periods?.length) return undefined;
  const day = now.getDay();
  // Open 24 hours is a single period opening Sunday 00:00 with no close.
  if (periods.length === 1 && !periods[0].close) return { open: 0, close: 24 * 60 };
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const todays = periods
    .filter((p) => p.open.day === day)
    .map((p) => {
      const open = p.open.hour * 60 + p.open.minute;
      let close = p.close ? p.close.hour * 60 + p.close.minute : 24 * 60;
      if (p.close && p.close.day !== day) close += 24 * 60;
      return { open, close };
    });
  if (!todays.length) return { open: 0, close: 0 }; // closed today
  // Prefer the period that is open now or opens next (e.g. dinner service).
  return todays.find((t) => t.close > nowMin) ?? todays[todays.length - 1];
}

export async function searchPlaces(query: string, near: LatLng): Promise<FoundPlace[]> {
  await loadGoogleMaps();
  const { Place } = (await google.maps.importLibrary("places")) as google.maps.PlacesLibrary;
  const { places } = await Place.searchByText({
    textQuery: query,
    fields: [
      "id",
      "displayName",
      "formattedAddress",
      "location",
      "rating",
      "userRatingCount",
      "priceLevel",
      "primaryTypeDisplayName",
      "googleMapsURI",
      "regularOpeningHours",
    ],
    locationBias: { center: near, radius: 3000 },
    maxResultCount: 10,
  });
  const now = new Date();
  return places
    .filter((p) => p.location)
    .map((p) => ({
      id: p.id,
      name: p.displayName ?? "Unnamed place",
      address: p.formattedAddress ?? "",
      location: { lat: p.location!.lat(), lng: p.location!.lng() },
      rating: p.rating ?? undefined,
      ratingCount: p.userRatingCount ?? undefined,
      priceLevel: p.priceLevel ?? undefined,
      type: p.primaryTypeDisplayName ?? undefined,
      mapsUrl: p.googleMapsURI ?? undefined,
      todayHours: todayHours(p.regularOpeningHours, now),
    }));
}

/** durations[i][j] in seconds; null where Google found no route. */
export async function travelMatrix(
  points: LatLng[],
  mode: TravelMode,
): Promise<(number | null)[][]> {
  await loadGoogleMaps();
  const { RouteMatrix } = (await google.maps.importLibrary(
    "routes",
  )) as google.maps.RoutesLibrary;
  const { matrix } = await RouteMatrix.computeRouteMatrix({
    origins: points,
    destinations: points,
    travelMode: MODES[mode],
    fields: ["durationMillis", "condition"],
  });
  return matrix.rows.map((row, i) =>
    row.items.map((item, j) =>
      i === j ? 0 : item.durationMillis != null ? item.durationMillis / 1000 : null,
    ),
  );
}

export interface Leg {
  path: LatLng[];
  durationS: number;
  distanceM: number;
}

export async function routeLeg(from: LatLng, to: LatLng, mode: TravelMode): Promise<Leg> {
  await loadGoogleMaps();
  const { Route } = (await google.maps.importLibrary("routes")) as google.maps.RoutesLibrary;
  const { routes } = await Route.computeRoutes({
    origin: from,
    destination: to,
    travelMode: MODES[mode],
    fields: ["path", "durationMillis", "distanceMeters"],
  });
  const r = routes?.[0];
  if (!r) throw new Error("No route found");
  return {
    path: (r.path ?? []).map((p) => ({ lat: p.lat, lng: p.lng })),
    durationS: (r.durationMillis ?? 0) / 1000,
    distanceM: r.distanceMeters ?? 0,
  };
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
    travelmode: mode === "transit" ? "transit" : mode,
  });
  if (stops.length > 1) params.set("waypoints", stops.slice(0, -1).map(fmt).join("|"));
  return `https://www.google.com/maps/dir/?${params}`;
}
