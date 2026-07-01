import express from 'express';
import cors from 'cors';
import path from 'path';
import { getDashboardArticles, getCountBySource, getArticleStats, markRead, markSaved, markUnread, initDb } from './db';
import { runFetchAll } from '../fetchers/orchestrator';
import type { DashboardData } from '../types';

const app = express();
const PORT = parseInt(process.env.PORT || '3006', 10);

app.use(cors());
app.use(express.json());

// Serve static files from public/
app.use(express.static(path.join(__dirname, '..', '..', 'public')));

// --- API Routes ---

// GET /api/dashboard — main dashboard data
app.get('/api/dashboard', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const articles = getDashboardArticles(limit, offset);
    const stats = getArticleStats();
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
    const stats = getArticleStats();
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
      markRead(id);
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
      markUnread(id);
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
      markSaved(id);
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

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`🕸️  Net running on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start Net:', err);
  process.exit(1);
});

export default app;
