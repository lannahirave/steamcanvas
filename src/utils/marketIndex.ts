// Copyright (C) 2026 lannahirave
// SPDX-License-Identifier: AGPL-3.0-only
//
// Searches the cached Market background catalog (worker/marketIndex.ts) in the browser, so finding
// a background does not depend on Steam answering. The index is downloaded once per page load, on
// the first cached search, and the browser may keep it for an hour.

import { marketImageBaseUrl, marketListingUrl, type MarketIndex, type MarketIndexItem } from '../../worker/marketIndex';
import type { SteamBackground } from '../components/BackgroundPicker';

export type LoadedMarketIndex = {
  updatedAt: number;
  games: Record<string, string>;
  items: MarketIndexItem[];
  /** Lowercase, accent-free "name game" text for each item, in the same order. */
  searchText: string[];
};

let loading: Promise<LoadedMarketIndex> | null = null;
let lastSearch: { index: LoadedMarketIndex; query: string; matches: number[] } | null = null;

function normalize(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

export function loadMarketIndex(): Promise<LoadedMarketIndex> {
  loading ??= fetch('/api/market-index')
    .then(async (response) => {
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || 'The cached catalog could not be loaded.');
      }
      const index = await response.json() as MarketIndex;
      return {
        updatedAt: index.updatedAt,
        games: index.games,
        items: index.items,
        searchText: index.items.map(([, name, appid]) => normalize(`${name} ${index.games[appid] ?? ''}`)),
      };
    })
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}

/** Every word of the query must appear in the background's name or game. An empty query lists all. */
export function searchMarketIndex(index: LoadedMarketIndex, query: string, start: number, count: number): { items: SteamBackground[]; totalCount: number } {
  const normalized = normalize(query.trim());
  if (lastSearch?.index !== index || lastSearch.query !== normalized) {
    const words = normalized.split(/\s+/).filter(Boolean);
    const matches: number[] = [];
    for (let position = 0; position < index.items.length; position++) {
      const text = index.searchText[position];
      if (words.every((word) => text.includes(word))) matches.push(position);
    }
    lastSearch = { index, query: normalized, matches };
  }

  const items = lastSearch.matches.slice(start, start + count).map((position) => {
    const [hashName, name, appid, iconId, price] = index.items[position];
    return {
      id: hashName,
      name,
      game: index.games[appid] ?? '',
      price,
      imageUrl: `${marketImageBaseUrl}${iconId}`,
      steamUrl: marketListingUrl(hashName),
    };
  });
  return { items, totalCount: lastSearch.matches.length };
}
