// Copyright (C) 2026 dumbapplee
// Modified by lannahirave, 2026: Cloudflare Worker port of server/index.ts. Express became plain
// fetch handlers, axios became fetch, the in-memory cache became the Cache API, and the optional
// PostgreSQL catalog index and profile metric were dropped.
// SPDX-License-Identifier: AGPL-3.0-only

import { load } from 'cheerio/slim';
import { catalogCacheTtlMs, getCachedCatalog, profileCacheTtlMs } from './cache';
import {
  extractFullScreenshotUrl,
  extractPublicScreenshots,
  makeInertDocument,
  resolveProfileUrl,
  type PublicScreenshot,
} from './profile';
import {
  getSteamHtml,
  getSteamHtmlWithRetry,
  getSteamJson,
  longRetry,
  makePointsShopQuery,
  makeRewardDefinitionsQuery,
  pointsShopUrl,
  retrySteamRequest,
  SteamHttpError,
  steamErrorStatus,
  steamHost,
  steamImageHost,
  SteamTimeoutError,
} from './steam';

interface Env {
  ASSETS: Fetcher;
  /** Origin of Steam Artwork Studio, whose /bridge page SteamCanvas embeds for handoffs. */
  ARTWORK_STUDIO_ORIGIN?: string;
  /** "true" on the beta deployment, so search engines skip it. */
  ROBOTS_NOINDEX?: string;
}

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

type WaitUntil = (promise: Promise<unknown>) => void;

const maxJsonBodyBytes = 4 * 1024;

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

const catalogCacheHeaders = { 'Cache-Control': `public, max-age=${catalogCacheTtlMs / 1000}` };

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxJsonBodyBytes) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function isValidCursor(cursor: string): boolean {
  return !cursor || (cursor.length <= 128 && /^[A-Za-z0-9+/]+={0,2}$/.test(cursor));
}

async function handleBackgrounds(url: URL, waitUntil: WaitUntil): Promise<Response> {
  const query = (url.searchParams.get('query') || '').trim().slice(0, 80);
  const start = Number(url.searchParams.get('start') ?? 0);
  const count = Number(url.searchParams.get('count') ?? 30);
  if (!Number.isInteger(start) || start < 0 || start > 100000 || !Number.isInteger(count) || count < 1 || count > 30) {
    return json({ error: 'Invalid background search page.' }, 400);
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

      const pages: SteamMarketResponse[] = [];
      for (let index = 0; index < Math.ceil(count / 10); index++) {
        const pageUrl = new URL(marketUrl);
        pageUrl.searchParams.set('start', String(start + index * 10));
        // No User-Agent here: from a Worker, the Market answered 429 to every browser User-Agent
        // tried and 200 without one. Profile pages behave the other way round (see steam.ts).
        pages.push(await retrySteamRequest(() => getSteamJson<SteamMarketResponse>(pageUrl.href, {
          Accept: 'application/json, text/javascript, */*; q=0.01',
          Referer: 'https://steamcommunity.com/market/',
          'X-Requested-With': 'XMLHttpRequest',
        }), longRetry));
      }
      if (pages.some((data) => !data.success || !Array.isArray(data.results))) throw new Error('Steam returned an invalid background catalog.');

      const items = pages.flatMap((data) => data.results || []).flatMap((item) => {
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

      return { items: uniqueItems, totalCount: pages[0].total_count || 0, pageSize: count };
    }, catalogCacheTtlMs, waitUntil);
    return json(payload, 200, catalogCacheHeaders);
  } catch (error) {
    if (error instanceof SteamHttpError && error.status === 429) {
      return json({ error: 'Steam is temporarily limiting Market requests. Please try again later.' }, 503);
    }
    return json({ error: 'Steam could not load profile backgrounds right now.' }, 502);
  }
}

function findFirstPointShopResponse(data: SteamPointShopResponse) {
  return data.response?.responses?.find((entry) => entry.eresult === 1)?.response;
}

