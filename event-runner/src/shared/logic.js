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
  const TRANSITION_TYPES = ['cut', 'fade', 'black', 'slide-left', 'slide-right', 'zoom'];

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
      src: ['auto', 'bpm', 'ext'].includes(overrides.src) ? overrides.src : 'auto',
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
      fx: src.fx
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
      fx: createDefaultFx(c.fx)
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
   * Kiểm tra và chuẩn hóa toàn bộ file dự án JSON
   */
  function validateAndMigrateProject(raw) {
    if (!raw || typeof raw !== 'object') {
      return {
        ok: false,
        error: 'Dữ liệu dự án không phải đối tượng JSON hợp lệ.',
        warnings: [],
        project: { version: 1, cues: [], sfxPads: createDefaultSfxPads(), customFxPresets: {} }
      };
    }

    const warnings = [];
    let rawCues = [];

    if (Array.isArray(raw.cues)) {
      rawCues = raw.cues;
    } else if (Array.isArray(raw)) {
      warnings.push('Đã chuyển đổi danh sách cue cũ sang định dạng dự án v1.');
      rawCues = raw;
    } else {
      return {
        ok: false,
        error: 'File dự án thiếu danh sách "cues".',
        warnings: [],
        project: { version: 1, cues: [], sfxPads: createDefaultSfxPads(), customFxPresets: {} }
      };
    }

    if (raw.version !== undefined && raw.version !== 1) {
      warnings.push(`Phiên bản dự án ${raw.version} đã được chuẩn hóa về phiên bản 1.`);
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
        version: 1,
        cues,
        sfxPads: createDefaultSfxPads(raw.sfxPads),
        customFxPresets
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

      if (cue.vis) {
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
    FX_PRESETS,
    BASS_PRESETS,
    AUDIO_EXTENSIONS,
    IMAGE_EXTENSIONS,
    VIDEO_EXTENSIONS,
    RISKY_VIDEO_EXTENSIONS,
    clamp,
    generateId,
    createDefaultFx,
    createDefaultTextOverlay,
    createDefaultCue,
    normalizeCue,
    createDefaultSfxPads,
    validateAndMigrateProject,
    createOnsetDetector,
    BeatDetector,
    BpmBeatTracker,
    calculateTapBpm,
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
