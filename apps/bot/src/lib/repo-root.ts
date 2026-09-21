import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the monorepo root whether cwd is the repo root or `apps/bot`.
 * Walks up looking for `pnpm-workspace.yaml`.
 */
export function resolveMonorepoRoot(startDir: string = process.cwd()): string {
  let dir = resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fallback from this file: apps/bot/src/lib → ../../../
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
}
