/**
 * Controller cửa sổ màn hình LED (output.html)
 * Engine chuyển động vật lý 2 lớp siêu mượt (60–144 fps, không giật cục):
 *   #idle  -> Trôi ngẫu nhiên mượt kiểu Cinema Camera Float (Spline bậc 3 Catmull-Rom 2 tầng + bộ lọc quán tính gimbal)
 *   #stage -> Vật lý đàn hồi lò xo giảm chấn (2nd-order Spring-Damper ODE): cú đập có độ nảy êm ở đầu xung
 *             và trượt mượt về tâm, tuyệt đối không dịch chuyển tức thời 0ms hay cắt ngang animation.
 */
'use strict';

(function () {
  const logic = window.EventRunnerLogic;

  const idleEl = document.getElementById('idle');
  const stageEl = document.getElementById('stage');
  const layerContainer = document.getElementById('layer-container');
  const flashOverlay = document.getElementById('flash-overlay');
  const textOverlay = document.getElementById('text-overlay');
  const textBox = document.getElementById('text-box');
  const blackoutOverlay = document.getElementById('blackout-overlay');
  const testPatternEl = document.getElementById('test-pattern');
  const testCanvas = document.getElementById('test-canvas');
  const testBadge = document.getElementById('test-badge');

  let showToken = 0;
  let currentFx = logic.createDefaultFx();
  let activeLayer = null;
  let layerZ = 1;
  let masterVol = 100;
  let audioSinkId = '';
  let videoFadeTimer = null;

  // Cache nạp sẵn media tối đa 4 phần tử
  const preloadCache = new Map();
  const MAX_PRELOAD = 4;

  // Theo dõi tụt khung hình cho filter 4K
  let filterQuality = 2;
  let slowFrameStreak = 0;

  // Theo dõi hướng & thời điểm beat
  let lastBeatAngle = NaN;
  let lastBeatTimeMs = 0;
  let rotSign = 1;

  // Trạng thái âm thanh & rung nền ngẫu nhiên mượt (Cinema Wander)
  let rawBassEnv = 0;
  let smoothBassEnv = 0;
  let musicPlaying = false;
  let testIdleOn = false;
  let idleActiveFactor = 0;
  let idlePhase = Math.random() * 100;
  let targetIdlePulse = 0;
  let smoothIdlePulse = 0;
  let smoothBaseScale = 1;

  // Quán tính gimbal cho #idle để quỹ đạo cong mượt tuyệt đối
  const idleGimbal = { x: 0, y: 0, rot: 0, breath: 0 };

  // Trạng thái vật lý lò xo giảm chấn liên tục cho #stage (Beat FX)
  const beatPhys = {
    x: 0, vx: 0,
    y: 0, vy: 0,
    rot: 0, vRot: 0,
    scale: 0, vScale: 0,
    bright: 0, vBright: 0,
    hue: 0, vHue: 0,
    flash: 0, vFlash: 0,
    omega: 18,
    zeta: 1.05,
    motion: 'smooth'
  };

  let lastFrameMs = performance.now();

  window.addEventListener('error', (ev) => {
    window.api.reportRendererError({ where: 'output', message: ev.message });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    window.api.reportRendererError({ where: 'output:promise', message: String(ev.reason) });
  });

  // =========================================================================
  // HÀM NHIỄU NGẪU NHIÊN SPLINE BẬC 3 CATMULL-ROM (TRÔI NGẪU NHIÊN KHÔNG LẶP)
  // =========================================================================

  /** Sinh số giả ngẫu nhiên phân bố đều [-1, 1] tại mỗi mốc nguyên n */
  function hashRand1D(n, seed) {
    const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453123;
    return (s - Math.floor(s)) * 2 - 1;
  }

  /** Nội suy Catmull-Rom bậc 3 đi qua chuỗi điểm ngẫu nhiên vô tận (vận tốc liên tục mượt mà) */
  function catmullRomNoise(phase, seed) {
    const i = Math.floor(phase);
    const t = phase - i;
    const p0 = hashRand1D(i - 1, seed);
    const p1 = hashRand1D(i, seed);
    const p2 = hashRand1D(i + 1, seed);
    const p3 = hashRand1D(i + 2, seed);

    const t2 = t * t;
    const t3 = t2 * t;
    const v = 0.5 * (
      2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
    return logic.clamp(v, -1.15, 1.15);
  }

  /** Chuyển động trôi ngẫu nhiên đa tầng giống After Effects wiggle() / máy quay cầm tay */
  function sampleOrganicWander(phase, seed, detailWeight) {
    const slowDrift = catmullRomNoise(phase, seed);
    const microSway = catmullRomNoise(phase * 2.13 + 17.7, seed + 53);
    return (slowDrift + microSway * detailWeight) / (1 + detailWeight);
  }

  /** Tính hệ số phóng nền chống lộ viền đen */
  function computeTargetBaseScale() {
    if (!currentFx || !currentFx.over) return 1;
    const fxActiveForIdle = Boolean(currentFx.idleOn || testIdleOn);
    if (!currentFx.on && !fxActiveForIdle) return 1;
    return logic.calculateOverscanScale(
      currentFx.on ? currentFx.shake : 0,
      currentFx.on ? currentFx.rot : 0,
      window.innerWidth,
      window.innerHeight,
      {
        idleOn: fxActiveForIdle,
        idleAmp: currentFx.idleAmp,
        idleCouple: currentFx.idleCouple,
        idleRot: currentFx.idleRot,
        idleBreath: currentFx.idleBreath
      }
    );
  }

  // =========================================================================
  // ENGINE VẬT LÝ CHUYỂN ĐỘNG LIÊN TỤC (IDLE FLOAT + BEAT SPRING-DAMPER)
  // =========================================================================

  /** Tích phân một bậc lò xo giảm chấn: x'' + 2*zeta*omega*x' + omega^2*x = 0 */
  function stepSpring1D(pos, vel, omega, zeta, dt) {
    const acc = -omega * omega * pos - 2 * zeta * omega * vel;
    const nextVel = vel + acc * dt;
    const nextPos = pos + nextVel * dt;
    return [nextPos, nextVel];
  }

  function masterMotionLoop(nowMs) {
    const rawDtMs = nowMs - lastFrameMs;
    lastFrameMs = nowMs;
    const dtMs = Math.min(64, Math.max(0.5, rawDtMs));
    const dtSec = dtMs / 1000;

    // Tự động theo dõi khung hình 4K để giảm tải filter nếu máy yếu
    if (rawDtMs > 52 && rawDtMs < 400 && Math.abs(beatPhys.scale) > 0.002) {
      slowFrameStreak++;
      if (slowFrameStreak >= 6 && filterQuality > 0) {
        filterQuality--;
        slowFrameStreak = 0;
      }
    } else {
      slowFrameStreak = Math.max(0, slowFrameStreak - 1);
    }

    const fx = currentFx;

    // 1. Làm mượt bao hình bass & xung beat (tránh nhảy bậc 30Hz từ IPC)
    const envAlpha = 1 - Math.exp(-dtSec * 9);
    smoothBassEnv += (rawBassEnv - smoothBassEnv) * envAlpha;

    targetIdlePulse *= Math.exp(-dtSec * 4.8);
    smoothIdlePulse += (targetIdlePulse - smoothIdlePulse) * (1 - Math.exp(-dtSec * 16));

    // Làm mượt hệ số phóng nền Overscan để bật/tắt không bị giật khung
    const desiredBaseScale = computeTargetBaseScale();
    smoothBaseScale += (desiredBaseScale - smoothBaseScale) * (1 - Math.exp(-dtSec * 10));

    // 2. CẬP NHẬT LỚP #idle (TRÔI NGẪU NHIÊN MƯỢT MÀ LIÊN TỤC)
    const shouldIdle = Boolean(fx && (fx.idleOn || testIdleOn));
    const wantsIdleMotion = shouldIdle && (testIdleOn || !fx.idleOnlyMusic || musicPlaying);
    const targetIdleGate = wantsIdleMotion ? 1 : 0;

    // Tăng/giảm êm với đường cong mượt (~650 ms)
    idleActiveFactor += (targetIdleGate - idleActiveFactor) * (1 - Math.exp(-dtSec * 4.2));
    if (idleActiveFactor < 0.0008 && targetIdleGate === 0) idleActiveFactor = 0;

    if (idleActiveFactor > 0) {
      const isHandheld = fx.idleStyle === 'jitter';
      const baseRate = (isHandheld ? 0.46 : 0.21) * Math.max(0.2, fx.idleSpeed || 2.2);
      const energySpeedBoost = 1 + 0.35 * smoothBassEnv + 0.35 * smoothIdlePulse;
      idlePhase += dtSec * baseRate * energySpeedBoost;

      const detailMix = isHandheld ? 0.55 : 0.22;
      const nx = sampleOrganicWander(idlePhase, 11.3, detailMix);
      const ny = sampleOrganicWander(idlePhase * 0.93 + 31.7, 29.9, detailMix);
      const nr = sampleOrganicWander(idlePhase * 0.77 + 64.1, 47.5, detailMix * 0.8);
      const nb = sampleOrganicWander(idlePhase * 0.61 + 93.4, 83.1, 0.15);

      const coupleBoost = 1 + (fx.idleCouple || 0) * smoothBassEnv + smoothIdlePulse * 0.65;
      const targetX = nx * (fx.idleAmp || 0) * coupleBoost * idleActiveFactor;
      const targetY = ny * (fx.idleAmp || 0) * coupleBoost * idleActiveFactor;
      const targetRot = nr * (fx.idleRot || 0) * coupleBoost * idleActiveFactor;
      const targetBreath = nb * ((fx.idleBreath || 0) / 100) * idleActiveFactor;

      // Bộ lọc gimbal mượt (không bao giờ bẻ góc gắt)
      const gimbalAlpha = 1 - Math.exp(-dtSec * (isHandheld ? 11.0 : 6.5));
      idleGimbal.x += (targetX - idleGimbal.x) * gimbalAlpha;
      idleGimbal.y += (targetY - idleGimbal.y) * gimbalAlpha;
      idleGimbal.rot += (targetRot - idleGimbal.rot) * gimbalAlpha;
      idleGimbal.breath += (targetBreath - idleGimbal.breath) * gimbalAlpha;
    } else {
      const settleAlpha = 1 - Math.exp(-dtSec * 6);
      idleGimbal.x *= 1 - settleAlpha;
      idleGimbal.y *= 1 - settleAlpha;
      idleGimbal.rot *= 1 - settleAlpha;
      idleGimbal.breath *= 1 - settleAlpha;
    }

    const idleScale = smoothBaseScale * (1 + idleGimbal.breath);
    idleEl.style.transform =
      `translate3d(${idleGimbal.x.toFixed(2)}px, ${idleGimbal.y.toFixed(2)}px, 0) ` +
      `rotate(${idleGimbal.rot.toFixed(3)}deg) scale(${idleScale.toFixed(4)})`;

    // 3. CẬP NHẬT LỚP #stage (VẬT LÝ ĐẬP BEAT MƯỢT MÀ BẰNG VI PHÂN LÒ XO)
    const subSteps = Math.max(1, Math.min(8, Math.ceil(dtSec / 0.004)));
    const subDt = dtSec / subSteps;
    const omega = beatPhys.omega;
    const zeta = beatPhys.zeta;
    const lightOmega = omega * 1.25;

    for (let s = 0; s < subSteps; s++) {
      [beatPhys.x, beatPhys.vx] = stepSpring1D(beatPhys.x, beatPhys.vx, omega, zeta, subDt);
      [beatPhys.y, beatPhys.vy] = stepSpring1D(beatPhys.y, beatPhys.vy, omega, zeta, subDt);
      [beatPhys.rot, beatPhys.vRot] = stepSpring1D(beatPhys.rot, beatPhys.vRot, omega, zeta, subDt);
      [beatPhys.scale, beatPhys.vScale] = stepSpring1D(beatPhys.scale, beatPhys.vScale, omega, zeta, subDt);
      [beatPhys.bright, beatPhys.vBright] = stepSpring1D(beatPhys.bright, beatPhys.vBright, lightOmega, 1.08, subDt);
      [beatPhys.hue, beatPhys.vHue] = stepSpring1D(beatPhys.hue, beatPhys.vHue, lightOmega, 1.08, subDt);
      [beatPhys.flash, beatPhys.vFlash] = stepSpring1D(beatPhys.flash, beatPhys.vFlash, lightOmega * 1.15, 1.12, subDt);
    }

    const isResting =
      Math.abs(beatPhys.x) < 0.04 &&
      Math.abs(beatPhys.y) < 0.04 &&
      Math.abs(beatPhys.rot) < 0.008 &&
      Math.abs(beatPhys.scale) < 0.0004 &&
      Math.abs(beatPhys.bright) < 0.003 &&
      Math.abs(beatPhys.hue) < 0.2;

    if (isResting) {
      stageEl.style.transform = 'translate3d(0px, 0px, 0) rotate(0deg) scale(1)';
      stageEl.style.filter = 'none';
    } else {
      let drawX = beatPhys.x;
      let drawY = beatPhys.y;
      let drawRot = beatPhys.rot;
      let drawScale = 1 + Math.max(-0.18, beatPhys.scale);

      // Nếu người dùng chọn kiểu 'step' (Giật nấc Glitch): lượng tử hóa nhẹ trên đường cong mượt
      if (beatPhys.motion === 'step') {
        const q = (val, unit) => (unit > 0 ? Math.round(val / unit) * unit : val);
        drawX = q(drawX, Math.max(1.5, (fx.shake || 8) * 0.22));
        drawY = q(drawY, Math.max(1.5, (fx.shake || 8) * 0.22));
        drawScale = 1 + q(beatPhys.scale, 0.015);
      }

      stageEl.style.transform =
        `translate3d(${drawX.toFixed(2)}px, ${drawY.toFixed(2)}px, 0) ` +
        `rotate(${drawRot.toFixed(3)}deg) scale(${drawScale.toFixed(4)})`;

      const filters = [];
      if (filterQuality >= 1 && Math.abs(beatPhys.bright) > 0.004) {
        filters.push(`brightness(${Math.max(0.5, 1 + beatPhys.bright).toFixed(3)})`);
      }
      if (filterQuality >= 2 && Math.abs(beatPhys.hue) > 0.3) {
        filters.push(`hue-rotate(${beatPhys.hue.toFixed(1)}deg)`);
      }
      stageEl.style.filter = filters.length > 0 ? filters.join(' ') : 'none';
    }

    if (beatPhys.flash > 0.004) {
      flashOverlay.style.opacity = logic.clamp(beatPhys.flash, 0, 0.9).toFixed(3);
    } else {
      flashOverlay.style.opacity = '0';
    }

    requestAnimationFrame(masterMotionLoop);
  }

  /**
   * Bơm xung lực đàn hồi mượt vào hệ lò xo khi có nhịp Beat (KHÔNG dịch chuyển tức thời 0ms):
   * Hình vươn êm ra đỉnh trong ~35–50 ms rồi đàn hồi mượt về tâm theo đúng thời gian hồi (decay).
   */
  function triggerBeatFx(k, fxOverride) {
    const fx = fxOverride ? logic.createDefaultFx(fxOverride) : currentFx;
    if (!fx || !fx.on) return;

    const now = performance.now();
    const strength = logic.clamp(k ?? 0.8, 0.2, 1);

    // Bơm xung mượt sang lớp rung nền #idle
    targetIdlePulse = Math.min(1.0, targetIdlePulse + 0.7 * strength);

    // Chọn góc giật mới cách góc trước >= 60 độ
    lastBeatAngle = logic.pickNextBeatAngle(lastBeatAngle);
    rotSign = -rotSign;

    const elapsedSincePrev = lastBeatTimeMs > 0 ? (now - lastBeatTimeMs) : Infinity;
    lastBeatTimeMs = now;
    const effDecayMs = logic.calculateEffectiveDecay(fx.decay, elapsedSincePrev);
    const decaySec = Math.max(0.09, effDecayMs / 1000);

    const motion = fx.motion || (fx.step ? 'step' : 'smooth');
    beatPhys.motion = motion;

    if (motion === 'spring') {
      // Lò xo đàn hồi: có nhịp nhún nhẹ qua tâm tự nhiên (~20%)
      beatPhys.zeta = 0.52;
      beatPhys.omega = logic.clamp(5.4 / decaySec, 14, 52);
    } else {
      // Mượt êm (Critically damped): phồng căng mịn ra đỉnh rồi lướt êm về 0 không cứng
      beatPhys.zeta = 1.04;
      beatPhys.omega = logic.clamp(4.4 / decaySec, 12, 46);
    }

    // Hệ số chuẩn hóa vận tốc đầu để đỉnh xung khớp biên độ thanh trượt:
    // Với lò xo giảm chấn tới hạn (zeta ~ 1), đỉnh đạt tại t = 1/omega với x_max = v0 / (omega * e)
    const velGain = beatPhys.omega * (motion === 'spring' ? 1.92 : Math.E);

    const peakX = Math.cos(lastBeatAngle) * fx.shake * strength;
    const peakY = Math.sin(lastBeatAngle) * fx.shake * strength;
    const peakRot = rotSign * fx.rot * strength;
    const peakScale = (fx.scale / 100) * strength;
    const peakBright = (fx.bright / 100) * strength;
    const peakHue = rotSign * fx.hue * strength;
    const peakFlash = (fx.flash / 100) * strength;

    // Cộng vận tốc mượt từ vị trí hiện tại (giữ liên tục đạo hàm, không bao giờ giật khung khi kick dày)
    beatPhys.vx = beatPhys.vx * 0.2 + (peakX - beatPhys.x * 0.55) * velGain;
    beatPhys.vy = beatPhys.vy * 0.2 + (peakY - beatPhys.y * 0.55) * velGain;
    beatPhys.vRot = beatPhys.vRot * 0.2 + (peakRot - beatPhys.rot * 0.55) * velGain;
    beatPhys.vScale = Math.max(0, beatPhys.vScale * 0.25) + Math.max(0, peakScale - beatPhys.scale * 0.5) * velGain;

    const lightGain = beatPhys.omega * 1.25 * Math.E;
    beatPhys.vBright = Math.max(0, peakBright - beatPhys.bright * 0.5) * lightGain;
    beatPhys.vHue = (peakHue - beatPhys.hue * 0.5) * lightGain;
    if (fx.flash > 0) {
      beatPhys.vFlash = Math.max(0, peakFlash - beatPhys.flash * 0.4) * lightGain * 1.15;
    }

    // Giới hạn an toàn để không vượt vùng phóng nền chống lộ viền (Overscan)
    const maxShake = Math.max(4, fx.shake * 1.18);
    beatPhys.x = logic.clamp(beatPhys.x, -maxShake, maxShake);
    beatPhys.y = logic.clamp(beatPhys.y, -maxShake, maxShake);
  }

  // =========================================================================
  // QUẢN LÝ MEDIA LAYER, VIDEO LOOP MƯỢT & CHUYỂN CẢNH CROSSFADE
  // =========================================================================

  function disposeLayer(layer) {
    if (!layer) return;
    if (typeof layer._cleanup === 'function') {
      try { layer._cleanup(); } catch (_) {}
    }
    const videos = layer.querySelectorAll('video');
    videos.forEach((v) => {
      try {
        v.pause();
        v.removeAttribute('src');
        v.load();
      } catch (_) {}
    });
    if (layer.parentNode) {
      layer.parentNode.removeChild(layer);
    }
  }

  function cleanupOldLayers(keepLayer) {
    const children = Array.from(layerContainer.children);
    for (const child of children) {
      if (child !== keepLayer) {
        disposeLayer(child);
      }
    }
  }

  function preloadMedia(url, mediaKind) {
    if (!url || preloadCache.has(url)) return;
    while (preloadCache.size >= MAX_PRELOAD) {
      const oldestKey = preloadCache.keys().next().value;
      const oldEntry = preloadCache.get(oldestKey);
      if (oldEntry && oldEntry.tagName === 'VIDEO') {
        try {
          oldEntry.pause();
          oldEntry.removeAttribute('src');
          oldEntry.load();
        } catch (_) {}
      }
      preloadCache.delete(oldestKey);
    }

    if (mediaKind === 'image') {
      const img = new Image();
      img.src = url;
      if (typeof img.decode === 'function') img.decode().catch(() => {});
      preloadCache.set(url, img);
    } else if (mediaKind === 'video') {
      const video = document.createElement('video');
      video.preload = 'auto';
      video.muted = true;
      video.playsInline = true;
      video.src = url;
      preloadCache.set(url, video);
    }
  }

  function applyAudioToVideo(v, vsound, vvol) {
    if (!v) return;
    const effVol = logic.clamp(((vvol ?? 100) / 100) * (masterVol / 100), 0, 1);
    v.volume = effVol;
    v.muted = !vsound || effVol <= 0.001;
    if (typeof v.setSinkId === 'function' && audioSinkId !== undefined) {
      v.setSinkId(audioSinkId || '').catch(() => {});
    }
  }

  function updateActiveLayerVideoAudio(opts) {
    clearInterval(videoFadeTimer);
    if (opts && opts.masterVol !== undefined) {
      masterVol = logic.clamp(opts.masterVol, 0, 100);
    }
    if (opts && opts.sinkId !== undefined) {
      audioSinkId = opts.sinkId || '';
    }
    if (!activeLayer || !activeLayer._videos) return;
    if (opts && opts.vsound !== undefined) {
      activeLayer._cueAudio.vsound = Boolean(opts.vsound);
    }
    if (opts && opts.vvol !== undefined) {
      activeLayer._cueAudio.vvol = logic.clamp(opts.vvol, 0, 100);
    }
    activeLayer._videos.forEach((v) => {
      applyAudioToVideo(v, activeLayer._cueAudio.vsound, activeLayer._cueAudio.vvol);
    });
  }

  function fadeOutActiveVideoAudio(durationSec) {
    clearInterval(videoFadeTimer);
    if (!activeLayer || !activeLayer._videos) return;
    const vids = activeLayer._videos;
    const durMs = Math.max(80, (Number(durationSec) || 2) * 1000);
    const startVols = vids.map((v) => (v.muted ? 0 : v.volume));
    const startedAt = performance.now();
    videoFadeTimer = setInterval(() => {
      const t = Math.min(1, (performance.now() - startedAt) / durMs);
      vids.forEach((v, idx) => {
        v.volume = Math.max(0, startVols[idx] * (1 - t));
        if (t >= 1) v.muted = true;
      });
      if (t >= 1) clearInterval(videoFadeTimer);
    }, 40);
  }

  function createVideoElement(url, fitClass, muted) {
    const v = document.createElement('video');
    v.className = fitClass;
    v.preload = 'auto';
    v.muted = Boolean(muted);
    v.playsInline = true;
    v.src = url;
    return v;
  }

  function createMediaLayer(cue, url, mediaKind, token) {
    const layer = document.createElement('div');
    layer.className = 'media-layer';
    layer.style.zIndex = String(++layerZ);

    const fitClass = cue.fit === 'cover' ? 'fit-cover' : 'fit-contain';
    let destroyed = false;
    let rafCheckId = null;

    if (mediaKind === 'image') {
      const img = document.createElement('img');
      img.className = fitClass;
      img.alt = '';
      img.onerror = () => {
        if (!destroyed) {
          window.api.notifyLedMediaError({
            cueId: cue.id,
            path: cue.vis,
            message: 'Không tải được ảnh trên màn hình LED.'
          });
        }
      };
      img.src = url;
      if (typeof img.decode === 'function') img.decode().catch(() => {});
      layer.appendChild(img);
      layer._cleanup = () => { destroyed = true; };
      return { layer, readyPromise: Promise.resolve() };
    }

    const cueAudio = {
      vsound: cue.vsound !== undefined ? Boolean(cue.vsound) : true,
      vvol: logic.clamp(cue.vvol ?? 100, 0, 100)
    };
    const vA = createVideoElement(url, fitClass, !cueAudio.vsound);
    const vB = cue.loop ? createVideoElement(url, fitClass, true) : null;
    applyAudioToVideo(vA, cueAudio.vsound, cueAudio.vvol);
    if (vB) applyAudioToVideo(vB, false, cueAudio.vvol);

    layer._videos = vB ? [vA, vB] : [vA];
    layer._cueAudio = cueAudio;

    vA.style.opacity = '1';
    layer.appendChild(vA);

    if (vB) {
      vB.style.opacity = '0';
      vB.style.transition = 'opacity 0.4s linear';
      vA.style.transition = 'opacity 0.4s linear';
      layer.appendChild(vB);
    }

    let front = vA;
    let back = vB;
    let crossfading = false;
    let nativeFallback = false;

    const onVideoError = () => {
      if (!destroyed) {
        window.api.notifyLedMediaError({
          cueId: cue.id,
          path: cue.vis,
          message: 'File này không phát được, hãy chuyển sang MP4 H.264'
        });
      }
    };
    vA.addEventListener('error', onVideoError);
    if (vB) vB.addEventListener('error', onVideoError);

    function monitorSmoothLoop() {
      if (destroyed || token !== showToken) return;
      if (cue.loop && back && !nativeFallback && front.duration && Number.isFinite(front.duration)) {
        if (front.duration < 1.2) {
          nativeFallback = true;
          front.loop = true;
        } else {
          const remaining = front.duration - front.currentTime;
          if (!crossfading && remaining <= 0.42 && remaining > 0.02) {
            crossfading = true;
            back.currentTime = 0;
            applyAudioToVideo(back, cueAudio.vsound, cueAudio.vvol);
            back.play().catch(() => {});
            back.style.opacity = '1';
            front.style.opacity = '0';

            const oldFront = front;
            front = back;
            back = oldFront;

            setTimeout(() => {
              if (destroyed) return;
              try {
                oldFront.muted = true;
                oldFront.pause();
                oldFront.currentTime = 0;
              } catch (_) {}
              crossfading = false;
            }, 430);
          }
        }
      }
      rafCheckId = requestAnimationFrame(monitorSmoothLoop);
    }

    const readyPromise = new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (!destroyed && token === showToken) {
          vA.play().catch(() => {});
          if (cue.loop) rafCheckId = requestAnimationFrame(monitorSmoothLoop);
        }
        resolve();
      };
      vA.addEventListener('canplay', done, { once: true });
      vA.addEventListener('error', done, { once: true });
      setTimeout(done, 180);
    });

    layer._cleanup = () => {
      destroyed = true;
      if (rafCheckId) cancelAnimationFrame(rafCheckId);
    };

    return { layer, readyPromise };
  }

  function fadeOutLayerVideos(layer, durMs) {
    if (!layer || !layer._videos || layer._videos.length === 0) return;
    const vids = layer._videos;
    if (durMs <= 30) {
      vids.forEach((v) => { v.muted = true; });
      return;
    }
    const startVols = vids.map((v) => (v.muted ? 0 : v.volume));
    const startMs = performance.now();
    const timer = setInterval(() => {
      const p = Math.min(1, (performance.now() - startMs) / durMs);
      vids.forEach((v, idx) => {
        try {
          v.volume = Math.max(0, startVols[idx] * (1 - p));
          if (p >= 1) v.muted = true;
        } catch (_) {}
      });
      if (p >= 1) clearInterval(timer);
    }, 30);
  }

  function runTransition(prevLayer, nextLayer, tr, durSec, token) {
    const durMs = Math.max(0, (Number(durSec) || 0) * 1000);

    if (!prevLayer || tr === 'cut' || durMs <= 20) {
      nextLayer.style.opacity = '1';
      cleanupOldLayers(nextLayer);
      return;
    }

    fadeOutLayerVideos(prevLayer, durMs);

    if (tr === 'fade') {
      nextLayer.style.opacity = '0';
      prevLayer.style.opacity = '1';

      const outAnim = prevLayer.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: durMs, easing: 'cubic-bezier(0.37, 0, 0.63, 1)', fill: 'forwards' }
      );
      const inAnim = nextLayer.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: durMs, easing: 'cubic-bezier(0.37, 0, 0.63, 1)', fill: 'forwards' }
      );

      Promise.allSettled([outAnim.finished, inAnim.finished]).then(() => {
        if (token === showToken) {
          nextLayer.style.opacity = '1';
          cleanupOldLayers(nextLayer);
        }
      });
      return;
    }

    if (tr === 'black') {
      const half = Math.max(40, durMs / 2);
      nextLayer.style.opacity = '0';
      const outAnim = prevLayer.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: half, easing: 'ease-in-out', fill: 'forwards' }
      );
      outAnim.onfinish = () => {
        if (token !== showToken) return;
        disposeLayer(prevLayer);
        const inAnim = nextLayer.animate(
          [{ opacity: 0 }, { opacity: 1 }],
          { duration: half, easing: 'ease-in-out', fill: 'forwards' }
        );
        inAnim.onfinish = () => {
          if (token === showToken) {
            nextLayer.style.opacity = '1';
            cleanupOldLayers(nextLayer);
          }
        };
      };
      return;
    }

    if (tr === 'slide-left' || tr === 'slide-right') {
      const dir = tr === 'slide-left' ? 1 : -1;
      nextLayer.style.opacity = '1';
      const outAnim = prevLayer.animate(
        [
          { transform: 'translateX(0%)', opacity: 1 },
          { transform: `translateX(${-100 * dir}%)`, opacity: 0 }
        ],
        { duration: durMs, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' }
      );
      const inAnim = nextLayer.animate(
        [
          { transform: `translateX(${100 * dir}%)`, opacity: 0.35 },
          { transform: 'translateX(0%)', opacity: 1 }
        ],
        { duration: durMs, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' }
      );
      Promise.allSettled([outAnim.finished, inAnim.finished]).then(() => {
        if (token === showToken) cleanupOldLayers(nextLayer);
      });
      return;
    }

    if (tr === 'zoom') {
      nextLayer.style.opacity = '0';
      const outAnim = prevLayer.animate(
        [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.92)' }],
        { duration: durMs, easing: 'ease-in-out', fill: 'forwards' }
      );
      const inAnim = nextLayer.animate(
        [{ opacity: 0, transform: 'scale(1.12)' }, { opacity: 1, transform: 'scale(1)' }],
        { duration: durMs, easing: 'ease-in-out', fill: 'forwards' }
      );
      Promise.allSettled([outAnim.finished, inAnim.finished]).then(() => {
        if (token === showToken) {
          nextLayer.style.opacity = '1';
          cleanupOldLayers(nextLayer);
        }
      });
      return;
    }

    cleanupOldLayers(nextLayer);
  }

  async function handleShowCommand(cmd) {
    const token = ++showToken;
    const cue = cmd.cue || {};
    clearInterval(videoFadeTimer);

    if (cmd.masterVol !== undefined) masterVol = logic.clamp(cmd.masterVol, 0, 100);
    if (cmd.sinkId !== undefined) audioSinkId = cmd.sinkId || '';

    currentFx = logic.createDefaultFx(cue.fx);
    applyTextOverlay(cue.text);

    if (!cmd.url) {
      if (!cue.keepAudio && activeLayer && activeLayer._videos) {
        fadeOutActiveVideoAudio(cue.fadeOut ?? 0.8);
      }
      return;
    }

    const existing = Array.from(layerContainer.children);
    if (existing.length > 1) {
      const latest = existing[existing.length - 1];
      existing.forEach((el) => {
        if (el !== latest) disposeLayer(el);
      });
      latest.getAnimations().forEach((a) => {
        try { a.cancel(); } catch (_) {}
      });
      latest.style.opacity = '1';
      latest.style.transform = 'none';
      activeLayer = latest;
    }

    const prevLayer = activeLayer;
    const { layer: nextLayer, readyPromise } = createMediaLayer(cue, cmd.url, cmd.mediaKind, token);
    nextLayer.style.opacity = cue.tr === 'cut' ? '1' : '0';
    layerContainer.appendChild(nextLayer);

    await readyPromise;
    if (token !== showToken) {
      disposeLayer(nextLayer);
      return;
    }

    activeLayer = nextLayer;
    runTransition(prevLayer, nextLayer, cue.tr || 'fade', cue.dur ?? 0.8, token);
  }

  function applyTextOverlay(textCfg) {
    const cfg = logic.createDefaultTextOverlay(textCfg);
    if (!cfg.on || !cfg.content.trim()) {
      textOverlay.classList.add('hidden');
      return;
    }
    textOverlay.className = `pos-${cfg.pos}`;
    textBox.textContent = cfg.content;
    textBox.style.fontSize = `${cfg.size}px`;
    textBox.style.color = cfg.color;
    textBox.className = cfg.bgBox ? 'with-bg' : '';
  }

  function drawTestPattern() {
    const w = Math.max(320, window.innerWidth);
    const h = Math.max(180, window.innerHeight);
    testCanvas.width = w;
    testCanvas.height = h;
    const ctx = testCanvas.getContext('2d');

    const topColors = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
    const barW = w / 7;
    const topH = Math.floor(h * 0.67);
    topColors.forEach((col, i) => {
      ctx.fillStyle = col;
      ctx.fillRect(i * barW, 0, Math.ceil(barW), topH);
    });

    const midColors = ['#0000c0', '#131313', '#c000c0', '#131313', '#00c0c0', '#131313', '#c0c0c0'];
    const midH = Math.floor(h * 0.08);
    midColors.forEach((col, i) => {
      ctx.fillStyle = col;
      ctx.fillRect(i * barW, topH, Math.ceil(barW), midH);
    });

    const botY = topH + midH;
    const botH = h - botY;
    const graySteps = 10;
    const stepW = w / graySteps;
    for (let i = 0; i < graySteps; i++) {
      const v = Math.round((i / (graySteps - 1)) * 255);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(i * stepW, botY, Math.ceil(stepW), botH);
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      const gx = Math.round((w * i) / 10) + 0.5;
      const gy = Math.round((h * i) / 10) + 0.5;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.lineTo(gx, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, w - 4, h - 4);

    testBadge.textContent = `LED OK ✔ — ${w} × ${h}`;
  }

  window.addEventListener('resize', () => {
    if (!testPatternEl.classList.contains('hidden')) {
      drawTestPattern();
    }
  });

  window.api.onCommand((cmd) => {
    if (!cmd || typeof cmd !== 'object') return;
    switch (cmd.type) {
      case 'show':
        handleShowCommand(cmd);
        break;
      case 'preload':
        preloadMedia(cmd.url, cmd.mediaKind);
        break;
      case 'fx':
      case 'idle':
        currentFx = logic.createDefaultFx(cmd.fx);
        filterQuality = 2;
        break;
      case 'video-audio':
        updateActiveLayerVideoAudio(cmd);
        break;
      case 'fade-video-audio':
        fadeOutActiveVideoAudio(cmd.durationSec ?? 2.0);
        break;
      case 'level':
        rawBassEnv = logic.clamp(cmd.env ?? 0, 0, 1);
        musicPlaying = Boolean(cmd.playing);
        break;
      case 'test-idle':
        testIdleOn = Boolean(cmd.on);
        if (cmd.fx) currentFx = logic.createDefaultFx(cmd.fx);
        break;
      case 'beat':
        triggerBeatFx(cmd.k, cmd.fx);
        break;
      case 'text':
        applyTextOverlay(cmd.text);
        break;
      case 'blackout':
        blackoutOverlay.classList.toggle('active', Boolean(cmd.on));
        break;
      case 'clear':
        showToken++;
        activeLayer = null;
        cleanupOldLayers(null);
        textOverlay.classList.add('hidden');
        blackoutOverlay.classList.remove('active');
        musicPlaying = false;
        rawBassEnv = 0;
        break;
      case 'test-pattern':
        if (cmd.on) {
          drawTestPattern();
          testPatternEl.classList.remove('hidden');
        } else {
          testPatternEl.classList.add('hidden');
        }
        break;
      default:
        break;
    }
  });

  window.addEventListener('DOMContentLoaded', () => {
    lastFrameMs = performance.now();
    requestAnimationFrame(masterMotionLoop);
    window.api.notifyLedReady();
  });
})();
