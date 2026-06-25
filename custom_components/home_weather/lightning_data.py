"""Blitzortung live lightning strike buffer and geofield filtering."""
from __future__ import annotations

import asyncio
import json
import logging
import random
from datetime import datetime, timezone
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import dt as dt_util

import aiohttp

from .hurricane_data import get_home_coordinates
from .hurricane_geo import haversine_distance_miles

_LOGGER = logging.getLogger(__name__)

BLITZORTUNG_SERVER_IDS = (1, 6, 5, 7)
RECONNECT_BASE_SECONDS = 2
RECONNECT_MAX_SECONDS = 30


def get_lightning_config(config: dict[str, Any] | None) -> dict[str, Any]:
    """Return merged lightning monitoring config with defaults."""
    defaults = {
        "enabled": True,
        "show_on_map": True,
        "max_age_minutes": 60,
        "max_strikes": 500,
        "geofield_radius_miles": 100,
    }
    monitoring = (config or {}).get("lightning_monitoring") or {}
    legacy = (config or {}).get("lightning") or {}
    return {**defaults, **legacy, **monitoring}


def parse_strike(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Parse a Blitzortung WebSocket strike message."""
    if not raw or raw.get("lat") is None or raw.get("lon") is None:
        return None
    try:
        time_ns = int(raw.get("time") or 0)
        lat = float(raw["lat"])
        lon = float(raw["lon"])
    except (TypeError, ValueError):
        return None
    time_ms = time_ns // 1_000_000
    return {
        "id": f"{time_ns}-{lat}-{lon}",
        "lat": lat,
        "lon": lon,
        "alt": float(raw.get("alt") or 0),
        "time_ms": time_ms,
        "time_ns": time_ns,
        "polarity": "positive" if float(raw.get("pol") or 0) > 0 else "negative",
    }


def _pick_server_url() -> str:
    server_id = random.choice(BLITZORTUNG_SERVER_IDS)
    return f"wss://ws{server_id}.blitzortung.org:3000/"


def build_lightning_payload(
    strikes: list[dict[str, Any]],
    home: dict[str, float],
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build coordinator payload from buffered strikes within retention window."""
    lightning_config = get_lightning_config(config)
    max_age_minutes = int(lightning_config.get("max_age_minutes", 60))
    geofield_radius = float(lightning_config.get("geofield_radius_miles", 100))
    cutoff_ms = int(dt_util.utcnow().timestamp() * 1000) - max_age_minutes * 60 * 1000

    recent: list[dict[str, Any]] = []
    for strike in strikes:
        time_ms = strike.get("time_ms")
        if time_ms is None or time_ms < cutoff_ms:
            continue
        dist = round(
            haversine_distance_miles(
                float(home["lat"]),
                float(home["lon"]),
                float(strike["lat"]),
                float(strike["lon"]),
            ),
            1,
        )
        recent.append({**strike, "distance_miles": dist})

    recent.sort(key=lambda s: s.get("time_ms") or 0, reverse=True)
    geofield = [s for s in recent if s.get("distance_miles", float("inf")) <= geofield_radius]
    nearest = min(geofield, key=lambda s: s.get("distance_miles", float("inf"))) if geofield else None

    one_hour_ms = int(dt_util.utcnow().timestamp() * 1000) - 3600 * 1000
    strikes_last_hour = sum(
        1 for s in geofield if (s.get("time_ms") or 0) >= one_hour_ms
    )

    last_strike_time: datetime | None = None
    if nearest and nearest.get("time_ms"):
        last_strike_time = datetime.fromtimestamp(
            nearest["time_ms"] / 1000, tz=timezone.utc
        )

    return {
        "strikes": recent,
        "geofield_strikes": geofield,
        "geofield_count": len(geofield),
        "in_geofield": len(geofield) > 0,
        "primary_geofield": nearest,
        "nearest_distance_miles": nearest.get("distance_miles") if nearest else None,
        "nearest_latitude": nearest.get("lat") if nearest else None,
        "nearest_longitude": nearest.get("lon") if nearest else None,
        "last_strike_time": last_strike_time,
        "strikes_last_hour": strikes_last_hour,
        "feed_status": "live",
        "last_updated": dt_util.utcnow().isoformat(),
    }


def empty_lightning_payload(*, feed_status: str = "off") -> dict[str, Any]:
    """Return empty lightning payload."""
    return {
        "strikes": [],
        "geofield_strikes": [],
        "geofield_count": 0,
        "in_geofield": False,
        "primary_geofield": None,
        "nearest_distance_miles": None,
        "nearest_latitude": None,
        "nearest_longitude": None,
        "last_strike_time": None,
        "strikes_last_hour": 0,
        "feed_status": feed_status,
        "last_updated": dt_util.utcnow().isoformat(),
    }


class LightningStrikeBuffer:
    """Thread-safe rolling buffer of live lightning strikes from Blitzortung."""

    def __init__(self, max_strikes: int = 500) -> None:
        self._max_strikes = max_strikes
        self._strikes: list[dict[str, Any]] = []
        self._lock = asyncio.Lock()
        self._last_strike_time_ns = 0

    async def add_strike(self, strike: dict[str, Any]) -> None:
        async with self._lock:
            self._strikes.insert(0, strike)
            if len(self._strikes) > self._max_strikes:
                self._strikes = self._strikes[: self._max_strikes]

    def set_max_strikes(self, max_strikes: int) -> None:
        self._max_strikes = max(1, max_strikes)

    async def get_strikes(self) -> list[dict[str, Any]]:
        async with self._lock:
            return list(self._strikes)

    @property
    def last_strike_time_ns(self) -> int:
        return self._last_strike_time_ns

    @last_strike_time_ns.setter
    def last_strike_time_ns(self, value: int) -> None:
        self._last_strike_time_ns = value


class BlitzortungListener:
    """Maintain a WebSocket connection to Blitzortung and feed a strike buffer."""

    def __init__(
        self,
        hass: HomeAssistant,
        buffer: LightningStrikeBuffer,
        on_strike: Any | None = None,
        on_status: Any | None = None,
    ) -> None:
        self.hass = hass
        self.buffer = buffer
        self._on_strike = on_strike
        self._on_status = on_status
        self._task: asyncio.Task | None = None
        self._closed = False
        self._reconnect_attempt = 0

    def _emit_status(self, status: str) -> None:
        if self._on_status:
            self._on_status(status)

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._closed = False
            self._emit_status("connecting")
            self._task = asyncio.create_task(self._run())

    async def async_stop(self) -> None:
        self._closed = True
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None

    async def _run(self) -> None:
        while not self._closed:
            try:
                await self._connect_once()
            except asyncio.CancelledError:
                raise
            except Exception as err:
                _LOGGER.debug("Blitzortung connection error: %s", err)
                self._emit_status("error")
            if self._closed:
                break
            self._emit_status("reconnecting")
            delay = min(
                RECONNECT_BASE_SECONDS * (2**self._reconnect_attempt),
                RECONNECT_MAX_SECONDS,
            )
            self._reconnect_attempt += 1
            await asyncio.sleep(delay)

    async def _connect_once(self) -> None:
        session = async_get_clientsession(self.hass)
        url = _pick_server_url()
        async with session.ws_connect(url, heartbeat=30) as ws:
            self._reconnect_attempt = 0
            self._emit_status("live")
            resume_ns = self.buffer.last_strike_time_ns
            await ws.send_str(json.dumps({"time": resume_ns}))
            async for msg in ws:
                if self._closed:
                    break
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    raw = json.loads(msg.data)
                except (json.JSONDecodeError, TypeError):
                    continue
                strike = parse_strike(raw)
                if not strike:
                    continue
                if strike["time_ns"] > self.buffer.last_strike_time_ns:
                    self.buffer.last_strike_time_ns = strike["time_ns"]
                await self.buffer.add_strike(strike)
                if self._on_strike:
                    self._on_strike()
