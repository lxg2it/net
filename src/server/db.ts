import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic, QueryExecResult } from 'sql.js';
import path from 'path';
import fs from 'fs';
import { randomBytes } from 'crypto';
import type { NetSource, NetArticle, NetReadState, NetInterest } from '../types';

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'net.db');
const DEFAULT_USER = 'default';

// --- Users ---

export function getUserByToken(token: string): { id: string; username: string; display_name: string } | null {
  return execOne(
    'SELECT id, username, display_name FROM net_users WHERE token = ?',
    [token]
  ) as { id: string; username: string; display_name: string } | null;
}

export function getUserById(userId: string): { id: string; username: string; display_name: string } | null {
  return execOne(
    'SELECT id, username, display_name FROM net_users WHERE id = ?',
    [userId]
  ) as { id: string; username: string; display_name: string } | null;
}

export function createUser(username: string, displayName: string | null): { id: string; username: string; display_name: string; token: string } {
  const id = generateId();
  const token = generateToken();
  run(
    `INSERT INTO net_users (id, username, display_name, token) VALUES (?, ?, ?, ?)`,
    [id, username, displayName || username, token]
  );
  return { id, username, display_name: displayName || username, token };
}

export function listUsers(): { id: string; username: string; display_name: string; token: string | null; created_at: string }[] {
  return execAndReturn(
    `SELECT id, username, display_name, token, created_at FROM net_users ORDER BY created_at ASC`
  );
}

export function deleteUser(userId: string): boolean {
  const user = getUserById(userId);
  if (!user) return false;
  // Clean up their read state too
  run(`DELETE FROM net_read_state WHERE user_id = ?`, [userId]);
  run(`DELETE FROM net_users WHERE id = ?`, [userId]);
  return true;
}

export function getUserByUsername(username: string): { id: string; username: string } | null {
  return execOne(`SELECT id, username FROM net_users WHERE username = ?`, [username]);
}

function generateToken(): string {
  // 32 hex chars of crypto randomness — URL-safe, no ambiguity
  return randomBytes(16).toString('hex');
}


let SQL: SqlJsStatic | null = null;
let db: Database | null = null;
let dbMtime = 0;

export async function initDb(): Promise<void> {
  if (db) return;
  SQL = await initSqlJs();

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let recoveryMode = false;
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    try {
      db = new SQL.Database(buffer);
      // Verify the DB is functional before committing to it
      db.exec('SELECT 1');
    } catch (err: any) {
      console.error(`[net] Database corrupted, creating fresh: ${DB_PATH}`, err.message);
      // Backup the corrupt file for forensic analysis
      const backupPath = DB_PATH + `.corrupt.${Date.now()}`;
      fs.copyFileSync(DB_PATH, backupPath);
      console.log(`[net] Corrupt DB backed up to ${backupPath}`);
      db = new SQL.Database();
      recoveryMode = true;
    }
  } else {
    db = new SQL.Database();
  }

  dbMtime = Date.now();
  db.run('PRAGMA foreign_keys = ON');
  initSchema();
  runMigrations();
  if (recoveryMode) saveDb();
}

function reloadIfStale(): void {
  if (!SQL || !fs.existsSync(DB_PATH)) return;
  const fileMtime = fs.statSync(DB_PATH).mtimeMs;
  if (fileMtime > dbMtime) {
    const buffer = fs.readFileSync(DB_PATH);
    try {
      const newDb = new SQL.Database(buffer);
      newDb.exec('SELECT 1'); // Verify before replacing in-memory DB
      newDb.run('PRAGMA foreign_keys = ON');
      db = newDb;
      dbMtime = fileMtime;
    } catch (err: any) {
      console.error(`[net] Reload failed, keeping in-memory DB. Corrupt file reverted.`, err.message);
      // Don't replace the working in-memory DB with a corrupt file
    }
  }
}

function getDb(): Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  reloadIfStale();
  return db;
}

function saveDb(): void {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
  dbMtime = fs.statSync(DB_PATH).mtimeMs;
}

function initSchema(): void {
  const schemaPath = path.join(__dirname, '..', '..', 'sql', 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    getDb().run(schema);
    saveDb();
  }
}

