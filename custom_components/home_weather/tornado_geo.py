"""Geospatial helpers for tornado warning polygons."""
from __future__ import annotations

import math
from typing import Any

from .hurricane_geo import haversine_distance_miles, is_point_inside_polygon

SEVERITY_RANK = {
    "Extreme": 4,
    "Severe": 3,
    "Moderate": 2,
    "Minor": 1,
    "Unknown": 0,
}


def normalize_geojson_geometry(geometry: dict[str, Any] | None) -> dict[str, Any] | None:
    """Return a normalized Polygon or MultiPolygon geometry, or None if invalid."""
    if not geometry or not isinstance(geometry, dict):
        return None

    geom_type = geometry.get("type")
    if geom_type not in ("Polygon", "MultiPolygon"):
        return None

    coords = geometry.get("coordinates")
    if not coords:
        return None

    if geom_type == "Polygon":
        rings = [_normalize_ring(ring) for ring in coords if ring]
        rings = [ring for ring in rings if len(ring) >= 3]
        if not rings:
            return None
        return {"type": "Polygon", "coordinates": rings}

    polygons: list[list[list[list[float]]]] = []
    for poly in coords:
        if not poly:
            continue
        rings = [_normalize_ring(ring) for ring in poly if ring]
        rings = [ring for ring in rings if len(ring) >= 3]
        if rings:
            polygons.append(rings)
    if not polygons:
        return None
    return {"type": "MultiPolygon", "coordinates": polygons}


def _normalize_ring(ring: list[list[float]]) -> list[list[float]]:
    """Ensure polygon ring uses [lon, lat] float pairs."""
    normalized: list[list[float]] = []
    for coord in ring:
        if not coord or len(coord) < 2:
            continue
        try:
            normalized.append([float(coord[0]), float(coord[1])])
        except (TypeError, ValueError):
            continue
    return normalized


def point_in_polygon(lat: float, lon: float, polygon: dict[str, Any] | None) -> bool:
    """Return True if lat/lon is inside a GeoJSON Polygon or MultiPolygon."""
    return is_point_inside_polygon({"lat": lat, "lon": lon}, polygon)


def polygon_centroid(polygon: dict[str, Any] | None) -> dict[str, float] | None:
    """Return approximate centroid {lat, lon} for a Polygon or MultiPolygon."""
    if not polygon:
        return None

    points: list[tuple[float, float]] = []
    geom_type = polygon.get("type")
    if geom_type == "Polygon":
        rings = polygon.get("coordinates") or []
        if rings:
            points = [(c[1], c[0]) for c in rings[0] if len(c) >= 2]
    elif geom_type == "MultiPolygon":
        for poly in polygon.get("coordinates") or []:
            if poly and poly[0]:
                points.extend((c[1], c[0]) for c in poly[0] if len(c) >= 2)
    if not points:
        return None

    lat_sum = sum(p[0] for p in points)
    lon_sum = sum(p[1] for p in points)
    count = len(points)
    return {"lat": lat_sum / count, "lon": lon_sum / count}


def _iter_polygon_edges(polygon: dict[str, Any]):
    """Yield (lat1, lon1, lat2, lon2) edges for outer rings."""
    if polygon.get("type") == "Polygon":
        polys = [polygon.get("coordinates") or []]
    elif polygon.get("type") == "MultiPolygon":
        polys = polygon.get("coordinates") or []
    else:
        return

    for poly in polys:
        if not poly:
            continue
        ring = poly[0]
        if len(ring) < 2:
            continue
        for idx in range(len(ring)):
            lon1, lat1 = ring[idx][0], ring[idx][1]
            lon2, lat2 = ring[(idx + 1) % len(ring)][0], ring[(idx + 1) % len(ring)][1]
            yield lat1, lon1, lat2, lon2


def _point_to_segment_distance_miles(
    lat: float,
    lon: float,
    lat1: float,
    lon1: float,
    lat2: float,
    lon2: float,
    samples: int = 12,
) -> float:
    """Approximate shortest distance from point to segment by sampling."""
    best = float("inf")
    for step in range(samples + 1):
        t = step / samples
        sample_lat = lat1 + (lat2 - lat1) * t
        sample_lon = lon1 + (lon2 - lon1) * t
        dist = haversine_distance_miles(lat, lon, sample_lat, sample_lon)
        if dist < best:
            best = dist
    return best


def distance_to_polygon(
    lat: float,
    lon: float,
    polygon: dict[str, Any] | None,
) -> float | None:
    """Return miles from point to polygon edge/centroid; 0 if inside."""
    normalized = normalize_geojson_geometry(polygon)
    if not normalized:
        return None

    if point_in_polygon(lat, lon, normalized):
        return 0.0

    best = float("inf")
    for lat1, lon1, lat2, lon2 in _iter_polygon_edges(normalized):
        edge_dist = _point_to_segment_distance_miles(lat, lon, lat1, lon1, lat2, lon2)
        best = min(best, edge_dist)

    centroid = polygon_centroid(normalized)
    if centroid:
        best = min(
            best,
            haversine_distance_miles(lat, lon, centroid["lat"], centroid["lon"]),
        )

    return round(best, 1) if best != float("inf") else None
