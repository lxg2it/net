import express from 'express';
import cors from 'cors';
import path from 'path';
import { getDashboardArticles, getCountBySource, getArticleStats, markRead, markSaved, markUnread, initDb, getUserByToken, createUser, listUsers, deleteUser, getUserByUsername } from './db';
import { runFetchAll } from '../fetchers/orchestrator';
import type { DashboardData } from '../types';

const app = express();
const PORT = parseInt(process.env.PORT || '3006', 10);

app.use(cors());
app.use(express.json());

// Auth middleware — extracts user from ?t= param or net_token cookie
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      username?: string;
      authenticated?: boolean;
    }
  }
}

function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  // Check query param first, then cookie
  const token = (req.query.t as string) ||
    (req.headers.cookie ? parseCookies(req.headers.cookie)['net_token'] : null);

  if (token) {
    const user = getUserByToken(token);
    if (user) {
      req.userId = user.id;
      req.username = user.username;
      req.authenticated = true;
      // If authed via query param, set persistent cookie
      if (req.query.t) {
        res.cookie('net_token', token, {
          maxAge: 365 * 24 * 60 * 60 * 1000,
          httpOnly: true,
          sameSite: 'lax',
          secure: true,
        });
      }
      return next();
    }
  }
  // Fall back to default user
  req.userId = 'default';
  req.username = 'scott';
  req.authenticated = false;
  next();
}

// Admin middleware — requires a valid token for the 'scott' (default) user.
// Prevents the unauthenticated fallback from gaining admin access.
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!req.authenticated || req.username !== 'scott') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  header.split(';').forEach(c => {
    const eq = c.indexOf('=');
    if (eq > 0) cookies[c.substring(0, eq).trim()] = c.substring(eq + 1).trim();
  });
  return cookies;
}

app.use(authMiddleware);

// Serve static files from public/
app.use(express.static(path.join(__dirname, '..', '..', 'public')));

// --- API Routes ---

// GET /api/me — current user info
app.get('/api/me', (req, res) => {
  res.json({ user_id: req.userId, username: req.username, is_admin: req.authenticated && req.username === 'scott' });
});

// --- Admin: user management ---

// GET /api/admin/users — list all users (admin only)
app.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ users: listUsers() });
});

// POST /api/admin/users — create a new user with a fresh token (admin only)
app.post('/api/admin/users', requireAdmin, (req, res) => {
  const { username, display_name } = req.body || {};
  if (!username || typeof username !== 'string' || !/^[a-zA-Z0-9_-]{1,32}$/.test(username)) {
    res.status(400).json({ error: 'Username must be 1-32 chars of a-z, A-Z, 0-9, _ or -' });
    return;
  }
  if (getUserByUsername(username)) {
    res.status(409).json({ error: 'Username already exists' });
    return;
  }
  const displayName = typeof display_name === 'string' && display_name.trim()
    ? display_name.trim().slice(0, 64)
    : null;
  const user = createUser(username, displayName);
  res.json({ user });
});

