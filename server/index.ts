// Copyright (C) 2026 dumbapplee
// SPDX-License-Identifier: AGPL-3.0-only

import axios from 'axios';
import { load } from 'cheerio';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const app = express();
const port = Number(process.env.PORT || 8787);
const steamHost = 'steamcommunity.com';
const steamImageHost = 'community.cloudflare.steamstatic.com';
const catalogPool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
  : null;
const catalogCategories = [
  { key: 'points-backgrounds', communityItemClass: 3 },
  { key: 'avatar-frames', communityItemClass: 14 },
  { key: 'profile-themes', communityItemClass: 8 },
] as const;
type CatalogCategory = typeof catalogCategories[number]['key'];
type CatalogItem = { id: string; name: string; game: string; [key: string]: unknown };

type SteamMarketItem = {
  name?: string;
  hash_name?: string;
  sell_price_text?: string;
  asset_description?: {
    icon_url?: string;
    market_name?: string;
    market_hash_name?: string;
    type?: string;
  };
};

type SteamMarketResponse = {
  success?: boolean;
  total_count?: number;
  results?: SteamMarketItem[];
};

type SteamPointShopDefinition = {
  appid?: number;
  defid?: number;
  active?: boolean;
  community_item_class?: number;
  community_item_type?: number;
  bundle_defids?: number[];
  community_item_data?: {
    item_name?: string;
    item_title?: string;
    item_image_small?: string;
    item_image_large?: string;
    item_movie_webm?: string;
    item_movie_mp4?: string;
    animated?: boolean;
    profile_theme_id?: string;
  };
};

type SteamPointShopResponse = {
  response?: {
    responses?: Array<{
      eresult?: number;
      response?: {
        total_count?: number;
        count?: number;
        next_cursor?: string;
        definitions?: SteamPointShopDefinition[];
      };
    }>;
  };
};

type PointShopPage = {
  items: CatalogItem[];
  totalCount: number;
  nextCursor: string | null;
};

class InvalidSteamPointShopResponseError extends Error {}

type PublicScreenshot = {
  id: string;
  imageUrl: string;
  thumbnailUrl: string;
  steamUrl: string;
  searchText?: string;
  appid?: number;
  aspectRatio?: number;
};

function extractFullScreenshotUrl(html: string, pageUrl: string): string | undefined {
  const candidates = [...html.matchAll(/https:\/\/images\.steamusercontent\.com\/ugc\/[^"'<>\s]+/gi)]
    .map((match) => match[0].replace(/&amp;/g, '&'))
    .map((value) => {
      try {
        const url = new URL(value, pageUrl);
        return url.hostname === 'images.steamusercontent.com' ? url : undefined;
      } catch {
        return undefined;
      }
    })
    .filter((url): url is URL => !!url)
    .sort((left, right) => Number(right.searchParams.get('imw') || 0) - Number(left.searchParams.get('imw') || 0));
  return candidates[0]?.href;
}

const catalogCache = new Map<string, { expiresAt: number; payload: unknown }>();
const catalogRequests = new Map<string, Promise<unknown>>();
const catalogCacheTtlMs = 3 * 60 * 60 * 1000;
const catalogCacheMaxEntries = 500;
const profileCacheTtlMs = 10 * 60 * 1000;
const steamRequestIntervalMs = 700;
let steamRequestQueue: Promise<void> = Promise.resolve();
let nextSteamRequestAt = 0;

async function waitForSteamRequestSlot(): Promise<void> {
  const previous = steamRequestQueue;
  let releaseQueue!: () => void;
  steamRequestQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  await previous;

  const delayMs = Math.max(0, nextSteamRequestAt - Date.now());
  if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  nextSteamRequestAt = Date.now() + steamRequestIntervalMs;
  releaseQueue();
}

axios.interceptors.request.use(async (config) => {
  await waitForSteamRequestSlot();
  return config;
});

type SteamRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxBackoffMs?: number;
  maxRetryAfterMs?: number;
  isRetryable?: (error: unknown) => boolean;
};

function retryDelayMs(error: unknown, attempt: number, options: SteamRetryOptions): number {
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 15000;
  if (axios.isAxiosError(error)) {
    const retryAfter = error.response?.headers?.['retry-after'];
    const retryAfterSeconds = Number(retryAfter);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) return Math.min(maxRetryAfterMs, retryAfterSeconds * 1000);
    if (typeof retryAfter === 'string') {
      const retryAt = Date.parse(retryAfter);
      if (Number.isFinite(retryAt)) return Math.min(maxRetryAfterMs, Math.max(500, retryAt - Date.now()));
    }
  }
  return Math.min(options.maxBackoffMs ?? 8000, (options.baseDelayMs ?? 750) * 2 ** attempt);
}

async function retrySteamRequest<T>(request: () => Promise<T>, options: SteamRetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 4;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      const networkError = axios.isAxiosError(error) && !error.response;
      const retryable = options.isRetryable?.(error) === true || networkError || status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500);
      if (!retryable || attempt === maxAttempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(error, attempt, options)));
    }
  }
  throw new Error('Steam request failed after retries.');
}

async function getSteamHtmlWithRetry(url: string, options: SteamRetryOptions = {}): Promise<{ data: string; responseUrl: string }> {
  const result = await retrySteamRequest(() => axios.get<string>(url, {
    timeout: 15000,
    maxRedirects: 5,
    responseType: 'text',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
  }), options);
  return { data: result.data, responseUrl: result.request?.res?.responseUrl || url };
}

async function getCachedCatalog<T>(key: string, loadCatalog: () => Promise<T>, ttlMs = catalogCacheTtlMs): Promise<T> {
  const cached = catalogCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.payload as T;

  const activeRequest = catalogRequests.get(key);
  if (activeRequest) return activeRequest as Promise<T>;

  const request = Promise.resolve().then(loadCatalog).then((payload) => {
    const now = Date.now();
    catalogCache.delete(key);
    while (catalogCache.size >= catalogCacheMaxEntries) {
      const oldestKey = catalogCache.keys().next().value;
      if (oldestKey === undefined) break;
      catalogCache.delete(oldestKey);
    }
    catalogCache.set(key, { expiresAt: now + ttlMs, payload });
    return payload;
  }).catch((error) => {
    // Serve the last known catalog if Steam is rate-limiting or unavailable.
    if (cached) return cached.payload as T;
    throw error;
  }).finally(() => {
    catalogRequests.delete(key);
  });
  catalogRequests.set(key, request);
  return request;
}

function setCatalogCacheHeaders(response: express.Response): void {
  response.setHeader('Cache-Control', `public, max-age=${catalogCacheTtlMs / 1000}`);
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

function encodeNumberField(field: number, value: number): Buffer {
  return Buffer.concat([encodeVarint(field << 3), encodeVarint(value)]);
}

function encodeStringField(field: number, value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(bytes.length), bytes]);
}

