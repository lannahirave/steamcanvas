// Copyright (C) 2026 dumbapplee
// Modified by lannahirave, 2026: the Market background search from worker/index.ts, in its own
// module so scripts/seed-market-kv.ts can run it under Node and write the same KV entries.
// SPDX-License-Identifier: AGPL-3.0-only

import { getSteamJson, longRetry, retrySteamRequest, steamHost, steamImageHost, type SteamRetryOptions } from './steam';

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

export function marketCacheKey(query: string, start: number, count: number): string {
  return `market:${query.toLowerCase()}:${start}:${count}`;
}

export type MarketBackground = {
  id: string;
  name: string;
  game: string;
  price: string;
  imageUrl: string;
  steamUrl: string;
};

// Steam's item type is "<Game> Profile Background", with "Uncommon" or "Rare" before
// "Profile Background" for those rarities.
const backgroundTypeSuffix = /\s+(?:(?:uncommon|rare)\s+)?profile background$/i;

/** One request to Steam's Market search for profile backgrounds (Steam returns at most 10). */
async function searchMarketPage(params: { query: string; start: number; appid?: number }, retry: SteamRetryOptions) {
  const url = new URL('/market/search/render/', `https://${steamHost}`);
  url.searchParams.set('query', params.query);
  url.searchParams.set('start', String(params.start));
  url.searchParams.set('count', '10');
  url.searchParams.set('search_descriptions', '0');
  url.searchParams.set('sort_column', 'popular');
  url.searchParams.set('sort_dir', 'desc');
  url.searchParams.set('appid', '753');
  url.searchParams.append('category_753_item_class[]', 'tag_item_class_3');
  if (params.appid !== undefined) url.searchParams.append('category_753_Game[]', `tag_app_${params.appid}`);
  url.searchParams.set('norender', '1');

  // No User-Agent here: from a Worker, the Market answered 429 to every browser User-Agent
  // tried and 200 without one. Profile pages behave the other way round (see steam.ts).
  const data = await retrySteamRequest(() => getSteamJson<SteamMarketResponse>(url.href, {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    Referer: 'https://steamcommunity.com/market/',
    'X-Requested-With': 'XMLHttpRequest',
  }), retry);
  if (!data.success || !Array.isArray(data.results)) throw new Error('Steam returned an invalid background catalog.');
  return { items: toBackgrounds(data.results), totalCount: data.total_count || 0 };
}

function toBackgrounds(results: SteamMarketItem[]): MarketBackground[] {
  return results.flatMap((item) => {
    const description = item.asset_description;
    const hashName = item.hash_name || description?.market_hash_name;
    const iconUrl = description?.icon_url;
    if (!description?.type?.toLowerCase().includes('profile background') || !hashName || !iconUrl || !/^[\w-]+$/.test(iconUrl)) return [];

    return [{
      id: hashName,
      name: description.market_name || item.name || hashName,
      game: description.type.replace(backgroundTypeSuffix, ''),
      price: item.sell_price_text || '',
      imageUrl: `https://${steamImageHost}/economy/image/${iconUrl}`,
      steamUrl: new URL(`/market/listings/753/${encodeURIComponent(hashName)}`, `https://${steamHost}`).href,
    }];
  });
}

function unique(items: MarketBackground[]): MarketBackground[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

/** A picker page: `count` backgrounds from `start` in Steam's popular order, in 10-item requests. */
export async function loadMarketBackgrounds(query: string, start: number, count: number, retry: SteamRetryOptions = longRetry) {
  const pages = [];
  for (let index = 0; index < Math.ceil(count / 10); index++) {
    pages.push(await searchMarketPage({ query, start: start + index * 10 }, retry));
  }
  return { items: unique(pages.flatMap((page) => page.items)), totalCount: pages[0].totalCount, pageSize: count };
}

/** Every listed profile background of one game (category_753_Game filter), usually one request. */
export async function loadGameBackgrounds(appid: number, retry: SteamRetryOptions = longRetry): Promise<MarketBackground[]> {
  const items: MarketBackground[] = [];
  for (let start = 0; ; start += 10) {
    const page = await searchMarketPage({ query: '', start, appid }, retry);
    items.push(...page.items);
    if (page.items.length === 0 || start + 10 >= page.totalCount) break;
  }
  return unique(items);
}

export type SteamAppFilters = { success?: boolean; facets?: Record<string, { tags?: Record<string, { localized_name?: string; matches?: string }> }> };

/** Every game with Market items for app 753, with Steam's item count for each. One request. */
export async function loadMarketGames(retry: SteamRetryOptions = longRetry): Promise<Map<number, { name: string; matches: number }>> {
  const data = await retrySteamRequest(() => getSteamJson<SteamAppFilters>(`https://${steamHost}/market/appfilters/753`), retry);
  const tags = data.facets?.['753_Game']?.tags;
  if (!data.success || !tags) throw new Error('Steam returned an invalid Market game list.');
  const games = new Map<number, { name: string; matches: number }>();
  for (const [tag, info] of Object.entries(tags)) {
    const appid = Number(tag.replace(/^app_/, ''));
    if (!Number.isInteger(appid) || appid <= 0) continue;
    games.set(appid, { name: info.localized_name || String(appid), matches: Number((info.matches || '0').replace(/,/g, '')) || 0 });
  }
  return games;
}
