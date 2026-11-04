// Copyright (C) 2026 lannahirave
// SPDX-License-Identifier: AGPL-3.0-only
//
// ?demo=<id>: places an example from the Steam Artwork Studio demo page (demoartwork.lannahirave.com).
// The demo page publishes demo-manifest.json, which maps each example's stable ID to its files. The
// first time an example is opened, SteamCanvas downloads the files and keeps a copy in its own
// IndexedDB (savedArtwork.ts); later visits use that copy, so they keep working when the demo site
// rearranges its files. See docs/ARTWORK_STUDIO_INTEGRATION.md.

import type { ArtworkStudioPreset, IncomingArtwork } from './artworkStudioLibrary';
import { demoArtworkKey, getSavedArtwork, saveArtwork, toIncomingArtwork, type SavedArtwork, type SavedArtworkFile } from './savedArtwork';

export const DEMO_ARTWORK_ORIGIN: string = import.meta.env.VITE_DEMO_ARTWORK_ORIGIN || 'https://demoartwork.lannahirave.com';
export const DEMO_ARTWORK_URL = `${DEMO_ARTWORK_ORIGIN}/`;

const manifestPath = '/demo-manifest.json';
const manifestVersion = 1;
const maxFiles = 15;
const maxFileBytes = 12 * 1024 * 1024;
const fetchTimeoutMs = 60000;
const idPattern = /^[A-Za-z0-9_-]{3,96}$/;
const imageType = /^image\/(png|jpeg|webp|gif|avif|apng)$/;

export function isDemoId(value: unknown): value is string {
  return typeof value === 'string' && idPattern.test(value);
}

export type DemoFailureReason = 'not-found' | 'network' | 'invalid';

export class DemoArtworkError extends Error {
  constructor(readonly reason: DemoFailureReason) {
    super(demoErrorMessage(reason));
  }
}

function demoErrorMessage(reason: DemoFailureReason): string {
  switch (reason) {
    case 'not-found':
      return 'This example is no longer on the Steam Artwork Studio demo page.';
    case 'network':
      return 'Could not download the example from the Steam Artwork Studio demo page. Check your connection and reload.';
    default:
      return 'The demo page sent an example SteamCanvas cannot use.';
  }
}

type ManifestItem = {
  id: string;
  title: string;
  preset: ArtworkStudioPreset;
  workshopRows: 1 | 2 | 3;
  files: Array<{ url: string; name: string; width: number; height: number }>;
};

function parseItem(raw: unknown): ManifestItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const preset = item.preset;
  if (!isDemoId(item.id)) return null;
  if (preset !== 'workshop' && preset !== 'showcase' && preset !== 'featured') return null;
  if (!Array.isArray(item.files) || item.files.length === 0 || item.files.length > maxFiles) return null;
  const files = item.files.map((file: unknown) => {
    const entry = (file ?? {}) as Record<string, unknown>;
    if (typeof entry.path !== 'string') return null;
    // Only files on the demo site itself.
    const url = new URL(entry.path, DEMO_ARTWORK_URL);
    if (url.origin !== DEMO_ARTWORK_ORIGIN) return null;
    const name = decodeURIComponent(url.pathname.split('/').pop() ?? '').slice(0, 160) || 'artwork.gif';
    return { url: url.href, name, width: Number(entry.width) || 0, height: Number(entry.height) || 0 };
  });
  if (files.some((file) => file === null)) return null;
  const rows = preset === 'workshop' ? files.length / 5 : 1;
  if (preset === 'featured' && files.length !== 1) return null;
  if (preset === 'showcase' && files.length !== 2) return null;
  if (preset === 'workshop' && (!Number.isInteger(rows) || rows < 1 || rows > 3)) return null;
  return {
    id: item.id,
    title: typeof item.title === 'string' ? item.title.slice(0, 160) : item.id,
    preset,
    workshopRows: rows as 1 | 2 | 3,
    files: files as ManifestItem['files'],
  };
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    // credentials: 'omit' — the demo files are public, nothing about the visitor is sent.
    return await fetch(url, { signal: controller.signal, credentials: 'omit', cache: 'no-cache' });
  } catch {
    throw new DemoArtworkError('network');
  } finally {
    clearTimeout(timer);
  }
}

async function findManifestItem(demoId: string): Promise<ManifestItem> {
  const response = await fetchWithTimeout(`${DEMO_ARTWORK_ORIGIN}${manifestPath}`);
  if (!response.ok) throw new DemoArtworkError('network');
  let manifest: unknown;
  try {
    manifest = await response.json();
  } catch {
    throw new DemoArtworkError('invalid');
  }
  const data = (manifest ?? {}) as Record<string, unknown>;
  if (data.version !== manifestVersion || !Array.isArray(data.items)) throw new DemoArtworkError('invalid');
  const raw = data.items.find((item: unknown) => (item as Record<string, unknown> | null)?.id === demoId);
  if (!raw) throw new DemoArtworkError('not-found');
  const item = parseItem(raw);
  if (!item) throw new DemoArtworkError('invalid');
  return item;
}

async function downloadFile(file: ManifestItem['files'][number]): Promise<SavedArtworkFile> {
  const response = await fetchWithTimeout(file.url);
  if (response.status === 404) throw new DemoArtworkError('not-found');
  if (!response.ok) throw new DemoArtworkError('network');
  const blob = await response.blob();
  const type = (response.headers.get('Content-Type') ?? blob.type).split(';')[0].trim().toLowerCase();
  if (!imageType.test(type) || blob.size === 0 || blob.size > maxFileBytes) throw new DemoArtworkError('invalid');
  return { name: file.name, type, width: file.width, height: file.height, blob: blob.type === type ? blob : blob.slice(0, blob.size, type) };
}

export type DemoArtworkResult = {
  artwork: IncomingArtwork;
  /** True when the copy came from this browser instead of the demo site. */
  fromSaved: boolean;
  /** False when the browser would not let SteamCanvas keep a copy. */
  saved: boolean;
};

/** The demo example, from the saved copy when there is one, otherwise downloaded and saved. */
export async function loadDemoArtwork(demoId: string): Promise<DemoArtworkResult> {
  const key = demoArtworkKey(demoId);
  try {
    const existing = await getSavedArtwork(key);
    if (existing) return { artwork: toIncomingArtwork(existing), fromSaved: true, saved: true };
  } catch {
    // Storage blocked: download and place without keeping a copy.
  }

  const item = await findManifestItem(demoId);
  const files = await Promise.all(item.files.map(downloadFile));
  const record: SavedArtwork = {
    id: key,
    kind: 'demo',
    sourceId: item.id,
    title: item.title,
    preset: item.preset,
    workshopRows: item.workshopRows,
    savedAt: Date.now(),
    sourceUrl: DEMO_ARTWORK_URL,
    files,
  };
  let saved = true;
  try {
    await saveArtwork(record);
  } catch {
    saved = false;
  }
  return { artwork: toIncomingArtwork(record), fromSaved: false, saved };
}
