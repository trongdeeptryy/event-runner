# EVENT RUNNER — Đặc tả phần mềm chạy sự kiện (Nhạc + Màn LED trong một cue)

> **Đây là PHẦN MỀM DESKTOP (ứng dụng Electron chạy trên Windows), KHÔNG PHẢI website.**
> Không làm landing page, không làm web server để người dùng truy cập, không deploy lên hosting.

---

## 0. LỜI NHẮC DÀNH CHO AI CODER (đọc trước, bắt buộc tuân thủ)

1. **Làm tự động từ đầu đến cuối, KHÔNG hỏi lại người dùng.** Mọi chỗ chưa rõ: tự chọn phương án hợp lý nhất theo mục 12 ("Quy tắc tự quyết"), ghi lại quyết định vào `DECISIONS.md`, rồi làm tiếp.
2. **Giao sản phẩm chạy được**, không giao khung rỗng. Kết thúc phải có: mã nguồn đầy đủ, `npm install` + `npm start` chạy được, và `npm run build` ra file `.exe` portable.
3. **Code hoàn chỉnh, copy-paste chạy được**, không để `// TODO`, không viết "phần còn lại tương tự".
4. **Comment trong code và giao diện đều bằng tiếng Việt.**
5. **Chạy hoàn toàn offline.** Không CDN, không gọi API ngoài, không font tải từ mạng (dùng font hệ thống: `Bahnschrift`, `Segoe UI`).
6. Ưu tiên số 1 của người dùng: **cắm màn LED (HDMI) vào là chạy được ngay**, và **giao diện trực quan, technical nhìn là hiểu, dễ bấm khi đang chạy show**.
7. Tự kiểm tra theo mục 13 trước khi báo hoàn thành.

---

## 1. BỐI CẢNH & MỤC TIÊU

Người dùng là kỹ thuật viên chạy sự kiện (khai mạc, văn nghệ, bốc thăm, hội nghị…).

**Hiện trạng:** cần 2 người — 1 người bấm màn LED, 1 người bấm nhạc. Hai người bấm lệch nhau nên độ mượt không đồng đều, nhạc và hình không ăn khớp.

**Mục tiêu:** một phần mềm duy nhất, **1 lần bấm GO = nhạc và hình LED chạy cùng lúc**, chuyển cảnh mượt, một người vận hành là đủ.

Tham chiếu tinh thần: QLab / các phần mềm "show control", nhưng đơn giản, tiếng Việt, tối ưu cho sự kiện nhỏ-vừa tại Việt Nam.

---

## 2. CÔNG NGHỆ (cố định, không đổi)

| Hạng mục | Lựa chọn |
|---|---|
| Nền tảng | **Electron** (bản ổn định mới, ví dụ ^33), chạy Windows 10/11 |
| Ngôn ngữ | JavaScript thuần (Node.js + HTML/CSS/JS). Không bắt buộc framework; nếu dùng thì chỉ dùng thứ bundle offline được |
| Âm thanh | **Web Audio API** (`AudioContext`, `GainNode`, `AnalyserNode`) + `HTMLAudioElement` |
| Hình | `<img>` / `<video>` trong cửa sổ LED, hiệu ứng bằng **Web Animations API** (`element.animate`) |
| Lưu trữ | File JSON (chương trình) + `userData` của Electron (autosave, settings) |
| Đóng gói | `electron-builder`, target `portable` cho Windows |

Bắt buộc dùng `contextIsolation: true`, giao tiếp qua `preload.js` + `contextBridge`. Không bật `nodeIntegration` ở renderer.

---

## 3. CẤU TRÚC THƯ MỤC

```
event-runner/
├─ package.json
├─ main.js            # Tiến trình chính: tạo cửa sổ, nhận màn hình, IPC, hộp thoại file
├─ preload.js         # Cầu nối an toàn (contextBridge) -> window.api
├─ control.html       # Bảng điều khiển (người vận hành dùng)
├─ output.html        # Cửa sổ LED (toàn màn hình trên màn HDMI)
├─ src/               # (tùy chọn) tách JS/CSS ra file riêng cho dễ bảo trì
├─ tests/             # Test logic thuần (node:test)
├─ README.md          # Hướng dẫn cài đặt/chạy/build bằng tiếng Việt
└─ DECISIONS.md       # Nhật ký các quyết định tự đưa ra
```

