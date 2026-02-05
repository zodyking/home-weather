import { LitElement, html, css } from "lit";
import { property, state } from "lit/decorators.js";

class HomeWeatherPanel extends LitElement {
  @property({ attribute: false }) hass;
  @property({ type: Boolean }) narrow = false;
  @property({ attribute: false }) route;
  @property({ attribute: false }) panel;

  @state() _config = null;
  @state() _loading = true;
  @state() _error = null;
  @state() _currentView = "forecast"; // "forecast" or "settings"
  @state() _forecastView = "24h"; // "24h" or "7d"
  @state() _weatherData = null;
  @state() _settings = {};

  static styles = css`
    :host {
      display: block;
      padding: 16px;
      max-width: 1200px;
      margin: 0 auto;
    }

    .loading,
    .error {
      text-align: center;
      padding: 48px 16px;
      color: var(--secondary-text-color);
    }

    .error {
      color: var(--error-color);
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--divider-color);
    }

    .header h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 400;
      color: var(--primary-text-color);
    }

    .nav-tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 24px;
    }

    .nav-tab {
      padding: 12px 24px;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--secondary-text-color);
      cursor: pointer;
      font-size: 16px;
      transition: all 0.2s;
    }

    .nav-tab:hover {
      color: var(--primary-text-color);
    }

    .nav-tab.active {
      color: var(--primary-color);
      border-bottom-color: var(--primary-color);
    }

    .view-toggle {
      display: flex;
      gap: 8px;
      margin-bottom: 24px;
    }

    .view-toggle button {
      padding: 8px 16px;
      background: var(--card-background-color);
      border: 1px solid var(--divider-color);
      border-radius: 4px;
      color: var(--primary-text-color);
      cursor: pointer;
      transition: all 0.2s;
    }

    .view-toggle button.active {
      background: var(--primary-color);
      color: var(--primary-color-text);
      border-color: var(--primary-color);
    }

    .forecast-container {
      display: grid;
      gap: 16px;
    }

    .hourly-forecast {
      display: flex;
      gap: 12px;
      overflow-x: auto;
      padding: 16px 0;
      scrollbar-width: thin;
    }

    .hourly-forecast::-webkit-scrollbar {
      height: 8px;
    }

    .hourly-forecast::-webkit-scrollbar-thumb {
      background: var(--divider-color);
      border-radius: 4px;
    }

    .hour-card {
      min-width: 120px;
      padding: 20px 16px;
      background: var(--card-background-color);
      border-radius: 12px;
      text-align: center;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      transition: transform 0.2s, box-shadow 0.2s;
      border: 1px solid var(--divider-color);
    }

    .hour-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 12px rgba(0, 0, 0, 0.15);
    }

    .hour-card.current {
      border: 2px solid var(--primary-color);
      background: linear-gradient(135deg, var(--primary-color) 0%, var(--accent-color, var(--primary-color)) 100%);
      color: var(--primary-color-text);
      box-shadow: 0 6px 16px rgba(var(--rgb-primary-color, 33, 150, 243), 0.4);
    }

    .hour-time {
      font-size: 14px;
      color: var(--secondary-text-color);
      margin-bottom: 8px;
    }

    .hour-card.current .hour-time {
      color: var(--primary-color-text);
    }

    .hour-temp {
      font-size: 28px;
      font-weight: 600;
      margin: 12px 0;
      line-height: 1.2;
    }

    .hour-condition {
      font-size: 13px;
      color: var(--secondary-text-color);
      margin-top: 12px;
      text-transform: capitalize;
      font-weight: 500;
    }

    .hour-card.current .hour-condition {
      color: var(--primary-color-text);
    }

    .hour-precip {
      font-size: 11px;
      color: var(--info-color);
      margin-top: 4px;
    }

    .daily-forecast {
      display: grid;
      gap: 12px;
    }

    .day-card {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px;
      background: var(--card-background-color);
      border-radius: 12px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      transition: transform 0.2s, box-shadow 0.2s;
      border: 1px solid var(--divider-color);
    }

    .day-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 12px rgba(0, 0, 0, 0.15);
    }

    .day-info {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .day-name {
      font-size: 16px;
      font-weight: 500;
      min-width: 100px;
    }

    .day-temps {
      display: flex;
      gap: 16px;
      align-items: center;
    }

    .day-high {
      font-size: 20px;
      font-weight: 500;
    }

    .day-low {
      font-size: 16px;
      color: var(--secondary-text-color);
    }

    .day-precip {
      font-size: 14px;
      color: var(--info-color);
      margin-left: auto;
    }

    .settings-form {
      display: grid;
      gap: 24px;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .form-group label {
      font-size: 14px;
      font-weight: 500;
      color: var(--primary-text-color);
    }

    .form-group input,
    .form-group select {
      padding: 12px 16px;
      border: 1px solid var(--divider-color);
      border-radius: 8px;
      background: var(--card-background-color);
      color: var(--primary-text-color);
      font-size: 14px;
      transition: border-color 0.2s, box-shadow 0.2s;
    }

    .form-group input:focus,
    .form-group select:focus {
      outline: none;
      border-color: var(--primary-color);
      box-shadow: 0 0 0 2px rgba(var(--rgb-primary-color, 33, 150, 243), 0.2);
    }

    .form-group input[type="checkbox"] {
      width: auto;
    }

    .form-actions {
      display: flex;
      gap: 12px;
      justify-content: flex-end;
      margin-top: 24px;
    }

    .btn {
      padding: 12px 32px;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    }

    .btn-primary {
      background: var(--primary-color);
      color: var(--primary-color-text);
    }

    .btn-primary:hover:not(:disabled) {
      opacity: 0.9;
      transform: translateY(-1px);
      box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
    }

    .btn-primary:active:not(:disabled) {
      transform: translateY(0);
    }

    .btn-secondary {
      background: var(--secondary-background-color);
      color: var(--primary-text-color);
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    @media (max-width: 768px) {
      :host {
        padding: 8px;
      }

      .hour-card {
        min-width: 100px;
        padding: 12px;
      }

      .day-card {
        flex-direction: column;
        align-items: flex-start;
      }
    }
  `;