function makePointsShopQuery(cursor?: string, communityItemClass = 3, pageSize = 20): string {
  const query = Buffer.concat([
    encodeNumberField(3, communityItemClass),
    encodeStringField(4, 'english'),
    encodeNumberField(5, pageSize),
    ...(cursor ? [encodeStringField(6, cursor)] : []),
    encodeNumberField(7, 2),
    encodeNumberField(8, 0),
    encodeNumberField(9, 1),
    ...(communityItemClass === 3 ? [encodeNumberField(12, 1)] : communityItemClass === 8 ? [encodeNumberField(12, 3)] : []),
    encodeNumberField(17, 3),
    encodeNumberField(17, 4),
  ]);
  return Buffer.concat([encodeVarint(10), encodeVarint(query.length), query]).toString('base64');
}

function makeRewardDefinitionsQuery(defids: number[]): string {
  const query = Buffer.concat([
    encodeStringField(4, 'english'),
    ...defids.map((defid) => encodeNumberField(11, defid)),
    encodeNumberField(16, 1),
  ]);
  return Buffer.concat([encodeVarint(10), encodeVarint(query.length), query]).toString('base64');
}

async function fetchPointShopPage(category: CatalogCategory, cursor?: string): Promise<PointShopPage> {
  const categoryConfig = catalogCategories.find((item) => item.key === category)!;
  const apiUrl = new URL('/ILoyaltyRewardsService/BatchedQueryRewardItems/v1', 'https://api.steampowered.com');
  apiUrl.searchParams.set('origin', 'https://store.steampowered.com');
  apiUrl.searchParams.set('input_protobuf_encoded', makePointsShopQuery(cursor, categoryConfig.communityItemClass));
  apiUrl.searchParams.set('format', 'json');

  const { pointShopResponse } = await retrySteamRequest(async () => {
    const result = await axios.get<SteamPointShopResponse>(apiUrl.href, {
      timeout: 15000,
      headers: { Accept: 'application/json' },
    });
    const responses = result.data.response?.responses || [];
    const validResponses = responses.filter((entry) => entry.eresult === 1 && Array.isArray(entry.response?.definitions));
    const pointShopResponse = category === 'profile-themes'
      ? validResponses.map((entry) => entry.response!).sort((left, right) => (right.definitions?.length || 0) - (left.definitions?.length || 0))[0]
      : validResponses[0]?.response;
    const definitions = pointShopResponse?.definitions;
    if (!pointShopResponse || !Array.isArray(definitions)) {
      const terminalPage = cursor
        ? responses.find((entry) => entry.eresult === 1 && entry.response?.count === 0 && entry.response.next_cursor === cursor)?.response
        : undefined;
      if (terminalPage) {
        return { pointShopResponse: { ...terminalPage, definitions: [], next_cursor: undefined } };
      }
      const resultCodes = responses.map((entry) => entry.eresult ?? 'missing').join(', ') || 'no response entries';
      const responseShape = JSON.stringify({
        topLevelKeys: Object.keys(result.data || {}),
        responseKeys: Object.keys(result.data.response || {}),
        entries: responses.slice(0, 2).map((entry) => ({
          eresult: entry.eresult,
          responseKeys: Object.keys(entry.response || {}),
          responsePreview: JSON.stringify(entry.response).slice(0, 500),
        })),
      });
      throw new InvalidSteamPointShopResponseError(`Steam returned an invalid ${category} catalog (eresult: ${resultCodes}; response: ${responseShape}).`);
    }
    return { pointShopResponse: { ...pointShopResponse, definitions } };
  }, {
    maxAttempts: 6,
    baseDelayMs: 2000,
    maxBackoffMs: 30000,
    maxRetryAfterMs: 60000,
    isRetryable: (error) => error instanceof InvalidSteamPointShopResponseError,
  });

  const items = pointShopResponse.definitions.flatMap((definition): CatalogItem[] => {
    const data = definition.community_item_data;
    const appid = definition.appid;
    const image = data?.item_image_large;
    const defid = definition.defid;
    if (!definition.active || definition.community_item_class !== categoryConfig.communityItemClass || !appid || !defid || !image) return [];
    const assetBase = `https://shared.fastly.steamstatic.com/community_assets/images/items/${appid}/`;
    const steamUrl = `https://store.steampowered.com/points/shop/app/${appid}`;

    if (category === 'points-backgrounds') {
      if (!data?.animated) return [];
      return [{
        id: `points:${appid}:${defid}`,
        name: data.item_title || data.item_name || 'Animated profile background',
        game: String(appid),
        price: '',
        imageUrl: `https://community.fastly.steamstatic.com/economy/profilebackground/items/${appid}/${image}?size=320x200`,
        videoPoster: `${assetBase}${image}`,
        steamUrl,
        animated: true,
        videoWebm: data.item_movie_webm ? `${assetBase}${data.item_movie_webm}` : undefined,
        videoMp4: data.item_movie_mp4 ? `${assetBase}${data.item_movie_mp4}` : undefined,
      }];
    }

    if (category === 'avatar-frames') {
      return [{
        id: `frame:${appid}:${defid}`,
        name: data?.item_title || data?.item_name || 'Avatar frame',
        game: String(appid),
        imageUrl: `${assetBase}${image}`,
        thumbnailUrl: `${assetBase}${data?.item_image_small || image}`,
        steamUrl,
        animatedImageUrl: data?.animated && data.item_image_small ? `${assetBase}${data.item_image_small}` : undefined,
        animated: Boolean(data?.animated),
      }];
    }

    if (!data?.profile_theme_id || !definition.bundle_defids?.length) return [];
    return [{
      id: `theme:${appid}:${defid}`,
      name: data.item_title || data.item_name || 'Profile theme',
      game: String(appid),
      appid,
      communityItemType: definition.community_item_type,
      profileThemeId: data.profile_theme_id,
      bundleDefids: definition.bundle_defids,
      imageUrl: `${assetBase}${image}`,
      thumbnailUrl: `${assetBase}${data.item_image_small || image}`,
      steamUrl,
    }];
  });

  return {
    items,
    totalCount: pointShopResponse.total_count || items.length,
    nextCursor: pointShopResponse.next_cursor || null,
  };
}

let catalogDbReady: Promise<void> | null = null;
let profileMetricsDbReady: Promise<void> | null = null;

