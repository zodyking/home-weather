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
    this._forecastView = "24h";
    this._graphMode = "temperature";
    this._useFahrenheit = true;
    this._weatherData = null;
    this._settings = {};
    this._narrow = null;
    this._drawerOpen = false;
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
    } else if (hass) {
      this._render();
    }
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
      this._settings = { ...this._config };
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

  _getConditionIcon(condition) {
    const c = (condition || "").toLowerCase().replace(/\s+/g, "");
    const icons = {
      sunny: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM12 2L9 5h6l-3-3zm0 14l-3 3h6l-3-3zM2 12l3-3v6l-3-3zm14 0l3 3v-6l-3 3zM5 5L2 8h2L5 5zm14 0l3 3h-2l-1-3zM5 19l-3-3h2l1 3zm14 0l-3-3h2l3 3z"/></svg>',
      clear: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5z"/></svg>',
      partlycloudy: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zm-5 8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm10 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>',
      partly_cloudy: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zm-5 8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm10 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z"/></svg>',
      cloudy: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>',
      fog: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 15h18v2H3v-2zm0 4h18v2H3v-2zm0-8h18v2H3v-2zm0-4h18v2H3V7z"/></svg>',
      rain: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 14h2v4H6v-4zm4-4h2v8h-2v-8zm4 2h2v6h-2v-6zm-8 2h2v4H6v-4zm4-4h2v8h-2v-8zm4 2h2v6h-2v-6z"/><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z" opacity="0.3"/></svg>',
      snowy: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/><path d="M12 18c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z" fill="#87CEEB"/></svg>',
      snow: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/><path d="M12 18c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z" fill="#87CEEB"/></svg>',
      lightning: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>',
      thunderstorm: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 2v11h3v9l7-12h-4l4-8z"/></svg>',
      hail: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 18c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>',
      overcast: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>',
    };
    return icons[c] || icons.partlycloudy;
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

  _render() {
    const s = this.shadowRoot;
    if (!s) return;
    if (!this._isNarrow) this._drawerOpen = false;
    s.innerHTML = `
      <style>
        :host { display: block; padding: 16px; max-width: 1200px; margin: 0 auto; }
        .loading, .error { text-align: center; padding: 48px 16px; color: var(--secondary-text-color); }
        .error { color: var(--error-color); }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--divider-color); }
        .header h1 { margin: 0; font-size: 24px; font-weight: 400; color: var(--primary-text-color); }
        .hamburger { display: none; padding: 8px; background: transparent; border: none; cursor: pointer; color: var(--primary-text-color); border-radius: 8px; }
        .hamburger:hover { background: var(--secondary-background-color); }
        .hamburger svg { width: 24px; height: 24px; display: block; }
        .drawer-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 1000; opacity: 0; pointer-events: none; transition: opacity 0.2s; }
        .drawer-overlay.open { opacity: 1; pointer-events: auto; }
        .drawer { position: fixed; top: 0; left: 0; bottom: 0; width: 280px; max-width: 85vw; background: var(--card-background-color); box-shadow: 4px 0 16px rgba(0,0,0,0.2); z-index: 1001; transform: translateX(-100%); transition: transform 0.25s ease; }
        .drawer.open { transform: translateX(0); }
        .drawer-header { display: flex; justify-content: space-between; align-items: center; padding: 16px; border-bottom: 1px solid var(--divider-color); }
        .drawer-header h2 { margin: 0; font-size: 18px; font-weight: 500; color: var(--primary-text-color); }
        .drawer-close { padding: 8px; background: transparent; border: none; cursor: pointer; color: var(--secondary-text-color); border-radius: 8px; }
        .drawer-close:hover { background: var(--secondary-background-color); color: var(--primary-text-color); }
        .drawer-nav { padding: 16px; display: flex; flex-direction: column; gap: 4px; }
        .drawer-nav .nav-tab { justify-content: flex-start; width: 100%; text-align: left; padding: 14px 16px; border-radius: 8px; margin-bottom: 0; }
        .drawer-nav .view-toggle { flex-direction: column; margin: 16px 0 0; }
        .drawer-nav .view-toggle button { width: 100%; text-align: left; padding: 12px 16px; }
        .main-nav { display: flex; gap: 8px; margin-bottom: 24px; }
        @media (max-width: 768px) { .hamburger { display: block; } .main-nav { display: none; } }
        .narrow .hamburger { display: block; }
        .narrow .main-nav { display: none; }
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
        .form-group { display: flex; flex-direction: column; gap: 8px; }
        .form-group label { font-size: 14px; font-weight: 500; color: var(--primary-text-color); }
        .form-group input, .form-group select { padding: 12px 16px; border: 1px solid var(--divider-color); border-radius: 8px; background: var(--card-background-color); color: var(--primary-text-color); font-size: 14px; }
        .form-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px; }
        .btn { padding: 12px 32px; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; }
        .btn-primary { background: var(--primary-color); color: var(--primary-color-text); }
        .btn-secondary { background: var(--secondary-background-color); color: var(--primary-text-color); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .weather-dashboard { --accent-color: #4285f4; --hero-gradient: linear-gradient(135deg, #4285f4 0%, #34a853 50%, #fbbc04 100%); }
        .current-section { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 32px; margin-bottom: 24px; padding: 32px 28px; background: linear-gradient(180deg, rgba(66,133,244,0.15) 0%, transparent 100%); border-radius: 24px; border: none; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
        .current-left { display: flex; align-items: center; gap: 28px; flex-wrap: wrap; }
        .current-icon { width: 96px; height: 96px; color: #fbbc04; filter: drop-shadow(0 2px 8px rgba(251,188,4,0.3)); }
        .current-icon svg { width: 100%; height: 100%; }
        .current-temp-block { display: flex; flex-direction: column; gap: 8px; }
        .current-temp { font-size: 72px; font-weight: 200; color: var(--primary-text-color); line-height: 1; letter-spacing: -2px; }
        .unit-toggle { display: flex; gap: 0; }
        .unit-btn { padding: 6px 12px; background: transparent; border: none; color: var(--secondary-text-color); cursor: pointer; font-size: 16px; font-weight: 500; }
        .unit-btn:hover { color: var(--primary-text-color); }
        .unit-btn.active { color: var(--accent-color); text-decoration: underline; text-underline-offset: 4px; }
        .current-metrics { font-size: 15px; color: var(--secondary-text-color); line-height: 2; font-weight: 400; }
        .current-right { text-align: right; }
        .weather-title { margin: 0 0 4px; font-size: 22px; font-weight: 500; color: var(--primary-text-color); letter-spacing: -0.5px; }
        .weather-day { font-size: 18px; color: var(--secondary-text-color); font-weight: 400; }
        .weather-condition { font-size: 20px; color: var(--primary-text-color); text-transform: capitalize; font-weight: 500; }
        .graph-section { margin-bottom: 28px; }
        .graph-tabs { display: flex; gap: 0; margin-bottom: 16px; border-bottom: 2px solid var(--divider-color); }
        .graph-tab { padding: 14px 24px; background: transparent; border: none; border-bottom: 3px solid transparent; margin-bottom: -2px; color: var(--secondary-text-color); cursor: pointer; font-size: 15px; font-weight: 500; }
        .graph-tab:hover { color: var(--primary-text-color); }
        .graph-tab.active { color: var(--accent-color); border-bottom-color: var(--accent-color); }
        .graph-container { position: relative; height: 160px; background: var(--card-background-color); border-radius: 16px; padding: 24px 20px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); border: none; }
        .graph-svg { width: 100%; height: 90px; display: block; }
        .graph-labels { position: absolute; top: 20px; left: 16px; right: 16px; height: 20px; pointer-events: none; }
        .graph-label { position: absolute; transform: translate(-50%, 0); font-size: 12px; color: var(--primary-text-color); }
        .graph-times { position: absolute; bottom: 20px; left: 16px; right: 16px; height: 20px; font-size: 12px; color: var(--secondary-text-color); }
        .graph-time { position: absolute; transform: translate(-50%, 0); }
        .daily-section { margin-bottom: 24px; }
        .daily-scroll { display: flex; gap: 16px; overflow-x: auto; padding: 20px 0; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; }
        .day-card { flex: 0 0 88px; scroll-snap-align: start; padding: 20px 12px; background: var(--card-background-color); border-radius: 20px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.06); border: none; transition: all 0.25s ease; }
        .day-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        .day-card.current-day { background: linear-gradient(180deg, rgba(66,133,244,0.12) 0%, rgba(66,133,244,0.04) 100%); box-shadow: 0 2px 12px rgba(66,133,244,0.2); }
        .day-abbr { font-size: 15px; font-weight: 600; color: var(--primary-text-color); margin-bottom: 12px; letter-spacing: -0.3px; }
        .day-icon { width: 44px; height: 44px; margin: 0 auto 12px; color: #fbbc04; }
        .day-icon svg { width: 100%; height: 100%; }
        .day-temps { font-size: 15px; color: var(--secondary-text-color); font-weight: 500; }
      </style>
      <div class="${this._isNarrow ? "narrow" : ""}">
        <div class="header">
          <button class="hamburger" id="hamburger-btn" aria-label="Open menu">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
          </button>
          <h1>Home Weather</h1>
        </div>
        <div class="main-nav nav-tabs">
          <button class="nav-tab ${this._currentView === "forecast" ? "active" : ""}" data-view="forecast">Forecast</button>
          <button class="nav-tab ${this._currentView === "settings" ? "active" : ""}" data-view="settings">Settings</button>
        </div>
      </div>
      <div class="drawer-overlay ${this._drawerOpen ? "open" : ""}" id="drawer-overlay"></div>
      <aside class="drawer ${this._drawerOpen ? "open" : ""}" id="drawer">
        <div class="drawer-header">
          <h2>Menu</h2>
          <button class="drawer-close" id="drawer-close" aria-label="Close menu">✕</button>
        </div>
        <div class="drawer-nav">
          <button class="nav-tab ${this._currentView === "forecast" ? "active" : ""}" data-view="forecast">Forecast</button>
          <button class="nav-tab ${this._currentView === "settings" ? "active" : ""}" data-view="settings">Settings</button>
        </div>
      </aside>
      ${this._renderContent()}
    `;
    const openDrawer = () => { this._drawerOpen = true; this._render(); };
    const closeDrawer = () => { this._drawerOpen = false; this._render(); };
    s.getElementById("hamburger-btn")?.addEventListener("click", openDrawer);
    s.getElementById("drawer-overlay")?.addEventListener("click", closeDrawer);
    s.getElementById("drawer-close")?.addEventListener("click", closeDrawer);
    s.querySelectorAll(".nav-tab").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        if (btn.dataset.view) this._currentView = btn.dataset.view;
        if (this._isNarrow && s.getElementById("drawer")?.contains(btn)) closeDrawer();
        this._render();
      });
    });
    if (this._currentView === "settings") {
      this._attachSettingsHandlers();
    } else if (this._currentView === "forecast") {
      s.querySelectorAll(".graph-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          this._graphMode = btn.dataset.graph;
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
    const we = s.getElementById("weather-entity");
    const saveBtn = s.getElementById("save-btn");
    const cancelBtn = s.getElementById("cancel-btn");
    if (we) we.addEventListener("change", (e) => { this._settings.weather_entity = e.target.value; this._render(); });
    if (saveBtn) saveBtn.addEventListener("click", () => this._saveSettings());
    if (cancelBtn) cancelBtn.addEventListener("click", () => {
      this._settings = { ...this._config };
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
    const daily = this._weatherData.daily_forecast || [];
    const today = new Date().toLocaleDateString("en-US", { weekday: "long" });
    const condition = current.condition || current.state || "—";
    const temp = current.temperature != null ? Math.round(current.temperature) : "—";
    const precipPct = hourly[0]?.precipitation_probability ?? 0;
    const humidity = current.humidity != null ? Math.round(current.humidity) : "—";
    const wind = this._formatWindSpeed(current.wind_speed, current.wind_speed_unit);

    const step = hourly.length >= 8 ? Math.floor(hourly.length / 8) : 1;
    const hourlySample = hourly.filter((_, i) => i % step === 0).slice(0, 8);
    const graphData = hourlySample.map((h) => ({
      time: this._formatTime(h.datetime),
      temp: h.temperature != null ? Math.round(h.temperature) : null,
      precip: h.precipitation_probability ?? 0,
      wind: h.wind_speed ?? 0,
    }));

    const graphPath = this._buildGraphPath(graphData, this._graphMode);
    const graphLabels = graphData.map((d) => {
      if (this._graphMode === "temperature") return d.temp != null ? String(d.temp) : "—";
      if (this._graphMode === "precipitation") return `${d.precip}%`;
      return d.wind != null ? String(Math.round(d.wind)) : "—";
    });

    return `
      <div class="weather-dashboard">
        <div class="current-section">
          <div class="current-left">
            <div class="current-icon">${this._getConditionIcon(condition)}</div>
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
            <h2 class="weather-title">Weather</h2>
            <div class="weather-day">${today}</div>
            <div class="weather-condition">${condition}</div>
          </div>
        </div>
        <div class="graph-section">
          <div class="graph-tabs">
            <button class="graph-tab ${this._graphMode === "temperature" ? "active" : ""}" data-graph="temperature">Temperature</button>
            <button class="graph-tab ${this._graphMode === "precipitation" ? "active" : ""}" data-graph="precipitation">Precipitation</button>
            <button class="graph-tab ${this._graphMode === "wind" ? "active" : ""}" data-graph="wind">Wind</button>
          </div>
          <div class="graph-container">
            <svg class="graph-svg" viewBox="0 0 400 120" preserveAspectRatio="none">
              <defs>
                <linearGradient id="graphGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#4285f4" stop-opacity="0.35"/>
                  <stop offset="100%" stop-color="#4285f4" stop-opacity="0"/>
                </linearGradient>
              </defs>
              <path class="graph-area" d="${graphPath.area}" fill="url(#graphGradient)"/>
              <path class="graph-line" d="${graphPath.line}" fill="none" stroke="#4285f4" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <div class="graph-labels">${graphLabels.map((l, i) => `<span class="graph-label" style="left:${(i / (graphLabels.length - 1 || 1)) * 100}%">${l}</span>`).join("")}</div>
            <div class="graph-times">${graphData.map((d, i) => `<span class="graph-time" style="left:${(i / (graphData.length - 1 || 1)) * 100}%">${d.time}</span>`).join("")}</div>
          </div>
        </div>
        <div class="daily-section">
          <div class="daily-scroll">
            ${daily.map((d, i) => `
              <div class="day-card ${i === 0 ? "current-day" : ""}">
                <div class="day-abbr">${this._formatDayShort(d.datetime)}</div>
                <div class="day-icon">${this._getConditionIcon(d.condition)}</div>
                <div class="day-temps">${d.temperature ?? "—"}° ${d.templow ?? "—"}°</div>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    `;
  }

  _buildGraphPath(data, mode) {
    if (!data.length) return { line: "", area: "" };
    const w = 400;
    const h = 100;
    const pad = 10;
    const values = data.map((d) => {
      if (mode === "temperature") return d.temp ?? 0;
      if (mode === "precipitation") return d.precip ?? 0;
      return d.wind ?? 0;
    });
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = Math.max(max - min, 1);
    const points = data.map((d, i) => {
      const x = pad + (i / (data.length - 1 || 1)) * (w - 2 * pad);
      const v = mode === "temperature" ? (d.temp ?? 0) : mode === "precipitation" ? (d.precip ?? 0) : (d.wind ?? 0);
      const y = h - pad - ((v - min) / range) * (h - 2 * pad);
      return [x, y];
    });
    const lineD = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0]} ${p[1]}`).join(" ");
    const areaD = lineD + ` L ${points[points.length - 1][0]} ${h - pad} L ${points[0][0]} ${h - pad} Z`;
    return { line: lineD, area: areaD };
  }

  _renderSettings() {
    const entities = Object.keys((this._hass && this._hass.states) || {});
    const weatherEntities = entities.filter((e) => e.startsWith("weather."));
    const canSave = !!this._settings.weather_entity;
    return `
      <div class="settings-form">
        <div class="form-group">
          <label>Weather Entity *</label>
          <select id="weather-entity">
            <option value="">Select weather entity</option>
            ${weatherEntities.map((e) => `<option value="${e}" ${this._settings.weather_entity === e ? "selected" : ""}>${e}</option>`).join("")}
          </select>
        </div>
        <div class="form-actions">
          <button class="btn btn-secondary" id="cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="save-btn" ${!canSave ? "disabled" : ""}>Save</button>
        </div>
      </div>
    `;
  }
}

customElements.define("home-weather-panel", HomeWeatherPanel);
