/**
 * Hurricane Tracker - Leaflet map for NOAA/NHC storm data.
 */
(function (global) {
  "use strict";

  const STORM_COLORS = ["#e53935", "#fb8c00", "#8e24aa", "#1e88e5", "#43a047"];
  const REFRESH_MS = 15 * 60 * 1000;
  // Contiguous United States bounds (default map view).
  const USA_BOUNDS = Object.freeze([
    [24.396308, -124.848974],
    [49.384358, -66.885444],
  ]);

  class HurricaneTracker {
    constructor(options) {
      this._hass = options.hass;
      this._shadow = options.shadowRoot;
      this._root = null;
      this._map = null;
      this._layerGroup = null;
      this._homeMarker = null;
      this._data = null;
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
        .hurricane-layout { display: flex; gap: 16px; padding: clamp(12px, 2vw, 18px); max-width: 1200px; margin: 0 auto; width: 100%; box-sizing: border-box; }
        .hurricane-map-wrap { flex: 1 1 60%; min-width: 0; position: relative; }
        .hurricane-map { width: 100%; min-height: 420px; height: 52vh; border-radius: var(--radius-lg, 12px); overflow: hidden; border: 1px solid var(--card-border, rgba(255,255,255,0.12)); background: var(--card-background-color, #1c1c1c); }
        .hurricane-map-empty-banner {
          position: absolute;
          top: 12px;
          left: 12px;
          right: 12px;
          z-index: 500;
          padding: 10px 14px;
          border-radius: 8px;
          font-size: 13px;
          line-height: 1.45;
          color: var(--secondary-text-color, #9b9b9b);
          background: rgba(17, 17, 17, 0.82);
          border: 1px solid rgba(255,255,255,0.12);
          pointer-events: none;
        }
        .hw-outlook-label { background: rgba(0,0,0,0.72); color: #ffb74d; border: none; border-radius: 4px; padding: 2px 6px; font-size: 10px; font-weight: 600; }
        .hurricane-status { flex: 0 0 280px; background: var(--card-background-color, #1c1c1c); border: 1px solid var(--card-border, rgba(255,255,255,0.12)); border-radius: var(--radius-lg, 12px); padding: 16px; display: flex; flex-direction: column; gap: 12px; }
        .hurricane-status.is-threat-high { border-color: rgba(244,67,54,0.55); box-shadow: 0 0 0 1px rgba(244,67,54,0.25); }
        .hurricane-status.is-threat-watch { border-color: rgba(255,152,0,0.45); }
        .hurricane-status h3 { margin: 0; font-size: 16px; font-weight: 600; color: var(--primary-text-color); }
        .hurricane-stat { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; color: var(--secondary-text-color); }
        .hurricane-stat strong { color: var(--primary-text-color); font-weight: 600; text-align: right; }
        .hurricane-stat.is-warning strong { color: #ff9800; }
        .hurricane-stat.is-danger strong { color: #f44336; }
        .hurricane-banner { padding: 10px 12px; border-radius: 8px; font-size: 12px; background: rgba(255,152,0,0.15); color: #ffb74d; border: 1px solid rgba(255,152,0,0.35); }
        .hurricane-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 48px 16px; color: var(--secondary-text-color); text-align: center; }
        .hurricane-toggle { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--secondary-text-color); cursor: pointer; }
        .hurricane-toggle input { accent-color: var(--panel-accent, #03a9f4); }
        .hurricane-loading { padding: 48px; text-align: center; color: var(--secondary-text-color); }
        .leaflet-container { font-family: inherit; background: #0d1117; }
        .hw-forecast-label { background: rgba(0,0,0,0.72); color: #fff; border: none; border-radius: 4px; padding: 2px 6px; font-size: 11px; font-weight: 600; }
        .hw-home-marker.in-cone { filter: drop-shadow(0 0 6px rgba(244,67,54,0.9)); animation: hw-pulse 1.5s ease-in-out infinite; }
        @keyframes hw-pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.08); } }
        @media (max-width: 768px) {
          .hurricane-layout { flex-direction: column; }
          .hurricane-status { flex: 1 1 auto; }
          .hurricane-map { height: 45vh; min-height: 320px; }
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
        const payload = await this._hass.callWS({
          type: "home_weather/get_hurricanes",
          force_refresh: !!forceRefresh,
        });
        this._data = payload;
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

    _renderError() {
      if (!this._root) return;
      this._root.innerHTML = `
        <section class="hurricane-layout">
          <div class="hurricane-empty" style="width:100%">
            <p>Failed to load hurricane data.</p>
            <p>${this._esc(this._error)}</p>
            <button class="btn btn-primary" data-hurricane-refresh>Retry</button>
          </div>
        </section>`;
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
          : summary.threatLevel === "watch"
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

      const statusPanel = `
        <aside class="hurricane-status ${threatClass}">
          <h3>Storm Status</h3>
          ${staleBanner}
          <div class="hurricane-stat"><span>Active storms</span><strong>${storms.length}</strong></div>
          <div class="hurricane-stat"><span>Closest storm</span><strong>${this._esc(summary.closestStormName || "—")}</strong></div>
          <div class="hurricane-stat"><span>Distance to center</span><strong>${this._fmtMiles(summary.distanceToCenterMiles)}</strong></div>
          <div class="hurricane-stat"><span>Nearest forecast point</span><strong>${this._fmtMiles(summary.distanceToNearestForecastMiles)}</strong></div>
          <div class="hurricane-stat ${insideClass}"><span>Home inside cone</span><strong>${insideText}</strong></div>
          <div class="hurricane-stat"><span>Closest approach</span><strong>${summary.estimatedClosestApproachHour != null ? summary.estimatedClosestApproachHour + "H" : "—"}</strong></div>
          <div class="hurricane-stat"><span>Threat level</span><strong>${this._esc(summary.threatLevel || "none")}</strong></div>
          <div class="hurricane-stat"><span>Last updated</span><strong>${this._esc(fetchedAt)}</strong></div>
          <label class="hurricane-toggle">
            <input type="checkbox" data-wind-radii-toggle ${this._showWindRadii ? "checked" : ""} />
            Show wind radii
          </label>
          <button class="btn btn-secondary" data-hurricane-refresh style="margin-top:4px">Refresh</button>
        </aside>`;

      const mapSection = `
        <div class="hurricane-map-wrap">
          <div id="hurricane-map" class="hurricane-map"></div>
          ${storms.length === 0
            ? `<div class="hurricane-map-empty-banner"><strong>No active tropical cyclones.</strong> Showing NHC outlook and development areas. Data updates every 6 hours (every 3 hours near landfall).</div>`
            : ""}
        </div>`;

      this._root.innerHTML = `
        <section class="hurricane-layout">
          ${mapSection}
          ${statusPanel}
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
        zoomControl: true,
        attributionControl: true,
      });
      global.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(this._map);
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

      if (home?.lat != null && home?.lon != null) {
        const insideCone = this._data?.summary?.insideCone;
        const homeIcon = global.L.divIcon({
          className: `hw-home-marker${insideCone ? " in-cone" : ""}`,
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
        this._map.fitBounds(combined, { padding: [32, 32] });
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
        bounds.push([lat, lon]);
      });
    }

    _drawStorm(storm, color, bounds) {
      const L = global.L;

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
        const label = pt.hour != null ? `${pt.hour}H` : "";
        const marker = L.circleMarker([pt.lat, pt.lon], {
          radius: 5,
          color: "#fff",
          weight: 1,
          fillColor: color,
          fillOpacity: 0.95,
        }).addTo(this._layerGroup);
        if (label) {
          marker.bindTooltip(label, {
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
        const stormIcon = L.divIcon({
          className: "hw-storm-marker",
          html: `<img src="/local/home_weather/icons/hurricane.svg" width="32" height="32" alt="" />`,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
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
      }
    }
  }

  global.HurricaneTracker = HurricaneTracker;
})(typeof window !== "undefined" ? window : globalThis);
