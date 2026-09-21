import { ButtonStyle } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  RELEASE_CUSTOM_PREFIX,
  buildPlayerReleaseEmbed,
  buildStaffReleaseButtons,
  buildStaffReleaseEmbed,
  parseReleaseCustomId,
  releaseButtonCustomId,
  releaseModalCustomId,
  truncateDiscordField,
} from './release-embed.js';

describe('release custom ids', () => {
  it('uses the changelog prefix and builds edit/publish/dismiss/modal ids', () => {
    expect(RELEASE_CUSTOM_PREFIX).toBe('changelog:');
    expect(releaseButtonCustomId('edit', '1.4.0')).toBe('changelog:edit:1.4.0');
    expect(releaseButtonCustomId('publish', '1.4.0')).toBe('changelog:publish:1.4.0');
    expect(releaseButtonCustomId('dismiss', '1.4.0')).toBe('changelog:dismiss:1.4.0');
    expect(releaseModalCustomId('1.4.0')).toBe('changelog:modal:1.4.0');
  });

  it('parses built custom ids', () => {
    expect(parseReleaseCustomId('changelog:edit:1.4.0')).toEqual({
      action: 'edit',
      version: '1.4.0',
    });
    expect(parseReleaseCustomId(releaseButtonCustomId('publish', '1.4.0'))).toEqual({
      action: 'publish',
      version: '1.4.0',
    });
    expect(parseReleaseCustomId(releaseModalCustomId('1.4.0'))).toEqual({
      action: 'modal',
      version: '1.4.0',
    });
  });

  it('rejects garbage, extra segments, prerelease, and a v prefix', () => {
    expect(parseReleaseCustomId('')).toBeNull();
    expect(parseReleaseCustomId('changelog:edit')).toBeNull();
    expect(parseReleaseCustomId('changelog:edit:')).toBeNull();
    expect(parseReleaseCustomId('changelog:open:1.4.0')).toBeNull();
    expect(parseReleaseCustomId('changelog:edit:1.4.0:extra')).toBeNull();
    expect(parseReleaseCustomId('changelog:edit:1.4.0-beta')).toBeNull();
    expect(parseReleaseCustomId('changelog:edit:v1.4.0')).toBeNull();
    expect(parseReleaseCustomId('leaderboard:page:user:next:1:league')).toBeNull();
  });
});

describe('truncateDiscordField', () => {
  it('returns text unchanged when it fits the default 1024 limit', () => {
    const text = 'a'.repeat(1024);
    expect(truncateDiscordField(text)).toBe(text);
  });

  it('truncates to 1024 with an ellipsis suffix', () => {
    const text = 'b'.repeat(1025);
    const truncated = truncateDiscordField(text);
    expect(truncated).toHaveLength(1024);
    expect(truncated.endsWith('…')).toBe(true);
    expect(truncated).toBe(`${'b'.repeat(1023)}…`);
  });

  it('honors a custom max', () => {
    expect(truncateDiscordField('hello world', 8)).toBe('hello w…');
  });
});

describe('buildStaffReleaseEmbed', () => {
  it('uses Draft · v1.4.0 and truncated note fields', () => {
    const embed = buildStaffReleaseEmbed({
      version: '1.4.0',
      playerNotes: 'Hello players',
      engineeringNotes: '### Features\n\n* lobby hint',
      status: 'draft',
    });
    expect(embed.data.title).toBe('Draft · v1.4.0');
    expect(embed.data.description).toBeUndefined();
    expect(embed.data.fields).toEqual([
      { name: 'Player notes', value: 'Hello players', inline: false },
      { name: 'Engineering notes', value: '### Features\n\n* lobby hint', inline: false },
    ]);
  });

  it('uses Published / Dismissed titles and a Posted to N servers line', () => {
    const published = buildStaffReleaseEmbed({
      version: '1.4.0',
      playerNotes: 'Notes',
      engineeringNotes: 'Eng',
      status: 'published',
      publishedCount: 3,
    });
    expect(published.data.title).toBe('Published · v1.4.0');
    expect(published.data.description).toBe('Posted to 3 servers.');

    const dismissed = buildStaffReleaseEmbed({
      version: '1.4.0',
      playerNotes: 'Notes',
      engineeringNotes: 'Eng',
      status: 'skipped',
    });
    expect(dismissed.data.title).toBe('Dismissed · v1.4.0');
    expect(dismissed.data.description).toBeUndefined();
  });

  it('adds a Failed field when publish failures are present', () => {
    const embed = buildStaffReleaseEmbed({
      version: '1.4.0',
      playerNotes: 'Notes',
      engineeringNotes: 'Eng',
      status: 'published',
      publishedCount: 1,
      failures: ['Could not post in guild `g1`: Missing access'],
    });
    expect(embed.data.fields?.at(-1)).toEqual({
      name: 'Failed',
      value: 'Could not post in guild `g1`: Missing access',
      inline: false,
    });
  });

  it('truncates oversize note fields at 1024 with …', () => {
    const embed = buildStaffReleaseEmbed({
      version: '1.4.0',
      playerNotes: 'p'.repeat(2000),
      engineeringNotes: 'e'.repeat(2000),
      status: 'draft',
    });
    expect(embed.data.fields?.[0]?.value).toBe(`${'p'.repeat(1023)}…`);
    expect(embed.data.fields?.[1]?.value).toBe(`${'e'.repeat(1023)}…`);
  });
});

describe('buildPlayerReleaseEmbed', () => {
  it('titles the player card v1.4.0 with playerNotes as the description', () => {
    const embed = buildPlayerReleaseEmbed({
      version: '1.4.0',
      playerNotes: 'Balance hint is now always visible.',
    });
    expect(embed.data.title).toBe('v1.4.0');
    expect(embed.data.description).toBe('Balance hint is now always visible.');
  });
});

describe('buildStaffReleaseButtons', () => {
  it('returns Edit / Publish / Dismiss for a draft', () => {
    const rows = buildStaffReleaseButtons('1.4.0', 'draft');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toJSON()).toEqual({
      type: 1,
      components: [
        {
          type: 2,
          custom_id: 'changelog:edit:1.4.0',
          label: 'Edit',
          style: ButtonStyle.Primary,
        },
        {
          type: 2,
          custom_id: 'changelog:publish:1.4.0',
          label: 'Publish',
          style: ButtonStyle.Success,
        },
        {
          type: 2,
          custom_id: 'changelog:dismiss:1.4.0',
          label: 'Dismiss',
          style: ButtonStyle.Danger,
        },
      ],
    });
  });

  it('returns an empty array when the release is not a draft', () => {
    expect(buildStaffReleaseButtons('1.4.0', 'published')).toEqual([]);
    expect(buildStaffReleaseButtons('1.4.0', 'skipped')).toEqual([]);
  });
});
