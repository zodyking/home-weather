"""Geospatial helpers for hurricane threat calculations."""
from __future__ import annotations

import math
from typing import Any

EARTH_RADIUS_MILES = 3958.8
KNOTS_TO_MPH = 1.15078

THREAT_LEVELS = ("none", "monitor", "watch", "high")
THREAT_RANK = {level: idx for idx, level in enumerate(THREAT_LEVELS)}


def haversine_distance_miles(
    lat1: float, lon1: float, lat2: float, lon2: float
) -> float:
    """Return great-circle distance in miles between two lat/lon points."""
    lat1_r = math.radians(lat1)
    lat2_r = math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)

    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1_r) * math.cos(lat2_r) * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return EARTH_RADIUS_MILES * c


def _normalize_ring(ring: list[list[float]]) -> list[list[float]]:
    """Ensure polygon ring uses [lon, lat] pairs."""
    if not ring:
        return ring
    normalized: list[list[float]] = []
    for coord in ring:
        if len(coord) < 2:
            continue
        lon, lat = float(coord[0]), float(coord[1])
        normalized.append([lon, lat])
    return normalized


def is_point_inside_polygon(
    point: dict[str, float],
    polygon: dict[str, Any] | None,
) -> bool:
    """Return True if point is inside a GeoJSON Polygon or MultiPolygon."""
    if not polygon or polygon.get("type") not in ("Polygon", "MultiPolygon"):
        return False

    lat = float(point["lat"])
    lon = float(point["lon"])
    x, y = lon, lat

    if polygon["type"] == "Polygon":
        rings = polygon.get("coordinates") or []
        if not rings:
            return False
        outer = _normalize_ring(rings[0])
        if not _point_in_ring(x, y, outer):
            return False
        for hole in rings[1:]:
            if _point_in_ring(x, y, _normalize_ring(hole)):
                return False
        return True

    for poly in polygon.get("coordinates") or []:
        if not poly:
            continue
        outer = _normalize_ring(poly[0])
        if not _point_in_ring(x, y, outer):
            continue
        in_hole = False
        for hole in poly[1:]:
            if _point_in_ring(x, y, _normalize_ring(hole)):
                in_hole = True
                break
        if not in_hole:
            return True
    return False


def _point_in_ring(x: float, y: float, ring: list[list[float]]) -> bool:
    """Ray-casting point-in-polygon test for a single ring."""
    if len(ring) < 3:
        return False
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        intersects = ((yi > y) != (yj > y)) and (
            x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi
        )
        if intersects:
            inside = not inside
        j = i
    return inside


