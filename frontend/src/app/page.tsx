"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { LatLng, TravelMode } from "@/lib/api";
import type { MapMarker } from "@/lib/maps";
import { GOOGLE_MAPS_KEY } from "@/lib/maps/googleLoader";
import { googleProvider } from "@/lib/places/google";
import { osmProvider } from "@/lib/places/osm";
import { estimateS, googleMapsDirectionsUrl, type FoundPlace } from "@/lib/places/types";
import { fmtTime, MAX_STOPS, phaseOf, planOuting, type Plan } from "@/lib/planner";

const TripMap = dynamic(() => import("@/components/TripMap"), { ssr: false });

// Google Maps when a browser key is configured, otherwise keyless OpenStreetMap.
const provider = GOOGLE_MAPS_KEY ? googleProvider : osmProvider;

const STORE_KEY = "wayfinder:tonight";
const DEFAULT_START: LatLng = { lat: 1.2834, lng: 103.8607 }; // Marina Bay, Singapore
const QUICK = ["Dinner", "Hawker centre", "Dessert", "Coffee", "Cocktail bar", "Night view"];

interface Stop extends FoundPlace {
  visitMin: number;
}

interface Saved {
  start: LatLng;
  startLabel: string;
  stops: Stop[];
  mode: TravelMode;
  plan: Plan | null;
  route: LatLng[];
}

function defaultVisit(p: FoundPlace): number {
  const phase = phaseOf(`${p.type ?? ""} ${p.name}`);
  return phase === 1 ? 75 : phase === 3 ? 60 : 40;
}

