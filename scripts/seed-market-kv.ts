// Copyright (C) 2026 lannahirave
// SPDX-License-Identifier: AGPL-3.0-only
//
// Fills the deployed Worker's CATALOG_KV with Market background pages fetched from this machine.
// Steam rate-limits the Market from Cloudflare's IPs but usually not from a home connection, so
// this seeds the shared cache the Worker serves from (see worker/cache.ts). Entries use the same
// keys and format as the Worker; once they go stale, the Worker serves them and refreshes in the
// background, keeping them on failure.
//
//   npm run seed:market -- [--env prod|beta] [--pages 10|all] [--start-page 1] [--query "anime" ...]
//                          [--delay 2500] [--batch 25] [--dry-run]
//
// Pages are numbered from 1, as in the log. --pages counts from --start-page and applies to each
// query. With no --query, only the default (empty) search is seeded. Entries are uploaded every
// --batch pages, so a stopped run loses at most one batch; the log prints the --start-page to
// resume from. Ctrl+C uploads what has been fetched, then stops.

import { catalogCacheTtlMs } from '../worker/cache';
import { loadMarketBackgrounds, marketCacheKey } from '../worker/market';
import { errorText, parseEnv, withRetries, withTempFile, wranglerKv, type KvEnv } from './lib';

// Must match the picker (src/components/BackgroundPicker.tsx) and the Worker's KV prefix and
// retention (worker/cache.ts), or the Worker will not find these entries.
const pageSize = 30;
const kvPrefix = 'catalog:';
const kvKeepSeconds = 30 * 24 * 60 * 60;
type Entry = { key: string; value: string; expiration_ttl: number };
type Payload = Awaited<ReturnType<typeof loadMarketBackgrounds>>;

function parseArgs(argv: string[]) {
  const options = { env: 'prod', pages: 10, startPage: 1, queries: [] as string[], delayMs: 2500, batch: 25, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value.`);
      return next;
    };
    if (arg === '--env') options.env = value();
    else if (arg === '--pages') {
      const pages = value();
      options.pages = pages === 'all' ? Infinity : Number(pages);
    } else if (arg === '--start-page') options.startPage = Number(value());
    else if (arg === '--query') options.queries.push(value().trim().slice(0, 80));
    else if (arg === '--delay') options.delayMs = Number(value());
    else if (arg === '--batch') options.batch = Number(value());
    else if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  parseEnv(options.env);
  if (options.pages !== Infinity && (!Number.isInteger(options.pages) || options.pages < 1)) throw new Error('--pages must be a positive integer or "all".');
  if (!Number.isInteger(options.startPage) || options.startPage < 1) throw new Error('--start-page must be 1 or more.');
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) throw new Error('--delay must be a number of milliseconds.');
  if (!Number.isInteger(options.batch) || options.batch < 1) throw new Error('--batch must be a positive integer.');
  if (options.queries.length > 1 && options.startPage > 1) throw new Error('--start-page works with one query at a time.');
  if (options.queries.length === 0) options.queries.push('');
  return options;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let stopRequested = false;
process.on('SIGINT', () => {
  if (stopRequested) process.exit(130);
  stopRequested = true;
  console.log('\nStopping after the current page (Ctrl+C again to quit without uploading)...');
});

function upload(entries: Entry[], env: string): boolean {
  const result = withTempFile('entries.json', JSON.stringify(entries), (file) => wranglerKv(env as KvEnv, ['bulk', 'put', file]));
  if (!result.ok) console.error(`Upload failed:
${result.output}`);
  return result.ok;
}

function loadPageWithRetries(query: string, start: number, label: string): Promise<Payload | null> {
  // Retries are done here, at page level, so the waits are exactly the ones in scripts/lib.ts.
  return withRetries(label, () => loadMarketBackgrounds(query, start, pageSize, { maxAttempts: 1 }), () => stopRequested);
}

async function seedQuery(query: string, options: ReturnType<typeof parseArgs>): Promise<boolean> {
  const name = query ? `"${query}"` : 'default search';
  const resumeHint = (page: number) => `npm run seed:market -- --env ${options.env}${query ? ` --query "${query}"` : ''} --pages ${options.pages === Infinity ? 'all' : options.pages - (page - options.startPage)} --start-page ${page}`;
  let pending: Entry[] = [];
  let pendingFirstPage = options.startPage;
  let uploaded = 0;
  let lastPage = options.startPage + options.pages - 1;

  const flush = (): boolean => {
    if (pending.length === 0) return true;
    if (options.dryRun) {
      console.log(`  (dry run) would upload pages ${pendingFirstPage}-${pendingFirstPage + pending.length - 1}`);
    } else if (upload(pending, options.env)) {
      uploaded += pending.length;
      console.log(`  uploaded pages ${pendingFirstPage}-${pendingFirstPage + pending.length - 1} (${uploaded} this run)`);
    } else {
      console.error(`Resume with: ${resumeHint(pendingFirstPage)}`);
      return false;
    }
    pendingFirstPage += pending.length;
    pending = [];
    return true;
  };

  for (let page = options.startPage; page <= lastPage; page++) {
    if (stopRequested) {
      const ok = flush();
      if (ok) console.log(`Stopped. Resume with: ${resumeHint(page)}`);
      return false;
    }
    const start = (page - 1) * pageSize;
    const label = `${name} page ${page}${Number.isFinite(lastPage) ? `/${lastPage}` : ''}`;
    const payload = await loadPageWithRetries(query, start, label);
    if (!payload) {
      if (flush()) console.error(`Resume with: ${resumeHint(page)}`);
      return false;
    }

    // Steam's total moves a little as listings come and go; the latest answer sets the last page.
    const totalPages = Math.max(1, Math.ceil(payload.totalCount / pageSize));
    lastPage = Math.min(options.startPage + options.pages - 1, totalPages);
    pending.push({
      key: kvPrefix + marketCacheKey(query, start, pageSize),
      value: JSON.stringify({ expiresAt: Date.now() + catalogCacheTtlMs, payload }),
      expiration_ttl: kvKeepSeconds,
    });
    console.log(`${name} page ${page}/${lastPage}: ${payload.items.length} items (total ${payload.totalCount})`);

    if (payload.items.length === 0) break;
    if (pending.length >= options.batch && !flush()) return false;
    if (page < lastPage && options.delayMs) await sleep(options.delayMs);
  }
  return flush();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  for (const query of options.queries) {
    if (!await seedQuery(query, options)) {
      process.exitCode = 1;
      return;
    }
  }
  console.log('Done.');
}

main().catch((error) => {
  console.error(errorText(error));
  process.exitCode = 1;
});
