import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  leagueFindUnique,
  leagueCreate,
  leagueUpdate,
  matchCount,
  matchFindMany,
  playerRatingFindMany,
  playerRatingCreateMany,
  playerRatingUpdate,
  playerHeroRatingFindMany,
  playerHeroRatingCreateMany,
  leagueChannelBindingCount,
  leagueChannelBindingUpdateMany,
  leagueWc3statsSlotMapFindMany,
  leagueWc3statsSlotMapCreateMany,
  leagueRolloverDraftDeleteMany,
  leagueRolloverDraftCreate,
  leagueRolloverDraftFindUnique,
  leagueRolloverDraftDelete,
  transaction,
} = vi.hoisted(() => ({
  leagueFindUnique: vi.fn(),
  leagueCreate: vi.fn(),
  leagueUpdate: vi.fn(),
  matchCount: vi.fn(),
  matchFindMany: vi.fn(),
  playerRatingFindMany: vi.fn(),
  playerRatingCreateMany: vi.fn(),
  playerRatingUpdate: vi.fn(),
  playerHeroRatingFindMany: vi.fn(),
  playerHeroRatingCreateMany: vi.fn(),
  leagueChannelBindingCount: vi.fn(),
  leagueChannelBindingUpdateMany: vi.fn(),
  leagueWc3statsSlotMapFindMany: vi.fn(),
  leagueWc3statsSlotMapCreateMany: vi.fn(),
  leagueRolloverDraftDeleteMany: vi.fn(),
  leagueRolloverDraftCreate: vi.fn(),
  leagueRolloverDraftFindUnique: vi.fn(),
  leagueRolloverDraftDelete: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: {
      findUnique: leagueFindUnique,
      create: leagueCreate,
      update: leagueUpdate,
    },
    match: {
      count: matchCount,
      findMany: matchFindMany,
    },
    playerRating: {
      findMany: playerRatingFindMany,
      createMany: playerRatingCreateMany,
      update: playerRatingUpdate,
    },
    playerHeroRating: {
      findMany: playerHeroRatingFindMany,
      createMany: playerHeroRatingCreateMany,
    },
    leagueChannelBinding: {
      count: leagueChannelBindingCount,
      updateMany: leagueChannelBindingUpdateMany,
    },
    leagueWc3statsSlotMap: {
      findMany: leagueWc3statsSlotMapFindMany,
      createMany: leagueWc3statsSlotMapCreateMany,
    },
    leagueRolloverDraft: {
      deleteMany: leagueRolloverDraftDeleteMany,
      create: leagueRolloverDraftCreate,
      findUnique: leagueRolloverDraftFindUnique,
      delete: leagueRolloverDraftDelete,
    },
    $transaction: transaction,
  },
}));

import {
  applyLeagueRollover,
  assertRolloverCompression,
  buildRolloverCancelCustomId,
  buildRolloverConfirmCustomId,
  compressMu,
  compressSigma,
  parseRolloverButtonCustomId,
  previewLeagueRollover,
  seedContinueGlobalRatings,
  seedContinueHeroRatings,
  seedSoftGlobalRatings,
  seedSoftHeroRatings,
} from './league-rollover.js';

const GUILD = 'guild-1';
const ACTOR = 'discord-actor';

const SEASON_ENDS_AT = new Date('2026-09-01T23:59:59.999Z');
const CRUNCH_STARTED_AT = new Date('2026-08-25T12:00:00.000Z');
const ACTIVITY_AT = new Date('2026-08-20T10:00:00.000Z');
const DECAY_APPLIED_AT = new Date('2026-08-22T00:00:00.000Z');

const ACTIVE_SOURCE = {
  id: 'league-1',
  guildId: GUILD,
  gameId: 'warcraft3_udbr',
  name: 'Season 1',
  status: 'ACTIVE',
  wc3statsEnabled: true,
  wc3statsMapPattern: 'udbr*',
  wc3statsMapSha1: 'sha1',
  leaderboardChannelId: 'lb-chan',
  leaderboardMessageId: 'lb-msg',
  leaderboardSize: 10,
  lobbyPlayerClaimEnabled: true,
  lobbyChannelEnabled: false,
  lobbyChannelId: null,
  wc3statsHostPromptEnabled: false,
  wc3statsHostPromptChannelId: null,
  rankResetEnabled: true,
  rankResetCooldownDays: 30,
  decayEnabled: true,
  seasonEndsAt: SEASON_ENDS_AT,
  crunchStartedAt: CRUNCH_STARTED_AT,
};

