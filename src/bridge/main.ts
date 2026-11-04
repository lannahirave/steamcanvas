// Copyright (C) 2026 lannahirave
// SPDX-License-Identifier: AGPL-3.0-only
//
// Runs inside a hidden iframe in Steam Artwork Studio's Library tab and answers its requests about the
// artwork SteamCanvas saved in this browser (the demo examples, savedArtwork.ts). Messages are accepted
// from, and sent to, the Studio's origin only. The Studio can list, delete one and delete all; it cannot
// add anything. See docs/ARTWORK_STUDIO_INTEGRATION.md, "Saved artwork bridge".

import { ARTWORK_STUDIO_ORIGIN } from '../utils/artworkStudioLibrary';
import { clearSavedArtwork, deleteSavedArtwork, listSavedArtwork, savedArtworkBytes } from '../utils/savedArtwork';

const channel = 'saved-artwork';
const protocolVersion = 1;
const idPattern = /^[A-Za-z0-9:_-]{3,128}$/;

type Request =
  | { type: 'list'; requestId: string }
  | { type: 'delete'; requestId: string; id: string }
  | { type: 'clear'; requestId: string };

function post(message: Record<string, unknown>): void {
  window.parent.postMessage({ source: 'steamcanvas', channel, version: protocolVersion, ...message }, ARTWORK_STUDIO_ORIGIN);
}

function parseRequest(data: unknown): Request | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  if (raw.source !== 'steam-artwork-studio' || raw.channel !== channel || raw.version !== protocolVersion) return null;
  const requestId = typeof raw.requestId === 'string' && raw.requestId.length <= 64 ? raw.requestId : null;
  if (!requestId) return null;
  if (raw.type === 'list' || raw.type === 'clear') return { type: raw.type, requestId };
  if (raw.type === 'delete' && typeof raw.id === 'string' && idPattern.test(raw.id)) return { type: 'delete', requestId, id: raw.id };
  return null;
}

async function answer(request: Request): Promise<void> {
  const { requestId } = request;
  try {
    if (request.type === 'list') {
      const records = await listSavedArtwork();
      post({
        type: 'list-result',
        requestId,
        entries: records.map((record) => ({
          id: record.id,
          kind: record.kind,
          sourceId: record.sourceId,
          title: record.title,
          preset: record.preset,
          workshopRows: record.workshopRows,
          savedAt: record.savedAt,
          bytes: savedArtworkBytes(record),
          files: record.files.map(({ name, type, width, height, blob }) => ({ name, type, width, height, blob })),
        })),
      });
      return;
    }
    if (request.type === 'delete') await deleteSavedArtwork(request.id);
    else await clearSavedArtwork();
    post({ type: 'done', requestId });
  } catch {
    // Storage blocked in this embedded context (for example, Safari tracking prevention).
    post({ type: 'error', requestId, reason: 'storage-unavailable' });
  }
}

if (window.parent !== window) {
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.origin !== ARTWORK_STUDIO_ORIGIN || event.source !== window.parent) return;
    const request = parseRequest(event.data);
    if (request) void answer(request);
  });
  post({ type: 'ready' });
}
