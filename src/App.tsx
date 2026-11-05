// Copyright (C) 2026 dumbapplee
// Modified by lannahirave, 2026: Steam Artwork Studio handoff, demo examples (?demo=), source and
// licence notices, and links to this fork.
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, CircleHelp, Coffee, Download, ExternalLink, Github, History, Images, LoaderCircle, PanelsTopLeft, Pause, Play, RefreshCw, RotateCcw, Search, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import AvatarEditor, { DEFAULT_AVATAR_EDIT, type AvatarEditState } from './components/AvatarEditor';
import AvatarFramePicker, { type SteamAvatarFrame } from './components/AvatarFramePicker';
import BackgroundPicker, { type ProfileBackgroundSize, type SteamBackground } from './components/BackgroundPicker';
import ProfileThemePicker, { type AppliedProfileTheme } from './components/ProfileThemePicker';
import ShowcaseEditor, { type IncomingArtworkResult, type RemovedShowcase } from './components/ShowcaseEditor';
import GuideDialog, { getGuideSlugForPath } from './components/GuidePage';
import { ensureShowcaseArea } from './utils/showcaseArea';
import {
  ARTWORK_STUDIO_URL,
  describePreset,
  getStudioArtwork,
  isStudioId,
  LibraryError,
  type IncomingArtwork,
} from './utils/artworkStudioLibrary';
import { DEMO_ARTWORK_URL, DemoArtworkError, isDemoId, loadDemoArtwork } from './utils/demoArtwork';

const forkRepositoryUrl = 'https://github.com/lannahirave/steamcanvas';
const upstreamRepositoryUrl = 'https://github.com/dumbapplee/steamcanvas';
const sourceCodeUrl = __SOURCE_REF__ ? `${forkRepositoryUrl}/tree/${__SOURCE_REF__}` : forkRepositoryUrl;

/** Where incoming artwork comes from: the Studio's Library (?studio=) or a demo example (?demo=). */
type HandoffSource = 'studio' | 'demo';

type HandoffState =
  | { status: 'none' }
  | { status: 'loading'; from: HandoffSource }
  | { status: 'ready'; from: HandoffSource; artwork: IncomingArtwork; note?: string }
  | { status: 'applied'; from: HandoffSource; artwork: IncomingArtwork; showcaseTitle: string }
  | { status: 'error'; from: HandoffSource; message: string };

function HandoffNotice({ state, hasProfile }: { state: HandoffState; hasProfile: boolean }) {
  if (state.status === 'none') return null;
  const demo = state.from === 'demo';
  const origin = demo ? 'the demo page' : 'Steam Artwork Studio';
  if (state.status === 'loading') {
    return <div className="handoff-notice" role="status"><LoaderCircle className="spin" size={15} /><span>{demo ? 'Getting the example GIFs from the demo page…' : 'Getting your GIFs from Steam Artwork Studio…'}</span></div>;
  }
  if (state.status === 'error') {
    return <div className="handoff-notice is-error" role="alert"><TriangleAlert size={15} /><span>{state.message} <a href={demo ? DEMO_ARTWORK_URL : ARTWORK_STUDIO_URL}>{demo ? 'Open the demo page' : 'Open Steam Artwork Studio'}</a></span></div>;
  }
  const count = state.artwork.files.length;
  const files = `${count} ${count === 1 ? 'file' : 'files'}`;
  if (state.status === 'applied') {
    return (
      <div className="handoff-notice is-done" role="status">
        <Check size={15} />
        <span>
          Placed {files} from {origin} in <strong>{state.showcaseTitle}</strong>.
          {demo ? ' This is an example: make your own in Steam Artwork Studio.' : ' This is only a preview: upload the files from the Studio to Steam yourself.'}
        </span>
      </div>
    );
  }
  return (
    <div className="handoff-notice" role="status">
      <Images size={15} />
      <span>
        {files} from {origin} ({describePreset(state.artwork)}{state.artwork.sourceName ? `, ${state.artwork.sourceName}` : ''}).
        {hasProfile ? ' Placing them in your showcase…' : ' Load your public profile, or resume a draft, to see them on it.'}
        {state.note ? ` ${state.note}` : ''}
      </span>
    </div>
  );
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <p>
        SteamCanvas by <a href="https://github.com/dumbapplee" target="_blank" rel="noreferrer">dumbapplee</a>, modified by <a href="https://github.com/lannahirave" target="_blank" rel="noreferrer">lannahirave</a> to work with <a href={ARTWORK_STUDIO_URL}>Steam Artwork Studio</a>.
        {' '}Licensed under the <a href={`${sourceCodeUrl}/LICENSE`} target="_blank" rel="noreferrer">GNU AGPL v3.0</a>.
        {' '}<a href={sourceCodeUrl} target="_blank" rel="noreferrer">Source code of this version</a> · <a href={upstreamRepositoryUrl} target="_blank" rel="noreferrer">Original project</a>
      </p>
      <p>Unofficial tool, not affiliated with or endorsed by Valve. Steam and the Steam logo are trademarks of Valve Corporation. Profile content belongs to its owners.</p>
    </footer>
  );
}

type ProfilePreview = {
  name: string;
  url: string;
  html: string;
  avatar?: string;
  level?: number;
};

const mosaicLayouts = [
  {
    columns: '1.4fr 1fr .8fr',
    order: ['a', 'b', 'c', 'd', 'e', 'f'],
  },
  {
    columns: '.8fr 1.4fr 1fr',
    order: ['b', 'c', 'a', 'e', 'f', 'd'],
  },
  {
    columns: '1fr .8fr 1.4fr',
    order: ['c', 'a', 'b', 'f', 'd', 'e'],
  },
];

type ProjectDraft = {
  format: 'steamcanvas-project';
  version: 1;
  profileIdentifier: string;
  showcaseAreaHtml: string;
  removedShowcases?: RemovedShowcase[];
  settings: {
    avatarEdit: AvatarEditState;
    avatarFrame: SteamAvatarFrame | null;
    background: SteamBackground | null;
    backgroundSize?: ProfileBackgroundSize;
    profileTheme: AppliedProfileTheme | null;
    previewLevel: number;
  };
};

type SavedSession = { sessionId: string | null; draft: ProjectDraft };
type SessionMeta = { sessionId: string; updatedAt: number; profileIdentifier: string };

const projectDatabaseName = 'steamcanvas-projects';
const projectStoreName = 'drafts';
const sessionStoreName = 'sessions';
// Drafts saved before sessions existed live under this key; they are read once and then replaced.
const legacyAutosaveKey = 'autosave';
// Drafts hold the showcase images as data URLs, so only the most recent sessions are kept.
const maxSavedSessions = 12;
const sessionIdPattern = /^[A-Za-z0-9_-]{12,64}$/;
let projectDatabase: Promise<IDBDatabase> | null = null;

const changelogSeenKey = 'steamcanvas-changelog-seen';

function readChangelogSeen(): string | null {
  try {
    return localStorage.getItem(changelogSeenKey);
  } catch {
    return null;
  }
}