async function ensureProfileMetricsDatabase(): Promise<void> {
  if (!catalogPool) throw new Error('DATABASE_URL is not configured.');
  if (!profileMetricsDbReady) {
    profileMetricsDbReady = catalogPool.query(`
      CREATE TABLE IF NOT EXISTS unique_steam_profiles (
        steamid64 CHAR(17) PRIMARY KEY,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).then(() => undefined).catch((error) => {
      profileMetricsDbReady = null;
      throw error;
    });
  }
  await profileMetricsDbReady;
}

async function ensureCatalogDatabase(): Promise<void> {
  if (!catalogPool) throw new Error('DATABASE_URL is not configured.');
  if (!catalogDbReady) {
    catalogDbReady = (async () => {
      await catalogPool.query(`
        CREATE TABLE IF NOT EXISTS points_catalog_items (
          category TEXT NOT NULL,
          id TEXT NOT NULL,
          name TEXT NOT NULL,
          game TEXT NOT NULL,
          payload JSONB NOT NULL,
          last_seen_run UUID NOT NULL,
          PRIMARY KEY (category, id)
        );
        CREATE INDEX IF NOT EXISTS points_catalog_search_idx ON points_catalog_items (category, lower(name));
        CREATE TABLE IF NOT EXISTS points_catalog_sync (
          category TEXT PRIMARY KEY,
          cursor TEXT,
          run_id UUID,
          complete BOOLEAN NOT NULL DEFAULT FALSE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_completed_at TIMESTAMPTZ,
          last_error TEXT
        );
        ALTER TABLE points_catalog_sync ADD COLUMN IF NOT EXISTS last_completed_at TIMESTAMPTZ;
        ALTER TABLE points_catalog_sync ADD COLUMN IF NOT EXISTS last_error TEXT;
      `);
    })().catch((error) => {
      catalogDbReady = null;
      throw error;
    });
  }
  await catalogDbReady;
}

async function searchIndexedCatalog(category: CatalogCategory, query: string, page: number): Promise<{ items: CatalogItem[]; totalCount: number; pageSize: number } | null> {
  if (!catalogPool) return null;
  await ensureCatalogDatabase();
  const state = await catalogPool.query<{ complete: boolean }>('SELECT complete FROM points_catalog_sync WHERE category = $1', [category]);
  if (!state.rows[0]?.complete) return null;
  const term = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const count = await catalogPool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM points_catalog_items WHERE category = $1 AND (name ILIKE $2 ESCAPE \'\\\' OR game ILIKE $2 ESCAPE \'\\\')',
    [category, term],
  );
  const result = await catalogPool.query<{ payload: CatalogItem }>(
    'SELECT payload FROM points_catalog_items WHERE category = $1 AND (name ILIKE $2 ESCAPE \'\\\' OR game ILIKE $2 ESCAPE \'\\\') ORDER BY lower(name), id LIMIT 20 OFFSET $3',
    [category, term, page * 20],
  );
  return { items: result.rows.map((row) => row.payload), totalCount: Number(count.rows[0]?.count || 0), pageSize: 20 };
}

let catalogSyncRunning = false;
let catalogRetryTimer: ReturnType<typeof setTimeout> | null = null;
const catalogSyncIntervalMs = 24 * 60 * 60 * 1000;
const catalogSyncContinueMs = 3000;
const catalogSyncRetryMs = 5 * 60 * 1000;

function scheduleCatalogSync(delayMs: number): void {
  if (catalogRetryTimer) clearTimeout(catalogRetryTimer);
  catalogRetryTimer = setTimeout(() => {
    catalogRetryTimer = null;
    void syncPointsCatalog();
  }, delayMs);
  catalogRetryTimer.unref();
}

async function syncCatalogCategory(category: CatalogCategory): Promise<boolean> {
  const stateResult = await catalogPool!.query<{
    cursor: string | null;
    run_id: string | null;
    complete: boolean;
    fresh: boolean;
  }>(
    `SELECT cursor, run_id, complete,
      last_completed_at > NOW() - INTERVAL '24 hours' AS fresh
     FROM points_catalog_sync WHERE category = $1`,
    [category],
  );
  const current = stateResult.rows[0];
  if (current?.complete && current.fresh && !current.run_id) return false;

  const runId = current?.run_id || randomUUID();
  const cursor = current?.run_id ? current.cursor || undefined : undefined;
  if (!current?.run_id) {
    await catalogPool!.query(
      `INSERT INTO points_catalog_sync (category, cursor, run_id, complete)
       VALUES ($1, NULL, $2, FALSE)
       ON CONFLICT (category) DO UPDATE
       SET cursor = NULL, run_id = $2, updated_at = NOW(), last_error = NULL`,
      [category, runId],
    );
  }

  const page = await fetchPointShopPage(category, cursor);
  if (cursor && page.nextCursor === cursor) {
    throw new Error(`Steam repeated the pagination cursor for ${category}.`);
  }

  const client = await catalogPool!.connect();
  try {
    await client.query('BEGIN');
    for (const item of page.items) {
      await client.query(
        'INSERT INTO points_catalog_items (category, id, name, game, payload, last_seen_run) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (category, id) DO UPDATE SET name = EXCLUDED.name, game = EXCLUDED.game, payload = EXCLUDED.payload, last_seen_run = EXCLUDED.last_seen_run',
        [category, item.id, item.name, item.game, JSON.stringify(item), runId],
      );
    }
    await client.query(
      'UPDATE points_catalog_sync SET cursor = $2, run_id = $3, updated_at = NOW(), last_error = NULL WHERE category = $1',
      [category, page.nextCursor, runId],
    );
    if (!page.nextCursor) {
      await client.query('DELETE FROM points_catalog_items WHERE category = $1 AND last_seen_run <> $2', [category, runId]);
      await client.query(
        'UPDATE points_catalog_sync SET cursor = NULL, run_id = NULL, complete = TRUE, updated_at = NOW(), last_completed_at = NOW(), last_error = NULL WHERE category = $1',
        [category],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  console.log(`Points Shop sync ${category}: saved ${page.items.length} items${page.nextCursor ? '; more pages remain.' : '; category complete.'}`);
  return Boolean(page.nextCursor);
}

async function syncPointsCatalog(): Promise<void> {
  if (!catalogPool || catalogSyncRunning) return;
  catalogSyncRunning = true;
  let lockClient: import('pg').PoolClient | undefined;
  try {
    await ensureCatalogDatabase();
    lockClient = await catalogPool.connect();
    const lockResult = await lockClient.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(741902318) AS locked');
    if (!lockResult.rows[0]?.locked) {
      scheduleCatalogSync(30_000);
      return;
    }

    let needsMorePages = false;
    let failedCategory = false;
    for (const { key: category } of catalogCategories) {
      try {
        needsMorePages = await syncCatalogCategory(category) || needsMorePages;
      } catch (error) {
        failedCategory = true;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Points Shop sync failed for ${category}; checkpoint preserved.`, error);
        await catalogPool.query(
          'UPDATE points_catalog_sync SET last_error = $2, updated_at = NOW() WHERE category = $1',
          [category, message.slice(0, 500)],
        ).catch((databaseError: unknown) => {
          console.error(`Could not record sync error for ${category}.`, databaseError);
        });
      }
    }

    if (failedCategory) scheduleCatalogSync(catalogSyncRetryMs);
    else scheduleCatalogSync(needsMorePages ? catalogSyncContinueMs : catalogSyncIntervalMs);
  } catch (error) {
    console.error('Points Shop catalog sync paused; it will resume on the next run.', error);
    scheduleCatalogSync(catalogSyncRetryMs);
  } finally {
    if (lockClient) {
      try { await lockClient.query('SELECT pg_advisory_unlock(741902318)'); } catch { /* connection may already be closed */ }
      lockClient.release();
    }
    catalogSyncRunning = false;
  }
}

