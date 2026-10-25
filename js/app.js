import { load, save, uid, loadAi, saveAi } from './store.js';
import { createProvider, providerIdFor } from './providers/mapProvider.js';
import { createTools, SYSTEM_PROMPT } from './ai/tools.js';

// The SDK is loaded lazily from the CDN, so the planner still works offline / without a key.
const loadAgent = () => import('./ai/agent.js');

const cfg = window.WAYFINDER_CONFIG || {};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MODES = {
  WALK: { label: 'Walk', icon: '🚶', gmaps: 'walking' },
  TRANSIT: { label: 'Transit', icon: '🚇', gmaps: 'transit' },
  DRIVE: { label: 'Drive', icon: '🚗', gmaps: 'driving' },
};
const STAYS = [15, 30, 45, 60, 90, 120, 180, 240];
const FALLBACK_CENTER = { lat: 1.2903, lng: 103.8519 }; // Singapore

let state = load();
let map = null; // map provider, null until loaded (or offline)
let view = { name: 'itinerary' };
let results = [];
let liveLegs = []; // route geometry + steps for the active day (not persisted)
let routeSeq = 0;
let watchId = null;
let userPos = null;
let ai = loadAi();
const chats = new Map(); // tripId -> { agent, items } — in memory for this session
let attachments = []; // [{ data (base64 jpeg), url (preview) }]

const trip = () => state.trips.find((t) => t.id === state.activeId) || null;
const day = () => { const t = trip(); return t ? t.days[t.activeDay] : null; };
const restricted = (t = trip()) => !!t && providerIdFor(t.countryCode) !== 'google';
const persist = () => save(state);
const newDay = () => ({ mode: 'WALK', start: '09:00', stops: [], legs: [] });

// ---- Formatting --------------------------------------------------------

