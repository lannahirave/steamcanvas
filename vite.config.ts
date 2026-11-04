// Copyright (C) 2026 dumbapplee
// Modified by lannahirave, 2026: fixed dev port so it does not clash with Steam Artwork Studio
// (5173 and 5174), and the build records which branch the AGPL source links point at: `beta` for beta
// builds, `main` otherwise. A second entry, bridge/index.html, is the page Steam Artwork Studio embeds to
// manage the artwork saved here (src/bridge/main.ts).
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` proxies /api to the Worker (wrangler dev, port 8790); `npm run dev:node` uses the
// original Express server on 8787.
// In development the Studio (cross-origin isolated) embeds /bridge/ too, so it needs the same opt-in
// headers the Worker sends in production (worker/index.ts, bridgeHeaders).
const bridgeDevHeaders: Plugin = {
  name: 'bridge-dev-headers',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url === '/bridge' || request.url?.startsWith('/bridge/')) {
        response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        response.setHeader('Cross-Origin-Resource-Policy', 'same-site');
      }
      next();
    });
  },
};

export default defineConfig(({ mode }) => ({
  plugins: [react(), bridgeDevHeaders],
  define: {
    // Each deploy is built from the tip of its branch (scripts/deploy.mjs checks), so the branch is its source.
    __SOURCE_REF__: JSON.stringify(mode === 'beta' ? 'beta' : 'main'),
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        bridge: fileURLToPath(new URL('./bridge/index.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': mode === 'node' ? 'http://127.0.0.1:8787' : 'http://127.0.0.1:8790',
    },
  },
}));
