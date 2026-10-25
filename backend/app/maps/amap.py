"""AMap (Gaode) Web Service adapter. Primary provider for mainland China.

AMap works in GCJ-02 and formats points as "lng,lat". Everything entering or
leaving this adapter is converted to WGS-84.

Transit routing needs a city code and is not wired up yet.
"""

from __future__ import annotations

from typing import Any

import httpx

from app.geo.coords import gcj02_to_wgs84, wgs84_to_gcj02
from app.maps.base import (
    LatLng,
    MapProvider,
    Place,
    ProviderNotConfigured,
    Route,
    RouteMatrix,
    RouteStep,
    TravelMode,
    pairwise_route_matrix,
)

_ROUTE_PATHS = {
    TravelMode.WALKING: "/v3/direction/walking",
    TravelMode.DRIVING: "/v3/direction/driving",
}


class AMapError(RuntimeError):
    pass


def to_amap(p: LatLng) -> str:
    lat, lng = wgs84_to_gcj02(p.lat, p.lng)
    return f"{lng:.6f},{lat:.6f}"


def from_amap(s: str) -> LatLng:
    lng, lat = (float(v) for v in s.split(","))
    lat, lng = gcj02_to_wgs84(lat, lng)
    return LatLng(lat=lat, lng=lng)


def parse_polyline(s: str) -> list[LatLng]:
    return [from_amap(pt) for pt in s.split(";") if pt]


class AMapProvider(MapProvider):
    name = "amap"

    def __init__(self, api_key: str | None, base_url: str, client: httpx.AsyncClient):
        if not api_key:
            raise ProviderNotConfigured("WAYFINDER_AMAP_API_KEY is not set")
        self._key = api_key
        self._base = base_url.rstrip("/")
        self._client = client

    async def _get(self, path: str, **params: Any) -> dict[str, Any]:
        resp = await self._client.get(f"{self._base}{path}", params={"key": self._key, **params})
        resp.raise_for_status()
        data = resp.json()
        if data.get("status") != "1":
            raise AMapError(f"{path}: {data.get('info')} ({data.get('infocode')})")
        return data

    async def search_places(
        self, query: str, near: LatLng | None = None, limit: int = 10
    ) -> list[Place]:
        if near:
            data = await self._get(
                "/v3/place/around", keywords=query, location=to_amap(near), offset=limit
            )
        else:
            data = await self._get("/v3/place/text", keywords=query, offset=limit)
        return [
            Place(
                provider=self.name,
                provider_place_id=poi["id"],
                name=poi["name"],
                local_name=poi["name"],
                location=from_amap(poi["location"]),
                address=poi.get("address") or None,
                categories=[c for c in str(poi.get("type", "")).split(";") if c],
            )
            for poi in data.get("pois", [])[:limit]
        ]

    async def geocode(self, address: str) -> LatLng | None:
        data = await self._get("/v3/geocode/geo", address=address)
        geocodes = data.get("geocodes") or []
        return from_amap(geocodes[0]["location"]) if geocodes else None

    async def reverse_geocode(self, location: LatLng) -> str | None:
        data = await self._get("/v3/geocode/regeo", location=to_amap(location))
        return (data.get("regeocode") or {}).get("formatted_address") or None

    async def calculate_route(self, origin: LatLng, destination: LatLng, mode: TravelMode) -> Route:
        path = _ROUTE_PATHS.get(mode)
        if path is None:
            raise NotImplementedError(f"AMap {mode} routing is not implemented yet")
        data = await self._get(path, origin=to_amap(origin), destination=to_amap(destination))
        best = data["route"]["paths"][0]
        geometry: list[LatLng] = []
        steps: list[RouteStep] = []
        for step in best.get("steps", []):
            geometry.extend(parse_polyline(step.get("polyline", "")))
            steps.append(
                RouteStep(
                    instruction=step.get("instruction", ""),
                    distance_m=float(step.get("distance") or 0),
                    duration_s=float(step.get("duration") or 0),
                )
            )
        return Route(
            provider=self.name,
            mode=mode,
            distance_m=float(best["distance"]),
            duration_s=float(best["duration"]),
            geometry=geometry or [origin, destination],
            steps=steps,
        )

    async def calculate_route_matrix(self, points: list[LatLng], mode: TravelMode) -> RouteMatrix:
        # TODO: use /v3/distance (many origins to one destination) to cut calls to n.
        return await pairwise_route_matrix(self, points, mode)
