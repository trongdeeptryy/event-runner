/**
 * Quản lý phím tắt bàn phím, gán phím tùy chỉnh cho 6 nút SFX (F1..F12, phím số, chữ) và thiết bị MIDI ngoài
 * Hỗ trợ: phím biểu diễn (Flash, Strobe Hold, Tap BPM, Quick Cut, Overlays), MIDI CC liên tục,
 * Strobe Hold tạm thời qua Note/CC và đồng bộ nhịp MIDI Clock (24 PPQN).
 */
'use strict';

(function (root) {
  const RESERVED_SHOW_CODES = new Set([
    'Space',
    'NumpadEnter',
    'Escape',
    'NumpadDecimal',
    'ArrowUp',
    'ArrowDown',
    'KeyB',
    'Numpad0',
    'KeyF',
    'KeyT',
    'KeyG',
    'KeyS',
    'KeyP',
    'KeyC'
  ]);

  const MIDI_ACTION_KEYS = [
    'go',
    'blackout',
    'stopAll',
    'fadeMusic',
    'tapBpm',
    'strobeHold',
    'flashHit',
    'ov1',
    'ov2',
    'ov3',
    'ov4',
    'col1',
    'col2',
    'col3',
    'col4',
    'tbar',
    'masterDimmer',
    'strobeIntensity'
  ];

  const MIDI_CC_FADER_ACTIONS = new Set(['tbar', 'masterDimmer', 'strobeIntensity']);

  const MIDI_CC_DISPATCH = [
    ['tbar', (h, norm) => h.onMidiTbar && h.onMidiTbar(norm)],
    ['masterDimmer', (h, norm) => h.onMidiDimmer && h.onMidiDimmer(norm)],
    ['strobeIntensity', (h, norm) => h.onMidiStrobeIntensity && h.onMidiStrobeIntensity(norm)]
  ];

  const MIDI_TRIGGER_DISPATCH = [
    ['go', (h) => h.onGo && h.onGo()],
    ['blackout', (h) => h.onToggleBlackout && h.onToggleBlackout()],
    ['stopAll', (h) => h.onStopAll && h.onStopAll()],
    ['fadeMusic', (h) => h.onFadeMusic && h.onFadeMusic()],
    ['tapBpm', (h) => h.onTapBpm && h.onTapBpm()],
    ['flashHit', (h) => h.onFlashHit && h.onFlashHit()],
    ['ov1', (h) => h.onToggleOverlay && h.onToggleOverlay(1)],
    ['ov2', (h) => h.onToggleOverlay && h.onToggleOverlay(2)],
    ['ov3', (h) => h.onToggleOverlay && h.onToggleOverlay(3)],
    ['ov4', (h) => h.onToggleOverlay && h.onToggleOverlay(4)],
    ['col1', (h) => h.onTriggerVjCol && h.onTriggerVjCol(0)],
    ['col2', (h) => h.onTriggerVjCol && h.onTriggerVjCol(1)],
    ['col3', (h) => h.onTriggerVjCol && h.onTriggerVjCol(2)],
    ['col4', (h) => h.onTriggerVjCol && h.onTriggerVjCol(3)]
  ];

  function createEmptyMidiMap() {
    const map = {};
    for (let i = 0; i < MIDI_ACTION_KEYS.length; i++) {
      map[MIDI_ACTION_KEYS[i]] = null;
    }
    return map;
  }

  function formatKeyLabel(code, key) {
    if (/^F([1-9]|1[0-2])$/.test(code)) return code;
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
    if (code.startsWith('Key')) return code.slice(3);
    if (key && key.length === 1) return key.toUpperCase();
    return code;
  }

  class InputMapper {
    constructor(handlers) {
      this.handlers = handlers || {};
      this.midiAccess = null;
      this.midiMap = createEmptyMidiMap();
      this.learningAction = null;
      this.onMidiStatusChange = null;
      this.onMidiLearned = null;

      // Trạng thái giữ Strobe tạm thời từ bàn phím
      this._kbdStrobeHeld = false;

      // Bộ đếm xung đồng bộ nhịp MIDI Clock (24 PPQN)
      this._midiClockTicks = 0;
      this._midiClockLastTickMs = null;
      this._midiClockIntervals = [];

      // Bản đồ phím tắt tùy chỉnh cho 6 ô SFX: Map<ev.code, padIndex>
      this.sfxHotkeyMap = new Map();
      this.learningSfxIndex = null;
      this.onSfxKeyLearned = null;
      this.onSfxKeyConflict = null;
    }

    /** Cập nhật bảng ánh xạ phím tắt từ danh sách 6 ô SFX */
    setSfxHotkeys(pads) {
      this.sfxHotkeyMap.clear();
      if (!Array.isArray(pads)) return;
      pads.forEach((pad, idx) => {
        if (pad && typeof pad.hotkey === 'string' && pad.hotkey.trim()) {
          this.sfxHotkeyMap.set(pad.hotkey.trim(), idx);
        }
      });
    }

    startSfxKeyLearn(padIndex) {
      this.learningSfxIndex = padIndex;
    }

    cancelSfxKeyLearn() {
      this.learningSfxIndex = null;
    }

    initKeyboard() {
      // Sau khi bấm nút bằng chuột, bỏ focus để phím Space luôn ăn vào GO
      document.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('button') : null;
        if (btn && !btn.dataset.keepFocus) {
          setTimeout(() => btn.blur(), 0);
        }
      });

      document.addEventListener('keydown', (ev) => {
        // Nếu đang trong chế độ học phím tắt cho nút SFX
        if (this.learningSfxIndex !== null) {
          if (['Shift', 'Control', 'Alt', 'Meta'].includes(ev.key)) return;
          ev.preventDefault();
          ev.stopPropagation();

          if (ev.key === 'Escape') {
            const canceledIdx = this.learningSfxIndex;
            this.learningSfxIndex = null;
            this.onSfxKeyLearned && this.onSfxKeyLearned(canceledIdx, null, null);
            return;
          }

          if (RESERVED_SHOW_CODES.has(ev.code)) {
            this.onSfxKeyConflict &&
              this.onSfxKeyConflict('Phím này đã dành riêng cho điều khiển chính / biểu diễn (GO / ĐEN MÀN / FLASH / STROBE / TAP / CUT / DỪNG). Hãy bấm phím khác (ví dụ F1–F12)!');
            return;
          }

          const idx = this.learningSfxIndex;
          this.learningSfxIndex = null;
          const label = formatKeyLabel(ev.code, ev.key);
          this.onSfxKeyLearned && this.onSfxKeyLearned(idx, ev.code, label);
          return;
        }

        const active = document.activeElement;
        const tag = active ? active.tagName : '';
        const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (active && active.isContentEditable);

        // Phím tắt có Ctrl / Meta
        if (ev.ctrlKey || ev.metaKey) {
          const k = ev.key.toLowerCase();
          if (k === 's') {
            ev.preventDefault();
            this.handlers.onSave && this.handlers.onSave(ev.shiftKey);
            return;
          }
          if (k === 'o') {
            ev.preventDefault();
            this.handlers.onOpen && this.handlers.onOpen();
            return;
          }
          if (k === 'd') {
            ev.preventDefault();
            this.handlers.onToggleDrawer && this.handlers.onToggleDrawer();
            return;
          }
          if (k === 'f') {
            ev.preventDefault();
            this.handlers.onFocusSearch && this.handlers.onFocusSearch();
            return;
          }
          if (k === 'z' && !isTyping) {
            ev.preventDefault();
            this.handlers.onUndo && this.handlers.onUndo();
            return;
          }
          if (k === 'y' && !isTyping) {
            ev.preventDefault();
            this.handlers.onRedo && this.handlers.onRedo();
            return;
          }
          return;
        }

        // Phím F1..F12 của SFX vẫn cho bấm ngay cả khi con trỏ đang nằm trong ô nhập (rất tiện khi chạy show)
        const isFunctionKey = /^F([1-9]|1[0-2])$/.test(ev.code);
        if (!ev.altKey && (!isTyping || isFunctionKey)) {
          if (this.sfxHotkeyMap.has(ev.code)) {
            ev.preventDefault();
            if (!ev.repeat) {
              const padIdx = this.sfxHotkeyMap.get(ev.code);
              this.handlers.onTriggerSfx && this.handlers.onTriggerSfx(padIdx);
            }
            return;
          }
        }

        if (isTyping) {
          if (ev.key === 'Escape' && active) {
            active.blur();
          }
          return;
        }

        // Alt + Digit1..Digit4: bật/tắt 4 lớp Overlay (vMix)
        if (ev.altKey) {
          if (ev.code === 'Digit1' || ev.code === 'Digit2' || ev.code === 'Digit3' || ev.code === 'Digit4') {
            ev.preventDefault();
            if (!ev.repeat) {
              const ovIndex = Number(ev.code.slice(5));
              this.handlers.onToggleOverlay && this.handlers.onToggleOverlay(ovIndex);
            }
          }
          return;
        }

        // Shift + Space: Flash Hit nhanh
        if (ev.code === 'Space' && ev.shiftKey) {
          ev.preventDefault();
          if (!ev.repeat) {
            this.handlers.onFlashHit && this.handlers.onFlashHit();
          }
          return;
        }

        // Phím tắt điều khiển chính v2.4 + biểu diễn v3.0
        if (ev.code === 'Space' || ev.code === 'NumpadEnter') {
          ev.preventDefault();
          this.handlers.onGo && this.handlers.onGo();
          return;
        }
        if (ev.key === 'ArrowUp') {
          ev.preventDefault();
          this.handlers.onSelectDelta && this.handlers.onSelectDelta(-1);
          return;
        }
        if (ev.key === 'ArrowDown') {
          ev.preventDefault();
          this.handlers.onSelectDelta && this.handlers.onSelectDelta(1);
          return;
        }
        if (ev.code === 'KeyB' || ev.code === 'Numpad0') {
          ev.preventDefault();
          this.handlers.onToggleBlackout && this.handlers.onToggleBlackout();
          return;
        }
        if (ev.code === 'KeyF') {
          ev.preventDefault();
          this.handlers.onFadeMusic && this.handlers.onFadeMusic();
          return;
        }
        if (ev.key === 'Escape' || ev.code === 'NumpadDecimal') {
          ev.preventDefault();
          this.handlers.onStopAll && this.handlers.onStopAll();
          return;
        }
        if (ev.code === 'KeyT') {
          ev.preventDefault();
          this.handlers.onToggleTestPattern && this.handlers.onToggleTestPattern();
          return;
        }
        if (ev.code === 'KeyG') {
          ev.preventDefault();
          if (!ev.repeat) {
            this.handlers.onFlashHit && this.handlers.onFlashHit();
          }
          return;
        }
        if (ev.code === 'KeyS') {
          ev.preventDefault();
          if (!ev.repeat && !this._kbdStrobeHeld) {
            this._kbdStrobeHeld = true;
            this.handlers.onStrobeHoldChange && this.handlers.onStrobeHoldChange(true);
          }
          return;
        }
        if (ev.code === 'KeyP') {
          ev.preventDefault();
          if (!ev.repeat) {
            this.handlers.onTapBpm && this.handlers.onTapBpm();
          }
          return;
        }
        if (ev.code === 'KeyC') {
          ev.preventDefault();
          if (!ev.repeat) {
            this.handlers.onQuickCut && this.handlers.onQuickCut();
          }
        }
      });

      document.addEventListener('keyup', (ev) => {
        if (ev.code === 'KeyS' && this._kbdStrobeHeld) {
          this._kbdStrobeHeld = false;
          this.handlers.onStrobeHoldChange && this.handlers.onStrobeHoldChange(false);
        }
      });

      if (typeof root.addEventListener === 'function') {
        root.addEventListener('blur', () => {
          if (this._kbdStrobeHeld) {
            this._kbdStrobeHeld = false;
            this.handlers.onStrobeHoldChange && this.handlers.onStrobeHoldChange(false);
          }
        });
      }
    }

    setMidiMap(map) {
      const next = createEmptyMidiMap();
      if (map && typeof map === 'object') {
        for (let i = 0; i < MIDI_ACTION_KEYS.length; i++) {
          const key = MIDI_ACTION_KEYS[i];
          next[key] = typeof map[key] === 'string' && map[key] ? map[key] : null;
        }
      }
      this.midiMap = next;
    }

    startLearn(action) {
      this.learningAction = action;
    }

    cancelLearn() {
      this.learningAction = null;
    }

    async initMidi() {
      if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
        this.onMidiStatusChange && this.onMidiStatusChange('Trình duyệt không hỗ trợ Web MIDI');
        return;
      }
      try {
        this.midiAccess = await navigator.requestMIDIAccess();
        const bindInputs = () => {
          const names = [];
          for (const input of this.midiAccess.inputs.values()) {
            names.push(input.name || 'MIDI');
            input.onmidimessage = (msg) => this._handleMidiMessage(msg);
          }
          const status = names.length > 0 ? `Đã nối MIDI: ${names.join(', ')}` : 'Chưa cắm thiết bị MIDI';
          this.onMidiStatusChange && this.onMidiStatusChange(status);
        };
        bindInputs();
        this.midiAccess.onstatechange = bindInputs;
      } catch (_) {
        this.onMidiStatusChange && this.onMidiStatusChange('Không truy cập được MIDI');
      }
    }

    _resetMidiClock() {
      this._midiClockTicks = 0;
      this._midiClockLastTickMs = null;
      this._midiClockIntervals = [];
    }

    _handleMidiClockMessage(statusByte, timeStamp) {
      if (statusByte === 0xfa || statusByte === 0xfc || statusByte === 0xff) {
        this._resetMidiClock();
        return;
      }
      if (statusByte !== 0xf8) return;

      const nowMs = (typeof timeStamp === 'number' && Number.isFinite(timeStamp))
        ? timeStamp
        : (typeof performance !== 'undefined' ? performance.now() : Date.now());

      if (this._midiClockLastTickMs !== null) {
        const dt = nowMs - this._midiClockLastTickMs;
        if (dt > 1500 || dt < 0) {
          this._midiClockTicks = 0;
          this._midiClockIntervals = [];
        } else if (dt > 0) {
          this._midiClockIntervals.push(dt);
          if (this._midiClockIntervals.length > 48) {
            this._midiClockIntervals.shift();
          }
        }
      }

      this._midiClockLastTickMs = nowMs;
      this._midiClockTicks++;

      if (this._midiClockTicks % 24 === 0 && this._midiClockIntervals.length > 0) {
        const recent = this._midiClockIntervals.slice(-24);
        let sum = 0;
        for (let i = 0; i < recent.length; i++) {
          sum += recent[i];
        }
        const avgTickMs = sum / recent.length;
        if (avgTickMs > 0) {
          const rawBpm = 60000 / (avgTickMs * 24);
          const bpm = Math.min(240, Math.max(40, Math.round(rawBpm)));
          this.handlers.onMidiClockBeat && this.handlers.onMidiClockBeat(bpm);
        }
      }
    }

    _handleMidiMessage(msg) {
      const data = msg && msg.data;
      if (!data || data.length < 1) return;

      const statusByte = data[0];
      if (statusByte >= 0xf0) {
        if (statusByte >= 0xf8) {
          this._handleMidiClockMessage(statusByte, msg.timeStamp);
        }
        return;
      }

      if (data.length < 2) return;
      const status = statusByte & 0xf0;
      const noteOrCc = data[1];
      const rawVal = data.length >= 3 && data[2] !== undefined ? Number(data[2]) : 127;
      const val = Number.isFinite(rawVal) ? Math.max(0, Math.min(127, rawVal)) : 127;

      if (this.learningAction) {
        const act = this.learningAction;
        if (MIDI_CC_FADER_ACTIONS.has(act)) {
          if (status !== 0xb0) return;
          const sig = `cc:${noteOrCc}`;
          this.midiMap[act] = sig;
          this.learningAction = null;
          this.onMidiLearned && this.onMidiLearned(act, sig, { ...this.midiMap });
          return;
        }

        const isLearnTrigger = (status === 0x90 && val > 0) || (status === 0xb0 && val >= 64);
        if (!isLearnTrigger) return;
        const sig = `${status}:${noteOrCc}`;
        this.midiMap[act] = sig;
        this.learningAction = null;
        this.onMidiLearned && this.onMidiLearned(act, sig, { ...this.midiMap });
        return;
      }

      // Fader / Knob CC liên tục (0xB0)
      if (status === 0xb0) {
        const ccSig = `cc:${noteOrCc}`;
        const norm = val / 127;
        for (let i = 0; i < MIDI_CC_DISPATCH.length; i++) {
          const [key, fn] = MIDI_CC_DISPATCH[i];
          if (this.midiMap[key] === ccSig) {
            fn(this.handlers, norm);
          }
        }
      }

      // Strobe Hold tạm thời: nhấn Note On / CC >= 64 -> true; nhả Note Off / CC < 64 -> false
      const strobeTarget = this.midiMap.strobeHold;
      if (strobeTarget) {
        const noteSig = `${0x90}:${noteOrCc}`;
        const ccBtnSig = `${0xb0}:${noteOrCc}`;
        if ((status === 0x90 && val > 0 && strobeTarget === noteSig) ||
            (status === 0xb0 && val >= 64 && strobeTarget === ccBtnSig)) {
          this.handlers.onStrobeHoldChange && this.handlers.onStrobeHoldChange(true);
        } else if (((status === 0x80 || (status === 0x90 && val === 0)) && strobeTarget === noteSig) ||
                   (status === 0xb0 && val < 64 && strobeTarget === ccBtnSig)) {
          this.handlers.onStrobeHoldChange && this.handlers.onStrobeHoldChange(false);
        }
      }

      // Các nút kích hoạt (Trigger actions)
      const isTrigger = (status === 0x90 && val > 0) || (status === 0xb0 && val >= 64);
      if (!isTrigger) return;

      const sig = `${status}:${noteOrCc}`;
      for (let i = 0; i < MIDI_TRIGGER_DISPATCH.length; i++) {
        const [key, fn] = MIDI_TRIGGER_DISPATCH[i];
        if (this.midiMap[key] === sig) {
          fn(this.handlers);
        }
      }
    }
  }

  root.EventRunnerInputMapper = InputMapper;
})(typeof window !== 'undefined' ? window : globalThis);
