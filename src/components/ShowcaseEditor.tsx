// Copyright (C) 2026 dumbapplee
// Modified by lannahirave, 2026: receive mode and a picker for GIFs saved in Steam Artwork Studio.
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ensureShowcaseArea } from '../utils/showcaseArea';
import type { IncomingArtwork } from '../utils/artworkStudioLibrary';
import StudioLibraryPicker from './StudioLibraryPicker';
import type { ProfileBackgroundSize } from './BackgroundPicker';
import { Camera, ChevronLeft, ChevronRight, Download, GripHorizontal, Hammer, ImagePlus, LoaderCircle, Pencil, Plus, RotateCcw, Search, Star, Trash2, X } from 'lucide-react';
import JSZip from 'jszip';
import { decompressFrames, parseGIF, type ParsedFrame } from 'gifuct-js';
import { applyPalette, GIFEncoder, quantize } from 'gifenc';

type ShowcaseKind = 'artwork' | 'featured-artwork' | 'screenshot' | 'workshop' | 'other';
type CreatableShowcaseKind = 'artwork' | 'featured-artwork' | 'screenshot' | 'workshop';

type ShowcaseEntry = {
	id: string;
	kind: ShowcaseKind;
	title: string;
	exportFiles?: Array<{ name: string; url: string }>;
	animatedArtwork?: { name: string; url: string };
	mosaicSources?: Array<{ startIndex: number; name: string; url: string }>;
	element: HTMLElement;
	host: HTMLElement;
};

export type RemovedShowcase = {
	key: string;
	title: string;
	html: string;
	index: number;
	beforeKey: string | null;
	afterKey: string | null;
};

type PublicScreenshot = { id: string; imageUrl: string; thumbnailUrl: string; fullImageUrl?: string; steamUrl: string; searchText?: string; appid?: number; aspectRatio?: number };
type EditorSource = File | PublicScreenshot;

type ShowcaseEditorProps = {
	previewDocument: Document | null;
	profileUrl: string;
	profileName: string;
	backgroundImageUrl: string;
	backgroundSize: ProfileBackgroundSize;
	addControlTarget: HTMLElement | null;
	trashControlTarget: HTMLElement | null;
	removedShowcases: RemovedShowcase[];
	onRemovedShowcasesChange: (showcases: RemovedShowcase[]) => void;
	exportAssetsRef: { current: (() => Promise<void>) | null };
	/** GIFs from Steam Artwork Studio to place once the profile preview is ready. */
	incomingArtwork?: IncomingArtwork | null;
	onIncomingArtworkApplied?: (result: IncomingArtworkResult) => void;
};

export type IncomingArtworkResult = { ok: true; showcaseTitle: string } | { ok: false; message: string };

type AnimatedMosaic = { width: number; height: number; mainWidth: number; panelWidths?: number[]; panelRegions?: Array<{ x: number; y: number; width: number; height: number }>; format: 'gif' | 'apng' };
type ArtworkMosaic = {
	images: string[];
	previewImages?: string[];
	panelDimensions?: Array<{ width: number; height: number }>;
	animated?: AnimatedMosaic;
	animatedRows?: Array<{ startIndex: number; file: File; mosaic: AnimatedMosaic }>;
};

type PreviewPanel = { src: string; width: number; height: number };

type ShowcasePointerGesture = {
	id: string;
	pointerId: number;
	x: number;
	y: number;
	offsetX: number;
	offsetY: number;
	moved: boolean;
	element: HTMLElement;
	placeholder: HTMLElement | null;
	ghost: HTMLElement | null;
	originalCssText: string;
	originalUserSelect: string;
};

type ImageInputMode = 'composite' | 'separate' | 'public' | 'workshop-rows' | 'workshop-custom';
type ArtworkLayout = 'main-side' | 'main-three-side';
const SIDE_PANEL_GAP = 13;
type WorkshopRows = 1 | 2 | 3;
type WorkshopUploadTarget = { kind: 'row' | 'panels'; index: number };
const DEFAULT_TRANSPARENT_HEIGHT = 284;

function getShowcaseOutputWidth(entry: ShowcaseEntry): number {
	return entry.kind === 'featured-artwork' || entry.kind === 'workshop' ? 630 : 606;
}

function getTransparentCropTarget(entry: ShowcaseEntry, row = 0): { left: number; top: number; scale: number } {
	const images = getShowcaseImages(entry.element, entry.kind);
	const image = entry.kind === 'workshop' ? images[row * 5] : images[0];
	const slot = entry.kind === 'workshop'
		? image?.closest<HTMLElement>('.workshop_showcase_mutiitem_ctn')
		: image?.closest<HTMLElement>('.screenshot_showcase_primary');
	const imageRect = image?.getBoundingClientRect();
	const slotRect = slot?.getBoundingClientRect();
	const rect = imageRect?.width && imageRect.height ? imageRect : slotRect;
	if (!rect || !rect.width) throw new Error('Could not locate the showcase image area.');
	const panelWidth = entry.kind === 'featured-artwork' ? 630 : entry.kind === 'workshop' ? 126 : 506;
	return { left: rect.left, top: rect.top, scale: rect.width / panelWidth };
}

function getShowcaseDisplayWidth(entry: ShowcaseEntry): number {
	return getTransparentCropTarget(entry).scale * getShowcaseOutputWidth(entry);
}

function applyTransparentCropPreviewHeight(entry: ShowcaseEntry, height: number): void {
	const images = getShowcaseImages(entry.element, entry.kind);
	if (!images.length) return;
	const scale = getShowcaseDisplayWidth(entry) / getShowcaseOutputWidth(entry);
	if (entry.kind === 'workshop') {
		const panelHeight = height * scale;
		images.forEach((image) => {
			image.style.height = `${panelHeight}px`;
			image.closest<HTMLAnchorElement>('a')?.style.setProperty('height', `${panelHeight}px`);
		});
		return;
	}
	if (entry.kind === 'featured-artwork') {
		images[0].style.height = `${height * scale}px`;
		images[0].closest<HTMLAnchorElement>('a')?.style.setProperty('height', `${height * scale}px`);
		return;
	}
	const sideCount = Math.max(1, images.length - 1);
	images[0].style.height = `${height * scale}px`;
	const sideHeight = Math.max(1, (height - SIDE_PANEL_GAP * (sideCount - 1)) / sideCount) * scale;
	images.slice(1).forEach((image) => {
		image.style.height = `${sideHeight}px`;
		image.closest<HTMLAnchorElement>('a')?.style.setProperty('height', `${sideHeight}px`);
	});
}
type TransparentResizeGesture = {
	entry: ShowcaseEntry;
	pointerId: number;
	startY: number;
	startHeight: number;
	outputWidth: number;
	displayWidth: number;
	handle: HTMLButtonElement;
};

function readImageFile(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read image.'));
		reader.onerror = () => reject(new Error('Could not read image.'));
		reader.readAsDataURL(file);
	});
}

