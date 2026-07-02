"""NIFC WFIGS wildfire data for Home Weather (no API key).

Sources:
- WFIGS_Incident_Locations_Current — active incident points (NIFC ArcGIS REST)
- WFIGS_Interagency_Perimeters_Current — current fire perimeters
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import dt as dt_util

from .hurricane_data import get_home_coordinates
from .hurricane_geo import haversine_distance_miles

_LOGGER = logging.getLogger(__name__)

WFIGS_BASE = (
    "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services"
)
INCIDENTS_QUERY = (
    f"{WFIGS_BASE}/WFIGS_Incident_Locations_Current/FeatureServer/0/query"
)
PERIMETERS_QUERY = (
    f"{WFIGS_BASE}/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query"
)

INCIDENT_FIELDS = (
    "IncidentName,FireDiscoveryDateTime,PercentContained,IncidentSize,"
    "DiscoveryAcres,IncidentTypeCategory,POOState,POOCounty,"
    "IncidentComplexityLevel,FireCause,LocalIncidentIdentifier"
)
PERIMETER_FIELDS = (
    "attr_IncidentName,attr_IncidentSize,attr_PercentContained,attr_POOState,"
    "attr_POOCounty,attr_IncidentTypeCategory,attr_FireDiscoveryDateTime,"
    "poly_GISAcres,poly_DateCurrent"
)

EMPTY_GEOJSON: dict[str, Any] = {"type": "FeatureCollection", "features": []}


def get_wildfire_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """Return merged wildfire monitoring settings."""
    defaults = {
        "enabled": True,
        "show_on_map": True,
        "show_perimeters": True,
        "min_acres": 100,
        "exclude_prescribed": True,
    }
    monitoring = (config or {}).get("wildfire_monitoring") or {}
    merged = {**defaults, **monitoring}
    try:
        merged["min_acres"] = max(0.0, float(merged.get("min_acres") or 0))
    except (TypeError, ValueError):
        merged["min_acres"] = defaults["min_acres"]
    return merged


def _to_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _format_epoch_ms(value: Any) -> str | None:
    ms = _to_float(value)
    if ms is None:
        return None
    try:
        return dt_util.utc_from_timestamp(ms / 1000.0).isoformat()
    except (OSError, OverflowError, ValueError):
        return None


def _state_label(code: Any) -> str:
    text = str(code or "").strip()
    if text.startswith("US-"):
        return text[3:]
    return text


def _incident_acres(attrs: dict[str, Any]) -> float:
    for key in ("IncidentSize", "DiscoveryAcres", "FinalAcres"):
        val = _to_float(attrs.get(key))
        if val is not None and val > 0:
            return val
    return 0.0


def _perimeter_acres(attrs: dict[str, Any]) -> float:
    for key in ("poly_GISAcres", "attr_IncidentSize", "attr_CalculatedAcres"):
        val = _to_float(attrs.get(key))
        if val is not None and val > 0:
            return val
    return 0.0


def wildfire_color(acres: float, percent_contained: float | None, category: str) -> str:
    """Return map color hex for a wildfire feature."""
    if category == "RX":
        return "#9e9e9e"
    if percent_contained is not None and percent_contained >= 100:
        return "#ffb74d"
    if acres >= 10000:
        return "#b71c1c"
    if acres >= 1000:
        return "#e53935"
    if acres >= 100:
        return "#ff7043"
    return "#ffa726"


def arcgis_point_feature(
    attrs: dict[str, Any],
    geometry: dict[str, Any],
    *,
    home: dict[str, float],
    layer: str,
) -> dict[str, Any] | None:
    """Convert an ArcGIS point feature to GeoJSON."""
    x = _to_float(geometry.get("x"))
    y = _to_float(geometry.get("y"))
    if x is None or y is None:
        return None

    category = str(attrs.get("IncidentTypeCategory") or "").strip().upper()
    acres = _incident_acres(attrs)
    contained = _to_float(attrs.get("PercentContained"))
    name = str(attrs.get("IncidentName") or "Wildfire").strip()
    state = _state_label(attrs.get("POOState"))
    county = str(attrs.get("POOCounty") or "").strip()
    location = ", ".join(p for p in (county, state) if p) or state or "Unknown"

    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [x, y]},
        "properties": {
            "layer": layer,
            "name": name,
            "acres": round(acres, 1) if acres else 0,
            "percent_contained": contained,
            "category": category,
            "state": state,
            "county": county,
            "location": location,
            "fire_cause": str(attrs.get("FireCause") or "").strip(),
            "discovery_time": _format_epoch_ms(attrs.get("FireDiscoveryDateTime")),
            "color": wildfire_color(acres, contained, category),
            "distance_miles": round(
                haversine_distance_miles(home["lat"], home["lon"], y, x), 1
            ),
            "source": "NIFC WFIGS",
        },
    }


def arcgis_polygon_feature(
    attrs: dict[str, Any],
    geometry: dict[str, Any],
    *,
    home: dict[str, float],
    layer: str,
) -> dict[str, Any] | None:
    """Convert an ArcGIS polygon feature to GeoJSON."""
    rings = geometry.get("rings")
    if not rings:
        return None

    coordinates: list[list[list[float]]] = []
    for ring in rings:
        if not ring:
            continue
        line = [[float(pt[0]), float(pt[1])] for pt in ring if len(pt) >= 2]
        if len(line) >= 4:
            coordinates.append(line)
    if not coordinates:
        return None

    category = str(
        attrs.get("attr_IncidentTypeCategory") or attrs.get("IncidentTypeCategory") or ""
    ).strip().upper()
    acres = _perimeter_acres(attrs)
    contained = _to_float(attrs.get("attr_PercentContained") or attrs.get("PercentContained"))
    name = str(attrs.get("attr_IncidentName") or attrs.get("IncidentName") or "Wildfire").strip()
    state = _state_label(attrs.get("attr_POOState") or attrs.get("POOState"))
    county = str(attrs.get("attr_POOCounty") or attrs.get("POOCounty") or "").strip()
    location = ", ".join(p for p in (county, state) if p) or state or "Unknown"

    # Centroid-ish point from first coordinate for distance sorting.
    first = coordinates[0][0]
    lon, lat = first[0], first[1]

    return {
        "type": "Feature",
        "geometry": {"type": "Polygon", "coordinates": coordinates},
        "properties": {
            "layer": layer,
            "name": name,
            "acres": round(acres, 1) if acres else 0,
            "percent_contained": contained,
            "category": category,
            "state": state,
            "county": county,
            "location": location,
            "discovery_time": _format_epoch_ms(
                attrs.get("attr_FireDiscoveryDateTime") or attrs.get("FireDiscoveryDateTime")
            ),
            "updated_time": _format_epoch_ms(
                attrs.get("poly_DateCurrent") or attrs.get("DateCurrent")
            ),
            "color": wildfire_color(acres, contained, category),
            "distance_miles": round(
                haversine_distance_miles(home["lat"], home["lon"], lat, lon), 1
            ),
            "source": "NIFC WFIGS",
        },
    }


def passes_wildfire_filter(
    props: dict[str, Any],
    wildfire_config: dict[str, Any],
    *,
    is_perimeter: bool = False,
) -> bool:
    """Return True when a wildfire feature meets monitoring filters."""
    if not wildfire_config.get("enabled", True):
        return False
    category = str(props.get("category") or "").upper()
    if wildfire_config.get("exclude_prescribed", True) and category == "RX":
        return False
    min_acres = float(wildfire_config.get("min_acres") or 0)
    acres = float(props.get("acres") or 0)
    if acres < min_acres:
        return False
    if is_perimeter and not wildfire_config.get("show_perimeters", True):
        return False
    return True


def build_wildfire_geojson(
    point_features: list[dict[str, Any]],
    perimeter_features: list[dict[str, Any]],
    wildfire_config: dict[str, Any],
) -> dict[str, Any]:
    """Build combined map GeoJSON for wildfires."""
    if not wildfire_config.get("show_on_map", True):
        return EMPTY_GEOJSON

    features: list[dict[str, Any]] = []
    for feature in perimeter_features:
        props = feature.get("properties") or {}
        if passes_wildfire_filter(props, wildfire_config, is_perimeter=True):
            features.append(feature)
    for feature in point_features:
        props = feature.get("properties") or {}
        if passes_wildfire_filter(props, wildfire_config, is_perimeter=False):
            features.append(feature)
    return {"type": "FeatureCollection", "features": features}


def build_coordinator_payload(
    point_features: list[dict[str, Any]],
    perimeter_features: list[dict[str, Any]],
    wildfire_config: dict[str, Any],
) -> dict[str, Any]:
    """Build coordinator payload for wildfire monitoring."""
    filtered_points = [
        f
        for f in point_features
        if passes_wildfire_filter(f.get("properties") or {}, wildfire_config)
    ]
    filtered_perimeters = [
        f
        for f in perimeter_features
        if passes_wildfire_filter(
            f.get("properties") or {}, wildfire_config, is_perimeter=True
        )
    ]
    geojson = build_wildfire_geojson(point_features, perimeter_features, wildfire_config)

    incidents = []
    for feature in filtered_points:
        props = dict(feature.get("properties") or {})
        coords = (feature.get("geometry") or {}).get("coordinates") or []
        if len(coords) >= 2:
            props["lon"] = coords[0]
            props["lat"] = coords[1]
        incidents.append(props)
    incidents.sort(key=lambda item: (-(item.get("acres") or 0), item.get("distance_miles") or 99999))

    nearest = incidents[0] if incidents else None
    active_uncontained = sum(
        1
        for item in incidents
        if item.get("category") != "RX"
        and (item.get("percent_contained") is None or item.get("percent_contained") < 100)
    )

    return {
        "incidents": incidents,
        "incident_count": len(filtered_points),
        "perimeter_count": len(filtered_perimeters),
        "active_uncontained_count": active_uncontained,
        "map_count": len(geojson.get("features") or []),
        "nearest_incident": nearest,
        "nearest_distance_miles": nearest.get("distance_miles") if nearest else None,
        "geojson": geojson,
        "source": "NIFC WFIGS",
    }


def empty_payload() -> dict[str, Any]:
    """Return an empty wildfire payload."""
    return build_coordinator_payload([], [], get_wildfire_config({}))


async def _fetch_arcgis_features(
    session: Any,
    url: str,
    *,
    out_fields: str,
    geometry_type: str,
) -> list[dict[str, Any]]:
    """Fetch all features from an ArcGIS FeatureServer query endpoint."""
    params = {
        "where": "1=1",
        "outFields": out_fields,
        "returnGeometry": "true",
        "outSR": "4326",
        "f": "json",
        "resultRecordCount": 2000,
    }
    features: list[dict[str, Any]] = []
    offset = 0
    while True:
        params["resultOffset"] = offset
        async with session.get(url, params=params, timeout=60) as resp:
            resp.raise_for_status()
            payload = await resp.json(content_type=None)
        if payload.get("error"):
            raise RuntimeError(str(payload["error"]))
        batch = payload.get("features") or []
        features.extend(batch)
        if not payload.get("exceededTransferLimit") or not batch:
            break
        offset += len(batch)
        if offset > 10000:
            _LOGGER.warning("WFIGS query truncated at %d features for %s", offset, url)
            break
    _LOGGER.debug("Fetched %d %s features from WFIGS", len(features), geometry_type)
    return features


async def async_fetch_wildfires(
    hass: HomeAssistant,
    config: dict[str, Any] | None,
) -> dict[str, Any]:
    """Fetch NIFC WFIGS wildfire incidents and perimeters."""
    wildfire_config = get_wildfire_config(config)
    if not wildfire_config.get("enabled", True):
        return empty_payload()

    home = get_home_coordinates(hass, config)
    session = async_get_clientsession(hass)

    raw_points, raw_polygons = await asyncio.gather(
        _fetch_arcgis_features(
            session, INCIDENTS_QUERY, out_fields=INCIDENT_FIELDS, geometry_type="point"
        ),
        _fetch_arcgis_features(
            session, PERIMETERS_QUERY, out_fields=PERIMETER_FIELDS, geometry_type="polygon"
        ),
    )

    point_features: list[dict[str, Any]] = []
    for item in raw_points:
        feature = arcgis_point_feature(
            item.get("attributes") or {},
            item.get("geometry") or {},
            home=home,
            layer="incident",
        )
        if feature:
            point_features.append(feature)

    perimeter_features: list[dict[str, Any]] = []
    for item in raw_polygons:
        feature = arcgis_polygon_feature(
            item.get("attributes") or {},
            item.get("geometry") or {},
            home=home,
            layer="perimeter",
        )
        if feature:
            perimeter_features.append(feature)

    return build_coordinator_payload(point_features, perimeter_features, wildfire_config)
