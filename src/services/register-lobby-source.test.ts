import { describe, expect, it } from 'vitest';
import { MatchServiceError } from './match-service.js';
import {
  allowsEmptyMatchOnWc3statsFailure,
  parseWc3statsId,
  resolveRegisterLobbySource,
} from './register-lobby-source.js';

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
