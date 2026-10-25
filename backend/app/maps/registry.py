"""Chooses a map provider per country.

Selection is by coverage and licensing, not one provider for all of Asia.
Providers whose keys are missing are skipped, and the offline mock provider is
the last resort so the app keeps working in degraded mode.
"""

from __future__ import annotations

import httpx

from app.config import Settings
from app.maps.amap import AMapProvider
from app.maps.baidu import BaiduProvider
from app.maps.base import MapProvider, ProviderNotConfigured
from app.maps.google import GoogleProvider
from app.maps.mock import MockProvider

# ISO 3166-1 alpha-2 country code -> providers in order of preference.
# Google is excluded for CN and VN (prohibited territories).
PROVIDER_PREFERENCE: dict[str, list[str]] = {
    "CN": ["amap", "baidu"],
    "VN": [],  # not yet validated; falls through to mock
}
DEFAULT_PREFERENCE = ["google"]


class ProviderRegistry:
    def __init__(self, settings: Settings, client: httpx.AsyncClient):
        self._settings = settings
        self._client = client

    def _build(self, name: str) -> MapProvider:
        s = self._settings
        match name:
            case "google":
                return GoogleProvider(s.google_maps_api_key, self._client)
            case "amap":
                return AMapProvider(s.amap_api_key, s.amap_base_url, self._client)
            case "baidu":
                return BaiduProvider(s.baidu_ak, s.baidu_base_url, self._client)
            case "mock":
                return MockProvider()
        raise ValueError(f"unknown map provider {name!r}")

    def candidates(self, country: str) -> list[MapProvider]:
        """Configured providers for a country, most preferred first, ending with mock."""
        override = self._settings.map_provider_override
        names = (
            [override]
            if override != "auto"
            else PROVIDER_PREFERENCE.get(country.upper(), DEFAULT_PREFERENCE)
        )
        providers: list[MapProvider] = []
        for name in names:
            try:
                providers.append(self._build(name))
            except ProviderNotConfigured:
                continue
        if not any(p.name == "mock" for p in providers):
            providers.append(MockProvider())
        return providers

    def for_country(self, country: str) -> MapProvider:
        return self.candidates(country)[0]
