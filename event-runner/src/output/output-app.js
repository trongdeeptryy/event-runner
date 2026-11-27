/**
 * Controller cửa sổ màn hình LED (output.html) — EVENT RUNNER v3.0 Pro
 * Compositor GPU đa tầng 60–144 FPS với MỘT vòng lặp requestAnimationFrame(masterMotionLoop) duy nhất:
 *   #output-mapping-root -> Crop, Offset, Scale, Flip, Perspective Keystone
 *   #idle                -> Cinema Camera Float (Spline bậc 3 Catmull-Rom + Gimbal)
 *   #stage               -> Spring-Damper Beat FX + 3 tầng VJ (#layer-container, #vj-layer-2, #vj-layer-3)
 *   #fx-glitch-canvas    -> Mirror/Kaleido, Pixelate, RGB Split & Glitch (liên kết Beat)
 *   #beat-led-canvas     -> Engine chớp đèn LED sân khấu 8 chế độ + Momentary
 *   #overlays-root       -> vMix Overlays (Lower Third, Corner Logo, Event Timer, Marquee Ticker)
 */
'use strict';

(function () {
  const logic = window.EventRunnerLogic;
  const vjGenerators = window.EventRunnerVjGenerators;
  const LedBeatEngineClass = window.EventRunnerLedBeatEngine;

  const outputMappingRoot = document.getElementById('output-mapping-root');
  const idleEl = document.getElementById('idle');
  const stageEl = document.getElementById('stage');
  const layerContainer = document.getElementById('layer-container');
  const vjLayer2El = document.getElementById('vj-layer-2');
  const vjLayer3El = document.getElementById('vj-layer-3');
  const fxGlitchCanvas = document.getElementById('fx-glitch-canvas');
  const beatLedCanvas = document.getElementById('beat-led-canvas');
  const flashOverlay = document.getElementById('flash-overlay');
  const ovLowerThirdEl = document.getElementById('ov-lower-third');
  const ovLogoEl = document.getElementById('ov-logo');
  const ovTimerEl = document.getElementById('ov-timer');
  const ovTickerEl = document.getElementById('ov-ticker');
  const textOverlay = document.getElementById('text-overlay');
  const textBox = document.getElementById('text-box');
  const masterVignetteEl = document.getElementById('master-vignette');
  const masterDimmerEl = document.getElementById('master-dimmer');
  const blackoutOverlay = document.getElementById('blackout-overlay');
  const testPatternEl = document.getElementById('test-pattern');
  const testCanvas = document.getElementById('test-canvas');
  const testBadge = document.getElementById('test-badge');

  const ledBeatEngine = LedBeatEngineClass ? new LedBeatEngineClass(beatLedCanvas) : null;

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

  // Trạng thái âm thanh & rung nền ngẫu nhiên mượt
  let rawBassEnv = 0;
  let smoothBassEnv = 0;
  let musicPlaying = false;
  let testIdleOn = false;
  let idleActiveFactor = 0;
  let idlePhase = Math.random() * 100;
  let targetIdlePulse = 0;
  let smoothIdlePulse = 0;
  let smoothBaseScale = 1;
  let transitionFlash = 0;

  // Trạng thái dải âm thanh 3-band & beat cho VJ Generator + Master FX
  const audioState = {
    bass: 0,
    mid: 0,
    high: 0,
    spectrum: null,
    bpm: 120,
    beatPhase: 0,
    beatIndex: 0,
    beatPulse: 0,
    playing: false
  };

  // Trạng thái LED Sync & Momentary Invert
  let ledSyncMode = 'off';
  let ledSyncDecayMs = 180;
  let stageInvertPulse = 0;
  let momentaryInvertActive = false;

  // Quản lý T-Bar Preview Layer
  const tbarState = {
    layer: null,
    cueKey: '',
    token: 0
  };

  // Quản lý 3 tầng VJ (Layer 0 dùng #layer-container, Layer 1 dùng #vj-layer-2, Layer 2 dùng #vj-layer-3)
  const vjLayers = [
    {
      index: 0,
      container: layerContainer,
      mediaLayer: null,
      clip: null,
      token: 0,
      visible: true,
      params: { opacity: 100, blend: 'normal', speed: 1, bypass: false, solo: false, audioReact: false }
    },
    {
      index: 1,
      container: vjLayer2El,
      mediaLayer: null,
      clip: null,
      token: 0,
      visible: true,
      params: { opacity: 100, blend: 'plus-lighter', speed: 1, bypass: false, solo: false, audioReact: false }
    },
    {
      index: 2,
      container: vjLayer3El,
      mediaLayer: null,
      clip: null,
      token: 0,
      visible: true,
      params: { opacity: 100, blend: 'plus-lighter', speed: 1, bypass: false, solo: false, audioReact: false }
    }
  ];

  // Các phần tử đang chạy bên trong vòng lặp masterMotionLoop duy nhất
  const activeLoopingVideos = new Set();
  const activeGenerators = new Set();

  // Trạng thái Master FX & Output Mapping
  let currentMasterFx = {
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

  let fxBeatImpulse = 0;
  let glitchCleared = true;
  const fxCtx = fxGlitchCanvas ? fxGlitchCanvas.getContext('2d') : null;
  let fxScratchCanvas = null;
  let fxScratchCtx = null;
  let fxPixCanvas = null;
  let fxPixCtx = null;
  let fxRedCanvas = null;
  let fxRedCtx = null;
  let fxCyanCanvas = null;
  let fxCyanCtx = null;

  // Trạng thái vMix Overlays (OV1..OV4)
  const tickerAnim = {
    active: false,
    speed: 85,
    x: 0,
    cycleW: 0,
    signature: '',
    trackEl: null
  };
  let lastOv1Sig = '';
  let lastOv2Url = '';
  let lastOv3TimerSig = '';

  // Quán tính gimbal cho #idle
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

  const VALID_BLENDS = new Set([
    'normal', 'screen', 'plus-lighter', 'multiply', 'overlay',
    'lighten', 'difference', 'color-dodge', 'hard-light'
  ]);

  window.addEventListener('error', (ev) => {
    window.api.reportRendererError({ where: 'output', message: ev.message });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    window.api.reportRendererError({ where: 'output:promise', message: String(ev.reason) });
  });

  function sanitizeBlendMode(blend, fallback) {
    return VALID_BLENDS.has(blend) ? blend : (fallback || 'normal');
  }

  function safeHexToRgb(hex) {
    if (logic && typeof logic.hexToRgb === 'function') {
      return logic.hexToRgb(hex);
    }
    const clean = typeof hex === 'string' ? hex.trim().replace('#', '') : '';
    if (/^[0-9a-fA-F]{6}$/.test(clean)) {
      return {
        r: parseInt(clean.slice(0, 2), 16),
        g: parseInt(clean.slice(2, 4), 16),
        b: parseInt(clean.slice(4, 6), 16)
      };
    }
    return { r: 8, g: 16, b: 28 };
  }

  // =========================================================================
  // HÀM NHIỄU NGẪU NHIÊN SPLINE BẬC 3 CATMULL-ROM
  // =========================================================================

  function hashRand1D(n, seed) {
    const s = Math.sin(n * 127.1 + seed * 311.7) * 43758.5453123;
    return (s - Math.floor(s)) * 2 - 1;
  }

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

  function sampleOrganicWander(phase, seed, detailWeight) {
    const slowDrift = catmullRomNoise(phase, seed);
    const microSway = catmullRomNoise(phase * 2.13 + 17.7, seed + 53);
    return (slowDrift + microSway * detailWeight) / (1 + detailWeight);
  }

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
  // ENGINE VẬT LÝ CHUYỂN ĐỘNG + VIDEO LOOP + VJ GENERATORS + MASTER FX CANVAS
  // =========================================================================

  function stepSpring1D(pos, vel, omega, zeta, dt) {
    const acc = -omega * omega * pos - 2 * zeta * omega * vel;
    const nextVel = vel + acc * dt;
    const nextPos = pos + nextVel * dt;
    return [nextPos, nextVel];
  }

  function stepActiveLoopingVideos() {
    for (const entry of activeLoopingVideos) {
      if (entry.destroyed) {
        activeLoopingVideos.delete(entry);
        continue;
      }
      const front = entry.front;
      const back = entry.back;
      if (entry.loop && back && !entry.nativeFallback && front && front.duration && Number.isFinite(front.duration)) {
        if (front.duration < 1.2) {
          entry.nativeFallback = true;
          front.loop = true;
        } else {
          const remaining = front.duration - front.currentTime;
          if (!entry.crossfading && remaining <= 0.42 && remaining > 0.02) {
            entry.crossfading = true;
            back.currentTime = 0;
            if (!entry.muted) {
              applyAudioToVideo(back, entry.cueAudio.vsound, entry.cueAudio.vvol);
            } else {
              back.muted = true;
            }
            back.playbackRate = front.playbackRate || 1;
            back.play().catch(() => {});
            back.style.opacity = '1';
            front.style.opacity = '0';

            const oldFront = front;
            entry.front = back;
            entry.back = oldFront;
            if (entry.layer) entry.layer._activeVideo = back;

            setTimeout(() => {
              if (entry.destroyed) return;
              try {
                if (!entry.muted) {
                  applyAudioToVideo(oldFront, false, entry.cueAudio.vvol);
                } else {
                  oldFront.muted = true;
                }
                oldFront.pause();
                oldFront.currentTime = 0;
              } catch (_) {}
              entry.crossfading = false;
            }, 430);
          }
        }
      }
    }
  }

  function syncCanvasSize(canvas, ctx, maxW) {
    const cw = canvas.clientWidth || window.innerWidth || 1920;
    const ch = canvas.clientHeight || window.innerHeight || 1080;
    if (cw <= 0 || ch <= 0) return null;
    const rawDpr = window.devicePixelRatio || 1;
    let targetW = Math.round(cw * Math.min(rawDpr, 1.5));
    let targetH = Math.round(ch * Math.min(rawDpr, 1.5));
    if (maxW && targetW > maxW) {
      const ratio = maxW / targetW;
      targetW = maxW;
      targetH = Math.max(1, Math.round(targetH * ratio));
    }
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const scaleX = targetW / cw;
    const scaleY = targetH / ch;
    ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    return { w: cw, h: ch, pxW: targetW, pxH: targetH };
  }

  function stepGenerators(dtSec) {
    if (!vjGenerators || activeGenerators.size === 0) return;

    for (const gen of activeGenerators) {
      if (gen.destroyed) {
        activeGenerators.delete(gen);
        continue;
      }
      if (gen.layerEl && gen.layerEl.parentNode) {
        const parent = gen.layerEl.parentNode;
        if (parent.style.display === 'none') continue;
      }

      const size = syncCanvasSize(gen.canvas, gen.ctx, 1920);
      if (!size) continue;

      const vjState = typeof gen.vjIndex === 'number' ? vjLayers[gen.vjIndex] : null;
      const layerSpeed = vjState ? (Number(vjState.params.speed) || 1) : 1;
      const effSpeed = logic.clamp((Number(gen.speed) || 1) * layerSpeed, 0.1, 8);
      gen.timeSec += dtSec * effSpeed;

      vjGenerators.renderGeneratorFrame(gen.ctx, size.w, size.h, gen.type, {
        timeSec: gen.timeSec,
        dtSec,
        bass: audioState.bass,
        mid: audioState.mid,
        high: audioState.high,
        spectrum: audioState.spectrum,
        bpm: audioState.bpm,
        beatPhase: audioState.beatPhase,
        beatPulse: audioState.beatPulse,
        beatIndex: audioState.beatIndex,
        color: gen.color,
        isOverlay: gen.isOverlay
      });
    }
  }

  function applyVjAudioReact() {
    for (let i = 0; i < vjLayers.length; i++) {
      const l = vjLayers[i];
      if (!l.visible) continue;
      if (!l.params.audioReact) continue;
      const baseOp = logic.clamp(l.params.opacity, 0, 100) / 100;
      const energy = Math.max(audioState.bass, audioState.mid * 0.85, audioState.beatPulse * 0.9);
      const effOp = logic.clamp(baseOp * (0.48 + energy * 0.72), 0, 1);
      const effScale = 1 + audioState.bass * 0.065 + audioState.beatPulse * 0.045;
      l.container.style.opacity = effOp.toFixed(3);
      l.container.style.transform = `scale(${effScale.toFixed(4)})`;
    }
  }

  // =========================================================================
  // RENDER MASTER FX CANVAS (MIRROR / KALEIDO / PIXELATE / RGB SPLIT / GLITCH)
  // =========================================================================

  function ensureOffscreen(holder, w, h) {
    if (!holder) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return { canvas: c, ctx: c.getContext('2d') };
    }
    if (holder.canvas.width !== w || holder.canvas.height !== h) {
      holder.canvas.width = w;
      holder.canvas.height = h;
    }
    return holder;
  }

  function drawSourceElementFitted(ctx, el, dstW, dstH) {
    let srcW = 0;
    let srcH = 0;
    if (el.tagName === 'VIDEO') {
      if (el.readyState < 2 || el.videoWidth <= 0 || el.videoHeight <= 0) return;
      srcW = el.videoWidth;
      srcH = el.videoHeight;
    } else if (el.tagName === 'IMG') {
      if (!el.complete || el.naturalWidth <= 0 || el.naturalHeight <= 0) return;
      srcW = el.naturalWidth;
      srcH = el.naturalHeight;
    } else if (el.tagName === 'CANVAS') {
      if (el.width <= 0 || el.height <= 0) return;
      ctx.drawImage(el, 0, 0, dstW, dstH);
      return;
    } else {
      return;
    }

    const isCover = el.classList.contains('fit-cover');
    const srcAspect = srcW / srcH;
    const dstAspect = dstW / dstH;
    let dx = 0;
    let dy = 0;
    let dw = dstW;
    let dh = dstH;

    if (isCover) {
      if (srcAspect > dstAspect) {
        dh = dstH;
        dw = dstH * srcAspect;
        dx = (dstW - dw) * 0.5;
      } else {
        dw = dstW;
        dh = dstW / srcAspect;
        dy = (dstH - dh) * 0.5;
      }
    } else {
      if (srcAspect > dstAspect) {
        dw = dstW;
        dh = dstW / srcAspect;
        dy = (dstH - dh) * 0.5;
      } else {
        dh = dstH;
        dw = dstH * srcAspect;
        dx = (dstW - dw) * 0.5;
      }
    }

    try {
      ctx.drawImage(el, dx, dy, dw, dh);
    } catch (_) {}
  }

  function compositeStageLayersToCanvas(targetCtx, w, h) {
    targetCtx.globalCompositeOperation = 'source-over';
    targetCtx.globalAlpha = 1;
    targetCtx.fillStyle = '#000000';
    targetCtx.fillRect(0, 0, w, h);

    let drewAny = false;
    for (let i = 0; i < vjLayers.length; i++) {
      const l = vjLayers[i];
      if (!l.visible) continue;
      const containerOp = parseFloat(l.container.style.opacity);
      const layerOpacity = Number.isFinite(containerOp)
        ? containerOp
        : logic.clamp(l.params.opacity, 0, 100) / 100;
      if (layerOpacity <= 0.01) continue;

      const mediaLayers = l.container.querySelectorAll('.media-layer');
      if (mediaLayers.length === 0) continue;

      const blend = sanitizeBlendMode(l.params.blend, 'normal');
      targetCtx.globalCompositeOperation = blend === 'normal' ? 'source-over' : blend;

      for (let m = 0; m < mediaLayers.length; m++) {
        const ml = mediaLayers[m];
        const mlOp = ml.style.opacity !== '' ? parseFloat(ml.style.opacity) : 1;
        if (!Number.isFinite(mlOp) || mlOp <= 0.01) continue;

        const children = ml.children;
        for (let c = 0; c < children.length; c++) {
          const el = children[c];
          const elOp = el.style.opacity !== '' ? parseFloat(el.style.opacity) : 1;
          const totalOp = layerOpacity * mlOp * (Number.isFinite(elOp) ? elOp : 1);
          if (totalOp <= 0.01) continue;
          targetCtx.globalAlpha = logic.clamp(totalOp, 0, 1);
          drawSourceElementFitted(targetCtx, el, w, h);
          drewAny = true;
        }
      }
    }
    targetCtx.globalAlpha = 1;
    targetCtx.globalCompositeOperation = 'source-over';
    return drewAny;
  }

  function renderMasterFxCanvas(nowMs) {
    if (!fxGlitchCanvas || !fxCtx) return;

    const fx = currentMasterFx;
    const mirror = fx.mirror || 'none';
    const pixelate = logic.clamp(fx.pixelate || 0, 0, 100);
    const baseRgb = logic.clamp(fx.rgbSplit || 0, 0, 100);
    const baseGlitch = logic.clamp(fx.glitch || 0, 0, 100);

    const beatEnergy = Math.max(fxBeatImpulse, audioState.bass * 0.75);
    const effRgb = fx.rgbBeatLink ? Math.min(100, baseRgb + beatEnergy * 55) : baseRgb;
    const effGlitch = fx.glitchBeatLink ? Math.min(100, baseGlitch + beatEnergy * 60) : baseGlitch;

    const active = mirror !== 'none' || pixelate > 0.5 || effRgb > 0.5 || effGlitch > 0.5;
    if (!active) {
      if (!glitchCleared) {
        fxCtx.setTransform(1, 0, 0, 1, 0, 0);
        fxCtx.clearRect(0, 0, fxGlitchCanvas.width, fxGlitchCanvas.height);
        glitchCleared = true;
      }
      return;
    }

    const size = syncCanvasSize(fxGlitchCanvas, fxCtx, 1280);
    if (!size) return;
    const w = size.w;
    const h = size.h;

    const workW = Math.min(960, Math.max(320, Math.round(size.pxW * 0.75)));
    const workH = Math.min(540, Math.max(180, Math.round(size.pxH * 0.75)));

    const scratchHolder = ensureOffscreen(
      fxScratchCanvas ? { canvas: fxScratchCanvas, ctx: fxScratchCtx } : null,
      workW,
      workH
    );
    fxScratchCanvas = scratchHolder.canvas;
    fxScratchCtx = scratchHolder.ctx;

    const hasContent = compositeStageLayersToCanvas(fxScratchCtx, workW, workH);
    if (!hasContent) {
      if (!glitchCleared) {
        fxCtx.clearRect(0, 0, w, h);
        glitchCleared = true;
      }
      return;
    }

    glitchCleared = false;
    fxCtx.clearRect(0, 0, w, h);

    // 1. Áp dụng Mirror / Kaleidoscope lên fxCtx (hoặc nguồn đã tổng hợp)
    const destHolder = ensureOffscreen(
      fxPixCanvas ? { canvas: fxPixCanvas, ctx: fxPixCtx } : null,
      workW,
      workH
    );
    fxPixCanvas = destHolder.canvas;
    fxPixCtx = destHolder.ctx;

    // Bước Mirror / Kaleido vào fxPixCanvas trước để các hiệu ứng sau xếp chồng mượt
    fxPixCtx.save();
    fxPixCtx.setTransform(1, 0, 0, 1, 0, 0);
    fxPixCtx.globalCompositeOperation = 'source-over';
    fxPixCtx.clearRect(0, 0, workW, workH);

    if (mirror === 'mirror-h') {
      const hw = workW * 0.5;
      fxPixCtx.drawImage(fxScratchCanvas, 0, 0, hw, workH, 0, 0, hw, workH);
      fxPixCtx.save();
      fxPixCtx.translate(workW, 0);
      fxPixCtx.scale(-1, 1);
      fxPixCtx.drawImage(fxScratchCanvas, 0, 0, hw, workH, 0, 0, hw, workH);
      fxPixCtx.restore();
    } else if (mirror === 'mirror-v') {
      const hh = workH * 0.5;
      fxPixCtx.drawImage(fxScratchCanvas, 0, 0, workW, hh, 0, 0, workW, hh);
      fxPixCtx.save();
      fxPixCtx.translate(0, workH);
      fxPixCtx.scale(1, -1);
      fxPixCtx.drawImage(fxScratchCanvas, 0, 0, workW, hh, 0, 0, workW, hh);
      fxPixCtx.restore();
    } else if (mirror === 'quad') {
      const hw = workW * 0.5;
      const hh = workH * 0.5;
      fxPixCtx.drawImage(fxScratchCanvas, 0, 0, hw, hh, 0, 0, hw, hh);
      fxPixCtx.save();
      fxPixCtx.translate(workW, 0);
      fxPixCtx.scale(-1, 1);
      fxPixCtx.drawImage(fxScratchCanvas, 0, 0, hw, hh, 0, 0, hw, hh);
      fxPixCtx.restore();
      fxPixCtx.save();
      fxPixCtx.translate(0, workH);
      fxPixCtx.scale(1, -1);
      fxPixCtx.drawImage(fxScratchCanvas, 0, 0, hw, hh, 0, 0, hw, hh);
      fxPixCtx.restore();
      fxPixCtx.save();
      fxPixCtx.translate(workW, workH);
      fxPixCtx.scale(-1, -1);
      fxPixCtx.drawImage(fxScratchCanvas, 0, 0, hw, hh, 0, 0, hw, hh);
      fxPixCtx.restore();
    } else if (mirror === 'kaleido') {
      const slices = 8;
      const angleStep = (Math.PI * 2) / slices;
      const radius = Math.hypot(workW, workH) * 0.55;
      const cx = workW * 0.5;
      const cy = workH * 0.5;
      const rotBase = nowMs * 0.00025;
      fxPixCtx.fillStyle = '#000000';
      fxPixCtx.fillRect(0, 0, workW, workH);
      for (let s = 0; s < slices; s++) {
        fxPixCtx.save();
        fxPixCtx.translate(cx, cy);
        fxPixCtx.rotate(s * angleStep + rotBase);
        if (s % 2 === 1) fxPixCtx.scale(1, -1);
        fxPixCtx.beginPath();
        fxPixCtx.moveTo(0, 0);
        fxPixCtx.arc(0, 0, radius, -angleStep * 0.52, angleStep * 0.52);
        fxPixCtx.closePath();
        fxPixCtx.clip();
        fxPixCtx.drawImage(fxScratchCanvas, -cx, -cy, workW, workH);
        fxPixCtx.restore();
      }
    } else {
      fxPixCtx.drawImage(fxScratchCanvas, 0, 0);
    }
    fxPixCtx.restore();

    // 2. Pixelate (giảm độ phân giải trực tiếp trên GPU rồi phóng không làm mịn)
    if (pixelate > 0.5) {
      const block = 2 + (pixelate / 100) * 34;
      const smallW = Math.max(16, Math.round(workW / block));
      const smallH = Math.max(9, Math.round(workH / block));
      fxScratchCtx.save();
      fxScratchCtx.globalCompositeOperation = 'source-over';
      fxScratchCtx.imageSmoothingEnabled = true;
      fxScratchCtx.clearRect(0, 0, smallW, smallH);
      fxScratchCtx.drawImage(fxPixCanvas, 0, 0, workW, workH, 0, 0, smallW, smallH);
      fxScratchCtx.restore();

      fxPixCtx.save();
      fxPixCtx.globalCompositeOperation = 'source-over';
      fxPixCtx.imageSmoothingEnabled = false;
      fxPixCtx.clearRect(0, 0, workW, workH);
      fxPixCtx.drawImage(fxScratchCanvas, 0, 0, smallW, smallH, 0, 0, workW, workH);
      fxPixCtx.imageSmoothingEnabled = true;
      fxPixCtx.restore();
    }

    // 3. RGB Chromatic Split (tách kênh Đỏ + Xanh lơ chuẩn GPU không tốn pixel loop)
    if (effRgb > 0.5) {
      const shift = (effRgb / 100) * (workW * 0.028);
      const redH = ensureOffscreen(fxRedCanvas ? { canvas: fxRedCanvas, ctx: fxRedCtx } : null, workW, workH);
      const cyanH = ensureOffscreen(fxCyanCanvas ? { canvas: fxCyanCanvas, ctx: fxCyanCtx } : null, workW, workH);
      fxRedCanvas = redH.canvas;
      fxRedCtx = redH.ctx;
      fxCyanCanvas = cyanH.canvas;
      fxCyanCtx = cyanH.ctx;

      fxRedCtx.globalCompositeOperation = 'source-over';
      fxRedCtx.drawImage(fxPixCanvas, 0, 0);
      fxRedCtx.globalCompositeOperation = 'multiply';
      fxRedCtx.fillStyle = '#ff0000';
      fxRedCtx.fillRect(0, 0, workW, workH);

      fxCyanCtx.globalCompositeOperation = 'source-over';
      fxCyanCtx.drawImage(fxPixCanvas, 0, 0);
      fxCyanCtx.globalCompositeOperation = 'multiply';
      fxCyanCtx.fillStyle = '#00ffff';
      fxCyanCtx.fillRect(0, 0, workW, workH);

      fxCtx.save();
      fxCtx.fillStyle = '#000000';
      fxCtx.fillRect(0, 0, w, h);
      fxCtx.imageSmoothingEnabled = pixelate <= 0.5;
      fxCtx.drawImage(fxRedCanvas, -(shift / workW) * w, 0, w, h);
      fxCtx.globalCompositeOperation = 'lighter';
      fxCtx.drawImage(fxCyanCanvas, (shift / workW) * w, 0, w, h);
      fxCtx.restore();
    } else {
      fxCtx.save();
      fxCtx.imageSmoothingEnabled = pixelate <= 0.5;
      fxCtx.drawImage(fxPixCanvas, 0, 0, w, h);
      fxCtx.restore();
    }

    // 4. Glitch Slice & Scanline Blocks
    if (effGlitch > 0.5) {
      const amt = effGlitch / 100;
      const seed = Math.floor(nowMs / 42);
      const sliceCount = Math.round(4 + amt * 14);
      const maxShift = w * 0.12 * amt;

      fxCtx.save();
      for (let i = 0; i < sliceCount; i++) {
        const r1 = (Math.sin((seed + i * 7) * 12.9898) * 43758.5453) % 1;
        const r2 = (Math.sin((seed + i * 13) * 78.233) * 43758.5453) % 1;
        const r3 = (Math.sin((seed + i * 19) * 39.425) * 43758.5453) % 1;
        const u1 = r1 < 0 ? r1 + 1 : r1;
        const u2 = r2 < 0 ? r2 + 1 : r2;
        const u3 = r3 < 0 ? r3 + 1 : r3;

        const sy = Math.floor(u1 * workH);
        const sh = Math.max(4, Math.floor((0.02 + u2 * 0.08) * workH));
        const dy = (sy / workH) * h;
        const dh = (sh / workH) * h;
        const dx = (u3 - 0.5) * 2 * maxShift;

        fxCtx.drawImage(fxPixCanvas, 0, sy, workW, sh, dx, dy, w, dh);

        if (u2 > 0.72) {
          fxCtx.fillStyle = i % 2 === 0 ? `rgba(0,210,255,${(amt * 0.35).toFixed(2)})` : `rgba(255,0,127,${(amt * 0.35).toFixed(2)})`;
          fxCtx.fillRect(0, dy, w, Math.max(2, dh * 0.28));
        }
      }
      fxCtx.restore();
    }
  }

  // =========================================================================
  // BƯỚC TICKER OV4 MƯỢT TRONG masterMotionLoop
  // =========================================================================

  function stepTicker(dtSec) {
    if (!tickerAnim.active || !tickerAnim.trackEl || tickerAnim.cycleW <= 0) return;
    tickerAnim.x -= tickerAnim.speed * dtSec;
    if (tickerAnim.x <= -tickerAnim.cycleW) {
      tickerAnim.x += tickerAnim.cycleW;
    }
    tickerAnim.trackEl.style.transform = `translate3d(${tickerAnim.x.toFixed(2)}px, 0, 0)`;
  }

  // =========================================================================
  // VÒNG LẶP REQUESTANIMATIONFRAME DUY NHẤT (60–144 FPS)
  // =========================================================================

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

    // 1. Làm mượt bao hình bass, xung beat & xung FX
    const envAlpha = 1 - Math.exp(-dtSec * 9);
    smoothBassEnv += (rawBassEnv - smoothBassEnv) * envAlpha;

    targetIdlePulse *= Math.exp(-dtSec * 4.8);
    smoothIdlePulse += (targetIdlePulse - smoothIdlePulse) * (1 - Math.exp(-dtSec * 16));

    audioState.beatPulse *= Math.exp(-dtSec * 7.5);
    if (audioState.beatPulse < 0.002) audioState.beatPulse = 0;

    fxBeatImpulse *= Math.exp(-dtSec * 8.5);
    if (fxBeatImpulse < 0.002) fxBeatImpulse = 0;

    transitionFlash *= Math.exp(-dtSec * 12);
    if (transitionFlash < 0.002) transitionFlash = 0;

    if (stageInvertPulse > 0) {
      const invTau = Math.max(0.04, (ledSyncDecayMs / 1000) * 0.45);
      stageInvertPulse *= Math.exp(-dtSec / invTau);
      if (stageInvertPulse < 0.01) stageInvertPulse = 0;
    }

    const desiredBaseScale = computeTargetBaseScale();
    smoothBaseScale += (desiredBaseScale - smoothBaseScale) * (1 - Math.exp(-dtSec * 10));

    // 2. Lớp #idle (Cinema Wander Catmull-Rom)
    const shouldIdle = Boolean(fx && (fx.idleOn || testIdleOn));
    const wantsIdleMotion = shouldIdle && (testIdleOn || !fx.idleOnlyMusic || musicPlaying);
    const targetIdleGate = wantsIdleMotion ? 1 : 0;

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

    // 3. Lớp #stage (Spring-Damper Beat FX + Bộ lọc Master FX & Invert)
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
    } else {
      let drawX = beatPhys.x;
      let drawY = beatPhys.y;
      let drawRot = beatPhys.rot;
      let drawScale = 1 + Math.max(-0.18, beatPhys.scale);

      if (beatPhys.motion === 'step') {
        const q = (val, unit) => (unit > 0 ? Math.round(val / unit) * unit : val);
        drawX = q(drawX, Math.max(1.5, (fx.shake || 8) * 0.22));
        drawY = q(drawY, Math.max(1.5, (fx.shake || 8) * 0.22));
        drawScale = 1 + q(beatPhys.scale, 0.015);
      }

      stageEl.style.transform =
        `translate3d(${drawX.toFixed(2)}px, ${drawY.toFixed(2)}px, 0) ` +
        `rotate(${drawRot.toFixed(3)}deg) scale(${drawScale.toFixed(4)})`;
    }

    // Hợp nhất CSS Filter trên #stage (Beat FX + Master FX + Momentary/Beat Invert)
    const filters = [];
    if (filterQuality >= 1 && Math.abs(beatPhys.bright) > 0.004) {
      filters.push(`brightness(${Math.max(0.5, 1 + beatPhys.bright).toFixed(3)})`);
    }
    const masterContrast = logic.clamp(currentMasterFx.contrast ?? 100, 10, 300);
    if (Math.abs(masterContrast - 100) > 0.5) {
      filters.push(`contrast(${masterContrast.toFixed(0)}%)`);
    }
    const masterSaturate = logic.clamp(currentMasterFx.saturate ?? 100, 0, 300);
    if (Math.abs(masterSaturate - 100) > 0.5) {
      filters.push(`saturate(${masterSaturate.toFixed(0)}%)`);
    }
    const totalHue = (filterQuality >= 2 ? beatPhys.hue : 0) + (Number(currentMasterFx.hue) || 0);
    if (Math.abs(totalHue) > 0.4) {
      filters.push(`hue-rotate(${totalHue.toFixed(1)}deg)`);
    }

    const baseInvert = (Boolean(currentMasterFx.invert) !== Boolean(momentaryInvertActive)) ? 1 : 0;
    const effInvert = stageInvertPulse > 0.04 ? Math.abs(baseInvert - stageInvertPulse) : baseInvert;
    if (effInvert > 0.02) {
      filters.push(`invert(${effInvert.toFixed(2)})`);
    }
    stageEl.style.filter = filters.length > 0 ? filters.join(' ') : 'none';

    const effFlash = Math.max(beatPhys.flash, transitionFlash);
    flashOverlay.style.opacity = effFlash > 0.004 ? logic.clamp(effFlash, 0, 0.95).toFixed(3) : '0';

    // 4. Vòng lặp mượt video kép, VJ Generators, Audio-React Layer, Master FX & LED Beat Engine
    stepActiveLoopingVideos();
    stepGenerators(dtSec);
    applyVjAudioReact();
    renderMasterFxCanvas(nowMs);
    if (ledBeatEngine) {
      ledBeatEngine.render(dtSec, nowMs);
    }
    stepTicker(dtSec);

    requestAnimationFrame(masterMotionLoop);
  }

  function triggerBeatFx(k, fxOverride) {
    const fx = fxOverride ? logic.createDefaultFx(fxOverride) : currentFx;
    if (!fx || !fx.on) return;

    const now = performance.now();
    const strength = logic.clamp(k ?? 0.8, 0.2, 1);

    targetIdlePulse = Math.min(1.0, targetIdlePulse + 0.7 * strength);
    lastBeatAngle = logic.pickNextBeatAngle(lastBeatAngle);
    rotSign = -rotSign;

    const elapsedSincePrev = lastBeatTimeMs > 0 ? (now - lastBeatTimeMs) : Infinity;
    lastBeatTimeMs = now;
    const effDecayMs = logic.calculateEffectiveDecay(fx.decay, elapsedSincePrev);
    const decaySec = Math.max(0.09, effDecayMs / 1000);

    const motion = fx.motion || (fx.step ? 'step' : 'smooth');
    beatPhys.motion = motion;

    if (motion === 'spring') {
      beatPhys.zeta = 0.52;
      beatPhys.omega = logic.clamp(5.4 / decaySec, 14, 52);
    } else {
      beatPhys.zeta = 1.04;
      beatPhys.omega = logic.clamp(4.4 / decaySec, 12, 46);
    }

    const velGain = beatPhys.omega * (motion === 'spring' ? 1.92 : Math.E);
    const peakX = Math.cos(lastBeatAngle) * fx.shake * strength;
    const peakY = Math.sin(lastBeatAngle) * fx.shake * strength;
    const peakRot = rotSign * fx.rot * strength;
    const peakScale = (fx.scale / 100) * strength;
    const peakBright = (fx.bright / 100) * strength;
    const peakHue = rotSign * fx.hue * strength;
    const peakFlash = (fx.flash / 100) * strength;

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

    const maxShake = Math.max(4, fx.shake * 1.18);
    beatPhys.x = logic.clamp(beatPhys.x, -maxShake, maxShake);
    beatPhys.y = logic.clamp(beatPhys.y, -maxShake, maxShake);
  }

  // =========================================================================
  // QUẢN LÝ MEDIA LAYER (IMAGE / VIDEO / CAMERA / GENERATOR) & CHUYỂN CẢNH
  // =========================================================================

  function disposeLayer(layer) {
    if (!layer) return;
    if (typeof layer._cleanup === 'function') {
      try { layer._cleanup(); } catch (_) {}
    }
    const videos = layer.querySelectorAll('video');
    videos.forEach((v) => {
      try {
        if (v._vaGain) {
          try { v._vaGain.disconnect(); } catch (_) {}
          v._vaGain = null;
        }
        if (v._vaSource) {
          try { v._vaSource.disconnect(); } catch (_) {}
          v._vaSource = null;
        }
        v.pause();
        if (v.srcObject && typeof v.srcObject.getTracks === 'function') {
          v.srcObject.getTracks().forEach((t) => {
            try { t.stop(); } catch (_) {}
          });
          v.srcObject = null;
        }
        v.removeAttribute('src');
        v.load();
      } catch (_) {}
    });
    if (layer.parentNode) {
      layer.parentNode.removeChild(layer);
    }
  }

  function cleanupOldLayers(keepLayer, containerEl) {
    const parent = containerEl || layerContainer;
    const children = Array.from(parent.children);
    for (const child of children) {
      if (child !== keepLayer && child !== tbarState.layer) {
        disposeLayer(child);
      }
    }
  }

  function preloadMedia(url, mediaKind) {
    if (!url || (mediaKind !== 'image' && mediaKind !== 'video') || preloadCache.has(url)) return;
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

  // =========================================================================
  // PHÂN TÍCH BEAT TRỰC TIẾP TỪ TIẾNG VIDEO ĐANG PHÁT (fx.src === 'video')
  // =========================================================================

  const videoAudioState = {
    ctx: null,
    bus: null,
    masterGain: null,
    silentGain: null,
    delayNode: null,
    specAnalyser: null,
    specBuf: null,
    hp1: null,
    hp2: null,
    lp1: null,
    lp2: null,
    timeAnalyser: null,
    timeBuf: null,
    detector: null,
    timer: null,
    lastCtxTime: 0,
    telemetryAcc: 0,
    sentIdleReset: true,
    sinkIdApplied: ''
  };

  function isVideoAudioAnalyzing() {
    return Boolean(currentFx && currentFx.src === 'video' && videoAudioState.timer);
  }

  function ensureVideoAudioContext() {
    if (videoAudioState.ctx) {
      if (videoAudioState.ctx.state === 'suspended') {
        videoAudioState.ctx.resume().catch(() => {});
      }
      return videoAudioState.ctx;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return null;
    const ctx = new AudioCtx();
    videoAudioState.ctx = ctx;

    const bus = ctx.createGain();
    const masterG = ctx.createGain();
    masterG.gain.value = logic.clamp(masterVol / 100, 0, 1);

    const delayNode = ctx.createDelay(0.3);
    delayNode.delayTime.value = logic.clamp(((currentFx && currentFx.delayMs) ?? 50) / 1000, 0, 0.2);

    const specAnalyser = ctx.createAnalyser();
    specAnalyser.fftSize = 2048;
    specAnalyser.smoothingTimeConstant = 0.3;

    const hp1 = ctx.createBiquadFilter();
    const hp2 = ctx.createBiquadFilter();
    const lp1 = ctx.createBiquadFilter();
    const lp2 = ctx.createBiquadFilter();
    const bassLow = logic.clamp((currentFx && currentFx.bassLow) ?? 35, 20, 80);
    let bassHigh = logic.clamp((currentFx && currentFx.bassHigh) ?? 150, 80, 250);
    if (bassHigh <= bassLow + 15) bassHigh = logic.clamp(bassLow + 30, 80, 250);

    [hp1, hp2].forEach((f) => { f.type = 'highpass'; f.Q.value = 0.707; f.frequency.value = bassLow; });
    [lp1, lp2].forEach((f) => { f.type = 'lowpass'; f.Q.value = 0.707; f.frequency.value = bassHigh; });

    const timeAnalyser = ctx.createAnalyser();
    timeAnalyser.fftSize = 2048;

    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    silentGain.connect(ctx.destination);

    bus.connect(masterG);
    masterG.connect(delayNode);
    delayNode.connect(specAnalyser);
    specAnalyser.connect(ctx.destination);

    // Nhánh phân tích bass lấy TRƯỚC masterG & DelayNode, nối vào silentGain -> destination để Chromium luôn kéo mẫu DSP
    bus.connect(hp1);
    hp1.connect(hp2);
    hp2.connect(lp1);
    lp1.connect(lp2);
    lp2.connect(timeAnalyser);
    timeAnalyser.connect(silentGain);

    videoAudioState.bus = bus;
    videoAudioState.masterGain = masterG;
    videoAudioState.silentGain = silentGain;
    videoAudioState.delayNode = delayNode;
    videoAudioState.specAnalyser = specAnalyser;
    videoAudioState.specBuf = new Uint8Array(specAnalyser.frequencyBinCount);
    videoAudioState.hp1 = hp1;
    videoAudioState.hp2 = hp2;
    videoAudioState.lp1 = lp1;
    videoAudioState.lp2 = lp2;
    videoAudioState.timeAnalyser = timeAnalyser;
    videoAudioState.timeBuf = new Float32Array(timeAnalyser.fftSize);
    videoAudioState.lastCtxTime = 0;
    videoAudioState.detector = logic.createOnsetDetector({
      sampleRate: ctx.sampleRate || 48000,
      blockSize: 128,
      sens: (currentFx && currentFx.sens) ?? 6,
      minIntervalMs: (currentFx && currentFx.minInterval) ?? 100,
      floor: 0.015
    });

    const targetSink = audioSinkId || '';
    if (typeof ctx.setSinkId === 'function' && targetSink) {
      videoAudioState.sinkIdApplied = targetSink;
      ctx.setSinkId(targetSink).catch(() => {
        videoAudioState.sinkIdApplied = '';
      });
    }
    return ctx;
  }

  function configureVideoAudioParams(fx) {
    if (!videoAudioState.ctx || !fx) return;
    const ctx = videoAudioState.ctx;
    const now = ctx.currentTime;
    const bassLow = logic.clamp(fx.bassLow ?? 35, 20, 80);
    let bassHigh = logic.clamp(fx.bassHigh ?? 150, 80, 250);
    if (bassHigh <= bassLow + 15) bassHigh = logic.clamp(bassLow + 30, 80, 250);
    const sens = logic.clamp(fx.sens ?? 6, 1, 10);
    const minInterval = logic.clamp(fx.minInterval ?? 100, 60, 300);
    const delayMs = logic.clamp(fx.delayMs ?? 50, 0, 200);

    if (videoAudioState.hp1 && videoAudioState.hp2) {
      videoAudioState.hp1.frequency.setTargetAtTime(bassLow, now, 0.015);
      videoAudioState.hp2.frequency.setTargetAtTime(bassLow, now, 0.015);
    }
    if (videoAudioState.lp1 && videoAudioState.lp2) {
      videoAudioState.lp1.frequency.setTargetAtTime(bassHigh, now, 0.015);
      videoAudioState.lp2.frequency.setTargetAtTime(bassHigh, now, 0.015);
    }
    if (videoAudioState.delayNode) {
      videoAudioState.delayNode.delayTime.setTargetAtTime(delayMs / 1000, now, 0.015);
    }
    if (videoAudioState.masterGain) {
      videoAudioState.masterGain.gain.setTargetAtTime(logic.clamp(masterVol / 100, 0, 1), now, 0.012);
    }
    if (videoAudioState.detector) {
      videoAudioState.detector.setParams({ sens, minIntervalMs: minInterval });
    }
    const targetSink = audioSinkId || '';
    if (typeof ctx.setSinkId === 'function' && targetSink !== videoAudioState.sinkIdApplied) {
      videoAudioState.sinkIdApplied = targetSink;
      ctx.setSinkId(targetSink).catch(() => {
        videoAudioState.sinkIdApplied = '';
        if (targetSink) ctx.setSinkId('').catch(() => {});
      });
    }
  }

  function attachVideoToAudioContext(v) {
    if (!v || v._vaSource) return;
    const ctx = ensureVideoAudioContext();
    if (!ctx || !videoAudioState.bus) return;
    try {
      const src = ctx.createMediaElementSource(v);
      const gain = ctx.createGain();
      const params = v._vaLastParams || { vsound: !v.muted, vvol: 100 };
      const cueVol = params.vsound ? logic.clamp((params.vvol ?? 100) / 100, 0, 1) : 0;
      gain.gain.setValueAtTime(cueVol, ctx.currentTime);
      src.connect(gain);
      gain.connect(videoAudioState.bus);
      v._vaSource = src;
      v._vaGain = gain;
      v.muted = false;
      v.volume = 1;
    } catch (_) {}
  }

  function sampleVideoSpectrumBars(freqBuf) {
    const bars = new Array(48);
    const usableBins = Math.floor(freqBuf.length * 0.55);
    for (let i = 0; i < 48; i++) {
      const startRatio = Math.pow(i / 48, 1.5);
      const endRatio = Math.pow((i + 1) / 48, 1.5);
      const b0 = Math.floor(startRatio * usableBins);
      const b1 = Math.max(b0 + 1, Math.floor(endRatio * usableBins));
      let maxVal = 0;
      for (let b = b0; b < b1 && b < freqBuf.length; b++) {
        if (freqBuf[b] > maxVal) maxVal = freqBuf[b];
      }
      bars[i] = maxVal / 255;
    }
    return bars;
  }

  function stepVideoAudioAnalysis() {
    if (!videoAudioState.ctx || !videoAudioState.timeAnalyser || !videoAudioState.detector) return;
    if (!currentFx || currentFx.src !== 'video') return;

    const ctx = videoAudioState.ctx;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const hasAudiblePlayingVideo = Boolean(
      activeLayer &&
      activeLayer._videos &&
      activeLayer._cueAudio &&
      activeLayer._cueAudio.vsound &&
      (activeLayer._cueAudio.vvol ?? 100) > 0 &&
      activeLayer._videos.some((v) => !v.paused && !v.ended)
    );

    if (!hasAudiblePlayingVideo) {
      videoAudioState.lastCtxTime = 0;
      if (!videoAudioState.sentIdleReset) {
        videoAudioState.sentIdleReset = true;
        rawBassEnv = 0;
        musicPlaying = false;
        audioState.bass = 0;
        audioState.mid = 0;
        audioState.high = 0;
        audioState.playing = false;
        window.api.notifyLedVideoTelemetry({
          o: 0,
          threshold: 0.015,
          env: 0,
          bass: 0,
          mid: 0,
          high: 0,
          spectrum: new Array(48).fill(0),
          playing: false
        });
      }
      return;
    }

    videoAudioState.sentIdleReset = false;
    const sr = ctx.sampleRate || 48000;
    const buf = videoAudioState.timeBuf;
    const bufLen = buf.length;
    const nowCtx = ctx.currentTime;
    let nBlocks = 0;
    if (videoAudioState.lastCtxTime <= 0 || nowCtx < videoAudioState.lastCtxTime || (nowCtx - videoAudioState.lastCtxTime) > 0.25) {
      nBlocks = 4;
      videoAudioState.lastCtxTime = nowCtx - (nBlocks * 128) / sr;
    } else {
      nBlocks = Math.min(
        Math.floor(bufLen / 128),
        Math.floor(((nowCtx - videoAudioState.lastCtxTime) * sr) / 128)
      );
    }

    let emittedBeat = null;
    if (nBlocks > 0) {
      videoAudioState.timeAnalyser.getFloatTimeDomainData(buf);
      const startSample = bufLen - nBlocks * 128;
      for (let i = 0; i < nBlocks; i++) {
        const off = startSample + i * 128;
        const slice = buf.subarray(off, off + 128);
        const blockTime = videoAudioState.lastCtxTime + ((i + 1) * 128) / sr;
        const beat = videoAudioState.detector.processBlock(slice, blockTime);
        if (beat) emittedBeat = beat;
      }
      videoAudioState.lastCtxTime += (nBlocks * 128) / sr;
    }

    if (emittedBeat) {
      fxBeatImpulse = Math.max(fxBeatImpulse, logic.clamp(emittedBeat.k ?? 0.85, 0.25, 1));
      audioState.beatPulse = Math.max(audioState.beatPulse, logic.clamp(emittedBeat.k ?? 0.85, 0.25, 1));
      if (currentFx && currentFx.on) {
        triggerBeatFx(emittedBeat.k, currentFx);
      }
      window.api.notifyLedVideoBeat({
        k: emittedBeat.k,
        o: emittedBeat.o,
        threshold: emittedBeat.threshold,
        env: emittedBeat.env
      });
    }

    videoAudioState.telemetryAcc++;
    if (videoAudioState.telemetryAcc >= 2) {
      videoAudioState.telemetryAcc = 0;
      const m = videoAudioState.detector.getLastMetrics();
      rawBassEnv = logic.clamp(m.env ?? 0, 0, 1);
      musicPlaying = true;

      let bands = { bass: 0, mid: 0, high: 0 };
      let spectrum = new Array(48).fill(0);
      if (videoAudioState.specAnalyser && videoAudioState.specBuf) {
        videoAudioState.specAnalyser.getByteFrequencyData(videoAudioState.specBuf);
        if (typeof logic.computeThreeBandEnergy === 'function') {
          bands = logic.computeThreeBandEnergy(
            videoAudioState.specBuf,
            ctx.sampleRate || 48000,
            videoAudioState.specAnalyser.fftSize || 2048
          );
        }
        spectrum = sampleVideoSpectrumBars(videoAudioState.specBuf);
      }

      audioState.bass = logic.clamp(bands.bass ?? 0, 0, 1);
      audioState.mid = logic.clamp(bands.mid ?? 0, 0, 1);
      audioState.high = logic.clamp(bands.high ?? 0, 0, 1);
      audioState.spectrum = spectrum;
      audioState.playing = true;
      if (ledBeatEngine) {
        ledBeatEngine.updateAudioBands({
          bass: audioState.bass,
          mid: audioState.mid,
          high: audioState.high,
          spectrum,
          playing: true
        });
      }

      window.api.notifyLedVideoTelemetry({
        o: m.o,
        threshold: m.threshold,
        env: m.env,
        bass: audioState.bass,
        mid: audioState.mid,
        high: audioState.high,
        spectrum,
        playing: true
      });
    }
  }

  function syncVideoAudioAnalyzer(resetDet) {
    const wantsVideoAnalysis = Boolean(
      currentFx &&
      currentFx.src === 'video' &&
      activeLayer &&
      activeLayer._videos &&
      activeLayer._videos.length > 0
    );

    if (wantsVideoAnalysis) {
      ensureVideoAudioContext();
      configureVideoAudioParams(currentFx);
      activeLayer._videos.forEach((v) => attachVideoToAudioContext(v));
      if (resetDet && videoAudioState.detector) {
        videoAudioState.detector.reset();
        videoAudioState.lastCtxTime = 0;
        videoAudioState.sentIdleReset = true;
      }
      if (!videoAudioState.timer) {
        videoAudioState.timer = setInterval(stepVideoAudioAnalysis, 16);
      }
    } else {
      if (videoAudioState.timer) {
        clearInterval(videoAudioState.timer);
        videoAudioState.timer = null;
      }
      videoAudioState.lastCtxTime = 0;
      if (videoAudioState.detector) {
        videoAudioState.detector.reset();
      }
      if (!videoAudioState.sentIdleReset) {
        videoAudioState.sentIdleReset = true;
        window.api.notifyLedVideoTelemetry({
          o: 0,
          threshold: 0.015,
          env: 0,
          bass: 0,
          mid: 0,
          high: 0,
          spectrum: new Array(48).fill(0),
          playing: false
        });
      }
    }
  }

  function applyAudioToVideo(v, vsound, vvol) {
    if (!v) return;
    v._vaLastParams = { vsound: Boolean(vsound), vvol: vvol ?? 100 };
    if (v._vaGain && videoAudioState.ctx) {
      const ctx = videoAudioState.ctx;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      const now = ctx.currentTime;
      const cueVol = vsound ? logic.clamp((vvol ?? 100) / 100, 0, 1) : 0;
      v._vaGain.gain.cancelScheduledValues(now);
      v._vaGain.gain.setTargetAtTime(cueVol, now, 0.012);
      v.muted = false;
      v.volume = 1;
      if (videoAudioState.masterGain) {
        videoAudioState.masterGain.gain.cancelScheduledValues(now);
        videoAudioState.masterGain.gain.setTargetAtTime(
          logic.clamp(masterVol / 100, 0, 1),
          now,
          0.012
        );
      }
      const targetSink = audioSinkId || '';
      if (typeof ctx.setSinkId === 'function' && targetSink !== videoAudioState.sinkIdApplied) {
        videoAudioState.sinkIdApplied = targetSink;
        ctx.setSinkId(targetSink).catch(() => {
          videoAudioState.sinkIdApplied = '';
          if (targetSink) ctx.setSinkId('').catch(() => {});
        });
      }
      return;
    }
    const effVol = logic.clamp(((vvol ?? 100) / 100) * (masterVol / 100), 0, 1);
    v.volume = effVol;
    v.muted = !vsound || effVol <= 0.001;
    const targetSink = audioSinkId || '';
    if (typeof v.setSinkId === 'function' && targetSink !== (v.sinkId || '')) {
      v.setSinkId(targetSink).catch(() => {
        if (targetSink) v.setSinkId('').catch(() => {});
      });
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
    if (videoAudioState.ctx) {
      configureVideoAudioParams(currentFx);
    }
    if (!activeLayer || !activeLayer._videos) return;
    if (opts && opts.vsound !== undefined) {
      activeLayer._cueAudio.vsound = Boolean(opts.vsound);
    }
    if (opts && opts.vvol !== undefined) {
      activeLayer._cueAudio.vvol = logic.clamp(opts.vvol, 0, 100);
    }
    const activeVid = activeLayer._activeVideo || activeLayer._videos[0];
    activeLayer._videos.forEach((v) => {
      const shouldSound = v === activeVid ? activeLayer._cueAudio.vsound : false;
      applyAudioToVideo(v, shouldSound, activeLayer._cueAudio.vvol);
    });
  }

  function fadeOutActiveVideoAudio(durationSec) {
    clearInterval(videoFadeTimer);
    if (!activeLayer || !activeLayer._videos) return;
    const vids = activeLayer._videos;
    const durMs = Math.max(80, (Number(durationSec) || 2) * 1000);
    const startVols = vids.map((v) => {
      if (v._vaGain) return v._vaGain.gain.value;
      return v.muted ? 0 : v.volume;
    });
    const startedAt = performance.now();
    videoFadeTimer = setInterval(() => {
      const t = Math.min(1, (performance.now() - startedAt) / durMs);
      vids.forEach((v, idx) => {
        const nextVal = Math.max(0, startVols[idx] * (1 - t));
        if (v._vaGain && videoAudioState.ctx) {
          v._vaGain.gain.setValueAtTime(nextVal, videoAudioState.ctx.currentTime);
        } else {
          v.volume = nextVal;
          if (t >= 1) v.muted = true;
        }
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

  function createMediaLayer(cue, url, mediaKind, token, opts) {
    const options = opts || {};
    const layer = document.createElement('div');
    layer.className = 'media-layer';
    layer.style.zIndex = String(options.zIndex || ++layerZ);

    const fitClass = cue.fit === 'cover' ? 'fit-cover' : 'fit-contain';
    let destroyed = false;

    // 1. Nguồn Generator Canvas
    if (mediaKind === 'generator') {
      const canvas = document.createElement('canvas');
      canvas.className = 'generator-canvas';
      layer.appendChild(canvas);

      const genEntry = {
        canvas,
        ctx: canvas.getContext('2d'),
        type: cue.generator || 'laser-beams',
        color: cue.color || '#00d2ff',
        speed: cue.speed ?? 1,
        timeSec: 0,
        isOverlay: Boolean(options.isOverlay),
        layerEl: layer,
        vjIndex: options.vjIndex,
        destroyed: false
      };
      activeGenerators.add(genEntry);

      layer._generatorEntry = genEntry;
      layer._cleanup = () => {
        destroyed = true;
        genEntry.destroyed = true;
        activeGenerators.delete(genEntry);
      };
      return { layer, readyPromise: Promise.resolve() };
    }

    // 2. Nguồn Camera / Capture Device (getUserMedia)
    if (mediaKind === 'camera') {
      const v = document.createElement('video');
      v.className = fitClass;
      v.autoplay = true;
      v.muted = true;
      v.playsInline = true;
      layer.appendChild(v);

      let camStream = null;
      const stopStream = (stream) => {
        if (!stream || typeof stream.getTracks !== 'function') return;
        stream.getTracks().forEach((t) => {
          try { t.stop(); } catch (_) {}
        });
      };

      layer._cleanup = () => {
        destroyed = true;
        stopStream(camStream);
        camStream = null;
        try { v.srcObject = null; } catch (_) {}
      };

      const cameraId = typeof cue.cameraId === 'string' ? cue.cameraId.trim() : '';
      const constraints = {
        video: cameraId ? { deviceId: { exact: cameraId } } : true,
        audio: false
      };

      const readyPromise = new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };

        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
          if (!options.isTbar) {
            window.api.notifyLedMediaError({
              cueId: cue.id,
              path: cameraId,
              message: 'Thiết bị không hỗ trợ truy cập Camera trực tiếp.'
            });
          }
          finish();
          return;
        }

        const timeoutId = setTimeout(finish, 1200);
        navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
          clearTimeout(timeoutId);
          if (destroyed || (options.isShow && token !== showToken)) {
            stopStream(stream);
            finish();
            return;
          }
          camStream = stream;
          v.srcObject = stream;
          v.play().catch(() => {});
          finish();
        }).catch(() => {
          clearTimeout(timeoutId);
          if (!destroyed && !options.isTbar) {
            window.api.notifyLedMediaError({
              cueId: cue.id,
              path: cameraId,
              message: 'Không mở được Camera đã chọn — hãy kiểm tra kết nối thiết bị.'
            });
          }
          finish();
        });
      });

      return { layer, readyPromise };
    }

    // 3. Nguồn Ảnh tĩnh
    if (mediaKind === 'image') {
      const img = document.createElement('img');
      img.className = fitClass;
      img.alt = '';
      img.onerror = () => {
        if (!destroyed && !options.isTbar) {
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

    // 4. Nguồn Blank đen (dùng khi T-Bar kéo tới cue không có hình)
    if (mediaKind === 'blank') {
      layer.style.background = '#000000';
      layer._cleanup = () => { destroyed = true; };
      return { layer, readyPromise: Promise.resolve() };
    }

    // 5. Nguồn Video (Dual-Video Crossfade Loop chạy chung trong masterMotionLoop)
    const mutedAll = Boolean(options.muted);
    const cueAudio = {
      vsound: mutedAll ? false : (cue.vsound !== undefined ? Boolean(cue.vsound) : true),
      vvol: logic.clamp(cue.vvol ?? 100, 0, 100)
    };
    const vA = createVideoElement(url, fitClass, mutedAll || !cueAudio.vsound);
    const shouldLoop = cue.loop !== false;
    const vB = shouldLoop ? createVideoElement(url, fitClass, true) : null;

    if (!mutedAll) {
      applyAudioToVideo(vA, cueAudio.vsound, cueAudio.vvol);
      if (vB) applyAudioToVideo(vB, false, cueAudio.vvol);
    }

    const playbackSpeed = logic.clamp(Number(options.speed ?? cue.speed ?? 1) || 1, 0.1, 8);
    vA.playbackRate = playbackSpeed;
    if (vB) vB.playbackRate = playbackSpeed;

    layer._videos = vB ? [vA, vB] : [vA];
    layer._activeVideo = vA;
    layer._cueAudio = cueAudio;
    layer._clipSpeed = Number(cue.speed ?? 1) || 1;

    vA.style.opacity = '1';
    layer.appendChild(vA);

    if (vB) {
      vB.style.opacity = '0';
      vB.style.transition = 'opacity 0.4s linear';
      vA.style.transition = 'opacity 0.4s linear';
      layer.appendChild(vB);
    }

    const loopEntry = {
      layer,
      front: vA,
      back: vB,
      loop: shouldLoop,
      muted: mutedAll,
      cueAudio,
      crossfading: false,
      nativeFallback: false,
      destroyed: false
    };

    const onVideoError = () => {
      if (!destroyed && !options.isTbar) {
        window.api.notifyLedMediaError({
          cueId: cue.id,
          path: cue.vis,
          message: 'File này không phát được, hãy chuyển sang MP4 H.264'
        });
      }
    };
    vA.addEventListener('error', onVideoError);
    if (vB) vB.addEventListener('error', onVideoError);

    let codecCheckTimer = null;
    const readyPromise = new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (!destroyed && (!options.isShow || token === showToken)) {
          vA.play().catch(() => {
            if (!destroyed && vA.paused) {
              vA.addEventListener('canplay', () => {
                if (!destroyed && (!options.isShow || token === showToken) && vA.paused) {
                  vA.play().catch(() => {});
                }
              }, { once: true });
            }
          });
          if (shouldLoop) activeLoopingVideos.add(loopEntry);
        }
        resolve();
      };
      vA.addEventListener('canplay', done, { once: true });
      vA.addEventListener('error', done, { once: true });
      setTimeout(done, 180);
    });

    if (!options.isTbar) {
      codecCheckTimer = setTimeout(() => {
        if (destroyed) return;
        if (!vA.paused && vA.currentTime > 0.3 && vA.videoWidth === 0 && vA.videoHeight === 0) {
          window.api.notifyLedMediaError({
            cueId: cue.id,
            path: cue.vis,
            message: 'Video này dùng codec chưa hỗ trợ (ví dụ .MOV ProRes/HEVC) — hãy chuyển sang MP4 H.264 + AAC.'
          });
        }
      }, 1400);
    }

    layer._cleanup = () => {
      destroyed = true;
      clearTimeout(codecCheckTimer);
      loopEntry.destroyed = true;
      activeLoopingVideos.delete(loopEntry);
    };

    return { layer, readyPromise };
  }

  function fadeOutLayerVideos(layer, durMs) {
    if (!layer || !layer._videos || layer._videos.length === 0) return;
    const vids = layer._videos;
    if (durMs <= 30) {
      vids.forEach((v) => {
        if (v._vaGain && videoAudioState.ctx) {
          v._vaGain.gain.setValueAtTime(0, videoAudioState.ctx.currentTime);
        } else {
          v.muted = true;
        }
      });
      return;
    }
    const startVols = vids.map((v) => {
      if (v._vaGain) return v._vaGain.gain.value;
      return v.muted ? 0 : v.volume;
    });
    const startMs = performance.now();
    const timer = setInterval(() => {
      const p = Math.min(1, (performance.now() - startMs) / durMs);
      vids.forEach((v, idx) => {
        try {
          const nextVal = Math.max(0, startVols[idx] * (1 - p));
          if (v._vaGain && videoAudioState.ctx) {
            v._vaGain.gain.setValueAtTime(nextVal, videoAudioState.ctx.currentTime);
          } else {
            v.volume = nextVal;
            if (p >= 1) v.muted = true;
          }
        } catch (_) {}
      });
      if (p >= 1) clearInterval(timer);
    }, 30);
  }

  function runTransition(prevLayer, nextLayer, tr, durSec, token) {
    const durMs = Math.max(0, (Number(durSec) || 0) * 1000);

    if (!prevLayer || tr === 'cut' || durMs <= 20) {
      nextLayer.style.opacity = '1';
      nextLayer.style.clipPath = '';
      nextLayer.style.filter = '';
      nextLayer.style.transform = '';
      cleanupOldLayers(nextLayer, layerContainer);
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
          cleanupOldLayers(nextLayer, layerContainer);
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
            cleanupOldLayers(nextLayer, layerContainer);
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
        if (token === showToken) {
          nextLayer.style.transform = '';
          cleanupOldLayers(nextLayer, layerContainer);
        }
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
          nextLayer.style.transform = '';
          cleanupOldLayers(nextLayer, layerContainer);
        }
      });
      return;
    }

    // 6 hiệu ứng chuyển cảnh mới (v3.0 Pro)
    if (tr === 'wipe-left' || tr === 'wipe-right' || tr === 'wipe-up') {
      const startClip =
        tr === 'wipe-left'
          ? 'inset(0 0 0 100%)'
          : (tr === 'wipe-right' ? 'inset(0 100% 0 0)' : 'inset(100% 0 0 0)');
      prevLayer.style.opacity = '1';
      nextLayer.style.opacity = '1';
      const inAnim = nextLayer.animate(
        [{ clipPath: startClip }, { clipPath: 'inset(0 0 0 0)' }],
        { duration: durMs, easing: 'cubic-bezier(0.25, 1, 0.5, 1)', fill: 'forwards' }
      );
      inAnim.finished.then(() => {
        if (token === showToken) {
          nextLayer.style.clipPath = '';
          cleanupOldLayers(nextLayer, layerContainer);
        }
      }).catch(() => {});
      return;
    }

    if (tr === 'circle-iris') {
      prevLayer.style.opacity = '1';
      nextLayer.style.opacity = '1';
      const inAnim = nextLayer.animate(
        [{ clipPath: 'circle(0% at 50% 50%)' }, { clipPath: 'circle(85% at 50% 50%)' }],
        { duration: durMs, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' }
      );
      inAnim.finished.then(() => {
        if (token === showToken) {
          nextLayer.style.clipPath = '';
          cleanupOldLayers(nextLayer, layerContainer);
        }
      }).catch(() => {});
      return;
    }

    if (tr === 'blur-dissolve') {
      nextLayer.style.opacity = '0';
      prevLayer.style.opacity = '1';
      const outAnim = prevLayer.animate(
        [
          { opacity: 1, filter: 'blur(0px)', transform: 'scale(1)' },
          { opacity: 0, filter: 'blur(22px)', transform: 'scale(1.04)' }
        ],
        { duration: durMs, easing: 'ease-in-out', fill: 'forwards' }
      );
      const inAnim = nextLayer.animate(
        [
          { opacity: 0, filter: 'blur(22px)', transform: 'scale(1.04)' },
          { opacity: 1, filter: 'blur(0px)', transform: 'scale(1)' }
        ],
        { duration: durMs, easing: 'ease-in-out', fill: 'forwards' }
      );
      Promise.allSettled([outAnim.finished, inAnim.finished]).then(() => {
        if (token === showToken) {
          nextLayer.style.opacity = '1';
          nextLayer.style.filter = '';
          nextLayer.style.transform = '';
          cleanupOldLayers(nextLayer, layerContainer);
        }
      });
      return;
    }

    if (tr === 'flash-cut') {
      transitionFlash = 0.96;
      const cutDelay = Math.min(110, Math.max(30, durMs * 0.25));
      nextLayer.style.opacity = '0';
      setTimeout(() => {
        if (token !== showToken) return;
        nextLayer.style.opacity = '1';
        cleanupOldLayers(nextLayer, layerContainer);
      }, cutDelay);
      return;
    }

    nextLayer.style.opacity = '1';
    cleanupOldLayers(nextLayer, layerContainer);
  }

  function resolveCueMediaKind(cue, cmdKind) {
    if (cue && cue.sourceType === 'camera') return 'camera';
    if (cue && cue.sourceType === 'generator') return 'generator';
    if (cmdKind === 'camera' || cmdKind === 'generator' || cmdKind === 'image' || cmdKind === 'video') {
      return cmdKind;
    }
    return cue && cue.vis && logic.detectMediaKind(cue.vis) === 'image' ? 'image' : 'video';
  }

  async function handleShowCommand(cmd) {
    const token = ++showToken;
    const cue = cmd.cue || {};
    clearInterval(videoFadeTimer);
    clearTbarPreview();

    if (cmd.masterVol !== undefined) masterVol = logic.clamp(cmd.masterVol, 0, 100);
    if (cmd.sinkId !== undefined) audioSinkId = cmd.sinkId || '';

    currentFx = logic.createDefaultFx(cue.fx);
    applyTextOverlay(cue.text);

    const effKind = resolveCueMediaKind(cue, cmd.mediaKind);
    const hasVisualSource = effKind === 'camera' || effKind === 'generator' || Boolean(cmd.url);

    if (!hasVisualSource) {
      if (!cue.keepAudio && activeLayer && activeLayer._videos) {
        fadeOutActiveVideoAudio(cue.fadeOut ?? 0.8);
      }
      syncVideoAudioAnalyzer(false);
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
      latest.style.transform = '';
      latest.style.clipPath = '';
      latest.style.filter = '';
      activeLayer = latest;
    }

    const prevLayer = activeLayer;
    const { layer: nextLayer, readyPromise } = createMediaLayer(cue, cmd.url, effKind, token, {
      isShow: true,
      isOverlay: false,
      vjIndex: 0
    });
    nextLayer.style.opacity = cue.tr === 'cut' ? '1' : '0';
    layerContainer.appendChild(nextLayer);

    await readyPromise;
    if (token !== showToken) {
      disposeLayer(nextLayer);
      return;
    }

    activeLayer = nextLayer;
    vjLayers[0].mediaLayer = nextLayer;
    syncVideoAudioAnalyzer(true);
    runTransition(prevLayer, nextLayer, cue.tr || 'fade', cue.dur ?? 0.8, token);
  }

  // =========================================================================
  // T-BAR LIVE PREVIEW MIXER (VMIX STYLE)
  // =========================================================================

  function restoreActiveLayerStyle() {
    if (!activeLayer) return;
    activeLayer.style.opacity = '1';
    activeLayer.style.transform = '';
    activeLayer.style.clipPath = '';
    activeLayer.style.filter = '';
  }

  function clearTbarPreview() {
    tbarState.token++;
    if (tbarState.layer) {
      disposeLayer(tbarState.layer);
      tbarState.layer = null;
    }
    tbarState.cueKey = '';
    restoreActiveLayerStyle();
  }

  function applyTbarProgress(layer, p, tr) {
    if (!layer) return;
    restoreActiveLayerStyle();

    layer.style.opacity = '1';
    layer.style.transform = '';
    layer.style.clipPath = '';
    layer.style.filter = '';

    switch (tr) {
      case 'cut':
        layer.style.opacity = p >= 0.5 ? '1' : '0';
        break;
      case 'black':
        if (p < 0.5) {
          if (activeLayer) activeLayer.style.opacity = String(logic.clamp(1 - p * 2, 0, 1));
          layer.style.opacity = '0';
        } else {
          if (activeLayer) activeLayer.style.opacity = '0';
          layer.style.opacity = String(logic.clamp((p - 0.5) * 2, 0, 1));
        }
        break;
      case 'slide-left':
        layer.style.transform = `translate3d(${((1 - p) * 100).toFixed(2)}%, 0, 0)`;
        if (activeLayer) activeLayer.style.transform = `translate3d(${(-p * 100).toFixed(2)}%, 0, 0)`;
        break;
      case 'slide-right':
        layer.style.transform = `translate3d(${(-(1 - p) * 100).toFixed(2)}%, 0, 0)`;
        if (activeLayer) activeLayer.style.transform = `translate3d(${(p * 100).toFixed(2)}%, 0, 0)`;
        break;
      case 'zoom':
        layer.style.opacity = p.toFixed(3);
        layer.style.transform = `scale(${(1.12 - 0.12 * p).toFixed(4)})`;
        if (activeLayer) {
          activeLayer.style.opacity = (1 - p).toFixed(3);
          activeLayer.style.transform = `scale(${(1 - 0.08 * p).toFixed(4)})`;
        }
        break;
      case 'wipe-left':
        layer.style.clipPath = `inset(0 0 0 ${((1 - p) * 100).toFixed(2)}%)`;
        break;
      case 'wipe-right':
        layer.style.clipPath = `inset(0 ${((1 - p) * 100).toFixed(2)}% 0 0)`;
        break;
      case 'wipe-up':
        layer.style.clipPath = `inset(${((1 - p) * 100).toFixed(2)}% 0 0 0)`;
        break;
      case 'circle-iris':
        layer.style.clipPath = `circle(${(p * 85).toFixed(2)}% at 50% 50%)`;
        break;
      case 'blur-dissolve':
        layer.style.opacity = p.toFixed(3);
        layer.style.filter = `blur(${((1 - p) * 22).toFixed(1)}px)`;
        if (activeLayer) {
          activeLayer.style.opacity = (1 - p).toFixed(3);
          activeLayer.style.filter = `blur(${(p * 22).toFixed(1)}px)`;
        }
        break;
      case 'flash-cut': {
        const distMid = Math.abs(p - 0.5);
        if (distMid < 0.12) {
          transitionFlash = Math.max(transitionFlash, (1 - distMid / 0.12) * 0.9);
        }
        layer.style.opacity = p >= 0.5 ? '1' : '0';
        break;
      }
      case 'fade':
      default:
        layer.style.opacity = p.toFixed(3);
        break;
    }
  }

  function handleTbarCommand(cmd) {
    const rawP = Number(cmd.progress) || 0;
    const p = logic.clamp(rawP > 1 ? rawP / 100 : rawP, 0, 1);

    if (p <= 0.001) {
      clearTbarPreview();
      return;
    }

    const cue = cmd.previewCue || {};
    const effKind = (cue.sourceType === 'camera' || cmd.previewKind === 'camera')
      ? 'camera'
      : ((cue.sourceType === 'generator' || cmd.previewKind === 'generator')
        ? 'generator'
        : (cmd.previewUrl
          ? (cmd.previewKind || (logic.detectMediaKind(cue.vis || '') === 'image' ? 'image' : 'video'))
          : 'blank'));

    const cueKey = JSON.stringify({
      id: cue.id || '',
      url: cmd.previewUrl || '',
      kind: effKind,
      gen: cue.generator || '',
      cam: cue.cameraId || '',
      fit: cue.fit || 'contain'
    });

    const tr = cmd.tr || cue.tr || 'fade';

    if (!tbarState.layer || tbarState.cueKey !== cueKey) {
      clearTbarPreview();
      tbarState.cueKey = cueKey;
      const myToken = ++tbarState.token;
      const { layer, readyPromise } = createMediaLayer(cue, cmd.previewUrl, effKind, showToken, {
        isTbar: true,
        muted: true,
        zIndex: 999999
      });
      tbarState.layer = layer;
      layerContainer.appendChild(layer);
      applyTbarProgress(layer, p, tr);

      readyPromise.then(() => {
        if (myToken !== tbarState.token && layer.parentNode) {
          disposeLayer(layer);
        }
      });
    } else {
      applyTbarProgress(tbarState.layer, p, tr);
    }
  }

  // =========================================================================
  // QUẢN LÝ 3 TẦNG VJ DECK (RESOLUME STYLE)
  // =========================================================================

  function applyVjLayerMixAndVisibility() {
    const anySolo = vjLayers.some((l) => l.params.solo);
    for (let i = 0; i < vjLayers.length; i++) {
      const l = vjLayers[i];
      l.visible = !l.params.bypass && (!anySolo || l.params.solo);
      l.container.style.display = l.visible ? '' : 'none';
      l.container.style.mixBlendMode = sanitizeBlendMode(l.params.blend, i === 0 ? 'normal' : 'plus-lighter');

      if (!l.params.audioReact) {
        l.container.style.opacity = String(logic.clamp(l.params.opacity, 0, 100) / 100);
        l.container.style.transform = '';
      }

      // Cập nhật tốc độ phát video / generator theo layer speed
      const layerSpd = logic.clamp(Number(l.params.speed) || 1, 0.1, 8);
      const vids = l.container.querySelectorAll('video');
      vids.forEach((v) => {
        if (!v.srcObject) {
          const parentClipSpeed = (v.parentNode && v.parentNode._clipSpeed) || 1;
          try {
            v.playbackRate = logic.clamp(layerSpd * parentClipSpeed, 0.1, 8);
          } catch (_) {}
        }
      });
    }
  }

  function ejectVjLayer(layerIdx, resetParams) {
    const l = vjLayers[layerIdx];
    if (!l) return;
    l.token++;
    l.clip = null;
    if (layerIdx === 0) {
      showToken++;
      activeLayer = null;
      syncVideoAudioAnalyzer(true);
      cleanupOldLayers(null, layerContainer);
    } else {
      if (l.mediaLayer) {
        disposeLayer(l.mediaLayer);
        l.mediaLayer = null;
      }
      cleanupOldLayers(null, l.container);
    }
    if (resetParams) {
      l.params.bypass = false;
      l.params.solo = false;
      l.params.opacity = 100;
      l.params.blend = layerIdx === 0 ? 'normal' : 'plus-lighter';
    }
    applyVjLayerMixAndVisibility();
  }

  async function handleVjLayerCommand(cmd) {
    const idx = Math.max(0, Math.min(2, Number(cmd.layerIndex) || 0));
    const l = vjLayers[idx];
    if (!l) return;

    if (cmd.params && typeof cmd.params === 'object') {
      if (cmd.params.opacity !== undefined) l.params.opacity = logic.clamp(cmd.params.opacity, 0, 100);
      if (cmd.params.blend !== undefined) l.params.blend = sanitizeBlendMode(cmd.params.blend, l.params.blend);
      if (cmd.params.speed !== undefined) l.params.speed = logic.clamp(cmd.params.speed, 0.1, 4);
      if (cmd.params.bypass !== undefined) l.params.bypass = Boolean(cmd.params.bypass);
      if (cmd.params.solo !== undefined) l.params.solo = Boolean(cmd.params.solo);
      if (cmd.params.audioReact !== undefined) l.params.audioReact = Boolean(cmd.params.audioReact);
    }

    if (cmd.action === 'eject') {
      ejectVjLayer(idx, false);
      return;
    }

    if (cmd.action === 'trigger') {
      const clip = cmd.clip;
      if (!clip || clip.kind === 'empty') {
        ejectVjLayer(idx, false);
        return;
      }

      l.clip = clip;
      const myToken = ++l.token;
      const kind = clip.kind;
      const url = cmd.url || (clip.path ? window.api.toFileUrl(clip.path) : '');

      if ((kind === 'image' || kind === 'video') && !url) {
        ejectVjLayer(idx, false);
        return;
      }

      const wantSound = kind === 'video' && clip.vsound !== false;
      const synthCue = {
        id: clip.id || `vj-${idx}`,
        fit: 'cover',
        loop: clip.loop !== false,
        vsound: wantSound,
        vvol: 100,
        cameraId: clip.cameraId || '',
        generator: clip.generator || 'laser-beams',
        color: clip.color || '#00d2ff',
        speed: clip.speed ?? 1
      };

      const { layer: nextLayer, readyPromise } = createMediaLayer(synthCue, url, kind, showToken, {
        isVj: true,
        isOverlay: idx > 0,
        muted: !wantSound,
        speed: (l.params.speed || 1) * (clip.speed || 1),
        vjIndex: idx
      });

      if (idx === 0) {
        clearTbarPreview();
        const sToken = ++showToken;
        nextLayer.style.opacity = '0';
        layerContainer.appendChild(nextLayer);
        await readyPromise;
        if (myToken !== l.token || sToken !== showToken) {
          disposeLayer(nextLayer);
          return;
        }
        const prev = activeLayer;
        activeLayer = nextLayer;
        l.mediaLayer = nextLayer;
        runTransition(prev, nextLayer, 'fade', 0.18, sToken);
      } else {
        nextLayer.style.opacity = '0';
        l.container.appendChild(nextLayer);
        await readyPromise;
        if (myToken !== l.token) {
          disposeLayer(nextLayer);
          return;
        }
        const prev = l.mediaLayer;
        l.mediaLayer = nextLayer;
        const inAnim = nextLayer.animate(
          [{ opacity: 0 }, { opacity: 1 }],
          { duration: 180, easing: 'ease-out', fill: 'forwards' }
        );
        inAnim.finished.then(() => {
          if (myToken === l.token) {
            nextLayer.style.opacity = '1';
            if (prev && prev !== nextLayer) disposeLayer(prev);
            cleanupOldLayers(nextLayer, l.container);
          }
        }).catch(() => {});
      }
    }

    applyVjLayerMixAndVisibility();
  }

  // =========================================================================
  // VMIX OVERLAYS (OV1 LOWER THIRD, OV2 LOGO, OV3 TIMER, OV4 MARQUEE TICKER)
  // =========================================================================

  function renderOv1LowerThird(ov1) {
    if (!ov1 || !ov1.active || (!ov1.title && !ov1.subtitle)) {
      ovLowerThirdEl.classList.add('hidden');
      return;
    }

    const theme = ['modern', 'neon', 'corporate', 'breaking'].includes(ov1.theme) ? ov1.theme : 'modern';
    const validPos = ['bottom-left', 'bottom-center', 'bottom-right', 'top-left', 'top-center', 'top-right'];
    const pos = validPos.includes(ov1.pos) ? ov1.pos : 'bottom-left';
    const accent = typeof ov1.accentColor === 'string' && ov1.accentColor ? ov1.accentColor : '#00d2ff';

    const sig = `${theme}|${pos}|${accent}|${ov1.title || ''}|${ov1.subtitle || ''}`;
    if (sig !== lastOv1Sig) {
      lastOv1Sig = sig;
      ovLowerThirdEl.style.setProperty('--ov-accent', accent);
      ovLowerThirdEl.className = `ov-layer theme-${theme} pos-${pos}`;

      let card = ovLowerThirdEl.firstElementChild;
      if (!card) {
        card = document.createElement('div');
        card.className = 'lt-card';
        const bar = document.createElement('div');
        bar.className = 'lt-accent';
        const body = document.createElement('div');
        body.className = 'lt-body';
        const titleEl = document.createElement('div');
        titleEl.className = 'lt-title';
        const subEl = document.createElement('div');
        subEl.className = 'lt-sub';
        body.appendChild(titleEl);
        body.appendChild(subEl);
        card.appendChild(bar);
        card.appendChild(body);
        ovLowerThirdEl.appendChild(card);
      }
      card.querySelector('.lt-title').textContent = ov1.title || '';
      card.querySelector('.lt-sub').textContent = ov1.subtitle || '';
    } else {
      ovLowerThirdEl.className = `ov-layer theme-${theme} pos-${pos}`;
    }

    ovLowerThirdEl.classList.remove('hidden');
  }

  function renderOv2Logo(ov2, projectFilePath) {
    const rawPath = ov2 && (ov2.url || ov2.path);
    if (!ov2 || !ov2.active || !rawPath) {
      ovLogoEl.classList.add('hidden');
      return;
    }

    const resolvedUrl = ov2.url || window.api.toFileUrl(ov2.path, projectFilePath);
    if (!resolvedUrl) {
      ovLogoEl.classList.add('hidden');
      return;
    }

    const pos = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(ov2.pos) ? ov2.pos : 'top-right';
    const margin = logic.clamp(ov2.margin ?? 28, 0, 200);
    const scaleVw = logic.clamp(ov2.scale ?? 14, 3, 60);
    const opacity = logic.clamp(ov2.opacity ?? 90, 0, 100) / 100;

    ovLogoEl.style.top = pos.startsWith('top') ? `${margin}px` : 'auto';
    ovLogoEl.style.bottom = pos.startsWith('bottom') ? `${margin}px` : 'auto';
    ovLogoEl.style.left = pos.endsWith('left') ? `${margin}px` : 'auto';
    ovLogoEl.style.right = pos.endsWith('right') ? `${margin}px` : 'auto';
    ovLogoEl.style.width = `${scaleVw}vw`;
    ovLogoEl.style.opacity = '';

    let img = ovLogoEl.querySelector('img.ov-logo-img');
    if (!img) {
      img = document.createElement('img');
      img.className = 'ov-logo-img';
      img.alt = '';
      ovLogoEl.appendChild(img);
    }
    if (lastOv2Url !== resolvedUrl) {
      lastOv2Url = resolvedUrl;
      img.src = resolvedUrl;
    }
    img.style.opacity = String(opacity);
    ovLogoEl.classList.remove('hidden');
  }

  function renderOv3Timer(ov3, timerDisplay) {
    if (!ov3 || !ov3.active) {
      ovTimerEl.classList.add('hidden');
      return;
    }

    const validPos = ['top-left', 'top-right', 'top-center', 'bottom-left', 'bottom-right', 'bottom-center', 'center'];
    const pos = validPos.includes(ov3.pos) ? ov3.pos : 'top-left';
    const size = logic.clamp(ov3.size ?? 46, 18, 160);
    const color = typeof ov3.color === 'string' && ov3.color ? ov3.color : '#ffffff';

    let textVal = '00:00';
    let labelVal = ov3.label || '';
    let isUrgent = false;

    if (typeof timerDisplay === 'string' && timerDisplay) {
      textVal = timerDisplay;
    } else if (timerDisplay && typeof timerDisplay === 'object') {
      textVal = timerDisplay.text || logic.formatTime(ov3.durationSec ?? 0);
      if (timerDisplay.label !== undefined) labelVal = timerDisplay.label;
      isUrgent = Boolean(timerDisplay.urgent);
    } else {
      textVal = logic.formatTime(ov3.durationSec ?? 0);
    }

    const sig = `${pos}|${size}|${color}|${labelVal}|${textVal}|${isUrgent}`;
    if (sig !== lastOv3TimerSig) {
      lastOv3TimerSig = sig;
      ovTimerEl.className = `ov-layer pos-${pos}${isUrgent ? ' urgent' : ''}`;
      ovTimerEl.style.fontSize = `${size}px`;

      let box = ovTimerEl.firstElementChild;
      if (!box) {
        box = document.createElement('div');
        box.className = 'ov-timer-box';
        const lbl = document.createElement('div');
        lbl.className = 'ov-timer-label';
        const val = document.createElement('div');
        val.className = 'ov-timer-value';
        box.appendChild(lbl);
        box.appendChild(val);
        ovTimerEl.appendChild(box);
      }
      box.querySelector('.ov-timer-label').textContent = labelVal;
      const valEl = box.querySelector('.ov-timer-value');
      valEl.textContent = textVal;
      valEl.style.color = color;
    }
    ovTimerEl.classList.remove('hidden');
  }

  function renderOv4Ticker(ov4) {
    if (!ov4 || !ov4.active || !String(ov4.text || '').trim()) {
      tickerAnim.active = false;
      ovTickerEl.classList.add('hidden');
      return;
    }

    const pos = ov4.pos === 'top' ? 'top' : 'bottom';
    const speed = logic.clamp(ov4.speed ?? 85, 20, 400);
    const size = logic.clamp(ov4.size ?? 28, 14, 96);
    const color = typeof ov4.color === 'string' && ov4.color ? ov4.color : '#ffffff';
    const bgRgb = safeHexToRgb(ov4.bgColor || '#08101c');
    const bgAlpha = logic.clamp(ov4.bgOpacity ?? 82, 0, 100) / 100;
    const text = String(ov4.text).trim();

    tickerAnim.speed = speed;
    tickerAnim.active = true;

    const sig = `${pos}|${size}|${color}|${bgRgb.r},${bgRgb.g},${bgRgb.b}|${bgAlpha}|${text}`;
    if (sig !== tickerAnim.signature) {
      tickerAnim.signature = sig;
      ovTickerEl.className = `ov-layer pos-${pos}`;

      ovTickerEl.innerHTML = '';
      const bar = document.createElement('div');
      bar.className = 'ov-ticker-bar';
      bar.style.fontSize = `${size}px`;
      bar.style.color = color;
      bar.style.background = `rgba(${bgRgb.r}, ${bgRgb.g}, ${bgRgb.b}, ${bgAlpha.toFixed(2)})`;

      const track = document.createElement('div');
      track.className = 'ov-ticker-track';

      // Tạo đủ bản sao để không bao giờ bị hở khoảng trống trên màn siêu rộng
      const itemA = document.createElement('span');
      itemA.className = 'ov-ticker-item';
      itemA.textContent = `${text}   •   `;
      track.appendChild(itemA);

      bar.appendChild(track);
      ovTickerEl.appendChild(bar);

      const singleW = Math.max(120, itemA.getBoundingClientRect().width || itemA.offsetWidth || 400);
      const minCopies = Math.max(3, Math.ceil((window.innerWidth * 2) / singleW) + 1);
      for (let i = 1; i < minCopies; i++) {
        const clone = itemA.cloneNode(true);
        track.appendChild(clone);
      }

      tickerAnim.trackEl = track;
      tickerAnim.cycleW = singleW;
      tickerAnim.x = 0;
    }

    ovTickerEl.classList.remove('hidden');
  }

  function applyOverlays(cmd) {
    const overlays = cmd.overlays || {};
    renderOv1LowerThird(overlays.ov1);
    renderOv2Logo(overlays.ov2, cmd.projectFilePath);
    renderOv3Timer(overlays.ov3, cmd.timerDisplay);
    renderOv4Ticker(overlays.ov4);
  }

  // =========================================================================
  // MASTER FX & OUTPUT MAPPING (CROP + KEYSTONE)
  // =========================================================================

  function applyMasterFxConfig(fx) {
    if (!fx || typeof fx !== 'object') return;
    currentMasterFx = {
      dimmer: logic.clamp(fx.dimmer ?? 100, 0, 100),
      contrast: logic.clamp(fx.contrast ?? 100, 10, 300),
      saturate: logic.clamp(fx.saturate ?? 100, 0, 300),
      hue: logic.clamp(fx.hue ?? 0, -180, 360),
      rgbSplit: logic.clamp(fx.rgbSplit ?? 0, 0, 100),
      rgbBeatLink: Boolean(fx.rgbBeatLink),
      mirror: typeof fx.mirror === 'string' ? fx.mirror : 'none',
      glitch: logic.clamp(fx.glitch ?? 0, 0, 100),
      glitchBeatLink: Boolean(fx.glitchBeatLink),
      vignette: logic.clamp(fx.vignette ?? 0, 0, 100),
      invert: Boolean(fx.invert),
      pixelate: logic.clamp(fx.pixelate ?? 0, 0, 100)
    };

    // Dimmer tổng
    const dimOpacity = 1 - currentMasterFx.dimmer / 100;
    masterDimmerEl.style.opacity = dimOpacity > 0.005 ? dimOpacity.toFixed(3) : '0';

    // Vignette tối viền điện ảnh
    const vig = currentMasterFx.vignette;
    if (vig > 0.5) {
      const innerStop = Math.round(70 - (vig / 100) * 42);
      const outerAlpha = logic.clamp((vig / 100) * 0.96, 0, 0.96);
      masterVignetteEl.style.background =
        `radial-gradient(ellipse at center, rgba(0,0,0,0) ${innerStop}%, rgba(0,0,0,${outerAlpha.toFixed(3)}) 100%)`;
      masterVignetteEl.style.opacity = '1';
    } else {
      masterVignetteEl.style.opacity = '0';
    }
  }

  function applyOutputMapping(m) {
    if (!outputMappingRoot || !m || typeof m !== 'object') return;

    let cropTop = logic.clamp(m.cropTop ?? 0, 0, 48);
    let cropBottom = logic.clamp(m.cropBottom ?? 0, 0, 48);
    let cropLeft = logic.clamp(m.cropLeft ?? 0, 0, 48);
    let cropRight = logic.clamp(m.cropRight ?? 0, 0, 48);

    if (cropTop + cropBottom > 95) cropBottom = Math.max(0, 95 - cropTop);
    if (cropLeft + cropRight > 95) cropRight = Math.max(0, 95 - cropLeft);

    if (cropTop === 0 && cropBottom === 0 && cropLeft === 0 && cropRight === 0) {
      outputMappingRoot.style.clipPath = '';
    } else {
      outputMappingRoot.style.clipPath = `inset(${cropTop}% ${cropRight}% ${cropBottom}% ${cropLeft}%)`;
    }

    const ox = logic.clamp(m.offsetX ?? 0, -1920, 1920);
    const oy = logic.clamp(m.offsetY ?? 0, -1080, 1080);
    const sx = (logic.clamp(m.scaleX ?? 100, 10, 300) / 100) * (m.flipH ? -1 : 1);
    const sy = (logic.clamp(m.scaleY ?? 100, 10, 300) / 100) * (m.flipV ? -1 : 1);
    const rx = logic.clamp(m.rotateX ?? 0, -60, 60);
    const ry = logic.clamp(m.rotateY ?? 0, -60, 60);
    const persp = logic.clamp(m.perspective ?? 1200, 200, 5000);

    const isIdentity =
      ox === 0 && oy === 0 && sx === 1 && sy === 1 && rx === 0 && ry === 0;
    if (isIdentity) {
      outputMappingRoot.style.transform = 'none';
    } else {
      outputMappingRoot.style.transform =
        `perspective(${persp.toFixed(0)}px) translate3d(${ox.toFixed(1)}px, ${oy.toFixed(1)}px, 0) ` +
        `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
    }
  }

  // =========================================================================
  // TEXT OVERLAY & MÀN THỬ LED SMPTE
  // =========================================================================

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
    if (tickerAnim.active) {
      tickerAnim.signature = '';
    }
  });

  // =========================================================================
  // XỬ LÝ LỆNH IPC TỪ CỬA SỔ ĐIỀU KHIỂN
  // =========================================================================

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
        syncVideoAudioAnalyzer(false);
        break;
      case 'video-audio':
        updateActiveLayerVideoAudio(cmd);
        break;
      case 'fade-video-audio':
        fadeOutActiveVideoAudio(cmd.durationSec ?? 2.0);
        break;
      case 'level':
        if (!isVideoAudioAnalyzing()) {
          rawBassEnv = logic.clamp(cmd.env ?? 0, 0, 1);
          musicPlaying = Boolean(cmd.playing);
        }
        break;
      case 'test-idle':
        testIdleOn = Boolean(cmd.on);
        if (cmd.fx) currentFx = logic.createDefaultFx(cmd.fx);
        break;
      case 'beat':
        fxBeatImpulse = Math.max(fxBeatImpulse, logic.clamp(cmd.k ?? 0.85, 0.25, 1));
        audioState.beatPulse = Math.max(audioState.beatPulse, logic.clamp(cmd.k ?? 0.85, 0.25, 1));
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
        syncVideoAudioAnalyzer(true);
        clearTbarPreview();
        ejectVjLayer(0, true);
        ejectVjLayer(1, true);
        ejectVjLayer(2, true);
        if (ledBeatEngine) ledBeatEngine.resetMomentaries();
        momentaryInvertActive = false;
        stageInvertPulse = 0;
        transitionFlash = 0;
        beatPhys.flash = 0;
        textOverlay.classList.add('hidden');
        blackoutOverlay.classList.remove('active');
        musicPlaying = false;
        rawBassEnv = 0;
        fxBeatImpulse = 0;
        audioState.bass = 0;
        audioState.mid = 0;
        audioState.high = 0;
        audioState.beatPulse = 0;
        audioState.playing = false;
        break;
      case 'test-pattern':
        if (cmd.on) {
          drawTestPattern();
          testPatternEl.classList.remove('hidden');
        } else {
          testPatternEl.classList.add('hidden');
        }
        break;

      // Lệnh v3.0 Pro
      case 'tbar':
        handleTbarCommand(cmd);
        break;
      case 'vj-layer':
        handleVjLayerCommand(cmd);
        break;
      case 'led-sync':
        if (cmd.config && typeof cmd.config === 'object') {
          ledSyncMode = cmd.config.on === false ? 'off' : (cmd.config.mode || 'off');
          ledSyncDecayMs = logic.clamp(cmd.config.decayMs ?? 180, 40, 1200);
          if (ledBeatEngine) ledBeatEngine.setConfig(cmd.config);
        }
        break;
      case 'led-beat-hit':
        audioState.beatIndex = Number.isFinite(cmd.beatIndex) ? cmd.beatIndex : (audioState.beatIndex + 1);
        audioState.beatPulse = Math.max(audioState.beatPulse, logic.clamp(cmd.k ?? 0.85, 0.25, 1));
        fxBeatImpulse = Math.max(fxBeatImpulse, logic.clamp(cmd.k ?? 0.85, 0.25, 1));
        if (ledSyncMode === 'invert-hit') {
          stageInvertPulse = logic.clamp(cmd.k ?? 0.9, 0.4, 1);
        }
        if (ledBeatEngine) ledBeatEngine.triggerBeatHit(cmd);
        break;
      case 'led-momentary':
        if (cmd.action === 'invert') {
          momentaryInvertActive = Boolean(cmd.active);
        }
        if (ledBeatEngine) {
          ledBeatEngine.setMomentary(cmd.action, cmd.active, cmd.color);
        }
        break;
      case 'audio-bands':
        if (!isVideoAudioAnalyzing() || cmd.playing) {
          audioState.bass = logic.clamp(cmd.bass ?? 0, 0, 1);
          audioState.mid = logic.clamp(cmd.mid ?? 0, 0, 1);
          audioState.high = logic.clamp(cmd.high ?? 0, 0, 1);
          audioState.spectrum = Array.isArray(cmd.spectrum) ? cmd.spectrum : null;
          audioState.playing = Boolean(cmd.playing);
          if (ledBeatEngine) ledBeatEngine.updateAudioBands(cmd);
        }
        if (Number.isFinite(cmd.bpm)) audioState.bpm = cmd.bpm;
        if (Number.isFinite(cmd.beatPhase)) audioState.beatPhase = cmd.beatPhase;
        break;
      case 'overlays':
        applyOverlays(cmd);
        break;
      case 'master-fx':
        applyMasterFxConfig(cmd.masterFx);
        break;
      case 'output-mapping':
        applyOutputMapping(cmd.mapping);
        break;
      default:
        break;
    }
  });

  window.addEventListener('DOMContentLoaded', () => {
    lastFrameMs = performance.now();
    applyVjLayerMixAndVisibility();
    requestAnimationFrame(masterMotionLoop);
    window.api.notifyLedReady();
  });
})();
