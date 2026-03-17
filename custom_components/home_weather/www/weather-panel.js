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
    this._moonCardView = "moon";
    this._useFahrenheit = true;
    this._weatherData = null;
    this._settings = {};
    this._settingsTab = "weather";
    this._narrow = null;
    this._graphHoverIndex = null;
    this._apexCharts = [];
    this._webhookInfo = {};  // { webhook_id: { url, last_triggered } }
    this._sunTimesCache = {};
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
      
      // Collect sun alerts
      this._settings.sun_alerts = this._collectSunAlertsSettings();
      
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
          --bg: #070a0f;
          --bg-2: #0b1017;
          --panel: rgba(17, 23, 32, 0.88);
          --panel-2: rgba(21, 28, 38, 0.94);
          --panel-3: rgba(25, 34, 46, 0.98);
          --stroke: rgba(126, 166, 255, 0.12);
          --stroke-2: rgba(126, 166, 255, 0.2);
          --text: #eef4fb;
          --muted: #93a2b8;
          --blue: #78a6ff;
          --blue-2: #99bcff;
          --cyan: #8ed8ff;
          --green: #63d7a0;
          --primary-text-color: #eef4fb;
          --secondary-text-color: #93a2b8;
          --card-background-color: rgba(17, 23, 32, 0.95);
          --divider-color: rgba(126, 166, 255, 0.12);
          --primary-color: #78a6ff;
          --primary-color-text: #070a0f;
          --accent-color: #78a6ff;
          --error-color: #ff7e7e;
          --shadow: 0 24px 60px rgba(0, 0, 0, 0.34);
          --radius-xl: 30px;
          --radius-lg: 24px;
          --radius-md: 18px;
          --radius-sm: 14px;
          --glass: saturate(135%) blur(18px);
        }
        :host { display: block; min-height: 100%; padding: 0; max-width: none; margin: 0; font-family: Inter, SF Pro Display, SF Pro Text, Arial, sans-serif;
          background: radial-gradient(circle at top left, rgba(120,166,255,0.12), transparent 24%), radial-gradient(circle at 80% 18%, rgba(142,216,255,0.06), transparent 18%), linear-gradient(180deg, #06090d 0%, #0b1017 100%);
          color: var(--text); }
        .hud-wrapper { position: relative; min-height: 100%; overflow: auto; }
        .hud-wrapper::before { content: ""; position: absolute; inset: 0; background: linear-gradient(rgba(255,255,255,0.018) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.018) 1px, transparent 1px); background-size: 48px 48px; opacity: 0.22; mask-image: radial-gradient(circle at center, black 42%, transparent 100%); pointer-events: none; }
        .hud-wrapper::after { content: ""; position: absolute; inset: 14px; border: 1px solid rgba(126,166,255,0.08); border-radius: 26px; pointer-events: none; }
        .weather-app { padding: clamp(12px, 2vw, 18px); display: grid; grid-template-rows: clamp(56px, 7vw, 78px) 1fr; gap: clamp(12px, 1.5vw, 16px); height: 100%; min-height: 0; min-width: 0; }
        .glass { background: var(--panel); border: 1px solid var(--stroke); border-radius: var(--radius-xl); box-shadow: var(--shadow); backdrop-filter: var(--glass); -webkit-backdrop-filter: var(--glass); }
        .topbar { display: flex; flex-wrap: nowrap; align-items: stretch; gap: clamp(8px, 1vw, 14px); min-width: 0; }
        .topbar .icon-btn { flex-shrink: 0; width: clamp(44px, 5vw, 56px); min-width: 44px; height: 100%; }
        .title-card { flex: 1; min-width: 0; display: flex; align-items: center; padding: 0 clamp(12px, 1.5vw, 22px); }
        .title-wrap { min-width: 0; flex: 1; overflow: hidden; }
        .eyebrow { color: var(--muted); font-size: clamp(8px, 0.9vw, 10px); letter-spacing: 0.2em; text-transform: uppercase; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .title { font-size: clamp(18px, 2.5vw, 34px); line-height: 1; font-weight: 700; letter-spacing: -0.04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .subtitle { margin-top: 2px; color: var(--muted); font-size: clamp(10px, 1.2vw, 13px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .status-card { display: flex; align-items: center; gap: clamp(6px, 0.8vw, 10px); justify-content: center; padding: 0 clamp(8px, 1vw, 14px); flex-shrink: 0; }
        .pill { height: clamp(30px, 3.5vw, 38px); padding: 0 clamp(8px, 1vw, 14px); border-radius: 999px; border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.035); display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: clamp(11px, 1.2vw, 14px); white-space: nowrap; flex-shrink: 0; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 12px rgba(99,215,160,0.42); }
        .icon-btn { border: 1px solid var(--stroke); background: var(--panel); border-radius: 18px; box-shadow: var(--shadow); display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--text); transition: 0.16s ease; backdrop-filter: var(--glass); width: 56px; height: 56px; }
        .icon-btn:hover { border-color: var(--stroke-2); background: var(--panel-2); }
        .gear { width: 20px; height: 20px; border: 2px solid var(--text); border-radius: 50%; position: relative; opacity: 0.92; }
        .gear::before { content: ""; position: absolute; inset: 5px; border: 2px solid var(--text); border-radius: 50%; }
        .content { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); grid-template-rows: 1fr auto; gap: clamp(12px, 1.5vw, 16px); min-width: 0; min-height: 0; }
        .hero { grid-column: 1; grid-row: 1; min-width: 0; }
        .highlights { grid-column: 2; grid-row: 1; min-width: 0; }
        .bottom-row { grid-column: 1 / -1; grid-row: 2; display: grid; grid-template-columns: minmax(0, 2.33fr) minmax(0, 1fr); gap: clamp(12px, 1.5vw, 16px); min-height: 0; min-width: 0; }
        .forecast { min-height: 0; min-width: 0; }
        .bottom-right { min-height: 0; min-width: 0; }
        .card { min-width: 0; min-height: 0; padding: clamp(12px, 2vw, 20px); display: flex; flex-direction: column; }
        .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: clamp(8px, 1vw, 12px); margin-bottom: clamp(12px, 1.5vw, 16px); }
        .card-title { font-size: clamp(12px, 1.5vw, 14px); font-weight: 700; letter-spacing: -0.01em; }
        .card-sub { margin-top: 4px; font-size: clamp(11px, 1.2vw, 12px); color: var(--muted); }
        .tag { height: 28px; padding: 0 12px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.04); display: inline-flex; align-items: center; color: var(--blue-2); font-size: 11px; white-space: nowrap; }
        .hero-body { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
        .hero-body-stack { }
        .hero-full-circle { position: relative; width: 100%; max-width: min(100%, 280px); aspect-ratio: 1; margin: 0 auto; flex-shrink: 0; }
        .hero-full-circle .ring-shell { width: 100%; height: 100%; position: relative; display: grid; place-items: center; z-index: 1; }
        .hero-meta-block { margin-top: 12px; text-align: center; }
        .hero-datetime-line { font-size: clamp(12px, 1.5vw, 14px); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .hero-meta-line { margin-top: 6px; font-size: clamp(11px, 1.2vw, 13px); color: var(--muted); display: flex; flex-wrap: wrap; justify-content: center; gap: clamp(6px, 1vw, 12px); }
        .hero-left { display: flex; flex-direction: column; justify-content: space-between; min-height: 0; }
        .condition-row { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; }
        .condition-row .weather-icon { width: 80px; height: 80px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; }
        .condition-row .weather-icon img { width: 88px; height: 72px; object-fit: contain; }
        .temp-row { display: flex; align-items: flex-start; gap: 10px; }
        .temp-row .value { font-size: clamp(92px, 8vw, 132px); line-height: 0.84; font-weight: 700; letter-spacing: -0.08em; }
        .temp-row .unit { margin-top: 14px; font-size: 28px; font-weight: 700; color: var(--blue-2); }
        .hero-meta { margin-top: 10px; color: var(--muted); font-size: clamp(12px, 1.5vw, 14px); display: flex; flex-wrap: wrap; gap: clamp(8px, 1vw, 18px); }
        .time-block { margin-top: 20px; }
        .time-block .time { font-size: 34px; font-weight: 700; letter-spacing: -0.04em; }
        .time-block .date { margin-top: 6px; color: var(--muted); font-size: 15px; }
        .time-block .condition { margin-top: 14px; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
        .hero-note { margin-top: 8px; color: var(--muted); font-size: 13px; line-height: 1.45; max-width: 90%; }
        .orbital { position: relative; display: flex; align-items: center; justify-content: center; min-height: 0; height: 100%; }
        .ring-shell { width: min(100%, 360px); aspect-ratio: 1; position: relative; display: grid; place-items: center; border-radius: 50%; }
        .ring { width: 72%; aspect-ratio: 1; border-radius: 50%; border: 12px solid var(--blue); background: rgba(255,255,255,0.03); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06); display: grid; place-items: center; position: relative; }
        .ring-center { text-align: center; }
        .ring-center .small { font-size: 10px; text-transform: uppercase; letter-spacing: 0.16em; color: var(--muted); }
        .ring-center .big { margin-top: 8px; font-size: clamp(44px, 4vw, 60px); font-weight: 700; letter-spacing: -0.06em; }
        .ring-center .state { margin-top: 6px; font-size: 12px; color: var(--blue-2); letter-spacing: 0.08em; white-space: nowrap; }
        .ring-center-icon { display: flex; align-items: center; justify-content: center; margin-bottom: 4px; }
        .ring-center-icon img { width: 120px; height: 96px; object-fit: contain; }
        .time-block-compact { margin-top: 12px; font-size: 18px; font-weight: 600; letter-spacing: -0.02em; color: var(--muted); }
        .highlights-grid { flex: 1; min-height: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .windy-map-container { flex: 1; min-height: 0; position: relative; aspect-ratio: 1; max-height: 100%; border-radius: 12px; overflow: hidden; }
        .windy-map-container iframe { width: 100%; height: 100%; border: none; display: block; }
        .highlight { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); border-radius: 22px; padding: 16px; min-height: 120px; display: flex; flex-direction: column; justify-content: space-between; }
        .highlight .top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .highlight .label { color: var(--muted); font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; }
        .highlight .icon { font-size: 16px; opacity: 0.95; }
        .highlight .icon img { width: 24px; height: 24px; object-fit: contain; }
        .highlight .value { font-size: 32px; font-weight: 700; letter-spacing: -0.04em; }
        .highlight .sub { color: var(--muted); font-size: 11px; }
        .windy-map-container { flex: 1; min-height: 0; position: relative; aspect-ratio: 1; max-height: 100%; border-radius: 12px; overflow: hidden; }
        .windy-map-container iframe { width: 100%; height: 100%; border: none; display: block; }
        .forecast-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
        .switcher { display: flex; align-items: center; gap: 8px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); border-radius: 999px; padding: 4px; }
        .switcher button { height: 30px; padding: 0 14px; border: 0; border-radius: 999px; background: transparent; color: var(--muted); font-size: 12px; cursor: pointer; transition: 0.16s ease; }
        .switcher button.active { background: rgba(120,166,255,0.2); color: var(--text); }
        .forecast-grid { flex: 1; min-height: 0; display: grid; gap: clamp(6px, 1vw, 10px); align-items: stretch; min-width: 0; }
        .forecast-card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); border-radius: clamp(14px, 2vw, 22px); padding: clamp(4px, 0.6vw, 12px) clamp(4px, 0.6vw, 10px); display: flex; flex-direction: column; align-items: center; justify-content: space-between; min-height: clamp(80px, 12vw, 120px); text-align: center; min-width: 0; }
        .forecast-card.active { background: rgba(120,166,255,0.12); border-color: rgba(153,188,255,0.16); }
        .forecast-card .day { font-size: clamp(9px, 1vw, 12px); color: var(--text); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
        .forecast-card .icon { margin: clamp(4px, 0.8vw, 10px) 0 clamp(2px, 0.4vw, 4px); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .forecast-card .icon img { width: clamp(28px, 4vw, 48px); height: clamp(24px, 3.5vw, 40px); object-fit: contain; }
        .forecast-card .condition { font-size: clamp(8px, 0.9vw, 11px); color: var(--muted); margin-bottom: clamp(2px, 0.4vw, 6px); text-align: center; line-height: 1.2; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .forecast-card .temps { line-height: 1.25; }
        .forecast-card .high { font-size: clamp(18px, 2.5vw, 28px); font-weight: 700; letter-spacing: -0.04em; }
        .forecast-card .low { color: var(--muted); font-size: clamp(11px, 1.2vw, 16px); }
        .forecast-card .rain { margin-top: clamp(4px, 0.6vw, 8px); color: var(--blue-2); font-size: clamp(10px, 1vw, 12px); font-weight: 600; }
        .forecast-scroll-24h { flex: 1; min-height: 0; display: flex; gap: clamp(6px, 1vw, 10px); overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; -ms-overflow-style: none; }
        .forecast-scroll-24h::-webkit-scrollbar { display: none; }
        .forecast-scroll-24h .forecast-card { min-width: clamp(64px, 8vw, 80px); flex-shrink: 0; }
        .bottom-right { display: flex; flex-direction: column; min-height: 0; overflow: hidden; border-radius: var(--radius-xl, 22px); }
        .moon-card-fill { flex: 0 0 320px; height: 320px; display: flex; flex-direction: column; align-items: center; text-align: center; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.06); border-radius: var(--radius-xl, 22px); padding: 16px; overflow: hidden; }
        .moon-card-fill .card-head { margin-bottom: 12px; flex-shrink: 0; align-self: stretch; width: 100%; }
        .moon-card-fill .card-head > div:first-child { text-align: left; }
        .moon-card { display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; }
        .moon-icon-wrap { width: 120px; height: 120px; margin-bottom: 8px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; overflow: visible; }
        .moon-card .moon-icon, .moon-card-fill .moon-icon { width: 120px; height: 120px; margin-bottom: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .moon-card-fill .moon-icon-wrapper { width: 120px; height: 120px; display: flex; align-items: center; justify-content: center; overflow: visible; }
        .moon-card-fill .moon-icon-wrapper img { transform: scale(1.5); width: 120px; height: 120px; }
        .moon-card-fill .moon-icon-wrap .moon-icon { width: 120px; height: 120px; margin: 0; transform: scale(1.55); }
        .moon-pane, .sun-pane { display: flex; flex-direction: column; align-items: center; gap: 8px; flex: 1; min-height: 0; overflow-y: auto; }
        .sun-pane .sun-stat { font-size: 13px; color: var(--text); white-space: nowrap; display: flex; justify-content: center; align-items: center; gap: 8px; }
        .sun-pane .sun-label { color: var(--muted); font-size: 12px; }
        .sun-pane .sun-attribution { margin-top: 12px; font-size: 10px; color: var(--muted); }
        .moon-card-fill .moon-meta, .moon-card-fill .moon-sun { margin-top: 8px; font-size: 12px; color: var(--muted); }
        .moon-card .moon-icon img, .moon-card-fill .moon-icon img { width: 100%; height: 100%; object-fit: contain; filter: drop-shadow(0 2px 8px rgba(0,0,0,0.2)); }
        .moon-title, .moon-card-fill .moon-title { font-size: 20px; font-weight: 600; letter-spacing: -0.02em; }
        .moon-sub, .moon-card-fill .moon-sub { margin-top: 6px; color: var(--muted); font-size: 13px; }
        .moon-pane, .sun-pane { display: flex; flex-direction: column; align-items: center; gap: 8px; width: 100%; }
        .sun-pane { text-align: center; }
        .sun-label { color: var(--muted); }
        .sun-attribution { margin-top: 8px; font-size: 10px; color: var(--muted); text-decoration: none; }
        .sun-attribution:hover { color: var(--blue-2); }
        .chart-container { flex: 1; min-height: 200px; width: 100%; }
        .radar-view { display: none; flex: 1; min-height: 0; flex-direction: column; }
        .radar-view.active { display: flex; }
        .moon-pane-wrap, .sun-pane-wrap { display: none; flex: 1; min-height: 0; flex-direction: column; }
        .moon-pane-wrap.active, .sun-pane-wrap.active { display: flex; }
        .forecast-7day-wrap, .forecast-24h-wrap { display: none; flex: 1; min-height: 0; flex-direction: column; }
        .forecast-7day-wrap.active, .forecast-24h-wrap.active { display: flex; }
        .footer-note { position: absolute; right: 22px; bottom: 18px; color: rgba(255,255,255,0.28); font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; pointer-events: none; }
        @media (min-width: 1181px) { .hud-wrapper { height: 100vh; overflow: hidden; } }
        @media (max-width: 1180px) { .weather-app { min-height: 1600px; } .content { grid-template-columns: 1fr 1fr; grid-template-rows: auto auto; align-content: start; } .bottom-row { grid-template-columns: 1fr; } .hero, .highlights { display: flex; justify-content: center; align-items: center; align-self: start; aspect-ratio: 1; width: 100%; max-width: min(100%, 50vw); flex-shrink: 0; } }
        @media (max-width: 900px) { .weather-app { padding: clamp(10px, 2vw, 14px); gap: clamp(10px, 1.5vw, 14px); } .hero-full-circle { max-width: min(100%, 240px); } }
        @media (max-width: 768px) { .weather-app { padding: 10px; } .topbar .icon-btn { width: 48px; min-width: 48px; } }
        .loading, .error { text-align: center; padding: 48px 16px; color: var(--secondary-text-color); }
        .error { color: var(--error-color); }
        .settings-view { padding: clamp(12px, 2vw, 18px); max-width: 100%; box-sizing: border-box; }
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
        /* Entity Autocomplete */
        .entity-autocomplete-wrapper { position: relative; width: 100%; }
        .entity-autocomplete-input { width: 100%; padding: 12px 16px; border: 1px solid var(--divider-color); border-radius: 8px; background: var(--card-background-color); color: var(--primary-text-color); font-size: 14px; }
        .entity-autocomplete-input:focus { outline: none; border-color: var(--accent-color); box-shadow: 0 0 0 2px rgba(66,133,244,0.15); }
        .entity-autocomplete-input::placeholder { color: var(--secondary-text-color); opacity: 0.7; }
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
      ${this._currentView === "forecast"
        ? `<div class="hud-wrapper">
            <div class="weather-app">
              <header class="topbar">
                ${this._isNarrow ? `<button class="hamburger icon-btn" id="hamburger-btn" aria-label="Open sidebar" style="width:48px;height:48px;"><svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg></button>` : ""}
                <section class="glass title-card">
                  <div class="title-wrap">
                    <div class="eyebrow">WEATHER DASHBOARD</div>
                    <div class="title">Home Weather</div>
                    <div class="subtitle">Your weather command center for live updates, forecast, and alerts</div>
                  </div>
                </section>
                <section class="glass status-card">
                  <div class="pill"><span class="status-dot"></span>Live</div>
                  <div class="pill">v${this._version ?? "—"}</div>
                  <div class="pill" id="update-status-pill">${this._updateStatus === "available" ? "Update available" : "Latest version"}</div>
                </section>
                <button class="icon-btn" id="gear-btn" aria-label="Settings">
                  <div class="gear"></div>
                </button>
              </header>
              ${this._renderContent()}
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
    const backBtn = s.getElementById("back-btn");
    if (settingsBtn) settingsBtn.addEventListener("click", () => {
      this._currentView = "settings";
      this._render();
      this._loadWebhookInfo();
    });
    if (gearBtn) gearBtn.addEventListener("click", () => {
      this._currentView = "settings";
      this._render();
      this._loadWebhookInfo();
    });
    if (backBtn) backBtn.addEventListener("click", () => { this._currentView = "forecast"; this._render(); });
    if (this._currentView === "settings") {
      this._attachSettingsHandlers();
    } else if (this._currentView === "forecast") {
      if (this._radarView === "chart") this._initApexChart();
      s.querySelectorAll(".switcher button, .forecast-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (btn.dataset.radarView) {
            this._radarView = btn.dataset.radarView || "map";
          } else if (btn.dataset.moonView) {
            this._moonCardView = btn.dataset.moonView || "moon";
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
    s.querySelectorAll(".moon-pane-wrap, .sun-pane-wrap").forEach((el) => el.classList.toggle("active", el.dataset.moonView === this._moonCardView));
    s.querySelectorAll(".forecast-7day-wrap, .forecast-24h-wrap").forEach((el) => el.classList.toggle("active", el.dataset.forecastView === this._forecastView));
    s.querySelectorAll(".switcher button").forEach((btn) => {
      const active = (btn.dataset.radarView && btn.dataset.radarView === this._radarView) ||
        (btn.dataset.moonView && btn.dataset.moonView === this._moonCardView) ||
        (btn.dataset.view && btn.dataset.view === this._forecastView);
      btn.classList.toggle("active", !!active);
    });
    const titleEl = s.getElementById("moon-card-title");
    const subEl = s.getElementById("moon-card-sub");
    if (titleEl) titleEl.textContent = this._moonCardView === "sun" ? "Sun Details" : "Moon Phase";
    if (subEl) subEl.textContent = this._moonCardView === "sun" ? "Solar times at your location" : "Lunar cycle at your location";
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
        testForecastBtn.textContent = "Playing...";
        testForecastBtn.disabled = true;
        try {
          await this._hass.callWS({ type: "home_weather/test_forecast" });
        } catch (e) {
          console.error("Test forecast failed:", e);
          alert("Test forecast failed: " + e.message);
        } finally {
          testForecastBtn.textContent = "Test Forecast";
          testForecastBtn.disabled = false;
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
        ? `<section class="content"><article class="glass card" style="grid-column:1/-1;padding:48px;text-align:center"><div class="loading">Connecting...</div></article></section>`
        : `<div class="loading">Connecting...</div>`;
    }
    if (this._loading && !this._config) {
      return this._currentView === "forecast"
        ? `<section class="content"><article class="glass card" style="grid-column:1/-1;padding:48px;text-align:center"><div class="loading">Loading...</div></article></section>`
        : `<div class="loading">Loading...</div>`;
    }
    if (this._error && !this._config) {
      return this._currentView === "forecast"
        ? `<section class="content"><article class="glass card" style="grid-column:1/-1;padding:48px;text-align:center"><div class="error">${String(this._error)}</div></article></section>`
        : `<div class="error">${String(this._error)}</div>`;
    }
    return this._currentView === "forecast" ? this._renderForecast() : this._renderSettings();
  }

  _renderForecast() {
    if (!this._weatherData || !this._weatherData.configured) {
      return `<section class="content"><article class="glass card" style="grid-column:1/-1;padding:48px;text-align:center"><div class="error">Weather data not available. Please configure the integration in Settings.</div></article></section>`;
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
    return `
      <section class="content">
        <article class="glass card hero">
          <div class="card-head">
            <div>
              <div class="card-title">Current Conditions</div>
              <div class="card-sub">Local snapshot with live time, temperature, and wind</div>
            </div>
            <div class="tag">Now</div>
          </div>
          <div class="hero-body hero-body-stack">
            <div class="hero-full-circle">
              <div class="ring-shell">
                <div class="ring">
                  <div class="ring-center">
                    <div class="ring-center-icon">${this._getConditionIcon(condition, "large", now)}</div>
                    <div class="big">${temp}°</div>
                    <div class="state">${this._getConditionLabel(condition, now)}</div>
                  </div>
                </div>
              </div>
            </div>
            <div class="hero-meta-block">
              <div class="hero-datetime-line">${timeStr.replace(/</g, "&lt;").replace(/>/g, "&gt;")} · ${dateStr.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
              ${metaItems.length > 0 ? `<div class="hero-meta-line">${metaItems.map((m) => `<span>${m.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</span>`).join("")}</div>` : ""}
            </div>
          </div>
        </article>

        <article class="glass card highlights">
          <div class="card-head">
            <div>
              <div class="card-title">Radar</div>
              <div class="card-sub">Live radar and weather at your location</div>
            </div>
            <div class="switcher">
              <button class="${this._radarView === "map" ? "active" : ""}" data-radar-view="map">Map</button>
              <button class="${this._radarView === "chart" ? "active" : ""}" data-radar-view="chart">Chart</button>
            </div>
          </div>
          <div class="radar-view ${this._radarView === "map" ? "active" : ""}" data-radar-view="map">
            <div class="windy-map-container">
              <iframe src="${windyUrl}" frameborder="0" title="Windy weather map" width="100%" height="100%" loading="lazy"></iframe>
            </div>
          </div>
          <div class="radar-view ${this._radarView === "chart" ? "active" : ""}" data-radar-view="chart">
            <div class="chart-container" id="apex-chart-combined"></div>
          </div>
        </article>

        <div class="bottom-row">
        <article class="glass card forecast">
          <div class="forecast-top">
            <div class="card-title">Forecast</div>
            <div class="switcher">
              <button class="${this._forecastView === "7day" ? "active" : ""}" data-view="7day">${daily.length} Day</button>
              <button class="${this._forecastView === "24h" ? "active" : ""}" data-view="24h">24 Hour</button>
            </div>
          </div>
          <div class="forecast-7day-wrap ${this._forecastView === "7day" ? "active" : ""}" data-forecast-view="7day">
            <div class="forecast-grid" style="grid-template-columns: repeat(${Math.max(1, daily.length)}, minmax(0, 1fr));">
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
            <div class="forecast-scroll-24h">
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

        <div class="bottom-right">
          <div class="moon-card moon-card-fill">
            <div class="card-head">
              <div>
                <div class="card-title" id="moon-card-title">${this._moonCardView === "sun" ? "Sun Details" : "Moon Phase"}</div>
                <div class="card-sub" id="moon-card-sub">${this._moonCardView === "sun" ? "Solar times at your location" : "Lunar cycle at your location"}</div>
              </div>
              <div class="switcher moon-sun-switcher">
                <button class="${this._moonCardView === "moon" ? "active" : ""}" data-moon-view="moon">Moon</button>
                <button class="${this._moonCardView === "sun" ? "active" : ""}" data-moon-view="sun">Sun</button>
              </div>
            </div>
            <div class="moon-pane-wrap ${this._moonCardView === "moon" ? "active" : ""}" data-moon-view="moon">
              <div class="moon-pane">
                <div class="moon-icon-wrap">
                  <div class="moon-icon">
                    <img src="/local/home_weather/icons/Moon%20Phase/${moon.icon}.svg" alt="${moon.name}" loading="lazy"/>
                  </div>
                </div>
                <div class="moon-title">${moon.name}</div>
                <div class="moon-sub">${moon.illumination}% illuminated</div>
                <div class="moon-meta">Day ${moon.daysSinceNew} · Next full in ${moon.daysToFull ?? "—"} days</div>
              </div>
            </div>
            <div class="sun-pane-wrap ${this._moonCardView === "sun" ? "active" : ""}" data-moon-view="sun">
              <div class="sun-pane">
                <div class="sun-stat"><span class="sun-label">Sunrise</span> ${sunriseStr}</div>
                <div class="sun-stat"><span class="sun-label">Sunset</span> ${sunsetStr}</div>
                <div class="sun-stat"><span class="sun-label">Solar noon</span> ${solarNoonStr}</div>
                <div class="sun-stat"><span class="sun-label">Day length</span> ${dayLengthStr}</div>
                <div class="sun-stat"><span class="sun-label">Civil twilight</span> ${civilBeginStr} – ${civilEndStr}</div>
                <a href="https://sunrise-sunset.org" target="_blank" rel="noopener noreferrer" class="sun-attribution">Data by sunrise-sunset.org</a>
              </div>
            </div>
          </div>
        </div>
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
        colors: ["#ff5252", "#ff7043", "#e040fb", "#448aff", "#00e5ff", "#40c4ff", "#69f0ae", "#ffab40", "#8d6e63", "#b0bec5", "#ffd740"],
        stroke: { curve: "smooth", width: 3, lineCap: "round" },
        series,
        xaxis: {
          categories: data.map((d) => d.time),
          labels: { 
            rotate: -45, 
            rotateAlways: true,
            style: { colors: "#9ca3af", fontSize: "10px" },
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
            style: { colors: "#9ca3af", fontSize: "11px" },
          }, 
          axisBorder: { show: false }, 
          axisTicks: { show: false },
        },
        grid: {
          borderColor: "rgba(255,255,255,0.1)",
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
          labels: { colors: "#9ca3af" },
          markers: { width: 10, height: 10, radius: 2 },
          itemMargin: { horizontal: 8, vertical: 4 },
        },
        markers: { size: 0, hover: { size: 5 } },
        fill: { opacity: 1 },
      };
      const ch = new ApexCharts(container, opts);
      await ch.render();
      const toHide = ["Feels Like", "Dew Point", "Precip Chance", "Humidity", "Wind Gusts", "Pressure", "Cloud Cover", "UV Index"];
      toHide.forEach((name) => ch.toggleSeries(name));
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
    const defaultSunAlerts = { enabled: false, sunrise_tts: { enabled: false, minutes_before: 15, interval_minutes: 5 }, sunset_tts: { enabled: false, minutes_before: 15, interval_minutes: 5 }, sunrise_automation: { enabled: false, entity_id: "" }, sunset_automation: { enabled: false, entity_id: "" } };
    const sunAlerts = { ...defaultSunAlerts, ...(this._settings.sun_alerts || {}) };
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
              <div class="form-group" style="margin-top: 16px;">
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
                  <div class="media-player-row">
                    <label class="media-player-label">Volume</label>
                    <div class="range-slider" style="flex:1">
                      <input type="range" class="media-player-volume" data-field="volume" min="0" max="1" step="0.05" value="${m.volume || 0.6}"/>
                      <span class="range-value">${Math.round((m.volume || 0.6) * 100)}%</span>
                    </div>
                  </div>
                  <div class="media-player-row">
                    <label class="media-player-label">Preroll (ms)</label>
                    <input type="number" class="media-player-preroll" data-field="preroll_ms" min="0" max="2000" step="50" value="${m.preroll_ms ?? 150}" style="width: 100px;"/>
                  </div>
                  <div class="media-player-row">
                    <label class="media-player-label">Cache TTS</label>
                    <label class="toggle-switch">
                      <input type="checkbox" class="media-player-cache" data-field="cache" ${m.cache ? "checked" : ""}/>
                      <span class="toggle-slider"></span>
                    </label>
                  </div>
                  <div class="media-player-row">
                    <label class="media-player-label">Language</label>
                    <input type="text" class="media-player-language" data-field="language" placeholder="e.g. en, en-US" value="${m.language || ""}"/>
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
            
            <div class="form-group" style="margin-top: 16px;">
              <button type="button" class="test-tts-btn" id="test-forecast-btn">Test Forecast</button>
              <p class="form-hint" style="margin-top: 8px;">Play the full scheduled forecast on all configured media players.</p>
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
          
          <!-- Sunrise & Sunset Alerts -->
          ${renderCollapsible("sun-alerts", "Sunrise & Sunset Alerts", "TTS and automations at sunrise/sunset", `
            ${renderToggle("sun-alerts-enabled", sunAlerts.enabled, "Enable Sunrise/Sunset Alerts")}
            
            <div class="form-group" style="margin-top: 16px;">
              <div class="collapsible-title" style="margin-bottom: 8px;">Sunrise TTS</div>
              ${renderToggle("sunrise-tts-enabled", sunAlerts.sunrise_tts.enabled, "Enable sunrise announcements")}
              <div class="form-group" style="margin-top: 12px;">
                <label>Minutes before sunrise to start</label>
                <input type="number" id="sunrise-minutes-before" min="5" max="60" value="${sunAlerts.sunrise_tts.minutes_before}"/>
              </div>
              <div class="form-group">
                <label>Repeat interval (minutes) until sunrise</label>
                <input type="number" id="sunrise-interval-minutes" min="1" max="30" value="${sunAlerts.sunrise_tts.interval_minutes}"/>
              </div>
              ${renderToggle("sunrise-automation-enabled", sunAlerts.sunrise_automation.enabled, "Trigger automation at sunrise")}
              <div class="form-group" style="margin-top: 8px;">
                <label>Automation</label>
                ${this._renderEntityAutocomplete("sunrise-automation-entity", sunAlerts.sunrise_automation.entity_id || "", "automation", "Type to search automations...")}
              </div>
            </div>
            
            <div class="form-group" style="margin-top: 20px;">
              <div class="collapsible-title" style="margin-bottom: 8px;">Sunset TTS</div>
              ${renderToggle("sunset-tts-enabled", sunAlerts.sunset_tts.enabled, "Enable sunset announcements")}
              <div class="form-group" style="margin-top: 12px;">
                <label>Minutes before sunset to start</label>
                <input type="number" id="sunset-minutes-before" min="5" max="60" value="${sunAlerts.sunset_tts.minutes_before}"/>
              </div>
              <div class="form-group">
                <label>Repeat interval (minutes) until sunset</label>
                <input type="number" id="sunset-interval-minutes" min="1" max="30" value="${sunAlerts.sunset_tts.interval_minutes}"/>
              </div>
              ${renderToggle("sunset-automation-enabled", sunAlerts.sunset_automation.enabled, "Trigger automation at sunset")}
              <div class="form-group" style="margin-top: 8px;">
                <label>Automation</label>
                ${this._renderEntityAutocomplete("sunset-automation-entity", sunAlerts.sunset_automation.entity_id || "", "automation", "Type to search automations...")}
              </div>
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
                      ${this._renderEntityAutocomplete(`sensor-trigger-entity-${i}`, st.entity_id || "", "all", "Type to search any entity...", "sensor-trigger-entity")}
                    </div>
                    <div class="media-player-row">
                      <span class="media-player-label">Trigger State</span>
                      <input type="text" class="sensor-trigger-state media-player-tts-entity" data-idx="${i}" placeholder="e.g. on, home, open" value="${st.trigger_state || ""}"/>
                    </div>
                    <div class="media-player-row">
                      <span class="media-player-label">Media Player</span>
                      <select class="sensor-trigger-media-player" data-idx="${i}">
                        <option value="">-- All Media Players --</option>
                        ${mediaPlayers.map(mp => `<option value="${mp.entity_id}" ${st.media_player === mp.entity_id ? "selected" : ""}>${mp.entity_id}</option>`).join("")}
                      </select>
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
                    ` : ""}
                    <div class="media-player-row">
                      <span class="media-player-label">Personal Name</span>
                      <input type="text" class="webhook-name media-player-tts-entity" data-idx="${i}" placeholder="e.g. John" value="${wh.personal_name || ""}"/>
                    </div>
                    <div class="media-player-row">
                      <span class="media-player-label">Media Player</span>
                      <select class="webhook-media-player" data-idx="${i}">
                        <option value="">-- All Media Players --</option>
                        ${mediaPlayers.map(mp => `<option value="${mp.entity_id}" ${wh.media_player === mp.entity_id ? "selected" : ""}>${mp.entity_id}</option>`).join("")}
                      </select>
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
      // Global TTS settings removed - now per-player in media_players array
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
}

customElements.define("home-weather-panel", HomeWeatherPanel);
