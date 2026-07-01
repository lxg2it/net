/**
 * Standalone fetch script — run via cron or manually.
 * Usage: node dist/server/fetch.js
 */

import { initDb } from './db';
import { runFetchAll } from '../fetchers/orchestrator';

async function main() {
  console.log('[net] Starting fetch run...');
  await initDb();
  try {
    const job = await runFetchAll();
    const totalNew = job.results.reduce((sum, r) => sum + r.articles_new, 0);
    console.log(`[net] Done: ${totalNew} new articles`);
    process.exit(0);
  } catch (err: any) {
    console.error('[net] Fetch failed:', err.message);
    process.exit(1);
  }
}

main();
