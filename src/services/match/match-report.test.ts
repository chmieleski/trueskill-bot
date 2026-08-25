import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveGrieferSlots,
  resolveQuitterSlots,
  clearMatchGriefers,
  clearMatchQuitters,
} from './match-report.js';
import { MatchServiceError } from './match-service.js';

const {
  matchFindUnique,
  matchPlayerUpdate,
  transaction,
  previewMatchCorrection,
  flipCompletedMatch,
} = vi.hoisted(() => ({
  matchFindUnique: vi.fn(),
  matchPlayerUpdate: vi.fn(),
  transaction: vi.fn(),
  previewMatchCorrection: vi.fn(),
  flipCompletedMatch: vi.fn(),
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

vi.mock('./match-correction.js', () => ({
  writeMatchRatingSnapshots: vi.fn(),
  previewMatchCorrection,
  flipCompletedMatch,
}));

function completedMatch(
  overrides: {
    status?: 'COMPLETED' | 'CANCELLED' | 'IN_PROGRESS';
    players?: Array<Record<string, unknown>>;
  } = {},
) {
  return {
    id: 'match-1',
    status: overrides.status ?? ('COMPLETED' as const),
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
        result: 'WIN' as const,
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
        result: 'LOSS' as const,
        player: { id: 'p2', username: 'p2' },
      },
    ],
  };
}

function quitterMatch(
  overrides: {
    status?: 'COMPLETED' | 'CANCELLED' | 'IN_PROGRESS';
    players?: Array<{
      slot: number;
      playerId: string;
      isQuitter: boolean;
      team: number;
      result?: 'WIN' | 'LOSS' | null;
    }>;
  } = {},
) {
  const players = (
    overrides.players ?? [
      { slot: 1, playerId: 'p1', isQuitter: true, team: 1, result: null },
      { slot: 2, playerId: 'p2', isQuitter: false, team: 2, result: null },
      { slot: 7, playerId: 'p7', isQuitter: true, team: 2, result: null },
    ]
  ).map((player) => ({
    heroId: player.slot,
    isGriefer: false,
    grieferKiAccrued: null,
    result: null as 'WIN' | 'LOSS' | null,
    player: { id: player.playerId, username: player.playerId },
    ...player,
  }));

  return completedMatch({
    status: overrides.status ?? 'CANCELLED',
    players,
  });
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

describe('clearMatchQuitters', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        matchPlayer: { update: matchPlayerUpdate },
      }),
    );
    matchPlayerUpdate.mockResolvedValue({});
  });

  it('clears all quitters when slots are omitted (cancelled flag-only)', async () => {
    const match = quitterMatch();
    matchFindUnique.mockResolvedValueOnce(match).mockResolvedValueOnce(match);

    const result = await clearMatchQuitters('match-1');

    expect(matchPlayerUpdate).toHaveBeenCalledTimes(2);
    expect(result.mode).toBe('flag_only');
    expect(result.flagOnlyReason).toBe('match is cancelled');
    expect(result.cleared).toEqual([
      { slot: 1, playerId: 'p1' },
      { slot: 7, playerId: 'p7' },
    ]);
    expect(flipCompletedMatch).not.toHaveBeenCalled();
  });

  it('clears only requested quitter slots and skips non-quitters', async () => {
    const match = quitterMatch();
    matchFindUnique.mockResolvedValueOnce(match).mockResolvedValueOnce(match);

    const result = await clearMatchQuitters('match-1', [1, 2]);

    expect(matchPlayerUpdate).toHaveBeenCalledTimes(1);
    expect(matchPlayerUpdate).toHaveBeenCalledWith({
      where: { matchId_playerId: { matchId: 'match-1', playerId: 'p1' } },
      data: { isQuitter: false },
    });
    expect(result.cleared).toEqual([{ slot: 1, playerId: 'p1' }]);
  });

  it('rejects in-progress matches', async () => {
    matchFindUnique.mockResolvedValue(quitterMatch({ status: 'IN_PROGRESS' }));

    await expect(clearMatchQuitters('match-1')).rejects.toThrow(
      'Quitter flags can only be cleared on completed or cancelled matches.',
    );
  });

  it('rejects when the match has no quitters', async () => {
    matchFindUnique.mockResolvedValue(
      quitterMatch({
        players: [
          { slot: 1, playerId: 'p1', isQuitter: false, team: 1 },
          { slot: 7, playerId: 'p7', isQuitter: false, team: 2 },
        ],
      }),
    );

    await expect(clearMatchQuitters('match-1')).rejects.toThrow(
      'This match has no quitters to clear.',
    );
  });

  it('rejects unknown slots', async () => {
    matchFindUnique.mockResolvedValue(quitterMatch());

    await expect(clearMatchQuitters('match-1', [99])).rejects.toThrow(
      'No quitter player in slot 99.',
    );
  });

  it('rejects when explicit slots are not quitters', async () => {
    matchFindUnique.mockResolvedValue(quitterMatch());

    await expect(clearMatchQuitters('match-1', [2])).rejects.toThrow(
      'The selected slots are not marked as quitters.',
    );
  });

  it('restores ratings on correctable completed matches via flip', async () => {
    const match = quitterMatch({
      status: 'COMPLETED',
      players: [
        { slot: 1, playerId: 'p1', isQuitter: true, team: 1, result: 'LOSS' },
        { slot: 2, playerId: 'p2', isQuitter: false, team: 1, result: 'WIN' },
        { slot: 7, playerId: 'p7', isQuitter: true, team: 2, result: 'LOSS' },
        { slot: 8, playerId: 'p8', isQuitter: false, team: 2, result: 'LOSS' },
      ],
    });
    matchFindUnique.mockResolvedValueOnce(match);
    previewMatchCorrection.mockResolvedValue({
      match,
      canCorrect: true,
      hasNewerMatches: true,
    });
    flipCompletedMatch.mockResolvedValue({
      match: { ...match, players: match.players.map((p) => ({ ...p, isQuitter: false })) },
      ratingPreview: { players: [] },
    });

    const result = await clearMatchQuitters('match-1', [1]);

    expect(flipCompletedMatch).toHaveBeenCalledWith('match-1', 1, [7]);
    expect(result.mode).toBe('ratings_restored');
    expect(result.hasNewerMatches).toBe(true);
    expect(result.cleared).toEqual([{ slot: 1, playerId: 'p1' }]);
    expect(matchPlayerUpdate).not.toHaveBeenCalled();
  });

  it('flag-only on completed matches outside the correction window and fixes result', async () => {
    const match = quitterMatch({
      status: 'COMPLETED',
      players: [
        { slot: 1, playerId: 'p1', isQuitter: true, team: 1, result: 'LOSS' },
        { slot: 2, playerId: 'p2', isQuitter: false, team: 1, result: 'WIN' },
        { slot: 7, playerId: 'p7', isQuitter: false, team: 2, result: 'LOSS' },
      ],
    });
    matchFindUnique.mockResolvedValueOnce(match).mockResolvedValueOnce(match);
    previewMatchCorrection.mockResolvedValue({
      match,
      canCorrect: false,
      hasNewerMatches: false,
      correctionBlockReason: 'This match can only be corrected within 24 hours of completion.',
    });

    const result = await clearMatchQuitters('match-1');

    expect(flipCompletedMatch).not.toHaveBeenCalled();
    expect(result.mode).toBe('flag_only');
    expect(result.flagOnlyReason).toBe('outside the 24-hour correction window');
    expect(matchPlayerUpdate).toHaveBeenCalledWith({
      where: { matchId_playerId: { matchId: 'match-1', playerId: 'p1' } },
      data: { isQuitter: false, result: 'WIN' },
    });
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

  it('normalizes an explicit slot list', () => {
    expect(resolveQuitterSlots(persistedFlags, [9, 1, 9])).toEqual([1, 9]);
  });
});

describe('resolveGrieferSlots', () => {
  const persistedFlags = [
    { slot: 2, isGriefer: true },
    { slot: 4, isGriefer: false },
    { slot: 8, isGriefer: true },
  ];

  it('uses persisted griefer flags when slots are omitted', () => {
    expect(resolveGrieferSlots(persistedFlags)).toEqual([2, 8]);
  });

  it('clears griefers when an explicit empty list is provided', () => {
    expect(resolveGrieferSlots(persistedFlags, [])).toEqual([]);
  });
});
