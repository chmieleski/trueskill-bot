import { describe, expect, it } from 'vitest';
import { normalizeNick } from './player-nick.js';

describe('normalizeNick', () => {
  it('trims whitespace and lowercases ASCII nicks', () => {
    expect(normalizeNick('  Tinys  ')).toBe('tinys');
    expect(normalizeNick('GHOST')).toBe('ghost');
  });

  it('lowercases Unicode nicks', () => {
    expect(normalizeNick('ПуховикКруг')).toBe('пуховиккруг');
  });

  it('returns empty string when the nick is only whitespace', () => {
    expect(normalizeNick('   ')).toBe('');
  });

  it('strips Battle.net tag discriminators before lowercasing', () => {
    expect(normalizeNick('Chmieleski#1941')).toBe('chmieleski');
    expect(normalizeNick('Tiny#11318')).toBe('tiny');
    expect(normalizeNick('  Vegeta#99  ')).toBe('vegeta');
  });

  it('preserves nicks that are not Battle.net tags', () => {
    expect(normalizeNick('foo#bar')).toBe('foo#bar');
  });
});
