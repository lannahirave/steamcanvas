// Copyright (C) 2026 lannahirave
// SPDX-License-Identifier: AGPL-3.0-only
//
// Builds and updates the cached Market background catalog (worker/marketIndex.ts) that the picker
// searches without asking Steam. Run from a home connection, which Steam usually allows; every run
// writes the index to CATALOG_KV once.
//
//   npm run market-index -- build  [--env prod|beta] [--source prod|beta] [--dry-run]
//   npm run market-index -- update [--env prod|beta] [--max-requests 300] [--delay 4000] [--game <appid> ...] [--dry-run]
//
// build:  makes the index from the Market pages already in --source's CATALOG_KV (filled by
//         npm run seed:market), plus one request for Steam's Market game list. No other Steam
//         requests. --source defaults to --env.
// update: one request for Steam's game list, compared with the item counts stored in the index;
//         then one request per new or changed game (most new or changed first, up to
//         --max-requests). Games left over are picked up by the next run. --game re-checks a game
//         even if its count did not change. Nothing is written when nothing changed.

import { gunzipSync, gzipSync } from 'node:zlib';
import { loadGameBackgrounds, loadMarketGames, type MarketBackground } from '../worker/market';
import { appIdOf, marketIndexKey, type MarketIndex, type MarketIndexItem } from '../worker/marketIndex';
import { errorText, parseEnv, sleep, withRetries, withTempFile, wranglerKv, type KvEnv } from './lib';

type CachedPage = { payload?: { items?: MarketBackground[] } };

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  if (command !== 'build' && command !== 'update') throw new Error('Usage: npm run market-index -- <build|update> [options]');
  const options = { command, env: 'prod' as KvEnv, source: '' as KvEnv | '', maxRequests: 300, delayMs: 4000, games: [] as number[], dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = () => {
      const next = rest[++i];
      if (next === undefined) throw new Error(`${arg} needs a value.`);
      return next;
    };
    if (arg === '--env') options.env = parseEnv(value());
    else if (arg === '--source') options.source = parseEnv(value());
    else if (arg === '--max-requests') options.maxRequests = Number(value());
    else if (arg === '--delay') options.delayMs = Number(value());
    else if (arg === '--game') {
      const appid = Number(value());
      if (!Number.isInteger(appid) || appid <= 0) throw new Error('--game needs an app ID.');
      options.games.push(appid);
    } else if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1) throw new Error('--max-requests must be a positive integer.');
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) throw new Error('--delay must be a number of milliseconds.');
  return { ...options, source: options.source || options.env };
}

function toIndexItem(item: MarketBackground): MarketIndexItem | null {
  const appid = appIdOf(item.id);
  const iconId = item.imageUrl.split('/').pop() || '';
  if (appid === null || !/^[\w-]+$/.test(iconId)) return null;
  return [item.id, item.name, appid, iconId, item.price];
}

async function loadGames(label: string) {
  const games = await withRetries(label, () => loadMarketGames({ maxAttempts: 1 }));
  if (!games) throw new Error('Could not load Steam\'s Market game list.');
  console.log(`${label}: ${games.size} games.`);
  return games;
}

function readIndex(env: KvEnv): MarketIndex | null {
  const result = wranglerKv(env, ['key', 'get', marketIndexKey]);
  if (!result.ok || result.stdout.length === 0 || /Value not found/i.test(result.output)) return null;
  return JSON.parse(gunzipSync(result.stdout).toString('utf8')) as MarketIndex;
}

function writeIndex(env: KvEnv, index: MarketIndex, dryRun: boolean): void {
  const gzipped = gzipSync(JSON.stringify(index), { level: 9 });
  const size = `${(gzipped.length / 1024 / 1024).toFixed(1)} MB gzipped`;
  if (dryRun) {
    console.log(`Dry run: would write ${index.items.length} backgrounds (${size}) to ${env}.`);
    return;
  }
  const result = withTempFile('market-index.json.gz', gzipped, (file) => wranglerKv(env, ['key', 'put', marketIndexKey, '--path', file]));
  if (!result.ok) throw new Error(`Writing the index failed:\n${result.output}`);
  // Read it back, so a corrupted upload is caught here rather than by visitors.
  const check = readIndex(env);
  if (check?.items.length !== index.items.length) throw new Error('The index read back from KV does not match what was written.');
  console.log(`Wrote ${index.items.length} backgrounds from ${Object.keys(index.games).length} games (${size}) to ${env}.`);
}

function listMarketPageKeys(env: KvEnv): string[] {
  const result = wranglerKv(env, ['key', 'list', '--prefix', 'catalog:market::']);
  if (!result.ok) throw new Error(`Listing KV keys failed:\n${result.output}`);
  const keys = JSON.parse(result.stdout.toString('utf8')) as { name: string }[];
  // Only the default search at the picker's page size, which is what seed:market writes.
  return keys.map((key) => key.name).filter((name) => /^catalog:market::\d+:30$/.test(name))
    .sort((a, b) => Number(a.split(':')[3]) - Number(b.split(':')[3]));
}

