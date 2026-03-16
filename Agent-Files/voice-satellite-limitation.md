# Voice Satellite: Known Limitation

## Overview

The "Voice satellite" (conversation/voice command) trigger in Home Weather is **not fully implemented**. When enabled, the integration logs the configured conversation commands but does not register any actual conversation handler with Home Assistant.

## Current Behavior

- **Configured commands** (e.g. "What is the weather", "Whats the weather") are stored and logged.
- **No voice activation** – saying these phrases to a voice assistant (Google Home, Alexa, Home Assistant conversation) will **not** trigger a weather forecast.
- Full conversation agent integration requires a more complex setup (e.g. `ConversationEntity`, intent registration) which is not yet implemented.

## Workaround

Use the **Test Forecast** button in Settings (Time-Based Forecasts section) to manually play the full scheduled forecast on all configured media players. This validates that TTS, weather data, and message building work correctly.

## Future Implementation

A full voice satellite would require:

1. Registering with Home Assistant's conversation or intent system
2. Returning a response that triggers TTS (e.g. via `ConversationResponse`)
3. Proper handling of satellite/assistant device targeting