async function handlePointsBackgrounds(url: URL, waitUntil: WaitUntil): Promise<Response> {
  const cursor = url.searchParams.get('cursor') || '';
  if (!isValidCursor(cursor)) return json({ error: 'Invalid Points Shop page cursor.' }, 400);

  try {
    const payload = await getCachedCatalog(`points-v3:${cursor || 'first'}`, async () => {
      const data = await getSteamJson<SteamPointShopResponse>(pointsShopUrl(makePointsShopQuery(cursor || undefined)));
      const pointShopResponse = findFirstPointShopResponse(data);
      if (!pointShopResponse || !Array.isArray(pointShopResponse.definitions)) throw new Error('Steam returned an invalid Points Shop catalog.');

      const items = pointShopResponse.definitions.flatMap((definition) => {
        const itemData = definition.community_item_data;
        const appid = definition.appid;
        const image = itemData?.item_image_large;
        if (!definition.active || definition.community_item_class !== 3 || !itemData?.animated || !appid || !definition.defid || !image) return [];

        const assetBase = `https://shared.fastly.steamstatic.com/community_assets/images/items/${appid}/`;
        return [{
          id: `points:${appid}:${definition.defid}`,
          name: itemData.item_title || itemData.item_name || 'Animated profile background',
          game: String(appid),
          price: '',
          imageUrl: `https://community.fastly.steamstatic.com/economy/profilebackground/items/${appid}/${image}?size=320x200`,
          videoPoster: `${assetBase}${image}`,
          steamUrl: `https://store.steampowered.com/points/shop/app/${appid}`,
          animated: true,
          videoWebm: itemData.item_movie_webm ? `${assetBase}${itemData.item_movie_webm}` : undefined,
          videoMp4: itemData.item_movie_mp4 ? `${assetBase}${itemData.item_movie_mp4}` : undefined,
        }];
      });

      return {
        items,
        totalCount: pointShopResponse.total_count || items.length,
        pageSize: 20,
        nextCursor: pointShopResponse.next_cursor || null,
      };
    }, catalogCacheTtlMs, waitUntil);
    return json(payload, 200, catalogCacheHeaders);
  } catch {
    return json({ error: 'Steam could not load animated Points Shop backgrounds right now.' }, 502);
  }
}

async function handleAvatarFrames(url: URL, waitUntil: WaitUntil): Promise<Response> {
  const cursor = url.searchParams.get('cursor') || '';
  if (!isValidCursor(cursor)) return json({ error: 'Invalid avatar frame page cursor.' }, 400);

  try {
    const payload = await getCachedCatalog(`frames-v3:${cursor || 'first'}`, async () => {
      const data = await getSteamJson<SteamPointShopResponse>(pointsShopUrl(makePointsShopQuery(cursor || undefined, 14)));
      const pointShopResponse = findFirstPointShopResponse(data);
      if (!pointShopResponse || !Array.isArray(pointShopResponse.definitions)) throw new Error('Steam returned an invalid avatar frame catalog.');

      const items = pointShopResponse.definitions.flatMap((definition) => {
        const itemData = definition.community_item_data;
        const appid = definition.appid;
        const image = itemData?.item_image_large;
        if (!definition.active || definition.community_item_class !== 14 || !appid || !definition.defid || !image) return [];

        const assetBase = `https://shared.fastly.steamstatic.com/community_assets/images/items/${appid}/`;
        return [{
          id: `frame:${appid}:${definition.defid}`,
          name: itemData.item_title || itemData.item_name || 'Avatar frame',
          game: String(appid),
          imageUrl: `${assetBase}${image}`,
          thumbnailUrl: `${assetBase}${itemData.item_image_small || image}`,
          steamUrl: `https://store.steampowered.com/points/shop/app/${appid}`,
          animatedImageUrl: itemData.animated && itemData.item_image_small ? `${assetBase}${itemData.item_image_small}` : undefined,
          animated: Boolean(itemData.animated),
        }];
      });

      return {
        items,
        totalCount: pointShopResponse.total_count || items.length,
        pageSize: 20,
        nextCursor: pointShopResponse.next_cursor || null,
      };
    }, catalogCacheTtlMs, waitUntil);
    return json(payload, 200, catalogCacheHeaders);
  } catch {
    return json({ error: 'Steam could not load avatar frames right now.' }, 502);
  }
}

