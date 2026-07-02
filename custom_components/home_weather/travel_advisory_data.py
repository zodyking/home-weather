"""U.S. Department of State travel advisory data for Home Weather."""
from __future__ import annotations

import json
import logging
import re
from html import unescape
from pathlib import Path
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import dt as dt_util

_LOGGER = logging.getLogger(__name__)

TRAVEL_ADVISORIES_URL = "https://cadataapi.state.gov/api/TravelAdvisories"
TRAVEL_RSS_URL = "https://travel.state.gov/_res/rss/TAsTWs.xml"

LEVEL_NAMES = {
    1: "Exercise Normal Precautions",
    2: "Exercise Increased Caution",
    3: "Reconsider Travel",
    4: "Do Not Travel",
}

LEVEL_COLORS = {
    1: "#4caf50",
    2: "#fff176",
    3: "#ff9800",
    4: "#f44336",
}

# State Dept category code -> Natural Earth / world.geo.json country name.
CATEGORY_TO_GEO_NAME: dict[str, str] = {
    "CH": "China",
    "HK": "China",
    "MC": "China",
    "UK": "United Kingdom",
    "GM": "Germany",
    "VM": "Vietnam",
    "EI": "Ireland",
    "SP": "Spain",
    "US": "United States of America",
}

# Parsed advisory title -> geojson country name overrides.
TITLE_TO_GEO_NAME: dict[str, str] = {
    "Burma": "Myanmar",
    "Czechia": "Czech Republic",
    "Cote d Ivoire": "Côte d'Ivoire",
    "Eswatini": "Swaziland",
    "United States": "United States of America",
    "Federated States of Micronesia": "Micronesia",
    "Cabo Verde": "Cape Verde",
    "The Gambia": "Gambia",
    "Mainland China, Hong Kong & Macau": "China",
    "Kingdom of Denmark": "Denmark",
    "Republic of Korea": "South Korea",
    "Democratic People's Republic of Korea": "North Korea",
    "Russia": "Russia",
    "Turkiye": "Turkey",
}

EMPTY_GEOJSON: dict[str, Any] = {"type": "FeatureCollection", "features": []}

_TITLE_RE = re.compile(r"^(.+?) - Level (\d): (.+)$", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")


def get_travel_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """Return merged travel monitoring + alert settings."""
    defaults_monitoring = {
        "enabled": True,
        "show_on_map": True,
        "min_level": 1,
    }
    monitoring = (config or {}).get("travel_monitoring") or {}
    return {**defaults_monitoring, **monitoring}


def get_travel_alerts_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """Return merged travel alert (TTS) settings."""
    defaults = {
        "enabled": False,
        "sound_file": "",
        "sound_volume": 0.8,
        "tts_volume": 0.9,
        "min_level": 3,
        "announce_level_changes": True,
        "announce_new_advisories": True,
        "watched_countries": [],
    }
    alerts = (config or {}).get("travel_alerts") or {}
    return {**defaults, **alerts}


def _strip_html(text: str) -> str:
    if not text:
        return ""
    plain = _TAG_RE.sub(" ", unescape(text))
    return re.sub(r"\s+", " ", plain).strip()


def parse_advisory_title(title: str) -> tuple[str, int, str]:
    """Parse 'Country - Level N: Label' into (country, level, level_label)."""
    cleaned = re.sub(r"\s*-\s*See Summaries.*$", "", (title or "").strip(), flags=re.I)
    match = _TITLE_RE.match(cleaned)
    if not match:
        return cleaned, 0, ""
    country, level_str, label = match.groups()
    try:
        level = int(level_str)
    except ValueError:
        level = 0
    return country.strip(), level, label.strip()


def _normalize_lookup_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).strip()


def _load_countries_geojson() -> dict[str, Any]:
    path = Path(__file__).parent / "www" / "countries.geo.json"
    try:
        with path.open(encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict) and isinstance(data.get("features"), list):
            return data
    except Exception as err:
        _LOGGER.warning("Could not load bundled countries geojson: %s", err)
    return dict(EMPTY_GEOJSON)


