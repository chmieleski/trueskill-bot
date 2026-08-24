import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGrieferSlots, resolveQuitterSlots, clearMatchGriefers } from './match-report.js';
import { MatchServiceError } from './match-service.js';

const { matchFindUnique, matchPlayerUpdate, transaction } = vi.hoisted(() => ({
  matchFindUnique: vi.fn(),
  matchPlayerUpdate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    match: { findUnique: matchFindUnique },
    matchPlayer: { update: matchPlayerUpdate },
    $transaction: transaction,
  },
}));

vi.mock('../../lib/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

function completedMatch(
  overrides: {
    players?: Array<{
      slot: number;
      playerId: string;
      isGriefer: boolean;
      grieferKiAccrued: number | null;
    }>;
  } = {},
) {
  return {
    id: 'match-1',
    status: 'COMPLETED' as const,
    leagueId: 'league-1',
    players: overrides.players ?? [
      {
        slot: 1,
        playerId: 'p1',
        isGriefer: true,
        grieferKiAccrued: 120,
        team: 1,
        heroId: 1,
        isQuitter: false,
        player: { id: 'p1', username: 'p1' },
      },
      {
        slot: 2,
        playerId: 'p2',
        isGriefer: false,
        grieferKiAccrued: null,
        team: 2,
        heroId: 2,
        isQuitter: false,
        player: { id: 'p2', username: 'p2' },
      },
    ],
  };
}

describe('clearMatchGriefers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        matchPlayer: { update: matchPlayerUpdate },
      }),
    );
    matchPlayerUpdate.mockResolvedValue({});
  });

  it('clears all griefers when slots are omitted', async () => {
    const match = completedMatch();
    matchFindUnique.mockResolvedValueOnce(match).mockResolvedValueOnce({
      ...match,
      players: match.players.map((player) =>
        player.isGriefer ? { ...player, isGriefer: false, grieferKiAccrued: null } : player,
      ),
    });

    const result = await clearMatchGriefers('match-1');

    expect(matchPlayerUpdate).toHaveBeenCalledWith({
      where: { matchId_playerId: { matchId: 'match-1', playerId: 'p1' } },
      data: { isGriefer: false, grieferKiAccrued: null },
    });
    expect(result.cleared).toEqual([{ slot: 1, playerId: 'p1', kiTaxRemoved: 120 }]);
  });

  it('clears only the requested slots', async () => {
    const match = completedMatch({
      players: [
        {
          slot: 1,
          playerId: 'p1',
          isGriefer: true,
          grieferKiAccrued: 100,
          team: 1,
          heroId: 1,
          isQuitter: false,
          player: { id: 'p1', username: 'p1' },
        },
        {
          slot: 3,
          playerId: 'p3',
          isGriefer: true,
          grieferKiAccrued: 80,
          team: 1,
          heroId: 3,
          isQuitter: false,
          player: { id: 'p3', username: 'p3' },
        },
      ],
    });
    matchFindUnique.mockResolvedValueOnce(match).mockResolvedValueOnce(match);

    const result = await clearMatchGriefers('match-1', [3]);

    expect(matchPlayerUpdate).toHaveBeenCalledTimes(1);
    expect(result.cleared).toEqual([{ slot: 3, playerId: 'p3', kiTaxRemoved: 80 }]);
  });

  it('rejects in-progress matches', async () => {
    matchFindUnique.mockResolvedValue({ ...completedMatch(), status: 'IN_PROGRESS' });

    await expect(clearMatchGriefers('match-1')).rejects.toThrow(MatchServiceError);
    await expect(clearMatchGriefers('match-1')).rejects.toThrow(
      'Griefer flags can only be cleared on completed or cancelled matches.',
    );
  });

  it('rejects unknown slots', async () => {
    matchFindUnique.mockResolvedValue(completedMatch());

    await expect(clearMatchGriefers('match-1', [99])).rejects.toThrow(
      'No griefer player in slot 99.',
    );
  });
});

describe('resolveQuitterSlots', () => {
  const persistedFlags = [
    { slot: 5, isQuitter: true },
    { slot: 1, isQuitter: false },
    { slot: 9, isQuitter: true },
    { slot: 3, isQuitter: true },
  ];

  it('uses persisted quitter flags when slots are omitted', () => {
    expect(resolveQuitterSlots(persistedFlags)).toEqual([3, 5, 9]);
  });

  it('clears quitters when an explicit empty list is provided', () => {
    expect(resolveQuitterSlots(persistedFlags, [])).toEqual([]);
  });

  it('replaces persisted flags with explicit slots', () => {
    expect(resolveQuitterSlots(persistedFlags, [1])).toEqual([1]);
  });

  it('normalizes explicit slots', () => {
    expect(resolveQuitterSlots(persistedFlags, [9, 1, 9, 3])).toEqual([1, 3, 9]);
  });
});

describe('resolveGrieferSlots', () => {
  const persistedFlags = [
    { slot: 5, isGriefer: true },
    { slot: 1, isGriefer: false },
    { slot: 9, isGriefer: true },
    { slot: 3, isGriefer: true },
  ];

  it('uses persisted griefer flags when slots are omitted', () => {
    expect(resolveGrieferSlots(persistedFlags)).toEqual([3, 5, 9]);
  });

  it('clears griefers when an explicit empty list is provided', () => {
    expect(resolveGrieferSlots(persistedFlags, [])).toEqual([]);
  });
});
