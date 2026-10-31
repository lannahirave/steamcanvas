# Steam Artwork Studio integration

This fork of [dumbapplee/steamcanvas](https://github.com/dumbapplee/steamcanvas) is deployed as the
profile preview for [Steam Artwork Studio](https://artworkstudio.lannahirave.com). A user converts a
video in the Studio, clicks **Preview on my Steam profile**, and sees the converted GIFs in the real
showcase slots of their own public Steam profile.

| Part | Where |
| --- | --- |
| Profile preview (this fork) | `https://preview.lannahirave.com`, Cloudflare Worker `steamcanvas` |
| Steam Artwork Studio | `https://artworkstudio.lannahirave.com`, Cloudflare Worker `steam-artwork-studio` |
| Fork source | https://github.com/lannahirave/steamcanvas |

## 1. Hosting

The upstream server is Node and Express (`server/index.ts`). The fork runs on Cloudflare instead, next to
the Studio, as a Worker (`worker/`):

- Express is replaced by plain `fetch` handlers and `axios` by `fetch`. The frontend is served as static
  Worker assets.
- The in-memory `Map` cache is replaced by the Cache API. Worker instances do not keep memory between
  requests, so a `Map` would not survive. A per-instance map still joins identical requests that run at
  the same time.
- Steam retries are shorter than upstream (fewer attempts, shorter backoff) to fit Worker time limits.
- **Request headers differ from upstream.** From `wrangler dev` (October 2026), Steam answered the same
  request differently than it did for the Node server:
  - profile pages: `429` for upstream's short `User-Agent` without `Accept-Language`, `200` with a
    complete browser-like set (full Chrome `User-Agent`, `Accept`, `Accept-Language`);
  - `/sharedfiles/filedetails/` (full-size screenshots): `429` for any browser `User-Agent`, `200`
    with no `User-Agent`;
  - Community Market search: `429` for any browser `User-Agent`, `200` with none.

  `worker/steam.ts` and `worker/index.ts` send headers to match. **This has not been tested from
  Cloudflare's production network**, where Steam may treat requests differently again. Check the
  profile, screenshot and Market routes right after the first deploy, and watch the Worker logs for
  `Profile request failed`.
- The `/guides/:slug` title and description rewrite is kept: the Worker reads `index.html` from the
  assets and rewrites it.
- The optional PostgreSQL catalog index and unique-profile metric are dropped. `GET /api/catalog-status`
  and `GET /api/profile-metrics` answer `503` as upstream does when `DATABASE_URL` is unset.

`server/index.ts` stays in the repository unchanged, so upstream changes can still be merged and
compared. The Worker is what is deployed.

## 2. The handoff: getting the Studio's GIFs into SteamCanvas

The Studio needs `crossOriginIsolated` for FFmpeg (`app/web/src/lib/browserSupport.ts`), so its
`COOP: same-origin` and `COEP: require-corp` headers stay. Because of that:

- **Opening the preview in a new tab and sending files** does not work: COOP cuts the link between the
  two windows.
- **Embedding the preview in the Studio** does not work either. Under COEP, the Steam CSS and images
  inside it would be blocked unless SteamCanvas proxied all of them.

**What works is a small bridge page.** Both subdomains are on the same site (`lannahirave.com`), so the
browser does not partition storage between them, and an iframe from the Studio can read the Studio's own
IndexedDB. The converted GIFs are saved for this session in IndexedDB and reused from there.
(`sessionStorage` cannot be used: it is per tab, per origin, and too small for GIFs.)

1. **Studio:** when the user clicks **Preview on my Steam profile**, it saves the parts plus a small
   manifest (preset, Workshop row count, file names, sizes) to IndexedDB (`steam-artwork-handoff`) under a
   random handoff ID. The button is a plain link to `https://preview.lannahirave.com/?handoff=<id>`
   opened in a new tab; a plain link works fine under COOP. Saving starts on the click, so nothing is
   stored unless the user asks for a preview.
2. **Studio:** a `/bridge/` page (`bridge/index.html`, a second Vite entry) is served with different headers from the rest of the app:
   - no COEP and no COOP;
   - `frame-ancestors https://preview.lannahirave.com` in place of `'none'`;
   - no `X-Frame-Options: DENY`.

   This page reads that one handoff from IndexedDB and sends the files to its parent with `postMessage`,
   addressed only to `https://preview.lannahirave.com` (the browser drops the message for any other
   parent). It deletes the handoff when SteamCanvas confirms that it applied it. Handoffs that are never
   picked up expire after 24 hours, and at most 5 are kept.
3. **SteamCanvas:** when it sees `?handoff=`, it loads a hidden iframe of
   `https://artworkstudio.lannahirave.com/bridge/?id=…`, checks the sender's origin, and receives the
   files.

The GIFs never leave the user's computer, so the Studio's "never uploaded" claim still holds. Safari's
tracking prevention can still block a storage iframe even on the same site, so there is a fallback: if
the bridge reports that storage is blocked or the handoff is missing, SteamCanvas says so and the user
downloads the ZIP from the Studio and selects the files in the showcase editor.

### Message protocol (version 1)

All messages are plain objects with `source: 'steam-artwork-studio'` or `source: 'steamcanvas'` and a
`version: 1` field.

| From | `type` | Payload |
| --- | --- | --- |
| bridge → SteamCanvas | `handoff` | `{ id, preset, workshopRows, sourceName, createdAt, files: [{ name, type, width, height, blob }] }` |
| bridge → SteamCanvas | `handoff-error` | `{ id, reason: 'not-found' \| 'expired' \| 'storage-unavailable' }` |
| SteamCanvas → bridge | `handoff-consumed` | `{ id }` (the bridge then deletes the record) |

`preset` is the Studio preset: `workshop` (5, 10 or 15 parts), `showcase` (Artwork Showcase: main 506 px
and side 100 px parts) or `featured` (one 630 px GIF). The Studio's `guide` preset has no place on a
profile, so it gets no preview button.

### Origins

| Setting | Production | Local development |
| --- | --- | --- |
| Studio `VITE_PROFILE_PREVIEW_ORIGIN` and Worker var `PROFILE_PREVIEW_ORIGIN` | `https://preview.lannahirave.com` | `http://localhost:5180` |
| SteamCanvas `VITE_ARTWORK_STUDIO_ORIGIN` | `https://artworkstudio.lannahirave.com` | `http://localhost:5173` |

`localhost:5173` and `localhost:5180` are the same site (ports are ignored), so the bridge works in
local development too.

## 3. Changes in the SteamCanvas fork

**To make it work:**

- **Receive mode:** `updateArtwork` in `ShowcaseEditor.tsx` takes the layout and Workshop row count as
  arguments, so received files go through the same code as manual uploads.
- **Ask for the profile:** after a handoff, SteamCanvas still needs the user to enter their profile (or
  resume their draft). Then it creates or reuses the matching showcase:
  - Workshop: the 5/10/15 parts as ready-made panels, set to the right row count;
  - Artwork: main and side panels, skipping SteamCanvas's own split (the Studio's are already cut);
  - Featured: one image.
- **Unpatched copies:** the Studio sends the parts without the `0x21` end-byte or GIF-header patch for the
  preview. The patched files stay the ones users download and upload to Steam.

**For the license and honesty (AGPL-3.0-only):**

- The fork is public, and the UI has a "Source code" link that points to the exact deployed commit.
  AGPL requires offering source to anyone who uses it over the network.
- `LICENSE`, the dumbapplee copyright notices and the "by dumbapplee" credit stay.
- A visible "Modified by lannahirave" note with the date is in the footer and in the README.

**Clean-up:**

- The AdSense script in `index.html` is removed. It carries upstream's publisher ID.
- The "Support me" link to upstream's Buy Me a Coffee is kept, as credit to the original author.
- The page has a CSP. It allows `steamcommunity.com`, `*.steamstatic.com`, `*.steamusercontent.com`,
  `*.akamaihd.net`, Google Fonts (which upstream already loads), and `blob:`/`data:` images, plus the Studio's origin in `frame-src`. The profile
  preview is a `srcdoc` iframe, which inherits this CSP, so `base-uri` also allows `steamcommunity.com`.
  The profile iframe sandbox stays as it is.
- The "unofficial, not affiliated with Valve" notice is shown, as on the Studio's demo page.
- Optional, not done yet: renaming the fork or matching the Studio's branding, and telling dumbapplee
  about the fork (they might accept the receive mode upstream).

## Deploying

```sh
cd steamcanvas
npm install
npm run deploy   # builds the frontend and runs wrangler deploy
```

Deploy from a clean, pushed commit: the build records `git rev-parse HEAD`, and the footer's "Source
code of this version" link points to that commit on GitHub.

The custom domain `preview.lannahirave.com` is set in `wrangler.jsonc`. The Studio must be deployed
with the `/bridge/` page and the matching `PROFILE_PREVIEW_ORIGIN` before the preview button works.
