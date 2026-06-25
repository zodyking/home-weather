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
      this._backendLightning = null;
      this._loading = false;
      this._error = null;
      this._showWindRadii = false;
      this._refreshTimer = null;
      this._mapInitialized = false;
      this._earthquakeClusterGroup = null;
      this._lastDetailTier = null;
      this._zoomDebounceTimer = null;
      this._zoomHandlerBound = false;
      this._viewLockHandlerBound = false;
      this._hasInitialFit = false;
      this._userViewLocked = false;
      this._mapLayers = { hurricane: true, tornado: true, earthquakes: true, lightning: true };
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
      if (this._map && this._layerGroup) this._renderMap();
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

    async init(rootEl) {
      this._root = rootEl;
      this._injectStyles();
      this._renderShell();
      await this._ensureDeps();
      this._bindControls();
      this._bindLayoutObserver();
      await this.loadData();
      this._refreshTimer = setInterval(() => this.loadData(), REFRESH_MS);
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
        }
      });
      this._layoutObserver.observe(this._root);
    }

    destroy() {
      if (this._refreshTimer) {
        clearInterval(this._refreshTimer);
        this._refreshTimer = null;
      }
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
      if (browserFeedActive) {
        const now = Date.now();
        const hourAgo = now - 60 * 60 * 1000;
        const maxAgeMs = (this._getLightningSettings().max_age_minutes || 60) * 60 * 1000;
        const active = this._lightningStrikes.filter((e) => now - e.strike.timeMs <= maxAgeMs);
        const lastHour = active.filter((e) => e.strike.timeMs >= hourAgo);
        let nearest = null;
        active.forEach((e) => {
          const d = this._distanceFromHomeMiles(e.strike.lat, e.strike.lon);
          if (d != null && (nearest == null || d < nearest)) nearest = d;
        });
        return {
          visibleCount: active.length,
          hourCount: lastHour.length,
          nearestMiles: nearest,
          status: this._lightningStatus,
        };
      }

      if (backend && backend.feed_status && backend.feed_status !== "off") {
        return {
          visibleCount: backend.geofield_count ?? 0,
          hourCount: backend.strikes_last_hour ?? 0,
          nearestMiles: backend.nearest_distance_miles ?? null,
          status: backend.feed_status,
        };
      }

      const now = Date.now();
      const hourAgo = now - 60 * 60 * 1000;
      const maxAgeMs = (this._getLightningSettings().max_age_minutes || 60) * 60 * 1000;
      const active = this._lightningStrikes.filter((e) => now - e.strike.timeMs <= maxAgeMs);
      const lastHour = active.filter((e) => e.strike.timeMs >= hourAgo);
      let nearest = null;
      active.forEach((e) => {
        const d = this._distanceFromHomeMiles(e.strike.lat, e.strike.lon);
        if (d != null && (nearest == null || d < nearest)) nearest = d;
      });
      return {
        visibleCount: active.length,
        hourCount: lastHour.length,
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
        this._lightningCleanupTimer = setInterval(() => this._cleanupLightningStrikes(), 30000);
      }
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
        this._lightningStrikes.forEach((e) => {
          if (e.marker && this._lightningLayerGroup) {
            this._lightningLayerGroup.removeLayer(e.marker);
          }
        });
        this._lightningStrikes = [];
        this._lightningLayerGroup?.clearLayers();
      }
      this._updateLightningStatusDom();
    }

    _onLightningStrike(strike) {
      if (!this._lightningEnabled() || !this._lightningLayerGroup || !global.L) return;
      const settings = this._getLightningSettings();
      const maxStrikes = Math.max(50, Number(settings.max_strikes) || 500);
      if (this._lightningStrikes.some((e) => e.strike.id === strike.id)) return;

      const marker = this._addLightningMarker(strike);
      if (!marker) return;
      this._lightningStrikes.push({ strike, marker });

      while (this._lightningStrikes.length > maxStrikes) {
        const oldest = this._lightningStrikes.shift();
        if (oldest?.marker) this._lightningLayerGroup.removeLayer(oldest.marker);
      }

      setTimeout(() => {
        const el = marker.getElement?.();
        if (el) {
          const wrap = el.querySelector(".hw-hazard-icon-wrap");
          if (wrap) wrap.classList.remove("is-fresh");
        }
      }, 2500);

      this._cleanupLightningStrikes();
      this._updateLightningStatusDom();
    }

    _addLightningMarker(strike) {
      const L = global.L;
      if (!L || !this._lightningLayerGroup) return null;
      const ageMs = Date.now() - strike.timeMs;
      const maxAgeMs = (this._getLightningSettings().max_age_minutes || 60) * 60 * 1000;
      const ageClass = ageMs > maxAgeMs * 0.5 ? "is-aging" : "is-fresh";
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
        className: `hw-lightning-marker ${ageClass}`,
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
      const maxAgeMs = (this._getLightningSettings().max_age_minutes || 60) * 60 * 1000;
      const cutoff = Date.now() - maxAgeMs;
      const keep = [];
      this._lightningStrikes.forEach((entry) => {
        if (entry.strike.timeMs < cutoff) {
          if (entry.marker && this._lightningLayerGroup) {
            this._lightningLayerGroup.removeLayer(entry.marker);
          }
        } else {
          keep.push(entry);
        }
      });
      this._lightningStrikes = keep;
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
          min-height: 100%;
          padding: 0;
          margin: 0;
          max-width: none;
          box-sizing: border-box;
        }
        .hurricane-layout.is-embedded {
          min-height: 100%;
          height: 100%;
        }
        .hurricane-layout.is-embedded .hurricane-map-wrap {
          position: relative;
          inset: auto;
          width: 100%;
          height: 100%;
          min-height: 100%;
        }
        .hurricane-layout.is-embedded .hurricane-map {
          min-height: 100%;
          border-radius: 0;
          border: none;
        }
        .hurricane-layout.is-embedded .hurricane-status {
          top: 12px;
          right: 12px;
          bottom: 12px;
          max-height: calc(100% - 24px);
          width: min(280px, calc(100% - 24px));
        }
        .hurricane-layout.is-embedded .hurricane-map-empty-banner {
          top: 12px;
          left: 12px;
          right: min(280px, calc(100% - 24px));
        }
        .hurricane-status-details {
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 10px;
          overflow: hidden;
          background: rgba(255,255,255,0.03);
        }
        .hurricane-status-details + .hurricane-status-details {
          margin-top: 4px;
        }
        .hurricane-status-details summary {
          list-style: none;
          cursor: pointer;
          padding: 10px 12px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: #b0bec5;
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
          color: #eceff1;
          background: rgba(255,255,255,0.1);
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
          border-bottom: 1px solid rgba(255,255,255,0.06);
        }
        .hurricane-status-details-body {
          padding: 8px 12px 10px;
          display: flex;
          flex-direction: column;
          gap: 6px;
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
          color: #e1e1e1;
        }
        .hurricane-status-headline.is-watch { color: #ffb74d; }
        .hurricane-status-headline.is-danger { color: #ef5350; }
        .hurricane-status-section {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding-top: 4px;
          border-top: 1px solid rgba(255,255,255,0.08);
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
        }
        .hurricane-map {
          width: 100%;
          height: 100%;
          min-height: 100%;
          border-radius: 0;
          overflow: hidden;
          border: none;
          background: #111111;
        }
        .hurricane-map-empty-banner { display: none; }
        .hurricane-status {
          position: absolute;
          top: 12px;
          right: 12px;
          bottom: 12px;
          width: min(280px, calc(100% - 24px));
          max-height: calc(100% - 24px);
          overflow-y: auto;
          z-index: 600;
          background: rgba(17, 20, 28, 0.88);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 14px;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          backdrop-filter: blur(14px);
          box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
        }
        .hurricane-status.is-threat-high {
          border-color: rgba(244,67,54,0.55);
          box-shadow: 0 0 0 1px rgba(244,67,54,0.25), 0 12px 40px rgba(0, 0, 0, 0.45);
        }
        .hurricane-status.is-threat-watch {
          border-color: rgba(255,152,0,0.45);
        }
        .hurricane-status h3 {
          margin: 0;
          font-size: 16px;
          font-weight: 600;
          color: #e1e1e1;
        }
        .hurricane-stat {
          display: flex;
          justify-content: space-between;
          gap: 8px;
          font-size: 13px;
          color: #9b9b9b;
        }
        .hurricane-stat strong {
          color: #e1e1e1;
          font-weight: 600;
          text-align: right;
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
          background: rgba(28, 28, 28, 0.92);
          color: #e1e1e1;
          border-color: rgba(255,255,255,0.12);
        }
        .leaflet-control-zoom a:hover {
          background: rgba(40, 40, 40, 0.96);
          color: #fff;
        }
        /* Horizontal zoom above scale bar (bottom-left stack) */
        .leaflet-bottom.leaflet-left .leaflet-control-zoom.leaflet-bar {
          display: flex;
          flex-direction: row;
          border-radius: 8px;
          overflow: hidden;
        }
        .leaflet-bottom.leaflet-left .leaflet-control-zoom.leaflet-bar a {
          width: 34px;
          height: 32px;
          line-height: 32px;
          border-bottom: none;
          border-right: 1px solid rgba(255,255,255,0.12);
        }
        .leaflet-bottom.leaflet-left .leaflet-control-zoom.leaflet-bar a:last-child {
          border-right: none;
        }
        .leaflet-bottom.leaflet-left .leaflet-control-scale {
          margin-bottom: 0;
        }
        .leaflet-bar {
          border: 1px solid rgba(255,255,255,0.12);
          box-shadow: 0 4px 16px rgba(0,0,0,0.35);
        }
        .leaflet-control-attribution {
          background: rgba(17, 17, 17, 0.72) !important;
          color: #9b9b9b !important;
          backdrop-filter: blur(6px);
        }
        .leaflet-control-attribution a { color: #90caf9 !important; }
        .hw-forecast-label {
          background: rgba(17, 20, 28, 0.88);
          color: #fff;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 6px;
          padding: 3px 8px;
          font-size: 11px;
          font-weight: 600;
          box-shadow: 0 4px 12px rgba(0,0,0,0.35);
          backdrop-filter: blur(8px);
        }
        .hw-tornado-polygon {
          stroke: #e040fb;
          fill: rgba(224, 64, 251, 0.18);
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
        }
        .hw-hazard-icon-wrap.hw-lightning-marker.is-aging {
          opacity: 0.45;
          filter: drop-shadow(0 1px 4px rgba(0,0,0,0.35));
        }
        @keyframes hw-lightning-pop {
          0% { transform: scale(0.4); opacity: 0.2; }
          70% { transform: scale(1.15); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        .hurricane-stat strong.is-live { color: #ffc107; }
        /* Scientific map controls */
        .hw-coords {
          background: rgba(17, 20, 28, 0.82);
          color: #cfd8dc;
          font-size: 11px;
          line-height: 1.4;
          padding: 3px 8px;
          margin: 0 0 6px 6px !important;
          border-radius: 6px;
          border: 1px solid rgba(255,255,255,0.12);
          backdrop-filter: blur(6px);
          font-variant-numeric: tabular-nums;
          pointer-events: none;
          white-space: nowrap;
        }
        .hw-legend {
          background: rgba(17, 20, 28, 0.92);
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 10px;
          color: #cfd8dc;
          overflow: hidden;
          max-width: 210px;
          backdrop-filter: blur(10px);
          box-shadow: 0 6px 22px rgba(0,0,0,0.4);
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
        .hw-legend-row { display: flex; align-items: center; gap: 8px; font-size: 11px; }
        .hw-legend-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
        .hw-legend-swatch { width: 12px; height: 12px; border-radius: 3px; flex-shrink: 0; border: 1px solid rgba(255,255,255,0.3); }
        .hw-legend img { width: 14px; height: 14px; flex-shrink: 0; }
        .hw-measure-ctrl { display: flex; align-items: stretch; }
        .hw-measure-ctrl .hw-measure-btn {
          display: flex !important;
          align-items: center;
          justify-content: center;
          width: 34px;
          height: 34px;
          line-height: 34px;
          background: rgba(28, 28, 28, 0.92);
          color: #e1e1e1;
        }
        .hw-measure-ctrl .hw-measure-btn:hover { background: rgba(40, 40, 40, 0.96); color: #fff; }
        .hw-measure-ctrl.active .hw-measure-btn { background: #0288d1; color: #fff; }
        .hw-measure-readout {
          display: none;
          align-items: center;
          padding: 0 10px;
          font-size: 11px;
          font-weight: 600;
          color: #e1e1e1;
          background: rgba(17, 20, 28, 0.92);
          border-left: 1px solid rgba(255,255,255,0.12);
          white-space: nowrap;
          font-variant-numeric: tabular-nums;
        }
        .hw-measure-ctrl.active .hw-measure-readout { display: flex; }
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
          border-radius: 10px;
          backdrop-filter: blur(10px);
        }
        .leaflet-control-layers-toggle {
          background-color: rgba(28, 28, 28, 0.92);
          border-radius: 8px;
        }
        .leaflet-control-layers-expanded { padding: 8px 10px; }
        .leaflet-control-layers label { font-size: 12px; margin: 2px 0; }
        .leaflet-control-scale-line {
          background: rgba(17, 20, 28, 0.7);
          color: #cfd8dc;
          border-color: rgba(255,255,255,0.4);
        }
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
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 8px;
          background: rgba(255,255,255,0.06);
          color: #b0bec5;
          cursor: pointer;
          flex-shrink: 0;
          line-height: 1;
          font-size: 14px;
        }
        .hurricane-status-toggle:hover { background: rgba(255,255,255,0.12); color: #eceff1; }
        .hurricane-status h3.hurricane-status-head {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        @media (max-width: 768px) {
          .hurricane-status {
            top: auto;
            left: 10px;
            right: 10px;
            bottom: max(10px, env(safe-area-inset-bottom, 0px));
            width: auto;
            max-height: min(52vh, 420px);
            padding: 12px 14px;
            border-radius: 16px 16px 12px 12px;
            transition: max-height 0.2s ease, padding 0.2s ease;
          }
          .hurricane-status.is-collapsed {
            max-height: none;
            overflow: hidden;
            padding-bottom: 12px;
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
          .hurricane-map-wrap .leaflet-bottom.leaflet-left {
            left: auto;
            right: 10px;
            bottom: max(10px, env(safe-area-inset-bottom, 0px));
          }
          .hurricane-map-wrap.status-expanded .leaflet-bottom.leaflet-left {
            bottom: calc(min(52vh, 420px) + 18px);
          }
          .hurricane-map-wrap.status-expanded .leaflet-bottom.leaflet-right {
            bottom: max(10px, env(safe-area-inset-bottom, 0px));
          }
          .leaflet-bottom.leaflet-left .leaflet-control-scale {
            max-width: min(140px, 42vw);
          }
          .hw-coords { font-size: 10px; padding: 2px 6px; }
          .hurricane-map-empty-banner {
            top: 68px;
            left: 12px;
            right: 12px;
          }
          .hurricane-layout.is-embedded .hurricane-status {
            top: auto;
            left: 10px;
            right: 10px;
            bottom: max(10px, env(safe-area-inset-bottom, 0px));
            max-height: min(48vh, 320px);
          }
          .hurricane-layout.is-embedded .hurricane-map-wrap.status-expanded .leaflet-bottom.leaflet-left {
            bottom: calc(min(48vh, 320px) + 18px);
          }
          .hurricane-layout.is-embedded .hurricane-map-empty-banner {
            top: 10px;
            left: 10px;
            right: 10px;
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
      return new Promise((resolve, reject) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        link.onload = () => resolve();
        link.onerror = () => reject(new Error(`Failed to load ${href}`));
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
        const [payload, tornadoPayload, earthquakePayload, lightningPayload] = await Promise.all([
          this._hass.callWS({
            type: "home_weather/get_hurricanes",
            force_refresh: !!forceRefresh,
          }),
          this._hass.callWS({ type: "home_weather/get_tornadoes" }).catch(() => null),
          this._hass.callWS({ type: "home_weather/get_earthquakes" }).catch(() => null),
          this._hass.callWS({ type: "home_weather/get_lightning" }).catch(() => null),
        ]);
        this._data = payload;
        this._tornadoData = tornadoPayload;
        this._earthquakeData = earthquakePayload;
        this._backendLightning = lightningPayload;
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
          <h3 class="hurricane-status-head">
            Hazard Status
            <button type="button" class="hurricane-status-toggle" aria-expanded="${statusExpanded ? "true" : "false"}" aria-label="${statusExpanded ? "Collapse hazard status" : "Expand hazard status"}">▾</button>
          </h3>
          <p class="hurricane-status-headline ${headline.className}">${this._esc(headline.text)}</p>
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
            <summary><span>Lightning</span><span class="h-count" id="hw-lightning-badge">${lightningStats.visibleCount}</span><span class="h-chevron">▸</span></summary>
            <div class="hurricane-status-details-body">
              <div class="hurricane-stat"><span>Strikes (last hour)</span><strong id="hw-lightning-count">${lightningStats.hourCount}</strong></div>
              <div class="hurricane-stat"><span>Nearest strike</span><strong id="hw-lightning-nearest">${lightningStats.nearestMiles != null ? this._fmtMiles(lightningStats.nearestMiles) : "—"}</strong></div>
              <div class="hurricane-stat"><span>Feed status</span><strong id="hw-lightning-status" class="${lightningStats.status === "live" ? "is-live" : lightningStats.status === "error" ? "is-danger" : ""}">${this._formatLightningStatus(lightningStats.status)}</strong></div>
              <div class="hurricane-stat"><span>Data source</span><strong><a href="https://www.blitzortung.org" target="_blank" rel="noopener noreferrer" style="color:#90caf9">Blitzortung</a></strong></div>
            </div>
          </details>
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
            ${this._buildStatusPanelHtml()}
          </div>
        </section>`;
      this._renderMap(true);
      this._syncLightningLayer();
      this._bindStatusPanelToggle();
      this._syncStatusPanelLayout();
    }

    _fmtMiles(value) {
      if (value == null || Number.isNaN(Number(value))) return "—";
      return `${Math.round(Number(value))} mi`;
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
      });

      const baseLayers = {
        Dark: L.tileLayer(DARK_TILE_URL, { maxZoom: 19, subdomains: "abcd", attribution: CARTO_ATTR }),
        Light: L.tileLayer(LIGHT_TILE_URL, { maxZoom: 19, subdomains: "abcd", attribution: CARTO_ATTR }),
        Satellite: L.tileLayer(SAT_TILE_URL, { maxZoom: 19, attribution: ESRI_ATTR }),
        Ocean: L.tileLayer(OCEAN_TILE_URL, { maxZoom: 13, attribution: ESRI_ATTR }),
      };
      this._baseLayers = baseLayers;
      baseLayers.Dark.addTo(this._map);

      /* Scale at bottom, horizontal zoom above it, coords on top */
      this._safe(() => L.control.scale({ position: "bottomleft", metric: true, imperial: true, maxWidth: 160 }).addTo(this._map));
      L.control.zoom({ position: "bottomleft" }).addTo(this._map);
      this._safe(() => L.control.layers(baseLayers, null, { position: "topleft", collapsed: true }).addTo(this._map));
      this._safe(() => this._addMeasureControl());
      this._safe(() => this._addLegendControl());
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
      const ctrl = L.control({ position: "bottomleft" });
      ctrl.onAdd = () => {
        const div = L.DomUtil.create("div", "hw-coords");
        div.textContent = "—";
        this._coordsEl = div;
        return div;
      };
      ctrl.addTo(this._map);
      const update = (lat, lon) => {
        if (!this._coordsEl) return;
        const z = this._map?.getZoom?.();
        this._coordsEl.textContent = `${lat.toFixed(3)}°, ${lon.toFixed(3)}°  ·  z${z ?? "?"}`;
      };
      this._map.on("mousemove", (e) => update(e.latlng.lat, e.latlng.lng));
      this._map.on("zoomend moveend", () => {
        const c = this._map.getCenter();
        update(c.lat, c.lng);
      });
    }

    _addLegendControl() {
      const L = global.L;
      if (!L || !this._map) return;
      const ctrl = L.control({ position: "topleft" });
      const collapsed = (global.innerWidth || 1024) < 768;
      ctrl.onAdd = () => {
        const div = L.DomUtil.create("div", `hw-legend leaflet-control${collapsed ? " collapsed" : ""}`);
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
              <div class="hw-legend-row"><span class="hw-legend-swatch" style="background:rgba(224,64,251,0.3);border-color:#e040fb"></span>Tornado warning</div>
              <div class="hw-legend-row"><img src="/local/home_weather/icons/disturbance.svg" alt=""/>NHC disturbance</div>
              <div class="hw-legend-row"><span class="hw-legend-swatch" style="background:rgba(255,167,38,0.25);border-color:#ffa726;border-style:dashed"></span>Development area</div>
              <div class="hw-legend-row"><img src="/local/home_weather/icons/lightning-bolt.svg" alt=""/>Live strike (Blitzortung)</div>
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
      };
      ctrl.addTo(this._map);
    }

    _addMeasureControl() {
      const L = global.L;
      if (!L || !this._map) return;
      const ctrl = L.control({ position: "topleft" });
      ctrl.onAdd = () => {
        const container = L.DomUtil.create("div", "hw-measure-ctrl leaflet-bar");
        const btn = L.DomUtil.create("a", "hw-measure-btn", container);
        btn.href = "#";
        btn.title = "Measure distance";
        btn.setAttribute("role", "button");
        btn.setAttribute("aria-label", "Measure distance");
        btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M21 6H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1zm-1 6h-2V9h-1.5v3h-1.5v-2h-1.5v2h-1.5V9H10v3H8.5v-2H7v2H5.5V9H4v3H3V8h17v4z"/></svg>`;
        const readout = L.DomUtil.create("span", "hw-measure-readout", container);
        readout.textContent = "";
        this._measureBtn = container;
        this._measureReadout = readout;
        L.DomEvent.on(btn, "click", (e) => { L.DomEvent.stop(e); this._toggleMeasure(); });
        L.DomEvent.disableClickPropagation(container);
        return container;
      };
      ctrl.addTo(this._map);
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
        if (this._measureReadout) this._measureReadout.textContent = "Click points…";
      } else {
        this._map.off("click", this._measureClickHandler);
        this._map.off("dblclick", this._measureDblHandler);
        this._map.doubleClickZoom.enable();
        this._measureBtn?.classList.remove("active");
        L.DomUtil.removeClass(this._map.getContainer(), "hw-measuring");
        this._measureLayer?.clearLayers();
        this._measurePoints = [];
        if (this._measureReadout) this._measureReadout.textContent = "";
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
      if (this._measureReadout) this._measureReadout.textContent = pts.length < 2 ? "Click next point…" : text;
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
      this._homeMarker = null;

      const bounds = [];
      const layers = this._mapLayers || { hurricane: true, tornado: true, earthquakes: true };

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

      if (fitView || !this._hasInitialFit) {
        this._fitMapView(bounds);
      }
      setTimeout(() => this._map?.invalidateSize(), 100);
    }

    _fitMapView(stormBounds) {
      const usa = this._getUsaBounds();
      if (!this._map || !usa) return;
      if (this._userViewLocked) return;

      if (stormBounds.length > 0) {
        const combined = global.L.latLngBounds(stormBounds).extend(usa);
        this._map.fitBounds(combined, { padding: [48, 48] });
      } else {
        this._map.fitBounds(usa, { padding: [24, 24] });
      }
      this._hasInitialFit = true;
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

      const pos = storm.currentPosition;
      if (pos?.lat != null && pos?.lon != null) {
        L.marker([pos.lat, pos.lon], { icon: stormIcon, zIndexOffset: 500 })
          .bindPopup(stormPopup)
          .addTo(this._layerGroup);
        bounds.push([pos.lat, pos.lon]);
      } else if (storm.cone) {
        const center = this._getFeatureCenterLatLng({ type: "Feature", geometry: storm.cone, properties: {} });
        if (center) {
          L.marker(center, { icon: stormIcon, zIndexOffset: 500 })
            .bindPopup(stormPopup)
            .addTo(this._layerGroup);
          bounds.push(center);
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
  }

  global.HurricaneTracker = HurricaneTracker;
})(typeof window !== "undefined" ? window : globalThis);