async function handleProfileThemes(url: URL, waitUntil: WaitUntil): Promise<Response> {
  const cursor = url.searchParams.get('cursor') || '';
  if (!isValidCursor(cursor)) return json({ error: 'Invalid profile theme page cursor.' }, 400);

  try {
    const payload = await getCachedCatalog(`profile-themes-v5:${cursor || 'first'}`, async () => {
      const data = await getSteamJson<SteamPointShopResponse>(pointsShopUrl(makePointsShopQuery(cursor || undefined, 8)));
      const pointShopResponse = data.response?.responses
        ?.filter((entry) => entry.eresult === 1 && Array.isArray(entry.response?.definitions))
        .map((entry) => entry.response!)
        .sort((left, right) => (right.definitions?.length || 0) - (left.definitions?.length || 0))[0];
      if (!pointShopResponse || !Array.isArray(pointShopResponse.definitions)) throw new Error('Steam returned an invalid profile theme catalog.');

      const items = pointShopResponse.definitions.flatMap((definition) => {
        const itemData = definition.community_item_data;
        const appid = definition.appid;
        const image = itemData?.item_image_large;
        if (!definition.active || definition.community_item_class !== 8 || !itemData?.profile_theme_id || !appid || !definition.defid || !image || !definition.bundle_defids?.length) return [];

        const assetBase = `https://shared.fastly.steamstatic.com/community_assets/images/items/${appid}/`;
        return [{
          id: `theme:${appid}:${definition.defid}`,
          name: itemData.item_title || itemData.item_name || 'Profile theme',
          game: String(appid),
          appid,
          communityItemType: definition.community_item_type,
          profileThemeId: itemData.profile_theme_id,
          bundleDefids: definition.bundle_defids,
          imageUrl: `${assetBase}${image}`,
          thumbnailUrl: `${assetBase}${itemData.item_image_small || image}`,
          steamUrl: `https://store.steampowered.com/points/shop/app/${appid}`,
        }];
      });

      return {
        items,
        totalCount: pointShopResponse.total_count || items.length,
        pageSize: 20,
        nextCursor: pointShopResponse.next_cursor || null,
      };
    }, catalogCacheTtlMs, waitUntil);
    return json(payload, 200, catalogCacheHeaders);
  } catch {
    return json({ error: 'Steam could not load profile themes right now.' }, 502);
  }
}

async function handleProfileThemeStyle(url: URL, waitUntil: WaitUntil): Promise<Response> {
  const appid = Number(url.searchParams.get('appid'));
  const itemType = Number(url.searchParams.get('itemtype'));
  if (!Number.isSafeInteger(appid) || appid < 1 || appid > 0xffffffff || !Number.isSafeInteger(itemType) || itemType < 1 || itemType > 0xffffffff) {
    return json({ error: 'Invalid profile theme preview identifiers.' }, 400);
  }

  const previewUrl = new URL('/profiles/76561197960266962', `https://${steamHost}`);
  previewUrl.searchParams.set('previewprofile', '1');
  previewUrl.searchParams.set('appid', String(appid));
  previewUrl.searchParams.set('itemtype', String(itemType));

  try {
    const payload = await getCachedCatalog(`profile-theme-style:${appid}:${itemType}`, async () => {
      const result = await getSteamHtml(previewUrl.href);
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
    }, catalogCacheTtlMs, waitUntil);
    return json(payload, 200, catalogCacheHeaders);
  } catch {
    return json({ error: 'Steam could not load the selected profile theme right now.' }, 502);
  }
}

async function handleProfileThemeItems(url: URL, waitUntil: WaitUntil): Promise<Response> {
  const rawDefids = url.searchParams.get('defids') || '';
  const defids = rawDefids.split(',').map((value) => Number(value));
  if (!rawDefids || defids.length < 1 || defids.length > 8 || defids.some((defid) => !Number.isInteger(defid) || defid < 1 || defid > 0xffffffff)) {
    return json({ error: 'Invalid profile theme bundle item IDs.' }, 400);
  }

  const uniqueDefids = [...new Set(defids)];
  const cacheKey = `profile-theme-items:${uniqueDefids.slice().sort((a, b) => a - b).join(',')}`;
  try {
    const payload = await getCachedCatalog(cacheKey, async () => {
      const data = await getSteamJson<SteamPointShopResponse>(pointsShopUrl(makeRewardDefinitionsQuery(uniqueDefids)));
      const definitions = data.response?.responses?.flatMap((entry) => entry.eresult === 1 ? entry.response?.definitions || [] : []) || [];
      if (definitions.length !== uniqueDefids.length) throw new Error('Steam returned an incomplete profile theme bundle.');
      return { items: definitions };
    }, catalogCacheTtlMs, waitUntil);
    return json(payload, 200, catalogCacheHeaders);
  } catch {
    return json({ error: 'Steam could not load the profile theme bundle right now.' }, 502);
  }
}

