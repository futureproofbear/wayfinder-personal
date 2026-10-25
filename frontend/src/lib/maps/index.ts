import { MapLibreRenderer } from "./maplibre";
import type { MapRenderer } from "./types";

export type { MapMarker, MapRenderer } from "./types";

/**
 * Pick a renderer for the country being viewed.
 *
 * Gate 1 target: AMap JS API (overseas endpoint) for CN, with Baidu as
 * fallback. Until those renderers exist, every country uses MapLibre, which
 * draws the WGS-84 geometry from the API on a WGS-84 base map, so it stays
 * consistent even in China.
 */
export function createRenderer(country: string): MapRenderer {
  void country; // TODO(gate-1): return AMapRenderer / BaiduRenderer for "CN".
  return new MapLibreRenderer();
}
