import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_VERSION,
  extractChangelogSection,
  isPlaceholderVersion,
  readAppVersion,
  readChangelogMarkdown,
} from './changelog.js';

const SAMPLE = `# Changelog

# [1.2.0](https://github.com/example/bot/compare/v1.1.1...v1.2.0) (2026-08-18)

### Features

* **lobby:** always show balance hint

## [1.1.1](https://github.com/example/bot/compare/v1.1.0...v1.1.1) (2026-08-17)

### Bug Fixes

* calibrating gate
`;

describe('extractChangelogSection', () => {
  it('returns the 1.2.0 body and ignores other versions', () => {
    expect(extractChangelogSection(SAMPLE, '1.2.0')).toBe(
      '### Features\n\n* **lobby:** always show balance hint',
    );
  });

  it('returns the 1.1.1 body', () => {
    expect(extractChangelogSection(SAMPLE, '1.1.1')).toBe('### Bug Fixes\n\n* calibrating gate');
  });

  it('returns null when the version heading is missing', () => {
    expect(extractChangelogSection(SAMPLE, '9.9.9')).toBeNull();
  });
});

describe('isPlaceholderVersion', () => {
  it('is true only for 0.1.0', () => {
    expect(isPlaceholderVersion(PLACEHOLDER_VERSION)).toBe(true);
    expect(isPlaceholderVersion('1.0.0')).toBe(false);
  });
});

describe('readAppVersion / readChangelogMarkdown', () => {
  it('reads version and changelog from a root dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bot-release-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.0' }));
    writeFileSync(join(dir, 'CHANGELOG.md'), SAMPLE);
    expect(readAppVersion(dir)).toBe('1.2.0');
    expect(readChangelogMarkdown(dir)).toContain('1.2.0');
  });
});
