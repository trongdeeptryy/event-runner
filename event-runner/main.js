/**
 * Tiến trình chính (Main Process) của EVENT RUNNER
 * Quản lý:
 * - Cửa sổ điều khiển (control.html) và cửa sổ màn LED (output.html)
 * - Tự động nhận màn hình phụ HDMI, cắm/rút nóng, tự hồi phục khi crash
 * - Chống ngủ màn hình, xác nhận khi thoát, ghi nhật ký lỗi và nhật ký show
 * - Lưu/mở dự án JSON, autosave, gói dự án (Collect files)
 * - Máy chủ điều khiển từ xa LAN (HTTP + WebSocket, mặc định TẮT, bảo vệ PIN 4 số)
 */
'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  screen,
  powerSaveBlocker,
  shell,
  session
} = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { WebSocketServer } = require('ws');

const logic = require('./src/shared/logic');
const { resolveMediaPath, toSafeFileUrl } = require('./src/shared/path-utils');

// Cho phép phát nhạc/video tự động không cần cử chỉ người dùng trên từng lần tạo Audio/Video
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const IS_SMOKE = process.env.EVENT_RUNNER_SMOKE === '1';

let controlWindow = null;
let ledWindow = null;
let stageWindow = null;
let powerBlockerId = null;
let isQuitting = false;
let currentLedDisplayId = null;
let currentLedMode = 'closed'; // 'closed' | 'fullscreen' | 'preview-window'
let currentStageDisplayId = null;
let currentStageMode = 'closed'; // 'closed' | 'fullscreen' | 'preview-window'
let lastStagePayload = null;
let lastPublicStageSig = '';
let hotplugTimer = null;
let recoverTimer = null;
let stageRecoverTimer = null;
let lastProjectFilePath = null;
let isShowRunning = false;

// Động cơ DMX Art-Net/sACN & OSC UDP (khởi tạo an toàn)
let dmxEngine = null;
let oscServer = null;

function getDmxEngine() {
  if (dmxEngine) return dmxEngine;
  try {
    const { DmxEngine } = require('./src/main/dmx-engine');
    dmxEngine = new DmxEngine();
  } catch (err) {
    logError('init:dmx-engine', err);
  }
  return dmxEngine;
}

function getOscServer() {
  if (oscServer) return oscServer;
  try {
    const { OscServer } = require('./src/main/osc-server');
    oscServer = new OscServer();
  } catch (err) {
    logError('init:osc-server', err);
  }
  return oscServer;
}

// Biến cho Remote LAN Server
let remoteHttpServer = null;
let remoteWss = null;
let remoteState = {
  enabled: false,
  port: 8765,
  pin: '1234',
  urls: [],
  liveName: 'Chưa phát',
  nextName: 'Trống',
  blackout: false,
  bpm: 120,
  ledMode: 'off',
  overlays: { ov1: false, ov2: false, ov3: false, ov4: false },
  sfxNames: [],
  stageNote: '',
  timerText: '--:--',
  stageMessage: '',
  timerUrgent: false,
  clients: 0
};

/** Đường dẫn thư mục userData */
function getUserDataPaths() {
  const userDir = app.getPath('userData');
  const logsDir = path.join(userDir, 'logs');
  return {
    userDir,
    logsDir,
    settingsFile: path.join(userDir, 'settings.json'),
    autosaveFile: path.join(userDir, 'autosave.json'),
    errorLogFile: path.join(logsDir, 'error.log'),
    showLogFile: path.join(logsDir, 'show.log')
  };
}

/** Đảm bảo thư mục logs tồn tại */
function ensureLogsDir() {
  try {
    const { logsDir } = getUserDataPaths();
    fs.mkdirSync(logsDir, { recursive: true });
    return logsDir;
  } catch (_) {
    return null;
  }
}

/** Ghi một dòng log vào file log */
function writeLogLine(filePath, message) {
  try {
    ensureLogsDir();
    const stamp = new Date().toISOString();
    fs.appendFileSync(filePath, `[${stamp}] ${message}\n`, 'utf8');
  } catch (_) {
    // Bỏ qua lỗi ghi log để không gây lỗi dây chuyền
  }
}

function logError(context, err) {
  const detail = err && err.stack ? err.stack : String(err);
  const { errorLogFile } = getUserDataPaths();
  writeLogLine(errorLogFile, `[${context}] ${detail}`);
}

process.on('uncaughtException', (err) => {
  logError('main:uncaughtException', err);
});

process.on('unhandledRejection', (reason) => {
  logError('main:unhandledRejection', reason);
});

/** Đọc settings.json */
function loadSettings() {
  const defaults = {
    autoOpenLed: true,
    lastDisplayId: null,
    lastDisplaySize: null,
    audioDeviceId: '',
    extDeviceId: '',
    extGain: 100,
    masterVol: 100,
    remotePin: '1234',
    midiMap: { go: null, blackout: null, stopAll: null }
  };
  try {
    const { settingsFile } = getUserDataPaths();
    if (!fs.existsSync(settingsFile)) return defaults;
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    return { ...defaults, ...raw };
  } catch (err) {
    logError('loadSettings', err);
    return defaults;
  }
}

/** Ghi settings.json */
function saveSettings(partial) {
  const current = loadSettings();
  const next = { ...current, ...(partial || {}) };
  try {
    const { userDir, settingsFile } = getUserDataPaths();
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    logError('saveSettings', err);
  }
  return next;
}

/** Định dạng danh sách màn hình cho UI */
function getFormattedDisplays() {
  const primary = screen.getPrimaryDisplay();
  const all = screen.getAllDisplays();
  return all.map((d, idx) => ({
    id: d.id,
    isPrimary: d.id === primary.id,
    label: d.label && d.label.trim()
      ? d.label.trim()
      : (d.id === primary.id ? `Màn chính (${idx + 1})` : `Màn phụ ${idx + 1}`),
    bounds: d.bounds,
    scaleFactor: d.scaleFactor || 1
  }));
}

/** Lấy trạng thái LED hiện tại */
function getLedStatusPayload() {
  const isOpen = Boolean(ledWindow && !ledWindow.isDestroyed());
  const displays = getFormattedDisplays();
  const activeDisplay = displays.find((d) => String(d.id) === String(currentLedDisplayId)) || null;
  return {
    isOpen,
    mode: isOpen ? currentLedMode : 'closed',
    displayId: isOpen ? currentLedDisplayId : null,
    displayLabel: activeDisplay ? activeDisplay.label : (currentLedMode === 'preview-window' ? 'Cửa sổ thử' : ''),
    width: activeDisplay ? activeDisplay.bounds.width : (isOpen ? 960 : 0),
    height: activeDisplay ? activeDisplay.bounds.height : (isOpen ? 540 : 0),
    hasExternalDisplay: displays.some((d) => !d.isPrimary)
  };
}

/** Gửi trạng thái LED & màn hình về cửa sổ điều khiển */
function notifyDisplayAndLedState(extraAlert) {
  if (!controlWindow || controlWindow.isDestroyed()) return;
  controlWindow.webContents.send('led-status-changed', {
    led: getLedStatusPayload(),
    displays: getFormattedDisplays(),
    alert: extraAlert || null
  });
}

/**
 * Mở cửa sổ LED trên màn hình chỉ định hoặc tự chọn màn hình tối ưu
 */
