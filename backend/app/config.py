from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="WAYFINDER_", extra="ignore")

    database_url: str = "postgresql://wayfinder:wayfinder@localhost:5432/wayfinder"
    redis_url: str = "redis://localhost:6379/0"
    cors_origins: list[str] = ["http://localhost:3000"]

    google_maps_api_key: str | None = None
    # AMap Web Service key. Point amap_base_url at the overseas endpoint once
    # the overseas Web Service API has been provisioned.
    amap_api_key: str | None = None
    amap_base_url: str = "https://restapi.amap.com"
    baidu_ak: str | None = None
    baidu_base_url: str = "https://api.map.baidu.com"

    # "auto" picks by country; set to "mock" to run fully offline.
    map_provider_override: str = "auto"


@lru_cache
def get_settings() -> Settings:
    return Settings()
