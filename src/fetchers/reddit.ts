import RssParser from 'rss-parser';
import type { NetSource } from '../types';
import { hashUrl, hashContent, cleanSnippet } from '../classifier/classifier';
import type { InterestClassifier } from '../classifier/classifier';
import {
  articleExistsByHash,
  articleExistsByFingerprint,
  insertArticle,
  ensureReadState,
} from '../server/db';

const parser = new RssParser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Net/0.1 (Doom Scroll Antidote; +https://net.lxg2it.com)',
  },
});

/**
 * Fetch Reddit posts using the built-in subreddit RSS feed.
 * No auth required — Reddit provides .rss for every subreddit.
 *
 * Feed format: https://www.reddit.com/r/{subreddit}/.rss
 */
export async function fetchRedditSource(
  source: NetSource,
  classifier: InterestClassifier,
): Promise<{ found: number; new: number; duplicate: number; error?: string }> {
  const subreddit = source.config.subreddit as string;
  const limit = (source.config.limit as number) || 25;

  try {
    const feedUrl = `https://www.reddit.com/r/${subreddit}/.rss?limit=${limit}`;
    const feed = await parser.parseURL(feedUrl);

    if (!feed.items || feed.items.length === 0) {
      return { found: 0, new: 0, duplicate: 0 };
    }

    let newCount = 0;
    let dupCount = 0;
    const articles = feed.items.slice(0, limit);

    for (const item of articles) {
      const title = item.title || 'Untitled';
      const link = item.link || '';
      if (!link) continue;

      const contentHash = hashUrl(link);
      const snippet = cleanSnippet(item.contentSnippet || item.content || null);
      const fingerprint = hashContent(title, snippet);

      if (articleExistsByHash(contentHash)) {
        dupCount++;
        continue;
      }
      if (articleExistsByFingerprint(fingerprint)) {
        dupCount++;
        continue;
      }

      const { score, matched } = classifier.score(title, snippet);

      const inserted = insertArticle({
        source_id: source.id,
        title: title,
        url: link,
        snippet,
        author: item.creator || item.author || null,
        published_at: item.isoDate || (item.pubDate ? new Date(item.pubDate).toISOString() : null),
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
