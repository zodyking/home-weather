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
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from aiohttp import ClientTimeout

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import dt as dt_util

from .http_retry import DEFAULT_BACKOFF_BASE, DEFAULT_BACKOFF_MAX
from .hurricane_data import get_home_coordinates
from .sensor_scope import is_sensor_bypass, pick_nearest_by_distance
from .hurricane_geo import haversine_distance_miles

_LOGGER = logging.getLogger(__name__)

GVP_CATALOG_URL = (
    "https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows"
    "?service=WFS&version=1.0.0&request=GetFeature"
    "&typeName=GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes"
    "&outputFormat=application/json"
)
GDACS_EVENTS_URL = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH"
HANS_ELEVATED_URL = "https://volcanoes.usgs.gov/vsc/api/volcanoApi/elevated"

# How long the GVP catalog stays fresh before re-fetching (it changes ~monthly).
CATALOG_TTL = timedelta(hours=24)
# GDACS query window and staleness cutoff for events without iscurrent.
GDACS_QUERY_DAYS = 7
GDACS_STALE_DAYS = 7
GDACS_WARNING_COOLDOWN = timedelta(hours=1)
GDACS_BACKOFF = timedelta(hours=6)
# One attempt. A hanging SEARCH call must not be retried in a loop; the
# caller tries one smaller query before the long backoff.
GDACS_TIMEOUT_SECONDS = 25
# Official GDACS quickstart (2025): semicolon-separated alert colors.
GDACS_ALERT_LEVELS = "green;orange;red"
GDACS_HEADERS = {
    "Accept": "application/json, application/geo+json",
    "User-Agent": "Home-Weather/1.0 (volcano monitor)",
}
_gdacs_last_warning_at: datetime | None = None
_gdacs_backoff_until: datetime | None = None
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


def select_volcano_map_features(
    features: list[dict[str, Any]],
    *,
    show_all: bool = False,
) -> list[dict[str, Any]]:
    """Choose which volcano features the hazard map plots.

    The default is the active subset (features the activity merge marked
    ``active``: advisory, watch, or warning). ``show_all`` returns the full
    catalog plus those active volcanoes — the set the layer used to plot.
    """
    chosen: list[dict[str, Any]] = []
    for feature in features or []:
        if not isinstance(feature, dict):
            continue
        if show_all or (feature.get("properties") or {}).get("active"):
            chosen.append(feature)
    return chosen


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
    if is_sensor_bypass(volcano_config):
        nearest = pick_nearest_by_distance(sensor_events)
    else:
        nearest = pick_nearest_volcano(sensor_events)
    # GeoJSON keeps the full catalog so the map can offer "Show all".
    # The map's default is active-only (advisory / watch / warning).
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


def _extract_xml_service_exception(text: str) -> str | None:
    """Return the GeoServer/OGC ServiceException message from an XML body."""
    match = re.search(r"<ServiceException[^>]*>(.*?)</ServiceException>", text, re.DOTALL)
    if not match:
        return None
    return " ".join(match.group(1).split())


def _format_fetch_error(err: BaseException) -> str:
    """Return a useful fetch error string even when ``str(err)`` is empty."""
    text = str(err).strip()
    if text:
        return f"{type(err).__name__}: {text}"
    return type(err).__name__


def _gdacs_in_backoff(now: datetime) -> bool:
    """Return True when GDACS requests should be skipped after a recent outage."""
    return _gdacs_backoff_until is not None and now < _gdacs_backoff_until


def _mark_gdacs_backoff(now: datetime) -> None:
    """Pause GDACS polling after the dated query and its smaller fallback both fail."""
    global _gdacs_backoff_until
    _gdacs_backoff_until = now + GDACS_BACKOFF


def _gdacs_warn_once(now: datetime, message: str, *args: Any) -> None:
    """Log one GDACS warning, then stay quiet for the cooldown window."""
    global _gdacs_last_warning_at
    if (
        _gdacs_last_warning_at is not None
        and now - _gdacs_last_warning_at < GDACS_WARNING_COOLDOWN
    ):
        _LOGGER.debug(message, *args)
        return
    _gdacs_last_warning_at = now
    _LOGGER.warning(message, *args)


