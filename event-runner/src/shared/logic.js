/**
 * Module logic thuần cho EVENT RUNNER (UMD: dùng được cả Node.js và Renderer)
 * Chứa: mô hình cue, validate/migrate dự án, bộ dò bass onset DSP, bộ theo dõi BPM,
 * TAP tempo, tính overscan chống lộ viền, chọn màn hình LED, kiểm tra trước giờ G.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EventRunnerLogic = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Các kiểu chuyển cảnh hỗ trợ trên màn LED */
  const TRANSITION_TYPES = [
    'cut',
    'fade',
    'black',
    'slide-left',
    'slide-right',
    'zoom',
    'wipe-left',
    'wipe-right',
    'wipe-up',
    'circle-iris',
    'blur-dissolve',
    'flash-cut'
  ];

  /** Chế độ hòa trộn lớp VJ & LED Strobe */
  const BLEND_MODES = [
    'normal',
    'screen',
    'plus-lighter',
    'multiply',
    'overlay',
    'lighten',
    'difference',
    'color-dodge',
    'hard-light'
  ];

  /** Các chế độ chớp / đuổi đèn LED đồng bộ nhạc */
  const LED_STROBE_MODES = [
    'off',
    'flash',
    'wash',
    'edge-chase',
    'quadrant',
    'matrix-bars',
    'invert-hit',
    'blinder'
  ];

  /** Bộ tạo hình ảnh VJ theo thời gian thực */
  const VJ_GENERATORS = [
    'spectrum-bars',
    'laser-beams',
    'strobe-matrix',
    'pulse-rings',
    'cyber-grid',
    'plasma-wave'
  ];

  /** Bảng màu LED đồng bộ theo chủ đề sân khấu */
  const LED_PALETTES = {
    white: { name: 'Trắng tinh khiết', colors: ['#ffffff', '#dbeafe'] },
    cyber: { name: 'Cyber Neon', colors: ['#00d2ff', '#ff007f', '#7c3aed'] },
    fire: { name: 'Lửa Sân Khấu', colors: ['#ff3b00', '#ff8800', '#ffd000'] },
    rainbow: { name: 'Cầu Vồng EDM', colors: ['#ff0055', '#ff9900', '#ffee00', '#00ff88', '#00d2ff', '#8b5cf6'] },
    gala: { name: 'Gala Sang Trọng', colors: ['#ffd700', '#fff1b8', '#ff9f1c', '#ffffff'] },
    ice: { name: 'Băng Giá', colors: ['#00f5d4', '#00bbf9', '#e0f7ff'] },
    custom: { name: 'Tự chọn A/B', colors: ['#00d2ff', '#ff007f'] }
  };

  /** Các preset chớp LED đồng bộ beat 1 chạm */
  const LED_STROBE_PRESETS = {
    'Club Drop': {
      on: true,
      mode: 'flash',
      palette: 'cyber',
      colorA: '#00d2ff',
      colorB: '#ff007f',
      trigger: 'beat',
      divider: 1,
      intensity: 95,
      decayMs: 160,
      blend: 'plus-lighter',
      edgeWidth: 12,
      dmxMode: 'beat-flash'
    },
    'EDM Strobe': {
      on: true,
      mode: 'blinder',
      palette: 'white',
      colorA: '#ffffff',
      colorB: '#dbeafe',
      trigger: 'all',
      divider: 2,
      intensity: 100,
      decayMs: 110,
      blend: 'plus-lighter',
      edgeWidth: 10,
      dmxMode: 'strobe'
    },
    'Viền Sân Khấu': {
      on: true,
      mode: 'edge-chase',
      palette: 'cyber',
      colorA: '#00d2ff',
      colorB: '#ff007f',
      trigger: 'beat',
      divider: 1,
      intensity: 85,
      decayMs: 220,
      blend: 'plus-lighter',
      edgeWidth: 10,
      dmxMode: 'chase'
    },
    'Chớp 4 Góc': {
      on: true,
      mode: 'quadrant',
      palette: 'fire',
      colorA: '#ff3b00',
      colorB: '#ffd000',
      trigger: 'bass',
      divider: 1,
      intensity: 90,
      decayMs: 180,
      blend: 'screen',
      edgeWidth: 14,
      dmxMode: 'chase'
    },
    'Equalizer LED': {
      on: true,
      mode: 'matrix-bars',
      palette: 'rainbow',
      colorA: '#ff0055',
      colorB: '#00d2ff',
      trigger: 'bass',
      divider: 1,
      intensity: 85,
      decayMs: 200,
      blend: 'plus-lighter',
      edgeWidth: 10,
      dmxMode: 'rainbow-beat'
    },
    'Gala Nhẹ': {
      on: true,
      mode: 'wash',
      palette: 'gala',
      colorA: '#ffd700',
      colorB: '#fff1b8',
      trigger: 'beat',
      divider: 0.5,
      intensity: 55,
      decayMs: 360,
      blend: 'screen',
      edgeWidth: 8,
      dmxMode: 'bass-dimmer'
    },
    'Âm bản Kick': {
      on: true,
      mode: 'invert-hit',
      palette: 'ice',
      colorA: '#00f5d4',
      colorB: '#00bbf9',
      trigger: 'bass',
      divider: 1,
      intensity: 90,
      decayMs: 140,
      blend: 'difference',
      edgeWidth: 12,
      dmxMode: 'beat-flash'
    }
  };

  const VALID_LED_TRIGGERS = ['beat', 'bass', 'mid', 'high', 'all'];
  const VALID_DIVIDERS = [0.25, 0.5, 1, 2, 4];
  const VALID_DMX_MODES = ['beat-flash', 'chase', 'rainbow-beat', 'bass-dimmer', 'strobe', 'solid'];
  const VALID_FIXTURE_TYPES = ['rgb', 'rgbw', 'drgb', 'drgbs', 'drgbws', 'strobe'];

  /** Các bộ thông số hiệu ứng beat + rung nền cài sẵn (1 chạm) */
  const FX_PRESETS = {
    'Nảy nhẹ': {
      scale: 5.5, shake: 6, rot: 0.7, bright: 22, hue: 0,
      flash: 0, decay: 280, motion: 'smooth', step: false, over: true,
      idleOn: true, idleAmp: 5, idleRot: 0.35, idleBreath: 0.6, idleSpeed: 2.0,
      idleStyle: 'smooth', idleCouple: 0.5, idleOnlyMusic: true
    },
    'Giật mạnh': {
      scale: 13, shake: 24, rot: 2.8, bright: 55, hue: 12,
      flash: 20, decay: 210, motion: 'spring', step: false, over: true,
      idleOn: true, idleAmp: 8, idleRot: 0.65, idleBreath: 0.9, idleSpeed: 3.4,
      idleStyle: 'jitter', idleCouple: 0.9, idleOnlyMusic: true
    },
    'Chớp': {
      scale: 4.5, shake: 7, rot: 0.4, bright: 95, hue: 0,
      flash: 60, decay: 200, motion: 'smooth', step: false, over: true,
      idleOn: true, idleAmp: 4.5, idleRot: 0.3, idleBreath: 0.5, idleSpeed: 2.2,
      idleStyle: 'smooth', idleCouple: 0.6, idleOnlyMusic: true
    },
    'Glitch': {
      scale: 10, shake: 36, rot: 4.5, bright: 75, hue: 90,
      flash: 30, decay: 150, motion: 'step', step: true, over: true,
      idleOn: true, idleAmp: 7, idleRot: 0.8, idleBreath: 0.7, idleSpeed: 4.8,
      idleStyle: 'jitter', idleCouple: 1.1, idleOnlyMusic: true
    },
    'Remix bass': {
      scale: 6.5, shake: 14, rot: 1.2, bright: 32, hue: 0,
      flash: 0, decay: 210, motion: 'spring', step: false, over: true,
      idleOn: true, idleAmp: 6, idleRot: 0.45, idleBreath: 0.7, idleSpeed: 2.6,
      idleStyle: 'smooth', idleCouple: 0.85, idleOnlyMusic: true
    }
  };

  /** Các bộ preset thông số phân tích dải bass 1 chạm (Mục 1.3) */
  const BASS_PRESETS = {
    'Remix bass nhanh': { sens: 7, minInterval: 90, bassLow: 35, bassHigh: 140 },
    'EDM / House': { sens: 6, minInterval: 150, bassLow: 40, bassHigh: 150 },
    'Nhạc chậm / ballad': { sens: 5, minInterval: 250, bassLow: 40, bassHigh: 200 }
  };

  /** Danh sách đuôi file hợp lệ và đuôi dễ lỗi codec trên Chromium/Electron */
  const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.opus'];
  const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg'];
  const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.m4v'];
  const RISKY_VIDEO_EXTENSIONS = ['.mov', '.avi', '.mkv', '.wmv', '.flv', '.hevc', '.h265', '.ts', '.mts'];

  /**
   * Giới hạn giá trị trong khoảng [min, max]
   */
  function clamp(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return min;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  /**
   * Tạo UUID v4 đơn giản không cần thư viện ngoài
   */
  function generateId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return 'cue-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /**
   * Chuẩn hóa chuỗi màu hex (#rgb, #rrggbb) về dạng #rrggbb an toàn
   */
  function normalizeHexColor(hex, fallback) {
    const fb = typeof fallback === 'string' && /^#[0-9a-fA-F]{6}$/.test(fallback) ? fallback.toLowerCase() : '#ffffff';
    if (typeof hex !== 'string') return fb;
    let clean = hex.trim();
    if (!clean.startsWith('#')) clean = '#' + clean;
    if (/^#[0-9a-fA-F]{3}$/.test(clean)) {
      return (
        '#' +
        clean[1] + clean[1] +
        clean[2] + clean[2] +
        clean[3] + clean[3]
      ).toLowerCase();
    }
    if (/^#[0-9a-fA-F]{6}$/.test(clean)) {
      return clean.toLowerCase();
    }
    if (/^#[0-9a-fA-F]{8}$/.test(clean)) {
      return clean.slice(0, 7).toLowerCase();
    }
    return fb;
  }

  /**
   * Chuyển mã màu hex (#rgb / #rrggbb / #rrggbbaa) sang { r, g, b } (0..255)
   */
  function hexToRgb(hex) {
    if (typeof hex !== 'string') return { r: 0, g: 0, b: 0 };
    let clean = hex.trim();
    if (clean.startsWith('#')) clean = clean.slice(1);
    if (/^[0-9a-fA-F]{3}$/.test(clean)) {
      return {
        r: parseInt(clean[0] + clean[0], 16),
        g: parseInt(clean[1] + clean[1], 16),
        b: parseInt(clean[2] + clean[2], 16)
      };
    }
    if (/^[0-9a-fA-F]{6}$/.test(clean) || /^[0-9a-fA-F]{8}$/.test(clean)) {
      return {
        r: parseInt(clean.slice(0, 2), 16),
        g: parseInt(clean.slice(2, 4), 16),
        b: parseInt(clean.slice(4, 6), 16)
      };
    }
    return { r: 0, g: 0, b: 0 };
  }

  /**
   * Chuẩn hóa bộ chia nhịp (divider) về một trong các mốc hợp lệ [0.25, 0.5, 1, 2, 4]
   */
  function normalizeBeatDivider(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 1;
    let best = VALID_DIVIDERS[0];
    let bestDist = Math.abs(n - best);
    for (let i = 1; i < VALID_DIVIDERS.length; i++) {
      const dist = Math.abs(n - VALID_DIVIDERS[i]);
      if (dist < bestDist) {
        best = VALID_DIVIDERS[i];
        bestDist = dist;
      }
    }
    return best;
  }

  /**
   * Trả về danh sách mã màu hex hiện dùng cho LED Sync
   */
  function resolvePaletteColors(ledSync) {
    const cfg = ledSync && typeof ledSync === 'object' ? ledSync : {};
    if (cfg.palette === 'custom') {
      return [
        normalizeHexColor(cfg.colorA, '#00d2ff'),
        normalizeHexColor(cfg.colorB, '#ff007f')
      ];
    }
    const entry = Object.prototype.hasOwnProperty.call(LED_PALETTES, cfg.palette)
      ? LED_PALETTES[cfg.palette]
      : LED_PALETTES.cyber;
    if (entry && Array.isArray(entry.colors) && entry.colors.length > 0) {
      return entry.colors.slice();
    }
    return LED_PALETTES.cyber.colors.slice();
  }

  /**
   * Tạo cấu hình hiệu ứng beat + phân tích bass + rung nền mặc định (tương thích dự án cũ)
   */
  function createDefaultFx(overrides) {
    const base = {
      on: false,
      src: 'auto',
      bpm: 120,
      off: 0,
      sens: 6,
      minInterval: 100,
      bassLow: 35,
      bassHigh: 150,
      delayMs: 50,
      scale: 6,
      shake: 12,
      rot: 1.5,
      bright: 40,
      hue: 0,
      flash: 0,
      decay: 240,
      motion: 'smooth', // 'smooth' | 'step' | 'spring'
      step: false,
      over: true,
      idleOn: false,
      idleAmp: 5,
      idleRot: 0.35,
      idleBreath: 0.6,
      idleSpeed: 2.2,
      idleStyle: 'smooth', // 'smooth' | 'jitter'
      idleCouple: 0.6,
      idleOnlyMusic: true
    };
    if (!overrides || typeof overrides !== 'object') return base;

    const isOn = Boolean(overrides.on ?? base.on);
    const hasMotion = ['smooth', 'step', 'spring'].includes(overrides.motion);
    const motion = hasMotion
      ? overrides.motion
      : (overrides.step ? 'step' : 'smooth');

    let bassLow = clamp(overrides.bassLow ?? base.bassLow, 20, 80);
    let bassHigh = clamp(overrides.bassHigh ?? base.bassHigh, 80, 250);
    if (bassHigh <= bassLow + 15) {
      bassHigh = clamp(bassLow + 30, 80, 250);
    }

    return {
      on: isOn,
      src: ['auto', 'video', 'bpm', 'ext'].includes(overrides.src) ? overrides.src : 'auto',
      bpm: clamp(overrides.bpm ?? base.bpm, 40, 240),
      off: clamp(overrides.off ?? base.off, -5, 5),
      sens: clamp(overrides.sens ?? base.sens, 1, 10),
      minInterval: clamp(overrides.minInterval ?? base.minInterval, 60, 300),
      bassLow,
      bassHigh,
      delayMs: clamp(overrides.delayMs ?? base.delayMs, 0, 200),
      scale: clamp(overrides.scale ?? base.scale, 0, 25),
      shake: clamp(overrides.shake ?? base.shake, 0, 60),
      rot: clamp(overrides.rot ?? base.rot, 0, 8),
      bright: clamp(overrides.bright ?? base.bright, 0, 150),
      hue: clamp(overrides.hue ?? base.hue, 0, 120),
      flash: clamp(overrides.flash ?? base.flash, 0, 90),
      decay: clamp(overrides.decay ?? base.decay, 60, 800),
      motion,
      step: motion === 'step',
      over: Boolean(overrides.over ?? base.over),
      // Nếu dự án cũ không có trường idleOn: mặc định bật theo fx.on
      idleOn: overrides.idleOn !== undefined ? Boolean(overrides.idleOn) : isOn,
      idleAmp: clamp(overrides.idleAmp ?? base.idleAmp, 0, 40),
      idleRot: clamp(overrides.idleRot ?? base.idleRot, 0, 4),
      idleBreath: clamp(overrides.idleBreath ?? base.idleBreath, 0, 5),
      idleSpeed: clamp(overrides.idleSpeed ?? base.idleSpeed, 0.2, 8),
      idleStyle: overrides.idleStyle === 'jitter' ? 'jitter' : 'smooth',
      idleCouple: clamp(overrides.idleCouple ?? base.idleCouple, 0, 1.5),
      idleOnlyMusic: overrides.idleOnlyMusic !== undefined ? Boolean(overrides.idleOnlyMusic) : base.idleOnlyMusic
    };
  }

  /**
   * Tạo cấu hình chữ hiển thị trên LED theo cue
   */
  function createDefaultTextOverlay(overrides) {
    const base = {
      on: false,
      content: '',
      size: 56,
      pos: 'bottom',
      color: '#ffffff',
      bgBox: true
    };
    if (!overrides || typeof overrides !== 'object') return base;
    const pos = ['top', 'center', 'bottom'].includes(overrides.pos) ? overrides.pos : 'bottom';
    return {
      on: Boolean(overrides.on),
      content: typeof overrides.content === 'string' ? overrides.content : '',
      size: clamp(overrides.size ?? base.size, 18, 180),
      pos,
      color: typeof overrides.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(overrides.color)
        ? overrides.color
        : '#ffffff',
      bgBox: Boolean(overrides.bgBox ?? base.bgBox)
    };
  }

  /**
   * Tạo cấu hình đồng bộ chớp đèn LED / DMX theo beat cho từng cue
   */
  function createDefaultLedSync(overrides) {
    const base = {
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
      edgeWidth: 10,
      dmxMode: 'beat-flash'
    };
    if (!overrides || typeof overrides !== 'object') return base;

    return {
      on: overrides.on !== undefined ? Boolean(overrides.on) : base.on,
      mode: LED_STROBE_MODES.includes(overrides.mode) ? overrides.mode : base.mode,
      palette: Object.prototype.hasOwnProperty.call(LED_PALETTES, overrides.palette)
        ? overrides.palette
        : base.palette,
      colorA: normalizeHexColor(overrides.colorA, base.colorA),
      colorB: normalizeHexColor(overrides.colorB, base.colorB),
      trigger: VALID_LED_TRIGGERS.includes(overrides.trigger) ? overrides.trigger : base.trigger,
      divider: overrides.divider !== undefined ? normalizeBeatDivider(overrides.divider) : base.divider,
      intensity: clamp(overrides.intensity ?? base.intensity, 0, 100),
      decayMs: clamp(overrides.decayMs ?? base.decayMs, 40, 1200),
      blend: BLEND_MODES.includes(overrides.blend) ? overrides.blend : base.blend,
      edgeWidth: clamp(overrides.edgeWidth ?? base.edgeWidth, 1, 40),
      dmxMode: VALID_DMX_MODES.includes(overrides.dmxMode) ? overrides.dmxMode : base.dmxMode
    };
  }

  /**
   * Tạo cấu hình 4 lớp Overlay kiểu vMix (Lower Third, Logo, Timer, Marquee Ticker)
   */
  function createDefaultOverlays(overrides) {
    const src = overrides && typeof overrides === 'object' ? overrides : {};
    const o1 = src.ov1 && typeof src.ov1 === 'object' ? src.ov1 : {};
    const o2 = src.ov2 && typeof src.ov2 === 'object' ? src.ov2 : {};
    const o3 = src.ov3 && typeof src.ov3 === 'object' ? src.ov3 : {};
    const o4 = src.ov4 && typeof src.ov4 === 'object' ? src.ov4 : {};

    const validThemes = ['modern', 'neon', 'corporate', 'breaking'];
    const validOv1Pos = ['bottom-left', 'bottom-right', 'bottom-center', 'top-left', 'top-right'];
    const validCornerPos = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    const validTimerPos = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
    const validTimerModes = ['countdown', 'clock', 'countup'];
    const validTickerPos = ['top', 'bottom'];

    return {
      ov1: {
        active: Boolean(o1.active),
        title: typeof o1.title === 'string' ? o1.title : '',
        subtitle: typeof o1.subtitle === 'string' ? o1.subtitle : '',
        theme: validThemes.includes(o1.theme) ? o1.theme : 'modern',
        pos: validOv1Pos.includes(o1.pos) ? o1.pos : 'bottom-left',
        accentColor: normalizeHexColor(o1.accentColor, '#00d2ff'),
        autoHideSec: clamp(o1.autoHideSec ?? 0, 0, 3600)
      },
      ov2: {
        active: Boolean(o2.active),
        path: typeof o2.path === 'string' && o2.path.trim() ? o2.path.trim() : null,
        pos: validCornerPos.includes(o2.pos) ? o2.pos : 'top-right',
        scale: clamp(o2.scale ?? 14, 3, 60),
        opacity: clamp(o2.opacity ?? 90, 0, 100),
        margin: clamp(o2.margin ?? 28, 0, 200)
      },
      ov3: {
        active: Boolean(o3.active),
        mode: validTimerModes.includes(o3.mode) ? o3.mode : 'countdown',
        durationSec: clamp(o3.durationSec ?? 300, 0, 86400),
        targetTime: typeof o3.targetTime === 'string' && /^\d{1,2}:\d{2}$/.test(o3.targetTime.trim())
          ? o3.targetTime.trim()
          : '20:00',
        label: typeof o3.label === 'string' ? o3.label : 'ĐẾM NGƯỢC',
        pos: validTimerPos.includes(o3.pos) ? o3.pos : 'top-left',
        size: clamp(o3.size ?? 46, 16, 180),
        color: normalizeHexColor(o3.color, '#ffffff'),
        warnSec: clamp(o3.warnSec ?? 30, 0, 3600),
        running: Boolean(o3.running)
      },
      ov4: {
        active: Boolean(o4.active),
        text: typeof o4.text === 'string' ? o4.text : '',
        pos: validTickerPos.includes(o4.pos) ? o4.pos : 'bottom',
        speed: clamp(o4.speed ?? 85, 10, 400),
        size: clamp(o4.size ?? 28, 14, 120),
        color: normalizeHexColor(o4.color, '#ffffff'),
        bgColor: normalizeHexColor(o4.bgColor, '#08101c'),
        bgOpacity: clamp(o4.bgOpacity ?? 82, 0, 100)
      }
    };
  }

  /**
   * Chuẩn hóa một ô clip trong VJ Deck
   */
  function normalizeVjClip(rawClip, fallbackId) {
    const c = rawClip && typeof rawClip === 'object' ? rawClip : {};
    const validKinds = ['empty', 'image', 'video', 'generator', 'camera'];
    const kind = validKinds.includes(c.kind) ? c.kind : 'empty';
    const generator = VJ_GENERATORS.includes(c.generator) ? c.generator : 'laser-beams';
    const defaultName = kind === 'empty' ? 'Trống' : generator;
    return {
      id: typeof c.id === 'string' && c.id.trim() ? c.id.trim() : fallbackId,
      name: typeof c.name === 'string' && c.name.trim() ? c.name.trim() : defaultName,
      kind,
      path: typeof c.path === 'string' && c.path.trim() ? c.path.trim() : null,
      generator,
      cameraId: typeof c.cameraId === 'string' ? c.cameraId : '',
      color: normalizeHexColor(c.color, '#00d2ff'),
      speed: clamp(c.speed ?? 1, 0.1, 4),
      loop: c.loop !== undefined ? Boolean(c.loop) : true,
      vsound: c.vsound !== undefined ? Boolean(c.vsound) : (kind === 'video')
    };
  }

  /**
   * Tạo cấu hình VJ Deck 3 tầng x 4 cột (3 deck A/B/C) kiểu Resolume
   */
  function createDefaultVjDeck(overrides) {
    const src = overrides && typeof overrides === 'object' ? overrides : {};
    const defaultLayers = [
      { id: 'vj-l1', name: 'Layer 1 (Nền)', opacity: 100, blend: 'normal', speed: 1, bypass: false, solo: false, audioReact: false, activeClipId: null },
      { id: 'vj-l2', name: 'Layer 2 (Giữa)', opacity: 100, blend: 'screen', speed: 1, bypass: false, solo: false, audioReact: false, activeClipId: null },
      { id: 'vj-l3', name: 'Layer 3 (Chớp/Overlay)', opacity: 100, blend: 'plus-lighter', speed: 1, bypass: false, solo: false, audioReact: false, activeClipId: null }
    ];

    const layers = defaultLayers.map((def, idx) => {
      const rawLayer = Array.isArray(src.layers) && src.layers[idx] && typeof src.layers[idx] === 'object'
        ? src.layers[idx]
        : {};
      return {
        id: def.id,
        name: typeof rawLayer.name === 'string' && rawLayer.name.trim() ? rawLayer.name.trim() : def.name,
        opacity: clamp(rawLayer.opacity ?? def.opacity, 0, 100),
        blend: BLEND_MODES.includes(rawLayer.blend) ? rawLayer.blend : def.blend,
        speed: clamp(rawLayer.speed ?? def.speed, 0.1, 4),
        bypass: Boolean(rawLayer.bypass),
        solo: Boolean(rawLayer.solo),
        audioReact: Boolean(rawLayer.audioReact),
        activeClipId: typeof rawLayer.activeClipId === 'string' && rawLayer.activeClipId.trim()
          ? rawLayer.activeClipId.trim()
          : null
      };
    });

    const buildEmptyDeck = (deckIdx) => {
      const matrix = [];
      for (let l = 0; l < 3; l++) {
        const row = [];
        for (let c = 0; c < 4; c++) {
          row.push(normalizeVjClip({ kind: 'empty', name: 'Trống' }, `clip-d${deckIdx}-l${l}-c${c}`));
        }
        matrix.push(row);
      }
      return matrix;
    };

    const hasProvidedDecks = Array.isArray(src.decks);
    const decks = [0, 1, 2].map((deckIdx) => {
      if (!hasProvidedDecks) {
        const deck = buildEmptyDeck(deckIdx);
        if (deckIdx === 0) {
          // Deck A Layer 2 (index 1): 2 ambient generators + 2 empty slots
          deck[1][0] = normalizeVjClip({
            id: 'clip-d0-l1-c0',
            name: 'Lưới Cyber',
            kind: 'generator',
            generator: 'cyber-grid',
            color: '#00d2ff'
          });
          deck[1][1] = normalizeVjClip({
            id: 'clip-d0-l1-c1',
            name: 'Sóng Plasma',
            kind: 'generator',
            generator: 'plasma-wave',
            color: '#ff007f'
          });
          // Deck A Layer 3 (index 2): 4 ready-to-play generators
          deck[2][0] = normalizeVjClip({
            id: 'clip-d0-l2-c0',
            name: 'Tia Laser',
            kind: 'generator',
            generator: 'laser-beams',
            color: '#00d2ff'
          });
          deck[2][1] = normalizeVjClip({
            id: 'clip-d0-l2-c1',
            name: 'Ma trận Chớp',
            kind: 'generator',
            generator: 'strobe-matrix',
            color: '#ffffff'
          });
          deck[2][2] = normalizeVjClip({
            id: 'clip-d0-l2-c2',
            name: 'Vòng Sóng',
            kind: 'generator',
            generator: 'pulse-rings',
            color: '#ff007f'
          });
          deck[2][3] = normalizeVjClip({
            id: 'clip-d0-l2-c3',
            name: 'Cột Nhạc',
            kind: 'generator',
            generator: 'spectrum-bars',
            color: '#00f5d4'
          });
        }
        return deck;
      }

      const rawDeck = Array.isArray(src.decks[deckIdx]) ? src.decks[deckIdx] : [];
      const matrix = [];
      for (let l = 0; l < 3; l++) {
        const rawRow = Array.isArray(rawDeck[l]) ? rawDeck[l] : [];
        const row = [];
        for (let c = 0; c < 4; c++) {
          row.push(normalizeVjClip(rawRow[c], `clip-d${deckIdx}-l${l}-c${c}`));
        }
        matrix.push(row);
      }
      return matrix;
    });

    const activeDeckIndex = Math.round(clamp(src.activeDeckIndex ?? 0, 0, 2));

    return {
      activeDeckIndex,
      layers,
      decks
    };
  }

  /**
   * Tạo cấu hình Master FX Rack (hiệu ứng tổng xuất ra màn hình LED)
   */
  function createDefaultMasterFx(overrides) {
    const base = {
      dimmer: 100,
      contrast: 100,
      saturate: 100,
      hue: 0,
      rgbSplit: 0,
      rgbBeatLink: false,
      mirror: 'none',
      glitch: 0,
      glitchBeatLink: false,
      vignette: 0,
      invert: false,
      pixelate: 0
    };
    if (!overrides || typeof overrides !== 'object') return base;
    const validMirrors = ['none', 'mirror-h', 'mirror-v', 'quad', 'kaleido'];
    return {
      dimmer: clamp(overrides.dimmer ?? base.dimmer, 0, 100),
      contrast: clamp(overrides.contrast ?? base.contrast, 20, 200),
      saturate: clamp(overrides.saturate ?? base.saturate, 0, 250),
      hue: clamp(overrides.hue ?? base.hue, -180, 360),
      rgbSplit: clamp(overrides.rgbSplit ?? base.rgbSplit, 0, 100),
      rgbBeatLink: Boolean(overrides.rgbBeatLink),
      mirror: validMirrors.includes(overrides.mirror) ? overrides.mirror : 'none',
      glitch: clamp(overrides.glitch ?? base.glitch, 0, 100),
      glitchBeatLink: Boolean(overrides.glitchBeatLink),
      vignette: clamp(overrides.vignette ?? base.vignette, 0, 100),
      invert: Boolean(overrides.invert),
      pixelate: clamp(overrides.pixelate ?? base.pixelate, 0, 100)
    };
  }

  /**
   * Tạo cấu hình cắt khung & hiệu chỉnh phối cảnh Keystone đầu ra LED
   */
  function createDefaultOutputMapping(overrides) {
    const base = {
      cropTop: 0,
      cropBottom: 0,
      cropLeft: 0,
      cropRight: 0,
      offsetX: 0,
      offsetY: 0,
      scaleX: 100,
      scaleY: 100,
      rotateX: 0,
      rotateY: 0,
      perspective: 1200,
      flipH: false,
      flipV: false
    };
    if (!overrides || typeof overrides !== 'object') return base;
    return {
      cropTop: clamp(overrides.cropTop ?? base.cropTop, 0, 45),
      cropBottom: clamp(overrides.cropBottom ?? base.cropBottom, 0, 45),
      cropLeft: clamp(overrides.cropLeft ?? base.cropLeft, 0, 45),
      cropRight: clamp(overrides.cropRight ?? base.cropRight, 0, 45),
      offsetX: clamp(overrides.offsetX ?? base.offsetX, -500, 500),
      offsetY: clamp(overrides.offsetY ?? base.offsetY, -500, 500),
      scaleX: clamp(overrides.scaleX ?? base.scaleX, 10, 300),
      scaleY: clamp(overrides.scaleY ?? base.scaleY, 10, 300),
      rotateX: clamp(overrides.rotateX ?? base.rotateX, -45, 45),
      rotateY: clamp(overrides.rotateY ?? base.rotateY, -45, 45),
      perspective: clamp(overrides.perspective ?? base.perspective, 200, 5000),
      flipH: Boolean(overrides.flipH),
      flipV: Boolean(overrides.flipV)
    };
  }

  /**
   * Tạo cấu hình DMX Art-Net / sACN và 8 đèn Par LED mặc định (kênh 1,5,9,13,17,21,25,29)
   */
  function createDefaultDmxConfig(overrides) {
    const defaultFixtures = [];
    for (let i = 0; i < 8; i++) {
      defaultFixtures.push({
        id: `fix-${i + 1}`,
        name: `Par LED ${i + 1}`,
        type: 'drgb',
        startChannel: 1 + i * 4,
        group: i < 4 ? 'A' : 'B'
      });
    }

    const base = {
      enabled: false,
      protocol: 'artnet',
      host: '255.255.255.255',
      port: 6454,
      universe: 0,
      fps: 35,
      masterDimmer: 100,
      blackout: false,
      fixtures: defaultFixtures
    };
    if (!overrides || typeof overrides !== 'object') return base;

    const protocol = overrides.protocol === 'sacn' ? 'sacn' : 'artnet';
    const fixtures = Array.isArray(overrides.fixtures)
      ? overrides.fixtures.map((f, idx) => {
        const rawF = f && typeof f === 'object' ? f : {};
        return {
          id: typeof rawF.id === 'string' && rawF.id.trim() ? rawF.id.trim() : `fix-${idx + 1}`,
          name: typeof rawF.name === 'string' && rawF.name.trim() ? rawF.name.trim() : `Đèn ${idx + 1}`,
          type: VALID_FIXTURE_TYPES.includes(rawF.type) ? rawF.type : 'drgb',
          startChannel: Math.round(clamp(rawF.startChannel ?? (1 + idx * 4), 1, 512)),
          group: typeof rawF.group === 'string' && rawF.group.trim() ? rawF.group.trim() : 'A'
        };
      })
      : defaultFixtures;

    return {
      enabled: Boolean(overrides.enabled),
      protocol,
      host: typeof overrides.host === 'string' && overrides.host.trim()
        ? overrides.host.trim()
        : base.host,
      port: Math.round(clamp(overrides.port ?? (protocol === 'sacn' ? 5568 : 6454), 1, 65535)),
      universe: Math.round(clamp(overrides.universe ?? (protocol === 'sacn' ? 1 : 0), 0, 63999)),
      fps: Math.round(clamp(overrides.fps ?? base.fps, 5, 44)),
      masterDimmer: clamp(overrides.masterDimmer ?? base.masterDimmer, 0, 100),
      blackout: Boolean(overrides.blackout),
      fixtures
    };
  }

  /**
   * Tạo cấu hình máy chủ OSC UDP
   */
  function createDefaultOscConfig(overrides) {
    const base = { enabled: false, port: 9000 };
    if (!overrides || typeof overrides !== 'object') return base;
    return {
      enabled: Boolean(overrides.enabled),
      port: Math.round(clamp(overrides.port ?? base.port, 1, 65535))
    };
  }

  /**
   * Tạo một cue mặc định đầy đủ trường
   */
  function createDefaultCue(overrides) {
    const src = overrides && typeof overrides === 'object' ? overrides : {};
    return normalizeCue({
      id: src.id || generateId(),
      name: typeof src.name === 'string' && src.name.trim() ? src.name : 'Cue mới',
      note: typeof src.note === 'string' ? src.note : '',

      aud: src.aud ?? null,
      vol: src.vol ?? 100,
      fadeIn: src.fadeIn ?? 0.5,
      fadeOut: src.fadeOut ?? 0.8,
      keepAudio: src.keepAudio ?? false,
      stop: src.keepAudio ? false : true,
      startAt: src.startAt ?? 0,
      endAt: src.endAt ?? 0,

      sourceType: src.sourceType ?? 'media',
      cameraId: src.cameraId ?? '',
      generator: src.generator ?? 'laser-beams',
      vis: src.vis ?? null,
      tr: src.tr ?? 'fade',
      dur: src.dur ?? 0.8,
      fit: src.fit ?? 'contain',
      loop: src.loop ?? true,
      vsound: src.vsound ?? true,
      vvol: src.vvol ?? 100,

      autoFollow: src.autoFollow ?? 'none',
      autoDelay: src.autoDelay ?? 5,

      text: src.text,
      fx: src.fx,
      ledSync: src.ledSync
    });
  }

  /**
   * Chuẩn hóa dữ liệu một cue bất kỳ để tương thích ngược dự án cũ
   */
  function normalizeCue(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const tr = TRANSITION_TYPES.includes(c.tr) ? c.tr : 'fade';
    const fit = c.fit === 'cover' ? 'cover' : 'contain';
    const autoFollow = ['none', 'time', 'audio-end'].includes(c.autoFollow) ? c.autoFollow : 'none';
    const sourceType = ['media', 'camera', 'generator'].includes(c.sourceType) ? c.sourceType : 'media';
    const generator = VJ_GENERATORS.includes(c.generator) ? c.generator : 'laser-beams';
    const startAt = Math.max(0, Number(c.startAt) || 0);
    let endAt = Math.max(0, Number(c.endAt) || 0);
    if (endAt > 0 && endAt <= startAt) {
      endAt = 0;
    }

    return {
      id: typeof c.id === 'string' && c.id ? c.id : generateId(),
      name: typeof c.name === 'string' && c.name.trim() ? c.name.trim() : 'Cue chưa đặt tên',
      note: typeof c.note === 'string' ? c.note : '',

      aud: typeof c.aud === 'string' && c.aud.trim() ? c.aud.trim() : null,
      vol: clamp(c.vol ?? 100, 0, 100),
      fadeIn: clamp(c.fadeIn ?? 0.5, 0, 15),
      fadeOut: clamp(c.fadeOut ?? 0.8, 0, 15),
      keepAudio: Boolean(c.keepAudio),
      stop: !Boolean(c.keepAudio),
      startAt,
      endAt,

      sourceType,
      cameraId: typeof c.cameraId === 'string' ? c.cameraId : '',
      generator,
      vis: typeof c.vis === 'string' && c.vis.trim() ? c.vis.trim() : null,
      tr,
      dur: clamp(c.dur ?? 0.8, 0, 10),
      fit,
      loop: c.loop !== undefined ? Boolean(c.loop) : true,
      // Tương thích dự án cũ chưa có vvol: mặc định bật tiếng gốc cho video để không bị mất tiếng
      vsound: c.vvol === undefined && c.vis && detectMediaKind(c.vis) === 'video'
        ? true
        : (c.vsound !== undefined ? Boolean(c.vsound) : true),
      vvol: clamp(c.vvol ?? 100, 0, 100),

      autoFollow,
      autoDelay: clamp(c.autoDelay ?? 5, 0.2, 3600),

      text: createDefaultTextOverlay(c.text),
      fx: createDefaultFx(c.fx),
      ledSync: createDefaultLedSync(c.ledSync)
    };
  }

  /**
   * Tạo 6 ô hiệu ứng âm thanh (SFX Square Pads) mặc định kèm phím tắt F1..F6
   */
  function createDefaultSfxPads(rawPads) {
    const defaults = [
      { id: 'sfx-1', name: 'Vỗ tay', path: null, vol: 90, color: 'emerald', hotkey: 'F1', hotkeyLabel: 'F1' },
      { id: 'sfx-2', name: 'Fanfare', path: null, vol: 90, color: 'amber', hotkey: 'F2', hotkeyLabel: 'F2' },
      { id: 'sfx-3', name: 'Trống hồi', path: null, vol: 90, color: 'rose', hotkey: 'F3', hotkeyLabel: 'F3' },
      { id: 'sfx-4', name: 'Ting!', path: null, vol: 90, color: 'cyber', hotkey: 'F4', hotkeyLabel: 'F4' },
      { id: 'sfx-5', name: 'Hò reo', path: null, vol: 90, color: 'violet', hotkey: 'F5', hotkeyLabel: 'F5' },
      { id: 'sfx-6', name: 'Báo hiệu', path: null, vol: 90, color: 'blue', hotkey: 'F6', hotkeyLabel: 'F6' }
    ];
    if (!Array.isArray(rawPads)) return defaults;
    const validColors = ['emerald', 'amber', 'rose', 'cyber', 'violet', 'blue'];
    return defaults.map((def, idx) => {
      const p = rawPads[idx] && typeof rawPads[idx] === 'object' ? rawPads[idx] : {};
      const hasExplicitHotkey = typeof p.hotkey === 'string';
      const normalizedHotkey = hasExplicitHotkey ? p.hotkey.trim() : def.hotkey;
      const normalizedLabel = normalizedHotkey
        ? (typeof p.hotkeyLabel === 'string' && p.hotkeyLabel.trim() ? p.hotkeyLabel.trim() : normalizedHotkey)
        : '---';
      return {
        id: def.id,
        name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : def.name,
        path: typeof p.path === 'string' && p.path.trim() ? p.path.trim() : null,
        vol: clamp(p.vol ?? def.vol, 0, 100),
        color: validColors.includes(p.color) ? p.color : def.color,
        hotkey: normalizedHotkey,
        hotkeyLabel: normalizedLabel
      };
    });
  }

  /**
   * Tạo cấu trúc dự án v2 trống mặc định
   */
  function createEmptyProjectV2() {
    return {
      version: 2,
      cues: [],
      sfxPads: createDefaultSfxPads(),
      customFxPresets: {},
      overlays: createDefaultOverlays(),
      vjDeck: createDefaultVjDeck(),
      masterFx: createDefaultMasterFx(),
      outputMapping: createDefaultOutputMapping(),
      dmxConfig: createDefaultDmxConfig(),
      oscConfig: createDefaultOscConfig()
    };
  }

  /**
   * Kiểm tra và chuẩn hóa toàn bộ file dự án JSON (hỗ trợ v1 và v2)
   */
  function validateAndMigrateProject(raw) {
    if (!raw || typeof raw !== 'object') {
      return {
        ok: false,
        error: 'Dữ liệu dự án không phải đối tượng JSON hợp lệ.',
        warnings: [],
        project: createEmptyProjectV2()
      };
    }

    const warnings = [];
    let rawCues = [];

    if (Array.isArray(raw.cues)) {
      rawCues = raw.cues;
    } else if (Array.isArray(raw)) {
      warnings.push('Đã chuyển đổi danh sách cue cũ sang định dạng dự án v2.');
      rawCues = raw;
    } else {
      return {
        ok: false,
        error: 'File dự án thiếu danh sách "cues".',
        warnings: [],
        project: createEmptyProjectV2()
      };
    }

    if (raw.version !== undefined && raw.version !== 1 && raw.version !== 2) {
      warnings.push(`Phiên bản dự án ${raw.version} đã được chuẩn hóa về phiên bản 2.`);
    }

    const seenIds = new Set();
    const cues = rawCues.map((item) => {
      const cue = normalizeCue(item);
      if (seenIds.has(cue.id)) {
        cue.id = generateId();
      }
      seenIds.add(cue.id);
      return cue;
    });

    const customFxPresets = {};
    if (raw.customFxPresets && typeof raw.customFxPresets === 'object') {
      for (const [k, v] of Object.entries(raw.customFxPresets)) {
        if (typeof k === 'string' && k.trim() && v && typeof v === 'object') {
          const normalized = createDefaultFx(v);
          customFxPresets[k.trim()] = {
            scale: normalized.scale,
            shake: normalized.shake,
            rot: normalized.rot,
            bright: normalized.bright,
            hue: normalized.hue,
            flash: normalized.flash,
            decay: normalized.decay,
            motion: normalized.motion,
            step: normalized.step,
            over: normalized.over,
            idleOn: normalized.idleOn,
            idleAmp: normalized.idleAmp,
            idleRot: normalized.idleRot,
            idleBreath: normalized.idleBreath,
            idleSpeed: normalized.idleSpeed,
            idleStyle: normalized.idleStyle,
            idleCouple: normalized.idleCouple,
            idleOnlyMusic: normalized.idleOnlyMusic
          };
        }
      }
    }

    return {
      ok: true,
      error: null,
      warnings,
      project: {
        version: 2,
        cues,
        sfxPads: createDefaultSfxPads(raw.sfxPads),
        customFxPresets,
        overlays: createDefaultOverlays(raw.overlays),
        vjDeck: createDefaultVjDeck(raw.vjDeck),
        masterFx: createDefaultMasterFx(raw.masterFx),
        outputMapping: createDefaultOutputMapping(raw.outputMapping),
        dmxConfig: createDefaultDmxConfig(raw.dmxConfig),
        oscConfig: createDefaultOscConfig(raw.oscConfig)
      }
    };
  }

  /**
   * Lõi thuật toán phát hiện bass onset thuần (KHÔNG dùng biến ngoài thân hàm,
   * để nhúng trực tiếp vào AudioWorkletProcessor bằng Function.prototype.toString()).
   *
   * Mỗi block 128 mẫu (~2.67 ms @ 48 kHz):
   * 1. Tính năng lượng RMS mượt qua cửa sổ 6 block (~16 ms, triệt gợn sóng sin đều 60–80 Hz).
   * 2. Hàm onset half-wave rectified: O[n] = max(0, ln(1 + 200·rms[n]) - ln(1 + 200·rms[n-4])).
   * 3. Ngưỡng thích nghi cửa sổ trượt ~1 giây: T[n] = mean(O) + (3.2 - 0.25·sens)·std(O) + floor.
   * 4. Chọn đỉnh cục bộ: O[n-1] > T && O[n-1] >= O[n-2] && O[n-1] >= O[n] && cách beat trước >= minIntervalMs.
   * 5. Cường độ: k_beat = clamp((O[n-1] - T) / (maxO_1s - T + 1e-6), 0.35, 1).
   */
  function createOnsetDetector(params) {
    var cfg = params || {};
    var sampleRate = Number(cfg.sampleRate) > 0 ? Number(cfg.sampleRate) : 48000;
    var blockSize = Number(cfg.blockSize) > 0 ? Number(cfg.blockSize) : 128;
    var sens = Math.min(10, Math.max(1, Number(cfg.sens !== undefined ? cfg.sens : 6)));
    var minIntervalMs = Math.min(300, Math.max(60, Number(cfg.minIntervalMs !== undefined ? cfg.minIntervalMs : 100)));
    var floor = Number(cfg.floor !== undefined ? cfg.floor : 0.015);
    var lookbackBlocks = Number(cfg.lookbackBlocks) > 0 ? Math.round(cfg.lookbackBlocks) : 4;
    var windowSec = Number(cfg.windowSec) > 0 ? Number(cfg.windowSec) : 1.0;

    var blockMs = (blockSize / sampleRate) * 1000;
    var winLen = Math.max(24, Math.round((windowSec * sampleRate) / blockSize));

    // Cửa sổ ngắn 6 block (~16 ms) làm mượt gợn pha của sóng sin thuần 60-80 Hz
    var energySmoothLen = 6;
    var blockMeanSqBuf = new Float64Array(energySmoothLen);
    var blockMeanSqIdx = 0;
    var blockCount = 0;

    // Lịch sử RMS để tính sai phân log-năng lượng tại n - lookbackBlocks
    var rmsHistLen = lookbackBlocks + 2;
    var rmsHist = new Float64Array(rmsHistLen);
    var rmsHistIdx = 0;

    // Vòng đệm onset ~1 giây để tính mean, std, maxO chính xác (tránh sai số tích lũy dài giờ)
    var oRing = new Float64Array(winLen);
    var oRingIdx = 0;
    var oRingCount = 0;

    var oPrev2 = 0;
    var oPrev1 = 0;
    var tPrev1 = 0;
    var lastBeatMs = -1e9;
    var lastO = 0;
    var lastT = floor;
    var lastEnv = 0;

    function reset() {
      blockMeanSqBuf.fill(0);
      blockMeanSqIdx = 0;
      blockCount = 0;
      rmsHist.fill(0);
      rmsHistIdx = 0;
      oRing.fill(0);
      oRingIdx = 0;
      oRingCount = 0;
      oPrev2 = 0;
      oPrev1 = 0;
      tPrev1 = 0;
      lastBeatMs = -1e9;
      lastO = 0;
      lastT = floor;
      lastEnv = 0;
    }

    function setParams(next) {
      if (!next) return;
      if (next.sens !== undefined && Number.isFinite(Number(next.sens))) {
        sens = Math.min(10, Math.max(1, Number(next.sens)));
      }
      if (next.minIntervalMs !== undefined && Number.isFinite(Number(next.minIntervalMs))) {
        minIntervalMs = Math.min(300, Math.max(60, Number(next.minIntervalMs)));
      }
      if (next.floor !== undefined && Number.isFinite(Number(next.floor))) {
        floor = Math.max(0.001, Number(next.floor));
      }
    }

    function processBlock(samples, timeSec) {
      if (!samples || samples.length === 0) return null;

      var sumSq = 0;
      var len = samples.length;
      for (var i = 0; i < len; i++) {
        var s = samples[i];
        sumSq += s * s;
      }
      var meanSq = sumSq / len;

      blockMeanSqBuf[blockMeanSqIdx] = meanSq;
      blockMeanSqIdx = (blockMeanSqIdx + 1) % energySmoothLen;
      blockCount++;

      var activeSmooth = blockCount < energySmoothLen ? blockCount : energySmoothLen;
      var smoothMeanSq = 0;
      for (var j = 0; j < activeSmooth; j++) {
        smoothMeanSq += blockMeanSqBuf[j];
      }
      var rmsNow = Math.sqrt(smoothMeanSq / activeSmooth);
      lastEnv = Math.min(1, rmsNow * 2.5);

      var prevPos = (rmsHistIdx - lookbackBlocks + rmsHistLen) % rmsHistLen;
      var rmsPrev = blockCount > lookbackBlocks ? rmsHist[prevPos] : rmsNow;

      rmsHist[rmsHistIdx] = rmsNow;
      rmsHistIdx = (rmsHistIdx + 1) % rmsHistLen;

      // Hàm onset nén logarit (half-wave rectified)
      var oNow = Math.log(1 + 200 * rmsNow) - Math.log(1 + 200 * rmsPrev);
      if (oNow < 0) oNow = 0;

      // Đưa vào cửa sổ trượt ~1 giây
      oRing[oRingIdx] = oNow;
      oRingIdx = (oRingIdx + 1) % winLen;
      if (oRingCount < winLen) oRingCount++;

      // Tính mean, std, maxO trên cửa sổ 1 giây
      var sumO = 0;
      var maxO = 0;
      for (var m = 0; m < oRingCount; m++) {
        var val = oRing[m];
        sumO += val;
        if (val > maxO) maxO = val;
      }
      var meanO = oRingCount > 0 ? sumO / oRingCount : 0;

      var varSum = 0;
      for (var v = 0; v < oRingCount; v++) {
        var diff = oRing[v] - meanO;
        varSum += diff * diff;
      }
      var stdO = oRingCount > 1 ? Math.sqrt(varSum / oRingCount) : 0;

      var kSens = 3.2 - 0.25 * sens;
      var threshold = meanO + kSens * stdO + floor;

      lastO = oNow;
      lastT = threshold;

      var nowMs = (Number.isFinite(timeSec) ? timeSec * 1000 : blockCount * blockMs);
      var peakTimeMs = nowMs - blockMs;
      var elapsedMs = peakTimeMs - lastBeatMs;

      // Cho phép dung sai lượng tử hóa 1 block khi khoảng cách kick bằng đúng minIntervalMs
      var minAllowedMs = minIntervalMs - blockMs * 0.95;

      var beatEvent = null;
      if (
        blockCount > lookbackBlocks + 4 &&
        oPrev1 > tPrev1 &&
        oPrev1 >= oPrev2 &&
        oPrev1 >= oNow &&
        elapsedMs >= minAllowedMs
      ) {
        var rawK = (oPrev1 - tPrev1) / (maxO - tPrev1 + 1e-6);
        var kBeat = Math.min(1, Math.max(0.35, rawK));
        lastBeatMs = peakTimeMs;
        beatEvent = {
          k: kBeat,
          o: oPrev1,
          threshold: tPrev1,
          env: lastEnv,
          t: peakTimeMs / 1000
        };
      }

      oPrev2 = oPrev1;
      oPrev1 = oNow;
      tPrev1 = threshold;

      return beatEvent;
    }

    function getLastMetrics() {
      return { o: lastO, threshold: lastT, env: lastEnv };
    }

    return {
      processBlock: processBlock,
      getLastMetrics: getLastMetrics,
      setParams: setParams,
      reset: reset
    };
  }

  /**
   * Bộ dò beat dự phòng dùng AnalyserNode (khi AudioWorklet không chạy được)
   */
  class BeatDetector {
    constructor(windowSize = 45, minIntervalMs = 100) {
      this.detector = createOnsetDetector({
        sampleRate: 48000,
        blockSize: 128,
        sens: 6,
        minIntervalMs
      });
      this.windowSize = windowSize;
    }

    reset() {
      this.detector.reset();
    }

    static extractBassEnergy(frequencyData, sampleRate = 48000, fftSize = 2048) {
      if (!frequencyData || frequencyData.length === 0) return 0;
      const binHz = sampleRate / fftSize;
      const startBin = Math.max(0, Math.floor(40 / binHz));
      const endBin = Math.min(frequencyData.length - 1, Math.ceil(160 / binHz));
      if (endBin < startBin) return 0;

      let sum = 0;
      let count = 0;
      for (let i = startBin; i <= endBin; i++) {
        sum += frequencyData[i];
        count++;
      }
      return count > 0 ? sum / count : 0;
    }

    processSamples(samples, timeSec, sens = 6, minIntervalMs = 100) {
      this.detector.setParams({ sens, minIntervalMs });
      return this.detector.processBlock(samples, timeSec);
    }
  }

  /**
   * Bộ phát beat theo nhịp BPM cố định
   * t = audioCurrentTime - off + 0.04 (0.04s bù trễ IPC)
   */
  class BpmBeatTracker {
    constructor(ipcCompensationSec = 0.04) {
      this.ipcCompensationSec = ipcCompensationSec;
      this.lastBeatIndex = -Infinity;
    }

    reset() {
      this.lastBeatIndex = -Infinity;
    }

    step(audioCurrentTimeSec, bpm, offsetSec = 0) {
      const safeBpm = clamp(bpm, 40, 240);
      const beatDuration = 60 / safeBpm;
      const t = (Number(audioCurrentTimeSec) || 0) - (Number(offsetSec) || 0) + this.ipcCompensationSec;
      const idx = Math.floor(t / beatDuration);

      if (this.lastBeatIndex === -Infinity) {
        this.lastBeatIndex = idx;
        return { isBeat: t >= 0 && idx >= 0, beatIndex: idx, k: 0.85 };
      }

      if (idx > this.lastBeatIndex) {
        this.lastBeatIndex = idx;
        return { isBeat: true, beatIndex: idx, k: 0.85 };
      }

      return { isBeat: false, beatIndex: idx, k: 0 };
    }
  }

  /**
   * Tính BPM từ danh sách mốc thời gian bấm TAP (ms).
   * Bỏ qua khoảng nghỉ > 2000ms; trả về null nếu chưa đủ 2 lần bấm liên tiếp.
   */
  function calculateTapBpm(timestampsMs) {
    if (!Array.isArray(timestampsMs) || timestampsMs.length < 2) return null;

    const validIntervals = [];
    for (let i = 1; i < timestampsMs.length; i++) {
      const diff = timestampsMs[i] - timestampsMs[i - 1];
      if (diff > 150 && diff <= 2000) {
        validIntervals.push(diff);
      } else if (diff > 2000) {
        validIntervals.length = 0;
      }
    }

    if (validIntervals.length === 0) return null;
    const recent = validIntervals.slice(-8);
    const avgMs = recent.reduce((a, b) => a + b, 0) / recent.length;
    const bpm = Math.round(60000 / avgMs);
    return clamp(bpm, 40, 240);
  }

  /**
   * Tính hệ số phóng nền chống lộ viền đen (gồm cả beat shake và rung nền liên tục)
   * Công thức: 1 + 2.4 * (shake + idleAmp * (1 + idleCouple + 0.8)) / min(W, H)
   *            + 0.03 * (rot + idleRot) + idleBreath / 100
   */
  function calculateOverscanScale(shakePx, rotDeg, width, height, idleOpts) {
    const w = Math.max(1, Number(width) || 1920);
    const h = Math.max(1, Number(height) || 1080);
    const minDim = Math.min(w, h);
    const shake = Math.max(0, Number(shakePx) || 0);
    const rot = Math.max(0, Number(rotDeg) || 0);

    if (!idleOpts || !idleOpts.idleOn) {
      return 1 + (shake * 2.4) / minDim + rot * 0.03;
    }

    const idleAmp = Math.max(0, Number(idleOpts.idleAmp) || 0);
    const idleCouple = Math.max(0, Number(idleOpts.idleCouple) || 0);
    const idleRot = Math.max(0, Number(idleOpts.idleRot) || 0);
    const idleBreath = Math.max(0, Number(idleOpts.idleBreath) || 0);

    return (
      1 +
      (2.4 * (shake + idleAmp * (1 + idleCouple + 0.8))) / minDim +
      0.03 * (rot + idleRot) +
      idleBreath / 100
    );
  }

  /**
   * Chọn góc giật cho beat tiếp theo sao cho cách góc trước >= 60 độ (PI/3 rad)
   */
  function pickNextBeatAngle(prevAngleRad, rng) {
    const rand = typeof rng === 'function' ? rng : Math.random;
    const twoPi = Math.PI * 2;
    if (!Number.isFinite(prevAngleRad)) {
      return rand() * twoPi;
    }
    const minGap = Math.PI / 3; // 60 độ
    const span = twoPi - 2 * minGap; // 240 độ khả dụng
    const offset = minGap + rand() * span;
    return (prevAngleRad + offset) % twoPi;
  }

  /**
   * Tính thời gian hồi hiệu dụng để không chồng animation khi beat dồn dập:
   * min(decay, max(60 ms, 0.9 * khoảng cách tới beat trước))
   */
  function calculateEffectiveDecay(decayMs, timeSincePrevBeatMs) {
    const baseDecay = clamp(decayMs ?? 220, 60, 800);
    if (!Number.isFinite(timeSincePrevBeatMs) || timeSincePrevBeatMs <= 0) {
      return baseDecay;
    }
    return Math.min(baseDecay, Math.max(60, 0.9 * timeSincePrevBeatMs));
  }

  /**
   * Chọn màn hình LED tối ưu
   */
  function pickBestDisplay(displays, primaryId, savedSettings) {
    if (!Array.isArray(displays) || displays.length === 0) {
      return { mode: 'none', display: null };
    }

    const externalDisplays = displays.filter((d) => d.id !== primaryId);
    if (externalDisplays.length === 0) {
      const primary = displays.find((d) => d.id === primaryId) || displays[0];
      return { mode: 'preview-window', display: primary };
    }

    const settings = savedSettings || {};
    if (settings.lastDisplayId !== undefined && settings.lastDisplayId !== null) {
      const byId = externalDisplays.find((d) => String(d.id) === String(settings.lastDisplayId));
      if (byId) return { mode: 'fullscreen', display: byId };
    }

    if (settings.lastDisplaySize && settings.lastDisplaySize.width && settings.lastDisplaySize.height) {
      const bySize = externalDisplays.find(
        (d) => d.bounds &&
          d.bounds.width === settings.lastDisplaySize.width &&
          d.bounds.height === settings.lastDisplaySize.height
      );
      if (bySize) return { mode: 'fullscreen', display: bySize };
    }

    return { mode: 'fullscreen', display: externalDisplays[0] };
  }

  /**
   * Lấy đuôi file viết thường (kèm dấu chấm)
   */
  function getExtensionLower(filePath) {
    if (typeof filePath !== 'string') return '';
    const clean = filePath.split('?')[0].split('#')[0];
    const idx = clean.lastIndexOf('.');
    return idx >= 0 ? clean.slice(idx).toLowerCase() : '';
  }

  /**
   * Phân loại media: 'image' | 'video' | 'audio' | 'unknown'
   */
  function detectMediaKind(filePath) {
    const ext = getExtensionLower(filePath);
    if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
    if (VIDEO_EXTENSIONS.includes(ext) || RISKY_VIDEO_EXTENSIONS.includes(ext)) return 'video';
    if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
    return 'unknown';
  }

  /**
   * Tạo danh sách Cue tự động từ mảng đường dẫn tệp kéo thả / chọn hàng loạt (Ảnh, Video, Nhạc)
   */
  function buildCuesFromMediaPaths(filePaths, stemExtractor) {
    const cues = [];
    const ignoredPaths = [];
    if (!Array.isArray(filePaths)) return { cues, ignoredPaths };

    const fallbackStem = (p) => {
      const normalized = String(p || '').replace(/\\/g, '/');
      const base = normalized.split('/').pop() || '';
      const dot = base.lastIndexOf('.');
      return (dot > 0 ? base.slice(0, dot) : base).trim() || 'Cue mới';
    };
    const getStem = typeof stemExtractor === 'function' ? stemExtractor : fallbackStem;

    for (const rawPath of filePaths) {
      if (typeof rawPath !== 'string' || !rawPath.trim()) continue;
      const cleanPath = rawPath.trim();
      const kind = detectMediaKind(cleanPath);
      const name = getStem(cleanPath) || 'Cue mới';

      if (kind === 'audio') {
        cues.push(createDefaultCue({ name, aud: cleanPath }));
      } else if (kind === 'image' || kind === 'video') {
        cues.push(createDefaultCue({
          name,
          vis: cleanPath,
          vsound: kind === 'video',
          vvol: 100
        }));
      } else {
        ignoredPaths.push(cleanPath);
      }
    }

    return { cues, ignoredPaths };
  }

  /**
   * Kiểm tra trước giờ G (Pre-flight check)
   */
  function runPreflightAnalysis(project, envState) {
    const issues = [];
    const env = envState || {};
    const cues = project && Array.isArray(project.cues) ? project.cues : [];

    if (!env.ledOpen) {
      issues.push({
        level: 'error',
        cueIndex: -1,
        cueName: 'Hệ thống LED',
        message: 'Cửa sổ LED chưa được mở.'
      });
    }

    if (typeof env.masterVol === 'number' && env.masterVol <= 0) {
      issues.push({
        level: 'warning',
        cueIndex: -1,
        cueName: 'Âm thanh tổng',
        message: 'Âm lượng tổng (Master) đang bằng 0%.'
      });
    }

    if (cues.length === 0) {
      issues.push({
        level: 'warning',
        cueIndex: -1,
        cueName: 'Danh sách cue',
        message: 'Chương trình chưa có cue nào.'
      });
    }

    const existsMap = env.fileExistsMap || {};
    const codecMap = env.codecErrorsMap || {};

    cues.forEach((cue, idx) => {
      const label = `#${idx + 1} ${cue.name}`;

      if (cue.aud) {
        if (existsMap[cue.aud] === false) {
          issues.push({
            level: 'error',
            cueIndex: idx,
            cueName: label,
            message: `Mất file nhạc: ${cue.aud}`
          });
        }
        if (cue.vol <= 0) {
          issues.push({
            level: 'warning',
            cueIndex: idx,
            cueName: label,
            message: 'Âm lượng bài nhạc đang đặt 0%.'
          });
        }
        if (codecMap[cue.aud]) {
          issues.push({
            level: 'error',
            cueIndex: idx,
            cueName: label,
            message: 'File nhạc gặp lỗi giải mã trước đó.'
          });
        }
      }

      if (cue.vis && (!cue.sourceType || cue.sourceType === 'media')) {
        if (existsMap[cue.vis] === false) {
          issues.push({
            level: 'error',
            cueIndex: idx,
            cueName: label,
            message: `Mất file hình/video: ${cue.vis}`
          });
        }
        const ext = getExtensionLower(cue.vis);
        if (RISKY_VIDEO_EXTENSIONS.includes(ext)) {
          issues.push({
            level: 'warning',
            cueIndex: idx,
            cueName: label,
            message: `Đuôi ${ext} có thể dùng codec không hỗ trợ — nên chuyển sang MP4 (H.264 + AAC).`
          });
        }
        if (codecMap[cue.vis]) {
          issues.push({
            level: 'error',
            cueIndex: idx,
            cueName: label,
            message: 'File hình/video không phát được (hãy chuyển sang MP4 H.264).'
          });
        }
      }
    });

    return {
      ok: issues.filter((i) => i.level === 'error').length === 0,
      errorCount: issues.filter((i) => i.level === 'error').length,
      warningCount: issues.filter((i) => i.level === 'warning').length,
      issues
    };
  }

  /**
   * Tính năng lượng 3 dải tần Bass (20-160Hz), Mid (160-2000Hz), High (2000-12000Hz)
   * từ mảng byte phổ FFT của AnalyserNode, chuẩn hóa trong [0, 1].
   */
  function computeThreeBandEnergy(freqUint8, sampleRate = 48000, fftSize = 2048) {
    if (!freqUint8 || typeof freqUint8.length !== 'number' || freqUint8.length === 0) {
      return { bass: 0, mid: 0, high: 0 };
    }
    const sr = Number(sampleRate) > 0 ? Number(sampleRate) : 48000;
    const fft = Number(fftSize) > 0 ? Number(fftSize) : 2048;
    const binHz = sr / fft;
    const len = freqUint8.length;

    const avgBand = (startBin, endBin) => {
      if (endBin < startBin || startBin >= len) return 0;
      const lo = Math.max(0, startBin);
      const hi = Math.min(len - 1, endBin);
      if (hi < lo) return 0;
      let sum = 0;
      let count = 0;
      for (let i = lo; i <= hi; i++) {
        const val = Number(freqUint8[i]);
        sum += Number.isFinite(val) ? val : 0;
        count++;
      }
      return count > 0 ? clamp(sum / (count * 255), 0, 1) : 0;
    };

    const b0 = Math.max(0, Math.floor(20 / binHz));
    const b1 = Math.min(len - 1, Math.floor(160 / binHz));
    const m0 = Math.max(b1 + 1, Math.floor(160 / binHz));
    const m1 = Math.min(len - 1, Math.floor(2000 / binHz));
    const h0 = Math.max(m1 + 1, Math.floor(2000 / binHz));
    const h1 = Math.min(len - 1, Math.ceil(12000 / binHz));

    return {
      bass: avgBand(b0, b1),
      mid: avgBand(m0, m1),
      high: avgBand(h0, h1)
    };
  }

  /**
   * Ước lượng BPM (60..200) và độ tin cậy (0..1) từ chuỗi mốc beat (ms).
   * Trả về null nếu chưa đủ ít nhất 4 mốc beat hợp lệ.
   */
  function estimateBpmFromBeatTimes(timestampsMs) {
    if (!Array.isArray(timestampsMs) || timestampsMs.length < 4) return null;
    const recent = timestampsMs
      .map(Number)
      .filter((t) => Number.isFinite(t))
      .slice(-24);
    if (recent.length < 4) return null;

    const intervals = [];
    for (let i = 1; i < recent.length; i++) {
      const diff = recent[i] - recent[i - 1];
      if (diff >= 150 && diff <= 2500) {
        intervals.push(diff);
      } else if (diff > 2500) {
        intervals.length = 0;
      }
    }
    if (intervals.length < 3) return null;

    const sorted = intervals.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const filtered = intervals.length >= 5
      ? intervals.filter((d) => Math.abs(d - median) <= median * 0.35)
      : intervals;
    const used = filtered.length >= 3 ? filtered : intervals;

    const mean = used.reduce((a, b) => a + b, 0) / used.length;
    if (mean <= 0) return null;

    let variance = 0;
    for (let i = 0; i < used.length; i++) {
      const delta = used[i] - mean;
      variance += delta * delta;
    }
    const stdDev = Math.sqrt(variance / used.length);
    const cv = stdDev / mean;

    const bpm = Math.round(clamp(60000 / mean, 60, 200));
    const confidence = clamp(1 - cv * 2.5, 0, 1);
    return { bpm, confidence };
  }

  /**
   * Đồng hồ nhịp Master Beat Clock hỗ trợ bộ chia 0.25x..4x, nudge pha và resync
   */
  class MasterBeatClock {
    constructor(bpm = 120, divider = 1) {
      this.bpm = clamp(bpm, 40, 240);
      this.divider = normalizeBeatDivider(divider);
      this.anchorMs = null;
      this.nudgeOffsetMs = 0;
      this.lastBeatIndex = -Infinity;
      this.lastSubBeatIndex = -Infinity;
      this.lastNowMs = null;
    }

    setBpm(bpm) {
      const nextBpm = clamp(bpm, 40, 240);
      if (nextBpm === this.bpm) return;
      if (this.anchorMs !== null && this.lastNowMs !== null) {
        const oldBeatDur = 60000 / this.bpm;
        const elapsed = this.lastNowMs - this.anchorMs + this.nudgeOffsetMs;
        const beatPos = elapsed / oldBeatDur;
        const newBeatDur = 60000 / nextBpm;
        this.anchorMs = this.lastNowMs + this.nudgeOffsetMs - beatPos * newBeatDur;
      }
      this.bpm = nextBpm;
    }

    setDivider(div) {
      const nextDiv = normalizeBeatDivider(div);
      if (nextDiv === this.divider) return;
      this.divider = nextDiv;
      if (this.anchorMs !== null && this.lastNowMs !== null) {
        const subDur = (60000 / this.bpm) / this.divider;
        const elapsed = this.lastNowMs - this.anchorMs + this.nudgeOffsetMs;
        this.lastSubBeatIndex = Math.floor(elapsed / subDur + 1e-9);
      }
    }

    nudge(ms) {
      const delta = Number(ms);
      if (!Number.isFinite(delta)) return;
      this.nudgeOffsetMs += delta;
    }

    resync(nowMs = 0) {
      const safeNow = Number.isFinite(Number(nowMs)) ? Number(nowMs) : 0;
      this.anchorMs = safeNow;
      this.nudgeOffsetMs = 0;
      this.lastBeatIndex = -Infinity;
      this.lastSubBeatIndex = -Infinity;
      this.lastNowMs = null;
    }

    step(nowMs) {
      const safeNow = Number.isFinite(Number(nowMs)) ? Number(nowMs) : 0;
      if (this.anchorMs === null) {
        this.anchorMs = safeNow;
      }
      this.lastNowMs = safeNow;

      const beatDurMs = 60000 / this.bpm;
      const subDurMs = beatDurMs / this.divider;
      const elapsedMs = safeNow - this.anchorMs + this.nudgeOffsetMs;

      const beatIndex = Math.floor(elapsedMs / beatDurMs + 1e-9);
      const subBeatIndex = Math.floor(elapsedMs / subDurMs + 1e-9);
      const rawPhase = (((elapsedMs % beatDurMs) + beatDurMs) % beatDurMs) / beatDurMs;
      const phase = rawPhase >= 0.999999999 ? 0 : rawPhase;
      const beatInBar = ((beatIndex % 4) + 4) % 4;

      let isBeat = false;
      if (this.lastBeatIndex === -Infinity || beatIndex > this.lastBeatIndex) {
        isBeat = true;
        this.lastBeatIndex = beatIndex;
      }

      let isSubBeat = false;
      if (this.lastSubBeatIndex === -Infinity || subBeatIndex > this.lastSubBeatIndex) {
        isSubBeat = true;
        this.lastSubBeatIndex = subBeatIndex;
      }

      return {
        phase,
        beatInBar,
        beatIndex,
        subBeatIndex,
        isBeat,
        isSubBeat
      };
    }
  }

  /**
   * Chuyển HSV (h: 0..360, s: 0..1, v: 0..1) sang RGB (0..255)
   */
  function hsvToRgb(hDeg, s, v) {
    const h = ((Number(hDeg) % 360) + 360) % 360;
    const sat = clamp(s, 0, 1);
    const val = clamp(v, 0, 1);
    const c = val * sat;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = val - c;
    let r1 = 0;
    let g1 = 0;
    let b1 = 0;
    if (h < 60) { r1 = c; g1 = x; }
    else if (h < 120) { r1 = x; g1 = c; }
    else if (h < 180) { g1 = c; b1 = x; }
    else if (h < 240) { g1 = x; b1 = c; }
    else if (h < 300) { r1 = x; b1 = c; }
    else { r1 = c; b1 = x; }
    return {
      r: Math.round((r1 + m) * 255),
      g: Math.round((g1 + m) * 255),
      b: Math.round((b1 + m) * 255)
    };
  }

  /**
   * Tính khung DMX 512 kênh và mảng preview trực quan cho các fixture sân khấu
   */
  function computeDmxFrame(dmxConfig, ledSync, beatState, audioBands, nowMs) {
    const cfg = dmxConfig && typeof dmxConfig === 'object' ? dmxConfig : createDefaultDmxConfig();
    const sync = ledSync && typeof ledSync === 'object' ? ledSync : createDefaultLedSync();
    const beat = beatState && typeof beatState === 'object' ? beatState : { phase: 0, beatInBar: 0, beatIndex: 0 };
    const bands = audioBands && typeof audioBands === 'object' ? audioBands : { bass: 0, mid: 0, high: 0 };
    const tMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : 0;

    const channels = new Uint8Array(512);
    const previews = [];
    const fixtures = Array.isArray(cfg.fixtures) ? cfg.fixtures : [];
    const masterDimmer = clamp(cfg.masterDimmer ?? 100, 0, 100) / 100;

    if (cfg.blackout || masterDimmer <= 0) {
      for (let i = 0; i < fixtures.length; i++) {
        const f = fixtures[i] || {};
        previews.push({
          id: f.id || `fix-${i + 1}`,
          name: f.name || `Đèn ${i + 1}`,
          r: 0,
          g: 0,
          b: 0,
          dimmer: 0
        });
      }
      return { channels, previews };
    }

    const paletteRgb = resolvePaletteColors(sync).map(hexToRgb);
    const intensity = clamp(sync.intensity ?? 80, 0, 100) / 100;
    const phase = clamp(beat.phase ?? 0, 0, 0.999999);
    const beatIndex = Math.max(0, Math.floor(Number(beat.beatIndex) || 0));
    const beatEnv = Number.isFinite(Number(beat.pulse)) ? clamp(beat.pulse, 0, 1) : Math.pow(1 - phase, 2.0);
    const bass = clamp(bands.bass ?? 0, 0, 1);
    const dmxMode = VALID_DMX_MODES.includes(sync.dmxMode) ? sync.dmxMode : 'beat-flash';
    const fixtureCount = Math.max(1, fixtures.length);

    for (let i = 0; i < fixtures.length; i++) {
      const f = fixtures[i] || {};
      const type = VALID_FIXTURE_TYPES.includes(f.type) ? f.type : 'drgb';
      const startCh = Math.round(clamp(f.startChannel ?? 1, 1, 512));
      const base = startCh - 1;

      let color = paletteRgb[beatIndex % paletteRgb.length] || { r: 255, g: 255, b: 255 };
      let fixtureDim = intensity;
      let strobeByte = 0;

      if (dmxMode === 'beat-flash') {
        color = paletteRgb[beatIndex % paletteRgb.length];
        fixtureDim = clamp((0.12 + 0.88 * beatEnv) * intensity, 0, 1);
      } else if (dmxMode === 'chase') {
        const activeIdx = beatIndex % fixtureCount;
        color = paletteRgb[(beatIndex + i) % paletteRgb.length];
        fixtureDim = i === activeIdx
          ? clamp((0.35 + 0.65 * beatEnv) * intensity, 0, 1)
          : clamp(0.08 * intensity, 0, 1);
      } else if (dmxMode === 'rainbow-beat') {
        const hue = (i / fixtureCount) * 360 + beatIndex * 45 + tMs * 0.02;
        color = hsvToRgb(hue, 1, 1);
        fixtureDim = clamp((0.45 + 0.55 * beatEnv) * intensity, 0, 1);
      } else if (dmxMode === 'bass-dimmer') {
        color = paletteRgb[i % paletteRgb.length];
        fixtureDim = clamp(bass * intensity, 0, 1);
      } else if (dmxMode === 'strobe') {
        color = paletteRgb[beatIndex % paletteRgb.length];
        const strobeOn = Math.floor(tMs / 35) % 2 === 0;
        fixtureDim = strobeOn ? intensity : 0;
        strobeByte = Math.round(clamp(128 + 127 * intensity, 0, 255));
      } else if (dmxMode === 'solid') {
        color = paletteRgb[0];
        fixtureDim = intensity;
      }

      const effectiveDim = clamp(fixtureDim * masterDimmer, 0, 1);
      const dimByte = Math.round(effectiveDim * 255);
      const rByte = Math.round(clamp(color.r, 0, 255));
      const gByte = Math.round(clamp(color.g, 0, 255));
      const bByte = Math.round(clamp(color.b, 0, 255));
      const wByte = Math.min(rByte, gByte, bByte);

      const writeCh = (offset, val) => {
        if (base + offset < 512) {
          channels[base + offset] = Math.round(clamp(val, 0, 255));
        }
      };

      if (type === 'rgb') {
        writeCh(0, rByte * effectiveDim);
        writeCh(1, gByte * effectiveDim);
        writeCh(2, bByte * effectiveDim);
      } else if (type === 'rgbw') {
        writeCh(0, rByte * effectiveDim);
        writeCh(1, gByte * effectiveDim);
        writeCh(2, bByte * effectiveDim);
        writeCh(3, wByte * effectiveDim);
      } else if (type === 'drgb') {
        writeCh(0, dimByte);
        writeCh(1, rByte);
        writeCh(2, gByte);
        writeCh(3, bByte);
      } else if (type === 'drgbs') {
        writeCh(0, dimByte);
        writeCh(1, rByte);
        writeCh(2, gByte);
        writeCh(3, bByte);
        writeCh(4, strobeByte);
      } else if (type === 'drgbws') {
        writeCh(0, dimByte);
        writeCh(1, rByte);
        writeCh(2, gByte);
        writeCh(3, bByte);
        writeCh(4, wByte);
        writeCh(5, strobeByte);
      } else if (type === 'strobe') {
        writeCh(0, dimByte);
        writeCh(1, strobeByte);
      }

      previews.push({
        id: f.id || `fix-${i + 1}`,
        name: f.name || `Đèn ${i + 1}`,
        r: rByte,
        g: gByte,
        b: bByte,
        dimmer: Number(effectiveDim.toFixed(3))
      });
    }

    return { channels, previews };
  }

  /**
   * Định dạng số giây sang mm:ss
   */
  function formatTime(seconds) {
    const s = Number(seconds);
    if (!Number.isFinite(s) || s < 0) return '00:00';
    const totalSec = Math.floor(s);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  }

  return {
    TRANSITION_TYPES,
    BLEND_MODES,
    LED_STROBE_MODES,
    VJ_GENERATORS,
    LED_PALETTES,
    LED_STROBE_PRESETS,
    FX_PRESETS,
    BASS_PRESETS,
    AUDIO_EXTENSIONS,
    IMAGE_EXTENSIONS,
    VIDEO_EXTENSIONS,
    RISKY_VIDEO_EXTENSIONS,
    clamp,
    generateId,
    hexToRgb,
    resolvePaletteColors,
    createDefaultFx,
    createDefaultTextOverlay,
    createDefaultLedSync,
    createDefaultOverlays,
    createDefaultVjDeck,
    createDefaultMasterFx,
    createDefaultOutputMapping,
    createDefaultDmxConfig,
    createDefaultOscConfig,
    createDefaultCue,
    normalizeCue,
    createDefaultSfxPads,
    validateAndMigrateProject,
    createOnsetDetector,
    BeatDetector,
    BpmBeatTracker,
    MasterBeatClock,
    calculateTapBpm,
    estimateBpmFromBeatTimes,
    computeThreeBandEnergy,
    computeDmxFrame,
    calculateOverscanScale,
    pickNextBeatAngle,
    calculateEffectiveDecay,
    pickBestDisplay,
    getExtensionLower,
    detectMediaKind,
    buildCuesFromMediaPaths,
    runPreflightAnalysis,
    formatTime
  };
});
