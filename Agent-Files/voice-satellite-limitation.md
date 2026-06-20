# Voice Satellite

## Overview

The "Voice satellite" (conversation/voice command) trigger in Home Weather **is implemented**. When enabled with at least one configured phrase, the integration registers a `HomeWeatherForecast` intent with Home Assistant and registers the phrases as `conversation` sentence triggers (when the running HA version supports `conversation.async_register_trigger`).

## Current Behavior

- **Configured commands** (e.g. "What is the weather", "Whats the weather") are stored and registered.
- A `HomeWeatherForecast` intent handler is registered via `homeassistant.helpers.intent.async_register`.
- When HA supports `conversation.async_register_trigger`, the configured phrases are registered as conversation sentence triggers — saying them to an Assist voice assistant fires the forecast on all configured media players.
- On older HA versions without `async_register_trigger`, only the intent handler is registered (the conversation sentences are skipped with a debug log).

## Implementation Reference

See `_setup_voice_satellite_trigger` in `custom_components/home_weather/tts_triggers.py`.

## Notes

- The intent handler fires `_fire_scheduled_forecast(refresh_weather=True)`, so the spoken forecast uses fresh coordinator data.
- The intent response speech is a fixed "Here is your weather forecast." line; the actual audio plays via TTS on the configured media players.