app.get('/api/catalog-status', async (_request, response) => {
  if (!catalogPool) {
    response.status(503).json({ configured: false, error: 'DATABASE_URL is not configured.' });
    return;
  }
  try {
    await ensureCatalogDatabase();
    const result = await catalogPool.query(`
      SELECT sync.category, sync.complete, sync.run_id IS NOT NULL AS in_progress,
        sync.updated_at, sync.last_completed_at, sync.last_error,
        COUNT(items.id)::text AS item_count
      FROM points_catalog_sync AS sync
      LEFT JOIN points_catalog_items AS items ON items.category = sync.category
      GROUP BY sync.category, sync.complete, sync.run_id, sync.updated_at, sync.last_completed_at, sync.last_error
      ORDER BY sync.category
    `);
    response.setHeader('Cache-Control', 'no-store');
    response.json({ configured: true, categories: result.rows });
  } catch (error) {
    console.error('Could not read Points Shop catalog status.', error);
    response.status(503).json({ configured: true, error: 'Could not read catalog status.' });
  }
});

async function respondWithIndexedSearch(category: CatalogCategory, request: express.Request, response: express.Response): Promise<boolean> {
  const query = typeof request.query.query === 'string' ? request.query.query.trim().slice(0, 80) : '';
  if (typeof request.query.cursor === 'string') return false;
  const page = Number(request.query.page ?? 0);
  if (!Number.isSafeInteger(page) || page < 0 || page > 5000) {
    response.status(400).json({ error: 'Invalid catalog search page.' });
    return true;
  }
  try {
    const result = await searchIndexedCatalog(category, query, page);
    if (!result) return false;
    response.setHeader('Cache-Control', 'public, max-age=300');
    response.json({ ...result, nextCursor: null, catalogIndexed: true });
    return true;
  } catch (error) {
    console.error(`Could not search indexed ${category}; using Steam fallback.`, error);
    return false;
  }
}

app.use(express.json({ limit: '4kb' }));

const steamBackgroundImageHosts = new Set([
  steamImageHost,
  'community.steamstatic.com',
  'steamcdn-a.akamaihd.net',
  'cdn.akamai.steamstatic.com',
  'cdn.cloudflare.steamstatic.com',
  'shared.fastly.steamstatic.com',
  'shared.akamai.steamstatic.com',
  'shared.cloudflare.steamstatic.com',
]);
const maxBackgroundImageBytes = 12 * 1024 * 1024;

function isAllowedBackgroundImageUrl(url: URL) {
  return url.protocol === 'https:' && !url.username && !url.password
    && steamBackgroundImageHosts.has(url.hostname) && !url.port;
}

app.get('/api/profile-background-image', async (request, response) => {
  const rawUrl = typeof request.query.url === 'string' ? request.query.url : '';
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    response.status(400).json({ error: 'Invalid background image URL.' });
    return;
  }
  if (!isAllowedBackgroundImageUrl(target)) {
    response.status(400).json({ error: 'Only Steam background images can be loaded.' });
    return;
  }

  try {
    let current = target;
    let upstream;
    for (let redirects = 0; redirects <= 3; redirects++) {
      upstream = await axios.get<ArrayBuffer>(current.href, {
        responseType: 'arraybuffer',
        timeout: 15000,
        maxRedirects: 0,
        maxContentLength: maxBackgroundImageBytes,
        validateStatus: (status) => status >= 200 && status < 400,
      });
      if (upstream.status < 300) break;
      const location = upstream.headers.location;
      if (!location) throw new Error('Missing redirect location.');
      current = new URL(location, current);
      if (!isAllowedBackgroundImageUrl(current)) throw new Error('Redirected outside Steam image hosts.');
      upstream = undefined;
    }
    const contentType = String(upstream?.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!upstream || !/^image\/(png|jpe?g|webp|gif)$/.test(contentType)) {
      response.status(502).json({ error: 'Steam did not return a usable background image.' });
      return;
    }
    response.setHeader('Content-Type', contentType);
    response.setHeader('Cache-Control', 'public, max-age=86400');
    response.send(Buffer.from(upstream.data));
  } catch {
    response.status(502).json({ error: 'Could not load the profile background image from Steam.' });
  }
});

