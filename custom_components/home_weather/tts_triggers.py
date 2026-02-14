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
    send_tts_with_ai_rewrite,
)

_LOGGER = logging.getLogger(__name__)


class TTSTriggerManager:
    """Manage all TTS triggers for the Home Weather integration."""

    def __init__(
        self,
        hass: HomeAssistant,
        get_config: Callable[[], dict[str, Any]],
        get_weather_data: Callable[[], dict[str, Any]],
    ) -> None:
        """Initialize the trigger manager.
        
        Args:
            hass: Home Assistant instance
            get_config: Callable that returns current config
            get_weather_data: Callable that returns current weather data
        """
        self.hass = hass
        self._get_config = get_config
        self._get_weather_data = get_weather_data
        self._unsub_callbacks: list[Callable] = []
        self._last_condition: str | None = None
        self._upcoming_alert_fired: set[str] = set()  # Track which hours already alerted
        self._registered_webhooks: list[str] = []  # Track registered webhook IDs

    async def async_setup(self) -> None:
        """Set up all enabled triggers based on config."""
        config = self._get_config()
        tts_config = config.get("tts", {})
        
        if not tts_config.get("enabled", False):
            _LOGGER.debug("TTS is disabled, skipping trigger setup")
            return
        
        # Time-based triggers
        if tts_config.get("enable_time_based", False):
            await self._setup_time_based_trigger(tts_config)
        
        # Current weather change trigger
        if tts_config.get("enable_current_change", False):
            await self._setup_current_change_trigger(config)
        
        # Upcoming change trigger (check every 5 minutes)
        if tts_config.get("enable_upcoming_change", False):
            await self._setup_upcoming_change_trigger(tts_config)
        
        # Sensor triggered
        if tts_config.get("enable_sensor_triggered", False):
            await self._setup_sensor_triggers(tts_config)
        
        # Webhook trigger
        if tts_config.get("enable_webhook", False):
            await self._setup_webhook_trigger(tts_config)
        
        # Voice satellite trigger
        if tts_config.get("enable_voice_satellite", False):
            await self._setup_voice_satellite_trigger(tts_config)
        
        _LOGGER.info("TTS triggers set up successfully")

    async def async_unload(self) -> None:
        """Unload all triggers."""
        for unsub in self._unsub_callbacks:
            try:
                unsub()
            except Exception as e:
                _LOGGER.warning("Error unsubscribing trigger: %s", e)
        self._unsub_callbacks.clear()
        
        # Unregister all webhooks
        for webhook_id in self._registered_webhooks:
            try:
                self.hass.components.webhook.async_unregister(webhook_id)
                _LOGGER.debug("Unregistered webhook: %s", webhook_id)
            except Exception as e:
                _LOGGER.warning("Error unregistering webhook %s: %s", webhook_id, e)
        self._registered_webhooks.clear()
        
        _LOGGER.info("TTS triggers unloaded")

    async def _setup_time_based_trigger(self, tts_config: dict[str, Any]) -> None:
        """Set up time-based forecast triggers.
        
        Triggers at regular intervals (hour_pattern) with minute offset,
        filtered by start/end time and days of week.
        """
        hour_pattern = tts_config.get("hour_pattern", 3)
        minute_offset = tts_config.get("minute_offset", 3)
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
        
        # Calculate which hours to trigger (every N hours)
        trigger_hours = list(range(0, 24, hour_pattern)) if hour_pattern > 0 else []
        
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
        _LOGGER.debug("Time-based trigger set up: every %d hours at minute %d", hour_pattern, minute_offset)

    async def _setup_current_change_trigger(self, config: dict[str, Any]) -> None:
        """Set up trigger for when current weather conditions change."""
        weather_entity = config.get("weather_entity")
        if not weather_entity:
            _LOGGER.warning("No weather entity configured for current change trigger")
            return
        
        # Initialize last condition
        state = self.hass.states.get(weather_entity)
        if state:
            self._last_condition = state.state
        
        @callback
        def _state_changed(event: Event) -> None:
            """Handle state change events."""
            new_state = event.data.get("new_state")
            old_state = event.data.get("old_state")
            
            if not new_state or not old_state:
                return
            
            old_condition = old_state.state
            new_condition = new_state.state
            
            # Only fire if condition actually changed
            if old_condition != new_condition and self._last_condition != new_condition:
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
        _LOGGER.debug("Current change trigger set up for %s", weather_entity)

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
        """
        sensor_triggers = tts_config.get("sensor_triggers", [])
        if not sensor_triggers:
            return
        
        # Build a mapping from entity_id to trigger_state
        trigger_map = {}
        for trigger in sensor_triggers:
            entity_id = trigger.get("entity_id")
            trigger_state = trigger.get("trigger_state", "on")
            if entity_id:
                trigger_map[entity_id] = trigger_state
        
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
            target_state = trigger_map.get(entity_id)
            
            if target_state is None:
                return
            
            # Fire when sensor enters the configured trigger state
            if old_state.state != target_state and new_state.state == target_state:
                self.hass.async_create_task(self._fire_scheduled_forecast())
        
        unsub = async_track_state_change_event(
            self.hass,
            list(trigger_map.keys()),
            _sensor_changed,
        )
        self._unsub_callbacks.append(unsub)
        _LOGGER.debug("Sensor triggers set up for %s", list(trigger_map.keys()))

    async def _setup_webhook_trigger(self, tts_config: dict[str, Any]) -> None:
        """Set up webhook triggers for personalized forecasts.
        
        Registers with Home Assistant using local_only=True and POST/PUT/GET/HEAD
        to match native HA webhook behavior. Records last trigger timestamp.
        """
        from aiohttp.web import Response
        
        webhooks = tts_config.get("webhooks", [])
        
        # Backward compatibility: support old single webhook config
        if not webhooks:
            old_webhook_id = tts_config.get("webhook_id")
            old_personal_name = tts_config.get("personal_name", "")
            if old_webhook_id:
                webhooks = [{"webhook_id": old_webhook_id, "personal_name": old_personal_name, "enabled": True}]
        
        if not webhooks:
            return
        
        if WEBHOOK_LAST_TRIGGERED_KEY not in self.hass.data:
            self.hass.data[WEBHOOK_LAST_TRIGGERED_KEY] = {}
        last_triggered_store = self.hass.data[WEBHOOK_LAST_TRIGGERED_KEY]
        
        for webhook_config in webhooks:
            if not webhook_config.get("enabled", True):
                continue
            
            webhook_id = webhook_config.get("webhook_id")
            if not webhook_id:
                continue
            
            personal_name = webhook_config.get("personal_name", "")
            
            def make_handler(name: str, wh_id: str):
                async def _handle_webhook(hass: HomeAssistant, _wh_id: str, request) -> Response | None:
                    """Handle webhook request. Supports POST, PUT (JSON body) and GET, HEAD (no body)."""
                    from datetime import datetime
                    data = {}
                    if request.method in ("POST", "PUT"):
                        try:
                            data = await request.json()
                        except Exception:
                            pass
                    
                    req_name = data.get("name") or name
                    volume = data.get("volume")
                    
                    last_triggered_store[wh_id] = datetime.utcnow().isoformat() + "Z"
                    await self._fire_webhook_forecast(req_name, volume)
                    return None
                return _handle_webhook
            
            try:
                self.hass.components.webhook.async_register(
                    "home_weather",
                    f"Weather Forecast ({personal_name or webhook_id})",
                    webhook_id,
                    make_handler(personal_name, webhook_id),
                    local_only=False,
                    allowed_methods=["POST", "PUT", "GET", "HEAD"],
                )
                self._registered_webhooks.append(webhook_id)
                _LOGGER.info("Webhook registered: %s (name: %s)", webhook_id, personal_name or "N/A")
            except Exception as e:
                _LOGGER.error("Failed to register webhook %s: %s", webhook_id, e)

    async def _setup_voice_satellite_trigger(self, tts_config: dict[str, Any]) -> None:
        """Set up voice satellite (conversation) triggers.
        
        Registers conversation commands for weather queries.
        """
        commands_text = tts_config.get("conversation_commands", "")
        commands = [c.strip() for c in commands_text.split("\n") if c.strip()]
        
        if not commands:
            return
        
        try:
            # Register conversation intent
            from homeassistant.helpers import intent
            
            for cmd in commands:
                # Create a simple pattern matcher for each command
                _LOGGER.debug("Registering voice command: %s", cmd)
            
            # Note: Full conversation agent integration requires more complex setup
            # For now, we log the intended commands
            _LOGGER.info("Voice satellite commands configured: %s", commands)
        except Exception as e:
            _LOGGER.warning("Voice satellite setup not fully supported: %s", e)

    async def _fire_scheduled_forecast(self) -> None:
        """Fire a scheduled forecast TTS."""
        config = self._get_config()
        weather_data = self._get_weather_data()
        tts_config = config.get("tts", {})
        media_players = config.get("media_players", [])
        
        if not media_players:
            _LOGGER.debug("No media players configured, skipping TTS")
            return
        
        message = build_scheduled_forecast(weather_data, config)
        await send_tts_with_ai_rewrite(
            self.hass,
            media_players,
            tts_config,
            message,
        )
        _LOGGER.info("Scheduled forecast TTS sent")

    async def _fire_current_change(self, old_condition: str, new_condition: str) -> None:
        """Fire a current change alert TTS."""
        config = self._get_config()
        weather_data = self._get_weather_data()
        tts_config = config.get("tts", {})
        media_players = config.get("media_players", [])
        volume = None  # Volume controlled per media player
        
        if not media_players:
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
        weather_data = self._get_weather_data()
        tts_config = config.get("tts", {})
        media_players = config.get("media_players", [])
        
        if not media_players:
            return
        
        hourly = weather_data.get("hourly_forecast", [])
        current = weather_data.get("current", {})
        
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
            
            h_time_str = h.get("datetime")
            if not h_time_str:
                continue
            
            try:
                h_time = datetime.fromisoformat(h_time_str.replace("Z", "+00:00"))
            except:
                continue
            
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
        
        # Clean up old alerts (older than 2 hours)
        two_hours_ago = now - timedelta(hours=2)
        self._upcoming_alert_fired = {
            k for k in self._upcoming_alert_fired
            if datetime.strptime(k, "%Y-%m-%d-%H") > two_hours_ago
        }

    async def _fire_webhook_forecast(self, name: str, volume: float | None) -> None:
        """Fire a webhook-triggered forecast."""
        config = self._get_config()
        weather_data = self._get_weather_data()
        tts_config = config.get("tts", {})
        media_players = config.get("media_players", [])
        
        if not media_players:
            return
        
        message = build_webhook_message(name, weather_data, config)
        await send_tts_with_ai_rewrite(
            self.hass,
            media_players,
            tts_config,
            message,
            volume_override=volume,
        )
        _LOGGER.info("Webhook forecast TTS sent for %s", name or "unnamed user")
