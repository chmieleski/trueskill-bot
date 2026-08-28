import { describe, expect, it } from 'vitest';
import { WARCRAFT3_UDBR_GAME_ID, WARCRAFT3_WOS_GAME_ID } from '../../domain/games.js';
import { getGameProfile } from '../../domain/game-profile.js';
import { buildDiscordDocsRenderContext, formatSlotRange } from './resolve-discord-docs-context.js';
import type { ResolvedLeagueConfig } from '../league/league-wc3stats.js';
import { DEFAULT_DECAY_SETTINGS } from '../rating/decay-settings.js';

function baseLeagueConfig(overrides: Partial<ResolvedLeagueConfig> = {}): ResolvedLeagueConfig {
  return {
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
    seasonEndsAt: undefined,
    decayInCrunch: false,
    decaySettings: DEFAULT_DECAY_SETTINGS,
    ...overrides,
  };
}

describe('buildDiscordDocsRenderContext', () => {
  it('maps UDBR profile and wc3stats flags', () => {
    const context = buildDiscordDocsRenderContext(
      { id: 'l1', name: 'Main' },
      getGameProfile(WARCRAFT3_UDBR_GAME_ID),
      baseLeagueConfig({
        wc3statsEnabled: true,
        wc3statsMapPattern: 'UDBR',
        wc3statsHostPromptEnabled: true,
        wc3statsHostPromptChannelId: '123',
        rankResetEnabled: true,
        showSideWinLoss: true,
        lobbyPlayerClaimEnabled: false,
      }),
    );

    expect(context.team1).toBe('Z Fighters');
    expect(context.team2).toBe('Evil');
    expect(context.team1Slots).toBe('1–6');
    expect(context.team2Slots).toBe('7–12');
    expect(context.wc3stats).toBe(true);
    expect(context.hostPrompts).toBe(true);
    expect(context.playerClaim).toBe(false);
    expect(context.rankReset).toBe(true);
    expect(context.sideWinLoss).toBe(true);
    expect(context.heroLeaderboards).toBe(true);
    expect(context.slotBound).toBe(true);
    expect(context.wosMatchStats).toBe(false);
  });

  it('enables wosMatchStats for WOS leagues', () => {
    const context = buildDiscordDocsRenderContext(
      { id: 'l-wos', name: 'WOS' },
      getGameProfile(WARCRAFT3_WOS_GAME_ID),
      baseLeagueConfig(),
    );

    expect(context.wosMatchStats).toBe(true);
    expect(context.heroLeaderboards).toBe(false);
    expect(context.ratingLabel).toBe('sp');
  });

  it('requires map pattern for wc3stats flag', () => {
    const context = buildDiscordDocsRenderContext(
      { id: 'l1', name: 'Main' },
      getGameProfile(WARCRAFT3_UDBR_GAME_ID),
      baseLeagueConfig({ wc3statsEnabled: true }),
    );
    expect(context.wc3stats).toBe(false);
  });
});

describe('formatSlotRange', () => {
  it('formats inclusive ranges', () => {
    expect(formatSlotRange(1, 6)).toBe('1–6');
    expect(formatSlotRange(7, 12)).toBe('7–12');
  });
});
