// Copyright (C) 2026 dumbapplee
// Modified by lannahirave, 2026: fixed dev port so it does not clash with Steam Artwork Studio
// (5173 and 5174), and the build records which branch the AGPL source links point at: `beta` for beta
// builds, `main` otherwise. A second entry, bridge/index.html, is the page Steam Artwork Studio embeds to
// manage the artwork saved here (src/bridge/main.ts).
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { defaultDemoOrigin, defaultStudioOrigin, staticHeadersFile } from './worker/securityHeaders';

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

// Writes dist/_headers, so static assets served without the Worker get the same security headers
// it would add. The origins come from the same .env files the client reads (.env.beta for beta,
// the defaults for production) and must match the vars in wrangler.jsonc.
function staticHeaders(mode: string): Plugin {
  return {
    name: 'static-headers',
    apply: 'build',
    generateBundle() {
      const env = loadEnv(mode, process.cwd(), 'VITE_');
      this.emitFile({
        type: 'asset',
        fileName: '_headers',
        source: staticHeadersFile({
          studioOrigin: env.VITE_ARTWORK_STUDIO_ORIGIN || defaultStudioOrigin,
          demoOrigin: env.VITE_DEMO_ARTWORK_ORIGIN || defaultDemoOrigin,
          noindex: mode === 'beta',
        }),
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), bridgeDevHeaders, staticHeaders(mode)],
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
