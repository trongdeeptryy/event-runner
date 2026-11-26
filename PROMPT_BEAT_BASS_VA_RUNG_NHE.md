# PROMPT CHO GEMINI — Nâng cấp "bắt bass beat" + "rung nhẹ ngẫu nhiên" (Event Runner)

> **Cách dùng:** copy TOÀN BỘ nội dung file này dán vào Gemini, rồi dán **toàn bộ mã nguồn hiện tại** của phần mềm xuống dưới dòng `=== MÃ NGUỒN HIỆN TẠI ===` ở cuối file. Gemini sẽ tự làm hết, không cần hỏi lại.

---

## VAI TRÒ

Bạn là kỹ sư Electron + xử lý tín hiệu âm thanh (DSP) với Web Audio API, chuyên làm phần mềm show control cho sự kiện, ưu tiên **độ chính xác về thời gian** và **chuyển động nhìn tự nhiên**.

## QUY TẮC BẮT BUỘC (đọc trước)

1. **Chỉ dựa trên mã nguồn tôi dán ở cuối.** Nếu không thấy một hàm/biến/file nào, ghi `[KHÔNG THẤY: tên]` rồi tạo mới. **KHÔNG được bịa** rằng nó đã tồn tại.
2. **KHÔNG hỏi lại tôi.** Chỗ nào chưa rõ thì tự chọn phương án ổn định nhất và ghi 1 dòng giải thích.
3. **GIỮ NGUYÊN mọi tính năng đang có** (danh sách cue, SFX, chữ trên LED, cắt đoạn nhạc, tự chuyển cue, khung hình, lưu/mở dự án…). Chỉ sửa/thêm những gì nêu dưới đây.
4. Đây là **phần mềm desktop Electron chạy offline** — KHÔNG thêm thư viện ngoài, KHÔNG CDN, KHÔNG gọi mạng.
5. Trả về **file ĐẦY ĐỦ** (copy-paste chạy được), không viết "phần còn lại giữ nguyên". **Comment bằng tiếng Việt.**
6. Dự án đã lưu từ trước **PHẢI mở được bình thường** (trường mới thiếu thì dùng giá trị mặc định).

## BỐI CẢNH (mang theo)

- App có 2 cửa sổ: **bảng điều khiển** (phát nhạc bằng Web Audio, có spectrum + đèn BEAT) và **cửa sổ LED** (hiển thị ảnh/video, nhận lệnh qua IPC, chạy hiệu ứng "nảy theo beat").
- Giao diện hiện có tab **"Hiệu ứng Beat (FX)"** với các thanh trượt (phóng to, rung, xoay, sáng, đổi màu, chớp, thời gian tắt…) và preset.
- **Vấn đề 1:** bộ dò beat hiện tại chỉ nảy theo **độ to chung của nhạc (khung/envelope)**, không bám từng cú **bass/kick**. Nhạc dùng để chạy show là **remix bass rất căng và nhanh** (kick dày, có thể 140–175 BPM, có nốt 1/8–1/16 cách nhau ~90–200 ms) nên bị trễ, dính, hoặc bỏ sót nhịp.
- **Vấn đề 2:** hình **đứng im hoàn toàn rồi mới giật** khi có beat → nhìn cứng, không đẹp. Cần có **rung nhẹ ngẫu nhiên liên tục** làm nền, beat nảy **chồng lên** trên nền rung đó.

---

## NHIỆM VỤ 1 — BỘ DÒ BASS BEAT CHÍNH XÁC

### 1.1 Đồ thị âm thanh (Web Audio)

```
nguồn nhạc → gain từng bài → master ─┬─► DelayNode (bù trễ) ─► destination (loa)
                                     └─► [NHÁNH PHÂN TÍCH] highpass(bassLow) ─► lowpass(bassHigh) ─► AudioWorkletNode "bass-onset"
```

