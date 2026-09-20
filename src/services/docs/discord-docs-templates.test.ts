import { describe, expect, it } from 'vitest';
import { WARCRAFT3_UDBR_GAME_ID, WARCRAFT3_WOS_GAME_ID } from '../../domain/games.js';
import { getGameProfile } from '../../domain/game-profile.js';
import { loadDiscordDocs } from './load-discord-docs.js';
import { renderDiscordDocPosts } from './render-discord-docs.js';
import { buildDiscordDocsRenderContext } from './resolve-discord-docs-context.js';
import type { ResolvedLeagueConfig } from '../league/league-wc3stats.js';
import { DEFAULT_DECAY_SETTINGS } from '../rating/decay-settings.js';

function leagueConfig(overrides: Partial<ResolvedLeagueConfig> = {}): ResolvedLeagueConfig {
  return {
    wc3statsEnabled: true,
    wc3statsMapPattern: 'map',
    wc3statsMapSha1: [],
    leaderboardChannelId: undefined,
    leaderboardMessageId: undefined,
    leaderboardSize: 10,
    lobbyPlayerClaimEnabled: true,
    wc3statsHostPromptEnabled: true,
    wc3statsHostPromptChannelId: '123',
    rankResetEnabled: true,
    rankResetCooldownDays: 30,
    lobbyChannelEnabled: true,
    lobbyChannelId: '456',
    decayEnabled: true,
    balanceStaticSigmaEnabled: false,
    showSideWinLoss: true,
    heroChampionRolesEnabled: false,
    seasonEndsAt: undefined,
    decayInCrunch: false,
    decaySettings: DEFAULT_DECAY_SETTINGS,
    ...overrides,
  };
}

describe('repo Discord docs templates', () => {
  it('render all public guides under Discord limit for UDBR and WOS', () => {
    const templates = loadDiscordDocs('public');
    const contexts = [
      buildDiscordDocsRenderContext(
        { id: 'udbr', name: 'UDBR' },
        getGameProfile(WARCRAFT3_UDBR_GAME_ID),
        leagueConfig(),
      ),
      buildDiscordDocsRenderContext(
        { id: 'wos', name: 'WOS' },
        getGameProfile(WARCRAFT3_WOS_GAME_ID),
        leagueConfig({
          wc3statsEnabled: false,
          wc3statsMapPattern: undefined,
          wc3statsHostPromptEnabled: false,
          wc3statsHostPromptChannelId: undefined,
          rankResetEnabled: false,
          showSideWinLoss: false,
          lobbyPlayerClaimEnabled: false,
        }),
      ),
    ];

    for (const context of contexts) {
      const rendered = renderDiscordDocPosts(templates, context);
      for (const post of rendered) {
        expect(post.content.length, `${context.gameId}:${post.filename}`).toBeLessThanOrEqual(2000);
        expect(post.content.length, `${context.gameId}:${post.filename}`).toBeGreaterThan(0);
      }
    }
  });
});
