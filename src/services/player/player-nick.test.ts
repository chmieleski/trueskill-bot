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
});
