import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@dbz/db';
import { WARCRAFT3_UDBR_GAME_ID, WARCRAFT3_WOS_GAME_ID } from '../../domain/games.js';
import { MatchServiceError } from '../match/match-service.js';
import {
  HERO_CHAMPION_ROLE_DUPLICATE,
  HERO_CHAMPION_ROLES_UNSUPPORTED,
  setLeagueHeroChampionRole,
  setLeagueHeroChampionRolesEnabled,
} from './hero-champion-config.js';

const { leagueFindUnique, leagueUpdate, heroFindUnique, championUpsert, transaction } = vi.hoisted(
  () => ({
    leagueFindUnique: vi.fn(),
    leagueUpdate: vi.fn(),
    heroFindUnique: vi.fn(),
    championUpsert: vi.fn(),
    transaction: vi.fn((callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        leagueHeroChampionRole: { upsert: championUpsert },
        league: { update: leagueUpdate },
      }),
    ),
  }),
);

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: { findUnique: leagueFindUnique, update: leagueUpdate },
    hero: { findUnique: heroFindUnique },
    leagueHeroChampionRole: { upsert: championUpsert },
    leagueRankRole: { findUnique: async () => null },
    $transaction: transaction,
  },
}));

describe('hero champion config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses enable on unsupported games', async () => {
    leagueFindUnique.mockResolvedValue({ gameId: WARCRAFT3_WOS_GAME_ID });
    await expect(setLeagueHeroChampionRolesEnabled('L1', true)).rejects.toThrow(
      HERO_CHAMPION_ROLES_UNSUPPORTED,
    );
    expect(leagueUpdate).not.toHaveBeenCalled();
  });

  it('enables for UDBR and marks dirty', async () => {
    leagueFindUnique.mockResolvedValue({ gameId: WARCRAFT3_UDBR_GAME_ID });
    leagueUpdate.mockResolvedValue({});
    await setLeagueHeroChampionRolesEnabled('L1', true);
    expect(leagueUpdate).toHaveBeenCalledWith({
      where: { id: 'L1' },
      data: { heroChampionRolesEnabled: true, heroChampionRolesDirty: true },
    });
  });

  it('disables for UDBR without setting dirty', async () => {
    leagueFindUnique.mockResolvedValue({ gameId: WARCRAFT3_UDBR_GAME_ID });
    leagueUpdate.mockResolvedValue({});
    await setLeagueHeroChampionRolesEnabled('L1', false);
    expect(leagueUpdate).toHaveBeenCalledWith({
      where: { id: 'L1' },
      data: { heroChampionRolesEnabled: false },
    });
  });

  it('maps duplicate Discord role to a friendly error', async () => {
    leagueFindUnique.mockResolvedValue({ gameId: WARCRAFT3_UDBR_GAME_ID });
    heroFindUnique.mockResolvedValue({ id: 1, name: 'Goku' });
    championUpsert.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(setLeagueHeroChampionRole('L1', 1, 'role-1')).rejects.toThrow(
      HERO_CHAMPION_ROLE_DUPLICATE,
    );
    await expect(setLeagueHeroChampionRole('L1', 1, 'role-1')).rejects.toBeInstanceOf(
      MatchServiceError,
    );
  });

  it('sets hero champion role and marks league dirty', async () => {
    leagueFindUnique.mockResolvedValue({ gameId: WARCRAFT3_UDBR_GAME_ID });
    heroFindUnique.mockResolvedValue({ id: 1, name: 'Goku' });
    championUpsert.mockResolvedValue({});
    leagueUpdate.mockResolvedValue({});

    await setLeagueHeroChampionRole('L1', 1, 'role-1');

    expect(championUpsert).toHaveBeenCalledWith({
      where: { leagueId_heroId: { leagueId: 'L1', heroId: 1 } },
      create: {
        leagueId: 'L1',
        heroId: 1,
        discordRoleId: 'role-1',
        holderDiscordId: null,
      },
      update: {
        discordRoleId: 'role-1',
        holderDiscordId: null,
      },
    });
    expect(leagueUpdate).toHaveBeenCalledWith({
      where: { id: 'L1' },
      data: { heroChampionRolesDirty: true },
    });
  });
});
