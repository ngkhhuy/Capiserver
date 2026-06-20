import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { saveLead, getLead, getCacheStats, TTL } from './db.js';

const app = express();

const PORT             = Number(process.env.PORT || 3000);
const TIKTOK_ENDPOINT  = process.env.TIKTOK_ENDPOINT || 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
const SERVER_KEY       = process.env.SERVER_KEY || '';
const REQUIRE_SERVER_KEY = String(process.env.REQUIRE_SERVER_KEY || 'true').toLowerCase() !== 'false';
const DEFAULT_EVENT    = process.env.DEFAULT_EVENT    || 'CompleteRegistration';
const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || 'USD';
const DEFAULT_TEST_EVENT_CODE = process.env.DEFAULT_TEST_EVENT_CODE || '';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

if (REQUIRE_SERVER_KEY && !SERVER_KEY) {
  throw new Error('SERVER_KEY is required. Set SERVER_KEY in .env or REQUIRE_SERVER_KEY=false.');
}

// ---------------------------------------------------------------------------
// Express setup
// ---------------------------------------------------------------------------
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));

// ---------------------------------------------------------------------------
// CORS — support browser fetch from Landing Page
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin) {
    if (!ALLOWED_ORIGINS.length) {
      // No restriction configured — allow any origin
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else {
      const isAllowed = ALLOWED_ORIGINS.some((o) => origin.startsWith(o));
      if (isAllowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      // If not allowed, omit CORS header — browser will block
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-server-key, x-api-key');
    res.setHeader('Access-Control-Max-Age', '86400');
  }

  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ---------------------------------------------------------------------------
// Logging — mask sensitive params
// ---------------------------------------------------------------------------
const SECRET_PARAMS = new Set([
  'access_token', 'server_key', 'key', 'sk',
  'email', 'phone', 'phone_number', 'external_id',
]);

function safeUrlForLog(req) {
  try {
    const url = new URL(req.originalUrl || req.url, 'http://local');
    for (const p of SECRET_PARAMS) {
      if (url.searchParams.has(p)) url.searchParams.set(p, '***');
    }
    const qs = url.searchParams.toString();
    return qs ? `${url.pathname}?${qs}` : url.pathname;
  } catch {
    return req.path || '/';
  }
}

morgan.token('safe-url', safeUrlForLog);
app.use(morgan(':remote-addr - :method :safe-url :status :res[content-length] - :response-time ms'));

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------
app.use(rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
  limit:    Number(process.env.RATE_LIMIT_MAX        || 300),
  standardHeaders: true,
  legacyHeaders:   false,
}));

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
function firstValue(v) { return Array.isArray(v) ? v[0] : v; }

function clean(value) {
  const raw = firstValue(value);
  if (raw == null) return undefined;
  const str = String(raw).trim();
  if (!str) return undefined;
  if (['DINAMIC_VALUE','DYNAMIC_VALUE','undefined','null','none'].includes(str)) return undefined;
  return str;
}

function isSha256Hex(v) { return /^[a-f0-9]{64}$/i.test(v || ''); }
function sha256(v)      { return crypto.createHash('sha256').update(v).digest('hex'); }

/**
 * Trả true nếu giá trị phone nên bị coi là "không có".
 * - null / undefined / chuỗi rỗng
 * - "999999999" — giá trị mặc định phía khách dùng khi user không có phone
 */
function isEmptyPhoneValue(value) {
  if (value == null) return true;
  const raw = String(value).trim();
  if (!raw) return true;
  const digitsOnly = raw.replace(/\D/g, '');
  if (digitsOnly === '999999999') return true;
  return false;
}

function normalizeIdentifier(key, value) {
  const v = clean(value);
  if (!v) return undefined;
  if (isSha256Hex(v)) return v.toLowerCase();
  if (key === 'email')        return sha256(v.toLowerCase());
  if (key === 'phone_number') return sha256(v.replace(/[\s().\-]/g, '').toLowerCase());
  return sha256(v.toLowerCase()); // external_id
}

function maskSecret(value) {
  if (!value) return value;
  const s = String(value);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

function normalizePageUrl(value) {
  const u = clean(value);
  if (!u) return undefined;
  return (u.startsWith('http://') || u.startsWith('https://')) ? u : `https://${u}`;
}

function normalizeTimestamp(value) {
  const t = clean(value);
  if (!t) return Math.floor(Date.now() / 1000);
  const n = Number(t);
  if (!Number.isFinite(n)) return Math.floor(Date.now() / 1000);
  return n > 10_000_000_000 ? Math.floor(n / 1000) : Math.floor(n);
}

function pickPayload(req) { return { ...req.query, ...(req.body || {}) }; }

function getClientIp(req, input) {
  const fromParam = clean(input.ip);
  if (fromParam) return fromParam;
  const xff = clean(req.headers['x-forwarded-for']);
  if (xff) return xff.split(',')[0].trim();
  return req.ip;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
function getIncomingServerKey(req, input) {
  return clean(input.server_key) || clean(input.key) || clean(input.sk)
      || clean(req.headers['x-server-key']) || clean(req.headers['x-api-key']);
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function ensureServerKey(req, input) {
  if (!REQUIRE_SERVER_KEY && !SERVER_KEY) return true;
  const incoming = getIncomingServerKey(req, input);
  if (!SERVER_KEY || !incoming) return false;
  return timingSafeEqual(incoming, SERVER_KEY);
}

function ensureAllowedOrigin(req) {
  if (!ALLOWED_ORIGINS.length) return true;
  const origin = clean(req.headers.origin) || clean(req.headers.referer);
  if (!origin) return true; // server-to-server call — no origin header, allow (protected by server_key)
  return ALLOWED_ORIGINS.some((o) => origin.startsWith(o));
}

// ---------------------------------------------------------------------------
// Match key helper  (vl_clickid > click_id)
// ---------------------------------------------------------------------------
function getMatchKey(input) {
  return clean(input.vl_clickid) || clean(input.click_id) || undefined;
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ ok: true, service: 'tiktok-capi-server' }));

// ---------------------------------------------------------------------------
// GET|POST /capture  — Landing Page calls this to store lead data
// ---------------------------------------------------------------------------
async function captureHandler(req, res) {
  try {
    const input = pickPayload(req);

    if (!ensureServerKey(req, input)) {
      return res.status(401).json({ success: false, error: 'Invalid or missing server_key' });
    }

    const matchKey = getMatchKey(input);
    if (!matchKey) {
      return res.status(400).json({ success: false, error: 'Missing required parameter: vl_clickid or click_id' });
    }

    // Normalize identifiers (hash if not already hashed)
    const emailHash      = normalizeIdentifier('email',        input.email);
    // Support both phone and phone_number as input aliases.
    // 999999999 = giá trị mặc định phía khách, coi như không có phone.
    const rawPhone  = clean(input.phone) || clean(input.phone_number);
    const phoneHash = (!isEmptyPhoneValue(rawPhone) && rawPhone)
      ? normalizeIdentifier('phone_number', rawPhone)
      : undefined;
    const externalIdHash = normalizeIdentifier('external_id', input.external_id);

    // Tracking metadata — stored raw
    const ttclid   = clean(input.ttclid);
    const ttp      = clean(input.ttp);
    const pageUrl  = normalizePageUrl(clean(input.url) || clean(input.page_url));
    const referrer = clean(input.referrer) || clean(input.page_referrer);
    const ip       = getClientIp(req, input);
    const userAgent = clean(input.user_agent) || clean(req.headers['user-agent']);

    const { expiresAt, ttl } = saveLead(matchKey, {
      click_id:         clean(input.click_id),
      email_hash:       emailHash,
      phone_hash:       phoneHash,
      external_id_hash: externalIdHash,
      ttclid,
      ttp,
      page_url:         pageUrl,
      referrer,
      ip,
      user_agent:       userAgent,
    });

    return res.json({
      success:            true,
      message:            'Lead cache saved',
      vl_clickid:         matchKey,
      click_id:           matchKey,
      expires_in_seconds: ttl,
      expires_at:         expiresAt,
      stored_fields: {
        email:      !!emailHash,
        phone:      !!phoneHash,
        external_id:!!externalIdHash,
        ttclid:     !!ttclid,
        ttp:        !!ttp,
        url:        !!pageUrl,
        referrer:   !!referrer,
        ip:         !!ip,
        user_agent: !!userAgent,
      },
    });
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, error: err.message || 'Internal Server Error' });
  }
}

