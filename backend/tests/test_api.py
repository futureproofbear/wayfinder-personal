import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.scoring import Signals, Weights, score


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("WAYFINDER_MAP_PROVIDER_OVERRIDE", "mock")
    get_settings.cache_clear()
    with TestClient(app) as c:
        yield c
    get_settings.cache_clear()


def test_health(client):
    assert client.get("/health").json() == {"status": "ok"}


def test_optimise_day_with_mock_provider(client):
    body = {
        "country": "SG",
        "mode": "walking",
        "start": {"lat": 1.2834, "lng": 103.8607},  # Marina Bay Sands
        "stops": [
            {"id": "merlion", "location": {"lat": 1.2868, "lng": 103.8545}, "visit_min": 30},
            {
                "id": "gardens",
                "location": {"lat": 1.2816, "lng": 103.8636},
                "visit_min": 90,
                "opens": "05:00",
                "closes": "23:00",
            },
            {
                "id": "chinatown",
                "location": {"lat": 1.2838, "lng": 103.8436},
                "visit_min": 60,
                "mandatory": True,
            },
        ],
    }
    resp = client.post("/itinerary/optimise-day", json=body)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["provider"] == "mock"
    assert {s["id"] for s in data["stops"]} == {"merlion", "gardens", "chinatown"}
    assert data["stops"][0]["arrive"] >= "09:00"
    # One leg per stop plus the return to the hotel.
    assert len(data["legs"]) == 4


def test_score_is_weighted_average():
    perfect = Signals(interest=1, reviews=1, popularity=1, geography=1, budget=1, confidence=1)
    assert score(perfect) == pytest.approx(1.0)
    only_interest = Weights(
        interest=1, reviews=0, popularity=0, geography=0, budget=0, confidence=0
    )
    mixed = Signals(interest=0.4, reviews=1, popularity=1, geography=1, budget=1, confidence=1)
    assert score(mixed, only_interest) == pytest.approx(0.4)