function readPages(env: KvEnv, keys: string[]): Map<string, CachedPage> {
  const pages = new Map<string, CachedPage>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const result = withTempFile('keys.json', JSON.stringify(chunk), (file) => wranglerKv(env, ['bulk', 'get', file]));
    if (!result.ok) throw new Error(`Reading KV pages failed:\n${result.output}`);
    const values = JSON.parse(result.stdout.toString('utf8')) as Record<string, string | null>;
    for (const [key, value] of Object.entries(values)) if (value) pages.set(key, JSON.parse(value) as CachedPage);
    process.stdout.write(`\rRead ${Math.min(i + 100, keys.length)}/${keys.length} pages`);
  }
  process.stdout.write('\n');
  return pages;
}

async function build(options: ReturnType<typeof parseArgs>) {
  const keys = listMarketPageKeys(options.source);
  if (keys.length === 0) throw new Error(`No Market pages in ${options.source}'s KV. Run npm run seed:market first.`);
  const pages = readPages(options.source, keys);

  const items = new Map<string, MarketIndexItem>();
  for (const key of keys) {
    for (const background of pages.get(key)?.payload?.items ?? []) {
      const item = toIndexItem(background);
      if (item && !items.has(item[0])) items.set(item[0], item);
    }
  }
  console.log(`${items.size} backgrounds from ${pages.size} pages.`);

  const games = await loadGames('Steam Market game list');
  const index: MarketIndex = { version: 1, updatedAt: Date.now(), games: {}, snapshot: {}, items: [...items.values()] };
  for (const [appid, game] of games) {
    index.games[appid] = game.name;
    index.snapshot[appid] = game.matches;
  }
  writeIndex(options.env, index, options.dryRun);
}

async function update(options: ReturnType<typeof parseArgs>) {
  const index = readIndex(options.env);
  if (!index) throw new Error(`No index in ${options.env}'s KV yet. Run: npm run market-index -- build --env ${options.env}`);
  const games = await loadGames('Steam Market game list');

  const newGames: number[] = [];
  const changedGames: { appid: number; change: number }[] = [];
  for (const [appid, game] of games) {
    index.games[appid] = game.name;
    const previous = index.snapshot[appid];
    if (previous === undefined) newGames.push(appid);
    else if (previous !== game.matches) changedGames.push({ appid, change: Math.abs(game.matches - previous) });
  }
  // New games first, newest app IDs first; then the games whose item count moved the most.
  // Games named with --game come before everything else.
  const queue = [...new Set([
    ...options.games.filter((appid) => games.has(appid)),
    ...newGames.sort((a, b) => b - a),
    ...changedGames.sort((a, b) => b.change - a.change).map((game) => game.appid),
  ])];
  console.log(`${newGames.length} new and ${changedGames.length} changed games.`);

  const positions = new Map(index.items.map((item, position) => [item[0], position]));
  let requests = 0;
  let processed = 0;
  let added = 0;
  let changed = 0;
  for (const appid of queue) {
    if (requests >= options.maxRequests) break;
    if (requests > 0 && options.delayMs) await sleep(options.delayMs);
    const label = `${index.games[appid]} (${appid})`;
    const backgrounds = await withRetries(label, () => {
      requests += 1;
      return loadGameBackgrounds(appid, { maxAttempts: 1 });
    });
    if (!backgrounds) {
      console.error(`Stopping; the remaining games stay queued for the next run.`);
      break;
    }
    for (const background of backgrounds) {
      const item = toIndexItem(background);
      if (!item) continue;
      const position = positions.get(item[0]);
      if (position === undefined) {
        positions.set(item[0], index.items.length);
        index.items.push(item);
        added += 1;
      } else if (JSON.stringify(index.items[position]) !== JSON.stringify(item)) {
        index.items[position] = item;
        changed += 1;
      }
    }
    index.snapshot[appid] = games.get(appid)!.matches;
    processed += 1;
    if (backgrounds.length) console.log(`${label}: ${backgrounds.length} backgrounds`);
  }

  console.log(`Checked ${processed} games with ${requests} requests: ${added} new and ${changed} updated backgrounds. ${queue.length - processed} games left for the next run.`);
  if (processed === 0) {
    console.log('Nothing changed; the index was not rewritten.');
    return;
  }
  index.updatedAt = Date.now();
  writeIndex(options.env, index, options.dryRun);
}

const options = parseArgs(process.argv.slice(2));
(options.command === 'build' ? build(options) : update(options)).catch((error) => {
  console.error(errorText(error));
  process.exitCode = 1;
});
