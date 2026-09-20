import { describe, expect, it } from 'vitest';
import {
  applyMitigationToMu,
  mitigationKeepFactor,
  normalizeMitigationPercent,
} from './rating-mitigation.js';

describe('normalizeMitigationPercent', () => {
  it('accepts presets and maps invalid to 0', () => {
    expect(normalizeMitigationPercent(25)).toBe(25);
    expect(normalizeMitigationPercent(35)).toBe(35);
    expect(normalizeMitigationPercent(50)).toBe(50);
    expect(normalizeMitigationPercent(0)).toBe(0);
    expect(normalizeMitigationPercent(null)).toBe(0);
    expect(normalizeMitigationPercent(undefined)).toBe(0);
    expect(normalizeMitigationPercent(40)).toBe(0);
  });
});

describe('mitigationKeepFactor', () => {
  it('maps presets to keep fractions', () => {
    expect(mitigationKeepFactor(0)).toBe(1);
    expect(mitigationKeepFactor(25)).toBe(0.75);
    expect(mitigationKeepFactor(35)).toBe(0.65);
    expect(mitigationKeepFactor(50)).toBe(0.5);
  });
});

describe('applyMitigationToMu', () => {
  it('is a no-op at 0%', () => {
    expect(applyMitigationToMu(25, 27, 0)).toBe(27);
  });

  it('keeps 65% of delta at 35% mitigation', () => {
    // before 25, after 29 → delta 4 → keep 0.65 → 25 + 2.6
    expect(applyMitigationToMu(25, 29, 35)).toBeCloseTo(27.6);
  });

  it('softens losses the same way', () => {
    // before 25, after 21 → delta -4 → keep 0.65 → 25 - 2.6
    expect(applyMitigationToMu(25, 21, 35)).toBeCloseTo(22.4);
  });
});
