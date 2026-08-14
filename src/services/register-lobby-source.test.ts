import { describe, expect, it } from 'vitest';
import { resolveRegisterLobbySource } from './register-lobby-source.js';

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
});
