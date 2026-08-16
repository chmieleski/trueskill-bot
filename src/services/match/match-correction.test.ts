import { describe, expect, it, vi } from 'vitest';
import { MatchServiceError } from './match-service.js';
import {
  CORRECTION_WINDOW_MS,
  GLOBAL_SNAPSHOT_HERO_ID,
  assertSnapshotsComplete,
  expectedSnapshotCount,
  isWithinCorrectionWindow,
  parseMatchCorrectionButtonCustomId,
  buildMatchCorrectionConfirmCustomId,
  writeMatchRatingSnapshots,
} from './match-correction.js';

const SNAPSHOTS_MISSING =
  'This match cannot be corrected because rating snapshots are missing.';

describe('expectedSnapshotCount', () => {
  // assertSnapshotsComplete and previewMatchCorrection both use this helper.
  it('counts GLOBAL+HERO per player when heroId is set', () => {
    expect(expectedSnapshotCount([{ heroId: 1 }, { heroId: 7 }])).toBe(4);
  });

  it('counts one GLOBAL row per null-hero player (not rosterSize * 2)', () => {
    const acaRoster = Array.from({ length: 10 }, () => ({ heroId: null }));
    expect(expectedSnapshotCount(acaRoster)).toBe(10);
    expect(expectedSnapshotCount(acaRoster)).not.toBe(acaRoster.length * 2);
  });

  it('adds 1 for null heroId and 2 when heroId is set', () => {
    expect(expectedSnapshotCount([{ heroId: null }, { heroId: 3 }, { heroId: null }])).toBe(4);
  });
});

