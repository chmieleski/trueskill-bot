import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocsServiceError, loadDiscordDocs } from './load-discord-docs.js';

describe('loadDiscordDocs', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-docs-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function writePublic(name: string, body: string): void {
    const dir = path.join(rootDir, 'docs', 'discord', 'public');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), body, 'utf8');
  }

  it('loads .md files sorted by filename and skips README.md', () => {
    writePublic('README.md', 'skip me');
    writePublic('02-b.md', 'second');
    writePublic('01-a.md', 'first');
    writePublic('notes.txt', 'ignore');

    expect(loadDiscordDocs('public', rootDir)).toEqual([
      { filename: '01-a.md', content: 'first' },
      { filename: '02-b.md', content: 'second' },
    ]);
  });

  it('throws when the directory is missing', () => {
    expect(() => loadDiscordDocs('staff', rootDir)).toThrow(DocsServiceError);
    expect(() => loadDiscordDocs('staff', rootDir)).toThrow(/staff/i);
  });

  it('throws when a file is empty after trim', () => {
    writePublic('01-empty.md', '   \n');
    expect(() => loadDiscordDocs('public', rootDir)).toThrow(/01-empty\.md/);
  });

  it('throws when a file exceeds 2000 characters', () => {
    writePublic('01-big.md', 'x'.repeat(2001));
    expect(() => loadDiscordDocs('public', rootDir)).toThrow(/2000/);
  });
});