def _build_geo_name_index(geojson: dict[str, Any]) -> dict[str, str]:
    index: dict[str, str] = {}
    for feature in geojson.get("features") or []:
        if not isinstance(feature, dict):
            continue
        name = (feature.get("properties") or {}).get("name")
        if not name:
            continue
        index[_normalize_lookup_key(str(name))] = str(name)
    for alias, target in TITLE_TO_GEO_NAME.items():
        key = _normalize_lookup_key(target)
        if key in index:
            index[_normalize_lookup_key(alias)] = index[key]
    return index


def resolve_geo_country_name(
    country: str,
    category_codes: list[str] | None,
    geo_index: dict[str, str],
) -> str | None:
    """Map a State Dept advisory to a bundled geojson country name."""
    for code in category_codes or []:
        mapped = CATEGORY_TO_GEO_NAME.get(str(code).upper())
        if mapped:
            key = _normalize_lookup_key(mapped)
            if key in geo_index:
                return geo_index[key]

    for candidate in (country, country.split(",")[0].strip()):
        override = TITLE_TO_GEO_NAME.get(candidate)
        if override:
            key = _normalize_lookup_key(override)
            if key in geo_index:
                return geo_index[key]
        key = _normalize_lookup_key(candidate)
        if key in geo_index:
            return geo_index[key]
    return None


