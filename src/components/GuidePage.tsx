// Copyright (C) 2026 dumbapplee
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Check, Copy, FileArchive, Image, Monitor, Terminal, Upload, X } from 'lucide-react';

type Guide = {
  slug: string;
  title: string;
  description: string;
  eyebrow: string;
  intro: string;
  steps: Array<{ title: string; body: ReactNode }>;
  checklist: string[];
  sourceUrl: string;
  sourceLabel: string;
};

const guides: Guide[] = [
  {
    slug: 'featured-artwork',
    title: 'Upload long Steam Artwork and Screenshot showcases',
    description: 'Follow the practical Steam upload workflow for long Artwork, Featured Artwork, and Screenshot showcase images.',
    eyebrow: 'STEAM PROFILE GUIDE · FEATURED ARTWORK',
    intro: 'This is the practical upload route for long Steam showcase images. It explains the legacy Community upload form, the dimensions expected by each showcase, and the browser-console values used to submit the image.',
    steps: [
      {
        title: 'Check that the showcase is available',
        body: 'Steam requires at least level 10 before an Artwork or Screenshot Showcase can be displayed. Choose the showcase type before preparing the file: a normal Artwork Showcase has a 506 px main image and a 100 px side image; use the same height for both if they must align. A Featured Artwork Showcase uses one 630 px-wide image. The height can be long.',
      },
      {
        title: 'Prepare and select the correct file',
        body: 'Use your own artwork at the width for the target showcase and avoid a tiny source image stretched into a long composition. Open SteamCanvas first if you want to preview the composition, then keep the original file separate from the upload copy.',
      },
      {
        title: 'Open Steam’s Community upload form',
        body: <>In Chrome or Firefox, open <a href="https://steamcommunity.com/sharedfiles/edititem/767/3" target="_blank" rel="noreferrer">Steam’s Community upload form</a> and select the image with <strong>Choose File</strong>. This is the form used by the workflow below; Steam can change or remove it without notice.</>,
      },
      {
        title: 'Set the upload values in Developer Tools',
        body: <><span>Open the browser console: <strong>Ctrl+Shift+J</strong> in Chrome or <strong>Ctrl+Shift+K</strong> in Firefox. Firefox may require you to type <code>allow pasting</code> manually before it accepts pasted commands.</span><strong className="guide-command-label">Artwork or Featured Artwork</strong><Command>$J('#image_width').val(1000).attr('id',''),$J('#image_height').val(1).attr('id','');</Command><strong className="guide-command-label">Screenshot Showcase</strong><Command>$J('#image_width').val(1000).attr('id',''),$J('#image_height').val(1).attr('id',''),$J('[name=file_type]').val(5);</Command></>,
      },
      {
        title: 'Save, place, and verify it',
        body: 'Add a title, confirm Steam’s creator certification only when it is truthful, then choose Save and Continue. In the artwork picker the new entry can initially look like a thin black line; that is expected in this workflow. Select it, add it to the intended showcase, and check the live profile after it loads.',
      },
    ],
    checklist: [
      'Steam account is level 10 or higher.',
      'Normal Artwork main image is 506 px wide; side image is 100 px wide.',
      'Featured Artwork image is 630 px wide.',
      'The correct Artwork/Featured or Screenshot console values were used.',
      'The published result has been selected in the intended Steam showcase.',
    ],
    sourceUrl: 'https://steamcommunity.com/sharedfiles/filedetails/?id=748624905',
    sourceLabel: 'Community reference: long images for Featured Artwork',
  },
  {
    slug: 'workshop-showcase',
    title: 'Upload long Steam Workshop Showcase images',
    description: 'Prepare, export, and upload the individual images required for a long Steam Workshop Showcase.',
    eyebrow: 'STEAM PROFILE GUIDE · WORKSHOP SHOWCASE',
    intro: 'A long Workshop Showcase is uploaded as individual panels. SteamCanvas splits the composition and performs the file preparation from the referenced workflow, so you only need to export, submit each panel, and place the published items on your profile.',
    steps: [
      {
        title: 'Confirm the layout and file ownership',
        body: <>Choose 1 × 5 for five Workshop slots, 2 × 5 for ten, or 3 × 5 for fifteen slots. Use source artwork or animations that you own and can export. Animated Workshop items also require accepting <a href="https://steamcommunity.com/sharedfiles/workshoplegalagreement" target="_blank" rel="noreferrer">Steam’s Workshop Legal Agreement</a> before an upload is possible.</>,
      },
      {
        title: 'Create the panels in SteamCanvas',
        body: 'Load the Workshop Showcase editor, add one source image for a 1 × 5 row or one image per row for a 2 × 5 or 3 × 5 layout. SteamCanvas splits them into five panels per row. You can also provide five, ten, or fifteen panels that have already been prepared.',
      },
      {
        title: 'Export the upload-ready Workshop ZIP',
        body: 'Use the Workshop export, not the generic showcase image download. For every panel in this ZIP, SteamCanvas applies the final-byte 0x21 preparation described by the reference guide. It retains unmodified copies separately for the local HTML preview, so do not upload those preview copies.',
      },
      {
        title: 'Open the Community upload form for each panel',
        body: <><span>For every exported panel, open <a href="https://steamcommunity.com/sharedfiles/edititem/767/3" target="_blank" rel="noreferrer">Steam’s Community upload form</a>, select the panel with <strong>Choose File</strong>, then open Developer Tools. Paste and run this command in the browser console:</span><Command>$J('[name=consumer_app_id]').val(480);$J('[name=file_type]').val(0);$J('[name=visibility]').val(0);</Command><span>It sets consumer app ID <strong>480</strong>, Workshop file type <strong>0</strong>, and visibility <strong>0</strong>. For a long Steam Guide instead of a Workshop item, replace the file-type value <code>0</code> with <code>9</code>.</span></>,
      },
      {
        title: 'Save all panels and assign them to the showcase',
        body: 'Choose Save and Continue for each image, then add the resulting published Workshop items to the matching profile slots in their left-to-right order. Repeat five, ten, or fifteen times to fill one, two, or three rows, and review the live profile for seams and ordering.',
      },
    ],
    checklist: [
      'The selected layout matches the number of Workshop slots on the profile.',
      'Steam Workshop Legal Agreement is accepted when uploading animations.',
      'The upload-ready Workshop ZIP, not a preview copy, is being used.',
      'Every panel uses the Community form with app ID 480, file type 0, and visibility 0.',
      'Five, ten, or fifteen published items were assigned in the correct order.',
    ],
    sourceUrl: 'https://steamcommunity.com/sharedfiles/filedetails/?id=2174159512',
    sourceLabel: 'Community reference: long Workshop and guide images',
  },
];