const changelogEntries = [
  {
    date: '2026-11-02',
    displayDate: 'November 2, 2026',
    category: 'TRANSPARENT BACKGROUND',
    title: 'Showcases that blend into your background',
    details: [
      'Crop the profile background behind Artwork, Featured Artwork, Screenshot, and Workshop showcases with one click, then drag the preview to set the height.',
      'Choose Full size or Original size for your background, and the crop follows that choice; empty areas are filled with black.',
    ],
  },
  {
    date: '2026-10-09',
    displayDate: 'October 9, 2026',
    category: 'WORKSHOP',
    title: 'More room for Workshop artwork',
    details: [
      'Choose the default 1 × 5 layout or use an upgraded 2 × 5 showcase with one image per row.',
      'Export Workshop images ready for Steam upload, plus a local HTML preview with linked image assets.',
    ],
  },
  {
    date: '2026-10-08',
    displayDate: 'October 8, 2026',
    category: 'PROFILE CUSTOMIZATION',
    title: 'More profile styles to explore',
    details: [
      'Browse Steam profile themes, avatar frames, and animated backgrounds.',
      'Catalog loading, caching, and retry handling make large Steam collections easier to explore.',
    ],
  },
  {
    date: '2026-10-02',
    displayDate: 'October 2, 2026',
    category: 'PREVIEW RELIABILITY',
    title: 'Smoother profile previews',
    details: [
      'Preview animated profile backgrounds without video controls covering the artwork.',
      'Steam requests use throttling and retry handling to cope better with rate limits.',
    ],
  },
  {
    date: '2026-10-01',
    displayDate: 'October 1, 2026',
    category: 'SHOWCASE EDITOR',
    title: 'Arrange, edit, and restore showcases',
    details: [
      'Add, reorder, remove, and restore Artwork, Featured Artwork, Screenshot, and Workshop showcases.',
      'Split artwork into Steam-sized panels, choose public screenshots, and download showcase assets as ZIPs.',
    ],
  },
  {
    date: '2026-09-30',
    displayDate: 'September 30, 2026',
    category: 'THE FIRST PREVIEW',
    title: 'Start with a public Steam profile',
    details: [
      'Load a profile by custom URL, SteamID64, or profile link and preview changes before making them.',
      'Try avatar and background changes in SteamCanvas; the preview does not modify your Steam account.',
    ],
  },
] as const;

const storageBlockedMessage = 'Another SteamCanvas tab is still open with an older version and is holding your saved drafts. Close the other SteamCanvas tabs, then reload this page.';

function openProjectDatabase(): Promise<IDBDatabase> {
  if (!projectDatabase) {
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let settled = false;
      const request = indexedDB.open(projectDatabaseName, 2);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(projectStoreName)) database.createObjectStore(projectStoreName);
        if (!database.objectStoreNames.contains(sessionStoreName)) database.createObjectStore(sessionStoreName, { keyPath: 'sessionId' });
      };
      request.onsuccess = () => {
        const database = request.result;
        // Step aside when a newer SteamCanvas in another tab needs to upgrade the database.
        database.onversionchange = () => {
          database.close();
          if (projectDatabase === opening) projectDatabase = null;
        };
        if (settled) {
          database.close();
          return;
        }
        settled = true;
        resolve(database);
      };
      request.onerror = () => {
        settled = true;
        reject(request.error || new Error('Could not open local project storage.'));
      };
      // An open tab with the previous version keeps its connection, so the upgrade would wait forever.
      // Only the first waiting request gets a blocked event; later ones (after a reload) just wait, so
      // a timeout reports it too. Opening normally takes a few milliseconds.
      const fail = () => {
        if (settled) return;
        settled = true;
        reject(new Error(storageBlockedMessage));
      };
      request.onblocked = fail;
      globalThis.setTimeout(fail, 4000);
    });
    projectDatabase = opening;
    opening.catch(() => {
      if (projectDatabase === opening) projectDatabase = null;
    });
  }
  return projectDatabase;
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Local project storage failed.'));
  });
}

// Same as index.html. The Worker swaps these for a guide's title on /guides/<slug>, so they
// are put back when that guide closes.
const editorTitle = 'SteamCanvas — Steam profile preview for Steam Artwork Studio';
const editorDescription = 'Preview your real Steam profile with new artwork, showcases, avatar, frame, background and theme before changing anything on Steam. Place GIFs from Steam Artwork Studio straight into Artwork, Featured Artwork, Screenshot and Workshop showcases. Free, no ads, saves drafts in your browser.';

function createSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function readUrlParam(name: string): string | null {
  return new URLSearchParams(globalThis.location.search).get(name);
}

/** Changes the query string without adding a history entry, so a reload opens the same session. */
function updateUrlParams(changes: Record<string, string | null>): void {
  const url = new URL(globalThis.location.href);
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) url.searchParams.delete(name);
    else url.searchParams.set(name, value);
  }
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (next !== `${globalThis.location.pathname}${globalThis.location.search}${globalThis.location.hash}`) {
    globalThis.history.replaceState(globalThis.history.state, '', next);
  }
}

function readSessionIdFromUrl(): string | null {
  const id = readUrlParam('session');
  return id && sessionIdPattern.test(id) ? id : null;
}

async function readSessionDraft(sessionId: string): Promise<ProjectDraft | null> {
  const database = await openProjectDatabase();
  const draft = await idbRequest(database.transaction(projectStoreName, 'readonly').objectStore(projectStoreName).get(sessionId));
  return isProjectDraft(draft) ? draft : null;
}

/** The most recently saved session, or a draft saved before sessions existed. */
async function readLatestDraft(): Promise<SavedSession | null> {
  const database = await openProjectDatabase();
  const transaction = database.transaction([projectStoreName, sessionStoreName], 'readonly');
  const sessions = await idbRequest(transaction.objectStore(sessionStoreName).getAll()) as SessionMeta[];
  const latest = sessions.sort((left, right) => right.updatedAt - left.updatedAt)[0];
  const key = latest ? latest.sessionId : legacyAutosaveKey;
  const draft = await idbRequest(transaction.objectStore(projectStoreName).get(key));
  return isProjectDraft(draft) ? { sessionId: latest ? latest.sessionId : null, draft } : null;
}

async function writeSessionDraft(sessionId: string, draft: ProjectDraft): Promise<void> {
  const database = await openProjectDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([projectStoreName, sessionStoreName], 'readwrite');
    const drafts = transaction.objectStore(projectStoreName);
    const sessions = transaction.objectStore(sessionStoreName);
    drafts.put(draft, sessionId);
    drafts.delete(legacyAutosaveKey);
    sessions.put({ sessionId, updatedAt: Date.now(), profileIdentifier: draft.profileIdentifier } satisfies SessionMeta);
    const all = sessions.getAll();
    all.onsuccess = () => {
      const stale = (all.result as SessionMeta[]).sort((left, right) => right.updatedAt - left.updatedAt).slice(maxSavedSessions);
      for (const session of stale) {
        drafts.delete(session.sessionId);
        sessions.delete(session.sessionId);
      }
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Could not save the project locally.'));
    transaction.onabort = () => reject(transaction.error || new Error('Could not save the project locally.'));
  });
}

// Autosave diagnostics. On in dev; elsewhere run localStorage.setItem('steamcanvas:debugAutosave', '1') and reload.
const autosaveDebug = (() => {
  try {
    return import.meta.env.DEV || globalThis.localStorage?.getItem('steamcanvas:debugAutosave') === '1';
  } catch {
    return false;
  }
})();

