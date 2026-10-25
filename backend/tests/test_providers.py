import httpx
import pytest

from app.config import Settings
from app.geo.coords import haversine_m
from app.maps.amap import AMapProvider
from app.maps.baidu import BaiduProvider
from app.maps.base import LatLng, TravelMode
from app.maps.google import decode_polyline
from app.maps.registry import ProviderRegistry

BUND = LatLng(lat=31.2400, lng=121.4900)
YU_GARDEN = LatLng(lat=31.2272, lng=121.4921)


def registry(**settings) -> ProviderRegistry:
    return ProviderRegistry(Settings(_env_file=None, **settings), httpx.AsyncClient())


def test_china_prefers_amap_then_baidu_never_google():
    reg = registry(amap_api_key="a", baidu_ak="b", google_maps_api_key="g")
    assert [p.name for p in reg.candidates("CN")] == ["amap", "baidu", "mock"]


def test_vietnam_never_uses_google():
    reg = registry(google_maps_api_key="g")
    assert [p.name for p in reg.candidates("VN")] == ["mock"]


def test_japan_uses_google():
    assert registry(google_maps_api_key="g").for_country("jp").name == "google"


def test_unconfigured_providers_fall_back_to_mock():
    assert [p.name for p in registry().candidates("CN")] == ["mock"]


def test_google_polyline_decoding():
    # Example from Google's encoded polyline algorithm documentation.
    pts = decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
    assert [(p.lat, p.lng) for p in pts] == [
        (38.5, -120.2),
        (40.7, -120.95),
        (43.252, -126.453),
    ]


async def test_amap_converts_datums_both_ways():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.url.params)
        # Echo the GCJ-02 points straight back as the route polyline.
        line = f"{request.url.params['origin']};{request.url.params['destination']}"
        return httpx.Response(
            200,
            json={
                "status": "1",
                "route": {
                    "paths": [
                        {
                            "distance": "1500",
                            "duration": "1200",
                            "steps": [
                                {
                                    "instruction": "Walk south",
                                    "distance": "1500",
                                    "duration": "1200",
                                    "polyline": line,
                                }
                            ],
                        }
                    ]
                },
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = AMapProvider("key", "https://amap.test", client)
        route = await provider.calculate_route(BUND, YU_GARDEN, TravelMode.WALKING)

    sent_lng, sent_lat = (float(v) for v in seen["origin"].split(","))
    assert haversine_m(BUND.lat, BUND.lng, sent_lat, sent_lng) > 100  # offset applied
    assert route.duration_s == 1200
    start = route.geometry[0]
    assert haversine_m(BUND.lat, BUND.lng, start.lat, start.lng) < 1  # and removed


async def test_baidu_uses_lat_lng_order_and_bd09():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.url.params)
        return httpx.Response(
            200,
            json={
                "status": 0,
                "result": {"routes": [{"distance": 1500, "duration": 1200, "steps": []}]},
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = BaiduProvider("ak", "https://baidu.test", client)
        await provider.calculate_route(BUND, YU_GARDEN, TravelMode.WALKING)

    lat, lng = (float(v) for v in seen["origin"].split(","))
    assert 31 < lat < 32 and 121 < lng < 122
    assert seen["coord_type"] == "bd09ll"


async def test_amap_error_status_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "0", "info": "INVALID_USER_KEY"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        provider = AMapProvider("bad", "https://amap.test", client)
        with pytest.raises(RuntimeError, match="INVALID_USER_KEY"):
            await provider.geocode("外滩")
