/**
 * Giao diện & điều khiển Resolume 3-Layer VJ Deck (3 Deck A/B/C × 3 Layer × 4 Clip Slots)
 * Hỗ trợ kéo thả file trực tiếp lên ô Clip, kích hoạt theo cột (Column Fire),
 * Blend Mode, Opacity, Speed, Audio-React, Bypass (B), Solo (S), Eject (⏏)
 * và Hộp thoại Cấu hình Clip (File Media / Generator / Camera) thuần DOM/Modal.
 */
'use strict';

(function (root) {
  const $ = (id) => document.getElementById(id);

  const GENERATOR_LABELS = {
    'spectrum-bars': 'Spectrum Bars',
    'laser-beams': 'Laser Beams',
    'strobe-matrix': 'Strobe Matrix',
    'pulse-rings': 'Pulse Rings',
    'cyber-grid': 'Cyber Grid',
    'plasma-wave': 'Plasma Wave'
  };

  const BLEND_LABELS = {
    'normal': 'Normal',
    'screen': 'Screen',
    'plus-lighter': 'Plus Lighter',
    'multiply': 'Multiply',
    'overlay': 'Overlay',
    'lighten': 'Lighten',
    'difference': 'Difference',
    'color-dodge': 'Color Dodge',
    'hard-light': 'Hard Light'
  };

  class VjDeckController {
    constructor(deps) {
      this.deps = deps; // { logic, audioEngine, getProject, getProjectFilePath, isShowMode, isRehearsalMode, pushUndo, scheduleAutosave, showBanner, extractDroppedPaths, isExternalFileDrag }
      this.editingTarget = null; // { deckIdx, layerIdx, colIdx }
      this.cameraList = [];
      this._bound = false;
    }

    getDeckState() {
      const proj = this.deps.getProject();
      if (!proj.vjDeck) {
        proj.vjDeck = this.deps.logic.createDefaultVjDeck();
      }
      return proj.vjDeck;
    }

    _layerParams(layer) {
      return {
        opacity: layer.opacity,
        blend: layer.blend,
        speed: layer.speed,
        bypass: Boolean(layer.bypass),
        solo: Boolean(layer.solo),
        audioReact: Boolean(layer.audioReact)
      };
    }

    _sendLayerCommand(layerIndex, action, clip) {
      if (this.deps.isRehearsalMode()) return;
      const deckState = this.getDeckState();
      const layer = deckState.layers[layerIndex];
      if (!layer) return;

      let url = null;
      if (clip && clip.path && (clip.kind === 'image' || clip.kind === 'video')) {
        url = window.api.toFileUrl(clip.path, this.deps.getProjectFilePath());
      }

      window.api.sendToLed({
        type: 'vj-layer',
        layerIndex,
        action,
        clip: clip ? JSON.parse(JSON.stringify(clip)) : null,
        url,
        params: this._layerParams(layer)
      });
    }

    _syncLayerParams(layerIndex) {
      this._sendLayerCommand(layerIndex, 'params', null);
    }

    triggerClip(layerIndex, colIndex) {
      const deckState = this.getDeckState();
      const activeIdx = this.deps.logic.clamp(deckState.activeDeckIndex ?? 0, 0, 2);
      const deck = deckState.decks[activeIdx];
      const layer = deckState.layers[layerIndex];
      if (!deck || !layer || !deck[layerIndex]) return;

      const clip = deck[layerIndex][colIndex];
      if (!clip) return;

      if (clip.kind === 'empty') {
        if (!this.deps.isShowMode()) {
          this.openClipModal(activeIdx, layerIndex, colIndex);
        } else {
          this.deps.showBanner('Ô Clip đang trống. Chuyển sang BIÊN TẬP để gán nội dung cho ô này.');
        }
        return;
      }

      layer.activeClipId = clip.id;
      this.deps.scheduleAutosave();
      this._sendLayerCommand(layerIndex, 'trigger', clip);
      this.render();
    }

    ejectLayer(layerIndex) {
      const deckState = this.getDeckState();
      const layer = deckState.layers[layerIndex];
      if (!layer) return;
      layer.activeClipId = null;
      this.deps.scheduleAutosave();
      this._sendLayerCommand(layerIndex, 'eject', null);
      this.render();
    }

    triggerColumn(colIndex) {
      const deckState = this.getDeckState();
      const activeIdx = this.deps.logic.clamp(deckState.activeDeckIndex ?? 0, 0, 2);
      const deck = deckState.decks[activeIdx];
      if (!deck) return;

      for (let l = 0; l < 3; l++) {
        const layer = deckState.layers[l];
        const clip = deck[l] && deck[l][colIndex];
        if (!layer || !clip) continue;

        if (clip.kind !== 'empty') {
          layer.activeClipId = clip.id;
          this._sendLayerCommand(l, 'trigger', clip);
        } else if (layer.activeClipId) {
          layer.activeClipId = null;
          this._sendLayerCommand(l, 'eject', null);
        }
      }
      this.deps.scheduleAutosave();
      this.render();
    }

    clearAllLayers() {
      const deckState = this.getDeckState();
      for (let l = 0; l < 3; l++) {
        const layer = deckState.layers[l];
        if (!layer) continue;
        const hadClip = Boolean(layer.activeClipId);
        layer.activeClipId = null;
        if (l > 0 || hadClip) {
          this._sendLayerCommand(l, 'eject', null);
        }
      }
      this.deps.scheduleAutosave();
      this.render();
    }

    reapplyActiveLayers() {
      const deckState = this.getDeckState();
      const activeIdx = this.deps.logic.clamp(deckState.activeDeckIndex ?? 0, 0, 2);
      const deck = deckState.decks[activeIdx];
      if (!deck) return;

      for (let l = 0; l < 3; l++) {
        const layer = deckState.layers[l];
        if (!layer) continue;
        if (layer.activeClipId) {
          let matchedClip = null;
          for (let d = 0; d < deckState.decks.length && !matchedClip; d++) {
            const row = deckState.decks[d][l] || [];
            matchedClip = row.find((c) => c && c.id === layer.activeClipId) || null;
          }
          if (matchedClip && matchedClip.kind !== 'empty') {
            this._sendLayerCommand(l, 'trigger', matchedClip);
          } else {
            this._syncLayerParams(l);
          }
        } else {
          this._syncLayerParams(l);
        }
      }
    }

    async refreshCameraOptions(selectedId) {
      if (this.deps.audioEngine && typeof this.deps.audioEngine.listVideoInputDevices === 'function') {
        this.cameraList = await this.deps.audioEngine.listVideoInputDevices();
      } else {
        this.cameraList = [];
      }
      const sel = $('vj-clip-camera');
      if (!sel) return;
      sel.innerHTML = '';
      const defOpt = document.createElement('option');
      defOpt.value = '';
      defOpt.textContent = 'Camera mặc định hệ thống';
      sel.appendChild(defOpt);
      this.cameraList.forEach((cam, idx) => {
        const opt = document.createElement('option');
        opt.value = cam.deviceId || '';
        opt.textContent = cam.label || `Camera ${idx + 1}`;
        sel.appendChild(opt);
      });
      if (selectedId) sel.value = selectedId;
    }

    async openClipModal(deckIdx, layerIdx, colIdx) {
      if (this.deps.isShowMode()) {
        this.deps.showBanner('Đang khóa kịch bản ở CHẾ ĐỘ SHOW — chuyển sang BIÊN TẬP để chỉnh ô Clip.');
        return;
      }
      const deckState = this.getDeckState();
      const clip = deckState.decks[deckIdx] && deckState.decks[deckIdx][layerIdx] && deckState.decks[deckIdx][layerIdx][colIdx];
      if (!clip) return;

      this.editingTarget = { deckIdx, layerIdx, colIdx };
      const deckChar = ['A', 'B', 'C'][deckIdx] || 'A';
      $('vj-clip-modal-title').textContent = `Cấu hình Deck ${deckChar} · Layer ${layerIdx + 1} · Ô ${colIdx + 1}`;
      $('vj-clip-name').value = clip.name || '';
      $('vj-clip-kind').value = clip.kind || 'empty';
      $('vj-clip-path').value = clip.path || '';
      $('vj-clip-generator').value = clip.generator || 'laser-beams';
      $('vj-clip-color').value = clip.color || '#00d2ff';
      const speedVal = this.deps.logic.clamp(clip.speed ?? 1, 0.25, 3);
      $('vj-clip-speed').value = String(speedVal);
      $('vj-clip-speed-v').textContent = speedVal.toFixed(2).replace(/\.00$/, '.0');
      $('vj-clip-loop').checked = clip.loop !== false;
      if ($('vj-clip-vsound')) $('vj-clip-vsound').checked = clip.vsound !== false;

      await this.refreshCameraOptions(clip.cameraId || '');
      this._updateClipModalRows();
      $('vj-clip-modal').classList.remove('hidden');
    }

    _updateClipModalRows() {
      const kind = $('vj-clip-kind').value;
      $('vj-clip-media-row').classList.toggle('hidden', kind !== 'image' && kind !== 'video');
      $('vj-clip-gen-row').classList.toggle('hidden', kind !== 'generator');
      $('vj-clip-cam-row').classList.toggle('hidden', kind !== 'camera');
      if ($('vj-clip-vsound-row')) $('vj-clip-vsound-row').classList.toggle('hidden', kind !== 'video');
    }

    closeClipModal() {
      this.editingTarget = null;
      $('vj-clip-modal').classList.add('hidden');
    }

    bindStaticEvents() {
      if (this._bound) return;
      this._bound = true;

      for (let d = 0; d < 3; d++) {
        const btn = $('vj-deck-btn-' + d);
        if (btn) {
          btn.addEventListener('click', () => {
            const deckState = this.getDeckState();
            deckState.activeDeckIndex = d;
            this.deps.scheduleAutosave();
            this.render();
          });
        }
      }

      if ($('btn-vj-clear-all')) {
        $('btn-vj-clear-all').addEventListener('click', () => this.clearAllLayers());
      }

      for (let c = 0; c < 4; c++) {
        const cBtn = $('vj-col-btn-' + c);
        if (cBtn) {
          cBtn.addEventListener('click', () => this.triggerColumn(c));
        }
      }

      // Modal events
      $('btn-close-vj-clip').addEventListener('click', () => this.closeClipModal());
      $('vj-clip-modal').addEventListener('click', (e) => {
        if (e.target === $('vj-clip-modal')) this.closeClipModal();
      });

      $('vj-clip-kind').addEventListener('change', () => this._updateClipModalRows());
      $('vj-clip-speed').addEventListener('input', (e) => {
        $('vj-clip-speed-v').textContent = Number(e.target.value).toFixed(2);
      });

      $('btn-vj-clip-pick').addEventListener('click', async () => {
        const files = await window.api.pickVisual();
        if (!files || files.length === 0) return;
        const filePath = files[0];
        const kind = this.deps.logic.detectMediaKind(filePath);
        if (kind !== 'image' && kind !== 'video') {
          this.deps.showBanner('Ô Clip VJ chỉ hỗ trợ Ảnh hoặc Video.');
          return;
        }
        $('vj-clip-kind').value = kind;
        $('vj-clip-path').value = filePath;
        if (kind === 'video' && $('vj-clip-vsound')) {
          $('vj-clip-vsound').checked = true;
        }
        if (!$('vj-clip-name').value.trim() || /^Ô\s+\d+/i.test($('vj-clip-name').value.trim())) {
          $('vj-clip-name').value = window.api.fileStem(filePath);
        }
        this._updateClipModalRows();
      });

      $('btn-vj-clip-clear-file').addEventListener('click', () => {
        $('vj-clip-path').value = '';
      });

      $('btn-vj-refresh-cam').addEventListener('click', async () => {
        await this.refreshCameraOptions($('vj-clip-camera').value);
      });

      $('btn-vj-clip-clear-slot').addEventListener('click', () => {
        if (!this.editingTarget) return;
        const { deckIdx, layerIdx, colIdx } = this.editingTarget;
        const deckState = this.getDeckState();
        const clip = deckState.decks[deckIdx][layerIdx][colIdx];
        if (!clip) return;
        this.deps.pushUndo();
        const wasActive = deckState.layers[layerIdx].activeClipId === clip.id;
        clip.kind = 'empty';
        clip.path = null;
        clip.name = `Ô ${colIdx + 1}`;
        clip.cameraId = '';
        if (wasActive) {
          deckState.layers[layerIdx].activeClipId = null;
          this._sendLayerCommand(layerIdx, 'eject', null);
        }
        this.deps.scheduleAutosave();
        this.closeClipModal();
        this.render();
      });

      $('btn-vj-clip-save').addEventListener('click', () => {
        if (!this.editingTarget) return;
        const { deckIdx, layerIdx, colIdx } = this.editingTarget;
        const deckState = this.getDeckState();
        const clip = deckState.decks[deckIdx][layerIdx][colIdx];
        if (!clip) return;

        const kind = $('vj-clip-kind').value;
        const filePath = $('vj-clip-path').value.trim() || null;
        if ((kind === 'image' || kind === 'video') && !filePath) {
          this.deps.showBanner('Hãy chọn file Ảnh hoặc Video cho ô Clip này.');
          return;
        }

        this.deps.pushUndo();
        clip.kind = kind;
        clip.path = (kind === 'image' || kind === 'video') ? filePath : null;
        clip.generator = $('vj-clip-generator').value || 'laser-beams';
        clip.cameraId = $('vj-clip-camera').value || '';
        clip.color = $('vj-clip-color').value || '#00d2ff';
        clip.speed = this.deps.logic.clamp($('vj-clip-speed').value, 0.25, 3);
        clip.loop = $('vj-clip-loop').checked;
        clip.vsound = kind === 'video'
          ? ($('vj-clip-vsound') ? $('vj-clip-vsound').checked : true)
          : false;

        let name = $('vj-clip-name').value.trim();
        if (!name) {
          if (kind === 'generator') name = GENERATOR_LABELS[clip.generator] || clip.generator;
          else if (kind === 'camera') name = 'Camera Live';
          else if (clip.path) name = window.api.fileStem(clip.path);
          else name = `Ô ${colIdx + 1}`;
        }
        clip.name = name;

        if (deckState.layers[layerIdx].activeClipId === clip.id) {
          if (clip.kind === 'empty') {
            deckState.layers[layerIdx].activeClipId = null;
            this._sendLayerCommand(layerIdx, 'eject', null);
          } else {
            this._sendLayerCommand(layerIdx, 'trigger', clip);
          }
        }

        this.deps.scheduleAutosave();
        this.closeClipModal();
        this.render();
      });
    }

    render() {
      const deckState = this.getDeckState();
      const activeIdx = this.deps.logic.clamp(deckState.activeDeckIndex ?? 0, 0, 2);
      const isLocked = this.deps.isShowMode();

      for (let d = 0; d < 3; d++) {
        const btn = $('vj-deck-btn-' + d);
        if (btn) btn.classList.toggle('active', d === activeIdx);
      }

      const host = $('vj-layers-host');
      if (!host) return;
      host.innerHTML = '';

      const deck = deckState.decks[activeIdx] || [];
      const blendModes = this.deps.logic.BLEND_MODES || Object.keys(BLEND_LABELS);

      deckState.layers.forEach((layer, layerIdx) => {
        const card = document.createElement('div');
        card.className = 'vj-layer-card' +
          (layer.bypass ? ' is-bypassed' : '') +
          (layer.solo ? ' is-solo' : '');

        // Header: Layer name + Audio-React + Bypass + Solo + Eject
        const head = document.createElement('div');
        head.className = 'vj-layer-head';

        const title = document.createElement('span');
        title.className = 'vj-layer-title';
        title.textContent = layer.name || `Layer ${layerIdx + 1}`;

        const flags = document.createElement('div');
        flags.className = 'vj-layer-flags';

        const reactBtn = document.createElement('button');
        reactBtn.className = 'vj-flag-btn is-on-react' + (layer.audioReact ? ' active' : '');
        reactBtn.textContent = '♪';
        reactBtn.title = 'Audio-React (Nhún độ sáng & kích thước theo nhạc)';
        reactBtn.addEventListener('click', () => {
          layer.audioReact = !layer.audioReact;
          this.deps.scheduleAutosave();
          this._syncLayerParams(layerIdx);
          this.render();
        });

        const bypassBtn = document.createElement('button');
        bypassBtn.className = 'vj-flag-btn is-bypass' + (layer.bypass ? ' active' : '');
        bypassBtn.textContent = 'B';
        bypassBtn.title = 'Bypass — Tạm ẩn Layer này';
        bypassBtn.addEventListener('click', () => {
          layer.bypass = !layer.bypass;
          this.deps.scheduleAutosave();
          this._syncLayerParams(layerIdx);
          this.render();
        });

        const soloBtn = document.createElement('button');
        soloBtn.className = 'vj-flag-btn is-solo' + (layer.solo ? ' active' : '');
        soloBtn.textContent = 'S';
        soloBtn.title = 'Solo — Chỉ hiện riêng Layer này';
        soloBtn.addEventListener('click', () => {
          layer.solo = !layer.solo;
          this.deps.scheduleAutosave();
          this._syncLayerParams(layerIdx);
          this.render();
        });

        const ejectBtn = document.createElement('button');
        ejectBtn.className = 'vj-flag-btn';
        ejectBtn.textContent = '⏏';
        ejectBtn.title = 'Eject — Dừng & đẩy clip khỏi Layer';
        ejectBtn.addEventListener('click', () => this.ejectLayer(layerIdx));

        flags.appendChild(reactBtn);
        flags.appendChild(bypassBtn);
        flags.appendChild(soloBtn);
        flags.appendChild(ejectBtn);
        head.appendChild(title);
        head.appendChild(flags);

        // Controls row: Opacity, Blend, Speed
        const ctrls = document.createElement('div');
        ctrls.className = 'vj-layer-controls';

        const opWrap = document.createElement('label');
        opWrap.className = 'vj-mini-slider';
        const opLbl = document.createElement('span');
        opLbl.textContent = `Độ mờ: ${layer.opacity ?? 100}%`;
        const opRange = document.createElement('input');
        opRange.type = 'range';
        opRange.min = '0';
        opRange.max = '100';
        opRange.value = String(layer.opacity ?? 100);
        opRange.addEventListener('input', () => {
          layer.opacity = Number(opRange.value);
          opLbl.textContent = `Độ mờ: ${layer.opacity}%`;
          this.deps.scheduleAutosave();
          this._syncLayerParams(layerIdx);
        });
        opWrap.appendChild(opLbl);
        opWrap.appendChild(opRange);

        const blendSel = document.createElement('select');
        blendSel.title = 'Chế độ hòa trộn (Blend Mode)';
        blendModes.forEach((bm) => {
          const opt = document.createElement('option');
          opt.value = bm;
          opt.textContent = BLEND_LABELS[bm] || bm;
          blendSel.appendChild(opt);
        });
        blendSel.value = layer.blend || 'normal';
        blendSel.addEventListener('change', () => {
          layer.blend = blendSel.value;
          this.deps.scheduleAutosave();
          this._syncLayerParams(layerIdx);
        });

        const spWrap = document.createElement('label');
        spWrap.className = 'vj-mini-slider';
        const spLbl = document.createElement('span');
        spLbl.textContent = `Tốc độ: ${(layer.speed ?? 1).toFixed(1)}x`;
        const spRange = document.createElement('input');
        spRange.type = 'range';
        spRange.min = '0.25';
        spRange.max = '2.5';
        spRange.step = '0.05';
        spRange.value = String(layer.speed ?? 1);
        spRange.addEventListener('input', () => {
          layer.speed = Number(spRange.value);
          spLbl.textContent = `Tốc độ: ${layer.speed.toFixed(1)}x`;
          this.deps.scheduleAutosave();
          this._syncLayerParams(layerIdx);
        });
        spWrap.appendChild(spLbl);
        spWrap.appendChild(spRange);

        ctrls.appendChild(opWrap);
        ctrls.appendChild(blendSel);
        ctrls.appendChild(spWrap);

        // 4 Clip Slots
        const grid = document.createElement('div');
        grid.className = 'vj-clips-grid';
        const rowClips = deck[layerIdx] || [];

        for (let colIdx = 0; colIdx < 4; colIdx++) {
          const clip = rowClips[colIdx] || { id: '', name: `Ô ${colIdx + 1}`, kind: 'empty' };
          const isActive = Boolean(layer.activeClipId && clip.id === layer.activeClipId && clip.kind !== 'empty');

          const slotEl = document.createElement('div');
          slotEl.className = 'vj-clip-slot' +
            (clip.kind === 'empty' ? ' is-empty' : '') +
            (isActive ? ' is-active' : '');
          slotEl.tabIndex = 0;
          slotEl.title = clip.kind === 'empty'
            ? 'Bấm hoặc kéo thả Ảnh/Video vào đây để cài đặt ô Clip'
            : `${clip.name} (${clip.kind}) — Bấm để phát · Chuột phải để sửa`;

          if (clip.color && clip.kind !== 'empty') {
            slotEl.style.borderTop = `2px solid ${clip.color}`;
          }

          const top = document.createElement('div');
          top.className = 'vj-clip-top';
          const badge = document.createElement('span');
          badge.className = 'vj-clip-kind';
          badge.textContent = clip.kind === 'empty'
            ? `#${colIdx + 1}`
            : (clip.kind === 'generator' ? 'GEN' : clip.kind === 'camera' ? 'CAM' : clip.kind === 'video' ? 'VID' : 'IMG');

          const editBtn = document.createElement('button');
          editBtn.type = 'button';
          editBtn.className = 'vj-clip-edit';
          editBtn.textContent = '⚙';
          editBtn.title = 'Cấu hình ô Clip';
          editBtn.disabled = isLocked;
          editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openClipModal(activeIdx, layerIdx, colIdx);
          });

          top.appendChild(badge);
          top.appendChild(editBtn);

          const nameSpan = document.createElement('div');
          nameSpan.className = 'vj-clip-name';
          nameSpan.textContent = clip.kind === 'empty' ? 'Trống' : (clip.name || `Ô ${colIdx + 1}`);

          slotEl.appendChild(top);
          slotEl.appendChild(nameSpan);

          slotEl.addEventListener('click', () => this.triggerClip(layerIdx, colIdx));
          slotEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.openClipModal(activeIdx, layerIdx, colIdx);
          });

          // Kéo thả file trực tiếp lên ô Clip VJ
          slotEl.addEventListener('dragover', (e) => {
            if (isLocked || !this.deps.isExternalFileDrag(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            slotEl.classList.add('is-dragover');
          });
          slotEl.addEventListener('dragleave', () => slotEl.classList.remove('is-dragover'));
          slotEl.addEventListener('drop', (e) => {
            slotEl.classList.remove('is-dragover');
            if (isLocked || !this.deps.isExternalFileDrag(e)) return;
            e.preventDefault();
            e.stopPropagation();
            const paths = this.deps.extractDroppedPaths(e);
            if (!paths || paths.length === 0) return;
            const kind = this.deps.logic.detectMediaKind(paths[0]);
            if (kind !== 'image' && kind !== 'video') {
              this.deps.showBanner('Ô Clip VJ chỉ nhận file Ảnh hoặc Video.');
              return;
            }
            this.deps.pushUndo();
            clip.kind = kind;
            clip.path = paths[0];
            clip.name = window.api.fileStem(paths[0]);
            clip.vsound = kind === 'video';
            this.deps.scheduleAutosave();
            if (layer.activeClipId === clip.id) {
              this._sendLayerCommand(layerIdx, 'trigger', clip);
            }
            this.render();
            this.deps.showBanner(`Đã gắn "${window.api.baseName(paths[0])}" vào Deck ${['A', 'B', 'C'][activeIdx]} Layer ${layerIdx + 1} Ô ${colIdx + 1}.`);
          });

          grid.appendChild(slotEl);
        }

        card.appendChild(head);
        card.appendChild(ctrls);
        card.appendChild(grid);
        host.appendChild(card);
      });
    }
  }

  root.EventRunnerVjDeckUi = VjDeckController;
})(window);
