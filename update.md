Bạn là senior Node.js backend developer. Hãy nâng cấp project TikTok CAPI server hiện tại của tôi.

## Bối cảnh project hiện tại

Project hiện tại là Node.js + Express, đang deploy trên Ubuntu Droplet, chạy bằng PM2, reverse proxy bằng Nginx.

Repo hiện tại có cấu trúc đại khái:

```txt
Capiserver/
├── src/
│   └── server.js
├── package.json
├── .env.example
├── ecosystem.config.cjs
└── README.md
```

Server hiện tại đã làm được:

1. Nhận GET/POST ở `/` và `/track`
2. Kiểm tra `server_key`
3. Lấy các field từ query/body:

   * `access_token`
   * `pixel_code`
   * `external_id`
   * `email`
   * `phone_number`
   * `url`
   * `ip`
   * `user_agent`
   * `event_id`
   * `value`
4. Hash SHA-256 cho `external_id`, `email`, `phone_number` nếu chưa hash
5. Gửi TikTok Events API endpoint:

```txt
https://business-api.tiktok.com/open_api/v1.3/event/track/
```

6. Payload TikTok hiện dùng format Events API v1.3 / Events 2.0:

```json
{
  "event_source": "web",
  "event_source_id": "PIXEL_CODE",
  "data": [
    {
      "event": "CompleteRegistration",
      "event_time": 1234567890,
      "event_id": "EVENT_ID",
      "user": {
        "external_id": "...",
        "email": "...",
        "phone_number": "...",
        "ip": "...",
        "user_agent": "..."
      },
      "page": {
        "url": "https://quickpayly.com"
      },
      "properties": {
        "currency": "USD",
        "value": 3
      }
    }
  ],
  "test_event_code": "TEST15954"
}
```

7. `.env` hiện có các biến:

```env
PORT=3000
NODE_ENV=production
TIKTOK_ENDPOINT=https://business-api.tiktok.com/open_api/v1.3/event/track/
REQUIRE_SERVER_KEY=true
SERVER_KEY=...
ALLOWED_ORIGINS=
DEFAULT_EVENT=CompleteRegistration
DEFAULT_CURRENCY=USD
DEFAULT_TEST_EVENT_CODE=TEST15954
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=300
```

8. `access_token` và `pixel_code` vẫn giữ nguyên cách hiện tại: truyền động qua URL/body, không lưu cố định trong `.env`.

## Yêu cầu nâng cấp mới

Khách hàng không thể luôn truyền trực tiếp `email` và `phone_number` trong URL chạy CAPI. Họ muốn server lưu tạm thông tin từ Prelander theo `click_id`.

Flow mới cần hỗ trợ:

```txt
1. User vào Prelander
2. Prelander gửi click_id + email/phone/external_id sang server
3. Server lưu tạm dữ liệu này trong khoảng 2–3 tiếng
4. Sau đó khi có tín hiệu ra tiền/conversion thật, hệ thống khách gọi CAPI chỉ kèm click_id
5. Server lookup click_id trong cache/DB
6. Nếu tìm thấy email/phone/external_id đã lưu thì gắn vào TikTok payload
7. Server gửi event sang TikTok CAPI
8. Sau khi hết hạn 2–3 tiếng thì dữ liệu tự hết hiệu lực/xoá
```

## Yêu cầu kỹ thuật

Hãy dùng SQLite cho temporary storage.

Lý do:

* Traffic thấp, khoảng vài chục request/ngày
* Không cần MongoDB/PostgreSQL
* Dữ liệu chỉ lưu tạm 2–3 tiếng
* Dễ deploy trên Droplet hiện tại
* Không mất cache khi PM2 restart

Cần thêm dependency SQLite phù hợp cho Node.js. Có thể dùng `better-sqlite3` hoặc package SQLite ổn định khác. Nếu chọn `better-sqlite3`, hãy cập nhật `package.json`.

## Database

Tạo file DB tại:

```txt
data/capi-cache.db
```

Nếu thư mục `data/` chưa có thì tự tạo.

Tạo bảng:

```sql
CREATE TABLE IF NOT EXISTS lead_cache (
  click_id TEXT PRIMARY KEY,
  email_hash TEXT,
  phone_hash TEXT,
  external_id_hash TEXT,
  page_url TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
```

Yêu cầu:

* `click_id` là unique key.
* Nếu `/capture` nhận lại cùng một `click_id` thì update/ghi đè dữ liệu mới.
* Mỗi lần update thì reset `expires_at = now + TTL`.
* TTL mặc định 3 tiếng.
* Cho cấu hình qua `.env`:

```env
LEAD_CACHE_TTL_SECONDS=10800
LEAD_CACHE_DB_PATH=./data/capi-cache.db
```

## Endpoint mới: `/capture`

Thêm endpoint:

```txt
GET  /capture
POST /capture
```

Mục đích: Prelander gọi endpoint này để lưu data tạm.

Input hỗ trợ query hoặc body:

```txt
server_key
click_id
email
phone_number
external_id
url
ip
user_agent
```

Field bắt buộc:

```txt
server_key
click_id
```

Field optional:

```txt
email
phone_number
external_id
url
ip
user_agent
```

Nhưng ít nhất nên có một trong các field sau thì mới hữu ích:

```txt
email
phone_number
external_id
```

Xử lý:

1. Kiểm tra `server_key` như các endpoint hiện tại.
2. Lấy `click_id`, trim khoảng trắng.
3. Nếu thiếu `click_id` thì trả 400.
4. Normalize/hash:

   * Nếu `email` chưa phải SHA-256 hex thì lowercase rồi hash SHA-256.
   * Nếu `phone_number` chưa phải SHA-256 hex thì xoá khoảng trắng/dấu `()-.`, rồi hash SHA-256.
   * Nếu `external_id` chưa phải SHA-256 hex thì lowercase rồi hash SHA-256.
   * Nếu đã là SHA-256 hex 64 ký tự thì giữ nguyên, đổi về lowercase.
5. Lưu vào SQLite theo `click_id`.
6. Nếu `click_id` đã tồn tại thì update/ghi đè.
7. Trả response:

```json
{
  "success": true,
  "message": "Lead cache saved",
  "click_id": "abc123",
  "expires_in_seconds": 10800,
  "expires_at": 1234567890,
  "stored_fields": {
    "email": true,
    "phone_number": true,
    "external_id": false
  }
}
```

Không bao giờ trả raw email/phone trong response.

## Endpoint hiện tại `/` và `/track`

Cần nâng cấp để hỗ trợ thêm `click_id`.

Input hiện tại vẫn giữ nguyên:

```txt
server_key
access_token
pixel_code
external_id
email
phone_number
url
ip
user_agent
event_id
value
test_event_code
timestamp
```

Bổ sung:

```txt
click_id
```

Logic mới:

1. Nếu request có truyền trực tiếp `email`, `phone_number`, `external_id` thì vẫn xử lý như hiện tại.
2. Nếu có `click_id`, server lookup SQLite:

   * Chỉ lấy record nếu `expires_at > now`.
   * Nếu record hết hạn thì xoá record đó.
3. Merge dữ liệu:

   * Dữ liệu truyền trực tiếp trên request được ưu tiên hơn dữ liệu trong cache.
   * Nếu request thiếu `email`, lấy `email_hash` từ cache.
   * Nếu request thiếu `phone_number`, lấy `phone_hash` từ cache.
   * Nếu request thiếu `external_id`, lấy `external_id_hash` từ cache.
   * Nếu request thiếu `ip`, lấy `ip` từ cache nếu có.
   * Nếu request thiếu `user_agent`, lấy `user_agent` từ cache nếu có.
   * Nếu request thiếu `url`, lấy `page_url` từ cache nếu có.
4. Vẫn gửi TikTok CAPI kể cả khi không tìm thấy `click_id`, vì các field email/phone là optional.
5. Nhưng response cần có thông tin debug an toàn:

```json
{
  "success": true,
  "pixel_code": "D8...",
  "access_token": "28ed***cf86",
  "click_id": "abc123",
  "enriched": true,
  "enrichment_source": "cache",
  "enrichment_warning": null,
  "result": {
    "http_status": 200,
    "ok": true,
    "tiktok": {
      "code": 0,
      "message": "OK"
    }
  }
}
```

Nếu không tìm thấy hoặc hết hạn:

```json
{
  "success": true,
  "click_id": "abc123",
  "enriched": false,
  "enrichment_warning": "click_id not found or expired",
  "result": {
    "tiktok": {
      "code": 0,
      "message": "OK"
    }
  }
}
```

## Cleanup cache

Cần có cleanup dữ liệu hết hạn:

1. Khi server start, xoá record hết hạn.
2. Định kỳ mỗi 10 phút xoá record hết hạn.
3. Có thể cấu hình interval bằng `.env`:

```env
LEAD_CACHE_CLEANUP_INTERVAL_SECONDS=600
```

