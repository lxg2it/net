import initSqlJs from 'sql.js';
import type { Database, SqlJsStatic, QueryExecResult } from 'sql.js';
import path from 'path';
import fs from 'fs';
import type { NetSource, NetArticle, NetReadState, NetInterest } from '../types';

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'net.db');

let SQL: SqlJsStatic | null = null;
let db: Database | null = null;
let dbMtime = 0; // Track file modification time for external-change detection

export async function initDb(): Promise<void> {
  if (db) return;
  SQL = await initSqlJs();

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Load existing or create new
  if (fs.existsSync(DB_PATH)) {
    dbMtime = fs.statSync(DB_PATH).mtimeMs;
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
    dbMtime = Date.now();
  }

  db.run('PRAGMA foreign_keys = ON');
  initSchema();
}

function reloadIfStale(): void {
  if (!SQL || !fs.existsSync(DB_PATH)) return;
  const fileMtime = fs.statSync(DB_PATH).mtimeMs;
  if (fileMtime > dbMtime) {
    const buffer = fs.readFileSync(DB_PATH);
    const newDb = new SQL.Database(buffer);
    newDb.run('PRAGMA foreign_keys = ON');
    db = newDb;
    dbMtime = fileMtime;
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
  dbMtime = fs.statSync(DB_PATH).mtimeMs; // Track our own writes
}

function initSchema(): void {
  const schemaPath = path.join(__dirname, '..', '..', 'sql', 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    getDb().run(schema);
    saveDb();
  }
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
  // Bind params by replacing ? with values
  let query = sql;
  if (params && params.length > 0) {
    let idx = 0;
    query = sql.replace(/\?/g, () => {
      const val = params[idx++];
      if (val === null || val === undefined) return 'NULL';
      if (typeof val === 'number') return String(val);
      // String value: escape quotes
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
  // Parse JSON config from SQLite text storage
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

// --- Read State ---

export function ensureReadState(articleId: string): void {
  // SQLite: INSERT OR IGNORE
  run(
    "INSERT OR IGNORE INTO net_read_state (article_id, state, created_at, updated_at) VALUES (?, 'unread', datetime('now'), datetime('now'))",
    [articleId]
  );
}

export function markRead(articleId: string): void {
  run(
    "INSERT OR REPLACE INTO net_read_state (article_id, state, read_at, updated_at, created_at) VALUES (?, 'read', datetime('now'), datetime('now'), COALESCE((SELECT created_at FROM net_read_state WHERE article_id = ?), datetime('now')))",
    [articleId, articleId]
  );
}

export function markSaved(articleId: string): void {
  run(
    "INSERT OR REPLACE INTO net_read_state (article_id, state, read_at, updated_at, created_at) VALUES (?, 'saved', NULL, datetime('now'), COALESCE((SELECT created_at FROM net_read_state WHERE article_id = ?), datetime('now')))",
    [articleId, articleId]
  );
}

export function markUnread(articleId: string): void {
  run(
    "INSERT OR REPLACE INTO net_read_state (article_id, state, read_at, updated_at, created_at) VALUES (?, 'unread', NULL, datetime('now'), COALESCE((SELECT created_at FROM net_read_state WHERE article_id = ?), datetime('now')))",
    [articleId, articleId]
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
  offset: number = 0
): Array<NetArticle & { state: string; read_at: string | null; source_label: string }> {
  return execAndReturn<NetArticle & { state: string; read_at: string | null; source_label: string }>(
    `SELECT a.*, COALESCE(rs.state, 'unread') as state, rs.read_at, s.label as source_label
     FROM net_articles a
     LEFT JOIN net_read_state rs ON a.id = rs.article_id
     JOIN net_sources s ON a.source_id = s.id
     ORDER BY a.published_at DESC
     LIMIT ${limit} OFFSET ${offset}`
  );
}

export function getArticleStats(): { total: number; unread: number; saved: number } {
  const totalRow = execOne<{ c: number }>('SELECT COUNT(*) as c FROM net_articles');
  const unreadRow = execOne<{ c: number }>(
    `SELECT COUNT(*) as c FROM net_articles a
     LEFT JOIN net_read_state rs ON a.id = rs.article_id
     WHERE rs.state IS NULL OR rs.state = 'unread'`
  );
  const savedRow = execOne<{ c: number }>(
    "SELECT COUNT(*) as c FROM net_read_state WHERE state = 'saved'"
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
