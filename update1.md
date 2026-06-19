Bạn là senior full-stack developer. Hãy nâng cấp hệ thống hiện tại gồm:

1. TikTok CAPI Server Node.js/Express.
2. Landing Page tĩnh dùng HTML + jQuery.

Mục tiêu: Khi user đăng ký trên Landing Page, hệ thống lưu tạm dữ liệu theo `vl_clickid`. Sau đó khi có tín hiệu conversion/ra tiền, endpoint TikTok CAPI được gọi với `vl_clickid`, server sẽ lookup DB tạm, lấy dữ liệu đã lưu, merge vào payload TikTok CAPI và gửi event sang TikTok.

## 1. Bối cảnh TikTok CAPI Server hiện tại

Project backend hiện là Node.js + Express, deploy trên Ubuntu Droplet, chạy bằng PM2, reverse proxy bằng Nginx.

Cấu trúc repo đại khái:

```txt
Capiserver/
├── src/
│   └── server.js
├── package.json
├── .env.example
├── ecosystem.config.cjs
└── README.md
```

Server hiện tại đã có:

```txt
GET  /health
GET  /
POST /
GET  /track
POST /track
```

Server hiện tại đã làm được:

```txt
1. Nhận request GET/POST.
2. Check server_key.
3. Nhận access_token và pixel_code từ URL/body.
4. Hash email / phone_number / external_id nếu chưa hash.
5. Gửi TikTok Events API endpoint:
   https://business-api.tiktok.com/open_api/v1.3/event/track/
6. Payload đang dùng format TikTok Events API v1.3 / Events 2.0:
   event_source, event_source_id, data array.
7. Event hardcode là CompleteRegistration.
8. Currency hardcode là USD.
9. Có DEFAULT_TEST_EVENT_CODE trong .env để test TikTok Events Manager.
```

`.env` hiện có dạng:

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

Yêu cầu giữ nguyên:

```txt
- access_token vẫn truyền động qua URL/body.
- pixel_code vẫn truyền động qua URL/body.
- Không lưu cố định access_token/pixel_code trong .env.
- Event mặc định: CompleteRegistration.
- Currency mặc định: USD.
- Vẫn giữ server_key.
- Vẫn giữ rate limit.
```

## 2. Bối cảnh Landing Page hiện tại

Landing Page là website tĩnh:

```txt
HTML + Tailwind CDN + jQuery + Slick Slider + AOS
```

Không phải React/Vue/Next.js/Laravel/WordPress.

File chính:

```txt
index.html
js/main.js
```

Form đăng ký:

```txt
form#apply_form
```

Email field hiện tại:

```txt
input#email_add
```

Phone field:

```txt
Hiện chưa có phone field trong form.
```

Submit flow hiện tại trong `js/main.js`:

```txt
1. $("#apply_form").on("submit", ...)
2. e.preventDefault()
3. Disable nút submit, đổi text Processing...
4. Lấy trackingUrl từ dtpCallback.l, fallback sang https://intencyfisionery.com/click
5. Append dữ liệu form vào finalUrl.searchParams
6. Copy toàn bộ query params hiện tại từ window.location.search sang finalUrl
7. Redirect ngay bằng location.href = finalUrl.toString()
```

Không có AJAX/fetch submit hiện tại. Không có backend riêng. Không thấy thank-you page.

## 3. Yêu cầu nghiệp vụ mới từ khách

Khách giải thích flow thực tế:

```txt
Không phải user submit form là bắn TikTok CAPI ngay.

Flow đúng:
1. User vào Landing Page / Prelander.
2. User đăng ký.
3. Landing Page lưu tạm dữ liệu gồm email, phone nếu có, ttclid, ttp, url, referrer theo vl_clickid.
4. Sau đó còn một bước xử lý phía sau.
5. Khi có tín hiệu ra tiền / conversion thật, hệ thống mới gọi TikTok CAPI.
6. Lúc gọi TikTok CAPI, request chỉ cần truyền vl_clickid.
7. Server dùng vl_clickid để lookup DB tạm.
8. Server lấy các dữ liệu đã lưu, merge vào payload TikTok CAPI.
9. Server gửi event CompleteRegistration sang TikTok.
```

