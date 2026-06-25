/**
 * Blitzortung live lightning WebSocket client.
 * Uses the current HTTPS websocket API (port 443) with obfuscated payloads.
 */
(function (global) {
  "use strict";

  const SERVER_IDS = [1, 2, 3, 5, 6, 7, 8];
  const SUBSCRIBE_ACTION = 111;
  const TABLE_START = 256;
  const RECONNECT_BASE_MS = 2000;
  const RECONNECT_MAX_MS = 30000;

  function pickServerUrl() {
    const id = SERVER_IDS[Math.floor(Math.random() * SERVER_IDS.length)];
    return `wss://ws${id}.blitzortung.org/`;
  }

  /** Reverse Blitzortung's LZW-style obfuscation (see map.blitzortung.org JavaScript). */
  function decodeMessage(payload) {
    const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
    const chars = text.split("");
    if (!chars.length) return "";
    const dictionary = {};
    let c = chars[0];
    let f = c;
    const out = [c];
    let nextCode = 256;
    for (let i = 1; i < chars.length; i += 1) {
      const entryCode = chars[i].charCodeAt(0);
      let entry;
      if (TABLE_START > entryCode) {
        entry = chars[i];
      } else if (Object.prototype.hasOwnProperty.call(dictionary, entryCode)) {
        entry = dictionary[entryCode];
      } else {
        entry = f + c;
      }
      out.push(entry);
      c = entry.charAt(0);
      dictionary[nextCode] = f + c;
      nextCode += 1;
      f = entry;
    }
    return out.join("");
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
        ws.binaryType = "arraybuffer";
      } catch (_) {
        this._scheduleReconnect();
        return;
      }
      this._ws = ws;

      ws.onopen = () => {
        this._reconnectAttempt = 0;
        try {
          ws.send(JSON.stringify({ a: SUBSCRIBE_ACTION }));
          this._emitStatus("live");
        } catch (_) {
          this._emitStatus("error");
          ws.close();
        }
      };

      ws.onmessage = (ev) => {
        let raw;
        try {
          raw = JSON.parse(decodeMessage(ev.data));
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
  global.BlitzortungClient.decodeMessage = decodeMessage;
})(typeof window !== "undefined" ? window : globalThis);
