/**
 * Giao diện & điều khiển Chớp LED theo Beat (Presets, Momentary Pads, 4-Beat Clock,
 * 8-Fixture DMX Stage Visualizer), Tab 5 LED Beat/DMX, và Modal Mạng DMX Art-Net/sACN & OSC.
 */
'use strict';

(function (root) {
  const $ = (id) => document.getElementById(id);

  const FIXTURE_TYPES = [
    { value: 'drgb', label: 'DRGB (4ch: Dim,R,G,B)' },
    { value: 'rgb', label: 'RGB (3ch: R,G,B)' },
    { value: 'rgbw', label: 'RGBW (4ch: R,G,B,W)' },
    { value: 'drgbs', label: 'DRGBS (5ch: Dim,R,G,B,Strobe)' },
    { value: 'drgbws', label: 'DRGBWS (6ch: Dim,R,G,B,W,Strobe)' },
    { value: 'strobe', label: 'Strobe (2ch: Dim,Strobe)' }
  ];

  class LedDmxController {
    constructor(deps) {
      this.deps = deps; // { logic, getProject, getSelectedCue, getLiveCue, isShowMode, isRehearsalMode, pushUndo, scheduleAutosave, showBanner, setSectionEnabled, onTapBpm, onAutoBpmToggle, onPhaseNudge, onPhaseResync, onDividerChange, getCurrentBpm }
      this.globalOverride = false;
      this.globalConfig = this.deps.logic.createDefaultLedSync();
      this.momentaryState = { flash: false, strobe: false, invert: false, drop: false };
      this.visualizerCells = [];
      this.flashPulseTimer = null;
      this.lastBeatLampTimer = null;
      this.activePresetName = '';
      this._bound = false;
    }

    getDmxConfig() {
      const proj = this.deps.getProject();
      if (!proj.dmxConfig) {
        proj.dmxConfig = this.deps.logic.createDefaultDmxConfig();
      }
      return proj.dmxConfig;
    }

    getOscConfig() {
      const proj = this.deps.getProject();
      if (!proj.oscConfig) {
        proj.oscConfig = this.deps.logic.createDefaultOscConfig();
      }
      return proj.oscConfig;
    }

    getActiveLedSync() {
      if (this.globalOverride) return this.globalConfig;
      const live = this.deps.getLiveCue();
      if (live && live.ledSync) return live.ledSync;
      const sel = this.deps.getSelectedCue();
      if (sel && sel.ledSync) return sel.ledSync;
      return this.globalConfig;
    }

    getEditableLedSync() {
      if (this.globalOverride) return this.globalConfig;
      const sel = this.deps.getSelectedCue();
      if (sel) {
        if (!sel.ledSync) sel.ledSync = this.deps.logic.createDefaultLedSync();
        return sel.ledSync;
      }
      return this.globalConfig;
    }

    sendLedSyncToOutput() {
      const cfg = this.getActiveLedSync();
      if (typeof this.deps.onDividerChange === 'function') {
        this.deps.onDividerChange(cfg.divider || 1);
      }
      if (!this.deps.isRehearsalMode()) {
        window.api.sendToLed({ type: 'led-sync', config: JSON.parse(JSON.stringify(cfg)) });
      }
    }

    setMomentary(action, active) {
      const next = Boolean(active);
      if (this.momentaryState[action] === next && action !== 'flash') return;
      this.momentaryState[action] = next;

      const btnMap = {
        flash: 'btn-mom-flash',
        strobe: 'btn-mom-strobe',
        invert: 'btn-mom-invert',
        drop: 'btn-mom-drop'
      };
      const btn = $(btnMap[action]);
      if (btn) btn.classList.toggle('is-pressed', next);

      if (!this.deps.isRehearsalMode()) {
        const cfg = this.getActiveLedSync();
        const colors = this.deps.logic.resolvePaletteColors(cfg);
        window.api.sendToLed({
          type: 'led-momentary',
          action,
          active: next,
          color: colors[0] || '#ffffff'
        });
      }
    }

    triggerFlashHit() {
      clearTimeout(this.flashPulseTimer);
      this.setMomentary('flash', true);
      this.flashPulseTimer = setTimeout(() => {
        this.setMomentary('flash', false);
      }, 130);
    }

    releaseAllMomentary() {
      ['flash', 'strobe', 'invert', 'drop'].forEach((act) => {
        if (this.momentaryState[act]) this.setMomentary(act, false);
      });
    }

    applyQuickPreset(presetName) {
      const presets = this.deps.logic.LED_STROBE_PRESETS || {};
      const target = this.getEditableLedSync();
      const liveCue = this.deps.getLiveCue();

      if (presetName === '__OFF__') {
        target.on = false;
        target.mode = 'off';
        if (liveCue && liveCue.ledSync && liveCue.ledSync !== target) {
          liveCue.ledSync.on = false;
          liveCue.ledSync.mode = 'off';
        }
        this.globalConfig.on = false;
        this.globalConfig.mode = 'off';
        this.activePresetName = '__OFF__';
      } else if (presets[presetName]) {
        const merged = this.deps.logic.createDefaultLedSync({ ...target, ...presets[presetName], on: true });
        Object.assign(target, merged);
        if (liveCue && liveCue.ledSync && liveCue.ledSync !== target) {
          Object.assign(liveCue.ledSync, merged);
        }
        Object.assign(this.globalConfig, merged);
        this.activePresetName = presetName;
      }

      this.deps.scheduleAutosave();
      this.renderQuickDeck();
      this.renderInspectorTab();
      this.sendLedSyncToOutput();
    }

    setLedModeBySlug(mode) {
      const valid = this.deps.logic.LED_STROBE_MODES || [];
      if (!valid.includes(mode)) return;
      const target = this.getEditableLedSync();
      target.mode = mode;
      target.on = mode !== 'off';
      const liveCue = this.deps.getLiveCue();
      if (liveCue && liveCue.ledSync && liveCue.ledSync !== target) {
        liveCue.ledSync.mode = mode;
        liveCue.ledSync.on = mode !== 'off';
      }
      this.globalConfig.mode = mode;
      this.globalConfig.on = mode !== 'off';
      this.activePresetName = '';
      this.deps.scheduleAutosave();
      this.renderQuickDeck();
      this.renderInspectorTab();
      this.sendLedSyncToOutput();
    }

    /** Khởi tạo 8 ô đèn giả lập Par LED DMX một lần để cập nhật mượt không tạo rác DOM */
    initStageVisualizer() {
      const host = $('dmx-stage-visualizer');
      if (!host) return;
      host.innerHTML = '';
      this.visualizerCells = [];
      for (let i = 0; i < 8; i++) {
        const cell = document.createElement('div');
        cell.className = 'dmx-par-cell';
        const dot = document.createElement('div');
        dot.className = 'dmx-par-dot';
        const lbl = document.createElement('span');
        lbl.className = 'dmx-par-name';
        lbl.textContent = `Par ${i + 1}`;
        cell.appendChild(dot);
        cell.appendChild(lbl);
        host.appendChild(cell);
        this.visualizerCells.push({ dot, lbl, lastText: `Par ${i + 1}`, lastBg: '' });
      }
    }

    updateStageVisualizer(previews) {
      if (!this.visualizerCells.length) return;
      for (let i = 0; i < this.visualizerCells.length; i++) {
        const cell = this.visualizerCells[i];
        const p = previews && previews[i];
        if (!p) {
          if (cell.lastBg !== 'off') {
            cell.dot.style.backgroundColor = '#151B27';
            cell.dot.style.boxShadow = 'none';
            cell.lastBg = 'off';
          }
          continue;
        }
        const shortName = (p.name || `Par ${i + 1}`).slice(0, 7);
        if (cell.lastText !== shortName) {
          cell.lbl.textContent = shortName;
          cell.lastText = shortName;
        }
        const rawDim = p.dimmer !== undefined ? Number(p.dimmer) : 1;
        const dim = rawDim > 1 ? rawDim / 255 : Math.max(0, Math.min(1, rawDim));
        const r = Math.round((p.r || 0) * dim);
        const g = Math.round((p.g || 0) * dim);
        const b = Math.round((p.b || 0) * dim);
        const bg = `rgb(${r},${g},${b})`;
        if (cell.lastBg !== bg) {
          cell.lastBg = bg;
          cell.dot.style.backgroundColor = bg;
          const lum = r + g + b;
          cell.dot.style.boxShadow = lum > 30 ? `0 0 10px rgba(${r},${g},${b},0.85)` : 'none';
        }
      }
    }

    updateBeatBarDots(beatInBar) {
      const idx = ((Number(beatInBar) || 0) % 4 + 4) % 4;
      for (let i = 0; i < 4; i++) {
        const dot = $('beat-dot-' + i);
        if (!dot) continue;
        dot.classList.toggle('is-active', i === idx);
        dot.classList.toggle('is-bar-one', i === 0 && idx === 0);
      }
    }

    flashBpmPill() {
      const pill = $('bpm-pill');
      if (!pill) return;
      pill.classList.add('is-beat-flash');
      clearTimeout(this.lastBeatLampTimer);
      this.lastBeatLampTimer = setTimeout(() => pill.classList.remove('is-beat-flash'), 90);
    }

    updateBpmPillText(bpm) {
      const el = $('bpm-pill-text');
      if (el) el.textContent = `${Math.round(Number(bpm) || 120)} BPM`;
    }

    async applyDmxConfiguration() {
      const cfg = this.getDmxConfig();
      const res = await window.api.configureDmx(cfg);
      this.updateDmxStatusUi(res);
    }

    updateDmxStatusUi(status) {
      const cfg = this.getDmxConfig();
      const st = status || {};
      const enabled = st.enabled !== undefined ? Boolean(st.enabled) : Boolean(cfg.enabled);
      const pill = $('dmx-status-pill');
      const txt = $('dmx-status-text');
      if (pill && txt) {
        pill.classList.remove('is-idle', 'is-live-input', 'is-off');
        if (!enabled) {
          pill.classList.add('is-idle');
          txt.textContent = 'DMX: Tắt';
        } else if (st.lastError) {
          pill.classList.add('is-off');
          txt.textContent = 'DMX: Lỗi';
        } else {
          pill.classList.add('is-live-input');
          const proto = (cfg.protocol || 'artnet') === 'sacn' ? 'sACN' : 'Art-Net';
          txt.textContent = `DMX: ${proto} U${cfg.universe ?? 0}`;
        }
      }
      const detail = $('dmx-status-detail');
      if (detail) {
        if (!enabled) {
          detail.textContent = 'Trạng thái: Đang tắt.';
        } else if (st.lastError) {
          detail.textContent = `Lỗi UDP DMX: ${st.lastError}`;
        } else {
          detail.textContent = `Đang phát ${(cfg.protocol || 'artnet').toUpperCase()} → ${cfg.host}:${cfg.port} (Universe ${cfg.universe}, ${cfg.fps} FPS · Đã gửi: ${st.packetsSent || 0} gói)`;
        }
      }
    }

    async applyOscConfiguration() {
      const osc = this.getOscConfig();
      const res = await window.api.toggleOsc(Boolean(osc.enabled), Number(osc.port) || 9000);
      this.updateOscStatusUi(res);
    }

    updateOscStatusUi(status) {
      const osc = this.getOscConfig();
      const detail = $('osc-status-detail');
      if (!detail) return;
      const st = status || {};
      if (st.lastError) {
        detail.textContent = `Lỗi mở cổng UDP ${st.port || osc.port}: ${st.lastError}`;
      } else if (st.enabled) {
        detail.textContent = `Đang lắng nghe UDP 0.0.0.0:${st.port || osc.port}`;
      } else {
        detail.textContent = 'Đang tắt.';
      }
    }

    showLastOscMessage(msg) {
      const el = $('osc-last-msg');
      if (!el || !msg) return;
      const argsStr = Array.isArray(msg.args) && msg.args.length > 0 ? ' ' + msg.args.join(', ') : '';
      el.textContent = `Nhận gần nhất: ${msg.address}${argsStr}`;
    }

    renderDmxModal() {
      const cfg = this.getDmxConfig();
      const osc = this.getOscConfig();

      $('dmx-enabled').checked = Boolean(cfg.enabled);
      $('dmx-protocol').value = cfg.protocol || 'artnet';
      $('dmx-host').value = cfg.host || '255.255.255.255';
      $('dmx-port').value = cfg.port || 6454;
      $('dmx-universe').value = cfg.universe ?? 0;
      $('dmx-fps').value = cfg.fps || 35;
      $('dmx-fps-v').textContent = cfg.fps || 35;
      $('dmx-master-dimmer').value = cfg.masterDimmer ?? 100;
      $('dmx-master-dimmer-v').textContent = cfg.masterDimmer ?? 100;
      $('dmx-blackout').checked = Boolean(cfg.blackout);

      $('osc-enabled').checked = Boolean(osc.enabled);
      $('osc-port').value = osc.port || 9000;

      this.renderFixtureList();
    }

    renderFixtureList() {
      const list = $('dmx-fixture-list');
      if (!list) return;
      const cfg = this.getDmxConfig();
      list.innerHTML = '';

      (cfg.fixtures || []).forEach((fix, idx) => {
        const row = document.createElement('div');
        row.className = 'dmx-fixture-row';

        const nameInp = document.createElement('input');
        nameInp.type = 'text';
        nameInp.value = fix.name || `Par ${idx + 1}`;
        nameInp.placeholder = 'Tên đèn';
        nameInp.addEventListener('input', () => {
          fix.name = nameInp.value.trim() || `Par ${idx + 1}`;
          this.deps.scheduleAutosave();
        });

        const typeSel = document.createElement('select');
        FIXTURE_TYPES.forEach((ft) => {
          const opt = document.createElement('option');
          opt.value = ft.value;
          opt.textContent = ft.label;
          typeSel.appendChild(opt);
        });
        typeSel.value = fix.type || 'drgb';
        typeSel.addEventListener('change', () => {
          fix.type = typeSel.value;
          this.deps.scheduleAutosave();
        });

        const chInp = document.createElement('input');
        chInp.type = 'number';
        chInp.min = '1';
        chInp.max = '512';
        chInp.value = String(fix.startChannel || 1);
        chInp.title = 'Kênh DMX bắt đầu (1..512)';
        chInp.addEventListener('change', () => {
          fix.startChannel = this.deps.logic.clamp(chInp.value, 1, 512);
          chInp.value = String(fix.startChannel);
          this.deps.scheduleAutosave();
        });

        const grpInp = document.createElement('input');
        grpInp.type = 'number';
        grpInp.min = '1';
        grpInp.max = '16';
        grpInp.value = String(fix.group || 1);
        grpInp.title = 'Nhóm đèn';
        grpInp.addEventListener('change', () => {
          fix.group = this.deps.logic.clamp(grpInp.value, 1, 16);
          this.deps.scheduleAutosave();
        });

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn btn-sm btn-danger-soft';
        delBtn.textContent = 'Xóa';
        delBtn.addEventListener('click', () => {
          cfg.fixtures.splice(idx, 1);
          this.deps.scheduleAutosave();
          this.renderFixtureList();
        });

        row.appendChild(nameInp);
        row.appendChild(typeSel);
        row.appendChild(chInp);
        row.appendChild(grpInp);
        row.appendChild(delBtn);
        list.appendChild(row);
      });
    }

    renderQuickDeck() {
      const host = $('led-quick-presets');
      const cfg = this.getActiveLedSync();
      if (host) {
        host.innerHTML = '';
        const presets = this.deps.logic.LED_STROBE_PRESETS || {};
        Object.keys(presets).forEach((name) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'led-preset-btn' + (this.activePresetName === name && cfg.on ? ' is-active' : '');
          btn.textContent = name;
          btn.addEventListener('click', () => this.applyQuickPreset(name));
          host.appendChild(btn);
        });

        const offBtn = document.createElement('button');
        offBtn.type = 'button';
        offBtn.className = 'led-preset-btn btn-danger-soft' + (!cfg.on ? ' is-active' : '');
        offBtn.textContent = 'Tắt chớp';
        offBtn.addEventListener('click', () => this.applyQuickPreset('__OFF__'));
        host.appendChild(offBtn);
      }

      const divVal = String(cfg.divider ?? 1);
      document.querySelectorAll('#led-div-group .led-div-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.div === divVal);
      });

      if ($('led-quick-mode')) $('led-quick-mode').value = cfg.on ? (cfg.mode || 'edge-chase') : 'off';
      if ($('led-quick-trigger')) $('led-quick-trigger').value = cfg.trigger || 'beat';
    }

    renderInspectorTab() {
      const cue = this.deps.getSelectedCue();
      const ls = this.globalOverride
        ? this.globalConfig
        : (cue ? this.deps.logic.createDefaultLedSync(cue.ledSync) : this.globalConfig);
      if (cue && !this.globalOverride) cue.ledSync = ls;

      $('ledsync-on').checked = Boolean(ls.on);
      $('ledsync-mode').value = ls.mode || 'edge-chase';
      $('ledsync-palette').value = ls.palette || 'cyber';
      $('ledsync-color-a').value = ls.colorA || '#00d2ff';
      $('ledsync-color-b').value = ls.colorB || '#ff007f';
      $('ledsync-custom-colors').classList.toggle('hidden', ls.palette !== 'custom');
      $('ledsync-trigger').value = ls.trigger || 'beat';
      $('ledsync-divider').value = String(ls.divider ?? 1);
      $('ledsync-intensity').value = ls.intensity ?? 80;
      $('ledsync-intensity-v').textContent = ls.intensity ?? 80;
      $('ledsync-decay').value = ls.decayMs ?? 180;
      $('ledsync-decay-v').textContent = ls.decayMs ?? 180;
      $('ledsync-edge').value = ls.edgeWidth ?? 10;
      $('ledsync-edge-v').textContent = ls.edgeWidth ?? 10;
      $('ledsync-blend').value = ls.blend || 'plus-lighter';
      $('ledsync-dmx-mode').value = ls.dmxMode || 'beat-flash';
      $('chk-ledsync-global').checked = this.globalOverride;

      this.deps.setSectionEnabled('group-ledsync-body', Boolean(ls.on));
    }

    bindEvents() {
      if (this._bound) return;
      this._bound = true;

      this.initStageVisualizer();
      this.renderQuickDeck();

      // Divider buttons
      document.querySelectorAll('#led-div-group .led-div-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const div = Number(btn.dataset.div) || 1;
          const target = this.getEditableLedSync();
          target.divider = div;
          const liveCue = this.deps.getLiveCue();
          if (liveCue && liveCue.ledSync && liveCue.ledSync !== target) liveCue.ledSync.divider = div;
          this.globalConfig.divider = div;
          this.deps.scheduleAutosave();
          this.renderQuickDeck();
          this.renderInspectorTab();
          this.sendLedSyncToOutput();
        });
      });

      $('led-quick-mode').addEventListener('change', (e) => {
        this.setLedModeBySlug(e.target.value);
      });

      $('led-quick-trigger').addEventListener('change', (e) => {
        const target = this.getEditableLedSync();
        target.trigger = e.target.value;
        const liveCue = this.deps.getLiveCue();
        if (liveCue && liveCue.ledSync && liveCue.ledSync !== target) liveCue.ledSync.trigger = e.target.value;
        this.globalConfig.trigger = e.target.value;
        this.deps.scheduleAutosave();
        this.renderInspectorTab();
        this.sendLedSyncToOutput();
      });

      // Momentary Performance Pads (pointerdown / pointerup / pointerleave / pointercancel)
      const bindMomentaryBtn = (id, action) => {
        const el = $(id);
        if (!el) return;
        const press = (e) => {
          e.preventDefault();
          try { el.setPointerCapture(e.pointerId); } catch (_) {}
          this.setMomentary(action, true);
        };
        const release = () => {
          this.setMomentary(action, false);
        };
        el.addEventListener('pointerdown', press);
        el.addEventListener('pointerup', release);
        el.addEventListener('pointerleave', release);
        el.addEventListener('pointercancel', release);
      };
      bindMomentaryBtn('btn-mom-flash', 'flash');
      bindMomentaryBtn('btn-mom-strobe', 'strobe');
      bindMomentaryBtn('btn-mom-invert', 'invert');
      bindMomentaryBtn('btn-mom-drop', 'drop');
      window.addEventListener('blur', () => this.releaseAllMomentary());

      // Clock / TAP / Phase Nudge
      $('btn-perf-tap-bpm').addEventListener('click', () => {
        if (typeof this.deps.onTapBpm === 'function') this.deps.onTapBpm();
      });
      $('bpm-pill').addEventListener('click', () => {
        if (typeof this.deps.onTapBpm === 'function') this.deps.onTapBpm();
      });
      $('chk-auto-bpm').addEventListener('change', (e) => {
        if (typeof this.deps.onAutoBpmToggle === 'function') this.deps.onAutoBpmToggle(e.target.checked);
      });
      $('btn-phase-nudge-back').addEventListener('click', () => {
        if (typeof this.deps.onPhaseNudge === 'function') this.deps.onPhaseNudge(-10);
      });
      $('btn-phase-nudge-fwd').addEventListener('click', () => {
        if (typeof this.deps.onPhaseNudge === 'function') this.deps.onPhaseNudge(10);
      });
      $('btn-phase-resync').addEventListener('click', () => {
        if (typeof this.deps.onPhaseResync === 'function') this.deps.onPhaseResync();
      });

      // Tab 5: Inspector LED Sync
      const bindLs = (id, evName, fn) => {
        $(id).addEventListener(evName, (e) => {
          const target = this.getEditableLedSync();
          fn(target, e.target);
          if (this.globalOverride) {
            Object.assign(this.globalConfig, target);
          } else {
            const liveCue = this.deps.getLiveCue();
            if (liveCue && liveCue.id === (this.deps.getSelectedCue() && this.deps.getSelectedCue().id)) {
              liveCue.ledSync = this.deps.logic.createDefaultLedSync(target);
            }
          }
          this.deps.scheduleAutosave();
          this.renderQuickDeck();
          this.renderInspectorTab();
          this.sendLedSyncToOutput();
        });
      };

      bindLs('ledsync-on', 'change', (ls, el) => { ls.on = el.checked; });
      bindLs('ledsync-mode', 'change', (ls, el) => { ls.mode = el.value; });
      bindLs('ledsync-palette', 'change', (ls, el) => { ls.palette = el.value; });
      bindLs('ledsync-color-a', 'input', (ls, el) => { ls.colorA = el.value; });
      bindLs('ledsync-color-b', 'input', (ls, el) => { ls.colorB = el.value; });
      bindLs('ledsync-trigger', 'change', (ls, el) => { ls.trigger = el.value; });
      bindLs('ledsync-divider', 'change', (ls, el) => { ls.divider = Number(el.value) || 1; });
      bindLs('ledsync-intensity', 'input', (ls, el) => { ls.intensity = Number(el.value); });
      bindLs('ledsync-decay', 'input', (ls, el) => { ls.decayMs = Number(el.value); });
      bindLs('ledsync-edge', 'input', (ls, el) => { ls.edgeWidth = Number(el.value); });
      bindLs('ledsync-blend', 'change', (ls, el) => { ls.blend = el.value; });
      bindLs('ledsync-dmx-mode', 'change', (ls, el) => { ls.dmxMode = el.value; });

      $('chk-ledsync-global').addEventListener('change', (e) => {
        this.globalOverride = e.target.checked;
        if (this.globalOverride) {
          const cur = this.deps.getSelectedCue() || this.deps.getLiveCue();
          if (cur && cur.ledSync) {
            this.globalConfig = this.deps.logic.createDefaultLedSync(cur.ledSync);
          }
        }
        this.renderQuickDeck();
        this.renderInspectorTab();
        this.sendLedSyncToOutput();
      });

      $('btn-ledsync-apply-all').addEventListener('click', () => {
        if (this.deps.isShowMode()) return;
        const proj = this.deps.getProject();
        const src = this.getEditableLedSync();
        this.deps.pushUndo();
        proj.cues.forEach((c) => {
          c.ledSync = this.deps.logic.createDefaultLedSync(src);
        });
        this.deps.scheduleAutosave();
        this.sendLedSyncToOutput();
        this.deps.showBanner(`Đã áp dụng cấu hình Chớp LED / DMX cho tất cả ${proj.cues.length} Cue.`);
      });

      // Modal DMX & OSC
      const openDmxModal = async () => {
        this.renderDmxModal();
        const [dmxSt, oscSt] = await Promise.all([
          window.api.getDmxStatus(),
          window.api.getOscStatus()
        ]);
        this.updateDmxStatusUi(dmxSt);
        this.updateOscStatusUi(oscSt);
        $('dmx-osc-modal').classList.remove('hidden');
      };

      $('btn-open-dmx-modal').addEventListener('click', openDmxModal);
      $('dmx-status-pill').addEventListener('click', openDmxModal);
      $('btn-close-dmx-modal').addEventListener('click', () => $('dmx-osc-modal').classList.add('hidden'));
      $('dmx-osc-modal').addEventListener('click', (e) => {
        if (e.target === $('dmx-osc-modal')) $('dmx-osc-modal').classList.add('hidden');
      });

      $('dmx-enabled').addEventListener('change', async (e) => {
        this.getDmxConfig().enabled = e.target.checked;
        this.deps.scheduleAutosave();
        await this.applyDmxConfiguration();
      });

      $('dmx-protocol').addEventListener('change', async (e) => {
        const cfg = this.getDmxConfig();
        cfg.protocol = e.target.value === 'sacn' ? 'sacn' : 'artnet';
        if (cfg.protocol === 'sacn') {
          if (cfg.port === 6454) cfg.port = 5568;
          if (cfg.universe === 0) cfg.universe = 1;
          if (cfg.host === '255.255.255.255') {
            const u = this.deps.logic.clamp(cfg.universe, 1, 63999);
            cfg.host = `239.255.${(u >> 8) & 0xff}.${u & 0xff}`;
          }
        } else {
          if (cfg.port === 5568) cfg.port = 6454;
          if (/^239\.255\./.test(cfg.host)) cfg.host = '255.255.255.255';
        }
        this.deps.scheduleAutosave();
        this.renderDmxModal();
        await this.applyDmxConfiguration();
      });

      ['dmx-host', 'dmx-port', 'dmx-universe'].forEach((id) => {
        $(id).addEventListener('change', async () => {
          const cfg = this.getDmxConfig();
          cfg.host = $('dmx-host').value.trim() || '255.255.255.255';
          cfg.port = this.deps.logic.clamp($('dmx-port').value, 1, 65535);
          cfg.universe = this.deps.logic.clamp($('dmx-universe').value, 0, 63999);
          this.deps.scheduleAutosave();
          await this.applyDmxConfiguration();
        });
      });

      $('dmx-fps').addEventListener('input', (e) => {
        const cfg = this.getDmxConfig();
        cfg.fps = this.deps.logic.clamp(e.target.value, 5, 44);
        $('dmx-fps-v').textContent = cfg.fps;
        this.deps.scheduleAutosave();
      });
      $('dmx-fps').addEventListener('change', () => this.applyDmxConfiguration());

      $('dmx-master-dimmer').addEventListener('input', (e) => {
        const cfg = this.getDmxConfig();
        cfg.masterDimmer = this.deps.logic.clamp(e.target.value, 0, 100);
        $('dmx-master-dimmer-v').textContent = cfg.masterDimmer;
        this.deps.scheduleAutosave();
      });

      $('dmx-blackout').addEventListener('change', (e) => {
        this.getDmxConfig().blackout = e.target.checked;
        this.deps.scheduleAutosave();
      });

      $('btn-dmx-add-fixture').addEventListener('click', () => {
        const cfg = this.getDmxConfig();
        const last = cfg.fixtures[cfg.fixtures.length - 1];
        const nextCh = last ? this.deps.logic.clamp((last.startChannel || 1) + 4, 1, 506) : 1;
        cfg.fixtures.push({
          id: this.deps.logic.generateId(),
          name: `Par ${cfg.fixtures.length + 1}`,
          type: 'drgb',
          startChannel: nextCh,
          group: ((cfg.fixtures.length) % 4) + 1
        });
        this.deps.scheduleAutosave();
        this.renderFixtureList();
      });

      $('btn-dmx-reset-fixtures').addEventListener('click', () => {
        const cfg = this.getDmxConfig();
        cfg.fixtures = this.deps.logic.createDefaultDmxConfig().fixtures;
        this.deps.scheduleAutosave();
        this.renderFixtureList();
      });

      $('osc-enabled').addEventListener('change', async (e) => {
        const osc = this.getOscConfig();
        osc.enabled = e.target.checked;
        osc.port = this.deps.logic.clamp($('osc-port').value, 1024, 65535);
        this.deps.scheduleAutosave();
        await this.applyOscConfiguration();
      });

      $('osc-port').addEventListener('change', async (e) => {
        const osc = this.getOscConfig();
        osc.port = this.deps.logic.clamp(e.target.value, 1024, 65535);
        e.target.value = String(osc.port);
        this.deps.scheduleAutosave();
        if (osc.enabled) await this.applyOscConfiguration();
      });
    }
  }

  root.EventRunnerLedDmxUi = LedDmxController;
})(window);
