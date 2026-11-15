// Copyright (C) 2026 lannahirave
// SPDX-License-Identifier: AGPL-3.0-only
//
// Shared by the scripts that fill CATALOG_KV from this machine (seed-market-kv.ts, market-index.ts):
// Steam retries with long waits, and the wrangler KV commands.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Waits before each retry of a failed Steam request; after the last one, the caller gives up.
// Steam's Market limit can last several minutes, so the short waits are followed by longer ones.
export const retryDelaysMs = [15_000, 30_000, 60_000, 300_000, 300_000, 300_000];

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Runs `load`, waiting as in retryDelaysMs between attempts. Returns null if every attempt fails. */
export async function withRetries<T>(label: string, load: () => Promise<T>, shouldStop: () => boolean = () => false): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await load();
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined || shouldStop()) {
        console.error(`${label}: failed (${errorText(error)}).`);
        return null;
      }
      const wait = delayMs >= 60_000 ? `${delayMs / 60_000} min` : `${delayMs / 1000} s`;
      console.warn(`${label}: failed (${errorText(error)}); retrying in ${wait} (attempt ${attempt + 2}/${retryDelaysMs.length + 1}).`);
      await sleep(delayMs);
    }
  }
}

export type KvEnv = 'prod' | 'beta';

export function parseEnv(value: string): KvEnv {
  if (value !== 'prod' && value !== 'beta') throw new Error('--env must be prod or beta.');
  return value;
}

/** Runs `npx wrangler kv ...` against CATALOG_KV of one environment, remotely. */
export function wranglerKv(env: KvEnv, args: string[]): { ok: boolean; stdout: Buffer; output: string } {
  const all = ['npx', 'wrangler', 'kv', ...args, '--binding', 'CATALOG_KV', '--remote', ...(env === 'beta' ? ['--env', 'beta'] : [])];
  // npx is a .cmd file on Windows, which needs a shell; pass one quoted command line to it.
  const command = all.map((arg) => /^[\w:./\\-]+$/.test(arg) ? arg : `"${arg}"`).join(' ');
  const result = spawnSync(command, { stdio: ['ignore', 'pipe', 'pipe'], shell: true, maxBuffer: 256 * 1024 * 1024 });
  const stdout = result.stdout ?? Buffer.alloc(0);
  return { ok: result.status === 0, stdout, output: `${stdout.toString('utf8')}${result.stderr?.toString('utf8') ?? ''}` };
}

/** Writes `contents` to a temporary file, passes its path to `run`, then deletes it. */
export function withTempFile<T>(name: string, contents: string | Buffer, run: (file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'steamcanvas-'));
  const file = join(dir, name);
  try {
    writeFileSync(file, contents);
    return run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
