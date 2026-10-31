// Copyright (C) 2026 lannahirave
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin of Steam Artwork Studio, which serves the /bridge page for handoffs. */
  readonly VITE_ARTWORK_STUDIO_ORIGIN?: string;
}

/** Commit the deployed build was made from, for the AGPL source link. Set in vite.config.ts. */
declare const __SOURCE_COMMIT__: string;
