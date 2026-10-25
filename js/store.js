// Trips live in localStorage so the itinerary is available offline.
const KEY = 'wayfinder.v1';
const EMPTY = { trips: [], activeId: null };

export function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || structuredClone(EMPTY);
  } catch {
    return structuredClone(EMPTY);
  }
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Private mode / quota — the session keeps working in memory.
  }
}

export const uid = () => Math.random().toString(36).slice(2, 10);
