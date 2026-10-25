"use client";

import { useEffect, useRef } from "react";
import type { LatLng } from "@/lib/api";
import { createRenderer, type MapMarker, type MapRenderer } from "@/lib/maps";

interface Props {
  country: string;
  center: LatLng;
  zoom: number;
  markers: MapMarker[];
  route: LatLng[];
}

export default function TripMap({ country, center, zoom, markers, route }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const renderer = useRef<MapRenderer | null>(null);
  const latest = useRef({ markers, route });
  latest.current = { markers, route };

  // Recreate the renderer when the country (and so possibly the provider) changes.
  useEffect(() => {
    if (!container.current) return;
    const r = createRenderer(country);
    let cancelled = false;
    r.mount(container.current, center, zoom).then(() => {
      if (cancelled) return;
      renderer.current = r;
      const { markers, route } = latest.current;
      r.setMarkers(markers);
      r.setRoute(route);
      r.fitTo(route.length ? route : markers.map((m) => m.location));
    });
    return () => {
      cancelled = true;
      renderer.current = null;
      r.destroy();
    };
    // center/zoom only seed the initial view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country]);

  useEffect(() => {
    const r = renderer.current;
    if (!r) return;
    r.setMarkers(markers);
    r.setRoute(route);
    r.fitTo(route.length ? route : markers.map((m) => m.location));
  }, [markers, route]);

  return <div ref={container} className="map" />;
}