app.get('/capture',  captureHandler);
app.post('/capture', captureHandler);

// ---------------------------------------------------------------------------
// GET|POST /  and  /track  — send TikTok CAPI event
// ---------------------------------------------------------------------------
async function buildTikTokPayload(req) {
  const input = pickPayload(req);

  if (!ensureServerKey(req, input))   throw Object.assign(new Error('Invalid or missing server_key'), { status: 401 });
  if (!ensureAllowedOrigin(req))      throw Object.assign(new Error('Origin not allowed'), { status: 403 });

  const accessToken = clean(input.access_token);
  const pixelCode   = clean(input.pixel_code);
  if (!accessToken) throw Object.assign(new Error('Missing required parameter: access_token'), { status: 400 });
  if (!pixelCode)   throw Object.assign(new Error('Missing required parameter: pixel_code'), { status: 400 });

  // Enrichment from cache
  const matchKey = getMatchKey(input);
  let cached = null;
  let enriched = false;
  let enrichmentSource = null;
  let enrichmentWarning = null;

  if (matchKey) {
    cached = getLead(matchKey);
    if (cached) {
      enriched = true;
      enrichmentSource = 'cache';
    } else {
      enrichmentWarning = 'vl_clickid not found or expired';
    }
  }

  // --- Build user object (direct input > cache) ---
  const user = {};

  // Email (hash)
  const email = normalizeIdentifier('email', input.email) || cached?.email_hash;
  if (email) user.email = email;

  // Phone (input: phone or phone_number; stored as phone_number in TikTok payload for backward compat).
  // 999999999 = giá trị mặc định phía khách, coi như không có phone — không hash, không gửi TikTok.
  const rawPhone  = clean(input.phone) || clean(input.phone_number);
  const phoneHash = (!isEmptyPhoneValue(rawPhone) && rawPhone)
    ? normalizeIdentifier('phone_number', rawPhone)
    : (!isEmptyPhoneValue(rawPhone) ? cached?.phone_hash : undefined);
  if (phoneHash) user.phone_number = phoneHash; // TikTok field name is phone_number

  // external_id (hash)
  const extId = normalizeIdentifier('external_id', input.external_id) || cached?.external_id_hash;
  if (extId) user.external_id = extId;

  // ttclid and ttp — raw tracking params
  const ttclid = clean(input.ttclid) || cached?.ttclid;
  const ttp    = clean(input.ttp)    || cached?.ttp;
  if (ttclid) user.ttclid = ttclid;
  if (ttp)    user.ttp    = ttp;

  // IP and user-agent
  const ip        = getClientIp(req, input) || cached?.ip;
  const userAgent = clean(input.user_agent) || clean(req.headers['user-agent']) || cached?.user_agent;
  if (ip)        user.ip         = ip;
  if (userAgent) user.user_agent = userAgent;

  // --- Page ---
  const rawUrl  = clean(input.url) || clean(input.page_url) || cached?.page_url;
  const pageUrl = normalizePageUrl(rawUrl);
  const referrer = clean(input.referrer) || clean(input.page_referrer) || cached?.referrer;

  // --- Properties ---
  const properties = { currency: DEFAULT_CURRENCY };
  const rawValue = clean(input.value);
  if (rawValue !== undefined) {
    const n = Number(rawValue);
    properties.value = Number.isFinite(n) ? n : rawValue;
  }

  // --- Event data ---
  const eventData = {
    event:      DEFAULT_EVENT,
    event_time: normalizeTimestamp(input.timestamp),
    user,
    properties,
  };

  if (pageUrl || referrer) {
    eventData.page = {};
    if (pageUrl)  eventData.page.url      = pageUrl;
    if (referrer) eventData.page.referrer = referrer;
  }

  const eventId = clean(input.event_id);
  if (eventId) eventData.event_id = eventId;

  // --- Root payload ---
  const payload = {
    event_source:    'web',
    event_source_id: pixelCode,
    data:            [eventData],
  };

  const testCode = clean(input.test_event_code) || clean(DEFAULT_TEST_EVENT_CODE);
  if (testCode) payload.test_event_code = testCode;

  return { accessToken, pixelCode, payload, matchKey, enriched, enrichmentSource, enrichmentWarning };
}

