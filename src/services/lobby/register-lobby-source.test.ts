import { describe, expect, it, vi } from 'vitest';

const { leagueFindUnique, getGameProfileForLeagueMock } = vi.hoisted(() => ({
  leagueFindUnique: vi.fn(),
  getGameProfileForLeagueMock: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique: leagueFindUnique },
  },
}));

vi.mock('../league/league-profile.js', () => ({
  getGameProfileForLeague: getGameProfileForLeagueMock,
}));

import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_WOS_GAME_ID, WARCRAFT3_UDBR_GAME_ID } from '../../domain/games.js';
import { LEAGUE_ARCHIVED_MESSAGE } from '../league/league.js';
import { MatchServiceError } from '../match/match-service.js';
import {
  allowsEmptyMatchOnWc3statsFailure,
  assertLeagueAllowsWc3statsImport,
  assertProfileAllowsWc3statsImport,
  assertRegisterLobbyAllowedForProfile,
  parseWc3statsId,
  resolveRegisterLobbySource,
  SCREENSHOT_UNSUPPORTED_MESSAGE,
  WC3STATS_UNSUPPORTED_MESSAGE,
} from './register-lobby-source.js';

const wos = getGameProfile(WARCRAFT3_WOS_GAME_ID);
const udbr = getGameProfile(WARCRAFT3_UDBR_GAME_ID);

describe('resolveRegisterLobbySource', () => {
  it('returns empty when no attachment url is given', () => {
    expect(resolveRegisterLobbySource({})).toEqual({ kind: 'empty' });
    expect(resolveRegisterLobbySource({ printAttachmentUrl: null })).toEqual({ kind: 'empty' });
    expect(resolveRegisterLobbySource({ printAttachmentUrl: '' })).toEqual({ kind: 'empty' });
  });

  it('returns wos2_report when report attachment url is present', () => {
    expect(
      resolveRegisterLobbySource({
        reportAttachmentUrl: 'https://cdn.discordapp.com/a.txt',
      }),
    ).toEqual({
      kind: 'wos2_report',
      url: 'https://cdn.discordapp.com/a.txt',
    });
  });

  it('prefers report over print and wc3stats', () => {
    expect(
      resolveRegisterLobbySource({
        reportAttachmentUrl: 'https://cdn.discordapp.com/a.txt',
        printAttachmentUrl: 'https://cdn.discordapp.com/a.png',
        printMimeType: 'image/png',
        wc3statsEnabled: true,
        wc3statsId: 12,
      }),
    ).toEqual({
      kind: 'wos2_report',
      url: 'https://cdn.discordapp.com/a.txt',
    });
  });

  it('returns screenshot when print url and mime are present', () => {
    expect(
      resolveRegisterLobbySource({
        printAttachmentUrl: 'https://cdn.discordapp.com/a.png',
        printMimeType: 'image/png',
      }),
    ).toEqual({
      kind: 'screenshot',
      url: 'https://cdn.discordapp.com/a.png',
      mimeType: 'image/png',
    });
  });

  it('prefers screenshot over wc3stats for the roster source', () => {
    expect(
      resolveRegisterLobbySource({
        printAttachmentUrl: 'https://cdn.discordapp.com/a.png',
        printMimeType: 'image/png',
        wc3statsEnabled: true,
        wc3statsId: 12,
      }),
    ).toEqual({
      kind: 'screenshot',
      url: 'https://cdn.discordapp.com/a.png',
      mimeType: 'image/png',
    });
  });

  it('returns wc3stats when enabled and there is no screenshot', () => {
    expect(
      resolveRegisterLobbySource({
        wc3statsEnabled: true,
        wc3statsId: 99,
      }),
    ).toEqual({ kind: 'wc3stats', wc3statsId: 99 });

    expect(resolveRegisterLobbySource({ wc3statsEnabled: true })).toEqual({
      kind: 'wc3stats',
      wc3statsId: undefined,
    });
  });
});

describe('allowsEmptyMatchOnWc3statsFailure', () => {
  it('lets Discord match creation continue when wc3stats has no usable lobby', () => {
    expect(allowsEmptyMatchOnWc3statsFailure('not_found')).toBe(true);
    expect(allowsEmptyMatchOnWc3statsFailure('ambiguous')).toBe(true);
    expect(allowsEmptyMatchOnWc3statsFailure('not_udbr')).toBe(true);
    expect(allowsEmptyMatchOnWc3statsFailure('unavailable')).toBe(true);
  });
});

describe('parseWc3statsId', () => {
  it('returns null for blank input', () => {
    expect(parseWc3statsId(null)).toBeNull();
    expect(parseWc3statsId('')).toBeNull();
  });

  it('parses a positive integer', () => {
    expect(parseWc3statsId('42')).toBe(42);
  });

  it('rejects non-numeric ids', () => {
    expect(() => parseWc3statsId('abc')).toThrow(MatchServiceError);
    expect(() => parseWc3statsId('abc')).toThrow('wc3stats_id must be a positive number.');
  });
});

describe('assertRegisterLobbyAllowedForProfile', () => {
  it('refuses screenshot when hero binding is optional_in_game', () => {
    expect(() =>
      assertRegisterLobbyAllowedForProfile(wos, { hasScreenshot: true, hasWc3statsId: false }),
    ).toThrow(SCREENSHOT_UNSUPPORTED_MESSAGE);
  });

  it('allows wc3stats id on WOS', () => {
    expect(() =>
      assertRegisterLobbyAllowedForProfile(wos, { hasScreenshot: false, hasWc3statsId: true }),
    ).not.toThrow();
  });

  it('allows screenshot on UDBR', () => {
    expect(() =>
      assertRegisterLobbyAllowedForProfile(udbr, { hasScreenshot: true, hasWc3statsId: false }),
    ).not.toThrow();
  });

  it('refuses text report when postMatchStats is none', () => {
    expect(() =>
      assertRegisterLobbyAllowedForProfile(udbr, {
        hasScreenshot: false,
        hasWc3statsId: false,
        hasReport: true,
      }),
    ).toThrow('Match file reports are not supported for this game.');
  });

  it('allows report on WOS', () => {
    expect(() =>
      assertRegisterLobbyAllowedForProfile(wos, {
        hasScreenshot: false,
        hasWc3statsId: false,
        hasReport: true,
      }),
    ).not.toThrow();
  });
});

describe('assertLeagueAllowsWc3statsImport', () => {
  it('rejects when the league is archived', async () => {
    leagueFindUnique.mockResolvedValue({ status: 'ARCHIVED' });

    await expect(assertLeagueAllowsWc3statsImport('league-archived')).rejects.toThrow(
      MatchServiceError,
    );
    await expect(assertLeagueAllowsWc3statsImport('league-archived')).rejects.toThrow(
      LEAGUE_ARCHIVED_MESSAGE,
    );
    expect(getGameProfileForLeagueMock).not.toHaveBeenCalled();
  });

  it('delegates to the game profile import check for active leagues', async () => {
    leagueFindUnique.mockResolvedValue({ status: 'ACTIVE' });
    getGameProfileForLeagueMock.mockResolvedValue(udbr);

    await expect(assertLeagueAllowsWc3statsImport('league-1')).resolves.toBeUndefined();
  });
});

describe('assertProfileAllowsWc3statsImport', () => {
  it('does not throw for WOS', () => {
    expect(() => assertProfileAllowsWc3statsImport(wos)).not.toThrow();
  });

  it('does not throw for UDBR', () => {
    expect(() => assertProfileAllowsWc3statsImport(udbr)).not.toThrow();
  });
});
