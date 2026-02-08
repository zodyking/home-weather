/**
 * Home Weather Panel - Vanilla JS (no Lit) for HA custom panel compatibility
 */
class HomeWeatherPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._loading = false;
    this._error = null;
    this._currentView = "forecast";
    this._forecastView = "7day";
    this._useFahrenheit = true;
    this._weatherData = null;
    this._settings = {};
    this._settingsTab = "weather";
    this._narrow = null;
    this._graphHoverIndex = null;
    this._apexCharts = [];
  }

  get _isNarrow() {
    return this._narrow ?? this._mediaQuery?.matches ?? false;
  }

  set narrow(value) {
    this._narrow = value === undefined || value === null ? null : !!value;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (hass && !this._config) {
      this._loadConfig();
    }
    // Do NOT call _render() here - hass updates on every HA state change, causing constant re-renders.
    // Rendering happens on: loadConfig, loadWeatherData, user actions, media query.
  }

  set panel(panel) {
    this._panelConfig = panel && panel.config;
  }

  connectedCallback() {
    this._mediaQuery = window.matchMedia("(max-width: 768px)");
    this._onMediaChange = () => this._render();
    this._mediaQuery.addEventListener("change", this._onMediaChange);
    this._render();
    if (this._hass && !this._config) {
      this._loadConfig();
    }
  }

  disconnectedCallback() {
    if (this._mediaQuery && this._onMediaChange) {
      this._mediaQuery.removeEventListener("change", this._onMediaChange);
    }
  }

  async _loadConfig() {
    if (!this._hass) return;
    try {
      this._loading = true;
      this._error = null;
      this._render();
      const response = await this._hass.callWS({ type: "home_weather/get_config" });
      this._config = response.config || {};
      this._settings = JSON.parse(JSON.stringify(this._config || {}));
      if (!this._settings.tts) this._settings.tts = { enabled: false, language: "en", platform: null };
      if (!Array.isArray(this._settings.media_players)) this._settings.media_players = [];
      if (!this._config.weather_entity) {
        this._currentView = "settings";
      }
      await this._loadWeatherData();
      // Refresh every 5 min
      if (this._refreshInterval) clearInterval(this._refreshInterval);
      this._refreshInterval = setInterval(() => this._loadWeatherData(), 5 * 60 * 1000);
    } catch (e) {
      console.error("Error loading config:", e);
      this._error = "Failed to load configuration";
    } finally {
      this._loading = false;
      this._render();
    }
  }

  async _loadWeatherData() {
    if (!this._hass || !this._config || !this._config.weather_entity) return;
    try {
      const response = await this._hass.callWS({ type: "home_weather/get_weather" });
      this._weatherData = response.data;
    } catch (e) {
      console.error("Error loading weather:", e);
      this._error = "Failed to load weather data";
    }
    this._render();
  }

  async _saveSettings() {
    if (!this._hass) return;
    const s = this.shadowRoot;
    if (s) {
      const ttsPlatform = s.getElementById("tts-platform");
      if (ttsPlatform) this._settings.tts = { ...(this._settings.tts || {}), platform: ttsPlatform.value || null };
      const mediaSelects = s.querySelectorAll(".media-player-select");
      if (mediaSelects.length) {
        this._settings.media_players = Array.from(mediaSelects).map((sel) => sel.value).filter(Boolean);
      }
    }
    try {
      this._loading = true;
      this._render();
      await this._hass.callWS({ type: "home_weather/set_config", config: this._settings });
      this._config = { ...this._settings };
      this._currentView = "forecast";
      await this._loadWeatherData();
    } catch (e) {
      console.error("Error saving:", e);
      this._error = "Failed to save settings";
    } finally {
      this._loading = false;
      this._render();
    }
  }

  _formatTime(dt) {
    if (!dt) return "";
    return new Date(dt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  _formatDay(dt) {
    if (!dt) return "";
    const d = new Date(dt);
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
    return d.toLocaleDateString("en-US", { weekday: "long" });
  }

  _formatDayShort(dt) {
    if (!dt) return "";
    return new Date(dt).toLocaleDateString("en-US", { weekday: "short" });
  }

  _formatDayLabel(dt) {
    if (!dt) return "";
    const d = new Date(dt);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return "Today";
    return d.toLocaleDateString("en-US", { weekday: "short" });
  }

  _formatDateMMDD(dt) {
    if (!dt) return "";
    const d = new Date(dt);
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${m}/${day}`;
  }

  _formatDateLong(d) {
    if (!d) return "";
    const date = d instanceof Date ? d : new Date(d);
    const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
    const month = date.toLocaleDateString("en-US", { month: "long" });
    const day = date.getDate();
    const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
    const year = date.getFullYear();
    return `${weekday}, ${month} ${day}${suffix} ${year}`;
  }

  _getMoonPhase(date) {
    const d = date instanceof Date ? date : new Date(date);
    const LUNAR_CYCLE = 29.53059;
    const KNOWN_NEW = new Date("2000-01-06T18:14Z").getTime();
    const ageDays = ((d.getTime() - KNOWN_NEW) / 86400000) % LUNAR_CYCLE;
    const phaseRatio = ageDays / LUNAR_CYCLE;
    const illumination = Math.round(
      (1 - Math.cos(2 * Math.PI * phaseRatio)) * 50
    );
    const phases = [
      { name: "New Moon", icon: "moon-new" },
      { name: "Waxing Crescent", icon: "moon-waxing-crescent" },
      { name: "First Quarter", icon: "moon-first-quarter" },
      { name: "Waxing Gibbous", icon: "moon-waxing-gibbous" },
      { name: "Full Moon", icon: "moon-full" },
      { name: "Waning Gibbous", icon: "moon-waning-gibbous" },
      { name: "Last Quarter", icon: "moon-last-quarter" },
      { name: "Waning Crescent", icon: "moon-waning-crescent" },
    ];
    const idx = Math.min(7, Math.floor(phaseRatio * 8));
    return { ...phases[idx], illumination, daysSinceNew: ageDays.toFixed(1) };
  }

  _formatDateTimeWithTime(d) {
    if (!d) return "";
    const date = d instanceof Date ? d : new Date(d);
    const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const dateStr = this._formatDateLong(d);
    return `${time} – ${dateStr}`;
  }

  _isNightTime(datetime) {
    if (!datetime) return false;
    const d = datetime instanceof Date ? datetime : new Date(datetime);
    const hour = d.getHours();
    // Day: 7am–6:59pm (7–18). Night: 7pm–6:59am (19–6).
    return hour >= 19 || hour < 7;
  }

  _getConditionLabel(condition, datetime) {
    const c = (condition || "").toLowerCase().trim();
    if (this._isNightTime(datetime) && (c === "sunny" || c === "clear" || c === "fair")) {
      return "Clear skies";
    }
    return condition || "—";
  }

  _getConditionIcon(condition, size, datetime, forceDay = false) {
    const c = (condition || "").toLowerCase().replace(/\s+/g, "");
    const isNight = forceDay ? false : this._isNightTime(datetime);
    // 7-day forecast: ONLY icons with "day" in filename. Others use day/night variants.
    const dayOnlyMap = {
      sunny: "clear-day", clear: "clear-day", fair: "clear-day", clearskies: "clear-day",
      partlycloudy: "partly-cloudy-day", partly_cloudy: "partly-cloudy-day",
      cloudy: "overcast-day", overcast: "overcast-day",
      fog: "fog-day", foggy: "fog-day", mist: "fog-day", hazy: "haze-day",
      rain: "partly-cloudy-day-rain", rainy: "partly-cloudy-day-rain", drizzle: "partly-cloudy-day-drizzle",
      snow: "partly-cloudy-day-snow", snowy: "partly-cloudy-day-snow", flurries: "partly-cloudy-day-snow",
      lightning: "thunderstorms-day", thunderstorm: "thunderstorms-day", thunderstorms: "thunderstorms-day",
      hail: "partly-cloudy-day-hail", sleet: "partly-cloudy-day-sleet", windy: "partly-cloudy-day",
    };
    const dayMap = {
      sunny: "clear-day", clear: "clear-day", fair: "clear-day", clearskies: "clear-day",
      partlycloudy: "partly-cloudy-day", partly_cloudy: "partly-cloudy-day",
      cloudy: "cloudy", overcast: "overcast-day",
      fog: "fog-day", foggy: "fog-day", mist: "mist", hazy: "haze-day",
      rain: "rain", rainy: "rain", drizzle: "drizzle",
      snow: "snow", snowy: "snow", flurries: "snow",
      lightning: "thunderstorms-day", thunderstorm: "thunderstorms-day", thunderstorms: "thunderstorms-day",
      hail: "hail", sleet: "sleet", windy: "wind",
    };
    const nightMap = {
      sunny: "clear-night", clear: "clear-night", fair: "clear-night", clearskies: "clear-night",
      partlycloudy: "partly-cloudy-night", partly_cloudy: "partly-cloudy-night",
      cloudy: "cloudy", overcast: "overcast-night",
      fog: "fog-night", foggy: "fog-night", mist: "mist", hazy: "haze-night",
      rain: "rain", rainy: "rain", drizzle: "drizzle",
      snow: "snow", snowy: "snow", flurries: "snow",
      lightning: "thunderstorms-night", thunderstorm: "thunderstorms-night", thunderstorms: "thunderstorms-night",
      hail: "hail", sleet: "sleet", windy: "wind",
    };
    const map = forceDay ? dayOnlyMap : (isNight ? nightMap : dayMap);
    let icon = map[c];
    if (!icon) {
      if (c.includes("rain")) icon = forceDay ? "partly-cloudy-day-rain" : "rain";
      else if (c.includes("snow")) icon = forceDay ? "partly-cloudy-day-snow" : "snow";
      else if (c.includes("cloud") || c.includes("overcast")) icon = forceDay ? "overcast-day" : (isNight ? "overcast-night" : "cloudy");
      else if (c.includes("thunder") || c.includes("lightning")) icon = isNight ? "thunderstorms-night" : "thunderstorms-day";
      else if (c.includes("fog") || c.includes("mist") || c.includes("haze")) icon = forceDay ? "fog-day" : (isNight ? "fog-night" : "fog-day");
      else if (c.includes("wind")) icon = forceDay ? "partly-cloudy-day" : "wind";
      else icon = forceDay ? "partly-cloudy-day" : (isNight ? "clear-night" : "partly-cloudy-day");
    }
    const w = size === "large" ? 88 : 48;
    const h = size === "large" ? 72 : 40;
    const subfolder = icon.includes("day") ? "day/" : icon.includes("night") ? "night/" : "";
    return `<img src="/local/home_weather/icons/${subfolder}${icon}.svg" alt="${condition || 'weather'}" width="${w}" height="${h}" class="weather-icon" loading="lazy"/>`;
  }

  _formatWindSpeed(val, unit) {
    if (val == null) return "—";
    const u = (unit || "mph").toLowerCase();
    return `${Math.round(val)} ${u}`;
  }

  _formatPrecip(val) {
    if (val == null) return "0%";
    return `${Math.round(val)}%`;
  }

  _getPrecipType(condition, precipitationKind) {
    if (precipitationKind) return String(precipitationKind).toLowerCase();
    const c = (condition || "").toLowerCase();
    if (c.includes("snow") || c.includes("flurr")) return "snow";
    if (c.includes("hail")) return "hail";
    if (c.includes("sleet")) return "sleet";
    if (c.includes("rain") || c.includes("drizzle") || c.includes("thunder")) return "rain";
    return null;
  }

  _render() {
    const s = this.shadowRoot;
    if (!s) return;
    this._apexCharts.forEach((ch) => { try { ch.destroy(); } catch (_) {} });
    this._apexCharts = [];
    s.innerHTML = `
      <style>
        :host { display: block; padding: 16px; max-width: 1200px; margin: 0 auto; }
        .loading, .error { text-align: center; padding: 48px 16px; color: var(--secondary-text-color); }
        .error { color: var(--error-color); }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid var(--divider-color); flex-wrap: wrap; gap: 12px; }
        .header-left { display: flex; align-items: center; gap: 12px; }
        .header-right { display: flex; align-items: center; margin-left: auto; }
        .header h1 { margin: 0; font-size: 24px; font-weight: 400; color: var(--primary-text-color); }
        .header-nav { display: flex; gap: 0; }
        .header-btn { padding: 8px; background: transparent; border: none; border-radius: 8px; color: var(--primary-text-color); cursor: pointer; display: flex; align-items: center; justify-content: center; }
        .header-btn:hover { background: var(--secondary-background-color); }
        .header-btn svg { width: 24px; height: 24px; }
        .hamburger { display: none; padding: 8px; background: transparent; border: none; cursor: pointer; color: var(--primary-text-color); border-radius: 8px; }
        .hamburger:hover { background: var(--secondary-background-color); }
        .hamburger svg { width: 24px; height: 24px; display: block; }
        @media (max-width: 768px) { .hamburger { display: block; } }
        .narrow .hamburger { display: block; }
        .nav-tabs { display: flex; gap: 8px; }
        .nav-tab { padding: 12px 24px; background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--secondary-text-color); cursor: pointer; font-size: 16px; }
        .nav-tab:hover { color: var(--primary-text-color); }
        .nav-tab.active { color: var(--primary-color); border-bottom-color: var(--primary-color); }
        .view-toggle { display: flex; gap: 8px; margin-bottom: 24px; }
        .view-toggle button { padding: 8px 16px; background: var(--card-background-color); border: 1px solid var(--divider-color); border-radius: 4px; color: var(--primary-text-color); cursor: pointer; }
        .view-toggle button.active { background: var(--primary-color); color: var(--primary-color-text); border-color: var(--primary-color); }
        .hourly-forecast { display: flex; gap: 12px; overflow-x: auto; padding: 16px 0; }
        .hour-card { min-width: 120px; padding: 20px 16px; background: var(--card-background-color); border-radius: 12px; text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.1); border: 1px solid var(--divider-color); }
        .hour-card.current { border: 2px solid var(--primary-color); background: var(--primary-color); color: var(--primary-color-text); }
        .hour-time { font-size: 14px; color: var(--secondary-text-color); margin-bottom: 8px; }
        .hour-card.current .hour-time { color: var(--primary-color-text); }
        .hour-temp { font-size: 28px; font-weight: 600; margin: 12px 0; }
        .hour-condition { font-size: 13px; color: var(--secondary-text-color); margin-top: 12px; }
        .hour-card.current .hour-condition { color: var(--primary-color-text); }
        .hour-precip { font-size: 11px; color: var(--info-color); margin-top: 4px; }
        .daily-forecast { display: grid; gap: 12px; }
        .day-card { display: flex; justify-content: space-between; align-items: center; padding: 20px; background: var(--card-background-color); border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .day-name { font-size: 16px; font-weight: 500; min-width: 100px; }
        .day-temps { display: flex; gap: 16px; }
        .day-high { font-size: 20px; font-weight: 500; }
        .day-low { font-size: 16px; color: var(--secondary-text-color); }
        .day-precip { font-size: 14px; color: var(--info-color); margin-left: auto; }
        .settings-form { display: grid; gap: 24px; }
        .settings-tabs { display: flex; gap: 0; margin-bottom: 24px; border-bottom: 2px solid var(--divider-color); }
        .settings-tab { padding: 12px 24px; background: transparent; border: none; border-bottom: 3px solid transparent; margin-bottom: -2px; color: var(--secondary-text-color); cursor: pointer; font-size: 15px; font-weight: 500; }
        .settings-tab:hover { color: var(--primary-text-color); }
        .settings-tab.active { color: var(--accent-color); border-bottom-color: var(--accent-color); }
        .settings-section { display: none; }
        .settings-section.active { display: block; }
        .form-group { display: flex; flex-direction: column; gap: 8px; }
        .form-group label { font-size: 14px; font-weight: 500; color: var(--primary-text-color); }
        .form-group input, .form-group select { padding: 12px 16px; border: 1px solid var(--divider-color); border-radius: 8px; background: var(--card-background-color); color: var(--primary-text-color); font-size: 14px; }
        .form-group input[type="checkbox"] { width: auto; padding: 0; }
        .form-row { display: flex; align-items: center; gap: 12px; }
        .form-row .btn-icon { padding: 8px 12px; min-width: auto; }
        .media-player-list { display: flex; flex-direction: column; gap: 12px; }
        .media-player-item { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: var(--card-background-color); border: 1px solid var(--divider-color); border-radius: 8px; }
        .media-player-item select { flex: 1; }
        .form-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px; }
        .btn { padding: 12px 32px; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; }
        .btn-primary { background: var(--primary-color); color: var(--primary-color-text); }
        .btn-secondary { background: var(--secondary-background-color); color: var(--primary-text-color); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .weather-dashboard { --accent-color: #4285f4; --hero-gradient: linear-gradient(135deg, #4285f4 0%, #34a853 50%, #fbbc04 100%); }
        .current-section { display: flex; flex-direction: column; gap: 24px; margin-bottom: 20px; padding: 28px 32px; background: linear-gradient(145deg, var(--card-background-color) 0%, rgba(66,133,244,0.06) 100%); border-radius: 20px; border: 1px solid var(--divider-color); box-shadow: 0 4px 24px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04); }
        .current-hero { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 24px; }
        .current-left { display: flex; align-items: center; gap: 28px; flex-wrap: wrap; }
        .current-icon-block { display: flex; flex-direction: column; align-items: center; gap: 10px; }
        .current-icon { width: 96px; height: 80px; display: flex; align-items: center; justify-content: center; overflow: visible; }
        .current-icon .weather-icon { width: 96px; height: 80px; object-fit: contain; filter: drop-shadow(0 2px 8px rgba(0,0,0,0.08)); }
        .current-condition { font-size: 18px; color: var(--primary-text-color); text-transform: capitalize; font-weight: 500; text-align: center; letter-spacing: 0.3px; }
        .current-temp-block { display: flex; flex-direction: column; gap: 10px; }
        .current-temp { font-size: 80px; font-weight: 200; color: var(--primary-text-color); line-height: 1; letter-spacing: -3px; }
        .current-date-row { width: 100%; padding: 12px 0 0; border-top: 1px solid var(--divider-color); margin-top: 8px; }
        .weather-date { font-size: 20px; font-weight: 500; color: var(--secondary-text-color); letter-spacing: -0.2px; line-height: 1.3; }
        .current-metrics { display: flex; flex-wrap: nowrap; gap: 12px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; -ms-overflow-style: none; }
        .current-metrics::-webkit-scrollbar { display: none; }
        .metric-pill { flex-shrink: 0; display: flex; align-items: center; gap: 12px; padding: 14px 18px; background: var(--secondary-background-color); border-radius: 14px; border: 1px solid var(--divider-color); transition: all 0.2s ease; }
        .metric-pill:hover { filter: brightness(1.05); transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
        .metric-pill-icon { width: 32px; height: 32px; flex-shrink: 0; opacity: 0.85; }
        .metric-pill-content { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .metric-pill-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--secondary-text-color); opacity: 0.9; }
        .metric-pill-value { font-size: 16px; font-weight: 600; color: var(--primary-text-color); }
        .graph-section { margin-bottom: 20px; }
        .graph-legend { display: flex; gap: 20px; margin-bottom: 10px; font-size: 12px; color: var(--secondary-text-color); }
        .graph-legend-item { display: flex; align-items: center; gap: 6px; }
        .graph-legend-item .dot { width: 10px; height: 10px; border-radius: 50%; }
        .graph-legend-item .dot.temp { background: #e53935; }
        .graph-legend-item .dot.precip { background: #1e88e5; }
        .graph-legend-item .dot.wind { background: #757575; }
        .graph-container { position: relative; background: var(--card-background-color); border-radius: 12px; padding: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); border: 1px solid var(--divider-color); }
        .graph-container.combined-graph { display: flex; flex-direction: column; gap: 24px; }
        .graph-chart { min-height: 200px; }
        .graph-svg { width: 100%; height: 90px; display: block; }
        .graph-times { position: absolute; bottom: 8px; left: 44px; right: 12px; height: 20px; font-size: 10px; font-weight: 500; color: var(--secondary-text-color); }
        .graph-time { position: absolute; transform: translate(-50%, 0); }
        .graph-tooltip { position: absolute; background: var(--card-background-color); border: 1px solid var(--divider-color); border-radius: 8px; padding: 10px 14px; font-size: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 10; pointer-events: none; }
        .graph-tooltip .tooltip-time { font-weight: 600; margin-bottom: 4px; }
        .graph-tooltip .tooltip-row { display: flex; justify-content: space-between; gap: 16px; }
        .graph-tooltip .tooltip-row span:first-child { color: var(--secondary-text-color); }
        .forecast-moon-row { display: grid; grid-template-columns: 1fr auto; gap: 24px; margin-bottom: 20px; align-items: start; }
        @media (max-width: 900px) { .forecast-moon-row { grid-template-columns: 1fr; } }
        .forecast-section { overflow-x: visible; overflow-y: visible; min-width: 0; }
        .moon-phase-section { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px 32px; background: var(--card-background-color); border-radius: 20px; border: 1px solid var(--divider-color); box-shadow: 0 2px 12px rgba(0,0,0,0.06); min-width: 180px; }
        .moon-phase-section-title { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: var(--secondary-text-color); margin-bottom: 16px; }
        .moon-phase-icon { width: 200px; height: 200px; display: flex; align-items: center; justify-content: center; }
        .moon-phase-icon img { width: 100%; height: 100%; object-fit: contain; filter: drop-shadow(0 4px 16px rgba(0,0,0,0.15)); }
        .moon-phase-name { font-size: 16px; font-weight: 600; color: var(--primary-text-color); margin-top: 12px; text-align: center; }
        .moon-phase-details { font-size: 13px; color: var(--secondary-text-color); margin-top: 6px; }
        .forecast-tabs { display: flex; gap: 8px; margin-bottom: 12px; }
        .forecast-tab { padding: 10px 20px; background: var(--card-background-color); border: 1px solid var(--divider-color); border-radius: 8px; color: var(--secondary-text-color); cursor: pointer; font-size: 14px; font-weight: 500; }
        .forecast-tab:hover { color: var(--primary-text-color); border-color: var(--primary-text-color); }
        .forecast-tab.active { background: var(--accent-color); color: white; border-color: var(--accent-color); }
        .daily-scroll { display: flex; gap: 12px; overflow-y: hidden; padding: 16px 4px; min-width: 0; }
        .daily-scroll.view-7day { overflow-x: visible; flex-wrap: nowrap; }
        .daily-scroll.view-24h { overflow-x: auto; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; scrollbar-width: none; -ms-overflow-style: none; }
        .daily-scroll.view-24h::-webkit-scrollbar { width: 0; height: 0; display: none; }
        .daily-scroll.view-24h::-webkit-scrollbar-track, .daily-scroll.view-24h::-webkit-scrollbar-thumb { display: none; width: 0; height: 0; background: transparent; }
        .forecast-card { display: flex; flex-direction: column; align-items: center; scroll-snap-align: start; padding: 12px 8px; background: var(--card-background-color); border-radius: 16px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.06); border: none; transition: all 0.25s ease; overflow: visible; }
        .forecast-card.day-card { flex: 1 1 0; min-width: 90px; }
        .daily-scroll.view-24h .forecast-card { flex: 0 0 110px; min-width: 110px; }
        .forecast-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        .forecast-card.current-day { background: linear-gradient(180deg, rgba(66,133,244,0.12) 0%, rgba(66,133,244,0.04) 100%); box-shadow: 0 2px 12px rgba(66,133,244,0.2); }
        .day-icon { width: 56px; height: 48px; margin: 0 auto 8px; display: flex; align-items: center; justify-content: center; overflow: visible; }
        .forecast-card.day-card .day-icon { width: 48px; height: 40px; margin-bottom: 6px; }
        .forecast-card.day-card .day-icon .weather-icon { width: 48px; height: 40px; }
        .forecast-card-label { font-size: 14px; font-weight: 600; color: var(--primary-text-color); margin-bottom: 8px; letter-spacing: -0.3px; display: block; width: 100%; }
        .forecast-card.day-card .forecast-card-label { font-size: 13px; margin-bottom: 6px; }
        .day-icon .weather-icon { width: 56px; height: 48px; object-fit: contain; }
        .forecast-card-condition { font-size: 11px; color: var(--secondary-text-color); text-transform: capitalize; margin-bottom: 8px; display: block; width: 100%; }
        .forecast-card.day-card .forecast-card-condition { font-size: 10px; margin-bottom: 6px; }
        .forecast-card-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 8px; width: 100%; font-size: 11px; color: var(--secondary-text-color); text-align: left; }
        .forecast-card-grid .left { text-align: left; }
        .forecast-card-grid .right { text-align: right; }
        .forecast-card-grid .col-span-full { grid-column: 1 / -1; text-align: center; }
        .forecast-card-grid .row { display: contents; }
        .forecast-card-grid .col { min-width: 0; }
      </style>
      <div class="${this._isNarrow ? "narrow" : ""}">
        <div class="header">
          <div class="header-left">
            <button class="hamburger" id="hamburger-btn" aria-label="Open Home Assistant sidebar">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
            </button>
            <h1>Home Weather</h1>
          </div>
          <div class="header-right">
            ${this._currentView === "forecast"
              ? `<button class="header-btn" id="settings-btn" aria-label="Settings" data-view="settings">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
                </button>`
              : `<button class="header-btn" id="back-btn" aria-label="Back to dashboard" data-view="forecast">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
                  <span style="margin-left:6px;font-size:14px">Back to dashboard</span>
                </button>`
            }
          </div>
        </div>
      </div>
      ${this._renderContent()}
    `;
    s.getElementById("hamburger-btn")?.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true }));
    });
    const settingsBtn = s.getElementById("settings-btn");
    const backBtn = s.getElementById("back-btn");
    if (settingsBtn) settingsBtn.addEventListener("click", () => { this._currentView = "settings"; this._render(); });
    if (backBtn) backBtn.addEventListener("click", () => { this._currentView = "forecast"; this._render(); });
    if (this._currentView === "settings") {
      this._attachSettingsHandlers();
    } else if (this._currentView === "forecast") {
      this._initApexChart();
      s.querySelectorAll(".forecast-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          this._forecastView = btn.dataset.view || "7day";
          this._render();
        });
      });
    }
  }

  _attachSettingsHandlers() {
    const s = this.shadowRoot;
    if (!s) return;
    s.querySelectorAll(".settings-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._settingsTab = btn.dataset.settingsTab || "weather";
        this._render();
      });
    });
    const we = s.getElementById("weather-entity");
    if (we) we.addEventListener("change", (e) => { this._settings.weather_entity = e.target.value || null; this._render(); });
    const ttsEnabled = s.getElementById("tts-enabled");
    if (ttsEnabled) ttsEnabled.addEventListener("change", (e) => {
      this._settings.tts = { ...(this._settings.tts || {}), enabled: e.target.checked };
      this._render();
    });
    const ttsLang = s.getElementById("tts-language");
    if (ttsLang) ttsLang.addEventListener("change", (e) => {
      this._settings.tts = { ...(this._settings.tts || {}), language: e.target.value };
      this._render();
    });
    const ttsPlatform = s.getElementById("tts-platform");
    if (ttsPlatform) ttsPlatform.addEventListener("input", (e) => {
      this._settings.tts = { ...(this._settings.tts || {}), platform: e.target.value || null };
    });
    s.querySelectorAll("[data-remove-media]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.removeMedia, 10);
        const list = [...(this._settings.media_players || [])];
        list.splice(idx, 1);
        this._settings.media_players = list;
        this._render();
      });
    });
    s.querySelectorAll(".media-player-select").forEach((sel, i) => {
      sel.addEventListener("change", (e) => {
        const list = [...(this._settings.media_players || [])];
        list[i] = e.target.value;
        this._settings.media_players = list;
        this._render();
      });
    });
    const addMediaBtn = s.getElementById("add-media-btn");
    const addMediaSelect = s.getElementById("media-player-add");
    if (addMediaBtn && addMediaSelect) {
      addMediaBtn.addEventListener("click", () => {
        const val = addMediaSelect.value;
        if (!val) return;
        const list = [...(this._settings.media_players || [])];
        list.push(val);
        this._settings.media_players = list;
        this._render();
      });
    }
    const saveBtn = s.getElementById("save-btn");
    const cancelBtn = s.getElementById("cancel-btn");
    if (saveBtn) saveBtn.addEventListener("click", () => this._saveSettings());
    if (cancelBtn) cancelBtn.addEventListener("click", () => {
      this._settings = JSON.parse(JSON.stringify(this._config || {}));
      if (!this._settings.tts) this._settings.tts = { enabled: false, language: "en", platform: null };
      if (!Array.isArray(this._settings.media_players)) this._settings.media_players = [];
      this._render();
    });
  }

  _renderContent() {
    if (!this._hass) return `<div class="loading">Connecting...</div>`;
    if (this._loading && !this._config) return `<div class="loading">Loading...</div>`;
    if (this._error && !this._config) return `<div class="error">${String(this._error)}</div>`;
    return this._currentView === "forecast" ? this._renderForecast() : this._renderSettings();
  }

  _renderForecast() {
    if (!this._weatherData || !this._weatherData.configured) {
      return `<div class="error">Weather data not available. Please configure the integration in Settings.</div>`;
    }
    const current = this._weatherData.current || {};
    const hourly = this._weatherData.hourly_forecast || [];
    const daily = (this._weatherData.daily_forecast || []).slice(0, 7);
    const h0 = hourly[0] || {};
    const now = new Date();
    const dateTimeStr = this._formatDateTimeWithTime(now);
    const condition = current.condition || current.state || "—";
    const temp = (current.temperature ?? h0.temperature) != null ? Math.round(current.temperature ?? h0.temperature) : "—";
    const windUnit = (current.wind_speed_unit || "mph").toLowerCase();
    const pressureUnit = (current.pressure_unit || "inHg").toLowerCase();
    const precipUnit = (current.precipitation_unit || "in").toLowerCase();

    const graphData = hourly.slice(0, 24).map((h) => ({
      time: this._formatTime(h.datetime),
      temp: h.temperature != null ? Math.round(h.temperature) : null,
      feelsLike: h.apparent_temperature != null ? Math.round(h.apparent_temperature) : null,
      dewPoint: h.dew_point != null ? Math.round(h.dew_point) : null,
      precipChance: h.precipitation_probability ?? 0,
      precipAmount: h.precipitation ?? 0,
      humidity: h.humidity ?? null,
      windSpeed: h.wind_speed ?? 0,
      windGusts: h.wind_gust_speed ?? 0,
      pressure: h.pressure ?? null,
      cloudCover: h.cloud_coverage ?? null,
      uvIndex: h.uv_index ?? null,
    }));

    this._graphData = graphData;
    this._graphWindUnit = windUnit;

    const feelsLike = (current.apparent_temperature ?? h0.apparent_temperature) != null ? Math.round(current.apparent_temperature ?? h0.apparent_temperature) : null;
    const dewPoint = (current.dew_point ?? h0.dew_point) != null ? Math.round(current.dew_point ?? h0.dew_point) : null;
    const humidity = (current.humidity ?? h0.humidity) != null ? Math.round(current.humidity ?? h0.humidity) : null;
    const precipChance = (h0.precipitation_probability ?? 0);
    const precipAmount = (current.precipitation ?? h0.precipitation);
    const windSpeed = (current.wind_speed ?? h0.wind_speed);
    const windGusts = (current.wind_gust_speed ?? h0.wind_gust_speed);
    const pressure = (current.pressure ?? h0.pressure);
    const cloudCover = (current.cloud_coverage ?? h0.cloud_coverage);
    const uvIndex = (current.uv_index ?? h0.uv_index);

    const metricPills = [
      feelsLike != null && { icon: "thermometer-warmer.svg", label: "Feels Like", value: `${feelsLike}°` },
      dewPoint != null && { icon: "thermometer-raindrop.svg", label: "Dew Point", value: `${dewPoint}°` },
      humidity != null && { icon: "humidity.svg", label: "Humidity", value: `${humidity}%` },
      { icon: "raindrop.svg", label: "Precip Chance", value: `${Math.round(precipChance)}%` },
      precipAmount != null && precipAmount > 0 && { icon: "raindrop-measure.svg", label: "Rain", value: `${precipAmount} ${precipUnit}` },
      windSpeed != null && { icon: "wind.svg", label: "Wind", value: `${Math.round(windSpeed)} ${windUnit}` },
      windGusts != null && { icon: "windsock.svg", label: "Gusts", value: `${Math.round(windGusts)} ${windUnit}` },
      pressure != null && { icon: "barometer.svg", label: "Pressure", value: `${pressure} ${pressureUnit}` },
      cloudCover != null && { icon: "cloud-up.svg", label: "Clouds", value: `${cloudCover}%` },
      uvIndex != null && { icon: "uv-index.svg", label: "UV Index", value: String(uvIndex) },
    ].filter(Boolean);

    return `
      <div class="weather-dashboard">
        <div class="current-section">
          <div class="current-hero">
            <div class="current-left">
              <div class="current-icon-block">
                <div class="current-icon">${this._getConditionIcon(condition, "large", now)}</div>
                <div class="current-condition">${this._getConditionLabel(condition, now)}</div>
              </div>
              <div class="current-temp-block">
                <span class="current-temp">${temp}</span>
                <div class="unit-toggle">
                  <button class="unit-btn ${this._useFahrenheit ? "active" : ""}" data-unit="F">°F</button>
                  <button class="unit-btn ${!this._useFahrenheit ? "active" : ""}" data-unit="C">°C</button>
                </div>
              </div>
            </div>
            <div class="current-right">
              <div class="weather-date">${dateTimeStr}</div>
            </div>
          </div>
          <div class="current-metrics">
            ${metricPills.map((p) => `
              <div class="metric-pill">
                <img src="/local/home_weather/icons/${p.icon}" alt="" class="metric-pill-icon" width="32" height="32" loading="lazy"/>
                <div class="metric-pill-content">
                  <span class="metric-pill-label">${p.label}</span>
                  <span class="metric-pill-value">${p.value}</span>
                </div>
              </div>
            `).join("")}
          </div>
        </div>
        <div class="forecast-moon-row">
        <div class="forecast-section">
          <div class="forecast-tabs">
            <button class="forecast-tab ${this._forecastView === "7day" ? "active" : ""}" data-view="7day">7 Day</button>
            <button class="forecast-tab ${this._forecastView === "24h" ? "active" : ""}" data-view="24h">24 Hour</button>
          </div>
          <div class="daily-scroll ${this._forecastView === "7day" ? "view-7day" : "view-24h"}">
            ${this._forecastView === "24h"
              ? hourly.slice(0, 24).map((h, i) => {
                  const hiTemp = h.temperature != null ? Math.round(h.temperature) : "—";
                  const windVal = h.wind_speed != null ? `${Math.round(h.wind_speed)} ${windUnit.toUpperCase()}` : "—";
                  const precipVal = this._formatPrecip(h.precipitation_probability);
                  const timeLabel = i === 0 ? "Now" : this._formatTime(h.datetime);
                  return `
                <div class="forecast-card ${i === 0 ? "current-day" : ""}">
                  <div class="forecast-card-label">${timeLabel}</div>
                  <div class="day-icon">${this._getConditionIcon(h.condition, null, h.datetime)}</div>
                  <div class="forecast-card-condition">${this._getConditionLabel(h.condition, h.datetime)}</div>
                  <div class="forecast-card-grid">
                    <span class="col left">Temp: ${hiTemp}°</span>
                    <span class="col right">Precip: ${precipVal}</span>
                    <span class="col col-span-full">Wind Speed: ${windVal}</span>
                  </div>
                </div>
              `;
                }).join("")
              : daily.map((d, i) => {
                  const hiTemp = d.temperature != null ? Math.round(d.temperature) : "—";
                  const lowTemp = d.templow != null ? Math.round(d.templow) : "—";
                  const precipVal = this._formatPrecip(d.precipitation_probability);
                  const dateMMDD = this._formatDateMMDD(d.datetime);
                  return `
                <div class="forecast-card day-card ${i === 0 ? "current-day" : ""}">
                  <div class="forecast-card-label">${this._formatDayLabel(d.datetime)}</div>
                  <div class="day-icon">${this._getConditionIcon(d.condition, null, null, true)}</div>
                  <div class="forecast-card-condition">${d.condition || "—"}</div>
                  <div class="forecast-card-grid">
                    <span class="col left">Hi: ${hiTemp}°</span>
                    <span class="col right">Low: ${lowTemp}°</span>
                    <span class="col left">Precip: ${precipVal}</span>
                    <span class="col right">${dateMMDD}</span>
                  </div>
                </div>
              `;
                }).join("")
            }
          </div>
        </div>
        <div class="moon-phase-section">
          <div class="moon-phase-section-title">Moon Phase</div>
          <div class="moon-phase-icon">
            <img src="/local/home_weather/icons/Moon%20Phase/${this._getMoonPhase(now).icon}.svg" alt="${this._getMoonPhase(now).name}" loading="lazy"/>
          </div>
          <div class="moon-phase-name">${this._getMoonPhase(now).name}</div>
          <div class="moon-phase-details">${this._getMoonPhase(now).illumination}% illuminated · Day ${this._getMoonPhase(now).daysSinceNew}</div>
        </div>
        </div>
        <div class="graph-section">
          <div class="graph-container combined-graph">
            <div id="apex-chart-combined" class="graph-chart"></div>
          </div>
        </div>
      </div>
    `;
  }

  _loadApexCharts() {
    if (window.ApexCharts) return Promise.resolve();
    if (this._apexChartsPromise) return this._apexChartsPromise;
    this._apexChartsPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/apexcharts@3.45.1/dist/apexcharts.min.js";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load ApexCharts"));
      document.head.appendChild(script);
    });
    return this._apexChartsPromise;
  }

  _baseChartOptions(data) {
    return {
      chart: { type: "area", height: 320, toolbar: { show: false }, zoom: { enabled: false }, fontFamily: "inherit" },
      dataLabels: { enabled: false },
      stroke: { curve: "smooth", width: 2 },
      fill: { type: "gradient", gradient: { opacityFrom: 0.2, opacityTo: 0 } },
      xaxis: {
        categories: data.map((d) => d.time),
        labels: { style: { colors: "#94a3b8" }, trim: true, maxHeight: 36 },
        axisBorder: { show: false },
        axisTicks: { show: false },
      },
      grid: { borderColor: "rgba(128,128,128,0.2)", strokeDashArray: 4, xaxis: { lines: { show: false } }, yaxis: { lines: { show: true } } },
      legend: { show: true, position: "top", horizontalAlign: "left" },
    };
  }

  _normalizeForChart(v, min, max) {
    if (v == null || min == null || max == null || max === min) return null;
    return Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
  }

  async _initApexChart() {
    const s = this.shadowRoot;
    if (!s || !this._graphData?.length) return;
    const data = this._graphData;
    const windUnit = (this._graphWindUnit || "mph").toUpperCase();
    const tempUnit = this._useFahrenheit ? "°F" : "°C";
    try {
      await this._loadApexCharts();
      const tempVals = data.flatMap((d) => [d.temp, d.feelsLike, d.dewPoint]).filter((n) => n != null);
      const tempMin = tempVals.length ? Math.floor(Math.min(...tempVals)) - 2 : 0;
      const tempMax = tempVals.length ? Math.ceil(Math.max(...tempVals)) + 2 : 100;
      const pressureVals = data.map((d) => d.pressure).filter((n) => n != null);
      const pressureMin = pressureVals.length ? Math.min(...pressureVals) - 0.1 : 29;
      const pressureMax = pressureVals.length ? Math.max(...pressureVals) + 0.1 : 31;
      const precipAmountVals = data.map((d) => d.precipAmount).filter((n) => n != null && n > 0);
      const precipAmountMax = precipAmountVals.length ? Math.max(...precipAmountVals) * 1.2 || 0.5 : 0.5;
      const windVals = data.flatMap((d) => [d.windSpeed, d.windGusts]).filter((n) => n != null);
      const windMax = windVals.length ? Math.ceil(Math.max(...windVals)) + 5 : 50;

      const allFields = [
        { key: "temp", label: "Temperature", color: "#e53935", format: (x) => (x != null ? `${x}°` : "—"), min: tempMin, max: tempMax },
        { key: "feelsLike", label: "Feels Like", color: "#ff7043", format: (x) => (x != null ? `${x}°` : "—"), min: tempMin, max: tempMax },
        { key: "dewPoint", label: "Dew Point", color: "#ab47bc", format: (x) => (x != null ? `${x}°` : "—"), min: tempMin, max: tempMax },
        { key: "precipChance", label: "Precip Chance", color: "#1e88e5", format: (x) => (x != null ? `${Math.round(x)}%` : "—"), min: 0, max: 100 },
        { key: "humidity", label: "Humidity", color: "#26a69a", format: (x) => (x != null ? `${x}%` : "—"), min: 0, max: 100 },
        { key: "precipAmount", label: "Precipitation Amount", color: "#42a5f5", format: (x) => (x != null ? `${x} in` : "—"), min: 0, max: precipAmountMax },
        { key: "windSpeed", label: "Wind Speed", color: "#757575", format: (x) => (x != null ? `${Math.round(x)} ${windUnit}` : "—"), min: 0, max: windMax },
        { key: "windGusts", label: "Wind Gusts", color: "#78909c", format: (x) => (x != null ? `${Math.round(x)} ${windUnit}` : "—"), min: 0, max: windMax },
        { key: "pressure", label: "Pressure", color: "#8d6e63", format: (x) => (x != null ? `${x} inHg` : "—"), min: pressureMin, max: pressureMax },
        { key: "cloudCover", label: "Cloud Cover", color: "#90a4ae", format: (x) => (x != null ? `${x}%` : "—"), min: 0, max: 100 },
        { key: "uvIndex", label: "UV Index", color: "#ffa726", format: (x) => (x != null ? String(x) : "—"), min: 0, max: 12 },
      ];

      const series = allFields.map((f) => ({
        name: f.label,
        data: data.map((d) => this._normalizeForChart(d[f.key], f.min, f.max)),
        type: "line",
      }));

      const tooltip = ({ dataPointIndex }) => {
        const d = data[dataPointIndex];
        const rows = allFields.map((f) => {
          const v = d[f.key];
          return `<div style="display:flex;justify-content:space-between;gap:16px"><span style="color:var(--secondary-text-color)">${f.label}:</span><span style="color:${f.color}">${f.format(v)}</span></div>`;
        }).join("");
        return `<div style="background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:8px;padding:10px 14px;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,0.15);"><div style="font-weight:600;margin-bottom:4px">${d.time}</div>${rows}</div>`;
      };

      const container = s.getElementById("apex-chart-combined");
      if (!container) return;
      const baseOpts = this._baseChartOptions(data);
      const opts = {
        ...baseOpts,
        chart: { ...baseOpts.chart, type: "line" },
        colors: ["#e53935", "#ff7043", "#ab47bc", "#1e88e5", "#26a69a", "#42a5f5", "#757575", "#78909c", "#8d6e63", "#90a4ae", "#ffa726"],
        series,
        yaxis: [{ min: 0, max: 100, labels: { formatter: (v) => v }, axisBorder: { show: false }, axisTicks: { show: false }, labels: { style: { colors: "#94a3b8" } } }],
        title: { text: "All metrics (normalized)", align: "left", style: { fontSize: "14px", fontWeight: 600 } },
        tooltip: { shared: true, intersect: false, custom: tooltip },
      };
      const ch = new ApexCharts(container, opts);
      await ch.render();
      this._apexCharts.push(ch);
    } catch (e) {
      console.error("ApexCharts init failed:", e);
    }
  }

  _renderSettings() {
    const entities = Object.keys((this._hass && this._hass.states) || {});
    const weatherEntities = entities.filter((e) => e.startsWith("weather."));
    const mediaPlayerEntities = entities.filter((e) => e.startsWith("media_player."));
    const tts = this._settings.tts || { enabled: false, language: "en", platform: null };
    const mediaPlayers = Array.isArray(this._settings.media_players) ? this._settings.media_players : [];
    const usedMediaPlayers = new Set(mediaPlayers);
    const availableMediaPlayers = mediaPlayerEntities.filter((e) => !usedMediaPlayers.has(e));
    return `
      <div class="settings-form">
        <div class="settings-tabs">
          <button class="settings-tab ${this._settingsTab === "weather" ? "active" : ""}" data-settings-tab="weather">Weather</button>
          <button class="settings-tab ${this._settingsTab === "tts" ? "active" : ""}" data-settings-tab="tts">TTS</button>
          <button class="settings-tab ${this._settingsTab === "media" ? "active" : ""}" data-settings-tab="media">Media Players</button>
        </div>
        <div class="settings-section ${this._settingsTab === "weather" ? "active" : ""}" data-section="weather">
          <div class="form-group">
            <label>Weather Entity *</label>
            <select id="weather-entity">
              <option value="">Select weather entity</option>
              ${weatherEntities.map((e) => `<option value="${e}" ${this._settings.weather_entity === e ? "selected" : ""}>${e}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="settings-section ${this._settingsTab === "tts" ? "active" : ""}" data-section="tts">
          <div class="form-group">
            <label><input type="checkbox" id="tts-enabled" ${tts.enabled ? "checked" : ""}/> Enable TTS for weather announcements</label>
          </div>
          <div class="form-group">
            <label>Language</label>
            <select id="tts-language">
              <option value="en" ${tts.language === "en" ? "selected" : ""}>English</option>
              <option value="es" ${tts.language === "es" ? "selected" : ""}>Spanish</option>
              <option value="fr" ${tts.language === "fr" ? "selected" : ""}>French</option>
              <option value="de" ${tts.language === "de" ? "selected" : ""}>German</option>
              <option value="it" ${tts.language === "it" ? "selected" : ""}>Italian</option>
            </select>
          </div>
          <div class="form-group">
            <label>TTS Platform (optional)</label>
            <input type="text" id="tts-platform" placeholder="e.g. google_translate" value="${tts.platform || ""}"/>
          </div>
        </div>
        <div class="settings-section ${this._settingsTab === "media" ? "active" : ""}" data-section="media">
          <div class="form-group">
            <label>Media Players for weather announcements</label>
            <div class="media-player-list" id="media-player-list">
              ${mediaPlayers.map((entityId, i) => `
                <div class="media-player-item" data-index="${i}">
                  <select class="media-player-select">
                    <option value="${entityId}">${entityId}</option>
                    ${mediaPlayerEntities.map((e) => `<option value="${e}" ${e === entityId ? "selected" : ""}>${e}</option>`).join("")}
                  </select>
                  <button type="button" class="btn btn-secondary btn-icon" data-remove-media="${i}" aria-label="Remove">−</button>
                </div>
              `).join("")}
            </div>
            <div class="form-row" style="margin-top: 12px;">
              <select id="media-player-add">
                <option value="">Add media player...</option>
                ${availableMediaPlayers.map((e) => `<option value="${e}">${e}</option>`).join("")}
                ${availableMediaPlayers.length === 0 ? "<option value=\"\" disabled>No more available</option>" : ""}
              </select>
              <button type="button" class="btn btn-secondary" id="add-media-btn">Add</button>
            </div>
          </div>
        </div>
        <div class="form-actions">
          <button class="btn btn-secondary" id="cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="save-btn">Save</button>
        </div>
      </div>
    `;
  }
}

customElements.define("home-weather-panel", HomeWeatherPanel);
