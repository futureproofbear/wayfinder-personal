import { load, save, uid } from './store.js';
import { createProvider, providerIdFor } from './providers/mapProvider.js';

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

function defaultStay(type = '') {
  if (/museum|gallery|zoo|aquarium|amusement|theme_park/.test(type)) return 120;
  if (/shopping|market|mall/.test(type)) return 90;
  if (/cafe|coffee|bakery|dessert/.test(type)) return 45;
  return 60;
}

// Arrival/departure times from the day's start, stays and travel legs.
function schedule(d) {
  let t = toMin(d.start || '09:00');
  return d.stops.map((s, i) => {
    const arrive = t;
    const leave = t + (s.stayMin || 60);
    t = leave + Math.round((d.legs[i]?.durationSec || 0) / 60);
    return { arrive, leave };
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
  const body = $('#sheetBody');
  const scroll = body.scrollTop;
  body.innerHTML = {
    results: renderResults,
    place: () => renderPlace(view.place),
    leg: () => renderLeg(view.index),
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
          <button class="name" data-action="focus" data-i="${i}">${esc(s.name)}</button>
          <div class="meta">
            <span>${fmtTime(times[i].arrive)}–${fmtTime(times[i].leave)}</span>
            <select data-action="stay" data-i="${i}" aria-label="Time spent here">
              ${STAYS.map((m) => `<option value="${m}" ${m === s.stayMin ? 'selected' : ''}>${fmtDur(m * 60)}</option>`).join('')}
            </select>
          </div>
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
    case 'focus':
      map?.focus(d.stops[i]);
      return snap('peek');
    case 'leg':
      view = { name: 'leg', index: i };
      map?.highlightLeg(i);
      render();
      $('#sheetBody').scrollTop = 0;
      return;
    case 'back':
      if (view.name === 'place') {
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
