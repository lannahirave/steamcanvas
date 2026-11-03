// Copyright (C) 2026 dumbapplee
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, ImagePlus, LoaderCircle, RotateCcw, Search, Sparkles, Store, X } from 'lucide-react';
import { fetchWithRetry } from '../utils/fetchWithRetry';

export type SteamBackground = {
	id: string;
	name: string;
	game: string;
	price: string;
	imageUrl: string;
	steamUrl: string;
	animated?: boolean;
	videoPoster?: string;
	videoWebm?: string;
	videoMp4?: string;
};

type BackgroundResponse = {
	items: SteamBackground[];
	totalCount: number;
	pageSize: number;
	nextCursor?: string | null;
	catalogIndexed?: boolean;
	error?: string;
};

export type ProfileBackgroundSize = 'full' | 'original';

type BackgroundPickerProps = {
	sourceBackgroundImage: string;
	value: SteamBackground | null;
	onChange: (background: SteamBackground | null) => void;
	backgroundSize: ProfileBackgroundSize;
	onBackgroundSizeChange: (size: ProfileBackgroundSize) => void;
};

export default function BackgroundPicker({ sourceBackgroundImage, value, onChange, backgroundSize, onBackgroundSizeChange }: BackgroundPickerProps) {
	const [query, setQuery] = useState('');
	const [submittedQuery, setSubmittedQuery] = useState('');
	const [source, setSource] = useState<'market' | 'points'>('market');
	const [page, setPage] = useState(0);
	const [items, setItems] = useState<SteamBackground[]>([]);
	const [totalCount, setTotalCount] = useState(0);
	const [loading, setLoading] = useState(false);
	const [retryAttempt, setRetryAttempt] = useState(0);
	const [error, setError] = useState('');
	const [expanded, setExpanded] = useState(false);
	const [pointShopIndexed, setPointShopIndexed] = useState(false);
	const dialogRef = useRef<HTMLDialogElement>(null);
	const pointShopCursors = useRef<Array<string | null>>([null]);
	const pointShopIndexedRef = useRef(false);
	const requestSequence = useRef(0);
	const pageSize = source === 'market' ? 30 : 20;

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		if (expanded && !dialog.open) dialog.showModal();
		if (!expanded && dialog.open) dialog.close();
	}, [expanded]);

	useEffect(() => {
		if (!expanded) return;

		const controller = new AbortController();
		const requestId = ++requestSequence.current;
		let url: string;
		if (source === 'market') {
			url = `/api/backgrounds?${new URLSearchParams({ query: submittedQuery, start: String(page * pageSize), count: String(pageSize) })}`;
		} else {
			const params = new URLSearchParams();
			if (submittedQuery) params.set('query', submittedQuery);
			if (pointShopIndexedRef.current) params.set('page', String(page));
			else if (pointShopCursors.current[page]) params.set('cursor', pointShopCursors.current[page] || '');
			url = `/api/points-backgrounds${params.toString() ? `?${params}` : ''}`;
		}

		setLoading(true);
		setRetryAttempt(0);
		setError('');
		fetchWithRetry(url, { signal: controller.signal }, {
			maxRetries: source === 'market' ? 0 : 3,
			onRetry: setRetryAttempt,
		})
			.then(async (response) => {
				const result = await response.json() as BackgroundResponse;
				if (!response.ok) throw new Error(result.error || 'Could not load Steam backgrounds.');
				return result;
			})
			.then((result) => {
				if (controller.signal.aborted || requestSequence.current !== requestId) return;
				setItems([...new Map(result.items.map((item) => [item.id, item])).values()]);
				setTotalCount(result.totalCount);
				if (source === 'points') {
					pointShopIndexedRef.current = Boolean(result.catalogIndexed);
					setPointShopIndexed(pointShopIndexedRef.current);
					pointShopCursors.current[page + 1] = result.nextCursor || null;
				}
			})
			.catch((caught: unknown) => {
				if (controller.signal.aborted || requestSequence.current !== requestId) return;
				if (caught instanceof DOMException && caught.name === 'AbortError') return;
				setError(caught instanceof Error ? caught.message : 'Could not load Steam backgrounds.');
				setItems([]);
				setTotalCount(0);
			})
			.finally(() => {
				if (!controller.signal.aborted) {
					setLoading(false);
					setRetryAttempt(0);
				}
			});

		return () => controller.abort();
	}, [expanded, page, source, submittedQuery]);

	function changeSource(nextSource: 'market' | 'points') {
		setSource(nextSource);
		setPage(0);
		setItems([]);
		setTotalCount(0);
		setQuery('');
		setSubmittedQuery('');
		pointShopIndexedRef.current = false;
		setPointShopIndexed(false);
		pointShopCursors.current = [null];
	}

	function searchBackgrounds(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setPage(0);
		setItems([]);
		setTotalCount(0);
		pointShopIndexedRef.current = false;
		setPointShopIndexed(false);
		pointShopCursors.current = [null];
		setSubmittedQuery(query.trim());
	}

	const visibleItems = source === 'points' && submittedQuery
		? items.filter((item) => `${item.name} ${item.game}`.toLowerCase().includes(submittedQuery.toLowerCase()))
		: items;
	const pageCount = Math.ceil(totalCount / pageSize);
	const hasNextPage = source === 'market'
		? (page + 1) * pageSize < totalCount
		: pointShopIndexed ? page + 1 < pageCount : Boolean(pointShopCursors.current[page + 1]);
	const previewImage = value ? `url("${value.imageUrl}")` : sourceBackgroundImage;
	const currentName = value?.name || (sourceBackgroundImage && sourceBackgroundImage !== 'none' ? 'Current profile background' : 'No background on profile');
	const steamUrl = value?.steamUrl || (value?.id.startsWith('points:')
		? `https://store.steampowered.com/points/shop/app/${value.id.slice('points:'.length).split(':')[0]}`
		: value ? `https://steamcommunity.com/market/listings/753/${encodeURIComponent(value.id)}` : '');

	return (
		<section className="background-picker" aria-labelledby="background-picker-title">
			<div className="background-picker-heading">
				<span className="source-label" id="background-picker-title">PROFILE BACKGROUND</span>
				<button
					className="icon-button"
					type="button"
					title="Reset background"
					aria-label="Reset background"
					onClick={() => onChange(null)}
					disabled={!value}
				>
					<RotateCcw size={15} />
				</button>
			</div>

			<div className="background-current-row">
				<div className="background-current-preview" role="img" aria-label={currentName} style={{ backgroundImage: previewImage }} />
				<div className="background-current-actions">
					<span className="background-current-name" title={currentName}>{currentName}</span>
					<button className="avatar-upload-button" type="button" onClick={() => setExpanded(true)}>
						<ImagePlus size={14} /> Replace background
					</button>
						{steamUrl && <a className="steam-item-link" href={steamUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} /> View on Steam</a>}
				</div>
			</div>

			<fieldset className="background-size-picker">
				<legend>Background size</legend>
				<div className="background-size-options">
					<label>
						<input type="radio" name="background-size" checked={backgroundSize === 'full'} onChange={() => onBackgroundSizeChange('full')} />
						<span>Full size</span>
					</label>
					<label>
						<input type="radio" name="background-size" checked={backgroundSize === 'original'} onChange={() => onBackgroundSizeChange('original')} />
						<span>Original size</span>
					</label>
				</div>
			</fieldset>

			<dialog
				ref={dialogRef}
				className="background-dialog"
				aria-labelledby="background-dialog-title"
				onClose={() => setExpanded(false)}
				onCancel={(event) => { event.preventDefault(); setExpanded(false); }}
				onClick={(event) => { if (event.target === event.currentTarget) setExpanded(false); }}
			>
				<div className="background-dialog-content">
					<header className="background-dialog-header">
						<div>
							<span className="source-label">STEAM COMMUNITY</span>
							<h2 id="background-dialog-title">Profile backgrounds</h2>
							{value && <p className="background-selection" title={value.name}>Selected: {value.name}</p>}
						</div>
						<button className="icon-button" type="button" title="Close background search" aria-label="Close background search" onClick={() => setExpanded(false)}>
							<X size={18} />
						</button>
					</header>

					<div className="background-source-tabs" role="group" aria-label="Background source">
						<button className={source === 'market' ? 'is-active' : ''} type="button" aria-pressed={source === 'market'} onClick={() => changeSource('market')}>
							<Store size={15} /> Market
						</button>
						<button className={source === 'points' ? 'is-active' : ''} type="button" aria-pressed={source === 'points'} onClick={() => changeSource('points')}>
							<Sparkles size={15} /> Animated
						</button>
					</div>

					<form className="background-search is-large" onSubmit={searchBackgrounds}>
						<Search size={17} aria-hidden="true" />
						<input
							aria-label="Search Steam profile backgrounds"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={source === 'market' ? 'Search backgrounds' : 'Search animated backgrounds'}
							maxLength={80}
							autoFocus={expanded}
						/>
						<button type="submit" aria-label="Search backgrounds"><Search size={17} /></button>
					</form>

					{error && <p className="background-error" role="alert">{error}</p>}
					<div className="background-results is-expanded" aria-busy={loading}>
						{visibleItems.map((item) => (
							<button
								className={`background-option is-large ${value?.id === item.id ? 'is-selected' : ''}`}
								type="button"
								key={item.id}
								title={`${item.name}${item.price ? ` · ${item.price}` : ''}`}
								aria-label={`Preview ${item.name}${item.price ? `, ${item.price}` : ''}`}
								aria-pressed={value?.id === item.id}
								onClick={() => { onChange(item); setExpanded(false); }}
							>
								<img src={item.imageUrl} alt="" loading="lazy" />
								<span className="background-option-name">{item.name}</span>
								{item.price && <span className="background-option-price">{item.price}</span>}
							</button>
						))}
						{loading && <div className="background-loading"><span><LoaderCircle className="spin" size={24} />{source === 'market' ? ' Waiting for Steam...' : retryAttempt > 0 && ` Retrying (${retryAttempt}/3)`}</span></div>}
						{!loading && !error && visibleItems.length === 0 && <p className="background-empty">No matching backgrounds.</p>}
					</div>

					<div className="background-picker-footer is-large">
						<span>{totalCount.toLocaleString()} items</span>
						<div className="background-pagination">
							<button type="button" aria-label="Previous backgrounds" disabled={page === 0 || loading} onClick={() => setPage((current) => current - 1)}>
								<ChevronLeft size={18} />
							</button>
							<span>{pageCount ? `${page + 1} / ${pageCount.toLocaleString()}` : '0 / 0'}</span>
							<button type="button" aria-label="Next backgrounds" disabled={loading || !hasNextPage} onClick={() => setPage((current) => current + 1)}>
								<ChevronRight size={18} />
							</button>
						</div>
					</div>
				</div>
			</dialog>
		</section>
	);
}
