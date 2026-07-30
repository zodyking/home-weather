/**
 * Hurricane Tracker - Leaflet map for NOAA/NHC storm data plus multi-hazard
 * overlays (tornado, earthquake, volcano, wildfire, air quality, travel,
 * lightning). UI/UX redesign notes:
 *  - Storm tracks: dotted muted past track, solid category-colored forecast
 *    track over a contrast casing, restrained cone, category badge markers.
 *  - Right-side status panel with threat hero + per-hazard cards; becomes a
 *    bottom sheet with a collapsed peek on compact layouts.
 *  - Labeled "Layers" menu (44px rows) replaces the unlabeled icon strip.
 *  - Theme-aware chrome via --hw-* custom properties (dark fallbacks) with
 *    [data-hw-theme="light"] overrides; setTheme(mode) hook for the panel.
 */
(function (global) {
  "use strict";

  const STORM_COLORS = ["#e53935", "#fb8c00", "#8e24aa", "#1e88e5", "#43a047"];
  const REFRESH_MS = 15 * 60 * 1000;
  const DARK_TILE_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
  const LIGHT_TILE_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
  const SAT_TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const OCEAN_TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}";
  const CARTO_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
  const ESRI_ATTR = 'Tiles &copy; <a href="https://www.esri.com/">Esri</a>';
  // Saffir-Simpson scale colors keyed by category (0 = TD/TS).
  const CATEGORY_COLORS = Object.freeze({
    0: "#5ebaff", // tropical depression / storm
    1: "#ffffb2",
    2: "#ffe775",
    3: "#ffc140",
    4: "#ff8f20",
    5: "#ff5050",
  });
  const EQ_SCALE = Object.freeze([
    { label: "M 5+", color: "#ef5350" },
    { label: "M 4 – 5", color: "#ff7043" },
    { label: "M 3 – 4", color: "#ffa726" },
    { label: "M < 3", color: "#ffb74d" },
  ]);
  // Contiguous United States bounds (default map view).
  const USA_BOUNDS = Object.freeze([
    [24.396308, -124.848974],
    [49.384358, -66.885444],
  ]);
  /** How long a lightning icon stays on the map before fading out (ms). */
  const LIGHTNING_MAP_DISPLAY_MS = 2400;
  const LIGHTNING_MAP_FADE_MS = 700;
  /** Ignore replayed/historical strikes older than this when flashing on the map. */
  const LIGHTNING_MAP_MAX_STRIKE_AGE_MS = 90 * 1000;
  const LIGHTNING_HISTORY_MS = 60 * 60 * 1000;
  /** Poll server lightning stats (hour count, nearest) without full map reload. */
  const LIGHTNING_POLL_MS = 60 * 1000;

  /** Layer/overlay toggle definitions for the Layers menu. */
  const LAYER_DEFS = Object.freeze([
    { key: "hurricane", label: "Hurricanes", icon: "hurricane", type: "layer" },
    { key: "tornado", label: "Tornadoes", icon: "tornado", type: "layer" },
    { key: "earthquakes", label: "Earthquakes", icon: "earthquake", type: "layer" },
    { key: "volcanoes", label: "Volcanoes", icon: "volcano", type: "layer" },
    { key: "lightning", label: "Lightning", icon: "lightning-bolt", type: "layer" },
    { key: "travel", label: "Travel advisories", icon: "globe", type: "layer" },
    { key: "wildfire", label: "Wildfires", icon: "fire", type: "layer" },
    { key: "air_quality", label: "Air quality", icon: "air-quality", type: "layer" },
    { key: "wind_radii", label: "Wind radii", icon: "wind-radii", type: "overlay" },
    { key: "alert_zones", label: "Alert zones", icon: "alert-zones", type: "overlay" },
  ]);

  class HurricaneTracker {
    constructor(options) {
      this._hass = options.hass;
      this._shadow = options.shadowRoot;
      this._embedded = !!options.embedded;
      this._root = null;
      this._map = null;
      this._layerGroup = null;
      this._homeLayerGroup = null;
      this._homeMarker = null;
      this._homeCoords = options.home || null;
      this._data = null;
      this._tornadoData = null;
      this._earthquakeData = null;
      this._volcanoData = null;
      this._travelData = null;
      this._wildfireData = null;
      this._airQualityData = null;
      this._volcanoClusterGroup = null;
      this._backendLightning = null;
      this._loading = false;
      this._error = null;
      this._showWindRadii = false;
      this._refreshTimer = null;
      this._lightningPollTimer = null;
      this._mapInitialized = false;
      this._earthquakeClusterGroup = null;
      this._lastDetailTier = null;
      this._zoomDebounceTimer = null;
      this._zoomHandlerBound = false;
      this._viewLockHandlerBound = false;
      this._hasInitialFit = false;
      this._lastFitBounds = null;
      this._userViewLocked = false;
      this._mapLayers = { hurricane: true, tornado: false, earthquakes: false, lightning: false, volcanoes: false, travel: false, wildfire: false, air_quality: false };
      this._mapSort = "newest";
      this._lightningSettings = {
        enabled: true,
        show_on_map: true,
        max_age_minutes: 60,
        max_strikes: 500,
        ...(options.lightningSettings || {}),
      };
      this._blitzortungClient = null;
      this._lightningLayerGroup = null;
      this._lightningStrikes = [];
      this._lightningStatus = "off";
      this._lightningCleanupTimer = null;
      this._lightningUnsubStrike = null;
      this._lightningUnsubStatus = null;
      this._measureActive = false;
      this._measurePoints = [];
      this._measureLayer = null;
      this._coordsEl = null;
      this._baseLayers = null;
      this._statusCollapsed = true;
      this._showZones = false;
      this._zoneConfig = Array.isArray(options.zoneConfig) ? options.zoneConfig : [];
      this._theme = "dark";
      this._userChoseBasemap = false;
      this._layersMenuOpen = false;
      this._docDismissHandler = null;
      this._docKeyHandler = null;
    }

    _isCompactLayout() {
      const width = this._root?.clientWidth ?? global.innerWidth ?? 1024;
      return width <= 768;
    }

    /* ------------------------------------------------------------------ */
    /* Public API (contract with weather-panel.js)                        */
    /* ------------------------------------------------------------------ */

    setMapLayers(layers) {
      const prevLightning = this._mapLayers.lightning;
      const merged = { ...this._mapLayers, ...(layers || {}) };
      if (Object.prototype.hasOwnProperty.call(merged, "tropical")) {
        if (!Object.prototype.hasOwnProperty.call(merged, "hurricane")) {
          merged.hurricane = merged.tropical;
        }
        delete merged.tropical;
      }
      this._mapLayers = merged;
      if (layers.lightning !== undefined && layers.lightning !== prevLightning) {
        this._syncLightningLayer();
      }
      this._syncLayerControls();
      if (this._map && this._layerGroup) this._renderMap();
    }

    setOnLayerToggle(callback) {
      this._onLayerToggle = callback;
    }

    setOnOverlayToggle(callback) {
      this._onOverlayToggle = callback;
    }

    setLightningSettings(settings) {
      this._lightningSettings = {
        show_on_map: true,
        max_age_minutes: 60,
        max_strikes: 500,
        ...this._lightningSettings,
        ...(settings || {}),
      };
      this._syncLightningLayer();
    }

    setMapSort(sort) {
      this._mapSort = sort || "newest";
      if (this._map && this._layerGroup) this._renderMap();
    }

    setShowWindRadii(show) {
      this._showWindRadii = !!show;
      this._syncLayerControls();
      if (this._map && this._layerGroup) this._renderMap();
    }

    /**
     * Toggle the "My zones" overlay: translucent per-hazard alert-radius
     * circles around home, driven by the Alert Zones settings.
     * @param {boolean} show
     * @param {Array<{key:string,label:string,color:string,enabled:boolean,zone_mode:string,alert_zone_mode:string,has_alerts:boolean,radius_miles:number}>} [zones]
     */
    setShowZones(show, zones) {
      this._showZones = !!show;
      if (Array.isArray(zones)) this._zoneConfig = zones;
      this._syncLayerControls();
      if (this._map && this._layerGroup) this._renderMap();
    }

    setHomeCoords(home) {
      this._homeCoords = home || null;
      if (this._map) this._renderHomeMarker();
    }

    /** Theme hook called by weather-panel when the user switches themes. */
    setTheme(mode) {
      const next = mode === "light" ? "light" : "dark";
      if (next === this._theme) return;
      this._theme = next;
      // Follow the theme with the matching basemap unless the user explicitly
      // picked one from the basemap menu.
      if (!this._userChoseBasemap && this._baseLayers) {
        this._applyBasemap(next === "light" ? "Light" : "Dark");
      }
      // Re-render vectors so theme-dependent casing/stroke colors update.
      if (this._map && this._layerGroup) this._renderMap();
    }

    async refresh() {
      await this.loadData(true);
      return this._data;
    }

    getLastUpdated() {
      const raw = this._data?.summary?.fetchedAt;
      if (!raw) return null;
      try {
        return new Date(raw).toLocaleString();
      } catch (_) {
        return null;
      }
    }

    invalidateMapSize() {
      this._map?.invalidateSize?.();
    }

    collapseStatusPanel() {
      if (!this._isCompactLayout()) return;
      this._statusCollapsed = true;
      this._syncStatusPanelLayout();
    }

    async init(rootEl) {
      this._root = rootEl;
      const attrTheme = rootEl?.getAttribute?.("data-hw-theme");
      this._theme = attrTheme === "light" ? "light" : "dark";
      this._injectStyles();
      this._renderShell();
      await this._ensureDeps();
      this._bindControls();
      this._bindLayoutObserver();
      this._bindGlobalDismiss();
      await this.loadData();
      this._refreshTimer = setInterval(() => this.loadData(), REFRESH_MS);
      this._startLightningPoll();
    }

    /* ------------------------------------------------------------------ */
    /* Lightning subsystem                                                 */
    /* ------------------------------------------------------------------ */

    _startLightningPoll() {
      this._stopLightningPoll();
      if (!this._hass) return;
      this._lightningPollTimer = setInterval(() => this._pollLightningStats(), LIGHTNING_POLL_MS);
    }

    _stopLightningPoll() {
      if (this._lightningPollTimer) {
        clearInterval(this._lightningPollTimer);
        this._lightningPollTimer = null;
      }
    }

    async _pollLightningStats() {
      if (!this._hass) return;
      try {
        const payload = await this._hass.callWS({ type: "home_weather/get_lightning" });
        if (!payload) return;
        this._backendLightning = payload;
        this._updateLightningStatusDom();
      } catch (_) {
        /* keep last known server stats */
      }
    }

    _bindLayoutObserver() {
      if (this._layoutObserver || !this._root) return;
      let lastCompact = this._isCompactLayout();
      this._layoutObserver = new ResizeObserver(() => {
        const compact = this._isCompactLayout();
        this._syncStatusPanelLayout();
        this._map?.invalidateSize?.();
        if (compact !== lastCompact) {
          lastCompact = compact;
          if (compact) this._statusCollapsed = true;
          const aside = this._root?.querySelector(".hurricane-status");
          if (aside && this._data) {
            aside.outerHTML = this._buildStatusPanelHtml();
            this._bindStatusPanelToggle();
            this._syncStatusPanelLayout();
            this._updateLightningStatusDom();
          }
          requestAnimationFrame(() => this._map?.invalidateSize?.());
        }
      });
      this._layoutObserver.observe(this._root);
    }

    destroy() {
      if (this._refreshTimer) {
        clearInterval(this._refreshTimer);
        this._refreshTimer = null;
      }
      this._stopLightningPoll();
      this._layoutObserver?.disconnect();
      this._layoutObserver = null;
      this._stopLightning(true);
      if (this._docDismissHandler) {
        document.removeEventListener("click", this._docDismissHandler);
        this._docDismissHandler = null;
      }
      if (this._docKeyHandler) {
        document.removeEventListener("keydown", this._docKeyHandler);
        this._docKeyHandler = null;
      }
      if (this._map) {
        this._map.remove();
        this._map = null;
        this._mapInitialized = false;
        this._earthquakeClusterGroup = null;
        this._volcanoClusterGroup = null;
        this._homeLayerGroup = null;
        this._homeMarker = null;
        this._zoomHandlerBound = false;
        this._viewLockHandlerBound = false;
        this._lastDetailTier = null;
        this._hasInitialFit = false;
        this._userViewLocked = false;
        this._resetMapControlState();
      }
    }

    _resetMapControlState() {
      this._measureActive = false;
      this._measurePoints = [];
      this._measureLayer = null;
      this._measureBtn = null;
      this._measureReadout = null;
      this._measureClickHandler = null;
      this._measureDblHandler = null;
      this._coordsEl = null;
      this._baseLayers = null;
      this._lightningLayerGroup = null;
      this._layersMenuOpen = false;
    }

    _getLightningSettings() {
      return {
        show_on_map: true,
        max_age_minutes: 60,
        max_strikes: 500,
        ...(this._lightningSettings || {}),
      };
    }

    _lightningEnabled() {
      const settings = this._getLightningSettings();
      if (settings.enabled === false) return false;
      return this._mapLayers.lightning !== false && settings.show_on_map !== false;
    }

    _haversineMiles(lat1, lon1, lat2, lon2) {
      const R = 3958.8;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    _distanceFromHomeMiles(lat, lon) {
      const home = this._data?.home;
      if (home?.lat == null || home?.lon == null || lat == null || lon == null) return null;
      return this._haversineMiles(home.lat, home.lon, lat, lon);
    }

    _formatLightningStatus(status) {
      const labels = {
        live: "Live",
        connecting: "Connecting…",
        reconnecting: "Reconnecting…",
        error: "Error",
        disabled: "Disabled",
        off: "Off",
      };
      return labels[status] || "Off";
    }

    _getLightningStats() {
      const backend = this._backendLightning;
      if (backend?.feed_status === "disabled") {
        return {
          visibleCount: backend.geofield_count ?? 0,
          hourCount: backend.strikes_last_hour ?? 0,
          nearestMiles: backend.nearest_distance_miles ?? null,
          status: "disabled",
        };
      }

      const browserFeedActive = this._lightningEnabled() && this._lightningStatus === "live";
      const visibleCount = browserFeedActive
        ? this._lightningStrikes.filter((e) => e.marker).length
        : (backend?.geofield_count ?? this._lightningStrikes.filter((e) => e.marker).length);

      // Hour count and nearest distance come from the HA server (rolling counter, not client buffer).
      if (backend && backend.feed_status && backend.feed_status !== "off") {
        return {
          visibleCount,
          hourCount: backend.strikes_last_hour ?? 0,
          nearestMiles: backend.nearest_distance_miles ?? null,
          status: browserFeedActive ? this._lightningStatus : backend.feed_status,
        };
      }

      const now = Date.now();
      const hourAgo = now - LIGHTNING_HISTORY_MS;
      const recent = this._lightningStrikes.filter((e) => e.strike.timeMs >= hourAgo);
      let nearest = null;
      recent.forEach((e) => {
        const d = this._distanceFromHomeMiles(e.strike.lat, e.strike.lon);
        if (d != null && (nearest == null || d < nearest)) nearest = d;
      });
      return {
        visibleCount,
        hourCount: recent.length,
        nearestMiles: nearest,
        status: this._lightningStatus,
      };
    }

    _updateLightningStatusDom() {
      const stats = this._getLightningStats();
      const root = this._root;
      if (!root) return;
      const countEl = root.querySelector("#hw-lightning-count");
      const nearestEl = root.querySelector("#hw-lightning-nearest");
      const statusEl = root.querySelector("#hw-lightning-status");
      if (countEl) countEl.textContent = String(stats.hourCount);
      if (nearestEl) nearestEl.textContent = stats.nearestMiles != null ? this._fmtMiles(stats.nearestMiles) : "—";
      if (statusEl) {
        statusEl.textContent = this._formatLightningStatus(stats.status);
        statusEl.classList.remove("is-live", "is-danger");
        if (stats.status === "live") statusEl.classList.add("is-live");
        else if (stats.status === "error" || stats.status === "disabled") statusEl.classList.add("is-danger");
      }
      const badge = root.querySelector("#hw-lightning-badge");
      if (badge) badge.textContent = String(stats.visibleCount);
    }

    _syncLightningLayer() {
      if (!this._map) return;
      const enabled = this._lightningEnabled();
      if (enabled) {
        if (this._lightningLayerGroup && !this._map.hasLayer(this._lightningLayerGroup)) {
          this._lightningLayerGroup.addTo(this._map);
        }
        this._startLightning();
      } else {
        this._stopLightning(false);
        if (this._lightningLayerGroup && this._map.hasLayer(this._lightningLayerGroup)) {
          this._map.removeLayer(this._lightningLayerGroup);
        }
      }
      this._updateLightningStatusDom();
    }

    _startLightning() {
      if (!global.BlitzortungClient) return;
      if (this._blitzortungClient) return;
      const client = new global.BlitzortungClient();
      this._blitzortungClient = client;
      this._lightningUnsubStrike = client.onStrike((strike) => this._onLightningStrike(strike));
      this._lightningUnsubStatus = client.onStatus((status) => {
        this._lightningStatus = status;
        this._updateLightningStatusDom();
      });
      client.connect();
      if (!this._lightningCleanupTimer) {
        this._lightningCleanupTimer = setInterval(() => this._cleanupLightningStrikes(), 2000);
      }
    }

    _clearLightningEntryTimers(entry) {
      if (!entry) return;
      if (entry.fadeTimer) {
        clearTimeout(entry.fadeTimer);
        entry.fadeTimer = null;
      }
      if (entry.removeTimer) {
        clearTimeout(entry.removeTimer);
        entry.removeTimer = null;
      }
    }

    _removeLightningMarkerEntry(entry, { dropRecord = false } = {}) {
      if (!entry) return;
      this._clearLightningEntryTimers(entry);
      if (entry.marker && this._lightningLayerGroup) {
        this._lightningLayerGroup.removeLayer(entry.marker);
      }
      entry.marker = null;
      if (dropRecord) {
        const idx = this._lightningStrikes.indexOf(entry);
        if (idx >= 0) this._lightningStrikes.splice(idx, 1);
      }
    }

    _scheduleLightningMarkerFade(entry) {
      const fadeDelay = Math.max(0, LIGHTNING_MAP_DISPLAY_MS - LIGHTNING_MAP_FADE_MS);
      entry.fadeTimer = setTimeout(() => {
        entry.fadeTimer = null;
        const wrap = entry.marker?.getElement?.()?.querySelector(".hw-hazard-icon-wrap");
        if (wrap) {
          wrap.classList.remove("is-fresh");
          wrap.classList.add("is-fading");
        }
      }, fadeDelay);
      entry.removeTimer = setTimeout(() => {
        entry.removeTimer = null;
        this._removeLightningMarkerEntry(entry);
        this._updateLightningStatusDom();
      }, LIGHTNING_MAP_DISPLAY_MS);
    }

    _stopLightning(clearAll) {
      if (this._lightningUnsubStrike) {
        this._lightningUnsubStrike();
        this._lightningUnsubStrike = null;
      }
      if (this._lightningUnsubStatus) {
        this._lightningUnsubStatus();
        this._lightningUnsubStatus = null;
      }
      if (this._blitzortungClient) {
        this._blitzortungClient.close();
        this._blitzortungClient = null;
      }
      if (this._lightningCleanupTimer) {
        clearInterval(this._lightningCleanupTimer);
        this._lightningCleanupTimer = null;
      }
      this._lightningStatus = "off";
      if (clearAll) {
        this._lightningStrikes.forEach((e) => this._removeLightningMarkerEntry(e, { dropRecord: true }));
        this._lightningStrikes = [];
        this._lightningLayerGroup?.clearLayers();
      }
      this._updateLightningStatusDom();
    }

    _onLightningStrike(strike) {
      if (!this._lightningEnabled() || !this._lightningLayerGroup || !global.L) return;
      const settings = this._getLightningSettings();
      const maxRecords = Math.max(50, Number(settings.max_strikes) || 500);
      if (this._lightningStrikes.some((e) => e.strike.id === strike.id)) return;

      const strikeAgeMs = Date.now() - strike.timeMs;
      if (strikeAgeMs > LIGHTNING_MAP_MAX_STRIKE_AGE_MS) return;

      const marker = this._addLightningMarker(strike);
      if (!marker) return;

      const entry = { strike, marker, fadeTimer: null, removeTimer: null };
      this._lightningStrikes.push(entry);
      this._scheduleLightningMarkerFade(entry);

      while (this._lightningStrikes.length > maxRecords) {
        const oldest = this._lightningStrikes.shift();
        this._removeLightningMarkerEntry(oldest);
      }

      this._cleanupLightningStrikes();
      this._updateLightningStatusDom();
    }

    _addLightningMarker(strike) {
      const L = global.L;
      if (!L || !this._lightningLayerGroup) return null;
      const dist = this._distanceFromHomeMiles(strike.lat, strike.lon);
      const timeStr = strike.timeMs ? new Date(strike.timeMs).toLocaleString() : "—";
      const popup = [
        "<strong>Lightning strike</strong>",
        `Time: ${this._esc(timeStr)}`,
        `Location: ${strike.lat.toFixed(3)}°, ${strike.lon.toFixed(3)}°`,
        dist != null ? `Distance from home: ${Math.round(dist)} mi` : "",
        `Polarity: ${strike.polarity}`,
        `<a href="https://www.blitzortung.org" target="_blank" rel="noopener noreferrer">Blitzortung.org</a>`,
      ].filter(Boolean).join("<br/>");

      const icon = this._createHazardIcon("lightning-bolt", {
        size: 22,
        className: "hw-lightning-marker is-fresh",
      });
      const marker = L.marker([strike.lat, strike.lon], {
        icon,
        zIndexOffset: 420,
      });
      marker.bindPopup(popup);
      marker.addTo(this._lightningLayerGroup);
      return marker;
    }

    _cleanupLightningStrikes() {
      const now = Date.now();
      const historyCutoff = now - LIGHTNING_HISTORY_MS;
      this._lightningStrikes = this._lightningStrikes.filter((entry) => {
        if (entry.strike.timeMs < historyCutoff) {
          this._removeLightningMarkerEntry(entry);
          return false;
        }
        if (entry.marker && entry.removeTimer == null && entry.strike.timeMs < now - LIGHTNING_MAP_DISPLAY_MS) {
          this._removeLightningMarkerEntry(entry);
        }
        return true;
      });
      this._updateLightningStatusDom();
    }

    /* ------------------------------------------------------------------ */
    /* Styles                                                              */
    /* ------------------------------------------------------------------ */

    _injectStyles() {
      if (this._shadow.querySelector("#hurricane-tracker-styles")) return;
      const style = document.createElement("style");
      style.id = "hurricane-tracker-styles";
      style.textContent = `
        /* ---- design tokens -------------------------------------------- */
        .hurricane-layout {
          --hz-bg: var(--hw-bg, #0f1216);
          --hz-surface: var(--hw-surface, #171b22);
          --hz-elevated: var(--hw-elevated, #1f2530);
          --hz-hover: var(--hw-hover, #242b38);
          --hz-border: var(--hw-border, rgba(255, 255, 255, 0.08));
          --hz-border-strong: var(--hw-border-strong, rgba(255, 255, 255, 0.16));
          --hz-text: var(--hw-text, #e8ecf1);
          --hz-muted: var(--hw-muted, #9aa5b1);
          --hz-accent: var(--hw-accent, #03a9f4);
          --hz-accent-hover: var(--hw-accent-hover, #29b6f6);
          --hz-ok: #4caf7d;
          --hz-watch: #ffb74d;
          --hz-danger: #ef5350;
          --hz-glass: rgba(16, 20, 27, 0.9);
          --hz-glass-border: rgba(255, 255, 255, 0.14);
          --hz-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
          --hz-shadow-soft: 0 4px 16px rgba(0, 0, 0, 0.35);
          --hz-tap: 44px;
          --hz-peek: 92px;
          position: relative;
          width: 100%;
          height: 100%;
          min-height: 0;
          flex: 1;
          display: flex;
          flex-direction: row;
          align-items: stretch;
          padding: 0;
          margin: 0;
          max-width: none;
          box-sizing: border-box;
          overflow: hidden;
          color: var(--hz-text);
        }
        [data-hw-theme="light"] .hurricane-layout {
          --hz-glass: rgba(255, 255, 255, 0.93);
          --hz-glass-border: rgba(20, 32, 48, 0.14);
          --hz-shadow: 0 8px 28px rgba(28, 40, 58, 0.2);
          --hz-shadow-soft: 0 4px 16px rgba(28, 40, 58, 0.14);
        }
        .hurricane-layout *,
        .hurricane-layout *::before,
        .hurricane-layout *::after {
          box-sizing: border-box;
        }

        /* ---- map stage -------------------------------------------------- */
        .hurricane-map-wrap {
          position: relative;
          flex: 1 1 auto;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
          z-index: 1;
          background: var(--hz-bg);
        }
        .hurricane-map {
          position: absolute;
          inset: 0;
          background: var(--hz-bg);
          isolation: isolate;
          z-index: 1;
        }
        .leaflet-container {
          font-family: inherit;
          background: var(--hz-bg);
        }

        /* ---- loading / empty / error ------------------------------------ */
        .hurricane-loading {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 14px;
          height: 100%;
          color: var(--hw-muted, #9aa5b1);
          text-align: center;
          font-size: 13px;
        }
        .hz-spinner {
          width: 26px;
          height: 26px;
          border-radius: 50%;
          border: 3px solid var(--hw-border-strong, rgba(255,255,255,0.16));
          border-top-color: var(--hw-accent, #03a9f4);
          animation: hz-spin 0.9s linear infinite;
        }
        @keyframes hz-spin { to { transform: rotate(360deg); } }
        .hurricane-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          padding: 48px 16px;
          color: var(--hz-muted);
          text-align: center;
        }
        .hurricane-empty button,
        .hurricane-loading button {
          min-height: var(--hz-tap, 44px);
          padding: 10px 22px;
          border-radius: 10px;
          border: 1px solid var(--hw-border-strong, rgba(255,255,255,0.16));
          background: var(--hw-accent, #0288d1);
          color: #fff;
          font-size: 13px;
          font-weight: 600;
          font-family: inherit;
          cursor: pointer;
        }

        /* ---- status panel: shared ---------------------------------------- */
        .hurricane-status {
          position: relative;
          flex: 0 0 clamp(280px, 30%, 344px);
          width: clamp(280px, 30%, 344px);
          max-width: 344px;
          height: 100%;
          min-height: 0;
          display: flex;
          flex-direction: column;
          z-index: 20;
          color: var(--hz-text);
          background: var(--hz-surface);
          border-left: 1px solid var(--hz-border-strong);
          isolation: isolate;
          --primary-text-color: var(--hz-text);
          --secondary-text-color: var(--hz-muted);
          --card-background-color: var(--hz-surface);
        }
        .hurricane-status.is-threat-high { box-shadow: inset 3px 0 0 var(--hz-danger); }
        .hurricane-status.is-threat-watch { box-shadow: inset 3px 0 0 var(--hz-watch); }
        .hurricane-status a { color: var(--hz-accent-hover); }
        .hurricane-status a:visited { color: var(--hz-accent-hover); }

        .hz-sheet-head {
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 14px 16px 12px;
          border-bottom: 1px solid var(--hz-border);
          background: var(--hz-surface);
        }
        .hz-grabber {
          display: none;
          width: 40px;
          height: 4px;
          margin: 0 auto 4px;
          border-radius: 999px;
          background: var(--hz-border-strong);
        }
        .hz-head-row {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }
        .hz-head-title {
          margin: 0;
          font-size: 14px;
          font-weight: 700;
          letter-spacing: 0.02em;
          color: var(--hz-text);
          flex: 1 1 auto;
          min-width: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .hz-threat-pill {
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 3px 10px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.09em;
          text-transform: uppercase;
          white-space: nowrap;
        }
        .hz-threat-pill::before {
          content: "";
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: currentColor;
        }
        .hz-threat-pill.is-ok {
          color: var(--hz-ok);
          background: rgba(76, 175, 125, 0.14);
          border: 1px solid rgba(76, 175, 125, 0.4);
        }
        .hz-threat-pill.is-watch {
          color: var(--hz-watch);
          background: rgba(255, 183, 77, 0.14);
          border: 1px solid rgba(255, 183, 77, 0.45);
        }
        .hz-threat-pill.is-danger {
          color: var(--hz-danger);
          background: rgba(239, 83, 80, 0.14);
          border: 1px solid rgba(239, 83, 80, 0.5);
        }
        .hz-headline {
          margin: 0;
          font-size: 13px;
          font-weight: 600;
          line-height: 1.45;
          color: var(--hz-text);
        }
        .hz-headline.is-watch { color: var(--hz-watch); }
        .hz-headline.is-danger { color: var(--hz-danger); }
        .hz-updated {
          margin: 0;
          font-size: 11px;
          color: var(--hz-muted);
        }
        .hz-sheet-toggle {
          display: none;
          flex-shrink: 0;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
          margin: -4px -6px -4px 0;
          padding: 0;
          border: none;
          border-radius: 10px;
          background: transparent;
          color: var(--hz-muted);
          cursor: pointer;
          line-height: 1;
        }
        .hz-sheet-toggle:hover { background: var(--hz-hover); color: var(--hz-text); }
        .hz-sheet-toggle svg { transition: transform 0.18s ease; }
        .hurricane-status:not(.is-collapsed) .hz-sheet-toggle svg { transform: rotate(180deg); }

        .hurricane-status-scroll {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
          -webkit-overflow-scrolling: touch;
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 12px 12px 14px;
          padding-bottom: max(14px, env(safe-area-inset-bottom, 0px));
          background: var(--hz-surface);
          scrollbar-width: thin;
          scrollbar-color: var(--hz-border-strong) transparent;
        }
        .hurricane-status-scroll::-webkit-scrollbar { width: 6px; }
        .hurricane-status-scroll::-webkit-scrollbar-thumb {
          background: var(--hz-border-strong);
          border-radius: 3px;
        }
        .hurricane-status-scroll::-webkit-scrollbar-track { background: transparent; }

        .hurricane-banner {
          flex-shrink: 0;
          padding: 10px 12px;
          border-radius: 10px;
          font-size: 12px;
          line-height: 1.45;
          background: rgba(255, 152, 0, 0.14);
          color: var(--hz-watch);
          border: 1px solid rgba(255, 152, 0, 0.4);
        }

        /* ---- hazard cards ------------------------------------------------ */
        .hz-card {
          flex-shrink: 0;
          border: 1px solid var(--hz-border);
          border-radius: 12px;
          background: var(--hz-elevated);
          overflow: hidden;
        }
        .hz-card summary {
          list-style: none;
          display: flex;
          align-items: center;
          gap: 10px;
          min-height: var(--hz-tap, 44px);
          padding: 8px 12px;
          cursor: pointer;
          user-select: none;
        }
        .hz-card summary::-webkit-details-marker { display: none; }
        .hz-card summary:hover { background: var(--hz-hover); }
        .hz-card summary:focus-visible {
          outline: 2px solid var(--hz-accent-hover);
          outline-offset: -2px;
          border-radius: 12px;
        }
        .hz-card-icon {
          width: 22px;
          height: 22px;
          flex-shrink: 0;
        }
        .hz-card-titles {
          display: flex;
          flex-direction: column;
          gap: 1px;
          flex: 1 1 auto;
          min-width: 0;
        }
        .hz-card-title {
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.02em;
          color: var(--hz-text);
        }
        .hz-card-lead {
          font-size: 11px;
          line-height: 1.35;
          color: var(--hz-muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .hz-card-value {
          flex-shrink: 0;
          font-size: 15px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          color: var(--hz-text);
          max-width: 40%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .hz-card-value.is-warning { color: var(--hz-watch); }
        .hz-card-value.is-danger { color: var(--hz-danger); }
        .hz-card-value.is-quiet { color: var(--hz-muted); font-weight: 600; }
        .hz-card-chevron {
          flex-shrink: 0;
          font-size: 11px;
          color: var(--hz-muted);
          transition: transform 0.15s ease;
        }
        .hz-card[open] .hz-card-chevron { transform: rotate(180deg); }
        .hz-card-body {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 10px 12px 12px;
          border-top: 1px solid var(--hz-border);
          background: var(--hz-surface);
        }
        .hz-row {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          gap: 12px;
          font-size: 12px;
          line-height: 1.45;
          color: var(--hz-muted);
        }
        .hz-row > span { flex: 1 1 auto; min-width: 0; }
        .hz-row strong {
          color: var(--hz-text);
          font-weight: 600;
          text-align: right;
          flex: 0 1 auto;
          min-width: 0;
          overflow-wrap: anywhere;
        }
        .hz-row.is-warning strong { color: var(--hz-watch); }
        .hz-row.is-danger strong { color: var(--hz-danger); }
        .hz-row strong.is-live { color: #ffc107; }
        .hz-row strong.is-danger { color: var(--hz-danger); }

        /* ---- compact layout: bottom sheet -------------------------------- */
        .hurricane-layout.is-compact .hurricane-map-wrap {
          position: absolute;
          inset: 0;
        }
        .hurricane-layout.is-compact .hurricane-status {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          top: auto;
          flex: none;
          width: auto;
          max-width: none;
          height: auto;
          max-height: min(72%, 540px);
          border: 1px solid var(--hz-border-strong);
          border-bottom: none;
          border-radius: 16px 16px 0 0;
          box-shadow: 0 -10px 34px rgba(0, 0, 0, 0.45);
          z-index: 1200;
        }
        [data-hw-theme="light"] .hurricane-layout.is-compact .hurricane-status {
          box-shadow: 0 -10px 34px rgba(28, 40, 58, 0.22);
        }
        .hurricane-layout.is-compact .hurricane-status.is-threat-high { box-shadow: inset 0 3px 0 var(--hz-danger), 0 -10px 34px rgba(0,0,0,0.45); }
        .hurricane-layout.is-compact .hurricane-status.is-threat-watch { box-shadow: inset 0 3px 0 var(--hz-watch), 0 -10px 34px rgba(0,0,0,0.45); }
        .hurricane-layout.is-compact .hz-grabber { display: block; }
        .hurricane-layout.is-compact .hz-sheet-toggle { display: inline-flex; }
        .hurricane-layout.is-compact .hz-sheet-head {
          cursor: pointer;
          border-radius: 16px 16px 0 0;
          padding: 8px 16px 10px;
          padding-bottom: max(10px, env(safe-area-inset-bottom, 0px));
        }
        .hurricane-layout.is-compact .hurricane-status:not(.is-collapsed) .hz-sheet-head {
          padding-bottom: 10px;
        }
        .hurricane-layout.is-compact .hurricane-status.is-collapsed .hurricane-status-scroll {
          display: none;
        }
        .hurricane-layout.is-compact .hurricane-status.is-collapsed .hz-headline {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .hurricane-layout.is-compact .hurricane-status.is-collapsed .hz-updated { display: none; }
        /* Keep leaflet attribution visible above the collapsed sheet. */
        .hurricane-layout.is-compact .leaflet-control-attribution {
          bottom: calc(var(--hz-peek, 92px) + 2px) !important;
        }

        /* ---- layers control ----------------------------------------------- */
        .hw-layers-ctl {
          position: absolute;
          left: 12px;
          bottom: 12px;
          z-index: 1080;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 8px;
        }
        .hurricane-layout.is-compact .hw-layers-ctl {
          bottom: calc(var(--hz-peek, 92px) + 12px);
        }
        .hw-layers-fab {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          min-height: var(--hz-tap, 44px);
          padding: 0 14px;
          border: 1px solid var(--hz-glass-border);
          border-radius: 999px;
          background: var(--hz-glass);
          color: var(--hz-text);
          font-size: 13px;
          font-weight: 600;
          font-family: inherit;
          cursor: pointer;
          box-shadow: var(--hz-shadow-soft);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
        }
        .hw-layers-fab:hover { background: var(--hz-hover); }
        .hw-layers-fab:focus-visible {
          outline: 2px solid var(--hz-accent-hover);
          outline-offset: 2px;
        }
        .hw-layers-fab svg { flex-shrink: 0; }
        .hw-layers-count {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 20px;
          height: 20px;
          padding: 0 6px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          color: #fff;
          background: var(--hz-accent);
        }
        .hw-layers-menu {
          width: 268px;
          max-width: min(80vw, 300px);
          max-height: min(400px, 52vh);
          overflow-y: auto;
          overscroll-behavior: contain;
          padding: 6px;
          border: 1px solid var(--hz-glass-border);
          border-radius: 14px;
          background: var(--hz-glass);
          box-shadow: var(--hz-shadow);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          scrollbar-width: thin;
        }
        .hw-layers-menu[hidden] { display: none; }
        .hw-layers-menu-head {
          padding: 8px 10px 4px;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--hz-muted);
        }
        .hw-layers-group-label {
          padding: 8px 10px 2px;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--hz-muted);
          opacity: 0.85;
        }
        .hw-layer-row {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 100%;
          min-height: var(--hz-tap, 44px);
          padding: 6px 10px;
          border: none;
          border-radius: 10px;
          background: transparent;
          color: var(--hz-text);
          font-size: 13px;
          font-family: inherit;
          text-align: left;
          cursor: pointer;
        }
        .hw-layer-row:hover { background: var(--hz-hover); }
        .hw-layer-row:focus-visible {
          outline: 2px solid var(--hz-accent-hover);
          outline-offset: -2px;
        }
        .hw-layer-row img {
          width: 22px;
          height: 22px;
          flex-shrink: 0;
          opacity: 0.55;
        }
        .hw-layer-row.is-on img { opacity: 1; }
        .hw-layer-label {
          flex: 1 1 auto;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .hw-layer-switch {
          flex-shrink: 0;
          position: relative;
          width: 34px;
          height: 20px;
          border-radius: 999px;
          background: var(--hz-border-strong);
          transition: background 0.15s ease;
        }
        .hw-layer-switch::after {
          content: "";
          position: absolute;
          top: 2px;
          left: 2px;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: #fff;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
          transition: transform 0.15s ease;
        }
        .hw-layer-row.is-on .hw-layer-switch { background: var(--hz-accent); }
        .hw-layer-row.is-on .hw-layer-switch::after { transform: translateX(14px); }

        /* ---- coords / scale readout --------------------------------------- */
        .hw-map-readout {
          position: absolute;
          right: 8px;
          bottom: 20px;
          z-index: 1060;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 4px 10px;
          border-radius: 8px;
          border: 1px solid var(--hz-glass-border);
          background: var(--hz-glass);
          color: var(--hz-muted);
          font-size: 11px;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
          pointer-events: none;
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
        }
        .hurricane-layout.is-compact .hw-map-readout { display: none; }
        .hw-map-readout .hw-scale-wrap {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .hw-map-readout .hw-scale-line {
          display: inline-block;
          height: 5px;
          border-left: 1px solid currentColor;
          border-right: 1px solid currentColor;
          border-bottom: 1px solid currentColor;
          min-width: 40px;
        }

        /* ---- top-left toolbar stack + legend ------------------------------- */
        .hw-map-controls-stack {
          --hw-map-btn: var(--hz-tap, 44px);
          --hw-map-stack-width: 178px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          width: var(--hw-map-stack-width);
          background: transparent;
          border: none;
          box-shadow: none;
        }
        .hw-map-toolbar {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          width: 100%;
          background: var(--hz-glass);
          border: 1px solid var(--hz-glass-border);
          border-radius: 12px;
          overflow: visible;
          box-shadow: var(--hz-shadow-soft);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
        }
        .hw-map-tool-cell {
          position: relative;
          display: flex;
          align-items: stretch;
          min-width: 0;
          min-height: var(--hw-map-btn);
        }
        .hw-map-tool-cell + .hw-map-tool-cell {
          border-left: 1px solid var(--hz-glass-border);
        }
        .hw-map-tool-cell:first-child .hw-map-tool-btn { border-radius: 11px 0 0 11px; }
        .hw-map-tool-cell:last-child .hw-map-tool-btn { border-radius: 0 11px 11px 0; }
        .hw-map-tool-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: var(--hw-map-btn);
          min-height: var(--hw-map-btn);
          padding: 0;
          margin: 0;
          border: none;
          border-radius: 0;
          background: transparent;
          color: var(--hz-text);
          font-size: 18px;
          font-weight: 600;
          line-height: 1;
          cursor: pointer;
          font-family: inherit;
        }
        .hw-map-tool-btn:hover { background: var(--hz-hover); }
        .hw-map-tool-btn:focus-visible {
          outline: 2px solid var(--hz-accent-hover);
          outline-offset: -2px;
          z-index: 1;
        }
        .hw-map-tool-btn.active {
          background: var(--hz-accent);
          color: #fff;
        }
        .hw-basemap-cell { z-index: 2; }
        .hw-basemap-menu {
          position: absolute;
          top: calc(100% + 6px);
          left: 0;
          z-index: 30;
          min-width: 150px;
          padding: 4px;
          background: var(--hz-glass);
          border: 1px solid var(--hz-glass-border);
          border-radius: 10px;
          box-shadow: var(--hz-shadow);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
        }
        .hw-basemap-menu[hidden] { display: none; }
        .hw-basemap-option {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          min-height: 36px;
          padding: 8px 10px;
          border: none;
          border-radius: 7px;
          background: transparent;
          color: var(--hz-text);
          font-size: 12px;
          font-family: inherit;
          text-align: left;
          cursor: pointer;
        }
        .hw-basemap-option:hover { background: var(--hz-hover); }
        .hw-basemap-option:focus-visible {
          outline: 2px solid var(--hz-accent-hover);
          outline-offset: -2px;
        }
        .hw-basemap-check {
          width: 14px;
          flex-shrink: 0;
          color: var(--hz-accent-hover);
          font-size: 11px;
          font-weight: 700;
        }
        .hw-map-controls-stack .hw-measure-readout-row {
          display: none;
          width: 100%;
          padding: 5px 10px;
          font-size: 11px;
          font-weight: 600;
          color: var(--hz-text);
          background: var(--hz-glass);
          border: 1px solid var(--hz-glass-border);
          border-radius: 10px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          font-variant-numeric: tabular-nums;
        }
        .hw-map-controls-stack.measure-active .hw-measure-readout-row { display: block; }

        .hw-legend {
          background: var(--hz-glass);
          border: 1px solid var(--hz-glass-border);
          border-radius: 12px;
          color: var(--hz-text);
          overflow: hidden;
          width: 100%;
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          box-shadow: var(--hz-shadow-soft);
        }
        .hw-legend-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          min-height: 40px;
          padding: 8px 12px;
          cursor: pointer;
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--hz-muted);
          user-select: none;
        }
        .hw-legend-header:hover { color: var(--hz-text); }
        .hw-legend-header:focus-visible {
          outline: 2px solid var(--hz-accent-hover);
          outline-offset: -2px;
          border-radius: 12px;
        }
        .hw-legend-caret { transition: transform 0.15s ease; }
        .hw-legend.collapsed .hw-legend-caret { transform: rotate(-90deg); }
        .hw-legend.collapsed .hw-legend-body { display: none; }
        .hw-legend-body {
          padding: 2px 12px 12px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          max-height: min(340px, 44vh);
          overflow-y: auto;
          overscroll-behavior: contain;
          scrollbar-width: thin;
        }
        .hw-legend-group { display: flex; flex-direction: column; gap: 5px; }
        .hw-legend-group-title {
          font-size: 9px;
          font-weight: 800;
          letter-spacing: 0.09em;
          text-transform: uppercase;
          color: var(--hz-muted);
        }
        .hw-legend-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 11px;
          line-height: 1.3;
          color: var(--hz-text);
        }
        .hw-legend-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
        .hw-legend-badge {
          width: 18px;
          height: 18px;
          flex-shrink: 0;
          border-radius: 50%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 9px;
          font-weight: 800;
          color: #10151c;
          border: 1px solid rgba(255, 255, 255, 0.75);
        }
        .hw-legend-swatch {
          width: 13px;
          height: 13px;
          border-radius: 3px;
          flex-shrink: 0;
          border: 1px solid rgba(128, 128, 128, 0.6);
        }
        .hw-legend-line {
          width: 24px;
          height: 0;
          flex-shrink: 0;
          border-top: 3px solid currentColor;
        }
        .hw-legend-line.is-past {
          color: #94a3b1;
          border-top-style: dotted;
          border-top-width: 4px;
        }
        .hw-legend-line.is-fcst { color: #e53935; }
        .hw-legend-line.is-watchline { color: #f44336; }
        .hw-legend img { width: 15px; height: 15px; flex-shrink: 0; }

        /* ---- leaflet chrome ------------------------------------------------ */
        .leaflet-bar {
          border: 1px solid var(--hz-border-strong);
          box-shadow: var(--hz-shadow-soft);
        }
        .leaflet-control-attribution {
          position: absolute !important;
          bottom: 2px !important;
          right: 4px !important;
          left: auto !important;
          background: transparent !important;
          color: rgba(158, 158, 158, 0.75) !important;
          font-size: 10px !important;
          padding: 0 4px !important;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
          white-space: nowrap;
        }
        [data-hw-theme="light"] .leaflet-control-attribution {
          color: rgba(90, 100, 112, 0.9) !important;
          text-shadow: 0 1px 2px rgba(255, 255, 255, 0.8);
        }
        .leaflet-control-attribution a { color: rgba(41, 182, 246, 0.85) !important; }
        .leaflet-control-attribution a:hover { color: var(--hw-accent-hover, #29b6f6) !important; }
        .leaflet-popup-content-wrapper {
          background: var(--hw-surface, #171b22);
          color: var(--hw-text, #e8ecf1);
          border-radius: 12px;
          box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
          border: 1px solid var(--hw-border-strong, rgba(255, 255, 255, 0.16));
        }
        .leaflet-popup-content {
          margin: 12px 14px;
          font-size: 13px;
          line-height: 1.5;
        }
        .leaflet-popup-content a { color: var(--hw-accent-hover, #29b6f6); }
        .leaflet-popup-tip {
          background: var(--hw-surface, #171b22);
          border: 1px solid var(--hw-border-strong, rgba(255, 255, 255, 0.16));
          box-shadow: none;
        }
        .leaflet-popup-close-button {
          color: var(--hw-muted, #9aa5b1) !important;
          font-size: 20px !important;
          padding: 6px 8px 0 0 !important;
        }
        .leaflet-popup-close-button:hover { color: var(--hw-text, #fff) !important; }
        .leaflet-container .leaflet-popup-close-button {
          width: 26px;
          height: 26px;
        }

        /* ---- tooltips -------------------------------------------------------- */
        .leaflet-tooltip.hw-tip {
          background: var(--hw-surface, #171b22);
          color: var(--hw-text, #e8ecf1);
          border: 1px solid var(--hw-border-strong, rgba(255, 255, 255, 0.16));
          border-radius: 8px;
          padding: 6px 9px;
          font-size: 11px;
          line-height: 1.45;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
          white-space: nowrap;
        }
        .leaflet-tooltip.hw-tip::before { display: none; }
        .hw-tip .hw-tip-line1 { font-weight: 700; }
        .hw-tip .hw-tip-line2 { color: var(--hw-muted, #9aa5b1); }
        .leaflet-tooltip.hw-fcst-hour {
          background: rgba(16, 20, 27, 0.85);
          color: #eef3f8;
          border: 1px solid rgba(255, 255, 255, 0.22);
          border-radius: 999px;
          padding: 1px 7px;
          font-size: 10px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
        }
        [data-hw-theme="light"] .leaflet-tooltip.hw-fcst-hour {
          background: rgba(255, 255, 255, 0.9);
          color: #23303e;
          border-color: rgba(20, 32, 48, 0.25);
        }
        .leaflet-tooltip.hw-fcst-hour::before { display: none; }
        .leaflet-tooltip.hw-name-label {
          background: var(--hw-surface, #171b22);
          color: var(--hw-text, #ffffff);
          border: 1px solid var(--hw-border-strong, rgba(255, 255, 255, 0.16));
          border-radius: 8px;
          padding: 2px 9px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.02em;
          white-space: nowrap;
          box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
        }
        .leaflet-tooltip.hw-name-label::before { display: none; }
        .hw-storm-label { border-left: 3px solid var(--storm-color, var(--hw-accent, #03a9f4)); }
        .hw-volcano-label { border-left: 3px solid #fb8c00; }

        /* ---- storm markers & popup card ---------------------------------- */
        .hw-storm-badge {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
          border-radius: 50%;
          background: var(--cat-color, #5ebaff);
          border: 2px solid rgba(255, 255, 255, 0.92);
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.55);
          color: #10151c;
          font-size: 15px;
          font-weight: 800;
          letter-spacing: -0.02em;
        }
        .hw-storm-badge .hw-storm-badge-core { position: relative; z-index: 1; }
        .hw-storm-badge.is-primary::before {
          content: "";
          position: absolute;
          inset: -6px;
          border-radius: 50%;
          border: 2px solid var(--cat-color, #5ebaff);
          opacity: 0.8;
          animation: hw-badge-pulse 1.8s ease-out infinite;
          pointer-events: none;
        }
        @keyframes hw-badge-pulse {
          0% { transform: scale(0.85); opacity: 0.85; }
          70% { transform: scale(1.35); opacity: 0; }
          100% { transform: scale(1.35); opacity: 0; }
        }
        .hw-storm-popup .leaflet-popup-content { margin: 0; }
        .hw-storm-card { min-width: 224px; max-width: 280px; }
        .hw-storm-card-head {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 14px;
          border-bottom: 1px solid var(--hw-border, rgba(255, 255, 255, 0.08));
        }
        .hw-storm-card-badge {
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 34px;
          height: 34px;
          border-radius: 50%;
          border: 2px solid rgba(255, 255, 255, 0.85);
          color: #10151c;
          font-size: 14px;
          font-weight: 800;
        }
        .hw-storm-card-names {
          display: flex;
          flex-direction: column;
          gap: 1px;
          min-width: 0;
        }
        .hw-storm-card-names strong {
          font-size: 14px;
          font-weight: 700;
          color: var(--hw-text, #e8ecf1);
          overflow-wrap: anywhere;
        }
        .hw-storm-card-names span {
          font-size: 11px;
          color: var(--hw-muted, #9aa5b1);
        }
        .hw-storm-card-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px 12px;
          padding: 12px 14px;
        }
        .hw-storm-card-cell { min-width: 0; }
        .hw-storm-card-cell .k {
          display: block;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--hw-muted, #9aa5b1);
          margin-bottom: 1px;
        }
        .hw-storm-card-cell .v {
          display: block;
          font-size: 12px;
          font-weight: 600;
          color: var(--hw-text, #e8ecf1);
          overflow-wrap: anywhere;
        }

        /* ---- misc map symbology (kept from baseline, restyled) ------------- */
        .hw-zone-arc-label {
          fill: #eaf4ff;
          font-family: inherit;
          font-weight: 700;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          paint-order: stroke;
          stroke: rgba(6, 10, 18, 0.88);
          stroke-width: 3.5px;
          stroke-linejoin: round;
          stroke-linecap: round;
          pointer-events: none;
          -webkit-user-select: none;
          user-select: none;
        }
        .hw-zone-arc-label.is-bypassed {
          fill: #ffcc80;
          opacity: 0.9;
        }
        [data-hw-theme="light"] .hw-zone-arc-label {
          fill: #1c2c3d;
          stroke: rgba(255, 255, 255, 0.92);
        }
        [data-hw-theme="light"] .hw-zone-arc-label.is-bypassed { fill: #a35b00; }
        .hw-tornado-polygon {
          stroke: #e040fb;
          fill: rgba(224, 64, 251, 0.18);
        }
        .hw-travel-advisory {
          stroke: rgba(255, 255, 255, 0.35);
          stroke-width: 1;
        }
        .hw-travel-advisory.level-1 { fill: rgba(76, 175, 80, 0.42); }
        .hw-travel-advisory.level-2 { fill: rgba(255, 241, 118, 0.48); }
        .hw-travel-advisory.level-3 { fill: rgba(255, 152, 0, 0.5); }
        .hw-travel-advisory.level-4 { fill: rgba(244, 67, 54, 0.55); }
        .hw-travel-popup strong { display: block; margin-bottom: 4px; }
        .hw-travel-popup .hw-travel-level {
          display: inline-block;
          font-size: 11px;
          font-weight: 700;
          padding: 2px 8px;
          border-radius: 999px;
          margin-bottom: 6px;
        }
        .hw-wildfire-perimeter { stroke-width: 2; }
        .hw-hazard-icon-marker { background: transparent; border: none; }
        .hw-hazard-icon-wrap {
          display: flex;
          align-items: center;
          justify-content: center;
          filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.5));
        }
        .hw-hazard-icon-wrap img { display: block; pointer-events: none; }
        .hw-hazard-icon-wrap.is-primary {
          filter: drop-shadow(0 0 8px rgba(255, 255, 255, 0.55)) drop-shadow(0 2px 8px rgba(0, 0, 0, 0.5));
        }
        .hw-hazard-icon-wrap.is-tsunami {
          filter: drop-shadow(0 0 10px rgba(3, 169, 244, 0.85)) drop-shadow(0 2px 8px rgba(0, 0, 0, 0.5));
        }
        .hw-hazard-icon-wrap.is-nearby {
          filter: drop-shadow(0 0 10px rgba(255, 193, 7, 0.75)) drop-shadow(0 2px 8px rgba(0, 0, 0, 0.5));
        }
        .hw-hazard-icon-wrap.hw-lightning-marker.is-fresh {
          filter: drop-shadow(0 0 12px rgba(255, 193, 7, 0.95)) drop-shadow(0 2px 8px rgba(0, 0, 0, 0.5));
          animation: hw-lightning-pop 0.45s ease-out;
          opacity: 1;
          transform: scale(1);
        }
        .hw-hazard-icon-wrap.hw-lightning-marker.is-fading {
          opacity: 0;
          transform: scale(0.55);
          filter: drop-shadow(0 0 4px rgba(255, 193, 7, 0.35));
          transition: opacity 0.7s ease-out, transform 0.7s ease-out, filter 0.7s ease-out;
        }
        @keyframes hw-lightning-pop {
          0% { transform: scale(0.4); opacity: 0.2; }
          70% { transform: scale(1.15); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        .hw-hazard-icon-wrap.hw-volcano-catalog {
          opacity: 0.45;
          filter: grayscale(0.55) drop-shadow(0 1px 3px rgba(0, 0, 0, 0.45));
        }
        .hw-hazard-icon-wrap.hw-volcano-catalog:hover {
          opacity: 0.9;
          filter: grayscale(0) drop-shadow(0 2px 6px rgba(0, 0, 0, 0.5));
        }
        .hw-hazard-icon-wrap.hw-volcano-active {
          animation: hw-volcano-pulse 1.6s ease-in-out infinite;
        }
        @keyframes hw-volcano-pulse {
          0%, 100% {
            transform: scale(1);
            filter: drop-shadow(0 0 4px var(--volcano-color, #fb8c00)) drop-shadow(0 2px 8px rgba(0, 0, 0, 0.5));
          }
          50% {
            transform: scale(1.18);
            filter: drop-shadow(0 0 14px var(--volcano-color, #fb8c00)) drop-shadow(0 2px 8px rgba(0, 0, 0, 0.5));
          }
        }
        .marker-cluster-hw,
        .marker-cluster-hw-volcano {
          background: transparent;
          border: none;
        }
        .marker-cluster-hw div,
        .marker-cluster-hw-volcano div {
          background: transparent;
          margin: 0;
          width: auto;
          height: auto;
          line-height: normal;
        }
        .hw-cluster-icon-wrap {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 42px;
          height: 42px;
          filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.45));
        }
        .hw-cluster-count {
          position: absolute;
          top: -1px;
          right: -1px;
          min-width: 17px;
          height: 17px;
          padding: 0 4px;
          border-radius: 999px;
          background: rgba(16, 21, 28, 0.94);
          border: 1.5px solid rgba(255, 255, 255, 0.88);
          color: #fff;
          font-size: 10px;
          font-weight: 800;
          line-height: 14px;
          text-align: center;
          box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
        }
        .hw-cluster-icon-wrap.hw-earthquake-cluster .hw-cluster-count {
          background: rgba(239, 83, 80, 0.95);
          color: #fff;
        }
        .hw-cluster-icon-wrap.hw-volcano-cluster .hw-cluster-count {
          background: rgba(251, 140, 0, 0.95);
          color: #10151c;
        }
        .hw-hurricane-marker {
          position: relative;
          width: 44px;
          height: 44px;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .hw-hurricane-marker .hw-hurricane-disc {
          width: 38px;
          height: 38px;
          border-radius: 50%;
          background: var(--cat-color, #5ebaff);
          border: 2px solid rgba(255, 255, 255, 0.92);
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.55);
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .hw-hurricane-marker img {
          width: 26px;
          height: 26px;
          filter: brightness(0) invert(1);
        }
        .hw-hurricane-marker .hw-hurricane-cat {
          position: absolute;
          bottom: 0;
          right: 0;
          min-width: 15px;
          height: 15px;
          padding: 0 3px;
          border-radius: 999px;
          background: rgba(16, 21, 28, 0.92);
          border: 1px solid rgba(255, 255, 255, 0.85);
          color: #fff;
          font-size: 9px;
          font-weight: 800;
          line-height: 13px;
          text-align: center;
        }
        .hw-hurricane-marker.is-primary .hw-hurricane-disc {
          box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.25), 0 2px 12px rgba(0, 0, 0, 0.55);
        }
        .hw-home-marker {
          filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.55));
        }
        .hw-home-marker.in-cone {
          filter: drop-shadow(0 0 6px rgba(244, 67, 54, 0.9));
          animation: hw-pulse 1.5s ease-in-out infinite;
        }
        @keyframes hw-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); } }
        .leaflet-container.hw-measuring { cursor: crosshair; }
        .hw-measure-tip {
          background: rgba(2, 136, 209, 0.92);
          color: #fff;
          border: none;
          border-radius: 6px;
          font-size: 11px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        }
        .hw-measure-tip::before { display: none; }

        /* ---- compact tweaks -------------------------------------------------- */
        .hurricane-layout.is-compact .hw-map-controls-stack {
          --hw-map-stack-width: 178px;
        }
        .hurricane-layout.is-compact .leaflet-top.leaflet-left {
          top: 8px;
          left: 8px;
        }
        .hurricane-layout.is-compact .hw-legend-body {
          max-height: min(240px, 34vh);
        }

        /* ---- accessibility: reduced motion ---------------------------------- */
        @media (prefers-reduced-motion: reduce) {
          .hz-spinner,
          .hw-storm-badge.is-primary::before,
          .hw-hazard-icon-wrap.hw-volcano-active,
          .hw-hazard-icon-wrap.hw-lightning-marker.is-fresh,
          .hw-home-marker.in-cone {
            animation: none !important;
          }
          .hz-card-chevron,
          .hz-sheet-toggle svg,
          .hw-legend-caret,
          .hw-layer-switch,
          .hw-layer-switch::after {
            transition: none !important;
          }
        }
      `;
      this._shadow.appendChild(style);
    }

    _renderShell() {
      if (!this._root) return;
      this._root.innerHTML = `
        <div class="hurricane-loading" role="status">
          <span class="hz-spinner" aria-hidden="true"></span>
          <span>Loading hazard map…</span>
        </div>`;
    }

    async _ensureDeps() {
      await this._loadStylesheet(
        "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css"
      );
      await this._loadScript(
        "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js",
        "leaflet"
      );
      await this._loadScript(
        "https://cdn.jsdelivr.net/npm/@turf/turf@6.5.0/turf.min.js",
        "turf"
      );
      await this._loadStylesheet(
        "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css"
      );
      await this._loadStylesheet(
        "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css"
      );
      if (!global.L?.markerClusterGroup) {
        await this._loadScript(
          "https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js",
          null
        );
      }
    }

    _loadStylesheet(href) {
      const existing = this._shadow.querySelector(`link[href="${href}"]`);
      if (existing) return Promise.resolve();
      return new Promise((resolve) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        link.onload = () => resolve();
        // Resolve (not reject) on error so a flaky non-critical stylesheet
        // (e.g. marker cluster CSS) can't abort map initialization entirely.
        link.onerror = () => resolve();
        this._shadow.appendChild(link);
      });
    }

    _loadScript(src, globalKey) {
      if (globalKey && global[globalKey]) return Promise.resolve();
      if (!globalKey && src.includes("markercluster") && global.L?.markerClusterGroup) {
        return Promise.resolve();
      }
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        return new Promise((resolve) => {
          if (global[globalKey]) resolve();
          else existing.addEventListener("load", () => resolve());
        });
      }
      return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
      });
    }

    async loadData(forceRefresh) {
      if (!this._hass) return;
      this._loading = true;
      this._error = null;
      try {
        // Each endpoint is independently guarded so that one backend failure
        // (e.g. hurricanes) still lets the base map + other hazards render
        // instead of blanking the whole view.
        let hurricaneError = null;
        const [payload, tornadoPayload, earthquakePayload, lightningPayload, volcanoPayload, travelPayload, wildfirePayload, airQualityPayload] = await Promise.all([
          this._hass.callWS({
            type: "home_weather/get_hurricanes",
            force_refresh: !!forceRefresh,
          }).catch((err) => { hurricaneError = err; return null; }),
          this._hass.callWS({ type: "home_weather/get_tornadoes" }).catch(() => null),
          this._hass.callWS({ type: "home_weather/get_earthquakes" }).catch(() => null),
          this._hass.callWS({ type: "home_weather/get_lightning" }).catch(() => null),
          this._hass.callWS({ type: "home_weather/get_volcanoes" }).catch(() => null),
          this._hass.callWS({ type: "home_weather/get_travel_advisories" }).catch(() => null),
          this._hass.callWS({ type: "home_weather/get_wildfires" }).catch(() => null),
          this._hass.callWS({ type: "home_weather/get_air_quality" }).catch(() => null),
        ]);
        // Preserve last-known hurricane data if this refresh failed.
        this._data = payload || this._data || { storms: [], outlook: {}, summary: {} };
        this._tornadoData = tornadoPayload;
        this._earthquakeData = earthquakePayload;
        this._backendLightning = lightningPayload;
        this._volcanoData = volcanoPayload;
        this._travelData = travelPayload;
        this._wildfireData = wildfirePayload;
        this._airQualityData = airQualityPayload;
        this._error = hurricaneError ? (hurricaneError.message || String(hurricaneError)) : null;
        this._renderUI();
        this._updateLightningStatusDom();
      } catch (err) {
        this._error = err?.message || String(err);
        if (this._data) {
          this._renderUI();
        } else {
          this._renderError();
        }
      } finally {
        this._loading = false;
      }
    }

    _bindControls() {
      /* Map controls live in this component's own overlays when embedded. */
    }

    _getDetailTier() {
      const zoom = this._map?.getZoom?.() ?? 8;
      if (zoom < 6) return 0;
      if (zoom < 8) return 1;
      return 2;
    }

    _bindMapZoomHandler() {
      if (!this._map || this._zoomHandlerBound) return;
      this._zoomHandlerBound = true;
      this._lastDetailTier = this._getDetailTier();
      this._map.on("zoomend", () => {
        const tier = this._getDetailTier();
        if (tier === this._lastDetailTier) return;
        this._lastDetailTier = tier;
        clearTimeout(this._zoomDebounceTimer);
        this._zoomDebounceTimer = setTimeout(() => this._renderMap(), 150);
      });
    }

    _bindMapViewLockHandler() {
      if (!this._map || this._viewLockHandlerBound) return;
      this._viewLockHandlerBound = true;
      const lockIfUser = (e) => {
        if (!e?.originalEvent) return;
        this._userViewLocked = true;
      };
      this._map.on("dragend", lockIfUser);
      this._map.on("zoomend", lockIfUser);
    }

    _esc(text) {
      return String(text ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    /** Saffir-Simpson info for a storm/point given category and/or wind. */
    _stormCatInfo(category, windMph) {
      const w = Number(windMph);
      let cat = Number(category);
      if (!Number.isFinite(cat) || cat < 1) {
        if (Number.isFinite(w)) {
          if (w >= 157) cat = 5;
          else if (w >= 130) cat = 4;
          else if (w >= 111) cat = 3;
          else if (w >= 96) cat = 2;
          else if (w >= 74) cat = 1;
          else cat = 0;
        } else {
          cat = 0;
        }
      }
      cat = Math.max(0, Math.min(5, Math.round(cat)));
      const isTs = cat === 0 && Number.isFinite(w) && w >= 39;
      const label = cat >= 1 ? String(cat) : (isTs ? "TS" : "TD");
      const longName = cat >= 1
        ? `Category ${cat} hurricane`
        : (isTs ? "Tropical storm" : "Tropical depression");
      return { cat, label, longName, color: CATEGORY_COLORS[cat] || CATEGORY_COLORS[0] };
    }

    _categoryColor(category, windMph) {
      return this._stormCatInfo(category, windMph).color;
    }

    /** Short human time for NHC valid-time strings; falls back to raw text. */
    _fmtValidTime(raw) {
      if (!raw) return "";
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) {
        try {
          return d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
        } catch (_) {
          return String(raw);
        }
      }
      return String(raw);
    }

    _fmtClockTime(raw) {
      if (!raw) return null;
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return null;
      try {
        return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      } catch (_) {
        return null;
      }
    }

    /** Nearest forecast-point approach of a storm to home (miles + hour). */
    _stormClosestApproach(storm) {
      const home = this._data?.home;
      if (home?.lat == null || home?.lon == null) return null;
      let best = null;
      (storm.forecastPoints || []).forEach((pt) => {
        if (pt.lat == null || pt.lon == null) return;
        const miles = this._haversineMiles(home.lat, home.lon, pt.lat, pt.lon);
        if (!best || miles < best.miles) {
          best = { miles, hour: pt.hour, validTime: pt.validTime };
        }
      });
      return best;
    }

    _formatStormLabel(storm) {
      const name = (storm.name || "Unnamed Storm").trim();
      const meta = [];
      if (storm.category != null && Number(storm.category) > 0) {
        meta.push(`Cat ${storm.category}`);
      }
      if (storm.maxWindMph != null) {
        meta.push(`${Math.round(Number(storm.maxWindMph))} mph`);
      }
      return { name, meta: meta.join(" · ") };
    }

    _formatOutlookLabel(props, fallback) {
      const name =
        props.stormname ||
        props.storm_name ||
        props.name ||
        props.disturbance ||
        props.disturb ||
        props.area ||
        fallback;
      const prob = props.prob2day || props.prob7day;
      if (prob && !String(name).includes("%")) {
        return `${name} (${prob})`;
      }
      return String(name || fallback);
    }

    _getFeatureCenterLatLng(feature) {
      const L = global.L;
      if (!feature) return null;
      if (global.turf) {
        try {
          const center = global.turf.center(feature);
          const [lon, lat] = center.geometry.coordinates;
          return [lat, lon];
        } catch (_) {
          /* fall through */
        }
      }
      const geom = feature.geometry || {};
      if (geom.type === "Point" && geom.coordinates?.length >= 2) {
        return [geom.coordinates[1], geom.coordinates[0]];
      }
      if (L?.geoJSON) {
        try {
          const layer = L.geoJSON(feature);
          const bounds = layer.getBounds?.();
          if (bounds?.isValid?.()) {
            const c = bounds.getCenter();
            return [c.lat, c.lng];
          }
        } catch (_) {
          /* fall through */
        }
      }
      return null;
    }

    _createHazardIcon(iconName, options = {}) {
      const L = global.L;
      if (!L) return null;
      const size = options.size ?? 32;
      const extraClass = options.className ? ` ${options.className}` : "";
      return L.divIcon({
        className: "hw-hazard-icon-marker",
        html: `<div class="hw-hazard-icon-wrap${extraClass}"><img src="/local/home_weather/icons/${iconName}.svg" width="${size}" height="${size}" alt="" draggable="false"/></div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });
    }

    _createClusterIcon(iconName, count, options = {}) {
      const L = global.L;
      if (!L) return null;
      const size = options.size ?? 42;
      const iconSize = Math.max(18, size - 14);
      const extraClass = options.className ? ` ${options.className}` : "";
      return L.divIcon({
        className: "hw-hazard-icon-marker hw-cluster-marker",
        html: `<div class="hw-cluster-icon-wrap${extraClass}"><img src="/local/home_weather/icons/${iconName}.svg" width="${iconSize}" height="${iconSize}" alt="" draggable="false"/><span class="hw-cluster-count">${count}</span></div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      });
    }

    _isValidHomeCoords(home) {
      if (!home || home.lat == null || home.lon == null) return false;
      const lat = Number(home.lat);
      const lon = Number(home.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
      if (Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001) return false;
      return true;
    }

    _resolveHome() {
      const fromData = this._data?.home;
      if (this._isValidHomeCoords(fromData)) return fromData;
      if (this._isValidHomeCoords(this._homeCoords)) {
        return {
          lat: Number(this._homeCoords.lat),
          lon: Number(this._homeCoords.lon),
          label: this._homeCoords.label || "Home",
        };
      }
      return null;
    }

    _renderHomeMarker() {
      const L = global.L;
      if (!L || !this._map || !this._homeLayerGroup) return;
      this._homeLayerGroup.clearLayers();
      this._homeMarker = null;
      const home = this._resolveHome();
      if (!home) return;
      const insideCone = this._data?.summary?.insideCone;
      const insideTornado = this._tornadoData?.affecting_home;
      const eqNearby = this._earthquakeData?.nearby_active;
      const homeIcon = L.divIcon({
        className: `hw-home-marker${insideCone || insideTornado || eqNearby ? " in-cone" : ""}`,
        html: `<img src="/local/home_weather/icons/home.svg" width="28" height="28" alt="Home" />`,
        iconSize: [28, 28],
        iconAnchor: [14, 28],
      });
      this._homeMarker = L.marker([home.lat, home.lon], { icon: homeIcon, zIndexOffset: 2000 })
        .bindPopup(`<strong>${this._esc(home.label || "Home")}</strong>`)
        .addTo(this._homeLayerGroup);
    }

    _addHazardMarker(lat, lon, iconName, options = {}) {
      const L = global.L;
      if (!L || lat == null || lon == null) return null;
      if (options.show === false) return null;
      const size = options.size ?? 32;
      const icon = options.icon || this._createHazardIcon(iconName, {
        size,
        className: options.className,
      });
      if (!icon) return null;
      const marker = L.marker([lat, lon], {
        icon,
        zIndexOffset: options.zIndexOffset ?? 400,
      });
      if (options.popup) marker.bindPopup(options.popup);
      marker.addTo(options.group || this._layerGroup);
      return marker;
    }

    _renderError() {
      if (!this._root) return;
      this._root.innerHTML = `
        <section class="hurricane-layout${this._embedded ? " is-embedded" : ""}">
          <div class="hurricane-empty" style="width:100%;height:100%">
            <p>Failed to load hazard data.</p>
            <p>${this._esc(this._error)}</p>
            <button type="button" data-hurricane-refresh>Retry</button>
          </div>
        </section>`;
      this._root.querySelector("[data-hurricane-refresh]")
        ?.addEventListener("click", () => this.loadData(true));
    }

    /* ------------------------------------------------------------------ */
    /* Status panel                                                        */
    /* ------------------------------------------------------------------ */

    _buildStatusHeadline(summary, storms) {
      const tornado = this._tornadoData || {};
      const earthquake = this._earthquakeData || {};
      if (tornado.affecting_home) {
        return { text: "Tornado warning affecting your area", className: "is-danger" };
      }
      if (earthquake.nearby_active && earthquake.primary_event) {
        const mag = earthquake.primary_event.magnitude;
        const place = earthquake.primary_event.place || "Nearby earthquake";
        const magText = mag != null ? `M${mag}` : "Earthquake";
        return { text: `${magText} — ${place}`, className: earthquake.primary_event.tsunami === 1 ? "is-danger" : "is-watch" };
      }
      const threat = summary.threatLevel || "none";
      const hasOutlook = summary.hasOutlookActivity;
      const stormCount = storms.length;
      if (stormCount > 0) {
        const name = summary.closestStormName || "Active storm";
        if (threat === "high") return { text: `${name} poses a high threat to your area`, className: "is-danger" };
        if (threat === "watch") return { text: `${name} is being monitored near your area`, className: "is-watch" };
        if (threat === "monitor") return { text: `${name} is in the Atlantic basin — keep watch`, className: "is-watch" };
        return { text: `${stormCount} active hurricane${stormCount === 1 ? "" : "s"}`, className: "" };
      }
      if (hasOutlook) {
        if (summary.insideDevelopmentRegion) {
          return { text: "Your area is inside a development region", className: "is-watch" };
        }
        if (summary.disturbanceCount > 0) {
          return {
            text: `${summary.disturbanceCount} disturbance${summary.disturbanceCount === 1 ? "" : "s"} being tracked by NHC`,
            className: "is-watch",
          };
        }
        return { text: "NHC is monitoring potential development", className: "is-watch" };
      }
      return { text: "No active hurricanes or disturbances", className: "" };
    }

    _statRow(label, value, cls = "") {
      return `<div class="hz-row${cls ? ` ${cls}` : ""}"><span>${label}</span><strong>${value}</strong></div>`;
    }

    /** One collapsible hazard card for the status panel. */
    _hazardCard(cfg) {
      const openAttr = cfg.open ? " open" : "";
      const valueClass = cfg.valueClass ? ` ${cfg.valueClass}` : "";
      return `
        <details class="hz-card"${openAttr} data-card="${cfg.id}">
          <summary>
            <img class="hz-card-icon" src="/local/home_weather/icons/${cfg.icon}.svg" alt="" draggable="false"/>
            <span class="hz-card-titles">
              <span class="hz-card-title">${cfg.title}</span>
              <span class="hz-card-lead">${cfg.lead}</span>
            </span>
            <span class="hz-card-value${valueClass}">${cfg.value}</span>
            <span class="hz-card-chevron" aria-hidden="true">▾</span>
          </summary>
          <div class="hz-card-body">${cfg.body}</div>
        </details>`;
    }

    _buildStatusPanelHtml(openState) {
      const summary = this._data.summary || {};
      const storms = this._data.storms || [];
      const threatClass =
        summary.threatLevel === "high"
          ? "is-threat-high"
          : summary.threatLevel === "watch" || summary.threatLevel === "monitor"
            ? "is-threat-watch"
            : "";

      const staleBanner = summary.stale || summary.warning
        ? `<div class="hurricane-banner">${this._esc(summary.warning || "Showing cached data.")}</div>`
        : "";

      const insideCone = summary.insideCone;

      const tornado = this._tornadoData || {};
      const tornadoCount = tornado.active_count || 0;
      const tornadoDistance = this._fmtMiles(tornado.nearest_distance_miles);
      const tornadoHeadline = tornado.primary_alert?.headline || "—";

      const earthquake = this._earthquakeData || {};
      const eqPrimary = earthquake.primary_event || {};
      const eqCount = earthquake.active_count || 0;
      const eqMapCount = earthquake.map_count ?? eqCount;
      const eqDistance = this._fmtMiles(earthquake.nearest_distance_miles);
      const eqMag = eqPrimary.magnitude != null ? `M${eqPrimary.magnitude}` : null;
      const eqDepth = eqPrimary.depth_km != null ? `${Math.round(eqPrimary.depth_km)} km` : "—";
      const eqPlace = eqPrimary.place || "—";
      const eqTsunami = eqPrimary.tsunami === 1;

      const volcano = this._volcanoData || {};
      const volcanoPrimary = volcano.primary_geofield || {};
      const volcanoActiveCount = volcano.active_count || 0;
      const volcanoZoneCount = volcano.geofield_count || 0;
      const volcanoNearestName = volcanoPrimary.name || "—";
      const volcanoNearestLevel = volcanoPrimary.activity_level
        ? String(volcanoPrimary.activity_level).toUpperCase()
        : "—";
      const volcanoDistance = this._fmtMiles(volcano.nearest_distance_miles);

      const travel = this._travelData || {};
      const travelCounts = travel.level_counts || { 1: 0, 2: 0, 3: 0, 4: 0 };
      const travelTotal = travel.advisory_count || 0;
      const travelHigh = (travelCounts[3] || 0) + (travelCounts[4] || 0);

      const wildfire = this._wildfireData || {};
      const wildfireCount = wildfire.incident_count || 0;
      const wildfireActive = wildfire.active_uncontained_count || 0;
      const wildfireNearest = wildfire.nearest_incident || {};
      const wildfireDistance = this._fmtMiles(wildfire.nearest_distance_miles);

      const airQuality = this._airQualityData || {};
      const aqiTotal = airQuality.area_count || 0;
      const aqiUnhealthy = airQuality.unhealthy_count || 0;
      const aqiWorst = airQuality.worst_area || {};
      const aqiNearestBad = airQuality.nearest_unhealthy || {};

      const headline = this._buildStatusHeadline(summary, storms);
      const tropicalCount = (summary.disturbanceCount || 0) + storms.length;
      const lightningStats = this._getLightningStats();
      const compact = this._isCompactLayout();
      const collapsedClass = compact && this._statusCollapsed ? " is-collapsed" : "";
      const sheetExpanded = compact && !this._statusCollapsed;

      const pill = headline.className === "is-danger"
        ? { cls: "is-danger", text: "Active threat" }
        : headline.className === "is-watch"
          ? { cls: "is-watch", text: "Monitoring" }
          : { cls: "is-ok", text: "All clear" };

      const updatedTime = this._fmtClockTime(summary.fetchedAt);

      // Cards default open on desktop when they carry an elevated state; user
      // toggles (openState) always win across re-renders.
      const isOpen = (id, fallback) => {
        if (openState && Object.prototype.hasOwnProperty.call(openState, id)) return !!openState[id];
        return !compact && fallback;
      };

      const cards = [];

      /* Tropical -------------------------------------------------------- */
      {
        const danger = summary.threatLevel === "high" || insideCone;
        const warn = storms.length > 0 || summary.hasOutlookActivity;
        let lead;
        if (storms.length > 0) {
          const bits = [this._esc(summary.closestStormName || "Active storm")];
          if (summary.distanceToCenterMiles != null) bits.push(this._fmtMiles(summary.distanceToCenterMiles));
          lead = `Closest: ${bits.join(" · ")}`;
        } else if (summary.hasOutlookActivity) {
          lead = `${summary.disturbanceCount || 0} disturbance${(summary.disturbanceCount || 0) === 1 ? "" : "s"} tracked by NHC`;
        } else {
          lead = "No active systems";
        }
        const body = [
          this._statRow("Overall threat", this._esc(summary.threatLevel || "none"), danger ? "is-danger" : warn ? "is-warning" : ""),
          summary.hasOutlookActivity ? this._statRow("Disturbances", summary.disturbanceCount || 0) : "",
          summary.hasOutlookActivity ? this._statRow("Development areas", summary.developmentAreaCount || 0) : "",
          summary.hasOutlookActivity ? this._statRow("Inside dev. region", summary.insideDevelopmentRegion ? "Yes" : "No", summary.insideDevelopmentRegion ? "is-warning" : "") : "",
          summary.hasOutlookActivity ? this._statRow("Nearest disturbance", this._fmtMiles(summary.nearestDisturbanceMiles)) : "",
          summary.hasOutlookActivity ? this._statRow("Formation probability", summary.highestFormationProbability != null ? `${summary.highestFormationProbability}%` : "—") : "",
          storms.length > 0 ? this._statRow("Active storms", storms.length) : "",
          storms.length > 0 ? this._statRow("Closest storm", this._esc(summary.closestStormName || "—")) : "",
          storms.length > 0 ? this._statRow("Distance to center", this._fmtMiles(summary.distanceToCenterMiles)) : "",
          storms.length > 0 ? this._statRow("Nearest forecast point", this._fmtMiles(summary.distanceToNearestForecastMiles)) : "",
          storms.length > 0 ? this._statRow("Home inside cone", insideCone ? "Yes" : "No", insideCone ? "is-danger" : "") : "",
          storms.length > 0 ? this._statRow("Closest approach", summary.estimatedClosestApproachHour != null ? `+${summary.estimatedClosestApproachHour}h` : "—") : "",
          !summary.hasOutlookActivity && storms.length === 0 ? this._statRow("Status", "No active storms") : "",
        ].filter(Boolean).join("");
        cards.push(this._hazardCard({
          id: "tropical",
          icon: "hurricane",
          title: "Hurricanes",
          lead,
          value: String(tropicalCount),
          valueClass: danger ? "is-danger" : (tropicalCount > 0 ? "is-warning" : "is-quiet"),
          open: isOpen("tropical", danger || storms.length > 0),
          body,
        }));
      }

      /* Tornado ---------------------------------------------------------- */
      {
        const danger = !!tornado.affecting_home;
        const lead = danger
          ? "Affecting your area"
          : tornadoCount > 0
            ? `Nearest warning ${tornadoDistance}`
            : "No active warnings";
        const body = [
          this._statRow("Active warnings", tornadoCount),
          this._statRow("Affecting home", danger ? "Yes" : "No", danger ? "is-danger" : ""),
          this._statRow("Nearest warning", tornadoDistance),
          this._statRow("Primary alert", this._esc(tornadoHeadline)),
        ].join("");
        cards.push(this._hazardCard({
          id: "tornado",
          icon: "tornado",
          title: "Tornado warnings",
          lead,
          value: String(tornadoCount),
          valueClass: danger ? "is-danger" : (tornadoCount > 0 ? "is-warning" : "is-quiet"),
          open: isOpen("tornado", danger),
          body,
        }));
      }

      /* Earthquakes ------------------------------------------------------- */
      {
        const warn = !!earthquake.nearby_active;
        const lead = eqMag
          ? `${this._esc(eqPlace)}${eqDistance !== "—" ? ` · ${eqDistance}` : ""}`
          : "No significant events";
        const body = [
          this._statRow("Worldwide on map", eqMapCount),
          this._statRow("Nearby (live feed)", eqCount),
          this._statRow("Nearest", this._esc(eqPlace), warn ? "is-warning" : ""),
          this._statRow("Magnitude", eqMag || "—"),
          this._statRow("Distance", eqDistance),
          this._statRow("Depth", eqDepth),
          this._statRow("Tsunami flag", eqTsunami ? "Yes" : "No", eqTsunami ? "is-danger" : ""),
        ].join("");
        cards.push(this._hazardCard({
          id: "earthquakes",
          icon: "earthquake",
          title: "Earthquakes",
          lead,
          value: eqMag || String(eqMapCount),
          valueClass: eqTsunami ? "is-danger" : warn ? "is-warning" : "is-quiet",
          open: isOpen("earthquakes", warn || eqTsunami),
          body,
        }));
      }

      /* Volcanoes ---------------------------------------------------------- */
      {
        const warn = !!volcano.in_geofield;
        const lead = volcanoActiveCount > 0
          ? `Nearest: ${this._esc(volcanoNearestName)}${volcanoNearestLevel !== "—" ? ` · ${this._esc(volcanoNearestLevel)}` : ""}`
          : "No elevated activity";
        const body = [
          this._statRow("Active worldwide", volcanoActiveCount),
          this._statRow("Active in your zone", volcanoZoneCount, warn ? "is-warning" : ""),
          this._statRow("Nearest active", this._esc(volcanoNearestName)),
          this._statRow("Alert level", this._esc(volcanoNearestLevel)),
          this._statRow("Distance", volcanoDistance),
        ].join("");
        cards.push(this._hazardCard({
          id: "volcanoes",
          icon: "volcano",
          title: "Volcanoes",
          lead,
          value: String(volcanoActiveCount),
          valueClass: warn ? "is-warning" : "is-quiet",
          open: isOpen("volcanoes", warn),
          body,
        }));
      }

      /* Lightning ----------------------------------------------------------- */
      {
        const statusCls = lightningStats.status === "live"
          ? "is-live"
          : (lightningStats.status === "error" || lightningStats.status === "disabled") ? "is-danger" : "";
        const body = [
          `<div class="hz-row"><span>Visible on map</span><strong id="hw-lightning-badge">${lightningStats.visibleCount}</strong></div>`,
          `<div class="hz-row"><span>Nearest strike</span><strong id="hw-lightning-nearest">${lightningStats.nearestMiles != null ? this._fmtMiles(lightningStats.nearestMiles) : "—"}</strong></div>`,
          `<div class="hz-row"><span>Feed status</span><strong id="hw-lightning-status" class="${statusCls}">${this._formatLightningStatus(lightningStats.status)}</strong></div>`,
          this._statRow("Data source", `<a href="https://www.blitzortung.org" target="_blank" rel="noopener noreferrer">Blitzortung</a>`),
        ].join("");
        cards.push(this._hazardCard({
          id: "lightning",
          icon: "lightning-bolt",
          title: "Lightning",
          lead: lightningStats.status === "live" ? "Live feed connected" : `Feed: ${this._formatLightningStatus(lightningStats.status)}`,
          value: `<span id="hw-lightning-count">${lightningStats.hourCount}</span>/hr`,
          valueClass: lightningStats.hourCount > 0 ? "is-warning" : "is-quiet",
          open: isOpen("lightning", false),
          body,
        }));
      }

      /* Travel advisories ----------------------------------------------------- */
      {
        const body = [
          this._statRow("Countries tracked", travelTotal),
          this._statRow("Level 3–4", travelHigh, travelHigh > 0 ? "is-warning" : ""),
          this._statRow("Level 4 (Do not travel)", travelCounts[4] || 0),
          this._statRow("Level 3 (Reconsider)", travelCounts[3] || 0),
          this._statRow("On map", travel.map_count || 0),
          this._statRow("Source", `<a href="https://travel.state.gov/content/travel/en/rss.html" target="_blank" rel="noopener noreferrer">State Dept</a>`),
        ].join("");
        cards.push(this._hazardCard({
          id: "travel",
          icon: "globe",
          title: "Travel advisories",
          lead: `${travelTotal} countries tracked`,
          value: `${travelHigh} high`,
          valueClass: travelHigh > 0 ? "is-warning" : "is-quiet",
          open: isOpen("travel", false),
          body,
        }));
      }

      /* Wildfires --------------------------------------------------------------- */
      {
        const warn = wildfireActive > 0;
        const lead = wildfireCount > 0
          ? `Nearest: ${this._esc(wildfireNearest.name || "—")}${wildfireDistance !== "—" ? ` · ${wildfireDistance}` : ""}`
          : "No active incidents";
        const body = [
          this._statRow("Active incidents", wildfireCount),
          this._statRow("Uncontained", wildfireActive, warn ? "is-warning" : ""),
          this._statRow("Perimeters on map", wildfire.perimeter_count || 0),
          this._statRow("Nearest", this._esc(wildfireNearest.name || "—")),
          this._statRow("Distance", wildfireDistance),
          this._statRow("Source", `<a href="https://data-nifc.opendata.arcgis.com/" target="_blank" rel="noopener noreferrer">NIFC WFIGS</a>`),
        ].join("");
        cards.push(this._hazardCard({
          id: "wildfire",
          icon: "fire",
          title: "Wildfires",
          lead,
          value: String(wildfireCount),
          valueClass: warn ? "is-warning" : "is-quiet",
          open: isOpen("wildfire", false),
          body,
        }));
      }

      /* Air quality ---------------------------------------------------------------- */
      {
        const warn = aqiUnhealthy > 0;
        const lead = aqiWorst.aqi != null
          ? `Worst: ${this._esc(aqiWorst.name ? `${aqiWorst.name}, ${aqiWorst.state || ""}` : "—")}`
          : "No reporting areas";
        const body = [
          this._statRow("Reporting areas", aqiTotal),
          this._statRow("Unhealthy+", aqiUnhealthy, warn ? "is-warning" : ""),
          this._statRow("Worst AQI", aqiWorst.aqi != null ? aqiWorst.aqi : "—"),
          this._statRow("Worst location", this._esc(aqiWorst.name ? `${aqiWorst.name}, ${aqiWorst.state || ""}` : "—")),
          this._statRow("Nearest unhealthy", this._esc(aqiNearestBad.name ? `${aqiNearestBad.name}, ${aqiNearestBad.state || ""}` : "—")),
          this._statRow("On map", airQuality.map_count || 0),
          this._statRow("Source", `<a href="https://www.airnow.gov/" target="_blank" rel="noopener noreferrer">EPA AirNow</a>`),
        ].join("");
        cards.push(this._hazardCard({
          id: "air_quality",
          icon: "air-quality",
          title: "Air quality",
          lead,
          value: aqiWorst.aqi != null ? `AQI ${aqiWorst.aqi}` : "—",
          valueClass: warn ? "is-warning" : "is-quiet",
          open: isOpen("air_quality", false),
          body,
        }));
      }

      return `
        <aside class="hurricane-status ${threatClass}${collapsedClass}" role="region" aria-label="Hazard status">
          <header class="hz-sheet-head">
            <div class="hz-grabber" aria-hidden="true"></div>
            <div class="hz-head-row">
              <span class="hz-threat-pill ${pill.cls}">${pill.text}</span>
              <h3 class="hz-head-title">Hazard status</h3>
              <button type="button" class="hz-sheet-toggle" aria-expanded="${sheetExpanded ? "true" : "false"}" aria-label="${sheetExpanded ? "Collapse hazard status" : "Expand hazard status"}">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M11.29 8.71 6.7 13.3a1 1 0 1 0 1.42 1.4L12 10.83l3.88 3.88a1 1 0 0 0 1.42-1.41l-4.59-4.59a1 1 0 0 0-1.42 0z"/></svg>
              </button>
            </div>
            <p class="hz-headline ${headline.className}" aria-live="polite">${this._esc(headline.text)}</p>
            ${updatedTime ? `<p class="hz-updated">Updated ${this._esc(updatedTime)}</p>` : ""}
          </header>
          <div class="hurricane-status-scroll">
            ${staleBanner}
            ${cards.join("")}
          </div>
        </aside>`;
    }

    _syncStatusPanelLayout() {
      const layout = this._root?.querySelector(".hurricane-layout");
      const aside = this._root?.querySelector(".hurricane-status");
      if (!layout || !aside) return;
      const compact = this._isCompactLayout();
      layout.classList.toggle("is-compact", compact);
      const collapsed = compact && this._statusCollapsed;
      aside.classList.toggle("is-collapsed", collapsed);
      const expanded = compact && !this._statusCollapsed;
      const toggle = aside.querySelector(".hz-sheet-toggle");
      if (toggle) {
        toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
        toggle.setAttribute("aria-label", expanded ? "Collapse hazard status" : "Expand hazard status");
      }
      if (compact) {
        const head = aside.querySelector(".hz-sheet-head");
        if (head) {
          // Drive floating-control offsets from the real peek height so the
          // Layers button and attribution stay reachable above the sheet.
          const peek = collapsed ? head.offsetHeight : head.offsetHeight;
          layout.style.setProperty("--hz-peek", `${Math.max(56, peek)}px`);
        }
      }
    }

    _bindStatusPanelToggle() {
      const aside = this._root?.querySelector(".hurricane-status");
      if (!aside || aside.dataset.toggleBound === "true") return;
      aside.dataset.toggleBound = "true";
      const toggle = () => {
        if (!this._isCompactLayout()) return;
        this._statusCollapsed = !this._statusCollapsed;
        this._syncStatusPanelLayout();
        this._map?.invalidateSize?.();
      };
      aside.querySelector(".hz-sheet-toggle")?.addEventListener("click", (e) => {
        e.stopPropagation();
        toggle();
      });
      aside.querySelector(".hz-sheet-head")?.addEventListener("click", (e) => {
        if (!this._isCompactLayout()) return;
        if (e.target.closest(".hz-sheet-toggle")) return;
        toggle();
      });
    }

    _renderUI() {
      if (!this._root || !this._data) return;

      const mapReady = !!(this._map && this._root.querySelector("#hurricane-map"));
      if (mapReady) {
        const aside = this._root.querySelector(".hurricane-status");
        if (aside) {
          // Preserve the user's expand/collapse choices across data refreshes.
          const openState = {};
          aside.querySelectorAll(".hz-card").forEach((d) => {
            if (d.dataset.card) openState[d.dataset.card] = d.open;
          });
          aside.outerHTML = this._buildStatusPanelHtml(openState);
          this._bindStatusPanelToggle();
          this._syncStatusPanelLayout();
        }
        this._renderMap();
        this._updateLightningStatusDom();
        return;
      }

      const compact = this._isCompactLayout();
      const layoutClass = [
        "hurricane-layout",
        this._embedded ? "is-embedded" : "",
        compact ? "is-compact" : "",
      ].filter(Boolean).join(" ");
      this._root.innerHTML = `
        <section class="${layoutClass}">
          <div class="hurricane-map-wrap">
            <div id="hurricane-map" class="hurricane-map" role="application" aria-label="Hazard map"></div>
            ${this._buildLayersControlHtml()}
            ${this._buildMapReadoutHtml()}
          </div>
          ${this._buildStatusPanelHtml()}
        </section>`;
      this._renderMap(true);
      this._syncLightningLayer();
      this._bindStatusPanelToggle();
      this._bindLayersControl();
      this._syncStatusPanelLayout();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => this._map?.invalidateSize?.());
      });
    }

    _fmtMiles(value) {
      if (value == null || Number.isNaN(Number(value))) return "—";
      return `${Math.round(Number(value))} mi`;
    }

    /* ------------------------------------------------------------------ */
    /* Layers menu + coords readout                                        */
    /* ------------------------------------------------------------------ */

    _isToggleActive(def) {
      if (def.type === "overlay") {
        if (def.key === "wind_radii") return this._showWindRadii;
        if (def.key === "alert_zones") return this._showZones;
        return false;
      }
      return !!this._mapLayers[def.key];
    }

    _activeToggleCount() {
      return LAYER_DEFS.reduce((n, def) => n + (this._isToggleActive(def) ? 1 : 0), 0);
    }

    _buildLayersControlHtml() {
      const rows = (defs) => defs.map((def) => {
        const on = this._isToggleActive(def);
        return `
          <button type="button" class="hw-layer-row${on ? " is-on" : ""}" role="switch"
            aria-checked="${on ? "true" : "false"}" data-layer="${def.key}" data-type="${def.type}">
            <img src="/local/home_weather/icons/${def.icon}.svg" alt="" draggable="false"/>
            <span class="hw-layer-label">${def.label}</span>
            <span class="hw-layer-switch" aria-hidden="true"></span>
          </button>`;
      }).join("");
      const hazardRows = rows(LAYER_DEFS.filter((d) => d.type === "layer"));
      const overlayRows = rows(LAYER_DEFS.filter((d) => d.type === "overlay"));
      return `
        <div class="hw-layers-ctl">
          <div class="hw-layers-menu" id="hw-layers-menu" role="group" aria-label="Map layers" hidden>
            <div class="hw-layers-menu-head">Map layers</div>
            <div class="hw-layers-group-label">Hazards</div>
            ${hazardRows}
            <div class="hw-layers-group-label">Overlays</div>
            ${overlayRows}
          </div>
          <button type="button" class="hw-layers-fab" aria-haspopup="true" aria-expanded="false" aria-controls="hw-layers-menu">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 2 2 7.5l10 5.5 10-5.5L12 2zm-7.7 8.4L2 11.7l10 5.5 10-5.5-2.3-1.3-7.7 4.2-7.7-4.2zm0 4.2L2 15.9l10 5.5 10-5.5-2.3-1.3-7.7 4.2-7.7-4.2z"/></svg>
            <span class="hw-layers-fab-label">Layers</span>
            <span class="hw-layers-count">${this._activeToggleCount()}</span>
          </button>
        </div>`;
    }

    _buildMapReadoutHtml() {
      return `
        <div class="hw-map-readout" aria-hidden="true">
          <span class="hw-coords-text">—</span>
          <span class="hw-scale-wrap"><span class="hw-scale-line" style="width:60px"></span><span class="hw-scale-label">—</span></span>
        </div>`;
    }

    _bindLayersControl() {
      const ctl = this._root?.querySelector(".hw-layers-ctl");
      if (!ctl || ctl.dataset.bound === "true") return;
      ctl.dataset.bound = "true";
      const fab = ctl.querySelector(".hw-layers-fab");
      const menu = ctl.querySelector(".hw-layers-menu");
      this._layersCtl = ctl;
      this._layersFab = fab;
      this._layersMenu = menu;

      fab?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this._layersMenuOpen) this._closeLayersMenu();
        else this._openLayersMenu();
      });

      menu?.addEventListener("click", (e) => {
        const btn = e.target.closest(".hw-layer-row");
        if (!btn) return;
        e.stopPropagation();
        const key = btn.dataset.layer;
        const type = btn.dataset.type;
        if (!key) return;

        if (type === "overlay") {
          if (key === "wind_radii") {
            this._showWindRadii = !this._showWindRadii;
            if (this._onOverlayToggle) this._onOverlayToggle("wind_radii", this._showWindRadii);
          } else if (key === "alert_zones") {
            this._showZones = !this._showZones;
            if (this._onOverlayToggle) this._onOverlayToggle("alert_zones", this._showZones);
          }
        } else {
          this._mapLayers[key] = !this._mapLayers[key];
          if (key === "lightning") this._syncLightningLayer();
          if (this._onLayerToggle) this._onLayerToggle(key, this._mapLayers[key]);
        }
        this._syncLayerControls();
        this._renderMap();
      });
    }

    _openLayersMenu() {
      if (!this._layersMenu || !this._layersFab) return;
      this._layersMenu.hidden = false;
      this._layersFab.setAttribute("aria-expanded", "true");
      this._layersMenuOpen = true;
    }

    _closeLayersMenu(refocus) {
      if (!this._layersMenu || !this._layersFab) return;
      this._layersMenu.hidden = true;
      this._layersFab.setAttribute("aria-expanded", "false");
      this._layersMenuOpen = false;
      if (refocus) this._layersFab.focus?.();
    }

    /** Reflect current layer/overlay state into the Layers menu UI. */
    _syncLayerControls() {
      const ctl = this._root?.querySelector(".hw-layers-ctl");
      if (!ctl) return;
      ctl.querySelectorAll(".hw-layer-row").forEach((btn) => {
        const def = LAYER_DEFS.find((d) => d.key === btn.dataset.layer && d.type === btn.dataset.type);
        if (!def) return;
        const on = this._isToggleActive(def);
        btn.classList.toggle("is-on", on);
        btn.setAttribute("aria-checked", on ? "true" : "false");
      });
      const count = ctl.querySelector(".hw-layers-count");
      if (count) count.textContent = String(this._activeToggleCount());
    }

    /** Shared document-level dismissal for the layers + basemap menus. */
    _bindGlobalDismiss() {
      if (this._docDismissHandler) return;
      this._docDismissHandler = (ev) => {
        const path = typeof ev.composedPath === "function" ? ev.composedPath() : [];
        if (this._layersMenuOpen && this._layersCtl && !path.includes(this._layersCtl)) {
          this._closeLayersMenu();
        }
        if (this._basemapMenu && !this._basemapMenu.hidden) {
          const cell = this._basemapMenu.closest(".hw-basemap-cell");
          if (!cell || !path.includes(cell)) this._closeBasemapMenu();
        }
      };
      this._docKeyHandler = (ev) => {
        if (ev.key !== "Escape") return;
        if (this._layersMenuOpen) this._closeLayersMenu(true);
        this._closeBasemapMenu();
      };
      document.addEventListener("click", this._docDismissHandler);
      document.addEventListener("keydown", this._docKeyHandler);
    }

    _updateBottomBarCoords(lat, lon, zoom) {
      const el = this._root?.querySelector(".hw-map-readout .hw-coords-text");
      if (el) el.textContent = `${lat.toFixed(3)}°, ${lon.toFixed(3)}° · z${zoom ?? "?"}`;
    }

    _getUsaBounds() {
      const L = global.L;
      if (!L) return null;
      return L.latLngBounds(USA_BOUNDS);
    }

    /* ------------------------------------------------------------------ */
    /* Map init + controls                                                 */
    /* ------------------------------------------------------------------ */

    _ensureMap() {
      const mapEl = this._root?.querySelector("#hurricane-map");
      if (!mapEl || !global.L || this._mapInitialized) return mapEl;
      const L = global.L;

      this._map = L.map(mapEl, {
        zoomControl: false,
        attributionControl: true,
        // Allow seamless horizontal panning with repeating world tiles.
        worldCopyJump: true,
        minZoom: 3,
        maxZoom: 18,
        // Smoother wheel + pinch zoom behaviour.
        zoomSnap: 0.5,
        zoomDelta: 0.5,
        wheelPxPerZoomLevel: 90,
      });

      // Establish a valid initial view immediately. Without a center/zoom the
      // map has no view and tiles never load (blank map); fitBounds runs later
      // once the container has a real size.
      const home = this._resolveHome();
      if (home) {
        this._safe(() => this._map.setView([home.lat, home.lon], 8));
      } else {
        this._safe(() => this._map.setView([39.8283, -98.5795], 4));
      }

      const baseLayers = {
        Dark: L.tileLayer(DARK_TILE_URL, { maxZoom: 19, subdomains: "abcd", attribution: CARTO_ATTR }),
        Light: L.tileLayer(LIGHT_TILE_URL, { maxZoom: 19, subdomains: "abcd", attribution: CARTO_ATTR }),
        Satellite: L.tileLayer(SAT_TILE_URL, { maxZoom: 19, attribution: ESRI_ATTR }),
        Ocean: L.tileLayer(OCEAN_TILE_URL, { maxZoom: 13, attribution: ESRI_ATTR }),
      };
      this._baseLayers = baseLayers;
      this._activeBasemap = this._theme === "light" ? "Light" : "Dark";
      baseLayers[this._activeBasemap].addTo(this._map);

      /* Custom toolbar stack at top-left; coords/scale in floating readout */
      this._safe(() => this._buildMapControlsStack());
      this._safe(() => this._addCoordinateControl());

      this._layerGroup = L.layerGroup().addTo(this._map);
      this._homeLayerGroup = L.layerGroup().addTo(this._map);
      if (global.L.markerClusterGroup) {
        this._earthquakeClusterGroup = global.L.markerClusterGroup({
          maxClusterRadius: 56,
          disableClusteringAtZoom: 8,
          spiderfyOnMaxZoom: true,
          showCoverageOnHover: false,
          iconCreateFunction: (cluster) => this._createClusterIcon(
            "earthquake",
            cluster.getChildCount(),
            { className: "hw-earthquake-cluster" },
          ),
        });
        this._map.addLayer(this._earthquakeClusterGroup);
        this._volcanoClusterGroup = global.L.markerClusterGroup({
          maxClusterRadius: 48,
          disableClusteringAtZoom: 7,
          spiderfyOnMaxZoom: true,
          showCoverageOnHover: false,
          iconCreateFunction: (cluster) => this._createClusterIcon(
            "volcano",
            cluster.getChildCount(),
            { className: "hw-volcano-cluster" },
          ),
        });
        this._map.addLayer(this._volcanoClusterGroup);
      }
      this._lightningLayerGroup = L.layerGroup();
      if (this._lightningEnabled()) {
        this._lightningLayerGroup.addTo(this._map);
      }
      this._mapInitialized = true;
      this._bindMapZoomHandler();
      this._bindMapViewLockHandler();
      const attr = this._map.attributionControl;
      if (attr?.setPrefix) {
        attr.setPrefix('Lightning &copy; <a href="https://www.blitzortung.org">Blitzortung</a>');
      }
      return mapEl;
    }

    _safe(fn) {
      try {
        return fn();
      } catch (err) {
        console.warn("[hazard-map] control init failed", err);
        return null;
      }
    }

    _addCoordinateControl() {
      const L = global.L;
      if (!L || !this._map) return;
      const update = (lat, lon) => {
        const z = this._map?.getZoom?.();
        this._updateBottomBarCoords(lat, lon, z);
      };
      this._map.on("mousemove", (e) => update(e.latlng.lat, e.latlng.lng));
      this._map.on("zoomend moveend", () => {
        const c = this._map.getCenter();
        update(c.lat, c.lng);
        this._updateBottomBarScaleFromMap();
      });
      const initCenter = this._map.getCenter();
      if (initCenter) update(initCenter.lat, initCenter.lng);
      this._updateBottomBarScaleFromMap();
    }

    _updateBottomBarScaleFromMap() {
      if (!this._map) return;
      const center = this._map.getCenter();
      const zoom = this._map.getZoom();
      const metersPerPixel = 40075016.686 * Math.abs(Math.cos(center.lat * Math.PI / 180)) / Math.pow(2, zoom + 8);
      const barWidth = 60;
      const meters = metersPerPixel * barWidth;
      let label = "";
      if (meters >= 1000) {
        const km = Math.round(meters / 1000);
        label = `${km} km`;
      } else {
        label = `${Math.round(meters)} m`;
      }
      const miles = meters / 1609.34;
      if (miles >= 1) {
        label += ` / ${Math.round(miles)} mi`;
      } else {
        label += ` / ${Math.round(meters * 3.281)} ft`;
      }
      const line = this._root?.querySelector(".hw-map-readout .hw-scale-line");
      const lbl = this._root?.querySelector(".hw-map-readout .hw-scale-label");
      if (line) line.style.width = `${barWidth}px`;
      if (lbl) lbl.textContent = label;
    }

    _buildLegendElement(collapsed = true) {
      const L = global.L;
      const div = L.DomUtil.create("div", `hw-legend${collapsed ? " collapsed" : ""}`);
      const catRows = [
        { c: CATEGORY_COLORS[0], t: "TD / TS", b: "TS" },
        { c: CATEGORY_COLORS[1], t: "Category 1", b: "1" },
        { c: CATEGORY_COLORS[2], t: "Category 2", b: "2" },
        { c: CATEGORY_COLORS[3], t: "Category 3", b: "3" },
        { c: CATEGORY_COLORS[4], t: "Category 4", b: "4" },
        { c: CATEGORY_COLORS[5], t: "Category 5", b: "5" },
      ];
      div.innerHTML = `
        <div class="hw-legend-header" role="button" tabindex="0" aria-expanded="${!collapsed}">
          <span>Legend</span><span class="hw-legend-caret" aria-hidden="true">▾</span>
        </div>
        <div class="hw-legend-body">
          <div class="hw-legend-group">
            <div class="hw-legend-group-title">Storm intensity</div>
            ${catRows.map((r) => `<div class="hw-legend-row"><span class="hw-legend-badge" style="background:${r.c}">${r.b}</span>${r.t}</div>`).join("")}
          </div>
          <div class="hw-legend-group">
            <div class="hw-legend-group-title">Storm tracks</div>
            <div class="hw-legend-row"><span class="hw-legend-line is-fcst"></span>Forecast track</div>
            <div class="hw-legend-row"><span class="hw-legend-swatch" style="background:rgba(229,57,53,0.18);border-color:rgba(229,57,53,0.8)"></span>Forecast cone (uncertainty)</div>
            <div class="hw-legend-row"><span class="hw-legend-line is-watchline"></span>Coastal watch / warning</div>
            <div class="hw-legend-row"><img src="/local/home_weather/icons/disturbance.svg" alt=""/>NHC disturbance</div>
            <div class="hw-legend-row"><span class="hw-legend-swatch" style="background:rgba(255,167,38,0.25);border-color:#ffa726;border-style:dashed"></span>Development area</div>
          </div>
          <div class="hw-legend-group">
            <div class="hw-legend-group-title">Earthquake magnitude</div>
            ${EQ_SCALE.map((r) => `<div class="hw-legend-row"><span class="hw-legend-dot" style="background:${r.color}"></span>${r.label}</div>`).join("")}
          </div>
          <div class="hw-legend-group">
            <div class="hw-legend-group-title">Other layers</div>
            <div class="hw-legend-row"><img src="/local/home_weather/icons/tornado.svg" alt=""/>Tornado warning</div>
            <div class="hw-legend-row"><img src="/local/home_weather/icons/lightning-bolt.svg" alt=""/>Live strike (Blitzortung)</div>
            <div class="hw-legend-row"><img src="/local/home_weather/icons/volcano.svg" alt="" style="opacity:0.55"/>Volcano (catalog)</div>
            <div class="hw-legend-row"><img src="/local/home_weather/icons/volcano.svg" alt=""/>Active volcano + affected area</div>
            <div class="hw-legend-row"><img src="/local/home_weather/icons/fire.svg" alt=""/>Active wildfire</div>
            <div class="hw-legend-row"><span class="hw-legend-swatch" style="background:rgba(229,57,53,0.35);border-color:#e53935"></span>Fire perimeter</div>
            <div class="hw-legend-row"><span class="hw-legend-swatch" style="background:rgba(76,175,80,0.45);border-color:#4caf50"></span>Travel L1 — Normal</div>
            <div class="hw-legend-row"><span class="hw-legend-swatch" style="background:rgba(255,241,118,0.5);border-color:#fff176"></span>Travel L2 — Caution</div>
            <div class="hw-legend-row"><span class="hw-legend-swatch" style="background:rgba(255,152,0,0.5);border-color:#ff9800"></span>Travel L3 — Reconsider</div>
            <div class="hw-legend-row"><span class="hw-legend-swatch" style="background:rgba(244,67,54,0.55);border-color:#f44336"></span>Travel L4 — Do not travel</div>
            <div class="hw-legend-row"><span class="hw-legend-swatch" style="background:rgba(0,228,0,0.25);border-color:#00e400"></span>AQI Good</div>
            <div class="hw-legend-row"><span class="hw-legend-swatch" style="background:rgba(255,255,0,0.3);border-color:#ffff00"></span>AQI Moderate</div>
            <div class="hw-legend-row"><span class="hw-legend-swatch" style="background:rgba(255,126,0,0.35);border-color:#ff7e00"></span>AQI USG</div>
            <div class="hw-legend-row"><span class="hw-legend-swatch" style="background:rgba(255,0,0,0.4);border-color:#ff0000"></span>AQI Unhealthy+</div>
            <div class="hw-legend-row"><img src="/local/home_weather/icons/home.svg" alt=""/>Your home</div>
          </div>
        </div>`;
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      const header = div.querySelector(".hw-legend-header");
      const toggle = () => {
        const isCollapsed = div.classList.toggle("collapsed");
        header.setAttribute("aria-expanded", String(!isCollapsed));
      };
      header.addEventListener("click", toggle);
      header.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); }
      });
      return div;
    }

    _buildMapControlsStack() {
      const L = global.L;
      if (!L || !this._map) return;
      const corner = this._map._controlCorners?.topleft;
      if (!corner || corner.querySelector(".hw-map-controls-stack")) return;

      corner.querySelectorAll(".leaflet-control-layers, .leaflet-control-zoom, .hw-measure-ctrl").forEach((el) => {
        el.closest(".leaflet-control")?.remove();
      });

      this._activeBasemap = this._activeBasemap || (this._theme === "light" ? "Light" : "Dark");

      const stack = L.DomUtil.create("div", "hw-map-controls-stack leaflet-control");
      const toolbar = L.DomUtil.create("div", "hw-map-toolbar");
      const readoutRow = L.DomUtil.create("div", "hw-measure-readout-row");
      readoutRow.textContent = "";
      this._mapControlsStack = stack;
      this._measureReadoutRow = readoutRow;

      const basemapCell = L.DomUtil.create("div", "hw-map-tool-cell hw-basemap-cell", toolbar);
      const basemapBtn = L.DomUtil.create("button", "hw-map-tool-btn hw-basemap-btn", basemapCell);
      basemapBtn.type = "button";
      basemapBtn.title = "Change basemap";
      basemapBtn.setAttribute("aria-label", "Change basemap");
      basemapBtn.setAttribute("aria-haspopup", "menu");
      basemapBtn.setAttribute("aria-expanded", "false");
      basemapBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 2 2 7l10 5 10-5L12 2zm0 7.5L4.5 6.5V16l7.5 4.3V9.5zm2 8.8 7.5-4.3V8.5L14 12.3v5.8z"/></svg>`;
      const basemapMenu = L.DomUtil.create("div", "hw-basemap-menu", basemapCell);
      basemapMenu.setAttribute("role", "menu");
      basemapMenu.hidden = true;
      this._basemapMenu = basemapMenu;
      this._basemapBtn = basemapBtn;

      const layerNames = Object.keys(this._baseLayers || {});
      layerNames.forEach((name) => {
        const item = L.DomUtil.create("button", "hw-basemap-option", basemapMenu);
        item.type = "button";
        item.setAttribute("role", "menuitem");
        item.dataset.layer = name;
        item.innerHTML = `<span class="hw-basemap-check"></span><span>${name}</span>`;
        L.DomEvent.on(item, "click", (e) => {
          L.DomEvent.stop(e);
          this._setBasemap(name);
          this._closeBasemapMenu();
        });
      });
      this._updateBasemapMenuChecks();

      L.DomEvent.on(basemapBtn, "click", (e) => {
        L.DomEvent.stop(e);
        if (basemapMenu.hidden) this._openBasemapMenu();
        else this._closeBasemapMenu();
      });
      L.DomEvent.disableClickPropagation(basemapCell);

      const zoomInCell = L.DomUtil.create("div", "hw-map-tool-cell", toolbar);
      const zoomInBtn = L.DomUtil.create("button", "hw-map-tool-btn hw-zoom-btn", zoomInCell);
      zoomInBtn.type = "button";
      zoomInBtn.title = "Zoom in";
      zoomInBtn.setAttribute("aria-label", "Zoom in");
      zoomInBtn.textContent = "+";
      L.DomEvent.on(zoomInBtn, "click", (e) => { L.DomEvent.stop(e); this._map.zoomIn(); });

      const zoomOutCell = L.DomUtil.create("div", "hw-map-tool-cell", toolbar);
      const zoomOutBtn = L.DomUtil.create("button", "hw-map-tool-btn hw-zoom-btn", zoomOutCell);
      zoomOutBtn.type = "button";
      zoomOutBtn.title = "Zoom out";
      zoomOutBtn.setAttribute("aria-label", "Zoom out");
      zoomOutBtn.textContent = "−";
      L.DomEvent.on(zoomOutBtn, "click", (e) => { L.DomEvent.stop(e); this._map.zoomOut(); });

      const measureCell = L.DomUtil.create("div", "hw-map-tool-cell", toolbar);
      const measureBtn = L.DomUtil.create("button", "hw-map-tool-btn hw-measure-btn", measureCell);
      measureBtn.type = "button";
      measureBtn.title = "Measure distance";
      measureBtn.setAttribute("aria-label", "Measure distance");
      measureBtn.setAttribute("aria-pressed", "false");
      measureBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M21 6H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1zm-1 6h-2V9h-1.5v3h-1.5v-2h-1.5v2h-1.5V9H10v3H8.5v-2H7v2H5.5V9H4v3H3V8h17v4z"/></svg>`;
      this._measureBtn = measureBtn;
      L.DomEvent.on(measureBtn, "click", (e) => { L.DomEvent.stop(e); this._toggleMeasure(); });

      const legend = this._buildLegendElement(true);
      this._legendEl = legend;

      stack.appendChild(toolbar);
      stack.appendChild(readoutRow);
      stack.appendChild(legend);
      corner.insertBefore(stack, corner.firstChild);
    }

    _updateBasemapMenuChecks() {
      if (!this._basemapMenu) return;
      this._basemapMenu.querySelectorAll(".hw-basemap-option").forEach((item) => {
        const check = item.querySelector(".hw-basemap-check");
        if (check) check.textContent = item.dataset.layer === this._activeBasemap ? "✓" : "";
      });
    }

    /** User-driven basemap change (records the explicit choice). */
    _setBasemap(name) {
      this._userChoseBasemap = true;
      this._applyBasemap(name);
    }

    /** Apply a basemap without treating it as a user preference. */
    _applyBasemap(name) {
      const layers = this._baseLayers;
      if (!layers?.[name] || !this._map) return;
      Object.entries(layers).forEach(([key, layer]) => {
        if (key === name) {
          if (!this._map.hasLayer(layer)) layer.addTo(this._map);
        } else if (this._map.hasLayer(layer)) {
          this._map.removeLayer(layer);
        }
      });
      this._activeBasemap = name;
      this._updateBasemapMenuChecks();
    }

    _openBasemapMenu() {
      if (!this._basemapMenu || !this._basemapBtn) return;
      this._basemapMenu.hidden = false;
      this._basemapBtn.setAttribute("aria-expanded", "true");
      this._basemapBtn.classList.add("active");
    }

    _closeBasemapMenu() {
      if (!this._basemapMenu || !this._basemapBtn) return;
      this._basemapMenu.hidden = true;
      this._basemapBtn.setAttribute("aria-expanded", "false");
      this._basemapBtn.classList.remove("active");
    }

    _setMeasureReadout(text) {
      const value = text || "";
      if (this._measureReadoutRow) this._measureReadoutRow.textContent = value;
      if (this._mapControlsStack) {
        this._mapControlsStack.classList.toggle("measure-active", Boolean(value));
      }
    }

    _toggleMeasure() {
      const L = global.L;
      if (!L || !this._map) return;
      this._measureActive = !this._measureActive;
      this._measureBtn?.setAttribute("aria-pressed", this._measureActive ? "true" : "false");
      if (this._measureActive) {
        this._measurePoints = [];
        if (!this._measureLayer) this._measureLayer = L.layerGroup().addTo(this._map);
        this._map.doubleClickZoom.disable();
        this._measureBtn?.classList.add("active");
        L.DomUtil.addClass(this._map.getContainer(), "hw-measuring");
        this._measureClickHandler = (e) => this._onMeasureClick(e);
        this._measureDblHandler = () => { this._measureActive && this._toggleMeasure(); };
        this._map.on("click", this._measureClickHandler);
        this._map.on("dblclick", this._measureDblHandler);
        this._setMeasureReadout("Click points…");
      } else {
        this._map.off("click", this._measureClickHandler);
        this._map.off("dblclick", this._measureDblHandler);
        this._map.doubleClickZoom.enable();
        this._measureBtn?.classList.remove("active");
        L.DomUtil.removeClass(this._map.getContainer(), "hw-measuring");
        this._measureLayer?.clearLayers();
        this._measurePoints = [];
        this._setMeasureReadout("");
      }
    }

    _onMeasureClick(e) {
      this._measurePoints.push(e.latlng);
      this._redrawMeasure();
    }

    _redrawMeasure() {
      const L = global.L;
      if (!L || !this._measureLayer) return;
      this._measureLayer.clearLayers();
      const pts = this._measurePoints;
      if (pts.length === 0) return;
      L.polyline(pts, { color: "#29b6f6", weight: 2, dashArray: "5 5", opacity: 0.95 }).addTo(this._measureLayer);
      let meters = 0;
      pts.forEach((p, i) => {
        if (i > 0) meters += pts[i - 1].distanceTo(p);
        L.circleMarker(p, { radius: 3, color: "#fff", weight: 1, fillColor: "#29b6f6", fillOpacity: 1 }).addTo(this._measureLayer);
      });
      const miles = meters / 1609.344;
      const km = meters / 1000;
      const text = miles >= 1
        ? `${miles.toFixed(1)} mi · ${km.toFixed(1)} km`
        : `${Math.round(meters * 3.28084)} ft · ${Math.round(meters)} m`;
      this._setMeasureReadout(pts.length < 2 ? "Click next point…" : text);
      if (pts.length >= 2) {
        L.marker(pts[pts.length - 1], { opacity: 0 })
          .bindTooltip(text, { permanent: true, direction: "top", className: "hw-measure-tip", offset: [0, -4] })
          .addTo(this._measureLayer)
          .openTooltip();
      }
    }

    /* ------------------------------------------------------------------ */
    /* Map rendering                                                       */
    /* ------------------------------------------------------------------ */

    _renderMap(fitView = false) {
      const storms = this._data?.storms || [];
      const outlook = this._data?.outlook || {};
      const home = this._resolveHome();
      if (!this._ensureMap() || !this._map || !this._layerGroup) return;

      this._layerGroup.clearLayers();
      if (this._earthquakeClusterGroup) this._earthquakeClusterGroup.clearLayers();
      if (this._volcanoClusterGroup) this._volcanoClusterGroup.clearLayers();
      this._renderHomeMarker();

      const bounds = [];
      const layers = this._mapLayers || { hurricane: true, tornado: true, earthquakes: true };

      if (layers.travel !== false) {
        this._drawTravelAdvisories(bounds);
      }

      if (layers.wildfire !== false) {
        this._drawWildfires(bounds);
      }

      if (layers.hurricane) {
        this._drawOutlook(outlook, bounds);
        storms.forEach((storm, idx) => {
          const color = STORM_COLORS[idx % STORM_COLORS.length];
          this._drawStorm(storm, color, bounds);
        });
      }

      if (layers.tornado) {
        this._drawTornadoWarnings(bounds);
      }

      if (layers.earthquakes) {
        this._drawEarthquakes(bounds);
      }

      if (layers.volcanoes !== false) {
        this._drawVolcanoes();
      }

      if (layers.air_quality !== false) {
        this._drawAirQuality(bounds);
      }

      if (home?.lat != null && home?.lon != null) {
        bounds.push([home.lat, home.lon]);
      }

      if (this._showZones && home?.lat != null && home?.lon != null) {
        this._drawZoneOverlay(home);
      }

      if (fitView || !this._hasInitialFit) {
        this._fitMapView(bounds);
      }
      const settleFit = () => {
        if (!this._map) return;
        this._map.invalidateSize();
        // If the initial fit was skipped because the container wasn't sized
        // yet, apply it now that the map has real dimensions.
        if (!this._hasInitialFit) this._fitMapView(this._lastFitBounds || bounds);
      };
      setTimeout(settleFit, 100);
      setTimeout(settleFit, 350);
    }

    /** Draw the configured alert-zone circles around home (My zones overlay). */
    _drawZoneOverlay(home) {
      const L = global.L;
      const zones = Array.isArray(this._zoneConfig) ? this._zoneConfig : [];

      // Tear down any curved labels from a previous render so we never leak
      // orphaned <text> nodes into the shared overlay SVG.
      (this._zoneTextEls || []).forEach((el) => el?.remove?.());
      this._zoneTextEls = [];
      this._zoneLabelUpdaters = [];

      // Rescale every curved label whenever the zoom (and therefore the
      // circle's pixel radius) changes. Registered once for the map's lifetime.
      if (!this._zoneZoomHooked && this._map) {
        this._zoneZoomHooked = true;
        this._map.on("zoomend", () =>
          (this._zoneLabelUpdaters || []).forEach((fn) => this._safe(fn)),
        );
      }

      const SVGNS = "http://www.w3.org/2000/svg";
      const XLINKNS = "http://www.w3.org/1999/xlink";

      zones.forEach((zone) => {
        if (!zone || !zone.enabled || !(zone.radius_miles > 0)) return;
        const sensorBypassed = zone.zone_mode === "all";
        const alertBypassed = (zone.alert_zone_mode ?? zone.zone_mode) === "all";
        const bypassed = sensorBypassed && (!zone.has_alerts || alertBypassed);
        const radiusMeters = zone.radius_miles * 1609.34;
        const circle = L.circle([home.lat, home.lon], {
          radius: radiusMeters,
          color: zone.color || "#29b6f6",
          weight: bypassed ? 1 : 2,
          opacity: bypassed ? 0.35 : 0.75,
          dashArray: bypassed ? "4 8" : "6 4",
          fillColor: zone.color || "#29b6f6",
          fillOpacity: bypassed ? 0.02 : 0.05,
          interactive: false,
          pane: "overlayPane",
        }).addTo(this._layerGroup);

        // The SVG renderer draws the circle as a <path>; a <textPath> that
        // references that path lets a single line of text follow the curve and
        // reproject automatically on pan/zoom. Leaflet's circle path starts due
        // west and runs along the bottom of the ring first, so a 25% offset
        // centers the label due south of home where it reads upright.
        // (Canvas renderer has no _path.)
        const path = circle._path;
        if (!path || !path.parentNode || typeof document === "undefined") return;

        const scopeWord = (b) => (b ? "bypassed" : "active");
        const parts = [zone.label || zone.key, `sensor ${scopeWord(sensorBypassed)}`];
        if (zone.has_alerts) parts.push(`alerts ${scopeWord(alertBypassed)}`);
        const lineText = parts.join("  \u00b7  ");

        const pathId = `hw-zone-path-${(this._zonePathSeq = (this._zonePathSeq || 0) + 1)}`;
        path.setAttribute("id", pathId);

        const textEl = document.createElementNS(SVGNS, "text");
        textEl.setAttribute("class", `hw-zone-arc-label${bypassed ? " is-bypassed" : ""}`);
        // Lift the baseline just off the stroke so text sits above the border.
        textEl.setAttribute("dy", "-6");
        const textPath = document.createElementNS(SVGNS, "textPath");
        textPath.setAttributeNS(XLINKNS, "xlink:href", `#${pathId}`);
        textPath.setAttribute("href", `#${pathId}`);
        textPath.setAttribute("startOffset", "25%");
        textPath.setAttribute("text-anchor", "middle");
        textPath.textContent = lineText;
        textEl.appendChild(textPath);
        path.parentNode.appendChild(textEl);
        this._zoneTextEls.push(textEl);

        // Size the font to the zone: bigger radius -> bigger text. Hide the
        // label entirely when the circle is too small to read cleanly.
        const updateFont = () => {
          const rPx = circle._radius;
          if (!rPx) return;
          const fontSize = Math.max(10, Math.min(19, rPx * 0.09));
          textEl.setAttribute("font-size", `${fontSize}px`);
          textEl.style.display = rPx < 42 ? "none" : "";
        };
        updateFont();
        this._zoneLabelUpdaters.push(updateFont);
      });
    }

    _milesToLatOffset(miles) {
      return Number(miles) / 69.0;
    }

    _milesToLonOffset(miles, lat) {
      const cos = Math.cos((Number(lat) * Math.PI) / 180);
      return Number(miles) / (69.0 * Math.max(0.15, Math.abs(cos)));
    }

    /**
     * Bounds covering home plus the largest configured alert-zone radius.
     * Used for the initial map view when no hazard geometry is in frame yet.
     */
    _getConfiguredZoneFitBounds() {
      const L = global.L;
      const home = this._resolveHome();
      if (!home || !L) return null;

      const zones = Array.isArray(this._zoneConfig) ? this._zoneConfig : [];
      let maxRadius = 0;
      zones.forEach((zone) => {
        if (!zone || zone.enabled === false) return;
        const miles = Number(zone.radius_miles);
        if (Number.isFinite(miles) && miles > 0) {
          maxRadius = Math.max(maxRadius, miles);
        }
      });
      if (maxRadius <= 0) maxRadius = 75;

      const dLat = this._milesToLatOffset(maxRadius);
      const dLon = this._milesToLonOffset(maxRadius, home.lat);
      return L.latLngBounds(
        [home.lat - dLat, home.lon - dLon],
        [home.lat + dLat, home.lon + dLon],
      );
    }

    _fitMapView(stormBounds) {
      const L = global.L;
      const usa = this._getUsaBounds();
      if (!this._map || !L) return;
      if (this._userViewLocked) return;

      // Remember the requested bounds so we can retry once the container is
      // actually sized (fitBounds on a 0x0 container produces a broken view).
      this._lastFitBounds = stormBounds;
      const size = this._map.getSize?.();
      if (size && (size.x < 1 || size.y < 1)) {
        // Container not laid out yet — keep the default view and retry later.
        return;
      }

      const fitOpts = { padding: [48, 48], maxZoom: 10 };
      const hazardPoints = this._collectFitPoints(stormBounds);
      const zoneBounds = this._getConfiguredZoneFitBounds();
      let targetBounds = null;

      if (hazardPoints.length > 0) {
        targetBounds = L.latLngBounds(hazardPoints);
        if (zoneBounds) targetBounds = targetBounds.extend(zoneBounds);
      } else if (zoneBounds) {
        targetBounds = zoneBounds;
      } else if (usa) {
        targetBounds = usa;
      }

      if (!targetBounds) return;

      const lngSpan = targetBounds.getEast() - targetBounds.getWest();
      const latSpan = targetBounds.getNorth() - targetBounds.getSouth();
      if (lngSpan > 170 || latSpan > 120) {
        // Guard against antimeridian / bad coordinates blowing the fit out to
        // the entire tiled world. Prefer the configured home zones, then USA.
        targetBounds = zoneBounds || usa;
        if (!targetBounds) return;
      }

      this._map.fitBounds(targetBounds, fitOpts);
      this._hasInitialFit = true;
    }

    /**
     * Normalize the mixed bounds array (which may contain [lat, lon] tuples,
     * L.LatLng points, and L.LatLngBounds objects) into a flat list of valid
     * [lat, lon] points, dropping anything non-finite or out of range.
     */
    _collectFitPoints(entries) {
      const out = [];
      const push = (lat, lon) => {
        const la = Number(lat);
        const lo = Number(lon);
        if (!Number.isFinite(la) || !Number.isFinite(lo)) return;
        if (la < -85 || la > 85 || lo < -180 || lo > 180) return;
        out.push([la, lo]);
      };
      (Array.isArray(entries) ? entries : []).forEach((entry) => {
        if (!entry) return;
        if (Array.isArray(entry) && entry.length >= 2) {
          push(entry[0], entry[1]);
        } else if (typeof entry.getNorthEast === "function") {
          const ne = entry.getNorthEast();
          const sw = entry.getSouthWest();
          if (ne) push(ne.lat, ne.lng);
          if (sw) push(sw.lat, sw.lng);
        } else if (entry.lat != null && (entry.lng != null || entry.lon != null)) {
          push(entry.lat, entry.lng != null ? entry.lng : entry.lon);
        }
      });
      return out;
    }

    _drawOutlook(outlook, bounds) {
      const L = global.L;
      if (!L || !outlook) return;
      const tier = this._getDetailTier();
      const showIcons = tier >= 1;

      const regionGeo = outlook.developmentRegion;
      if (regionGeo?.features?.length) {
        L.geoJSON(regionGeo, {
          style: (feature) => {
            const prob = String(feature?.properties?.prob7day || feature?.properties?.prob2day || "");
            let fill = "#ffb74d";
            if (prob.includes("70") || prob.includes("80") || prob.includes("90")) fill = "#ef5350";
            else if (prob.includes("40") || prob.includes("50") || prob.includes("60")) fill = "#ffa726";
            return {
              color: fill,
              weight: 1,
              fillColor: fill,
              fillOpacity: 0.18,
              opacity: 0.75,
              dashArray: "6 4",
            };
          },
          onEachFeature: (feature, layer) => {
            const props = feature.properties || {};
            const label = [
              props.basin ? `Basin: ${props.basin}` : "",
              props.prob2day ? `2-day: ${props.prob2day}` : "",
              props.prob7day ? `7-day: ${props.prob7day}` : "",
              props.risk2day ? `2-day risk: ${props.risk2day}` : "",
              props.risk7day ? `7-day risk: ${props.risk7day}` : "",
            ].filter(Boolean).join("<br/>");
            const popup = label ? `<strong>Potential development</strong><br/>${label}` : "";
            if (popup) layer.bindPopup(popup);
            const center = this._getFeatureCenterLatLng(feature);
            if (center) {
              this._addHazardMarker(center[0], center[1], "disturbance", {
                size: 26,
                show: showIcons,
                popup,
                zIndexOffset: 320,
              });
            }
          },
        }).addTo(this._layerGroup).eachLayer((layer) => {
          if (layer.getBounds) bounds.push(layer.getBounds());
        });
      }

      const motionGeo = outlook.developmentMotion;
      if (motionGeo?.features?.length) {
        L.geoJSON(motionGeo, {
          style: {
            color: "#ffb74d",
            weight: 2,
            opacity: 0.7,
            dashArray: "8 6",
          },
        }).addTo(this._layerGroup).eachLayer((layer) => {
          if (layer.getBounds) bounds.push(layer.getBounds());
        });
      }

      this._drawOutlookPoints(outlook.twoDayLocation, "#ffd54f", "2-day disturbance", bounds, showIcons);
      this._drawOutlookPoints(outlook.sevenDayLocation, "#ff9800", "7-day disturbance", bounds, showIcons);
    }

    _drawOutlookPoints(geo, color, title, bounds, showIcons) {
      const L = global.L;
      if (!L || !geo?.features?.length) return;
      if (showIcons === undefined) showIcons = this._getDetailTier() >= 1;

      geo.features.forEach((feature) => {
        const geom = feature.geometry || {};
        const coords = geom.coordinates;
        if (!coords || coords.length < 2) return;
        const lon = coords[0];
        const lat = coords[1];
        const props = feature.properties || {};
        const popup = [
          `<strong>${title}</strong>`,
          props.basin ? `Basin: ${this._esc(props.basin)}` : "",
          props.prob2day ? `2-day: ${this._esc(props.prob2day)}` : "",
          props.prob7day ? `7-day: ${this._esc(props.prob7day)}` : "",
          props.risk2day ? `2-day risk: ${this._esc(props.risk2day)}` : "",
          props.risk7day ? `7-day risk: ${this._esc(props.risk7day)}` : "",
        ].filter(Boolean).join("<br/>");
        this._addHazardMarker(lat, lon, "disturbance", {
          size: 24,
          show: showIcons,
          popup,
          zIndexOffset: 310,
        });
        bounds.push([lat, lon]);
      });
    }

    /** Rich detail card shown when a storm marker is clicked/tapped. */
    _buildStormCardHtml(storm) {
      const cat = this._stormCatInfo(storm.category, storm.maxWindMph);
      const pos = storm.currentPosition;
      const distNow = pos ? this._distanceFromHomeMiles(pos.lat, pos.lon) : null;
      const approach = this._stormClosestApproach(storm);
      const cell = (k, v) => `<div class="hw-storm-card-cell"><span class="k">${k}</span><span class="v">${v}</span></div>`;
      let approachText = "—";
      if (approach) {
        const bits = [this._fmtMiles(approach.miles)];
        if (approach.hour != null) bits.push(`+${approach.hour}h`);
        approachText = bits.join(" · ");
      }
      return `
        <div class="hw-storm-card">
          <div class="hw-storm-card-head">
            <span class="hw-storm-card-badge" style="background:${cat.color}">${cat.label}</span>
            <span class="hw-storm-card-names">
              <strong>${this._esc(storm.name || "Unnamed storm")}</strong>
              <span>${cat.longName}</span>
            </span>
          </div>
          <div class="hw-storm-card-grid">
            ${cell("Max winds", storm.maxWindMph != null ? `${Math.round(Number(storm.maxWindMph))} mph` : "—")}
            ${cell("Pressure", storm.pressureMb != null ? `${storm.pressureMb} mb` : "—")}
            ${cell("Movement", this._esc(storm.movement || "—"))}
            ${cell("From home", distNow != null ? this._fmtMiles(distNow) : "—")}
            ${cell("Closest approach", approachText)}
            ${cell("Advisory", this._esc(storm.advisoryTime || "—"))}
          </div>
        </div>`;
    }

    /**
     * Storm rendering, redesigned for readability:
     *  - past track: dotted muted line + small hollow dots (hover for details)
     *  - forecast track: solid storm-colored line over a theme casing line
     *  - forecast points: intensity-colored dots with time/cat/wind info
     *  - cone: restrained fill + neutral outline (uncertainty area)
     *  - current position: circular Saffir-Simpson badge (TD/TS/1–5)
     */
    _drawStorm(storm, color, bounds) {
      const L = global.L;
      const tier = this._getDetailTier();
      const compact = this._isCompactLayout();
      const isPrimary = storm.id && storm.id === this._data?.summary?.closestStormId;
      const light = this._theme === "light";
      const casingColor = light ? "rgba(20, 28, 40, 0.8)" : "rgba(255, 255, 255, 0.85)";
      const pastColor = light ? "#5b6672" : "#94a3b1";
      const cat = this._stormCatInfo(storm.category, storm.maxWindMph);
      const stormCard = this._buildStormCardHtml(storm);

      /* Forecast uncertainty cone (area, under everything else). */
      if (storm.cone?.coordinates) {
        const coneLayer = L.geoJSON(storm.cone, {
          style: {
            color: casingColor,
            weight: 1.5,
            opacity: 0.7,
            fillColor: color,
            fillOpacity: light ? 0.14 : 0.11,
          },
        }).addTo(this._layerGroup);
        coneLayer.eachLayer((layer) => {
          if (layer.getBounds) bounds.push(layer.getBounds());
        });
      }

      if (this._showWindRadii && storm.windRadii) {
        L.geoJSON(storm.windRadii, {
          style: {
            color,
            weight: 1.2,
            dashArray: "4 4",
            fillOpacity: 0.05,
            opacity: 0.55,
          },
        }).addTo(this._layerGroup);
      }

      /* Forecast track: solid storm color over a contrast casing. */
      let fcstLatLngs = null;
      if (storm.track?.coordinates?.length) {
        fcstLatLngs = storm.track.coordinates.map((c) => [c[1], c[0]]);
      } else {
        const pts = (storm.forecastPoints || []).filter((p) => p.lat != null && p.lon != null);
        if (pts.length >= 2) fcstLatLngs = pts.map((p) => [p.lat, p.lon]);
      }
      if (fcstLatLngs?.length) {
        L.polyline(fcstLatLngs, {
          color: casingColor,
          weight: 7,
          opacity: 0.55,
          lineCap: "round",
          lineJoin: "round",
        }).addTo(this._layerGroup);
        L.polyline(fcstLatLngs, {
          color,
          weight: 3.5,
          opacity: 0.95,
          lineCap: "round",
          lineJoin: "round",
        }).addTo(this._layerGroup);
        fcstLatLngs.forEach((ll) => bounds.push(ll));
      }

      /* Coastal watch/warning segments. */
      if (storm.watchWarning?.coordinates?.length) {
        const watchLatLngs = storm.watchWarning.coordinates.map((c) => [c[1], c[0]]);
        L.polyline(watchLatLngs, {
          color: "#f44336",
          weight: 3,
          opacity: 0.85,
        }).addTo(this._layerGroup);
        watchLatLngs.forEach((ll) => bounds.push(ll));
      }

      /* Past positions: small hollow dots with hover detail. */
      (storm.pastPoints || []).forEach((pt) => {
        if (pt.lat == null || pt.lon == null) return;
        const marker = L.circleMarker([pt.lat, pt.lon], {
          radius: 3.5,
          color: pastColor,
          weight: 1.5,
          fillColor: light ? "#fff" : "#1c222c",
          fillOpacity: 0.9,
        }).addTo(this._layerGroup);
        const time = this._fmtValidTime(pt.validTime);
        const info = [
          time ? this._esc(time) : "",
          pt.maxWindMph != null ? `${Math.round(Number(pt.maxWindMph))} mph` : "",
        ].filter(Boolean).join(" · ");
        marker.bindTooltip(
          `<div class="hw-tip-line1">Past position</div>${info ? `<div class="hw-tip-line2">${info}</div>` : ""}`,
          { direction: "top", className: "hw-tip", offset: [0, -6], sticky: false },
        );
        bounds.push([pt.lat, pt.lon]);
      });

      /* Forecast positions: intensity-colored dots + time/cat/wind info. */
      (storm.forecastPoints || []).forEach((pt) => {
        if (pt.lat == null || pt.lon == null) return;
        const ptCat = this._stormCatInfo(null, pt.maxWindMph);
        const marker = L.circleMarker([pt.lat, pt.lon], {
          radius: compact ? 7 : 6,
          color: casingColor,
          weight: 2,
          fillColor: pt.maxWindMph != null ? ptCat.color : color,
          fillOpacity: 1,
          bubblingMouseEvents: false,
        }).addTo(this._layerGroup);

        const line1 = [
          pt.hour != null ? `+${pt.hour}h` : "",
          this._fmtValidTime(pt.validTime),
        ].filter(Boolean).join(" · ");
        const line2 = [
          pt.maxWindMph != null ? ptCat.longName : "",
          pt.maxWindMph != null ? `${Math.round(Number(pt.maxWindMph))} mph` : "",
          pt.pressureMb != null ? `${pt.pressureMb} mb` : "",
        ].filter(Boolean).join(" · ");
        const tipHtml = `
          <div class="hw-tip-line1">${this._esc(line1 || "Forecast position")}</div>
          ${line2 ? `<div class="hw-tip-line2">${this._esc(line2)}</div>` : ""}`;
        marker.bindTooltip(tipHtml, { direction: "top", className: "hw-tip", offset: [0, -8] });
        // Tap-friendly: same info as a popup for touch devices.
        marker.bindPopup(`<strong>${this._esc(storm.name || "Storm")} forecast</strong><br/>${this._esc(line1)}${line2 ? `<br/>${this._esc(line2)}` : ""}`);

        // Permanent "+48h" pills live on a separate invisible anchor so they
        // can coexist with the hover tooltip (Leaflet allows one per layer).
        if (pt.hour != null && tier >= 2) {
          L.marker([pt.lat, pt.lon], { opacity: 0, interactive: false, keyboard: false })
            .bindTooltip(`+${pt.hour}h`, {
              permanent: true,
              direction: "right",
              className: "hw-fcst-hour",
              offset: [10, 0],
            })
            .addTo(this._layerGroup)
            .openTooltip();
        }
        bounds.push([pt.lat, pt.lon]);
      });

      /* Current position: category-colored hurricane icon. */
      const badgeSize = compact ? 44 : 40;
      const stormIcon = L.divIcon({
        className: "hw-hazard-icon-marker",
        html: `<div class="hw-hurricane-marker${isPrimary ? " is-primary" : ""}" style="--cat-color:${cat.color}"><div class="hw-hurricane-disc"><img src="/local/home_weather/icons/hurricane.svg" alt="" draggable="false"/></div><span class="hw-hurricane-cat">${cat.label}</span></div>`,
        iconSize: [badgeSize, badgeSize],
        iconAnchor: [badgeSize / 2, badgeSize / 2],
      });

      const stormLabel = this._formatStormLabel(storm);
      const addStormMarker = (latlng) => {
        const marker = L.marker(latlng, {
          icon: stormIcon,
          zIndexOffset: 500,
          alt: `${stormLabel.name} — ${cat.longName}`,
        }).bindPopup(stormCard, { className: "hw-storm-popup", maxWidth: 300 });
        if (stormLabel.name) {
          marker.bindTooltip(this._esc(stormLabel.name), {
            permanent: true,
            direction: "top",
            className: "hw-name-label hw-storm-label",
            offset: [0, -(badgeSize / 2) - 3],
          });
        }
        marker.addTo(this._layerGroup);
        // Color the name label's accent bar to match the storm identity.
        const tipEl = marker.getTooltip()?.getElement?.();
        if (tipEl) tipEl.style.setProperty("--storm-color", color);
        bounds.push(latlng);
      };

      const pos = storm.currentPosition;
      if (pos?.lat != null && pos?.lon != null) {
        addStormMarker([pos.lat, pos.lon]);
      } else if (storm.cone) {
        const center = this._getFeatureCenterLatLng({ type: "Feature", geometry: storm.cone, properties: {} });
        if (center) {
          addStormMarker(center);
        }
      }
    }

    _drawTornadoWarnings(bounds) {
      const L = global.L;
      const geojson = this._tornadoData?.geojson;
      if (!L || !geojson?.features?.length || !this._layerGroup) return;

      L.geoJSON(geojson, {
        style: {
          color: "#e040fb",
          weight: 2,
          opacity: 0.95,
          fillColor: "#e040fb",
          fillOpacity: 0.18,
          dashArray: "6 4",
          className: "hw-tornado-polygon",
        },
        onEachFeature: (feature, layer) => {
          const props = feature.properties || {};
          const popup = `
            <strong>${this._esc(props.headline || "Tornado Warning")}</strong><br/>
            Severity: ${this._esc(props.severity || "—")}<br/>
            Expires: ${this._esc(props.expires || "—")}<br/>
            Area: ${this._esc(props.areaDesc || "—")}
          `;
          layer.bindPopup(popup);
          const center = this._getFeatureCenterLatLng(feature);
          if (center) {
            this._addHazardMarker(center[0], center[1], "tornado", {
              size: 28,
              popup,
              zIndexOffset: 460,
            });
            bounds.push(center);
          }
          try {
            const layerBounds = layer.getBounds?.();
            if (layerBounds?.isValid?.()) {
              bounds.push(layerBounds.getNorthEast(), layerBounds.getSouthWest());
            }
          } catch (_) {
            /* ignore malformed geometry */
          }
        },
      }).addTo(this._layerGroup);
    }

    _earthquakeMarkerStyle(magnitude, tsunami) {
      const mag = Number(magnitude) || 0;
      let color = "#ffb74d";
      let radius = 8;
      if (mag >= 5) {
        color = "#ef5350";
        radius = 14;
      } else if (mag >= 4) {
        color = "#ff7043";
        radius = 11;
      } else if (mag >= 3) {
        color = "#ffa726";
        radius = 9;
      }
      return { color, radius, tsunami: tsunami === 1 };
    }

    _formatEarthquakeTime(timeMs) {
      if (!timeMs) return "—";
      try {
        return new Date(timeMs).toLocaleString();
      } catch (_) {
        return "—";
      }
    }

    _sortEarthquakeFeatures(features) {
      const sort = this._mapSort || "newest";
      const sorted = [...features];
      if (sort === "magnitude") {
        sorted.sort((a, b) => (b.properties?.mag ?? 0) - (a.properties?.mag ?? 0));
      } else if (sort === "distance") {
        sorted.sort((a, b) => {
          const da = a.properties?.distance_miles ?? Number.POSITIVE_INFINITY;
          const db = b.properties?.distance_miles ?? Number.POSITIVE_INFINITY;
          return da - db;
        });
      } else {
        sorted.sort((a, b) => (b.properties?.time ?? 0) - (a.properties?.time ?? 0));
      }
      return sorted;
    }

    _drawEarthquakes(bounds) {
      const L = global.L;
      const geojson = this._earthquakeData?.geojson;
      const targetGroup = this._earthquakeClusterGroup || this._layerGroup;
      if (!L || !geojson?.features?.length || !targetGroup) return;

      const tier = this._getDetailTier();
      const primaryId = this._earthquakeData?.primary_event?.id;
      const features = this._sortEarthquakeFeatures(geojson.features);

      features.forEach((feature) => {
        const props = feature.properties || {};
        const coords = feature.geometry?.coordinates;
        if (!coords || coords.length < 2) return;
        const lon = coords[0];
        const lat = coords[1];
        const style = this._earthquakeMarkerStyle(props.mag, props.tsunami);
        const isPrimary = props.id && props.id === primaryId;
        const isNearby = props.nearby === true || isPrimary;
        const iconSize = Math.round(22 + style.radius * 1.4);
        const iconClasses = [
          isPrimary ? "is-primary" : "",
          style.tsunami ? "is-tsunami" : "",
          isNearby ? "is-nearby" : "",
        ].filter(Boolean).join(" ");

        const popup = `
          <strong>M${props.mag != null ? props.mag : "?"} Earthquake</strong>${props.nearby ? " <em>(live nearby)</em>" : ""}<br/>
          ${this._esc(props.place || "Unknown location")}<br/>
          Depth: ${props.depth_km != null ? Math.round(props.depth_km) + " km" : "—"}<br/>
          Distance: ${props.distance_miles != null ? Math.round(props.distance_miles) + " mi" : "—"}<br/>
          Time: ${this._esc(this._formatEarthquakeTime(props.time))}<br/>
          ${props.tsunami === 1 ? "Tsunami possible<br/>" : ""}
          ${props.url ? `<a href="${this._esc(props.url)}" target="_blank" rel="noopener noreferrer">USGS details</a>` : ""}
        `;

        const marker = L.marker([lat, lon], {
          icon: this._createHazardIcon("earthquake", {
            size: iconSize,
            className: iconClasses,
          }),
          zIndexOffset: isPrimary ? 480 : 380,
        });
        marker.bindPopup(popup);
        targetGroup.addLayer(marker);

        if (style.tsunami && tier >= 2) {
          L.circle([lat, lon], {
            radius: Math.max(25000, style.radius * 8000),
            color: "#03a9f4",
            weight: 2,
            fillColor: "#03a9f4",
            fillOpacity: 0.08,
            dashArray: "6 4",
          }).addTo(this._layerGroup);
        }

      });
    }

    _volcanoLevelColor(level) {
      if (level === "warning") return "#e53935";
      if (level === "watch") return "#fb8c00";
      return "#fdd835";
    }

    _volcanoPopup(props) {
      const rows = [
        `<strong>${this._esc(props.name || "Volcano")}</strong>`,
        this._esc(props.country || ""),
      ];
      if (props.type) rows.push(`Type: ${this._esc(props.type)}`);
      if (props.elevation_m != null) rows.push(`Elevation: ${Math.round(props.elevation_m)} m`);
      if (props.last_eruption_year) rows.push(`Last eruption: ${this._esc(props.last_eruption_year)}`);
      if (props.distance_miles != null) rows.push(`Distance: ${Math.round(props.distance_miles)} mi`);
      if (props.active) {
        const level = String(props.activity_level || "").toUpperCase();
        rows.push(`<span style="color:${this._volcanoLevelColor(props.activity_level)};font-weight:700">Activity: ${this._esc(level)}</span>`);
        if (props.color_code) rows.push(`Aviation color: ${this._esc(props.color_code)}`);
        if (props.synopsis) rows.push(this._esc(String(props.synopsis).slice(0, 220)));
        if (props.url) rows.push(`<a href="${this._esc(props.url)}" target="_blank" rel="noopener noreferrer">Details</a>`);
      }
      return rows.filter(Boolean).join("<br/>");
    }

    _drawVolcanoes() {
      const L = global.L;
      const features = this._volcanoData?.geojson?.features;
      if (!L || !features?.length) return;
      const targetGroup = this._volcanoClusterGroup || this._layerGroup;

      features.forEach((feature) => {
        const props = feature.properties || {};
        const coords = feature.geometry?.coordinates;
        if (!coords || coords.length < 2) return;
        const lon = coords[0];
        const lat = coords[1];
        if (lat == null || lon == null) return;
        const popup = this._volcanoPopup(props);

        if (props.active) {
          const color = this._volcanoLevelColor(props.activity_level);
          const marker = L.marker([lat, lon], {
            icon: L.divIcon({
              className: "hw-hazard-icon-marker",
              html: `<div class="hw-hazard-icon-wrap hw-volcano-active" style="--volcano-color:${color}"><img src="/local/home_weather/icons/volcano.svg" width="30" height="30" alt="" draggable="false"/></div>`,
              iconSize: [30, 30],
              iconAnchor: [15, 15],
            }),
            zIndexOffset: 470,
          });
          marker.bindPopup(popup);
          if (props.name) {
            marker.bindTooltip(this._esc(props.name), {
              permanent: true,
              direction: "top",
              className: "hw-name-label hw-volcano-label",
              offset: [0, -16],
            });
          }
          targetGroup.addLayer(marker);

          const ringMiles = Number(props.ring_radius_miles);
          if (Number.isFinite(ringMiles) && ringMiles > 0) {
            L.circle([lat, lon], {
              radius: ringMiles * 1609.34,
              color,
              weight: 2,
              dashArray: "8 6",
              fillColor: color,
              fillOpacity: 0.18,
            }).bindPopup(popup).addTo(this._layerGroup);
          }
          return;
        }

        const marker = L.marker([lat, lon], {
          icon: L.divIcon({
            className: "hw-hazard-icon-marker",
            html: `<div class="hw-hazard-icon-wrap hw-volcano-catalog"><img src="/local/home_weather/icons/volcano.svg" width="18" height="18" alt="" draggable="false"/></div>`,
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          }),
          zIndexOffset: 120,
        });
        marker.bindPopup(popup);
        targetGroup.addLayer(marker);
      });
    }

    _wildfirePopup(props) {
      const contained = props.percent_contained;
      const containedText = contained == null ? "Unknown" : `${Math.round(contained)}%`;
      return [
        `<strong>${this._esc(props.name || "Wildfire")}</strong>`,
        this._esc(props.location || ""),
        `Size: ${props.acres != null ? Math.round(props.acres).toLocaleString() + " acres" : "—"}`,
        `Contained: ${containedText}`,
        props.fire_cause ? `Cause: ${this._esc(props.fire_cause)}` : "",
        props.discovery_time ? `Discovered: ${this._esc(this._formatEarthquakeTime(props.discovery_time))}` : "",
        props.distance_miles != null ? `Distance: ${Math.round(props.distance_miles)} mi` : "",
        `<span style="font-size:11px;opacity:0.8">Source: NIFC WFIGS</span>`,
      ].filter(Boolean).join("<br/>");
    }

    _drawWildfires(bounds) {
      const L = global.L;
      const features = this._wildfireData?.geojson?.features;
      if (!L || !features?.length || !this._layerGroup) return;

      features.forEach((feature) => {
        const props = feature.properties || {};
        const geom = feature.geometry || {};
        const color = props.color || "#ff7043";
        const popup = this._wildfirePopup(props);

        if (geom.type === "Polygon" && Array.isArray(geom.coordinates)) {
          L.geoJSON(feature, {
            style: {
              color,
              weight: 2,
              fillColor: color,
              fillOpacity: 0.22,
              className: "hw-wildfire-perimeter",
            },
          }).bindPopup(popup).addTo(this._layerGroup);
          try {
            const ring = geom.coordinates[0] || [];
            ring.forEach((pt) => {
              if (Array.isArray(pt) && pt.length >= 2) bounds.push([pt[1], pt[0]]);
            });
          } catch (_) { /* ignore */ }
          return;
        }

        const coords = geom.coordinates;
        if (!coords || coords.length < 2) return;
        const lon = coords[0];
        const lat = coords[1];
        const marker = L.marker([lat, lon], {
          icon: L.divIcon({
            className: "hw-hazard-icon-marker",
            html: `<div class="hw-hazard-icon-wrap"><img src="/local/home_weather/icons/fire.svg" width="26" height="26" alt="" draggable="false"/></div>`,
            iconSize: [26, 26],
            iconAnchor: [13, 13],
          }),
          zIndexOffset: 460,
        });
        marker.bindPopup(popup);
        marker.addTo(this._layerGroup);
        bounds.push([lat, lon]);
      });
    }

    _aqiPopup(props) {
      return [
        `<strong>${this._esc(props.name || "Reporting area")}, ${this._esc(props.state || "")}</strong>`,
        `<span style="display:inline-block;background:${props.color || "#ccc"};color:#111;font-weight:700;padding:2px 8px;border-radius:999px">AQI ${props.aqi} — ${this._esc(props.category || "")}</span>`,
        props.pollutant ? `Primary pollutant: ${this._esc(props.pollutant)}` : "",
        props.pollutants?.length ? `Pollutants tracked: ${this._esc(props.pollutants.join(", "))}` : "",
        props.agency ? `Agency: ${this._esc(props.agency)}` : "",
        props.distance_miles != null ? `Distance: ${Math.round(props.distance_miles)} mi` : "",
        `<span style="font-size:11px;opacity:0.8">Source: EPA AirNow</span>`,
      ].filter(Boolean).join("<br/>");
    }

    _aqiRadiusMeters(level) {
      const n = Number(level) || 1;
      if (n >= 5) return 65000;
      if (n >= 4) return 55000;
      if (n >= 3) return 45000;
      if (n >= 2) return 35000;
      return 28000;
    }

    _aqiFillOpacity(level) {
      const n = Number(level) || 1;
      if (n >= 5) return 0.45;
      if (n >= 4) return 0.38;
      if (n >= 3) return 0.32;
      if (n >= 2) return 0.22;
      return 0.14;
    }

    _drawAirQuality(bounds) {
      const L = global.L;
      const features = this._airQualityData?.geojson?.features;
      if (!L || !features?.length || !this._layerGroup) return;

      const sorted = [...features].sort((a, b) => {
        const levelA = Number(a.properties?.category_level) || 1;
        const levelB = Number(b.properties?.category_level) || 1;
        return levelA - levelB;
      });

      sorted.forEach((feature) => {
        const props = feature.properties || {};
        const coords = feature.geometry?.coordinates;
        if (!coords || coords.length < 2) return;
        const lon = coords[0];
        const lat = coords[1];
        const level = Number(props.category_level) || 1;
        const color = props.color || "#00e400";
        const radius = this._aqiRadiusMeters(level);
        const fillOpacity = this._aqiFillOpacity(level);

        const circle = L.circle([lat, lon], {
          radius,
          color: "transparent",
          weight: 0,
          fillColor: color,
          fillOpacity,
          interactive: true,
          pane: "overlayPane",
        });
        circle.bindPopup(this._aqiPopup(props));
        circle.addTo(this._layerGroup);
      });
    }

    _travelPopup(props) {
      const level = Number(props.level) || 0;
      const color = props.color || "#9e9e9e";
      const summary = this._esc((props.summary_text || "").slice(0, 480));
      const link = props.link
        ? `<p style="margin:8px 0 0"><a href="${this._esc(props.link)}" target="_blank" rel="noopener noreferrer">Full advisory on travel.state.gov</a></p>`
        : "";
      return `
        <div class="hw-travel-popup">
          <strong>${this._esc(props.country || props.name || "Country")}</strong>
          <span class="hw-travel-level" style="background:${color};color:#111">Level ${level}: ${this._esc(props.level_label || props.level_name || "")}</span>
          ${summary ? `<p style="margin:6px 0 0;font-size:12px;line-height:1.45">${summary}${(props.summary_text || "").length > 480 ? "…" : ""}</p>` : ""}
          ${link}
        </div>`;
    }

    _drawTravelAdvisories(bounds) {
      const L = global.L;
      const geojson = this._travelData?.geojson;
      if (!L || !geojson?.features?.length || !this._layerGroup) return;

      L.geoJSON(geojson, {
        style: (feature) => {
          const level = Number(feature?.properties?.level) || 1;
          const color = feature?.properties?.color || "#9e9e9e";
          return {
            color: "rgba(255,255,255,0.35)",
            weight: 1,
            opacity: 0.85,
            fillColor: color,
            fillOpacity: level >= 4 ? 0.55 : level >= 3 ? 0.5 : level >= 2 ? 0.48 : 0.42,
            className: `hw-travel-advisory level-${level}`,
          };
        },
        onEachFeature: (feature, layer) => {
          const props = feature.properties || {};
          layer.bindPopup(this._travelPopup(props));
          try {
            const center = layer.getBounds?.().getCenter?.();
            if (center) bounds.push([center.lat, center.lng]);
          } catch (_) { /* ignore */ }
        },
        pane: "overlayPane",
      }).addTo(this._layerGroup);
    }
  }

  global.HurricaneTracker = HurricaneTracker;
})(typeof window !== "undefined" ? window : globalThis);