async function handleProfile(request: Request, waitUntil: WaitUntil): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return json({ error: 'Request body is too large.' }, 413);
  let profileUrl: URL;
  try {
    profileUrl = resolveProfileUrl(body.identifier);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Invalid profile address.' }, 400);
  }

  try {
    const profile = await getCachedCatalog(`profile:${profileUrl.href}`, async () => {
      const result = await getSteamHtmlWithRetry(profileUrl.href, longRetry);
      return { ...makeInertDocument(result.data, result.responseUrl), url: result.responseUrl };
    }, profileCacheTtlMs, waitUntil);
    return json(profile, 200, { 'Cache-Control': 'no-store' });
  } catch (error) {
    console.error('Profile request failed:', profileUrl.href, error instanceof Error ? error.message : error);
    if (error instanceof SteamHttpError && error.status === 404) return json({ error: 'Steam could not find that profile.' }, 404);
    if (error instanceof SteamTimeoutError) return json({ error: 'Steam took too long to respond. Try again in a moment.' }, 504);
    return json({ error: 'Steam did not return a usable public profile. It may be private or temporarily unavailable.' }, 502);
  }
}

async function handleProfileScreenshots(request: Request, waitUntil: WaitUntil): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return json({ error: 'Request body is too large.' }, 413);
  let profileUrl: URL;
  try {
    profileUrl = resolveProfileUrl(body.profileUrl);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'Invalid profile address.' }, 400);
  }

  const screenshotsUrl = new URL(profileUrl);
  screenshotsUrl.pathname = `${screenshotsUrl.pathname.replace(/\/$/, '')}/screenshots/`;
  const requestedPage = Math.max(1, Math.min(10000, Number(body.page) || 1));
  const pageBatchSize = 6;
  try {
    const catalog = await getCachedCatalog(`profile-screenshots:${screenshotsUrl.href}:page-${requestedPage}`, async () => {
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
    }, catalogCacheTtlMs, waitUntil);
    return json(catalog, 200, catalogCacheHeaders);
  } catch (error) {
    const status = steamErrorStatus(error);
    return json({ error: status === 429 ? 'Steam is rate limiting screenshot requests. Wait a moment and try again.' : status === 504 ? 'Steam took too long to load the screenshot gallery.' : 'Steam could not load this public screenshot gallery right now.' }, status);
  }
}

async function handleScreenshotImage(request: Request, waitUntil: WaitUntil): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) return json({ error: 'Request body is too large.' }, 413);
  try {
    const screenshotUrl = new URL(String(body.steamUrl || ''));
    if (screenshotUrl.hostname !== steamHost && screenshotUrl.hostname !== `www.${steamHost}` || screenshotUrl.pathname !== '/sharedfiles/filedetails/') {
      throw new Error('Invalid screenshot URL.');
    }
    const imageUrl = await getCachedCatalog(`screenshot-image:${screenshotUrl.href}`, async () => {
      const result = await getSteamHtmlWithRetry(screenshotUrl.href);
      return extractFullScreenshotUrl(result.data, result.responseUrl);
    }, catalogCacheTtlMs, waitUntil);
    if (!imageUrl) throw new Error('Steam did not expose a full-resolution screenshot.');
    return json({ imageUrl });
  } catch (error) {
    const status = steamErrorStatus(error);
    return json({ error: status === 429 ? 'Steam is rate limiting full-resolution requests. Wait a moment and try again.' : status === 504 ? 'Steam took too long to load the full-resolution screenshot.' : 'Steam could not load the full-resolution screenshot right now.' }, status);
  }
}

