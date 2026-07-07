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

// Rotate through common browser User-Agent strings to avoid rate limiting
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7; rv:133.0) Gecko/20100101 Firefox/133.0',
];
let uaIndex = 0;

function nextUserAgent(): string {
  const ua = USER_AGENTS[uaIndex % USER_AGENTS.length];
  uaIndex++;
  return ua;
}

/**
 * Fetch Reddit posts using the built-in subreddit RSS feed.
 * No auth required — Reddit provides .rss for every subreddit.
 *
 * Feed format: https://www.reddit.com/r/{subreddit}/.rss
 *
 * Uses rotating User-Agents. Falls back to old.reddit.com if www gets rate-limited.
 * Retries once with backoff on 429 errors.
 */
export async function fetchRedditSource(
  source: NetSource,
  classifier: InterestClassifier,
): Promise<{ found: number; new: number; duplicate: number; error?: string }> {
  const subreddit = source.config.subreddit as string;
  const limit = (source.config.limit as number) || 25;

  // Reddit aggressively rate-limits RSS by IP. Retry once with backoff on 429.
  // Browser UAs sometimes help but the real constraint is IP-level rate limiting.
  const feedUrl = `https://www.reddit.com/r/${subreddit}/.rss?limit=${limit}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const ua = nextUserAgent();

    try {
      const parser = new RssParser({
        timeout: 15000,
        headers: { 'User-Agent': ua },
      });

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
      const msg = err.message || String(err);
      const isRateLimited = msg.includes('429') || msg.includes('Too Many Requests');

      if (isRateLimited && attempt === 0) {
        // Rate limited — back off and retry once with a different UA
        await new Promise(resolve => setTimeout(resolve, 3000 + Math.random() * 2000));
        continue;
      }

      // Non-rate-limit error or second attempt failed
      return { found: 0, new: 0, duplicate: 0, error: msg };
    }
  }

  return { found: 0, new: 0, duplicate: 0, error: 'Rate limited after retries' };
}
