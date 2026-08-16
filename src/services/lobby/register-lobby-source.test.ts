import { describe, expect, it } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import {
  WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID,
  WARCRAFT3_UDBR_GAME_ID,
} from '../../domain/games.js';
import { MatchServiceError } from '../match/match-service.js';
import {
  allowsEmptyMatchOnWc3statsFailure,
  assertProfileAllowsWc3statsImport,
  assertRegisterLobbyAllowedForProfile,
  parseWc3statsId,
  resolveRegisterLobbySource,
  SCREENSHOT_UNSUPPORTED_MESSAGE,
  WC3STATS_UNSUPPORTED_MESSAGE,
} from './register-lobby-source.js';

const aca = getGameProfile(WARCRAFT3_ANIME_CHOICE_ARENA_GAME_ID);
const udbr = getGameProfile(WARCRAFT3_UDBR_GAME_ID);

describe('resolveRegisterLobbySource', () => {
  it('returns empty when no attachment url is given', () => {
    expect(resolveRegisterLobbySource({})).toEqual({ kind: 'empty' });
    expect(resolveRegisterLobbySource({ attachmentUrl: null })).toEqual({ kind: 'empty' });
    expect(resolveRegisterLobbySource({ attachmentUrl: '' })).toEqual({ kind: 'empty' });
  });

  it('returns screenshot when url and mime are present', () => {
    expect(
      resolveRegisterLobbySource({
        attachmentUrl: 'https://cdn.discordapp.com/a.png',
        mimeType: 'image/png',
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
        attachmentUrl: 'https://cdn.discordapp.com/a.png',
        mimeType: 'image/png',
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
  it('refuses screenshot and wc3stats id on import none', () => {
    expect(() =>
      assertRegisterLobbyAllowedForProfile(aca, { hasScreenshot: true, hasWc3statsId: false }),
    ).toThrow(SCREENSHOT_UNSUPPORTED_MESSAGE);
    expect(() =>
      assertRegisterLobbyAllowedForProfile(aca, { hasScreenshot: false, hasWc3statsId: true }),
    ).toThrow(WC3STATS_UNSUPPORTED_MESSAGE);
  });

  it('allows screenshot on UDBR', () => {
    expect(() =>
      assertRegisterLobbyAllowedForProfile(udbr, { hasScreenshot: true, hasWc3statsId: false }),
    ).not.toThrow();
  });

  it('allows empty Discord-only register on import none', () => {
    expect(() =>
      assertRegisterLobbyAllowedForProfile(aca, { hasScreenshot: false, hasWc3statsId: false }),
    ).not.toThrow();
  });
});

describe('assertProfileAllowsWc3statsImport', () => {
  it('throws the import refuse string for ACA', () => {
    expect(() => assertProfileAllowsWc3statsImport(aca)).toThrow(WC3STATS_UNSUPPORTED_MESSAGE);
  });

  it('does not throw for UDBR', () => {
    expect(() => assertProfileAllowsWc3statsImport(udbr)).not.toThrow();
  });
});
