/**
 * Controller chính của Bảng điều khiển EVENT RUNNER v3.0 PRO (Giao diện 3 Cột)
 * Tích hợp đồng bộ:
 * - Kịch bản Cue v2.4 (kéo thả batch, Undo/Redo, sóng âm, Beat FX DSP, Idle Shake, SFX F1-F6)
 * - Resolume 3-Layer VJ Deck (3 Deck A/B/C × 3 Layer × 4 Slots, Generator & Camera Input)
 * - vMix Switcher Strip (T-Bar thủ công, Cut/Fade/Wipe/FTB, 4 Overlays + Stage Display FreeShow)
 * - Beat-Synced LED Strobe & DMX Art-Net/sACN + OSC UDP + MIDI Clock & Faders
 */
'use strict';

(function () {
  const logic = window.EventRunnerLogic;
  const audioEngine = new window.EventRunnerAudioEngine();

  window.addEventListener('error', (ev) => {
    window.api.reportRendererError({ where: 'control', message: ev.message });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    window.api.reportRendererError({ where: 'control:promise', message: String(ev.reason) });
  });
  window.addEventListener('beforeunload', () => {
    audioEngine.disposeBassBranch();
  });

  const MIDI_ACTION_KEYS = [
    'go', 'blackout', 'stopAll', 'fadeMusic', 'tapBpm', 'strobeHold', 'flashHit',
    'ov1', 'ov2', 'ov3', 'ov4', 'col1', 'col2', 'col3', 'col4',
    'tbar', 'masterDimmer', 'strobeIntensity'
  ];

  const GENERATOR_TITLES = {
    'spectrum-bars': 'Cột phổ nhạc (Spectrum Bars)',
    'laser-beams': 'Chùm tia Laser (Laser Beams)',
    'strobe-matrix': 'Ma trận LED (Strobe Matrix)',
    'pulse-rings': 'Vòng xung (Pulse Rings)',
    'cyber-grid': 'Lưới Cyber (Cyber Grid)',
    'plasma-wave': 'Sóng Plasma (Plasma Wave)'
  };

  function createEmptyProject() {
    return {
      version: 2,
      cues: [],
      sfxPads: logic.createDefaultSfxPads(),
      customFxPresets: {},
      overlays: logic.createDefaultOverlays(),
      vjDeck: logic.createDefaultVjDeck(),
      masterFx: logic.createDefaultMasterFx(),
      outputMapping: logic.createDefaultOutputMapping(),
      dmxConfig: logic.createDefaultDmxConfig(),
      oscConfig: logic.createDefaultOscConfig()
    };
  }

  // Trạng thái toàn cục
  const state = {
    project: createEmptyProject(),
    projectFilePath: null,
    selectedIndex: -1,
    liveCueId: null,
    liveCueSnapshot: null,
    liveStartedAtMs: 0,
    operatingMode: 'edit', // 'edit' | 'rehearsal' | 'show'
    showMode: false,
    rehearsalMode: false,
    blackout: false,
    testPattern: false,
    testBeatOn: false,
    testIdleOn: false,
    ledStatus: { isOpen: false, mode: 'closed' },
    stageStatus: { isOpen: false, mode: 'closed' },
    displays: [],
    videoDevices: [],
    settings: {},
    fileExistsMap: {},
    codecErrorMap: {},
    autoFollowTimer: null,
    autoFollowEndTime: 0,
    isSeekingAudio: false,
    isCommittingTbar: false,
    tapTimestamps: [],
    activeTrackPeaks: null,
    sfxVuLevel: 0,
    masterBpm: 120,
    autoBpmEnabled: false,
    beatTimesForAutoBpm: [],
    lastAudioBands: { bass: 0, mid: 0, high: 0, spectrum: [] },
    ledVideoTelemetry: {
      playing: false,
      updatedAtMs: 0,
      bass: 0,
      mid: 0,
      high: 0,
      env: 0,
      spectrum: new Array(48).fill(0)
    },
    localVideoEnv: 0,
    lastAudioBandsSentMs: 0,
    lastDmxSentMs: 0,
    lastStageSentMs: 0,
    lastLedBeatHitMs: 0,
    lastBandPeakMs: 0,
    lastStageSig: '',
    beatPulseLevel: 0,
    lastBeatState: { phase: 0, beatInBar: 0, beatIndex: 0 }
  };

  // Undo / Redo stack
  const undoStack = [];
  const redoStack = [];
  const MAX_UNDO = 50;
  let autosaveTimer = null;

  // Bộ theo dõi nhịp BPM + bộ thử BPM + MasterBeatClock
  const bpmBeatTracker = new logic.BpmBeatTracker(0.04);
  const testBeatTracker = new logic.BpmBeatTracker(0.04);
  const masterBeatClock = new logic.MasterBeatClock(120, 1);
  let testBeatStartMs = 0;
  let lampTimeout = null;
  let lastAnimMs = performance.now();

  // Dữ liệu biểu đồ phân tích bass 4 giây gần nhất & tính beat/giây
  const bassChartPoints = [];
  const bassChartBeats = [];
  const beatRateTimestamps = [];

  let appInputMapper = null;
  const sfxBurstTimers = new Map();

  // Các UI Controller con (v3.0 Pro)
  let vjDeckUi = null;
  let overlaysUi = null;
  let ledDmxUi = null;

  const thumbImageCache = new Map();
  const MAX_THUMB_CACHE = 80;
  let selectionCommitTimer = null;
  let preloadDebounceTimer = null;
  let waveformToken = 0;
  let hadPlayingWave = false;
  let lastVideoStatusUiMs = 0;

  // Vật lý Beat FX nhẹ cho màn hình Live Preview (chế độ 1 màn hình / Tập dượt)
  const previewBeatPhys = {
    x: 0, vx: 0, y: 0, vy: 0,
    rot: 0, vRot: 0, scale: 0, vScale: 0,
    bright: 0, vBright: 0, hue: 0, vHue: 0,
    flash: 0, vFlash: 0,
    omega: 18, zeta: 1.04,
    motion: 'smooth', shakeUnit: 8,
    lastBeatAngle: NaN, lastBeatTimeMs: 0, rotSign: 1,
    active: false
  };

  const thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const box = entry.target;
      thumbObserver.unobserve(box);
      const visPath = box.dataset.vis;
      if (!visPath || box.dataset.loaded === '1') continue;
      box.dataset.loaded = '1';
      renderThumbContent(box, visPath);
    }
  }, { rootMargin: '120px' });

  const $ = (id) => document.getElementById(id);

  function formatTimeHMS(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    return (
      String(hrs).padStart(2, '0') + ':' +
      String(mins).padStart(2, '0') + ':' +
      String(secs).padStart(2, '0')
    );
  }

  // =========================================================================
  // ĐỒNG HỒ MỨC ÂM THANH (VU METER) & 3-BAND METERS
  // =========================================================================

  function initVuMeters() {
    ['master-vu-meter', 'sfx-vu-meter', 'ext-opt-vu-meter', 'fx-ext-vu-meter', 'fx-video-vu-meter'].forEach((id) => {
      const container = $(id);
      if (!container) return;
      container.innerHTML = '';
      for (let i = 0; i < 12; i++) {
        const seg = document.createElement('span');
        seg.className = 'vu-seg';
        container.appendChild(seg);
      }
    });
  }

  function updateVuMeter(containerId, level0to1) {
    const container = $(containerId);
    if (!container) return;
    const segs = container.children;
    const activeCount = Math.round(logic.clamp(level0to1, 0, 1) * segs.length);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      seg.className = 'vu-seg';
      if (i < activeCount) {
        if (i >= 10) seg.classList.add('on-red');
        else if (i >= 8) seg.classList.add('on-yellow');
        else seg.classList.add('on-green');
      }
    }
  }

  function updateThreeBandMeters(bands) {
    const b = $('band-meter-bass');
    const m = $('band-meter-mid');
    const h = $('band-meter-high');
    if (b) b.style.width = `${Math.round(logic.clamp(bands.bass, 0, 1) * 100)}%`;
    if (m) m.style.width = `${Math.round(logic.clamp(bands.mid, 0, 1) * 100)}%`;
    if (h) h.style.width = `${Math.round(logic.clamp(bands.high, 0, 1) * 100)}%`;
  }

  // =========================================================================
  // KHÓA / MỞ KHÓA CÁC MỤC THEO NÚT GẠT ON/OFF & CHẾ ĐỘ VẬN HÀNH
  // =========================================================================

  function setSectionEnabled(containerId, enabled) {
    const box = $(containerId);
    if (!box) return;
    box.classList.toggle('is-section-disabled', !enabled);
    const controls = box.querySelectorAll('input, select, textarea, button');
    controls.forEach((el) => {
      if (!enabled) {
        el.disabled = true;
      } else if (
        state.showMode &&
        (el.classList.contains('edit-lockable') || el.classList.contains('edit-lockable-input'))
      ) {
        el.disabled = true;
      } else {
        el.disabled = false;
      }
    });
  }

  function syncAllToggleSections(cue) {
    setSectionEnabled('group-video-sound', Boolean(cue && cue.vsound !== false));
    setSectionEnabled('wrap-autodelay', Boolean(cue && cue.autoFollow === 'time'));
    setSectionEnabled('group-audio-track', Boolean(cue && cue.aud));
    setSectionEnabled('group-audio-fadeout', Boolean(cue && (cue.aud || !cue.keepAudio)));
    setSectionEnabled('group-beat-fx', Boolean(cue && cue.fx && cue.fx.on));
    setSectionEnabled('group-idle-fx', Boolean(cue && cue.fx && cue.fx.idleOn));
    setSectionEnabled('group-overscan-fx', Boolean(cue && cue.fx && (cue.fx.on || cue.fx.idleOn)));
    setSectionEnabled('group-text-fx', Boolean(cue && cue.text && cue.text.on));
    setSectionEnabled('group-ledsync-body', Boolean(
      (ledDmxUi && ledDmxUi.globalOverride && ledDmxUi.globalConfig.on) ||
      (cue && cue.ledSync && cue.ledSync.on)
    ));
    const remChk = $('remote-enable');
    if (remChk) setSectionEnabled('group-remote-pin', Boolean(remChk.checked));
    const extChk = $('ext-input-enable');
    if (extChk) setSectionEnabled('group-ext-options', Boolean(extChk.checked));
  }

  function setOperatingMode(mode) {
    const valid = ['edit', 'rehearsal', 'show'].includes(mode) ? mode : 'edit';
    const wasRehearsal = state.rehearsalMode;
    state.operatingMode = valid;
    state.showMode = valid === 'show';
    state.rehearsalMode = valid === 'rehearsal';

    document.querySelectorAll('.seg-pill').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === valid);
    });

    document.querySelectorAll('.edit-lockable').forEach((el) => {
      el.disabled = state.showMode;
    });
    document.querySelectorAll('.edit-lockable-input').forEach((el) => {
      el.disabled = state.showMode;
    });
    document.querySelectorAll('.edit-lockable-zone').forEach((el) => {
      el.classList.toggle('is-zone-locked', state.showMode);
    });

    $('lock-badge').classList.toggle('hidden', !state.showMode);
    audioEngine.setRehearsalMode(state.rehearsalMode);
    renderCueList();
    if (vjDeckUi) vjDeckUi.render();
    syncAllToggleSections(getSelectedCue());
    syncLivePreviewVideoAudio();
    syncAnalysisSourceRouting();

    if (!wasRehearsal && state.rehearsalMode && state.ledStatus.isOpen) {
      window.api.sendToLed({ type: 'video-audio', vsound: false, vvol: 0 });
    } else if (wasRehearsal && !state.rehearsalMode && state.ledStatus.isOpen) {
      const liveCue = getLiveCue();
      if (liveCue) {
        const { visUrl, visKind } = resolveCueVisualInfo(liveCue);
        window.api.sendToLed({
          type: 'show',
          cue: { ...JSON.parse(JSON.stringify(liveCue)), tr: 'cut', dur: 0 },
          url: visUrl,
          mediaKind: visKind,
          masterVol: Number($('master-vol').value),
          sinkId: state.settings.audioDeviceId || ''
        });
      }
    }

    if (state.rehearsalMode) {
      showBanner('Đang bật chế độ TẬP DƯỢT: chỉ phát xem trước trên máy, giảm âm còn 35%, không xuất ra màn LED.');
    } else {
      hideBanner();
    }
  }

  // =========================================================================
  // LƯU TỰ ĐỘNG, UNDO / REDO & KIỂM TRA FILE
  // =========================================================================

  function cloneProjectData() {
    return JSON.parse(JSON.stringify(state.project));
  }

  function ensureProjectV3Shape() {
    const migrated = logic.validateAndMigrateProject(state.project);
    if (migrated && migrated.project) {
      state.project = migrated.project;
    }
  }

  function pushUndoSnapshot() {
    undoStack.push(JSON.stringify({
      project: state.project,
      selectedIndex: state.selectedIndex
    }));
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
  }

  function performUndo() {
    if (state.showMode || undoStack.length === 0) return;
    redoStack.push(JSON.stringify({
      project: state.project,
      selectedIndex: state.selectedIndex
    }));
    const prev = JSON.parse(undoStack.pop());
    state.project = prev.project;
    ensureProjectV3Shape();
    state.selectedIndex = logic.clamp(prev.selectedIndex, -1, state.project.cues.length - 1);
    scheduleAutosave();
    refreshAllUi();
  }

  function performRedo() {
    if (state.showMode || redoStack.length === 0) return;
    undoStack.push(JSON.stringify({
      project: state.project,
      selectedIndex: state.selectedIndex
    }));
    const next = JSON.parse(redoStack.pop());
    state.project = next.project;
    ensureProjectV3Shape();
    state.selectedIndex = logic.clamp(next.selectedIndex, -1, state.project.cues.length - 1);
    scheduleAutosave();
    refreshAllUi();
  }

  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      window.api.saveAutosave({
        projectFilePath: state.projectFilePath,
        project: state.project
      });
    }, 350);
  }

  async function verifyAllMediaFiles() {
    const paths = new Set();
    for (const cue of state.project.cues) {
      if (cue.aud) paths.add(cue.aud);
      if (cue.vis && (!cue.sourceType || cue.sourceType === 'media')) paths.add(cue.vis);
    }
    for (const pad of state.project.sfxPads) {
      if (pad.path) paths.add(pad.path);
    }
    if (state.project.overlays && state.project.overlays.ov2 && state.project.overlays.ov2.path) {
      paths.add(state.project.overlays.ov2.path);
    }
    if (state.project.vjDeck && Array.isArray(state.project.vjDeck.decks)) {
      for (const deck of state.project.vjDeck.decks) {
        if (!Array.isArray(deck)) continue;
        for (const row of deck) {
          if (!Array.isArray(row)) continue;
          for (const clip of row) {
            if (clip && (clip.kind === 'image' || clip.kind === 'video') && clip.path) {
              paths.add(clip.path);
            }
          }
        }
      }
    }

    if (paths.size === 0) {
      state.fileExistsMap = {};
      return;
    }
    const res = await window.api.checkFilesExist(Array.from(paths), state.projectFilePath);
    state.fileExistsMap = res || {};
    renderCueList();
  }

  function showBanner(text) {
    const banner = $('alert-banner');
    $('alert-banner-text').textContent = text;
    banner.classList.remove('hidden');
    document.body.classList.add('has-banner');
  }

  function hideBanner() {
    $('alert-banner').classList.add('hidden');
    document.body.classList.remove('has-banner');
  }

  // =========================================================================
  // MASTER BPM CLOCK & STAGE DISPLAY / REMOTE ORCHESTRATION
  // =========================================================================

  function setMasterBpm(nextBpm, resetClockPhase) {
    const clamped = Math.round(logic.clamp(nextBpm, 40, 240));
    state.masterBpm = clamped;
    masterBeatClock.setBpm(clamped);
    if (resetClockPhase) {
      masterBeatClock.resync(performance.now());
    }
    if (ledDmxUi) ledDmxUi.updateBpmPillText(clamped);
    pushStageUpdate(true);
    syncRemoteState();
  }

  function handleTapBpm() {
    const now = performance.now();
    const prev = state.tapTimestamps.length > 0 ? state.tapTimestamps[state.tapTimestamps.length - 1] : 0;
    if (now - prev > 2000) {
      state.tapTimestamps = [];
      masterBeatClock.resync(now);
    }
    state.tapTimestamps.push(now);
    if (state.tapTimestamps.length > 10) state.tapTimestamps.shift();

    const bpm = logic.calculateTapBpm(state.tapTimestamps);
    if (bpm !== null) {
      setMasterBpm(bpm, false);
      const selCue = getSelectedCue();
      if (selCue && selCue.fx) {
        selCue.fx.bpm = bpm;
        if ($('fx-bpm')) $('fx-bpm').value = bpm;
        scheduleAutosave();
        sendLiveCueFxIfActive(selCue);
      }
    }
  }

  function buildStagePayload() {
    const live = getLiveCue();
    const next = getSelectedCue();
    const track = audioEngine.getCurrentTrackInfo();
    const td = overlaysUi ? overlaysUi.getTimerDisplay() : { text: '--:--', urgent: false, label: 'ĐỒNG HỒ SỰ KIỆN' };

    let cueRemainingText = '';
    if (track.playing && track.duration > 0) {
      cueRemainingText = `${logic.formatTime(track.currentTime)} / ${logic.formatTime(track.duration)}`;
    } else if (state.liveCueId && state.liveStartedAtMs > 0) {
      cueRemainingText = formatTimeHMS((performance.now() - state.liveStartedAtMs) / 1000);
    }

    return {
      liveName: live ? live.name : 'Chưa phát',
      nextName: next ? next.name : 'Trống',
      stageNote: live ? (live.note || '') : (next ? (next.note || '') : ''),
      nextNote: next ? (next.note || '') : '',
      timerText: td.text,
      timerLabel: td.label,
      timerUrgent: Boolean(td.urgent),
      stageMessage: overlaysUi ? overlaysUi.stageMessage : '',
      cueRemainingText,
      blackout: state.blackout,
      bpm: state.masterBpm,
      beatPhase: state.lastBeatState.phase,
      beatInBar: state.lastBeatState.beatInBar,
      beatIndex: state.lastBeatState.beatIndex
    };
  }

  function pushStageUpdate(force) {
    const payload = buildStagePayload();
    const sig = `${payload.liveName}|${payload.nextName}|${payload.stageNote}|${payload.timerText}|${payload.timerUrgent}|${payload.stageMessage}|${payload.blackout}|${payload.bpm}|${payload.beatInBar}`;
    if (force || sig !== state.lastStageSig) {
      state.lastStageSig = sig;
      window.api.sendToStage(payload);
    }
  }

  function syncRemoteState() {
    const live = getLiveCue();
    const next = getSelectedCue();
    const ov = state.project.overlays || logic.createDefaultOverlays();
    const activeLs = ledDmxUi ? ledDmxUi.getActiveLedSync() : logic.createDefaultLedSync();
    const td = overlaysUi ? overlaysUi.getTimerDisplay() : { text: '--:--', urgent: false };

    window.api.broadcastRemoteState({
      liveName: live ? live.name : 'Chưa phát',
      nextName: next ? next.name : 'Trống',
      blackout: state.blackout,
      bpm: state.masterBpm,
      ledMode: activeLs.on ? (activeLs.mode || 'off') : 'off',
      overlays: {
        ov1: Boolean(ov.ov1 && ov.ov1.active),
        ov2: Boolean(ov.ov2 && ov.ov2.active),
        ov3: Boolean(ov.ov3 && ov.ov3.active),
        ov4: Boolean(ov.ov4 && ov.ov4.active)
      },
      sfxNames: (state.project.sfxPads || []).map((p) => p.name || 'SFX'),
      stageNote: live ? (live.note || '') : (next ? (next.note || '') : ''),
      timerText: td.text,
      timerUrgent: Boolean(td.urgent),
      stageMessage: overlaysUi ? overlaysUi.stageMessage : ''
    });
  }

  // =========================================================================
  // PHÁT CUE (GO) & ĐỒNG BỘ LED + NHẠC + T-BAR
  // =========================================================================

  function getSelectedCue() {
    if (state.selectedIndex < 0 || state.selectedIndex >= state.project.cues.length) return null;
    return state.project.cues[state.selectedIndex];
  }

  function getLiveCue() {
    if (!state.liveCueId) return null;
    return state.project.cues.find((c) => c.id === state.liveCueId) || state.liveCueSnapshot;
  }

  function resolveCueVisualInfo(cue) {
    if (!cue) return { visUrl: null, visKind: null };
    if (cue.sourceType === 'camera') return { visUrl: null, visKind: 'camera' };
    if (cue.sourceType === 'generator') return { visUrl: null, visKind: 'generator' };
    if (!cue.vis) return { visUrl: null, visKind: null };
    const visUrl = window.api.toFileUrl(cue.vis, state.projectFilePath);
    const visKind = logic.detectMediaKind(cue.vis) === 'image' ? 'image' : 'video';
    return { visUrl, visKind };
  }

  function preloadCue(cue) {
    if (!cue) return;
    const { visUrl, visKind } = resolveCueVisualInfo(cue);
    if (visUrl && (visKind === 'image' || visKind === 'video')) {
      if (!state.rehearsalMode) {
        window.api.sendToLed({ type: 'preload', url: visUrl, mediaKind: visKind });
      }
    }
    if (cue.aud) {
      const audUrl = window.api.toFileUrl(cue.aud, state.projectFilePath);
      audioEngine.preloadTrack(audUrl);
    }
  }

  function clearAutoFollow() {
    clearTimeout(state.autoFollowTimer);
    state.autoFollowTimer = null;
    state.autoFollowEndTime = 0;
  }

  function scheduleAutoFollow(cue) {
    clearAutoFollow();
    if (!cue || cue.autoFollow !== 'time') return;
    const delayMs = Math.max(200, (Number(cue.autoDelay) || 5) * 1000);
    state.autoFollowEndTime = Date.now() + delayMs;
    state.autoFollowTimer = setTimeout(() => {
      const liveIdx = state.project.cues.findIndex((c) => c.id === cue.id);
      const nextIdx = liveIdx >= 0 ? liveIdx + 1 : state.selectedIndex;
      if (nextIdx >= 0 && nextIdx < state.project.cues.length) {
        triggerCueAt(nextIdx, true);
      }
    }, delayMs);
  }

  function triggerCueAt(index, advanceSelection = true, opts = null) {
    if (index < 0 || index >= state.project.cues.length) return;
    clearTimeout(selectionCommitTimer);
    clearTimeout(preloadDebounceTimer);
    const cue = state.project.cues[index];
    const isRetriggerSameCue = state.liveCueId === cue.id;
    const cuePayload = JSON.parse(JSON.stringify(cue));
    if (opts && opts.overrideTr) cuePayload.tr = opts.overrideTr;
    if (opts && opts.overrideDur !== undefined) cuePayload.dur = opts.overrideDur;

    const { visUrl, visKind } = resolveCueVisualInfo(cue);
    const audUrl = cue.aud ? window.api.toFileUrl(cue.aud, state.projectFilePath) : null;

    if (!state.rehearsalMode) {
      window.api.sendToLed({
        type: 'show',
        cue: cuePayload,
        url: visUrl,
        mediaKind: visKind,
        masterVol: Number($('master-vol').value),
        sinkId: state.settings.audioDeviceId || ''
      });
    }

    audioEngine.playCue(cue, audUrl);
    if (cue.aud) {
      audioEngine.getWaveformPeaks(cue.aud, state.projectFilePath, 96).then((res) => {
        if (res && res.peaks) state.activeTrackPeaks = res.peaks;
      });
    } else if (!cue.keepAudio) {
      state.activeTrackPeaks = null;
    }

    state.liveCueId = cue.id;
    state.liveCueSnapshot = JSON.parse(JSON.stringify(cue));
    state.liveStartedAtMs = performance.now();
    state.ledVideoTelemetry.playing = false;
    bpmBeatTracker.reset();
    window.api.setShowRunningState(true);

    if (cue.fx && cue.fx.on && cue.fx.src === 'ext' && !audioEngine.isExternalInputActive()) {
      enableExternalMixerInput(true);
    } else {
      syncAnalysisSourceRouting();
    }

    if (ledDmxUi) {
      ledDmxUi.renderQuickDeck();
      ledDmxUi.sendLedSyncToOutput();
    }

    window.api.appendShowLog(
      `GO #${index + 1}: ${cue.name}${cue.aud ? ' | ♪ ' + window.api.baseName(cue.aud) : ''}${cue.vis ? ' | ▣ ' + window.api.baseName(cue.vis) : ''}`
    );

    if (advanceSelection) {
      state.selectedIndex = index + 1 < state.project.cues.length ? index + 1 : index;
    }

    scheduleAutoFollow(cue);
    updateCueListSelection();
    renderMonitors();
    if (isRetriggerSameCue) {
      const localVid = getTopLivePreviewVideo();
      if (localVid) {
        try { localVid.currentTime = 0; } catch (_) {}
        localVid.play().catch(() => {});
      }
      syncLivePreviewVideoAudio();
    }
    renderEditor();

    const nextCue = getSelectedCue();
    if (nextCue && nextCue.id !== cue.id) {
      preloadCue(nextCue);
    }
    pushStageUpdate(true);
    syncRemoteState();
  }

  function handleGo() {
    if (state.project.cues.length === 0) return;
    const idx = state.selectedIndex >= 0 ? state.selectedIndex : 0;
    triggerCueAt(idx, true);
  }

  function triggerSelectedWithTransition(tr, dur) {
    if (state.project.cues.length === 0) return;
    const idx = state.selectedIndex >= 0 ? state.selectedIndex : 0;
    const cue = state.project.cues[idx];
    const effDur = dur !== undefined ? dur : Math.max(0.5, Number(cue && cue.dur) || 0.8);
    triggerCueAt(idx, true, { overrideTr: tr, overrideDur: effDur });
  }

  function handleTbarInput(rawVal0to100) {
    const val = logic.clamp(rawVal0to100, 0, 100);
    const slider = $('tbar-slider');
    const pct = $('tbar-pct');
    if (slider) slider.value = String(Math.round(val));
    if (pct) pct.textContent = `${Math.round(val)}%`;

    const nextCue = getSelectedCue();
    if (!nextCue) return;

    if (val >= 99.5) {
      if (state.isCommittingTbar) return;
      state.isCommittingTbar = true;
      const idx = state.selectedIndex >= 0 ? state.selectedIndex : 0;
      triggerCueAt(idx, true, { overrideTr: 'cut', overrideDur: 0 });
      if (slider) slider.value = '0';
      if (pct) pct.textContent = '0%';
      setTimeout(() => { state.isCommittingTbar = false; }, 120);
      return;
    }

    const { visUrl, visKind } = resolveCueVisualInfo(nextCue);
    const tr = nextCue.tr === 'cut' ? 'fade' : (nextCue.tr || 'fade');
    if (!state.rehearsalMode) {
      window.api.sendToLed({
        type: 'tbar',
        progress: val / 100,
        previewCue: JSON.parse(JSON.stringify(nextCue)),
        previewUrl: visUrl,
        previewKind: visKind,
        tr
      });
    }
  }

  function renderMonitorHeadersOnly() {
    const liveCue = getLiveCue();
    const nextCue = getSelectedCue();

    $('live-cue-title').textContent = liveCue ? liveCue.name : 'Chưa phát';
    $('next-cue-title').textContent = nextCue ? nextCue.name : 'Chưa chọn';
    $('go-next-hint').textContent = nextCue
      ? `Phím Space — Chạy Cue ${state.selectedIndex + 1}: ${nextCue.name}`
      : 'Phím Space — Chưa có Cue';

    let followTxt = '';
    if (nextCue && nextCue.autoFollow === 'time') followTxt = `Tự chuyển sau ${nextCue.autoDelay}s`;
    else if (nextCue && nextCue.autoFollow === 'audio-end') followTxt = 'Tự chuyển khi hết nhạc';
    $('auto-follow-badge').textContent = followTxt;
  }

  function showLightweightKeyboardNextPreview(selCue) {
    const nextBox = $('next-preview-box');
    if (!nextBox) return;
    if (!selCue) {
      renderPreviewBox(nextBox, null, 'Chọn một Cue bên trái', true, false);
      return;
    }
    const srcType = selCue.sourceType || 'media';
    if (srcType === 'media' && selCue.vis && logic.detectMediaKind(selCue.vis) === 'video') {
      const cacheKey = `${selCue.vis}|${state.projectFilePath || ''}`;
      const cachedThumb = thumbImageCache.get(cacheKey);
      nextBox._renderedKey = '';
      const layer = document.createElement('div');
      layer.className = 'preview-layer';
      if (cachedThumb) {
        const bg = document.createElement('img');
        bg.className = 'preview-backdrop';
        bg.src = cachedThumb;
        const img = document.createElement('img');
        img.className = 'preview-fg';
        img.src = cachedThumb;
        img.style.objectFit = selCue.fit === 'cover' ? 'cover' : 'contain';
        layer.appendChild(bg);
        layer.appendChild(img);
      } else {
        const empty = document.createElement('div');
        empty.className = 'preview-empty';
        empty.textContent = `🎬 ${window.api.baseName(selCue.vis)}`;
        layer.appendChild(empty);
      }
      const oldLayers = Array.from(nextBox.querySelectorAll('.preview-layer'));
      oldLayers.forEach((old) => {
        const oldVid = old.querySelector('video');
        if (oldVid) {
          try { oldVid.pause(); oldVid.removeAttribute('src'); } catch (_) {}
          setTimeout(() => { try { oldVid.load(); } catch (_) {} }, 0);
        }
      });
      nextBox.innerHTML = '';
      nextBox.appendChild(layer);
      return;
    }
    renderPreviewBox(nextBox, selCue, 'Chọn một Cue bên trái', true, false);
  }

  function handleSelectDelta(delta) {
    const len = state.project.cues.length;
    if (len === 0) return;
    const cur = state.selectedIndex >= 0 ? state.selectedIndex : 0;
    const nextIdx = logic.clamp(cur + delta, 0, len - 1);
    if (nextIdx === state.selectedIndex) return;
    state.selectedIndex = nextIdx;
    onSelectionChanged({ fromKeyboard: true });
  }

  function onSelectionChanged(opts) {
    const isKeyboard = Boolean(opts && opts.fromKeyboard);
    const isSelectionOnly = isKeyboard || Boolean(opts && opts.selectionOnly);

    if (isSelectionOnly) {
      updateCueListSelection();
    } else {
      renderCueList();
      const listEl = $('cue-list');
      const activeRow = listEl ? listEl.querySelector('.cue-card.is-selected') : null;
      if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
    }
    renderMonitorHeadersOnly();

    clearTimeout(selectionCommitTimer);
    clearTimeout(preloadDebounceTimer);

    const commitSelectionHeavy = () => {
      renderMonitors();
      renderEditor();
      pushStageUpdate(true);
      syncRemoteState();
      preloadDebounceTimer = setTimeout(() => {
        const sel = getSelectedCue();
        if (sel) preloadCue(sel);
      }, 90);
    };

    if (isKeyboard) {
      showLightweightKeyboardNextPreview(getSelectedCue());
      selectionCommitTimer = setTimeout(commitSelectionHeavy, 110);
    } else {
      renderMonitors();
      renderEditor();
      preloadDebounceTimer = setTimeout(() => {
        const sel = getSelectedCue();
        if (sel) preloadCue(sel);
        pushStageUpdate(true);
        syncRemoteState();
      }, 80);
    }
  }

  function toggleBlackout(explicitState) {
    state.blackout = explicitState !== undefined ? Boolean(explicitState) : !state.blackout;
    $('btn-blackout').classList.toggle('active', state.blackout);
    if ($('btn-sw-ftb')) $('btn-sw-ftb').classList.toggle('active', state.blackout);
    if (!state.rehearsalMode) {
      window.api.sendToLed({ type: 'blackout', on: state.blackout });
    }
    window.api.appendShowLog(state.blackout ? 'PANIC: ĐEN MÀN (Bật)' : 'PANIC: ĐEN MÀN (Tắt)');
    pushStageUpdate(true);
    syncRemoteState();
  }

  function fadeOutMusicPanic() {
    audioEngine.fadeOutCurrent(2.0);
    if (!state.rehearsalMode) {
      window.api.sendToLed({ type: 'fade-video-audio', durationSec: 2.0 });
    }
    const localVid = getTopLivePreviewVideo();
    if (localVid) {
      audioEngine.syncLiveVideoElement(localVid, false, 0, false, 0);
      localVid.muted = true;
    }
    window.api.appendShowLog('PANIC: TẮT NHẠC DẦN (2s)');
  }

  function stopAllPanic() {
    clearAutoFollow();
    audioEngine.stopAll(0.3);
    state.activeTrackPeaks = null;
    state.blackout = false;
    $('btn-blackout').classList.remove('active');
    if ($('btn-sw-ftb')) $('btn-sw-ftb').classList.remove('active');
    if ($('tbar-slider')) $('tbar-slider').value = '0';
    if ($('tbar-pct')) $('tbar-pct').textContent = '0%';

    if (ledDmxUi) ledDmxUi.releaseAllMomentary();
    if (vjDeckUi) {
      const deckState = vjDeckUi.getDeckState();
      deckState.layers.forEach((l) => { l.activeClipId = null; });
      vjDeckUi.render();
    }

    if (!state.rehearsalMode) {
      window.api.sendToLed({ type: 'clear' });
    }
    state.liveCueId = null;
    state.liveCueSnapshot = null;
    state.liveStartedAtMs = 0;
    state.ledVideoTelemetry.playing = false;
    state.ledVideoTelemetry.env = 0;
    state.localVideoEnv = 0;
    previewBeatPhys.active = false;
    syncAnalysisSourceRouting();
    window.api.setShowRunningState(false);
    updateCueListSelection();
    renderMonitors();
    window.api.appendShowLog('PANIC: DỪNG TẤT CẢ (Esc)');
    pushStageUpdate(true);
    syncRemoteState();
  }

  function toggleTestPattern() {
    state.testPattern = !state.testPattern;
    $('btn-test-pattern').classList.toggle('active', state.testPattern);
    window.api.sendToLed({ type: 'test-pattern', on: state.testPattern });
  }

  // =========================================================================
  // KÉO THẢ & NHẬP TỆP MEDIA (ẢNH / VIDEO / NHẠC) TỪ MÁY TÍNH
  // =========================================================================

  function isExternalFileDrag(ev) {
    if (!ev || !ev.dataTransfer) return false;
    const types = Array.from(ev.dataTransfer.types || []);
    return types.includes('Files');
  }

  function extractDroppedFilePaths(ev) {
    if (!ev || !ev.dataTransfer || !ev.dataTransfer.files) return [];
    const out = [];
    const files = Array.from(ev.dataTransfer.files);
    for (const f of files) {
      const p = window.api.getDroppedFilePath(f);
      if (p) out.push(p);
    }
    return out;
  }

  function clearCuePanelDragVisuals() {
    const panel = $('cue-panel');
    if (panel) panel.classList.remove('is-file-dragover');
    document.querySelectorAll('.cue-card.is-file-target').forEach((el) => el.classList.remove('is-file-target'));
    document.querySelectorAll('.cue-dropzone-card.is-dragover').forEach((el) => el.classList.remove('is-dragover'));
  }

  function isUntouchedBlankCue(cue) {
    return Boolean(
      cue &&
      (!cue.sourceType || cue.sourceType === 'media') &&
      !cue.vis &&
      !cue.aud &&
      (!cue.note || !cue.note.trim())
    );
  }

  function isGenericCueName(name) {
    return !name || /^Cue(\s+\d+|\s+mới|\s+chưa\s+đặt\s+tên)?$/i.test(name.trim());
  }

  async function importMediaFilesIntoCueList(filePaths, opts) {
    const options = opts || {};
    if (state.showMode) {
      showBanner('Đang khóa kịch bản ở CHẾ ĐỘ SHOW — hãy chuyển sang BIÊN TẬP để kéo thả hoặc nhập tệp.');
      return;
    }

    const { cues: builtCues, ignoredPaths } = logic.buildCuesFromMediaPaths(
      filePaths,
      (p) => window.api.fileStem(p)
    );

    if (builtCues.length === 0) {
      showBanner('Không nhận diện được tệp hợp lệ. Hãy thả tệp Ảnh (JPG, PNG...), Video (MP4, WEBM...) hoặc Nhạc (MP3, WAV, M4A...).');
      return;
    }

    pushUndoSnapshot();

    let firstSelectedIdx = 0;
    const targetIdx = typeof options.targetCueIndex === 'number' ? options.targetCueIndex : -1;
    const targetCue = targetIdx >= 0 ? state.project.cues[targetIdx] : null;

    if (targetCue && isUntouchedBlankCue(targetCue)) {
      if (
        builtCues.length === 2 &&
        ((builtCues[0].vis && builtCues[1].aud) || (builtCues[0].aud && builtCues[1].vis))
      ) {
        const visCue = builtCues[0].vis ? builtCues[0] : builtCues[1];
        const audCue = builtCues[0].aud ? builtCues[0] : builtCues[1];
        targetCue.sourceType = 'media';
        targetCue.vis = visCue.vis;
        targetCue.vsound = visCue.vsound;
        targetCue.vvol = visCue.vvol;
        targetCue.aud = audCue.aud;
        if (isGenericCueName(targetCue.name)) targetCue.name = visCue.name;
        firstSelectedIdx = targetIdx;
      } else {
        const first = builtCues[0];
        if (first.vis) {
          targetCue.sourceType = 'media';
          targetCue.vis = first.vis;
          targetCue.vsound = first.vsound;
          targetCue.vvol = first.vvol;
        }
        if (first.aud) {
          targetCue.aud = first.aud;
          targetCue.startAt = 0;
          targetCue.endAt = 0;
        }
        if (isGenericCueName(targetCue.name)) targetCue.name = first.name;
        if (builtCues.length > 1) {
          state.project.cues.splice(targetIdx + 1, 0, ...builtCues.slice(1));
        }
        firstSelectedIdx = targetIdx;
      }
    } else if (state.project.cues.length === 1 && isUntouchedBlankCue(state.project.cues[0])) {
      state.project.cues.splice(0, 1, ...builtCues);
      firstSelectedIdx = 0;
    } else {
      const insertAt = typeof options.insertAt === 'number'
        ? logic.clamp(options.insertAt, 0, state.project.cues.length)
        : (state.selectedIndex >= 0 ? state.selectedIndex + 1 : state.project.cues.length);
      state.project.cues.splice(insertAt, 0, ...builtCues);
      firstSelectedIdx = insertAt;
    }

    state.selectedIndex = logic.clamp(firstSelectedIdx, 0, state.project.cues.length - 1);
    scheduleAutosave();
    await verifyAllMediaFiles();
    onSelectionChanged();

    const skippedNote = ignoredPaths.length > 0 ? ` (đã bỏ qua ${ignoredPaths.length} tệp không hỗ trợ)` : '';
    if (builtCues.length === 1) {
      showBanner(`Đã nhập "${window.api.baseName(filePaths[0])}" vào Danh sách Cue!${skippedNote}`);
    } else {
      showBanner(`Đã tự động nhập ${builtCues.length} tệp thành Cue!${skippedNote}`);
    }
  }

  async function pickAndImportBatchFiles() {
    if (state.showMode) return;
    const files = await window.api.pickBatchVisuals();
    if (!files || files.length === 0) return;
    await importMediaFilesIntoCueList(files);
  }

  function ensureEditableSelectedCue(defaultStemPath) {
    let cue = getSelectedCue();
    if (!cue) {
      const stem = defaultStemPath ? window.api.fileStem(defaultStemPath) : `Cue ${state.project.cues.length + 1}`;
      cue = logic.createDefaultCue({ name: stem || 'Cue 1' });
      state.project.cues.push(cue);
      state.selectedIndex = state.project.cues.length - 1;
    }
    return cue;
  }

  function activateInspectorTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tabId);
    });
    document.querySelectorAll('.tab-pane').forEach((p) => {
      p.classList.toggle('active', p.id === tabId);
    });
    if (tabId === 'tab-audio') {
      renderWaveformForCue(getSelectedCue());
    }
  }

  async function assignVisualFileToSelectedCue(filePath, viaDrop) {
    if (state.showMode) {
      showBanner('Đang ở CHẾ ĐỘ SHOW (khóa kịch bản) — hãy chuyển sang BIÊN TẬP để đổi hình/video.');
      return;
    }
    const kind = logic.detectMediaKind(filePath);
    if (kind === 'audio') {
      await assignAudioFileToSelectedCue(filePath, true);
      activateInspectorTab('tab-audio');
      return;
    }
    if (kind !== 'image' && kind !== 'video') {
      showBanner('Tệp kéo thả không phải định dạng Ảnh hoặc Video hỗ trợ (MP4, WEBM, JPG, PNG, WEBP, GIF).');
      return;
    }

    pushUndoSnapshot();
    const cue = ensureEditableSelectedCue(filePath);
    const wasBlank = !cue.vis && !cue.aud;
    cue.sourceType = 'media';
    cue.vis = filePath;
    if (kind === 'video') {
      cue.vsound = true;
      cue.vvol = cue.vvol ?? 100;
    }
    if (wasBlank && isGenericCueName(cue.name)) {
      cue.name = window.api.fileStem(filePath) || cue.name;
    }

    scheduleAutosave();
    await verifyAllMediaFiles();
    renderCueList();
    renderEditor();
    renderMonitors();
    preloadCue(cue);
    if (viaDrop) {
      showBanner(`Đã gắn ${kind === 'video' ? 'video' : 'ảnh'} "${window.api.baseName(filePath)}" cho "${cue.name}".`);
    }
  }

  async function assignAudioFileToSelectedCue(filePath, viaDrop) {
    if (state.showMode) {
      showBanner('Đang ở CHẾ ĐỘ SHOW (khóa kịch bản) — hãy chuyển sang BIÊN TẬP để nhập nhạc.');
      return;
    }
    const kind = logic.detectMediaKind(filePath);
    if (kind === 'image' || kind === 'video') {
      await assignVisualFileToSelectedCue(filePath, true);
      activateInspectorTab('tab-general');
      return;
    }
    if (kind !== 'audio') {
      showBanner('Tệp âm thanh không hợp lệ — hãy chọn hoặc kéo thả file MP3, WAV, M4A, AAC, FLAC hoặc OGG.');
      return;
    }

    pushUndoSnapshot();
    const cue = ensureEditableSelectedCue(filePath);
    const wasBlank = !cue.vis && !cue.aud;
    cue.aud = filePath;
    cue.startAt = 0;
    cue.endAt = 0;
    if (wasBlank && isGenericCueName(cue.name)) {
      cue.name = window.api.fileStem(filePath) || cue.name;
    }

    scheduleAutosave();
    await verifyAllMediaFiles();
    renderCueList();
    renderEditor();
    renderMonitors();
    preloadCue(cue);
    if (viaDrop) {
      showBanner(`Đã gắn nhạc "${window.api.baseName(filePath)}" cho "${cue.name}".`);
    }
  }

  // =========================================================================
  // RENDER DANH SÁCH THẺ CUE (CỘT TRÁI)
  // =========================================================================

  function renderThumbContent(box, visPath) {
    const cacheKey = `${visPath}|${state.projectFilePath || ''}`;
    const cachedDataUrl = thumbImageCache.get(cacheKey);
    if (cachedDataUrl) {
      box.innerHTML = '';
      const img = document.createElement('img');
      img.decoding = 'async';
      img.src = cachedDataUrl;
      box.appendChild(img);
      return;
    }

    const url = window.api.toFileUrl(visPath, state.projectFilePath);
    const kind = logic.detectMediaKind(visPath);
    if (kind === 'image') {
      box.innerHTML = '';
      const img = document.createElement('img');
      img.decoding = 'async';
      img.loading = 'lazy';
      img.src = url;
      img.onerror = () => { box.textContent = '⚠'; };
      box.appendChild(img);
    } else if (kind === 'video') {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.playsInline = true;
      let captured = false;

      const cleanupVideo = () => {
        try {
          v.onloadeddata = null;
          v.onseeked = null;
          v.onerror = null;
          v.pause();
          v.removeAttribute('src');
          setTimeout(() => { try { v.load(); } catch (_) {} }, 0);
        } catch (_) {}
      };

      v.onloadeddata = () => {
        try {
          const seekT = (v.duration && Number.isFinite(v.duration)) ? Math.min(0.5, v.duration * 0.2) : 0.1;
          v.currentTime = seekT;
        } catch (_) {
          cleanupVideo();
        }
      };

      v.onseeked = () => {
        if (captured) return;
        captured = true;
        try {
          if (v.videoWidth > 0 && v.videoHeight > 0) {
            const canvas = document.createElement('canvas');
            canvas.width = 112;
            canvas.height = 72;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              const scale = Math.max(112 / v.videoWidth, 72 / v.videoHeight);
              const dw = v.videoWidth * scale;
              const dh = v.videoHeight * scale;
              ctx.drawImage(v, (112 - dw) / 2, (72 - dh) / 2, dw, dh);
              const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
              if (thumbImageCache.size >= MAX_THUMB_CACHE) {
                const oldestKey = thumbImageCache.keys().next().value;
                thumbImageCache.delete(oldestKey);
              }
              thumbImageCache.set(cacheKey, dataUrl);
              if (box.isConnected && box.dataset.vis === visPath) {
                box.innerHTML = '';
                const img = document.createElement('img');
                img.decoding = 'async';
                img.src = dataUrl;
                box.appendChild(img);
              }
            }
          }
        } catch (_) {
          // Bỏ qua nếu frame không đọc được
        } finally {
          cleanupVideo();
        }
      };

      v.onerror = () => {
        if (box.isConnected && box.dataset.vis === visPath) box.textContent = '⚠';
        cleanupVideo();
      };
      v.src = url;
    } else {
      box.innerHTML = '';
      box.textContent = '▣';
    }
  }

  function applyCueSearchFilter() {
    const input = $('cue-search-input');
    const clearBtn = $('btn-cue-search-clear');
    const listEl = $('cue-list');
    if (!listEl) return;
    const q = input ? input.value.trim().toLowerCase() : '';
    if (clearBtn) clearBtn.classList.toggle('hidden', !q);
    const cards = listEl.querySelectorAll('.cue-card');
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const matched = !q || (card.dataset.searchText || '').includes(q);
      card.classList.toggle('is-filtered-out', !matched);
    }
  }

  function setCueViewMode(mode) {
    const isGrid = mode === 'grid';
    const listEl = $('cue-list');
    const btnList = $('btn-cue-view-list');
    const btnGrid = $('btn-cue-view-grid');
    if (listEl) listEl.classList.toggle('is-grid-view', isGrid);
    if (btnList) btnList.classList.toggle('active', !isGrid);
    if (btnGrid) btnGrid.classList.toggle('active', isGrid);
    try {
      localStorage.setItem('er_cue_view', isGrid ? 'grid' : 'list');
    } catch (_) {}
  }

  function setDrawerCollapsed(collapsed) {
    const drawer = $('fs-drawer');
    const toggleBtn = $('btn-drawer-toggle');
    if (!drawer) return;
    drawer.classList.toggle('is-collapsed', Boolean(collapsed));
    if (toggleBtn) {
      toggleBtn.textContent = collapsed ? '▴ Mở rộng' : '▾ Thu gọn';
    }
    try {
      localStorage.setItem('er_drawer_collapsed', collapsed ? '1' : '0');
    } catch (_) {}
  }

  function activateDrawerTab(paneId, autoExpand = true) {
    document.querySelectorAll('.drawer-tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.drawerTab === paneId);
    });
    document.querySelectorAll('.drawer-pane').forEach((p) => {
      p.classList.toggle('active', p.id === paneId);
    });
    if (autoExpand) {
      setDrawerCollapsed(false);
    }
    try {
      localStorage.setItem('er_drawer_tab', paneId);
    } catch (_) {}
  }

  function initFreeShowDrawerAndResizers() {
    try {
      const rootStyle = document.documentElement.style;
      const savedLeft = Number(localStorage.getItem('er_fs_left_w'));
      const savedRight = Number(localStorage.getItem('er_fs_right_w'));
      const savedDrawerH = Number(localStorage.getItem('er_fs_drawer_h'));
      if (Number.isFinite(savedLeft) && savedLeft >= 220 && savedLeft <= 520) {
        rootStyle.setProperty('--fs-left-w', `${savedLeft}px`);
      }
      if (Number.isFinite(savedRight) && savedRight >= 270 && savedRight <= 520) {
        rootStyle.setProperty('--fs-right-w', `${savedRight}px`);
      }
      if (Number.isFinite(savedDrawerH) && savedDrawerH >= 130 && savedDrawerH <= 440) {
        rootStyle.setProperty('--fs-drawer-h', `${savedDrawerH}px`);
      }
      if (localStorage.getItem('er_cue_view') === 'grid') {
        setCueViewMode('grid');
      }
      const savedTab = localStorage.getItem('er_drawer_tab');
      if (savedTab && $(savedTab)) {
        activateDrawerTab(savedTab, false);
      }
      if (localStorage.getItem('er_drawer_collapsed') === '1') {
        setDrawerCollapsed(true);
      }
    } catch (_) {}

    const btnList = $('btn-cue-view-list');
    const btnGrid = $('btn-cue-view-grid');
    if (btnList) btnList.addEventListener('click', () => setCueViewMode('list'));
    if (btnGrid) btnGrid.addEventListener('click', () => setCueViewMode('grid'));

    const searchInput = $('cue-search-input');
    const searchClear = $('btn-cue-search-clear');
    if (searchInput) searchInput.addEventListener('input', applyCueSearchFilter);
    if (searchClear) {
      searchClear.addEventListener('click', () => {
        if (searchInput) searchInput.value = '';
        applyCueSearchFilter();
      });
    }

    document.querySelectorAll('.drawer-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        activateDrawerTab(btn.dataset.drawerTab, true);
      });
    });

    const drawerToggle = $('btn-drawer-toggle');
    if (drawerToggle) {
      drawerToggle.addEventListener('click', () => {
        const drawer = $('fs-drawer');
        if (drawer) setDrawerCollapsed(!drawer.classList.contains('is-collapsed'));
      });
    }

    document.querySelectorAll('.fs-col-resizer').forEach((resizer) => {
      resizer.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        const side = resizer.dataset.resize;
        const startX = ev.clientX;
        const leftEl = $('cue-panel');
        const rightEl = $('editor-panel');
        const startWidth = side === 'left'
          ? (leftEl ? leftEl.getBoundingClientRect().width : 280)
          : (rightEl ? rightEl.getBoundingClientRect().width : 335);

        resizer.classList.add('is-resizing');
        let lastVal = Math.round(startWidth);

        const onMove = (moveEv) => {
          const dx = moveEv.clientX - startX;
          if (side === 'left') {
            lastVal = Math.round(logic.clamp(startWidth + dx, 220, 520));
            document.documentElement.style.setProperty('--fs-left-w', `${lastVal}px`);
          } else {
            lastVal = Math.round(logic.clamp(startWidth - dx, 270, 520));
            document.documentElement.style.setProperty('--fs-right-w', `${lastVal}px`);
          }
        };

        const onUp = () => {
          resizer.classList.remove('is-resizing');
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          try {
            localStorage.setItem(side === 'left' ? 'er_fs_left_w' : 'er_fs_right_w', String(lastVal));
          } catch (_) {}
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
    });

    const drawerResizer = $('fs-drawer-resizer');
    if (drawerResizer) {
      drawerResizer.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        const drawer = $('fs-drawer');
        const body = $('fs-drawer-body');
        const wasCollapsed = drawer && drawer.classList.contains('is-collapsed');
        const startY = ev.clientY;
        const startH = wasCollapsed ? 180 : (body ? body.getBoundingClientRect().height : 205);
        drawerResizer.classList.add('is-resizing');
        let lastH = Math.round(startH);

        const onMove = (moveEv) => {
          const dy = startY - moveEv.clientY;
          const nextH = logic.clamp(startH + dy, 130, 440);
          lastH = Math.round(nextH);
          if (drawer && drawer.classList.contains('is-collapsed') && dy > 16) {
            setDrawerCollapsed(false);
          }
          document.documentElement.style.setProperty('--fs-drawer-h', `${lastH}px`);
        };

        const onUp = () => {
          drawerResizer.classList.remove('is-resizing');
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          try {
            localStorage.setItem('er_fs_drawer_h', String(lastH));
          } catch (_) {}
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
    }
  }

  function renderCueList() {
    const listEl = $('cue-list');
    thumbObserver.disconnect();
    listEl.innerHTML = '';
    const cues = state.project.cues;
    $('cue-count-label').textContent = `${cues.length} Cue`;
    $('project-name-label').textContent = state.projectFilePath
      ? window.api.baseName(state.projectFilePath)
      : 'Autosave';

    let dragSrcIndex = null;

    cues.forEach((cue, idx) => {
      const isLive = cue.id === state.liveCueId;
      const isSelected = idx === state.selectedIndex;

      let cueType = 'empty';
      let typeLabel = 'CUE';
      if (cue.sourceType === 'camera') {
        cueType = 'camera';
        typeLabel = 'CAM';
      } else if (cue.sourceType === 'generator') {
        cueType = 'generator';
        typeLabel = 'VJ';
      } else if (cue.vis) {
        const visKind = logic.detectMediaKind(cue.vis);
        cueType = visKind === 'image' ? 'image' : 'video';
        typeLabel = visKind === 'image' ? 'ẢNH' : 'VIDEO';
      } else if (cue.aud) {
        cueType = 'audio';
        typeLabel = 'NHẠC';
      }

      const card = document.createElement('div');
      card.className = 'cue-card' + (isLive ? ' is-live' : '') + (isSelected ? ' is-selected' : '');
      card.dataset.cueIndex = String(idx);
      card.dataset.cueId = cue.id;
      card.dataset.cueType = cueType;
      card.dataset.searchText = [
        cue.name || '',
        cue.vis ? window.api.baseName(cue.vis) : '',
        cue.aud ? window.api.baseName(cue.aud) : '',
        cue.note || '',
        typeLabel
      ].join(' ').toLowerCase();
      card.draggable = !state.showMode;
      card.title = 'Click đơn để chọn KẾ TIẾP • Nháy đúp để phát ngay Cue này';

      const typeBar = document.createElement('div');
      typeBar.className = 'cue-type-bar';
      const typeLeft = document.createElement('span');
      typeLeft.textContent = `#${idx + 1} · ${typeLabel}`;
      const typeRight = document.createElement('span');
      typeRight.className = 'cue-type-tr';
      typeRight.textContent = cue.tr || 'fade';
      typeBar.appendChild(typeLeft);
      typeBar.appendChild(typeRight);
      card.appendChild(typeBar);

      const mainRow = document.createElement('div');
      mainRow.className = 'cue-card-main';

      const thumbEl = document.createElement('div');
      thumbEl.className = 'cue-thumb';
      if (cue.sourceType === 'camera') {
        thumbEl.textContent = 'CAM';
      } else if (cue.sourceType === 'generator') {
        thumbEl.textContent = 'GEN';
      } else if (cue.vis) {
        thumbEl.dataset.vis = cue.vis;
        thumbEl.textContent = '...';
        thumbObserver.observe(thumbEl);
      } else if (cue.aud) {
        thumbEl.textContent = '♪';
      } else {
        thumbEl.textContent = `#${idx + 1}`;
      }

      const infoEl = document.createElement('div');
      infoEl.className = 'cue-card-info';

      const topRow = document.createElement('div');
      topRow.className = 'cue-card-top';

      const nameEl = document.createElement('span');
      nameEl.className = 'cue-name';
      nameEl.textContent = cue.name;
      topRow.appendChild(nameEl);

      if (isLive) {
        const badge = document.createElement('span');
        badge.className = 'cue-badge cue-badge-live';
        badge.textContent = 'LIVE';
        topRow.appendChild(badge);
      } else if (isSelected) {
        const badge = document.createElement('span');
        badge.className = 'cue-badge cue-badge-next';
        badge.textContent = 'KẾ TIẾP';
        topRow.appendChild(badge);
      }

      const subRow = document.createElement('div');
      subRow.className = 'cue-sub';
      const parts = [];
      if (cue.aud) parts.push(window.api.baseName(cue.aud));
      else if (cue.keepAudio) parts.push('Giữ nhạc cũ');
      if (cue.sourceType === 'camera') parts.push('Camera Live');
      else if (cue.sourceType === 'generator') parts.push(`VJ: ${cue.generator || 'laser-beams'}`);
      else if (cue.vis) parts.push(window.api.baseName(cue.vis));
      if (cue.fx && (cue.fx.on || cue.fx.idleOn)) parts.push('FX');
      if (cue.ledSync && cue.ledSync.on) parts.push('LED');
      subRow.textContent = parts.length > 0 ? parts.join(' • ') : 'Trống';

      const missingAud = cue.aud && state.fileExistsMap[cue.aud] === false;
      const missingVis = (!cue.sourceType || cue.sourceType === 'media') && cue.vis && state.fileExistsMap[cue.vis] === false;
      const visCodecErr = Boolean(cue.vis && state.codecErrorMap[cue.vis]);
      const audCodecErr = Boolean(cue.aud && state.codecErrorMap[cue.aud]);
      const codecErr = visCodecErr || audCodecErr;

      infoEl.appendChild(topRow);
      infoEl.appendChild(subRow);

      if (missingAud || missingVis || codecErr) {
        const warn = document.createElement('div');
        warn.className = 'cue-warn';
        const isImgErr = visCodecErr && logic.detectMediaKind(cue.vis) === 'image';
        warn.textContent = (missingAud || missingVis)
          ? '⚠ Mất tệp nguồn'
          : (isImgErr ? '⚠ Không đọc được tệp ảnh' : '⚠ Lỗi codec (cần MP4 H.264)');
        infoEl.appendChild(warn);
      } else if (cue.note && cue.note.trim()) {
        const noteEl = document.createElement('div');
        noteEl.className = 'cue-note-preview';
        noteEl.textContent = cue.note.trim();
        infoEl.appendChild(noteEl);
      }

      mainRow.appendChild(thumbEl);
      mainRow.appendChild(infoEl);
      card.appendChild(mainRow);

      if (cue.aud) {
        const strip = document.createElement('div');
        strip.className = 'cue-audio-strip';
        const lbl = document.createElement('div');
        lbl.className = 'cue-audio-label';
        lbl.textContent = `${cue.name} — ${window.api.baseName(cue.aud)}`;
        const wave = document.createElement('div');
        wave.className = 'cue-mini-wave';
        const fill = document.createElement('div');
        fill.className = 'cue-mini-wave-fill';
        fill.dataset.cueWave = cue.id;
        wave.appendChild(fill);
        strip.appendChild(lbl);
        strip.appendChild(wave);
        card.appendChild(strip);
      }

      card.addEventListener('click', () => {
        if (state.selectedIndex === idx) return;
        state.selectedIndex = idx;
        onSelectionChanged({ selectionOnly: true });
      });

      card.addEventListener('dblclick', () => {
        triggerCueAt(idx, true);
      });

      card.addEventListener('dragstart', (e) => {
        if (state.showMode) { e.preventDefault(); return; }
        dragSrcIndex = idx;
        e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => {
        dragSrcIndex = null;
      });
      card.addEventListener('dragover', (e) => {
        if (state.showMode) return;
        if (isExternalFileDrag(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          card.classList.add('is-file-target');
          return;
        }
        if (dragSrcIndex !== null) {
          e.preventDefault();
          card.classList.add('drag-over');
        }
      });
      card.addEventListener('dragleave', () => {
        card.classList.remove('drag-over', 'is-file-target');
      });
      card.addEventListener('drop', (e) => {
        card.classList.remove('drag-over', 'is-file-target');
        if (isExternalFileDrag(e)) {
          e.preventDefault();
          e.stopPropagation();
          clearCuePanelDragVisuals();
          const droppedPaths = extractDroppedFilePaths(e);
          if (droppedPaths.length > 0) {
            importMediaFilesIntoCueList(droppedPaths, {
              targetCueIndex: idx,
              insertAt: idx + 1
            });
          }
          return;
        }
        e.preventDefault();
        if (state.showMode || dragSrcIndex === null || dragSrcIndex === idx) return;
        pushUndoSnapshot();
        const [moved] = state.project.cues.splice(dragSrcIndex, 1);
        state.project.cues.splice(idx, 0, moved);
        state.selectedIndex = idx;
        dragSrcIndex = null;
        scheduleAutosave();
        renderCueList();
        renderMonitors();
        renderEditor();
      });

      listEl.appendChild(card);
    });

    if (!state.showMode) {
      const dzCard = document.createElement('div');
      dzCard.className = 'cue-dropzone-card';
      dzCard.title = 'Kéo thả file vào đây hoặc bấm để chọn tệp từ máy tính';
      const titleSpan = document.createElement('span');
      titleSpan.className = 'cue-dz-title';
      titleSpan.textContent = 'Kéo thả file';
      dzCard.appendChild(titleSpan);

      dzCard.addEventListener('click', pickAndImportBatchFiles);
      dzCard.addEventListener('dragover', (e) => {
        if (!isExternalFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        dzCard.classList.add('is-dragover');
      });
      dzCard.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && dzCard.contains(e.relatedTarget)) return;
        dzCard.classList.remove('is-dragover');
      });
      dzCard.addEventListener('drop', (e) => {
        if (!isExternalFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        clearCuePanelDragVisuals();
        const droppedPaths = extractDroppedFilePaths(e);
        if (droppedPaths.length > 0) {
          importMediaFilesIntoCueList(droppedPaths, { insertAt: state.project.cues.length });
        }
      });
      listEl.appendChild(dzCard);
    }

    applyCueSearchFilter();
  }

  function updateCueListSelection() {
    const listEl = $('cue-list');
    if (!listEl) return;
    const cards = listEl.querySelectorAll('.cue-card');
    if (cards.length !== state.project.cues.length) {
      renderCueList();
      const row = listEl.querySelector('.cue-card.is-selected');
      if (row) row.scrollIntoView({ block: 'nearest' });
      return;
    }

    let selectedCard = null;
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const cueId = card.dataset.cueId;
      const isLive = cueId === state.liveCueId;
      const isSelected = i === state.selectedIndex;

      card.classList.toggle('is-live', isLive);
      card.classList.toggle('is-selected', isSelected);
      if (isSelected) selectedCard = card;

      const topRow = card.querySelector('.cue-card-top');
      if (topRow) {
        const desired = isLive ? 'live' : (isSelected ? 'next' : 'none');
        const existingBadge = topRow.querySelector('.cue-badge');
        const current = existingBadge
          ? (existingBadge.classList.contains('cue-badge-live') ? 'live' : 'next')
          : 'none';
        if (current !== desired) {
          if (existingBadge) existingBadge.remove();
          if (desired === 'live') {
            const badge = document.createElement('span');
            badge.className = 'cue-badge cue-badge-live';
            badge.textContent = 'LIVE';
            topRow.appendChild(badge);
          } else if (desired === 'next') {
            const badge = document.createElement('span');
            badge.className = 'cue-badge cue-badge-next';
            badge.textContent = 'KẾ TIẾP';
            topRow.appendChild(badge);
          }
        }
      }
    }

    if (selectedCard && !selectedCard.classList.contains('is-filtered-out')) {
      const listRect = listEl.getBoundingClientRect();
      const cardRect = selectedCard.getBoundingClientRect();
      if (cardRect.top < listRect.top) {
        listEl.scrollTop -= (listRect.top - cardRect.top + 6);
      } else if (cardRect.bottom > listRect.bottom) {
        listEl.scrollTop += (cardRect.bottom - listRect.bottom + 6);
      }
    }
  }

  // =========================================================================
  // RENDER MÀN HÌNH XEM TRƯỚC & THUỘC TÍNH CUE
  // =========================================================================

  function getTopLivePreviewLayer() {
    const liveBox = $('live-preview-box');
    if (!liveBox) return null;
    const layers = liveBox.querySelectorAll('.preview-layer');
    return layers.length > 0 ? layers[layers.length - 1] : null;
  }

  function getTopLivePreviewVideo() {
    const topLayer = getTopLivePreviewLayer();
    return topLayer ? topLayer.querySelector('video') : null;
  }

  function stepPreviewSpring1D(pos, vel, omega, zeta, dt) {
    const acc = -omega * omega * pos - 2 * zeta * omega * vel;
    const nextVel = vel + acc * dt;
    const nextPos = pos + nextVel * dt;
    return [nextPos, nextVel];
  }

  function triggerPreviewBeatFx(k, fxOverride) {
    const fx = fxOverride ? logic.createDefaultFx(fxOverride) : null;
    if (!fx || !fx.on) return;

    const now = performance.now();
    const strength = logic.clamp(k ?? 0.8, 0.2, 1);
    previewBeatPhys.lastBeatAngle = logic.pickNextBeatAngle(previewBeatPhys.lastBeatAngle);
    previewBeatPhys.rotSign = -previewBeatPhys.rotSign;

    const elapsedSincePrev = previewBeatPhys.lastBeatTimeMs > 0 ? (now - previewBeatPhys.lastBeatTimeMs) : Infinity;
    previewBeatPhys.lastBeatTimeMs = now;
    const effDecayMs = logic.calculateEffectiveDecay(fx.decay, elapsedSincePrev);
    const decaySec = Math.max(0.09, effDecayMs / 1000);

    const motion = fx.motion || (fx.step ? 'step' : 'smooth');
    previewBeatPhys.motion = motion;
    previewBeatPhys.shakeUnit = (fx.shake || 8) * 0.35;

    if (motion === 'spring') {
      previewBeatPhys.zeta = 0.52;
      previewBeatPhys.omega = logic.clamp(5.4 / decaySec, 14, 52);
    } else {
      previewBeatPhys.zeta = 1.04;
      previewBeatPhys.omega = logic.clamp(4.4 / decaySec, 12, 46);
    }

    const velGain = previewBeatPhys.omega * (motion === 'spring' ? 1.92 : Math.E);
    const shakePx = (fx.shake || 0) * 0.35;
    const peakX = Math.cos(previewBeatPhys.lastBeatAngle) * shakePx * strength;
    const peakY = Math.sin(previewBeatPhys.lastBeatAngle) * shakePx * strength;
    const peakRot = previewBeatPhys.rotSign * (fx.rot || 0) * strength;
    const peakScale = ((fx.scale || 0) / 100) * strength;
    const peakBright = ((fx.bright || 0) / 100) * strength;
    const peakHue = previewBeatPhys.rotSign * (fx.hue || 0) * strength;
    const peakFlash = ((fx.flash || 0) / 100) * strength;

    previewBeatPhys.vx = previewBeatPhys.vx * 0.2 + (peakX - previewBeatPhys.x * 0.55) * velGain;
    previewBeatPhys.vy = previewBeatPhys.vy * 0.2 + (peakY - previewBeatPhys.y * 0.55) * velGain;
    previewBeatPhys.vRot = previewBeatPhys.vRot * 0.2 + (peakRot - previewBeatPhys.rot * 0.55) * velGain;
    previewBeatPhys.vScale = Math.max(0, previewBeatPhys.vScale * 0.25) + Math.max(0, peakScale - previewBeatPhys.scale * 0.5) * velGain;

    const lightGain = previewBeatPhys.omega * 1.25 * Math.E;
    previewBeatPhys.vBright = Math.max(0, peakBright - previewBeatPhys.bright * 0.5) * lightGain;
    previewBeatPhys.vHue = (peakHue - previewBeatPhys.hue * 0.5) * lightGain;
    if ((fx.flash || 0) > 0) {
      previewBeatPhys.vFlash = Math.max(0, peakFlash - previewBeatPhys.flash * 0.4) * lightGain * 1.15;
    }

    const maxShake = Math.max(3, shakePx * 1.18);
    previewBeatPhys.x = logic.clamp(previewBeatPhys.x, -maxShake, maxShake);
    previewBeatPhys.y = logic.clamp(previewBeatPhys.y, -maxShake, maxShake);
    previewBeatPhys.active = true;
  }

  function stepPreviewBeatFx(dtSec) {
    if (!previewBeatPhys.active) return;
    const liveBox = $('live-preview-box');
    const topLayer = getTopLivePreviewLayer();
    const targetEl = topLayer ? (topLayer.querySelector('.preview-fg') || topLayer.querySelector('.preview-virtual-card')) : null;
    if (!liveBox || !targetEl) {
      previewBeatPhys.active = false;
      return;
    }

    const subSteps = Math.max(1, Math.min(8, Math.ceil(dtSec / 0.004)));
    const subDt = dtSec / subSteps;
    const omega = previewBeatPhys.omega;
    const zeta = previewBeatPhys.zeta;
    const lightOmega = omega * 1.25;

    for (let s = 0; s < subSteps; s++) {
      [previewBeatPhys.x, previewBeatPhys.vx] = stepPreviewSpring1D(previewBeatPhys.x, previewBeatPhys.vx, omega, zeta, subDt);
      [previewBeatPhys.y, previewBeatPhys.vy] = stepPreviewSpring1D(previewBeatPhys.y, previewBeatPhys.vy, omega, zeta, subDt);
      [previewBeatPhys.rot, previewBeatPhys.vRot] = stepPreviewSpring1D(previewBeatPhys.rot, previewBeatPhys.vRot, omega, zeta, subDt);
      [previewBeatPhys.scale, previewBeatPhys.vScale] = stepPreviewSpring1D(previewBeatPhys.scale, previewBeatPhys.vScale, omega, zeta, subDt);
      [previewBeatPhys.bright, previewBeatPhys.vBright] = stepPreviewSpring1D(previewBeatPhys.bright, previewBeatPhys.vBright, lightOmega, 1.08, subDt);
      [previewBeatPhys.hue, previewBeatPhys.vHue] = stepPreviewSpring1D(previewBeatPhys.hue, previewBeatPhys.vHue, lightOmega, 1.08, subDt);
      [previewBeatPhys.flash, previewBeatPhys.vFlash] = stepPreviewSpring1D(previewBeatPhys.flash, previewBeatPhys.vFlash, lightOmega * 1.15, 1.12, subDt);
    }

    const isResting =
      Math.abs(previewBeatPhys.x) < 0.03 &&
      Math.abs(previewBeatPhys.y) < 0.03 &&
      Math.abs(previewBeatPhys.rot) < 0.008 &&
      Math.abs(previewBeatPhys.scale) < 0.0004 &&
      Math.abs(previewBeatPhys.bright) < 0.004 &&
      Math.abs(previewBeatPhys.hue) < 0.3 &&
      Math.abs(previewBeatPhys.flash) < 0.004;

    let flashEl = liveBox.querySelector('.preview-beat-flash');
    if (isResting) {
      targetEl.style.transform = '';
      targetEl.style.filter = '';
      if (flashEl) flashEl.style.opacity = '0';
      previewBeatPhys.active = false;
      return;
    }

    let drawX = previewBeatPhys.x;
    let drawY = previewBeatPhys.y;
    const drawRot = previewBeatPhys.rot;
    let drawScale = 1 + Math.max(-0.15, previewBeatPhys.scale);

    if (previewBeatPhys.motion === 'step') {
      const q = (val, unit) => (unit > 0 ? Math.round(val / unit) * unit : val);
      drawX = q(drawX, Math.max(1, previewBeatPhys.shakeUnit * 0.22));
      drawY = q(drawY, Math.max(1, previewBeatPhys.shakeUnit * 0.22));
      drawScale = 1 + q(previewBeatPhys.scale, 0.015);
    }

    targetEl.style.transform =
      `translate3d(${drawX.toFixed(2)}px, ${drawY.toFixed(2)}px, 0) ` +
      `rotate(${drawRot.toFixed(2)}deg) scale(${drawScale.toFixed(4)})`;

    const filters = [];
    if (Math.abs(previewBeatPhys.bright) > 0.005) {
      filters.push(`brightness(${Math.max(0.5, 1 + previewBeatPhys.bright).toFixed(3)})`);
    }
    if (Math.abs(previewBeatPhys.hue) > 0.5) {
      filters.push(`hue-rotate(${previewBeatPhys.hue.toFixed(1)}deg)`);
    }
    targetEl.style.filter = filters.length > 0 ? filters.join(' ') : '';

    if (previewBeatPhys.flash > 0.005) {
      if (!flashEl) {
        flashEl = document.createElement('div');
        flashEl.className = 'preview-beat-flash';
        liveBox.appendChild(flashEl);
      }
      flashEl.style.opacity = logic.clamp(previewBeatPhys.flash, 0, 0.85).toFixed(3);
    } else if (flashEl) {
      flashEl.style.opacity = '0';
    }
  }

  function syncLivePreviewVideoAudio() {
    const v = getTopLivePreviewVideo();
    if (!v) return;
    const liveCue = getLiveCue();
    if (!liveCue) {
      audioEngine.syncLiveVideoElement(v, false, 0, false, 0);
      v.muted = true;
      return;
    }
    const useLocalAudio = state.rehearsalMode || !state.ledStatus.isOpen;
    const hasVsound = liveCue.vsound !== false;
    const cueVol = hasVsound ? logic.clamp((liveCue.vvol ?? 100) / 100, 0, 1) : 0;
    const rehearsalFactor = state.rehearsalMode ? 0.35 : 1.0;
    const outVol = logic.clamp((Number($('master-vol').value) / 100) * rehearsalFactor, 0, 1);
    const shouldPlayLocalAudio = useLocalAudio && cueVol > 0.001 && outVol > 0.001;
    const wantsLocalVideoAnalysis = Boolean(liveCue.fx && liveCue.fx.src === 'video');
    const handledByAudioEngine = audioEngine.syncLiveVideoElement(
      v,
      shouldPlayLocalAudio,
      cueVol,
      useLocalAudio && wantsLocalVideoAnalysis && cueVol > 0.001,
      outVol
    );
    if (handledByAudioEngine) {
      if (!v.muted && v.paused && !v.ended) {
        v.play().catch(() => {});
      }
      return;
    }

    const effVol = cueVol * outVol;
    v.volume = effVol;
    v.muted = !useLocalAudio || effVol <= 0.001;
    if (!v.muted && v.paused && !v.ended) {
      v.play().catch(() => {});
    }
    const targetSink = state.settings.audioDeviceId || '';
    if (typeof v.setSinkId === 'function' && targetSink !== (v.sinkId || '')) {
      v.setSinkId(targetSink).catch(() => {
        if (targetSink !== '') v.setSinkId('').catch(() => {});
      });
    }
  }

  function sendLiveVideoAudioIfActive(cue) {
    if (!cue || cue.id !== state.liveCueId) return;
    state.liveCueSnapshot = JSON.parse(JSON.stringify(cue));
    syncLivePreviewVideoAudio();
    if (!state.rehearsalMode) {
      window.api.sendToLed({
        type: 'video-audio',
        vsound: cue.vsound !== false,
        vvol: cue.vvol ?? 100,
        masterVol: Number($('master-vol').value),
        sinkId: state.settings.audioDeviceId || ''
      });
    }
  }

  function renderPreviewBox(boxEl, cue, emptyText, withBlurBackdrop, animateTransition) {
    const srcType = cue ? (cue.sourceType || 'media') : 'media';
    const renderKey = cue
      ? `${cue.id}|${srcType}|${cue.cameraId || ''}|${cue.generator || ''}|${cue.vis || ''}|${cue.aud || ''}|${cue.fit || ''}|${cue.loop ? 1 : 0}`
      : `empty|${emptyText}`;

    if (boxEl._renderedKey === renderKey) {
      if (boxEl.id === 'live-preview-box') syncLivePreviewVideoAudio();
      return;
    }
    const hadPrevious = Boolean(boxEl._renderedKey);
    boxEl._renderedKey = renderKey;

    const layer = document.createElement('div');
    layer.className = 'preview-layer';

    if (!cue) {
      const empty = document.createElement('div');
      empty.className = 'preview-empty';
      empty.textContent = emptyText;
      layer.appendChild(empty);
    } else if (srcType === 'camera') {
      const card = document.createElement('div');
      card.className = 'preview-virtual-card';
      const badge = document.createElement('span');
      badge.className = 'preview-virtual-badge';
      badge.textContent = '📷 CAMERA / CAPTURE LIVE';
      const camObj = state.videoDevices.find((d) => d.deviceId === cue.cameraId);
      const ttl = document.createElement('div');
      ttl.className = 'preview-virtual-title';
      ttl.textContent = camObj && camObj.label ? camObj.label : 'Camera mặc định hệ thống';
      card.appendChild(badge);
      card.appendChild(ttl);
      layer.appendChild(card);
    } else if (srcType === 'generator') {
      const card = document.createElement('div');
      card.className = 'preview-virtual-card';
      const badge = document.createElement('span');
      badge.className = 'preview-virtual-badge';
      badge.textContent = '✨ VJ GENERATOR';
      const ttl = document.createElement('div');
      ttl.className = 'preview-virtual-title';
      ttl.textContent = GENERATOR_TITLES[cue.generator] || cue.generator || 'Laser Beams';
      card.appendChild(badge);
      card.appendChild(ttl);
      layer.appendChild(card);
    } else if (!cue.vis) {
      const empty = document.createElement('div');
      empty.className = 'preview-empty';
      empty.textContent = cue.aud ? `♪ Chỉ phát nhạc: ${window.api.baseName(cue.aud)}` : emptyText;
      layer.appendChild(empty);
    } else {
      const url = window.api.toFileUrl(cue.vis, state.projectFilePath);
      const kind = logic.detectMediaKind(cue.vis);
      const fitStyle = cue.fit === 'cover' ? 'cover' : 'contain';

      if (kind === 'image') {
        let bg = null;
        if (withBlurBackdrop) {
          bg = document.createElement('img');
          bg.className = 'preview-backdrop';
          bg.onerror = () => { if (bg.parentNode) bg.remove(); };
          bg.src = url;
          layer.appendChild(bg);
        }
        const img = document.createElement('img');
        img.className = 'preview-fg';
        img.style.objectFit = fitStyle;
        img.onerror = () => {
          if (bg && bg.parentNode) bg.remove();
          if (img.parentNode) img.remove();
          if (!layer.querySelector('.preview-empty')) {
            const fallback = document.createElement('div');
            fallback.className = 'preview-empty';
            fallback.textContent = `Không tải được ảnh: ${window.api.baseName(cue.vis)}`;
            layer.appendChild(fallback);
          }
        };
        img.src = url;
        layer.appendChild(img);
      } else {
        const v = document.createElement('video');
        v.className = 'preview-fg';
        v.src = url;
        v.muted = true;
        v.loop = Boolean(cue.loop);
        v.autoplay = true;
        v.playsInline = true;
        v.style.objectFit = fitStyle;
        layer.appendChild(v);
        v.play().catch(() => {});
      }
    }

    const oldLayers = Array.from(boxEl.querySelectorAll('.preview-layer'));
    const durMs = cue && animateTransition && hadPrevious && cue.tr !== 'cut'
      ? Math.max(0, (Number(cue.dur ?? 0.8) || 0) * 1000)
      : 0;

    if (oldLayers.length > 0 && durMs > 30) {
      layer.style.opacity = '0';
      boxEl.appendChild(layer);
      if (boxEl.id === 'live-preview-box') syncLivePreviewVideoAudio();

      oldLayers.forEach((old) => {
        const oldVid = old.querySelector('video');
        if (oldVid) oldVid.muted = true;
        const outA = old.animate(
          [{ opacity: 1 }, { opacity: 0 }],
          { duration: durMs, easing: 'ease-in-out', fill: 'forwards' }
        );
        outA.onfinish = () => {
          if (oldVid) {
            audioEngine.disconnectLiveVideoElement(oldVid);
            try { oldVid.pause(); oldVid.removeAttribute('src'); } catch (_) {}
            setTimeout(() => { try { oldVid.load(); } catch (_) {} }, 0);
          }
          if (old.parentNode) old.parentNode.removeChild(old);
        };
      });

      const inA = layer.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: durMs, easing: 'ease-in-out', fill: 'forwards' }
      );
      inA.onfinish = () => {
        layer.style.opacity = '1';
        if (boxEl.id === 'live-preview-box') syncLivePreviewVideoAudio();
      };
    } else {
      oldLayers.forEach((old) => {
        const oldVid = old.querySelector('video');
        if (oldVid) {
          audioEngine.disconnectLiveVideoElement(oldVid);
          try { oldVid.pause(); oldVid.removeAttribute('src'); } catch (_) {}
          setTimeout(() => { try { oldVid.load(); } catch (_) {} }, 0);
        }
      });
      boxEl.innerHTML = '';
      boxEl.appendChild(layer);
      if (boxEl.id === 'live-preview-box') syncLivePreviewVideoAudio();
    }
  }

  function renderMonitors() {
    const liveCue = getLiveCue();
    const nextCue = getSelectedCue();
    renderMonitorHeadersOnly();
    renderPreviewBox($('next-preview-box'), nextCue, 'Chọn một Cue bên trái', true, false);
    renderPreviewBox($('live-preview-box'), liveCue, 'Màn hình LED đang chờ', false, true);
  }

  function renderFxPresets() {
    const container = $('fx-preset-buttons');
    container.innerHTML = '';
    const allPresets = { ...logic.FX_PRESETS, ...(state.project.customFxPresets || {}) };

    Object.entries(allPresets).forEach(([name, preset]) => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm';
      btn.textContent = name;
      btn.addEventListener('click', () => {
        const cue = getSelectedCue();
        if (!cue) return;
        pushUndoSnapshot();
        cue.fx = logic.createDefaultFx({ ...cue.fx, ...preset, on: true });
        scheduleAutosave();
        renderEditor();
        sendLiveCueFxIfActive(cue);
      });
      container.appendChild(btn);
    });
  }

  function renderBassPresets() {
    const container = $('bass-preset-buttons');
    container.innerHTML = '';
    Object.entries(logic.BASS_PRESETS).forEach(([name, preset]) => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm btn-fx';
      btn.textContent = name;
      btn.addEventListener('click', () => {
        const cue = getSelectedCue();
        if (!cue) return;
        pushUndoSnapshot();
        cue.fx.sens = preset.sens;
        cue.fx.minInterval = preset.minInterval;
        cue.fx.bassLow = preset.bassLow;
        cue.fx.bassHigh = preset.bassHigh;
        if (cue.fx.src !== 'video') cue.fx.src = 'auto';
        scheduleAutosave();
        renderEditor();
        sendLiveCueFxIfActive(cue);
      });
      container.appendChild(btn);
    });
  }

  function sendLiveCueFxIfActive(cue) {
    if (!cue) return;
    if (cue.id === state.liveCueId) {
      state.liveCueSnapshot = JSON.parse(JSON.stringify(cue));
      audioEngine.configureBassAnalysis(cue.fx);
      syncLivePreviewVideoAudio();
      syncAnalysisSourceRouting();
      if (!state.rehearsalMode) {
        window.api.sendToLed({ type: 'fx', fx: cue.fx });
      }
    } else {
      syncAnalysisSourceRouting();
      if ((state.testIdleOn || state.testBeatOn) && !state.rehearsalMode) {
        window.api.sendToLed({ type: 'idle', fx: cue.fx });
      }
    }
  }

  function sendLiveCueTextIfActive(cue) {
    if (!cue || cue.id !== state.liveCueId) return;
    state.liveCueSnapshot = JSON.parse(JSON.stringify(cue));
    if (!state.rehearsalMode) {
      window.api.sendToLed({ type: 'text', text: cue.text });
    }
  }

  async function renderWaveformForCue(cue) {
    const myToken = ++waveformToken;
    const canvas = $('waveform-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#191b22';
    ctx.fillRect(0, 0, w, h);

    if (!cue || !cue.aud) {
      ctx.fillStyle = '#969cb0';
      ctx.font = '11.5px Segoe UI';
      ctx.fillText('Chưa chọn tệp nhạc cho Cue này', 12, 38);
      canvas.dataset.duration = '0';
      return;
    }

    ctx.fillStyle = '#969cb0';
    ctx.font = '11.5px Segoe UI';
    ctx.fillText('Đang phân tích sóng âm...', 12, 38);

    const data = await audioEngine.getWaveformPeaks(cue.aud, state.projectFilePath, 160);
    if (myToken !== waveformToken) return;

    ctx.fillStyle = '#191b22';
    ctx.fillRect(0, 0, w, h);

    if (!data || !data.peaks) {
      ctx.fillStyle = '#F59E0B';
      ctx.fillText('Không giải mã được sóng âm (nhạc vẫn phát bình thường)', 12, 38);
      canvas.dataset.duration = '0';
      return;
    }

    canvas.dataset.duration = String(data.duration || 0);
    const peaks = data.peaks;
    const barW = w / peaks.length;
    const midY = h / 2;

    const startRatio = data.duration > 0 ? logic.clamp(cue.startAt / data.duration, 0, 1) : 0;
    const endRatio = data.duration > 0 && cue.endAt > cue.startAt
      ? logic.clamp(cue.endAt / data.duration, 0, 1)
      : 1;

    ctx.fillStyle = 'rgba(240, 0, 140, 0.12)';
    ctx.fillRect(startRatio * w, 0, (endRatio - startRatio) * w, h);

    peaks.forEach((p, i) => {
      const ratio = i / peaks.length;
      const inRange = ratio >= startRatio && ratio <= endRatio;
      ctx.fillStyle = inRange ? '#f0008c' : '#3a4052';
      const barH = Math.max(2, p * (h - 10));
      ctx.fillRect(i * barW, midY - barH / 2, Math.max(1, barW - 1), barH);
    });

    ctx.fillStyle = '#10B981';
    ctx.fillRect(startRatio * w, 0, 2, h);
    if (cue.endAt > cue.startAt) {
      ctx.fillStyle = '#EF4444';
      ctx.fillRect(endRatio * w - 2, 0, 2, h);
    }
  }

  function renderEditorMediaDropzones(cue) {
    const dzVis = $('dropzone-vis');
    if (dzVis) {
      if (cue && cue.vis) {
        const vKind = logic.detectMediaKind(cue.vis);
        const ext = logic.getExtensionLower(cue.vis).replace('.', '').toUpperCase() || 'FILE';
        dzVis.classList.add('has-file');
        $('dz-vis-badge').textContent = (vKind === 'video' ? 'VIDEO ' : 'ẢNH ') + ext;
        $('dz-vis-badge').classList.remove('hidden');
        $('dz-vis-title').textContent = window.api.baseName(cue.vis);
        $('dz-vis-sub').textContent = cue.vis;
        $('btn-pick-vis').textContent = 'Đổi hình';
        $('btn-clear-vis').classList.remove('hidden');
      } else {
        dzVis.classList.remove('has-file');
        $('dz-vis-badge').classList.add('hidden');
        $('dz-vis-title').textContent = 'Kéo thả file';
        $('dz-vis-sub').textContent = 'Ảnh hoặc Video (MP4, WEBM, JPG, PNG, WEBP, GIF) — để trống nếu giữ hình cũ';
        $('btn-pick-vis').textContent = 'Chọn file';
        $('btn-clear-vis').classList.add('hidden');
      }
    }

    const dzAud = $('dropzone-aud');
    if (dzAud) {
      if (cue && cue.aud) {
        const ext = logic.getExtensionLower(cue.aud).replace('.', '').toUpperCase() || 'AUDIO';
        dzAud.classList.add('has-file');
        $('dz-aud-badge').textContent = 'NHẠC ' + ext;
        $('dz-aud-badge').classList.remove('hidden');
        $('dz-aud-title').textContent = window.api.baseName(cue.aud);
        $('dz-aud-sub').textContent = cue.aud;
        $('btn-pick-aud').textContent = 'Đổi nhạc';
        $('btn-clear-aud').classList.remove('hidden');
      } else {
        dzAud.classList.remove('has-file');
        $('dz-aud-badge').classList.add('hidden');
        $('dz-aud-title').textContent = 'Kéo thả file';
        $('dz-aud-sub').textContent = 'Hỗ trợ MP3, WAV, M4A, AAC, FLAC, OGG — tự tắt nhạc Cue trước nếu để trống';
        $('btn-pick-aud').textContent = 'Chọn nhạc';
        $('btn-clear-aud').classList.add('hidden');
      }
    }
  }

  function syncCueSourceTypeVisibility(sourceType) {
    const st = ['media', 'camera', 'generator'].includes(sourceType) ? sourceType : 'media';
    $('wrap-vis-media').classList.toggle('hidden', st !== 'media');
    $('wrap-vis-camera').classList.toggle('hidden', st !== 'camera');
    $('wrap-vis-generator').classList.toggle('hidden', st !== 'generator');
  }

  async function refreshCameraDevices() {
    if (typeof audioEngine.listVideoInputDevices === 'function') {
      state.videoDevices = await audioEngine.listVideoInputDevices();
    } else {
      state.videoDevices = [];
    }
    const sel = $('ed-camera-id');
    if (!sel) return;
    const curVal = sel.value;
    sel.innerHTML = '';
    const defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = 'Camera mặc định hệ thống';
    sel.appendChild(defOpt);
    state.videoDevices.forEach((cam, idx) => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId || '';
      opt.textContent = cam.label || `Camera ${idx + 1}`;
      sel.appendChild(opt);
    });
    const cue = getSelectedCue();
    sel.value = (cue && cue.cameraId) || curVal || '';
  }

  function renderEditor() {
    const cue = getSelectedCue();
    if (!cue) {
      $('editor-empty').classList.remove('hidden');
      $('editor-body').classList.add('hidden');
      $('editing-cue-badge').textContent = 'Thuộc tính Cue';
      if (ledDmxUi) ledDmxUi.renderInspectorTab();
      return;
    }

    $('editor-empty').classList.add('hidden');
    $('editor-body').classList.remove('hidden');
    $('editing-cue-badge').textContent = `Thuộc tính Cue #${state.selectedIndex + 1}`;

    $('ed-name').value = cue.name;
    $('ed-note').value = cue.note;
    $('ed-source-type').value = cue.sourceType || 'media';
    syncCueSourceTypeVisibility(cue.sourceType || 'media');
    $('ed-camera-id').value = cue.cameraId || '';
    $('ed-generator').value = cue.generator || 'laser-beams';
    $('ed-vis').value = cue.vis || '';
    $('ed-tr').value = cue.tr;
    $('ed-dur').value = cue.dur;
    $('ed-fit').value = cue.fit;
    $('ed-loop').checked = cue.loop;
    $('ed-vsound').checked = cue.vsound !== false;
    $('ed-vvol').value = cue.vvol ?? 100;
    $('ed-vvol-val').textContent = cue.vvol ?? 100;
    $('ed-autofollow').value = cue.autoFollow;
    $('ed-autodelay').value = cue.autoDelay;

    $('ed-aud').value = cue.aud || '';
    renderEditorMediaDropzones(cue);
    $('ed-keep-audio').checked = Boolean(cue.keepAudio);
    $('ed-vol').value = cue.vol;
    $('ed-vol-val').textContent = cue.vol;
    $('ed-fadein').value = cue.fadeIn;
    $('ed-fadeout').value = cue.fadeOut;
    $('ed-startat').value = cue.startAt;
    $('ed-endat').value = cue.endAt;

    const fx = logic.createDefaultFx(cue.fx);
    cue.fx = fx;

    $('fx-on').checked = fx.on;
    $('fx-src').value = fx.src;
    $('fx-bpm').value = fx.bpm;
    $('fx-off').value = fx.off;
    $('fx-bpm-controls').classList.toggle('hidden', fx.src !== 'bpm');
    $('fx-ext-controls').classList.toggle('hidden', fx.src !== 'ext');
    if ($('fx-video-controls')) $('fx-video-controls').classList.toggle('hidden', fx.src !== 'video');
    $('wrap-fx-delay').classList.toggle('hidden', fx.src === 'ext');
    $('fx-motion').value = fx.motion;

    ['scale', 'shake', 'rot', 'bright', 'hue', 'flash', 'decay', 'sens'].forEach((k) => {
      $('fx-' + k).value = fx[k];
      $('fx-' + k + '-v').textContent = fx[k];
    });

    $('fx-min-interval').value = fx.minInterval;
    $('fx-min-interval-v').textContent = fx.minInterval;
    $('fx-bass-low').value = fx.bassLow;
    $('fx-bass-low-v').textContent = fx.bassLow;
    $('fx-bass-high').value = fx.bassHigh;
    $('fx-bass-high-v').textContent = fx.bassHigh;
    $('fx-delay-ms').value = fx.delayMs;
    $('fx-delay-ms-v').textContent = fx.delayMs;
    $('fx-over').checked = fx.over;

    $('fx-idle-on').checked = fx.idleOn;
    $('fx-idle-only-music').checked = fx.idleOnlyMusic;
    $('fx-idle-style').value = fx.idleStyle;
    $('fx-idle-amp').value = fx.idleAmp;
    $('fx-idle-amp-v').textContent = fx.idleAmp;
    $('fx-idle-rot').value = fx.idleRot;
    $('fx-idle-rot-v').textContent = fx.idleRot;
    $('fx-idle-breath').value = fx.idleBreath;
    $('fx-idle-breath-v').textContent = fx.idleBreath;
    $('fx-idle-speed').value = fx.idleSpeed;
    $('fx-idle-speed-v').textContent = fx.idleSpeed;
    $('fx-idle-couple').value = fx.idleCouple;
    $('fx-idle-couple-v').textContent = fx.idleCouple;

    $('txt-on').checked = cue.text.on;
    $('txt-content').value = cue.text.content;
    $('txt-pos').value = cue.text.pos;
    $('txt-size').value = cue.text.size;
    $('txt-size-v').textContent = cue.text.size;
    $('txt-color').value = cue.text.color;
    $('txt-bgbox').checked = cue.text.bgBox;

    renderFxPresets();
    renderBassPresets();
    if (ledDmxUi) {
      ledDmxUi.renderInspectorTab();
      ledDmxUi.renderQuickDeck();
    }
    syncAllToggleSections(cue);
    updateVideoBeatStatusUi(performance.now(), true);
    const audioTabEl = $('tab-audio');
    if (audioTabEl && audioTabEl.classList.contains('active')) {
      renderWaveformForCue(cue);
    }
  }

  // =========================================================================
  // MASTER LIVE FX RACK & OUTPUT MAPPING + STAGE DISPLAY
  // =========================================================================

  function pushMasterFxToLed() {
    if (!state.rehearsalMode) {
      window.api.sendToLed({ type: 'master-fx', masterFx: state.project.masterFx });
    }
  }

  function renderMasterFxControls() {
    const mfx = logic.createDefaultMasterFx(state.project.masterFx);
    state.project.masterFx = mfx;
    $('mfx-dimmer').value = mfx.dimmer;
    $('mfx-dimmer-v').textContent = mfx.dimmer;
    $('mfx-contrast').value = mfx.contrast;
    $('mfx-contrast-v').textContent = mfx.contrast;
    $('mfx-saturate').value = mfx.saturate;
    $('mfx-saturate-v').textContent = mfx.saturate;
    $('mfx-hue').value = mfx.hue;
    $('mfx-hue-v').textContent = mfx.hue;
    $('mfx-rgbsplit').value = mfx.rgbSplit;
    $('mfx-rgbsplit-v').textContent = mfx.rgbSplit;
    $('mfx-rgb-beat').checked = Boolean(mfx.rgbBeatLink);
    $('mfx-glitch').value = mfx.glitch;
    $('mfx-glitch-v').textContent = mfx.glitch;
    $('mfx-glitch-beat').checked = Boolean(mfx.glitchBeatLink);
    $('mfx-vignette').value = mfx.vignette;
    $('mfx-vignette-v').textContent = mfx.vignette;
    $('mfx-pixelate').value = mfx.pixelate;
    $('mfx-pixelate-v').textContent = mfx.pixelate;
    $('mfx-mirror').value = mfx.mirror || 'none';
    $('mfx-invert').checked = Boolean(mfx.invert);
  }

  function pushOutputMappingToLed() {
    if (!state.rehearsalMode) {
      window.api.sendToLed({ type: 'output-mapping', mapping: state.project.outputMapping });
    }
  }

  function renderMappingControls() {
    const m = logic.createDefaultOutputMapping(state.project.outputMapping);
    state.project.outputMapping = m;
    $('map-crop-top').value = m.cropTop; $('map-crop-top-v').textContent = m.cropTop;
    $('map-crop-bottom').value = m.cropBottom; $('map-crop-bottom-v').textContent = m.cropBottom;
    $('map-crop-left').value = m.cropLeft; $('map-crop-left-v').textContent = m.cropLeft;
    $('map-crop-right').value = m.cropRight; $('map-crop-right-v').textContent = m.cropRight;
    $('map-offset-x').value = m.offsetX; $('map-offset-x-v').textContent = m.offsetX;
    $('map-offset-y').value = m.offsetY; $('map-offset-y-v').textContent = m.offsetY;
    $('map-scale-x').value = m.scaleX; $('map-scale-x-v').textContent = m.scaleX;
    $('map-scale-y').value = m.scaleY; $('map-scale-y-v').textContent = m.scaleY;
    $('map-rotate-x').value = m.rotateX; $('map-rotate-x-v').textContent = m.rotateX;
    $('map-rotate-y').value = m.rotateY; $('map-rotate-y-v').textContent = m.rotateY;
    $('map-perspective').value = m.perspective; $('map-perspective-v').textContent = m.perspective;
    $('map-flip-h').checked = Boolean(m.flipH);
    $('map-flip-v').checked = Boolean(m.flipV);
  }

  function renderStageDisplayUi(stage, displays) {
    if (stage) state.stageStatus = stage;
    if (displays) state.displays = displays;

    const sel = $('stage-display-select');
    if (sel) {
      const prev = sel.value;
      sel.innerHTML = '';
      const autoOpt = document.createElement('option');
      autoOpt.value = 'auto';
      autoOpt.textContent = 'Tự chọn màn phụ trống (hoặc cửa sổ thử)';
      sel.appendChild(autoOpt);

      const previewOpt = document.createElement('option');
      previewOpt.value = 'preview';
      previewOpt.textContent = 'Mở dạng cửa sổ 960×540';
      sel.appendChild(previewOpt);

      state.displays.forEach((d) => {
        const opt = document.createElement('option');
        opt.value = String(d.id);
        opt.textContent = `${d.label} (${d.bounds.width}×${d.bounds.height})`;
        sel.appendChild(opt);
      });
      if (prev) sel.value = prev;
    }

    const st = state.stageStatus || { isOpen: false };
    const pill = $('stage-status-pill');
    const txt = $('stage-status-text');
    const btn = $('btn-toggle-stage');
    const detail = $('stage-modal-status');

    if (pill && txt) {
      pill.classList.remove('is-idle', 'is-live-input', 'is-warn');
      if (st.isOpen) {
        pill.classList.add(st.mode === 'fullscreen' ? 'is-live-input' : 'is-warn');
        txt.textContent = st.mode === 'fullscreen' ? 'Stage: Bật' : 'Stage: Cửa sổ';
      } else {
        pill.classList.add('is-idle');
        txt.textContent = 'Stage: Tắt';
      }
    }
    if (btn) btn.textContent = st.isOpen ? 'Đóng Stage Display' : 'Mở Stage Display';
    if (detail) {
      detail.textContent = st.isOpen
        ? `Đang mở Stage Display (${st.displayLabel || st.mode}, ${st.width}×${st.height}).`
        : 'Stage Display đang tắt.';
    }
  }

  function refreshAllUi() {
    renderSfxPads();
    renderCueList();
    renderMonitors();
    renderEditor();
    if (vjDeckUi) vjDeckUi.render();
    if (overlaysUi) overlaysUi.render();
    if (ledDmxUi) {
      ledDmxUi.renderQuickDeck();
      ledDmxUi.renderInspectorTab();
    }
    renderMasterFxControls();
    renderMappingControls();
    pushMasterFxToLed();
    pushOutputMappingToLed();
    if (overlaysUi) overlaysUi.pushToLed(false);
    if (ledDmxUi) ledDmxUi.sendLedSyncToOutput();
    pushStageUpdate(true);
    syncRemoteState();
  }

  // =========================================================================
  // TRẠNG THÁI MÀN HÌNH LED & LOA TRÊN TOP HEADER
  // =========================================================================

  function renderLedAndDisplayUi(led, displays) {
    state.ledStatus = led;
    state.displays = displays || state.displays;

    const sel = $('display-select');
    const prevVal = sel.value;
    sel.innerHTML = '';
    const autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = 'Tự chọn màn phụ';
    sel.appendChild(autoOpt);

    state.displays.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = String(d.id);
      opt.textContent = `${d.label} (${d.bounds.width}×${d.bounds.height})`;
      sel.appendChild(opt);
    });
    if (prevVal) sel.value = prevVal;

    const pill = $('led-status-pill');
    const txt = $('led-status-text');
    const toggleBtn = $('btn-toggle-led');

    pill.classList.remove('is-warn', 'is-off');
    if (led && led.isOpen) {
      toggleBtn.textContent = 'Đóng LED';
      if (led.mode === 'fullscreen') {
        txt.textContent = 'LED: Đang mở';
        pill.title = `Đang mở trên ${led.displayLabel} (${led.width}×${led.height}) — Bấm để đóng`;
      } else {
        pill.classList.add('is-warn');
        txt.textContent = 'LED: Cửa sổ thử';
        pill.title = 'Chưa thấy màn phụ, đang mở cửa sổ thử 960×540 — Bấm để đóng';
      }
    } else {
      toggleBtn.textContent = 'Mở LED';
      pill.classList.add('is-off');
      txt.textContent = 'LED: Đang đóng';
      pill.title = 'Màn hình LED đang đóng — Bấm để mở lại';
    }

    renderStageDisplayUi(state.stageStatus, state.displays);
  }

  function updateAudioBadgeLabel() {
    const sel = $('audio-device-select');
    const opt = sel && sel.selectedOptions && sel.selectedOptions[0];
    if (!opt || !sel.value) {
      $('audio-status-text').textContent = 'Loa: Mặc định';
    } else {
      const shortName = opt.textContent.replace(/\s*\(.*?\)\s*/g, '').slice(0, 16);
      $('audio-status-text').textContent = `Loa: ${shortName}`;
    }
  }

  async function refreshAudioDevices() {
    const list = await audioEngine.listOutputDevices();
    const sel = $('audio-device-select');
    sel.innerHTML = '';
    const defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = 'Mặc định hệ thống';
    sel.appendChild(defOpt);

    list.forEach((d, idx) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Thiết bị âm thanh ${idx + 1}`;
      sel.appendChild(opt);
    });
    if (state.settings.audioDeviceId) {
      sel.value = state.settings.audioDeviceId;
    }
    updateAudioBadgeLabel();
  }

  function syncAnalysisSourceRouting() {
    const liveCue = getLiveCue();
    const selCue = getSelectedCue();
    const track = audioEngine.getCurrentTrackInfo();
    const extOn = audioEngine.isExternalInputActive();

    let nextMode = 'internal';
    if (liveCue && liveCue.fx && liveCue.fx.on) {
      if (liveCue.fx.src === 'ext' && extOn) nextMode = 'external';
      else if (liveCue.fx.src === 'video') nextMode = 'video';
    } else if (liveCue && liveCue.fx && liveCue.fx.src === 'video') {
      nextMode = 'video';
    } else if (extOn && !track.playing) {
      nextMode = 'external';
    } else if (selCue && selCue.fx && selCue.fx.src === 'ext' && extOn && !track.playing) {
      nextMode = 'external';
    }

    audioEngine.setAnalysisSourceMode(nextMode);
    const refCue = liveCue || selCue;
    if (refCue && refCue.fx) {
      audioEngine.configureBassAnalysis(refCue.fx);
    }
  }

  function updateVideoBeatStatusUi(nowMs, force, ledVideoActiveArg, localVideoPlayingArg) {
    const box = $('fx-video-controls');
    const statusEl = $('fx-video-status');
    const actionsEl = $('fx-video-actions');
    const btnVsound = $('btn-fx-enable-vsound');
    const btnGo = $('btn-fx-go-selected');
    if (!box || !statusEl || !actionsEl || !btnVsound || !btnGo) return;

    const selCue = getSelectedCue();
    if (!selCue || !selCue.fx || selCue.fx.src !== 'video') {
      updateVuMeter('fx-video-vu-meter', 0);
      return;
    }

    const liveCue = getLiveCue();
    const t = Number.isFinite(nowMs) ? nowMs : performance.now();
    const localVideoPlaying = localVideoPlayingArg !== undefined ? Boolean(localVideoPlayingArg) : audioEngine.isLiveVideoPlaying();
    const ledVideoActive = ledVideoActiveArg !== undefined
      ? Boolean(ledVideoActiveArg)
      : Boolean(
          liveCue &&
          liveCue.fx &&
          liveCue.fx.src === 'video' &&
          !state.rehearsalMode &&
          state.ledStatus.isOpen &&
          state.ledVideoTelemetry.playing &&
          (t - state.ledVideoTelemetry.updatedAtMs < 450)
        );

    const videoVu = ledVideoActive
      ? logic.clamp(Math.max(state.ledVideoTelemetry.env || 0, state.ledVideoTelemetry.bass || 0), 0, 1)
      : (localVideoPlaying ? logic.clamp(state.localVideoEnv || 0, 0, 1) : 0);
    updateVuMeter('fx-video-vu-meter', videoVu);

    if (!force && (t - lastVideoStatusUiMs < 150)) return;
    lastVideoStatusUiMs = t;

    statusEl.classList.remove('is-ok', 'is-warn');
    let text = '';
    let tone = 'muted';
    let showVsoundBtn = false;
    let showGoBtn = false;

    if (!liveCue || liveCue.id !== selCue.id) {
      const selInfo = resolveCueVisualInfo(selCue);
      if (selInfo.visKind === 'video' && selInfo.visUrl) {
        text = `Cue #${state.selectedIndex + 1} chưa phát LIVE — bấm GO (Space) để phát Video này và bắt nhịp beat.`;
        showGoBtn = true;
      } else {
        text = `Cue #${state.selectedIndex + 1} chưa có Video và chưa phát LIVE.`;
      }
      tone = 'warn';
    } else {
      const liveInfo = resolveCueVisualInfo(liveCue);
      if (liveInfo.visKind !== 'video' || !liveInfo.visUrl) {
        text = 'Cue đang phát LIVE không phải Video — hãy chọn Cue Video hoặc đổi nguồn beat.';
        tone = 'warn';
      } else if (liveCue.vsound === false || (liveCue.vvol ?? 100) <= 0) {
        text = 'Cue LIVE đang tắt "Âm thanh gốc từ Video" — bật lại để DSP nhận tiếng.';
        showVsoundBtn = true;
        tone = 'warn';
      } else if (ledVideoActive) {
        text = `✔ Đang bắt nhịp từ tiếng Video LIVE: "${liveCue.name}"`;
        tone = 'ok';
      } else if (localVideoPlaying) {
        text = `✔ Đang bắt nhịp từ tiếng Video xem trước: "${liveCue.name}"`;
        tone = 'ok';
      } else {
        text = `⏳ Đang chờ tiếng từ Video "${liveCue.name}"...`;
      }
    }

    if (statusEl.textContent !== text) statusEl.textContent = text;
    if (tone === 'ok') statusEl.classList.add('is-ok');
    else if (tone === 'warn') statusEl.classList.add('is-warn');
    btnVsound.classList.toggle('hidden', !showVsoundBtn);
    btnGo.classList.toggle('hidden', !showGoBtn);
    actionsEl.classList.toggle('hidden', !showVsoundBtn && !showGoBtn);
  }

  function updateInputStatusPill(active, labelText) {
    const pill = $('input-status-pill');
    const txt = $('input-status-text');
    if (!pill || !txt) return;
    pill.classList.remove('is-idle', 'is-live-input', 'is-off');
    if (active) {
      pill.classList.add('is-live-input');
      const clean = (labelText || 'Line-In').replace(/\s*\(.*?\)\s*/g, '').slice(0, 14);
      txt.textContent = `Mixer: ${clean}`;
    } else {
      pill.classList.add('is-idle');
      txt.textContent = 'Mixer: Tắt';
    }
  }

  async function refreshInputDevices() {
    const list = await audioEngine.listInputDevices();
    const selects = [$('audio-input-select'), $('fx-ext-device')];
    selects.forEach((sel) => {
      if (!sel) return;
      sel.innerHTML = '';
      const defOpt = document.createElement('option');
      defOpt.value = '';
      defOpt.textContent = 'Mặc định (Line-In / Soundcard)';
      sel.appendChild(defOpt);

      list.forEach((d, idx) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Cổng thu âm thanh ${idx + 1}`;
        sel.appendChild(opt);
      });

      if (state.settings.extDeviceId) {
        sel.value = state.settings.extDeviceId;
      }
    });
  }

  async function enableExternalMixerInput(enable, customDeviceId) {
    if (!enable) {
      audioEngine.stopExternalInput();
      if ($('ext-input-enable')) $('ext-input-enable').checked = false;
      setSectionEnabled('group-ext-options', false);
      updateInputStatusPill(false);
      updateVuMeter('ext-opt-vu-meter', 0);
      updateVuMeter('fx-ext-vu-meter', 0);
      syncAnalysisSourceRouting();
      return false;
    }

    const devId = customDeviceId !== undefined ? customDeviceId : (state.settings.extDeviceId || '');
    const res = await audioEngine.startExternalInput(devId);
    if (!res.ok) {
      if ($('ext-input-enable')) $('ext-input-enable').checked = false;
      setSectionEnabled('group-ext-options', false);
      updateInputStatusPill(false);
      showBanner('Không thu được tín hiệu từ Mixer / Line-In: ' + res.error);
      syncAnalysisSourceRouting();
      return false;
    }

    state.settings.extDeviceId = devId;
    window.api.setSettings({ extDeviceId: devId });
    if ($('ext-input-enable')) $('ext-input-enable').checked = true;
    setSectionEnabled('group-ext-options', true);
    await refreshInputDevices();
    updateInputStatusPill(true, res.label);
    syncAnalysisSourceRouting();
    return true;
  }

  // =========================================================================
  // VẼ WAVEFORM DECK TRUNG TÂM, BIỂU ĐỒ BASS & VÒNG LẶP 60 FPS
  // =========================================================================

  function drawDeckWaveform(bars, progressRatio, playing) {
    const canvas = $('spectrum-canvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const numCols = 96;
    const colStep = w / numCols;
    const barW = Math.max(2, colStep - 2.2);
    const midY = h / 2;
    const peaks = state.activeTrackPeaks;

    for (let i = 0; i < numCols; i++) {
      const colRatio = i / numCols;
      const specIdx = Math.min(bars.length - 1, Math.floor((i / numCols) * bars.length));
      const specVal = playing ? bars[specIdx] : 0;

      let baseAmp = 0.16 + 0.1 * Math.abs(Math.sin(i * 0.43) * Math.cos(i * 0.19));
      if (peaks && peaks.length > 0) {
        const pIdx = Math.min(peaks.length - 1, Math.floor(colRatio * peaks.length));
        baseAmp = Math.max(0.08, peaks[pIdx] * 0.82);
      }

      const combined = logic.clamp(baseAmp * 0.72 + specVal * 0.55, 0.06, 0.96);
      const barH = Math.max(4, combined * (h - 8));
      const isPlayed = progressRatio > 0 && colRatio <= progressRatio;

      if (isPlayed) {
        ctx.fillStyle = specVal > 0.75 ? '#ff66be' : '#f0008c';
      } else {
        ctx.fillStyle = playing ? '#43495c' : '#2e3240';
      }

      ctx.fillRect(i * colStep + 1, midY - barH / 2, barW, barH);
    }

    if (progressRatio > 0 && progressRatio < 1) {
      const px = progressRatio * w;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(px - 1, 0, 2, h);
    }
  }

  function drawBassChart(nowMs) {
    const canvas = $('bass-chart-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const windowMs = 4000;
    const cutoff = nowMs - windowMs;

    while (bassChartPoints.length > 0 && bassChartPoints[0].timeMs < cutoff) {
      bassChartPoints.shift();
    }
    while (bassChartBeats.length > 0 && bassChartBeats[0] < cutoff) {
      bassChartBeats.shift();
    }

    ctx.fillStyle = '#191b22';
    ctx.fillRect(0, 0, w, h);

    let maxVal = 0.25;
    for (let i = 0; i < bassChartPoints.length; i++) {
      const p = bassChartPoints[i];
      if (p.o > maxVal) maxVal = p.o;
      if (p.threshold > maxVal) maxVal = p.threshold;
    }
    maxVal *= 1.15;

    ctx.strokeStyle = 'rgba(239, 68, 68, 0.85)';
    ctx.lineWidth = 1.8;
    for (let i = 0; i < bassChartBeats.length; i++) {
      const x = ((bassChartBeats[i] - cutoff) / windowMs) * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    if (bassChartPoints.length < 2) {
      ctx.save();
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      const guideY = h - 14;
      ctx.beginPath();
      ctx.moveTo(0, guideY);
      ctx.lineTo(w, guideY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#64748B';
      ctx.font = '11px system-ui, -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Đang chờ tín hiệu âm thanh (bấm GO để phát)...', w / 2, h / 2 - 4);
      ctx.restore();
      return;
    }

    ctx.save();
    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    bassChartPoints.forEach((p, idx) => {
      const x = ((p.timeMs - cutoff) / windowMs) * w;
      const y = h - 4 - (p.threshold / maxVal) * (h - 8);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();

    ctx.strokeStyle = '#ff3da8';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    bassChartPoints.forEach((p, idx) => {
      const x = ((p.timeMs - cutoff) / windowMs) * w;
      const y = h - 4 - (p.o / maxVal) * (h - 8);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  function flashBeatLamp(nowMs) {
    const lamp = $('beat-lamp');
    lamp.classList.add('lit');
    clearTimeout(lampTimeout);
    lampTimeout = setTimeout(() => lamp.classList.remove('lit'), 95);
    beatRateTimestamps.push(nowMs);
  }

  function emitLedBeatHit(k, clockStep, nowMs) {
    if (nowMs - state.lastLedBeatHitMs < 45) return;
    state.lastLedBeatHitMs = nowMs;
    state.beatPulseLevel = Math.max(state.beatPulseLevel, logic.clamp(k, 0.3, 1));
    flashBeatLamp(nowMs);
    if (!state.rehearsalMode) {
      window.api.sendToLed({
        type: 'led-beat-hit',
        k,
        beatIndex: clockStep.beatIndex,
        beatInBar: clockStep.beatInBar,
        subBeat: clockStep.subBeatIndex,
        bands: {
          bass: state.lastAudioBands.bass,
          mid: state.lastAudioBands.mid,
          high: state.lastAudioBands.high
        }
      });
    }
  }

  function animationLoop() {
    const nowMs = performance.now();
    const dtSec = Math.min(0.1, Math.max(0.001, (nowMs - lastAnimMs) / 1000));
    lastAnimMs = nowMs;

    const liveCue = getLiveCue();
    const bars = audioEngine.sampleSpectrum();
    const extSpec = audioEngine.sampleExternalSpectrum();
    const extOn = audioEngine.isExternalInputActive();
    const track = audioEngine.getCurrentTrackInfo();
    const localVideoPlaying = audioEngine.isLiveVideoPlaying();
    const ledVideoActive = Boolean(
      liveCue &&
      liveCue.fx &&
      liveCue.fx.src === 'video' &&
      !state.rehearsalMode &&
      state.ledStatus.isOpen &&
      state.ledVideoTelemetry.playing &&
      (nowMs - state.ledVideoTelemetry.updatedAtMs < 450)
    );
    const progressRatio = track.duration > 0 ? logic.clamp(track.currentTime / track.duration, 0, 1) : 0;

    if (!track.playing && extOn && !localVideoPlaying && !ledVideoActive) {
      drawDeckWaveform(extSpec.bars, 0, true);
    } else if (ledVideoActive) {
      drawDeckWaveform(state.ledVideoTelemetry.spectrum, 0, true);
    } else {
      drawDeckWaveform(bars, progressRatio, track.playing || localVideoPlaying);
    }
    drawBassChart(nowMs);
    stepPreviewBeatFx(dtSec);

    const activeBars = ledVideoActive ? state.ledVideoTelemetry.spectrum : bars;
    let sumBar = 0;
    for (let i = 0; i < 24; i++) sumBar += (activeBars[i] || 0);
    const avgLevel = (track.playing || localVideoPlaying || ledVideoActive)
      ? (sumBar / 24) * (Number($('master-vol').value) / 100) * 1.35
      : 0;
    updateVuMeter('master-vu-meter', avgLevel);

    state.sfxVuLevel = Math.max(0, state.sfxVuLevel - 0.03);
    updateVuMeter('sfx-vu-meter', state.sfxVuLevel);
    updateVuMeter('ext-opt-vu-meter', extOn ? extSpec.level : 0);
    updateVuMeter('fx-ext-vu-meter', extOn ? extSpec.level : 0);
    updateVideoBeatStatusUi(nowMs, false, ledVideoActive, localVideoPlaying);

    if (track.playing) {
      hadPlayingWave = true;
      document.querySelectorAll('[data-cue-wave]').forEach((el) => {
        el.style.width = el.dataset.cueWave === track.cueId ? `${(progressRatio * 100).toFixed(1)}%` : '0%';
      });
    } else if (hadPlayingWave) {
      hadPlayingWave = false;
      document.querySelectorAll('[data-cue-wave]').forEach((el) => {
        el.style.width = '0%';
      });
    }

    const rateCutoff = nowMs - 2000;
    while (beatRateTimestamps.length > 0 && beatRateTimestamps[0] < rateCutoff) {
      beatRateTimestamps.shift();
    }
    $('beat-rate').textContent = `${(beatRateTimestamps.length / 2).toFixed(1)} /s`;

    if (track.playing && track.cueTitle) {
      $('track-name').textContent = `${track.cueTitle} — ${track.fileName}`;
    } else if (extOn) {
      $('track-name').textContent = '🎧 Đang nhận tín hiệu trực tiếp từ Mixer / DJ (Line-In)';
    } else {
      $('track-name').textContent = track.fileName;
    }
    $('track-time').textContent = `${logic.formatTime(track.currentTime)} / ${logic.formatTime(track.duration)}`;

    if (!state.isSeekingAudio) {
      $('track-seek').value = String(Math.round(progressRatio * 1000));
    }

    const cdEl = $('live-countdown');
    let remainSec = -1;
    if (track.playing && track.duration > 0) {
      remainSec = Math.max(0, track.duration - track.currentTime);
    } else if (state.autoFollowEndTime > 0) {
      remainSec = Math.max(0, (state.autoFollowEndTime - Date.now()) / 1000);
    }

    if (remainSec > 0 && remainSec < 10) {
      cdEl.textContent = '-' + logic.formatTime(remainSec);
      cdEl.classList.add('is-urgent');
    } else if (state.liveCueId && state.liveStartedAtMs > 0) {
      const elapsedLive = (nowMs - state.liveStartedAtMs) / 1000;
      cdEl.textContent = formatTimeHMS(track.playing ? track.currentTime : elapsedLive);
      cdEl.classList.remove('is-urgent');
    } else {
      cdEl.textContent = '00:00:00';
      cdEl.classList.remove('is-urgent');
    }

    // 1. Master Beat Clock (tách nhịp 0.25x..4x, dot 1-2-3-4, LED beat hit)
    state.beatPulseLevel = Math.max(0, state.beatPulseLevel - dtSec * 4.2);
    const clockStep = masterBeatClock.step(nowMs);
    state.lastBeatState = {
      phase: clockStep.phase,
      beatInBar: clockStep.beatInBar,
      beatIndex: clockStep.beatIndex
    };
    if (clockStep.isBeat && ledDmxUi) {
      ledDmxUi.updateBeatBarDots(clockStep.beatInBar);
      ledDmxUi.flashBpmPill();
    }

    const activeLedSync = ledDmxUi ? ledDmxUi.getActiveLedSync() : logic.createDefaultLedSync();
    if (
      activeLedSync.on &&
      clockStep.isSubBeat &&
      (activeLedSync.trigger === 'beat' || activeLedSync.trigger === 'all')
    ) {
      emitLedBeatHit(0.88, clockStep, nowMs);
    }

    // 2. Sample 3-Band FFT Audio (~30Hz)
    if (nowMs - state.lastAudioBandsSentMs >= 33) {
      state.lastAudioBandsSentMs = nowMs;
      const bands = ledVideoActive
        ? {
            bass: state.ledVideoTelemetry.bass,
            mid: state.ledVideoTelemetry.mid,
            high: state.ledVideoTelemetry.high,
            spectrum: state.ledVideoTelemetry.spectrum
          }
        : (typeof audioEngine.sampleAudioBands === 'function'
            ? audioEngine.sampleAudioBands()
            : { bass: 0, mid: 0, high: 0, spectrum: bars });
      state.lastAudioBands = bands;
      updateThreeBandMeters(bands);

      const hasSound =
        track.playing ||
        localVideoPlaying ||
        ledVideoActive ||
        (extOn && (bands.bass + bands.mid + bands.high) > 0.03);
      if (!state.rehearsalMode && !ledVideoActive) {
        window.api.sendToLed({
          type: 'audio-bands',
          bass: bands.bass,
          mid: bands.mid,
          high: bands.high,
          spectrum: bands.spectrum,
          bpm: state.masterBpm,
          beatPhase: clockStep.phase,
          playing: hasSound
        });
      }

      if (activeLedSync.on && hasSound && (activeLedSync.trigger === 'mid' || activeLedSync.trigger === 'high')) {
        const energy = activeLedSync.trigger === 'mid' ? bands.mid : bands.high;
        if (energy > 0.56 && nowMs - state.lastBandPeakMs >= 130) {
          state.lastBandPeakMs = nowMs;
          emitLedBeatHit(logic.clamp(energy * 1.15, 0.45, 1), clockStep, nowMs);
        }
      }
    }

    // 3. Beat FX (chế độ thử beat hoặc BPM cố định)
    if (state.testBeatOn) {
      const selCue = getSelectedCue() || liveCue;
      const fx = selCue ? selCue.fx : logic.createDefaultFx({ on: true });
      const elapsedSec = (nowMs - testBeatStartMs) / 1000;
      const step = testBeatTracker.step(elapsedSec, fx.bpm, fx.off);
      if (step.isBeat) {
        flashBeatLamp(nowMs);
        triggerPreviewBeatFx(step.k, { ...fx, on: true });
        if (!state.rehearsalMode) {
          window.api.sendToLed({ type: 'beat', k: step.k, fx: { ...fx, on: true } });
        }
      }
    } else if (liveCue && liveCue.fx && liveCue.fx.on && liveCue.fx.src === 'bpm' && track.playing) {
      const fx = liveCue.fx;
      const res = bpmBeatTracker.step(track.currentTime, fx.bpm, fx.off);
      if (res.isBeat) {
        flashBeatLamp(nowMs);
        triggerPreviewBeatFx(res.k, fx);
        if (!state.rehearsalMode) {
          window.api.sendToLed({ type: 'beat', k: res.k, fx });
        }
      }
    }

    // 4. Tick OV3 Event Timer
    if (overlaysUi) {
      overlaysUi.tick(nowMs);
    }

    // 5. DMX Frame (~35Hz) & 8-Fixture Stage LED Visualizer
    const dmxCfg = ledDmxUi ? ledDmxUi.getDmxConfig() : state.project.dmxConfig;
    const dmxIntervalMs = 1000 / logic.clamp(dmxCfg && dmxCfg.fps ? dmxCfg.fps : 35, 5, 44);
    if (nowMs - state.lastDmxSentMs >= dmxIntervalMs) {
      state.lastDmxSentMs = nowMs;
      let dmxLedSync = activeLedSync;
      let dmxPulse = state.beatPulseLevel;
      if (ledDmxUi && ledDmxUi.momentaryState.strobe) {
        dmxLedSync = { ...activeLedSync, on: true, dmxMode: 'strobe', intensity: 100 };
        dmxPulse = 1;
      } else if (ledDmxUi && (ledDmxUi.momentaryState.flash || ledDmxUi.momentaryState.drop)) {
        dmxLedSync = { ...activeLedSync, on: true, dmxMode: 'beat-flash', intensity: 100 };
        dmxPulse = 1;
      }
      const dmxBeat = {
        phase: clockStep.phase,
        beatInBar: clockStep.beatInBar,
        beatIndex: clockStep.beatIndex,
        pulse: dmxPulse
      };
      const frame = logic.computeDmxFrame(dmxCfg, dmxLedSync, dmxBeat, state.lastAudioBands, nowMs);
      if (ledDmxUi) ledDmxUi.updateStageVisualizer(frame.previews);
      if (dmxCfg && dmxCfg.enabled && !state.rehearsalMode) {
        window.api.sendDmxFrame(frame.channels);
      }
    }

    // 6. Stage Display update (~4Hz)
    if (nowMs - state.lastStageSentMs >= 250) {
      state.lastStageSentMs = nowMs;
      pushStageUpdate(false);
    }

    requestAnimationFrame(animationLoop);
  }

  // =========================================================================
  // BẢNG 6 NÚT VUÔNG HIỆU ỨNG NHANH (DJ CUE PADS) & HỘP THOẠI CÀI ĐẶT CHUNG
  // =========================================================================

  function ensureSixSfxPads() {
    state.project.sfxPads = logic.createDefaultSfxPads(state.project.sfxPads);
  }

  function renderSfxPads() {
    ensureSixSfxPads();
    if (appInputMapper) {
      appInputMapper.setSfxHotkeys(state.project.sfxPads);
    }

    const hintEl = $('sfx-hotkey-hint');
    if (hintEl) {
      const labels = state.project.sfxPads
        .map((p) => (p.hotkey ? p.hotkeyLabel || p.hotkey : ''))
        .filter((lbl) => lbl && lbl !== '---');
      hintEl.textContent = labels.length > 0 ? `Phím tắt: ${labels.join(' · ')}` : 'Chưa gán phím tắt';
    }

    const container = $('sfx-pads');
    if (!container) return;
    container.innerHTML = '';
    const playingIds = audioEngine.getPlayingSfxPadIds();

    state.project.sfxPads.forEach((pad, idx) => {
      const btn = document.createElement('button');
      const colorCls = pad.color ? `pad-${pad.color}` : 'pad-cyber';
      const keyLabel = pad.hotkey ? (pad.hotkeyLabel || pad.hotkey) : '---';
      const isBursting = sfxBurstTimers.has(pad.id);

      btn.className =
        `sfx-square-pad ${colorCls}` +
        (pad.path ? ' has-file' : '') +
        (playingIds.has(pad.id) ? ' is-playing' : '') +
        (isBursting ? ' is-dj-burst' : '');
      btn.dataset.padId = pad.id;
      btn.title = pad.path
        ? `${pad.name} — ${window.api.baseName(pad.path)} (Phím ${keyLabel})`
        : `${pad.name} — Chưa có file (Bấm "⚙ Cài đặt SFX" để chọn file & gán phím)`;

      const top = document.createElement('div');
      top.className = 'sfx-pad-top';
      const keySpan = document.createElement('span');
      keySpan.className = 'sfx-pad-key';
      keySpan.textContent = keyLabel;
      const dotSpan = document.createElement('span');
      dotSpan.className = 'sfx-pad-dot';
      top.appendChild(keySpan);
      top.appendChild(dotSpan);

      const nameSpan = document.createElement('div');
      nameSpan.className = 'sfx-pad-name';
      nameSpan.textContent = pad.name;

      const ledBar = document.createElement('div');
      ledBar.className = 'sfx-pad-led-bar';

      btn.appendChild(top);
      btn.appendChild(nameSpan);
      btn.appendChild(ledBar);

      btn.addEventListener('click', () => triggerSfxPad(idx));

      btn.addEventListener('dragover', (e) => {
        if (state.showMode || !isExternalFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        btn.classList.add('is-dragover');
      });
      btn.addEventListener('dragleave', () => btn.classList.remove('is-dragover'));
      btn.addEventListener('drop', async (e) => {
        btn.classList.remove('is-dragover');
        if (state.showMode || !isExternalFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const paths = extractDroppedFilePaths(e);
        if (paths.length === 0) return;
        if (logic.detectMediaKind(paths[0]) !== 'audio') {
          showBanner('Ô hiệu ứng SFX chỉ nhận tệp âm thanh (MP3, WAV, M4A, OGG, FLAC...).');
          return;
        }
        pushUndoSnapshot();
        pad.path = paths[0];
        const defaultNames = ['Vỗ tay', 'Fanfare', 'Trống hồi', 'Ting!', 'Hò reo', 'Báo hiệu'];
        if (defaultNames.includes(pad.name)) {
          pad.name = window.api.fileStem(paths[0]).slice(0, 16);
        }
        scheduleAutosave();
        await verifyAllMediaFiles();
        renderSfxPads();
        syncRemoteState();
        showBanner(`Đã gán âm thanh "${window.api.baseName(paths[0])}" vào ô SFX "${pad.name}".`);
      });

      container.appendChild(btn);
    });
  }

  function triggerDjPadBurst(padId, durationMs = 580) {
    let targetBtn = null;
    document.querySelectorAll('.sfx-square-pad').forEach((btn) => {
      if (btn.dataset.padId === padId) targetBtn = btn;
    });

    if (sfxBurstTimers.has(padId)) {
      clearTimeout(sfxBurstTimers.get(padId));
      sfxBurstTimers.delete(padId);
    }

    if (targetBtn) {
      targetBtn.classList.remove('is-dj-burst');
      void targetBtn.offsetWidth;
      targetBtn.classList.add('is-dj-burst');
    }

    const timer = setTimeout(() => {
      sfxBurstTimers.delete(padId);
      document.querySelectorAll('.sfx-square-pad').forEach((btn) => {
        if (btn.dataset.padId === padId) {
          btn.classList.remove('is-dj-burst');
        }
      });
    }, durationMs);
    sfxBurstTimers.set(padId, timer);
  }

  function updatePlayingSfxHighlights(playingIds) {
    document.querySelectorAll('.sfx-square-pad').forEach((btn) => {
      btn.classList.toggle('is-playing', playingIds.has(btn.dataset.padId));
    });
  }

  function renderSfxSettingsModal() {
    ensureSixSfxPads();
    const listEl = $('sfx-settings-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    state.project.sfxPads.forEach((pad, idx) => {
      const row = document.createElement('div');
      row.className = 'sfx-setting-row';

      const num = document.createElement('div');
      num.className = 'sfx-setting-num';
      num.textContent = `#${idx + 1}`;

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = pad.name;
      nameInput.placeholder = `Tên ô ${idx + 1}`;
      nameInput.addEventListener('input', () => {
        pad.name = nameInput.value.trim() || `SFX ${idx + 1}`;
        scheduleAutosave();
        renderSfxPads();
        syncRemoteState();
      });

      const keyBtn = document.createElement('button');
      keyBtn.type = 'button';
      keyBtn.className = 'btn-key-bind';
      keyBtn.dataset.keepFocus = '1';
      const currentKeyText = pad.hotkey && pad.hotkeyLabel ? pad.hotkeyLabel : 'Chưa gán';
      keyBtn.textContent = `Phím: ${currentKeyText}`;
      keyBtn.title = 'Bấm vào đây rồi nhấn phím trên bàn phím (ví dụ F1–F12) để gán. Nhấn Backspace/Delete để gỡ phím, Esc để hủy.';
      keyBtn.addEventListener('click', () => {
        listEl.querySelectorAll('.btn-key-bind').forEach((b, bIdx) => {
          b.classList.remove('is-learning');
          const p = state.project.sfxPads[bIdx];
          const lbl = p && p.hotkey && p.hotkeyLabel ? p.hotkeyLabel : 'Chưa gán';
          b.textContent = `Phím: ${lbl}`;
        });
        keyBtn.classList.add('is-learning');
        keyBtn.textContent = 'Nhấn phím...';
        if (appInputMapper) appInputMapper.startSfxKeyLearn(idx);
      });

      const pathInput = document.createElement('input');
      pathInput.type = 'text';
      pathInput.readOnly = true;
      pathInput.value = pad.path || '';
      pathInput.placeholder = 'Chưa chọn tệp âm thanh...';

      const volWrap = document.createElement('div');
      volWrap.className = 'sfx-setting-vol';
      const volLabel = document.createElement('span');
      volLabel.innerHTML = `Âm lượng: <b>${pad.vol ?? 90}%</b>`;
      const volSlider = document.createElement('input');
      volSlider.type = 'range';
      volSlider.min = '0';
      volSlider.max = '100';
      volSlider.value = String(pad.vol ?? 90);
      volSlider.addEventListener('input', () => {
        pad.vol = Number(volSlider.value);
        volLabel.innerHTML = `Âm lượng: <b>${pad.vol}%</b>`;
        scheduleAutosave();
      });
      volWrap.appendChild(volLabel);
      volWrap.appendChild(volSlider);

      const btnGroup = document.createElement('div');
      btnGroup.className = 'btn-row-tight';

      const pickBtn = document.createElement('button');
      pickBtn.className = 'btn btn-sm btn-emerald';
      pickBtn.textContent = 'Chọn file';
      pickBtn.addEventListener('click', async () => {
        if (appInputMapper) appInputMapper.cancelSfxKeyLearn();
        const files = await window.api.pickAudio();
        if (!files || files.length === 0) return;
        pushUndoSnapshot();
        pad.path = files[0];
        const defaultNames = ['Vỗ tay', 'Fanfare', 'Trống hồi', 'Ting!', 'Hò reo', 'Báo hiệu'];
        if (defaultNames.includes(pad.name)) {
          pad.name = window.api.fileStem(files[0]).slice(0, 16);
        }
        scheduleAutosave();
        renderSfxPads();
        renderSfxSettingsModal();
        syncRemoteState();
      });

      const testBtn = document.createElement('button');
      testBtn.className = 'btn btn-sm btn-fx';
      testBtn.textContent = '▶';
      testBtn.title = 'Nghe thử hiệu ứng này';
      testBtn.disabled = !pad.path;
      testBtn.addEventListener('click', () => triggerSfxPad(idx));

      const clearBtn = document.createElement('button');
      clearBtn.className = 'btn btn-sm';
      clearBtn.textContent = 'Xóa';
      clearBtn.disabled = !pad.path;
      clearBtn.addEventListener('click', () => {
        if (appInputMapper) appInputMapper.cancelSfxKeyLearn();
        pushUndoSnapshot();
        pad.path = null;
        scheduleAutosave();
        renderSfxPads();
        renderSfxSettingsModal();
      });

      btnGroup.appendChild(pickBtn);
      btnGroup.appendChild(testBtn);
      btnGroup.appendChild(clearBtn);

      row.appendChild(num);
      row.appendChild(nameInput);
      row.appendChild(keyBtn);
      row.appendChild(pathInput);
      row.appendChild(volWrap);
      row.appendChild(btnGroup);

      row.addEventListener('dragover', (e) => {
        if (!isExternalFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        row.classList.add('is-dragover');
      });
      row.addEventListener('dragleave', () => row.classList.remove('is-dragover'));
      row.addEventListener('drop', async (e) => {
        row.classList.remove('is-dragover');
        if (!isExternalFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const paths = extractDroppedFilePaths(e);
        if (paths.length === 0) return;
        if (logic.detectMediaKind(paths[0]) !== 'audio') {
          showBanner('Hàng cài đặt SFX chỉ nhận tệp âm thanh (MP3, WAV, M4A, OGG, FLAC...).');
          return;
        }
        pushUndoSnapshot();
        pad.path = paths[0];
        const defaultNames = ['Vỗ tay', 'Fanfare', 'Trống hồi', 'Ting!', 'Hò reo', 'Báo hiệu'];
        if (defaultNames.includes(pad.name)) {
          pad.name = window.api.fileStem(paths[0]).slice(0, 16);
        }
        scheduleAutosave();
        await verifyAllMediaFiles();
        renderSfxPads();
        renderSfxSettingsModal();
        syncRemoteState();
      });

      listEl.appendChild(row);
    });
  }

  function openSfxSettingsModal() {
    if (state.showMode) return;
    if (appInputMapper) appInputMapper.cancelSfxKeyLearn();
    renderSfxSettingsModal();
    $('sfx-settings-modal').classList.remove('hidden');
  }

  function triggerSfxPad(idx) {
    ensureSixSfxPads();
    const pad = state.project.sfxPads[idx];
    if (!pad) return;

    triggerDjPadBurst(pad.id);

    if (!pad.path) {
      const keyTag = pad.hotkey && pad.hotkeyLabel ? ` [${pad.hotkeyLabel}]` : '';
      showBanner(`Ô SFX "${pad.name}"${keyTag} chưa được gán tệp âm thanh — bấm "⚙ Cài đặt SFX" khi cần chọn file.`);
      return;
    }

    const url = window.api.toFileUrl(pad.path, state.projectFilePath);
    state.sfxVuLevel = (Number($('sfx-master-vol').value) / 100) * ((pad.vol ?? 90) / 100) * 0.96;
    audioEngine.playSfx(pad, url);
  }

  // =========================================================================
  // MENU DROPDOWN & GÁN SỰ KIỆN GIAO DIỆN
  // =========================================================================

  function closeAllMenus() {
    document.querySelectorAll('.menu-dropdown').forEach((d) => d.classList.add('hidden'));
    document.querySelectorAll('.menu-trigger').forEach((b) => b.classList.remove('open'));
  }

  function bindUiEvents() {
    // Dropdown menu trên Header
    document.querySelectorAll('.menu-trigger[data-menu]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const menuEl = $(btn.dataset.menu);
        const wasOpen = !menuEl.classList.contains('hidden');
        closeAllMenus();
        if (!wasOpen) {
          menuEl.classList.remove('hidden');
          btn.classList.add('open');
        }
      });
    });

    document.querySelectorAll('.menu-dropdown').forEach((drop) => {
      drop.addEventListener('click', (e) => {
        if (e.target.closest('.menu-action')) {
          closeAllMenus();
        } else {
          e.stopPropagation();
        }
      });
    });

    document.addEventListener('click', () => closeAllMenus());

    // Segmented Mode Pills
    document.querySelectorAll('.seg-pill').forEach((btn) => {
      btn.addEventListener('click', () => setOperatingMode(btn.dataset.mode));
    });

    // Khởi tạo giao diện docked + Bottom Drawer + List/Grid + Resizers kiểu FreeShow
    initFreeShowDrawerAndResizers();

    // Right Column Tabs Thuộc tính Cue
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        activateInspectorTab(btn.dataset.tab);
      });
    });

    $('alert-banner-close').addEventListener('click', hideBanner);

    // Status pills & Gear trên Topbar
    const toggleLedAction = async () => {
      if (state.ledStatus.isOpen) {
        const st = await window.api.closeLed();
        renderLedAndDisplayUi(st);
        syncLivePreviewVideoAudio();
      } else {
        const st = await window.api.openLed($('display-select').value);
        renderLedAndDisplayUi(st);
        syncLivePreviewVideoAudio();
      }
    };
    $('btn-toggle-led').addEventListener('click', toggleLedAction);
    $('led-status-pill').addEventListener('click', toggleLedAction);

    const toggleStageAction = async () => {
      if (state.stageStatus && state.stageStatus.isOpen) {
        const st = await window.api.closeStage();
        renderStageDisplayUi(st);
      } else {
        const sel = $('stage-display-select');
        const st = await window.api.openStage(sel ? sel.value : 'auto');
        renderStageDisplayUi(st);
        pushStageUpdate(true);
      }
    };
    $('stage-status-pill').addEventListener('click', toggleStageAction);
    $('btn-toggle-stage').addEventListener('click', toggleStageAction);

    $('audio-status-pill').addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllMenus();
      $('menu-options').classList.remove('hidden');
    });

    $('input-status-pill').addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllMenus();
      $('menu-options').classList.remove('hidden');
    });

    $('ext-input-enable').addEventListener('change', async (e) => {
      await enableExternalMixerInput(e.target.checked);
    });

    const onExtDeviceChange = async (e) => {
      const id = e.target.value;
      if ($('audio-input-select')) $('audio-input-select').value = id;
      if ($('fx-ext-device')) $('fx-ext-device').value = id;
      state.settings.extDeviceId = id;
      window.api.setSettings({ extDeviceId: id });
      if (audioEngine.isExternalInputActive() || ($('ext-input-enable') && $('ext-input-enable').checked)) {
        await enableExternalMixerInput(true, id);
      }
    };
    $('audio-input-select').addEventListener('change', onExtDeviceChange);
    $('fx-ext-device').addEventListener('change', onExtDeviceChange);

    const onExtGainInput = (e) => {
      const val = logic.clamp(Number(e.target.value), 20, 400);
      if ($('ext-input-gain')) $('ext-input-gain').value = val;
      if ($('fx-ext-gain')) $('fx-ext-gain').value = val;
      if ($('ext-input-gain-v')) $('ext-input-gain-v').textContent = val;
      if ($('fx-ext-gain-v')) $('fx-ext-gain-v').textContent = val;
      audioEngine.setExternalGain(val);
      state.settings.extGain = val;
      window.api.setSettings({ extGain: val });
    };
    $('ext-input-gain').addEventListener('input', onExtGainInput);
    $('fx-ext-gain').addEventListener('input', onExtGainInput);

    $('display-select').addEventListener('change', async () => {
      if (state.ledStatus.isOpen) {
        const st = await window.api.openLed($('display-select').value);
        renderLedAndDisplayUi(st);
      }
    });

    $('chk-auto-open-led').addEventListener('change', (e) => {
      window.api.setSettings({ autoOpenLed: e.target.checked });
    });

    $('audio-device-select').addEventListener('change', async (e) => {
      const id = e.target.value;
      const res = await audioEngine.setOutputDevice(id);
      if (!res.ok) {
        showBanner('Không đổi được thiết bị phát âm thanh: ' + res.error);
      } else {
        state.settings.audioDeviceId = id;
        window.api.setSettings({ audioDeviceId: id });
        updateAudioBadgeLabel();
        syncLivePreviewVideoAudio();
        if (!state.rehearsalMode) {
          window.api.sendToLed({ type: 'video-audio', sinkId: id });
        }
      }
    });

    // Switcher Strip (T-Bar + CUT / FADE / WIPE / FTB)
    $('tbar-slider').addEventListener('input', (e) => {
      handleTbarInput(Number(e.target.value));
    });
    $('btn-sw-cut').addEventListener('click', () => triggerSelectedWithTransition('cut', 0));
    $('btn-sw-fade').addEventListener('click', () => triggerSelectedWithTransition('fade'));
    $('btn-sw-wipe').addEventListener('click', () => triggerSelectedWithTransition('wipe-left'));
    $('btn-sw-ftb').addEventListener('click', () => toggleBlackout());

    // Nút GO & Nút chức năng & Bảng 6 ô SFX
    $('btn-go').addEventListener('click', handleGo);
    $('btn-blackout').addEventListener('click', () => toggleBlackout());
    $('btn-fade-music').addEventListener('click', fadeOutMusicPanic);
    $('btn-stop-all').addEventListener('click', stopAllPanic);
    $('btn-test-pattern').addEventListener('click', toggleTestPattern);
    $('btn-sfx-settings').addEventListener('click', openSfxSettingsModal);
    $('btn-close-sfx-settings').addEventListener('click', () => {
      if (appInputMapper) appInputMapper.cancelSfxKeyLearn();
      $('sfx-settings-modal').classList.add('hidden');
    });
    $('sfx-settings-modal').addEventListener('click', (e) => {
      if (e.target === $('sfx-settings-modal')) {
        if (appInputMapper) appInputMapper.cancelSfxKeyLearn();
        $('sfx-settings-modal').classList.add('hidden');
      }
    });
    $('btn-stop-sfx').addEventListener('click', () => {
      audioEngine.stopAllSfx(0.25);
      state.sfxVuLevel = 0;
    });

    // Live FX Rack (Master FX)
    const bindMfx = (id, evName, fn) => {
      $(id).addEventListener(evName, (e) => {
        fn(state.project.masterFx, e.target);
        scheduleAutosave();
        renderMasterFxControls();
        pushMasterFxToLed();
      });
    };
    bindMfx('mfx-dimmer', 'input', (fx, el) => { fx.dimmer = logic.clamp(el.value, 0, 100); });
    bindMfx('mfx-contrast', 'input', (fx, el) => { fx.contrast = logic.clamp(el.value, 50, 200); });
    bindMfx('mfx-saturate', 'input', (fx, el) => { fx.saturate = logic.clamp(el.value, 0, 250); });
    bindMfx('mfx-hue', 'input', (fx, el) => { fx.hue = logic.clamp(el.value, -180, 180); });
    bindMfx('mfx-rgbsplit', 'input', (fx, el) => { fx.rgbSplit = logic.clamp(el.value, 0, 40); });
    bindMfx('mfx-rgb-beat', 'change', (fx, el) => { fx.rgbBeatLink = el.checked; });
    bindMfx('mfx-glitch', 'input', (fx, el) => { fx.glitch = logic.clamp(el.value, 0, 100); });
    bindMfx('mfx-glitch-beat', 'change', (fx, el) => { fx.glitchBeatLink = el.checked; });
    bindMfx('mfx-vignette', 'input', (fx, el) => { fx.vignette = logic.clamp(el.value, 0, 100); });
    bindMfx('mfx-pixelate', 'input', (fx, el) => { fx.pixelate = logic.clamp(el.value, 0, 40); });
    bindMfx('mfx-mirror', 'change', (fx, el) => { fx.mirror = el.value; });
    bindMfx('mfx-invert', 'change', (fx, el) => { fx.invert = el.checked; });
    $('btn-reset-master-fx').addEventListener('click', () => {
      state.project.masterFx = logic.createDefaultMasterFx();
      scheduleAutosave();
      renderMasterFxControls();
      pushMasterFxToLed();
    });

    // Output Mapping & Stage Display Modal
    const openMappingStageModal = async () => {
      renderMappingControls();
      const st = await window.api.getStageStatus();
      renderStageDisplayUi(st);
      $('mapping-stage-modal').classList.remove('hidden');
    };
    $('btn-open-mapping-modal').addEventListener('click', openMappingStageModal);
    $('btn-open-stage-modal').addEventListener('click', openMappingStageModal);
    $('btn-close-mapping-modal').addEventListener('click', () => $('mapping-stage-modal').classList.add('hidden'));
    $('mapping-stage-modal').addEventListener('click', (e) => {
      if (e.target === $('mapping-stage-modal')) $('mapping-stage-modal').classList.add('hidden');
    });

    const bindMap = (id, evName, fn) => {
      $(id).addEventListener(evName, (e) => {
        fn(state.project.outputMapping, e.target);
        scheduleAutosave();
        renderMappingControls();
        pushOutputMappingToLed();
      });
    };
    bindMap('map-crop-top', 'input', (m, el) => { m.cropTop = logic.clamp(el.value, 0, 45); });
    bindMap('map-crop-bottom', 'input', (m, el) => { m.cropBottom = logic.clamp(el.value, 0, 45); });
    bindMap('map-crop-left', 'input', (m, el) => { m.cropLeft = logic.clamp(el.value, 0, 45); });
    bindMap('map-crop-right', 'input', (m, el) => { m.cropRight = logic.clamp(el.value, 0, 45); });
    bindMap('map-offset-x', 'input', (m, el) => { m.offsetX = logic.clamp(el.value, -400, 400); });
    bindMap('map-offset-y', 'input', (m, el) => { m.offsetY = logic.clamp(el.value, -400, 400); });
    bindMap('map-scale-x', 'input', (m, el) => { m.scaleX = logic.clamp(el.value, 20, 200); });
    bindMap('map-scale-y', 'input', (m, el) => { m.scaleY = logic.clamp(el.value, 20, 200); });
    bindMap('map-rotate-x', 'input', (m, el) => { m.rotateX = logic.clamp(el.value, -35, 35); });
    bindMap('map-rotate-y', 'input', (m, el) => { m.rotateY = logic.clamp(el.value, -35, 35); });
    bindMap('map-perspective', 'input', (m, el) => { m.perspective = logic.clamp(el.value, 300, 3000); });
    bindMap('map-flip-h', 'change', (m, el) => { m.flipH = el.checked; });
    bindMap('map-flip-v', 'change', (m, el) => { m.flipV = el.checked; });
    $('btn-reset-mapping').addEventListener('click', () => {
      state.project.outputMapping = logic.createDefaultOutputMapping();
      scheduleAutosave();
      renderMappingControls();
      pushOutputMappingToLed();
    });

    // Âm lượng Master & SFX
    $('master-vol').addEventListener('input', (e) => {
      const val = Number(e.target.value);
      $('master-vol-val').textContent = val + '%';
      audioEngine.setMasterVolume(val);
      window.api.setSettings({ masterVol: val });
      syncLivePreviewVideoAudio();
      if (!state.rehearsalMode) {
        window.api.sendToLed({ type: 'video-audio', masterVol: val });
      }
    });

    $('sfx-master-vol').addEventListener('input', (e) => {
      const val = Number(e.target.value);
      $('sfx-vol-val').textContent = val + '%';
      audioEngine.setSfxVolume(val);
    });

    $('track-seek').addEventListener('mousedown', () => { state.isSeekingAudio = true; });
    $('track-seek').addEventListener('mouseup', () => {
      state.isSeekingAudio = false;
      const track = audioEngine.getCurrentTrackInfo();
      if (track.duration > 0) {
        audioEngine.seekActive((Number($('track-seek').value) / 1000) * track.duration);
      }
    });
    $('track-seek').addEventListener('change', () => {
      state.isSeekingAudio = false;
      const track = audioEngine.getCurrentTrackInfo();
      if (track.duration > 0) {
        audioEngine.seekActive((Number($('track-seek').value) / 1000) * track.duration);
      }
    });

    // Quản lý danh sách Cue
    $('btn-add-cue').addEventListener('click', () => {
      if (state.showMode) return;
      pushUndoSnapshot();
      const cue = logic.createDefaultCue({ name: `Cue ${state.project.cues.length + 1}` });
      const insertAt = state.selectedIndex >= 0 ? state.selectedIndex + 1 : state.project.cues.length;
      state.project.cues.splice(insertAt, 0, cue);
      state.selectedIndex = insertAt;
      scheduleAutosave();
      onSelectionChanged();
    });

    $('btn-add-batch').addEventListener('click', pickAndImportBatchFiles);
    if ($('btn-import-files')) {
      $('btn-import-files').addEventListener('click', pickAndImportBatchFiles);
    }

    window.addEventListener('dragover', (e) => {
      if (isExternalFileDrag(e)) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (isExternalFileDrag(e)) {
        e.preventDefault();
        clearCuePanelDragVisuals();
      }
    });

    const cuePanelEl = $('cue-panel');
    if (cuePanelEl) {
      cuePanelEl.addEventListener('dragenter', (e) => {
        if (!isExternalFileDrag(e)) return;
        e.preventDefault();
        if (!state.showMode) cuePanelEl.classList.add('is-file-dragover');
      });
      cuePanelEl.addEventListener('dragover', (e) => {
        if (!isExternalFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = state.showMode ? 'none' : 'copy';
        if (!state.showMode) cuePanelEl.classList.add('is-file-dragover');
      });
      cuePanelEl.addEventListener('dragleave', (e) => {
        if (e.relatedTarget && cuePanelEl.contains(e.relatedTarget)) return;
        clearCuePanelDragVisuals();
      });
      cuePanelEl.addEventListener('drop', (e) => {
        if (!isExternalFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        clearCuePanelDragVisuals();
        const droppedPaths = extractDroppedFilePaths(e);
        if (droppedPaths.length > 0) {
          importMediaFilesIntoCueList(droppedPaths, { insertAt: state.project.cues.length });
        }
      });
    }

    $('btn-dup-cue').addEventListener('click', () => {
      if (state.showMode) return;
      const cue = getSelectedCue();
      if (!cue) return;
      pushUndoSnapshot();
      const copy = logic.normalizeCue({
        ...JSON.parse(JSON.stringify(cue)),
        id: logic.generateId(),
        name: cue.name + ' (Bản sao)'
      });
      state.project.cues.splice(state.selectedIndex + 1, 0, copy);
      state.selectedIndex += 1;
      scheduleAutosave();
      onSelectionChanged();
    });

    $('btn-del-cue').addEventListener('click', () => {
      if (state.showMode) return;
      const cue = getSelectedCue();
      if (!cue) return;
      if (!window.confirm(`Xác nhận xóa Cue "${cue.name}"?`)) return;
      pushUndoSnapshot();
      state.project.cues.splice(state.selectedIndex, 1);
      if (state.selectedIndex >= state.project.cues.length) {
        state.selectedIndex = state.project.cues.length - 1;
      }
      scheduleAutosave();
      onSelectionChanged();
    });

    $('btn-move-up').addEventListener('click', () => {
      if (state.showMode || state.selectedIndex <= 0) return;
      pushUndoSnapshot();
      const i = state.selectedIndex;
      const arr = state.project.cues;
      [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
      state.selectedIndex = i - 1;
      scheduleAutosave();
      onSelectionChanged();
    });

    $('btn-move-down').addEventListener('click', () => {
      if (state.showMode || state.selectedIndex < 0 || state.selectedIndex >= state.project.cues.length - 1) return;
      pushUndoSnapshot();
      const i = state.selectedIndex;
      const arr = state.project.cues;
      [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
      state.selectedIndex = i + 1;
      scheduleAutosave();
      onSelectionChanged();
    });

    $('btn-undo').addEventListener('click', performUndo);
    $('btn-redo').addEventListener('click', performRedo);
    $('btn-menu-undo').addEventListener('click', performUndo);
    $('btn-menu-redo').addEventListener('click', performRedo);

    $('btn-open-proj').addEventListener('click', openProjectAction);
    $('btn-save-proj').addEventListener('click', () => saveProjectAction(false));
    $('btn-save-as-proj').addEventListener('click', () => saveProjectAction(true));
    $('btn-collect-proj').addEventListener('click', collectProjectAction);

    // Form chỉnh sửa Thuộc tính Cue
    const bindCueEdit = (elId, eventName, updater) => {
      $(elId).addEventListener(eventName, (e) => {
        const cue = getSelectedCue();
        if (!cue) return;
        updater(cue, e.target);
        scheduleAutosave();
        renderCueList();
        renderMonitors();
        pushStageUpdate(false);
      });
    };

    bindCueEdit('ed-name', 'input', (c, el) => {
      if (state.showMode) return;
      c.name = el.value.trim() || 'Cue chưa đặt tên';
    });
    bindCueEdit('ed-note', 'input', (c, el) => { if (!state.showMode) c.note = el.value; });
    bindCueEdit('ed-source-type', 'change', (c, el) => {
      if (state.showMode) return;
      c.sourceType = ['media', 'camera', 'generator'].includes(el.value) ? el.value : 'media';
      syncCueSourceTypeVisibility(c.sourceType);
      if (c.sourceType === 'camera') refreshCameraDevices();
    });
    bindCueEdit('ed-camera-id', 'change', (c, el) => {
      if (!state.showMode) c.cameraId = el.value || '';
    });
    $('btn-refresh-cameras').addEventListener('click', () => refreshCameraDevices());
    bindCueEdit('ed-generator', 'change', (c, el) => {
      if (!state.showMode) c.generator = el.value || 'laser-beams';
    });
    bindCueEdit('ed-tr', 'change', (c, el) => { if (!state.showMode) c.tr = el.value; });
    bindCueEdit('ed-dur', 'input', (c, el) => { if (!state.showMode) c.dur = logic.clamp(el.value, 0, 10); });
    bindCueEdit('ed-fit', 'change', (c, el) => {
      if (!state.showMode) c.fit = el.value === 'cover' ? 'cover' : 'contain';
    });
    bindCueEdit('ed-loop', 'change', (c, el) => { if (!state.showMode) c.loop = el.checked; });
    $('ed-vsound').addEventListener('change', (e) => {
      const cue = getSelectedCue();
      if (!cue) return;
      cue.vsound = e.target.checked;
      syncAllToggleSections(cue);
      scheduleAutosave();
      sendLiveVideoAudioIfActive(cue);
    });
    $('ed-vvol').addEventListener('input', (e) => {
      const cue = getSelectedCue();
      if (!cue) return;
      cue.vvol = logic.clamp(e.target.value, 0, 100);
      $('ed-vvol-val').textContent = cue.vvol;
      scheduleAutosave();
      sendLiveVideoAudioIfActive(cue);
    });
    bindCueEdit('ed-autofollow', 'change', (c, el) => {
      if (state.showMode) return;
      c.autoFollow = el.value;
      syncAllToggleSections(c);
    });
    bindCueEdit('ed-autodelay', 'change', (c, el) => {
      if (!state.showMode) c.autoDelay = logic.clamp(el.value, 0.2, 3600);
    });

    const pickVisualAction = async () => {
      if (state.showMode) return;
      const files = await window.api.pickVisual();
      if (!files || files.length === 0) return;
      await assignVisualFileToSelectedCue(files[0], false);
    };

    const pickAudioAction = async () => {
      if (state.showMode) return;
      const files = await window.api.pickAudio();
      if (!files || files.length === 0) return;
      await assignAudioFileToSelectedCue(files[0], false);
    };

    $('btn-pick-vis').addEventListener('click', (e) => {
      e.stopPropagation();
      pickVisualAction();
    });

    $('btn-clear-vis').addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.showMode) return;
      const cue = getSelectedCue();
      if (!cue) return;
      pushUndoSnapshot();
      cue.vis = null;
      scheduleAutosave();
      renderEditor();
      renderCueList();
      renderMonitors();
    });

    $('btn-pick-aud').addEventListener('click', (e) => {
      e.stopPropagation();
      pickAudioAction();
    });

    $('btn-clear-aud').addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.showMode) return;
      const cue = getSelectedCue();
      if (!cue) return;
      pushUndoSnapshot();
      cue.aud = null;
      cue.startAt = 0;
      cue.endAt = 0;
      scheduleAutosave();
      renderEditor();
      renderCueList();
      renderMonitors();
    });

    const bindMediaDropzone = (zoneId, paneId, onClickAction, onDropFilePath) => {
      const zone = $(zoneId);
      const pane = $(paneId);
      if (zone) {
        zone.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          onClickAction();
        });
        zone.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClickAction();
          }
        });
      }

      const attachDropEvents = (containerEl, highlightEl) => {
        if (!containerEl || !highlightEl) return;
        containerEl.addEventListener('dragenter', (e) => {
          if (!isExternalFileDrag(e)) return;
          e.preventDefault();
          if (!state.showMode) highlightEl.classList.add('is-dragover');
        });
        containerEl.addEventListener('dragover', (e) => {
          if (!isExternalFileDrag(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = state.showMode ? 'none' : 'copy';
          if (!state.showMode) highlightEl.classList.add('is-dragover');
        });
        containerEl.addEventListener('dragleave', (e) => {
          if (e.relatedTarget && containerEl.contains(e.relatedTarget)) return;
          highlightEl.classList.remove('is-dragover');
        });
        containerEl.addEventListener('drop', async (e) => {
          if (!isExternalFileDrag(e)) return;
          e.preventDefault();
          e.stopPropagation();
          highlightEl.classList.remove('is-dragover');
          const paths = extractDroppedFilePaths(e);
          if (paths.length > 0) await onDropFilePath(paths[0]);
        });
      };

      attachDropEvents(pane || zone, zone);
    };

    bindMediaDropzone('dropzone-vis', 'tab-general', pickVisualAction, (p) => assignVisualFileToSelectedCue(p, true));
    bindMediaDropzone('dropzone-aud', 'tab-audio', pickAudioAction, (p) => assignAudioFileToSelectedCue(p, true));

    const emptyEditorEl = $('editor-empty');
    if (emptyEditorEl) {
      emptyEditorEl.addEventListener('dragover', (e) => {
        if (!isExternalFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = state.showMode ? 'none' : 'copy';
      });
      emptyEditorEl.addEventListener('drop', (e) => {
        if (!isExternalFileDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        const paths = extractDroppedFilePaths(e);
        if (paths.length > 0) importMediaFilesIntoCueList(paths);
      });
    }

    bindCueEdit('ed-keep-audio', 'change', (c, el) => {
      if (!state.showMode) {
        c.keepAudio = el.checked;
        c.stop = !el.checked;
        syncAllToggleSections(c);
      }
    });
    bindCueEdit('ed-vol', 'input', (c, el) => {
      c.vol = logic.clamp(el.value, 0, 100);
      $('ed-vol-val').textContent = c.vol;
    });
    bindCueEdit('ed-fadein', 'change', (c, el) => { if (!state.showMode) c.fadeIn = logic.clamp(el.value, 0, 15); });
    bindCueEdit('ed-fadeout', 'change', (c, el) => { if (!state.showMode) c.fadeOut = logic.clamp(el.value, 0, 15); });
    bindCueEdit('ed-startat', 'change', (c, el) => {
      if (state.showMode) return;
      c.startAt = Math.max(0, Number(el.value) || 0);
      renderWaveformForCue(c);
    });
    bindCueEdit('ed-endat', 'change', (c, el) => {
      if (state.showMode) return;
      c.endAt = Math.max(0, Number(el.value) || 0);
      renderWaveformForCue(c);
    });

    $('btn-reset-trim').addEventListener('click', () => {
      if (state.showMode) return;
      const cue = getSelectedCue();
      if (!cue) return;
      cue.startAt = 0;
      cue.endAt = 0;
      $('ed-startat').value = 0;
      $('ed-endat').value = 0;
      scheduleAutosave();
      renderWaveformForCue(cue);
    });

    $('waveform-canvas').addEventListener('mousedown', (e) => {
      if (state.showMode) return;
      const cue = getSelectedCue();
      const canvas = $('waveform-canvas');
      const dur = Number(canvas.dataset.duration) || 0;
      if (!cue || dur <= 0) return;
      const rect = canvas.getBoundingClientRect();
      const ratio = logic.clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const sec = Number((ratio * dur).toFixed(2));
      if (e.button === 2) {
        cue.endAt = sec > cue.startAt ? sec : 0;
        $('ed-endat').value = cue.endAt;
      } else {
        cue.startAt = sec;
        if (cue.endAt > 0 && cue.endAt <= cue.startAt) {
          cue.endAt = 0;
          $('ed-endat').value = 0;
        }
        $('ed-startat').value = cue.startAt;
      }
      scheduleAutosave();
      renderWaveformForCue(cue);
    });
    $('waveform-canvas').addEventListener('contextmenu', (e) => e.preventDefault());

    // Hiệu ứng Beat FX & Rung nền
    const bindFxEdit = (elId, eventName, updater) => {
      $(elId).addEventListener(eventName, (e) => {
        const cue = getSelectedCue();
        if (!cue) return;
        updater(cue.fx, e.target);
        syncAllToggleSections(cue);
        scheduleAutosave();
        renderCueList();
        sendLiveCueFxIfActive(cue);
      });
    };

    bindFxEdit('fx-on', 'change', (fx, el) => {
      fx.on = el.checked;
      if (!fx.on && state.testBeatOn) {
        state.testBeatOn = false;
        $('btn-test-beat').classList.remove('is-active');
        $('btn-test-beat').textContent = 'Thử beat trên LED';
      }
    });
    bindFxEdit('fx-src', 'change', (fx, el) => {
      fx.src = ['auto', 'video', 'bpm', 'ext'].includes(el.value) ? el.value : 'auto';
      $('fx-bpm-controls').classList.toggle('hidden', fx.src !== 'bpm');
      $('fx-ext-controls').classList.toggle('hidden', fx.src !== 'ext');
      if ($('fx-video-controls')) $('fx-video-controls').classList.toggle('hidden', fx.src !== 'video');
      $('wrap-fx-delay').classList.toggle('hidden', fx.src === 'ext');
      if (fx.src === 'ext' && !audioEngine.isExternalInputActive()) {
        enableExternalMixerInput(true);
      } else {
        syncAnalysisSourceRouting();
      }
      updateVideoBeatStatusUi(performance.now(), true);
    });
    bindFxEdit('fx-bpm', 'input', (fx, el) => { fx.bpm = logic.clamp(el.value, 40, 240); });
    bindFxEdit('fx-off', 'input', (fx, el) => { fx.off = logic.clamp(el.value, -5, 5); });
    bindFxEdit('fx-motion', 'change', (fx, el) => {
      fx.motion = el.value;
      fx.step = el.value === 'step';
    });
    bindFxEdit('fx-over', 'change', (fx, el) => { fx.over = el.checked; });

    ['scale', 'shake', 'rot', 'bright', 'hue', 'flash', 'decay', 'sens'].forEach((k) => {
      bindFxEdit('fx-' + k, 'input', (fx, el) => {
        fx[k] = Number(el.value);
        $('fx-' + k + '-v').textContent = el.value;
      });
    });

    bindFxEdit('fx-min-interval', 'input', (fx, el) => {
      fx.minInterval = Number(el.value);
      $('fx-min-interval-v').textContent = el.value;
    });
    bindFxEdit('fx-bass-low', 'input', (fx, el) => {
      fx.bassLow = Number(el.value);
      if (fx.bassHigh <= fx.bassLow + 15) {
        fx.bassHigh = logic.clamp(fx.bassLow + 20, 80, 250);
        $('fx-bass-high').value = fx.bassHigh;
        $('fx-bass-high-v').textContent = fx.bassHigh;
      }
      $('fx-bass-low-v').textContent = el.value;
    });
    bindFxEdit('fx-bass-high', 'input', (fx, el) => {
      fx.bassHigh = Number(el.value);
      if (fx.bassHigh <= fx.bassLow + 15) {
        fx.bassLow = logic.clamp(fx.bassHigh - 20, 20, 80);
        $('fx-bass-low').value = fx.bassLow;
        $('fx-bass-low-v').textContent = fx.bassLow;
      }
      $('fx-bass-high-v').textContent = el.value;
    });
    bindFxEdit('fx-delay-ms', 'input', (fx, el) => {
      fx.delayMs = Number(el.value);
      $('fx-delay-ms-v').textContent = el.value;
    });

    bindFxEdit('fx-idle-on', 'change', (fx, el) => {
      fx.idleOn = el.checked;
      if (!fx.idleOn && state.testIdleOn) {
        state.testIdleOn = false;
        $('btn-test-idle').classList.remove('is-active');
        $('btn-test-idle').textContent = '▶ Thử rung nền';
        if (!state.rehearsalMode) {
          window.api.sendToLed({ type: 'test-idle', on: false, fx });
        }
      }
    });
    bindFxEdit('fx-idle-only-music', 'change', (fx, el) => { fx.idleOnlyMusic = el.checked; });
    bindFxEdit('fx-idle-style', 'change', (fx, el) => { fx.idleStyle = el.value === 'jitter' ? 'jitter' : 'smooth'; });
    [
      ['fx-idle-amp', 'idleAmp'],
      ['fx-idle-rot', 'idleRot'],
      ['fx-idle-breath', 'idleBreath'],
      ['fx-idle-speed', 'idleSpeed'],
      ['fx-idle-couple', 'idleCouple']
    ].forEach(([elId, key]) => {
      bindFxEdit(elId, 'input', (fx, el) => {
        fx[key] = Number(el.value);
        $(elId + '-v').textContent = el.value;
      });
    });

    const btnEnableVsound = $('btn-fx-enable-vsound');
    if (btnEnableVsound) {
      btnEnableVsound.addEventListener('click', () => {
        const cue = getLiveCue() || getSelectedCue();
        if (!cue) return;
        pushUndoSnapshot();
        cue.vsound = true;
        if ((cue.vvol ?? 0) <= 0) cue.vvol = 100;
        scheduleAutosave();
        renderEditor();
        sendLiveVideoAudioIfActive(cue);
        syncAnalysisSourceRouting();
      });
    }

    const btnFxGoSelected = $('btn-fx-go-selected');
    if (btnFxGoSelected) {
      btnFxGoSelected.addEventListener('click', () => {
        if (state.selectedIndex >= 0 && state.selectedIndex < state.project.cues.length) {
          triggerCueAt(state.selectedIndex, false);
        }
      });
    }

    $('btn-tap-bpm').addEventListener('click', handleTapBpm);

    $('btn-test-beat').addEventListener('click', () => {
      state.testBeatOn = !state.testBeatOn;
      $('btn-test-beat').classList.toggle('is-active', state.testBeatOn);
      $('btn-test-beat').textContent = state.testBeatOn ? '⏹ Dừng thử' : 'Thử beat';
      testBeatTracker.reset();
      testBeatStartMs = performance.now();
    });

    $('btn-test-idle').addEventListener('click', () => {
      state.testIdleOn = !state.testIdleOn;
      $('btn-test-idle').classList.toggle('is-active', state.testIdleOn);
      $('btn-test-idle').textContent = state.testIdleOn ? '⏹ Dừng rung' : '▶ Thử rung nền';
      const cue = getSelectedCue() || getLiveCue();
      if (!state.rehearsalMode) {
        window.api.sendToLed({
          type: 'test-idle',
          on: state.testIdleOn,
          fx: cue ? cue.fx : logic.createDefaultFx({ idleOn: true })
        });
      }
    });

    $('btn-save-preset').addEventListener('click', () => {
      const cue = getSelectedCue();
      if (!cue) return;
      const name = `Preset ${Object.keys(state.project.customFxPresets).length + 1} (${cue.name.slice(0, 10)})`;
      pushUndoSnapshot();
      state.project.customFxPresets[name] = {
        scale: cue.fx.scale, shake: cue.fx.shake, rot: cue.fx.rot,
        bright: cue.fx.bright, hue: cue.fx.hue, flash: cue.fx.flash,
        decay: cue.fx.decay, motion: cue.fx.motion, step: cue.fx.step,
        over: cue.fx.over, idleOn: cue.fx.idleOn, idleAmp: cue.fx.idleAmp,
        idleRot: cue.fx.idleRot, idleBreath: cue.fx.idleBreath,
        idleSpeed: cue.fx.idleSpeed, idleStyle: cue.fx.idleStyle,
        idleCouple: cue.fx.idleCouple, idleOnlyMusic: cue.fx.idleOnlyMusic
      };
      scheduleAutosave();
      renderFxPresets();
      showBanner(`Đã lưu bộ hiệu ứng riêng "${name}".`);
    });

    // Chữ trên LED
    const bindTextEdit = (elId, eventName, updater) => {
      $(elId).addEventListener(eventName, (e) => {
        const cue = getSelectedCue();
        if (!cue) return;
        updater(cue.text, e.target);
        syncAllToggleSections(cue);
        scheduleAutosave();
        sendLiveCueTextIfActive(cue);
      });
    };

    bindTextEdit('txt-on', 'change', (t, el) => { t.on = el.checked; });
    bindTextEdit('txt-content', 'input', (t, el) => { t.content = el.value; });
    bindTextEdit('txt-pos', 'change', (t, el) => { t.pos = el.value; });
    bindTextEdit('txt-size', 'input', (t, el) => {
      t.size = logic.clamp(el.value, 18, 180);
      $('txt-size-v').textContent = t.size;
    });
    bindTextEdit('txt-color', 'input', (t, el) => { t.color = el.value; });
    bindTextEdit('txt-bgbox', 'change', (t, el) => { t.bgBox = el.checked; });

    // Modals: Pre-flight, Tools, Help
    $('btn-preflight').addEventListener('click', async () => {
      await verifyAllMediaFiles();
      const report = logic.runPreflightAnalysis(state.project, {
        ledOpen: state.ledStatus.isOpen && state.ledStatus.mode === 'fullscreen',
        masterVol: Number($('master-vol').value),
        fileExistsMap: state.fileExistsMap,
        codecErrorsMap: state.codecErrorMap
      });

      const body = $('preflight-body');
      body.innerHTML = '';
      if (report.issues.length === 0) {
        const okDiv = document.createElement('div');
        okDiv.className = 'preflight-item is-ok';
        okDiv.textContent = 'TẤT CẢ ĐỀU ỔN! Đã sẵn sàng chạy chương trình.';
        body.appendChild(okDiv);
      } else {
        report.issues.forEach((it) => {
          const item = document.createElement('div');
          item.className = `preflight-item ${it.level === 'error' ? 'is-error' : 'is-warning'}`;
          item.textContent = `[${it.level === 'error' ? 'LỖI' : 'CẢNH BÁO'}] ${it.cueName}: ${it.message}`;
          body.appendChild(item);
        });
      }
      $('preflight-modal').classList.remove('hidden');
    });
    $('btn-close-preflight').addEventListener('click', () => $('preflight-modal').classList.add('hidden'));

    const openToolsModal = async () => {
      const logs = await window.api.readShowLogs();
      $('show-log-box').textContent = logs.length > 0 ? logs.join('\n') : 'Chưa có nhật ký.';
      const rStatus = await window.api.getRemoteStatus();
      updateRemoteUi(rStatus);
      $('tools-modal').classList.remove('hidden');
    };
    $('btn-tools-modal').addEventListener('click', openToolsModal);
    $('btn-gear-settings').addEventListener('click', openToolsModal);
    $('btn-close-tools').addEventListener('click', () => $('tools-modal').classList.add('hidden'));
    $('btn-open-log-folder').addEventListener('click', () => window.api.openLogsFolder());

    $('btn-help-modal').addEventListener('click', () => $('help-modal').classList.remove('hidden'));
    $('btn-close-help').addEventListener('click', () => $('help-modal').classList.add('hidden'));

    $('remote-enable').addEventListener('change', async (e) => {
      const enable = e.target.checked;
      setSectionEnabled('group-remote-pin', enable);
      const pin = $('remote-pin').value.trim();
      const st = await window.api.toggleRemote(enable, pin);
      updateRemoteUi(st);
      syncRemoteState();
    });

    $('btn-apply-remote').addEventListener('click', async () => {
      const enable = $('remote-enable').checked;
      const pin = $('remote-pin').value.trim();
      const st = await window.api.toggleRemote(enable, pin);
      updateRemoteUi(st);
      syncRemoteState();
    });
  }

  function updateRemoteUi(st) {
    if (!st) return;
    $('remote-enable').checked = Boolean(st.enabled);
    $('remote-pin').value = st.pin || '1234';
    setSectionEnabled('group-remote-pin', Boolean(st.enabled));
    if (st.enabled) {
      const urls = st.urls || [];
      const stageUrls = urls.map((u) => `${u}/stage`).join(' · ');
      $('remote-info').textContent =
        `Đang BẬT — Remote: ${urls.join(' hoặc ')} (PIN: ${st.pin}) | Stage MC (/stage): ${stageUrls} | Đang nối: ${st.clients || 0}`;
    } else {
      $('remote-info').textContent = 'Đang TẮT. Gạt nút bật để lấy địa chỉ Remote & /stage trên điện thoại / tablet cùng Wi-Fi.';
    }
  }

  // =========================================================================
  // MỞ / LƯU / GÓI DỰ ÁN
  // =========================================================================

  async function applyLoadedProjectServices() {
    if (ledDmxUi) {
      await ledDmxUi.applyDmxConfiguration();
      await ledDmxUi.applyOscConfiguration();
    }
  }

  async function openProjectAction() {
    const res = await window.api.openProjectDialog();
    if (!res || res.canceled) return;
    if (!res.ok) {
      showBanner(res.error || 'Không mở được tệp dự án.');
      return;
    }
    pushUndoSnapshot();
    state.project = res.project;
    ensureProjectV3Shape();
    state.projectFilePath = res.filePath;
    state.selectedIndex = state.project.cues.length > 0 ? 0 : -1;
    state.liveCueId = null;
    state.liveCueSnapshot = null;
    scheduleAutosave();
    await verifyAllMediaFiles();
    refreshAllUi();
    await applyLoadedProjectServices();
    if (res.warnings && res.warnings.length > 0) showBanner(res.warnings.join(' '));
  }

  async function saveProjectAction(saveAs) {
    const res = await window.api.saveProjectDialog({
      project: cloneProjectData(),
      currentPath: state.projectFilePath,
      saveAs: Boolean(saveAs)
    });
    if (!res || res.canceled) return;
    if (!res.ok) {
      showBanner(res.error || 'Không lưu được dự án.');
      return;
    }
    state.projectFilePath = res.filePath;
    scheduleAutosave();
    renderCueList();
    showBanner('Đã lưu dự án thành công: ' + res.filePath);
  }

  async function collectProjectAction() {
    const res = await window.api.collectProjectFiles({
      project: cloneProjectData(),
      currentPath: state.projectFilePath
    });
    if (!res || res.canceled) return;
    if (!res.ok) {
      showBanner(res.error || 'Gói dự án thất bại.');
      return;
    }
    state.project = res.project;
    ensureProjectV3Shape();
    state.projectFilePath = res.filePath;
    scheduleAutosave();
    await verifyAllMediaFiles();
    refreshAllUi();
    const missMsg = res.missingFiles && res.missingFiles.length > 0
      ? ` (Lưu ý: ${res.missingFiles.length} tệp bị thiếu không chép được)`
      : '';
    showBanner(`Đã gói ${res.copiedCount} tệp media vào thư mục cùng dự án!${missMsg}`);
  }

  // =========================================================================
  // XỬ LÝ LỆNH OSC & REMOTE LAN MỞ RỘNG
  // =========================================================================

  function handleOscCommand(msg) {
    if (!msg || typeof msg.address !== 'string') return;
    if (ledDmxUi) ledDmxUi.showLastOscMessage(msg);

    const addr = msg.address.trim().toLowerCase();
    const args = Array.isArray(msg.args) ? msg.args : [];
    const arg0 = args[0];

    if (addr === '/er/go') {
      handleGo();
    } else if (addr === '/er/back') {
      handleSelectDelta(-1);
    } else if (addr === '/er/blackout') {
      toggleBlackout(arg0 !== undefined ? Boolean(Number(arg0) || arg0 === true) : undefined);
    } else if (addr === '/er/stop') {
      stopAllPanic();
    } else if (addr === '/er/tbar') {
      const n = Number(arg0);
      if (Number.isFinite(n)) {
        const pct = n <= 1.001 ? n * 100 : n;
        handleTbarInput(pct);
      }
    } else if (/^\/er\/ov([1-4])$/.test(addr)) {
      const idx = Number(addr.match(/^\/er\/ov([1-4])$/)[1]);
      if (overlaysUi) {
        overlaysUi.toggleOverlay(idx, arg0 !== undefined ? Boolean(Number(arg0) || arg0 === true) : undefined);
      }
    } else if (addr === '/er/flash') {
      if (ledDmxUi) ledDmxUi.triggerFlashHit();
    } else if (addr === '/er/strobe') {
      const on = arg0 !== undefined ? Boolean(Number(arg0) || arg0 === true) : true;
      if (ledDmxUi) ledDmxUi.setMomentary('strobe', on);
    } else if (addr === '/er/bpm') {
      const bpm = Number(arg0);
      if (Number.isFinite(bpm) && bpm >= 40 && bpm <= 240) {
        setMasterBpm(bpm, false);
      }
    } else if (/^\/er\/vj\/col(\/([1-4]))?$/.test(addr)) {
      const m = addr.match(/^\/er\/vj\/col(?:\/([1-4]))?$/);
      const colNum = m && m[1] ? Number(m[1]) : Math.round(Number(arg0) || 1);
      if (vjDeckUi && colNum >= 1 && colNum <= 4) {
        vjDeckUi.triggerColumn(colNum - 1);
      }
    } else if (addr === '/er/cue') {
      const cueNum = Math.round(Number(arg0));
      if (Number.isFinite(cueNum) && cueNum >= 1 && cueNum <= state.project.cues.length) {
        triggerCueAt(cueNum - 1, true);
      }
    }
  }

  function handleRemoteCommand(cmd) {
    if (typeof cmd !== 'string') return;
    if (cmd === 'GO') handleGo();
    else if (cmd === 'BACK') handleSelectDelta(-1);
    else if (cmd === 'BLACK') toggleBlackout();
    else if (cmd === 'STOP') stopAllPanic();
    else if (cmd === 'FADE') fadeOutMusicPanic();
    else if (cmd === 'TAP_BPM') handleTapBpm();
    else if (cmd === 'OV1' && overlaysUi) overlaysUi.toggleOverlay(1);
    else if (cmd === 'OV2' && overlaysUi) overlaysUi.toggleOverlay(2);
    else if (cmd === 'OV3' && overlaysUi) overlaysUi.toggleOverlay(3);
    else if (cmd === 'OV4' && overlaysUi) overlaysUi.toggleOverlay(4);
    else if (cmd === 'FLASH_HIT' && ledDmxUi) ledDmxUi.triggerFlashHit();
    else if (cmd === 'STROBE_HOLD_ON' && ledDmxUi) ledDmxUi.setMomentary('strobe', true);
    else if (cmd === 'STROBE_HOLD_OFF' && ledDmxUi) ledDmxUi.setMomentary('strobe', false);
    else if (/^SFX:([0-5])$/.test(cmd)) {
      triggerSfxPad(Number(cmd.slice(4)));
    } else if (/^LED_MODE:([a-z0-9-]+)$/i.test(cmd) && ledDmxUi) {
      ledDmxUi.setLedModeBySlug(cmd.slice(9).toLowerCase());
    }
  }

  // =========================================================================
  // KHỞI ĐỘNG ỨNG DỤNG
  // =========================================================================

  async function bootstrap() {
    initVuMeters();

    // Khởi tạo 3 UI controller mới
    vjDeckUi = new window.EventRunnerVjDeckUi({
      logic,
      audioEngine,
      getProject: () => state.project,
      getProjectFilePath: () => state.projectFilePath,
      isShowMode: () => state.showMode,
      isRehearsalMode: () => state.rehearsalMode,
      pushUndo: pushUndoSnapshot,
      scheduleAutosave,
      showBanner,
      extractDroppedPaths: extractDroppedFilePaths,
      isExternalFileDrag
    });

    overlaysUi = new window.EventRunnerOverlaysUi({
      logic,
      getProject: () => state.project,
      getProjectFilePath: () => state.projectFilePath,
      isRehearsalMode: () => state.rehearsalMode,
      scheduleAutosave,
      showBanner,
      onOverlaysChanged: () => {
        pushStageUpdate(false);
        syncRemoteState();
      },
      onStageMessageChanged: () => {
        pushStageUpdate(true);
        syncRemoteState();
      }
    });

    ledDmxUi = new window.EventRunnerLedDmxUi({
      logic,
      getProject: () => state.project,
      getSelectedCue,
      getLiveCue,
      isShowMode: () => state.showMode,
      isRehearsalMode: () => state.rehearsalMode,
      pushUndo: pushUndoSnapshot,
      scheduleAutosave,
      showBanner,
      setSectionEnabled,
      onTapBpm: handleTapBpm,
      onAutoBpmToggle: (enabled) => {
        state.autoBpmEnabled = Boolean(enabled);
        state.beatTimesForAutoBpm = [];
      },
      onPhaseNudge: (ms) => {
        masterBeatClock.nudge(ms);
      },
      onPhaseResync: () => {
        masterBeatClock.resync(performance.now());
      },
      onDividerChange: (div) => {
        masterBeatClock.setDivider(div);
      },
      getCurrentBpm: () => state.masterBpm
    });

    const inputMapper = new window.EventRunnerInputMapper({
      onGo: handleGo,
      onSelectDelta: handleSelectDelta,
      onToggleBlackout: () => toggleBlackout(),
      onFadeMusic: fadeOutMusicPanic,
      onStopAll: stopAllPanic,
      onToggleTestPattern: toggleTestPattern,
      onSave: saveProjectAction,
      onOpen: openProjectAction,
      onToggleDrawer: () => {
        const drawer = $('fs-drawer');
        if (drawer) setDrawerCollapsed(!drawer.classList.contains('is-collapsed'));
      },
      onFocusSearch: () => {
        const el = $('cue-search-input');
        if (el) {
          el.focus();
          el.select();
        }
      },
      onUndo: performUndo,
      onRedo: performRedo,
      onTriggerSfx: triggerSfxPad,
      onFlashHit: () => ledDmxUi && ledDmxUi.triggerFlashHit(),
      onStrobeHoldChange: (active) => ledDmxUi && ledDmxUi.setMomentary('strobe', active),
      onTapBpm: handleTapBpm,
      onQuickCut: () => triggerSelectedWithTransition('cut', 0),
      onToggleOverlay: (num) => overlaysUi && overlaysUi.toggleOverlay(num),
      onTriggerVjCol: (colIdx) => vjDeckUi && vjDeckUi.triggerColumn(colIdx),
      onMidiClockBeat: (bpm) => setMasterBpm(bpm, false),
      onMidiTbar: (norm) => handleTbarInput(Math.round(logic.clamp(norm, 0, 1) * 100)),
      onMidiDimmer: (norm) => {
        const val = Math.round(logic.clamp(norm, 0, 1) * 100);
        state.project.masterFx.dimmer = val;
        renderMasterFxControls();
        pushMasterFxToLed();
      },
      onMidiStrobeIntensity: (norm) => {
        const val = Math.round(logic.clamp(norm, 0, 1) * 100);
        const target = ledDmxUi.getEditableLedSync();
        target.intensity = val;
        ledDmxUi.globalConfig.intensity = val;
        ledDmxUi.renderInspectorTab();
        ledDmxUi.sendLedSyncToOutput();
      }
    });
    appInputMapper = inputMapper;
    inputMapper.initKeyboard();
    inputMapper.setSfxHotkeys(state.project.sfxPads);

    inputMapper.onSfxKeyConflict = (msg) => showBanner(msg);
    inputMapper.onSfxKeyLearned = (idx, code, label) => {
      ensureSixSfxPads();
      const pad = state.project.sfxPads[idx];
      if (!pad || code === null) {
        renderSfxSettingsModal();
        return;
      }
      pushUndoSnapshot();
      if (code === 'Backspace' || code === 'Delete') {
        pad.hotkey = '';
        pad.hotkeyLabel = '---';
        showBanner(`Đã gỡ phím tắt khỏi hiệu ứng "${pad.name}".`);
      } else {
        state.project.sfxPads.forEach((other, oIdx) => {
          if (oIdx !== idx && other.hotkey === code) {
            other.hotkey = '';
            other.hotkeyLabel = '---';
          }
        });
        pad.hotkey = code;
        pad.hotkeyLabel = label || code;
        showBanner(`Đã gán phím [${pad.hotkeyLabel}] cho hiệu ứng "${pad.name}".`);
      }
      scheduleAutosave();
      renderSfxPads();
      renderSfxSettingsModal();
    };

    inputMapper.onMidiStatusChange = (txt) => { $('midi-status').textContent = txt; };
    inputMapper.onMidiLearned = (act, sig, fullMap) => {
      const lbl = $('midi-lbl-' + act);
      if (lbl) lbl.textContent = sig;
      window.api.setSettings({ midiMap: fullMap });
    };

    document.querySelectorAll('[data-midi-learn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.midiLearn;
        const lbl = $('midi-lbl-' + act);
        if (lbl) lbl.textContent = 'Bấm nút/Fader MIDI...';
        inputMapper.startLearn(act);
      });
    });

    $('btn-midi-clear').addEventListener('click', () => {
      const empty = {};
      MIDI_ACTION_KEYS.forEach((a) => {
        empty[a] = null;
        const lbl = $('midi-lbl-' + a);
        if (lbl) lbl.textContent = 'Chưa gán';
      });
      inputMapper.setMidiMap(empty);
      window.api.setSettings({ midiMap: empty });
    });

    // Beat từ AudioWorklet -> gửi sang LED FX + LED Strobe Beat Hit + Auto-BPM
    audioEngine.onBassBeat = (beat) => {
      const nowMs = performance.now();
      const track = audioEngine.getCurrentTrackInfo();
      const extOn = audioEngine.isExternalInputActive();
      const localVidOn = audioEngine.isLiveVideoPlaying();
      const liveCue = getLiveCue();

      const liveWantsExt = Boolean(liveCue && liveCue.fx && liveCue.fx.on && liveCue.fx.src === 'ext' && extOn);
      const liveWantsAuto = Boolean(liveCue && liveCue.fx && liveCue.fx.on && liveCue.fx.src === 'auto' && track.playing);
      const liveWantsLocalVid = Boolean(
        liveCue && liveCue.fx && liveCue.fx.on && liveCue.fx.src === 'video' &&
        (state.rehearsalMode || !state.ledStatus.isOpen) && localVidOn
      );

      if (liveWantsExt || liveWantsAuto || liveWantsLocalVid) {
        bassChartBeats.push(nowMs);
        flashBeatLamp(nowMs);
        triggerPreviewBeatFx(beat.k, liveCue.fx);
        if (!state.rehearsalMode && !liveWantsLocalVid) {
          window.api.sendToLed({ type: 'beat', k: beat.k, fx: liveCue.fx });
        }
      } else if (!liveCue && extOn && !track.playing) {
        bassChartBeats.push(nowMs);
        flashBeatLamp(nowMs);
      }

      const activeLedSync = ledDmxUi.getActiveLedSync();
      if (
        activeLedSync.on &&
        (activeLedSync.trigger === 'bass' || activeLedSync.trigger === 'all') &&
        (track.playing || extOn || localVidOn)
      ) {
        emitLedBeatHit(beat.k, state.lastBeatState, nowMs);
      }

      if (state.autoBpmEnabled && (track.playing || extOn || localVidOn)) {
        state.beatTimesForAutoBpm.push(nowMs);
        if (state.beatTimesForAutoBpm.length > 24) state.beatTimesForAutoBpm.shift();
        const est = logic.estimateBpmFromBeatTimes(state.beatTimesForAutoBpm);
        if (est && est.confidence >= 0.45) {
          setMasterBpm(est.bpm, false);
        }
      }
    };

    audioEngine.onBassTelemetry = (msg) => {
      const nowMs = performance.now();
      const track = audioEngine.getCurrentTrackInfo();
      const extOn = audioEngine.isExternalInputActive();
      const localVidOn = audioEngine.isLiveVideoPlaying();
      const liveCue = getLiveCue();
      const usingExt = Boolean(extOn && ((liveCue && liveCue.fx && liveCue.fx.src === 'ext') || (!track.playing && !localVidOn)));
      const usingLedVideo = Boolean(liveCue && liveCue.fx && liveCue.fx.src === 'video' && !state.rehearsalMode && state.ledStatus.isOpen);

      if (localVidOn && !usingLedVideo) {
        state.localVideoEnv = logic.clamp((msg && msg.env) || 0, 0, 1);
      } else if (!localVidOn) {
        state.localVideoEnv = 0;
      }

      if (!usingLedVideo && (track.playing || usingExt || localVidOn)) {
        bassChartPoints.push({
          timeMs: nowMs,
          o: msg.o || 0,
          threshold: msg.threshold || 0.015
        });
      }
      if (!state.rehearsalMode && !usingLedVideo) {
        const hasMusicSignal = usingExt ? ((msg.env || 0) > 0.012) : (track.playing || localVidOn);
        window.api.sendToLed({
          type: 'level',
          env: hasMusicSignal ? (msg.env || 0) : 0,
          playing: hasMusicSignal
        });
      }
    };

    if (typeof window.api.onLedVideoBeat === 'function') {
      window.api.onLedVideoBeat((beat) => {
        const nowMs = performance.now();
        const liveCue = getLiveCue();
        if (!liveCue || !liveCue.fx || liveCue.fx.src !== 'video' || state.rehearsalMode || !state.ledStatus.isOpen) {
          return;
        }
        if (liveCue.fx.on) {
          bassChartBeats.push(nowMs);
          flashBeatLamp(nowMs);
          triggerPreviewBeatFx((beat && beat.k) || 0.85, liveCue.fx);
        }
        const activeLedSync = ledDmxUi.getActiveLedSync();
        if (activeLedSync.on && (activeLedSync.trigger === 'bass' || activeLedSync.trigger === 'all')) {
          emitLedBeatHit((beat && beat.k) || 0.85, state.lastBeatState, nowMs);
        }
        if (state.autoBpmEnabled) {
          state.beatTimesForAutoBpm.push(nowMs);
          if (state.beatTimesForAutoBpm.length > 24) state.beatTimesForAutoBpm.shift();
          const est = logic.estimateBpmFromBeatTimes(state.beatTimesForAutoBpm);
          if (est && est.confidence >= 0.45) {
            setMasterBpm(est.bpm, false);
          }
        }
      });
    }

    if (typeof window.api.onLedVideoTelemetry === 'function') {
      window.api.onLedVideoTelemetry((msg) => {
        const nowMs = performance.now();
        const liveCue = getLiveCue();
        if (!liveCue || !liveCue.fx || liveCue.fx.src !== 'video' || state.rehearsalMode || !state.ledStatus.isOpen) {
          return;
        }
        const playing = Boolean(msg && msg.playing);
        state.ledVideoTelemetry.playing = playing;
        state.ledVideoTelemetry.updatedAtMs = nowMs;
        state.ledVideoTelemetry.bass = Number(msg && msg.bass) || 0;
        state.ledVideoTelemetry.mid = Number(msg && msg.mid) || 0;
        state.ledVideoTelemetry.high = Number(msg && msg.high) || 0;
        state.ledVideoTelemetry.env = Number(msg && msg.env) || 0;
        if (msg && Array.isArray(msg.spectrum)) {
          state.ledVideoTelemetry.spectrum = msg.spectrum;
        }
        if (playing) {
          bassChartPoints.push({
            timeMs: nowMs,
            o: (msg && msg.o) || 0,
            threshold: (msg && msg.threshold) || 0.015
          });
        }
      });
    }

    audioEngine.onWorkletFallback = (msg) => {
      if (msg) showBanner(msg);
    };
    audioEngine.onSfxStateChange = (playingIds) => updatePlayingSfxHighlights(playingIds);

    audioEngine.onAudioEnded = (endedCueId) => {
      const cue = state.project.cues.find((c) => c.id === endedCueId);
      if (cue && cue.id === state.liveCueId && cue.autoFollow === 'audio-end') {
        const idx = state.project.cues.findIndex((c) => c.id === cue.id);
        if (idx >= 0 && idx + 1 < state.project.cues.length) {
          triggerCueAt(idx + 1, true);
        }
      }
    };

    audioEngine.onAudioError = ({ path, message }) => {
      if (path) state.codecErrorMap[path] = true;
      showBanner(message);
      renderCueList();
    };

    window.api.onLedStatusChanged(({ led, displays, alert }) => {
      renderLedAndDisplayUi(led, displays);
      syncLivePreviewVideoAudio();
      if (alert) showBanner(alert);
    });

    window.api.onStageStatusChanged(({ stage, displays }) => {
      renderStageDisplayUi(stage, displays);
      if (stage && stage.isOpen) {
        pushStageUpdate(true);
      }
    });

    window.api.onLedReady((ledStatus) => {
      renderLedAndDisplayUi(ledStatus);
      syncLivePreviewVideoAudio();
      const liveCue = getLiveCue();
      if (liveCue && !state.rehearsalMode) {
        const { visUrl, visKind } = resolveCueVisualInfo(liveCue);
        window.api.sendToLed({
          type: 'show',
          cue: { ...JSON.parse(JSON.stringify(liveCue)), tr: 'cut', dur: 0 },
          url: visUrl,
          mediaKind: visKind,
          masterVol: Number($('master-vol').value),
          sinkId: state.settings.audioDeviceId || ''
        });
        if (state.blackout) window.api.sendToLed({ type: 'blackout', on: true });
        if (state.testPattern) window.api.sendToLed({ type: 'test-pattern', on: true });
        if (state.testIdleOn) window.api.sendToLed({ type: 'test-idle', on: true, fx: liveCue.fx });
      } else if (state.testIdleOn && !state.rehearsalMode) {
        const sel = getSelectedCue();
        window.api.sendToLed({ type: 'test-idle', on: true, fx: sel ? sel.fx : logic.createDefaultFx() });
      }
      if (!state.rehearsalMode) {
        pushMasterFxToLed();
        pushOutputMappingToLed();
        if (overlaysUi) overlaysUi.pushToLed(false);
        if (ledDmxUi) ledDmxUi.sendLedSyncToOutput();
        if (vjDeckUi) vjDeckUi.reapplyActiveLayers();
      }
    });

    window.api.onLedMediaError(({ path, message }) => {
      if (path) state.codecErrorMap[path] = true;
      showBanner(message || 'File này không phát được, hãy chuyển sang MP4 H.264');
      renderCueList();
    });

    window.api.onRemoteCommand(handleRemoteCommand);
    if (typeof window.api.onOscMessage === 'function') {
      window.api.onOscMessage(handleOscCommand);
    }

    state.settings = await window.api.getSettings();
    $('chk-auto-open-led').checked = state.settings.autoOpenLed !== false;
    const savedMaster = logic.clamp(state.settings.masterVol ?? 100, 0, 100);
    $('master-vol').value = savedMaster;
    $('master-vol-val').textContent = savedMaster + '%';
    audioEngine.setMasterVolume(savedMaster);
    const savedExtGain = logic.clamp(state.settings.extGain ?? 100, 20, 400);
    if ($('ext-input-gain')) $('ext-input-gain').value = savedExtGain;
    if ($('fx-ext-gain')) $('fx-ext-gain').value = savedExtGain;
    if ($('ext-input-gain-v')) $('ext-input-gain-v').textContent = savedExtGain;
    if ($('fx-ext-gain-v')) $('fx-ext-gain-v').textContent = savedExtGain;
    audioEngine.setExternalGain(savedExtGain);
    setSectionEnabled('group-ext-options', false);

    if (state.settings.audioDeviceId) audioEngine.setOutputDevice(state.settings.audioDeviceId);
    if (state.settings.midiMap) {
      inputMapper.setMidiMap(state.settings.midiMap);
      MIDI_ACTION_KEYS.forEach((a) => {
        const lbl = $('midi-lbl-' + a);
        if (lbl && state.settings.midiMap[a]) lbl.textContent = state.settings.midiMap[a];
      });
    }

    const autosave = await window.api.loadAutosave();
    if (autosave && autosave.exists && autosave.project) {
      state.project = autosave.project;
      ensureProjectV3Shape();
      state.projectFilePath = autosave.projectFilePath || null;
      state.selectedIndex = state.project.cues.length > 0 ? 0 : -1;
    }

    bindUiEvents();
    vjDeckUi.bindStaticEvents();
    overlaysUi.bindEvents();
    ledDmxUi.bindEvents();

    refreshAllUi();
    await verifyAllMediaFiles();

    const [displays, ledStatus, stageStatus] = await Promise.all([
      window.api.listDisplays(),
      window.api.getLedStatus(),
      window.api.getStageStatus()
    ]);
    renderLedAndDisplayUi(ledStatus, displays);
    syncLivePreviewVideoAudio();
    renderStageDisplayUi(stageStatus, displays);

    await Promise.all([
      refreshAudioDevices(),
      refreshInputDevices(),
      refreshCameraDevices()
    ]);

    if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
      navigator.mediaDevices.addEventListener('devicechange', () => {
        refreshAudioDevices();
        refreshInputDevices();
        refreshCameraDevices();
      });
    }
    inputMapper.initMidi();

    await applyLoadedProjectServices();

    $('clock-display').textContent = new Date().toTimeString().slice(0, 8);
    setInterval(() => {
      $('clock-display').textContent = new Date().toTimeString().slice(0, 8);
    }, 500);
    setInterval(verifyAllMediaFiles, 10000);

    requestAnimationFrame(animationLoop);
  }

  window.addEventListener('DOMContentLoaded', bootstrap);
})();
