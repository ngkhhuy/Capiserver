import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.LEAD_CACHE_DB_PATH || './data/capi-cache.db';
export const TTL = Number(process.env.LEAD_CACHE_TTL_SECONDS || 10800);
const CLEANUP_INTERVAL_MS =
  Number(process.env.LEAD_CACHE_CLEANUP_INTERVAL_SECONDS || 600) * 1000;

// Ensure data/ directory exists
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(DB_PATH);

// WAL mode for better concurrency
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS lead_cache (
    click_id          TEXT PRIMARY KEY,
    email_hash        TEXT,
    phone_hash        TEXT,
    external_id_hash  TEXT,
    page_url          TEXT,
    ip                TEXT,
    user_agent        TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_expires_at ON lead_cache (expires_at);
`);

const stmtUpsert = db.prepare(`
  INSERT INTO lead_cache
    (click_id, email_hash, phone_hash, external_id_hash, page_url, ip, user_agent,
     created_at, updated_at, expires_at)
  VALUES
    (@click_id, @email_hash, @phone_hash, @external_id_hash, @page_url, @ip, @user_agent,
     @created_at, @updated_at, @expires_at)
  ON CONFLICT(click_id) DO UPDATE SET
    email_hash       = excluded.email_hash,
    phone_hash       = excluded.phone_hash,
    external_id_hash = excluded.external_id_hash,
    page_url         = excluded.page_url,
    ip               = excluded.ip,
    user_agent       = excluded.user_agent,
    updated_at       = excluded.updated_at,
    expires_at       = excluded.expires_at
`);

const stmtGet = db.prepare(
  `SELECT * FROM lead_cache WHERE click_id = ?`
);

const stmtDelete = db.prepare(
  `DELETE FROM lead_cache WHERE click_id = ?`
);

const stmtDeleteExpired = db.prepare(
  `DELETE FROM lead_cache WHERE expires_at <= ?`
);

const stmtCountAll     = db.prepare(`SELECT COUNT(*) AS n FROM lead_cache`);
const stmtCountActive  = db.prepare(`SELECT COUNT(*) AS n FROM lead_cache WHERE expires_at > ?`);
const stmtCountExpired = db.prepare(`SELECT COUNT(*) AS n FROM lead_cache WHERE expires_at <= ?`);

/**
 * Lưu hoặc ghi đè lead theo click_id.
 * Trả về { expiresAt, ttl }.
 */
export function saveLead(clickId, data) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + TTL;

  stmtUpsert.run({
    click_id:         clickId,
    email_hash:       data.email_hash        ?? null,
    phone_hash:       data.phone_hash        ?? null,
    external_id_hash: data.external_id_hash  ?? null,
    page_url:         data.page_url          ?? null,
    ip:               data.ip               ?? null,
    user_agent:       data.user_agent        ?? null,
    created_at:       now,
    updated_at:       now,
    expires_at:       expiresAt,
  });

  return { expiresAt, ttl: TTL };
}

/**
 * Lấy lead theo click_id. Trả null nếu không tồn tại hoặc đã hết hạn.
 * Tự động xoá record hết hạn.
 */
export function getLead(clickId) {
  const now = Math.floor(Date.now() / 1000);
  const row = stmtGet.get(clickId);

  if (!row) return null;

  if (row.expires_at <= now) {
    stmtDelete.run(clickId);
    return null;
  }

  return row;
}

/**
 * Xoá toàn bộ record hết hạn. Trả về số record đã xoá.
 */
export function cleanupExpired() {
  const now = Math.floor(Date.now() / 1000);
  const info = stmtDeleteExpired.run(now);
  return info.changes;
}

/**
 * Thống kê cache.
 */
export function getCacheStats() {
  const now = Math.floor(Date.now() / 1000);
  return {
    total_records:   stmtCountAll.get().n,
    active_records:  stmtCountActive.get(now).n,
    expired_records: stmtCountExpired.get(now).n,
    ttl_seconds:     TTL,
  };
}

// Cleanup khi khởi động
const startupRemoved = cleanupExpired();
if (startupRemoved > 0) {
  console.log(`[db] Startup cleanup: removed ${startupRemoved} expired lead(s).`);
}

// Cleanup định kỳ
setInterval(() => {
  const removed = cleanupExpired();
  if (removed > 0) {
    console.log(`[db] Periodic cleanup: removed ${removed} expired lead(s).`);
  }
}, CLEANUP_INTERVAL_MS).unref(); // unref() để không giữ process nếu server graceful exit
