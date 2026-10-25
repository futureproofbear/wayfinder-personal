import maplibregl from "maplibre-gl";
import type { LatLng } from "@/lib/api";
import type { MapMarker, MapRenderer } from "./types";

// MapLibre only renders; it needs a tile service. OpenFreeMap is free and
// keyless, which suits a personal deployment. Swap via NEXT_PUBLIC_MAP_STYLE_URL.
const STYLE_URL =
  process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "https://tiles.openfreemap.org/styles/liberty";

const ROUTE_SOURCE = "wayfinder-route";

export class MapLibreRenderer implements MapRenderer {
  readonly name = "maplibre";
  private map?: maplibregl.Map;
  private markers: maplibregl.Marker[] = [];
  private pendingRoute: LatLng[] = [];

  async mount(container: HTMLElement, center: LatLng, zoom: number) {
    this.map = new maplibregl.Map({
      container,
      style: STYLE_URL,
      center: [center.lng, center.lat],
      zoom,
    });
    this.map.addControl(new maplibregl.NavigationControl(), "top-right");
    this.map.addControl(
      new maplibregl.GeolocateControl({ trackUserLocation: true }),
      "top-right",
    );
    // Don't block on the style: if tiles are unreachable (common on restricted
    // networks) markers must still show. The route layer is added once the
    // style loads, which may be never.
    this.map.once("load", () => {
      this.map?.addSource(ROUTE_SOURCE, {
        type: "geojson",
        data: this.routeGeoJson(this.pendingRoute),
      });
      this.map?.addLayer({
        id: ROUTE_SOURCE,
        type: "line",
        source: ROUTE_SOURCE,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": "#0f766e", "line-width": 4, "line-opacity": 0.85 },
      });
    });
  }

  setMarkers(markers: MapMarker[]) {
    this.markers.forEach((m) => m.remove());
    if (!this.map) return;
    this.markers = markers.map((m) => {
      const el = document.createElement("div");
      el.className = "wf-marker";
      el.textContent = m.label;
      return new maplibregl.Marker({ element: el })
        .setLngLat([m.location.lng, m.location.lat])
        .setPopup(new maplibregl.Popup({ offset: 16 }).setText(m.id))
        .addTo(this.map!);
    });
  }

  setRoute(path: LatLng[]) {
    this.pendingRoute = path;
    const source = this.map?.getSource(ROUTE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    source?.setData(this.routeGeoJson(path));
  }

  fitTo(points: LatLng[]) {
    if (!this.map || points.length === 0) return;
    const bounds = new maplibregl.LngLatBounds();
    points.forEach((p) => bounds.extend([p.lng, p.lat]));
    this.map.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 600 });
  }

  destroy() {
    this.map?.remove();
    this.map = undefined;
  }

  private routeGeoJson(path: LatLng[]): GeoJSON.Feature<GeoJSON.LineString> {
    return {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: path.map((p) => [p.lng, p.lat]) },
    };
  }
}