---

## 4. KIẾN TRÚC

```
┌──────────────── Electron ────────────────┐
│  main.js (Node)                          │
│   ├─ Cửa sổ ĐIỀU KHIỂN (control.html)    │  ← người vận hành bấm ở đây
│   │    • Danh sách cue, nút GO           │
│   │    • ENGINE ÂM THANH (phát nhạc)     │
│   │    • Dò beat (AnalyserNode)          │
│   └─ Cửa sổ LED (output.html)            │  ← toàn màn hình trên màn HDMI
│        • Hiển thị ảnh/video              │
│        • Chuyển cảnh + hiệu ứng beat     │
└──────────────────────────────────────────┘
 control --IPC('out', lệnh)--> main --webContents.send('cmd')--> output
```

**Lý do nhạc phát ở cửa sổ điều khiển:** để vẽ VU/spectrum, dò beat và hiển thị thời gian ngay tại chỗ. Khi bấm GO, bảng điều khiển **gửi lệnh hình sang LED trước rồi `play()` nhạc ngay sau** trong cùng một tick → độ lệch chỉ vài ms.

**Bắt buộc:**
- Cả hai cửa sổ: `webPreferences.backgroundThrottling = false` (nếu không, cửa sổ không focus sẽ bị trình duyệt giảm tốc → giật).
- `app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')`.
- `powerSaveBlocker.start('prevent-display-sleep')` — không cho máy tắt màn hình/ngủ giữa show.
- Cửa sổ điều khiển hỏi xác nhận trước khi đóng ("Đang chạy chương trình — thoát thật không?").

---

## 5. MÔ HÌNH DỮ LIỆU (một cue)

```json
{
  "id": "uuid",
  "name": "Khai mạc",
  "note": "Ghi chú cho người vận hành (không hiện lên LED)",

  "aud": "C:/show/nhac-khai-mac.mp3",
  "vol": 100,
  "fadeIn": 1.0,
  "fadeOut": 1.5,
  "stop": false,

  "vis": "C:/show/bg-khai-mac.mp4",
  "tr": "fade",
  "dur": 0.8,
  "fit": "contain",
  "loop": true,
  "vsound": false,

  "fx": {
    "on": true, "src": "auto", "bpm": 120, "off": 0, "sens": 5,
    "scale": 6, "shake": 12, "rot": 1.5, "bright": 40, "hue": 0,
    "flash": 0, "decay": 220, "step": true, "over": true
  }
}
```

| Trường | Ý nghĩa |
|---|---|
| `aud` | File nhạc (null = cue không có nhạc, **nhạc đang phát được giữ nguyên**) |
| `vol` | Âm lượng 0–100 |
| `fadeIn` | Nhạc mới vào dần trong N giây |
| `fadeOut` | Nhạc **cũ** tắt dần trong N giây khi cue này bắt đầu (crossfade) |
| `stop` | Cue không có nhạc nhưng muốn tắt nhạc cũ |
| `vis` | Ảnh hoặc video lên LED (null = giữ hình cũ) |
| `tr` | Chuyển cảnh: `cut` (cắt), `fade` (mờ chéo), `black` (qua đen) |
| `dur` | Thời gian chuyển cảnh (giây) |
| `fit` | `contain` (thấy đủ hình) / `cover` (tràn màn, có thể cắt mép) |
| `loop` | Lặp video |
| `vsound` | Bật tiếng gốc của video (mặc định tắt) |
| `fx` | Hiệu ứng giật theo beat — xem mục 7.4 |

File dự án: `{ "version": 1, "cues": [ ... ] }`.

---

## 6. MÀN LED — YÊU CẦU "CẮM VÀO LÀ CHẠY"

