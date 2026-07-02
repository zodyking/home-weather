/**
 * Space Map — simplified Three.js solar system + NOAA sun weather view.
 */
(function (global) {
  const BODY_COLORS = {
    sun: 0xffcc33,
    planet: 0x60a5fa,
    dwarf_planet: 0xa78bfa,
    moon: 0x94a3b8,
    spacecraft: 0x34d399,
    asteroid: 0xf97316,
    comet: 0x22d3ee,
  };

  const BODY_SIZES = {
    sun: 1.6,
    planet: 0.42,
    dwarf_planet: 0.32,
    moon: 0.1,
    spacecraft: 0.12,
    asteroid: 0.07,
    comet: 0.09,
  };

  const LABEL_TYPES = new Set(["sun", "planet", "dwarf_planet", "spacecraft"]);

  class SpaceMap {
    constructor(options = {}) {
      this._hass = options.hass;
      this._shadowRoot = options.shadowRoot;
      this._root = options.root;
      this._mode = options.mode || "solar_system";
      this._layers = Object.assign({
        planets: true,
        dwarf_planets: true,
        moons: true,
        spacecraft: true,
        asteroids: true,
        comets: true,
      }, options.layers || {});
      this._logScale = options.logScale !== false;
      this._autoRotate = true;
      this._mapData = null;
      this._solarData = null;
      this._lastUpdated = null;
      this._renderer = null;
      this._scene = null;
      this._camera = null;
      this._animationId = null;
      this._bodyMeshes = [];
      this._raycaster = null;
      this._pointer = null;
      this._selectedBody = null;
      this._onResize = this._handleResize.bind(this);
      this._onPointerMove = this._handlePointerMove.bind(this);
      this._onClick = this._handleClick.bind(this);
    }

    getLastUpdated() {
      return this._lastUpdated;
    }

    setMode(mode) {
      this._mode = mode;
      this._renderShell();
      if (mode === "solar_system") {
        this._initThree();
        this.loadData();
      } else {
        this._destroyThree();
        this.loadData();
      }
    }

    setLayers(layers) {
      this._layers = Object.assign({}, this._layers, layers || {});
      if (this._mode === "solar_system") this._rebuildBodies();
    }

    setLogScale(enabled) {
      this._logScale = enabled !== false;
      if (this._mode === "solar_system") this._rebuildBodies();
    }

    async loadData() {
      if (!this._hass) return;
      try {
        const [mapPayload, solarPayload] = await Promise.all([
          this._hass.callWS({ type: "home_weather/get_space_map" }).catch(() => null),
          this._hass.callWS({ type: "home_weather/get_solar_weather" }).catch(() => null),
        ]);
        this._mapData = mapPayload || {};
        this._solarData = (solarPayload && solarPayload.solar_weather) || {};
        this._lastUpdated = mapPayload?.updated || solarPayload?.updated || null;
        if (this._mode === "solar_system") {
          this._rebuildBodies();
          this._updateEmptyState();
        } else {
          this._renderSunWeather();
        }
      } catch (err) {
        console.warn("[space-map] load failed", err);
      }
    }

    mount() {
      if (!this._root) return;
      this._renderShell();
      if (this._mode === "solar_system") {
        this._initThree();
      }
      this.loadData();
      window.addEventListener("resize", this._onResize);
    }

    destroy() {
      window.removeEventListener("resize", this._onResize);
      this._destroyThree();
      if (this._root) this._root.innerHTML = "";
    }

    _renderShell() {
      if (!this._root) return;
      if (this._mode === "sun_weather") {
        this._root.innerHTML = `
          <div class="space-map-page space-sun-page">
            <div class="space-sun-layout">
              <div class="space-sun-visual" id="space-sun-visual">
                <div class="space-sun-loading">Loading sun weather…</div>
              </div>
              <aside class="space-sun-sidebar" id="space-sun-sidebar"></aside>
            </div>
            <div class="space-info-card" id="space-info-card" hidden></div>
          </div>`;
        return;
      }
      this._root.innerHTML = `
        <div class="space-map-page">
          <div class="space-canvas-wrap" id="space-canvas-wrap">
            <div class="space-loading">Loading space map…</div>
          </div>
          <div class="space-info-card" id="space-info-card" hidden></div>
          <div class="space-controls">
            <button type="button" class="space-ctrl-btn" data-space-action="toggle-rotate" title="Pause rotation">⏸</button>
            <button type="button" class="space-ctrl-btn" data-space-action="reset-camera" title="Reset view">⟲</button>
          </div>
        </div>`;
      this._root.querySelector('[data-space-action="toggle-rotate"]')
        ?.addEventListener("click", () => {
          this._autoRotate = !this._autoRotate;
          const btn = this._root.querySelector('[data-space-action="toggle-rotate"]');
          if (btn) btn.textContent = this._autoRotate ? "⏸" : "▶";
        });
      this._root.querySelector('[data-space-action="reset-camera"]')
        ?.addEventListener("click", () => this._resetCamera());
    }

    _initThree() {
      this._destroyThree();
      const wrap = this._root?.querySelector("#space-canvas-wrap");
      if (!wrap || typeof THREE === "undefined" || !THREE.WebGLRenderer) {
        if (wrap) wrap.innerHTML = `<div class="space-error">Three.js failed to load.</div>`;
        return;
      }
      wrap.innerHTML = "";
      const width = Math.max(wrap.clientWidth || 0, 320);
      const height = Math.max(wrap.clientHeight || 0, 240);
      if (width < 10 || height < 10) {
        wrap.innerHTML = `<div class="space-loading">Preparing canvas…</div>`;
        requestAnimationFrame(() => this._initThree());
        return;
      }

      try {
      this._scene = new THREE.Scene();
      this._scene.background = new THREE.Color(0x000000);

      this._camera = new THREE.PerspectiveCamera(55, width / height, 0.01, 500);
      this._camera.position.set(0, 10, 18);
      this._camera.lookAt(0, 0, 0);
      this._raycaster = new THREE.Raycaster();
      this._pointer = new THREE.Vector2();

      this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this._renderer.setSize(width, height);
      wrap.appendChild(this._renderer.domElement);

      const ambient = new THREE.AmbientLight(0x445566, 0.55);
      this._scene.add(ambient);
      const sunLight = new THREE.PointLight(0xffdd88, 3.2, 200);
      sunLight.position.set(0, 0, 0);
      this._scene.add(sunLight);

      this._renderer.domElement.addEventListener("pointermove", this._onPointerMove);
      this._renderer.domElement.addEventListener("click", this._onClick);

      this._rebuildBodies();
      this._updateEmptyState();
      this._animate();
      } catch (err) {
        console.warn("[space-map] WebGL init failed", err);
        wrap.innerHTML = `<div class="space-error">WebGL is unavailable in this browser. Try Sun Weather mode from the View menu.</div>`;
      }
    }

    _destroyThree() {
      if (this._animationId) {
        cancelAnimationFrame(this._animationId);
        this._animationId = null;
      }
      if (this._renderer) {
        this._renderer.domElement.removeEventListener("pointermove", this._onPointerMove);
        this._renderer.domElement.removeEventListener("click", this._onClick);
        this._renderer.dispose();
        this._renderer = null;
      }
      this._bodyMeshes = [];
      this._scene = null;
      this._camera = null;
    }

    _scaleDistance(au) {
      const d = Math.max(0.001, Number(au) || 0.001);
      if (!this._logScale) return d * 2;
      return Math.log10(d * 10 + 1) * 3.2;
    }

    _layerVisible(type) {
      if (type === "sun" || type === "planet") return this._layers.planets !== false;
      if (type === "dwarf_planet") return this._layers.dwarf_planets !== false;
      if (type === "moon") return this._layers.moons !== false;
      if (type === "spacecraft") return this._layers.spacecraft !== false;
      if (type === "asteroid") return this._layers.asteroids !== false;
      if (type === "comet") return this._layers.comets !== false;
      return true;
    }

    _createLabel(text) {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = 256;
      canvas.height = 64;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = "600 22px system-ui, sans-serif";
      ctx.fillStyle = "#e2e8f0";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(text).slice(0, 18), 128, 32);
      const texture = new THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;
      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.scale.set(2.6, 0.65, 1);
      return sprite;
    }

    _updateEmptyState() {
      const wrap = this._root?.querySelector("#space-canvas-wrap");
      if (!wrap) return;
      let banner = wrap.querySelector(".space-empty-banner");
      const bodies = (this._mapData && this._mapData.bodies) || [];
      const small = (this._mapData && this._mapData.small_bodies) || [];
      const visibleCount = bodies.length + small.filter(
        (b) => b.position_available !== false && b.x_au != null,
      ).length;
      if (visibleCount > 0) {
        banner?.remove();
        return;
      }
      if (!banner) {
        banner = document.createElement("div");
        banner.className = "space-empty-banner";
        wrap.appendChild(banner);
      }
      banner.textContent = this._mapData?.updated
        ? "No space objects loaded yet. Try Refresh from the Actions menu."
        : "Loading solar system data…";
    }

    _rebuildBodies() {
      if (!this._scene) return;
      this._bodyMeshes.forEach((mesh) => {
        if (mesh.material) {
          if (mesh.material.map) mesh.material.map.dispose();
          mesh.material.dispose();
        }
        if (mesh.geometry) mesh.geometry.dispose();
        this._scene.remove(mesh);
      });
      this._bodyMeshes = [];
      const bodies = (this._mapData && this._mapData.bodies) || [];
      const small = (this._mapData && this._mapData.small_bodies) || [];
      const all = bodies.concat(
        small.filter((b) => b.position_available !== false && b.x_au != null)
      );

      all.forEach((body) => {
        const type = body.type || "planet";
        if (!this._layerVisible(type)) return;
        const x = type === "sun" ? 0 : this._scaleDistance(body.x_au);
        const y = type === "sun" ? 0 : (Number(body.z_au) || 0) * (this._logScale ? 0.4 : 2);
        const z = type === "sun" ? 0 : this._scaleDistance(body.y_au);
        const size = BODY_SIZES[type] || 0.15;
        const color = BODY_COLORS[type] || 0xffffff;
        const geo = new THREE.SphereGeometry(size, 20, 20);
        const mat = new THREE.MeshStandardMaterial({
          color,
          emissive: type === "sun" ? 0xffaa00 : 0x111111,
          emissiveIntensity: type === "sun" ? 1.4 : 0.08,
          metalness: type === "sun" ? 0 : 0.15,
          roughness: type === "sun" ? 0.35 : 0.7,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x, y, z);
        mesh.userData = body;
        this._scene.add(mesh);
        this._bodyMeshes.push(mesh);

        if (type === "sun") {
          const glowGeo = new THREE.SphereGeometry(size * 1.45, 20, 20);
          const glowMat = new THREE.MeshBasicMaterial({
            color: 0xffcc66,
            transparent: true,
            opacity: 0.14,
          });
          const glow = new THREE.Mesh(glowGeo, glowMat);
          glow.position.set(0, 0, 0);
          this._scene.add(glow);
          this._bodyMeshes.push(glow);
        }

        if (body.name && LABEL_TYPES.has(type)) {
          const label = this._createLabel(body.name);
          label.position.set(x, y + size + 0.28, z);
          this._scene.add(label);
          this._bodyMeshes.push(label);
        }

        if ((type === "planet" || type === "dwarf_planet") && x > 0.05) {
          const orbit = new THREE.RingGeometry(x * 0.985, x * 1.015, 96);
          const orbitMat = new THREE.MeshBasicMaterial({
            color: 0x334155,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.14,
          });
          const orbitMesh = new THREE.Mesh(orbit, orbitMat);
          orbitMesh.rotation.x = Math.PI / 2;
          this._scene.add(orbitMesh);
          this._bodyMeshes.push(orbitMesh);
        }
      });
      this._updateEmptyState();
    }

    _animate() {
      if (!this._renderer || !this._scene || !this._camera) return;
      if (this._autoRotate) {
        this._camera.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.0015);
        this._camera.lookAt(0, 0, 0);
      }
      this._renderer.render(this._scene, this._camera);
      this._animationId = requestAnimationFrame(() => this._animate());
    }

    _handleResize() {
      const wrap = this._root?.querySelector("#space-canvas-wrap");
      if (!wrap || !this._renderer || !this._camera) return;
      const width = wrap.clientWidth || 640;
      const height = wrap.clientHeight || 480;
      this._camera.aspect = width / height;
      this._camera.updateProjectionMatrix();
      this._renderer.setSize(width, height);
    }

    _resetCamera() {
      if (!this._camera) return;
      this._camera.position.set(0, 10, 18);
      this._camera.lookAt(0, 0, 0);
    }

    _handlePointerMove(event) {
      if (!this._renderer || !this._camera) return;
      const rect = this._renderer.domElement.getBoundingClientRect();
      this._pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this._pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }

    _handleClick() {
      if (!this._renderer || !this._camera || !this._scene) return;
      this._raycaster.setFromCamera(this._pointer, this._camera);
      const hits = this._raycaster.intersectObjects(this._bodyMeshes.filter((m) => m.userData?.name));
      if (!hits.length) {
        this._hideInfo();
        return;
      }
      this._showInfo(hits[0].object.userData);
    }

    _showInfo(body) {
      const card = this._root?.querySelector("#space-info-card");
      if (!card || !body) return;
      const dist = body.distance_au != null ? `${Number(body.distance_au).toFixed(3)} AU` : "—";
      const vel = body.velocity_kms != null ? `${Number(body.velocity_kms).toFixed(1)} km/s` : "—";
      card.hidden = false;
      card.innerHTML = `
        <div class="space-info-title">${this._esc(body.name || body.id)}</div>
        <div class="space-info-type">${this._esc(body.type || "object")}</div>
        <div class="space-info-row"><span>Distance</span><strong>${dist}</strong></div>
        <div class="space-info-row"><span>Velocity</span><strong>${vel}</strong></div>`;
    }

    _hideInfo() {
      const card = this._root?.querySelector("#space-info-card");
      if (card) card.hidden = true;
    }

    _renderSunWeather() {
      const visual = this._root?.querySelector("#space-sun-visual");
      const sidebar = this._root?.querySelector("#space-sun-sidebar");
      if (!visual || !sidebar) return;
      const sw = this._solarData || {};
      const images = sw.images || {};
      visual.innerHTML = `
        <div class="space-sun-disk-wrap">
          <img src="${images.sdo_hmi || ""}" alt="SDO HMI sun disk" class="space-sun-disk" loading="lazy"/>
        </div>
        <img src="${images.goes_xray || ""}" alt="GOES X-ray flux" class="space-sun-xray" loading="lazy"/>`;
      const regions = (sw.regions || []).slice(-8).reverse();
      sidebar.innerHTML = `
        <div class="space-sun-title">Sun Weather</div>
        <div class="space-sun-stat"><span>Sunspot #</span><strong>${sw.sunspot_number ?? "—"}</strong></div>
        <div class="space-sun-stat"><span>K-index</span><strong>${sw.k_index ?? "—"}</strong></div>
        <div class="space-sun-stat"><span>F10.7 flux</span><strong>${sw.f107_flux ?? "—"} sfu</strong></div>
        <div class="space-sun-stat"><span>X-ray class</span><strong>${sw.xray_class ?? "—"}</strong></div>
        <div class="space-sun-stat"><span>G-scale</span><strong>${sw.g_scale ?? 0}</strong></div>
        <div class="space-sun-regions">
          <div class="space-sun-subtitle">Active regions</div>
          ${regions.length ? regions.map((r) => `
            <div class="space-sun-region">${this._esc(r.region || r.number || "Region")} — ${this._esc(r.location || "")}</div>
          `).join("") : `<div class="space-sun-muted">No region data</div>`}
        </div>
        <a class="space-sun-attribution" href="https://www.swpc.noaa.gov/" target="_blank" rel="noopener noreferrer">${this._esc(sw.attribution || "NOAA SWPC")}</a>`;
    }

    _esc(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
  }

  global.SpaceMap = SpaceMap;
})(typeof window !== "undefined" ? window : globalThis);
