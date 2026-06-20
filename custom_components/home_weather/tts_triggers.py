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
    async_track_time_change,
    async_track_time_interval,
    async_track_state_change_event,
)
from homeassistant.util import dt as dt_util

from .const import DOMAIN, WEBHOOK_LAST_TRIGGERED_KEY
from .tts_notifications import (
    build_scheduled_forecast,
    build_current_change_message,
    build_upcoming_change_message,
    build_webhook_message,
    build_sunrise_upcoming_message,
    build_sunrise_final_message,
    build_sunset_upcoming_message,
    build_sunset_final_message,
    send_tts,
    send_tts_with_ai_rewrite,
    play_nws_alert_notification,
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
    return False


def extract_weather_condition(state: Any) -> str:
    """Read the weather condition from a state object."""
    if not state:
        return ""
    condition = state.attributes.get("condition") if state.attributes else None
    if condition:
        return str(condition)
    return str(state.state or "")


def compute_trigger_hours(start_h: int, end_h: int, hour_pattern: int) -> list[int]:
    """Compute clock hours for time-based forecasts anchored to start_h."""
    hour_pattern = int(hour_pattern)
    start_h = int(start_h)
    end_h = int(end_h)
    if hour_pattern <= 0 or start_h > end_h:
        return []
    hours: list[int] = []
    hour = start_h
    while hour <= end_h:
        hours.append(hour)
        hour += hour_pattern
    return hours


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


def media_players_with_tts(media_players: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return media players that have both entity and TTS entity configured."""
    return [
        mp
        for mp in media_players
        if mp.get("entity_id") and mp.get("tts_entity_id")
    ]


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
        
        _LOGGER.info("TTS triggers unloaded")

    async def _resolve_weather_data(self, *, refresh: bool = True) -> dict[str, Any]:
        """Refresh and return the best available weather data for TTS."""
        if refresh and self._refresh_weather_data:
            try:
                await asyncio.wait_for(self._refresh_weather_data(), timeout=15.0)
            except asyncio.TimeoutError:
                _LOGGER.warning("Weather refresh timed out before TTS, using cached data")
            except Exception as err:
                _LOGGER.warning("Weather refresh failed before TTS: %s", err)

        weather_data = self._get_weather_data() or {}
        if weather_data.get("configured") is not False:
            return weather_data

        weather_entity = self._get_config().get("weather_entity")
        if not weather_entity:
            return weather_data

        fallback = build_weather_data_from_state(self.hass, weather_entity)
        if fallback.get("configured"):
            _LOGGER.debug("Using live weather entity state for TTS fallback")
            return fallback
        return weather_data

    async def _setup_time_based_trigger(self, tts_config: dict[str, Any]) -> None:
        """Set up time-based forecast triggers.
        
        Triggers at regular intervals (hour_pattern) with minute offset,
        filtered by start/end time and days of week.
        """
        hour_pattern = int(tts_config.get("hour_pattern", 3))
        minute_offset = int(tts_config.get("minute_offset", 3))
        start_time = tts_config.get("start_time", "08:00")
        end_time = tts_config.get("end_time", "21:00")
        days_of_week = tts_config.get("days_of_week", [])
        
        # Parse start/end times
        try:
            start_h, start_m = map(int, start_time.split(":"))
            end_h, end_m = map(int, end_time.split(":"))
        except:
            start_h, start_m = 8, 0
            end_h, end_m = 21, 0
        
        # Day abbreviations to weekday numbers
        day_map = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}
        allowed_days = {day_map.get(d.lower()[:3], -1) for d in days_of_week}
        allowed_days.discard(-1)
        if not allowed_days:
            allowed_days = set(range(7))  # Default to all days
        
        trigger_hours = compute_trigger_hours(start_h, end_h, hour_pattern)
        
        @callback
        def _check_and_fire(now: datetime) -> None:
            """Check if conditions are met and fire forecast."""
            # Check day of week
            if now.weekday() not in allowed_days:
                return
            
            # Check time window
            current_minutes = now.hour * 60 + now.minute
            start_minutes = start_h * 60 + start_m
            end_minutes = end_h * 60 + end_m
            
            if not (start_minutes <= current_minutes <= end_minutes):
                return
            
            # Check if this hour matches pattern
            if now.hour not in trigger_hours:
                return
            
            # Fire scheduled forecast
            self.hass.async_create_task(self._fire_scheduled_forecast())
        
        # Register time change listener for the minute offset
        unsub = async_track_time_change(
            self.hass,
            _check_and_fire,
            minute=minute_offset,
            second=0,
        )
        self._unsub_callbacks.append(unsub)
        _LOGGER.info(
            "Time-based trigger set up: hours=%s at minute %d, window %s-%s",
            trigger_hours,
            minute_offset,
            start_time,
            end_time,
        )

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

    async def fire_test_scheduled_forecast(self) -> None:
        """Play a scheduled forecast on all configured media players."""
        await self._fire_scheduled_forecast(refresh_weather=False)

    async def fire_test_current_change(self) -> None:
        """Play a sample current-change alert on all configured media players."""
        weather_data = await self._resolve_weather_data(refresh=False)
        current = weather_data.get("current") or {}
        new_condition = current.get("condition") or current.get("state") or "changing conditions"
        await self._fire_current_change(
            "previous conditions",
            new_condition,
            refresh_weather=False,
        )

    async def fire_test_upcoming_change(self) -> None:
        """Play a sample upcoming-precipitation alert."""
        config = self._get_config()
        tts_config = config.get("tts") or {}
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("No media players with TTS configured for upcoming-change test")
            return

        weather_data = await self._resolve_weather_data(refresh=False)
        hourly = (weather_data or {}).get("hourly_forecast") or []
        threshold = int(tts_config.get("precip_threshold", 30))
        minutes_until = 30
        precip_kind = "rain"
        probability = max(threshold, 60)

        now = dt_util.now()
        for h in hourly:
            try:
                h_time_val = h.get("datetime")
                if isinstance(h_time_val, str):
                    h_time = dt_util.parse_datetime(h_time_val.replace("Z", "+00:00"))
                else:
                    h_time = h_time_val
                if h_time and h_time.tzinfo is None:
                    h_time = dt_util.as_local(h_time)
                if not h_time or h_time <= now:
                    continue
                prob = int(h.get("precipitation_probability", 0) or 0)
                if prob <= 0:
                    continue
                minutes_until = max(1, int((h_time - now).total_seconds() / 60))
                probability = prob
                precip_kind = h.get("precipitation_kind") or h.get("condition") or precip_kind
                break
            except Exception:
                continue

        message = build_upcoming_change_message(precip_kind, minutes_until, probability)
        await send_tts_with_ai_rewrite(self.hass, media_players, tts_config, message)
        _LOGGER.info("Test upcoming-change TTS dispatched")

    async def fire_test_sensor_triggered(self) -> None:
        """Trigger a sensor forecast on the first configured sensor target."""
        config = self._get_config()
        sensor_triggers = (config.get("tts") or {}).get("sensor_triggers") or []
        target = ""
        for trig in sensor_triggers:
            if trig.get("entity_id"):
                target = trig.get("media_player", "") or ""
                break
        await self._fire_scheduled_forecast(target_media_player=target, refresh_weather=False)

    async def fire_test_webhook(self) -> None:
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
        await self._fire_webhook_forecast(name, None, target_media_player=target)

    async def fire_test_sunrise(self) -> None:
        """Speak the sunrise upcoming announcement on all media players."""
        config = self._get_config()
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("No media players with TTS configured for sunrise test")
            return
        mins = int(((config.get("sun_alerts") or {}).get("sunrise_tts") or {}).get("minutes_before", 15))
        msg = build_sunrise_upcoming_message(mins)
        await send_tts(self.hass, media_players, msg)
        _LOGGER.info("Test sunrise TTS dispatched")

    async def fire_test_sunset(self) -> None:
        """Speak the sunset upcoming announcement on all media players."""
        config = self._get_config()
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("No media players with TTS configured for sunset test")
            return
        mins = int(((config.get("sun_alerts") or {}).get("sunset_tts") or {}).get("minutes_before", 15))
        msg = build_sunset_upcoming_message(mins)
        await send_tts(self.hass, media_players, msg)
        _LOGGER.info("Test sunset TTS dispatched")

    async def fire_test_nws_alert(self) -> None:
        """Play the configured NWS siren/TTS using a fake alert payload."""
        config = self._get_config()
        media_players = media_players_with_tts(config.get("media_players", []))
        if not media_players:
            _LOGGER.warning("No media players with TTS configured for NWS test")
            return
        sample = {
            "event": "Test Alert",
            "description": (
                "This is a Home Weather test alert. No active warnings are in effect."
            ),
        }
        await play_nws_alert_notification(self.hass, config, sample, media_players)
        _LOGGER.info("Test NWS alert dispatched")

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
            self.hass.async_create_task(self._check_sun_alerts_async(config))

        unsub = async_track_time_interval(
            self.hass,
            _check_sun_alerts,
            timedelta(minutes=1),
        )
        self._unsub_callbacks.append(unsub)
        _LOGGER.debug("Sun alerts trigger set up (check every 60s)")

    async def _check_sun_alerts_async(self, config: dict[str, Any]) -> None:
        """Check sunrise/sunset and fire TTS/automation as needed."""
        sun_alerts = config.get("sun_alerts", {})
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
                    await send_tts(self.hass, media_players, msg)
                    _LOGGER.info("Sunrise final TTS sent")
            elif window_start <= now < next_rising:
                mins_until = int((next_rising - now).total_seconds() / 60)
                last = self._sun_alerts_last_upcoming.get(event_key_up)
                if last is None or (now - last).total_seconds() >= interval * 60:
                    self._sun_alerts_last_upcoming[event_key_up] = now
                    msg = build_sunrise_upcoming_message(mins_until)
                    await send_tts(self.hass, media_players, msg)
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
                    await send_tts(self.hass, media_players, msg)
                    _LOGGER.info("Sunset final TTS sent")
            elif window_start <= now < next_setting:
                mins_until = int((next_setting - now).total_seconds() / 60)
                last = self._sun_alerts_last_upcoming.get(event_key_up)
                if last is None or (now - last).total_seconds() >= interval * 60:
                    self._sun_alerts_last_upcoming[event_key_up] = now
                    msg = build_sunset_upcoming_message(mins_until)
                    await send_tts(self.hass, media_players, msg)
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

        def _poll(now: datetime) -> None:
            self.hass.async_create_task(self._check_nws_alerts_async(config))

        unsub = async_track_time_interval(self.hass, _poll, timedelta(minutes=5))
        self._unsub_callbacks.append(unsub)
        await self._check_nws_alerts_async(config)
        _LOGGER.info("NWS alerts trigger set up (polling every 5 min)")

    async def _check_nws_alerts_async(self, config: dict[str, Any]) -> None:
        """Fetch NWS alerts and fire notification for newly seen active alerts."""
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
            if aid not in known:
                known.add(aid)
                await play_nws_alert_notification(
                    self.hass,
                    config,
                    props,
                    media_players,
                )
                _LOGGER.info("NWS alert fired: %s", props.get("event", aid))

        self._nws_known_alert_ids = {x for x in known if x in active_ids}

    async def _fire_scheduled_forecast(
        self,
        target_media_player: str = "",
        *,
        refresh_weather: bool = True,
    ) -> None:
        """Fire a scheduled forecast TTS.
        
        Args:
            target_media_player: If specified, only send to this media player.
                               If empty, send to all configured media players.
            refresh_weather: Whether to refresh coordinator data before building message.
        """
        config = self._get_config()
        weather_data = await self._resolve_weather_data(refresh=refresh_weather)
        tts_config = config.get("tts", {})
        media_players = media_players_with_tts(config.get("media_players", []))

        if not media_players:
            _LOGGER.warning("No media players with TTS configured, skipping scheduled TTS")
            return

        if not weather_data:
            _LOGGER.warning("Weather data unavailable, skipping scheduled TTS")
            return

        # Filter to specific media player if specified
        if target_media_player:
            media_players = [mp for mp in media_players if mp.get("entity_id") == target_media_player]
            if not media_players:
                _LOGGER.warning("Target media player %s not found in config", target_media_player)
                return
        
        message = build_scheduled_forecast(weather_data, config)
        _LOGGER.debug(
            "Scheduled forecast TTS: len=%d, preview=%s",
            len(message),
            (message[:100] + "...") if len(message) > 100 else message,
        )
        await send_tts_with_ai_rewrite(
            self.hass,
            media_players,
            tts_config,
            message,
        )
        _LOGGER.info("Scheduled forecast TTS sent to %s", target_media_player or "all players")

    async def _fire_current_change(
        self,
        old_condition: str,
        new_condition: str,
        *,
        refresh_weather: bool = True,
    ) -> None:
        """Fire a current change alert TTS."""
        config = self._get_config()
        weather_data = await self._resolve_weather_data(refresh=refresh_weather)
        tts_config = config.get("tts", {})
        media_players = media_players_with_tts(config.get("media_players", []))
        volume = None  # Volume controlled per media player

        if not media_players:
            _LOGGER.warning("No media players with TTS configured, skipping current change TTS")
            return
        
        if not weather_data:
            _LOGGER.warning("Weather data unavailable, skipping current change TTS")
            return
        
        message = build_current_change_message(old_condition, new_condition, weather_data)
        await send_tts_with_ai_rewrite(
            self.hass,
            media_players,
            tts_config,
            message,
            volume_override=volume,
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

        if not weather_data:
            return
        
        hourly = weather_data.get("hourly_forecast", [])
        current = weather_data.get("current") or {}
        
        # Don't alert if it's already precipitating
        current_condition = (current.get("condition") or current.get("state", "")).lower()
        if any(p in current_condition for p in ["rain", "snow", "sleet", "drizzle", "thunder"]):
            return
        
        now = dt_util.now()
        alert_window = now + timedelta(minutes=minutes_before)
        
        for h in hourly:
            precip_prob = h.get("precipitation_probability", 0) or 0
            if precip_prob < threshold:
                continue
            
            h_time_val = h.get("datetime")
            if not h_time_val:
                continue
            
            h_time = dt_util.parse_datetime(str(h_time_val).replace("Z", "+00:00")) if isinstance(h_time_val, str) else h_time_val
            if h_time is None:
                continue
            # Ensure timezone-aware for comparison with now/alert_window
            if h_time.tzinfo is None:
                h_time = dt_util.as_local(h_time)
            
            # Check if within alert window
            if now < h_time <= alert_window:
                # Create unique key for this alert
                alert_key = h_time.strftime("%Y-%m-%d-%H")
                if alert_key in self._upcoming_alert_fired:
                    continue
                
                self._upcoming_alert_fired.add(alert_key)
                
                # Calculate minutes until
                minutes_until = int((h_time - now).total_seconds() / 60)
                precip_kind = h.get("precipitation_kind") or h.get("condition", "precipitation")
                
                volume = None  # Volume controlled per media player
                message = build_upcoming_change_message(precip_kind, minutes_until, precip_prob)
                
                await send_tts_with_ai_rewrite(
                    self.hass,
                    media_players,
                    tts_config,
                    message,
                    volume_override=volume,
                )
                _LOGGER.info("Upcoming precip TTS sent: %s in %d minutes", precip_kind, minutes_until)
                break  # Only alert for the first upcoming precip
        
        # Clean up old alerts (older than 2 hours); use string comparison to avoid naive/aware datetime mismatch
        cutoff_key = (now - timedelta(hours=2)).strftime("%Y-%m-%d-%H")
        self._upcoming_alert_fired = {k for k in self._upcoming_alert_fired if k > cutoff_key}

    async def _fire_webhook_forecast(self, name: str, volume: float | None, target_media_player: str = "") -> None:
        """Fire a webhook-triggered forecast.
        
        Args:
            name: Personal name for greeting
            volume: Optional volume override
            target_media_player: If specified, only send to this media player.
                               If empty, send to all configured media players.
        """
        _LOGGER.info("_fire_webhook_forecast called with name=%s, volume=%s, target=%s", name, volume, target_media_player)
        
        config = self._get_config()
        weather_data = await self._resolve_weather_data(refresh=True)
        tts_config = config.get("tts", {})
        media_players = media_players_with_tts(config.get("media_players", []))
        
        _LOGGER.debug("Config has %d media players with TTS configured", len(media_players))
        
        if not media_players:
            _LOGGER.warning("No media players configured, cannot send TTS")
            return
        
        if not weather_data:
            _LOGGER.warning("Weather data unavailable, skipping webhook TTS")
            return
        
        # Filter to specific media player if specified
        if target_media_player:
            media_players = [mp for mp in media_players if mp.get("entity_id") == target_media_player]
            if not media_players:
                _LOGGER.warning("Target media player %s not found in config", target_media_player)
                return
        
        message = build_webhook_message(name, weather_data, config)
        _LOGGER.debug("Built TTS message: %s", message[:100] if message else "empty")
        
        await send_tts_with_ai_rewrite(
            self.hass,
            media_players,
            tts_config,
            message,
            volume_override=volume,
        )
        _LOGGER.info("Webhook forecast TTS sent for %s to %s", name or "unnamed user", target_media_player or "all players")
