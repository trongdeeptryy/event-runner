/**
 * Bộ phát DMX qua mạng LAN (Art-Net UDP 6454 & sACN E1.31 UDP 5568)
 * Quản lý socket UDP4, bộ đệm 512 kênh và vòng gửi theo FPS cấu hình.
 */
'use strict';

const dgram = require('dgram');
const crypto = require('crypto');
const {
  buildArtNetPacket,
  buildSacnPacket,
  getSacnMulticastIp
} = require('../shared/dmx-protocol');

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function isBroadcastHost(host) {
  if (typeof host !== 'string') return false;
  const trimmed = host.trim();
  return trimmed === '255.255.255.255' || /\.255$/.test(trimmed);
}

function isMulticastIp(host) {
  if (typeof host !== 'string') return false;
  const firstOctet = Number(host.trim().split('.')[0]);
  return Number.isInteger(firstOctet) && firstOctet >= 224 && firstOctet <= 239;
}

class DmxEngine {
  constructor() {
    this._socket = null;
    this._socketReady = false;
    this._timer = null;
    this._frame = new Uint8Array(512);
    this._seq = 0;
    this._cidBytes = crypto.randomBytes(16);
    this._packetsSent = 0;
    this._lastError = null;
    this._config = {
      enabled: false,
      protocol: 'artnet',
      host: '255.255.255.255',
      port: 6454,
      universe: 0,
      fps: 35
    };
  }

  _clearTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _closeSocket() {
    const sock = this._socket;
    this._socket = null;
    this._socketReady = false;
    if (sock) {
      try {
        sock.removeAllListeners();
        sock.close();
      } catch (_) {}
    }
  }

  _applySocketOptions(sock) {
    if (!sock || !this._socketReady) return;
    try {
      if (this._config.protocol === 'artnet' || isBroadcastHost(this._config.host)) {
        sock.setBroadcast(true);
      }
      if (this._config.protocol === 'sacn' && isMulticastIp(this._config.host)) {
        sock.setMulticastTTL(1);
      }
    } catch (err) {
      this._lastError = err && err.message ? err.message : String(err);
    }
  }

  _sendCurrentFrame() {
    if (!this._config.enabled || !this._socket || !this._socketReady) return;

    this._seq = (this._seq % 255) + 1;
    let packet;
    try {
      packet = this._config.protocol === 'sacn'
        ? buildSacnPacket(this._config.universe, this._frame, this._seq, 'EVENT RUNNER v3.0', this._cidBytes)
        : buildArtNetPacket(this._config.universe, this._frame, this._seq);
    } catch (err) {
      this._lastError = err && err.message ? err.message : String(err);
      return;
    }

    const sock = this._socket;
    try {
      sock.send(packet, 0, packet.length, this._config.port, this._config.host, (err) => {
        if (this._socket !== sock) return;
        if (err) {
          this._lastError = err.message || String(err);
        } else {
          this._packetsSent++;
        }
      });
    } catch (err) {
      this._lastError = err && err.message ? err.message : String(err);
    }
  }

  /**
   * Cấu hình động cơ phát DMX Art-Net / sACN và bật/tắt vòng gửi UDP
   */
  configure(cfg) {
    const input = cfg && typeof cfg === 'object' ? cfg : {};
    const prevEnabled = this._config.enabled;
    const prevProtocol = this._config.protocol;
    const prevFps = this._config.fps;

    const enabled = Boolean(input.enabled);
    const protocol = input.protocol === 'sacn' ? 'sacn' : 'artnet';
    const fps = clampInt(input.fps, 5, 44, 35);
    const universe = protocol === 'sacn'
      ? clampInt(input.universe, 1, 63999, 1)
      : clampInt(input.universe, 0, 32767, 0);
    const defaultPort = protocol === 'sacn' ? 5568 : 6454;
    const port = clampInt(input.port, 1, 65535, defaultPort);

    let host = typeof input.host === 'string' ? input.host.trim() : '';
    if (protocol === 'sacn' && (!host || host.toLowerCase() === 'multicast')) {
      host = getSacnMulticastIp(universe);
    } else if (!host) {
      host = '255.255.255.255';
    }

    this._config = { enabled, protocol, host, port, universe, fps };

    if (!enabled) {
      this._clearTimer();
      this._closeSocket();
      this._lastError = null;
      return this.getStatus();
    }

    const needNewSocket = !this._socket || prevProtocol !== protocol || !prevEnabled;
    if (needNewSocket) {
      this._closeSocket();
      const sock = dgram.createSocket('udp4');
      this._socket = sock;
      this._socketReady = false;
      this._lastError = null;

      sock.on('error', (err) => {
        if (this._socket !== sock) return;
        this._lastError = err && err.message ? err.message : String(err);
      });

      try {
        sock.bind(0, () => {
          if (this._socket !== sock) return;
          this._socketReady = true;
          this._applySocketOptions(sock);
        });
      } catch (err) {
        this._lastError = err && err.message ? err.message : String(err);
      }
    } else {
      this._lastError = null;
      if (this._socketReady) {
        this._applySocketOptions(this._socket);
      }
    }

    if (!this._timer || prevFps !== fps || !prevEnabled) {
      this._clearTimer();
      const intervalMs = Math.max(22, Math.round(1000 / fps));
      this._timer = setInterval(() => this._sendCurrentFrame(), intervalMs);
      if (typeof this._timer.unref === 'function') {
        this._timer.unref();
      }
    }

    return this.getStatus();
  }

  /**
   * Cập nhật khung giá trị 512 kênh DMX mới nhất
   */
  updateFrame(channels) {
    if (!channels || typeof channels.length !== 'number') return;
    if (channels instanceof Uint8Array && channels.length === 512) {
      this._frame.set(channels);
      return;
    }
    const len = Math.min(512, channels.length);
    for (let i = 0; i < len; i++) {
      const v = Number(channels[i]);
      this._frame[i] = Number.isFinite(v) ? clampInt(v, 0, 255, 0) : 0;
    }
    for (let i = len; i < 512; i++) {
      this._frame[i] = 0;
    }
  }

  /**
   * Trả về trạng thái DMX hiện tại
   */
  getStatus() {
    return {
      enabled: this._config.enabled,
      protocol: this._config.protocol,
      host: this._config.host,
      port: this._config.port,
      universe: this._config.universe,
      fps: this._config.fps,
      packetsSent: this._packetsSent,
      lastError: this._lastError
    };
  }

  /**
   * Dừng bộ đếm thời gian và đóng socket UDP
   */
  stop() {
    this._clearTimer();
    this._closeSocket();
    this._config.enabled = false;
    return this.getStatus();
  }
}

module.exports = { DmxEngine };
