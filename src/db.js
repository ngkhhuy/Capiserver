import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_PATH = process.env.LEAD_CACHE_DB_PATH || './data/capi-cache.db';
export const TTL = Number(process.env.LEAD_CACHE_TTL_SECONDS || 10800);
const CLEANUP_INTERVAL_MS =
  Number(process.env.LEAD_CACHE_CLEANUP_INTERVAL_SECONDS || 600) * 1000;

const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ---------------------------------------------------------------------------
// Schema migration  (user_version tracks schema version)
// v0 = original schema: click_id TEXT PRIMARY KEY (no vl_clickid)
// v1 = has vl_clickid but may be missing ttclid/ttp/referrer
// v2 = current full schema
// ---------------------------------------------------------------------------
const TARGET_VERSION = 2;

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_cache (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      vl_clickid       TEXT    UNIQUE NOT NULL,
      click_id         TEXT,
      email_hash       TEXT,
      phone_hash       TEXT,
      external_id_hash TEXT,
      ttclid           TEXT,
      ttp              TEXT,
      page_url         TEXT,
      referrer         TEXT,
      ip               TEXT,
      user_agent       TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      expires_at       INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lead_expires ON lead_cache (expires_at);
  `);
}

(function runMigrations() {
  const ver = db.pragma('user_version', { simple: true });
  if (ver >= TARGET_VERSION) return;

  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='lead_cache'")
    .get();

  if (!tableExists) {
    createSchema();
  } else {
    const cols = db.prepare('PRAGMA table_info(lead_cache)').all().map((c) => c.name);

    if (!cols.includes('vl_clickid')) {
      // v0 → v2: full table migration
      console.log('[db] Migrating schema v0 → v2 ...');
      db.exec('ALTER TABLE lead_cache RENAME TO lead_cache_v0');
      createSchema();
      db.prepare(`
        INSERT OR IGNORE INTO lead_cache
          (vl_clickid, click_id, email_hash, phone_hash, external_id_hash,
           page_url, ip, user_agent, created_at, updated_at, expires_at)
        SELECT click_id, click_id, email_hash, phone_hash, external_id_hash,
               page_url, ip, user_agent, created_at, updated_at, expires_at
        FROM lead_cache_v0
      `).run();
      db.exec('DROP TABLE lead_cache_v0');
      console.log('[db] Migration v0 → v2 done.');
    } else {
      // v1 → v2: add missing columns
      for (const col of ['ttclid', 'ttp', 'referrer', 'click_id']) {
        if (!cols.includes(col)) {
          db.prepare(`ALTER TABLE lead_cache ADD COLUMN ${col} TEXT`).run();
          console.log(`[db] Added column: ${col}`);
        }
      }
    }
  }

  db.pragma(`user_version = ${TARGET_VERSION}`);
})();

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------
const stmtUpsert = db.prepare(`
  INSERT INTO lead_cache
    (vl_clickid, click_id, email_hash, phone_hash, external_id_hash,
     ttclid, ttp, page_url, referrer, ip, user_agent,
     created_at, updated_at, expires_at)
  VALUES
    (@vl_clickid, @click_id, @email_hash, @phone_hash, @external_id_hash,
     @ttclid, @ttp, @page_url, @referrer, @ip, @user_agent,
     @created_at, @updated_at, @expires_at)
  ON CONFLICT(vl_clickid) DO UPDATE SET
    click_id         = excluded.click_id,
    email_hash       = excluded.email_hash,
    phone_hash       = excluded.phone_hash,
    external_id_hash = excluded.external_id_hash,
    ttclid           = excluded.ttclid,
    ttp              = excluded.ttp,
    page_url         = excluded.page_url,
    referrer         = excluded.referrer,
    ip               = excluded.ip,
    user_agent       = excluded.user_agent,
    updated_at       = excluded.updated_at,
    expires_at       = excluded.expires_at
`);

const stmtGet        = db.prepare(`SELECT * FROM lead_cache WHERE vl_clickid = ?`);
const stmtDel        = db.prepare(`DELETE FROM lead_cache WHERE vl_clickid = ?`);
const stmtDelExpired = db.prepare(`DELETE FROM lead_cache WHERE expires_at <= ?`);
const stmtAll        = db.prepare(`SELECT COUNT(*) AS n FROM lead_cache`);
const stmtActive     = db.prepare(`SELECT COUNT(*) AS n FROM lead_cache WHERE expires_at > ?`);
const stmtExpired    = db.prepare(`SELECT COUNT(*) AS n FROM lead_cache WHERE expires_at <= ?`);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Save or overwrite a lead. matchKey = vl_clickid || click_id value. */
export function saveLead(matchKey, data) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + TTL;

  stmtUpsert.run({
    vl_clickid:       matchKey,
    click_id:         data.click_id         ?? null,
    email_hash:       data.email_hash        ?? null,
    phone_hash:       data.phone_hash        ?? null,
    external_id_hash: data.external_id_hash  ?? null,
    ttclid:           data.ttclid            ?? null,
    ttp:              data.ttp               ?? null,
    page_url:         data.page_url          ?? null,
    referrer:         data.referrer          ?? null,
    ip:               data.ip               ?? null,
    user_agent:       data.user_agent        ?? null,
    created_at:       now,
    updated_at:       now,
    expires_at:       expiresAt,
  });

  return { expiresAt, ttl: TTL };
}

/** Get non-expired lead. Returns null if not found or expired (auto-deletes). */
export function getLead(matchKey) {
  const now = Math.floor(Date.now() / 1000);
  const row = stmtGet.get(matchKey);
  if (!row) return null;
  if (row.expires_at <= now) {
    stmtDel.run(matchKey);
    return null;
  }
  return row;
}

/** Delete expired records. Returns count removed. */
export function cleanupExpired() {
  return stmtDelExpired.run(Math.floor(Date.now() / 1000)).changes;
}

/** Cache statistics. */
export function getCacheStats() {
  const now = Math.floor(Date.now() / 1000);
  return {
    total_records:   stmtAll.get().n,
    active_records:  stmtActive.get(now).n,
    expired_records: stmtExpired.get(now).n,
    ttl_seconds:     TTL,
  };
}

// Startup cleanup
const removed = cleanupExpired();
if (removed > 0) console.log(`[db] Startup: removed ${removed} expired lead(s).`);

// Periodic cleanup
setInterval(() => {
  const n = cleanupExpired();
  if (n > 0) console.log(`[db] Cleanup: removed ${n} expired lead(s).`);
}, CLEANUP_INTERVAL_MS).unref();