function openLedWindow(preferredDisplayId) {
  const settings = loadSettings();
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  let selection;
  if (preferredDisplayId !== undefined && preferredDisplayId !== null && preferredDisplayId !== 'auto') {
    const manual = displays.find((d) => String(d.id) === String(preferredDisplayId));
    if (manual) {
      selection = {
        mode: manual.id === primary.id && displays.length === 1 ? 'preview-window' : 'fullscreen',
        display: manual
      };
    }
  }

  if (!selection) {
    selection = logic.pickBestDisplay(displays, primary.id, settings);
  }

  if (!selection || !selection.display) {
    return getLedStatusPayload();
  }

  const targetDisplay = selection.display;
  const isFullscreen = selection.mode === 'fullscreen';

  // Nếu cửa sổ LED đã mở ở đúng màn và chế độ đó thì chỉ cần báo trạng thái
  if (ledWindow && !ledWindow.isDestroyed()) {
    if (String(currentLedDisplayId) === String(targetDisplay.id) && currentLedMode === selection.mode) {
      ledWindow.showInactive();
      return getLedStatusPayload();
    }
    try {
      ledWindow.destroy();
    } catch (_) {}
    ledWindow = null;
  }

  currentLedDisplayId = targetDisplay.id;
  currentLedMode = selection.mode;

  if (isFullscreen) {
    saveSettings({
      lastDisplayId: targetDisplay.id,
      lastDisplaySize: {
        width: targetDisplay.bounds.width,
        height: targetDisplay.bounds.height
      }
    });
  }

  const winOptions = isFullscreen
    ? {
        x: targetDisplay.bounds.x,
        y: targetDisplay.bounds.y,
        width: targetDisplay.bounds.width,
        height: targetDisplay.bounds.height,
        frame: false,
        fullscreen: true,
        alwaysOnTop: true,
        focusable: false,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        backgroundColor: '#000000',
        show: false,
        title: 'EVENT RUNNER — Màn hình LED',
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          backgroundThrottling: false,
          webSecurity: false
        }
      }
    : {
        x: targetDisplay.bounds.x + 40,
        y: targetDisplay.bounds.y + 40,
        width: 960,
        height: 540,
        frame: true,
        fullscreen: false,
        alwaysOnTop: false,
        focusable: true,
        skipTaskbar: false,
        resizable: true,
        backgroundColor: '#000000',
        show: false,
        title: 'EVENT RUNNER — Cửa sổ thử LED (Chưa thấy màn LED phụ)',
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          backgroundThrottling: false,
          webSecurity: false
        }
      };

  ledWindow = new BrowserWindow(winOptions);

  if (isFullscreen) {
    ledWindow.setAlwaysOnTop(true, 'screen-saver');
    ledWindow.setBounds({
      x: targetDisplay.bounds.x,
      y: targetDisplay.bounds.y,
      width: targetDisplay.bounds.width,
      height: targetDisplay.bounds.height
    });
  }

  ledWindow.setMenuBarVisibility(false);
  ledWindow.loadFile(path.join(__dirname, 'output.html'));

  ledWindow.once('ready-to-show', () => {
    if (!ledWindow || ledWindow.isDestroyed()) return;
    if (isFullscreen) {
      ledWindow.showInactive();
      ledWindow.setAlwaysOnTop(true, 'screen-saver');
    } else if (!IS_SMOKE) {
      ledWindow.showInactive();
    }
    notifyDisplayAndLedState(
      isFullscreen
        ? null
        : 'Đang chạy ở chế độ cửa sổ thử (960×540) vì chưa thấy màn LED phụ.'
    );
  });

  ledWindow.on('closed', () => {
    ledWindow = null;
    currentLedMode = 'closed';
    currentLedDisplayId = null;
    notifyDisplayAndLedState();
  });

  // Tự hồi phục sau 0.5s nếu renderer của cửa sổ LED gặp sự cố crash (Mục 6.7)
  ledWindow.webContents.on('render-process-gone', (_event, details) => {
    logError('led:render-process-gone', JSON.stringify(details));
    if (isQuitting) return;
    const prevDisplay = currentLedDisplayId;
    try {
      if (ledWindow && !ledWindow.isDestroyed()) ledWindow.destroy();
    } catch (_) {}
    ledWindow = null;
    currentLedMode = 'closed';
    notifyDisplayAndLedState('Cửa sổ LED vừa khởi động lại để tự hồi phục...');
    clearTimeout(recoverTimer);
    recoverTimer = setTimeout(() => {
      if (!isQuitting) {
        openLedWindow(prevDisplay || 'auto');
      }
    }, 500);
  });

  return getLedStatusPayload();
}

/** Tạo webPreferences chuẩn cho các cửa sổ Electron của app */
function createAppWebPreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    backgroundThrottling: false,
    webSecurity: false
  };
}

/** Đóng cửa sổ LED */
function closeLedWindow() {
  clearTimeout(recoverTimer);
  if (ledWindow && !ledWindow.isDestroyed()) {
    ledWindow.destroy();
  }
  ledWindow = null;
  currentLedMode = 'closed';
  currentLedDisplayId = null;
  notifyDisplayAndLedState();
  return getLedStatusPayload();
}

/** Lấy trạng thái cửa sổ Stage Display hiện tại */
function getStageStatusPayload() {
  const isOpen = Boolean(stageWindow && !stageWindow.isDestroyed());
  const displays = getFormattedDisplays();
  const activeDisplay = displays.find((d) => String(d.id) === String(currentStageDisplayId)) || null;
  return {
    isOpen,
    mode: isOpen ? currentStageMode : 'closed',
    displayId: isOpen ? currentStageDisplayId : null,
    displayLabel: activeDisplay
      ? activeDisplay.label
      : (currentStageMode === 'preview-window' ? 'Cửa sổ xem trước' : ''),
    width: activeDisplay ? activeDisplay.bounds.width : (isOpen ? 960 : 0),
    height: activeDisplay ? activeDisplay.bounds.height : (isOpen ? 540 : 0)
  };
}

/** Gửi trạng thái Stage Display về cửa sổ điều khiển */
function notifyStageStatusChanged() {
  if (!controlWindow || controlWindow.isDestroyed()) return;
  controlWindow.webContents.send('stage-status-changed', {
    stage: getStageStatusPayload(),
    displays: getFormattedDisplays()
  });
}

/**
 * Mở cửa sổ Stage Display (FreeShow-style) trên màn hình chỉ định hoặc cửa sổ 960x540
 */
function openStageWindow(displayId) {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();

  let selection = null;
  if (displayId === 'preview') {
    selection = { mode: 'preview-window', display: primary };
  } else if (displayId !== undefined && displayId !== null && displayId !== 'auto' && displayId !== '') {
    const manual = displays.find((d) => String(d.id) === String(displayId));
    if (manual) {
      selection = {
        mode: manual.id === primary.id && displays.length === 1 ? 'preview-window' : 'fullscreen',
        display: manual
      };
    }
  }

  if (!selection) {
    const freeExternal = displays.filter(
      (d) => d.id !== primary.id && String(d.id) !== String(currentLedDisplayId)
    );
    if (freeExternal.length > 0) {
      selection = { mode: 'fullscreen', display: freeExternal[0] };
    } else if (primary) {
      selection = { mode: 'preview-window', display: primary };
    }
  }

  if (!selection || !selection.display) {
    return getStageStatusPayload();
  }

  const targetDisplay = selection.display;
  const isFullscreen = selection.mode === 'fullscreen';

  if (stageWindow && !stageWindow.isDestroyed()) {
    if (String(currentStageDisplayId) === String(targetDisplay.id) && currentStageMode === selection.mode) {
      if (isFullscreen) {
        stageWindow.showInactive();
      } else {
        stageWindow.show();
      }
      return getStageStatusPayload();
    }
    try {
      stageWindow.destroy();
    } catch (_) {}
    stageWindow = null;
  }

  currentStageDisplayId = targetDisplay.id;
  currentStageMode = selection.mode;

  const winOptions = isFullscreen
    ? {
        x: targetDisplay.bounds.x,
        y: targetDisplay.bounds.y,
        width: targetDisplay.bounds.width,
        height: targetDisplay.bounds.height,
        frame: false,
        fullscreen: true,
        alwaysOnTop: true,
        focusable: false,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        backgroundColor: '#05080f',
        show: false,
        title: 'EVENT RUNNER — Stage Display',
        webPreferences: createAppWebPreferences()
      }
    : {
        x: targetDisplay.bounds.x + 80,
        y: targetDisplay.bounds.y + 80,
        width: 960,
        height: 540,
        frame: true,
        fullscreen: false,
        alwaysOnTop: false,
        focusable: true,
        skipTaskbar: false,
        resizable: true,
        backgroundColor: '#05080f',
        show: false,
        title: 'EVENT RUNNER — Stage Display (Cửa sổ xem trước)',
        webPreferences: createAppWebPreferences()
      };

  stageWindow = new BrowserWindow(winOptions);

  if (isFullscreen) {
    stageWindow.setAlwaysOnTop(true, 'screen-saver');
    stageWindow.setBounds({
      x: targetDisplay.bounds.x,
      y: targetDisplay.bounds.y,
      width: targetDisplay.bounds.width,
      height: targetDisplay.bounds.height
    });
  }

  stageWindow.setMenuBarVisibility(false);
  stageWindow.webContents.on('will-navigate', (ev) => {
    ev.preventDefault();
  });
  stageWindow.loadFile(path.join(__dirname, 'stage.html'));

  stageWindow.once('ready-to-show', () => {
    if (!stageWindow || stageWindow.isDestroyed()) return;
    if (isFullscreen) {
      stageWindow.showInactive();
      stageWindow.setAlwaysOnTop(true, 'screen-saver');
    } else if (!IS_SMOKE) {
      stageWindow.showInactive();
    }
    notifyStageStatusChanged();
  });

  stageWindow.on('closed', () => {
    stageWindow = null;
    currentStageMode = 'closed';
    currentStageDisplayId = null;
    notifyStageStatusChanged();
  });

  stageWindow.webContents.on('render-process-gone', (_event, details) => {
    logError('stage:render-process-gone', JSON.stringify(details));
    if (isQuitting) return;
    const prevDisplay = currentStageDisplayId;
    try {
      if (stageWindow && !stageWindow.isDestroyed()) stageWindow.destroy();
    } catch (_) {}
    stageWindow = null;
    currentStageMode = 'closed';
    notifyStageStatusChanged();
    clearTimeout(stageRecoverTimer);
    stageRecoverTimer = setTimeout(() => {
      if (!isQuitting) {
        openStageWindow(prevDisplay || 'auto');
      }
    }, 500);
  });

  return getStageStatusPayload();
}

