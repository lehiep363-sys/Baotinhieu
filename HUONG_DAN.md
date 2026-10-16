# Hướng dẫn dựng bot Telegram báo tín hiệu Điểm 2

Bot này tự động quét tín hiệu Điểm 2 (RSI retest MA9) mỗi 5 phút trên GitHub
miễn phí, và nhắn tin Telegram cho bạn khi có tín hiệu mới — kể cả khi bạn
không mở app Crypto Chart.

**Bạn cần chuẩn bị:** điện thoại có Telegram, một tài khoản GitHub (miễn phí).

---

## Bước 1 — Tạo bot Telegram (khoảng 3 phút)

1. Mở Telegram, tìm **`@BotFather`** (có tick xanh) và nhắn `/start`.
2. Nhắn `/newbot`, đặt tên hiển thị (ví dụ `Bao Tin Hieu Diem 2`), rồi đặt
   username (phải kết thúc bằng `bot`, ví dụ `diem2_signal_bot`).
3. BotFather trả về một **token** dạng `123456789:AAH...` — **giữ kín token này**.
4. Tìm bot vừa tạo theo username, nhắn `/start` cho nó (bắt buộc — Telegram
   không cho bot nhắn trước nếu bạn chưa từng nhắn cho nó).
5. Nhắn cho bot một tin bất kỳ (ví dụ `hi`), rồi mở trình duyệt vào địa chỉ:
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   (thay `<TOKEN>` bằng token ở bước 3). Trong nội dung trả về, tìm dòng
   `"chat":{"id": 123456789` — con số đó chính là **chat_id** của bạn.

## Bước 2 — Tạo repo GitHub và đẩy 3 file lên (khoảng 3 phút)

1. Vào [github.com](https://github.com), bấm **New repository**.
2. Đặt tên ví dụ `telegram-signal-bot`. **Nên chọn Public** — GitHub cho repo
   public 2.000 phút Actions/tháng miễn phí (repo private chỉ 500 phút).
   Không tick gì thêm, bấm **Create repository**.
3. Trong repo mới, bấm **Add file → Upload files**, kéo thả 3 file sau lên:
   - `signal-bot.js`
   - `.github/workflows/signal-scan.yml` (giữ đúng cấu trúc thư mục `.github/workflows/`)
   - `HUONG_DAN.md` (file này, tùy chọn)
   
   Không cần upload `state.json` — bot sẽ tự tạo ở lần chạy đầu.
4. Bấm **Commit changes**.

## Bước 3 — Thêm Secrets (khoảng 2 phút)

1. Trong repo, vào **Settings → Secrets and variables → Actions**.
2. Bấm **New repository secret**, thêm 2 secrets:
   - Tên `TELEGRAM_BOT_TOKEN`, giá trị là token ở Bước 1.
   - Tên `TELEGRAM_CHAT_ID`, giá trị là chat_id ở Bước 1.
3. (Tùy chọn) Nếu muốn đổi coin/khung giờ quét khác mặc định
   (`NEARUSDT,OPUSDT,ARBUSDT,CAKEUSDT,ETHFIUSDT` và `15m,1h,4h`),
   vào tab **Variables** thêm `SYMBOLS` (ví dụ `BTCUSDT,ETHUSDT`)
   và `TIMEFRAMES` (ví dụ `15m,1h`).

## Bước 4 — Chạy thử

1. Vào tab **Actions** của repo, chọn workflow **"Quét tín hiệu Điểm 2"**
   ở cột trái, bấm **Run workflow → Run workflow**.
2. Đợi 1–2 phút, bấm vào lần chạy vừa xong xem log. Nếu thấy dòng
   `🏁 Xong:` nghĩa là bot chạy tốt.
3. Lưu ý: bot **chỉ nhắn khi có tín hiệu mới**, nên lần chạy thử có thể
   không có tin nhắn nào — đó là bình thường. Muốn chắc bot nhắn được,
   bạn có thể tạm nhắn test bằng cách mở bot Telegram của mình.

Từ giờ, cứ mỗi 5 phút GitHub sẽ tự chạy một lần. Khi có tín hiệu Điểm 2 mới,
bạn nhận được tin nhắn dạng:

> 🟢 LONG NEARUSDT · 15m
> Trigger A — RSI đóng trên MA9
> Giá: 5.263 · Nến 10:15 16/10

Mỗi tín hiệu chỉ báo **một lần** (bot nhớ nến đã báo trong `state.json`).

---

## ⚠️ Bảo mật — đọc kỹ

- **KHÔNG BAO GIỜ** gửi token bot cho bất kỳ ai, kể cả qua chat với AI.
  Token chỉ nằm trong **Secrets** của repo, không dán vào code, không chụp
  màn hình khoe.
- Nếu lỡ lộ token: nhắn `@BotFather` → `/revoke` → chọn bot để cấp token mới,
  rồi cập nhật lại Secret.

## Hạn chế cần biết

- Quét mỗi 5 phút nên tín hiệu có thể **trễ vài phút** so với lúc nến đóng.
- Khung **1m quá nhanh** so với nhịp quét — bot này không phù hợp để bắt
  tín hiệu 1m chính xác từng giây.
- Lịch chạy của GitHub là best-effort, đôi khi trễ hơn 5 phút.
- Nếu repo **không có hoạt động nào trong 60 ngày**, GitHub sẽ tạm dừng
  workflow — vào tab Actions bấm bật lại là xong.
- Binance đôi khi chặn theo vùng: bot đã có cơ chế tự đổi sang mirror
  `data-api.binance.vision` khi `api.binance.com` lỗi.
