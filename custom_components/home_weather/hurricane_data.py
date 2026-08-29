"""Fetch and normalize NOAA/NHC hurricane GIS data."""
from __future__ import annotations

import asyncio
import logging
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from typing import Any

from aiohttp import ClientError, ClientTimeout

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import dt as dt_util

from .http_retry import DEFAULT_BACKOFF_BASE, DEFAULT_BACKOFF_MAX

from .hurricane_geo import (
    THREAT_RANK,
    format_movement,
    get_nearest_forecast_point,
    get_outlook_summary,
    get_storm_threat_status,
    haversine_distance_miles,
    knots_to_mph,
    pick_highest_threat,
)

_LOGGER = logging.getLogger(__name__)

ARCGIS_MAPSERVER = (
    "https://mapservices.weather.noaa.gov/tropical/rest/services/"
    "tropical/NHC_tropical_weather/MapServer"
)
ARCGIS_SUMMARY_MAPSERVER = (
    "https://mapservices.weather.noaa.gov/tropical/rest/services/"
    "tropical/NHC_tropical_weather_summary/MapServer"
)
NHC_ACTIVE_KML = "https://www.nhc.noaa.gov/gis/kml/nhc_active.kml"

WALLET_PATTERN = re.compile(r"^(AT|EP|CP)[1-5]$")
SUMMARY_OUTLOOK_LAYERS = {
    "twoDayLocation": 1,
    "sevenDayLocation": 2,
    "developmentRegion": 3,
    "developmentMotion": 33,
}
SUMMARY_STORM_LAYERS = {
    "Forecast Points": 5,
    "Forecast Track": 6,
    "Forecast Cone": 7,
    "Watch-Warning": 8,
    "Past Points": 10,
    "Past Track": 11,
    "Forecast Wind Radii": 15,
}
CACHE_TTL = timedelta(minutes=15)

KML_NS = {"kml": "http://www.opengis.net/kml/2.2"}


class HurricaneDataCache:
    """In-memory cache for hurricane data with stale fallback."""

    def __init__(self) -> None:
        self._payload: dict[str, Any] | None = None
        self._fetched_at: datetime | None = None

    def get_if_fresh(self) -> dict[str, Any] | None:
        if self._payload is None or self._fetched_at is None:
            return None
        if datetime.now(timezone.utc) - self._fetched_at > CACHE_TTL:
            return None
        return self._payload

    def get_stale(self) -> dict[str, Any] | None:
        return self._payload

    def set(self, payload: dict[str, Any]) -> None:
        self._payload = payload
        self._fetched_at = datetime.now(timezone.utc)


_CACHE = HurricaneDataCache()


def get_home_coordinates(hass: HomeAssistant, config: dict[str, Any] | None = None) -> dict[str, Any]:
    """Resolve home coordinates from Home Assistant's configured home location.

    Priority: ``zone.home`` (user-editable on the HA map), then ``hass.config``.
    Weather-entity latitude/longitude are intentionally excluded — those attributes
    refer to the provider's forecast grid point, not the user's home address.
    """
    _ = config  # reserved for future explicit home overrides in panel config
    label = "Home"

    zone = hass.states.get("zone.home")
    if zone:
        zlat = zone.attributes.get("latitude")
        zlon = zone.attributes.get("longitude")
        if zlat is not None and zlon is not None:
            try:
                return {
                    "lat": float(zlat),
                    "lon": float(zlon),
                    "label": label,
                }
            except (TypeError, ValueError):
                pass

    lat = hass.config.latitude
    lon = hass.config.longitude
    if lat is not None and lon is not None:
        try:
            return {
                "lat": float(lat),
                "lon": float(lon),
                "label": label,
            }
        except (TypeError, ValueError):
            pass

    return {"lat": 0.0, "lon": 0.0, "label": label}


