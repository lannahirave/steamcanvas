// Copyright (C) 2026 lannahirave
// SPDX-License-Identifier: AGPL-3.0-only
//
// Artwork SteamCanvas keeps in its own IndexedDB: copies of the demo examples opened with ?demo=.
// Each record holds the image files themselves, not links, so a saved example keeps working when
// the demo site moves or renames its files. Steam Artwork Studio lists and deletes these through
// /bridge/ (src/bridge/main.ts). See docs/ARTWORK_STUDIO_INTEGRATION.md.

import type { ArtworkStudioPreset, IncomingArtwork } from './artworkStudioLibrary';

const databaseName = 'steamcanvas-saved-artwork';
const storeName = 'artwork';

export type SavedArtworkFile = { name: string; type: string; width: number; height: number; blob: Blob };

export type SavedArtwork = {
  /** `demo:<demo id>` for demo examples. */
  id: string;
  kind: 'demo';
  /** The demo site's ID for the example; stays the same when its files move. */
  sourceId: string;
  title: string;
  preset: ArtworkStudioPreset;
  workshopRows: 1 | 2 | 3;
  savedAt: number;
  /** Where the files were downloaded from, for reference only. */
  sourceUrl: string;
  files: SavedArtworkFile[];
};

let database: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading the schema closes this connection; reopen on the next call.
      db.onversionchange = () => { db.close(); database = null; };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('IndexedDB is not available.'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab.'));
  });
  database.catch(() => { database = null; });
  return database;
}

function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then((db) => new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? request.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Saving was cancelled.'));
  }));
}

export function demoArtworkKey(demoId: string): string {
  return `demo:${demoId}`;
}

export function saveArtwork(record: SavedArtwork): Promise<IDBValidKey> {
  return run('readwrite', (store) => store.put(record));
}

export async function getSavedArtwork(id: string): Promise<SavedArtwork | null> {
  const record = await run<SavedArtwork | undefined>('readonly', (store) => store.get(id));
  return record ?? null;
}

/** Everything saved, newest first. */
export async function listSavedArtwork(): Promise<SavedArtwork[]> {
  const records = await run<SavedArtwork[]>('readonly', (store) => store.getAll());
  return records.sort((left, right) => right.savedAt - left.savedAt);
}

export function deleteSavedArtwork(id: string): Promise<undefined> {
  return run('readwrite', (store) => store.delete(id));
}

export function clearSavedArtwork(): Promise<undefined> {
  return run('readwrite', (store) => store.clear());
}

export function savedArtworkBytes(record: SavedArtwork): number {
  return record.files.reduce((total, file) => total + file.blob.size, 0);
}

/** A saved record in the shape the showcase editor places. */
export function toIncomingArtwork(record: SavedArtwork): IncomingArtwork {
  const widths = record.files.map((file) => file.width);
  return {
    id: record.id,
    preset: record.preset,
    workshopRows: record.workshopRows,
    sourceName: record.title,
    files: record.files.map((file) => new File([file.blob], file.name, { type: file.type })),
    ...(widths.every((width) => width > 0) ? { widths } : {}),
  };
}