function runMigrations(): void {
  const d = getDb();
  let migrated = false;

  // Migration 1: Add user_id column to net_read_state if not present
  // (and drop the old single-column primary key to allow composite PK)
  try {
    d.run('SELECT user_id FROM net_read_state LIMIT 1');
  } catch {
    // Column doesn't exist — migrate
    d.run('DROP TABLE IF EXISTS net_read_state_old');
    d.run('ALTER TABLE net_read_state RENAME TO net_read_state_old');
    d.run(`
      CREATE TABLE net_read_state (
        user_id TEXT NOT NULL DEFAULT 'default',
        article_id TEXT NOT NULL REFERENCES net_articles(id) ON DELETE CASCADE,
        state TEXT NOT NULL DEFAULT 'unread' CHECK (state IN ('unread', 'read', 'saved')),
        read_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, article_id)
      )
    `);
    // Copy existing rows, defaulting user_id
    const oldState = d.exec('SELECT article_id, state, read_at, created_at, updated_at FROM net_read_state_old');
    if (oldState.length > 0 && oldState[0].values) {
      for (const row of oldState[0].values) {
        const [article_id, state, read_at, created_at, updated_at] = row;
        d.run(
          `INSERT OR REPLACE INTO net_read_state (user_id, article_id, state, read_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ['default', article_id, state, read_at, created_at, updated_at]
        );
      }
    }
    d.run('DROP TABLE IF EXISTS net_read_state_old');
    migrated = true;
  }

  // Migration 2: Ensure default user exists
  const userCheck = d.exec("SELECT 1 FROM net_users WHERE id = 'default'");
  if (userCheck.length === 0 || !userCheck[0].values || userCheck[0].values.length === 0) {
    try {
      d.run("INSERT OR IGNORE INTO net_users (id, username, display_name) VALUES ('default', 'scott', 'Scott')");
      migrated = true;
    } catch {
      // net_users table might not exist yet — schema.sql handles creation
    }
  }

  // Migration 3: Add token column to net_users
  try {
    d.run('SELECT token FROM net_users LIMIT 1');
  } catch {
    d.run('ALTER TABLE net_users ADD COLUMN token TEXT');
    d.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_net_users_token ON net_users(token)');
    d.run("UPDATE net_users SET token = 'scott-net-7x9k2m' WHERE id = 'default'");
    migrated = true;
  }

  if (migrated) saveDb();
}

// Helper: convert exec result columns+values arrays into objects
function rowsToObjects<T>(result: QueryExecResult | null): T[] {
  if (!result || !result.columns.length) return [];
  const { columns, values } = result;
  return values.map((row: any[]) => {
    const obj: any = {};
    columns.forEach((col: string, i: number) => {
      obj[col] = row[i];
    });
    return obj as T;
  });
}

function execAndReturn<T>(sql: string, params?: any[]): T[] {
  const d = getDb();
  let query = sql;
  if (params && params.length > 0) {
    let idx = 0;
    query = sql.replace(/\?/g, () => {
      const val = params[idx++];
      if (val === null || val === undefined) return 'NULL';
      if (typeof val === 'number') return String(val);
      return `'${String(val).replace(/'/g, "''")}'`;
    });
  }
  const results = d.exec(query);
  return results.length > 0 ? rowsToObjects<T>(results[0]) as T[] : [];
}

