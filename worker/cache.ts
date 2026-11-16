// Copyright (C) 2026 dumbapplee
// Modified by lannahirave, 2026: the upstream in-memory cache, moved to the Cloudflare Cache API,
// with an optional Workers KV tier shared by every data center.
// SPDX-License-Identifier: AGPL-3.0-only

export const catalogCacheTtlMs = 3 * 60 * 60 * 1000;
export const profileCacheTtlMs = 10 * 60 * 1000;

// How long a stale entry is kept so it can be served when Steam is rate-limiting or down.
const staleKeepMs = 24 * 60 * 60 * 1000;
// KV keeps entries much longer: an old Market page is better than an error.
const kvKeepSeconds = 30 * 24 * 60 * 60;
// After a failed background refresh, this isolate leaves Steam alone for a while for that key.
const refreshCooldownMs = 5 * 60 * 1000;
const cacheOrigin = 'https://steamcanvas-cache.internal';
const kvPrefix = 'catalog:';

type CachedEntry = { expiresAt: number; payload: unknown };
type WaitUntil = (promise: Promise<unknown>) => void;

export type CatalogCacheOptions = {
  /** Shared, cross-data-center store. Use only for public catalogs, never for profile data. */
  kv?: KVNamespace;
  /** Serve a stale entry at once and refresh it in the background, instead of waiting on Steam. */
  staleWhileRevalidate?: boolean;
};

// Joins identical requests that run at the same time in this Worker instance.
const activeRequests = new Map<string, Promise<unknown>>();
const lastRefreshFailure = new Map<string, number>();

function cacheRequest(key: string): Request {
  return new Request(`${cacheOrigin}/${encodeURIComponent(key)}`);
}

async function readCache(key: string): Promise<CachedEntry | null> {
  try {
    const response = await caches.default.match(cacheRequest(key));
    return response ? await response.json() as CachedEntry : null;
  } catch {
    return null;
  }
}

async function writeCache(key: string, entry: CachedEntry): Promise<void> {
  try {
    const maxAge = Math.ceil((entry.expiresAt - Date.now() + staleKeepMs) / 1000);
    if (maxAge <= 0) return;
    await caches.default.put(cacheRequest(key), new Response(JSON.stringify(entry), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${maxAge}` },
    }));
  } catch {
    // The Cache API is unavailable on workers.dev and in some local setups; caching is best effort.
  }
}

async function readKv(kv: KVNamespace, key: string): Promise<CachedEntry | null> {
  try {
    return await kv.get<CachedEntry>(kvPrefix + key, 'json');
  } catch {
    return null;
  }
}

async function writeKv(kv: KVNamespace, key: string, entry: CachedEntry): Promise<void> {
  try {
    await kv.put(kvPrefix + key, JSON.stringify(entry), { expirationTtl: kvKeepSeconds });
  } catch {
    // Best effort, like the Cache API (for example, the daily write limit on the free plan).
  }
}

function isFresh(entry: CachedEntry | null): boolean {
  return !!entry && entry.expiresAt > Date.now();
}

function load<T>(key: string, loadCatalog: () => Promise<T>, ttlMs: number, kv: KVNamespace | undefined, waitUntil?: WaitUntil): Promise<T> {
  const activeRequest = activeRequests.get(key);
  if (activeRequest) return activeRequest as Promise<T>;

  const request = Promise.resolve().then(loadCatalog).then((payload) => {
    const entry = { expiresAt: Date.now() + ttlMs, payload };
    const writes = Promise.all([writeCache(key, entry), kv ? writeKv(kv, key, entry) : null]);
    if (waitUntil) waitUntil(writes);
    lastRefreshFailure.delete(key);
    return payload;
  }, (error: unknown) => {
    lastRefreshFailure.set(key, Date.now());
    throw error;
  }).finally(() => {
    activeRequests.delete(key);
  });
  activeRequests.set(key, request);
  return request;
}

/**
 * Returns a cached payload while it is fresh, otherwise loads it. If loading fails and an expired
 * payload is still cached, that payload is served instead, as the upstream server did.
 *
 * With `options.kv`, a miss in this data center's cache falls back to KV before Steam, and fresh
 * results are written to both. With `staleWhileRevalidate`, a stale entry is returned at once and
 * refreshed in the background.
 */
export async function getCachedCatalog<T>(key: string, loadCatalog: () => Promise<T>, ttlMs = catalogCacheTtlMs, waitUntil?: WaitUntil, options: CatalogCacheOptions = {}): Promise<T> {
  const { kv } = options;
  let cached = await readCache(key);
  if (cached && isFresh(cached)) return cached.payload as T;

  if (kv) {
    const shared = await readKv(kv, key);
    if (shared && (!cached || shared.expiresAt > cached.expiresAt)) cached = shared;
    if (cached && isFresh(cached)) {
      const copy = writeCache(key, cached);
      if (waitUntil) waitUntil(copy);
      return cached.payload as T;
    }
  }

  if (cached && options.staleWhileRevalidate && waitUntil) {
    const failedAt = lastRefreshFailure.get(key) ?? 0;
    if (!activeRequests.has(key) && Date.now() - failedAt > refreshCooldownMs) {
      waitUntil(load(key, loadCatalog, ttlMs, kv, waitUntil).catch(() => undefined));
    }
    return cached.payload as T;
  }

  try {
    return await load(key, loadCatalog, ttlMs, kv, waitUntil);
  } catch (error) {
    if (cached) return cached.payload as T;
    throw error;
  }
}