function describeNode(node: Node | null): string {
  if (!node) return '(null)';
  if (!(node instanceof Element) && node.nodeType !== Node.ELEMENT_NODE) return node.nodeName;
  const element = node as Element;
  const classes = [...element.classList].slice(0, 3).map((name) => `.${name}`).join('');
  const controls = element.closest('[data-steamcanvas-showcase-controls]');
  return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${classes}${controls ? ` [in controls host "${controls.getAttribute('data-steamcanvas-showcase-controls')}"]` : ''}`;
}

function describeMutation(record: MutationRecord): string {
  if (record.type === 'attributes') {
    const now = (record.target as Element).getAttribute?.(record.attributeName || '') ?? null;
    const clip = (value: string | null) => (value && value.length > 80 ? `${value.slice(0, 80)}…` : value);
    return `attr ${record.attributeName} on ${describeNode(record.target)}: ${JSON.stringify(clip(record.oldValue))} -> ${JSON.stringify(clip(now))}`;
  }
  if (record.type === 'childList') {
    const names = (nodes: NodeList) => [...nodes].map(describeNode).join(', ');
    return `childList on ${describeNode(record.target)}: +[${names(record.addedNodes)}] -[${names(record.removedNodes)}]`;
  }
  return `characterData on ${describeNode(record.target.parentNode)}`;
}

/** Mutations that cannot change the saved draft: the editor's overlay hosts and the attributes serialization strips. */
const editorOnlyAttributes = new Set(['data-steamcanvas-showcase-controls', 'data-steamcanvas-showcase-id', 'data-steamcanvas-draggable', 'data-steamcanvas-dragging']);
function isEditorOnlyNode(node: Node): boolean {
  return node instanceof Element || node.nodeType === Node.ELEMENT_NODE
    ? !!(node as Element).closest('[data-steamcanvas-showcase-controls]')
    : !!node.parentElement?.closest('[data-steamcanvas-showcase-controls]');
}
function isEditorOnlyMutation(record: MutationRecord): boolean {
  if (isEditorOnlyNode(record.target)) return true;
  if (record.type === 'attributes') return editorOnlyAttributes.has(record.attributeName || '');
  if (record.type === 'childList') {
    const nodes = [...record.addedNodes, ...record.removedNodes];
    // Removed nodes are detached, so check the marker attribute directly.
    return nodes.length > 0 && nodes.every((node) => (node as Element).hasAttribute?.('data-steamcanvas-showcase-controls'));
  }
  return false;
}

function serializeShowcaseArea(document: Document): string {
  const area = document.querySelector<HTMLElement>('.profile_leftcol > .profile_customization_area');
  if (!area) return '';
  const copy = area.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[data-steamcanvas-showcase-controls], [data-steamcanvas-drag-placeholder], [data-steamcanvas-dragging="true"]').forEach((element) => element.remove());
  for (const element of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) {
    element.removeAttribute('data-steamcanvas-showcase-controls');
    element.removeAttribute('data-steamcanvas-showcase-id');
    element.removeAttribute('data-steamcanvas-draggable');
    element.removeAttribute('data-steamcanvas-dragging');
  }
  return copy.innerHTML;
}

function restoreShowcaseArea(document: Document, html: string): void {
  const area = ensureShowcaseArea(document);
  if (!area) return;
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('script, iframe, object, embed, form').forEach((element) => element.remove());
  template.content.querySelectorAll<HTMLElement>('*').forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || attribute.name === 'srcdoc') element.removeAttribute(attribute.name);
      if (/^(href|src|xlink:href)$/i.test(attribute.name) && /^\s*javascript:/i.test(attribute.value)) element.removeAttribute(attribute.name);
    }
  });
  area.replaceChildren(template.content.cloneNode(true));
}

function isProjectDraft(value: unknown): value is ProjectDraft {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Record<string, unknown>;
  const settings = draft.settings;
  if (!settings || typeof settings !== 'object') return false;
  const state = settings as Record<string, unknown>;
  const avatarEdit = state.avatarEdit;
  const frame = state.avatarFrame;
  const background = state.background;
  const theme = state.profileTheme;
  const avatarIsValid = !!avatarEdit && typeof avatarEdit === 'object'
    && ((avatarEdit as Record<string, unknown>).imageUrl === null || typeof (avatarEdit as Record<string, unknown>).imageUrl === 'string');
  const frameIsValid = frame === null || (!!frame && typeof frame === 'object'
    && typeof (frame as Record<string, unknown>).imageUrl === 'string'
    && ((frame as Record<string, unknown>).animatedImageUrl === undefined || typeof (frame as Record<string, unknown>).animatedImageUrl === 'string'));
  const backgroundIsValid = background === null || (!!background && typeof background === 'object'
    && typeof (background as Record<string, unknown>).imageUrl === 'string');
  const themeIsValid = theme === null || (!!theme && typeof theme === 'object'
    && !!(theme as Record<string, unknown>).variables
    && typeof (theme as Record<string, unknown>).variables === 'object'
    && Object.values((theme as { variables: Record<string, unknown> }).variables).every((item) => typeof item === 'string'));
  return draft.format === 'steamcanvas-project'
    && draft.version === 1
    && typeof draft.profileIdentifier === 'string'
    && typeof draft.showcaseAreaHtml === 'string'
    && (draft.removedShowcases === undefined || (Array.isArray(draft.removedShowcases) && draft.removedShowcases.every((item) => {
      if (!item || typeof item !== 'object') return false;
      const showcase = item as Record<string, unknown>;
      return typeof showcase.key === 'string' && typeof showcase.title === 'string'
        && typeof showcase.html === 'string' && Number.isInteger(showcase.index)
        && (showcase.beforeKey === null || typeof showcase.beforeKey === 'string')
        && (showcase.afterKey === null || typeof showcase.afterKey === 'string');
    })))
    && avatarIsValid
    && frameIsValid
    && backgroundIsValid
    && (state.backgroundSize === undefined || state.backgroundSize === 'full' || state.backgroundSize === 'original')
    && themeIsValid
    && Number.isFinite(state.previewLevel);
}

export default function App() {
  const [motionEnabled, setMotionEnabled] = useState(
    () => typeof window === 'undefined' || !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [motionLayout, setMotionLayout] = useState(0);
  const [identifier, setIdentifier] = useState('');
  const [profile, setProfile] = useState<ProfilePreview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [avatarEdit, setAvatarEdit] = useState<AvatarEditState>(DEFAULT_AVATAR_EDIT);
  const [avatarFrame, setAvatarFrame] = useState<SteamAvatarFrame | null>(null);
  const [background, setBackground] = useState<SteamBackground | null>(null);
  const [backgroundSize, setBackgroundSize] = useState<ProfileBackgroundSize>('full');
  const [profileTheme, setProfileTheme] = useState<AppliedProfileTheme | null>(null);
  const [previewLevel, setPreviewLevel] = useState(0);
  const [sourceBackgroundImage, setSourceBackgroundImage] = useState('');
  const [sourceBackgroundAnimated, setSourceBackgroundAnimated] = useState(false);
  const backgroundIsAnimated = background ? Boolean(background.animated) : sourceBackgroundAnimated;
  const [sourceAvatarFrameImage, setSourceAvatarFrameImage] = useState('');
  const [showcaseDocument, setShowcaseDocument] = useState<Document | null>(null);
  const [showcaseAddTarget, setShowcaseAddTarget] = useState<HTMLDivElement | null>(null);
  // /guides/<slug> links (bookmarks, search results) open the editor with that guide showing.
  const [guideSlug, setGuideSlug] = useState<string | null>(() => getGuideSlugForPath(globalThis.location.pathname));
  const [showcaseTrashTarget, setShowcaseTrashTarget] = useState<HTMLDivElement | null>(null);
  const [removedShowcases, setRemovedShowcases] = useState<RemovedShowcase[]>([]);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [projectStatus, setProjectStatus] = useState('Autosave ready');
  const [savedDraft, setSavedDraft] = useState<SavedSession | null>(null);
  const [restoringSession, setRestoringSession] = useState(() => readSessionIdFromUrl() !== null);
  const [handoff, setHandoff] = useState<HandoffState>(() => {
    if (isStudioId(readUrlParam('studio'))) return { status: 'loading', from: 'studio' };
    if (isDemoId(readUrlParam('demo'))) return { status: 'loading', from: 'demo' };
    return { status: 'none' };
  });
  // Identifies this editing session in the URL (?session=) and in local storage, so a reload restores it.
  const sessionIdRef = useRef<string | null>(null);
  // Autosave diagnostics (see autosaveDebug).
  // Last draft written (session id + JSON), so saves that would write the same thing are skipped.
  const lastSavedKeyRef = useRef<string | null>(null);
  const autosaveCountRef = useRef(0);
  const prevAutosaveDepsRef = useRef<Record<string, unknown> | null>(null);
  const previewFrame = useRef<HTMLIFrameElement>(null);
  const changelogDialog = useRef<HTMLDialogElement>(null);
  const [changelogSeen, setChangelogSeen] = useState(() => readChangelogSeen() === changelogEntries[0].date);
  const exportAssetsRef = useRef<(() => Promise<void>) | null>(null);
  const pendingDraft = useRef<ProjectDraft | null>(null);
  const identifierRef = useRef('');
  const sourceBackgroundStyle = useRef<string | null>(null);
  const sourceBackgroundVideo = useRef<HTMLElement | null>(null);
  const sourceAvatarFrame = useRef<HTMLElement | null>(null);
  const sourceBodyClass = useRef('');
  const sourceThemeVariables = useRef<Record<string, { value: string; priority: string }>>({});

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncMotionPreference = () => setMotionEnabled(!reducedMotion.matches);
    reducedMotion.addEventListener('change', syncMotionPreference);
    return () => reducedMotion.removeEventListener('change', syncMotionPreference);
  }, []);

  useEffect(() => {
    if (!motionEnabled || profile) return;

    const timer = window.setInterval(
      () => setMotionLayout((layout) => (layout + 1) % mosaicLayouts.length),
      2400,
    );

    return () => window.clearInterval(timer);
  }, [motionEnabled, profile]);

  // ?studio=<id>: Steam Artwork Studio sent a saved conversion to place on the profile.
  useEffect(() => {
    // Links from before the Library existed; their one-shot records are gone.
    if (readUrlParam('handoff')) updateUrlParams({ handoff: null });
    const id = readUrlParam('studio');
    const demoId = readUrlParam('demo');
    if (!isStudioId(id)) {
      if (id) updateUrlParams({ studio: null });
      if (!isDemoId(demoId)) {
        if (demoId) updateUrlParams({ demo: null });
        return;
      }
      // ?demo=<id>: an example from the demo page, kept in this browser after the first visit.
      let active = true;
      void loadDemoArtwork(demoId).then(({ artwork, saved }) => {
        if (!active) return;
        setHandoff({
          status: 'ready',
          from: 'demo',
          artwork,
          note: saved ? undefined : 'Your browser would not let SteamCanvas keep a copy, so this example needs the demo page next time.',
        });
      }).catch((caught: unknown) => {
        if (!active) return;
        if (caught instanceof DemoArtworkError && caught.reason !== 'network') updateUrlParams({ demo: null });
        setHandoff({ status: 'error', from: 'demo', message: caught instanceof Error ? caught.message : 'Could not get the example from the demo page.' });
      });
      return () => { active = false; };
    }
    let active = true;
    void getStudioArtwork(id).then((artwork) => {
      if (active) setHandoff({ status: 'ready', from: 'studio', artwork });
    }).catch((caught: unknown) => {
      if (!active) return;
      // Missing or unusable entries will not come back on a reload; a timeout might.
      if (caught instanceof LibraryError && caught.reason !== 'timeout') updateUrlParams({ studio: null });
      setHandoff({ status: 'error', from: 'studio', message: caught instanceof Error ? caught.message : 'Could not receive the GIFs from Steam Artwork Studio.' });
    });
    return () => { active = false; };
  }, []);

  function handleIncomingArtworkApplied(result: IncomingArtworkResult) {
    if (handoff.status !== 'ready') return;
    if (!result.ok) {
      setHandoff({ status: 'error', from: handoff.from, message: result.message });
      return;
    }
    // The session draft now holds the GIFs: a reload restores it instead of placing them again.
    updateUrlParams({ studio: null, demo: null });
    setHandoff({ status: 'applied', from: handoff.from, artwork: handoff.artwork, showcaseTitle: result.showcaseTitle });
  }

  const themeVariableNames = [
    '--gradient-right', '--gradient-left', '--gradient-background', '--gradient-background-right',
    '--gradient-background-left', '--color-showcase-header', '--gradient-showcase-header-left',
    '--btn-background', '--btn-background-hover', '--btn-outline',
  ];

  useEffect(() => {
    if (!profile || !previewLoaded) return;

    const frameDocument = previewFrame.current?.contentDocument;
    const picture = frameDocument?.querySelector<HTMLPictureElement>('.playerAvatarAutoSizeInner > picture');
    const image = picture?.querySelector('img');
    const imageSource = avatarEdit.imageUrl || profile.avatar;
    if (!picture || !image || !imageSource) return;

    picture.querySelectorAll('source').forEach((source) => source.removeAttribute('srcset'));
    image.removeAttribute('srcset');
    image.src = imageSource;
    picture.style.display = 'block';
    picture.style.width = '100%';
    picture.style.height = '100%';
    picture.style.overflow = 'hidden';
    picture.style.borderRadius = '0';
    image.style.width = '100%';
    image.style.height = '100%';
    image.style.objectFit = 'cover';
    image.style.borderRadius = '0';
    image.style.boxSizing = 'border-box';
    image.style.removeProperty('object-position');
    image.style.removeProperty('transform');
    image.style.removeProperty('transform-origin');
    image.style.removeProperty('border');
  }, [avatarEdit, previewLoaded, profile]);

  useEffect(() => {
    if (!profile || !previewLoaded) return;

    const avatarInner = previewFrame.current?.contentDocument?.querySelector<HTMLElement>('.playerAvatarAutoSizeInner');
    if (!avatarInner) return;
    avatarInner.querySelector('.profile_avatar_frame')?.remove();

    const frameElement = avatarFrame
      ? avatarInner.ownerDocument.createElement('div')
      : sourceAvatarFrame.current?.cloneNode(true) as HTMLElement | undefined;
    if (!frameElement) return;

    frameElement.classList.add('profile_avatar_frame');
    if (avatarFrame) {
      const picture = avatarInner.ownerDocument.createElement('picture');
      if (avatarFrame.animatedImageUrl) {
        const animatedSource = avatarInner.ownerDocument.createElement('source');
        animatedSource.media = '(prefers-reduced-motion: no-preference)';
        animatedSource.srcset = avatarFrame.animatedImageUrl;
        picture.append(animatedSource);
        const reducedMotionSource = avatarInner.ownerDocument.createElement('source');
        reducedMotionSource.media = '(prefers-reduced-motion: reduce)';
        reducedMotionSource.srcset = avatarFrame.imageUrl;
        picture.append(reducedMotionSource);
      }
      const image = avatarInner.ownerDocument.createElement('img');
      image.src = avatarFrame.imageUrl;
      image.alt = '';
      picture.append(image);
      frameElement.replaceChildren(picture);
    }
    avatarInner.insertBefore(frameElement, avatarInner.firstElementChild);
  }, [avatarFrame, previewLoaded, profile]);

  useEffect(() => {
    if (!profile || !previewLoaded) return;
    const level = previewFrame.current?.contentDocument?.querySelector<HTMLElement>('.profile_header_badgeinfo .friendPlayerLevelNum');
    if (level) level.textContent = String(previewLevel);
  }, [previewLevel, previewLoaded, profile]);

  useEffect(() => {
    if (!profile || !previewLoaded) return;
    const body = previewFrame.current?.contentDocument?.body;
    if (!body) return;

    body.className = sourceBodyClass.current;
    if (profileTheme) {
      for (const className of [...body.classList]) {
        if (className.endsWith('Theme')) body.classList.remove(className);
      }
      if (profileTheme.themeClass) body.classList.add(profileTheme.themeClass);
    }
    for (const property of themeVariableNames) {
      const value = profileTheme?.variables[property];
      if (value) {
        body.style.setProperty(property, value);
        continue;
      }
      const original = sourceThemeVariables.current[property];
      if (original?.value) body.style.setProperty(property, original.value, original.priority);
      else body.style.removeProperty(property);
    }
  }, [profileTheme, previewLoaded, profile]);

  useEffect(() => {
    if (!profile || !previewLoaded) return;

    const document = previewFrame.current?.contentDocument;
    if (!document) return;
    document.querySelectorAll('video').forEach((video) => {
      video.controls = false;
      video.removeAttribute('controls');
    });

    const page = document.querySelector<HTMLElement>('.no_header.profile_page');
    if (!page) return;
    page.querySelectorAll('.profile_animated_background').forEach((element) => element.remove());
    if (sourceBackgroundStyle.current !== null) {
      page.setAttribute('style', sourceBackgroundStyle.current);
    } else {
      page.removeAttribute('style');
    }

    if (background) {
      if (background.animated && (background.videoWebm || background.videoMp4)) {
        page.style.setProperty('background-image', 'none', 'important');
        const wrapper = page.ownerDocument.createElement('div');
        wrapper.className = 'profile_animated_background';
        wrapper.dataset.steamcanvasBackgroundVideo = 'true';

        const video = page.ownerDocument.createElement('video');
        video.autoplay = true;
        video.loop = true;
        video.muted = true;
        video.controls = false;
        video.playsInline = true;
        video.poster = background.videoPoster || background.imageUrl;
        video.setAttribute('aria-hidden', 'true');

        if (background.videoWebm) {
          const source = page.ownerDocument.createElement('source');
          source.src = background.videoWebm;
          source.type = 'video/webm';
          video.append(source);
        }
        if (background.videoMp4) {
          const source = page.ownerDocument.createElement('source');
          source.src = background.videoMp4;
          source.type = 'video/mp4';
          video.append(source);
        }

        wrapper.append(video);
        page.prepend(wrapper);
        void video.play().catch(() => {});
      } else {
        page.style.setProperty('background-image', `url("${background.imageUrl}")`, 'important');
      }
    } else if (sourceBackgroundVideo.current) {
      const originalBackground = sourceBackgroundVideo.current.cloneNode(true) as HTMLElement;
      originalBackground.querySelectorAll('video').forEach((video) => {
        video.autoplay = true;
        video.loop = true;
        video.muted = true;
        video.controls = false;
        video.removeAttribute('controls');
        video.playsInline = true;
        void video.play().catch(() => {});
      });
      page.prepend(originalBackground);
    }
    page.classList.toggle('full_width_background', backgroundIsAnimated || backgroundSize === 'full');
  }, [background, backgroundIsAnimated, backgroundSize, previewLoaded, profile]);

  /** Loads a profile. With a draft it restores that session; without one it starts a new session. */
  async function loadProfileByIdentifier(rawIdentifier: string, draft: ProjectDraft | null = null, sessionId: string | null = null) {
    const nextIdentifier = rawIdentifier.trim();
    if (!nextIdentifier || loading) return;
    const nextSessionId = sessionId || createSessionId();
    sessionIdRef.current = null;

    identifierRef.current = nextIdentifier;
    setIdentifier(nextIdentifier);
    setLoading(true);
    setError('');
    setProjectStatus(draft ? 'Restoring project' : 'Autosave ready');
    pendingDraft.current = draft;
    setProfile(null);
    setPreviewLoaded(false);
    setShowcaseDocument(null);
    setRemovedShowcases(draft?.removedShowcases || []);
    setAvatarEdit(draft?.settings.avatarEdit || DEFAULT_AVATAR_EDIT);
    setAvatarFrame(draft?.settings.avatarFrame || null);
    setBackground(draft?.settings.background || null);
    setBackgroundSize(draft?.settings.backgroundSize === 'original' ? 'original' : 'full');
    setProfileTheme(draft?.settings.profileTheme || null);
    setPreviewLevel(draft?.settings.previewLevel ?? 0);
    setSourceBackgroundImage('');
    setSourceAvatarFrameImage('');
    sourceBackgroundStyle.current = null;
    sourceBackgroundVideo.current = null;
    sourceAvatarFrame.current = null;
    sourceBodyClass.current = '';
    sourceThemeVariables.current = {};

    try {
      const response = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: nextIdentifier }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not load this profile.');
      const loadedProfile = result as ProfilePreview;
      sessionIdRef.current = nextSessionId;
      updateUrlParams({ session: nextSessionId });
      setProfile(loadedProfile);
      if (!draft) setPreviewLevel(loadedProfile.level ?? 0);
    } catch (caught) {
      pendingDraft.current = null;
      if (draft) setProjectStatus('Project restore failed');
      setError(caught instanceof Error ? caught.message : 'Something went wrong while loading the profile.');
    } finally {
      setLoading(false);
    }
  }

  async function loadProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await loadProfileByIdentifier(identifier);
  }

  function createProjectDraft(document: Document): ProjectDraft {
    if (!profile) throw new Error('Load a profile before exporting a project.');
    return {
      format: 'steamcanvas-project',
      version: 1,
      profileIdentifier: profile.url,
      showcaseAreaHtml: serializeShowcaseArea(document),
      removedShowcases,
      settings: { avatarEdit, avatarFrame, background, backgroundSize, profileTheme, previewLevel },
    };
  }

  async function exportProject() {
    try {
      if (!exportAssetsRef.current) throw new Error('Load a profile before exporting showcase artwork.');
      setProjectStatus('Preparing profile preview ZIP');
      await exportAssetsRef.current();
      setProjectStatus('Profile preview and artwork ZIP exported');
    } catch (caught) {
      setProjectStatus(caught instanceof Error ? caught.message : 'Profile preview ZIP export failed');
    }
  }

  /** Rebuilds the preview iframe from the current edits, for when it stops matching them. Nothing is discarded. */
  function reloadProfilePreview() {
    if (!profile || !previewLoaded || loading || !showcaseDocument) return;
    let draft: ProjectDraft;
    try {
      draft = createProjectDraft(showcaseDocument);
    } catch {
      setProjectStatus('Could not reload the preview');
      return;
    }
    // onLoad restores the showcases from this draft; the appearance effects reapply once previewLoaded is true again.
    pendingDraft.current = draft;
    setPreviewLoaded(false);
    setShowcaseDocument(null);
    setSourceBackgroundImage('');
    setSourceAvatarFrameImage('');
    sourceBackgroundStyle.current = null;
    sourceBackgroundVideo.current = null;
    sourceAvatarFrame.current = null;
    sourceBodyClass.current = '';
    sourceThemeVariables.current = {};
    setPreviewRevision((revision) => revision + 1);
  }

  function resetProfilePreview() {
    if (!profile || !previewLoaded || loading) return;
    const confirmed = globalThis.confirm('Reset this preview to the loaded Steam profile? All showcase edits and appearance changes will be discarded.');
    if (!confirmed) return;

    pendingDraft.current = null;
    setPreviewLoaded(false);
    setShowcaseDocument(null);
    setAvatarEdit(DEFAULT_AVATAR_EDIT);
    setAvatarFrame(null);
    setBackground(null);
    setBackgroundSize('full');
    setProfileTheme(null);
    setPreviewLevel(profile.level ?? 0);
    setRemovedShowcases([]);
    setSourceBackgroundImage('');
    setSourceAvatarFrameImage('');
    setProjectStatus('Resetting profile preview');
    sourceBackgroundStyle.current = null;
    sourceBackgroundVideo.current = null;
    sourceAvatarFrame.current = null;
    sourceBodyClass.current = '';
    sourceThemeVariables.current = {};
    setPreviewRevision((revision) => revision + 1);
  }

  useEffect(() => {
    let active = true;
    const offerLatestDraft = (status?: string) => readLatestDraft().then((latest) => {
      if (!active || identifierRef.current) return;
      setSavedDraft(latest);
      setProjectStatus(status || (latest ? 'Saved draft available' : 'Autosave ready'));
    });
    const sessionId = readSessionIdFromUrl();
    const restore = sessionId
      ? readSessionDraft(sessionId).then((draft) => {
        if (!active) return;
        setRestoringSession(false);
        if (draft) {
          void loadProfileByIdentifier(draft.profileIdentifier, draft, sessionId);
          return;
        }
        updateUrlParams({ session: null });
        setError('That editing session is not saved in this browser any more. Load a profile to start again.');
        return offerLatestDraft();
      })
      : offerLatestDraft();
    restore.catch((caught: unknown) => {
      if (!active) return;
      setRestoringSession(false);
      setProjectStatus('Local autosave unavailable');
      // Keep ?session= so a reload restores it once the storage is free again.
      if (sessionId) setError(caught instanceof Error && caught.message === storageBlockedMessage ? storageBlockedMessage : 'Could not open the saved drafts in this browser, so this session cannot be restored.');
    });
    return () => { active = false; };
  // Runs once on page load; loadProfileByIdentifier only reads state that is still initial here.
  }, []);

  useEffect(() => {
    if (!profile || !previewLoaded || !showcaseDocument) return;
    let timer: ReturnType<typeof globalThis.setTimeout>;
    // Diagnostics: why each save was scheduled, collected until the debounced save runs.
    let pendingReasons: string[] = [];
    let pendingMutationCount = 0;
    const saveDraft = (reason?: string) => {
      if (autosaveDebug && reason) pendingReasons.push(reason);
      globalThis.clearTimeout(timer);
      timer = globalThis.setTimeout(() => {
        try {
          const sessionId = sessionIdRef.current;
          if (!sessionId) return;
          const serializeStart = performance.now();
          const draft = createProjectDraft(showcaseDocument);
          // Only the serialized draft matters: skip the write (and the status flicker) when it is what we saved last.
          const key = `${sessionId}
${JSON.stringify(draft)}`;
          const unchanged = key === lastSavedKeyRef.current;
          const serializeMs = performance.now() - serializeStart;
          if (autosaveDebug) {
            console.groupCollapsed(
              `[autosave] save #${++autosaveCountRef.current}: ${pendingMutationCount} mutation(s), html ${(draft.showcaseAreaHtml.length / 1024).toFixed(1)} KB, serialize ${serializeMs.toFixed(1)} ms${unchanged ? ' — draft unchanged, write skipped' : ''}`,
            );
            const counts = new Map<string, number>();
            for (const line of pendingReasons) counts.set(line, (counts.get(line) || 0) + 1);
            for (const [line, count] of [...counts].slice(0, 40)) console.log(count > 1 ? `${count}× ${line}` : line);
            if (counts.size > 40) console.log(`…and ${counts.size - 40} more distinct reasons`);
            console.groupEnd();
          }
          pendingReasons = [];
          pendingMutationCount = 0;
          if (unchanged) return;
          lastSavedKeyRef.current = key;
          setProjectStatus('Saving draft');
          const writeStart = performance.now();
          void writeSessionDraft(sessionId, draft).then(() => {
            if (autosaveDebug) console.log(`[autosave] IndexedDB write ${(performance.now() - writeStart).toFixed(1)} ms`);
            setSavedDraft({ sessionId, draft });
            setProjectStatus('Draft saved locally');
          }).catch(() => {
            if (lastSavedKeyRef.current === key) lastSavedKeyRef.current = null;
            setProjectStatus('Autosave failed');
          });
        } catch {
          setProjectStatus('Autosave failed');
        }
      }, 700);
    };
    let observedArea = showcaseDocument.querySelector<HTMLElement>('.profile_leftcol > .profile_customization_area');
    let observer: MutationObserver;
    observer = new MutationObserver((allRecords) => {
      // The editor's own overlay (hover outline, buttons) lives inside the area but is never saved.
      const records = allRecords.filter((record) => !isEditorOnlyMutation(record));
      if (autosaveDebug && records.length < allRecords.length) {
        console.debug(`[autosave] ignored ${allRecords.length - records.length} editor-overlay mutation(s)`);
      }
      if (!records.length) return;
      if (autosaveDebug) {
        pendingMutationCount += records.length;
        for (const record of records) pendingReasons.push(describeMutation(record));
      }
      if (!observedArea) {
        observedArea = showcaseDocument.querySelector<HTMLElement>('.profile_leftcol > .profile_customization_area');
        if (observedArea) {
          observer.disconnect();
          observer.observe(observedArea, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: autosaveDebug });
        }
      }
      saveDraft();
    });
    if (observedArea) {
      observer.observe(observedArea, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: autosaveDebug });
    } else {
      observer.observe(showcaseDocument.documentElement, { subtree: true, childList: true });
    }
    if (autosaveDebug) {
      const deps = { profile, previewLoaded, showcaseDocument, avatarEdit, avatarFrame, background, profileTheme, previewLevel, removedShowcases };
      const previous = prevAutosaveDepsRef.current;
      const changed = previous ? Object.keys(deps).filter((key) => !Object.is(deps[key as keyof typeof deps], previous[key])) : ['(first run)'];
      prevAutosaveDepsRef.current = deps;
      saveDraft(`effect re-run, changed deps: ${changed.join(', ') || '(none)'}`);
    } else {
      saveDraft();
    }
    return () => {
      globalThis.clearTimeout(timer);
      observer.disconnect();
    };
  }, [profile, previewLoaded, showcaseDocument, avatarEdit, avatarFrame, background, backgroundSize, profileTheme, previewLevel, removedShowcases]);

  // Keep the address bar on the guide's own URL while a guide that was opened from one is showing,
  // and go back to the editor's URL when it closes, keeping the session in the query string.
  function changeGuide(slug: string) {
    setGuideSlug(slug);
    if (getGuideSlugForPath(globalThis.location.pathname)) {
      globalThis.history.replaceState(globalThis.history.state, '', `/guides/${slug}${globalThis.location.search}${globalThis.location.hash}`);
    }
  }

  function closeGuide() {
    setGuideSlug(null);
    if (getGuideSlugForPath(globalThis.location.pathname)) {
      globalThis.history.replaceState(globalThis.history.state, '', `/${globalThis.location.search}${globalThis.location.hash}`);
      document.title = editorTitle;
      document.querySelector('meta[name="description"]')?.setAttribute('content', editorDescription);
    }
  }

  // Profile scripts never run (the iframe sandbox has no allow-scripts), so the DOM is final once
  // parsed. Setting up then, not on the iframe's load event, keeps the editor from waiting for every
  // badge, game capsule and background video on Steam's CDN (8s+ on busy profiles, or never if one stalls).
  const initializedPreviewDocuments = useRef(new WeakSet<Document>());
  const initPreviewDocument = (document: Document | null | undefined) => {
    if (!document || initializedPreviewDocuments.current.has(document)) return;
    // Later calls must not re-read the "source" styles from a document the editor has already changed.
    initializedPreviewDocuments.current.add(document);
    const restoredDraft = pendingDraft.current;
    if (document && restoredDraft) {
      restoreShowcaseArea(document, restoredDraft.showcaseAreaHtml);
      pendingDraft.current = null;
    }
    if (document && !document.querySelector('#steamcanvas-hide-video-controls')) {
      const style = document.createElement('style');
      style.id = 'steamcanvas-hide-video-controls';
      style.textContent = 'video::-webkit-media-controls,video::-webkit-media-controls-enclosure{display:none!important}';
      document.head.append(style);
    }
    const page = previewFrame.current?.contentDocument?.querySelector<HTMLElement>('.no_header.profile_page');
    const animatedBackground = page?.querySelector<HTMLElement>('.profile_animated_background');
    const avatarFrameElement = previewFrame.current?.contentDocument?.querySelector<HTMLElement>('.playerAvatarAutoSizeInner .profile_avatar_frame');
    const avatarFrameImage = avatarFrameElement?.querySelector<HTMLImageElement>('img');
    const body = document?.body;
    sourceBodyClass.current = body?.className || '';
    sourceThemeVariables.current = Object.fromEntries(themeVariableNames.map((property) => [property, {
      value: body?.style.getPropertyValue(property) || '',
      priority: body?.style.getPropertyPriority(property) || '',
    }]));
    sourceBackgroundStyle.current = page?.getAttribute('style') ?? null;
    sourceBackgroundVideo.current = animatedBackground ? animatedBackground.cloneNode(true) as HTMLElement : null;
    sourceAvatarFrame.current = avatarFrameElement ? avatarFrameElement.cloneNode(true) as HTMLElement : null;
    const poster = animatedBackground?.querySelector<HTMLVideoElement>('video')?.poster;
    setSourceBackgroundImage(poster ? `url("${poster}")` : page ? getComputedStyle(page).backgroundImage : '');
    setSourceBackgroundAnimated(Boolean(animatedBackground));
    setSourceAvatarFrameImage(avatarFrameImage?.currentSrc || avatarFrameImage?.src || '');
    setShowcaseDocument(document || null);
    setPreviewLoaded(true);
  };

  useEffect(() => {
    if (!profile || previewLoaded) return;
    let frameId = 0;
    const poll = () => {
      const document = previewFrame.current?.contentDocument;
      // The initial about:blank document is swapped for the srcdoc one; wait for that and its parse.
      if (document && document.URL === 'about:srcdoc' && document.readyState !== 'loading' && document.querySelector('body')) {
        initPreviewDocument(document);
        return;
      }
      frameId = requestAnimationFrame(poll);
    };
    frameId = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(frameId);
  });

  return (
    <main className={`app-shell${profile ? ' has-profile' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <a className="brand-home" href="/" aria-label="SteamCanvas home">
            <span className="brand-mark"><PanelsTopLeft size={18} strokeWidth={2.1} /></span>
            <span>steam<span className="brand-light">canvas</span></span>
          </a>
          <span className="author-credit">by <a href="https://github.com/dumbapplee" target="_blank" rel="noreferrer">dumbapplee</a> and <a href="https://github.com/lannahirave" target="_blank" rel="noreferrer">lannahirave</a></span>
        </div>
        <nav className="topbar-actions" aria-label="Site navigation">
          <button className="topbar-link guide-trigger" type="button" aria-haspopup="dialog" onClick={() => setGuideSlug('featured-artwork')}>Guides</button>
          <button className="topbar-link changelog-trigger" type="button" aria-label="Open changelog" aria-haspopup="dialog" onClick={() => {
            changelogDialog.current?.showModal();
            if (changelogSeen) return;
            try {
              localStorage.setItem(changelogSeenKey, changelogEntries[0].date);
            } catch {
              // Storage can be unavailable; the dot will simply show again next visit.
            }
            setChangelogSeen(true);
          }}><History size={15} /><span>Changelog</span>{!changelogSeen && <i className="changelog-new-dot" aria-hidden="true" />}</button>
          <a className="topbar-link" href={ARTWORK_STUDIO_URL}><Images size={15} /> Artwork Studio</a>
          <a className="topbar-link" href={sourceCodeUrl} target="_blank" rel="noreferrer"><Github size={15} /> Source <ExternalLink size={12} /></a>
          <a className="topbar-link" href="https://buymeacoffee.com/migueelss" target="_blank" rel="noreferrer"><Coffee size={15} /> Support dumbapplee <ExternalLink size={12} /></a>
        </nav>
      </header>

      {!profile ? (
        <section className={`entry-screen${loading ? ' is-loading' : ''}`} aria-label="Load a Steam profile">
          <div className="entry-copy">
            <div className="entry-overline"><span className="entry-overline-dot" /> A LITTLE STUDIO FOR YOUR STEAM PROFILE</div>
            <h1>Your profile.<br /><em>Your style.</em></h1>
            <p className="entry-description">Switch up the avatar, art, colours and showcases. See what feels right on your real profile before you change a thing.</p>
            <form className="entry-form" onSubmit={loadProfile}>
              <label htmlFor="steam-identifier">Start with a public profile</label>
              <div className={`entry-input${error ? ' has-error' : ''}`}>
                <Search size={19} aria-hidden="true" />
                <input
                  id="steam-identifier"
                  value={identifier}
                  onChange={(event) => { identifierRef.current = event.target.value; setIdentifier(event.target.value); }}
                  placeholder="Profile URL, custom name or SteamID64"
                  autoComplete="url"
                  spellCheck={false}
                  autoFocus
                />
                <button className="entry-submit" type="submit" disabled={loading || !identifier.trim()} aria-label="Load profile">
                  {loading ? <LoaderCircle className="spin" size={20} /> : <ArrowUpRight size={21} />}
                </button>
              </div>
              {error ? <p className="entry-error" role="alert">{error}</p> : <p className="entry-hint"><ShieldCheck size={14} /> Public profiles only <span /> SteamID64, custom name, or profile URL</p>}
            </form>
            <HandoffNotice state={handoff} hasProfile={false} />
            <div className="entry-actions">
              {savedDraft && !restoringSession && <button className="entry-resume" type="button" onClick={() => void loadProfileByIdentifier(savedDraft.draft.profileIdentifier, savedDraft.draft, savedDraft.sessionId)} disabled={loading}><PanelsTopLeft size={15} /> Resume saved draft</button>}
              {(loading || restoringSession) && <span className="entry-loading"><LoaderCircle className="spin" size={13} /> {restoringSession || pendingDraft.current ? 'Restoring your session' : 'Fetching profile'}</span>}
            </div>
          </div>

          <aside className="entry-tools" aria-label="Profile editor features">
            <div className="entry-tools-heading">
              <span>The toolkit</span>
              <button
                className="entry-motion-toggle"
                type="button"
                aria-label={motionEnabled ? 'Pause shape animation' : 'Play shape animation'}
                aria-pressed={motionEnabled}
                onClick={() => setMotionEnabled((enabled) => !enabled)}
              >
                {motionEnabled ? <Pause size={12} /> : <Play size={12} />}
                {motionEnabled ? 'Pause motion' : 'Play motion'}
              </button>
            </div>
            <div className="entry-tools-intro">
              <strong>One small tweak.<br />A whole new vibe.</strong>
              <span>Play with the details until they feel right.</span>
            </div>
            <div className={`entry-motion${motionEnabled ? ' is-playing' : ''}`} aria-hidden="true">
              <div
                className="motion-stage"
                style={{ gridTemplateColumns: mosaicLayouts[motionLayout].columns }}
              >
                {mosaicLayouts[motionLayout].order.map((piece) => (
                  <span
                    className={`mosaic-piece piece-${piece}`}
                    data-piece={piece}
                    key={piece}
                  />
                ))}
              </div>
            </div>
            <div className="entry-tools-list">
              <div className="entry-tool">
                <span className="entry-tool-index">01</span>
                <span className="entry-tool-copy"><strong>Avatar &amp; frame</strong><small>Get the crop and frame in sync</small></span>
                <span className="entry-tool-mark entry-tool-avatar" aria-hidden="true" />
              </div>
              <div className="entry-tool">
                <span className="entry-tool-index">02</span>
                <span className="entry-tool-copy"><strong>Profile theme</strong><small>Pick a colour mood for your page</small></span>
                <span className="entry-tool-swatches" aria-hidden="true"><i /><i /><i /></span>
              </div>
              <div className="entry-tool">
                <span className="entry-tool-index">03</span>
                <span className="entry-tool-copy"><strong>Background</strong><small>Find art that pulls it all together</small></span>
                <span className="entry-tool-mark entry-tool-background" aria-hidden="true" />
              </div>
              <div className="entry-tool">
                <span className="entry-tool-index">04</span>
                <span className="entry-tool-copy"><strong>Showcases</strong><small>Split one image across showcase panels</small></span>
                <span className="entry-tool-mark entry-tool-showcases" aria-hidden="true"><i /><i /><i /></span>
              </div>
            </div>
          </aside>
        </section>
      ) : (
      <section className="workspace workspace-arrive">
        <aside className="control-panel">
          <form className="profile-form" onSubmit={loadProfile}>
            <label htmlFor="steam-identifier">Steam profile</label>
            <div className={`input-wrap ${error ? 'has-error' : ''}`}>
              <Search size={17} aria-hidden="true" />
              <input
                id="steam-identifier"
                value={identifier}
                onChange={(event) => { identifierRef.current = event.target.value; setIdentifier(event.target.value); }}
                placeholder="ID, custom name or profile URL"
                autoComplete="url"
                spellCheck={false}
              />
              <button className="submit-button" type="submit" disabled={loading || !identifier.trim()} aria-label="Load profile">
                {loading ? <LoaderCircle className="spin" size={17} /> : <ArrowUpRight size={18} />}
              </button>
            </div>
            {error ? <p className="form-error" role="alert">{error}</p> : <p className="input-hint"><CircleHelp size={13} /> Accepts SteamID64, custom name, or full URL</p>}
          </form>
          <HandoffNotice state={handoff} hasProfile />

          <div className="source-block">
            <span className="source-label">Current source</span>
            {profile ? (
              <>
                <div className="source-identity">
                  {profile.avatar && <img src={profile.avatar} alt="" />}
                  <span>{profile.name}</span>
                  {profile.level !== undefined && <span className="source-level">LVL {profile.level}</span>}
                </div>
                <a className="source-url" href={profile.url} target="_blank" rel="noreferrer">
                  {profile.url.replace(/^https:\/\//, '')}<ExternalLink size={12} />
                </a>
              </>
            ) : <p className="source-empty">Waiting for a profile</p>}
          </div>

          {profile && (
            <>
              <section className="showcase-add-section" aria-label="Showcases">
                <span className="source-label">Showcases</span>
                <div className="showcase-add-slot" ref={setShowcaseAddTarget} />
              </section>
              <AvatarEditor sourceAvatar={profile.avatar} value={avatarEdit} onChange={setAvatarEdit} />
              <AvatarFramePicker sourceAvatar={avatarEdit.imageUrl || profile.avatar} sourceFrameImage={sourceAvatarFrameImage} value={avatarFrame} onChange={setAvatarFrame} />
              <ProfileThemePicker value={profileTheme} onApply={setProfileTheme} />
              <BackgroundPicker sourceBackgroundImage={sourceBackgroundImage} value={background} onChange={setBackground} backgroundSize={backgroundSize} onBackgroundSizeChange={setBackgroundSize} isAnimated={backgroundIsAnimated} />
            </>
          )}

        </aside>

        <section className="preview-area" aria-label="Steam profile preview">
          <div className="preview-toolbar">
            <div className="preview-toolbar-actions" role="group" aria-label="Preview actions">
              <span className="draft-status" role="status" aria-live="polite">{projectStatus === 'Draft saved locally' && <Check size={13} />}{projectStatus}</span>
              {profile && <button className="project-action" type="button" onClick={reloadProfilePreview} disabled={!previewLoaded || loading} title="Reload the preview from your current edits if it stops matching them. Nothing is discarded."><RefreshCw size={14} />Fix desync</button>}
              {profile && <button className="project-action project-reset-action" type="button" onClick={resetProfilePreview} disabled={!previewLoaded || loading} title="Discard all preview changes and restore the loaded profile"><RotateCcw size={14} />Reset</button>}
              <button className="project-action" type="button" onClick={() => void exportProject()} disabled={!profile || !previewLoaded} title="Download the profile preview HTML and uploaded showcase artwork as ZIP"><Download size={14} />Export</button>
              {profile && <a className="open-source" href={profile.url} target="_blank" rel="noreferrer">Open on Steam <ExternalLink size={13} /></a>}
            </div>
          </div>
          <div className={`preview-stage ${profile ? 'has-profile' : ''}`}>
            {profile ? (
              <iframe
                key={previewRevision}
                ref={previewFrame}
                className="steam-frame"
                title={`Steam profile preview for ${profile.name}`}
                sandbox="allow-same-origin"
                srcDoc={profile.html}
                onLoad={() => initPreviewDocument(previewFrame.current?.contentDocument)}
              />
            ) : (
              <div className="empty-canvas">
                <h2>No profile loaded</h2>
                <p>Enter a public Steam profile on the left to see its layout here.</p>
              </div>
            )}
            {loading && <div className="loading-cover"><LoaderCircle className="spin" size={24} /><span>Fetching profile?</span></div>}
                <ShowcaseEditor
                  previewDocument={showcaseDocument}
                  profileUrl={profile?.url || ''}
                  profileName={profile?.name || 'steamcanvas'}
                  backgroundImageUrl={background?.imageUrl || sourceBackgroundImage}
                  backgroundIsAnimated={backgroundIsAnimated}
                  backgroundSize={backgroundSize}
                  addControlTarget={showcaseAddTarget}
                  trashControlTarget={showcaseTrashTarget}
                  removedShowcases={removedShowcases}
                  onRemovedShowcasesChange={setRemovedShowcases}
                  exportAssetsRef={exportAssetsRef}
                  incomingArtwork={handoff.status === 'ready' ? handoff.artwork : null}
                  onIncomingArtworkApplied={handleIncomingArtworkApplied}
                />
                {profile && <div className="showcase-trash-slot" ref={setShowcaseTrashTarget} />}
          </div>
        </section>
      </section>
      )}
      <SiteFooter />
      <dialog
        ref={changelogDialog}
        className="changelog-dialog"
        aria-labelledby="changelog-title"
        onClick={(event) => { if (event.target === event.currentTarget) changelogDialog.current?.close(); }}
      >
        <section className="changelog-content">
          <header className="changelog-header">
            <div>
              <span className="changelog-kicker">STEAMCANVAS · CHANGELOG</span>
              <h2 id="changelog-title">What’s been happening</h2>
              <p>A short history of what’s been added to the profile studio.</p>
            </div>
            <button className="icon-button changelog-close" type="button" aria-label="Close changelog" onClick={() => changelogDialog.current?.close()}><X size={17} /></button>
          </header>
          <div className="changelog-list">
            {changelogEntries.map((entry) => <article className="changelog-entry" key={entry.date}>
              <div className="changelog-entry-meta"><time dateTime={entry.date}>{entry.displayDate}</time><span>{entry.category}</span></div>
              <h3>{entry.title}</h3>
              <ul>{entry.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>
            </article>)}
          </div>
          <footer className="changelog-footer">A retrospective of SteamCanvas updates, based on the project history.</footer>
        </section>
      </dialog>
      <GuideDialog slug={guideSlug} onSlugChange={changeGuide} onClose={closeGuide} />
    </main>
  );
}