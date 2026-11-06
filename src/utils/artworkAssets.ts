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

export const ARTWORK_ASSET_SCHEME = 'steamcanvas-asset:';

type Asset = { id: string; blob: Blob; url: string };

const assetsByUrl = new Map<string, Asset>();
const assetsById = new Map<string, Asset>();

const assetIdPattern = /^[A-Za-z0-9_-]{8,64}$/;
const assetTokenPattern = /steamcanvas-asset:([A-Za-z0-9_-]{8,64})/g;
// Blob URLs are `blob:<origin>/<uuid>`; nothing in them needs escaping in HTML.
const blobUrlPattern = /blob:[^\s"'()<>]+/g;
// Base64 data URLs that drafts saved before blob URLs still contain.
const inlineImagePattern = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;

function createAssetId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/** A blob URL for this image, registered so drafts can save the file and restore it later. */
export function createArtworkUrl(blob: Blob, id: string = createAssetId()): string {
  const existing = assetsById.get(id);
  if (existing) return existing.url;
  const url = URL.createObjectURL(blob);
  const asset = { id, blob, url };
  assetsByUrl.set(url, asset);
  assetsById.set(id, asset);
  return url;
}

export function canvasToArtworkUrl(canvas: HTMLCanvasElement, type = 'image/png'): Promise<string> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(createArtworkUrl(blob)) : reject(new Error('Could not prepare the image.')), type);
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

/** Swaps registered blob URLs for asset tokens; returns the ids the HTML now refers to. */
export function dehydrateArtworkUrls(html: string): { html: string; assetIds: string[] } {
  const assetIds = new Set<string>();
  const result = html.replace(blobUrlPattern, (url) => {
    const asset = assetsByUrl.get(url);
    if (!asset) return url;
    assetIds.add(asset.id);
    return `${ARTWORK_ASSET_SCHEME}${asset.id}`;
  });
  return { html: result, assetIds: [...assetIds] };
}

export function listArtworkAssetIds(html: string): string[] {
  return [...new Set([...html.matchAll(assetTokenPattern)].map((match) => match[1]))];
}

/**
 * Turns a saved draft's asset tokens back into blob URLs. Base64 data URLs from older drafts become
 * blob URLs too, so the next autosave stores them as files and the draft shrinks.
 */
export async function hydrateArtworkUrls(html: string, blobs: Map<string, Blob>): Promise<string> {
  let result = html.replace(assetTokenPattern, (token, id: string) => {
    const blob = blobs.get(id);
    return blob && assetIdPattern.test(id) ? createArtworkUrl(blob, id) : token;
  });
  const inline = [...new Set(result.match(inlineImagePattern) || [])];
  if (!inline.length) return result;
  const urls = new Map<string, string>();
  for (const dataUrl of inline) {
    try {
      urls.set(dataUrl, createArtworkUrl(await (await fetch(dataUrl)).blob()));
    } catch {
      // Leave an unreadable image as it was.
    }
  }
  result = result.replace(inlineImagePattern, (dataUrl) => urls.get(dataUrl) || dataUrl);
  return result;
}
