from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import time

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.config import get_settings
from app.maps.base import LatLng, MapProvider, Place, Route, TravelMode
from app.maps.registry import ProviderRegistry
from app.optimiser.day_planner import InfeasibleDay, Stop, plan_day

log = logging.getLogger("wayfinder")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    async with httpx.AsyncClient(timeout=15.0) as client:
        app.state.registry = ProviderRegistry(get_settings(), client)
        yield


app = FastAPI(title="Wayfinder API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def with_fallback[T](
    request: Request, country: str, call: Callable[[MapProvider], Awaitable[T]]
) -> tuple[T, str, bool]:
    """Run ``call`` against each provider for the country until one succeeds.

    Returns (result, provider name, degraded). Degraded means the preferred
    provider failed and a fallback answered.
    """
    providers = request.app.state.registry.candidates(country)
    errors: list[str] = []
    for i, provider in enumerate(providers):
        try:
            return await call(provider), provider.name, i > 0
        except (httpx.HTTPError, RuntimeError, KeyError, IndexError, NotImplementedError) as exc:
            log.warning("provider %s failed: %r", provider.name, exc)
            errors.append(f"{provider.name}: {exc}")
    raise HTTPException(502, detail={"message": "all map providers failed", "errors": errors})


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


class PlacesResponse(BaseModel):
    provider: str
    degraded: bool
    places: list[Place]


@app.get("/places/search")
async def search_places(
    request: Request,
    q: str,
    country: str = Query(min_length=2, max_length=2),
    lat: float | None = None,
    lng: float | None = None,
    limit: int = Query(10, ge=1, le=20),
) -> PlacesResponse:
    near = LatLng(lat=lat, lng=lng) if lat is not None and lng is not None else None
    places, provider, degraded = await with_fallback(
        request, country, lambda p: p.search_places(q, near=near, limit=limit)
    )
    return PlacesResponse(provider=provider, degraded=degraded, places=places)


class RouteRequest(BaseModel):
    country: str = Field(min_length=2, max_length=2)
    origin: LatLng
    destination: LatLng
    mode: TravelMode = TravelMode.WALKING


@app.post("/routes")
async def route(request: Request, body: RouteRequest) -> Route:
    result, _, _ = await with_fallback(
        request,
        body.country,
        lambda p: p.calculate_route(body.origin, body.destination, body.mode),
    )
    return result


class StopIn(BaseModel):
    id: str
    name: str | None = None
    location: LatLng
    visit_min: int = Field(60, ge=0, le=12 * 60)
    opens: time | None = None
    closes: time | None = None
    mandatory: bool = False
    priority: float = Field(1.0, gt=0)


class OptimiseDayRequest(BaseModel):
    country: str = Field(min_length=2, max_length=2)
    mode: TravelMode = TravelMode.WALKING
    start: LatLng
    stops: list[StopIn] = Field(min_length=1, max_length=25)
    day_start: time = time(9, 0)
    day_end: time = time(21, 0)
    return_to_start: bool = True
    max_travel_min: int | None = None


class ScheduledStopOut(BaseModel):
    id: str
    arrive: str
    depart: str
    travel_from_prev_min: int


class OptimiseDayResponse(BaseModel):
    provider: str
    degraded: bool
    stops: list[ScheduledStopOut]
    dropped: list[str]
    total_travel_min: int
    legs: list[Route]


def _secs(t: time) -> int:
    return t.hour * 3600 + t.minute * 60


def _hhmm(s: int) -> str:
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}"


@app.post("/itinerary/optimise-day")
async def optimise_day(request: Request, body: OptimiseDayRequest) -> OptimiseDayResponse:
    points = [body.start, *(s.location for s in body.stops)]
    matrix, provider, degraded = await with_fallback(
        request, body.country, lambda p: p.calculate_route_matrix(points, body.mode)
    )
    stops = [
        Stop(
            id=s.id,
            visit_s=s.visit_min * 60,
            open_s=_secs(s.opens) if s.opens else 0,
            close_s=_secs(s.closes) if s.closes else 24 * 3600,
            mandatory=s.mandatory,
            priority=s.priority,
        )
        for s in body.stops
    ]
    try:
        plan = plan_day(
            stops,
            matrix.durations_s,
            day_start_s=_secs(body.day_start),
            day_end_s=_secs(body.day_end),
            return_to_start=body.return_to_start,
            max_travel_s=body.max_travel_min * 60 if body.max_travel_min else None,
        )
    except InfeasibleDay as exc:
        raise HTTPException(422, detail=str(exc)) from exc

    # Fetch drawable geometry for each leg of the chosen order.
    by_id = {s.id: s.location for s in body.stops}
    ordered = [body.start, *(by_id[s.id] for s in plan.stops)]
    if body.return_to_start and plan.stops:
        ordered.append(body.start)
    legs: list[Route] = []
    for a, b in zip(ordered, ordered[1:], strict=False):
        leg, _, _ = await with_fallback(
            request, body.country, lambda p, a=a, b=b: p.calculate_route(a, b, body.mode)
        )
        legs.append(leg)

    return OptimiseDayResponse(
        provider=provider,
        degraded=degraded,
        stops=[
            ScheduledStopOut(
                id=s.id,
                arrive=_hhmm(s.arrive_s),
                depart=_hhmm(s.depart_s),
                travel_from_prev_min=round(s.travel_from_prev_s / 60),
            )
            for s in plan.stops
        ],
        dropped=plan.dropped,
        total_travel_min=round(plan.total_travel_s / 60),
        legs=legs,
    )
