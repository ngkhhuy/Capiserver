import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { saveLead, getLead, getCacheStats, TTL } from './db.js';

const app = express();

const PORT = Number(process.env.PORT || 3000);
const TIKTOK_ENDPOINT =
  process.env.TIKTOK_ENDPOINT ||
  'https://business-api.tiktok.com/open_api/v1.3/event/track/';

const SERVER_KEY = process.env.SERVER_KEY || '';
const REQUIRE_SERVER_KEY =
  String(process.env.REQUIRE_SERVER_KEY || 'true').toLowerCase() !== 'false';

const DEFAULT_EVENT     = process.env.DEFAULT_EVENT     || 'CompleteRegistration';
const DEFAULT_CURRENCY  = process.env.DEFAULT_CURRENCY  || 'USD';
const DEFAULT_TEST_EVENT_CODE = process.env.DEFAULT_TEST_EVENT_CODE || '';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (REQUIRE_SERVER_KEY && !SERVER_KEY) {
  throw new Error(
    'SERVER_KEY is required. Set SERVER_KEY in .env or set REQUIRE_SERVER_KEY=false for local testing only.'
  );
}

app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: true, limit: '50kb' }));

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function maskSecret(value) {
  if (!value) return value;
  const str = String(value);
  if (str.length <= 8) return '***';
  return `${str.slice(0, 4)}***${str.slice(-4)}`;
}

const SECRET_PARAMS = new Set([
  'access_token',
  'server_key',
  'key',
  'sk',
  'email',
  'phone_number',
  'external_id',
]);

