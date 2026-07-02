/**
 * Zone Editor - Interactive Leaflet map for configuring per-hazard alert
 * radii around the home location. Each hazard gets a color-coded circle
 * with a draggable edge handle; a side panel exposes enable, radius, and
 * zone-vs-bypass ("all data") controls.
 */
(function (global) {
  "use strict";

  const DARK_TILE_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
  const LIGHT_TILE_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
  const SAT_TILE_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const CARTO_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
  const ESRI_ATTR = 'Tiles &copy; <a href="https://www.esri.com/">Esri</a>';
  const MILES_TO_METERS = 1609.344;
  const EARTH_RADIUS_MILES = 3958.8;

  const HAZARDS = [
    {
      key: "hurricane",
      configKey: "hurricane_monitoring",
      radiusKey: "max_distance_miles",
      label: "Hurricane",
      icon: "hurricane",
      color: "#29b6f6",
      min: 1,
      max: 5000,
      hint: "Storms within this radius drive hurricane sensors and alerts.",
    },
    {
      key: "tornado",
      configKey: "tornado_monitoring",
      radiusKey: "max_distance_miles",
      label: "Tornado",
      icon: "tornado",
      color: "#e040fb",
      min: 1,
      max: 500,
      hint: "Warning polygons within this radius trigger tornado sensors.",
    },
    {
      key: "earthquake",
      configKey: "earthquake_monitoring",
      radiusKey: "radius_miles",
      label: "Earthquake",
      icon: "earthquake",
      color: "#ffa726",
      min: 1,
      max: 5000,
      hint: "Quakes inside this radius count as nearby for sensors.",
    },
    {
      key: "lightning",
      configKey: "lightning_monitoring",
      radiusKey: "geofield_radius_miles",
      label: "Lightning",
      icon: "lightning-bolt",
      color: "#ffee58",
      min: 1,
      max: 500,
      hint: "Live strikes inside this radius feed lightning sensors.",
    },
    {
      key: "volcano",
      configKey: "volcano_monitoring",
      radiusKey: "radius_miles",
      label: "Volcano",
      icon: "volcano",
      color: "#ff7043",
      min: 1,
      max: 5000,
      hint: "Active volcanoes inside this radius count as nearby for sensors.",
    },
  ];

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function haversineMiles(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return EARTH_RADIUS_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /** Destination point given start, bearing (deg), and distance (miles). */
  function destinationPoint(lat, lon, bearingDeg, distanceMiles) {
    const delta = distanceMiles / EARTH_RADIUS_MILES;
    const theta = bearingDeg * Math.PI / 180;
    const phi1 = lat * Math.PI / 180;
    const lambda1 = lon * Math.PI / 180;
    const phi2 = Math.asin(
      Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta)
    );
    const lambda2 = lambda1 + Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
    );
    return {
      lat: phi2 * 180 / Math.PI,
      lon: ((lambda2 * 180 / Math.PI) + 540) % 360 - 180,
    };
  }

  function bearingDegrees(lat1, lon1, lat2, lon2) {
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const dLambda = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(dLambda) * Math.cos(phi2);
    const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }

  class ZoneEditor {
    constructor(options) {
      this._hass = options.hass;
      this._shadow = options.shadowRoot;
      this._home = options.home || { lat: 39.8283, lon: -98.5795 }; // Center of contiguous US
      this._settings = options.settings || {};
      this._onSave = options.onSave || (() => {});
      this._onClose = options.onClose || (() => {});
      this._root = null;
      this._map = null;
      this._circles = {};
      this._handles = {};
      this._handleBearings = {};
      this._state = {};
      this._original = {};
      this._selected = null;
      this._saving = false;
      this._panelCollapsed = false;
      this._layoutObserver = null;
      this._initState();
    }

    _initState() {
      HAZARDS.forEach((hazard) => {
        const block = this._settings[hazard.configKey]
          || this._settings[hazard.key === "earthquake" ? "earthquakes" : hazard.key]
          || {};
        const radiusRaw = Number(block[hazard.radiusKey]);
        const defaults = { hurricane: 500, tornado: 25, earthquake: 500, lightning: 100, volcano: 500 };
        const radius = Number.isFinite(radiusRaw) && radiusRaw > 0
          ? clamp(radiusRaw, hazard.min, hazard.max)
          : defaults[hazard.key];
        this._state[hazard.key] = {
          enabled: block.enabled !== false,
          zone_mode: block.zone_mode === "all" ? "all" : "zone",
          radius,
        };
        this._original[hazard.key] = { ...this._state[hazard.key] };
      });
    }

    isDirty() {
      return HAZARDS.some((hazard) => {
        const a = this._state[hazard.key];
        const b = this._original[hazard.key];
        return a.enabled !== b.enabled || a.zone_mode !== b.zone_mode || Math.round(a.radius) !== Math.round(b.radius);
      });
    }

    buildPatch() {
      const patch = {};
      HAZARDS.forEach((hazard) => {
        const existing = this._settings[hazard.configKey] || {};
        const state = this._state[hazard.key];
        patch[hazard.configKey] = {
          ...existing,
          enabled: state.enabled,
          zone_mode: state.zone_mode,
          [hazard.radiusKey]: Math.round(clamp(state.radius, hazard.min, hazard.max)),
        };
      });
      return patch;
    }

    async init(rootEl) {
      this._root = rootEl;
      this._injectStyles();
      this._root.innerHTML = `<div class="hw-zone-loading">Loading zone editor…</div>`;
      await this._ensureDeps();
      if (!this._root) return;
      this._renderShell();
      this._initMap();
      this._bindPanel();
      this._bindLayoutObserver();
      this._syncPanelLayout();
      this._syncPanelDom();
    }

    destroy() {
      this._layoutObserver?.disconnect();
      this._layoutObserver = null;
      if (this._map) {
        this._map.remove();
        this._map = null;
      }
      this._circles = {};
      this._handles = {};
      this._root = null;
    }

    invalidateMapSize() {
      this._map?.invalidateSize?.();
    }

    _isCompactLayout() {
      const width = this._root?.clientWidth ?? global.innerWidth ?? 1024;
      return width <= 768;
    }

    async _ensureDeps() {
      await this._loadStylesheet("https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css");
      await this._loadScript("https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js", "L");
    }

    _loadStylesheet(href) {
      return new Promise((resolve) => {
        if (document.querySelector(`link[href="${href}"]`)) {
          resolve();
          return;
        }
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        link.onload = () => resolve();
        link.onerror = () => resolve();
        document.head.appendChild(link);
      });
    }

    _loadScript(src, globalName) {
      const SCRIPT_TIMEOUT_MS = 15000;
      return new Promise((resolve, reject) => {
        if (globalName && global[globalName]) {
          resolve();
          return;
        }
        let settled = false;
        const finish = (fn, arg) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(arg);
        };
        const timer = setTimeout(() => {
          finish(reject, new Error(`Timed out loading ${src}`));
        }, SCRIPT_TIMEOUT_MS);
        const existing = document.querySelector(`script[src="${src}"]`);
        if (existing) {
          existing.addEventListener("load", () => finish(resolve), { once: true });
          existing.addEventListener("error", () => finish(reject, new Error(`Failed to load ${src}`)), { once: true });
          if (globalName && global[globalName]) finish(resolve);
          return;
        }
        const script = document.createElement("script");
        script.src = src;
        script.onload = () => finish(resolve);
        script.onerror = () => finish(reject, new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
      });
    }

    _injectStyles() {
      if (this._shadow.querySelector("#zone-editor-styles")) return;
      const style = document.createElement("style");
      style.id = "zone-editor-styles";
      style.textContent = `
        .hw-zone-layout {
          position: relative;
          width: 100%;
          height: 100%;
          min-height: 320px;
          overflow: hidden;
          border-radius: inherit;
        }
        .hw-zone-loading {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          min-height: 240px;
          color: #9b9b9b;
        }
        .hw-zone-map {
          position: absolute;
          inset: 0;
          background: #111;
        }
        .hw-zone-map .leaflet-container {
          width: 100%;
          height: 100%;
          font-family: inherit;
          background: #111111;
        }
        .hw-zone-panel {
          position: absolute;
          top: 12px;
          right: 12px;
          z-index: 800;
          width: 300px;
          max-height: calc(100% - 24px);
          display: flex;
          flex-direction: column;
          background: rgba(17, 20, 28, 0.94);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 12px;
          box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(10px);
          color: #e1e1e1;
          overflow: hidden;
        }
        .hw-zone-panel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 12px 14px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          cursor: default;
        }
        .hw-zone-panel-title {
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        .hw-zone-panel-sub {
          font-size: 11px;
          color: #9b9b9b;
          margin-top: 2px;
        }
        .hw-zone-panel-toggle {
          display: none;
          background: none;
          border: none;
          color: #9b9b9b;
          cursor: pointer;
          padding: 4px;
          border-radius: 6px;
          transition: transform 0.2s ease;
        }
        .hw-zone-panel-toggle:hover { color: #fff; }
        .hw-zone-panel-body {
          overflow-y: auto;
          padding: 8px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .hw-zone-row {
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 10px;
          background: rgba(28, 28, 28, 0.6);
          padding: 10px 12px;
          cursor: pointer;
          transition: border-color 0.15s ease, background 0.15s ease;
        }
        .hw-zone-row:hover { border-color: rgba(255, 255, 255, 0.2); }
        .hw-zone-row.is-selected {
          border-color: var(--hazard-color, #03a9f4);
          background: rgba(40, 40, 40, 0.8);
        }
        .hw-zone-row.is-disabled { opacity: 0.55; }
        .hw-zone-row-head {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .hw-zone-dot {
          width: 12px;
          height: 12px;
          border-radius: 50%;
          flex-shrink: 0;
          box-shadow: 0 0 0 2px rgba(255,255,255,0.15);
        }
        .hw-zone-row-label {
          font-size: 13px;
          font-weight: 600;
          flex: 1;
        }
        .hw-zone-radius-badge {
          font-size: 11px;
          font-variant-numeric: tabular-nums;
          color: #cfd8dc;
          background: rgba(255,255,255,0.08);
          padding: 2px 8px;
          border-radius: 999px;
          white-space: nowrap;
        }
        .hw-zone-switch {
          position: relative;
          display: inline-block;
          width: 34px;
          height: 20px;
          flex-shrink: 0;
        }
        .hw-zone-switch input { opacity: 0; width: 0; height: 0; }
        .hw-zone-switch .hw-zone-slider {
          position: absolute;
          inset: 0;
          background: rgba(255,255,255,0.18);
          border-radius: 999px;
          transition: background 0.15s ease;
        }
        .hw-zone-switch .hw-zone-slider::before {
          content: "";
          position: absolute;
          width: 14px;
          height: 14px;
          left: 3px;
          top: 3px;
          background: #fff;
          border-radius: 50%;
          transition: transform 0.15s ease;
        }
        .hw-zone-switch input:checked + .hw-zone-slider { background: #03a9f4; }
        .hw-zone-switch input:checked + .hw-zone-slider::before { transform: translateX(14px); }
        .hw-zone-switch input:focus-visible + .hw-zone-slider { outline: 2px solid #03a9f4; outline-offset: 2px; }
        .hw-zone-row-body {
          display: none;
          margin-top: 10px;
          flex-direction: column;
          gap: 10px;
        }
        .hw-zone-row.is-selected .hw-zone-row-body { display: flex; }
        .hw-zone-field {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .hw-zone-field-label {
          font-size: 12px;
          color: #9b9b9b;
        }
        .hw-zone-radius-input {
          width: 88px;
          background: rgba(0,0,0,0.35);
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 8px;
          color: #e1e1e1;
          font-size: 13px;
          font-variant-numeric: tabular-nums;
          padding: 6px 8px;
          text-align: right;
        }
        .hw-zone-radius-input:focus {
          outline: none;
          border-color: #03a9f4;
        }
        .hw-zone-mode {
          display: flex;
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 8px;
          overflow: hidden;
        }
        .hw-zone-mode button {
          flex: 1;
          background: none;
          border: none;
          color: #9b9b9b;
          font-size: 11px;
          font-weight: 600;
          padding: 6px 8px;
          cursor: pointer;
          min-height: 30px;
          transition: background 0.15s ease, color 0.15s ease;
        }
        .hw-zone-mode button + button { border-left: 1px solid rgba(255,255,255,0.14); }
        .hw-zone-mode button.active {
          background: rgba(3, 169, 244, 0.22);
          color: #e1f5fe;
        }
        .hw-zone-mode button:focus-visible { outline: 2px solid #03a9f4; outline-offset: -2px; }
        .hw-zone-hint {
          font-size: 11px;
          color: #78909c;
          line-height: 1.4;
        }
        .hw-zone-bypass-note {
          font-size: 11px;
          color: #ffb74d;
          line-height: 1.4;
        }
        .hw-zone-panel-footer {
          display: flex;
          gap: 8px;
          padding: 10px 12px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
        }
        .hw-zone-btn {
          flex: 1;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.14);
          background: rgba(255,255,255,0.06);
          color: #e1e1e1;
          font-size: 13px;
          font-weight: 600;
          padding: 9px 12px;
          min-height: 40px;
          cursor: pointer;
          transition: background 0.15s ease;
        }
        .hw-zone-btn:hover { background: rgba(255,255,255,0.12); }
        .hw-zone-btn:focus-visible { outline: 2px solid #03a9f4; outline-offset: 2px; }
        .hw-zone-btn--primary {
          background: #03a9f4;
          border-color: #03a9f4;
          color: #04212e;
        }
        .hw-zone-btn--primary:hover { background: #29b6f6; }
        .hw-zone-btn:disabled { opacity: 0.5; cursor: default; }
        .hw-zone-handle {
          cursor: ew-resize;
        }
        .hw-zone-handle-dot {
          width: 18px;
          height: 18px;
          border-radius: 50%;
          border: 3px solid #fff;
          background: var(--hazard-color, #03a9f4);
          box-shadow: 0 2px 8px rgba(0,0,0,0.6);
          box-sizing: border-box;
        }
        .hw-zone-radius-tip {
          background: rgba(2, 136, 209, 0.92);
          color: #fff;
          border: none;
          border-radius: 6px;
          padding: 3px 8px;
          font-size: 12px;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        }
        .hw-zone-radius-tip::before { display: none; }
        .hw-zone-home-marker img { filter: drop-shadow(0 2px 4px rgba(0,0,0,0.6)); }
        .hw-zone-map .leaflet-control-zoom a {
          background: rgba(28, 28, 28, 0.92);
          color: #e1e1e1;
          border-color: rgba(255,255,255,0.12);
        }
        .hw-zone-map .leaflet-control-zoom a:hover {
          background: rgba(40, 40, 40, 0.96);
          color: #fff;
        }
        .hw-zone-map .leaflet-bar {
          border: 1px solid rgba(255,255,255,0.12);
          box-shadow: 0 4px 16px rgba(0,0,0,0.35);
        }
        .hw-zone-map .leaflet-control-attribution {
          background: rgba(17, 17, 17, 0.72) !important;
          color: #9b9b9b !important;
        }
        .hw-zone-map .leaflet-control-attribution a { color: #90caf9 !important; }
        .hw-zone-map .leaflet-control-layers {
          background: rgba(17, 20, 28, 0.92);
          color: #cfd8dc;
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 8px;
        }
        .hw-zone-map .leaflet-control-layers-toggle { background-color: rgba(28, 28, 28, 0.92); }
        @media (max-width: 768px) {
          .hw-zone-panel {
            top: auto;
            right: 8px;
            left: 8px;
            bottom: max(8px, env(safe-area-inset-bottom, 0px));
            width: auto;
            max-height: min(52vh, 420px);
          }
          .hw-zone-panel-toggle { display: inline-flex; }
          .hw-zone-panel.is-collapsed .hw-zone-panel-body,
          .hw-zone-panel.is-collapsed .hw-zone-panel-footer { display: none; }
          .hw-zone-panel.is-collapsed .hw-zone-panel-toggle { transform: rotate(180deg); }
          .hw-zone-layout .leaflet-bottom.leaflet-left {
            left: auto;
            right: 10px;
            bottom: max(10px, env(safe-area-inset-bottom, 0px));
          }
          .hw-zone-layout.panel-expanded .leaflet-bottom.leaflet-left {
            bottom: calc(min(52vh, 420px) + 18px);
          }
          .hw-zone-layout.panel-expanded .leaflet-top.leaflet-left {
            bottom: calc(min(52vh, 420px) + 18px);
            top: auto;
          }
        }
      `;
      this._shadow.appendChild(style);
    }

    _renderShell() {
      const rows = HAZARDS.map((hazard) => {
        const state = this._state[hazard.key];
        return `
          <div class="hw-zone-row ${state.enabled ? "" : "is-disabled"}" data-zone-hazard="${hazard.key}" style="--hazard-color:${hazard.color}">
            <div class="hw-zone-row-head">
              <span class="hw-zone-dot" style="background:${hazard.color}"></span>
              <span class="hw-zone-row-label">${hazard.label}</span>
              <span class="hw-zone-radius-badge" data-zone-badge="${hazard.key}"></span>
              <label class="hw-zone-switch" title="Enable ${hazard.label} monitoring" aria-label="Enable ${hazard.label} monitoring">
                <input type="checkbox" data-zone-enabled="${hazard.key}" ${state.enabled ? "checked" : ""}/>
                <span class="hw-zone-slider"></span>
              </label>
            </div>
            <div class="hw-zone-row-body">
              <div class="hw-zone-field">
                <span class="hw-zone-field-label">Radius (miles)</span>
                <input type="number" class="hw-zone-radius-input" data-zone-radius="${hazard.key}"
                  min="${hazard.min}" max="${hazard.max}" step="1" value="${Math.round(state.radius)}"
                  aria-label="${hazard.label} radius in miles"/>
              </div>
              <div class="hw-zone-mode" role="group" aria-label="${hazard.label} zone mode">
                <button type="button" data-zone-mode="${hazard.key}" data-mode="zone" class="${state.zone_mode === "zone" ? "active" : ""}">Use zone</button>
                <button type="button" data-zone-mode="${hazard.key}" data-mode="all" class="${state.zone_mode === "all" ? "active" : ""}">Show all data</button>
              </div>
              <div class="hw-zone-bypass-note" data-zone-note="${hazard.key}" style="display:none">
                Zone bypassed — sensors report all ${hazard.label.toLowerCase()} data regardless of distance.
              </div>
              <div class="hw-zone-hint">${hazard.hint} Drag the handle on the circle edge to resize.</div>
            </div>
          </div>`;
      }).join("");

      const layoutClass = this._isCompactLayout() && !this._panelCollapsed ? " panel-expanded" : "";
      this._root.innerHTML = `
        <div class="hw-zone-layout${layoutClass}">
          <div class="hw-zone-map" id="hw-zone-map"></div>
          <aside class="hw-zone-panel ${this._isCompactLayout() && this._panelCollapsed ? "is-collapsed" : ""}">
            <div class="hw-zone-panel-header">
              <div>
                <div class="hw-zone-panel-title">Alert zones</div>
                <div class="hw-zone-panel-sub">Radius around home per hazard</div>
              </div>
              <button type="button" class="hw-zone-panel-toggle" aria-label="Collapse panel">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>
              </button>
            </div>
            <div class="hw-zone-panel-body">${rows}</div>
            <div class="hw-zone-panel-footer">
              <button type="button" class="hw-zone-btn" data-zone-action="cancel">Cancel</button>
              <button type="button" class="hw-zone-btn hw-zone-btn--primary" data-zone-action="save">Save zones</button>
            </div>
          </aside>
        </div>`;
    }

    _safeFitCircle(circle, padding = [40, 40]) {
      if (!this._map || !circle) return;
      try {
        const bounds = circle.getBounds();
        if (bounds?.isValid?.()) {
          this._map.fitBounds(bounds, { padding });
          return;
        }
      } catch {
        /* Leaflet Circle.getBounds() can fail before map projection is ready */
      }
      this._map.setView([this._home.lat, this._home.lon], 8);
    }

    _syncPanelLayout() {
      const layout = this._root?.querySelector(".hw-zone-layout");
      const panel = this._root?.querySelector(".hw-zone-panel");
      if (!layout || !panel) return;
      const expanded = this._isCompactLayout() && !this._panelCollapsed;
      layout.classList.toggle("panel-expanded", expanded);
      panel.classList.toggle("is-collapsed", this._isCompactLayout() && this._panelCollapsed);
    }

    _initMap() {
      const L = global.L;
      const mapEl = this._root.querySelector("#hw-zone-map");
      if (!L || !mapEl) return;

      const home = this._home;
      this._map = L.map(mapEl, {
        zoomControl: true,
        attributionControl: true,
        center: [home.lat, home.lon],
        zoom: 8,
      });
      const baseLayers = {
        Dark: L.tileLayer(DARK_TILE_URL, { maxZoom: 19, subdomains: "abcd", attribution: CARTO_ATTR }),
        Light: L.tileLayer(LIGHT_TILE_URL, { maxZoom: 19, subdomains: "abcd", attribution: CARTO_ATTR }),
        Satellite: L.tileLayer(SAT_TILE_URL, { maxZoom: 19, attribution: ESRI_ATTR }),
      };
      baseLayers.Dark.addTo(this._map);
      L.control.layers(baseLayers, null, { position: "topleft" }).addTo(this._map);
      L.control.scale({ imperial: true, metric: false }).addTo(this._map);

      const homeIcon = L.divIcon({
        className: "hw-zone-home-marker",
        html: `<img src="/local/home_weather/icons/home.svg" width="28" height="28" alt="Home" />`,
        iconSize: [28, 28],
        iconAnchor: [14, 28],
      });
      L.marker([home.lat, home.lon], { icon: homeIcon, zIndexOffset: 1000 })
        .bindPopup("<strong>Home</strong>")
        .addTo(this._map);

      HAZARDS.forEach((hazard, i) => {
        this._handleBearings[hazard.key] = 45 + i * 90;
        this._createHazardLayers(hazard);
      });

      this._map.invalidateSize();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!this._map) return;
          this._map.invalidateSize();
          this._fitToZones();
        });
      });
    }

    _createHazardLayers(hazard) {
      const L = global.L;
      const state = this._state[hazard.key];
      const home = this._home;

      const circle = L.circle([home.lat, home.lon], {
        radius: state.radius * MILES_TO_METERS,
        color: hazard.color,
        weight: 2,
        opacity: 0.85,
        fillColor: hazard.color,
        fillOpacity: 0.08,
      }).addTo(this._map);
      circle.on("click", () => this._selectHazard(hazard.key));
      this._circles[hazard.key] = circle;

      const bearing = this._handleBearings[hazard.key];
      const pos = destinationPoint(home.lat, home.lon, bearing, state.radius);
      const handleIcon = L.divIcon({
        className: "hw-zone-handle",
        html: `<div class="hw-zone-handle-dot" style="--hazard-color:${hazard.color}"></div>`,
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
      const handle = L.marker([pos.lat, pos.lon], {
        icon: handleIcon,
        draggable: true,
        zIndexOffset: 900,
        keyboard: false,
        title: `${hazard.label} radius handle`,
      }).addTo(this._map);

      handle.bindTooltip("", {
        permanent: false,
        direction: "top",
        offset: [0, -10],
        className: "hw-zone-radius-tip",
      });

      handle.on("dragstart", () => {
        this._selectHazard(hazard.key, { fit: false });
        handle.openTooltip();
      });
      handle.on("drag", () => {
        const at = handle.getLatLng();
        const dist = haversineMiles(home.lat, home.lon, at.lat, at.lng);
        const clamped = clamp(dist, hazard.min, hazard.max);
        this._handleBearings[hazard.key] = bearingDegrees(home.lat, home.lon, at.lat, at.lng);
        this._state[hazard.key].radius = clamped;
        this._circles[hazard.key].setRadius(clamped * MILES_TO_METERS);
        handle.setTooltipContent(`${Math.round(clamped)} mi`);
        this._syncPanelDom({ skipRadiusInputFocus: true });
      });
      handle.on("dragend", () => {
        this._positionHandle(hazard.key);
        handle.closeTooltip();
        this._syncPanelDom();
      });

      this._handles[hazard.key] = handle;
      this._applyHazardStyle(hazard.key);
    }

    _positionHandle(key) {
      const handle = this._handles[key];
      if (!handle) return;
      const home = this._home;
      const state = this._state[key];
      const bearing = this._handleBearings[key];
      const pos = destinationPoint(home.lat, home.lon, bearing, state.radius);
      handle.setLatLng([pos.lat, pos.lon]);
    }

    _applyHazardStyle(key) {
      const hazard = HAZARDS.find((h) => h.key === key);
      const state = this._state[key];
      const circle = this._circles[key];
      const handle = this._handles[key];
      if (!hazard || !circle || !handle) return;

      if (!state.enabled) {
        circle.setStyle({ opacity: 0, fillOpacity: 0 });
        handle.getElement()?.style.setProperty("display", "none");
        return;
      }
      handle.getElement()?.style.removeProperty("display");

      const selected = this._selected === key;
      if (state.zone_mode === "all") {
        circle.setStyle({
          opacity: selected ? 0.6 : 0.35,
          fillOpacity: 0.02,
          dashArray: "6 8",
          weight: selected ? 3 : 2,
        });
      } else {
        circle.setStyle({
          opacity: selected ? 1 : 0.85,
          fillOpacity: selected ? 0.14 : 0.08,
          dashArray: null,
          weight: selected ? 3 : 2,
        });
      }
      if (selected) circle.bringToFront();
    }

    _selectHazard(key, { fit = true } = {}) {
      this._selected = key;
      HAZARDS.forEach((hazard) => this._applyHazardStyle(hazard.key));
      this._syncPanelDom();
      if (fit && this._circles[key] && this._state[key].enabled) {
        this._safeFitCircle(this._circles[key]);
      }
    }

    _fitToZones() {
      if (!this._map) return;
      const enabled = HAZARDS.filter((h) => this._state[h.key].enabled);
      if (!enabled.length) {
        this._map.setView([this._home.lat, this._home.lon], 8);
        return;
      }
      // Fit to the smallest enabled zone so nearby zones stay usable.
      const smallest = enabled.reduce((acc, h) => (
        this._state[h.key].radius < this._state[acc.key].radius ? h : acc
      ));
      const circle = this._circles[smallest.key];
      if (circle) this._safeFitCircle(circle);
    }

    _bindPanel() {
      const root = this._root;
      const panel = root.querySelector(".hw-zone-panel");

      panel.querySelector(".hw-zone-panel-toggle")?.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._panelCollapsed = !this._panelCollapsed;
        this._syncPanelLayout();
        requestAnimationFrame(() => this._map?.invalidateSize?.());
      });

      root.querySelectorAll(".hw-zone-row").forEach((row) => {
        const key = row.getAttribute("data-zone-hazard");
        row.addEventListener("click", (ev) => {
          if (ev.target.closest("input, button, label")) return;
          this._selectHazard(key);
        });
      });

      root.querySelectorAll("[data-zone-enabled]").forEach((input) => {
        const key = input.getAttribute("data-zone-enabled");
        input.addEventListener("change", () => {
          this._state[key].enabled = input.checked;
          this._applyHazardStyle(key);
          this._syncPanelDom();
        });
      });

      root.querySelectorAll("[data-zone-radius]").forEach((input) => {
        const key = input.getAttribute("data-zone-radius");
        const hazard = HAZARDS.find((h) => h.key === key);
        const commit = () => {
          const raw = parseInt(input.value, 10);
          if (!Number.isFinite(raw)) {
            input.value = String(Math.round(this._state[key].radius));
            return;
          }
          const clamped = clamp(raw, hazard.min, hazard.max);
          this._state[key].radius = clamped;
          input.value = String(clamped);
          this._circles[key]?.setRadius(clamped * MILES_TO_METERS);
          this._positionHandle(key);
          this._syncPanelDom({ skipRadiusInputFocus: true });
        };
        input.addEventListener("change", commit);
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            commit();
            input.blur();
          }
        });
      });

      root.querySelectorAll("[data-zone-mode]").forEach((btn) => {
        const key = btn.getAttribute("data-zone-mode");
        const mode = btn.getAttribute("data-mode");
        btn.addEventListener("click", () => {
          this._state[key].zone_mode = mode;
          this._applyHazardStyle(key);
          this._syncPanelDom();
        });
      });

      root.querySelector('[data-zone-action="cancel"]')?.addEventListener("click", () => {
        this._onClose();
      });
      root.querySelector('[data-zone-action="save"]')?.addEventListener("click", async () => {
        if (this._saving) return;
        this._saving = true;
        this._syncPanelDom();
        try {
          await this._onSave(this.buildPatch());
        } finally {
          this._saving = false;
          this._syncPanelDom();
        }
      });
    }

    _bindLayoutObserver() {
      if (this._layoutObserver || !this._root) return;
      this._layoutObserver = new ResizeObserver(() => {
        this._syncPanelLayout();
        this._map?.invalidateSize?.();
      });
      this._layoutObserver.observe(this._root);
    }

    _syncPanelDom({ skipRadiusInputFocus = false } = {}) {
      const root = this._root;
      if (!root) return;
      HAZARDS.forEach((hazard) => {
        const key = hazard.key;
        const state = this._state[key];
        const row = root.querySelector(`.hw-zone-row[data-zone-hazard="${key}"]`);
        if (!row) return;
        row.classList.toggle("is-selected", this._selected === key);
        row.classList.toggle("is-disabled", !state.enabled);

        const badge = row.querySelector(`[data-zone-badge="${key}"]`);
        if (badge) {
          badge.textContent = state.zone_mode === "all"
            ? "All data"
            : `${Math.round(state.radius)} mi`;
        }

        const input = row.querySelector(`[data-zone-radius="${key}"]`);
        if (input && !(skipRadiusInputFocus && root.getRootNode()?.activeElement === input)) {
          input.value = String(Math.round(state.radius));
        }

        row.querySelectorAll(`[data-zone-mode="${key}"]`).forEach((btn) => {
          btn.classList.toggle("active", btn.getAttribute("data-mode") === state.zone_mode);
        });

        const note = row.querySelector(`[data-zone-note="${key}"]`);
        if (note) note.style.display = state.zone_mode === "all" ? "" : "none";
      });

      const saveBtn = root.querySelector('[data-zone-action="save"]');
      if (saveBtn) {
        saveBtn.disabled = this._saving;
        saveBtn.textContent = this._saving ? "Saving…" : (this.isDirty() ? "Save zones" : "Save zones");
      }
    }
  }

  global.ZoneEditor = ZoneEditor;
})(window);