Đây là yêu cầu quan trọng nhất.

1. **Tự nhận màn hình:** dùng `screen.getAllDisplays()`. Khi khởi động, nếu có màn phụ → tự mở cửa sổ LED toàn màn hình trên màn phụ (ưu tiên màn đã dùng lần trước, lưu trong `settings.json`).
2. **Cắm nóng:** lắng nghe `display-added` → nếu đang bật "Tự mở khi cắm LED" và LED chưa mở → đợi ~1.5 giây (cho Windows ổn định) rồi tự mở. `display-removed` → nếu màn đang dùng bị rút thì đóng cửa sổ LED và báo trên giao diện. `display-metrics-changed` → cập nhật danh sách.
3. **Cửa sổ LED:** không viền, `fullscreen: true`, `alwaysOnTop` mức `'screen-saver'`, `focusable: false` (bấm chuột vào không cướp focus của bảng điều khiển), ẩn con trỏ chuột, nền đen `#000`, hiện bằng `showInactive()`.
4. **Chỉ có 1 màn hình** (đang test ở nhà): KHÔNG phủ kín màn chính (sẽ che mất bảng điều khiển). Mở **cửa sổ thử 960×540 có viền** và hiện cảnh báo "Chưa thấy màn LED".
5. **Chọn màn thủ công:** ô chọn danh sách màn hình + nút "Mở LED / Đóng LED".
6. **Màn thử (phím T):** hiện thanh màu SMPTE, lưới 10%, dải xám, và chữ "LED OK ✔ — độ phân giải W × H". Dùng để kỹ thuật kiểm tra LED nhận đủ hình, đúng tỉ lệ, không lệch mép.
7. **Tự hồi phục:** nếu cửa sổ LED crash (`render-process-gone`) → tự mở lại sau 0.5s; khi LED báo `ready`, bảng điều khiển **gửi lại hình đang chạy (chuyển cảnh `cut`) + trạng thái đen màn**.
8. Đèn trạng thái trên header: 🟢 LED đang mở (hiện tên màn + độ phân giải) / 🔴 chưa mở.

---

## 7. TÍNH NĂNG BẮT BUỘC (MVP)

### 7.1 Danh sách cue
- Thêm cue trống; thêm **hàng loạt** ảnh/video (mỗi file = 1 cue, tên lấy từ tên file).
- Mỗi hàng hiển thị: số thứ tự, thumbnail (ảnh hoặc khung đầu của video), tên cue, tên file nhạc, tên file hình, trạng thái (`ĐANG CHẠY` đỏ / `KẾ TIẾP` hổ phách), nút ▶ chạy riêng cue đó.
- Sắp xếp (↑ ↓ và **kéo thả**), nhân đôi, xóa (có xác nhận).
- **Cảnh báo ⚠ "mất file"** nếu đường dẫn media không còn tồn tại (kiểm tra bằng `fs.existsSync` khi mở dự án và định kỳ).
- Chọn cue ≠ chạy cue. Chỉ **GO** mới chạy.

### 7.2 GO — chạy nhạc + hình cùng lúc
- Nút **GO** rất lớn (phím **Space**) chạy cue đang chọn rồi tự chọn cue kế tiếp.
- Thứ tự trong 1 tick: (1) gửi lệnh `show` sang LED, (2) bắt đầu nhạc.
- **Nạp sẵn (preload):** ngay khi chọn cue kế tiếp, nạp sẵn ảnh (`decode()`) / video (`preload=auto`) bên LED và nạp sẵn file nhạc bên điều khiển → bấm GO là lên **ngay**, không khựng, không nháy đen.
- Bấm GO dồn dập không được làm hỏng hình: dọn các lớp cũ, chỉ giữ lớp trên cùng.

