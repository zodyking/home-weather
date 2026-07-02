"""Fetch and merge worldwide volcano data.

Sources (all free, keyless):
- Smithsonian GVP WFS  — worldwide Holocene volcano catalog (points, ~monthly updates)
- GDACS                — live worldwide volcano disaster alerts (Green/Orange/Red)
- USGS HANS            — US volcano alert levels + aviation color codes

Activity from GDACS/HANS is matched onto the catalog and normalized to a
unified level: ``advisory`` | ``watch`` | ``warning``. Each active volcano
gets an alert-scaled affected-area ring radius for the hazard map.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import dt as dt_util

from .hurricane_data import get_home_coordinates
from .hurricane_geo import haversine_distance_miles

_LOGGER = logging.getLogger(__name__)

GVP_CATALOG_URL = (
    "https://webservices.volcano.si.edu/geoserver/GVP-VOTW/wfs"
    "?service=WFS&version=1.0.0&request=GetFeature"
    "&typeName=GVP-VOTW:Smithsonian_Holocene_Volcanoes"
    "&outputFormat=application/json"
)
GDACS_EVENTS_URL = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH"
HANS_ELEVATED_URL = "https://volcanoes.usgs.gov/vsc/api/volcanoApi/elevated"

# How long the GVP catalog stays fresh before re-fetching (it changes ~monthly).
CATALOG_TTL = timedelta(hours=24)
# GDACS query window and staleness cutoff for events without iscurrent.
GDACS_QUERY_DAYS = 30
GDACS_STALE_DAYS = 7
# Max distance for matching a GDACS alert to a catalog volcano when names differ.
ACTIVITY_MATCH_MILES = 35.0

ACTIVITY_LEVELS = ("advisory", "watch", "warning")
ACTIVITY_RANK = {"advisory": 1, "watch": 2, "warning": 3}
# Affected-area ring radius (miles) per unified activity level.
RING_RADIUS_MILES = {"advisory": 10, "watch": 30, "warning": 60}
# Fallback aviation color per level when the source has none (e.g. GDACS).
LEVEL_COLOR = {"advisory": "YELLOW", "watch": "ORANGE", "warning": "RED"}

EMPTY_GEOJSON: dict[str, Any] = {"type": "FeatureCollection", "features": []}


def get_volcano_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """Return merged volcano monitoring config with defaults."""
    defaults = {
        "enabled": True,
        "zone_mode": "zone",
        "alert_zone_mode": "zone",
        "radius_miles": 500,
        "min_alert_level": "advisory",
        "map_show_all_volcanoes": True,
    }
    monitoring = (config or {}).get("volcano_monitoring") or {}
    merged = {**defaults, **monitoring}
    if merged["min_alert_level"] not in ACTIVITY_LEVELS:
        merged["min_alert_level"] = "advisory"
    return merged


def _prop(props: dict[str, Any], *names: str) -> Any:
    """Case-insensitive property lookup across candidate key names."""
    if not isinstance(props, dict):
        return None
    for name in names:
        if name in props and props[name] is not None:
            return props[name]
    lowered = {str(k).lower(): v for k, v in props.items()}
    for name in names:
        val = lowered.get(name.lower())
        if val is not None:
            return val
    return None


def _to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def normalize_activity_level(value: Any) -> str | None:
    """Map a source alert level to the unified advisory/watch/warning scale."""
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in ACTIVITY_RANK:
        return text
    # GDACS alert colors
    if text == "green":
        return "advisory"
    if text == "orange":
        return "watch"
    if text == "red":
        return "warning"
    return None


def parse_gvp_catalog(
    features: list[dict[str, Any]],
    home: dict[str, float],
) -> list[dict[str, Any]]:
    """Parse GVP WFS GeoJSON features into normalized catalog volcanoes."""
    home_lat = float(home["lat"])
    home_lon = float(home["lon"])
    volcanoes: list[dict[str, Any]] = []
    for feature in features or []:
        if not isinstance(feature, dict):
            continue
        props = feature.get("properties") or {}
        lat = _to_float(_prop(props, "Latitude"))
        lon = _to_float(_prop(props, "Longitude"))
        if lat is None or lon is None:
            geometry = feature.get("geometry") or {}
            coords = geometry.get("coordinates")
            if isinstance(coords, list) and len(coords) >= 2:
                lon = _to_float(coords[0])
                lat = _to_float(coords[1])
        if lat is None or lon is None:
            continue

        vnum = _prop(props, "Volcano_Number", "VolcanoNumber", "vnum")
        name = _prop(props, "Volcano_Name", "VolcanoName", "name")
        if not name:
            continue
        volcanoes.append(
            {
                "id": str(vnum) if vnum is not None else f"gvp-{name}",
                "vnum": str(vnum) if vnum is not None else None,
                "name": str(name),
                "country": str(_prop(props, "Country") or ""),
                "region": str(_prop(props, "Region") or ""),
                "type": str(_prop(props, "Primary_Volcano_Type", "VolcanoType") or ""),
                "elevation_m": _to_float(_prop(props, "Elevation", "Elevation_m")),
                "last_eruption_year": _prop(
                    props, "Last_Eruption_Year", "LastEruptionYear"
                ),
                "latitude": lat,
                "longitude": lon,
                "distance_miles": round(
                    haversine_distance_miles(home_lat, home_lon, lat, lon), 1
                ),
            }
        )
    return volcanoes


def _parse_gdacs_date(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def parse_gdacs_events(
    features: list[dict[str, Any]],
    *,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    """Parse GDACS volcano alert features into normalized activity records."""
    now = now or dt_util.utcnow()
    cutoff = now - timedelta(days=GDACS_STALE_DAYS)
    records: list[dict[str, Any]] = []
    for feature in features or []:
        if not isinstance(feature, dict):
            continue
        props = feature.get("properties") or {}
        if str(props.get("eventtype") or "").upper() not in ("VO", ""):
            continue
        level = normalize_activity_level(props.get("alertlevel"))
        if level is None:
            continue

        is_current = str(props.get("iscurrent")).strip().lower() == "true"
        todate = _parse_gdacs_date(props.get("todate"))
        if not is_current and (todate is None or todate < cutoff):
            continue

        geometry = feature.get("geometry") or {}
        coords = geometry.get("coordinates")
        lat = lon = None
        if isinstance(coords, list) and len(coords) >= 2:
            lon = _to_float(coords[0])
            lat = _to_float(coords[1])
        if lat is None or lon is None:
            continue

        event_id = props.get("eventid")
        records.append(
            {
                "source": "gdacs",
                "id": f"gdacs-{event_id}" if event_id is not None else None,
                "name": str(props.get("name") or props.get("eventname") or ""),
                "activity_level": level,
                "color_code": LEVEL_COLOR[level],
                "synopsis": str(props.get("description") or props.get("htmldescription") or ""),
                "url": str((props.get("url") or {}).get("report") or "") if isinstance(props.get("url"), dict) else str(props.get("url") or ""),
                "latitude": lat,
                "longitude": lon,
                "updated": str(props.get("todate") or props.get("fromdate") or ""),
            }
        )
    return records


def parse_hans_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Parse USGS HANS elevated-volcano records into normalized activity."""
    parsed: list[dict[str, Any]] = []
    for rec in records or []:
        if not isinstance(rec, dict):
            continue
        level = normalize_activity_level(rec.get("alertLevel"))
        if level is None:
            continue
        lat = _to_float(rec.get("lat"))
        lon = _to_float(rec.get("long") if rec.get("long") is not None else rec.get("lon"))
        vnum = rec.get("vnum")
        parsed.append(
            {
                "source": "usgs",
                "id": str(vnum) if vnum is not None else None,
                "vnum": str(vnum) if vnum is not None else None,
                "name": str(rec.get("vName") or rec.get("volcanoName") or ""),
                "activity_level": level,
                "color_code": str(rec.get("colorCode") or LEVEL_COLOR[level]).upper(),
                "synopsis": str(rec.get("noticeSynopsis") or ""),
                "url": str(rec.get("noticeUrl") or ""),
                "latitude": lat,
                "longitude": lon,
                "updated": str(rec.get("sentUtc") or rec.get("alertDate") or ""),
            }
        )
    return parsed