Biến so khớp chính:

```txt
vl_clickid
```

Các field khách muốn lưu vào DB/cache từ Landing Page:

```txt
1. email
2. phone
3. ttclid
4. ttp
5. url
6. referrer
```

Nguồn lấy dữ liệu:

```txt
vl_clickid: lấy từ URL query param.
ttclid: lấy từ URL query param.
ttp: lấy từ cookies, ưu tiên cookie _ttp hoặc ttp.
url: window.location.href.
referrer: document.referrer.
email: lấy từ input#email_add.
phone: nếu landing page có field phone thì lấy; hiện tại chưa có phone field nên optional.
```

Payload TikTok khách mô tả dạng:

```json
{
  "event_source": "web",
  "event_source_id": null,
  "data": [
    {
      "event": "CompleteRegistration",
      "event_time": 1781859627,
      "user": {
        "email": null,
        "phone": null,
        "external_id": null,
        "ttclid": null,
        "ttp": null,
        "ip": null,
        "user_agent": null
      },
      "properties": {
        "currency": null,
        "value": null
      },
      "page": {
        "url": null,
        "referrer": null
      }
    }
  ]
}
```

Nhưng khi build payload thật, tuyệt đối không gửi field `null`, `undefined`, hoặc chuỗi rỗng. Field nào không có thì bỏ khỏi payload.

## 4. Nguyên tắc rất quan trọng: tất cả field enrichment đều optional

Tuyệt đối không require các field sau:

```txt
email
phone
phone_number
external_id
ttclid
ttp
url
referrer
ip
user_agent
event_id
value
```

### `/capture` chỉ require:

```txt
server_key
vl_clickid hoặc click_id
```

Còn lại optional hết:

```txt
email
phone
phone_number
external_id
ttclid
ttp
url
referrer
ip
user_agent
```

Nếu `/capture` chỉ có `vl_clickid` mà không có email/phone/ttclid/ttp/url/referrer thì vẫn cho lưu record.

### `/`, `/track` chỉ require:

```txt
server_key
access_token
pixel_code
```

Còn lại optional hết:

```txt
vl_clickid
click_id
email
phone
phone_number
external_id
ttclid
ttp
url
referrer
ip
user_agent
event_id
value
timestamp
test_event_code
```

Nếu có `vl_clickid` hoặc `click_id`, server lookup cache/DB. Nếu lookup thấy field nào thì merge field đó vào payload. Nếu lookup không thấy hoặc record hết hạn thì vẫn gửi TikTok CAPI với dữ liệu hiện có, response chỉ cần có warning.

Không được fail TikTok CAPI request chỉ vì thiếu email/phone/ttclid/ttp/url/referrer.

## 5. Yêu cầu DB/cache

Dùng SQLite temporary cache.

Lý do:

```txt
- Traffic thấp.
- Chỉ lưu tạm 2–3 tiếng.
- Không cần MongoDB/PostgreSQL.
- Chạy ngay trên Droplet hiện tại.
- Không mất cache khi PM2 restart.
```

Thêm dependency SQLite phù hợp, ưu tiên `better-sqlite3` nếu ổn.

File DB:

```txt
data/capi-cache.db
```

Nếu thư mục `data/` chưa có thì tự tạo.

Thêm `.env`:

```env
LEAD_CACHE_TTL_SECONDS=10800
LEAD_CACHE_DB_PATH=./data/capi-cache.db
LEAD_CACHE_CLEANUP_INTERVAL_SECONDS=600
```

TTL mặc định:

```txt
10800 giây = 3 tiếng
```

## 6. Database schema

Có thể tạo bảng mới hoặc migrate bảng cũ. Yêu cầu support đầy đủ các field sau.

Schema đề xuất:

```sql
CREATE TABLE IF NOT EXISTS lead_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vl_clickid TEXT UNIQUE,
  click_id TEXT,
  email_hash TEXT,
  phone_hash TEXT,
  external_id_hash TEXT,
  ttclid TEXT,
  ttp TEXT,
  page_url TEXT,
  referrer TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
```

Yêu cầu:

