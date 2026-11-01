// Copyright (C) 2026 dumbapplee
// Modified by lannahirave, 2026: fixed dev port so it does not clash with Steam Artwork Studio
// (5173 and 5174), and the build records which branch the AGPL source links point at: `beta` for beta
// builds, `main` otherwise.
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` proxies /api to the Worker (wrangler dev, port 8790); `npm run dev:node` uses the
// original Express server on 8787.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    // Each deploy is built from the tip of its branch (scripts/deploy.mjs checks), so the branch is its source.
    __SOURCE_REF__: JSON.stringify(mode === 'beta' ? 'beta' : 'main'),
  },
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': mode === 'node' ? 'http://127.0.0.1:8787' : 'http://127.0.0.1:8790',
    },
  },
}));