function execOne<T>(sql: string, params?: any[]): T | null {
  const rows = execAndReturn<T>(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function run(sql: string, params?: any[]): void {
  const d = getDb();
  let query = sql;
  if (params && params.length > 0) {
    let idx = 0;
    query = sql.replace(/\?/g, () => {
      const val = params[idx++];
      if (val === null || val === undefined) return 'NULL';
      if (typeof val === 'number') return String(val);
      return `'${String(val).replace(/'/g, "''")}'`;
    });
  }
  d.run(query);
  saveDb();
}

// --- Sources ---

export function getEnabledSources(): NetSource[] {
  const raw = execAndReturn<NetSource>(
    'SELECT * FROM net_sources WHERE enabled = 1 ORDER BY source_type, label'
  );
  return raw.map(s => ({
    ...s,
    config: typeof s.config === 'string' ? JSON.parse(s.config) : s.config,
  }));
}

export function updateSourceLastFetched(sourceId: string): void {
  run(
    "UPDATE net_sources SET last_fetched_at = datetime('now'), error_count = 0 WHERE id = ?",
    [sourceId]
  );
}

export function incrementSourceErrorCount(sourceId: string): void {
  run(
    'UPDATE net_sources SET error_count = error_count + 1 WHERE id = ?',
    [sourceId]
  );
}

// --- Articles ---

export function articleExistsByHash(contentHash: string): boolean {
  const row = execOne('SELECT 1 as found FROM net_articles WHERE content_hash = ? LIMIT 1', [contentHash]);
  return !!row;
}

export function articleExistsByFingerprint(fingerprint: string): boolean {
  const row = execOne('SELECT 1 as found FROM net_articles WHERE fingerprint = ? LIMIT 1', [fingerprint]);
  return !!row;
}

export function insertArticle(
  article: Omit<NetArticle, 'id' | 'fetched_at'>
): NetArticle {
  const id = generateId();
  const now = new Date().toISOString();
  const matchedInterests = article.matched_interests
    ? JSON.stringify(article.matched_interests)
    : null;

  run(
    `INSERT INTO net_articles (id, source_id, title, url, snippet, author, published_at, fetched_at, content_hash, fingerprint, interest_score, matched_interests)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      article.source_id,
      article.title,
      article.url,
      article.snippet || null,
      article.author || null,
      article.published_at || null,
      now,
      article.content_hash,
      article.fingerprint,
      article.interest_score,
      matchedInterests,
    ]
  );

  return {
    id,
    source_id: article.source_id,
    title: article.title,
    url: article.url,
    snippet: article.snippet || null,
    author: article.author || null,
    published_at: article.published_at || null,
    fetched_at: now,
    content_hash: article.content_hash,
    fingerprint: article.fingerprint,
    interest_score: article.interest_score,
    matched_interests: article.matched_interests || null,
  };
}

export function logDedup(articleId: string, duplicateOf: string, reason: string): void {
  run(
    "INSERT INTO net_dedup_log (article_id, duplicate_of, reason, created_at) VALUES (?, ?, ?, datetime('now'))",
    [articleId, duplicateOf, reason]
  );
}

// --- Read State (per-user, default user) ---

export function ensureReadState(articleId: string, userId: string = DEFAULT_USER): void {
  run(
    "INSERT OR IGNORE INTO net_read_state (user_id, article_id, state, created_at, updated_at) VALUES (?, ?, 'unread', datetime('now'), datetime('now'))",
    [userId, articleId]
  );
}

export function markRead(articleId: string, userId: string = DEFAULT_USER): void {
  run(
    `INSERT OR REPLACE INTO net_read_state (user_id, article_id, state, read_at, updated_at, created_at)
     VALUES (?, ?, 'read', datetime('now'), datetime('now'),
     COALESCE((SELECT created_at FROM net_read_state WHERE user_id = ? AND article_id = ?), datetime('now')))`,
    [userId, articleId, userId, articleId]
  );
}

export function markSaved(articleId: string, userId: string = DEFAULT_USER): void {
  run(
    `INSERT OR REPLACE INTO net_read_state (user_id, article_id, state, read_at, updated_at, created_at)
     VALUES (?, ?, 'saved', NULL, datetime('now'),
     COALESCE((SELECT created_at FROM net_read_state WHERE user_id = ? AND article_id = ?), datetime('now')))`,
    [userId, articleId, userId, articleId]
  );
}

export function markUnread(articleId: string, userId: string = DEFAULT_USER): void {
  run(
    `INSERT OR REPLACE INTO net_read_state (user_id, article_id, state, read_at, updated_at, created_at)
     VALUES (?, ?, 'unread', NULL, datetime('now'),
     COALESCE((SELECT created_at FROM net_read_state WHERE user_id = ? AND article_id = ?), datetime('now')))`,
    [userId, articleId, userId, articleId]
  );
}

// --- Interests ---

export function getAllInterests(): NetInterest[] {
  return execAndReturn<NetInterest>(
    'SELECT * FROM net_interests ORDER BY category, weight DESC'
  );
}

// --- Dashboard queries ---

export function getDashboardArticles(
  limit: number = 50,
  offset: number = 0,
  userId: string = DEFAULT_USER
): Array<NetArticle & { state: string; read_at: string | null; source_label: string }> {
  return execAndReturn<NetArticle & { state: string; read_at: string | null; source_label: string }>(
    `SELECT a.*, COALESCE(rs.state, 'unread') as state, rs.read_at, s.label as source_label
     FROM net_articles a
     LEFT JOIN net_read_state rs ON a.id = rs.article_id AND rs.user_id = '${userId}'
     JOIN net_sources s ON a.source_id = s.id
     ORDER BY a.published_at DESC
     LIMIT ${limit} OFFSET ${offset}`
  );
}

export function getArticleStats(userId: string = DEFAULT_USER): { total: number; unread: number; saved: number } {
  const totalRow = execOne<{ c: number }>('SELECT COUNT(*) as c FROM net_articles');
  const unreadRow = execOne<{ c: number }>(
    `SELECT COUNT(*) as c FROM net_articles a
     LEFT JOIN net_read_state rs ON a.id = rs.article_id AND rs.user_id = '${userId}'
     WHERE rs.state IS NULL OR rs.state = 'unread'`
  );
  const savedRow = execOne<{ c: number }>(
    `SELECT COUNT(*) as c FROM net_read_state WHERE state = 'saved' AND user_id = '${userId}'`
  );
  return {
    total: totalRow?.c || 0,
    unread: unreadRow?.c || 0,
    saved: savedRow?.c || 0,
  };
}

export function getCountBySource(): Record<string, number> {
  const rows = execAndReturn<{ label: string; count: number }>(
    `SELECT s.label, COUNT(a.id) as count
     FROM net_sources s
     LEFT JOIN net_articles a ON a.source_id = s.id
     GROUP BY s.id, s.label
     ORDER BY count DESC`
  );
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.label] = row.count;
  }
  return result;
}

// --- Helpers ---

function generateId(): string {
  const hex = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
  return hex;
}

export function rotateUserToken(userId: string): { id: string; username: string; token: string } | null {
  const user = getUserById(userId);
  if (!user) return null;
  const token = generateToken();
  run(`UPDATE net_users SET token = ? WHERE id = ?`, [token, userId]);
  return { id: user.id, username: user.username, token };
}
