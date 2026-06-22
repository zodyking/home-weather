/**
 * Hurricane Tracker - Leaflet map for NOAA/NHC storm data.
 */
(function (global) {
  "use strict";

  const STORM_COLORS = ["#e53935", "#fb8c00", "#8e24aa", "#1e88e5", "#43a047"];
  const REFRESH_MS = 15 * 60 * 1000;
  const DARK_TILE_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
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
      this._loading = false;
      this._error = null;
      this._showWindRadii = false;
      this._refreshTimer = null;
      this._mapInitialized = false;
    }

    async init(rootEl) {
      this._root = rootEl;
      this._injectStyles();
      this._renderShell();
      await this._ensureDeps();
      this._bindControls();
      await this.loadData();
      this._refreshTimer = setInterval(() => this.loadData(), REFRESH_MS);
    }

    destroy() {
      if (this._refreshTimer) {
        clearInterval(this._refreshTimer);
        this._refreshTimer = null;
      }
      if (this._map) {
        this._map.remove();
        this._map = null;
        this._mapInitialized = false;
      }
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
          min-height: clamp(320px, 42vh, 460px);
          height: clamp(320px, 42vh, 460px);
        }
        .hurricane-layout.is-embedded .hurricane-map-wrap {
          position: relative;
          inset: auto;
          width: 100%;
          height: 100%;
          min-height: inherit;
        }
        .hurricane-layout.is-embedded .hurricane-map {
          min-height: inherit;
          border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.12);
        }
        .hurricane-layout.is-embedded .hurricane-status {
          top: 12px;
          right: 12px;
          bottom: 12px;
          max-height: calc(100% - 24px);
        }
        .hurricane-layout.is-embedded .hurricane-map-empty-banner {
          top: 12px;
          left: 12px;
          right: min(300px, calc(100% - 24px));
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
        .hurricane-map-empty-banner {
          position: absolute;
          top: 72px;
          left: 16px;
          right: min(340px, calc(100% - 32px));
          z-index: 500;
          padding: 10px 14px;
          border-radius: 10px;
          font-size: 13px;
          line-height: 1.45;
          color: #cfd8dc;
          background: rgba(17, 17, 17, 0.82);
          border: 1px solid rgba(255,255,255,0.12);
          backdrop-filter: blur(10px);
          pointer-events: none;
        }
        .hurricane-status {
          position: absolute;
          top: 72px;
          right: 16px;
          bottom: 16px;
          width: min(300px, calc(100% - 32px));
          max-height: calc(100% - 88px);
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
        .hw-forecast-label,
        .hw-outlook-label,
        .hw-storm-track-label {
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
        .hw-outlook-label { color: #ffb74d; }
        .hw-tornado-polygon {
          stroke: #e040fb;
          fill: rgba(224, 64, 251, 0.18);
        }
        .hw-tornado-label {
          background: rgba(74, 20, 140, 0.92);
          color: #f3e5f5;
          border: 1px solid rgba(224, 64, 251, 0.55);
          border-radius: 6px;
          padding: 3px 8px;
          font-size: 11px;
          font-weight: 600;
          box-shadow: 0 4px 12px rgba(0,0,0,0.35);
        }
        .hw-earthquake-marker {
          border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.85);
          box-shadow: 0 0 0 2px rgba(0,0,0,0.35);
        }
        .hw-earthquake-marker.is-tsunami {
          box-shadow: 0 0 0 3px rgba(3,169,244,0.75), 0 0 12px rgba(3,169,244,0.45);
        }
        .hw-earthquake-label {
          background: rgba(20, 24, 28, 0.92);
          color: #ffe082;
          border: 1px solid rgba(255, 193, 7, 0.45);
          border-radius: 6px;
          padding: 3px 8px;
          font-size: 11px;
          font-weight: 600;
          box-shadow: 0 4px 12px rgba(0,0,0,0.35);
        }
        .hw-storm-marker-wrap {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          text-align: center;
          transform: translate(-50%, -50%);
        }
        .hw-storm-name {
          background: rgba(17, 20, 28, 0.92);
          color: #fff;
          border: 1px solid rgba(255,255,255,0.14);
          border-left: 3px solid var(--storm-color, #e53935);
          border-radius: 8px;
          padding: 5px 10px;
          font-size: 12px;
          font-weight: 700;
          line-height: 1.25;
          white-space: nowrap;
          box-shadow: 0 6px 18px rgba(0,0,0,0.4);
          backdrop-filter: blur(10px);
        }
        .hw-storm-meta {
          display: block;
          margin-top: 2px;
          font-size: 10px;
          font-weight: 500;
          color: #b0bec5;
        }
        .hw-storm-icon {
          filter: drop-shadow(0 2px 6px rgba(0,0,0,0.45));
        }
        .hw-home-marker.in-cone {
          filter: drop-shadow(0 0 6px rgba(244,67,54,0.9));
          animation: hw-pulse 1.5s ease-in-out infinite;
        }
        @keyframes hw-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.08); } }
        @media (max-width: 768px) {
          .hurricane-status {
            top: auto;
            left: 12px;
            right: 12px;
            bottom: 12px;
            width: auto;
            max-height: min(46vh, 360px);
          }
          .hurricane-map-empty-banner {
            top: 68px;
            left: 12px;
            right: 12px;
          }
          .hurricane-layout.is-embedded .hurricane-status {
            top: auto;
            left: 10px;
            right: 10px;
            bottom: 10px;
            max-height: min(42vh, 280px);
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
      this._root.innerHTML = `<div class="hurricane-loading">Loading hurricane data…</div>`;
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
        const [payload, tornadoPayload, earthquakePayload] = await Promise.all([
          this._hass.callWS({
            type: "home_weather/get_hurricanes",
            force_refresh: !!forceRefresh,
          }),
          this._hass.callWS({ type: "home_weather/get_tornadoes" }).catch(() => null),
          this._hass.callWS({ type: "home_weather/get_earthquakes" }).catch(() => null),
        ]);
        this._data = payload;
        this._tornadoData = tornadoPayload;
        this._earthquakeData = earthquakePayload;
        this._renderUI();
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
      if (!this._root) return;
      this._root.addEventListener("change", (e) => {
        if (e.target.matches("[data-wind-radii-toggle]")) {
          this._showWindRadii = e.target.checked;
          this._renderMap();
        }
      });
      this._root.addEventListener("click", (e) => {
        if (e.target.closest("[data-hurricane-refresh]")) {
          this.loadData(true);
        }
      });
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

    _addMapLabel(lat, lon, text, className, direction, offset) {
      const L = global.L;
      if (!L || lat == null || lon == null || !text) return;
      L.marker([lat, lon], {
        icon: L.divIcon({
          className: "hw-map-label-anchor",
          html: `<div class="${className}">${this._esc(text)}</div>`,
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        }),
        interactive: false,
        zIndexOffset: 400,
      }).addTo(this._layerGroup);
    }

    _renderError() {
      if (!this._root) return;
      this._root.innerHTML = `
        <section class="hurricane-layout">
          <div class="hurricane-empty" style="width:100%;height:100%">
            <p>Failed to load hurricane data.</p>
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
        return { text: `${stormCount} active tropical cyclone${stormCount === 1 ? "" : "s"}`, className: "" };
      }
      if (hasOutlook) {
        if (summary.insideDevelopmentRegion) {
          return { text: "Your area is inside a tropical development region", className: "is-watch" };
        }
        if (summary.disturbanceCount > 0) {
          return {
            text: `${summary.disturbanceCount} disturbance${summary.disturbanceCount === 1 ? "" : "s"} being tracked by NHC`,
            className: "is-watch",
          };
        }
        return { text: "NHC is monitoring potential tropical development", className: "is-watch" };
      }
      return { text: "No active tropical cyclones or disturbances", className: "" };
    }

    _renderUI() {
      if (!this._root || !this._data) return;
      if (this._map) {
        this._map.remove();
        this._map = null;
        this._mapInitialized = false;
        this._layerGroup = null;
      }
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

      const fetchedAt = summary.fetchedAt
        ? new Date(summary.fetchedAt).toLocaleString()
        : "—";

      const tornado = this._tornadoData || {};
      const tornadoCount = tornado.active_count || 0;
      const tornadoAffecting = tornado.affecting_home ? "Yes" : "No";
      const tornadoDistance = this._fmtMiles(tornado.nearest_distance_miles);
      const tornadoHeadline = tornado.primary_alert?.headline || "—";

      const earthquake = this._earthquakeData || {};
      const eqPrimary = earthquake.primary_event || {};
      const eqCount = earthquake.active_count || 0;
      const eqDistance = this._fmtMiles(earthquake.nearest_distance_miles);
      const eqMag = eqPrimary.magnitude != null ? `M${eqPrimary.magnitude}` : "—";
      const eqDepth = eqPrimary.depth_km != null ? `${Math.round(eqPrimary.depth_km)} km` : "—";
      const eqPlace = eqPrimary.place || "—";
      const eqTsunami = eqPrimary.tsunami === 1 ? "Yes" : "No";

      const headline = this._buildStatusHeadline(summary, storms);
      const outlookSection = summary.hasOutlookActivity ? `
          <div class="hurricane-status-section">
            <h4>Tropical Outlook</h4>
            <div class="hurricane-stat"><span>Disturbances</span><strong>${summary.disturbanceCount || 0}</strong></div>
            <div class="hurricane-stat"><span>Development areas</span><strong>${summary.developmentAreaCount || 0}</strong></div>
            <div class="hurricane-stat ${summary.insideDevelopmentRegion ? "is-warning" : ""}"><span>Inside dev. region</span><strong>${summary.insideDevelopmentRegion ? "Yes" : "No"}</strong></div>
            <div class="hurricane-stat"><span>Nearest disturbance</span><strong>${this._fmtMiles(summary.nearestDisturbanceMiles)}</strong></div>
            <div class="hurricane-stat"><span>Formation probability</span><strong>${summary.highestFormationProbability != null ? summary.highestFormationProbability + "%" : "—"}</strong></div>
          </div>` : "";

      const cycloneSection = storms.length > 0 ? `
          <div class="hurricane-status-section">
            <h4>Active Cyclones</h4>
            <div class="hurricane-stat"><span>Active storms</span><strong>${storms.length}</strong></div>
            <div class="hurricane-stat"><span>Closest storm</span><strong>${this._esc(summary.closestStormName || "—")}</strong></div>
            <div class="hurricane-stat"><span>Distance to center</span><strong>${this._fmtMiles(summary.distanceToCenterMiles)}</strong></div>
            <div class="hurricane-stat"><span>Nearest forecast point</span><strong>${this._fmtMiles(summary.distanceToNearestForecastMiles)}</strong></div>
            <div class="hurricane-stat ${insideClass}"><span>Home inside cone</span><strong>${insideText}</strong></div>
            <div class="hurricane-stat"><span>Closest approach</span><strong>${summary.estimatedClosestApproachHour != null ? summary.estimatedClosestApproachHour + "H" : "—"}</strong></div>
          </div>` : "";

      const statusPanel = `
        <aside class="hurricane-status ${threatClass}">
          <h3>Hazard Status</h3>
          <p class="hurricane-status-headline ${headline.className}">${this._esc(headline.text)}</p>
          ${staleBanner}
          <div class="hurricane-stat"><span>Overall tropical threat</span><strong>${this._esc(summary.threatLevel || "none")}</strong></div>
          ${outlookSection}
          ${cycloneSection}
          <div class="hurricane-status-section">
            <h4>Tornado Warnings</h4>
            <div class="hurricane-stat"><span>Active warnings</span><strong>${tornadoCount}</strong></div>
            <div class="hurricane-stat ${tornado.affecting_home ? "is-danger" : ""}"><span>Affecting home</span><strong>${tornadoAffecting}</strong></div>
            <div class="hurricane-stat"><span>Nearest warning</span><strong>${tornadoDistance}</strong></div>
            <div class="hurricane-stat"><span>Primary alert</span><strong>${this._esc(tornadoHeadline)}</strong></div>
          </div>
          <div class="hurricane-status-section">
            <h4>Earthquakes</h4>
            <div class="hurricane-stat"><span>Within range</span><strong>${eqCount}</strong></div>
            <div class="hurricane-stat ${earthquake.nearby_active ? "is-warning" : ""}"><span>Nearest</span><strong>${this._esc(eqPlace)}</strong></div>
            <div class="hurricane-stat"><span>Magnitude</span><strong>${eqMag}</strong></div>
            <div class="hurricane-stat"><span>Distance</span><strong>${eqDistance}</strong></div>
            <div class="hurricane-stat"><span>Depth</span><strong>${eqDepth}</strong></div>
            <div class="hurricane-stat ${eqPrimary.tsunami === 1 ? "is-danger" : ""}"><span>Tsunami flag</span><strong>${eqTsunami}</strong></div>
          </div>
          <label class="hurricane-toggle">
            <input type="checkbox" data-wind-radii-toggle ${this._showWindRadii ? "checked" : ""} />
            Show wind radii
          </label>
          <button class="btn btn-secondary" data-hurricane-refresh style="margin-top:4px">Refresh</button>
          <div class="hurricane-stat" style="margin-top:4px"><span>Last updated</span><strong>${this._esc(fetchedAt)}</strong></div>
        </aside>`;

      const emptyBanner = storms.length === 0 && !summary.hasOutlookActivity
        ? `<div class="hurricane-map-empty-banner"><strong>No active tropical cyclones.</strong> NHC outlook updates every 6 hours.</div>`
        : storms.length === 0 && summary.hasOutlookActivity
          ? `<div class="hurricane-map-empty-banner"><strong>Tropical development possible.</strong> Disturbances and development areas are shown on the map.</div>`
          : "";

      const layoutClass = this._embedded ? "hurricane-layout is-embedded" : "hurricane-layout";
      this._root.innerHTML = `
        <section class="${layoutClass}">
          <div class="hurricane-map-wrap">
            <div id="hurricane-map" class="hurricane-map"></div>
            ${emptyBanner}
            ${statusPanel}
          </div>
        </section>`;
      this._renderMap();
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

      this._map = global.L.map(mapEl, {
        zoomControl: false,
        attributionControl: true,
      });
      global.L.tileLayer(DARK_TILE_URL, {
        maxZoom: 19,
        subdomains: "abcd",
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      }).addTo(this._map);
      global.L.control.zoom({ position: "bottomleft" }).addTo(this._map);
      this._layerGroup = global.L.layerGroup().addTo(this._map);
      this._mapInitialized = true;
      this._map.fitBounds(this._getUsaBounds(), { padding: [24, 24] });
      return mapEl;
    }

    _renderMap() {
      const storms = this._data?.storms || [];
      const outlook = this._data?.outlook || {};
      const home = this._data?.home;
      if (!this._ensureMap() || !this._map || !this._layerGroup) return;

      this._layerGroup.clearLayers();
      this._homeMarker = null;

      const bounds = [];

      this._drawOutlook(outlook, bounds);

      storms.forEach((storm, idx) => {
        const color = STORM_COLORS[idx % STORM_COLORS.length];
        this._drawStorm(storm, color, bounds);
      });

      this._drawTornadoWarnings(bounds);
      this._drawEarthquakes(bounds);

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

      this._fitMapView(bounds);
      setTimeout(() => this._map?.invalidateSize(), 100);
    }

    _fitMapView(stormBounds) {
      const usa = this._getUsaBounds();
      if (!this._map || !usa) return;

      if (stormBounds.length > 0) {
        const combined = global.L.latLngBounds(stormBounds).extend(usa);
        this._map.fitBounds(combined, { padding: [48, 48] });
      } else {
        this._map.fitBounds(usa, { padding: [24, 24] });
      }
    }

    _drawOutlook(outlook, bounds) {
      const L = global.L;
      if (!L || !outlook) return;

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
            if (label) layer.bindPopup(`<strong>Potential development</strong><br/>${label}`);
            const center = this._getFeatureCenterLatLng(feature);
            if (center) {
              const mapLabel = this._formatOutlookLabel(props, "Development area");
              this._addMapLabel(center[0], center[1], mapLabel, "hw-outlook-label");
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

      this._drawOutlookPoints(outlook.twoDayLocation, "#ffd54f", "2-day disturbance", bounds);
      this._drawOutlookPoints(outlook.sevenDayLocation, "#ff9800", "7-day disturbance", bounds);
    }

    _drawOutlookPoints(geo, color, title, bounds) {
      const L = global.L;
      if (!L || !geo?.features?.length) return;

      geo.features.forEach((feature) => {
        const geom = feature.geometry || {};
        const coords = geom.coordinates;
        if (!coords || coords.length < 2) return;
        const lon = coords[0];
        const lat = coords[1];
        const props = feature.properties || {};
        const marker = L.circleMarker([lat, lon], {
          radius: 7,
          color: "#fff",
          weight: 1,
          fillColor: color,
          fillOpacity: 0.95,
        }).addTo(this._layerGroup);
        const popup = [
          `<strong>${title}</strong>`,
          props.basin ? `Basin: ${this._esc(props.basin)}` : "",
          props.prob2day ? `2-day: ${this._esc(props.prob2day)}` : "",
          props.prob7day ? `7-day: ${this._esc(props.prob7day)}` : "",
          props.risk2day ? `2-day risk: ${this._esc(props.risk2day)}` : "",
          props.risk7day ? `7-day risk: ${this._esc(props.risk7day)}` : "",
        ].filter(Boolean).join("<br/>");
        marker.bindPopup(popup);
        const mapLabel = this._formatOutlookLabel(props, title);
        marker.bindTooltip(mapLabel, {
          permanent: true,
          direction: "top",
          className: "hw-outlook-label",
          offset: [0, -8],
        });
        bounds.push([lat, lon]);
      });
    }

    _drawStorm(storm, color, bounds) {
      const L = global.L;
      const labelInfo = this._formatStormLabel(storm);

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
        if (latlngs.length > 0) {
          const [trackLat, trackLon] = latlngs[latlngs.length - 1];
          L.marker([trackLat, trackLon], {
            icon: L.divIcon({
              className: "hw-map-label-anchor",
              html: `<div class="hw-storm-track-label" style="border-left:3px solid ${color}">${this._esc(labelInfo.name)}</div>`,
              iconSize: [0, 0],
              iconAnchor: [0, 0],
            }),
            interactive: false,
            zIndexOffset: 350,
          }).addTo(this._layerGroup);
        }
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
        if (hourLabel) {
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
        const metaHtml = labelInfo.meta
          ? `<span class="hw-storm-meta">${this._esc(labelInfo.meta)}</span>`
          : "";
        const stormIcon = L.divIcon({
          className: "hw-storm-marker",
          html: `
            <div class="hw-storm-marker-wrap" style="--storm-color:${color}">
              <div class="hw-storm-name">${this._esc(labelInfo.name)}${metaHtml}</div>
              <img class="hw-storm-icon" src="/local/home_weather/icons/hurricane.svg" width="32" height="32" alt="" />
            </div>
          `,
          iconSize: [32, 48],
          iconAnchor: [16, 40],
        });
        const popup = `
          <strong>${this._esc(storm.name)}</strong><br/>
          Advisory: ${this._esc(storm.advisoryTime || "—")}<br/>
          Max wind: ${storm.maxWindMph != null ? storm.maxWindMph + " mph" : "—"}<br/>
          Pressure: ${storm.pressureMb != null ? storm.pressureMb + " mb" : "—"}<br/>
          Movement: ${this._esc(storm.movement || "—")}<br/>
          Category: ${storm.category != null ? storm.category : "—"}
        `;
        L.marker([pos.lat, pos.lon], { icon: stormIcon, zIndexOffset: 500 })
          .bindPopup(popup)
          .addTo(this._layerGroup);
        bounds.push([pos.lat, pos.lon]);
      } else if (storm.cone) {
        const center = this._getFeatureCenterLatLng({ type: "Feature", geometry: storm.cone, properties: {} });
        if (center) {
          this._addMapLabel(center[0], center[1], labelInfo.name, "hw-storm-track-label");
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
            this._addMapLabel(center[0], center[1], "Tornado Warning", "hw-tornado-label");
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

    _drawEarthquakes(bounds) {
      const L = global.L;
      const geojson = this._earthquakeData?.geojson;
      if (!L || !geojson?.features?.length || !this._layerGroup) return;

      geojson.features.forEach((feature) => {
        const props = feature.properties || {};
        const coords = feature.geometry?.coordinates;
        if (!coords || coords.length < 2) return;
        const lon = coords[0];
        const lat = coords[1];
        const style = this._earthquakeMarkerStyle(props.mag, props.tsunami);
        const marker = L.circleMarker([lat, lon], {
          radius: style.radius,
          color: "#ffffff",
          weight: 2,
          fillColor: style.color,
          fillOpacity: 0.92,
          className: `hw-earthquake-marker${style.tsunami ? " is-tsunami" : ""}`,
        }).addTo(this._layerGroup);

        const popup = `
          <strong>M${props.mag != null ? props.mag : "?"} Earthquake</strong><br/>
          ${this._esc(props.place || "Unknown location")}<br/>
          Depth: ${props.depth_km != null ? Math.round(props.depth_km) + " km" : "—"}<br/>
          Distance: ${props.distance_miles != null ? Math.round(props.distance_miles) + " mi" : "—"}<br/>
          Time: ${this._esc(this._formatEarthquakeTime(props.time))}<br/>
          ${props.tsunami === 1 ? "Tsunami possible<br/>" : ""}
          ${props.url ? `<a href="${this._esc(props.url)}" target="_blank" rel="noopener noreferrer">USGS details</a>` : ""}
        `;
        marker.bindPopup(popup);
        if (style.tsunami) {
          L.circle([lat, lon], {
            radius: Math.max(25000, style.radius * 8000),
            color: "#03a9f4",
            weight: 2,
            fillColor: "#03a9f4",
            fillOpacity: 0.08,
            dashArray: "6 4",
          }).addTo(this._layerGroup);
        }
        const label = `M${props.mag != null ? props.mag : "?"}`;
        marker.bindTooltip(label, {
          permanent: true,
          direction: "top",
          className: "hw-earthquake-label",
          offset: [0, -style.radius],
        });
        bounds.push([lat, lon]);
      });
    }
  }

  global.HurricaneTracker = HurricaneTracker;
})(typeof window !== "undefined" ? window : globalThis);