function safeUrlForLog(req) {
  try {
    const url = new URL(req.originalUrl || req.url, 'http://local');
    for (const param of SECRET_PARAMS) {
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

app.use(
  morgan(
    ':remote-addr - :method :safe-url :status :res[content-length] - :response-time ms'
  )
);

app.use(
  rateLimit({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
    limit:    Number(process.env.RATE_LIMIT_MAX        || 300),
    standardHeaders: true,
    legacyHeaders:   false,
  })
);

// ---------------------------------------------------------------------------
// Data normalisation helpers
// ---------------------------------------------------------------------------

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

  // Already a SHA-256 hex — keep as-is (lowercase)
  if (isSha256Hex(v)) return v.toLowerCase();

  if (key === 'email') {
    return sha256(v.toLowerCase());
  }

  if (key === 'phone_number') {
    const phone = v.replace(/[\s().\-]/g, '');
    return sha256(phone.toLowerCase());
  }

  // external_id
  return sha256(v.toLowerCase());
}

function normalizePageUrl(value) {
  const pageUrl = clean(value);
  if (!pageUrl) return undefined;
  if (pageUrl.startsWith('http://') || pageUrl.startsWith('https://')) {
    return pageUrl;
  }
  return `https://${pageUrl}`;
}

function normalizeTimestamp(value) {
  const timestamp = clean(value);
  if (!timestamp) return Math.floor(Date.now() / 1000);

  const n = Number(timestamp);
  if (!Number.isFinite(n)) return Math.floor(Date.now() / 1000);

  // Client sent milliseconds → convert to seconds
  if (n > 10_000_000_000) return Math.floor(n / 1000);

  return Math.floor(n);
}

// ---------------------------------------------------------------------------
// Auth / origin helpers
// ---------------------------------------------------------------------------

function pickPayload(req) {
  // Body overrides query when both present
  return { ...req.query, ...(req.body || {}) };
}

function getIncomingServerKey(req, input) {
  return (
    clean(input.server_key) ||
    clean(input.key)        ||
    clean(input.sk)         ||
    clean(req.headers['x-server-key']) ||
    clean(req.headers['x-api-key'])
  );
}

function timingSafeEqualString(a, b) {
  const aBuf = Buffer.from(String(a || ''));
  const bBuf = Buffer.from(String(b || ''));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function ensureServerKey(req, input) {
  if (!REQUIRE_SERVER_KEY && !SERVER_KEY) return true;

  const incomingKey = getIncomingServerKey(req, input);
  if (!SERVER_KEY || !incomingKey) return false;

  return timingSafeEqualString(incomingKey, SERVER_KEY);
}

function ensureAllowedOrigin(req) {
  if (!ALLOWED_ORIGINS.length) return true;

  const origin = clean(req.headers.origin) || clean(req.headers.referer);
  if (!origin) return false;

  return ALLOWED_ORIGINS.some((allowed) => origin.startsWith(allowed));
}

function getClientIp(req, input) {
  const fromParam = clean(input.ip);
  if (fromParam) return fromParam;

  const xff = clean(req.headers['x-forwarded-for']);
  if (xff) return xff.split(',')[0].trim();

  return req.ip;
}

// ---------------------------------------------------------------------------
// TikTok payload builder
// ---------------------------------------------------------------------------

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
  const pixelCode   = clean(input.pixel_code);

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

  // --- click_id enrichment from cache ---
  const clickId = clean(input.click_id);
  let enriched          = false;
  let enrichmentSource  = null;
  let enrichmentWarning = null;
  let cached            = null;

  if (clickId) {
    cached = getLead(clickId);
    if (cached) {
      enriched         = true;
      enrichmentSource = 'cache';
    } else {
      enrichmentWarning = 'click_id not found or expired';
    }
  }

  // --- Build user object (direct params > cache) ---
  const user = {};

  // Hashes from direct request
  const directExternalId   = normalizeIdentifier('external_id',  input.external_id);
  const directEmail        = normalizeIdentifier('email',         input.email);
  const directPhoneNumber  = normalizeIdentifier('phone_number',  input.phone_number);

  // Fallback from cache (already hashed)
  const externalId  = directExternalId || cached?.external_id_hash || undefined;
  const email       = directEmail       || cached?.email_hash       || undefined;
  const phoneNumber = directPhoneNumber || cached?.phone_hash       || undefined;

  if (externalId)  user.external_id  = externalId;
  if (email)       user.email        = email;
  if (phoneNumber) user.phone_number = phoneNumber;

  // IP and UA — fallback to cache
  const directIp = getClientIp(req, input);
  const ip       = directIp                                    || cached?.ip          || undefined;
  const userAgent = clean(input.user_agent) || clean(req.headers['user-agent']) || cached?.user_agent || undefined;

  if (ip)        user.ip         = ip;
  if (userAgent) user.user_agent = userAgent;

  // URL — fallback to cache
  const rawUrl  = clean(input.url) || cached?.page_url || undefined;
  const pageUrl = normalizePageUrl(rawUrl);

  const properties = { currency: DEFAULT_CURRENCY };

  const value = clean(input.value);
  if (value !== undefined) {
    const numericValue = Number(value);
    properties.value = Number.isFinite(numericValue) ? numericValue : value;
  }

  const eventId   = clean(input.event_id);
  const eventTime = normalizeTimestamp(input.timestamp);

  const eventData = {
    event:      DEFAULT_EVENT,
    event_time: eventTime,
    user,
    properties,
  };

  if (pageUrl)  eventData.page     = { url: pageUrl };
  if (eventId)  eventData.event_id = eventId;

  const payload = {
    event_source:    'web',
    event_source_id: pixelCode,
    data:            [eventData],
  };

  const testEventCode =
    clean(input.test_event_code) || clean(DEFAULT_TEST_EVENT_CODE);
  if (testEventCode) payload.test_event_code = testEventCode;

  return {
    accessToken,
    pixelCode,
    payload,
    clickId,
    enriched,
    enrichmentSource,
    enrichmentWarning,
  };
}

// ---------------------------------------------------------------------------
// TikTok API call
// ---------------------------------------------------------------------------

async function sendToTikTok(accessToken, payload) {
  const response = await fetch(TIKTOK_ENDPOINT, {
    method:  'POST',
    headers: {
      'Access-Token':  accessToken,
      'Content-Type':  'application/json',
      Accept:          'application/json',
    },
    body: JSON.stringify(payload),
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
    ok:          response.ok,
    tiktok:      data,
  };
}

function getDebugPayload(payload) {
  if (process.env.NODE_ENV === 'production') return undefined;
  return payload;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/** GET /health */
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'tiktok-capi-server' });
});