- Nhánh phân tích **lấy trước DelayNode**, nên beat được phát hiện **sớm hơn** âm thanh nghe thấy một đoạn `bù trễ` → hình nảy **đúng lúc** với tiếng (bù cho thời gian phân tích + IPC + vẽ hình).
- `DelayNode` chỉ làm trễ **đường ra loa**; `maxDelayTime = 0.3`. Mặc định **50 ms**, thanh trượt **0–200 ms** (nhãn: "Bù trễ nhạc (ms) — tăng nếu hình nảy chậm hơn tiếng, giảm nếu nảy sớm hơn").
- Lọc dải bass bằng **2 bộ biquad nối tiếp mỗi loại** (dốc ~24 dB/oct), Q ≈ 0.7. Mặc định dải **35–150 Hz**; cho người dùng chỉnh `bassLow` (20–80 Hz) và `bassHigh` (80–250 Hz).

### 1.2 Thuật toán onset (chạy trong `AudioWorkletProcessor`, mỗi block 128 mẫu ≈ 2.7 ms)

1. Tính `rms[n]` của block đã lọc bass.
2. **Hàm onset (half-wave rectified):** `O[n] = max(0, ln(1 + 200·rms[n]) − ln(1 + 200·rms[n−4]))` (so với ~11 ms trước → bắt **đầu cú đánh**, không bám theo độ to nền).
3. **Ngưỡng thích nghi trên cửa sổ trượt ~1 giây** (≈ 370 block): `T[n] = mean(O) + k·std(O) + floor`, với `k = 3.2 − 0.25·độNhạy` (độ nhạy 1–10, mặc định 6) và `floor = 0.015`. Nhờ thích nghi nên **đổi bài to/nhỏ không phải chỉnh lại**.
4. **Chọn đỉnh (peak picking):** phát beat khi `O[n−1] > T` **và** `O[n−1] ≥ O[n−2]` **và** `O[n−1] ≥ O[n]` (cực đại cục bộ, trễ 1 block ≈ 3 ms) **và** cách beat trước ≥ `khoảngTốiThiểu` (mặc định **100 ms**, thanh trượt 60–300 ms).
5. **Cường độ** `k_beat = clamp((O − T) / (maxO_1s − T + ε), 0.35, 1)`.
6. Worklet gửi `port.postMessage({k, t: currentTime})` **ngay khi phát hiện** — luồng chính gọi IPC sang LED **ngay lập tức**, KHÔNG chờ `requestAnimationFrame`.
7. Tách lõi thuật toán thành **hàm thuần** `createOnsetDetector(params)` (nhận từng block, trả `null` hoặc `{k}`) dùng chung cho worklet (nhúng bằng `Function.prototype.toString()` vào chuỗi mã worklet) **và** cho test.
8. Nạp worklet bằng **Blob URL** (`URL.createObjectURL(new Blob([code]))`) để chạy ổn khi mở từ `file://`. **Dự phòng:** nếu `audioWorklet` lỗi thì dùng `AnalyserNode` (`fftSize 512`, đọc mỗi khung) chạy **cùng thuật toán** trên dải bass.

### 1.3 Giao diện (thêm vào tab "Hiệu ứng Beat (FX)", mục **"Phân tích bass"**)

- Thanh trượt: **Độ nhạy** (1–10), **Khoảng tối thiểu giữa 2 beat (ms)**, **Dải bass thấp/cao (Hz)**, **Bù trễ nhạc (ms)**.
- Nút preset 1 chạm:
  - **Remix bass nhanh:** độ nhạy 7, khoảng 90 ms, dải 35–140 Hz
  - **EDM / House:** độ nhạy 6, khoảng 150 ms, dải 40–150 Hz
  - **Nhạc chậm / ballad:** độ nhạy 5, khoảng 250 ms, dải 40–200 Hz
- **Biểu đồ phân tích bass** (canvas nhỏ, cuộn 4 giây gần nhất): đường `O` (xanh lơ), đường ngưỡng `T` (nét đứt, vàng), **vạch đỏ** mỗi beat đã phát hiện. Kỹ thuật viên nhìn là biết bộ dò có bám đúng kick hay không.
- Đèn **BEAT** nhấp nháy theo từng beat + số **beat/giây** hiện cạnh đèn.
- Nguồn nhịp: giữ lựa chọn cũ "Tự dò" / "Theo BPM"; chế độ "Tự dò" dùng bộ dò mới này.

