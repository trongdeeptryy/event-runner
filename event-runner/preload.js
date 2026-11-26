/**
 * Preload script an toàn (contextIsolation: true, nodeIntegration: false)
 * Cung cấp API thống nhất qua window.api cho cả bảng điều khiển và cửa sổ LED.
 */
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

/**
 * Chuyển đổi đường dẫn media (tuyệt đối hoặc tương đối) sang URL an toàn
 * dùng url.pathToFileURL ngay trong preload để không phải đợi IPC khi bấm GO.
 */
function resolveFileUrlSync(mediaPath, projectFilePath) {
  if (typeof mediaPath !== 'string' || !mediaPath.trim()) return '';
  const trimmed = mediaPath.trim();
  if (/^(file|blob|data):/i.test(trimmed)) return trimmed;

  let resolved;
  if (path.isAbsolute(trimmed)) {
    resolved = path.normalize(trimmed);
  } else if (projectFilePath && typeof projectFilePath === 'string') {
    resolved = path.resolve(path.dirname(projectFilePath), trimmed);
  } else {
    resolved = path.resolve(trimmed);
  }
  return pathToFileURL(resolved).href;
}

/** Lấy tên file hiển thị gọn */
function getBaseNameSync(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return '';
  return path.basename(filePath.trim());
}

/** Lấy tên file không kèm đuôi */
function getStemSync(filePath) {
  const base = getBaseNameSync(filePath);
  const idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(0, idx) : base;
}

/** Lấy đường dẫn thực trên ổ đĩa từ đối tượng File kéo thả vào cửa sổ (tương thích Electron 32/33+) */
function getDroppedFilePathSync(file) {
  if (!file) return '';
  try {
    if (webUtils && typeof webUtils.getPathForFile === 'function') {
      const p = webUtils.getPathForFile(file);
      if (typeof p === 'string' && p.trim()) return p.trim();
    }
  } catch (_) {}
  return typeof file.path === 'string' ? file.path.trim() : '';
}

contextBridge.exposeInMainWorld('api', {
  // Giao tiếp sang cửa sổ LED (fire-and-forget)
  sendToLed: (cmd) => ipcRenderer.send('out', cmd),
  notifyLedReady: () => ipcRenderer.send('led-ready'),
  notifyLedMediaError: (payload) => ipcRenderer.send('led-media-error', payload),
  reportRendererError: (payload) => ipcRenderer.send('renderer-error', payload),
  setShowRunningState: (running) => ipcRenderer.send('show-running-state', running),

  // Lắng nghe sự kiện từ main
  onCommand: (callback) => {
    const handler = (_event, cmd) => callback(cmd);
    ipcRenderer.on('cmd', handler);
    return () => ipcRenderer.removeListener('cmd', handler);
  },
  onLedStatusChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('led-status-changed', handler);
    return () => ipcRenderer.removeListener('led-status-changed', handler);
  },
  onLedReady: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('led-ready', handler);
    return () => ipcRenderer.removeListener('led-ready', handler);
  },
  onLedMediaError: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('led-media-error', handler);
    return () => ipcRenderer.removeListener('led-media-error', handler);
  },
  onRemoteCommand: (callback) => {
    const handler = (_event, cmd) => callback(cmd);
    ipcRenderer.on('remote-command', handler);
    return () => ipcRenderer.removeListener('remote-command', handler);
  },

  // Quản lý màn hình & cửa sổ LED
  listDisplays: () => ipcRenderer.invoke('displays:list'),
  getLedStatus: () => ipcRenderer.invoke('led:status'),
  openLed: (displayId) => ipcRenderer.invoke('led:open', displayId),
  closeLed: () => ipcRenderer.invoke('led:close'),

  // Cài đặt & Lưu trữ
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  loadAutosave: () => ipcRenderer.invoke('project:loadAutosave'),
  saveAutosave: (payload) => ipcRenderer.invoke('project:saveAutosave', payload),
  openProjectDialog: () => ipcRenderer.invoke('project:openDialog'),
  saveProjectDialog: (payload) => ipcRenderer.invoke('project:saveDialog', payload),
  collectProjectFiles: (payload) => ipcRenderer.invoke('project:collectFiles', payload),

  // Chọn & kiểm tra media
  pickAudio: () => ipcRenderer.invoke('media:pickAudio'),
  pickVisual: () => ipcRenderer.invoke('media:pickVisual'),
  pickBatchVisuals: () => ipcRenderer.invoke('media:pickBatchVisuals'),
  checkFilesExist: (paths, projectFilePath) =>
    ipcRenderer.invoke('media:checkExists', { paths, projectFilePath }),
  readMediaBuffer: (filePath, projectFilePath) =>
    ipcRenderer.invoke('media:readBuffer', { filePath, projectFilePath }),

  // Nhật ký show
  appendShowLog: (line) => ipcRenderer.invoke('log:append', line),
  readShowLogs: () => ipcRenderer.invoke('log:readRecent'),
  openLogsFolder: () => ipcRenderer.invoke('log:openFolder'),

  // Điều khiển từ xa LAN
  getRemoteStatus: () => ipcRenderer.invoke('remote:status'),
  toggleRemote: (enable, pin) => ipcRenderer.invoke('remote:toggle', { enable, pin }),
  broadcastRemoteState: (state) => ipcRenderer.send('remote:broadcastState', state),

  // Tiện ích đồng bộ (chạy tức thời không tốn vòng IPC)
  toFileUrl: resolveFileUrlSync,
  baseName: getBaseNameSync,
  fileStem: getStemSync,
  getDroppedFilePath: getDroppedFilePathSync
});
