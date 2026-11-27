/**
 * Giao diện & điều khiển 4 lớp Overlay kiểu vMix (OV1 Lower Third, OV2 Corner Logo,
 * OV3 Event Timer / Countdown, OV4 Marquee Ticker) + Tin nhắn gửi MC / Stage Display.
 */
'use strict';

(function (root) {
  const $ = (id) => document.getElementById(id);

  function formatMmSs(totalSec) {
    const s = Math.max(0, Math.floor(Number(totalSec) || 0));
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    if (hrs > 0) {
      return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  class OverlaysController {
    constructor(deps) {
      this.deps = deps; // { logic, getProject, getProjectFilePath, isRehearsalMode, scheduleAutosave, showBanner, onOverlaysChanged, onStageMessageChanged }
      this.stageMessage = '';
      this.ov1AutoHideTimer = null;
      this.timerRemainingSec = 300;
      this.timerElapsedSec = 0;
      this.lastTickWallMs = 0;
      this.lastSentTimerText = '';
      this._bound = false;
    }

    getOverlays() {
      const proj = this.deps.getProject();
      if (!proj.overlays) {
        proj.overlays = this.deps.logic.createDefaultOverlays();
      }
      return proj.overlays;
    }

    getTimerDisplay() {
      const ov3 = this.getOverlays().ov3;
      const mode = ov3.mode || 'countdown';
      if (mode === 'clock') {
        return {
          text: new Date().toTimeString().slice(0, 8),
          urgent: false,
          label: ov3.label || ''
        };
      }
      if (mode === 'countup') {
        return {
          text: formatMmSs(this.timerElapsedSec),
          urgent: false,
          label: ov3.label || ''
        };
      }
      const rem = Math.max(0, this.timerRemainingSec);
      const urgent = rem <= (Number(ov3.warnSec) || 30);
      return {
        text: formatMmSs(rem),
        urgent,
        label: ov3.label || 'ĐẾM NGƯỢC'
      };
    }

    buildLedPayload() {
      const ov = this.getOverlays();
      const copy = JSON.parse(JSON.stringify(ov));
      if (copy.ov2) {
        copy.ov2.url = copy.ov2.path
          ? window.api.toFileUrl(copy.ov2.path, this.deps.getProjectFilePath())
          : null;
      }
      return {
        overlays: copy,
        timerDisplay: this.getTimerDisplay()
      };
    }

    pushToLed(forceBroadcast = true) {
      const payload = this.buildLedPayload();
      if (!this.deps.isRehearsalMode()) {
        window.api.sendToLed({
          type: 'overlays',
          overlays: payload.overlays,
          timerDisplay: payload.timerDisplay
        });
      }
      this.syncSwitcherButtons();
      if (forceBroadcast && typeof this.deps.onOverlaysChanged === 'function') {
        this.deps.onOverlaysChanged(payload);
      }
    }

    _armOv1AutoHide() {
      clearTimeout(this.ov1AutoHideTimer);
      this.ov1AutoHideTimer = null;
      const ov1 = this.getOverlays().ov1;
      const sec = Math.max(0, Number(ov1.autoHideSec) || 0);
      if (ov1.active && sec > 0) {
        this.ov1AutoHideTimer = setTimeout(() => {
          ov1.active = false;
          if ($('ov1-active')) $('ov1-active').checked = false;
          this.deps.scheduleAutosave();
          this.pushToLed(true);
        }, sec * 1000);
      }
    }

    toggleOverlay(num, explicitState) {
      const key = 'ov' + num;
      const overlays = this.getOverlays();
      if (!overlays[key]) return;
      const nextState = explicitState !== undefined ? Boolean(explicitState) : !overlays[key].active;
      overlays[key].active = nextState;
      const chk = $(key + '-active');
      if (chk) chk.checked = nextState;

      if (num === 1) {
        this._armOv1AutoHide();
      }
      if (num === 3 && nextState && !overlays.ov3.running && overlays.ov3.mode !== 'clock') {
        // Khi bật OV3 nếu timer đang ở 0 thì đặt lại theo durationSec
        if (this.timerRemainingSec <= 0 && overlays.ov3.mode === 'countdown') {
          this.timerRemainingSec = Math.max(0, Number(overlays.ov3.durationSec) || 300);
        }
      }

      this.deps.scheduleAutosave();
      this.pushToLed(true);
    }

    syncSwitcherButtons() {
      const ov = this.getOverlays();
      for (let i = 1; i <= 4; i++) {
        const btn = $('btn-sw-ov' + i);
        if (btn) {
          btn.classList.toggle('is-lit', Boolean(ov['ov' + i] && ov['ov' + i].active));
        }
      }
    }

    startTimer() {
      const ov3 = this.getOverlays().ov3;
      if (ov3.mode === 'countdown' && this.timerRemainingSec <= 0) {
        this.timerRemainingSec = Math.max(0, Number(ov3.durationSec) || 300);
      }
      ov3.running = true;
      this.lastTickWallMs = performance.now();
      this.deps.scheduleAutosave();
      this.updateTimerPreviewDom();
      this.pushToLed(true);
    }

    pauseTimer() {
      const ov3 = this.getOverlays().ov3;
      ov3.running = false;
      this.lastTickWallMs = 0;
      this.deps.scheduleAutosave();
      this.updateTimerPreviewDom();
      this.pushToLed(true);
    }

    resetTimer() {
      const ov3 = this.getOverlays().ov3;
      ov3.running = false;
      this.timerRemainingSec = Math.max(0, Number(ov3.durationSec) || 300);
      this.timerElapsedSec = 0;
      this.lastTickWallMs = 0;
      this.deps.scheduleAutosave();
      this.updateTimerPreviewDom();
      this.pushToLed(true);
    }

    updateTimerPreviewDom() {
      const td = this.getTimerDisplay();
      const el = $('ov3-timer-preview');
      if (el) {
        el.textContent = td.text;
        el.style.color = td.urgent ? '#EF4444' : 'var(--cyber)';
      }
      return td;
    }

    /** Gọi mỗi khung hình (60fps) trong animationLoop */
    tick(nowMs) {
      const ov3 = this.getOverlays().ov3;
      if (ov3.running && ov3.mode !== 'clock') {
        if (this.lastTickWallMs > 0) {
          const dtSec = Math.max(0, (nowMs - this.lastTickWallMs) / 1000);
          if (ov3.mode === 'countdown') {
            this.timerRemainingSec = Math.max(0, this.timerRemainingSec - dtSec);
            if (this.timerRemainingSec <= 0) {
              ov3.running = false;
            }
          } else if (ov3.mode === 'countup') {
            this.timerElapsedSec += dtSec;
          }
        }
        this.lastTickWallMs = nowMs;
      } else {
        this.lastTickWallMs = nowMs;
      }

      const td = this.updateTimerPreviewDom();
      const sig = `${td.text}|${td.urgent ? 1 : 0}|${ov3.active ? 1 : 0}`;
      if (sig !== this.lastSentTimerText) {
        this.lastSentTimerText = sig;
        if (ov3.active || ov3.running) {
          this.pushToLed(true);
        } else if (typeof this.deps.onOverlaysChanged === 'function') {
          // Vẫn cập nhật đồng hồ cho Stage Display
          this.deps.onOverlaysChanged(this.buildLedPayload());
        }
      }
    }

    setStageMessage(text) {
      this.stageMessage = String(text || '').trim();
      if ($('stage-msg-input') && $('stage-msg-input').value !== this.stageMessage) {
        $('stage-msg-input').value = this.stageMessage;
      }
      if (typeof this.deps.onStageMessageChanged === 'function') {
        this.deps.onStageMessageChanged(this.stageMessage);
      }
    }

    bindEvents() {
      if (this._bound) return;
      this._bound = true;

      // Switcher strip quick toggles
      for (let i = 1; i <= 4; i++) {
        const swBtn = $('btn-sw-ov' + i);
        if (swBtn) {
          swBtn.addEventListener('click', () => this.toggleOverlay(i));
        }
      }

      // Stage message box
      if ($('btn-stage-msg-send')) {
        $('btn-stage-msg-send').addEventListener('click', () => {
          this.setStageMessage($('stage-msg-input').value);
        });
      }
      if ($('btn-stage-msg-clear')) {
        $('btn-stage-msg-clear').addEventListener('click', () => {
          this.setStageMessage('');
        });
      }
      if ($('stage-msg-input')) {
        $('stage-msg-input').addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey)) {
            e.preventDefault();
            this.setStageMessage($('stage-msg-input').value);
          }
        });
      }

      // OV1 Lower Third
      $('ov1-active').addEventListener('change', (e) => this.toggleOverlay(1, e.target.checked));
      const bindOv1 = (id, evName, fn) => {
        $(id).addEventListener(evName, (e) => {
          fn(this.getOverlays().ov1, e.target);
          this.deps.scheduleAutosave();
          this.pushToLed(true);
        });
      };
      bindOv1('ov1-title', 'input', (o, el) => { o.title = el.value; });
      bindOv1('ov1-subtitle', 'input', (o, el) => { o.subtitle = el.value; });
      bindOv1('ov1-theme', 'change', (o, el) => { o.theme = el.value; });
      bindOv1('ov1-pos', 'change', (o, el) => { o.pos = el.value; });
      bindOv1('ov1-accent', 'input', (o, el) => { o.accentColor = el.value; });
      bindOv1('ov1-autohide', 'change', (o, el) => {
        o.autoHideSec = this.deps.logic.clamp(el.value, 0, 120);
        this._armOv1AutoHide();
      });

      // OV2 Corner Logo
      $('ov2-active').addEventListener('change', (e) => this.toggleOverlay(2, e.target.checked));
      $('btn-ov2-pick').addEventListener('click', async () => {
        const files = await window.api.pickVisual();
        if (!files || files.length === 0) return;
        const kind = this.deps.logic.detectMediaKind(files[0]);
        if (kind !== 'image') {
          this.deps.showBanner('OV2 Logo chỉ nhận file Ảnh (PNG, WEBP, JPG, SVG).');
          return;
        }
        const ov2 = this.getOverlays().ov2;
        ov2.path = files[0];
        this.deps.scheduleAutosave();
        this.render();
        this.pushToLed(true);
      });
      $('btn-ov2-clear').addEventListener('click', () => {
        const ov2 = this.getOverlays().ov2;
        ov2.path = null;
        this.deps.scheduleAutosave();
        this.render();
        this.pushToLed(true);
      });
      const bindOv2 = (id, evName, fn) => {
        $(id).addEventListener(evName, (e) => {
          fn(this.getOverlays().ov2, e.target);
          this.deps.scheduleAutosave();
          this.pushToLed(true);
        });
      };
      bindOv2('ov2-pos', 'change', (o, el) => { o.pos = el.value; });
      bindOv2('ov2-scale', 'input', (o, el) => {
        o.scale = this.deps.logic.clamp(el.value, 4, 40);
        $('ov2-scale-v').textContent = o.scale;
      });
      bindOv2('ov2-opacity', 'input', (o, el) => {
        o.opacity = this.deps.logic.clamp(el.value, 10, 100);
        $('ov2-opacity-v').textContent = o.opacity;
      });
      bindOv2('ov2-margin', 'input', (o, el) => {
        o.margin = this.deps.logic.clamp(el.value, 0, 120);
        $('ov2-margin-v').textContent = o.margin;
      });

      // OV3 Timer / Countdown
      $('ov3-active').addEventListener('change', (e) => this.toggleOverlay(3, e.target.checked));
      $('btn-ov3-start').addEventListener('click', () => this.startTimer());
      $('btn-ov3-pause').addEventListener('click', () => this.pauseTimer());
      $('btn-ov3-reset').addEventListener('click', () => this.resetTimer());

      const bindOv3 = (id, evName, fn) => {
        $(id).addEventListener(evName, (e) => {
          fn(this.getOverlays().ov3, e.target);
          this.deps.scheduleAutosave();
          this.updateTimerPreviewDom();
          this.pushToLed(true);
        });
      };
      bindOv3('ov3-mode', 'change', (o, el) => { o.mode = el.value; });
      bindOv3('ov3-duration', 'change', (o, el) => {
        o.durationSec = this.deps.logic.clamp(el.value, 5, 86400);
        if (!o.running) this.timerRemainingSec = o.durationSec;
      });
      bindOv3('ov3-target', 'input', (o, el) => { o.targetTime = el.value; });
      bindOv3('ov3-label', 'input', (o, el) => { o.label = el.value; });
      bindOv3('ov3-pos', 'change', (o, el) => { o.pos = el.value; });
      bindOv3('ov3-warn', 'change', (o, el) => { o.warnSec = this.deps.logic.clamp(el.value, 0, 600); });
      bindOv3('ov3-size', 'input', (o, el) => {
        o.size = this.deps.logic.clamp(el.value, 20, 120);
        $('ov3-size-v').textContent = o.size;
      });
      bindOv3('ov3-color', 'input', (o, el) => { o.color = el.value; });

      // OV4 Marquee Ticker
      $('ov4-active').addEventListener('change', (e) => this.toggleOverlay(4, e.target.checked));
      const bindOv4 = (id, evName, fn) => {
        $(id).addEventListener(evName, (e) => {
          fn(this.getOverlays().ov4, e.target);
          this.deps.scheduleAutosave();
          this.pushToLed(true);
        });
      };
      bindOv4('ov4-text', 'input', (o, el) => { o.text = el.value; });
      bindOv4('ov4-pos', 'change', (o, el) => { o.pos = el.value; });
      bindOv4('ov4-speed', 'input', (o, el) => {
        o.speed = this.deps.logic.clamp(el.value, 20, 300);
        $('ov4-speed-v').textContent = o.speed;
      });
      bindOv4('ov4-size', 'input', (o, el) => {
        o.size = this.deps.logic.clamp(el.value, 16, 80);
        $('ov4-size-v').textContent = o.size;
      });
      bindOv4('ov4-bgopacity', 'input', (o, el) => {
        o.bgOpacity = this.deps.logic.clamp(el.value, 0, 100);
        $('ov4-bgopacity-v').textContent = o.bgOpacity;
      });
      bindOv4('ov4-color', 'input', (o, el) => { o.color = el.value; });
      bindOv4('ov4-bgcolor', 'input', (o, el) => { o.bgColor = el.value; });
    }

    render() {
      const ov = this.getOverlays();

      $('ov1-active').checked = Boolean(ov.ov1.active);
      $('ov1-title').value = ov.ov1.title || '';
      $('ov1-subtitle').value = ov.ov1.subtitle || '';
      $('ov1-theme').value = ov.ov1.theme || 'modern';
      $('ov1-pos').value = ov.ov1.pos || 'bottom-left';
      $('ov1-accent').value = ov.ov1.accentColor || '#00d2ff';
      $('ov1-autohide').value = ov.ov1.autoHideSec ?? 0;

      $('ov2-active').checked = Boolean(ov.ov2.active);
      $('ov2-path-label').textContent = ov.ov2.path ? window.api.baseName(ov.ov2.path) : 'Chưa chọn logo';
      $('ov2-pos').value = ov.ov2.pos || 'top-right';
      $('ov2-scale').value = ov.ov2.scale ?? 14;
      $('ov2-scale-v').textContent = ov.ov2.scale ?? 14;
      $('ov2-opacity').value = ov.ov2.opacity ?? 90;
      $('ov2-opacity-v').textContent = ov.ov2.opacity ?? 90;
      $('ov2-margin').value = ov.ov2.margin ?? 28;
      $('ov2-margin-v').textContent = ov.ov2.margin ?? 28;

      $('ov3-active').checked = Boolean(ov.ov3.active);
      $('ov3-mode').value = ov.ov3.mode || 'countdown';
      $('ov3-duration').value = ov.ov3.durationSec ?? 300;
      $('ov3-target').value = ov.ov3.targetTime || '20:00';
      $('ov3-label').value = ov.ov3.label ?? 'ĐẾM NGƯỢC';
      $('ov3-pos').value = ov.ov3.pos || 'top-left';
      $('ov3-warn').value = ov.ov3.warnSec ?? 30;
      $('ov3-size').value = ov.ov3.size ?? 46;
      $('ov3-size-v').textContent = ov.ov3.size ?? 46;
      $('ov3-color').value = ov.ov3.color || '#ffffff';

      if (!ov.ov3.running && ov.ov3.mode === 'countdown' && this.timerRemainingSec <= 0) {
        this.timerRemainingSec = Math.max(0, Number(ov.ov3.durationSec) || 300);
      }
      this.updateTimerPreviewDom();

      $('ov4-active').checked = Boolean(ov.ov4.active);
      $('ov4-text').value = ov.ov4.text || '';
      $('ov4-pos').value = ov.ov4.pos || 'bottom';
      $('ov4-speed').value = ov.ov4.speed ?? 85;
      $('ov4-speed-v').textContent = ov.ov4.speed ?? 85;
      $('ov4-size').value = ov.ov4.size ?? 28;
      $('ov4-size-v').textContent = ov.ov4.size ?? 28;
      $('ov4-bgopacity').value = ov.ov4.bgOpacity ?? 82;
      $('ov4-bgopacity-v').textContent = ov.ov4.bgOpacity ?? 82;
      $('ov4-color').value = ov.ov4.color || '#ffffff';
      $('ov4-bgcolor').value = ov.ov4.bgColor || '#08101c';

      this.syncSwitcherButtons();
    }
  }

  root.EventRunnerOverlaysUi = OverlaysController;
})(window);