function getBackgroundUrl(value: string): string | null {
	if (/^(https?:|data:|blob:|\/\/)/i.test(value.trim())) return value.trim();
	const matches = [...value.matchAll(/url\((["']?)(.*?)\1\)/gi)];
	return matches.at(-1)?.[2] || null;
}

function getBackgroundDimension(value: string, area: number, natural: number): number | null {
	if (value === 'auto') return null;
	if (value.endsWith('%')) return area * Number.parseFloat(value) / 100;
	if (value.endsWith('px')) return Number.parseFloat(value);
	return natural;
}

function getBackgroundPositionOffset(value: string, area: number, image: number, axis: 'x' | 'y'): number {
	const normalized = value.toLowerCase();
	const end = axis === 'x' ? 'right' : 'bottom';
	if (normalized === 'center') return (area - image) / 2;
	if (normalized === end) return area - image;
	if (normalized === 'left' || normalized === 'top') return 0;
	if (normalized.endsWith('%')) return (area - image) * Number.parseFloat(normalized) / 100;
	const offset = Number.parseFloat(normalized);
	return Number.isFinite(offset) ? (normalized.startsWith(end) ? area - image - offset : offset) : (area - image) / 2;
}

async function loadBackgroundImage(url: string): Promise<{ image: HTMLImageElement; cleanup: () => void }> {
	let sourceUrl = url;
	let cleanup = () => {};
	if (/^https?:/i.test(url)) {
		const response = await fetch(`/api/profile-background-image?${new URLSearchParams({ url })}`);
		if (!response.ok) {
			const result = await response.json().catch(() => null) as { error?: string } | null;
			throw new Error(result?.error || 'Could not load the profile background image from Steam.');
		}
		sourceUrl = URL.createObjectURL(await response.blob());
		cleanup = () => URL.revokeObjectURL(sourceUrl);
	}
	const image = new Image();
	image.src = sourceUrl;
	try {
		await image.decode();
	} catch {
		cleanup();
		throw new Error('Could not load the profile background image for cropping.');
	}
	if (!image.naturalWidth || !image.naturalHeight) {
		cleanup();
		throw new Error('The profile background image has no usable dimensions.');
	}
	return { image, cleanup };
}

async function createBackgroundCropFiles(
	entry: ShowcaseEntry,
	backgroundImageUrl: string,
	height: number,
	layout: ArtworkLayout,
	workshopRows: WorkshopRows,
): Promise<File[]> {
	const backgroundSource = await loadBackgroundImage(backgroundImageUrl);
	const image = backgroundSource.image;
	try {
	const document = entry.element.ownerDocument;
	const profilePage = document.querySelector<HTMLElement>('.no_header.profile_page')
		|| document.querySelector<HTMLElement>('.profile_page.full_width_background')
		|| document.querySelector<HTMLElement>('.profile_page');
	if (!profilePage) throw new Error('Could not locate the profile background area.');
	const view = document.defaultView;
	if (!view) throw new Error('Could not read the profile preview dimensions.');
	const backgroundStyle = view.getComputedStyle(profilePage);
	const backgroundSize = backgroundStyle.backgroundSize.split(/\s+/);
	const areaRect = profilePage.getBoundingClientRect();
	const backgroundAttachment = backgroundStyle.backgroundAttachment.split(',')[0].trim();
	const backgroundOrigin = backgroundStyle.backgroundOrigin.split(',')[0].trim();
	const borderLeft = backgroundOrigin === 'border-box' ? 0 : profilePage.clientLeft;
	const borderTop = backgroundOrigin === 'border-box' ? 0 : profilePage.clientTop;
	const areaLeft = backgroundAttachment === 'fixed' ? 0 : areaRect.left + borderLeft;
	const areaTop = backgroundAttachment === 'fixed' ? 0 : areaRect.top + borderTop;
	const areaWidth = backgroundAttachment === 'fixed'
		? view.innerWidth
		: backgroundOrigin === 'border-box' ? areaRect.width : profilePage.clientWidth || areaRect.width;
	const areaHeight = backgroundAttachment === 'fixed'
		? view.innerHeight
		: backgroundOrigin === 'border-box' ? areaRect.height : profilePage.clientHeight || areaRect.height;
	let backgroundWidth: number;
	let backgroundHeight: number;
	if (backgroundSize[0] === 'cover' || backgroundSize[0] === 'contain') {
		const scale = backgroundSize[0] === 'cover'
			? Math.max(areaWidth / image.naturalWidth, areaHeight / image.naturalHeight)
			: Math.min(areaWidth / image.naturalWidth, areaHeight / image.naturalHeight);
		backgroundWidth = image.naturalWidth * scale;
		backgroundHeight = image.naturalHeight * scale;
	} else {
		const width = getBackgroundDimension(backgroundSize[0] || 'auto', areaWidth, image.naturalWidth);
		const backgroundHeightValue = getBackgroundDimension(backgroundSize[1] || 'auto', areaHeight, image.naturalHeight);
		if (width === null && backgroundHeightValue === null) {
			backgroundWidth = image.naturalWidth;
			backgroundHeight = image.naturalHeight;
		} else if (width === null) {
			backgroundHeight = backgroundHeightValue as number;
			backgroundWidth = image.naturalWidth * backgroundHeight / image.naturalHeight;
		} else if (backgroundHeightValue === null) {
			backgroundWidth = width;
			backgroundHeight = image.naturalHeight * backgroundWidth / image.naturalWidth;
		} else {
			backgroundWidth = width;
			backgroundHeight = backgroundHeightValue;
		}
	}
	const position = backgroundStyle.backgroundPosition.split(/\s+/);
	const backgroundLeft = areaLeft + getBackgroundPositionOffset(position[0] || '50%', areaWidth, backgroundWidth, 'x');
	const backgroundTop = areaTop + getBackgroundPositionOffset(position[1] || '50%', areaHeight, backgroundHeight, 'y');
	const scaleX = backgroundWidth / image.naturalWidth;
	const scaleY = backgroundHeight / image.naturalHeight;

	type CropArea = { left: number; top: number; scale: number; outputWidth: number; outputHeight: number };
	let cropAreas: CropArea[];
	if (entry.kind === 'workshop') {
		ensureWorkshopSlots(entry, workshopRows * 5);
		setWorkshopShowcaseRows(entry, workshopRows);
		cropAreas = Array.from({ length: workshopRows * 5 }, (_, index) => {
			const target = getTransparentCropTarget(entry, Math.floor(index / 5));
			const image = getShowcaseImages(entry.element, entry.kind)[index];
			const panel = image?.getBoundingClientRect();
			const slot = image?.closest<HTMLElement>('.workshop_showcase_mutiitem_ctn')?.getBoundingClientRect();
			const left = panel?.width ? panel.left : slot?.left ?? target.left;
			const top = panel?.height ? panel.top : slot?.top ?? target.top;
			const scale = (panel?.width || slot?.width || 126 * target.scale) / 126;
			return { left, top, scale, outputWidth: 126, outputHeight: height };
		});
	} else {
		const panelCount = getMosaicPanelCount(entry.kind, layout);
		if (hasTwoPanelImageEditor(entry.kind)) {
			const rightColumn = entry.element.querySelector<HTMLElement>('.screenshot_showcase_rightcol');
			if (rightColumn) {
				const sideSlots = [...rightColumn.querySelectorAll<HTMLElement>('.screenshot_showcase_smallscreenshot.showcase_slot')];
				for (let index = sideSlots.length; index < panelCount - 1; index += 1) {
					rightColumn.insertBefore(makeImageSlot(document, 'screenshot_showcase_smallscreenshot showcase_slot', 100), rightColumn.querySelector('.screenshot_count'));
				}
			}
		}
		const images = getShowcaseImages(entry.element, entry.kind).slice(0, panelCount);
		if (images.length < panelCount) throw new Error('Could not locate all showcase image slots.');
		const sideCount = panelCount - 1;
		cropAreas = images.map((image, index) => {
			const outputWidth = index === 0 ? entry.kind === 'featured-artwork' ? 630 : 506 : 100;
			const outputHeight = index === 0 || !sideCount
				? height
				: Math.max(1, (height - SIDE_PANEL_GAP * (sideCount - 1)) / sideCount);
			const rect = image.getBoundingClientRect();
			const slotRect = image.closest<HTMLElement>('.screenshot_showcase_primary, .screenshot_showcase_smallscreenshot')?.getBoundingClientRect();
			const target = getTransparentCropTarget(entry);
			const left = rect.width ? rect.left : slotRect?.left || target.left;
			const top = rect.height ? rect.top : slotRect?.top || target.top;
			const scale = (rect.width || slotRect?.width || outputWidth * target.scale) / outputWidth;
			return { left, top, scale, outputWidth, outputHeight };
		});
	}

	return await Promise.all(cropAreas.map(async ({ left, top, scale, outputWidth, outputHeight }, index) => {
		if (!scale || !Number.isFinite(scale)) throw new Error('Could not determine the showcase image dimensions.');
		const output = document.createElement('canvas');
		output.width = outputWidth;
		output.height = outputHeight;
		const context = output.getContext('2d');
		if (!context) throw new Error('Could not prepare the background crop.');
		context.fillStyle = '#000';
		context.fillRect(0, 0, outputWidth, outputHeight);
		const sourceX = (left - backgroundLeft) / scaleX;
		const sourceY = (top - backgroundTop) / scaleY;
		const sourceWidth = outputWidth * scale / scaleX;
		const sourceHeight = outputHeight * scale / scaleY;
		const clippedLeft = Math.max(0, sourceX);
		const clippedTop = Math.max(0, sourceY);
		const clippedRight = Math.min(image.naturalWidth, sourceX + sourceWidth);
		const clippedBottom = Math.min(image.naturalHeight, sourceY + sourceHeight);
		if (clippedRight > clippedLeft && clippedBottom > clippedTop) {
			const destinationX = (clippedLeft - sourceX) * outputWidth / sourceWidth;
			const destinationY = (clippedTop - sourceY) * outputHeight / sourceHeight;
			const destinationWidth = (clippedRight - clippedLeft) * outputWidth / sourceWidth;
			const destinationHeight = (clippedBottom - clippedTop) * outputHeight / sourceHeight;
			context.drawImage(image, clippedLeft, clippedTop, clippedRight - clippedLeft, clippedBottom - clippedTop, destinationX, destinationY, destinationWidth, destinationHeight);
		}
		const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/png'));
		if (!blob) throw new Error('Could not encode the background crop.');
		const name = entry.kind === 'workshop'
			? `profile-background-row-${Math.floor(index / 5) + 1}-panel-${index % 5 + 1}.png`
			: `profile-background-${index === 0 ? 'main' : `side-${index}`}.png`;
		return new File([blob], name, { type: 'image/png' });
	}));
	} finally {
		backgroundSource.cleanup();
	}
}

function getImageExtension(file: File): string {
	const extension = file.name.match(/\.(png|jpe?g|webp|gif|apng|avif)$/i)?.[1]?.toLowerCase();
	return extension === 'jpeg' ? 'jpg' : extension || (file.type === 'image/gif' ? 'gif' : 'png');
}

function getShowcaseArea(document: Document | null, create = false): HTMLElement | null {
	const column = document?.querySelector<HTMLElement>('.profile_leftcol');
	if (!column || !document) return null;
	const existing = column.querySelector<HTMLElement>(':scope > .profile_customization_area');
	if (!create) return existing || null;
	return ensureShowcaseArea(document);
}

function classifyShowcase(element: HTMLElement): ShowcaseKind {
	if (element.querySelector('.myworkshop_showcase')) return 'workshop';
	if (element.classList.contains('myscreenshots')) return 'screenshot';
	if (!element.classList.contains('myart')) return 'other';
	return element.querySelector('.screenshot_showcase_primary.single') ? 'featured-artwork' : 'artwork';
}

// Steam's like/comment icons live inside .screenshot_showcase_primary too, so they must be excluded from artwork images.
const SHOWCASE_ARTWORK_IMAGE_SELECTOR = '.screenshot_showcase_primary img:not(.screenshot_showcase_staticon), .screenshot_showcase_smallscreenshot.showcase_slot img';

function getShowcaseImages(element: HTMLElement, kind: ShowcaseKind): HTMLImageElement[] {
	const selector = kind === 'workshop'
		? '.myworkshop_showcase .workshop_showcase_item_image'
		: SHOWCASE_ARTWORK_IMAGE_SELECTOR;
	return [...element.querySelectorAll<HTMLImageElement>(selector)];
}

function getWorkshopShowcaseRows(entry: ShowcaseEntry): WorkshopRows {
	if (entry.kind !== 'workshop') return 1;
	const images = getShowcaseImages(entry.element, entry.kind);
	if (images.length < 10) return 1;

	const savedRows = entry.element.dataset.steamcanvasWorkshopRows;
	if (savedRows === '1') return 1;
	if (savedRows === '2') return 2;
	if (savedRows === '3' && images.length >= 15) return 3;

	const hasPublishedItemInRow = (row: number) => images.slice(row * 5, row * 5 + 5).some((image) => {
		const slot = image.closest<HTMLElement>('.workshop_showcase_mutiitem_ctn');
		const link = slot?.querySelector<HTMLAnchorElement>('a[href]');
		if (!link) return false;
		const itemUrl = new URL(link.href, link.ownerDocument.baseURI);
		return /\/sharedfiles\/filedetails\/?$/i.test(itemUrl.pathname)
			&& /^\d+$/.test(itemUrl.searchParams.get('id') || '');
	});
	if (images.length >= 15 && hasPublishedItemInRow(2)) return 3;
	return hasPublishedItemInRow(1) ? 2 : 1;
}

function setWorkshopShowcaseRows(entry: ShowcaseEntry, rows: WorkshopRows): void {
	if (entry.kind !== 'workshop') return;
	getShowcaseImages(entry.element, entry.kind).forEach((image, index) => {
		const slot = image.closest<HTMLElement>('.workshop_showcase_mutiitem_ctn');
		if (!slot) return;
		if (index < rows * 5) {
			if (slot.dataset.steamcanvasWorkshopHidden === 'true') {
				slot.style.display = slot.dataset.steamcanvasWorkshopOriginalDisplay || '';
				delete slot.dataset.steamcanvasWorkshopHidden;
				delete slot.dataset.steamcanvasWorkshopOriginalDisplay;
			}
			return;
		}
		if (slot.dataset.steamcanvasWorkshopHidden !== 'true') {
			slot.dataset.steamcanvasWorkshopOriginalDisplay = slot.style.display;
			slot.dataset.steamcanvasWorkshopHidden = 'true';
		}
		slot.style.display = 'none';
	});
}

function readUploadedAssets(element: HTMLElement, kind: ShowcaseKind, title: string): Array<{ name: string; url: string }> {
	const baseName = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'showcase-artwork';
	return getShowcaseImages(element, kind)
		.filter((image) => !image.closest('[data-steamcanvas-empty-slot]') && /^data:image\//i.test(image.currentSrc || image.src))
		.map((image, index) => {
			const url = image.currentSrc || image.src;
			const mime = url.match(/^data:image\/([^;,]+)/i)?.[1]?.toLowerCase() || 'png';
			const extension = mime === 'jpeg' ? 'jpg' : mime.split('+')[0];
			const suffix = kind === 'featured-artwork' ? '' : kind === 'workshop' ? `-${index + 1}` : `-${index === 0 ? 'main' : index === 1 ? 'side' : `side-${index}`}`;
			return { name: `${baseName}${suffix}.${extension}`, url };
		});
}

function hasTwoPanelImageEditor(kind: ShowcaseKind): boolean {
	return kind === 'artwork' || kind === 'screenshot';
}

function getMosaicPanelCount(kind: ShowcaseKind, layout: ArtworkLayout, workshopRows: WorkshopRows = 1): number {
	return kind === 'workshop' ? workshopRows * 5 : hasTwoPanelImageEditor(kind) ? layout === 'main-three-side' ? 4 : 2 : 1;
}

// Width of a received part, from the Studio's manifest when present, else from the file name order.
function incomingArtworkWidth(artwork: IncomingArtwork, file: File): number {
	return artwork.widths?.[artwork.files.indexOf(file)] ?? (artwork.files.length - artwork.files.indexOf(file));
}

function fitFeaturedImage(image: HTMLImageElement): void {
	image.style.display = 'block';
	image.style.width = '100%';
	image.style.maxWidth = '100%';
	image.style.height = 'auto';
	image.style.objectFit = 'contain';
}

function fitFeaturedArtwork(element: HTMLElement): void {
	element.querySelectorAll<HTMLImageElement>('.screenshot_showcase_primary.single img:not(.screenshot_showcase_staticon)').forEach(fitFeaturedImage);
}

function makeImageSlot(document: Document, className: string, maxWidth: number): HTMLElement {
	const slot = document.createElement('div');
	slot.className = className;
	slot.dataset.steamcanvasEmptySlot = 'true';
	const anchor = document.createElement('a');
	anchor.className = 'screenshot_showcase_screenshot modalContentLink';
	const image = document.createElement('img');
	image.alt = '';
	image.style.maxWidth = `${maxWidth}px`;
	image.style.width = '100%';
	image.style.minHeight = `${Math.round(maxWidth * 0.5625)}px`;
	image.style.background = 'linear-gradient(135deg, #263746, #4b6272)';
	image.src = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${maxWidth}" height="${Math.round(maxWidth * 0.5625)}" viewBox="0 0 ${maxWidth} ${Math.round(maxWidth * 0.5625)}"><rect width="100%" height="100%" fill="#344b5b"/></svg>`)}`;
	image.dataset.steamcanvasArtwork = 'true';
	anchor.append(image);
	slot.append(anchor);
	return slot;
}

function makeWorkshopSlot(document: Document): HTMLElement {
	const slot = document.createElement('div');
	slot.className = 'workshop_showcase_mutiitem_ctn';
	slot.dataset.steamcanvasEmptySlot = 'true';
	const innerSlot = document.createElement('div');
	innerSlot.className = 'workshop_showcase_multiitem showcase_slot';
	const anchor = document.createElement('a');
	anchor.className = 'ugc';
	anchor.href = '#';
	const image = document.createElement('img');
	image.className = 'workshop_showcase_item_image';
	image.alt = '';
	image.src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="126" height="84" viewBox="0 0 126 84"><rect width="126" height="84" fill="#344b5b"/></svg>')}`;
	anchor.append(image);
	innerSlot.append(anchor);
	slot.append(innerSlot);
	return slot;
}

// Lets users preview more rows than their showcase has slots for
function ensureWorkshopSlots(entry: ShowcaseEntry, count: number): void {
	if (entry.kind !== 'workshop') return;
	const slots = [...entry.element.querySelectorAll<HTMLElement>('.myworkshop_showcase .workshop_showcase_mutiitem_ctn')];
	let last = slots[slots.length - 1];
	for (let index = slots.length; last && index < count; index += 1) {
		const slot = makeWorkshopSlot(entry.element.ownerDocument);
		last.after(slot);
		last = slot;
	}
}

function makeArtworkShowcase(document: Document, kind: 'artwork' | 'featured-artwork'): HTMLElement {
	const featured = kind === 'featured-artwork';
	const showcase = document.createElement('div');
	showcase.className = 'profile_customization myart';
	showcase.dataset.steamcanvasNewShowcase = 'true';

	const header = document.createElement('div');
	header.className = 'profile_customization_header';
	header.textContent = featured ? 'Featured Artwork Showcase' : 'Artwork Showcase';
	const block = document.createElement('div');
	block.className = 'profile_customization_block';
	const content = document.createElement('div');
	content.className = 'screenshot_showcase';

	const primary = makeImageSlot(document, `screenshot_showcase_primary${featured ? ' single' : ''} showcase_slot`, featured ? 630 : 506);
	if (featured) {
		const title = document.createElement('div');
		title.className = 'screenshot_showcase_itemname';
		primary.append(title);
		const stats = document.createElement('div');
		stats.className = 'screenshot_showcase_stats';
		primary.append(stats);
	} else {
		content.append(primary);
		const right = document.createElement('div');
		right.className = 'screenshot_showcase_rightcol';
		for (let index = 0; index < 3; index += 1) {
			right.append(makeImageSlot(document, 'screenshot_showcase_smallscreenshot showcase_slot', 100));
		}
		content.append(right);
		const clear = document.createElement('div');
		clear.style.clear = 'both';
		content.append(clear);
	}

	if (featured) content.append(primary);
	block.append(content);
	showcase.append(header, block);
	return showcase;
}

function makeScreenshotShowcase(document: Document): HTMLElement {
	const showcase = document.createElement('div');
	showcase.className = 'profile_customization myscreenshots';
	showcase.dataset.steamcanvasNewShowcase = 'true';

	const header = document.createElement('div');
	header.className = 'profile_customization_header';
	header.textContent = 'Screenshot Showcase';
	const block = document.createElement('div');
	block.className = 'profile_customization_block';
	const content = document.createElement('div');
	content.className = 'screenshot_showcase';

	const primary = makeImageSlot(document, 'screenshot_showcase_primary showcase_slot', 506);
	const title = document.createElement('div');
	title.className = 'screenshot_showcase_itemname';
	const stats = document.createElement('div');
	stats.className = 'screenshot_showcase_stats';
	primary.append(title, stats);
	content.append(primary);

	const right = document.createElement('div');
	right.className = 'screenshot_showcase_rightcol';
	for (let index = 0; index < 3; index += 1) {
		right.append(makeImageSlot(document, 'screenshot_showcase_smallscreenshot showcase_slot', 100));
	}
	const screenshotCount = document.createElement('a');
	screenshotCount.className = 'screenshot_showcase_smallscreenshot screenshot_count';
	screenshotCount.href = '#';
	const countLabel = document.createElement('div');
	countLabel.className = 'screenshot_showcase_screenshot';
	countLabel.textContent = '+ 0';
	screenshotCount.append(countLabel);
	right.append(screenshotCount);
	content.append(right);

	const clear = document.createElement('div');
	clear.style.clear = 'both';
	content.append(clear);
	block.append(content);
	showcase.append(header, block);
	return showcase;
}

function makeWorkshopShowcase(document: Document): HTMLElement {
	const showcase = document.createElement('div');
	showcase.className = 'profile_customization';
	showcase.dataset.steamcanvasNewShowcase = 'true';

	const header = document.createElement('div');
	header.className = 'profile_customization_header';
	header.textContent = 'Workshop Showcase';
	const ownerHeader = document.createElement('div');
	ownerHeader.className = 'myworkshop_showcase_header';
	const avatar = document.createElement('div');
	avatar.className = 'playerAvatar offline';
	const avatarLink = document.createElement('a');
	avatarLink.href = '#';
	const avatarImage = document.createElement('img');
	avatarImage.src = document.querySelector<HTMLImageElement>('.playerAvatarAutoSizeInner > picture img')?.src || '';
	avatarImage.alt = '';
	avatarLink.append(avatarImage);
	avatar.append(avatarLink);
	const ownerName = document.createElement('a');
	ownerName.className = 'myworkshop_playerName';
	ownerName.href = '#';
	ownerName.textContent = `${document.querySelector<HTMLElement>('.actual_persona_name')?.textContent?.trim() || 'Steam user'}'s Workshop`;
	ownerHeader.append(avatar, ownerName);
	const block = document.createElement('div');
	block.className = 'profile_customization_block';
	const content = document.createElement('div');
	content.className = 'myworkshop_showcase';

	for (let index = 0; index < 5; index += 1) content.append(makeWorkshopSlot(document));

	const clear = document.createElement('div');
	clear.style.clear = 'left';
	const stats = document.createElement('div');
	stats.className = 'showcase_stats_row showcase_content_bg';
	for (const label of ['Submissions', 'Followers']) {
		const stat = document.createElement(label === 'Submissions' ? 'a' : 'div');
		stat.className = 'showcase_stat';
		if (label === 'Submissions') stat.setAttribute('href', '#');
		const value = document.createElement('div');
		value.className = 'value';
		value.textContent = '0';
		const statLabel = document.createElement('div');
		statLabel.className = 'label';
		statLabel.textContent = label;
		stat.append(value, statLabel);
		stats.append(stat);
	}
	content.append(clear, stats);
	block.append(content);
	showcase.append(header, ownerHeader, block);
	return showcase;
}

async function splitArtworkMosaic(file: File, layout: ArtworkLayout = 'main-side'): Promise<ArtworkMosaic> {
	const dataUrl = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read artwork image.'));
		reader.onerror = () => reject(new Error('Could not read artwork image.'));
		reader.readAsDataURL(file);
	});

	const image = new Image();
	image.src = dataUrl;
	await image.decode();

	const showcaseWidth = 606;
	const mainWidth = 506;
	const scale = showcaseWidth / image.naturalWidth;
	const compositeWidth = Math.max(6, Math.round(image.naturalWidth * scale));
	const compositeHeight = Math.max(1, Math.round(image.naturalHeight * scale));
	const outputMainWidth = Math.max(1, Math.round(compositeWidth * mainWidth / showcaseWidth));
	const sideWidth = Math.max(1, compositeWidth - outputMainWidth);
	const sideCount = layout === 'main-three-side' ? 3 : 1;
	// Steam stacks side tiles with a fixed vertical gap; tiles are cut from the side column skipping those gaps
	const sideGap = sideCount > 1 ? SIDE_PANEL_GAP : 0;
	const sideTilesHeight = Math.max(sideCount, compositeHeight - sideGap * (sideCount - 1));
	const sideHeightEdges = Array.from({ length: sideCount + 1 }, (_, index) => Math.floor(index * sideTilesHeight / sideCount));
	const panelRegions = [
		{ x: 0, y: 0, width: outputMainWidth, height: compositeHeight },
		...Array.from({ length: sideCount }, (_, index) => ({
			x: outputMainWidth,
			y: sideHeightEdges[index] + index * sideGap,
			width: sideWidth,
			height: Math.max(1, sideHeightEdges[index + 1] - sideHeightEdges[index]),
		})),
	];
	if (file.type === 'image/gif' || file.type === 'image/apng' || /\.(gif|apng)$/i.test(file.name)) {
		return {
			images: Array(panelRegions.length).fill(dataUrl),
			previewImages: cropImagePreview(image, compositeWidth, compositeHeight, panelRegions),
			panelDimensions: panelRegions.map(({ width, height }) => ({ width, height })),
			animated: {
				width: compositeWidth,
				height: compositeHeight,
				mainWidth: outputMainWidth,
				panelRegions,
				format: file.type === 'image/gif' || /\.gif$/i.test(file.name) ? 'gif' : 'apng',
			},
		};
	}

	const composite = document.createElement('canvas');
	composite.width = compositeWidth;
	composite.height = compositeHeight;
	const context = composite.getContext('2d');
	if (!context) throw new Error('Could not prepare the artwork mosaic.');
	context.drawImage(image, 0, 0, compositeWidth, compositeHeight);

	const extractTile = ({ x, y, width, height }: typeof panelRegions[number]) => {
		const tile = document.createElement('canvas');
		tile.width = width;
		tile.height = height;
		const tileContext = tile.getContext('2d');
		if (!tileContext) throw new Error('Could not prepare an artwork tile.');
		tileContext.drawImage(composite, x, y, width, height, 0, 0, width, height);
		return tile.toDataURL('image/png');
	};

	return {
		images: panelRegions.map(extractTile),
		panelDimensions: panelRegions.map(({ width, height }) => ({ width, height })),
	};
}

async function splitWorkshopMosaic(file: File): Promise<ArtworkMosaic> {
	const dataUrl = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read workshop image.'));
		reader.onerror = () => reject(new Error('Could not read workshop image.'));
		reader.readAsDataURL(file);
	});
	const image = new Image();
	image.src = dataUrl;
	await image.decode();

	const panelCount = 5;
	const width = 630;
	const height = Math.max(1, Math.round(image.naturalHeight * width / image.naturalWidth));
	const panelWidths = Array.from({ length: panelCount }, (_, index) => Math.floor((index + 1) * width / panelCount) - Math.floor(index * width / panelCount));
	const isGif = file.type === 'image/gif' || /\.gif$/i.test(file.name);
	const isApng = file.type === 'image/apng' || /\.apng$/i.test(file.name);
	if (isGif || isApng) {
		const panelRegions = panelWidths.map((panelWidth, index) => ({ x: panelWidths.slice(0, index).reduce((sum, size) => sum + size, 0), y: 0, width: panelWidth, height }));
		return { images: Array(panelCount).fill(dataUrl), previewImages: cropImagePreview(image, width, height, panelRegions), panelDimensions: panelWidths.map((panelWidth) => ({ width: panelWidth, height })), animated: { width, height, mainWidth: panelWidths[0], panelWidths, format: isGif ? 'gif' : 'apng' } };
	}

	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (!context) throw new Error('Could not prepare workshop image panels.');
	context.drawImage(image, 0, 0, width, height);

	const panels: string[] = [];
	let sourceX = 0;
	for (const panelWidth of panelWidths) {
		const panel = document.createElement('canvas');
		panel.width = panelWidth;
		panel.height = height;
		const panelContext = panel.getContext('2d');
		if (!panelContext) throw new Error('Could not prepare a workshop image panel.');
		panelContext.drawImage(canvas, sourceX, 0, panelWidth, height, 0, 0, panelWidth, height);
		panels.push(panel.toDataURL('image/png'));
		sourceX += panelWidth;
	}
	return { images: panels, panelDimensions: panelWidths.map((panelWidth) => ({ width: panelWidth, height })) };
}

async function splitWorkshopRows(files: File[]): Promise<ArtworkMosaic> {
	if (files.length < 2 || files.length > 3) throw new Error('Choose one image for each Workshop row.');
	const rows = await Promise.all(files.map(splitWorkshopMosaic));
	const animatedRows = rows.flatMap((row, index) => row.animated
		? [{ startIndex: index * 5, file: files[index], mosaic: row.animated }]
		: []);
	return {
		images: rows.flatMap((row) => row.images),
		previewImages: rows.flatMap((row) => row.previewImages || row.images),
		panelDimensions: rows.flatMap((row) => row.panelDimensions || []),
		...(animatedRows.length ? { animatedRows } : {}),
	};
}

function readBlobDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not export animated artwork.'));
		reader.onerror = () => reject(new Error('Could not export animated artwork.'));
		reader.readAsDataURL(blob);
	});
}

async function prepareWorkshopImageForLongUpload(blob: Blob): Promise<Blob> {
	const buffer = await blob.arrayBuffer();
	if (buffer.byteLength === 0) throw new Error('Could not prepare an empty image for Workshop upload.');
	new Uint8Array(buffer)[buffer.byteLength - 1] = 0x21;
	return new Blob([buffer], { type: blob.type });
}

