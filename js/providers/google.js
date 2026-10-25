// Google Maps Platform adapter.
// Map rendering: Maps JavaScript API. Search: Places API (New). Routing: Routes API.

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';
const NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

const PLACE_FIELDS = [
  'id', 'displayName', 'formattedAddress', 'location', 'rating', 'userRatingCount',
  'primaryType', 'primaryTypeDisplayName', 'currentOpeningHours.openNow', 'googleMapsUri',
  'priceLevel', 'parkingOptions',
].map((f) => `places.${f}`).join(',');

const PRICE_LEVELS = {
  PRICE_LEVEL_FREE: 'free',
  PRICE_LEVEL_INEXPENSIVE: '$',
  PRICE_LEVEL_MODERATE: '$$',
  PRICE_LEVEL_EXPENSIVE: '$$$',
  PRICE_LEVEL_VERY_EXPENSIVE: '$$$$',
};

const ROUTE_FIELDS = [
  'routes.optimizedIntermediateWaypointIndex',
  'routes.legs.duration',
  'routes.legs.distanceMeters',
  'routes.legs.polyline.encodedPolyline',
  'routes.legs.steps.distanceMeters',
  'routes.legs.steps.travelMode',
  'routes.legs.steps.navigationInstruction',
  'routes.legs.steps.transitDetails',
].join(',');

const LINE_COLORS = { WALK: '#0d9488', TRANSIT: '#7c3aed', DRIVE: '#2563eb' };

let bootstrapped = false;

// Google's official dynamic library loader (adds google.maps.importLibrary).
function bootstrap(key) {
  if (bootstrapped) return;
  bootstrapped = true;
  /* eslint-disable */
  (g=>{var h,a,k,p="The Google Maps JavaScript API",c="google",l="importLibrary",q="__ib__",m=document,b=window;b=b[c]||(b[c]={});var d=b.maps||(b.maps={}),r=new Set,e=new URLSearchParams,u=()=>h||(h=new Promise(async(f,n)=>{await (a=m.createElement("script"));e.set("libraries",[...r]+"");for(k in g)e.set(k.replace(/[A-Z]/g,t=>"_"+t[0].toLowerCase()),g[k]);e.set("callback",c+".maps."+q);a.src=`https://maps.${c}apis.com/maps/api/js?`+e;d[q]=f;a.onerror=()=>h=n(Error(p+" could not load."));a.nonce=m.querySelector("script[nonce]")?.nonce||"";m.head.append(a)}));d[l]?console.warn(p+" only loads once. Ignoring:",g):d[l]=(f,...n)=>r.add(f)&&u().then(()=>d[l](f,...n))})({ key, v: 'weekly' });
  /* eslint-enable */
}

const toLatLng = (p) => ({ lat: p.lat, lng: p.lng });
const waypoint = (s) => ({ location: { latLng: { latitude: s.lat, longitude: s.lng } } });

function normPlace(p) {
  return {
    placeId: p.id,
    name: p.displayName?.text || 'Unnamed place',
    address: p.formattedAddress || '',
    lat: p.location?.latitude,
    lng: p.location?.longitude,
    type: p.primaryTypeDisplayName?.text || '',
    primaryType: p.primaryType || '',
    rating: p.rating,
    ratings: p.userRatingCount,
    openNow: p.currentOpeningHours?.openNow,
    mapsUri: p.googleMapsUri,
    priceLevel: PRICE_LEVELS[p.priceLevel],
    // e.g. ['paidParkingLot', 'freeStreetParking'] — whatever the venue reports as true
    parking: p.parkingOptions
      ? Object.keys(p.parkingOptions).filter((k) => p.parkingOptions[k] === true)
      : undefined,
  };
}

function normStep(st) {
  const td = st.transitDetails;
  let transit = null;
  if (td) {
    const line = td.transitLine || {};
    transit = {
      line: line.nameShort || line.name || 'Transit',
      vehicle: line.vehicle?.name?.text || '',
      color: line.color,
      headsign: td.headsign,
      from: td.stopDetails?.departureStop?.name,
      to: td.stopDetails?.arrivalStop?.name,
      stops: td.stopCount,
    };
  }
  return {
    text: st.navigationInstruction?.instructions || '',
    distanceM: st.distanceMeters || 0,
    mode: st.travelMode,
    transit,
  };
}