function fmtDur(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fmtTime = (min) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function dayDate(t, i) {
  if (!t.startDate) return '';
  const d = new Date(`${t.startDate}T00:00`);
  d.setDate(d.getDate() + i);
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function mealAt(min) {
  if (min < 11 * 60) return 'breakfast';
  if (min < 15 * 60) return 'lunch';
  if (min < 17 * 60 + 30) return 'a snack';
  return 'dinner';
}

const PARKING_LABELS = {
  freeParkingLot: 'free lot', paidParkingLot: 'paid lot', paidGarageParking: 'paid garage',
  freeGarageParking: 'free garage', freeStreetParking: 'free street', paidStreetParking: 'paid street',
  valetParking: 'valet',
};

function defaultStay(type = '') {
  if (/museum|gallery|zoo|aquarium|amusement|theme_park/.test(type)) return 120;
  if (/shopping|market|mall/.test(type)) return 90;
  if (/cafe|coffee|bakery|dessert/.test(type)) return 45;
  return 60;
}

// Arrival/departure times from the day's start, stays and travel legs.
// A stop with a fixed time (`at`, e.g. a booking) waits until then; `late` flags a miss.
function schedule(d) {
  let t = toMin(d.start || '09:00');
  return d.stops.map((s, i) => {
    const fixed = s.at ? toMin(s.at) : null;
    const arrive = fixed != null ? Math.max(t, fixed) : t;
    const late = fixed != null && t > fixed;
    const leave = arrive + (s.stayMin || 60);
    t = leave + Math.round((d.legs[i]?.durationSec || 0) / 60);
    return { arrive, leave, late };
  });
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ---- Bottom sheet ------------------------------------------------------

const sheet = $('#sheet');
const SNAPS = ['peek', 'half', 'full'];
const snapHeight = {
  peek: () => 120,
  half: () => Math.round(innerHeight * 0.46),
  full: () => Math.round(innerHeight - $('.topbar').getBoundingClientRect().bottom - 8),
};

function setSheetHeight(h) {
  sheet.style.height = `${h}px`;
  document.documentElement.style.setProperty('--sheet-h', `${h}px`);
}

function snap(name) {
  sheet.dataset.snap = name;
  setSheetHeight(snapHeight[name]());
}

function mapPadding() {
  return {
    top: Math.round($('.topbar').getBoundingClientRect().bottom + 16),
    bottom: Math.round(sheet.getBoundingClientRect().height + 16),
    left: 40,
    right: 40,
  };
}

function bindSheetDrag() {
  const handle = $('#sheetHandle');
  let startY = null; let startH; let lastY; let lastT; let v = 0; let moved = false;
  handle.addEventListener('pointerdown', (e) => {
    startY = lastY = e.clientY;
    lastT = e.timeStamp;
    startH = sheet.getBoundingClientRect().height;
    moved = false;
    v = 0;
    sheet.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (startY == null) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    v = (e.clientY - lastY) / Math.max(1, e.timeStamp - lastT);
    lastY = e.clientY;
    lastT = e.timeStamp;
    setSheetHeight(Math.min(snapHeight.full(), Math.max(snapHeight.peek(), startH - dy)));
  });
  const end = () => {
    if (startY == null) return;
    startY = null;
    sheet.classList.remove('dragging');
    if (!moved) return snap(SNAPS[(SNAPS.indexOf(sheet.dataset.snap) + 1) % SNAPS.length]);
    const target = sheet.getBoundingClientRect().height - v * 250; // fling bias
    snap(SNAPS.reduce((a, b) => (Math.abs(snapHeight[a]() - target) < Math.abs(snapHeight[b]() - target) ? a : b)));
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  addEventListener('resize', () => snap(sheet.dataset.snap));
}

// ---- Rendering ---------------------------------------------------------

function render() {
  const t = trip();
  $('#tripBtn').textContent = t ? t.name : 'Trips';
  $('#q').placeholder = t ? `Search in ${t.name}` : 'Search places';
  $('#aiBtn').classList.toggle('on', view.name === 'assistant');
  const body = $('#sheetBody');
  const chatOn = view.name === 'assistant';
  $('#chat').hidden = !chatOn;
  body.hidden = chatOn;
  if (chatOn) return renderChat();
  const scroll = body.scrollTop;
  body.innerHTML = {
    results: renderResults,
    place: () => renderPlace(view.place),
    leg: () => renderLeg(view.index),
    stop: () => renderStop(view.index),
  }[view.name]?.() ?? renderItinerary();
  body.scrollTop = scroll;
}

function renderItinerary() {
  const t = trip();
  if (!t) {
    return `<div class="empty"><h2>Plan your first trip</h2>
      <p>Pick a destination, then add places to each day. Routes and timings are worked out for you.</p>
      <button class="btn primary" data-action="trips">Create a trip</button></div>`;
  }
  const d = day();
  const times = schedule(d);
  const totalSec = d.legs.reduce((a, l) => a + (l?.durationSec || 0), 0);
  const totalM = d.legs.reduce((a, l) => a + (l?.distanceM || 0), 0);

  const tabs = t.days.map((_, i) => `
    <button class="tab ${i === t.activeDay ? 'on' : ''}" data-action="day" data-i="${i}">
      <b>Day ${i + 1}</b><small>${esc(dayDate(t, i)) || `${t.days[i].stops.length} stops`}</small>
    </button>`).join('');

  const modes = Object.entries(MODES).map(([k, m]) => `
    <button class="${d.mode === k ? 'on' : ''}" data-action="mode" data-mode="${k}">${m.icon} ${m.label}</button>`).join('');

  const stops = d.stops.map((s, i) => {
    const leg = d.legs[i];
    const legRow = i < d.stops.length - 1 ? `
      <li class="leg"><button data-action="leg" data-i="${i}" ${leg && liveLegs[i] ? '' : 'disabled'}>
        <span>${MODES[leg?.fallback || d.mode].icon}</span>
        ${leg ? `${fmtDur(leg.durationSec)} · ${fmtDist(leg.distanceM)}` : (map && !restricted() ? 'Calculating…' : '—')}
        ${leg && liveLegs[i] ? '<span class="chev">›</span>' : ''}
      </button></li>` : '';
    return `
      <li class="stop">
        <span class="num">${i + 1}</span>
        <div class="info">
          <button class="name" data-action="stop" data-i="${i}">${esc(s.name)}</button>
          <div class="meta">
            <span class="${times[i].late ? 'late' : ''}">${s.at ? '📌 ' : ''}${fmtTime(times[i].arrive)}–${fmtTime(times[i].leave)}${times[i].late ? ` · late for ${esc(s.at)}` : ''}</span>
            <select data-action="stay" data-i="${i}" aria-label="Time spent here">
              ${[...new Set([...STAYS, s.stayMin])].sort((a, b) => a - b).map((m) => `<option value="${m}" ${m === s.stayMin ? 'selected' : ''}>${fmtDur(m * 60)}</option>`).join('')}
            </select>
            ${d.mode === 'DRIVE' ? `<button class="mini" data-action="near" data-kind="parking" data-i="${i}" aria-label="Parking options">🅿️</button>` : ''}
          </div>
          ${s.note ? `<div class="note">${esc(s.note)}</div>` : ''}
        </div>
        <div class="ops">
          <button data-action="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move earlier">↑</button>
          <button data-action="down" data-i="${i}" ${i === d.stops.length - 1 ? 'disabled' : ''} aria-label="Move later">↓</button>
          <button data-action="remove" data-i="${i}" aria-label="Remove">✕</button>
        </div>
      </li>${legRow}`;
  }).join('');

  const notice = restricted(t) ? `<div class="notice">Google Maps can't be used in ${t.countryCode === 'CN' ? 'mainland China' : 'this country'}.
    Search and routing here need the AMap/Baidu adapter, which isn't built yet.</div>` : '';

  return `${notice}
    <div class="tabs">${tabs}<button class="tab add" data-action="add-day" aria-label="Add a day">＋</button></div>
    <div class="row">
      <div class="seg">${modes}</div>
      <label class="start">Start <input type="time" data-action="start" value="${esc(d.start)}"></label>
    </div>
    ${d.mode === 'TRANSIT' && t.countryCode === 'JP' ? `<p class="hint">Google's API has no train/bus data for Japan, so legs
      fall back to walking times. Use "Google Maps ↗" for live train routes (a Japan transit provider such as NAVITIME would plug into the adapter).</p>` : ''}
    ${d.stops.length ? `
      <ol class="stops">${stops}</ol>
      <p class="summary">${d.stops.length} stops · ${fmtDur(totalSec)} travelling · ${fmtDist(totalM)} · done by ${fmtTime(times.at(-1).leave)}</p>
      <div class="row actions">
        <button class="btn" data-action="optimise" ${d.stops.length < 4 || !map ? 'disabled' : ''}>✨ Optimise order</button>
        <button class="btn" data-action="gmaps" ${d.stops.length < 2 ? 'disabled' : ''}>Google Maps ↗</button>
      </div>
      ${d.stops.length < 4 ? '<p class="hint">Optimise needs 4+ stops — the first and last stay fixed (e.g. your hotel).</p>' : ''}`
    : '<div class="empty small"><p>No stops yet. Search above or tap a category, then press ＋ to add places to this day.</p></div>'}`;
}

function placeMeta(p) {
  return [
    p.type,
    p.rating ? `★ ${p.rating.toFixed(1)} (${p.ratings ?? 0})` : '',
    p.priceLevel || '',
    p.parking?.length ? `🅿️ ${p.parking.map((k) => PARKING_LABELS[k] || k).join(', ')}` : '',
    p.openNow === true ? '<span class="open">Open now</span>' : p.openNow === false ? '<span class="closed">Closed</span>' : '',
  ].filter(Boolean).map((x) => (x.startsWith('<span') ? x : esc(x))).join(' · ');
}

function renderResults() {
  const d = day();
  return `
    <div class="hd"><button class="link" data-action="back">‹ Itinerary</button><span class="muted">${results.length} results</span></div>
    ${results.length ? '' : '<p class="empty small">Nothing found here. Try another search or move the map.</p>'}
    <ul class="results">${results.map((p, i) => {
      const added = d?.stops.some((s) => s.placeId === p.placeId);
      return `<li>
        <span class="dotnum">${i + 1}</span>
        <button class="res" data-action="place" data-i="${i}">
          <b>${esc(p.name)}</b><small>${placeMeta(p)}</small><small class="addr">${esc(p.address)}</small>
        </button>
        <button class="add ${added ? 'done' : ''}" data-action="add" data-i="${i}" aria-label="Add to day">${added ? '✓' : '＋'}</button>
      </li>`;
    }).join('')}</ul>`;
}

function renderPlace(p) {
  const t = trip();
  return `
    <div class="hd"><button class="link" data-action="back">‹ Results</button></div>
    <h2 class="title">${esc(p.name)}</h2>
    <p class="muted">${placeMeta(p)}</p>
    <p>${esc(p.address)}</p>
    <div class="row actions">
      <button class="btn primary" data-action="add">＋ Add to Day ${t ? t.activeDay + 1 : ''}</button>
      ${p.mapsUri ? `<a class="btn" href="${esc(p.mapsUri)}" target="_blank" rel="noopener">Reviews & photos ↗</a>` : ''}
    </div>`;
}

function renderStop(i) {
  const t = trip();
  const d = day();
  const s = d?.stops[i];
  if (!s) return '<div class="hd"><button class="link" data-action="back">‹ Itinerary</button></div>';
  const time = schedule(d)[i];
  const nav = `https://www.google.com/maps/dir/?${new URLSearchParams({
    api: '1', destination: `${s.lat},${s.lng}`, travelmode: MODES[d.mode].gmaps,
  })}`;
  return `
    <div class="hd"><button class="link" data-action="back">‹ Itinerary</button>
      <span class="muted">Day ${t.activeDay + 1} · stop ${i + 1}</span></div>
    <h2 class="title">${esc(s.name)}</h2>
    <p class="muted">${fmtTime(time.arrive)}–${fmtTime(time.leave)} · ${esc(s.address)}</p>
    ${s.note ? `<p class="note big">${esc(s.note)}</p>` : ''}
    <div class="tiles">
      <button class="tile" data-action="near" data-kind="parking" data-i="${i}">🅿️<b>Parking</b><small>Options & cost</small></button>
      <button class="tile" data-action="near" data-kind="food" data-i="${i}">🍜<b>Food nearby</b><small>For ${mealAt(time.arrive)}</small></button>
      <button class="tile" data-action="near" data-kind="coffee" data-i="${i}">☕<b>Coffee & snacks</b><small>Close by</small></button>
      <button class="tile" data-action="ask-stop" data-i="${i}">✨<b>Ask AI</b><small>About this stop</small></button>
    </div>
    <div class="row actions"><a class="btn" href="${esc(nav)}" target="_blank" rel="noopener">🧭 Navigate here ↗</a></div>`;
}

function renderLeg(i) {
  const d = day();
  const leg = liveLegs[i];
  const from = d.stops[i];
  const to = d.stops[i + 1];
  if (!leg || !from || !to) return '<div class="hd"><button class="link" data-action="back">‹ Itinerary</button></div>';
  const steps = leg.steps.map((s) => {
    if (s.transit) {
      const tr = s.transit;
      return `<li class="step transit">
        <span class="line" style="${tr.color ? `background:${esc(tr.color)}` : ''}">${esc(tr.line)}</span>
        <div><b>${esc(tr.vehicle || 'Transit')}${tr.headsign ? ` towards ${esc(tr.headsign)}` : ''}</b>
        <small>${esc(tr.from)} → ${esc(tr.to)}${tr.stops ? ` · ${tr.stops} stops` : ''}</small></div></li>`;
    }
    return `<li class="step"><span class="ico">${s.mode === 'DRIVE' ? '🚗' : '🚶'}</span>
      <div>${esc(s.text || 'Continue')}<small>${fmtDist(s.distanceM)}</small></div></li>`;
  }).join('');
  return `
    <div class="hd"><button class="link" data-action="back">‹ Itinerary</button>
      <span class="muted">${MODES[leg.fallback || d.mode].icon} ${fmtDur(leg.durationSec)} · ${fmtDist(leg.distanceM)}</span></div>
    <h2 class="title">${esc(from.name)} → ${esc(to.name)}</h2>
    ${leg.fallback ? '<p class="hint">No transit option found for this hop — showing walking directions.</p>' : ''}
    <ol class="steps">${steps}</ol>`;
}

// ---- Behaviour ---------------------------------------------------------

async function refreshRoute(fit = false) {
  const d = day();
  liveLegs = [];
  map?.clearRoute();
  render();
  if (!map) return;
  map.setStops(d ? d.stops : [], (i) => {
    view = { name: 'itinerary' };
    render();
    snap('half');
    document.querySelectorAll('.stop')[i]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  if (!d) return;
  if (fit && d.stops.length) map.fitTo(d.stops, mapPadding());
  if (d.stops.length < 2 || restricted()) return;

  const seq = ++routeSeq;
  try {
    const r = await map.calculateRoute(d.stops, d.mode);
    if (seq !== routeSeq) return;
    liveLegs = r.legs;
    d.legs = r.legs.map(({ durationSec, distanceM, fallback }) => ({ durationSec, distanceM, fallback }));
    persist();
    map.drawRoute(r.legs, d.mode);
  } catch (err) {
    if (seq === routeSeq) toast(`Route unavailable: ${err.message}`);
  }
  if (seq === routeSeq) render();
}

// Any edit to a day's stops or mode invalidates its cached leg timings.
function changed() {
  day().legs = [];
  persist();
  refreshRoute();
}

async function search(q) {
  q = q.trim();
  if (!q) return;
  if (!map) return toast('Map is offline — search needs a connection');
  if (restricted()) return toast('Search for this country needs the AMap/Baidu adapter');
  $('#q').blur();
  try {
    results = await map.searchPlaces(q, { near: map.getCenter() });
  } catch (err) {
    return toast(`Search failed: ${err.message}`);
  }
  view = { name: 'results' };
  snap('half');
  map.showResults(results, (i) => openPlace(results[i]));
  if (results.length) map.fitTo(results, mapPadding());
  render();
  $('#sheetBody').scrollTop = 0;
}

function openPlace(p) {
  view = { name: 'place', place: p };
  if (sheet.dataset.snap === 'peek') snap('half');
  map?.focus(p);
  render();
}

function addStop(p) {
  const t = trip();
  if (!t) return openTrips();
  const d = day();
  if (d.stops.some((s) => s.placeId === p.placeId)) return toast('Already on this day');
  d.stops.push({
    id: uid(), placeId: p.placeId, name: p.name, address: p.address,
    lat: p.lat, lng: p.lng, stayMin: defaultStay(p.primaryType),
  });
  toast(`Added to Day ${t.activeDay + 1}`);
  changed();
}

async function optimise() {
  const d = day();
  toast('Optimising…');
  try {
    const { order } = await map.calculateRoute(d.stops, d.mode, { optimise: true });
    const unchanged = order.every((v, i) => v === i);
    d.stops = order.map((i) => d.stops[i]);
    changed();
    toast(unchanged ? 'Already the most efficient order' : 'Stops reordered to cut travel time');
  } catch (err) {
    toast(`Optimise failed: ${err.message}`);
  }
}

function gmapsUrl(d) {
  const ll = (s) => `${s.lat},${s.lng}`;
  const p = new URLSearchParams({
    api: '1',
    origin: ll(d.stops[0]),
    destination: ll(d.stops.at(-1)),
    travelmode: MODES[d.mode].gmaps,
  });
  if (d.stops.length > 2) p.set('waypoints', d.stops.slice(1, -1).map(ll).join('|'));
  return `https://www.google.com/maps/dir/?${p}`;
}

function locate() {
  if (!navigator.geolocation) return toast('Location is not available on this device');
  let first = true;
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition((pos) => {
    const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    userPos = p;
    map?.showUser(p);
    if (first) { first = false; map?.panTo(p); }
  }, (err) => {
    toast(err.code === 1 ? 'Location permission denied (Settings › Safari › Location)' : 'Could not get your location');
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
}

function switchTrip() {
  const t = trip();
  view = { name: 'itinerary' };
  results = [];
  map?.clearResults();
  if (t && map) {
    if (t.viewport) map.fitViewport(t.viewport);
    else map.panTo(t.center);
  }
  refreshRoute(true);
}

// ---- Trip edits made by the assistant ---------------------------------

let refreshTimer;
// Show the day the assistant just edited, and re-route once edits settle.
function touched(dayIdx) {
  const t = trip();
  t.days[dayIdx].legs = [];
  t.activeDay = dayIdx;
  persist();
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshRoute(), 250);
}

function aiAddStops(dayIdx, items, position) {
  const d = trip().days[dayIdx];
  const stops = items.map(({ place, stayMin, note, at }) => ({
    id: uid(), placeId: place.placeId, name: place.name, address: place.address,
    lat: place.lat, lng: place.lng,
    stayMin: Math.max(5, Math.round(stayMin ?? defaultStay(place.primaryType))),
    ...(note ? { note } : {}),
    ...(at ? { at } : {}),
  }));
  const at = position ? Math.min(Math.max(position - 1, 0), d.stops.length) : d.stops.length;
  d.stops.splice(at, 0, ...stops);
  touched(dayIdx);
  return d.stops.length;
}

function aiEditStop(dayIdx, stopIdx, ch) {
  const t = trip();
  const d = t.days[dayIdx];
  const s = d.stops[stopIdx];
  if (ch.stay_minutes) s.stayMin = Math.max(5, Math.round(ch.stay_minutes));
  if (ch.note !== undefined) s.note = ch.note || undefined;
  if (ch.arrive_at !== undefined) s.at = ch.arrive_at || undefined;
  if (ch.remove) {
    d.stops.splice(stopIdx, 1);
  } else if (ch.move_to_day || ch.move_to_position) {
    const targetIdx = (ch.move_to_day ?? dayIdx + 1) - 1;
    const target = t.days[targetIdx];
    d.stops.splice(stopIdx, 1);
    const at = ch.move_to_position ? Math.min(Math.max(ch.move_to_position - 1, 0), target.stops.length) : target.stops.length;
    target.stops.splice(at, 0, s);
    if (targetIdx !== dayIdx) target.legs = [];
    return touched(targetIdx);
  }
  touched(dayIdx);
}

function aiEditDay(dayIdx, { mode, start }) {
  const d = trip().days[dayIdx];
  if (mode) d.mode = mode;
  if (start) d.start = start;
  touched(dayIdx);
}

function aiAddDays(n) {
  const t = trip();
  for (let i = 0; i < n; i++) t.days.push(newDay());
  persist();
  return t.days.length;
}

// ---- Assistant chat ----------------------------------------------------

const aiReady = () => !!ai.apiKey;

function chatFor(tripId) {
  if (!chats.has(tripId)) chats.set(tripId, { agent: null, items: [] });
  return chats.get(tripId);
}

const currentChat = () => chatFor(state.activeId || 'none');

function pushItem(item) {
  currentChat().items.push(item);
  queueChatRender();
}

async function getAgent() {
  const chat = currentChat();
  if (!chat.agent) {
    const { TripAgent } = await loadAgent();
    const env = {
      trip, provider: () => map, restricted: () => restricted(),
      mapCenter: () => map?.getCenter(), schedule, fmtTime, dayDate,
      addStops: aiAddStops, editStop: aiEditStop, editDay: aiEditDay, addDays: aiAddDays,
      recommend: showCards,
      status: (text) => pushItem({ kind: 'status', text }),
    };
    chat.agent = new TripAgent({
      apiKey: ai.apiKey,
      baseURL: ai.baseURL,
      model: ai.model,
      system: SYSTEM_PROMPT,
      tools: createTools(env),
      countryCode: trip()?.countryCode,
      onEvent: onAgentEvent,
    });
  }
  return chat.agent;
}

function onAgentEvent(e) {
  const items = currentChat().items;
  const last = items.at(-1);
  if (e.type === 'text') {
    if (last?.kind === 'assistant') last.text += e.delta;
    else items.push({ kind: 'assistant', text: e.delta });
  } else if (e.type === 'status') {
    items.push({ kind: 'status', text: e.text });
  } else if (e.type === 'error') {
    items.push({ kind: 'error', text: e.text });
  }
  queueChatRender();
}

function showCards(title, cards) {
  pushItem({ kind: 'cards', title, cards });
  const k = currentChat().items.length - 1;
  const places = cards.map((c) => c.place);
  map?.showResults(places, (j) => {
    document.querySelector(`.cards[data-k="${k}"] .card[data-j="${j}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  map?.fitTo(places, mapPadding());
}

function contextNote() {
  const t = trip();
  const now = new Date().toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const parts = [`Now: ${now}.`];
  if (t) parts.push(`Trip: ${t.name} (${t.countryCode || '?'}), viewing day ${t.activeDay + 1}.`);
  if (userPos) parts.push(`User's current location: ${userPos.lat.toFixed(5)},${userPos.lng.toFixed(5)}.`);
  return `[App context] ${parts.join(' ')}`;
}

async function askAI(text, images = []) {
  text = text.trim();
  if (!text && !images.length) return;
  if (!aiReady()) return openSettings('Add your Claude API key to use the assistant.');
  if (!trip()) return openTrips();
  view = { name: 'assistant' };
  if (sheet.dataset.snap === 'peek') snap('half');
  render();
  let agent;
  try {
    agent = await getAgent();
  } catch {
    return pushItem({ kind: 'error', text: "Couldn't load the AI library — check your connection." });
  }
  if (agent.busy) return toast('Still working on the last request…');
  pushItem({ kind: 'user', text, images: images.map((a) => a.url) });
  const content = [
    ...images.map((a) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: a.data } })),
    { type: 'text', text: text || 'Please read the attached images and add what you find to my trip.' },
    { type: 'text', text: contextNote() },
  ];
  renderComposer();
  try {
    await agent.send(content);
  } catch (err) {
    pushItem({ kind: 'error', text: err.message });
  }
  renderComposer();
}

// Stop-level shortcuts. With a Claude key they ask the assistant; without one,
// they fall back to a plain nearby search.
async function nearby(kind, i) {
  const t = trip();
  const d = day();
  const s = d.stops[i];
  const time = schedule(d)[i];
  const when = `around ${fmtTime(time.arrive)}${t.startDate ? ` on ${dayDate(t, t.activeDay)}` : ''}`;
  if (aiReady()) {
    const prompts = {
      parking: `I'm driving to Day ${t.activeDay + 1} stop ${i + 1} (${s.name}), arriving ${when} and staying about ${fmtDur(s.stayMin * 60)}. Where should I park? Give the best car park and 2 alternatives with walking distance and what parking will cost for my stay.`,
      food: `Recommend places for ${mealAt(time.arrive)} near Day ${t.activeDay + 1} stop ${i + 1} (${s.name}) — I'll be there ${when}.`,
      coffee: `Recommend good coffee or snack spots close to Day ${t.activeDay + 1} stop ${i + 1} (${s.name}), ${when}.`,
    };
    return askAI(prompts[kind]);
  }
  if (!map) return toast('Map is offline');
  const types = { parking: ['parking_lot', 'parking_garage'], food: ['restaurant'], coffee: ['cafe', 'bakery'] }[kind];
  try {
    results = await map.searchNearby(types, s, { radiusM: 800, max: 12 });
  } catch (err) {
    return toast(`Search failed: ${err.message}`);
  }
  view = { name: 'results' };
  snap('half');
  map.showResults(results, (j) => openPlace(results[j]));
  if (results.length) map.fitTo([s, ...results], mapPadding());
  render();
  $('#sheetBody').scrollTop = 0;
  toast('Tip: add a Claude key in ⚙︎ Settings for AI picks with prices');
}

// Tiny, safe markdown: escape first, then links, bold and bullet lists.
function md(src) {
  const inline = (s) => esc(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">link</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const out = [];
  let list = null;
  for (const raw of src.split('\n')) {
    const line = raw.replace(/^#+\s*/, '');
    const bullet = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)/);
    if (bullet) {
      (list ||= []).push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('');
}

function renderCards(item, k) {
  const added = new Set(day()?.stops.map((s) => s.placeId));
  return `<div class="cards" data-k="${k}"><div class="cards-title">${esc(item.title)}</div>
    ${item.cards.map((c, j) => `
      <div class="card" data-j="${j}">
        <span class="dotnum">${j + 1}</span>
        <div class="body">
          <b>${esc(c.place.name)}</b>
          <small>${placeMeta(c.place)}</small>
          ${c.priceNote ? `<div class="price">💲 ${esc(c.priceNote)}</div>` : ''}
          <p>${esc(c.reason)}</p>
        </div>
        <div class="cardops">
          <button class="add ${added.has(c.place.placeId) ? 'done' : ''}" data-action="card-add" data-k="${k}" data-j="${j}" aria-label="Add to day">${added.has(c.place.placeId) ? '✓' : '＋'}</button>
          ${c.place.mapsUri ? `<a class="mini" href="${esc(c.place.mapsUri)}" target="_blank" rel="noopener" aria-label="Open in Google Maps">↗</a>` : ''}
        </div>
      </div>`).join('')}</div>`;
}

const SUGGESTIONS = [
  ['📋', 'Paste a booking, itinerary or list of places', ''],
  ['🗓', 'Plan this day for me', 'Plan this day for me: a relaxed pace, top sights and good local food.'],
  ['🅿️', 'Driving: where to park at each stop?', "I'm driving this day. For each stop, where should I park and what will it cost?"],
  ['🍜', 'Lunch & dinner near my stops', 'Suggest lunch and dinner spots near where I will be at those times today.'],
];

function renderChat() {
  const log = $('#chatLog');
  const { items, agent } = currentChat();
  if (!items.length) {
    log.innerHTML = `<div class="chat-empty">
      <h3>✨ Travel assistant</h3>
      <p>Paste or photograph bookings, itineraries or notes and I'll add them to your trip. Ask about parking, food, or how to plan a day.</p>
      ${SUGGESTIONS.map(([icon, label, prompt], i) => `<button class="suggest" data-action="suggest" data-i="${i}">${icon} ${esc(label)}</button>`).join('')}
      ${aiReady() ? '' : '<button class="btn primary" data-action="settings">Add Claude API key</button>'}
    </div>`;
    return;
  }
  // Follow new output only if the user hasn't scrolled up to read something.
  const follow = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.innerHTML = items.map((it, k) => {
    if (it.kind === 'user') {
      return `<div class="msg user">${it.images?.length ? `<div class="thumbs">${it.images.map((u) => `<img src="${u}" alt="">`).join('')}</div>` : ''}${esc(it.text)}</div>`;
    }
    if (it.kind === 'assistant') return `<div class="msg assistant">${md(it.text)}</div>`;
    if (it.kind === 'status') return `<div class="msg status">${esc(it.text)}</div>`;
    if (it.kind === 'error') return `<div class="msg error">${esc(it.text)}</div>`;
    if (it.kind === 'cards') return renderCards(it, k);
    return '';
  }).join('') + (agent?.busy ? '<div class="typing"><span></span><span></span><span></span></div>' : '');
  if (follow) log.scrollTop = log.scrollHeight;
}

let chatFrame = 0;
function queueChatRender() {
  if (view.name !== 'assistant' || chatFrame) return;
  chatFrame = requestAnimationFrame(() => { chatFrame = 0; renderChat(); });
}

function renderComposer() {
  const busy = !!currentChat().agent?.busy;
  const send = $('#sendBtn');
  send.textContent = busy ? '■' : '↑';
  send.setAttribute('aria-label', busy ? 'Stop' : 'Send');
  send.classList.toggle('stop', busy);
  $('#attachments').innerHTML = attachments.map((a, i) =>
    `<span class="att"><img src="${a.url}" alt=""><button type="button" data-att="${i}" aria-label="Remove">✕</button></span>`).join('');
  queueChatRender();
}

// Downscale photos before sending: smaller uploads, fewer tokens.
async function toJpeg(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.85);
  return { url, data: url.split(',')[1] };
}

function bindChat() {
  const input = $('#chatInput');
  const grow = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    input.style.overflowY = input.scrollHeight > 160 ? 'auto' : 'hidden'; // long pastes scroll
  };
  input.addEventListener('input', grow);
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const agent = currentChat().agent;
    if (agent?.busy) return agent.cancel();
    const text = input.value;
    const imgs = attachments;
    if (!text.trim() && !imgs.length) return;
    input.value = '';
    attachments = [];
    grow();
    askAI(text, imgs);
  });
  $('#attachBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', async (e) => {
    const files = [...e.target.files].slice(0, 5 - attachments.length);
    e.target.value = '';
    for (const f of files) {
      try { attachments.push(await toJpeg(f)); } catch { toast(`Couldn't read ${f.name}`); }
    }
    renderComposer();
  });
  $('#attachments').addEventListener('click', (e) => {
    const b = e.target.closest('[data-att]');
    if (b) { attachments.splice(Number(b.dataset.att), 1); renderComposer(); }
  });
}

// ---- Settings dialog ---------------------------------------------------

async function openSettings(message = '') {
  const f = $('#settingsForm');
  const { MODELS } = await loadAgent().catch(() => ({ MODELS: { [ai.model]: ai.model } }));
  f.model.innerHTML = Object.entries(MODELS).map(([id, label]) =>
    `<option value="${id}" ${id === ai.model ? 'selected' : ''}>${esc(label)}</option>`).join('');
  f.apiKey.value = ai.apiKey;
  $('#settingsMsg').textContent = message;
  $('#settingsDialog').showModal();
}

function bindSettings() {
  $('#settingsForm').addEventListener('submit', (e) => {
    const action = e.submitter?.value;
    if (action === 'clear') {
      e.preventDefault();
      chats.delete(state.activeId);
      toast('Chat cleared');
      render();
      return;
    }
    if (action !== 'save') return;
    const f = e.target;
    ai = { ...ai, apiKey: f.apiKey.value.trim(), model: f.model.value };
    saveAi(ai);
    chats.forEach((c) => { c.agent = null; }); // rebuild agents with the new key/model
    render();
  });
}

// ---- Trips dialog ------------------------------------------------------

const dialog = $('#tripDialog');
const form = $('#tripForm');

function renderTripList() {
  $('#tripList').innerHTML = state.trips.length
    ? state.trips.map((t) => `
      <li class="${t.id === state.activeId ? 'on' : ''}">
        <button type="button" class="pick" data-trip="${t.id}">
          <b>${esc(t.name)}</b>
          <small>${t.days.length} day${t.days.length > 1 ? 's' : ''}${t.startDate ? ` · from ${esc(dayDate(t, 0))}` : ''}</small>
        </button>
        <button type="button" class="del" data-del="${t.id}" aria-label="Delete ${esc(t.name)}">🗑</button>
      </li>`).join('')
    : '<li class="muted">No trips yet.</li>';
}

function openTrips() {
  renderTripList();
  $('#tripErr').textContent = '';
  if (!form.start.value) form.start.value = new Date().toISOString().slice(0, 10);
  dialog.showModal();
}

function bindTripDialog() {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) return dialog.close(); // tap on backdrop
    const pick = e.target.closest('[data-trip]');
    const del = e.target.closest('[data-del]');
    const dest = e.target.closest('[data-dest]');
    if (pick) {
      state.activeId = pick.dataset.trip;
      persist();
      dialog.close();
      switchTrip();
    } else if (del) {
      const t = state.trips.find((x) => x.id === del.dataset.del);
      if (!confirm(`Delete "${t.name}"?`)) return;
      state.trips = state.trips.filter((x) => x !== t);
      if (state.activeId === t.id) state.activeId = state.trips[0]?.id ?? null;
      persist();
      renderTripList();
      switchTrip();
    } else if (dest) {
      form.dest.value = dest.dataset.dest;
    }
  });

  form.addEventListener('submit', async (e) => {
    if (e.submitter?.value !== 'create') return;
    e.preventDefault();
    const btn = e.submitter;
    const err = $('#tripErr');
    err.textContent = '';
    if (!map) { err.textContent = 'You need to be online to create a trip.'; return; }
    btn.disabled = true;
    btn.textContent = 'Finding…';
    try {
      const place = await map.geocode(form.dest.value);
      if (!place) throw new Error('Destination not found — try adding the country.');
      const days = Math.max(1, Math.min(30, Number(form.days.value) || 1));
      const t = {
        id: uid(),
        name: place.name,
        countryCode: place.countryCode,
        center: { lat: place.lat, lng: place.lng },
        viewport: place.viewport,
        startDate: form.start.value,
        activeDay: 0,
        days: Array.from({ length: days }, newDay),
      };
      state.trips.unshift(t);
      state.activeId = t.id;
      persist();
      form.dest.value = '';
      dialog.close();
      switchTrip();
      snap('half');
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Create trip';
    }
  });
}

// ---- Wiring ------------------------------------------------------------

function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled || el.tagName === 'SELECT' || el.tagName === 'INPUT') return;
  const t = trip();
  const d = day();
  const i = Number(el.dataset.i);
  switch (el.dataset.action) {
    case 'trips': return openTrips();
    case 'cat': return search(el.dataset.q);
    case 'day':
      t.activeDay = i;
      persist();
      view = { name: 'itinerary' };
      return refreshRoute(true);
    case 'add-day':
      t.days.push(newDay());
      t.activeDay = t.days.length - 1;
      persist();
      return refreshRoute();
    case 'mode':
      if (d.mode === el.dataset.mode) return;
      d.mode = el.dataset.mode;
      return changed();
    case 'up':
    case 'down': {
      const j = el.dataset.action === 'up' ? i - 1 : i + 1;
      [d.stops[i], d.stops[j]] = [d.stops[j], d.stops[i]];
      return changed();
    }
    case 'remove':
      d.stops.splice(i, 1);
      return changed();
    case 'stop':
      view = { name: 'stop', index: i };
      map?.focus(d.stops[i]);
      render();
      $('#sheetBody').scrollTop = 0;
      return;
    case 'near': return nearby(el.dataset.kind, i);
    case 'ask-stop':
      view = { name: 'assistant' };
      render();
      $('#chatInput').value = `About Day ${t.activeDay + 1} stop ${i + 1} (${d.stops[i].name}): `;
      return $('#chatInput').focus();
    case 'ai':
      if (view.name === 'assistant') { view = { name: 'itinerary' }; map?.clearResults(); return render(); }
      if (!aiReady()) return openSettings('Add your Claude API key to use the assistant.');
      view = { name: 'assistant' };
      if (sheet.dataset.snap === 'peek') snap('half');
      return render();
    case 'settings': return openSettings();
    case 'suggest': {
      const [, , prompt] = SUGGESTIONS[i];
      if (prompt) return askAI(prompt);
      $('#chatInput').placeholder = 'Paste your booking, itinerary or notes here…';
      return $('#chatInput').focus();
    }
    case 'card-add': {
      const item = currentChat().items[Number(el.dataset.k)];
      return addStop(item.cards[Number(el.dataset.j)].place);
    }
    case 'leg':
      view = { name: 'leg', index: i };
      map?.highlightLeg(i);
      render();
      $('#sheetBody').scrollTop = 0;
      return;
    case 'back':
      if (view.name === 'place' && results.length) {
        view = { name: 'results' };
      } else {
        view = { name: 'itinerary' };
        map?.clearResults();
        map?.highlightLeg(-1);
      }
      return render();
    case 'place': return openPlace(results[i]);
    case 'add': return addStop(view.name === 'place' ? view.place : results[i]);
    case 'optimise': return optimise();
    case 'gmaps': return window.open(gmapsUrl(d), '_blank', 'noopener');
  }
}

function onChange(e) {
  const el = e.target;
  const d = day();
  if (!d) return;
  if (el.dataset.action === 'stay') {
    d.stops[Number(el.dataset.i)].stayMin = Number(el.value);
  } else if (el.dataset.action === 'start') {
    d.start = el.value || '09:00';
  } else {
    return;
  }
  persist();
  render();
}

async function init() {
  bindSheetDrag();
  bindTripDialog();
  bindChat();
  bindSettings();
  $('#chatInput').addEventListener('focus', () => snap('full'));
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  $('#tripBtn').addEventListener('click', openTrips);
  $('#locateBtn').addEventListener('click', locate);
  $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); search($('#q').value); });
  window.gm_authFailure = () => toast('Google rejected the Maps API key — check its restrictions');

  snap('half');
  render();

  if (!cfg.googleMapsApiKey) {
    toast('Add your Google API keys to config.js');
  } else {
    try {
      const provider = createProvider('google', cfg);
      await provider.renderMap($('#map'), { center: trip()?.center || FALLBACK_CENTER, zoom: 13 });
      map = provider;
    } catch {
      toast('Offline — showing your saved itinerary');
    }
  }

  if (!state.trips.length) openTrips();
  else refreshRoute(true);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
