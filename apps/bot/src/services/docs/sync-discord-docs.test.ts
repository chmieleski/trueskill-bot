import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocsServiceError } from './docs-errors.js';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';
import { buildDiscordDocsRenderContext } from './resolve-discord-docs-context.js';
import type { ResolvedLeagueConfig } from '../league/league-wc3stats.js';
import { DEFAULT_DECAY_SETTINGS } from '../rating/decay-settings.js';

const { wipeChannelMessages } = vi.hoisted(() => ({
  wipeChannelMessages: vi.fn(),
}));

vi.mock('./wipe-channel-messages.js', () => ({
  wipeChannelMessages: (...args: unknown[]) => wipeChannelMessages(...args),
}));

import { syncDiscordDocsToChannel } from './sync-discord-docs.js';

function testContext() {
  const leagueConfig: ResolvedLeagueConfig = {
    wc3statsEnabled: false,
    wc3statsMapPattern: undefined,
    wc3statsMapSha1: [],
    leaderboardChannelId: undefined,
    leaderboardMessageId: undefined,
    leaderboardSize: 10,
    lobbyPlayerClaimEnabled: true,
    wc3statsHostPromptEnabled: false,
    wc3statsHostPromptChannelId: undefined,
    rankResetEnabled: false,
    rankResetCooldownDays: 30,
    lobbyChannelEnabled: false,
    lobbyChannelId: undefined,
    decayEnabled: true,
    balanceStaticSigmaEnabled: false,
    showSideWinLoss: false,
    heroChampionRolesEnabled: false,
    seasonEndsAt: undefined,
    decayInCrunch: false,
    decaySettings: DEFAULT_DECAY_SETTINGS,
  };

  return buildDiscordDocsRenderContext(
    { id: 'league-1', name: 'Test League' },
    getGameProfile(WARCRAFT3_UDBR_GAME_ID),
    leagueConfig,
  );
}

describe('syncDiscordDocsToChannel', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-docs-'));
    wipeChannelMessages.mockReset();
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function writePublic(name: string, body: string): void {
    const dir = path.join(rootDir, 'docs', 'discord', 'public');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), body, 'utf8');
  }

  it('does not wipe when a rendered doc is invalid', async () => {
    writePublic('01-big.md', 'x'.repeat(2001));
    const send = vi.fn();
    const channel = { send } as never;

    await expect(
      syncDiscordDocsToChannel({ kind: 'public', channel, rootDir, context: testContext() }),
    ).rejects.toThrow(DocsServiceError);

    expect(wipeChannelMessages).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('wipes then posts each file in order', async () => {
    writePublic('02-b.md', 'second');
    writePublic('01-a.md', 'first');

    wipeChannelMessages.mockResolvedValue(3);
    const send = vi.fn().mockResolvedValue({});
    const channel = { send } as never;

    const result = await syncDiscordDocsToChannel({
      kind: 'public',
      channel,
      rootDir,
      context: testContext(),
    });

    expect(wipeChannelMessages).toHaveBeenCalledOnce();
    expect(wipeChannelMessages).toHaveBeenCalledWith(channel);
    expect(send.mock.calls.map((c) => c[0])).toEqual([{ content: 'first' }, { content: 'second' }]);
    expect(result).toEqual({
      kind: 'public',
      deletedCount: 3,
      postedCount: 2,
      filenames: ['01-a.md', '02-b.md'],
    });
  });
});
