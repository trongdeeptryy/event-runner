# DECISIONS.md — Nhật ký các quyết định kỹ thuật tự đưa ra

Tài liệu này ghi nhận các quyết định thiết kế đã tự chọn theo **Mục 12 (Quy tắc tự quyết)** trong `EVENT_RUNNER_SPEC.md`.

---

## 1. Quyết định kỹ thuật cốt lõi (MVP)

1. **Tắt `sandbox` ở `webPreferences` nhưng giữ nguyên `contextIsolation: true` và `nodeIntegration: false` (`main.js`):**
   - Trong Electron 33, `sandbox: true` là mặc định, khiến `preload.js` không thể gọi `require('path')` và `require('url').pathToFileURL`.
   - Đặt `sandbox: false` kết hợp `contextIsolation: true` và `nodeIntegration: false` giúp `preload.js` dùng trực tiếp `url.pathToFileURL` đồng bộ (xử lý chuẩn dấu cách, tiếng Việt, `#`, `%` mà không tốn vòng gọi IPC khi bấm GO), đồng thời renderer vẫn hoàn toàn bị cô lập khỏi Node.js.
2. **Bật `webSecurity: false` kèm Content-Security-Policy chặn mạng (`connect-src 'none'`):**
   - Ứng dụng chạy 100% offline với file media local (`file://`). `webSecurity: false` đảm bảo Web Audio `createMediaElementSource` + `AnalyserNode` và `decodeAudioData` hoạt động trơn tru trên mọi ổ đĩa Windows mà không bị chặn chính sách CORS `file://`, trong khi thẻ `<meta http-equiv="Content-Security-Policy">` vẫn khóa mọi kết nối ra ngoài mạng.
3. **Cấu hình đóng gói Windows Portable (`signAndEditExecutable: false`):**
   - Để `electron-builder` đóng gói file `.exe` portable mượt trên Windows thông thường mà không yêu cầu quyền Administrator tạo symbolic link cho gói `winCodeSign`, thiết lập `win.signAndEditExecutable: false` trong `package.json`.
4. **Hộp thoại lưu preset FX riêng không dùng `window.prompt()`:**
   - Chromium trong Electron không hỗ trợ `window.prompt()` đồng bộ. Khi bấm `+ Lưu preset riêng`, hệ thống tự sinh tên preset theo số thứ tự + tên cue (`Preset N (Tên cue)`) và lưu ngay vào dự án, tránh lỗi runtime.
5. **Tạo icon bằng script Node thuần (PNG 256×256 + ICO):**
   - Thay vì tải ảnh hay cài thư viện xử lý ảnh ngoài, tạo sẵn `assets/icon.png` và `assets/icon.ico` nhúng trực tiếp để đảm bảo 100% offline và không phụ thuộc thêm gói npm.
6. **Làm mượt RMS 6 block (~16 ms) trong `createOnsetDetector` (`src/shared/logic.js`):**
   - Tính RMS trực tiếp trên từng block 128 mẫu (2.67 ms) sẽ tạo gợn sóng pha ở sóng sin thuần 60–80 Hz; làm mượt bình phương biên độ qua 6 block (~16 ms, >1 chu kỳ bass) giúp sóng sin 80 Hz cho đúng `0` beat mà vẫn bắt nhạy đầu cú kick cách nhau 90–120 ms.
7. **Dung sai lượng tử hóa block cho `minIntervalMs`:**
   - Do block 128 mẫu ở 48 kHz dài ~2.67 ms, hai cú kick cách nhau đúng 90 ms (33.75 block) có thể lệch xuống 88 ms ở một số nhịp; trừ dung sai `0.95 * blockMs` khi so sánh giúp không bị rớt nhịp ở biên độ 90 ms.

---

## 2. Trạng thái triển khai các tính năng bổ sung (Mục 9)

