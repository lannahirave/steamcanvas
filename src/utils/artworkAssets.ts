// Copyright (C) 2026 lannahirave
// SPDX-License-Identifier: AGPL-3.0-only
//
// Artwork placed in the preview is referenced by blob: URLs, never inlined as data: URLs. A data URL
// puts the whole file into the preview's markup as base64 text (a third larger than the file), so a
// 37 MB set of Workshop GIFs became ~104 MB of HTML (src plus the wrapping link's href) that autosave
// copied several times per save and IndexedDB then rejected as too large. A blob URL is ~60 characters
// and the bytes stay in the browser's blob storage.
//
// Drafts store each blob URL as `steamcanvas-asset:<id>` and the files themselves separately
// (App.tsx, the "assets" store), so a restored draft gets fresh blob URLs for the same files.
//
// The registry would otherwise keep every file for the life of the tab, including cancelled previews and
// replaced or deleted artwork. sweepArtwork() releases what nothing refers to any more: the preview and
// the removed-showcase archive (the roots App.tsx registers) and editor state (retainArtworkUrls).

export const ARTWORK_ASSET_SCHEME = 'steamcanvas-asset:';

type Asset = {
  id: string;
  blob: Blob;
  url: string;
  createdAt: number;
  /** Set once the URL has been seen in a root or in retained editor state. */
  seen: boolean;
  /** When a seen asset was first found unreferenced; null while something refers to it. */
  unreferencedSince: number | null;
};

const assetsByUrl = new Map<string, Asset>();
const assetsById = new Map<string, Asset>();
const retainedByOwner = new Map<string, Set<string>>();
// Owners in the middle of work (splitting, encoding, exporting) whose new URLs are not in state yet.
const busyOwners = new Set<string>();
let readRoots: (() => string[]) | null = null;
let sweepTimer: ReturnType<typeof globalThis.setTimeout> | undefined;

// A seen asset is released after staying unreferenced this long, so a URL moving from editor state into
// the preview (an Apply that is still encoding, a drag, a remove followed by restore) is never cut off.
const RELEASE_AFTER_MS = 30_000;
// An asset that was never seen anywhere is an intermediate (a decoded source, a cancelled split).
const RELEASE_UNSEEN_AFTER_MS = 5 * 60_000;

const assetIdPattern = /^[A-Za-z0-9_-]{8,64}$/;
const assetTokenPattern = /steamcanvas-asset:([A-Za-z0-9_-]{8,64})/g;
// Blob URLs are `blob:<origin>/<uuid>`; nothing in them needs escaping in HTML. `&` ends one too: in
// serialized style attributes the quotes of url("blob:...") come out as &quot;.
const blobUrlPattern = /blob:[^\s"'()<>&]+/g;
// Base64 data URLs that drafts saved before blob URLs still contain.
const inlineImagePattern = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

// crypto.randomUUID only exists on secure origins; getRandomValues also works over plain HTTP (a LAN IP).
function createAssetId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A blob URL for this image, registered so drafts can save the file and restore it later. */
export function createArtworkUrl(blob: Blob, id: string = createAssetId()): string {
  const existing = assetsById.get(id);
  if (existing) return existing.url;
  const url = URL.createObjectURL(blob);
  const asset: Asset = { id, blob, url, createdAt: Date.now(), seen: false, unreferencedSince: null };
  assetsByUrl.set(url, asset);
  assetsById.set(id, asset);
  return url;
}

export function canvasToArtworkUrl(canvas: HTMLCanvasElement, type = 'image/png'): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      // An error thrown here would escape the promise and leave the caller waiting.
      try {
        if (!blob) throw new Error('Could not prepare the image.');
        resolve(createArtworkUrl(blob));
      } catch (caught) {
        reject(caught instanceof Error ? caught : new Error('Could not prepare the image.'));
      }
    }, type);
  });
}

export function getArtworkBlob(id: string): Blob | undefined {
  return assetsById.get(id)?.blob;
}

/** True for images that live only in this tab (placed artwork), not on Steam's CDN. */
export function isLocalImageUrl(url: string): boolean {
  return /^data:image\//i.test(url) || assetsByUrl.has(url);
}