def parse_travel_advisories(raw_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Normalize State Dept travel advisory API records."""
    advisories: list[dict[str, Any]] = []
    for item in raw_items or []:
        if not isinstance(item, dict):
            continue
        title = str(item.get("Title") or "")
        country, level, level_label = parse_advisory_title(title)
        if not country or level < 1:
            continue
        categories = item.get("Category") or []
        if not isinstance(categories, list):
            categories = [categories]
        codes = [str(c).upper() for c in categories if c]
        advisory_id = codes[0] if codes else _normalize_lookup_key(country).replace(" ", "_")
        summary_html = str(item.get("Summary") or "")
        advisories.append(
            {
                "id": advisory_id,
                "country": country,
                "category_codes": codes,
                "level": level,
                "level_label": level_label or LEVEL_NAMES.get(level, f"Level {level}"),
                "level_name": LEVEL_NAMES.get(level, f"Level {level}"),
                "title": title,
                "link": str(item.get("Link") or ""),
                "summary_html": summary_html,
                "summary_text": _strip_html(summary_html),
                "color": LEVEL_COLORS.get(level, "#9e9e9e"),
            }
        )
    advisories.sort(key=lambda a: (-int(a.get("level") or 0), str(a.get("country") or "")))
    return advisories


def build_travel_advisory_geojson(
    advisories: list[dict[str, Any]],
    geojson: dict[str, Any],
    *,
    min_level: int = 1,
) -> dict[str, Any]:
    """Merge advisories onto country polygons for choropleth display."""
    geo_index = _build_geo_name_index(geojson)
    by_geo_name: dict[str, dict[str, Any]] = {}
    for advisory in advisories:
        if int(advisory.get("level") or 0) < min_level:
            continue
        geo_name = resolve_geo_country_name(
            str(advisory.get("country") or ""),
            advisory.get("category_codes"),
            geo_index,
        )
        if not geo_name:
            continue
        existing = by_geo_name.get(geo_name)
        if existing is None or int(advisory.get("level") or 0) > int(existing.get("level") or 0):
            by_geo_name[geo_name] = advisory

    features: list[dict[str, Any]] = []
    for feature in geojson.get("features") or []:
        if not isinstance(feature, dict):
            continue
        props = dict(feature.get("properties") or {})
        geo_name = str(props.get("name") or "")
        advisory = by_geo_name.get(geo_name)
        if not advisory:
            continue
        merged_props = {
            **props,
            "advisory_id": advisory.get("id"),
            "country": advisory.get("country"),
            "level": advisory.get("level"),
            "level_label": advisory.get("level_label"),
            "level_name": advisory.get("level_name"),
            "color": advisory.get("color"),
            "title": advisory.get("title"),
            "link": advisory.get("link"),
            "summary_text": advisory.get("summary_text"),
        }
        features.append(
            {
                "type": "Feature",
                "geometry": feature.get("geometry"),
                "properties": merged_props,
            }
        )
    return {"type": "FeatureCollection", "features": features}


def build_coordinator_payload(
    advisories: list[dict[str, Any]],
    travel_config: dict[str, Any],
    countries_geojson: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build coordinator payload for travel advisories."""
    min_level = max(1, min(4, int(travel_config.get("min_level") or 1)))
    level_counts = {1: 0, 2: 0, 3: 0, 4: 0}
    for advisory in advisories:
        lvl = int(advisory.get("level") or 0)
        if lvl in level_counts:
            level_counts[lvl] += 1

    geo_source = countries_geojson if isinstance(countries_geojson, dict) else _load_countries_geojson()
    geojson = (
        build_travel_advisory_geojson(advisories, geo_source, min_level=min_level)
        if travel_config.get("show_on_map", True)
        else dict(EMPTY_GEOJSON)
    )
    return {
        "advisories": advisories,
        "advisory_count": len(advisories),
        "level_counts": level_counts,
        "geojson": geojson,
        "map_count": len(geojson.get("features") or []),
        "min_level": min_level,
        "last_updated": dt_util.utcnow().isoformat(),
    }


def empty_coordinator_payload() -> dict[str, Any]:
    """Return an empty travel advisory payload."""
    return build_coordinator_payload([], get_travel_config({}), EMPTY_GEOJSON)


def passes_travel_alert_filter(
    advisory: dict[str, Any],
    alerts_config: dict[str, Any],
) -> bool:
    """Return True when an advisory should trigger spoken alerts."""
    min_level = max(1, min(4, int(alerts_config.get("min_level") or 3)))
    if int(advisory.get("level") or 0) < min_level:
        return False
    watched = alerts_config.get("watched_countries") or []
    if not watched:
        return True
    watched_set = {str(w).upper() for w in watched}
    country = str(advisory.get("country") or "").lower()
    codes = {str(c).upper() for c in (advisory.get("category_codes") or [])}
    return (
        country in {w.lower() for w in watched}
        or bool(codes & watched_set)
        or any(w.lower() in country for w in watched)
    )


def detect_travel_advisory_changes(
    previous: dict[str, dict[str, Any]],
    current: list[dict[str, Any]],
    alerts_config: dict[str, Any],
) -> list[tuple[str, dict[str, Any]]]:
    """Detect new or level-changed advisories for TTS."""
    events: list[tuple[str, dict[str, Any]]] = []
    announce_new = alerts_config.get("announce_new_advisories", True)
    announce_changes = alerts_config.get("announce_level_changes", True)

    current_by_id = {str(a["id"]): a for a in current if a.get("id")}
    for advisory_id, advisory in current_by_id.items():
        if not passes_travel_alert_filter(advisory, alerts_config):
            continue
        prev = previous.get(advisory_id)
        if prev is None:
            if announce_new:
                events.append(("home_weather_travel_advisory_new", advisory))
        elif announce_changes and int(prev.get("level") or 0) != int(advisory.get("level") or 0):
            events.append(("home_weather_travel_advisory_changed", advisory))
    return events


async def async_fetch_travel_advisories(
    hass: HomeAssistant,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Fetch U.S. State Department travel advisories and build map payload."""
    travel_config = get_travel_config(config)
    if not travel_config.get("enabled", True):
        return empty_coordinator_payload()

    session = async_get_clientsession(hass)
    try:
        async with session.get(TRAVEL_ADVISORIES_URL, timeout=60) as resp:
            if resp.status != 200:
                _LOGGER.warning("Travel advisories API returned %s", resp.status)
                return empty_coordinator_payload()
            raw = await resp.json()
    except Exception as err:
        _LOGGER.warning("Travel advisories fetch failed: %s", err)
        return empty_coordinator_payload()

    if not isinstance(raw, list):
        _LOGGER.warning("Travel advisories API returned unexpected payload")
        return empty_coordinator_payload()

    advisories = parse_travel_advisories(raw)
    return build_coordinator_payload(advisories, travel_config)
