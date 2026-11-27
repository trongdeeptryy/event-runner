/**
 * Engine chớp đèn LED sân khấu đồng bộ nhịp Beat & Âm thanh 60–144 FPS
 * Hỗ trợ đầy đủ 8 chế độ LED + 7 bảng màu + 4 nút nhấn giữ tức thời (Momentary)
 * Tối ưu zero-GC & skip hoàn toàn khi mode === 'off' và không có momentary.
 */
(function (root, factory) {
  const LedBeatEngine = factory(root.EventRunnerLogic);
  if (typeof module === 'object' && module.exports) {
    module.exports = LedBeatEngine;
  }
  if (root) {
    root.EventRunnerLedBeatEngine = LedBeatEngine;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (logicRef) {
  'use strict';

  const FALLBACK_PALETTES = {
    white: ['#ffffff', '#e2e8f0'],
    cyber: ['#00d2ff', '#ff007f', '#7b2cbf'],
    fire: ['#ff3b00', '#ff9900', '#ffdd00'],
    rainbow: ['#ff004c', '#ff9900', '#ffee00', '#00f59b', '#00d2ff', '#9d4edd'],
    gala: ['#ffd166', '#ffffff', '#ff9f1c'],
    ice: ['#e0fbfc', '#00e5ff', '#3a86ff']
  };

  const VALID_BLENDS = new Set([
    'normal', 'screen', 'plus-lighter', 'multiply', 'overlay',
    'lighten', 'difference', 'color-dodge', 'hard-light'
  ]);

  const parsedHexCache = new Map();

  function clamp(v, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return min;
    return n < min ? min : (n > max ? max : n);
  }

  function parseHexRgb(hex) {
    const key = typeof hex === 'string' && hex ? hex : '#00d2ff';
    const hit = parsedHexCache.get(key);
    if (hit) return hit;

    let r = 0;
    let g = 210;
    let b = 255;
    const logic = (typeof window !== 'undefined' && window.EventRunnerLogic) || logicRef;
    if (logic && typeof logic.hexToRgb === 'function') {
      const res = logic.hexToRgb(key);
      if (res) {
        r = res.r;
        g = res.g;
        b = res.b;
      }
    } else {
      const clean = key.trim().replace('#', '');
      if (/^[0-9a-fA-F]{6}$/.test(clean)) {
        r = parseInt(clean.slice(0, 2), 16);
        g = parseInt(clean.slice(2, 4), 16);
        b = parseInt(clean.slice(4, 6), 16);
      } else if (/^[0-9a-fA-F]{3}$/.test(clean)) {
        r = parseInt(clean[0] + clean[0], 16);
        g = parseInt(clean[1] + clean[1], 16);
        b = parseInt(clean[2] + clean[2], 16);
      }
    }

    const entry = {
      r, g, b,
      prefix: `rgba(${r},${g},${b},`,
      solid: `rgb(${r},${g},${b})`
    };
    if (parsedHexCache.size > 64) parsedHexCache.clear();
    parsedHexCache.set(key, entry);
    return entry;
  }

  function resolveColors(cfg) {
    const logic = (typeof window !== 'undefined' && window.EventRunnerLogic) || logicRef;
    if (logic && typeof logic.resolvePaletteColors === 'function') {
      const arr = logic.resolvePaletteColors(cfg);
      if (Array.isArray(arr) && arr.length > 0) return arr;
    }
    if (cfg.palette === 'custom') {
      return [cfg.colorA || '#00d2ff', cfg.colorB || '#ff007f'];
    }
    return FALLBACK_PALETTES[cfg.palette] || FALLBACK_PALETTES.cyber;
  }

  class LedBeatEngine {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas ? canvas.getContext('2d') : null;
      this.logicalW = 1920;
      this.logicalH = 1080;
      this.dprScale = 1;
      this._cleared = true;

      this.config = {
        on: false,
        mode: 'edge-chase',
        palette: 'cyber',
        colorA: '#00d2ff',
        colorB: '#ff007f',
        trigger: 'beat',
        divider: 1,
        intensity: 80,
        decayMs: 180,
        blend: 'plus-lighter',
        edgeWidth: 10
      };
      this.paletteColors = resolveColors(this.config);

      // Trạng thái nhịp & dải âm thanh
      this.beatEnv = 0;
      this.bandPulse = 0;
      this.beatIndex = 0;
      this.beatInBar = 0;
      this.colorCursor = 0;
      this.chaseOffset = 0;
      this.matrixSweep = 0;

      this.bass = 0;
      this.mid = 0;
      this.high = 0;
      this.prevBandSignal = 0;
      this.bandCooldown = 0;
      this.beatPhase = 0;
      this.playing = false;

      // Trạng thái nút nhấn giữ tức thời (Momentary)
      this.momFlash = false;
      this.momStrobe = false;
      this.momInvert = false;
      this.momDrop = false;
      this.momColor = null;
      this.flashPeak = 0;
      this.dropPeak = 0;
      this.invertPeak = 0;

      this._applyBlendMode();
    }

    _applyBlendMode() {
      if (!this.canvas || !this.canvas.style) return;
      const blend = VALID_BLENDS.has(this.config.blend) ? this.config.blend : 'plus-lighter';
      if (this.canvas.style.mixBlendMode !== blend) {
        this.canvas.style.mixBlendMode = blend;
      }
    }

    _syncCanvasSize() {
      if (!this.canvas || !this.ctx) return false;
      const cw = this.canvas.clientWidth || window.innerWidth || 1920;
      const ch = this.canvas.clientHeight || window.innerHeight || 1080;
      if (cw <= 0 || ch <= 0) return false;

      const rawDpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      // Giới hạn DPR trên màn lớn để giữ 60–144 FPS mượt tuyệt đối
      const scale = cw > 2560 ? Math.min(rawDpr, 1.25) : Math.min(rawDpr, 2);
      const targetW = Math.max(1, Math.round(cw * scale));
      const targetH = Math.max(1, Math.round(ch * scale));

      if (this.canvas.width !== targetW || this.canvas.height !== targetH || this.dprScale !== scale) {
        this.canvas.width = targetW;
        this.canvas.height = targetH;
        this.logicalW = cw;
        this.logicalH = ch;
        this.dprScale = scale;
        this.ctx.setTransform(scale, 0, 0, scale, 0, 0);
      } else {
        this.logicalW = cw;
        this.logicalH = ch;
      }
      return true;
    }

    setConfig(config) {
      if (!config || typeof config !== 'object') return;
      const prevOn = this.config.on;
      const next = {
        on: config.on !== undefined ? Boolean(config.on) : (config.mode ? config.mode !== 'off' : prevOn),
        mode: typeof config.mode === 'string' ? config.mode : this.config.mode,
        palette: typeof config.palette === 'string' ? config.palette : this.config.palette,
        colorA: typeof config.colorA === 'string' ? config.colorA : this.config.colorA,
        colorB: typeof config.colorB === 'string' ? config.colorB : this.config.colorB,
        trigger: typeof config.trigger === 'string' ? config.trigger : this.config.trigger,
        divider: Number.isFinite(Number(config.divider)) ? Number(config.divider) : this.config.divider,
        intensity: clamp(config.intensity ?? this.config.intensity, 0, 100),
        decayMs: clamp(config.decayMs ?? this.config.decayMs, 40, 1200),
        blend: typeof config.blend === 'string' ? config.blend : this.config.blend,
        edgeWidth: clamp(config.edgeWidth ?? this.config.edgeWidth, 1, 40)
      };
      this.config = next;
      this.paletteColors = resolveColors(next);
      this._applyBlendMode();
    }

    triggerBeatHit(payload) {
      const p = payload && typeof payload === 'object' ? payload : {};
      const k = clamp(p.k ?? 0.85, 0.15, 1);

      if (Array.isArray(p.paletteOverride) && p.paletteOverride.length > 0) {
        this.paletteColors = p.paletteOverride;
      }

      this.beatEnv = Math.max(this.beatEnv, k);
      this.beatIndex = Number.isFinite(p.beatIndex) ? p.beatIndex : (this.beatIndex + 1);
      this.beatInBar = Number.isFinite(p.beatInBar)
        ? ((p.beatInBar % 4) + 4) % 4
        : ((this.beatIndex % 4) + 4) % 4;
      this.colorCursor = (this.colorCursor + 1) % Math.max(1, this.paletteColors.length);
      this.chaseOffset = (this.chaseOffset + 0.25) % 1;
      this.matrixSweep = (this.matrixSweep + 1) % 6;

      if (p.bands && typeof p.bands === 'object') {
        this.bass = clamp(p.bands.bass ?? this.bass, 0, 1);
        this.mid = clamp(p.bands.mid ?? this.mid, 0, 1);
        this.high = clamp(p.bands.high ?? this.high, 0, 1);
      }
    }

    setMomentary(action, active, color) {
      const isOn = Boolean(active);
      if (typeof color === 'string' && color.trim()) {
        this.momColor = color.trim();
      } else if (!isOn && !this.momFlash && !this.momStrobe && !this.momDrop && !this.momInvert) {
        this.momColor = null;
      }

      switch (action) {
        case 'flash':
          this.momFlash = isOn;
          if (isOn) this.flashPeak = 1.0;
          break;
        case 'strobe':
          this.momStrobe = isOn;
          break;
        case 'invert':
          this.momInvert = isOn;
          if (isOn) this.invertPeak = 1.0;
          break;
        case 'drop':
          this.momDrop = isOn;
          if (isOn) {
            this.dropPeak = 1.0;
            this.beatEnv = 1.0;
          }
          break;
        default:
          break;
      }
    }

    resetMomentaries() {
      this.momFlash = false;
      this.momStrobe = false;
      this.momInvert = false;
      this.momDrop = false;
      this.momColor = null;
      this.flashPeak = 0;
      this.dropPeak = 0;
      this.invertPeak = 0;
    }

    updateAudioBands(bands) {
      if (!bands || typeof bands !== 'object') return;
      this.bass = clamp(bands.bass ?? 0, 0, 1);
      this.mid = clamp(bands.mid ?? 0, 0, 1);
      this.high = clamp(bands.high ?? 0, 0, 1);
      this.playing = Boolean(bands.playing);
      if (Number.isFinite(bands.beatPhase)) {
        this.beatPhase = (bands.beatPhase % 1 + 1) % 1;
      }

      const trig = this.config.trigger;
      let bandSignal = 0;
      if (trig === 'bass') bandSignal = this.bass;
      else if (trig === 'mid') bandSignal = this.mid;
      else if (trig === 'high') bandSignal = this.high;
      else if (trig === 'all') bandSignal = Math.max(this.bass, this.mid, this.high);

      if (trig !== 'beat' && this.config.on !== false) {
        const delta = bandSignal - this.prevBandSignal;
        if (delta > 0.13 && bandSignal > 0.32 && this.bandCooldown <= 0) {
          this.beatEnv = Math.max(this.beatEnv, clamp(bandSignal * 1.15, 0.35, 1));
          this.colorCursor = (this.colorCursor + 1) % Math.max(1, this.paletteColors.length);
          this.chaseOffset = (this.chaseOffset + 0.18) % 1;
          this.bandCooldown = 0.095;
        }
        this.bandPulse = Math.max(this.bandPulse * 0.85, bandSignal);
      } else {
        this.bandPulse = 0;
      }
      this.prevBandSignal = bandSignal;
    }

    _getPrimaryRgb(offset) {
      const arr = this.paletteColors;
      const len = arr.length || 1;
      const idx = ((this.colorCursor + (offset || 0)) % len + len) % len;
      return parseHexRgb(arr[idx]);
    }

    // =========================================================================
    // 8 CHẾ ĐỘ VẼ LED SÂN KHẤU
    // =========================================================================

    _drawFlash(ctx, w, h, strength, rgb) {
      if (strength <= 0.005) return;
      ctx.fillStyle = `${rgb.prefix}${(strength * 0.78).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);

      // Lõi trắng chói ở đỉnh xung
      if (strength > 0.4) {
        const core = (strength - 0.4) / 0.6;
        ctx.fillStyle = `rgba(255,255,255,${(core * 0.55).toFixed(3)})`;
        ctx.fillRect(0, 0, w, h);
      }
    }

    _drawWash(ctx, w, h, strength, rgb, rgbAlt) {
      const trig = this.config.trigger;
      const bandEnv = trig === 'mid' ? this.mid : (trig === 'high' ? this.high : (trig === 'all' ? Math.max(this.bass, this.mid, this.high) : this.bass));
      const washLevel = clamp(strength * 0.72 + bandEnv * 0.55, 0, 1);
      if (washLevel <= 0.008) return;

      const cx = w * 0.5;
      const cy = h * 0.5;
      const maxR = Math.hypot(w, h) * 0.62;

      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
      grad.addColorStop(0, `${rgb.prefix}${(washLevel * 0.62).toFixed(3)})`);
      grad.addColorStop(0.55, `${rgbAlt.prefix}${(washLevel * 0.34).toFixed(3)})`);
      grad.addColorStop(1, `${rgbAlt.prefix}0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Hai luồng wash hai bên cánh gà
      const sideR = w * 0.45;
      const gL = ctx.createRadialGradient(0, h * 0.5, 0, 0, h * 0.5, sideR);
      gL.addColorStop(0, `${rgbAlt.prefix}${(washLevel * 0.45).toFixed(3)})`);
      gL.addColorStop(1, `${rgbAlt.prefix}0)`);
      ctx.fillStyle = gL;
      ctx.fillRect(0, 0, sideR, h);

      const gR = ctx.createRadialGradient(w, h * 0.5, 0, w, h * 0.5, sideR);
      gR.addColorStop(0, `${rgb.prefix}${(washLevel * 0.45).toFixed(3)})`);
      gR.addColorStop(1, `${rgb.prefix}0)`);
      ctx.fillStyle = gR;
      ctx.fillRect(w - sideR, 0, sideR, h);
    }

    _drawEdgeChase(ctx, w, h, strength, rgb, rgbAlt, nowMs) {
      const baseGlow = clamp(0.18 + this.bass * 0.35 + strength * 0.85, 0, 1);
      const thick = Math.max(8, Math.min(w, h) * (this.config.edgeWidth / 100) * 0.48);
      const segPerSide = 8;
      const chase = (this.chaseOffset + (nowMs * 0.00045)) % 1;

      // Vẽ 4 viền phát sáng dịu + các phân đoạn LED chạy vòng quanh 4 cạnh
      const drawEdgeStrip = (x0, y0, sw, sh, isHoriz, sideIdx) => {
        for (let i = 0; i < segPerSide; i++) {
          const u = ((sideIdx * segPerSide + i) / (segPerSide * 4) + chase) % 1;
          const wave = Math.sin(u * Math.PI * 4);
          const pulse = Math.max(0.08, wave * 0.5 + 0.5);
          const segAlpha = clamp(baseGlow * (0.25 + 0.75 * pulse), 0, 1);
          const col = ((i + this.beatIndex) % 2 === 0) ? rgb : rgbAlt;

          const rx = isHoriz ? x0 + (sw / segPerSide) * i : x0;
          const ry = isHoriz ? y0 : y0 + (sh / segPerSide) * i;
          const rw = isHoriz ? (sw / segPerSide) - 2 : sw;
          const rh = isHoriz ? sh : (sh / segPerSide) - 2;

          ctx.fillStyle = `${col.prefix}${(segAlpha * 0.82).toFixed(3)})`;
          ctx.fillRect(rx, ry, rw, rh);

          if (segAlpha > 0.45) {
            const inner = thick * 0.28;
            ctx.fillStyle = `rgba(255,255,255,${((segAlpha - 0.45) * 0.9).toFixed(3)})`;
            if (isHoriz) {
              const cy = y0 === 0 ? 0 : y0 + sh - inner;
              ctx.fillRect(rx, cy, rw, inner);
            } else {
              const cx = x0 === 0 ? 0 : x0 + sw - inner;
              ctx.fillRect(cx, ry, inner, rh);
            }
          }
        }
      };

      // Hào quang viền tổng
      ctx.strokeStyle = `${rgb.prefix}${(baseGlow * 0.45).toFixed(3)})`;
      ctx.lineWidth = thick * 1.4;
      ctx.strokeRect(thick * 0.3, thick * 0.3, w - thick * 0.6, h - thick * 0.6);

      drawEdgeStrip(0, 0, w, thick, true, 0);
      drawEdgeStrip(w - thick, thick, thick, h - thick * 2, false, 1);
      drawEdgeStrip(0, h - thick, w, thick, true, 2);
      drawEdgeStrip(0, thick, thick, h - thick * 2, false, 3);
    }

    _drawQuadrant(ctx, w, h, strength, rgb, rgbAlt) {
      if (strength <= 0.01) return;
      const q = this.beatInBar % 4;
      const halfW = w * 0.5;
      const halfH = h * 0.5;

      // Thứ tự góc: 0=Trên-Trái, 1=Trên-Phải, 2=Dưới-Phải, 3=Dưới-Trái
      const coords = [
        [0, 0, 0, 0],
        [halfW, 0, w, 0],
        [halfW, halfH, w, h],
        [0, halfH, 0, h]
      ];
      const [qx, qy, gx, gy] = coords[q];
      const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, Math.hypot(halfW, halfH) * 1.05);
      grad.addColorStop(0, `rgba(255,255,255,${(strength * 0.75).toFixed(3)})`);
      grad.addColorStop(0.28, `${rgb.prefix}${(strength * 0.85).toFixed(3)})`);
      grad.addColorStop(1, `${rgb.prefix}0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(qx, qy, halfW, halfH);

      // Góc đối diện mờ nhẹ tạo cân bằng sân khấu
      const opp = (q + 2) % 4;
      const [ox, oy, ogx, ogy] = coords[opp];
      const gradOpp = ctx.createRadialGradient(ogx, ogy, 0, ogx, ogy, Math.hypot(halfW, halfH) * 0.75);
      gradOpp.addColorStop(0, `${rgbAlt.prefix}${(strength * 0.42).toFixed(3)})`);
      gradOpp.addColorStop(1, `${rgbAlt.prefix}0)`);
      ctx.fillStyle = gradOpp;
      ctx.fillRect(ox, oy, halfW, halfH);
    }

    _drawMatrixBars(ctx, w, h, strength, rgb, rgbAlt) {
      const energy = clamp(strength * 0.85 + this.mid * 0.35 + this.bass * 0.25, 0, 1);
      if (energy <= 0.01) return;

      const numBars = 8;
      const isHoriz = (Math.floor(this.beatIndex / 4) % 2) === 1;
      const activeIdx = this.matrixSweep % numBars;

      if (!isHoriz) {
        const barW = w / numBars;
        for (let i = 0; i < numBars; i++) {
          const dist = Math.min(Math.abs(i - activeIdx), numBars - Math.abs(i - activeIdx));
          const active = dist === 0 ? 1 : (dist === 1 ? 0.48 : 0.12);
          const alpha = energy * active;
          if (alpha <= 0.02) continue;
          const col = i % 2 === 0 ? rgb : rgbAlt;
          const x = i * barW;
          const grad = ctx.createLinearGradient(x, 0, x + barW, 0);
          grad.addColorStop(0, `${col.prefix}0)`);
          grad.addColorStop(0.5, `${col.prefix}${(alpha * 0.75).toFixed(3)})`);
          grad.addColorStop(1, `${col.prefix}0)`);
          ctx.fillStyle = grad;
          ctx.fillRect(x, 0, barW, h);

          if (dist === 0) {
            ctx.fillStyle = `rgba(255,255,255,${(alpha * 0.45).toFixed(3)})`;
            ctx.fillRect(x + barW * 0.44, 0, barW * 0.12, h);
          }
        }
      } else {
        const barH = h / numBars;
        for (let i = 0; i < numBars; i++) {
          const dist = Math.min(Math.abs(i - activeIdx), numBars - Math.abs(i - activeIdx));
          const active = dist === 0 ? 1 : (dist === 1 ? 0.48 : 0.12);
          const alpha = energy * active;
          if (alpha <= 0.02) continue;
          const col = i % 2 === 0 ? rgb : rgbAlt;
          const y = i * barH;
          const grad = ctx.createLinearGradient(0, y, 0, y + barH);
          grad.addColorStop(0, `${col.prefix}0)`);
          grad.addColorStop(0.5, `${col.prefix}${(alpha * 0.75).toFixed(3)})`);
          grad.addColorStop(1, `${col.prefix}0)`);
          ctx.fillStyle = grad;
          ctx.fillRect(0, y, w, barH);
        }
      }
    }

    _drawInvertHit(ctx, w, h, strength, rgb) {
      if (strength <= 0.01) return;
      // Chớp màu nhịp + viền sân khấu sắc nét đồng bộ với CSS invert trên #stage
      ctx.fillStyle = `${rgb.prefix}${(strength * 0.34).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);

      const border = Math.max(10, Math.min(w, h) * 0.028);
      ctx.strokeStyle = `rgba(255,255,255,${(strength * 0.88).toFixed(3)})`;
      ctx.lineWidth = border;
      ctx.strokeRect(border * 0.5, border * 0.5, w - border, h - border);
    }

    _drawBlinder(ctx, w, h, strength, rgb, cols, rows) {
      const level = clamp(strength * 0.9 + this.bass * 0.2, 0, 1);
      if (level <= 0.01) return;

      const cellW = w / cols;
      const cellH = h / rows;
      const maxR = Math.min(cellW, cellH) * 0.62;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cx = (c + 0.5) * cellW;
          const cy = (r + 0.5) * cellH;
          const isWarm = this.config.palette === 'white' || this.config.palette === 'gala';
          const haloCol = isWarm ? 'rgba(255,205,120,' : rgb.prefix;

          const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
          grad.addColorStop(0, `rgba(255,250,235,${(level * 0.95).toFixed(3)})`);
          grad.addColorStop(0.28, `${haloCol}${(level * 0.75).toFixed(3)})`);
          grad.addColorStop(0.65, `${haloCol}${(level * 0.26).toFixed(3)})`);
          grad.addColorStop(1, `${haloCol}0)`);
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // =========================================================================
    // VÒNG RENDER CHÍNH (GỌI TRONG masterMotionLoop)
    // =========================================================================

    render(dtSec, nowMs) {
      if (!this.canvas || !this.ctx) return;

      const dt = clamp(dtSec || (1 / 60), 0.0005, 0.1);
      const tMs = Number.isFinite(nowMs) ? nowMs : performance.now();

      this.bandCooldown = Math.max(0, this.bandCooldown - dt);
      const decayTau = Math.max(0.03, (this.config.decayMs / 1000) * 0.42);
      const decayFactor = Math.exp(-dt / decayTau);
      this.beatEnv *= decayFactor;
      if (this.beatEnv < 0.002) this.beatEnv = 0;

      this.flashPeak *= Math.exp(-dt / Math.max(0.04, decayTau));
      if (this.flashPeak < 0.002) this.flashPeak = 0;

      this.dropPeak *= Math.exp(-dt / 0.25);
      if (this.dropPeak < 0.002) this.dropPeak = 0;

      this.invertPeak *= Math.exp(-dt / Math.max(0.05, decayTau));
      if (this.invertPeak < 0.002) this.invertPeak = 0;

      const effectiveMode = this.config.on === false ? 'off' : (this.config.mode || 'off');
      const hasMomentary = Boolean(
        this.momFlash || this.momStrobe || this.momInvert || this.momDrop ||
        this.flashPeak > 0.005 || this.dropPeak > 0.005 || this.invertPeak > 0.005
      );

      // Tiết kiệm 100% CPU/GPU khi LED Beat tắt và không nhấn giữ momentary
      if (effectiveMode === 'off' && !hasMomentary) {
        if (!this._cleared) {
          this.ctx.clearRect(0, 0, this.logicalW, this.logicalH);
          this._cleared = true;
        }
        return;
      }

      if (!this._syncCanvasSize()) return;

      const ctx = this.ctx;
      const w = this.logicalW;
      const h = this.logicalH;
      ctx.clearRect(0, 0, w, h);
      this._cleared = false;

      const intensityScale = this.config.intensity / 100;
      const strength = clamp(Math.max(this.beatEnv, this.bandPulse * 0.85) * intensityScale, 0, 1);
      const rgb = this._getPrimaryRgb(0);
      const rgbAlt = this._getPrimaryRgb(1);

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // 1. Render chế độ LED theo Beat
      switch (effectiveMode) {
        case 'flash':
          this._drawFlash(ctx, w, h, strength, rgb);
          break;
        case 'wash':
          this._drawWash(ctx, w, h, strength, rgb, rgbAlt);
          break;
        case 'edge-chase':
          this._drawEdgeChase(ctx, w, h, strength, rgb, rgbAlt, tMs);
          break;
        case 'quadrant':
          this._drawQuadrant(ctx, w, h, strength, rgb, rgbAlt);
          break;
        case 'matrix-bars':
          this._drawMatrixBars(ctx, w, h, strength, rgb, rgbAlt);
          break;
        case 'invert-hit':
          this._drawInvertHit(ctx, w, h, strength, rgb);
          break;
        case 'blinder':
          this._drawBlinder(ctx, w, h, strength, rgb, 4, 2);
          break;
        case 'off':
        default:
          break;
      }

      // 2. Render các nút nhấn giữ Momentary ưu tiên cao
      const momRgb = this.momColor ? parseHexRgb(this.momColor) : rgb;

      if (this.momFlash || this.flashPeak > 0.005) {
        const fLevel = this.momFlash ? Math.max(0.85, this.flashPeak) : this.flashPeak;
        this._drawFlash(ctx, w, h, fLevel, momRgb);
      }

      if (this.momStrobe) {
        // Sóng vuông 16 Hz (chu kỳ 62.5 ms -> sáng 31.25 ms, tắt 31.25 ms)
        const onPhase = (tMs % 62.5) < 31.25;
        if (onPhase) {
          ctx.fillStyle = this.momColor ? `${momRgb.prefix}0.88)` : 'rgba(255,255,255,0.92)';
          ctx.fillRect(0, 0, w, h);
        }
      }

      if (this.momInvert || this.invertPeak > 0.005) {
        const invAlpha = this.momInvert ? 0.72 : this.invertPeak * 0.72;
        ctx.strokeStyle = `${momRgb.prefix}${invAlpha.toFixed(3)})`;
        ctx.lineWidth = Math.max(12, Math.min(w, h) * 0.032);
        ctx.strokeRect(0, 0, w, h);
      }

      if (this.momDrop || this.dropPeak > 0.005) {
        const dropAmt = this.momDrop ? 1.0 : this.dropPeak;
        const cycleIdx = Math.floor(tMs / 75);
        const dropColA = parseHexRgb(this.paletteColors[cycleIdx % this.paletteColors.length]);
        const dropColB = parseHexRgb(this.paletteColors[(cycleIdx + 1) % this.paletteColors.length]);
        this._drawBlinder(ctx, w, h, dropAmt, dropColA, 6, 2);
        const oldOffset = this.chaseOffset;
        this.chaseOffset = (tMs * 0.003) % 1;
        this._drawEdgeChase(ctx, w, h, dropAmt, dropColA, dropColB, tMs);
        this.chaseOffset = oldOffset;
      }

      ctx.restore();
    }
  }

  // Cho phép dùng cả `new EventRunnerLedBeatEngine(canvas)` và `new EventRunnerLedBeatEngine.LedBeatEngine(canvas)`
  LedBeatEngine.LedBeatEngine = LedBeatEngine;
  return LedBeatEngine;
});