| STT | Tính năng | Trạng thái | Ghi chú kỹ thuật |
|---|---|---|---|
| 1 | Chữ trên LED theo cue | **Đã làm** | Hỗ trợ bật/tắt, nhiều dòng, cỡ chữ, vị trí (trên/giữa/dưới), màu chữ, khung nền mờ, cập nhật live khi đang chạy. |
| 2 | Loop video mượt | **Đã làm** | Dùng 2 thẻ `<video>` mờ chéo ~0.4s khi `duration >= 1.2s`; tự chuyển về `video.loop` gốc nếu clip ngắn hơn 1.2s để không bị lặp chồng. |
| 3 | Tự chuyển cue (auto-follow) | **Đã làm** | Hỗ trợ 3 chế độ: Thủ công / Sau X giây / Khi nhạc kết thúc. |
| 4 | Nhiều lớp nhạc (nhạc nền + SFX) | **Đã làm** | 4 nút SFX bấm nhanh (hỗ trợ `Numpad 1–4`), có thanh âm lượng SFX riêng và đi nhánh riêng sau `AnalyserNode` để không làm nhiễu dò beat của nhạc nền. |
| 5 | Điểm cắt nhạc (`startAt`/`endAt`) + Waveform | **Đã làm** | Giải mã sóng âm bằng `decodeAudioData` (cache tối đa 20 file, giới hạn file <= 120MB), click chuột trái đặt `startAt`, chuột phải đặt `endAt`. |
| 6 | Đồng hồ đếm ngược | **Đã làm** | Hiện `-mm:ss` ở khung `ĐANG CHẠY`, nhấp nháy đỏ khi còn dưới 10 giây. |
| 7 | Gói dự án (Collect files) | **Đã làm** | Sao chép toàn bộ nhạc/hình/SFX vào thư mục `<tên-dự-án>_media/` cạnh file `.json` và tự chuyển đường dẫn sang dạng tương đối `./...` (xử lý trùng tên file). |
| 8 | Chế độ tập dượt (Rehearsal) | **Đã làm** | Bật lên sẽ không gửi lệnh hình ra màn hình LED và tự giảm âm lượng phát còn 35%. |
| 9 | Undo / Redo (`Ctrl+Z` / `Ctrl+Y`) | **Đã làm** | Lưu tối đa 50 bước lịch sử danh sách cue; tự khóa khi bật `CHẾ ĐỘ SHOW`. |
| 10 | Nhật ký show (Log) | **Đã làm** | Ghi thời gian thực mỗi lần `GO` và `PANIC` vào `userData/logs/show.log`, xem trực tiếp trong mục Công cụ hoặc mở thư mục log. |
| 11 | Kiểm tra trước giờ G (Pre-flight check) | **Đã làm** | Quét toàn bộ cue tìm file mất, đuôi rủi ro codec (`.mov/.avi/.mkv/...`), lỗi giải mã, LED chưa mở, âm lượng = 0%. |
| 12 | Điều khiển từ xa LAN (Wi-Fi) | **Đã làm** | Server HTTP + WebSocket (`ws`) tích hợp trong `main.js`, mặc định **TẮT**, bảo vệ bằng mã PIN 4 số, phục vụ giao diện mobile offline chỉ nhận `GO / BACK / BLACK / STOP`. |
| 13 | Phím điều khiển ngoài / MIDI / Numpad | **Đã làm** | Hỗ trợ Web MIDI API với chế độ "Học phím MIDI" cho `GO / ĐEN MÀN / DỪNG TẤT CẢ`, kèm phím tắt `NumpadEnter`, `Numpad0`, `NumpadDecimal`, `Numpad 1–4`. |
| 14 | Thư viện preset FX của người dùng | **Đã làm** | Cho phép lưu thêm bộ thông số FX riêng vào file dự án JSON (`customFxPresets`). |
| 15 | Chuyển cảnh trượt (`slide`) & mở rộng | **Đã làm** | Ngoài `cut`, `fade`, `black`, đã bổ sung `slide-left`, `slide-right`, và `zoom`. |