### 7.3 Engine âm thanh
- `AudioContext` → mỗi bài có `GainNode` riêng → `master` gain → `AnalyserNode` → `destination`.
- **Crossfade:** khi cue mới có nhạc: nhạc cũ giảm về 0 trong `fadeOut` giây rồi dừng và giải phóng; nhạc mới tăng từ 0 lên `vol` trong `fadeIn` giây. Dùng `linearRampToValueAtTime`, nhớ `cancelScheduledValues` + `setValueAtTime(giá trị hiện tại)` trước khi ramp.
- Cue không có nhạc: giữ nhạc đang phát (mặc định); nếu `stop=true` thì tắt dần nhạc cũ.
- Thanh **âm lượng tổng (master)**, thanh tiến trình, thời gian `đã phát / tổng`, tên bài đang phát.
- **Chọn thiết bị phát âm thanh** (`AudioContext.setSinkId`, bọc try/catch) — để chọn loa/HDMI/card âm thanh riêng.
- Hiển thị **spectrum** (~48 cột) và đèn **BEAT** nhấp nháy khi dò được beat.

### 7.4 Hiệu ứng giật theo beat (người dùng tự set / tự custom)
Áp lên **ảnh lẫn video**, thực hiện bên cửa sổ LED bằng `stage.animate([đỉnh, nghỉ], {duration: decay, easing})`.

**Nguồn beat (`fx.src`):**
- `auto` — dò bass bằng `AnalyserNode` (`fftSize 2048`, `smoothingTimeConstant 0.3`), lấy trung bình dải 40–160 Hz; so với trung bình trượt ~45 khung gần nhất. Là beat khi `năng lượng > trung bình × (1.6 − sens × 0.05)` **và** `năng lượng > 70` **và** cách beat trước > 200 ms. Cường độ `k = clamp(0.4 + (năng lượng − tb)/100, 0, 1)`.
- `bpm` — theo nhịp cố định: `t = audio.currentTime − off + 0.04` (0.04s bù trễ IPC); phát beat mỗi khi `floor(t / (60/bpm))` tăng lên. Có ô `BPM`, ô `Offset (giây)` và nút **TAP tempo** (trung bình các khoảng bấm gần nhất, bỏ qua khoảng > 2 giây).

**Thông số tùy chỉnh (thanh trượt, hiện giá trị trực tiếp):**

| Thông số | Khoảng | Tác dụng |
|---|---|---|
| `scale` | 0–25 % | Phóng to khi nảy |
| `shake` | 0–60 px | Rung ngẫu nhiên ngang/dọc |
| `rot` | 0–8 ° | Xoay ngẫu nhiên |
| `bright` | 0–150 % | Tăng sáng |
| `hue` | 0–120 ° | Đổi màu thoáng qua |
| `flash` | 0–90 % | Chớp trắng toàn màn |
| `decay` | 60–800 ms | Thời gian trở về trạng thái nghỉ |
| `sens` | 1–10 | Độ nhạy khi dò beat tự động |
| `step` | bật/tắt | Chuyển động **giật nấc** (`steps(3, end)`) thay vì mượt (`ease-out`) |
| `over` | bật/tắt | Phóng nền nhẹ để **không lộ viền đen** khi rung/xoay (`1 + shake×2.4/min(W,H) + rot×0.03`) |

**Preset 1 chạm** (chỉ điền sẵn thông số, người dùng vẫn chỉnh tiếp): *Nảy nhẹ*, *Giật mạnh*, *Chớp*, *Glitch*.

**Chỉnh trực tiếp khi đang chạy:** sửa thông số của cue đang LIVE → gửi `fx` sang LED ngay, thấy kết quả liền.
**Nút "Thử beat trên LED":** bật/tắt phát beat đều theo BPM của cue để căn chỉnh khi chưa có nhạc.

### 7.5 Hình trên LED
- **Ảnh tĩnh** và **video** (mp4/webm). Video có `loop`, mặc định **tắt tiếng**.
- **Chuyển cảnh:** `cut`, `fade` (hình mới hiện dần **đè lên** hình cũ — không bị tụt sáng giữa chừng), `black` (cũ tối dần rồi mới sáng dần).
- Video không loop: dừng ở khung cuối.

