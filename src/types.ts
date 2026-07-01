// Shared types for the Net project

export interface NetSource {
  id: string;
  source_type: 'rss' | 'reddit' | 'hackernews';
  label: string;
  config: Record<string, unknown>;
  enabled: boolean;
  last_fetched_at: string | null;
  error_count: number;
  created_at: string;
}

export interface NetArticle {
  id: string;
  source_id: string;
  title: string;
  url: string;
  snippet: string | null;
  author: string | null;
  published_at: string | null;
  fetched_at: string;
  content_hash: string;
  fingerprint: string;
  interest_score: number;
  matched_interests: string[] | null;
}

export type ReadState = 'unread' | 'read' | 'saved';

export interface NetReadState {
  article_id: string;
  state: ReadState;
  read_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NetInterest {
  id: string;
  keyword: string;
  weight: number;
  category: string | null;
}

// API response types
export interface ArticleListItem extends NetArticle {
  state: ReadState;
  read_at: string | null;
  source_label: string;
}

export interface FetchResult {
  source_id: string;
  articles_found: number;
  articles_new: number;
  articles_duplicate: number;
  error?: string;
}

export interface DashboardData {
  total_unread: number;
  total_saved: number;
  articles: ArticleListItem[];
  by_source: Record<string, number>;
}

export interface FetchJob {
  id: string;
  started_at: string;
  completed_at: string | null;
  total_sources: number;
  completed_sources: number;
  results: FetchResult[];
}