/** Đóng cửa sổ Stage Display */
function closeStageWindow() {
  clearTimeout(stageRecoverTimer);
  if (stageWindow && !stageWindow.isDestroyed()) {
    stageWindow.destroy();
  }
  stageWindow = null;
  currentStageMode = 'closed';
  currentStageDisplayId = null;
  notifyStageStatusChanged();
  return getStageStatusPayload();
}

/** Dừng toàn bộ dịch vụ nền (Remote LAN, DMX, OSC, Stage & LED) khi thoát */
function stopAllSubsystems() {
  stopRemoteServer();
  if (dmxEngine) {
    try {
      dmxEngine.stop();
    } catch (err) {
      logError('stopAllSubsystems:dmx', err);
    }
  }
  if (oscServer) {
    try {
      oscServer.stop();
    } catch (err) {
      logError('stopAllSubsystems:osc', err);
    }
  }
  closeStageWindow();
  closeLedWindow();
}

/** Tạo cửa sổ bảng điều khiển chính */
function createControlWindow() {
  const primary = screen.getPrimaryDisplay();
  const area = primary.workArea;

  controlWindow = new BrowserWindow({
    x: area.x + Math.max(0, Math.floor((area.width - Math.min(1520, area.width - 20)) / 2)),
    y: area.y + Math.max(0, Math.floor((area.height - Math.min(860, area.height - 20)) / 2)),
    width: Math.min(1520, area.width - 20),
    height: Math.min(860, area.height - 20),
    minWidth: 1160,
    minHeight: 680,
    backgroundColor: '#0F1117',
    title: 'EVENT RUNNER v3.0 PRO — Bảng điều khiển sự kiện',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
    webPreferences: createAppWebPreferences()
  });

  controlWindow.setMenuBarVisibility(false);
  controlWindow.webContents.on('will-navigate', (ev) => {
    ev.preventDefault();
  });
  controlWindow.loadFile(path.join(__dirname, 'control.html'));

  controlWindow.once('ready-to-show', () => {
    if (!IS_SMOKE) {
      controlWindow.show();
    }
    // Tự mở màn LED khi khởi động (màn phụ nếu có, hoặc cửa sổ thử 960x540 nếu chỉ có 1 màn)
    openLedWindow('auto');
  });

  // Xác nhận trước khi đóng bảng điều khiển (Mục 4 & 8)
  controlWindow.on('close', (e) => {
    if (isQuitting || IS_SMOKE) return;
    e.preventDefault();
    const message = isShowRunning
      ? 'Đang chạy chương trình — thoát thật không?'
      : 'Bạn có chắc muốn thoát EVENT RUNNER? Chương trình đã được tự động lưu.';
    const choice = dialog.showMessageBoxSync(controlWindow, {
      type: 'question',
      buttons: ['Ở lại', 'Thoát phần mềm'],
      defaultId: 0,
      cancelId: 0,
      title: 'Xác nhận thoát',
      message: 'Đang chạy chương trình — thoát thật không?',
      detail: message
    });
    if (choice === 1) {
      isQuitting = true;
      stopAllSubsystems();
      controlWindow.destroy();
      app.quit();
    }
  });

  controlWindow.on('closed', () => {
    controlWindow = null;
    if (!isQuitting) {
      isQuitting = true;
      stopAllSubsystems();
      app.quit();
    }
  });
}

/** Đăng ký sự kiện cắm / rút nóng màn hình */
function registerDisplayEvents() {
  screen.on('display-added', () => {
    const settings = loadSettings();
    notifyDisplayAndLedState('Phát hiện màn hình mới được kết nối...');
    notifyStageStatusChanged();
    if (!settings.autoOpenLed) return;

    clearTimeout(hotplugTimer);
    hotplugTimer = setTimeout(() => {
      if (isQuitting) return;
      const displays = screen.getAllDisplays();
      const primary = screen.getPrimaryDisplay();
      const hasExternal = displays.some((d) => d.id !== primary.id);
      if (hasExternal && (!ledWindow || ledWindow.isDestroyed() || currentLedMode === 'preview-window')) {
        openLedWindow('auto');
      } else {
        notifyDisplayAndLedState();
        notifyStageStatusChanged();
      }
    }, 1500);
  });

  screen.on('display-removed', (_event, oldDisplay) => {
    if (stageWindow && !stageWindow.isDestroyed() && String(oldDisplay.id) === String(currentStageDisplayId)) {
      closeStageWindow();
    } else {
      notifyStageStatusChanged();
    }

    if (ledWindow && !ledWindow.isDestroyed() && String(oldDisplay.id) === String(currentLedDisplayId)) {
      closeLedWindow();
      notifyDisplayAndLedState('Cảnh báo: Màn hình LED vừa bị rút kết nối!');
    } else {
      notifyDisplayAndLedState('Một màn hình phụ vừa bị ngắt kết nối.');
    }
  });

  screen.on('display-metrics-changed', () => {
    notifyDisplayAndLedState();
    notifyStageStatusChanged();
  });
}