### 7.6 Nút an toàn (panic)
| Nút | Phím | Việc làm |
|---|---|---|
| **ĐEN MÀN** (bật/tắt) | `B` | Phủ đen LED mờ dần 0.4s; nhạc vẫn chạy |
| **TẮT NHẠC** | `F` | Nhạc tắt dần 2s |
| **DỪNG TẤT CẢ** | `Esc` | Dừng nhạc 0.3s + xóa hình + bỏ đen màn |
| **Màn thử LED** | `T` | Bật/tắt màn thử |

### 7.7 Lưu / mở / tự lưu
- **Autosave** vào `userData/autosave.json` sau mỗi thay đổi; mở app là nạp lại lần cuối.
- Nút **Lưu / Mở** file `.json` (Ctrl+S, Ctrl+O).

---

## 8. GIAO DIỆN BẢNG ĐIỀU KHIỂN

Phong cách **"phòng điều khiển"**: nền tối, chữ rõ, nút lớn, màu có nghĩa. Dùng font hệ thống (`Bahnschrift`, `Segoe UI`), số thời gian dùng font đơn cách (`Consolas`).

**Màu trạng thái (cố định ý nghĩa):**
- Đỏ `#ff4d3d` = **ĐANG CHẠY (LIVE)**
- Hổ phách `#ffb020` = **KẾ TIẾP (NEXT)**
- Xanh lá `#2ee59d` = **ổn / LED đã kết nối**
- Xanh lơ `#4cc9f0` = **hiệu ứng beat (FX)**
- Nền `#0e1217`, panel `#171c23`, viền `#2a323d`, chữ `#dde5ee`, chữ phụ `#7d8a99`

```
┌─────────────────────────────────────────────────────────────────────────┐
│ EVENT RUNNER   ● LED: Màn 2 — 1920×1080 [Mở/Đóng] ☑Tự mở  Thiết bị âm   │
│                thanh [▼]                                   🕒 19:42:10  │
├───────────────────────────────┬─────────────────────────────────────────┤
│ [+Cue] [+Nhiều ảnh/video]     │  ┌── ĐANG CHẠY ──┐ ┌── KẾ TIẾP ──┐      │
│ [Lưu] [Mở]                    │  │  (hình LED)   │ │  (hình)     │      │
│ ┌──────────────────────────┐  │  └───────────────┘ └─────────────┘      │
│ │1 [▣] Khai mạc   ♪ ▶      │  │  ┌─────────────────────────────────┐    │
│ │2 [▣] Đại biểu ▶ ĐANG CHẠY│  │  │          G O   (Space)          │    │
│ │3 [▣] Văn nghệ ▶ KẾ TIẾP  │  │  └─────────────────────────────────┘    │
│ │4 [▣] Bốc thăm   ⚠ mất file│ │  [ĐEN MÀN B] [TẮT NHẠC F] [DỪNG Esc]    │
│ │ ...                       │  │  ♪ Tên bài   02:13 / 04:05 ▓▓▓▓░░░     │
│ └──────────────────────────┘  │  ▁▃▅▇▆▄▂▁ spectrum   (●) BEAT   Vol ──○ │
│                               │  ── Chỉnh cue đang chọn ──────────────  │
│                               │  Nhạc / Hình / Chuyển cảnh / FX beat    │
└───────────────────────────────┴─────────────────────────────────────────┘
```

**Yêu cầu giao diện:**
- Nút GO to nhất màn hình, bấm trúng dễ dù đang vội.
- Hàng cue đang chạy / kế tiếp phải nổi bật nhìn từ xa.
- Hai khung xem trước **ĐANG CHẠY** và **KẾ TIẾP**.
- Tất cả nút nguy hiểm có màu riêng và nằm tách xa nút GO.
- **Chế độ SHOW (khóa soạn):** bật lên thì ẩn khung chỉnh sửa, không cho xóa/kéo thả/sửa cue → tránh lỡ tay giữa chương trình.
- Phím tắt: `Space` GO · `↑ ↓` chọn cue · `B` đen màn · `F` tắt nhạc · `Esc` dừng tất cả · `T` màn thử · `Ctrl+S` lưu · `Ctrl+O` mở. Không kích hoạt phím tắt khi đang gõ trong ô nhập. Sau khi bấm nút chuột phải `blur()` để phím Space không bấm lại nút cũ.
- Hộp thoại xác nhận cho thao tác xóa / thoát.

