/**
 * Hurricane Tracker - Leaflet map for NOAA/NHC storm data.
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

  class HurricaneTracker {
    constructor(options) {
      this._hass = options.hass;
      this._shadow = options.shadowRoot;
      this._embedded = !!options.embedded;
      this._root = null;
      this._map = null;
      this._layerGroup = null;
      this._homeMarker = null;
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
      this._mapLayers = { hurricane: true, tornado: true, earthquakes: true, lightning: true, volcanoes: true, travel: false, wildfire: false, air_quality: false };
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
      this._showZones = true;
      this._zoneConfig = [];
    }

    _isCompactLayout() {
      const width = this._root?.clientWidth ?? global.innerWidth ?? 1024;
      return width <= 768;
    }

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
      this._syncBottomBarButtons();
      if (this._map && this._layerGroup) this._renderMap();
    }

    setOnLayerToggle(callback) {
      this._onLayerToggle = callback;
    }

    setOnOverlayToggle(callback) {
      this._onOverlayToggle = callback;
    }

    _syncBottomBarButtons() {
      const btns = this._root?.querySelectorAll(".hw-bottom-layer-btn");
      if (!btns) return;
      btns.forEach((btn) => {
        const key = btn.dataset.layer;
        const type = btn.dataset.type;
        if (!key) return;
        
        if (type === "overlay") {
          let active = false;
          if (key === "wind_radii") {
            active = this._showWindRadii;
          } else if (key === "alert_zones") {
            active = this._showZones;
          }
          btn.classList.toggle("is-active", active);
          btn.setAttribute("aria-pressed", active ? "true" : "false");
          return;
        }
        const active = !!this._mapLayers[key];
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-pressed", active ? "true" : "false");
      });
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
      this._injectStyles();
      this._renderShell();
      await this._ensureDeps();
      this._bindControls();
      this._bindLayoutObserver();
      await this.loadData();
      this._refreshTimer = setInterval(() => this.loadData(), REFRESH_MS);
      this._startLightningPoll();
    }

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
      if (this._map) {
        this._map.remove();
        this._map = null;
        this._mapInitialized = false;
        this._earthquakeClusterGroup = null;
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
        statusEl.className = stats.status === "live" ? "is-live" : (stats.status === "error" || stats.status === "disabled") ? "is-danger" : "";
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

    _injectStyles() {
      if (this._shadow.querySelector("#hurricane-tracker-styles")) return;
      const style = document.createElement("style");
      style.id = "hurricane-tracker-styles";
      style.textContent = `
        .hurricane-layout {
          position: relative;
          width: 100%;
          height: 100%;
          min-height: 0;
          flex: 1;
          display: flex;
          flex-direction: column;
          padding: 0;
          margin: 0;
          max-width: none;
          box-sizing: border-box;
          overflow: hidden;
        }
        .hurricane-layout.is-embedded {
          min-height: 0;
          height: 100%;
          flex: 1;
        }
        .hurricane-layout.is-embedded .hurricane-map-wrap {
          position: absolute;
          inset: 0;
          flex: none;
          width: auto;
          height: auto;
          min-height: 0;
          overflow: hidden;
        }
        .hurricane-layout.is-embedded .hurricane-map {
          width: 100%;
          height: 100%;
          min-height: 0;
          border-radius: 0;
          border: none;
        }
        @media (min-width: 769px) {
          .hurricane-layout {
            flex-direction: row;
            align-items: stretch;
          }
          .hurricane-map-wrap {
            position: relative;
            inset: auto;
            flex: 1 1 auto;
            min-width: 0;
            min-height: 0;
            z-index: 1;
            background: #111111;
          }
          .hurricane-layout.is-embedded .hurricane-map-wrap {
            position: relative;
            inset: auto;
            flex: 1 1 auto;
            width: auto;
            height: auto;
          }
          .hurricane-map-wrap > .hurricane-map,
          .hurricane-layout.is-embedded .hurricane-map {
            position: relative;
            width: 100%;
            height: 100%;
            min-width: 0;
            min-height: 0;
            inset: auto;
          }
          .hurricane-status {
            position: relative;
            top: auto;
            right: auto;
            bottom: auto;
            left: auto;
            flex: 0 0 clamp(248px, 28vw, 300px);
            width: clamp(248px, 28vw, 300px);
            max-width: clamp(248px, 28vw, 300px);
            max-height: 100%;
            height: 100%;
            min-height: 0;
            align-self: stretch;
            margin: 0;
            border-radius: 0;
            border-top: none;
            border-right: none;
            border-bottom: none;
            border-left: 1px solid var(--hw-border-strong, #333);
            box-shadow: none;
            z-index: 20;
            background-color: #1c1c1c;
          }
          .hurricane-map-empty-banner {
            top: 12px;
            left: 12px;
            right: 12px;
          }
          .hw-map-controls-stack {
            --hw-map-btn: 36px;
            --hw-map-stack-width: 144px;
          }
          .hw-legend {
            max-width: none;
          }
        }
        .hurricane-status-details {
          border: 1px solid var(--hw-border-strong, #333);
          border-radius: 10px;
          overflow: hidden;
          background-color: #282828;
          flex-shrink: 0;
        }
        .hurricane-status-details + .hurricane-status-details {
          margin-top: 8px;
        }
        .hurricane-status-details summary {
          list-style: none;
          cursor: pointer;
          padding: 10px 12px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--hw-muted, #b0bec5) !important;
          background-color: #282828;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .hurricane-status-details summary .h-count {
          margin-left: auto;
          min-width: 22px;
          padding: 2px 7px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0;
          text-transform: none;
          color: var(--hw-text, #eceff1);
          background: var(--hw-border-strong, #333);
        }
        .hurricane-status-details summary .h-chevron {
          font-size: 12px;
          color: #78909c;
          transition: transform 0.15s ease;
          flex-shrink: 0;
        }
        .hurricane-status-details summary::-webkit-details-marker { display: none; }
        .hurricane-status-details[open] summary .h-chevron {
          transform: rotate(90deg);
        }
        .hurricane-status-details[open] summary {
          border-bottom: 1px solid var(--hw-border-strong, #333);
        }
        .hurricane-status-details-body {
          padding: 8px 12px 10px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          background-color: #1e1e1e;
        }
        .marker-cluster-hw {
          background: rgba(255, 183, 77, 0.25);
          border: 2px solid rgba(255, 255, 255, 0.85);
          border-radius: 50%;
          color: #fff;
          font-weight: 700;
          font-size: 12px;
        }
        .marker-cluster-hw div {
          background: rgba(239, 83, 80, 0.88);
          border-radius: 50%;
          width: 30px;
          height: 30px;
          margin-left: 5px;
          margin-top: 5px;
          text-align: center;
          line-height: 30px;
        }
        .hurricane-status-headline {
          margin: 0;
          font-size: 14px;
          font-weight: 600;
          line-height: 1.45;
          color: var(--hw-text, #e1e1e1) !important;
        }
        .hurricane-status-headline.is-watch { color: #ffb74d; }
        .hurricane-status-headline.is-danger { color: #ef5350; }
        .hurricane-status-section {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding-top: 4px;
          border-top: 1px solid var(--hw-border-strong, #333);
        }
        .hurricane-status-section:first-of-type {
          border-top: none;
          padding-top: 0;
        }
        .hurricane-status-section h4 {
          margin: 0;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: #9b9b9b;
        }
        .hurricane-map-wrap {
          position: absolute;
          inset: 0;
          overflow: hidden;
          z-index: 1;
        }
        .hurricane-map {
          position: relative;
          z-index: 1;
          width: 100%;
          height: calc(100% - 48px);
          min-height: 0;
          border-radius: 0;
          overflow: hidden;
          border: none;
          background: #111111;
          isolation: isolate;
        }
        @media (max-width: 768px) {
          .hurricane-map {
            height: calc(100% - 44px);
          }
        }
        .hurricane-map-empty-banner { display: none; }
        .hurricane-status {
          position: absolute;
          top: 0;
          right: 0;
          bottom: 0;
          left: auto;
          width: min(320px, 100%);
          height: 100%;
          max-height: 100%;
          min-height: 0;
          overflow: hidden;
          overflow-x: hidden;
          z-index: 1100;
          pointer-events: auto;
          --primary-text-color: var(--hw-text, #e1e1e1);
          --secondary-text-color: var(--hw-muted, #9b9b9b);
          --card-background-color: #1c1c1c;
          color: var(--hw-text, #e1e1e1);
          background-color: #1c1c1c;
          border: none;
          border-left: 1px solid var(--hw-border-strong, #333);
          border-radius: 0;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 0;
          box-shadow: -4px 0 24px rgba(0, 0, 0, 0.45);
          isolation: isolate;
        }
        .hurricane-status,
        .hurricane-status * {
          -webkit-font-smoothing: antialiased;
        }
        .hurricane-status span,
        .hurricane-status summary,
        .hurricane-status h3,
        .hurricane-status p {
          color: inherit;
        }
        .hurricane-status a {
          color: #90caf9;
        }
        .hurricane-status a:visited {
          color: #90caf9;
        }
        .hurricane-status-header {
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          gap: 10px;
          padding-bottom: 12px;
          margin-bottom: 12px;
          border-bottom: 1px solid var(--hw-border-strong, #333);
          background-color: #1c1c1c;
        }
        .hurricane-status-scroll {
          flex: 1 1 auto;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
          -webkit-overflow-scrolling: touch;
          display: block;
          padding-right: 4px;
          padding-bottom: max(16px, env(safe-area-inset-bottom, 0px));
          background-color: #1c1c1c;
          scrollbar-width: thin;
          scrollbar-color: #444 #1c1c1c;
          -ms-overflow-style: auto;
        }
        .hurricane-status-scroll > .hurricane-stat,
        .hurricane-status-scroll > .hurricane-banner {
          flex-shrink: 0;
        }
        .hurricane-status-scroll > .hurricane-stat + .hurricane-status-details,
        .hurricane-status-scroll > .hurricane-banner + .hurricane-status-details {
          margin-top: 8px;
        }
        .hurricane-status-scroll::-webkit-scrollbar {
          width: 6px;
        }
        .hurricane-status-scroll::-webkit-scrollbar-thumb {
          background: #444;
          border-radius: 3px;
        }
        .hurricane-status-scroll::-webkit-scrollbar-track {
          background: #1c1c1c;
        }
        .hurricane-status.is-threat-high {
          border-color: #f44336;
          box-shadow: none;
        }
        .hurricane-status.is-threat-watch {
          border-color: #ff9800;
        }
        .hurricane-status h3 {
          margin: 0;
          font-size: 16px;
          font-weight: 600;
          color: var(--hw-text, #e1e1e1) !important;
        }
        .hurricane-stat {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          gap: 12px;
          font-size: 13px;
          line-height: 1.45;
          color: var(--hw-muted, #9b9b9b) !important;
          flex-shrink: 0;
        }
        .hurricane-stat > span {
          flex: 1 1 auto;
          min-width: 0;
        }
        .hurricane-stat strong {
          color: var(--hw-text, #e1e1e1) !important;
          font-weight: 600;
          text-align: right;
          flex: 0 1 auto;
          min-width: 0;
          overflow-wrap: anywhere;
        }
        .hurricane-stat.is-warning strong { color: #ff9800; }
        .hurricane-stat.is-danger strong { color: #f44336; }
        .hurricane-banner {
          padding: 10px 12px;
          border-radius: 8px;
          font-size: 12px;
          background: rgba(255,152,0,0.15);
          color: #ffb74d;
          border: 1px solid rgba(255,152,0,0.35);
        }
        .hurricane-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
          padding: 48px 16px;
          color: #9b9b9b;
          text-align: center;
        }
        .hurricane-toggle {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          color: #9b9b9b;
          cursor: pointer;
        }
        .hurricane-toggle input { accent-color: #03a9f4; }
        .hurricane-loading {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: #9b9b9b;
          text-align: center;
        }
        .leaflet-container {
          font-family: inherit;
          background: #111111;
        }
        .leaflet-control-zoom a {
          background: var(--hw-surface, #1c1c1c);
          color: var(--hw-text, #e1e1e1);
          border-color: var(--hw-border-strong, #333);
        }
        .leaflet-control-zoom a:hover {
          background: var(--hw-elevated, #282828);
          color: var(--hw-text, #fff);
        }
        /* Unified top-left map controls stack: toolbar row + legend */
        .hw-map-controls-stack {
          --hw-map-btn: 42px;
          --hw-map-stack-width: 168px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          width: var(--hw-map-stack-width);
          background: transparent;
          border: none;
          box-shadow: none;
        }
        .hw-map-toolbar {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          width: 100%;
          background: var(--hw-surface, #1c1c1c);
          border: 1px solid var(--hw-border-strong, #333);
          border-radius: 8px;
          overflow: visible;
          box-shadow: 0 4px 16px rgba(0,0,0,0.35);
        }
        .hw-map-tool-cell {
          position: relative;
          display: flex;
          align-items: stretch;
          min-width: 0;
          min-height: var(--hw-map-btn);
        }
        .hw-map-tool-cell + .hw-map-tool-cell {
          border-left: 1px solid var(--hw-border-strong, #333);
        }
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
          background: var(--hw-surface, #1c1c1c);
          color: var(--hw-text, #e1e1e1);
          font-size: 18px;
          font-weight: 600;
          line-height: 1;
          cursor: pointer;
          box-sizing: border-box;
          font-family: inherit;
        }
        .hw-map-tool-btn:hover {
          background: var(--hw-elevated, #282828);
          color: var(--hw-text, #fff);
        }
        .hw-map-tool-btn:focus-visible {
          outline: 2px solid var(--hw-accent-hover, #29b6f6);
          outline-offset: -2px;
          z-index: 1;
        }
        .hw-map-tool-btn.active {
          background: var(--hw-accent, #0288d1);
          color: #fff;
        }
        .hw-basemap-cell { z-index: 2; }
        .hw-basemap-menu {
          position: absolute;
          top: calc(100% + 6px);
          left: 0;
          z-index: 30;
          min-width: 148px;
          padding: 4px;
          background: var(--hw-surface, rgba(17, 20, 28, 0.96));
          border: 1px solid var(--hw-border-strong, rgba(255,255,255,0.14));
          border-radius: 8px;
          box-shadow: 0 6px 22px rgba(0,0,0,0.45);
          backdrop-filter: blur(10px);
        }
        .hw-basemap-menu[hidden] { display: none; }
        .hw-basemap-option {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          padding: 8px 10px;
          border: none;
          border-radius: 6px;
          background: transparent;
          color: var(--hw-text, #cfd8dc);
          font-size: 12px;
          font-family: inherit;
          text-align: left;
          cursor: pointer;
        }
        .hw-basemap-option:hover {
          background: var(--hw-hover, #222);
          color: var(--hw-text, #fff);
        }
        .hw-basemap-check {
          width: 14px;
          flex-shrink: 0;
          color: var(--hw-accent-hover, #29b6f6);
          font-size: 11px;
          font-weight: 700;
        }
        .hw-map-controls-stack .hw-measure-readout-row {
          display: none;
          width: 100%;
          box-sizing: border-box;
          padding: 4px 8px;
          font-size: 10px;
          font-weight: 600;
          color: var(--hw-text, #cfd8dc);
          background: var(--hw-surface, #1c1c1c);
          border: 1px solid var(--hw-border-strong, #333);
          border-radius: 8px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          font-variant-numeric: tabular-nums;
        }
        .hw-map-controls-stack.measure-active .hw-measure-readout-row {
          display: block;
        }
        .leaflet-bar {
          border: 1px solid var(--hw-border-strong, #333);
          box-shadow: 0 4px 16px rgba(0,0,0,0.35);
        }
        .leaflet-control-attribution {
          position: absolute !important;
          bottom: 2px !important;
          right: 4px !important;
          left: auto !important;
          background: transparent !important;
          color: rgba(158, 158, 158, 0.7) !important;
          font-size: 10px !important;
          padding: 0 4px !important;
          text-shadow: 0 1px 2px rgba(0,0,0,0.8);
        }
        .leaflet-control-attribution a { 
          color: rgba(144, 202, 249, 0.8) !important;
        }
        .leaflet-control-attribution a:hover {
          color: #90caf9 !important;
        }
        .hw-forecast-label {
          background: #141820;
          color: #fff;
          border: 1px solid #333;
          border-radius: 6px;
          padding: 3px 8px;
          font-size: 11px;
          font-weight: 600;
          box-shadow: 0 4px 12px rgba(0,0,0,0.35);
        }
        .leaflet-tooltip.hw-name-label {
          background: var(--hw-surface, #1c1c1c);
          color: var(--hw-text, #ffffff);
          border: 1px solid var(--hw-border-strong, #333);
          border-radius: 7px;
          padding: 2px 9px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.2px;
          white-space: nowrap;
          box-shadow: 0 4px 14px rgba(0,0,0,0.4);
        }
        .leaflet-tooltip.hw-name-label::before { display: none; }
        .hw-storm-label { border-left: 3px solid var(--hw-accent, #03a9f4); }
        /* Single-line zone label that follows the curve of the zone circle. */
        .hw-zone-arc-label {
          fill: #e3f2fd;
          font-family: inherit;
          font-weight: 700;
          letter-spacing: 0.4px;
          text-transform: uppercase;
          paint-order: stroke;
          stroke: rgba(6, 10, 18, 0.9);
          stroke-width: 3.5px;
          stroke-linejoin: round;
          stroke-linecap: round;
          pointer-events: none;
          -webkit-user-select: none;
          user-select: none;
        }
        .hw-zone-arc-label.is-bypassed { fill: #ffcc80; }
        .hw-volcano-label { border-left: 3px solid #fb8c00; }
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
        .hw-wildfire-perimeter {
          stroke-width: 2;
        }
        .hw-hazard-icon-marker {
          background: transparent;
          border: none;
        }
        .hw-hazard-icon-wrap {
          display: flex;
          align-items: center;
          justify-content: center;
          filter: drop-shadow(0 2px 8px rgba(0,0,0,0.5));
        }
        .hw-hazard-icon-wrap img {
          display: block;
          pointer-events: none;
        }
        .hw-hazard-icon-wrap.is-primary {
          filter: drop-shadow(0 0 8px rgba(255,255,255,0.55)) drop-shadow(0 2px 8px rgba(0,0,0,0.5));
        }
        .hw-hazard-icon-wrap.is-tsunami {
          filter: drop-shadow(0 0 10px rgba(3,169,244,0.85)) drop-shadow(0 2px 8px rgba(0,0,0,0.5));
        }
        .hw-hazard-icon-wrap.is-nearby {
          filter: drop-shadow(0 0 10px rgba(255,193,7,0.75)) drop-shadow(0 2px 8px rgba(0,0,0,0.5));
        }
        .hw-storm-icon-wrap {
          display: flex;
          align-items: center;
          justify-content: center;
          filter: drop-shadow(0 2px 8px rgba(0,0,0,0.5));
        }
        .hw-storm-icon-wrap.is-primary {
          filter: drop-shadow(0 0 10px var(--storm-color, #e53935)) drop-shadow(0 2px 8px rgba(0,0,0,0.5));
        }
        .hw-storm-icon {
          filter: none;
          position: relative;
          z-index: 1;
        }
        .hw-cat-ring {
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          border-radius: 50%;
          border: 2px solid #5ebaff;
          box-sizing: border-box;
          pointer-events: none;
          opacity: 0.95;
        }
        .hw-hazard-icon-wrap.hw-lightning-marker.is-fresh {
          filter: drop-shadow(0 0 12px rgba(255, 193, 7, 0.95)) drop-shadow(0 2px 8px rgba(0,0,0,0.5));
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
        /* Volcano markers: catalog points blend into the basemap */
        .hw-hazard-icon-wrap.hw-volcano-catalog {
          opacity: 0.45;
          filter: grayscale(0.55) drop-shadow(0 1px 3px rgba(0,0,0,0.45));
        }
        .hw-hazard-icon-wrap.hw-volcano-catalog:hover {
          opacity: 0.9;
          filter: grayscale(0) drop-shadow(0 2px 6px rgba(0,0,0,0.5));
        }
        /* Active volcanoes pulse with their alert color */
        .hw-hazard-icon-wrap.hw-volcano-active {
          animation: hw-volcano-pulse 1.6s ease-in-out infinite;
        }
        @keyframes hw-volcano-pulse {
          0%, 100% {
            transform: scale(1);
            filter: drop-shadow(0 0 4px var(--volcano-color, #fb8c00)) drop-shadow(0 2px 8px rgba(0,0,0,0.5));
          }
          50% {
            transform: scale(1.18);
            filter: drop-shadow(0 0 14px var(--volcano-color, #fb8c00)) drop-shadow(0 2px 8px rgba(0,0,0,0.5));
          }
        }
        .marker-cluster-hw-volcano {
          background: rgba(120, 124, 134, 0.35);
          border: 1px solid rgba(255,255,255,0.25);
          border-radius: 50%;
          color: #e6e9ef;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
          font-weight: 600;
          box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        }
        .marker-cluster-hw-volcano div {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 100%;
          height: 100%;
        }
        .hurricane-stat strong.is-live { color: #ffc107; }
        /* Leaflet popup styling for dark theme */
        .leaflet-popup-content-wrapper {
          background: #1a1f2a;
          color: #e1e1e1;
          border-radius: 10px;
          box-shadow: 0 6px 24px rgba(0,0,0,0.5);
          border: 1px solid rgba(255,255,255,0.1);
        }
        .leaflet-popup-content {
          margin: 12px 14px;
          font-size: 13px;
          line-height: 1.5;
        }
        .leaflet-popup-tip {
          background: #1a1f2a;
          border: 1px solid rgba(255,255,255,0.1);
          box-shadow: 0 3px 10px rgba(0,0,0,0.3);
        }
        .leaflet-popup-close-button {
          color: #9e9e9e !important;
          font-size: 20px !important;
          padding: 6px 8px 0 0 !important;
        }
        .leaflet-popup-close-button:hover {
          color: #fff !important;
        }
        .hw-legend {
          background: rgba(17, 20, 28, 0.92);
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 8px;
          color: #cfd8dc;
          overflow: hidden;
          width: 100%;
          max-width: none;
          box-sizing: border-box;
          backdrop-filter: blur(10px);
          box-shadow: 0 4px 16px rgba(0,0,0,0.35);
        }
        .hw-map-controls-stack .hw-legend {
          margin: 0;
        }
        .hw-legend-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 7px 10px;
          cursor: pointer;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: #b0bec5;
          user-select: none;
        }
        .hw-legend-caret { transition: transform 0.15s ease; }
        .hw-legend.collapsed .hw-legend-caret { transform: rotate(-90deg); }
        .hw-legend.collapsed .hw-legend-body { display: none; }
        .hw-legend-body {
          padding: 4px 10px 10px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .hw-legend-group { display: flex; flex-direction: column; gap: 4px; }
        .hw-legend-group-title {
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #78909c;
        }
        .hw-legend-row { display: flex; align-items: center; gap: 6px; font-size: 10px; line-height: 1.25; }
        .hw-legend-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
        .hw-legend-swatch { width: 12px; height: 12px; border-radius: 3px; flex-shrink: 0; border: 1px solid rgba(255,255,255,0.3); }
        .hw-legend img { width: 14px; height: 14px; flex-shrink: 0; }
        .leaflet-container.hw-measuring { cursor: crosshair; }
        .hw-measure-tip {
          background: rgba(2, 136, 209, 0.92);
          color: #fff;
          border: none;
          border-radius: 6px;
          font-size: 11px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        }
        .hw-measure-tip::before { display: none; }
        .leaflet-control-layers {
          background: rgba(17, 20, 28, 0.92);
          color: #cfd8dc;
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 8px;
          backdrop-filter: blur(10px);
        }
        .leaflet-control-layers-toggle {
          background-color: rgba(28, 28, 28, 0.92);
        }
        .leaflet-control-layers-expanded { padding: 8px 10px; }
        .leaflet-control-layers label { font-size: 12px; margin: 2px 0; }
        .hw-home-marker.in-cone {
          filter: drop-shadow(0 0 6px rgba(244,67,54,0.9));
          animation: hw-pulse 1.5s ease-in-out infinite;
        }
        @keyframes hw-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.08); } }
        .hurricane-status-toggle {
          display: none;
          margin-left: auto;
          width: 32px;
          height: 32px;
          padding: 0;
          border: 1px solid var(--hw-border-strong, #333);
          border-radius: 8px;
          background: var(--hw-elevated, #282828);
          color: #b0bec5;
          cursor: pointer;
          flex-shrink: 0;
          line-height: 1;
          font-size: 14px;
        }
        .hurricane-status-toggle:hover { background: var(--hw-hover, #222); color: #eceff1; }
        .hurricane-status h3.hurricane-status-head {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        /* Bottom toolbar */
        .hw-bottom-bar {
          position: absolute;
          bottom: 0;
          left: 0;
          right: min(320px, 100%);
          height: 48px;
          background: var(--hw-surface, #1c1c1c);
          border-top: 1px solid var(--hw-border-strong, #333);
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 16px;
          z-index: 1050;
          gap: 12px;
        }
        @media (min-width: 769px) {
          .hw-bottom-bar {
            right: clamp(248px, 28vw, 300px);
          }
        }
        .hw-bottom-layers {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .hw-bottom-layer-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
          border: none;
          border-radius: 8px;
          background: transparent;
          cursor: pointer;
          transition: background 0.15s, opacity 0.15s;
          opacity: 0.45;
          padding: 0;
        }
        .hw-bottom-layer-btn:hover {
          background: var(--hw-hover, #222);
          opacity: 0.75;
        }
        .hw-bottom-layer-btn.is-active {
          background: var(--hw-elevated, #282828);
          opacity: 1;
        }
        .hw-bottom-layer-btn img,
        .hw-bottom-layer-btn svg {
          width: 22px;
          height: 22px;
          display: block;
        }
        .hw-bottom-coords {
          display: flex;
          align-items: center;
          gap: 12px;
          font-size: 11px;
          color: #b0b0b0;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
          padding-left: 12px;
          border-left: 1px solid rgba(255,255,255,0.1);
          height: 28px;
        }
        .hw-bottom-coords .hw-scale-wrap {
          display: flex;
          align-items: center;
          gap: 6px;
          color: #8a8a8a;
        }
        .hw-bottom-coords .hw-scale-line {
          display: inline-block;
          height: 4px;
          border-left: 1px solid #8a8a8a;
          border-right: 1px solid #8a8a8a;
          border-bottom: 1px solid #8a8a8a;
          min-width: 40px;
        }
        @media (max-width: 768px) {
          .hw-bottom-bar {
            right: 0;
            height: 44px;
            padding: 0 10px;
            gap: 8px;
          }
          .hw-bottom-layers {
            gap: 2px;
          }
          .hw-bottom-layer-btn {
            width: 32px;
            height: 32px;
          }
          .hw-bottom-layer-btn img,
          .hw-bottom-layer-btn svg {
            width: 18px;
            height: 18px;
          }
          .hw-bottom-coords {
            font-size: 10px;
            gap: 6px;
          }
          .hw-bottom-coords .hw-scale-wrap {
            display: none;
          }
          .hurricane-status {
            top: 0;
            left: auto;
            right: 0;
            bottom: 0;
            width: min(300px, 88%);
            height: 100%;
            max-height: 100%;
            padding: 14px;
            border-radius: 0;
            border-left: 1px solid var(--hw-border-strong, #333);
            transition: width 0.2s ease, padding 0.2s ease;
          }
          .hurricane-status.is-collapsed {
            height: auto;
            bottom: auto;
            max-height: none;
            width: min(300px, 88%);
            overflow: hidden;
            padding-bottom: 14px;
            border-bottom: 1px solid var(--hw-border-strong, #333);
          }
          .hurricane-status.is-collapsed .hurricane-status-header {
            padding-bottom: 0;
            margin-bottom: 0;
            border-bottom: none;
          }
          .hurricane-status.is-collapsed .hurricane-status-scroll {
            display: none;
          }
          .hurricane-status.is-collapsed .hurricane-banner,
          .hurricane-status.is-collapsed .hurricane-stat,
          .hurricane-status.is-collapsed .hurricane-status-details {
            display: none;
          }
          .hurricane-status.is-collapsed .hurricane-status-headline {
            margin: 0;
            font-size: 13px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          .hurricane-status-toggle { display: inline-flex; align-items: center; justify-content: center; }
          .hurricane-status.is-collapsed .hurricane-status-toggle { transform: rotate(-90deg); }
          .hurricane-map-empty-banner {
            top: 10px;
            left: 12px;
            right: 12px;
          }
          .hurricane-layout.is-embedded .hurricane-status {
            top: 0;
            left: auto;
            right: 0;
            bottom: 0;
            width: min(300px, 88%);
            height: 100%;
            max-height: 100%;
          }
          .hurricane-layout.is-embedded .hurricane-status.is-collapsed {
            height: auto;
            bottom: auto;
            max-height: none;
          }
          .hurricane-layout.is-embedded .hurricane-map-empty-banner {
            top: 10px;
            left: 10px;
            right: 10px;
          }
          .hw-map-controls-stack {
            --hw-map-btn: 36px;
            --hw-map-stack-width: 144px;
          }
          .hw-legend {
            max-width: none;
          }
          .leaflet-top.leaflet-left {
            top: 8px;
            left: 8px;
          }
        }
      `;
      this._shadow.appendChild(style);
    }

    _renderShell() {
      if (!this._root) return;
      this._root.innerHTML = `<div class="hurricane-loading">Loading hazard map…</div>`;
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
      await this._loadScript(
        "https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js",
        "L"
      );
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
      /* Map controls live in weather-panel toolbar when embedded. */
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
        <section class="hurricane-layout">
          <div class="hurricane-empty" style="width:100%;height:100%">
            <p>Failed to load hazard data.</p>
            <p>${this._esc(this._error)}</p>
            <button class="btn btn-primary" data-hurricane-refresh>Retry</button>
          </div>
        </section>`;
    }

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

    _buildStatusPanelHtml() {
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
      const insideClass = insideCone ? "is-danger" : "";
      const insideText = insideCone ? "Yes" : "No";

      const tornado = this._tornadoData || {};
      const tornadoCount = tornado.active_count || 0;
      const tornadoAffecting = tornado.affecting_home ? "Yes" : "No";
      const tornadoDistance = this._fmtMiles(tornado.nearest_distance_miles);
      const tornadoHeadline = tornado.primary_alert?.headline || "—";

      const earthquake = this._earthquakeData || {};
      const eqPrimary = earthquake.primary_event || {};
      const eqCount = earthquake.active_count || 0;
      const eqMapCount = earthquake.map_count ?? eqCount;
      const eqDistance = this._fmtMiles(earthquake.nearest_distance_miles);
      const eqMag = eqPrimary.magnitude != null ? `M${eqPrimary.magnitude}` : "—";
      const eqDepth = eqPrimary.depth_km != null ? `${Math.round(eqPrimary.depth_km)} km` : "—";
      const eqPlace = eqPrimary.place || "—";
      const eqTsunami = eqPrimary.tsunami === 1 ? "Yes" : "No";

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
      const aqiCounts = airQuality.level_counts || {};
      const aqiTotal = airQuality.area_count || 0;
      const aqiUnhealthy = airQuality.unhealthy_count || 0;
      const aqiWorst = airQuality.worst_area || {};
      const aqiNearestBad = airQuality.nearest_unhealthy || {};

      const headline = this._buildStatusHeadline(summary, storms);
      const tropicalCount = (summary.disturbanceCount || 0) + storms.length;
      const tornadoCountLabel = tornadoCount;
      const eqCountLabel = eqMapCount;
      const lightningStats = this._getLightningStats();
      const compact = this._isCompactLayout();
      const detailsOpen = compact ? "" : " open";
      const collapsedClass = compact && this._statusCollapsed ? " is-collapsed" : "";
      const statusExpanded = compact && !this._statusCollapsed;

      const tropicalBody = `
            ${summary.hasOutlookActivity ? `
            <div class="hurricane-stat"><span>Disturbances</span><strong>${summary.disturbanceCount || 0}</strong></div>
            <div class="hurricane-stat"><span>Development areas</span><strong>${summary.developmentAreaCount || 0}</strong></div>
            <div class="hurricane-stat ${summary.insideDevelopmentRegion ? "is-warning" : ""}"><span>Inside dev. region</span><strong>${summary.insideDevelopmentRegion ? "Yes" : "No"}</strong></div>
            <div class="hurricane-stat"><span>Nearest disturbance</span><strong>${this._fmtMiles(summary.nearestDisturbanceMiles)}</strong></div>
            <div class="hurricane-stat"><span>Formation probability</span><strong>${summary.highestFormationProbability != null ? summary.highestFormationProbability + "%" : "—"}</strong></div>` : ""}
            ${storms.length > 0 ? `
            <div class="hurricane-stat"><span>Active storms</span><strong>${storms.length}</strong></div>
            <div class="hurricane-stat"><span>Closest storm</span><strong>${this._esc(summary.closestStormName || "—")}</strong></div>
            <div class="hurricane-stat"><span>Distance to center</span><strong>${this._fmtMiles(summary.distanceToCenterMiles)}</strong></div>
            <div class="hurricane-stat"><span>Nearest forecast point</span><strong>${this._fmtMiles(summary.distanceToNearestForecastMiles)}</strong></div>
            <div class="hurricane-stat ${insideClass}"><span>Home inside cone</span><strong>${insideText}</strong></div>
            <div class="hurricane-stat"><span>Closest approach</span><strong>${summary.estimatedClosestApproachHour != null ? summary.estimatedClosestApproachHour + "H" : "—"}</strong></div>` : ""}
            ${!summary.hasOutlookActivity && storms.length === 0 ? `<div class="hurricane-stat"><span>Status</span><strong>No active storms</strong></div>` : ""}`;

      return `
        <aside class="hurricane-status ${threatClass}${collapsedClass}" data-status-expanded="${statusExpanded ? "true" : "false"}">
          <div class="hurricane-status-header">
            <h3 class="hurricane-status-head">
              Hazard Status
              <button type="button" class="hurricane-status-toggle" aria-expanded="${statusExpanded ? "true" : "false"}" aria-label="${statusExpanded ? "Collapse hazard status" : "Expand hazard status"}">▾</button>
            </h3>
            <p class="hurricane-status-headline ${headline.className}">${this._esc(headline.text)}</p>
          </div>
          <div class="hurricane-status-scroll">
            ${staleBanner}
            <div class="hurricane-stat"><span>Overall hurricane threat</span><strong>${this._esc(summary.threatLevel || "none")}</strong></div>
            <details class="hurricane-status-details"${detailsOpen}>
              <summary><span>Hurricanes</span><span class="h-count">${tropicalCount}</span><span class="h-chevron">▸</span></summary>
              <div class="hurricane-status-details-body">${tropicalBody}</div>
            </details>
            <details class="hurricane-status-details"${detailsOpen}>
              <summary><span>Tornado Warnings</span><span class="h-count">${tornadoCountLabel}</span><span class="h-chevron">▸</span></summary>
              <div class="hurricane-status-details-body">
                <div class="hurricane-stat"><span>Active warnings</span><strong>${tornadoCount}</strong></div>
                <div class="hurricane-stat ${tornado.affecting_home ? "is-danger" : ""}"><span>Affecting home</span><strong>${tornadoAffecting}</strong></div>
                <div class="hurricane-stat"><span>Nearest warning</span><strong>${tornadoDistance}</strong></div>
                <div class="hurricane-stat"><span>Primary alert</span><strong>${this._esc(tornadoHeadline)}</strong></div>
              </div>
            </details>
            <details class="hurricane-status-details"${detailsOpen}>
              <summary><span>Earthquakes</span><span class="h-count">${eqCountLabel}</span><span class="h-chevron">▸</span></summary>
              <div class="hurricane-status-details-body">
                <div class="hurricane-stat"><span>Worldwide on map</span><strong>${eqMapCount}</strong></div>
                <div class="hurricane-stat"><span>Nearby (live feed)</span><strong>${eqCount}</strong></div>
                <div class="hurricane-stat ${earthquake.nearby_active ? "is-warning" : ""}"><span>Nearest</span><strong>${this._esc(eqPlace)}</strong></div>
                <div class="hurricane-stat"><span>Magnitude</span><strong>${eqMag}</strong></div>
                <div class="hurricane-stat"><span>Distance</span><strong>${eqDistance}</strong></div>
                <div class="hurricane-stat"><span>Depth</span><strong>${eqDepth}</strong></div>
                <div class="hurricane-stat ${eqPrimary.tsunami === 1 ? "is-danger" : ""}"><span>Tsunami flag</span><strong>${eqTsunami}</strong></div>
              </div>
            </details>
            <details class="hurricane-status-details"${detailsOpen}>
              <summary><span>Volcanoes</span><span class="h-count">${volcanoActiveCount}</span><span class="h-chevron">▸</span></summary>
              <div class="hurricane-status-details-body">
                <div class="hurricane-stat"><span>Active worldwide</span><strong>${volcanoActiveCount}</strong></div>
                <div class="hurricane-stat ${volcano.in_geofield ? "is-warning" : ""}"><span>Active in your zone</span><strong>${volcanoZoneCount}</strong></div>
                <div class="hurricane-stat"><span>Nearest active</span><strong>${this._esc(volcanoNearestName)}</strong></div>
                <div class="hurricane-stat"><span>Alert level</span><strong>${this._esc(volcanoNearestLevel)}</strong></div>
                <div class="hurricane-stat"><span>Distance</span><strong>${volcanoDistance}</strong></div>
              </div>
            </details>
            <details class="hurricane-status-details"${detailsOpen}>
              <summary><span>Travel Advisories</span><span class="h-count">${travelTotal}</span><span class="h-chevron">▸</span></summary>
              <div class="hurricane-status-details-body">
                <div class="hurricane-stat"><span>Countries tracked</span><strong>${travelTotal}</strong></div>
                <div class="hurricane-stat ${travelHigh > 0 ? "is-warning" : ""}"><span>Level 3–4</span><strong>${travelHigh}</strong></div>
                <div class="hurricane-stat"><span>Level 4 (Do not travel)</span><strong>${travelCounts[4] || 0}</strong></div>
                <div class="hurricane-stat"><span>Level 3 (Reconsider)</span><strong>${travelCounts[3] || 0}</strong></div>
                <div class="hurricane-stat"><span>On map</span><strong>${travel.map_count || 0}</strong></div>
                <div class="hurricane-stat"><span>Source</span><strong><a href="https://travel.state.gov/content/travel/en/rss.html" target="_blank" rel="noopener noreferrer" style="color:#90caf9">State Dept</a></strong></div>
              </div>
            </details>
            <details class="hurricane-status-details"${detailsOpen}>
              <summary><span>Wildfires</span><span class="h-count">${wildfireCount}</span><span class="h-chevron">▸</span></summary>
              <div class="hurricane-status-details-body">
                <div class="hurricane-stat"><span>Active incidents</span><strong>${wildfireCount}</strong></div>
                <div class="hurricane-stat ${wildfireActive > 0 ? "is-warning" : ""}"><span>Uncontained</span><strong>${wildfireActive}</strong></div>
                <div class="hurricane-stat"><span>Perimeters on map</span><strong>${wildfire.perimeter_count || 0}</strong></div>
                <div class="hurricane-stat"><span>Nearest</span><strong>${this._esc(wildfireNearest.name || "—")}</strong></div>
                <div class="hurricane-stat"><span>Distance</span><strong>${wildfireDistance}</strong></div>
                <div class="hurricane-stat"><span>Source</span><strong><a href="https://data-nifc.opendata.arcgis.com/" target="_blank" rel="noopener noreferrer" style="color:#90caf9">NIFC WFIGS</a></strong></div>
              </div>
            </details>
            <details class="hurricane-status-details"${detailsOpen}>
              <summary><span>Air Quality</span><span class="h-count">${aqiTotal}</span><span class="h-chevron">▸</span></summary>
              <div class="hurricane-status-details-body">
                <div class="hurricane-stat"><span>Reporting areas</span><strong>${aqiTotal}</strong></div>
                <div class="hurricane-stat ${aqiUnhealthy > 0 ? "is-warning" : ""}"><span>Unhealthy+</span><strong>${aqiUnhealthy}</strong></div>
                <div class="hurricane-stat"><span>Worst AQI</span><strong>${aqiWorst.aqi != null ? aqiWorst.aqi : "—"}</strong></div>
                <div class="hurricane-stat"><span>Worst location</span><strong>${this._esc(aqiWorst.name ? `${aqiWorst.name}, ${aqiWorst.state || ""}` : "—")}</strong></div>
                <div class="hurricane-stat"><span>Nearest unhealthy</span><strong>${this._esc(aqiNearestBad.name ? `${aqiNearestBad.name}, ${aqiNearestBad.state || ""}` : "—")}</strong></div>
                <div class="hurricane-stat"><span>On map</span><strong>${airQuality.map_count || 0}</strong></div>
                <div class="hurricane-stat"><span>Source</span><strong><a href="https://www.airnow.gov/" target="_blank" rel="noopener noreferrer" style="color:#90caf9">EPA AirNow</a></strong></div>
              </div>
            </details>
            <details class="hurricane-status-details"${detailsOpen}>
              <summary><span>Lightning</span><span class="h-count" id="hw-lightning-badge">${lightningStats.visibleCount}</span><span class="h-chevron">▸</span></summary>
              <div class="hurricane-status-details-body">
                <div class="hurricane-stat"><span>Strikes (last hour)</span><strong id="hw-lightning-count">${lightningStats.hourCount}</strong></div>
                <div class="hurricane-stat"><span>Nearest strike</span><strong id="hw-lightning-nearest">${lightningStats.nearestMiles != null ? this._fmtMiles(lightningStats.nearestMiles) : "—"}</strong></div>
                <div class="hurricane-stat"><span>Feed status</span><strong id="hw-lightning-status" class="${lightningStats.status === "live" ? "is-live" : lightningStats.status === "error" ? "is-danger" : ""}">${this._formatLightningStatus(lightningStats.status)}</strong></div>
                <div class="hurricane-stat"><span>Data source</span><strong><a href="https://www.blitzortung.org" target="_blank" rel="noopener noreferrer" style="color:#90caf9">Blitzortung</a></strong></div>
              </div>
            </details>
          </div>
        </aside>`;
    }

    _syncStatusPanelLayout() {
      const wrap = this._root?.querySelector(".hurricane-map-wrap");
      const aside = this._root?.querySelector(".hurricane-status");
      if (!wrap || !aside) return;
      const expanded = this._isCompactLayout() && !this._statusCollapsed;
      wrap.classList.toggle("status-expanded", expanded);
      aside.classList.toggle("is-collapsed", this._isCompactLayout() && this._statusCollapsed);
      aside.dataset.statusExpanded = expanded ? "true" : "false";
      const toggle = aside.querySelector(".hurricane-status-toggle");
      if (toggle) {
        toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
        toggle.setAttribute("aria-label", expanded ? "Collapse hazard status" : "Expand hazard status");
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
      aside.querySelector(".hurricane-status-toggle")?.addEventListener("click", (e) => {
        e.stopPropagation();
        toggle();
      });
      aside.querySelector(".hurricane-status-head")?.addEventListener("click", (e) => {
        if (!this._isCompactLayout()) return;
        if (e.target.closest(".hurricane-status-toggle")) return;
        toggle();
      });
    }

    _renderUI() {
      if (!this._root || !this._data) return;

      const mapReady = !!(this._map && this._root.querySelector("#hurricane-map"));
      if (mapReady) {
        const aside = this._root.querySelector(".hurricane-status");
        if (aside) {
          aside.outerHTML = this._buildStatusPanelHtml();
          this._bindStatusPanelToggle();
          this._syncStatusPanelLayout();
        }
        this._renderMap();
        this._updateLightningStatusDom();
        return;
      }

      const layoutClass = this._embedded ? "hurricane-layout is-embedded" : "hurricane-layout";
      this._root.innerHTML = `
        <section class="${layoutClass}">
          <div class="hurricane-map-wrap">
            <div id="hurricane-map" class="hurricane-map"></div>
            ${this._buildBottomBarHtml()}
          </div>
          ${this._buildStatusPanelHtml()}
        </section>`;
      this._renderMap(true);
      this._syncLightningLayer();
      this._bindStatusPanelToggle();
      this._bindBottomBarToggles();
      this._syncStatusPanelLayout();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => this._map?.invalidateSize?.());
      });
    }

    _fmtMiles(value) {
      if (value == null || Number.isNaN(Number(value))) return "—";
      return `${Math.round(Number(value))} mi`;
    }

    _buildBottomBarHtml() {
      const layers = [
        { key: "hurricane", label: "Hurricanes", icon: "/local/home_weather/icons/hurricane.svg", type: "layer" },
        { key: "tornado", label: "Tornadoes", icon: "/local/home_weather/icons/tornado.svg", type: "layer" },
        { key: "earthquakes", label: "Earthquakes", icon: "/local/home_weather/icons/earthquake.svg", type: "layer" },
        { key: "volcanoes", label: "Volcanoes", icon: "/local/home_weather/icons/volcano.svg", type: "layer" },
        { key: "lightning", label: "Lightning", icon: "/local/home_weather/icons/lightning-bolt.svg", type: "layer" },
        { key: "travel", label: "Travel Advisories", icon: "/local/home_weather/icons/globe.svg", type: "layer" },
        { key: "wildfire", label: "Wildfires", icon: "/local/home_weather/icons/fire.svg", type: "layer" },
        { key: "air_quality", label: "Air Quality", icon: "/local/home_weather/icons/air-quality.svg", type: "layer" },
        { key: "wind_radii", label: "Wind Radii", icon: "/local/home_weather/icons/wind-radii.svg", type: "overlay" },
        { key: "alert_zones", label: "Alert Zones", icon: "/local/home_weather/icons/alert-zones.svg", type: "overlay" },
      ];
      const btns = layers.map((l) => {
        let active = "";
        if (l.type === "layer") {
          active = this._mapLayers[l.key] ? "is-active" : "";
        } else if (l.key === "wind_radii") {
          active = this._showWindRadii ? "is-active" : "";
        } else if (l.key === "alert_zones") {
          active = this._showZones ? "is-active" : "";
        }
        const pressed = active ? "true" : "false";
        const iconHtml = `<img src="${l.icon}" alt="" draggable="false"/>`;
        return `<button type="button" class="hw-bottom-layer-btn ${active}" data-layer="${l.key}" data-type="${l.type}" title="${l.label}" aria-label="${l.label}" aria-pressed="${pressed}">${iconHtml}</button>`;
      }).join("");
      return `
        <div class="hw-bottom-bar">
          <div class="hw-bottom-layers">${btns}</div>
          <div class="hw-bottom-coords">
            <span class="hw-coords-text">—</span>
            <span class="hw-scale-wrap"><span class="hw-scale-line" style="width:50px"></span><span class="hw-scale-label">—</span></span>
          </div>
        </div>`;
    }

    _bindBottomBarToggles() {
      const bar = this._root?.querySelector(".hw-bottom-bar");
      if (!bar || bar.dataset.bound === "true") return;
      bar.dataset.bound = "true";
      bar.addEventListener("click", (e) => {
        const btn = e.target.closest(".hw-bottom-layer-btn");
        if (!btn) return;
        const key = btn.dataset.layer;
        const type = btn.dataset.type;
        if (!key) return;
        
        if (type === "overlay") {
          if (key === "wind_radii") {
            this._showWindRadii = !this._showWindRadii;
            btn.classList.toggle("is-active", this._showWindRadii);
            btn.setAttribute("aria-pressed", this._showWindRadii ? "true" : "false");
            if (this._onOverlayToggle) this._onOverlayToggle("wind_radii", this._showWindRadii);
          } else if (key === "alert_zones") {
            this._showZones = !this._showZones;
            btn.classList.toggle("is-active", this._showZones);
            btn.setAttribute("aria-pressed", this._showZones ? "true" : "false");
            if (this._onOverlayToggle) this._onOverlayToggle("alert_zones", this._showZones);
          }
        } else {
          this._mapLayers[key] = !this._mapLayers[key];
          btn.classList.toggle("is-active", this._mapLayers[key]);
          btn.setAttribute("aria-pressed", this._mapLayers[key] ? "true" : "false");
          if (this._onLayerToggle) this._onLayerToggle(key, this._mapLayers[key]);
        }
        this._renderMap();
      });
    }

    _updateBottomBarCoords(lat, lon, zoom) {
      const el = this._root?.querySelector(".hw-bottom-bar .hw-coords-text");
      if (el) el.textContent = `${lat.toFixed(3)}°, ${lon.toFixed(3)}° · z${zoom ?? "?"}`;
    }

    _updateBottomBarScale(meters, label) {
      const line = this._root?.querySelector(".hw-bottom-bar .hw-scale-line");
      const lbl = this._root?.querySelector(".hw-bottom-bar .hw-scale-label");
      if (line && meters) {
        const px = Math.min(100, Math.max(40, meters / 10));
        line.style.width = `${px}px`;
      }
      if (lbl) lbl.textContent = label || "—";
    }

    _getUsaBounds() {
      const L = global.L;
      if (!L) return null;
      return L.latLngBounds(USA_BOUNDS);
    }

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
      });

      // Establish a valid initial view immediately. Without a center/zoom the
      // map has no view and tiles never load (blank map); fitBounds runs later
      // once the container has a real size.
      this._safe(() => this._map.setView([39.8283, -98.5795], 4));

      const baseLayers = {
        Dark: L.tileLayer(DARK_TILE_URL, { maxZoom: 19, subdomains: "abcd", attribution: CARTO_ATTR }),
        Light: L.tileLayer(LIGHT_TILE_URL, { maxZoom: 19, subdomains: "abcd", attribution: CARTO_ATTR }),
        Satellite: L.tileLayer(SAT_TILE_URL, { maxZoom: 19, attribution: ESRI_ATTR }),
        Ocean: L.tileLayer(OCEAN_TILE_URL, { maxZoom: 13, attribution: ESRI_ATTR }),
      };
      this._baseLayers = baseLayers;
      baseLayers.Dark.addTo(this._map);

      /* Custom toolbar stack at top-left; coords/scale in bottom bar */
      this._safe(() => this._buildMapControlsStack());
      this._safe(() => this._addCoordinateControl());

      this._layerGroup = L.layerGroup().addTo(this._map);
      if (global.L.markerClusterGroup) {
        this._earthquakeClusterGroup = global.L.markerClusterGroup({
          maxClusterRadius: 56,
          disableClusteringAtZoom: 8,
          spiderfyOnMaxZoom: true,
          showCoverageOnHover: false,
          iconCreateFunction: (cluster) => global.L.divIcon({
            html: `<div>${cluster.getChildCount()}</div>`,
            className: "marker-cluster-hw",
            iconSize: global.L.point(40, 40),
          }),
        });
        this._map.addLayer(this._earthquakeClusterGroup);
        this._volcanoClusterGroup = global.L.markerClusterGroup({
          maxClusterRadius: 48,
          disableClusteringAtZoom: 7,
          spiderfyOnMaxZoom: true,
          showCoverageOnHover: false,
          iconCreateFunction: (cluster) => global.L.divIcon({
            html: `<div>${cluster.getChildCount()}</div>`,
            className: "marker-cluster-hw-volcano",
            iconSize: global.L.point(34, 34),
          }),
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

    _categoryColor(category, windMph) {
      let cat = Number(category);
      if (!Number.isFinite(cat) || cat <= 0) {
        const w = Number(windMph);
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
      return CATEGORY_COLORS[cat] || CATEGORY_COLORS[0];
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
      const line = this._root?.querySelector(".hw-bottom-bar .hw-scale-line");
      const lbl = this._root?.querySelector(".hw-bottom-bar .hw-scale-label");
      if (line) line.style.width = `${barWidth}px`;
      if (lbl) lbl.textContent = label;
    }

    _buildLegendElement(collapsed = true) {
      const L = global.L;
      const div = L.DomUtil.create("div", `hw-legend${collapsed ? " collapsed" : ""}`);
      const catRows = [
        { c: CATEGORY_COLORS[0], t: "TD / Storm" },
        { c: CATEGORY_COLORS[1], t: "Category 1" },
        { c: CATEGORY_COLORS[2], t: "Category 2" },
        { c: CATEGORY_COLORS[3], t: "Category 3" },
        { c: CATEGORY_COLORS[4], t: "Category 4" },
        { c: CATEGORY_COLORS[5], t: "Category 5" },
      ];
      div.innerHTML = `
        <div class="hw-legend-header" role="button" tabindex="0" aria-expanded="${!collapsed}">
          <span>Legend</span><span class="hw-legend-caret">▾</span>
        </div>
        <div class="hw-legend-body">
          <div class="hw-legend-group">
            <div class="hw-legend-group-title">Hurricane category</div>
            ${catRows.map((r) => `<div class="hw-legend-row"><span class="hw-legend-dot" style="background:${r.c}"></span>${r.t}</div>`).join("")}
          </div>
          <div class="hw-legend-group">
            <div class="hw-legend-group-title">Earthquake magnitude</div>
            ${EQ_SCALE.map((r) => `<div class="hw-legend-row"><span class="hw-legend-dot" style="background:${r.color}"></span>${r.label}</div>`).join("")}
          </div>
          <div class="hw-legend-group">
            <div class="hw-legend-group-title">Other layers</div>
            <div class="hw-legend-row"><img src="/local/home_weather/icons/tornado.svg" alt=""/>Tornado warning</div>
            <div class="hw-legend-row"><img src="/local/home_weather/icons/disturbance.svg" alt=""/>NHC disturbance</div>
            <div class="hw-legend-row"><span class="hw-legend-swatch" style="background:rgba(255,167,38,0.25);border-color:#ffa726;border-style:dashed"></span>Development area</div>
            <div class="hw-legend-row"><img src="/local/home_weather/icons/lightning-bolt.svg" alt=""/>Live strike (Blitzortung)</div>
            <div class="hw-legend-row"><img src="/local/home_weather/icons/volcano.svg" alt="" style="opacity:0.55"/>Volcano (catalog)</div>
            <div class="hw-legend-row"><img src="/local/home_weather/icons/volcano.svg" alt=""/>Active volcano + affected area</div>
            <div class="hw-legend-row"><span class="hw-legend-swatch" style="background:rgba(76,175,80,0.45);border-color:#4caf50"></span>Travel L1 — Normal</div>
            <div class="hw-legend-row"><span class="hw-legend-swatch" style="background:rgba(255,241,118,0.5);border-color:#fff176"></span>Travel L2 — Caution</div>
            <div class="hw-legend-row"><span class="hw-legend-swatch" style="background:rgba(255,152,0,0.5);border-color:#ff9800"></span>Travel L3 — Reconsider</div>
            <div class="hw-legend-row"><span class="hw-legend-swatch" style="background:rgba(244,67,54,0.55);border-color:#f44336"></span>Travel L4 — Do not travel</div>
            <div class="hw-legend-row"><img src="/local/home_weather/icons/fire.svg" alt=""/>Active wildfire</div>
            <div class="hw-legend-row"><span class="hw-legend-swatch" style="background:rgba(229,57,53,0.35);border-color:#e53935"></span>Fire perimeter</div>
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

      this._activeBasemap = this._activeBasemap || "Dark";

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
      measureBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M21 6H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1zm-1 6h-2V9h-1.5v3h-1.5v-2h-1.5v2h-1.5V9H10v3H8.5v-2H7v2H5.5V9H4v3H3V8h17v4z"/></svg>`;
      this._measureBtn = measureBtn;
      L.DomEvent.on(measureBtn, "click", (e) => { L.DomEvent.stop(e); this._toggleMeasure(); });

      const legend = this._buildLegendElement(true);
      this._legendEl = legend;

      stack.appendChild(toolbar);
      stack.appendChild(readoutRow);
      stack.appendChild(legend);
      corner.insertBefore(stack, corner.firstChild);

      this._bindBasemapMenuDismiss();
    }

    _updateBasemapMenuChecks() {
      if (!this._basemapMenu) return;
      this._basemapMenu.querySelectorAll(".hw-basemap-option").forEach((item) => {
        const check = item.querySelector(".hw-basemap-check");
        if (check) check.textContent = item.dataset.layer === this._activeBasemap ? "✓" : "";
      });
    }

    _setBasemap(name) {
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

    _bindBasemapMenuDismiss() {
      if (this._basemapDismissBound) return;
      this._basemapDismissBound = true;
      const onDocClick = (ev) => {
        if (!this._basemapMenu || this._basemapMenu.hidden) return;
        const cell = this._basemapMenu.closest(".hw-basemap-cell");
        if (cell?.contains(ev.target)) return;
        this._closeBasemapMenu();
      };
      const onKeyDown = (ev) => {
        if (ev.key === "Escape") this._closeBasemapMenu();
      };
      document.addEventListener("click", onDocClick);
      document.addEventListener("keydown", onKeyDown);
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

    _renderMap(fitView = false) {
      const storms = this._data?.storms || [];
      const outlook = this._data?.outlook || {};
      const home = this._data?.home;
      if (!this._ensureMap() || !this._map || !this._layerGroup) return;

      this._layerGroup.clearLayers();
      if (this._earthquakeClusterGroup) this._earthquakeClusterGroup.clearLayers();
      if (this._volcanoClusterGroup) this._volcanoClusterGroup.clearLayers();
      this._homeMarker = null;

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
        const insideCone = this._data?.summary?.insideCone;
        const insideTornado = this._tornadoData?.affecting_home;
        const eqNearby = this._earthquakeData?.nearby_active;
        const homeIcon = global.L.divIcon({
          className: `hw-home-marker${insideCone || insideTornado || eqNearby ? " in-cone" : ""}`,
          html: `<img src="/local/home_weather/icons/home.svg" width="28" height="28" alt="Home" />`,
          iconSize: [28, 28],
          iconAnchor: [14, 28],
        });
        this._homeMarker = global.L.marker([home.lat, home.lon], { icon: homeIcon, zIndexOffset: 1000 })
          .bindPopup(`<strong>${this._esc(home.label || "Home")}</strong>`)
          .addTo(this._layerGroup);
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
        // reproject automatically on pan/zoom. (Canvas renderer has no _path.)
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
        textEl.setAttribute("dy", "-5");
        const textPath = document.createElementNS(SVGNS, "textPath");
        textPath.setAttributeNS(XLINKNS, "xlink:href", `#${pathId}`);
        textPath.setAttribute("href", `#${pathId}`);
        // The circle path starts due west and runs along the bottom, so 25%
        // centers the text at the bottom (due south of home) reading upright.
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
          const fontSize = Math.max(8, Math.min(22, rPx * 0.1));
          textEl.setAttribute("font-size", `${fontSize}px`);
          textEl.style.display = rPx < 34 ? "none" : "";
        };
        updateFont();
        this._zoneLabelUpdaters.push(updateFont);
      });
    }

    _fitMapView(stormBounds) {
      const L = global.L;
      const usa = this._getUsaBounds();
      if (!this._map || !usa || !L) return;
      if (this._userViewLocked) return;

      // Remember the requested bounds so we can retry once the container is
      // actually sized (fitBounds on a 0x0 container produces a broken view).
      this._lastFitBounds = stormBounds;
      const size = this._map.getSize?.();
      if (size && (size.x < 1 || size.y < 1)) {
        // Container not laid out yet — keep the default view and retry later.
        return;
      }

      const fitOpts = { padding: [48, 48], maxZoom: 8 };
      const points = this._collectFitPoints(stormBounds);

      if (points.length > 0) {
        const combined = L.latLngBounds(points).extend(usa);
        // Guard against antimeridian / bad coordinates blowing the fit out to
        // the entire tiled world (zoom 1). If the span is near-global, a hazard
        // is on the far side of the planet — stay anchored on the USA instead.
        const lngSpan = combined.getEast() - combined.getWest();
        const latSpan = combined.getNorth() - combined.getSouth();
        if (lngSpan <= 170 && latSpan <= 120) {
          this._map.fitBounds(combined, fitOpts);
        } else {
          this._map.fitBounds(usa, { padding: [24, 24], maxZoom: 8 });
        }
      } else {
        this._map.fitBounds(usa, { padding: [24, 24], maxZoom: 8 });
      }
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

    _drawStorm(storm, color, bounds) {
      const L = global.L;
      const tier = this._getDetailTier();
      const isPrimary = storm.id && storm.id === this._data?.summary?.closestStormId;
      const iconSize = isPrimary && tier >= 1 ? 36 : 32;
      const catColor = this._categoryColor(storm.category, storm.maxWindMph);
      const stormPopup = `
        <strong>${this._esc(storm.name)}</strong><br/>
        Advisory: ${this._esc(storm.advisoryTime || "—")}<br/>
        Max wind: ${storm.maxWindMph != null ? storm.maxWindMph + " mph" : "—"}<br/>
        Pressure: ${storm.pressureMb != null ? storm.pressureMb + " mb" : "—"}<br/>
        Movement: ${this._esc(storm.movement || "—")}<br/>
        Category: ${storm.category != null ? storm.category : "—"}
      `;
      const stormIcon = L.divIcon({
        className: "hw-hazard-icon-marker",
        html: `<div class="hw-storm-icon-wrap${isPrimary ? " is-primary" : ""}" style="--storm-color:${color}"><span class="hw-cat-ring" style="border-color:${catColor};box-shadow:0 0 8px ${catColor}cc;width:${iconSize}px;height:${iconSize}px;"></span><img class="hw-storm-icon" src="/local/home_weather/icons/hurricane.svg" width="${iconSize}" height="${iconSize}" alt="" draggable="false"/></div>`,
        iconSize: [iconSize, iconSize],
        iconAnchor: [iconSize / 2, iconSize / 2],
      });

      if (storm.cone?.coordinates) {
        const coneLayer = L.geoJSON(storm.cone, {
          style: {
            color,
            weight: 1,
            fillColor: color,
            fillOpacity: 0.15,
            opacity: 0.6,
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
            weight: 1,
            dashArray: "4 4",
            fillOpacity: 0.05,
            opacity: 0.5,
          },
        }).addTo(this._layerGroup);
      }

      if (storm.track?.coordinates?.length) {
        const latlngs = storm.track.coordinates.map((c) => [c[1], c[0]]);
        L.polyline(latlngs, { color, weight: 4, opacity: 0.9 }).addTo(this._layerGroup);
        latlngs.forEach((ll) => bounds.push(ll));
      }

      if (storm.pastTrack?.coordinates?.length) {
        const pastLatLngs = storm.pastTrack.coordinates.map((c) => [c[1], c[0]]);
        L.polyline(pastLatLngs, {
          color: "#90a4ae",
          weight: 3,
          opacity: 0.75,
          dashArray: "5 6",
        }).addTo(this._layerGroup);
        pastLatLngs.forEach((ll) => bounds.push(ll));
      }

      if (storm.watchWarning?.coordinates?.length) {
        const watchLatLngs = storm.watchWarning.coordinates.map((c) => [c[1], c[0]]);
        L.polyline(watchLatLngs, {
          color: "#f44336",
          weight: 3,
          opacity: 0.85,
        }).addTo(this._layerGroup);
        watchLatLngs.forEach((ll) => bounds.push(ll));
      }

      (storm.pastPoints || []).forEach((pt) => {
        if (pt.lat == null || pt.lon == null) return;
        L.circleMarker([pt.lat, pt.lon], {
          radius: 4,
          color: "#cfd8dc",
          weight: 1,
          fillColor: "#78909c",
          fillOpacity: 0.85,
        }).addTo(this._layerGroup);
        bounds.push([pt.lat, pt.lon]);
      });

      (storm.forecastPoints || []).forEach((pt) => {
        if (pt.lat == null || pt.lon == null) return;
        const hourLabel = pt.hour != null ? `${pt.hour}H` : "";
        const marker = L.circleMarker([pt.lat, pt.lon], {
          radius: 5,
          color: "#fff",
          weight: 1,
          fillColor: color,
          fillOpacity: 0.95,
        }).addTo(this._layerGroup);
        if (hourLabel && tier >= 2) {
          marker.bindTooltip(hourLabel, {
            permanent: true,
            direction: "right",
            className: "hw-forecast-label",
            offset: [6, 0],
          });
        }
        bounds.push([pt.lat, pt.lon]);
      });

      const stormLabel = this._formatStormLabel(storm);
      const addStormMarker = (latlng) => {
        const marker = L.marker(latlng, { icon: stormIcon, zIndexOffset: 500 })
          .bindPopup(stormPopup);
        if (stormLabel.name) {
          marker.bindTooltip(this._esc(stormLabel.name), {
            permanent: true,
            direction: "top",
            className: "hw-name-label hw-storm-label",
            offset: [0, -(iconSize / 2) - 2],
          });
        }
        marker.addTo(this._layerGroup);
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
      const catalogGroup = this._volcanoClusterGroup || this._layerGroup;

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
          marker.addTo(this._layerGroup);

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
        catalogGroup.addLayer(marker);
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