export function getGuideSlugForPath(pathname: string): string | null {
  const slug = pathname.match(/^\/guides\/([^/]+)\/?$/)?.[1];
  return guides.some((guide) => guide.slug === slug) ? slug ?? null : null;
}

const guideTabLabels: Record<string, string> = {
  'featured-artwork': 'Featured Artwork',
  'workshop-showcase': 'Workshop Showcase',
};

function Command({ children }: { children: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    globalThis.setTimeout(() => setCopyState('idle'), 1800);
  };

  return (
    <div className="guide-command">
      <code>{children}</code>
      <button type="button" onClick={() => void copy()} aria-label="Copy command">
        <Copy size={14} aria-hidden="true" />
        {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
      </button>
    </div>
  );
}

function GuideVisual({ workshop }: { workshop: boolean }) {
  const panels = workshop ? 5 : 1;

  return (
    <figure className={`guide-visual${workshop ? ' is-workshop' : ' is-featured'}`} aria-label={workshop ? 'Five-panel Workshop Showcase example' : 'Featured Artwork example'}>
      <div className="guide-visual-window">
        <div className="guide-visual-bar"><i /><i /><i /><span>steam profile preview</span></div>
        <div className="guide-visual-profile">
          <div className="guide-visual-avatar" />
          <div><b>{workshop ? 'Workshop showcase' : 'Featured artwork'}</b><small>your Steam profile</small></div>
        </div>
        <div className="guide-visual-artwork">
          {Array.from({ length: panels }, (_, index) => <span key={index}><em>{workshop ? String(index + 1).padStart(2, '0') : '630 PX'}</em></span>)}
        </div>
        <div className="guide-visual-caption">{workshop ? 'one image, split into five panels' : 'one long image, any height'}</div>
      </div>
      <figcaption><Image size={14} /> {workshop ? 'Workshop 1 × 5 example' : 'Featured Artwork example'}</figcaption>
    </figure>
  );
}

function StepIcon({ index }: { index: number }) {
  const Icon = [Monitor, Image, Upload, Terminal, FileArchive][index] || Check;
  return <Icon size={18} aria-hidden="true" />;
}

export default function GuideDialog({ slug, onSlugChange, onClose }: { slug: string | null; onSlugChange: (slug: string) => void; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const guide = guides.find((item) => item.slug === slug) ?? guides[0];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (slug && !dialog.open) dialog.showModal();
    if (!slug && dialog.open) dialog.close();
  }, [slug]);

  return (
    <dialog
      ref={dialogRef}
      className="guide-dialog"
      aria-labelledby="guide-dialog-title"
      onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) dialogRef.current?.close(); }}
    >
      <div className="guide-dialog-content">
        <header className="guide-dialog-header">
          <nav className="guide-switch" aria-label="Guides">
            {guides.map((item) => (
              <button key={item.slug} type="button" aria-pressed={item.slug === guide.slug} onClick={() => onSlugChange(item.slug)}>
                {guideTabLabels[item.slug] ?? item.slug}
              </button>
            ))}
          </nav>
          <button className="icon-button guide-close" type="button" aria-label="Close guide" onClick={() => dialogRef.current?.close()}><X size={17} /></button>
        </header>

      <article className="guide-content">
        <header className="guide-hero">
          <div className="guide-hero-copy">
            <p className="guide-eyebrow">{guide.eyebrow}</p>
            <h1 id="guide-dialog-title">{guide.title}</h1>
            <p>{guide.intro}</p>
            <div className="guide-actions">
              <button className="guide-cta" type="button" onClick={() => dialogRef.current?.close()}>Back to the editor <ArrowUpRight size={16} /></button>
              <a className="guide-source-link" href={guide.sourceUrl} target="_blank" rel="noreferrer">Original community guide <ArrowUpRight size={14} /></a>
            </div>
          </div>
          <GuideVisual workshop={guide.slug === 'workshop-showcase'} />
        </header>

        <section className="guide-examples" aria-labelledby="guide-examples-title">
          <div>
            <p className="guide-section-label">WHAT YOU ARE MAKING</p>
            <h2 id="guide-examples-title">{guide.slug === 'workshop-showcase' ? 'A single scene across every panel.' : 'One artwork that fits the showcase.'}</h2>
          </div>
          <ul>
            {guide.checklist.slice(0, 3).map((item) => <li key={item}><Check size={16} aria-hidden="true" />{item}</li>)}
          </ul>
        </section>

        <section className="guide-section" aria-labelledby="guide-steps-title">
          <div className="guide-section-heading">
            <div>
              <p className="guide-section-label">THE UPLOAD FLOW</p>
              <h2 id="guide-steps-title">From artwork to Steam.</h2>
            </div>
            <span>{guide.steps.length} steps</span>
          </div>
          <ol className="guide-steps">
            {guide.steps.map((step, index) => (
              <li key={step.title}>
                <div className="guide-step-icon"><StepIcon index={index} /></div>
                <div>
                  <span className="guide-step-number">Step {String(index + 1).padStart(2, '0')}</span>
                  <h3>{step.title}</h3>
                  <div className="guide-step-body">{step.body}</div>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <footer className="guide-footer">
          <p>SteamCanvas is an independent preview and export tool. It does not sign in to Steam or publish changes to your account.</p>
          <p>Steam and Workshop behaviour can change; always check the live result before sharing it. See the <a href={guide.sourceUrl} target="_blank" rel="noreferrer">{guide.sourceLabel}</a> for the source workflow.</p>
        </footer>
      </article>
      </div>
    </dialog>
  );
}
