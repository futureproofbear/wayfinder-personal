"""Coordinate datum conversions between WGS-84, GCJ-02 and BD-09.

Canonical locations are stored in WGS-84. Mainland China providers use offset
datums: AMap uses GCJ-02 and Baidu uses BD-09. Adapters must convert at the
boundary so the rest of the application never sees offset coordinates.

GCJ-02 offsets only apply inside mainland China, so points outside the rough
bounding box are returned unchanged. The inverse transforms are iterative
approximations accurate to well under a metre.
"""

from __future__ import annotations

import math

_A = 6378245.0  # Krasovsky 1940 semi-major axis
_EE = 0.00669342162296594323  # Krasovsky 1940 eccentricity squared
_X_PI = math.pi * 3000.0 / 180.0


def in_mainland_china(lat: float, lng: float) -> bool:
    # Coarse bounding box. Hong Kong, Macau and Taiwan are inside it but use
    # WGS-84 in practice, so providers must still decide per market.
    return 73.66 < lng < 135.05 and 3.86 < lat < 53.55


def _transform_lat(x: float, y: float) -> float:
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (160.0 * math.sin(y / 12.0 * math.pi) + 320 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    return ret


def _transform_lng(x: float, y: float) -> float:
    ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    return ret


def wgs84_to_gcj02(lat: float, lng: float) -> tuple[float, float]:
    if not in_mainland_china(lat, lng):
        return lat, lng
    d_lat = _transform_lat(lng - 105.0, lat - 35.0)
    d_lng = _transform_lng(lng - 105.0, lat - 35.0)
    rad_lat = lat / 180.0 * math.pi
    magic = 1 - _EE * math.sin(rad_lat) ** 2
    sqrt_magic = math.sqrt(magic)
    d_lat = (d_lat * 180.0) / ((_A * (1 - _EE)) / (magic * sqrt_magic) * math.pi)
    d_lng = (d_lng * 180.0) / (_A / sqrt_magic * math.cos(rad_lat) * math.pi)
    return lat + d_lat, lng + d_lng


def gcj02_to_wgs84(lat: float, lng: float) -> tuple[float, float]:
    if not in_mainland_china(lat, lng):
        return lat, lng
    # Fixed-point iteration: find w such that wgs84_to_gcj02(w) == (lat, lng).
    w_lat, w_lng = lat, lng
    for _ in range(10):
        g_lat, g_lng = wgs84_to_gcj02(w_lat, w_lng)
        d_lat, d_lng = g_lat - lat, g_lng - lng
        w_lat, w_lng = w_lat - d_lat, w_lng - d_lng
        if abs(d_lat) < 1e-9 and abs(d_lng) < 1e-9:
            break
    return w_lat, w_lng


def gcj02_to_bd09(lat: float, lng: float) -> tuple[float, float]:
    z = math.sqrt(lng * lng + lat * lat) + 0.00002 * math.sin(lat * _X_PI)
    theta = math.atan2(lat, lng) + 0.000003 * math.cos(lng * _X_PI)
    return z * math.sin(theta) + 0.006, z * math.cos(theta) + 0.0065


def bd09_to_gcj02(lat: float, lng: float) -> tuple[float, float]:
    x, y = lng - 0.0065, lat - 0.006
    z = math.sqrt(x * x + y * y) - 0.00002 * math.sin(y * _X_PI)
    theta = math.atan2(y, x) - 0.000003 * math.cos(x * _X_PI)
    return z * math.sin(theta), z * math.cos(theta)


def wgs84_to_bd09(lat: float, lng: float) -> tuple[float, float]:
    return gcj02_to_bd09(*wgs84_to_gcj02(lat, lng))


def bd09_to_wgs84(lat: float, lng: float) -> tuple[float, float]:
    return gcj02_to_wgs84(*bd09_to_gcj02(lat, lng))


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))
