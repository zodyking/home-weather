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

  _isNightTime(datetime) {
    if (!datetime) return false;
    const d = datetime instanceof Date ? datetime : new Date(datetime);
    const hour = d.getHours();
    return hour >= 18 || hour < 6;
  }

  _getConditionLabel(condition, datetime) {
    const c = (condition || "").toLowerCase().trim();
    if (this._isNightTime(datetime) && (c === "sunny" || c === "clear" || c === "fair")) {
      return "Clear skies";
    }
    return condition || "—";
  }

  _getConditionIcon(condition, size, datetime) {
    const c = (condition || "").toLowerCase().replace(/\s+/g, "");
    const isNight = this._isNightTime(datetime);
    // Meteocons (basmilius/weather-icons) - day/night variants
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
    const map = isNight ? nightMap : dayMap;
    let icon = map[c];
    if (!icon) {
      if (c.includes("rain")) icon = "rain";
      else if (c.includes("snow")) icon = "snow";
      else if (c.includes("cloud") || c.includes("overcast")) icon = isNight ? "overcast-night" : "cloudy";
      else if (c.includes("thunder") || c.includes("lightning")) icon = isNight ? "thunderstorms-night" : "thunderstorms-day";
      else if (c.includes("fog") || c.includes("mist") || c.includes("haze")) icon = isNight ? "fog-night" : "fog-day";
      else if (c.includes("wind")) icon = "wind";
      else icon = isNight ? "clear-night" : "partly-cloudy-day";
    }
    const w = size === "large" ? 88 : 48;
    const h = size === "large" ? 72 : 40;
    return `<img src="/local/home_weather/icons/meteocons/${icon}.svg" alt="${condition || 'weather'}" width="${w}" height="${h}" class="weather-icon" loading="lazy"/>`;
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
    s.innerHTML = `
      <style>
        :host { display: block; padding: 16px; max-width: 1200px; margin: 0 auto; }
        .loading, .error { text-align: center; padding: 48px 16px; color: var(--secondary-text-color); }
        .error { color: var(--error-color); }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid var(--divider-color); flex-wrap: wrap; gap: 12px; }
        .header-left { display: flex; align-items: center; gap: 12px; }
        .header h1 { margin: 0; font-size: 24px; font-weight: 400; color: var(--primary-text-color); }
        .header-nav { display: flex; gap: 0; }
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
        .current-section { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 24px; margin-bottom: 20px; padding: 24px 28px; background: var(--card-background-color); border-radius: 16px; border: 1px solid var(--divider-color); box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
        .current-left { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
        .current-icon-block { display: flex; flex-direction: column; align-items: center; gap: 8px; }
        .current-icon { width: 88px; height: 72px; display: flex; align-items: center; justify-content: center; overflow: visible; }
        .current-icon .weather-icon { width: 88px; height: 72px; object-fit: contain; }
        .current-condition { font-size: 16px; color: var(--primary-text-color); text-transform: capitalize; font-weight: 500; text-align: center; }
        .current-temp-block { display: flex; flex-direction: column; gap: 8px; }
        .current-temp { font-size: 72px; font-weight: 200; color: var(--primary-text-color); line-height: 1; letter-spacing: -2px; }
        .unit-toggle { display: flex; gap: 0; }
        .unit-btn { padding: 6px 12px; background: transparent; border: none; color: var(--secondary-text-color); cursor: pointer; font-size: 16px; font-weight: 500; }
        .unit-btn:hover { color: var(--primary-text-color); }
        .unit-btn.active { color: var(--accent-color); text-decoration: underline; text-underline-offset: 4px; }
        .current-metrics { font-size: 15px; color: var(--secondary-text-color); line-height: 2; font-weight: 400; }
        .current-right { display: flex; align-items: center; justify-content: flex-end; flex: 1; min-width: 0; }
        .weather-date { font-size: 28px; font-weight: 500; color: var(--primary-text-color); letter-spacing: -0.5px; line-height: 1.2; text-align: right; }
        .graph-section { margin-bottom: 20px; }
        .graph-legend { display: flex; gap: 20px; margin-bottom: 10px; font-size: 12px; color: var(--secondary-text-color); }
        .graph-legend-item { display: flex; align-items: center; gap: 6px; }
        .graph-legend-item .dot { width: 10px; height: 10px; border-radius: 50%; }
        .graph-legend-item .dot.temp { background: #e53935; }
        .graph-legend-item .dot.precip { background: #1e88e5; }
        .graph-legend-item .dot.wind { background: #757575; }
        .graph-container { position: relative; height: 160px; background: var(--card-background-color); border-radius: 12px; padding: 16px 16px 32px 44px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); border: 1px solid var(--divider-color); }
        .graph-container.combined-graph { height: 140px; cursor: crosshair; }
        .graph-svg { width: 100%; height: 90px; display: block; }
        .combined-graph .graph-svg { height: 100px; }
        .graph-times { position: absolute; bottom: 8px; left: 44px; right: 12px; height: 20px; font-size: 10px; font-weight: 500; color: var(--secondary-text-color); }
        .graph-time { position: absolute; transform: translate(-50%, 0); }
        .graph-tooltip { position: absolute; background: var(--card-background-color); border: 1px solid var(--divider-color); border-radius: 8px; padding: 10px 14px; font-size: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 10; pointer-events: none; }
        .graph-tooltip .tooltip-time { font-weight: 600; margin-bottom: 4px; }
        .graph-tooltip .tooltip-row { display: flex; justify-content: space-between; gap: 16px; }
        .graph-tooltip .tooltip-row span:first-child { color: var(--secondary-text-color); }
        .forecast-section { margin-bottom: 20px; overflow: visible; }
        .forecast-tabs { display: flex; gap: 8px; margin-bottom: 12px; }
        .forecast-tab { padding: 10px 20px; background: var(--card-background-color); border: 1px solid var(--divider-color); border-radius: 8px; color: var(--secondary-text-color); cursor: pointer; font-size: 14px; font-weight: 500; }
        .forecast-tab:hover { color: var(--primary-text-color); border-color: var(--primary-text-color); }
        .forecast-tab.active { background: var(--accent-color); color: white; border-color: var(--accent-color); }
        .daily-scroll { display: flex; gap: 20px; overflow-x: auto; padding: 24px 8px; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; scrollbar-width: none; -ms-overflow-style: none; }
        .daily-scroll::-webkit-scrollbar { display: none; }
        .forecast-card { display: flex; flex-direction: column; align-items: center; flex: 0 0 130px; min-width: 130px; scroll-snap-align: start; padding: 16px 14px; background: var(--card-background-color); border-radius: 20px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.06); border: none; transition: all 0.25s ease; overflow: visible; }
        .forecast-card.day-card { flex: 0 0 130px; min-width: 130px; }
        .forecast-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        .forecast-card.current-day { background: linear-gradient(180deg, rgba(66,133,244,0.12) 0%, rgba(66,133,244,0.04) 100%); box-shadow: 0 2px 12px rgba(66,133,244,0.2); }
        .day-icon { width: 56px; height: 48px; margin: 0 auto 10px; display: flex; align-items: center; justify-content: center; overflow: visible; }
        .forecast-card-label { font-size: 14px; font-weight: 600; color: var(--primary-text-color); margin-bottom: 8px; letter-spacing: -0.3px; display: block; width: 100%; }
        .day-icon .weather-icon { width: 56px; height: 48px; object-fit: contain; }
        .forecast-card-condition { font-size: 11px; color: var(--secondary-text-color); text-transform: capitalize; margin-bottom: 8px; display: block; width: 100%; }
        .forecast-card-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 16px; width: 100%; font-size: 11px; color: var(--secondary-text-color); text-align: left; }
        .forecast-card-grid .left { text-align: left; }
        .forecast-card-grid .right { text-align: right; }
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
            <div class="header-nav nav-tabs">
              <button class="nav-tab ${this._currentView === "forecast" ? "active" : ""}" data-view="forecast">Forecast</button>
              <button class="nav-tab ${this._currentView === "settings" ? "active" : ""}" data-view="settings">Settings</button>
            </div>
          </div>
        </div>
      </div>
      ${this._renderContent()}
    `;
    s.getElementById("hamburger-btn")?.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true }));
    });
    s.querySelectorAll(".nav-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.view) this._currentView = btn.dataset.view;
        this._render();
      });
    });
    if (this._currentView === "settings") {
      this._attachSettingsHandlers();
    } else if (this._currentView === "forecast") {
      this._attachGraphHandlers();
      s.querySelectorAll(".forecast-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          this._forecastView = btn.dataset.view || "7day";
          this._render();
        });
      });
      s.querySelectorAll(".unit-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          this._useFahrenheit = btn.dataset.unit === "F";
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
    const now = new Date();
    const dateLong = this._formatDateLong(now);
    const condition = current.condition || current.state || "—";
    const temp = current.temperature != null ? Math.round(current.temperature) : "—";
    const precipPct = hourly[0]?.precipitation_probability ?? 0;
    const humidity = current.humidity != null ? Math.round(current.humidity) : "—";
    const wind = this._formatWindSpeed(current.wind_speed, current.wind_speed_unit);
    const windUnit = (current.wind_speed_unit || "mph").toLowerCase();

    const graphData = hourly.slice(0, 24).map((h) => ({
      time: this._formatTime(h.datetime),
      temp: h.temperature != null ? Math.round(h.temperature) : null,
      precip: h.precipitation_probability ?? 0,
      wind: h.wind_speed ?? 0,
    }));

    const combinedChart = this._buildCombinedChart(graphData, windUnit);
    const timeStep = graphData.length > 12 ? 3 : graphData.length > 6 ? 2 : 1;
    const graphTimeLabels = [];
    for (let i = 0; i < graphData.length; i += timeStep) {
      graphTimeLabels.push({ label: graphData[i].time, pct: (i / (graphData.length - 1 || 1)) * 100 });
    }
    if (graphData.length && graphTimeLabels[graphTimeLabels.length - 1]?.pct < 99) {
      graphTimeLabels.push({ label: graphData[graphData.length - 1].time, pct: 100 });
    }

    return `
      <div class="weather-dashboard">
        <div class="current-section">
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
            <div class="current-metrics">
              <div>Precipitation: ${this._formatPrecip(precipPct)}</div>
              <div>Humidity: ${humidity === "—" ? "—" : humidity + "%"}</div>
              <div>Wind: ${wind}</div>
            </div>
          </div>
          <div class="current-right">
            <div class="weather-date">${dateLong}</div>
          </div>
        </div>
        <div class="forecast-section">
          <div class="forecast-tabs">
            <button class="forecast-tab ${this._forecastView === "7day" ? "active" : ""}" data-view="7day">7 Day</button>
            <button class="forecast-tab ${this._forecastView === "24h" ? "active" : ""}" data-view="24h">24 Hour</button>
          </div>
          <div class="daily-scroll">
            ${this._forecastView === "24h"
              ? hourly.slice(0, 24).map((h, i) => {
                  const hiTemp = h.temperature != null ? Math.round(h.temperature) : "—";
                  const lowTemp = h.templow != null ? Math.round(h.templow) : "—";
                  const windVal = h.wind_speed != null ? `${Math.round(h.wind_speed)} ${windUnit}` : "—";
                  const precipVal = this._formatPrecip(h.precipitation_probability);
                  return `
                <div class="forecast-card ${i === 0 ? "current-day" : ""}">
                  <div class="forecast-card-label">${this._formatTime(h.datetime)}</div>
                  <div class="day-icon">${this._getConditionIcon(h.condition, null, h.datetime)}</div>
                  <div class="forecast-card-condition">${this._getConditionLabel(h.condition, h.datetime)}</div>
                  <div class="forecast-card-grid">
                    <span class="col left">Hi: ${hiTemp}°</span>
                    <span class="col right">Low: ${lowTemp}°</span>
                    <span class="col left">Wind: ${windVal}</span>
                    <span class="col right">Precip: ${precipVal}</span>
                  </div>
                </div>
              `;
                }).join("")
              : daily.map((d, i) => {
                  const hiTemp = d.temperature != null ? Math.round(d.temperature) : "—";
                  const lowTemp = d.templow != null ? Math.round(d.templow) : "—";
                  const windVal = d.wind_speed != null ? `${Math.round(d.wind_speed)} ${windUnit}` : "—";
                  const precipVal = this._formatPrecip(d.precipitation_probability);
                  return `
                <div class="forecast-card day-card ${i === 0 ? "current-day" : ""}">
                  <div class="forecast-card-label">${this._formatDayShort(d.datetime)}</div>
                  <div class="day-icon">${this._getConditionIcon(d.condition, null, d.datetime)}</div>
                  <div class="forecast-card-condition">${d.condition || "—"}</div>
                  <div class="forecast-card-grid">
                    <span class="col left">Hi: ${hiTemp}°</span>
                    <span class="col right">Low: ${lowTemp}°</span>
                    <span class="col left">Wind: ${windVal}</span>
                    <span class="col right">Precip: ${precipVal}</span>
                  </div>
                </div>
              `;
                }).join("")
            }
          </div>
        </div>
        <div class="graph-section">
          <div class="graph-legend">
            <span class="graph-legend-item"><span class="dot temp"></span> Temperature</span>
            <span class="graph-legend-item"><span class="dot precip"></span> Precipitation</span>
            <span class="graph-legend-item"><span class="dot wind"></span> Wind</span>
          </div>
          <div class="graph-container combined-graph">
            <svg class="graph-svg" viewBox="0 0 600 120" preserveAspectRatio="none">
              <defs>
                <linearGradient id="graphGradTemp" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#e53935" stop-opacity="0.25"/>
                  <stop offset="100%" stop-color="#e53935" stop-opacity="0"/>
                </linearGradient>
                <linearGradient id="graphGradPrecip" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#1e88e5" stop-opacity="0.25"/>
                  <stop offset="100%" stop-color="#1e88e5" stop-opacity="0"/>
                </linearGradient>
                <linearGradient id="graphGradWind" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#757575" stop-opacity="0.2"/>
                  <stop offset="100%" stop-color="#757575" stop-opacity="0"/>
                </linearGradient>
              </defs>
              ${combinedChart.svg}
            </svg>
            <div class="graph-times">${graphTimeLabels.map((t) => `<span class="graph-time" style="left:${t.pct}%">${t.label}</span>`).join("")}</div>
            <div class="graph-tooltip" id="graph-tooltip" style="display:none"></div>
          </div>
        </div>
      </div>
    `;
  }

  _buildCombinedChart(data, windUnit) {
    if (!data.length) return { svg: "", points: [] };
    const w = 600;
    const h = 120;
    const padX = 28;
    const padY = 6;
    const bandH = (h - 2 * padY) / 3;
    const bandTop = (i) => padY + i * bandH;
    const bandBottom = (i) => padY + (i + 1) * bandH;

    const temps = data.map((d) => d.temp ?? 0).filter((v) => v !== null && !isNaN(v));
    const tempMin = temps.length ? Math.floor(Math.min(...temps)) - 2 : 0;
    const tempMax = temps.length ? Math.ceil(Math.max(...temps)) + 2 : 100;
    const tempRange = Math.max(tempMax - tempMin, 1);

    const precipMax = Math.max(20, ...data.map((d) => d.precip ?? 0));
    const precipRange = Math.max(precipMax, 1);

    const winds = data.map((d) => d.wind ?? 0);
    const windMax = winds.length ? Math.ceil(Math.max(...winds)) + 2 : 20;
    const windRange = Math.max(windMax, 1);

    const toTempPoints = () =>
      data.map((d, i) => {
        const x = padX + (i / (data.length - 1 || 1)) * (w - 2 * padX);
        const v = d.temp ?? tempMin;
        const norm = (v - tempMin) / tempRange;
        const y = bandBottom(0) - norm * bandH;
        return [x, y];
      });
    const toPrecipPoints = () =>
      data.map((d, i) => {
        const x = padX + (i / (data.length - 1 || 1)) * (w - 2 * padX);
        const v = (d.precip ?? 0) / precipRange;
        const y = bandBottom(1) - v * bandH;
        return [x, y];
      });
    const toWindPoints = () =>
      data.map((d, i) => {
        const x = padX + (i / (data.length - 1 || 1)) * (w - 2 * padX);
        const v = (d.wind ?? 0) / windRange;
        const y = bandBottom(2) - v * bandH;
        return [x, y];
      });

    const tempPoints = toTempPoints();
    const precipPoints = toPrecipPoints();
    const windPoints = toWindPoints();

    const toPath = (pts) => this._smoothPath(pts);
    const toAreaPath = (pts, baseY) => {
      const line = toPath(pts);
      const last = pts[pts.length - 1];
      const first = pts[0];
      return `${line} L ${last[0]} ${baseY} L ${first[0]} ${baseY} Z`;
    };

    const svg = `
      <line x1="${padX}" y1="${padY}" x2="${padX}" y2="${h - padY}" stroke="var(--divider-color)" stroke-width="1" opacity="0.5"/>
      <line x1="${padX}" y1="${h - padY}" x2="${w - padX}" y2="${h - padY}" stroke="var(--divider-color)" stroke-width="1" opacity="0.5"/>
      <line x1="${padX}" y1="${bandBottom(0)}" x2="${w - padX}" y2="${bandBottom(0)}" stroke="var(--divider-color)" stroke-width="0.5" opacity="0.3"/>
      <line x1="${padX}" y1="${bandBottom(1)}" x2="${w - padX}" y2="${bandBottom(1)}" stroke="var(--divider-color)" stroke-width="0.5" opacity="0.3"/>
      <path d="${toAreaPath(tempPoints, bandBottom(0))}" fill="url(#graphGradTemp)"/>
      <path d="${toPath(tempPoints)}" fill="none" stroke="#e53935" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="${toAreaPath(precipPoints, bandBottom(1))}" fill="url(#graphGradPrecip)"/>
      <path d="${toPath(precipPoints)}" fill="none" stroke="#1e88e5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="${toAreaPath(windPoints, bandBottom(2))}" fill="url(#graphGradWind)"/>
      <path d="${toPath(windPoints)}" fill="none" stroke="#757575" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      ${data.map((_, i) => {
        const x = padX + (i / (data.length - 1 || 1)) * (w - 2 * padX);
        const r = 3;
        return `<circle cx="${x}" cy="${tempPoints[i][1]}" r="${r}" fill="#e53935"/><circle cx="${x}" cy="${precipPoints[i][1]}" r="${r}" fill="#1e88e5"/><circle cx="${x}" cy="${windPoints[i][1]}" r="${r}" fill="#757575"/>`;
      }).join("")}
    `;
    return { svg, points: data, windUnit };
  }

  _attachGraphHandlers() {
    const s = this.shadowRoot;
    if (!s) return;
    const container = s.querySelector(".combined-graph");
    const tooltip = s.getElementById("graph-tooltip");
    if (!container || !tooltip) return;

    const hourly = (this._weatherData && this._weatherData.hourly_forecast) || [];
    const graphData = hourly.slice(0, 24).map((h) => ({
      time: this._formatTime(h.datetime),
      temp: h.temperature != null ? Math.round(h.temperature) : null,
      precip: h.precipitation_probability ?? 0,
      wind: h.wind_speed ?? 0,
    }));
    const windUnit = (this._weatherData?.current?.wind_speed_unit || "mph").toLowerCase();

    const showTooltip = (idx, x, y) => {
      if (idx < 0 || idx >= graphData.length) return;
      const d = graphData[idx];
      tooltip.innerHTML = `
        <div class="tooltip-time">${d.time}</div>
        <div class="tooltip-row"><span>Temp:</span><span style="color:#e53935">${d.temp != null ? d.temp + "°" : "—"}</span></div>
        <div class="tooltip-row"><span>Precip:</span><span style="color:#1e88e5">${Math.round(d.precip)}%</span></div>
        <div class="tooltip-row"><span>Wind:</span><span style="color:#757575">${Math.round(d.wind)} ${windUnit}</span></div>
      `;
      tooltip.style.display = "block";
      tooltip.style.left = `${Math.min(Math.max(x - 60, 10), container.offsetWidth - 130)}px`;
      tooltip.style.top = `${Math.max(y - 80, 10)}px`;
    };

    const hideTooltip = () => {
      tooltip.style.display = "none";
    };

    const getIndexFromEvent = (e) => {
      const rect = container.getBoundingClientRect();
      const graphLeft = 44;
      const graphWidth = rect.width - 60;
      const xPct = (e.clientX - rect.left - graphLeft) / graphWidth;
      const idx = Math.round(xPct * (graphData.length - 1));
      return Math.max(0, Math.min(idx, graphData.length - 1));
    };

    container.addEventListener("mousemove", (e) => {
      const rect = container.getBoundingClientRect();
      const idx = getIndexFromEvent(e);
      if (idx >= 0 && e.clientX >= rect.left && e.clientX <= rect.right) {
        showTooltip(idx, e.clientX - rect.left, e.clientY - rect.top);
      }
    });
    container.addEventListener("mouseleave", hideTooltip);
  }

  _smoothPath(points) {
    if (points.length < 2) return `M ${points[0][0]} ${points[0][1]} L ${points[1][0]} ${points[1][1]}`;
    let d = `M ${points[0][0]} ${points[0][1]}`;
    for (let i = 1; i < points.length; i++) {
      const [x0, y0] = points[i - 1];
      const [x1, y1] = points[i];
      const cpX = (x0 + x1) / 2;
      d += ` Q ${cpX} ${y0}, ${cpX} ${(y0 + y1) / 2}`;
      d += ` Q ${cpX} ${y1}, ${x1} ${y1}`;
    }
    return d;
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
