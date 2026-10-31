// Copyright (C) 2026 dumbapplee
// Modified by lannahirave, 2026: the upstream in-memory cache, moved to the Cloudflare Cache API.
// SPDX-License-Identifier: AGPL-3.0-only

export const catalogCacheTtlMs = 3 * 60 * 60 * 1000;
export const profileCacheTtlMs = 10 * 60 * 1000;

// How long a stale entry is kept so it can be served when Steam is rate-limiting or down.
const staleKeepMs = 24 * 60 * 60 * 1000;
const cacheOrigin = 'https://steamcanvas-cache.internal';

type CachedEntry = { expiresAt: number; payload: unknown };

// Joins identical requests that run at the same time in this Worker instance.
const activeRequests = new Map<string, Promise<unknown>>();

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
    await caches.default.put(cacheRequest(key), new Response(JSON.stringify(entry), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${maxAge}` },
    }));
  } catch {
    // The Cache API is unavailable on workers.dev and in some local setups; caching is best effort.
  }
}

/**
 * Returns a cached payload while it is fresh, otherwise loads it. If loading fails and an expired
 * payload is still cached, that payload is served instead, as the upstream server did.
 */
export async function getCachedCatalog<T>(key: string, loadCatalog: () => Promise<T>, ttlMs = catalogCacheTtlMs, waitUntil?: (promise: Promise<unknown>) => void): Promise<T> {
  const cached = await readCache(key);
  if (cached && cached.expiresAt > Date.now()) return cached.payload as T;

  const activeRequest = activeRequests.get(key);
  if (activeRequest) return activeRequest as Promise<T>;

  const request = Promise.resolve().then(loadCatalog).then((payload) => {
    const write = writeCache(key, { expiresAt: Date.now() + ttlMs, payload });
    if (waitUntil) waitUntil(write);
    return payload;
  }).catch((error) => {
    if (cached) return cached.payload as T;
    throw error;
  }).finally(() => {
    activeRequests.delete(key);
  });
  activeRequests.set(key, request);
  return request;
}
