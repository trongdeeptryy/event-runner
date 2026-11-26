/**
 * Bộ kiểm thử tự động cho logic thuần & DSP của EVENT RUNNER (dùng node:test)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const logic = require('../src/shared/logic');
const pathUtils = require('../src/shared/path-utils');

/**
 * Sinh tín hiệu bass giả lập gồm các cú kick 60 Hz tắt dần + nhiễu nền
 */
function generateKickSignal({
  sampleRate = 48000,
  durationSec = 1.6,
  kickTimesSec = [],
  kickGain = 0.65,
  noiseGain = 0.02,
  gainFn = null
}) {
  const totalSamples = Math.floor(sampleRate * durationSec);
  const out = new Float32Array(totalSamples);
  // Bộ sinh nhiễu giả ngẫu nhiên tất định (LCG)
  let seed = 1337;
  for (let i = 0; i < totalSamples; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const white = (seed / 0xffffffff) * 2 - 1;
    const t = i / sampleRate;
    const mult = typeof gainFn === 'function' ? gainFn(t) : 1.0;

    // Nhiễu nền trầm nhẹ + tiếng ù bass liên tục nhỏ
    let val = noiseGain * (0.5 * white + 0.5 * Math.sin(2 * Math.PI * 45 * t));

    for (let k = 0; k < kickTimesSec.length; k++) {
      const dt = t - kickTimesSec[k];
      if (dt >= 0 && dt < 0.085) {
        const attack = Math.min(1, dt / 0.0025);
        const env = attack * Math.exp(-dt / 0.032);
        val += kickGain * env * Math.sin(2 * Math.PI * 60 * dt);
      }
    }
    out[i] = val * mult;
  }
  return out;
}

/** Đưa mảng mẫu qua createOnsetDetector theo từng block 128 mẫu */
function runDetectorOnSignal(signal, detector, sampleRate = 48000, blockSize = 128) {
  const beats = [];
  for (let offset = 0; offset + blockSize <= signal.length; offset += blockSize) {
    const block = signal.subarray(offset, offset + blockSize);
    const timeSec = (offset + blockSize) / sampleRate;
    const res = detector.processBlock(block, timeSec);
    if (res) beats.push(res);
  }
  return beats;
}

test('createOnsetDetector (Tiêu chí 1): 8 cú kick 60 Hz cách nhau 120 ms + nhiễu nền -> bắt >= 7/8 và <= 1 beat sai', () => {
  const kickTimes = Array.from({ length: 8 }, (_, i) => 0.25 + i * 0.12);
  const signal = generateKickSignal({ durationSec: 1.5, kickTimesSec: kickTimes });
  const detector = logic.createOnsetDetector({
    sampleRate: 48000,
    blockSize: 128,
    sens: 6,
    minIntervalMs: 100
  });

  const beats = runDetectorOnSignal(signal, detector);
  let matched = 0;
  let falseBeats = 0;
  const usedKicks = new Set();

  for (const b of beats) {
    assert.ok(b.k >= 0.35 && b.k <= 1, 'Cường độ k_beat phải nằm trong [0.35, 1]');
    const idx = kickTimes.findIndex((kt, j) => !usedKicks.has(j) && Math.abs(b.t - kt) <= 0.03);
    if (idx >= 0) {
      usedKicks.add(idx);
      matched++;
    } else {
      falseBeats++;
    }
  }

  assert.ok(matched >= 7, `Kỳ vọng bắt >= 7/8 kick, thực tế bắt được ${matched}/8`);
  assert.ok(falseBeats <= 1, `Kỳ vọng <= 1 beat sai, thực tế có ${falseBeats}`);
});

test('createOnsetDetector (Tiêu chí 2): 8 cú kick 60 Hz cách nhau 90 ms (preset Remix bass nhanh) -> bắt >= 6/8', () => {
  const kickTimes = Array.from({ length: 8 }, (_, i) => 0.25 + i * 0.09);
  const signal = generateKickSignal({ durationSec: 1.2, kickTimesSec: kickTimes });
  const preset = logic.BASS_PRESETS['Remix bass nhanh'];
  const detector = logic.createOnsetDetector({
    sampleRate: 48000,
    blockSize: 128,
    sens: preset.sens,
    minIntervalMs: preset.minInterval
  });

  const beats = runDetectorOnSignal(signal, detector);
  let matched = 0;
  const usedKicks = new Set();
  for (const b of beats) {
    const idx = kickTimes.findIndex((kt, j) => !usedKicks.has(j) && Math.abs(b.t - kt) <= 0.03);
    if (idx >= 0) {
      usedKicks.add(idx);
      matched++;
    }
  }

  assert.ok(matched >= 6, `Kỳ vọng bắt >= 6/8 kick 90 ms, thực tế bắt được ${matched}/8`);
});