async function sendToTikTok(accessToken, payload) {
  const response = await fetch(TIKTOK_ENDPOINT, {
    method:  'POST',
    headers: { 'Access-Token': accessToken, 'Content-Type': 'application/json', Accept: 'application/json' },
    body:    JSON.stringify(payload),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  return { http_status: response.status, ok: response.ok, tiktok: data };
}

async function trackHandler(req, res) {
  try {
    const { accessToken, pixelCode, payload, matchKey, enriched, enrichmentSource, enrichmentWarning } =
      await buildTikTokPayload(req);

    const result     = await sendToTikTok(accessToken, payload);
    const tiktokCode = result?.tiktok?.code;
    const success    = result.ok && (tiktokCode === undefined || tiktokCode === 0);

    const body = {
      success,
      pixel_code:   pixelCode,
      access_token: maskSecret(accessToken),
      result,
    };

    // Only in development expose sent_payload for debug
    if (process.env.NODE_ENV !== 'production') body.sent_payload = payload;

    if (matchKey !== undefined) {
      body.vl_clickid          = matchKey;
      body.enriched            = enriched;
      body.enrichment_source   = enrichmentSource;
      body.enrichment_warning  = enrichmentWarning;
    }

    return res.status(success ? 200 : 502).json(body);
  } catch (err) {
    return res.status(err.status || 500).json({ success: false, error: err.message || 'Internal Server Error' });
  }
}

app.get('/',      trackHandler);
app.post('/',     trackHandler);
app.get('/track', trackHandler);
app.post('/track',trackHandler);

// ---------------------------------------------------------------------------
// GET /cache/stats
// ---------------------------------------------------------------------------
app.get('/cache/stats', (req, res) => {
  try {
    const input = pickPayload(req);
    if (!ensureServerKey(req, input)) {
      return res.status(401).json({ success: false, error: 'Invalid or missing server_key' });
    }
    return res.json({ success: true, ...getCacheStats() });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------
app.use((_req, res) => res.status(404).json({ success: false, error: 'Not found' }));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => console.log(`TikTok CAPI server listening on port ${PORT}`));