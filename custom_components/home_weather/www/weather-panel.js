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
    this._chartMetric = "temp";
    this._selectedForecast = null; // { type: "hour"|"day", index: number }
    this._radarCollapsed = false;
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
    // Subscribe to TTS status events for real playback feedback
    if (hass && !this._ttsStatusUnsub) {
      this._subscribeToTtsStatus();
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
    // Subscribe to TTS status events for real playback feedback
    this._subscribeToTtsStatus();
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
    // Unsubscribe from TTS status events
    if (this._ttsStatusUnsub) {
      this._ttsStatusUnsub();
      this._ttsStatusUnsub = null;
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

  _subscribeToTtsStatus() {
    if (!this._hass || this._ttsStatusUnsub) return;
    if (!this._pendingTtsRequests) this._pendingTtsRequests = new Map();
    try {
      this._hass.connection.subscribeEvents((event) => {
        this._handleTtsStatusEvent(event);
      }, "home_weather_tts_status").then((unsub) => {
        this._ttsStatusUnsub = unsub;
      }).catch((e) => {
        console.warn("Failed to subscribe to TTS status events:", e);
      });
    } catch (e) {
      console.warn("Error subscribing to TTS status events:", e);
    }
  }

  _handleTtsStatusEvent(event) {
    const data = (event && event.data) || {};
    const request_id = data.request_id;
    if (!request_id) return;
    const pending = this._pendingTtsRequests && this._pendingTtsRequests.get(request_id);
    if (!pending) return;

    const { btn, originalLabel, resetTimer } = pending;
    const status = data.status;
    const reason = data.reason || "";

    // Map backend status to UI label
    let label = originalLabel;
    if (status === "sent") {
      label = "Playing\u2026";
    } else if (status === "failed") {
      label = reason ? `Failed: ${this._truncate(reason, 28)}` : "Failed";
    } else if (status === "skipped") {
      label = reason ? `Skipped: ${this._truncate(reason, 28)}` : "Skipped";
    } else {
      return; // ignore unknown statuses
    }

    if (btn && this.shadowRoot && this.shadowRoot.contains(btn)) {
      btn.textContent = label;
    }

    // Clear any prior reset timer and schedule a fresh one so the label
    // persists long enough for the user to read the outcome.
    if (resetTimer) clearTimeout(resetTimer);
    if (pending.fallbackTimer) {
      clearTimeout(pending.fallbackTimer);
      pending.fallbackTimer = null;
    }
    const newTimer = setTimeout(() => {
      this._pendingTtsRequests && this._pendingTtsRequests.delete(request_id);
      if (btn && this.shadowRoot && this.shadowRoot.contains(btn)) {
        btn.textContent = originalLabel;
        btn.disabled = false;
      }
    }, 4000);
    pending.resetTimer = newTimer;
  }

  _truncate(str, n) {
    return str.length > n ? str.slice(0, n - 1) + "\u2026" : str;
  }

  _trackTtsRequest(request_id, btn, originalLabel) {
    if (!this._pendingTtsRequests) this._pendingTtsRequests = new Map();
    this._pendingTtsRequests.set(request_id, { btn, originalLabel, resetTimer: null });
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

  _renderHeaderTempPill() {
    const w = this._weatherData;
    if (!w || !w.configured) return "";
    const current = w.current || {};
    const hourly = w.hourly_forecast || [];
    const h0 = hourly[0] || {};
    const temp = (current.temperature ?? h0.temperature);
    if (temp == null) return "";
    const condition = current.condition || current.state || "";
    const icon = this._getConditionIcon(condition, null, new Date());
    return `<div class="pill header-temp-pill"><span class="header-temp-icon">${icon}</span><span class="header-temp-val">${Math.round(temp)}&deg;</span></div>`;
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
    // Preserve the Windy iframe across full re-renders to avoid reload flicker.
    const prevIframe = s.querySelector(".windy-map-container iframe");
    const prevWindyUrl = prevIframe ? prevIframe.getAttribute("src") : null;
    if (prevIframe) prevIframe.remove();
    s.innerHTML = `
      <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        :host {
          /* Panel-private tokens. HA themes cannot override these because they
             only know the standard --card-background-color etc. names. All panel
             surfaces resolve to these hardcoded dark values. */
          --hw-bg: #111111;
          --hw-surface: #1c1c1c;
          --hw-surface-2: #161616;
          --hw-elevated: #282828;
          --hw-input-bg: #282828;
          --hw-text: #e1e1e1;
          --hw-muted: #9b9b9b;
          --hw-disabled: #6f6f6f;
          --hw-accent: #03a9f4;
          --hw-accent-hover: #29b6f6;
          --hw-accent-dim: rgba(3, 169, 244, 0.15);
          --hw-danger: #f44336;
          --hw-warning: #ff9800;
          --hw-success: #4caf50;
          --hw-border: rgba(255, 255, 255, 0.08);
          --hw-border-strong: rgba(255, 255, 255, 0.12);
          --hw-hover: rgba(255, 255, 255, 0.04);

          /* Semantic aliases point at the private tokens so existing
             var(--card-background-color) references stay dark regardless of the
             active HA theme. */
          --primary-background-color: var(--hw-bg);
          --card-background-color: var(--hw-surface);
          --panel-header-background: var(--hw-surface);
          --secondary-background-color: var(--hw-elevated);
          --input-bg: var(--hw-input-bg);
          --primary-text-color: var(--hw-text);
          --secondary-text-color: var(--hw-muted);
          --disabled-text-color: var(--hw-disabled);
          --panel-accent: var(--hw-accent);
          --panel-accent-hover: var(--hw-accent-hover);
          --panel-accent-dim: var(--hw-accent-dim);
          --panel-danger: var(--hw-danger);
          --panel-warning: var(--hw-warning);
          --panel-success: var(--hw-success);
          --card-border: var(--hw-border);
          --input-border: var(--hw-border-strong);
          --divider-color: var(--hw-border);
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
          --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
          --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.35);
          --shadow-lg: 0 12px 40px rgba(0, 0, 0, 0.5);
          --radius-xl: 20px;
          --radius-lg: 16px;
          --radius-md: 12px;
          --radius-sm: 8px;
          --radius-xs: 6px;
          --space-1: 4px;
          --space-2: 8px;
          --space-3: 12px;
          --space-4: 16px;
          --space-5: 24px;
          --space-6: 32px;
          --fs-hero: clamp(64px, 18vw, 104px);
          --fs-display: clamp(28px, 6vw, 40px);
          --fs-h1: clamp(20px, 3vw, 24px);
          --fs-h2: clamp(15px, 2vw, 17px);
          --fs-body: 14px;
          --fs-small: 13px;
          --fs-xs: 11px;
          --fs-eyebrow: 10px;
          --lh-tight: 1.1;
          --lh-snug: 1.25;
          --lh-normal: 1.5;
          --ease: cubic-bezier(0.4, 0, 0.2, 1);
          --dur-fast: 0.16s;
          --dur-med: 0.24s;
          --dur-slow: 0.36s;
          --safe-top: env(safe-area-inset-top, 0px);
          --safe-bottom: env(safe-area-inset-bottom, 0px);
          --safe-left: env(safe-area-inset-left, 0px);
          --safe-right: env(safe-area-inset-right, 0px);
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
          background: var(--hw-bg);
          color: var(--hw-text);
        }
        /* Force every surface element to dark defaults so no HA theme or UA
           stylesheet can ever produce white cards/buttons. */
        :host button, :host article, :host section, :host aside {
          background: transparent;
          color: inherit;
        }
        :host button { border: none; font: inherit; }
        .hud-wrapper { position: relative; min-height: 100%; overflow: auto; }
        .hud-wrapper::before, .hud-wrapper::after { content: none; }
        .weather-app { padding: 0; display: flex; flex-direction: column; gap: 0; height: 100%; min-height: 0; min-width: 0; }
        .content-area { flex: 1; min-height: 0; min-width: 0; width: 100%; max-width: 100%; margin: 0; padding: clamp(var(--space-3), 3vw, var(--space-5)); padding-bottom: calc(clamp(var(--space-3), 3vw, var(--space-5)) + var(--safe-bottom)); box-sizing: border-box; display: flex; flex-direction: column; overflow-x: hidden; }
        @media (min-width: 1200px) {
          .content-area { max-width: 1600px; margin: 0 auto; }
        }
        .glass { background: var(--hw-surface); border: 1px solid var(--hw-border); border-radius: var(--radius-xl); box-shadow: var(--shadow); }
        .topbar {
          position: sticky;
          top: 0;
          z-index: 100;
          display: flex;
          flex-wrap: nowrap;
          align-items: center;
          gap: var(--space-2) var(--space-3);
          min-width: 0;
          padding: calc(var(--space-1) + var(--safe-top)) calc(var(--space-3) + var(--safe-right)) var(--space-1) calc(var(--space-3) + var(--safe-left));
          background: rgba(28, 28, 28, 0.72);
          backdrop-filter: blur(14px) saturate(140%);
          -webkit-backdrop-filter: blur(14px) saturate(140%);
          border-bottom: 1px solid var(--hw-border);
        }
        .topbar .icon-btn { flex-shrink: 0; width: 44px; min-width: 44px; height: 44px; }
        .title-card { flex: 1; min-width: 0; display: flex; align-items: center; padding: 0 var(--space-2) 0 0; background: transparent; border: none; box-shadow: none; border-radius: 0; }
        .title-wrap { min-width: 0; flex: 1; overflow: hidden; }
        .eyebrow { color: var(--hw-muted); font-size: var(--fs-eyebrow); letter-spacing: 0.14em; text-transform: uppercase; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .title { font-size: clamp(15px, 1.8vw, 18px); line-height: 1.2; font-weight: 600; letter-spacing: -0.02em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--hw-text); }
        .status-card { display: flex; align-items: center; gap: var(--space-2); justify-content: flex-end; padding: 0; flex-shrink: 1; flex-wrap: nowrap; min-width: 0; background: transparent; border: none; box-shadow: none; border-radius: 0; }
        .pill { min-height: 32px; height: 32px; padding: 0 var(--space-3); border-radius: 999px; border: 1px solid var(--hw-border-strong); background: var(--hw-elevated); display: inline-flex; align-items: center; gap: 5px; color: var(--hw-muted); font-size: var(--fs-xs); white-space: nowrap; flex-shrink: 0; min-width: 0; }
        .pill.pill-muted { font-size: var(--fs-eyebrow); color: var(--hw-muted); }
        .header-temp-pill { color: var(--hw-text); font-weight: 600; gap: 6px; }
        .header-temp-icon { display: inline-flex; align-items: center; }
        .header-temp-icon img { width: 20px; height: 18px; object-fit: contain; }
        .header-temp-val { font-size: var(--fs-body); font-variant-numeric: tabular-nums; }
        .status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--hw-success); box-shadow: 0 0 0 1px rgba(76, 175, 80, 0.35); }
        .icon-btn { border: 1px solid var(--hw-border-strong); background: var(--hw-input-bg); border-radius: var(--radius-sm); box-shadow: none; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--hw-text); transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease); width: 44px; height: 44px; min-width: 44px; }
        .icon-btn:hover { background: var(--hw-hover); border-color: var(--hw-border-strong); color: var(--hw-accent-hover); }
        .icon-btn:focus-visible, .switcher button:focus-visible, .nav-tab:focus-visible, .btn:focus-visible, .forecast-tab:focus-visible, .forecast-card:focus-visible, .daily-row:focus-visible, .alert-card:focus-visible { outline: 2px solid var(--hw-accent); outline-offset: 2px; }
        .icon-btn svg { width: 22px; height: 22px; }
        .dashboard { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; min-height: 0; flex: 1; padding-bottom: calc(var(--space-5) + var(--safe-bottom)); box-sizing: border-box; }
        .dashboard-message { padding: var(--space-6); text-align: center; }

        /* Hero card */
        .hero-card { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-3); padding: var(--space-5); min-width: 0; }
        .hero-eyebrow { font-size: var(--fs-eyebrow); letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
        .hero-icon { display: flex; align-items: center; justify-content: flex-start; }
        .hero-icon .weather-icon img { width: clamp(96px, 28vw, 140px); height: clamp(80px, 24vw, 120px); object-fit: contain; filter: drop-shadow(0 6px 20px rgba(0,0,0,0.4)); }
        .hero-temp-row { display: flex; align-items: flex-start; gap: var(--space-2); }
        .hero-temp { font-size: var(--fs-hero); font-weight: 700; line-height: var(--lh-tight); letter-spacing: -0.06em; font-variant-numeric: tabular-nums; color: var(--primary-text-color); }
        .hero-unit { font-size: clamp(24px, 6vw, 36px); font-weight: 700; color: var(--panel-accent-hover); line-height: 1; }
        .hero-condition { font-size: var(--fs-display); font-weight: 600; color: var(--primary-text-color); text-transform: capitalize; line-height: var(--lh-snug); }
        .hero-datetime { font-size: var(--fs-small); color: var(--muted); }
        .hero-chips { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-1); }
        .hero-chip { padding: var(--space-2) var(--space-3); min-height: 32px; border-radius: var(--radius-xs); background: var(--secondary-background-color); border: 1px solid var(--card-border); font-size: var(--fs-small); color: var(--primary-text-color); white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }

        /* Hourly snap strip */
        .hourly-card { display: flex; flex-direction: column; min-width: 0; }
        .hourly-strip { display: flex; flex-direction: row; flex-wrap: nowrap; gap: var(--space-2); overflow-x: auto; overflow-y: hidden; padding: var(--space-2) 0 var(--space-3); -webkit-overflow-scrolling: touch; scrollbar-width: none; min-width: 0; scroll-snap-type: x proximity; position: relative; }
        .hourly-strip::-webkit-scrollbar { height: 0; display: none; }
        .hourly-strip::before { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, var(--panel-accent-dim), transparent 30%); pointer-events: none; border-radius: var(--radius-md); }

        /* Forecast card (hourly strip item) */
        .forecast-card { background: var(--hw-surface); border: 1px solid var(--hw-border); border-top: 3px solid transparent; border-radius: var(--radius-md); padding: var(--space-3) var(--space-2); display: flex; flex-direction: column; align-items: center; justify-content: space-between; min-height: 120px; text-align: center; width: clamp(68px, 18vw, 84px); flex: 0 0 auto; box-sizing: border-box; cursor: pointer; transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease); scroll-snap-align: start; }
        .forecast-card:hover { background: var(--hw-hover); }
        .forecast-card:active { transform: scale(0.97); }
        .forecast-card.active { background: var(--hw-accent-dim); border-color: rgba(3, 169, 244, 0.35); border-top-color: var(--hw-accent); }
        .forecast-card .day { font-size: var(--fs-xs); color: var(--hw-text); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
        .forecast-card .icon { margin: var(--space-1) 0; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .forecast-card .icon img { width: clamp(28px, 7vw, 38px); height: clamp(24px, 6vw, 32px); object-fit: contain; }
        .forecast-card .condition { font-size: 9px; color: var(--muted); margin-bottom: var(--space-1); text-align: center; line-height: 1.2; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .forecast-card .temps { line-height: var(--lh-snug); }
        .forecast-card .high { font-size: clamp(15px, 4vw, 18px); font-weight: 700; letter-spacing: -0.04em; font-variant-numeric: tabular-nums; }
        .forecast-card .low { color: var(--muted); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
        .forecast-card .rain { margin-top: var(--space-1); color: var(--panel-accent-hover); font-size: var(--fs-xs); font-weight: 600; }

        /* Daily vertical list — explicit dark surfaces, accent left-border per day */
        .daily-card { background: var(--hw-surface-2) !important; border: 1px solid var(--hw-border) !important; }
        .daily-list { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .daily-row { display: grid; grid-template-columns: 64px 36px 1fr auto; grid-template-rows: auto; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-3) var(--space-2) calc(var(--space-3) - 3px); border-radius: var(--radius-md); border-left: 3px solid transparent; background: transparent; cursor: pointer; transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease); min-height: 48px; }
        .daily-row:hover { background: var(--hw-hover); }
        .daily-row.active { background: var(--hw-accent-dim); border-left-color: var(--hw-accent); }
        .daily-row .daily-day { font-size: var(--fs-body); font-weight: 600; color: var(--hw-text); }
        .daily-row .daily-icon { display: flex; align-items: center; justify-content: center; }
        .daily-row .daily-icon img { width: 36px; height: 30px; object-fit: contain; }
        .daily-row .daily-bar { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; }
        .daily-row .daily-precip { display: flex; align-items: center; gap: var(--space-1); font-size: var(--fs-xs); color: var(--hw-accent-hover); font-weight: 600; }
        .daily-range-track { position: relative; height: 4px; background: var(--hw-elevated); border-radius: 2px; overflow: hidden; min-width: 60px; }
        .daily-range-fill { position: absolute; top: 0; bottom: 0; background: linear-gradient(90deg, var(--hw-accent), var(--hw-warning)); border-radius: 2px; }
        .daily-row .daily-temps { display: flex; align-items: baseline; gap: var(--space-2); font-variant-numeric: tabular-nums; }
        .daily-row .daily-high { font-size: var(--fs-body); font-weight: 700; color: var(--hw-text); }
        .daily-row .daily-low { font-size: var(--fs-small); color: var(--hw-muted); }
        @media (max-width: 380px) {
          .daily-row { grid-template-columns: 52px 32px 1fr auto; gap: var(--space-2); }
          .daily-range-track { min-width: 40px; }
        }

        /* Details grid */
        .details-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--space-2); }
        @media (min-width: 768px) { .details-grid { grid-template-columns: repeat(3, 1fr); } }
        .detail-tile { background: var(--card-background-color); border: 1px solid var(--card-border); border-radius: var(--radius-md); padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; min-height: 96px; justify-content: space-between; }
        .detail-tile .detail-label { color: var(--muted); font-size: var(--fs-eyebrow); letter-spacing: 0.14em; text-transform: uppercase; }
        .detail-tile .detail-value { font-size: var(--fs-display); font-weight: 700; letter-spacing: -0.04em; font-variant-numeric: tabular-nums; line-height: 1; }
        .detail-tile .detail-sub { color: var(--muted); font-size: var(--fs-xs); }

        /* Radar card (collapsible) */
        .radar-card { display: flex; flex-direction: column; min-width: 0; }
        .radar-card .radar-body { flex: 1 0 auto; min-height: 280px; display: flex; flex-direction: column; position: relative; }
        .radar-card .radar-view { display: none; flex: 1; min-height: 0; flex-direction: column; }
        .radar-card .radar-view.active { display: flex; }
        .windy-map-container { flex: 1; min-height: clamp(200px, 40vw, 380px); min-width: 0; position: relative; aspect-ratio: 16/10; max-height: 100%; border-radius: var(--radius-md); overflow: hidden; border: 1px solid var(--card-border); background: var(--secondary-background-color); }
        .windy-map-container iframe { width: 100%; height: 100%; border: none; display: block; }
        .windy-skeleton { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: var(--fs-small); }
        .chart-container { flex: 1; min-height: clamp(220px, 36vw, 360px); min-width: 0; width: 100%; }

        /* Metric switcher */
        .metric-switcher { display: flex; align-items: center; gap: var(--space-1); background: var(--secondary-background-color); border: 1px solid var(--card-border); border-radius: 999px; padding: var(--space-1); flex-wrap: wrap; }
        .metric-switcher button { min-height: 36px; padding: var(--space-2) var(--space-3); border: 0; border-radius: 999px; background: transparent; color: var(--secondary-text-color); font-size: var(--fs-xs); cursor: pointer; transition: var(--dur-fast) var(--ease); white-space: nowrap; }
        .metric-switcher button.active { background: var(--panel-accent); color: #ffffff; }

        /* Aux row (moon + sun) */
        .aux-row { display: grid; grid-template-columns: 1fr; gap: var(--space-3); }
        @media (min-width: 960px) { .aux-row { grid-template-columns: 1fr 1fr; } }
        .moon-card-fill, .sun-panel-card { min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
        .moon-pane, .sun-pane { display: flex; flex-direction: column; gap: var(--space-2); flex: 1; min-height: 0; overflow: hidden; }
        .moon-icon-wrap { width: clamp(64px, 14vw, 96px); height: clamp(64px, 14vw, 96px); margin-bottom: var(--space-2); display: flex; align-items: center; justify-content: center; overflow: hidden; align-self: center; }
        .moon-icon { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
        .moon-icon img { width: 100%; height: 100%; object-fit: contain; filter: drop-shadow(0 2px 8px rgba(0,0,0,0.2)); }
        .moon-title { font-size: clamp(var(--fs-h2), 3vw, var(--fs-h1)); font-weight: 600; letter-spacing: -0.02em; text-align: center; }
        .moon-sub { margin-top: var(--space-1); color: var(--muted); font-size: var(--fs-small); text-align: center; }
        .moon-meta { margin-top: var(--space-1); font-size: var(--fs-xs); color: var(--muted); text-align: center; }
        .sun-panel-card .sun-pane { align-items: stretch; text-align: left; }
        .sun-stat { font-size: var(--fs-body); color: var(--text); display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); padding: var(--space-2) 0; border-bottom: 1px solid var(--card-border); }
        .sun-stat:last-of-type { border-bottom: none; }
        .sun-label { color: var(--muted); font-size: var(--fs-small); }
        .sun-attribution { margin-top: var(--space-2); font-size: var(--fs-eyebrow); color: var(--muted); text-decoration: none; }
        .sun-attribution:hover { color: var(--panel-accent-hover); }

        /* Card shell */
        .card { min-width: 0; min-height: 0; padding: var(--space-4); display: flex; flex-direction: column; overflow: hidden; }
        .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-3); }
        .card-title { font-size: var(--fs-h2); font-weight: 700; letter-spacing: -0.01em; }
        .card-sub { margin-top: 2px; font-size: var(--fs-xs); color: var(--muted); }
        .tag { min-height: 32px; height: 32px; padding: 0 var(--space-3); border-radius: 999px; border: 1px solid var(--input-border); background: var(--secondary-background-color); display: inline-flex; align-items: center; color: var(--panel-accent-hover); font-size: var(--fs-xs); white-space: nowrap; }
        .switcher { display: flex; align-items: center; gap: var(--space-1); background: var(--secondary-background-color); border: 1px solid var(--card-border); border-radius: 999px; padding: var(--space-1); }
        .switcher button { min-height: 36px; padding: var(--space-2) var(--space-3); border: 0; border-radius: 999px; background: transparent; color: var(--secondary-text-color); font-size: var(--fs-xs); cursor: pointer; transition: var(--dur-fast) var(--ease); }
        .switcher button.active { background: var(--panel-accent); color: #ffffff; }
        .forecast-top { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-2); flex-shrink: 0; flex-wrap: wrap; }
        .forecast-7day-wrap, .forecast-24h-wrap { display: none; flex: 1; min-height: 170px; flex-direction: column; }
        .forecast-7day-wrap.active, .forecast-24h-wrap.active { display: flex; }

        /* Detail sheet (bottom sheet mobile / centered desktop) */
        .detail-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); z-index: 200; opacity: 0; visibility: hidden; transition: opacity var(--dur-med) var(--ease), visibility var(--dur-med); }
        .detail-backdrop.open { opacity: 1; visibility: visible; }
        .detail-sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 201; background: var(--card-background-color); border-radius: var(--radius-xl) var(--radius-xl) 0 0; border: 1px solid var(--card-border); border-bottom: none; box-shadow: var(--shadow-lg); padding: var(--space-4); padding-bottom: calc(var(--space-5) + var(--safe-bottom)); transform: translateY(100%); transition: transform var(--dur-med) var(--ease); max-height: 85vh; overflow-y: auto; -webkit-overflow-scrolling: touch; }
        .detail-sheet.open { transform: translateY(0); }
        @media (min-width: 768px) {
          .detail-sheet { max-width: 480px; left: 50%; right: auto; transform: translate(-50%, 100%); border-radius: var(--radius-xl); border-bottom: 1px solid var(--card-border); }
          .detail-sheet.open { transform: translate(-50%, 0); top: 50%; bottom: auto; max-height: 80vh; }
        }
        .detail-sheet-handle { width: 40px; height: 4px; background: var(--input-border); border-radius: 2px; margin: 0 auto var(--space-4); }
        .detail-sheet-close { position: absolute; top: var(--space-3); right: var(--space-3); width: 44px; height: 44px; min-width: 44px; border: 1px solid var(--input-border); background: var(--input-bg); border-radius: var(--radius-sm); color: var(--text); cursor: pointer; display: flex; align-items: center; justify-content: center; }
        .detail-sheet-close svg { width: 20px; height: 20px; }
        .detail-sheet-title { font-size: var(--fs-h1); font-weight: 700; letter-spacing: -0.02em; margin-bottom: var(--space-1); padding-right: 56px; }
        .detail-sheet-sub { font-size: var(--fs-body); color: var(--muted); margin-bottom: var(--space-4); }
        .detail-sheet-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: var(--space-3); }
        .detail-sheet-item { display: flex; flex-direction: column; gap: 2px; padding: var(--space-3); background: var(--secondary-background-color); border-radius: var(--radius-sm); }
        .detail-sheet-item .label { font-size: var(--fs-eyebrow); letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
        .detail-sheet-item .value { font-size: var(--fs-h2); font-weight: 600; font-variant-numeric: tabular-nums; color: var(--primary-text-color); }

        /* Skeleton loaders */
        .skeleton-card { background: var(--card-background-color); border: 1px solid var(--card-border); border-radius: var(--radius-lg); padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-3); }
        .skeleton-line { background: linear-gradient(90deg, var(--secondary-background-color) 0%, var(--card-background-color) 50%, var(--secondary-background-color) 100%); background-size: 200% 100%; animation: shimmer 1.4s infinite; border-radius: var(--radius-xs); height: 16px; }
        .skeleton-line.wide { width: 100%; }
        .skeleton-line.half { width: 50%; }
        .skeleton-line.hero { height: 80px; width: 60%; }
        .skeleton-strip { display: flex; gap: var(--space-2); overflow: hidden; }
        .skeleton-line.card { height: 120px; width: 76px; flex: 0 0 auto; border-radius: var(--radius-md); }
        @keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

        /* Loading & error states */
        .loading, .error { text-align: center; padding: var(--space-6) var(--space-4); color: var(--secondary-text-color); }
        .error { color: var(--error-color); }

        /* Animations (respect reduced motion) */
        @media (prefers-reduced-motion: no-preference) {
          .dashboard > * { animation: cardIn var(--dur-slow) var(--ease) both; }
          .dashboard > *:nth-child(1) { animation-delay: 0s; }
          .dashboard > *:nth-child(2) { animation-delay: 0.05s; }
          .dashboard > *:nth-child(3) { animation-delay: 0.1s; }
          .dashboard > *:nth-child(4) { animation-delay: 0.15s; }
          .dashboard > *:nth-child(5) { animation-delay: 0.2s; }
          .dashboard > *:nth-child(6) { animation-delay: 0.25s; }
          .dashboard > *:nth-child(7) { animation-delay: 0.3s; }
          .radar-view.active { animation: fadeSlideIn var(--dur-med) var(--ease); }
          .detail-backdrop { transition: opacity var(--dur-med) var(--ease); }
          .detail-sheet { transition: transform var(--dur-med) var(--ease); }
        }
        @keyframes cardIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fadeSlideIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .settings-view { padding: clamp(12px, 2vw, 18px); max-width: 1800px; margin: 0 auto; width: 100%; box-sizing: border-box; }
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding-bottom: 12px; border-bottom: 1px solid var(--card-border); flex-wrap: wrap; gap: 12px; }
        .header-left { display: flex; align-items: center; gap: 12px; }
        .header-right { display: flex; align-items: center; margin-left: auto; }
        .header h1 { margin: 0; font-size: 20px; font-weight: 600; color: var(--primary-text-color); letter-spacing: -0.01em; }
        .header-title-block { display: flex; flex-direction: column; }
        .header-eyebrow { font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--secondary-text-color); }
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
        /* Alerts page */
        .alerts-page { padding: clamp(12px, 2vw, 18px); max-width: 920px; margin: 0 auto; width: 100%; box-sizing: border-box; }
        .alerts-title { font-size: 18px; font-weight: 600; color: var(--primary-text-color); margin: 0 0 16px; }
        .alerts-list { display: flex; flex-direction: column; gap: 12px; }
        .alerts-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 48px 16px; background: var(--card-background-color); border: 1px dashed var(--card-border); border-radius: var(--radius-lg); color: var(--secondary-text-color); }
        .alerts-empty svg { opacity: 0.6; }
        .alerts-empty.is-error { color: var(--panel-danger); border-color: rgba(244,67,54,0.35); }
        .alert-card { background: var(--card-background-color); border: 1px solid var(--card-border); border-left-width: 4px; border-radius: var(--radius-md); padding: 16px 20px; display: flex; flex-direction: column; gap: 10px; }
        .alert-card.sev-warning { border-left-color: var(--panel-danger); }
        .alert-card.sev-watch { border-left-color: var(--panel-warning); }
        .alert-card.sev-advisory { border-left-color: var(--panel-accent); }
        .alert-card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .alert-card-head h3 { font-size: 16px; font-weight: 600; color: var(--primary-text-color); margin: 0; flex: 1 1 60%; min-width: 0; }
        .alert-severity-icon { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .alert-card.sev-warning .alert-severity-icon { color: var(--panel-danger); }
        .alert-card.sev-watch .alert-severity-icon { color: var(--panel-warning); }
        .alert-card.sev-advisory .alert-severity-icon { color: var(--panel-accent-hover); }
        .alert-expand { margin-left: auto; width: 36px; height: 36px; min-width: 36px; border: 1px solid var(--card-border); background: var(--secondary-background-color); border-radius: var(--radius-sm); color: var(--secondary-text-color); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: transform var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease); flex-shrink: 0; }
        .alert-expand:hover { background: var(--card-border); color: var(--primary-text-color); }
        .alert-card.expanded .alert-expand { transform: rotate(180deg); }
        .alert-card-head[data-alert-toggle] { cursor: pointer; }
        .alert-desc-full { display: none; }
        .alert-card.expanded .alert-desc-full { display: block; }
        .alert-card.expanded .alert-desc:not(.alert-desc-full) { display: none; }
        .alert-pill { font-size: 10px; font-weight: 700; letter-spacing: 0.12em; padding: 3px 10px; border-radius: 999px; background: var(--secondary-background-color); color: var(--secondary-text-color); }
        .alert-card.sev-warning .alert-pill { background: rgba(244,67,54,0.15); color: #ff8a80; }
        .alert-card.sev-watch .alert-pill { background: rgba(255,152,0,0.15); color: #ffb74d; }
        .alert-card.sev-advisory .alert-pill { background: var(--panel-accent-dim); color: var(--panel-accent-hover); }
        .alert-desc { font-size: 14px; color: var(--secondary-text-color); line-height: 1.55; margin: 0; }
        .alert-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px 18px; margin: 0; padding-top: 8px; border-top: 1px solid var(--card-border); }
        .alert-meta dt { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--secondary-text-color); }
        .alert-meta dd { font-size: 13px; color: var(--primary-text-color); margin: 2px 0 0; font-variant-numeric: tabular-nums; }

        .settings-group { display: flex; flex-direction: column; gap: 12px; }
        .settings-group-title { font-size: 11px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: var(--secondary-text-color); }
        .settings-group-sub { font-size: 13px; color: var(--secondary-text-color); margin-bottom: 4px; max-width: 70ch; line-height: 1.5; }
        .form-actions-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: var(--form-gap); }
        .btn-secondary-test { background: var(--secondary-background-color); color: var(--primary-text-color); border: 1px solid var(--input-border); }
        .btn-secondary-test:hover { background: rgba(255, 255, 255, 0.06); }
        code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; padding: 1px 5px; border-radius: 4px; background: rgba(255,255,255,0.06); color: var(--panel-accent-hover); }
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
        .collapsible-section { background: var(--card-background-color); border: 1px solid var(--card-border); border-radius: var(--radius-md); overflow: hidden; transition: border-color 0.2s ease; }
        .collapsible-section.open { border-color: rgba(255,255,255,0.16); }
        .collapsible-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; cursor: pointer; user-select: none; transition: background 0.2s; gap: 12px; }
        .collapsible-header:hover { background: var(--secondary-background-color); }
        .collapsible-header-left { display: flex; align-items: center; gap: 14px; flex: 1; min-width: 0; }
        .collapsible-header-left > div:last-child { min-width: 0; }
        .collapsible-title { font-size: 15px; font-weight: 600; color: var(--primary-text-color); }
        .collapsible-subtitle { font-size: 12px; color: var(--secondary-text-color); margin-top: 2px; }
        .collapsible-chevron { width: 20px; height: 20px; color: var(--secondary-text-color); transition: transform 0.2s; flex-shrink: 0; }
        .collapsible-section.open .collapsible-chevron { transform: rotate(180deg); }
        .collapsible-content { padding: var(--section-padding); display: none; flex-direction: column; gap: var(--form-gap); }
        .collapsible-header + .collapsible-content { border-top: 1px solid var(--card-border); }
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
                ${this._renderHeaderTempPill()}
                <section class="status-card">
                  <div class="pill pill-muted pill-update-hide-narrow" id="update-status-pill">${this._updateStatus === "available" ? "Update available" : "Latest"}</div>
                </section>
                <button class="icon-btn" id="alerts-btn" aria-label="Alerts" style="display:flex;align-items:center;gap:6px;padding:0 10px;width:auto;min-width:40px;">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
                  <span style="font-size:12px;font-weight:500;">Alerts</span>
                </button>
                <button class="icon-btn" id="gear-btn" aria-label="Settings">
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94 0 .31.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
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
                <div class="header-title-block">
                  <div class="header-eyebrow">Home Weather</div>
                  <h1>Settings</h1>
                </div>
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
    // Re-insert preserved Windy iframe if the new render produced one with the same URL.
    if (prevIframe && prevWindyUrl) {
      const newContainer = s.querySelector(".windy-map-container");
      const newIframe = newContainer ? newContainer.querySelector("iframe") : null;
      if (newIframe && newIframe.getAttribute("src") === prevWindyUrl) {
        newIframe.replaceWith(prevIframe);
      }
    }
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
      if (this._radarView === "chart" && !this._radarCollapsed) this._initApexChart();
      s.querySelectorAll(".dashboard .switcher button").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (btn.dataset.radarView) {
            this._radarView = btn.dataset.radarView || "map";
            this._updateToggleView();
          }
        });
      });
      s.querySelectorAll(".metric-switcher button[data-chart-metric]").forEach((btn) => {
        btn.addEventListener("click", () => {
          this._chartMetric = btn.dataset.chartMetric || "temp";
          s.querySelectorAll(".metric-switcher button[data-chart-metric]").forEach((b) => b.classList.toggle("active", b === btn));
          this._initApexChart();
        });
      });
      s.querySelectorAll("[data-detail-hour], [data-detail-day]").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (btn.dataset.detailHour != null) {
            this._selectedForecast = { type: "hour", index: Number(btn.dataset.detailHour) };
          } else if (btn.dataset.detailDay != null) {
            this._selectedForecast = { type: "day", index: Number(btn.dataset.detailDay) };
          }
          this._openDetailSheet();
        });
      });
      s.querySelectorAll("[data-close-detail]").forEach((btn) => {
        btn.addEventListener("click", () => this._closeDetailSheet());
      });
      s.querySelectorAll("[data-toggle-radar]").forEach((hdr) => {
        hdr.addEventListener("click", () => {
          const card = hdr.closest(".collapsible-section");
          if (!card) return;
          const open = card.classList.toggle("open");
          const content = card.querySelector(".collapsible-content");
          if (content) content.style.display = open ? "flex" : "none";
          const chev = hdr.querySelector(".collapsible-chevron");
          if (chev) chev.style.transform = open ? "rotate(0deg)" : "rotate(-90deg)";
          this._radarCollapsed = !open;
          if (open && this._radarView === "chart") this._initApexChart();
        });
      });
      s.querySelectorAll("[data-retry]").forEach((btn) => {
        btn.addEventListener("click", () => { this._fetchData(); });
      });
    } else if (this._currentView === "alerts") {
      s.querySelectorAll("[data-alert-toggle], [data-alert-expand]").forEach((el) => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          const idx = el.dataset.alertToggle ?? el.dataset.alertExpand;
          if (idx == null) return;
          const card = s.querySelector(`.alert-card[data-alert-index="${idx}"]`);
          if (card) card.classList.toggle("expanded");
        });
      });
    }
  }

  _openDetailSheet() {
    const s = this.shadowRoot;
    if (!s) return;
    const backdrop = s.querySelector(".detail-backdrop");
    const sheet = s.querySelector(".detail-sheet");
    if (backdrop) backdrop.classList.add("open");
    if (sheet) sheet.classList.add("open");
  }

  _closeDetailSheet() {
    const s = this.shadowRoot;
    if (!s) return;
    const backdrop = s.querySelector(".detail-backdrop");
    const sheet = s.querySelector(".detail-sheet");
    if (backdrop) backdrop.classList.remove("open");
    if (sheet) sheet.classList.remove("open");
    this._selectedForecast = null;
  }

  _updateToggleView() {
    const s = this.shadowRoot;
    if (!s) return;
    s.querySelectorAll(".radar-view").forEach((el) => el.classList.toggle("active", el.dataset.radarView === this._radarView));
    s.querySelectorAll(".dashboard .switcher button[data-radar-view]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.radarView === this._radarView);
    });
    // Show metric switcher only in chart view
    s.querySelectorAll(".metric-switcher").forEach((el) => {
      el.style.display = this._radarView === "chart" ? "flex" : "none";
    });
    if (this._radarView === "chart") this._initApexChart();
  }

  _attachSettingsHandlers() {
    const s = this.shadowRoot;
    if (!s) return;

    // Initialize entity autocomplete inputs
    this._initEntityAutocompletes(s);

    // Weather entity
    const we = s.getElementById("weather-entity");
    if (we) we.addEventListener("change", (e) => { this._settings.weather_entity = e.target.value || null; });

    // Collapsible sections
    s.querySelectorAll(".collapsible-header").forEach((header) => {
      header.addEventListener("click", (e) => {
        // Don't toggle if clicking on the toggle switch inside header (it controls the enable flag)
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

        const originalLabel = btn.textContent;
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

          const result = await this._hass.callWS(wsData);
          const requestId = (result && result.request_id) || "";
          if (requestId) {
            this._trackTtsRequest(requestId, btn, originalLabel);
            // Fallback in case no status event arrives within 10s
            const fallback = setTimeout(() => {
              if (this._pendingTtsRequests && this._pendingTtsRequests.has(requestId)) {
                this._pendingTtsRequests.delete(requestId);
                if (this.shadowRoot && this.shadowRoot.contains(btn)) {
                  btn.textContent = originalLabel;
                  btn.disabled = false;
                }
              }
            }, 10000);
            const pending = this._pendingTtsRequests.get(requestId);
            if (pending) pending.fallbackTimer = fallback;
          } else {
            // No request_id correlation: reset after short delay
            setTimeout(() => {
              if (this.shadowRoot && this.shadowRoot.contains(btn)) {
                btn.textContent = originalLabel;
                btn.disabled = false;
              }
            }, 2500);
          }
        } catch (e) {
          console.error("Test TTS failed:", e);
          alert("Test TTS failed: " + e.message);
          btn.textContent = originalLabel;
          btn.disabled = false;
        }
      });
    });
    
    // Shared helper: wire a test button to a WS command and reflect real TTS
    // playback status (sent/failed/skipped) via the home_weather_tts_status
    // event instead of a blind "Queued" label.
    const wireStatusTestButton = (btn, wsType, busyLabel = "Sending\u2026") => {
      if (!btn) return;
      btn.addEventListener("click", async () => {
        const originalLabel = btn.textContent;
        btn.textContent = busyLabel;
        btn.disabled = true;
        try {
          const result = await this._hass.callWS({ type: wsType });
          const requestId = (result && result.request_id) || "";
          if (requestId) {
            this._trackTtsRequest(requestId, btn, originalLabel);
            // Fallback: if no status event arrives in 12s, reset label.
            const fallback = setTimeout(() => {
              if (this._pendingTtsRequests && this._pendingTtsRequests.has(requestId)) {
                this._pendingTtsRequests.delete(requestId);
                if (this.shadowRoot && this.shadowRoot.contains(btn)) {
                  btn.textContent = originalLabel;
                  btn.disabled = false;
                }
              }
            }, 12000);
            const pending = this._pendingTtsRequests.get(requestId);
            if (pending) pending.fallbackTimer = fallback;
          } else {
            // No correlation id: keep old behavior as a safe fallback.
            btn.textContent = "Queued";
            setTimeout(() => {
              if (this.shadowRoot && this.shadowRoot.contains(btn) && btn.textContent === "Queued") {
                btn.textContent = originalLabel;
                btn.disabled = false;
              }
            }, 2500);
          }
        } catch (e) {
          console.error(`${wsType} failed:`, e);
          alert(`${originalLabel} failed: ${(e && e.message) || e}`);
          btn.textContent = originalLabel;
          btn.disabled = false;
        }
      });
    };

    // Test Forecast button
    const testForecastBtn = s.getElementById("test-forecast-btn");
    wireStatusTestButton(testForecastBtn, "home_weather/test_forecast", "Starting\u2026");

    // Generic helper to wire any test-trigger button to a WebSocket command.
    const wireTestButton = (btnId, wsType, busyLabel = "Sending\u2026") => {
      const btn = s.getElementById(btnId);
      wireStatusTestButton(btn, wsType, busyLabel);
    };

    wireTestButton("test-current-change-btn", "home_weather/test_current_change");
    wireTestButton("test-upcoming-change-btn", "home_weather/test_upcoming_change");
    wireTestButton("test-sensor-btn", "home_weather/test_sensor_triggered");
    wireTestButton("test-webhook-btn", "home_weather/test_webhook");
    wireTestButton("test-sunrise-btn", "home_weather/test_sunrise");
    wireTestButton("test-sunset-btn", "home_weather/test_sunset");
    wireTestButton("test-nws-btn", "home_weather/test_nws_alert");
    
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
        ? this._renderSkeleton()
        : `<div class="loading">Loading...</div>`;
    }
    if (this._error && !this._config) {
      return this._currentView === "forecast"
        ? `<section class="dashboard"><article class="glass card dashboard-message"><div class="error">${String(this._error)}</div><button class="btn btn-primary" data-retry style="margin-top:16px;">Retry</button></article></section>`
        : `<div class="error">${String(this._error)}</div>`;
    }
    if (this._currentView === "forecast") return this._renderForecast();
    if (this._currentView === "alerts") return this._renderAlerts();
    return this._renderSettings();
  }

  _renderSkeleton() {
    return `
      <section class="dashboard">
        <article class="glass card hero-card skeleton-card" aria-busy="true" aria-label="Loading current conditions">
          <div class="skeleton-line half"></div>
          <div class="skeleton-line hero"></div>
          <div class="skeleton-line wide" style="height:24px;width:80%"></div>
          <div class="skeleton-strip">
            <div class="skeleton-line" style="height:28px;width:80px"></div>
            <div class="skeleton-line" style="height:28px;width:80px"></div>
            <div class="skeleton-line" style="height:28px;width:80px"></div>
          </div>
        </article>
        <article class="glass card hourly-card skeleton-card" aria-busy="true" aria-label="Loading hourly forecast">
          <div class="skeleton-line half"></div>
          <div class="skeleton-strip">
            ${Array.from({ length: 6 }).map(() => `<div class="skeleton-line card"></div>`).join("")}
          </div>
        </article>
        <article class="glass card daily-card skeleton-card" aria-busy="true" aria-label="Loading daily forecast">
          <div class="skeleton-line half"></div>
          ${Array.from({ length: 5 }).map(() => `<div class="skeleton-line wide" style="height:56px"></div>`).join("")}
        </article>
        <article class="glass card details-grid-card skeleton-card" aria-busy="true" aria-label="Loading details">
          <div class="skeleton-line half"></div>
          <div class="details-grid">
            ${Array.from({ length: 4 }).map(() => `<div class="detail-tile"><div class="skeleton-line half"></div><div class="skeleton-line wide" style="height:24px"></div></div>`).join("")}
          </div>
        </article>
      </section>
    `;
  }

  _renderForecast() {
    if (!this._weatherData || !this._weatherData.configured) {
      return `<section class="dashboard"><article class="glass card dashboard-message"><div class="error">Weather data not available. Please configure the integration in Settings.</div><button class="btn btn-primary" data-retry style="margin-top:16px;">Retry</button></article></section>`;
    }
    const current = this._weatherData.current || {};
    const hourly = this._weatherData.hourly_forecast || [];
    const daily = (this._weatherData.daily_forecast || []).slice(0, 7);
    const h0 = hourly[0] || {};
    const now = new Date();
    const condition = current.condition || current.state || "—";
    const temp = (current.temperature ?? h0.temperature) != null ? Math.round(current.temperature ?? h0.temperature) : "—";
    const windUnit = (current.wind_speed_unit || "mph").toLowerCase();
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
    const pressure = current.pressure;
    const uvIndex = current.uv_index;
    const dewPoint = current.dew_point;
    const cloudCoverage = current.cloud_coverage;

    const moon = this._getMoonPhase(now);

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

    // Compute week min/max for the daily range bars
    const weekTemps = daily
      .flatMap((d) => [d.templow, d.temperature])
      .filter((t) => t != null)
      .map((t) => Number(t));
    const weekMin = weekTemps.length ? Math.min(...weekTemps) : 0;
    const weekMax = weekTemps.length ? Math.max(...weekTemps) : 100;
    const weekSpan = Math.max(1, weekMax - weekMin);

    const esc = (s) => String(s).replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // Details grid tiles
    const detailTiles = [];
    if (feelsLike != null) detailTiles.push({ label: "Feels Like", value: `${feelsLike}°`, sub: temp != null && feelsLike !== temp ? `Actual ${temp}°` : "—" });
    if (humidity != null) detailTiles.push({ label: "Humidity", value: `${humidity}%`, sub: dewPoint != null ? `Dew ${Math.round(dewPoint)}°` : "—" });
    if (windSpeed != null) detailTiles.push({ label: "Wind", value: `${Math.round(windSpeed)}`, sub: `${windUnit}${windGusts != null ? ` · gusts ${Math.round(windGusts)}` : ""}` });
    if (uvIndex != null) detailTiles.push({ label: "UV Index", value: `${Math.round(uvIndex)}`, sub: uvIndex >= 8 ? "Very high" : uvIndex >= 6 ? "High" : uvIndex >= 3 ? "Moderate" : "Low" });
    if (pressure != null) detailTiles.push({ label: "Pressure", value: `${Math.round(pressure)}`, sub: current.pressure_unit || "hPa" });
    if (cloudCoverage != null) detailTiles.push({ label: "Cloud Cover", value: `${Math.round(cloudCoverage)}%`, sub: "—" });

    const chartMetric = this._chartMetric || "temp";
    const metricLabels = { temp: "Temperature", precip: "Precipitation", wind: "Wind", humidity: "Humidity" };

    return `
      <section class="dashboard">

        <article class="glass card hero-card" data-detail-hero>
          <div class="hero-eyebrow">Current conditions</div>
          <div class="hero-icon">${this._getConditionIcon(condition, "large", now)}</div>
          <div class="hero-temp-row">
            <span class="hero-temp">${String(temp).replace(/</g, "&lt;")}</span><span class="hero-unit">°</span>
          </div>
          <div class="hero-condition">${condLabel}</div>
          <div class="hero-datetime">${esc(timeStr)} · ${esc(dateStr)}</div>
          ${metaItems.length > 0 ? `<div class="hero-chips">${metaItems.map((m) => `<span class="hero-chip">${esc(m)}</span>`).join("")}</div>` : ""}
        </article>

        <article class="glass card hourly-card">
          <div class="card-head">
            <div>
              <div class="card-title">Hourly forecast</div>
              <div class="card-sub">Next 24 hours</div>
            </div>
          </div>
          <div class="hourly-strip">
            ${hourly.slice(0, 24).map((h, i) => {
              const hTemp = h.temperature != null ? Math.round(h.temperature) : "—";
              const precipVal = this._formatPrecip(h.precipitation_probability);
              const timeLabel = i === 0 ? "Now" : this._formatTime(h.datetime);
              return `
                <button type="button" class="forecast-card ${i === 0 ? "active" : ""}" data-detail-hour="${i}" aria-label="Forecast for ${esc(timeLabel)}">
                  <div class="day">${esc(timeLabel)}</div>
                  <div class="icon">${this._getConditionIcon(h.condition, null, h.datetime)}</div>
                  <div class="temps"><div class="high">${hTemp}°</div></div>
                  <div class="rain">${precipVal}</div>
                </button>
              `;
            }).join("")}
          </div>
        </article>

        <article class="glass card daily-card">
          <div class="forecast-top">
            <div>
              <div class="card-title">${daily.length}-day forecast</div>
              <div class="card-sub">Daily outlook</div>
            </div>
          </div>
          <div class="daily-list">
            ${daily.map((d, i) => {
              const dHi = d.temperature != null ? Math.round(d.temperature) : null;
              const dLo = d.templow != null ? Math.round(d.templow) : null;
              const precipVal = this._formatPrecip(d.precipitation_probability);
              const dayLabel = this._formatDayLabel(d.datetime);
              const condText = this._formatConditionText(d.condition);
              // Range bar position (0-100%)
              let fillLeft = 0, fillWidth = 100;
              if (dHi != null && dLo != null) {
                fillLeft = Math.max(0, Math.min(100, ((dLo - weekMin) / weekSpan) * 100));
                fillWidth = Math.max(4, Math.min(100 - fillLeft, ((dHi - dLo) / weekSpan) * 100));
              }
              return `
                <button type="button" class="daily-row ${i === 0 ? "active" : ""}" data-detail-day="${i}" aria-label="Forecast for ${esc(dayLabel)}">
                  <span class="daily-day">${esc(dayLabel)}</span>
                  <span class="daily-icon">${this._getConditionIcon(d.condition, null, null, true)}</span>
                  <span class="daily-bar">
                    ${precipVal && precipVal !== "0%" ? `<span class="daily-precip">${precipVal}</span>` : ""}
                    <span class="daily-range-track"><span class="daily-range-fill" style="left:${fillLeft}%;width:${fillWidth}%"></span></span>
                  </span>
                  <span class="daily-temps">
                    <span class="daily-high">${dHi ?? "—"}°</span>
                    <span class="daily-low">${dLo ?? "—"}°</span>
                  </span>
                </button>
              `;
            }).join("")}
          </div>
        </article>

        ${detailTiles.length > 0 ? `
        <article class="glass card details-grid-card">
          <div class="card-head"><div><div class="card-title">Details</div><div class="card-sub">Current conditions breakdown</div></div></div>
          <div class="details-grid">
            ${detailTiles.map((t) => `
              <div class="detail-tile">
                <div class="detail-label">${esc(t.label)}</div>
                <div class="detail-value">${esc(t.value)}</div>
                <div class="detail-sub">${esc(t.sub)}</div>
              </div>
            `).join("")}
          </div>
        </article>
        ` : ""}

        <article class="glass card radar-card collapsible-section open" data-section-id="radar">
          <div class="collapsible-header" data-toggle-radar>
            <div class="collapsible-header-left">
              <div>
                <div class="collapsible-title">Radar &amp; trends</div>
                <div class="collapsible-subtitle">Live map and hourly chart</div>
              </div>
            </div>
            <svg class="collapsible-chevron" viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
          </div>
          <div class="collapsible-content" style="display:flex;">
            <div class="forecast-top" style="width:100%;">
              <div class="switcher">
                <button type="button" class="${this._radarView === "map" ? "active" : ""}" data-radar-view="map">Map</button>
                <button type="button" class="${this._radarView === "chart" ? "active" : ""}" data-radar-view="chart">Chart</button>
              </div>
              ${this._radarView === "chart" ? `
              <div class="metric-switcher">
                ${Object.entries(metricLabels).map(([key, label]) => `<button type="button" class="${chartMetric === key ? "active" : ""}" data-chart-metric="${key}">${label}</button>`).join("")}
              </div>
              ` : ""}
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
          </div>
        </article>

        <div class="aux-row">
          <article class="glass card moon-card-fill">
            <div class="card-head"><div><div class="card-title">Moon</div><div class="card-sub">Lunar cycle</div></div></div>
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

          <article class="glass card sun-panel-card">
            <div class="card-head"><div><div class="card-title">Sun</div><div class="card-sub">Solar times</div></div></div>
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
      ${this._renderDetailSheet()}
    `;
  }

  _renderDetailSheet() {
    const sel = this._selectedForecast;
    if (!sel) return "";
    const hourly = (this._weatherData?.hourly_forecast) || [];
    const daily = ((this._weatherData?.daily_forecast) || []).slice(0, 7);
    const { lat, lon } = this._getHomeCoordinates();
    const sunTimes = this._getSunTimes(lat, lon, new Date());

    let title = "", sub = "", items = [];
    if (sel.type === "hour" && hourly[sel.index]) {
      const h = hourly[sel.index];
      const t = h.temperature != null ? Math.round(h.temperature) : "—";
      const timeLabel = sel.index === 0 ? "Now" : this._formatTime(h.datetime);
      title = `${t}°`;
      sub = `${timeLabel} · ${this._formatConditionText(h.condition)}`;
      const windUnit = (this._weatherData?.current?.wind_speed_unit || "mph").toLowerCase();
      items = [
        { label: "Feels Like", value: h.apparent_temperature != null ? `${Math.round(h.apparent_temperature)}°` : "—" },
        { label: "Precipitation", value: this._formatPrecip(h.precipitation_probability) },
        { label: "Precip Amount", value: h.precipitation != null ? `${h.precipitation}` : "—" },
        { label: "Wind", value: h.wind_speed != null ? `${Math.round(h.wind_speed)} ${windUnit}` : "—" },
        { label: "Wind Gusts", value: h.wind_gust_speed != null ? `${Math.round(h.wind_gust_speed)} ${windUnit}` : "—" },
        { label: "Humidity", value: h.humidity != null ? `${Math.round(h.humidity)}%` : "—" },
        { label: "Dew Point", value: h.dew_point != null ? `${Math.round(h.dew_point)}°` : "—" },
        { label: "Cloud Cover", value: h.cloud_coverage != null ? `${Math.round(h.cloud_coverage)}%` : "—" },
      ];
    } else if (sel.type === "day" && daily[sel.index]) {
      const d = daily[sel.index];
      const hi = d.temperature != null ? Math.round(d.temperature) : "—";
      const lo = d.templow != null ? Math.round(d.templow) : "—";
      const dayLabel = this._formatDayLabel(d.datetime);
      title = `${hi}° / ${lo}°`;
      sub = `${dayLabel} · ${this._formatConditionText(d.condition)}`;
      items = [
        { label: "High", value: `${hi}°` },
        { label: "Low", value: `${lo}°` },
        { label: "Precipitation", value: this._formatPrecip(d.precipitation_probability) },
        { label: "Precip Amount", value: d.precipitation != null ? `${d.precipitation}` : "—" },
        { label: "Wind", value: d.wind_speed != null ? `${Math.round(d.wind_speed)}` : "—" },
        { label: "Sunrise", value: sunTimes.sunrise ? sunTimes.sunrise.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—" },
        { label: "Sunset", value: sunTimes.sunset ? sunTimes.sunset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—" },
        { label: "UV Index", value: d.uv_index != null ? `${Math.round(d.uv_index)}` : "—" },
      ];
    }

    const esc = (s) => String(s).replace(/</g, "&lt;").replace(/>/g, "&gt;");

    return `
      <div class="detail-backdrop ${sel ? "open" : ""}" data-close-detail></div>
      <div class="detail-sheet ${sel ? "open" : ""}" role="dialog" aria-modal="true" aria-label="Forecast details">
        <div class="detail-sheet-handle"></div>
        <button class="detail-sheet-close" data-close-detail aria-label="Close">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
        </button>
        <div class="detail-sheet-title">${esc(title)}</div>
        <div class="detail-sheet-sub">${esc(sub)}</div>
        <div class="detail-sheet-grid">
          ${items.map((it) => `
            <div class="detail-sheet-item">
              <div class="label">${esc(it.label)}</div>
              <div class="value">${esc(it.value)}</div>
            </div>
          `).join("")}
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

    if (this._apexCharts && this._apexCharts.length > 0) {
      this._apexCharts.forEach((chart) => {
        try { chart.destroy(); } catch (e) { console.warn("Error destroying chart:", e); }
      });
      this._apexCharts = [];
    }

    const data = this._graphData;
    const windUnit = (this._graphWindUnit || "mph").toUpperCase();
    const metric = this._chartMetric || "temp";

    try {
      await this._loadApexCharts();

      const metricDefs = {
        temp: {
          fields: [
            { key: "temp", label: "Temperature", color: "#f44336", format: (x) => (x != null ? `${x}°` : "—") },
            { key: "feelsLike", label: "Feels Like", color: "#ff7043", format: (x) => (x != null ? `${x}°` : "—") },
            { key: "dewPoint", label: "Dew Point", color: "#ab47bc", format: (x) => (x != null ? `${x}°` : "—") },
          ],
          min: () => {
            const vals = data.flatMap((d) => [d.temp, d.feelsLike, d.dewPoint]).filter((n) => n != null);
            return vals.length ? Math.floor(Math.min(...vals)) - 2 : 0;
          },
          max: () => {
            const vals = data.flatMap((d) => [d.temp, d.feelsLike, d.dewPoint]).filter((n) => n != null);
            return vals.length ? Math.ceil(Math.max(...vals)) + 2 : 100;
          },
        },
        precip: {
          fields: [
            { key: "precipAmount", label: "Precipitation", color: "#29b6f6", format: (x) => (x != null ? `${x} in` : "—") },
          ],
          min: () => 0,
          max: () => {
            const vals = data.map((d) => d.precipAmount).filter((n) => n != null && n > 0);
            return vals.length ? Math.max(...vals) * 1.2 || 0.5 : 0.5;
          },
        },
        wind: {
          fields: [
            { key: "windSpeed", label: "Wind Speed", color: "#4caf50", format: (x) => (x != null ? `${Math.round(x)} ${windUnit}` : "—") },
            { key: "windGusts", label: "Wind Gusts", color: "#827717", format: (x) => (x != null ? `${Math.round(x)} ${windUnit}` : "—") },
          ],
          min: () => 0,
          max: () => {
            const vals = data.flatMap((d) => [d.windSpeed, d.windGusts]).filter((n) => n != null);
            return vals.length ? Math.ceil(Math.max(...vals)) + 5 : 50;
          },
        },
        humidity: {
          fields: [
            { key: "humidity", label: "Humidity", color: "#26a69a", format: (x) => (x != null ? `${x}%` : "—") },
            { key: "cloudCover", label: "Cloud Cover", color: "#90a4ae", format: (x) => (x != null ? `${x}%` : "—") },
          ],
          min: () => 0,
          max: () => 100,
        },
      };

      const def = metricDefs[metric] || metricDefs.temp;
      const fields = def.fields;
      const yMin = def.min();
      const yMax = def.max();

      const series = fields.map((f) => ({
        name: f.label,
        data: data.map((d) => d[f.key]),
        type: "line",
      }));

      const tooltip = ({ dataPointIndex }) => {
        const d = data[dataPointIndex];
        const rows = fields.map((f) => {
          const v = d[f.key];
          return `<div style="display:flex;justify-content:space-between;gap:16px"><span style="color:var(--secondary-text-color)">${f.label}:</span><span style="color:${f.color}">${f.format(v)}</span></div>`;
        }).join("");
        return `<div style="background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:8px;padding:10px 14px;font-size:12px;box-shadow:0 4px 12px rgba(0,0,0,0.15);"><div style="font-weight:600;margin-bottom:4px">${d.time}</div>${rows}</div>`;
      };

      const container = s.getElementById("apex-chart-combined");
      if (!container) return;
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
        colors: fields.map((f) => f.color),
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
          min: yMin,
          max: yMax,
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
      this._apexCharts.push(ch);
    } catch (e) {
      console.error("ApexCharts init failed:", e);
    }
  }

  _renderAlerts() {
    if (!this._alertsData && !this._alertsLoading) {
      this._alertsLoading = true;
      this._fetchNwsAlerts();
    }
    const empty = (msg, isError = false) => `
      <section class="alerts-page">
        <div class="alerts-empty ${isError ? "is-error" : ""}">
          <svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
          <p>${msg}</p>
        </div>
      </section>`;
    if (this._alertsLoading || !this._alertsData) {
      return `<section class="alerts-page"><div class="alerts-empty"><p>Loading alerts…</p></div></section>`;
    }
    if (this._alertsData.error) {
      return empty(`Failed to load alerts: ${String(this._alertsData.error).replace(/</g, "&lt;")}`, true);
    }
    const alerts = this._alertsData.alerts || [];
    if (alerts.length === 0) {
      return empty("No active weather alerts for your area.");
    }
    const severityIcon = (sevClass) => {
      if (sevClass === "sev-warning") return `<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>`; // triangle
      if (sevClass === "sev-watch") return `<path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>`; // info circle
      return `<path d="M11 17h2v-6h-2v6zm1-15C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zM11 9h2V7h-2v2z"/>`; // advisory
    };
    const rows = alerts.map((a, i) => {
      const event = String(a.event || "Alert").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const descRaw = a.description || "";
      const isLong = descRaw.length > 280;
      const desc = (isLong ? descRaw.substring(0, 280) + "…" : descRaw)
        .replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
      const descFull = descRaw.replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
      const effective = a.effective ? new Date(a.effective).toLocaleString() : "—";
      const expires = a.expires ? new Date(a.expires).toLocaleString() : "—";
      const sev = String(a.event || "").toLowerCase();
      const sevClass = sev.includes("warning") ? "sev-warning" : sev.includes("watch") ? "sev-watch" : "sev-advisory";
      const sevLabel = sevClass.replace("sev-", "");
      return `<article class="alert-card ${sevClass}" data-alert-index="${i}">
        <header class="alert-card-head" data-alert-toggle="${i}">
          <span class="alert-severity-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">${severityIcon(sevClass)}</svg></span>
          <span class="alert-pill">${sevLabel.toUpperCase()}</span>
          <h3>${event}</h3>
          ${isLong ? `<button class="alert-expand" aria-label="Toggle details" data-alert-expand="${i}"><svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg></button>` : ""}
        </header>
        <p class="alert-desc" data-alert-desc="${i}">${desc}</p>
        ${isLong ? `<p class="alert-desc alert-desc-full" data-alert-desc-full="${i}" style="display:none;">${descFull}</p>` : ""}
        <dl class="alert-meta">
          <div><dt>Effective</dt><dd>${effective}</dd></div>
          <div><dt>Expires</dt><dd>${expires}</dd></div>
        </dl>
      </article>`;
    }).join("");
    return `<section class="alerts-page"><h2 class="alerts-title">Active weather alerts</h2><div class="alerts-list">${rows}</div></section>`;
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
    const mediaPlayerEntities = entities.filter((e) => e.startsWith("media_player."));
    const ttsEntities = entities.filter((e) => e.startsWith("tts."));

    const defaultTts = {
      hour_pattern: 3,
      minute_offset: 3, start_time: "08:00", end_time: "21:00",
      days_of_week: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      enable_time_based: false,
      enable_sensor_triggered: false, sensor_triggers: [],
      enable_current_change: false,
      enable_upcoming_change: false, minutes_before_announce: 30,
      enable_webhook: false, webhooks: [],
      enable_voice_satellite: false, conversation_commands: "What is the weather\nWhats the weather",
      precip_threshold: 30,
      wind_speed_threshold: 15, wind_gust_threshold: 20,
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
    if (!this._expandedSections) this._expandedSections = new Set(["media-players"]);

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

        <!-- Section: Weather Source -->
        <div class="settings-group">
          <div class="settings-group-title">Weather source</div>
          <div class="settings-group-sub">Pick the entity that powers your dashboard and forecasts.</div>
          <div class="collapsible-section open" data-section-id="weather-source">
            <div class="collapsible-content" style="display:flex;padding-top:20px;">
              <div class="form-group">
                <label>Weather Entity *</label>
                ${this._renderEntityAutocomplete("weather-entity", this._settings.weather_entity || "", "weather", "Type to search weather entities...")}
                <p class="form-hint">Required. Must support hourly and daily forecasts.</p>
              </div>
            </div>
          </div>
        </div>

        <!-- Section: Announcements & Alerts -->
        <div class="settings-group">
          <div class="settings-group-title">Announcements &amp; alerts</div>
          <div class="settings-group-sub">Enable and test each alert type independently. Media players and TTS entities are configured per player below.</div>

          <!-- General: Message Intro -->
          <div class="collapsible-section open" data-section-id="general">
            <div class="collapsible-content" style="display: flex; padding-top: 20px;">
              <div class="form-group">
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
            
            <div class="form-actions-row">
              <button type="button" class="test-tts-btn" id="test-forecast-btn">Test forecast</button>
            </div>
            <p class="form-hint">Plays the full scheduled forecast on all configured media players.</p>
          `, true, "enable-time-based", tts.enable_time_based)}

          <!-- Current Change Alerts -->
          ${renderCollapsible("current-change", "Current Change Alerts", "Speak when conditions change", `
            <p class="form-hint" style="margin-top: var(--form-gap);">Triggered when the weather entity's condition changes (e.g. sunny → cloudy). Volume is controlled per media player.</p>
            <div class="form-actions-row">
              <button type="button" class="test-tts-btn" id="test-current-change-btn">Test current change</button>
            </div>
          `, true, "enable-current-change", tts.enable_current_change)}

          <!-- Upcoming Change Alerts -->
          ${renderCollapsible("upcoming-change", "Upcoming Change Alerts", "Heads-up before rain or snow", `
            <div class="form-group" style="margin-top: var(--form-gap);">
              <label>Minutes Before to Announce</label>
              <select id="minutes-before-announce">
                <option value="15" ${tts.minutes_before_announce === 15 ? "selected" : ""}>15 minutes</option>
                <option value="30" ${tts.minutes_before_announce === 30 ? "selected" : ""}>30 minutes</option>
                <option value="45" ${tts.minutes_before_announce === 45 ? "selected" : ""}>45 minutes</option>
                <option value="60" ${tts.minutes_before_announce === 60 ? "selected" : ""}>1 hour</option>
              </select>
            </div>
            <div class="form-actions-row">
              <button type="button" class="test-tts-btn" id="test-upcoming-change-btn">Test upcoming change</button>
            </div>
            <p class="form-hint">Picks the next forecast period above your precipitation threshold.</p>
          `, true, "enable-upcoming-change", tts.enable_upcoming_change)}

          <!-- Sunrise & Sunset Alerts -->
          ${renderCollapsible("sun-alerts", "Sunrise &amp; Sunset Alerts", "TTS and automations at sunrise/sunset", `
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
            <div class="form-actions-row">
              <button type="button" class="test-tts-btn" id="test-sunrise-btn">Test sunrise</button>
              <button type="button" class="test-tts-btn btn-secondary-test" id="test-sunset-btn">Test sunset</button>
            </div>
            <p class="form-hint">Tests speak the "upcoming" message immediately.</p>
          `, true, "sun-alerts-enabled", sunAlerts.enabled)}

          <!-- NWS Alerts -->
          ${renderCollapsible("nws-alerts", "NWS Weather Alerts", "Siren + TTS for National Weather Service alerts", `
            <div class="form-group" style="margin-top: var(--form-gap);">
              <label>Alert sound (plays before TTS)</label>
              <select id="nws-alerts-sound-file">
                <option value="">None</option>
                ${(this._wwwSounds || []).map((f) => `<option value="${f}" ${nwsAlerts.sound_file === f ? "selected" : ""}>${f}</option>`).join("")}
              </select>
              <p class="form-hint">Place .mp3, .wav, or .ogg files in <code>custom_components/home_weather/www/sounds/</code>.</p>
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
            <div class="form-actions-row">
              <button type="button" class="test-tts-btn" id="test-nws-btn">Test NWS alert</button>
            </div>
          `, true, "nws-alerts-enabled", nwsAlerts.enabled)}

          <!-- Sensor Triggered -->
          ${renderCollapsible("sensor-triggered", "Sensor Triggered", "Announce when an entity reaches a state", `
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
            <div class="form-actions-row">
              <button type="button" class="test-tts-btn" id="test-sensor-btn">Test sensor trigger</button>
            </div>
            <p class="form-hint">Runs a forecast on the media player from the first sensor row (or all players).</p>
          `, true, "enable-sensor-triggered", tts.enable_sensor_triggered)}

          <!-- Webhook -->
          ${renderCollapsible("webhook", "Webhook Triggers", `${tts.webhooks.length} configured`, `
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
            <div class="form-actions-row">
              <button type="button" class="test-tts-btn" id="test-webhook-btn">Test webhook</button>
            </div>
            <p class="form-hint">Runs the webhook forecast for the first enabled webhook above.</p>
          `, true, "enable-webhook", tts.enable_webhook)}

          <!-- Voice Satellite -->
          ${renderCollapsible("voice-satellite", "Voice Satellite", "Speak weather on voice queries", `
            <div class="form-group" style="margin-top: var(--form-gap);">
              <label>Conversation Commands (one per line)</label>
              <textarea class="textarea-field" id="conversation-commands" placeholder="What is the weather&#10;Whats the weather">${tts.conversation_commands}</textarea>
              <p class="form-hint">Registers a <code>HomeWeatherForecast</code> intent and the phrases above as conversation triggers.</p>
            </div>
          `, true, "enable-voice-satellite", tts.enable_voice_satellite)}

        </div>

        <!-- Section: Advanced -->
        <div class="settings-group">
          <div class="settings-group-title">Advanced</div>
          <div class="settings-group-sub">Thresholds, forecast tuning and AI rewriting.</div>

          <!-- Forecast Settings -->
          ${renderCollapsible("forecast-settings", "Forecast Settings", "Thresholds and limits", `
            <div class="form-group">
              <label>Precipitation Threshold (%)</label>
              <input type="number" id="precip-threshold" min="0" max="100" value="${tts.precip_threshold}"/>
            </div>

            <div class="form-row-inline">
              <div class="form-group">
                <label>Wind Speed Threshold (for mention)</label>
                <input type="number" id="wind-speed-threshold" min="0" max="100" value="${tts.wind_speed_threshold}"/>
              </div>

              <div class="form-group">
                <label>Wind Gust Threshold (for mention)</label>
                <input type="number" id="wind-gust-threshold" min="0" max="100" value="${tts.wind_gust_threshold}"/>
              </div>
            </div>
          `)}

          <!-- AI Rewrite -->
          ${renderCollapsible("ai-rewrite", "AI Rewrite", "Rewrite TTS messages with an AI Task", `
            <div class="form-group" style="margin-top: var(--form-gap);">
              <label>AI Task Entity</label>
              ${this._renderEntityAutocomplete("ai-task-entity", tts.ai_task_entity || "", "ai_task", "Type to search AI task entities...")}
            </div>
            <div class="form-group">
              <label>AI Rewrite Prompt</label>
              <textarea class="textarea-field" id="ai-rewrite-prompt">${tts.ai_rewrite_prompt}</textarea>
            </div>
          `, true, "use-ai-rewrite", tts.use_ai_rewrite)}

        </div>

        <div class="form-actions">
          <button class="btn btn-secondary" id="cancel-btn">Cancel</button>
          <button class="btn btn-primary" id="save-btn">Save changes</button>
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
      wind_speed_threshold: parseInt(s.getElementById("wind-speed-threshold")?.value || existing.wind_speed_threshold || 15, 10),
      wind_gust_threshold: parseInt(s.getElementById("wind-gust-threshold")?.value || existing.wind_gust_threshold || 20, 10),
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