function nowMin(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function hoursLabel(h: FoundPlace["todayHours"]): string | null {
  if (!h) return null;
  if (h.open === 0 && h.close === 0) return "Closed today";
  if (h.open === 0 && h.close === 24 * 60) return "Open 24 hours";
  return `Today ${fmtTime(h.open)}–${fmtTime(h.close)}`;
}

export default function Tonight() {
  const [start, setStart] = useState<LatLng>(DEFAULT_START);
  const [startLabel, setStartLabel] = useState("Marina Bay (default)");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoundPlace[]>([]);
  const [stops, setStops] = useState<Stop[]>([]);
  const [mode, setMode] = useState<TravelMode>("walking");
  const [startTime, setStartTime] = useState(() => fmtTime(Math.ceil(nowMin() / 15) * 15));
  const [plan, setPlan] = useState<Plan | null>(null);
  const [route, setRoute] = useState<LatLng[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  // Restore the last evening so it survives reloads and patchy signal.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw) as Saved;
        setStart(s.start);
        setStartLabel(s.startLabel);
        setStops(s.stops);
        setMode(s.mode);
        setPlan(s.plan);
        setRoute(s.route);
      }
    } catch {
      // Ignore unreadable storage.
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (!restored) return;
    try {
      const s: Saved = { start, startLabel, stops, mode, plan, route };
      localStorage.setItem(STORE_KEY, JSON.stringify(s));
    } catch {
      // Storage blocked: still works, just not persisted.
    }
  }, [restored, start, startLabel, stops, mode, plan, route]);

  function invalidate() {
    setPlan(null);
    setRoute([]);
  }

  function locateMe() {
    if (!navigator.geolocation) {
      setNote("This browser can't share location.");
      return;
    }
    setBusy("Finding you…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setStart({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setStartLabel("My location");
        invalidate();
        setBusy(null);
      },
      (err) => {
        setNote(`Location unavailable: ${err.message}`);
        setBusy(null);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  async function runSearch(q: string) {
    if (!q.trim()) return;
    setQuery(q);
    setBusy("Searching…");
    setNote(null);
    try {
      const found = await provider.search(q, start);
      setResults(found);
      if (!found.length) setNote(`Nothing found for "${q}" nearby. Try another search.`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Search failed");
    } finally {
      setBusy(null);
    }
  }

  function addStop(p: FoundPlace) {
    if (stops.some((s) => s.id === p.id)) return;
    if (stops.length >= MAX_STOPS) {
      setNote(`Up to ${MAX_STOPS} stops for an evening.`);
      return;
    }
    setStops([...stops, { ...p, visitMin: defaultVisit(p) }]);
    invalidate();
  }

  function updateStop(id: string, patch: Partial<Stop>) {
    setStops(stops.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    invalidate();
  }

  function removeStop(id: string) {
    setStops(stops.filter((s) => s.id !== id));
    invalidate();
  }

  async function planEvening() {
    if (!stops.length) return;
    setBusy("Planning your evening…");
    setNote(null);
    try {
      await planAndDraw();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Planning failed");
    } finally {
      setBusy(null);
    }
  }

  async function planAndDraw() {
    const points = [start, ...stops.map((s) => s.location)];
    let matrix: (number | null)[][];
    try {
      matrix = (await provider.matrix(points, mode)).map((row) =>
        row.map((s) => (s == null ? null : s / 60)),
      );
    } catch {
      matrix = points.map((a) => points.map((b) => estimateS(a, b, mode) / 60));
      setNote("Live travel times unavailable; using distance estimates.");
    }
    const [h, m] = startTime.split(":").map(Number);
    const result = planOuting(
      stops.map((s) => ({
        id: s.id,
        visitMin: s.visitMin,
        open: s.todayHours?.open,
        close: s.todayHours?.close,
        phase: phaseOf(`${s.type ?? ""} ${s.name}`),
      })),
      matrix,
      h * 60 + m,
    );
    setPlan(result);

    // Draw real paths for the chosen order; straight lines if a leg fails.
    const byId = new Map(stops.map((s) => [s.id, s.location]));
    const ordered = [start, ...result.order.map((o) => byId.get(o.id)!)];
    const legs = await Promise.all(
      ordered.slice(1).map((to, i) =>
        provider
          .leg(ordered[i], to, mode)
          .then((l) => l.path)
          .catch(() => [ordered[i], to]),
      ),
    );
    setRoute(legs.flat());
  }

  const markers: MapMarker[] = useMemo(() => {
    const ids = plan ? plan.order.map((o) => o.id) : stops.map((s) => s.id);
    const byId = new Map(stops.map((s) => [s.id, s]));
    const stopMarkers = ids.flatMap((id, i) => {
      const s = byId.get(id);
      return s ? [{ id: s.name, label: String(i + 1), location: s.location }] : [];
    });
    const preview = results
      .filter((r) => !byId.has(r.id))
      .map((r) => ({ id: r.name, label: "·", location: r.location }));
    return [{ id: startLabel, label: "★", location: start }, ...stopMarkers, ...preview];
  }, [plan, stops, results, start, startLabel]);

  const byId = new Map(stops.map((s) => [s.id, s]));
  const navUrl =
    plan && plan.order.length
      ? googleMapsDirectionsUrl(
          start,
          plan.order.map((o) => byId.get(o.id)!.location),
          mode,
        )
      : null;

  return (
    <main className="layout">
      <aside className="panel">
        <header>
          <h1>Wayfinder · Tonight</h1>
          <p className="muted small">
            Find places, let it order them around opening hours, then go.{" "}
            <Link href="/demo">Sample days</Link>
          </p>
        </header>


        <section className="card">
          <div className="row">
            <span className="small">
              Start: <strong>{startLabel}</strong>
            </span>
            <button className="ghost" onClick={locateMe}>
              📍 Use my location
            </button>
          </div>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              runSearch(query);
            }}
          >
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search: ramen, rooftop bar, chilli crab…"
              enterKeyHint="search"
            />
            <button type="submit" disabled={!!busy}>
              Search
            </button>
          </form>
          <div className="chips">
            {QUICK.map((q) => (
              <button key={q} className="chip" onClick={() => runSearch(q)}>
                {q}
              </button>
            ))}
          </div>
          {results.length > 0 && (
            <ul className="results">
              {results.map((p) => {
                const added = stops.some((s) => s.id === p.id);
                return (
                  <li key={p.id}>
                    <div>
                      <div className="name">{p.name}</div>
                      <div className="muted small">
                        {[
                          p.rating ? `★ ${p.rating.toFixed(1)} (${p.ratingCount ?? 0})` : null,
                          p.type,
                          hoursLabel(p.todayHours),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                    <button className="ghost" onClick={() => addStop(p)} disabled={added}>
                      {added ? "Added" : "Add"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {stops.length > 0 && (
          <section className="card">
            <h2>Your evening</h2>
            {plan ? (
              <>
                <ol className="itinerary">
                  {plan.order.map((o) => {
                    const s = byId.get(o.id)!;
                    return (
                      <li key={o.id}>
                        <span className="time">
                          {fmtTime(o.arriveMin)}–{fmtTime(o.departMin)}
                          {o.late && <span className="late"> · may be closed</span>}
                        </span>
                        <span className="name">{s.name}</span>
                        <span className="muted small">
                          {Math.round(o.travelMin)} min {mode}
                          {o.waitMin >= 5 ? ` · wait ${Math.round(o.waitMin)} min to open` : ""}
                        </span>
                      </li>
                    );
                  })}
                </ol>
                <p className="muted small">
                  {Math.round(plan.totalTravelMin)} min travelling in total.
                </p>
                {navUrl && (
                  <a className="primary button" href={navUrl} target="_blank" rel="noreferrer">
                    Navigate in Google Maps
                  </a>
                )}
                <button className="ghost" onClick={invalidate}>
                  Edit stops
                </button>
              </>
            ) : (
              <>
                <ul className="stops">
                  {stops.map((s) => (
                    <li key={s.id}>
                      <div>
                        <div className="name">{s.name}</div>
                        <div className="muted small">{hoursLabel(s.todayHours) ?? s.address}</div>
                      </div>
                      <div className="stepper">
                        <button
                          aria-label="Shorter"
                          onClick={() =>
                            updateStop(s.id, { visitMin: Math.max(15, s.visitMin - 15) })
                          }
                        >
                          −
                        </button>
                        <span className="small">{s.visitMin}m</span>
                        <button
                          aria-label="Longer"
                          onClick={() => updateStop(s.id, { visitMin: s.visitMin + 15 })}
                        >
                          +
                        </button>
                        <button aria-label="Remove" onClick={() => removeStop(s.id)}>
                          ✕
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="row">
                  <label className="field grow">
                    <span>Leave at</span>
                    <input
                      type="time"
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                    />
                  </label>
                  <label className="field grow">
                    <span>Getting around</span>
                    <select
                      value={mode}
                      onChange={(e) => {
                        setMode(e.target.value as TravelMode);
                        invalidate();
                      }}
                    >
                      <option value="walking">Walking</option>
                      <option value="transit">Public transport</option>
                      <option value="driving">Taxi / car</option>
                    </select>
                  </label>
                </div>
                <button className="primary" onClick={planEvening} disabled={!!busy}>
                  Plan my evening
                </button>
              </>
            )}
          </section>
        )}

        {(busy || note) && <p className="status">{busy ?? note}</p>}
        <p className="muted small">{provider.attribution}</p>
      </aside>

      <TripMap country="SG" center={start} zoom={14} markers={markers} route={route} />
    </main>
  );
}
