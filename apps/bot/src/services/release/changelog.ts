import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveMonorepoRoot } from '../../lib/repo-root.js';

export const PLACEHOLDER_VERSION = '0.1.0';

/** True for the historical package.json placeholder that must never open a Discord draft. */
export function isPlaceholderVersion(version: string): boolean {
  return version === PLACEHOLDER_VERSION;
}

/**
 * Return the markdown body under the heading for `version` (semver without `v`).
 * Matches semantic-release headings like `# [1.2.0](...)` or `## [1.1.1](...)`.
 */
export function extractChangelogSection(markdown: string, version: string): string | null {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^#{1,2} \\[?${escaped}\\]?\\b.*$`, 'm');
  const match = heading.exec(markdown);
  if (!match) {
    return null;
  }

  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const next = rest.search(/^#{1,2} /m);
  const body = (next === -1 ? rest : rest.slice(0, next)).trim();
  return body.length > 0 ? body : null;
}

/** Read product version from `@dbz/bot` package.json. */
export function readAppVersion(rootDir = resolve(resolveMonorepoRoot(), 'apps/bot')): string {
  const raw = readFileSync(resolve(rootDir, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { version?: string };
  if (typeof parsed.version !== 'string' || parsed.version.trim() === '') {
    throw new Error('package.json is missing version');
  }
  return parsed.version.trim();
}

export function readChangelogMarkdown(rootDir = resolveMonorepoRoot()): string {
  return readFileSync(resolve(rootDir, 'CHANGELOG.md'), 'utf8');
}
