/// <reference types="google.maps" />

// Browser key, restricted by HTTP referrer in Google Cloud. Needs the Maps
// JavaScript API, Places API (New) and Routes API enabled.
export const GOOGLE_MAPS_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";

let loading: Promise<void> | null = null;

/** Load the Maps JavaScript API once, then use google.maps.importLibrary. */
export function loadGoogleMaps(): Promise<void> {
  if (!GOOGLE_MAPS_KEY) return Promise.reject(new Error("No Google Maps API key configured"));
  if (typeof window !== "undefined" && typeof window.google?.maps?.importLibrary === "function") {
    return Promise.resolve();
  }
  loading ??= new Promise<void>((resolve, reject) => {
    const cb = "__wayfinderGoogleReady";
    (window as unknown as Record<string, () => void>)[cb] = () => resolve();
    const script = document.createElement("script");
    const params = new URLSearchParams({
      key: GOOGLE_MAPS_KEY,
      v: "weekly",
      loading: "async",
      callback: cb,
    });
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.onerror = () => {
      loading = null;
      reject(new Error("Could not load Google Maps"));
    };
    document.head.appendChild(script);
  });
  return loading;
}