app.get('/api/backgrounds', async (request, response) => {
  const query = typeof request.query.query === 'string' ? request.query.query.trim().slice(0, 80) : '';
  const start = Number(request.query.start ?? 0);
  const count = Number(request.query.count ?? 30);
  if (!Number.isInteger(start) || start < 0 || start > 100000 || !Number.isInteger(count) || count < 1 || count > 30) {
    response.status(400).json({ error: 'Invalid background search page.' });
    return;
  }

  const cacheKey = `market:${query.toLowerCase()}:${start}:${count}`;
  try {
    const payload = await getCachedCatalog(cacheKey, async () => {
  const marketUrl = new URL('/market/search/render/', `https://${steamHost}`);
  marketUrl.searchParams.set('query', query);
  marketUrl.searchParams.set('count', '10');
  marketUrl.searchParams.set('search_descriptions', '0');
  marketUrl.searchParams.set('sort_column', 'popular');
  marketUrl.searchParams.set('sort_dir', 'desc');
  marketUrl.searchParams.set('appid', '753');
  marketUrl.searchParams.append('category_753_item_class[]', 'tag_item_class_3');
  marketUrl.searchParams.set('norender', '1');

    const pages: Awaited<ReturnType<typeof axios.get<SteamMarketResponse>>>[] = [];
    for (let index = 0; index < Math.ceil(count / 10); index++) {
      const pageUrl = new URL(marketUrl);
      pageUrl.searchParams.set('start', String(start + index * 10));
      pages.push(await retrySteamRequest(() => axios.get<SteamMarketResponse>(pageUrl.href, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: 'https://steamcommunity.com/market/',
          Origin: 'https://steamcommunity.com',
          'X-Requested-With': 'XMLHttpRequest',
        },
      }), {
        maxAttempts: 6,
        baseDelayMs: 2000,
        maxBackoffMs: 30000,
        maxRetryAfterMs: 60000,
      }));
    }
    if (pages.some(({ data }) => !data.success || !Array.isArray(data.results))) throw new Error('Steam returned an invalid background catalog.');

    const items = pages.flatMap(({ data }) => data.results || []).flatMap((item) => {
      const description = item.asset_description;
      const hashName = item.hash_name || description?.market_hash_name;
      const iconUrl = description?.icon_url;
      if (!description?.type?.toLowerCase().includes('profile background') || !hashName || !iconUrl || !/^[\w-]+$/.test(iconUrl)) return [];

      return [{
        id: hashName,
        name: description.market_name || item.name || hashName,
        game: description.type.replace(/\s+profile background$/i, ''),
        price: item.sell_price_text || '',
        imageUrl: `https://${steamImageHost}/economy/image/${iconUrl}`,
        steamUrl: new URL(`/market/listings/753/${encodeURIComponent(hashName)}`, `https://${steamHost}`).href,
      }];
    });
    const uniqueItems = [...new Map(items.map((item) => [item.id, item])).values()];

      return { items: uniqueItems, totalCount: pages[0].data.total_count || 0, pageSize: count };
    });
    setCatalogCacheHeaders(response);
    response.json(payload);
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 429) {
      response.status(503).json({ error: 'Steam is temporarily limiting Market requests. Please try again later.' });
      return;
    }
    response.status(502).json({ error: 'Steam could not load profile backgrounds right now.' });
  }
});

app.get('/api/points-backgrounds', async (request, response) => {
  if (await respondWithIndexedSearch('points-backgrounds', request, response)) return;
  const cursor = typeof request.query.cursor === 'string' ? request.query.cursor : '';
  if (cursor && (cursor.length > 128 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cursor))) {
    response.status(400).json({ error: 'Invalid Points Shop page cursor.' });
    return;
  }

  const cacheKey = `points-v3:${cursor || 'first'}`;
  try {
    const payload = await getCachedCatalog(cacheKey, async () => {
  const apiUrl = new URL('/ILoyaltyRewardsService/BatchedQueryRewardItems/v1', 'https://api.steampowered.com');
  apiUrl.searchParams.set('origin', 'https://store.steampowered.com');
  apiUrl.searchParams.set('input_protobuf_encoded', makePointsShopQuery(cursor || undefined));
  apiUrl.searchParams.set('format', 'json');

    const result = await axios.get<SteamPointShopResponse>(apiUrl.href, {
      timeout: 15000,
      headers: { Accept: 'application/json' },
    });
    const pointShopResponse = result.data.response?.responses?.find((entry) => entry.eresult === 1)?.response;
    if (!pointShopResponse || !Array.isArray(pointShopResponse.definitions)) throw new Error('Steam returned an invalid Points Shop catalog.');

    const items = pointShopResponse.definitions.flatMap((definition) => {
      const data = definition.community_item_data;
      const appid = definition.appid;
      const image = data?.item_image_large;
      if (!definition.active || definition.community_item_class !== 3 || !data?.animated || !appid || !definition.defid || !image) return [];

      const assetBase = `https://shared.fastly.steamstatic.com/community_assets/images/items/${appid}/`;
      return [{
        id: `points:${appid}:${definition.defid}`,
        name: data.item_title || data.item_name || 'Animated profile background',
        game: String(appid),
        price: '',
        imageUrl: `https://community.fastly.steamstatic.com/economy/profilebackground/items/${appid}/${image}?size=320x200`,
        videoPoster: `${assetBase}${image}`,
        steamUrl: `https://store.steampowered.com/points/shop/app/${appid}`,
        animated: true,
        videoWebm: data.item_movie_webm ? `${assetBase}${data.item_movie_webm}` : undefined,
        videoMp4: data.item_movie_mp4 ? `${assetBase}${data.item_movie_mp4}` : undefined,
      }];
    });

    const payload = {
      items,
      totalCount: pointShopResponse.total_count || items.length,
      pageSize: 20,
      nextCursor: pointShopResponse.next_cursor || null,
    };
      return payload;
    });
    setCatalogCacheHeaders(response);
    response.json(payload);
  } catch {
    response.status(502).json({ error: 'Steam could not load animated Points Shop backgrounds right now.' });
  }
});

app.get('/api/avatar-frames', async (request, response) => {
  if (await respondWithIndexedSearch('avatar-frames', request, response)) return;
  const cursor = typeof request.query.cursor === 'string' ? request.query.cursor : '';
  if (cursor && (cursor.length > 128 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cursor))) {
    response.status(400).json({ error: 'Invalid avatar frame page cursor.' });
    return;
  }

  const cacheKey = `frames-v3:${cursor || 'first'}`;
  try {
    const payload = await getCachedCatalog(cacheKey, async () => {
  const apiUrl = new URL('/ILoyaltyRewardsService/BatchedQueryRewardItems/v1', 'https://api.steampowered.com');
  apiUrl.searchParams.set('origin', 'https://store.steampowered.com');
  apiUrl.searchParams.set('input_protobuf_encoded', makePointsShopQuery(cursor || undefined, 14));
  apiUrl.searchParams.set('format', 'json');

    const result = await axios.get<SteamPointShopResponse>(apiUrl.href, {
      timeout: 15000,
      headers: { Accept: 'application/json' },
    });
    const pointShopResponse = result.data.response?.responses?.find((entry) => entry.eresult === 1)?.response;
    if (!pointShopResponse || !Array.isArray(pointShopResponse.definitions)) throw new Error('Steam returned an invalid avatar frame catalog.');

    const items = pointShopResponse.definitions.flatMap((definition) => {
      const data = definition.community_item_data;
      const appid = definition.appid;
      const image = data?.item_image_large;
      if (!definition.active || definition.community_item_class !== 14 || !appid || !definition.defid || !image) return [];

      const assetBase = `https://shared.fastly.steamstatic.com/community_assets/images/items/${appid}/`;
      return [{
        id: `frame:${appid}:${definition.defid}`,
        name: data.item_title || data.item_name || 'Avatar frame',
        game: String(appid),
        imageUrl: `${assetBase}${image}`,
        thumbnailUrl: `${assetBase}${data.item_image_small || image}`,
        steamUrl: `https://store.steampowered.com/points/shop/app/${appid}`,
        animatedImageUrl: data.animated && data.item_image_small ? `${assetBase}${data.item_image_small}` : undefined,
        animated: Boolean(data.animated),
      }];
    });

    const payload = {
      items,
      totalCount: pointShopResponse.total_count || items.length,
      pageSize: 20,
      nextCursor: pointShopResponse.next_cursor || null,
    };
      return payload;
    });
    setCatalogCacheHeaders(response);
    response.json(payload);
  } catch {
    response.status(502).json({ error: 'Steam could not load avatar frames right now.' });
  }
});

