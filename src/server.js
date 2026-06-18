import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';

const app = express();

const PORT = Number(process.env.PORT || 3000);
const TIKTOK_ENDPOINT = process.env.TIKTOK_ENDPOINT || 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
const SERVER_KEY = process.env.SERVER_KEY || '';
const REQUIRE_SERVER_KEY = String(process.env.REQUIRE_SERVER_KEY || 'true').toLowerCase() !== 'false';
const DEFAULT_EVENT = process.env.DEFAULT_EVENT || 'CompleteRegistration';
const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || 'USD';
const DEFAULT_TEST_EVENT_CODE = process.env.DEFAULT_TEST_EVENT_CODE || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (REQUIRE_SERVER_KEY && !SERVER_KEY) {
  throw new Error('SERVER_KEY is required. Set SERVER_KEY in .env or set REQUIRE_SERVER_KEY=false for local testing only.');
}

app.set('trust proxy', true);
app.use(helmet());
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));

function maskSecret(value) {
  if (!value) return value;
  const str = String(value);
  if (str.length <= 8) return '***';
  return `${str.slice(0, 4)}***${str.slice(-4)}`;
}

function safeUrlForLog(req) {
  try {
    const url = new URL(req.originalUrl || req.url, 'http://local');
    const secretParams = new Set([
      'access_token',
      'server_key',
      'key',
      'sk',
      'email',
      'phone_number',
      'external_id'
    ]);

    for (const param of secretParams) {
      if (url.searchParams.has(param)) {
        url.searchParams.set(param, '***');
      }
    }

    const qs = url.searchParams.toString();
    return qs ? `${url.pathname}?${qs}` : url.pathname;
  } catch {
    return req.path || '/';
  }
}

morgan.token('safe-url', safeUrlForLog);
app.use(morgan(':remote-addr - :method :safe-url :status :res[content-length] - :response-time ms'));

app.use(rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  limit: Number(process.env.RATE_LIMIT_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false
}));

function firstValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function clean(value) {
  const raw = firstValue(value);
  if (raw === undefined || raw === null) return undefined;
  const str = String(raw).trim();
  if (!str) return undefined;
  const bad = new Set(['DINAMIC_VALUE', 'DYNAMIC_VALUE', 'undefined', 'null', 'none']);
  if (bad.has(str)) return undefined;
  return str;
}

