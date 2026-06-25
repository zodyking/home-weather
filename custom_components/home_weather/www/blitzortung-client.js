/**
 * Blitzortung live lightning WebSocket client.
 * Protocol ported from https://github.com/SimonSchick/BlitzortungAPI
 */
(function (global) {
  "use strict";

  const SERVER_IDS = [1, 6, 5, 7];
  const RECONNECT_BASE_MS = 2000;
  const RECONNECT_MAX_MS = 30000;

  function pickServerUrl() {
    const id = SERVER_IDS[Math.floor(Math.random() * SERVER_IDS.length)];
    return `wss://ws${id}.blitzortung.org:3000/`;
  }

  function parseStrike(raw) {
    if (!raw || raw.lat == null || raw.lon == null) return null;
    const timeNs = Number(raw.time) || 0;
    const timeMs = Math.floor(timeNs / 1e6);
    return {
      id: `${timeNs}-${raw.lat}-${raw.lon}`,
      lat: Number(raw.lat),
      lon: Number(raw.lon),
      alt: Number(raw.alt) || 0,
      timeMs,
      timeNs,
      polarity: Number(raw.pol) > 0 ? "positive" : "negative",
      region: Number(raw.region) || 0,
      deviation: Number(raw.mds) || 0,
    };
  }

  class BlitzortungClient {
    constructor() {
      this._ws = null;
      this._closed = false;
      this._reconnectTimer = null;
      this._reconnectAttempt = 0;
      this._lastStrikeTimeNs = 0;
      this._strikeHandlers = new Set();
      this._statusHandlers = new Set();
    }

    onStrike(cb) {
      if (typeof cb === "function") this._strikeHandlers.add(cb);
      return () => this._strikeHandlers.delete(cb);
    }

    onStatus(cb) {
      if (typeof cb === "function") this._statusHandlers.add(cb);
      return () => this._statusHandlers.delete(cb);
    }

    _emitStatus(status) {
      this._statusHandlers.forEach((cb) => {
        try { cb(status); } catch (_) { /* ignore */ }
      });
    }

    _emitStrike(strike) {
      this._strikeHandlers.forEach((cb) => {
        try { cb(strike); } catch (_) { /* ignore */ }
      });
    }

    connect() {
      this._closed = false;
      this._openSocket();
    }

    close() {
      this._closed = true;
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      if (this._ws) {
        this._ws.onopen = null;
        this._ws.onmessage = null;
        this._ws.onerror = null;
        this._ws.onclose = null;
        try { this._ws.close(); } catch (_) { /* ignore */ }
        this._ws = null;
      }
      this._emitStatus("off");
    }

    _openSocket() {
      if (this._closed) return;
      this._emitStatus("connecting");
      const url = pickServerUrl();
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        this._scheduleReconnect();
        return;
      }
      this._ws = ws;

      ws.onopen = () => {
        this._reconnectAttempt = 0;
        this._emitStatus("live");
        const resumeNs = this._lastStrikeTimeNs > 0 ? this._lastStrikeTimeNs : 0;
        try {
          ws.send(JSON.stringify({ time: resumeNs }));
        } catch (_) { /* ignore */ }
      };

      ws.onmessage = (ev) => {
        let raw;
        try {
          raw = JSON.parse(ev.data);
        } catch (_) {
          return;
        }
        const strike = parseStrike(raw);
        if (!strike) return;
        if (strike.timeNs > this._lastStrikeTimeNs) {
          this._lastStrikeTimeNs = strike.timeNs;
        }
        this._emitStrike(strike);
      };

      ws.onerror = () => {
        this._emitStatus("error");
      };

      ws.onclose = () => {
        this._ws = null;
        if (this._closed) return;
        this._emitStatus("reconnecting");
        this._scheduleReconnect();
      };
    }

    _scheduleReconnect() {
      if (this._closed) return;
      clearTimeout(this._reconnectTimer);
      const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempt),
        RECONNECT_MAX_MS
      );
      this._reconnectAttempt += 1;
      this._reconnectTimer = setTimeout(() => this._openSocket(), delay);
    }
  }

  global.BlitzortungClient = BlitzortungClient;
  global.BlitzortungClient.parseStrike = parseStrike;
})(typeof window !== "undefined" ? window : globalThis);
