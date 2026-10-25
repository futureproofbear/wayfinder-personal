import { GoogleRenderer } from "./google";
import { GOOGLE_MAPS_KEY } from "./googleLoader";
import { MapLibreRenderer } from "./maplibre";
import type { MapRenderer } from "./types";

export type { MapMarker, MapRenderer } from "./types";

/**
 * Pick a renderer for the country being viewed.
 *
 * Google Maps when a browser key is configured, except mainland China and
 * Vietnam (prohibited territories). MapLibre otherwise. Gate 1 target for CN
 * is the AMap JS API with Baidu as fallback; until then CN uses MapLibre,
 * which draws the API's WGS-84 geometry consistently.
 */
export function createRenderer(country: string): MapRenderer {
  const c = country.toUpperCase();
  if (GOOGLE_MAPS_KEY && c !== "CN" && c !== "VN") return new GoogleRenderer();
  return new MapLibreRenderer();
}