function normLeg(l) {
  const enc = l.polyline?.encodedPolyline;
  return {
    durationSec: parseInt(l.duration, 10) || 0,
    distanceM: l.distanceMeters || 0,
    path: enc && google.maps.geometry ? google.maps.geometry.encoding.decodePath(enc) : [],
    steps: (l.steps || []).map(normStep),
  };
}

export class GoogleProvider {
  id = 'google';

  // mapsKey loads the JS map; servicesKey calls Places (New) + Routes over REST.
  constructor({ googleMapsApiKey, googleServicesApiKey }) {
    this.key = googleMapsApiKey;
    this.servicesKey = googleServicesApiKey || googleMapsApiKey;
    this.stopMarkers = [];
    this.resultMarkers = [];
    this.lines = [];
    this.userMarker = null;
  }

  async renderMap(el, { center, zoom }) {
    bootstrap(this.key);
    const [{ Map }, { AdvancedMarkerElement }, core] = await Promise.all([
      google.maps.importLibrary('maps'),
      google.maps.importLibrary('marker'),
      google.maps.importLibrary('core'),
      google.maps.importLibrary('geometry'),
    ]);
    this.Marker = AdvancedMarkerElement;
    this.map = new Map(el, {
      center,
      zoom,
      mapId: 'DEMO_MAP_ID', // required for advanced markers; swap for your own Map ID
      disableDefaultUI: true,
      gestureHandling: 'greedy', // one-finger pan on iPhone
      clickableIcons: false,
      colorScheme: core.ColorScheme?.FOLLOW_SYSTEM,
    });
  }