test('createOnsetDetector (Tiêu chí 3): sóng sin 80 Hz biên độ không đổi -> 0 beat', () => {
  const sampleRate = 48000;
  const totalSamples = sampleRate * 2;
  const signal = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    signal[i] = 0.5 * Math.sin(2 * Math.PI * 80 * (i / sampleRate));
  }

  const detector = logic.createOnsetDetector({ sampleRate, blockSize: 128, sens: 6, minIntervalMs: 100 });
  const beats = runDetectorOnSignal(signal, detector, sampleRate, 128);
  assert.equal(beats.length, 0, `Sóng sin 80 Hz đều phải cho 0 beat, thực tế: ${beats.length}`);
});

test('createOnsetDetector (Tiêu chí 4): đổi âm lượng +/- 12 dB giữa chừng -> số beat lệch <= 15%', () => {
  // 20 cú kick đoạn chuẩn (0.2s..3.0s) và 20 cú kick đoạn giảm -12 dB (3.4s..6.2s)
  const kicksA = Array.from({ length: 20 }, (_, i) => 0.25 + i * 0.14);
  const kicksB = Array.from({ length: 20 }, (_, i) => 3.5 + i * 0.14);
  const allKicks = [...kicksA, ...kicksB];

  // Đoạn sau đổi âm lượng -12 dB (hệ số biên độ = 10^(-12/20) ≈ 0.251)
  const signalDrop = generateKickSignal({
    durationSec: 6.6,
    kickTimesSec: allKicks,
    kickGain: 0.8,
    noiseGain: 0.02,
    gainFn: (t) => (t >= 3.3 ? 0.251 : 1.0)
  });

  const detDrop = logic.createOnsetDetector({ sampleRate: 48000, blockSize: 128, sens: 6, minIntervalMs: 100 });
  const beatsDrop = runDetectorOnSignal(signalDrop, detDrop);
  const countA = beatsDrop.filter((b) => b.t < 3.2).length;
  const countB = beatsDrop.filter((b) => b.t >= 3.4).length;

  assert.ok(countA >= 18, `Đoạn gốc phải bắt >= 18/20 beat, thực tế: ${countA}`);
  const diffRatio = Math.abs(countA - countB) / countA;
  assert.ok(diffRatio <= 0.15, `Chênh lệch sau -12 dB là ${(diffRatio * 100).toFixed(1)}% (> 15%)`);
});

test('BpmBeatTracker: bù trễ 0.04s và phát nhịp đúng theo BPM', () => {
  const tracker = new logic.BpmBeatTracker(0.04);
  const times = [0.0, 0.2, 0.45, 0.47, 0.7, 0.95, 0.97];
  const hits = [];
  for (const t of times) {
    const r = tracker.step(t, 120, 0);
    if (r.isBeat) hits.push(t);
  }
  assert.deepEqual(hits, [0.0, 0.47, 0.97]);
});

test('calculateTapBpm: tính BPM chuẩn và bỏ qua khoảng nghỉ > 2 giây', () => {
  const taps = [100, 600, 4100, 4600, 5100, 5600];
  assert.equal(logic.calculateTapBpm(taps), 120);
  assert.equal(logic.calculateTapBpm([1000]), null);
});

test('calculateOverscanScale: tính đủ cả beat shake lẫn rung nền liên tục chống lộ viền', () => {
  const baseOnly = logic.calculateOverscanScale(20, 2, 1920, 1080);
  const expectedBase = 1 + (20 * 2.4) / 1080 + 2 * 0.03;
  assert.ok(Math.abs(baseOnly - expectedBase) < 1e-9);

  const withIdle = logic.calculateOverscanScale(14, 1.2, 1920, 1080, {
    idleOn: true,
    idleAmp: 4,
    idleCouple: 0.9,
    idleRot: 0.35,
    idleBreath: 0.45
  });
  const expectedIdle =
    1 +
    (2.4 * (14 + 4 * (1 + 0.9 + 0.8))) / 1080 +
    0.03 * (1.2 + 0.35) +
    0.45 / 100;
  assert.ok(Math.abs(withIdle - expectedIdle) < 1e-9);
  assert.ok(withIdle > baseOnly);
});

