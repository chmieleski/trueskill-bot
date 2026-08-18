import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique, create } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    botRelease: { findUnique, create },
  },
}));

import { ensureDraftForVersion } from './release-draft.js';

const CHANGELOG = `# [1.0.0](https://example.com) (2026-08-18)

### Features

* first public release
`;

describe('ensureDraftForVersion', () => {
  beforeEach(() => {
    findUnique.mockReset();
    create.mockReset();
  });

  it('skips placeholder 0.1.0 without writing', async () => {
    await expect(
      ensureDraftForVersion({ version: '0.1.0', changelogMarkdown: CHANGELOG }),
    ).resolves.toBe('skipped_placeholder');
    expect(findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('returns missing_notes when the section is absent', async () => {
    findUnique.mockResolvedValue(null);
    await expect(
      ensureDraftForVersion({ version: '1.0.0', changelogMarkdown: '# Changelog\n' }),
    ).resolves.toBe('missing_notes');
    expect(create).not.toHaveBeenCalled();
  });

  it('returns exists when a row is already present', async () => {
    findUnique.mockResolvedValue({ version: '1.0.0' });
    await expect(
      ensureDraftForVersion({ version: '1.0.0', changelogMarkdown: CHANGELOG }),
    ).resolves.toBe('exists');
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a draft with playerNotes copied from engineering notes', async () => {
    findUnique.mockResolvedValue(null);
    create.mockResolvedValue({});
    await expect(
      ensureDraftForVersion({ version: '1.0.0', changelogMarkdown: CHANGELOG }),
    ).resolves.toBe('created');
    expect(create).toHaveBeenCalledWith({
      data: {
        version: '1.0.0',
        engineeringNotes: '### Features\n\n* first public release',
        playerNotes: '### Features\n\n* first public release',
        status: 'draft',
      },
    });
  });
});
