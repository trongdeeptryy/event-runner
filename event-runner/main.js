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
let powerBlockerId = null;
let isQuitting = false;
let currentLedDisplayId = null;
let currentLedMode = 'closed'; // 'closed' | 'fullscreen' | 'preview-window'
let hotplugTimer = null;
let recoverTimer = null;
let lastProjectFilePath = null;
let isShowRunning = false;

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
    title: 'EVENT RUNNER v2.4 — Bảng điều khiển sự kiện',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      webSecurity: false
    }
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
      stopRemoteServer();
      closeLedWindow();
      controlWindow.destroy();
      app.quit();
    }
  });

  controlWindow.on('closed', () => {
    controlWindow = null;
    if (!isQuitting) {
      isQuitting = true;
      closeLedWindow();
      app.quit();
    }
  });
}

/** Đăng ký sự kiện cắm / rút nóng màn hình */
function registerDisplayEvents() {
  screen.on('display-added', () => {
    const settings = loadSettings();
    notifyDisplayAndLedState('Phát hiện màn hình mới được kết nối...');
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
      }
    }, 1500);
  });

  screen.on('display-removed', (_event, oldDisplay) => {
    if (ledWindow && !ledWindow.isDestroyed() && String(oldDisplay.id) === String(currentLedDisplayId)) {
      closeLedWindow();
      notifyDisplayAndLedState('Cảnh báo: Màn hình LED vừa bị rút kết nối!');
    } else {
      notifyDisplayAndLedState('Một màn hình phụ vừa bị ngắt kết nối.');
    }
  });

  screen.on('display-metrics-changed', () => {
    notifyDisplayAndLedState();
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

/** HTML giao diện điện thoại cho Remote LAN (100% offline, tiếng Việt) */
function buildRemoteMobileHtml() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>EVENT RUNNER — Điều khiển từ xa</title>
<style>
  *{box-sizing:border-box;font-family:'Segoe UI',system-ui,sans-serif}
  body{margin:0;background:#0e1217;color:#dde5ee;display:flex;flex-direction:column;min-height:100vh;padding:16px;gap:14px}
  h1{font-size:18px;margin:0;letter-spacing:.5px;color:#4cc9f0}
  .card{background:#171c23;border:1px solid #2a323d;border-radius:10px;padding:14px}
  .label{font-size:12px;color:#7d8a99;text-transform:uppercase}
  .val{font-size:18px;font-weight:700;margin-top:4px;word-break:break-word}
  .live{color:#ff4d3d}.next{color:#ffb020}
  input,button{font-size:16px;border-radius:10px;border:1px solid #2a323d;padding:14px;color:#fff}
  input{background:#0e1217;width:100%;text-align:center;font-size:24px;letter-spacing:8px}
  button{cursor:pointer;font-weight:700}
  .btn-go{background:#1e9e62;border-color:#2ee59d;padding:28px;font-size:28px;width:100%}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .btn-sec{background:#232b36}
  .btn-blk{background:#523a12;border-color:#ffb020}
  .btn-stp{background:#6b1915;border-color:#ff4d3d;width:100%;padding:18px}
  .status{font-size:13px;color:#7d8a99;text-align:center}
  .hidden{display:none!important}
</style>
</head>
<body>
  <h1>EVENT RUNNER — REMOTE LAN</h1>
  <div id="auth-box" class="card">
    <div class="label">Nhập mã PIN 4 số trên máy tính</div>
    <input id="pin-input" type="password" inputmode="numeric" maxlength="4" placeholder="••••" style="margin:12px 0">
    <button id="btn-connect" class="btn-go" style="padding:14px;font-size:18px">KẾT NỐI</button>
    <div id="auth-err" class="status" style="color:#ff4d3d;margin-top:8px"></div>
  </div>
  <div id="ctrl-box" class="hidden" style="display:flex;flex-direction:column;gap:14px">
    <div class="card">
      <div class="label">ĐANG CHẠY (LIVE)</div>
      <div id="live-name" class="val live">---</div>
      <div class="label" style="margin-top:10px">KẾ TIẾP (NEXT)</div>
      <div id="next-name" class="val next">---</div>
    </div>
    <button class="btn-go" onclick="sendCmd('GO')">GO — CHẠY CUE</button>
    <div class="row">
      <button class="btn-sec" onclick="sendCmd('BACK')">← LÙI CUE</button>
      <button id="btn-blk" class="btn-blk" onclick="sendCmd('BLACK')">ĐEN MÀN</button>
    </div>
    <button class="btn-stp" onclick="sendCmd('STOP')">DỪNG TẤT CẢ</button>
    <div id="conn-status" class="status">Đã kết nối</div>
  </div>
<script>
  let ws=null, authed=false;
  const authBox=document.getElementById('auth-box');
  const ctrlBox=document.getElementById('ctrl-box');
  const pinInput=document.getElementById('pin-input');
  const authErr=document.getElementById('auth-err');
  document.getElementById('btn-connect').onclick=connect;
  function connect(){
    const pin=pinInput.value.trim();
    if(pin.length!==4){authErr.textContent='Vui lòng nhập đủ 4 số PIN';return;}
    authErr.textContent='Đang kết nối...';
    const proto=location.protocol==='https:'?'wss://':'ws://';
    ws=new WebSocket(proto+location.host);
    ws.onopen=()=>ws.send(JSON.stringify({type:'auth',pin}));
    ws.onmessage=(ev)=>{
      const msg=JSON.parse(ev.data);
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
    ws.onclose=()=>{
      if(authed){
        document.getElementById('conn-status').textContent='Mất kết nối — bấm tải lại trang';
      }
    };
  }
  function updateUi(st){
    if(!st)return;
    document.getElementById('live-name').textContent=st.liveName||'Chưa phát';
    document.getElementById('next-name').textContent=st.nextName||'Trống';
    document.getElementById('btn-blk').textContent=st.blackout?'BỎ ĐEN MÀN':'ĐEN MÀN';
  }
  function sendCmd(cmd){
    if(!ws||ws.readyState!==1)return;
    if(cmd==='STOP'&&!confirm('Xác nhận DỪNG TẤT CẢ?'))return;
    ws.send(JSON.stringify({type:'cmd',cmd}));
  }
</script>
</body>
</html>`;
}

/** Phát trạng thái show tới tất cả thiết bị remote đã xác thực */
function broadcastRemoteState() {
  if (!remoteWss) return;
  const payload = JSON.stringify({
    type: 'state',
    state: {
      liveName: remoteState.liveName,
      nextName: remoteState.nextName,
      blackout: remoteState.blackout
    }
  });
  let count = 0;
  remoteWss.clients.forEach((client) => {
    if (client.readyState === 1 && client._authed) {
      count++;
      client.send(payload);
    }
  });
  remoteState.clients = count;
}

/** Bật server điều khiển từ xa LAN */
function startRemoteServer(pin) {
  return new Promise((resolve) => {
    if (remoteHttpServer) {
      remoteState.pin = String(pin || remoteState.pin).slice(0, 4).padStart(4, '0');
      saveSettings({ remotePin: remoteState.pin });
      resolve({ ...remoteState });
      return;
    }

    const cleanPin = String(pin || loadSettings().remotePin || '1234').replace(/\D/g, '').slice(0, 4).padStart(4, '0');
    saveSettings({ remotePin: cleanPin });

    const server = http.createServer((req, res) => {
      if (req.url === '/' || req.url.startsWith('/?')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildRemoteMobileHtml());
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    const wss = new WebSocketServer({ server });
    wss.on('connection', (socket) => {
      socket._authed = false;
      socket.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'auth') {
            if (String(msg.pin) === remoteState.pin) {
              socket._authed = true;
              socket.send(JSON.stringify({
                type: 'auth-ok',
                state: {
                  liveName: remoteState.liveName,
                  nextName: remoteState.nextName,
                  blackout: remoteState.blackout
                }
              }));
              broadcastRemoteState();
            } else {
              socket.send(JSON.stringify({ type: 'auth-fail' }));
            }
            return;
          }
          if (!socket._authed) return;
          if (msg.type === 'cmd' && ['GO', 'BACK', 'BLACK', 'STOP'].includes(msg.cmd)) {
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

  ipcMain.on('renderer-error', (_event, payload) => {
    logError('renderer', JSON.stringify(payload));
  });

  ipcMain.on('show-running-state', (_event, running) => {
    isShowRunning = Boolean(running);
  });

  ipcMain.on('remote:broadcastState', (_event, st) => {
    if (st && typeof st === 'object') {
      remoteState.liveName = st.liveName || 'Chưa phát';
      remoteState.nextName = st.nextName || 'Trống';
      remoteState.blackout = Boolean(st.blackout);
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
    app.exit(ok ? 0 : 1);
  }, 3500);
}

app.whenReady().then(() => {
  // Cho phép thu tín hiệu âm thanh Line-In / Soundcard / Mixer phục vụ dò beat DJ
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'media' || permission === 'audioCapture';
  });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'audioCapture');
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
  stopRemoteServer();
  app.quit();
});
