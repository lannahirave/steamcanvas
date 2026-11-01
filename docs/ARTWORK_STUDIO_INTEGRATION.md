# Steam Artwork Studio integration

This fork of [dumbapplee/steamcanvas](https://github.com/dumbapplee/steamcanvas) is deployed as the
profile preview for [Steam Artwork Studio](https://artworkstudio.lannahirave.com). A user converts a
video in the Studio, clicks **Preview on my Steam profile**, and sees the converted GIFs in the real
showcase slots of their own public Steam profile.

| Part | Where |
| --- | --- |
| Profile preview (this fork) | `https://previewartwork.lannahirave.com`, Cloudflare Worker `steamcanvas` |
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

## 2. The Library bridge: getting the Studio's GIFs into SteamCanvas

The Studio needs `crossOriginIsolated` for FFmpeg (`app/web/src/lib/browserSupport.ts`), so its
`COOP: same-origin` and `COEP: require-corp` headers stay. Because of that:

- **Opening the preview in a new tab and sending files** does not work: COOP cuts the link between the
  two windows.
- **Embedding the preview in the Studio** does not work either. Under COEP, the Steam CSS and images
  inside it would be blocked unless SteamCanvas proxied all of them.

**What works is a small bridge page.** Both subdomains are on the same site (`lannahirave.com`), so the
browser does not partition storage between them, and an iframe from the Studio can read the Studio's own
IndexedDB.

1. **Studio:** every conversion is saved automatically to the **Library**, an IndexedDB database
   (`steam-artwork-library`, store `conversions`) in the user's browser. It holds the patched files the
   user uploads to Steam and, where they differ, unpatched copies for previews. The Studio's **Library**
   tab lists the saved conversions, downloads them again, and deletes one or all of them.
2. **Studio:** a `/bridge/` page (`bridge/index.html`, a second Vite entry) is served with different headers from the rest of the app:
   - no COEP and no COOP;
   - `frame-ancestors https://previewartwork.lannahirave.com` in place of `'none'`;
   - no `X-Frame-Options: DENY`.

   It answers requests from its parent with `postMessage`, addressed only to
   `https://previewartwork.lannahirave.com` (the browser drops the message for any other parent), and it
   accepts requests only from that origin. It only reads the Library; deleting happens in the Studio.
3. **SteamCanvas** loads a hidden iframe of `https://artworkstudio.lannahirave.com/bridge/` once per page,
   when it first needs the Library, and checks the sender's origin of every answer. It uses it in two places:
   - **Preview on my Steam profile** in the Studio opens `https://previewartwork.lannahirave.com/?studio=<id>`.
     SteamCanvas fetches that conversion and places it once a profile is loaded.
   - **Choose from Artwork Studio** in the showcase editor lists the whole Library. Conversions that do
     not fit the open showcase are shown greyed out with the reason.

The GIFs never leave the user's computer, so the Studio's "never uploaded" claim still holds. Safari's
tracking prevention can still block a storage iframe even on the same site, so there is a fallback: if
the bridge reports that storage is blocked or the conversion is missing, SteamCanvas says so and the user
downloads the ZIP from the Studio and selects the files in the showcase editor.

### Message protocol (version 2)

All messages are plain objects with `source: 'steam-artwork-studio'` or `source: 'steamcanvas'` and a
`version: 2` field. Requests carry a `requestId` (at most 64 characters) that the answer repeats.

| From | `type` | Payload |
| --- | --- | --- |
| bridge → SteamCanvas | `ready` | none; sent once when the bridge has loaded |
| SteamCanvas → bridge | `list` | `{ requestId }` |
| SteamCanvas → bridge | `get` | `{ requestId, id }` |
| bridge → SteamCanvas | `list-result` | `{ requestId, entries: Entry[] }`, newest first |
| bridge → SteamCanvas | `get-result` | `{ requestId, entry: Entry }` |
| bridge → SteamCanvas | `error` | `{ requestId, reason: 'not-found' \| 'storage-unavailable' }` |

`Entry` is `{ id, createdAt, sourceName, preset, workshopParts, workshopRows, complete, files: [{ name, type,
width, height, blob }] }`. The files are the unpatched preview copies.

`preset` is the Studio preset: `workshop` (5, 10 or 15 parts), `showcase` (Artwork Showcase: main 506 px
and side 100 px parts), `featured` (one 630 px GIF) or `guide`. Guide covers have no place on a profile,
and neither do Workshop conversions that finished early with missing parts; SteamCanvas lists them but
does not place them.

Version 1 was a one-shot handoff (`?handoff=<id>`, record deleted after use). The Studio deletes its old
`steam-artwork-handoff` database, and SteamCanvas removes `?handoff=` from the URL.

### Editing sessions in the URL

SteamCanvas keeps the current editing session in the URL as `?session=<id>`. The draft (showcase area,
avatar, frame, background, theme, level) is autosaved in IndexedDB (`steamcanvas-projects`, stores `drafts`
and `sessions`) under that ID, so reloading the page restores the same profile and edits. Loading another
profile starts a new session; **Resume saved draft** opens the most recent one. The 12 most recent sessions
are kept. Once Studio artwork from `?studio=` is placed, `studio` is removed from the URL, so a reload
restores the draft instead of placing the GIFs again.

### Origins

| Setting | Production | Local development |
| --- | --- | --- |
| Studio `VITE_PROFILE_PREVIEW_ORIGIN` and Worker var `PROFILE_PREVIEW_ORIGIN` | `https://previewartwork.lannahirave.com` | `http://localhost:5180` |
| SteamCanvas `VITE_ARTWORK_STUDIO_ORIGIN` | `https://artworkstudio.lannahirave.com` | `http://localhost:5173` |

`localhost:5173` and `localhost:5180` are the same site (ports are ignored), so the bridge works in
local development too.

## 3. Changes in the SteamCanvas fork

**To make it work:**

- **Receive mode:** `updateArtwork` in `ShowcaseEditor.tsx` takes the layout and Workshop row count as
  arguments, so received files go through the same code as manual uploads.
- **Ask for the profile:** for `?studio=` artwork, SteamCanvas still needs the user to enter their profile
  (or resume a draft). Then it creates or reuses the matching showcase:
  - Workshop: the 5/10/15 parts as ready-made panels, set to the right row count;
  - Artwork: main and side panels, skipping SteamCanvas's own split (the Studio's are already cut);
  - Featured: one image.
- **Library picker:** `StudioLibraryPicker.tsx` in the showcase editor. A Workshop conversion fills rows
  from the chosen start row and adds rows when needed; Artwork and Screenshot showcases take a main and
  side pair; a Featured Artwork takes one image. **Apply to preview** places them as usual.
- **Unpatched copies:** the Studio sends the parts without the `0x21` end-byte or GIF-header patch for the
  preview. The patched files stay the ones users download and upload to Steam.

**For the license and honesty (AGPL-3.0-only):**

- The fork is public, and the UI has a "Source code" link that points to the exact deployed commit.
  AGPL requires offering source to anyone who uses it over the network.
- `LICENSE`, the dumbapplee copyright notices and the "by dumbapplee" credit stay.
- A visible "Modified by lannahirave" note with the date is in the footer and in the README.

**Clean-up:**

- The AdSense script in `index.html` is removed. It carries upstream's publisher ID.
- The link to upstream's Buy Me a Coffee is kept as credit to the original author, relabelled "Support dumbapplee" so it is clear who it supports.
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

The custom domain `previewartwork.lannahirave.com` is set in `wrangler.jsonc`. The Studio must be deployed
with the `/bridge/` page and the matching `PROFILE_PREVIEW_ORIGIN` before the preview button works.