/** The image subtype ("gif", "png", "jpeg"...) of a local image URL. */
export function localImageSubtype(url: string): string {
  const type = assetsByUrl.get(url)?.blob.type || url.match(/^data:image\/([^;,]+)/i)?.[1] || '';
  return type.replace(/^image\//i, '').split('+')[0].toLowerCase() || 'png';
}

/**
 * Swaps registered blob URLs for asset tokens. Returns the files the HTML now refers to, captured now so
 * a later sweep cannot take them away before the draft is written.
 */
export function dehydrateArtworkUrls(html: string): { html: string; assets: Map<string, Blob> } {
  const assets = new Map<string, Blob>();
  const result = html.replace(blobUrlPattern, (url) => {
    const asset = assetsByUrl.get(url);
    if (!asset) return url;
    assets.set(asset.id, asset.blob);
    return `${ARTWORK_ASSET_SCHEME}${asset.id}`;
  });
  return { html: result, assets };
}

export function listArtworkAssetIds(html: string): string[] {
  return [...new Set([...html.matchAll(assetTokenPattern)].map((match) => match[1]))];
}

/**
 * Turns a saved draft's asset tokens back into blob URLs. Base64 data URLs from older drafts become
 * blob URLs too, so the next autosave stores them as files and the draft shrinks. Throws if a token's
 * file is missing: a draft restored with broken images would be autosaved over the good copy.
 */
export async function hydrateArtworkUrls(html: string, blobs: Map<string, Blob>): Promise<string> {
  const missing = listArtworkAssetIds(html).filter((id) => !blobs.has(id) || !assetIdPattern.test(id));
  if (missing.length) throw new Error(`The saved draft is missing ${missing.length} image${missing.length === 1 ? '' : 's'}.`);
  let result = html.replace(assetTokenPattern, (_token, id: string) => createArtworkUrl(blobs.get(id)!, id));
  const inline = [...new Set(result.match(inlineImagePattern) || [])];
  if (!inline.length) return result;
  const urls = new Map<string, string>();
  for (const dataUrl of inline) {
    try {
      urls.set(dataUrl, createArtworkUrl(await (await fetch(dataUrl)).blob()));
    } catch {
      // Leave an unreadable image as it was; it still displays as a data URL.
    }
  }
  result = result.replace(inlineImagePattern, (dataUrl) => urls.get(dataUrl) || dataUrl);
  return result;
}

/** Registers the markup that holds placed artwork (the preview and the removed-showcase archive). */
export function setArtworkRoots(read: (() => string[]) | null): void {
  readRoots = read;
}

/** Collects blob URLs from plain data (strings, arrays, plain objects); DOM nodes and Files are skipped. */
export function collectBlobUrls(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (value.startsWith('blob:')) into.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectBlobUrls(item, into);
  } else if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const item of Object.values(value)) collectBlobUrls(item, into);
  }
  return into;
}

/** Keeps the URLs an owner (editor state, an export in progress) still uses; replaces its previous set. */
export function retainArtworkUrls(owner: string, urls: Iterable<string>): void {
  const next = new Set(urls);
  // Seen now, not at the next sweep: a preview cancelled before that sweep must not count as unseen.
  for (const url of next) {
    const asset = assetsByUrl.get(url);
    if (asset) asset.seen = true;
  }
  if (next.size) retainedByOwner.set(owner, next);
  else retainedByOwner.delete(owner);
  scheduleArtworkSweep();
}

/** While an owner is busy no sweep runs, so URLs it is about to place are never released mid-work. */
export function setArtworkBusy(owner: string, busy: boolean): void {
  if (busy) busyOwners.add(owner);
  else if (busyOwners.delete(owner)) scheduleArtworkSweep();
}

export function scheduleArtworkSweep(delay = 2_000): void {
  globalThis.clearTimeout(sweepTimer);
  sweepTimer = globalThis.setTimeout(sweepArtwork, delay);
}

/** Revokes and forgets files nothing has referred to for a while. Returns how many were released. */
export function sweepArtwork(now = Date.now()): number {
  if (!readRoots || !assetsByUrl.size || busyOwners.size) return 0;
  const referenced = new Set<string>();
  for (const html of readRoots()) for (const url of html.match(blobUrlPattern) || []) referenced.add(url);
  for (const urls of retainedByOwner.values()) for (const url of urls) referenced.add(url);
  let released = 0;
  // Deleting the current entry while iterating a Map is safe.
  for (const asset of assetsByUrl.values()) {
    if (referenced.has(asset.url)) {
      asset.seen = true;
      asset.unreferencedSince = null;
      continue;
    }
    if (!asset.seen) {
      if (now - asset.createdAt < RELEASE_UNSEEN_AFTER_MS) continue;
    } else {
      asset.unreferencedSince ??= now;
      if (now - asset.unreferencedSince < RELEASE_AFTER_MS) continue;
    }
    URL.revokeObjectURL(asset.url);
    assetsByUrl.delete(asset.url);
    assetsById.delete(asset.id);
    released += 1;
  }
  return released;
}
