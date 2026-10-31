// Copyright (C) 2026 dumbapplee
// Modified by lannahirave, 2026: moved from server/index.ts for the Cloudflare Worker.
// SPDX-License-Identifier: AGPL-3.0-only

// The slim build uses htmlparser2 only. The full build pulls in undici for fromURL, which does not
// run in a Worker.
import { load } from 'cheerio/slim';
import { steamHost } from './steam';

export type PublicScreenshot = {
  id: string;
  imageUrl: string;
  thumbnailUrl: string;
  steamUrl: string;
  searchText?: string;
  appid?: number;
  aspectRatio?: number;
};

export function resolveProfileUrl(input: unknown): URL {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Enter a SteamID64, custom profile name, or full profile URL.');
  }

  const value = input.trim();
  if (/^\d{17}$/.test(value)) return new URL(`/profiles/${value}`, `https://${steamHost}`);

  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new Error('That does not look like a valid Steam profile address.');
  }

  if (parsed.hostname !== steamHost && parsed.hostname !== `www.${steamHost}`) {
    if (value.includes('/') || value.includes(':')) {
      throw new Error('Use a steamcommunity.com profile URL or enter only the custom profile name.');
    }
    return new URL(`/id/${encodeURIComponent(value)}`, `https://${steamHost}`);
  }

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || !['id', 'profiles'].includes(parts[0])) {
    throw new Error('Use a Steam profile URL in the form /id/name or /profiles/SteamID64.');
  }
  if (parts[0] === 'profiles' && !/^\d{17}$/.test(parts[1])) {
    throw new Error('The SteamID64 in that profile URL must contain 17 digits.');
  }
  if (parts[0] === 'id' && !/^[\w-]{1,64}$/.test(decodeURIComponent(parts[1]))) {
    throw new Error('That custom profile name contains unsupported characters.');
  }

  return new URL(`/${parts[0]}/${encodeURIComponent(decodeURIComponent(parts[1]))}`, `https://${steamHost}`);
}

export function extractFullScreenshotUrl(html: string, pageUrl: string): string | undefined {
  const candidates = [...html.matchAll(/https:\/\/images\.steamusercontent\.com\/ugc\/[^"'<>\s]+/gi)]
    .map((match) => match[0].replace(/&amp;/g, '&'))
    .map((value) => {
      try {
        const url = new URL(value, pageUrl);
        return url.hostname === 'images.steamusercontent.com' ? url : undefined;
      } catch {
        return undefined;
      }
    })
    .filter((url): url is URL => !!url)
    .sort((left, right) => Number(right.searchParams.get('imw') || 0) - Number(left.searchParams.get('imw') || 0));
  return candidates[0]?.href;
}

export function extractPublicScreenshots(html: string, pageUrl: string): PublicScreenshot[] {
  const $ = load(html);
  const screenshots: PublicScreenshot[] = [];
  $('a.profile_media_item[data-publishedfileid]').each((_, element) => {
    if (screenshots.length >= 50) return;
    const item = $(element);
    const id = item.attr('data-publishedfileid');
    const rawImage = item.find('.imgWallItem').first().attr('style')?.match(/background-image\s*:\s*url\(['"]?([^'"\)]+)['"]?\)/i)?.[1];
    if (!id || !rawImage) return;
    try {
      const thumbnailUrl = new URL(rawImage, pageUrl);
      if (thumbnailUrl.hostname !== 'images.steamusercontent.com') return;
      const imageUrl = new URL(thumbnailUrl.href);
      imageUrl.search = '';
      imageUrl.hash = '';
      const aspectRatio = Number(item.attr('data-desired-aspect'));
      screenshots.push({
        id,
        imageUrl: imageUrl.href,
        thumbnailUrl: thumbnailUrl.href,
        steamUrl: new URL(item.attr('href') || `/sharedfiles/filedetails/?id=${id}`, pageUrl).href,
        searchText: `Screenshot ${id} App ${item.attr('data-appid') || ''}`,
        ...(Number.isInteger(Number(item.attr('data-appid'))) ? { appid: Number(item.attr('data-appid')) } : {}),
        ...(Number.isFinite(aspectRatio) && aspectRatio > 0 ? { aspectRatio } : {}),
      });
    } catch {
      // Ignore malformed or non-public screenshot URLs.
    }
  });
  return screenshots;
}

export function makeInertDocument(html: string, pageUrl: string): { html: string; name: string; avatar?: string; level?: number } {
  const $ = load(html);
  $('#global_header').remove();
  $('script, iframe, object, embed').remove();
  $('*').each((_, element) => {
    if (!('attribs' in element)) return;
    for (const attribute of Object.keys(element.attribs)) {
      if (attribute.toLowerCase().startsWith('on')) $(element).removeAttr(attribute);
    }
  });
  $('base').remove();
  $('head').prepend(`<base href="${new URL('/', pageUrl).href}">`);

  const name = $('#personaName').text().trim()
    || $('.actual_persona_name').first().text().trim()
    || $('title').text().trim()
    || 'Steam profile';
  const levelText = $('.profile_header_badgeinfo .friendPlayerLevelNum').first().text().trim();
  const level = /^\d+$/.test(levelText) ? Number(levelText) : undefined;
  const avatarImages = $('.playerAvatarAutoSizeInner img, .playerAvatar img').toArray();
  const avatarSource = $('meta[property="og:image"]').attr('content')
    || $('meta[name="twitter:image"]').attr('content')
    || avatarImages.map((image) => {
      const candidate = $(image).attr('src')
        || $(image).attr('data-src')
        || $(image).attr('srcset')?.split(',')[0]?.trim().split(/\s+/)[0];
      return candidate && new URL(candidate, pageUrl).hostname === 'avatars.fastly.steamstatic.com' ? candidate : undefined;
    }).find(Boolean);
  const avatar = avatarSource ? new URL(avatarSource, pageUrl).href : undefined;

  return { html: $.html(), name, ...(avatar ? { avatar } : {}), ...(level !== undefined ? { level } : {}) };
}