---

## NHIỆM VỤ 2 — RUNG NHẸ NGẪU NHIÊN LIÊN TỤC (idle shake)

### 2.1 Cấu trúc để hai chuyển động không ghi đè nhau

```
#idle (rung nền, điều khiển bằng requestAnimationFrame)
 └─ #stage (hiệu ứng beat, dùng element.animate như hiện tại)
     └─ các lớp ảnh/video
```

Rung nền chỉ đổi `transform` của `#idle`; beat chạy trên `#stage` → **cộng dồn tự nhiên**, hình không bao giờ đứng im khi hiệu ứng đang bật.

### 2.2 Thông số (lưu theo từng cue trong `cue.fx`, có giá trị mặc định cho dự án cũ)

| Trường | Khoảng | Mặc định | Ý nghĩa |
|---|---|---|---|
| `idleOn` | bật/tắt | `true` khi `fx.on` | Bật rung nền |
| `idleAmp` | 0–20 px | 3 | Biên độ rung ngang/dọc |
| `idleRot` | 0–2 ° | 0.25 | Xoay rất nhẹ |
| `idleBreath` | 0–3 % | 0.4 | "Thở" phóng/thu nhẹ |
| `idleSpeed` | 0.2–8 Hz | 3 | Tốc độ rung |
| `idleStyle` | `smooth` / `jitter` | `smooth` | `smooth`: nhiễu mượt (tổng 3 sóng sin tần số vô tỉ mỗi trục). `jitter`: mỗi 40–90 ms chọn điểm đích ngẫu nhiên rồi nội suy nhanh (cảm giác cầm máy quay) |
| `idleCouple` | 0–1.5 | 0.6 | Rung **mạnh lên theo độ căng của bass** (cường độ lấy từ envelope nhánh phân tích, gửi sang LED ~30 lần/giây) |
| `idleOnlyMusic` | bật/tắt | `true` | Chỉ rung khi đang có nhạc; khi nhạc dừng thì giảm dần về 0 trong 600 ms |

- **Xung theo beat:** mỗi beat cộng thêm một "xung" làm biên độ rung nền tăng thêm `+0.8·k_beat` rồi **tắt dần trong ~250 ms** → nhịp bass nghe và nhìn dính nhau mà vẫn mượt.
- **Chống lộ viền đen:** công thức phóng nền hiện có phải tính cả rung nền: `base = 1 + 2.4·(shake + idleAmp·(1 + idleCouple + 0.8)) / min(W,H) + 0.03·(rot + idleRot) + idleBreath/100`. Có công tắc **"Chống lộ viền khi rung"** như cũ.
- Chỉ dùng `transform` (KHÔNG dùng `filter`, `top/left`) cho rung nền để chạy mượt 60 fps ở 1080p và 4K; thêm `will-change: transform` cho `#idle`.

### 2.3 Giao diện (mục **"Rung nhẹ liên tục"** trong tab "Hiệu ứng Beat (FX)")

- Công tắc bật/tắt, thanh trượt cho từng thông số ở bảng trên, ô chọn kiểu (`Mượt` / `Giật nhẹ kiểu cầm máy`).
- Nút **"▶ Thử rung nền trên LED"** để xem khi chưa phát nhạc.
- Thêm giá trị rung nền vào **4 preset hiện có** (Nảy nhẹ, Giật mạnh, Chớp, Glitch) cho hợp phong cách. Thêm preset **"Remix bass"**: `scale 5, shake 14, rot 1.2, bright 35, decay 140, step false, idleAmp 4, idleRot 0.35, idleSpeed 4, idleCouple 0.9`.
- Chỉnh khi cue đang LIVE thì thấy đổi ngay trên LED.

---

