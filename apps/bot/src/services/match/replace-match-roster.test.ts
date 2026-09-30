import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getGameProfile } from '../../domain/game-profile.js';
import { WARCRAFT3_WOS_GAME_ID } from '../../domain/games.js';

const {
  matchFindUnique,
  prismaTransaction,
  getGameProfileForLeague,
  matchPlayerFindMany,
  matchPlayerDeleteMany,
  matchPlayerCreateMany,
  matchPlayerCreate,
  matchPlayerUpdate,
  matchFindUniqueInTx,
  matchFindUniqueOrThrow,
  matchUpdate,
  playerFindMany,
  playerCreateMany,
  playerRatingCreateMany,
  playerHeroRatingCreateMany,
} = vi.hoisted(() => ({
  matchFindUnique: vi.fn(),
  prismaTransaction: vi.fn(),
  getGameProfileForLeague: vi.fn(),
  matchPlayerFindMany: vi.fn(),
  matchPlayerDeleteMany: vi.fn(),
  matchPlayerCreateMany: vi.fn(),
  matchPlayerCreate: vi.fn(),
  matchPlayerUpdate: vi.fn(),
  matchFindUniqueInTx: vi.fn(),
  matchFindUniqueOrThrow: vi.fn(),
  matchUpdate: vi.fn(),
  playerFindMany: vi.fn(),
  playerCreateMany: vi.fn(),
  playerRatingCreateMany: vi.fn(),
  playerHeroRatingCreateMany: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    match: { findUnique: matchFindUnique },
    $transaction: prismaTransaction,
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
  getGameProfileForLeague,
  LeagueNotFoundError: class LeagueNotFoundError extends Error {},
}));

import { MatchServiceError, replaceMatchRoster } from './match-service.js';

const MATCH_ID = 'match-1';
const LEAGUE_ID = 'league-1';

type PreviousRow = {
  playerId: string;
  slot: number;
  team: number;
  heroId: number | null;
  locked: boolean;
  isQuitter: boolean;
  isGriefer: boolean;
};

function pendingMatch(overrides: Record<string, unknown> = {}) {
  return {
    id: MATCH_ID,
    status: 'PENDING',
    leagueId: LEAGUE_ID,
    eventId: null,
    ...overrides,
  };
}

function stubTransaction(previousRows: PreviousRow[]) {
  matchPlayerFindMany.mockResolvedValue(previousRows);
  matchFindUniqueInTx.mockResolvedValue(pendingMatch());
  matchPlayerDeleteMany.mockResolvedValue({ count: 0 });
  matchPlayerCreateMany.mockResolvedValue({ count: 0 });
  matchPlayerCreate.mockResolvedValue({});
  matchPlayerUpdate.mockResolvedValue({});
  matchUpdate.mockResolvedValue({});
  playerCreateMany.mockResolvedValue({ count: 0 });
  playerRatingCreateMany.mockResolvedValue({ count: 0 });
  playerHeroRatingCreateMany.mockResolvedValue({ count: 0 });
  matchFindUniqueOrThrow.mockResolvedValue({
    ...pendingMatch(),
    players: [],
  });

  prismaTransaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
    const tx = {
      match: {
        findUnique: matchFindUniqueInTx,
        findUniqueOrThrow: matchFindUniqueOrThrow,
        update: matchUpdate,
      },
      matchPlayer: {
        findMany: matchPlayerFindMany,
        deleteMany: matchPlayerDeleteMany,
        createMany: matchPlayerCreateMany,
        create: matchPlayerCreate,
        update: matchPlayerUpdate,
      },
      player: {
        findMany: playerFindMany,
        createMany: playerCreateMany,
      },
      playerRating: {
        createMany: playerRatingCreateMany,
      },
      playerHeroRating: {
        createMany: playerHeroRatingCreateMany,
      },
    };
    return fn(tx);
  });
}

/** Map incoming roster nicks to stable player ids for resolvePlayersInTx. */
function stubPlayersByNick(rows: Array<{ id: string; username: string }>) {
  playerFindMany.mockImplementation(
    async ({
      where,
    }: {
      where: {
        username?: { in?: string[] };
        OR?: Array<{ username: { equals: string } }>;
      };
    }) => {
      if (where.username?.in) {
        return rows.filter((row) => where.username!.in!.includes(row.username));
      }
      if (where.OR) {
        const nicks = new Set(where.OR.map((clause) => clause.username.equals.toLowerCase()));
        return rows.filter((row) => nicks.has(row.username.toLowerCase()));
      }
      return rows;
    },
  );
}

