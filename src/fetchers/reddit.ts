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
 * Uses rotating User-Agents. Reddit rate-limits by IP, so some
 * sources will fail each cycle — the next auto-fetch will retry them.
 */
export async function fetchRedditSource(
  source: NetSource,
  classifier: InterestClassifier,
): Promise<{ found: number; new: number; duplicate: number; error?: string }> {
  const subreddit = source.config.subreddit as string;
  const limit = (source.config.limit as number) || 25;

  // Reddit aggressively rate-limits RSS by IP. Single attempt per cycle —
  // if rate-limited, we'll catch it in the next auto-fetch cycle.
  const feedUrl = `https://www.reddit.com/r/${subreddit}/.rss?limit=${limit}`;
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
    return { found: 0, new: 0, duplicate: 0, error: err.message || String(err) };
  }
}
