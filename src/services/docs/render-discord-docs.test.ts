import { describe, expect, it } from 'vitest';
import { WARCRAFT3_UDBR_GAME_ID, WARCRAFT3_WOS_GAME_ID } from '../../domain/games.js';
import { getGameProfile } from '../../domain/game-profile.js';
import { DocsServiceError } from './docs-errors.js';
import {
  applyDiscordDocConditionals,
  applyDiscordDocPlaceholders,
  renderDiscordDocContent,
} from './render-discord-docs.js';
import { buildDiscordDocsRenderContext } from './resolve-discord-docs-context.js';
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

describe('renderDiscordDocContent', () => {
  const udbrContext = buildDiscordDocsRenderContext(
    { id: 'league-1', name: 'UDBR IHL' },
    getGameProfile(WARCRAFT3_UDBR_GAME_ID),
    baseLeagueConfig({
      wc3statsEnabled: true,
      wc3statsMapPattern: 'UDBR',
      rankResetEnabled: true,
      showSideWinLoss: true,
    }),
  );

  it('replaces team and rating placeholders', () => {
    const rendered = renderDiscordDocContent(
      'Slots {{team1Slots}} = {{team1}} · {{team2Slots}} = {{team2}} · {{ratingLabel}}',
      udbrContext,
    );
    expect(rendered).toBe('Slots 1–6 = Z Fighters · 7–12 = Evil · ki');
  });

  it('omits disabled feature blocks', () => {
    const wosContext = buildDiscordDocsRenderContext(
      { id: 'league-2', name: 'WOS' },
      getGameProfile(WARCRAFT3_WOS_GAME_ID),
      baseLeagueConfig(),
    );

    const rendered = renderDiscordDocContent(
      'before{{#wc3stats}} wc3stats{{/wc3stats}} after{{#rankReset}} reset{{/rankReset}} end',
      wosContext,
    );
    expect(rendered).toBe('before after end');
  });

  it('keeps wosMatchStats blocks for WOS leagues', () => {
    const wosContext = buildDiscordDocsRenderContext(
      { id: 'league-2', name: 'WOS' },
      getGameProfile(WARCRAFT3_WOS_GAME_ID),
      baseLeagueConfig(),
    );

    const rendered = renderDiscordDocContent(
      'a{{#wosMatchStats}} /hero{{/wosMatchStats}}b',
      wosContext,
    );
    expect(rendered).toBe('a /herob');
  });

  it('throws on unknown placeholder or conditional', () => {
    expect(() => renderDiscordDocContent('{{nope}}', udbrContext)).toThrow(DocsServiceError);
    expect(() => renderDiscordDocContent('{{#nope}}x{{/nope}}', udbrContext)).toThrow(
      DocsServiceError,
    );
  });

  it('throws when rendered output exceeds Discord limit', () => {
    expect(() => renderDiscordDocContent('x'.repeat(2001), udbrContext)).toThrow(/2000/);
  });
});

describe('applyDiscordDocConditionals', () => {
  const context = buildDiscordDocsRenderContext(
    { id: 'league-1', name: 'Test' },
    getGameProfile(WARCRAFT3_UDBR_GAME_ID),
    baseLeagueConfig({ wc3statsEnabled: true, wc3statsMapPattern: 'UDBR' }),
  );

  it('keeps enabled blocks', () => {
    expect(applyDiscordDocConditionals('a{{#wc3stats}}b{{/wc3stats}}c', context)).toBe('abc');
  });
});

describe('applyDiscordDocPlaceholders', () => {
  const context = buildDiscordDocsRenderContext(
    { id: 'league-1', name: 'Test League' },
    getGameProfile(WARCRAFT3_WOS_GAME_ID),
    baseLeagueConfig(),
  );

  it('uses WOS team names', () => {
    expect(applyDiscordDocPlaceholders('{{team1}} vs {{team2}} on {{gameName}}', context)).toBe(
      'WOS Enjoyers vs WOS Haters on WOS',
    );
  });
});