---

## 9. TÍNH NĂNG BỔ SUNG (làm sau MVP nếu còn — thứ tự ưu tiên)

AI coder **tự thực hiện hết các mục dưới đây theo thứ tự, không cần hỏi**, sau khi MVP đã qua nghiệm thu mục 13. Mục nào quá rủi ro thì bỏ qua và ghi vào `DECISIONS.md`.

1. **Chữ trên LED theo cue** (tên đại biểu, tên tiết mục): ô nhập chữ, cỡ chữ, vị trí (trên/giữa/dưới), màu, hiện/ẩn mờ dần.
2. **Loop video mượt:** với video ≥ 2.5×thời gian chồng, dùng 2 phần tử `<video>` cùng nguồn, khi gần hết clip thì phát bản thứ hai và mờ chéo (~0.4s) để tránh khựng ở điểm lặp.
3. **Tự chuyển cue (auto-follow):** cue có thể "chạy tiếp sau X giây" hoặc "chạy tiếp khi nhạc kết thúc".
4. **Nhiều lớp nhạc:** nhạc nền + hiệu ứng âm thanh (SFX) bấm nhanh độc lập, mỗi lớp có thanh âm lượng riêng.
5. **Điểm bắt đầu / kết thúc nhạc** (`startAt`, `endAt`) và hiển thị **waveform** để chọn điểm cắt.
6. **Đồng hồ đếm ngược** thời lượng còn lại của cue/bài, đổi màu khi còn dưới 10 giây.
7. **Gói dự án (Collect files):** nút sao chép toàn bộ media vào một thư mục cạnh file dự án và đổi sang đường dẫn tương đối → mang sang máy khác không bị mất file.
8. **Chế độ tập dượt (rehearsal):** chạy toàn bộ không xuất ra LED (chỉ xem ở khung xem trước, nhạc phát nhỏ).
9. **Undo / Redo** (Ctrl+Z / Ctrl+Y) cho thao tác trên danh sách cue.
10. **Nhật ký show (log):** ghi giờ mỗi lần GO / panic ra file `.log` để xem lại sau sự kiện.
11. **Kiểm tra trước giờ G (Pre-flight check):** một nút quét toàn bộ cue — file mất, định dạng không phát được, LED chưa mở, âm lượng = 0 — rồi báo danh sách lỗi.
12. **Điều khiển từ xa qua mạng LAN** (điện thoại/máy tính bảng bấm GO / chọn cue): server WebSocket nhỏ trong `main.js`, mặc định **tắt**, bật bằng công tắc; yêu cầu mã PIN 4 số; chỉ nhận `GO / BACK / BLACK / STOP`.
13. **Phím điều khiển ngoài / MIDI / bàn phím số** gán cho GO, ĐEN, DỪNG.
14. **Thư viện preset FX** do người dùng lưu thêm preset riêng của họ.
15. **Chuyển cảnh trượt** (`slide`) và thêm vài kiểu chuyển cảnh khác.

---

## 10. RÀNG BUỘC KỸ THUẬT QUAN TRỌNG (dễ sai — chú ý)

