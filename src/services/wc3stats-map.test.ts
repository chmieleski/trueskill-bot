import { describe, expect, it } from 'vitest';
import { isUdbrMap } from './wc3stats-map.js';

const config = {
  pattern: /ultimate.?dragon.?ball.?reborn|udbr/i,
  sha1Allowlist: new Set<string>(['abc123']),
};

describe('isUdbrMap', () => {
  it('accepts UDBR-like filenames', () => {
    expect(isUdbrMap({ map: 'UltimateDragonBallReborn_v1.w3x' }, config)).toBe(true);
    expect(isUdbrMap({ normalizedName: 'Ultimate Dragon Ball Reborn' }, config)).toBe(true);
  });

  it('rejects Tribute and unrelated maps', () => {
    expect(isUdbrMap({ map: 'DBZ_Tribute_Elite_v2.1mb_slk.w3x' }, config)).toBe(false);
    expect(isUdbrMap({ map: 'DotA_v6_89Q.w3x' }, config)).toBe(false);
  });

  it('accepts sha1 allowlist even if the name is odd', () => {
    expect(isUdbrMap({ map: 'weird.w3x', sha1: 'abc123' }, config)).toBe(true);
  });
});

describe('compileWc3statsMapConfig', () => {
  it('throws on an invalid regex', async () => {
    const { compileWc3statsMapConfig } = await import('./wc3stats-map.js');
    expect(() => compileWc3statsMapConfig('(', [])).toThrow(
      'WC3STATS_MAP_PATTERN is not a valid regular expression.',
    );
  });
});
