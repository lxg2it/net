/**
 * Fetch orchestrator: runs all enabled sources and records results.
 * This can be invoked via the API or a cron job.
 */

import { getEnabledSources, updateSourceLastFetched, incrementSourceErrorCount, getAllInterests } from '../server/db';
import { InterestClassifier } from '../classifier/classifier';
import { fetchRssSource } from './rss';
import { fetchRedditSource } from './reddit';
import { fetchHackerNewsSource } from './hackernews';
import type { FetchResult, FetchJob } from '../types';

/**
 * Reddit rate-limits by IP: roughly 1-3 requests per window before returning
 * 429 for everything after. Fetching all subreddits consecutively guarantees
 * most of them get 429'd. Instead, rotate through them — fetch a subset each
 * cycle so every subreddit gets its own rate-limit budget.
 *
 * With REDDIT_PER_CYCLE=2 and 7 subreddits at a 20-min auto-fetch interval,
 * each sub is refreshed roughly hourly — plenty for Reddit's post lifecycle
 * (posts stay relevant for 12-24h). If a sub still gets 429'd, it simply
 * waits for its next rotation slot.
 */
const REDDIT_PER_CYCLE = 2;
let redditRotationOffset = 0;

export async function runFetchAll(): Promise<FetchJob> {
  const startedAt = new Date().toISOString();
  const allSources = getEnabledSources();
  const interests = getAllInterests();
  const classifier = new InterestClassifier(interests);

  // Rotate reddit sources: select REDDIT_PER_CYCLE subs, wrapping around
  const redditSources = allSources.filter(s => s.source_type === 'reddit');
  const selectedReddit = new Set<string>();
  if (redditSources.length > 0) {
    for (let i = 0; i < REDDIT_PER_CYCLE && i < redditSources.length; i++) {
      const src = redditSources[(redditRotationOffset + i) % redditSources.length];
      selectedReddit.add(src.id);
    }
    redditRotationOffset = (redditRotationOffset + REDDIT_PER_CYCLE) % redditSources.length;
  }

  // Fetch all non-reddit sources plus this cycle's reddit rotation slot
  const sources = allSources.filter(s => s.source_type !== 'reddit' || selectedReddit.has(s.id));
  const skippedReddit = allSources.filter(s => s.source_type === 'reddit' && !selectedReddit.has(s.id));
  if (skippedReddit.length > 0) {
    console.log(`[net] Skipping reddit sources (rotation): ${skippedReddit.map(s => s.label).join(', ')}`);
  }

  const results: FetchResult[] = [];

  for (const source of sources) {
    console.log(`[net] Fetching: ${source.label} (${source.source_type})`);

    // Rate limit: same-type sources need delay between calls
    if (results.length > 0) {
      const prevSource = sources[results.length - 1];
      const prevType = prevSource?.source_type;
      const currType = source.source_type;
      if (prevType === currType) {
        // Only 2 reddit fetches per cycle now, so we can afford a longer
        // gap between them — better odds both land within Reddit's budget.
        const delay = currType === 'reddit' ? 25000 + Math.random() * 10000 : 500;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    let result: { found: number; new: number; duplicate: number; error?: string };

    try {
      switch (source.source_type) {
        case 'rss':
          result = await fetchRssSource(source, classifier);
          break;
        case 'reddit':
          result = await fetchRedditSource(source, classifier);
          break;
        case 'hackernews':
          result = await fetchHackerNewsSource(source, classifier);
          break;
        default:
          result = { found: 0, new: 0, duplicate: 0, error: `Unknown source type: ${source.source_type}` };
      }
    } catch (err: any) {
      result = { found: 0, new: 0, duplicate: 0, error: err.message || String(err) };
    }

    if (result.error) {
      incrementSourceErrorCount(source.id);
      console.error(`[net] Error fetching ${source.label}: ${result.error}`);
    } else {
      updateSourceLastFetched(source.id);
      console.log(`[net] ${source.label}: ${result.new} new, ${result.duplicate} dup of ${result.found} found`);
    }

    results.push({
      source_id: source.id,
      articles_found: result.found,
      articles_new: result.new,
      articles_duplicate: result.duplicate,
      error: result.error,
    });
  }

  const job: FetchJob = {
    id: `fetch-${Date.now()}`,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    total_sources: sources.length,
    completed_sources: results.length,
    results,
  };

  const totalNew = results.reduce((sum, r) => sum + r.articles_new, 0);
  console.log(`[net] Fetch complete: ${totalNew} new articles across ${sources.length} sources`);

  return job;
}