function previewInput(overrides: Partial<Parameters<typeof previewLeagueRollover>[0]> = {}) {
  return {
    guildId: GUILD,
    sourceLeagueId: 'league-1',
    successorName: 'Season 2',
    resetMode: 'hard' as const,
    actorDiscordId: ACTOR,
    ...overrides,
  };
}

describe('compressMu', () => {
  it('pulls halfway toward mean at compression 0.5', () => {
    expect(compressMu(30, 20, 0.5)).toBe(25);
  });

  it('returns mean at compression 1', () => {
    expect(compressMu(40, 25, 1)).toBe(25);
  });

  it('returns old mu at compression 0', () => {
    expect(compressMu(40, 25, 0)).toBe(40);
  });
});

describe('compressSigma', () => {
  it('raises low veteran sigma to floor 6', () => {
    expect(compressSigma(2.5)).toBe(6);
  });

  it('caps at default 8.333', () => {
    expect(compressSigma(8.333)).toBe(8.333);
  });
});

describe('seedSoftGlobalRatings', () => {
  it('compresses each player toward league mean and copies decay fields', () => {
    const out = seedSoftGlobalRatings(
      [
        {
          playerId: 'a',
          mu: 30,
          sigma: 3,
          lastQualifyingActivityAt: ACTIVITY_AT,
          idleDecayKiApplied: 4,
          lastDecayAppliedAt: DECAY_APPLIED_AT,
          isNewPlayer: false,
        },
        {
          playerId: 'b',
          mu: 20,
          sigma: 3,
          lastQualifyingActivityAt: null,
          idleDecayKiApplied: 0,
          lastDecayAppliedAt: null,
          isNewPlayer: true,
        },
      ],
      0.5,
    );
    expect(out).toEqual([
      {
        playerId: 'a',
        mu: 27.5,
        sigma: 6,
        lastQualifyingActivityAt: ACTIVITY_AT,
        idleDecayKiApplied: 4,
        lastDecayAppliedAt: DECAY_APPLIED_AT,
        isNewPlayer: false,
      },
      {
        playerId: 'b',
        mu: 22.5,
        sigma: 6,
        lastQualifyingActivityAt: null,
        idleDecayKiApplied: 0,
        lastDecayAppliedAt: null,
        isNewPlayer: true,
      },
    ]);
  });
});

describe('seedSoftHeroRatings', () => {
  it('uses per-hero means and zeroes matchesPlayed', () => {
    const out = seedSoftHeroRatings(
      [
        { playerId: 'a', heroId: 1, mu: 30, sigma: 3, matchesPlayed: 12 },
        { playerId: 'b', heroId: 1, mu: 20, sigma: 3, matchesPlayed: 8 },
      ],
      0.5,
    );
    expect(out[0]).toMatchObject({ playerId: 'a', heroId: 1, mu: 27.5, matchesPlayed: 0 });
    expect(out[1]).toMatchObject({ playerId: 'b', heroId: 1, mu: 22.5, matchesPlayed: 0 });
  });
});

describe('assertRolloverCompression', () => {
  it('rejects out of range', () => {
    expect(() => assertRolloverCompression(1.1)).toThrow(/between 0 and 1/);
  });
});

describe('seedContinueGlobalRatings', () => {
  it('copies mu, sigma, and decay fields unchanged', () => {
    const rows = [
      {
        playerId: 'a',
        mu: 30,
        sigma: 3,
        lastQualifyingActivityAt: ACTIVITY_AT,
        idleDecayKiApplied: 4,
        lastDecayAppliedAt: DECAY_APPLIED_AT,
        isNewPlayer: true,
      },
    ];
    expect(seedContinueGlobalRatings(rows)).toEqual(rows);
  });
});