## NHIỆM VỤ 3 — CHUYỂN ĐỘNG BEAT TỰ NHIÊN HƠN

1. **Hướng giật không lặp:** chọn góc ngẫu nhiên nhưng cách góc beat trước **≥ 60°**, tránh giật cùng một hướng liên tục.
2. **Không chồng animation khi beat dồn dập:** `decay hiệu dụng = min(decay, max(60 ms, 0.9 × khoảng cách tới beat trước))`; trước khi chạy beat mới thì hủy animation beat cũ.
3. Thêm lựa chọn kiểu chuyển động **"Lò xo"** (nảy quá đà rồi về): keyframes `[đỉnh 0%, vượt −25% ở 35%, nghỉ 100%]` với `easing: cubic-bezier(.2,1.6,.4,1)`; giữ nguyên hai kiểu cũ "mượt" và "giật nấc".

---

## RÀNG BUỘC KỸ THUẬT

- Không đổi cấu trúc IPC đã có; **chỉ thêm** lệnh mới (ví dụ `level` cho cường độ bass, `idle` cho cấu hình rung nền).
- Không để rò bộ nhớ: khi đổi/dừng nhạc phải `disconnect()` nhánh phân tích cũ, đóng `port` của worklet.
- Chạy 4–6 tiếng liên tục không tăng bộ nhớ bất thường; không gây giật khi LED ở 4K.
- Giữ `backgroundThrottling: false` cho cả hai cửa sổ.
- Mọi lỗi (worklet không nạp được…) phải báo bằng thông báo tiếng Việt và **tự chuyển sang phương án dự phòng**, không làm sập app.

---

## TIÊU CHÍ NGHIỆM THU (mỗi mục phải trả lời ĐẠT / CHƯA + lý do)

1. Test `node:test` cho `createOnsetDetector`: tín hiệu giả gồm **8 cú kick 60 Hz tắt dần, cách nhau 120 ms, chồng nhiễu nền** → phát hiện **≥ 7/8** cú và **≤ 1** beat sai.
2. Cùng test nhưng 8 cú cách nhau **90 ms** (đúng `khoảng tối thiểu` preset "Remix bass nhanh") → vẫn **≥ 6/8** cú.
3. Tín hiệu **nhạc to đều, không có kick** (sóng sin 80 Hz biên độ không đổi) → **0 beat**.
4. Đổi âm lượng bài lên/xuống 12 dB giữa chừng → số beat phát hiện **không đổi quá ±15%** (nhờ ngưỡng thích nghi).
5. Nhánh phân tích lấy **trước** `DelayNode`; thanh trượt bù trễ 0–200 ms có tác dụng.
6. Bật rung nền, **không phát nhạc**, bấm "Thử rung nền" → hình rung nhẹ liên tục, **không lộ viền đen** ở mọi kiểu khung hình.
7. Bật cả rung nền lẫn beat → hai chuyển động **cộng dồn**, không cái nào làm dừng cái kia.
8. Mở dự án cũ (không có trường `idle*`, `bassLow`…) → mở bình thường, dùng giá trị mặc định.
9. Mọi tính năng cũ vẫn hoạt động (không có hồi quy).

---

## ĐỊNH DẠNG TRẢ LỜI (BẮT BUỘC, theo đúng thứ tự)

1. **Tóm tắt thay đổi** — tối đa 8 dòng gạch đầu dòng.
2. **Từng file đã sửa/thêm** — mỗi file một mục `### tên_file` kèm **một khối code đầy đủ**.
3. **Bảng nghiệm thu** — 9 dòng, cột: `Tiêu chí | ĐẠT/CHƯA | Lý do`.
4. **Lưu ý khi chạy thử** — tối đa 5 dòng (ví dụ cách chỉnh bù trễ cho khớp tiếng).

Ví dụ khuôn mục 2:

````
### control.js
```js
// ... toàn bộ nội dung file ...
```
````

---

=== MÃ NGUỒN HIỆN TẠI (dán toàn bộ mã nguồn của bạn xuống dưới dòng này) ===
