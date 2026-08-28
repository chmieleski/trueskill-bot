import { EmbedBuilder } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WARCRAFT3_WOS_GAME_ID } from '../../domain/games.js';
import { getGameProfile } from '../../domain/game-profile.js';
import type { MatchPlayerStatsLine } from './match-stats-upload.js';

const { matchPlayerStatsFindMany, matchStatsReportFindUnique, getGameProfileForMatch } = vi.hoisted(
  () => ({
    matchPlayerStatsFindMany: vi.fn(),
    matchStatsReportFindUnique: vi.fn(),
    getGameProfileForMatch: vi.fn(),
  }),
);

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    matchPlayerStats: {
      findMany: matchPlayerStatsFindMany,
    },
    matchStatsReport: {
      findUnique: matchStatsReportFindUnique,
    },
  },
}));

vi.mock('../../config/env.js', () => ({
  env: {
    matchCreateRoleId: undefined,
    matchModRoleId: undefined,
  },
}));

vi.mock('./match-service.js', () => {
  class MatchServiceError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'MatchServiceError';
    }
  }

  return {
    MatchServiceError,
    getGameProfileForMatch,
  };
});

import {
  buildMatchStatsLogEmbedFields,
  enrichCompletedMatchLogEmbeds,
  formatCompactStatNumber,
  formatMatchStatsDetailedPlayerLine,
  formatMatchStatsTeamTable,
  formatMatchStatsFieldValue,
} from './match-stats-upload.js';
import type { MatchWithPlayers } from './match-service.js';

function sampleStat(overrides: Partial<MatchPlayerStatsLine> = {}): MatchPlayerStatsLine {
  return {
    matchId: 'm1',
    playerId: 'p1',
    reportIndex: 1,
    reportPid: 0,
    reportWin: false,
    kills: 1,
    deaths: 10,
    damagePhys: 1660,
    damageMagic: 8174,
    damageTotal: 9834,
    heal: 606,
    takenPhys: 1868,
    takenMagic: 2560,
    takenTotal: 4428,
    heroObjectId: 1211117616,
    heroName: 'Raiden Ei',
    itemSlot1: 0,
    itemSlot2: 0,
    itemSlot3: 0,
    itemSlot4: 0,
    itemSlot5: 0,
    itemSlot6: 0,
    username: 'chmieleski',
    ...overrides,
  };
}

describe('formatCompactStatNumber', () => {
  it('uses k suffix from 1000 upward', () => {
    expect(formatCompactStatNumber(606)).toBe('606');
    expect(formatCompactStatNumber(9834)).toBe('10k');
    expect(formatCompactStatNumber(12_500)).toBe('13k');
  });
});

describe('formatMatchStatsDetailedPlayerLine', () => {
  it('includes hero, K/D, and combat totals', () => {
    expect(formatMatchStatsDetailedPlayerLine(sampleStat())).toBe(
      '**chmieleski** · Raiden Ei · 1/10 · 10k dmg · 606 heal · 4k taken',
    );
  });

  it('strips Battle.net tags from the username', () => {
    expect(formatMatchStatsDetailedPlayerLine(sampleStat({ username: 'Chmieleski#1941' }))).toBe(
      '**chmieleski** · Raiden Ei · 1/10 · 10k dmg · 606 heal · 4k taken',
    );
  });
});

describe('formatMatchStatsTeamTable', () => {
  it('renders aligned columns in a code block', () => {
    const table = formatMatchStatsTeamTable([
      sampleStat(),
      sampleStat({
        playerId: 'p2',
        username: 'Tiny#11318',
        heroName: 'Frieren',
        kills: 0,
        deaths: 2,
        damageTotal: 151_000,
        heal: 11_200,
        takenTotal: 154_500,
      }),
    ]);

    expect(table).toMatch(/^```\n/);
    expect(table).toMatch(/```$/);
    expect(table).toContain('Hero');
    expect(table).toContain('K/D');
    expect(table).not.toContain('Player');
    expect(table).toContain('Raiden Ei');
    expect(table).toContain('Frieren');
  });
});

describe('buildMatchStatsLogEmbedFields', () => {
  const profile = getGameProfile(WARCRAFT3_WOS_GAME_ID);

  it('adds round score and per-team stat fields sorted by slot', () => {
    const fields = buildMatchStatsLogEmbedFields(
      [
        sampleStat({
          playerId: 'p2',
          username: 'Tiny#11318',
          heroName: 'Frieren',
          kills: 0,
          deaths: 2,
        }),
        sampleStat({ playerId: 'p1' }),
      ],
      {
        profile,
        roster: [
          { playerId: 'p1', team: 1, slot: 1 },
          { playerId: 'p2', team: 2, slot: 6 },
        ],
        team1Rounds: 2,
        team2Rounds: 10,
      },
    );

    expect(fields[0]?.name).toBe('Round score');
    expect(fields[0]?.value).toContain('WOS Enjoyers **2** – **10** WOS Haters');
    expect(fields[1]?.name).toContain('WOS Enjoyers stats');
    expect(fields[1]?.value).toContain('```');
    expect(fields[1]?.value).toContain('Raiden Ei');
    expect(fields[2]?.name).toContain('WOS Haters stats');
    expect(fields[2]?.value).toContain('Frieren');
  });
});

describe('formatMatchStatsFieldValue', () => {
  it('keeps the compact summary format for /match show', () => {
    expect(formatMatchStatsFieldValue([sampleStat()])).toBe('chmieleski: 1/10 · Raiden Ei');
  });
});

describe('enrichCompletedMatchLogEmbeds', () => {
  const baseMatch = {
    id: 'm1',
    players: [
      {
        playerId: 'p1',
        team: 1,
        slot: 1,
        player: { username: 'Chmieleski#1941' },
      },
    ],
  } as MatchWithPlayers;

  beforeEach(() => {
    matchPlayerStatsFindMany.mockReset();
    matchStatsReportFindUnique.mockReset();
    getGameProfileForMatch.mockReset();
    getGameProfileForMatch.mockResolvedValue(getGameProfile(WARCRAFT3_WOS_GAME_ID));
  });

  it('returns the original embeds when no stats exist', async () => {
    matchPlayerStatsFindMany.mockResolvedValue([]);
    const embeds = [new EmbedBuilder().setTitle('Match Completed')];

    const result = await enrichCompletedMatchLogEmbeds(baseMatch, embeds);

    expect(result).toBe(embeds);
    expect(result[0]?.data.fields).toBeUndefined();
  });

  it('adds detailed stats fields to the first embed', async () => {
    matchPlayerStatsFindMany.mockResolvedValue([
      { ...sampleStat(), player: { username: 'Chmieleski#1941' } },
    ]);
    matchStatsReportFindUnique.mockResolvedValue({ team1Rounds: 2, team2Rounds: 10 });
    const embeds = [new EmbedBuilder().setTitle('Match Completed')];

    const [enriched] = await enrichCompletedMatchLogEmbeds(baseMatch, embeds);

    expect(enriched?.data.fields?.some((field) => field.name === 'Round score')).toBe(true);
    expect(enriched?.data.fields?.some((field) => field.name?.includes('WOS Enjoyers stats'))).toBe(
      true,
    );
    expect(enriched?.data.fields?.[1]?.value).toContain('```');
    expect(enriched?.data.fields?.[1]?.value).toContain('Raiden Ei');
  });
});
