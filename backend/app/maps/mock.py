"""Offline provider that estimates routes from straight-line distance.

Used for tests, local development without API keys, and as the degraded-mode
fallback when no live provider is reachable.
"""

from __future__ import annotations

from app.geo.coords import haversine_m
from app.maps.base import LatLng, MapProvider, Place, Route, RouteMatrix, TravelMode

# Average speeds in m/s, and a detour factor because streets are not straight.
SPEEDS = {TravelMode.WALKING: 1.3, TravelMode.DRIVING: 8.0, TravelMode.TRANSIT: 6.0}
DETOUR = 1.3
TRANSIT_OVERHEAD_S = 300.0  # waiting and walking to the station


def estimate(a: LatLng, b: LatLng, mode: TravelMode) -> tuple[float, float]:
    """Return (distance_m, duration_s) for a leg."""
    distance = haversine_m(a.lat, a.lng, b.lat, b.lng) * DETOUR
    if distance == 0:
        return 0.0, 0.0
    duration = distance / SPEEDS[mode]
    if mode is TravelMode.TRANSIT:
        duration += TRANSIT_OVERHEAD_S
    return distance, duration


class MockProvider(MapProvider):
    name = "mock"

    async def search_places(
        self, query: str, near: LatLng | None = None, limit: int = 10
    ) -> list[Place]:
        return []

    async def geocode(self, address: str) -> LatLng | None:
        return None

    async def reverse_geocode(self, location: LatLng) -> str | None:
        return None

    async def calculate_route(self, origin: LatLng, destination: LatLng, mode: TravelMode) -> Route:
        distance, duration = estimate(origin, destination, mode)
        return Route(
            provider=self.name,
            mode=mode,
            distance_m=distance,
            duration_s=duration,
            geometry=[origin, destination],
        )

    async def calculate_route_matrix(self, points: list[LatLng], mode: TravelMode) -> RouteMatrix:
        legs = [[estimate(a, b, mode) for b in points] for a in points]
        return RouteMatrix(
            provider=self.name,
            mode=mode,
            distances_m=[[d for d, _ in row] for row in legs],
            durations_s=[[t for _, t in row] for row in legs],
        )