```txt
- vl_clickid là key ưu tiên.
- Support cả click_id cũ để backward compatible.
- Nếu có vl_clickid thì dùng vl_clickid làm key chính.
- Nếu không có vl_clickid nhưng có click_id thì dùng click_id.
- Nếu cùng vl_clickid gửi lại thì update/ghi đè record cũ và reset expires_at.
- Các field optional có thể lưu NULL.
- Email/phone/external_id nên lưu dạng hash, không lưu raw.
- ttclid, ttp, url, referrer có thể lưu raw vì đây là tracking metadata.
```

Nếu muốn ít thay đổi hơn, có thể dùng column `click_id` cũ làm internal key, nhưng input `vl_clickid` phải được map vào đó. Tuy nhiên response nên hiển thị lại `vl_clickid` nếu request dùng `vl_clickid`.

## 7. Endpoint `/capture`

Thêm hoặc nâng cấp endpoint:

```txt
GET  /capture
POST /capture
```

Mục đích: Landing Page gọi endpoint này lúc user submit form để lưu tạm data.

Input hỗ trợ cả query và body:

```txt
server_key
vl_clickid
click_id
email
phone
phone_number
external_id
ttclid
ttp
url
page_url
referrer
page_referrer
ip
user_agent
```

Mapping:

```txt
vl_clickid hoặc click_id: key so khớp.
phone hoặc phone_number: số điện thoại.
url hoặc page_url: URL hiện tại.
referrer hoặc page_referrer: referrer.
```

Ưu tiên:

```txt
vl_clickid > click_id
phone > phone_number nếu cả hai cùng có
url > page_url
referrer > page_referrer
```

Xử lý:

```txt
1. Check server_key.
2. Lấy match key = vl_clickid || click_id.
3. Nếu thiếu cả vl_clickid và click_id thì trả 400.
4. Các field khác optional.
5. Normalize/hash email, phone, external_id nếu có:
   - Nếu đã là SHA-256 hex 64 ký tự thì giữ nguyên lowercase.
   - Email: lowercase rồi SHA-256.
   - Phone: xoá khoảng trắng và ký tự ()-. rồi SHA-256.
   - external_id: lowercase rồi SHA-256.
6. Lưu ttclid, ttp, page_url, referrer, ip, user_agent nếu có.
7. Nếu record đã tồn tại thì update/ghi đè.
8. expires_at = now + LEAD_CACHE_TTL_SECONDS.
```

Response thành công:

```json
{
  "success": true,
  "message": "Lead cache saved",
  "vl_clickid": "abc123",
  "click_id": "abc123",
  "expires_in_seconds": 10800,
  "expires_at": 1781859627,
  "stored_fields": {
    "email": true,
    "phone": false,
    "external_id": false,
    "ttclid": true,
    "ttp": true,
    "url": true,
    "referrer": true,
    "ip": false,
    "user_agent": true
  }
}
```

Không trả raw email/phone trong response.

## 8. Endpoint `/` và `/track` gửi TikTok CAPI

Nâng cấp logic hiện tại.

Input vẫn support cũ:

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

Bổ sung support mới:

```txt
vl_clickid
click_id
phone
ttclid
ttp
referrer
page_url
page_referrer
```

Logic:

```txt
1. Check server_key.
2. Require access_token.
3. Require pixel_code.
4. Lấy match key = vl_clickid || click_id nếu có.
5. Nếu có match key thì lookup DB:
   - Chỉ lấy record nếu expires_at > now.
   - Nếu hết hạn thì xoá hoặc coi như not found.
6. Merge dữ liệu:
   - Field truyền trực tiếp trên request được ưu tiên hơn field từ cache.
   - Nếu request thiếu email thì lấy email_hash từ cache.
   - Nếu request thiếu phone/phone_number thì lấy phone_hash từ cache.
   - Nếu request thiếu external_id thì lấy external_id_hash từ cache.
   - Nếu request thiếu ttclid thì lấy ttclid từ cache.
   - Nếu request thiếu ttp thì lấy ttp từ cache.
   - Nếu request thiếu url/page_url thì lấy page_url từ cache.
   - Nếu request thiếu referrer/page_referrer thì lấy referrer từ cache.
   - Nếu request thiếu ip thì lấy ip từ cache hoặc request IP.
   - Nếu request thiếu user_agent thì lấy user_agent từ cache hoặc header user-agent.
7. Gửi TikTok CAPI dù không enrich được.
8. Response cần báo enriched true/false.
```