describe('seedContinueHeroRatings', () => {
  it('copies mu, sigma, and matchesPlayed unchanged', () => {
    const rows = [{ playerId: 'a', heroId: 1, mu: 30, sigma: 3, matchesPlayed: 12 }];
    expect(seedContinueHeroRatings(rows)).toEqual(rows);
  });
});

describe('rollover button custom IDs', () => {
  it('round-trips confirm and cancel custom IDs', () => {
    const confirmId = buildRolloverConfirmCustomId('draft-1', ACTOR);
    const cancelId = buildRolloverCancelCustomId('draft-1', ACTOR);

    expect(confirmId).toBe('lv:c:draft-1:discord-actor');
    expect(parseRolloverButtonCustomId(confirmId)).toEqual({
      action: 'confirm',
      draftId: 'draft-1',
      actorDiscordId: ACTOR,
    });
    expect(cancelId).toBe('lv:x:draft-1:discord-actor');
    expect(parseRolloverButtonCustomId(cancelId)).toEqual({
      action: 'cancel',
      draftId: 'draft-1',
      actorDiscordId: ACTOR,
    });
  });
});

describe('previewLeagueRollover', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    leagueFindUnique.mockResolvedValue(ACTIVE_SOURCE);
    matchCount.mockResolvedValue(0);
    matchFindMany.mockResolvedValue([]);
    playerRatingFindMany.mockResolvedValue([{ playerId: 'p1' }, { playerId: 'p2' }]);
    playerHeroRatingFindMany.mockResolvedValue([{ playerId: 'p2' }]);
    leagueChannelBindingCount.mockResolvedValue(2);
    leagueRolloverDraftDeleteMany.mockResolvedValue({ count: 0 });
    leagueRolloverDraftCreate.mockResolvedValue({
      id: 'draft-1',
      sourceLeagueId: 'league-1',
      successorName: 'Season 2',
      resetMode: 'hard',
      compression: null,
      actorDiscordId: ACTOR,
    });
  });

  it('rejects an archived source league', async () => {
    leagueFindUnique.mockResolvedValue({ ...ACTIVE_SOURCE, status: 'ARCHIVED' });

    await expect(previewLeagueRollover(previewInput())).rejects.toThrow(
      'That league is archived and cannot be rolled over.',
    );
  });

  it('blocks preview when active matches exist', async () => {
    matchCount.mockResolvedValue(2);
    matchFindMany.mockResolvedValue([{ id: 'match-1' }, { id: 'match-2' }]);

    await expect(previewLeagueRollover(previewInput())).rejects.toThrow(
      'Finish or cancel all active lobbies and matches first (2 active: `match-1`, `match-2`).',
    );
    expect(leagueRolloverDraftCreate).not.toHaveBeenCalled();
  });

  it('creates a draft and returns preview counts', async () => {
    await expect(previewLeagueRollover(previewInput())).resolves.toEqual({
      draftId: 'draft-1',
      sourceLeagueId: 'league-1',
      sourceLeagueName: 'Season 1',
      successorName: 'Season 2',
      resetMode: 'hard',
      compression: null,
      playerCount: 2,
      bindingCount: 2,
    });

    expect(leagueRolloverDraftCreate).toHaveBeenCalledWith({
      data: {
        sourceLeagueId: 'league-1',
        successorName: 'Season 2',
        resetMode: 'hard',
        compression: null,
        actorDiscordId: ACTOR,
      },
    });
  });

  it('rejects compression unless reset is soft', async () => {
    await expect(
      previewLeagueRollover({
        guildId: GUILD,
        sourceLeagueId: 'league-1',
        successorName: 'Season 1.5',
        resetMode: 'continue',
        compression: 0.5,
        actorDiscordId: ACTOR,
      }),
    ).rejects.toThrow(/Compression is only used with reset:soft/);

    await expect(
      previewLeagueRollover({
        guildId: GUILD,
        sourceLeagueId: 'league-1',
        successorName: 'Fresh',
        resetMode: 'hard',
        compression: 0.5,
        actorDiscordId: ACTOR,
      }),
    ).rejects.toThrow(/Compression is only used with reset:soft/);
  });
});

