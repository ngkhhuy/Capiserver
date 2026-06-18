# TikTok CAPI Server

Server Node.js nhận URL GET/POST, kiểm tra `server_key`, tự chuẩn hoá/hash `external_id`, `email`, `phone_number` bằng SHA-256 nếu chưa hash, rồi gọi TikTok Events API.

## 1. Cài đặt local

```bash
npm install
cp .env.example .env
npm run dev
```

Health check:

```bash
curl http://localhost:3000/health
```

## 2. Cấu hình server key

Mặc định server yêu cầu `SERVER_KEY` để tránh người ngoài gọi URL bừa bãi.

Trong file `.env`, đổi dòng này thành secret thật:

```env
REQUIRE_SERVER_KEY=true
SERVER_KEY=CHANGE_ME_TO_A_LONG_RANDOM_SECRET
```

Tạo key ngẫu nhiên trên server:

```bash
openssl rand -hex 32
```

Ví dụ:

```env
SERVER_KEY=8cf9a9e2c8a8c94dfdc8e5f5b8b4d5a85fd37a02c967111bc219c40e115b69a1
```

## 3. URL mẫu GET có server_key

```bash
curl "http://localhost:3000/track?server_key=YOUR_SERVER_KEY&access_token=YOUR_ACCESS_TOKEN&pixel_code=D51A6ORC77UCC7FFQ1N0&external_id=user123&email=test@example.com&phone_number=%2B84901234567&url=https%3A%2F%2Fquickpayly.com&ip=2607%3Afb91%3A5305%3A42f5%3Ae0e6%3A6816%3A5bf%3A999c&user_agent=Mozilla%2F5.0&event_id=W_WM4RJP&value=2.83"
```

URL production:

```txt
https://your-domain.com/?server_key=YOUR_SERVER_KEY&access_token=YOUR_ACCESS_TOKEN&pixel_code=PIXEL_CODE&external_id=EXTERNAL_ID&email=EMAIL&phone_number=PHONE&url=PAGE_URL&ip=IP&user_agent=USER_AGENT&event_id=EVENT_ID&value=VALUE
```

Server cũng hỗ trợ alias ngắn nếu cần:

```txt
?key=YOUR_SERVER_KEY
?sk=YOUR_SERVER_KEY
```

Hoặc truyền qua header thay vì query:

```bash
curl "http://localhost:3000/track?access_token=YOUR_ACCESS_TOKEN&pixel_code=D51A6ORC77UCC7FFQ1N0&external_id=user123&email=test@example.com&phone_number=%2B84901234567&url=https%3A%2F%2Fquickpayly.com&event_id=W_WM4RJP&value=2.83" \
  -H "x-server-key: YOUR_SERVER_KEY"
```

## 4. POST JSON mẫu

```bash
curl --location --request POST 'http://localhost:3000/track' \
  --header 'Content-Type: application/json' \
  --header 'x-server-key: YOUR_SERVER_KEY' \
  --data-raw '{
    "access_token": "YOUR_ACCESS_TOKEN",
    "pixel_code": "D51A6ORC77UCC7FFQ1N0",
    "external_id": "user123",
    "email": "test@example.com",
    "phone_number": "+84901234567",
    "url": "https://quickpayly.com",
    "ip": "2607:fb91:5305:42f5:e0e6:6816:5bf:999c",
    "user_agent": "Mozilla/5.0",
    "event_id": "W_WM4RJP",
    "value": "2.83"
  }'
```

## 5. Logic đang hardcode theo yêu cầu khách

- `event`: `CompleteRegistration`
- `currency`: `USD`
- `access_token`: lấy từ URL/body
- `pixel_code`: lấy từ URL/body
- `url`: khách tự gắn vào biến `url=` khi gọi API
- `external_id`, `email`, `phone_number`: server tự hash SHA-256 nếu chưa hash

## 6. Deploy Ubuntu/DigitalOcean

```bash
sudo apt update
sudo apt install -y curl nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2

sudo mkdir -p /var/www/tiktok-capi
sudo chown -R $USER:$USER /var/www/tiktok-capi
# Upload/copy source vào /var/www/tiktok-capi
cd /var/www/tiktok-capi
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
sudo certbot --nginx -d capitiktokcustome.com -d www.capitiktokcustome.com
```

## 7. Bảo mật

- `server_key` hiện là bắt buộc nếu `REQUIRE_SERVER_KEY=true`.
- App log đã che các query nhạy cảm như `access_token`, `server_key`, `email`, `phone_number`, `external_id`.
- File Nginx mẫu đã `access_log off` để tránh lưu token/key trong log URL.
- Không gửi `test_event_code` trên production sau khi test xong.