## 9. Quy tắc build TikTok payload

Payload gửi TikTok phải dùng format:

```json
{
  "event_source": "web",
  "event_source_id": "PIXEL_CODE",
  "data": [
    {
      "event": "CompleteRegistration",
      "event_time": 1781859627,
      "event_id": "EVENT_ID_IF_HAVE",
      "user": {
        "email": "HASH_IF_HAVE",
        "phone": "HASH_IF_HAVE",
        "phone_number": "HASH_IF_NEEDED",
        "external_id": "HASH_IF_HAVE",
        "ttclid": "TTCLID_IF_HAVE",
        "ttp": "TTP_IF_HAVE",
        "ip": "IP_IF_HAVE",
        "user_agent": "USER_AGENT_IF_HAVE"
      },
      "properties": {
        "currency": "USD",
        "value": 3
      },
      "page": {
        "url": "URL_IF_HAVE",
        "referrer": "REFERRER_IF_HAVE"
      }
    }
  ],
  "test_event_code": "TEST15954_IF_CONFIGURED_OR_PASSED"
}
```

Quan trọng:

```txt
- event_source_id = pixel_code.
- event = DEFAULT_EVENT.
- currency = DEFAULT_CURRENCY.
- event_time = timestamp nếu có, không có thì current unix seconds.
- value optional; nếu có thì parse number nếu được.
- event_id optional.
- page optional; chỉ tạo page object nếu có url hoặc referrer.
- user optional nhưng nên tạo nếu có ít nhất một user field.
- Không gửi field null/undefined/empty string.
```

Về field phone:

```txt
Khách mô tả user.phone.
Server cũ có phone_number.
Để backward compatible, support input phone và phone_number.
Khi gửi TikTok, nếu đang dùng chuẩn cũ trong code là phone_number thì giữ phone_number. Nếu muốn thêm phone theo payload khách, có thể set cả phone và phone_number cùng hash, nhưng ưu tiên không phá format hiện tại. Hãy comment rõ lựa chọn trong code.
```

## 10. CORS cho Landing Page

Vì Landing Page là browser frontend gọi sang:

```txt
https://api.lendoraai.site/capture
```

Cần CORS nếu dùng fetch POST JSON.

Landing domain hiện tại theo phân tích là:

```txt
https://assetshall.net
```

Cần thêm CORS middleware hoặc xử lý OPTIONS.

`.env` nên dùng:

```env
ALLOWED_ORIGINS=https://assetshall.net,https://www.assetshall.net
```

Yêu cầu:

```txt
- Nếu ALLOWED_ORIGINS rỗng thì cho phép mọi origin hoặc không restrict.
- Nếu có ALLOWED_ORIGINS thì chỉ allow các origin đó.
- Support OPTIONS preflight cho /capture.
- Không làm hỏng request server-to-server hoặc curl không có Origin.
```

Nếu muốn tránh preflight, có thể để Landing Page dùng GET hoặc sendBeacon text/plain. Nhưng vẫn nên support CORS chuẩn.

## 11. Landing Page integration

Sửa `js/main.js`.

Landing Page hiện có:

```txt
form#apply_form
email field: #email_add
submit redirect bằng location.href = finalUrl.toString()
```

Cần thêm JS helper:

```txt
- getQueryParam(name)
- getCookie(name)
- getVlClickId()
- getTtclid()
- getTtp()
- captureLeadToCapi()
```

Nguồn lấy field:

```txt
vl_clickid: URL query param vl_clickid. Nếu không có thì fallback click_id/clickid/cid/subid.
ttclid: URL query param ttclid.
ttp: cookie _ttp hoặc ttp.
url: window.location.href.
referrer: document.referrer.
email: $("#email_add").val().trim()
phone: nếu có input phone thì lấy; hiện chưa có thì bỏ qua.
user_agent: navigator.userAgent.
```

Yêu cầu:

