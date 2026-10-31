// Copyright (C) 2026 lannahirave
// SPDX-License-Identifier: AGPL-3.0-only
//
// Receives converted GIFs from Steam Artwork Studio. The Studio keeps them in its own IndexedDB and
// serves a small /bridge page that SteamCanvas embeds in a hidden iframe; the bridge posts the files
// to this window. See docs/ARTWORK_STUDIO_INTEGRATION.md for the protocol.

export const ARTWORK_STUDIO_ORIGIN: string = import.meta.env.VITE_ARTWORK_STUDIO_ORIGIN || 'https://artworkstudio.lannahirave.com';
export const ARTWORK_STUDIO_URL = `${ARTWORK_STUDIO_ORIGIN}/`;

const protocolVersion = 1;
const handoffTimeoutMs = 20000;
const maxFiles = 15;

export type ArtworkStudioPreset = 'workshop' | 'showcase' | 'featured';

export type IncomingArtwork = {
  id: string;
  preset: ArtworkStudioPreset;
  workshopRows: 1 | 2 | 3;
  sourceName: string;
  files: File[];
  /** Pixel width of each file, in the same order, as reported by the Studio. */
  widths?: number[];
};

export type HandoffFailureReason = 'not-found' | 'expired' | 'storage-unavailable' | 'timeout' | 'invalid';

export class HandoffError extends Error {
  constructor(readonly reason: HandoffFailureReason) {
    super(handoffErrorMessage(reason));
  }
}

function handoffErrorMessage(reason: HandoffFailureReason): string {
  switch (reason) {
    case 'not-found':
      return 'These GIFs are no longer saved in Steam Artwork Studio. Go back to the Studio and open the preview again.';
    case 'expired':
      return 'This preview link has expired. Go back to Steam Artwork Studio and open the preview again.';
    case 'storage-unavailable':
      return 'Your browser did not let SteamCanvas read the GIFs from Steam Artwork Studio. Download the ZIP in the Studio and select the files in the showcase editor instead.';
    case 'timeout':
      return 'Steam Artwork Studio did not answer. Check your connection, or download the ZIP in the Studio and select the files in the showcase editor.';
    default:
      return 'Steam Artwork Studio sent files SteamCanvas cannot use. Download the ZIP in the Studio and select the files in the showcase editor instead.';
  }
}

/** Reads `?handoff=<id>` from the current URL. */
export function readHandoffId(): string | null {
  const id = new URLSearchParams(globalThis.location.search).get('handoff');
  return id && /^[A-Za-z0-9_-]{16,64}$/.test(id) ? id : null;
}

/** Removes `?handoff=` so a reload or a shared URL does not ask for the same files again. */
export function clearHandoffFromUrl(): void {
  const url = new URL(globalThis.location.href);
  if (!url.searchParams.has('handoff')) return;
  url.searchParams.delete('handoff');
  globalThis.history.replaceState(globalThis.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

export function describePreset(artwork: Pick<IncomingArtwork, 'preset' | 'workshopRows'>): string {
  if (artwork.preset === 'workshop') return `Workshop Showcase, ${artwork.workshopRows} × 5`;
  if (artwork.preset === 'featured') return 'Featured Artwork Showcase';
  return 'Artwork Showcase';
}

type BridgeFile = { name?: unknown; type?: unknown; width?: unknown; blob?: unknown };

function parseHandoff(id: string, data: Record<string, unknown>): IncomingArtwork {
  const preset = data.preset;
  if (preset !== 'workshop' && preset !== 'showcase' && preset !== 'featured') throw new HandoffError('invalid');
  const rawFiles = Array.isArray(data.files) ? data.files as BridgeFile[] : [];
  if (!rawFiles.length || rawFiles.length > maxFiles) throw new HandoffError('invalid');

  const files = rawFiles.map((file, index) => {
    if (!(file.blob instanceof Blob)) throw new HandoffError('invalid');
    const type = typeof file.type === 'string' && file.type ? file.type : file.blob.type;
    if (!/^image\/(png|jpeg|webp|gif|avif|apng)$/.test(type)) throw new HandoffError('invalid');
    const name = typeof file.name === 'string' && file.name.trim() ? file.name.trim().slice(0, 160) : `artwork-${index + 1}`;
    return new File([file.blob], name, { type });
  });

  const expectedCount = preset === 'featured' ? 1 : preset === 'showcase' ? 2 : files.length;
  if (files.length !== expectedCount) throw new HandoffError('invalid');
  const rows = preset === 'workshop' ? files.length / 5 : 1;
  if (rows !== 1 && rows !== 2 && rows !== 3) throw new HandoffError('invalid');

  const widths = rawFiles.map((file) => Number(file.width));
  return {
    id,
    preset,
    ...(widths.every((width) => Number.isFinite(width) && width > 0) ? { widths } : {}),
    workshopRows: rows,
    sourceName: typeof data.sourceName === 'string' ? data.sourceName.slice(0, 160) : '',
    files,
  };
}

export type HandoffConnection = {
  artwork: IncomingArtwork;
  /** Tells the Studio the files were placed, so it can delete its copy, and closes the bridge. */
  confirmApplied: () => void;
  /** Closes the bridge without deleting the Studio's copy. */
  close: () => void;
};

/** Loads the Studio's bridge page in a hidden iframe and waits for the files it sends. */
export function requestHandoff(id: string): Promise<HandoffConnection> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.title = 'Steam Artwork Studio handoff';
    frame.src = `${ARTWORK_STUDIO_ORIGIN}/bridge/?id=${encodeURIComponent(id)}`;

    let settled = false;
    const close = () => {
      window.removeEventListener('message', onMessage);
      globalThis.clearTimeout(timer);
      frame.remove();
    };
    const fail = (reason: HandoffFailureReason) => {
      if (settled) return;
      settled = true;
      close();
      reject(new HandoffError(reason));
    };
    const onMessage = (event: MessageEvent) => {
      // Only the bridge iframe, served from the Studio's origin, may hand over files.
      if (event.origin !== ARTWORK_STUDIO_ORIGIN || event.source !== frame.contentWindow) return;
      const data = event.data as Record<string, unknown> | null;
      if (!data || data.source !== 'steam-artwork-studio' || data.version !== protocolVersion || data.id !== id) return;

      if (data.type === 'handoff-error') {
        const reason = data.reason;
        fail(reason === 'not-found' || reason === 'expired' || reason === 'storage-unavailable' ? reason : 'invalid');
        return;
      }
      if (data.type !== 'handoff' || settled) return;

      let artwork: IncomingArtwork;
      try {
        artwork = parseHandoff(id, data);
      } catch (error) {
        fail(error instanceof HandoffError ? error.reason : 'invalid');
        return;
      }
      settled = true;
      globalThis.clearTimeout(timer);
      resolve({
        artwork,
        confirmApplied: () => {
          frame.contentWindow?.postMessage({ source: 'steamcanvas', version: protocolVersion, type: 'handoff-consumed', id }, ARTWORK_STUDIO_ORIGIN);
          // Give the bridge a moment to delete the record before its page goes away.
          globalThis.setTimeout(close, 1500);
        },
        close,
      });
    };
    const timer = globalThis.setTimeout(() => fail('timeout'), handoffTimeoutMs);

    window.addEventListener('message', onMessage);
    document.body.append(frame);
  });
}
