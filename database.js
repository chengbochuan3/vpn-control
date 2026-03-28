const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'vpn-control.db');

let db;

function initDb(defaultSubscriptions) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS shares (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      max_uses INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0,
      revoked INTEGER NOT NULL DEFAULT 0,
      subscription_ids TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS health_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      response_time_ms INTEGER,
      checked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 100,
      is_main INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      upload BIGINT DEFAULT 0,
      download BIGINT DEFAULT 0,
      total BIGINT DEFAULT 0,
      expire INTEGER DEFAULT 0,
      info_updated_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrate: add new columns if missing (for existing databases)
  const cols = db.prepare("PRAGMA table_info(subscriptions)").all().map(c => c.name);
  if (!cols.includes('upload')) {
    db.exec(`
      ALTER TABLE subscriptions ADD COLUMN upload BIGINT DEFAULT 0;
      ALTER TABLE subscriptions ADD COLUMN download BIGINT DEFAULT 0;
      ALTER TABLE subscriptions ADD COLUMN total BIGINT DEFAULT 0;
      ALTER TABLE subscriptions ADD COLUMN expire INTEGER DEFAULT 0;
      ALTER TABLE subscriptions ADD COLUMN info_updated_at TEXT;
    `);
  }
  const shareCols = db.prepare("PRAGMA table_info(shares)").all().map(c => c.name);
  if (!shareCols.includes('subscription_ids')) {
    db.exec(`ALTER TABLE shares ADD COLUMN subscription_ids TEXT;`);
  }

  // Seed default subscriptions if table is empty
  const count = db.prepare('SELECT COUNT(*) as c FROM subscriptions').get().c;
  if (count === 0 && defaultSubscriptions) {
    const insert = db.prepare(
      'INSERT INTO subscriptions (name, url, priority, is_main) VALUES (?, ?, ?, ?)'
    );
    for (const sub of defaultSubscriptions) {
      insert.run(sub.name, sub.url, sub.priority, sub.is_main);
    }
    console.log(`[db] Seeded ${defaultSubscriptions.length} default subscriptions`);
  }

  return db;
}

// ---------------------------------------------------------------------------
// Shares
// ---------------------------------------------------------------------------
function createShare(label, maxUses, subscriptionIds) {
  const token = crypto.randomUUID();
  const subIdsJson = subscriptionIds ? JSON.stringify(subscriptionIds) : null;
  db.prepare(
    'INSERT INTO shares (token, label, max_uses, subscription_ids) VALUES (?, ?, ?, ?)'
  ).run(token, label || '', maxUses || null, subIdsJson);
  return getShareByToken(token);
}

function getShareByToken(token) {
  return db.prepare('SELECT * FROM shares WHERE token = ?').get(token);
}

function incrementUseCount(token) {
  db.prepare(
    "UPDATE shares SET use_count = use_count + 1, last_used_at = datetime('now') WHERE token = ?"
  ).run(token);
}

function listShares() {
  return db.prepare('SELECT * FROM shares ORDER BY created_at DESC').all();
}

function revokeShare(token) {
  return db.prepare('UPDATE shares SET revoked = 1 WHERE token = ?').run(token);
}

function unrevokeShare(token) {
  return db.prepare('UPDATE shares SET revoked = 0 WHERE token = ?').run(token);
}

function deleteShare(token) {
  return db.prepare('DELETE FROM shares WHERE token = ?').run(token);
}

function updateShareMaxUses(token, maxUses) {
  return db.prepare('UPDATE shares SET max_uses = ? WHERE token = ?').run(
    maxUses || null,
    token
  );
}

// ---------------------------------------------------------------------------
// Subscriptions CRUD
// ---------------------------------------------------------------------------
function listSubscriptions() {
  return db
    .prepare('SELECT * FROM subscriptions ORDER BY priority ASC, id ASC')
    .all();
}

function getSubscription(id) {
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
}

function getSubscriptionsByIds(ids) {
  if (!ids || ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM subscriptions WHERE id IN (${placeholders}) AND enabled = 1 ORDER BY is_main DESC, priority ASC, id ASC`)
    .all(...ids);
}

function addSubscription(name, url, priority, isMain) {
  if (isMain) {
    db.prepare('UPDATE subscriptions SET is_main = 0').run();
  }
  const result = db.prepare(
    'INSERT INTO subscriptions (name, url, priority, is_main) VALUES (?, ?, ?, ?)'
  ).run(name, url, priority ?? 100, isMain ? 1 : 0);
  return getSubscription(result.lastInsertRowid);
}

function updateSubscription(id, fields) {
  const sub = getSubscription(id);
  if (!sub) return null;
  if (fields.is_main) {
    db.prepare('UPDATE subscriptions SET is_main = 0').run();
  }
  const name = fields.name ?? sub.name;
  const url = fields.url ?? sub.url;
  const priority = fields.priority ?? sub.priority;
  const isMain = fields.is_main !== undefined ? (fields.is_main ? 1 : 0) : sub.is_main;
  const enabled = fields.enabled !== undefined ? (fields.enabled ? 1 : 0) : sub.enabled;
  db.prepare(
    'UPDATE subscriptions SET name = ?, url = ?, priority = ?, is_main = ?, enabled = ? WHERE id = ?'
  ).run(name, url, priority, isMain, enabled, id);
  return getSubscription(id);
}

function updateSubscriptionInfo(id, upload, download, total, expire) {
  db.prepare(
    "UPDATE subscriptions SET upload = ?, download = ?, total = ?, expire = ?, info_updated_at = datetime('now') WHERE id = ?"
  ).run(upload || 0, download || 0, total || 0, expire || 0, id);
}

function deleteSubscription(id) {
  return db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id);
}

function getEnabledSubscriptions() {
  return db
    .prepare(
      'SELECT * FROM subscriptions WHERE enabled = 1 ORDER BY is_main DESC, priority ASC, id ASC'
    )
    .all();
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
function logHealth(url, name, status, responseTimeMs) {
  db.prepare(
    'INSERT INTO health_log (url, name, status, response_time_ms) VALUES (?, ?, ?, ?)'
  ).run(url, name, status, responseTimeMs);

  db.prepare(
    `DELETE FROM health_log WHERE url = ? AND id NOT IN (
      SELECT id FROM health_log WHERE url = ? ORDER BY id DESC LIMIT 500
    )`
  ).run(url, url);
}

function getHealthHistory(limit = 50) {
  return db
    .prepare('SELECT * FROM health_log ORDER BY id DESC LIMIT ?')
    .all(limit);
}

function getLatestHealth() {
  return db
    .prepare(
      `SELECT h.* FROM health_log h
       INNER JOIN (SELECT url, MAX(id) as max_id FROM health_log GROUP BY url) latest
       ON h.url = latest.url AND h.id = latest.max_id`
    )
    .all();
}

module.exports = {
  initDb,
  createShare,
  getShareByToken,
  incrementUseCount,
  listShares,
  revokeShare,
  unrevokeShare,
  deleteShare,
  updateShareMaxUses,
  listSubscriptions,
  getSubscription,
  getSubscriptionsByIds,
  addSubscription,
  updateSubscription,
  updateSubscriptionInfo,
  deleteSubscription,
  getEnabledSubscriptions,
  logHealth,
  getHealthHistory,
  getLatestHealth,
};
