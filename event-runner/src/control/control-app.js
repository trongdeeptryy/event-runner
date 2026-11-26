/**
 * Controller chính của Bảng điều khiển EVENT RUNNER v2.4 (Giao diện 3 Cột)
 * Kết nối toàn bộ luồng vận hành show:
 * - Header mỏng với menu Tệp / Chỉnh sửa / Tùy chọn / Sự kiện / Trợ giúp & Segmented Mode (BIÊN TẬP / TẬP DƯỢT / CHẾ ĐỘ SHOW)
 * - Cột trái: Danh sách thẻ Cue gọn sạch (click chọn KẾ TIẾP, nháy đúp phát ngay, sóng âm mini)
 * - Cột giữa: 2 màn hình 16:9 song song, nút GO lớn, cột nút phụ trợ, sóng âm tương tác, 4 SFX & VU Meter
 * - Cột phải: Thuộc tính Cue 4 tab + Phân tích bass DSP AudioWorklet + Rung nhẹ liên tục (Idle Shake)
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

  // Trạng thái toàn cục
  const state = {
    project: {
      version: 1,
      cues: [],
      sfxPads: logic.createDefaultSfxPads(),
      customFxPresets: {}
    },
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
    displays: [],
    settings: {},
    fileExistsMap: {},
    codecErrorMap: {},
    autoFollowTimer: null,
    autoFollowEndTime: 0,
    isSeekingAudio: false,
    tapTimestamps: [],
    activeTrackPeaks: null,
    sfxVuLevel: 0
  };

  // Undo / Redo stack
  const undoStack = [];
  const redoStack = [];
  const MAX_UNDO = 50;
  let autosaveTimer = null;

  // Bộ theo dõi nhịp BPM + bộ thử BPM
  const bpmBeatTracker = new logic.BpmBeatTracker(0.04);
  const testBeatTracker = new logic.BpmBeatTracker(0.04);
  let testBeatStartMs = 0;
  let lampTimeout = null;

  // Dữ liệu biểu đồ phân tích bass 4 giây gần nhất & tính beat/giây
  const bassChartPoints = [];
  const bassChartBeats = [];
  const beatRateTimestamps = [];

  // Bộ quản lý phím tắt bàn phím / MIDI và bộ hẹn giờ đèn viền DJ cho 6 ô SFX
  let appInputMapper = null;
  const sfxBurstTimers = new Map();

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

  /** Định dạng giây sang HH:MM:SS */
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
  // ĐỒNG HỒ MỨC ÂM THANH (VU METER)
  // =========================================================================

  function initVuMeters() {
    ['master-vu-meter', 'sfx-vu-meter', 'ext-opt-vu-meter', 'fx-ext-vu-meter'].forEach((id) => {
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
    const remChk = $('remote-enable');
    if (remChk) {
      setSectionEnabled('group-remote-pin', Boolean(remChk.checked));
    }
    const extChk = $('ext-input-enable');
    if (extChk) {
      setSectionEnabled('group-ext-options', Boolean(extChk.checked));
    }
  }

  function setOperatingMode(mode) {
    const valid = ['edit', 'rehearsal', 'show'].includes(mode) ? mode : 'edit';
    state.operatingMode = valid;
    state.showMode = valid === 'show';
    state.rehearsalMode = valid === 'rehearsal';

    document.querySelectorAll('.seg-pill').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === valid);
    });

    // Khóa các nút thêm/sửa/xóa kịch bản khi ở CHẾ ĐỘ SHOW nhưng giữ nguyên khung 3 cột & cho chỉnh FX/Vol
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
    syncAllToggleSections(getSelectedCue());
    syncLivePreviewVideoAudio();

    if (state.rehearsalMode) {
      showBanner('Đang bật chế độ TẬP DƯỢT: chỉ phát xem trước trên máy, giảm âm còn 35%, không xuất ra màn LED.');
    } else {
      hideBanner();
    }

    renderCueList();
  }

  // =========================================================================
  // LƯU TỰ ĐỘNG, UNDO / REDO & KIỂM TRA FILE
  // =========================================================================

  function cloneProjectData() {
    return JSON.parse(JSON.stringify(state.project));
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
      if (cue.vis) paths.add(cue.vis);
    }
    for (const pad of state.project.sfxPads) {
      if (pad.path) paths.add(pad.path);
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
  // PHÁT CUE (GO) & ĐỒNG BỘ LED + NHẠC
  // =========================================================================

  function getSelectedCue() {
    if (state.selectedIndex < 0 || state.selectedIndex >= state.project.cues.length) return null;
    return state.project.cues[state.selectedIndex];
  }

  function getLiveCue() {
    if (!state.liveCueId) return null;
    return state.project.cues.find((c) => c.id === state.liveCueId) || state.liveCueSnapshot;
  }

  function preloadCue(cue) {
    if (!cue) return;
    if (cue.vis) {
      const visUrl = window.api.toFileUrl(cue.vis, state.projectFilePath);
      const kind = logic.detectMediaKind(cue.vis) === 'image' ? 'image' : 'video';
      if (!state.rehearsalMode) {
        window.api.sendToLed({ type: 'preload', url: visUrl, mediaKind: kind });
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

  function triggerCueAt(index, advanceSelection = true) {
    if (index < 0 || index >= state.project.cues.length) return;
    const cue = state.project.cues[index];

    const visUrl = cue.vis ? window.api.toFileUrl(cue.vis, state.projectFilePath) : null;
    const visKind = cue.vis ? (logic.detectMediaKind(cue.vis) === 'image' ? 'image' : 'video') : null;
    const audUrl = cue.aud ? window.api.toFileUrl(cue.aud, state.projectFilePath) : null;

    // 1. Gửi lệnh hình sang LED TRƯỚC (kèm mức Master & thiết bị loa cho tiếng gốc video)
    if (!state.rehearsalMode) {
      window.api.sendToLed({
        type: 'show',
        cue: JSON.parse(JSON.stringify(cue)),
        url: visUrl,
        mediaKind: visKind,
        masterVol: Number($('master-vol').value),
        sinkId: state.settings.audioDeviceId || ''
      });
    }

    // 2. Phát nhạc NGAY SAU trong cùng tick (mặc định tự tắt nhạc Cue trước nếu sang Cue không có nhạc)
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
    bpmBeatTracker.reset();
    window.api.setShowRunningState(true);

    // Nếu Cue đang chạy dùng nguồn beat từ Mixer/DJ thì tự động bật thu Line-In và chuyển mạch DSP sang external
    if (cue.fx && cue.fx.on && cue.fx.src === 'ext' && !audioEngine.isExternalInputActive()) {
      enableExternalMixerInput(true);
    } else {
      syncAnalysisSourceRouting();
    }

    window.api.appendShowLog(
      `GO #${index + 1}: ${cue.name}${cue.aud ? ' | ♪ ' + window.api.baseName(cue.aud) : ''}${cue.vis ? ' | ▣ ' + window.api.baseName(cue.vis) : ''}`
    );

    if (advanceSelection) {
      state.selectedIndex = index + 1 < state.project.cues.length ? index + 1 : index;
    }

    scheduleAutoFollow(cue);
    renderCueList();
    renderMonitors();
    renderEditor();

    const nextCue = getSelectedCue();
    if (nextCue && nextCue.id !== cue.id) {
      preloadCue(nextCue);
    }
    syncRemoteState();
  }

  function handleGo() {
    if (state.project.cues.length === 0) return;
    const idx = state.selectedIndex >= 0 ? state.selectedIndex : 0;
    triggerCueAt(idx, true);
  }

  function handleSelectDelta(delta) {
    const len = state.project.cues.length;
    if (len === 0) return;
    const cur = state.selectedIndex >= 0 ? state.selectedIndex : 0;
    state.selectedIndex = logic.clamp(cur + delta, 0, len - 1);
    onSelectionChanged();
  }

  function onSelectionChanged() {
    renderCueList();
    renderMonitors();
    renderEditor();
    const sel = getSelectedCue();
    if (sel) preloadCue(sel);
    syncRemoteState();

    const activeRow = $('cue-list').querySelector('.cue-card.is-selected');
    if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
  }

  function toggleBlackout() {
    state.blackout = !state.blackout;
    $('btn-blackout').classList.toggle('active', state.blackout);
    if (!state.rehearsalMode) {
      window.api.sendToLed({ type: 'blackout', on: state.blackout });
    }
    window.api.appendShowLog(state.blackout ? 'PANIC: ĐEN MÀN (Bật)' : 'PANIC: ĐEN MÀN (Tắt)');
    syncRemoteState();
  }

  function fadeOutMusicPanic() {
    audioEngine.fadeOutCurrent(2.0);
    if (!state.rehearsalMode) {
      window.api.sendToLed({ type: 'fade-video-audio', durationSec: 2.0 });
    }
    const localVid = $('live-preview-box') && $('live-preview-box').querySelector('video');
    if (localVid) localVid.muted = true;
    window.api.appendShowLog('PANIC: TẮT NHẠC DẦN (2s)');
  }

  function stopAllPanic() {
    clearAutoFollow();
    audioEngine.stopAll(0.3);
    state.activeTrackPeaks = null;
    state.blackout = false;
    $('btn-blackout').classList.remove('active');
    if (!state.rehearsalMode) {
      window.api.sendToLed({ type: 'clear' });
    }
    state.liveCueId = null;
    state.liveCueSnapshot = null;
    state.liveStartedAtMs = 0;
    window.api.setShowRunningState(false);
    renderCueList();
    renderMonitors();
    window.api.appendShowLog('PANIC: DỪNG TẤT CẢ (Esc)');
    syncRemoteState();
  }

  function toggleTestPattern() {
    state.testPattern = !state.testPattern;
    $('btn-test-pattern').classList.toggle('active', state.testPattern);
    window.api.sendToLed({ type: 'test-pattern', on: state.testPattern });
  }

  function syncRemoteState() {
    const live = getLiveCue();
    const next = getSelectedCue();
    window.api.broadcastRemoteState({
      liveName: live ? live.name : 'Chưa phát',
      nextName: next ? next.name : 'Trống',
      blackout: state.blackout
    });
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
    return Boolean(cue && !cue.vis && !cue.aud && (!cue.note || !cue.note.trim()));
  }

  function isGenericCueName(name) {
    return !name || /^Cue(\s+\d+|\s+mới|\s+chưa\s+đặt\s+tên)?$/i.test(name.trim());
  }

  /** Nhập mảng đường dẫn Ảnh / Video / Nhạc thành các Cue trong Danh sách Cue */
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

    // Nếu người dùng thả trực tiếp vào 1 Cue trống chưa có hình/nhạc -> điền thẳng vào Cue trống đó
    if (targetCue && isUntouchedBlankCue(targetCue)) {
      if (
        builtCues.length === 2 &&
        ((builtCues[0].vis && builtCues[1].aud) || (builtCues[0].aud && builtCues[1].vis))
      ) {
        const visCue = builtCues[0].vis ? builtCues[0] : builtCues[1];
        const audCue = builtCues[0].aud ? builtCues[0] : builtCues[1];
        targetCue.vis = visCue.vis;
        targetCue.vsound = visCue.vsound;
        targetCue.vvol = visCue.vvol;
        targetCue.aud = audCue.aud;
        if (isGenericCueName(targetCue.name)) targetCue.name = visCue.name;
        firstSelectedIdx = targetIdx;
      } else {
        const first = builtCues[0];
        if (first.vis) {
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
      // Nếu cả dự án đang chỉ có đúng 1 Cue trống mặc định -> thay thế luôn để không dư Cue rỗng
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
    box.innerHTML = '';
    const url = window.api.toFileUrl(visPath, state.projectFilePath);
    const kind = logic.detectMediaKind(visPath);
    if (kind === 'image') {
      const img = document.createElement('img');
      img.src = url;
      img.onerror = () => { box.textContent = '⚠'; };
      box.appendChild(img);
    } else if (kind === 'video') {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.src = url;
      v.onloadeddata = () => {
        try { v.currentTime = Math.min(0.5, (v.duration || 1) * 0.2); } catch (_) {}
      };
      v.onerror = () => { box.textContent = '⚠'; };
      box.appendChild(v);
    } else {
      box.textContent = '▣';
    }
  }

  function renderCueList() {
    const listEl = $('cue-list');
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

      const card = document.createElement('div');
      card.className = 'cue-card' + (isLive ? ' is-live' : '') + (isSelected ? ' is-selected' : '');
      card.draggable = !state.showMode;
      card.title = 'Click đơn để chọn KẾ TIẾP • Nháy đúp để phát ngay Cue này';

      const mainRow = document.createElement('div');
      mainRow.className = 'cue-card-main';

      const thumbEl = document.createElement('div');
      thumbEl.className = 'cue-thumb';
      if (cue.vis) {
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
      if (cue.vis) parts.push(window.api.baseName(cue.vis));
      if (cue.fx && (cue.fx.on || cue.fx.idleOn)) parts.push('FX');
      subRow.textContent = parts.length > 0 ? parts.join(' • ') : 'Trống';

      const missingAud = cue.aud && state.fileExistsMap[cue.aud] === false;
      const missingVis = cue.vis && state.fileExistsMap[cue.vis] === false;
      const codecErr = (cue.vis && state.codecErrorMap[cue.vis]) || (cue.aud && state.codecErrorMap[cue.aud]);

      infoEl.appendChild(topRow);
      infoEl.appendChild(subRow);

      if (missingAud || missingVis || codecErr) {
        const warn = document.createElement('div');
        warn.className = 'cue-warn';
        const isImgErr = codecErr && cue.vis && logic.detectMediaKind(cue.vis) === 'image';
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

      // Thanh sóng âm tiến trình bên dưới thẻ có nhạc
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

      // Click đơn = chọn KẾ TIẾP; Nháy đúp = phát ngay Cue đó
      card.addEventListener('click', () => {
        state.selectedIndex = idx;
        onSelectionChanged();
      });

      card.addEventListener('dblclick', () => {
        triggerCueAt(idx, true);
      });

      // Kéo thả sắp xếp thứ tự Cue hoặc nhận tệp kéo thả từ máy tính
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

    // Ô nhận kéo thả căn giữa vùng Danh sách Cue (chỉ hiển thị chữ "Kéo thả file")
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
  }

  // =========================================================================
  // RENDER MÀN HÌNH XEM TRƯỚC & THUỘC TÍNH CUE
  // =========================================================================

  /** Đồng bộ tiếng gốc video ở khung xem trước LIVE (chỉ bật tiếng local khi đóng LED hoặc Tập dượt để không bị vọng đôi) */
  function syncLivePreviewVideoAudio() {
    const liveBox = $('live-preview-box');
    if (!liveBox) return;
    const v = liveBox.querySelector('video');
    if (!v) return;
    const liveCue = getLiveCue();
    if (!liveCue) {
      v.muted = true;
      return;
    }
    const shouldPlayLocalAudio =
      (state.rehearsalMode || !state.ledStatus.isOpen) && Boolean(liveCue.vsound !== false);
    const rehearsalFactor = state.rehearsalMode ? 0.35 : 1.0;
    const vol = logic.clamp(
      ((liveCue.vvol ?? 100) / 100) * (Number($('master-vol').value) / 100) * rehearsalFactor,
      0,
      1
    );
    v.volume = vol;
    v.muted = !shouldPlayLocalAudio || vol <= 0.001;
    if (typeof v.setSinkId === 'function' && state.settings.audioDeviceId !== undefined) {
      v.setSinkId(state.settings.audioDeviceId || '').catch(() => {});
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
    const renderKey = cue
      ? `${cue.id}|${cue.vis || ''}|${cue.aud || ''}|${cue.fit || ''}|${cue.loop ? 1 : 0}`
      : `empty|${emptyText}`;

    // Không vẽ lại nếu nội dung không đổi (tránh nháy hình khi đang gõ tên/chỉnh slider)
    if (boxEl._renderedKey === renderKey) {
      if (boxEl.id === 'live-preview-box') syncLivePreviewVideoAudio();
      return;
    }
    const hadPrevious = Boolean(boxEl._renderedKey);
    boxEl._renderedKey = renderKey;

    const layer = document.createElement('div');
    layer.className = 'preview-layer';

    if (!cue || !cue.vis) {
      const empty = document.createElement('div');
      empty.className = 'preview-empty';
      empty.textContent = cue && cue.aud ? `♪ Chỉ phát nhạc: ${window.api.baseName(cue.aud)}` : emptyText;
      layer.appendChild(empty);
    } else {
      const url = window.api.toFileUrl(cue.vis, state.projectFilePath);
      const kind = logic.detectMediaKind(cue.vis);
      const fitStyle = cue.fit === 'cover' ? 'cover' : 'contain';

      if (kind === 'image') {
        if (withBlurBackdrop) {
          const bg = document.createElement('img');
          bg.className = 'preview-backdrop';
          bg.src = url;
          layer.appendChild(bg);
        }
        const img = document.createElement('img');
        img.className = 'preview-fg';
        img.src = url;
        img.style.objectFit = fitStyle;
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
            try { oldVid.pause(); oldVid.removeAttribute('src'); oldVid.load(); } catch (_) {}
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
      };
    } else {
      oldLayers.forEach((old) => {
        const oldVid = old.querySelector('video');
        if (oldVid) {
          try { oldVid.pause(); oldVid.removeAttribute('src'); oldVid.load(); } catch (_) {}
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

    $('live-cue-title').textContent = liveCue ? liveCue.name : 'Chưa phát';
    $('next-cue-title').textContent = nextCue ? nextCue.name : 'Chưa chọn';
    $('go-next-hint').textContent = nextCue
      ? `Phím Space — Chạy Cue ${state.selectedIndex + 1}: ${nextCue.name}`
      : 'Phím Space — Chưa có Cue';

    let followTxt = '';
    if (nextCue && nextCue.autoFollow === 'time') followTxt = `Tự chuyển sau ${nextCue.autoDelay}s`;
    else if (nextCue && nextCue.autoFollow === 'audio-end') followTxt = 'Tự chuyển khi hết nhạc';
    $('auto-follow-badge').textContent = followTxt;

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
        cue.fx.src = 'auto';
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
    const canvas = $('waveform-canvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#080B10';
    ctx.fillRect(0, 0, w, h);

    if (!cue || !cue.aud) {
      ctx.fillStyle = '#5C6880';
      ctx.font = '11.5px Segoe UI';
      ctx.fillText('Chưa chọn tệp nhạc cho Cue này', 12, 38);
      canvas.dataset.duration = '0';
      return;
    }

    ctx.fillStyle = '#8A96AC';
    ctx.font = '11.5px Segoe UI';
    ctx.fillText('Đang phân tích sóng âm...', 12, 38);

    const data = await audioEngine.getWaveformPeaks(cue.aud, state.projectFilePath, 160);
    ctx.fillStyle = '#080B10';
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

    ctx.fillStyle = 'rgba(0, 210, 255, 0.09)';
    ctx.fillRect(startRatio * w, 0, (endRatio - startRatio) * w, h);

    peaks.forEach((p, i) => {
      const ratio = i / peaks.length;
      const inRange = ratio >= startRatio && ratio <= endRatio;
      ctx.fillStyle = inRange ? '#00D2FF' : '#2C364B';
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

  function renderEditor() {
    const cue = getSelectedCue();
    if (!cue) {
      $('editor-empty').classList.remove('hidden');
      $('editor-body').classList.add('hidden');
      $('editing-cue-badge').textContent = 'Thuộc tính Cue';
      return;
    }

    $('editor-empty').classList.add('hidden');
    $('editor-body').classList.remove('hidden');
    $('editing-cue-badge').textContent = `Thuộc tính Cue #${state.selectedIndex + 1}`;

    $('ed-name').value = cue.name;
    $('ed-note').value = cue.note;
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
    syncAllToggleSections(cue);
    renderWaveformForCue(cue);
  }

  function refreshAllUi() {
    renderSfxPads();
    renderCueList();
    renderMonitors();
    renderEditor();
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
  }

  function updateAudioBadgeLabel() {
    const sel = $('audio-device-select');
    const opt = sel && sel.selectedOptions && sel.selectedOptions[0];
    if (!opt || !sel.value) {
      $('audio-status-text').textContent = 'Loa: Mặc định';
    } else {
      const shortName = opt.textContent.replace(/\s*\(.*?\)\s*/g, '').slice(0, 18);
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

  /** Đồng bộ luồng tín hiệu đưa vào bộ phân tích DSP: nhạc phần mềm ('internal') hoặc Mixer/DJ ('external') */
  function syncAnalysisSourceRouting() {
    const liveCue = getLiveCue();
    const selCue = getSelectedCue();
    const track = audioEngine.getCurrentTrackInfo();
    const extOn = audioEngine.isExternalInputActive();

    let useExternal = false;
    if (liveCue && liveCue.fx && liveCue.fx.on) {
      useExternal = liveCue.fx.src === 'ext' && extOn;
    } else if (extOn && !track.playing) {
      useExternal = true;
    } else if (selCue && selCue.fx && selCue.fx.src === 'ext' && extOn && !track.playing) {
      useExternal = true;
    }

    audioEngine.setAnalysisSourceMode(useExternal ? 'external' : 'internal');
    const refCue = liveCue || selCue;
    if (refCue && refCue.fx) {
      audioEngine.configureBassAnalysis(refCue.fx);
    }
  }

  function updateInputStatusPill(active, labelText) {
    const pill = $('input-status-pill');
    const txt = $('input-status-text');
    if (!pill || !txt) return;
    pill.classList.remove('is-idle', 'is-live-input', 'is-off');
    if (active) {
      pill.classList.add('is-live-input');
      const clean = (labelText || 'Line-In').replace(/\s*\(.*?\)\s*/g, '').slice(0, 16);
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

  /** Vẽ sóng âm xám-xanh thanh lịch kết hợp phổ âm trực tiếp trên thanh Media Console */
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
        ctx.fillStyle = specVal > 0.75 ? '#38BDF8' : '#00D2FF';
      } else {
        ctx.fillStyle = playing ? '#333F58' : '#242D40';
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

    ctx.fillStyle = '#080B10';
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

    if (bassChartPoints.length < 2) return;

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

    ctx.strokeStyle = '#00D2FF';
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

  function animationLoop() {
    const nowMs = performance.now();
    const bars = audioEngine.sampleSpectrum();
    const extSpec = audioEngine.sampleExternalSpectrum();
    const extOn = audioEngine.isExternalInputActive();
    const track = audioEngine.getCurrentTrackInfo();
    const progressRatio = track.duration > 0 ? logic.clamp(track.currentTime / track.duration, 0, 1) : 0;

    // Nếu không phát nhạc nội bộ mà đang mở cổng Mixer/DJ -> hiển thị phổ sóng âm trực tiếp của DJ
    if (!track.playing && extOn) {
      drawDeckWaveform(extSpec.bars, 0, true);
    } else {
      drawDeckWaveform(bars, progressRatio, track.playing);
    }
    drawBassChart(nowMs);

    // Cập nhật VU Meter cho Master, SFX và ngõ vào Mixer/DJ
    let sumBar = 0;
    for (let i = 0; i < 24; i++) sumBar += bars[i];
    const avgLevel = track.playing ? (sumBar / 24) * (Number($('master-vol').value) / 100) * 1.35 : 0;
    updateVuMeter('master-vu-meter', avgLevel);

    state.sfxVuLevel = Math.max(0, state.sfxVuLevel - 0.03);
    updateVuMeter('sfx-vu-meter', state.sfxVuLevel);

    updateVuMeter('ext-opt-vu-meter', extOn ? extSpec.level : 0);
    updateVuMeter('fx-ext-vu-meter', extOn ? extSpec.level : 0);

    // Cập nhật sóng âm tiến trình mini trên thẻ Cue đang phát nhạc
    document.querySelectorAll('[data-cue-wave]').forEach((el) => {
      if (track.playing && el.dataset.cueWave === track.cueId) {
        el.style.width = `${(progressRatio * 100).toFixed(1)}%`;
      } else {
        el.style.width = '0%';
      }
    });

    // Cập nhật beat/giây
    const rateCutoff = nowMs - 2000;
    while (beatRateTimestamps.length > 0 && beatRateTimestamps[0] < rateCutoff) {
      beatRateTimestamps.shift();
    }
    const beatsPerSec = (beatRateTimestamps.length / 2).toFixed(1);
    $('beat-rate').textContent = `${beatsPerSec} /s`;

    // Hiển thị tên bài hoặc trạng thái thu trực tiếp từ Mixer/DJ
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

    // Bộ đếm giờ trên khung ĐANG CHẠY (LIVE)
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

    // Chế độ thử beat hoặc BPM cố định
    const liveCue = getLiveCue();
    if (state.testBeatOn) {
      const selCue = getSelectedCue() || liveCue;
      const fx = selCue ? selCue.fx : logic.createDefaultFx({ on: true });
      const elapsedSec = (nowMs - testBeatStartMs) / 1000;
      const step = testBeatTracker.step(elapsedSec, fx.bpm, fx.off);
      if (step.isBeat) {
        flashBeatLamp(nowMs);
        if (!state.rehearsalMode) {
          window.api.sendToLed({ type: 'beat', k: step.k, fx: { ...fx, on: true } });
        }
      }
    } else if (liveCue && liveCue.fx && liveCue.fx.on && liveCue.fx.src === 'bpm' && track.playing) {
      const fx = liveCue.fx;
      const res = bpmBeatTracker.step(track.currentTime, fx.bpm, fx.off);
      if (res.isBeat) {
        flashBeatLamp(nowMs);
        if (!state.rehearsalMode) {
          window.api.sendToLed({ type: 'beat', k: res.k, fx });
        }
      }
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

      // Hỗ trợ kéo thả file âm thanh trực tiếp lên ô SFX khi không ở chế độ khóa Show
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
        showBanner(`Đã gán âm thanh "${window.api.baseName(paths[0])}" vào ô SFX "${pad.name}".`);
      });

      container.appendChild(btn);
    });
  }

  /** Kích hoạt hiệu ứng đèn viền sáng rực & chớp nháy kiểu nút Cue trên bàn DJ khi vừa nhấn */
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
      // Ép trình duyệt khởi động lại chu kỳ chớp sáng ngay lập tức khi nhấp dồn liên tiếp như bàn DJ
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

    // Luôn bật đèn chớp viền kiểu nút Cue bàn DJ ngay khi nhấn chuột hoặc phím tắt
    triggerDjPadBurst(pad.id);

    // Không bao giờ tự bung cửa sổ Cài đặt SFX khi bấm vào ô trống (ở mọi chế độ Biên tập / Tập dượt / Show)
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

    // Tabs Thuộc tính Cue
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        $(btn.dataset.tab).classList.add('active');
      });
    });

    $('alert-banner-close').addEventListener('click', hideBanner);

    // Status pills & Gear trên Topbar
    const toggleLedAction = async () => {
      if (state.ledStatus.isOpen) {
        const st = await window.api.closeLed();
        renderLedAndDisplayUi(st);
      } else {
        const st = await window.api.openLed($('display-select').value);
        renderLedAndDisplayUi(st);
      }
    };
    $('btn-toggle-led').addEventListener('click', toggleLedAction);
    $('led-status-pill').addEventListener('click', toggleLedAction);

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

    // Nút GO & Nút chức năng & Bảng 6 ô SFX
    $('btn-go').addEventListener('click', handleGo);
    $('btn-blackout').addEventListener('click', toggleBlackout);
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

    // Chặn hành vi trình duyệt tự chuyển trang khi lỡ kéo thả tệp ra ngoài vùng nhận
    window.addEventListener('dragover', (e) => {
      if (isExternalFileDrag(e)) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (isExternalFileDrag(e)) {
        e.preventDefault();
        clearCuePanelDragVisuals();
      }
    });

    // Kéo thả tệp từ máy tính vào toàn bộ khung Danh sách Cue (Cột trái)
    const cuePanelEl = $('cue-panel');
    if (cuePanelEl) {
      cuePanelEl.addEventListener('dragenter', (e) => {
        if (!isExternalFileDrag(e)) return;
        e.preventDefault();
        if (!state.showMode) {
          cuePanelEl.classList.add('is-file-dragover');
        }
      });
      cuePanelEl.addEventListener('dragover', (e) => {
        if (!isExternalFileDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = state.showMode ? 'none' : 'copy';
        if (!state.showMode) {
          cuePanelEl.classList.add('is-file-dragover');
        }
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
      });
    };

    bindCueEdit('ed-name', 'input', (c, el) => {
      if (state.showMode) return;
      c.name = el.value.trim() || 'Cue chưa đặt tên';
    });
    bindCueEdit('ed-note', 'input', (c, el) => { if (!state.showMode) c.note = el.value; });
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

    // Click hoặc Kéo thả trực tiếp vào ô Hình LED (#dropzone-vis / #tab-general) và ô Âm thanh (#dropzone-aud / #tab-audio)
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
          if (paths.length > 0) {
            await onDropFilePath(paths[0]);
          }
        });
      };

      // Bắt kéo thả trên toàn bộ tab (hoặc trực tiếp trên khung dropzone) để khung sáng nhấp nháy ổn định
      attachDropEvents(pane || zone, zone);
    };

    bindMediaDropzone('dropzone-vis', 'tab-general', pickVisualAction, (p) => assignVisualFileToSelectedCue(p, true));
    bindMediaDropzone('dropzone-aud', 'tab-audio', pickAudioAction, (p) => assignAudioFileToSelectedCue(p, true));

    // Nếu danh sách chưa có Cue nào mà kéo thả tệp vào khung trống bên phải (#editor-empty) -> tự tạo Cue luôn
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

    // Hiệu ứng Beat FX & Rung nền (vẫn cho phép chỉnh trực tiếp trong CHẾ ĐỘ SHOW)
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
      fx.src = ['auto', 'bpm', 'ext'].includes(el.value) ? el.value : 'auto';
      $('fx-bpm-controls').classList.toggle('hidden', fx.src !== 'bpm');
      $('fx-ext-controls').classList.toggle('hidden', fx.src !== 'ext');
      $('wrap-fx-delay').classList.toggle('hidden', fx.src === 'ext');
      if (fx.src === 'ext' && !audioEngine.isExternalInputActive()) {
        enableExternalMixerInput(true);
      } else {
        syncAnalysisSourceRouting();
      }
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

    $('btn-tap-bpm').addEventListener('click', () => {
      const cue = getSelectedCue();
      if (!cue) return;
      state.tapTimestamps.push(performance.now());
      if (state.tapTimestamps.length > 10) state.tapTimestamps.shift();
      const bpm = logic.calculateTapBpm(state.tapTimestamps);
      if (bpm !== null) {
        cue.fx.bpm = bpm;
        $('fx-bpm').value = bpm;
        scheduleAutosave();
        sendLiveCueFxIfActive(cue);
      }
    });

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
        scale: cue.fx.scale,
        shake: cue.fx.shake,
        rot: cue.fx.rot,
        bright: cue.fx.bright,
        hue: cue.fx.hue,
        flash: cue.fx.flash,
        decay: cue.fx.decay,
        motion: cue.fx.motion,
        step: cue.fx.step,
        over: cue.fx.over,
        idleOn: cue.fx.idleOn,
        idleAmp: cue.fx.idleAmp,
        idleRot: cue.fx.idleRot,
        idleBreath: cue.fx.idleBreath,
        idleSpeed: cue.fx.idleSpeed,
        idleStyle: cue.fx.idleStyle,
        idleCouple: cue.fx.idleCouple,
        idleOnlyMusic: cue.fx.idleOnlyMusic
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

    // Modals: Kiểm tra giờ G, Công cụ mở rộng, Trợ giúp
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
    });

    $('btn-apply-remote').addEventListener('click', async () => {
      const enable = $('remote-enable').checked;
      const pin = $('remote-pin').value.trim();
      const st = await window.api.toggleRemote(enable, pin);
      updateRemoteUi(st);
    });
  }

  function updateRemoteUi(st) {
    if (!st) return;
    $('remote-enable').checked = Boolean(st.enabled);
    $('remote-pin').value = st.pin || '1234';
    setSectionEnabled('group-remote-pin', Boolean(st.enabled));
    if (st.enabled) {
      $('remote-info').textContent = `Đang BẬT — Mở trên điện thoại: ${(st.urls || []).join(' hoặc ')} (PIN: ${st.pin}, đang nối: ${st.clients || 0})`;
    } else {
      $('remote-info').textContent = 'Đang TẮT. Gạt nút bật để lấy địa chỉ truy cập trên điện thoại cùng Wi-Fi.';
    }
  }

  // =========================================================================
  // MỞ / LƯU / GÓI DỰ ÁN
  // =========================================================================

  async function openProjectAction() {
    const res = await window.api.openProjectDialog();
    if (!res || res.canceled) return;
    if (!res.ok) {
      showBanner(res.error || 'Không mở được tệp dự án.');
      return;
    }
    pushUndoSnapshot();
    state.project = res.project;
    state.projectFilePath = res.filePath;
    state.selectedIndex = state.project.cues.length > 0 ? 0 : -1;
    state.liveCueId = null;
    state.liveCueSnapshot = null;
    scheduleAutosave();
    await verifyAllMediaFiles();
    renderSfxPads();
    refreshAllUi();
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
    state.projectFilePath = res.filePath;
    scheduleAutosave();
    await verifyAllMediaFiles();
    renderSfxPads();
    refreshAllUi();
    const missMsg = res.missingFiles && res.missingFiles.length > 0
      ? ` (Lưu ý: ${res.missingFiles.length} tệp bị thiếu không chép được)`
      : '';
    showBanner(`Đã gói ${res.copiedCount} tệp media vào thư mục cùng dự án!${missMsg}`);
  }

  // =========================================================================
  // KHỞI ĐỘNG ỨNG DỤNG
  // =========================================================================

  async function bootstrap() {
    initVuMeters();

    const inputMapper = new window.EventRunnerInputMapper({
      onGo: handleGo,
      onSelectDelta: handleSelectDelta,
      onToggleBlackout: toggleBlackout,
      onFadeMusic: fadeOutMusicPanic,
      onStopAll: stopAllPanic,
      onToggleTestPattern: toggleTestPattern,
      onSave: saveProjectAction,
      onOpen: openProjectAction,
      onUndo: performUndo,
      onRedo: performRedo,
      onTriggerSfx: triggerSfxPad
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
      $('midi-lbl-' + act).textContent = sig;
      window.api.setSettings({ midiMap: fullMap });
    };

    document.querySelectorAll('[data-midi-learn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.midiLearn;
        $('midi-lbl-' + act).textContent = 'Bấm nút trên MIDI...';
        inputMapper.startLearn(act);
      });
    });

    $('btn-midi-clear').addEventListener('click', () => {
      const empty = { go: null, blackout: null, stopAll: null };
      inputMapper.setMidiMap(empty);
      ['go', 'blackout', 'stopAll'].forEach((a) => { $('midi-lbl-' + a).textContent = 'Chưa gán'; });
      window.api.setSettings({ midiMap: empty });
    });

    // Beat từ AudioWorklet -> gửi sang LED NGAY LẬP TỨC (hỗ trợ cả nhạc phần mềm lẫn Line-In Mixer/DJ)
    audioEngine.onBassBeat = (beat) => {
      const nowMs = performance.now();
      const track = audioEngine.getCurrentTrackInfo();
      const extOn = audioEngine.isExternalInputActive();
      const liveCue = getLiveCue();

      const liveWantsExt = Boolean(liveCue && liveCue.fx && liveCue.fx.on && liveCue.fx.src === 'ext' && extOn);
      const liveWantsAuto = Boolean(liveCue && liveCue.fx && liveCue.fx.on && liveCue.fx.src === 'auto' && track.playing);

      if (liveWantsExt || liveWantsAuto) {
        bassChartBeats.push(nowMs);
        flashBeatLamp(nowMs);
        if (!state.rehearsalMode) {
          window.api.sendToLed({ type: 'beat', k: beat.k, fx: liveCue.fx });
        }
      } else if (!liveCue && extOn && !track.playing) {
        // Khi chưa bấm GO nhưng đang bật thu Mixer để căn chỉnh Input Gain / Độ nhạy trước giờ diễn
        bassChartBeats.push(nowMs);
        flashBeatLamp(nowMs);
      }
    };

    audioEngine.onBassTelemetry = (msg) => {
      const nowMs = performance.now();
      const track = audioEngine.getCurrentTrackInfo();
      const extOn = audioEngine.isExternalInputActive();
      const liveCue = getLiveCue();
      const usingExt = Boolean(extOn && ((liveCue && liveCue.fx && liveCue.fx.src === 'ext') || !track.playing));

      if (track.playing || usingExt) {
        bassChartPoints.push({
          timeMs: nowMs,
          o: msg.o || 0,
          threshold: msg.threshold || 0.015
        });
      }
      if (!state.rehearsalMode) {
        // Với nguồn Mixer/DJ: coi là đang có nhạc khi năng lượng đầu vào vượt ngưỡng tĩnh lặng (> 0.012)
        const hasMusicSignal = usingExt ? ((msg.env || 0) > 0.012) : track.playing;
        window.api.sendToLed({
          type: 'level',
          env: hasMusicSignal ? (msg.env || 0) : 0,
          playing: hasMusicSignal
        });
      }
    };

    audioEngine.onWorkletFallback = (msg) => showBanner(msg);
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

    window.api.onLedReady((ledStatus) => {
      renderLedAndDisplayUi(ledStatus);
      syncLivePreviewVideoAudio();
      const liveCue = getLiveCue();
      if (liveCue && !state.rehearsalMode) {
        const visUrl = liveCue.vis ? window.api.toFileUrl(liveCue.vis, state.projectFilePath) : null;
        const kind = liveCue.vis ? (logic.detectMediaKind(liveCue.vis) === 'image' ? 'image' : 'video') : null;
        window.api.sendToLed({
          type: 'show',
          cue: { ...JSON.parse(JSON.stringify(liveCue)), tr: 'cut', dur: 0 },
          url: visUrl,
          mediaKind: kind,
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
    });

    window.api.onLedMediaError(({ path, message }) => {
      if (path) state.codecErrorMap[path] = true;
      showBanner(message || 'File này không phát được, hãy chuyển sang MP4 H.264');
      renderCueList();
    });

    window.api.onRemoteCommand((cmd) => {
      if (cmd === 'GO') handleGo();
      else if (cmd === 'BACK') handleSelectDelta(-1);
      else if (cmd === 'BLACK') toggleBlackout();
      else if (cmd === 'STOP') stopAllPanic();
    });

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
      ['go', 'blackout', 'stopAll'].forEach((a) => {
        if (state.settings.midiMap[a]) $('midi-lbl-' + a).textContent = state.settings.midiMap[a];
      });
    }

    const autosave = await window.api.loadAutosave();
    if (autosave && autosave.exists && autosave.project) {
      state.project = autosave.project;
      state.projectFilePath = autosave.projectFilePath || null;
      state.selectedIndex = state.project.cues.length > 0 ? 0 : -1;
    }

    bindUiEvents();
    renderSfxPads();
    refreshAllUi();
    await verifyAllMediaFiles();

    const [displays, ledStatus] = await Promise.all([
      window.api.listDisplays(),
      window.api.getLedStatus()
    ]);
    renderLedAndDisplayUi(ledStatus, displays);
    await refreshAudioDevices();
    await refreshInputDevices();
    if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
      navigator.mediaDevices.addEventListener('devicechange', () => {
        refreshAudioDevices();
        refreshInputDevices();
      });
    }
    inputMapper.initMidi();

    $('clock-display').textContent = new Date().toTimeString().slice(0, 8);
    setInterval(() => {
      $('clock-display').textContent = new Date().toTimeString().slice(0, 8);
    }, 500);
    setInterval(verifyAllMediaFiles, 10000);

    requestAnimationFrame(animationLoop);
  }

  window.addEventListener('DOMContentLoaded', bootstrap);
})();
