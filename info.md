# Home Weather

A beautiful Home Assistant integration that converts the weather forecast alert blueprint into a full-featured integration with a custom sidebar panel, automated TTS announcements, and a beautiful weather display.

## Features

- **Beautiful Weather Display**: 24-hour and 7-day forecast views with modern, responsive design
- **Automated TTS Announcements**: All blueprint triggers implemented (schedule, sensor, weather changes, upcoming precipitation, webhook, voice satellite)
- **Sunrise & Sunset Alerts**: Upcoming and final TTS messages at sunrise/sunset, with optional automation triggers
- **NWS Weather Alerts**: Siren sound + TTS for new National Weather Service alerts at your location
- **Per-Media-Player Configuration**: Each media player has its own TTS entity, volume, preroll, cache, language, and options
- **AI Rewrite**: Optionally rewrite forecast messages with a Home Assistant AI Task entity
- **No Configuration Required**: All settings managed through the integration's panel
- **Smart Routing**: Automatically redirects to settings if not configured
- **Sidebar Panel**: Custom panel accessible from the hamburger menu

## Installation

### HACS (Recommended)

1. Install this integration via HACS
2. Restart Home Assistant
3. Add the panel to your sidebar by adding this to `configuration.yaml`:

```yaml
panel_custom:
  - name: home-weather
    sidebar_title: Home Weather
    sidebar_icon: mdi:weather-cloudy
    url_path: home-weather
    module_url: /local/home_weather/weather-panel.js
    embed_iframe: false
```

4. Restart Home Assistant again
5. Access the panel from the sidebar menu (hamburger icon) or navigate to `/home-weather`

### Manual Installation

1. Copy the `custom_components/home_weather` folder to your Home Assistant `custom_components` directory
2. Restart Home Assistant
3. Follow steps 3-5 above

## Configuration

All configuration is done through the panel's Settings page:

1. Open the Home Weather panel
2. If not configured, you'll be automatically redirected to Settings
3. Configure:
   - **Weather Entity**: Select your weather entity (must support hourly and daily forecasts)
   - **Media Players**: Add one or more media players, each with its own TTS entity, volume, preroll, cache, language, and options
   - **Message Intro**: Optional spoken intro prefix
   - **Announcement types**: Toggle each independently — time-based, current change, upcoming change, sunrise/sunset, NWS alerts, sensor triggered, webhook, voice satellite
   - **Advanced**: Precipitation/wind thresholds and optional AI rewrite
4. Click Save

## Requirements

- Home Assistant 2024.1 or later
- A weather entity that supports `weather.get_forecasts` (daily + hourly)
- One or more `tts.*` entities (TTS integration configured)
- One or more `media_player.*` entities

## Support

For issues, feature requests, or questions, please open an issue on GitHub.