def _match_catalog_volcano(
    record: dict[str, Any],
    catalog: list[dict[str, Any]],
    by_vnum: dict[str, dict[str, Any]],
    by_name: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    """Match an activity record to a catalog volcano by vnum, name, or proximity."""
    vnum = record.get("vnum")
    if vnum and vnum in by_vnum:
        return by_vnum[vnum]

    name = str(record.get("name") or "").strip().lower()
    if name and name in by_name:
        return by_name[name]

    lat = record.get("latitude")
    lon = record.get("longitude")
    if lat is None or lon is None or not catalog:
        return None
    nearest = min(
        catalog,
        key=lambda v: haversine_distance_miles(lat, lon, v["latitude"], v["longitude"]),
    )
    if (
        haversine_distance_miles(lat, lon, nearest["latitude"], nearest["longitude"])
        <= ACTIVITY_MATCH_MILES
    ):
        return nearest
    return None


def merge_activity(
    catalog: list[dict[str, Any]],
    activity_records: list[dict[str, Any]],
    home: dict[str, float],
) -> list[dict[str, Any]]:
    """Merge GDACS/HANS activity onto the catalog -> active volcano events.

    When both sources report the same volcano, the higher level wins and the
    USGS synopsis/color takes precedence. Unmatched alerts become standalone
    active events using the alert's own coordinates.
    """
    by_vnum = {v["vnum"]: v for v in catalog if v.get("vnum")}
    by_name = {v["name"].strip().lower(): v for v in catalog if v.get("name")}
    home_lat = float(home["lat"])
    home_lon = float(home["lon"])

    active: dict[str, dict[str, Any]] = {}
    for record in activity_records:
        volcano = _match_catalog_volcano(record, catalog, by_vnum, by_name)
        if volcano is not None:
            key = volcano["id"]
            base = {
                "id": volcano["id"],
                "vnum": volcano.get("vnum"),
                "name": volcano["name"],
                "country": volcano.get("country", ""),
                "type": volcano.get("type", ""),
                "elevation_m": volcano.get("elevation_m"),
                "last_eruption_year": volcano.get("last_eruption_year"),
                "latitude": volcano["latitude"],
                "longitude": volcano["longitude"],
                "distance_miles": volcano.get("distance_miles"),
            }
        else:
            key = record.get("id") or f"{record['source']}-{record.get('name', '')}"
            lat = record.get("latitude")
            lon = record.get("longitude")
            base = {
                "id": key,
                "vnum": record.get("vnum"),
                "name": record.get("name") or "Unknown volcano",
                "country": "",
                "type": "",
                "elevation_m": None,
                "last_eruption_year": None,
                "latitude": lat,
                "longitude": lon,
                "distance_miles": (
                    round(haversine_distance_miles(home_lat, home_lon, lat, lon), 1)
                    if lat is not None and lon is not None
                    else None
                ),
            }

        level = record["activity_level"]
        existing = active.get(key)
        if existing is None:
            active[key] = {
                **base,
                "activity_level": level,
                "color_code": record.get("color_code") or LEVEL_COLOR[level],
                "synopsis": record.get("synopsis") or "",
                "url": record.get("url") or "",
                "updated": record.get("updated") or "",
                "sources": [record["source"]],
                "ring_radius_miles": RING_RADIUS_MILES[level],
            }
            continue

        if record["source"] not in existing["sources"]:
            existing["sources"].append(record["source"])
        if ACTIVITY_RANK[level] > ACTIVITY_RANK[existing["activity_level"]]:
            existing["activity_level"] = level
            existing["ring_radius_miles"] = RING_RADIUS_MILES[level]
        # USGS detail (synopsis/color/url) takes precedence over GDACS.
        if record["source"] == "usgs":
            existing["color_code"] = record.get("color_code") or existing["color_code"]
            existing["synopsis"] = record.get("synopsis") or existing["synopsis"]
            existing["url"] = record.get("url") or existing["url"]
            existing["updated"] = record.get("updated") or existing["updated"]

    events = list(active.values())
    events.sort(
        key=lambda e: (
            -ACTIVITY_RANK[e["activity_level"]],
            e.get("distance_miles") if e.get("distance_miles") is not None else float("inf"),
        )
    )
    return events


def passes_volcano_geofield_filter(
    event: dict[str, Any],
    volcano_config: dict[str, Any],
) -> bool:
    """Return True when an active volcano is inside the configured radius (ignores sensor bypass)."""
    level = event.get("activity_level")
    min_level = volcano_config.get("min_alert_level", "advisory")
    if level not in ACTIVITY_RANK:
        return False
    if ACTIVITY_RANK[level] < ACTIVITY_RANK.get(min_level, 1):
        return False

    radius = float(volcano_config.get("radius_miles", 500))
    distance = event.get("distance_miles")
    if distance is None or distance > radius:
        return False

    return True


def passes_volcano_filters(
    event: dict[str, Any],
    volcano_config: dict[str, Any],
) -> bool:
    """Return True when an active volcano meets sensor-scope filters (may bypass radius)."""
    level = event.get("activity_level")
    min_level = volcano_config.get("min_alert_level", "advisory")
    if level not in ACTIVITY_RANK:
        return False
    if ACTIVITY_RANK[level] < ACTIVITY_RANK.get(min_level, 1):
        return False

    if volcano_config.get("zone_mode", "zone") != "all":
        radius = float(volcano_config.get("radius_miles", 500))
        distance = event.get("distance_miles")
        if distance is None or distance > radius:
            return False

    return True


def pick_nearest_volcano(events: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Return the nearest active volcano (highest level wins ties)."""
    if not events:
        return None
    return min(
        events,
        key=lambda e: (
            e.get("distance_miles") if e.get("distance_miles") is not None else float("inf"),
            -ACTIVITY_RANK.get(e.get("activity_level") or "", 0),
        ),
    )


def build_volcano_geojson(
    catalog: list[dict[str, Any]],
    active_events: list[dict[str, Any]],
    *,
    geofield_ids: set[str] | None = None,
) -> dict[str, Any]:
    """Build a map-ready FeatureCollection: catalog points + active volcanoes.

    Active volcanoes replace their catalog point and carry activity properties
    (level, color, ring radius) so the frontend can pulse them and draw rings.
    """
    in_zone = geofield_ids or set()
    active_by_id = {e["id"]: e for e in active_events if e.get("id")}
    features: list[dict[str, Any]] = []

    def _feature(entry: dict[str, Any], active: dict[str, Any] | None) -> dict[str, Any]:
        props: dict[str, Any] = {
            "id": entry.get("id"),
            "name": entry.get("name"),
            "country": entry.get("country"),
            "type": entry.get("type"),
            "elevation_m": entry.get("elevation_m"),
            "last_eruption_year": entry.get("last_eruption_year"),
            "distance_miles": entry.get("distance_miles"),
            "active": active is not None,
        }
        if active is not None:
            props.update(
                {
                    "activity_level": active.get("activity_level"),
                    "color_code": active.get("color_code"),
                    "ring_radius_miles": active.get("ring_radius_miles"),
                    "synopsis": active.get("synopsis"),
                    "url": active.get("url"),
                    "sources": active.get("sources"),
                    "in_zone": str(active.get("id")) in in_zone,
                }
            )
        return {
            "type": "Feature",
            "id": str(entry.get("id") or ""),
            "properties": props,
            "geometry": {
                "type": "Point",
                "coordinates": [entry.get("longitude"), entry.get("latitude")],
            },
        }

    seen_active: set[str] = set()
    for volcano in catalog:
        active = active_by_id.get(volcano["id"])
        if active is not None:
            seen_active.add(volcano["id"])
            features.append(_feature(active, active))
        else:
            features.append(_feature(volcano, None))

    for event in active_events:
        if event.get("id") not in seen_active:
            features.append(_feature(event, event))

    return {"type": "FeatureCollection", "features": features}


def build_coordinator_payload(
    catalog: list[dict[str, Any]],
    active_events: list[dict[str, Any]],
    volcano_config: dict[str, Any],
) -> dict[str, Any]:
    """Build coordinator payload from the catalog and merged activity."""
    geofield_events = [
        e for e in active_events if passes_volcano_geofield_filter(e, volcano_config)
    ]
    sensor_events = [
        e for e in active_events if passes_volcano_filters(e, volcano_config)
    ]
    geofield_ids = {str(e["id"]) for e in geofield_events if e.get("id")}
    nearest = pick_nearest_volcano(sensor_events)
    # The full worldwide catalog is always plotted; inactive volcanoes render
    # as dim catalog points while active ones glow with their alert color.
    # Alert scope: bypass fires spoken alerts for all active volcanoes
    # regardless of zone or level; otherwise it mirrors the sensor geofield.
    alert_mode = str(
        volcano_config.get("alert_zone_mode", volcano_config.get("zone_mode", "zone"))
    ).lower()
    alert_events = active_events if alert_mode == "all" else geofield_events
    return {
        "catalog_count": len(catalog),
        "active_events": active_events,
        "geofield_events": geofield_events,
        "alert_events": alert_events,
        "active_count": len(active_events),
        "geofield_count": len(geofield_events),
        "in_geofield": len(geofield_events) > 0,
        "nearest_distance_miles": nearest.get("distance_miles") if nearest else None,
        "nearest_name": nearest.get("name") if nearest else None,
        "nearest_activity_level": nearest.get("activity_level") if nearest else None,
        "nearest_color_code": nearest.get("color_code") if nearest else None,
        "primary_geofield": nearest,
        "geojson": build_volcano_geojson(
            catalog,
            active_events,
            geofield_ids=geofield_ids,
        ),
        "last_updated": dt_util.utcnow().isoformat(),
    }


def empty_coordinator_payload() -> dict[str, Any]:
    """Return empty payload when monitoring is disabled or fetch failed."""
    return {
        "catalog_count": 0,
        "active_events": [],
        "geofield_events": [],
        "alert_events": [],
        "active_count": 0,
        "geofield_count": 0,
        "in_geofield": False,
        "nearest_distance_miles": None,
        "nearest_name": None,
        "nearest_activity_level": None,
        "nearest_color_code": None,
        "primary_geofield": None,
        "geojson": dict(EMPTY_GEOJSON),
        "last_updated": dt_util.utcnow().isoformat(),
    }


def _event_tracking_signature(event: dict[str, Any]) -> dict[str, Any]:
    return {
        "activity_level": event.get("activity_level"),
        "color_code": event.get("color_code"),
        "synopsis": event.get("synopsis"),
    }


def _event_payload(event: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": event.get("id"),
        "name": event.get("name"),
        "country": event.get("country"),
        "activity_level": event.get("activity_level"),
        "color_code": event.get("color_code"),
        "synopsis": event.get("synopsis"),
        "url": event.get("url"),
        "distance_miles": event.get("distance_miles"),
        "latitude": event.get("latitude"),
        "longitude": event.get("longitude"),
    }


def detect_volcano_events(
    previous: dict[str, dict[str, Any]],
    current_events: list[dict[str, Any]],
) -> list[tuple[str, dict[str, Any]]]:
    """Return bus events to fire: (event_type, payload)."""
    events_out: list[tuple[str, dict[str, Any]]] = []
    current_by_id = {str(e["id"]): e for e in current_events if e.get("id")}
    current_ids = set(current_by_id)

    for volcano_id, event in current_by_id.items():
        payload = _event_payload(event)
        prev = previous.get(volcano_id)
        if prev is None:
            events_out.append(("home_weather_volcano_activity_detected", payload))
            continue
        if _event_tracking_signature(prev) != _event_tracking_signature(event):
            events_out.append(("home_weather_volcano_activity_updated", payload))

    for volcano_id in set(previous) - current_ids:
        events_out.append(
            (
                "home_weather_volcano_activity_cleared",
                _event_payload(previous[volcano_id]),
            )
        )

    return events_out


async def _fetch_json(session: Any, url: str, label: str, *, params: dict | None = None) -> Any:
    """Fetch JSON from a source, returning None on failure."""
    try:
        async with session.get(url, params=params, timeout=30) as resp:
            if resp.status != 200:
                _LOGGER.warning("%s returned HTTP %s", label, resp.status)
                return None
            return await resp.json(content_type=None)
    except Exception as err:
        _LOGGER.warning("%s fetch failed: %s", label, err)
        return None


async def _fetch_gvp_catalog(session: Any, home: dict[str, float]) -> list[dict[str, Any]] | None:
    data = await _fetch_json(session, GVP_CATALOG_URL, "GVP volcano catalog")
    if not isinstance(data, dict):
        return None
    features = data.get("features")
    if not isinstance(features, list):
        return None
    return parse_gvp_catalog(features, home)


async def _fetch_gdacs_activity(session: Any) -> list[dict[str, Any]]:
    now = dt_util.utcnow()
    params = {
        "eventlist": "VO",
        "fromdate": (now - timedelta(days=GDACS_QUERY_DAYS)).date().isoformat(),
        "todate": now.date().isoformat(),
    }
    data = await _fetch_json(session, GDACS_EVENTS_URL, "GDACS volcano alerts", params=params)
    if not isinstance(data, dict):
        return []
    features = data.get("features")
    if not isinstance(features, list):
        return []
    return parse_gdacs_events(features, now=now)


async def _fetch_hans_activity(session: Any) -> list[dict[str, Any]]:
    data = await _fetch_json(session, HANS_ELEVATED_URL, "USGS HANS elevated volcanoes")
    if not isinstance(data, list):
        return []
    return parse_hans_records(data)


async def async_fetch_volcanoes(
    hass: HomeAssistant,
    config: dict[str, Any] | None = None,
    catalog_cache: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Fetch and merge volcano data from GVP + GDACS + USGS HANS.

    ``catalog_cache`` (owned by the coordinator) holds the GVP catalog with a
    24 h TTL so only the live activity feeds are hit every update cycle.
    """
    volcano_config = get_volcano_config(config)
    if not volcano_config.get("enabled", True):
        return empty_coordinator_payload()

    home = get_home_coordinates(hass, config)
    session = async_get_clientsession(hass)
    now = dt_util.utcnow()

    catalog: list[dict[str, Any]] = []
    cache_fresh = False
    if catalog_cache:
        fetched_at = catalog_cache.get("fetched_at")
        cached = catalog_cache.get("volcanoes")
        if (
            isinstance(cached, list)
            and cached
            and fetched_at is not None
            and now - fetched_at < CATALOG_TTL
            and catalog_cache.get("home") == (home.get("lat"), home.get("lon"))
        ):
            catalog = cached
            cache_fresh = True

    if cache_fresh:
        gdacs_records, hans_records = await asyncio.gather(
            _fetch_gdacs_activity(session),
            _fetch_hans_activity(session),
        )
    else:
        fetched_catalog, gdacs_records, hans_records = await asyncio.gather(
            _fetch_gvp_catalog(session, home),
            _fetch_gdacs_activity(session),
            _fetch_hans_activity(session),
        )
        if fetched_catalog is not None:
            catalog = fetched_catalog
            if catalog_cache is not None:
                catalog_cache["fetched_at"] = now
                catalog_cache["volcanoes"] = catalog
                catalog_cache["home"] = (home.get("lat"), home.get("lon"))
        elif catalog_cache and isinstance(catalog_cache.get("volcanoes"), list):
            # Keep serving a stale catalog rather than dropping the layer.
            catalog = catalog_cache["volcanoes"]

    active_events = merge_activity(catalog, hans_records + gdacs_records, home)
    return build_coordinator_payload(catalog, active_events, volcano_config)
