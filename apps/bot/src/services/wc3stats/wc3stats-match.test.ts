import { describe, expect, it } from 'vitest';
import { duplicateWc3statsMatchMessage } from '../match/match-service.js';

describe('duplicateWc3statsMatchMessage', () => {
  it('names the existing match id', () => {
    expect(duplicateWc3statsMatchMessage('clxyz')).toBe(
      'That Warcraft lobby is already registered as match clxyz.',
    );
  });
});
