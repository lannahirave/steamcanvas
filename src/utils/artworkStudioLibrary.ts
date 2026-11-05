// Copyright (C) 2026 lannahirave
// SPDX-License-Identifier: AGPL-3.0-only
//
// Reads the Library of Steam Artwork Studio. The Studio keeps every conversion in its own IndexedDB
// and serves a small /bridge page; SteamCanvas embeds it in a hidden iframe and asks it for saved
// conversions over postMessage. The bridge only reads. See docs/ARTWORK_STUDIO_INTEGRATION.md.

export const ARTWORK_STUDIO_ORIGIN: string = import.meta.env.VITE_ARTWORK_STUDIO_ORIGIN || 'https://artworkstudio.lannahirave.com';
export const ARTWORK_STUDIO_URL = `${ARTWORK_STUDIO_ORIGIN}/`;

const protocolVersion = 2;
const connectTimeoutMs = 15000;
const requestTimeoutMs = 20000;
const maxFiles = 15;
const maxNotesLength = 1000;
const idPattern = /^[A-Za-z0-9_-]{16,64}$/;

export type ArtworkStudioPreset = 'workshop' | 'showcase' | 'featured';
export type StudioPreset = ArtworkStudioPreset | 'guide';

/** A saved conversion SteamCanvas can place in a showcase. */
export type IncomingArtwork = {
  id: string;
  preset: ArtworkStudioPreset;
  workshopRows: 1 | 2 | 3;
  sourceName: string;
  files: File[];
  /** Pixel width of each file, in the same order, as reported by the Studio. */
  widths?: number[];
};

/** Any saved conversion, with the reason it cannot be placed when SteamCanvas has no showcase for it. */
export type StudioLibraryEntry = {
  id: string;
  createdAt: number;
  sourceName: string;
  preset: StudioPreset;
  workshopRows: number;
  complete: boolean;
  /** The user's notes from the Studio's Library tab; empty when there are none. */
  notes: string;
  files: File[];
  widths: number[];
  heights: number[];
  artwork: IncomingArtwork | null;
  problem: string | null;
};

export type LibraryFailureReason = 'not-found' | 'storage-unavailable' | 'timeout' | 'invalid';

export class LibraryError extends Error {
  constructor(readonly reason: LibraryFailureReason) {
    super(libraryErrorMessage(reason));
  }
}

function libraryErrorMessage(reason: LibraryFailureReason): string {
  switch (reason) {
    case 'not-found':
      return 'These GIFs are no longer in the Steam Artwork Studio Library of this browser. They may have been deleted there.';
    case 'storage-unavailable':
      return 'Your browser did not let SteamCanvas read the Steam Artwork Studio Library. Download the ZIP in the Studio and select the files in the showcase editor instead.';
    case 'timeout':
      return 'Steam Artwork Studio did not answer. Check your connection, or download the ZIP in the Studio and select the files in the showcase editor.';
    default:
      return 'Steam Artwork Studio sent files SteamCanvas cannot use. Download the ZIP in the Studio and select the files in the showcase editor instead.';
  }
}

export function isStudioId(value: unknown): value is string {
  return typeof value === 'string' && idPattern.test(value);
}

export function describePreset(artwork: { preset: StudioPreset; workshopRows: number }): string {
  if (artwork.preset === 'workshop') return `Workshop Showcase, ${artwork.workshopRows} × 5`;
  if (artwork.preset === 'featured') return 'Featured Artwork Showcase';
  if (artwork.preset === 'guide') return 'Guide cover';
  return 'Artwork Showcase';
}

type BridgeFile = { name?: unknown; type?: unknown; width?: unknown; height?: unknown; blob?: unknown };

