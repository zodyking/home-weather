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
    this._webhookInfo = {};  // { webhook_id: { url, last_triggered } }
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
      this._settings.media_players = this._normalizeMediaPlayers(this._settings.media_players);
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

  async _loadWebhookInfo() {
    if (!this._hass) return;
    try {
      const r = await this._hass.callWS({ type: "home_weather/get_webhook_info" });
      this._webhookInfo = {};
      (r.webhooks || []).forEach((w) => {
        this._webhookInfo[w.webhook_id] = {
          url: w.url || "",
          url_internal: w.url_internal || "",
          url_external: w.url_external || "",
          last_triggered: w.last_triggered,
        };
      });
      this._render();
    } catch (e) {
      console.error("Failed to load webhook info:", e);
      this._webhookInfo = {};
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
      // Collect weather entity
      const weatherEntity = s.getElementById("weather-entity");
      if (weatherEntity) this._settings.weather_entity = weatherEntity.value || null;
      
      // Collect all TTS settings using helper
      this._settings.tts = this._collectTtsSettings();
      
      // Collect message prefix
      const messagePrefix = s.getElementById("message-prefix");
      if (messagePrefix) this._settings.message_prefix = messagePrefix.value || "Weather update";
      
      // Collect media players from cards (exclude webhook cards)
      const cards = s.querySelectorAll("#media-player-list .media-player-card");
      if (cards.length) {
        this._settings.media_players = Array.from(cards).map((card) => {
          const entitySel = card.querySelector(".media-player-select");
          const ttsSel = card.querySelector(".media-player-tts-entity");
          const volumeSlider = card.querySelector(".media-player-volume");
          const cacheChk = card.querySelector(".media-player-cache");
          const langInput = card.querySelector(".media-player-language");
          const optionsInput = card.querySelector(".media-player-options");
          let options = {};
          if (optionsInput?.value) {
            try { options = JSON.parse(optionsInput.value); } catch (_) {}
          }
          return {
            entity_id: entitySel?.value || "",
            tts_entity_id: ttsSel?.value || "",
            volume: parseFloat(volumeSlider?.value || 0.6),
            cache: !!cacheChk?.checked,
            language: (langInput?.value || "").trim(),
            options,
          };
        }).filter((m) => m.entity_id);
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

  _normalizeMediaPlayers(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map((item) => {
      if (typeof item === "string") {
        return { entity_id: item, tts_entity_id: "", volume: 0.6, cache: false, language: "", options: {} };
      }
      return {
        entity_id: item.entity_id || "",
        tts_entity_id: item.tts_entity_id || "",
        volume: item.volume ?? 0.6,
        cache: !!item.cache,
        language: item.language || "",
        options: item.options || {},
      };
    }).filter((m) => m.entity_id);
  }

  _syncMediaPlayerFromCard(index) {
    const s = this.shadowRoot;
    if (!s) return;
    const cards = s.querySelectorAll(".media-player-card");
    const card = cards[index];
    if (!card) return;
    const list = [...(this._settings.media_players || [])];
    if (!list[index]) return;
    const entitySel = card.querySelector(".media-player-select");
    const ttsSel = card.querySelector(".media-player-tts-entity");
    const volumeSlider = card.querySelector(".media-player-volume");
    const cacheChk = card.querySelector(".media-player-cache");
    const langInput = card.querySelector(".media-player-language");
    const optionsInput = card.querySelector(".media-player-options");
    
    // Parse options JSON safely
    let options = {};
    if (optionsInput?.value) {
      try {
        options = JSON.parse(optionsInput.value);
      } catch (e) {
        // Keep existing options if parse fails
        options = list[index]?.options || {};
      }
    }
    
    list[index] = {
      entity_id: entitySel?.value || "",
      tts_entity_id: ttsSel?.value || "",
      volume: parseFloat(volumeSlider?.value || 0.6),
      cache: cacheChk?.checked || false,
      language: langInput?.value || "",
      options: options,
    };
    this._settings.media_players = list;
  }

  _syncSensorTriggerFromCard(index) {
    const s = this.shadowRoot;
    if (!s) return;
    const cards = s.querySelectorAll(".sensor-trigger-card");
    const card = cards[index];
    if (!card) return;
    if (!this._settings.tts) this._settings.tts = {};
    if (!Array.isArray(this._settings.tts.sensor_triggers)) this._settings.tts.sensor_triggers = [];
    const list = [...this._settings.tts.sensor_triggers];
    if (!list[index]) list[index] = {};
    const entitySel = card.querySelector(".sensor-trigger-entity");
    const stateInput = card.querySelector(".sensor-trigger-state");
    list[index] = {
      entity_id: entitySel?.value || "",
      trigger_state: stateInput?.value || "on",
    };
    this._settings.tts.sensor_triggers = list;
  }

  _syncWebhookFromCard(index) {
    const s = this.shadowRoot;
    if (!s) return;
    const cards = s.querySelectorAll(".webhook-card");
    const card = cards[index];
    if (!card) return;
    if (!this._settings.tts) this._settings.tts = {};
    if (!Array.isArray(this._settings.tts.webhooks)) this._settings.tts.webhooks = [];
    const list = [...this._settings.tts.webhooks];
    if (!list[index]) list[index] = {};
    const webhookIdInput = card.querySelector(".webhook-id");
    const nameInput = card.querySelector(".webhook-name");
    const enabledChk = card.querySelector(".webhook-enabled");
    list[index] = {
      webhook_id: webhookIdInput?.value || "",
      personal_name: nameInput?.value || "",
      enabled: enabledChk?.checked !== false,
    };
    this._settings.tts.webhooks = list;
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
        .media-player-list { display: flex; flex-direction: column; gap: 16px; }
        .media-player-item { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: var(--card-background-color); border: 1px solid var(--divider-color); border-radius: 8px; }
        .media-player-item select { flex: 1; }
        .media-player-card { padding: 20px; background: var(--card-background-color); border: 1px solid var(--divider-color); border-radius: 12px; display: flex; flex-direction: column; gap: 14px; }
        .media-player-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
        .media-player-label { font-size: 13px; font-weight: 500; color: var(--secondary-text-color); min-width: 140px; }
        .media-player-controls { display: flex; gap: 8px; flex: 1; min-width: 0; }
        .media-player-controls select { flex: 1; min-width: 0; }
        .media-player-tts-entity, .media-player-language { flex: 1; min-width: 200px; padding: 10px 14px; border: 1px solid var(--divider-color); border-radius: 8px; background: var(--card-background-color); color: var(--primary-text-color); font-size: 14px; }
        .toggle-switch { position: relative; display: inline-block; width: 44px; height: 24px; }
        .toggle-switch input { opacity: 0; width: 0; height: 0; }
        .toggle-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background: var(--secondary-background-color); border-radius: 24px; transition: 0.3s; border: 1px solid var(--divider-color); }
        .toggle-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 2px; bottom: 2px; background: var(--primary-text-color); border-radius: 50%; transition: 0.3s; }
        .toggle-switch input:checked + .toggle-slider { background: var(--accent-color); border-color: var(--accent-color); }
        .toggle-switch input:checked + .toggle-slider:before { transform: translateX(20px); background: white; }
        .toggle-label { font-size: 13px; color: var(--secondary-text-color); margin-left: 8px; }
        .collapsible-section { background: var(--card-background-color); border: 1px solid var(--divider-color); border-radius: 12px; margin-bottom: 16px; overflow: hidden; }
        .collapsible-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; cursor: pointer; user-select: none; transition: background 0.2s; }
        .collapsible-header:hover { background: var(--secondary-background-color); }
        .collapsible-header-left { display: flex; align-items: center; gap: 12px; }
        .collapsible-title { font-size: 15px; font-weight: 600; color: var(--primary-text-color); }
        .collapsible-subtitle { font-size: 12px; color: var(--secondary-text-color); margin-top: 2px; }
        .collapsible-chevron { width: 20px; height: 20px; color: var(--secondary-text-color); transition: transform 0.2s; }
        .collapsible-section.open .collapsible-chevron { transform: rotate(180deg); }
        .collapsible-content { padding: 0 20px 20px; display: none; }
        .collapsible-section.open .collapsible-content { display: block; }
        .range-slider { display: flex; align-items: center; gap: 12px; width: 100%; }
        .range-slider input[type="range"] { flex: 1; height: 6px; border-radius: 3px; background: var(--secondary-background-color); appearance: none; -webkit-appearance: none; cursor: pointer; }
        .range-slider input[type="range"]::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%; background: var(--accent-color); cursor: pointer; box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
        .range-slider input[type="range"]::-moz-range-thumb { width: 18px; height: 18px; border-radius: 50%; background: var(--accent-color); cursor: pointer; border: none; }
        .range-value { min-width: 48px; text-align: right; font-size: 14px; font-weight: 600; color: var(--primary-text-color); }
        .checkbox-group { display: flex; flex-wrap: wrap; gap: 12px; }
        .checkbox-item { display: flex; align-items: center; gap: 6px; padding: 8px 12px; background: var(--secondary-background-color); border-radius: 8px; cursor: pointer; transition: all 0.2s; }
        .checkbox-item:hover { filter: brightness(1.05); }
        .checkbox-item.checked { background: var(--accent-color); color: white; }
        .checkbox-item input { display: none; }
        .time-input-group { display: flex; align-items: center; gap: 8px; }
        .time-input-group input[type="time"] { padding: 10px 14px; border: 1px solid var(--divider-color); border-radius: 8px; background: var(--card-background-color); color: var(--primary-text-color); font-size: 14px; }
        .test-tts-btn { padding: 8px 16px; background: var(--accent-color); color: white; border: none; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.2s; }
        .test-tts-btn:hover { filter: brightness(1.1); }
        .multi-select { display: flex; flex-direction: column; gap: 8px; max-height: 200px; overflow-y: auto; padding: 12px; background: var(--secondary-background-color); border-radius: 8px; }
        .multi-select-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--card-background-color); border-radius: 6px; cursor: pointer; transition: all 0.2s; }
        .multi-select-item:hover { background: var(--divider-color); }
        .multi-select-item.selected { background: var(--accent-color); color: white; }
        .multi-select-item input { display: none; }
        .textarea-field { width: 100%; min-height: 100px; padding: 12px; border: 1px solid var(--divider-color); border-radius: 8px; background: var(--card-background-color); color: var(--primary-text-color); font-size: 14px; font-family: inherit; resize: vertical; }
        .inline-toggle { display: flex; align-items: center; gap: 12px; padding: 12px 0; }
        .inline-toggle-label { flex: 1; font-size: 14px; color: var(--primary-text-color); }
        .settings-section-divider { border: none; border-top: 1px solid var(--divider-color); margin: 20px 0; }
        .form-hint { font-size: 12px; color: var(--secondary-text-color); margin-bottom: 16px; }
        .webhook-status-row { display: flex; align-items: center; gap: 10px; }
        .webhook-status-dot { width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0; }
        .webhook-status-dot.idle { background: #e53935; }
        .webhook-status-dot.triggered { background: #43a047; }
        .webhook-status-label { font-size: 13px; font-weight: 500; color: var(--primary-text-color); }
        .webhook-timestamp { font-size: 12px; color: var(--secondary-text-color); margin-left: auto; }
        .webhook-url-display { flex: 1; font-size: 12px; padding: 8px 12px; background: var(--secondary-background-color); border-radius: 6px; color: var(--primary-text-color); cursor: text; }
        .form-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px; }
        .btn { padding: 12px 32px; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; }
        .btn-primary { background: var(--primary-color); color: var(--primary-color-text); }
        .btn-secondary { background: var(--secondary-background-color); color: var(--primary-text-color); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        /* Bento Grid Dashboard */
        .weather-dashboard { --accent-color: #4285f4; --card-radius: 20px; --gap: 16px; }
        .bento-grid { display: grid; grid-template-columns: 2fr 1fr; gap: var(--gap); margin-bottom: var(--gap); }
        @media (max-width: 900px) { .bento-grid { grid-template-columns: 1fr; } }
        .bento-card { background: var(--card-background-color); border-radius: var(--card-radius); border: 1px solid var(--divider-color); padding: 24px; }
        
        /* Hero Card */
        .hero-card { display: flex; flex-direction: column; gap: 16px; background: linear-gradient(145deg, rgba(66,133,244,0.08) 0%, var(--card-background-color) 100%); }
        .hero-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
        .hero-main { display: flex; align-items: center; gap: 20px; }
        .hero-icon { width: 100px; height: 100px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .hero-icon .weather-icon { width: 100%; height: 100%; object-fit: contain; filter: drop-shadow(0 4px 12px rgba(0,0,0,0.1)); }
        .hero-temp-block { display: flex; flex-direction: column; }
        .hero-temp { font-size: 72px; font-weight: 300; line-height: 1; color: var(--primary-text-color); letter-spacing: -2px; }
        .hero-hilo { font-size: 14px; color: var(--secondary-text-color); margin-top: 4px; }
        .hero-hilo span { margin-right: 12px; }
        .hero-condition { font-size: 20px; font-weight: 500; color: var(--primary-text-color); text-transform: capitalize; }
        .hero-wind-row { display: flex; gap: 16px; font-size: 14px; color: var(--secondary-text-color); }
        .hero-wind-row span { display: flex; align-items: center; gap: 6px; }
        .hero-wind-row img { width: 18px; height: 18px; opacity: 0.85; }
        .hero-datetime { text-align: right; }
        .hero-time { font-size: 28px; font-weight: 600; color: var(--primary-text-color); }
        .hero-date { font-size: 14px; color: var(--secondary-text-color); margin-top: 4px; }
        @media (min-width: 901px) {
          .hero-card { align-items: center; text-align: center; }
          .hero-top { flex-direction: column; align-items: center; width: 100%; }
          .hero-main { flex-direction: column; align-items: center; }
          .hero-icon { width: 180px; height: 180px; }
          .hero-temp { font-size: 96px; }
          .hero-hilo { justify-content: center; }
          .hero-condition { font-size: 24px; }
          .hero-wind-row { justify-content: center; }
          .hero-datetime { text-align: center; }
        }
        
        /* Highlights Grid */
        .highlights-card { display: flex; flex-direction: column; }
        .highlights-title { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--secondary-text-color); margin-bottom: 16px; }
        .highlights-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; flex: 1; }
        .highlight-item { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 16px 12px; background: var(--secondary-background-color); border-radius: 12px; text-align: center; min-height: 90px; }
        .highlight-icon { width: 28px; height: 28px; margin-bottom: 8px; opacity: 0.8; }
        .highlight-value { font-size: 18px; font-weight: 600; color: var(--primary-text-color); }
        .highlight-label { font-size: 11px; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: 0.3px; margin-top: 4px; }
        
        /* Forecast Strip */
        .forecast-row { display: grid; grid-template-columns: 1fr auto; gap: var(--gap); margin-bottom: var(--gap); }
        @media (max-width: 900px) { .forecast-row { grid-template-columns: 1fr; } }
        .forecast-card-container { background: var(--card-background-color); border-radius: var(--card-radius); border: 1px solid var(--divider-color); padding: 20px; overflow: hidden; }
        .forecast-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
        .forecast-title { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--secondary-text-color); }
        .forecast-tabs { display: flex; gap: 8px; }
        .forecast-tab { padding: 6px 14px; background: transparent; border: 1px solid var(--divider-color); border-radius: 6px; color: var(--secondary-text-color); cursor: pointer; font-size: 12px; font-weight: 500; transition: all 0.2s; }
        .forecast-tab:hover { border-color: var(--primary-text-color); color: var(--primary-text-color); }
        .forecast-tab.active { background: var(--accent-color); color: white; border-color: var(--accent-color); }
        .forecast-scroll { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 8px; scrollbar-width: thin; }
        .forecast-scroll::-webkit-scrollbar { height: 4px; }
        .forecast-scroll::-webkit-scrollbar-thumb { background: var(--divider-color); border-radius: 2px; }
        .forecast-item { flex: 0 0 auto; min-width: 80px; padding: 14px 12px; background: var(--secondary-background-color); border-radius: 12px; text-align: center; transition: all 0.2s; }
        .forecast-item:hover { transform: translateY(-2px); }
        .forecast-item.current { background: linear-gradient(180deg, rgba(66,133,244,0.15) 0%, rgba(66,133,244,0.05) 100%); }
        .forecast-item-day { font-size: 12px; font-weight: 600; color: var(--primary-text-color); margin-bottom: 8px; }
        .forecast-item-icon { width: 36px; height: 36px; margin: 0 auto 8px; }
        .forecast-item-icon .weather-icon { width: 100%; height: 100%; }
        .forecast-item-temp { font-size: 14px; font-weight: 600; color: var(--primary-text-color); }
        .forecast-item-low { font-size: 12px; color: var(--secondary-text-color); }
        .forecast-item-precip { font-size: 10px; color: var(--info-color, #1e88e5); margin-top: 4px; }
        
        /* Moon Phase */
        .moon-card { display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 160px; background: var(--card-background-color); border-radius: var(--card-radius); border: 1px solid var(--divider-color); padding: 24px; }
        .moon-title { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--secondary-text-color); margin-bottom: 12px; }
        .moon-icon { width: 80px; height: 80px; margin-bottom: 12px; }
        .moon-icon img { width: 100%; height: 100%; object-fit: contain; filter: drop-shadow(0 2px 8px rgba(0,0,0,0.15)); }
        .moon-name { font-size: 14px; font-weight: 600; color: var(--primary-text-color); text-align: center; }
        .moon-details { font-size: 11px; color: var(--secondary-text-color); margin-top: 4px; text-align: center; }
        
        /* Chart Section */
        .chart-card { background: var(--card-background-color); border-radius: var(--card-radius); border: 1px solid var(--divider-color); padding: 20px; }
        .chart-title { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--secondary-text-color); margin-bottom: 16px; }
        .chart-container { min-height: 280px; }
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
    if (settingsBtn) settingsBtn.addEventListener("click", () => {
      this._currentView = "settings";
      this._render();
      this._loadWebhookInfo();
    });
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
    
    // Settings tabs
    s.querySelectorAll(".settings-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._settingsTab = btn.dataset.settingsTab || "weather";
        this._render();
      });
    });
    
    // Weather entity
    const we = s.getElementById("weather-entity");
    if (we) we.addEventListener("change", (e) => { this._settings.weather_entity = e.target.value || null; });
    
    // Collapsible sections
    s.querySelectorAll(".collapsible-header").forEach((header) => {
      header.addEventListener("click", (e) => {
        // Don't toggle if clicking on the toggle switch inside header
        if (e.target.closest(".toggle-switch")) return;
        const section = header.closest(".collapsible-section");
        const sectionId = section?.dataset?.sectionId;
        if (sectionId) {
          if (this._expandedSections.has(sectionId)) {
            this._expandedSections.delete(sectionId);
          } else {
            this._expandedSections.add(sectionId);
          }
          section.classList.toggle("open");
        }
      });
    });
    
    // Range sliders - update display value
    s.querySelectorAll('input[type="range"]').forEach((slider) => {
      slider.addEventListener("input", () => {
        const valueDisplay = slider.nextElementSibling;
        if (valueDisplay && valueDisplay.classList.contains("range-value")) {
          const val = parseFloat(slider.value);
          valueDisplay.textContent = Math.round(val * 100) + "%";
        }
      });
    });
    
    // Days of week checkboxes - prevent double toggle from label behavior
    s.querySelectorAll("#days-of-week .checkbox-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        e.preventDefault();
        item.classList.toggle("checked");
        const checkbox = item.querySelector("input");
        if (checkbox) checkbox.checked = item.classList.contains("checked");
      });
    });
    
    // Multi-select items (presence sensors) - prevent double toggle from label behavior
    s.querySelectorAll(".multi-select-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        e.preventDefault();
        item.classList.toggle("selected");
        const checkbox = item.querySelector("input");
        if (checkbox) checkbox.checked = item.classList.contains("selected");
      });
    });
    
    // Media player remove buttons
    s.querySelectorAll("[data-remove-media]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.removeMedia, 10);
        const list = [...(this._settings.media_players || [])];
        list.splice(idx, 1);
        this._settings.media_players = list;
        this._render();
      });
    });
    
    // Sensor trigger card handlers
    s.querySelectorAll(".sensor-trigger-card").forEach((card) => {
      const idx = parseInt(card.dataset.sensorIdx, 10);
      const entitySelect = card.querySelector(".sensor-trigger-entity");
      const stateInput = card.querySelector(".sensor-trigger-state");
      
      if (entitySelect) {
        entitySelect.addEventListener("change", () => {
          this._syncSensorTriggerFromCard(idx);
        });
      }
      if (stateInput) {
        stateInput.addEventListener("input", () => {
          this._syncSensorTriggerFromCard(idx);
        });
      }
    });
    
    // Sensor trigger remove buttons
    s.querySelectorAll("[data-remove-sensor]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.removeSensor, 10);
        if (!this._settings.tts) this._settings.tts = {};
        const list = [...(this._settings.tts.sensor_triggers || [])];
        list.splice(idx, 1);
        this._settings.tts.sensor_triggers = list;
        this._render();
      });
    });
    
    // Add sensor trigger
    const addSensorBtn = s.getElementById("add-sensor-trigger");
    if (addSensorBtn) {
      addSensorBtn.addEventListener("click", () => {
        if (!this._settings.tts) this._settings.tts = {};
        if (!Array.isArray(this._settings.tts.sensor_triggers)) this._settings.tts.sensor_triggers = [];
        this._settings.tts.sensor_triggers.push({ entity_id: "", trigger_state: "on" });
        this._render();
      });
    }
    
    // Webhook card handlers
    s.querySelectorAll(".webhook-card").forEach((card) => {
      const idx = parseInt(card.dataset.webhookIdx, 10);
      const webhookIdInput = card.querySelector(".webhook-id");
      const nameInput = card.querySelector(".webhook-name");
      const enabledChk = card.querySelector(".webhook-enabled");
      
      if (webhookIdInput) {
        webhookIdInput.addEventListener("input", () => this._syncWebhookFromCard(idx));
      }
      if (nameInput) {
        nameInput.addEventListener("input", () => this._syncWebhookFromCard(idx));
      }
      if (enabledChk) {
        enabledChk.addEventListener("change", () => this._syncWebhookFromCard(idx));
      }
    });
    
    // Webhook remove buttons
    s.querySelectorAll("[data-remove-webhook]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.removeWebhook, 10);
        if (!this._settings.tts) this._settings.tts = {};
        const list = [...(this._settings.tts.webhooks || [])];
        list.splice(idx, 1);
        this._settings.tts.webhooks = list;
        this._render();
      });
    });
    
    // Add webhook
    const addWebhookBtn = s.getElementById("add-webhook");
    if (addWebhookBtn) {
      addWebhookBtn.addEventListener("click", () => {
        if (!this._settings.tts) this._settings.tts = {};
        if (!Array.isArray(this._settings.tts.webhooks)) this._settings.tts.webhooks = [];
        this._settings.tts.webhooks.push({ webhook_id: "", personal_name: "", enabled: true });
        this._render();
      });
    }
    
    // Media player card sync handlers
    s.querySelectorAll(".media-player-card").forEach((card, i) => {
      card.querySelectorAll(".media-player-select, .media-player-tts-entity, .media-player-language, .media-player-options").forEach((el) => {
        el.addEventListener("change", () => this._syncMediaPlayerFromCard(i));
        el.addEventListener("input", () => this._syncMediaPlayerFromCard(i));
      });
      card.querySelectorAll(".media-player-cache").forEach((el) => {
        el.addEventListener("change", () => this._syncMediaPlayerFromCard(i));
      });
      // Volume slider
      card.querySelectorAll(".media-player-volume").forEach((slider) => {
        slider.addEventListener("input", () => {
          this._syncMediaPlayerFromCard(i);
          const valueDisplay = slider.nextElementSibling;
          if (valueDisplay) valueDisplay.textContent = Math.round(parseFloat(slider.value) * 100) + "%";
        });
      });
    });
    
    // Test TTS buttons
    s.querySelectorAll("[data-test-media]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const idx = parseInt(btn.dataset.testMedia, 10);
        const mediaPlayers = this._settings.media_players || [];
        const mp = mediaPlayers[idx];
        if (!mp || !mp.entity_id) return;
        
        const ttsEntity = mp.tts_entity_id || this._settings.tts?.engine;
        if (!ttsEntity) {
          alert("Please select a TTS entity first.");
          return;
        }
        
        btn.textContent = "Testing...";
        btn.disabled = true;
        
        try {
          await this._hass.callWS({
            type: "home_weather/test_tts",
            media_player_entity_id: mp.entity_id,
            tts_entity_id: ttsEntity,
            message: "This is a test of the weather announcement system.",
            volume: mp.volume || 0.6,
            cache: mp.cache || false,
            language: mp.language || "",
          });
        } catch (e) {
          console.error("Test TTS failed:", e);
          alert("Test TTS failed: " + e.message);
        } finally {
          btn.textContent = "Test TTS";
          btn.disabled = false;
        }
      });
    });
    
    // Add media player
    const addMediaBtn = s.getElementById("add-media-btn");
    const addMediaSelect = s.getElementById("media-player-add");
    if (addMediaBtn && addMediaSelect) {
      addMediaBtn.addEventListener("click", () => {
        const val = addMediaSelect.value;
        if (!val) return;
        const list = [...(this._settings.media_players || [])];
        list.push({ entity_id: val, tts_entity_id: "", volume: 0.6, cache: false, language: "", options: {} });
        this._settings.media_players = list;
        this._render();
      });
    }
    
    // Save and Cancel
    const saveBtn = s.getElementById("save-btn");
    const cancelBtn = s.getElementById("cancel-btn");
    if (saveBtn) saveBtn.addEventListener("click", () => this._saveSettings());
    if (cancelBtn) cancelBtn.addEventListener("click", () => {
      this._settings = JSON.parse(JSON.stringify(this._config || {}));
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
    const condition = current.condition || current.state || "—";
    const temp = (current.temperature ?? h0.temperature) != null ? Math.round(current.temperature ?? h0.temperature) : "—";
    const windUnit = (current.wind_speed_unit || "mph").toLowerCase();
    const pressureUnit = (current.pressure_unit || "inHg").toLowerCase();
    const precipUnit = (current.precipitation_unit || "in").toLowerCase();

    // Hi/Lo from today's daily forecast
    const todayDaily = daily[0] || {};
    const hiTemp = todayDaily.temperature != null ? Math.round(todayDaily.temperature) : null;
    const loTemp = todayDaily.templow != null ? Math.round(todayDaily.templow) : null;

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
    const humidity = (current.humidity ?? h0.humidity) != null ? Math.round(current.humidity ?? h0.humidity) : null;
    const precipChance = (h0.precipitation_probability ?? 0);
    const windSpeed = (current.wind_speed ?? h0.wind_speed);
    const windGusts = (current.wind_gust_speed ?? h0.wind_gust_speed);
    const pressure = (current.pressure ?? h0.pressure);
    const uvIndex = (current.uv_index ?? h0.uv_index);
    const cloudCover = (current.cloud_coverage ?? h0.cloud_coverage);

    // Highlights for the grid (6 items in 2x3 grid)
    const highlights = [
      { icon: "thermometer-warmer.svg", label: "Feels Like", value: feelsLike != null ? `${feelsLike}°` : "—" },
      { icon: "humidity.svg", label: "Humidity", value: humidity != null ? `${humidity}%` : "—" },
      { icon: "wind.svg", label: "Wind", value: windSpeed != null ? `${Math.round(windSpeed)} ${windUnit}` : "—" },
      { icon: "raindrop.svg", label: "Precip", value: `${Math.round(precipChance)}%` },
      { icon: "uv-index.svg", label: "UV Index", value: uvIndex != null ? String(uvIndex) : "—" },
      { icon: "barometer.svg", label: "Pressure", value: pressure != null ? `${pressure} ${pressureUnit}` : "—" },
    ];

    // Moon phase
    const moon = this._getMoonPhase(now);

    // Time formatting
    const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const dateStr = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

    return `
      <div class="weather-dashboard">
        <!-- Top Row: Hero + Highlights -->
        <div class="bento-grid">
          <div class="bento-card hero-card">
            <div class="hero-top">
              <div class="hero-main">
                <div class="hero-icon">${this._getConditionIcon(condition, "large", now)}</div>
                <div class="hero-temp-block">
                  <div class="hero-temp">${temp}°</div>
                  <div class="hero-hilo">
                    ${hiTemp != null ? `<span>H: ${hiTemp}°</span>` : ""}
                    ${loTemp != null ? `<span>L: ${loTemp}°</span>` : ""}
                  </div>
                </div>
              </div>
              <div class="hero-datetime">
                <div class="hero-time">${timeStr}</div>
                <div class="hero-date">${dateStr}</div>
              </div>
            </div>
            <div class="hero-condition">${this._getConditionLabel(condition, now)}</div>
            <div class="hero-wind-row">
              ${windSpeed != null ? `<span><img src="/local/home_weather/icons/wind.svg" alt=""/>Wind: ${Math.round(windSpeed)} ${windUnit}</span>` : ""}
              ${windGusts != null ? `<span><img src="/local/home_weather/icons/windsock.svg" alt=""/>Gusts: ${Math.round(windGusts)} ${windUnit}</span>` : ""}
            </div>
          </div>
          <div class="bento-card highlights-card">
            <div class="highlights-title">Today's Highlights</div>
            <div class="highlights-grid">
              ${highlights.map((h) => `
                <div class="highlight-item">
                  <img src="/local/home_weather/icons/${h.icon}" alt="" class="highlight-icon" loading="lazy"/>
                  <div class="highlight-value">${h.value}</div>
                  <div class="highlight-label">${h.label}</div>
                </div>
              `).join("")}
            </div>
          </div>
        </div>

        <!-- Second Row: Forecast + Moon -->
        <div class="forecast-row">
          <div class="forecast-card-container">
            <div class="forecast-header">
              <div class="forecast-title">Forecast</div>
              <div class="forecast-tabs">
                <button class="forecast-tab ${this._forecastView === "7day" ? "active" : ""}" data-view="7day">7 Day</button>
                <button class="forecast-tab ${this._forecastView === "24h" ? "active" : ""}" data-view="24h">24 Hour</button>
              </div>
            </div>
            <div class="forecast-scroll">
              ${this._forecastView === "24h"
                ? hourly.slice(0, 24).map((h, i) => {
                    const hTemp = h.temperature != null ? Math.round(h.temperature) : "—";
                    const precipVal = this._formatPrecip(h.precipitation_probability);
                    const timeLabel = i === 0 ? "Now" : this._formatTime(h.datetime);
                    return `
                      <div class="forecast-item ${i === 0 ? "current" : ""}">
                        <div class="forecast-item-day">${timeLabel}</div>
                        <div class="forecast-item-icon">${this._getConditionIcon(h.condition, null, h.datetime)}</div>
                        <div class="forecast-item-temp">${hTemp}°</div>
                        <div class="forecast-item-precip">${precipVal}</div>
                      </div>
                    `;
                  }).join("")
                : daily.map((d, i) => {
                    const dHi = d.temperature != null ? Math.round(d.temperature) : "—";
                    const dLo = d.templow != null ? Math.round(d.templow) : "—";
                    const precipVal = this._formatPrecip(d.precipitation_probability);
                    const dayLabel = this._formatDayLabel(d.datetime);
                    return `
                      <div class="forecast-item ${i === 0 ? "current" : ""}">
                        <div class="forecast-item-day">${dayLabel}</div>
                        <div class="forecast-item-icon">${this._getConditionIcon(d.condition, null, null, true)}</div>
                        <div class="forecast-item-temp">${dHi}°</div>
                        <div class="forecast-item-low">${dLo}°</div>
                        <div class="forecast-item-precip">${precipVal}</div>
                      </div>
                    `;
                  }).join("")
              }
            </div>
          </div>
          <div class="moon-card">
            <div class="moon-title">Moon Phase</div>
            <div class="moon-icon">
              <img src="/local/home_weather/icons/Moon%20Phase/${moon.icon}.svg" alt="${moon.name}" loading="lazy"/>
            </div>
            <div class="moon-name">${moon.name}</div>
            <div class="moon-details">${moon.illumination}% illuminated</div>
          </div>
        </div>

        <!-- Third Row: Chart -->
        <div class="chart-card">
          <div class="chart-title">24-Hour Overview</div>
          <div class="chart-container" id="apex-chart-combined"></div>
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
      chart: { type: "area", height: 320, toolbar: { show: false }, zoom: { enabled: false }, fontFamily: "inherit", background: "transparent" },
      dataLabels: { enabled: false },
      stroke: { curve: "smooth", width: 4 },
      fill: { type: "gradient", gradient: { opacityFrom: 0.25, opacityTo: 0.05 } },
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
        chart: { ...baseOpts.chart, type: "line", height: 280 },
        colors: ["#ef5350", "#ff8a65", "#ba68c8", "#42a5f5", "#4db6ac", "#64b5f6", "#b0bec5", "#90a4ae", "#a1887f", "#78909c", "#ffb74d"],
        stroke: { curve: "smooth", width: 4 },
        series,
        yaxis: [{ min: 0, max: 100, labels: { formatter: (v) => String(Math.round(v)) }, axisBorder: { show: false }, axisTicks: { show: false }, labels: { style: { colors: "#94a3b8", fontSize: "12px" } } }],
        title: { text: "", align: "left", style: { fontSize: "14px", fontWeight: 600 } },
        tooltip: { shared: true, intersect: false, custom: tooltip },
        legend: { show: true, position: "top", horizontalAlign: "center", fontSize: "11px" },
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
    const ttsEntities = entities.filter((e) => e.startsWith("tts."));
    const binarySensorEntities = entities.filter((e) => e.startsWith("binary_sensor."));
    const aiTaskEntities = entities.filter((e) => e.startsWith("ai_task."));
    
    // Initialize TTS settings with defaults
    const defaultTts = {
      enabled: false, engine: "", voice: "", volume_level: 0.6, preroll_ms: 150,
      cache: true, language: "", enable_time_based: false, hour_pattern: 3,
      minute_offset: 3, start_time: "08:00", end_time: "21:00",
      days_of_week: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      enable_sensor_triggered: false, sensor_triggers: [],
      enable_current_change: false,
      enable_upcoming_change: false, minutes_before_announce: 30,
      enable_webhook: false, webhooks: [],
      enable_voice_satellite: false, conversation_commands: "What is the weather\nWhats the weather",
      precip_threshold: 30, hours_ahead: 24, hourly_segments_count: 3,
      wind_speed_threshold: 15, wind_gust_threshold: 20, daily_forecast_days: 3,
      use_ai_rewrite: false, ai_task_entity: "",
      ai_rewrite_prompt: "You are a friendly meteorologist. Rewrite this weather forecast in a natural, conversational way.",
    };
    const tts = { ...defaultTts, ...(this._settings.tts || {}) };
    // Ensure arrays
    if (!Array.isArray(tts.sensor_triggers)) tts.sensor_triggers = [];
    if (!Array.isArray(tts.webhooks)) tts.webhooks = [];
    const mediaPlayers = this._normalizeMediaPlayers(this._settings.media_players || []);
    const usedMediaPlayerIds = new Set(mediaPlayers.map((m) => m.entity_id));
    const availableMediaPlayers = mediaPlayerEntities.filter((e) => !usedMediaPlayerIds.has(e));
    const messagePrefix = this._settings.message_prefix || "Weather update";
    
    // Track expanded sections
    if (!this._expandedSections) this._expandedSections = new Set(["general-tts"]);

    const chevronSvg = `<svg class="collapsible-chevron" viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>`;
    
    const renderToggle = (id, checked, label) => `
      <div class="inline-toggle">
        <span class="inline-toggle-label">${label}</span>
        <label class="toggle-switch">
          <input type="checkbox" id="${id}" ${checked ? "checked" : ""}/>
          <span class="toggle-slider"></span>
        </label>
      </div>
    `;
    
    const renderSlider = (id, value, min, max, step, suffix = "%") => `
      <div class="range-slider">
        <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}"/>
        <span class="range-value" data-for="${id}">${Math.round(value * (suffix === "%" ? 100 : 1))}${suffix}</span>
      </div>
    `;
    
    const renderCollapsible = (id, title, subtitle, content, hasToggle = false, toggleId = "", toggleChecked = false) => `
      <div class="collapsible-section ${this._expandedSections.has(id) ? "open" : ""}" data-section-id="${id}">
        <div class="collapsible-header">
          <div class="collapsible-header-left">
            ${hasToggle ? `
              <label class="toggle-switch" style="margin-right: 8px;">
                <input type="checkbox" id="${toggleId}" ${toggleChecked ? "checked" : ""}/>
                <span class="toggle-slider"></span>
              </label>
            ` : ""}
            <div>
              <div class="collapsible-title">${title}</div>
              ${subtitle ? `<div class="collapsible-subtitle">${subtitle}</div>` : ""}
            </div>
          </div>
          ${chevronSvg}
        </div>
        <div class="collapsible-content">
          ${content}
        </div>
      </div>
    `;

    const daysOfWeek = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const dayLabels = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

    return `
      <div class="settings-form">
        <div class="settings-tabs">
          <button class="settings-tab ${this._settingsTab === "weather" ? "active" : ""}" data-settings-tab="weather">Weather</button>
          <button class="settings-tab ${this._settingsTab === "tts" ? "active" : ""}" data-settings-tab="tts">TTS Settings</button>
        </div>
        
        <!-- Weather Tab -->
        <div class="settings-section ${this._settingsTab === "weather" ? "active" : ""}" data-section="weather">
          <div class="form-group">
            <label>Weather Entity *</label>
            <select id="weather-entity">
              <option value="">Select weather entity</option>
              ${weatherEntities.map((e) => `<option value="${e}" ${this._settings.weather_entity === e ? "selected" : ""}>${e}</option>`).join("")}
            </select>
          </div>
        </div>
        
        <!-- TTS Tab -->
        <div class="settings-section ${this._settingsTab === "tts" ? "active" : ""}" data-section="tts">
          
          <!-- General TTS Settings -->
          ${renderCollapsible("general-tts", "General TTS Settings", "TTS engine, volume, and global options", `
            ${renderToggle("tts-enabled", tts.enabled, "Enable TTS Announcements")}
            
            <div class="form-group" style="margin-top: 16px;">
              <label>TTS Engine</label>
              <select id="tts-engine">
                <option value="">Select TTS entity</option>
                ${ttsEntities.map((e) => `<option value="${e}" ${tts.engine === e ? "selected" : ""}>${e}</option>`).join("")}
              </select>
            </div>
            
            <div class="form-group">
              <label>Preroll Delay (ms)</label>
              <input type="number" id="tts-preroll" min="0" max="2000" step="50" value="${tts.preroll_ms}"/>
            </div>
            
            ${renderToggle("tts-cache", tts.cache, "Cache TTS Audio")}
            
            <div class="form-group" style="margin-top: 16px;">
              <label>Language</label>
              <input type="text" id="tts-language" placeholder="e.g. en, en-US" value="${tts.language || ""}"/>
            </div>
            
            <div class="form-group">
              <label>Message Prefix</label>
              <input type="text" id="message-prefix" placeholder="e.g. Weather update" value="${messagePrefix}"/>
            </div>
          `)}
          
          <!-- Media Players -->
          ${renderCollapsible("media-players", "Media Players", `${mediaPlayers.length} configured`, `
            <p class="form-hint">Configure TTS settings for each media player.</p>
            <div class="media-player-list" id="media-player-list">
              ${mediaPlayers.map((m, i) => `
                <div class="media-player-card" data-index="${i}">
                  <div class="media-player-row">
                    <label class="media-player-label">Media Player</label>
                    <div class="media-player-controls">
                      <select class="media-player-select" data-field="entity_id">
                        ${mediaPlayerEntities.map((e) => `<option value="${e}" ${e === m.entity_id ? "selected" : ""}>${e}</option>`).join("")}
                      </select>
                      <button type="button" class="btn btn-secondary btn-icon" data-remove-media="${i}" aria-label="Remove">−</button>
                    </div>
                  </div>
                  <div class="media-player-row">
                    <label class="media-player-label">TTS Entity</label>
                    <select class="media-player-tts-entity" data-field="tts_entity_id">
                      <option value="">Use default</option>
                      ${ttsEntities.map((e) => `<option value="${e}" ${e === m.tts_entity_id ? "selected" : ""}>${e}</option>`).join("")}
                    </select>
                  </div>
                  <div class="media-player-row">
                    <label class="media-player-label">Volume</label>
                    <div class="range-slider" style="flex:1">
                      <input type="range" class="media-player-volume" data-field="volume" min="0" max="1" step="0.05" value="${m.volume || 0.6}"/>
                      <span class="range-value">${Math.round((m.volume || 0.6) * 100)}%</span>
                    </div>
                  </div>
                  <div class="media-player-row">
                    <label class="media-player-label">Cache</label>
                    <label class="toggle-switch">
                      <input type="checkbox" class="media-player-cache" data-field="cache" ${m.cache ? "checked" : ""}/>
                      <span class="toggle-slider"></span>
                    </label>
                  </div>
                  <div class="media-player-row">
                    <label class="media-player-label">Language</label>
                    <input type="text" class="media-player-language" data-field="language" placeholder="Override language" value="${m.language || ""}"/>
                  </div>
                  <div class="media-player-row">
                    <label class="media-player-label">Options (JSON)</label>
                    <input type="text" class="media-player-options" data-field="options" placeholder='{"key": "value"}' value='${JSON.stringify(m.options || {}).replace(/'/g, "&#39;")}'/>
                  </div>
                  <div class="media-player-row">
                    <button type="button" class="test-tts-btn" data-test-media="${i}">Test TTS</button>
                  </div>
                </div>
              `).join("")}
            </div>
            <div class="form-row" style="margin-top: 12px;">
              <select id="media-player-add">
                <option value="">Add media player...</option>
                ${availableMediaPlayers.map((e) => `<option value="${e}">${e}</option>`).join("")}
              </select>
              <button type="button" class="btn btn-secondary" id="add-media-btn">Add</button>
            </div>
          `)}
          
          <!-- Time-Based Forecasts -->
          ${renderCollapsible("time-based", "Time-Based Forecasts", "Scheduled announcements", `
            ${renderToggle("enable-time-based", tts.enable_time_based, "Enable Scheduled Forecasts")}
            
            <div class="form-group" style="margin-top: 16px;">
              <label>Announce Every</label>
              <select id="hour-pattern">
                <option value="1" ${tts.hour_pattern === 1 ? "selected" : ""}>1 hour</option>
                <option value="2" ${tts.hour_pattern === 2 ? "selected" : ""}>2 hours</option>
                <option value="3" ${tts.hour_pattern === 3 ? "selected" : ""}>3 hours</option>
                <option value="4" ${tts.hour_pattern === 4 ? "selected" : ""}>4 hours</option>
                <option value="6" ${tts.hour_pattern === 6 ? "selected" : ""}>6 hours</option>
                <option value="12" ${tts.hour_pattern === 12 ? "selected" : ""}>12 hours</option>
              </select>
            </div>
            
            <div class="form-group">
              <label>Minute Offset (0-59)</label>
              <input type="number" id="minute-offset" min="0" max="59" value="${tts.minute_offset}"/>
            </div>
            
            <div class="form-group">
              <label>Active Hours</label>
              <div class="time-input-group">
                <input type="time" id="start-time" value="${tts.start_time}"/>
                <span>to</span>
                <input type="time" id="end-time" value="${tts.end_time}"/>
              </div>
            </div>
            
            <div class="form-group">
              <label>Active Days</label>
              <div class="checkbox-group" id="days-of-week">
                ${daysOfWeek.map((d) => `
                  <label class="checkbox-item ${tts.days_of_week.includes(d) ? "checked" : ""}" data-day="${d}">
                    <input type="checkbox" ${tts.days_of_week.includes(d) ? "checked" : ""}/>
                    ${dayLabels[d]}
                  </label>
                `).join("")}
              </div>
            </div>
          `)}
          
          <!-- Current Change Alerts -->
          ${renderCollapsible("current-change", "Current Change Alerts", "Alert when weather changes", `
            ${renderToggle("enable-current-change", tts.enable_current_change, "Enable Current Change Alerts")}
            <p class="form-hint" style="margin-top: 12px;">Volume is controlled per media player.</p>
          `)}
          
          <!-- Upcoming Change Alerts -->
          ${renderCollapsible("upcoming-change", "Upcoming Change Alerts", "Alert before precipitation", `
            ${renderToggle("enable-upcoming-change", tts.enable_upcoming_change, "Enable Upcoming Change Alerts")}
            
            <div class="form-group" style="margin-top: 16px;">
              <label>Minutes Before to Announce</label>
              <select id="minutes-before-announce">
                <option value="15" ${tts.minutes_before_announce === 15 ? "selected" : ""}>15 minutes</option>
                <option value="30" ${tts.minutes_before_announce === 30 ? "selected" : ""}>30 minutes</option>
                <option value="45" ${tts.minutes_before_announce === 45 ? "selected" : ""}>45 minutes</option>
                <option value="60" ${tts.minutes_before_announce === 60 ? "selected" : ""}>1 hour</option>
              </select>
            </div>
          `)}
          
          <!-- Sensor Triggered -->
          ${renderCollapsible("sensor-triggered", "Sensor Triggered", "Announce when entity state changes", `
            ${renderToggle("enable-sensor-triggered", tts.enable_sensor_triggered, "Enable Sensor-Triggered Forecasts")}
            
            <div class="form-group" style="margin-top: 16px;">
              <label>Sensor Triggers</label>
              <p class="form-hint">Add entities and define the state that triggers a TTS announcement.</p>
              <div id="sensor-triggers-list" class="media-player-list">
                ${tts.sensor_triggers.map((st, i) => `
                  <div class="media-player-card sensor-trigger-card" data-sensor-idx="${i}">
                    <div class="media-player-row">
                      <span class="media-player-label">Entity</span>
                      <select class="sensor-trigger-entity media-player-controls" data-idx="${i}">
                        <option value="">-- Select Entity --</option>
                        ${entities.slice(0, 500).map((e) => `<option value="${e}" ${e === st.entity_id ? "selected" : ""}>${e}</option>`).join("")}
                      </select>
                    </div>
                    <div class="media-player-row">
                      <span class="media-player-label">Trigger State</span>
                      <input type="text" class="sensor-trigger-state media-player-tts-entity" data-idx="${i}" placeholder="e.g. on, home, open" value="${st.trigger_state || ""}"/>
                    </div>
                    <div class="media-player-row" style="justify-content: flex-end;">
                      <button class="btn btn-secondary" data-remove-sensor="${i}">Remove</button>
                    </div>
                  </div>
                `).join("")}
              </div>
              <button class="btn btn-secondary" id="add-sensor-trigger" style="margin-top: 12px;">+ Add Sensor Trigger</button>
            </div>
          `)}
          
          <!-- Webhook -->
          ${renderCollapsible("webhook", "Webhook Triggers", `${tts.webhooks.length} configured`, `
            ${renderToggle("enable-webhook", tts.enable_webhook, "Enable Webhook Triggers")}
            
            <div class="form-group" style="margin-top: 16px;">
              <label>Webhook Configurations</label>
              <p class="form-hint">Create multiple webhooks with unique IDs for different users or scenarios.</p>
              <div id="webhooks-list" class="media-player-list">
                ${tts.webhooks.map((wh, i) => {
                  const info = this._webhookInfo[wh.webhook_id] || {};
                  const urlInt = info.url_internal || "";
                  const urlExt = info.url_external || "";
                  const hasUrls = wh.webhook_id && (urlInt || urlExt);
                  const lastTrig = info.last_triggered;
                  const hasTriggered = !!lastTrig;
                  const triggerTime = lastTrig ? (() => {
                    try {
                      const d = new Date(lastTrig);
                      return d.toLocaleString();
                    } catch (_) { return lastTrig; }
                  })() : "";
                  return `
                  <div class="media-player-card webhook-card" data-webhook-idx="${i}">
                    <div class="media-player-row">
                      <span class="media-player-label">Webhook ID</span>
                      <input type="text" class="webhook-id media-player-tts-entity" data-idx="${i}" placeholder="e.g. weather_morning" value="${wh.webhook_id || ""}"/>
                    </div>
                    ${wh.webhook_id ? `
                    <div class="media-player-row webhook-status-row">
                      <span class="webhook-status-dot ${hasTriggered ? "triggered" : "idle"}"></span>
                      <span class="webhook-status-label">${hasTriggered ? "Triggered" : "Idle"}</span>
                      ${triggerTime ? `<span class="webhook-timestamp">${triggerTime}</span>` : ""}
                    </div>
                    <p class="form-hint" style="margin: 8px 0 4px;">Either URL triggers TTS when called.</p>
                    ${urlInt ? `
                    <div class="media-player-row">
                      <label class="media-player-label">Internal URL</label>
                      <input type="text" class="webhook-url-display" readonly value="${urlInt}" onclick="this.select()" title="Click to select"/>
                    </div>
                    ` : ""}
                    ${urlExt ? `
                    <div class="media-player-row">
                      <label class="media-player-label">External URL</label>
                      <input type="text" class="webhook-url-display" readonly value="${urlExt}" onclick="this.select()" title="Click to select"/>
                    </div>
                    ` : ""}
                    ${!urlInt && !urlExt && wh.webhook_id ? `
                    <div class="media-player-row">
                      <label class="media-player-label">Webhook URL</label>
                      <input type="text" class="webhook-url-display" readonly value="Save to generate URLs" title="Save settings first"/>
                    </div>
                    ` : ""}
                    <div class="media-player-row">
                      <span class="media-player-label">Personal Name</span>
                      <input type="text" class="webhook-name media-player-tts-entity" data-idx="${i}" placeholder="e.g. John" value="${wh.personal_name || ""}"/>
                    </div>
                    <div class="media-player-row">
                      <span class="media-player-label">Enabled</span>
                      <label class="toggle-switch">
                        <input type="checkbox" class="webhook-enabled" data-idx="${i}" ${wh.enabled !== false ? "checked" : ""}/>
                        <span class="toggle-slider"></span>
                      </label>
                    </div>
                    <div class="media-player-row" style="justify-content: flex-end;">
                      <button class="btn btn-secondary" data-remove-webhook="${i}">Remove</button>
                    </div>
                  </div>
                `;
                }).join("")}
              </div>
              <button class="btn btn-secondary" id="add-webhook" style="margin-top: 12px;">+ Add Webhook</button>
            </div>
          `)}
          
          <!-- Voice Satellite -->
          ${renderCollapsible("voice-satellite", "Voice Satellite", "Conversation commands", `
            ${renderToggle("enable-voice-satellite", tts.enable_voice_satellite, "Enable Voice Commands")}
            
            <div class="form-group" style="margin-top: 16px;">
              <label>Conversation Commands (one per line)</label>
              <textarea class="textarea-field" id="conversation-commands" placeholder="What is the weather&#10;Whats the weather">${tts.conversation_commands}</textarea>
            </div>
          `)}
          
          <!-- Forecast Settings -->
          ${renderCollapsible("forecast-settings", "Forecast Settings", "Thresholds and limits", `
            <div class="form-group">
              <label>Precipitation Threshold (%)</label>
              <input type="number" id="precip-threshold" min="0" max="100" value="${tts.precip_threshold}"/>
            </div>
            
            <div class="form-group">
              <label>Hours Ahead to Check</label>
              <input type="number" id="hours-ahead" min="1" max="48" value="${tts.hours_ahead}"/>
            </div>
            
            <div class="form-group">
              <label>Hourly Segments to Announce</label>
              <input type="number" id="hourly-segments-count" min="0" max="8" value="${tts.hourly_segments_count}"/>
            </div>
            
            <div class="form-group">
              <label>Wind Speed Threshold (for mention)</label>
              <input type="number" id="wind-speed-threshold" min="0" max="100" value="${tts.wind_speed_threshold}"/>
            </div>
            
            <div class="form-group">
              <label>Wind Gust Threshold (for mention)</label>
              <input type="number" id="wind-gust-threshold" min="0" max="100" value="${tts.wind_gust_threshold}"/>
            </div>
            
            <div class="form-group">
              <label>Daily Forecast Days</label>
              <input type="number" id="daily-forecast-days" min="0" max="7" value="${tts.daily_forecast_days}"/>
            </div>
          `)}
          
          <!-- AI Rewrite -->
          ${renderCollapsible("ai-rewrite", "AI Rewrite", "Optionally rewrite messages with AI", `
            ${renderToggle("use-ai-rewrite", tts.use_ai_rewrite, "Enable AI Message Rewriting")}
            
            <div class="form-group" style="margin-top: 16px;">
              <label>AI Task Entity</label>
              <select id="ai-task-entity">
                <option value="">Select AI task entity</option>
                ${aiTaskEntities.map((e) => `<option value="${e}" ${tts.ai_task_entity === e ? "selected" : ""}>${e}</option>`).join("")}
              </select>
            </div>
            
            <div class="form-group">
              <label>AI Rewrite Prompt</label>
              <textarea class="textarea-field" id="ai-rewrite-prompt">${tts.ai_rewrite_prompt}</textarea>
            </div>
          `)}
          
        </div>
        
        <div class="form-actions">
          <button class="btn btn-secondary" id="cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="save-btn">Save</button>
        </div>
      </div>
    `;
  }

  _collectTtsSettings() {
    const s = this.shadowRoot;
    if (!s) return {};
    
    // Collect days of week
    const daysOfWeek = [];
    s.querySelectorAll("#days-of-week .checkbox-item.checked").forEach((el) => {
      const day = el.dataset.day;
      if (day) daysOfWeek.push(day);
    });
    
    // Collect sensor triggers and webhooks from settings state (already synced via card handlers)
    const sensorTriggers = this._settings.tts?.sensor_triggers || [];
    const webhooks = this._settings.tts?.webhooks || [];
    
    return {
      enabled: s.getElementById("tts-enabled")?.checked || false,
      engine: s.getElementById("tts-engine")?.value || "",
      preroll_ms: parseInt(s.getElementById("tts-preroll")?.value || 150, 10),
      cache: s.getElementById("tts-cache")?.checked || false,
      language: s.getElementById("tts-language")?.value || "",
      enable_time_based: s.getElementById("enable-time-based")?.checked || false,
      hour_pattern: parseInt(s.getElementById("hour-pattern")?.value || 3, 10),
      minute_offset: parseInt(s.getElementById("minute-offset")?.value || 3, 10),
      start_time: s.getElementById("start-time")?.value || "08:00",
      end_time: s.getElementById("end-time")?.value || "21:00",
      days_of_week: daysOfWeek.length > 0 ? daysOfWeek : ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      enable_sensor_triggered: s.getElementById("enable-sensor-triggered")?.checked || false,
      sensor_triggers: sensorTriggers.filter((t) => t.entity_id),
      enable_current_change: s.getElementById("enable-current-change")?.checked || false,
      enable_upcoming_change: s.getElementById("enable-upcoming-change")?.checked || false,
      minutes_before_announce: parseInt(s.getElementById("minutes-before-announce")?.value || 30, 10),
      enable_webhook: s.getElementById("enable-webhook")?.checked || false,
      webhooks: webhooks.filter((w) => w.webhook_id),
      enable_voice_satellite: s.getElementById("enable-voice-satellite")?.checked || false,
      conversation_commands: s.getElementById("conversation-commands")?.value || "",
      precip_threshold: parseInt(s.getElementById("precip-threshold")?.value || 30, 10),
      hours_ahead: parseInt(s.getElementById("hours-ahead")?.value || 24, 10),
      hourly_segments_count: parseInt(s.getElementById("hourly-segments-count")?.value || 3, 10),
      wind_speed_threshold: parseInt(s.getElementById("wind-speed-threshold")?.value || 15, 10),
      wind_gust_threshold: parseInt(s.getElementById("wind-gust-threshold")?.value || 20, 10),
      daily_forecast_days: parseInt(s.getElementById("daily-forecast-days")?.value || 3, 10),
      use_ai_rewrite: s.getElementById("use-ai-rewrite")?.checked || false,
      ai_task_entity: s.getElementById("ai-task-entity")?.value || "",
      ai_rewrite_prompt: s.getElementById("ai-rewrite-prompt")?.value || "",
    };
  }
}

customElements.define("home-weather-panel", HomeWeatherPanel);
