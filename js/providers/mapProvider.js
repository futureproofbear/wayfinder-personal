// Map Provider Adapter. The itinerary code only talks to this contract, so a
// China-capable provider (AMap / Baidu) can be added without touching app.js.
//
// Every provider implements:
//   renderMap(el, { center, zoom })
//   geocode(query)                      -> { name, lat, lng, countryCode, viewport } | null
//   searchPlaces(query, { near })       -> [Place]
//   calculateRoute(stops, mode, { optimise }) -> { order: [stopIndex], legs: [Leg] }
//   setStops / showResults / drawRoute / highlightLeg / fitTo / focus / showUser ...
//
// Place: { placeId, name, address, lat, lng, type, primaryType, rating, ratings, openNow, mapsUri }
// Leg:   { durationSec, distanceM, path, steps: [{ text, distanceM, mode, transit }], fallback? }
// Coordinates are WGS-84 { lat, lng }.

import { GoogleProvider } from './google.js';

// Google Maps Platform prohibited territories relevant to this app.
// (Also note: Google's Routes API returns no transit data for Japan.)
const GOOGLE_RESTRICTED = new Set(['CN', 'VN']);

export function providerIdFor(countryCode) {
  if (countryCode === 'CN') return 'amap';
  if (GOOGLE_RESTRICTED.has(countryCode)) return 'unsupported';
  return 'google';
}

export function createProvider(id, config) {
  switch (id) {
    case 'google':
      return new GoogleProvider(config);
    default:
      throw new Error(`Map provider "${id}" is not implemented yet`);
  }
}
