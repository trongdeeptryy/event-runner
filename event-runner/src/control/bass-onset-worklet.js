/**
 * AudioWorkletProcessor tĩnh cho bộ dò Bass Onset (tuân thủ CSP script-src 'self').
 */
'use strict';

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

  var energySmoothLen = 6;
  var blockMeanSqBuf = new Float64Array(energySmoothLen);
  var blockMeanSqIdx = 0;
  var blockCount = 0;

  var rmsHistLen = lookbackBlocks + 2;
  var rmsHist = new Float64Array(rmsHistLen);
  var rmsHistIdx = 0;

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

    var oNow = Math.log(1 + 200 * rmsNow) - Math.log(1 + 200 * rmsPrev);
    if (oNow < 0) oNow = 0;

    oRing[oRingIdx] = oNow;
    oRingIdx = (oRingIdx + 1) % winLen;
    if (oRingCount < winLen) oRingCount++;

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
