"""TTS trigger system for Home Weather integration.

Manages all trigger types:
- Time-based: Scheduled forecasts at regular intervals
- Current weather change: Alert when conditions change
- Upcoming change: Alert before precipitation starts
- Sensor triggered: Full forecast when presence sensor activates
- Webhook: Personalized forecast via webhook
- Voice satellite: Conversation commands for weather queries
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any, Callable

from homeassistant.core import HomeAssistant, Event, callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_change,
    async_track_time_interval,
)
from homeassistant.util import dt as dt_util

from .condition_labels import (
    find_upcoming_precip_alert,
    is_significant_condition_change,
    normalize_weather_condition,
)
from .const import DOMAIN, WEBHOOK_LAST_TRIGGERED_KEY
from .tts_notifications import (
    TTS_STATUS_EVENT,
    _fire_tts_status,
    build_scheduled_forecast,
    build_current_change_message,
    build_upcoming_change_message,
    build_webhook_message,
    build_sunrise_upcoming_message,
    build_sunrise_final_message,
    build_sunset_upcoming_message,
    build_sunset_final_message,
    dispatch_tts,
    dispatch_tts_and_wait,
    format_earthquake_alert_for_tts,
    format_tornado_warning_for_tts,
    format_tropical_alert_for_tts,
    format_travel_advisory_for_tts,
    format_volcano_alert_for_tts,
    format_wildfire_alert_for_tts,
    format_air_quality_alert_for_tts,
    format_spacecraft_alert_for_tts,
    format_solar_weather_alert_for_tts,
    format_neo_alert_for_tts,
    passes_earthquake_tts_filter,
    passes_tornado_tts_filter,
    passes_volcano_tts_filter,
    passes_wildfire_tts_filter,
    passes_air_quality_tts_filter,
    passes_spacecraft_tts_filter,
    passes_solar_weather_tts_filter,
    passes_neo_tts_filter,
    play_hazard_alert_notification,
    play_hazard_siren,
    play_nws_alert_notification,
    replay_active_nws_alerts,
)

_LOGGER = logging.getLogger(__name__)


_TTS_TRIGGER_FLAGS: tuple[str, ...] = (
    "enable_time_based",
    "enable_current_change",
    "enable_upcoming_change",
    "enable_sensor_triggered",
    "enable_webhook",
    "enable_voice_satellite",
)


def _is_tts_active(tts_config: dict[str, Any]) -> bool:
    """Return True when any TTS trigger type is enabled.

    Each alert section manages itself; there is no master TTS switch.
    """
    return any(tts_config.get(flag, False) for flag in _TTS_TRIGGER_FLAGS)


def _is_alerts_active(config: dict[str, Any]) -> bool:
    """Return True when any alert subsystem (TTS or otherwise) is enabled."""
    if _is_tts_active(config.get("tts") or {}):
        return True
    if (config.get("sun_alerts") or {}).get("enabled", False):
        return True
    if (config.get("nws_alerts") or {}).get("enabled", False):
        return True
    if (config.get("tropical_alerts") or {}).get("enabled", False):
        return True
    if (config.get("tornado_alerts") or {}).get("enabled", False):
        return True
    if (config.get("earthquake_alerts") or {}).get("enabled", False):
        return True
    if (config.get("volcano_alerts") or {}).get("enabled", False):
        return True
    if (config.get("wildfire_alerts") or {}).get("enabled", False):
        return True
    if (config.get("air_quality_alerts") or {}).get("enabled", False):
        return True
    if (config.get("travel_alerts") or {}).get("enabled", False):
        return True
    if (config.get("spacecraft_alerts") or {}).get("enabled", False):
        return True
    if (config.get("solar_weather_alerts") or {}).get("enabled", False):
        return True
    if (config.get("neo_alerts") or {}).get("enabled", False):
        return True
    return False


def extract_weather_condition(state: Any) -> str:
    """Read and normalize the weather condition from a state object."""
    if not state:
        return ""
    condition = state.attributes.get("condition") if state.attributes else None
    raw = str(condition) if condition else str(state.state or "")
    return normalize_weather_condition(raw)


def _safe_int(value: Any, default: int, *, minimum: int | None = None) -> int:
    """Parse an int from config/UI values, falling back when missing or invalid."""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    if minimum is not None and parsed < minimum:
        return default
    return parsed


def parse_time_hm(value: Any, default_h: int, default_m: int) -> tuple[int, int]:
    """Parse an HH:MM string into hour/minute components."""
    if not value or not isinstance(value, str):
        return default_h, default_m
    try:
        hour_str, minute_str = value.split(":", 1)
        hour = int(hour_str)
        minute = int(minute_str)
    except (TypeError, ValueError):
        return default_h, default_m
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return default_h, default_m
    return hour, minute


def normalize_days_of_week(days_of_week: Any) -> set[int]:
    """Normalize configured days to weekday numbers (Mon=0 .. Sun=6)."""
    day_map = {
        "mon": 0,
        "tue": 1,
        "wed": 2,
        "thu": 3,
        "fri": 4,
        "sat": 5,
        "sun": 6,
    }
    if not days_of_week:
        return set(range(7))

    allowed: set[int] = set()
    for day in days_of_week:
        if isinstance(day, int) and 0 <= day <= 6:
            allowed.add(day)
            continue
        if isinstance(day, str):
            mapped = day_map.get(day.lower()[:3], -1)
            if mapped >= 0:
                allowed.add(mapped)
    return allowed or set(range(7))


def compute_trigger_hours(start_h: int, end_h: int, hour_pattern: int) -> list[int]:
    """Compute clock hours for time-based forecasts anchored to start_h."""
    hour_pattern = int(hour_pattern)
    start_h = int(start_h)
    end_h = int(end_h)
    if hour_pattern <= 0:
        return []
    if start_h <= end_h:
        hours: list[int] = []
        hour = start_h
        while hour <= end_h:
            hours.append(hour)
            hour += hour_pattern
        return hours

    # Overnight window (e.g. 22:00-06:00): anchor from start_h through midnight,
    # then continue from midnight through end_h.
    hours = list(range(start_h, 24, hour_pattern))
    hours.extend(range(0, end_h + 1, hour_pattern))
    return sorted(set(hours))


def should_fire_scheduled_forecast(
    now: datetime,
    tts_config: dict[str, Any],
    *,
    check_minute: bool = True,
) -> bool:
    """Return True when ``now`` matches the configured scheduled forecast slot."""
    if not tts_config.get("enable_time_based", False):
        return False

    minute_offset = _safe_int(tts_config.get("minute_offset"), 3, minimum=0)
    if check_minute and now.minute != minute_offset:
        return False

    hour_pattern = max(1, _safe_int(tts_config.get("hour_pattern"), 3, minimum=1))
    start_h, start_m = parse_time_hm(tts_config.get("start_time"), 8, 0)
    end_h, end_m = parse_time_hm(tts_config.get("end_time"), 21, 0)

    if now.weekday() not in normalize_days_of_week(tts_config.get("days_of_week")):
        return False

    current_minutes = now.hour * 60 + now.minute
    start_minutes = start_h * 60 + start_m
    end_minutes = end_h * 60 + end_m
    if start_minutes <= end_minutes:
        if not (start_minutes <= current_minutes <= end_minutes):
            return False
        trigger_hours = compute_trigger_hours(start_h, end_h, hour_pattern)
    elif not (current_minutes >= start_minutes or current_minutes <= end_minutes):
        return False
    else:
        trigger_hours = compute_trigger_hours(start_h, end_h, hour_pattern)

    return now.hour in trigger_hours


def build_weather_data_from_state(hass: HomeAssistant, weather_entity: str) -> dict[str, Any]:
    """Build minimal weather data from a live entity state."""
    state = hass.states.get(weather_entity)
    if not state:
        return {"configured": False}

    current = {
        "temperature": state.attributes.get("temperature")
        or state.attributes.get("native_temperature"),
        "condition": state.attributes.get("condition"),
        "state": state.state,
        "humidity": state.attributes.get("humidity"),
        "wind_speed": state.attributes.get("wind_speed")
        or state.attributes.get("native_wind_speed"),
        "wind_speed_unit": state.attributes.get("wind_speed_unit")
        or state.attributes.get("native_wind_speed_unit", "mph"),
        "wind_gust_speed": state.attributes.get("wind_gust_speed")
        or state.attributes.get("native_wind_gust_speed"),
    }
    return {
        "current": current,
        "hourly_forecast": [],
        "daily_forecast": [],
        "configured": True,
        "weather_entity": weather_entity,
    }


def media_players_with_tts(
    media_players: list[dict[str, Any]],
    *,
    fallback_tts_entity: str | None = None,
) -> list[dict[str, Any]]:
    """Return media players that have both entity and TTS entity configured."""
    resolved: list[dict[str, Any]] = []
    fallback = (fallback_tts_entity or "").strip()
    for mp in media_players:
        entity_id = mp.get("entity_id")
        if not entity_id:
            continue
        tts_entity = (mp.get("tts_entity_id") or fallback or "").strip()
        if not tts_entity:
            continue
        entry = dict(mp)
        if not entry.get("tts_entity_id"):
            entry["tts_entity_id"] = tts_entity
        resolved.append(entry)
    return resolved


def _weather_data_usable(weather_data: dict[str, Any] | None) -> bool:
    """Return True when weather_data has enough payload to build a TTS message.

    The coordinator returns a non-empty dict even when configured=False, so a
    truthy check is not enough — we need actual current/hourly/daily payload.
    """
    if not weather_data:
        return False
    if weather_data.get("configured") is False:
        return False
    return bool(
        weather_data.get("current")
        or weather_data.get("hourly_forecast")
        or weather_data.get("daily_forecast")
    )


class TTSTriggerManager:
    """Manage all TTS triggers for the Home Weather integration."""

    def __init__(
        self,
        hass: HomeAssistant,
        get_config: Callable[[], dict[str, Any]],
        get_weather_data: Callable[[], dict[str, Any]],
        refresh_weather_data: Callable[[], Any] | None = None,
    ) -> None:
        """Initialize the trigger manager.
        
        Args:
            hass: Home Assistant instance
            get_config: Callable that returns current config
            get_weather_data: Callable that returns current weather data
            refresh_weather_data: Optional async callable to refresh weather data
        """
        self.hass = hass
        self._get_config = get_config
        self._get_weather_data = get_weather_data
        self._refresh_weather_data = refresh_weather_data
        self._unsub_callbacks: list[Callable] = []
        self._last_condition: str | None = None
        self._upcoming_alert_fired: set[str] = set()  # Track which hours already alerted
        self._registered_webhooks: list[str] = []  # Track registered webhook IDs
        self._sun_alerts_last_upcoming: dict[str, datetime] = {}  # event_key -> last announce
        self._sun_alerts_final_fired: set[str] = set()  # event_key for sunrise/sunset final
        self._sun_alert_state: dict[str, Any] = {}  # Track sun alert announcements
        self._nws_known_alert_ids: set[str] = set()  # Track NWS alert IDs to detect new alerts
        self._nws_active_alerts: list[dict[str, Any]] = []
        self._nws_bootstrapped: bool = False
        self._tropical_snapshot: dict[str, Any] | None = None
        self._tropical_bootstrapped: bool = False
        self._scheduled_forecast_last_fire_key: str | None = None

    async def async_setup(self) -> None:
        """Set up all enabled triggers based on config.

        Each trigger is wrapped in its own try/except so a single failing
        trigger never prevents the rest from registering.
        """
        config = self._get_config()
        tts_config = config.get("tts") or {}

        if not _is_alerts_active(config):
            _LOGGER.debug("No alerts enabled, skipping trigger setup")
            return

        setups: list[tuple[str, Any]] = []
        if tts_config.get("enable_time_based", False):
            setups.append(("time_based", self._setup_time_based_trigger(tts_config)))
        if tts_config.get("enable_current_change", False):
            setups.append(("current_change", self._setup_current_change_trigger(config)))
        if tts_config.get("enable_upcoming_change", False):
            setups.append(("upcoming_change", self._setup_upcoming_change_trigger(tts_config)))
        if tts_config.get("enable_sensor_triggered", False):
            setups.append(("sensor_triggered", self._setup_sensor_triggers(tts_config)))
        if tts_config.get("enable_webhook", False):
            setups.append(("webhook", self._setup_webhook_trigger(tts_config)))
        if tts_config.get("enable_voice_satellite", False):
            setups.append(("voice_satellite", self._setup_voice_satellite_trigger(tts_config)))
        if (config.get("sun_alerts") or {}).get("enabled", False):
            setups.append(("sun_alerts", self._setup_sun_alerts_trigger(config)))
        if (config.get("nws_alerts") or {}).get("enabled", False):
            setups.append(("nws_alerts", self._setup_nws_alerts_trigger(config)))
        if (config.get("tropical_alerts") or {}).get("enabled", False):
            setups.append(("tropical_alerts", self._setup_tropical_alerts_trigger(config)))
        if (config.get("tornado_alerts") or {}).get("enabled", False):
            setups.append(("tornado_alerts", self._setup_tornado_alerts_trigger(config)))
        if (config.get("earthquake_alerts") or {}).get("enabled", False):
            setups.append(("earthquake_alerts", self._setup_earthquake_alerts_trigger(config)))
        if (config.get("volcano_alerts") or {}).get("enabled", False):
            setups.append(("volcano_alerts", self._setup_volcano_alerts_trigger(config)))
        if (config.get("wildfire_alerts") or {}).get("enabled", False):
            setups.append(("wildfire_alerts", self._setup_wildfire_alerts_trigger(config)))
        if (config.get("air_quality_alerts") or {}).get("enabled", False):
            setups.append(("air_quality_alerts", self._setup_air_quality_alerts_trigger(config)))
        if (config.get("travel_alerts") or {}).get("enabled", False):
            setups.append(("travel_alerts", self._setup_travel_alerts_trigger(config)))
        if (config.get("spacecraft_alerts") or {}).get("enabled", False):
            setups.append(("spacecraft_alerts", self._setup_spacecraft_alerts_trigger(config)))
        if (config.get("solar_weather_alerts") or {}).get("enabled", False):
            setups.append(("solar_weather_alerts", self._setup_solar_weather_alerts_trigger(config)))
        if (config.get("neo_alerts") or {}).get("enabled", False):
            setups.append(("neo_alerts", self._setup_neo_alerts_trigger(config)))

        successful: list[str] = []
        for name, coro in setups:
            try:
                await coro
                successful.append(name)
            except Exception as err:
                _LOGGER.exception("Failed to set up %s trigger: %s", name, err)

        _LOGGER.info("Home Weather triggers registered: %s", successful or "none")

    async def async_unload(self) -> None:
        """Unload all triggers."""
        for unsub in self._unsub_callbacks:
            try:
                unsub()
            except Exception as e:
                _LOGGER.warning("Error unsubscribing trigger: %s", e)
        self._unsub_callbacks.clear()
        
        # Unregister all webhooks
        from homeassistant.components import webhook
        for webhook_id in self._registered_webhooks:
            try:
                webhook.async_unregister(self.hass, webhook_id)
                _LOGGER.debug("Unregistered webhook: %s", webhook_id)
            except Exception as e:
                _LOGGER.warning("Error unregistering webhook %s: %s", webhook_id, e)
        self._registered_webhooks.clear()
        self._tropical_bootstrapped = False
        self._tropical_snapshot = None
        
        _LOGGER.info("TTS triggers unloaded")

    async def _resolve_weather_data(self, *, refresh: bool = True) -> dict[str, Any]:
        """Refresh and return the best available weather data for TTS.

        Coordinator data may be empty/stale (configured: False) when the
        weather entity is mid-refresh or hasn't run yet. We always attempt a
        live-state fallback so TTS for non-sunrise alerts isn't silently
        dropped just because the coordinator cache is cold.
        """
        if refresh and self._refresh_weather_data:
            try:
                await asyncio.wait_for(self._refresh_weather_data(), timeout=15.0)
            except asyncio.TimeoutError:
                _LOGGER.warning("Weather refresh timed out before TTS, using cached data")
            except Exception as err:
                _LOGGER.warning("Weather refresh failed before TTS: %s", err)

        weather_data = self._get_weather_data() or {}
        configured = weather_data.get("configured") is not False
        has_payload = bool(
            weather_data.get("current")
            or weather_data.get("hourly_forecast")
            or weather_data.get("daily_forecast")
        )

        if configured and has_payload:
            return weather_data

        # Coordinator cache is cold/empty: fall back to live entity state so
        # alerts still play. Sunrise/sunset don't need this, but every other
        # alert path does.
        weather_entity = self._get_config().get("weather_entity")
        if not weather_entity:
            _LOGGER.warning(
                "Weather data unavailable (configured=%s, has_payload=%s) and no weather_entity configured",
                configured, has_payload,
            )
            return weather_data

        fallback = build_weather_data_from_state(self.hass, weather_entity)
        if fallback.get("configured"):
            _LOGGER.info(
                "Using live weather entity state for TTS fallback (coordinator cache was cold)"
            )
            return fallback

        _LOGGER.warning(
            "Weather data unavailable: coordinator configured=%s has_payload=%s, "
            "fallback entity %s also unavailable",
            configured, has_payload, weather_entity,
        )
        return weather_data

    async def _setup_time_based_trigger(self, tts_config: dict[str, Any]) -> None:
        """Set up time-based forecast triggers.

        Uses Home Assistant's minute clock listener for exact slot timing and
        re-reads the live schedule on each tick so config changes apply after
        the trigger manager reloads.
        """
        minute_offset = _safe_int(tts_config.get("minute_offset"), 3, minimum=0)
        start_time = tts_config.get("start_time", "08:00")
        end_time = tts_config.get("end_time", "21:00")
        hour_pattern = max(1, _safe_int(tts_config.get("hour_pattern"), 3, minimum=1))
        start_h, _ = parse_time_hm(start_time, 8, 0)
        end_h, _ = parse_time_hm(end_time, 21, 0)
        trigger_hours = compute_trigger_hours(start_h, end_h, hour_pattern)

        @callback
        def _check_and_fire(now: datetime) -> None:
            self.hass.async_create_task(self._check_scheduled_forecast_tick(now))

        unsub = async_track_time_change(
            self.hass,
            _check_and_fire,
            minute=minute_offset,
            second=0,
        )
        self._unsub_callbacks.append(unsub)
        _LOGGER.info(
            "Time-based trigger set up: hours=%s at minute :%02d, window %s-%s",
            trigger_hours,
            minute_offset,
            start_time,
            end_time,
        )

    async def _check_scheduled_forecast_tick(
        self,
        now: datetime,
        *,
        check_minute: bool = False,
    ) -> None:
        """Evaluate the live schedule and fire a forecast when the slot matches."""
        config = self._get_config()
        tts_config = config.get("tts") or {}
        if not should_fire_scheduled_forecast(now, tts_config, check_minute=check_minute):
            return

        fire_key = now.strftime("%Y-%m-%d-%H-%M")
        if self._scheduled_forecast_last_fire_key == fire_key:
            return

        self._scheduled_forecast_last_fire_key = fire_key
        _LOGGER.info("Scheduled forecast slot matched (%s); firing TTS", fire_key)
        try:
            await self._fire_scheduled_forecast()
        except Exception as err:
            _LOGGER.exception("Scheduled forecast TTS failed: %s", err)
            self._scheduled_forecast_last_fire_key = None

    async def _setup_current_change_trigger(self, config: dict[str, Any]) -> None:
        """Set up trigger for when current weather conditions change."""
        weather_entity = config.get("weather_entity")
        if not weather_entity:
            _LOGGER.warning("No weather entity configured for current change trigger")
            return
        
        state = self.hass.states.get(weather_entity)
        if state:
            self._last_condition = extract_weather_condition(state)

        @callback
        def _state_changed(event: Event) -> None:
            """Handle state change events."""
            new_state = event.data.get("new_state")
            old_state = event.data.get("old_state")

            if not new_state or not old_state:
                return

            old_condition = extract_weather_condition(old_state)
            new_condition = extract_weather_condition(new_state)

            if (
                not new_condition
                or old_condition == new_condition
                or self._last_condition == new_condition
                or not is_significant_condition_change(old_condition, new_condition)
            ):
                return

            self._last_condition = new_condition
            self.hass.async_create_task(
                self._fire_current_change(old_condition, new_condition)
            )
        
        unsub = async_track_state_change_event(
            self.hass,
            [weather_entity],
            _state_changed,
        )
        self._unsub_callbacks.append(unsub)
        _LOGGER.info("Current change trigger set up for %s", weather_entity)

    async def fire_test_scheduled_forecast(self, *, request_id: str | None = None) -> None:
        """Play a scheduled forecast on all configured media players."""
        await self._fire_scheduled_forecast(refresh_weather=False, request_id=request_id)

    async def fire_test_current_change(self, *, request_id: str | None = None) -> None:
        """Play a sample current-change alert on all configured media players."""
        weather_data = await self._resolve_weather_data(refresh=False)
        current = weather_data.get("current") or {}
        new_condition = current.get("condition") or current.get("state") or "changing conditions"
        await self._fire_current_change(
            "previous conditions",
            new_condition,
            refresh_weather=False,
            request_id=request_id,
        )

    async def fire_test_upcoming_change(self, *, request_id: str | None = None) -> None:
        """Play a sample upcoming-precipitation alert."""
        config = self._get_config()
        tts_config = config.get("tts") or {}
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("No media players with TTS configured for upcoming-change test")
            _fire_tts_status(
                self.hass, "skipped",
                request_id=request_id, reason="No media players with TTS configured",
                alert_kind="upcoming_change",
            )
            return

        weather_data = await self._resolve_weather_data(refresh=False)
        hourly = (weather_data or {}).get("hourly_forecast") or []
        current = (weather_data or {}).get("current") or {}
        threshold = int(tts_config.get("precip_threshold", 30))
        minutes_before = int(tts_config.get("minutes_before_announce", 30))
        probability = max(threshold, 60)
        precip_kind = "rain"
        minutes_until = minutes_before

        match = find_upcoming_precip_alert(
            current,
            hourly,
            minutes_before=minutes_before,
            threshold=threshold,
        )
        if match:
            minutes_until = match["minutes_until"]
            probability = match["probability"]
            precip_kind = match["precip_kind"]
        else:
            _LOGGER.info("Upcoming-change test skipped: precipitation already active or none in window")
            _fire_tts_status(
                self.hass, "skipped",
                request_id=request_id,
                reason="Precipitation already active or none in alert window",
                alert_kind="upcoming_change",
            )
            return

        message = build_upcoming_change_message(precip_kind, minutes_until, probability)
        await dispatch_tts(
            self.hass, media_players, tts_config, message,
            request_id=request_id, alert_kind="upcoming_change",
            config=config, type_id="upcoming_change",
        )
        _LOGGER.info("Test upcoming-change TTS dispatched")

    async def fire_test_sensor_triggered(self, *, request_id: str | None = None) -> None:
        """Trigger a sensor forecast on the first configured sensor target."""
        config = self._get_config()
        sensor_triggers = (config.get("tts") or {}).get("sensor_triggers") or []
        target = ""
        for trig in sensor_triggers:
            if trig.get("entity_id"):
                target = trig.get("media_player", "") or ""
                break
        await self._fire_scheduled_forecast(
            target_media_player=target, refresh_weather=False, request_id=request_id,
        )

    async def fire_test_webhook(self, *, request_id: str | None = None) -> None:
        """Trigger the first configured webhook forecast (or all if none)."""
        config = self._get_config()
        webhooks = (config.get("tts") or {}).get("webhooks") or []
        name = ""
        target = ""
        for wh in webhooks:
            if wh.get("enabled", True) and wh.get("webhook_id"):
                name = wh.get("personal_name") or ""
                target = wh.get("media_player") or ""
                break
        await self._fire_webhook_forecast(name, None, target_media_player=target, request_id=request_id)

    async def fire_test_sunrise(self, *, request_id: str | None = None) -> None:
        """Speak the sunrise upcoming announcement on all media players."""
        config = self._get_config()
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("No media players with TTS configured for sunrise test")
            _fire_tts_status(
                self.hass, "skipped",
                request_id=request_id, reason="No media players with TTS configured",
                alert_kind="sunrise",
            )
            return
        tts_config = config.get("tts", {})
        mins = int(((config.get("sun_alerts") or {}).get("sunrise_tts") or {}).get("minutes_before", 15))
        msg = build_sunrise_upcoming_message(mins)
        await dispatch_tts(
            self.hass, media_players, tts_config, msg,
            request_id=request_id, alert_kind="sunrise",
            config=config, type_id="sun_alerts",
        )
        _LOGGER.info("Test sunrise TTS dispatched")

    async def fire_test_sunset(self, *, request_id: str | None = None) -> None:
        """Speak the sunset upcoming announcement on all media players."""
        config = self._get_config()
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("No media players with TTS configured for sunset test")
            _fire_tts_status(
                self.hass, "skipped",
                request_id=request_id, reason="No media players with TTS configured",
                alert_kind="sunset",
            )
            return
        tts_config = config.get("tts", {})
        mins = int(((config.get("sun_alerts") or {}).get("sunset_tts") or {}).get("minutes_before", 15))
        msg = build_sunset_upcoming_message(mins)
        await dispatch_tts(
            self.hass, media_players, tts_config, msg,
            request_id=request_id, alert_kind="sunset",
            config=config, type_id="sun_alerts",
        )
        _LOGGER.info("Test sunset TTS dispatched")

    async def fire_test_nws_alert(self, *, request_id: str | None = None) -> None:
        """Play the configured NWS siren/TTS using a fake alert payload."""
        config = self._get_config()
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("No media players with TTS configured for NWS test")
            _fire_tts_status(
                self.hass, "skipped",
                request_id=request_id, reason="No media players with TTS configured",
                alert_kind="nws_alert",
            )
            return
        sample = {
            "event": "Test Alert",
            "description": (
                "* WHAT...This is a Home Weather test alert.\n\n"
                "* IMPACTS...No active warnings are in effect."
            ),
        }
        await play_nws_alert_notification(self.hass, config, sample, media_players, request_id=request_id)
        _LOGGER.info("Test NWS alert dispatched")

    async def _fire_test_section_siren(
        self,
        section_key: str,
        alert_kind: str,
        *,
        request_id: str | None = None,
    ) -> None:
        """Play the configured siren for an alert section (no TTS)."""
        config = self._get_config()
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("No media players with TTS configured for %s test", alert_kind)
            _fire_tts_status(
                self.hass, "skipped",
                request_id=request_id, reason="No media players with TTS configured",
                alert_kind=alert_kind,
            )
            return
        section = config.get(section_key, {})
        from .sounds_setup import normalize_nws_sound_filename, sound_file_exists

        sound_file = normalize_nws_sound_filename(section.get("sound_file") or "")
        if not sound_file:
            _LOGGER.warning("No siren sound file configured for %s", section_key)
            _fire_tts_status(
                self.hass, "skipped",
                request_id=request_id, reason="No siren sound file configured",
                alert_kind=alert_kind,
            )
            return
        if not sound_file_exists(self.hass, sound_file):
            _LOGGER.warning("Siren sound file not found: %s", sound_file)
            _fire_tts_status(
                self.hass, "failed",
                request_id=request_id,
                reason="Sound file not found in config/www/home_weather/sounds/",
                alert_kind=alert_kind,
            )
            return
        await play_hazard_siren(
            self.hass, section, media_players, request_id=request_id, alert_kind=alert_kind,
        )
        _LOGGER.info("Test %s dispatched", alert_kind)

    async def fire_test_nws_siren(self, *, request_id: str | None = None) -> None:
        """Play the configured NWS siren only (no TTS)."""
        await self._fire_test_section_siren("nws_alerts", "nws_siren", request_id=request_id)

    async def fire_test_tropical_siren(self, *, request_id: str | None = None) -> None:
        """Play the configured hurricane siren only (no TTS)."""
        await self._fire_test_section_siren("tropical_alerts", "tropical_siren", request_id=request_id)

    async def fire_test_tornado_siren(self, *, request_id: str | None = None) -> None:
        """Play the configured tornado siren only (no TTS)."""
        await self._fire_test_section_siren("tornado_alerts", "tornado_siren", request_id=request_id)

    async def fire_test_earthquake_siren(self, *, request_id: str | None = None) -> None:
        """Play the configured earthquake siren only (no TTS)."""
        await self._fire_test_section_siren("earthquake_alerts", "earthquake_siren", request_id=request_id)

    async def fire_test_volcano_siren(self, *, request_id: str | None = None) -> None:
        """Play the configured volcano siren only (no TTS)."""
        await self._fire_test_section_siren("volcano_alerts", "volcano_siren", request_id=request_id)

    async def fire_test_wildfire_siren(self, *, request_id: str | None = None) -> None:
        """Play the configured wildfire siren only (no TTS)."""
        await self._fire_test_section_siren("wildfire_alerts", "wildfire_siren", request_id=request_id)

    async def fire_test_air_quality_siren(self, *, request_id: str | None = None) -> None:
        """Play the configured air quality siren only (no TTS)."""
        await self._fire_test_section_siren(
            "air_quality_alerts", "air_quality_siren", request_id=request_id
        )

    async def fire_test_tropical_alert(self, *, request_id: str | None = None) -> None:
        """Play sample tropical cyclone TTS alert."""
        config = self._get_config()
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _fire_tts_status(
                self.hass, "skipped", request_id=request_id,
                reason="No media players with TTS configured", alert_kind="tropical_alert",
            )
            return
        sample = {
            "event_kind": "inside_cone",
            "closestStormName": "Test Storm",
            "distanceToCenterMiles": 120,
            "estimatedClosestApproachHour": 36,
        }
        msg = format_tropical_alert_for_tts(sample)
        await play_hazard_alert_notification(
            self.hass, config, "tropical_alerts", msg, media_players,
            request_id=request_id, alert_kind="tropical_alert",
        )

    async def fire_test_tornado_alert(self, *, request_id: str | None = None) -> None:
        """Play sample tornado warning TTS alert."""
        config = self._get_config()
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _fire_tts_status(
                self.hass, "skipped", request_id=request_id,
                reason="No media players with TTS configured", alert_kind="tornado_alert",
            )
            return
        sample = {
            "affecting_home": True,
            "headline": "This is a Home Weather test tornado warning.",
            "distance_miles": 0,
        }
        msg = format_tornado_warning_for_tts(sample)
        await play_hazard_alert_notification(
            self.hass, config, "tornado_alerts", msg, media_players,
            request_id=request_id, alert_kind="tornado_alert",
        )

    async def fire_test_earthquake_alert(self, *, request_id: str | None = None) -> None:
        """Play sample earthquake TTS alert."""
        config = self._get_config()
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _fire_tts_status(
                self.hass, "skipped", request_id=request_id,
                reason="No media players with TTS configured", alert_kind="earthquake_alert",
            )
            return
        sample = {
            "magnitude": 4.2,
            "place": "near San Jose, California",
            "distance_miles": 45,
            "depth_km": 8,
            "tsunami": 0,
        }
        msg = format_earthquake_alert_for_tts(sample)
        await play_hazard_alert_notification(
            self.hass, config, "earthquake_alerts", msg, media_players,
            request_id=request_id, alert_kind="earthquake_alert",
        )

    async def fire_test_volcano_alert(self, *, request_id: str | None = None) -> None:
        """Play sample volcano TTS alert."""
        config = self._get_config()
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _fire_tts_status(
                self.hass, "skipped", request_id=request_id,
                reason="No media players with TTS configured", alert_kind="volcano_alert",
            )
            return
        sample = {
            "name": "Mount Test",
            "activity_level": "watch",
            "distance_miles": 120,
            "synopsis": "This is a Home Weather test volcano alert.",
        }
        msg = format_volcano_alert_for_tts(sample)
        await play_hazard_alert_notification(
            self.hass, config, "volcano_alerts", msg, media_players,
            request_id=request_id, alert_kind="volcano_alert",
        )

    async def fire_test_wildfire_alert(self, *, request_id: str | None = None) -> None:
        """Play sample wildfire TTS alert."""
        config = self._get_config()
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _fire_tts_status(
                self.hass, "skipped", request_id=request_id,
                reason="No media players with TTS configured", alert_kind="wildfire_alert",
            )
            return
        sample = {
            "name": "Sample Wildfire",
            "location": "Sample County, CA",
            "state": "CA",
            "acres": 2500,
            "percent_contained": 15,
            "distance_miles": 42,
        }
        msg = format_wildfire_alert_for_tts(sample)
        await play_hazard_alert_notification(
            self.hass, config, "wildfire_alerts", msg, media_players,
            request_id=request_id, alert_kind="wildfire_alert",
        )

    async def fire_test_air_quality_alert(self, *, request_id: str | None = None) -> None:
        """Play sample air quality TTS alert."""
        config = self._get_config()
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _fire_tts_status(
                self.hass, "skipped", request_id=request_id,
                reason="No media players with TTS configured", alert_kind="air_quality_alert",
            )
            return
        sample = {
            "name": "Sample City",
            "state": "NY",
            "aqi": 156,
            "category": "Unhealthy",
            "category_level": 4,
            "distance_miles": 8,
        }
        msg = format_air_quality_alert_for_tts(sample)
        await play_hazard_alert_notification(
            self.hass, config, "air_quality_alerts", msg, media_players,
            request_id=request_id, alert_kind="air_quality_alert",
        )

    async def fire_test_travel_alert(self, *, request_id: str | None = None) -> None:
        """Play sample travel advisory TTS alert."""
        config = self._get_config()
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _fire_tts_status(
                self.hass, "skipped", request_id=request_id,
                reason="No media players with TTS configured", alert_kind="travel_alert",
            )
            return
        sample = {
            "country": "Example Country",
            "level": 3,
            "level_name": "Reconsider Travel",
            "summary_text": "This is a Home Weather test travel advisory.",
        }
        msg = format_travel_advisory_for_tts(sample)
        await play_hazard_alert_notification(
            self.hass, config, "travel_alerts", msg, media_players,
            request_id=request_id, alert_kind="travel_alert",
        )

    async def fire_test_travel_siren(self, *, request_id: str | None = None) -> None:
        """Play the configured travel advisory siren only (no TTS)."""
        await self._fire_test_section_siren("travel_alerts", "travel_siren", request_id=request_id)

    async def fire_test_spacecraft_alert(self, *, request_id: str | None = None) -> None:
        """Play sample spacecraft overhead TTS alert."""
        config = self._get_config()
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _fire_tts_status(
                self.hass, "skipped", request_id=request_id,
                reason="No media players with TTS configured", alert_kind="spacecraft_alert",
            )
            return
        sample = {
            "name": "International Space Station",
            "craft_name": "International Space Station",
            "max_elevation_deg": 72,
        }
        msg = format_spacecraft_alert_for_tts(sample)
        await play_hazard_alert_notification(
            self.hass, config, "spacecraft_alerts", msg, media_players,
            request_id=request_id, alert_kind="spacecraft_alert",
        )

    async def fire_test_spacecraft_siren(self, *, request_id: str | None = None) -> None:
        """Play the configured spacecraft alert siren only (no TTS)."""
        await self._fire_test_section_siren(
            "spacecraft_alerts", "spacecraft_siren", request_id=request_id
        )

    async def fire_test_solar_weather_alert(self, *, request_id: str | None = None) -> None:
        """Play sample solar weather TTS alert."""
        config = self._get_config()
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _fire_tts_status(
                self.hass, "skipped", request_id=request_id,
                reason="No media players with TTS configured", alert_kind="solar_weather_alert",
            )
            return
        sample = {"type": "geomagnetic_storm", "k_index": 6, "g_scale": 2}
        msg = format_solar_weather_alert_for_tts(sample)
        await play_hazard_alert_notification(
            self.hass, config, "solar_weather_alerts", msg, media_players,
            request_id=request_id, alert_kind="solar_weather_alert",
        )

    async def fire_test_solar_weather_siren(self, *, request_id: str | None = None) -> None:
        """Play the configured solar weather siren only (no TTS)."""
        await self._fire_test_section_siren(
            "solar_weather_alerts", "solar_weather_siren", request_id=request_id
        )

    async def fire_test_neo_alert(self, *, request_id: str | None = None) -> None:
        """Play sample NEO close approach TTS alert."""
        config = self._get_config()
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _fire_tts_status(
                self.hass, "skipped", request_id=request_id,
                reason="No media players with TTS configured", alert_kind="neo_alert",
            )
            return
        sample = {
            "name": "Sample Asteroid",
            "lunar_distance": 2.5,
            "close_approach_date": "2026-07-15",
        }
        msg = format_neo_alert_for_tts(sample)
        await play_hazard_alert_notification(
            self.hass, config, "neo_alerts", msg, media_players,
            request_id=request_id, alert_kind="neo_alert",
        )

    async def fire_test_neo_siren(self, *, request_id: str | None = None) -> None:
        """Play the configured NEO alert siren only (no TTS)."""
        await self._fire_test_section_siren("neo_alerts", "neo_siren", request_id=request_id)

    async def _setup_upcoming_change_trigger(self, tts_config: dict[str, Any]) -> None:
        """Set up trigger for upcoming precipitation alerts.
        
        Checks every 5 minutes for precipitation in the forecast.
        Only fires once per forecast period.
        """
        minutes_before = tts_config.get("minutes_before_announce", 30)
        precip_threshold = tts_config.get("precip_threshold", 30)
        
        @callback
        def _check_upcoming(now: datetime) -> None:
            """Check for upcoming precipitation."""
            self.hass.async_create_task(
                self._check_upcoming_precip(minutes_before, precip_threshold)
            )
        
        # Check every 5 minutes
        unsub = async_track_time_interval(
            self.hass,
            _check_upcoming,
            timedelta(minutes=5),
        )
        self._unsub_callbacks.append(unsub)
        _LOGGER.debug("Upcoming change trigger set up")

    async def _setup_sensor_triggers(self, tts_config: dict[str, Any]) -> None:
        """Set up triggers for user-defined sensor state changes.
        
        Fires a full forecast when any configured sensor enters its trigger state.
        Supports any entity type (not just binary sensors).
        Each sensor trigger can target a specific media player or all players.
        """
        sensor_triggers = tts_config.get("sensor_triggers", [])
        if not sensor_triggers:
            return
        
        # Build a mapping from entity_id to {trigger_state, media_player}
        trigger_map = {}
        for trigger in sensor_triggers:
            entity_id = trigger.get("entity_id")
            trigger_state = trigger.get("trigger_state", "on")
            media_player = trigger.get("media_player", "")  # Empty = all players
            if entity_id:
                trigger_map[entity_id] = {
                    "trigger_state": trigger_state,
                    "media_player": media_player,
                }
        
        if not trigger_map:
            return
        
        @callback
        def _sensor_changed(event: Event) -> None:
            """Handle sensor state change."""
            new_state = event.data.get("new_state")
            old_state = event.data.get("old_state")
            
            if not new_state or not old_state:
                return
            
            entity_id = new_state.entity_id
            trigger_info = trigger_map.get(entity_id)
            
            if trigger_info is None:
                return
            
            target_state = trigger_info["trigger_state"]
            target_media_player = trigger_info["media_player"]
            
            # Fire when sensor enters the configured trigger state
            if old_state.state != target_state and new_state.state == target_state:
                self.hass.async_create_task(
                    self._fire_scheduled_forecast(target_media_player=target_media_player)
                )
        
        unsub = async_track_state_change_event(
            self.hass,
            list(trigger_map.keys()),
            _sensor_changed,
        )
        self._unsub_callbacks.append(unsub)
        _LOGGER.debug("Sensor triggers set up for %s", list(trigger_map.keys()))

    async def _setup_webhook_trigger(self, tts_config: dict[str, Any]) -> None:
        """Set up webhook triggers for personalized forecasts.
        
        Registers with Home Assistant using local_only=False and POST/PUT/GET/HEAD
        to match native HA webhook behavior. Records last trigger timestamp.
        """
        from homeassistant.components import webhook
        
        webhooks = tts_config.get("webhooks", [])
        
        # Backward compatibility: support old single webhook config
        if not webhooks:
            old_webhook_id = tts_config.get("webhook_id")
            old_personal_name = tts_config.get("personal_name", "")
            if old_webhook_id:
                webhooks = [{"webhook_id": old_webhook_id, "personal_name": old_personal_name, "enabled": True}]
        
        if not webhooks:
            _LOGGER.debug("No webhooks configured")
            return
        
        if WEBHOOK_LAST_TRIGGERED_KEY not in self.hass.data:
            self.hass.data[WEBHOOK_LAST_TRIGGERED_KEY] = {}
        
        for webhook_config in webhooks:
            if not webhook_config.get("enabled", True):
                _LOGGER.debug("Webhook %s is disabled, skipping", webhook_config.get("webhook_id"))
                continue
            
            webhook_id = webhook_config.get("webhook_id")
            if not webhook_id:
                _LOGGER.debug("Empty webhook_id, skipping")
                continue
            
            personal_name = webhook_config.get("personal_name", "")
            target_media_player = webhook_config.get("media_player", "")  # Empty = all players
            
            # Create the handler with proper closure binding
            # Capture self, webhook_id, personal_name, and target_media_player in the closure
            handler = self._create_webhook_handler(webhook_id, personal_name, target_media_player)
            
            try:
                webhook.async_register(
                    self.hass,
                    DOMAIN,
                    f"Weather Forecast ({personal_name or webhook_id})",
                    webhook_id,
                    handler,
                    local_only=False,
                    allowed_methods=["POST", "PUT", "GET", "HEAD"],
                )
                self._registered_webhooks.append(webhook_id)
                _LOGGER.info("Webhook registered successfully: %s (name: %s)", webhook_id, personal_name or "N/A")
            except Exception as e:
                _LOGGER.error("Failed to register webhook %s: %s", webhook_id, e, exc_info=True)
    
    def _create_webhook_handler(self, webhook_id: str, personal_name: str, target_media_player: str = ""):
        """Create a webhook handler with proper closure binding."""
        async def handle_webhook(hass: HomeAssistant, wh_id: str, request) -> None:
            """Handle incoming webhook request."""
            _LOGGER.info("Webhook triggered: %s (method: %s)", wh_id, request.method)
            
            data = {}
            if request.method in ("POST", "PUT"):
                try:
                    data = await request.json()
                    _LOGGER.debug("Webhook payload: %s", data)
                except Exception as e:
                    _LOGGER.debug("No JSON body or parse error: %s", e)
            
            req_name = data.get("name") or personal_name
            volume = data.get("volume")
            
            # Update last triggered timestamp
            timestamp = datetime.utcnow().isoformat() + "Z"
            try:
                self.hass.data[WEBHOOK_LAST_TRIGGERED_KEY][webhook_id] = timestamp
                _LOGGER.debug("Updated last_triggered for webhook %s", webhook_id)
            except Exception as e:
                _LOGGER.error("Failed to update last_triggered: %s", e)
            
            # Fire an event so the frontend can update the status dot in real-time
            self.hass.bus.async_fire(
                "home_weather_webhook_triggered",
                {
                    "webhook_id": webhook_id,
                    "personal_name": personal_name,
                    "timestamp": timestamp,
                },
            )
            _LOGGER.debug("Fired home_weather_webhook_triggered event for %s", webhook_id)
            
            # Fire the webhook forecast (target specific media player if configured)
            try:
                await self._fire_webhook_forecast(req_name, volume, target_media_player=target_media_player)
            except Exception as e:
                _LOGGER.error("Failed to fire webhook forecast: %s", e, exc_info=True)
        
        return handle_webhook

    async def _setup_voice_satellite_trigger(self, tts_config: dict[str, Any]) -> None:
        """Set up voice satellite (conversation) triggers.

        Registers an intent handler ``HomeWeatherForecast`` and adds the user
        configured phrases as ``conversation`` sentence triggers. Falls back to
        registering only the intent handler if sentence registration is not
        supported on the running Home Assistant version.
        """
        commands_text = tts_config.get("conversation_commands", "")
        commands = [c.strip() for c in commands_text.split("\n") if c.strip()]
        if not commands:
            _LOGGER.debug("Voice satellite enabled but no commands configured")
            return

        try:
            from homeassistant.helpers import intent
        except Exception as err:
            _LOGGER.warning("Voice satellite unavailable (intent helper missing): %s", err)
            return

        manager = self

        class _ForecastIntentHandler(intent.IntentHandler):
            intent_type = "HomeWeatherForecast"
            description = "Speak the Home Weather forecast on configured media players."

            async def async_handle(self, intent_obj):
                manager.hass.async_create_task(
                    manager._fire_scheduled_forecast(refresh_weather=True)
                )
                response = intent_obj.create_response()
                response.async_set_speech("Here is your weather forecast.")
                return response

        try:
            intent.async_register(self.hass, _ForecastIntentHandler())
            _LOGGER.info("Registered HomeWeatherForecast intent")
        except Exception as err:
            _LOGGER.warning("Could not register HomeWeatherForecast intent: %s", err)
            return

        # Register sentences with the conversation component when available so
        # the configured phrases route to our intent without YAML.
        try:
            from homeassistant.components import conversation

            register_trigger = getattr(conversation, "async_register_trigger", None)
            if register_trigger is None:
                _LOGGER.debug(
                    "conversation.async_register_trigger missing; relying on intent slot"
                )
            else:
                @callback
                def _on_match(_sentence: str, _result: Any) -> None:
                    self.hass.async_create_task(
                        self._fire_scheduled_forecast(refresh_weather=True)
                    )

                unsub = register_trigger(self.hass, commands, _on_match)
                if callable(unsub):
                    self._unsub_callbacks.append(unsub)
                _LOGGER.info("Voice satellite phrases registered: %s", commands)
        except Exception as err:
            _LOGGER.debug(
                "Voice satellite sentence registration not available: %s", err
            )

    async def _setup_sun_alerts_trigger(self, config: dict[str, Any]) -> None:
        """Set up sunrise/sunset TTS and automation triggers.

        Uses sun.sun entity's next_rising/next_setting. Runs every 60 seconds.
        At minutes_before: TTS upcoming message, repeat at interval_minutes.
        At sunrise/sunset (±1 min): TTS final message, then trigger automation if enabled.
        """
        sun_alerts = config.get("sun_alerts", {})
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("No media players with TTS for sun alerts, skipping")
            return

        def _parse_sun_time(val: str | None) -> datetime | None:
            if not val:
                return None
            try:
                dt = dt_util.parse_datetime(str(val).replace("Z", "+00:00"))
                return dt_util.as_local(dt) if dt and dt.tzinfo else dt
            except Exception:
                return None

        @callback
        def _check_sun_alerts(now: datetime) -> None:
            self.hass.async_create_task(self._check_sun_alerts_async())

        unsub = async_track_time_interval(
            self.hass,
            _check_sun_alerts,
            timedelta(minutes=1),
        )
        self._unsub_callbacks.append(unsub)
        _LOGGER.debug("Sun alerts trigger set up (check every 60s)")

    async def _check_sun_alerts_async(self) -> None:
        """Check sunrise/sunset and fire TTS/automation as needed."""
        config = self._get_config()
        sun_alerts = config.get("sun_alerts", {})
        tts_config = config.get("tts", {})
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players or not sun_alerts.get("enabled"):
            return

        sun_state = self.hass.states.get("sun.sun")
        if not sun_state or not sun_state.attributes:
            return

        now = dt_util.now()
        today_key = now.strftime("%Y-%m-%d")

        # Reset daily: clear final_fired and last_upcoming from previous days
        self._sun_alerts_final_fired = {k for k in self._sun_alerts_final_fired if k.endswith(f"_{today_key}")}
        self._sun_alerts_last_upcoming = {k: v for k, v in self._sun_alerts_last_upcoming.items() if k.endswith(f"_{today_key}")}

        def _parse(val: str | None) -> datetime | None:
            if not val:
                return None
            try:
                dt = dt_util.parse_datetime(str(val).replace("Z", "+00:00"))
                return dt_util.as_local(dt) if dt and dt.tzinfo else dt
            except Exception:
                return None

        next_rising = _parse(sun_state.attributes.get("next_rising"))
        next_setting = _parse(sun_state.attributes.get("next_setting"))

        # Sunrise TTS and automation
        sunrise_tts = sun_alerts.get("sunrise_tts") or {}
        sunrise_auto = sun_alerts.get("sunrise_automation") or {}
        if sunrise_tts.get("enabled") and next_rising:
            mins_before = sunrise_tts.get("minutes_before", 15)
            interval = sunrise_tts.get("interval_minutes", 5)
            window_start = next_rising - timedelta(minutes=mins_before)
            event_key_up = f"sunrise_up_{today_key}"
            event_key_final = f"sunrise_final_{today_key}"

            if now >= next_rising:
                diff_mins = (now - next_rising).total_seconds() / 60
                if diff_mins <= 1 and event_key_final not in self._sun_alerts_final_fired:
                    self._sun_alerts_final_fired.add(event_key_final)
                    automation_triggered = False
                    if sunrise_auto.get("enabled") and sunrise_auto.get("entity_id"):
                        try:
                            await self.hass.services.async_call(
                                "automation",
                                "trigger",
                                {"entity_id": sunrise_auto["entity_id"]},
                            )
                            automation_triggered = True
                            _LOGGER.info("Sunrise automation triggered: %s", sunrise_auto["entity_id"])
                        except Exception as e:
                            _LOGGER.warning("Sunrise automation failed: %s", e)
                    msg = build_sunrise_final_message(automation_triggered)
                    await dispatch_tts_and_wait(
                        self.hass, media_players, tts_config, msg,
                        alert_kind="sunrise",
                        config=config, type_id="sun_alerts",
                    )
                    _LOGGER.info("Sunrise final TTS sent")
            elif window_start <= now < next_rising:
                mins_until = int((next_rising - now).total_seconds() / 60)
                last = self._sun_alerts_last_upcoming.get(event_key_up)
                if last is None or (now - last).total_seconds() >= interval * 60:
                    self._sun_alerts_last_upcoming[event_key_up] = now
                    msg = build_sunrise_upcoming_message(mins_until)
                    await dispatch_tts_and_wait(
                        self.hass, media_players, tts_config, msg,
                        alert_kind="sunrise",
                        config=config, type_id="sun_alerts",
                    )
                    _LOGGER.info("Sunrise upcoming TTS: %d minutes", mins_until)

        # Sunset TTS and automation
        sunset_tts = sun_alerts.get("sunset_tts") or {}
        sunset_auto = sun_alerts.get("sunset_automation") or {}
        if sunset_tts.get("enabled") and next_setting:
            mins_before = sunset_tts.get("minutes_before", 15)
            interval = sunset_tts.get("interval_minutes", 5)
            window_start = next_setting - timedelta(minutes=mins_before)
            event_key_up = f"sunset_up_{today_key}"
            event_key_final = f"sunset_final_{today_key}"

            if now >= next_setting:
                diff_mins = (now - next_setting).total_seconds() / 60
                if diff_mins <= 1 and event_key_final not in self._sun_alerts_final_fired:
                    self._sun_alerts_final_fired.add(event_key_final)
                    automation_triggered = False
                    if sunset_auto.get("enabled") and sunset_auto.get("entity_id"):
                        try:
                            await self.hass.services.async_call(
                                "automation",
                                "trigger",
                                {"entity_id": sunset_auto["entity_id"]},
                            )
                            automation_triggered = True
                            _LOGGER.info("Sunset automation triggered: %s", sunset_auto["entity_id"])
                        except Exception as e:
                            _LOGGER.warning("Sunset automation failed: %s", e)
                    msg = build_sunset_final_message(automation_triggered)
                    await dispatch_tts_and_wait(
                        self.hass, media_players, tts_config, msg,
                        alert_kind="sunset",
                        config=config, type_id="sun_alerts",
                    )
                    _LOGGER.info("Sunset final TTS sent")
            elif window_start <= now < next_setting:
                mins_until = int((next_setting - now).total_seconds() / 60)
                last = self._sun_alerts_last_upcoming.get(event_key_up)
                if last is None or (now - last).total_seconds() >= interval * 60:
                    self._sun_alerts_last_upcoming[event_key_up] = now
                    msg = build_sunset_upcoming_message(mins_until)
                    await dispatch_tts_and_wait(
                        self.hass, media_players, tts_config, msg,
                        alert_kind="sunset",
                        config=config, type_id="sun_alerts",
                    )
                    _LOGGER.info("Sunset upcoming TTS: %d minutes", mins_until)

        # Expire _sun_alerts_last_upcoming entries older than 2 hours.
        # (Daily key reset for _sun_alerts_final_fired and _sun_alerts_last_upcoming
        # is already handled at the top of this method via the today_key filter.)
        upcoming_cutoff = now - timedelta(hours=2)
        self._sun_alerts_last_upcoming = {
            k: v for k, v in self._sun_alerts_last_upcoming.items()
            if v >= upcoming_cutoff
        }

    async def _setup_nws_alerts_trigger(self, config: dict[str, Any]) -> None:
        """Poll NWS API every 5 minutes; play sound + TTS when new active alert appears."""
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("NWS alerts enabled but no media players with TTS configured")
            return

        lat = self.hass.config.latitude
        lon = self.hass.config.longitude
        if lat is None or lon is None:
            _LOGGER.warning("Home coordinates not configured, cannot poll NWS alerts")
            return

        if not hasattr(self, "_nws_known_alert_ids"):
            self._nws_known_alert_ids: set[str] = set()

        @callback
        def _poll(now: datetime) -> None:
            # Must run on the event loop: async_track_time_interval runs
            # non-callback functions in the executor, where async_create_task
            # is not thread-safe and the coroutine would never be awaited.
            self.hass.async_create_task(self._check_nws_alerts_async())

        unsub = async_track_time_interval(self.hass, _poll, timedelta(minutes=5))
        self._unsub_callbacks.append(unsub)
        await self._check_nws_alerts_async()
        _LOGGER.info("NWS alerts trigger set up (polling every 5 min)")

    async def _check_nws_alerts_async(
        self,
        *,
        notify_new: bool = True,
    ) -> None:
        """Fetch NWS alerts and fire notification for newly seen active alerts."""
        config = self._get_config()
        nws = config.get("nws_alerts", {})
        media_players = media_players_with_tts(config.get("media_players", []))
        if not nws.get("enabled") or not media_players:
            return

        lat = self.hass.config.latitude
        lon = self.hass.config.longitude
        if lat is None or lon is None:
            return

        url = f"https://api.weather.gov/alerts/active?point={lat},{lon}"
        known = getattr(self, "_nws_known_alert_ids", set())

        try:
            session = async_get_clientsession(self.hass)
            async with session.get(url) as resp:
                if resp.status != 200:
                    _LOGGER.warning("NWS API returned %s", resp.status)
                    return
                data = await resp.json()
        except Exception as e:
            _LOGGER.warning("NWS alerts fetch failed: %s", e)
            return

        features = data.get("features") or []
        now = dt_util.now()
        active_ids: set[str] = set()
        active_alerts: list[dict[str, Any]] = []
        bootstrap = not getattr(self, "_nws_bootstrapped", False)

        for feat in features:
            props = feat.get("properties") or {}
            aid = props.get("id")
            if not aid:
                continue
            exp = props.get("expires") or props.get("ends")
            if exp:
                try:
                    exp_dt = dt_util.parse_datetime(str(exp).replace("Z", "+00:00"))
                    if exp_dt and now > exp_dt:
                        continue
                except Exception:
                    pass
            active_ids.add(aid)
            active_alerts.append(props)
            if notify_new and not bootstrap and aid not in known:
                known.add(aid)
                await play_nws_alert_notification(
                    self.hass,
                    config,
                    props,
                    media_players,
                )
                _LOGGER.info("NWS alert fired: %s", props.get("event", aid))

        if bootstrap:
            known.update(active_ids)
            self._nws_bootstrapped = True
            _LOGGER.debug(
                "NWS alerts bootstrap: seeded %d active alert IDs without announcing",
                len(active_ids),
            )

        self._nws_active_alerts = active_alerts
        self._nws_known_alert_ids = {x for x in known if x in active_ids}

    async def _fire_scheduled_forecast(
        self,
        target_media_player: str = "",
        *,
        refresh_weather: bool = True,
        request_id: str | None = None,
    ) -> None:
        """Fire a scheduled forecast TTS.
        
        Args:
            target_media_player: If specified, only send to this media player.
                               If empty, send to all configured media players.
            refresh_weather: Whether to refresh coordinator data before building message.
            request_id: Optional correlation id for TTS status events.
        """
        config = self._get_config()
        weather_data = await self._resolve_weather_data(refresh=refresh_weather)
        tts_config = config.get("tts", {})
        media_players = media_players_with_tts(
            config.get("media_players", []),
            fallback_tts_entity=tts_config.get("engine"),
        )

        if not media_players:
            _LOGGER.warning("No media players with TTS configured, skipping scheduled TTS")
            _fire_tts_status(
                self.hass, "skipped",
                request_id=request_id, reason="No media players with TTS configured",
                alert_kind="scheduled_forecast",
            )
            return

        if not _weather_data_usable(weather_data):
            _LOGGER.warning(
                "Weather data unavailable, skipping scheduled TTS (configured=%s)",
                weather_data.get("configured"),
            )
            _fire_tts_status(
                self.hass, "skipped",
                request_id=request_id, reason="Weather data unavailable",
                alert_kind="scheduled_forecast",
            )
            return

        # Filter to specific media player if specified
        if target_media_player:
            media_players = [mp for mp in media_players if mp.get("entity_id") == target_media_player]
            if not media_players:
                _LOGGER.warning("Target media player %s not found in config", target_media_player)
                _fire_tts_status(
                    self.hass, "skipped",
                    request_id=request_id, reason=f"Target media player {target_media_player} not found",
                    alert_kind="scheduled_forecast",
                )
                return

        from .tts_notifications import resolve_announcement_players

        resolved_players = resolve_announcement_players(
            config, "scheduled_forecast", media_players
        )
        if not resolved_players:
            skipped = [
                mp.get("entity_id")
                for mp in media_players
                if mp.get("entity_id")
            ]
            _LOGGER.warning(
                "All media players bypassed for scheduled_forecast, skipping scheduled TTS: %s",
                skipped,
            )
            _fire_tts_status(
                self.hass, "skipped",
                request_id=request_id,
                reason="All speakers set to Skip for scheduled forecast",
                alert_kind="scheduled_forecast",
            )
            return

        message = build_scheduled_forecast(weather_data, config)
        if not message or not message.strip():
            _LOGGER.warning("Scheduled forecast message was empty, skipping TTS")
            _fire_tts_status(
                self.hass, "skipped",
                request_id=request_id, reason="Forecast message was empty",
                alert_kind="scheduled_forecast",
            )
            return

        player_ids = [mp.get("entity_id") for mp in resolved_players if mp.get("entity_id")]
        _LOGGER.info(
            "Scheduled forecast TTS: %d chars to %s",
            len(message),
            ", ".join(player_ids) or "no players",
        )
        _LOGGER.debug(
            "Scheduled forecast preview: %s",
            (message[:100] + "...") if len(message) > 100 else message,
        )
        await dispatch_tts_and_wait(
            self.hass,
            resolved_players,
            tts_config,
            message,
            request_id=request_id,
            alert_kind="scheduled_forecast",
        )
        _LOGGER.info(
            "Scheduled forecast TTS sent to %s (%d speaker(s))",
            target_media_player or "all players",
            len(resolved_players),
        )

        await self._maybe_replay_nws_alerts_after_forecast(
            config, resolved_players, request_id=request_id
        )

    async def _maybe_replay_nws_alerts_after_forecast(
        self,
        config: dict[str, Any],
        media_players: list[dict[str, Any]],
        *,
        request_id: str | None = None,
    ) -> None:
        """After a time-based forecast, replay active NWS alerts if configured."""
        nws = config.get("nws_alerts") or {}
        if not nws.get("enabled"):
            _LOGGER.debug("Skipping NWS replay after forecast: NWS alerts disabled")
            return
        if not nws.get("replay_on_time_based_forecast", True):
            _LOGGER.debug("Skipping NWS replay after forecast: replay toggle off")
            return

        # Refresh from the API so replay is not limited to the last 5-minute poll.
        await self._check_nws_alerts_async(notify_new=False)
        alerts = getattr(self, "_nws_active_alerts", [])
        if not alerts:
            _LOGGER.debug("Skipping NWS replay after forecast: no active alerts")
            return

        await replay_active_nws_alerts(
            self.hass,
            config,
            media_players,
            alerts,
            request_id=request_id,
        )
        _LOGGER.info("NWS active alert replay after scheduled forecast (%d alerts)", len(alerts))

    async def _fire_current_change(
        self,
        old_condition: str,
        new_condition: str,
        *,
        refresh_weather: bool = True,
        request_id: str | None = None,
    ) -> None:
        """Fire a current change alert TTS."""
        config = self._get_config()
        weather_data = await self._resolve_weather_data(refresh=refresh_weather)
        tts_config = config.get("tts", {})
        media_players = media_players_with_tts(config.get("media_players", []))
        volume = None  # Volume controlled per media player

        if not media_players:
            _LOGGER.warning("No media players with TTS configured, skipping current change TTS")
            _fire_tts_status(
                self.hass, "skipped",
                request_id=request_id, reason="No media players with TTS configured",
                alert_kind="current_change",
            )
            return
        
        if not _weather_data_usable(weather_data):
            _LOGGER.warning("Weather data unavailable, skipping current change TTS")
            _fire_tts_status(
                self.hass, "skipped",
                request_id=request_id, reason="Weather data unavailable",
                alert_kind="current_change",
            )
            return
        
        message = build_current_change_message(old_condition, new_condition, weather_data)
        await dispatch_tts(
            self.hass,
            media_players,
            tts_config,
            message,
            volume_override=volume,
            request_id=request_id,
            alert_kind="current_change",
            config=config, type_id="current_change",
        )
        _LOGGER.info("Current change TTS sent: %s -> %s", old_condition, new_condition)

    async def _check_upcoming_precip(self, minutes_before: int, threshold: int) -> None:
        """Check for upcoming precipitation and fire alert if needed."""
        config = self._get_config()
        weather_data = await self._resolve_weather_data(refresh=False)
        tts_config = config.get("tts", {})
        media_players = media_players_with_tts(config.get("media_players", []))

        if not media_players:
            return

        if not _weather_data_usable(weather_data):
            return

        hourly = weather_data.get("hourly_forecast", [])
        current = weather_data.get("current") or {}
        now = dt_util.now()

        match = find_upcoming_precip_alert(
            current,
            hourly,
            minutes_before=minutes_before,
            threshold=threshold,
            now=now,
        )
        if not match:
            return

        alert_key = match["alert_key"]
        if alert_key in self._upcoming_alert_fired:
            return

        self._upcoming_alert_fired.add(alert_key)
        message = build_upcoming_change_message(
            match["precip_kind"],
            match["minutes_until"],
            match["probability"],
        )

        await dispatch_tts(
            self.hass,
            media_players,
            tts_config,
            message,
            volume_override=None,
            alert_kind="upcoming_change",
            config=config, type_id="upcoming_change",
        )
        _LOGGER.info(
            "Upcoming precip TTS sent: %s in %d minutes",
            match["precip_kind"],
            match["minutes_until"],
        )

        cutoff_key = (now - timedelta(hours=2)).strftime("%Y-%m-%d-%H")
        self._upcoming_alert_fired = {k for k in self._upcoming_alert_fired if k > cutoff_key}

    async def _fire_webhook_forecast(
        self,
        name: str,
        volume: float | None,
        target_media_player: str = "",
        *,
        request_id: str | None = None,
    ) -> None:
        """Fire a webhook-triggered forecast.
        
        Args:
            name: Personal name for greeting
            volume: Optional volume override
            target_media_player: If specified, only send to this media player.
                               If empty, send to all configured media players.
            request_id: Optional correlation id for TTS status events.
        """
        _LOGGER.info("_fire_webhook_forecast called with name=%s, volume=%s, target=%s", name, volume, target_media_player)
        
        config = self._get_config()
        weather_data = await self._resolve_weather_data(refresh=True)
        tts_config = config.get("tts", {})
        media_players = media_players_with_tts(config.get("media_players", []))
        
        _LOGGER.debug("Config has %d media players with TTS configured", len(media_players))
        
        if not media_players:
            _LOGGER.warning("No media players configured, cannot send TTS")
            _fire_tts_status(
                self.hass, "skipped",
                request_id=request_id, reason="No media players configured",
                alert_kind="webhook",
            )
            return
        
        if not _weather_data_usable(weather_data):
            _LOGGER.warning("Weather data unavailable, skipping webhook TTS")
            _fire_tts_status(
                self.hass, "skipped",
                request_id=request_id, reason="Weather data unavailable",
                alert_kind="webhook",
            )
            return
        
        # Filter to specific media player if specified
        if target_media_player:
            media_players = [mp for mp in media_players if mp.get("entity_id") == target_media_player]
            if not media_players:
                _LOGGER.warning("Target media player %s not found in config", target_media_player)
                _fire_tts_status(
                    self.hass, "skipped",
                    request_id=request_id, reason=f"Target media player {target_media_player} not found",
                    alert_kind="webhook",
                )
                return
        
        message = build_webhook_message(name, weather_data, config)
        _LOGGER.debug("Built TTS message: %s", message[:100] if message else "empty")
        
        await dispatch_tts(
            self.hass,
            media_players,
            tts_config,
            message,
            volume_override=volume,
            request_id=request_id,
            alert_kind="webhook",
            config=config, type_id="scheduled_forecast",
        )
        _LOGGER.info("Webhook forecast TTS sent for %s to %s", name or "unnamed user", target_media_player or "all players")

    async def _setup_tropical_alerts_trigger(self, config: dict[str, Any]) -> None:
        """Poll hurricane data every 5 minutes for tropical TTS alerts."""
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("Tropical alerts enabled but no media players with TTS configured")
            return

        @callback
        def _poll(now: datetime) -> None:
            self.hass.async_create_task(self._check_tropical_alerts_async())

        unsub = async_track_time_interval(self.hass, _poll, timedelta(minutes=5))
        self._unsub_callbacks.append(unsub)
        await self._check_tropical_alerts_async()
        _LOGGER.info("Tropical alerts trigger set up (polling every 5 min)")

    async def _check_tropical_alerts_async(self) -> None:
        """Fetch hurricane data and announce tropical changes."""
        from .hurricane_data import (
            async_get_hurricane_data,
            build_tropical_tts_snapshot,
            detect_tropical_tts_events,
        )

        config = self._get_config()
        tropical = config.get("tropical_alerts") or {}
        media_players = media_players_with_tts(config.get("media_players", []))
        if not tropical.get("enabled") or not media_players:
            return

        try:
            payload = await async_get_hurricane_data(self.hass, config, force_refresh=True)
        except Exception as err:
            _LOGGER.warning("Tropical alerts fetch failed: %s", err)
            return

        # Thresholds (min threat, distance, outlook probability) and the alert
        # scope live in hurricane_monitoring (Alert Zones). The tropical_alerts
        # block only carries the announce toggles.
        monitoring = config.get("hurricane_monitoring") or {}
        alert_mode = str(
            monitoring.get("alert_zone_mode", monitoring.get("zone_mode", "zone"))
        ).lower()
        effective_tropical = dict(tropical)
        if alert_mode == "all":
            effective_tropical["min_threat_level"] = "none"
            effective_tropical["max_distance_miles"] = float("inf")
            effective_tropical["outlook_min_probability"] = 0
        else:
            effective_tropical["min_threat_level"] = monitoring.get("min_threat_level", "monitor")
            effective_tropical["max_distance_miles"] = float(monitoring.get("max_distance_miles", 500))
            effective_tropical["outlook_min_probability"] = int(monitoring.get("outlook_min_probability", 40))

        bootstrap = not self._tropical_bootstrapped
        events = detect_tropical_tts_events(
            self._tropical_snapshot,
            payload,
            effective_tropical,
            bootstrap=bootstrap,
        )
        self._tropical_snapshot = build_tropical_tts_snapshot(payload)
        if bootstrap:
            self._tropical_bootstrapped = True
            _LOGGER.debug("Tropical alerts bootstrap complete")
            return

        for _kind, context in events:
            msg = format_tropical_alert_for_tts(context)
            await play_hazard_alert_notification(
                self.hass, config, "tropical_alerts", msg, media_players,
                alert_kind="tropical_alert",
            )
            _LOGGER.info("Tropical alert fired: %s", context.get("event_kind"))

    async def _setup_tornado_alerts_trigger(self, config: dict[str, Any]) -> None:
        """Listen for tornado coordinator bus events."""
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("Tornado alerts enabled but no media players with TTS configured")
            return

        @callback
        def _on_issued(event: Event) -> None:
            self.hass.async_create_task(
                self._handle_tornado_bus_event(event, cleared=False)
            )

        @callback
        def _on_cleared(event: Event) -> None:
            self.hass.async_create_task(
                self._handle_tornado_bus_event(event, cleared=True)
            )

        self._unsub_callbacks.append(
            self.hass.bus.async_listen("home_weather_tornado_warning_issued", _on_issued)
        )
        self._unsub_callbacks.append(
            self.hass.bus.async_listen("home_weather_tornado_warning_cleared", _on_cleared)
        )
        _LOGGER.info("Tornado alerts trigger set up (bus listeners)")

    async def _handle_tornado_bus_event(
        self,
        event: Event,
        *,
        cleared: bool,
    ) -> None:
        config = self._get_config()
        tornado = config.get("tornado_alerts") or {}
        if not tornado.get("enabled"):
            return
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            return
        payload = dict(event.data or {})
        monitoring = config.get("tornado_monitoring") or {}
        if not passes_tornado_tts_filter(payload, tornado, monitoring, cleared=cleared):
            return
        msg = format_tornado_warning_for_tts(payload, cleared=cleared)
        await play_hazard_alert_notification(
            self.hass, config, "tornado_alerts", msg, media_players,
            alert_kind="tornado_alert",
        )
        _LOGGER.info("Tornado alert TTS fired (cleared=%s)", cleared)

    async def _setup_earthquake_alerts_trigger(self, config: dict[str, Any]) -> None:
        """Listen for earthquake coordinator bus events."""
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("Earthquake alerts enabled but no media players with TTS configured")
            return

        for event_type in (
            "home_weather_earthquake_detected",
            "home_weather_earthquake_updated",
            "home_weather_earthquake_cleared",
        ):
            def _make_listener(et: str) -> Callable[[Event], None]:
                @callback
                def _on_event(ev: Event) -> None:
                    self.hass.async_create_task(
                        self._handle_earthquake_bus_event(ev, et)
                    )
                return _on_event

            self._unsub_callbacks.append(
                self.hass.bus.async_listen(event_type, _make_listener(event_type))
            )
        _LOGGER.info("Earthquake alerts trigger set up (bus listeners)")

    async def _handle_earthquake_bus_event(
        self,
        event: Event,
        event_type: str,
    ) -> None:
        config = self._get_config()
        eq_cfg = config.get("earthquake_alerts") or {}
        if not eq_cfg.get("enabled"):
            return
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            return
        payload = dict(event.data or {})
        monitoring = config.get("earthquake_monitoring") or {}
        if not passes_earthquake_tts_filter(payload, eq_cfg, event_type, monitoring):
            return
        cleared = event_type == "home_weather_earthquake_cleared"
        updated = event_type == "home_weather_earthquake_updated"
        msg = format_earthquake_alert_for_tts(payload, cleared=cleared, updated=updated)
        await play_hazard_alert_notification(
            self.hass, config, "earthquake_alerts", msg, media_players,
            alert_kind="earthquake_alert",
        )
        _LOGGER.info("Earthquake alert TTS fired: %s", event_type)

    async def _setup_volcano_alerts_trigger(self, config: dict[str, Any]) -> None:
        """Listen for volcano coordinator bus events."""
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("Volcano alerts enabled but no media players with TTS configured")
            return

        for event_type in (
            "home_weather_volcano_activity_detected",
            "home_weather_volcano_activity_updated",
            "home_weather_volcano_activity_cleared",
        ):
            def _make_listener(et: str) -> Callable[[Event], None]:
                @callback
                def _on_event(ev: Event) -> None:
                    self.hass.async_create_task(
                        self._handle_volcano_bus_event(ev, et)
                    )
                return _on_event

            self._unsub_callbacks.append(
                self.hass.bus.async_listen(event_type, _make_listener(event_type))
            )
        _LOGGER.info("Volcano alerts trigger set up (bus listeners)")

    async def _handle_volcano_bus_event(
        self,
        event: Event,
        event_type: str,
    ) -> None:
        config = self._get_config()
        volcano_cfg = config.get("volcano_alerts") or {}
        if not volcano_cfg.get("enabled"):
            return
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            return
        payload = dict(event.data or {})
        monitoring = config.get("volcano_monitoring") or {}
        if not passes_volcano_tts_filter(payload, volcano_cfg, event_type, monitoring):
            return
        cleared = event_type == "home_weather_volcano_activity_cleared"
        updated = event_type == "home_weather_volcano_activity_updated"
        msg = format_volcano_alert_for_tts(payload, cleared=cleared, updated=updated)
        await play_hazard_alert_notification(
            self.hass, config, "volcano_alerts", msg, media_players,
            alert_kind="volcano_alert",
        )
        _LOGGER.info("Volcano alert TTS fired: %s", event_type)

    async def _setup_wildfire_alerts_trigger(self, config: dict[str, Any]) -> None:
        """Listen for wildfire coordinator bus events."""
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("Wildfire alerts enabled but no media players with TTS configured")
            return

        for event_type in (
            "home_weather_wildfire_detected",
            "home_weather_wildfire_updated",
            "home_weather_wildfire_cleared",
        ):
            def _make_listener(et: str) -> Callable[[Event], None]:
                @callback
                def _on_event(ev: Event) -> None:
                    self.hass.async_create_task(
                        self._handle_wildfire_bus_event(ev, et)
                    )
                return _on_event

            self._unsub_callbacks.append(
                self.hass.bus.async_listen(event_type, _make_listener(event_type))
            )
        _LOGGER.info("Wildfire alerts trigger set up (bus listeners)")

    async def _handle_wildfire_bus_event(
        self,
        event: Event,
        event_type: str,
    ) -> None:
        config = self._get_config()
        wildfire_cfg = config.get("wildfire_alerts") or {}
        if not wildfire_cfg.get("enabled"):
            return
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            return
        payload = dict(event.data or {})
        monitoring = config.get("wildfire_monitoring") or {}
        if not passes_wildfire_tts_filter(payload, wildfire_cfg, event_type, monitoring):
            return
        cleared = event_type == "home_weather_wildfire_cleared"
        updated = event_type == "home_weather_wildfire_updated"
        msg = format_wildfire_alert_for_tts(payload, cleared=cleared, updated=updated)
        await play_hazard_alert_notification(
            self.hass, config, "wildfire_alerts", msg, media_players,
            alert_kind="wildfire_alert",
        )
        _LOGGER.info("Wildfire alert TTS fired: %s", event_type)

    async def _setup_air_quality_alerts_trigger(self, config: dict[str, Any]) -> None:
        """Listen for air quality coordinator bus events."""
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("Air quality alerts enabled but no media players with TTS configured")
            return

        for event_type in (
            "home_weather_air_quality_unhealthy",
            "home_weather_air_quality_updated",
            "home_weather_air_quality_cleared",
        ):
            def _make_listener(et: str) -> Callable[[Event], None]:
                @callback
                def _on_event(ev: Event) -> None:
                    self.hass.async_create_task(
                        self._handle_air_quality_bus_event(ev, et)
                    )
                return _on_event

            self._unsub_callbacks.append(
                self.hass.bus.async_listen(event_type, _make_listener(event_type))
            )
        _LOGGER.info("Air quality alerts trigger set up (bus listeners)")

    async def _handle_air_quality_bus_event(
        self,
        event: Event,
        event_type: str,
    ) -> None:
        config = self._get_config()
        air_quality_cfg = config.get("air_quality_alerts") or {}
        if not air_quality_cfg.get("enabled"):
            return
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            return
        payload = dict(event.data or {})
        monitoring = config.get("air_quality_monitoring") or {}
        if not passes_air_quality_tts_filter(
            payload, air_quality_cfg, event_type, monitoring
        ):
            return
        cleared = event_type == "home_weather_air_quality_cleared"
        updated = event_type == "home_weather_air_quality_updated"
        msg = format_air_quality_alert_for_tts(payload, cleared=cleared, updated=updated)
        await play_hazard_alert_notification(
            self.hass, config, "air_quality_alerts", msg, media_players,
            alert_kind="air_quality_alert",
        )
        _LOGGER.info("Air quality alert TTS fired: %s", event_type)

    async def _setup_travel_alerts_trigger(self, config: dict[str, Any]) -> None:
        """Listen for travel advisory coordinator bus events."""
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("Travel alerts enabled but no media players with TTS configured")
            return

        for event_type in (
            "home_weather_travel_advisory_new",
            "home_weather_travel_advisory_changed",
        ):
            def _make_listener(et: str) -> Callable[[Event], None]:
                @callback
                def _on_event(ev: Event) -> None:
                    self.hass.async_create_task(
                        self._handle_travel_bus_event(ev, et)
                    )
                return _on_event

            self._unsub_callbacks.append(
                self.hass.bus.async_listen(event_type, _make_listener(event_type))
            )
        _LOGGER.info("Travel alerts trigger set up (bus listeners)")

    async def _handle_travel_bus_event(
        self,
        event: Event,
        event_type: str,
    ) -> None:
        config = self._get_config()
        travel_cfg = config.get("travel_alerts") or {}
        if not travel_cfg.get("enabled"):
            return
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            return
        payload = dict(event.data or {})
        from .travel_advisory_data import passes_travel_alert_filter

        if not passes_travel_alert_filter(payload, travel_cfg):
            return
        changed = event_type == "home_weather_travel_advisory_changed"
        msg = format_travel_advisory_for_tts(payload, changed=changed)
        await play_hazard_alert_notification(
            self.hass, config, "travel_alerts", msg, media_players,
            alert_kind="travel_alert",
        )
        _LOGGER.info("Travel alert TTS fired: %s", event_type)

    async def _setup_spacecraft_alerts_trigger(self, config: dict[str, Any]) -> None:
        """Listen for spacecraft overhead bus events."""
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("Spacecraft alerts enabled but no media players with TTS configured")
            return

        for event_type in (
            "home_weather_spacecraft_overhead",
            "home_weather_spacecraft_overhead_updated",
            "home_weather_spacecraft_overhead_cleared",
        ):
            def _make_listener(et: str) -> Callable[[Event], None]:
                @callback
                def _on_event(ev: Event) -> None:
                    self.hass.async_create_task(
                        self._handle_spacecraft_bus_event(ev, et)
                    )
                return _on_event

            self._unsub_callbacks.append(
                self.hass.bus.async_listen(event_type, _make_listener(event_type))
            )
        _LOGGER.info("Spacecraft alerts trigger set up (bus listeners)")

    async def _handle_spacecraft_bus_event(
        self,
        event: Event,
        event_type: str,
    ) -> None:
        config = self._get_config()
        spacecraft_cfg = config.get("spacecraft_alerts") or {}
        if not spacecraft_cfg.get("enabled"):
            return
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            return
        payload = dict(event.data or {})
        if not passes_spacecraft_tts_filter(payload, spacecraft_cfg, event_type):
            return
        msg = format_spacecraft_alert_for_tts(payload)
        await play_hazard_alert_notification(
            self.hass, config, "spacecraft_alerts", msg, media_players,
            alert_kind="spacecraft_alert",
        )
        _LOGGER.info("Spacecraft alert TTS fired: %s", event_type)

    async def _setup_solar_weather_alerts_trigger(self, config: dict[str, Any]) -> None:
        """Listen for solar weather bus events."""
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("Solar weather alerts enabled but no media players with TTS configured")
            return

        for event_type in (
            "home_weather_solar_storm",
            "home_weather_solar_storm_updated",
            "home_weather_solar_storm_cleared",
            "home_weather_solar_flare",
            "home_weather_solar_flare_updated",
        ):
            def _make_listener(et: str) -> Callable[[Event], None]:
                @callback
                def _on_event(ev: Event) -> None:
                    self.hass.async_create_task(
                        self._handle_solar_weather_bus_event(ev, et)
                    )
                return _on_event

            self._unsub_callbacks.append(
                self.hass.bus.async_listen(event_type, _make_listener(event_type))
            )
        _LOGGER.info("Solar weather alerts trigger set up (bus listeners)")

    async def _handle_solar_weather_bus_event(
        self,
        event: Event,
        event_type: str,
    ) -> None:
        config = self._get_config()
        solar_cfg = config.get("solar_weather_alerts") or {}
        if not solar_cfg.get("enabled"):
            return
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            return
        payload = dict(event.data or {})
        if not passes_solar_weather_tts_filter(payload, solar_cfg, event_type):
            return
        msg = format_solar_weather_alert_for_tts(payload)
        await play_hazard_alert_notification(
            self.hass, config, "solar_weather_alerts", msg, media_players,
            alert_kind="solar_weather_alert",
        )
        _LOGGER.info("Solar weather alert TTS fired: %s", event_type)

    async def _setup_neo_alerts_trigger(self, config: dict[str, Any]) -> None:
        """Listen for NEO close approach bus events."""
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("NEO alerts enabled but no media players with TTS configured")
            return

        for event_type in (
            "home_weather_neo_close_approach",
            "home_weather_neo_close_approach_updated",
        ):
            def _make_listener(et: str) -> Callable[[Event], None]:
                @callback
                def _on_event(ev: Event) -> None:
                    self.hass.async_create_task(
                        self._handle_neo_bus_event(ev, et)
                    )
                return _on_event

            self._unsub_callbacks.append(
                self.hass.bus.async_listen(event_type, _make_listener(event_type))
            )
        _LOGGER.info("NEO alerts trigger set up (bus listeners)")

    async def _handle_neo_bus_event(
        self,
        event: Event,
        event_type: str,
    ) -> None:
        config = self._get_config()
        neo_cfg = config.get("neo_alerts") or {}
        if not neo_cfg.get("enabled"):
            return
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            return
        payload = dict(event.data or {})
        if not passes_neo_tts_filter(payload, neo_cfg, event_type):
            return
        msg = format_neo_alert_for_tts(payload)
        await play_hazard_alert_notification(
            self.hass, config, "neo_alerts", msg, media_players,
            alert_kind="neo_alert",
        )
        _LOGGER.info("NEO alert TTS fired: %s", event_type)
