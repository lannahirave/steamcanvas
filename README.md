<div align="center">

# SteamCanvas

### Your Steam profile. Your style. Your call.

Preview profile ideas, tune the details, and shape your showcases — all before changing anything on Steam.

<p>
  <a href="https://github.com/dumbapplee/steamcanvas"><img alt="React" src="https://img.shields.io/badge/React-19-149eca?logo=react&logoColor=white"></a>
  <a href="https://github.com/dumbapplee/steamcanvas"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white"></a>
  <a href="https://github.com/dumbapplee/steamcanvas"><img alt="Vite" src="https://img.shields.io/badge/Vite-6-646cff?logo=vite&logoColor=white"></a>
  <a href="https://github.com/dumbapplee/steamcanvas"><img alt="Express" src="https://img.shields.io/badge/Express-5-111111?logo=express&logoColor=white"></a>
</p>

[Explore the features](#-the-workshop) · [Run locally](#-run-it-locally) · [Read the asset notes](docs/STEAM_PROFILE_ASSETS.md) · [License](#license)

</div>

---

> **This is a modified fork.** It was changed by [lannahirave](https://github.com/lannahirave) in October 2026 to run on Cloudflare Workers at [preview.lannahirave.com](https://preview.lannahirave.com) and to receive converted GIFs from [Steam Artwork Studio](https://artworkstudio.lannahirave.com). The original project is [dumbapplee/steamcanvas](https://github.com/dumbapplee/steamcanvas). What changed and why: [docs/ARTWORK_STUDIO_INTEGRATION.md](docs/ARTWORK_STUDIO_INTEGRATION.md).

SteamCanvas is a local-first editor for experimenting with **public Steam profiles**. Load a profile, try a new look, arrange its showcases, and export the artwork or a portable HTML preview when you are happy with it.

> **A safe space to experiment:** SteamCanvas previews changes in your browser. It does not sign in to Steam or edit your Steam account.

## ✨ The workshop

### Make the profile yours

- Load a public profile using its custom URL, SteamID64, or full profile link.
- Crop, zoom, and rotate an avatar image before previewing it.
- Browse and preview Steam avatar frames, profile themes, and animated or static backgrounds.
- Search backgrounds in both the Community Market and Steam Points Shop.
- Adjust the preview level without changing the level on Steam.

### Make every showcase feel intentional

- Add, reorder, remove, and restore Artwork, Featured Artwork, Screenshot, and Workshop showcases.
- Split one image into showcase-sized artwork panels, or use separate, ready-made panels.
- Browse public profile screenshots and place selected images into Screenshot Showcase slots.
- Preview GIF artwork and export showcase assets together in a ZIP.
- Use an upgraded Workshop Showcase as **1 × 5**, **2 × 5**, or **3 × 5** when the profile has enough slots. For multi-row layouts, use one source image per row or provide ready-made panels.
- Export a complete profile-preview ZIP with an `index.html` wired to local copies of uploaded assets.

### Pick up where you left off

SteamCanvas autosaves the current preview as a draft in your browser. Return to the app in the same browser to resume it, or reset the preview to the profile as it was loaded.

## 🚀 Run it locally

### Requirements

- Node.js and npm
- An internet connection to load Steam profiles and browse Steam items

### Start the development app

```sh
git clone https://github.com/lannahirave/steamcanvas.git
cd steamcanvas
npm install
npm run dev
```

Open **[http://localhost:5180](http://localhost:5180)**. The development command starts the Vite frontend and the Cloudflare Worker API (`wrangler dev`); Vite forwards `/api` requests to the Worker on port `8790`. Copy `.dev.vars.example` to `.dev.vars` first.

`npm run dev:node` runs the original Express server instead, if you want to compare the two.

### Build and deploy

```sh
npm run build
npm run deploy
```

The build type-checks the client, the Worker, and the Express server, then creates the frontend in `dist/`. `npm run deploy` publishes the Worker and the built files with Wrangler, using `wrangler.jsonc`. `npm run start` still serves the build with the Express server at **[http://localhost:8787](http://localhost:8787)**.

### Optional catalog database

The Worker has no catalog database: `/api/catalog-status` and `/api/profile-metrics` answer 503 there. With the Express server, set `DATABASE_URL` for the server to enable its PostgreSQL-backed catalog indexing and global unique-profile metric; without it, Points Shop catalog searches use Steam's fallback and profile metrics are unavailable. The local development setup does not require PostgreSQL.

After a public profile loads successfully, SteamCanvas stores its SteamID64 once in PostgreSQL. The total number of distinct profiles seen by this server is available from `GET /api/profile-metrics` as `{ "uniqueProfiles": 123 }`. No profile names or submitted profile URLs are stored for this metric.

## 🧭 A quick tour

1. Enter a public profile URL, custom profile name, or 17-digit SteamID64.
2. Explore appearance options and edit the showcases in the preview.
3. Use **Export** for a ZIP with the profile HTML and its local assets, or download an individual showcase's artwork.
4. Open the exported `index.html` from the extracted ZIP to revisit the preview.
5. Upload exported artwork to Steam yourself when you are ready.

## 📦 Workshop exports

Workshop image exports apply the community-documented `0x21` final-byte workaround to each image **in the Workshop ZIP only**. It is not applied to other showcase exports or the profile preview assets. This is an unofficial Steam upload technique, not a guarantee from Valve.

The full-export ZIP keeps unmodified Workshop image copies for local HTML preview, separate from the upload-ready files. The HTML references these assets with relative paths. Steam-hosted styles and profile assets that were not uploaded into the editor still require an internet connection.

For details on image handling, Workshop layouts, and export behavior, see [Steam profile assets](docs/STEAM_PROFILE_ASSETS.md).

## ℹ️ What to know

- Only **public** Steam profiles can be loaded.
- This fork has no ads. The upstream AdSense script was removed.
- SteamCanvas is a preview and export tool; it does not apply changes to your Steam account. Upload artwork and make profile changes on Steam yourself.
- Some showcase types are preserved as Steam provided them. Artwork editing is supported for the showcase types listed above; other showcase blocks can remain unchanged while you reorder or remove them.
- Workshop layouts are available up to the number of five-slot rows in the loaded showcase: **2 × 5** needs ten slots and **3 × 5** needs fifteen. A profile with the relevant Steam upgrade can preview up to three rows.
- Steam can rate-limit or temporarily fail to serve profiles and catalog results. Try again later if a request cannot be completed.
- Exported HTML may need an internet connection for Steam-hosted content that is not included in the ZIP.

## 🛠️ Built with

| Part | Technology |
| --- | --- |
| User interface | React 19, TypeScript, Vite |
| API | Cloudflare Workers (this fork); Node.js, Express 5 (upstream server, kept) |
| Asset processing | Canvas, `gifuct-js`, `gifenc`, JSZip |
| Optional catalog index | PostgreSQL |

## 📁 Project map

```text
src/
  components/   Profile, avatar, background, theme, and showcase editors
  utils/        Shared profile and network helpers
  App.tsx       App shell, profile loading, drafts, and full export
worker/
  index.ts      Steam-facing API on Cloudflare Workers (this fork)
server/
  index.ts      Original Express API and optional catalog index
docs/
  STEAM_PROFILE_ASSETS.md
  ARTWORK_STUDIO_INTEGRATION.md
```

## 📜 Available commands

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite frontend and the Worker API for local development |
| `npm run dev:node` | Start the Vite frontend with the original Express server |
| `npm run build` | Type-check the client, Worker and server, then build the frontend |
| `npm run deploy` | Build, then deploy the Worker with Wrangler |
| `npm run start` | Serve the production build with the Express server |

## License

Copyright (C) 2026 dumbapplee. Modifications copyright (C) 2026 lannahirave.

SteamCanvas is licensed under the GNU Affero General Public License, version 3 only. See [LICENSE](LICENSE). Redistributed copies must retain the copyright and license notices. If you run a modified version as a network service, AGPLv3 requires you to offer its corresponding source code to users interacting with it remotely.

---

<div align="center">

Made for people who like their Steam profile to feel like **theirs**.

[Back to top](#steamcanvas)

</div>