function parseEntry(data: unknown): StudioLibraryEntry {
  if (!data || typeof data !== 'object') throw new LibraryError('invalid');
  const raw = data as Record<string, unknown>;
  const preset = raw.preset;
  if (!isStudioId(raw.id)) throw new LibraryError('invalid');
  if (preset !== 'workshop' && preset !== 'showcase' && preset !== 'featured' && preset !== 'guide') throw new LibraryError('invalid');
  const rawFiles = Array.isArray(raw.files) ? raw.files as BridgeFile[] : [];
  if (!rawFiles.length || rawFiles.length > 64) throw new LibraryError('invalid');

  let imageFiles = true;
  const files = rawFiles.map((file, index) => {
    if (!(file.blob instanceof Blob)) throw new LibraryError('invalid');
    const type = typeof file.type === 'string' && file.type ? file.type : file.blob.type;
    if (!/^image\/(png|jpeg|webp|gif|avif|apng)$/.test(type)) imageFiles = false;
    const name = typeof file.name === 'string' && file.name.trim() ? file.name.trim().slice(0, 160) : `artwork-${index + 1}`;
    return new File([file.blob], name, { type });
  });
  const widths = rawFiles.map((file) => Number(file.width) || 0);
  const heights = rawFiles.map((file) => Number(file.height) || 0);
  const workshopRows = Number(raw.workshopRows) || 1;
  const workshopParts = Number(raw.workshopParts) || 5;

  let problem: string | null = null;
  if (preset === 'guide') problem = 'Guide covers are not part of a profile.';
  else if (!imageFiles) problem = 'SteamCanvas can only show image files.';
  else if (preset === 'featured' && files.length !== 1) problem = 'A Featured Artwork needs exactly one image.';
  else if (preset === 'showcase' && files.length !== 2) problem = 'An Artwork Showcase needs a main and a side image.';
  else if (preset === 'workshop' && workshopParts !== 5) problem = `SteamCanvas places 5 Workshop parts per row; this conversion has ${workshopParts}.`;
  else if (preset === 'workshop' && (files.length % 5 !== 0 || files.length > maxFiles)) problem = 'This Workshop conversion finished early and is missing parts.';

  const rows = preset === 'workshop' ? files.length / 5 : 1;
  const artwork: IncomingArtwork | null = problem || preset === 'guide' ? null : {
    id: raw.id,
    preset,
    workshopRows: rows as 1 | 2 | 3,
    sourceName: typeof raw.sourceName === 'string' ? raw.sourceName.slice(0, 160) : '',
    files,
    ...(widths.every((width) => width > 0) ? { widths } : {}),
  };
  return {
    id: raw.id,
    createdAt: Number(raw.createdAt) || 0,
    sourceName: typeof raw.sourceName === 'string' ? raw.sourceName.slice(0, 160) : '',
    preset,
    workshopRows,
    complete: raw.complete !== false,
    // Older Studio builds send no notes.
    notes: typeof raw.notes === 'string' ? raw.notes.slice(0, maxNotesLength) : '',
    files,
    widths,
    heights,
    artwork,
    problem,
  };
}

type Pending = { resolve: (data: Record<string, unknown>) => void; reject: (error: LibraryError) => void; timer: ReturnType<typeof setTimeout> };

let connection: Promise<HTMLIFrameElement> | null = null;
const pending = new Map<string, Pending>();
let requestCounter = 0;

function onMessage(event: MessageEvent): void {
  if (event.origin !== ARTWORK_STUDIO_ORIGIN) return;
  const data = event.data as Record<string, unknown> | null;
  if (!data || data.source !== 'steam-artwork-studio' || data.version !== protocolVersion) return;
  const requestId = typeof data.requestId === 'string' ? data.requestId : '';
  const waiting = pending.get(requestId);
  if (!waiting) return;
  pending.delete(requestId);
  clearTimeout(waiting.timer);
  if (data.type === 'error') {
    waiting.reject(new LibraryError(data.reason === 'not-found' || data.reason === 'storage-unavailable' ? data.reason : 'invalid'));
  } else {
    waiting.resolve(data);
  }
}

/** Loads the Studio's bridge once per page and resolves when it reports ready. */
function connect(): Promise<HTMLIFrameElement> {
  if (connection) return connection;
  connection = new Promise<HTMLIFrameElement>((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.title = 'Steam Artwork Studio Library';
    frame.src = `${ARTWORK_STUDIO_ORIGIN}/bridge/`;

    const timer = setTimeout(() => {
      window.removeEventListener('message', onReady);
      frame.remove();
      reject(new LibraryError('timeout'));
    }, connectTimeoutMs);
    function onReady(event: MessageEvent) {
      // Only the bridge iframe, served from the Studio's origin, may answer.
      if (event.origin !== ARTWORK_STUDIO_ORIGIN || event.source !== frame.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.source !== 'steam-artwork-studio' || data.version !== protocolVersion || data.type !== 'ready') return;
      clearTimeout(timer);
      window.removeEventListener('message', onReady);
      window.addEventListener('message', onMessage);
      resolve(frame);
    }
    window.addEventListener('message', onReady);
    document.body.append(frame);
  });
  // A failed connection is retried on the next request.
  connection.catch(() => { connection = null; });
  return connection;
}

async function request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const frame = await connect();
  const requestId = `r${++requestCounter}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new LibraryError('timeout'));
    }, requestTimeoutMs);
    pending.set(requestId, { resolve, reject, timer });
    frame.contentWindow?.postMessage({ source: 'steamcanvas', version: protocolVersion, requestId, ...message }, ARTWORK_STUDIO_ORIGIN);
  });
}

/** Every conversion saved in the Studio's Library in this browser, newest first. Malformed ones are skipped. */
export async function listStudioLibrary(): Promise<StudioLibraryEntry[]> {
  const result = await request({ type: 'list' });
  if (result.type !== 'list-result' || !Array.isArray(result.entries)) throw new LibraryError('invalid');
  return result.entries.flatMap((entry) => {
    try {
      return [parseEntry(entry)];
    } catch {
      return [];
    }
  });
}

/** One saved conversion, ready to place. Throws when it is missing or SteamCanvas cannot place it. */
export async function getStudioArtwork(id: string): Promise<IncomingArtwork> {
  const result = await request({ type: 'get', id });
  if (result.type !== 'get-result') throw new LibraryError('invalid');
  const entry = parseEntry(result.entry);
  if (!entry.artwork) throw new LibraryError('invalid');
  return entry.artwork;
}
