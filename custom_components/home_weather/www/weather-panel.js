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

  _getConditionIcon(condition, size) {
    const c = (condition || "").toLowerCase().replace(/\s+/g, "");
    const map = {
      sunny: "clear-day", clear: "clear-day", fair: "clear-day",
      partlycloudy: "cloudy-1-day", partly_cloudy: "cloudy-1-day",
      cloudy: "cloudy", overcast: "cloudy-2-day",
      fog: "fog", foggy: "fog", mist: "fog", hazy: "fog",
      rain: "rainy-1", rainy: "rainy-1", drizzle: "rainy-1", "rainy-1": "rainy-1", "rainy-2": "rainy-2",
      snow: "snowy-1", snowy: "snowy-1", flurries: "snowy-1", "snowy-1": "snowy-1", "snowy-2": "snowy-2",
      lightning: "thunderstorms", thunderstorm: "thunderstorms", thunderstorms: "thunderstorms",
      hail: "hail", sleet: "rain-and-sleet-mix",
    };
    let icon = map[c];
    if (!icon) {
      if (c.includes("rain")) icon = "rainy-1";
      else if (c.includes("snow")) icon = "snowy-1";
      else if (c.includes("cloud") || c.includes("overcast")) icon = "cloudy";
      else if (c.includes("thunder") || c.includes("lightning")) icon = "thunderstorms";
      else if (c.includes("fog") || c.includes("mist") || c.includes("haze")) icon = "fog";
      else icon = "cloudy-1-day";
    }
    const w = size === "large" ? 88 : 48;
    const h = size === "large" ? 72 : 40;
    return `<img src="/local/home_weather/icons/animated/${icon}.svg" alt="${condition || 'weather'}" width="${w}" height="${h}" class="weather-icon" loading="lazy"/>`;
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
        .main-nav { display: flex; gap: 8px; margin-bottom: 24px; }
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
        .form-group { display: flex; flex-direction: column; gap: 8px; }
        .form-group label { font-size: 14px; font-weight: 500; color: var(--primary-text-color); }
        .form-group input, .form-group select { padding: 12px 16px; border: 1px solid var(--divider-color); border-radius: 8px; background: var(--card-background-color); color: var(--primary-text-color); font-size: 14px; }
        .form-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px; }
        .btn { padding: 12px 32px; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; }
        .btn-primary { background: var(--primary-color); color: var(--primary-color-text); }
        .btn-secondary { background: var(--secondary-background-color); color: var(--primary-text-color); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .weather-dashboard { --accent-color: #4285f4; --hero-gradient: linear-gradient(135deg, #4285f4 0%, #34a853 50%, #fbbc04 100%); }
        .current-section { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 24px; margin-bottom: 20px; padding: 24px 28px; background: var(--card-background-color); border-radius: 16px; border: 1px solid var(--divider-color); box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
        .current-left { display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
        .current-icon { width: 88px; height: 72px; display: flex; align-items: center; justify-content: center; overflow: visible; }
        .current-icon .weather-icon { width: 88px; height: 72px; object-fit: contain; }
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
        .graph-section { margin-bottom: 20px; }
        .graph-tabs { display: flex; gap: 0; margin-bottom: 12px; border-bottom: 2px solid var(--divider-color); }
        .graph-tab { padding: 10px 20px; background: transparent; border: none; border-bottom: 3px solid transparent; margin-bottom: -2px; color: var(--secondary-text-color); cursor: pointer; font-size: 14px; font-weight: 500; }
        .graph-tab:hover { color: var(--primary-text-color); }
        .graph-tab.active { color: var(--accent-color); border-bottom-color: var(--accent-color); }
        .graph-container { position: relative; height: 120px; background: var(--card-background-color); border-radius: 12px; padding: 12px 12px 28px 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); border: 1px solid var(--divider-color); }
        .graph-svg { width: 100%; height: 80px; display: block; }
        .graph-axis-y { position: absolute; left: 8px; top: 12px; bottom: 28px; display: flex; flex-direction: column; justify-content: space-between; font-size: 10px; font-weight: 500; color: var(--secondary-text-color); }
        .graph-times { position: absolute; bottom: 6px; left: 40px; right: 8px; height: 20px; font-size: 10px; font-weight: 500; color: var(--secondary-text-color); }
        .graph-time { position: absolute; transform: translate(-50%, 0); }
        .daily-section { margin-bottom: 24px; overflow: visible; }
        .daily-scroll { display: flex; gap: 20px; overflow-x: auto; padding: 24px 8px; scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; }
        .day-card { flex: 0 0 110px; min-width: 110px; scroll-snap-align: start; padding: 20px 16px; background: var(--card-background-color); border-radius: 20px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.06); border: none; transition: all 0.25s ease; overflow: visible; }
        .day-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        .day-card.current-day { background: linear-gradient(180deg, rgba(66,133,244,0.12) 0%, rgba(66,133,244,0.04) 100%); box-shadow: 0 2px 12px rgba(66,133,244,0.2); }
        .day-icon { width: 56px; height: 48px; margin: 0 auto 10px; display: flex; align-items: center; justify-content: center; overflow: visible; }
        .day-abbr { font-size: 14px; font-weight: 600; color: var(--primary-text-color); margin-bottom: 8px; letter-spacing: -0.3px; }
        .day-icon .weather-icon { width: 56px; height: 48px; object-fit: contain; }
        .day-temps { font-size: 15px; color: var(--secondary-text-color); font-weight: 500; }
      </style>
      <div class="${this._isNarrow ? "narrow" : ""}">
        <div class="header">
          <button class="hamburger" id="hamburger-btn" aria-label="Open Home Assistant sidebar">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
          </button>
          <h1>Home Weather</h1>
        </div>
        <div class="main-nav nav-tabs">
          <button class="nav-tab ${this._currentView === "forecast" ? "active" : ""}" data-view="forecast">Forecast</button>
          <button class="nav-tab ${this._currentView === "settings" ? "active" : ""}" data-view="settings">Settings</button>
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
    const daily = (this._weatherData.daily_forecast || []).slice(0, 7);
    const now = new Date();
    const todayLabel = now.toLocaleDateString("en-US", { weekday: "long" });
    const dateStr = now.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" });
    const condition = current.condition || current.state || "—";
    const temp = current.temperature != null ? Math.round(current.temperature) : "—";
    const precipPct = hourly[0]?.precipitation_probability ?? 0;
    const humidity = current.humidity != null ? Math.round(current.humidity) : "—";
    const wind = this._formatWindSpeed(current.wind_speed, current.wind_speed_unit);

    const graphData = hourly.slice(0, 24).map((h) => ({
      time: this._formatTime(h.datetime),
      temp: h.temperature != null ? Math.round(h.temperature) : null,
      precip: h.precipitation_probability ?? 0,
      wind: h.wind_speed ?? 0,
    }));

    const values = graphData.map((d) => {
      if (this._graphMode === "temperature") return d.temp ?? 0;
      if (this._graphMode === "precipitation") return d.precip ?? 0;
      return d.wind ?? 0;
    });
    const graphAxis = {
      min: values.length ? Math.floor(Math.min(...values)) : 0,
      max: values.length ? Math.ceil(Math.max(...values)) : 0,
      suffix: this._graphMode === "precipitation" ? "%" : this._graphMode === "wind" ? " mph" : "°",
    };
    if (this._graphMode === "precipitation") {
      graphAxis.max = Math.max(20, Math.min(100, graphAxis.max));
      graphAxis.min = 0;
    }
    const graphPath = this._buildGraphPath(graphData, this._graphMode, graphAxis);
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
            <div class="current-icon">${this._getConditionIcon(condition, "large")}</div>
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
            <div class="weather-day">${todayLabel}, ${dateStr}</div>
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
            <svg class="graph-svg" viewBox="0 0 600 80" preserveAspectRatio="xMidYMid meet">
              <defs>
                <linearGradient id="graphGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#4285f4" stop-opacity="0.25"/>
                  <stop offset="100%" stop-color="#4285f4" stop-opacity="0"/>
                </linearGradient>
              </defs>
              <line x1="24" y1="8" x2="24" y2="72" stroke="var(--divider-color)" stroke-width="1" opacity="0.5"/>
              <line x1="24" y1="72" x2="576" y2="72" stroke="var(--divider-color)" stroke-width="1" opacity="0.5"/>
              <path class="graph-area" d="${graphPath.area}" fill="url(#graphGradient)"/>
              <path class="graph-line" d="${graphPath.line}" fill="none" stroke="#4285f4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <div class="graph-axis-y">
              <span class="axis-max">${graphAxis.max}${graphAxis.suffix}</span>
              <span class="axis-min">${graphAxis.min}${graphAxis.suffix}</span>
            </div>
            <div class="graph-times">${graphTimeLabels.map((t) => `<span class="graph-time" style="left:${t.pct}%">${t.label}</span>`).join("")}</div>
          </div>
        </div>
        <div class="daily-section">
          <div class="daily-scroll">
            ${daily.map((d, i) => `
              <div class="day-card ${i === 0 ? "current-day" : ""}">
                <div class="day-icon">${this._getConditionIcon(d.condition)}</div>
                <div class="day-abbr">${this._formatDayShort(d.datetime)}</div>
                <div class="day-temps">${d.temperature ?? "—"}° / ${d.templow ?? "—"}°</div>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    `;
  }

  _buildGraphPath(data, mode, axis) {
    if (!data.length) return { line: "", area: "" };
    const w = 600;
    const h = 80;
    const padX = 24;
    const padY = 8;
    const values = data.map((d) => {
      if (mode === "temperature") return d.temp ?? 0;
      if (mode === "precipitation") return d.precip ?? 0;
      return d.wind ?? 0;
    });
    const min = axis ? axis.min : Math.min(...values);
    const max = axis ? axis.max : Math.max(...values);
    const range = Math.max(max - min, 1);
    const points = data.map((d, i) => {
      const x = padX + (i / (data.length - 1 || 1)) * (w - 2 * padX);
      const v = mode === "temperature" ? (d.temp ?? 0) : mode === "precipitation" ? (d.precip ?? 0) : (d.wind ?? 0);
      const y = h - padY - ((v - min) / range) * (h - 2 * padY);
      return [x, y];
    });
    const smoothPath = this._smoothPath(points);
    const baseY = h - padY;
    const areaD = smoothPath + ` L ${points[points.length - 1][0]} ${baseY} L ${points[0][0]} ${baseY} Z`;
    return { line: smoothPath, area: areaD };
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