def gdacs_volcano_search_params(now: datetime) -> dict[str, str]:
    """Documented GDACS SEARCH query for volcano alerts.

    The 2025 GDACS quickstart uses ``eventlist``, lowercase ``fromdate`` /
    ``todate`` (``YYYY-MM-DD``), and a semicolon-separated ``alertlevel``.
    ``eventtypes`` is not a SEARCH filter: the live API ignores it and
    returns other hazards. Non-ISO dates and the ``MAP`` output type
    return HTTP 400. An empty volcano window returns HTTP 204.
    """
    end = now.date()
    start = end - timedelta(days=GDACS_QUERY_DAYS)
    return {
        "eventlist": "VO",
        "fromdate": start.isoformat(),
        "todate": end.isoformat(),
        "alertlevel": GDACS_ALERT_LEVELS,
    }


def gdacs_volcano_alternate_params(now: datetime) -> dict[str, str]:
    """CamelCase date names the live SEARCH API also accepts.

    Used once when the documented lowercase query is rejected with HTTP 400,
    not as a substitute for fixing that query.
    """
    primary = gdacs_volcano_search_params(now)
    return {
        "eventlist": "VO",
        "fromDate": primary["fromdate"],
        "toDate": primary["todate"],
        "alertlevel": "Green;Orange;Red",
    }


def gdacs_volcano_compact_params() -> dict[str, str]:
    """Smaller undated orange/red query used when the dated request times out.

    Live SEARCH returns this as a few-kilobyte GeoJSON instead of hanging
    on the dated window. It is still ``eventlist=VO`` on the same endpoint.
    """
    return {"eventlist": "VO", "alertlevel": "orange;red"}


def _short_response_reason(status: int, body: str) -> str:
    """Status plus a short body excerpt, for a one-line warning."""
    detail = _extract_xml_service_exception(body) if body else None
    if not detail and body:
        detail = " ".join(body.split())
    if detail:
        return f"HTTP {status}: {detail[:160]}"
    if status == 400:
        return "HTTP 400: empty response body"
    return f"HTTP {status}"


def _gdacs_records_from_payload(payload: Any, now: datetime) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    features = payload.get("features")
    if not isinstance(features, list):
        return []
    return parse_gdacs_events(features, now=now)


async def _request_gdacs(
    session: Any,
    params: dict[str, str],
) -> tuple[str, Any, str]:
    """One GDACS GET. Returns ``(kind, payload, detail)`` and does not log.

    ``kind`` is ``ok``, ``empty``, ``bad_request``, ``unavailable``,
    ``timeout``, or ``error``. HTTP 204 is ``empty`` (no alerts).
    """
    try:
        async with session.get(
            GDACS_EVENTS_URL,
            params=params,
            headers=GDACS_HEADERS,
            timeout=ClientTimeout(total=GDACS_TIMEOUT_SECONDS),
        ) as resp:
            text = await resp.text()
            if resp.status == 204 or (resp.status == 200 and not text.strip()):
                return "empty", None, ""
            if resp.status == 400:
                return "bad_request", None, _short_response_reason(resp.status, text)
            if resp.status != 200:
                return "unavailable", None, _short_response_reason(resp.status, text)
            stripped = text.lstrip()
            content_type = (resp.headers.get("Content-Type") or "").lower()
            if stripped.startswith("<?xml") or (
                stripped.startswith("<") and "xml" in content_type
            ):
                detail = _extract_xml_service_exception(text) or "non-JSON XML response"
                return "error", None, detail
            try:
                return "ok", json.loads(text), ""
            except json.JSONDecodeError as err:
                return "error", None, f"invalid JSON ({_format_fetch_error(err)})"
    except TimeoutError:
        return "timeout", None, f"timed out after {GDACS_TIMEOUT_SECONDS}s"
    except Exception as err:  # noqa: BLE001 - keep GDACS failures off the other feeds
        return "error", None, _format_fetch_error(err)