- **Codec:** Electron/Chromium phát tốt **MP4 (H.264 + AAC)**, WebM (VP8/VP9), MP3, WAV, OGG, AAC/M4A, FLAC. **KHÔNG** phát được H.265/HEVC, ProRes, MOV một số codec. Khi phát lỗi (`error` event) → hiện cảnh báo rõ trên cue: "File này không phát được, hãy chuyển sang MP4 H.264".
- **Đường dẫn file → URL:** dùng `url.pathToFileURL(p).href` (xử lý đúng dấu cách, tiếng Việt, ký tự đặc biệt).
- **`createMediaElementSource`** chỉ gọi **một lần** cho mỗi phần tử `Audio`.
- Giải phóng bài nhạc cũ sau khi tắt dần (`pause()`, `src = ''`) để không rò bộ nhớ.
- **Bù trễ IPC** ~ vài chục ms cho chế độ BPM (đã cộng +0.04s); chế độ auto không thể dự đoán trước nên không bù.
- **Hiệu ứng `filter`** trên màn 4K có thể nặng — nếu tụt khung hình, tự giảm: bỏ `hue-rotate` trước, rồi `brightness`.
- **DPI / scale của Windows:** dùng `bounds` (đơn vị DIP) của `screen`, kiểm tra màn 125%/150% không bị lệch.
- Cửa sổ LED `focusable:false` + `alwaysOnTop('screen-saver')` để không bị thanh Taskbar/thông báo che.
- Cắm màn hình có thể đổi `display.id` → lưu thêm kích thước để đoán màn quen thuộc nếu `id` không còn.
- Mọi lệnh sang LED là `fire-and-forget`; LED phải chịu được lệnh đến sớm/muộn/trùng.

---

## 11. YÊU CẦU PHI CHỨC NĂNG

- **Ổn định hơn đẹp:** không crash, không memory leak khi chạy show 4–6 tiếng liên tục (cue ≥ 200).
- Độ trễ từ lúc bấm GO đến khi lên hình + nhạc: **< 100 ms** khi đã preload.
- Khởi động app < 3 giây; mở dự án 200 cue < 2 giây (thumbnail video nạp lười, `preload="metadata"`).
- Lỗi nào cũng phải có thông báo tiếng Việt dễ hiểu, không để màn trắng/treo.
- Bắt `uncaughtException` / `unhandledrejection` trong cả main và renderer: ghi log, không làm sập chương trình.

---

## 12. QUY TẮC TỰ QUYẾT (thay cho việc hỏi người dùng)

| Gặp tình huống | Làm gì |
|---|---|
| Spec không nói rõ | Chọn phương án đơn giản, ổn định, ít rủi ro nhất → ghi `DECISIONS.md` |
| Hai cách làm ngang nhau | Chọn cách ít phụ thuộc thư viện ngoài |
| Thư viện cần tải | Chỉ dùng gói npm đã bundle sẵn trong `node_modules`, **không CDN** |
| Tính năng ở mục 9 quá phức tạp/rủi ro | Bỏ qua, ghi lý do, **không** làm hỏng MVP |
| Nghi ngờ một thông số số học (ngưỡng beat, thời gian…) | Dùng giá trị trong tài liệu này; cho phép người dùng chỉnh trên giao diện |
| Xung đột giữa "đẹp" và "dễ bấm khi chạy show" | Chọn **dễ bấm, dễ nhìn** |

---

## 13. QUY TRÌNH TỰ ĐỘNG & NGHIỆM THU

### Các giai đoạn (làm tuần tự, tự chạy, không dừng chờ ý kiến)
1. **Khởi tạo:** `package.json`, `main.js`, `preload.js`, cửa sổ điều khiển + cửa sổ LED rỗng, IPC thông suốt.
2. **LED:** nhận màn hình, cắm/rút nóng, cửa sổ toàn màn hình, màn thử, tự hồi phục.
3. **Hình:** hiển thị ảnh/video, preload, 3 kiểu chuyển cảnh, loop.
4. **Nhạc:** engine Web Audio, crossfade, master, thiết bị phát, tiến trình, spectrum.
5. **GO đồng bộ:** gắn nhạc + hình vào một lần bấm, preload cue kế tiếp.
6. **Beat FX:** dò beat auto + BPM + TAP, thông số tùy chỉnh, preset, chỉnh trực tiếp, nút thử.
7. **Giao diện:** danh sách cue, thumbnail, khung ĐANG CHẠY/KẾ TIẾP, panic, phím tắt, chế độ SHOW.
8. **Lưu trữ:** autosave, lưu/mở, cảnh báo mất file.
9. **Mục 9:** thực hiện các tính năng bổ sung theo thứ tự ưu tiên.
10. **Đóng gói:** `npm run build` ra `.exe` portable; viết `README.md` tiếng Việt (cài đặt, cách nối LED, cách dùng, phím tắt, xử lý sự cố).

