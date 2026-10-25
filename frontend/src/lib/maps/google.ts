/// <reference types="google.maps" />
import type { LatLng } from "@/lib/api";
import { loadGoogleMaps } from "./googleLoader";
import type { MapMarker, MapRenderer } from "./types";

/** Google Maps JavaScript API renderer. Not for mainland China. */
export class GoogleRenderer implements MapRenderer {
  readonly name = "google";
  private map?: google.maps.Map;
  private markers: google.maps.marker.AdvancedMarkerElement[] = [];
  private line?: google.maps.Polyline;
  private pending: { markers: MapMarker[]; route: LatLng[] } = { markers: [], route: [] };

  async mount(container: HTMLElement, center: LatLng, zoom: number) {
    await loadGoogleMaps();
    const { Map } = (await google.maps.importLibrary("maps")) as google.maps.MapsLibrary;
    await google.maps.importLibrary("marker");
    this.map = new Map(container, {
      center,
      zoom,
      // Advanced markers need a map ID; DEMO_MAP_ID works without setup.
      mapId: process.env.NEXT_PUBLIC_GOOGLE_MAP_ID ?? "DEMO_MAP_ID",
      gestureHandling: "greedy",
      clickableIcons: false,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
    });
    this.line = new google.maps.Polyline({
      map: this.map,
      strokeColor: "#0f766e",
      strokeOpacity: 0.9,
      strokeWeight: 5,
    });
    this.setMarkers(this.pending.markers);
    this.setRoute(this.pending.route);
  }

  setMarkers(markers: MapMarker[]) {
    this.pending.markers = markers;
    if (!this.map) return;
    this.markers.forEach((m) => (m.map = null));
    this.markers = markers.map((m) => {
      const el = document.createElement("div");
      el.className = "wf-marker";
      el.textContent = m.label;
      return new google.maps.marker.AdvancedMarkerElement({
        map: this.map,
        position: m.location,
        content: el,
        title: m.id,
      });
    });
  }

  setRoute(path: LatLng[]) {
    this.pending.route = path;
    this.line?.setPath(path);
  }

  fitTo(points: LatLng[]) {
    if (!this.map || points.length === 0) return;
    if (points.length === 1) {
      this.map.panTo(points[0]);
      return;
    }
    const bounds = new google.maps.LatLngBounds();
    points.forEach((p) => bounds.extend(p));
    this.map.fitBounds(bounds, 60);
  }

  getCenter(): LatLng | null {
    const c = this.map?.getCenter();
    return c ? { lat: c.lat(), lng: c.lng() } : null;
  }

  destroy() {
    this.markers.forEach((m) => (m.map = null));
    this.line?.setMap(null);
    this.map = undefined;
  }
}