  async firstUpdated() {
    await this._loadConfig();
    await this._checkConfiguration();
    await this._loadWeatherData();
    
    // Refresh weather data every 5 minutes
    setInterval(() => {
      this._loadWeatherData();
    }, 5 * 60 * 1000);
  }

  async _loadConfig() {
    try {
      this._loading = true;
      const response = await this.hass.callWS({
        type: "home_weather/get_config",
      });
      this._config = response.config;
      this._settings = { ...this._config };
    } catch (error) {
      console.error("Error loading config:", error);
      this._error = "Failed to load configuration";
    } finally {
      this._loading = false;
    }
  }

  async _checkConfiguration() {
    if (!this._config || !this._config.weather_entity || !this._config.tts_engine || !this._config.media_players || this._config.media_players.length === 0) {
      this._currentView = "settings";
    }
  }

  async _loadWeatherData() {
    if (!this._config || !this._config.weather_entity) {
      return;
    }

    try {
      const response = await this.hass.callWS({
        type: "home_weather/get_weather",
      });
      this._weatherData = response.data;
    } catch (error) {
      console.error("Error loading weather data:", error);
      this._error = "Failed to load weather data";
    }
  }

  async _saveSettings() {
    try {
      this._loading = true;
      await this.hass.callWS({
        type: "home_weather/set_config",
        config: this._settings,
      });
      this._config = { ...this._settings };
      this._currentView = "forecast";
      await this._loadWeatherData();
      // Reload page to restart automation
      window.location.reload();
    } catch (error) {
      console.error("Error saving settings:", error);
      this._error = "Failed to save settings";
    } finally {
      this._loading = false;
    }
  }

  _formatTime(datetime) {
    if (!datetime) return "";
    const date = new Date(datetime);
    return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }

  _formatDay(datetime) {
    if (!datetime) return "";
    const date = new Date(datetime);
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    if (date.toDateString() === today.toDateString()) {
      return "Today";
    } else if (date.toDateString() === tomorrow.toDateString()) {
      return "Tomorrow";
    } else {
      return date.toLocaleDateString("en-US", { weekday: "long" });
    }
  }

  _getWeatherIcon(condition) {
    if (!condition) return "mdi:weather-cloudy";
    const conditionLower = condition.toLowerCase();
    if (conditionLower.includes("sun") || conditionLower.includes("clear")) {
      return "mdi:weather-sunny";
    } else if (conditionLower.includes("cloud")) {
      return "mdi:weather-cloudy";
    } else if (conditionLower.includes("rain")) {
      return "mdi:weather-rainy";
    } else if (conditionLower.includes("snow")) {
      return "mdi:weather-snowy";
    } else if (conditionLower.includes("fog") || conditionLower.includes("mist")) {
      return "mdi:weather-fog";
    }
    return "mdi:weather-cloudy";
  }

  render() {
    if (this._loading && !this._config) {
      return html`<div class="loading">Loading...</div>`;
    }

    if (this._error && !this._config) {
      return html`<div class="error">${this._error}</div>`;
    }

    return html`
      <div class="header">
        <h1>Home Weather</h1>
      </div>

      <div class="nav-tabs">
        <button
          class="nav-tab ${this._currentView === "forecast" ? "active" : ""}"
          @click=${() => {
            if (this._config && this._config.weather_entity) {
              this._currentView = "forecast";
            }
          }}
        >
          Forecast
        </button>
        <button
          class="nav-tab ${this._currentView === "settings" ? "active" : ""}"
          @click=${() => (this._currentView = "settings")}
        >
          Settings
        </button>
      </div>

      ${this._currentView === "forecast" ? this._renderForecast() : this._renderSettings()}
    `;
  }