test('pickNextBeatAngle & calculateEffectiveDecay: góc cách >= 60 độ và decay không chồng animation', () => {
  let prev = 0.5;
  for (let i = 0; i < 50; i++) {
    const next = logic.pickNextBeatAngle(prev);
    let diff = Math.abs(next - prev) % (Math.PI * 2);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    assert.ok(diff >= Math.PI / 3 - 1e-9, `Khoảng cách góc phải >= 60 độ, thực tế: ${(diff * 180 / Math.PI).toFixed(1)}°`);
    prev = next;
  }

  assert.equal(logic.calculateEffectiveDecay(220, 100), 90);
  assert.equal(logic.calculateEffectiveDecay(220, 50), 60);
  assert.equal(logic.calculateEffectiveDecay(140, 400), 140);
});

test('path-utils: chuyển đường dẫn tiếng Việt, dấu cách, ký tự đặc biệt sang file:// URL', () => {
  const winPath = 'C:\\Show Sự Kiện\\Nhạc & Hình\\01 Khai Mạc #1 (100%).mp4';
  const url = pathUtils.toSafeFileUrl(winPath);
  assert.ok(url.startsWith('file:///'));
  assert.ok(url.includes('%20'));
  assert.ok(url.includes('%23'));
  assert.ok(url.includes('%25'));

  const projFile = path.join('D:', 'Event2026', 'show.json');
  const relUrl = pathUtils.toSafeFileUrl('./show_media/nen.mp4', projFile);
  assert.ok(relUrl.endsWith('/Event2026/show_media/nen.mp4'));
});

test('validateAndMigrateProject (Tiêu chí 8): mở dự án cũ không có trường idle*, bassLow, motion vẫn bình thường', () => {
  const legacyProject = {
    version: 1,
    cues: [
      {
        id: 'legacy-1',
        name: 'Khai mạc cũ',
        aud: 'nhac.mp3',
        fx: { on: true, src: 'auto', scale: 8, shake: 15, step: true }
      },
      {
        id: 'legacy-1',
        vis: 'hinh.png'
      }
    ]
  };
  const res = logic.validateAndMigrateProject(legacyProject);
  assert.equal(res.ok, true);
  assert.equal(res.project.cues.length, 2);
  assert.notEqual(res.project.cues[0].id, res.project.cues[1].id);

  const fx0 = res.project.cues[0].fx;
  assert.equal(fx0.motion, 'step');
  assert.equal(fx0.idleOn, true);
  assert.equal(fx0.bassLow, 35);
  assert.equal(fx0.bassHigh, 150);
  assert.equal(fx0.delayMs, 50);
  assert.equal(fx0.minInterval, 100);
  assert.equal(fx0.idleStyle, 'smooth');
  // Mặc định mọi cue (kể cả dự án cũ) tự động tắt nhạc khi chuyển sang cue không có nhạc (keepAudio = false)
  assert.equal(res.project.cues[1].keepAudio, false);
  assert.equal(res.project.cues[1].stop, true);
  // Mặc định video cũ chưa có vvol sẽ tự bật tiếng gốc video (vsound = true, vvol = 100)
  const videoCue = logic.normalizeCue({ name: 'Clip intro', vis: 'C:/show/intro.mp4', vsound: false });
  assert.equal(videoCue.vsound, true);
  assert.equal(videoCue.vvol, 100);
  // Nhưng nếu đã có vvol (người dùng chủ động gạt OFF tiếng gốc video) thì giữ đúng vsound = false
  const mutedVideoCue = logic.normalizeCue({ name: 'Clip tắt tiếng', vis: 'C:/show/bg.mp4', vsound: false, vvol: 80 });
  assert.equal(mutedVideoCue.vsound, false);
  assert.equal(mutedVideoCue.vvol, 80);
  // Hỗ trợ nguồn beat trực tiếp từ Mixer / DJ ('ext') và nâng cấp dự án cũ lên đủ 6 nút SFX vuông kèm phím mặc định F1..F6
  const djCue = logic.normalizeCue({ name: 'DJ Set', vis: 'C:/show/dj-bg.mp4', fx: { on: true, src: 'ext' } });
  assert.equal(djCue.fx.src, 'ext');
  assert.equal(res.project.sfxPads.length, 6);
  assert.equal(res.project.sfxPads[0].hotkey, 'F1');
  assert.equal(res.project.sfxPads[0].hotkeyLabel, 'F1');
  assert.equal(res.project.sfxPads[5].hotkey, 'F6');
  assert.equal(res.project.sfxPads[5].hotkeyLabel, 'F6');

  // Giữ nguyên phím tắt tùy chỉnh do người dùng đã cài đặt (ví dụ F2 = Thổi kèn, hoặc gỡ phím = '')
  const customPads = logic.createDefaultSfxPads([
    { id: 'sfx-1', name: 'Vỗ tay', hotkey: '', hotkeyLabel: '---' },
    { id: 'sfx-2', name: 'Thổi kèn', hotkey: 'F1', hotkeyLabel: 'F1' }
  ]);
  assert.equal(customPads[0].hotkey, '');
  assert.equal(customPads[0].hotkeyLabel, '---');
  assert.equal(customPads[1].name, 'Thổi kèn');
  assert.equal(customPads[1].hotkey, 'F1');
  assert.equal(customPads[1].hotkeyLabel, 'F1');
});

