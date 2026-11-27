/**
 * Engine âm thanh Web Audio API cho EVENT RUNNER
 * Đồ thị âm thanh:
 *   nguồn nhạc -> gain từng bài -> musicBus -> masterGain
 *     ├─► DelayNode (bù trễ 0-200ms) -> AnalyserNode (spectrum 48 cột) -> destination (loa)
 *     └─► [NHÁNH PHÂN TÍCH TRƯỚC DELAY] HP1 -> HP2 -> LP1 -> LP2 -> AudioWorkletNode "bass-onset" -> silentGain -> destination
 * Lớp SFX độc lập đi qua sfxMasterGain -> destination.
 */
'use strict';

(function (root) {
  const logic = root.EventRunnerLogic;

  /** Fallback tính năng lượng 3 dải tần (bass 20-160Hz, mid 160-2000Hz, high 2000-12000Hz) nếu chạy độc lập */
  function computeThreeBandEnergyFallback(freqBuffer, sampleRate = 48000, fftSize = 2048) {
    if (!freqBuffer || freqBuffer.length === 0) {
      return { bass: 0, mid: 0, high: 0 };
    }
    const sr = Number(sampleRate) > 0 ? Number(sampleRate) : 48000;
    const nFft = Number(fftSize) > 0 ? Number(fftSize) : freqBuffer.length * 2;
    const binHz = sr / nFft;
    const bandAvg = (lowHz, highHz) => {
      const startBin = Math.max(0, Math.floor(lowHz / binHz));
      const endBin = Math.min(freqBuffer.length - 1, Math.ceil(highHz / binHz));
      if (endBin < startBin) return 0;
      let sum = 0;
      let count = 0;
      for (let i = startBin; i <= endBin; i++) {
        sum += freqBuffer[i];
        count++;
      }
      if (count <= 0) return 0;
      const avg = (sum / count) / 255;
      return avg < 0 ? 0 : (avg > 1 ? 1 : avg);
    };
    return {
      bass: bandAvg(20, 160),
      mid: bandAvg(160, 2000),
      high: bandAvg(2000, 12000)
    };
  }

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.musicBus = null;
      this.masterGain = null;
      this.delayNode = null;
      this.sfxMasterGain = null;
      this.analyser = null;

      // Nhánh phân tích bass
      this.internalAnalysisGate = null;
      this.externalAnalysisGate = null;
      this.videoAnalysisGate = null;
      this.videoBus = null;
      this.videoOutGain = null;
      this.liveVideoMap = new Map();
      this.analysisMode = 'internal'; // 'internal' | 'external' | 'video'
      this.hp1 = null;
      this.hp2 = null;
      this.lp1 = null;
      this.lp2 = null;
      this.workletNode = null;
      this.silentGain = null;
      this.workletReady = false;
      this.workletInitPromise = null;

      // Ngõ vào âm thanh trực tiếp từ Mixer / DJ (Line-In / USB Soundcard)
      this.extStream = null;
      this.extSourceNode = null;
      this.extGainNode = null;
      this.extAnalyser = null;
      this.extFreqBuffer = null;
      this.extGainPct = 100; // 20% - 400%
      this.extDeviceId = '';
      this.extActive = false;

      // Dự phòng nếu AudioWorklet không nạp được
      this.fallbackAnalyser = null;
      this.fallbackBuffer = null;
      this.fallbackTimer = null;
      this.fallbackDetector = null;
      this.fallbackBlockAcc = 0;
      this.fallbackLastCtxTime = 0;

      // Tham số phân tích bass hiện hành
      this.bassConfig = {
        bassLow: 35,
        bassHigh: 150,
        sens: 6,
        minInterval: 100,
        delayMs: 50
      };

      this.masterVol = 100;
      this.sfxVol = 90;
      this.rehearsalMode = false;

      this.activeDeck = null;
      this.fadingDecks = new Set();
      this.activeSfxSet = new Set();
      this.preloadedAudio = null;

      this.waveformCache = new Map();
      this.MAX_WAVEFORM_CACHE = 20;

      // Callbacks
      this.onAudioError = null;
      this.onAudioEnded = null;
      this.onBassBeat = null;
      this.onBassTelemetry = null;
      this.onWorkletFallback = null;
      this.onSfxStateChange = null;

      this.freqBuffer = null;
    }

    /** Tạo mã nguồn AudioWorkletProcessor nhúng hàm thuần createOnsetDetector */
    _buildWorkletCode() {
      const detectorSource = logic.createOnsetDetector.toString();
      return `
${detectorSource}

class BassOnsetProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.detector = createOnsetDetector({
      sampleRate: sampleRate,
      blockSize: 128,
      sens: opts.sens !== undefined ? opts.sens : 6,
      minIntervalMs: opts.minIntervalMs !== undefined ? opts.minIntervalMs : 100,
      floor: 0.015,
      lookbackBlocks: 4,
      windowSec: 1.0
    });
    this.telemetryCounter = 0;
    this.monoBuf = new Float32Array(128);
    this.port.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.type === 'config') {
        this.detector.setParams({
          sens: msg.sens,
          minIntervalMs: msg.minIntervalMs
        });
      } else if (msg.type === 'reset') {
        this.detector.reset();
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    if (!ch0 || ch0.length === 0) return true;

    let samples = ch0;
    if (input.length > 1 && input[1] && input[1].length === ch0.length) {
      if (this.monoBuf.length !== ch0.length) {
        this.monoBuf = new Float32Array(ch0.length);
      }
      const ch1 = input[1];
      for (let i = 0; i < ch0.length; i++) {
        this.monoBuf[i] = 0.5 * (ch0[i] + ch1[i]);
      }
      samples = this.monoBuf;
    }

    const beat = this.detector.processBlock(samples, currentTime);
    if (beat) {
      this.port.postMessage({
        type: 'beat',
        k: beat.k,
        o: beat.o,
        threshold: beat.threshold,
        env: beat.env,
        t: currentTime
      });
    }

    // Gửi telemetry ~30 lần/giây (~mỗi 12 block) để vẽ biểu đồ + rung nền theo độ căng bass
    this.telemetryCounter++;
    if (this.telemetryCounter >= 12) {
      this.telemetryCounter = 0;
      const m = this.detector.getLastMetrics();
      this.port.postMessage({
        type: 'telemetry',
        o: m.o,
        threshold: m.threshold,
        env: m.env,
        t: currentTime
      });
    }
    return true;
  }
}

registerProcessor('bass-onset', BassOnsetProcessor);
`;
    }

    /** Khởi tạo đồ thị AudioContext + DelayNode + Bộ lọc bass 24 dB/oct + Worklet */
    ensureContext() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') {
          this.ctx.resume().catch(() => {});
        }
        return this.ctx;
      }

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();

      this.musicBus = this.ctx.createGain();
      this.masterGain = this.ctx.createGain();
      this.sfxMasterGain = this.ctx.createGain();

      // DelayNode chỉ làm trễ đường ra loa (tối đa 0.3s, mặc định 50 ms)
      this.delayNode = this.ctx.createDelay(0.3);
      this.delayNode.delayTime.value = logic.clamp(this.bassConfig.delayMs / 1000, 0, 0.2);

      // Analyser cho spectrum 48 cột (sau DelayNode để khớp tiếng nghe)
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.3;

      this.musicBus.connect(this.masterGain);
      this.masterGain.connect(this.delayNode);
      this.delayNode.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);

      this.sfxMasterGain.connect(this.ctx.destination);
      this.freqBuffer = new Uint8Array(this.analyser.frequencyBinCount);

      // Nhánh phân tích bass lấy TRƯỚC DelayNode (chuyển mạch sạch giữa nhạc phần mềm, Line-In Mixer/DJ & tiếng video)
      this.internalAnalysisGate = this.ctx.createGain();
      this.externalAnalysisGate = this.ctx.createGain();
      this.videoAnalysisGate = this.ctx.createGain();
      this.internalAnalysisGate.gain.value = this.analysisMode === 'internal' ? 1 : 0;
      this.externalAnalysisGate.gain.value = this.analysisMode === 'external' ? 1 : 0;
      this.videoAnalysisGate.gain.value = this.analysisMode === 'video' ? 1 : 0;

      // Nhánh video xem trước cục bộ (chỉ hoạt động khi Tập dượt / tắt LED)
      this.videoBus = this.ctx.createGain();
      this.videoOutGain = this.ctx.createGain();
      this.videoOutGain.gain.value = 1;
      this.videoBus.connect(this.videoAnalysisGate);
      this.videoBus.connect(this.videoOutGain);
      this.videoOutGain.connect(this.delayNode);

      // Nhánh thu ngoài từ Mixer / Soundcard (KHÔNG nối ra destination để chống hú/vọng loa)
      this.extGainNode = this.ctx.createGain();
      this.extGainNode.gain.value = logic.clamp(this.extGainPct / 100, 0.1, 4.0);
      this.extAnalyser = this.ctx.createAnalyser();
      this.extAnalyser.fftSize = 2048;
      this.extAnalyser.smoothingTimeConstant = 0.3;
      this.extFreqBuffer = new Uint8Array(this.extAnalyser.frequencyBinCount);
      this.extGainNode.connect(this.extAnalyser);
      this.extGainNode.connect(this.externalAnalysisGate);

      this.hp1 = this.ctx.createBiquadFilter();
      this.hp2 = this.ctx.createBiquadFilter();
      this.lp1 = this.ctx.createBiquadFilter();
      this.lp2 = this.ctx.createBiquadFilter();

      [this.hp1, this.hp2].forEach((f) => {
        f.type = 'highpass';
        f.Q.value = 0.707;
        f.frequency.value = this.bassConfig.bassLow;
      });
      [this.lp1, this.lp2].forEach((f) => {
        f.type = 'lowpass';
        f.Q.value = 0.707;
        f.frequency.value = this.bassConfig.bassHigh;
      });

      this.silentGain = this.ctx.createGain();
      this.silentGain.gain.value = 0;

      this.masterGain.connect(this.internalAnalysisGate);
      this.internalAnalysisGate.connect(this.hp1);
      this.externalAnalysisGate.connect(this.hp1);
      this.videoAnalysisGate.connect(this.hp1);
      this.hp1.connect(this.hp2);
      this.hp2.connect(this.lp1);
      this.lp1.connect(this.lp2);
      this.extAnalyser.connect(this.silentGain);
      this.silentGain.connect(this.ctx.destination);

      this._initBassWorklet();
      this._applyMasterGains();
      return this.ctx;
    }

    /** Nạp AudioWorklet qua module tĩnh (hoặc Blob URL fallback), tự chuyển sang AnalyserNode nếu lỗi */
    _initBassWorklet() {
      if (this.workletInitPromise) return this.workletInitPromise;

      this.workletInitPromise = (async () => {
        if (!this.ctx || !this.ctx.audioWorklet || typeof AudioWorkletNode !== 'function') {
          this._activateFallbackAnalyser('Trình duyệt không hỗ trợ AudioWorklet, đang dùng bộ dò dự phòng AnalyserNode.');
          return;
        }

        try {
          try {
            await this.ctx.audioWorklet.addModule('src/control/bass-onset-worklet.js');
          } catch (staticErr) {
            let blobUrl = null;
            try {
              const code = this._buildWorkletCode();
              const blob = new Blob([code], { type: 'application/javascript' });
              blobUrl = URL.createObjectURL(blob);
              await this.ctx.audioWorklet.addModule(blobUrl);
            } finally {
              if (blobUrl) {
                try { URL.revokeObjectURL(blobUrl); } catch (_) {}
              }
            }
          }

          if (!this.ctx || !this.lp2 || !this.silentGain) return;
          this.workletNode = new AudioWorkletNode(this.ctx, 'bass-onset', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            channelCount: 2,
            processorOptions: {
              sens: this.bassConfig.sens,
              minIntervalMs: this.bassConfig.minInterval
            }
          });

          this.workletNode.port.onmessage = (ev) => {
            const msg = ev.data;
            if (!msg) return;
            if (msg.type === 'beat') {
              if (typeof this.onBassBeat === 'function') {
                this.onBassBeat(msg);
              }
            } else if (msg.type === 'telemetry') {
              if (typeof this.onBassTelemetry === 'function') {
                this.onBassTelemetry(msg);
              }
            }
          };

          this.lp2.connect(this.workletNode);
          this.workletNode.connect(this.silentGain);
          this.workletReady = true;
        } catch (err) {
          const reason = err && err.message ? err.message : String(err);
          console.warn('[AudioEngine] AudioWorklet fallback active:', reason);
          this._activateFallbackAnalyser('');
        }
      })();

      return this.workletInitPromise;
    }

    /** Phương án dự phòng dùng AnalyserNode (fftSize 2048) đồng bộ ctx.currentTime chạy cùng thuật toán onset */
    _activateFallbackAnalyser(message) {
      if (this.fallbackAnalyser) return;
      if (message && typeof this.onWorkletFallback === 'function') {
        this.onWorkletFallback(message);
      }
      if (!this.ctx || !this.lp2 || !this.silentGain) return;

      this.fallbackAnalyser = this.ctx.createAnalyser();
      this.fallbackAnalyser.fftSize = 2048;
      this.lp2.connect(this.fallbackAnalyser);
      this.fallbackAnalyser.connect(this.silentGain);
      this.fallbackBuffer = new Float32Array(this.fallbackAnalyser.fftSize);
      this.fallbackLastCtxTime = 0;
      this.fallbackDetector = logic.createOnsetDetector({
        sampleRate: this.ctx.sampleRate || 48000,
        blockSize: 128,
        sens: this.bassConfig.sens,
        minIntervalMs: this.bassConfig.minInterval,
        floor: 0.015
      });

      this.fallbackTimer = setInterval(() => {
        if (!this.ctx || !this.fallbackAnalyser || (!this.activeDeck && !this.extActive && !this.isLiveVideoPlaying())) {
          this.fallbackLastCtxTime = 0;
          return;
        }
        if (this.ctx.state === 'suspended') {
          this.ctx.resume().catch(() => {});
        }
        const sr = this.ctx.sampleRate || 48000;
        const buf = this.fallbackBuffer;
        const bufLen = buf.length;
        const nowCtx = this.ctx.currentTime;
        let nBlocks = 0;
        if (this.fallbackLastCtxTime <= 0 || nowCtx < this.fallbackLastCtxTime || (nowCtx - this.fallbackLastCtxTime) > 0.25) {
          nBlocks = 4;
          this.fallbackLastCtxTime = nowCtx - (nBlocks * 128) / sr;
        } else {
          nBlocks = Math.min(
            Math.floor(bufLen / 128),
            Math.floor(((nowCtx - this.fallbackLastCtxTime) * sr) / 128)
          );
        }

        let emittedBeat = null;
        if (nBlocks > 0) {
          this.fallbackAnalyser.getFloatTimeDomainData(buf);
          const startSample = bufLen - nBlocks * 128;
          for (let i = 0; i < nBlocks; i++) {
            const off = startSample + i * 128;
            const slice = buf.subarray(off, off + 128);
            const blockTime = this.fallbackLastCtxTime + ((i + 1) * 128) / sr;
            const beat = this.fallbackDetector.processBlock(slice, blockTime);
            if (beat) emittedBeat = beat;
          }
          this.fallbackLastCtxTime += (nBlocks * 128) / sr;
        }
        if (emittedBeat && typeof this.onBassBeat === 'function') {
          this.onBassBeat(emittedBeat);
        }
        this.fallbackBlockAcc++;
        if (this.fallbackBlockAcc >= 2 && typeof this.onBassTelemetry === 'function') {
          this.fallbackBlockAcc = 0;
          const m = this.fallbackDetector.getLastMetrics();
          this.onBassTelemetry({ o: m.o, threshold: m.threshold, env: m.env, t: nowCtx });
        }
      }, 16);
    }

    /** Cập nhật thông số lọc dải bass, độ nhạy, khoảng tối thiểu và bù trễ DelayNode */
    configureBassAnalysis(fx) {
      if (!fx || typeof fx !== 'object') return;
      const bassLow = logic.clamp(fx.bassLow ?? 35, 20, 80);
      let bassHigh = logic.clamp(fx.bassHigh ?? 150, 80, 250);
      if (bassHigh <= bassLow + 15) bassHigh = logic.clamp(bassLow + 30, 80, 250);
      const sens = logic.clamp(fx.sens ?? 6, 1, 10);
      const minInterval = logic.clamp(fx.minInterval ?? 100, 60, 300);
      const delayMs = logic.clamp(fx.delayMs ?? 50, 0, 200);

      this.bassConfig = { bassLow, bassHigh, sens, minInterval, delayMs };

      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      if (this.hp1 && this.hp2) {
        this.hp1.frequency.setTargetAtTime(bassLow, now, 0.015);
        this.hp2.frequency.setTargetAtTime(bassLow, now, 0.015);
      }
      if (this.lp1 && this.lp2) {
        this.lp1.frequency.setTargetAtTime(bassHigh, now, 0.015);
        this.lp2.frequency.setTargetAtTime(bassHigh, now, 0.015);
      }
      if (this.delayNode) {
        this.delayNode.delayTime.setTargetAtTime(delayMs / 1000, now, 0.015);
      }
      if (this.workletNode && this.workletReady) {
        this.workletNode.port.postMessage({
          type: 'config',
          sens,
          minIntervalMs: minInterval
        });
      }
      if (this.fallbackDetector) {
        this.fallbackDetector.setParams({ sens, minIntervalMs: minInterval });
      }
    }

    /** Xóa bộ đệm bộ dò khi đổi/dừng nhạc */
    resetBassDetector() {
      this.fallbackLastCtxTime = 0;
      if (this.workletNode && this.workletReady) {
        try {
          this.workletNode.port.postMessage({ type: 'reset' });
        } catch (_) {}
      }
      if (this.fallbackDetector) {
        this.fallbackDetector.reset();
      }
    }

    /** Giải phóng nhánh phân tích và đóng port worklet khi thoát */
    disposeBassBranch() {
      this.stopExternalInput();
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
      if (this.workletNode) {
        try {
          this.workletNode.port.onmessage = null;
          this.workletNode.port.close();
          this.workletNode.disconnect();
        } catch (_) {}
        this.workletNode = null;
        this.workletReady = false;
      }
      [
        this.internalAnalysisGate,
        this.externalAnalysisGate,
        this.videoAnalysisGate,
        this.videoBus,
        this.videoOutGain,
        this.extGainNode,
        this.extAnalyser,
        this.hp1,
        this.hp2,
        this.lp1,
        this.lp2,
        this.silentGain,
        this.fallbackAnalyser
      ].forEach((n) => {
        if (n) {
          try { n.disconnect(); } catch (_) {}
        }
      });
    }

    /** Chuyển nguồn đưa vào bộ phân tích DSP: 'internal' (nhạc phần mềm), 'external' (Mixer/DJ), hoặc 'video' (tiếng video cục bộ) */
    setAnalysisSourceMode(mode) {
      const nextMode = (mode === 'external' || mode === 'video') ? mode : 'internal';
      if (this.analysisMode !== nextMode) {
        this.analysisMode = nextMode;
        this.resetBassDetector();
      }
      if (!this.ctx || !this.internalAnalysisGate || !this.externalAnalysisGate) return;
      const now = this.ctx.currentTime;
      this.internalAnalysisGate.gain.setTargetAtTime(nextMode === 'internal' ? 1 : 0, now, 0.01);
      this.externalAnalysisGate.gain.setTargetAtTime(nextMode === 'external' ? 1 : 0, now, 0.01);
      if (this.videoAnalysisGate) {
        this.videoAnalysisGate.gain.setTargetAtTime(nextMode === 'video' ? 1 : 0, now, 0.01);
      }
    }

    /** Gắn / đồng bộ phần tử <video> đang phát cục bộ vào Web Audio để dò beat khi Tập dượt hoặc tắt cửa sổ LED */
    syncLiveVideoElement(videoEl, shouldPlayOutput, cueVol0to1, attachIfNeeded, outVol0to1) {
      if (!videoEl) return false;
      let entry = this.liveVideoMap.get(videoEl) || null;
      if (!entry && !attachIfNeeded) return false;

      this.ensureContext();
      if (!this.ctx) return false;
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }

      if (!entry) {
        try {
          const source = this.ctx.createMediaElementSource(videoEl);
          const gain = this.ctx.createGain();
          source.connect(gain);
          gain.connect(this.videoBus);
          entry = { source, gain, targetVol: 0 };
          this.liveVideoMap.set(videoEl, entry);
        } catch (_) {
          return false;
        }
      }

      const rawCueVol = logic.clamp(cueVol0to1 ?? (shouldPlayOutput ? 1 : 0), 0, 1);
      const nextCueVol = (shouldPlayOutput || attachIfNeeded) ? rawCueVol : 0;
      const resolvedOutVol = outVol0to1 !== undefined
        ? (shouldPlayOutput ? logic.clamp(outVol0to1, 0, 1) : 0)
        : (shouldPlayOutput ? 1 : 0);

      entry.targetVol = nextCueVol;
      entry.gain.gain.setTargetAtTime(nextCueVol, this.ctx.currentTime, 0.012);
      if (this.videoOutGain) {
        this.videoOutGain.gain.setTargetAtTime(resolvedOutVol, this.ctx.currentTime, 0.012);
      }
      videoEl.muted = false;
      videoEl.volume = 1;
      return true;
    }

    disconnectLiveVideoElement(videoEl) {
      if (!videoEl) return;
      const entry = this.liveVideoMap.get(videoEl);
      if (!entry) return;
      this.liveVideoMap.delete(videoEl);
      try { entry.source.disconnect(); } catch (_) {}
      try { entry.gain.disconnect(); } catch (_) {}
    }

    isLiveVideoPlaying() {
      for (const [videoEl, entry] of this.liveVideoMap.entries()) {
        if (!videoEl || !videoEl.isConnected) {
          this.disconnectLiveVideoElement(videoEl);
          continue;
        }
        if (!videoEl.paused && !videoEl.ended && entry && entry.targetVol > 0.001) {
          return true;
        }
      }
      return false;
    }

    /** Lấy danh sách thiết bị thu âm (Line-In / USB Soundcard / Mixer / Mic) */
    async listInputDevices() {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter((d) => d.kind === 'audioinput');
      } catch (_) {
        return [];
      }
    }

    /** Lấy danh sách thiết bị Camera / Video Capture */
    async listVideoInputDevices() {
      try {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
          return [];
        }
        const devices = await navigator.mediaDevices.enumerateDevices();
        return Array.isArray(devices) ? devices.filter((d) => d && d.kind === 'videoinput') : [];
      } catch (_) {
        return [];
      }
    }

    /** Bật thu tín hiệu trực tiếp từ Mixer / DJ (tắt toàn bộ lọc thoại để giữ nguyên dải sub-bass) */
    async startExternalInput(deviceId) {
      this.ensureContext();
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        return { ok: false, error: 'Hệ thống không hỗ trợ thu tín hiệu âm thanh đầu vào.' };
      }

      this.stopExternalInput();
      const targetId = deviceId || '';

      try {
        const audioConstraints = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 2 }
        };
        if (targetId) {
          audioConstraints.deviceId = { exact: targetId };
        }

        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
        } catch (exactErr) {
          // Nếu thiết bị cũ đã rút ra, tự fallback về thiết bị Line-In mặc định để không gãy show
          if (targetId) {
            delete audioConstraints.deviceId;
            stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
          } else {
            throw exactErr;
          }
        }

        this.extStream = stream;
        this.extSourceNode = this.ctx.createMediaStreamSource(stream);
        this.extSourceNode.connect(this.extGainNode);
        this.extDeviceId = targetId;
        this.extActive = true;
        this.resetBassDetector();

        const track = stream.getAudioTracks()[0];
        const label = track && track.label ? track.label : 'Line-In / Mixer';
        return { ok: true, label };
      } catch (err) {
        this.extActive = false;
        return {
          ok: false,
          error: err && err.message ? err.message : String(err)
        };
      }
    }

    /** Ngắt thu tín hiệu ngoài và giải phóng thiết bị âm thanh */
    stopExternalInput() {
      if (this.extSourceNode) {
        try { this.extSourceNode.disconnect(); } catch (_) {}
        this.extSourceNode = null;
      }
      if (this.extStream) {
        try {
          this.extStream.getTracks().forEach((t) => t.stop());
        } catch (_) {}
        this.extStream = null;
      }
      this.extActive = false;
    }

    isExternalInputActive() {
      return Boolean(this.extActive && this.extStream);
    }

    /** Chỉnh độ khuếch đại tín hiệu từ Mixer (20% - 400%) */
    setExternalGain(pct) {
      this.extGainPct = logic.clamp(pct, 20, 400);
      if (this.ctx && this.extGainNode) {
        this.extGainNode.gain.setTargetAtTime(this.extGainPct / 100, this.ctx.currentTime, 0.015);
      }
    }

    /** Đọc phổ 48 cột & mức tín hiệu đầu vào từ Mixer / DJ */
    sampleExternalSpectrum() {
      if (!this.ctx || !this.extAnalyser || !this.extFreqBuffer || !this.extActive) {
        return { bars: new Array(48).fill(0), level: 0 };
      }
      this.extAnalyser.getByteFrequencyData(this.extFreqBuffer);
      const bars = new Array(48);
      const usableBins = Math.floor(this.extFreqBuffer.length * 0.55);
      let sumLowMid = 0;
      for (let i = 0; i < 48; i++) {
        const startRatio = Math.pow(i / 48, 1.5);
        const endRatio = Math.pow((i + 1) / 48, 1.5);
        const b0 = Math.floor(startRatio * usableBins);
        const b1 = Math.max(b0 + 1, Math.floor(endRatio * usableBins));
        let maxVal = 0;
        for (let b = b0; b < b1 && b < this.extFreqBuffer.length; b++) {
          if (this.extFreqBuffer[b] > maxVal) maxVal = this.extFreqBuffer[b];
        }
        bars[i] = maxVal / 255;
        if (i < 24) sumLowMid += bars[i];
      }
      return {
        bars,
        level: logic.clamp((sumLowMid / 24) * 1.45, 0, 1)
      };
    }

    /** Cập nhật mức gain tổng */
    _applyMasterGains() {
      if (!this.ctx) return;
      const rehearsalFactor = this.rehearsalMode ? 0.35 : 1.0;
      const now = this.ctx.currentTime;
      const mVal = logic.clamp(this.masterVol / 100, 0, 1) * rehearsalFactor;
      const sVal = logic.clamp(this.sfxVol / 100, 0, 1) * rehearsalFactor;

      this.masterGain.gain.cancelScheduledValues(now);
      this.masterGain.gain.setValueAtTime(mVal, now);

      this.sfxMasterGain.gain.cancelScheduledValues(now);
      this.sfxMasterGain.gain.setValueAtTime(sVal, now);
    }

    setMasterVolume(vol0to100) {
      this.masterVol = logic.clamp(vol0to100, 0, 100);
      this._applyMasterGains();
    }

    setSfxVolume(vol0to100) {
      this.sfxVol = logic.clamp(vol0to100, 0, 100);
      this._applyMasterGains();
    }

    setRehearsalMode(enabled) {
      this.rehearsalMode = Boolean(enabled);
      this._applyMasterGains();
    }

    /** Chọn thiết bị phát âm thanh */
    async setOutputDevice(deviceId) {
      this.ensureContext();
      if (typeof this.ctx.setSinkId !== 'function') {
        return { ok: false, error: 'Phiên bản trình duyệt hiện tại không hỗ trợ đổi thiết bị phát.' };
      }
      try {
        await this.ctx.setSinkId(deviceId || '');
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    }

    async listOutputDevices() {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
          return [];
        }
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter((d) => d.kind === 'audiooutput');
      } catch (_) {
        return [];
      }
    }

    /** Nạp sẵn bài nhạc kế tiếp */
    preloadTrack(url) {
      if (!url) return;
      if (this.preloadedAudio && this.preloadedAudio.url === url) return;
      if (this.preloadedAudio && this.preloadedAudio.element) {
        try {
          this.preloadedAudio.element.pause();
          this.preloadedAudio.element.removeAttribute('src');
          this.preloadedAudio.element.load();
        } catch (_) {}
      }
      const el = new Audio();
      el.preload = 'auto';
      el.src = url;
      el.load();
      this.preloadedAudio = { url, element: el };
    }

    /** Giải phóng deck sau khi tắt dần xong */
    _disposeDeck(deck) {
      if (!deck) return;
      clearTimeout(deck.disposeTimer);
      clearInterval(deck.endCheckTimer);
      this.fadingDecks.delete(deck);
      try {
        deck.audio.onended = null;
        deck.audio.onerror = null;
        deck.audio.pause();
        deck.audio.removeAttribute('src');
        deck.audio.load();
      } catch (_) {}
      try {
        deck.source.disconnect();
        deck.gain.disconnect();
      } catch (_) {}
    }

    /** Tắt dần một deck rồi giải phóng */
    _fadeOutDeck(deck, fadeSec) {
      if (!deck || !this.ctx) return;
      if (this.activeDeck === deck) {
        this.activeDeck = null;
      }
      this.fadingDecks.add(deck);
      clearTimeout(deck.disposeTimer);

      const dur = Math.max(0.02, Number(fadeSec) || 0.02);
      const now = this.ctx.currentTime;
      const g = deck.gain.gain;
      const currentVal = g.value;
      g.cancelScheduledValues(now);
      g.setValueAtTime(currentVal, now);
      g.linearRampToValueAtTime(0, now + dur);

      deck.disposeTimer = setTimeout(() => {
        this._disposeDeck(deck);
      }, dur * 1000 + 80);
    }

    /** Tắt dần bài đang phát (Nút F - 2s) */
    fadeOutCurrent(fadeSec = 2.0) {
      if (!this.activeDeck) return;
      this._fadeOutDeck(this.activeDeck, fadeSec);
    }

    /** Dừng khẩn cấp toàn bộ nhạc (Nút Esc - 0.3s) */
    stopAll(fadeSec = 0.3) {
      if (this.activeDeck) {
        this._fadeOutDeck(this.activeDeck, fadeSec);
      }
      for (const d of Array.from(this.fadingDecks)) {
        this._fadeOutDeck(d, Math.min(fadeSec, 0.25));
      }
      this.stopAllSfx(0.2);
      this.resetBassDetector();
    }

    /** Phát nhạc cho một cue */
    playCue(cue, resolvedUrl) {
      this.ensureContext();
      if (cue && cue.fx) {
        this.configureBassAnalysis(cue.fx);
      }

      if (!resolvedUrl) {
        // Mặc định khi chuyển sang Cue khác không có nhạc: tắt dần nhạc của Cue trước cùng lúc chuyển slide,
        // trừ khi người dùng chủ động bật keepAudio ("Giữ nhạc của Cue trước tiếp tục phát").
        if (!cue || !cue.keepAudio) {
          if (this.activeDeck) {
            this._fadeOutDeck(this.activeDeck, cue ? (cue.fadeOut ?? cue.dur ?? 0.8) : 0.8);
          }
          this.resetBassDetector();
        }
        return;
      }

      const oldDeck = this.activeDeck;
      if (oldDeck) {
        this._fadeOutDeck(oldDeck, cue.fadeOut ?? 1.0);
      }
      this.resetBassDetector();

      let audioEl;
      if (this.preloadedAudio && this.preloadedAudio.url === resolvedUrl) {
        audioEl = this.preloadedAudio.element;
        this.preloadedAudio = null;
      } else {
        audioEl = new Audio();
        audioEl.preload = 'auto';
        audioEl.src = resolvedUrl;
      }

      const source = this.ctx.createMediaElementSource(audioEl);
      const gain = this.ctx.createGain();
      source.connect(gain);
      gain.connect(this.musicBus);

      const targetVol = logic.clamp((cue.vol ?? 100) / 100, 0, 1);
      const fadeInSec = Math.max(0, Number(cue.fadeIn ?? 0.5));
      const now = this.ctx.currentTime;

      gain.gain.cancelScheduledValues(now);
      if (fadeInSec > 0.02) {
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(targetVol, now + fadeInSec);
      } else {
        gain.gain.setValueAtTime(targetVol, now);
      }

      const deck = {
        cueId: cue.id,
        title: cue.name,
        fileName: window.api.baseName(cue.aud || ''),
        url: resolvedUrl,
        audio: audioEl,
        source,
        gain,
        startAt: Math.max(0, Number(cue.startAt) || 0),
        endAt: Math.max(0, Number(cue.endAt) || 0),
        disposeTimer: null,
        endCheckTimer: null,
        endedHandled: false
      };

      this.activeDeck = deck;

      const triggerEnd = () => {
        if (deck.endedHandled) return;
        deck.endedHandled = true;
        const wasActive = this.activeDeck === deck;
        this._disposeDeck(deck);
        if (wasActive) {
          this.activeDeck = null;
          if (typeof this.onAudioEnded === 'function') {
            this.onAudioEnded(deck.cueId);
          }
        }
      };

      audioEl.onended = triggerEnd;
      audioEl.onerror = () => {
        const msg = 'Không phát được file nhạc này (hãy kiểm tra định dạng MP3/WAV/AAC).';
        if (typeof this.onAudioError === 'function') {
          this.onAudioError({ cueId: cue.id, path: cue.aud, message: msg });
        }
        this._disposeDeck(deck);
        if (this.activeDeck === deck) this.activeDeck = null;
      };

      if (deck.startAt > 0) {
        const applyStart = () => {
          try {
            if (deck.startAt < (audioEl.duration || Infinity)) {
              audioEl.currentTime = deck.startAt;
            }
          } catch (_) {}
        };
        if (audioEl.readyState >= 1) {
          applyStart();
        } else {
          audioEl.addEventListener('loadedmetadata', applyStart, { once: true });
        }
      }

      if (deck.endAt > deck.startAt) {
        deck.endCheckTimer = setInterval(() => {
          if (audioEl.currentTime >= deck.endAt) {
            triggerEnd();
          }
        }, 80);
      }

      audioEl.play().catch((err) => {
        if (typeof this.onAudioError === 'function') {
          this.onAudioError({
            cueId: cue.id,
            path: cue.aud,
            message: 'Không khởi phát được nhạc: ' + (err && err.message ? err.message : String(err))
          });
        }
      });
    }

    seekActive(seconds) {
      if (!this.activeDeck) return;
      const a = this.activeDeck.audio;
      if (!a || !Number.isFinite(a.duration)) return;
      a.currentTime = logic.clamp(seconds, 0, Math.max(0, a.duration - 0.05));
    }

    getCurrentTrackInfo() {
      if (!this.activeDeck) {
        return {
          playing: false,
          cueId: null,
          fileName: 'Chưa phát nhạc',
          currentTime: 0,
          duration: 0,
          endAt: 0
        };
      }
      const a = this.activeDeck.audio;
      const duration = Number.isFinite(a.duration) ? a.duration : 0;
      const effectiveEnd = this.activeDeck.endAt > this.activeDeck.startAt && duration > 0
        ? Math.min(duration, this.activeDeck.endAt)
        : duration;
      return {
        playing: !a.paused,
        cueId: this.activeDeck.cueId,
        cueTitle: this.activeDeck.title,
        fileName: this.activeDeck.fileName || this.activeDeck.title,
        currentTime: a.currentTime || 0,
        duration: effectiveEnd || duration,
        rawDuration: duration,
        endAt: this.activeDeck.endAt
      };
    }

    playSfx(pad, resolvedUrl) {
      if (!resolvedUrl) return;
      this.ensureContext();

      const el = new Audio();
      el.src = resolvedUrl;
      const srcNode = this.ctx.createMediaElementSource(el);
      const padGain = this.ctx.createGain();
      padGain.gain.value = logic.clamp((pad.vol ?? 90) / 100, 0, 1);

      srcNode.connect(padGain);
      padGain.connect(this.sfxMasterGain);

      const entry = { padId: pad.id, el, srcNode, padGain, disposed: false };
      this.activeSfxSet.add(entry);
      if (typeof this.onSfxStateChange === 'function') {
        this.onSfxStateChange(this.getPlayingSfxPadIds());
      }

      const cleanup = () => {
        if (entry.disposed) return;
        entry.disposed = true;
        this.activeSfxSet.delete(entry);
        try {
          el.pause();
          el.removeAttribute('src');
          el.load();
          srcNode.disconnect();
          padGain.disconnect();
        } catch (_) {}
        if (typeof this.onSfxStateChange === 'function') {
          this.onSfxStateChange(this.getPlayingSfxPadIds());
        }
      };
      el.onended = cleanup;
      el.onerror = cleanup;
      el.play().catch(cleanup);
    }

    /** Ngắt mượt toàn bộ hiệu ứng SFX đang phát (ví dụ ngắt trống hồi khi công bố giải) */
    stopAllSfx(fadeSec = 0.25) {
      if (!this.ctx || this.activeSfxSet.size === 0) return;
      const dur = Math.max(0.03, Number(fadeSec) || 0.25);
      const now = this.ctx.currentTime;
      for (const entry of Array.from(this.activeSfxSet)) {
        try {
          const g = entry.padGain.gain;
          g.cancelScheduledValues(now);
          g.setValueAtTime(g.value, now);
          g.linearRampToValueAtTime(0, now + dur);
          setTimeout(() => {
            if (!entry.disposed) {
              entry.disposed = true;
              this.activeSfxSet.delete(entry);
              try {
                entry.el.pause();
                entry.el.removeAttribute('src');
                entry.el.load();
                entry.srcNode.disconnect();
                entry.padGain.disconnect();
              } catch (_) {}
              if (typeof this.onSfxStateChange === 'function') {
                this.onSfxStateChange(this.getPlayingSfxPadIds());
              }
            }
          }, dur * 1000 + 40);
        } catch (_) {}
      }
    }

    getPlayingSfxPadIds() {
      const ids = new Set();
      for (const e of this.activeSfxSet) {
        if (!e.disposed && e.padId) ids.add(e.padId);
      }
      return ids;
    }

    /** Lấy dữ liệu phổ tần số 48 cột */
    sampleSpectrum() {
      if (!this.ctx || !this.analyser || !this.freqBuffer) {
        return new Array(48).fill(0);
      }
      this.analyser.getByteFrequencyData(this.freqBuffer);
      const bars = new Array(48);
      const usableBins = Math.floor(this.freqBuffer.length * 0.55);
      for (let i = 0; i < 48; i++) {
        const startRatio = Math.pow(i / 48, 1.5);
        const endRatio = Math.pow((i + 1) / 48, 1.5);
        const b0 = Math.floor(startRatio * usableBins);
        const b1 = Math.max(b0 + 1, Math.floor(endRatio * usableBins));
        let maxVal = 0;
        for (let b = b0; b < b1 && b < this.freqBuffer.length; b++) {
          if (this.freqBuffer[b] > maxVal) maxVal = this.freqBuffer[b];
        }
        bars[i] = maxVal / 255;
      }
      return bars;
    }

    /** Đọc năng lượng 3 dải (bass, mid, high trong [0, 1]) và phổ 48 cột từ nguồn đang phát */
    sampleAudioBands() {
      if (!this.ctx) {
        return { bass: 0, mid: 0, high: 0, spectrum: new Array(48).fill(0) };
      }

      const hasPlayingDeck = Boolean(
        this.activeDeck &&
        this.activeDeck.audio &&
        !this.activeDeck.audio.paused &&
        !this.activeDeck.audio.ended
      );
      const hasFadingDeck = Boolean(
        this.fadingDecks &&
        Array.from(this.fadingDecks).some((d) => d && d.audio && !d.audio.paused && !d.audio.ended)
      );
      const hasLiveVideo = this.isLiveVideoPlaying();
      const internalActive = (hasPlayingDeck || hasFadingDeck || hasLiveVideo) && this.analyser && this.freqBuffer;
      const externalActive = !internalActive && Boolean(this.extActive && this.extAnalyser && this.extFreqBuffer);

      let freqBuffer = null;
      let fftSize = 2048;
      let spectrum = null;

      if (internalActive) {
        spectrum = this.sampleSpectrum();
        freqBuffer = this.freqBuffer;
        fftSize = this.analyser.fftSize || 2048;
      } else if (externalActive) {
        const ext = this.sampleExternalSpectrum();
        spectrum = ext && Array.isArray(ext.bars) ? ext.bars : new Array(48).fill(0);
        freqBuffer = this.extFreqBuffer;
        fftSize = this.extAnalyser.fftSize || 2048;
      } else {
        return { bass: 0, mid: 0, high: 0, spectrum: new Array(48).fill(0) };
      }

      const sampleRate = this.ctx.sampleRate || 48000;
      const activeLogic = root.EventRunnerLogic || logic;
      const rawBands = (activeLogic && typeof activeLogic.computeThreeBandEnergy === 'function')
        ? activeLogic.computeThreeBandEnergy(freqBuffer, sampleRate, fftSize)
        : computeThreeBandEnergyFallback(freqBuffer, sampleRate, fftSize);

      const clamp01 = (v) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return 0;
        return n < 0 ? 0 : (n > 1 ? 1 : n);
      };

      return {
        bass: clamp01(rawBands && rawBands.bass),
        mid: clamp01(rawBands && rawBands.mid),
        high: clamp01(rawBands && rawBands.high),
        spectrum
      };
    }

    /** Giải mã waveform (cache tối đa 20 file) */
    async getWaveformPeaks(filePath, projectFilePath, numBins = 220) {
      if (!filePath) return null;
      const cacheKey = `${filePath}|${projectFilePath || ''}`;
      if (this.waveformCache.has(cacheKey)) {
        return this.waveformCache.get(cacheKey);
      }

      const res = await window.api.readMediaBuffer(filePath, projectFilePath);
      if (!res || !res.ok || !res.buffer) return null;

      this.ensureContext();
      try {
        const audioBuffer = await this.ctx.decodeAudioData(res.buffer.slice(0));
        const channel = audioBuffer.getChannelData(0);
        const step = Math.max(1, Math.floor(channel.length / numBins));
        const peaks = new Array(numBins);
        for (let i = 0; i < numBins; i++) {
          let peak = 0;
          const start = i * step;
          const end = Math.min(channel.length, start + step);
          for (let j = start; j < end; j += Math.max(1, Math.floor(step / 12))) {
            const v = Math.abs(channel[j]);
            if (v > peak) peak = v;
          }
          peaks[i] = peak;
        }

        const entry = { duration: audioBuffer.duration, peaks };
        while (this.waveformCache.size >= this.MAX_WAVEFORM_CACHE) {
          const oldest = this.waveformCache.keys().next().value;
          this.waveformCache.delete(oldest);
        }
        this.waveformCache.set(cacheKey, entry);
        return entry;
      } catch (_) {
        return null;
      }
    }
  }

  root.EventRunnerAudioEngine = AudioEngine;
})(typeof window !== 'undefined' ? window : globalThis);