async function encodeAnimatedMosaic(file: File, mosaic: NonNullable<ArtworkMosaic['animated']>): Promise<string[]> {
	const parsed = parseGIF(await file.arrayBuffer());
	const frames = decompressFrames(parsed, true);
	if (!frames.length) throw new Error('This GIF has no decodable frames.');

	const scale = mosaic.width / parsed.lsd.width;
	const mainCanvas = document.createElement('canvas');
	mainCanvas.width = mosaic.width;
	mainCanvas.height = mosaic.height;
	const mainContext = mainCanvas.getContext('2d', { willReadFrequently: true });
	if (!mainContext) throw new Error('Could not prepare animated artwork frames.');
	mainContext.imageSmoothingEnabled = false;

	const patchCanvas = document.createElement('canvas');
	const patchContext = patchCanvas.getContext('2d');
	if (!patchContext) throw new Error('Could not prepare animated artwork patches.');

	const panelRegions = mosaic.panelRegions || (mosaic.panelWidths || [mosaic.mainWidth, mosaic.width - mosaic.mainWidth]).map((width, index, widths) => ({
		x: widths.slice(0, index).reduce((total, value) => total + value, 0), y: 0, width, height: mosaic.height,
	}));
	const encoders = panelRegions.map((region) => GIFEncoder({ initialCapacity: Math.max(4096, region.width * region.height) }));
	const panelCanvases = panelRegions.map((region) => {
		const canvas = document.createElement('canvas');
		canvas.width = region.width;
		canvas.height = region.height;
		return canvas;
	});
	const panelContexts = panelCanvases.map((canvas) => canvas.getContext('2d', { willReadFrequently: true }));
	if (panelContexts.some((context) => !context)) throw new Error('Could not prepare animated mosaic panels.');

	const hasTransparency = frames.some((frame) => frame.transparentIndex >= 0);
	const backgroundColor = parsed.gct[parsed.lsd.backgroundColorIndex] || [255, 255, 255];
	if (!hasTransparency) {
		mainContext.fillStyle = `rgb(${backgroundColor[0]}, ${backgroundColor[1]}, ${backgroundColor[2]})`;
		mainContext.fillRect(0, 0, mosaic.width, mosaic.height);
	}

	let previousFrame: ParsedFrame | undefined;
	let restorePrevious: ImageData | undefined;
	function indexFrame(pixels: Uint8ClampedArray) {
		const transparent = pixels.some((_, index) => index % 4 === 3 && pixels[index] < 128);
		const maxOpaqueColors = transparent ? 255 : 256;
		const exactPalette: number[][] = [];
		const exactIndices = new Map<string, number>();
		let hasTooManyColors = false;
		for (let pixelOffset = 0; pixelOffset < pixels.length; pixelOffset += 4) {
			if (pixels[pixelOffset + 3] < 128) continue;
			const red = pixels[pixelOffset];
			const green = pixels[pixelOffset + 1];
			const blue = pixels[pixelOffset + 2];
			const key = `${red},${green},${blue}`;
			if (exactIndices.has(key)) continue;
			if (exactPalette.length === maxOpaqueColors) {
				hasTooManyColors = true;
				break;
			}
			exactIndices.set(key, exactPalette.length);
			exactPalette.push([red, green, blue]);
		}

		if (!hasTooManyColors) {
			const transparentIndex = transparent ? exactPalette.length : -1;
			const palette = transparent ? [...exactPalette, [0, 0, 0]] : exactPalette;
			const indexed = new Uint8Array(pixels.length / 4);
			for (let pixelOffset = 0; pixelOffset < pixels.length; pixelOffset += 4) {
				const index = pixelOffset / 4;
				if (pixels[pixelOffset + 3] < 128) {
					indexed[index] = transparentIndex;
				} else {
					indexed[index] = exactIndices.get(`${pixels[pixelOffset]},${pixels[pixelOffset + 1]},${pixels[pixelOffset + 2]}`) || 0;
				}
			}
			return { palette, indexed, transparentIndex };
		}

		const opaquePixels = new Uint8ClampedArray(pixels);
		for (let pixelOffset = 0; pixelOffset < opaquePixels.length; pixelOffset += 4) {
			if (opaquePixels[pixelOffset + 3] < 128) {
				opaquePixels[pixelOffset] = 0;
				opaquePixels[pixelOffset + 1] = 0;
				opaquePixels[pixelOffset + 2] = 0;
			}
			opaquePixels[pixelOffset + 3] = 255;
		}
		const opaquePalette = quantize(opaquePixels, maxOpaqueColors, { format: 'rgb565' });
		const indexed = applyPalette(opaquePixels, opaquePalette, 'rgb565');
		const transparentIndex = transparent ? opaquePalette.length : -1;
		if (transparent) {
			for (let pixelOffset = 0; pixelOffset < pixels.length; pixelOffset += 4) {
				if (pixels[pixelOffset + 3] < 128) indexed[pixelOffset / 4] = transparentIndex;
			}
		}
		return { palette: transparent ? [...opaquePalette, [0, 0, 0]] : opaquePalette, indexed, transparentIndex };
	}

	for (const [frameIndex, frame] of frames.entries()) {
		if (previousFrame?.disposalType === 2) {
			const { left, top, width, height } = previousFrame.dims;
			const x = Math.round(left * scale);
			const y = Math.round(top * scale);
			const w = Math.max(1, Math.round(width * scale));
			const h = Math.max(1, Math.round(height * scale));
			if (hasTransparency) mainContext.clearRect(x, y, w, h);
			else {
				mainContext.fillStyle = `rgb(${backgroundColor[0]}, ${backgroundColor[1]}, ${backgroundColor[2]})`;
				mainContext.fillRect(x, y, w, h);
			}
		} else if (previousFrame?.disposalType === 3 && restorePrevious) {
			mainContext.putImageData(restorePrevious, 0, 0);
		}

		const restoreCurrent = frame.disposalType === 3
			? mainContext.getImageData(0, 0, mosaic.width, mosaic.height)
			: undefined;
		patchCanvas.width = frame.dims.width;
		patchCanvas.height = frame.dims.height;
		const patchData = patchContext.createImageData(frame.dims.width, frame.dims.height);
		patchData.data.set(frame.patch);
		patchContext.putImageData(patchData, 0, 0);
		mainContext.drawImage(
			patchCanvas,
			Math.round(frame.dims.left * scale),
			Math.round(frame.dims.top * scale),
			Math.max(1, Math.round(frame.dims.width * scale)),
			Math.max(1, Math.round(frame.dims.height * scale)),
		);

		for (let panelIndex = 0; panelIndex < panelCanvases.length; panelIndex += 1) {
			const panelContext = panelContexts[panelIndex];
			if (!panelContext) continue;
			const region = panelRegions[panelIndex];
			panelContext.clearRect(0, 0, region.width, region.height);
			panelContext.drawImage(mainCanvas, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
			const pixels = panelContext.getImageData(0, 0, region.width, region.height).data;
			const { palette, indexed, transparentIndex } = indexFrame(pixels);
			encoders[panelIndex].writeFrame(indexed, region.width, region.height, {
				palette,
				delay: frame.delay || 100,
				...(frameIndex === 0 ? { repeat: 0 } : {}),
				transparent: transparentIndex >= 0,
				transparentIndex: Math.max(0, transparentIndex),
			});
		}

		previousFrame = frame;
		restorePrevious = restoreCurrent;
	}

	return Promise.all(encoders.map(async (encoder) => {
		encoder.finish();
		const encoded = encoder.bytes();
		const buffer = new ArrayBuffer(encoded.byteLength);
		new Uint8Array(buffer).set(encoded);
		return readBlobDataUrl(new Blob([buffer], { type: 'image/gif' }));
	}));
}

function isPublicScreenshot(source: EditorSource): source is PublicScreenshot {
	return 'imageUrl' in source;
}

function sourceName(source: EditorSource): string {
	return isPublicScreenshot(source) ? `Screenshot ${source.id}` : source.name;
}

export default function ShowcaseEditor({ previewDocument, profileUrl, profileName, backgroundImageUrl, backgroundSize, addControlTarget, trashControlTarget, removedShowcases, onRemovedShowcasesChange, exportAssetsRef, incomingArtwork = null, onIncomingArtworkApplied }: ShowcaseEditorProps) {
	const [entries, setEntries] = useState<ShowcaseEntry[]>([]);
	// The document the current entries were read from, so receive mode waits for the scan to finish.
	const [entriesDocument, setEntriesDocument] = useState<Document | null>(null);
	const appliedIncomingIdRef = useRef<string | null>(null);
	const [error, setError] = useState('');
	const [editingId, setEditingId] = useState<string | null>(null);
	const [imageInputMode, setImageInputMode] = useState<ImageInputMode>('composite');
	const [artworkLayout, setArtworkLayout] = useState<ArtworkLayout>('main-side');
	const [workshopRows, setWorkshopRows] = useState<WorkshopRows>(1);
	const [backgroundCropHeight, setBackgroundCropHeight] = useState(DEFAULT_TRANSPARENT_HEIGHT);
	const [workshopRowFiles, setWorkshopRowFiles] = useState<Array<File | null>>(() => Array(3).fill(null));
	const [workshopRowPreviews, setWorkshopRowPreviews] = useState<Array<string | null>>(() => Array(3).fill(null));
	const [workshopPanelFiles, setWorkshopPanelFiles] = useState<Array<File | null>>(() => Array(15).fill(null));
	const [editorFiles, setEditorFiles] = useState<Array<EditorSource | null>>([]);
	const [editorPreview, setEditorPreview] = useState<Array<PreviewPanel | null>>([]);
	const [uploadButtonPreview, setUploadButtonPreview] = useState<string | null>(null);
	const [editorLoading, setEditorLoading] = useState(false);
	const [editorProgress, setEditorProgress] = useState('');
	const [editorError, setEditorError] = useState('');
	const [publicScreenshots, setPublicScreenshots] = useState<PublicScreenshot[]>([]);
	const [publicScreenshotSearch, setPublicScreenshotSearch] = useState('');
	const [publicScreenshotPage, setPublicScreenshotPage] = useState(0);
	const [publicScreenshotExpanded, setPublicScreenshotExpanded] = useState(false);
	const [publicScreenshotsLoading, setPublicScreenshotsLoading] = useState(false);
	const [publicScreenshotNextPage, setPublicScreenshotNextPage] = useState(1);
	const [publicScreenshotHasMore, setPublicScreenshotHasMore] = useState(true);
	const [addingOpen, setAddingOpen] = useState(false);
	const [addDrawerLeft, setAddDrawerLeft] = useState<number | null>(null);
	const [addDrawerTop, setAddDrawerTop] = useState<number | null>(null);
	const [addControlHost, setAddControlHost] = useState<HTMLElement | null>(null);
	const [addMenuHost, setAddMenuHost] = useState<HTMLElement | null>(null);
	const [trashHost, setTrashHost] = useState<HTMLElement | null>(null);
	const [trashOpen, setTrashOpen] = useState(false);
	const [draggingShowcaseId, setDraggingShowcaseId] = useState<string | null>(null);
	const [dragTargetShowcaseId, setDragTargetShowcaseId] = useState<string | null>(null);
	const [hoveredShowcaseId, setHoveredShowcaseId] = useState<string | null>(null);
	const [exportingShowcaseId, setExportingShowcaseId] = useState<string | null>(null);
	const [showcaseExportError, setShowcaseExportError] = useState<{ id: string; message: string } | null>(null);
	const [backgroundResizingId, setBackgroundResizingId] = useState<string | null>(null);
	const editorDialogRef = useRef<HTMLDialogElement>(null);
	const workshopFileInputRef = useRef<HTMLInputElement>(null);
	const workshopUploadTargetRef = useRef<WorkshopUploadTarget | null>(null);
	const addMenuRef = useRef<HTMLElement>(null);
	const previewRequestId = useRef(0);
	const dragTargetRef = useRef<{ id: string | null; after: boolean }>({ id: null, after: false });
	const pointerGestureRef = useRef<ShowcasePointerGesture | null>(null);
	const transparentResizeRef = useRef<TransparentResizeGesture | null>(null);
	const backgroundResizeInProgressRef = useRef(false);
	const backgroundImageUrlRef = useRef(backgroundImageUrl);
	backgroundImageUrlRef.current = backgroundImageUrl;
	const suppressClickRef = useRef(false);

	function createOverlayHost(document: Document, parent: HTMLElement, name: string): HTMLElement {
		if (document.defaultView?.getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
		const host = document.createElement('div');
		host.dataset.steamcanvasShowcaseControls = name;
		host.style.cssText = 'position:absolute;inset:0;z-index:2147483000;display:block;pointer-events:none;';
		parent.append(host);
		return host;
	}

	useEffect(() => {
		const area = getShowcaseArea(previewDocument, true);
		if (!area) {
			setEntries([]);
			setEntriesDocument(null);
			setAddControlHost(null);
			return;
		}
		const dragStyle = previewDocument!.createElement('style');
		dragStyle.dataset.steamcanvasDragCursor = 'true';
		dragStyle.textContent = '[data-steamcanvas-draggable="true"]:hover,[data-steamcanvas-draggable="true"]:hover *{cursor:grab!important}[data-steamcanvas-draggable="true"][data-steamcanvas-dragging="true"],[data-steamcanvas-draggable="true"][data-steamcanvas-dragging="true"] *{cursor:grabbing!important}[data-steamcanvas-draggable="true"]:hover [data-steamcanvas-showcase-controls],[data-steamcanvas-draggable="true"]:hover [data-steamcanvas-showcase-controls] *{cursor:pointer!important}[data-steamcanvas-showcase-controls="transparent-resize"]{position:absolute!important;bottom:4px!important;left:50%!important;z-index:2!important;min-width:76px!important;min-height:25px!important;display:flex!important;align-items:center!important;justify-content:center!important;gap:4px!important;padding:2px 7px!important;transform:translateX(-50%)!important;border:1px solid #d5f89b!important;border-radius:4px!important;background:rgba(25,34,24,.94)!important;color:#e4ffbd!important;box-shadow:0 2px 8px rgba(0,0,0,.45)!important;font:10px monospace!important;cursor:ns-resize!important;touch-action:none!important;pointer-events:auto!important}[data-steamcanvas-draggable="true"]:hover [data-steamcanvas-showcase-controls="transparent-resize"]{cursor:ns-resize!important}[data-steamcanvas-showcase-controls="transparent-resize"]:hover{background:#344621!important}[data-steamcanvas-showcase-controls="transparent-resize"]:disabled{opacity:.7!important;cursor:wait!important}[data-steamcanvas-showcase-controls="transparent-resize"]:focus-visible{outline:2px solid #fff!important;outline-offset:2px!important}';
		previewDocument!.head.append(dragStyle);

		const nextEntries = [...area.children]
			.filter((child) => child.classList.contains('profile_customization') && !child.classList.contains('customization_edit'))
			.map((child, index) => {
				const element = child as HTMLElement;
				const id = `showcase-${index}-${Math.random().toString(36).slice(2, 8)}`;
				element.dataset.steamcanvasRestoreKey ||= `showcase-key-${Math.random().toString(36).slice(2, 12)}`;
				element.dataset.steamcanvasShowcaseId = id;
				const title = element.querySelector<HTMLElement>('.profile_customization_header')?.textContent?.trim()
					|| 'Profile showcase';
				const kind = classifyShowcase(element);
				element.dataset.steamcanvasDraggable = 'true';
				const host = createOverlayHost(previewDocument!, element, id);
				if (kind === 'featured-artwork') fitFeaturedArtwork(element);
				const exportFiles = readUploadedAssets(element, kind, title);
				return { id, kind, title, element, host, ...(exportFiles.length ? { exportFiles } : {}) };
			});
		setEntries(nextEntries);
		setEntriesDocument(previewDocument);
		const addHost = addControlTarget?.ownerDocument.createElement('div') || null;
		if (addHost && addControlTarget) {
			addHost.dataset.steamcanvasShowcaseControls = 'add-showcase';
			addHost.style.cssText = 'position:relative;z-index:5;display:block;pointer-events:auto;';
			addControlTarget.append(addHost);
		}
		setAddControlHost(addHost);
		const menuHost = addControlTarget?.ownerDocument.createElement('div') || null;
		if (menuHost) addControlTarget?.ownerDocument.body.append(menuHost);
		setAddMenuHost(menuHost);
		setEditingId(null);
		setAddingOpen(false);
		setError('');
		return () => {
			nextEntries.forEach((entry) => {
				entry.host.remove();
				delete entry.element.dataset.steamcanvasDraggable;
				delete entry.element.dataset.steamcanvasDragging;
			});
			dragStyle.remove();
			addHost?.remove();
			menuHost?.remove();
		};
	}, [addControlTarget, previewDocument]);

	useEffect(() => {
		if (!trashControlTarget) return;
		const host = trashControlTarget.ownerDocument.createElement('div');
		trashControlTarget.append(host);
		setTrashHost(host);
		return () => {
			setTrashHost(null);
			host.remove();
		};
	}, [trashControlTarget]);

	useEffect(() => {
		if (!trashOpen || !trashHost) return;
		const closeOnOutside = (event: Event) => {
			const target = event.target as Node | null;
			if (target && !trashHost.contains(target)) setTrashOpen(false);
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setTrashOpen(false);
		};
		const documents = new Set([trashHost.ownerDocument, previewDocument].filter((document): document is Document => !!document));
		documents.forEach((document) => {
			document.addEventListener('pointerdown', closeOnOutside, true);
			document.addEventListener('keydown', closeOnEscape, true);
		});
		return () => documents.forEach((document) => {
			document.removeEventListener('pointerdown', closeOnOutside, true);
			document.removeEventListener('keydown', closeOnEscape, true);
		});
	}, [previewDocument, trashHost, trashOpen]);

	useEffect(() => {
		if (!addingOpen || !addControlHost) return;
		const closeOnOutside = (event: Event) => {
			const target = event.target as Node | null;
			if (target && !addControlHost.contains(target) && !addMenuRef.current?.contains(target)) setAddingOpen(false);
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setAddingOpen(false);
		};
		const documents = new Set([addControlHost.ownerDocument, previewDocument].filter((document): document is Document => !!document));
		documents.forEach((document) => {
			document.addEventListener('pointerdown', closeOnOutside, true);
			document.addEventListener('keydown', closeOnEscape, true);
		});
		return () => documents.forEach((document) => {
			document.removeEventListener('pointerdown', closeOnOutside, true);
			document.removeEventListener('keydown', closeOnEscape, true);
		});
	}, [addingOpen, addControlHost, previewDocument]);

	useLayoutEffect(() => {
		if (!addingOpen || !addControlHost) return;
		const positionDrawer = () => {
			const drawer = addMenuRef.current;
			if (!drawer) return;
			const bounds = drawer.getBoundingClientRect();
			const anchor = addControlHost.getBoundingClientRect();
			const maxLeft = Math.max(12, globalThis.innerWidth - bounds.width - 12);
			const nextLeft = Math.max(12, Math.min(anchor.right + 10, maxLeft));
			const maxTop = Math.max(12, globalThis.innerHeight - bounds.height - 12);
			const nextTop = Math.max(12, Math.min(anchor.top - 5, maxTop));
			setAddDrawerLeft((current) => current === nextLeft ? current : nextLeft);
			setAddDrawerTop((current) => current === nextTop ? current : nextTop);
		};
		positionDrawer();
		globalThis.addEventListener('resize', positionDrawer);
		return () => globalThis.removeEventListener('resize', positionDrawer);
	}, [addControlHost, addingOpen]);

	useEffect(() => {
		const dialog = editorDialogRef.current;
		if (!dialog) return;
		if (editingId && !dialog.open) dialog.showModal();
		if (!editingId && dialog.open) dialog.close();
	}, [editingId]);

	useEffect(() => {
		if (!previewDocument) return;
		let pointerFrame = 0;
		let pendingPointerEvent: PointerEvent | null = null;
		let targetRects: Array<{ entry: ShowcaseEntry; rect: DOMRect }> = [];
		let targetRectsDirty = true;
		const cancelPendingPointerMove = () => {
			pendingPointerEvent = null;
			if (pointerFrame) previewDocument.defaultView?.cancelAnimationFrame(pointerFrame);
			pointerFrame = 0;
		};
		const finishGesture = (gesture: ShowcasePointerGesture, commit: boolean) => {
			cancelPendingPointerMove();
			const { element, placeholder, ghost, originalCssText, originalUserSelect } = gesture;
			if (commit && gesture.moved) {
				placeholder?.remove();
				dropShowcaseOn(dragTargetRef.current.id, dragTargetRef.current.after, gesture.id);
			} else {
				placeholder?.remove();
			}
			element.style.cssText = originalCssText;
			ghost?.remove();
			delete element.dataset.steamcanvasDragging;
			previewDocument.documentElement.style.userSelect = originalUserSelect;
			if (gesture.moved) globalThis.setTimeout(() => { suppressClickRef.current = false; }, 500);
			pointerGestureRef.current = null;
			dragTargetRef.current = { id: null, after: false };
			setDraggingShowcaseId(null);
			setDragTargetShowcaseId(null);
		};
		const processPointerMove = (event: PointerEvent) => {
			const gesture = pointerGestureRef.current;
			if (!gesture || gesture.pointerId !== event.pointerId) return;
			if (!gesture.moved && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 7) return;
			if (!gesture.moved) {
				gesture.moved = true;
				suppressClickRef.current = true;
				gesture.element.dataset.steamcanvasDragging = 'true';
				const rect = gesture.element.getBoundingClientRect();
				const computed = previewDocument.defaultView?.getComputedStyle(gesture.element);
				const placeholder = previewDocument.createElement('div');
				placeholder.className = gesture.element.className;
				placeholder.dataset.steamcanvasDragPlaceholder = 'true';
				placeholder.setAttribute('aria-hidden', 'true');
				placeholder.style.cssText = `box-sizing:border-box;width:${rect.width}px;height:${rect.height}px;min-height:${rect.height}px;margin:${computed?.margin || '0'};border:1px dashed rgba(126,155,61,.72);border-radius:3px;background:rgba(196,243,106,.12);transition:transform .16s ease,margin .16s ease;`;
				gesture.element.parentElement?.insertBefore(placeholder, gesture.element);
				gesture.placeholder = placeholder;
				gesture.element.style.setProperty('position', 'fixed', 'important');
				gesture.element.style.setProperty('left', `${rect.left}px`, 'important');
				gesture.element.style.setProperty('top', `${rect.top}px`, 'important');
				gesture.element.style.setProperty('width', `${rect.width}px`, 'important');
				gesture.element.style.setProperty('height', `${rect.height}px`, 'important');
				gesture.element.style.setProperty('margin', '0', 'important');
				gesture.element.style.setProperty('visibility', 'hidden', 'important');
				gesture.element.style.setProperty('pointer-events', 'none', 'important');
				targetRectsDirty = true;
				const ghost = gesture.element.cloneNode(true) as HTMLElement;
				ghost.querySelectorAll('[data-steamcanvas-showcase-controls]').forEach((control) => control.remove());
				ghost.querySelectorAll('img, video, audio, canvas').forEach((media) => media.remove());
				ghost.style.cssText += `;position:fixed!important;left:${rect.left}px!important;top:${rect.top}px!important;width:${rect.width}px!important;height:${rect.height}px!important;margin:0!important;z-index:2147483647!important;opacity:.94!important;pointer-events:none!important;transform:scale(1.025)!important;transform-origin:center!important;box-shadow:0 20px 48px rgba(0,0,0,.42)!important;transition:box-shadow .14s ease,transform .14s ease!important;`;
				ghost.style.setProperty('visibility', 'visible', 'important');
				previewDocument.body.append(ghost);
				gesture.ghost = ghost;
				previewDocument.documentElement.style.userSelect = 'none';
				setDraggingShowcaseId(gesture.id);
			}
			if (gesture.ghost) {
				gesture.ghost.style.left = `${event.clientX - gesture.offsetX}px`;
				gesture.ghost.style.top = `${event.clientY - gesture.offsetY}px`;
			}
			if (targetRectsDirty) {
				targetRects = entries
					.filter((entry) => entry.id !== gesture.id)
					.map((entry) => ({ entry, rect: entry.element.getBoundingClientRect() }));
				targetRectsDirty = false;
			}
			let nearest: { entry: ShowcaseEntry; rect: DOMRect } | null = null;
			let nearestDistance = Number.POSITIVE_INFINITY;
			for (const candidate of targetRects) {
				const { entry, rect } = candidate;
				const distance = Math.abs(rect.top + rect.height / 2 - event.clientY);
				if (distance < nearestDistance) {
					nearest = { entry, rect };
					nearestDistance = distance;
				}
			}
			const id = nearest?.entry.id || null;
			const after = nearest ? event.clientY >= nearest.rect.top + nearest.rect.height / 2 : false;
			const targetChanged = dragTargetRef.current.id !== id;
			dragTargetRef.current = { id, after };
			if (targetChanged) setDragTargetShowcaseId(id);
			if (nearest && gesture.placeholder) {
				const parent = nearest.entry.element.parentElement;
				const reference = after ? nearest.entry.element.nextSibling : nearest.entry.element;
				if (parent && reference !== gesture.placeholder) {
					parent.insertBefore(gesture.placeholder, reference);
					targetRectsDirty = true;
				}
			}
			event.preventDefault();
		};
		const flushPendingPointerMove = () => {
			const pending = pendingPointerEvent;
			cancelPendingPointerMove();
			if (pending) processPointerMove(pending);
		};
		const onPointerMove = (event: PointerEvent) => {
			const resize = transparentResizeRef.current;
			if (resize && resize.pointerId === event.pointerId) {
				const height = Math.max(1, Math.round(
					resize.startHeight + (event.clientY - resize.startY) * resize.outputWidth / resize.displayWidth,
				));
				resize.entry.element.dataset.steamcanvasTransparentHeight = String(height);
				const heightLabel = resize.handle.querySelector<HTMLElement>('[data-transparent-height]');
				if (heightLabel) heightLabel.textContent = `${height}px`;
				applyTransparentCropPreviewHeight(resize.entry, height);
				event.preventDefault();
				return;
			}
			const gesture = pointerGestureRef.current;
			if (!gesture || gesture.pointerId !== event.pointerId) return;
			if (gesture.moved || Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= 7) event.preventDefault();
			pendingPointerEvent = event;
			if (pointerFrame) return;
			pointerFrame = previewDocument.defaultView?.requestAnimationFrame(() => {
				pointerFrame = 0;
				const pending = pendingPointerEvent;
				pendingPointerEvent = null;
				if (pending) processPointerMove(pending);
			}) || 0;
		};
		const onPointerUp = (event: PointerEvent) => {
			const resize = transparentResizeRef.current;
			if (resize && resize.pointerId === event.pointerId) {
				transparentResizeRef.current = null;
				const height = Number(resize.entry.element.dataset.steamcanvasTransparentHeight) || resize.startHeight;
				if (height !== resize.startHeight) void resizeTransparentBackground(resize.entry, height, resize.startHeight);
				return;
			}
			const gesture = pointerGestureRef.current;
			if (!gesture || gesture.pointerId !== event.pointerId) return;
			flushPendingPointerMove();
			finishGesture(gesture, true);
		};
		const onPointerCancel = (event: PointerEvent) => {
			const resize = transparentResizeRef.current;
			if (resize && resize.pointerId === event.pointerId) {
				transparentResizeRef.current = null;
				resize.entry.element.dataset.steamcanvasTransparentHeight = String(resize.startHeight);
				applyTransparentCropPreviewHeight(resize.entry, resize.startHeight);
				return;
			}
			const gesture = pointerGestureRef.current;
			if (gesture?.pointerId === event.pointerId) finishGesture(gesture, false);
		};
		const onClick = (event: MouseEvent) => {
			if (!suppressClickRef.current) return;
			suppressClickRef.current = false;
			event.preventDefault();
			event.stopPropagation();
		};
		const handlers = entries.map((entry) => {
			const onPointerDown = (event: PointerEvent) => {
				if (event.button !== 0 || (event.target as Element | null)?.closest('[data-steamcanvas-showcase-controls]')) return;
				try {
					entry.element.setPointerCapture(event.pointerId);
				} catch {}
				const originalUserSelect = previewDocument.documentElement.style.userSelect;
				previewDocument.documentElement.style.userSelect = 'none';
				const rect = entry.element.getBoundingClientRect();
				pointerGestureRef.current = {
					id: entry.id,
					pointerId: event.pointerId,
					x: event.clientX,
					y: event.clientY,
					offsetX: event.clientX - rect.left,
					offsetY: event.clientY - rect.top,
					moved: false,
					element: entry.element,
					placeholder: null,
					ghost: null,
					originalCssText: entry.element.style.cssText,
					originalUserSelect,
				};
				setHoveredShowcaseId(entry.id);
			};
			const onDragStart = (event: DragEvent) => event.preventDefault();
			const onEnter = () => setHoveredShowcaseId(entry.id);
			const onLeave = () => setHoveredShowcaseId((current) => current === entry.id ? null : current);
			entry.element.addEventListener('pointerdown', onPointerDown);
			entry.element.addEventListener('dragstart', onDragStart);
			entry.element.addEventListener('mouseenter', onEnter);
			entry.element.addEventListener('mouseleave', onLeave);
			return () => {
				entry.element.removeEventListener('pointerdown', onPointerDown);
				entry.element.removeEventListener('dragstart', onDragStart);
				entry.element.removeEventListener('mouseenter', onEnter);
				entry.element.removeEventListener('mouseleave', onLeave);
			};
		});
		previewDocument.addEventListener('pointermove', onPointerMove, true);
		previewDocument.addEventListener('pointerup', onPointerUp, true);
		previewDocument.addEventListener('pointercancel', onPointerCancel, true);
		previewDocument.addEventListener('click', onClick, true);
		return () => {
			cancelPendingPointerMove();
			handlers.forEach((cleanup) => cleanup());
			previewDocument.removeEventListener('pointermove', onPointerMove, true);
			previewDocument.removeEventListener('pointerup', onPointerUp, true);
			previewDocument.removeEventListener('pointercancel', onPointerCancel, true);
			previewDocument.removeEventListener('click', onClick, true);
		};
	}, [entries, previewDocument]);

	async function downloadShowcaseZip(
		exportableEntries: Array<{ entry: ShowcaseEntry; files: Array<{ name: string; url: string }>; index: number }>,
		filename: string,
		includeProfileHtml = false,
	) {
		const folders: Record<ShowcaseKind, string> = {
			artwork: 'Artwork Showcase',
			'featured-artwork': 'Featured Artwork',
			screenshot: 'Screenshots',
			workshop: 'Workshop',
			other: '',
		};
		const archive = new JSZip();
		const exportedImagePaths = new Map<HTMLImageElement, string>();
		for (const { entry, files, index } of exportableEntries) {
			const showcaseFolder = `${String(index + 1).padStart(2, '0')} - ${entry.title.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Showcase'}`;
			const folder = archive.folder(folders[entry.kind])?.folder(showcaseFolder);
			if (!folder) continue;
			const imageElements = getShowcaseImages(entry.element, entry.kind);
			for (const [fileIndex, file] of files.entries()) {
				const response = await fetch(file.url);
				if (!response.ok) throw new Error(`Could not read ${file.name}.`);
				const blob = await response.blob();
				const assetPath = `${folders[entry.kind]}/${showcaseFolder}/${file.name}`;
				archive.file(assetPath, entry.kind === 'workshop' ? await prepareWorkshopImageForLongUpload(blob) : blob);
				if (imageElements[fileIndex]) {
					if (includeProfileHtml && entry.kind === 'workshop') {
						const previewAssetPath = `Profile Preview Assets/${assetPath}`;
						archive.file(previewAssetPath, blob);
						exportedImagePaths.set(imageElements[fileIndex], previewAssetPath);
					} else {
						exportedImagePaths.set(imageElements[fileIndex], assetPath);
					}
				}
			}
		}
		if (includeProfileHtml) {
			if (!previewDocument) throw new Error('The profile preview is unavailable.');
			const exportedDocument = previewDocument.cloneNode(true) as Document;
			const sourceBaseUrl = previewDocument.baseURI;
			const sourceUrlElements = [...previewDocument.querySelectorAll<HTMLElement>('[href], [src], [poster], [action], [srcset]')];
			const exportedUrlElements = [...exportedDocument.querySelectorAll<HTMLElement>('[href], [src], [poster], [action], [srcset]')];
			for (const [elementIndex, sourceElement] of sourceUrlElements.entries()) {
				const exportedElement = exportedUrlElements[elementIndex];
				if (!exportedElement) continue;
				for (const attribute of ['href', 'src', 'poster', 'action']) {
					const value = sourceElement.getAttribute(attribute);
					if (!value || /^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) continue;
					try {
						exportedElement.setAttribute(attribute, new URL(value, sourceBaseUrl).href);
					} catch {
						throw new Error(`Could not resolve profile URL: ${value}`);
					}
				}
				const srcset = sourceElement.getAttribute('srcset');
				if (srcset && !/\bdata:/i.test(srcset)) {
					const resolvedSrcset = srcset.split(',').map((candidate) => {
						const [url, ...descriptors] = candidate.trim().split(/\s+/);
						if (!url) return candidate;
						try {
							return [new URL(url, sourceBaseUrl).href, ...descriptors].join(' ');
						} catch {
							throw new Error(`Could not resolve profile image URL: ${url}`);
						}
					}).join(', ');
					exportedElement.setAttribute('srcset', resolvedSrcset);
				}
			}
			const sourceImages = [...previewDocument.querySelectorAll<HTMLImageElement>('img')];
			const exportedImages = [...exportedDocument.querySelectorAll<HTMLImageElement>('img')];
			const inlineAssetPaths = new Map<string, string>();
			let inlineAssetIndex = 0;

			for (const [imageIndex, sourceImage] of sourceImages.entries()) {
				const exportedImage = exportedImages[imageIndex];
				if (!exportedImage) continue;
				let assetPath = exportedImagePaths.get(sourceImage);
				const sourceUrl = sourceImage.getAttribute('src') || '';
				if (!assetPath && /^data:image\//i.test(sourceUrl)) {
					assetPath = inlineAssetPaths.get(sourceUrl);
					if (!assetPath) {
						const response = await fetch(sourceUrl);
						if (!response.ok) throw new Error('Could not save an embedded profile image.');
						const mime = sourceUrl.match(/^data:image\/([^;,]+)/i)?.[1]?.split('+')[0]?.toLowerCase() || 'png';
						const extension = mime === 'jpeg' ? 'jpg' : /^[a-z0-9]+$/.test(mime) ? mime : 'png';
						assetPath = `Profile Assets/image-${String(++inlineAssetIndex).padStart(3, '0')}.${extension}`;
						archive.file(assetPath, await response.blob());
						inlineAssetPaths.set(sourceUrl, assetPath);
					}
				}
				if (assetPath) {
					exportedImage.setAttribute('src', assetPath);
					exportedImage.removeAttribute('srcset');
					const sourceAnchor = sourceImage.closest<HTMLAnchorElement>('a');
					const exportedAnchor = exportedImage.closest<HTMLAnchorElement>('a');
					if (sourceAnchor && exportedAnchor && sourceAnchor.getAttribute('href') === sourceUrl) {
						exportedAnchor.setAttribute('href', assetPath);
					}
				} else {
					const resolvedSource = sourceImage.currentSrc || sourceImage.src;
					if (resolvedSource) exportedImage.setAttribute('src', resolvedSource);
				}
				if (assetPath && sourceImage.style.transform && sourceImage.style.transform !== 'none') {
					for (const property of ['width', 'height', 'max-width', 'min-height', 'object-fit', 'transform', 'transform-origin']) {
						exportedImage.style.removeProperty(property);
					}
					exportedImage.style.display = 'block';
					exportedImage.style.width = '100%';
					exportedImage.style.height = 'auto';
					exportedImage.style.maxWidth = '100%';
					exportedImage.style.objectFit = 'fill';
				}
			}

			exportedDocument.querySelectorAll('[data-steamcanvas-showcase-controls], style[data-steamcanvas-drag-cursor]').forEach((element) => element.remove());
			const base = exportedDocument.querySelector('base') || exportedDocument.head.appendChild(exportedDocument.createElement('base'));
			base.setAttribute('href', './');
			archive.file('index.html', `<!DOCTYPE html>\n${exportedDocument.documentElement.outerHTML}`);
		}
		const blob = await archive.generateAsync({ type: 'blob' });
		const url = URL.createObjectURL(blob);
		const link = globalThis.document.createElement('a');
		link.href = url;
		link.download = filename;
		globalThis.document.body.append(link);
		link.click();
		link.remove();
		globalThis.setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	function getExportableEntry(entry: ShowcaseEntry, index: number) {
		if (entry.kind === 'other' || entry.element.dataset.steamcanvasPublicScreenshots === 'true') return null;
		const files = entry.exportFiles || (entry.animatedArtwork ? [entry.animatedArtwork] : []);
		return files.length ? { entry, files, index } : null;
	}

	async function exportSingleShowcase(entry: ShowcaseEntry) {
		const index = entries.findIndex((item) => item.id === entry.id);
		const exportableEntry = getExportableEntry(entry, index);
		if (!exportableEntry || exportingShowcaseId) return;
		setExportingShowcaseId(entry.id);
		setShowcaseExportError(null);
		try {
			const baseName = profileName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'steamcanvas';
			const title = entry.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'showcase';
			await downloadShowcaseZip([exportableEntry], `${baseName}-${title}.zip`);
		} catch (caught) {
			setShowcaseExportError({ id: entry.id, message: caught instanceof Error ? caught.message : 'Showcase ZIP export failed.' });
		} finally {
			setExportingShowcaseId(null);
		}
	}

	useEffect(() => {
		exportAssetsRef.current = async () => {
			const exportableEntries = entries.map(getExportableEntry).filter((entry): entry is NonNullable<typeof entry> => !!entry);
			if (!exportableEntries.length) throw new Error('No uploaded showcase artwork to export yet.');
			if (exportingShowcaseId) throw new Error('A showcase ZIP is already being prepared.');
			setExportingShowcaseId('all');
			try {
				const baseName = profileName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'steamcanvas';
				await downloadShowcaseZip(exportableEntries, `${baseName}-showcase-project.zip`, true);
			} finally {
				setExportingShowcaseId(null);
			}
		};
		return () => { exportAssetsRef.current = null; };
	}, [entries, exportAssetsRef, profileName, exportingShowcaseId, previewDocument]);

	function syncOrder(nextEntries: ShowcaseEntry[]) {
		const area = getShowcaseArea(previewDocument);
		if (!area) return;
		let reference: Node | null = [...area.children].find((child) => child.classList.contains('customization_edit')) || null;
		for (let index = nextEntries.length - 1; index >= 0; index -= 1) {
			const element = nextEntries[index].element;
			if (element.parentElement !== area || element.nextSibling !== reference) area.insertBefore(element, reference);
			reference = element;
		}
		setEntries(nextEntries);
	}

	function dropShowcaseOn(targetId: string | null, after = false, sourceId = draggingShowcaseId) {
		if (!targetId) return;
		if (!sourceId || sourceId === targetId) return;
		const nextEntries = [...entries];
		const fromIndex = nextEntries.findIndex((entry) => entry.id === sourceId);
		const toIndex = nextEntries.findIndex((entry) => entry.id === targetId);
		if (fromIndex < 0 || toIndex < 0) return;
		const [moved] = nextEntries.splice(fromIndex, 1);
		const targetIndex = toIndex - (fromIndex < toIndex ? 1 : 0);
		nextEntries.splice(targetIndex + (after ? 1 : 0), 0, moved);
		syncOrder(nextEntries);
		setDraggingShowcaseId(null);
		setDragTargetShowcaseId(null);
	}

	function animateShowcaseToTrash(entry: ShowcaseEntry) {
		const target = trashControlTarget;
		const frame = previewDocument?.defaultView?.frameElement;
		if (!target || !frame || !previewDocument) return;
		const sourceRect = entry.element.getBoundingClientRect();
		const frameRect = frame.getBoundingClientRect();
		const targetRect = target.getBoundingClientRect();
		const flight = entry.element.cloneNode(true) as HTMLElement;
		flight.querySelectorAll('[data-steamcanvas-showcase-controls], [data-steamcanvas-drag-placeholder]').forEach((element) => element.remove());
		for (const element of [flight, ...flight.querySelectorAll<HTMLElement>('*')]) {
			element.removeAttribute('data-steamcanvas-showcase-controls');
			element.removeAttribute('data-steamcanvas-showcase-id');
			element.removeAttribute('data-steamcanvas-draggable');
			element.removeAttribute('data-steamcanvas-dragging');
		}
		flight.setAttribute('aria-hidden', 'true');
		flight.querySelectorAll<HTMLImageElement>('img').forEach((image) => { image.draggable = false; });
		flight.style.setProperty('position', 'fixed', 'important');
		flight.style.setProperty('left', `${sourceRect.left}px`, 'important');
		flight.style.setProperty('top', `${sourceRect.top}px`, 'important');
		flight.style.setProperty('width', `${sourceRect.width}px`, 'important');
		flight.style.setProperty('height', `${sourceRect.height}px`, 'important');
		flight.style.setProperty('margin', '0', 'important');
		flight.style.setProperty('z-index', '2147483647', 'important');
		flight.style.setProperty('pointer-events', 'none', 'important');
		flight.style.setProperty('transform-origin', 'center center', 'important');
		previewDocument.body.append(flight);
		const targetX = targetRect.left + targetRect.width / 2 - frameRect.left;
		const targetY = targetRect.top + targetRect.height / 2 - frameRect.top;
		const deltaX = targetX - (sourceRect.left + sourceRect.width / 2);
		const deltaY = targetY - (sourceRect.top + sourceRect.height / 2);
		const reducedMotion = previewDocument.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches;
		const animation = flight.animate([
			{ transform: 'translate(0, 0) scale(1)', opacity: 1 },
			{ transform: `translate(${deltaX}px, ${deltaY}px) scale(.035)`, opacity: 0 },
		], { duration: reducedMotion ? 220 : 720, easing: 'cubic-bezier(.2,.78,.2,1)', fill: 'forwards' });
		void animation.finished.then(() => flight.remove(), () => flight.remove());
	}

	function removeShowcase(entry: ShowcaseEntry) {
		animateShowcaseToTrash(entry);
		if (!entry.element.dataset.steamcanvasNewShowcase) {
			const index = entries.findIndex((item) => item.id === entry.id);
			const copy = entry.element.cloneNode(true) as HTMLElement;
			copy.querySelectorAll('[data-steamcanvas-showcase-controls], [data-steamcanvas-drag-placeholder]').forEach((element) => element.remove());
			for (const element of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) {
				element.removeAttribute('data-steamcanvas-showcase-controls');
				element.removeAttribute('data-steamcanvas-showcase-id');
				element.removeAttribute('data-steamcanvas-draggable');
				element.removeAttribute('data-steamcanvas-dragging');
			}
			const archived: RemovedShowcase = {
				key: entry.element.dataset.steamcanvasRestoreKey || `showcase-key-${Math.random().toString(36).slice(2, 12)}`,
				title: entry.title,
				html: copy.outerHTML,
				index,
				beforeKey: entries[index - 1]?.element.dataset.steamcanvasRestoreKey || null,
				afterKey: entries[index + 1]?.element.dataset.steamcanvasRestoreKey || null,
			};
			onRemovedShowcasesChange([...removedShowcases, archived]);
		}
		entry.element.remove();
		setEntries((current) => current.filter((item) => item.id !== entry.id));
	}

	function restoreRemovedShowcase(archived: RemovedShowcase) {
		const area = getShowcaseArea(previewDocument, true);
		if (!area) return;
		const template = area.ownerDocument.createElement('template');
		template.innerHTML = archived.html;
		template.content.querySelectorAll('script, iframe, object, embed, form').forEach((element) => element.remove());
		template.content.querySelectorAll<HTMLElement>('*').forEach((element) => {
			for (const attribute of [...element.attributes]) {
				if (/^on/i.test(attribute.name) || attribute.name === 'srcdoc') element.removeAttribute(attribute.name);
				if (/^(href|src|xlink:href)$/i.test(attribute.name) && /^\s*javascript:/i.test(attribute.value)) element.removeAttribute(attribute.name);
			}
		});
		const element = template.content.firstElementChild as HTMLElement | null;
		if (!element || !element.classList.contains('profile_customization')) return;
		element.dataset.steamcanvasRestoreKey = archived.key;
		const id = `showcase-restored-${Math.random().toString(36).slice(2, 8)}`;
		element.dataset.steamcanvasShowcaseId = id;
		element.dataset.steamcanvasDraggable = 'true';
		const host = createOverlayHost(area.ownerDocument, element, id);
		const restored: ShowcaseEntry = { id, kind: classifyShowcase(element), title: archived.title, element, host };
		if (restored.kind === 'featured-artwork') fitFeaturedArtwork(element);
		const after = entries.find((entry) => entry.element.dataset.steamcanvasRestoreKey === archived.afterKey);
		const before = entries.find((entry) => entry.element.dataset.steamcanvasRestoreKey === archived.beforeKey);
		const fallback = entries[Math.min(archived.index, entries.length)];
		const insertionPoint = after?.element || (before ? before.element.nextSibling : fallback?.element) || [...area.children].find((child) => child.classList.contains('customization_edit')) || null;
		area.insertBefore(element, insertionPoint);
		const nextEntries = [...entries];
		const insertionIndex = after ? nextEntries.indexOf(after) : before ? nextEntries.indexOf(before) + 1 : fallback ? nextEntries.indexOf(fallback) : nextEntries.length;
		nextEntries.splice(Math.max(0, insertionIndex), 0, restored);
		setEntries(nextEntries);
		onRemovedShowcasesChange(removedShowcases.filter((item) => item.key !== archived.key));
	}

	/** Builds a new showcase, inserts it before Steam's add-showcase placeholder and returns it. */
	function createShowcase(kind: CreatableShowcaseKind): ShowcaseEntry | null {
		const area = getShowcaseArea(previewDocument, true);
		if (!area) return null;
		const element = kind === 'workshop'
			? makeWorkshopShowcase(area.ownerDocument)
			: kind === 'screenshot'
				? makeScreenshotShowcase(area.ownerDocument)
				: makeArtworkShowcase(area.ownerDocument, kind);
		const id = `showcase-new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		element.dataset.steamcanvasRestoreKey = `showcase-key-${Math.random().toString(36).slice(2, 12)}`;
		element.dataset.steamcanvasShowcaseId = id;
		const title = kind === 'workshop'
			? 'Workshop Showcase'
			: kind === 'screenshot'
				? 'Screenshot Showcase'
			: kind === 'featured-artwork' ? 'Featured Artwork Showcase' : 'Artwork Showcase';
		element.dataset.steamcanvasDraggable = 'true';
		const host = createOverlayHost(area.ownerDocument, element, id);
		const entry: ShowcaseEntry = { id, kind, title, element, host };
		const placeholder = [...area.children].find((child) => child.classList.contains('customization_edit')) || null;
		area.insertBefore(element, placeholder);
		setEntries((current) => [...current, entry]);
		return entry;
	}

	function scrollToShowcase(element: HTMLElement) {
		const previewWindow = element.ownerDocument.defaultView;
		if (!previewWindow) return;
		const targetTop = element.getBoundingClientRect().top + previewWindow.scrollY - 24;
		previewWindow.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
	}

	function addShowcase(kind: CreatableShowcaseKind) {
		const entry = createShowcase(kind);
		if (!entry) {
			setError('Showcase area not found.');
			return;
		}
		scrollToShowcase(entry.element);
		setAddingOpen(false);
		setEditingId(null);
		setError('');
	}

	const activeEditor = entries.find((entry) => entry.id === editingId) || null;
	const maxWorkshopRows = activeEditor?.kind === 'workshop' ? 3 : 0;
	const editorPanelCount = activeEditor ? getMosaicPanelCount(activeEditor.kind, artworkLayout, workshopRows) : 1;
	const workshopSelectionCount = workshopRowFiles.slice(0, workshopRows).filter(Boolean).length
		+ workshopPanelFiles.slice(0, editorPanelCount).filter(Boolean).length;
	const expectedEditorFiles = imageInputMode === 'workshop-rows'
		? workshopRows
		: imageInputMode === 'separate' || imageInputMode === 'public' ? editorPanelCount : 1;

	function openEditor(entry: ShowcaseEntry) {
		previewRequestId.current += 1;
		const publicSelection = entry.element.dataset.steamcanvasPublicScreenshotData ? JSON.parse(entry.element.dataset.steamcanvasPublicScreenshotData) as PublicScreenshot[] : [];
		const publicSelectionIds = publicSelection.map((item) => item.id);
		const savedLayout = publicSelectionIds.length || entry.element.dataset.steamcanvasMosaicPanels === '4' ? 'main-three-side' : 'main-side';
		const savedWorkshopRows = getWorkshopShowcaseRows(entry);
		setArtworkLayout(savedLayout);
		setWorkshopRows(savedWorkshopRows);
		setBackgroundCropHeight(Number(entry.element.dataset.steamcanvasTransparentHeight)
			|| (entry.kind === 'workshop' ? 126 : DEFAULT_TRANSPARENT_HEIGHT));
		setWorkshopRowFiles(Array(3).fill(null));
		setWorkshopRowPreviews(Array(3).fill(null));
		setWorkshopPanelFiles(Array(15).fill(null));
		workshopUploadTargetRef.current = null;
		const panelCount = getMosaicPanelCount(entry.kind, savedLayout, savedWorkshopRows);
		const currentImages = [...entry.element.querySelectorAll<HTMLImageElement>(entry.kind === 'workshop'
			? '.myworkshop_showcase .workshop_showcase_item_image'
			: SHOWCASE_ARTWORK_IMAGE_SELECTOR)];
		setImageInputMode(publicSelectionIds.length ? 'public' : 'composite');
		setEditorFiles(publicSelection);
		setEditorPreview(publicSelectionIds.length ? [] : currentImages.slice(0, panelCount).map((image) => ({
			src: image.currentSrc || image.src,
			width: image.naturalWidth || image.width || 16,
			height: image.naturalHeight || image.height || 9,
		})));
		setUploadButtonPreview(publicSelection[0]?.thumbnailUrl || currentImages[0]?.currentSrc || currentImages[0]?.src || null);
		setEditorLoading(false);
		setEditorProgress('');
		setEditorError('');
		setAddingOpen(false);
		setEditingId(entry.id);
		setPublicScreenshotSearch('');
		setPublicScreenshotPage(0);
		setPublicScreenshotExpanded(false);
		setPublicScreenshotNextPage(1);
		setPublicScreenshotHasMore(true);
		if (publicSelection.length) void updateEditorPreview(entry, publicSelection, 'public');
		else if (entry.mosaicSources?.length) void restoreMosaicSources(entry, savedLayout, savedWorkshopRows);
		if (entry.kind === 'screenshot' && profileUrl) void loadPublicScreenshots(1, false, entry.id);
	}

	async function loadPublicScreenshots(page: number, append: boolean, restoreEntryId?: string) {
		setPublicScreenshotsLoading(true);
		setEditorError('');
		try {
			const response = await fetch('/api/profile-screenshots', {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileUrl, page }),
			});
			const result = await response.json() as { items?: PublicScreenshot[]; hasMore?: boolean; error?: string };
			if (!response.ok) throw new Error(result.error || 'Could not load public screenshots.');
			const nextItems = append ? [...new Map([...publicScreenshots, ...(result.items || [])].map((item) => [item.id, item])).values()] : result.items || [];
			setPublicScreenshots(nextItems);
			if (!append && restoreEntryId) {
				const entry = entries.find((item) => item.id === restoreEntryId);
				const ids = entry?.element.dataset.steamcanvasPublicScreenshotIds ? JSON.parse(entry.element.dataset.steamcanvasPublicScreenshotIds) as string[] : [];
				const restored = ids.map((id) => nextItems.find((item) => item.id === id)).filter((item): item is PublicScreenshot => !!item);
				if (entry && restored.length) {
					setEditorFiles(restored);
					void updateEditorPreview(entry, restored, 'public');
				}
			}
			setPublicScreenshotNextPage(page + 6);
			setPublicScreenshotHasMore(result.hasMore === true);
		} catch (caught) {
			if (!append) setPublicScreenshots([]);
			setEditorError(caught instanceof Error ? caught.message : 'Could not load public screenshots.');
		} finally {
			setPublicScreenshotsLoading(false);
		}
	}

	async function updateEditorPreview(entry: ShowcaseEntry, files: Array<EditorSource | null>, mode: ImageInputMode, layout = artworkLayout) {
		const requestId = ++previewRequestId.current;
		setEditorLoading(true);
		setEditorError('');
		try {
			let panels: Array<PreviewPanel | null>;
			if (mode === 'separate' || mode === 'public') {
				panels = await Promise.all(files.map((file) => file ? readPreviewPanel(file) : Promise.resolve(null)));
			} else if (mode === 'workshop-rows') {
				const rows = await splitWorkshopRows(files.filter((file): file is File => !!file && !isPublicScreenshot(file)));
				panels = rows.images.map((src, index) => ({ src: rows.previewImages?.[index] || src, ...(rows.panelDimensions?.[index] || { width: 1, height: 1 }) }));
			} else if (files[0] && hasTwoPanelImageEditor(entry.kind)) {
				const mosaic = await splitArtworkMosaic(files[0] as File, layout);
				panels = mosaic.images.map((src, index) => ({ src: mosaic.previewImages?.[index] || src, ...(mosaic.panelDimensions?.[index] || { width: 16, height: 9 }) }));
			} else if (files[0] && entry.kind === 'workshop') {
				const mosaic = await splitWorkshopMosaic(files[0] as File);
				panels = mosaic.images.map((src, index) => ({ src: mosaic.previewImages?.[index] || src, ...(mosaic.panelDimensions?.[index] || { width: 1, height: 1 }) }));
			} else if (files[0]) {
				panels = [await readPreviewPanel(files[0])];
			} else {
				panels = [];
			}
			if (previewRequestId.current === requestId) {
				setEditorPreview(panels);
				const source = files.find((file): file is EditorSource => !!file) || null;
				const thumbnail = mode === 'composite' && source && !isPublicScreenshot(source)
					? (await readPreviewPanel(source)).src
					: panels.find((panel): panel is PreviewPanel => !!panel)?.src || null;
				if (previewRequestId.current === requestId) setUploadButtonPreview(thumbnail);
			}
		} catch (caught) {
			if (previewRequestId.current === requestId) {
				setEditorError(caught instanceof Error ? caught.message : 'Could not prepare the image preview.');
				setEditorPreview([]);
			}
		} finally {
			if (previewRequestId.current === requestId) setEditorLoading(false);
		}
	}

	async function restoreMosaicSources(entry: ShowcaseEntry, layout: ArtworkLayout, rows: WorkshopRows) {
		const requestId = ++previewRequestId.current;
		setEditorLoading(true);
		setEditorError('');
		try {
			const sources = await Promise.all((entry.mosaicSources || []).map(async (source) => {
				const response = await fetch(source.url);
				if (!response.ok) throw new Error(`Could not restore ${source.name}.`);
				const blob = await response.blob();
				return { ...source, file: new File([blob], source.name, { type: blob.type }) };
			}));
			if (!sources.length || previewRequestId.current !== requestId) return;
			const firstPreview = await readPreviewPanel(sources[0].file);
			if (entry.kind === 'workshop') {
				const rowFiles: Array<File | null> = Array(3).fill(null);
				const rowPreviews: Array<string | null> = Array(3).fill(null);
				const panelFiles: Array<File | null> = Array(15).fill(null);
				const currentImages = getShowcaseImages(entry.element, entry.kind);
				const panels: Array<PreviewPanel | null> = currentImages.slice(0, rows * 5).map((image) => ({
					src: image.currentSrc || image.src,
					width: image.naturalWidth || image.width || 1,
					height: image.naturalHeight || image.height || 1,
				}));
				for (const source of sources) {
					const row = Math.floor(source.startIndex / 5);
					if (row >= rows) continue;
					rowFiles[row] = source.file;
					rowPreviews[row] = (await readPreviewPanel(source.file)).src;
					const mosaic = await splitWorkshopMosaic(source.file);
					mosaic.images.forEach((src, index) => {
						panels[source.startIndex + index] = {
							src: mosaic.previewImages?.[index] || src,
							...(mosaic.panelDimensions?.[index] || { width: 1, height: 1 }),
						};
					});
				}
				if (previewRequestId.current !== requestId) return;
				setWorkshopRowFiles(rowFiles);
				setWorkshopRowPreviews(rowPreviews);
				setWorkshopPanelFiles(panelFiles);
				setEditorFiles(sources.map((source) => source.file));
				setImageInputMode('workshop-custom');
				setEditorPreview(panels);
				setUploadButtonPreview(firstPreview.src);
			} else {
				const file = sources[0].file;
				const mosaic = await splitArtworkMosaic(file, layout);
				if (previewRequestId.current !== requestId) return;
				setEditorFiles([file]);
				setImageInputMode('composite');
				setEditorPreview(mosaic.images.map((src, index) => ({
					src: mosaic.previewImages?.[index] || src,
					...(mosaic.panelDimensions?.[index] || { width: 16, height: 9 }),
				})));
				setUploadButtonPreview(firstPreview.src);
			}
		} catch (caught) {
			if (previewRequestId.current === requestId) {
				setEditorError(caught instanceof Error ? caught.message : 'Could not restore the animated mosaic preview.');
			}
		} finally {
			if (previewRequestId.current === requestId) setEditorLoading(false);
		}
	}

	function requestWorkshopUpload(target: WorkshopUploadTarget) {
		workshopUploadTargetRef.current = target;
		workshopFileInputRef.current?.click();
	}

	async function selectWorkshopRowFile(rowIndex: number, file: File) {
		if (!activeEditor || activeEditor.kind !== 'workshop') return;
		if (!/^image\/(png|jpeg|webp|gif|avif|apng)$/.test(file.type)) {
			setEditorError('Choose PNG, JPG, WEBP, GIF, APNG, or AVIF images.');
			return;
		}
		const nextRowFiles = [...workshopRowFiles];
		nextRowFiles[rowIndex] = file;
		const nextPanelFiles = [...workshopPanelFiles];
		nextPanelFiles.fill(null, rowIndex * 5, rowIndex * 5 + 5);
		setWorkshopRowFiles(nextRowFiles);
		setWorkshopRowPreviews((current) => {
			const next = [...current];
			next[rowIndex] = null;
			return next;
		});
		setWorkshopPanelFiles(nextPanelFiles);
		setEditorFiles([file]);
		setImageInputMode('workshop-custom');
		setEditorError('');
		const requestId = ++previewRequestId.current;
		setEditorLoading(true);
		setEditorPreview((current) => {
			const next = [...current];
			next.fill(null, rowIndex * 5, rowIndex * 5 + 5);
			return next;
		});
		try {
			const [mosaic, sourcePreview] = await Promise.all([splitWorkshopMosaic(file), readImageFile(file)]);
			if (previewRequestId.current !== requestId) return;
			setWorkshopRowPreviews((current) => {
				const next = [...current];
				next[rowIndex] = sourcePreview;
				return next;
			});
			setEditorPreview((current) => {
				const next = [...current];
				mosaic.images.forEach((src, index) => {
					next[rowIndex * 5 + index] = {
						src: mosaic.previewImages?.[index] || src,
						...(mosaic.panelDimensions?.[index] || { width: 1, height: 1 }),
					};
				});
				return next;
			});
		} catch (caught) {
			if (previewRequestId.current === requestId) {
				setEditorError(caught instanceof Error ? caught.message : 'Could not prepare the Workshop row.');
			}
		} finally {
			if (previewRequestId.current === requestId) setEditorLoading(false);
		}
	}

	async function selectWorkshopPanels(startIndex: number, selected: File[]) {
		if (!activeEditor || activeEditor.kind !== 'workshop' || !selected.length) return;
		const rowIndex = Math.floor(startIndex / 5);
		const rowEnd = (rowIndex + 1) * 5;
		if (selected.length > rowEnd - startIndex) {
			setEditorError(`Choose up to ${rowEnd - startIndex} images, starting at this panel.`);
			return;
		}
		if (selected.some((file) => !/^image\/(png|jpeg|webp|gif|avif|apng)$/.test(file.type))) {
			setEditorError('Choose PNG, JPG, WEBP, GIF, APNG, or AVIF images.');
			return;
		}
		const rowHadComposite = !!workshopRowFiles[rowIndex];
		const nextRowFiles = [...workshopRowFiles];
		nextRowFiles[rowIndex] = null;
		const nextPanelFiles = [...workshopPanelFiles];
		if (rowHadComposite) nextPanelFiles.fill(null, rowIndex * 5, rowEnd);
		selected.forEach((file, index) => { nextPanelFiles[startIndex + index] = file; });
		setWorkshopRowFiles(nextRowFiles);
		if (rowHadComposite) {
			setWorkshopRowPreviews((current) => {
				const next = [...current];
				next[rowIndex] = null;
				return next;
			});
		}
		setWorkshopPanelFiles(nextPanelFiles);
		setEditorFiles([...nextRowFiles.filter((file): file is File => !!file), ...nextPanelFiles.filter((file): file is File => !!file)]);
		setImageInputMode('workshop-custom');
		setEditorError('');
		const requestId = ++previewRequestId.current;
		setEditorLoading(true);
		if (rowHadComposite) {
			setEditorPreview((current) => {
				const next = [...current];
				next.fill(null, rowIndex * 5, rowEnd);
				return next;
			});
		}
		try {
			const panels = await Promise.all(selected.map(readPreviewPanel));
			if (previewRequestId.current !== requestId) return;
			setEditorPreview((current) => {
				const next = [...current];
				panels.forEach((panel, index) => { next[startIndex + index] = panel; });
				return next;
			});
		} catch (caught) {
			if (previewRequestId.current === requestId) {
				setEditorError(caught instanceof Error ? caught.message : 'Could not prepare the selected Workshop panels.');
			}
		} finally {
			if (previewRequestId.current === requestId) setEditorLoading(false);
		}
	}

	// Fills whole Workshop rows with ready-made panels, starting at startIndex, and adds rows if needed.
	async function placeWorkshopPanels(startIndex: number, files: File[]) {
		const firstRow = Math.floor(startIndex / 5);
		const lastRow = Math.floor((startIndex + files.length - 1) / 5);
		if (!files.length || lastRow > 2) return;
		const rows = Math.max(workshopRows, lastRow + 1) as WorkshopRows;
		const nextRowFiles = [...workshopRowFiles];
		const nextPanelFiles = [...workshopPanelFiles];
		for (let row = firstRow; row <= lastRow; row += 1) {
			nextRowFiles[row] = null;
			nextPanelFiles.fill(null, row * 5, row * 5 + 5);
		}
		files.forEach((file, index) => { nextPanelFiles[startIndex + index] = file; });
		setWorkshopRows(rows);
		setWorkshopRowFiles(nextRowFiles);
		setWorkshopRowPreviews((current) => current.map((preview, row) => (row >= firstRow && row <= lastRow ? null : preview)));
		setWorkshopPanelFiles(nextPanelFiles);
		setEditorFiles([
			...nextRowFiles.slice(0, rows).filter((file): file is File => !!file),
			...nextPanelFiles.slice(0, rows * 5).filter((file): file is File => !!file),
		]);
		setImageInputMode('workshop-custom');
		setEditorError('');
		const requestId = ++previewRequestId.current;
		setEditorLoading(true);
		try {
			const panels = await Promise.all(files.map(readPreviewPanel));
			if (previewRequestId.current !== requestId) return;
			setEditorPreview((current) => {
				const next = [...current];
				panels.forEach((panel, index) => { next[startIndex + index] = panel; });
				return next;
			});
		} catch (caught) {
			if (previewRequestId.current === requestId) {
				setEditorError(caught instanceof Error ? caught.message : 'Could not prepare the Workshop panels.');
			}
		} finally {
			if (previewRequestId.current === requestId) setEditorLoading(false);
		}
	}

	// Puts a conversion from the Steam Artwork Studio Library in the open editor. The Studio's parts
	// are already cut to Steam's sizes, so they go in as ready-made panels; Apply places them.
	function chooseStudioArtwork(artwork: IncomingArtwork, startRow: number) {
		if (!activeEditor) return;
		setEditorError('');
		setUploadButtonPreview(null);
		if (activeEditor.kind === 'workshop') {
			void placeWorkshopPanels((startRow - 1) * 5, artwork.files);
			return;
		}
		if (activeEditor.kind === 'featured-artwork') {
			const files = artwork.files.slice(0, 1);
			setImageInputMode('composite');
			setEditorFiles(files);
			void updateEditorPreview(activeEditor, files, 'composite');
			return;
		}
		// Main panel first, by width, so the order never depends on file names.
		const files = [...artwork.files].sort((left, right) => incomingArtworkWidth(artwork, right) - incomingArtworkWidth(artwork, left));
		setArtworkLayout('main-side');
		setImageInputMode('separate');
		setEditorFiles(files);
		void updateEditorPreview(activeEditor, files, 'separate', 'main-side');
	}

	function selectWorkshopFiles(event: ChangeEvent<HTMLInputElement>) {
		const selected = [...(event.target.files || [])];
		event.target.value = '';
		const target = workshopUploadTargetRef.current;
		workshopUploadTargetRef.current = null;
		if (!target || !selected.length) return;
		if (target.kind === 'row') void selectWorkshopRowFile(target.index, selected[0]);
		else void selectWorkshopPanels(target.index, selected);
	}

	function selectShowcaseFiles(event: ChangeEvent<HTMLInputElement>) {
		const selected = [...(event.target.files || [])];
		event.target.value = '';
		setShowcaseFiles(selected);
	}

	async function selectProfileBackgroundCrop() {
		if (!activeEditor) return;
		const url = getBackgroundUrl(backgroundImageUrl);
		if (!url) {
			setEditorError('No static profile background image is available to crop.');
			return;
		}
		setEditorLoading(true);
		setEditorProgress('Cropping the profile background...');
		setEditorError('');
		try {
			if (activeEditor.kind === 'workshop') {
				ensureWorkshopSlots(activeEditor, workshopRows * 5);
				setWorkshopShowcaseRows(activeEditor, workshopRows);
			}
			const files = await createBackgroundCropFiles(activeEditor, url, backgroundCropHeight, artworkLayout, workshopRows);
			const applied = activeEditor.kind === 'workshop'
				? await applyWorkshopSelection(activeEditor, files, workshopRows)
				: await updateArtwork(activeEditor, files, hasTwoPanelImageEditor(activeEditor.kind) ? 'separate' : 'composite', artworkLayout, workshopRows);
			if (!applied) return;
			activeEditor.element.dataset.steamcanvasTransparent = 'true';
			activeEditor.element.dataset.steamcanvasTransparentHeight = String(backgroundCropHeight);
			activeEditor.element.dataset.steamcanvasTransparentLayout = artworkLayout;
			activeEditor.element.dataset.steamcanvasTransparentRows = String(workshopRows);
			applyTransparentCropPreviewHeight(activeEditor, backgroundCropHeight);
			setEditorError('');
			setShowcaseExportError(null);
			setEditingId(null);
		} catch (caught) {
			setEditorError(caught instanceof Error ? caught.message : 'Could not crop the profile background.');
		} finally {
			setEditorProgress('');
			setEditorLoading(false);
		}
	}

	async function resizeTransparentBackground(entry: ShowcaseEntry, height: number, previousHeight: number): Promise<void> {
		const url = getBackgroundUrl(backgroundImageUrlRef.current);
		if (!url || backgroundResizeInProgressRef.current) return;
		const layout = entry.element.dataset.steamcanvasTransparentLayout === 'main-three-side' ? 'main-three-side' : 'main-side';
		const savedRows = Number(entry.element.dataset.steamcanvasTransparentRows);
		const rows: WorkshopRows = savedRows === 2 || savedRows === 3 ? savedRows : 1;
		backgroundResizeInProgressRef.current = true;
		setBackgroundResizingId(entry.id);
		setShowcaseExportError(null);
		try {
			const files = await createBackgroundCropFiles(entry, url, height, layout, rows);
			const applied = entry.kind === 'workshop'
				? await applyWorkshopSelection(entry, files, rows)
				: await updateArtwork(entry, files, hasTwoPanelImageEditor(entry.kind) ? 'separate' : 'composite', layout, rows);
			if (!applied) throw new Error('Could not update the transparent background artwork.');
			entry.element.dataset.steamcanvasTransparentHeight = String(height);
			applyTransparentCropPreviewHeight(entry, height);
		} catch (caught) {
			entry.element.dataset.steamcanvasTransparentHeight = String(previousHeight);
			applyTransparentCropPreviewHeight(entry, previousHeight);
			setShowcaseExportError({
				id: entry.id,
				message: caught instanceof Error ? caught.message : 'Could not resize the transparent background.',
			});
		} finally {
			backgroundResizeInProgressRef.current = false;
			setBackgroundResizingId(null);
		}
	}

	useEffect(() => {
		if (!previewDocument || !getBackgroundUrl(backgroundImageUrl)) return;
		let cancelled = false;
		const frame = globalThis.requestAnimationFrame(() => {
			void (async () => {
				for (const entry of entries) {
					if (entry.element.dataset.steamcanvasTransparent !== 'true') continue;
					const height = Number(entry.element.dataset.steamcanvasTransparentHeight);
					if (!Number.isFinite(height) || height <= 0) continue;
					while (backgroundResizeInProgressRef.current && !cancelled) {
						await new Promise((resolve) => globalThis.setTimeout(resolve, 50));
					}
					if (cancelled) return;
					await resizeTransparentBackground(entry, height, height);
				}
			})();
		});
		return () => {
			cancelled = true;
			globalThis.cancelAnimationFrame(frame);
		};
	}, [backgroundImageUrl, backgroundSize, entries.length, previewDocument]);

	async function applyWorkshopSelection(
		entry: ShowcaseEntry,
		selectedPanelFiles = workshopPanelFiles,
		rows: WorkshopRows = workshopRows,
	): Promise<boolean> {
		type WorkshopAsset = {
			url: string;
			exportUrl: string;
			name: string;
			animation?: { width: number; height: number; x: number; y: number; regionHeight: number };
			animatedArtwork?: { name: string; url: string };
		};
		const assets = new Map<number, WorkshopAsset>();
		const animatedMosaicSources: NonNullable<ShowcaseEntry['mosaicSources']> = [];
		try {
			for (let row = 0; row < rows; row += 1) {
				const rowFile = workshopRowFiles[row];
				if (rowFile) {
					setEditorProgress(`Preparing row ${row + 1}...`);
					const mosaic = await splitWorkshopMosaic(rowFile);
					if (mosaic.animated) animatedMosaicSources.push({ startIndex: row * 5, name: rowFile.name, url: mosaic.images[0] });
					const baseName = sourceName(rowFile).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').slice(0, 80) || 'steam-workshop';
					const gifPanels = mosaic.animated?.format === 'gif'
						? await encodeAnimatedMosaic(rowFile, mosaic.animated)
						: [];
					for (let panel = 0; panel < 5; panel += 1) {
						const index = row * 5 + panel;
						const region = mosaic.animated
							? {
								width: mosaic.animated.width,
								height: mosaic.animated.height,
								x: mosaic.animated.panelWidths?.slice(0, panel).reduce((sum, width) => sum + width, 0) || 0,
								y: 0,
								regionHeight: mosaic.animated.height,
							}
							: undefined;
						const animatedApng = mosaic.animated?.format === 'apng'
							? { name: sourceName(rowFile), url: mosaic.images[panel] }
							: undefined;
						assets.set(index, {
							url: mosaic.images[panel],
							exportUrl: gifPanels[panel] || mosaic.images[panel],
							name: `${baseName}-${index + 1}.${gifPanels.length ? 'gif' : 'png'}`,
							...(region ? { animation: region } : {}),
							...(animatedApng ? { animatedArtwork: animatedApng } : {}),
						});
					}
				}
				for (let panel = 0; panel < 5; panel += 1) {
					const index = row * 5 + panel;
					const file = selectedPanelFiles[index];
					if (!file) continue;
					setEditorProgress(`Preparing panel ${index + 1} of ${rows * 5}...`);
					const url = await readImageFile(file);
					const baseName = sourceName(file).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').slice(0, 80) || `workshop-panel-${index + 1}`;
					assets.set(index, {
						url,
						exportUrl: url,
						name: `${baseName}.${getImageExtension(file)}`,
					});
				}
			}
			if (!assets.size) return false;
			ensureWorkshopSlots(entry, rows * 5);
			const images = getShowcaseImages(entry.element, entry.kind);
			for (const [index, asset] of assets) {
				const image = images[index];
				if (!image) continue;
				const anchor = image.closest<HTMLAnchorElement>('a');
				image.src = asset.url;
				image.dataset.steamcanvasArtwork = 'true';
				image.closest<HTMLElement>('[data-steamcanvas-empty-slot]')?.removeAttribute('data-steamcanvas-empty-slot');
				anchor?.setAttribute('href', asset.url);
				image.style.display = 'block';
				image.style.width = '100%';
				image.style.maxWidth = '100%';
				image.style.minHeight = '0';
				image.style.objectFit = 'fill';
				image.style.transformOrigin = 'top left';
				if (asset.animation && anchor) {
					anchor.style.display = 'block';
					anchor.style.overflow = 'hidden';
					anchor.style.height = `${asset.animation.regionHeight}px`;
					anchor.style.width = '100%';
					image.style.width = `${asset.animation.width}px`;
					image.style.height = `${asset.animation.height}px`;
					image.style.maxWidth = 'none';
					image.style.transform = asset.animation.x || asset.animation.y
						? `translate(${-asset.animation.x}px, ${-asset.animation.y}px)`
						: 'none';
				} else {
					image.style.height = 'auto';
					image.style.transform = 'none';
					if (anchor) {
						anchor.style.display = 'block';
						anchor.style.width = '100%';
						anchor.style.height = '';
						anchor.style.overflow = 'hidden';
					}
				}
			}
			setWorkshopShowcaseRows(entry, rows);
			entry.element.dataset.steamcanvasWorkshopRows = String(rows);
			const animatedArtwork = [...assets.values()].find((asset) => asset.animatedArtwork)?.animatedArtwork;
			setEntries((current) => current.map((item) => {
				if (item.id !== entry.id) return item;
				const exportFiles = [...(item.exportFiles || [])];
				for (const [index, asset] of assets) exportFiles[index] = { name: asset.name, url: asset.exportUrl };
				const changedRows = new Set([...assets.keys()].map((index) => Math.floor(index / 5)));
				const mosaicSources = [
					...(item.mosaicSources || []).filter((source) => !changedRows.has(Math.floor(source.startIndex / 5))),
					...animatedMosaicSources,
				];
				return {
					...item,
					exportFiles: exportFiles.filter((file): file is { name: string; url: string } => !!file),
					animatedArtwork,
					mosaicSources: mosaicSources.length ? mosaicSources : undefined,
				};
			}));
			setEditorError('');
			setError('');
			return true;
		} catch (caught) {
			setEditorError(caught instanceof Error ? caught.message : 'Could not prepare the Workshop panels.');
			return false;
		}
	}

	function setShowcaseFiles(selected: File[]) {
		if (!activeEditor) return;
		const isWorkshopRows = activeEditor.kind === 'workshop' && workshopRows > 1 && selected.length === workshopRows;
		const separate = selected.length === editorPanelCount && editorPanelCount > 1;
		const mode: ImageInputMode = isWorkshopRows ? 'workshop-rows' : separate ? 'separate' : 'composite';
		const validSingleImage = selected.length === 1 && !(activeEditor.kind === 'workshop' && workshopRows > 1);
		const validSelection = validSingleImage || separate || isWorkshopRows;
		if (!validSelection) {
			setImageInputMode('composite');
			setEditorFiles([]);
			setEditorPreview([]);
			setUploadButtonPreview(null);
			setEditorError(activeEditor.kind === 'workshop' && workshopRows > 1
				? `Choose ${workshopRows} images (one per row) or exactly ${editorPanelCount} ready-made panels.`
				: `Choose one complete image or exactly ${editorPanelCount} separate panels.`);
			return;
		}
		setImageInputMode(mode);
		const files = separate
			? Array.from({ length: editorPanelCount }, (_, index) => selected[index] || null)
			: selected;
		setEditorFiles(files);
		setUploadButtonPreview(null);
		setEditorError('');
		void updateEditorPreview(activeEditor, files, mode);
	}

	function togglePublicScreenshot(screenshot: PublicScreenshot) {
		if (!activeEditor || activeEditor.kind !== 'screenshot') return;
		const publicLayout: ArtworkLayout = 'main-three-side';
		if (artworkLayout !== publicLayout) setArtworkLayout(publicLayout);
		const current = editorFiles.filter((source): source is PublicScreenshot => !!source && isPublicScreenshot(source));
		const publicPanelCount = getMosaicPanelCount(activeEditor.kind, publicLayout);
		if (!current.some((item) => item.id === screenshot.id) && current.length >= publicPanelCount) return;
		const next = current.some((item) => item.id === screenshot.id)
			? current.filter((item) => item.id !== screenshot.id)
			: current.length < publicPanelCount ? [...current, screenshot] : current;
		setImageInputMode('public');
		setEditorFiles(next);
		setUploadButtonPreview(next[0]?.thumbnailUrl || null);
		setEditorError('');
		void updateEditorPreview(activeEditor, next, 'public');
	}

	async function applyEditorChanges() {
		if (!activeEditor) return;
		if (activeEditor.kind === 'workshop' && imageInputMode === 'workshop-custom') {
			setEditorLoading(true);
			try {
				if (await applyWorkshopSelection(activeEditor)) setEditingId(null);
			} finally {
				setEditorLoading(false);
				setEditorProgress('');
			}
			return;
		}
		const files = editorFiles.filter((file): file is EditorSource => file !== null);
		if (files.length !== expectedEditorFiles || editorLoading || editorError) return;
		setEditorLoading(true);
		try {
			const applied = await updateArtwork(activeEditor, files, imageInputMode);
			if (applied) setEditingId(null);
		} finally {
			setEditorLoading(false);
			setEditorProgress('');
		}
	}

	// layout and rows default to the open editor's state; receive mode passes its own.
	async function updateArtwork(entry: ShowcaseEntry, files: EditorSource[], mode: ImageInputMode, layout: ArtworkLayout = artworkLayout, rows: WorkshopRows = workshopRows): Promise<boolean> {
		if (!files.length) return false;
		if (files.some((file) => !isPublicScreenshot(file) && !/^image\/(png|jpeg|webp|gif|avif|apng)$/.test(file.type))) {
			setEditorError('Choose PNG, JPG, WEBP, GIF, APNG, or AVIF images.');
			return false;
		}
		const panelCount = getMosaicPanelCount(entry.kind, layout, rows);
		const workshopRowUploads = mode === 'workshop-rows' && entry.kind === 'workshop' && rows > 1 && files.length === rows && files.every((file) => !isPublicScreenshot(file));
		const separateUploads = mode === 'separate' && panelCount > 1 && files.length === panelCount;
		if (!workshopRowUploads && files.length !== 1 && !separateUploads && mode !== 'public') {
			setEditorError(entry.kind === 'workshop' && rows > 1
				? `Choose ${rows} images (one per row) or exactly ${panelCount} ready-made panels.`
				: `Choose one complete image or exactly ${panelCount} separate panels.`);
			return false;
		}
		if (hasTwoPanelImageEditor(entry.kind)) {
			const rightColumn = entry.element.querySelector<HTMLElement>('.screenshot_showcase_rightcol');
			if (rightColumn) {
				const sideSlots = [...rightColumn.querySelectorAll<HTMLElement>('.screenshot_showcase_smallscreenshot.showcase_slot')];
				for (let index = sideSlots.length; index < panelCount - 1; index += 1) {
					rightColumn.insertBefore(makeImageSlot(entry.element.ownerDocument, 'screenshot_showcase_smallscreenshot showcase_slot', 100), rightColumn.querySelector('.screenshot_count'));
				}
			}
		}
		ensureWorkshopSlots(entry, panelCount);
		const images = getShowcaseImages(entry.element, entry.kind);
		try {
			let exportWarning = false;
			const fullResolutionImages = files.every(isPublicScreenshot)
				? await (async () => {
					const images: string[] = [];
					for (const [index, file] of files.entries()) {
						setEditorProgress(`Loading screenshot ${index + 1} of ${files.length}...`);
						if (file.fullImageUrl) {
							images.push(file.fullImageUrl);
							continue;
						}
						const response = await fetch('/api/screenshot-image', {
							method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steamUrl: file.steamUrl }),
						});
						const result = await response.json() as { imageUrl?: string; error?: string };
						if (!response.ok || !result.imageUrl) throw new Error(result.error || 'Could not load the full-resolution screenshot.');
						images.push(result.imageUrl);
					}
					setEditorProgress('Applying screenshots...');
					return images;
				})()
				: undefined;
			const mosaic = files.every(isPublicScreenshot)
				? { images: fullResolutionImages as string[] }
				: workshopRowUploads
					? await splitWorkshopRows(files.filter((file): file is File => !isPublicScreenshot(file)))
				: separateUploads
				? { images: await Promise.all(files.map((file) => readImageFile(file as File)) ) }
				: hasTwoPanelImageEditor(entry.kind)
				? await splitArtworkMosaic(files[0] as File, layout)
				: entry.kind === 'workshop'
					? await splitWorkshopMosaic(files[0] as File)
					: { images: [await new Promise<string>((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read artwork image.'));
					reader.onerror = () => reject(new Error('Could not read artwork image.'));
					reader.readAsDataURL(files[0] as File);
				})] };
			if (workshopRowUploads && mosaic.animatedRows?.some((row) => row.mosaic.format === 'apng')) {
				setEditorError('Multi-row Workshop exports support static images and GIFs. Convert APNG files to GIF or use static images.');
				return false;
			}
			const encodedWorkshopRows = workshopRowUploads
				? await Promise.all((mosaic.animatedRows || []).map(async (row) => ({
					startIndex: row.startIndex,
					panels: await encodeAnimatedMosaic(row.file, row.mosaic),
				})))
				: [];
			let encodedMosaicGif: string[] = [];
			let mosaicGifEncodingError: string | null = null;
			if (!workshopRowUploads && mosaic.animated?.format === 'gif') {
				try {
					encodedMosaicGif = await encodeAnimatedMosaic(files[0] as File, mosaic.animated);
				} catch (caught) {
					mosaicGifEncodingError = caught instanceof Error ? caught.message : 'GIF export could not be completed.';
				}
			}
			const encodedPanelUrls = new Map<number, string>();
			encodedMosaicGif.forEach((url, index) => encodedPanelUrls.set(index, url));
			encodedWorkshopRows.forEach(({ startIndex, panels }) => panels.forEach((url, index) => encodedPanelUrls.set(startIndex + index, url)));
			for (const [index, dataUrl] of mosaic.images.entries()) {
				const image = images[index];
				if (!image) break;
				const encodedPanelUrl = encodedPanelUrls.get(index);
				const encodedPreviewPanelUrl = entry.kind === 'workshop' ? undefined : encodedPanelUrl;
				const animatedRow = mosaic.animatedRows?.find((row) => index >= row.startIndex && index < row.startIndex + 5);
				const animation = encodedPreviewPanelUrl ? undefined : animatedRow?.mosaic || mosaic.animated;
				const animationPanelIndex = animatedRow ? index - animatedRow.startIndex : index;
				const anchor = image.closest<HTMLAnchorElement>('a');
				const panelUrl = encodedPreviewPanelUrl || dataUrl;
				image.src = panelUrl;
				image.style.height = animation ? `${animation.height}px` : 'auto';
				if (!animation) {
					image.style.display = 'block';
					image.style.width = '100%';
					image.style.maxWidth = '100%';
					image.style.minHeight = '0';
					image.style.objectFit = 'fill';
					image.style.transform = 'none';
					image.style.transformOrigin = 'top left';
					if (anchor) {
						anchor.style.display = '';
						anchor.style.width = '';
						anchor.style.height = '';
						anchor.style.overflow = '';
					}
				}
				if (entry.kind === 'featured-artwork' && !animation) fitFeaturedImage(image);
				image.closest<HTMLElement>('[data-steamcanvas-empty-slot]')?.removeAttribute('data-steamcanvas-empty-slot');
				anchor?.setAttribute('href', panelUrl);
				if (entry.kind === 'workshop') {
					image.style.display = 'block';
					image.style.width = '100%';
					image.style.maxWidth = '100%';
					image.style.minHeight = '0';
					image.style.objectFit = 'fill';
					image.style.transformOrigin = 'top left';
					if (anchor) {
						anchor.style.display = 'block';
						anchor.style.width = '100%';
						anchor.style.overflow = 'hidden';
					}
					if (!animation) {
						image.style.height = 'auto';
						image.style.transform = 'none';
					}
				}
				if (animation && anchor) {
					anchor.style.display = 'block';
					anchor.style.overflow = 'hidden';
					const panelRegions = animation.panelRegions || (animation.panelWidths || [animation.mainWidth, animation.width - animation.mainWidth]).map((width, panelIndex, widths) => ({
						x: widths.slice(0, panelIndex).reduce((total, value) => total + value, 0), y: 0, width, height: animation.height,
					}));
					const region = panelRegions[animationPanelIndex];
					anchor.style.height = `${region.height}px`;
					anchor.style.width = entry.kind === 'workshop' || index === 0 ? '100%' : `${region.width}px`;
					image.style.width = `${animation.width}px`;
					image.style.height = `${animation.height}px`;
					image.style.maxWidth = 'none';
					image.style.minHeight = '0';
					image.style.objectFit = 'fill';
					image.style.transform = region.x || region.y ? `translate(${-region.x}px, ${-region.y}px)` : 'none';
					image.style.transformOrigin = 'top left';
				}
			}
			if (entry.kind === 'workshop') {
				setWorkshopShowcaseRows(entry, rows);
				entry.element.dataset.steamcanvasWorkshopRows = String(rows);
			}
			if (hasTwoPanelImageEditor(entry.kind)) {
				const sideSlots = [...entry.element.querySelectorAll<HTMLElement>('.screenshot_showcase_smallscreenshot.showcase_slot')];
				const panelCount = getMosaicPanelCount(entry.kind, layout);
				sideSlots.slice(panelCount - 1).forEach((slot) => slot.remove());
				entry.element.dataset.steamcanvasMosaic = 'true';
				entry.element.dataset.steamcanvasMosaicPanels = String(panelCount);
				entry.element.dataset.steamcanvasPublicScreenshots = files.every(isPublicScreenshot) ? 'true' : 'false';
				if (files.every(isPublicScreenshot)) {
					entry.element.dataset.steamcanvasPublicScreenshotIds = JSON.stringify(files.map((file) => file.id));
					entry.element.dataset.steamcanvasPublicScreenshotData = JSON.stringify(files.map(({ id, imageUrl, thumbnailUrl, steamUrl, searchText, appid, aspectRatio }) => ({ id, imageUrl, thumbnailUrl, steamUrl, searchText, appid, aspectRatio })));
				} else {
					delete entry.element.dataset.steamcanvasPublicScreenshotIds;
					delete entry.element.dataset.steamcanvasPublicScreenshotData;
				}
				const baseName = sourceName(files[0]).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').slice(0, 80) || (entry.kind === 'screenshot' ? 'steam-screenshot' : 'steam-artwork');
				if (mosaic.animated?.format === 'gif') {
					if (encodedMosaicGif.length) {
						setEntries((current) => current.map((item) => item.id !== entry.id ? item : {
							...item,
							exportFiles: encodedMosaicGif.map((url, index) => ({ name: `${baseName}-${index === 0 ? 'main' : panelCount === 2 ? 'side' : `side-${index}`}.gif`, url })),
							animatedArtwork: undefined,
							mosaicSources: [{ startIndex: 0, name: sourceName(files[0]), url: mosaic.images[0] }],
						}));
					} else {
						setEntries((current) => current.map((item) => item.id !== entry.id ? item : {
							...item,
							exportFiles: undefined,
							animatedArtwork: { name: sourceName(files[0]), url: mosaic.images[0] },
							mosaicSources: [{ startIndex: 0, name: sourceName(files[0]), url: mosaic.images[0] }],
						}));
						exportWarning = true;
						setError(`${mosaicGifEncodingError || 'GIF export could not be completed.'} The original animated file is available to download.`);
					}
				} else if (mosaic.animated) {
					setEntries((current) => current.map((item) => item.id !== entry.id ? item : {
						...item,
						exportFiles: undefined,
						animatedArtwork: { name: sourceName(files[0]), url: mosaic.images[0] },
						mosaicSources: [{ startIndex: 0, name: sourceName(files[0]), url: mosaic.images[0] }],
					}));
				} else {
					setEntries((current) => current.map((item) => item.id !== entry.id ? item : {
						...item,
						exportFiles: mosaic.images.map((url, index) => ({
							name: `${baseName}-${index === 0 ? 'main' : panelCount === 2 ? 'side' : `side-${index}`}.${separateUploads && !isPublicScreenshot(files[index]) ? getImageExtension(files[index]) : 'png'}`,
							url,
						})),
						animatedArtwork: undefined,
						mosaicSources: undefined,
					}));
				}
			}
			if (entry.kind === 'workshop') {
				const baseName = sourceName(files[0]).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').slice(0, 80) || 'steam-workshop';
				if (workshopRowUploads) {
					const animatedPanelUrls = new Map<number, string>();
					encodedWorkshopRows.forEach(({ startIndex, panels }) => panels.forEach((url, index) => animatedPanelUrls.set(startIndex + index, url)));
					setEntries((current) => current.map((item) => item.id !== entry.id ? item : {
						...item,
						exportFiles: mosaic.images.map((url, index) => ({
							name: `${baseName}-${index + 1}.${animatedPanelUrls.has(index) ? 'gif' : 'png'}`,
							url: animatedPanelUrls.get(index) || url,
						})),
						animatedArtwork: undefined,
						mosaicSources: (mosaic.animatedRows || []).map((row) => ({
							startIndex: row.startIndex,
							name: row.file.name,
							url: mosaic.images[row.startIndex],
						})),
					}));
				} else if (mosaic.animated?.format === 'gif') {
					if (encodedMosaicGif.length) {
						setEntries((current) => current.map((item) => item.id !== entry.id ? item : {
							...item,
							exportFiles: encodedMosaicGif.map((url, index) => ({ name: `${baseName}-${index + 1}.gif`, url })),
							animatedArtwork: undefined,
							mosaicSources: [{ startIndex: 0, name: sourceName(files[0]), url: mosaic.images[0] }],
						}));
					} else {
						setEntries((current) => current.map((item) => item.id !== entry.id ? item : {
							...item,
							exportFiles: undefined,
							animatedArtwork: { name: sourceName(files[0]), url: mosaic.images[0] },
							mosaicSources: [{ startIndex: 0, name: sourceName(files[0]), url: mosaic.images[0] }],
						}));
						exportWarning = true;
						setError(`${mosaicGifEncodingError || 'GIF export could not be completed.'} The original animated file is available to download.`);
					}
				} else if (mosaic.animated) {
					setEntries((current) => current.map((item) => item.id !== entry.id ? item : {
						...item,
						exportFiles: undefined,
						animatedArtwork: { name: sourceName(files[0]), url: mosaic.images[0] },
						mosaicSources: [{ startIndex: 0, name: sourceName(files[0]), url: mosaic.images[0] }],
					}));
				} else {
					setEntries((current) => current.map((item) => item.id !== entry.id ? item : {
						...item,
						exportFiles: mosaic.images.map((url, index) => ({ name: `${baseName}-${index + 1}.${separateUploads && !isPublicScreenshot(files[index]) ? getImageExtension(files[index]) : 'png'}`, url })),
						animatedArtwork: undefined,
						mosaicSources: undefined,
					}));
				}
			}
			if (entry.kind === 'featured-artwork') {
				const baseName = sourceName(files[0]).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').slice(0, 80) || 'featured-artwork';
				setEntries((current) => current.map((item) => item.id !== entry.id ? item : {
					...item,
					exportFiles: [{ name: `${baseName}.${getImageExtension(files[0] as File)}`, url: mosaic.images[0] }],
					animatedArtwork: undefined,
					mosaicSources: undefined,
				}));
			}
			if (!exportWarning) {
				setError('');
				setEditorError('');
			}
			return true;
		} catch (caught) {
			setEditorError(caught instanceof Error ? caught.message : 'Could not prepare these images.');
			return false;
		}
	}

	// Receive mode: places GIFs from Steam Artwork Studio in a matching showcase once the profile
	// preview has been scanned. An existing showcase of the right type is reused; otherwise one is
	// added. The Studio's parts are already cut to Steam's sizes, so they go in as ready-made panels.
	useEffect(() => {
		if (!incomingArtwork || !previewDocument || entriesDocument !== previewDocument) return;
		if (appliedIncomingIdRef.current === incomingArtwork.id) return;
		appliedIncomingIdRef.current = incomingArtwork.id;

		const kind: CreatableShowcaseKind = incomingArtwork.preset === 'workshop'
			? 'workshop'
			: incomingArtwork.preset === 'featured' ? 'featured-artwork' : 'artwork';
		const rows = incomingArtwork.preset === 'workshop' ? incomingArtwork.workshopRows : 1;
		// Main panel first: the Studio names it _part_01, but order by width so it never depends on names.
		const files = kind === 'artwork'
			? [...incomingArtwork.files].sort((left, right) => incomingArtworkWidth(incomingArtwork, right) - incomingArtworkWidth(incomingArtwork, left))
			: incomingArtwork.files;
		const mode: ImageInputMode = kind === 'featured-artwork' ? 'composite' : 'separate';

		void (async () => {
			const entry = entries.find((item) => item.kind === kind) || createShowcase(kind);
			if (!entry) {
				onIncomingArtworkApplied?.({ ok: false, message: 'This profile has no showcase area SteamCanvas can add to.' });
				return;
			}
			setEditingId(null);
			if (kind === 'workshop') setWorkshopRows(rows);
			if (kind === 'artwork') setArtworkLayout('main-side');
			const applied = await updateArtwork(entry, files, mode, 'main-side', rows);
			if (applied) {
				scrollToShowcase(entry.element);
				onIncomingArtworkApplied?.({ ok: true, showcaseTitle: entry.title });
			} else {
				onIncomingArtworkApplied?.({ ok: false, message: 'SteamCanvas could not place these GIFs. Open the showcase editor and select the files from the Studio ZIP instead.' });
			}
		})();
	// Runs once per handoff when the scanned entries are ready; later entry changes must not re-apply it.
	}, [incomingArtwork, previewDocument, entriesDocument]);

	const buttonStyle: CSSProperties = {
		minHeight: '30px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', padding: '0 9px',
		border: '1px solid rgba(167,139,250,.38)', borderRadius: '3px', background: 'rgba(29,24,38,.96)',
		color: '#f2eff8', cursor: 'pointer', font: '12px Arial,sans-serif', whiteSpace: 'nowrap',
	};
	const screenshotPreviewHeight = Math.max(1, Math.round(506 * (editorPreview[0]?.height || 284) / (editorPreview[0]?.width || 506)));
	const previewPanelSize = (index: number) => activeEditor?.kind === 'screenshot'
		? index === 0
			? { src: editorPreview[index]?.src || '', width: 506, height: screenshotPreviewHeight }
			: { src: editorPreview[index]?.src || '', width: 100, height: editorPanelCount === 4 ? Math.max(1, Math.round((screenshotPreviewHeight - 8) / 3)) : screenshotPreviewHeight }
		: editorPreview[index] || (activeEditor?.kind === 'workshop'
		? { src: '', width: 126, height: 56 }
		: index === 0 ? { src: '', width: activeEditor?.kind === 'featured-artwork' ? 630 : 506, height: 284 } : { src: '', width: 100, height: 56 });
	const previewSizes = Array.from({ length: editorPanelCount }, (_, index) => previewPanelSize(index));
	const workshopRowWidths = Array.from({ length: workshopRows }, (_, row) => previewSizes.slice(row * 5, row * 5 + 5).reduce((sum, panel) => sum + panel.width, 0));
	const workshopRowHeights = Array.from({ length: workshopRows }, (_, row) => Math.max(...previewSizes.slice(row * 5, row * 5 + 5).map((panel) => panel.height)));
	const previewWidth = activeEditor?.kind === 'workshop' ? Math.max(...workshopRowWidths) : activeEditor?.kind === 'featured-artwork' ? previewSizes[0].width : previewSizes[0].width + (previewSizes[1]?.width || 100);
	const previewHeight = activeEditor?.kind === 'workshop'
		? workshopRowHeights.reduce((sum, height) => sum + height, 4 * (workshopRows - 1))
		: editorPanelCount === 4
			? Math.max(previewSizes[0].height, previewSizes.slice(1).reduce((sum, panel) => sum + panel.height, 0) + 8)
			: Math.max(...previewSizes.map((panel) => panel.height));
	const previewAspectRatio = previewWidth / Math.max(1, previewHeight);
	const previewRenderWidth = Math.min(480, 390 * previewAspectRatio);
	const isAnimatedPreview = (imageInputMode === 'composite' || imageInputMode === 'workshop-rows' || (imageInputMode === 'workshop-custom' && activeEditor?.kind === 'workshop'))
		&& editorFiles.some((file) => !!file && !isPublicScreenshot(file) && /\.(gif|apng)$/i.test(file.name));
	const publicScreenshotMatches = publicScreenshots.filter((screenshot) => !publicScreenshotSearch.trim() || `${screenshot.searchText || ''} ${screenshot.id} ${screenshot.steamUrl}`.toLowerCase().includes(publicScreenshotSearch.trim().toLowerCase()));
	const publicScreenshotPageSize = publicScreenshotExpanded ? 9 : 6;
	const publicScreenshotPageCount = Math.max(1, Math.ceil(publicScreenshotMatches.length / publicScreenshotPageSize));
	const visiblePublicScreenshots = publicScreenshotMatches.slice(publicScreenshotPage * publicScreenshotPageSize, (publicScreenshotPage + 1) * publicScreenshotPageSize);
	const previewStyle: CSSProperties = {
		width: `min(100%, ${previewRenderWidth}px)`,
		aspectRatio: `${previewWidth} / ${previewHeight}`,
		gridTemplateColumns: activeEditor?.kind === 'workshop'
			? 'repeat(5, minmax(0, 1fr))'
			: activeEditor?.kind === 'featured-artwork' ? '1fr' : `${previewSizes[0].width}fr ${previewSizes[1]?.width || 100}fr`,
		gridTemplateRows: activeEditor?.kind === 'workshop' ? `repeat(${workshopRows}, auto)` : undefined,
	};
	const renderPreviewPanel = (index: number, label: string, extraClass = '') => <div className={`showcase-editor-preview-panel ${extraClass}`} key={index} style={{ aspectRatio: `${previewPanelSize(index).width} / ${previewPanelSize(index).height}` }}>
		<span>{label}</span>
		{editorPreview[index]?.src ? <img src={editorPreview[index].src} alt={`Preview ${label.toLowerCase()}`} /> : <div className="showcase-editor-preview-empty">{editorLoading ? 'Preparing preview...' : 'Preview appears here'}</div>}
	</div>;
	const renderWorkshopPanel = (index: number) => {
		const row = Math.floor(index / 5);
		return <button
			key={index}
			type="button"
			className={`showcase-editor-preview-panel showcase-editor-workshop-panel${workshopPanelFiles[index] ? ' has-upload' : ''}`}
			style={{ aspectRatio: `${previewPanelSize(index).width} / ${previewPanelSize(index).height}` }}
			aria-label={`Add image${5 - index % 5 > 1 ? ' or images' : ''} starting at row ${row + 1}, panel ${index % 5 + 1}`}
			title="Click to add one or more panel images, starting here"
			disabled={editorLoading}
			onClick={() => requestWorkshopUpload({ kind: 'panels', index })}
		>
			<span>Row {row + 1} · {index % 5 + 1}</span>
			{editorPreview[index]?.src ? <img src={editorPreview[index].src} alt="" /> : <div className="showcase-editor-preview-empty">{editorLoading ? 'Preparing...' : <><ImagePlus size={15} /><small>Add image</small></>}</div>}
			{workshopPanelFiles[index] && <i className="showcase-editor-workshop-selected" aria-label="Panel image selected" />}
		</button>;
	};
	const renderOverlay = (entry: ShowcaseEntry, host: HTMLElement) => {
		const canExport = !!getExportableEntry(entry, entries.findIndex((item) => item.id === entry.id));
		const isExporting = exportingShowcaseId === entry.id || exportingShowcaseId === 'all';
		const transparentHeight = Number(entry.element.dataset.steamcanvasTransparentHeight) || DEFAULT_TRANSPARENT_HEIGHT;
		return createPortal(
		<div className="showcase-overlay" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', outline: dragTargetShowcaseId === entry.id ? '3px solid #c9ef73' : hoveredShowcaseId === entry.id ? '2px solid rgba(201,239,115,.9)' : undefined, outlineOffset: '-2px', background: dragTargetShowcaseId === entry.id ? 'rgba(196,243,106,.1)' : hoveredShowcaseId === entry.id ? 'rgba(196,243,106,.035)' : undefined, transition: 'outline-color .12s ease, background .12s ease' }}>
			<div className="showcase-overlay-actions" style={{ position: 'absolute', top: '5px', right: '5px', display: 'flex', alignItems: 'center', gap: '6px', padding: '3px', borderRadius: '4px', background: 'rgba(12,17,21,.78)', backdropFilter: 'blur(4px)', pointerEvents: 'auto' }}>
				<button type="button" style={buttonStyle} title={`Edit ${entry.title}`} aria-label={`Edit ${entry.title}`} onClick={() => openEditor(entry)}><Pencil size={14} />Edit</button>
				{canExport && <button type="button" style={{ ...buttonStyle, width: '30px', padding: 0, justifyContent: 'center' }} title={isExporting ? 'Preparing showcase ZIP...' : `Download ${entry.title} as ZIP`} aria-label={`Download ${entry.title} as ZIP`} disabled={!!exportingShowcaseId} onClick={() => void exportSingleShowcase(entry)}>{isExporting ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}</button>}
				<button type="button" style={{ ...buttonStyle, width: '30px', padding: 0, justifyContent: 'center', color: '#ffc0b5' }} title={`Remove ${entry.title}`} aria-label={`Remove ${entry.title}`} onClick={() => { removeShowcase(entry); if (editingId === entry.id) setEditingId(null); }}><Trash2 size={14} /></button>
			</div>
			{entry.element.dataset.steamcanvasTransparent === 'true' && <button
				className="showcase-transparent-resize"
				type="button"
				data-steamcanvas-showcase-controls="transparent-resize"
				disabled={backgroundResizingId === entry.id}
				title="Drag up or down to resize transparent background height"
				aria-label={`Transparent background height ${transparentHeight} pixels. Drag up or down to resize.`}
				onPointerDown={(event) => {
					if (event.button !== 0 || backgroundResizingId) return;
					event.preventDefault();
					event.stopPropagation();
					const handle = event.currentTarget;
					const startHeight = Number(entry.element.dataset.steamcanvasTransparentHeight) || DEFAULT_TRANSPARENT_HEIGHT;
					transparentResizeRef.current = {
						entry,
						pointerId: event.pointerId,
						startY: event.clientY,
						startHeight,
						outputWidth: getShowcaseOutputWidth(entry),
						displayWidth: Math.max(1, getShowcaseDisplayWidth(entry)),
						handle,
					};
					try {
						handle.setPointerCapture(event.pointerId);
					} catch {
						transparentResizeRef.current = null;
					}
				}}
			>
				{backgroundResizingId === entry.id ? <LoaderCircle size={14} className="spin" /> : <GripHorizontal size={15} />}
				<span data-transparent-height>{transparentHeight}px</span>
			</button>}
			{showcaseExportError?.id === entry.id && <div role="alert" style={{ position: 'absolute', top: '42px', right: '5px', maxWidth: '220px', padding: '5px 7px', borderRadius: '3px', background: 'rgba(80,24,20,.94)', color: '#fff', font: '11px Arial,sans-serif', pointerEvents: 'auto' }}>{showcaseExportError.message}</div>}
		</div>, host, entry?.id || 'showcase-add-controls');
	};
	const renderAddControl = (host: HTMLElement, menuHost: HTMLElement) => {
		const rect = host.getBoundingClientRect();
		const menuWidth = Math.min(330, globalThis.innerWidth - 24);
		const left = addDrawerLeft ?? Math.max(12, Math.min(rect.right + 10, globalThis.innerWidth - menuWidth - 12));
		const top = addDrawerTop ?? Math.max(12, Math.min(rect.top - 5, globalThis.innerHeight - 350));
		const options: Array<{ kind: CreatableShowcaseKind; title: string; description: string; icon: typeof ImagePlus }> = [
			{ kind: 'artwork', title: 'Artwork showcase', description: 'Split one image into Steam showcase panels', icon: ImagePlus },
			{ kind: 'featured-artwork', title: 'Featured artwork', description: 'One large image as the centrepiece', icon: Star },
			{ kind: 'screenshot', title: 'Screenshot showcase', description: 'Choose from this profile or upload art', icon: Camera },
			{ kind: 'workshop', title: 'Workshop showcase', description: 'Split one image across five Workshop slots', icon: Hammer },
		];
		return <>
			{createPortal(
				<div className="showcase-add-control">
					<button type="button" className="showcase-add-trigger" title="Add showcase" aria-label="Add showcase" aria-expanded={addingOpen} onClick={() => { setAddingOpen((open) => !open); setEditingId(null); }}>
						<Plus size={15} /><span>Add showcase</span>
					</button>
				</div>, host, 'showcase-add-controls')}
			{addingOpen && createPortal(
				<section ref={addMenuRef} className="showcase-add-drawer" style={{ left, top }} aria-label="Available showcases" onClick={(event) => event.stopPropagation()}>
					<header>
						<div><span>SHOWCASE LIBRARY</span><h2>Add to profile</h2></div>
						<button type="button" className="showcase-add-close" aria-label="Close showcase library" onClick={() => setAddingOpen(false)}><X size={17} /></button>
					</header>
					<div className="showcase-add-options">
						{options.map(({ kind, title, description, icon: Icon }) => <button key={kind} type="button" className="showcase-add-option" onClick={() => addShowcase(kind)}>
							<span className="showcase-add-option-icon"><Icon size={18} /></span>
							<span><strong>{title}</strong><small>{description}</small></span>
							<Plus className="showcase-add-option-plus" size={15} />
						</button>)}
					</div>
					{error && <p className="showcase-add-error" role="alert">{error}</p>}
				</section>, menuHost, 'showcase-add-drawer')}
		</>;
	};
	const renderTrash = (host: HTMLElement) => createPortal(
		<div className="showcase-trash-control">
			{trashOpen && <section className="showcase-trash-popover" aria-label="Removed original showcases">
				<header><strong>Removed originals</strong><span>{removedShowcases.length}</span></header>
				{removedShowcases.length ? <div className="showcase-trash-list">
					{removedShowcases.map((showcase) => <div className="showcase-trash-item" key={showcase.key}>
						<span title={showcase.title}>{showcase.title}</span>
						<button type="button" title={`Restore ${showcase.title}`} aria-label={`Restore ${showcase.title}`} onClick={() => restoreRemovedShowcase(showcase)}><RotateCcw size={14} /></button>
					</div>)}
				</div> : <p>No removed showcases.</p>}
			</section>}
			<button
				className={`showcase-trash-button${trashOpen ? ' is-open' : ''}`}
				type="button"
				title="Removed original showcases"
				aria-label={`Removed original showcases, ${removedShowcases.length} items`}
				aria-expanded={trashOpen}
				onClick={() => setTrashOpen((open) => !open)}
			>
				<Trash2 size={21} />
				{removedShowcases.length > 0 && <span>{removedShowcases.length}</span>}
			</button>
		</div>, host, 'showcase-trash');

	if (!previewDocument) return null;
	return <>
		{entries.map((entry) => renderOverlay(entry, entry.host))}
		{addControlHost && addMenuHost && renderAddControl(addControlHost, addMenuHost)}
		{trashHost && removedShowcases.length > 0 && renderTrash(trashHost)}
		<dialog
			ref={editorDialogRef}
			className="showcase-editor-dialog"
			aria-labelledby="showcase-editor-title"
			onClose={() => setEditingId(null)}
			onCancel={(event) => { event.preventDefault(); if (!editorLoading) setEditingId(null); }}
			onClick={(event) => { if (event.target === event.currentTarget && !editorLoading) setEditingId(null); }}
		>
			{activeEditor && <div className="showcase-editor-content">
				<header className="showcase-editor-header">
					<div><span className="source-label">SHOWCASE EDITOR</span><h2 id="showcase-editor-title">{activeEditor.title}</h2></div>
					<button className="icon-button" type="button" aria-label="Close editor" title={editorLoading ? 'Please wait until the operation finishes' : 'Close editor'} disabled={editorLoading} onClick={() => setEditingId(null)}><X size={17} /></button>
				</header>
				{activeEditor.kind !== 'other' && <>
					<div className="showcase-editor-layout">
						<div className="showcase-editor-preview" aria-busy={editorLoading}>
							<div className="showcase-editor-preview-heading"><strong>Preview</strong><span>{isAnimatedPreview ? 'GIF · first frame' : activeEditor.kind === 'featured-artwork' ? 'Single image' : activeEditor.kind === 'workshop' ? `${workshopRows} row${workshopRows === 1 ? '' : 's'} · ${editorPanelCount} panels` : `${editorPanelCount} panels`}</span></div>
							<div className={`showcase-editor-preview-panels ${activeEditor.kind === 'workshop' ? 'is-workshop' : activeEditor.kind === 'featured-artwork' ? 'is-featured' : editorPanelCount === 4 ? 'is-four-panel' : 'is-two-panel'}`} style={previewStyle}>
								{activeEditor.kind === 'workshop'
									? Array.from({ length: editorPanelCount }, (_, index) => renderWorkshopPanel(index))
									: editorPanelCount === 4
										? <>{renderPreviewPanel(0, 'Main')}<div className="showcase-editor-preview-side-stack">{[1, 2, 3].map((index) => renderPreviewPanel(index, `Side ${index}`, 'is-side'))}</div></>
										: editorPanelCount === 2
											? <>{renderPreviewPanel(0, 'Main')}{renderPreviewPanel(1, 'Side')}</>
											: renderPreviewPanel(0, 'Featured image')}
							</div>
						</div>
						<aside className="showcase-editor-controls">
							{activeEditor.kind === 'workshop' && maxWorkshopRows >= 2 && <div className="showcase-editor-control-group">
								<span className="showcase-editor-label">LAYOUT</span>
								<div className="showcase-editor-layout-choice" role="group" aria-label="Workshop showcase layout">
								{Array.from({ length: maxWorkshopRows }, (_, index) => (index + 1) as WorkshopRows).map((rows) => <button key={rows} className={workshopRows === rows ? 'is-active' : ''} type="button" aria-pressed={workshopRows === rows} onClick={() => {
										setWorkshopRows(rows);
										const hasSelection = workshopRowFiles.slice(0, rows).some(Boolean) || workshopPanelFiles.slice(0, rows * 5).some(Boolean);
										setImageInputMode(hasSelection ? 'workshop-custom' : 'composite');
										setEditorFiles([
											...workshopRowFiles.slice(0, rows).filter((file): file is File => !!file),
											...workshopPanelFiles.slice(0, rows * 5).filter((file): file is File => !!file),
										]);
										setEditorError('');
									}}>
										<span className={`showcase-layout-icon is-workshop-${rows}`} aria-hidden="true">{Array.from({ length: rows * 5 }, (_, index) => <i key={index} />)}</span>
										<span className="showcase-layout-copy"><strong>{rows} × 5</strong><small>{rows === 1 ? 'One image · 5 slots' : `${rows} images · ${rows * 5} slots`}</small></span>
									</button>)}
								</div>
							</div>}
							{activeEditor.kind === 'workshop' && <div className="showcase-editor-control-group">
								<span className="showcase-editor-label">ROW ARTWORK</span>
								<div className="showcase-editor-workshop-rows">
									{Array.from({ length: workshopRows }, (_, row) => {
										const selectedPanels = workshopPanelFiles.slice(row * 5, row * 5 + 5).filter(Boolean).length;
										const rowFile = workshopRowFiles[row];
										return <button
											key={row}
											className="showcase-editor-upload showcase-editor-workshop-row-button"
											type="button"
											disabled={editorLoading}
											onClick={() => requestWorkshopUpload({ kind: 'row', index: row })}
										>
											{rowFile && workshopRowPreviews[row]
												? <img className="showcase-editor-workshop-row-thumb" src={workshopRowPreviews[row] || undefined} alt="" />
												: <ImagePlus size={17} />}
											<span>
												<strong>{rowFile ? `Replace row ${row + 1} image` : `Choose image for row ${row + 1}`}</strong>
												<small>{rowFile ? sourceName(rowFile) : selectedPanels ? `${selectedPanels} of 5 panels filled individually` : 'One image split across all 5 panels'}</small>
											</span>
										</button>;
									})}
								</div>
								<p className="showcase-editor-workshop-hint">Or click a panel in the preview to add one or more images starting there.</p>
								<input
									ref={workshopFileInputRef}
									className="visually-hidden"
									type="file"
									multiple
									accept="image/png,image/jpeg,image/webp,image/gif,image/apng,image/avif"
									onChange={selectWorkshopFiles}
								/>
							</div>}
							{(activeEditor.kind === 'artwork' || activeEditor.kind === 'screenshot') && <div className="showcase-editor-control-group"><span className="showcase-editor-label">LAYOUT</span><div className="showcase-editor-layout-choice" role="group" aria-label="Showcase layout">
								<button className={artworkLayout === 'main-side' ? 'is-active' : ''} type="button" aria-pressed={artworkLayout === 'main-side'} onClick={() => { setArtworkLayout('main-side'); setEditorFiles([]); setEditorPreview([]); setUploadButtonPreview(null); setEditorError(''); }}><span className="showcase-layout-icon is-two"><i /><i /></span><span className="showcase-layout-copy"><strong>Main + side</strong><small>2 panels</small></span></button>
								<button className={artworkLayout === 'main-three-side' ? 'is-active' : ''} type="button" aria-pressed={artworkLayout === 'main-three-side'} onClick={() => { setArtworkLayout('main-three-side'); setEditorFiles([]); setEditorPreview([]); setUploadButtonPreview(null); setEditorError(''); }}><span className="showcase-layout-icon is-four"><i /><i /><i /><i /></span><span className="showcase-layout-copy"><strong>Main + 3 sides</strong><small>4 panels</small></span></button>
							</div></div>}
							<div className="showcase-editor-control-group">
								<button className="avatar-upload-button showcase-editor-background-crop" type="button" disabled={editorLoading || !getBackgroundUrl(backgroundImageUrl)} onClick={() => void selectProfileBackgroundCrop()}>
									{editorLoading ? <LoaderCircle size={14} className="spin" /> : <ImagePlus size={14} />}
									{editorLoading ? 'Preparing...' : 'Transparent background'}
								</button>
								{!getBackgroundUrl(backgroundImageUrl) && <small className="showcase-background-crop-copy">Choose a static profile background first.</small>}
							</div>
							{activeEditor.kind === 'screenshot' && <div className={`showcase-public-picker ${publicScreenshotExpanded ? 'is-expanded' : ''}`}>
								<div className="showcase-editor-label">PUBLIC SCREENSHOTS</div>
								<p className="showcase-public-picker-copy">Choose up to {editorPanelCount} screenshots from this profile. They stay whole in the showcase slots.</p>
								{publicScreenshotsLoading && !publicScreenshots.length ? <div className="showcase-public-picker-status" role="status" aria-live="polite"><LoaderCircle size={14} className="spin" aria-hidden="true" />Loading public screenshots...</div> : publicScreenshots.length ? <>
									<div className="showcase-public-toolbar">
										{publicScreenshotExpanded && <input autoFocus className="showcase-public-search" type="search" value={publicScreenshotSearch} onChange={(event) => { setPublicScreenshotSearch(event.target.value); setPublicScreenshotPage(0); }} placeholder="Search screenshots" aria-label="Search public screenshots" />}
										<button className="showcase-public-expand" type="button" aria-label={publicScreenshotExpanded ? 'Close screenshot browser' : 'Open screenshot browser'} title={publicScreenshotExpanded ? 'Close screenshot browser' : 'Browse and search screenshots'} onClick={() => { setPublicScreenshotExpanded((expanded) => !expanded); setPublicScreenshotPage(0); }}><Search size={15} /></button>
									</div>
									<div className="showcase-public-grid">
									{visiblePublicScreenshots.map((screenshot) => {
										const selectedIndex = editorFiles.findIndex((source) => !!source && isPublicScreenshot(source) && source.id === screenshot.id);
										return <button key={screenshot.id} type="button" className={`showcase-public-item ${selectedIndex >= 0 ? 'is-selected' : ''}`} aria-pressed={selectedIndex >= 0} title={selectedIndex >= 0 ? `Selected as slot ${selectedIndex + 1}` : 'Use this screenshot'} onClick={() => togglePublicScreenshot(screenshot)}>
											<img src={screenshot.thumbnailUrl} alt="" /><span>{selectedIndex >= 0 ? `Slot ${selectedIndex + 1}` : 'Select'}</span>
										</button>;
									})}
									</div>
									{publicScreenshotExpanded && <div className="showcase-public-pagination"><button type="button" aria-label="Previous screenshot page" title="Previous page" disabled={publicScreenshotPage === 0} onClick={() => setPublicScreenshotPage((page) => Math.max(0, page - 1))}><ChevronLeft size={14} /></button><span>{publicScreenshotPage + 1} / {publicScreenshotPageCount}</span><button type="button" aria-label="Next screenshot page" title="Next page" disabled={publicScreenshotPage >= publicScreenshotPageCount - 1} onClick={() => setPublicScreenshotPage((page) => Math.min(publicScreenshotPageCount - 1, page + 1))}><ChevronRight size={14} /></button></div>}
									{publicScreenshotExpanded && <div className="showcase-public-count">{publicScreenshotMatches.length} screenshots loaded{publicScreenshotHasMore ? ' · more available' : ''}</div>}
									{publicScreenshotExpanded && publicScreenshotHasMore && <button className="showcase-public-load-more" type="button" disabled={publicScreenshotsLoading} onClick={() => void loadPublicScreenshots(publicScreenshotNextPage, true)}>{publicScreenshotsLoading && <LoaderCircle size={13} className="spin" aria-hidden="true" />}{publicScreenshotsLoading ? 'Loading more...' : 'Load more screenshots'}</button>}
								</> : <div className="showcase-public-picker-status">No public screenshots were found on this profile.</div>}
							</div>}
							<StudioLibraryPicker key={activeEditor.id} kind={activeEditor.kind} disabled={editorLoading} onChoose={chooseStudioArtwork} />
							{activeEditor.kind !== 'workshop' && <label className={`showcase-editor-upload ${editorPanelCount > 1 ? 'is-multiple' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); setShowcaseFiles([...event.dataTransfer.files]); }}>
								{uploadButtonPreview ? <img className="showcase-editor-upload-thumb" src={uploadButtonPreview} alt="" /> : <ImagePlus size={19} />}
								<span>
									<strong>{editorFiles.filter(Boolean).length
										? imageInputMode === 'separate' || imageInputMode === 'public'
											? `${editorFiles.filter(Boolean).length} of ${editorPanelCount} panels ready`
											: sourceName(editorFiles[0] as EditorSource)
										: editorPanelCount > 1 ? 'Drop one image or choose ready-made panels' : 'Drop or choose an image'}</strong>
									<small>{editorPanelCount > 1
										? `One image is split to fit this Steam layout. Or select ${editorPanelCount} separate panels.`
										: 'Image or animated GIF'}</small>
									{(imageInputMode === 'separate' || imageInputMode === 'public') && editorFiles.filter(Boolean).length > 0 && <small className="showcase-editor-file-list">{editorFiles.filter((file): file is EditorSource => !!file).map(sourceName).join(' · ')}</small>}
								</span>
								<input type="file" multiple={editorPanelCount > 1} accept="image/png,image/jpeg,image/webp,image/gif,image/apng,image/avif" onChange={selectShowcaseFiles} />
							</label>}
						</aside>
					</div>
				</>}
				{editorProgress && <p className="showcase-editor-progress" role="status" aria-live="polite">{editorProgress}</p>}
				{editorError && <p className="showcase-editor-error" role="alert">{editorError}</p>}
				<footer className="showcase-editor-footer">
					<button className="showcase-editor-remove" type="button" onClick={() => { removeShowcase(activeEditor); setEditingId(null); }}><Trash2 size={15} /> Remove showcase</button>
					<button className="showcase-editor-cancel" type="button" disabled={editorLoading} onClick={() => setEditingId(null)}>Cancel</button>
					{activeEditor.kind !== 'other' && <button className="showcase-editor-apply" type="button" disabled={editorLoading || !!editorError || (activeEditor.kind === 'workshop' ? !workshopSelectionCount : editorFiles.filter(Boolean).length !== expectedEditorFiles)} onClick={() => void applyEditorChanges()}>{editorLoading ? 'Preparing...' : 'Apply to preview'}</button>}
				</footer>
			</div>}
		</dialog>
	</>;
}

