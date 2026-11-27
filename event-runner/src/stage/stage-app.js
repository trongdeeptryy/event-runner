/**
 * Script giao diện Stage Display (cửa sổ sân khấu / MC kiểu FreeShow)
 * Lắng nghe dữ liệu từ Control thông qua window.api.onStageUpdate và báo sẵn sàng qua notifyStageReady().
 */
'use strict';

(function () {
  const DAYS_VI = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];

  const el = {};

  function cacheElements() {
    const ids = [
      'wall-clock',
      'wall-date',
      'stage-blackout-badge',
      'timer-label',
      'event-timer',
      'stage-message-banner',
      'stage-message-text',
      'live-cue-title',
      'live-cue-sub',
      'stage-note',
      'next-cue-title',
      'next-cue-note',
      'bpm-value',
      'beat-dot-0',
      'beat-dot-1',
      'beat-dot-2',
      'beat-dot-3',
      'beat-bar-fill'
    ];
    for (const id of ids) {
      el[id] = document.getElementById(id);
    }
  }

  function updateWallClock() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    if (el['wall-clock']) {
      el['wall-clock'].textContent = `${hh}:${mm}:${ss}`;
    }
    if (el['wall-date']) {
      const dd = String(now.getDate()).padStart(2, '0');
      const mo = String(now.getMonth() + 1).padStart(2, '0');
      const yyyy = now.getFullYear();
      el['wall-date'].textContent = `${DAYS_VI[now.getDay()]}, ${dd}/${mo}/${yyyy}`;
    }
  }

  function isTimerUrgent(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (payload.timerUrgent || payload.urgent || payload.isUrgent || payload.timerWarning) {
      return true;
    }
    if (payload.timerDisplay && payload.timerDisplay.urgent) {
      return true;
    }
    if (Number.isFinite(payload.remainingSec)) {
      const warnSec = Number.isFinite(payload.warnSec) ? payload.warnSec : 30;
      return payload.remainingSec <= warnSec;
    }
    return false;
  }

  function updateBeatIndicator(payload) {
    const bpm = Number(payload && payload.bpm);
    const validBpm = Number.isFinite(bpm) && bpm > 0 ? Math.round(bpm) : 120;
    if (el['bpm-value']) {
      el['bpm-value'].textContent = `${validBpm} BPM`;
    }

    let activeBeat = -1;
    if (Number.isFinite(payload && payload.beatInBar)) {
      activeBeat = ((Math.floor(payload.beatInBar) % 4) + 4) % 4;
    } else if (Number.isFinite(payload && payload.beatIndex)) {
      activeBeat = ((Math.floor(payload.beatIndex) % 4) + 4) % 4;
    }

    for (let i = 0; i < 4; i++) {
      const dot = el[`beat-dot-${i}`];
      if (!dot) continue;
      const isActive = i === activeBeat;
      dot.classList.toggle('active', isActive);
      dot.classList.toggle('downbeat', isActive && i === 0);
    }

    if (el['beat-bar-fill']) {
      let fill = 0;
      if (Number.isFinite(payload && payload.beatPhase)) {
        const p = Math.max(0, Math.min(1, Number(payload.beatPhase)));
        fill = Math.max(0.08, 1 - p);
      } else if (activeBeat >= 0) {
        fill = (activeBeat + 1) / 4;
      }
      el['beat-bar-fill'].style.transform = `scaleX(${fill.toFixed(3)})`;
    }
  }

  function applyStageUpdate(payload) {
    if (!payload || typeof payload !== 'object') return;

    const liveTitle = payload.liveName || payload.currentTitle || payload.liveTitle || 'Chưa phát';
    const nextTitle = payload.nextName || payload.nextTitle || 'Trống';
    const noteText = String(payload.stageNote ?? payload.notes ?? payload.note ?? '').trim();
    const nextNoteText = String(payload.nextNote ?? '').trim();
    const timerText = String(
      payload.timerText ||
      (payload.timerDisplay && payload.timerDisplay.text) ||
      '--:--'
    );
    const timerLabel = String(
      payload.timerLabel ||
      (payload.timerDisplay && payload.timerDisplay.label) ||
      'ĐỒNG HỒ SỰ KIỆN'
    );
    const stageMessage = String(payload.stageMessage ?? payload.message ?? '').trim();
    const liveSub = String(payload.cueRemainingText || payload.liveSub || '').trim();
    const blackout = Boolean(payload.blackout);

    if (el['live-cue-title']) {
      el['live-cue-title'].textContent = liveTitle;
    }
    if (el['live-cue-sub']) {
      el['live-cue-sub'].textContent = liveSub;
    }
    if (el['next-cue-title']) {
      el['next-cue-title'].textContent = nextTitle;
    }
    if (el['next-cue-note']) {
      el['next-cue-note'].textContent = nextNoteText;
      el['next-cue-note'].classList.toggle('hidden', !nextNoteText);
    }

    if (el['stage-note']) {
      if (noteText) {
        el['stage-note'].textContent = noteText;
        el['stage-note'].classList.remove('is-empty');
      } else {
        el['stage-note'].textContent = 'Chưa có ghi chú cho Cue hiện tại';
        el['stage-note'].classList.add('is-empty');
      }
    }

    if (el['timer-label']) {
      el['timer-label'].textContent = timerLabel.toUpperCase();
    }
    if (el['event-timer']) {
      el['event-timer'].textContent = timerText;
      el['event-timer'].classList.toggle('urgent', isTimerUrgent(payload));
    }

    if (el['stage-message-banner'] && el['stage-message-text']) {
      el['stage-message-text'].textContent = stageMessage;
      el['stage-message-banner'].classList.toggle('hidden', !stageMessage);
    }

    if (el['stage-blackout-badge']) {
      el['stage-blackout-badge'].classList.toggle('hidden', !blackout);
    }

    updateBeatIndicator(payload);
  }

  document.addEventListener('DOMContentLoaded', () => {
    cacheElements();
    updateWallClock();
    setInterval(updateWallClock, 250);

    if (window.api && typeof window.api.onStageUpdate === 'function') {
      window.api.onStageUpdate(applyStageUpdate);
    }
    if (window.api && typeof window.api.notifyStageReady === 'function') {
      window.api.notifyStageReady();
    }
  });
})();
