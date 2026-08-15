import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  leagueFindUnique,
  playerFindUnique,
  matchPlayerFindFirst,
  playerRankResetFindFirst,
  playerRatingUpsert,
  playerHeroRatingDeleteMany,
  playerRankResetCreate,
  transaction,
} = vi.hoisted(() => ({
  leagueFindUnique: vi.fn(),
  playerFindUnique: vi.fn(),
  matchPlayerFindFirst: vi.fn(),
  playerRankResetFindFirst: vi.fn(),
  playerRatingUpsert: vi.fn(),
  playerHeroRatingDeleteMany: vi.fn(),
  playerRankResetCreate: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique: leagueFindUnique },
    player: { findUnique: playerFindUnique },
    matchPlayer: { findFirst: matchPlayerFindFirst },
    playerRankReset: {
      findFirst: playerRankResetFindFirst,
      create: playerRankResetCreate,
    },
    playerRating: { upsert: playerRatingUpsert },
    playerHeroRating: { deleteMany: playerHeroRatingDeleteMany },
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

vi.mock('../../config/env.js', () => ({
  env: {
    geminiApiKey: 'test-key',
    wc3statsTimeoutMs: 4000,
  },
}));

import {
  applyRankReset,
  assertRankResetCooldownDays,
  buildRankResetCancelCustomId,
  buildRankResetConfirmCustomId,
  isRankResetCooldownElapsed,
  nextRankResetAt,
  parseRankResetButtonCustomId,
  previewRankReset,
  RANK_RESET_COOLDOWN_DEFAULT_DAYS,
  RANK_RESET_COOLDOWN_MAX_DAYS,
  RANK_RESET_COOLDOWN_MIN_DAYS,
  RankResetServiceError,
} from './rank-reset.js';

const NOW = new Date('2026-08-15T12:00:00.000Z');
const PLAYER = { id: 'player-1', username: 'Goku', discordId: 'discord-target' };

function selfInput() {
  return {
    leagueId: 'league-1',
    actorDiscordId: 'discord-target',
    targetDiscordId: 'discord-target',
    memberRoleIds: [],
    now: NOW,
  };
}

describe('rank-reset cooldown helpers', () => {
  it('exposes the configured cooldown bounds and default', () => {
    expect(RANK_RESET_COOLDOWN_MIN_DAYS).toBe(1);
    expect(RANK_RESET_COOLDOWN_MAX_DAYS).toBe(365);
    expect(RANK_RESET_COOLDOWN_DEFAULT_DAYS).toBe(30);
  });

  it.each([1, 365])('accepts an integer cooldown of %i days', (days) => {
    expect(assertRankResetCooldownDays(days)).toBe(days);
  });

  it.each([0, 366, 1.5])('rejects an invalid cooldown of %s days', (days) => {
    expect(() => assertRankResetCooldownDays(days)).toThrow(RankResetServiceError);
    expect(() => assertRankResetCooldownDays(days)).toThrow(
      'Rank reset cooldown must be between 1 and 365 days.',
    );
  });

  it('adds calendar-length days to the last reset time', () => {
    const lastResetAt = new Date('2026-01-10T06:30:00.000Z');

    expect(nextRankResetAt(lastResetAt, 30)).toEqual(
      new Date('2026-02-09T06:30:00.000Z'),
    );
  });

  it('treats the exact next-reset instant as elapsed', () => {
    const lastResetAt = new Date('2026-01-10T06:30:00.000Z');

    expect(
      isRankResetCooldownElapsed(
        lastResetAt,
        30,
        new Date('2026-02-09T06:29:59.999Z'),
      ),
    ).toBe(false);
    expect(
      isRankResetCooldownElapsed(
        lastResetAt,
        30,
        new Date('2026-02-09T06:30:00.000Z'),
      ),
    ).toBe(true);
  });
});

describe('rank-reset button custom IDs', () => {
  it('round-trips a confirm custom ID', () => {
    const customId = buildRankResetConfirmCustomId(
      'league-1',
      'player-1',
      'discord-actor',
    );

    expect(customId).toBe('rank_reset:confirm:league-1:player-1:discord-actor');
    expect(parseRankResetButtonCustomId(customId)).toEqual({
      action: 'confirm',
      leagueId: 'league-1',
      playerId: 'player-1',
      actorDiscordId: 'discord-actor',
    });
  });

  it('round-trips a cancel custom ID', () => {
    const customId = buildRankResetCancelCustomId(
      'league-1',
      'player-1',
      'discord-actor',
    );

    expect(customId).toBe('rank_reset:cancel:league-1:player-1:discord-actor');
    expect(parseRankResetButtonCustomId(customId)).toEqual({
      action: 'cancel',
      leagueId: 'league-1',
      playerId: 'player-1',
      actorDiscordId: 'discord-actor',
    });
  });

  it.each([
    'rank_reset:approve:league-1:player-1:discord-actor',
    'rank_reset:confirm:league-1:player-1',
    'other:confirm:league-1:player-1:discord-actor',
    'rank_reset:confirm::player-1:discord-actor',
  ])('returns null for invalid custom ID %s', (customId) => {
    expect(parseRankResetButtonCustomId(customId)).toBeNull();
  });
});

describe('previewRankReset', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    leagueFindUnique.mockResolvedValue({
      rankResetEnabled: true,
      rankResetCooldownDays: 30,
    });
    playerFindUnique.mockResolvedValue(PLAYER);
    matchPlayerFindFirst.mockResolvedValue(null);
    playerRankResetFindFirst.mockResolvedValue(null);
  });

  it('rejects when rank reset is disabled for the league', async () => {
    leagueFindUnique.mockResolvedValue({
      rankResetEnabled: false,
      rankResetCooldownDays: 30,
    });

    await expect(previewRankReset(selfInput())).rejects.toThrow(
      'Rank reset is disabled for this league.',
    );
  });

  it('tells an unlinked self to link before resetting', async () => {
    playerFindUnique.mockResolvedValue(null);

    await expect(previewRankReset(selfInput())).rejects.toThrow(
      'Link your Discord with /link before resetting your rank.',
    );
  });

  it('tells staff when the targeted Discord user is unlinked', async () => {
    playerFindUnique.mockResolvedValue(null);

    await expect(
      previewRankReset({
        ...selfInput(),
        actorDiscordId: 'discord-mod',
        memberRoleIds: ['role-mod'],
        matchModRoleId: 'role-mod',
      }),
    ).rejects.toThrow(
      'That Discord user is not linked to a player. They must /link first.',
    );
  });

  it('rejects a target on an active league roster', async () => {
    matchPlayerFindFirst.mockResolvedValue({ matchId: 'match-1' });

    await expect(previewRankReset(selfInput())).rejects.toThrow(
      "You can't reset rank while that player is in an active lobby or match.",
    );
    expect(matchPlayerFindFirst).toHaveBeenCalledWith({
      where: {
        playerId: PLAYER.id,
        match: {
          leagueId: 'league-1',
          status: { in: ['PENDING', 'IN_PROGRESS'] },
        },
      },
    });
  });

  it('rejects a self reset during cooldown with a Discord relative timestamp', async () => {
    playerRankResetFindFirst.mockResolvedValue({
      createdAt: new Date('2026-08-01T12:00:00.000Z'),
    });

    await expect(previewRankReset(selfInput())).rejects.toThrow(
      'You can reset again <t:1788177600:R>.',
    );
  });

  it('allows a match moderator to override the target cooldown', async () => {
    playerRankResetFindFirst.mockResolvedValue({
      createdAt: new Date('2026-08-14T12:00:00.000Z'),
    });

    await expect(
      previewRankReset({
        ...selfInput(),
        actorDiscordId: 'discord-mod',
        memberRoleIds: ['role-mod'],
        matchModRoleId: 'role-mod',
      }),
    ).resolves.toEqual({
      leagueId: 'league-1',
      playerId: PLAYER.id,
      username: PLAYER.username,
      targetDiscordId: 'discord-target',
      staffOverride: true,
      cooldownDays: 30,
    });
    expect(playerRankResetFindFirst).not.toHaveBeenCalled();
  });
});