app.get('/api/profile-themes', async (request, response) => {
  if (await respondWithIndexedSearch('profile-themes', request, response)) return;
  const cursor = typeof request.query.cursor === 'string' ? request.query.cursor : '';
  if (cursor && (cursor.length > 128 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cursor))) {
    response.status(400).json({ error: 'Invalid profile theme page cursor.' });
    return;
  }

  const cacheKey = `profile-themes-v5:${cursor || 'first'}`;
  try {
    const payload = await getCachedCatalog(cacheKey, async () => {
      const apiUrl = new URL('/ILoyaltyRewardsService/BatchedQueryRewardItems/v1', 'https://api.steampowered.com');
      apiUrl.searchParams.set('origin', 'https://store.steampowered.com');
      apiUrl.searchParams.set('input_protobuf_encoded', makePointsShopQuery(cursor || undefined, 8));
      apiUrl.searchParams.set('format', 'json');

      const result = await axios.get<SteamPointShopResponse>(apiUrl.href, {
        timeout: 15000,
        headers: { Accept: 'application/json' },
      });
      const pointShopResponse = result.data.response?.responses
        ?.filter((entry) => entry.eresult === 1 && Array.isArray(entry.response?.definitions))
        .map((entry) => entry.response!)
        .sort((left, right) => (right.definitions?.length || 0) - (left.definitions?.length || 0))[0];
      if (!pointShopResponse || !Array.isArray(pointShopResponse.definitions)) throw new Error('Steam returned an invalid profile theme catalog.');

      const items = pointShopResponse.definitions.flatMap((definition) => {
        const data = definition.community_item_data;
        const appid = definition.appid;
        const image = data?.item_image_large;
        if (!definition.active || definition.community_item_class !== 8 || !data?.profile_theme_id || !appid || !definition.defid || !image || !definition.bundle_defids?.length) return [];

        const assetBase = `https://shared.fastly.steamstatic.com/community_assets/images/items/${appid}/`;
        return [{
          id: `theme:${appid}:${definition.defid}`,
          name: data.item_title || data.item_name || 'Profile theme',
          game: String(appid),
          appid,
          communityItemType: definition.community_item_type,
          profileThemeId: data.profile_theme_id,
          bundleDefids: definition.bundle_defids,
          imageUrl: `${assetBase}${image}`,
          thumbnailUrl: `${assetBase}${data.item_image_small || image}`,
          steamUrl: `https://store.steampowered.com/points/shop/app/${appid}`,
        }];
      });

      return {
        items,
        totalCount: pointShopResponse.total_count || items.length,
        pageSize: 20,
        nextCursor: pointShopResponse.next_cursor || null,
      };
    });
    setCatalogCacheHeaders(response);
    response.json(payload);
  } catch {
    response.status(502).json({ error: 'Steam could not load profile themes right now.' });
  }
});

app.get('/api/profile-theme-style', async (request, response) => {
  const appid = Number(request.query.appid);
  const itemType = Number(request.query.itemtype);
  if (!Number.isSafeInteger(appid) || appid < 1 || appid > 0xffffffff || !Number.isSafeInteger(itemType) || itemType < 1 || itemType > 0xffffffff) {
    response.status(400).json({ error: 'Invalid profile theme preview identifiers.' });
    return;
  }

  const previewUrl = new URL('/profiles/76561197960266962', `https://${steamHost}`);
  previewUrl.searchParams.set('previewprofile', '1');
  previewUrl.searchParams.set('appid', String(appid));
  previewUrl.searchParams.set('itemtype', String(itemType));
  const cacheKey = `profile-theme-style:${appid}:${itemType}`;

  try {
    const payload = await getCachedCatalog(cacheKey, async () => {
      const result = await axios.get<string>(previewUrl.href, {
        timeout: 15000,
        maxRedirects: 5,
        responseType: 'text',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
      });
      const $ = load(result.data);
      const themeRule = $('style').toArray()
        .map((element) => $(element).text().match(/body\.GameProfileTheme\s*\{([^}]*)\}/s)?.[1])
        .find(Boolean);
      if (!themeRule) throw new Error('Steam did not return profile theme styles.');

      const allowedProperties = new Set([
        '--gradient-right', '--gradient-left', '--gradient-background', '--gradient-background-right',
        '--gradient-background-left', '--color-showcase-header', '--gradient-showcase-header-left',
        '--btn-background', '--btn-background-hover', '--btn-outline',
      ]);
      const variables: Record<string, string> = {};
      for (const declaration of themeRule.matchAll(/(--[\w-]+)\s*:\s*([^;]+)\s*;?/g)) {
        const [, property, rawValue] = declaration;
        const value = rawValue.trim();
        if (!allowedProperties.has(property)) continue;
        if (/^(?:#[\da-f]{3,8}|rgba?\([\d.%\s,/]+\)|hsla?\([\d.%\s,/]+\)|transparent)$/i.test(value)) {
          variables[property] = value;
        }
      }
      if (!variables['--color-showcase-header'] || !variables['--gradient-background']) {
        throw new Error('Steam returned incomplete profile theme styles.');
      }
      return { variables };
    });
    setCatalogCacheHeaders(response);
    response.json(payload);
  } catch {
    response.status(502).json({ error: 'Steam could not load the selected profile theme right now.' });
  }
});

app.get('/api/profile-theme-items', async (request, response) => {
  const rawDefids = typeof request.query.defids === 'string' ? request.query.defids : '';
  const defids = rawDefids.split(',').map((value) => Number(value));
  if (!rawDefids || defids.length < 1 || defids.length > 8 || defids.some((defid) => !Number.isInteger(defid) || defid < 1 || defid > 0xffffffff)) {
    response.status(400).json({ error: 'Invalid profile theme bundle item IDs.' });
    return;
  }

  const uniqueDefids = [...new Set(defids)];
  const cacheKey = `profile-theme-items:${uniqueDefids.slice().sort((a, b) => a - b).join(',')}`;
  try {
    const payload = await getCachedCatalog(cacheKey, async () => {
      const apiUrl = new URL('/ILoyaltyRewardsService/BatchedQueryRewardItems/v1', 'https://api.steampowered.com');
      apiUrl.searchParams.set('origin', 'https://store.steampowered.com');
      apiUrl.searchParams.set('input_protobuf_encoded', makeRewardDefinitionsQuery(uniqueDefids));
      apiUrl.searchParams.set('format', 'json');
      const result = await axios.get<SteamPointShopResponse>(apiUrl.href, { timeout: 15000, headers: { Accept: 'application/json' } });
      const definitions = result.data.response?.responses?.flatMap((entry) => entry.eresult === 1 ? entry.response?.definitions || [] : []) || [];
      if (definitions.length !== uniqueDefids.length) throw new Error('Steam returned an incomplete profile theme bundle.');
      return { items: definitions };
    });
    setCatalogCacheHeaders(response);
    response.json(payload);
  } catch {
    response.status(502).json({ error: 'Steam could not load the profile theme bundle right now.' });
  }
});