function isSha256Hex(value) {
  return /^[a-f0-9]{64}$/i.test(value || '');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeIdentifier(key, value) {
  const v = clean(value);
  if (!v) return undefined;

  // If already SHA-256 hex, do not hash again.
  if (isSha256Hex(v)) return v.toLowerCase();

  // TikTok matching keys should be normalized then SHA-256 hashed.
  if (key === 'email') return sha256(v.toLowerCase());

  // Keep + for E.164 style, remove spaces and common separators before hashing.
  if (key === 'phone_number') {
    const phone = v.replace(/[\s().-]/g, '');
    return sha256(phone.toLowerCase());
  }

  // external_id is often an internal user id. Trim/lowercase before hashing for consistency.
  return sha256(v.toLowerCase());
}

function pickPayload(req) {
  // Accept both GET query and POST JSON/form body. Body overrides query when both exist.
  return { ...req.query, ...(req.body || {}) };
}

function getClientIp(req, input) {
  const fromParam = clean(input.ip);
  if (fromParam) return fromParam;

  const xff = clean(req.headers['x-forwarded-for']);
  if (xff) return xff.split(',')[0].trim();

  return req.ip;
}

function ensureAllowedOrigin(req) {
  if (!ALLOWED_ORIGINS.length) return true;
  const origin = clean(req.headers.origin) || clean(req.headers.referer);
  if (!origin) return false;
  return ALLOWED_ORIGINS.some((allowed) => origin.startsWith(allowed));
}

function timingSafeEqualString(a, b) {
  const aBuf = Buffer.from(String(a || ''));
  const bBuf = Buffer.from(String(b || ''));

  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function getIncomingServerKey(req, input) {
  // Support query/body/header so client can choose the easiest way.
  return (
    clean(input.server_key) ||
    clean(input.key) ||
    clean(input.sk) ||
    clean(req.headers['x-server-key']) ||
    clean(req.headers['x-api-key'])
  );
}

function ensureServerKey(req, input) {
  if (!REQUIRE_SERVER_KEY && !SERVER_KEY) return true;

  const incomingKey = getIncomingServerKey(req, input);
  if (!SERVER_KEY || !incomingKey) return false;

  return timingSafeEqualString(incomingKey, SERVER_KEY);
}

function buildTikTokPayload(req) {
  const input = pickPayload(req);

  if (!ensureServerKey(req, input)) {
    const err = new Error('Invalid or missing server_key');
    err.status = 401;
    throw err;
  }

  if (!ensureAllowedOrigin(req)) {
    const err = new Error('Origin/Referer is not allowed');
    err.status = 403;
    throw err;
  }

  const accessToken = clean(input.access_token);
  const pixelCode = clean(input.pixel_code);
  if (!accessToken) {
    const err = new Error('Missing required parameter: access_token');
    err.status = 400;
    throw err;
  }
  if (!pixelCode) {
    const err = new Error('Missing required parameter: pixel_code');
    err.status = 400;
    throw err;
  }

  const user = {};
  const externalId = normalizeIdentifier('external_id', input.external_id);
  const email = normalizeIdentifier('email', input.email);
  const phoneNumber = normalizeIdentifier('phone_number', input.phone_number);

  if (externalId) user.external_id = externalId;
  if (email) user.email = email;
  if (phoneNumber) user.phone_number = phoneNumber;

  const pageUrl = clean(input.url);
  const ip = getClientIp(req, input);
  const userAgent = clean(input.user_agent) || clean(req.headers['user-agent']);

  const context = {};
  if (Object.keys(user).length) context.user = user;
  if (pageUrl) context.page = { url: pageUrl };
  if (ip) context.ip = ip;
  if (userAgent) context.user_agent = userAgent;

  const properties = {
    currency: DEFAULT_CURRENCY
  };

  const value = clean(input.value);
  if (value !== undefined) {
    const numericValue = Number(value);
    properties.value = Number.isFinite(numericValue) ? numericValue : value;
  }

  const eventId = clean(input.event_id);
  const payload = {
    pixel_code: pixelCode,
    event: DEFAULT_EVENT,
    context,
    properties
  };

  if (eventId) payload.event_id = eventId;

  const timestamp = clean(input.timestamp);
  if (timestamp) payload.timestamp = timestamp;

  const testEventCode = clean(input.test_event_code) || clean(DEFAULT_TEST_EVENT_CODE);
  if (testEventCode) payload.test_event_code = testEventCode;

  return { accessToken, pixelCode, payload };
}

async function sendToTikTok(accessToken, payload) {
  const response = await fetch(TIKTOK_ENDPOINT, {
    method: 'POST',
    headers: {
      'Access-Token': accessToken,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  return {
    http_status: response.status,
    ok: response.ok,
    tiktok: data
  };
}

function getDebugPayload(payload) {
  if (process.env.NODE_ENV === 'production') return undefined;
  return payload;
}

async function trackHandler(req, res) {
  try {
    const { accessToken, pixelCode, payload } = buildTikTokPayload(req);
    const result = await sendToTikTok(accessToken, payload);

    // Return HTTP 200 for TikTok success. If TikTok returns code != 0, expose error clearly.
    const tiktokCode = result?.tiktok?.code;
    const success = result.ok && (tiktokCode === undefined || tiktokCode === 0);

    return res.status(success ? 200 : 502).json({
      success,
      pixel_code: pixelCode,
      access_token: maskSecret(accessToken),
      sent_payload: getDebugPayload(payload),
      result
    });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({
      success: false,
      error: error.message || 'Internal Server Error'
    });
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'tiktok-capi-server' });
});

// Main endpoints. Both GET and POST are supported.
app.get('/', trackHandler);
app.post('/', trackHandler);
app.get('/track', trackHandler);
app.post('/track', trackHandler);

app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`TikTok CAPI server listening on port ${PORT}`);
});