// DELETE /api/admin/users/:id — remove a user and their read state (admin only)
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  if (id === 'default') {
    res.status(400).json({ error: 'Cannot delete the default admin user' });
    return;
  }
  if (deleteUser(id)) {
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

// POST /api/admin/users/:id/rotate-token — rotate a user's token (admin only)
app.post('/api/admin/users/:id/rotate-token', requireAdmin, (req, res) => {
  const { id } = req.params;
  if (id === 'default') {
    res.status(400).json({ error: 'Cannot rotate the default admin token via this endpoint (would lock out all existing logins)' });
    return;
  }
  const user = rotateUserToken(id);
  if (user) {
    res.json({ user });
  } else {
    res.status(404).json({ error: 'User not found' });
  }
});

// GET /api/dashboard — main dashboard data
app.get('/api/dashboard', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const articles = getDashboardArticles(limit, offset, req.userId!);
    const stats = getArticleStats(req.userId!);
    const bySource = getCountBySource();

    const data: DashboardData = {
      total_unread: stats.unread,
      total_saved: stats.saved,
      articles: articles.map(a => ({
        ...a,
        state: a.state as 'unread' | 'read' | 'saved',
        matched_interests: typeof a.matched_interests === 'string'
          ? JSON.parse(a.matched_interests)
          : a.matched_interests,
      })),
      by_source: bySource,
    };

    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/articles — paginated article list
app.get('/api/articles', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const state = req.query.state as string | undefined; // 'unread', 'read', 'saved'

    // Simplified: using the dashboard query for now
    let articles = getDashboardArticles(limit + offset, 0);

    if (state) {
      articles = articles.filter(a => a.state === state);
    }

    // Manual offset/filter
    articles = articles.slice(offset, offset + limit);

    res.json(articles);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats — quick stats
app.get('/api/stats', (req, res) => {
  try {
    const stats = getArticleStats(req.userId!);
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mark-read — mark article(s) as read
app.post('/api/mark-read', (req, res) => {
  try {
    const { article_ids } = req.body;
    if (!article_ids || !Array.isArray(article_ids)) {
      return res.status(400).json({ error: 'article_ids array required' });
    }
    for (const id of article_ids) {
      markRead(id, req.userId!);
    }
    res.json({ marked: article_ids.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/mark-unread — mark article(s) as unread
app.post('/api/mark-unread', (req, res) => {
  try {
    const { article_ids } = req.body;
    if (!article_ids || !Array.isArray(article_ids)) {
      return res.status(400).json({ error: 'article_ids array required' });
    }
    for (const id of article_ids) {
      markUnread(id, req.userId!);
    }
    res.json({ marked: article_ids.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/save — save article(s)
app.post('/api/save', (req, res) => {
  try {
    const { article_ids } = req.body;
    if (!article_ids || !Array.isArray(article_ids)) {
      return res.status(400).json({ error: 'article_ids array required' });
    }
    for (const id of article_ids) {
      markSaved(id, req.userId!);
    }
    res.json({ saved: article_ids.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fetch — trigger a fetch run
app.post('/api/fetch', async (req, res) => {
  try {
    const job = await runFetchAll();
    res.json(job);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Serve index.html for all other routes (SPA-like)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, '..', '..', 'public', 'index.html'));
});

// Auto-fetch scheduler — runs periodically to keep articles fresh
// Default 15 minutes, configurable via FETCH_INTERVAL_MINUTES env var
let fetchTimer: ReturnType<typeof setTimeout> | null = null;
let isFetching = false;
let consecutiveFailures = 0;
const MAX_BACKOFF_MIN = 120; // max backoff: 2 hours

function scheduleNextFetch(): void {
  const baseIntervalMin = parseInt(process.env.FETCH_INTERVAL_MINUTES || '15', 10);
  // Exponential backoff: baseInterval * 2^failures, capped at MAX_BACKOFF_MIN
  const backoff = Math.min(baseIntervalMin * Math.pow(2, consecutiveFailures), MAX_BACKOFF_MIN);
  const intervalMs = backoff * 60 * 1000;

  fetchTimer = setTimeout(async () => {
    if (isFetching) {
      console.log('[net] Skipping auto-fetch — previous run still in progress');
      scheduleNextFetch();
      return;
    }

    isFetching = true;
    try {
      console.log('[net] Auto-fetch starting...');
      const job = await runFetchAll();
      const totalNew = job.results.reduce((sum: number, r: any) => sum + r.articles_new, 0);
      console.log(`[net] Auto-fetch complete: ${totalNew} new articles`);
      consecutiveFailures = 0; // Reset on success
    } catch (err: any) {
      consecutiveFailures++;
      const nextBackoff = Math.min(baseIntervalMin * Math.pow(2, consecutiveFailures), MAX_BACKOFF_MIN);
      console.error(`[net] Auto-fetch failed (${consecutiveFailures} consecutive): ${err.message}. Next attempt in ${nextBackoff}min`);
    } finally {
      isFetching = false;
      scheduleNextFetch();
    }
  }, intervalMs);
}

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`🕸️  Net running on http://localhost:${PORT}`);
    const intervalMin = parseInt(process.env.FETCH_INTERVAL_MINUTES || '15', 10);
    console.log(`[net] Auto-fetch every ${intervalMin} minutes`);

    // Run first fetch after 10 seconds, then schedule recurring
    setTimeout(async () => {
      if (!isFetching) {
        isFetching = true;
        try {
          console.log('[net] Auto-fetch starting...');
          const job = await runFetchAll();
          const totalNew = job.results.reduce((sum, r) => sum + r.articles_new, 0);
          console.log(`[net] Auto-fetch complete: ${totalNew} new articles`);
        } catch (err: any) {
          console.error('[net] Auto-fetch failed:', err.message);
        } finally {
          isFetching = false;
          scheduleNextFetch();
        }
      }
    }, 10_000);
  });
}

start().catch(err => {
  console.error('Failed to start Net:', err);
  process.exit(1);
});

export default app;
