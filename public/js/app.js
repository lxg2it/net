// Net — Frontend App

const API = '/api';
let currentFilter = 'all';
let currentSource = '';
let articles = [];

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
  setupFilters();
  setupRefresh();
  loadDashboard();
});

// --- API Calls ---
async function loadDashboard() {
  showLoading();
  try {
    const res = await fetch(`${API}/dashboard?limit=100`);
    const data = await res.json();
    articles = data.articles;
    updateStats(data);
    populateSourceFilter(data.by_source);
    renderArticles();
  } catch (err) {
    console.error('Failed to load dashboard:', err);
  }
  hideLoading();
}

async function markRead(ids) {
  await fetch(`${API}/mark-read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ article_ids: ids }),
  });
}

async function markUnread(ids) {
  await fetch(`${API}/mark-unread`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ article_ids: ids }),
  });
}

async function saveArticle(ids) {
  await fetch(`${API}/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ article_ids: ids }),
  });
}

async function triggerFetch() {
  const emptyEl = document.getElementById('empty');
  emptyEl.innerHTML = '<p>Fetching from all sources…</p>';
  try {
    const res = await fetch(`${API}/fetch`, { method: 'POST' });
    const job = await res.json();
    await loadDashboard();
  } catch (err) {
    console.error('Fetch failed:', err);
    emptyEl.innerHTML = '<p>Fetch failed. Check server logs.</p>';
  }
}

// --- Stats ---
function updateStats(data) {
  document.querySelector('.stat.unread').textContent = `${data.total_unread} unread`;
  document.querySelector('.stat.saved').textContent = `${data.total_saved} saved`;
  const total = data.articles.length;
  document.querySelector('.stat.total').textContent = `${total} total`;
}

function populateSourceFilter(bySource) {
  const select = document.getElementById('sourceFilter');
  // Keep the "All sources" option
  select.innerHTML = '<option value="">All sources</option>';
  if (bySource) {
    Object.keys(bySource).forEach(label => {
      const option = document.createElement('option');
      option.value = label;
      option.textContent = `${label} (${bySource[label]})`;
      select.appendChild(option);
    });
  }
}

// --- Filters ---
function setupFilters() {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderArticles();
    });
  });

  document.getElementById('sourceFilter').addEventListener('change', (e) => {
    currentSource = e.target.value;
    renderArticles();
  });
}

function setupRefresh() {
  document.getElementById('btnRefresh').addEventListener('click', loadDashboard);
  document.getElementById('btnFetch')?.addEventListener('click', triggerFetch);
}

// --- Rendering ---
function filterArticles() {
  let filtered = articles;

  if (currentFilter === 'unread') {
    filtered = filtered.filter(a => a.state !== 'read');
  } else if (currentFilter === 'saved') {
    filtered = filtered.filter(a => a.state === 'saved');
  }

  if (currentSource) {
    filtered = filtered.filter(a => a.source_label === currentSource);
  }

  return filtered;
}

function renderArticles() {
  const container = document.getElementById('articlesList');
  const emptyEl = document.getElementById('empty');
  const filtered = filterArticles();

  if (filtered.length === 0) {
    container.innerHTML = '';
    emptyEl.style.display = 'block';
    if (articles.length === 0) {
      emptyEl.innerHTML = '<p>No articles yet. Pull up your net!</p><button id="btnFetch" class="btn-fetch">Fetch Now</button>';
      document.getElementById('btnFetch')?.addEventListener('click', triggerFetch);
    } else {
      emptyEl.innerHTML = '<p>No articles match this filter.</p>';
    }
    return;
  }

  emptyEl.style.display = 'none';
  container.innerHTML = filtered.map(article => renderArticle(article)).join('');

  // Attach event listeners
  container.querySelectorAll('.article-card').forEach(card => {
    const id = card.dataset.id;
    const state = card.dataset.state;

    // Click to open + mark as read
    card.addEventListener('click', async (e) => {
      // Don't trigger if clicking a button
      if (e.target.tagName === 'BUTTON') return;
      window.open(card.dataset.url, '_blank');
      if (state !== 'read') {
        await markRead([id]);
        // Update locally
        const art = articles.find(a => a.id === id);
        if (art) { art.state = 'read'; art.read_at = new Date().toISOString(); }
        renderArticles();
      }
    });

    // Mark unread button
    card.querySelector('.read-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (state === 'read') {
        await markUnread([id]);
        const art = articles.find(a => a.id === id);
        if (art) { art.state = 'unread'; art.read_at = null; }
        renderArticles();
      }
    });

    // Save button
    card.querySelector('.save-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const art = articles.find(a => a.id === id);
      if (!art) return;
      if (art.state === 'saved') {
        await markRead([id]);
        art.state = 'read';
      } else {
        await saveArticle([id]);
        art.state = 'saved';
      }
      renderArticles();
    });
  });

  // Update stats after any local mutations
  updateStatsFromArticles();
}

function renderArticle(a) {
  const isRead = a.state === 'read';
  const isSaved = a.state === 'saved';
  const timeAgo = formatTimeAgo(a.published_at || a.fetched_at);
  const sourceType = getSourceType(a.source_id);
  const interests = a.matched_interests || [];
  const cardClass = [
    'article-card',
    isRead ? 'read' : '',
    isSaved ? 'saved-article' : '',
  ].filter(Boolean).join(' ');

  return `
    <div class="${cardClass}" data-id="${a.id}" data-url="${a.url}" data-state="${a.state}">
      <div class="article-meta">
        <span class="source-badge ${sourceType}">${a.source_label}</span>
        ${interests.slice(0, 3).map(k => `<span class="interest-badge">${h(k)}</span>`).join('')}
        <span class="interest-score" title="Relevance: ${(a.interest_score * 100).toFixed(0)}%">
          ${scoreDot(a.interest_score)}
        </span>
        <span class="article-time">${timeAgo}</span>
      </div>
      <div class="article-title">${h(a.title)}</div>
      ${a.snippet ? `<div class="article-snippet">${h(a.snippet)}</div>` : ''}
      <div class="article-actions">
        <button class="read-btn">${isRead ? '↩ Mark unread' : '✓ Mark read'}</button>
        <button class="save-btn">${isSaved ? '★ Saved' : '☆ Save'}</button>
      </div>
    </div>
  `;
}

// --- Helpers ---
function h(s) {
  if (!s) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function formatTimeAgo(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString('en-AU', { month: 'short', day: 'numeric' });
}

function getSourceType(sourceId) {
  if (sourceId.startsWith('rss-')) return 'rss';
  if (sourceId.startsWith('reddit-')) return 'reddit';
  if (sourceId.startsWith('hackernews')) return 'hackernews';
  return '';
}

function scoreDot(score) {
  if (score >= 0.5) return '🟢';
  if (score >= 0.15) return '🟡';
  if (score > 0) return '⚪';
  return '';
}

function updateStatsFromArticles() {
  const unread = articles.filter(a => a.state !== 'read').length;
  const saved = articles.filter(a => a.state === 'saved').length;
  document.querySelector('.stat.unread').textContent = `${unread} unread`;
  document.querySelector('.stat.saved').textContent = `${saved} saved`;
}

function showLoading() {
  document.getElementById('loading').style.display = 'block';
  document.getElementById('empty').style.display = 'none';
}

function hideLoading() {
  document.getElementById('loading').style.display = 'none';
}
