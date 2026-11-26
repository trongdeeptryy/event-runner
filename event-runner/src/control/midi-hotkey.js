/**
 * Quản lý phím tắt bàn phím, gán phím tùy chỉnh cho 6 nút SFX (F1..F12, phím số, chữ) và thiết bị MIDI ngoài
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
    'KeyT'
  ]);

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
      this.midiMap = { go: null, blackout: null, stopAll: null };
      this.learningAction = null; // 'go' | 'blackout' | 'stopAll' | null
      this.onMidiStatusChange = null;
      this.onMidiLearned = null;

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
              this.onSfxKeyConflict('Phím này đã dành riêng cho điều khiển chính (GO / ĐEN MÀN / TẮT NHẠC / DỪNG). Hãy bấm phím khác (ví dụ F1–F12)!');
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

        // Phím tắt có Ctrl
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
        }

        // Phím F1..F12 của SFX vẫn cho bấm ngay cả khi con trỏ đang nằm trong ô nhập (rất tiện khi chạy show)
        const isFunctionKey = /^F([1-9]|1[0-2])$/.test(ev.code);
        if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && (!isTyping || isFunctionKey)) {
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

        // Phím tắt điều khiển chính
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
        }
      });
    }

    setMidiMap(map) {
      if (map && typeof map === 'object') {
        this.midiMap = {
          go: map.go || null,
          blackout: map.blackout || null,
          stopAll: map.stopAll || null
        };
      }
    }

    startLearn(action) {
      this.learningAction = action;
    }

    cancelLearn() {
      this.learningAction = null;
    }

    async initMidi() {
      if (typeof navigator.requestMIDIAccess !== 'function') {
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

    _handleMidiMessage(msg) {
      const data = msg.data;
      if (!data || data.length < 2) return;
      const status = data[0] & 0xf0;
      const noteOrCc = data[1];
      const val = data[2] ?? 127;

      const isTrigger = (status === 0x90 && val > 0) || (status === 0xb0 && val >= 64);
      if (!isTrigger) return;

      const sig = `${status}:${noteOrCc}`;
      if (this.learningAction) {
        const act = this.learningAction;
        this.midiMap[act] = sig;
        this.learningAction = null;
        this.onMidiLearned && this.onMidiLearned(act, sig, { ...this.midiMap });
        return;
      }

      if (this.midiMap.go === sig) {
        this.handlers.onGo && this.handlers.onGo();
      } else if (this.midiMap.blackout === sig) {
        this.handlers.onToggleBlackout && this.handlers.onToggleBlackout();
      } else if (this.midiMap.stopAll === sig) {
        this.handlers.onStopAll && this.handlers.onStopAll();
      }
    }
  }

  root.EventRunnerInputMapper = InputMapper;
})(window);
