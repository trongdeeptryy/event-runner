/**
 * Bộ sinh đồ họa VJ thời gian thực 60–144 FPS cho EVENT RUNNER v3.0 Pro
 * Hỗ trợ 6 bộ sinh chuẩn sân khấu:
 *   - spectrum-bars : Cột phổ 48 dải neon phát sáng + bóng phản chiếu + đỉnh rơi
 *   - laser-beams   : Tia laser sân khấu quét theo nhịp & bùng nổ khi có beat
 *   - strobe-matrix : Ma trận ô đèn LED 12×6 chớp đuổi theo pha beat
 *   - pulse-rings   : Vòng sóng xung kích đồng tâm nở theo Bass / Mid / High
 *   - cyber-grid    : Lưới không gian 3D synthwave cuộn theo tốc độ + zoom beat
 *   - plasma-wave   : Sóng plasma hữu cơ đa tầng uốn lượn theo 3 dải âm thanh
 *
 * Tối ưu zero-GC: mọi bộ đệm trạng thái & bảng màu được tái sử dụng qua WeakMap.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.EventRunnerVjGenerators = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const GENERATOR_NAMES = [
    'spectrum-bars',
    'laser-beams',
    'strobe-matrix',
    'pulse-rings',
    'cyber-grid',
    'plasma-wave'
  ];

  const colorCache = new Map();
  const ctxStateMap = new WeakMap();
  const MAX_RINGS = 14;

  function clamp01(v) {
    return v < 0 ? 0 : (v > 1 ? 1 : v);
  }

  function parseColor(hex) {
    const key = typeof hex === 'string' && hex ? hex : '#00d2ff';
    let cached = colorCache.get(key);
    if (cached) return cached;

    let r = 0;
    let g = 210;
    let b = 255;
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

    // Màu phụ tương phản hài hòa (xoay kênh sang tím/hồng/vàng neon)
    const r2 = Math.min(255, Math.round(b * 0.85 + 60));
    const g2 = Math.min(255, Math.round(r * 0.45 + 20));
    const b2 = Math.min(255, Math.round(g * 0.75 + 90));

    cached = {
      r, g, b,
      r2, g2, b2,
      rgbPrefix: `rgba(${r},${g},${b},`,
      rgb2Prefix: `rgba(${r2},${g2},${b2},`
    };
    if (colorCache.size > 48) colorCache.clear();
    colorCache.set(key, cached);
    return cached;
  }

  function getCtxState(ctx) {
    let st = ctxStateMap.get(ctx);
    if (st) return st;

    const ringRadius = new Float32Array(MAX_RINGS);
    const ringAlpha = new Float32Array(MAX_RINGS);
    const ringWidth = new Float32Array(MAX_RINGS);
    const ringTone = new Uint8Array(MAX_RINGS);

    // Khởi tạo vài vòng ban đầu
    for (let i = 0; i < 4; i++) {
      ringRadius[i] = i * 0.25;
      ringAlpha[i] = 0.65 * (1 - ringRadius[i]);
      ringWidth[i] = 4;
      ringTone[i] = i % 2;
    }

    st = {
      peaks: new Float32Array(48),
      smoothBars: new Float32Array(48),
      ringRadius,
      ringAlpha,
      ringWidth,
      ringTone,
      ringNextIdx: 4,
      ringCooldown: 0,
      lastBeatIdx: -1
    };
    ctxStateMap.set(ctx, st);
    return st;
  }

  function sampleSpectrumVal(spectrum, i, timeSec, bass, mid, high) {
    if (spectrum && spectrum.length > 0) {
      const idx = Math.min(spectrum.length - 1, Math.floor((i * spectrum.length) / 48));
      const v = Number(spectrum[idx]);
      if (Number.isFinite(v) && v > 0.002) {
        return clamp01(v);
      }
    }
    // Chuyển động chờ nhẹ nhàng khi nhạc chưa có tín hiệu
    const band = i < 12 ? bass : (i < 30 ? mid : high);
    const idleWave = 0.08 + 0.06 * Math.sin(timeSec * 2.4 + i * 0.28) + 0.04 * Math.cos(timeSec * 1.3 - i * 0.17);
    return clamp01(idleWave + band * (0.45 + 0.45 * Math.sin(i * 0.35 + timeSec * 4)));
  }

  function clearStageBackground(ctx, w, h, isOverlay, col, glowAlpha) {
    if (isOverlay) {
      ctx.clearRect(0, 0, w, h);
      return;
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#03050b';
    ctx.fillRect(0, 0, w, h);

    if (glowAlpha > 0.01) {
      const grad = ctx.createRadialGradient(w * 0.5, h * 0.52, 0, w * 0.5, h * 0.52, Math.max(w, h) * 0.62);
      grad.addColorStop(0, `${col.rgbPrefix}${(glowAlpha * 0.32).toFixed(3)})`);
      grad.addColorStop(0.55, `${col.rgb2Prefix}${(glowAlpha * 0.12).toFixed(3)})`);
      grad.addColorStop(1, 'rgba(3,5,11,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }
  }

  // ===========================================================================
  // 1. SPECTRUM BARS (48 CỘT NEON + PHẢN CHIẾU + ĐỈNH RƠI)
  // ===========================================================================

  function renderSpectrumBars(ctx, w, h, st, state, col) {
    const { timeSec, dtSec, bass, mid, high, spectrum, beatPulse, isOverlay } = state;
    clearStageBackground(ctx, w, h, isOverlay, col, 0.25 + bass * 0.55 + beatPulse * 0.45);

    const count = 48;
    const marginX = w * 0.06;
    const usableW = w - marginX * 2;
    const stepW = usableW / count;
    const barW = Math.max(2, stepW * 0.68);
    const gapOffset = (stepW - barW) * 0.5;
    const horizonY = h * 0.64;
    const maxBarH = h * 0.5;
    const decay = Math.min(1, dtSec * 14);
    const peakFall = dtSec * 0.42;

    // Đường chân trời phát sáng
    ctx.save();
    ctx.fillStyle = `${col.rgbPrefix}${(0.22 + beatPulse * 0.35).toFixed(3)})`;
    ctx.fillRect(marginX * 0.5, horizonY - 1, w - marginX, 2);

    const barGrad = ctx.createLinearGradient(0, horizonY - maxBarH, 0, horizonY);
    barGrad.addColorStop(0, '#ffffff');
    barGrad.addColorStop(0.22, `${col.rgb2Prefix}0.95)`);
    barGrad.addColorStop(0.65, `${col.rgbPrefix}0.9)`);
    barGrad.addColorStop(1, `${col.rgbPrefix}0.35)`);

    const reflGrad = ctx.createLinearGradient(0, horizonY, 0, horizonY + maxBarH * 0.36);
    reflGrad.addColorStop(0, `${col.rgbPrefix}0.42)`);
    reflGrad.addColorStop(1, `${col.rgbPrefix}0)`);

    ctx.globalCompositeOperation = 'lighter';

    for (let i = 0; i < count; i++) {
      // Sắp xếp đối xứng đẹp mắt hoặc 48 dải mượt
      const symIdx = i < 24 ? (23 - i) * 2 : (i - 24) * 2;
      const target = sampleSpectrumVal(spectrum, symIdx, timeSec, bass, mid, high);
      const boost = i >= 16 && i <= 31 ? (1 + bass * 0.35 + beatPulse * 0.25) : (1 + mid * 0.2);
      const vTarget = clamp01(target * boost);

      st.smoothBars[i] += (vTarget - st.smoothBars[i]) * decay;
      const val = st.smoothBars[i];

      if (val > st.peaks[i]) {
        st.peaks[i] = val;
      } else {
        st.peaks[i] = Math.max(val, st.peaks[i] - peakFall);
      }

      const x = marginX + i * stepW + gapOffset;
      const barH = Math.max(4, val * maxBarH);
      const peakY = horizonY - st.peaks[i] * maxBarH - 5;

      // Hào quang phía sau cột cao
      if (val > 0.35) {
        ctx.fillStyle = `${col.rgbPrefix}${(val * 0.16).toFixed(3)})`;
        ctx.fillRect(x - 2, horizonY - barH - 4, barW + 4, barH + 4);
      }

      // Cột chính
      ctx.fillStyle = barGrad;
      ctx.fillRect(x, horizonY - barH, barW, barH);

      // Bóng phản chiếu dưới mặt sàn
      const reflH = barH * 0.34;
      ctx.fillStyle = reflGrad;
      ctx.fillRect(x, horizonY + 2, barW, reflH);

      // Đỉnh rơi (Peak cap)
      ctx.fillStyle = `rgba(255,255,255,${(0.65 + val * 0.35).toFixed(3)})`;
      ctx.fillRect(x, peakY, barW, Math.max(2, h * 0.005));
    }

    ctx.restore();
  }

  // ===========================================================================
  // 2. LASER BEAMS (CHÙM TIA LASER QUÉT SÂN KHẤU)
  // ===========================================================================

  function renderLaserBeams(ctx, w, h, _st, state, col) {
    const { timeSec, bass, mid, high, beatPulse, beatPhase, isOverlay } = state;
    clearStageBackground(ctx, w, h, isOverlay, col, 0.18 + beatPulse * 0.55);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const emitters = 6;
    const beamLen = Math.hypot(w, h) * 1.15;
    const energy = clamp01(0.35 + bass * 0.35 + mid * 0.35 + beatPulse * 0.65);

    for (let e = 0; e < emitters; e++) {
      const originX = w * ((e + 0.5) / emitters);
      const originY = -h * 0.02;
      const sideSign = e < emitters / 2 ? 1 : -1;
      const baseSweep = Math.sin(timeSec * (1.2 + (e % 3) * 0.35) + e * 1.1) * 0.48;
      const phaseAngle = Math.cos(beatPhase * Math.PI * 2 + e * 0.8) * (0.14 + high * 0.18) * sideSign;
      const centerAngle = Math.PI * 0.5 + baseSweep + phaseAngle;

      const subRays = beatPulse > 0.28 ? 3 : 2;
      const spread = 0.08 + beatPulse * 0.16 + mid * 0.08;

      for (let r = 0; r < subRays; r++) {
        const offset = subRays === 1 ? 0 : (r / (subRays - 1) - 0.5) * spread * 2;
        const ang = centerAngle + offset;
        const ex = originX + Math.cos(ang) * beamLen;
        const ey = originY + Math.sin(ang) * beamLen;

        const useAlt = (e + r) % 2 === 1;
        const prefix = useAlt ? col.rgb2Prefix : col.rgbPrefix;

        // Vùng nón ánh sáng rộng
        const coneWidth = 0.035 + energy * 0.04;
        ctx.beginPath();
        ctx.moveTo(originX, originY);
        ctx.lineTo(originX + Math.cos(ang - coneWidth) * beamLen, originY + Math.sin(ang - coneWidth) * beamLen);
        ctx.lineTo(originX + Math.cos(ang + coneWidth) * beamLen, originY + Math.sin(ang + coneWidth) * beamLen);
        ctx.closePath();
        const coneGrad = ctx.createLinearGradient(originX, originY, ex, ey);
        coneGrad.addColorStop(0, `${prefix}${(0.26 * energy).toFixed(3)})`);
        coneGrad.addColorStop(0.65, `${prefix}${(0.06 * energy).toFixed(3)})`);
        coneGrad.addColorStop(1, `${prefix}0)`);
        ctx.fillStyle = coneGrad;
        ctx.fill();

        // Hào quang tia
        ctx.beginPath();
        ctx.moveTo(originX, originY);
        ctx.lineTo(ex, ey);
        ctx.strokeStyle = `${prefix}${(0.48 * energy).toFixed(3)})`;
        ctx.lineWidth = Math.max(4, w * 0.008 * (0.7 + beatPulse * 0.9));
        ctx.stroke();

        // Lõi trắng sắc nét
        ctx.beginPath();
        ctx.moveTo(originX, originY);
        ctx.lineTo(ex, ey);
        ctx.strokeStyle = `rgba(255,255,255,${(0.55 + beatPulse * 0.45).toFixed(3)})`;
        ctx.lineWidth = Math.max(1.5, w * 0.0018);
        ctx.stroke();
      }

      // Đèn emitter trên giàn truss
      const flareR = Math.max(12, w * 0.024) * (0.8 + beatPulse * 0.6);
      const flareGrad = ctx.createRadialGradient(originX, h * 0.015, 0, originX, h * 0.015, flareR);
      flareGrad.addColorStop(0, 'rgba(255,255,255,0.95)');
      flareGrad.addColorStop(0.3, `${col.rgbPrefix}0.65)`);
      flareGrad.addColorStop(1, `${col.rgbPrefix}0)`);
      ctx.fillStyle = flareGrad;
      ctx.beginPath();
      ctx.arc(originX, h * 0.015, flareR, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  // ===========================================================================
  // 3. STROBE MATRIX (MA TRẬN Ô LED 12×6 CHỚP ĐUỔI)
  // ===========================================================================

  function renderStrobeMatrix(ctx, w, h, _st, state, col) {
    const { timeSec, bass, mid, high, beatPhase, beatIndex, beatPulse, isOverlay } = state;
    clearStageBackground(ctx, w, h, isOverlay, col, 0.1 + beatPulse * 0.35);

    const cols = 12;
    const rows = 6;
    const padX = w * 0.04;
    const padY = h * 0.06;
    const cellW = (w - padX * 2) / cols;
    const cellH = (h - padY * 2) / rows;
    const gap = Math.max(4, Math.min(cellW, cellH) * 0.12);
    const innerW = cellW - gap;
    const innerH = cellH - gap;

    const pattern = Math.abs(beatIndex) % 4;
    const sweepPos = beatPhase * (cols + rows);
    const centerX = (cols - 1) * 0.5;
    const centerY = (rows - 1) * 0.5;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = padX + c * cellW + gap * 0.5;
        const y = padY + r * cellH + gap * 0.5;

        let energy = 0;
        if (pattern === 0) {
          // Chéo quét
          const d = Math.abs((c + r) - sweepPos);
          energy = Math.max(0, 1 - d * 0.42);
        } else if (pattern === 1) {
          // Bàn cờ đảo pha
          const isAlt = (c + r + beatIndex) % 2 === 0;
          energy = isAlt ? (0.35 + beatPulse * 0.65) : (mid * 0.35);
        } else if (pattern === 2) {
          // Tỏa từ tâm
          const dist = Math.hypot(c - centerX, r - centerY);
          const ring = Math.abs(dist - beatPhase * 7.5);
          energy = Math.max(0, 1 - ring * 0.52);
        } else {
          // Sóng cột ngang
          const colPhase = Math.sin(timeSec * 5 + c * 0.55) * 0.5 + 0.5;
          energy = colPhase * (0.35 + bass * 0.65);
        }

        energy = clamp01(energy * (0.45 + bass * 0.45 + beatPulse * 0.65) + high * 0.12);
        const useAlt = (c + r) % 3 === 0;
        const prefix = useAlt ? col.rgb2Prefix : col.rgbPrefix;

        if (!isOverlay) {
          ctx.fillStyle = 'rgba(255,255,255,0.035)';
          ctx.fillRect(x, y, innerW, innerH);
        }

        if (energy > 0.04) {
          ctx.fillStyle = `${prefix}${(energy * 0.78).toFixed(3)})`;
          ctx.fillRect(x, y, innerW, innerH);

          // Tâm sáng khi chớp mạnh
          if (energy > 0.55) {
            const coreAlpha = (energy - 0.55) / 0.45;
            const inset = Math.min(innerW, innerH) * 0.22;
            ctx.fillStyle = `rgba(255,255,255,${(coreAlpha * 0.72).toFixed(3)})`;
            ctx.fillRect(x + inset, y + inset, innerW - inset * 2, innerH - inset * 2);
          }
        }
      }
    }

    ctx.restore();
  }

  // ===========================================================================
  // 4. PULSE RINGS (VÒNG SÓNG ĐỒNG TÂM NỞ THEO BASS / MID / HIGH)
  // ===========================================================================

  function spawnRing(st, width, tone) {
    const idx = st.ringNextIdx;
    st.ringNextIdx = (st.ringNextIdx + 1) % MAX_RINGS;
    st.ringRadius[idx] = 0.02;
    st.ringAlpha[idx] = 1.0;
    st.ringWidth[idx] = width;
    st.ringTone[idx] = tone;
  }

  function renderPulseRings(ctx, w, h, st, state, col) {
    const { dtSec, bass, mid, high, beatPulse, beatIndex, isOverlay } = state;
    clearStageBackground(ctx, w, h, isOverlay, col, 0.2 + bass * 0.5 + beatPulse * 0.45);

    st.ringCooldown = Math.max(0, st.ringCooldown - dtSec);
    if (beatIndex !== st.lastBeatIdx) {
      st.lastBeatIdx = beatIndex;
      spawnRing(st, 6 + bass * 10, Math.abs(beatIndex) % 2);
      st.ringCooldown = 0.14;
    } else if ((beatPulse > 0.65 || bass > 0.72) && st.ringCooldown <= 0) {
      spawnRing(st, 4 + bass * 8, 0);
      st.ringCooldown = 0.18;
    }

    const cx = w * 0.5;
    const cy = h * 0.5;
    const maxR = Math.hypot(w, h) * 0.56;
    const expandSpeed = 0.46 + mid * 0.35 + beatPulse * 0.22;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // Lõi năng lượng trung tâm
    const coreR = Math.min(w, h) * (0.07 + bass * 0.08 + beatPulse * 0.06);
    const coreGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 2.2);
    coreGrad.addColorStop(0, `rgba(255,255,255,${(0.5 + beatPulse * 0.45).toFixed(3)})`);
    coreGrad.addColorStop(0.35, `${col.rgbPrefix}${(0.55 + bass * 0.35).toFixed(3)})`);
    coreGrad.addColorStop(1, `${col.rgbPrefix}0)`);
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 2.2, 0, Math.PI * 2);
    ctx.fill();

    // Cập nhật và vẽ từng vòng sóng
    for (let i = 0; i < MAX_RINGS; i++) {
      if (st.ringAlpha[i] <= 0.01) continue;
      st.ringRadius[i] += dtSec * expandSpeed;
      st.ringAlpha[i] = Math.max(0, 1 - st.ringRadius[i]);
      if (st.ringAlpha[i] <= 0.01) continue;

      const rPx = st.ringRadius[i] * maxR;
      const alpha = st.ringAlpha[i];
      const prefix = st.ringTone[i] === 1 ? col.rgb2Prefix : col.rgbPrefix;

      // Vòng hào quang ngoài
      ctx.beginPath();
      ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
      ctx.strokeStyle = `${prefix}${(alpha * 0.65).toFixed(3)})`;
      ctx.lineWidth = st.ringWidth[i] * (1.2 + high * 1.4);
      ctx.stroke();

      // Vòng lõi mảnh sáng
      ctx.beginPath();
      ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${(alpha * 0.55).toFixed(3)})`;
      ctx.lineWidth = Math.max(1.5, st.ringWidth[i] * 0.32);
      ctx.stroke();
    }

    ctx.restore();
  }

  // ===========================================================================
  // 5. CYBER GRID (LƯỚI KHÔNG GIAN 3D SYNTHWAVE + MẶT TRỜI + ZOOM BEAT)
  // ===========================================================================

  function renderCyberGrid(ctx, w, h, _st, state, col) {
    const { timeSec, bass, mid, high, spectrum, beatPulse, isOverlay } = state;

    if (isOverlay) {
      ctx.clearRect(0, 0, w, h);
    } else {
      const skyGrad = ctx.createLinearGradient(0, 0, 0, h);
      skyGrad.addColorStop(0, '#040312');
      skyGrad.addColorStop(0.5, '#120726');
      skyGrad.addColorStop(0.52, '#050814');
      skyGrad.addColorStop(1, '#020308');
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, w, h);
    }

    const horizonY = h * (0.48 - beatPulse * 0.015);
    const cx = w * 0.5;
    const sunR = Math.min(w, h) * (0.16 + bass * 0.025 + beatPulse * 0.02);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // Mặt trời Synthwave cắt lát ngang ở chân trời
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, horizonY);
    ctx.clip();

    const sunGrad = ctx.createLinearGradient(cx, horizonY - sunR * 1.6, cx, horizonY);
    sunGrad.addColorStop(0, '#fff7cc');
    sunGrad.addColorStop(0.4, `${col.rgb2Prefix}0.85)`);
    sunGrad.addColorStop(1, `${col.rgbPrefix}0.9)`);
    ctx.fillStyle = sunGrad;
    ctx.beginPath();
    ctx.arc(cx, horizonY - sunR * 0.15, sunR, 0, Math.PI * 2);
    ctx.fill();

    // Đường cắt ngang trên mặt trời
    ctx.globalCompositeOperation = 'destination-out';
    for (let s = 0; s < 6; s++) {
      const sliceY = horizonY - sunR * (0.08 + s * 0.14);
      const sliceH = Math.max(2, sunR * (0.02 + (5 - s) * 0.008));
      ctx.fillRect(cx - sunR - 4, sliceY, sunR * 2 + 8, sliceH);
    }
    ctx.restore();

    // Đường chân trời phát sáng + dải núi phổ nhạc
    ctx.beginPath();
    const mountainPts = 32;
    ctx.moveTo(0, horizonY);
    for (let i = 0; i <= mountainPts; i++) {
      const px = (i / mountainPts) * w;
      const distCenter = Math.abs(i / mountainPts - 0.5) * 2;
      const spec = sampleSpectrumVal(spectrum, i % 48, timeSec, bass, mid, high);
      const peakH = (0.02 + spec * 0.13) * h * (0.35 + distCenter * 0.85);
      ctx.lineTo(px, horizonY - peakH);
    }
    ctx.lineTo(w, horizonY);
    ctx.strokeStyle = `${col.rgb2Prefix}${(0.6 + high * 0.4).toFixed(3)})`;
    ctx.lineWidth = Math.max(2, w * 0.0022);
    ctx.stroke();

    // Lưới sàn 3D cuộn liên tục về phía camera
    const floorH = h - horizonY;
    const gridScroll = (timeSec * (1.2 + beatPulse * 0.4)) % 1;
    const horizLines = 16;

    // Đường chân trời sáng rực
    ctx.beginPath();
    ctx.moveTo(0, horizonY);
    ctx.lineTo(w, horizonY);
    ctx.strokeStyle = `rgba(255,255,255,${(0.65 + beatPulse * 0.35).toFixed(3)})`;
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Các đường ngang có chiều sâu phối cảnh z^2
    for (let i = 0; i < horizLines; i++) {
      const t = (i + gridScroll) / horizLines;
      const z = t * t * (1 + beatPulse * 0.08);
      const y = horizonY + z * floorH;
      if (y > h) continue;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.strokeStyle = `${col.rgbPrefix}${(0.22 + t * 0.65).toFixed(3)})`;
      ctx.lineWidth = 1 + t * 2.2;
      ctx.stroke();
    }

    // Các đường dọc hội tụ về tâm chân trời
    const vertLines = 18;
    const fovSpread = 2.8 + beatPulse * 0.35;
    for (let i = -vertLines; i <= vertLines; i++) {
      const nx = i / vertLines;
      const xTop = cx + nx * w * 0.06;
      const xBot = cx + nx * w * fovSpread * 0.5;
      ctx.beginPath();
      ctx.moveTo(xTop, horizonY);
      ctx.lineTo(xBot, h);
      ctx.strokeStyle = `${col.rgbPrefix}${(0.3 + mid * 0.35).toFixed(3)})`;
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    ctx.restore();
  }

  // ===========================================================================
  // 6. PLASMA WAVE (SÓNG PLASMA ĐA TẦNG PHẢN ỨNG BASS / MID / HIGH)
  // ===========================================================================

  function renderPlasmaWave(ctx, w, h, _st, state, col) {
    const { timeSec, bass, mid, high, beatPulse, isOverlay } = state;
    clearStageBackground(ctx, w, h, isOverlay, col, 0.2 + bass * 0.45 + beatPulse * 0.35);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    const layers = 6;
    const steps = 64;
    const baseY = h * 0.52;

    for (let l = 0; l < layers; l++) {
      const ratio = l / (layers - 1);
      const prefix = l % 2 === 0 ? col.rgbPrefix : col.rgb2Prefix;
      const amp = h * (0.08 + bass * 0.14 + mid * 0.12 + beatPulse * 0.08) * (0.65 + ratio * 0.6);
      const freq1 = 2.2 + l * 0.45;
      const freq2 = 4.8 + l * 0.9;
      const speed1 = 1.3 + l * 0.28;
      const speed2 = 2.4 + high * 2.2;
      const yOffset = (ratio - 0.5) * h * 0.16;

      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const x = u * w;
        const env = Math.sin(u * Math.PI);
        const w1 = Math.sin(u * Math.PI * freq1 + timeSec * speed1 + l * 1.1);
        const w2 = Math.cos(u * Math.PI * freq2 - timeSec * speed2 + l * 0.7) * (0.28 + high * 0.55);
        const y = baseY + yOffset + (w1 + w2) * amp * env;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      // Viền phát sáng
      ctx.strokeStyle = `${prefix}${(0.55 + beatPulse * 0.35).toFixed(3)})`;
      ctx.lineWidth = Math.max(2.5, h * (0.004 + (1 - ratio) * 0.005));
      ctx.stroke();

      // Lõi mảnh sáng
      ctx.strokeStyle = `rgba(255,255,255,${(0.25 + beatPulse * 0.3).toFixed(3)})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // Dải ánh sáng mờ bên dưới sóng
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      const fillGrad = ctx.createLinearGradient(0, baseY - amp, 0, h);
      fillGrad.addColorStop(0, `${prefix}${(0.12 + bass * 0.14).toFixed(3)})`);
      fillGrad.addColorStop(0.65, `${prefix}0.02)`);
      fillGrad.addColorStop(1, `${prefix}0)`);
      ctx.fillStyle = fillGrad;
      ctx.fill();
    }

    ctx.restore();
  }

  // ===========================================================================
  // PUBLIC API
  // ===========================================================================

  function renderGeneratorFrame(ctx, w, h, type, state) {
    if (!ctx || w <= 0 || h <= 0) return;
    const s = state && typeof state === 'object' ? state : {};
    const normState = {
      timeSec: Number.isFinite(s.timeSec) ? s.timeSec : 0,
      dtSec: Number.isFinite(s.dtSec) ? Math.min(0.1, Math.max(0.001, s.dtSec)) : 1 / 60,
      bass: clamp01(Number(s.bass) || 0),
      mid: clamp01(Number(s.mid) || 0),
      high: clamp01(Number(s.high) || 0),
      spectrum: Array.isArray(s.spectrum) ? s.spectrum : null,
      bpm: Number.isFinite(s.bpm) ? s.bpm : 120,
      beatPhase: Number.isFinite(s.beatPhase) ? (s.beatPhase % 1 + 1) % 1 : 0,
      beatPulse: clamp01(Number(s.beatPulse) || 0),
      beatIndex: Number.isFinite(s.beatIndex) ? s.beatIndex : 0,
      color: s.color || '#00d2ff',
      isOverlay: Boolean(s.isOverlay)
    };

    const st = getCtxState(ctx);
    const col = parseColor(normState.color);

    switch (type) {
      case 'spectrum-bars':
        renderSpectrumBars(ctx, w, h, st, normState, col);
        break;
      case 'strobe-matrix':
        renderStrobeMatrix(ctx, w, h, st, normState, col);
        break;
      case 'pulse-rings':
        renderPulseRings(ctx, w, h, st, normState, col);
        break;
      case 'cyber-grid':
        renderCyberGrid(ctx, w, h, st, normState, col);
        break;
      case 'plasma-wave':
        renderPlasmaWave(ctx, w, h, st, normState, col);
        break;
      case 'laser-beams':
      default:
        renderLaserBeams(ctx, w, h, st, normState, col);
        break;
    }
  }

  function listGeneratorNames() {
    return GENERATOR_NAMES.slice();
  }

  return {
    renderGeneratorFrame,
    listGeneratorNames
  };
});
