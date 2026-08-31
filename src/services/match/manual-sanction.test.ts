import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addManualSanction,
  findLatestManualSanctionMatchId,
  removeManualSanction,
} from './manual-sanction.js';
import { MatchServiceError } from './match-service.js';
import { LEAGUE_ARCHIVED_MESSAGE } from '../league/league.js';

const {
  leagueFindUnique,
  playerFindUnique,
  playerFindFirst,
  matchCreate,
  matchPlayerCreate,
  matchPlayerFindUnique,
  matchPlayerFindMany,
  matchPlayerUpdate,
  transaction,
  writeMatchRatingSnapshots,
  applyQuitterPenalties,
  accrueGrieferPenalties,
  loadLiveGlobalByPlayer,
  loadMatchDisplayStatsByPlayer,
  ensurePlayerRatings,
  restoreMatchRatingSnapshots,
  clearMatchGriefers,
  clearMatchQuitters,
  getMatchById,
} = vi.hoisted(() => ({
  leagueFindUnique: vi.fn(),
  playerFindUnique: vi.fn(),
  playerFindFirst: vi.fn(),
  matchCreate: vi.fn(),
  matchPlayerCreate: vi.fn(),
  matchPlayerFindUnique: vi.fn(),
  matchPlayerFindMany: vi.fn(),
  matchPlayerUpdate: vi.fn(),
  transaction: vi.fn(),
  writeMatchRatingSnapshots: vi.fn(),
  applyQuitterPenalties: vi.fn(),
  accrueGrieferPenalties: vi.fn(),
  loadLiveGlobalByPlayer: vi.fn(),
  loadMatchDisplayStatsByPlayer: vi.fn(),
  ensurePlayerRatings: vi.fn(),
  restoreMatchRatingSnapshots: vi.fn(),
  clearMatchGriefers: vi.fn(),
  clearMatchQuitters: vi.fn(),
  getMatchById: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique: leagueFindUnique },
    player: { findUnique: playerFindUnique },
    matchPlayer: {
      findFirst: playerFindFirst,
      findUnique: matchPlayerFindUnique,
      findMany: matchPlayerFindMany,
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

vi.mock('../league/league-profile.js', () => ({
  getGameProfileForLeague: vi.fn(async () => ({
    heroBinding: 'optional_in_game',
  })),
}));

vi.mock('./match-correction.js', () => ({
  writeMatchRatingSnapshots,
  restoreMatchRatingSnapshots,
}));

vi.mock('../rating/rating-update.js', () => ({
  applyQuitterPenalties,
  accrueGrieferPenalties,
  loadLiveGlobalByPlayer,
}));

vi.mock('../rating/rank-reset-display.js', () => ({
  loadMatchDisplayStatsByPlayer,
  gamesByPlayerFromStats: () => new Map(),
}));

vi.mock('../rating/rating-preview.js', () => ({
  ensurePlayerRatings,
}));

vi.mock('./match-report.js', () => ({
  clearMatchGriefers,
  clearMatchQuitters,
}));

vi.mock('./match-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./match-service.js')>();
  return {
    ...actual,
    getMatchById,
  };
});

describe('addManualSanction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    leagueFindUnique.mockResolvedValue({ status: 'ACTIVE' });
    playerFindUnique.mockResolvedValue({ id: 'p1', username: 'goku' });
    matchCreate.mockResolvedValue({ id: 'sanction-1' });
    matchPlayerCreate.mockResolvedValue({});
    loadMatchDisplayStatsByPlayer.mockResolvedValue(
      new Map([['p1', { games: 5, wins: 3, losses: 2, quits: 2, griefs: 0 }]]),
    );
    matchPlayerFindUnique.mockResolvedValue({ grieferKiAccrued: null });
    transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        match: { create: matchCreate },
        matchPlayer: { create: matchPlayerCreate },
      };
      await fn(tx);
    });
  });

  it('creates a cancelled manual match and applies quitter penalties', async () => {
    const result = await addManualSanction({
      leagueId: 'league-1',
      playerId: 'p1',
      type: 'quitter',
      actorDiscordId: 'mod-1',
      discordChannelId: 'chan-1',
    });

    expect(matchCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'CANCELLED',
        isManualSanction: true,
        leagueId: 'league-1',
      }),
    });
    expect(matchPlayerCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        playerId: 'p1',
        isQuitter: true,
        isGriefer: false,
      }),
    });
    expect(writeMatchRatingSnapshots).toHaveBeenCalled();
    expect(applyQuitterPenalties).toHaveBeenCalled();
    expect(accrueGrieferPenalties).not.toHaveBeenCalled();
    expect(result.matchId).toBe('sanction-1');
    expect(result.quits).toBe(2);
  });

  it('accrues griefer tax on griefer add', async () => {
    matchPlayerFindUnique.mockResolvedValue({ grieferKiAccrued: 125 });

    const result = await addManualSanction({
      leagueId: 'league-1',
      playerId: 'p1',
      type: 'griefer',
      actorDiscordId: 'mod-1',
      discordChannelId: 'chan-1',
    });

    expect(accrueGrieferPenalties).toHaveBeenCalled();
    expect(writeMatchRatingSnapshots).not.toHaveBeenCalled();
    expect(applyQuitterPenalties).not.toHaveBeenCalled();
    expect(result.grieferKiAccrued).toBe(125);
  });

  it('rejects archived leagues', async () => {
    leagueFindUnique.mockResolvedValue({ status: 'ARCHIVED' });

    await expect(
      addManualSanction({
        leagueId: 'league-1',
        playerId: 'p1',
        type: 'quitter',
        actorDiscordId: 'mod-1',
        discordChannelId: 'chan-1',
      }),
    ).rejects.toThrow(new MatchServiceError(LEAGUE_ARCHIVED_MESSAGE));
  });
});

