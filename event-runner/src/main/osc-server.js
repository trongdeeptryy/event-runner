/**
 * Bộ lắng nghe OSC qua UDP (mặc định TẮT cho tới khi người dùng bật)
 * Nhận gói OSC từ bàn lighting / TouchOSC / QLab / Companion và chuyển về Control App.
 */
'use strict';

const dgram = require('dgram');
const { parseOscPacket } = require('../shared/osc-protocol');

function clampPort(value, fallback = 9000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded < 1 || rounded > 65535) return fallback;
  return rounded;
}

class OscServer {
  constructor() {
    this._socket = null;
    this._enabled = false;
    this._port = 9000;
    this._lastError = null;
    this._onMessage = null;
  }

  _closeSocketInstance(sock) {
    if (!sock) return;
    if (this._socket === sock) {
      this._socket = null;
    }
    try {
      sock.removeAllListeners();
      sock.close();
    } catch (_) {}
  }

  /**
   * Mở cổng UDP4 trên 0.0.0.0:port để lắng nghe gói OSC
   */
  start(port = 9000, onMessage) {
    const targetPort = clampPort(port, 9000);
    if (this._socket && this._enabled && this._port === targetPort) {
      if (typeof onMessage === 'function') {
        this._onMessage = onMessage;
      }
      return Promise.resolve(this.getStatus());
    }

    this.stop();
    this._port = targetPort;
    this._onMessage = typeof onMessage === 'function' ? onMessage : null;
    this._lastError = null;

    return new Promise((resolve) => {
      const sock = dgram.createSocket('udp4');
      this._socket = sock;
      let settled = false;

      const settleOnce = () => {
        if (settled) return;
        settled = true;
        resolve(this.getStatus());
      };

      sock.on('error', (err) => {
        const msg = err && err.message ? err.message : String(err);
        if (this._socket === sock) {
          this._lastError = msg;
        }
        if (!settled) {
          this._enabled = false;
          this._closeSocketInstance(sock);
          settleOnce();
        }
      });

      sock.on('message', (buf) => {
        if (this._socket !== sock) return;
        let packets;
        try {
          packets = parseOscPacket(buf);
        } catch (err) {
          this._lastError = err && err.message ? err.message : String(err);
          return;
        }
        if (!Array.isArray(packets)) return;
        for (const pkt of packets) {
          if (!pkt || typeof pkt.address !== 'string') continue;
          if (typeof this._onMessage === 'function') {
            try {
              this._onMessage({
                address: pkt.address,
                args: Array.isArray(pkt.args) ? pkt.args : []
              });
            } catch (err) {
              this._lastError = err && err.message ? err.message : String(err);
            }
          }
        }
      });

      sock.on('listening', () => {
        if (this._socket !== sock) return;
        try {
          const addr = sock.address();
          if (addr && typeof addr.port === 'number') {
            this._port = addr.port;
          }
        } catch (_) {}
        this._enabled = true;
        this._lastError = null;
        settleOnce();
      });

      try {
        sock.bind(targetPort, '0.0.0.0');
      } catch (err) {
        this._lastError = err && err.message ? err.message : String(err);
        this._enabled = false;
        this._closeSocketInstance(sock);
        settleOnce();
      }
    });
  }

  /**
   * Đóng socket OSC và đặt lại trạng thái
   */
  stop() {
    const sock = this._socket;
    this._socket = null;
    this._enabled = false;
    this._lastError = null;
    this._onMessage = null;
    if (sock) {
      try {
        sock.removeAllListeners();
        sock.close();
      } catch (_) {}
    }
    return {
      enabled: false,
      port: this._port,
      lastError: null
    };
  }

  /**
   * Trả về trạng thái OSC Server hiện tại
   */
  getStatus() {
    return {
      enabled: this._enabled,
      port: this._port,
      lastError: this._lastError
    };
  }
}

module.exports = { OscServer };
