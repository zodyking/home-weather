/**
 * Space Map — interactive top-down solar system + NOAA sun weather view.
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

  const PLANET_COLORS = {
    Mercury: 0x9ca3af,
    Venus: 0xe8cda0,
    Earth: 0x3b82f6,
    Mars: 0xc14436,
    Jupiter: 0xd4a574,
    Saturn: 0xe8d5a3,
    Uranus: 0x7dd3fc,
    Neptune: 0x6366f1,
    Pluto: 0xbfa094,
    Sun: 0xffdd44,
  };

  const BODY_SIZES = {
    sun: 1.85,
    planet: 0.44,
    dwarf_planet: 0.34,
    moon: 0.1,
    spacecraft: 0.12,
    asteroid: 0.07,
    comet: 0.09,
  };

  const LABEL_TYPES = new Set(["sun", "planet", "dwarf_planet", "spacecraft"]);

  /** Top-down pan + zoom camera controller (no OrbitControls dependency). */
  class SpaceViewport {
    constructor(camera, domElement) {
      this.camera = camera;
      this.dom = domElement;
      this.targetX = 0;
      this.targetZ = 0;
      this.baseHeight = 28;
      this.zoom = 1;
      this.minZoom = 0.35;
      this.maxZoom = 6;
      this._dragging = false;
      this._moved = false;
      this._lastX = 0;
      this._lastY = 0;
      this._onPointerDown = this._handlePointerDown.bind(this);
      this._onPointerMove = this._handlePointerMove.bind(this);
      this._onPointerUp = this._handlePointerUp.bind(this);
      this._onWheel = this._handleWheel.bind(this);
      this._onContextMenu = (e) => e.preventDefault();
      domElement.addEventListener("pointerdown", this._onPointerDown);
      domElement.addEventListener("pointermove", this._onPointerMove);
      domElement.addEventListener("pointerup", this._onPointerUp);
      domElement.addEventListener("pointerleave", this._onPointerUp);
      domElement.addEventListener("wheel", this._onWheel, { passive: false });
      domElement.addEventListener("contextmenu", this._onContextMenu);
      domElement.style.cursor = "grab";
      domElement.style.touchAction = "none";
    }

    destroy() {
      if (!this.dom) return;
      this.dom.removeEventListener("pointerdown", this._onPointerDown);
      this.dom.removeEventListener("pointermove", this._onPointerMove);
      this.dom.removeEventListener("pointerup", this._onPointerUp);
      this.dom.removeEventListener("pointerleave", this._onPointerUp);
      this.dom.removeEventListener("wheel", this._onWheel);
      this.dom.removeEventListener("contextmenu", this._onContextMenu);
      this.dom.style.cursor = "";
      this.dom.style.touchAction = "";
      this.dom = null;
    }

    get height() {
      return this.baseHeight / this.zoom;
    }

    setBaseHeight(value) {
      this.baseHeight = Math.max(12, value);
      this.apply();
    }

    reset() {
      this.targetX = 0;
      this.targetZ = 0;
      this.zoom = 1;
      this.apply();
    }

    zoomBy(factor) {
      this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
      this.apply();
    }

    apply() {
      if (!this.camera) return;
      const h = this.height;
      this.camera.position.set(this.targetX, h, this.targetZ);
      this.camera.up.set(0, 0, -1);
      this.camera.lookAt(this.targetX, 0, this.targetZ);
    }

    panPixels(dx, dy) {
      const h = this.height;
      const scale = (h * 0.0018) / this.zoom;
      this.targetX -= dx * scale;
      this.targetZ -= dy * scale;
      this.apply();
    }

    consumeMoved() {
      const moved = this._moved;
      this._moved = false;
      return moved;
    }

    _handlePointerDown(event) {
      if (event.button !== 0) return;
      this._dragging = true;
      this._moved = false;
      this._lastX = event.clientX;
      this._lastY = event.clientY;
      this.dom.setPointerCapture?.(event.pointerId);
      this.dom.style.cursor = "grabbing";
    }

    _handlePointerMove(event) {
      if (!this._dragging) return;
      const dx = event.clientX - this._lastX;
      const dy = event.clientY - this._lastY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this._moved = true;
      this._lastX = event.clientX;
      this._lastY = event.clientY;
      this.panPixels(dx, dy);
    }

    _handlePointerUp(event) {
      if (!this._dragging) return;
      this._dragging = false;
      this.dom.releasePointerCapture?.(event.pointerId);
      this.dom.style.cursor = "grab";
    }

    _handleWheel(event) {
      event.preventDefault();
      const factor = event.deltaY > 0 ? 0.9 : 1.1;
      this.zoomBy(factor);
    }
  }

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
      this._mapData = null;
      this._solarData = null;
      this._lastUpdated = null;
      this._renderer = null;
      this._scene = null;
      this._sceneGroup = null;
      this._camera = null;
      this._viewport = null;
      this._sunGroup = null;
      this._sunPulse = 0;
      this._animationId = null;
      this._bodyMeshes = [];
      this._raycaster = null;
      this._pointer = null;
      this._onResize = this._handleResize.bind(this);
      this._onPointerMovePick = this._handlePointerMovePick.bind(this);
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
            <div class="space-map-hint">Drag to pan · Scroll to zoom · Click a body for details</div>
          </div>
          <div class="space-info-card" id="space-info-card" hidden></div>
          <div class="space-controls">
            <button type="button" class="space-ctrl-btn" data-space-action="zoom-in" title="Zoom in">+</button>
            <button type="button" class="space-ctrl-btn" data-space-action="zoom-out" title="Zoom out">−</button>
            <button type="button" class="space-ctrl-btn" data-space-action="reset-camera" title="Reset view">⟲</button>
          </div>
        </div>`;
      this._root.querySelector('[data-space-action="zoom-in"]')
        ?.addEventListener("click", () => this._viewport?.zoomBy(1.25));
      this._root.querySelector('[data-space-action="zoom-out"]')
        ?.addEventListener("click", () => this._viewport?.zoomBy(0.8));
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
      const hint = wrap.querySelector(".space-map-hint");
      wrap.innerHTML = "";
      if (hint) wrap.appendChild(hint);

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
        this._sceneGroup = new THREE.Group();
        this._scene.add(this._sceneGroup);

        this._camera = new THREE.PerspectiveCamera(50, width / height, 0.05, 800);
        this._raycaster = new THREE.Raycaster();
        this._pointer = new THREE.Vector2();

        this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
        this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this._renderer.setSize(width, height);
        wrap.insertBefore(this._renderer.domElement, wrap.firstChild);

        this._viewport = new SpaceViewport(this._camera, this._renderer.domElement);
        this._viewport.apply();

        const ambient = new THREE.AmbientLight(0x1a2030, 0.35);
        this._scene.add(ambient);

        this._renderer.domElement.addEventListener("pointermove", this._onPointerMovePick);
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
      if (this._viewport) {
        this._viewport.destroy();
        this._viewport = null;
      }
      if (this._renderer) {
        this._renderer.domElement.removeEventListener("pointermove", this._onPointerMovePick);
        this._renderer.domElement.removeEventListener("click", this._onClick);
        this._renderer.dispose();
        this._renderer = null;
      }
      this._disposeMeshes();
      this._sunGroup = null;
      this._scene = null;
      this._sceneGroup = null;
      this._camera = null;
    }

    _disposeMeshes() {
      if (this._sunGroup) {
        this._sunGroup.traverse((obj) => {
          if (obj.geometry) obj.geometry.dispose();
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach((mat) => {
            if (!mat) return;
            if (mat.map) mat.map.dispose();
            mat.dispose();
          });
        });
        this._sceneGroup?.remove(this._sunGroup);
        this._sunGroup = null;
      }
      this._bodyMeshes.forEach((mesh) => {
        if (mesh.material) {
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((m) => {
              if (m.map) m.map.dispose();
              m.dispose();
            });
          } else {
            if (mesh.material.map) mesh.material.map.dispose();
            mesh.material.dispose();
          }
        }
        if (mesh.geometry) mesh.geometry.dispose();
        mesh.parent?.remove(mesh);
      });
      this._bodyMeshes = [];
    }

    _bodyColor(body, type) {
      const byName = PLANET_COLORS[body.name];
      if (byName != null) return byName;
      return BODY_COLORS[type] || 0xffffff;
    }

    _bodyPosition(body, type) {
      if (type === "sun") return { x: 0, y: 0, z: 0 };
      return {
        x: this._scaleDistance(body.x_au),
        y: 0,
        z: this._scaleDistance(body.y_au),
      };
    }

    _fitCameraToBodies(all) {
      let maxOrbit = 6;
      all.forEach((body) => {
        if ((body.type || "planet") === "sun") return;
        const pos = this._bodyPosition(body, body.type || "planet");
        maxOrbit = Math.max(maxOrbit, Math.hypot(pos.x, pos.z));
      });
      if (this._viewport) {
        this._viewport.setBaseHeight(Math.max(20, maxOrbit * 1.55));
        this._viewport.reset();
      }
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

    _createSunTexture() {
      const size = 512;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      const cx = size / 2;
      const grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, cx);
      grad.addColorStop(0, "#fffef5");
      grad.addColorStop(0.12, "#fff3b0");
      grad.addColorStop(0.35, "#ffb300");
      grad.addColorStop(0.62, "#ff6f00");
      grad.addColorStop(0.88, "#e65100");
      grad.addColorStop(1, "#bf360c");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 40; i += 1) {
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * cx * 0.85;
        const px = cx + Math.cos(angle) * dist;
        const py = cx + Math.sin(angle) * dist;
        const r = 4 + Math.random() * 18;
        ctx.fillStyle = `rgba(255, ${180 + Math.random() * 40 | 0}, 0, ${0.08 + Math.random() * 0.12})`;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
      const texture = new THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;
      return texture;
    }

    _createSunGroup(size) {
      const group = new THREE.Group();
      group.userData.isSun = true;

      const core = new THREE.Mesh(
        new THREE.SphereGeometry(size, 48, 48),
        new THREE.MeshBasicMaterial({
          map: this._createSunTexture(),
        }),
      );
      group.add(core);

      const glowLayers = [
        { scale: 1.35, color: 0xffcc33, opacity: 0.22 },
        { scale: 1.75, color: 0xff9900, opacity: 0.14 },
        { scale: 2.35, color: 0xff6600, opacity: 0.08 },
        { scale: 3.1, color: 0xff3300, opacity: 0.04 },
      ];
      glowLayers.forEach((layer) => {
        const glow = new THREE.Mesh(
          new THREE.SphereGeometry(size * layer.scale, 32, 32),
          new THREE.MeshBasicMaterial({
            color: layer.color,
            transparent: true,
            opacity: layer.opacity,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        );
        glow.userData.sunGlow = true;
        glow.userData.baseOpacity = layer.opacity;
        group.add(glow);
      });

      const rayCount = 20;
      for (let i = 0; i < rayCount; i += 1) {
        const angle = (i / rayCount) * Math.PI * 2;
        const rayLen = size * (3.5 + (i % 3) * 0.6);
        const ray = new THREE.Mesh(
          new THREE.PlaneGeometry(size * 0.22, rayLen),
          new THREE.MeshBasicMaterial({
            color: i % 2 === 0 ? 0xffdd66 : 0xff9933,
            transparent: true,
            opacity: 0.07,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
        );
        ray.rotation.x = -Math.PI / 2;
        ray.rotation.z = angle;
        ray.position.set(
          Math.cos(angle) * size * 0.35,
          0.02,
          Math.sin(angle) * size * 0.35,
        );
        ray.userData.sunRay = true;
        group.add(ray);
      }

      const sunLight = new THREE.PointLight(0xffdd99, 4.5, 220, 1.4);
      sunLight.position.set(0, 0, 0);
      group.add(sunLight);

      const fillLight = new THREE.PointLight(0x6688cc, 0.35, 180);
      fillLight.position.set(0, 40, 0);
      group.add(fillLight);

      return group;
    }

    _createLabel(text) {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      canvas.width = 256;
      canvas.height = 64;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = "600 22px system-ui, sans-serif";
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillText(String(text).slice(0, 18), 130, 34);
      ctx.fillStyle = "#f1f5f9";
      ctx.fillText(String(text).slice(0, 18), 128, 32);
      const texture = new THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
      }));
      sprite.scale.set(2.8, 0.7, 1);
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
      if (!this._scene || !this._sceneGroup) return;
      this._disposeMeshes();
      this._sunGroup = null;

      const bodies = (this._mapData && this._mapData.bodies) || [];
      const small = (this._mapData && this._mapData.small_bodies) || [];
      let all = bodies.concat(
        small.filter((b) => b.position_available !== false && b.x_au != null),
      );
      if (!all.some((b) => b.type === "sun")) {
        all = [{
          id: "10", name: "Sun", type: "sun",
          x_au: 0, y_au: 0, z_au: 0, distance_au: 0,
        }, ...all];
      }

      this._sunGroup = this._createSunGroup(BODY_SIZES.sun);
      this._sunGroup.userData = { name: "Sun", type: "sun", id: "10" };
      this._sceneGroup.add(this._sunGroup);
      const sunLabel = this._createLabel("Sun");
      sunLabel.position.set(0, 0.1, -BODY_SIZES.sun - 0.55);
      this._sceneGroup.add(sunLabel);
      this._bodyMeshes.push(sunLabel);

      all.forEach((body) => {
        const type = body.type || "planet";
        if (type === "sun" || !this._layerVisible(type)) return;

        const pos = this._bodyPosition(body, type);
        const { x, y, z } = pos;
        const size = BODY_SIZES[type] || 0.15;
        const color = this._bodyColor(body, type);
        const mat = new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: type === "planet" || type === "dwarf_planet" ? 0.12 : 0.06,
          metalness: 0.08,
          roughness: 0.82,
        });
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(size, 24, 24), mat);
        mesh.position.set(x, y, z);
        mesh.userData = body;
        this._sceneGroup.add(mesh);
        this._bodyMeshes.push(mesh);

        if (body.name && LABEL_TYPES.has(type)) {
          const label = this._createLabel(body.name);
          label.position.set(x, 0.08, z - size - 0.38);
          this._sceneGroup.add(label);
          this._bodyMeshes.push(label);
        }

        const orbitR = Math.hypot(x, z);
        if ((type === "planet" || type === "dwarf_planet") && orbitR > 0.05) {
          const orbit = new THREE.Mesh(
            new THREE.RingGeometry(orbitR * 0.992, orbitR * 1.008, 128),
            new THREE.MeshBasicMaterial({
              color: 0x3d4f63,
              side: THREE.DoubleSide,
              transparent: true,
              opacity: 0.18,
            }),
          );
          orbit.rotation.x = Math.PI / 2;
          this._sceneGroup.add(orbit);
          this._bodyMeshes.push(orbit);
        }
      });

      this._fitCameraToBodies(all);
      this._updateEmptyState();
    }

    _animate() {
      if (!this._renderer || !this._scene || !this._camera) return;
      this._sunPulse += 0.025;
      if (this._sunGroup) {
        this._sunGroup.children.forEach((child) => {
          if (child.userData?.sunGlow && child.material) {
            child.material.opacity = child.userData.baseOpacity + Math.sin(this._sunPulse) * 0.04;
          }
          if (child.userData?.sunRay && child.material) {
            child.material.opacity = 0.05 + Math.sin(this._sunPulse + child.rotation.z) * 0.025;
            child.scale.y = 0.85 + Math.sin(this._sunPulse) * 0.15;
          }
        });
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
      if (this._viewport) this._viewport.reset();
    }

    _handlePointerMovePick(event) {
      if (!this._renderer || !this._camera) return;
      const rect = this._renderer.domElement.getBoundingClientRect();
      this._pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this._pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }

    _handleClick() {
      if (!this._renderer || !this._camera || !this._scene) return;
      if (this._viewport?.consumeMoved()) return;
      this._raycaster.setFromCamera(this._pointer, this._camera);
      const pickables = this._bodyMeshes.filter((m) => m.userData?.name && !m.userData?.sunGlow && !m.userData?.sunRay);
      const hits = this._raycaster.intersectObjects(pickables, true);
      if (!hits.length) {
        const sunHit = this._raycaster.intersectObject(this._sunGroup, true);
        if (sunHit.length) {
          this._showInfo(this._sunGroup.userData);
          return;
        }
        this._hideInfo();
        return;
      }
      let target = hits[0].object;
      while (target && !target.userData?.name && target.parent) {
        target = target.parent;
      }
      this._showInfo(target.userData?.name ? target.userData : hits[0].object.userData);
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
