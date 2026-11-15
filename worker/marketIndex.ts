// Copyright (C) 2026 lannahirave
// SPDX-License-Identifier: AGPL-3.0-only
//
// The cached Market background catalog that the picker searches without asking Steam. One gzipped
// JSON value in CATALOG_KV, built and updated by scripts/market-index.ts from a home connection,
// served as-is by GET /api/market-index, and searched in the browser (src/utils/marketIndex.ts).
// No imports and no Worker globals: the client and Node scripts load this file too.

export const marketIndexKey = 'market-index:v1';

/** [market hash name, display name, app ID, icon ID, price text]. */
export type MarketIndexItem = [hashName: string, name: string, appid: number, iconId: string, price: string];

export type MarketIndex = {
  version: 1;
  /** When the index was last written (ms). */
  updatedAt: number;
  /** App ID to game name, from Steam's Market game list. */
  games: Record<string, string>;
  /**
   * App ID to Steam's item count for that game when its backgrounds were last fetched. A game whose
   * count differs in a newer game list may have new backgrounds; scripts/market-index.ts uses this
   * to fetch only those games.
   */
  snapshot: Record<string, number>;
  /** In Steam's popular order as first crawled; backgrounds found later are appended. */
  items: MarketIndexItem[];
};

export const marketImageBaseUrl = 'https://community.cloudflare.steamstatic.com/economy/image/';

export function marketListingUrl(hashName: string): string {
  return `https://steamcommunity.com/market/listings/753/${encodeURIComponent(hashName)}`;
}

/** Background hash names start with the game's app ID, as in "268910-Solo Cup". */
export function appIdOf(hashName: string): number | null {
  const match = /^(\d+)-/.exec(hashName);
  return match ? Number(match[1]) : null;
}
