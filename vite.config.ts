// Copyright (C) 2026 dumbapplee
// Modified by lannahirave, 2026: fixed dev port so it does not clash with Steam Artwork Studio
// (5173 and 5174), and the build records its git commit for the AGPL source link.
// SPDX-License-Identifier: AGPL-3.0-only

import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function sourceCommit(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

// `npm run dev` proxies /api to the Worker (wrangler dev, port 8790); `npm run dev:node` uses the
// original Express server on 8787.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: {
    __SOURCE_COMMIT__: JSON.stringify(sourceCommit()),
  },
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': mode === 'node' ? 'http://127.0.0.1:8787' : 'http://127.0.0.1:8790',
    },
  },
}));
