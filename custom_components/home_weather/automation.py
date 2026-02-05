"""Automation manager for Home Weather integration."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import event
from homeassistant.helpers.event import (
    async_track_state_change,
    async_track_time_interval,
)
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .coordinator import WeatherCoordinator
from .storage import HomeWeatherStorage

_LOGGER = logging.getLogger(__name__)


class HomeWeatherAutomation:
    """Manage automation triggers and TTS announcements."""

    def __init__(
        self,
        hass: HomeAssistant,
        storage: HomeWeatherStorage,
        coordinator: WeatherCoordinator,
    ) -> None:
        """Initialize automation manager."""
        self.hass = hass
        self.storage = storage
        self.coordinator = coordinator
        self._listeners: list[Any] = []
        self._scheduled_tasks: list[Any] = []
        self._last_announcement: dict[str, datetime] = {}
        self._is_running = False

    async def async_start(self) -> None:
        """Start automation manager."""
        if self._is_running:
            return

        self._is_running = True
        _LOGGER.info("Starting Home Weather automation")

        # Load configuration
        config = await self.storage.async_get()

        # Check if configured
        if not self.storage.is_configured():
            _LOGGER.info("Integration not configured, automation not started")
            return

        # Setup all triggers
        await self._setup_time_based_trigger(config)
        await self._setup_sensor_trigger(config)
        await self._setup_current_change_trigger(config)
        await self._setup_upcoming_change_trigger(config)
        await self._setup_webhook_trigger(config)
        await self._setup_voice_trigger(config)

    async def async_stop(self) -> None:
        """Stop automation manager."""
        if not self._is_running:
            return

        self._is_running = False
        _LOGGER.info("Stopping Home Weather automation")

        # Remove all listeners
        for listener in self._listeners:
            listener()
        self._listeners.clear()

        # Cancel scheduled tasks
        for task in self._scheduled_tasks:
            if not task.done():
                task.cancel()
        self._scheduled_tasks.clear()

    async def _setup_time_based_trigger(self, config: dict[str, Any]) -> None:
        """Setup time-based scheduled announcements."""
        if not config.get("enable_time_based"):
            return

        async def check_schedule(now: datetime) -> None:
            """Check if we should announce based on schedule."""
            try:
                current_config = await self.storage.async_get()
                if not current_config.get("enable_time_based"):
                    return

                hour_pattern = current_config.get("hour_pattern", "*/1")
                minute_offset = current_config.get("minute_offset", 0)
                start_time = current_config.get("start_time", "06:00:00")
                end_time = current_config.get("end_time", "22:00:00")
                days_of_week = current_config.get("days_of_week", [])

                # Parse times
                start_hour, start_min = map(int, start_time.split(":")[:2])
                end_hour, end_min = map(int, end_time.split(":")[:2])

                current_time = now.time()
                start = datetime.combine(now.date(), datetime.min.time().replace(hour=start_hour, minute=start_min)).time()
                end = datetime.combine(now.date(), datetime.min.time().replace(hour=end_hour, minute=end_min)).time()

                # Check time window
                if not (start <= current_time <= end):
                    return

                # Check day of week
                day_names = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
                current_day = day_names[now.weekday()]
                if current_day not in days_of_week:
                    return

                # Check hour pattern (simplified: every N hours)
                if hour_pattern.startswith("*/"):
                    interval = int(hour_pattern[2:])
                    if now.hour % interval != 0:
                        return

                # Check minute offset
                if now.minute != minute_offset:
                    return

                # Announce
                await self._announce_weather(current_config)

            except Exception as e:
                _LOGGER.error("Error in schedule check: %s", e)

        # Check every minute
        self._listeners.append(
            async_track_time_interval(self.hass, check_schedule, timedelta(minutes=1))
        )

    async def _setup_sensor_trigger(self, config: dict[str, Any]) -> None:
        """Setup sensor-based triggers."""
        if not config.get("enable_sensor_triggered"):
            return

        presence_sensors = config.get("presence_sensors", [])

        @callback
        async def sensor_state_changed(entity_id: str, old_state: Any, new_state: Any) -> None:
            """Handle sensor state change."""
            if new_state and new_state.state == "on":
                current_config = await self.storage.async_get()
                if current_config.get("enable_sensor_triggered"):
                    await self._announce_weather(current_config)

        for sensor in presence_sensors:
            self._listeners.append(
                async_track_state_change(self.hass, sensor, sensor_state_changed)
            )

    async def _setup_current_change_trigger(self, config: dict[str, Any]) -> None:
        """Setup current weather change trigger."""
        if not config.get("enable_current_change_announce"):
            return

        weather_entity = config.get("weather_entity")
        if not weather_entity:
            return

        @callback
        async def weather_state_changed(entity_id: str, old_state: Any, new_state: Any) -> None:
            """Handle weather state change."""
            current_config = await self.storage.async_get()
            if current_config.get("enable_current_change_announce"):
                volume = current_config.get("current_change_volume_level", 0.7)
                await self._announce_weather(current_config, volume_override=volume)

        self._listeners.append(
            async_track_state_change(self.hass, weather_entity, weather_state_changed)
        )

    async def _setup_upcoming_change_trigger(self, config: dict[str, Any]) -> None:
        """Setup upcoming precipitation change trigger."""
        if not config.get("enable_upcoming_change_announce"):
            return

        async def check_upcoming_precipitation(now: datetime) -> None:
            """Check for upcoming precipitation."""
            try:
                current_config = await self.storage.async_get()
                if not current_config.get("enable_upcoming_change_announce"):
                    return

                # Get weather data
                data = self.coordinator.data
                if not data or not data.get("configured"):
                    return

                hourly_forecast = data.get("hourly_forecast", [])
                minutes_before = current_config.get("minutes_before_announce", 30)
                precip_threshold = current_config.get("precip_threshold", 30)

                # Check if currently precipitating
                current = data.get("current", {})
                current_condition = current.get("condition", "").lower()
                is_precipitating = any(
                    word in current_condition
                    for word in ["rain", "snow", "sleet", "drizzle", "shower"]
                )

                if is_precipitating:
                    return  # Already precipitating, don't announce

                # Check hourly forecast for upcoming precipitation
                for forecast in hourly_forecast:
                    forecast_time = dt_util.parse_datetime(forecast.get("datetime", ""))
                    if not forecast_time:
                        continue

                    time_diff = (forecast_time - now).total_seconds() / 60
                    if 0 <= time_diff <= minutes_before:
                        precip_prob = forecast.get("precipitation_probability", 0)
                        if precip_prob >= precip_threshold:
                            volume = current_config.get("upcoming_change_volume_level", 0.7)
                            await self._announce_weather(current_config, volume_override=volume)
                            break  # Only announce once per check

            except Exception as e:
                _LOGGER.error("Error checking upcoming precipitation: %s", e)

        # Check every 5 minutes
        self._listeners.append(
            async_track_time_interval(
                self.hass, check_upcoming_precipitation, timedelta(minutes=5)
            )
        )

    async def _setup_webhook_trigger(self, config: dict[str, Any]) -> None:
        """Setup webhook trigger."""
        if not config.get("enable_alarm_announce"):
            return

        webhook_id = config.get("webhook_id")
        if not webhook_id:
            return

        async def handle_webhook(hass: HomeAssistant, webhook_id: str, request: Any) -> None:
            """Handle webhook call."""
            current_config = await self.storage.async_get()
            if current_config.get("enable_alarm_announce"):
                volume = current_config.get("alarm_volume_level", 0.8)
                await self._announce_weather(current_config, volume_override=volume)

        self.hass.components.webhook.async_register(DOMAIN, webhook_id, handle_webhook)

    async def _setup_voice_trigger(self, config: dict[str, Any]) -> None:
        """Setup voice trigger via conversation."""
        if not config.get("enable_voice_satellite"):
            return

        # Voice triggers are handled by the conversation integration
        # This would require additional setup with the conversation component
        _LOGGER.info("Voice triggers enabled (requires conversation integration setup)")

    async def _announce_weather(
        self, config: dict[str, Any], volume_override: float | None = None
    ) -> None:
        """Generate and announce weather forecast."""
        try:
            # Get weather data
            await self.coordinator.async_request_refresh()
            data = self.coordinator.data

            if not data or not data.get("configured"):
                _LOGGER.warning("Weather data not available for announcement")
                return

            # Generate message
            message = await self._generate_weather_message(data, config)

            # Optional AI rewrite
            if config.get("use_ai_rewrite") and config.get("ai_task_entity"):
                try:
                    result = await self.hass.services.async_call(
                        "assist_pipeline",
                        "run",
                        {
                            "entity_id": config["ai_task_entity"],
                            "text": message,
                            "prompt": config.get("ai_rewrite_prompt", "Rephrase this weather forecast naturally without changing any facts."),
                        },
                        blocking=True,
                        return_response=True,
                    )
                    if result and result.get("response"):
                        message = result["response"]
                except Exception as e:
                    _LOGGER.warning("AI rewrite failed, using original message: %s", e)

            # Get TTS settings
            tts_engine = config.get("tts_engine")
            media_players = config.get("media_players", [])
            volume = volume_override or config.get("volume_level", 0.7)
            voice = config.get("voice")
            preroll_ms = config.get("preroll_ms", 200)

            if not tts_engine or not media_players:
                _LOGGER.warning("TTS not configured")
                return

            # Pre-roll delay
            if preroll_ms > 0:
                await asyncio.sleep(preroll_ms / 1000.0)

            # Call TTS service for each media player
            for media_player in media_players:
                try:
                    service_data = {
                        "entity_id": media_player,
                        "message": message,
                    }

                    # Add voice if specified
                    if voice:
                        service_data["language"] = voice

                    # Set volume
                    await self.hass.services.async_call(
                        "media_player",
                        "volume_set",
                        {"entity_id": media_player, "volume_level": volume},
                    )

                    # Call TTS
                    await self.hass.services.async_call(
                        "tts",
                        f"{tts_engine}_say",
                        service_data,
                    )

                except Exception as e:
                    _LOGGER.error("Error calling TTS for %s: %s", media_player, e)

        except Exception as e:
            _LOGGER.error("Error announcing weather: %s", e)

    async def _generate_weather_message(
        self, data: dict[str, Any], config: dict[str, Any]
    ) -> str:
        """Generate weather forecast message."""
        current = data.get("current", {})
        hourly_forecast = data.get("hourly_forecast", [])
        daily_forecast = data.get("daily_forecast", [])

        # Greeting
        personal_name = config.get("personal_name", "")
        greeting = f"Hello {personal_name}, " if personal_name else ""

        # Current conditions
        temp = current.get("temperature")
        condition = current.get("condition", "unknown")
        current_line = f"Right now it's {temp}° with {condition}."

        # Today's forecast
        today = daily_forecast[0] if daily_forecast else {}
        high = today.get("temperature")
        low = today.get("templow")
        today_line = f"Today's high will be {high}° and low {low}°."

        # First precipitation window
        precip_line = ""
        for forecast in hourly_forecast:
            precip_prob = forecast.get("precipitation_probability", 0)
            if precip_prob > 0:
                forecast_time = dt_util.parse_datetime(forecast.get("datetime", ""))
                if forecast_time:
                    time_str = forecast_time.strftime("%I:%M %p")
                    precip_line = f" The first chance of precipitation is at {time_str} with a {precip_prob}% chance."
                break

        message = f"{greeting}{current_line} {today_line}{precip_line}"
        return message.strip()

    async def trigger_announcement(self) -> None:
        """Manually trigger an announcement."""
        config = await self.storage.async_get()
        await self._announce_weather(config)