  async #post(url, body, fieldMask) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.servicesKey,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
    return json;
  }

  // ---- Data -------------------------------------------------------------

  async geocode(query) {
    const json = await this.#post(
      PLACES_URL,
      { textQuery: query, maxResultCount: 1, languageCode: 'en' },
      'places.id,places.displayName,places.location,places.viewport,places.addressComponents',
    );
    const p = json.places?.[0];
    if (!p) return null;
    const country = p.addressComponents?.find((c) => c.types?.includes('country'));
    const v = p.viewport;
    return {
      name: p.displayName?.text || query,
      lat: p.location.latitude,
      lng: p.location.longitude,
      countryCode: country?.shortText || '',
      viewport: v && {
        south: v.low.latitude, west: v.low.longitude,
        north: v.high.latitude, east: v.high.longitude,
      },
    };
  }

  // Nearest places of the given Google place types, e.g. ['parking_lot', 'parking_garage'].
  async searchNearby(types, near, { radiusM = 800, max = 10 } = {}) {
    const json = await this.#post(NEARBY_URL, {
      includedTypes: types,
      maxResultCount: max,
      rankPreference: 'DISTANCE',
      languageCode: 'en',
      locationRestriction: {
        circle: { center: { latitude: near.lat, longitude: near.lng }, radius: radiusM },
      },
    }, PLACE_FIELDS);
    return (json.places || []).map(normPlace).filter((p) => p.lat != null);
  }

  async searchPlaces(query, { near, radiusM = 10000, max = 15 } = {}) {
    const body = { textQuery: query, maxResultCount: max, languageCode: 'en' };
    if (near) {
      body.locationBias = {
        circle: { center: { latitude: near.lat, longitude: near.lng }, radius: radiusM },
      };
    }
    const json = await this.#post(PLACES_URL, body, PLACE_FIELDS);
    return (json.places || []).map(normPlace).filter((p) => p.lat != null);
  }

  // One Routes API call for walk/drive (supports waypoint optimisation, which
  // keeps the first and last stop fixed). Transit can't take intermediates,
  // so it's computed leg by leg, falling back to walking for short hops.
  async calculateRoute(stops, mode, { optimise = false } = {}) {
    if (stops.length < 2) return { order: stops.map((_, i) => i), legs: [] };
    if (mode !== 'TRANSIT') return this.#route(stops, mode, optimise);

    const order = optimise && stops.length > 3
      ? (await this.#route(stops, 'DRIVE', true)).order
      : stops.map((_, i) => i);
    const seq = order.map((i) => stops[i]);
    const legs = await Promise.all(seq.slice(1).map(async (to, i) => {
      const pair = [seq[i], to];
      try {
        return (await this.#route(pair, 'TRANSIT', false)).legs[0];
      } catch {
        return { ...(await this.#route(pair, 'WALK', false)).legs[0], fallback: 'WALK' };
      }
    }));
    return { order, legs };
  }

  async #route(stops, mode, optimise) {
    const n = stops.length;
    const body = {
      origin: waypoint(stops[0]),
      destination: waypoint(stops[n - 1]),
      intermediates: stops.slice(1, -1).map(waypoint),
      travelMode: mode,
      languageCode: 'en',
      units: 'METRIC',
    };
    if (optimise && n > 3) body.optimizeWaypointOrder = true;
    const json = await this.#post(ROUTES_URL, body, ROUTE_FIELDS);
    const route = json.routes?.[0];
    if (!route) throw new Error('No route found');
    const opt = route.optimizedIntermediateWaypointIndex;
    const order = opt?.length && opt[0] !== -1
      ? [0, ...opt.map((i) => i + 1), n - 1]
      : stops.map((_, i) => i);
    return { order, legs: route.legs.map(normLeg) };
  }

  // ---- Drawing ----------------------------------------------------------

  #marker(position, className, label, zIndex, onTap) {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = label;
    const m = new this.Marker({ map: this.map, position, content: el, zIndex, gmpClickable: !!onTap });
    if (onTap) m.addEventListener('gmp-click', onTap);
    return m;
  }

  setStops(stops, onTap) {
    if (!this.map) return;
    this.stopMarkers.forEach((m) => { m.map = null; });
    this.stopMarkers = stops.map((s, i) =>
      this.#marker(toLatLng(s), 'pin', String(i + 1), 200 + i, () => onTap?.(i)));
  }

  showResults(places, onTap) {
    this.clearResults();
    this.resultMarkers = places.map((p, i) =>
      this.#marker(toLatLng(p), 'dot', String(i + 1), 100 + i, () => onTap?.(i)));
  }

  clearResults() {
    this.resultMarkers.forEach((m) => { m.map = null; });
    this.resultMarkers = [];
  }

  #lineStyle(mode, on) {
    const color = LINE_COLORS[mode] || LINE_COLORS.WALK;
    const opacity = on ? 0.95 : 0.3;
    if (mode === 'WALK') {
      return {
        strokeOpacity: 0,
        icons: [{
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 3, fillColor: color, fillOpacity: opacity, strokeOpacity: 0 },
          offset: '0',
          repeat: '11px',
        }],
      };
    }
    return { strokeColor: color, strokeOpacity: opacity, strokeWeight: 6, icons: [] };
  }

  drawRoute(legs, mode) {
    this.clearRoute();
    if (!this.map) return;
    this.lines = legs.map((leg) => {
      const legMode = leg.fallback || mode;
      const line = new google.maps.Polyline({ map: this.map, path: leg.path, zIndex: 5, ...this.#lineStyle(legMode, true) });
      line.mode = legMode;
      return line;
    });
  }

  highlightLeg(index) {
    this.lines.forEach((l, i) => l.setOptions(this.#lineStyle(l.mode, index < 0 || i === index)));
    const leg = this.lines[index];
    if (leg) {
      const b = new google.maps.LatLngBounds();
      leg.getPath().forEach((p) => b.extend(p));
      this.map.fitBounds(b, this.padding);
    }
  }

  clearRoute() {
    this.lines.forEach((l) => l.setMap(null));
    this.lines = [];
  }

  fitTo(points, padding) {
    if (!this.map || !points.length) return;
    this.padding = padding;
    if (points.length === 1) return this.focus(points[0]);
    const b = new google.maps.LatLngBounds();
    points.forEach((p) => b.extend(toLatLng(p)));
    this.map.fitBounds(b, padding);
  }

  fitViewport(v) {
    this.map?.fitBounds(v);
  }

  focus(p) {
    if (!this.map) return;
    this.map.panTo(toLatLng(p));
    if (this.map.getZoom() < 16) this.map.setZoom(16);
  }

  panTo(p) {
    this.map?.panTo(p);
  }

  getCenter() {
    return this.map?.getCenter()?.toJSON();
  }

  showUser(p) {
    if (!this.map) return;
    if (!this.userMarker) this.userMarker = this.#marker(p, 'me', '', 1000);
    else this.userMarker.position = p;
  }
}