test('pickBestDisplay: ưu tiên màn phụ theo ID, theo kích thước và fallback cửa sổ thử', () => {
  const single = [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];
  const s1 = logic.pickBestDisplay(single, 1, {});
  assert.equal(s1.mode, 'preview-window');
  assert.equal(s1.display.id, 1);

  const dual = [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 720 } },
    { id: 3, bounds: { x: 3200, y: 0, width: 3840, height: 2160 } }
  ];
  const byId = logic.pickBestDisplay(dual, 1, { lastDisplayId: 3 });
  assert.equal(byId.display.id, 3);

  const bySize = logic.pickBestDisplay(dual, 1, {
    lastDisplayId: 999,
    lastDisplaySize: { width: 3840, height: 2160 }
  });
  assert.equal(bySize.display.id, 3);
});

test('runPreflightAnalysis: phát hiện file mất, đuôi rủi ro codec, LED đóng, âm lượng 0', () => {
  const project = {
    version: 1,
    cues: [
      logic.createDefaultCue({
        name: 'Clip lỗi',
        vis: 'C:/show/video.mov',
        aud: 'C:/show/missing.mp3',
        vol: 0
      })
    ]
  };
  const report = logic.runPreflightAnalysis(project, {
    ledOpen: false,
    masterVol: 0,
    fileExistsMap: { 'C:/show/video.mov': true, 'C:/show/missing.mp3': false }
  });

  assert.equal(report.ok, false);
  assert.ok(report.errorCount >= 2);
  assert.ok(report.warningCount >= 3);
});

test('buildCuesFromMediaPaths: tự phân loại Ảnh, Video, Nhạc khi kéo thả hàng loạt vào Danh sách Cue', () => {
  const { cues, ignoredPaths } = logic.buildCuesFromMediaPaths([
    'D:\\Media\\01_Backdrop_Chinh.png',
    'D:\\Media\\02_Intro_KhaiMac.mp4',
    'D:\\Media\\03_Nhac_Nen_Remix.mp3',
    'D:\\Media\\tai_lieu_kich_ban.docx'
  ]);

  assert.equal(cues.length, 3);
  assert.equal(ignoredPaths.length, 1);

  assert.equal(cues[0].name, '01_Backdrop_Chinh');
  assert.equal(cues[0].vis, 'D:\\Media\\01_Backdrop_Chinh.png');
  assert.equal(cues[0].aud, null);

  assert.equal(cues[1].name, '02_Intro_KhaiMac');
  assert.equal(cues[1].vis, 'D:\\Media\\02_Intro_KhaiMac.mp4');
  assert.equal(cues[1].vsound, true);
  assert.equal(cues[1].vvol, 100);

  assert.equal(cues[2].name, '03_Nhac_Nen_Remix');
  assert.equal(cues[2].aud, 'D:\\Media\\03_Nhac_Nen_Remix.mp3');
  assert.equal(cues[2].vis, null);
});