function resolveProfileUrl(input: unknown): URL {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Enter a SteamID64, custom profile name, or full profile URL.');
  }

  const value = input.trim();
  if (/^\d{17}$/.test(value)) return new URL(`/profiles/${value}`, `https://${steamHost}`);

  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new Error('That does not look like a valid Steam profile address.');
  }

  if (parsed.hostname !== steamHost && parsed.hostname !== `www.${steamHost}`) {
    if (value.includes('/') || value.includes(':')) {
      throw new Error('Use a steamcommunity.com profile URL or enter only the custom profile name.');
    }
    return new URL(`/id/${encodeURIComponent(value)}`, `https://${steamHost}`);
  }

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || !['id', 'profiles'].includes(parts[0])) {
    throw new Error('Use a Steam profile URL in the form /id/name or /profiles/SteamID64.');
  }
  if (parts[0] === 'profiles' && !/^\d{17}$/.test(parts[1])) {
    throw new Error('The SteamID64 in that profile URL must contain 17 digits.');
  }
  if (parts[0] === 'id' && !/^[\w-]{1,64}$/.test(decodeURIComponent(parts[1]))) {
    throw new Error('That custom profile name contains unsupported characters.');
  }

  return new URL(`/${parts[0]}/${encodeURIComponent(decodeURIComponent(parts[1]))}`, `https://${steamHost}`);
}

function extractPublicScreenshots(html: string, pageUrl: string): PublicScreenshot[] {
  const $ = load(html);
  const screenshots: PublicScreenshot[] = [];
  $('a.profile_media_item[data-publishedfileid]').each((_, element) => {
    if (screenshots.length >= 50) return;
    const item = $(element);
    const id = item.attr('data-publishedfileid');
    const rawImage = item.find('.imgWallItem').first().attr('style')?.match(/background-image\s*:\s*url\(['"]?([^'"\)]+)['"]?\)/i)?.[1];
    if (!id || !rawImage) return;
    try {
      const thumbnailUrl = new URL(rawImage, pageUrl);
      if (thumbnailUrl.hostname !== 'images.steamusercontent.com') return;
      const imageUrl = new URL(thumbnailUrl.href);
      imageUrl.search = '';
      imageUrl.hash = '';
      const aspectRatio = Number(item.attr('data-desired-aspect'));
      screenshots.push({
        id,
        imageUrl: imageUrl.href,
        thumbnailUrl: thumbnailUrl.href,
        steamUrl: new URL(item.attr('href') || `/sharedfiles/filedetails/?id=${id}`, pageUrl).href,
        searchText: `Screenshot ${id} App ${item.attr('data-appid') || ''}`,
        ...(Number.isInteger(Number(item.attr('data-appid'))) ? { appid: Number(item.attr('data-appid')) } : {}),
        ...(Number.isFinite(aspectRatio) && aspectRatio > 0 ? { aspectRatio } : {}),
      });
    } catch {
      // Ignore malformed or non-public screenshot URLs.
    }
  });
  return screenshots;
}

function makeInertDocument(html: string, pageUrl: string): { html: string; name: string; avatar?: string; level?: number } {
  const $ = load(html);
  $('#global_header').remove();
  $('script, iframe, object, embed').remove();
  $('*').each((_, element) => {
    if (!('attribs' in element)) return;
    for (const attribute of Object.keys(element.attribs)) {
      if (attribute.toLowerCase().startsWith('on')) $(element).removeAttr(attribute);
    }
  });
  $('base').remove();
  $('head').prepend(`<base href="${new URL('/', pageUrl).href}">`);

  const name = $('#personaName').text().trim()
    || $('.actual_persona_name').first().text().trim()
    || $('title').text().trim()
    || 'Steam profile';
  const levelText = $('.profile_header_badgeinfo .friendPlayerLevelNum').first().text().trim();
  const level = /^\d+$/.test(levelText) ? Number(levelText) : undefined;
  const avatarImages = $('.playerAvatarAutoSizeInner img, .playerAvatar img').toArray();
  const avatarSource = $('meta[property="og:image"]').attr('content')
    || $('meta[name="twitter:image"]').attr('content')
    || avatarImages.map((image) => {
      const candidate = $(image).attr('src')
        || $(image).attr('data-src')
        || $(image).attr('srcset')?.split(',')[0]?.trim().split(/\s+/)[0];
      return candidate && new URL(candidate, pageUrl).hostname === 'avatars.fastly.steamstatic.com' ? candidate : undefined;
    }).find(Boolean);
  const avatar = avatarSource ? new URL(avatarSource, pageUrl).href : undefined;

  return { html: $.html(), name, ...(avatar ? { avatar } : {}), ...(level !== undefined ? { level } : {}) };
}

