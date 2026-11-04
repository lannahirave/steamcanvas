// Copyright (C) 2026 lannahirave
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin of Steam Artwork Studio, which serves the /bridge page for handoffs. */
  readonly VITE_ARTWORK_STUDIO_ORIGIN?: string;
  /** Origin of the Steam Artwork Studio demo page, which publishes demo-manifest.json for ?demo=. */
  readonly VITE_DEMO_ARTWORK_ORIGIN?: string;
}

/** Git ref the Source links point at: `beta` for beta builds, otherwise the build's commit. Set in vite.config.ts. */
declare const __SOURCE_REF__: string;
