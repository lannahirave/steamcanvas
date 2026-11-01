// Copyright (C) 2026 lannahirave
// SPDX-License-Identifier: AGPL-3.0-only
//
// Lists the conversions saved in Steam Artwork Studio's Library (in this browser) inside the
// showcase editor, so they can be placed without downloading and re-selecting the files.

import { useEffect, useMemo, useState } from 'react';
import { Images, LoaderCircle, RotateCcw } from 'lucide-react';
import {
  ARTWORK_STUDIO_URL,
  describePreset,
  listStudioLibrary,
  type IncomingArtwork,
  type StudioLibraryEntry,
} from '../utils/artworkStudioLibrary';

export type StudioPickerKind = 'workshop' | 'artwork' | 'screenshot' | 'featured-artwork';

type Props = {
  kind: StudioPickerKind;
  disabled: boolean;
  onChoose: (artwork: IncomingArtwork, startRow: number) => void;
};

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; entries: StudioLibraryEntry[] }
  | { status: 'error'; message: string };

/** Why an entry cannot go in this showcase, or null when it can. */
function placementProblem(entry: StudioLibraryEntry, kind: StudioPickerKind, startRow: number): string | null {
  if (entry.problem || !entry.artwork) return entry.problem || 'SteamCanvas cannot place this conversion.';
  const { preset } = entry.artwork;
  if (kind === 'workshop') {
    if (preset !== 'workshop') return `Made for the ${describePreset(entry)}.`;
    const lastRow = startRow + entry.artwork.workshopRows - 1;
    if (lastRow > 3) return `Needs ${entry.artwork.workshopRows} rows; start at row ${4 - entry.artwork.workshopRows} or earlier.`;
    return null;
  }
  if (kind === 'featured-artwork') return preset === 'featured' ? null : `Made for the ${describePreset(entry)}.`;
  return preset === 'showcase' ? null : `Made for the ${describePreset(entry)}.`;
}

function EntryButton({ entry, problem, disabled, onChoose }: { entry: StudioLibraryEntry; problem: string | null; disabled: boolean; onChoose: () => void }) {
  // Workshop conversions show their first row; one GIF per part keeps the strip recognisable.
  const thumbnails = useMemo(() => entry.files.slice(0, 5).map((file) => URL.createObjectURL(file)), [entry]);
  useEffect(() => () => thumbnails.forEach((url) => URL.revokeObjectURL(url)), [thumbnails]);
  const title = entry.sourceName || 'Untitled conversion';
  const date = entry.createdAt ? new Date(entry.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  return (
    <button
      type="button"
      className={`studio-library-item${problem ? ' is-unavailable' : ''}`}
      disabled={disabled || !!problem}
      title={problem || `Use ${title}`}
      onClick={onChoose}
    >
      <span className={`studio-library-thumbs is-${entry.preset}`}>
        {thumbnails.map((url, index) => <img key={index} src={url} alt="" loading="lazy" />)}
      </span>
      <span className="studio-library-copy">
        <strong>{title}</strong>
        <small>{describePreset(entry)}{date ? ` · ${date}` : ''}{entry.complete ? '' : ' · finished early'}</small>
        {problem && <small className="studio-library-problem">{problem}</small>}
      </span>
    </button>
  );
}

export default function StudioLibraryPicker({ kind, disabled, onChoose }: Props) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const [startRow, setStartRow] = useState(1);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void Promise.resolve().then(() => {
      if (active) setState({ status: 'loading' });
      return listStudioLibrary();
    }).then((entries) => {
      if (active) setState({ status: 'ready', entries });
    }).catch((caught: unknown) => {
      if (active) setState({ status: 'error', message: caught instanceof Error ? caught.message : 'Could not read the Steam Artwork Studio Library.' });
    });
    return () => { active = false; };
  }, [open, revision]);

  const entries = state.status === 'ready' ? state.entries : [];
  const ranked = entries
    .map((entry) => ({ entry, problem: placementProblem(entry, kind, startRow) }))
    // Usable conversions first, each group newest first (the Studio already sends them newest first).
    .sort((left, right) => Number(!!left.problem) - Number(!!right.problem));

  return (
    <div className="showcase-editor-control-group studio-library-picker">
      <span className="showcase-editor-label">FROM ARTWORK STUDIO</span>
      {!open ? (
        <button className="showcase-editor-upload studio-library-open" type="button" disabled={disabled} onClick={() => setOpen(true)}>
          <Images size={17} />
          <span>
            <strong>Choose from Artwork Studio</strong>
            <small>GIFs saved in the Steam Artwork Studio Library of this browser</small>
          </span>
        </button>
      ) : (
        <>
          {kind === 'workshop' && (
            <div className="studio-library-rows" role="group" aria-label="First row to fill">
              <span>Start at row</span>
              {[1, 2, 3].map((row) => (
                <button key={row} type="button" className={startRow === row ? 'is-active' : ''} aria-pressed={startRow === row} onClick={() => setStartRow(row)}>{row}</button>
              ))}
            </div>
          )}
          {state.status === 'loading' && <div className="showcase-public-picker-status" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" />Reading the Artwork Studio Library…</div>}
          {state.status === 'error' && (
            <div className="showcase-public-picker-status" role="alert">
              <span>{state.message}</span>
              <button className="studio-library-retry" type="button" onClick={() => setRevision((value) => value + 1)}><RotateCcw size={12} /> Retry</button>
            </div>
          )}
          {state.status === 'ready' && !entries.length && (
            <p className="showcase-public-picker-copy">Nothing saved yet. Conversions you make in <a href={ARTWORK_STUDIO_URL} target="_blank" rel="noreferrer">Steam Artwork Studio</a> appear here.</p>
          )}
          {ranked.length > 0 && (
            <div className="studio-library-list">
              {ranked.map(({ entry, problem }) => (
                <EntryButton key={entry.id} entry={entry} problem={problem} disabled={disabled} onChoose={() => entry.artwork && onChoose(entry.artwork, startRow)} />
              ))}
            </div>
          )}
          {state.status === 'ready' && (
            <button className="studio-library-retry" type="button" onClick={() => setRevision((value) => value + 1)}><RotateCcw size={12} /> Refresh</button>
          )}
        </>
      )}
    </div>
  );
}