describe('applyLeagueRollover', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    matchCount.mockResolvedValue(0);
    matchFindMany.mockResolvedValue([]);
    leagueRolloverDraftFindUnique.mockResolvedValue({
      id: 'draft-1',
      sourceLeagueId: 'league-1',
      successorName: 'Season 2',
      resetMode: 'hard',
      compression: null,
      actorDiscordId: ACTOR,
      sourceLeague: ACTIVE_SOURCE,
    });
    playerRatingFindMany.mockResolvedValue([
      {
        playerId: 'p1',
        mu: 30,
        sigma: 3,
        lastQualifyingActivityAt: ACTIVITY_AT,
        idleDecayKiApplied: 4,
        lastDecayAppliedAt: DECAY_APPLIED_AT,
        isNewPlayer: false,
      },
      {
        playerId: 'p2',
        mu: 20,
        sigma: 3,
        lastQualifyingActivityAt: ACTIVITY_AT,
        idleDecayKiApplied: 2,
        lastDecayAppliedAt: DECAY_APPLIED_AT,
        isNewPlayer: true,
      },
    ]);
    playerHeroRatingFindMany.mockResolvedValue([
      { playerId: 'p2', heroId: 1, mu: 28, sigma: 2.5, matchesPlayed: 5 },
    ]);
    leagueWc3statsSlotMapFindMany.mockResolvedValue([{ wc3statsSlot: 0, heroId: 1 }]);
    leagueCreate.mockResolvedValue({
      id: 'league-2',
      name: 'Season 2',
    });
    leagueChannelBindingUpdateMany.mockResolvedValue({ count: 2 });
    leagueUpdate.mockResolvedValue({ ...ACTIVE_SOURCE, status: 'ARCHIVED' });
    leagueRolloverDraftDelete.mockResolvedValue({ id: 'draft-1' });
    transaction.mockImplementation(async (callback) =>
      callback({
        match: {
          count: matchCount,
          findMany: matchFindMany,
        },
        league: {
          create: leagueCreate,
          update: leagueUpdate,
        },
        playerRating: {
          createMany: playerRatingCreateMany,
          update: playerRatingUpdate,
        },
        playerHeroRating: { createMany: playerHeroRatingCreateMany },
        leagueWc3statsSlotMap: { createMany: leagueWc3statsSlotMapCreateMany },
        leagueChannelBinding: { updateMany: leagueChannelBindingUpdateMany },
        leagueRolloverDraft: { delete: leagueRolloverDraftDelete },
      }),
    );
  });

  it('blocks apply inside transaction when active matches appear after preview', async () => {
    matchCount.mockResolvedValue(1);
    matchFindMany.mockResolvedValue([{ id: 'match-late' }]);

    await expect(
      applyLeagueRollover({ draftId: 'draft-1', actorDiscordId: ACTOR }),
    ).rejects.toThrow(
      'Finish or cancel all active lobbies and matches first (1 active: `match-late`).',
    );

    expect(leagueCreate).not.toHaveBeenCalled();
    expect(leagueUpdate).not.toHaveBeenCalled();
  });

  it('hard reset seeds global defaults with zeroed decay counters', async () => {
    await expect(
      applyLeagueRollover({ draftId: 'draft-1', actorDiscordId: ACTOR }),
    ).resolves.toMatchObject({
      archivedLeagueId: 'league-1',
      successorLeagueId: 'league-2',
      resetMode: 'hard',
      playersSeeded: 2,
      bindingsMoved: 2,
    });

    expect(leagueCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        decayEnabled: true,
        seasonEndsAt: SEASON_ENDS_AT,
        crunchStartedAt: CRUNCH_STARTED_AT,
      }),
    });
    expect(playerRatingCreateMany).toHaveBeenCalledWith({
      data: [
        {
          leagueId: 'league-2',
          playerId: 'p1',
          mu: 25,
          sigma: 8.333,
          idleDecayKiApplied: 0,
          lastQualifyingActivityAt: null,
          lastDecayAppliedAt: null,
        },
        {
          leagueId: 'league-2',
          playerId: 'p2',
          mu: 25,
          sigma: 8.333,
          idleDecayKiApplied: 0,
          lastQualifyingActivityAt: null,
          lastDecayAppliedAt: null,
        },
      ],
    });
    expect(playerHeroRatingCreateMany).not.toHaveBeenCalled();
    expect(leagueChannelBindingUpdateMany).toHaveBeenCalledWith({
      where: { leagueId: 'league-1' },
      data: { leagueId: 'league-2' },
    });
    expect(leagueUpdate).toHaveBeenCalledWith({
      where: { id: 'league-1' },
      data: {
        status: 'ARCHIVED',
        archivedAt: expect.any(Date),
        leaderboardMessageId: null,
      },
    });
  });

  it('soft reset copies compressed hero rows and decay fields', async () => {
    leagueRolloverDraftFindUnique.mockResolvedValue({
      id: 'draft-soft',
      sourceLeagueId: 'league-1',
      successorName: 'Season 2',
      resetMode: 'soft',
      compression: 0.5,
      actorDiscordId: ACTOR,
      sourceLeague: ACTIVE_SOURCE,
    });
    leagueCreate.mockResolvedValue({ id: 'league-3', name: 'Season 2' });

    await applyLeagueRollover({ draftId: 'draft-soft', actorDiscordId: ACTOR });

    expect(leagueCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        decayEnabled: true,
        seasonEndsAt: SEASON_ENDS_AT,
        crunchStartedAt: CRUNCH_STARTED_AT,
      }),
    });
    expect(playerRatingCreateMany).toHaveBeenCalledWith({
      data: [
        {
          leagueId: 'league-3',
          playerId: 'p1',
          mu: 27.5,
          sigma: 6,
          lastQualifyingActivityAt: ACTIVITY_AT,
          idleDecayKiApplied: 4,
          lastDecayAppliedAt: DECAY_APPLIED_AT,
          isNewPlayer: false,
        },
        {
          leagueId: 'league-3',
          playerId: 'p2',
          mu: 22.5,
          sigma: 6,
          lastQualifyingActivityAt: ACTIVITY_AT,
          idleDecayKiApplied: 2,
          lastDecayAppliedAt: DECAY_APPLIED_AT,
          isNewPlayer: true,
        },
      ],
    });
    expect(playerHeroRatingCreateMany).toHaveBeenCalledWith({
      data: [
        {
          leagueId: 'league-3',
          playerId: 'p2',
          heroId: 1,
          mu: 28,
          sigma: 6,
          matchesPlayed: 0,
        },
      ],
    });
  });

  it('continue sets decayEnabled false and copies decay fields', async () => {
    leagueRolloverDraftFindUnique.mockResolvedValue({
      id: 'draft-1',
      sourceLeagueId: 'league-1',
      successorName: 'Season 1.5',
      resetMode: 'continue',
      compression: null,
      actorDiscordId: ACTOR,
      sourceLeague: ACTIVE_SOURCE,
    });
    playerRatingFindMany.mockResolvedValue([
      {
        playerId: 'p1',
        mu: 30,
        sigma: 3,
        lastQualifyingActivityAt: ACTIVITY_AT,
        idleDecayKiApplied: 4,
        lastDecayAppliedAt: DECAY_APPLIED_AT,
        isNewPlayer: true,
      },
    ]);
    playerHeroRatingFindMany.mockResolvedValue([
      { playerId: 'p1', heroId: 1, mu: 28, sigma: 4, matchesPlayed: 12 },
    ]);
    leagueCreate.mockResolvedValue({ id: 'league-2', name: 'Season 1.5' });

    const result = await applyLeagueRollover({
      draftId: 'draft-1',
      actorDiscordId: ACTOR,
    });

    expect(result.resetMode).toBe('continue');
    expect(result.compression).toBeNull();
    expect(leagueCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        decayEnabled: false,
        seasonEndsAt: SEASON_ENDS_AT,
        crunchStartedAt: CRUNCH_STARTED_AT,
      }),
    });
    expect(playerRatingCreateMany).toHaveBeenCalledWith({
      data: [
        {
          leagueId: result.successorLeagueId,
          playerId: 'p1',
          mu: 30,
          sigma: 3,
          lastQualifyingActivityAt: ACTIVITY_AT,
          idleDecayKiApplied: 4,
          lastDecayAppliedAt: DECAY_APPLIED_AT,
          isNewPlayer: true,
        },
      ],
    });
    expect(playerHeroRatingCreateMany).toHaveBeenCalledWith({
      data: [
        {
          leagueId: result.successorLeagueId,
          playerId: 'p1',
          heroId: 1,
          mu: 28,
          sigma: 4,
          matchesPlayed: 12,
        },
      ],
    });
    expect(leagueUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'league-1' },
        data: expect.objectContaining({ status: 'ARCHIVED' }),
      }),
    );
    expect(playerRatingUpdate).not.toHaveBeenCalled();
  });

  it('soft/hard default decayEnabled to true when source flag is missing', async () => {
    const sourceWithoutDecay = {
      ...ACTIVE_SOURCE,
      decayEnabled: undefined,
    };
    leagueRolloverDraftFindUnique.mockResolvedValue({
      id: 'draft-soft',
      sourceLeagueId: 'league-1',
      successorName: 'Season 2',
      resetMode: 'soft',
      compression: 0.5,
      actorDiscordId: ACTOR,
      sourceLeague: sourceWithoutDecay,
    });
    leagueCreate.mockResolvedValue({ id: 'league-3', name: 'Season 2' });

    await applyLeagueRollover({ draftId: 'draft-soft', actorDiscordId: ACTOR });

    expect(leagueCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ decayEnabled: true }),
    });
  });

  it('continue does not invent a global row for a hero-only player', async () => {
    leagueRolloverDraftFindUnique.mockResolvedValue({
      id: 'draft-1',
      sourceLeagueId: 'league-1',
      successorName: 'Season 1.5',
      resetMode: 'continue',
      compression: null,
      actorDiscordId: ACTOR,
      sourceLeague: ACTIVE_SOURCE,
    });
    playerRatingFindMany.mockResolvedValue([]);
    playerHeroRatingFindMany.mockResolvedValue([
      { playerId: 'p2', heroId: 1, mu: 28, sigma: 4, matchesPlayed: 12 },
    ]);
    leagueCreate.mockResolvedValue({ id: 'league-2', name: 'Season 1.5' });

    await applyLeagueRollover({ draftId: 'draft-1', actorDiscordId: ACTOR });

    const globals = playerRatingCreateMany.mock.calls[0]?.[0]?.data ?? [];
    expect(globals.some((row: { playerId: string }) => row.playerId === 'p2')).toBe(false);
  });

  it('empty league continue seeds 0 players and still archives', async () => {
    leagueRolloverDraftFindUnique.mockResolvedValue({
      id: 'draft-1',
      sourceLeagueId: 'league-1',
      successorName: 'Season 1.5',
      resetMode: 'continue',
      compression: null,
      actorDiscordId: ACTOR,
      sourceLeague: ACTIVE_SOURCE,
    });
    playerRatingFindMany.mockResolvedValue([]);
    playerHeroRatingFindMany.mockResolvedValue([]);
    leagueCreate.mockResolvedValue({ id: 'league-2', name: 'Season 1.5' });
    leagueChannelBindingUpdateMany.mockResolvedValue({ count: 0 });

    await expect(
      applyLeagueRollover({ draftId: 'draft-1', actorDiscordId: ACTOR }),
    ).resolves.toMatchObject({
      resetMode: 'continue',
      playersSeeded: 0,
      archivedLeagueId: 'league-1',
      successorLeagueId: 'league-2',
    });

    expect(playerRatingCreateMany).not.toHaveBeenCalled();
    expect(playerHeroRatingCreateMany).not.toHaveBeenCalled();
    expect(leagueUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'league-1' },
        data: expect.objectContaining({ status: 'ARCHIVED' }),
      }),
    );
  });
});
