"""Baidu Maps adapter. Secondary/fallback provider for mainland China.

Baidu works in BD-09 and formats request points as "lat,lng" (but returns
polylines as "lng,lat"). All conversion happens here so callers see WGS-84.
Commercial use must be checked against Baidu's developer terms.
"""

from __future__ import annotations

from typing import Any

import httpx

from app.geo.coords import bd09_to_wgs84, wgs84_to_bd09
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
    TravelMode.WALKING: "/directionlite/v1/walking",
    TravelMode.DRIVING: "/directionlite/v1/driving",
    TravelMode.TRANSIT: "/directionlite/v1/transit",
}


class BaiduError(RuntimeError):
    pass


def to_baidu(p: LatLng) -> str:
    lat, lng = wgs84_to_bd09(p.lat, p.lng)
    return f"{lat:.6f},{lng:.6f}"


def from_baidu(lat: float, lng: float) -> LatLng:
    lat, lng = bd09_to_wgs84(lat, lng)
    return LatLng(lat=lat, lng=lng)


def parse_path(s: str) -> list[LatLng]:
    points = []
    for pt in s.split(";"):
        if pt:
            lng, lat = (float(v) for v in pt.split(","))
            points.append(from_baidu(lat, lng))
    return points


class BaiduProvider(MapProvider):
    name = "baidu"

    def __init__(self, ak: str | None, base_url: str, client: httpx.AsyncClient):
        if not ak:
            raise ProviderNotConfigured("WAYFINDER_BAIDU_AK is not set")
        self._ak = ak
        self._base = base_url.rstrip("/")
        self._client = client

    async def _get(self, path: str, **params: Any) -> dict[str, Any]:
        resp = await self._client.get(
            f"{self._base}{path}",
            params={"ak": self._ak, "output": "json", "coord_type": "bd09ll", **params},
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("status") != 0:
            raise BaiduError(f"{path}: {data.get('message')} ({data.get('status')})")
        return data

    async def search_places(
        self, query: str, near: LatLng | None = None, limit: int = 10
    ) -> list[Place]:
        params: dict[str, Any] = {"query": query, "page_size": limit}
        if near:
            params |= {"location": to_baidu(near), "radius": 3000}
        else:
            params["region"] = "全国"
        data = await self._get("/place/v2/search", **params)
        return [
            Place(
                provider=self.name,
                provider_place_id=r["uid"],
                name=r["name"],
                local_name=r["name"],
                location=from_baidu(r["location"]["lat"], r["location"]["lng"]),
                address=r.get("address") or None,
            )
            for r in data.get("results", [])[:limit]
            if "location" in r and "uid" in r
        ]

    async def geocode(self, address: str) -> LatLng | None:
        data = await self._get("/geocoding/v3/", address=address)
        loc = (data.get("result") or {}).get("location")
        return from_baidu(loc["lat"], loc["lng"]) if loc else None

    async def reverse_geocode(self, location: LatLng) -> str | None:
        data = await self._get("/reverse_geocoding/v3/", location=to_baidu(location))
        return (data.get("result") or {}).get("formatted_address") or None

    async def calculate_route(self, origin: LatLng, destination: LatLng, mode: TravelMode) -> Route:
        data = await self._get(
            _ROUTE_PATHS[mode], origin=to_baidu(origin), destination=to_baidu(destination)
        )
        best = data["result"]["routes"][0]
        geometry: list[LatLng] = []
        steps: list[RouteStep] = []
        for step in best.get("steps", []):
            # Transit steps are nested one level deeper (a list of alternatives).
            for s in step if isinstance(step, list) else [step]:
                geometry.extend(parse_path(s.get("path", "")))
                steps.append(
                    RouteStep(
                        instruction=s.get("instruction") or s.get("instructions", ""),
                        distance_m=float(s.get("distance") or 0),
                        duration_s=float(s.get("duration") or 0),
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
        # TODO: Baidu's routematrix API returns n x n in one call for walk/drive.
        return await pairwise_route_matrix(self, points, mode)
