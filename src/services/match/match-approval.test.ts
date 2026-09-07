import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MatchServiceError } from './match-service.js';

const { matchFindUnique, matchUpdate, matchPlayerUpdate, transaction, queryRaw, completeMatch } =
  vi.hoisted(() => ({
    matchFindUnique: vi.fn(),
    matchUpdate: vi.fn(),
    matchPlayerUpdate: vi.fn(),
    transaction: vi.fn(),
    queryRaw: vi.fn(),
    completeMatch: vi.fn(),
  }));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    match: {
      findUnique: matchFindUnique,
      update: matchUpdate,
    },
    matchPlayer: {
      update: matchPlayerUpdate,
    },
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

vi.mock('./match-report.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./match-report.js')>();
  return {
    ...actual,
    completeMatch,
  };
});

import { approveWaitingMatch, rejectWaitingMatch, setApprovalWinner } from './match-approval.js';
import { setQuitters } from './match-report.js';

function waitingMatch(
  overrides: {
    approvalWinnerTeam?: number | null;
    players?: Array<{
      slot: number;
      playerId: string;
      team: number;
      isQuitter?: boolean;
      isGriefer?: boolean;
    }>;
  } = {},
) {
  const players = (
    overrides.players ?? [
      { slot: 1, playerId: 'p1', team: 1, isQuitter: false, isGriefer: false },
      { slot: 2, playerId: 'p2', team: 1, isQuitter: true, isGriefer: false },
      { slot: 7, playerId: 'p7', team: 2, isQuitter: false, isGriefer: true },
      { slot: 8, playerId: 'p8', team: 2, isQuitter: false, isGriefer: false },
    ]
  ).map((player) => ({
    heroId: player.slot,
    isQuitter: player.isQuitter ?? false,
    isGriefer: player.isGriefer ?? false,
    grieferKiAccrued: null,
    result: null,
    player: { id: player.playerId, username: player.playerId },
    ...player,
  }));

  return {
    id: 'match-1',
    status: 'WAITING_FOR_APPROVAL' as const,
    leagueId: 'league-1',
    approvalWinnerTeam:
      overrides.approvalWinnerTeam === undefined ? 2 : overrides.approvalWinnerTeam,
    players,
  };
}

describe('setApprovalWinner', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('persists the winning team on a waiting match', async () => {
    const match = waitingMatch({ approvalWinnerTeam: null });
    const updated = { ...match, approvalWinnerTeam: 1 };
    matchFindUnique.mockResolvedValueOnce(match).mockResolvedValueOnce(updated);
    matchUpdate.mockResolvedValue(updated);

    const result = await setApprovalWinner('match-1', 1);

    expect(matchUpdate).toHaveBeenCalledWith({
      where: { id: 'match-1' },
      data: { approvalWinnerTeam: 1 },
    });
    expect(result.approvalWinnerTeam).toBe(1);
    expect(result.status).toBe('WAITING_FOR_APPROVAL');
  });

  it('rejects when the match is not awaiting approval', async () => {
    matchFindUnique.mockResolvedValue({ ...waitingMatch(), status: 'IN_PROGRESS' });

    await expect(setApprovalWinner('match-1', 1)).rejects.toThrow(MatchServiceError);
    await expect(setApprovalWinner('match-1', 1)).rejects.toThrow(
      'This match is not awaiting approval.',
    );
  });
});

describe('approveWaitingMatch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('throws when no winning team is set', async () => {
    matchFindUnique.mockResolvedValue(waitingMatch({ approvalWinnerTeam: null }));

    await expect(approveWaitingMatch('match-1')).rejects.toThrow(MatchServiceError);
    await expect(approveWaitingMatch('match-1')).rejects.toThrow(
      'Set a winning team before approving this match.',
    );
    expect(completeMatch).not.toHaveBeenCalled();
  });

  it('calls completeMatch with winner and current quitter/griefer slots', async () => {
    const match = waitingMatch({ approvalWinnerTeam: 2 });
    matchFindUnique.mockResolvedValue(match);
    completeMatch.mockResolvedValue({
      match: { ...match, status: 'COMPLETED' },
      ratingPreview: { players: [] },
    });

    const result = await approveWaitingMatch('match-1');

    expect(completeMatch).toHaveBeenCalledWith('match-1', 2, [2], [7]);
    expect(result.match.status).toBe('COMPLETED');
  });
});

describe('rejectWaitingMatch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $queryRaw: queryRaw.mockResolvedValue([{ id: 'match-1' }]),
        match: {
          findUnique: matchFindUnique,
          update: matchUpdate,
        },
      }),
    );
  });

  it('cancels a waiting match without rating writes', async () => {
    const match = waitingMatch();
    const cancelled = { ...match, status: 'CANCELLED' as const };
    matchFindUnique.mockResolvedValueOnce(match).mockResolvedValueOnce(cancelled);
    matchUpdate.mockResolvedValue(cancelled);

    const result = await rejectWaitingMatch('match-1');

    expect(matchUpdate).toHaveBeenCalledWith({
      where: { id: 'match-1' },
      data: { status: 'CANCELLED' },
    });
    expect(result.status).toBe('CANCELLED');
    expect(completeMatch).not.toHaveBeenCalled();
  });
});

describe('setQuitters on WAITING_FOR_APPROVAL', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        match: {
          findUnique: vi.fn().mockResolvedValue({ status: 'WAITING_FOR_APPROVAL' }),
        },
        matchPlayer: { update: matchPlayerUpdate },
      }),
    );
    matchPlayerUpdate.mockResolvedValue({});
  });

  it('updates quitters on a waiting match', async () => {
    const match = waitingMatch({
      players: [
        { slot: 1, playerId: 'p1', team: 1, isQuitter: false },
        { slot: 7, playerId: 'p7', team: 2, isQuitter: false },
      ],
    });
    const updated = {
      ...match,
      players: match.players.map((player) =>
        player.slot === 1 ? { ...player, isQuitter: true } : player,
      ),
    };
    matchFindUnique.mockResolvedValueOnce(match).mockResolvedValueOnce(updated);

    const result = await setQuitters('match-1', [1]);

    expect(matchPlayerUpdate).toHaveBeenCalled();
    expect(result.players.find((player) => player.slot === 1)?.isQuitter).toBe(true);
  });
});
