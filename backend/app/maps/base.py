"""Provider-neutral map types and the MapProvider interface.

The itinerary engine only ever talks to this interface. It never knows whether
a route came from Google, AMap or Baidu, and all coordinates crossing this
boundary are WGS-84. Adapters convert to and from provider datums internally.
"""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod
from enum import StrEnum

from pydantic import BaseModel, Field


class TravelMode(StrEnum):
    WALKING = "walking"
    DRIVING = "driving"
    TRANSIT = "transit"


class LatLng(BaseModel):
    """A WGS-84 coordinate."""

    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class Place(BaseModel):
    provider: str
    provider_place_id: str
    name: str
    local_name: str | None = None
    location: LatLng
    address: str | None = None
    categories: list[str] = []


class RouteStep(BaseModel):
    instruction: str
    distance_m: float
    duration_s: float


class Route(BaseModel):
    provider: str
    mode: TravelMode
    distance_m: float
    duration_s: float
    # Polyline as WGS-84 points, so the frontend can draw it on any base map.
    geometry: list[LatLng]
    steps: list[RouteStep] = []


class RouteMatrix(BaseModel):
    provider: str
    mode: TravelMode
    # durations_s[i][j] is the travel time from origins[i] to destinations[j].
    durations_s: list[list[float]]
    distances_m: list[list[float]]


class ProviderNotConfigured(RuntimeError):
    """Raised when an adapter is selected but its API key is missing."""


class MapProvider(ABC):
    """The adapter contract every map provider implements."""

    name: str

    @abstractmethod
    async def search_places(
        self, query: str, near: LatLng | None = None, limit: int = 10
    ) -> list[Place]: ...

    @abstractmethod
    async def geocode(self, address: str) -> LatLng | None: ...

    @abstractmethod
    async def reverse_geocode(self, location: LatLng) -> str | None: ...

    @abstractmethod
    async def calculate_route(
        self, origin: LatLng, destination: LatLng, mode: TravelMode
    ) -> Route: ...

    @abstractmethod
    async def calculate_route_matrix(
        self, points: list[LatLng], mode: TravelMode
    ) -> RouteMatrix: ...

    async def get_nearby_places(
        self, location: LatLng, category: str, limit: int = 10
    ) -> list[Place]:
        return await self.search_places(category, near=location, limit=limit)


async def pairwise_route_matrix(
    provider: MapProvider, points: list[LatLng], mode: TravelMode, concurrency: int = 4
) -> RouteMatrix:
    """Build a matrix from individual route calls.

    For providers without a native matrix endpoint. This costs n*(n-1) billable
    requests, so callers should keep n small and cache the result.
    """
    sem = asyncio.Semaphore(concurrency)
    n = len(points)
    durations = [[0.0] * n for _ in range(n)]
    distances = [[0.0] * n for _ in range(n)]

    async def leg(i: int, j: int) -> None:
        async with sem:
            route = await provider.calculate_route(points[i], points[j], mode)
        durations[i][j] = route.duration_s
        distances[i][j] = route.distance_m

    await asyncio.gather(*(leg(i, j) for i in range(n) for j in range(n) if i != j))
    return RouteMatrix(
        provider=provider.name, mode=mode, durations_s=durations, distances_m=distances
    )
