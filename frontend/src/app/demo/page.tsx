"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { optimiseDay, type OptimiseDayResponse, type TravelMode } from "@/lib/api";
import { DEMO_DAYS } from "@/lib/demo";
import type { MapMarker } from "@/lib/maps";

// MapLibre touches window, so render the map client-side only.
const TripMap = dynamic(() => import("@/components/TripMap"), { ssr: false });

const CACHE_KEY = "wayfinder:last-plan";

interface CachedPlan {
  dayKey: string;
  mode: TravelMode;
  plan: OptimiseDayResponse;
  savedAt: string;
}

function readCache(): CachedPlan | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as CachedPlan) : null;
  } catch {
    return null;
  }
}

function writeCache(entry: CachedPlan) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Storage full or blocked: the plan still shows, it just won't survive offline.
  }
}

export default function Home() {
  const [dayKey, setDayKey] = useState(DEMO_DAYS[0].key);
  const [mode, setMode] = useState<TravelMode>("walking");
  const [plan, setPlan] = useState<OptimiseDayResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const day = DEMO_DAYS.find((d) => d.key === dayKey) ?? DEMO_DAYS[0];

  // Restore the last plan so the itinerary is readable offline.
  useEffect(() => {
    const cached = readCache();
    if (!cached) return;
    setDayKey(cached.dayKey);
    setMode(cached.mode);
    setPlan(cached.plan);
    setStatus(`Showing saved plan from ${new Date(cached.savedAt).toLocaleString()}`);
  }, []);

  async function run() {
    setLoading(true);
    setStatus(null);
    try {
      const result = await optimiseDay({ ...day.request, mode });
      setPlan(result);
      writeCache({ dayKey, mode, plan: result, savedAt: new Date().toISOString() });
      if (result.degraded || result.provider === "mock") {
        setStatus(`Routes estimated by "${result.provider}" provider (no live map provider).`);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not reach the planner.");
    } finally {
      setLoading(false);
    }
  }

  const markers: MapMarker[] = useMemo(() => {
    const order = plan ? plan.stops.map((s) => s.id) : day.request.stops.map((s) => s.id);
    const byId = new Map(day.request.stops.map((s) => [s.id, s]));
    const stopMarkers = order.flatMap((id, i) => {
      const s = byId.get(id);
      return s ? [{ id: day.names[id] ?? id, label: String(i + 1), location: s.location }] : [];
    });
    return [{ id: "Start (hotel)", label: "H", location: day.request.start }, ...stopMarkers];
  }, [plan, day]);

  const route = useMemo(() => plan?.legs.flatMap((l) => l.geometry) ?? [], [plan]);

  return (
    <main className="layout">
      <aside className="panel">
        <header>
          <h1>Wayfinder · sample days</h1>
          <p className="muted">Plan a day, optimise the route, see it on the map.</p>
        </header>

        <section className="card">
          <label className="field">
            <span>Day</span>
            <select
              value={dayKey}
              onChange={(e) => {
                setDayKey(e.target.value);
                setPlan(null);
                setStatus(null);
              }}
            >
              {DEMO_DAYS.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.title} · {d.subtitle}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Getting around</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as TravelMode)}>
              <option value="walking">Walking</option>
              <option value="transit">Public transport</option>
              <option value="driving">Driving / taxi</option>
            </select>
          </label>
          <button className="primary" onClick={run} disabled={loading}>
            {loading ? "Optimising…" : "Optimise day"}
          </button>
          {status && <p className="status">{status}</p>}
        </section>

        {plan ? (
          <section className="card">
            <h2>
              {day.title} itinerary{" "}
              <span className="muted">· {plan.total_travel_min} min travelling</span>
            </h2>
            <ol className="itinerary">
              {plan.stops.map((s) => (
                <li key={s.id}>
                  <span className="time">
                    {s.arrive}–{s.depart}
                  </span>
                  <span className="name">{day.names[s.id] ?? s.id}</span>
                  <span className="muted small">{s.travel_from_prev_min} min to get here</span>
                </li>
              ))}
            </ol>
            {plan.dropped.length > 0 && (
              <p className="muted small">
                Didn&apos;t fit today: {plan.dropped.map((id) => day.names[id] ?? id).join(", ")}
              </p>
            )}
          </section>
        ) : (
          <section className="card">
            <h2>Stops</h2>
            <ul className="itinerary">
              {day.request.stops.map((s) => (
                <li key={s.id}>
                  <span className="name">{day.names[s.id] ?? s.id}</span>
                  <span className="muted small">
                    {s.visit_min ?? 60} min
                    {s.opens && s.closes ? ` · open ${s.opens}–${s.closes}` : ""}
                    {s.mandatory ? " · must visit" : ""}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </aside>

      <TripMap
        country={day.request.country}
        center={day.request.start}
        zoom={day.zoom}
        markers={markers}
        route={route}
      />
    </main>
  );
}