/** GET|POST /capture — lưu tạm thông tin lead theo click_id */
async function captureHandler(req, res) {
  try {
    const input = pickPayload(req);

    if (!ensureServerKey(req, input)) {
      return res.status(401).json({ success: false, error: 'Invalid or missing server_key' });
    }

    const clickId = clean(input.click_id);
    if (!clickId) {
      return res.status(400).json({ success: false, error: 'Missing required parameter: click_id' });
    }

    const emailHash      = normalizeIdentifier('email',        input.email);
    const phoneHash      = normalizeIdentifier('phone_number', input.phone_number);
    const externalIdHash = normalizeIdentifier('external_id',  input.external_id);
    const pageUrl        = normalizePageUrl(input.url);
    const ip             = getClientIp(req, input);
    const userAgent      = clean(input.user_agent) || clean(req.headers['user-agent']);

    const { expiresAt, ttl } = saveLead(clickId, {
      email_hash:       emailHash,
      phone_hash:       phoneHash,
      external_id_hash: externalIdHash,
      page_url:         pageUrl,
      ip,
      user_agent:       userAgent,
    });

    return res.status(200).json({
      success:          true,
      message:          'Lead cache saved',
      click_id:         clickId,
      expires_in_seconds: ttl,
      expires_at:       expiresAt,
      stored_fields: {
        email:        !!emailHash,
        phone_number: !!phoneHash,
        external_id:  !!externalIdHash,
      },
    });
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({
      success: false,
      error:   error.message || 'Internal Server Error',
    });
  }
}

/** GET|POST / and /track — forward event to TikTok CAPI */
async function trackHandler(req, res) {
  try {
    const {
      accessToken,
      pixelCode,
      payload,
      clickId,
      enriched,
      enrichmentSource,
      enrichmentWarning,
    } = buildTikTokPayload(req);

    const result = await sendToTikTok(accessToken, payload);

    const tiktokCode = result?.tiktok?.code;
    const success    = result.ok && (tiktokCode === undefined || tiktokCode === 0);

    const responseBody = {
      success,
      pixel_code:   pixelCode,
      access_token: maskSecret(accessToken),
      sent_payload: getDebugPayload(payload),
      result,
    };

    // Enrichment info — always return if click_id was provided
    if (clickId !== undefined && clickId !== null) {
      responseBody.click_id           = clickId;
      responseBody.enriched           = enriched;
      responseBody.enrichment_source  = enrichmentSource;
      responseBody.enrichment_warning = enrichmentWarning;
    }

    return res.status(success ? 200 : 502).json(responseBody);
  } catch (error) {
    const status = error.status || 500;
    return res.status(status).json({
      success: false,
      error:   error.message || 'Internal Server Error',
    });
  }
}

/** GET /cache/stats — thống kê cache, yêu cầu server_key */
async function cacheStatsHandler(req, res) {
  try {
    const input = pickPayload(req);

    if (!ensureServerKey(req, input)) {
      return res.status(401).json({ success: false, error: 'Invalid or missing server_key' });
    }

    const stats = getCacheStats();
    return res.json({ success: true, ...stats });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error:   error.message || 'Internal Server Error',
    });
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

app.get('/capture',     captureHandler);
app.post('/capture',    captureHandler);

app.get('/cache/stats', cacheStatsHandler);

// Main track endpoints — backward compatible
app.get('/',      trackHandler);
app.post('/',     trackHandler);
app.get('/track', trackHandler);
app.post('/track', trackHandler);

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`TikTok CAPI server listening on port ${PORT}`);
});