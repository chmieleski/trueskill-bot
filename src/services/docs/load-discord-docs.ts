import fs from 'node:fs';
import path from 'node:path';
import { DocsServiceError } from './docs-errors.js';

export type DiscordDocsKind = 'public' | 'staff';

export type DiscordDocPost = {
  filename: string;
  content: string;
};

export function loadDiscordDocs(
  kind: DiscordDocsKind,
  rootDir: string = process.cwd(),
): DiscordDocPost[] {
  const dir = path.join(rootDir, 'docs', 'discord', kind);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new DocsServiceError(`Discord docs folder not found: docs/discord/${kind}`);
  }

  const names = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.md') && name.toLowerCase() !== 'readme.md')
    .sort((a, b) => a.localeCompare(b));

  const posts: DiscordDocPost[] = [];
  for (const filename of names) {
    const raw = fs.readFileSync(path.join(dir, filename), 'utf8');
    const content = raw.trim();
    if (!content) {
      throw new DocsServiceError(`Discord doc is empty: ${filename}`);
    }
    posts.push({ filename, content });
  }

  if (posts.length === 0) {
    throw new DocsServiceError(`No Discord guide markdown files in docs/discord/${kind}`);
  }

  return posts;
}
