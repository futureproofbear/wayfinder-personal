"""Google Maps Platform adapter (Places API (New), Geocoding, Routes API).

Default provider outside mainland China and Vietnam, which are on Google's
prohibited-territory list. Google already works in WGS-84.
"""

from __future__ import annotations

from typing import Any

import httpx

from app.maps.base import (
    LatLng,
    MapProvider,
    Place,
    ProviderNotConfigured,
    Route,
    RouteMatrix,
    RouteStep,
    TravelMode,
)

_MODES = {
    TravelMode.WALKING: "WALK",
    TravelMode.DRIVING: "DRIVE",
    TravelMode.TRANSIT: "TRANSIT",
}


def decode_polyline(encoded: str) -> list[LatLng]:
    """Decode a Google encoded polyline (precision 5)."""
    points: list[LatLng] = []
    index = lat = lng = 0
    while index < len(encoded):
        for is_lng in (False, True):
            shift = result = 0
            while True:
                b = ord(encoded[index]) - 63
                index += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if is_lng:
                lng += delta
            else:
                lat += delta
        points.append(LatLng(lat=lat / 1e5, lng=lng / 1e5))
    return points


def _seconds(duration: str | None) -> float:
    # Routes API durations look like "123s".
    return float(duration.rstrip("s")) if duration else 0.0


def _waypoint(p: LatLng) -> dict[str, Any]:
    return {"location": {"latLng": {"latitude": p.lat, "longitude": p.lng}}}


class GoogleProvider(MapProvider):
    name = "google"

    def __init__(self, api_key: str | None, client: httpx.AsyncClient):
        if not api_key:
            raise ProviderNotConfigured("WAYFINDER_GOOGLE_MAPS_API_KEY is not set")
        self._key = api_key
        self._client = client

    async def _post(self, url: str, body: dict[str, Any], field_mask: str) -> Any:
        resp = await self._client.post(
            url,
            json=body,
            headers={"X-Goog-Api-Key": self._key, "X-Goog-FieldMask": field_mask},
        )
        resp.raise_for_status()
        return resp.json()

    async def search_places(
        self, query: str, near: LatLng | None = None, limit: int = 10
    ) -> list[Place]:
        body: dict[str, Any] = {"textQuery": query, "pageSize": min(limit, 20)}
        if near:
            body["locationBias"] = {
                "circle": {
                    "center": {"latitude": near.lat, "longitude": near.lng},
                    "radius": 3000.0,
                }
            }
        data = await self._post(
            "https://places.googleapis.com/v1/places:searchText",
            body,
            "places.id,places.displayName,places.location,places.formattedAddress,places.types",
        )
        return [
            Place(
                provider=self.name,
                provider_place_id=p["id"],
                name=p.get("displayName", {}).get("text", ""),
                location=LatLng(lat=p["location"]["latitude"], lng=p["location"]["longitude"]),
                address=p.get("formattedAddress"),
                categories=p.get("types", []),
            )
            for p in data.get("places", [])
        ]

    async def _geocode(self, **params: str) -> dict[str, Any] | None:
        resp = await self._client.get(
            "https://maps.googleapis.com/maps/api/geocode/json", params={"key": self._key, **params}
        )
        resp.raise_for_status()
        results = resp.json().get("results") or []
        return results[0] if results else None

    async def geocode(self, address: str) -> LatLng | None:
        result = await self._geocode(address=address)
        if not result:
            return None
        loc = result["geometry"]["location"]
        return LatLng(lat=loc["lat"], lng=loc["lng"])

    async def reverse_geocode(self, location: LatLng) -> str | None:
        result = await self._geocode(latlng=f"{location.lat},{location.lng}")
        return result.get("formatted_address") if result else None

    async def calculate_route(self, origin: LatLng, destination: LatLng, mode: TravelMode) -> Route:
        data = await self._post(
            "https://routes.googleapis.com/directions/v2:computeRoutes",
            {
                "origin": _waypoint(origin),
                "destination": _waypoint(destination),
                "travelMode": _MODES[mode],
            },
            "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,"
            "routes.legs.steps.navigationInstruction,routes.legs.steps.distanceMeters,"
            "routes.legs.steps.staticDuration",
        )
        best = data["routes"][0]
        steps = [
            RouteStep(
                instruction=s.get("navigationInstruction", {}).get("instructions", ""),
                distance_m=float(s.get("distanceMeters", 0)),
                duration_s=_seconds(s.get("staticDuration")),
            )
            for leg in best.get("legs", [])
            for s in leg.get("steps", [])
        ]
        encoded = best.get("polyline", {}).get("encodedPolyline")
        return Route(
            provider=self.name,
            mode=mode,
            distance_m=float(best.get("distanceMeters", 0)),
            duration_s=_seconds(best.get("duration")),
            geometry=decode_polyline(encoded) if encoded else [origin, destination],
            steps=steps,
        )

    async def calculate_route_matrix(self, points: list[LatLng], mode: TravelMode) -> RouteMatrix:
        waypoints = [{"waypoint": _waypoint(p)} for p in points]
        elements = await self._post(
            "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix",
            {"origins": waypoints, "destinations": waypoints, "travelMode": _MODES[mode]},
            "originIndex,destinationIndex,duration,distanceMeters,condition",
        )
        n = len(points)
        unreachable = 24 * 3600.0
        durations = [[0.0 if i == j else unreachable for j in range(n)] for i in range(n)]
        distances = [[0.0] * n for _ in range(n)]
        for e in elements:
            i, j = e.get("originIndex", 0), e.get("destinationIndex", 0)
            if e.get("condition") == "ROUTE_EXISTS":
                durations[i][j] = _seconds(e.get("duration"))
                distances[i][j] = float(e.get("distanceMeters", 0))
        return RouteMatrix(
            provider=self.name, mode=mode, durations_s=durations, distances_m=distances
        )
