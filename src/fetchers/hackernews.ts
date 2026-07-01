import fetch from 'node-fetch';
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

interface HNItem {
  id: number;
  title: string;
  url?: string;
  text?: string;
  by: string;
  time: number;
  score: number;
  descendants: number;
}

/**
 * Fetch Hacker News stories using the Firebase API.
 * Uses the /v0/topstories endpoint then fetches each item.
 */
export async function fetchHackerNewsSource(
  source: NetSource,
  classifier: InterestClassifier,
): Promise<{ found: number; new: number; duplicate: number; error?: string }> {
  const limit = (source.config.limit as number) || 30;

  try {
    // Get top story IDs
    const topResponse = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
    if (!topResponse.ok) {
      return { found: 0, new: 0, duplicate: 0, error: `HTTP ${topResponse.status}` };
    }
    const ids = (await topResponse.json()) as number[];
    const topIds = ids.slice(0, limit);

    // Fetch each story
    let newCount = 0;
    let dupCount = 0;
    let foundCount = 0;

    for (const id of topIds) {
      const itemUrl = `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
      const itemResponse = await fetch(itemUrl);

      if (!itemResponse.ok) continue;

      const item = (await itemResponse.json()) as HNItem;
      if (!item || !item.title) continue;

      foundCount++;

      const articleUrl = item.url || `https://news.ycombinator.com/item?id=${item.id}`;
      const contentHash = hashUrl(articleUrl);
      const snippet = cleanSnippet(item.text || null);
      const fingerprint = hashContent(item.title, snippet);

      if (articleExistsByHash(contentHash)) {
        dupCount++;
        continue;
      }
      if (articleExistsByFingerprint(fingerprint)) {
        dupCount++;
        continue;
      }

      const { score, matched, categories } = classifier.score(item.title, snippet);

      const inserted = insertArticle({
        source_id: source.id,
        title: item.title,
        url: articleUrl,
        snippet,
        author: item.by,
        published_at: new Date(item.time * 1000).toISOString(),
        content_hash: contentHash,
        fingerprint,
        interest_score: score,
        matched_interests: matched,
      });

      ensureReadState(inserted.id);
      newCount++;
    }

    return { found: foundCount, new: newCount, duplicate: dupCount };
  } catch (err: any) {
    return { found: 0, new: 0, duplicate: 0, error: err.message || String(err) };
  }
}
