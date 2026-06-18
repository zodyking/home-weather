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
    this._radarView = "map";
    this._useFahrenheit = true;
    this._weatherData = null;
    this._settings = {};
    this._settingsTab = "weather";
    this._narrow = null;
    this._graphHoverIndex = null;
    this._apexCharts = [];
    this._webhookInfo = {};  // { webhook_id: { url, last_triggered } }
    this._sunTimesCache = {};
    this._wwwSounds = [];  // Audio files in www/sounds/ for NWS alert picker
    this._alertsData = null;
    this._alertsLoading = false;
    this._version = null;
    this._updateStatus = "latest";  // "latest" | "available" | "checking"
    this._updateCheckInterval = null;
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
    // Subscribe to webhook events if not already subscribed
    if (hass && !this._webhookEventUnsub) {
      this._subscribeToWebhookEvents();
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
    this._startUpdateCheckPoll();
    // Subscribe to webhook triggered events for real-time status updates
    this._subscribeToWebhookEvents();
  }

  disconnectedCallback() {
    this._stopUpdateCheckPoll();
    if (this._mediaQuery && this._onMediaChange) {
      this._mediaQuery.removeEventListener("change", this._onMediaChange);
    }
    // Unsubscribe from webhook events
    if (this._webhookEventUnsub) {
      this._webhookEventUnsub();
      this._webhookEventUnsub = null;
    }
  }

  _subscribeToWebhookEvents() {
    if (!this._hass || this._webhookEventUnsub) return;
    try {
      this._hass.connection.subscribeEvents((event) => {
        this._handleWebhookTriggered(event);
      }, "home_weather_webhook_triggered").then((unsub) => {
        this._webhookEventUnsub = unsub;
      }).catch((e) => {
        console.warn("Failed to subscribe to webhook events:", e);
      });
    } catch (e) {
      console.warn("Error subscribing to webhook events:", e);
    }
  }

  _handleWebhookTriggered(event) {
    const { webhook_id, timestamp } = event.data || {};
    if (!webhook_id) return;
    
    // Update local webhook info
    if (!this._webhookInfo[webhook_id]) {
      this._webhookInfo[webhook_id] = {};
    }
    this._webhookInfo[webhook_id].last_triggered = timestamp;
    
    // Update the DOM directly for real-time feedback (without full re-render)
    const s = this.shadowRoot;
    if (!s) return;
    
    s.querySelectorAll(".webhook-card").forEach((card) => {
      const webhookIdInput = card.querySelector(".webhook-id");
      if (webhookIdInput && webhookIdInput.value === webhook_id) {
        // Update status dot
        const dot = card.querySelector(".webhook-status-dot");
        if (dot) {
          dot.classList.remove("idle");
          dot.classList.add("triggered");
        }
        // Update status label
        const label = card.querySelector(".webhook-status-label");
        if (label) {
          label.textContent = "Triggered";
        }
        // Update timestamp
        let tsEl = card.querySelector(".webhook-timestamp");
        if (!tsEl) {
          // Create timestamp element if it doesn't exist
          const statusRow = card.querySelector(".webhook-status-row");
          if (statusRow) {
            tsEl = document.createElement("span");
            tsEl.className = "webhook-timestamp";
            statusRow.appendChild(tsEl);
          }
        }
        if (tsEl && timestamp) {
          try {
            const dt = new Date(timestamp);
            tsEl.textContent = dt.toLocaleString();
          } catch (e) {
            tsEl.textContent = timestamp;
          }
        }
      }
    });
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
      await this._fetchVersion();
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

  async _fetchVersion() {
    if (!this._hass) return;
    try {
      const r = await this._hass.callWS({ type: "home_weather/get_version" });
      this._version = r.version != null ? String(r.version) : null;
      this._render();
    } catch (e) {
      console.error("Failed to fetch version:", e);
      this._version = null;
      this._render();
    }
  }

  _parseSemver(v) {
    const s = String(v || "0").replace(/^v/i, "").trim();
    const parts = s.split(".").map((n) => parseInt(n, 10) || 0);
    return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
  }

  _compareVersions(current, latest) {
    const c = this._parseSemver(current);
    const l = this._parseSemver(latest);
    if (l.major > c.major) return 1;
    if (l.major < c.major) return -1;
    if (l.minor > c.minor) return 1;
    if (l.minor < c.minor) return -1;
    if (l.patch > c.patch) return 1;
    if (l.patch < c.patch) return -1;
    return 0;
  }

  async _checkForUpdate() {
    const current = this._version;
    if (!current) return;
    try {
      const res = await fetch("https://api.github.com/repos/zodyking/home-weather/releases/latest");
      if (res.status === 404) {
        this._updateStatus = "latest";
      } else if (!res.ok) {
        this._updateStatus = this._updateStatus === "available" ? "available" : "latest";
        return;
      } else {
        const data = await res.json();
        const tag = (data.tag_name || "").replace(/^v/i, "").trim();
        if (!tag) {
          this._updateStatus = "latest";
        } else if (this._compareVersions(current, tag) > 0) {
          this._updateStatus = "available";
        } else {
          this._updateStatus = "latest";
        }
      }
      const pill = this.shadowRoot?.getElementById("update-status-pill");
      if (pill) pill.textContent = this._updateStatus === "available" ? "Update available" : "Latest version";
    } catch (e) {
      this._updateStatus = this._updateStatus === "available" ? "available" : "latest";
    }
  }

  _startUpdateCheckPoll() {
    this._stopUpdateCheckPoll();
    this._checkForUpdate();
    this._updateCheckInterval = setInterval(() => this._checkForUpdate(), 60000);
  }

  _stopUpdateCheckPoll() {
    if (this._updateCheckInterval) {
      clearInterval(this._updateCheckInterval);
      this._updateCheckInterval = null;
    }
  }

  async _loadWwwSounds() {
    if (!this._hass) return;
    try {
      const r = await this._hass.callWS({ type: "home_weather/list_www_sounds" });
      this._wwwSounds = r.sounds || [];
    } catch (e) {
      console.warn("Failed to load www sounds:", e);
      this._wwwSounds = [];
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
    this._syncSettingsFromForm();
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
    const daysToFull = (14.765 - ageDays + LUNAR_CYCLE) % LUNAR_CYCLE;
    return { ...phases[idx], illumination, daysSinceNew: ageDays.toFixed(1), daysToFull: Math.round(daysToFull * 10) / 10 };
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
        return { entity_id: item, tts_entity_id: "", volume: 0.6, cache: false, language: "", preroll_ms: 150, options: {} };
      }
      return {
        entity_id: item.entity_id || "",
        tts_entity_id: item.tts_entity_id || "",
        volume: item.volume ?? 0.6,
        cache: !!item.cache,
        language: item.language || "",
        preroll_ms: item.preroll_ms ?? 150,
        options: item.options || {},
      };
    }).filter((m) => m.entity_id);
  }

  // ========== Entity Autocomplete Helpers ==========
  
  _getEntitiesForAutocomplete(entityType) {
    const entities = Object.keys((this._hass && this._hass.states) || {});
    const prefixMap = {
      weather: "weather.",
      tts: "tts.",
      sensor: "sensor.",
      binary_sensor: "binary_sensor.",
      ai_task: "ai_task.",
      switch: "switch.",
      light: "light.",
      automation: "automation.",
      all: "", // all entities
    };
    const prefix = prefixMap[entityType] || "";
    const filtered = prefix ? entities.filter((e) => e.startsWith(prefix)) : entities;
    return filtered.map((e) => {
      const state = this._hass?.states?.[e];
      return {
        entity_id: e,
        friendly_name: state?.attributes?.friendly_name || e,
      };
    });
  }

  _filterEntityMatches(entities, query) {
    if (!query || !query.trim()) return entities.slice(0, 20);
    const q = query.toLowerCase().trim();
    const scored = entities.map((e) => {
      const id = (e.entity_id || "").toLowerCase();
      const name = (e.friendly_name || "").toLowerCase();
      let score = 0;
      if (id === q || name === q) score += 30;
      if (id.startsWith(q)) score += 15;
      if (name.startsWith(q)) score += 10;
      if (id.includes(q)) score += 5;
      if (name.includes(q)) score += 3;
      return { ...e, _score: score };
    }).filter((e) => e._score > 0).sort((a, b) => b._score - a._score);
    return scored.slice(0, 20).map(({ _score, ...e }) => e);
  }

  _renderEntityAutocomplete(id, value, entityType, placeholder, inputClass = "") {
    this._entityDatalistId = (this._entityDatalistId || 0) + 1;
    const dlId = `entity-dl-${this._entityDatalistId}`;
    const safeVal = (value || "").replace(/"/g, "&quot;");
    const safePlaceholder = (placeholder || "Type to search...").replace(/"/g, "&quot;");
    return `
      <div class="entity-autocomplete-wrapper">
        <input type="text" id="${id}" class="form-input entity-autocomplete-input ${inputClass}" 
               value="${safeVal}" placeholder="${safePlaceholder}" 
               list="${dlId}" data-entity-type="${entityType}" autocomplete="off"/>
        <datalist id="${dlId}" data-entity-type="${entityType}"></datalist>
      </div>
    `;
  }

  _initEntityAutocompletes(container) {
    if (!container) return;
    container.querySelectorAll(".entity-autocomplete-input").forEach((input) => {
      if (input._entityAutocompleteInit) return;
      input._entityAutocompleteInit = true;

      const dlId = input.getAttribute("list");
      const datalist = dlId ? container.querySelector(`#${dlId}`) : null;
      const entityType = input.dataset.entityType || "all";

      if (!datalist) return;

      const update = () => {
        const entities = this._getEntitiesForAutocomplete(entityType);
        const matches = this._filterEntityMatches(entities, input.value);
        datalist.innerHTML = matches.map((e) => {
          const id = (e.entity_id || "").replace(/"/g, "&quot;").replace(/</g, "&lt;");
          const label = (e.friendly_name || e.entity_id || "").replace(/</g, "&lt;");
          return `<option value="${id}">${label}</option>`;
        }).join("");
      };

      input.addEventListener("focus", update);
      input.addEventListener("input", update);
    });
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
    const ttsInput = card.querySelector(".media-player-tts-entity");
    const volumeSlider = card.querySelector(".media-player-volume");
    const prerollInput = card.querySelector(".media-player-preroll");
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
      tts_entity_id: ttsInput?.value || "",
      volume: parseFloat(volumeSlider?.value || 0.6),
      preroll_ms: parseInt(prerollInput?.value || 150, 10),
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
    const mediaPlayerSelect = card.querySelector(".sensor-trigger-media-player");
    list[index] = {
      entity_id: entitySel?.value || "",
      trigger_state: stateInput?.value || "on",
      media_player: mediaPlayerSelect?.value || "",
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
    const mediaPlayerSelect = card.querySelector(".webhook-media-player");
    list[index] = {
      webhook_id: webhookIdInput?.value || "",
      personal_name: nameInput?.value || "",
      enabled: enabledChk?.checked !== false,
      media_player: mediaPlayerSelect?.value || "",
    };
    this._settings.tts.webhooks = list;
  }

  _getTzid() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }

  async _ensureSunTimes(lat, lon, date) {
    const d = date instanceof Date ? date : new Date(date);
    const dateStr = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const key = `${lat.toFixed(4)}_${lon.toFixed(4)}_${dateStr}`;
    if (this._sunTimesCache && this._sunTimesCache[key]) return;
    try {
      const tzid = this._getTzid();
      const url = `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}&date=${dateStr}&formatted=0&tzid=${encodeURIComponent(tzid)}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.status !== "OK" || !json.results) return;
      const r = json.results;
      const parse = (s) => s ? new Date(s) : null;
      this._sunTimesCache = this._sunTimesCache || {};
      this._sunTimesCache[key] = {
        sunrise: parse(r.sunrise),
        sunset: parse(r.sunset),
        solar_noon: parse(r.solar_noon),
        day_length: r.day_length,
        civil_twilight_begin: parse(r.civil_twilight_begin),
        civil_twilight_end: parse(r.civil_twilight_end),
      };
      this._render();
    } catch (e) {
      console.warn("Sunrise-Sunset API failed:", e);
    }
  }

  async _fetchSunTimes(lat, lon, date) {
    const d = date instanceof Date ? date : new Date(date);
    const dateStr = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const key = `${lat.toFixed(4)}_${lon.toFixed(4)}_${dateStr}`;
    if (this._sunTimesCache && this._sunTimesCache[key]) return this._sunTimesCache[key];
    const tzid = this._getTzid();
    const url = `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lon}&date=${dateStr}&formatted=0&tzid=${encodeURIComponent(tzid)}`;
    try {
      const res = await fetch(url);
      const json = await res.json();
      if (json.status !== "OK" || !json.results) throw new Error(json.status || "Unknown error");
      const r = json.results;
      const parse = (s) => s ? new Date(s) : null;
      const data = {
        sunrise: parse(r.sunrise),
        sunset: parse(r.sunset),
        solar_noon: parse(r.solar_noon),
        day_length: r.day_length,
        civil_twilight_begin: parse(r.civil_twilight_begin),
        civil_twilight_end: parse(r.civil_twilight_end),
      };
      this._sunTimesCache = this._sunTimesCache || {};
      this._sunTimesCache[key] = data;
      return data;
    } catch (e) {
      return this._getSunTimesMath(lat, lon, date);
    }
  }

  _getSunTimesMath(lat, lon, date) {
    const d = date instanceof Date ? date : new Date(date);
    const day = d.getDate();
    const month = d.getMonth() + 1;
    const year = d.getFullYear();
    const latRad = (lat * Math.PI) / 180;
    const n = Math.floor(365.25 * (year - 2000)) + Math.floor(30.6001 * (month + 1)) + day - 63.5;
    const sunMeanAnom = (357.5281 + 0.9856 * n) % 360;
    const sunMeanAnomRad = (sunMeanAnom * Math.PI) / 180;
    const eclipticLon = 280.46 + 0.9856474 * n + 1.915 * Math.sin(sunMeanAnomRad) + 0.02 * Math.sin(2 * sunMeanAnomRad);
    const obliquity = 23.44 - 0.0000004 * n;
    const decRad = Math.asin(Math.sin((obliquity * Math.PI) / 180) * Math.sin((eclipticLon * Math.PI) / 180));
    const cosHourAngle = (Math.sin((-0.83 * Math.PI) / 180) - Math.sin(latRad) * Math.sin(decRad)) / (Math.cos(latRad) * Math.cos(decRad));
    if (cosHourAngle > 1 || cosHourAngle < -1) return { sunrise: null, sunset: null, solar_noon: null, day_length: null, civil_twilight_begin: null, civil_twilight_end: null };
    const hourAngle = Math.acos(Math.max(-1, Math.min(1, cosHourAngle))) * (180 / Math.PI);
    const eqTime = 0.0172 + 0.4281 * Math.cos(sunMeanAnomRad) - 7.351 * Math.sin(sunMeanAnomRad) - 3.3495 * Math.cos(2 * sunMeanAnomRad) - 9.3619 * Math.sin(2 * sunMeanAnomRad);
    const sunriseOffset = 12 - (1 / 15) * (hourAngle + eqTime) - lon / 15;
    const sunsetOffset = 12 + (1 / 15) * (hourAngle - eqTime) - lon / 15;
    const sunrise = new Date(year, month - 1, day);
    sunrise.setHours(Math.floor(sunriseOffset), Math.round((sunriseOffset % 1) * 60), 0, 0);
    const sunset = new Date(year, month - 1, day);
    sunset.setHours(Math.floor(sunsetOffset), Math.round((sunsetOffset % 1) * 60), 0, 0);
    return { sunrise, sunset, solar_noon: null, day_length: null, civil_twilight_begin: null, civil_twilight_end: null };
  }

  _getSunTimes(lat, lon, date) {
    const d = date instanceof Date ? date : new Date(date);
    const dateStr = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const key = `${lat.toFixed(4)}_${lon.toFixed(4)}_${dateStr}`;
    if (this._sunTimesCache && this._sunTimesCache[key]) return this._sunTimesCache[key];
    return this._getSunTimesMath(lat, lon, date);
  }

  _isDayTime(datetime, lat, lon) {
    if (datetime == null || lat == null || lon == null) return true;
    const d = datetime instanceof Date ? datetime : new Date(datetime);
    const { sunrise, sunset } = this._getSunTimes(lat, lon, d);
    if (!sunrise || !sunset) return d.getHours() >= 7 && d.getHours() < 19;
    const t = d.getTime();
    return t >= sunrise.getTime() && t <= sunset.getTime();
  }

  _getHomeCoordinates() {
    const h = this._hass;
    if (!h) return { lat: 40.441, lon: -73.938 };

    const weatherEntity = this._settings?.weather_entity ?? this._config?.weather_entity;
    const weatherState = weatherEntity ? h.states?.[weatherEntity] : null;
    const wLat = weatherState?.attributes?.latitude;
    const wLon = weatherState?.attributes?.longitude;
    if (wLat != null && wLon != null && Number.isFinite(Number(wLat)) && Number.isFinite(Number(wLon))) {
      return { lat: Number(wLat), lon: Number(wLon) };
    }

    const lat = h.config?.latitude ?? h.states?.["zone.home"]?.attributes?.latitude ?? 40.441;
    const lon = h.config?.longitude ?? h.states?.["zone.home"]?.attributes?.longitude ?? -73.938;
    return { lat, lon };
  }

  _isNightTime(datetime) {
    const { lat, lon } = this._getHomeCoordinates();
    return !this._isDayTime(datetime, lat, lon);
  }

  _getConditionLabel(condition, datetime) {
    const c = (condition || "").toLowerCase().trim();
    if (this._isNightTime(datetime) && (c === "sunny" || c === "clear" || c === "fair")) {
      return "Clear skies";
    }
    return condition || "—";
  }

  _formatConditionText(condition) {
    if (!condition || !String(condition).trim()) return "—";
    return String(condition)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
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
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :host {
          --primary-background-color: #111111;
          --card-background-color: #1c1c1c;
          --panel-header-background: #1c1c1c;
          --secondary-background-color: #282828;
          --input-bg: #282828;
          --primary-text-color: #e1e1e1;
          --secondary-text-color: #9b9b9b;
          --disabled-text-color: #6f6f6f;
          --panel-accent: #03a9f4;
          --panel-accent-hover: #29b6f6;
          --panel-accent-dim: rgba(3, 169, 244, 0.15);
          --panel-danger: #f44336;
          --panel-warning: #ff9800;
          --panel-success: #4caf50;
          --card-border: rgba(255, 255, 255, 0.08);
          --input-border: rgba(255, 255, 255, 0.12);
          --divider-color: var(--card-border);
          --primary-color: var(--panel-accent);
          --accent-color: var(--panel-accent);
          --primary-color-text: #ffffff;
          --error-color: var(--panel-danger);
          --info-color: var(--panel-accent);
          --bg: var(--primary-background-color);
          --bg-2: var(--primary-background-color);
          --panel: var(--card-background-color);
          --panel-2: var(--secondary-background-color);
          --panel-3: var(--secondary-background-color);
          --stroke: var(--card-border);
          --stroke-2: var(--input-border);
          --text: var(--primary-text-color);
          --muted: var(--secondary-text-color);
          --blue: var(--panel-accent);
          --blue-2: var(--panel-accent-hover);
          --cyan: var(--panel-accent-hover);
          --green: var(--panel-success);
          --shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
          --radius-xl: 12px;
          --radius-lg: 12px;
          --radius-md: 10px;
          --radius-sm: 10px;
          --glass: none;
        }
        :host {
          display: block;
          width: 100%;
          min-height: 100%;
          padding: 0;
          max-width: none;
          margin: 0;
          font-family: var(--paper-font-body1_-_font-family, "Roboto", "Segoe UI", sans-serif);
          background: var(--primary-background-color);
          color: var(--text);
        }
        .hud-wrapper { position: relative; min-height: 100%; overflow: auto; }
        .hud-wrapper::before, .hud-wrapper::after { content: none; }
        .weather-app { padding: 0; display: flex; flex-direction: column; gap: 0; height: 100%; min-height: 0; min-width: 0; }
        .content-area { flex: 1; min-height: 0; min-width: 0; max-width: 1800px; margin: 0 auto; width: 100%; padding: clamp(12px, 2vw, 18px); box-sizing: border-box; display: flex; flex-direction: column; }
        .glass { background: var(--card-background-color); border: 1px solid var(--card-border); border-radius: var(--radius-xl); box-shadow: var(--shadow); }
        .topbar {
          position: sticky;
          top: 0;
          z-index: 100;
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px 10px;
          min-width: 0;
          padding: 8px 12px;
          background: var(--panel-header-background);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          border-bottom: 1px solid var(--card-border);
        }
        .topbar .icon-btn { flex-shrink: 0; width: 40px; min-width: 40px; height: 40px; }
        .title-card { flex: 1; min-width: 0; display: flex; align-items: center; padding: 0 8px 0 0; background: transparent; border: none; box-shadow: none; border-radius: 0; }
        .title-wrap { min-width: 0; flex: 1; overflow: hidden; }
        .eyebrow { color: var(--muted); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .title { font-size: clamp(17px, 2.2vw, 20px); line-height: 1.2; font-weight: 600; letter-spacing: -0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--primary-text-color); }
        .status-card { display: flex; align-items: center; gap: 6px 8px; justify-content: flex-end; padding: 0; flex-shrink: 1; flex-wrap: wrap; min-width: 0; background: transparent; border: none; box-shadow: none; border-radius: 0; }
        .pill { height: 28px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--input-border); background: var(--secondary-background-color); display: inline-flex; align-items: center; gap: 5px; color: var(--secondary-text-color); font-size: 11px; white-space: nowrap; flex-shrink: 0; min-width: 0; }
        .pill.pill-muted { font-size: 10px; color: var(--muted); }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--panel-success); box-shadow: 0 0 0 1px rgba(76, 175, 80, 0.35); }
        .icon-btn { border: 1px solid var(--input-border); background: var(--input-bg); border-radius: 10px; box-shadow: none; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--text); transition: background 0.16s ease, border-color 0.16s ease; width: 40px; height: 40px; min-width: 40px; }
        .icon-btn:hover { background: rgba(255, 255, 255, 0.06); border-color: var(--input-border); color: var(--panel-accent-hover); }
        .gear { width: 20px; height: 20px; border: 2px solid var(--text); border-radius: 50%; position: relative; opacity: 0.92; }
        .gear::before { content: ""; position: absolute; inset: 5px; border: 2px solid var(--text); border-radius: 50%; }
        .dashboard { display: flex; flex-direction: column; gap: clamp(10px, 1.5vw, 14px); min-width: 0; min-height: 0; flex: 1; padding-bottom: clamp(12px, 2vw, 24px); box-sizing: border-box; }
        .dashboard-message { padding: 48px; text-align: center; }
        .dashboard-bento {
          display: grid;
          grid-template-columns: 1fr;
          gap: clamp(10px, 1.5vw, 14px);
          min-width: 0;
          align-items: stretch;
          align-content: stretch;
        }
        .dashboard-bento > * { min-width: 0; }
        @media (min-width: 960px) {
          .dashboard-bento {
            grid-template-columns: 1fr 1fr;
            grid-template-rows: auto auto 1fr;
            min-height: clamp(520px, calc(100dvh - 100px), 2000px);
          }
          .dash-today { grid-column: 1; grid-row: 1; }
          .dash-radar { grid-column: 2; grid-row: 1; }
          .dash-forecast { grid-column: 1 / -1; grid-row: 2; }
          .dash-moon { grid-column: 1; grid-row: 3; }
          .dash-sun { grid-column: 2; grid-row: 3; }
          .dashboard-bento .dash-moon,
          .dashboard-bento .dash-sun {
            min-height: 0;
            height: 100%;
            align-self: stretch;
          }
        }
        .today-card { min-height: 0; }
        .dashboard-bento .dash-today .today-grid {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
        }
        .dashboard-bento .dash-today .today-primary {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
        }
        .today-grid {
          display: block;
          min-width: 0;
        }
        .today-primary { min-width: 0; text-align: center; }
        .today-primary-row { display: flex; align-items: center; justify-content: center; gap: clamp(12px, 2vw, 20px); flex-wrap: wrap; }
        .today-icon .weather-icon { display: flex; align-items: center; justify-content: center; }
        .today-icon .weather-icon img { width: clamp(72px, 16vw, 100px); height: clamp(60px, 14vw, 84px); object-fit: contain; }
        .today-temp-block { min-width: 0; }
        .today-temp { font-size: clamp(56px, 14vw, 88px); font-weight: 700; line-height: 0.95; letter-spacing: -0.06em; font-variant-numeric: tabular-nums; color: var(--primary-text-color); }
        .today-unit { font-size: clamp(22px, 5vw, 32px); font-weight: 700; color: var(--panel-accent-hover); margin-left: 2px; vertical-align: super; }
        .today-condition { margin-top: 8px; font-size: clamp(15px, 2.5vw, 18px); font-weight: 600; color: var(--primary-text-color); text-transform: capitalize; }
        .today-datetime { margin-top: 10px; font-size: 13px; color: var(--secondary-text-color); }
        .today-chips { margin-top: 12px; display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 8px; min-width: 0; }
        .today-chip { padding: 5px 8px; border-radius: 8px; background: var(--secondary-background-color); border: 1px solid var(--card-border); font-size: clamp(10px, 2.6vw, 12px); color: var(--primary-text-color); white-space: nowrap; }
        .forecast-panel-card, .radar-panel-card, .moon-panel-card, .sun-panel-card { min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
        .dashboard-bento .dash-forecast.forecast-panel-card { min-height: 280px; }
        .dashboard-bento .radar-body { flex: 1 0 auto; width: 100%; min-width: 0; height: 320px; min-height: 320px; display: flex; flex-direction: column; }
        .dashboard-bento .radar-body .radar-view.active { flex: 1; min-height: 0; display: flex; flex-direction: column; }
        .dashboard-bento .dash-radar .windy-map-container { flex: 1; min-height: 0; height: 100%; aspect-ratio: unset; max-height: none; max-width: 100%; }
        .dashboard-bento .dash-radar .chart-container { flex: 1; min-height: 0; height: 100%; max-height: none; }
        .card { min-width: 0; min-height: 0; padding: clamp(12px, 2vw, 20px); display: flex; flex-direction: column; overflow: hidden; }
        .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: clamp(8px, 1vw, 12px); margin-bottom: clamp(12px, 1.5vw, 16px); }
        .card-title { font-size: clamp(12px, 1.5vw, 14px); font-weight: 700; letter-spacing: -0.01em; }
        .card-sub { margin-top: 4px; font-size: clamp(11px, 1.2vw, 12px); color: var(--muted); }
        .tag { height: 28px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--input-border); background: var(--secondary-background-color); display: inline-flex; align-items: center; color: var(--panel-accent-hover); font-size: 11px; white-space: nowrap; }
        .windy-map-container { flex: 1; min-height: clamp(80px, 15vw, 320px); min-width: 0; position: relative; aspect-ratio: 1; max-height: 100%; border-radius: var(--radius-md); overflow: hidden; border: 1px solid var(--card-border); }
        .windy-map-container iframe { width: 100%; height: 100%; border: none; display: block; }
        .highlight { background: var(--card-background-color); border: 1px solid var(--card-border); border-radius: var(--radius-lg); padding: clamp(12px, 1.5vw, 16px); min-height: min(120px, 25vw); display: flex; flex-direction: column; justify-content: space-between; min-width: 0; }
        .highlight .top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .highlight .label { color: var(--muted); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; }
        .highlight .icon { font-size: 16px; opacity: 0.95; }
        .highlight .icon img { width: 24px; height: 24px; object-fit: contain; }
        .highlight .value { font-size: 32px; font-weight: 700; letter-spacing: -0.04em; font-variant-numeric: tabular-nums; }
        .highlight .sub { color: var(--muted); font-size: 11px; }
        .forecast-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; flex-shrink: 0; }
        .switcher { display: flex; align-items: center; gap: 4px; background: var(--secondary-background-color); border: 1px solid var(--card-border); border-radius: 999px; padding: 4px; }
        .switcher button { height: clamp(26px, 3vw, 30px); padding: 0 clamp(8px, 1.2vw, 14px); border: 0; border-radius: 999px; background: transparent; color: var(--secondary-text-color); font-size: clamp(10px, 1.2vw, 12px); cursor: pointer; transition: 0.16s ease; }
        .switcher button.active { background: var(--panel-accent); color: #ffffff; }
        .forecast-strip { flex: 1; min-height: 0; display: flex; flex-direction: row; flex-wrap: nowrap; gap: clamp(6px, 1vw, 10px); overflow-x: auto; overflow-y: hidden; padding-bottom: 6px; -webkit-overflow-scrolling: touch; scrollbar-width: thin; min-width: 0; align-items: stretch; }
        .forecast-strip::-webkit-scrollbar { height: 4px; }
        .forecast-strip::-webkit-scrollbar-thumb { background: var(--card-border); border-radius: 2px; }
        .forecast-24h-wrap .forecast-strip { scrollbar-width: none; }
        .forecast-24h-wrap .forecast-strip::-webkit-scrollbar { height: 0; display: none; }
        .forecast-7day-wrap .forecast-strip { display: grid; grid-template-columns: repeat(var(--forecast-cols, 7), minmax(0, 1fr)); overflow-x: visible; width: 100%; }
        .forecast-7day-wrap .forecast-card { width: 100%; min-width: 0; max-width: none; max-height: 176px; flex: unset; padding: 8px 6px; }
        .forecast-card { background: var(--card-background-color); border: 1px solid var(--card-border); border-radius: var(--radius-md); padding: 6px 5px; display: flex; flex-direction: column; align-items: center; justify-content: space-between; min-height: 0; max-height: 132px; text-align: center; min-width: 72px; max-width: 96px; width: clamp(72px, 12vw, 92px); flex: 0 0 auto; box-sizing: border-box; }
        .forecast-card.active { background: var(--panel-accent-dim); border-color: rgba(3, 169, 244, 0.35); }
        .forecast-card .day { font-size: clamp(10px, 1vw, 12px); color: var(--text); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
        .forecast-card .icon { margin: 2px 0; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .forecast-card .icon img { width: clamp(22px, 5vw, 34px); height: clamp(20px, 4.5vw, 30px); object-fit: contain; }
        .forecast-card .condition { font-size: clamp(9px, 0.9vw, 11px); color: var(--muted); margin-bottom: clamp(2px, 0.4vw, 6px); text-align: center; line-height: 1.2; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .forecast-card .temps { line-height: 1.25; }
        .forecast-card .high { font-size: clamp(13px, 2.5vw, 18px); font-weight: 700; letter-spacing: -0.04em; font-variant-numeric: tabular-nums; }
        .forecast-card .low { color: var(--muted); font-size: clamp(10px, 2vw, 13px); font-variant-numeric: tabular-nums; }
        .forecast-card .rain { margin-top: clamp(4px, 0.6vw, 8px); color: var(--panel-accent-hover); font-size: clamp(10px, 1vw, 12px); font-weight: 600; }
        .moon-card-fill { flex: 1 1 auto; min-height: 0; max-height: none; display: flex; flex-direction: column; align-items: center; text-align: center; overflow: hidden; min-width: 0; }
        .moon-card-fill .card-head { margin-bottom: 12px; flex-shrink: 0; align-self: stretch; width: 100%; }
        .moon-card-fill .card-head > div:first-child { text-align: left; }
        .moon-card { display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; }
        .moon-icon-wrap { width: clamp(56px, 10vw, 120px); height: clamp(56px, 10vw, 120px); margin-bottom: 8px; flex-shrink: 1; min-width: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; }
        .moon-card .moon-icon, .moon-card-fill .moon-icon { width: clamp(56px, 10vw, 120px); height: clamp(56px, 10vw, 120px); margin-bottom: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 1; min-width: 0; min-height: 0; }
        .moon-card-fill .moon-icon-wrapper { width: 100%; height: 100%; max-width: 100%; max-height: 100%; display: flex; align-items: center; justify-content: center; overflow: hidden; }
        .moon-card-fill .moon-icon-wrapper img { width: 100%; height: 100%; max-width: 100%; max-height: 100%; object-fit: contain; }
        .moon-card-fill .moon-icon-wrap .moon-icon { width: 100%; height: 100%; margin: 0; max-width: 100%; max-height: 100%; display: flex; align-items: center; justify-content: center; }
        .moon-pane, .sun-pane { display: flex; flex-direction: column; align-items: center; gap: clamp(4px, 0.8vw, 8px); flex: 1; min-height: 0; overflow: hidden; }
        .sun-pane .sun-stat { font-size: clamp(11px, 1.2vw, 13px); color: var(--text); white-space: nowrap; display: flex; justify-content: center; align-items: center; gap: 8px; }
        .sun-pane .sun-label { color: var(--muted); font-size: clamp(10px, 1.1vw, 12px); }
        .sun-pane .sun-attribution { margin-top: clamp(6px, 1vw, 12px); font-size: clamp(9px, 1vw, 10px); color: var(--muted); }
        .moon-card-fill .moon-meta, .moon-card-fill .moon-sun { margin-top: 8px; font-size: clamp(10px, 1.1vw, 12px); color: var(--muted); overflow-wrap: break-word; word-break: break-word; max-width: 100%; }
        .moon-card .moon-icon img, .moon-card-fill .moon-icon img { width: 100%; height: 100%; object-fit: contain; filter: drop-shadow(0 2px 8px rgba(0,0,0,0.2)); }
        .moon-title, .moon-card-fill .moon-title { font-size: clamp(12px, 2vw, 20px); font-weight: 600; letter-spacing: -0.02em; overflow-wrap: break-word; word-break: break-word; max-width: 100%; }
        .moon-sub, .moon-card-fill .moon-sub { margin-top: 6px; color: var(--muted); font-size: clamp(10px, 1.2vw, 13px); overflow-wrap: break-word; max-width: 100%; }
        .moon-pane, .sun-pane { display: flex; flex-direction: column; align-items: center; gap: clamp(4px, 0.8vw, 8px); width: 100%; }
        .sun-pane { text-align: center; }
        .sun-label { color: var(--muted); font-size: clamp(10px, 1.1vw, 12px); }
        .sun-attribution { margin-top: clamp(6px, 1vw, 12px); font-size: clamp(9px, 1vw, 10px); color: var(--muted); text-decoration: none; }
        .sun-attribution:hover { color: var(--panel-accent-hover); }
        .chart-container { flex: 1; min-height: clamp(100px, 20vw, 320px); min-width: 0; width: 100%; }
        .radar-view { display: none; flex: 1; min-height: 0; flex-direction: column; }
        .radar-view.active { display: flex; }
        .dash-moon .moon-pane { display: flex; flex: 1; min-height: 0; flex-direction: column; align-items: center; justify-content: center; text-align: center; overflow: hidden; }
        .dash-sun .sun-pane { display: flex; flex: 1; min-height: 0; flex-direction: column; justify-content: flex-start; overflow: hidden; }
        .dash-moon .moon-icon-wrap { width: clamp(48px, 12vw, 88px); height: clamp(48px, 12vw, 88px); }
        .dash-moon .moon-icon { width: 100%; height: 100%; max-width: 88px; max-height: 88px; }
        .sun-panel-card .sun-pane { align-items: stretch; text-align: left; width: 100%; }
        .sun-panel-card .sun-stat { justify-content: space-between; width: 100%; white-space: normal; flex-wrap: wrap; gap: 4px 12px; }
        .sun-panel-card.moon-card-fill { align-items: stretch; text-align: left; }
        .sun-panel-card.moon-card-fill .sun-attribution { margin-top: auto; align-self: flex-start; }
        .forecast-7day-wrap, .forecast-24h-wrap { display: none; flex: 1; min-height: 170px; flex-direction: column; }
        .forecast-7day-wrap.active, .forecast-24h-wrap.active { display: flex; }
        @media (max-width: 600px) {
          .forecast-7day-wrap .forecast-strip { display: flex; overflow-x: auto; grid-template-columns: unset; scrollbar-width: none; }
          .forecast-7day-wrap .forecast-strip::-webkit-scrollbar { height: 0; display: none; }
          .forecast-7day-wrap .forecast-card { flex: 0 0 auto; width: clamp(72px, 22vw, 92px); max-width: 96px; max-height: 148px; padding: 6px 5px; }
        }
        .footer-note { position: absolute; right: 22px; bottom: 18px; max-width: calc(100% - 44px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--disabled-text-color); font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; pointer-events: none; }
        @media (min-width: 1181px) { .hud-wrapper { min-height: 100vh; } }
        @media (max-width: 900px) { .content-area { padding: clamp(10px, 2vw, 14px); } }
        @media (max-width: 768px) { .content-area { padding: 10px; } }
        @media (max-width: 520px) { .topbar .pill-update-hide-narrow { display: none; } }
        @media (max-width: 480px) { .forecast-card { max-height: 128px; padding: 5px 4px; min-width: 68px; max-width: 88px; width: 72px; } .forecast-card .temps { min-width: 0; overflow: hidden; } .forecast-card .day, .forecast-card .condition { min-width: 0; } }
        .loading, .error { text-align: center; padding: 48px 16px; color: var(--secondary-text-color); }
        .error { color: var(--error-color); }
        .settings-view { padding: clamp(12px, 2vw, 18px); max-width: 1800px; margin: 0 auto; width: 100%; box-sizing: border-box; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid var(--card-border); flex-wrap: wrap; gap: 12px; }
        .header-left { display: flex; align-items: center; gap: 12px; }
        .header-right { display: flex; align-items: center; margin-left: auto; }
        .header h1 { margin: 0; font-size: 16px; font-weight: 500; color: var(--primary-text-color); }
        .header-nav { display: flex; gap: 0; }
        .header-btn { padding: 8px; background: transparent; border: none; border-radius: 8px; color: var(--primary-text-color); cursor: pointer; display: flex; align-items: center; justify-content: center; }
        .header-btn:hover { background: var(--secondary-background-color); }
        .header-btn svg { width: 24px; height: 24px; }
        .hamburger { display: none; padding: 8px; background: transparent; border: none; cursor: pointer; color: var(--primary-text-color); border-radius: 8px; }
        .hamburger:hover { background: var(--secondary-background-color); }
        .hamburger svg { width: 24px; height: 24px; display: block; }
        @media (max-width: 768px) { .hamburger { display: block; } }
        .narrow .hamburger { display: block; }
        .nav-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px; background: var(--secondary-background-color); border: 1px solid var(--card-border); border-radius: 999px; width: fit-content; max-width: 100%; }
        .nav-tab { padding: 8px 16px; background: transparent; border: none; border-radius: 999px; color: var(--secondary-text-color); cursor: pointer; font-size: 14px; font-weight: 500; }
        .nav-tab:hover { color: var(--primary-text-color); }
        .nav-tab.active { background: var(--panel-accent); color: #ffffff; }
        .view-toggle { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 24px; padding: 4px; background: var(--secondary-background-color); border: 1px solid var(--card-border); border-radius: 999px; width: fit-content; max-width: 100%; }
        .view-toggle button { padding: 8px 16px; background: transparent; border: none; border-radius: 999px; color: var(--secondary-text-color); cursor: pointer; font-size: 13px; font-weight: 500; }
        .view-toggle button.active { background: var(--panel-accent); color: #ffffff; }
        .hourly-forecast { display: flex; gap: 12px; overflow-x: auto; padding: 16px 0; }
        .hour-card { min-width: 120px; padding: 20px 16px; background: var(--card-background-color); border-radius: var(--radius-md); text-align: center; border: 1px solid var(--card-border); }
        .hour-card.current { border: 2px solid var(--panel-accent); background: var(--panel-accent); color: #ffffff; }
        .hour-time { font-size: 14px; color: var(--secondary-text-color); margin-bottom: 8px; }
        .hour-card.current .hour-time { color: #ffffff; }
        .hour-temp { font-size: 28px; font-weight: 600; margin: 12px 0; }
        .hour-condition { font-size: 13px; color: var(--secondary-text-color); margin-top: 12px; }
        .hour-card.current .hour-condition { color: #ffffff; }
        .hour-precip { font-size: 11px; color: var(--info-color); margin-top: 4px; }
        .daily-forecast { display: grid; gap: 12px; }
        .day-card { display: flex; justify-content: space-between; align-items: center; padding: 20px; background: var(--card-background-color); border-radius: var(--radius-md); border: 1px solid var(--card-border); }
        .day-name { font-size: 16px; font-weight: 500; min-width: 100px; }
        .day-temps { display: flex; gap: 16px; }
        .day-high { font-size: 20px; font-weight: 500; }
        .day-low { font-size: 16px; color: var(--secondary-text-color); }
        .day-precip { font-size: 14px; color: var(--info-color); margin-left: auto; }
        /* Settings design tokens */
        .settings-form {
          --form-gap: 16px;
          --form-gap-sm: 12px;
          --form-gap-lg: 24px;
          --form-label-size: 13px;
          --form-label-weight: 500;
          --form-hint-size: 12px;
          --form-input-height: 40px;
          --section-padding: 20px;
          display: grid;
          gap: var(--form-gap-lg);
        }
        .settings-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 24px; padding: 4px; background: var(--secondary-background-color); border: 1px solid var(--card-border); border-radius: 999px; width: fit-content; max-width: 100%; }
        .settings-tab { padding: 8px 18px; background: transparent; border: none; border-radius: 999px; color: var(--secondary-text-color); cursor: pointer; font-size: 14px; font-weight: 500; }
        .settings-tab:hover { color: var(--primary-text-color); }
        .settings-tab.active { background: var(--panel-accent); color: #ffffff; }
        .settings-section { display: none; }
        .settings-section.active { display: block; }
        .form-group { display: flex; flex-direction: column; gap: 6px; margin-bottom: var(--form-gap); }
        .form-group label { font-size: var(--form-label-size); font-weight: var(--form-label-weight); color: var(--primary-text-color); }
        .form-group input, .form-group select { padding: 10px 14px; height: var(--form-input-height); border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--primary-text-color); font-size: 14px; box-sizing: border-box; }
        .form-group input[type="checkbox"] { width: auto; padding: 0; height: auto; }
        .form-row { display: flex; align-items: center; gap: var(--form-gap-sm); }
        .form-row-inline { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--form-gap-sm); align-items: end; margin-bottom: var(--form-gap); }
        .form-row-inline .form-group { margin-bottom: 0; }
        @media (max-width: 480px) { .form-row-inline { grid-template-columns: 1fr; } }
        .settings-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: var(--form-gap-sm); padding: 12px 0; }
        .settings-toggle-row .inline-toggle-label { margin: 0; }
        .form-group.settings-toggle-row { flex-direction: row; flex-wrap: nowrap; }
        .days-of-week-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--form-gap-sm); margin-bottom: var(--form-gap); }
        .day-toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: var(--secondary-background-color); border-radius: 8px; }
        .day-toggle-row .day-label { font-size: var(--form-label-size); font-weight: var(--form-label-weight); color: var(--primary-text-color); }
        @media (max-width: 480px) { .days-of-week-grid { grid-template-columns: repeat(2, 1fr); } }
        .form-group.settings-toggle-row { flex-direction: row; flex-wrap: nowrap; align-items: center; }
        .form-group.settings-toggle-row label:first-of-type { margin-bottom: 0; flex: 1; }
        .form-row .btn-icon { padding: 8px 12px; min-width: auto; }
        .media-player-list { display: flex; flex-direction: column; gap: 16px; }
        .media-player-item { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: var(--card-background-color); border: 1px solid var(--card-border); border-radius: 8px; }
        .media-player-item select { flex: 1; }
        .media-player-card { padding: 20px; background: var(--card-background-color); border: 1px solid var(--card-border); border-radius: var(--radius-md); display: flex; flex-direction: column; gap: 14px; }
        .media-player-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
        .media-player-label { font-size: 13px; font-weight: 500; color: var(--secondary-text-color); min-width: 140px; }
        .media-player-controls { display: flex; gap: 8px; flex: 1; min-width: 0; }
        .media-player-controls select { flex: 1; min-width: 0; }
        .media-player-tts-entity, .media-player-language { flex: 1; min-width: min(200px, 100%); padding: 10px 14px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--primary-text-color); font-size: 14px; }
        .toggle-switch { position: relative; display: inline-block; width: 44px; height: 24px; }
        .toggle-switch input { opacity: 0; width: 0; height: 0; }
        .toggle-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background: var(--secondary-background-color); border-radius: 24px; transition: 0.3s; border: 1px solid var(--input-border); }
        .toggle-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 2px; bottom: 2px; background: var(--primary-text-color); border-radius: 50%; transition: 0.3s; }
        .toggle-switch input:checked + .toggle-slider { background: var(--accent-color); border-color: var(--accent-color); }
        .toggle-switch input:checked + .toggle-slider:before { transform: translateX(20px); background: white; }
        .toggle-label { font-size: 13px; color: var(--secondary-text-color); margin-left: 8px; }
        .collapsible-section { background: var(--card-background-color); border: 1px solid var(--card-border); border-radius: var(--radius-md); margin-bottom: 16px; overflow: hidden; }
        .collapsible-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; cursor: pointer; user-select: none; transition: background 0.2s; }
        .collapsible-header:hover { background: var(--secondary-background-color); }
        .collapsible-header-left { display: flex; align-items: center; gap: 12px; }
        .collapsible-title { font-size: 15px; font-weight: 600; color: var(--primary-text-color); }
        .collapsible-subtitle { font-size: 12px; color: var(--secondary-text-color); margin-top: 2px; }
        .collapsible-chevron { width: 20px; height: 20px; color: var(--secondary-text-color); transition: transform 0.2s; }
        .collapsible-section.open .collapsible-chevron { transform: rotate(180deg); }
        .collapsible-content { padding: var(--section-padding); display: none; flex-direction: column; gap: var(--form-gap); }
        .collapsible-section.open .collapsible-content { display: flex; }
        .subsection-block { display: flex; flex-direction: column; gap: var(--form-gap-sm); }
        .subsection-title { font-size: 14px; font-weight: 600; color: var(--primary-text-color); margin-bottom: 4px; }
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
        .time-input-group input[type="time"] { padding: 10px 14px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--primary-text-color); font-size: 14px; }
        .test-tts-btn { padding: 8px 16px; background: var(--accent-color); color: white; border: none; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.2s; }
        .test-tts-btn:hover { background: var(--panel-accent-hover); }
        .multi-select { display: flex; flex-direction: column; gap: 8px; max-height: 200px; overflow-y: auto; padding: 12px; background: var(--secondary-background-color); border-radius: 8px; }
        .multi-select-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--card-background-color); border-radius: 6px; cursor: pointer; transition: all 0.2s; }
        .multi-select-item:hover { background: rgba(255, 255, 255, 0.06); }
        .multi-select-item.selected { background: var(--accent-color); color: white; }
        .multi-select-item input { display: none; }
        .textarea-field { width: 100%; min-height: 100px; padding: 12px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--primary-text-color); font-size: 14px; font-family: inherit; resize: vertical; }
        .inline-toggle { display: flex; align-items: center; gap: 12px; padding: 12px 0; }
        .inline-toggle-label { flex: 1; font-size: 14px; color: var(--primary-text-color); }
        .settings-section-divider { border: none; border-top: 1px solid var(--card-border); margin: 20px 0; }
        .form-hint { font-size: 12px; color: var(--secondary-text-color); margin-bottom: 16px; }
        .webhook-status-row { display: flex; align-items: center; gap: 10px; }
        .webhook-status-dot { width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0; }
        .webhook-status-dot.idle { background: var(--panel-danger); }
        .webhook-status-dot.triggered { background: var(--panel-success); }
        .webhook-status-label { font-size: 13px; font-weight: 500; color: var(--primary-text-color); }
        .webhook-timestamp { font-size: 12px; color: var(--secondary-text-color); margin-left: auto; }
        .webhook-url-display { flex: 1; font-size: 12px; padding: 8px 12px; background: var(--secondary-background-color); border-radius: 6px; color: var(--primary-text-color); cursor: text; }
        .form-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px; }
        .btn { padding: 12px 32px; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; box-sizing: border-box; }
        .topbar #alerts-btn { width: auto; min-width: 52px; padding-left: 12px; padding-right: 14px; gap: 6px; }
        .btn-primary { background: var(--panel-accent); color: #ffffff; box-shadow: 0 2px 8px var(--panel-accent-dim); }
        .btn-primary:hover { background: var(--panel-accent-hover); }
        .btn-secondary { background: var(--input-bg); color: var(--primary-text-color); border: 1px solid var(--input-border); }
        .btn-secondary:hover { background: rgba(255, 255, 255, 0.06); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        /* Entity Autocomplete */
        .entity-autocomplete-wrapper { position: relative; width: 100%; }
        .entity-autocomplete-input { width: 100%; padding: 12px 16px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--primary-text-color); font-size: 14px; }
        .entity-autocomplete-input:focus { outline: none; border-color: var(--panel-accent); box-shadow: 0 0 0 2px var(--panel-accent-dim); }
        .entity-autocomplete-input::placeholder { color: var(--secondary-text-color); opacity: 0.7; }
        /* Bento Grid Dashboard */
        .weather-dashboard { --card-radius: var(--radius-lg); --gap: 16px; }
        .bento-grid { display: grid; grid-template-columns: 2fr 1fr; gap: var(--gap); margin-bottom: var(--gap); }
        @media (max-width: 900px) { .bento-grid { grid-template-columns: 1fr; } }
        .bento-card { background: var(--card-background-color); border-radius: var(--card-radius); border: 1px solid var(--card-border); padding: 24px; }
        
        /* Hero Card */
        .hero-card { display: flex; flex-direction: column; gap: 16px; background: linear-gradient(145deg, var(--panel-accent-dim) 0%, var(--card-background-color) 100%); }
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
        
        /* Highlights Grid (bento / weather-dashboard only; main dashboard uses earlier .highlights-grid) */
        .weather-dashboard .highlights-card { display: flex; flex-direction: column; }
        .highlights-title { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--secondary-text-color); margin-bottom: 16px; }
        .weather-dashboard .highlights-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; flex: 1; }
        .highlight-item { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 16px 12px; background: var(--secondary-background-color); border-radius: 12px; text-align: center; min-height: 90px; }
        .highlight-icon { width: 28px; height: 28px; margin-bottom: 8px; opacity: 0.8; }
        .highlight-value { font-size: 18px; font-weight: 600; color: var(--primary-text-color); }
        .highlight-label { font-size: 11px; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: 0.3px; margin-top: 4px; }
        
        /* Forecast Strip */
        .forecast-row { display: grid; grid-template-columns: 1fr auto; gap: var(--gap); margin-bottom: var(--gap); }
        @media (max-width: 900px) { .forecast-row { grid-template-columns: 1fr; } }
        .forecast-card-container { background: var(--card-background-color); border-radius: var(--card-radius); border: 1px solid var(--card-border); padding: 20px; overflow: hidden; }
        .forecast-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
        .forecast-title { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--secondary-text-color); }
        .forecast-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px; background: var(--secondary-background-color); border: 1px solid var(--card-border); border-radius: 999px; width: fit-content; max-width: 100%; }
        .forecast-tab { padding: 6px 14px; background: transparent; border: none; border-radius: 999px; color: var(--secondary-text-color); cursor: pointer; font-size: 12px; font-weight: 500; transition: background 0.2s, color 0.2s; }
        .forecast-tab:hover { color: var(--primary-text-color); }
        .forecast-tab.active { background: var(--panel-accent); color: #ffffff; }
        .forecast-scroll { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 8px; scrollbar-width: thin; }
        .forecast-scroll::-webkit-scrollbar { height: 4px; }
        .forecast-scroll::-webkit-scrollbar-thumb { background: var(--card-border); border-radius: 2px; }
        .forecast-item { flex: 0 0 auto; min-width: 80px; padding: 14px 12px; background: var(--secondary-background-color); border-radius: 12px; text-align: center; transition: all 0.2s; }
        .forecast-item:hover { transform: translateY(-2px); }
        .forecast-item.current { background: linear-gradient(180deg, var(--panel-accent-dim) 0%, rgba(3, 169, 244, 0.05) 100%); }
        .forecast-item-day { font-size: 12px; font-weight: 600; color: var(--primary-text-color); margin-bottom: 8px; }
        .forecast-item-icon { width: 36px; height: 36px; margin: 0 auto 8px; }
        .forecast-item-icon .weather-icon { width: 100%; height: 100%; }
        .forecast-item-temp { font-size: 14px; font-weight: 600; color: var(--primary-text-color); }
        .forecast-item-low { font-size: 12px; color: var(--secondary-text-color); }
        .forecast-item-precip { font-size: 10px; color: var(--info-color); margin-top: 4px; }
        
        /* Moon Phase */
        .moon-card { display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 160px; background: var(--card-background-color); border-radius: var(--card-radius); border: 1px solid var(--card-border); padding: 24px; }
        .moon-title { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--secondary-text-color); margin-bottom: 12px; }
        .moon-icon { width: 80px; height: 80px; margin-bottom: 12px; }
        .moon-icon img { width: 100%; height: 100%; object-fit: contain; filter: drop-shadow(0 2px 8px rgba(0,0,0,0.15)); }
        .moon-name { font-size: 14px; font-weight: 600; color: var(--primary-text-color); text-align: center; }
        .moon-details { font-size: 11px; color: var(--secondary-text-color); margin-top: 4px; text-align: center; }
        
        /* Chart Section */
        .chart-card { background: var(--card-background-color); border-radius: var(--card-radius); border: 1px solid var(--card-border); padding: 20px; }
        .chart-title { font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--secondary-text-color); margin-bottom: 16px; }
        .chart-container { min-height: 280px; }
      </style>
      ${this._currentView === "forecast" || this._currentView === "alerts"
        ? this._currentView === "alerts"
          ? `<div class="settings-view ${this._isNarrow ? "narrow" : ""}">
            <div class="header">
              <div class="header-left">
                <button class="hamburger" id="hamburger-btn" aria-label="Open Home Assistant sidebar">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
                </button>
                <h1>NWS Alerts</h1>
              </div>
              <div class="header-right">
                <button class="header-btn" id="back-btn" aria-label="Back to dashboard" data-view="forecast">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
                  <span style="margin-left:6px;font-size:14px">Back to dashboard</span>
                </button>
              </div>
            </div>
            ${this._renderContent()}
          </div>`
          : `<div class="hud-wrapper">
            <div class="weather-app">
              <header class="topbar">
                ${this._isNarrow ? `<button class="hamburger icon-btn" id="hamburger-btn" aria-label="Open sidebar"><svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg></button>` : ""}
                <section class="title-card">
                  <div class="title-wrap">
                    <div class="title">Home Weather</div>
                  </div>
                </section>
                <section class="status-card">
                  <div class="pill"><span class="status-dot"></span>Live</div>
                  <div class="pill">v${this._version ?? "—"}</div>
                  <div class="pill pill-muted pill-update-hide-narrow" id="update-status-pill">${this._updateStatus === "available" ? "Update available" : "Latest"}</div>
                </section>
                <button class="icon-btn" id="alerts-btn" aria-label="Alerts" style="display:flex;align-items:center;gap:6px;padding:0 10px;width:auto;min-width:40px;">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
                  <span style="font-size:12px;font-weight:500;">Alerts</span>
                </button>
                <button class="icon-btn" id="gear-btn" aria-label="Settings">
                  <div class="gear"></div>
                </button>
              </header>
              <div class="content-area">
              ${this._renderContent()}
              </div>
            </div>
            <div class="footer-note">Home Weather</div>
          </div>`
        : `<div class="settings-view ${this._isNarrow ? "narrow" : ""}">
            <div class="header">
              <div class="header-left">
                <button class="hamburger" id="hamburger-btn" aria-label="Open Home Assistant sidebar">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
                </button>
                <h1>Home Weather</h1>
              </div>
              <div class="header-right">
                <button class="header-btn" id="back-btn" aria-label="Back to dashboard" data-view="forecast">
                  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
                  <span style="margin-left:6px;font-size:14px">Back to dashboard</span>
                </button>
              </div>
            </div>
            ${this._renderContent()}
          </div>`
      }
    `;
    s.getElementById("hamburger-btn")?.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true }));
    });
    const settingsBtn = s.getElementById("settings-btn");
    const gearBtn = s.getElementById("gear-btn");
    const alertsBtn = s.getElementById("alerts-btn");
    const backBtn = s.getElementById("back-btn");
    if (alertsBtn) alertsBtn.addEventListener("click", () => {
      this._currentView = "alerts";
      this._alertsData = null;
      this._alertsLoading = false;
      this._render();
    });
    if (settingsBtn) settingsBtn.addEventListener("click", () => {
      this._currentView = "settings";
      this._render();
      this._loadWebhookInfo();
    });
    if (gearBtn) gearBtn.addEventListener("click", async () => {
      this._currentView = "settings";
      await this._loadWwwSounds();
      this._render();
      this._loadWebhookInfo();
    });
    if (backBtn) backBtn.addEventListener("click", () => {
      this._syncSettingsFromForm();
      this._currentView = "forecast";
      this._render();
    });
    if (this._currentView === "settings") {
      this._attachSettingsHandlers();
    } else if (this._currentView === "forecast") {
      if (this._radarView === "chart") this._initApexChart();
      s.querySelectorAll(".dashboard .switcher button, .forecast-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (btn.dataset.radarView) {
            this._radarView = btn.dataset.radarView || "map";
          } else if (btn.dataset.view) {
            this._forecastView = btn.dataset.view || "7day";
          }
          this._updateToggleView();
        });
      });
    }
  }

  _updateToggleView() {
    const s = this.shadowRoot;
    if (!s) return;
    s.querySelectorAll(".radar-view").forEach((el) => el.classList.toggle("active", el.dataset.radarView === this._radarView));
    s.querySelectorAll(".forecast-7day-wrap, .forecast-24h-wrap").forEach((el) => el.classList.toggle("active", el.dataset.forecastView === this._forecastView));
    s.querySelectorAll(".dashboard .switcher button").forEach((btn) => {
      const active = (btn.dataset.radarView && btn.dataset.radarView === this._radarView) ||
        (btn.dataset.view && btn.dataset.view === this._forecastView);
      btn.classList.toggle("active", !!active);
    });
    if (this._radarView === "chart") this._initApexChart();
  }

  _attachSettingsHandlers() {
    const s = this.shadowRoot;
    if (!s) return;
    
    // Initialize entity autocomplete inputs
    this._initEntityAutocompletes(s);
    
    // Settings tabs
    s.querySelectorAll(".settings-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._syncSettingsFromForm();
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
    
    // Days of week: toggle switches in day-toggle-row (native checkbox handles toggle)
    
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
      const entityInput = card.querySelector(".sensor-trigger-entity");
      const stateInput = card.querySelector(".sensor-trigger-state");
      const mediaPlayerSelect = card.querySelector(".sensor-trigger-media-player");
      
      if (entityInput) {
        entityInput.addEventListener("input", () => {
          this._syncSensorTriggerFromCard(idx);
        });
        entityInput.addEventListener("change", () => {
          this._syncSensorTriggerFromCard(idx);
        });
      }
      if (stateInput) {
        stateInput.addEventListener("input", () => {
          this._syncSensorTriggerFromCard(idx);
        });
      }
      if (mediaPlayerSelect) {
        mediaPlayerSelect.addEventListener("change", () => {
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
        this._settings.tts.sensor_triggers.push({ entity_id: "", trigger_state: "on", media_player: "" });
        this._render();
      });
    }
    
    // Webhook card handlers
    s.querySelectorAll(".webhook-card").forEach((card) => {
      const idx = parseInt(card.dataset.webhookIdx, 10);
      const webhookIdInput = card.querySelector(".webhook-id");
      const nameInput = card.querySelector(".webhook-name");
      const enabledChk = card.querySelector(".webhook-enabled");
      const mediaPlayerSelect = card.querySelector(".webhook-media-player");
      
      if (webhookIdInput) {
        webhookIdInput.addEventListener("input", () => this._syncWebhookFromCard(idx));
      }
      if (nameInput) {
        nameInput.addEventListener("input", () => this._syncWebhookFromCard(idx));
      }
      if (enabledChk) {
        enabledChk.addEventListener("change", () => this._syncWebhookFromCard(idx));
      }
      if (mediaPlayerSelect) {
        mediaPlayerSelect.addEventListener("change", () => this._syncWebhookFromCard(idx));
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
        this._settings.tts.webhooks.push({ webhook_id: "", personal_name: "", enabled: true, media_player: "" });
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
          // Parse options JSON if it exists
          let optionsObj = {};
          if (mp.options) {
            if (typeof mp.options === "string" && mp.options.trim()) {
              try {
                optionsObj = JSON.parse(mp.options);
              } catch (e) {
                console.warn("Failed to parse TTS options:", e);
              }
            } else if (typeof mp.options === "object") {
              optionsObj = mp.options;
            }
          }
          
          const wsData = {
            type: "home_weather/test_tts",
            media_player_entity_id: mp.entity_id,
            tts_entity_id: ttsEntity,
            message: "This is a test of the weather announcement system.",
            volume: mp.volume || 0.6,
            cache: mp.cache || false,
          };
          
          // Only add language if non-empty
          if (mp.language && mp.language.trim()) {
            wsData.language = mp.language.trim();
          }
          
          // Only add options if non-empty object
          if (optionsObj && Object.keys(optionsObj).length > 0) {
            wsData.options = optionsObj;
          }
          
          await this._hass.callWS(wsData);
        } catch (e) {
          console.error("Test TTS failed:", e);
          alert("Test TTS failed: " + e.message);
        } finally {
          btn.textContent = "Test TTS";
          btn.disabled = false;
        }
      });
    });
    
    // Test Forecast button
    const testForecastBtn = s.getElementById("test-forecast-btn");
    if (testForecastBtn) {
      testForecastBtn.addEventListener("click", async () => {
        const originalLabel = testForecastBtn.textContent;
        testForecastBtn.textContent = "Starting...";
        testForecastBtn.disabled = true;
        try {
          await this._hass.callWS({ type: "home_weather/test_forecast" });
          testForecastBtn.textContent = "Queued";
        } catch (e) {
          console.error("Test forecast failed:", e);
          alert("Test forecast failed: " + e.message);
          testForecastBtn.textContent = originalLabel;
        } finally {
          testForecastBtn.disabled = false;
          if (testForecastBtn.textContent === "Queued") {
            setTimeout(() => {
              if (testForecastBtn.textContent === "Queued") {
                testForecastBtn.textContent = originalLabel;
              }
            }, 2500);
          }
        }
      });
    }

    // Test Current Change button
    const testCurrentChangeBtn = s.getElementById("test-current-change-btn");
    if (testCurrentChangeBtn) {
      testCurrentChangeBtn.addEventListener("click", async () => {
        const originalLabel = testCurrentChangeBtn.textContent;
        testCurrentChangeBtn.textContent = "Starting...";
        testCurrentChangeBtn.disabled = true;
        try {
          await this._hass.callWS({ type: "home_weather/test_current_change" });
          testCurrentChangeBtn.textContent = "Queued";
        } catch (e) {
          console.error("Test current change failed:", e);
          alert("Test current change failed: " + e.message);
          testCurrentChangeBtn.textContent = originalLabel;
        } finally {
          testCurrentChangeBtn.disabled = false;
          if (testCurrentChangeBtn.textContent === "Queued") {
            setTimeout(() => {
              if (testCurrentChangeBtn.textContent === "Queued") {
                testCurrentChangeBtn.textContent = originalLabel;
              }
            }, 2500);
          }
        }
      });
    }
    
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
    if (!this._hass) {
      return this._currentView === "forecast"
        ? `<section class="dashboard"><article class="glass card dashboard-message"><div class="loading">Connecting...</div></article></section>`
        : `<div class="loading">Connecting...</div>`;
    }
    if (this._loading && !this._config) {
      return this._currentView === "forecast"
        ? `<section class="dashboard"><article class="glass card dashboard-message"><div class="loading">Loading...</div></article></section>`
        : `<div class="loading">Loading...</div>`;
    }
    if (this._error && !this._config) {
      return this._currentView === "forecast"
        ? `<section class="dashboard"><article class="glass card dashboard-message"><div class="error">${String(this._error)}</div></article></section>`
        : `<div class="error">${String(this._error)}</div>`;
    }
    if (this._currentView === "forecast") return this._renderForecast();
    if (this._currentView === "alerts") return this._renderAlerts();
    return this._renderSettings();
  }

  _renderForecast() {
    if (!this._weatherData || !this._weatherData.configured) {
      return `<section class="dashboard"><article class="glass card dashboard-message"><div class="error">Weather data not available. Please configure the integration in Settings.</div></article></section>`;
    }
    const current = this._weatherData.current || {};
    const hourly = this._weatherData.hourly_forecast || [];
    const daily = (this._weatherData.daily_forecast || []).slice(0, 7);
    const h0 = hourly[0] || {};
    const now = new Date();
    const condition = current.condition || current.state || "—";
    const temp = (current.temperature ?? h0.temperature) != null ? Math.round(current.temperature ?? h0.temperature) : "—";
    const windUnit = (current.wind_speed_unit || "mph").toLowerCase();
    // Hi/Lo from today's daily forecast
    const todayDaily = daily[0] || {};
    const hiTemp = todayDaily.temperature != null ? Math.round(todayDaily.temperature) : null;
    const loTemp = todayDaily.templow != null ? Math.round(todayDaily.templow) : null;

    const graphData = hourly.slice(0, 24).map((h) => ({
      time: this._formatTime(h.datetime),
      temp: h.temperature != null ? Math.round(h.temperature) : null,
      feelsLike: h.apparent_temperature != null ? Math.round(h.apparent_temperature) : null,
      dewPoint: h.dew_point != null ? Math.round(h.dew_point) : null,
      precipAmount: h.precipitation ?? 0,
      humidity: h.humidity ?? null,
      windSpeed: h.wind_speed ?? 0,
      windGusts: h.wind_gust_speed ?? 0,
      cloudCover: h.cloud_coverage ?? null,
    }));

    this._graphData = graphData;
    this._graphWindUnit = windUnit;

    const feelsLike = (current.apparent_temperature ?? h0.apparent_temperature) != null ? Math.round(current.apparent_temperature ?? h0.apparent_temperature) : null;
    const humidity = (current.humidity ?? h0.humidity) != null ? Math.round(current.humidity ?? h0.humidity) : null;
    const windSpeed = (current.wind_speed ?? h0.wind_speed);
    const windGusts = (current.wind_gust_speed ?? h0.wind_gust_speed);

    // Moon phase
    const moon = this._getMoonPhase(now);

    // Time formatting
    const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const dateStr = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });

    const { lat, lon } = this._getHomeCoordinates();
    const windyUrl = `https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=in&metricTemp=°F&metricWind=mph&zoom=8&overlay=radar&product=radar&level=surface&lat=${lat}&lon=${lon}&pressure=true&message=true&play=1`;

    const sunTimes = this._getSunTimes(lat, lon, now);
    const sunriseStr = sunTimes.sunrise ? sunTimes.sunrise.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
    const sunsetStr = sunTimes.sunset ? sunTimes.sunset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
    const solarNoonStr = sunTimes.solar_noon ? sunTimes.solar_noon.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
    const civilBeginStr = sunTimes.civil_twilight_begin ? sunTimes.civil_twilight_begin.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
    const civilEndStr = sunTimes.civil_twilight_end ? sunTimes.civil_twilight_end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
    const dayLengthStr = sunTimes.day_length != null ? `${Math.floor(sunTimes.day_length / 3600)}h ${Math.floor((sunTimes.day_length % 3600) / 60)}m` : "—";

    this._ensureSunTimes(lat, lon, now).catch(() => {});

    const metaItems = [];
    if (hiTemp != null) metaItems.push(`H: ${hiTemp}°`);
    if (loTemp != null) metaItems.push(`L: ${loTemp}°`);
    if (feelsLike != null) metaItems.push(`Feels ${feelsLike}°`);
    if (windSpeed != null) metaItems.push(`Wind ${Math.round(windSpeed)} ${windUnit}`);
    if (windGusts != null) metaItems.push(`Gusts ${Math.round(windGusts)} ${windUnit}`);
    if (humidity != null) metaItems.push(`Hum ${humidity}%`);
    const condLabel = String(this._getConditionLabel(condition, now)).replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const moonNameSafe = String(moon.name || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `
      <section class="dashboard">
        <div class="dashboard-bento">
          <article class="glass card today-card dash-today">
            <div class="card-head">
              <div>
                <div class="card-title">Current conditions</div>
                <div class="card-sub">Live at your location</div>
              </div>
              <div class="tag">Now</div>
            </div>
            <div class="today-grid">
              <div class="today-primary">
                <div class="today-primary-row">
                  <div class="today-icon">${this._getConditionIcon(condition, "large", now)}</div>
                  <div class="today-temp-block">
                    <div><span class="today-temp">${String(temp).replace(/</g, "&lt;")}</span><span class="today-unit">°</span></div>
                    <div class="today-condition">${condLabel}</div>
                  </div>
                </div>
                <div class="today-datetime">${timeStr.replace(/</g, "&lt;").replace(/>/g, "&gt;")} · ${dateStr.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
                ${metaItems.length > 0 ? `<div class="today-chips">${metaItems.map((m) => `<span class="today-chip">${m.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</span>`).join("")}</div>` : ""}
              </div>
            </div>
          </article>

          <article class="glass card radar-panel-card dash-radar">
            <div class="card-head">
              <div>
                <div class="card-title">Radar</div>
                <div class="card-sub">Live radar and trends at your location</div>
              </div>
              <div class="switcher">
                <button type="button" class="${this._radarView === "map" ? "active" : ""}" data-radar-view="map">Map</button>
                <button type="button" class="${this._radarView === "chart" ? "active" : ""}" data-radar-view="chart">Chart</button>
              </div>
            </div>
            <div class="radar-body">
            <div class="radar-view ${this._radarView === "map" ? "active" : ""}" data-radar-view="map">
              <div class="windy-map-container">
                <iframe src="${windyUrl}" frameborder="0" title="Windy weather map" width="100%" height="100%" loading="lazy"></iframe>
              </div>
            </div>
            <div class="radar-view ${this._radarView === "chart" ? "active" : ""}" data-radar-view="chart">
              <div class="chart-container" id="apex-chart-combined"></div>
            </div>
            </div>
          </article>

          <article class="glass card forecast forecast-panel-card dash-forecast">
            <div class="forecast-top">
              <div>
                <div class="card-title">Forecast</div>
                <div class="card-sub">Daily and hourly outlook</div>
              </div>
              <div class="switcher">
                <button type="button" class="${this._forecastView === "7day" ? "active" : ""}" data-view="7day">${daily.length} day</button>
                <button type="button" class="${this._forecastView === "24h" ? "active" : ""}" data-view="24h">24 hour</button>
              </div>
            </div>
            <div class="forecast-7day-wrap ${this._forecastView === "7day" ? "active" : ""}" data-forecast-view="7day">
              <div class="forecast-strip" style="--forecast-cols: ${Math.max(1, daily.length)}">
                ${daily.map((d, i) => {
                const dHi = d.temperature != null ? Math.round(d.temperature) : "—";
                const dLo = d.templow != null ? Math.round(d.templow) : "—";
                const precipVal = this._formatPrecip(d.precipitation_probability);
                const dayLabel = this._formatDayLabel(d.datetime);
                return `
                  <div class="forecast-card ${i === 0 ? "active" : ""}">
                    <div class="day">${dayLabel}</div>
                    <div class="icon">${this._getConditionIcon(d.condition, null, null, true)}</div>
                    <div class="condition">${this._formatConditionText(d.condition)}</div>
                    <div class="temps">
                      <div class="high">${dHi}°</div>
                      <div class="low">${dLo}°</div>
                    </div>
                    <div class="rain">${precipVal}</div>
                  </div>
                `;
              }).join("")}
              </div>
            </div>
            <div class="forecast-24h-wrap ${this._forecastView === "24h" ? "active" : ""}" data-forecast-view="24h">
              <div class="forecast-strip">
                ${hourly.slice(0, 24).map((h, i) => {
                const hTemp = h.temperature != null ? Math.round(h.temperature) : "—";
                const precipVal = this._formatPrecip(h.precipitation_probability);
                const timeLabel = i === 0 ? "Now" : this._formatTime(h.datetime);
                return `
                  <div class="forecast-card ${i === 0 ? "active" : ""}">
                    <div class="day">${timeLabel}</div>
                    <div class="icon">${this._getConditionIcon(h.condition, null, h.datetime)}</div>
                    <div class="condition">${this._formatConditionText(h.condition)}</div>
                    <div class="temps">
                      <div class="high">${hTemp}°</div>
                    </div>
                    <div class="rain">${precipVal}</div>
                  </div>
                `;
              }).join("")}
              </div>
            </div>
          </article>

          <article class="glass card moon-card-fill moon-panel-card dash-moon">
            <div class="card-head">
              <div>
                <div class="card-title">Moon</div>
                <div class="card-sub">Lunar cycle at your location</div>
              </div>
            </div>
            <div class="moon-pane">
              <div class="moon-icon-wrap">
                <div class="moon-icon">
                  <img src="/local/home_weather/icons/Moon%20Phase/${moon.icon}.svg" alt="${moonNameSafe}" loading="lazy"/>
                </div>
              </div>
              <div class="moon-title">${moonNameSafe}</div>
              <div class="moon-sub">${moon.illumination}% illuminated</div>
              <div class="moon-meta">Day ${moon.daysSinceNew} · Next full in ${moon.daysToFull ?? "—"} days</div>
            </div>
          </article>

          <article class="glass card moon-card-fill sun-panel-card dash-sun">
            <div class="card-head">
              <div>
                <div class="card-title">Sun</div>
                <div class="card-sub">Solar times at your location</div>
              </div>
            </div>
            <div class="sun-pane">
              <div class="sun-stat"><span class="sun-label">Sunrise</span> ${sunriseStr}</div>
              <div class="sun-stat"><span class="sun-label">Sunset</span> ${sunsetStr}</div>
              <div class="sun-stat"><span class="sun-label">Solar noon</span> ${solarNoonStr}</div>
              <div class="sun-stat"><span class="sun-label">Day length</span> ${dayLengthStr}</div>
              <div class="sun-stat"><span class="sun-label">Civil twilight</span> ${civilBeginStr} – ${civilEndStr}</div>
              <a href="https://sunrise-sunset.org" target="_blank" rel="noopener noreferrer" class="sun-attribution">Data by sunrise-sunset.org</a>
            </div>
          </article>
        </div>
      </section>
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
        labels: { style: { colors: "#9b9b9b" }, trim: true, maxHeight: 36 },
        axisBorder: { show: false },
        axisTicks: { show: false },
      },
      grid: { borderColor: "rgba(255,255,255,0.08)", strokeDashArray: 4, xaxis: { lines: { show: false } }, yaxis: { lines: { show: true } } },
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
    
    // Destroy any existing charts to prevent duplicates
    if (this._apexCharts && this._apexCharts.length > 0) {
      this._apexCharts.forEach((chart) => {
        try {
          chart.destroy();
        } catch (e) {
          console.warn("Error destroying chart:", e);
        }
      });
      this._apexCharts = [];
    }
    
    const data = this._graphData;
    const windUnit = (this._graphWindUnit || "mph").toUpperCase();
    const tempUnit = this._useFahrenheit ? "°F" : "°C";
    try {
      await this._loadApexCharts();
      const tempVals = data.flatMap((d) => [d.temp, d.feelsLike, d.dewPoint]).filter((n) => n != null);
      const tempMin = tempVals.length ? Math.floor(Math.min(...tempVals)) - 2 : 0;
      const tempMax = tempVals.length ? Math.ceil(Math.max(...tempVals)) + 2 : 100;
      const precipAmountVals = data.map((d) => d.precipAmount).filter((n) => n != null && n > 0);
      const precipAmountMax = precipAmountVals.length ? Math.max(...precipAmountVals) * 1.2 || 0.5 : 0.5;
      const windVals = data.flatMap((d) => [d.windSpeed, d.windGusts]).filter((n) => n != null);
      const windMax = windVals.length ? Math.ceil(Math.max(...windVals)) + 5 : 50;

      const allFields = [
        { key: "temp", label: "Temperature", color: "#f44336", format: (x) => (x != null ? `${x}°` : "—"), min: tempMin, max: tempMax },
        { key: "feelsLike", label: "Feels Like", color: "#ff7043", format: (x) => (x != null ? `${x}°` : "—"), min: tempMin, max: tempMax },
        { key: "dewPoint", label: "Dew Point", color: "#ab47bc", format: (x) => (x != null ? `${x}°` : "—"), min: tempMin, max: tempMax },
        { key: "humidity", label: "Humidity", color: "#26a69a", format: (x) => (x != null ? `${x}%` : "—"), min: 0, max: 100 },
        { key: "precipAmount", label: "Precipitation Amount", color: "#29b6f6", format: (x) => (x != null ? `${x} in` : "—"), min: 0, max: precipAmountMax },
        { key: "windSpeed", label: "Wind Speed", color: "#4caf50", format: (x) => (x != null ? `${Math.round(x)} ${windUnit}` : "—"), min: 0, max: windMax },
        { key: "windGusts", label: "Wind Gusts", color: "#827717", format: (x) => (x != null ? `${Math.round(x)} ${windUnit}` : "—"), min: 0, max: windMax },
        { key: "cloudCover", label: "Cloud Cover", color: "#90a4ae", format: (x) => (x != null ? `${x}%` : "—"), min: 0, max: 100 },
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
      
      // Clear the container first
      container.innerHTML = "";
      
      const opts = {
        chart: {
          type: "line",
          height: 320,
          background: "transparent",
          toolbar: { show: false },
          zoom: { enabled: false },
          animations: { enabled: true, speed: 300 },
          fontFamily: "inherit",
        },
        colors: allFields.map((f) => f.color),
        stroke: { curve: "smooth", width: 3, lineCap: "round" },
        series,
        xaxis: {
          categories: data.map((d) => d.time),
          labels: { 
            rotate: -45, 
            rotateAlways: true,
            style: { colors: "#9b9b9b", fontSize: "10px" },
            hideOverlappingLabels: true,
          },
          axisBorder: { show: false },
          axisTicks: { show: false },
        },
        yaxis: { 
          min: 0, 
          max: 100, 
          labels: { 
            formatter: (v) => String(Math.round(v)),
            style: { colors: "#9b9b9b", fontSize: "11px" },
          }, 
          axisBorder: { show: false }, 
          axisTicks: { show: false },
        },
        grid: {
          borderColor: "rgba(255,255,255,0.08)",
          strokeDashArray: 3,
          xaxis: { lines: { show: false } },
          yaxis: { lines: { show: true } },
        },
        title: { text: "", align: "left", style: { fontSize: "14px", fontWeight: 600 } },
        tooltip: { shared: true, intersect: false, custom: tooltip, theme: "dark" },
        legend: { 
          show: true, 
          position: "top", 
          horizontalAlign: "center", 
          fontSize: "11px",
          labels: { colors: "#9b9b9b" },
          markers: { width: 10, height: 10, radius: 2 },
          itemMargin: { horizontal: 8, vertical: 4 },
        },
        markers: { size: 0, hover: { size: 5 } },
        fill: { opacity: 1 },
      };
      const ch = new ApexCharts(container, opts);
      await ch.render();
      const toHide = ["Feels Like", "Dew Point", "Humidity", "Wind Gusts", "Cloud Cover"];
      toHide.forEach((name) => ch.toggleSeries(name));
      this._apexCharts.push(ch);
    } catch (e) {
      console.error("ApexCharts init failed:", e);
    }
  }

  _renderAlerts() {
    if (!this._alertsData && !this._alertsLoading) {
      this._alertsLoading = true;
      this._fetchNwsAlerts();
      return `<div class="settings-form" style="padding:24px;"><div class="loading" style="padding:48px;text-align:center">Loading alerts...</div></div>`;
    }
    if (this._alertsLoading || !this._alertsData) {
      return `<div class="settings-form" style="padding:24px;"><div class="loading" style="padding:48px;text-align:center">Loading alerts...</div></div>`;
    }
    const alerts = this._alertsData.alerts || [];
    if (this._alertsData.error) {
      return `<div class="settings-form" style="padding:24px;"><div class="glass card" style="padding:32px;text-align:center"><p class="error">Failed to load alerts: ${String(this._alertsData.error).replace(/</g, "&lt;")}</p></div></div>`;
    }
    if (alerts.length === 0) {
      return `<div class="settings-form" style="padding:24px;"><div class="glass card" style="padding:32px;text-align:center;border-radius:var(--card-radius);border:1px solid var(--divider-color);"><p style="color:var(--primary-text-color);">No active alerts.</p></div></div>`;
    }
    const rows = alerts.map((a) => {
      const event = String(a.event || "Alert").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const descRaw = a.description || "";
      const desc = (descRaw.length > 300 ? descRaw.substring(0, 300) + "..." : descRaw).replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
      const effective = a.effective ? new Date(a.effective).toLocaleString() : "";
      const expires = a.expires ? new Date(a.expires).toLocaleString() : "";
      return `<div class="glass card" style="margin-bottom:16px;padding:20px;border-radius:var(--card-radius);border:1px solid var(--divider-color);">
        <div style="font-size:16px;font-weight:600;color:var(--primary-text-color);margin-bottom:8px;">${event}</div>
        <div style="font-size:14px;color:var(--secondary-text-color);margin-bottom:12px;line-height:1.5;">${desc}</div>
        <div style="font-size:12px;color:var(--secondary-text-color);">Effective: ${effective} | Expires: ${expires}</div>
      </div>`;
    }).join("");
    return `<div class="settings-form" style="padding:24px;"><h2 style="font-size:18px;margin-bottom:16px;color:var(--primary-text-color);">Active Weather Alerts</h2>${rows}</div>`;
  }

  _fetchNwsAlerts() {
    const { lat, lon } = this._getHomeCoordinates();
    fetch(`https://api.weather.gov/alerts/active?point=${lat},${lon}`)
      .then((r) => r.json())
      .then((data) => {
        const features = data.features || [];
        const now = new Date();
        const alerts = features
          .map((f) => f.properties || {})
          .filter((p) => {
            const exp = p.expires || p.ends;
            if (!exp) return true;
            return new Date(exp) > now;
          })
          .map((p) => ({
            id: p.id,
            event: p.event,
            description: p.description,
            headline: p.headline,
            effective: p.effective,
            expires: p.expires || p.ends,
          }));
        this._alertsData = { alerts };
        this._alertsLoading = false;
        this._render();
      })
      .catch((e) => {
        console.error("NWS alerts fetch failed:", e);
        this._alertsData = { alerts: [], error: String(e.message || e) };
        this._alertsLoading = false;
        this._render();
      });
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
    const defaultSunAlerts = { enabled: false, sunrise_tts: { enabled: false, minutes_before: 15, interval_minutes: 5 }, sunset_tts: { enabled: false, minutes_before: 15, interval_minutes: 5 }, sunrise_automation: { enabled: false, entity_id: "" }, sunset_automation: { enabled: false, entity_id: "" } };
    const sunAlerts = { ...defaultSunAlerts, ...(this._settings.sun_alerts || {}) };
    const defaultNwsAlerts = { enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9 };
    const nwsAlerts = { ...defaultNwsAlerts, ...(this._settings.nws_alerts || {}) };
    if (!sunAlerts.sunrise_tts) sunAlerts.sunrise_tts = defaultSunAlerts.sunrise_tts;
    if (!sunAlerts.sunset_tts) sunAlerts.sunset_tts = defaultSunAlerts.sunset_tts;
    if (!sunAlerts.sunrise_automation) sunAlerts.sunrise_automation = defaultSunAlerts.sunrise_automation;
    if (!sunAlerts.sunset_automation) sunAlerts.sunset_automation = defaultSunAlerts.sunset_automation;
    const automationEntities = entities.filter((e) => e.startsWith("automation."));
    
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
            ${this._renderEntityAutocomplete("weather-entity", this._settings.weather_entity || "", "weather", "Type to search weather entities...")}
          </div>
        </div>
        
        <!-- TTS Tab -->
        <div class="settings-section ${this._settingsTab === "tts" ? "active" : ""}" data-section="tts">
          
          <!-- TTS Master Toggle & Message Prefix -->
          <div class="collapsible-section open" data-section-id="tts-master">
            <div class="collapsible-content" style="display: block; padding-top: 20px;">
              ${renderToggle("tts-enabled", tts.enabled, "Enable TTS Announcements")}
              <div class="form-group" style="margin-top: var(--form-gap);">
                <label>Message Intro</label>
                <input type="text" id="message-prefix" placeholder="Here's your weather forecast" value="${messagePrefix}"/>
                <p class="form-hint" style="margin-top: 6px;">Time is announced automatically: "The time is seven oh five AM. [Your intro]. Right now it's..."</p>
              </div>
            </div>
          </div>
          
          <!-- Media Players - Each player has its own complete TTS config -->
          ${renderCollapsible("media-players", "Media Players", `${mediaPlayers.length} configured`, `
            <p class="form-hint">Each media player has its own TTS settings. Add players and configure TTS entity, volume, and options.</p>
            <div class="media-player-list" id="media-player-list">
              ${mediaPlayers.map((m, i) => `
                <div class="media-player-card" data-index="${i}">
                  <div class="media-player-row">
                    <label class="media-player-label">Media Player *</label>
                    <div class="media-player-controls">
                      <select class="media-player-select" data-field="entity_id">
                        ${mediaPlayerEntities.map((e) => `<option value="${e}" ${e === m.entity_id ? "selected" : ""}>${e}</option>`).join("")}
                      </select>
                      <button type="button" class="btn btn-secondary btn-icon" data-remove-media="${i}" aria-label="Remove">−</button>
                    </div>
                  </div>
                  <div class="media-player-row">
                    <label class="media-player-label">TTS Entity *</label>
                    <select class="media-player-tts-entity" data-field="tts_entity_id">
                      <option value="">-- Select TTS Entity --</option>
                      ${ttsEntities.map((e) => `<option value="${e}" ${e === m.tts_entity_id ? "selected" : ""}>${e}</option>`).join("")}
                    </select>
                  </div>
                  <div class="form-row-inline">
                    <div class="form-group">
                      <label>Volume</label>
                      <div class="range-slider">
                        <input type="range" class="media-player-volume" data-field="volume" min="0" max="1" step="0.05" value="${m.volume || 0.6}"/>
                        <span class="range-value">${Math.round((m.volume || 0.6) * 100)}%</span>
                      </div>
                    </div>
                    <div class="form-group" style="min-width: 100px;">
                      <label>Preroll (ms)</label>
                      <input type="number" class="media-player-preroll" data-field="preroll_ms" min="0" max="2000" step="50" value="${m.preroll_ms ?? 150}"/>
                    </div>
                    <div class="form-group settings-toggle-row" style="min-width: 140px;">
                      <label>Cache TTS</label>
                      <label class="toggle-switch">
                        <input type="checkbox" class="media-player-cache" data-field="cache" ${m.cache ? "checked" : ""}/>
                        <span class="toggle-slider"></span>
                      </label>
                    </div>
                  </div>
                  <div class="form-row-inline">
                    <div class="form-group" style="flex: 1; min-width: 120px;">
                      <label>Language</label>
                      <input type="text" class="media-player-language" data-field="language" placeholder="e.g. en, en-US" value="${m.language || ""}"/>
                    </div>
                    <div class="form-group" style="flex: 2; min-width: 180px;">
                      <label>Options (JSON)</label>
                      <input type="text" class="media-player-options" data-field="options" placeholder='{"key": "value"}' value='${JSON.stringify(m.options || {}).replace(/'/g, "&#39;")}'/>
                    </div>
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
            
            <div class="form-row-inline" style="margin-top: var(--form-gap);">
              <div class="form-group">
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
              <div class="days-of-week-grid" id="days-of-week">
                ${daysOfWeek.map((d) => `
                  <div class="day-toggle-row">
                    <span class="day-label">${dayLabels[d]}</span>
                    <label class="toggle-switch">
                      <input type="checkbox" data-day="${d}" ${tts.days_of_week.includes(d) ? "checked" : ""}/>
                      <span class="toggle-slider"></span>
                    </label>
                  </div>
                `).join("")}
              </div>
            </div>
            
            <div class="form-group" style="margin-top: var(--form-gap);">
              <button type="button" class="test-tts-btn" id="test-forecast-btn">Test Forecast</button>
              <p class="form-hint">Play the full scheduled forecast on all configured media players.</p>
            </div>
          `)}
          
          <!-- Current Change Alerts -->
          ${renderCollapsible("current-change", "Current Change Alerts", "Alert when weather changes", `
            ${renderToggle("enable-current-change", tts.enable_current_change, "Enable Current Change Alerts")}
            <div class="form-group" style="margin-top: var(--form-gap);">
              <button type="button" class="test-tts-btn" id="test-current-change-btn">Test Current Change</button>
              <p class="form-hint">Play a sample current-change alert on all configured media players.</p>
            </div>
            <p class="form-hint" style="margin-top: 12px;">Volume is controlled per media player.</p>
          `)}
          
          <!-- Upcoming Change Alerts -->
          ${renderCollapsible("upcoming-change", "Upcoming Change Alerts", "Alert before precipitation", `
            ${renderToggle("enable-upcoming-change", tts.enable_upcoming_change, "Enable Upcoming Change Alerts")}
            
            <div class="form-group" style="margin-top: var(--form-gap);">
              <label>Minutes Before to Announce</label>
              <select id="minutes-before-announce">
                <option value="15" ${tts.minutes_before_announce === 15 ? "selected" : ""}>15 minutes</option>
                <option value="30" ${tts.minutes_before_announce === 30 ? "selected" : ""}>30 minutes</option>
                <option value="45" ${tts.minutes_before_announce === 45 ? "selected" : ""}>45 minutes</option>
                <option value="60" ${tts.minutes_before_announce === 60 ? "selected" : ""}>1 hour</option>
              </select>
            </div>
          `)}
          
          <!-- Sunrise & Sunset Alerts -->
          ${renderCollapsible("sun-alerts", "Sunrise & Sunset Alerts", "TTS and automations at sunrise/sunset", `
            ${renderToggle("sun-alerts-enabled", sunAlerts.enabled, "Enable Sunrise/Sunset Alerts")}
            
            <div class="subsection-block" style="margin-top: var(--form-gap);">
              <div class="subsection-title">Sunrise TTS</div>
              ${renderToggle("sunrise-tts-enabled", sunAlerts.sunrise_tts.enabled, "Enable sunrise announcements")}
              <div class="form-row-inline" style="margin-top: var(--form-gap-sm);">
                <div class="form-group">
                  <label>Minutes before sunrise</label>
                  <input type="number" id="sunrise-minutes-before" min="5" max="60" value="${sunAlerts.sunrise_tts.minutes_before}"/>
                </div>
                <div class="form-group">
                  <label>Repeat interval (min)</label>
                  <input type="number" id="sunrise-interval-minutes" min="1" max="30" value="${sunAlerts.sunrise_tts.interval_minutes}"/>
                </div>
              </div>
              ${renderToggle("sunrise-automation-enabled", sunAlerts.sunrise_automation.enabled, "Trigger automation at sunrise")}
              <div class="form-group" style="margin-top: var(--form-gap-sm);">
                <label>Automation</label>
                ${this._renderEntityAutocomplete("sunrise-automation-entity", sunAlerts.sunrise_automation.entity_id || "", "automation", "Type to search automations...")}
              </div>
            </div>
            
            <div class="subsection-block" style="margin-top: var(--form-gap);">
              <div class="subsection-title">Sunset TTS</div>
              ${renderToggle("sunset-tts-enabled", sunAlerts.sunset_tts.enabled, "Enable sunset announcements")}
              <div class="form-row-inline" style="margin-top: var(--form-gap-sm);">
                <div class="form-group">
                  <label>Minutes before sunset</label>
                  <input type="number" id="sunset-minutes-before" min="5" max="60" value="${sunAlerts.sunset_tts.minutes_before}"/>
                </div>
                <div class="form-group">
                  <label>Repeat interval (min)</label>
                  <input type="number" id="sunset-interval-minutes" min="1" max="30" value="${sunAlerts.sunset_tts.interval_minutes}"/>
                </div>
              </div>
              ${renderToggle("sunset-automation-enabled", sunAlerts.sunset_automation.enabled, "Trigger automation at sunset")}
              <div class="form-group" style="margin-top: var(--form-gap-sm);">
                <label>Automation</label>
                ${this._renderEntityAutocomplete("sunset-automation-entity", sunAlerts.sunset_automation.entity_id || "", "automation", "Type to search automations...")}
              </div>
            </div>
          `)}
          
          <!-- NWS Alerts -->
          ${renderCollapsible("nws-alerts", "NWS Weather Alerts", "TTS and siren when National Weather Service issues alerts", `
            ${renderToggle("nws-alerts-enabled", nwsAlerts.enabled, "Enable NWS Alerts")}
            <div class="form-group" style="margin-top: var(--form-gap);">
              <label>Alert sound (plays before TTS)</label>
              <select id="nws-alerts-sound-file">
                <option value="">None</option>
                ${(this._wwwSounds || []).map((f) => `<option value="${f}" ${nwsAlerts.sound_file === f ? "selected" : ""}>${f}</option>`).join("")}
              </select>
              <p class="form-hint">Place .mp3, .wav, or .ogg files in custom_components/home_weather/www/sounds/</p>
            </div>
            <div class="form-row-inline">
              <div class="form-group">
                <label>Siren volume</label>
                ${renderSlider("nws-alerts-sound-volume", nwsAlerts.sound_volume, 0, 1, 0.05, "%")}
              </div>
              <div class="form-group">
                <label>TTS volume</label>
                ${renderSlider("nws-alerts-tts-volume", nwsAlerts.tts_volume, 0, 1, 0.05, "%")}
              </div>
            </div>
          `)}
          
          <!-- Sensor Triggered -->
          ${renderCollapsible("sensor-triggered", "Sensor Triggered", "Announce when entity state changes", `
            ${renderToggle("enable-sensor-triggered", tts.enable_sensor_triggered, "Enable Sensor-Triggered Forecasts")}
            
            <div class="form-group" style="margin-top: var(--form-gap);">
              <label>Sensor Triggers</label>
              <p class="form-hint">Add entities and define the state that triggers a TTS announcement.</p>
              <div id="sensor-triggers-list" class="media-player-list">
                ${tts.sensor_triggers.map((st, i) => `
                  <div class="media-player-card sensor-trigger-card" data-sensor-idx="${i}">
                    <div class="form-row-inline">
                      <div class="form-group" style="flex: 2; min-width: 180px;">
                        <label>Entity</label>
                        ${this._renderEntityAutocomplete(`sensor-trigger-entity-${i}`, st.entity_id || "", "all", "Type to search any entity...", "sensor-trigger-entity")}
                      </div>
                      <div class="form-group" style="flex: 1; min-width: 120px;">
                        <label>Trigger State</label>
                        <input type="text" class="sensor-trigger-state media-player-tts-entity" data-idx="${i}" placeholder="e.g. on, home, open" value="${st.trigger_state || ""}"/>
                      </div>
                    </div>
                    <div class="media-player-row">
                      <span class="media-player-label">Media Player</span>
                      <select class="sensor-trigger-media-player" data-idx="${i}" style="flex: 1;">
                        <option value="">-- All Media Players --</option>
                        ${mediaPlayers.map(mp => `<option value="${mp.entity_id}" ${st.media_player === mp.entity_id ? "selected" : ""}>${mp.entity_id}</option>`).join("")}
                      </select>
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
            
            <div class="form-group" style="margin-top: var(--form-gap);">
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
                    ` : ""}
                    <div class="form-row-inline">
                      <div class="form-group" style="flex: 1; min-width: 120px;">
                        <label>Personal Name</label>
                        <input type="text" class="webhook-name media-player-tts-entity" data-idx="${i}" placeholder="e.g. John" value="${wh.personal_name || ""}"/>
                      </div>
                      <div class="form-group" style="flex: 1; min-width: 140px;">
                        <label>Media Player</label>
                        <select class="webhook-media-player" data-idx="${i}">
                          <option value="">-- All Media Players --</option>
                          ${mediaPlayers.map(mp => `<option value="${mp.entity_id}" ${wh.media_player === mp.entity_id ? "selected" : ""}>${mp.entity_id}</option>`).join("")}
                        </select>
                      </div>
                    </div>
                    <div class="settings-toggle-row">
                      <span class="inline-toggle-label">Enabled</span>
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
            
            <div class="form-group" style="margin-top: var(--form-gap);">
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
            
            <div class="form-group" style="margin-top: var(--form-gap);">
              <label>AI Task Entity</label>
              ${this._renderEntityAutocomplete("ai-task-entity", tts.ai_task_entity || "", "ai_task", "Type to search AI task entities...")}
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

  _syncSettingsFromForm() {
    if (this._currentView !== "settings") return;
    const s = this.shadowRoot;
    if (!s) return;

    const weatherEntity = s.getElementById("weather-entity");
    if (weatherEntity) this._settings.weather_entity = weatherEntity.value || null;

    this._settings.tts = this._collectTtsSettings();
    this._settings.sun_alerts = this._collectSunAlertsSettings();
    this._settings.nws_alerts = this._collectNwsAlertsSettings();

    const messagePrefix = s.getElementById("message-prefix");
    if (messagePrefix) this._settings.message_prefix = messagePrefix.value || "Weather update";

    const cards = s.querySelectorAll("#media-player-list .media-player-card");
    if (cards.length) {
      this._settings.media_players = Array.from(cards).map((card) => {
        const entitySel = card.querySelector(".media-player-select");
        const ttsSel = card.querySelector(".media-player-tts-entity");
        const volumeSlider = card.querySelector(".media-player-volume");
        const prerollInput = card.querySelector(".media-player-preroll");
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
          preroll_ms: parseInt(prerollInput?.value || 150, 10),
          cache: !!cacheChk?.checked,
          language: (langInput?.value || "").trim(),
          options,
        };
      }).filter((m) => m.entity_id);
    }
  }

  _collectTtsSettings() {
    const s = this.shadowRoot;
    const existing = this._settings.tts || {};
    if (!s) return { ...existing };
    
    // Collect days of week (toggle switches in day-toggle-row)
    const daysOfWeek = [];
    s.querySelectorAll("#days-of-week input[type='checkbox'][data-day]:checked").forEach((el) => {
      const day = el.dataset.day;
      if (day) daysOfWeek.push(day);
    });
    
    // Collect sensor triggers and webhooks from settings state (already synced via card handlers)
    const sensorTriggers = this._settings.tts?.sensor_triggers || [];
    const webhooks = this._settings.tts?.webhooks || [];
    
    return {
      ...existing,
      enabled: s.getElementById("tts-enabled")?.checked ?? existing.enabled ?? false,
      enable_time_based: s.getElementById("enable-time-based")?.checked ?? existing.enable_time_based ?? false,
      hour_pattern: parseInt(s.getElementById("hour-pattern")?.value || existing.hour_pattern || 3, 10),
      minute_offset: parseInt(s.getElementById("minute-offset")?.value || existing.minute_offset || 3, 10),
      start_time: s.getElementById("start-time")?.value || existing.start_time || "08:00",
      end_time: s.getElementById("end-time")?.value || existing.end_time || "21:00",
      days_of_week: daysOfWeek.length > 0 ? daysOfWeek : (existing.days_of_week || ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
      enable_sensor_triggered: s.getElementById("enable-sensor-triggered")?.checked ?? existing.enable_sensor_triggered ?? false,
      sensor_triggers: sensorTriggers.filter((t) => t.entity_id),
      enable_current_change: s.getElementById("enable-current-change")?.checked ?? existing.enable_current_change ?? false,
      enable_upcoming_change: s.getElementById("enable-upcoming-change")?.checked ?? existing.enable_upcoming_change ?? false,
      minutes_before_announce: parseInt(s.getElementById("minutes-before-announce")?.value || existing.minutes_before_announce || 30, 10),
      enable_webhook: s.getElementById("enable-webhook")?.checked ?? existing.enable_webhook ?? false,
      webhooks: webhooks.filter((w) => w.webhook_id),
      enable_voice_satellite: s.getElementById("enable-voice-satellite")?.checked ?? existing.enable_voice_satellite ?? false,
      conversation_commands: s.getElementById("conversation-commands")?.value || existing.conversation_commands || "",
      precip_threshold: parseInt(s.getElementById("precip-threshold")?.value || existing.precip_threshold || 30, 10),
      hours_ahead: parseInt(s.getElementById("hours-ahead")?.value || existing.hours_ahead || 24, 10),
      hourly_segments_count: parseInt(s.getElementById("hourly-segments-count")?.value || existing.hourly_segments_count || 3, 10),
      wind_speed_threshold: parseInt(s.getElementById("wind-speed-threshold")?.value || existing.wind_speed_threshold || 15, 10),
      wind_gust_threshold: parseInt(s.getElementById("wind-gust-threshold")?.value || existing.wind_gust_threshold || 20, 10),
      daily_forecast_days: parseInt(s.getElementById("daily-forecast-days")?.value || existing.daily_forecast_days || 3, 10),
      use_ai_rewrite: s.getElementById("use-ai-rewrite")?.checked ?? existing.use_ai_rewrite ?? false,
      ai_task_entity: s.getElementById("ai-task-entity")?.value || existing.ai_task_entity || "",
      ai_rewrite_prompt: s.getElementById("ai-rewrite-prompt")?.value || existing.ai_rewrite_prompt || "",
    };
  }

  _collectSunAlertsSettings() {
    const s = this.shadowRoot;
    if (!s) return { enabled: false, sunrise_tts: { enabled: false, minutes_before: 15, interval_minutes: 5 }, sunset_tts: { enabled: false, minutes_before: 15, interval_minutes: 5 }, sunrise_automation: { enabled: false, entity_id: "" }, sunset_automation: { enabled: false, entity_id: "" } };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getNum = (id, def) => parseInt(getVal(id, String(def)), 10) || def;
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    return {
      enabled: getChecked("sun-alerts-enabled"),
      sunrise_tts: {
        enabled: getChecked("sunrise-tts-enabled"),
        minutes_before: Math.min(60, Math.max(5, getNum("sunrise-minutes-before", 15))),
        interval_minutes: Math.min(30, Math.max(1, getNum("sunrise-interval-minutes", 5))),
      },
      sunset_tts: {
        enabled: getChecked("sunset-tts-enabled"),
        minutes_before: Math.min(60, Math.max(5, getNum("sunset-minutes-before", 15))),
        interval_minutes: Math.min(30, Math.max(1, getNum("sunset-interval-minutes", 5))),
      },
      sunrise_automation: {
        enabled: getChecked("sunrise-automation-enabled"),
        entity_id: (getVal("sunrise-automation-entity", "") || "").trim(),
      },
      sunset_automation: {
        enabled: getChecked("sunset-automation-enabled"),
        entity_id: (getVal("sunset-automation-entity", "") || "").trim(),
      },
    };
  }

  _collectNwsAlertsSettings() {
    const s = this.shadowRoot;
    if (!s) return { enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9 };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    const soundVol = Math.min(1, Math.max(0, parseFloat(getVal("nws-alerts-sound-volume", "0.8"))));
    const ttsVol = Math.min(1, Math.max(0, parseFloat(getVal("nws-alerts-tts-volume", "0.9"))));
    return {
      enabled: getChecked("nws-alerts-enabled"),
      sound_file: (getVal("nws-alerts-sound-file", "") || "").trim(),
      sound_volume: soundVol,
      tts_volume: ttsVol,
    };
  }
}

customElements.define("home-weather-panel", HomeWeatherPanel);
