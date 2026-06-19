# TikTok CAPI Server

Server Node.js nhận URL GET/POST, kiểm tra `server_key`, tự chuẩn hoá/hash `external_id`, `email`, `phone_number` bằng SHA-256 nếu chưa hash, rồi gọi TikTok Events API.

Hỗ trợ **lead cache** bằng SQLite: Prelander lưu tạm thông tin user theo `click_id`, sau đó khi có conversion thật chỉ cần truyền `click_id` — server tự enrich dữ liệu và gửi TikTok CAPI.

## 1. Cài đặt local

```bash
npm install
cp .env.example .env
# Chỉnh SERVER_KEY trong .env
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

## 2. Cấu hình .env

```env
PORT=3000
NODE_ENV=production

TIKTOK_ENDPOINT=https://business-api.tiktok.com/open_api/v1.3/event/track/

REQUIRE_SERVER_KEY=true
SERVER_KEY=CHANGE_ME_TO_A_LONG_RANDOM_SECRET

ALLOWED_ORIGINS=

DEFAULT_EVENT=CompleteRegistration
DEFAULT_CURRENCY=USD
DEFAULT_TEST_EVENT_CODE=

RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=300

# Lead Cache (SQLite)
LEAD_CACHE_DB_PATH=./data/capi-cache.db
LEAD_CACHE_TTL_SECONDS=10800
LEAD_CACHE_CLEANUP_INTERVAL_SECONDS=600
```

Tạo `SERVER_KEY` ngẫu nhiên:

```bash
openssl rand -hex 32
```

## 3. Flow /capture + /track

```
1. User vào Prelander
2. Prelander gọi GET /capture?server_key=...&click_id=CLICK123&email=...&phone_number=...
3. Server hash + lưu vào SQLite, TTL 3 tiếng
4. Khi có conversion, hệ thống gọi GET /?server_key=...&access_token=...&pixel_code=...&click_id=CLICK123&value=3
5. Server lookup click_id, merge dữ liệu vào TikTok payload
6. Gửi TikTok Events API
```

> **Lưu ý:** Dữ liệu cache tự xoá sau 3 tiếng. Không lưu raw email/phone — chỉ lưu SHA-256 hash.

## 4. Endpoint /capture — Lưu tạm lead

### GET

```bash
curl "https://api.lendoraai.site/capture?server_key=SERVER_KEY&click_id=CLICK123&email=email@gmail.com&phone_number=8900343434&external_id=user123&url=quickpayly.com&ip=1.1.1.1&user_agent=chrome"
```

### POST JSON

```bash
curl --location --request POST 'https://api.lendoraai.site/capture' \
  --header 'Content-Type: application/json' \
  --header 'x-server-key: SERVER_KEY' \
  --data-raw '{
    "click_id": "CLICK123",
    "email": "email@gmail.com",
    "phone_number": "+84900343434",
    "external_id": "user123",
    "url": "https://quickpayly.com",
    "ip": "1.1.1.1",
    "user_agent": "Mozilla/5.0"
  }'
```

Response:

```json
{
  "success": true,
  "message": "Lead cache saved",
  "click_id": "CLICK123",
  "expires_in_seconds": 10800,
  "expires_at": 1234567890,
  "stored_fields": {
    "email": true,
    "phone_number": true,
    "external_id": true
  }
}
```

## 5. Endpoint /track — Gửi CAPI với click_id

```bash
curl "https://api.lendoraai.site/?server_key=SERVER_KEY&access_token=ACCESS_TOKEN&pixel_code=PIXEL_CODE&click_id=CLICK123&event_id=EVT123&value=3"
```

Response khi tìm thấy click_id:

```json
{
  "success": true,
  "pixel_code": "D8...",
  "access_token": "28ed***cf86",
  "click_id": "CLICK123",
  "enriched": true,
  "enrichment_source": "cache",
  "enrichment_warning": null,
  "result": {
    "http_status": 200,
    "ok": true,
    "tiktok": { "code": 0, "message": "OK" }
  }
}
```

Response khi không tìm thấy click_id:

```json
{
  "success": true,
  "click_id": "NOTFOUND",
  "enriched": false,
  "enrichment_source": null,
  "enrichment_warning": "click_id not found or expired",
  "result": { ... }
}
```

## 6. Endpoint /cache/stats

Thống kê cache (yêu cầu server_key):

```bash
curl "https://api.lendoraai.site/cache/stats?server_key=SERVER_KEY"
```

```json
{
  "success": true,
  "total_records": 10,
  "active_records": 8,
  "expired_records": 2,
  "ttl_seconds": 10800
}
```

## 7. URL backward-compatible (không dùng click_id)

```bash
curl "https://api.lendoraai.site/?server_key=SERVER_KEY&access_token=ACCESS_TOKEN&pixel_code=PIXEL_CODE&external_id=user123&email=test@example.com&phone_number=%2B84901234567&url=https%3A%2F%2Fquickpayly.com&ip=1.1.1.1&user_agent=Mozilla%2F5.0&event_id=W_WM4RJP&value=2.83"
```

## 8. Deploy / Update trên server

### Deploy lần đầu

```bash
sudo apt update
sudo apt install -y curl nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2

sudo mkdir -p /var/www/Capiserver
sudo chown -R $USER:$USER /var/www/Capiserver
# Upload/copy source vào /var/www/Capiserver
cd /var/www/Capiserver
npm install --omit=dev
cp .env.example .env
nano .env
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Nginx:

```bash
sudo cp nginx-example.conf /etc/nginx/sites-available/tiktok-capi
sudo ln -s /etc/nginx/sites-available/tiktok-capi /etc/nginx/sites-enabled/tiktok-capi
sudo nginx -t
sudo systemctl reload nginx
```

SSL:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com -d www.your-domain.com
```

### Update (pull code mới)

```bash
cd /var/www/Capiserver
git pull
npm install --omit=dev
pm2 restart tiktok-capi-server
pm2 logs tiktok-capi-server --lines 100
```

## 9. Bảo mật

- `server_key` so sánh bằng `crypto.timingSafeEqual` — chống timing attack.
- Log URL tự động mask: `access_token`, `server_key`, `email`, `phone_number`, `external_id`.
- Chỉ lưu SHA-256 hash vào SQLite — không lưu raw email/phone.
- Nginx `access_log off` để tránh lộ token trong Nginx log.
- Rate limit: 300 req/phút (configurable).
- Không gửi `test_event_code` trên production sau khi test xong.

## 10. Cấu trúc project

```txt
Capiserver/
├── data/
│   └── capi-cache.db        # SQLite DB (tự tạo khi khởi động)
├── src/
│   ├── db.js                # SQLite wrapper (lead cache)
│   └── server.js            # Express server
├── .env.example
├── ecosystem.config.cjs
├── nginx-example.conf
├── package.json
└── README.md
```
