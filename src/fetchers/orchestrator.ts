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

export async function runFetchAll(): Promise<FetchJob> {
  const startedAt = new Date().toISOString();
  const sources = getEnabledSources();
  const interests = getAllInterests();
  const classifier = new InterestClassifier(interests);

  const results: FetchResult[] = [];

  for (const source of sources) {
    console.log(`[net] Fetching: ${source.label} (${source.source_type})`);

    // Rate limit: same-type sources need delay between calls
    if (results.length > 0) {
      const prevSource = sources[results.length - 1];
      const prevType = prevSource?.source_type;
      const currType = source.source_type;
      if (prevType === currType) {
        const delay = currType === 'reddit' ? 5000 + Math.random() * 3000 : 500;
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
