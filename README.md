<p align="center">
  <img src="assets/readme-banner.png" alt="Home Weather — Home Assistant Integration" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/custom-components/hacs"><img src="https://img.shields.io/badge/HACS-Custom-orange.svg" alt="HACS Custom" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/zodyking/home-weather.svg" alt="License" /></a>
  <img src="https://img.shields.io/github/v/release/zodyking/home-weather?label=release" alt="Release" />
</p>

A Home Assistant custom integration with a full-screen weather panel, animated conditions, NWS alerts, hurricane tracking, and configurable TTS — all managed from the UI.

## Features

### Dashboard
- **Live conditions** — Animated atmosphere hero with temp, feels-like, wind, UV, humidity, and unified condition labels (Home Assistant + Apple WeatherKit)
- **Forecasts** — 7-day list and 24-hour timeline with detail sheets
- **Radar & charts** — Windy.com map embed plus temperature, precipitation, and wind charts
- **Moon & sun** — Phase, rise/set, solar noon, and day length
- **NWS alerts** — Active warnings with expandable details
- **Hurricane tracker** — NOAA/NHC storm map, forecast cone, and home threat summary
- **Responsive** — Mobile-friendly layout with dark theme independent of HA theme

### TTS & alerts
- Scheduled forecasts, sensor triggers, condition-change and upcoming-precip alerts
- Webhooks and voice/conversation weather queries
- Sunrise/sunset announcements and automations
- **NWS siren** — Play a custom sound before alert TTS (config/media)
- Per–media-player volume, preroll, language, and optional AI rewrite

### Settings
Everything is configured in the panel — weather entity, TTS players, triggers, thresholds, webhooks, and NWS options. No YAML required.

## Install

**HACS (recommended)**

1. HACS → Integrations → ⋮ → **Custom repositories**
2. Add `https://github.com/zodyking/home-weather` (category: Integration)
3. Install **Home Weather** and restart Home Assistant
4. Settings → Devices & services → **Add integration** → Home Weather

## Quick start

1. Open **Home Weather** from the sidebar
2. Choose a **weather entity** with daily and hourly forecasts
3. Optionally enable TTS, NWS alerts, or hurricane tracker from Settings
4. Save

## Requirements

- Home Assistant 2024.1+
- Weather entity supporting `weather.get_forecasts` (daily + hourly)
- TTS + media players (for announcements)
- `panel_custom` enabled if the sidebar entry is missing

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Panel missing from sidebar | Add `panel_custom` in `configuration.yaml`, restart HA |
| No weather data | Confirm entity in Settings; entity must expose forecasts |
| TTS silent | Configure TTS engine + media players; use Test TTS in Settings |
| NWS siren won't play | Place `.wav` files in `config/media/home_weather/sounds/` |
| Hurricane map empty | No active storms, or NOAA/NHC feed temporarily unavailable |

## License

MIT — see [LICENSE](LICENSE).

## Credits

Inspired by the [Weather Forecast Alert Blueprint](https://github.com/zodyking/weather-forecast-alert-blueprint) by [@zodyking](https://github.com/zodyking).
