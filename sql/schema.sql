-- Net: Database schema for the doom-scroll antidote

-- Content sources (RSS feeds, Reddit subs, HN)
CREATE TABLE IF NOT EXISTS net_sources (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    source_type TEXT NOT NULL CHECK (source_type IN ('rss', 'reddit', 'hackernews')),
    label TEXT NOT NULL,
    config JSONB NOT NULL,  -- {url: string, ...} for RSS, {subreddit: string, ...} for Reddit
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_fetched_at TIMESTAMP,
    error_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Fetched articles
CREATE TABLE IF NOT EXISTS net_articles (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    source_id TEXT NOT NULL REFERENCES net_sources(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    snippet TEXT,
    author TEXT,
    published_at TIMESTAMP,
    fetched_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    content_hash TEXT NOT NULL,  -- SHA256 of URL for dedup
    fingerprint TEXT NOT NULL,   -- SHA256 of (title + first 500 chars) for content dedup
    interest_score REAL NOT NULL DEFAULT 0.0,
    matched_interests TEXT[]    -- which interest keywords matched
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_net_articles_url_hash ON net_articles(content_hash);
CREATE INDEX IF NOT EXISTS idx_net_articles_published ON net_articles(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_net_articles_interest ON net_articles(interest_score DESC);
CREATE INDEX IF NOT EXISTS idx_net_articles_source ON net_articles(source_id);

-- Read state for articles
CREATE TABLE IF NOT EXISTS net_read_state (
    article_id TEXT PRIMARY KEY REFERENCES net_articles(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'unread' CHECK (state IN ('unread', 'read', 'saved')),
    read_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Interest keywords that Scott cares about
CREATE TABLE IF NOT EXISTS net_interests (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    keyword TEXT NOT NULL UNIQUE,
    weight REAL NOT NULL DEFAULT 1.0,
    category TEXT
);

-- Insert Scott's initial interests
INSERT OR IGNORE INTO net_interests (keyword, weight, category) VALUES
    ('large language model', 1.0, 'ai'),
    ('LLM', 0.9, 'ai'),
    ('transformer', 0.8, 'ai'),
    ('fine-tuning', 0.9, 'ai'),
    ('LoRA', 0.9, 'ai'),
    ('MLX', 0.8, 'ai'),
    ('local model', 0.9, 'ai'),
    ('open source AI', 0.9, 'ai'),
    ('Anthropic', 0.7, 'ai'),
    ('Claude', 0.7, 'ai'),
    ('OpenAI', 0.6, 'ai'),
    ('GPT', 0.6, 'ai'),
    ('oMLX', 0.8, 'ai'),
    ('MCP', 0.8, 'ai'),
    ('Model Context Protocol', 0.8, 'ai'),
    ('agent', 0.7, 'ai'),
    ('AI agent', 0.8, 'ai'),
    ('reinforcement learning', 0.7, 'ai'),
    ('embedding', 0.6, 'ai'),
    ('RAG', 0.7, 'ai'),
    ('retrieval augmented', 0.7, 'ai'),
    ('vector database', 0.6, 'ai'),
    ('Bitcoin', 1.0, 'crypto'),
    ('Lightning Network', 0.8, 'crypto'),
    ('cryptocurrency', 0.7, 'crypto'),
    ('blockchain', 0.6, 'crypto'),
    ('Satoshi', 0.6, 'crypto'),
    ('Ethereum', 0.5, 'crypto'),
    ('robot', 0.8, 'robotics'),
    ('robotics', 0.9, 'robotics'),
    ('Raspberry Pi', 0.8, 'robotics'),
    ('mecanum', 0.7, 'robotics'),
    ('autonomous', 0.7, 'robotics'),
    ('SLAM', 0.7, 'robotics'),
    ('ROS', 0.6, 'robotics'),
    ('Brisbane Lions', 0.9, 'afl'),
    ('AFL', 0.6, 'afl'),
    ('TypeScript', 0.5, 'programming'),
    ('Rust', 0.5, 'programming'),
    ('Node.js', 0.5, 'programming'),
    ('PostgreSQL', 0.5, 'programming'),
    ('Docker', 0.4, 'programming'),
    ('M4 Max', 0.7, 'hardware'),
    ('Mac Studio', 0.6, 'hardware'),
    ('Apple Silicon', 0.7, 'hardware'),
    ('Australia tech', 0.5, 'local'),
    ('Melbourne startup', 0.5, 'local'),
    ('Masters AI', 0.5, 'personal'),
    ('consulting', 0.4, 'business'),
    ('startup', 0.5, 'business');

-- Insert initial sources
INSERT OR IGNORE INTO net_sources (id, source_type, label, config) VALUES
    ('hackernews', 'hackernews', 'Hacker News', '{"limit": 30}'),
    ('reddit-machinelearning', 'reddit', 'r/MachineLearning', '{"subreddit": "MachineLearning", "limit": 25}'),
    ('reddit-localllama', 'reddit', 'r/LocalLLaMA', '{"subreddit": "LocalLLaMA", "limit": 25}'),
    ('reddit-artificial', 'reddit', 'r/Artificial', '{"subreddit": "Artificial", "limit": 25}'),
    ('reddit-bitcoin', 'reddit', 'r/Bitcoin', '{"subreddit": "Bitcoin", "limit": 25}'),
    ('reddit-robotics', 'reddit', 'r/robotics', '{"subreddit": "robotics", "limit": 25}'),
    ('rss-arxiv-csai', 'rss', 'arXiv CS.AI', '{"url": "http://export.arxiv.org/rss/cs.AI", "limit": 20}'),
    ('rss-arxiv-cscl', 'rss', 'arXiv CS.CL', '{"url": "http://export.arxiv.org/rss/cs.CL", "limit": 20}'),
    ('rss-arxiv-cslg', 'rss', 'arXiv CS.LG', '{"url": "http://export.arxiv.org/rss/cs.LG", "limit": 20}'),
    ('rss-arxiv-csro', 'rss', 'arXiv CS.RO', '{"url": "http://export.arxiv.org/rss/cs.RO", "limit": 20}'),
    ('rss-schneier', 'rss', 'Schneier on Security', '{"url": "https://www.schneier.com/feed/atom/", "limit": 10}'),
    ('rss-simonw', 'rss', 'Simon Willison', '{"url": "https://simonwillison.net/atom/everything/", "limit": 10}');

-- Article dedup log (for debugging)
CREATE TABLE IF NOT EXISTS net_dedup_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id TEXT REFERENCES net_articles(id),
    duplicate_of TEXT REFERENCES net_articles(id),
    reason TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