```txt
- Gắn capture trong submit handler sau validate/lấy form data và trước location.href redirect.
- Capture không được block flow đăng ký.
- Nếu thiếu vl_clickid/click_id thì có thể skip capture, console.warn.
- Nếu capture fail thì console.warn, không chặn redirect.
- Do redirect nhanh, dùng fetch keepalive hoặc navigator.sendBeacon.
```

Code frontend đề xuất:

```js
function getQueryParam(name) {
  return new URLSearchParams(window.location.search).get(name) || "";
}

function getFirstNonEmpty(values) {
  for (var i = 0; i < values.length; i++) {
    if (values[i]) return values[i];
  }
  return "";
}

function getCookie(name) {
  var match = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"));
  return match ? decodeURIComponent(match[2]) : "";
}

function getVlClickId() {
  var id = getFirstNonEmpty([
    getQueryParam("vl_clickid"),
    getQueryParam("click_id"),
    getQueryParam("clickid"),
    getQueryParam("cid"),
    getQueryParam("subid")
  ]);

  if (id) {
    try {
      localStorage.setItem("vl_clickid", id);
    } catch (e) {}
    return id;
  }

  try {
    return localStorage.getItem("vl_clickid") || "";
  } catch (e) {
    return "";
  }
}

function getTtclid() {
  return getQueryParam("ttclid");
}

function getTtp() {
  return getCookie("_ttp") || getCookie("ttp") || "";
}

function captureLeadToCapi() {
  var vlClickId = getVlClickId();

  if (!vlClickId) {
    console.warn("CAPI capture skipped: missing vl_clickid");
    return;
  }

  var payload = {
    server_key: "SERVER_KEY_PLACEHOLDER",
    vl_clickid: vlClickId,
    email: ($("#email_add").val() || "").trim(),
    ttclid: getTtclid(),
    ttp: getTtp(),
    url: window.location.href,
    referrer: document.referrer || "",
    user_agent: navigator.userAgent
  };

  // Nếu sau này có input phone thì mở đoạn này:
  // var phone = ($("#phone").val() || "").trim();
  // if (phone) payload.phone = phone;

  Object.keys(payload).forEach(function (key) {
    if (payload[key] === "" || payload[key] == null) {
      delete payload[key];
    }
  });

  try {
    fetch("https://api.lendoraai.site/capture", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(function (err) {
      console.warn("CAPI capture failed:", err);
    });
  } catch (err) {
    console.warn("CAPI capture failed:", err);
  }
}
```

Trong submit handler, thêm ngay trước redirect:

```js
captureLeadToCapi();
location.href = finalUrl.toString();
```

Nếu bạn chọn dùng sendBeacon, hãy đảm bảo server parse được body dạng text/plain hoặc application/x-www-form-urlencoded.

## 12. Bảo mật/logging

Yêu cầu:

```txt
1. Không log raw access_token.
2. Không log raw server_key.
3. Không log raw email.
4. Không log raw phone.
5. Không log raw external_id.
6. Không trả raw email/phone trong response.
7. Nginx access_log đang off, giữ nguyên.
8. Express morgan safe-url phải mask:
   - access_token
   - server_key
   - key
   - sk
   - email
   - phone
   - phone_number
   - external_id
9. Nếu server_key đặt trong frontend JS thì coi là public-ish, nên dùng key riêng và giới hạn ALLOWED_ORIGINS.
```

## 13. Trust proxy

Hiện trước đó có lỗi express-rate-limit:

```txt
ERR_ERL_PERMISSIVE_TRUST_PROXY
```

Yêu cầu:

```js
app.set("trust proxy", 1);
```

Không dùng:

```js
app.set("trust proxy", true);
```

Vì app chạy sau Nginx.

## 14. Cleanup cache

Yêu cầu:

```txt
1. Khi server start, xoá record hết hạn.
2. Định kỳ mỗi LEAD_CACHE_CLEANUP_INTERVAL_SECONDS xoá record hết hạn.
3. Không xoá record active.
```

## 15. Endpoint `/cache/stats`

Nếu chưa có, thêm:

```txt
GET /cache/stats
```

Yêu cầu:

```txt
- Check server_key.
- Không trả email/phone/hash.
- Chỉ trả thống kê.
```

Response:

```json
{
  "success": true,
  "total_records": 10,
  "active_records": 8,
  "expired_records": 2,
  "ttl_seconds": 10800
}
```

