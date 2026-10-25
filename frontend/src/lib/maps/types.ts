import type { LatLng } from "@/lib/api";

export interface MapMarker {
  id: string;
  label: string;
  location: LatLng;
}

/**
 * Frontend half of the map provider adapter. Components only use this
 * interface, never a vendor SDK directly.
 *
 * All coordinates passed in are WGS-84 (what the API returns). Renderers on
 * offset base maps (AMap = GCJ-02, Baidu = BD-09) must convert before drawing.
 */
export interface MapRenderer {
  readonly name: string;
  mount(container: HTMLElement, center: LatLng, zoom: number): Promise<void>;
  setMarkers(markers: MapMarker[]): void;
  setRoute(path: LatLng[]): void;
  fitTo(points: LatLng[]): void;
  destroy(): void;
}
