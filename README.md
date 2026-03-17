# Home Weather

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/custom-components/hacs)
[![License](https://img.shields.io/github/license/zodyking/home-weather.svg)](LICENSE)

A Home Assistant integration with a custom weather dashboard, automated TTS announcements, and full control from the panel—no YAML required.

## Features

### Dashboard

- **Current Conditions** — Live temperature, feels like, wind, gusts, high/low, condition, and date/time in a circular hero layout
- **Radar** — Windy.com map embed and interactive chart (temperature, precipitation, wind) with Map/Chart toggle
- **Forecast** — 7-day and 24-hour views with daily cards and hourly timeline
- **Moon & Sun** — Moon phase with lunar details; Sun details with sunrise, sunset, solar noon, and day length
- **Version & Update Status** — Integration version from manifest; polls GitHub every minute for "Update available" or "Latest version"
- **Responsive** — Fluid layout, mobile-friendly, single-line menu bar across screen sizes

### TTS Announcements

- **Time-based** — Scheduled forecasts at configurable intervals (e.g. every 3 hours, 8 AM–9 PM)
- **Sensor-triggered** — Full forecast when presence or other binary sensors turn on
- **Current change** — Alert when weather conditions change
- **Upcoming change** — Precipitation alerts before rain or snow (configurable lead time)
- **Webhook** — Personalized forecast via HTTP endpoint; multiple webhooks with optional names
- **Voice** — Weather queries via Home Assistant conversation
- **Sunrise/Sunset** — TTS announcements and automations at sunrise/sunset (configurable minutes before, intervals)

### Settings (Panel UI)

- **Weather** — Weather entity selection
- **TTS** — Per-media-player config (TTS entity, volume, preroll, cache, language, options); message prefix; time-based schedule; sensor triggers; current/upcoming alerts; webhooks; voice commands; precip/wind thresholds; optional AI rewrite; sunrise/sunset alerts

## Installation

### HACS (Recommended)

1. HACS → Integrations → ⋮ → Custom repositories
2. Add `https://github.com/zodyking/home-weather`, category: Integration
3. Install "Home Weather"
4. Restart Home Assistant

## Configuration

All configuration is done in the panel:

1. Open Home Weather
2. If not configured, you are redirected to Settings
3. Set **Weather Entity** (must support forecasts)
4. Optionally enable TTS and configure media players, triggers, and alerts
5. Save

## Requirements

- Home Assistant 2024.1 or later
- Weather entity with `weather.get_forecasts` (daily + hourly)
- For TTS: TTS integration and media player entities

## Troubleshooting

| Issue | Check |
|-------|------|
| Panel not in sidebar | `panel_custom` in `configuration.yaml`, restart HA |
| Weather not loading | Weather entity in Settings, entity supports forecasts |
| TTS not working | TTS engine and media players configured, test via Developer Tools |
| Triggers not firing | TTS enabled, trigger toggles on, check HA logs |

## License

MIT. See [LICENSE](LICENSE) if present.

## Credits

Based on the [Weather Forecast Alert Blueprint](https://github.com/zodyking/weather-forecast-alert-blueprint) by zodyking.