async def _fetch_json(
    session: Any,
    url: str,
    label: str,
    *,
    params: dict | None = None,
    retries: int = 3,
) -> Any:
    """Fetch JSON from a source with retry logic, returning None on failure.

    GDACS uses :func:`_fetch_gdacs_activity` instead. This helper is the
    GVP catalog and USGS HANS feeds.
    """
    last_error: str | None = None
    for attempt in range(retries):
        try:
            client_timeout = ClientTimeout(total=30)
            async with session.get(url, params=params, timeout=client_timeout) as resp:
                if resp.status != 200:
                    _LOGGER.warning(
                        "%s returned HTTP %s (attempt %d/%d)",
                        label, resp.status, attempt + 1, retries
                    )
                    last_error = f"HTTP {resp.status}"
                    if attempt < retries - 1:
                        delay = min(DEFAULT_BACKOFF_BASE * (2 ** attempt), DEFAULT_BACKOFF_MAX)
                        await asyncio.sleep(delay)
                        continue
                    return None
                text = await resp.text()
                if not text.strip():
                    _LOGGER.warning("%s returned an empty response", label)
                    return None
                stripped = text.lstrip()
                content_type = (resp.headers.get("Content-Type") or "").lower()
                if stripped.startswith("<?xml") or "xml" in content_type:
                    detail = _extract_xml_service_exception(text) or "non-JSON XML response"
                    _LOGGER.warning("%s fetch failed: %s", label, detail)
                    return None
                if attempt > 0:
                    _LOGGER.info("%s fetch succeeded on attempt %d", label, attempt + 1)
                return json.loads(text)
        except json.JSONDecodeError as err:
            _LOGGER.warning("%s fetch failed: invalid JSON (%s)", label, _format_fetch_error(err))
            return None
        except Exception as err:
            detail = _format_fetch_error(err)
            last_error = detail
            _LOGGER.warning(
                "%s fetch failed: %s (attempt %d/%d)",
                label, detail, attempt + 1, retries
            )
            if attempt < retries - 1:
                delay = min(DEFAULT_BACKOFF_BASE * (2 ** attempt), DEFAULT_BACKOFF_MAX)
                await asyncio.sleep(delay)
                continue

    _LOGGER.warning("%s all %d attempts failed: %s", label, retries, last_error)
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
    """Fetch current GDACS volcano alerts.

    HTTP 204 is an empty alert list. A timeout tries one smaller query
    before the long backoff. Any miss returns no GDACS alerts so USGS HANS
    and the Smithsonian catalog still populate the map.
    """
    now = dt_util.utcnow()
    if _gdacs_in_backoff(now):
        _LOGGER.debug("GDACS volcano alerts fetch skipped during backoff")
        return []

    kind, payload, detail = await _request_gdacs(session, gdacs_volcano_search_params(now))
    if kind == "ok":
        return _gdacs_records_from_payload(payload, now)
    if kind == "empty":
        return []

    if kind == "bad_request":
        kind2, payload2, detail2 = await _request_gdacs(
            session, gdacs_volcano_alternate_params(now)
        )
        if kind2 == "ok":
            _gdacs_warn_once(
                now,
                "GDACS volcano alerts returned %s; alternate query succeeded",
                detail,
            )
            return _gdacs_records_from_payload(payload2, now)
        if kind2 == "empty":
            _gdacs_warn_once(
                now,
                "GDACS volcano alerts returned %s; alternate query had no alerts",
                detail,
            )
            return []
        _gdacs_warn_once(
            now,
            "GDACS volcano alerts returned %s",
            detail2 or detail,
        )
        _mark_gdacs_backoff(now)
        return []

    if kind in ("timeout", "unavailable"):
        kind2, payload2, _detail2 = await _request_gdacs(
            session, gdacs_volcano_compact_params()
        )
        if kind2 == "ok":
            _gdacs_warn_once(
                now,
                "GDACS volcano alerts %s; used a smaller alert query",
                detail,
            )
            return _gdacs_records_from_payload(payload2, now)
        if kind2 == "empty":
            _gdacs_warn_once(
                now,
                "GDACS volcano alerts %s; smaller query returned no alerts",
                detail,
            )
            return []
        if kind == "timeout":
            _gdacs_warn_once(
                now,
                "GDACS volcano alerts timed out after %ds; using other volcano sources",
                GDACS_TIMEOUT_SECONDS,
            )
        else:
            _gdacs_warn_once(
                now,
                "GDACS volcano alerts failed (%s); using other volcano sources",
                detail,
            )
        _mark_gdacs_backoff(now)
        return []

    _gdacs_warn_once(
        now,
        "GDACS volcano alerts fetch failed: %s; using other volcano sources",
        detail or kind,
    )
    _mark_gdacs_backoff(now)
    return []


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

    # An empty GDACS list still leaves USGS HANS activity on the catalog.
    active_events = merge_activity(catalog, hans_records + gdacs_records, home)
    return build_coordinator_payload(catalog, active_events, volcano_config)
