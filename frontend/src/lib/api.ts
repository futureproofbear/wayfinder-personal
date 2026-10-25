// Types mirror the FastAPI models in backend/app/main.py.

export type TravelMode = "walking" | "driving" | "transit";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface StopIn {
  id: string;
  name?: string;
  location: LatLng;
  visit_min?: number;
  opens?: string;
  closes?: string;
  mandatory?: boolean;
  priority?: number;
}

export interface OptimiseDayRequest {
  country: string;
  mode: TravelMode;
  start: LatLng;
  stops: StopIn[];
  day_start?: string;
  day_end?: string;
  return_to_start?: boolean;
}

export interface Route {
  provider: string;
  mode: TravelMode;
  distance_m: number;
  duration_s: number;
  geometry: LatLng[];
}

export interface OptimiseDayResponse {
  provider: string;
  degraded: boolean;
  stops: { id: string; arrive: string; depart: string; travel_from_prev_min: number }[];
  dropped: string[];
  total_travel_min: number;
  legs: Route[];
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export async function optimiseDay(req: OptimiseDayRequest): Promise<OptimiseDayResponse> {
  const res = await fetch(`${API_URL}/itinerary/optimise-day`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(
      typeof detail.detail === "string" ? detail.detail : `API error ${res.status}`,
    );
  }
  return res.json();
}