def get_nearest_forecast_point(
    home: dict[str, float],
    forecast_points: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Return nearest forecast point and distance in miles."""
    if not forecast_points:
        return None

    best: dict[str, Any] | None = None
    best_dist = float("inf")
    home_lat = float(home["lat"])
    home_lon = float(home["lon"])

    for pt in forecast_points:
        lat = pt.get("lat")
        lon = pt.get("lon")
        if lat is None or lon is None:
            continue
        dist = haversine_distance_miles(home_lat, home_lon, float(lat), float(lon))
        if dist < best_dist:
            best_dist = dist
            best = {**pt, "distanceMiles": round(dist, 1)}

    return best


def knots_to_mph(knots: float | None) -> int | None:
    """Convert knots to rounded mph."""
    if knots is None:
        return None
    try:
        return int(round(float(knots) * KNOTS_TO_MPH))
    except (TypeError, ValueError):
        return None


def format_movement(direction_deg: float | None, speed_knots: float | None) -> str | None:
    """Format storm movement like 'NW at 12 mph'."""
    if direction_deg is None and speed_knots is None:
        return None
    parts: list[str] = []
    if direction_deg is not None:
        parts.append(_compass_from_degrees(float(direction_deg)))
    if speed_knots is not None:
        mph = knots_to_mph(float(speed_knots))
        if mph is not None:
            parts.append(f"at {mph} mph")
    return " ".join(parts) if parts else None


def _compass_from_degrees(degrees: float) -> str:
    """Convert meteorological degrees to 16-point compass label."""
    labels = [
        "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
        "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
    ]
    idx = int((degrees % 360) / 22.5 + 0.5) % 16
    return labels[idx]


def get_storm_threat_status(
    home: dict[str, float],
    storm: dict[str, Any],
) -> dict[str, Any]:
    """Compute threat status for home relative to a storm."""
    inside_cone = is_point_inside_polygon(home, storm.get("cone"))

    nearest = get_nearest_forecast_point(home, storm.get("forecastPoints") or [])
    nearest_dist = nearest["distanceMiles"] if nearest else float("inf")
    nearest_hour = nearest.get("hour") if nearest else None

    if inside_cone and nearest_dist <= 75:
        threat_level = "high"
    elif inside_cone or nearest_dist <= 150:
        threat_level = "watch"
    elif nearest_dist <= 250:
        threat_level = "monitor"
    else:
        threat_level = "none"

    center = storm.get("currentPosition") or {}
    center_dist = None
    if center.get("lat") is not None and center.get("lon") is not None:
        center_dist = round(
            haversine_distance_miles(
                float(home["lat"]),
                float(home["lon"]),
                float(center["lat"]),
                float(center["lon"]),
            ),
            1,
        )

    return {
        "insideCone": inside_cone,
        "nearestTrackDistanceMiles": None if nearest_dist == float("inf") else nearest_dist,
        "nearestForecastHour": nearest_hour,
        "distanceToCenterMiles": center_dist,
        "threatLevel": threat_level,
    }


def pick_highest_threat(threat_levels: list[str]) -> str:
    """Return the highest-ranked threat level from a list."""
    if not threat_levels:
        return "none"
    return max(threat_levels, key=lambda level: THREAT_RANK.get(level, 0))


def _parse_probability(props: dict[str, Any]) -> int | None:
    """Extract highest numeric probability from NHC outlook properties."""
    best: int | None = None
    for key in ("prob7day", "prob2day", "risk7day", "risk2day"):
        raw = props.get(key)
        if raw is None:
            continue
        for token in str(raw).replace("%", " ").split():
            try:
                value = int(float(token))
            except (TypeError, ValueError):
                continue
            if 0 <= value <= 100:
                best = value if best is None else max(best, value)
    return best


def get_outlook_summary(
    home: dict[str, float],
    outlook: dict[str, Any] | None,
) -> dict[str, Any]:
    """Summarize NHC tropical outlook relative to home."""
    outlook = outlook or {}
    home_lat = float(home["lat"])
    home_lon = float(home["lon"])

    disturbance_count = 0
    nearest_dist: float | None = None
    inside_development = False
    highest_prob: int | None = None
    development_area_count = 0

    region_geo = outlook.get("developmentRegion")
    if isinstance(region_geo, dict) and region_geo.get("features"):
        for feature in region_geo["features"]:
            development_area_count += 1
            geometry = feature.get("geometry")
            props = feature.get("properties") or {}
            prob = _parse_probability(props)
            if prob is not None:
                highest_prob = prob if highest_prob is None else max(highest_prob, prob)
            if geometry and is_point_inside_polygon(home, geometry):
                inside_development = True

    for key in ("twoDayLocation", "sevenDayLocation"):
        geo = outlook.get(key)
        if not isinstance(geo, dict) or not geo.get("features"):
            continue
        for feature in geo["features"]:
            disturbance_count += 1
            geometry = feature.get("geometry") or {}
            coords = geometry.get("coordinates")
            if not coords or len(coords) < 2:
                continue
            lon, lat = float(coords[0]), float(coords[1])
            dist = haversine_distance_miles(home_lat, home_lon, lat, lon)
            nearest_dist = dist if nearest_dist is None else min(nearest_dist, dist)
            props = feature.get("properties") or {}
            prob = _parse_probability(props)
            if prob is not None:
                highest_prob = prob if highest_prob is None else max(highest_prob, prob)

    has_activity = (
        disturbance_count > 0
        or development_area_count > 0
        or inside_development
    )

    threat_level = "none"
    if inside_development or (nearest_dist is not None and nearest_dist <= 250):
        threat_level = "monitor"
    if inside_development or (nearest_dist is not None and nearest_dist <= 120):
        if highest_prob is not None and highest_prob >= 40:
            threat_level = "watch"
        elif nearest_dist is not None and nearest_dist <= 75:
            threat_level = "watch"

    return {
        "disturbanceCount": disturbance_count,
        "developmentAreaCount": development_area_count,
        "insideDevelopmentRegion": inside_development,
        "nearestDisturbanceMiles": round(nearest_dist, 1) if nearest_dist is not None else None,
        "highestFormationProbability": highest_prob,
        "outlookThreatLevel": threat_level,
        "hasOutlookActivity": has_activity,
    }
