import RssParser from 'rss-parser';
import type { NetSource } from '../types';
import { hashUrl, hashContent, cleanSnippet } from '../classifier/classifier';
import type { InterestClassifier } from '../classifier/classifier';
import {
  articleExistsByHash,
  articleExistsByFingerprint,
  insertArticle,
  ensureReadState,
  logDedup,
} from '../server/db';

const parser = new RssParser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Net/0.1 (Doom Scroll Antidote; +https://net.lxg2it.com)',
  },
});

interface RawArticle {
  title: string;
  url: string;
  snippet: string | null;
  author: string | null;
  published_at: string | null;
}

export async function fetchRssSource(
  source: NetSource,
  classifier: InterestClassifier,
): Promise<{ found: number; new: number; duplicate: number; error?: string }> {
  const url = source.config.url as string;
  const limit = (source.config.limit as number) || 30;

  try {
    const feed = await parser.parseURL(url);

    if (!feed.items || feed.items.length === 0) {
      return { found: 0, new: 0, duplicate: 0 };
    }

    // Extract and score articles
    const articles: RawArticle[] = feed.items.slice(0, limit).map((item) => ({
      title: item.title || 'Untitled',
      url: item.link || '',
      snippet: cleanSnippet(item.contentSnippet || item.content || null),
      author: item.creator || item.author || null,
      published_at: item.isoDate || item.pubDate ? new Date(item.pubDate || '').toISOString() : null,
    }));

    let newCount = 0;
    let dupCount = 0;

    for (const article of articles) {
      if (!article.url) continue;

      const contentHash = hashUrl(article.url);
      const fingerprint = hashContent(article.title, article.snippet);

      // Check for duplicates
      if (articleExistsByHash(contentHash)) {
        dupCount++;
        continue;
      }
      if (articleExistsByFingerprint(fingerprint)) {
        dupCount++;
        continue;
      }

      // Score interest
      const { score, matched, categories } = classifier.score(article.title, article.snippet);

      // Insert
      const inserted = insertArticle({
        source_id: source.id,
        title: article.title,
        url: article.url,
        snippet: article.snippet,
        author: article.author,
        published_at: article.published_at,
        content_hash: contentHash,
        fingerprint,
        interest_score: score,
        matched_interests: matched,
      });

      ensureReadState(inserted.id);
      newCount++;
    }

    return { found: articles.length, new: newCount, duplicate: dupCount };
  } catch (err: any) {
    return { found: 0, new: 0, duplicate: 0, error: err.message || String(err) };
  }
}