describe('replaceMatchRoster diff', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getGameProfileForLeague.mockResolvedValue(getGameProfile(WARCRAFT3_WOS_GAME_ID));
    matchFindUnique.mockResolvedValue(pendingMatch());
  });

  it('creates two rows when the lobby was empty (no delete)', async () => {
    stubTransaction([]);
    stubPlayersByNick([
      { id: 'p-a', username: 'alice' },
      { id: 'p-b', username: 'bob' },
    ]);

    await replaceMatchRoster(MATCH_ID, [
      { slot: 1, nick: 'alice' },
      { slot: 6, nick: 'bob' },
    ]);

    expect(matchPlayerDeleteMany).not.toHaveBeenCalled();
    expect(matchPlayerCreateMany).not.toHaveBeenCalled();
    expect(matchPlayerCreate).toHaveBeenCalledTimes(2);
    expect(matchPlayerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ matchId: MATCH_ID, playerId: 'p-a', slot: 1 }),
      }),
    );
    expect(matchPlayerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ matchId: MATCH_ID, playerId: 'p-b', slot: 6 }),
      }),
    );
  });

  it('deletes only the removed playerId when one of two players leaves', async () => {
    stubTransaction([
      {
        playerId: 'p-a',
        slot: 1,
        team: 1,
        heroId: null,
        locked: false,
        isQuitter: false,
        isGriefer: false,
      },
      {
        playerId: 'p-b',
        slot: 6,
        team: 2,
        heroId: null,
        locked: false,
        isQuitter: false,
        isGriefer: false,
      },
    ]);
    stubPlayersByNick([{ id: 'p-a', username: 'alice' }]);

    await replaceMatchRoster(MATCH_ID, [{ slot: 1, nick: 'alice' }]);

    expect(matchPlayerDeleteMany).toHaveBeenCalledTimes(1);
    expect(matchPlayerDeleteMany).toHaveBeenCalledWith({
      where: { matchId: MATCH_ID, playerId: { in: ['p-b'] } },
    });
    expect(matchPlayerCreate).not.toHaveBeenCalled();
  });

  it('does not wipe all rows when one slot changes', async () => {
    stubTransaction([
      {
        playerId: 'p-a',
        slot: 1,
        team: 1,
        heroId: null,
        locked: false,
        isQuitter: false,
        isGriefer: false,
      },
      {
        playerId: 'p-b',
        slot: 2,
        team: 1,
        heroId: null,
        locked: false,
        isQuitter: false,
        isGriefer: false,
      },
    ]);
    stubPlayersByNick([
      { id: 'p-a', username: 'alice' },
      { id: 'p-c', username: 'carol' },
    ]);

    await replaceMatchRoster(MATCH_ID, [
      { slot: 1, nick: 'alice' },
      { slot: 2, nick: 'carol' },
    ]);

    expect(matchPlayerDeleteMany).toHaveBeenCalledWith({
      where: { matchId: MATCH_ID, playerId: { in: ['p-b'] } },
    });
    expect(matchPlayerDeleteMany).not.toHaveBeenCalledWith({
      where: { matchId: MATCH_ID },
    });
    expect(matchPlayerCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ playerId: 'p-c', slot: 2 }),
      }),
    );
    // Unchanged slot-1 player is not deleted or recreated.
    expect(matchPlayerCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ playerId: 'p-a' }),
      }),
    );
  });

  it('leaves an unchanged playerId alone (no full wipe, no update)', async () => {
    stubTransaction([
      {
        playerId: 'p-a',
        slot: 1,
        team: 1,
        heroId: null,
        locked: false,
        isQuitter: false,
        isGriefer: false,
      },
    ]);
    stubPlayersByNick([{ id: 'p-a', username: 'alice' }]);

    await replaceMatchRoster(MATCH_ID, [{ slot: 1, nick: 'alice' }]);

    expect(matchPlayerDeleteMany).not.toHaveBeenCalled();
    expect(matchPlayerCreateMany).not.toHaveBeenCalled();
    expect(matchPlayerCreate).not.toHaveBeenCalled();
    expect(matchPlayerUpdate).not.toHaveBeenCalled();
  });

  it('preserves locked pair across refresh', async () => {
    stubTransaction([
      {
        playerId: 'p-a',
        slot: 1,
        team: 1,
        heroId: null,
        locked: true,
        isQuitter: false,
        isGriefer: false,
      },
      {
        playerId: 'p-b',
        slot: 6,
        team: 2,
        heroId: null,
        locked: false,
        isQuitter: false,
        isGriefer: false,
      },
    ]);
    stubPlayersByNick([
      { id: 'p-a', username: 'alice' },
      { id: 'p-b', username: 'bob' },
    ]);

    await replaceMatchRoster(MATCH_ID, [
      { slot: 1, nick: 'alice', locked: true },
      { slot: 6, nick: 'bob' },
    ]);

    expect(matchPlayerDeleteMany).not.toHaveBeenCalled();
    expect(matchPlayerCreate).not.toHaveBeenCalled();
    // Locked pair unchanged → no write; soft lock stays on the existing row.
    expect(matchPlayerUpdate).not.toHaveBeenCalled();
  });

  it('throws for non-PENDING match and skips roster writes', async () => {
    matchFindUnique.mockResolvedValue(pendingMatch({ status: 'IN_PROGRESS' }));
    stubTransaction([]);
    matchFindUniqueInTx.mockResolvedValue(pendingMatch({ status: 'IN_PROGRESS' }));
    stubPlayersByNick([{ id: 'p-a', username: 'alice' }]);

    await expect(replaceMatchRoster(MATCH_ID, [{ slot: 1, nick: 'alice' }])).rejects.toThrow(
      MatchServiceError,
    );
    await expect(replaceMatchRoster(MATCH_ID, [{ slot: 1, nick: 'alice' }])).rejects.toThrow(
      'This match can no longer be edited.',
    );

    expect(matchPlayerDeleteMany).not.toHaveBeenCalled();
    expect(matchPlayerCreate).not.toHaveBeenCalled();
    expect(matchPlayerCreateMany).not.toHaveBeenCalled();
    expect(matchPlayerUpdate).not.toHaveBeenCalled();
  });

  it('updates when an existing player changes slot', async () => {
    stubTransaction([
      {
        playerId: 'p-a',
        slot: 1,
        team: 1,
        heroId: null,
        locked: false,
        isQuitter: false,
        isGriefer: false,
      },
    ]);
    stubPlayersByNick([{ id: 'p-a', username: 'alice' }]);

    await replaceMatchRoster(MATCH_ID, [{ slot: 2, nick: 'alice' }]);

    expect(matchPlayerDeleteMany).not.toHaveBeenCalled();
    expect(matchPlayerCreate).not.toHaveBeenCalled();
    expect(matchPlayerUpdate).toHaveBeenCalledWith({
      where: { matchId_playerId: { matchId: MATCH_ID, playerId: 'p-a' } },
      data: expect.objectContaining({ slot: 2, team: 1, locked: false }),
    });
  });

  it('updates both rows when two players swap slots (no delete)', async () => {
    stubTransaction([
      {
        playerId: 'p-a',
        slot: 1,
        team: 1,
        heroId: null,
        locked: false,
        isQuitter: false,
        isGriefer: false,
      },
      {
        playerId: 'p-b',
        slot: 6,
        team: 2,
        heroId: null,
        locked: false,
        isQuitter: false,
        isGriefer: false,
      },
    ]);
    stubPlayersByNick([
      { id: 'p-a', username: 'alice' },
      { id: 'p-b', username: 'bob' },
    ]);

    await replaceMatchRoster(MATCH_ID, [
      { slot: 6, nick: 'alice' },
      { slot: 1, nick: 'bob' },
    ]);

    expect(matchPlayerDeleteMany).not.toHaveBeenCalled();
    expect(matchPlayerCreate).not.toHaveBeenCalled();
    expect(matchPlayerUpdate).toHaveBeenCalledTimes(2);
    expect(matchPlayerUpdate).toHaveBeenCalledWith({
      where: { matchId_playerId: { matchId: MATCH_ID, playerId: 'p-a' } },
      data: expect.objectContaining({ slot: 6, team: 2, locked: false }),
    });
    expect(matchPlayerUpdate).toHaveBeenCalledWith({
      where: { matchId_playerId: { matchId: MATCH_ID, playerId: 'p-b' } },
      data: expect.objectContaining({ slot: 1, team: 1, locked: false }),
    });
  });

  it('unlocks when incoming roster omits locked for a previously locked pair', async () => {
    stubTransaction([
      {
        playerId: 'p-a',
        slot: 1,
        team: 1,
        heroId: null,
        locked: true,
        isQuitter: false,
        isGriefer: false,
      },
      {
        playerId: 'p-b',
        slot: 6,
        team: 2,
        heroId: null,
        locked: false,
        isQuitter: false,
        isGriefer: false,
      },
    ]);
    stubPlayersByNick([
      { id: 'p-a', username: 'alice' },
      { id: 'p-b', username: 'bob' },
    ]);

    // OCR/wc3stats omit locked → reconcile returns false; must write unlock.
    await replaceMatchRoster(MATCH_ID, [
      { slot: 1, nick: 'alice' },
      { slot: 6, nick: 'bob' },
    ]);

    expect(matchPlayerDeleteMany).not.toHaveBeenCalled();
    expect(matchPlayerCreate).not.toHaveBeenCalled();
    expect(matchPlayerUpdate).toHaveBeenCalledTimes(1);
    expect(matchPlayerUpdate).toHaveBeenCalledWith({
      where: { matchId_playerId: { matchId: MATCH_ID, playerId: 'p-a' } },
      data: expect.objectContaining({ slot: 1, locked: false }),
    });
  });

  it('deletes all previous rows when roster becomes empty', async () => {
    stubTransaction([
      {
        playerId: 'p-a',
        slot: 1,
        team: 1,
        heroId: null,
        locked: false,
        isQuitter: false,
        isGriefer: false,
      },
      {
        playerId: 'p-b',
        slot: 6,
        team: 2,
        heroId: null,
        locked: false,
        isQuitter: false,
        isGriefer: false,
      },
    ]);
    stubPlayersByNick([]);

    await replaceMatchRoster(MATCH_ID, []);

    expect(matchPlayerDeleteMany).toHaveBeenCalledTimes(1);
    expect(matchPlayerDeleteMany).toHaveBeenCalledWith({
      where: { matchId: MATCH_ID, playerId: { in: expect.arrayContaining(['p-a', 'p-b']) } },
    });
    expect(matchPlayerCreate).not.toHaveBeenCalled();
    expect(matchPlayerUpdate).not.toHaveBeenCalled();
  });
});