describe('match correction constants', () => {
  it('uses a 24h window', () => {
    expect(CORRECTION_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('uses heroId sentinel 0 for GLOBAL rows', () => {
    expect(GLOBAL_SNAPSHOT_HERO_ID).toBe(0);
  });
});

describe('isWithinCorrectionWindow', () => {
  it('accepts completedAt within 24h', () => {
    expect(isWithinCorrectionWindow(new Date(Date.now() - 1000), Date.now())).toBe(true);
  });

  it('rejects null completedAt', () => {
    expect(isWithinCorrectionWindow(null, Date.now())).toBe(false);
  });

  it('rejects older than 24h', () => {
    const old = new Date(Date.now() - CORRECTION_WINDOW_MS - 1);
    expect(isWithinCorrectionWindow(old, Date.now())).toBe(false);
  });

  it('accepts completedAt exactly at the boundary', () => {
    const exact = new Date(Date.now() - CORRECTION_WINDOW_MS);
    expect(isWithinCorrectionWindow(exact, Date.now())).toBe(true);
  });
});

describe('matchcorr customId', () => {
  it('round-trips flip confirm', () => {
    const id = buildMatchCorrectionConfirmCustomId({
      action: 'flip',
      matchId: 'clxxxxxxxxxxxxxxxxxxxxxx',
      actorDiscordId: '123456789012345678',
      winningTeam: 2,
      quitterSlots: [1, 7],
    });
    expect(id.length).toBeLessThanOrEqual(100);
    expect(parseMatchCorrectionButtonCustomId(id)).toEqual({
      kind: 'confirm',
      action: 'flip',
      matchId: 'clxxxxxxxxxxxxxxxxxxxxxx',
      actorDiscordId: '123456789012345678',
      winningTeam: 2,
      quitterSlots: [1, 7],
    });
  });

  it('round-trips void confirm', () => {
    const id = buildMatchCorrectionConfirmCustomId({
      action: 'void',
      matchId: 'clxxxxxxxxxxxxxxxxxxxxxx',
      actorDiscordId: '123456789012345678',
    });
    expect(parseMatchCorrectionButtonCustomId(id)?.action).toBe('void');
    expect(parseMatchCorrectionButtonCustomId(id)?.kind).toBe('confirm');
  });

  it('round-trips flip confirm with no quitters', () => {
    const id = buildMatchCorrectionConfirmCustomId({
      action: 'flip',
      matchId: 'clxxxxxxxxxxxxxxxxxxxxxx',
      actorDiscordId: '123456789012345678',
      winningTeam: 1,
      quitterSlots: [],
    });
    const parsed = parseMatchCorrectionButtonCustomId(id);
    expect(parsed).toMatchObject({ action: 'flip', winningTeam: 1, quitterSlots: [] });
  });

  it('returns null for unknown prefix', () => {
    expect(parseMatchCorrectionButtonCustomId('match:ok:f:foo:bar:1:–')).toBeNull();
  });

  it('returns null for malformed team value', () => {
    expect(
      parseMatchCorrectionButtonCustomId(
        'matchcorr:ok:f:clxxxxxxxxxxxxxxxxxxxxxx:123456789012345678:3:1-7',
      ),
    ).toBeNull();
  });

  it('cancel customId parses to kind=cancel', () => {
    const id = buildMatchCorrectionConfirmCustomId({
      action: 'flip',
      matchId: 'clxxxxxxxxxxxxxxxxxxxxxx',
      actorDiscordId: '123456789012345678',
      winningTeam: 1,
      quitterSlots: [],
    });
    // Replace ok with no to simulate a cancel customId
    const cancelId = id.replace('matchcorr:ok:', 'matchcorr:no:');
    const parsed = parseMatchCorrectionButtonCustomId(cancelId);
    expect(parsed?.kind).toBe('cancel');
    expect(parsed?.action).toBe('flip');
  });
});

function mockCorrectionDb(opts: {
  snapshotCount?: number;
  globals?: Array<{ playerId: string; mu: number; sigma: number }>;
  heroes?: Array<{
    playerId: string;
    heroId: number;
    mu: number;
    sigma: number;
    matchesPlayed: number;
  }>;
}) {
  const createMany = vi.fn().mockResolvedValue({ count: 0 });
  const count = vi.fn().mockResolvedValue(opts.snapshotCount ?? 0);
  const heroFindMany = vi.fn().mockResolvedValue(opts.heroes ?? []);
  return {
    db: {
      matchRatingSnapshot: { count, createMany },
      playerRating: {
        findMany: vi.fn().mockResolvedValue(opts.globals ?? []),
      },
      playerHeroRating: { findMany: heroFindMany },
    } as never,
    createMany,
    count,
    heroFindMany,
  };
}

describe('writeMatchRatingSnapshots', () => {
  it('inserts one GLOBAL row per null-hero player', async () => {
    const players = Array.from({ length: 10 }, (_, i) => ({
      playerId: `p${i + 1}`,
      heroId: null,
    }));
    const { db, createMany, heroFindMany } = mockCorrectionDb({
      globals: players.map((player) => ({
        playerId: player.playerId,
        mu: 25,
        sigma: 8.333,
      })),
    });

    await writeMatchRatingSnapshots('league-1', 'match-1', players, db);

    expect(heroFindMany).not.toHaveBeenCalled();
    expect(createMany).toHaveBeenCalledOnce();
    const rows = (createMany.mock.calls[0]![0] as { data: Array<{ entityKind: string; heroId: number }> })
      .data;
    expect(rows).toHaveLength(10);
    expect(
      rows.every(
        (row) => row.entityKind === 'GLOBAL' && row.heroId === GLOBAL_SNAPSHOT_HERO_ID,
      ),
    ).toBe(true);
  });

  it('inserts GLOBAL and HERO rows when heroId is set', async () => {
    const players = [
      { playerId: 'p1', heroId: 1 },
      { playerId: 'p2', heroId: 7 },
    ];
    const { db, createMany } = mockCorrectionDb({
      globals: [
        { playerId: 'p1', mu: 25, sigma: 8.333 },
        { playerId: 'p2', mu: 25, sigma: 8.333 },
      ],
      heroes: [
        { playerId: 'p1', heroId: 1, mu: 25, sigma: 8.333, matchesPlayed: 0 },
        { playerId: 'p2', heroId: 7, mu: 25, sigma: 8.333, matchesPlayed: 0 },
      ],
    });

    await writeMatchRatingSnapshots('league-1', 'match-1', players, db);

    const rows = (createMany.mock.calls[0]![0] as { data: unknown[] }).data;
    expect(rows).toHaveLength(4);
  });
});

describe('assertSnapshotsComplete', () => {
  it('accepts one snapshot per null-hero player', async () => {
    const roster = Array.from({ length: 10 }, () => ({ heroId: null }));
    const { db } = mockCorrectionDb({ snapshotCount: 10 });

    await expect(assertSnapshotsComplete('match-1', roster, db)).resolves.toBeUndefined();
  });

  it('rejects a null-hero roster when the count is rosterSize * 2', async () => {
    const roster = Array.from({ length: 10 }, () => ({ heroId: null }));
    const { db } = mockCorrectionDb({ snapshotCount: 20 });

    await expect(assertSnapshotsComplete('match-1', roster, db)).rejects.toThrow(SNAPSHOTS_MISSING);
    await expect(assertSnapshotsComplete('match-1', roster, db)).rejects.toBeInstanceOf(
      MatchServiceError,
    );
  });

  it('still requires two rows when heroId is set', async () => {
    const roster = [{ heroId: 1 }, { heroId: 2 }];
    const tooFew = mockCorrectionDb({ snapshotCount: 2 });
    await expect(assertSnapshotsComplete('match-1', roster, tooFew.db)).rejects.toThrow(
      SNAPSHOTS_MISSING,
    );

    const complete = mockCorrectionDb({ snapshotCount: 4 });
    await expect(assertSnapshotsComplete('match-1', roster, complete.db)).resolves.toBeUndefined();
  });
});
