import pytest

from app.geo.coords import (
    bd09_to_wgs84,
    gcj02_to_wgs84,
    haversine_m,
    wgs84_to_bd09,
    wgs84_to_gcj02,
)

THE_BUND = (31.2400, 121.4900)
TOKYO_STATION = (35.6812, 139.7671)


def test_gcj02_offset_is_applied_in_china():
    lat, lng = wgs84_to_gcj02(*THE_BUND)
    # The GCJ-02 shift in Shanghai is a few hundred metres.
    assert 100 < haversine_m(*THE_BUND, lat, lng) < 1000


def test_no_offset_outside_china():
    assert wgs84_to_gcj02(*TOKYO_STATION) == TOKYO_STATION


@pytest.mark.parametrize(
    ("forward", "inverse"),
    [(wgs84_to_gcj02, gcj02_to_wgs84), (wgs84_to_bd09, bd09_to_wgs84)],
)
def test_round_trip_is_sub_metre(forward, inverse):
    back = inverse(*forward(*THE_BUND))
    assert haversine_m(*THE_BUND, *back) < 0.5


def test_haversine_known_distance():
    # Singapore Changi to Marina Bay Sands is roughly 17 km as the crow flies.
    assert 15_000 < haversine_m(1.3644, 103.9915, 1.2834, 103.8607) < 19_000
