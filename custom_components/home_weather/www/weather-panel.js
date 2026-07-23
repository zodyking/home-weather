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
    this._mapsMode = "storms";
    this._mapsWindRadii = false;
    this._mapsShowZones = true;
    this._mapsLayers = this._normalizeMapLayers({ hurricane: true, tornado: true, earthquakes: true, lightning: true, volcanoes: true, travel: false, wildfire: false, air_quality: false });
    this._mapsSort = "newest";
    this._settingsPane = "general";
    this._zoneEditor = null;
    this._zoneEditorPromise = null;
    this._zoneEditorReturnView = "settings";
    this._chartMetric = "temp";
    this._selectedForecast = null; // { type: "hour"|"day", index: number }
    this._useFahrenheit = true;
    this._weatherData = null;
    this._settings = {};
    // Seed appearance from localStorage so the very first paint uses the
    // remembered theme (no dark flash) before the config WS round-trip lands.
    this._settings.appearance = this._readStoredAppearance();
    this._themeSaveTimer = null;
    this._narrow = null;
    this._graphHoverIndex = null;
    this._apexCharts = [];
    this._webhookInfo = {};  // { webhook_id: { url, last_triggered } }
    this._sunTimesCache = {};
    this._wwwSounds = [];  // Audio files in www/sounds/ for NWS alert picker
    this._alertsData = null;
    this._alertsLoading = false;
    this._hurricaneTracker = null;
    this._hurricaneTrackerPromise = null;
    this._spaceMap = null;
    this._spaceMapPromise = null;
    this._spaceMode = "solar_system";
    this._spaceLayers = {
      planets: true,
      dwarf_planets: true,
      moons: true,
      spacecraft: true,
      asteroids: true,
      comets: true,
    };
    this._spaceRefreshTimer = null;
    this._version = null;
    this._updateStatus = "checking";  // "latest" | "available" | "checking" | "error"
    this._latestRelease = null;  // { version, name, body, date, url, isCommit }
    this._updateCheckInterval = null;
    this._clockTimeout = null;
    this._dashboardSettled = false;
    this._settingsNotice = null;
    this._settingsNoticeTimer = null;
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
    this._startAtmosphereClock();
    // Subscribe to webhook triggered events for real-time status updates
    this._subscribeToWebhookEvents();
    // Subscribe to TTS status events for real playback feedback
    this._subscribeToTtsStatus();
  }

  disconnectedCallback() {
    this._stopUpdateCheckPoll();
    this._stopAtmosphereClock();
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
    let weatherRendered = false;
    try {
      this._loading = true;
      this._error = null;
      this._render();
      const response = await this._hass.callWS({ type: "home_weather/get_config" });
      this._config = response.config || {};
      this._settings = JSON.parse(JSON.stringify(this._config || {}));
      // Resolve theme: prefer the saved server-side appearance; otherwise keep
      // whatever we already applied from localStorage (avoids a dark flash and
      // preserves the user's last choice on a fresh/blank config).
      if (this._settings.appearance && this._settings.appearance.mode) {
        this._settings.appearance = {
          mode: this._settings.appearance.mode === "light" ? "light" : "dark",
          overrides: this._settings.appearance.overrides && typeof this._settings.appearance.overrides === "object"
            ? this._settings.appearance.overrides
            : {},
        };
      } else {
        this._settings.appearance = this._readStoredAppearance();
      }
      // Keep localStorage in sync with the authoritative config.
      try {
        window.localStorage.setItem("hw_theme_mode", this._settings.appearance.mode);
        window.localStorage.setItem("hw_theme_overrides", JSON.stringify(this._settings.appearance.overrides || {}));
      } catch (_) { /* ignore */ }
      this._applyTheme();
      if (!this._settings.tts) this._settings.tts = { enabled: false, language: "en", platform: null };
      if (!Array.isArray(this._settings.media_players)) this._settings.media_players = [];
      this._settings.media_players = this._normalizeMediaPlayers(this._settings.media_players);
      this._mapsLayers = this._normalizeMapLayers(this._mapsLayers);
      const lightningMon = this._settings?.lightning_monitoring || this._settings?.lightning || {};
      this._mapsLayers.lightning = lightningMon.show_on_map !== false;
      if (!this._config.weather_entity) {
        this._currentView = "settings";
      } else {
        await this._loadWeatherData();
        weatherRendered = true;
      }
      await this._fetchVersion();
      // Refresh every 5 min
      if (this._refreshInterval) clearInterval(this._refreshInterval);
      this._refreshInterval = setInterval(() => this._loadWeatherData(), 5 * 60 * 1000);
    } catch (e) {
      console.error("Error loading config:", e);
      this._error = "Failed to load configuration";
    } finally {
      this._loading = false;
      if (!weatherRendered || this._error) {
        this._render();
      }
    }
  }

  async _fetchVersion() {
    if (!this._hass) return;
    try {
      const r = await this._hass.callWS({ type: "home_weather/get_version" });
      this._version = r.version != null ? String(r.version) : null;
    } catch (e) {
      console.error("Failed to fetch version:", e);
      this._version = null;
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
    if (!current) {
      this._updateStatus = "checking";
      return;
    }

    const repo = "zodyking/home-weather";
    const prevStatus = this._updateStatus;

    try {
      // Try releases first
      const relRes = await fetch(`https://api.github.com/repos/${repo}/releases/latest`);
      if (relRes.ok) {
        const data = await relRes.json();
        const tag = (data.tag_name || "").replace(/^v/i, "").trim();
        if (tag) {
          this._latestRelease = {
            version: tag,
            name: data.name || `v${tag}`,
            body: this._formatReleaseBody(data.body || ""),
            date: data.published_at ? new Date(data.published_at) : null,
            url: data.html_url,
            isCommit: false,
          };
          this._updateStatus = this._compareVersions(current, tag) > 0 ? "available" : "latest";
          this._renderVersionSection();
          return;
        }
      }

      // Fallback: try tags
      const tagRes = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=1`);
      if (tagRes.ok) {
        const tags = await tagRes.json();
        if (tags.length > 0) {
          const tag = (tags[0].name || "").replace(/^v/i, "").trim();
          if (tag) {
            this._latestRelease = {
              version: tag,
              name: `v${tag}`,
              body: "",
              date: null,
              url: `https://github.com/${repo}/releases/tag/${tags[0].name}`,
              isCommit: false,
            };
            this._updateStatus = this._compareVersions(current, tag) > 0 ? "available" : "latest";
            this._renderVersionSection();
            return;
          }
        }
      }

      // Fallback: latest commit
      const commitRes = await fetch(`https://api.github.com/repos/${repo}/commits?per_page=1`);
      if (commitRes.ok) {
        const commits = await commitRes.json();
        if (commits.length > 0) {
          const commit = commits[0];
          const sha = commit.sha?.substring(0, 7) || "unknown";
          this._latestRelease = {
            version: sha,
            name: `Commit ${sha}`,
            body: commit.commit?.message?.split("\n")[0] || "",
            date: commit.commit?.author?.date ? new Date(commit.commit.author.date) : null,
            url: commit.html_url,
            isCommit: true,
          };
          // Can't compare semver to commit hash — assume up to date if no releases exist
          this._updateStatus = "latest";
          this._renderVersionSection();
          return;
        }
      }

      this._updateStatus = prevStatus === "available" ? "available" : "latest";
    } catch (e) {
      console.warn("Update check failed:", e);
      this._updateStatus = prevStatus === "available" ? "available" : "error";
    }
    this._renderVersionSection();
  }

  _formatReleaseBody(body) {
    if (!body) return "";
    // Trim to first ~300 chars at a sentence boundary for display
    const trimmed = body.length > 300 ? body.substring(0, 300).replace(/\s+\S*$/, "…") : body;
    // Strip markdown headers but keep structure
    return trimmed
      .replace(/^##+ /gm, "")
      .replace(/\*\*/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  _renderVersionSection() {
    const s = this.shadowRoot;
    if (!s) return;
    const container = s.querySelector(".version-section-content");
    if (!container) return;
    container.innerHTML = this._buildVersionSectionContent();
  }

  _buildVersionSectionContent() {
    const current = this._version;
    const latest = this._latestRelease;
    const status = this._updateStatus;

    const formatDate = (d) => {
      if (!d) return "";
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    };

    let statusBadge = "";
    if (status === "checking") {
      statusBadge = `<span class="version-badge checking">Checking…</span>`;
    } else if (status === "available") {
      statusBadge = `<span class="version-badge update">Update Available</span>`;
    } else if (status === "error") {
      statusBadge = `<span class="version-badge error">Check Failed</span>`;
    }

    let latestHtml = "";
    if (latest) {
      const dateStr = formatDate(latest.date);
      const typeLabel = latest.isCommit ? "Latest Commit" : "Latest Release";
      latestHtml = `
        <div class="version-row latest">
          <div class="version-row-header">
            <span class="version-label">${typeLabel}</span>
            <span class="version-value">${this._esc(latest.name)}</span>
            ${dateStr ? `<span class="version-date">${dateStr}</span>` : ""}
          </div>
          ${latest.body ? `<div class="version-notes">${this._esc(latest.body)}</div>` : ""}
          ${latest.url ? `<a class="version-link" href="${this._esc(latest.url)}" target="_blank" rel="noopener noreferrer">View on GitHub →</a>` : ""}
        </div>`;
    } else if (status === "checking") {
      latestHtml = `<div class="version-row latest"><span class="version-checking-text">Checking for updates…</span></div>`;
    } else if (status === "error") {
      latestHtml = `<div class="version-row latest"><span class="version-error-text">Could not check for updates</span></div>`;
    }

    return `
      <div class="version-row installed">
        <div class="version-row-header">
          <span class="version-label">Installed</span>
          <span class="version-value">${current ? `v${this._esc(current)}` : "Unknown"}</span>
          ${statusBadge}
        </div>
      </div>
      ${latestHtml}
    `;
  }

  _esc(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
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

  _formatAtmosphereDateTime(date = new Date()) {
    const timeStr = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const dateStr = date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    return `${timeStr} · ${dateStr}`;
  }

  _updateAtmosphereClock() {
    const s = this.shadowRoot;
    if (!s) return;
    const el = s.querySelector(".atmosphere-datetime");
    if (!el) return;
    const text = this._formatAtmosphereDateTime();
    if (el.textContent !== text) el.textContent = text;
  }

  _startAtmosphereClock() {
    this._stopAtmosphereClock();
    this._updateAtmosphereClock();
    const scheduleTick = () => {
      this._updateAtmosphereClock();
      const now = new Date();
      const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 50;
      this._clockTimeout = setTimeout(scheduleTick, msUntilNextMinute);
    };
    const now = new Date();
    const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 50;
    this._clockTimeout = setTimeout(scheduleTick, msUntilNextMinute);
  }

  _stopAtmosphereClock() {
    if (this._clockTimeout) {
      clearTimeout(this._clockTimeout);
      this._clockTimeout = null;
    }
  }

  _formatSunTime(dt) {
    return dt ? dt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
  }

  _patchSunPanelTimes() {
    const s = this.shadowRoot;
    if (!s || this._currentView !== "forecast") return;
    const stats = s.querySelectorAll(".sun-panel-card .sun-stat");
    if (!stats.length) return;
    const { lat, lon } = this._getHomeCoordinates();
    const sunTimes = this._getSunTimes(lat, lon, new Date());
    const dayLengthStr = sunTimes.day_length != null
      ? `${Math.floor(sunTimes.day_length / 3600)}h ${Math.floor((sunTimes.day_length % 3600) / 60)}m`
      : "—";
    const civilBeginStr = this._formatSunTime(sunTimes.civil_twilight_begin);
    const civilEndStr = this._formatSunTime(sunTimes.civil_twilight_end);
    const values = [
      this._formatSunTime(sunTimes.sunrise),
      this._formatSunTime(sunTimes.sunset),
      this._formatSunTime(sunTimes.solar_noon),
      dayLengthStr,
      `${civilBeginStr} – ${civilEndStr}`,
    ];
    stats.forEach((row, i) => {
      if (values[i] == null) return;
      const label = row.querySelector(".sun-label");
      row.textContent = "";
      if (label) row.appendChild(label);
      row.append(` ${values[i]}`);
    });
  }

  _patchAtmosphereTheme() {
    const s = this.shadowRoot;
    if (!s || this._currentView !== "forecast") return;
    const card = s.querySelector(".atmosphere-card:not(.skeleton-card)");
    if (!card || !this._weatherData?.configured) return;

    const current = this._weatherData.current || {};
    const condition = current.condition || current.state || "";
    const now = new Date();
    const theme = this._getAtmosphereTheme(condition, current.cloud_coverage, now);
    card.className = `glass card atmosphere-card ${theme.className}`;
    card.dataset.atmosphereMood = theme.mood;
    card.style.setProperty("--atmosphere-cloud", theme.cloudOpacity);
    card.style.setProperty("--atmosphere-intensity", theme.intensity);

    s.querySelectorAll(".hourly-strip .forecast-card .icon").forEach((iconEl, i) => {
      const hourly = this._weatherData.hourly_forecast || [];
      const h = hourly[i];
      if (!h || !iconEl) return;
      const when = i === 0 ? now : this._parseForecastDatetime(h.datetime);
      iconEl.innerHTML = this._getConditionIcon(h.condition, null, when);
    });

    this._initAtmosphereParticles();
  }

  _patchAlertsBadge() {
    const s = this.shadowRoot;
    if (!s) return;
    const btn = s.getElementById("alerts-btn");
    if (!btn) return;
    btn.querySelector(".alerts-badge")?.remove();
    const badgeHtml = this._renderAlertsBadge();
    if (badgeHtml) btn.insertAdjacentHTML("beforeend", badgeHtml);
    const count = this._getActiveAlertCount();
    btn.setAttribute(
      "aria-label",
      count ? `Alerts, ${count} active` : "Alerts",
    );
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

  _clearSettingsNotice() {
    if (this._settingsNoticeTimer) {
      clearTimeout(this._settingsNoticeTimer);
      this._settingsNoticeTimer = null;
    }
    this._settingsNotice = null;
  }

  _showSettingsNotice(message) {
    this._clearSettingsNotice();
    this._settingsNotice = message;
    this._settingsNoticeTimer = setTimeout(() => {
      this._settingsNotice = null;
      this._settingsNoticeTimer = null;
      if (this._currentView === "settings") this._render();
    }, 3200);
  }

  /** Update the inline save-status pill in place (no re-render). */
  _setSaveStatus(state, message) {
    const el = this.shadowRoot?.getElementById("settings-save-status");
    if (!el) return;
    el.setAttribute("data-state", state);
    if (message != null) el.textContent = message;
  }

  /** Debounced auto-save fired from form edits. Applies optimistically and
   *  saves in the background so the UI never blocks. */
  _scheduleAutoSave() {
    if (this._currentView !== "settings") return;
    if (this._autoSaveTimer) clearTimeout(this._autoSaveTimer);
    this._setSaveStatus("saving", "Saving\u2026");
    this._autoSaveTimer = setTimeout(() => {
      this._autoSaveTimer = null;
      this._saveSettings({ silent: true });
    }, 800);
  }

  /** Quiet weather refresh that never re-renders while the settings form is
   *  open, so a background save can't clobber the user's inputs/focus. */
  async _loadWeatherDataQuiet() {
    if (!this._hass || !this._config || !this._config.weather_entity) return;
    try {
      const response = await this._hass.callWS({ type: "home_weather/get_weather" });
      this._weatherData = response.data;
    } catch (e) {
      console.error("Error loading weather:", e);
    }
    if (this._currentView !== "settings") this._render();
  }

  /** Quiet webhook-info refresh. Updates the cache and, when it's safe to do so
   *  (the user isn't actively editing a field), re-renders so any freshly
   *  generated webhook URLs appear. Never clobbers an in-progress edit. */
  async _loadWebhookInfoQuiet() {
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
      if (this._currentView !== "settings" || !this._isEditingField()) {
        this._render();
      }
    } catch (e) {
      console.error("Failed to load webhook info:", e);
    }
  }

  /** True when a form control inside the panel currently has focus, so a
   *  background refresh should avoid re-rendering and stealing the user's spot. */
  _isEditingField() {
    const active = this.shadowRoot?.activeElement;
    if (!active) return false;
    const tag = active.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active.isContentEditable;
  }

  async _saveSettings({ silent = false } = {}) {
    if (!this._hass) return;
    // Any pending debounced autosave is superseded by this explicit save.
    if (this._autoSaveTimer) { clearTimeout(this._autoSaveTimer); this._autoSaveTimer = null; }
    this._syncSettingsFromForm();
    // Optimistic UI: adopt the new settings locally immediately so the panel
    // reflects them at once and never waits on the WS round-trip.
    const snapshot = JSON.parse(JSON.stringify(this._settings));
    this._config = JSON.parse(JSON.stringify(snapshot));
    this._setSaveStatus("saving", "Saving\u2026");
    try {
      await this._hass.callWS({ type: "home_weather/set_config", config: snapshot });
      this._setSaveStatus("saved", "All changes saved");
      // Refresh derived data in the background, never blocking the form.
      this._loadWeatherDataQuiet();
      this._loadWebhookInfoQuiet();
      if (this._saveStatusTimer) clearTimeout(this._saveStatusTimer);
      this._saveStatusTimer = setTimeout(() => {
        this._saveStatusTimer = null;
        this._setSaveStatus("idle", "Changes save automatically");
      }, 2500);
    } catch (e) {
      // On failure, keep the user's edits in this._settings so nothing is lost
      // and surface a clear, retryable error.
      console.error("Error saving:", e);
      this._setSaveStatus("error", "Save failed \u2014 your changes are kept. Retry or edit to save again.");
      if (!silent) this._showSettingsNotice("Failed to save settings");
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

  _normalizeMapLayers(layers) {
    const normalized = { ...(layers || {}) };
    if (Object.prototype.hasOwnProperty.call(normalized, "tropical")) {
      if (!Object.prototype.hasOwnProperty.call(normalized, "hurricane")) {
        normalized.hurricane = normalized.tropical;
      }
      delete normalized.tropical;
    }
    if (!Object.prototype.hasOwnProperty.call(normalized, "volcanoes")) {
      normalized.volcanoes = true;
    }
    if (!Object.prototype.hasOwnProperty.call(normalized, "travel")) {
      normalized.travel = true;
    }
    if (!Object.prototype.hasOwnProperty.call(normalized, "wildfire")) {
      normalized.wildfire = true;
    }
    if (!Object.prototype.hasOwnProperty.call(normalized, "air_quality")) {
      normalized.air_quality = true;
    }
    return normalized;
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

  static get _WEATHER_PLATFORM_LABELS() {
    return {
      weatherkit: "Apple Weather",
      openweathermap: "OpenWeatherMap",
      met: "Met.no",
      accuweather: "AccuWeather",
      pirateweather: "Pirate Weather",
      smhi: "SMHI",
      bom: "Bureau of Meteorology",
      ecowitt: "Ecowitt",
      nws: "National Weather Service",
      foreca: "Foreca",
      metoffice: "Met Office",
      dwd_weather: "Deutscher Wetterdienst",
      environment_canada: "Environment Canada",
    };
  }

  async _ensureEntityRegistryCache() {
    if (this._entityRegistryCachePromise) return this._entityRegistryCachePromise;
    this._entityRegistryCachePromise = (async () => {
      if (!this._hass?.callWS) {
        this._entityRegistryCache = { entryTitles: {}, byEntityId: {} };
        return;
      }
      try {
        const [entities, entries] = await Promise.all([
          this._hass.callWS({ type: "config/entity_registry/list" }),
          this._hass.callWS({ type: "config/config_entries/list" }),
        ]);
        const entryTitles = {};
        (entries || []).forEach((entry) => {
          if (entry?.entry_id && entry?.title) entryTitles[entry.entry_id] = entry.title;
        });
        const byEntityId = {};
        (entities || []).forEach((entity) => {
          if (entity?.entity_id) byEntityId[entity.entity_id] = entity;
        });
        this._entityRegistryCache = { entryTitles, byEntityId };
      } catch (_) {
        this._entityRegistryCache = { entryTitles: {}, byEntityId: {} };
      }
    })();
    return this._entityRegistryCachePromise;
  }

  _formatWeatherPlatformName(platform) {
    if (!platform) return "Weather";
    const known = HomeWeatherPanel._WEATHER_PLATFORM_LABELS[platform];
    if (known) return known;
    return platform
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  _getWeatherEntityIntegrationName(entityId) {
    if (!entityId) return "";
    const cache = this._entityRegistryCache;
    const reg = cache?.byEntityId?.[entityId];
    if (reg?.config_entry_id && cache?.entryTitles?.[reg.config_entry_id]) {
      return cache.entryTitles[reg.config_entry_id];
    }
    const state = this._hass?.states?.[entityId];
    const attribution = state?.attributes?.attribution || "";
    const attrMatch = attribution.match(/(?:provided by|powered by|data from|©)\s*([^.,]+)/i);
    if (attrMatch?.[1]) return attrMatch[1].trim();
    const platform = this._hass?.entities?.[entityId]?.platform || reg?.platform;
    if (platform) return this._formatWeatherPlatformName(platform);
    return state?.attributes?.friendly_name || "Weather";
  }

  _getWeatherEntityOptions() {
    const states = this._hass?.states || {};
    const options = Object.keys(states)
      .filter((entityId) => entityId.startsWith("weather."))
      .map((entityId) => ({
        entity_id: entityId,
        integration_name: this._getWeatherEntityIntegrationName(entityId),
      }))
      .sort((a, b) => {
        const byName = a.integration_name.localeCompare(b.integration_name, undefined, { sensitivity: "base" });
        return byName !== 0 ? byName : a.entity_id.localeCompare(b.entity_id);
      });
    return options;
  }

  _escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  _renderWeatherEntitySelect(selectedId) {
    const options = this._getWeatherEntityOptions();
    const selected = selectedId && (options.some((o) => o.entity_id === selectedId) || this._hass?.states?.[selectedId])
      ? selectedId
      : "";
    const selectedOption = options.find((o) => o.entity_id === selected);
    const selectedTitle = selected
      ? (selectedOption?.integration_name || this._getWeatherEntityIntegrationName(selected))
      : "Select weather entity…";
    const optionsHtml = options.length
      ? options.map((opt) => `
          <button type="button" class="hw-entity-select-option" role="option"
            data-value="${this._escapeHtml(opt.entity_id)}"
            aria-selected="${opt.entity_id === selected ? "true" : "false"}">
            <span class="hw-entity-select-title">${this._escapeHtml(opt.integration_name)}</span>
            <span class="hw-entity-select-sub">${this._escapeHtml(opt.entity_id)}</span>
          </button>`).join("")
      : `<div class="hw-entity-select-empty">No weather entities found. Add a weather integration in Home Assistant first.</div>`;
    return `
      <div class="hw-entity-select" data-weather-entity-select>
        <input type="hidden" id="weather-entity" value="${this._escapeHtml(selected)}"/>
        <button type="button" class="hw-entity-select-trigger${selected ? "" : " is-placeholder"}"
          aria-haspopup="listbox" aria-expanded="false" aria-labelledby="weather-entity-label">
          <span class="hw-entity-select-label">
            <span class="hw-entity-select-title">${this._escapeHtml(selectedTitle)}</span>
            ${selected ? `<span class="hw-entity-select-sub">${this._escapeHtml(selected)}</span>` : ""}
          </span>
          <svg class="hw-entity-select-chevron" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M7 10l5 5 5-5z"/>
          </svg>
        </button>
        <div class="hw-entity-select-dropdown" role="listbox" aria-label="Weather entities">
          ${optionsHtml}
        </div>
      </div>`;
  }

  _refreshWeatherEntitySelect() {
    const s = this.shadowRoot;
    if (!s || this._currentView !== "settings") return;
    const wrapper = s.querySelector("[data-weather-entity-select]");
    if (!wrapper) return;
    const selected = s.getElementById("weather-entity")?.value || this._settings.weather_entity || "";
    const parent = wrapper.parentElement;
    if (!parent) return;
    const tmp = document.createElement("div");
    tmp.innerHTML = this._renderWeatherEntitySelect(selected);
    const next = tmp.firstElementChild;
    if (!next) return;
    wrapper.replaceWith(next);
    this._initWeatherEntitySelect(s);
  }

  _initWeatherEntitySelect(container) {
    if (!container) return;
    const root = container.querySelector("[data-weather-entity-select]");
    if (!root || root._weatherEntitySelectInit) return;
    root._weatherEntitySelectInit = true;

    const hidden = root.querySelector("#weather-entity");
    const trigger = root.querySelector(".hw-entity-select-trigger");
    const dropdown = root.querySelector(".hw-entity-select-dropdown");
    if (!hidden || !trigger || !dropdown) return;

    let scrollListener = null;
    let resizeListener = null;

    const positionDropdown = () => {
      const rect = trigger.getBoundingClientRect();
      const gap = 4;
      const maxH = Math.min(320, window.innerHeight * 0.5);
      const spaceBelow = window.innerHeight - rect.bottom - gap;
      const spaceAbove = rect.top - gap;
      const dropUp = spaceBelow < maxH && spaceAbove > spaceBelow;
      dropdown.style.left = `${rect.left}px`;
      dropdown.style.width = `${rect.width}px`;
      if (dropUp) {
        dropdown.style.top = "auto";
        dropdown.style.bottom = `${window.innerHeight - rect.top + gap}px`;
        dropdown.style.maxHeight = `${Math.min(maxH, spaceAbove)}px`;
      } else {
        dropdown.style.top = `${rect.bottom + gap}px`;
        dropdown.style.bottom = "auto";
        dropdown.style.maxHeight = `${Math.min(maxH, spaceBelow)}px`;
      }
    };

    const clearPositionListeners = () => {
      if (scrollListener) {
        window.removeEventListener("scroll", scrollListener, true);
        scrollListener = null;
      }
      if (resizeListener) {
        window.removeEventListener("resize", resizeListener);
        resizeListener = null;
      }
    };

    const close = () => {
      root.classList.remove("open");
      trigger.setAttribute("aria-expanded", "false");
      dropdown.style.left = "";
      dropdown.style.top = "";
      dropdown.style.bottom = "";
      dropdown.style.width = "";
      dropdown.style.maxHeight = "";
      clearPositionListeners();
    };

    const selectValue = (entityId, title) => {
      hidden.value = entityId || "";
      this._settings.weather_entity = entityId || null;
      const label = trigger.querySelector(".hw-entity-select-label");
      if (label) {
        label.innerHTML = entityId
          ? `<span class="hw-entity-select-title">${this._escapeHtml(title || this._getWeatherEntityIntegrationName(entityId))}</span><span class="hw-entity-select-sub">${this._escapeHtml(entityId)}</span>`
          : `<span class="hw-entity-select-title">Select weather entity…</span>`;
      }
      trigger.classList.toggle("is-placeholder", !entityId);
      dropdown.querySelectorAll(".hw-entity-select-option").forEach((opt) => {
        opt.setAttribute("aria-selected", opt.dataset.value === entityId ? "true" : "false");
      });
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
      close();
    };

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = root.classList.toggle("open");
      trigger.setAttribute("aria-expanded", isOpen ? "true" : "false");
      if (isOpen) {
        positionDropdown();
        scrollListener = () => close();
        resizeListener = () => positionDropdown();
        window.addEventListener("scroll", scrollListener, true);
        window.addEventListener("resize", resizeListener);
      } else {
        close();
      }
    });

    dropdown.querySelectorAll(".hw-entity-select-option").forEach((opt) => {
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        selectValue(opt.dataset.value || "", opt.querySelector(".hw-entity-select-title")?.textContent?.trim() || "");
      });
    });

    if (!container._weatherEntitySelectDocBound) {
      container._weatherEntitySelectDocBound = true;
      container.addEventListener("click", (e) => {
        if (!e.target?.closest?.("[data-weather-entity-select]")) {
          container.querySelectorAll("[data-weather-entity-select].open").forEach((el) => {
            el.classList.remove("open");
            el.querySelector(".hw-entity-select-trigger")?.setAttribute("aria-expanded", "false");
            const dd = el.querySelector(".hw-entity-select-dropdown");
            if (dd) {
              dd.style.left = "";
              dd.style.top = "";
              dd.style.bottom = "";
              dd.style.width = "";
              dd.style.maxHeight = "";
            }
          });
          clearPositionListeners();
        }
      });
    }
  }

  _syncMediaPlayerFromCard(index) {
    const s = this.shadowRoot;
    if (!s) return;
    const cards = s.querySelector("#media-player-list")?.querySelectorAll(".media-player-card") || [];
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
      this._patchSunPanelTimes();
      this._patchAtmosphereTheme();
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
    const tzOffsetHours = -d.getTimezoneOffset() / 60;
    const sunriseOffset = 12 - (1 / 15) * (hourAngle + eqTime) - lon / 15 + tzOffsetHours;
    const sunsetOffset = 12 + (1 / 15) * (hourAngle - eqTime) - lon / 15 + tzOffsetHours;
    const sunrise = new Date(year, month - 1, day);
    sunrise.setHours(Math.floor(sunriseOffset), Math.round((sunriseOffset % 1) * 60), 0, 0);
    const sunset = new Date(year, month - 1, day);
    sunset.setHours(Math.floor(sunsetOffset), Math.round((sunsetOffset % 1) * 60), 0, 0);
    return { sunrise, sunset, solar_noon: null, day_length: null, civil_twilight_begin: null, civil_twilight_end: null };
  }

  _getSunTimes(lat, lon, date) {
    // Handle null/undefined coordinates gracefully
    if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return { sunrise: null, sunset: null, solar_noon: null, day_length: null, civil_twilight_begin: null, civil_twilight_end: null };
    }
    const d = date instanceof Date ? date : new Date(date);
    const dateStr = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const key = `${lat.toFixed(4)}_${lon.toFixed(4)}_${dateStr}`;
    if (this._sunTimesCache && this._sunTimesCache[key]) return this._sunTimesCache[key];
    return this._getSunTimesMath(lat, lon, date);
  }

  _parseForecastDatetime(value) {
    if (value == null) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const parsed = new Date(String(value).replace(" ", "T"));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  _isDayTime(datetime, lat, lon) {
    if (datetime == null || lat == null || lon == null) return true;
    const d = datetime instanceof Date ? datetime : this._parseForecastDatetime(datetime);
    if (!d || Number.isNaN(d.getTime())) return true;

    const sunState = this._hass?.states?.["sun.sun"];
    if (sunState && Math.abs(Date.now() - d.getTime()) < 120000) {
      if (sunState.state === "above_horizon") return true;
      if (sunState.state === "below_horizon") return false;
    }

    const { sunrise, sunset } = this._getSunTimes(lat, lon, d);
    if (!sunrise || !sunset) return d.getHours() >= 7 && d.getHours() < 19;
    const t = d.getTime();
    return t >= sunrise.getTime() && t <= sunset.getTime();
  }

  _getHomeCoordinates() {
    const h = this._hass;

    // Priority 1: zone.home — matches HA map "Home" and is user-editable.
    const zoneHome = h?.states?.["zone.home"];
    if (zoneHome?.attributes?.latitude != null && zoneHome?.attributes?.longitude != null) {
      const lat = Number(zoneHome.attributes.latitude);
      const lon = Number(zoneHome.attributes.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return { lat, lon };
      }
    }

    // Priority 2: Home Assistant core config (Settings → General → Home location).
    if (h?.config?.latitude != null && h?.config?.longitude != null) {
      const lat = Number(h.config.latitude);
      const lon = Number(h.config.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return { lat, lon };
      }
    }

    // Do not fall back to weather-entity lat/lon — that is the forecast grid point,
    // not the user's home (e.g. a Brooklyn home can map to a NJ grid cell).
    return { lat: null, lon: null };
  }

  _formatWindyCoordinate(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    // Windy embed requires coordinates with a decimal part (see embed.windy.com/config/map).
    return n.toFixed(6);
  }

  _hasValidHomeCoordinates() {
    const { lat, lon } = this._getHomeCoordinates();
    return lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon);
  }

  _buildWindyUrl(product = "radar") {
    const { lat, lon } = this._getHomeCoordinates();
    if (lat == null || lon == null) return null;
    const latStr = this._formatWindyCoordinate(lat);
    const lonStr = this._formatWindyCoordinate(lon);
    if (latStr == null || lonStr == null) return null;

    const params = new URLSearchParams({
      type: "map",
      location: "coordinates",
      metricRain: "in",
      metricTemp: "°F",
      metricWind: "mph",
      zoom: "9",
      overlay: product,
      product,
      level: "surface",
      lat: latStr,
      lon: lonStr,
      detailLat: latStr,
      detailLon: lonStr,
      marker: "true",
      pressure: "true",
      message: "false",
      play: "0",
    });
    return `https://embed.windy.com/embed.html?${params.toString()}`;
  }

  _prepareGraphData() {
    const hourly = (this._weatherData?.hourly_forecast) || [];
    const windUnit = (this._weatherData?.current?.wind_speed_unit || "mph").toLowerCase();
    this._graphData = hourly.slice(0, 24).map((h) => ({
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
    this._graphWindUnit = windUnit;
  }

  _isNightTime(datetime) {
    const { lat, lon } = this._getHomeCoordinates();
    return !this._isDayTime(datetime, lat, lon);
  }

  _getConditionLabel(condition, datetime, conditionLabel) {
    if (conditionLabel) return conditionLabel;
    return this._conditionLabelFromSlug(condition) || "—";
  }

  _conditionLabelFromSlug(condition) {
    const slug = this._canonicalConditionSlug(condition);
    const labels = {
      "clear-night": "Clear Night",
      cloudy: "Cloudy",
      exceptional: "Exceptional",
      hurricane: "Hurricane",
      "tropical-storm": "Tropical Storm",
      tornado: "Tornado",
      fog: "Fog",
      hail: "Hail",
      thunderstorm: "Thunderstorm",
      partlycloudy: "Partly Cloudy",
      pouring: "Pouring Rain",
      rainy: "Rain",
      snowy: "Snow",
      "snowy-rainy": "Snow & Rain",
      sunny: "Sunny",
      windy: "Windy",
      "windy-variant": "Windy & Cloudy",
    };
    return labels[slug] || "";
  }

  _canonicalConditionSlug(condition) {
    const c = (condition || "").toLowerCase().replace(/[\s_-]+/g, "");
    if (c === "clearnight") return "clear-night";
    if (c === "lightningrainy" || c === "lightning" || c === "thunderstorm" || c === "thunderstorms") return "thunderstorm";
    if (c === "snowyrainy") return "snowy-rainy";
    if (c === "windyvariant") return "windy-variant";
    if (c === "heavyrain") return "pouring";
    if (c.includes("pour")) return "pouring";
    if (c === "tropicalstorm") return "tropical-storm";
    if (c === "hurricane" || c.includes("hurricane")) return "hurricane";
    if (c === "tornado" || c.includes("tornado")) return "tornado";
    if (c.includes("tropical")) return "tropical-storm";
    if (c.includes("thunder") || c.includes("lightning") || c === "storm" || c === "storms") return "thunderstorm";
    if (c.includes("snow") && c.includes("rain")) return "snowy-rainy";
    if (c.includes("snow") || c.includes("blizzard") || c.includes("flurr")) return "snowy";
    if (c.includes("rain") || c.includes("drizzle") || c.includes("shower")) return "rainy";
    if (c.includes("fog") || c.includes("mist") || c.includes("haze")) return "fog";
    if (c.includes("hail")) return "hail";
    if (c.includes("wind") && c.includes("cloud")) return "windy-variant";
    if (c.includes("wind") || c.includes("breezy")) return "windy";
    if (c.includes("partly")) return "partlycloudy";
    if (c.includes("cloud") || c.includes("overcast")) return "cloudy";
    if (c.includes("clear") || c.includes("sun") || c.includes("fair")) return "sunny";
    return c || "cloudy";
  }

  _formatConditionText(entry) {
    if (entry && typeof entry === "object" && entry.condition_label) {
      return entry.condition_label;
    }
    const raw = typeof entry === "object" ? (entry?.condition || entry?.state || "") : entry;
    if (!raw || !String(raw).trim()) return "—";
    return this._conditionLabelFromSlug(raw) || String(raw).replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
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
    const c = this._canonicalConditionSlug(condition).replace(/-/g, "");
    const when = datetime instanceof Date ? datetime : this._parseForecastDatetime(datetime);
    const isNight = forceDay ? false : this._isNightTime(when ?? datetime);
    // 7-day forecast: ONLY icons with "day" in filename. Others use day/night variants.
    const dayOnlyMap = {
      sunny: "clear-day", clear: "clear-day", fair: "clear-day", clearskies: "clear-day",
      partlycloudy: "partly-cloudy-day",
      cloudy: "overcast-day", overcast: "overcast-day",
      fog: "fog-day", foggy: "fog-day", mist: "fog-day", hazy: "haze-day",
      rainy: "partly-cloudy-day-rain", rain: "partly-cloudy-day-rain", drizzle: "partly-cloudy-day-drizzle",
      pouring: "partly-cloudy-day-rain", pouringrain: "partly-cloudy-day-rain",
      snowy: "partly-cloudy-day-snow", snow: "partly-cloudy-day-snow", flurries: "partly-cloudy-day-snow",
      thunderstorm: "thunderstorms-day", lightning: "thunderstorms-day", lightningrainy: "thunderstorms-day",
      hail: "partly-cloudy-day-hail", snowyrainy: "partly-cloudy-day-sleet", sleet: "partly-cloudy-day-sleet",
      windy: "partly-cloudy-day", windyvariant: "partly-cloudy-day", exceptional: "overcast-day",
      hurricane: "hurricane", tropicalstorm: "hurricane", tornado: "thunderstorms-day",
      clearnight: "clear-night",
    };
    const dayMap = {
      sunny: "clear-day", clear: "clear-day", fair: "clear-day", clearskies: "clear-day",
      partlycloudy: "partly-cloudy-day",
      cloudy: "cloudy", overcast: "overcast-day",
      fog: "fog-day", foggy: "fog-day", mist: "mist", hazy: "haze-day",
      rainy: "rain", rain: "rain", drizzle: "drizzle", pouring: "rain", pouringrain: "rain",
      snowy: "snow", snow: "snow", flurries: "snow",
      thunderstorm: "thunderstorms-day", lightning: "thunderstorms-day", lightningrainy: "thunderstorms-day",
      hail: "hail", snowyrainy: "sleet", sleet: "sleet", windy: "wind", windyvariant: "wind",
      exceptional: "cloudy", clearnight: "clear-night",
      hurricane: "hurricane", tropicalstorm: "hurricane", tornado: "thunderstorms-day",
    };
    const nightMap = {
      sunny: "clear-night", clear: "clear-night", fair: "clear-night", clearskies: "clear-night",
      partlycloudy: "partly-cloudy-night",
      cloudy: "cloudy", overcast: "overcast-night",
      fog: "fog-night", foggy: "fog-night", mist: "mist", hazy: "haze-night",
      rainy: "rain", rain: "rain", drizzle: "drizzle", pouring: "rain", pouringrain: "rain",
      snowy: "snow", snow: "snow", flurries: "snow",
      thunderstorm: "thunderstorms-night", lightning: "thunderstorms-night", lightningrainy: "thunderstorms-night",
      hail: "hail", snowyrainy: "sleet", sleet: "sleet", windy: "wind", windyvariant: "wind",
      exceptional: "cloudy", clearnight: "clear-night",
      hurricane: "hurricane", tropicalstorm: "hurricane", tornado: "thunderstorms-night",
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
    const w = size === "large" ? 140 : 48;
    const h = size === "large" ? 112 : 40;
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

  _getAtmosphereTheme(condition, cloudCoverage, now) {
    const slug = this._canonicalConditionSlug(condition);
    const isNight = this._isNightTime(now);
    let mood = "cloudy";
    if (slug === "thunderstorm" || slug === "hurricane" || slug === "tropical-storm" || slug === "tornado") mood = "storm";
    else if (slug === "hail") mood = "hail";
    else if (slug === "snowy-rainy") mood = "sleet";
    else if (slug === "snowy") mood = "snow";
    else if (slug === "pouring" || slug === "rainy") mood = "rain";
    else if (slug === "fog") mood = "fog";
    else if (slug === "partlycloudy") mood = "partly";
    else if (slug === "sunny" || slug === "clear-night") mood = "clear";
    else if (slug === "cloudy" || slug === "windy-variant") mood = "cloudy";

    let cloudOpacity = 0.45;
    if (cloudCoverage != null) {
      cloudOpacity = Math.max(0.12, Math.min(0.95, cloudCoverage / 100));
    } else if (mood === "clear") cloudOpacity = isNight ? 0.2 : 0.12;
    else if (mood === "partly") cloudOpacity = isNight ? 0.4 : 0.35;
    else if (mood === "cloudy") cloudOpacity = isNight ? 0.78 : 0.72;
    else if (mood === "rain" || mood === "storm") cloudOpacity = isNight ? 0.88 : 0.82;
    else if (mood === "snow" || mood === "sleet" || mood === "hail") cloudOpacity = isNight ? 0.85 : 0.78;
    else if (mood === "fog") cloudOpacity = isNight ? 0.7 : 0.65;

    const intensity = cloudCoverage != null
      ? Math.max(0.35, Math.min(1, cloudCoverage / 100))
      : (mood === "clear" ? 0.3 : mood === "storm" ? 0.9 : 0.65);
    const timeClass = isNight ? "atmosphere--night" : "atmosphere--day";
    const className = `atmosphere--${mood} ${timeClass}`;
    return { className, cloudOpacity, isNight, intensity, mood };
  }

  _destroyAtmosphereParticles() {
    if (!this._atmosphereAnim) return;
    cancelAnimationFrame(this._atmosphereAnim.rafId);
    this._atmosphereAnim.resizeObserver?.disconnect();
    this._atmosphereAnim = null;
  }

  _initAtmosphereParticles() {
    this._destroyAtmosphereParticles();
    const s = this.shadowRoot;
    if (!s || this._currentView !== "forecast") return;
    const card = s.querySelector(".atmosphere-card:not(.skeleton-card)");
    if (!card) return;

    const mood = card.dataset.atmosphereMood;
    if (!mood || !["rain", "storm", "hail", "sleet"].includes(mood)) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const container = card.querySelector(".atmosphere-bg__particles");
    if (!container) return;

    let canvas = container.querySelector(".atmosphere-particles-canvas");
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.className = "atmosphere-particles-canvas";
      container.appendChild(canvas);
    }

    const intensity = Math.max(0.35, Math.min(1, parseFloat(card.style.getPropertyValue("--atmosphere-intensity")) || 0.65));
    const isNight = card.classList.contains("atmosphere--night");
    const ctx = canvas.getContext("2d");
    const windRaw = parseFloat(card.dataset.windSpeed);
    const windMph = Number.isFinite(windRaw) ? windRaw : 12;
    const windSlant = Math.min(0.32, (windMph / 55) * 0.22);
    const windAngle = -0.06 - windSlant - intensity * 0.05;
    const state = {
      canvas,
      ctx,
      mood,
      intensity,
      isNight,
      windAngle,
      width: 0,
      height: 0,
      dpr: 1,
      particles: [],
      splashes: [],
      lightning: { cooldown: 2.5 + Math.random() * 4, flash: 0, afterglow: 0, bolts: null },
      rafId: 0,
      lastTs: 0,
      resizeObserver: null,
    };

    const resize = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      state.dpr = Math.min(window.devicePixelRatio || 1, 2);
      state.width = rect.width;
      state.height = rect.height;
      canvas.width = Math.floor(rect.width * state.dpr);
      canvas.height = Math.floor(rect.height * state.dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
      state.particles = this._createAtmosphereParticles(state);
      state.splashes = [];
    };

    resize();
    state.resizeObserver = new ResizeObserver(resize);
    state.resizeObserver.observe(container);

    const tick = (ts) => {
      if (!this._atmosphereAnim || this._atmosphereAnim !== state) return;
      const dt = state.lastTs ? Math.min(0.05, (ts - state.lastTs) / 1000) : 0.016;
      state.lastTs = ts;
      this._drawAtmosphereParticles(state, dt);
      state.rafId = requestAnimationFrame(tick);
    };

    this._atmosphereAnim = state;
    state.rafId = requestAnimationFrame(tick);
  }

  _createAtmosphereParticles(state) {
    const { mood, intensity, width, height, windAngle } = state;
    const particles = [];
    const areaFactor = Math.max(0.55, Math.sqrt((width * height) / 90000));

    const addRainLayer = (layer, countMul) => {
      const specs = {
        far: { len: [5, 11], speed: [420, 520], opacity: [0.06, 0.14], width: [0.45, 0.75], z: 0 },
        mid: { len: [11, 20], speed: [520, 640], opacity: [0.14, 0.32], width: [0.7, 1.1], z: 1 },
        near: { len: [18, 32], speed: [640, 820], opacity: [0.28, 0.52], width: [1.0, 1.6], z: 2 },
      }[layer];
      const count = Math.floor(countMul * intensity * areaFactor);
      for (let i = 0; i < count; i += 1) {
        const slant = windAngle + (Math.random() - 0.5) * 0.06;
        particles.push({
          kind: "rain",
          z: specs.z,
          x: Math.random() * (width + 40) - 20,
          y: Math.random() * (height + specs.len[1]),
          len: specs.len[0] + Math.random() * (specs.len[1] - specs.len[0]),
          speed: specs.speed[0] + Math.random() * (specs.speed[1] - specs.speed[0]),
          slant,
          opacity: specs.opacity[0] + Math.random() * (specs.opacity[1] - specs.opacity[0]),
          width: specs.width[0] + Math.random() * (specs.width[1] - specs.width[0]),
        });
      }
    };

    if (mood === "rain") {
      addRainLayer("far", 55);
      addRainLayer("mid", 48);
      addRainLayer("near", 28);
    } else if (mood === "storm") {
      addRainLayer("far", 70);
      addRainLayer("mid", 62);
      addRainLayer("near", 38);
    } else if (mood === "sleet") {
      addRainLayer("far", 28);
      addRainLayer("mid", 24);
      addRainLayer("near", 14);
      const snowCount = Math.floor(28 * intensity * areaFactor);
      for (let i = 0; i < snowCount; i += 1) {
        particles.push({
          kind: "snow",
          z: 1,
          x: Math.random() * width,
          y: Math.random() * height,
          radius: 0.7 + Math.random() * 1.6,
          speed: 28 + Math.random() * 38,
          drift: Math.sin(windAngle) * 18 + (Math.random() - 0.5) * 12,
          opacity: 0.25 + Math.random() * 0.45,
          phase: Math.random() * Math.PI * 2,
        });
      }
    }

    if (mood === "hail") {
      const count = Math.floor(42 * intensity * areaFactor);
      for (let i = 0; i < count; i += 1) {
        const size = 1.4 + Math.random() * 2.8;
        particles.push({
          kind: "hail",
          z: size > 3 ? 2 : 1,
          x: Math.random() * width,
          y: Math.random() * (height + 30),
          size,
          speed: 480 + Math.random() * 260 + size * 20,
          drift: Math.sin(windAngle) * 55 + (Math.random() - 0.5) * 35,
          opacity: 0.55 + Math.random() * 0.35,
          rotation: Math.random() * Math.PI * 2,
          spin: (Math.random() - 0.5) * 8,
          wobble: Math.random() * Math.PI * 2,
        });
      }
    }

    particles.sort((a, b) => (a.z || 0) - (b.z || 0));
    return particles;
  }

  _spawnRainSplash(state, x) {
    if (state.splashes.length > 24) return;
    state.splashes.push({
      x,
      y: state.height - 1 - Math.random() * 3,
      r: 0.5 + Math.random() * 1.5,
      life: 0.35 + Math.random() * 0.2,
      maxLife: 0.5,
    });
  }

  _drawRainStreak(ctx, p, width, height, color, intensity) {
    const sl = p.slant || 0;
    const dx = Math.sin(sl) * p.len;
    const dy = Math.cos(sl) * p.len;
    const x2 = p.x + dx;
    const y2 = p.y + dy;
    const alpha = p.opacity * (0.75 + intensity * 0.25);

    const grad = ctx.createLinearGradient(p.x, p.y, x2, y2);
    grad.addColorStop(0, `rgba(${color}, 0)`);
    grad.addColorStop(0.12, `rgba(${color}, ${alpha * 0.35})`);
    grad.addColorStop(0.45, `rgba(${color}, ${alpha})`);
    grad.addColorStop(0.85, `rgba(${color}, ${alpha * 0.55})`);
    grad.addColorStop(1, `rgba(${color}, 0)`);

    ctx.strokeStyle = grad;
    ctx.lineWidth = p.width;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  _drawHailStone(ctx, p, color, isNight) {
    const { x, y, size, opacity, rotation } = p;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);

    const sides = 6;
    ctx.beginPath();
    for (let i = 0; i < sides; i += 1) {
      const a = (i / sides) * Math.PI * 2;
      const r = size * (0.82 + Math.sin(i * 2.1) * 0.18);
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();

    const body = ctx.createRadialGradient(-size * 0.25, -size * 0.3, 0, 0, 0, size * 1.2);
    body.addColorStop(0, `rgba(255, 255, 255, ${opacity * 0.95})`);
    body.addColorStop(0.45, `rgba(${color}, ${opacity * 0.85})`);
    body.addColorStop(1, `rgba(${isNight ? "120, 135, 160" : "160, 175, 195"}, ${opacity * 0.7})`);
    ctx.fillStyle = body;
    ctx.fill();

    ctx.strokeStyle = `rgba(255, 255, 255, ${opacity * 0.35})`;
    ctx.lineWidth = 0.6;
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = `rgba(0, 0, 0, ${opacity * 0.12})`;
    ctx.beginPath();
    ctx.ellipse(x + size * 0.15, y + size * 0.85, size * 0.9, size * 0.25, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawAtmosphereParticles(state, dt) {
    const { ctx, width, height, particles, mood, isNight, intensity, windAngle } = state;
    ctx.clearRect(0, 0, width, height);

    const rainColor = isNight ? "155, 185, 220" : "175, 205, 235";
    const hailColor = isNight ? "195, 210, 225" : "225, 235, 245";

    if (mood === "rain" || mood === "storm" || mood === "sleet") {
      const mist = ctx.createLinearGradient(0, height * 0.72, 0, height);
      mist.addColorStop(0, "rgba(255,255,255,0)");
      mist.addColorStop(1, isNight ? "rgba(100,120,150,0.12)" : "rgba(180,200,220,0.14)");
      ctx.fillStyle = mist;
      ctx.fillRect(0, height * 0.72, width, height * 0.28);
    }

    for (const p of particles) {
      if (p.kind === "rain") {
        const vx = Math.sin(p.slant) * p.speed;
        const vy = Math.cos(p.slant) * p.speed;
        p.x += vx * dt;
        p.y += vy * dt;

        if (p.y > height + p.len) {
          if (p.z >= 2 && Math.random() < 0.08) this._spawnRainSplash(state, p.x);
          p.y = -p.len - Math.random() * height * 0.35;
          p.x = Math.random() * (width + 60) - 30;
        }
        if (p.x < -40) p.x = width + 30;
        if (p.x > width + 40) p.x = -30;

        this._drawRainStreak(ctx, p, width, height, rainColor, intensity);
      } else if (p.kind === "hail") {
        p.wobble += dt * 5;
        p.rotation += p.spin * dt;
        p.x += (p.drift + Math.sin(p.wobble) * 12) * dt;
        p.y += p.speed * dt;
        if (p.y > height + p.size * 2) {
          p.y = -p.size * 2 - Math.random() * 40;
          p.x = Math.random() * width;
          p.speed = 480 + Math.random() * 260 + p.size * 20;
        }
        this._drawHailStone(ctx, p, hailColor, isNight);
      } else if (p.kind === "snow") {
        p.phase += dt * 2;
        p.x += (p.drift + Math.sin(p.phase) * 6) * dt;
        p.y += p.speed * dt;
        if (p.y > height + 6) {
          p.y = -6;
          p.x = Math.random() * width;
        }
        ctx.fillStyle = `rgba(240, 248, 255, ${p.opacity})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    for (let i = state.splashes.length - 1; i >= 0; i -= 1) {
      const s = state.splashes[i];
      s.life -= dt;
      if (s.life <= 0) {
        state.splashes.splice(i, 1);
        continue;
      }
      const t = 1 - s.life / s.maxLife;
      const alpha = (1 - t) * 0.35;
      ctx.strokeStyle = `rgba(${rainColor}, ${alpha})`;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, s.r + t * 3, (s.r * 0.35) + t * 1.2, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (mood === "storm") {
      state.windAngle = windAngle + Math.sin(state.lastTs * 0.0004) * 0.015;
      this._drawAtmosphereLightning(state, dt, width, height, isNight);
    }
  }

  _drawAtmosphereLightning(state, dt, width, height, isNight) {
    const bolt = state.lightning;
    bolt.cooldown -= dt;
    if (bolt.flash > 0) bolt.flash = Math.max(0, bolt.flash - dt * 5.5);
    if (bolt.afterglow > 0) bolt.afterglow = Math.max(0, bolt.afterglow - dt * 1.8);

    if (bolt.cooldown <= 0 && bolt.flash <= 0.02) {
      const strike = Math.random() < 0.62;
      bolt.flash = strike ? 1 : 0.25 + Math.random() * 0.2;
      bolt.afterglow = strike ? 0.45 : 0.15;
      bolt.cooldown = 4 + Math.random() * 7;
      if (strike) {
        const startX = width * (0.2 + Math.random() * 0.6);
        bolt.bolts = this._generateLightningTree(startX, -4, height * (0.28 + Math.random() * 0.22));
      } else {
        bolt.bolts = null;
      }
    }

    const totalFlash = Math.max(bolt.flash, bolt.afterglow * 0.4);
    if (totalFlash <= 0.01) {
      bolt.bolts = null;
      return;
    }

    const cloudGlow = state.ctx.createRadialGradient(width * 0.5, 0, 0, width * 0.5, 0, width * 0.85);
    cloudGlow.addColorStop(0, `rgba(${isNight ? "140,155,200" : "200,210,240"}, ${totalFlash * 0.35})`);
    cloudGlow.addColorStop(0.45, `rgba(${isNight ? "100,120,170" : "170,185,220"}, ${totalFlash * 0.12})`);
    cloudGlow.addColorStop(1, "rgba(0,0,0,0)");
    state.ctx.fillStyle = cloudGlow;
    state.ctx.fillRect(0, 0, width, height);

    const ambient = totalFlash * (isNight ? 0.18 : 0.1);
    state.ctx.fillStyle = `rgba(${isNight ? "170, 185, 255" : "230, 238, 255"}, ${ambient})`;
    state.ctx.fillRect(0, 0, width, height);

    if (bolt.bolts) {
      this._strokeLightningTree(state.ctx, bolt.bolts, totalFlash, true);
    }
  }

  _generateLightningTree(startX, startY, targetY) {
    const main = this._generateLightningPath(startX, startY, startX + (Math.random() - 0.5) * 24, targetY, 0, 5);
    const branches = [];
    for (let i = 2; i < main.length - 2; i += 1) {
      if (Math.random() > 0.38) continue;
      const pt = main[i];
      const branchLen = (targetY - pt.y) * (0.25 + Math.random() * 0.35);
      const dir = Math.random() < 0.5 ? -1 : 1;
      branches.push(
        this._generateLightningPath(
          pt.x, pt.y,
          pt.x + dir * (18 + Math.random() * 32),
          pt.y + branchLen,
          1, 3
        )
      );
    }
    return { main, branches };
  }

  _generateLightningPath(x1, y1, x2, y2, depth, maxDepth) {
    const points = [{ x: x1, y: y1 }];
    const segments = 5 + Math.floor(Math.random() * 4);
    const displacement = Math.max(8, 32 - depth * 8);
    let cx = x1;
    let cy = y1;
    for (let i = 1; i <= segments; i += 1) {
      const t = i / segments;
      const tx = x1 + (x2 - x1) * t;
      const ty = y1 + (y2 - y1) * t;
      cx = tx + (Math.random() - 0.5) * displacement;
      cy = ty;
      points.push({ x: cx, y: cy });
    }
    if (depth < maxDepth && points.length > 2 && Math.random() < 0.3) {
      const mid = points[Math.floor(points.length / 2)];
      points.push(...this._generateLightningPath(mid.x, mid.y, mid.x + (Math.random() - 0.5) * 40, mid.y + 30 + Math.random() * 40, depth + 1, maxDepth).slice(1));
    }
    return points;
  }

  _strokeLightningTree(ctx, tree, flash, isMain) {
    const alpha = Math.min(1, flash);
    const drawPath = (points, width, glow) => {
      if (!points || points.length < 2) return;
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.shadowColor = `rgba(180, 210, 255, ${alpha * glow})`;
      ctx.shadowBlur = 16 * glow;
      ctx.strokeStyle = `rgba(220, 235, 255, ${alpha * 0.55 * glow})`;
      ctx.lineWidth = width * 2.2;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
      ctx.stroke();
      ctx.shadowBlur = 6;
      ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.95})`;
      ctx.lineWidth = width;
      ctx.stroke();
      ctx.restore();
    };

    drawPath(tree.main, isMain ? 2.4 : 1.6, 1);
    for (const branch of tree.branches || []) {
      drawPath(branch, 1.2, 0.65);
    }
  }

  _buildAtmosphereMetrics({
    feelsLike, temp, humidity, dewPoint, windSpeed, windGusts, windUnit,
    uvIndex, pressure, pressureUnit, cloudCoverage,
  }) {
    const metrics = [];
    if (feelsLike != null) {
      let sub = "";
      if (temp != null && feelsLike !== temp) {
        const diff = feelsLike - temp;
        sub = diff > 0 ? `${Math.abs(diff)}° warmer than actual` : `${Math.abs(diff)}° cooler than actual`;
      }
      metrics.push({ key: "feels", label: "Feels", value: `${feelsLike}°`, sub });
    }
    if (humidity != null) {
      metrics.push({
        key: "humidity",
        label: "Humidity",
        value: `${humidity}%`,
        sub: dewPoint != null ? `Dew ${Math.round(dewPoint)}°` : "",
      });
    }
    if (windSpeed != null) {
      const unit = (windUnit || "mph").toLowerCase();
      metrics.push({
        key: "wind",
        label: "Wind",
        value: `${Math.round(windSpeed)} ${unit}`,
        sub: windGusts != null ? `Gusts ${Math.round(windGusts)}` : "",
        windSpeed: Math.round(windSpeed),
      });
    }
    if (uvIndex != null) {
      const uv = Math.round(uvIndex);
      const sub = uv >= 8 ? "Very high" : uv >= 6 ? "High" : uv >= 3 ? "Moderate" : "Low";
      metrics.push({
        key: "uv",
        label: "UV Index",
        value: `${uv}`,
        sub,
        uvPercent: Math.min(100, (uv / 11) * 100),
      });
    }
    if (pressure != null) {
      metrics.push({
        key: "pressure",
        label: "Pressure",
        value: `${Math.round(pressure)}`,
        sub: pressureUnit || "hPa",
      });
    }
    if (cloudCoverage != null) {
      metrics.push({
        key: "clouds",
        label: "Clouds",
        value: `${Math.round(cloudCoverage)}%`,
        sub: "",
        cloudPercent: Math.round(cloudCoverage),
      });
    }
    return metrics;
  }

  _getMetricIcon(key) {
    const icons = {
      feels: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M15 13V5a3 3 0 0 0-6 0v8a5 5 0 1 0 6 0zm-4-8a1 1 0 0 1 2 0v7.17a3 3 0 1 1-2 0V5z"/></svg>',
      humidity: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0L12 2.69z"/></svg>',
      wind: '<svg class="metric-wind-arrow" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14.5 17c0 1.65-1.35 3-3 3s-3-1.35-3-3h2a1 1 0 1 1 2 0h2zm-1.45-9.98L17 7H3v2h10.45l-3.98 3.98 1.41 1.42L20.84 8l-7.96-7.96-1.41 1.42 3.97 3.98z"/></svg>',
      uv: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.42 1.79-1.8zM20 10.5v2h3v-2h-3zm-8 5c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6zm-1 4.95h2V19.5h-2v2.55zm-7.45-1.96l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z"/></svg>',
      pressure: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67V7z"/></svg>',
      clouds: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg>',
    };
    return icons[key] || "";
  }

  _renderAtmosphereHiLo(hiTemp, loTemp, temp, esc) {
    if (hiTemp == null || loTemp == null) return "";
    const span = Math.max(1, hiTemp - loTemp);
    let currentPos = 50;
    if (typeof temp === "number") {
      currentPos = Math.max(4, Math.min(96, ((temp - loTemp) / span) * 100));
    }
    return `
      <div class="atmosphere-hilo">
        <div class="atmosphere-hilo-labels">
          <span class="atmosphere-hilo-lo">${esc(loTemp)}°</span>
          <span class="atmosphere-hilo-title">Today's range</span>
          <span class="atmosphere-hilo-hi">${esc(hiTemp)}°</span>
        </div>
        <div class="atmosphere-hilo-track">
          <div class="atmosphere-hilo-fill"></div>
          <div class="atmosphere-hilo-marker" style="left:${currentPos}%"></div>
        </div>
      </div>
    `;
  }

  _renderAtmosphereMetrics(metrics, esc) {
    if (!metrics.length) return "";
    return metrics.map((m, i) => {
      const uvBar = m.key === "uv" && m.uvPercent != null
        ? `<div class="metric-uv-bar" aria-hidden="true"><span class="metric-uv-fill" style="width:${m.uvPercent}%"></span></div>`
        : "";
      const subHtml = m.sub ? `<div class="metric-sub">${esc(m.sub)}</div>` : "";
      return `
        <div class="metric-glass metric-glass--${esc(m.key)}" style="--metric-i:${i}" data-metric="${esc(m.key)}">
          <div class="metric-head">
            <span class="metric-icon">${this._getMetricIcon(m.key)}</span>
            <span class="metric-label">${esc(m.label)}</span>
          </div>
          <div class="metric-value">${esc(m.value)}</div>
          ${subHtml}
          ${uvBar}
        </div>
      `;
    }).join("");
  }

  _render() {
    const s = this.shadowRoot;
    if (!s) return;
    this._applyTheme();
    this._apexCharts.forEach((ch) => { try { ch.destroy(); } catch (_) {} });
    this._apexCharts = [];
    // Preserve the Windy iframe across full re-renders when the target URL is unchanged.
    const prevIframe = s.querySelector(".maps-windy-frame iframe");
    const prevWindyUrl = prevIframe ? prevIframe.getAttribute("src") : null;
    const expectedWindyUrl = this._mapsMode !== "storms" ? this._buildWindyUrl(this._mapsMode) : null;
    const canPreserveWindy = prevIframe && prevWindyUrl && expectedWindyUrl && prevWindyUrl === expectedWindyUrl;
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
          --hw-border: #252525;
          --hw-border-strong: #333333;
          --hw-hover: #222222;
          /* Neutral overlays (flip with theme via _applyTheme). Defaults match
             the dark theme; the light theme swaps in dark-tinted equivalents so
             subtle fills/dividers stay visible on light surfaces. */
          --hw-overlay-subtle: rgba(255, 255, 255, 0.025);
          --hw-overlay-hover: rgba(255, 255, 255, 0.045);
          --hw-overlay-border: rgba(255, 255, 255, 0.1);
          --hw-overlay-border-strong: rgba(255, 255, 255, 0.16);
          --hw-divider-soft: rgba(255, 255, 255, 0.08);
          /* Match Home Assistant's header/sidebar bar height so the panel's
             menu bar lines up with the "Home Assistant" section on the left.
             Fallback matches the Dashboard topbar so every page is consistent. */
          --hw-menubar-height: var(--header-height, 64px);
          --hw-appbar-height: var(--hw-menubar-height);
          --hw-toolbar-height: 0px;

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
        :host button, :host article, :host section, :host aside:not(.hurricane-status) {
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
        .glass { background: var(--hw-surface); border: 1px solid var(--hw-border-strong); border-radius: var(--radius-xl); box-shadow: var(--shadow-md); }
        :host([data-hw-theme="light"]) .settings-card,
        :host([data-hw-theme="light"]) .settings-sidenav,
        :host([data-hw-theme="light"]) .zone-card,
        :host([data-hw-theme="light"]) .collapsible-section--zone,
        :host([data-hw-theme="light"]) .hourly-card,
        :host([data-hw-theme="light"]) .daily-card,
        :host([data-hw-theme="light"]) .moon-card-fill,
        :host([data-hw-theme="light"]) .sun-panel-card,
        :host([data-hw-theme="light"]) .theme-swatch-row {
          box-shadow: var(--shadow-sm);
        }
        :host([data-hw-theme="light"]) .settings-pane-sub,
        :host([data-hw-theme="light"]) .form-hint { color: var(--hw-muted); }
        .topbar {
          position: sticky;
          top: 0;
          z-index: 100;
          display: flex;
          flex-wrap: nowrap;
          align-items: center;
          gap: var(--space-2) var(--space-3);
          min-width: 0;
          box-sizing: border-box;
          height: var(--header-height, 64px);
          min-height: var(--header-height, 64px);
          max-height: var(--header-height, 64px);
          padding: 0 calc(var(--space-3) + var(--safe-right)) 0 calc(var(--space-3) + var(--safe-left));
          background: var(--hw-surface);
          border-bottom: 1px solid var(--hw-border-strong);
        }
        .topbar .icon-btn { flex-shrink: 0; width: 40px; min-width: 40px; height: 40px; min-height: 40px; }
        .topbar-back-btn {
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 40px;
          min-height: 40px;
          padding: 0 12px;
          margin-left: auto;
          border: 1px solid var(--hw-border-strong);
          background: var(--hw-input-bg);
          border-radius: var(--radius-sm);
          color: var(--hw-text);
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          white-space: nowrap;
          transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
        }
        .topbar-back-btn:hover { background: var(--hw-hover); border-color: var(--hw-border-strong); }
        .topbar-back-btn svg { width: 20px; height: 20px; flex-shrink: 0; }
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

        /* Atmosphere card (hero + details unified) */
        .atmosphere-card {
          position: relative;
          overflow: hidden;
          padding: 0;
          min-height: clamp(300px, 44vw, 400px);
          background: transparent;
          border: 1px solid var(--hw-border);
        }
        .atmosphere-bg {
          position: absolute;
          inset: 0;
          z-index: 0;
          pointer-events: none;
        }
        .atmosphere-bg__gradient {
          position: absolute;
          inset: 0;
          background-size: 220% 220%;
          animation: atmosphereDrift 14s ease-in-out infinite alternate;
        }
        /* Clear sky */
        .atmosphere--clear.atmosphere--day .atmosphere-bg__gradient {
          background: linear-gradient(160deg, #01579b 0%, #0288d1 35%, #4fc3f7 65%, #fff9c4 100%);
        }
        .atmosphere--clear.atmosphere--night .atmosphere-bg__gradient {
          background: linear-gradient(165deg, #020617 0%, #0f172a 30%, #1e1b4b 60%, #312e81 100%);
        }
        /* Partly cloudy */
        .atmosphere--partly.atmosphere--day .atmosphere-bg__gradient {
          background: linear-gradient(155deg, #1565c0 0%, #42a5f5 40%, #90caf9 70%, #ffe082 100%);
        }
        .atmosphere--partly.atmosphere--night .atmosphere-bg__gradient {
          background: linear-gradient(165deg, #0a0e17 0%, #1a237e 40%, #283593 70%, #4527a0 100%);
        }
        /* Cloudy / overcast */
        .atmosphere--cloudy.atmosphere--day .atmosphere-bg__gradient {
          background: linear-gradient(160deg, #1c2833 0%, #37474f 42%, #78909c 100%);
        }
        .atmosphere--cloudy.atmosphere--night .atmosphere-bg__gradient {
          background: linear-gradient(165deg, #0d1117 0%, #1a2332 45%, #2d3748 100%);
        }
        /* Rain */
        .atmosphere--rain.atmosphere--day .atmosphere-bg__gradient {
          background: linear-gradient(180deg, #1a2332 0%, #2c3e50 35%, #4a6278 65%, #6b8499 100%);
        }
        .atmosphere--rain.atmosphere--night .atmosphere-bg__gradient {
          background: linear-gradient(180deg, #040608 0%, #0c1219 30%, #152028 60%, #1e2a36 100%);
        }
        /* Storm */
        .atmosphere--storm.atmosphere--day .atmosphere-bg__gradient {
          background: linear-gradient(180deg, #0a0e12 0%, #151c24 25%, #243040 55%, #3d5163 85%, #4a6175 100%);
        }
        .atmosphere--storm.atmosphere--night .atmosphere-bg__gradient {
          background: linear-gradient(180deg, #020304 0%, #080c10 25%, #101820 55%, #182028 100%);
        }
        /* Snow */
        .atmosphere--snow.atmosphere--day .atmosphere-bg__gradient {
          background: linear-gradient(160deg, #37474f 0%, #78909c 45%, #b0bec5 75%, #eceff1 100%);
        }
        .atmosphere--snow.atmosphere--night .atmosphere-bg__gradient {
          background: linear-gradient(160deg, #1a237e 0%, #37474f 55%, #546e7a 100%);
        }
        /* Sleet */
        .atmosphere--sleet.atmosphere--day .atmosphere-bg__gradient {
          background: linear-gradient(160deg, #263238 0%, #455a64 50%, #78909c 100%);
        }
        .atmosphere--sleet.atmosphere--night .atmosphere-bg__gradient {
          background: linear-gradient(165deg, #0d1117 0%, #263238 50%, #37474f 100%);
        }
        /* Hail */
        .atmosphere--hail.atmosphere--day .atmosphere-bg__gradient {
          background: linear-gradient(180deg, #1c2530 0%, #344552 45%, #536878 100%);
        }
        .atmosphere--hail.atmosphere--night .atmosphere-bg__gradient {
          background: linear-gradient(180deg, #060910 0%, #121a22 50%, #1c2832 100%);
        }
        /* Fog */
        .atmosphere--fog.atmosphere--day .atmosphere-bg__gradient {
          background: linear-gradient(180deg, #78909c 0%, #90a4ae 50%, #b0bec5 100%);
        }
        .atmosphere--fog.atmosphere--night .atmosphere-bg__gradient {
          background: linear-gradient(180deg, #263238 0%, #37474f 60%, #455a64 100%);
        }
        /* Animation layers */
        .atmosphere-bg__clouds,
        .atmosphere-bg__particles,
        .atmosphere-bg__effects {
          position: absolute;
          inset: 0;
          pointer-events: none;
          overflow: hidden;
          opacity: 0;
        }
        .atmosphere-bg__clouds::before,
        .atmosphere-bg__clouds::after {
          content: "";
          position: absolute;
          border-radius: 50%;
          filter: blur(28px);
          background: rgba(255, 255, 255, 0.18);
        }
        .atmosphere-bg__clouds::before { width: 55%; height: 35%; top: 8%; left: -10%; animation: cloudDriftA 28s ease-in-out infinite alternate, cloudBreathe 7s ease-in-out infinite alternate; }
        .atmosphere-bg__clouds::after { width: 45%; height: 30%; top: 18%; right: -8%; animation: cloudDriftB 34s ease-in-out infinite alternate, cloudBreathe 9s ease-in-out infinite alternate-reverse; }
        .atmosphere--clear .atmosphere-bg__clouds,
        .atmosphere--partly .atmosphere-bg__clouds,
        .atmosphere--cloudy .atmosphere-bg__clouds,
        .atmosphere--rain .atmosphere-bg__clouds,
        .atmosphere--storm .atmosphere-bg__clouds,
        .atmosphere--hail .atmosphere-bg__clouds,
        .atmosphere--fog .atmosphere-bg__clouds { opacity: 1; }
        .atmosphere--clear .atmosphere-bg__clouds { opacity: 0.35; }
        .atmosphere--partly .atmosphere-bg__clouds { opacity: 0.65; }
        .atmosphere--cloudy .atmosphere-bg__clouds::before,
        .atmosphere--cloudy .atmosphere-bg__clouds::after {
          background: rgba(200, 210, 220, 0.42);
          filter: blur(36px);
          box-shadow:
            35vw 8vh 0 0 rgba(180, 190, 200, 0.28),
            60vw 18vh 0 0 rgba(160, 175, 190, 0.22),
            -8vw 22vh 0 0 rgba(190, 200, 210, 0.25);
        }
        .atmosphere--rain .atmosphere-bg__clouds::before,
        .atmosphere--rain .atmosphere-bg__clouds::after,
        .atmosphere--hail .atmosphere-bg__clouds::before,
        .atmosphere--hail .atmosphere-bg__clouds::after {
          background: rgba(85, 100, 120, 0.48);
          filter: blur(44px);
          box-shadow:
            28vw 2vh 0 0 rgba(65, 80, 100, 0.38),
            52vw 12vh 0 0 rgba(55, 70, 90, 0.3),
            -8vw 16vh 0 0 rgba(75, 90, 110, 0.32);
        }
        .atmosphere--storm .atmosphere-bg__clouds::before,
        .atmosphere--storm .atmosphere-bg__clouds::after {
          background: rgba(50, 58, 72, 0.58);
          filter: blur(52px);
          box-shadow:
            22vw 0 0 0 rgba(40, 48, 62, 0.45),
            48vw 10vh 0 0 rgba(35, 42, 55, 0.38),
            70vw 6vh 0 0 rgba(45, 52, 65, 0.35);
        }
        .atmosphere--night .atmosphere-bg__clouds::before,
        .atmosphere--night .atmosphere-bg__clouds::after { background: rgba(120, 130, 150, 0.22); }
        /* Rain / hail / storm particles (canvas-driven) */
        .atmosphere-bg__particles {
          opacity: 0;
        }
        .atmosphere--rain .atmosphere-bg__particles,
        .atmosphere--storm .atmosphere-bg__particles,
        .atmosphere--hail .atmosphere-bg__particles,
        .atmosphere--sleet .atmosphere-bg__particles {
          opacity: 1;
        }
        .atmosphere-particles-canvas {
          display: block;
          width: 100%;
          height: 100%;
        }
        /* Snow particles (CSS — lightweight) */
        .atmosphere--snow .atmosphere-bg__particles {
          background: none;
          opacity: calc(0.6 + var(--atmosphere-intensity, 0.6) * 0.3);
        }
        .atmosphere--snow .atmosphere-bg__particles::before {
          content: "";
          position: absolute;
          inset: -20% 0 0 0;
          background-image:
            radial-gradient(2px 2px at 10% 15%, rgba(255,255,255,0.9) 50%, transparent 50%),
            radial-gradient(2px 2px at 25% 35%, rgba(255,255,255,0.85) 50%, transparent 50%),
            radial-gradient(1.5px 1.5px at 40% 10%, rgba(255,255,255,0.8) 50%, transparent 50%),
            radial-gradient(2px 2px at 55% 45%, rgba(255,255,255,0.9) 50%, transparent 50%),
            radial-gradient(1.5px 1.5px at 70% 20%, rgba(255,255,255,0.75) 50%, transparent 50%),
            radial-gradient(2px 2px at 85% 55%, rgba(255,255,255,0.85) 50%, transparent 50%),
            radial-gradient(1.5px 1.5px at 15% 70%, rgba(255,255,255,0.8) 50%, transparent 50%),
            radial-gradient(2px 2px at 35% 85%, rgba(255,255,255,0.9) 50%, transparent 50%),
            radial-gradient(1.5px 1.5px at 60% 75%, rgba(255,255,255,0.7) 50%, transparent 50%),
            radial-gradient(2px 2px at 90% 80%, rgba(255,255,255,0.85) 50%, transparent 50%);
          background-size: 100% 100%;
          animation: snowDrift 5s linear infinite;
        }
        /* Hail uses canvas — no CSS stripe pattern */
        /* Clear day sun */
        .atmosphere--clear.atmosphere--day .atmosphere-bg__effects {
          opacity: 1;
          background: radial-gradient(circle at 22% 20%, rgba(255, 236, 179, 0.55) 0%, rgba(255, 193, 7, 0.15) 18%, transparent 42%);
        }
        .atmosphere--clear.atmosphere--day .atmosphere-bg__effects::before {
          content: "";
          position: absolute;
          top: 20%;
          left: 22%;
          width: 72px;
          height: 72px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(255, 249, 196, 0.9) 0%, rgba(255, 193, 7, 0.4) 40%, transparent 70%);
          animation: sunPulse 6s ease-in-out infinite;
        }
        /* Clear / partly night stars */
        .atmosphere--clear.atmosphere--night .atmosphere-bg__effects,
        .atmosphere--partly.atmosphere--night .atmosphere-bg__effects {
          opacity: 1;
          background-image:
            radial-gradient(1px 1px at 12% 18%, rgba(255,255,255,0.9) 50%, transparent 50%),
            radial-gradient(1px 1px at 28% 8%, rgba(255,255,255,0.7) 50%, transparent 50%),
            radial-gradient(1.5px 1.5px at 45% 22%, rgba(255,255,255,0.85) 50%, transparent 50%),
            radial-gradient(1px 1px at 62% 12%, rgba(255,255,255,0.6) 50%, transparent 50%),
            radial-gradient(1px 1px at 78% 28%, rgba(255,255,255,0.75) 50%, transparent 50%),
            radial-gradient(1.5px 1.5px at 88% 15%, rgba(255,255,255,0.8) 50%, transparent 50%),
            radial-gradient(1px 1px at 18% 42%, rgba(255,255,255,0.55) 50%, transparent 50%),
            radial-gradient(1px 1px at 55% 38%, rgba(255,255,255,0.65) 50%, transparent 50%),
            radial-gradient(1px 1px at 72% 48%, rgba(255,255,255,0.5) 50%, transparent 50%);
          animation: starTwinkle 4s ease-in-out infinite alternate;
        }
        .atmosphere--clear.atmosphere--night .atmosphere-bg__effects::before,
        .atmosphere--partly.atmosphere--night .atmosphere-bg__effects::before {
          content: "";
          position: absolute;
          top: 10%;
          right: 18%;
          width: 48px;
          height: 48px;
          border-radius: 50%;
          background: radial-gradient(circle, rgba(236, 239, 241, 0.85) 0%, rgba(236, 239, 241, 0.2) 45%, transparent 70%);
          box-shadow: 0 0 24px rgba(236, 239, 241, 0.25);
        }
        /* Storm lightning handled on canvas; keep effects layer for subtle cloud glow only */
        .atmosphere--storm .atmosphere-bg__effects {
          opacity: 0;
          background: radial-gradient(ellipse 80% 50% at 50% 0%, rgba(120, 140, 180, 0.12) 0%, transparent 70%);
          animation: stormCloudGlow 8s ease-in-out infinite alternate;
        }
        /* Fog wisps */
        .atmosphere--fog .atmosphere-bg__effects {
          opacity: 1;
          background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.08) 30%, rgba(255,255,255,0.14) 50%, rgba(255,255,255,0.08) 70%, transparent 100%);
          background-size: 200% 100%;
          animation: fogRoll 14s ease-in-out infinite;
        }
        .atmosphere-bg__veil {
          position: absolute;
          inset: 0;
          background:
            radial-gradient(ellipse at 28% 18%, rgba(255, 255, 255, 0.1) 0%, transparent 55%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.05) 0%, rgba(0, 0, 0, 0.35) 100%);
          opacity: var(--atmosphere-cloud, 0.45);
          animation: cloudVeilPulse 6s ease-in-out infinite;
        }
        .atmosphere-content {
          position: relative;
          z-index: 1;
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
          padding: var(--space-5);
          min-height: inherit;
        }
        .atmosphere-eyebrow {
          font-size: var(--fs-eyebrow);
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.65);
          text-align: center;
          width: 100%;
        }
        .atmosphere-hero {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--space-4);
          min-width: 0;
          width: 100%;
        }
        .atmosphere-hero-main {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: var(--space-4);
          width: 100%;
          max-width: 520px;
          margin: 0 auto;
        }
        .atmosphere-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          width: 100%;
        }
        .atmosphere-icon img.weather-icon {
          width: clamp(120px, 34vw, 168px);
          height: clamp(96px, 27vw, 136px);
          object-fit: contain;
          filter: drop-shadow(0 8px 28px rgba(0, 0, 0, 0.5));
        }
        .atmosphere-headline {
          min-width: 0;
          text-align: center;
          width: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
        }
        .atmosphere-temp-row { display: flex; align-items: flex-start; justify-content: center; gap: var(--space-2); }
        .atmosphere-temp {
          font-size: var(--fs-hero);
          font-weight: 700;
          line-height: var(--lh-tight);
          letter-spacing: -0.06em;
          font-variant-numeric: tabular-nums;
          color: #ffffff;
          text-shadow: 0 2px 16px rgba(0, 0, 0, 0.35);
        }
        .atmosphere-unit {
          font-size: clamp(24px, 6vw, 36px);
          font-weight: 700;
          color: var(--panel-accent-hover);
          line-height: 1;
        }
        .atmosphere-condition {
          font-size: var(--fs-display);
          font-weight: 600;
          color: #ffffff;
          line-height: var(--lh-snug);
          text-shadow: 0 1px 8px rgba(0, 0, 0, 0.3);
        }
        .atmosphere-datetime {
          font-size: var(--fs-small);
          color: rgba(255, 255, 255, 0.72);
          margin-top: var(--space-1);
        }
        .atmosphere-hilo { width: 100%; max-width: none; align-self: stretch; }
        .atmosphere-hilo-labels {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          gap: var(--space-2);
          margin-bottom: var(--space-2);
          font-variant-numeric: tabular-nums;
        }
        .atmosphere-hilo-lo, .atmosphere-hilo-hi {
          font-size: var(--fs-body);
          font-weight: 600;
          color: rgba(255, 255, 255, 0.9);
        }
        .atmosphere-hilo-title {
          font-size: var(--fs-xs);
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.55);
        }
        .atmosphere-hilo-track {
          position: relative;
          height: 6px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.12);
          overflow: visible;
        }
        .atmosphere-hilo-fill {
          position: absolute;
          inset: 0;
          border-radius: inherit;
          background: linear-gradient(90deg, var(--hw-accent), var(--hw-warning));
        }
        .atmosphere-hilo-marker {
          position: absolute;
          top: 50%;
          width: 14px;
          height: 14px;
          margin-left: -7px;
          border-radius: 50%;
          background: #ffffff;
          border: 2px solid var(--hw-accent);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
          transform: translateY(-50%);
          transition: left var(--dur-med) var(--ease);
        }
        .atmosphere-metrics {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: var(--space-2);
          margin-top: auto;
        }
        @media (min-width: 768px) {
          .atmosphere-metrics { grid-template-columns: repeat(3, 1fr); }
        }
        @media (min-width: 1100px) {
          .atmosphere-metrics { grid-template-columns: repeat(6, 1fr); }
        }
        .metric-glass {
          background: rgba(18, 18, 18, 0.52);
          backdrop-filter: blur(14px) saturate(150%);
          -webkit-backdrop-filter: blur(14px) saturate(150%);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: var(--radius-md);
          padding: var(--space-3);
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-height: 92px;
          min-width: 0;
          transition: transform var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
        }
        @media (prefers-reduced-motion: no-preference) {
          .dashboard:not(.dashboard--settled) .metric-glass {
            animation: metricIn var(--dur-slow) var(--ease) both;
            animation-delay: calc(var(--metric-i, 0) * 0.06s);
          }
          .dashboard:not(.dashboard--settled) .metric-uv-fill {
            animation: uvFill 1.2s var(--ease) both;
            animation-delay: calc(var(--metric-i, 0) * 0.06s + 0.2s);
          }
        }
        .metric-glass:hover {
          transform: translateY(-2px);
          border-color: rgba(255, 255, 255, 0.2);
        }
        .metric-head {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          min-width: 0;
        }
        .metric-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          color: var(--hw-accent-hover);
          flex-shrink: 0;
        }
        .metric-icon svg { width: 16px; height: 16px; }
        .metric-wind-arrow { transform-origin: center; animation: windPulse 2.4s ease-in-out infinite; }
        .metric-label {
          font-size: var(--fs-eyebrow);
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: rgba(255, 255, 255, 0.55);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .metric-value {
          font-size: clamp(18px, 3.5vw, 22px);
          font-weight: 700;
          letter-spacing: -0.03em;
          font-variant-numeric: tabular-nums;
          color: #ffffff;
          line-height: 1.2;
        }
        .metric-sub {
          font-size: var(--fs-xs);
          color: rgba(255, 255, 255, 0.6);
          line-height: 1.3;
          margin-top: 2px;
        }
        .metric-uv-bar {
          margin-top: var(--space-2);
          height: 4px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.12);
          overflow: hidden;
        }
        .metric-uv-fill {
          display: block;
          height: 100%;
          border-radius: inherit;
          background: linear-gradient(90deg, #4caf50, #ffeb3b, #ff9800, #f44336);
        }
        .atmosphere-card.skeleton-card .atmosphere-bg__gradient {
          background: linear-gradient(160deg, #1c1c1c 0%, #282828 100%);
          animation: none;
        }
        .atmosphere-card.skeleton-card .atmosphere-bg__veil { opacity: 0.2; animation: none; }

        /* Hourly snap strip */
        .hourly-card { display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
        .hourly-card .card-head { flex-shrink: 0; }
        .hourly-strip {
          display: flex;
          flex-direction: row;
          flex-wrap: nowrap;
          gap: var(--space-2);
          overflow-x: auto;
          overflow-y: hidden;
          margin-inline: calc(-1 * var(--space-4));
          padding: var(--space-2) var(--space-4) var(--space-3);
          scroll-padding-inline: var(--space-4);
          -webkit-overflow-scrolling: touch;
          scrollbar-width: none;
          -ms-overflow-style: none;
          min-width: 0;
          scroll-snap-type: x proximity;
        }
        .hourly-strip::-webkit-scrollbar { display: none; }

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

        /* Maps & Weather page */
        .maps-view {
          height: 100dvh;
          max-height: 100dvh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .maps-view .settings-body {
          flex: 1;
          min-height: 0;
          padding: 0;
          max-width: none;
          margin: 0;
          width: 100%;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .maps-page {
          display: flex;
          flex-direction: column;
          flex: 1;
          min-height: 0;
          width: 100%;
          height: 100%;
          overflow: hidden;
        }
        .maps-stage {
          position: relative;
          flex: 1;
          min-height: 0;
          width: 100%;
          overflow: hidden;
          z-index: 1;
          isolation: isolate;
        }
        .maps-view-panel,
        .maps-windy-view,
        .maps-trends-panel {
          display: none;
          width: 100%;
          height: 100%;
          min-height: 0;
          overflow: hidden;
        }
        .maps-view-panel.active,
        .maps-windy-view.active {
          display: flex;
          flex-direction: column;
          flex: 1;
          min-height: 0;
        }
        .maps-trends-panel.active {
          display: flex;
          flex-direction: column;
          flex: 1;
          min-height: 0;
          padding: var(--space-3);
          box-sizing: border-box;
          gap: var(--space-2);
        }
        .maps-trends-panel .maps-trends-title {
          font-size: var(--fs-h2);
          font-weight: 700;
          letter-spacing: -0.01em;
        }
        .maps-trends-panel .maps-trends-sub {
          font-size: var(--fs-xs);
          color: var(--muted);
          margin-top: 2px;
        }
        #hurricane-tracker-root {
          flex: 1;
          width: 100%;
          height: 100%;
          min-height: 0;
          position: relative;
          overflow: hidden;
          z-index: 1;
        }
        .space-map-page {
          display: flex;
          flex-direction: column;
          flex: 1;
          min-height: 0;
          width: 100%;
          height: 100%;
          position: relative;
          overflow: hidden;
        }
        .space-canvas-wrap {
          flex: 1;
          min-height: 0;
          width: 100%;
          position: relative;
          background: #000000;
        }
        .space-canvas-wrap canvas {
          display: block;
          width: 100% !important;
          height: 100% !important;
          cursor: grab;
        }
        .space-canvas-wrap canvas:active {
          cursor: grabbing;
        }
        .space-map-hint {
          position: absolute;
          left: var(--space-3);
          bottom: var(--space-3);
          z-index: 2;
          pointer-events: none;
          font-size: var(--fs-xs);
          color: var(--hw-muted);
          background: rgba(0, 0, 0, 0.55);
          border: 1px solid var(--hw-border);
          border-radius: var(--radius-sm);
          padding: 6px 10px;
          max-width: min(320px, 90%);
          line-height: 1.35;
        }
        .space-loading, .space-error, .space-sun-loading, .space-empty-banner {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: var(--space-2);
          padding: var(--space-4);
          text-align: center;
          color: var(--hw-muted);
          font-size: var(--fs-body);
          pointer-events: none;
          z-index: 1;
        }
        .space-error-detail {
          font-size: var(--fs-xs);
          color: var(--hw-muted);
          max-width: 420px;
          line-height: 1.4;
        }
        .space-controls {
          position: absolute;
          right: var(--space-3);
          bottom: var(--space-3);
          display: flex;
          gap: var(--space-2);
          z-index: 2;
        }
        .space-ctrl-btn {
          min-width: 40px;
          min-height: 40px;
          border-radius: 999px;
          border: 1px solid var(--hw-border);
          background: var(--hw-elevated);
          color: var(--hw-text);
          cursor: pointer;
        }
        .space-info-card {
          position: absolute;
          left: var(--space-3);
          bottom: var(--space-3);
          min-width: 180px;
          max-width: 260px;
          padding: var(--space-3);
          border-radius: var(--radius-md);
          border: 1px solid var(--hw-border);
          background: color-mix(in srgb, var(--hw-surface) 92%, transparent);
          backdrop-filter: blur(8px);
          z-index: 2;
        }
        .space-info-title { font-weight: 700; margin-bottom: 2px; }
        .space-info-type { font-size: var(--fs-xs); color: var(--hw-muted); margin-bottom: var(--space-2); text-transform: capitalize; }
        .space-info-row { display: flex; justify-content: space-between; gap: var(--space-2); font-size: var(--fs-xs); padding: 2px 0; }
        .space-sun-layout {
          display: flex;
          flex-direction: row;
          align-items: stretch;
          gap: var(--space-3);
          flex: 1;
          min-height: 0;
          padding: var(--space-3);
          box-sizing: border-box;
        }
        .space-sun-visual {
          flex: 1.2;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          min-height: 0;
          overflow: auto;
        }
        .space-sun-disk-wrap {
          border-radius: var(--radius-md);
          overflow: hidden;
          border: 1px solid var(--hw-border);
          background: #000;
        }
        .space-sun-disk, .space-sun-xray {
          width: 100%;
          height: auto;
          display: block;
        }
        .space-sun-sidebar {
          flex: 0.8;
          min-width: 240px;
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          min-height: 0;
          overflow: auto;
        }
        @media (max-width: 768px) {
          .space-sun-layout { flex-direction: column; }
          .space-sun-sidebar { min-width: 0; }
        }
        .space-sun-title { font-size: var(--fs-h2); font-weight: 700; }
        .space-sun-stat {
          display: flex;
          justify-content: space-between;
          gap: var(--space-2);
          padding: var(--space-2) 0;
          border-bottom: 1px solid var(--hw-border);
          font-size: var(--fs-body);
        }
        .space-sun-subtitle { font-size: var(--fs-xs); color: var(--hw-muted); margin-top: var(--space-2); }
        .space-sun-region { font-size: var(--fs-xs); padding: 4px 0; }
        .space-sun-muted { font-size: var(--fs-xs); color: var(--hw-muted); }
        .space-sun-attribution { margin-top: auto; font-size: var(--fs-eyebrow); color: var(--hw-muted); }
        #zone-editor-root {
          flex: 1;
          width: 100%;
          height: 100%;
          min-height: 0;
          position: relative;
          overflow: hidden;
          z-index: 1;
        }
        #space-map-root {
          flex: 1;
          width: 100%;
          height: 100%;
          min-height: 0;
          position: relative;
          overflow: hidden;
          z-index: 1;
        }
        .maps-windy-frame {
          width: 100%;
          height: 100%;
          min-height: 0;
          border-radius: 0;
          overflow: hidden;
          border: none;
          background: var(--secondary-background-color);
        }
        .maps-windy-frame iframe {
          width: 100%;
          height: 100%;
          border: none;
          display: block;
        }
        .maps-windy-loading {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: var(--hw-muted, #9b9b9b);
          font-size: 14px;
        }
        .maps-chart-container {
          flex: 1;
          min-height: 0;
          width: 100%;
        }
        @media (max-width: 768px) {
          .maps-view {
            height: 100dvh;
            max-height: 100dvh;
          }
        }

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
          .dashboard:not(.dashboard--settled) > * { animation: cardIn var(--dur-slow) var(--ease) both; }
          .dashboard:not(.dashboard--settled) > *:nth-child(1) { animation-delay: 0s; }
          .dashboard:not(.dashboard--settled) > *:nth-child(2) { animation-delay: 0.05s; }
          .dashboard:not(.dashboard--settled) > *:nth-child(3) { animation-delay: 0.1s; }
          .dashboard:not(.dashboard--settled) > *:nth-child(4) { animation-delay: 0.15s; }
          .dashboard:not(.dashboard--settled) > *:nth-child(5) { animation-delay: 0.2s; }
          .radar-view.active { animation: fadeSlideIn var(--dur-med) var(--ease); }
          .detail-backdrop { transition: opacity var(--dur-med) var(--ease); }
          .detail-sheet { transition: transform var(--dur-med) var(--ease); }
        }
        @keyframes cardIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes fadeSlideIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes atmosphereDrift {
          0% { background-position: 0% 30%; transform: scale(1); }
          100% { background-position: 100% 70%; transform: scale(1.04); }
        }
        @keyframes cloudDriftA {
          0% { transform: translateX(0) translateY(0) scale(1); }
          100% { transform: translateX(18%) translateY(8px) scale(1.08); }
        }
        @keyframes cloudDriftB {
          0% { transform: translateX(0) translateY(0) scale(1); }
          100% { transform: translateX(-16%) translateY(-6px) scale(1.06); }
        }
        @keyframes cloudBreathe {
          0%, 100% { opacity: 0.75; filter: blur(28px); }
          50% { opacity: 1; filter: blur(34px); }
        }
        @keyframes snowDrift {
          0% { transform: translateY(0); opacity: 0.85; }
          100% { transform: translateY(28px); opacity: 1; }
        }
        @keyframes sunPulse {
          0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: 0.9; }
          50% { transform: translate(-50%, -50%) scale(1.08); opacity: 1; }
        }
        @keyframes starTwinkle {
          0% { opacity: 0.7; }
          100% { opacity: 1; }
        }
        @keyframes stormCloudGlow {
          0% { opacity: 0.35; }
          100% { opacity: 0.7; }
        }
        @keyframes fogRoll {
          0% { background-position: 0% 0; }
          100% { background-position: 100% 0; }
        }
        @keyframes cloudVeilPulse {
          0%, 100% { opacity: calc(var(--atmosphere-cloud, 0.45) * 0.75); }
          50% { opacity: calc(var(--atmosphere-cloud, 0.45) * 1.15); }
        }
        @keyframes metricIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes uvFill {
          from { width: 0; }
        }
        @keyframes windPulse {
          0%, 100% { transform: translateX(0); opacity: 0.85; }
          50% { transform: translateX(2px); opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .atmosphere-bg__gradient { animation: none; transform: none; }
          .atmosphere-bg__veil { animation: none; }
          .atmosphere-bg__clouds::before,
          .atmosphere-bg__clouds::after,
          .atmosphere-bg__particles,
          .atmosphere-bg__effects,
          .atmosphere-bg__effects::before,
          .atmosphere-bg__particles::before { animation: none; }
          .atmosphere--storm .atmosphere-bg__effects { animation: none; opacity: 0.4; }
          .metric-glass { animation: none; opacity: 1; transform: none; }
          .metric-glass:hover { transform: none; }
          .metric-uv-fill { animation: none; }
          .metric-wind-arrow { animation: none; }
        }
        .settings-view {
          display: flex;
          flex-direction: column;
          min-height: 100%;
          max-width: none;
          margin: 0;
          padding: 0;
          width: 100%;
          box-sizing: border-box;
        }
        .settings-body {
          flex: 1;
          padding: clamp(12px, 2vw, 18px);
          max-width: 1800px;
          margin: 0 auto;
          width: 100%;
          box-sizing: border-box;
        }
        .hamburger { display: none; padding: 8px; background: transparent; border: none; cursor: pointer; color: var(--primary-text-color); border-radius: 8px; }
        .hamburger:hover { background: var(--secondary-background-color); }
        .hamburger svg { width: 24px; height: 24px; display: block; }
        @media (max-width: 768px) { .hamburger { display: block; } }
        .narrow .hamburger { display: block; }
        .topbar .hamburger.icon-btn { display: none; }
        @media (max-width: 768px) { .topbar .hamburger.icon-btn { display: inline-flex; } }
        .narrow .topbar .hamburger.icon-btn { display: inline-flex; }
        /* Settings design tokens */
        .settings-form {
          --form-gap: 16px;
          --form-gap-sm: 12px;
          --form-gap-lg: 20px;
          --form-label-size: 13px;
          --form-label-weight: 500;
          --form-hint-size: 12px;
          --form-input-height: 40px;
          --section-padding: 18px;
          display: grid;
          gap: var(--form-gap-lg);
          max-width: min(1200px, 100%);
          margin: 0 auto;
          width: 100%;
          padding-bottom: 88px;
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
        .alert-body { font-size: 15px; color: var(--primary-text-color); line-height: 1.55; margin: 0; overflow-wrap: anywhere; word-break: break-word; }
        .alert-details { display: none; flex-direction: column; gap: 10px; }
        .alert-card.expanded .alert-details { display: flex; }
        .alert-detail-section {
          width: 100%;
          background: var(--secondary-background-color);
          border: 1px solid var(--card-border);
          border-radius: var(--radius-sm);
          padding: 12px 14px;
        }
        .alert-detail-label { font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--secondary-text-color); margin-bottom: 6px; }
        .alert-detail-value { font-size: 13px; color: var(--primary-text-color); line-height: 1.55; margin: 0; font-variant-numeric: tabular-nums; }
        .alert-detail-section--text .alert-detail-value { color: var(--secondary-text-color); }
        .alert-footer {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px 18px;
          margin: 0;
          padding-top: 10px;
          border-top: 1px solid var(--card-border);
        }
        .alert-pill { font-size: 10px; font-weight: 700; letter-spacing: 0.12em; padding: 3px 10px; border-radius: 999px; background: var(--secondary-background-color); color: var(--secondary-text-color); }
        .alert-card.sev-warning .alert-pill { background: rgba(244,67,54,0.15); color: #ff8a80; }
        .alert-card.sev-watch .alert-pill { background: rgba(255,152,0,0.15); color: #ffb74d; }
        .alert-card.sev-advisory .alert-pill { background: var(--panel-accent-dim); color: var(--panel-accent-hover); }

        .settings-group { display: flex; flex-direction: column; gap: 12px; }
        .settings-group-title { font-size: 11px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: var(--secondary-text-color); }
        .settings-group-sub { font-size: 13px; color: var(--secondary-text-color); margin-bottom: 4px; max-width: 70ch; line-height: 1.5; }
        .settings-category.collapsible-section { border-radius: var(--radius-lg); }
        .settings-category.collapsible-section.open { border-color: var(--hw-border-strong); box-shadow: var(--shadow-sm); }
        .settings-category > .collapsible-header { padding: 16px 20px; }
        .settings-category > .collapsible-header .collapsible-title { font-size: 16px; }
        .settings-category-hint {
          font-size: 13px;
          color: var(--secondary-text-color);
          line-height: 1.5;
          margin: 0 0 4px;
          max-width: 72ch;
        }
        .collapsible-content--category { gap: 12px; padding-top: 4px; }
        .settings-panel {
          display: flex;
          flex-direction: column;
          gap: 0;
          min-width: 0;
          background: var(--hw-elevated);
          border: 1px solid var(--hw-border);
          border-radius: var(--radius-md);
          overflow: hidden;
        }
        .settings-panel .collapsible-section {
          background: transparent;
          border: none;
          border-radius: 0;
          border-bottom: 1px solid var(--hw-border);
        }
        .settings-panel .collapsible-section:last-child { border-bottom: none; }
        .settings-panel--player { background: transparent; border: none; }
        .settings-panel--player > .collapsible-section {
          background: var(--hw-elevated);
          border: 1px solid var(--hw-border);
          border-radius: var(--radius-md);
        }
        .media-player-list { display: flex; flex-direction: column; gap: 10px; }
        .collapsible-section--mini > .collapsible-header { padding: 12px 14px; }
        .collapsible-section--mini > .collapsible-header .collapsible-title { font-size: 13px; font-weight: 600; letter-spacing: 0.04em; }
        .collapsible-section--mini > .collapsible-content { padding: 0 14px 14px; gap: var(--form-gap-sm); }
        .settings-nest {
          margin-left: 0;
          padding-left: 0;
          border-left: none;
          display: flex;
          flex-direction: column;
          gap: 10px;
          min-width: 0;
        }
        @media (max-width: 480px) {
          .settings-nest { margin-left: 0; padding-left: 12px; }
        }
        .settings-nest .collapsible-section { background: var(--hw-elevated); }
        .settings-field-block {
          display: flex;
          flex-direction: column;
          gap: var(--form-gap-sm);
          padding: 14px 16px;
          background: var(--hw-inset-bg, var(--hw-surface-2));
          border: 1px solid var(--hw-border);
          border-radius: var(--radius-sm);
        }
        .settings-field-block-title {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--secondary-text-color);
          margin-bottom: 2px;
        }
        .settings-field-block--optional .settings-field-block-title { color: var(--hw-muted); }
        .optional-tag {
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--hw-muted);
          margin-left: 6px;
        }
        .media-player-card {
          padding: 0;
          background: transparent;
          border: none;
          border-radius: 0;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .media-player-list .settings-panel--player { margin: 0; }
        .media-player-playback-block { display: flex; flex-direction: column; gap: var(--form-gap-sm); margin-bottom: var(--form-gap); }
        .media-player-playback-block > .form-group { margin-bottom: 0; }
        .playback-options-row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: var(--form-gap-sm) var(--form-gap);
        }
        .playback-options-row .form-group { margin-bottom: 0; flex: 0 1 148px; min-width: 120px; max-width: 180px; }
        .playback-options-row .settings-toggle-row { margin-bottom: 0; }
        .media-player-actions { display: flex; justify-content: flex-end; padding-top: 4px; }
        .media-player-add-row { margin-top: 4px; }
        .media-player-add-row select { flex: 1; min-width: 0; }
        .settings-form-footer {
          position: sticky;
          bottom: 0;
          z-index: 10;
          display: flex;
          gap: 12px;
          justify-content: flex-end;
          margin-top: 8px;
          padding: 16px 0 calc(16px + var(--safe-bottom));
          background: var(--hw-surface);
          border-top: 1px solid var(--hw-border-strong);
        }
        .settings-save-status {
          margin-right: auto;
          align-self: center;
          display: inline-flex;
          align-items: center;
          gap: 7px;
          font-size: 12.5px;
          font-weight: 500;
          color: var(--hw-muted);
          min-height: 20px;
          transition: color var(--dur-fast) var(--ease);
        }
        .settings-save-status::before {
          content: "";
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--hw-muted);
          flex-shrink: 0;
          transition: background var(--dur-fast) var(--ease);
        }
        .settings-save-status[data-state="saving"] { color: var(--hw-accent-hover); }
        .settings-save-status[data-state="saving"]::before { background: var(--hw-accent); animation: hwSavePulse 1s var(--ease) infinite; }
        .settings-save-status[data-state="saved"] { color: var(--hw-success); }
        .settings-save-status[data-state="saved"]::before { background: var(--hw-success); }
        .settings-save-status[data-state="error"] { color: var(--hw-danger); }
        .settings-save-status[data-state="error"]::before { background: var(--hw-danger); }
        @keyframes hwSavePulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        @media (max-width: 560px) {
          .settings-save-status { width: 100%; margin-right: 0; order: -1; }
        }
        .settings-toast {
          position: fixed;
          left: 50%;
          bottom: calc(88px + var(--safe-bottom));
          z-index: 30;
          transform: translateX(-50%) translateY(12px);
          max-width: min(420px, calc(100vw - 32px));
          padding: 12px 18px;
          border-radius: 10px;
          background: var(--hw-elevated);
          color: var(--hw-text);
          border: 1px solid var(--hw-border-strong);
          box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
          font-size: 14px;
          font-weight: 500;
          text-align: center;
          pointer-events: none;
          opacity: 0;
          animation: settingsToastIn 0.28s var(--ease) forwards;
        }
        .settings-toast--error { border-color: rgba(244, 67, 54, 0.45); color: var(--hw-danger); }
        @keyframes settingsToastIn {
          from { opacity: 0; transform: translateX(-50%) translateY(12px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        .form-actions-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: var(--form-gap-lg); padding-top: var(--form-gap); border-top: 1px solid var(--hw-border); }
        .btn-secondary-test { background: var(--secondary-background-color); color: var(--primary-text-color); border: 1px solid var(--input-border); }
        .btn-secondary-test:hover { background: var(--hw-hover); }
        code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; padding: 1px 5px; border-radius: 4px; background: var(--hw-code-bg); color: var(--panel-accent-hover); }
        .form-group { display: flex; flex-direction: column; gap: 5px; margin-bottom: var(--form-gap); }
        .form-group label { font-size: var(--form-label-size); font-weight: 500; color: var(--primary-text-color); letter-spacing: 0.01em; }
        .form-group input, .form-group select { padding: 10px 14px; height: var(--form-input-height); border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--primary-text-color); font-size: 14px; box-sizing: border-box; transition: border-color 0.15s ease; }
        .form-group input:focus, .form-group select:focus { outline: none; border-color: var(--panel-accent); }
        .form-group input[type="checkbox"] { width: auto; padding: 0; height: auto; }
        .form-group .form-hint { margin-top: 2px; margin-bottom: 0; }
        .form-row { display: flex; align-items: center; gap: var(--form-gap-sm); }
        .form-row-inline {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr));
          gap: var(--form-gap-sm);
          align-items: end;
          margin-bottom: var(--form-gap);
        }
        .form-row-inline .form-group { margin-bottom: 0; }
        .settings-toggle-row,
        .inline-toggle {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 12px;
          margin-bottom: 6px;
          justify-content: space-between;
          background: var(--hw-overlay-subtle);
          border-left: 3px solid var(--hw-overlay-border);
          border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
          max-width: min(400px, 100%);
          box-sizing: border-box;
          transition: background 0.15s ease, border-color 0.15s ease;
        }
        .settings-toggle-row:hover,
        .inline-toggle:hover {
          background: var(--hw-overlay-hover);
          border-left-color: var(--panel-accent);
        }
        .settings-toggle-row--wide,
        .inline-toggle--wide {
          max-width: min(520px, 100%);
        }
        .toggle-group { display: flex; flex-direction: column; gap: 2px; margin-bottom: var(--form-gap-sm); }
        .toggle-group .settings-toggle-row,
        .toggle-group .inline-toggle { margin-bottom: 0; }
        .settings-toggle-row .inline-toggle-label,
        .inline-toggle-label,
        .settings-toggle-row > label:first-of-type:not(.toggle-switch) {
          flex: 1;
          margin: 0;
          font-size: 13px;
          font-weight: 450;
          color: var(--primary-text-color);
          line-height: 1.4;
        }
        .settings-toggle-row .toggle-switch,
        .inline-toggle .toggle-switch { flex-shrink: 0; margin-left: auto; }
        .days-of-week-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--form-gap-sm); margin-bottom: var(--form-gap); }
        .day-toggle-row {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 12px;
          background: var(--secondary-background-color);
          border-radius: 8px;
          min-width: 0;
        }
        .day-toggle-row .day-label {
          flex: 0 1 auto;
          font-size: var(--form-label-size);
          font-weight: var(--form-label-weight);
          color: var(--primary-text-color);
        }
        .day-toggle-row .toggle-switch { flex-shrink: 0; margin-left: auto; }
        @media (max-width: 480px) { .days-of-week-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        .form-row .btn-icon { padding: 8px 12px; min-width: auto; }
        .media-player-item { display: flex; align-items: center; gap: 12px; padding: 12px 16px; background: var(--card-background-color); border: 1px solid var(--card-border); border-radius: 8px; }
        .media-player-item select { flex: 1; }
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
        .collapsible-section.open { border-color: var(--hw-overlay-border-strong); }
        .collapsible-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; cursor: pointer; user-select: none; transition: background 0.2s; gap: 12px; }
        .collapsible-header:hover { background: var(--secondary-background-color); }
        .collapsible-header-left { display: flex; align-items: center; gap: 14px; flex: 1; min-width: 0; }
        .collapsible-header-left > div:last-child { min-width: 0; }
        .collapsible-title { font-size: 15px; font-weight: 600; color: var(--primary-text-color); }
        .collapsible-subtitle { font-size: 12px; color: var(--secondary-text-color); margin-top: 2px; }
        .collapsible-chevron { width: 20px; height: 20px; color: var(--secondary-text-color); transition: transform 0.2s; flex-shrink: 0; pointer-events: none; }
        .collapsible-toggle {
          flex-shrink: 0;
          width: 36px;
          height: 36px;
          min-width: 36px;
          border: 1px solid var(--card-border);
          background: var(--secondary-background-color);
          border-radius: var(--radius-sm);
          color: var(--secondary-text-color);
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          transition: background 0.2s, border-color 0.2s, transform 0.2s;
        }
        .collapsible-toggle:hover { background: var(--card-border); color: var(--primary-text-color); }
        .collapsible-section.open > .collapsible-header .collapsible-chevron { transform: rotate(180deg); }
        .collapsible-content { padding: var(--section-padding); display: none; flex-direction: column; gap: var(--form-gap); }
        .collapsible-header + .collapsible-content { border-top: 1px solid var(--card-border); }
        .collapsible-section.open > .collapsible-content { display: flex; }
        .subsection-block { display: flex; flex-direction: column; gap: var(--form-gap-sm); padding-top: var(--form-gap); margin-top: var(--form-gap-sm); border-top: 1px solid var(--hw-divider-soft); }
        .subsection-block:first-child { padding-top: 0; margin-top: 0; border-top: none; }
        .subsection-title { font-size: 11px; font-weight: 600; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; padding-top: var(--form-gap); border-top: 1px solid var(--hw-divider-soft); }
        .subsection-block .subsection-title:first-child { padding-top: 0; border-top: none; }
        .subsection-block + .subsection-title { margin-top: var(--form-gap); }
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
        .multi-select-item:hover { background: var(--hw-hover); }
        .multi-select-item.selected { background: var(--accent-color); color: white; }
        .multi-select-item input { display: none; }
        .textarea-field { width: 100%; min-height: 100px; padding: 12px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--primary-text-color); font-size: 14px; font-family: inherit; resize: vertical; }
        .settings-section-divider { border: none; border-top: 1px solid var(--card-border); margin: 20px 0; }
        .form-hint { font-size: 11.5px; color: var(--secondary-text-color); margin: 0 0 var(--form-gap-sm); line-height: 1.5; opacity: 0.85; }
        .settings-form .collapsible-content > .form-group:last-child,
        .settings-form .collapsible-content > .inline-toggle:last-child,
        .settings-form .collapsible-content > .settings-toggle-row:last-child,
        .settings-form .collapsible-content > .media-player-playback-block:last-child { margin-bottom: 0; }
        .settings-form .range-slider { max-width: min(440px, 100%); }
        /* Consistent, tidy control widths so fields don't stretch the whole card */
        .settings-form .form-group > input,
        .settings-form .form-group > select,
        .settings-form .form-group > .entity-autocomplete-wrapper,
        .settings-form .form-group > .hw-entity-select,
        .settings-form .textarea-field { width: 100%; }
        .settings-form .form-group > input[type="number"],
        .settings-form .form-group > input[type="time"] { max-width: 150px; }
        .settings-form .form-group > select { max-width: 320px; }
        .settings-form .form-group > input[type="text"],
        .settings-form .form-group > .entity-autocomplete-wrapper,
        .settings-form .form-group > .hw-entity-select { max-width: 520px; }
        .settings-form .textarea-field { max-width: 640px; }
        .settings-form .time-input-group input[type="time"] { flex: 0 0 auto; width: 150px; }
        /* Two-up rows: keep paired fields compact and left-aligned instead of full-bleed */
        .settings-form .form-row-inline {
          grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 320px));
          justify-content: start;
          max-width: 680px;
        }
        .settings-form .form-row-inline .form-group > select { max-width: 100%; }
        .settings-form .form-row-inline .form-group > .range-slider { max-width: 100%; }
        /* Match autocomplete input height to other controls */
        .settings-form .entity-autocomplete-input { height: var(--form-input-height); padding: 10px 14px; box-sizing: border-box; }
        .webhook-status-row { display: flex; align-items: center; gap: 10px; }
        .webhook-status-dot { width: 14px; height: 14px; border-radius: 50%; flex-shrink: 0; }
        .webhook-status-dot.idle { background: var(--panel-danger); }
        .webhook-status-dot.triggered { background: var(--panel-success); }
        .webhook-status-label { font-size: 13px; font-weight: 500; color: var(--primary-text-color); }
        .webhook-timestamp { font-size: 12px; color: var(--secondary-text-color); margin-left: auto; }
        .webhook-url-display { flex: 1; font-size: 12px; padding: 8px 12px; background: var(--secondary-background-color); border-radius: 6px; color: var(--primary-text-color); cursor: text; }
        .form-actions { display: flex; gap: 12px; justify-content: flex-end; margin-top: 24px; }
        .btn { padding: 12px 32px; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; box-sizing: border-box; }
        .topbar #alerts-btn { width: auto; min-width: 52px; padding-left: 12px; padding-right: 14px; gap: 6px; position: relative; }
        .alerts-badge {
          position: absolute;
          top: 4px;
          right: 4px;
          min-width: 18px;
          height: 18px;
          padding: 0 5px;
          border-radius: 999px;
          background: var(--panel-danger);
          color: #fff;
          font-size: 10px;
          font-weight: 700;
          line-height: 18px;
          text-align: center;
          font-variant-numeric: tabular-nums;
          box-shadow: 0 0 0 2px var(--hw-surface);
          pointer-events: none;
        }
        .btn-primary { background: var(--panel-accent); color: #ffffff; box-shadow: 0 2px 8px var(--panel-accent-dim); }
        .btn-primary:hover { background: var(--panel-accent-hover); }
        .btn-secondary { background: var(--input-bg); color: var(--primary-text-color); border: 1px solid var(--input-border); }
        .btn-secondary:hover { background: var(--hw-hover); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        /* Entity Autocomplete */
        .entity-autocomplete-wrapper { position: relative; width: 100%; }
        .entity-autocomplete-input { width: 100%; padding: 12px 16px; border: 1px solid var(--input-border); border-radius: 8px; background: var(--input-bg); color: var(--primary-text-color); font-size: 14px; }
        .entity-autocomplete-input:focus { outline: none; border-color: var(--panel-accent); box-shadow: 0 0 0 2px var(--panel-accent-dim); }
        .entity-autocomplete-input::placeholder { color: var(--secondary-text-color); opacity: 0.7; }

        /* Weather entity picker (read-only dropdown, two-line options) */
        .hw-entity-select {
          position: relative;
          width: 100%;
          max-width: 520px;
        }
        .hw-entity-select-trigger {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          width: 100%;
          min-height: var(--form-input-height, 44px);
          padding: 8px 12px 8px 14px;
          border: 1px solid var(--input-border);
          border-radius: 8px;
          background: var(--input-bg);
          color: var(--primary-text-color);
          font-family: inherit;
          text-align: left;
          cursor: pointer;
          box-sizing: border-box;
          transition: border-color 0.12s ease, box-shadow 0.12s ease;
        }
        .hw-entity-select-trigger:hover { border-color: var(--hw-border-strong, var(--input-border)); }
        .hw-entity-select.open > .hw-entity-select-trigger,
        .hw-entity-select-trigger:focus-visible {
          outline: none;
          border-color: var(--panel-accent);
          box-shadow: 0 0 0 2px var(--panel-accent-dim);
        }
        .hw-entity-select-label {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
          flex: 1;
        }
        .hw-entity-select-title {
          font-size: 14px;
          font-weight: 500;
          line-height: 1.25;
          color: var(--primary-text-color);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .hw-entity-select-sub {
          font-size: 11px;
          line-height: 1.25;
          color: var(--secondary-text-color);
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .hw-entity-select-trigger.is-placeholder .hw-entity-select-title {
          color: var(--secondary-text-color);
          font-weight: 400;
        }
        .hw-entity-select-trigger.is-placeholder .hw-entity-select-sub { display: none; }
        .hw-entity-select-chevron {
          width: 18px;
          height: 18px;
          flex-shrink: 0;
          color: var(--secondary-text-color);
          transition: transform 0.15s ease;
        }
        .hw-entity-select.open .hw-entity-select-chevron { transform: rotate(180deg); }
        .hw-entity-select-dropdown {
          display: none;
          position: fixed;
          z-index: 9999;
          max-height: min(320px, 50vh);
          overflow-y: auto;
          padding: 6px;
          border: 1px solid var(--hw-border-strong, var(--input-border));
          border-radius: 10px;
          background: rgba(24, 24, 24, 0.98);
          box-shadow: 0 16px 44px rgba(0, 0, 0, 0.55);
        }
        .hw-entity-select.open > .hw-entity-select-dropdown { display: block; }
        .hw-entity-select-option {
          display: flex;
          flex-direction: column;
          gap: 2px;
          width: 100%;
          padding: 10px 12px;
          border: none;
          border-radius: 8px;
          background: transparent;
          color: var(--primary-text-color);
          font-family: inherit;
          text-align: left;
          cursor: pointer;
          box-sizing: border-box;
        }
        .hw-entity-select-option:hover,
        .hw-entity-select-option:focus-visible {
          outline: none;
          background: var(--hw-hover, rgba(255, 255, 255, 0.06));
        }
        .hw-entity-select-option[aria-selected="true"] {
          background: var(--panel-accent-dim);
        }
        .hw-entity-select-empty {
          padding: 12px 14px;
          font-size: 13px;
          color: var(--secondary-text-color);
        }

        /* ============ Desktop-app menubar (single row, menu items only) ============ */
        .hw-menubar {
          position: sticky;
          top: 0;
          z-index: 200;
          display: flex;
          align-items: stretch;
          flex-shrink: 0;
          height: var(--hw-menubar-height);
          min-height: var(--hw-menubar-height);
          padding: 0 clamp(6px, 1vw, 12px);
          box-sizing: border-box;
          background: var(--hw-surface);
          border-bottom: 1px solid var(--hw-border-strong);
          user-select: none;
        }
        .hw-menubar-menus {
          display: flex;
          align-items: stretch;
          flex: 1;
          min-width: 0;
          gap: 0;
        }
        .hw-menubar-end {
          display: flex;
          align-items: center;
          flex-shrink: 0;
          margin-left: auto;
        }
        .hw-menu-sep {
          width: 1px;
          align-self: center;
          height: 16px;
          margin: 0 6px;
          background: var(--hw-border-strong);
          flex-shrink: 0;
        }
        .hw-menubar .hw-menu { position: relative; display: flex; align-items: stretch; }
        @media (max-width: 768px) {
          /* Keep the bar the same height as HA's header on every page. */
          .hw-menubar-menus { display: none; }
        }
        .narrow .hw-menubar-menus { display: none; }
        .hw-menu-trigger {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          height: 100%;
          padding: 0 10px;
          border: none;
          background: transparent;
          color: var(--hw-text);
          font-size: 12px;
          font-weight: 500;
          font-family: inherit;
          cursor: pointer;
          border-radius: 4px;
          transition: background 0.12s ease;
          white-space: nowrap;
        }
        .hw-menu-trigger:hover { background: var(--hw-hover); }
        .hw-menu-trigger:focus-visible { outline: 2px solid var(--hw-accent); outline-offset: -2px; }
        .hw-menu.open > .hw-menu-trigger { background: var(--hw-elevated); color: var(--hw-accent-hover); }
        .hw-menu-dropdown {
          display: none;
          position: absolute;
          top: calc(100% - 4px);
          left: 0;
          z-index: 210;
          min-width: 224px;
          padding: 6px;
          background: rgba(24, 24, 24, 0.98);
          border: 1px solid var(--hw-border-strong);
          border-radius: 10px;
          box-shadow: 0 16px 44px rgba(0, 0, 0, 0.55);
          backdrop-filter: blur(14px);
        }
        .hw-menu.open > .hw-menu-dropdown { display: flex; flex-direction: column; }
        .hw-menu-item {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 100%;
          padding: 8px 10px;
          border: none;
          border-radius: 6px;
          background: transparent;
          color: var(--hw-text);
          font-size: 13px;
          font-family: inherit;
          text-align: left;
          cursor: pointer;
          white-space: nowrap;
          transition: background 0.1s ease;
          box-sizing: border-box;
        }
        .hw-menu-item:hover { background: var(--hw-hover); }
        .hw-menu-item:focus-visible { outline: 2px solid var(--hw-accent); outline-offset: -2px; }
        .hw-menu-item[disabled] { opacity: 0.45; cursor: default; }
        .hw-menu-item .hw-menu-mark {
          width: 16px;
          height: 16px;
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          color: var(--hw-accent-hover);
          visibility: hidden;
        }
        .hw-menu-item[aria-checked="true"] .hw-menu-mark { visibility: visible; }
        .hw-menu-item .hw-menu-ico { width: 15px; height: 15px; flex-shrink: 0; opacity: 0.8; }
        .hw-menu-item .hw-menu-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .hw-menu-item .hw-menu-item-hint { font-size: 11px; color: var(--hw-muted); }
        .hw-menu-divider { height: 1px; margin: 5px 8px; background: var(--hw-border); border: none; }
        .hw-menu-group-label {
          padding: 7px 10px 3px;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--hw-muted);
        }
        .hw-menubar-mobile-trigger {
          display: none;
          align-items: center;
          gap: 6px;
          height: 32px;
          min-height: 32px;
          padding: 0 10px;
          border: none;
          background: transparent;
          border-radius: 4px;
          color: var(--hw-text);
          font-size: 12px;
          font-weight: 500;
          font-family: inherit;
          cursor: pointer;
        }
        .hw-menubar-mobile-trigger:hover { background: var(--hw-hover); }
        .hw-menubar-mobile-trigger:focus-visible { outline: 2px solid var(--hw-accent); outline-offset: -2px; }
        .hw-menubar-mobile-trigger svg { width: 16px; height: 16px; }
        @media (max-width: 768px) {
          .hw-menubar-mobile-trigger { display: inline-flex; }
        }
        .narrow .hw-menubar-mobile-trigger { display: inline-flex; }
        /* Back button in menubar */
        .hw-menubar-back {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          height: 100%;
          padding: 0 12px;
          background: none;
          border: none;
          color: var(--hw-text);
          font-size: 12px;
          font-weight: 500;
          font-family: inherit;
          cursor: pointer;
          white-space: nowrap;
          transition: background 0.12s ease;
        }
        .hw-menubar-back:hover { background: var(--hw-hover); }
        .hw-menubar-back:focus-visible { outline: 2px solid var(--hw-accent); outline-offset: -2px; }
        .hw-menubar-back svg { flex-shrink: 0; opacity: 0.8; }
        .hw-menubar-back + .hw-menubar-menus > .hw-menu:first-child { margin-left: 4px; }
        /* Back button stays visible on every breakpoint — it is the primary
           way back to the Dashboard on sub-pages. */
        .hw-menu-back-item { font-weight: 600; color: var(--hw-accent); }
        /* Mobile menu sheet */
        .hw-menusheet-backdrop {
          position: fixed;
          inset: 0;
          z-index: 900;
          background: var(--hw-scrim, rgba(0, 0, 0, 0.55));
          opacity: 0;
          visibility: hidden;
          transition: opacity 0.2s ease, visibility 0.2s;
        }
        .hw-menusheet-backdrop.open { opacity: 1; visibility: visible; }
        .hw-menusheet {
          position: fixed;
          top: 0;
          right: 0;
          bottom: 0;
          z-index: 910;
          width: min(320px, 88vw);
          display: flex;
          flex-direction: column;
          background: var(--hw-surface);
          border-left: 1px solid var(--hw-border-strong);
          box-shadow: var(--shadow-lg);
          transform: translateX(105%);
          transition: transform 0.22s ease;
          overflow: hidden;
        }
        .hw-menusheet.open { transform: translateX(0); }
        .hw-menusheet-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 14px 16px;
          border-bottom: 1px solid var(--hw-border);
          flex-shrink: 0;
        }
        .hw-menusheet-title { font-size: 14px; font-weight: 700; color: var(--hw-text); }
        .hw-menusheet-close {
          width: 40px;
          height: 40px;
          min-width: 40px;
          border: 1px solid var(--hw-border-strong);
          background: var(--hw-input-bg);
          border-radius: var(--radius-sm);
          color: var(--hw-text);
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .hw-menusheet-close svg { width: 18px; height: 18px; }
        .hw-menusheet-body {
          flex: 1;
          overflow-y: auto;
          -webkit-overflow-scrolling: touch;
          padding: 8px 10px calc(16px + var(--safe-bottom));
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .hw-menusheet-body .hw-menu-group-label { padding-top: 14px; }
        .hw-menusheet-body .hw-menu-item { min-height: 44px; font-size: 14px; }

        /* ============ Settings shell (sidebar + panes) ============ */
        .settings-shell {
          display: grid;
          grid-template-columns: 232px minmax(0, 1fr);
          gap: clamp(12px, 2vw, 24px);
          max-width: min(1360px, 100%);
          margin: 0 auto;
          width: 100%;
          align-items: start;
        }
        .settings-sidenav {
          position: sticky;
          top: calc(var(--hw-menubar-height) + 8px);
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 8px;
          background: var(--hw-surface);
          border: 1px solid var(--hw-border);
          border-radius: var(--radius-lg);
          box-sizing: border-box;
        }
        .settings-sidenav button {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 100%;
          min-height: 42px;
          padding: 0 12px;
          border: none;
          border-radius: var(--radius-sm);
          background: transparent;
          color: var(--hw-muted);
          font-size: 13px;
          font-weight: 500;
          font-family: inherit;
          text-align: left;
          cursor: pointer;
          transition: background 0.12s ease, color 0.12s ease;
          box-sizing: border-box;
          white-space: nowrap;
        }
        .settings-sidenav button:hover { background: var(--hw-hover); color: var(--hw-text); }
        .settings-sidenav button:focus-visible { outline: 2px solid var(--hw-accent); outline-offset: -2px; }
        .settings-sidenav button.active {
          background: var(--hw-accent-dim, rgba(3, 169, 244, 0.14));
          color: var(--hw-accent-hover);
          font-weight: 600;
        }
        .settings-sidenav button svg { width: 17px; height: 17px; flex-shrink: 0; }
        .settings-sidenav-desc { display: none; }
        .settings-content { min-width: 0; display: flex; flex-direction: column; }
        .settings-pane { display: none; flex-direction: column; gap: 14px; min-width: 0; }
        .settings-pane.active { display: flex; }
        .settings-pane-head { margin-bottom: 2px; }
        .settings-pane-title { font-size: 18px; font-weight: 700; letter-spacing: -0.01em; color: var(--hw-text); }
        .settings-pane-sub { font-size: 13px; color: var(--hw-muted); margin-top: 3px; line-height: 1.5; max-width: 72ch; }
        .settings-card {
          background: var(--hw-surface);
          border: 1px solid var(--hw-border);
          border-radius: var(--radius-md);
          padding: 18px 20px;
          display: flex;
          flex-direction: column;
          gap: var(--form-gap, 16px);
          min-width: 0;
        }
        .settings-card-title { font-size: 15px; font-weight: 600; color: var(--hw-text); }
        .settings-card-sub { font-size: 12px; color: var(--hw-muted); line-height: 1.5; margin-top: 2px; }
        .settings-card-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          padding-bottom: 12px;
          border-bottom: 1px solid var(--hw-border);
          margin-bottom: 4px;
        }
        .settings-card-header .settings-card-sub { margin-top: 4px; }
        .settings-card-header + .settings-card-body { padding-top: 8px; }
        .settings-card-body { display: flex; flex-direction: column; gap: var(--form-gap, 16px); }
        .settings-card-body > .form-group:last-child { margin-bottom: 0; }
        .settings-card-body > .form-hint:first-child { margin-top: 0; }
        .settings-card-body > .form-actions-row { margin-top: 4px; }

        /* Version section */
        .version-section { margin-top: 4px; }
        .version-row {
          padding: 12px 14px;
          background: var(--hw-surface-2);
          border-radius: var(--radius-sm, 6px);
          margin-bottom: 10px;
        }
        .version-row:last-child { margin-bottom: 0; }
        .version-row-header {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .version-label {
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          color: var(--hw-muted);
          min-width: 90px;
        }
        .version-value {
          font-size: 14px;
          font-weight: 600;
          color: var(--hw-text);
          font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, monospace;
        }
        .version-date {
          font-size: 12px;
          color: var(--hw-muted);
          margin-left: auto;
        }
        .version-badge {
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.3px;
          padding: 3px 8px;
          border-radius: 4px;
          white-space: nowrap;
        }
        .version-badge.update {
          background: rgba(76, 175, 80, 0.15);
          color: #4caf50;
        }
        .version-badge.checking {
          background: rgba(3, 169, 244, 0.12);
          color: var(--hw-accent);
        }
        .version-badge.error {
          background: rgba(244, 67, 54, 0.12);
          color: var(--hw-danger);
        }
        .version-notes {
          font-size: 12px;
          color: var(--hw-muted);
          line-height: 1.55;
          margin-top: 8px;
          padding-top: 8px;
          border-top: 1px solid var(--hw-border);
          white-space: pre-wrap;
          word-break: break-word;
        }
        .version-link {
          display: inline-block;
          font-size: 12px;
          color: var(--hw-accent);
          text-decoration: none;
          margin-top: 8px;
        }
        .version-link:hover { text-decoration: underline; }
        .version-checking-text,
        .version-error-text {
          font-size: 12px;
          color: var(--hw-muted);
          font-style: italic;
        }
        .version-error-text { color: var(--hw-danger); opacity: 0.8; }

        .settings-form-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: var(--form-gap, 16px);
          align-items: start;
        }
        .settings-form-grid > .form-hint,
        .settings-form-grid > .inline-toggle,
        .settings-form-grid > .settings-toggle-row,
        .settings-form-grid > p,
        .settings-form-grid > .form-row-inline {
          grid-column: 1 / -1;
        }
        .settings-form-grid .form-group { margin-bottom: 0; }
        .monitoring-card { gap: 12px; }
        @media (max-width: 640px) {
          .settings-form-grid { grid-template-columns: 1fr; }
        }
        @media (max-width: 900px) {
          .settings-shell { grid-template-columns: 1fr; }
          .settings-sidenav {
            position: sticky;
            top: calc(var(--hw-menubar-height) + 8px);
            z-index: 60;
            flex-direction: row;
            flex-wrap: nowrap;
            gap: 6px;
            overflow-x: auto;
            overscroll-behavior-x: contain;
            -webkit-overflow-scrolling: touch;
            scrollbar-width: none;
            scroll-snap-type: x proximity;
            padding: 6px;
            border-radius: var(--radius-md);
            max-width: 100%;
          }
          .settings-sidenav::-webkit-scrollbar { display: none; }
          .settings-sidenav button {
            width: auto;
            flex: 0 0 auto;
            min-height: 44px;
            padding: 0 14px;
            scroll-snap-align: start;
            border-radius: 999px;
            border: 1px solid transparent;
          }
          .settings-sidenav button.active { border-color: var(--hw-accent-dim); }
        }
        /* Below 768px: keep forms single-column and tap targets generous. */
        @media (max-width: 768px) {
          .settings-form-grid { grid-template-columns: 1fr; }
          .settings-card { padding: 16px; }
          .form-row-inline { flex-direction: column; }
          .settings-form-footer { flex-wrap: wrap; }
          .settings-form-footer .btn { flex: 1 1 auto; min-height: 44px; }
        }

        /* Alert zone cards + hazard monitoring collapsibles */
        .collapsible-section.is-disabled { opacity: 0.6; }
        .collapsible-section.collapsible-section--zone {
          border-left: 4px solid var(--zone-color, var(--hw-accent));
        }
        .zone-cards {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
          gap: 12px;
        }
        .zone-card {
          background: var(--hw-surface);
          border: 1px solid var(--hw-border);
          border-left: 4px solid var(--zone-color, var(--hw-accent));
          border-radius: var(--radius-md);
          padding: 14px 16px;
          display: flex;
          flex-direction: column;
          gap: 0;
          min-width: 0;
        }
        .zone-card-head {
          display: flex;
          align-items: center;
          gap: 10px;
          padding-bottom: 12px;
          border-bottom: 1px solid var(--hw-border);
        }
        .zone-card-head img { width: 20px; height: 20px; flex-shrink: 0; }
        .zone-card-title { font-size: 14px; font-weight: 600; color: var(--hw-text); flex: 1; }
        .zone-card-body { display: flex; flex-direction: column; gap: 0; padding-top: 4px; }
        .zone-card-desc { margin: 10px 0 4px !important; }
        .zone-card.is-disabled { opacity: 0.6; }
        .zone-card-field {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 12px 0;
          border-bottom: 1px solid var(--hw-border);
        }
        .zone-card-field:first-of-type { padding-top: 8px; }
        .zone-card-field:last-of-type { border-bottom: none; padding-bottom: 0; }
        .zone-card-field > label {
          font-size: 12px;
          font-weight: 600;
          color: var(--hw-muted);
          letter-spacing: 0.01em;
        }
        .zone-card-field input[type="number"],
        .zone-card-field select {
          width: 100%;
          height: 40px;
          padding: 0 12px;
          border: 1px solid var(--input-border);
          border-radius: 8px;
          background: var(--input-bg);
          color: var(--primary-text-color);
          font-size: 14px;
          font-variant-numeric: tabular-nums;
          box-sizing: border-box;
          transition: border-color 0.15s ease, box-shadow 0.15s ease;
        }
        .zone-card-field input[type="number"]:focus,
        .zone-card-field select:focus {
          outline: none;
          border-color: var(--panel-accent);
          box-shadow: 0 0 0 2px var(--panel-accent-dim);
        }
        .zone-card-field .zone-mode-seg {
          display: flex;
          width: 100%;
          border: 1px solid var(--input-border);
          border-radius: 8px;
          overflow: hidden;
        }
        .zone-card-field .zone-mode-seg button {
          flex: 1;
          min-height: 40px;
          padding: 0 12px;
          border: none;
          background: transparent;
          color: var(--hw-muted);
          font-size: 13px;
          font-weight: 600;
          font-family: inherit;
          cursor: pointer;
          transition: background 0.12s ease, color 0.12s ease;
        }
        .zone-card-field .zone-mode-seg button + button { border-left: 1px solid var(--input-border); }
        .zone-card-field .zone-mode-seg button.active { background: var(--panel-accent-dim); color: var(--panel-accent-hover); }
        .zone-card-field .zone-mode-seg button:focus-visible { outline: 2px solid var(--hw-accent); outline-offset: -2px; }
        .zone-card-field--toggle .toggle-switch { align-self: flex-start; }
        .zone-card-note { font-size: 12px; color: var(--hw-warning, #ffb74d); line-height: 1.45; margin: 0; }

        /* Appearance tab */
        .theme-mode-block { display: flex; flex-direction: column; gap: 10px; }
        .theme-mode-seg {
          display: inline-flex;
          border: 1px solid var(--input-border);
          border-radius: 10px;
          overflow: hidden;
          width: fit-content;
        }
        .theme-mode-seg button {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          min-height: 38px;
          padding: 0 18px;
          border: none;
          background: transparent;
          color: var(--hw-muted);
          font-size: 13px;
          font-weight: 600;
          font-family: inherit;
          cursor: pointer;
          transition: background 0.14s ease, color 0.14s ease;
        }
        .theme-mode-seg button + button { border-left: 1px solid var(--input-border); }
        .theme-mode-seg button.active { background: var(--panel-accent-dim); color: var(--panel-accent-hover); }
        .theme-mode-seg button:focus-visible { outline: 2px solid var(--hw-accent); outline-offset: -2px; }
        .theme-mode-seg svg { flex-shrink: 0; }
        .theme-swatch-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
          gap: 10px;
        }
        .theme-swatch-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 10px 12px;
          border: 1px solid var(--hw-border);
          border-radius: var(--radius-sm);
          background: var(--hw-surface-2);
        }
        .theme-swatch-row.is-overridden { border-color: var(--hw-accent); }
        .theme-swatch-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .theme-swatch-label { font-size: 13px; font-weight: 600; color: var(--hw-text); }
        .theme-swatch-hint { font-size: 11px; color: var(--hw-muted); }
        .theme-swatch { position: relative; flex-shrink: 0; width: 40px; height: 32px; cursor: pointer; }
        .theme-swatch input[type="color"] {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          opacity: 0;
          cursor: pointer;
          border: none;
          padding: 0;
        }
        .theme-swatch-dot {
          display: block;
          width: 100%;
          height: 100%;
          border-radius: 8px;
          border: 1px solid var(--hw-border-strong);
          box-shadow: inset 0 0 0 2px var(--hw-surface);
          pointer-events: none;
        }
        .btn-sm { min-height: 32px; padding: 0 12px; font-size: 12px; }
        .zone-editor-cta {
          display: flex;
          align-items: center;
          gap: 16px;
          flex-wrap: wrap;
          justify-content: space-between;
          background: linear-gradient(120deg, rgba(3, 169, 244, 0.14), rgba(3, 169, 244, 0.03));
          border: 1px solid rgba(3, 169, 244, 0.35);
          border-radius: var(--radius-md);
          padding: 16px 20px;
        }
        .zone-editor-cta-text { flex: 1 1 260px; min-width: 0; }
        .zone-editor-cta-title { font-size: 15px; font-weight: 700; color: var(--hw-text); }
        .zone-editor-cta-sub { font-size: 12px; color: var(--hw-muted); margin-top: 4px; line-height: 1.5; }

        /* Zone editor view */
        .zones-view {
          height: 100dvh;
          max-height: 100dvh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .zones-view .settings-body {
          flex: 1;
          min-height: 0;
          padding: 0;
          max-width: none;
          margin: 0;
          width: 100%;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
      </style>
      ${this._currentView === "forecast" || this._currentView === "alerts" || this._currentView === "hurricanes" || this._currentView === "space" || this._currentView === "zones"
        ? this._currentView === "alerts"
          ? `<div class="settings-view ${this._isNarrow ? "narrow" : ""}">
            ${this._renderAlertsMenubar()}
            <div class="settings-body">
            ${this._renderContent()}
            </div>
          </div>`
          : this._currentView === "hurricanes"
            ? `<div class="settings-view maps-view ${this._isNarrow ? "narrow" : ""}">
            ${this._renderMapsMenubar()}
            <div class="settings-body">
            ${this._renderContent()}
            </div>
          </div>`
          : this._currentView === "space"
            ? `<div class="settings-view maps-view space-view ${this._isNarrow ? "narrow" : ""}">
            ${this._renderSpaceMenubar()}
            <div class="settings-body">
            ${this._renderContent()}
            </div>
          </div>`
          : this._currentView === "zones"
            ? `<div class="settings-view zones-view ${this._isNarrow ? "narrow" : ""}">
            ${this._renderZonesMenubar()}
            <div class="settings-body">
            ${this._renderContent()}
            </div>
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
                <button class="icon-btn" id="alerts-btn" aria-label="${this._getActiveAlertCount() ? `Alerts, ${this._getActiveAlertCount()} active` : "Alerts"}" style="display:flex;align-items:center;gap:6px;padding:0 10px;width:auto;min-width:40px;">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
                  <span style="font-size:12px;font-weight:500;">Alerts</span>
                  ${this._renderAlertsBadge()}
                </button>
                <button class="icon-btn" id="hurricanes-btn" aria-label="Hazard Map" title="Hazard Map">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M20.5 3l-.16.03L15 5.1 9 3 3.36 4.9c-.21.07-.36.25-.36.48V20.5c0 .28.22.5.5.5l.16-.03L9 18.9l6 2.1 5.64-1.9c.21-.07.36-.25.36-.48V3.5c0-.28-.22-.5-.5-.5zM15 19l-6-2.11V5l6 2.11V19z"/></svg>
                </button>
                <button class="icon-btn" id="space-map-btn" aria-label="Space Map" title="Space Map">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" aria-hidden="true">
                    <circle cx="12" cy="12" r="3"/>
                    <ellipse cx="12" cy="12" rx="9" ry="4" fill="none" stroke="currentColor" stroke-width="1.5"/>
                    <ellipse cx="12" cy="12" rx="6.5" ry="2.5" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.75" transform="rotate(-25 12 12)"/>
                    <circle cx="19" cy="10" r="1.1"/>
                    <circle cx="5.5" cy="14.5" r="0.85"/>
                  </svg>
                </button>
                <button class="icon-btn" id="gear-btn" aria-label="Settings">
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94 0 .31.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>
                </button>
              </header>
              <div class="content-area">
              ${this._renderContent()}
              </div>
            </div>
          </div>`
        : `<div class="settings-view ${this._isNarrow ? "narrow" : ""}">
            ${this._renderSettingsMenubar()}
            <div class="settings-body">
            ${this._renderContent()}
            </div>
            ${this._renderSettingsNotice()}
          </div>`
      }
    `;
    // Re-insert preserved Windy iframe only when coordinates/mode URL still match.
    if (canPreserveWindy) {
      const newContainer = s.querySelector(".maps-windy-frame");
      const newIframe = newContainer ? newContainer.querySelector("iframe") : null;
      if (newIframe && newIframe.getAttribute("src") === prevWindyUrl) {
        newIframe.replaceWith(prevIframe);
      }
    }
    s.getElementById("hamburger-btn")?.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true }));
    });
    const gearBtn = s.getElementById("gear-btn");
    const alertsBtn = s.getElementById("alerts-btn");
    const hurricanesBtn = s.getElementById("hurricanes-btn");
    const spaceMapBtn = s.getElementById("space-map-btn");
    const backBtn = s.getElementById("back-btn");
    if (alertsBtn) alertsBtn.addEventListener("click", () => this._navigateTo("alerts"));
    if (hurricanesBtn) hurricanesBtn.addEventListener("click", () => this._navigateTo("hurricanes"));
    if (spaceMapBtn) spaceMapBtn.addEventListener("click", () => this._navigateTo("space"));
    if (gearBtn) gearBtn.addEventListener("click", () => this._navigateTo("settings"));
    if (backBtn) backBtn.addEventListener("click", () => this._navigateTo("forecast"));
    if (this._currentView === "hurricanes" || this._currentView === "space" || this._currentView === "settings" || this._currentView === "zones" || this._currentView === "alerts") {
      this._attachMenubarHandlers();
    }
    if (this._currentView === "settings") {
      this._attachSettingsHandlers();
    } else if (this._currentView === "zones") {
      this._initZoneEditor();
    } else if (this._currentView === "forecast") {
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
      s.querySelectorAll("[data-retry]").forEach((btn) => {
        btn.addEventListener("click", () => { this._fetchData(); });
      });
      this._initAtmosphereParticles();
      this._updateAtmosphereClock();
      if (this._weatherData?.configured && !this._dashboardSettled) {
        this._dashboardSettled = true;
      }
    } else if (this._currentView === "alerts") {
      this._destroyAtmosphereParticles();
      s.querySelectorAll("[data-alert-toggle], [data-alert-expand]").forEach((el) => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          const idx = el.dataset.alertToggle ?? el.dataset.alertExpand;
          if (idx == null) return;
          const card = s.querySelector(`.alert-card[data-alert-index="${idx}"]`);
          if (card) card.classList.toggle("expanded");
        });
      });
    } else if (this._currentView === "hurricanes") {
      if (this._mapsMode === "storms") this._initHurricaneTracker();
      if (this._mapsMode === "trends") this._initApexChart();
    } else if (this._currentView === "space") {
      this._initSpaceMap();
    }
    // Now that this render's DOM (incl. any child-component roots) exists, tag
    // the roots with the active theme so embedded components can key off
    // [data-hw-theme]. The --hw-* tokens already inherit into their shadow DOMs
    // from the host, so this is purely an explicit signal for child code.
    this._propagateThemeToChildren(this._getAppearance().mode);
  }

  /**
   * Centralized view navigation: tears down active view resources, applies
   * per-view setup, and re-renders.
   */
  async _navigateTo(view) {
    if (view === this._currentView) {
      this._closeMenusheet();
      return;
    }
    if (this._currentView === "settings") {
      this._syncSettingsFromForm();
      if (view !== "settings") this._clearSettingsNotice();
    }
    this._destroyHurricaneTracker();
    this._destroySpaceMap();
    this._destroyZoneEditor();
    this._destroyAtmosphereParticles();
    this._currentView = view;
    if (view === "alerts") {
      this._alertsData = null;
      this._alertsLoading = false;
    }
    if (view === "settings") {
      this._expandedSections = new Set();
      this._settingsPane = this._settingsPane || "general";
      await this._loadWwwSounds();
      this._render();
      this._loadWebhookInfo();
      return;
    }
    this._render();
  }

  _openZoneEditorView(returnView) {
    if (this._currentView === "settings") this._syncSettingsFromForm();
    this._zoneEditorReturnView = returnView || this._currentView || "settings";
    this._destroyHurricaneTracker();
    this._destroySpaceMap();
    this._destroyAtmosphereParticles();
    this._currentView = "zones";
    this._render();
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

  _getAccordionGroup(sectionId) {
    const generalNested = ["general-weather-source", "general-about"];
    if (generalNested.includes(sectionId)) return { type: "list", ids: generalNested };
    const monitoringNested = [
      "monitoring-tornado", "monitoring-earthquake", "monitoring-lightning", "monitoring-volcano",
      "monitoring-wildfire", "monitoring-air_quality",
    ];
    if (monitoringNested.includes(sectionId)) return { type: "list", ids: monitoringNested };
    const spaceNested = [
      "space-map-layers", "space-solar-display", "space-spacecraft-tracking", "space-neo-monitoring",
    ];
    if (spaceNested.includes(sectionId)) return { type: "list", ids: spaceNested };
    const safetyNested = ["travel-monitoring"];
    if (safetyNested.includes(sectionId)) return { type: "list", ids: safetyNested };
    const appearanceNested = ["appearance-overview", "appearance-theme", "appearance-colors"];
    if (appearanceNested.includes(sectionId)) return { type: "list", ids: appearanceNested };
    const alertsNested = [
      "general", "media-players", "time-based", "current-change", "upcoming-change",
      "sun-alerts", "nws-alerts", "tropical-alerts", "tornado-alerts", "earthquake-alerts",
      "volcano-alerts", "wildfire-alerts", "air-quality-alerts", "travel-alerts",
      "spacecraft-alerts", "solar-weather-alerts", "neo-alerts",
      "sensor-triggered", "webhook", "voice-satellite",
    ];
    if (alertsNested.includes(sectionId)) return { type: "list", ids: alertsNested };
    const advancedNested = ["forecast-settings", "ai-rewrite"];
    if (advancedNested.includes(sectionId)) return { type: "list", ids: advancedNested };
    if (/^media-player-\d+$/.test(sectionId)) return { type: "mediaPlayer", sectionId };
    const subMatch = sectionId.match(/^(media-player-\d+-)/);
    if (subMatch) return { type: "prefix", prefix: subMatch[1] };
    return null;
  }

  _toggleSection(sectionId) {
    if (!this._expandedSections) this._expandedSections = new Set();
    const isOpen = this._expandedSections.has(sectionId);
    const group = this._getAccordionGroup(sectionId);
    if (group && !isOpen) {
      if (group.type === "list") {
        group.ids.forEach((id) => { if (id !== sectionId) this._expandedSections.delete(id); });
      } else if (group.type === "prefix") {
        [...this._expandedSections]
          .filter((id) => id.startsWith(group.prefix) && id !== sectionId)
          .forEach((id) => this._expandedSections.delete(id));
      } else if (group.type === "mediaPlayer") {
        [...this._expandedSections]
          .filter((id) => {
            if (id === sectionId) return false;
            if (/^media-player-\d+$/.test(id)) return true;
            return /^media-player-\d+-/.test(id);
          })
          .forEach((id) => this._expandedSections.delete(id));
      }
    }
    if (isOpen) this._expandedSections.delete(sectionId);
    else this._expandedSections.add(sectionId);
  }

  _applyExpandedSectionsToDom(s) {
    if (!s) return;
    s.querySelectorAll(".collapsible-section[data-section-id]").forEach((section) => {
      const id = section.dataset.sectionId;
      const isOpen = this._expandedSections.has(id);
      section.classList.toggle("open", isOpen);
      const toggle = section.querySelector(":scope > .collapsible-header .collapsible-toggle");
      if (toggle) toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });
  }

  _handleCollapsibleToggle(sectionId, s) {
    if (!sectionId) return;
    this._toggleSection(sectionId);
    this._applyExpandedSectionsToDom(s);
  }

  _attachCollapsibleHandlers(s) {
    if (!s) return;
    s.querySelectorAll(".collapsible-section[data-section-id] > .collapsible-header").forEach((header) => {
      header.addEventListener("click", (e) => {
        if (e.target.closest(".toggle-switch, button, input, select, textarea, label, .entity-autocomplete-dropdown, .hw-entity-select-dropdown, .collapsible-toggle")) return;
        const section = header.closest(".collapsible-section");
        this._handleCollapsibleToggle(section?.dataset?.sectionId, s);
      });
    });
    s.querySelectorAll(".collapsible-toggle").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const section = btn.closest(".collapsible-section");
        this._handleCollapsibleToggle(section?.dataset?.sectionId, s);
      });
    });
  }

  _attachSettingsHandlers() {
    const s = this.shadowRoot;
    if (!s) return;

    // Initialize entity autocomplete inputs
    this._initEntityAutocompletes(s);
    this._initWeatherEntitySelect(s);
    this._ensureEntityRegistryCache().then(() => this._refreshWeatherEntitySelect());

    // Sidebar pane navigation — all panes stay in the DOM so form state and
    // the collect helpers keep working; switching is a pure class toggle.
    s.querySelectorAll(".settings-sidenav button[data-settings-pane]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const pane = btn.dataset.settingsPane;
        if (!pane) return;
        this._settingsPane = pane;
        s.querySelectorAll(".settings-sidenav button[data-settings-pane]").forEach((b) => b.classList.toggle("active", b === btn));
        s.querySelectorAll(".settings-pane").forEach((p) => p.classList.toggle("active", p.dataset.settingsPane === pane));
      });
    });

    // Appearance: theme mode + per-element color overrides (live preview).
    s.querySelectorAll(".theme-mode-seg button[data-theme-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        s.querySelectorAll(".theme-mode-seg button[data-theme-mode]").forEach((b) => b.classList.toggle("active", b === btn));
        if (!this._settings.appearance) this._settings.appearance = { mode: "dark", overrides: {} };
        this._settings.appearance.mode = btn.dataset.themeMode === "light" ? "light" : "dark";
        const base = this._themeBase(this._settings.appearance.mode);
        const ov = this._settings.appearance.overrides || {};
        s.querySelectorAll("input[data-theme-token]").forEach((inp) => {
          const key = inp.dataset.themeToken;
          if (!ov[key]) {
            const hex = this._themeSwatchHex(base, key);
            inp.value = hex;
            const dot = inp.parentElement?.querySelector(".theme-swatch-dot");
            if (dot) dot.style.background = hex;
          }
        });
        this._applyTheme();
        this._persistAppearance();
        if (this._currentView === "trends") this._initApexChart();
      });
    });
    s.querySelectorAll("input[data-theme-token]").forEach((inp) => {
      inp.addEventListener("input", () => {
        if (!this._settings.appearance) this._settings.appearance = { mode: "dark", overrides: {} };
        if (!this._settings.appearance.overrides) this._settings.appearance.overrides = {};
        this._settings.appearance.overrides[inp.dataset.themeToken] = inp.value;
        const dot = inp.parentElement?.querySelector(".theme-swatch-dot");
        if (dot) dot.style.background = inp.value;
        inp.closest(".theme-swatch-row")?.classList.add("is-overridden");
        this._applyTheme();
        this._persistAppearance();
      });
    });
    s.getElementById("theme-reset-btn")?.addEventListener("click", () => {
      if (!this._settings.appearance) this._settings.appearance = { mode: "dark", overrides: {} };
      this._settings.appearance.overrides = {};
      const base = this._themeBase(this._getAppearance().mode);
      s.querySelectorAll("input[data-theme-token]").forEach((inp) => {
        const hex = this._themeSwatchHex(base, inp.dataset.themeToken);
        inp.value = hex;
        const dot = inp.parentElement?.querySelector(".theme-swatch-dot");
        if (dot) dot.style.background = hex;
        inp.closest(".theme-swatch-row")?.classList.remove("is-overridden");
      });
      this._applyTheme();
      this._persistAppearance();
    });

    // Alert Zones: independent scope segmented switches (separate sensor + alert zone/bypass)
    s.querySelectorAll('.zone-mode-seg[data-scope-for]').forEach((seg) => {
      const key = seg.getAttribute("data-scope-for");
      seg.querySelectorAll("button[data-mode]").forEach((btn) => {
        btn.addEventListener("click", () => {
          seg.querySelectorAll("button[data-mode]").forEach((b) => b.classList.toggle("active", b === btn));
          const note = s.querySelector(`.zone-card-note[data-scope-note-for="${key}"]`);
          if (note) note.style.display = btn.dataset.mode === "all" ? "" : "none";
        });
      });
    });

    // Alert Zones: dim card when hazard disabled
    s.querySelectorAll("[data-zone-card-enabled]").forEach((input) => {
      input.addEventListener("change", () => {
        const card = s.querySelector(`.zone-card[data-zone-card="${input.dataset.zoneCardEnabled}"]`);
        card?.classList.toggle("is-disabled", !input.checked);
      });
    });

    // Alert Zones: open full-screen map editor
    s.getElementById("open-zone-editor-btn")?.addEventListener("click", () => {
      this._openZoneEditorView("settings");
    });

    // Weather entity
    const we = s.getElementById("weather-entity");
    if (we) we.addEventListener("change", (e) => { this._settings.weather_entity = e.target.value || null; });

    // Collapsible sections — exclusive groups, all collapsed by default
    this._attachCollapsibleHandlers(s);
    
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
    const mediaPlayerList = s.querySelector("#media-player-list");
    (mediaPlayerList ? mediaPlayerList.querySelectorAll(".media-player-card") : []).forEach((card, i) => {
      card.querySelectorAll(".media-player-select, .media-player-tts-entity, .media-player-language, .media-player-options, .media-player-preroll").forEach((el) => {
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
          const pct = Math.round(parseFloat(slider.value) * 100);
          const valueDisplay = slider.nextElementSibling;
          if (valueDisplay) valueDisplay.textContent = pct + "%";
          slider.setAttribute("aria-valuetext", pct + " percent");
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
    wireTestButton("test-nws-siren-btn", "home_weather/test_nws_siren", "Playing\u2026");
    wireTestButton("test-tropical-btn", "home_weather/test_tropical_alert");
    wireTestButton("test-tropical-siren-btn", "home_weather/test_tropical_siren", "Playing\u2026");
    wireTestButton("test-tornado-btn", "home_weather/test_tornado_alert");
    wireTestButton("test-tornado-siren-btn", "home_weather/test_tornado_siren", "Playing\u2026");
    wireTestButton("test-earthquake-alert-btn", "home_weather/test_earthquake_alert");
    wireTestButton("test-earthquake-siren-btn", "home_weather/test_earthquake_siren", "Playing\u2026");
    wireTestButton("test-volcano-alert-btn", "home_weather/test_volcano_alert");
    wireTestButton("test-volcano-siren-btn", "home_weather/test_volcano_siren", "Playing\u2026");
    wireTestButton("test-wildfire-alert-btn", "home_weather/test_wildfire_alert");
    wireTestButton("test-wildfire-siren-btn", "home_weather/test_wildfire_siren", "Playing\u2026");
    wireTestButton("test-air-quality-alert-btn", "home_weather/test_air_quality_alert");
    wireTestButton("test-air-quality-siren-btn", "home_weather/test_air_quality_siren", "Playing\u2026");
    wireTestButton("test-travel-btn", "home_weather/test_travel_alert");
    wireTestButton("test-travel-siren-btn", "home_weather/test_travel_siren", "Playing\u2026");
    wireTestButton("test-spacecraft-alert-btn", "home_weather/test_spacecraft_alert");
    wireTestButton("test-spacecraft-siren-btn", "home_weather/test_spacecraft_siren", "Playing\u2026");
    wireTestButton("test-solar-weather-alert-btn", "home_weather/test_solar_weather_alert");
    wireTestButton("test-solar-weather-siren-btn", "home_weather/test_solar_weather_siren", "Playing\u2026");
    wireTestButton("test-neo-alert-btn", "home_weather/test_neo_alert");
    wireTestButton("test-neo-siren-btn", "home_weather/test_neo_siren", "Playing\u2026");
    
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
    
    // Save and Cancel (explicit)
    const saveBtn = s.getElementById("save-btn");
    const cancelBtn = s.getElementById("cancel-btn");
    if (saveBtn) saveBtn.addEventListener("click", () => this._saveSettings());
    if (cancelBtn) cancelBtn.addEventListener("click", () => {
      if (this._autoSaveTimer) { clearTimeout(this._autoSaveTimer); this._autoSaveTimer = null; }
      this._settings = JSON.parse(JSON.stringify(this._config || {}));
      this._clearSettingsNotice();
      this._render();
    });

    // Auto-save: debounced background save on any settings edit. Applied
    // optimistically so the form never blocks. The theme controls persist
    // separately (instantly) via _persistAppearance, so we skip them here.
    const settingsForm = s.querySelector(".settings-form");
    if (settingsForm && !settingsForm._autoSaveBound) {
      settingsForm._autoSaveBound = true;
      const onEdit = (e) => {
        const t = e.target;
        if (!t) return;
        // Theme swatches/mode buttons handle their own instant persistence.
        if (t.closest && t.closest(".theme-mode-block, .theme-swatch-grid")) return;
        // Ignore events from embedded child components (zone editor, etc.).
        if (t.closest && t.closest("#zone-editor-root, #hurricane-tracker-root, #space-map-root")) return;
        this._scheduleAutoSave();
      };
      settingsForm.addEventListener("input", onEdit);
      settingsForm.addEventListener("change", onEdit);
    }
  }

  _renderSettingsNotice() {
    if (!this._settingsNotice) return "";
    const isError = this._settingsNotice.toLowerCase().includes("failed");
    return `<div class="settings-toast${isError ? " settings-toast--error" : ""}" role="status" aria-live="polite">${this._escapeHtml(this._settingsNotice)}</div>`;
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
    if (this._currentView === "forecast") {
      this._ensureNwsAlertsLoaded();
      return this._renderForecast();
    }
    if (this._currentView === "alerts") return this._renderAlerts();
    if (this._currentView === "hurricanes") return this._renderHurricanes();
    if (this._currentView === "space") return this._renderSpaceMap();
    if (this._currentView === "zones") return this._renderZones();
    return this._renderSettings();
  }

  /* ===================== Desktop-app menubar ===================== */

  _renderMenubarItem(item) {
    if (item.type === "divider") return `<hr class="hw-menu-divider"/>`;
    if (item.type === "label") return `<div class="hw-menu-group-label">${item.label}</div>`;
    const role = item.type === "radio" ? "menuitemradio" : item.type === "check" ? "menuitemcheckbox" : "menuitem";
    const checked = item.type === "radio" || item.type === "check" ? ` aria-checked="${item.checked ? "true" : "false"}"` : "";
    const mark = item.type === "radio"
      ? `<span class="hw-menu-mark"><svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg></span>`
      : item.type === "check"
        ? `<span class="hw-menu-mark"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></span>`
        : `<span class="hw-menu-mark"></span>`;
    const icon = item.icon ? `<img class="hw-menu-ico" src="/local/home_weather/icons/${item.icon}.svg" alt="" draggable="false"/>` : "";
    const hint = item.hint ? `<span class="hw-menu-item-hint">${item.hint}</span>` : "";
    return `
      <button type="button" class="hw-menu-item" role="${role}"${checked}
        data-mb-action="${item.action}" data-mb-value="${item.value ?? ""}" data-mb-type="${item.type}" ${item.disabled ? "disabled" : ""}>
        ${mark}${icon}<span class="hw-menu-item-label">${item.label}</span>${hint}
      </button>`;
  }

  _renderMenubar({ menus = [], backAction = null, backLabel = null }) {
    const backBtnHtml = backAction && backLabel ? `
      <button type="button" class="hw-menubar-back" data-mb-action="${backAction}" data-mb-value="" title="${backLabel}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
        <span>${backLabel}</span>
      </button>` : "";
    const menusHtml = menus.map((menu, index) => {
      const sep = index === 1 && !backAction ? `<span class="hw-menu-sep" aria-hidden="true"></span>` : "";
      return `${sep}
      <div class="hw-menu" data-menu-id="${menu.id}">
        <button type="button" class="hw-menu-trigger" aria-haspopup="true" aria-expanded="false">${menu.label}</button>
        <div class="hw-menu-dropdown" role="menu" aria-label="${menu.label}">
          ${menu.items.map((item) => this._renderMenubarItem(item)).join("")}
        </div>
      </div>`;
    }).join("");
    const hasMenus = menus.length > 0;
    const sheetHtml = hasMenus ? `
      <div class="hw-menusheet-backdrop" data-menusheet-close></div>
      <aside class="hw-menusheet" role="dialog" aria-label="Menu">
        <div class="hw-menusheet-head">
          <div class="hw-menusheet-title">Home Weather</div>
          <button type="button" class="hw-menusheet-close" data-menusheet-close aria-label="Close menu">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>
        <div class="hw-menusheet-body">
          ${backAction && backLabel ? `<button type="button" class="hw-menu-item hw-menu-back-item" data-mb-action="${backAction}" data-mb-value="">
            <span class="hw-menu-mark"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg></span>
            <span class="hw-menu-item-label">${backLabel}</span>
          </button><hr class="hw-menu-divider"/>` : ""}
          ${menus.map((menu) => `
            <div class="hw-menu-group-label">${menu.label}</div>
            ${menu.items.map((item) => this._renderMenubarItem(item)).join("")}
          `).join("")}
        </div>
      </aside>` : "";
    return `
      <header class="hw-menubar">
        ${backBtnHtml}
        <nav class="hw-menubar-menus" role="menubar" aria-label="Application menu">
          ${menusHtml}
        </nav>
        ${hasMenus ? `<div class="hw-menubar-end">
          <button type="button" class="hw-menubar-mobile-trigger" data-menusheet-open aria-label="Open menu">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>
            <span>Menu</span>
          </button>
        </div>` : ""}
      </header>
      ${sheetHtml}`;
  }

  _renderAlertsMenubar() {
    return this._renderMenubar({
      menus: [],
      backAction: "nav",
      backLabel: "Back",
    });
  }

  _renderMapsMenubar() {
    const viewMenu = {
      id: "maps-view",
      label: "View",
      items: [
        { type: "radio", action: "maps-mode", value: "storms", label: "Hazards map", checked: this._mapsMode === "storms" },
        { type: "radio", action: "maps-mode", value: "radar", label: "Radar", checked: this._mapsMode === "radar" },
        { type: "radio", action: "maps-mode", value: "wind", label: "Wind", checked: this._mapsMode === "wind" },
        { type: "radio", action: "maps-mode", value: "rain", label: "Rain", checked: this._mapsMode === "rain" },
        { type: "radio", action: "maps-mode", value: "trends", label: "Hourly trends", checked: this._mapsMode === "trends" },
      ],
    };
    const toolsMenu = {
      id: "maps-tools",
      label: "Tools",
      items: [
        { type: "action", action: "maps-refresh", label: "Refresh hazard data" },
        { type: "action", action: "edit-zones", label: "Edit alert zones…" },
        { type: "divider" },
        { type: "label", label: "Earthquake sort" },
        { type: "radio", action: "maps-sort", value: "newest", label: "Newest first", checked: this._mapsSort === "newest" },
        { type: "radio", action: "maps-sort", value: "magnitude", label: "Magnitude", checked: this._mapsSort === "magnitude" },
        { type: "radio", action: "maps-sort", value: "distance", label: "Distance from home", checked: this._mapsSort === "distance" },
      ],
    };
    const trendsMenu = {
      id: "maps-trends",
      label: "Trends",
      items: [
        { type: "radio", action: "chart-metric", value: "temp", label: "Temperature", checked: (this._chartMetric || "temp") === "temp" },
        { type: "radio", action: "chart-metric", value: "precip", label: "Precipitation", checked: this._chartMetric === "precip" },
        { type: "radio", action: "chart-metric", value: "wind", label: "Wind", checked: this._chartMetric === "wind" },
        { type: "radio", action: "chart-metric", value: "humidity", label: "Humidity", checked: this._chartMetric === "humidity" },
      ],
    };
    const menus = [viewMenu];
    if (this._mapsMode === "storms") {
      menus.push(toolsMenu);
    } else if (this._mapsMode === "trends") {
      menus.push(trendsMenu);
    } else {
      menus.push(toolsMenu);
    }
    return this._renderMenubar({ menus, backAction: "nav", backLabel: "Back" });
  }

  _renderSettingsMenubar() {
    return this._renderMenubar({
      menus: [],
      backAction: "nav",
      backLabel: "Back",
    });
  }

  _renderZonesMenubar() {
    const returnView = this._zoneEditorReturnView || "settings";
    const backLabel = returnView === "hurricanes" ? "Back to Hazard Map" : returnView === "forecast" ? "Back to Dashboard" : "Back to Settings";
    const zonesMenu = {
      id: "zones-menu",
      label: "Zones",
      items: [
        { type: "action", action: "close-zones", value: "", label: backLabel, icon: "arrow-left" },
        { type: "divider" },
        { type: "action", action: "nav", value: "hurricanes", label: "Open Hazard Map" },
        { type: "action", action: "nav", value: "settings", label: "Open Settings" },
      ],
    };
    return this._renderMenubar({
      menus: [zonesMenu],
      backAction: "close-zones",
      backLabel,
    });
  }

  _closeAllMenus() {
    const s = this.shadowRoot;
    if (!s) return;
    s.querySelectorAll(".hw-menu.open").forEach((m) => {
      m.classList.remove("open");
      m.querySelector(".hw-menu-trigger")?.setAttribute("aria-expanded", "false");
    });
  }

  _closeMenusheet() {
    const s = this.shadowRoot;
    if (!s) return;
    s.querySelector(".hw-menusheet")?.classList.remove("open");
    s.querySelector(".hw-menusheet-backdrop")?.classList.remove("open");
  }

  _attachMenubarHandlers() {
    const s = this.shadowRoot;
    if (!s) return;

    if (!this._menubarGlobalBound) {
      this._menubarGlobalBound = true;
      s.addEventListener("click", (e) => {
        if (!e.target || !e.target.closest) return;
        if (!e.target.closest(".hw-menu")) this._closeAllMenus();
      });
      s.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          this._closeAllMenus();
          this._closeMenusheet();
        }
      });
    }

    s.querySelectorAll(".hw-menu-trigger").forEach((trigger) => {
      const menu = trigger.closest(".hw-menu");
      trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        const wasOpen = menu.classList.contains("open");
        this._closeAllMenus();
        if (!wasOpen) {
          menu.classList.add("open");
          trigger.setAttribute("aria-expanded", "true");
        }
      });
      trigger.addEventListener("mouseenter", () => {
        const anyOpen = s.querySelector(".hw-menu.open");
        if (anyOpen && anyOpen !== menu) {
          this._closeAllMenus();
          menu.classList.add("open");
          trigger.setAttribute("aria-expanded", "true");
        }
      });
      trigger.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          this._closeAllMenus();
          menu.classList.add("open");
          trigger.setAttribute("aria-expanded", "true");
          menu.querySelector(".hw-menu-item:not([disabled])")?.focus();
        } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          const triggers = [...s.querySelectorAll(".hw-menu-trigger")];
          const idx = triggers.indexOf(trigger);
          const next = e.key === "ArrowRight"
            ? triggers[(idx + 1) % triggers.length]
            : triggers[(idx - 1 + triggers.length) % triggers.length];
          next?.focus();
          if (menu.classList.contains("open")) {
            this._closeAllMenus();
            const nm = next?.closest(".hw-menu");
            if (nm) {
              nm.classList.add("open");
              next.setAttribute("aria-expanded", "true");
            }
          }
        }
      });
    });

    s.querySelectorAll(".hw-menu-dropdown").forEach((dropdown) => {
      dropdown.addEventListener("keydown", (e) => {
        const items = [...dropdown.querySelectorAll(".hw-menu-item:not([disabled])")];
        const current = items.indexOf(s.activeElement || document.activeElement);
        if (e.key === "ArrowDown") {
          e.preventDefault();
          items[(current + 1) % items.length]?.focus();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          items[(current - 1 + items.length) % items.length]?.focus();
        }
      });
    });

    s.querySelectorAll("[data-mb-action]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = el.dataset.mbAction;
        const value = el.dataset.mbValue || "";
        const type = el.dataset.mbType || "action";
        this._handleMenubarAction(action, value, type, el);
      });
    });

    s.querySelectorAll("[data-menusheet-open]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._hurricaneTracker?.collapseStatusPanel?.();
        s.querySelector(".hw-menusheet")?.classList.add("open");
        s.querySelector(".hw-menusheet-backdrop")?.classList.add("open");
      });
    });
    s.querySelectorAll("[data-menusheet-close]").forEach((el) => {
      el.addEventListener("click", () => this._closeMenusheet());
    });
  }

  /** Update aria-checked marks in-place for a check/radio menubar action. */
  _syncMenubarChecks(action, predicate) {
    const s = this.shadowRoot;
    if (!s) return;
    s.querySelectorAll(`[data-mb-action="${action}"]`).forEach((el) => {
      const val = el.dataset.mbValue || "";
      el.setAttribute("aria-checked", predicate(val) ? "true" : "false");
    });
  }

  async _handleMenubarAction(action, value, type, el) {
    switch (action) {
      case "nav":
        this._closeMenusheet();
        this._navigateTo(value || "forecast");
        break;
      case "edit-zones":
        this._closeMenusheet();
        this._closeAllMenus();
        this._openZoneEditorView(this._currentView === "zones" ? this._zoneEditorReturnView : this._currentView);
        break;
      case "close-zones":
        this._closeMenusheet();
        this._closeAllMenus();
        this._closeZoneEditorView();
        break;
      case "maps-mode": {
        this._closeMenusheet();
        const mode = value || "storms";
        if (mode === this._mapsMode) {
          this._closeAllMenus();
          return;
        }
        this._mapsMode = mode;
        if (mode !== "storms") this._destroyHurricaneTracker();
        this._render();
        break;
      }
      case "maps-layer": {
        if (!value) return;
        this._mapsLayers = this._normalizeMapLayers({
          ...this._mapsLayers,
          [value]: !this._mapsLayers[value],
        });
        this._syncMenubarChecks("maps-layer", (v) => !!this._mapsLayers[v]);
        this._hurricaneTracker?.setMapLayers(this._mapsLayers);
        break;
      }
      case "wind-radii":
        this._mapsWindRadii = !this._mapsWindRadii;
        this._syncMenubarChecks("wind-radii", () => this._mapsWindRadii);
        this._hurricaneTracker?.setShowWindRadii(this._mapsWindRadii);
        break;
      case "zones-overlay":
        this._mapsShowZones = !this._mapsShowZones;
        this._syncMenubarChecks("zones-overlay", () => this._mapsShowZones);
        this._hurricaneTracker?.setShowZones?.(this._mapsShowZones, this._getZoneOverlayConfig());
        break;
      case "maps-sort":
        this._mapsSort = value || "newest";
        this._syncMenubarChecks("maps-sort", (v) => v === this._mapsSort);
        this._closeAllMenus();
        this._closeMenusheet();
        this._hurricaneTracker?.setMapSort(this._mapsSort);
        break;
      case "maps-refresh": {
        this._closeAllMenus();
        this._closeMenusheet();
        if (el) el.disabled = true;
        try {
          await this._hurricaneTracker?.refresh();
          this._updateMapsHazardsMeta();
        } finally {
          if (el) el.disabled = false;
        }
        break;
      }
      case "chart-metric":
        this._chartMetric = value || "temp";
        this._syncMenubarChecks("chart-metric", (v) => v === this._chartMetric);
        this._closeAllMenus();
        this._closeMenusheet();
        this._initApexChart();
        break;
      case "space-mode": {
        this._closeMenusheet();
        const mode = value || "solar_system";
        if (mode === "settings") {
          this._settingsPane = "space";
          this._navigateTo("settings");
          return;
        }
        if (mode === this._spaceMode) {
          this._closeAllMenus();
          return;
        }
        this._spaceMode = mode;
        this._spaceMap?.setMode(mode);
        this._render();
        break;
      }
      case "space-layer": {
        if (!value) return;
        this._spaceLayers = { ...this._spaceLayers, [value]: !this._spaceLayers[value] };
        this._syncMenubarChecks("space-layer", (v) => !!this._spaceLayers[v]);
        this._spaceMap?.setLayers(this._spaceLayers);
        break;
      }
      case "space-log-scale": {
        const current = (this._settings.space_monitoring || {}).log_scale_orbits !== false;
        const enabled = !current;
        if (!this._settings.space_monitoring) this._settings.space_monitoring = {};
        this._settings.space_monitoring.log_scale_orbits = enabled;
        this._syncMenubarChecks("space-log-scale", () => enabled);
        this._spaceMap?.setLogScale(enabled);
        break;
      }
      case "space-refresh": {
        this._closeAllMenus();
        this._closeMenusheet();
        if (el) el.disabled = true;
        try {
          await this._spaceMap?.loadData();
        } finally {
          if (el) el.disabled = false;
        }
        break;
      }
      default:
        break;
    }
  }

  /** Zone circles for the hazard-map overlay, derived from saved settings. */
  _getZoneOverlayConfig() {
    const settings = this._settings || {};
    const hazards = [
      { key: "hurricane", configKey: "hurricane_monitoring", radiusKey: "max_distance_miles", color: "#29b6f6", label: "Hurricane zone", hasAlerts: true },
      { key: "tornado", configKey: "tornado_monitoring", radiusKey: "max_distance_miles", color: "#e040fb", label: "Tornado zone", hasAlerts: true },
      { key: "earthquake", configKey: "earthquake_monitoring", radiusKey: "radius_miles", color: "#ffa726", label: "Earthquake zone", hasAlerts: true },
      { key: "lightning", configKey: "lightning_monitoring", radiusKey: "geofield_radius_miles", color: "#ffee58", label: "Lightning zone", hasAlerts: false },
      { key: "volcano", configKey: "volcano_monitoring", radiusKey: "radius_miles", color: "#ff7043", label: "Volcano zone", hasAlerts: true },
      { key: "wildfire", configKey: "wildfire_monitoring", radiusKey: "radius_miles", color: "#ff5722", label: "Wildfire zone", hasAlerts: true },
      { key: "air_quality", configKey: "air_quality_monitoring", radiusKey: "radius_miles", color: "#42a5f5", label: "Air quality zone", hasAlerts: true },
    ];
    return hazards.map((h) => {
      const block = settings[h.configKey] || {};
      const sensorMode = block.zone_mode === "all" ? "all" : "zone";
      const alertMode = (block.alert_zone_mode ?? block.zone_mode) === "all" ? "all" : "zone";
      return {
        key: h.key,
        label: h.label,
        color: h.color,
        enabled: block.enabled !== false,
        zone_mode: sensorMode,
        alert_zone_mode: alertMode,
        has_alerts: h.hasAlerts,
        radius_miles: Number(block[h.radiusKey]) || 0,
      };
    });
  }

  /* ===================== Zone editor view ===================== */

  _renderZones() {
    return `
      <section class="maps-page">
        <div class="maps-stage">
          <div id="zone-editor-root"></div>
        </div>
      </section>`;
  }

  _loadZoneEditorScript() {
    if (window.ZoneEditor) return Promise.resolve();
    if (this._zoneEditorPromise) return this._zoneEditorPromise;
    const version = this._version || Date.now();
    this._zoneEditorPromise = new Promise((resolve, reject) => {
      const src = `/local/home_weather/zone-editor.js?v=${version}`;
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("Failed to load zone editor")), { once: true });
        if (window.ZoneEditor) resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load zone editor"));
      document.head.appendChild(script);
    });
    return this._zoneEditorPromise;
  }

  _destroyZoneEditor() {
    if (this._zoneEditor) {
      this._zoneEditor.destroy();
      this._zoneEditor = null;
    }
  }

  async _initZoneEditor() {
    const s = this.shadowRoot;
    if (!s || this._currentView !== "zones") return;
    const root = s.getElementById("zone-editor-root");
    if (!root) return;
    try {
      await this._loadZoneEditorScript();
      if (this._currentView !== "zones") return;
      this._destroyZoneEditor();
      const homeCoords = this._getHomeCoordinates();
      // Provide default coordinates if not available (center of contiguous US)
      const home = (homeCoords.lat != null && homeCoords.lon != null)
        ? homeCoords
        : { lat: 39.8283, lon: -98.5795 };
      this._zoneEditor = new window.ZoneEditor({
        hass: this._hass,
        shadowRoot: s,
        home,
        settings: this._settings || {},
        onSave: (patch) => this._saveZonePatch(patch),
        onClose: () => this._closeZoneEditorView(),
      });
      await this._zoneEditor.init(root);
    } catch (err) {
      root.innerHTML = `<div class="error" style="padding:24px;text-align:center;">Failed to load zone editor: ${String(err.message || err)}</div>`;
    }
  }

  _closeZoneEditorView() {
    this._destroyZoneEditor();
    this._currentView = this._zoneEditorReturnView || "settings";
    this._render();
  }

  async _saveZonePatch(patch) {
    if (!this._hass) return;
    Object.assign(this._settings, patch);
    // Keep legacy aliases in sync with the monitoring blocks.
    this._settings.earthquakes = { ...this._settings.earthquake_monitoring };
    if (this._settings.lightning_monitoring) {
      const { enabled: _enabled, ...legacyLightning } = this._settings.lightning_monitoring;
      this._settings.lightning = legacyLightning;
    }
    try {
      await this._hass.callWS({ type: "home_weather/set_config", config: this._settings });
      this._config = JSON.parse(JSON.stringify(this._settings));
      this._closeZoneEditorView();
    } catch (e) {
      console.error("Failed to save alert zones:", e);
      alert("Failed to save alert zones: " + (e?.message || e));
    }
  }

  _renderHurricanes() {
    this._prepareGraphData();
    const windyModes = ["radar", "wind", "rain"];
    const windyPanels = windyModes.map((mode) => {
      const active = this._mapsMode === mode;
      const windyUrl = this._buildWindyUrl(mode);
      const iframeHtml = active && windyUrl
        ? `<iframe src="${windyUrl}" frameborder="0" title="${mode} weather map" width="100%" height="100%" loading="lazy"></iframe>`
        : active && !windyUrl
          ? `<div class="maps-windy-loading">Loading location data…</div>`
          : "";
      return `
        <div class="maps-windy-view ${active ? "active" : ""}" data-maps-mode="${mode}">
          <div class="maps-windy-frame">
            ${iframeHtml}
          </div>
        </div>`;
    }).join("");

    return `
      <section class="maps-page">
        <div class="maps-stage">
          <div class="maps-view-panel ${this._mapsMode === "storms" ? "active" : ""}" data-maps-mode="storms">
            <div id="hurricane-tracker-root"></div>
          </div>
          ${windyPanels}
          <div class="maps-trends-panel ${this._mapsMode === "trends" ? "active" : ""}" data-maps-mode="trends">
            <div>
              <div class="maps-trends-title">Hourly trends</div>
              <div class="maps-trends-sub">Next 24 hours from your weather entity</div>
            </div>
            <div class="chart-container maps-chart-container" id="maps-apex-chart"></div>
          </div>
        </div>
      </section>`;
  }

  _updateMapsHazardsMeta() {
    const s = this.shadowRoot;
    if (!s) return;
    const el = s.getElementById("maps-hazards-updated");
    if (!el) return;
    const updated = this._hurricaneTracker?.getLastUpdated?.();
    el.textContent = updated ? `Updated ${updated}` : "Updated —";
  }

  _loadHurricaneTrackerScript() {
    if (window.HurricaneTracker && window.BlitzortungClient) return Promise.resolve();
    if (this._hurricaneTrackerPromise) return this._hurricaneTrackerPromise;
    const version = this._version || Date.now();
    const loadScript = (src, globalName) => new Promise((resolve, reject) => {
      if (globalName && window[globalName]) {
        resolve();
        return;
      }
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
        if (globalName && window[globalName]) resolve();
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
    this._hurricaneTrackerPromise = loadScript(`/local/home_weather/blitzortung-client.js?v=${version}`, "BlitzortungClient")
      .then(() => loadScript(`/local/home_weather/hurricane-tracker.js?v=${version}`, "HurricaneTracker"));
    return this._hurricaneTrackerPromise;
  }

  _destroyHurricaneTracker() {
    if (this._hurricaneTracker) {
      this._hurricaneTracker.destroy();
      this._hurricaneTracker = null;
    }
  }

  _renderSpaceMap() {
    return `
      <section class="maps-page">
        <div class="maps-stage">
          <div class="maps-view-panel active" data-maps-mode="space">
            <div id="space-map-root"></div>
          </div>
        </div>
      </section>`;
  }

  _renderSpaceMenubar() {
    const spaceMonitoring = this._settings.space_monitoring || {};
    const layerItems = [
      { key: "planets", label: "Planets" },
      { key: "dwarf_planets", label: "Dwarf planets" },
      { key: "moons", label: "Moons" },
      { key: "spacecraft", label: "Spacecraft" },
      { key: "asteroids", label: "Asteroids" },
      { key: "comets", label: "Comets" },
    ].map(({ key, label }) => ({
      type: "check",
      action: "space-layer",
      value: key,
      label,
      checked: this._spaceLayers[key] !== false,
    }));
    return this._renderMenubar({
      backAction: "nav",
      backLabel: "Back",
      menus: [
        {
          id: "space-view",
          label: "View",
          items: [
            { type: "radio", action: "space-mode", value: "solar_system", label: "Solar System", checked: this._spaceMode === "solar_system" },
            { type: "radio", action: "space-mode", value: "earth", label: "Earth", checked: this._spaceMode === "earth" },
            { type: "divider" },
            { type: "radio", action: "nav", value: "settings", label: "Space settings…" },
          ],
        },
        {
          id: "space-layers",
          label: "Layers",
          items: layerItems,
        },
        {
          id: "space-actions",
          label: "Actions",
          items: [
            { type: "radio", action: "space-log-scale", value: "1", label: "Log-scale orbits", checked: spaceMonitoring.log_scale_orbits !== false },
            { type: "divider" },
            { type: "radio", action: "space-refresh", value: "1", label: "Refresh now" },
          ],
        },
      ],
    });
  }

  _updateSpaceMeta() {
    const s = this.shadowRoot;
    if (!s) return;
    const el = s.getElementById("space-updated-meta");
    if (!el) return;
    const updated = this._spaceMap?.getLastUpdated?.();
    el.textContent = updated ? `Updated ${updated}` : "Updated —";
  }

  _loadSpaceMapScript() {
    if (window.SpaceMap && typeof window.SpaceMap === "function") return Promise.resolve();
    if (this._spaceMapPromise) return this._spaceMapPromise;
    const version = this._version || Date.now();
    const loadScript = (src, globalName, verify) => new Promise((resolve, reject) => {
      if (globalName && window[globalName] && (!verify || verify(window[globalName]))) {
        resolve();
        return;
      }
      const existing = document.querySelector(`script[data-hw-src="${src}"]`);
      if (existing) {
        if (globalName && window[globalName] && (!verify || verify(window[globalName]))) {
          resolve();
          return;
        }
        if (existing.dataset.hwFailed === "1") {
          existing.remove();
        } else if (existing.readyState === "complete" || existing.readyState === "loaded") {
          reject(new Error(`Failed to load ${src}`));
          return;
        } else {
          existing.addEventListener("load", () => {
            if (globalName && window[globalName] && (!verify || verify(window[globalName]))) resolve();
            else reject(new Error(`Failed to load ${src}`));
          }, { once: true });
          existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
          return;
        }
      }
      const script = document.createElement("script");
      script.src = src;
      script.dataset.hwSrc = src;
      script.onload = () => {
        if (globalName && window[globalName] && (!verify || verify(window[globalName]))) {
          resolve();
          return;
        }
        script.dataset.hwFailed = "1";
        reject(new Error(`Failed to load ${src}`));
      };
      script.onerror = () => {
        script.dataset.hwFailed = "1";
        reject(new Error(`Failed to load ${src}`));
      };
      document.head.appendChild(script);
    });
    this._spaceMapPromise = loadScript(
      `/local/home_weather/space-map.js?v=${version}`,
      "SpaceMap",
      (spaceMap) => typeof spaceMap === "function",
    )
      .catch((err) => {
        this._spaceMapPromise = null;
        throw err;
      });
    return this._spaceMapPromise;
  }

  _destroySpaceMap() {
    if (this._spaceRefreshTimer) {
      clearInterval(this._spaceRefreshTimer);
      this._spaceRefreshTimer = null;
    }
    if (this._spaceMap) {
      this._spaceMap.destroy();
      this._spaceMap = null;
    }
  }

  async _initSpaceMap() {
    const s = this.shadowRoot;
    if (!s || this._currentView !== "space") return;
    const root = s.getElementById("space-map-root");
    if (!root) return;
    try {
      await this._loadSpaceMapScript();
      if (this._currentView !== "space") return;
      this._destroySpaceMap();
      const spaceMonitoring = this._settings.space_monitoring || {};
      this._spaceLayers = {
        planets: spaceMonitoring.show_planets !== false,
        dwarf_planets: spaceMonitoring.show_dwarf_planets !== false,
        moons: spaceMonitoring.show_moons !== false,
        spacecraft: spaceMonitoring.show_spacecraft !== false,
        asteroids: spaceMonitoring.show_asteroids !== false,
        comets: spaceMonitoring.show_comets !== false,
      };
      if (typeof window.SpaceMap !== "function") {
        throw new Error("SpaceMap module unavailable");
      }
      this._spaceMap = new window.SpaceMap({
        hass: this._hass,
        shadowRoot: s,
        root,
        mode: this._spaceMode,
        layers: this._spaceLayers,
        logScale: spaceMonitoring.log_scale_orbits !== false,
        onModeChange: (mode) => {
          // Keep panel state + menubar radios in sync when the user switches
          // modes with the in-canvas segmented control.
          this._spaceMode = mode;
          this._syncMenubarChecks("space-mode", (v) => v === mode);
        },
      });
      this._spaceMap.mount();
      if (!this._spaceRefreshTimer) {
        this._spaceRefreshTimer = setInterval(() => {
          if (this._currentView === "space") this._spaceMap?.loadData();
        }, 60000);
      }
    } catch (err) {
      console.error("Failed to init space map:", err);
      const detail = String(err?.message || err || "Unknown error")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      root.innerHTML = `
        <div class="space-error">
          <p>Failed to load space map.</p>
          <p class="space-error-detail">${detail}</p>
          <p class="space-error-detail">Try reloading the Home Weather integration, then hard-refresh the panel (Ctrl+F5).</p>
        </div>`;
    }
  }

  async _initHurricaneTracker() {
    const s = this.shadowRoot;
    if (!s || this._currentView !== "hurricanes") return;
    const root = s.getElementById("hurricane-tracker-root");
    if (!root) return;
    try {
      await this._loadHurricaneTrackerScript();
      if (this._currentView !== "hurricanes") return;
      this._destroyHurricaneTracker();
      this._mapsLayers.lightning = (this._settings?.lightning_monitoring || this._settings?.lightning || {}).show_on_map !== false;
      this._hurricaneTracker = new window.HurricaneTracker({
        hass: this._hass,
        shadowRoot: s,
        embedded: true,
        lightningSettings: this._settings.lightning_monitoring || this._settings.lightning || { enabled: true, show_on_map: true, max_age_minutes: 60, max_strikes: 500 },
      });
      await this._hurricaneTracker.init(root);
      this._hurricaneTracker.setShowWindRadii(this._mapsWindRadii);
      this._hurricaneTracker.setMapLayers(this._mapsLayers);
      this._hurricaneTracker.setMapSort(this._mapsSort);
      this._hurricaneTracker.setShowZones?.(this._mapsShowZones, this._getZoneOverlayConfig());
      this._hurricaneTracker.setOnLayerToggle?.((key, active) => {
        this._mapsLayers = this._normalizeMapLayers({ ...this._mapsLayers, [key]: active });
      });
      this._hurricaneTracker.setOnOverlayToggle?.((key, active) => {
        if (key === "wind_radii") {
          this._mapsWindRadii = active;
        } else if (key === "alert_zones") {
          this._mapsShowZones = active;
          this._hurricaneTracker?.setShowZones?.(active, this._getZoneOverlayConfig());
        }
      });
      this._updateMapsHazardsMeta();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => this._hurricaneTracker?.invalidateMapSize?.());
      });
    } catch (err) {
      root.innerHTML = `<div class="error" style="padding:24px;text-align:center;">Failed to load hazard map: ${String(err.message || err)}</div>`;
    }
  }

  _renderSkeleton() {
    return `
      <section class="dashboard">
        <article class="glass card atmosphere-card skeleton-card" aria-busy="true" aria-label="Loading current conditions">
          <div class="atmosphere-bg" aria-hidden="true">
            <div class="atmosphere-bg__gradient"></div>
            <div class="atmosphere-bg__veil"></div>
          </div>
          <div class="atmosphere-content">
            <div class="skeleton-line half"></div>
            <div class="skeleton-line hero"></div>
            <div class="skeleton-line wide" style="height:24px;width:70%"></div>
            <div class="skeleton-line wide" style="height:6px;margin-top:8px"></div>
            <div class="atmosphere-metrics">
              ${Array.from({ length: 6 }).map(() => `
                <div class="metric-glass">
                  <div class="skeleton-line half"></div>
                  <div class="skeleton-line wide" style="height:22px"></div>
                </div>
              `).join("")}
            </div>
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

    this._prepareGraphData();

    const feelsLike = (current.apparent_temperature ?? h0.apparent_temperature) != null ? Math.round(current.apparent_temperature ?? h0.apparent_temperature) : null;
    const humidity = (current.humidity ?? h0.humidity) != null ? Math.round(current.humidity ?? h0.humidity) : null;
    const windSpeed = (current.wind_speed ?? h0.wind_speed);
    const windGusts = (current.wind_gust_speed ?? h0.wind_gust_speed);
    const pressure = current.pressure;
    const uvIndex = current.uv_index;
    const dewPoint = current.dew_point;
    const cloudCoverage = current.cloud_coverage;

    const moon = this._getMoonPhase(now);

    const atmosphereDateTime = this._formatAtmosphereDateTime(now);

    const { lat, lon } = this._getHomeCoordinates();

    const sunTimes = this._getSunTimes(lat, lon, now);
    const sunriseStr = sunTimes.sunrise ? sunTimes.sunrise.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
    const sunsetStr = sunTimes.sunset ? sunTimes.sunset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
    const solarNoonStr = sunTimes.solar_noon ? sunTimes.solar_noon.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
    const civilBeginStr = sunTimes.civil_twilight_begin ? sunTimes.civil_twilight_begin.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
    const civilEndStr = sunTimes.civil_twilight_end ? sunTimes.civil_twilight_end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—";
    const dayLengthStr = sunTimes.day_length != null ? `${Math.floor(sunTimes.day_length / 3600)}h ${Math.floor((sunTimes.day_length % 3600) / 60)}m` : "—";

    this._ensureSunTimes(lat, lon, now).catch(() => {});

    const theme = this._getAtmosphereTheme(condition, cloudCoverage, now);
    const atmosphereMetrics = this._buildAtmosphereMetrics({
      feelsLike,
      temp: typeof temp === "number" ? temp : null,
      humidity,
      dewPoint,
      windSpeed,
      windGusts,
      windUnit,
      uvIndex,
      pressure,
      pressureUnit: current.pressure_unit,
      cloudCoverage,
    });
    const condLabel = String(this._getConditionLabel(condition, now, current.condition_label)).replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

    const hiloHtml = this._renderAtmosphereHiLo(hiTemp, loTemp, typeof temp === "number" ? temp : null, esc);
    const metricsHtml = this._renderAtmosphereMetrics(atmosphereMetrics, esc);

    return `
      <section class="dashboard${this._dashboardSettled ? " dashboard--settled" : ""}">

        <article class="glass card atmosphere-card ${theme.className}" data-detail-hero data-atmosphere-mood="${theme.mood}" data-wind-speed="${windSpeed != null ? windSpeed : ""}" style="--atmosphere-cloud: ${theme.cloudOpacity}; --atmosphere-intensity: ${theme.intensity}">
          <div class="atmosphere-bg" aria-hidden="true">
            <div class="atmosphere-bg__gradient"></div>
            <div class="atmosphere-bg__clouds"></div>
            <div class="atmosphere-bg__particles"></div>
            <div class="atmosphere-bg__effects"></div>
            <div class="atmosphere-bg__veil"></div>
          </div>
          <div class="atmosphere-content">
            <div class="atmosphere-eyebrow">Current conditions</div>
            <div class="atmosphere-hero">
              <div class="atmosphere-hero-main">
                <div class="atmosphere-headline">
                  <div class="atmosphere-temp-row">
                    <span class="atmosphere-temp">${String(temp).replace(/</g, "&lt;")}</span><span class="atmosphere-unit">°</span>
                  </div>
                  <div class="atmosphere-condition">${condLabel}</div>
                  <div class="atmosphere-datetime">${esc(atmosphereDateTime)}</div>
                </div>
              </div>
              ${hiloHtml}
            </div>
            ${metricsHtml ? `<div class="atmosphere-metrics">${metricsHtml}</div>` : ""}
          </div>
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
              const iconWhen = i === 0 ? now : h.datetime;
              return `
                <button type="button" class="forecast-card ${i === 0 ? "active" : ""}" data-detail-hour="${i}" aria-label="Forecast for ${esc(timeLabel)}">
                  <div class="day">${esc(timeLabel)}</div>
                  <div class="icon">${this._getConditionIcon(h.condition, null, iconWhen)}</div>
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
              const condText = this._formatConditionText(d);
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
      sub = `${timeLabel} · ${this._formatConditionText(h)}`;
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
      sub = `${dayLabel} · ${this._formatConditionText(d)}`;
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

  _chartThemeColors() {
    const style = getComputedStyle(this);
    return {
      muted: style.getPropertyValue("--hw-muted").trim() || "#9b9b9b",
      border: style.getPropertyValue("--hw-border").trim() || "#252525",
      text: style.getPropertyValue("--hw-text").trim() || "#e1e1e1",
    };
  }

  _baseChartOptions(data) {
    const tc = this._chartThemeColors();
    return {
      chart: { type: "area", height: 320, toolbar: { show: false }, zoom: { enabled: false }, fontFamily: "inherit", background: "transparent" },
      dataLabels: { enabled: false },
      stroke: { curve: "smooth", width: 4 },
      fill: { type: "gradient", gradient: { opacityFrom: 0.25, opacityTo: 0.05 } },
      xaxis: {
        categories: data.map((d) => d.time),
        labels: { style: { colors: tc.muted }, trim: true, maxHeight: 36 },
        axisBorder: { show: false },
        axisTicks: { show: false },
      },
      grid: { borderColor: tc.border, strokeDashArray: 4, xaxis: { lines: { show: false } }, yaxis: { lines: { show: true } } },
      legend: { show: true, position: "top", horizontalAlign: "left", labels: { colors: tc.text } },
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

      const container = s.getElementById("maps-apex-chart") || s.getElementById("apex-chart-combined");
      if (!container) return;
      container.innerHTML = "";

      const chartHeight = Math.max(280, (container.clientHeight || 400) - 8);
      const tc = this._chartThemeColors();
      const chartTheme = this._getAppearance().mode === "light" ? "light" : "dark";

      const opts = {
        chart: {
          type: "line",
          height: chartHeight,
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
            style: { colors: tc.muted, fontSize: "10px" },
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
            style: { colors: tc.muted, fontSize: "11px" },
          },
          axisBorder: { show: false },
          axisTicks: { show: false },
        },
        grid: {
          borderColor: tc.border,
          strokeDashArray: 3,
          xaxis: { lines: { show: false } },
          yaxis: { lines: { show: true } },
        },
        title: { text: "", align: "left", style: { fontSize: "14px", fontWeight: 600, color: tc.text } },
        tooltip: { shared: true, intersect: false, custom: tooltip, theme: chartTheme },
        legend: {
          show: true,
          position: "top",
          horizontalAlign: "center",
          fontSize: "11px",
          labels: { colors: tc.muted },
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

  _isNwsPreamble(text) {
    const s = String(text || "").trim();
    if (!s) return true;
    if (/^[A-Z0-9]{4,8}\s/.test(s)) return true;
    if (/\bhas issued an?\s*$/i.test(s)) return true;
    if (/National Weather Service/i.test(s) && s.length < 120 && !/\b(at|until|hazard|warning for)\b/i.test(s)) return true;
    return false;
  }

  _parseNwsAlertDescription(raw) {
    const empty = { what: null, where: null, when: null, impacts: null, additional: null, other: [] };
    const knownKeys = new Set(["what", "where", "when", "impacts", "additional", "additional details", "hazard", "source"]);
    const assignField = (result, key, body) => {
      if (key === "what") result.what = body;
      else if (key === "where") result.where = body;
      else if (key === "when") result.when = body;
      else if (key === "impacts" || key === "hazard") result.impacts = result.impacts ? `${result.impacts} ${body}` : body;
      else if (key === "additional" || key === "additional details") result.additional = body;
      else result.other.push({ key, body });
    };
    const pushBullet = (result, body) => {
      if (!body || body === "&&" || this._isNwsPreamble(body)) return;
      if (!result.what) result.what = body;
      else result.other.push({ key: null, body });
    };
    const processLine = (result, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "&&") return;
      const dotIdx = trimmed.indexOf("...");
      if (dotIdx !== -1) {
        const key = trimmed.slice(0, dotIdx).trim().replace(/\./g, "").toLowerCase();
        const body = trimmed.slice(dotIdx + 3).trim().replace(/\s+/g, " ");
        if (knownKeys.has(key) && body) {
          assignField(result, key, body);
          return;
        }
      }
      pushBullet(result, trimmed.replace(/^\*\s*/, "").replace(/\s+/g, " ").trim());
    };
    if (!raw || !String(raw).trim()) return empty;
    const text = String(raw).trim().replace(/\s*&&\s*$/g, "").trim();
    const result = { ...empty, other: [] };
    const blocks = ("\n" + text).split(/\n\s*\*\s*/);
    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed || trimmed === "&&") continue;
      if (this._isNwsPreamble(trimmed)) continue;
      trimmed.split(/\n+/).forEach((line) => processLine(result, line));
    }
    if (result.what && this._isNwsPreamble(result.what)) {
      result.what = null;
    }
    if (!result.what && !result.where && !result.when && result.other.length === 0) {
      const fallback = text.replace(/\*\s*/g, "").replace(/\.\.\./g, ". ").replace(/\s+/g, " ").trim();
      if (fallback && !this._isNwsPreamble(fallback)) result.what = fallback;
    }
    return result;
  }

  _pickAlertMainBody(alert, parsed) {
    const headline = String(alert?.headline || "").trim();
    const candidates = [];
    if (parsed.what && !this._isNwsPreamble(parsed.what)) candidates.push(parsed.what);
    if (headline) candidates.push(headline);
    if (parsed.impacts) candidates.push(parsed.impacts);
    for (const entry of parsed.other || []) {
      if (entry?.body) candidates.push(entry.body);
    }
    if (parsed.additional) candidates.push(parsed.additional);
    const picked = candidates.find((c) => c && !this._isNwsPreamble(c));
    if (picked) return picked;
    const bullets = (parsed.other || []).map((o) => o.body).filter(Boolean);
    if (bullets.length >= 2) return `${bullets[0]} ${bullets[1]}`.trim();
    return bullets[0] || headline || parsed.what || "";
  }

  _getActiveAlertCount() {
    if (!this._alertsData || this._alertsData.error) return 0;
    return (this._alertsData.alerts || []).length;
  }

  _renderAlertsBadge() {
    const count = this._getActiveAlertCount();
    if (!count) return "";
    const label = count > 99 ? "99+" : String(count);
    return `<span class="alerts-badge" aria-hidden="true">${label}</span>`;
  }

  _ensureNwsAlertsLoaded() {
    if (!this._alertsData && !this._alertsLoading) {
      this._alertsLoading = true;
      this._fetchNwsAlerts();
    }
  }

  _renderAlerts() {
    this._ensureNwsAlertsLoaded();
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
      const parsed = this._parseNwsAlertDescription(descRaw);
      const esc = (s) => String(s).replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const mainBody = this._pickAlertMainBody(a, parsed);
      const extraParts = [];
      if (parsed.impacts && parsed.impacts !== mainBody) extraParts.push(parsed.impacts);
      if (parsed.additional && parsed.additional !== mainBody) extraParts.push(parsed.additional);
      parsed.other.forEach((o) => {
        if (o.body && o.body !== mainBody && !extraParts.includes(o.body)) extraParts.push(o.body);
      });
      const extraText = extraParts.join(" ");
      const isLong = extraText.length > 120 || mainBody.length > 160;
      const effective = a.effective ? new Date(a.effective).toLocaleString() : "—";
      const expires = a.expires ? new Date(a.expires).toLocaleString() : "—";
      const sev = String(a.event || "").toLowerCase();
      const sevClass = sev.includes("warning") ? "sev-warning" : sev.includes("watch") ? "sev-watch" : "sev-advisory";
      const sevLabel = sevClass.replace("sev-", "");
      const hasWhere = !!parsed.where;
      const hasWhen = !!parsed.when;
      const hasDetails = hasWhere || hasWhen || isLong || extraParts.length > 0;
      const detailSections = [];
      if (hasWhere) {
        detailSections.push(`<div class="alert-detail-section"><div class="alert-detail-label">Where</div><p class="alert-detail-value">${esc(parsed.where)}</p></div>`);
      }
      if (hasWhen) {
        detailSections.push(`<div class="alert-detail-section"><div class="alert-detail-label">When</div><p class="alert-detail-value">${esc(parsed.when)}</p></div>`);
      }
      if (isLong) {
        detailSections.push(`<div class="alert-detail-section alert-detail-section--text"><p class="alert-detail-value">${esc(extraText)}</p></div>`);
      }
      const detailsHtml = hasDetails ? `<div class="alert-details">${detailSections.join("")}</div>` : "";
      const footerHtml = `<footer class="alert-footer">
        <div><div class="alert-detail-label">Effective</div><p class="alert-detail-value">${esc(effective)}</p></div>
        <div><div class="alert-detail-label">Expires</div><p class="alert-detail-value">${esc(expires)}</p></div>
      </footer>`;
      return `<article class="alert-card ${sevClass}" data-alert-index="${i}">
        <header class="alert-card-head"${hasDetails ? ` data-alert-toggle="${i}"` : ""}>
          <span class="alert-severity-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">${severityIcon(sevClass)}</svg></span>
          <span class="alert-pill">${sevLabel.toUpperCase()}</span>
          <h3>${event}</h3>
          ${hasDetails ? `<button class="alert-expand" aria-label="Toggle details" data-alert-expand="${i}"><svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg></button>` : ""}
        </header>
        ${mainBody ? `<p class="alert-body">${esc(mainBody)}</p>` : ""}
        ${detailsHtml}
        ${footerHtml}
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
        if (this._currentView === "forecast") {
          this._patchAlertsBadge();
        } else {
          this._render();
        }
      })
      .catch((e) => {
        console.error("NWS alerts fetch failed:", e);
        this._alertsData = { alerts: [], error: String(e.message || e) };
        this._alertsLoading = false;
        if (this._currentView === "forecast") {
          this._patchAlertsBadge();
        } else {
          this._render();
        }
      });
  }

  _renderPanelHeader(title, eyebrow = "") {
    const eyebrowHtml = eyebrow
      ? `<div class="eyebrow">${eyebrow}</div>`
      : "";
    return `
      <header class="topbar">
        <button class="hamburger icon-btn" id="hamburger-btn" aria-label="Open Home Assistant sidebar">
          <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/></svg>
        </button>
        <section class="title-card">
          <div class="title-wrap">
            ${eyebrowHtml}
            <div class="title">${title}</div>
          </div>
        </section>
        <button type="button" class="topbar-back-btn" id="back-btn" aria-label="Back to dashboard" data-view="forecast">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          <span>Back to dashboard</span>
        </button>
      </header>
    `;
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
    const defaultNwsAlerts = { enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9, replay_on_time_based_forecast: true };
    const nwsAlerts = { ...defaultNwsAlerts, ...(this._settings.nws_alerts || {}) };
    const defaultTropicalAlerts = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9,
      min_threat_level: "watch", max_distance_miles: 500,
      announce_inside_cone: true, announce_threat_escalation: true,
      announce_new_storm: true, announce_outlook_development: true, outlook_min_probability: 40,
    };
    const tropicalAlerts = { ...defaultTropicalAlerts, ...(this._settings.tropical_alerts || {}) };
    const defaultTornadoAlerts = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9,
      only_affecting_home: true, max_distance_miles: 25, announce_cleared: false,
    };
    const tornadoAlerts = { ...defaultTornadoAlerts, ...(this._settings.tornado_alerts || {}) };
    const defaultEarthquakeAlerts = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9,
      min_magnitude: 4.0, max_distance_miles: 100, tsunami_priority: true,
      announce_updated: false, announce_cleared: false,
    };
    const earthquakeAlerts = { ...defaultEarthquakeAlerts, ...(this._settings.earthquake_alerts || {}) };
    const defaultVolcanoAlerts = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9,
      min_alert_level: "watch", announce_cleared: false,
    };
    const volcanoAlerts = { ...defaultVolcanoAlerts, ...(this._settings.volcano_alerts || {}) };
    const defaultWildfireAlerts = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9, announce_cleared: false,
    };
    const wildfireAlerts = { ...defaultWildfireAlerts, ...(this._settings.wildfire_alerts || {}) };
    const defaultAirQualityAlerts = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9, announce_cleared: false,
    };
    const airQualityAlerts = { ...defaultAirQualityAlerts, ...(this._settings.air_quality_alerts || {}) };
    const defaultEarthquakes = {
      enabled: true,
      min_magnitude: 2.5,
      radius_miles: 500,
      feed_type: "all_hour",
      tsunami_alert_enabled: true,
      map_show_worldwide: true,
      map_min_magnitude: 4.5,
      map_feed_type: "all_day",
    };
    const defaultHurricaneMonitoring = { enabled: true, zone_mode: "zone", alert_zone_mode: "zone", max_distance_miles: 500, min_threat_level: "monitor", outlook_min_probability: 40 };
    const hurricaneMonitoring = { ...defaultHurricaneMonitoring, ...(this._settings.hurricane_monitoring || {}) };
    const defaultTornadoMonitoring = { enabled: true, zone_mode: "zone", alert_zone_mode: "zone", only_affecting_home: true, max_distance_miles: 25 };
    const tornadoMonitoring = { ...defaultTornadoMonitoring, ...(this._settings.tornado_monitoring || {}) };
    const earthquakeMonitoring = { ...defaultEarthquakes, alert_zone_mode: "zone", ...(this._settings.earthquake_monitoring || this._settings.earthquakes || {}) };
    const normalizeEqWindow = (v) => {
      const t = String(v || "").toLowerCase();
      if (["all_hour", "all_day", "all_week", "all_month"].includes(t)) return t;
      if (t.endsWith("_hour")) return "all_hour";
      if (t.endsWith("_week")) return "all_week";
      if (t.endsWith("_month")) return "all_month";
      return "all_day";
    };
    const eqMapWindow = normalizeEqWindow(earthquakeMonitoring.map_feed_type);
    const defaultLightningMonitoring = { enabled: true, show_on_map: true, max_age_minutes: 60, max_strikes: 500, geofield_radius_miles: 100 };
    const lightningMonitoring = { ...defaultLightningMonitoring, ...(this._settings.lightning_monitoring || this._settings.lightning || {}) };
    const defaultVolcanoMonitoring = { enabled: true, zone_mode: "zone", alert_zone_mode: "zone", radius_miles: 500, min_alert_level: "advisory", map_show_all_volcanoes: true };
    const volcanoMonitoring = { ...defaultVolcanoMonitoring, ...(this._settings.volcano_monitoring || {}) };
    const defaultTravelMonitoring = { enabled: true, show_on_map: true, min_level: 1 };
    const travelMonitoring = { ...defaultTravelMonitoring, ...(this._settings.travel_monitoring || {}) };
    const defaultTravelAlerts = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9,
      min_level: 3, announce_level_changes: true, announce_new_advisories: true, watched_countries: [],
    };
    const travelAlerts = { ...defaultTravelAlerts, ...(this._settings.travel_alerts || {}) };
    const defaultWildfireMonitoring = { enabled: true, zone_mode: "zone", alert_zone_mode: "zone", radius_miles: 100, show_on_map: true, show_perimeters: true, min_acres: 100, exclude_prescribed: true };
    const wildfireMonitoring = { ...defaultWildfireMonitoring, ...(this._settings.wildfire_monitoring || {}) };
    const defaultAirQualityMonitoring = { enabled: true, zone_mode: "zone", alert_zone_mode: "zone", radius_miles: 50, show_on_map: true, min_category_level: 1 };
    const airQualityMonitoring = { ...defaultAirQualityMonitoring, ...(this._settings.air_quality_monitoring || {}) };
    const defaultSpaceMonitoring = {
      enabled: true, show_planets: true, show_dwarf_planets: true, show_moons: true,
      show_spacecraft: true, show_asteroids: true, show_comets: true,
      small_body_min_diameter_km: 0, log_scale_orbits: true,
    };
    const spaceMonitoring = { ...defaultSpaceMonitoring, ...(this._settings.space_monitoring || {}) };
    const defaultSolarWeatherMonitoring = { enabled: true, show_sunspot_regions: true, show_flare_events: true };
    const solarWeatherMonitoring = { ...defaultSolarWeatherMonitoring, ...(this._settings.solar_weather_monitoring || {}) };
    const defaultSpacecraftAlerts = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9,
      min_elevation_deg: 10, craft_ids: ["-255544"], announce_pass_start: true, announce_pass_peak: false,
    };
    const spacecraftAlerts = { ...defaultSpacecraftAlerts, ...(this._settings.spacecraft_alerts || {}) };
    const defaultSolarWeatherAlerts = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9,
      min_k_index: 5, min_g_scale: 1, min_xray_class: "M",
      announce_flare_events: true, announce_geomagnetic_storm: true,
    };
    const solarWeatherAlerts = { ...defaultSolarWeatherAlerts, ...(this._settings.solar_weather_alerts || {}) };
    const defaultNeoAlerts = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9,
      max_lunar_distances: 5, min_diameter_m: 100,
    };
    const neoAlerts = { ...defaultNeoAlerts, ...(this._settings.neo_alerts || {}) };
    const aqiLevelOptions = (selected) => [
      { value: 1, label: "Good and above (show all)" },
      { value: 2, label: "Moderate and above" },
      { value: 3, label: "Unhealthy for Sensitive Groups and above" },
      { value: 4, label: "Unhealthy and above" },
      { value: 5, label: "Very Unhealthy and above" },
      { value: 6, label: "Hazardous only" },
    ].map((opt) => `<option value="${opt.value}" ${Number(selected) === opt.value ? "selected" : ""}>${opt.label}</option>`).join("");
    if (!sunAlerts.sunrise_tts) sunAlerts.sunrise_tts = defaultSunAlerts.sunrise_tts;
    if (!sunAlerts.sunset_tts) sunAlerts.sunset_tts = defaultSunAlerts.sunset_tts;
    if (!sunAlerts.sunrise_automation) sunAlerts.sunrise_automation = defaultSunAlerts.sunrise_automation;
    if (!sunAlerts.sunset_automation) sunAlerts.sunset_automation = defaultSunAlerts.sunset_automation;
    
    // Track expanded sections — all collapsed by default
    if (!this._expandedSections) this._expandedSections = new Set();

    const chevronSvg = `<svg class="collapsible-chevron" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>`;
    const chevronBtn = (expanded = false) => `<button type="button" class="collapsible-toggle" aria-label="Toggle section" aria-expanded="${expanded ? "true" : "false"}">${chevronSvg}</button>`;

    const entityFriendlyName = (entityId, fallback = "New player") => {
      if (!entityId) return fallback;
      const st = this._hass?.states?.[entityId];
      const name = st?.attributes?.friendly_name;
      if (name) return String(name);
      return entityId.replace(/^media_player\./, "") || entityId;
    };
    
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

    const renderAlertAudioSection = (prefix, alerts, {
      sirenBtnId,
      alertBtnId,
      hintHtml = "",
      behaviorTitle = "",
      behaviorContent = "",
      afterBehaviorHtml = "",
    }) => `
      <div class="form-group">
        <label>Alert Sound</label>
        <select id="${prefix}-sound-file">
          <option value="">None</option>
          ${(this._wwwSounds || []).map((f) => `<option value="${f}" ${alerts.sound_file === f ? "selected" : ""}>${f}</option>`).join("")}
        </select>
      </div>
      <div class="form-row-inline">
        <div class="form-group">
          <label>Siren Volume</label>
          ${renderSlider(`${prefix}-sound-volume`, alerts.sound_volume, 0, 1, 0.05, "%")}
        </div>
        <div class="form-group">
          <label>TTS Volume</label>
          ${renderSlider(`${prefix}-tts-volume`, alerts.tts_volume, 0, 1, 0.05, "%")}
        </div>
      </div>
      ${hintHtml}
      ${behaviorTitle ? `<div class="subsection-title">${behaviorTitle}</div>` : ""}
      ${behaviorContent ? `<div class="toggle-group">${behaviorContent}</div>` : ""}
      ${afterBehaviorHtml}
      <div class="form-actions-row">
        <button type="button" class="test-tts-btn btn-secondary-test" id="${sirenBtnId}">Test siren</button>
        <button type="button" class="test-tts-btn" id="${alertBtnId}">Test alert</button>
      </div>
    `;
    
    const renderCollapsible = (id, title, subtitle, content, hasToggle = false, toggleId = "", toggleChecked = false, toggleAttrs = "", sectionClass = "", sectionStyle = "") => `
      <div class="collapsible-section ${this._expandedSections.has(id) ? "open" : ""} ${sectionClass}" data-section-id="${id}"${sectionStyle ? ` style="${sectionStyle}"` : ""}>
        <div class="collapsible-header">
          <div class="collapsible-header-left">
            ${hasToggle ? `
              <label class="toggle-switch" style="margin-right: 8px;">
                <input type="checkbox" id="${toggleId}" ${toggleChecked ? "checked" : ""} ${toggleAttrs}/>
                <span class="toggle-slider"></span>
              </label>
            ` : ""}
            <div>
              <div class="collapsible-title">${title}</div>
              ${subtitle ? `<div class="collapsible-subtitle">${subtitle}</div>` : ""}
            </div>
          </div>
          ${chevronBtn(this._expandedSections.has(id))}
        </div>
        <div class="collapsible-content">
          ${content}
        </div>
      </div>
    `;

    const renderNestedSection = (id, title, subtitle, content, hasToggle = false, toggleId = "", toggleChecked = false, toggleAttrs = "", sectionClass = "", sectionStyle = "") => `
      <div class="settings-panel">
        ${renderCollapsible(id, title, subtitle, content, hasToggle, toggleId, toggleChecked, toggleAttrs, sectionClass, sectionStyle)}
      </div>
    `;

    const renderMonitoringCard = (title, subtitle, content) => `
      <div class="settings-card monitoring-card">
        <div class="settings-card-title">${title}</div>
        <div class="settings-card-sub">${subtitle}</div>
        <div class="settings-form-grid">${content}</div>
      </div>
    `;

    const renderSettingsSection = (title, subtitle, content, hasToggle = false, toggleId = "", toggleChecked = false) => `
      <div class="settings-card">
        <div class="settings-card-header">
          <div>
            <div class="settings-card-title">${title}</div>
            ${subtitle ? `<div class="settings-card-sub">${subtitle}</div>` : ""}
          </div>
          ${hasToggle ? `
            <label class="toggle-switch" title="Enable ${title}">
              <input type="checkbox" id="${toggleId}" ${toggleChecked ? "checked" : ""}/>
              <span class="toggle-slider"></span>
            </label>
          ` : ""}
        </div>
        <div class="settings-card-body">${content}</div>
      </div>
    `;

    const renderMiniCollapsible = (id, title, content, optionalTag = "") => `
      <div class="collapsible-section collapsible-section--mini ${this._expandedSections.has(id) ? "open" : ""}" data-section-id="${id}">
        <div class="collapsible-header">
          <div class="collapsible-header-left">
            <div class="collapsible-title">${title}${optionalTag}</div>
          </div>
          ${chevronBtn(this._expandedSections.has(id))}
        </div>
        <div class="collapsible-content">
          ${content}
        </div>
      </div>
    `;

    const renderMediaPlayerCard = (m, i) => {
      const cardId = `media-player-${i}`;
      const title = entityFriendlyName(m.entity_id);
      const configured = m.tts_entity_id ? "Configured" : "Not configured";
      const subtitle = `${configured} · ${m.tts_entity_id ? m.tts_entity_id.replace(/^tts\./, "") : "No TTS"}`;
      const connectionBlock = `
        <div class="form-group">
          <label>Media Player *</label>
          <div class="media-player-controls">
            <select class="media-player-select" data-field="entity_id">
              ${mediaPlayerEntities.map((e) => `<option value="${e}" ${e === m.entity_id ? "selected" : ""}>${e}</option>`).join("")}
            </select>
            <button type="button" class="btn btn-secondary btn-icon" data-remove-media="${i}" aria-label="Remove player">Remove</button>
          </div>
        </div>
        <div class="form-group">
          <label>TTS Entity *</label>
          <select class="media-player-tts-entity" data-field="tts_entity_id">
            <option value="">-- Select TTS Entity --</option>
            ${ttsEntities.map((e) => `<option value="${e}" ${e === m.tts_entity_id ? "selected" : ""}>${e}</option>`).join("")}
          </select>
        </div>
      `;
      const playbackBlock = `
        <div class="media-player-playback-block">
          <div class="form-group">
            <label for="${cardId}-volume">Announcement volume</label>
            <div class="range-slider">
              <input type="range" id="${cardId}-volume" class="media-player-volume" data-field="volume" min="0" max="1" step="0.05" value="${m.volume || 0.6}" aria-label="Announcement volume for ${title}" aria-valuetext="${Math.round((m.volume || 0.6) * 100)} percent"/>
              <span class="range-value">${Math.round((m.volume || 0.6) * 100)}%</span>
            </div>
            <p class="form-hint">This speaker is set to this level for announcements, then returned to its previous volume automatically.</p>
          </div>
          <div class="playback-options-row">
            <div class="form-group">
              <label>Preroll (ms)</label>
              <input type="number" class="media-player-preroll" data-field="preroll_ms" min="0" max="2000" step="50" value="${m.preroll_ms ?? 150}"/>
            </div>
            <div class="settings-toggle-row">
              <span class="inline-toggle-label">Cache TTS</span>
              <label class="toggle-switch">
                <input type="checkbox" class="media-player-cache" data-field="cache" ${m.cache ? "checked" : ""}/>
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
        </div>
      `;
      const voiceBlock = `
        <div class="form-row-inline">
          <div class="form-group">
            <label>Language</label>
            <input type="text" class="media-player-language" data-field="language" placeholder="e.g. en, en-US" value="${m.language || ""}"/>
          </div>
          <div class="form-group">
            <label>Options (JSON)</label>
            <input type="text" class="media-player-options" data-field="options" placeholder='{"key": "value"}' value='${JSON.stringify(m.options || {}).replace(/'/g, "&#39;")}'/>
          </div>
        </div>
      `;
      const content = `
        <div class="media-player-card" data-index="${i}">
          ${renderMiniCollapsible(`${cardId}-connection`, "Connection", connectionBlock)}
          ${renderMiniCollapsible(`${cardId}-playback`, "Playback", playbackBlock)}
          ${renderMiniCollapsible(`${cardId}-voice`, "Voice options", voiceBlock, '<span class="optional-tag">Optional</span>')}
          <div class="media-player-actions">
            <button type="button" class="test-tts-btn" data-test-media="${i}" title="Play a short announcement at the configured volume">Test announcement</button>
          </div>
        </div>
      `;
      return `
        <div class="settings-panel settings-panel--player">
          ${renderCollapsible(cardId, title, subtitle, content)}
        </div>
      `;
    };

    const daysOfWeek = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    const dayLabels = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };

    const activePane = this._settingsPane || "general";
    const paneNav = [
      { id: "general", label: "General", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3l9 7h-3v9h-4v-6H10v6H6v-9H3l9-7z"/></svg>` },
      { id: "zones", label: "Alert Zones", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 2a8 8 0 110 16 8 8 0 010-16zm0 3a5 5 0 100 10 5 5 0 000-10zm0 2a3 3 0 110 6 3 3 0 010-6z"/></svg>` },
      { id: "monitoring", label: "Hazard Monitoring", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>` },
      { id: "space", label: "Space", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7 7 7 0 01-7 7h-4a7 7 0 01-7-7 7 7 0 017-7h1V5.73A2 2 0 0112 2zm-1 9a1 1 0 100 2 1 1 0 000-2zm2 0a1 1 0 100 2 1 1 0 000-2z"/></svg>` },
      { id: "safety", label: "Safety", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>` },
      { id: "announcements", label: "Announcements", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 00-2.5-4.03v8.05A4.5 4.5 0 0016.5 12zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>` },
      { id: "appearance", label: "Appearance", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a9 9 0 000 18c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.39-.61-.39-.99 0-.83.67-1.5 1.5-1.5H16a5 5 0 005-5c0-4.42-4.03-8-9-8zm-5.5 9a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm3-4a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm5 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm3.5 4a1.5 1.5 0 110-3 1.5 1.5 0 010 3z"/></svg>` },
      { id: "advanced", label: "Advanced", icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 00.12-.61l-1.92-3.32a.488.488 0 00-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 00-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94 0 .31.02.64.07.94l-2.03 1.58a.49.49 0 00-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>` },
    ];
    const threatOptions = (selected) => ["none", "monitor", "watch", "high"]
      .map((v) => `<option value="${v}" ${selected === v ? "selected" : ""}>${v.charAt(0).toUpperCase() + v.slice(1)}</option>`).join("");
    const volcanoLevelOptions = (selected) => ["advisory", "watch", "warning"]
      .map((v) => `<option value="${v}" ${selected === v ? "selected" : ""}>${v.charAt(0).toUpperCase() + v.slice(1)}</option>`).join("");
    const travelLevelOptions = (selected) => [
      { v: 1, label: "Level 1 — Exercise Normal Precautions" },
      { v: 2, label: "Level 2 — Exercise Increased Caution" },
      { v: 3, label: "Level 3 — Reconsider Travel" },
      { v: 4, label: "Level 4 — Do Not Travel" },
    ].map(({ v, label }) => `<option value="${v}" ${Number(selected) === v ? "selected" : ""}>${label}</option>`).join("");
    const resolveSensorMode = (block) => (block?.zone_mode === "all" ? "all" : "zone");
    const resolveAlertMode = (block) => ((block?.alert_zone_mode ?? block?.zone_mode) === "all" ? "all" : "zone");
    const zoneHazards = [
      { key: "hurricane", label: "Hurricane", icon: "hurricane", color: "#29b6f6", enabledId: "hurricane-monitoring-enabled", radiusId: "hurricane-monitoring-max-distance", radius: hurricaneMonitoring.max_distance_miles, min: 1, max: 5000, enabled: hurricaneMonitoring.enabled !== false, hasAlerts: true, sensorMode: resolveSensorMode(hurricaneMonitoring), alertMode: resolveAlertMode(hurricaneMonitoring), desc: "Storms within this radius drive hurricane sensors and alerts.", thresholds: `
        <div class="zone-card-field">
          <label for="hurricane-monitoring-min-threat">Min threat level</label>
          <select id="hurricane-monitoring-min-threat">${threatOptions(hurricaneMonitoring.min_threat_level)}</select>
        </div>
        <div class="zone-card-field">
          <label for="hurricane-monitoring-outlook-prob">Outlook min probability (%)</label>
          <input type="number" id="hurricane-monitoring-outlook-prob" min="0" max="100" step="1" value="${Math.round(hurricaneMonitoring.outlook_min_probability ?? 40)}"/>
        </div>` },
      { key: "tornado", label: "Tornado", icon: "tornado", color: "#e040fb", enabledId: "tornado-monitoring-enabled", radiusId: "tornado-monitoring-max-distance", radius: tornadoMonitoring.max_distance_miles, min: 1, max: 500, enabled: tornadoMonitoring.enabled !== false, hasAlerts: true, sensorMode: resolveSensorMode(tornadoMonitoring), alertMode: resolveAlertMode(tornadoMonitoring), desc: "Warning polygons within this radius trigger tornado sensors and alerts.", thresholds: `
        <div class="zone-card-field zone-card-field--toggle">
          <label for="tornado-monitoring-only-home">Only when polygon includes home</label>
          <label class="toggle-switch">
            <input type="checkbox" id="tornado-monitoring-only-home" ${tornadoMonitoring.only_affecting_home !== false ? "checked" : ""}/>
            <span class="toggle-slider"></span>
          </label>
        </div>` },
      { key: "earthquake", label: "Earthquake", icon: "earthquake", color: "#ffa726", enabledId: "earthquake-monitoring-enabled", radiusId: "earthquake-radius-miles", radius: earthquakeMonitoring.radius_miles, min: 1, max: 5000, enabled: earthquakeMonitoring.enabled !== false, hasAlerts: true, sensorMode: resolveSensorMode(earthquakeMonitoring), alertMode: resolveAlertMode(earthquakeMonitoring), desc: "Quakes inside this radius count as nearby for sensors and alerts.", thresholds: `
        <div class="zone-card-field">
          <label for="earthquake-min-magnitude">Min magnitude</label>
          <input type="number" id="earthquake-min-magnitude" min="0" max="10" step="0.1" value="${earthquakeMonitoring.min_magnitude ?? 2.5}"/>
        </div>` },
      { key: "lightning", label: "Lightning", icon: "lightning-bolt", color: "#ffee58", enabledId: "lightning-monitoring-enabled", radiusId: "lightning-geofield-radius-miles", radius: lightningMonitoring.geofield_radius_miles ?? 100, min: 1, max: 500, enabled: lightningMonitoring.enabled !== false, hasAlerts: false, sensorMode: resolveSensorMode(lightningMonitoring), desc: "Live strikes inside this radius feed lightning sensors." },
      { key: "volcano", label: "Volcano", icon: "volcano", color: "#ff7043", enabledId: "volcano-monitoring-enabled", radiusId: "volcano-radius-miles", radius: volcanoMonitoring.radius_miles ?? 500, min: 1, max: 5000, enabled: volcanoMonitoring.enabled !== false, hasAlerts: true, sensorMode: resolveSensorMode(volcanoMonitoring), alertMode: resolveAlertMode(volcanoMonitoring), desc: "Active volcanoes inside this radius count as nearby for sensors and alerts.", thresholds: `
        <div class="zone-card-field">
          <label for="volcano-min-alert-level">Min activity level</label>
          <select id="volcano-min-alert-level">${volcanoLevelOptions(volcanoMonitoring.min_alert_level)}</select>
        </div>` },
      { key: "wildfire", label: "Wildfire", icon: "fire", color: "#ff5722", enabledId: "wildfire-monitoring-enabled", radiusId: "wildfire-radius-miles", radius: wildfireMonitoring.radius_miles ?? 100, min: 1, max: 500, enabled: wildfireMonitoring.enabled !== false, hasAlerts: true, sensorMode: resolveSensorMode(wildfireMonitoring), alertMode: resolveAlertMode(wildfireMonitoring), desc: "Wildfires inside this radius count as nearby for sensors and alerts.", thresholds: `
        <div class="zone-card-field">
          <label for="wildfire-min-acres">Min fire size (acres)</label>
          <input type="number" id="wildfire-min-acres" min="0" max="1000000" step="1" value="${wildfireMonitoring.min_acres ?? 100}"/>
        </div>` },
      { key: "air_quality", label: "Air Quality", icon: "air-quality", color: "#42a5f5", enabledId: "air-quality-monitoring-enabled", radiusId: "air-quality-radius-miles", radius: airQualityMonitoring.radius_miles ?? 50, min: 1, max: 500, enabled: airQualityMonitoring.enabled !== false, hasAlerts: true, sensorMode: resolveSensorMode(airQualityMonitoring), alertMode: resolveAlertMode(airQualityMonitoring), desc: "Reporting areas inside this radius drive air quality sensors and alerts.", thresholds: `
        <div class="zone-card-field">
          <label for="air-quality-min-level">Min category level</label>
          <select id="air-quality-min-level">${aqiLevelOptions(airQualityMonitoring.min_category_level ?? 1)}</select>
        </div>` },
    ];
    const renderZoneCard = (z) => `
      <div class="zone-card ${z.enabled ? "" : "is-disabled"}" data-zone-card="${z.key}" style="--zone-color:${z.color}">
        <div class="zone-card-head">
          <img src="/local/home_weather/icons/${z.icon}.svg" alt="" draggable="false"/>
          <span class="zone-card-title">${z.label}</span>
          <label class="toggle-switch" title="Enable ${z.label} monitoring">
            <input type="checkbox" id="${z.enabledId}" data-zone-card-enabled="${z.key}" ${z.enabled ? "checked" : ""}/>
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="zone-card-body">
          <p class="form-hint zone-card-desc">${z.desc}</p>
          <div class="zone-card-field">
            <label for="${z.radiusId}">Zone radius (miles)</label>
            <input type="number" id="${z.radiusId}" min="${z.min}" max="${z.max}" step="1" value="${Math.round(z.radius)}"/>
          </div>
          ${z.thresholds || ""}
          <div class="zone-card-field">
            <span>Sensor scope</span>
            <div class="zone-mode-seg" data-scope-for="${z.key}-sensor" role="group" aria-label="${z.label} sensor scope">
              <button type="button" data-mode="zone" class="${z.sensorMode === "zone" ? "active" : ""}">Use zone</button>
              <button type="button" data-mode="all" class="${z.sensorMode === "all" ? "active" : ""}">Bypass</button>
            </div>
            <p class="zone-card-note" data-scope-note-for="${z.key}-sensor" style="${z.sensorMode === "all" ? "" : "display:none"}">Bypass active — sensors use all ${z.label.toLowerCase()} data regardless of distance and thresholds.</p>
          </div>
          ${z.hasAlerts ? `
          <div class="zone-card-field">
            <span>Alert scope</span>
            <div class="zone-mode-seg" data-scope-for="${z.key}-alert" role="group" aria-label="${z.label} alert scope">
              <button type="button" data-mode="zone" class="${z.alertMode === "zone" ? "active" : ""}">Use zone</button>
              <button type="button" data-mode="all" class="${z.alertMode === "all" ? "active" : ""}">Bypass</button>
            </div>
            <p class="zone-card-note" data-scope-note-for="${z.key}-alert" style="${z.alertMode === "all" ? "" : "display:none"}">Bypass active — spoken alerts use all ${z.label.toLowerCase()} data regardless of distance and thresholds.</p>
          </div>` : ""}
        </div>
      </div>`;

    const monitoringHazards = [
      {
        key: "tornado",
        label: "Tornado",
        color: "#e040fb",
        desc: "Zone and alerts",
        content: `<p class="form-hint">Tornado warnings use your home location with the radius, thresholds, and scope from <strong>Alert Zones</strong> (Use zone or Bypass). Spoken alert behavior is in <strong>Announcements</strong>.</p>`,
      },
      {
        key: "earthquake",
        label: "Earthquake",
        color: "#ffa726",
        desc: "USGS seismic data and map display",
        content: `
          <p class="form-hint">Nearby alerts and sensors always use real-time seismic data within your earthquake zone. Magnitude and radius live in <strong>Alert Zones</strong>. The settings below control the hazard map display.</p>
          <div class="form-group">
            <label>Map time window</label>
            <select id="earthquake-map-window">
              <option value="all_hour" ${eqMapWindow === "all_hour" ? "selected" : ""}>Past hour</option>
              <option value="all_day" ${eqMapWindow === "all_day" ? "selected" : ""}>Past 24 hours</option>
              <option value="all_week" ${eqMapWindow === "all_week" ? "selected" : ""}>Past week</option>
              <option value="all_month" ${eqMapWindow === "all_month" ? "selected" : ""}>Past month</option>
            </select>
            <p class="form-hint">How far back the map shows earthquakes. Default is the past 24 hours.</p>
          </div>
          ${renderToggle("earthquake-map-worldwide", earthquakeMonitoring.map_show_worldwide !== false, "Show worldwide seismic activity on map")}
          <div class="form-group">
            <label>Map minimum magnitude</label>
            <input type="number" id="earthquake-map-min-magnitude" min="0" max="10" step="0.1" value="${earthquakeMonitoring.map_min_magnitude ?? 4.5}"/>
            <p class="form-hint">Hide quakes weaker than this on the map.</p>
          </div>
          <div class="inline-toggle">
            <span class="inline-toggle-label">Tsunami alerts</span>
            <label class="toggle-switch">
              <input type="checkbox" id="earthquake-tsunami-enabled" ${earthquakeMonitoring.tsunami_alert_enabled !== false ? "checked" : ""}/>
              <span class="toggle-slider"></span>
            </label>
          </div>`,
      },
      {
        key: "lightning",
        label: "Lightning",
        color: "#ffee58",
        desc: "Live Blitzortung strike tracking",
        content: `
          <p class="form-hint">Map markers require both tracking enabled (in Alert Zones) and the Lightning layer on the hazard map. Data from <a href="https://www.blitzortung.org" target="_blank" rel="noopener noreferrer">Blitzortung.org</a>.</p>
          ${renderToggle("lightning-show-on-map", lightningMonitoring.show_on_map !== false, "Show live lightning on hazard map")}
          <div class="form-group">
            <label>Strike retention (minutes)</label>
            <input type="number" id="lightning-max-age-minutes" min="5" max="240" value="${lightningMonitoring.max_age_minutes ?? 60}"/>
            <p class="form-hint">How long strike markers stay visible on the map.</p>
          </div>`,
      },
      {
        key: "volcano",
        label: "Volcano",
        color: "#ff7043",
        desc: "Worldwide activity from GVP, GDACS, and USGS",
        content: `
          <p class="form-hint">Sensors track active volcanoes inside your volcano zone using the min activity level set in <strong>Alert Zones</strong>. Sources: Smithsonian GVP catalog, GDACS live alerts, and USGS HANS.</p>
          <p class="form-hint">Every worldwide volcano is plotted on the hazard map: dormant volcanoes appear as dim catalog points, while active ones glow with their alert color and show affected-area rings. Toggle the Volcano layer from the map's layer menu to hide them all.</p>`,
      },
      {
        key: "wildfire",
        label: "Wildfires",
        color: "#ff5722",
        desc: "NIFC WFIGS active/ongoing incidents",
        content: `
          <p class="form-hint">Live U.S. wildfire data from the National Interagency Fire Center <a href="https://data-nifc.opendata.arcgis.com/" target="_blank" rel="noopener noreferrer">WFIGS</a> program (no API key). Only currently active and ongoing fires are tracked. Incident points and fire perimeters appear on the hazard map; click for size, containment, and location details.</p>
          <p class="form-hint">Zone radius, minimum fire size, and alert scope are set on the Wildfire card in <strong>Alert Zones</strong>.</p>
          ${renderToggle("wildfire-show-on-map", wildfireMonitoring.show_on_map !== false, "Show wildfires on hazard map")}
          ${renderToggle("wildfire-show-perimeters", wildfireMonitoring.show_perimeters !== false, "Show fire perimeters on map")}
          ${renderToggle("wildfire-exclude-prescribed", wildfireMonitoring.exclude_prescribed !== false, "Exclude prescribed burns (RX)")}`,
      },
      {
        key: "air_quality",
        label: "Air Quality",
        color: "#42a5f5",
        desc: "EPA AirNow reporting-area observations",
        content: `
          <p class="form-hint">Real-time air quality from the EPA <a href="https://www.airnow.gov/" target="_blank" rel="noopener noreferrer">AirNow</a> reporting-area file (no API key). Colors follow the standard EPA AQI scale.</p>
          <p class="form-hint">Zone radius, minimum category level, and alert scope are set on the Air Quality card in <strong>Alert Zones</strong>.</p>
          ${renderToggle("air-quality-show-on-map", airQualityMonitoring.show_on_map !== false, "Show air quality on hazard map")}`,
      },
    ];

    const renderMonitoringSection = (m) => renderNestedSection(
      `monitoring-${m.key}`,
      m.label,
      m.desc,
      `<div class="settings-form-grid">${m.content}</div>`,
      false,
      "",
      false,
      "",
      "collapsible-section--zone",
      `--zone-color:${m.color}`,
    );

    const spaceSections = [
      {
        key: "map-layers",
        label: "Space Map",
        color: "#64b5f6",
        desc: "3D solar system layers and map display",
        content: `
          <p class="form-hint">Open the Space Map from the top bar. Layer toggles also appear in the Space Map menubar.</p>
          ${renderToggle("space-monitoring-enabled", spaceMonitoring.enabled !== false, "Enable Space Map data")}
          ${renderToggle("space-show-planets", spaceMonitoring.show_planets !== false, "Show planets")}
          ${renderToggle("space-show-dwarf-planets", spaceMonitoring.show_dwarf_planets !== false, "Show dwarf planets")}
          ${renderToggle("space-show-moons", spaceMonitoring.show_moons !== false, "Show natural moons")}
          ${renderToggle("space-show-spacecraft", spaceMonitoring.show_spacecraft !== false, "Show spacecraft")}
          ${renderToggle("space-show-asteroids", spaceMonitoring.show_asteroids !== false, "Show asteroids / NEOs")}
          ${renderToggle("space-show-comets", spaceMonitoring.show_comets !== false, "Show comets")}
          ${renderToggle("space-log-scale", spaceMonitoring.log_scale_orbits !== false, "Log-scale orbits (easier to see inner planets)")}
          <div class="form-group">
            <label for="space-min-diameter-km">Min small-body diameter (km, 0 = all)</label>
            <input type="number" id="space-min-diameter-km" min="0" max="1000" step="0.1" value="${spaceMonitoring.small_body_min_diameter_km ?? 0}"/>
          </div>`,
      },
      {
        key: "solar-display",
        label: "Solar Weather View",
        color: "#ffb74d",
        desc: "Sun disk overlays from NOAA SWPC",
        content: `
          <p class="form-hint">Sunspot regions, K-index, flux, and imagery from <a href="https://www.swpc.noaa.gov/" target="_blank" rel="noopener noreferrer">NOAA SWPC</a>. Live values also appear as Home Assistant sensors.</p>
          ${renderToggle("solar-weather-monitoring-enabled", solarWeatherMonitoring.enabled !== false, "Enable solar weather data")}
          ${renderToggle("solar-show-regions", solarWeatherMonitoring.show_sunspot_regions !== false, "Show active sunspot regions")}
          ${renderToggle("solar-show-flares", solarWeatherMonitoring.show_flare_events !== false, "Show flare events")}`,
      },
      {
        key: "spacecraft-tracking",
        label: "Spacecraft Tracking",
        color: "#81c784",
        desc: "Overhead pass detection for sensors and automations",
        content: `
          <p class="form-hint">Controls the <strong>Spacecraft Overhead</strong> binary sensor and pass elevation/azimuth sensors. Spoken pass alerts are in <strong>Announcements</strong>.</p>
          <div class="form-group">
            <label for="spacecraft-min-elevation">Minimum elevation (°)</label>
            <input type="number" id="spacecraft-min-elevation" min="0" max="90" step="1" value="${spacecraftAlerts.min_elevation_deg ?? 10}"/>
            <p class="form-hint">Passes below this elevation are ignored.</p>
          </div>
          <div class="form-group">
            <label for="spacecraft-craft-ids">Horizons craft IDs (comma-separated)</label>
            <input type="text" id="spacecraft-craft-ids" placeholder="-255544" value="${(spacecraftAlerts.craft_ids || ["-255544"]).join(", ")}"/>
            <p class="form-hint">Default <code>-255544</code> is the International Space Station.</p>
          </div>`,
      },
      {
        key: "neo-monitoring",
        label: "NEO Close Approaches",
        color: "#ce93d8",
        desc: "Proximity thresholds for NEO sensors",
        content: `
          <p class="form-hint">Controls the <strong>NEO Close Approach Soon</strong> binary sensor and closest-NEO sensors. Spoken flyby alerts are in <strong>Announcements</strong>.</p>
          <div class="form-group">
            <label for="neo-max-lunar-distances">Maximum lunar distances (LD)</label>
            <input type="number" id="neo-max-lunar-distances" min="0.1" max="100" step="0.1" value="${neoAlerts.max_lunar_distances ?? 5}"/>
          </div>
          <div class="form-group">
            <label for="neo-min-diameter-m">Minimum diameter (m)</label>
            <input type="number" id="neo-min-diameter-m" min="0" max="100000" step="1" value="${neoAlerts.min_diameter_m ?? 100}"/>
          </div>`,
      },
    ];

    const renderSpaceSection = (section) => renderNestedSection(
      `space-${section.key}`,
      section.label,
      section.desc,
      `<div class="settings-form-grid">${section.content}</div>`,
      false,
      "",
      false,
      "",
      "collapsible-section--zone",
      `--zone-color:${section.color}`,
    );

    return `
      <div class="settings-form">
        <div class="settings-shell">
          <nav class="settings-sidenav" aria-label="Settings sections">
            ${paneNav.map((p) => `<button type="button" class="${activePane === p.id ? "active" : ""}" data-settings-pane="${p.id}">${p.icon}<span>${p.label}</span></button>`).join("")}
          </nav>
          <div class="settings-content">

            <section class="settings-pane ${activePane === "general" ? "active" : ""}" data-settings-pane="general">
              <div class="settings-pane-head">
                <div class="settings-pane-title">General</div>
                <div class="settings-pane-sub">Data source for the whole integration.</div>
              </div>
              ${renderNestedSection("general-weather-source", "Weather Source", "Required weather entity", `
                <div class="form-group">
                  <label id="weather-entity-label">Weather Entity</label>
                  ${this._renderWeatherEntitySelect(this._settings.weather_entity || "")}
                  <p class="form-hint">Required. Must support hourly and daily forecasts.</p>
                </div>
              `)}
              ${renderNestedSection("general-about", "About", "Version and integration info", `
                <p class="form-hint" style="margin:0 0 16px 0;">Home Weather integration. Configure alert zones, hazard monitoring, and announcements from the sidebar.</p>
                <div class="version-section">
                  <div class="version-section-content">${this._buildVersionSectionContent()}</div>
                </div>
              `)}
            </section>

            <section class="settings-pane ${activePane === "zones" ? "active" : ""}" data-settings-pane="zones">
              <div class="settings-pane-head">
                <div class="settings-pane-title">Alert Zones</div>
                <div class="settings-pane-sub">Set the radius around your home for each hazard. Scope controls whether sensors and spoken alerts use the zone or bypass it for all data.</div>
              </div>
              <div class="zone-editor-cta">
                <div class="zone-editor-cta-text">
                  <div class="zone-editor-cta-title">Edit zones on the map</div>
                  <div class="zone-editor-cta-sub">Drag each hazard's radius around your home visually with live distance readouts.</div>
                </div>
                <button type="button" class="btn btn-primary" id="open-zone-editor-btn">Open map editor</button>
              </div>
              <div class="zone-cards">
                ${zoneHazards.map(renderZoneCard).join("")}
              </div>
            </section>

            <section class="settings-pane ${activePane === "monitoring" ? "active" : ""}" data-settings-pane="monitoring">
              <div class="settings-pane-head">
                <div class="settings-pane-title">Hazard Monitoring</div>
                <div class="settings-pane-sub">Data-source and map-quality filters per hazard. Zone radius, thresholds, and sensor/alert scope live in <strong>Alert Zones</strong>; spoken alert sounds and behavior live in <strong>Announcements</strong>.</div>
              </div>
              ${monitoringHazards.map(renderMonitoringSection).join("")}
            </section>

            <section class="settings-pane ${activePane === "safety" ? "active" : ""}" data-settings-pane="safety">
              <div class="settings-pane-head">
                <div class="settings-pane-title">Safety</div>
                <div class="settings-pane-sub">Travel advisory data sources. Spoken travel alerts are configured in <strong>Announcements</strong>.</div>
              </div>
              ${renderNestedSection("travel-monitoring", "U.S. Travel Advisories", "State Department worldwide threat levels", `
                <p class="form-hint">Live data from the U.S. Department of State <a href="https://travel.state.gov/content/travel/en/rss.html" target="_blank" rel="noopener noreferrer">Travel Advisories</a> program. Countries are color-coded on the hazard map by threat level (1–4). Click a country for details.</p>
                ${renderToggle("travel-show-on-map", travelMonitoring.show_on_map !== false, "Show travel advisories on hazard map")}
                <div class="form-group">
                  <label>Minimum map level</label>
                  <select id="travel-map-min-level">${travelLevelOptions(travelMonitoring.min_level ?? 1)}</select>
                  <p class="form-hint">Only color countries at or above this advisory level on the map.</p>
                </div>
                <div class="form-hint" style="margin-top:8px;">
                  <strong>Level 1</strong> Normal precautions ·
                  <strong>Level 2</strong> Increased caution ·
                  <strong>Level 3</strong> Reconsider travel ·
                  <strong>Level 4</strong> Do not travel
                </div>
              `, true, "travel-monitoring-enabled", travelMonitoring.enabled !== false)}
            </section>

            <section class="settings-pane ${activePane === "space" ? "active" : ""}" data-settings-pane="space">
              <div class="settings-pane-head">
                <div class="settings-pane-title">Space Map</div>
                <div class="settings-pane-sub">Map layers, solar weather display, and sensor thresholds. Spoken space alerts are configured in <strong>Announcements</strong>.</div>
              </div>
              ${spaceSections.map(renderSpaceSection).join("")}
            </section>

            <section class="settings-pane ${activePane === "announcements" ? "active" : ""}" data-settings-pane="announcements">
              <div class="settings-pane-head">
                <div class="settings-pane-title">Announcements</div>
                <div class="settings-pane-sub">Spoken forecasts and hazard alerts, including space and travel advisories. Configure media players and enable alert types below.</div>
              </div>

          ${renderNestedSection("general", "Message Intro", "Opening phrase spoken before forecasts", `
            <div class="form-group">
              <label>Intro Message</label>
              <input type="text" id="message-prefix" placeholder="Here's your weather forecast" value="${messagePrefix}"/>
              <p class="form-hint">Time is announced automatically before your intro.</p>
            </div>
          `)}

          ${renderNestedSection("media-players", "Media Players", `${mediaPlayers.length} configured`, `
            <p class="form-hint">Each media player has its own TTS settings, volume, and options.</p>
            <div class="media-player-list" id="media-player-list">
              ${mediaPlayers.map((m, i) => renderMediaPlayerCard(m, i)).join("")}
            </div>
            <div class="form-row media-player-add-row">
              <select id="media-player-add">
                <option value="">Add media player...</option>
                ${availableMediaPlayers.map((e) => `<option value="${e}">${e}</option>`).join("")}
              </select>
              <button type="button" class="btn btn-secondary" id="add-media-btn">Add</button>
            </div>
          `)}

          ${renderNestedSection("time-based", "Scheduled Forecasts", "Time-based announcements", `
            <div class="form-row-inline">
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
                <label>Minute Offset</label>
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
          `, true, "enable-time-based", tts.enable_time_based)}

          ${renderNestedSection("current-change", "Current Condition Alerts", "Speak when weather changes", `
            <p class="form-hint">Triggered when the weather condition changes (e.g. sunny → cloudy).</p>
            <div class="form-actions-row">
              <button type="button" class="test-tts-btn" id="test-current-change-btn">Test alert</button>
            </div>
          `, true, "enable-current-change", tts.enable_current_change)}

          ${renderNestedSection("upcoming-change", "Upcoming Weather Alerts", "Heads-up before rain or snow", `
            <div class="form-group">
              <label>Alert Lead Time</label>
              <select id="minutes-before-announce">
                <option value="15" ${tts.minutes_before_announce === 15 ? "selected" : ""}>15 minutes</option>
                <option value="30" ${tts.minutes_before_announce === 30 ? "selected" : ""}>30 minutes</option>
                <option value="45" ${tts.minutes_before_announce === 45 ? "selected" : ""}>45 minutes</option>
                <option value="60" ${tts.minutes_before_announce === 60 ? "selected" : ""}>1 hour</option>
              </select>
              <p class="form-hint">How far ahead to warn about precipitation.</p>
            </div>
            <div class="form-actions-row">
              <button type="button" class="test-tts-btn" id="test-upcoming-change-btn">Test alert</button>
            </div>
          `, true, "enable-upcoming-change", tts.enable_upcoming_change)}

          ${renderNestedSection("sun-alerts", "Sunrise &amp; Sunset", "TTS and automations at dawn/dusk", `
            <div class="subsection-block">
              <div class="subsection-title">Sunrise</div>
              ${renderToggle("sunrise-tts-enabled", sunAlerts.sunrise_tts.enabled, "Announce sunrise")}
              <div class="form-row-inline">
                <div class="form-group">
                  <label>Minutes before</label>
                  <input type="number" id="sunrise-minutes-before" min="5" max="60" value="${sunAlerts.sunrise_tts.minutes_before}"/>
                </div>
                <div class="form-group">
                  <label>Repeat interval</label>
                  <input type="number" id="sunrise-interval-minutes" min="1" max="30" value="${sunAlerts.sunrise_tts.interval_minutes}"/>
                </div>
              </div>
              ${renderToggle("sunrise-automation-enabled", sunAlerts.sunrise_automation.enabled, "Trigger automation")}
              <div class="form-group">
                <label>Automation Entity</label>
                ${this._renderEntityAutocomplete("sunrise-automation-entity", sunAlerts.sunrise_automation.entity_id || "", "automation", "Search automations...")}
              </div>
            </div>
            <div class="subsection-block">
              <div class="subsection-title">Sunset</div>
              ${renderToggle("sunset-tts-enabled", sunAlerts.sunset_tts.enabled, "Announce sunset")}
              <div class="form-row-inline">
                <div class="form-group">
                  <label>Minutes before</label>
                  <input type="number" id="sunset-minutes-before" min="5" max="60" value="${sunAlerts.sunset_tts.minutes_before}"/>
                </div>
                <div class="form-group">
                  <label>Repeat interval</label>
                  <input type="number" id="sunset-interval-minutes" min="1" max="30" value="${sunAlerts.sunset_tts.interval_minutes}"/>
                </div>
              </div>
              ${renderToggle("sunset-automation-enabled", sunAlerts.sunset_automation.enabled, "Trigger automation")}
              <div class="form-group">
                <label>Automation Entity</label>
                ${this._renderEntityAutocomplete("sunset-automation-entity", sunAlerts.sunset_automation.entity_id || "", "automation", "Search automations...")}
              </div>
            </div>
            <div class="form-actions-row">
              <button type="button" class="test-tts-btn" id="test-sunrise-btn">Test sunrise</button>
              <button type="button" class="test-tts-btn btn-secondary-test" id="test-sunset-btn">Test sunset</button>
            </div>
          `, true, "sun-alerts-enabled", sunAlerts.enabled)}

          ${renderNestedSection("nws-alerts", "NWS Weather Alerts", "National Weather Service warnings", `
            ${renderAlertAudioSection("nws-alerts", nwsAlerts, {
              sirenBtnId: "test-nws-siren-btn",
              alertBtnId: "test-nws-btn",
              behaviorTitle: "Behavior",
              behaviorContent: renderToggle("nws-alerts-replay-forecast", nwsAlerts.replay_on_time_based_forecast !== false, "Replay active alerts after scheduled forecasts"),
            })}
          `, true, "nws-alerts-enabled", nwsAlerts.enabled)}

          ${renderNestedSection("tropical-alerts", "Hurricane Alerts", "Nearby storm warnings", `
            ${renderAlertAudioSection("tropical-alerts", tropicalAlerts, {
              sirenBtnId: "test-tropical-siren-btn",
              alertBtnId: "test-tropical-btn",
              behaviorTitle: "Announce When",
              behaviorContent: `
                ${renderToggle("tropical-announce-cone", tropicalAlerts.announce_inside_cone !== false, "Home enters forecast cone")}
                ${renderToggle("tropical-announce-escalation", tropicalAlerts.announce_threat_escalation !== false, "Threat level escalates")}
                ${renderToggle("tropical-announce-new-storm", tropicalAlerts.announce_new_storm !== false, "New nearby hurricane detected")}
                ${renderToggle("tropical-announce-outlook", tropicalAlerts.announce_outlook_development !== false, "Outlook development")}
              `,
              afterBehaviorHtml: `<p class="form-hint">Threat level, outlook probability, distance, and alert scope are set on the Hurricane card in <strong>Alert Zones</strong>.</p>`,
            })}
          `, true, "tropical-alerts-enabled", tropicalAlerts.enabled)}

          ${renderNestedSection("tornado-alerts", "Tornado Alerts", "Tornado warning announcements", `
            ${renderAlertAudioSection("tornado-alerts", tornadoAlerts, {
              sirenBtnId: "test-tornado-siren-btn",
              alertBtnId: "test-tornado-btn",
              behaviorTitle: "Behavior",
              behaviorContent: renderToggle("tornado-announce-cleared", tornadoAlerts.announce_cleared === true, "Announce when warning clears"),
            })}
          `, true, "tornado-alerts-enabled", tornadoAlerts.enabled)}

          ${renderNestedSection("earthquake-alerts", "Earthquake Alerts", "Nearby USGS seismic events", `
            ${renderAlertAudioSection("earthquake-alerts", earthquakeAlerts, {
              sirenBtnId: "test-earthquake-siren-btn",
              alertBtnId: "test-earthquake-alert-btn",
              hintHtml: `<p class="form-hint">Minimum magnitude, distance, and alert scope are set on the Earthquake card in <strong>Alert Zones</strong>.</p>`,
              behaviorTitle: "Behavior",
              behaviorContent: `
                ${renderToggle("earthquake-alerts-tsunami-priority", earthquakeAlerts.tsunami_priority !== false, "Always announce tsunami-flagged events")}
                ${renderToggle("earthquake-alerts-announce-updated", earthquakeAlerts.announce_updated === true, "Announce magnitude updates")}
                ${renderToggle("earthquake-alerts-announce-cleared", earthquakeAlerts.announce_cleared === true, "Announce when event clears")}
              `,
            })}
          `, true, "earthquake-alerts-enabled", earthquakeAlerts.enabled)}

          ${renderNestedSection("volcano-alerts", "Volcano Alerts", "Volcanic activity warnings", `
            ${renderAlertAudioSection("volcano-alerts", volcanoAlerts, {
              sirenBtnId: "test-volcano-siren-btn",
              alertBtnId: "test-volcano-alert-btn",
              hintHtml: `<p class="form-hint">Minimum activity level, distance, and alert scope are set on the Volcano card in <strong>Alert Zones</strong>.</p>`,
              behaviorTitle: "Behavior",
              behaviorContent: renderToggle("volcano-alerts-announce-cleared", volcanoAlerts.announce_cleared === true, "Announce when activity clears"),
            })}
          `, true, "volcano-alerts-enabled", volcanoAlerts.enabled)}

          ${renderNestedSection("wildfire-alerts", "Wildfire Alerts", "Nearby active wildfire incidents", `
            ${renderAlertAudioSection("wildfire-alerts", wildfireAlerts, {
              sirenBtnId: "test-wildfire-siren-btn",
              alertBtnId: "test-wildfire-alert-btn",
              hintHtml: `<p class="form-hint">Minimum fire size, distance, and alert scope are set on the Wildfire card in <strong>Alert Zones</strong>.</p>`,
              behaviorTitle: "Behavior",
              behaviorContent: renderToggle("wildfire-alerts-announce-cleared", wildfireAlerts.announce_cleared === true, "Announce when incident clears"),
            })}
          `, true, "wildfire-alerts-enabled", wildfireAlerts.enabled)}

          ${renderNestedSection("air-quality-alerts", "Air Quality Alerts", "Unhealthy air quality announcements", `
            ${renderAlertAudioSection("air-quality-alerts", airQualityAlerts, {
              sirenBtnId: "test-air-quality-siren-btn",
              alertBtnId: "test-air-quality-alert-btn",
              hintHtml: `<p class="form-hint">Minimum category level, distance, and alert scope are set on the Air Quality card in <strong>Alert Zones</strong>.</p>`,
              behaviorTitle: "Behavior",
              behaviorContent: renderToggle("air-quality-alerts-announce-cleared", airQualityAlerts.announce_cleared === true, "Announce when conditions clear"),
            })}
          `, true, "air-quality-alerts-enabled", airQualityAlerts.enabled)}

          ${renderNestedSection("travel-alerts", "Travel Advisory Alerts", "U.S. State Department travel warnings", `
            ${renderAlertAudioSection("travel-alerts", travelAlerts, {
              sirenBtnId: "test-travel-siren-btn",
              alertBtnId: "test-travel-btn",
              hintHtml: `<p class="form-hint">Map display and minimum map level are also in <strong>Safety</strong>.</p>`,
              behaviorTitle: "Behavior",
              behaviorContent: `
                <div class="form-group">
                  <label>Minimum announce level</label>
                  <select id="travel-alerts-min-level">${travelLevelOptions(travelAlerts.min_level ?? 3)}</select>
                </div>
                ${renderToggle("travel-announce-new", travelAlerts.announce_new_advisories !== false, "Announce new advisories")}
                ${renderToggle("travel-announce-changes", travelAlerts.announce_level_changes !== false, "Announce level changes")}
                <div class="form-group">
                  <label>Watched countries (optional)</label>
                  <input type="text" id="travel-watched-countries" placeholder="e.g. MX, FR, Japan (blank = all countries)" value="${(travelAlerts.watched_countries || []).join(", ")}"/>
                  <p class="form-hint">Comma-separated State Dept codes or country names. Leave blank to announce for all countries at or above the minimum level.</p>
                </div>
              `,
            })}
          `, true, "travel-alerts-enabled", travelAlerts.enabled)}

          ${renderNestedSection("spacecraft-alerts", "Spacecraft Overhead Alerts", "Announce when tracked craft pass overhead", `
            ${renderAlertAudioSection("spacecraft-alerts", spacecraftAlerts, {
              sirenBtnId: "test-spacecraft-siren-btn",
              alertBtnId: "test-spacecraft-alert-btn",
              hintHtml: `<p class="form-hint">Craft IDs and minimum elevation are configured under <strong>Space Map → Spacecraft Tracking</strong>.</p>`,
              behaviorTitle: "Behavior",
              behaviorContent: `
                ${renderToggle("spacecraft-announce-pass-start", spacecraftAlerts.announce_pass_start !== false, "Announce pass start")}
                ${renderToggle("spacecraft-announce-pass-peak", spacecraftAlerts.announce_pass_peak === true, "Announce pass peak")}
              `,
            })}
          `, true, "spacecraft-alerts-enabled", spacecraftAlerts.enabled)}

          ${renderNestedSection("solar-weather-alerts", "Solar Weather Alerts", "Geomagnetic storms and solar flares", `
            ${renderAlertAudioSection("solar-weather-alerts", solarWeatherAlerts, {
              sirenBtnId: "test-solar-weather-siren-btn",
              alertBtnId: "test-solar-weather-alert-btn",
              behaviorTitle: "Announce when",
              behaviorContent: `
                <div class="form-group">
                  <label for="solar-min-k-index">Minimum K-index</label>
                  <input type="number" id="solar-min-k-index" min="0" max="9" step="1" value="${solarWeatherAlerts.min_k_index ?? 5}"/>
                </div>
                <div class="form-group">
                  <label for="solar-min-g-scale">Minimum G-scale</label>
                  <input type="number" id="solar-min-g-scale" min="0" max="5" step="1" value="${solarWeatherAlerts.min_g_scale ?? 1}"/>
                </div>
                <div class="form-group">
                  <label for="solar-min-xray-class">Minimum X-ray class</label>
                  <select id="solar-min-xray-class">
                    ${["C", "M", "X"].map((c) => `<option value="${c}" ${String(solarWeatherAlerts.min_xray_class || "M").toUpperCase() === c ? "selected" : ""}>Class ${c}</option>`).join("")}
                  </select>
                </div>
                ${renderToggle("solar-announce-flares", solarWeatherAlerts.announce_flare_events !== false, "Announce solar flares")}
                ${renderToggle("solar-announce-storms", solarWeatherAlerts.announce_geomagnetic_storm !== false, "Announce geomagnetic storms")}
              `,
            })}
          `, true, "solar-weather-alerts-enabled", solarWeatherAlerts.enabled)}

          ${renderNestedSection("neo-alerts", "NEO Close Approach Alerts", "Near-Earth object flybys", `
            ${renderAlertAudioSection("neo-alerts", neoAlerts, {
              sirenBtnId: "test-neo-siren-btn",
              alertBtnId: "test-neo-alert-btn",
              hintHtml: `<p class="form-hint">Proximity thresholds are configured under <strong>Space Map → NEO Close Approaches</strong>.</p>`,
            })}
          `, true, "neo-alerts-enabled", neoAlerts.enabled)}

          ${renderNestedSection("sensor-triggered", "Sensor Triggers", "Announce when entity state changes", `
            <p class="form-hint">Add entities and define the state that triggers a TTS announcement.</p>
            <div id="sensor-triggers-list" class="media-player-list">
              ${tts.sensor_triggers.map((st, i) => `
                <div class="media-player-card sensor-trigger-card" data-sensor-idx="${i}">
                  <div class="form-row-inline">
                    <div class="form-group" style="flex: 2; min-width: 180px;">
                      <label>Entity</label>
                      ${this._renderEntityAutocomplete(`sensor-trigger-entity-${i}`, st.entity_id || "", "all", "Search entities...", "sensor-trigger-entity")}
                    </div>
                    <div class="form-group" style="flex: 1; min-width: 120px;">
                      <label>Trigger State</label>
                      <input type="text" class="sensor-trigger-state media-player-tts-entity" data-idx="${i}" placeholder="e.g. on, home" value="${st.trigger_state || ""}"/>
                    </div>
                  </div>
                  <div class="media-player-row">
                    <span class="media-player-label">Media Player</span>
                    <select class="sensor-trigger-media-player" data-idx="${i}" style="flex: 1;">
                      <option value="">All Media Players</option>
                      ${mediaPlayers.map(mp => `<option value="${mp.entity_id}" ${st.media_player === mp.entity_id ? "selected" : ""}>${mp.entity_id}</option>`).join("")}
                    </select>
                    <button class="btn btn-secondary" data-remove-sensor="${i}">Remove</button>
                  </div>
                </div>
              `).join("")}
            </div>
            <button class="btn btn-secondary" id="add-sensor-trigger" style="margin-top: 8px;">+ Add Trigger</button>
            <div class="form-actions-row">
              <button type="button" class="test-tts-btn" id="test-sensor-btn">Test trigger</button>
            </div>
          `, true, "enable-sensor-triggered", tts.enable_sensor_triggered)}

          <!-- Webhook -->
          ${renderNestedSection("webhook", "Webhook Triggers", `${tts.webhooks.length} configured`, `
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
                    <div class="inline-toggle">
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

          ${renderNestedSection("voice-satellite", "Voice Satellite", "Speak weather on voice queries", `
            <div class="form-group" style="margin-top: var(--form-gap);">
              <label>Conversation Commands (one per line)</label>
              <textarea class="textarea-field" id="conversation-commands" placeholder="What is the weather&#10;Whats the weather">${tts.conversation_commands}</textarea>
              <p class="form-hint">Registers a <code>HomeWeatherForecast</code> intent and the phrases above as conversation triggers.</p>
            </div>
          `, true, "enable-voice-satellite", tts.enable_voice_satellite)}
            </section>

            ${this._renderAppearanceTabFull(activePane, renderNestedSection)}

            <section class="settings-pane ${activePane === "advanced" ? "active" : ""}" data-settings-pane="advanced">
              <div class="settings-pane-head">
                <div class="settings-pane-title">Advanced</div>
                <div class="settings-pane-sub">Forecast tuning thresholds and AI message rewriting.</div>
              </div>
              ${renderNestedSection("forecast-settings", "Forecast Settings", "Thresholds and limits", `
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

              ${renderNestedSection("ai-rewrite", "AI Rewrite", "Rewrite TTS messages with an AI Task", `
                <div class="form-group" style="margin-top: var(--form-gap);">
                  <label>AI Task Entity</label>
                  ${this._renderEntityAutocomplete("ai-task-entity", tts.ai_task_entity || "", "ai_task", "Type to search AI task entities...")}
                </div>
                <div class="form-group">
                  <label>AI Rewrite Prompt</label>
                  <textarea class="textarea-field" id="ai-rewrite-prompt">${tts.ai_rewrite_prompt}</textarea>
                </div>
              `, true, "use-ai-rewrite", tts.use_ai_rewrite)}
            </section>

            <div class="settings-form-footer">
              <span class="settings-save-status" id="settings-save-status" role="status" aria-live="polite" data-state="idle">Changes save automatically</span>
              <button class="btn btn-secondary" id="cancel-btn">Revert</button>
              <button class="btn btn-primary" id="save-btn">Save now</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ---- Appearance / theme ----------------------------------------------

  /** Base palette (all --hw-* tokens) for a theme mode. */
  _themeBase(mode) {
    if (mode === "light") {
      return {
        bg: "#dde4ed", surface: "#ffffff", surface2: "#edf1f6", elevated: "#ffffff",
        inputBg: "#ffffff", text: "#152030", muted: "#546274", disabled: "#8a95a3",
        accent: "#0277bd", accentHover: "#0288d1", accentDim: "#e3f2fd",
        danger: "#c62828", warning: "#e65100", success: "#2e7d32",
        border: "#d0d7e0", borderStrong: "#bcc5d1", hover: "#e8ecf2",
        swatchBorder: "#b8c4d4",
      };
    }
    return {
      bg: "#111111", surface: "#1c1c1c", surface2: "#161616", elevated: "#282828",
      inputBg: "#282828", text: "#e1e1e1", muted: "#9b9b9b", disabled: "#6f6f6f",
      accent: "#03a9f4", accentHover: "#29b6f6", accentDim: "#0d2536",
      danger: "#f44336", warning: "#ff9800", success: "#4caf50",
      border: "#252525", borderStrong: "#333333", hover: "#222222",
      swatchBorder: "#333333",
    };
  }

  /** Normalized appearance settings: { mode, overrides }. */
  _getAppearance() {
    const ap = this._settings?.appearance || {};
    const mode = ap.mode === "light" ? "light" : "dark";
    const overrides = ap.overrides && typeof ap.overrides === "object" ? { ...ap.overrides } : {};
    return { mode, overrides };
  }

  /** Read a persisted appearance from localStorage (used for an instant,
   *  flash-free theme before the config WS round-trip resolves). Falls back to
   *  dark when nothing valid is stored. */
  _readStoredAppearance() {
    try {
      const mode = window.localStorage.getItem("hw_theme_mode");
      let overrides = {};
      const rawOv = window.localStorage.getItem("hw_theme_overrides");
      if (rawOv) {
        const parsed = JSON.parse(rawOv);
        if (parsed && typeof parsed === "object") overrides = parsed;
      }
      return { mode: mode === "light" ? "light" : "dark", overrides };
    } catch (_) {
      return { mode: "dark", overrides: {} };
    }
  }

  /** Persist the active appearance to localStorage synchronously so the next
   *  load can theme instantly, and (debounced) to the backend so it survives
   *  across devices. Never blocks the UI. */
  _persistAppearance() {
    const { mode, overrides } = this._getAppearance();
    try {
      window.localStorage.setItem("hw_theme_mode", mode);
      window.localStorage.setItem("hw_theme_overrides", JSON.stringify(overrides || {}));
    } catch (_) { /* storage may be unavailable (private mode) */ }
    // Background save to HA storage so the preference follows the account.
    if (this._config) this._config.appearance = { mode, overrides };
    if (this._themeSaveTimer) clearTimeout(this._themeSaveTimer);
    this._themeSaveTimer = setTimeout(() => {
      this._themeSaveTimer = null;
      if (!this._hass) return;
      const cfg = { ...(this._settings || {}), appearance: { mode, overrides } };
      this._hass.callWS({ type: "home_weather/set_config", config: cfg }).catch((e) => {
        console.warn("Theme preference save failed (will retry on next save):", e);
      });
    }, 600);
  }

  /** Mirror the current theme mode + tokens onto embedded child component roots
   *  (hurricane tracker, zone editor, space map) so their shadow DOMs inherit
   *  the --hw-* custom properties and can key off [data-hw-theme]. Custom
   *  properties inherit through shadow boundaries as long as they are set on an
   *  ancestor of the child's shadow host, which these roots are. */
  _propagateThemeToChildren(mode) {
    const s = this.shadowRoot;
    if (!s) return;
    const roots = [
      s.getElementById("hurricane-tracker-root"),
      s.getElementById("zone-editor-root"),
      s.getElementById("space-map-root"),
    ];
    roots.forEach((root) => {
      if (root) root.setAttribute("data-hw-theme", mode);
    });
    // Notify live child component instances that expose a theme hook.
    try { this._hurricaneTracker?.setTheme?.(mode); } catch (_) {}
    try { this._zoneEditor?.setTheme?.(mode); } catch (_) {}
    try { this._spaceMap?.setTheme?.(mode); } catch (_) {}
  }

  /** Hex swatch value for a control key given a base palette. */
  _themeSwatchHex(base, key) {
    if (key === "border") return base.swatchBorder;
    return base[key] || "#000000";
  }

  _hexToRgba(hex, alpha) {
    const h = String(hex || "").replace("#", "");
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const int = parseInt(full, 16);
    if (Number.isNaN(int) || full.length !== 6) return `rgba(3, 169, 244, ${alpha})`;
    const r = (int >> 16) & 255, g = (int >> 8) & 255, b = int & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  /** Lighten (positive) or darken (negative) a hex color by an amount. */
  _shiftColor(hex, amt) {
    const h = String(hex || "").replace("#", "");
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const int = parseInt(full, 16);
    if (Number.isNaN(int) || full.length !== 6) return hex;
    const clamp = (v) => Math.max(0, Math.min(255, v));
    const r = clamp(((int >> 16) & 255) + amt);
    const g = clamp(((int >> 8) & 255) + amt);
    const b = clamp((int & 255) + amt);
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  }

  /** Apply the active theme to the host as inline CSS variables (survives re-render). */
  _applyTheme() {
    const host = this;
    if (!host || !host.style) return;
    const { mode, overrides: ov } = this._getAppearance();
    const base = this._themeBase(mode);
    const t = { ...base };
    if (ov.accent) {
      t.accent = ov.accent;
      t.accentHover = this._shiftColor(ov.accent, mode === "light" ? -14 : 18);
      t.accentDim = this._hexToRgba(ov.accent, 0.15);
    }
    if (ov.bg) t.bg = ov.bg;
    if (ov.surface) {
      t.surface = ov.surface;
      t.surface2 = this._shiftColor(ov.surface, mode === "light" ? -10 : 10);
      t.elevated = ov.surface;
      t.inputBg = ov.surface;
    }
    if (ov.text) t.text = ov.text;
    if (ov.muted) { t.muted = ov.muted; t.disabled = ov.muted; }
    if (ov.border) { t.border = ov.border; t.borderStrong = ov.border; }
    if (ov.danger) t.danger = ov.danger;
    if (ov.warning) t.warning = ov.warning;
    if (ov.success) t.success = ov.success;
    const set = (k, v) => host.style.setProperty(k, v);
    set("--hw-bg", t.bg);
    set("--hw-surface", t.surface);
    set("--hw-surface-2", t.surface2);
    set("--hw-elevated", t.elevated);
    set("--hw-input-bg", t.inputBg);
    set("--hw-text", t.text);
    set("--hw-muted", t.muted);
    set("--hw-disabled", t.disabled);
    set("--hw-accent", t.accent);
    set("--hw-accent-hover", t.accentHover);
    set("--hw-accent-dim", t.accentDim);
    set("--hw-danger", t.danger);
    set("--hw-warning", t.warning);
    set("--hw-success", t.success);
    set("--hw-border", t.border);
    set("--hw-border-strong", t.borderStrong);
    set("--hw-hover", t.hover);
    const shadows = mode === "light"
      ? {
        sm: "0 1px 2px rgba(15, 23, 42, 0.05)",
        base: "0 1px 2px rgba(15, 23, 42, 0.05), 0 2px 6px rgba(15, 23, 42, 0.06)",
        md: "0 2px 8px rgba(15, 23, 42, 0.08), 0 1px 3px rgba(15, 23, 42, 0.05)",
        lg: "0 12px 32px rgba(15, 23, 42, 0.12), 0 4px 8px rgba(15, 23, 42, 0.06)",
      }
      : {
        sm: "0 1px 2px rgba(0, 0, 0, 0.3)",
        base: "0 2px 8px rgba(0, 0, 0, 0.35)",
        md: "0 4px 16px rgba(0, 0, 0, 0.35)",
        lg: "0 12px 40px rgba(0, 0, 0, 0.5)",
      };
    set("--shadow-sm", shadows.sm);
    set("--shadow", shadows.base);
    set("--shadow-md", shadows.md);
    set("--shadow-lg", shadows.lg);
    set("--hw-footer-bg", /^#/.test(t.surface) ? this._hexToRgba(t.surface, mode === "light" ? 0.96 : 0.88) : t.surface);
    set("--hw-inset-bg", t.surface2);
    set("--hw-code-bg", mode === "light" ? "rgba(21, 32, 48, 0.06)" : "rgba(255,255,255,0.06)");
    set("--hw-scrim", mode === "light" ? "rgba(15, 23, 42, 0.32)" : "rgba(0, 0, 0, 0.55)");
    // Neutral overlays that must invert between themes (subtle fills, hairline
    // dividers and borders that were previously hardcoded to white rgba and so
    // vanished on light surfaces).
    set("--hw-overlay-subtle", mode === "light" ? "rgba(15, 23, 42, 0.03)" : "rgba(255, 255, 255, 0.025)");
    set("--hw-overlay-hover", mode === "light" ? "rgba(15, 23, 42, 0.06)" : "rgba(255, 255, 255, 0.045)");
    set("--hw-overlay-border", mode === "light" ? "rgba(15, 23, 42, 0.12)" : "rgba(255, 255, 255, 0.1)");
    set("--hw-overlay-border-strong", mode === "light" ? "rgba(15, 23, 42, 0.16)" : "rgba(255, 255, 255, 0.16)");
    set("--hw-divider-soft", mode === "light" ? "rgba(15, 23, 42, 0.08)" : "rgba(255, 255, 255, 0.08)");
    // Translucent header bar tuned to the current surface so the sticky topbar
    // matches the theme (it otherwise falls back to a hardcoded dark rgba).
    const headerBg = /^#/.test(t.surface) ? this._hexToRgba(t.surface, 0.78) : t.surface;
    set("--app-header-background-color", headerBg);
    host.setAttribute("data-hw-theme", mode);
    this._propagateThemeToChildren(mode);
  }

  /** Collect appearance settings. The theme controls update
   *  this._settings.appearance live (instant apply), so we just normalize and
   *  return the current selection here. */
  _collectAppearanceSettings() {
    const { mode, overrides } = this._getAppearance();
    return { mode, overrides };
  }

  _renderAppearanceTab(activePane, renderNestedSection) {
    const section = typeof renderNestedSection === "function"
      ? renderNestedSection("appearance-overview", "Theme", "Dark mode and customization", `
          <div style="text-align:center;padding:24px 12px;">
            <div style="margin-bottom:16px;">
              <svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48" style="opacity:0.4;"><path d="M12 3a9 9 0 109 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 01-4.4 2.26 5.4 5.4 0 01-5.4-5.4c0-1.81.9-3.42 2.26-4.4A9.1 9.1 0 0012 3z"/></svg>
            </div>
            <div class="settings-card-title" style="font-size:18px;margin-bottom:8px;">Dark Mode Active</div>
            <p style="color:var(--hw-muted,#9e9e9e);margin:0 0 20px;font-size:14px;line-height:1.5;">
              Home Weather is optimized for dark environments and hazard monitoring.<br/>
              Theme customization options are coming in a future update.
            </p>
            <span style="display:inline-block;padding:6px 14px;background:rgba(255,255,255,0.08);border-radius:999px;font-size:12px;font-weight:600;color:#90caf9;letter-spacing:0.5px;">
              COMING SOON
            </span>
          </div>
        `)
      : "";
    return `
      <section class="settings-pane ${activePane === "appearance" ? "active" : ""}" data-settings-pane="appearance">
        <div class="settings-pane-head">
          <div class="settings-pane-title">Appearance</div>
          <div class="settings-pane-sub">Customize the look and feel of Home Weather.</div>
        </div>
        ${section}
      </section>`;
  }

  _renderAppearanceTabFull(activePane, renderNestedSection) {
    const { mode, overrides } = this._getAppearance();
    const base = this._themeBase(mode);
    const swatches = [
      { key: "accent", label: "Accent", hint: "Buttons, links, highlights" },
      { key: "bg", label: "Background", hint: "App backdrop" },
      { key: "surface", label: "Cards / surfaces", hint: "Panels, inputs, menus" },
      { key: "text", label: "Text", hint: "Primary text" },
      { key: "muted", label: "Secondary text", hint: "Hints and labels" },
      { key: "border", label: "Borders", hint: "Dividers and outlines" },
      { key: "danger", label: "Danger", hint: "Errors and warnings" },
      { key: "warning", label: "Warning", hint: "Cautions" },
      { key: "success", label: "Success", hint: "Confirmations" },
    ];
    const swatchRow = (sw) => {
      const val = overrides[sw.key] || this._themeSwatchHex(base, sw.key);
      const isOn = !!overrides[sw.key];
      return `
        <div class="theme-swatch-row ${isOn ? "is-overridden" : ""}">
          <div class="theme-swatch-info">
            <span class="theme-swatch-label">${sw.label}</span>
            <span class="theme-swatch-hint">${sw.hint}</span>
          </div>
          <label class="theme-swatch">
            <input type="color" data-theme-token="${sw.key}" value="${val}" aria-label="${sw.label} color"/>
            <span class="theme-swatch-dot" style="background:${val}"></span>
          </label>
        </div>`;
    };
    const themeBlock = `
      <div class="theme-mode-block">
        <div class="theme-mode-seg" role="group" aria-label="Theme mode">
          <button type="button" data-theme-mode="dark" class="${mode === "dark" ? "active" : ""}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 3a9 9 0 109 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 01-4.4 2.26 5.4 5.4 0 01-5.4-5.4c0-1.81.9-3.42 2.26-4.4A9.1 9.1 0 0012 3z"/></svg>
            <span>Dark</span>
          </button>
          <button type="button" data-theme-mode="light" class="${mode === "light" ? "active" : ""}">
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 7a5 5 0 100 10 5 5 0 000-10zm0-5v3m0 14v3M4.2 4.2l2.1 2.1m11.4 11.4l2.1 2.1M2 12h3m14 0h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>
            <span>Light</span>
          </button>
        </div>
        <p class="form-hint" style="margin:0;">Panel-wide base palette. The default is Dark.</p>
      </div>`;
    const colorsBlock = `
      <div class="settings-card-header">
        <div>
          <div class="settings-card-sub">Override any element. Untouched colors follow the base theme.</div>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" id="theme-reset-btn">Reset to defaults</button>
      </div>
      <div class="theme-swatch-grid">
        ${swatches.map(swatchRow).join("")}
      </div>`;
    const sections = typeof renderNestedSection === "function"
      ? `
        ${renderNestedSection("appearance-theme", "Theme", "Base light or dark palette", themeBlock)}
        ${renderNestedSection("appearance-colors", "Colors", "Per-element color overrides", colorsBlock)}
      `
      : `
        <div class="settings-card">
          <div class="settings-card-title">Theme</div>
          ${themeBlock}
        </div>
        <div class="settings-card">
          <div class="settings-card-header">
            <div>
              <div class="settings-card-title">Colors</div>
              <div class="settings-card-sub">Override any element. Untouched colors follow the base theme.</div>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" id="theme-reset-btn">Reset to defaults</button>
          </div>
          <div class="theme-swatch-grid">
            ${swatches.map(swatchRow).join("")}
          </div>
        </div>
      `;
    return `
      <section class="settings-pane ${activePane === "appearance" ? "active" : ""}" data-settings-pane="appearance">
        <div class="settings-pane-head">
          <div class="settings-pane-title">Appearance</div>
          <div class="settings-pane-sub">Choose a base theme and fine-tune individual colors. Changes preview instantly; Save to keep them.</div>
        </div>
        ${sections}
      </section>`;
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
    this._settings.tropical_alerts = this._collectTropicalAlertsSettings();
    this._settings.tornado_alerts = this._collectTornadoAlertsSettings();
    this._settings.earthquake_alerts = this._collectEarthquakeAlertsSettings();
    this._settings.volcano_alerts = this._collectVolcanoAlertsSettings();
    this._settings.wildfire_alerts = this._collectWildfireAlertsSettings();
    this._settings.air_quality_alerts = this._collectAirQualityAlertsSettings();
    this._settings.travel_alerts = this._collectTravelAlertsSettings();
    this._settings.space_monitoring = this._collectSpaceMonitoringSettings();
    this._settings.solar_weather_monitoring = this._collectSolarWeatherMonitoringSettings();
    this._settings.spacecraft_alerts = this._collectSpacecraftAlertsSettings();
    this._settings.solar_weather_alerts = this._collectSolarWeatherAlertsSettings();
    this._settings.neo_alerts = this._collectNeoAlertsSettings();
    this._settings.hurricane_monitoring = this._collectHurricaneMonitoringSettings();
    this._settings.tornado_monitoring = this._collectTornadoMonitoringSettings();
    this._settings.earthquake_monitoring = this._collectEarthquakeMonitoringSettings();
    this._settings.lightning_monitoring = this._collectLightningMonitoringSettings();
    this._settings.volcano_monitoring = this._collectVolcanoMonitoringSettings();
    this._settings.travel_monitoring = this._collectTravelMonitoringSettings();
    this._settings.wildfire_monitoring = this._collectWildfireMonitoringSettings();
    this._settings.air_quality_monitoring = this._collectAirQualityMonitoringSettings();
    this._settings.earthquakes = { ...this._settings.earthquake_monitoring };
    this._settings.lightning = this._collectLightningSettings();
    this._settings.appearance = this._collectAppearanceSettings();

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
    if (!s) return { enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9, replay_on_time_based_forecast: true };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    const soundVol = Math.min(1, Math.max(0, parseFloat(getVal("nws-alerts-sound-volume", "0.8"))));
    const ttsVol = Math.min(1, Math.max(0, parseFloat(getVal("nws-alerts-tts-volume", "0.9"))));
    return {
      enabled: getChecked("nws-alerts-enabled"),
      sound_file: (getVal("nws-alerts-sound-file", "") || "").trim(),
      sound_volume: soundVol,
      tts_volume: ttsVol,
      replay_on_time_based_forecast: getChecked("nws-alerts-replay-forecast"),
    };
  }

  _collectTropicalAlertsSettings() {
    const s = this.shadowRoot;
    const defaults = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9,
      announce_inside_cone: true, announce_threat_escalation: true,
      announce_new_storm: true, announce_outlook_development: true,
    };
    if (!s) return { ...(this._settings.tropical_alerts || {}), ...defaults };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    // Threat level, outlook probability, distance, and alert scope live in
    // hurricane_monitoring (Alert Zones tab) — TTS block is TTS-only.
    return {
      ...(this._settings.tropical_alerts || {}),
      enabled: getChecked("tropical-alerts-enabled"),
      sound_file: (getVal("tropical-alerts-sound-file", "") || "").trim(),
      sound_volume: Math.min(1, Math.max(0, parseFloat(getVal("tropical-alerts-sound-volume", "0.8")))),
      tts_volume: Math.min(1, Math.max(0, parseFloat(getVal("tropical-alerts-tts-volume", "0.9")))),
      announce_inside_cone: getChecked("tropical-announce-cone"),
      announce_threat_escalation: getChecked("tropical-announce-escalation"),
      announce_new_storm: getChecked("tropical-announce-new-storm"),
      announce_outlook_development: getChecked("tropical-announce-outlook"),
    };
  }

  _collectTornadoAlertsSettings() {
    const s = this.shadowRoot;
    const defaults = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9,
      announce_cleared: false,
    };
    if (!s) return { ...(this._settings.tornado_alerts || {}), ...defaults };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    // Distance, polygon matching, and alert scope live in tornado_monitoring.
    return {
      ...(this._settings.tornado_alerts || {}),
      enabled: getChecked("tornado-alerts-enabled"),
      sound_file: (getVal("tornado-alerts-sound-file", "") || "").trim(),
      sound_volume: Math.min(1, Math.max(0, parseFloat(getVal("tornado-alerts-sound-volume", "0.8")))),
      tts_volume: Math.min(1, Math.max(0, parseFloat(getVal("tornado-alerts-tts-volume", "0.9")))),
      announce_cleared: getChecked("tornado-announce-cleared"),
    };
  }

  _collectEarthquakeAlertsSettings() {
    const s = this.shadowRoot;
    const defaults = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9,
      tsunami_priority: true, announce_updated: false, announce_cleared: false,
    };
    if (!s) return { ...(this._settings.earthquake_alerts || {}), ...defaults };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    // Magnitude, distance, and alert scope live in earthquake_monitoring.
    return {
      ...(this._settings.earthquake_alerts || {}),
      enabled: getChecked("earthquake-alerts-enabled"),
      sound_file: (getVal("earthquake-alerts-sound-file", "") || "").trim(),
      sound_volume: Math.min(1, Math.max(0, parseFloat(getVal("earthquake-alerts-sound-volume", "0.8")))),
      tts_volume: Math.min(1, Math.max(0, parseFloat(getVal("earthquake-alerts-tts-volume", "0.9")))),
      tsunami_priority: getChecked("earthquake-alerts-tsunami-priority"),
      announce_updated: getChecked("earthquake-alerts-announce-updated"),
      announce_cleared: getChecked("earthquake-alerts-announce-cleared"),
    };
  }

  /** Read the linked scope (zone/bypass) for sensors and alerts from the Alert Zones pane. */
  _getScopeModeFromForm(hazardKey, fallback = "zone") {
    const s = this.shadowRoot;
    const activeBtn = s?.querySelector(`.zone-mode-seg[data-scope-for="${hazardKey}"] button.active`);
    if (!activeBtn) return fallback;
    return activeBtn.dataset.mode === "all" ? "all" : "zone";
  }

  _collectHurricaneMonitoringSettings() {
    const s = this.shadowRoot;
    const existing = this._settings.hurricane_monitoring || {};
    const defaults = { enabled: true, zone_mode: "zone", alert_zone_mode: "zone", max_distance_miles: 500, min_threat_level: "monitor", outlook_min_probability: 40 };
    if (!s) return { ...defaults, ...existing };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    const levels = ["none", "monitor", "watch", "high"];
    const minThreat = getVal("hurricane-monitoring-min-threat", defaults.min_threat_level);
    return {
      ...existing,
      enabled: getChecked("hurricane-monitoring-enabled"),
      zone_mode: this._getScopeModeFromForm("hurricane-sensor", existing.zone_mode || "zone"),
      alert_zone_mode: this._getScopeModeFromForm("hurricane-alert", existing.alert_zone_mode || existing.zone_mode || "zone"),
      min_threat_level: levels.includes(minThreat) ? minThreat : defaults.min_threat_level,
      max_distance_miles: Math.min(5000, Math.max(1, parseInt(getVal("hurricane-monitoring-max-distance", String(existing.max_distance_miles ?? defaults.max_distance_miles)), 10) || defaults.max_distance_miles)),
      outlook_min_probability: Math.min(100, Math.max(0, parseInt(getVal("hurricane-monitoring-outlook-prob", String(existing.outlook_min_probability ?? defaults.outlook_min_probability)), 10) || defaults.outlook_min_probability)),
    };
  }

  _collectTornadoMonitoringSettings() {
    const s = this.shadowRoot;
    const existing = this._settings.tornado_monitoring || {};
    const defaults = { enabled: true, zone_mode: "zone", alert_zone_mode: "zone", only_affecting_home: true, max_distance_miles: 25 };
    if (!s) return { ...defaults, ...existing };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    return {
      ...existing,
      enabled: getChecked("tornado-monitoring-enabled"),
      zone_mode: this._getScopeModeFromForm("tornado-sensor", existing.zone_mode || "zone"),
      alert_zone_mode: this._getScopeModeFromForm("tornado-alert", existing.alert_zone_mode || existing.zone_mode || "zone"),
      only_affecting_home: getChecked("tornado-monitoring-only-home"),
      max_distance_miles: Math.min(500, Math.max(1, parseInt(getVal("tornado-monitoring-max-distance", String(existing.max_distance_miles ?? defaults.max_distance_miles)), 10) || defaults.max_distance_miles)),
    };
  }

  _collectEarthquakeMonitoringSettings() {
    const s = this.shadowRoot;
    const existing = this._settings.earthquake_monitoring || {};
    const defaults = {
      enabled: true,
      zone_mode: "zone",
      alert_zone_mode: "zone",
      min_magnitude: 2.5,
      radius_miles: 500,
      feed_type: "all_hour",
      tsunami_alert_enabled: true,
      map_show_worldwide: true,
      map_min_magnitude: 4.5,
      map_feed_type: "all_day",
    };
    if (!s) return { ...defaults, ...existing };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    const mapWindows = ["all_hour", "all_day", "all_week", "all_month"];
    const rawWindow = getVal("earthquake-map-window", existing.map_feed_type || defaults.map_feed_type);
    const mapFeedType = mapWindows.includes(rawWindow) ? rawWindow : defaults.map_feed_type;
    return {
      ...existing,
      enabled: getChecked("earthquake-monitoring-enabled"),
      zone_mode: this._getScopeModeFromForm("earthquake-sensor", existing.zone_mode || "zone"),
      alert_zone_mode: this._getScopeModeFromForm("earthquake-alert", existing.alert_zone_mode || existing.zone_mode || "zone"),
      min_magnitude: Math.min(10, Math.max(0, parseFloat(getVal("earthquake-min-magnitude", String(defaults.min_magnitude))) || defaults.min_magnitude)),
      radius_miles: Math.min(5000, Math.max(1, parseInt(getVal("earthquake-radius-miles", String(existing.radius_miles ?? defaults.radius_miles)), 10) || defaults.radius_miles)),
      feed_type: existing.feed_type || defaults.feed_type,
      tsunami_alert_enabled: getChecked("earthquake-tsunami-enabled"),
      map_show_worldwide: getChecked("earthquake-map-worldwide"),
      map_min_magnitude: Math.min(10, Math.max(0, parseFloat(getVal("earthquake-map-min-magnitude", String(defaults.map_min_magnitude))) || defaults.map_min_magnitude)),
      map_feed_type: mapFeedType,
    };
  }

  _collectLightningMonitoringSettings() {
    const s = this.shadowRoot;
    const existing = this._settings.lightning_monitoring || {};
    const defaults = { enabled: true, zone_mode: "zone", show_on_map: true, max_age_minutes: 60, max_strikes: 500, geofield_radius_miles: 100 };
    if (!s) return { ...defaults, ...existing };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    return {
      ...existing,
      enabled: getChecked("lightning-monitoring-enabled"),
      zone_mode: this._getScopeModeFromForm("lightning-sensor", existing.zone_mode || "zone"),
      show_on_map: getChecked("lightning-show-on-map"),
      geofield_radius_miles: Math.min(500, Math.max(1, parseInt(getVal("lightning-geofield-radius-miles", String(existing.geofield_radius_miles ?? defaults.geofield_radius_miles)), 10) || defaults.geofield_radius_miles)),
      max_age_minutes: Math.min(240, Math.max(5, parseInt(getVal("lightning-max-age-minutes", String(defaults.max_age_minutes)), 10) || defaults.max_age_minutes)),
      max_strikes: existing.max_strikes ?? defaults.max_strikes,
    };
  }

  _collectVolcanoAlertsSettings() {
    const s = this.shadowRoot;
    const defaults = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9,
      announce_cleared: false,
    };
    if (!s) return { ...(this._settings.volcano_alerts || {}), ...defaults };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    // Min activity level, distance, and alert scope live in volcano_monitoring.
    return {
      ...(this._settings.volcano_alerts || {}),
      enabled: getChecked("volcano-alerts-enabled"),
      sound_file: (getVal("volcano-alerts-sound-file", "") || "").trim(),
      sound_volume: Math.min(1, Math.max(0, parseFloat(getVal("volcano-alerts-sound-volume", "0.8")))),
      tts_volume: Math.min(1, Math.max(0, parseFloat(getVal("volcano-alerts-tts-volume", "0.9")))),
      announce_cleared: getChecked("volcano-alerts-announce-cleared"),
    };
  }

  _collectWildfireAlertsSettings() {
    const s = this.shadowRoot;
    const defaults = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9, announce_cleared: false,
    };
    if (!s) return { ...(this._settings.wildfire_alerts || {}), ...defaults };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    return {
      ...(this._settings.wildfire_alerts || {}),
      enabled: getChecked("wildfire-alerts-enabled"),
      sound_file: (getVal("wildfire-alerts-sound-file", "") || "").trim(),
      sound_volume: Math.min(1, Math.max(0, parseFloat(getVal("wildfire-alerts-sound-volume", "0.8")))),
      tts_volume: Math.min(1, Math.max(0, parseFloat(getVal("wildfire-alerts-tts-volume", "0.9")))),
      announce_cleared: getChecked("wildfire-alerts-announce-cleared"),
    };
  }

  _collectAirQualityAlertsSettings() {
    const s = this.shadowRoot;
    const defaults = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9, announce_cleared: false,
    };
    if (!s) return { ...(this._settings.air_quality_alerts || {}), ...defaults };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    return {
      ...(this._settings.air_quality_alerts || {}),
      enabled: getChecked("air-quality-alerts-enabled"),
      sound_file: (getVal("air-quality-alerts-sound-file", "") || "").trim(),
      sound_volume: Math.min(1, Math.max(0, parseFloat(getVal("air-quality-alerts-sound-volume", "0.8")))),
      tts_volume: Math.min(1, Math.max(0, parseFloat(getVal("air-quality-alerts-tts-volume", "0.9")))),
      announce_cleared: getChecked("air-quality-alerts-announce-cleared"),
    };
  }

  _collectVolcanoMonitoringSettings() {
    const s = this.shadowRoot;
    const existing = this._settings.volcano_monitoring || {};
    const defaults = { enabled: true, zone_mode: "zone", alert_zone_mode: "zone", radius_miles: 500, min_alert_level: "advisory", map_show_all_volcanoes: true };
    if (!s) return { ...defaults, ...existing };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    const levels = ["advisory", "watch", "warning"];
    const minLevel = getVal("volcano-min-alert-level", existing.min_alert_level || defaults.min_alert_level);
    return {
      ...existing,
      enabled: getChecked("volcano-monitoring-enabled"),
      zone_mode: this._getScopeModeFromForm("volcano-sensor", existing.zone_mode || "zone"),
      alert_zone_mode: this._getScopeModeFromForm("volcano-alert", existing.alert_zone_mode || existing.zone_mode || "zone"),
      radius_miles: Math.min(5000, Math.max(1, parseInt(getVal("volcano-radius-miles", String(existing.radius_miles ?? defaults.radius_miles)), 10) || defaults.radius_miles)),
      min_alert_level: levels.includes(minLevel) ? minLevel : defaults.min_alert_level,
      map_show_all_volcanoes: true,
    };
  }

  _collectEarthquakeSettings() {
    return this._collectEarthquakeMonitoringSettings();
  }

  _collectLightningSettings() {
    const mon = this._collectLightningMonitoringSettings();
    const { enabled: _enabled, ...legacy } = mon;
    return legacy;
  }

  _collectTravelMonitoringSettings() {
    const s = this.shadowRoot;
    const existing = this._settings.travel_monitoring || {};
    const defaults = { enabled: true, show_on_map: true, min_level: 1 };
    if (!s) return { ...defaults, ...existing };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    const minLevel = Math.min(4, Math.max(1, parseInt(getVal("travel-map-min-level", String(existing.min_level ?? defaults.min_level)), 10) || defaults.min_level));
    return {
      ...existing,
      enabled: getChecked("travel-monitoring-enabled"),
      show_on_map: getChecked("travel-show-on-map"),
      min_level: minLevel,
    };
  }

  _collectTravelAlertsSettings() {
    const s = this.shadowRoot;
    const defaults = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9,
      min_level: 3, announce_level_changes: true, announce_new_advisories: true, watched_countries: [],
    };
    if (!s) return { ...(this._settings.travel_alerts || {}), ...defaults };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    const watchedRaw = (getVal("travel-watched-countries", "") || "").trim();
    const watched = watchedRaw
      ? watchedRaw.split(",").map((v) => v.trim()).filter(Boolean)
      : [];
    const minLevel = Math.min(4, Math.max(1, parseInt(getVal("travel-alerts-min-level", String(defaults.min_level)), 10) || defaults.min_level));
    return {
      ...(this._settings.travel_alerts || {}),
      enabled: getChecked("travel-alerts-enabled"),
      sound_file: (getVal("travel-alerts-sound-file", "") || "").trim(),
      sound_volume: Math.min(1, Math.max(0, parseFloat(getVal("travel-alerts-sound-volume", "0.8")))),
      tts_volume: Math.min(1, Math.max(0, parseFloat(getVal("travel-alerts-tts-volume", "0.9")))),
      min_level: minLevel,
      announce_level_changes: getChecked("travel-announce-changes"),
      announce_new_advisories: getChecked("travel-announce-new"),
      watched_countries: watched,
    };
  }

  _collectWildfireMonitoringSettings() {
    const s = this.shadowRoot;
    const existing = this._settings.wildfire_monitoring || {};
    const defaults = { enabled: true, zone_mode: "zone", alert_zone_mode: "zone", radius_miles: 100, show_on_map: true, show_perimeters: true, min_acres: 100, exclude_prescribed: true };
    if (!s) return { ...defaults, ...existing };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    return {
      ...existing,
      enabled: getChecked("wildfire-monitoring-enabled"),
      zone_mode: this._getScopeModeFromForm("wildfire-sensor", existing.zone_mode || "zone"),
      alert_zone_mode: this._getScopeModeFromForm("wildfire-alert", existing.alert_zone_mode || existing.zone_mode || "zone"),
      radius_miles: Math.min(500, Math.max(1, parseInt(getVal("wildfire-radius-miles", String(existing.radius_miles ?? defaults.radius_miles)), 10) || defaults.radius_miles)),
      show_on_map: getChecked("wildfire-show-on-map"),
      show_perimeters: getChecked("wildfire-show-perimeters"),
      exclude_prescribed: getChecked("wildfire-exclude-prescribed"),
      min_acres: Math.max(0, parseFloat(getVal("wildfire-min-acres", String(existing.min_acres ?? defaults.min_acres))) || defaults.min_acres),
    };
  }

  _collectAirQualityMonitoringSettings() {
    const s = this.shadowRoot;
    const existing = this._settings.air_quality_monitoring || {};
    const defaults = { enabled: true, zone_mode: "zone", alert_zone_mode: "zone", radius_miles: 50, show_on_map: true, min_category_level: 1 };
    if (!s) return { ...defaults, ...existing };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    const minLevel = Math.min(6, Math.max(1, parseInt(getVal("air-quality-min-level", String(existing.min_category_level ?? defaults.min_category_level)), 10) || defaults.min_category_level));
    return {
      ...existing,
      enabled: getChecked("air-quality-monitoring-enabled"),
      zone_mode: this._getScopeModeFromForm("air_quality-sensor", existing.zone_mode || "zone"),
      alert_zone_mode: this._getScopeModeFromForm("air_quality-alert", existing.alert_zone_mode || existing.zone_mode || "zone"),
      radius_miles: Math.min(500, Math.max(1, parseInt(getVal("air-quality-radius-miles", String(existing.radius_miles ?? defaults.radius_miles)), 10) || defaults.radius_miles)),
      show_on_map: getChecked("air-quality-show-on-map"),
      min_category_level: minLevel,
    };
  }

  _collectSpaceMonitoringSettings() {
    const s = this.shadowRoot;
    const existing = this._settings.space_monitoring || {};
    const defaults = {
      enabled: true, show_planets: true, show_dwarf_planets: true, show_moons: true,
      show_spacecraft: true, show_asteroids: true, show_comets: true,
      small_body_min_diameter_km: 0, log_scale_orbits: true,
    };
    if (!s) return { ...defaults, ...existing };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    return {
      ...existing,
      enabled: getChecked("space-monitoring-enabled"),
      show_planets: getChecked("space-show-planets"),
      show_dwarf_planets: getChecked("space-show-dwarf-planets"),
      show_moons: getChecked("space-show-moons"),
      show_spacecraft: getChecked("space-show-spacecraft"),
      show_asteroids: getChecked("space-show-asteroids"),
      show_comets: getChecked("space-show-comets"),
      log_scale_orbits: getChecked("space-log-scale"),
      small_body_min_diameter_km: Math.max(0, parseFloat(getVal("space-min-diameter-km", String(existing.small_body_min_diameter_km ?? 0))) || 0),
    };
  }

  _collectSolarWeatherMonitoringSettings() {
    const s = this.shadowRoot;
    const existing = this._settings.solar_weather_monitoring || {};
    const defaults = { enabled: true, show_sunspot_regions: true, show_flare_events: true };
    if (!s) return { ...defaults, ...existing };
    return {
      ...existing,
      enabled: !!s.getElementById("solar-weather-monitoring-enabled")?.checked,
      show_sunspot_regions: !!s.getElementById("solar-show-regions")?.checked,
      show_flare_events: !!s.getElementById("solar-show-flares")?.checked,
    };
  }

  _collectSpacecraftAlertsSettings() {
    const s = this.shadowRoot;
    const defaults = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9,
      min_elevation_deg: 10, craft_ids: ["-255544"], announce_pass_start: true, announce_pass_peak: false,
    };
    if (!s) return { ...(this._settings.spacecraft_alerts || {}), ...defaults };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    const craftRaw = (getVal("spacecraft-craft-ids", "-255544") || "").trim();
    const craft_ids = craftRaw.split(",").map((v) => v.trim()).filter(Boolean);
    return {
      ...(this._settings.spacecraft_alerts || {}),
      enabled: getChecked("spacecraft-alerts-enabled"),
      sound_file: (getVal("spacecraft-alerts-sound-file", "") || "").trim(),
      sound_volume: Math.min(1, Math.max(0, parseFloat(getVal("spacecraft-alerts-sound-volume", "0.8")))),
      tts_volume: Math.min(1, Math.max(0, parseFloat(getVal("spacecraft-alerts-tts-volume", "0.9")))),
      min_elevation_deg: Math.min(90, Math.max(0, parseFloat(getVal("spacecraft-min-elevation", "10")) || 10)),
      craft_ids: craft_ids.length ? craft_ids : ["-255544"],
      announce_pass_start: getChecked("spacecraft-announce-pass-start"),
      announce_pass_peak: getChecked("spacecraft-announce-pass-peak"),
    };
  }

  _collectSolarWeatherAlertsSettings() {
    const s = this.shadowRoot;
    const defaults = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9,
      min_k_index: 5, min_g_scale: 1, min_xray_class: "M",
      announce_flare_events: true, announce_geomagnetic_storm: true,
    };
    if (!s) return { ...(this._settings.solar_weather_alerts || {}), ...defaults };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    return {
      ...(this._settings.solar_weather_alerts || {}),
      enabled: getChecked("solar-weather-alerts-enabled"),
      sound_file: (getVal("solar-weather-alerts-sound-file", "") || "").trim(),
      sound_volume: Math.min(1, Math.max(0, parseFloat(getVal("solar-weather-alerts-sound-volume", "0.8")))),
      tts_volume: Math.min(1, Math.max(0, parseFloat(getVal("solar-weather-alerts-tts-volume", "0.9")))),
      min_k_index: Math.min(9, Math.max(0, parseInt(getVal("solar-min-k-index", "5"), 10) || 5)),
      min_g_scale: Math.min(5, Math.max(0, parseInt(getVal("solar-min-g-scale", "1"), 10) || 1)),
      min_xray_class: (getVal("solar-min-xray-class", "M") || "M").toUpperCase().slice(0, 1),
      announce_flare_events: getChecked("solar-announce-flares"),
      announce_geomagnetic_storm: getChecked("solar-announce-storms"),
    };
  }

  _collectNeoAlertsSettings() {
    const s = this.shadowRoot;
    const defaults = {
      enabled: false, sound_file: "", sound_volume: 0.8, tts_volume: 0.9,
      max_lunar_distances: 5, min_diameter_m: 100,
    };
    if (!s) return { ...(this._settings.neo_alerts || {}), ...defaults };
    const getVal = (id, def) => (s.getElementById(id)?.value ?? def);
    const getChecked = (id) => !!s.getElementById(id)?.checked;
    return {
      ...(this._settings.neo_alerts || {}),
      enabled: getChecked("neo-alerts-enabled"),
      sound_file: (getVal("neo-alerts-sound-file", "") || "").trim(),
      sound_volume: Math.min(1, Math.max(0, parseFloat(getVal("neo-alerts-sound-volume", "0.8")))),
      tts_volume: Math.min(1, Math.max(0, parseFloat(getVal("neo-alerts-tts-volume", "0.9")))),
      max_lunar_distances: Math.max(0.1, parseFloat(getVal("neo-max-lunar-distances", "5")) || 5),
      min_diameter_m: Math.max(0, parseFloat(getVal("neo-min-diameter-m", "100")) || 100),
    };
  }
}

customElements.define("home-weather-panel", HomeWeatherPanel);