/** Lấy danh sách IP LAN IPv4 của máy */
function getLanUrls(port) {
  const ifs = os.networkInterfaces();
  const urls = [];
  for (const name of Object.keys(ifs)) {
    for (const net of ifs[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    }
  }
  if (urls.length === 0) {
    urls.push(`http://127.0.0.1:${port}`);
  }
  return urls;
}

const ALLOWED_REMOTE_COMMANDS = new Set([
  'GO',
  'BACK',
  'BLACK',
  'STOP',
  'FADE',
  'TAP_BPM',
  'OV1',
  'OV2',
  'OV3',
  'OV4',
  'FLASH_HIT',
  'STROBE_HOLD_ON',
  'STROBE_HOLD_OFF'
]);

function isAllowedRemoteCommand(cmd) {
  if (typeof cmd !== 'string') return false;
  return ALLOWED_REMOTE_COMMANDS.has(cmd) ||
    /^SFX:[0-5]$/.test(cmd) ||
    /^LED_MODE:[a-z0-9-]+$/i.test(cmd);
}

function getAuthRemoteStateSnapshot() {
  return {
    liveName: remoteState.liveName,
    nextName: remoteState.nextName,
    blackout: remoteState.blackout,
    bpm: remoteState.bpm,
    ledMode: remoteState.ledMode,
    overlays: remoteState.overlays,
    sfxNames: remoteState.sfxNames,
    stageNote: remoteState.stageNote,
    timerText: remoteState.timerText,
    stageMessage: remoteState.stageMessage,
    timerUrgent: remoteState.timerUrgent
  };
}

function getPublicStageStateSnapshot() {
  return {
    liveName: remoteState.liveName,
    nextName: remoteState.nextName,
    bpm: remoteState.bpm,
    stageNote: remoteState.stageNote,
    timerText: remoteState.timerText,
    stageMessage: remoteState.stageMessage,
    timerUrgent: remoteState.timerUrgent,
    blackout: remoteState.blackout
  };
}

/** HTML giao diện điện thoại cho Remote LAN (100% offline, tiếng Việt, 4 tab) */
function buildRemoteMobileHtml() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>EVENT RUNNER — Điều khiển từ xa</title>
<style>
  *{box-sizing:border-box;font-family:'Segoe UI',system-ui,sans-serif;-webkit-tap-highlight-color:transparent}
  body{margin:0;background:#0c1017;color:#e4ebf5;display:flex;flex-direction:column;min-height:100vh;padding:12px;gap:10px}
  .topbar{display:flex;align-items:center;justify-content:space-between;gap:8px}
  h1{font-size:15px;margin:0;letter-spacing:.5px;color:#00d2ff}
  .stage-link{font-size:12px;font-weight:700;color:#00d2ff;text-decoration:none;border:1px solid #1e4b63;background:#102230;padding:6px 10px;border-radius:8px}
  .card{background:#151b24;border:1px solid #283344;border-radius:10px;padding:12px}
  .label{font-size:11px;color:#8291a8;text-transform:uppercase;letter-spacing:.6px}
  .val{font-size:16px;font-weight:700;margin-top:3px;word-break:break-word}
  .live{color:#2ee59d}.next{color:#ffb020}
  .meta-row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px;font-size:13px;color:#b8c7dc}
  .note-box{margin-top:8px;padding:8px;border-radius:8px;background:#0e131b;border:1px solid #232d3d;font-size:13px;color:#ffe6a3;white-space:pre-wrap;max-height:72px;overflow:auto}
  input,button{font-size:15px;border-radius:10px;border:1px solid #2a3446;padding:12px;color:#fff;touch-action:manipulation}
  input{background:#0b0f16;width:100%;text-align:center;font-size:24px;letter-spacing:8px}
  button{cursor:pointer;font-weight:700;background:#1e2634}
  button:active{transform:scale(0.98)}
  .tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
  .tab-btn{padding:10px 4px;font-size:12px;background:#151b24;border-color:#263143;color:#93a3ba}
  .tab-btn.active{background:#0f2a3a;border-color:#00d2ff;color:#00d2ff}
  .tab-pane{display:flex;flex-direction:column;gap:10px}
  .btn-go{background:#158450;border-color:#2ee59d;padding:24px;font-size:24px;width:100%}
  .row-2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .row-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
  .btn-sec{background:#202938}
  .btn-fade{background:#1b3348;border-color:#00d2ff}
  .btn-blk{background:#4d3510;border-color:#ffb020}
  .btn-blk.is-on{background:#b45309;color:#fff}
  .btn-stp{background:#6b1915;border-color:#ff4d3d;width:100%;padding:16px}
  .ov-btn{display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:14px;text-align:left;background:#161d29}
  .ov-btn.is-on{background:#103846;border-color:#00d2ff}
  .ov-state{font-size:11px;color:#8291a8}
  .ov-btn.is-on .ov-state{color:#2ee59d}
  .btn-flash{background:#3a2d0d;border-color:#fbbf24;padding:18px;font-size:16px}
  .btn-strobe{background:#4c1528;border-color:#ff3b7f;padding:18px;font-size:16px;touch-action:none;user-select:none}
  .btn-strobe.holding{background:#be185d;border-color:#fff}
  .mode-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .mode-btn{padding:12px 8px;font-size:13px;background:#161d29}
  .mode-btn.active{background:#0f2f42;border-color:#00d2ff;color:#00d2ff}
  .sfx-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .sfx-btn{padding:20px 10px;background:#1b2433;border-color:#34435c;min-height:74px;font-size:15px}
  .status{font-size:12px;color:#7d8a99;text-align:center}
  .hidden{display:none!important}
</style>
</head>
<body>
  <div class="topbar">
    <h1>EVENT RUNNER — REMOTE</h1>
    <a class="stage-link" href="/stage">Mở /stage</a>
  </div>

  <div id="auth-box" class="card">
    <div class="label">Nhập mã PIN 4 số trên máy tính</div>
    <input id="pin-input" type="password" inputmode="numeric" maxlength="4" placeholder="••••" style="margin:12px 0">
    <button id="btn-connect" class="btn-go" style="padding:14px;font-size:17px">KẾT NỐI</button>
    <div id="auth-err" class="status" style="color:#ff5b5b;margin-top:8px"></div>
  </div>

  <div id="ctrl-box" class="hidden" style="display:flex;flex-direction:column;gap:10px">
    <div class="card">
      <div class="label">ĐANG CHẠY (LIVE)</div>
      <div id="live-name" class="val live">Chưa phát</div>
      <div class="label" style="margin-top:8px">KẾ TIẾP (NEXT)</div>
      <div id="next-name" class="val next">Trống</div>
      <div class="meta-row">
        <span>Đồng hồ: <strong id="timer-val">--:--</strong></span>
        <span>Nhịp: <strong id="bpm-val">120 BPM</strong></span>
      </div>
      <div id="stage-note-box" class="note-box hidden"></div>
    </div>

    <div class="tabs">
      <button class="tab-btn active" data-tab="show">Show</button>
      <button class="tab-btn" data-tab="overlays">Overlays</button>
      <button class="tab-btn" data-tab="led">LED Beat</button>
      <button class="tab-btn" data-tab="sfx">SFX</button>
    </div>

    <div id="pane-show" class="tab-pane">
      <button id="btn-go" class="btn-go">GO — CHẠY CUE</button>
      <div class="row-3">
        <button id="btn-back" class="btn-sec">← LÙI</button>
        <button id="btn-fade" class="btn-fade">FADE</button>
        <button id="btn-blk" class="btn-blk">ĐEN MÀN</button>
      </div>
      <button id="btn-stop" class="btn-stp">DỪNG TẤT CẢ</button>
    </div>

    <div id="pane-overlays" class="tab-pane hidden">
      <div class="row-2">
        <button class="ov-btn" data-ov="OV1" id="ov-btn-1">
          <span>OV1 — Lower Third</span>
          <span class="ov-state" id="ov-st-1">Đang tắt</span>
        </button>
        <button class="ov-btn" data-ov="OV2" id="ov-btn-2">
          <span>OV2 — Logo Góc</span>
          <span class="ov-state" id="ov-st-2">Đang tắt</span>
        </button>
        <button class="ov-btn" data-ov="OV3" id="ov-btn-3">
          <span>OV3 — Đồng hồ</span>
          <span class="ov-state" id="ov-st-3">Đang tắt</span>
        </button>
        <button class="ov-btn" data-ov="OV4" id="ov-btn-4">
          <span>OV4 — Chữ chạy</span>
          <span class="ov-state" id="ov-st-4">Đang tắt</span>
        </button>
      </div>
    </div>

    <div id="pane-led" class="tab-pane hidden">
      <div class="row-2">
        <button id="btn-flash-hit" class="btn-flash">⚡ FLASH HIT</button>
        <button id="btn-strobe-hold" class="btn-strobe">💥 GIỮ CHỚP</button>
      </div>
      <button id="btn-tap-bpm" class="btn-sec">🥁 TAP BPM (<span id="bpm-btn-val">120</span>)</button>
      <div class="label" style="margin-top:4px">Chế độ chớp LED theo beat</div>
      <div class="mode-grid" id="led-mode-grid">
        <button class="mode-btn" data-mode="off">Tắt chớp</button>
        <button class="mode-btn" data-mode="flash">Chớp Flash</button>
        <button class="mode-btn" data-mode="wash">Phủ Wash</button>
        <button class="mode-btn" data-mode="edge-chase">Chạy Viền</button>
        <button class="mode-btn" data-mode="quadrant">Chớp 4 Góc</button>
        <button class="mode-btn" data-mode="matrix-bars">Thanh Equalizer</button>
        <button class="mode-btn" data-mode="invert-hit">Đảo Màu Kick</button>
        <button class="mode-btn" data-mode="blinder">Đèn Blinder</button>
      </div>
    </div>

    <div id="pane-sfx" class="tab-pane hidden">
      <div class="sfx-grid" id="sfx-grid">
        <button class="sfx-btn" data-sfx="0">SFX 1</button>
        <button class="sfx-btn" data-sfx="1">SFX 2</button>
        <button class="sfx-btn" data-sfx="2">SFX 3</button>
        <button class="sfx-btn" data-sfx="3">SFX 4</button>
        <button class="sfx-btn" data-sfx="4">SFX 5</button>
        <button class="sfx-btn" data-sfx="5">SFX 6</button>
      </div>
    </div>

    <div id="conn-status" class="status">Đã kết nối</div>
  </div>

<script>
  (function(){
    let ws=null, authed=false, strobeHolding=false;
    const authBox=document.getElementById('auth-box');
    const ctrlBox=document.getElementById('ctrl-box');
    const pinInput=document.getElementById('pin-input');
    const authErr=document.getElementById('auth-err');

    document.getElementById('btn-connect').addEventListener('click', connect);
    pinInput.addEventListener('keydown', function(e){ if(e.key==='Enter') connect(); });

    function sendCmd(cmd){
      if(!ws || ws.readyState!==1 || !authed) return;
      if(cmd==='STOP' && !confirm('Xác nhận DỪNG TẤT CẢ?')) return;
      ws.send(JSON.stringify({type:'cmd', cmd:cmd}));
    }

    function connect(){
      const pin=pinInput.value.trim();
      if(pin.length!==4){ authErr.textContent='Vui lòng nhập đủ 4 số PIN'; return; }
      authErr.textContent='Đang kết nối...';
      const proto=location.protocol==='https:'?'wss://':'ws://';
      ws=new WebSocket(proto+location.host);
      ws.onopen=function(){ ws.send(JSON.stringify({type:'auth', pin:pin})); };
      ws.onmessage=function(ev){
        let msg;
        try{ msg=JSON.parse(ev.data); }catch(_){ return; }
        if(msg.type==='auth-ok'){
          authed=true;
          authBox.classList.add('hidden');
          ctrlBox.classList.remove('hidden');
          updateUi(msg.state);
        }else if(msg.type==='auth-fail'){
          authErr.textContent='Sai mã PIN!';
          ws.close();
        }else if(msg.type==='state'){
          updateUi(msg.state);
        }
      };
      ws.onclose=function(){
        if(strobeHolding){ strobeHolding=false; }
        if(authed){
          document.getElementById('conn-status').textContent='Mất kết nối — bấm tải lại trang';
        }
      };
    }

    function isOvActive(ovVal){
      if(ovVal && typeof ovVal==='object') return Boolean(ovVal.active);
      return Boolean(ovVal);
    }

    function updateUi(st){
      if(!st) return;
      document.getElementById('live-name').textContent=st.liveName||'Chưa phát';
      document.getElementById('next-name').textContent=st.nextName||'Trống';
      document.getElementById('timer-val').textContent=st.timerText||'--:--';
      const bpm=Math.round(Number(st.bpm)||120);
      document.getElementById('bpm-val').textContent=bpm+' BPM';
      document.getElementById('bpm-btn-val').textContent=String(bpm);

      const noteBox=document.getElementById('stage-note-box');
      const noteText=(st.stageNote||'').trim();
      if(noteText){
        noteBox.textContent=noteText;
        noteBox.classList.remove('hidden');
      }else{
        noteBox.classList.add('hidden');
      }

      const blkBtn=document.getElementById('btn-blk');
      blkBtn.textContent=st.blackout?'BỎ ĐEN MÀN':'ĐEN MÀN';
      blkBtn.classList.toggle('is-on', Boolean(st.blackout));

      const ov=st.overlays||{};
      for(let i=1;i<=4;i++){
        const on=isOvActive(ov['ov'+i]);
        const btn=document.getElementById('ov-btn-'+i);
        const lbl=document.getElementById('ov-st-'+i);
        if(btn) btn.classList.toggle('is-on', on);
        if(lbl) lbl.textContent=on?'Đang BẬT':'Đang tắt';
      }

      const activeMode=String(st.ledMode||'off');
      document.querySelectorAll('.mode-btn').forEach(function(b){
        b.classList.toggle('active', b.getAttribute('data-mode')===activeMode);
      });

      const sfxNames=Array.isArray(st.sfxNames)?st.sfxNames:[];
      document.querySelectorAll('.sfx-btn').forEach(function(b, idx){
        const raw=sfxNames[idx];
        const name=(raw && typeof raw==='object') ? raw.name : raw;
        b.textContent=(name && String(name).trim()) ? String(name).trim() : ('SFX '+(idx+1));
      });
    }

    document.querySelectorAll('.tab-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        const target=btn.getAttribute('data-tab');
        document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.toggle('active', b===btn); });
        ['show','overlays','led','sfx'].forEach(function(name){
          const pane=document.getElementById('pane-'+name);
          if(pane) pane.classList.toggle('hidden', name!==target);
        });
      });
    });

    document.getElementById('btn-go').addEventListener('click', function(){ sendCmd('GO'); });
    document.getElementById('btn-back').addEventListener('click', function(){ sendCmd('BACK'); });
    document.getElementById('btn-fade').addEventListener('click', function(){ sendCmd('FADE'); });
    document.getElementById('btn-blk').addEventListener('click', function(){ sendCmd('BLACK'); });
    document.getElementById('btn-stop').addEventListener('click', function(){ sendCmd('STOP'); });
    document.getElementById('btn-flash-hit').addEventListener('click', function(){ sendCmd('FLASH_HIT'); });
    document.getElementById('btn-tap-bpm').addEventListener('click', function(){ sendCmd('TAP_BPM'); });

    document.querySelectorAll('.ov-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        sendCmd(btn.getAttribute('data-ov'));
      });
    });

    document.querySelectorAll('.mode-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        sendCmd('LED_MODE:'+btn.getAttribute('data-mode'));
      });
    });

    document.querySelectorAll('.sfx-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        sendCmd('SFX:'+btn.getAttribute('data-sfx'));
      });
    });

    const strobeBtn=document.getElementById('btn-strobe-hold');
    function beginStrobe(ev){
      if(ev) ev.preventDefault();
      if(strobeHolding) return;
      strobeHolding=true;
      strobeBtn.classList.add('holding');
      sendCmd('STROBE_HOLD_ON');
    }
    function endStrobe(){
      if(!strobeHolding) return;
      strobeHolding=false;
      strobeBtn.classList.remove('holding');
      sendCmd('STROBE_HOLD_OFF');
    }
    strobeBtn.addEventListener('pointerdown', beginStrobe);
    strobeBtn.addEventListener('pointerup', endStrobe);
    strobeBtn.addEventListener('pointercancel', endStrobe);
    strobeBtn.addEventListener('pointerleave', endStrobe);
    window.addEventListener('blur', endStrobe);
  })();
</script>
</body>
</html>`;
}

/** HTML giao diện Web Stage Display (/stage — chỉ đọc, tự đồng bộ qua WebSocket) */
function buildWebStageHtml() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>EVENT RUNNER — Web Stage Display</title>
<style>
  *{box-sizing:border-box;font-family:'Segoe UI',system-ui,sans-serif}
  html,body{margin:0;padding:0;width:100%;height:100%;background:#05080f;color:#f3f7ff}
  body{display:flex;flex-direction:column;padding:14px;gap:12px}
  .hidden{display:none!important}
  .hdr{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:10px;background:#0d1320;border:2px solid #23314d;border-radius:12px;padding:12px 16px}
  .lbl{font-size:11px;font-weight:800;letter-spacing:1.2px;color:#8ea0bf;text-transform:uppercase}
  .mono{font-family:'Cascadia Mono','Consolas',monospace;font-variant-numeric:tabular-nums;font-weight:900}
  .clock{font-size:clamp(24px,5vw,56px)}
  .timer{font-size:clamp(26px,5.4vw,60px);color:#00d2ff;text-align:right}
  .timer.urgent{color:#ff3b3b}
  .mid-hdr{display:flex;flex-direction:column;align-items:center;gap:6px}
  .badge{font-size:11px;font-weight:800;color:#00d2ff;background:rgba(0,210,255,.12);border:1px solid rgba(0,210,255,.35);padding:4px 10px;border-radius:999px}
  .blk-badge{font-size:12px;font-weight:900;background:#ff3b3b;color:#fff;padding:4px 10px;border-radius:6px}
  .msg-banner{background:linear-gradient(90deg,#ffb020,#ff8c00);color:#0b0f17;border-radius:12px;padding:12px 16px;display:flex;align-items:center;gap:12px}
  .msg-tag{background:#0b0f17;color:#ffb020;font-size:11px;font-weight:900;padding:4px 8px;border-radius:6px;flex-shrink:0}
  .msg-text{font-size:clamp(18px,3vw,34px);font-weight:900;word-break:break-word}
  .main{flex:1;min-height:0;display:grid;grid-template-columns:2fr 1fr;gap:12px}
  @media(max-width:720px){.main{grid-template-columns:1fr}}
  .panel{background:#0d1320;border:2px solid #23314d;border-radius:12px;padding:14px 18px;display:flex;flex-direction:column;min-height:0;overflow:hidden}
  .panel-live{border-left:6px solid #2ee59d}
  .panel-next{border-left:6px solid #ffb020;background:#111a2b}
  .pill-live{color:#2ee59d;font-size:12px;font-weight:900;letter-spacing:1px}
  .pill-next{color:#ffb020;font-size:12px;font-weight:900;letter-spacing:1px}
  .live-title{margin:8px 0 0;font-size:clamp(22px,3.6vw,48px);font-weight:900;line-height:1.15;word-break:break-word}
  .note-sep{margin-top:12px;padding-top:8px;border-top:1px solid #23314d;font-size:11px;font-weight:800;color:#8ea0bf;letter-spacing:1px}
  .note{margin-top:8px;flex:1;overflow:auto;font-size:clamp(18px,2.5vw,34px);font-weight:700;line-height:1.35;color:#fff6c9;white-space:pre-wrap;word-break:break-word}
  .note.empty{color:#4f5f7a;font-style:italic;font-weight:500}
  .next-title{margin:8px 0 0;font-size:clamp(18px,2.6vw,36px);font-weight:800;color:#ffe3a8;word-break:break-word}
  .ftr{display:flex;align-items:center;justify-content:space-between;background:#0d1320;border:2px solid #23314d;border-radius:12px;padding:10px 16px;font-size:14px}
  .bpm{color:#00d2ff;font-size:18px;font-weight:900}
  .conn{color:#8ea0bf;font-size:12px}
  .back-link{color:#00d2ff;text-decoration:none;font-size:12px;font-weight:700}
</style>
</head>
<body>
  <header class="hdr">
    <div>
      <div class="lbl">GIỜ HỆ THỐNG</div>
      <div id="wall-clock" class="mono clock">--:--:--</div>
    </div>
    <div class="mid-hdr">
      <div class="badge">WEB STAGE</div>
      <div id="blk-badge" class="blk-badge hidden">ĐANG ĐEN MÀN</div>
    </div>
    <div>
      <div class="lbl" style="text-align:right">ĐỒNG HỒ SỰ KIỆN</div>
      <div id="timer-text" class="mono timer">--:--</div>
    </div>
  </header>

  <section id="msg-banner" class="msg-banner hidden">
    <div class="msg-tag">TIN NHẮN SÂN KHẤU</div>
    <div id="msg-text" class="msg-text"></div>
  </section>

  <main class="main">
    <section class="panel panel-live">
      <div class="pill-live">ĐANG CHẠY (LIVE)</div>
      <h1 id="live-name" class="live-title">Chưa phát</h1>
      <div class="note-sep">GHI CHÚ DIỄN GIẢ / KỸ THUẬT</div>
      <div id="stage-note" class="note empty">Chưa có ghi chú cho Cue hiện tại</div>
    </section>
    <aside class="panel panel-next">
      <div class="pill-next">KẾ TIẾP (NEXT)</div>
      <h2 id="next-name" class="next-title">Trống</h2>
    </aside>
  </main>

  <footer class="ftr">
    <div>NHỊP BEAT: <span id="bpm-val" class="mono bpm">120 BPM</span></div>
    <div id="conn-st" class="conn">Đang kết nối...</div>
    <a class="back-link" href="/">Remote</a>
  </footer>

<script>
  (function(){
    function updateClock(){
      const d=new Date();
      const h=String(d.getHours()).padStart(2,'0');
      const m=String(d.getMinutes()).padStart(2,'0');
      const s=String(d.getSeconds()).padStart(2,'0');
      document.getElementById('wall-clock').textContent=h+':'+m+':'+s;
    }
    updateClock();
    setInterval(updateClock, 250);

    function applyState(st){
      if(!st) return;
      document.getElementById('live-name').textContent=st.liveName||'Chưa phát';
      document.getElementById('next-name').textContent=st.nextName||'Trống';
      const timerEl=document.getElementById('timer-text');
      timerEl.textContent=st.timerText||'--:--';
      timerEl.classList.toggle('urgent', Boolean(st.timerUrgent));
      document.getElementById('bpm-val').textContent=Math.round(Number(st.bpm)||120)+' BPM';
      document.getElementById('blk-badge').classList.toggle('hidden', !st.blackout);

      const noteEl=document.getElementById('stage-note');
      const noteText=(st.stageNote||'').trim();
      if(noteText){
        noteEl.textContent=noteText;
        noteEl.classList.remove('empty');
      }else{
        noteEl.textContent='Chưa có ghi chú cho Cue hiện tại';
        noteEl.classList.add('empty');
      }

      const msgText=(st.stageMessage||'').trim();
      document.getElementById('msg-text').textContent=msgText;
      document.getElementById('msg-banner').classList.toggle('hidden', !msgText);
    }

    function connectWs(){
      const proto=location.protocol==='https:'?'wss://':'ws://';
      const ws=new WebSocket(proto+location.host);
      ws.onopen=function(){
        document.getElementById('conn-st').textContent='Đã đồng bộ trực tiếp';
        ws.send(JSON.stringify({type:'stage-subscribe'}));
      };
      ws.onmessage=function(ev){
        try{
          const msg=JSON.parse(ev.data);
          if(msg.type==='stage-state' || msg.type==='state'){
            applyState(msg.state);
          }
        }catch(_){}
      };
      ws.onclose=function(){
        document.getElementById('conn-st').textContent='Mất kết nối — đang thử lại...';
        setTimeout(connectWs, 2000);
      };
    }
    connectWs();
  })();
</script>
</body>
</html>`;
}

/** Phát trạng thái show tới tất cả thiết bị remote đã xác thực và màn /stage đã đăng ký */
function broadcastRemoteState() {
  if (!remoteWss) return;
  const authPayload = JSON.stringify({
    type: 'state',
    state: getAuthRemoteStateSnapshot()
  });
  const stagePayload = JSON.stringify({
    type: 'stage-state',
    state: getPublicStageStateSnapshot()
  });
  let count = 0;
  remoteWss.clients.forEach((client) => {
    if (client.readyState !== 1) return;
    if (client._authed) {
      count++;
      client.send(authPayload);
    } else if (client._stageSubscribed) {
      client.send(stagePayload);
    }
  });
  remoteState.clients = count;
}

/** Bật server điều khiển từ xa LAN */
function startRemoteServer(pin) {
  return new Promise((resolve) => {
    if (remoteHttpServer) {
      remoteState.pin = String(pin || remoteState.pin).replace(/\D/g, '').slice(0, 4).padStart(4, '0');
      saveSettings({ remotePin: remoteState.pin });
      resolve({ ...remoteState });
      return;
    }

    const cleanPin = String(pin || loadSettings().remotePin || '1234').replace(/\D/g, '').slice(0, 4).padStart(4, '0');
    saveSettings({ remotePin: cleanPin });

    const server = http.createServer((req, res) => {
      const reqPath = (req.url || '/').split('?')[0];
      if (reqPath === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildRemoteMobileHtml());
      } else if (reqPath === '/stage') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildWebStageHtml());
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    const wss = new WebSocketServer({ server });
    wss.on('connection', (socket) => {
      socket._authed = false;
      socket._stageSubscribed = false;
      socket.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (!msg || typeof msg !== 'object') return;

          if (msg.type === 'stage-subscribe') {
            socket._stageSubscribed = true;
            socket.send(JSON.stringify({
              type: 'stage-state',
              state: getPublicStageStateSnapshot()
            }));
            return;
          }

          if (msg.type === 'auth') {
            if (String(msg.pin) === remoteState.pin) {
              socket._authed = true;
              socket.send(JSON.stringify({
                type: 'auth-ok',
                state: getAuthRemoteStateSnapshot()
              }));
              broadcastRemoteState();
            } else {
              socket.send(JSON.stringify({ type: 'auth-fail' }));
            }
            return;
          }

          if (!socket._authed) return;

          if (msg.type === 'cmd' && isAllowedRemoteCommand(msg.cmd)) {
            if (controlWindow && !controlWindow.isDestroyed()) {
              controlWindow.webContents.send('remote-command', msg.cmd);
            }
          }
        } catch (_) {}
      });
      socket.on('close', () => {
        broadcastRemoteState();
      });
    });

    server.on('error', () => {
      // Nếu cổng 8765 bận, thử cổng ngẫu nhiên
      server.listen(0, '0.0.0.0');
    });

    server.listen(8765, '0.0.0.0', () => {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 8765;
      remoteHttpServer = server;
      remoteWss = wss;
      remoteState.enabled = true;
      remoteState.port = port;
      remoteState.pin = cleanPin;
      remoteState.urls = getLanUrls(port);
      remoteState.clients = 0;
      resolve({ ...remoteState });
    });
  });
}

/** Tắt server điều khiển từ xa LAN */
function stopRemoteServer() {
  if (remoteWss) {
    try {
      remoteWss.clients.forEach((c) => c.terminate());
      remoteWss.close();
    } catch (_) {}
    remoteWss = null;
  }
  if (remoteHttpServer) {
    try {
      remoteHttpServer.close();
    } catch (_) {}
    remoteHttpServer = null;
  }
  remoteState.enabled = false;
  remoteState.urls = [];
  remoteState.clients = 0;
  return { ...remoteState };
}

/** Đăng ký toàn bộ IPC handler */
function registerIpcHandlers() {
  // Chuyển lệnh điều khiển fire-and-forget sang cửa sổ LED (Mục 4 & 10)
  ipcMain.on('out', (_event, cmd) => {
    if (ledWindow && !ledWindow.isDestroyed()) {
      ledWindow.webContents.send('cmd', cmd);
    }
  });

  ipcMain.on('led-ready', () => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('led-ready', getLedStatusPayload());
    }
  });

  ipcMain.on('led-media-error', (_event, payload) => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('led-media-error', payload);
    }
  });

  ipcMain.on('led-video-beat', (_event, payload) => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('led-video-beat', payload);
    }
  });

  ipcMain.on('led-video-telemetry', (_event, payload) => {
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('led-video-telemetry', payload);
    }
  });

  ipcMain.on('renderer-error', (_event, payload) => {
    logError('renderer', JSON.stringify(payload));
  });

  ipcMain.on('show-running-state', (_event, running) => {
    isShowRunning = Boolean(running);
  });

  // Stage Display IPC
  ipcMain.handle('stage:open', (_event, displayId) => openStageWindow(displayId));
  ipcMain.handle('stage:close', () => closeStageWindow());
  ipcMain.handle('stage:status', () => getStageStatusPayload());

  ipcMain.on('stage:send', (_event, payload) => {
    if (payload && typeof payload === 'object') {
      lastStagePayload = payload;
      if (stageWindow && !stageWindow.isDestroyed()) {
        stageWindow.webContents.send('stage-update', payload);
      }
      if (payload.liveName !== undefined) remoteState.liveName = payload.liveName || 'Chưa phát';
      if (payload.nextName !== undefined) remoteState.nextName = payload.nextName || 'Trống';
      if (payload.bpm !== undefined && Number.isFinite(Number(payload.bpm))) {
        remoteState.bpm = Number(payload.bpm);
      }
      if (payload.stageNote !== undefined) remoteState.stageNote = String(payload.stageNote || '');
      if (payload.timerText !== undefined) remoteState.timerText = String(payload.timerText || '--:--');
      if (payload.stageMessage !== undefined) remoteState.stageMessage = String(payload.stageMessage || '');
      if (payload.blackout !== undefined) remoteState.blackout = Boolean(payload.blackout);
      const urgentFlag = Boolean(
        payload.timerUrgent ||
        payload.urgent ||
        payload.isUrgent ||
        payload.timerWarning ||
        (payload.timerDisplay && payload.timerDisplay.urgent)
      );
      remoteState.timerUrgent = urgentFlag;

      const sig = JSON.stringify(getPublicStageStateSnapshot());
      if (sig !== lastPublicStageSig) {
        lastPublicStageSig = sig;
        if (remoteWss) {
          const msg = JSON.stringify({ type: 'stage-state', state: getPublicStageStateSnapshot() });
          remoteWss.clients.forEach((client) => {
            if (client.readyState === 1 && client._stageSubscribed) {
              client.send(msg);
            }
          });
        }
      }
    }
  });

  ipcMain.on('stage-ready', () => {
    if (lastStagePayload && stageWindow && !stageWindow.isDestroyed()) {
      stageWindow.webContents.send('stage-update', lastStagePayload);
    }
    if (controlWindow && !controlWindow.isDestroyed()) {
      controlWindow.webContents.send('stage-ready', getStageStatusPayload());
    }
  });

  // DMX Art-Net / sACN IPC
  ipcMain.handle('dmx:configure', (_event, cfg) => {
    const eng = getDmxEngine();
    if (!eng) {
      return {
        enabled: false,
        protocol: cfg && cfg.protocol === 'sacn' ? 'sacn' : 'artnet',
        host: (cfg && cfg.host) || '255.255.255.255',
        port: (cfg && cfg.port) || 6454,
        universe: (cfg && cfg.universe) || 0,
        fps: (cfg && cfg.fps) || 35,
        packetsSent: 0,
        lastError: 'DMX module unavailable'
      };
    }
    return eng.configure(cfg);
  });

  ipcMain.on('dmx:frame', (_event, channels) => {
    const eng = dmxEngine || getDmxEngine();
    if (eng) {
      eng.updateFrame(channels);
    }
  });

  ipcMain.handle('dmx:status', () => {
    const eng = dmxEngine || getDmxEngine();
    if (!eng) {
      return {
        enabled: false,
        protocol: 'artnet',
        host: '255.255.255.255',
        port: 6454,
        universe: 0,
        fps: 35,
        packetsSent: 0,
        lastError: null
      };
    }
    return eng.getStatus();
  });

  // OSC UDP Listener IPC
  ipcMain.handle('osc:toggle', async (_event, payload) => {
    const enable = Boolean(payload && payload.enable);
    const port = Number(payload && payload.port) || 9000;
    const srv = getOscServer();
    if (!srv) {
      return { enabled: false, port, lastError: 'OSC module unavailable' };
    }
    if (enable) {
      return await srv.start(port, (msg) => {
        if (controlWindow && !controlWindow.isDestroyed()) {
          controlWindow.webContents.send('osc-message', msg);
        }
      });
    }
    return srv.stop();
  });

  ipcMain.handle('osc:status', () => {
    const srv = oscServer || getOscServer();
    if (!srv) {
      return { enabled: false, port: 9000, lastError: null };
    }
    return srv.getStatus();
  });

  ipcMain.on('remote:broadcastState', (_event, st) => {
    if (st && typeof st === 'object') {
      if (st.liveName !== undefined) remoteState.liveName = st.liveName || 'Chưa phát';
      if (st.nextName !== undefined) remoteState.nextName = st.nextName || 'Trống';
      if (st.blackout !== undefined) remoteState.blackout = Boolean(st.blackout);
      if (st.bpm !== undefined && Number.isFinite(Number(st.bpm))) remoteState.bpm = Number(st.bpm);
      if (st.ledMode !== undefined) remoteState.ledMode = String(st.ledMode || 'off');
      if (st.overlays !== undefined && typeof st.overlays === 'object') remoteState.overlays = st.overlays;
      if (Array.isArray(st.sfxNames)) remoteState.sfxNames = st.sfxNames;
      if (st.stageNote !== undefined) remoteState.stageNote = String(st.stageNote || '');
      if (st.timerText !== undefined) remoteState.timerText = String(st.timerText || '--:--');
      if (st.stageMessage !== undefined) remoteState.stageMessage = String(st.stageMessage || '');
      if (st.timerUrgent !== undefined) remoteState.timerUrgent = Boolean(st.timerUrgent);
      lastPublicStageSig = JSON.stringify(getPublicStageStateSnapshot());
      broadcastRemoteState();
    }
  });

  ipcMain.handle('displays:list', () => getFormattedDisplays());
  ipcMain.handle('led:status', () => getLedStatusPayload());
  ipcMain.handle('led:open', (_event, displayId) => openLedWindow(displayId));
  ipcMain.handle('led:close', () => closeLedWindow());

  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:set', (_event, partial) => saveSettings(partial));

  // Autosave (Mục 7.7)
  ipcMain.handle('project:loadAutosave', () => {
    const { autosaveFile } = getUserDataPaths();
    try {
      if (!fs.existsSync(autosaveFile)) {
        return { exists: false, project: null, filePath: null };
      }
      const raw = JSON.parse(fs.readFileSync(autosaveFile, 'utf8'));
      const projectData = raw.project ? raw.project : raw;
      lastProjectFilePath = raw.projectFilePath || null;
      const validated = logic.validateAndMigrateProject(projectData);
      return {
        exists: true,
        project: validated.project,
        warnings: validated.warnings,
        projectFilePath: lastProjectFilePath
      };
    } catch (err) {
      logError('project:loadAutosave', err);
      return { exists: false, project: null, error: 'Không đọc được bản tự lưu gần nhất.' };
    }
  });

  ipcMain.handle('project:saveAutosave', (_event, payload) => {
    const { userDir, autosaveFile } = getUserDataPaths();
    try {
      fs.mkdirSync(userDir, { recursive: true });
      const data = {
        savedAt: new Date().toISOString(),
        projectFilePath: payload && payload.projectFilePath ? payload.projectFilePath : lastProjectFilePath,
        project: payload && payload.project ? payload.project : payload
      };
      fs.writeFileSync(autosaveFile, JSON.stringify(data, null, 2), 'utf8');
      return { ok: true };
    } catch (err) {
      logError('project:saveAutosave', err);
      return { ok: false, error: err.message };
    }
  });

  // Mở / Lưu file dự án .json
  ipcMain.handle('project:openDialog', async () => {
    const res = await dialog.showOpenDialog(controlWindow, {
      title: 'Mở file chương trình EVENT RUNNER',
      filters: [{ name: 'Dự án Event Runner (*.json)', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (res.canceled || res.filePaths.length === 0) return { canceled: true };
    const filePath = res.filePaths[0];
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const validated = logic.validateAndMigrateProject(raw);
      if (!validated.ok) {
        return { canceled: false, ok: false, error: validated.error };
      }
      lastProjectFilePath = filePath;
      return {
        canceled: false,
        ok: true,
        filePath,
        project: validated.project,
        warnings: validated.warnings
      };
    } catch (err) {
      return { canceled: false, ok: false, error: 'File JSON bị lỗi hoặc không đọc được: ' + err.message };
    }
  });

  ipcMain.handle('project:saveDialog', async (_event, { project, currentPath, saveAs }) => {
    let targetPath = !saveAs && currentPath ? currentPath : null;
    if (!targetPath) {
      const res = await dialog.showSaveDialog(controlWindow, {
        title: 'Lưu file chương trình EVENT RUNNER',
        defaultPath: currentPath || 'chuong-trinh-su-kien.json',
        filters: [{ name: 'Dự án Event Runner (*.json)', extensions: ['json'] }]
      });
      if (res.canceled || !res.filePath) return { canceled: true };
      targetPath = res.filePath;
    }
    try {
      fs.writeFileSync(targetPath, JSON.stringify(project, null, 2), 'utf8');
      lastProjectFilePath = targetPath;
      return { canceled: false, ok: true, filePath: targetPath };
    } catch (err) {
      return { canceled: false, ok: false, error: 'Không lưu được file: ' + err.message };
    }
  });

  // Gói dự án (Collect files - Mục 9.7): copy toàn bộ media vào thư mục cạnh file dự án
  ipcMain.handle('project:collectFiles', async (_event, { project, currentPath }) => {
    const res = await dialog.showSaveDialog(controlWindow, {
      title: 'Chọn nơi lưu file dự án đã đóng gói',
      defaultPath: currentPath || 'su-kien-dong-goi.json',
      filters: [{ name: 'Dự án Event Runner (*.json)', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return { canceled: true };

    const targetJson = res.filePath;
    const baseDir = path.dirname(targetJson);
    const stem = path.basename(targetJson, path.extname(targetJson));
    const mediaFolderName = `${stem}_media`;
    const mediaDir = path.join(baseDir, mediaFolderName);

    try {
      fs.mkdirSync(mediaDir, { recursive: true });
      const copiedMap = new Map();
      const usedNames = new Set();
      let copiedCount = 0;
      const missingFiles = [];

      const copyOne = (rawPath) => {
        if (!rawPath) return null;
        const abs = resolveMediaPath(rawPath, currentPath);
        if (!abs || !fs.existsSync(abs)) {
          missingFiles.push(rawPath);
          return rawPath;
        }
        if (copiedMap.has(abs)) return copiedMap.get(abs);

        const ext = path.extname(abs);
        const origName = path.basename(abs, ext);
        let candidate = `${origName}${ext}`;
        let counter = 1;
        while (usedNames.has(candidate.toLowerCase())) {
          candidate = `${origName}_${counter}${ext}`;
          counter++;
        }
        usedNames.add(candidate.toLowerCase());

        const destAbs = path.join(mediaDir, candidate);
        if (path.resolve(abs) !== path.resolve(destAbs)) {
          fs.copyFileSync(abs, destAbs);
        }
        copiedCount++;
        const relPath = `./${mediaFolderName}/${candidate}`;
        copiedMap.set(abs, relPath);
        return relPath;
      };

      const cloned = JSON.parse(JSON.stringify(project));
      for (const cue of cloned.cues || []) {
        if (cue.aud) cue.aud = copyOne(cue.aud);
        if (cue.vis) cue.vis = copyOne(cue.vis);
      }
      for (const pad of cloned.sfxPads || []) {
        if (pad.path) pad.path = copyOne(pad.path);
      }
      if (cloned.overlays && cloned.overlays.ov2 && cloned.overlays.ov2.path) {
        cloned.overlays.ov2.path = copyOne(cloned.overlays.ov2.path);
      }
      if (cloned.vjDeck && Array.isArray(cloned.vjDeck.decks)) {
        for (const deck of cloned.vjDeck.decks) {
          if (!Array.isArray(deck)) continue;
          for (const layerRow of deck) {
            if (!Array.isArray(layerRow)) continue;
            for (const clip of layerRow) {
              if (clip && (clip.kind === 'image' || clip.kind === 'video') && clip.path) {
                clip.path = copyOne(clip.path);
              }
            }
          }
        }
      }

      fs.writeFileSync(targetJson, JSON.stringify(cloned, null, 2), 'utf8');
      lastProjectFilePath = targetJson;

      return {
        canceled: false,
        ok: true,
        filePath: targetJson,
        mediaDir,
        copiedCount,
        missingFiles,
        project: cloned
      };
    } catch (err) {
      return { canceled: false, ok: false, error: 'Lỗi khi gói dự án: ' + err.message };
    }
  });

  // Chọn file media
  ipcMain.handle('media:pickAudio', async () => {
    const res = await dialog.showOpenDialog(controlWindow, {
      title: 'Chọn file nhạc',
      filters: [
        { name: 'Tệp âm thanh', extensions: ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac', 'opus'] },
        { name: 'Tất cả tệp', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('media:pickVisual', async () => {
    const res = await dialog.showOpenDialog(controlWindow, {
      title: 'Chọn ảnh hoặc video cho màn LED',
      filters: [
        { name: 'Ảnh & Video', extensions: ['mp4', 'webm', 'm4v', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'mov', 'mkv', 'avi'] },
        { name: 'Tất cả tệp', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('media:pickBatchVisuals', async () => {
    const res = await dialog.showOpenDialog(controlWindow, {
      title: 'Chọn nhiều tệp Ảnh, Video hoặc Nhạc (mỗi tệp tự nhập thành 1 Cue)',
      filters: [
        {
          name: 'Tất cả Media (Ảnh, Video, Nhạc)',
          extensions: ['mp4', 'webm', 'm4v', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac', 'opus', 'mov', 'mkv', 'avi']
        },
        { name: 'Ảnh & Video LED', extensions: ['mp4', 'webm', 'm4v', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'mov', 'mkv', 'avi'] },
        { name: 'Nhạc & Âm thanh', extensions: ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac', 'opus'] },
        { name: 'Tất cả tệp', extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections']
    });
    return res.canceled ? [] : res.filePaths;
  });

  // Kiểm tra file media còn tồn tại không (Mục 7.1)
  ipcMain.handle('media:checkExists', (_event, { paths, projectFilePath }) => {
    const result = {};
    if (!Array.isArray(paths)) return result;
    for (const p of paths) {
      if (!p) continue;
      const resolved = resolveMediaPath(p, projectFilePath);
      try {
        result[p] = Boolean(resolved && fs.existsSync(resolved));
      } catch (_) {
        result[p] = false;
      }
    }
    return result;
  });

  // Đọc buffer âm thanh để vẽ waveform
  ipcMain.handle('media:readBuffer', async (_event, { filePath, projectFilePath }) => {
    const resolved = resolveMediaPath(filePath, projectFilePath);
    if (!resolved || !fs.existsSync(resolved)) {
      return { ok: false, error: 'File không tồn tại.' };
    }
    try {
      const stat = fs.statSync(resolved);
      if (stat.size > 120 * 1024 * 1024) {
        return { ok: false, error: 'File quá lớn (> 120 MB) để vẽ waveform.' };
      }
      const buf = fs.readFileSync(resolved);
      return { ok: true, buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('media:resolveUrl', (_event, { filePath, projectFilePath }) => {
    return toSafeFileUrl(filePath, projectFilePath);
  });

  // Nhật ký show (Mục 9.10)
  ipcMain.handle('log:append', (_event, line) => {
    const { showLogFile } = getUserDataPaths();
    writeLogLine(showLogFile, String(line || ''));
    return true;
  });

  ipcMain.handle('log:readRecent', () => {
    const { showLogFile } = getUserDataPaths();
    try {
      if (!fs.existsSync(showLogFile)) return [];
      const text = fs.readFileSync(showLogFile, 'utf8');
      return text.trim().split('\n').slice(-120).reverse();
    } catch (_) {
      return [];
    }
  });

  ipcMain.handle('log:openFolder', () => {
    const dir = ensureLogsDir();
    if (dir) shell.openPath(dir);
    return dir;
  });

  // Remote LAN
  ipcMain.handle('remote:status', () => ({ ...remoteState }));
  ipcMain.handle('remote:toggle', async (_event, { enable, pin }) => {
    if (enable) {
      return await startRemoteServer(pin);
    }
    return stopRemoteServer();
  });
}

/** Chế độ kiểm thử tự động (Smoke Test) khi EVENT_RUNNER_SMOKE=1 */
function runSmokeTestMode() {
  const consoleErrors = [];
  let ledReadySeen = false;

  app.on('web-contents-created', (_e, wc) => {
    wc.on('console-message', (_ev, level, message) => {
      if (level >= 3) {
        consoleErrors.push(message);
      }
    });
    wc.on('did-fail-load', (_ev, code, desc) => {
      consoleErrors.push(`did-fail-load ${code}: ${desc}`);
    });
  });

  ipcMain.on('led-ready', () => {
    ledReadySeen = true;
  });

  setTimeout(() => {
    const ok = Boolean(
      controlWindow && !controlWindow.isDestroyed() &&
      ledWindow && !ledWindow.isDestroyed() &&
      ledReadySeen &&
      consoleErrors.length === 0
    );
    console.log('[SMOKE] controlOk=', Boolean(controlWindow), 'ledOk=', Boolean(ledWindow), 'ledReady=', ledReadySeen, 'errors=', consoleErrors.length);
    if (consoleErrors.length > 0) {
      console.error('[SMOKE_ERRORS]', consoleErrors);
    }
    isQuitting = true;
    stopAllSubsystems();
    app.exit(ok ? 0 : 1);
  }, 3500);
}

app.whenReady().then(() => {
  // Cho phép thu tín hiệu âm thanh Line-In / Soundcard / Mixer & Camera cho Live Video Input
  const allowedPermissions = new Set(['media', 'audioCapture', 'videoCapture']);
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return allowedPermissions.has(permission);
  });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowedPermissions.has(permission));
  });

  powerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  registerIpcHandlers();
  registerDisplayEvents();
  createControlWindow();
  if (IS_SMOKE) {
    runSmokeTestMode();
  }
});

app.on('window-all-closed', () => {
  if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
    powerSaveBlocker.stop(powerBlockerId);
  }
  stopAllSubsystems();
  app.quit();
});