### Tự kiểm tra (chạy được trong môi trường code)
- `node --check` toàn bộ file JS; trích `<script>` trong HTML ra kiểm tra cú pháp.
- Viết test `node:test` cho **logic thuần** tách được: thuật toán dò beat (đưa mảng năng lượng giả → đúng số beat), tính BPM từ TAP, tính `base` scale chống lộ viền, chuyển đường dẫn → URL, validate/migrate file dự án.
- Chạy thử `npm start` (nếu có môi trường) và đảm bảo không có lỗi trong console của cả hai cửa sổ.

### Checklist nghiệm thu (tất cả phải ĐẠT)
- [ ] Mở app, cắm HDMI → LED tự lên toàn màn hình trên màn phụ.
- [ ] Rút HDMI → app không crash, có cảnh báo; cắm lại → tự mở lại.
- [ ] Chỉ 1 màn hình → mở cửa sổ thử, không che bảng điều khiển.
- [ ] Màn thử (T) hiện đúng thanh màu + độ phân giải.
- [ ] GO một cue có cả nhạc + hình → hai thứ bắt đầu cùng lúc, không khựng.
- [ ] Chuyển cue: nhạc cũ tắt dần, nhạc mới vào dần; hình mờ chéo không tụt sáng.
- [ ] Video loop hoạt động; ảnh tĩnh hoạt động; `fit` contain/cover đúng.
- [ ] Beat FX: dò auto bám theo trống; chế độ BPM đúng nhịp; TAP hoạt động; chỉnh thanh trượt thấy đổi ngay trên LED khi đang LIVE; "giật nấc" khác "mượt" rõ rệt; bật `over` không lộ viền đen.
- [ ] ĐEN MÀN / TẮT NHẠC / DỪNG TẤT CẢ hoạt động và phím tắt đúng.
- [ ] Bấm GO liên tục 10 lần nhanh không lỗi.
- [ ] Tắt LED giữa chừng rồi mở lại → hình đang chạy được khôi phục.
- [ ] Đóng/mở lại app → chương trình cũ còn nguyên (autosave); file media bị xóa → hiện ⚠.
- [ ] Chế độ SHOW khóa đúng các thao tác soạn.
- [ ] Chạy liên tục 2 tiếng không tăng bộ nhớ bất thường.
- [ ] `npm run build` ra được `.exe` portable chạy độc lập.

### Sản phẩm bàn giao
1. Toàn bộ mã nguồn (đủ file, copy chạy được).
2. `README.md` (tiếng Việt) và `DECISIONS.md`.
3. File `.exe` portable (hoặc lệnh build nếu môi trường không build được).
4. Danh sách ngắn: **đã làm / chưa làm / lý do** cho từng mục ở mục 9.

---

## 14. PROMPT NGẮN ĐỂ DÁN KÈM (copy nguyên đoạn này khi đưa file cho AI)

> Hãy đọc toàn bộ file `EVENT_RUNNER_SPEC.md` và xây dựng đúng **phần mềm desktop Electron** (không phải website) theo đặc tả. Làm tự động từ đầu đến cuối theo mục 13, **không hỏi lại tôi**; chỗ nào chưa rõ thì tự quyết theo mục 12 và ghi vào `DECISIONS.md`. Trả về mã nguồn đầy đủ từng file (copy-paste chạy được), comment tiếng Việt, kèm `README.md`. Làm xong MVP (mục 7) rồi tiếp tục các tính năng bổ sung ở mục 9 theo thứ tự ưu tiên. Cuối cùng tự đối chiếu checklist nghiệm thu và báo cáo mục nào đạt/chưa đạt.