## 16. Backward compatibility

Các URL cũ vẫn phải chạy:

```txt
https://api.lendoraai.site/?server_key=...&access_token=...&pixel_code=...&external_id=...&email=...&phone_number=...&url=...&ip=...&user_agent=...&event_id=...&value=...
```

URL mới `/capture`:

```txt
https://api.lendoraai.site/capture?server_key=...&vl_clickid=VL123&email=email@gmail.com&ttclid=TTCLID123&ttp=TTP123&url=https%3A%2F%2Fassetshall.net&referrer=https%3A%2F%2Fgoogle.com
```

URL mới track bằng `vl_clickid`:

```txt
https://api.lendoraai.site/?server_key=...&access_token=...&pixel_code=...&vl_clickid=VL123&event_id=EVT123&value=3
```

Nếu dùng `click_id` cũ cũng vẫn chạy.

## 17. Test cases bắt buộc

Sau khi sửa code, cung cấp lệnh test.

### 1. Health

```bash
curl https://api.lendoraai.site/health
```

### 2. Capture bằng vl_clickid

```bash
curl "https://api.lendoraai.site/capture?server_key=SERVER_KEY&vl_clickid=VL123&email=email@gmail.com&ttclid=TTCLID123&ttp=TTP123&url=https%3A%2F%2Fassetshall.net%2F%3Fvl_clickid%3DVL123%26ttclid%3DTTCLID123&referrer=https%3A%2F%2Fgoogle.com&user_agent=chrome"
```

Expected:

```txt
success = true
stored_fields.email = true
stored_fields.ttclid = true
stored_fields.ttp = true
stored_fields.url = true
stored_fields.referrer = true
```

### 3. Cache stats

```bash
curl "https://api.lendoraai.site/cache/stats?server_key=SERVER_KEY"
```

Expected active_records >= 1.

### 4. Track bằng vl_clickid

```bash
curl "https://api.lendoraai.site/?server_key=SERVER_KEY&access_token=ACCESS_TOKEN&pixel_code=PIXEL_CODE&vl_clickid=VL123&event_id=EVT123&value=3"
```

Expected:

```txt
success = true
enriched = true
tiktok.code = 0
tiktok.message = OK
```

### 5. Track không có vl_clickid

```bash
curl "https://api.lendoraai.site/?server_key=SERVER_KEY&access_token=ACCESS_TOKEN&pixel_code=PIXEL_CODE&event_id=EVT_NO_ID&value=3"
```

Expected:

```txt
success true nếu TikTok nhận
enriched false hoặc omitted
không fail chỉ vì thiếu vl_clickid
```

### 6. Track vl_clickid không tồn tại

```bash
curl "https://api.lendoraai.site/?server_key=SERVER_KEY&access_token=ACCESS_TOKEN&pixel_code=PIXEL_CODE&vl_clickid=NOT_FOUND&event_id=EVT_NOT_FOUND&value=3"
```

Expected:

```txt
Vẫn gửi TikTok.
enriched = false.
Có enrichment_warning.
```

### 7. Sai server_key

Expected HTTP 401.

## 18. Cách deploy trên server sau khi code xong

Cập nhật README kèm lệnh:

```bash
cd /var/www/Capiserver
git pull
npm install --omit=dev
mkdir -p data
chmod 700 data
pm2 restart tiktok-capi-server --update-env
pm2 save
pm2 logs tiktok-capi-server --lines 100
```

Nếu thêm dependency native SQLite như better-sqlite3 mà lỗi build:

```bash
apt update
apt install -y build-essential python3 make g++
npm install --omit=dev
pm2 restart tiktok-capi-server --update-env
```

## 19. Output mong muốn

Hãy trả về:

```txt
1. Danh sách file cần sửa/thêm.
2. Code hoàn chỉnh cho từng file cần sửa.
3. Các dependency mới cần cài.
4. Nội dung .env.example mới.
5. Hướng dẫn migrate DB nếu cần.
6. Lệnh deploy trên Droplet.
7. Lệnh curl test đầy đủ.
8. Ghi chú phần nào sửa ở Landing Page, phần nào sửa ở CAPI Server.
```

Yêu cầu code production-ready