describe('applyRankReset', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    leagueFindUnique.mockResolvedValue({
      rankResetEnabled: true,
      rankResetCooldownDays: 30,
    });
    playerFindUnique.mockResolvedValue(PLAYER);
    matchPlayerFindFirst.mockResolvedValue(null);
    playerRankResetFindFirst.mockResolvedValue(null);
    transaction.mockImplementation(async (callback) =>
      callback({
        playerRating: { upsert: playerRatingUpsert },
        playerHeroRating: { deleteMany: playerHeroRatingDeleteMany },
        playerRankReset: { create: playerRankResetCreate },
      }),
    );
  });

  it('resets overall and hero ratings and creates a self-reset audit row', async () => {
    await expect(applyRankReset(selfInput())).resolves.toEqual({
      playerId: PLAYER.id,
      username: PLAYER.username,
      staffOverride: false,
    });

    expect(playerRatingUpsert).toHaveBeenCalledWith({
      where: {
        leagueId_playerId: {
          leagueId: 'league-1',
          playerId: PLAYER.id,
        },
      },
      create: {
        leagueId: 'league-1',
        playerId: PLAYER.id,
        mu: 25,
        sigma: 8.333,
      },
      update: { mu: 25, sigma: 8.333 },
    });
    expect(playerHeroRatingDeleteMany).toHaveBeenCalledWith({
      where: { leagueId: 'league-1', playerId: PLAYER.id },
    });
    expect(playerRankResetCreate).toHaveBeenCalledWith({
      data: {
        leagueId: 'league-1',
        playerId: PLAYER.id,
        actorDiscordId: 'discord-target',
        targetDiscordId: 'discord-target',
        staffOverride: false,
      },
    });
  });

  it('rejects a stale confirmation bound to a different player', async () => {
    await expect(
      applyRankReset({ ...selfInput(), expectedPlayerId: 'old-player-id' }),
    ).rejects.toThrow('That rank reset confirmation is no longer valid.');
    expect(transaction).not.toHaveBeenCalled();
  });
});