  _renderForecast() {
    if (!this._weatherData || !this._weatherData.configured) {
      return html`<div class="error">Weather data not available. Please configure the integration in Settings.</div>`;
    }

    const current = this._weatherData.current || {};
    const hourly = this._weatherData.hourly_forecast || [];
    const daily = this._weatherData.daily_forecast || [];

    return html`
      <div class="view-toggle">
        <button
          class="${this._forecastView === "24h" ? "active" : ""}"
          @click=${() => (this._forecastView = "24h")}
        >
          24 Hour
        </button>
        <button
          class="${this._forecastView === "7d" ? "active" : ""}"
          @click=${() => (this._forecastView = "7d")}
        >
          7 Day
        </button>
      </div>

      ${this._forecastView === "24h"
        ? html`
            <div class="forecast-container">
              <div class="hourly-forecast">
                ${hourly.map(
                  (hour, index) => html`
                    <div class="hour-card ${index === 0 ? "current" : ""}">
                      <div class="hour-time">${this._formatTime(hour.datetime)}</div>
                      <div class="hour-temp">${hour.temperature}°</div>
                      <div class="hour-condition">${hour.condition || "N/A"}</div>
                      ${hour.precipitation_probability > 0
                        ? html`<div class="hour-precip">${hour.precipitation_probability}%</div>`
                        : ""}
                    </div>
                  `
                )}
              </div>
            </div>
          `
        : html`
            <div class="forecast-container">
              <div class="daily-forecast">
                ${daily.map(
                  (day) => html`
                    <div class="day-card">
                      <div class="day-info">
                        <div class="day-name">${this._formatDay(day.datetime)}</div>
                        <div class="day-temps">
                          <div class="day-high">${day.temperature}°</div>
                          <div class="day-low">${day.templow}°</div>
                        </div>
                      </div>
                      ${day.precipitation_probability > 0
                        ? html`<div class="day-precip">${day.precipitation_probability}%</div>`
                        : ""}
                    </div>
                  `
                )}
              </div>
            </div>
          `}
    `;
  }

  _renderSettings() {
    const entities = Object.keys(this.hass.states || {});
    const weatherEntities = entities.filter((e) => e.startsWith("weather."));
    const ttsEngines = entities.filter((e) => e.startsWith("tts."));
    const mediaPlayers = entities.filter((e) => e.startsWith("media_player."));

    return html`
      <div class="settings-form">
        <div class="form-group">
          <label>Weather Entity *</label>
          <select
            .value=${this._settings.weather_entity || ""}
            @change=${(e) => (this._settings.weather_entity = e.target.value)}
          >
            <option value="">Select weather entity</option>
            ${weatherEntities.map(
              (entity) => html`<option value="${entity}">${entity}</option>`
            )}
          </select>
        </div>

        <div class="form-group">
          <label>TTS Engine *</label>
          <select
            .value=${this._settings.tts_engine || ""}
            @change=${(e) => (this._settings.tts_engine = e.target.value)}
          >
            <option value="">Select TTS engine</option>
            ${ttsEngines.map((entity) => html`<option value="${entity}">${entity}</option>`)}
          </select>
        </div>

        <div class="form-group">
          <label>Media Players *</label>
          <select
            multiple
            .value=${this._settings.media_players || []}
            @change=${(e) => {
              this._settings.media_players = Array.from(e.target.selectedOptions, (opt) => opt.value);
            }}
          >
            ${mediaPlayers.map((entity) => html`<option value="${entity}">${entity}</option>`)}
          </select>
          <small>Hold Ctrl/Cmd to select multiple</small>
        </div>

        <div class="form-group">
          <label>Volume Level</label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.1"
            .value=${this._settings.volume_level || 0.7}
            @input=${(e) => (this._settings.volume_level = parseFloat(e.target.value))}
          />
          <small>${(this._settings.volume_level || 0.7) * 100}%</small>
        </div>

        <div class="form-actions">
          <button class="btn btn-secondary" @click=${() => (this._settings = { ...this._config })}>
            Cancel
          </button>
          <button
            class="btn btn-primary"
            ?disabled=${!this._settings.weather_entity ||
            !this._settings.tts_engine ||
            !this._settings.media_players ||
            this._settings.media_players.length === 0}
            @click=${this._saveSettings}
          >
            Save
          </button>
        </div>
      </div>
    `;
  }
}

customElements.define("home-weather-panel", HomeWeatherPanel);
