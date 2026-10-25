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

// AI settings (Claude API key + model) stay on this device only.
const AI_KEY = 'wayfinder.ai';

export function loadAi() {
  try {
    return { apiKey: '', model: 'claude-opus-5-5', ...JSON.parse(localStorage.getItem(AI_KEY)) };
  } catch {
    return { apiKey: '', model: 'claude-opus-5-5' };
  }
}

export function saveAi(ai) {
  try {
    localStorage.setItem(AI_KEY, JSON.stringify(ai));
  } catch {
    // ignore — settings last for this session
  }
}

export const uid = () => Math.random().toString(36).slice(2, 10);