async def async_get_hurricane_data(
    hass: HomeAssistant,
    config: dict[str, Any] | None = None,
    *,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """Return normalized hurricane data with home-relative summary."""
    if not force_refresh:
        cached = _CACHE.get_if_fresh()
        if cached is not None:
            return _attach_home_summary(hass, cached, config)

    session = async_get_clientsession(hass)
    warning: str | None = None
    stale = False
    source = "arcgis"

    try:
        storms, outlook = await _fetch_from_arcgis(session)
    except Exception as err:
        _LOGGER.warning("ArcGIS hurricane fetch failed: %s", err)
        storms = None
        outlook = {}

    if storms is None:
        try:
            storms = await _fetch_from_kml(session)
            outlook = {}
            source = "kml"
        except Exception as err:
            _LOGGER.warning("KML hurricane fetch failed: %s", err)
            stale_payload = _CACHE.get_stale()
            if stale_payload is not None:
                stale = True
                warning = "NOAA/NHC data temporarily unavailable. Showing last known data."
                result = dict(stale_payload)
                result["summary"] = dict(result.get("summary") or {})
                result["summary"]["stale"] = True
                result["summary"]["warning"] = warning
                return _attach_home_summary(hass, result, config)
            return _empty_payload(
                warning="Unable to fetch hurricane data from NOAA/NHC.",
                stale=False,
            )

    fetched_at = datetime.now(timezone.utc).isoformat()
    payload = {
        "storms": storms,
        "outlook": outlook,
        "source": source,
        "summary": {
            "activeCount": len(storms),
            "stale": stale,
            "warning": warning,
            "fetchedAt": fetched_at,
        },
    }
    _CACHE.set(payload)
    return _attach_home_summary(hass, payload, config)


def _attach_home_summary(
    hass: HomeAssistant,
    payload: dict[str, Any],
    config: dict[str, Any] | None,
) -> dict[str, Any]:
    home = get_home_coordinates(hass, config)
    storms = payload.get("storms") or []
    summary = dict(payload.get("summary") or {})

    closest_storm: dict[str, Any] | None = None
    closest_dist = float("inf")
    threat_levels: list[str] = []
    global_nearest_forecast: dict[str, Any] | None = None
    global_nearest_dist = float("inf")

    for storm in storms:
        threat = get_storm_threat_status(home, storm)
        storm["threat"] = threat
        threat_levels.append(threat["threatLevel"])

        center_dist = threat.get("distanceToCenterMiles")
        if center_dist is not None and center_dist < closest_dist:
            closest_dist = center_dist
            closest_storm = storm

        nearest = get_nearest_forecast_point(home, storm.get("forecastPoints") or [])
        if nearest and nearest["distanceMiles"] < global_nearest_dist:
            global_nearest_dist = nearest["distanceMiles"]
            global_nearest_forecast = {
                "stormId": storm.get("id"),
                "stormName": storm.get("name"),
                "hour": nearest.get("hour"),
                "distanceMiles": nearest["distanceMiles"],
            }

    inside_cone = any(storm.get("threat", {}).get("insideCone") for storm in storms)
    outlook_summary = get_outlook_summary(home, payload.get("outlook"))
    combined_threat = pick_highest_threat(
        threat_levels + [outlook_summary["outlookThreatLevel"]]
    )
    summary.update(
        {
            "activeCount": len(storms),
            "closestStormId": closest_storm.get("id") if closest_storm else None,
            "closestStormName": closest_storm.get("name") if closest_storm else None,
            "distanceToCenterMiles": closest_storm.get("threat", {}).get("distanceToCenterMiles")
            if closest_storm
            else None,
            "distanceToNearestForecastMiles": global_nearest_forecast["distanceMiles"]
            if global_nearest_forecast
            else None,
            "insideCone": inside_cone,
            "threatLevel": combined_threat,
            "estimatedClosestApproachHour": global_nearest_forecast["hour"]
            if global_nearest_forecast
            else None,
            **outlook_summary,
        }
    )

    return {**payload, "home": home, "summary": summary}


def _empty_payload(warning: str | None = None, stale: bool = False) -> dict[str, Any]:
    return {
        "storms": [],
        "outlook": {},
        "home": {"lat": 0.0, "lon": 0.0, "label": "Home"},
        "summary": {
            "activeCount": 0,
            "closestStormId": None,
            "closestStormName": None,
            "distanceToCenterMiles": None,
            "distanceToNearestForecastMiles": None,
            "insideCone": False,
            "threatLevel": "none",
            "estimatedClosestApproachHour": None,
            "stale": stale,
            "warning": warning,
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
        },
    }


async def _fetch_from_arcgis(session: Any, retries: int = 3) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    last_error: Exception | None = None
    metadata = None
    for attempt in range(retries):
        try:
            client_timeout = ClientTimeout(total=30)
            async with session.get(f"{ARCGIS_MAPSERVER}?f=json", timeout=client_timeout) as resp:
                resp.raise_for_status()
                metadata = await resp.json()
                if attempt > 0:
                    _LOGGER.info("ArcGIS hurricane metadata fetch succeeded on attempt %d", attempt + 1)
                break
        except (ClientError, asyncio.TimeoutError) as err:
            last_error = err
            _LOGGER.debug(
                "ArcGIS hurricane metadata fetch failed: %s (attempt %d/%d)",
                err, attempt + 1, retries
            )
            if attempt < retries - 1:
                delay = min(DEFAULT_BACKOFF_BASE * (2 ** attempt), DEFAULT_BACKOFF_MAX)
                await asyncio.sleep(delay)
                continue
            raise

    if metadata is None:
        raise last_error or RuntimeError("Failed to fetch ArcGIS metadata")

    layers = metadata.get("layers") or []
    wallets = _discover_storm_wallets(layers)
    storms: list[dict[str, Any]] = []

    for wallet, layer_map in wallets.items():
        points_layer = layer_map.get("Forecast Points")
        if points_layer is None:
            continue
        points_geo = await _query_layer_geojson(session, points_layer, ARCGIS_MAPSERVER)
        if not points_geo.get("features"):
            continue

        track_geo = await _query_layer_geojson(
            session, layer_map.get("Forecast Track"), ARCGIS_MAPSERVER
        )
        cone_geo = await _query_layer_geojson(
            session, layer_map.get("Forecast Cone"), ARCGIS_MAPSERVER
        )
        radii_geo = await _query_layer_geojson(
            session, layer_map.get("Forecast Wind Radii"), ARCGIS_MAPSERVER
        )
        watch_geo = await _query_layer_geojson(
            session, layer_map.get("Watch-Warning"), ARCGIS_MAPSERVER
        )
        past_track_geo = await _query_layer_geojson(
            session, layer_map.get("Past Track"), ARCGIS_MAPSERVER
        )
        past_points_geo = await _query_layer_geojson(
            session, layer_map.get("Past Points"), ARCGIS_MAPSERVER
        )

        storm = _normalize_arcgis_storm(wallet, points_geo, track_geo, cone_geo, radii_geo)
        if storm:
            storm["watchWarning"] = _geometry_from_features(
                watch_geo.get("features") or [], "LineString"
            )
            storm["pastTrack"] = _geometry_from_features(
                past_track_geo.get("features") or [], "LineString"
            )
            storm["pastPoints"] = _normalize_past_points(past_points_geo.get("features") or [])
            storms.append(storm)

    summary_storms = await _fetch_storms_from_summary(session)
    outlook = await _fetch_outlook_from_summary(session)
    storms = _merge_storm_lists(storms, summary_storms)
    return storms, outlook


def _discover_storm_wallets(layers: list[dict[str, Any]]) -> dict[str, dict[str, int]]:
    """Map storm wallet codes to sub-layer ids by name suffix."""
    by_id = {layer["id"]: layer for layer in layers if "id" in layer and "name" in layer}
    wallets: dict[str, dict[str, int]] = {}

    for layer in layers:
        name = layer.get("name") or ""
        if not WALLET_PATTERN.match(name):
            continue
        wallet = name
        wallets.setdefault(wallet, {})
        _collect_wallet_layers(wallet, layer.get("subLayerIds") or [], by_id, wallets)

    return wallets


def _collect_wallet_layers(
    wallet: str,
    sub_ids: list[int],
    by_id: dict[int, dict[str, Any]],
    wallets: dict[str, dict[str, int]],
) -> None:
    for layer_id in sub_ids:
        layer = by_id.get(layer_id)
        if not layer:
            continue
        layer_name = layer.get("name") or ""
        prefix = f"{wallet} "
        if layer_name.startswith(prefix):
            suffix = layer_name[len(prefix):]
            if suffix in (
                "Forecast Points",
                "Forecast Track",
                "Forecast Cone",
                "Forecast Wind Radii",
                "Watch-Warning",
                "Past Points",
                "Past Track",
            ):
                wallets[wallet][suffix] = layer_id
        nested = layer.get("subLayerIds") or []
        if nested:
            _collect_wallet_layers(wallet, nested, by_id, wallets)


async def _query_layer_geojson(
    session: Any,
    layer_id: int | None,
    mapserver: str = ARCGIS_MAPSERVER,
    retries: int = 3,
) -> dict[str, Any]:
    if layer_id is None:
        return {"type": "FeatureCollection", "features": []}
    url = f"{mapserver}/{layer_id}/query"
    params = {"where": "1=1", "outFields": "*", "f": "geojson", "returnGeometry": "true"}

    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            client_timeout = ClientTimeout(total=30)
            async with session.get(url, params=params, timeout=client_timeout) as resp:
                resp.raise_for_status()
                if attempt > 0:
                    _LOGGER.info(
                        "Hurricane layer %s fetch succeeded on attempt %d",
                        layer_id, attempt + 1
                    )
                return await resp.json()
        except (ClientError, asyncio.TimeoutError) as err:
            last_error = err
            _LOGGER.debug(
                "Hurricane layer %s fetch failed: %s (attempt %d/%d)",
                layer_id, err, attempt + 1, retries
            )
            if attempt < retries - 1:
                delay = min(DEFAULT_BACKOFF_BASE * (2 ** attempt), DEFAULT_BACKOFF_MAX)
                await asyncio.sleep(delay)
                continue
            raise

    raise last_error or RuntimeError("Failed to fetch hurricane layer")


async def _fetch_outlook_from_summary(session: Any) -> dict[str, Any]:
    """Fetch NHC tropical weather outlook layers (disturbances and development areas)."""
    outlook: dict[str, Any] = {}
    for key, layer_id in SUMMARY_OUTLOOK_LAYERS.items():
        geo = await _query_layer_geojson(session, layer_id, ARCGIS_SUMMARY_MAPSERVER)
        outlook[key] = geo if geo.get("features") else None
    return outlook


def _storm_group_key(props: dict[str, Any]) -> str:
    source = props.get("idp_source") or props.get("stormname") or props.get("basin")
    if source:
        return str(source).strip()
    return "unknown"


def _group_features_by_storm_key(
    features: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for feature in features:
        props = feature.get("properties") or {}
        key = _storm_group_key(props)
        grouped.setdefault(key, []).append(feature)
    return grouped


def _merge_storm_lists(
    primary: list[dict[str, Any]], secondary: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    seen = {storm.get("id") for storm in primary if storm.get("id")}
    merged = list(primary)
    for storm in secondary:
        storm_id = storm.get("id")
        if storm_id and storm_id in seen:
            continue
        merged.append(storm)
        if storm_id:
            seen.add(storm_id)
    return merged


async def _fetch_storms_from_summary(session: Any) -> list[dict[str, Any]]:
    """Build storm objects from the NHC summary MapServer flat forecast layers."""
    layer_data: dict[str, dict[str, Any]] = {}
    for suffix, layer_id in SUMMARY_STORM_LAYERS.items():
        layer_data[suffix] = await _query_layer_geojson(
            session, layer_id, ARCGIS_SUMMARY_MAPSERVER
        )

    point_groups = _group_features_by_storm_key(
        layer_data["Forecast Points"].get("features") or []
    )
    if not point_groups:
        return []

    track_groups = _group_features_by_storm_key(
        layer_data["Forecast Track"].get("features") or []
    )
    cone_groups = _group_features_by_storm_key(
        layer_data["Forecast Cone"].get("features") or []
    )
    radii_groups = _group_features_by_storm_key(
        layer_data["Forecast Wind Radii"].get("features") or []
    )
    watch_groups = _group_features_by_storm_key(
        layer_data["Watch-Warning"].get("features") or []
    )
    past_track_groups = _group_features_by_storm_key(
        layer_data["Past Track"].get("features") or []
    )
    past_point_groups = _group_features_by_storm_key(
        layer_data["Past Points"].get("features") or []
    )

    storms: list[dict[str, Any]] = []
    for key, point_features in point_groups.items():
        wallet = key[:3] if len(key) >= 3 else key
        points_geo = {"type": "FeatureCollection", "features": point_features}
        track_geo = {
            "type": "FeatureCollection",
            "features": track_groups.get(key, []),
        }
        cone_geo = {
            "type": "FeatureCollection",
            "features": cone_groups.get(key, []),
        }
        radii_geo = {
            "type": "FeatureCollection",
            "features": radii_groups.get(key, []),
        }
        storm = _normalize_arcgis_storm(wallet, points_geo, track_geo, cone_geo, radii_geo)
        if not storm:
            continue
        storm["watchWarning"] = _geometry_from_features(
            watch_groups.get(key, []), "LineString"
        )
        storm["pastTrack"] = _geometry_from_features(
            past_track_groups.get(key, []), "LineString"
        )
        storm["pastPoints"] = _normalize_past_points(past_point_groups.get(key, []))
        storms.append(storm)
    return storms


def _normalize_past_points(features: list[dict[str, Any]]) -> list[dict[str, Any]]:
    points: list[dict[str, Any]] = []
    for feature in features:
        props = feature.get("properties") or {}
        geom = feature.get("geometry") or {}
        coords = geom.get("coordinates")
        lat = props.get("lat")
        lon = props.get("lon")
        if coords and len(coords) >= 2:
            lon, lat = float(coords[0]), float(coords[1])
        if lat is None or lon is None:
            continue
        points.append(
            {
                "lat": float(lat),
                "lon": float(lon),
                "maxWindMph": knots_to_mph(props.get("maxwind")),
                "validTime": props.get("validtime") or props.get("fldatelbl"),
            }
        )
    return points


def _normalize_arcgis_storm(
    wallet: str,
    points_geo: dict[str, Any],
    track_geo: dict[str, Any],
    cone_geo: dict[str, Any],
    radii_geo: dict[str, Any],
) -> dict[str, Any] | None:
    features = points_geo.get("features") or []
    if not features:
        return None

    attrs = features[0].get("properties") or {}
    storm_id = _build_storm_id(attrs, wallet)
    name = attrs.get("stormname") or wallet
    basin = attrs.get("basin") or wallet[:2]

    forecast_points: list[dict[str, Any]] = []
    for feature in features:
        props = feature.get("properties") or {}
        geom = feature.get("geometry") or {}
        coords = geom.get("coordinates")
        lat = props.get("lat")
        lon = props.get("lon")
        if coords and len(coords) >= 2:
            lon, lat = float(coords[0]), float(coords[1])
        hour = props.get("tau")
        if hour is None:
            hour = props.get("fcstprd")
        forecast_points.append(
            {
                "hour": int(float(hour)) if hour is not None else None,
                "lat": float(lat) if lat is not None else None,
                "lon": float(lon) if lon is not None else None,
                "maxWindMph": knots_to_mph(props.get("maxwind")),
                "pressureMb": _to_int(props.get("mslp")),
                "validTime": props.get("validtime") or props.get("fldatelbl"),
            }
        )

    forecast_points.sort(
        key=lambda p: (p["hour"] is None, p["hour"] if p["hour"] is not None else 9999)
    )
    current = _pick_current_point(forecast_points)

    track = _geometry_from_features(track_geo.get("features") or [], "LineString")
    if track is None and len(forecast_points) >= 2:
        track = {
            "type": "LineString",
            "coordinates": [
                [p["lon"], p["lat"]]
                for p in forecast_points
                if p.get("lon") is not None and p.get("lat") is not None
            ],
        }

    cone = _geometry_from_features(cone_geo.get("features") or [], "Polygon")
    wind_radii = _geometry_from_features(radii_geo.get("features") or [], "Polygon", multi=True)

    current_attrs = _find_attrs_for_point(features, current)
    movement = format_movement(
        current_attrs.get("tcdir") if current_attrs else attrs.get("tcdir"),
        current_attrs.get("tcspd") if current_attrs else attrs.get("tcspd"),
    )

    return {
        "id": storm_id,
        "name": name,
        "basin": basin,
        "wallet": wallet,
        "advisoryTime": attrs.get("advdate") or attrs.get("idp_filedate"),
        "currentPosition": current,
        "maxWindMph": knots_to_mph(
            (current_attrs or attrs).get("maxwind")
        ),
        "pressureMb": _to_int((current_attrs or attrs).get("mslp")),
        "movement": movement,
        "category": _to_int((current_attrs or attrs).get("ssnum")),
        "track": track,
        "forecastPoints": forecast_points,
        "cone": cone,
        "windRadii": wind_radii,
    }


def _build_storm_id(attrs: dict[str, Any], wallet: str) -> str:
    source = attrs.get("idp_source") or wallet
    basin = attrs.get("basin") or source[:2]
    stormnum = attrs.get("stormnum")
    if stormnum is not None:
        try:
            num = int(float(stormnum))
            year = datetime.now(timezone.utc).year
            return f"{basin}{num:02d}{year}"
        except (TypeError, ValueError):
            pass
    return str(source)


def _pick_current_point(forecast_points: list[dict[str, Any]]) -> dict[str, float] | None:
    if not forecast_points:
        return None
    zero_points = [p for p in forecast_points if p.get("hour") == 0]
    chosen = zero_points[0] if zero_points else forecast_points[0]
    if chosen.get("lat") is None or chosen.get("lon") is None:
        return None
    return {"lat": float(chosen["lat"]), "lon": float(chosen["lon"])}


def _find_attrs_for_point(
    features: list[dict[str, Any]], current: dict[str, float] | None
) -> dict[str, Any] | None:
    if not current:
        return None
    for feature in features:
        props = feature.get("properties") or {}
        lat = props.get("lat")
        lon = props.get("lon")
        geom = feature.get("geometry") or {}
        coords = geom.get("coordinates")
        if coords and len(coords) >= 2:
            lon, lat = coords[0], coords[1]
        if lat is None or lon is None:
            continue
        if abs(float(lat) - current["lat"]) < 0.01 and abs(float(lon) - current["lon"]) < 0.01:
            return props
        if props.get("tau") == 0 or props.get("fcstprd") == 0:
            return props
    return None


def _geometry_from_features(
    features: list[dict[str, Any]],
    expected_type: str,
    *,
    multi: bool = False,
) -> dict[str, Any] | None:
    if not features:
        return None
    if multi and len(features) > 1:
        polys = []
        for feature in features:
            geom = feature.get("geometry")
            if geom and geom.get("type") == "Polygon":
                polys.append(geom.get("coordinates"))
        if polys:
            return {"type": "MultiPolygon", "coordinates": polys}
    geom = features[0].get("geometry")
    if geom and geom.get("type") == expected_type:
        return geom
    return None


def _to_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return None


async def _fetch_from_kml(session: Any, retries: int = 3) -> list[dict[str, Any]]:
    text = None
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            client_timeout = ClientTimeout(total=30)
            async with session.get(NHC_ACTIVE_KML, timeout=client_timeout) as resp:
                resp.raise_for_status()
                text = await resp.text()
                if attempt > 0:
                    _LOGGER.info("KML hurricane fetch succeeded on attempt %d", attempt + 1)
                break
        except (ClientError, asyncio.TimeoutError) as err:
            last_error = err
            _LOGGER.debug(
                "KML hurricane fetch failed: %s (attempt %d/%d)",
                err, attempt + 1, retries
            )
            if attempt < retries - 1:
                delay = min(DEFAULT_BACKOFF_BASE * (2 ** attempt), DEFAULT_BACKOFF_MAX)
                await asyncio.sleep(delay)
                continue
            raise

    if text is None:
        raise last_error or RuntimeError("Failed to fetch KML data")

    root = ET.fromstring(text)
    placemarks = root.findall(".//kml:Placemark", KML_NS)
    storms_by_name: dict[str, dict[str, Any]] = {}

    for placemark in placemarks:
        name_el = placemark.find("kml:name", KML_NS)
        name = (name_el.text or "").strip() if name_el is not None else "Unknown"
        storm_key = name.split("-")[0].strip() or name
        storm = storms_by_name.setdefault(
            storm_key,
            {
                "id": storm_key.replace(" ", ""),
                "name": storm_key,
                "basin": storm_key[:2] if len(storm_key) >= 2 else "AL",
                "forecastPoints": [],
                "track": None,
                "cone": None,
                "windRadii": None,
                "currentPosition": None,
                "maxWindMph": None,
                "pressureMb": None,
                "movement": None,
                "category": None,
                "advisoryTime": None,
            },
        )

        line = placemark.find(".//kml:LineString/kml:coordinates", KML_NS)
        if line is not None and line.text:
            coords = _parse_kml_coordinates(line.text, line=True)
            if "track" in name.lower() or "forecast" in name.lower():
                storm["track"] = {"type": "LineString", "coordinates": coords}
            continue

        polygon = placemark.find(".//kml:Polygon/kml:outerBoundaryIs/kml:LinearRing/kml:coordinates", KML_NS)
        if polygon is not None and polygon.text:
            ring = _parse_kml_coordinates(polygon.text, line=False)
            if "cone" in name.lower():
                storm["cone"] = {"type": "Polygon", "coordinates": [ring]}
            elif "wind" in name.lower() or "radii" in name.lower():
                storm["windRadii"] = {"type": "Polygon", "coordinates": [ring]}
            continue

        point = placemark.find(".//kml:Point/kml:coordinates", KML_NS)
        if point is not None and point.text:
            coords = _parse_kml_coordinates(point.text, line=False)
            if coords:
                lon, lat = coords[0]
                pt = {"hour": None, "lat": lat, "lon": lon, "maxWindMph": None, "pressureMb": None, "validTime": None}
                storm["forecastPoints"].append(pt)
                if storm["currentPosition"] is None:
                    storm["currentPosition"] = {"lat": lat, "lon": lon}

    return [s for s in storms_by_name.values() if s.get("forecastPoints") or s.get("track")]


def _parse_kml_coordinates(text: str, *, line: bool) -> list[list[float]]:
    """Parse KML coordinate text (lon,lat,elev) into GeoJSON [lon,lat] lists."""
    coords: list[list[float]] = []
    for token in text.replace("\n", " ").split():
        parts = token.split(",")
        if len(parts) < 2:
            continue
        lon, lat = float(parts[0]), float(parts[1])
        coords.append([lon, lat])
    if not line and coords:
        return coords
    return coords


def build_tropical_tts_snapshot(payload: dict[str, Any]) -> dict[str, Any]:
    """Build a comparable snapshot from hurricane payload for TTS change detection."""
    summary = payload.get("summary") or {}
    storms = payload.get("storms") or []
    storm_ids: set[str] = set()
    for storm in storms:
        sid = storm.get("id")
        if sid:
            storm_ids.add(str(sid))
    return {
        "threatLevel": summary.get("threatLevel") or "none",
        "insideCone": bool(summary.get("insideCone")),
        "stormIds": storm_ids,
        "insideDevelopmentRegion": bool(summary.get("insideDevelopmentRegion")),
        "highestFormationProbability": summary.get("highestFormationProbability"),
        "closestStormName": summary.get("closestStormName"),
        "distanceToCenterMiles": summary.get("distanceToCenterMiles"),
        "distanceToNearestForecastMiles": summary.get("distanceToNearestForecastMiles"),
        "estimatedClosestApproachHour": summary.get("estimatedClosestApproachHour"),
    }


def _meets_min_threat(threat_level: str, min_level: str) -> bool:
    return THREAT_RANK.get(threat_level, 0) >= THREAT_RANK.get(min_level, 0)


def detect_tropical_tts_events(
    previous: dict[str, Any] | None,
    payload: dict[str, Any],
    tropical_config: dict[str, Any],
    *,
    bootstrap: bool = False,
) -> list[tuple[str, dict[str, Any]]]:
    """Detect tropical TTS-worthy changes between polls."""
    if bootstrap or previous is None:
        return []

    summary = payload.get("summary") or {}
    storms = payload.get("storms") or []
    current = build_tropical_tts_snapshot(payload)
    min_threat = tropical_config.get("min_threat_level", "watch")
    max_dist = float(tropical_config.get("max_distance_miles", 500))

    if not _meets_min_threat(current["threatLevel"], min_threat):
        return []

    events: list[tuple[str, dict[str, Any]]] = []
    context_base = {
        "summary": summary,
        "storms": storms,
        "closestStormName": current.get("closestStormName"),
        "distanceToCenterMiles": current.get("distanceToCenterMiles"),
        "estimatedClosestApproachHour": current.get("estimatedClosestApproachHour"),
    }

    if tropical_config.get("announce_inside_cone", True):
        if current["insideCone"] and not previous.get("insideCone"):
            events.append(("inside_cone", {**context_base, "event_kind": "inside_cone"}))

    if tropical_config.get("announce_threat_escalation", True):
        prev_rank = THREAT_RANK.get(previous.get("threatLevel", "none"), 0)
        curr_rank = THREAT_RANK.get(current["threatLevel"], 0)
        if curr_rank > prev_rank:
            events.append((
                "threat_escalation",
                {
                    **context_base,
                    "event_kind": "threat_escalation",
                    "previousThreat": previous.get("threatLevel"),
                    "currentThreat": current["threatLevel"],
                },
            ))

    if tropical_config.get("announce_new_storm", True):
        prev_ids = previous.get("stormIds") or set()
        new_ids = current["stormIds"] - prev_ids
        for storm in storms:
            sid = str(storm.get("id") or "")
            if sid not in new_ids:
                continue
            threat = storm.get("threat") or {}
            dist = threat.get("distanceToCenterMiles")
            if dist is not None and dist <= max_dist:
                events.append((
                    "new_storm",
                    {
                        **context_base,
                        "event_kind": "new_storm",
                        "stormName": storm.get("name") or "Unnamed storm",
                        "stormId": sid,
                        "distanceMiles": dist,
                    },
                ))

    if tropical_config.get("announce_outlook_development", True):
        min_prob = int(tropical_config.get("outlook_min_probability", 40))
        prev_prob = previous.get("highestFormationProbability")
        curr_prob = current.get("highestFormationProbability")
        inside_now = current.get("insideDevelopmentRegion")
        inside_before = previous.get("insideDevelopmentRegion")
        prob_crossed = (
            curr_prob is not None
            and curr_prob >= min_prob
            and (prev_prob is None or prev_prob < min_prob)
        )
        if inside_now and not inside_before:
            events.append((
                "outlook_development",
                {
                    **context_base,
                    "event_kind": "outlook_development",
                    "reason": "inside_region",
                    "formationProbability": curr_prob,
                },
            ))
        elif prob_crossed:
            events.append((
                "outlook_development",
                {
                    **context_base,
                    "event_kind": "outlook_development",
                    "reason": "probability",
                    "formationProbability": curr_prob,
                },
            ))

    return events


def get_hurricane_geofield_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """Return geofield thresholds from hurricane monitoring settings."""
    monitoring = (config or {}).get("hurricane_monitoring") or {}
    if monitoring:
        return {
            "enabled": monitoring.get("enabled", True),
            "zone_mode": monitoring.get("zone_mode", "zone"),
            "max_distance_miles": float(monitoring.get("max_distance_miles", 500)),
            "min_threat_level": monitoring.get("min_threat_level", "monitor"),
        }
    tropical = (config or {}).get("tropical_alerts") or {}
    return {
        "enabled": True,
        "zone_mode": "zone",
        "max_distance_miles": float(tropical.get("max_distance_miles", 500)),
        "min_threat_level": tropical.get("min_threat_level", "watch"),
    }


def storm_in_geofield(storm: dict[str, Any], geofield_config: dict[str, Any]) -> bool:
    """Return True when a storm is inside the configured geofield (ignores sensor bypass)."""
    threat = storm.get("threat") or {}
    threat_level = threat.get("threatLevel", "none")
    if not _meets_min_threat(threat_level, geofield_config.get("min_threat_level", "watch")):
        return False
    dist = threat.get("distanceToCenterMiles")
    max_dist = float(geofield_config.get("max_distance_miles", 500))
    return dist is not None and dist <= max_dist


def storm_in_sensor_scope(storm: dict[str, Any], geofield_config: dict[str, Any]) -> bool:
    """Return True when a storm meets sensor-scope filters (may bypass distance)."""
    threat = storm.get("threat") or {}
    threat_level = threat.get("threatLevel", "none")
    if not _meets_min_threat(threat_level, geofield_config.get("min_threat_level", "watch")):
        return False
    if geofield_config.get("zone_mode", "zone") == "all":
        return True
    return storm_in_geofield(storm, geofield_config)


def storm_sensor_distance_miles(
    storm: dict[str, Any],
    home: dict[str, float] | None = None,
) -> tuple[float | None, int | None]:
    """Return the nearest distance to home and forecast hour for a storm."""
    threat = storm.get("threat") or {}
    distances: list[float] = []
    hour = threat.get("nearestForecastHour")

    for key in ("distanceToCenterMiles", "nearestTrackDistanceMiles"):
        value = threat.get(key)
        if value is not None:
            distances.append(float(value))

    if not distances and home:
        nearest = get_nearest_forecast_point(home, storm.get("forecastPoints") or [])
        if nearest:
            distances.append(float(nearest["distanceMiles"]))
            hour = nearest.get("hour")
        center = storm.get("currentPosition") or {}
        if center.get("lat") is not None and center.get("lon") is not None:
            distances.append(
                haversine_distance_miles(
                    float(home["lat"]),
                    float(home["lon"]),
                    float(center["lat"]),
                    float(center["lon"]),
                )
            )

    if not distances:
        return None, hour
    return round(min(distances), 1), hour


def pick_nearest_storm(
    storms: list[dict[str, Any]],
    home: dict[str, float] | None = None,
) -> tuple[dict[str, Any] | None, float | None, int | None]:
    """Return the nearest storm in sensor scope and its distance/hour."""
    closest: dict[str, Any] | None = None
    closest_dist: float | None = None
    closest_hour: int | None = None

    for storm in storms:
        dist, hour = storm_sensor_distance_miles(storm, home)
        if dist is None:
            continue
        if closest is None or dist < closest_dist:
            closest = storm
            closest_dist = dist
            closest_hour = hour

    if closest is None and storms:
        fallback = storms[0]
        return fallback, None, (fallback.get("threat") or {}).get("nearestForecastHour")
    return closest, closest_dist, closest_hour


def build_hurricane_sensor_payload(
    payload: dict[str, Any],
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build sensor-oriented payload with geofield-scoped storm data."""
    summary = dict(payload.get("summary") or {})
    storms = payload.get("storms") or []
    geofield_config = get_hurricane_geofield_config(config)
    if not geofield_config.get("enabled", True):
        return {
            **payload,
            "geofield_storms": [],
            "geofield_count": 0,
            "in_geofield": False,
            "primary_geofield": None,
            "inside_cone_geofield": False,
            "threat_elevated_geofield": False,
            "sensor_summary": {
                "threat_level": "none",
                "closest_storm_name": None,
                "distance_miles": None,
                "closest_approach_hour": None,
                "formation_probability": None,
                "active_storm_count": len(storms),
                "disturbance_count": summary.get("disturbanceCount") or 0,
                "inside_cone": False,
            },
            "last_updated": dt_util.utcnow().isoformat(),
        }
    geofield_storms = [s for s in storms if storm_in_geofield(s, geofield_config)]
    sensor_storms = [s for s in storms if storm_in_sensor_scope(s, geofield_config)]
    home = payload.get("home") or {}
    closest, closest_dist, closest_hour = pick_nearest_storm(sensor_storms, home)

    inside_cone = any(
        (s.get("threat") or {}).get("insideCone") for s in geofield_storms
    )
    threat_elevated = _meets_min_threat(
        summary.get("threatLevel", "none"),
        geofield_config.get("min_threat_level", "watch"),
    ) and bool(geofield_storms)

    return {
        **payload,
        "geofield_storms": geofield_storms,
        "geofield_count": len(geofield_storms),
        "in_geofield": len(geofield_storms) > 0,
        "primary_geofield": closest,
        "inside_cone_geofield": inside_cone,
        "threat_elevated_geofield": threat_elevated,
        "sensor_summary": {
            "threat_level": summary.get("threatLevel", "none"),
            "closest_storm_name": closest.get("name") if closest else None,
            "distance_miles": closest_dist,
            "closest_approach_hour": closest_hour
            if closest_hour is not None
            else summary.get("estimatedClosestApproachHour"),
            "formation_probability": summary.get("highestFormationProbability"),
            "active_storm_count": len(sensor_storms),
            "disturbance_count": summary.get("disturbanceCount") or 0,
            "inside_cone": inside_cone,
        },
        "last_updated": dt_util.utcnow().isoformat(),
    }