describe('findLatestManualSanctionMatchId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries manual cancelled rows for quitters', async () => {
    playerFindFirst.mockResolvedValue({ matchId: 'm1' });

    const id = await findLatestManualSanctionMatchId('league-1', 'p1', 'quitter');

    expect(id).toBe('m1');
    expect(playerFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isQuitter: true,
          match: expect.objectContaining({ isManualSanction: true, status: 'CANCELLED' }),
        }),
      }),
    );
  });
});

describe('removeManualSanction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    leagueFindUnique.mockResolvedValue({ status: 'ACTIVE' });
    transaction.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        matchPlayer: {
          findMany: matchPlayerFindMany.mockResolvedValue([{ playerId: 'p1' }]),
          update: matchPlayerUpdate,
        },
      };
      await fn(tx);
    });
    matchPlayerFindMany.mockResolvedValue([{ playerId: 'p1' }]);
  });

  it('restores snapshots when removing latest manual quitter', async () => {
    playerFindFirst.mockResolvedValue({ matchId: 'sanction-1' });
    getMatchById.mockResolvedValue({
      id: 'sanction-1',
      leagueId: 'league-1',
      isManualSanction: true,
      players: [{ playerId: 'p1', slot: 1, isQuitter: true, isGriefer: false }],
    });

    const result = await removeManualSanction({
      leagueId: 'league-1',
      playerId: 'p1',
      username: 'goku',
      type: 'quitter',
    });

    expect(restoreMatchRatingSnapshots).toHaveBeenCalledWith(
      'league-1',
      'sanction-1',
      expect.anything(),
    );
    expect(result.mode).toBe('manual_restored');
  });

  it('delegates to clearMatchGriefers for latest manual griefer', async () => {
    playerFindFirst.mockResolvedValue({ matchId: 'sanction-2' });
    getMatchById.mockResolvedValue({
      id: 'sanction-2',
      leagueId: 'league-1',
      isManualSanction: true,
      players: [{ playerId: 'p1', slot: 1, isQuitter: false, isGriefer: true }],
    });

    const result = await removeManualSanction({
      leagueId: 'league-1',
      playerId: 'p1',
      username: 'goku',
      type: 'griefer',
    });

    expect(clearMatchGriefers).toHaveBeenCalledWith('sanction-2');
    expect(result.mode).toBe('delegated_clear');
  });

  it('throws when no manual sanction exists', async () => {
    playerFindFirst.mockResolvedValue(null);

    await expect(
      removeManualSanction({
        leagueId: 'league-1',
        playerId: 'p1',
        username: 'goku',
        type: 'quitter',
      }),
    ).rejects.toThrow(/No manual quitter sanction/);
  });

  it('delegates to clearMatchQuitters when match_id is provided', async () => {
    getMatchById.mockResolvedValue({
      id: 'match-9',
      leagueId: 'league-1',
      isManualSanction: false,
      players: [{ playerId: 'p1', slot: 1, isQuitter: true, isGriefer: false }],
    });
    clearMatchQuitters.mockResolvedValue({
      match: { id: 'match-9' },
      cleared: [],
      mode: 'flag_only',
    });

    const result = await removeManualSanction({
      leagueId: 'league-1',
      playerId: 'p1',
      username: 'goku',
      type: 'quitter',
      matchId: 'match-9',
    });

    expect(clearMatchQuitters).toHaveBeenCalledWith('match-9', [1]);
    expect(result.mode).toBe('delegated_clear');
  });
});