## Endpoint quản trị/debug an toàn

Thêm endpoint health vẫn giữ:

```txt
GET /health
```

Có thể bổ sung thêm:

```txt
GET /cache/stats
```

Yêu cầu:

* Bắt buộc `server_key`.
* Trả thống kê, không trả email/phone:

```json
{
  "success": true,
  "total_records": 10,
  "active_records": 8,
  "expired_records": 2,
  "ttl_seconds": 10800
}
```

Không cần endpoint list data chi tiết để tránh lộ dữ liệu.

## Bảo mật

Yêu cầu rất quan trọng:

1. Không log raw `access_token`, `server_key`, `email`, `phone_number`, `external_id`.
2. Log URL phải mask các param nhạy cảm:

   * `access_token`
   * `server_key`
   * `key`
   * `sk`
   * `email`
   * `phone_number`
   * `external_id`
3. Không trả raw email/phone trong response.
4. Nên lưu hash, không lưu raw email/phone.
5. Giữ `server_key` bắt buộc nếu `REQUIRE_SERVER_KEY=true`.
6. Giữ rate limit.
7. Sửa cấu hình Express trust proxy:

   * Không dùng `app.set('trust proxy', true)`
   * Dùng `app.set('trust proxy', 1)` vì app chạy sau Nginx.
8. Nginx access log đã tắt, không cần thay đổi.

## Backward compatibility

Cần đảm bảo các URL cũ vẫn chạy:

```txt
https://api.lendoraai.site/?server_key=...&access_token=...&pixel_code=...&external_id=...&email=...&phone_number=...&url=...&ip=...&user_agent=...&event_id=...&value=...
```

Và URL mới cũng chạy:

```txt
https://api.lendoraai.site/capture?server_key=...&click_id=CLICK123&email=email@gmail.com&phone_number=8900343434
```

Sau đó:

```txt
https://api.lendoraai.site/?server_key=...&access_token=...&pixel_code=...&click_id=CLICK123&url=quickpayly.com&ip=1.1.1.1&user_agent=chrome&event_id=12345&value=3
```

## README cần cập nhật

Cập nhật README với các phần:

1. Cách cài dependency
2. Cấu hình `.env`
3. Mô tả flow `/capture` và `/track`
4. Ví dụ GET `/capture`
5. Ví dụ POST `/capture`
6. Ví dụ gọi CAPI bằng `click_id`
7. Lưu ý dữ liệu chỉ lưu tạm 3 tiếng
8. Lệnh deploy/update trên server:

```bash
cd /var/www/Capiserver
git pull
npm install --omit=dev
pm2 restart tiktok-capi-server
pm2 logs tiktok-capi-server --lines 100
```

## Test cases cần đảm bảo

Hãy tự kiểm tra bằng curl:

### 1. Health

```bash
curl https://api.lendoraai.site/health
```

### 2. Capture bằng GET

```bash
curl "https://api.lendoraai.site/capture?server_key=SERVER_KEY&click_id=CLICK123&email=email@gmail.com&phone_number=8900343434&external_id=123123&url=quickpayly.com&ip=1.1.1.1&user_agent=chrome"
```

Expected: `success: true`

### 3. Track bằng click_id

```bash
curl "https://api.lendoraai.site/?server_key=SERVER_KEY&access_token=ACCESS_TOKEN&pixel_code=PIXEL_CODE&click_id=CLICK123&event_id=EVT123&value=3"
```

Expected:

* TikTok response `code: 0`
* `enriched: true`

### 4. Track click_id không tồn tại

```bash
curl "https://api.lendoraai.site/?server_key=SERVER_KEY&access_token=ACCESS_TOKEN&pixel_code=PIXEL_CODE&click_id=NOT_FOUND&event_id=EVT124&value=3"
```

Expected:

* Vẫn gửi TikTok nếu các field optional thiếu
* `enriched: false`
* Có `enrichment_warning`

### 5. Capture trùng click_id

Gửi `/capture` hai lần cùng `click_id`, dữ liệu mới phải ghi đè dữ liệu cũ và reset TTL.

### 6. Sai server_key

Expected: HTTP 401.

## Output mong muốn

Hãy trả về:

1. Danh sách file cần sửa/thêm.
2. Code hoàn chỉnh cho từng file.
3. Lệnh npm install nếu có dependency mới.
4. Lệnh deploy trên server.
5. Lệnh curl test đầy đủ.

Không viết giải thích lan man. Tập trung vào code production-ready