async function handleApi(request: Request, url: URL, waitUntil: WaitUntil): Promise<Response> {
  const route = `${request.method} ${url.pathname}`;
  switch (route) {
    case 'GET /api/catalog-status':
      return json({ configured: false, error: 'The catalog index is not available in this deployment.' }, 503);
    case 'GET /api/profile-metrics':
      return json({ error: 'Profile metrics are not available in this deployment.' }, 503);
    case 'GET /api/backgrounds':
      return handleBackgrounds(url, waitUntil);
    case 'GET /api/points-backgrounds':
      return handlePointsBackgrounds(url, waitUntil);
    case 'GET /api/avatar-frames':
      return handleAvatarFrames(url, waitUntil);
    case 'GET /api/profile-themes':
      return handleProfileThemes(url, waitUntil);
    case 'GET /api/profile-theme-style':
      return handleProfileThemeStyle(url, waitUntil);
    case 'GET /api/profile-theme-items':
      return handleProfileThemeItems(url, waitUntil);
    case 'POST /api/profile':
      return handleProfile(request, waitUntil);
    case 'POST /api/profile-screenshots':
      return handleProfileScreenshots(request, waitUntil);
    case 'POST /api/screenshot-image':
      return handleScreenshotImage(request, waitUntil);
    default:
      return json({ error: 'Not found.' }, 404);
  }
}

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

const betaRobotsTxt = `# SteamCanvas beta (pre-release copy). Not for search engines.
# The public site is https://previewartwork.lannahirave.com
User-agent: *
Disallow: /
`;

async function handleGuide(request: Request, url: URL, env: Env): Promise<Response | null> {
  const slug = url.pathname.match(/^\/guides\/([^/]+)\/?$/)?.[1];
  const metadata = slug ? guidePageMetadata[slug] : undefined;
  if (!metadata) return null;
  const index = await env.ASSETS.fetch(new Request(new URL('/', url), request));
  if (!index.ok) return index;
  const html = (await index.text())
    .replace(/<title>[^<]*<\/title>/, `<title>${metadata.title}</title>`)
    .replace(/(<meta (?:name|property)="(?:og:|twitter:)?description" content=")[^"]*("\s*\/?>)/g, `$1${metadata.description}$2`)
    .replace(/(<meta (?:name|property)="(?:og|twitter):title" content=")[^"]*("\s*\/?>)/g, `$1${metadata.title}$2`);
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// The profile preview iframe uses srcdoc, so it inherits this policy. Steam's own CSS, fonts,
// images and background videos must therefore be allowed, and base-uri must allow the
// <base href="https://steamcommunity.com/"> the server adds to the preview.
function contentSecurityPolicy(env: Env): string {
  const steamAssets = 'https://*.steamstatic.com https://steamcommunity.com https://*.steamusercontent.com https://*.akamaihd.net';
  const studioOrigin = env.ARTWORK_STUDIO_ORIGIN || 'https://artworkstudio.lannahirave.com';
  return [
    "default-src 'self'",
    "script-src 'self'",
    `style-src 'self' 'unsafe-inline' ${steamAssets} https://fonts.googleapis.com`,
    `img-src 'self' data: blob: ${steamAssets}`,
    `media-src 'self' data: blob: ${steamAssets}`,
    `font-src 'self' data: ${steamAssets} https://fonts.gstatic.com`,
    `connect-src 'self' data: blob: ${steamAssets}`,
    `frame-src ${studioOrigin}`,
    "object-src 'none'",
    "base-uri 'self' https://steamcommunity.com",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function withSecurityHeaders(response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  headers.set('Content-Security-Policy', contentSecurityPolicy(env));
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (env.ROBOTS_NOINDEX === 'true') headers.set('X-Robots-Tag', 'noindex, nofollow');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const waitUntil: WaitUntil = (promise) => context.waitUntil(promise);
    let response: Response;
    if (url.pathname === '/robots.txt' && env.ROBOTS_NOINDEX === 'true') {
      // Beta and other non-production copies: keep crawlers out entirely.
      response = new Response(betaRobotsTxt, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    } else if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      response = await handleApi(request, url, waitUntil);
    } else {
      response = await handleGuide(request, url, env) ?? await env.ASSETS.fetch(request);
    }
    return withSecurityHeaders(response, env);
  },
} satisfies ExportedHandler<Env>;
