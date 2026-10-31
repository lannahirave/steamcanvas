// Copyright (C) 2026 dumbapplee
// Modified by lannahirave, 2026: Cloudflare Worker port of the Steam helpers in server/index.ts.
// SPDX-License-Identifier: AGPL-3.0-only

export const steamHost = 'steamcommunity.com';
export const steamImageHost = 'community.cloudflare.steamstatic.com';
// Steam treats Worker requests differently from Node ones. In testing from workerd (October 2026):
// - profile pages answered 429 to upstream's short User-Agent without Accept-Language, and 200 to a
//   complete browser-like set of headers;
// - /sharedfiles/ pages answered 429 to any browser User-Agent, and 200 with no User-Agent at all.
// Production runs from Cloudflare's IPs, which may be treated differently again.
export const browserUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const acceptLanguage = 'en-US,en;q=0.9';

/** A non-2xx response from Steam. Mirrors the parts of AxiosError the upstream server relied on. */
export class SteamHttpError extends Error {
  constructor(readonly status: number, readonly retryAfter: string | null) {
    super(`Steam responded with HTTP ${status}.`);
  }
}

/** Steam did not answer within the request timeout. */
export class SteamTimeoutError extends Error {
  constructor() {
    super('Steam took too long to respond.');
  }
}

/** The request never reached Steam or the connection dropped. */
export class SteamNetworkError extends Error {}

export class InvalidSteamPointShopResponseError extends Error {}

const steamRequestIntervalMs = 700;
const steamRequestTimeoutMs = 15000;
let steamRequestQueue: Promise<void> = Promise.resolve();
let nextSteamRequestAt = 0;

// Spaces out requests made by this Worker instance. Instances do not share this queue, so it only
// smooths bursts from one instance; Steam's own rate limits are still handled by the retries below.
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

async function steamFetch(url: string, headers: Record<string, string>): Promise<Response> {
  await waitForSteamRequestSlot();
  let response: Response;
  try {
    response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(steamRequestTimeoutMs) });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new SteamTimeoutError();
    throw new SteamNetworkError(error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    // Drain the body so the connection can be reused.
    await response.body?.cancel();
    throw new SteamHttpError(response.status, response.headers.get('retry-after'));
  }
  return response;
}

export async function getSteamJson<T>(url: string, headers: Record<string, string> = { Accept: 'application/json' }): Promise<T> {
  const response = await steamFetch(url, { 'Accept-Language': acceptLanguage, ...headers });
  return await response.json() as T;
}

export async function getSteamHtml(url: string): Promise<{ data: string; responseUrl: string }> {
  const sendUserAgent = !new URL(url).pathname.startsWith('/sharedfiles/');
  const response = await steamFetch(url, {
    ...(sendUserAgent ? { 'User-Agent': browserUserAgent } : {}),
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': acceptLanguage,
  });
  return { data: await response.text(), responseUrl: response.url || url };
}

export type SteamRetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxBackoffMs?: number;
  maxRetryAfterMs?: number;
  isRetryable?: (error: unknown) => boolean;
};

// Shorter than upstream's defaults (up to 6 attempts and 30-60 s waits): a Worker request should
// finish well inside a browser's patience and Cloudflare's limits.
export const longRetry: SteamRetryOptions = { maxAttempts: 4, baseDelayMs: 1500, maxBackoffMs: 8000, maxRetryAfterMs: 10000 };

function retryDelayMs(error: unknown, attempt: number, options: SteamRetryOptions): number {
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 8000;
  if (error instanceof SteamHttpError && error.retryAfter) {
    const retryAfterSeconds = Number(error.retryAfter);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) return Math.min(maxRetryAfterMs, retryAfterSeconds * 1000);
    const retryAt = Date.parse(error.retryAfter);
    if (Number.isFinite(retryAt)) return Math.min(maxRetryAfterMs, Math.max(500, retryAt - Date.now()));
  }
  return Math.min(options.maxBackoffMs ?? 6000, (options.baseDelayMs ?? 750) * 2 ** attempt);
}

export async function retrySteamRequest<T>(request: () => Promise<T>, options: SteamRetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      const status = error instanceof SteamHttpError ? error.status : undefined;
      const transient = error instanceof SteamNetworkError || error instanceof SteamTimeoutError;
      const retryable = options.isRetryable?.(error) === true || transient || status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500);
      if (!retryable || attempt === maxAttempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(error, attempt, options)));
    }
  }
  throw new Error('Steam request failed after retries.');
}

export function getSteamHtmlWithRetry(url: string, options: SteamRetryOptions = {}) {
  return retrySteamRequest(() => getSteamHtml(url), options);
}

export function steamErrorStatus(error: unknown): 429 | 504 | 502 {
  if (error instanceof SteamHttpError && error.status === 429) return 429;
  if (error instanceof SteamTimeoutError) return 504;
  return 502;
}

// Minimal protobuf encoding for the Points Shop queries (upstream used Node's Buffer).
function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value);
  return bytes;
}

function encodeNumberField(field: number, value: number): number[] {
  return [...encodeVarint(field << 3), ...encodeVarint(value)];
}

function encodeStringField(field: number, value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [...encodeVarint((field << 3) | 2), ...encodeVarint(bytes.length), ...bytes];
}

function toBase64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

export function makePointsShopQuery(cursor?: string, communityItemClass = 3, pageSize = 20): string {
  const query = [
    ...encodeNumberField(3, communityItemClass),
    ...encodeStringField(4, 'english'),
    ...encodeNumberField(5, pageSize),
    ...(cursor ? encodeStringField(6, cursor) : []),
    ...encodeNumberField(7, 2),
    ...encodeNumberField(8, 0),
    ...encodeNumberField(9, 1),
    ...(communityItemClass === 3 ? encodeNumberField(12, 1) : communityItemClass === 8 ? encodeNumberField(12, 3) : []),
    ...encodeNumberField(17, 3),
    ...encodeNumberField(17, 4),
  ];
  return toBase64([...encodeVarint(10), ...encodeVarint(query.length), ...query]);
}

export function makeRewardDefinitionsQuery(defids: number[]): string {
  const query = [
    ...encodeStringField(4, 'english'),
    ...defids.flatMap((defid) => encodeNumberField(11, defid)),
    ...encodeNumberField(16, 1),
  ];
  return toBase64([...encodeVarint(10), ...encodeVarint(query.length), ...query]);
}

export function pointsShopUrl(encodedQuery: string): string {
  const apiUrl = new URL('/ILoyaltyRewardsService/BatchedQueryRewardItems/v1', 'https://api.steampowered.com');
  apiUrl.searchParams.set('origin', 'https://store.steampowered.com');
  apiUrl.searchParams.set('input_protobuf_encoded', encodedQuery);
  apiUrl.searchParams.set('format', 'json');
  return apiUrl.href;
}
