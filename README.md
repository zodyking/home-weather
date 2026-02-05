# Home Weather Integration

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/custom-components/hacs)
[![GitHub release](https://img.shields.io/github/release/zodyking/home-weather.svg)](https://github.com/zodyking/home-weather/releases)
[![License](https://img.shields.io/github/license/zodyking/home-weather.svg)](LICENSE)

A beautiful Home Assistant integration that converts the weather forecast alert blueprint into a full-featured integration with a custom sidebar panel, automated TTS announcements, and a beautiful weather display.

## Features

- **Beautiful Weather Display**: 24-hour and 7-day forecast views with modern, responsive design
- **Automated TTS Announcements**: All blueprint triggers implemented (schedule, sensor, weather changes, webhook, voice)
- **No Configuration Required**: All settings managed through the integration's panel
- **Smart Routing**: Automatically redirects to settings if not configured
- **Sidebar Panel**: Custom panel accessible from the hamburger menu

## Installation

### HACS (Recommended)

1. Install this integration via [HACS](https://hacs.xyz/)
   - Go to HACS → Integrations
   - Click the three dots (⋮) in the top right
   - Select "Custom repositories"
   - Add repository: `https://github.com/zodyking/home-weather`
   - Category: Integration
   - Click "Add"
   - Find "Home Weather" in the list and click "Install"
2. Restart Home Assistant
3. Add the panel to your sidebar by adding this to your `configuration.yaml`:

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

1. Copy the `custom_components/home_weather` folder to your Home Assistant `custom_components` directory:
   ```
   <config>/custom_components/home_weather/
   ```

2. Restart Home Assistant
3. Follow steps 3-5 above

## Configuration

All configuration is done through the panel's Settings page:

1. Open the Home Weather panel
2. If not configured, you'll be automatically redirected to Settings
3. Configure:
   - **Weather Entity**: Select your weather entity (must support forecasts)
   - **TTS Engine**: Select your TTS engine
   - **Media Players**: Select one or more media players for announcements
   - **Volume Level**: Set the default volume (0.0 - 1.0)
4. Click Save

## Automation Features

The integration automatically handles all triggers from the original blueprint:

- **Time-based**: Scheduled announcements at configured times
- **Sensor-triggered**: Announcements when binary sensors turn on
- **Current change**: Announcements when weather conditions change
- **Upcoming change**: Precipitation alerts before rain/snow
- **Webhook**: HTTP endpoint for external triggers
- **Voice**: Integration with conversation (optional)

## Panel Features

### Forecast View

- **24-Hour Forecast**: Scrollable horizontal timeline with hourly temperature, conditions, and precipitation probability
- **7-Day Forecast**: Daily cards with high/low temperatures and precipitation info
- **Toggle**: Switch between 24-hour and 7-day views

### Settings Page

- Weather entity selection
- TTS engine configuration
- Media player selection (multiple)
- Volume control
- All automation trigger settings

## Requirements

- Home Assistant 2024.1 or later
- A weather entity that supports `weather.get_forecasts` (daily + hourly)
- TTS integration configured
- Media player entities

## Troubleshooting

### Panel not showing in sidebar

- Ensure `panel_custom` entry is added to `configuration.yaml`
- Restart Home Assistant
- Check browser console for errors

### Weather data not loading

- Verify weather entity is configured in Settings
- Check that weather entity supports forecasts
- Check Home Assistant logs for errors

### TTS not working

- Verify TTS engine is configured
- Check media players are selected
- Test TTS manually via Developer Tools
- Check Home Assistant logs for service call errors

### Automation not triggering

- Ensure integration is configured (weather entity, TTS engine, media players)
- Check Home Assistant logs for automation errors
- Verify trigger settings are enabled in the backend (currently basic settings only in UI)

## Development

The integration consists of:

- **Backend (Python)**:
  - `__init__.py`: Integration setup and panel registration
  - `storage.py`: Configuration storage handler
  - `coordinator.py`: Weather data coordinator
  - `automation.py`: Automation triggers and TTS calls
  - `services.py`: WebSocket API handlers

- **Frontend (LitElement)**:
  - `www/weather-panel.js`: Main panel component with forecast display and settings

## License

See LICENSE file if present.

## Credits

Based on the [Weather Forecast Alert Blueprint](https://github.com/zodyking/weather-forecast-alert-blueprint) by zodyking.