function extractSteamId64(html: string, pageUrl: string): string | undefined {
  const urlMatch = pageUrl.match(/\/profiles\/(\d{17})(?:\/|$)/);
  if (urlMatch) return urlMatch[1];

  const $ = load(html);
  const canonicalUrl = $('link[rel="canonical"]').attr('href')
    || $('meta[property="og:url"]').attr('content');
  const canonicalMatch = canonicalUrl?.match(/\/profiles\/(\d{17})(?:\/|$)/);
  if (canonicalMatch) return canonicalMatch[1];

  return html.match(/(?:steamid(?:64)?|steam_id(?:64)?)["']?\s*[:=]\s*["'](\d{17})/i)?.[1];
}

app.post('/api/profile', async (request, response) => {
  let profileUrl: URL;
  try {
    profileUrl = resolveProfileUrl(request.body?.identifier);
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid profile address.' });
    return;
  }

  try {
    const { steamId64, ...profile } = await getCachedCatalog(`profile:${profileUrl.href}`, async () => {
      const result = await getSteamHtmlWithRetry(profileUrl.href, {
        maxAttempts: 6,
        baseDelayMs: 2000,
        maxBackoffMs: 30000,
        maxRetryAfterMs: 30000,
      });
      return {
        ...makeInertDocument(result.data, result.responseUrl),
        url: result.responseUrl,
        steamId64: extractSteamId64(result.data, result.responseUrl),
      };
    }, profileCacheTtlMs);
    if (catalogPool) {
      try {
        if (steamId64) {
          await ensureProfileMetricsDatabase();
          await catalogPool.query(
            'INSERT INTO unique_steam_profiles (steamid64) VALUES ($1) ON CONFLICT (steamid64) DO NOTHING',
            [steamId64],
          );
        } else {
          console.warn(`Could not resolve a SteamID64 for successfully loaded profile: ${profile.url}`);
        }
      } catch (error) {
        console.error('Failed to record the unique Steam profile metric:', error);
      }
    }
    response.setHeader('Cache-Control', 'no-store');
    response.json(profile);
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      response.status(404).json({ error: 'Steam could not find that profile.' });
      return;
    }
    if (axios.isAxiosError(error) && error.code === 'ECONNABORTED') {
      response.status(504).json({ error: 'Steam took too long to respond. Try again in a moment.' });
      return;
    }
    response.status(502).json({ error: 'Steam did not return a usable public profile. It may be private or temporarily unavailable.' });
  }
});

app.get('/api/profile-metrics', async (_request, response) => {
  if (!catalogPool) {
    response.status(503).json({ error: 'Profile metrics require DATABASE_URL to be configured.' });
    return;
  }

  try {
    await ensureProfileMetricsDatabase();
    const result = await catalogPool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM unique_steam_profiles');
    response.setHeader('Cache-Control', 'no-store');
    response.json({ uniqueProfiles: Number(result.rows[0]?.count || 0) });
  } catch (error) {
    console.error('Failed to read the unique Steam profile metric:', error);
    response.status(500).json({ error: 'Could not read profile metrics right now.' });
  }
});

app.post('/api/profile-screenshots', async (request, response) => {
  let profileUrl: URL;
  try {
    profileUrl = resolveProfileUrl(request.body?.profileUrl);
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid profile address.' });
    return;
  }

  const screenshotsUrl = new URL(profileUrl);
  screenshotsUrl.pathname = `${screenshotsUrl.pathname.replace(/\/$/, '')}/screenshots/`;
  const requestedPage = Math.max(1, Number(request.body?.page) || 1);
  const pageBatchSize = 6;
  const cacheKey = `profile-screenshots:${screenshotsUrl.href}:page-${requestedPage}`;
  try {
    const catalog = await getCachedCatalog(cacheKey, async () => {
      const pages: PublicScreenshot[][] = [];
      for (let index = 0; index < pageBatchSize; index += 1) {
        const pageUrl = new URL(screenshotsUrl.href);
        pageUrl.searchParams.set('p', String(requestedPage + index));
        const result = await getSteamHtmlWithRetry(pageUrl.href);
        pages.push(extractPublicScreenshots(result.data, result.responseUrl));
        if (index < pageBatchSize - 1) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return {
        items: [...new Map(pages.flat().map((item) => [item.id, item])).values()],
        hasMore: pages[pages.length - 1]?.length > 0,
      };
    });
    setCatalogCacheHeaders(response);
    response.json(catalog);
  } catch (error) {
    const status = axios.isAxiosError(error) && error.response?.status === 429 ? 429 : axios.isAxiosError(error) && error.code === 'ECONNABORTED' ? 504 : 502;
    response.status(status).json({ error: status === 429 ? 'Steam is rate limiting screenshot requests. Wait a moment and try again.' : status === 504 ? 'Steam took too long to load the screenshot gallery.' : 'Steam could not load this public screenshot gallery right now.' });
  }
});

app.post('/api/screenshot-image', async (request, response) => {
  try {
    const screenshotUrl = new URL(String(request.body?.steamUrl || ''));
    if (screenshotUrl.hostname !== steamHost && screenshotUrl.hostname !== `www.${steamHost}` || screenshotUrl.pathname !== '/sharedfiles/filedetails/') {
      throw new Error('Invalid screenshot URL.');
    }
    const imageUrl = await getCachedCatalog(`screenshot-image:${screenshotUrl.href}`, async () => {
      const result = await getSteamHtmlWithRetry(screenshotUrl.href);
      return extractFullScreenshotUrl(result.data, result.responseUrl);
    });
    if (!imageUrl) throw new Error('Steam did not expose a full-resolution screenshot.');
    response.json({ imageUrl });
  } catch (error) {
    const status = axios.isAxiosError(error) && error.response?.status === 429 ? 429 : axios.isAxiosError(error) && error.code === 'ECONNABORTED' ? 504 : 502;
    response.status(status).json({ error: status === 429 ? 'Steam is rate limiting full-resolution requests. Wait a moment and try again.' : status === 504 ? 'Steam took too long to load the full-resolution screenshot.' : 'Steam could not load the full-resolution screenshot right now.' });
  }
});

const clientBuildPath = resolve('dist');
const guidePageMetadata: Record<string, { title: string; description: string }> = {
  'featured-artwork': {
    title: 'Upload long Steam Artwork and Screenshot showcases — SteamCanvas',
    description: 'Follow the practical Steam upload workflow for long Artwork, Featured Artwork, and Screenshot showcase images.',
  },
  'workshop-showcase': {
    title: 'Upload long Steam Workshop Showcase images — SteamCanvas',
    description: 'Prepare, export, and upload the individual images required for a long Steam Workshop Showcase.',
  },
};

app.get('/guides/:slug', async (request, response, next) => {
  const metadata = guidePageMetadata[request.params.slug];
  if (!metadata) {
    next();
    return;
  }

  try {
    const html = await readFile(resolve(clientBuildPath, 'index.html'), 'utf8');
    const document = html
      .replace(/<title>[^<]*<\/title>/, `<title>${metadata.title}</title>`)
      .replace(/(<meta name="description" content=")[^"]*("\s*\/?>)/, `$1${metadata.description}$2`)
      .replace('</head>', `<meta property="og:title" content="${metadata.title}" />\n    <meta property="og:description" content="${metadata.description}" />\n  </head>`);
    response.type('html').send(document);
  } catch (error) {
    next(error);
  }
});

app.use(express.static(clientBuildPath));
app.get(/^(?!\/api(?:\/|$)).*/, (_request, response) => {
  response.sendFile(resolve(clientBuildPath, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`SteamCanvas listening on http://localhost:${port}`);
  if (catalogPool) {
    const initialSync = setTimeout(() => void syncPointsCatalog(), 5000);
    initialSync.unref();
  } else {
    console.log('DATABASE_URL is not configured; Points Shop search will use the Steam fallback.');
  }
});