async function readPreviewPanel(source: EditorSource): Promise<PreviewPanel> {
	const src = isPublicScreenshot(source) ? source.thumbnailUrl : await readImageFile(source);
	const image = new Image();
	image.src = src;
	await image.decode();
	return { src, width: image.naturalWidth || 16, height: image.naturalHeight || Math.round(16 / (isPublicScreenshot(source) ? source.aspectRatio || 1.7778 : 1.7778)) };
}

function cropImagePreview(image: HTMLImageElement, width: number, height: number, regions: Array<{ x: number; y: number; width: number; height: number }>): string[] {
	const composite = document.createElement('canvas');
	composite.width = width;
	composite.height = height;
	const context = composite.getContext('2d');
	if (!context) throw new Error('Could not prepare the image preview.');
	context.drawImage(image, 0, 0, width, height);
	return regions.map(({ x, y, width: panelWidth, height: panelHeight }) => {
		const panel = document.createElement('canvas');
		panel.width = panelWidth;
		panel.height = panelHeight;
		const panelContext = panel.getContext('2d');
		if (!panelContext) throw new Error('Could not prepare a panel preview.');
		panelContext.drawImage(composite, x, y, panelWidth, panelHeight, 0, 0, panelWidth, panelHeight);
		return panel.toDataURL('image/png');
	});
}