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

export async function loadMarketBackgrounds(query: string, start: number, count: number, retry: SteamRetryOptions = longRetry) {
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
    }), retry));
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
}
