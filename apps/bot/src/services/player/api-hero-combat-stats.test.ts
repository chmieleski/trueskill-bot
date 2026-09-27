import { describe, expect, it } from 'vitest';
import {
  aggregateApiHeroWindow,
  filterRowsToCompletedAtRange,
  mapItemSlots,
  type ApiCombatRow,
} from './api-hero-combat-stats.js';

function combatRow(overrides: Partial<ApiCombatRow> & { matchId: string }): ApiCombatRow {
  return {
    playerId: 'p1',
    username: 'Alice',
    result: 'WIN',
    completedAt: new Date('2026-01-10T12:00:00Z'),
    kills: 2,
    deaths: 1,
    damagePhys: 300,
    damageMagic: 700,
    damageTotal: 1000,
    takenPhys: 200,
    takenMagic: 300,
    takenTotal: 500,
    heal: 100,
    heroObjectId: null,
    heroName: null,
    itemObjectIds: [],
    ...overrides,
  };
}

describe('aggregateApiHeroWindow', () => {
  it('returns zeros and null win rate for empty rows', () => {
    const stats = aggregateApiHeroWindow([], 5);
    expect(stats.games).toBe(0);
    expect(stats.wins).toBe(0);
    expect(stats.losses).toBe(0);
    expect(stats.winRatePercent).toBeNull();
    expect(stats.avgDamageTotal).toBe(0);
    expect(stats.sumDamageTotal).toBe(0);
    expect(stats.kda).toBe('—');
    expect(stats.topPlayers).toEqual([]);
  });

  it('computes averages, sums, win rate, and window KDA for mixed results', () => {
    const stats = aggregateApiHeroWindow(
      [
        combatRow({
          matchId: 'm1',
          result: 'WIN',
          kills: 4,
          deaths: 2,
          damagePhys: 100,
          damageMagic: 200,
          damageTotal: 300,
          takenPhys: 50,
          takenMagic: 50,
          takenTotal: 100,
          heal: 80,
        }),
        combatRow({
          matchId: 'm2',
          result: 'LOSS',
          kills: 2,
          deaths: 4,
          damagePhys: 300,
          damageMagic: 500,
          damageTotal: 800,
          takenPhys: 150,
          takenMagic: 250,
          takenTotal: 400,
          heal: 120,
        }),
      ],
      0,
    );
    expect(stats.games).toBe(2);
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(1);
    expect(stats.winRatePercent).toBe(50);
    expect(stats.avgDamageTotal).toBe(550);
    expect(stats.avgDamagePhys).toBe(200);
    expect(stats.avgDamageMagic).toBe(350);
    expect(stats.avgTakenTotal).toBe(250);
    expect(stats.avgHeal).toBe(100);
    expect(stats.avgKills).toBe(3);
    expect(stats.avgDeaths).toBe(3);
    expect(stats.sumDamageTotal).toBe(1100);
    expect(stats.sumKills).toBe(6);
    expect(stats.sumDeaths).toBe(6);
    expect(stats.kda).toBe('1');
    expect(stats.topPlayers).toEqual([]);
  });

  it('returns top players with min 3 games sorted by win rate', () => {
    const mk = (playerId: string, username: string, wins: number, losses: number) =>
      Array.from({ length: wins + losses }, (_, index) =>
        combatRow({
          matchId: `${playerId}-${index}`,
          playerId,
          username,
          result: index < wins ? 'WIN' : 'LOSS',
        }),
      );

    const rows = [...mk('a', 'Ace', 2, 1), ...mk('b', 'Bob', 4, 2), ...mk('c', 'Cara', 0, 2)];
    const stats = aggregateApiHeroWindow(rows, 5);
    expect(stats.topPlayers.map((player) => player.username)).toEqual(['Bob', 'Ace']);
    expect(stats.topPlayers[0]!.winRatePercent).toBeCloseTo(66.7, 1);
  });

  it('omits top players when limit is 0', () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      combatRow({ matchId: `m${index}`, playerId: 'p1' }),
    );
    const stats = aggregateApiHeroWindow(rows, 0);
    expect(stats.topPlayers).toEqual([]);
  });
});

describe('filterRowsToCompletedAtRange', () => {
  it('keeps rows with completedAt in [from, to) and drops null completedAt', () => {
    const from = new Date('2026-01-05T00:00:00Z');
    const to = new Date('2026-01-15T00:00:00Z');
    const rows = [
      combatRow({ matchId: 'in', completedAt: new Date('2026-01-10T00:00:00Z') }),
      combatRow({ matchId: 'before', completedAt: new Date('2026-01-01T00:00:00Z') }),
      combatRow({ matchId: 'at-to', completedAt: new Date('2026-01-15T00:00:00Z') }),
      combatRow({ matchId: 'null-date', completedAt: null }),
    ];
    const filtered = filterRowsToCompletedAtRange(rows, from, to);
    expect(filtered.map((row) => row.matchId)).toEqual(['in']);
  });
});

describe('mapItemSlots', () => {
  it('maps object ids to names with null when missing', () => {
    const names = new Map<number, string>([[1, 'Oken']]);
    expect(mapItemSlots([1, 99], names)).toEqual([
      { objectId: 1, name: 'Oken' },
      { objectId: 99, name: null },
    ]);
  });
});
