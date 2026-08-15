import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Prisma mock — must be hoisted before any imports that use prisma
// ---------------------------------------------------------------------------

const { leagueFindUnique, leagueFindMany, bindingFindUnique } = vi.hoisted(() => ({
  leagueFindUnique: vi.fn(),
  leagueFindMany: vi.fn(),
  bindingFindUnique: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    league: {
      findUnique: leagueFindUnique,
      findMany: leagueFindMany,
    },
    leagueChannelBinding: {
      findUnique: bindingFindUnique,
    },
  },
}));

import { resolveLeagueContext } from './league-resolve.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GUILD = 'guild-1';
const OTHER_GUILD = 'guild-2';

const league1 = {
  id: 'league-1',
  guildId: GUILD,
  gameId: 'warcraft3_udbr',
  name: 'League One',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

const league2 = {
  id: 'league-2',
  guildId: GUILD,
  gameId: 'warcraft3_udbr',
  name: 'League Two',
  createdAt: new Date('2024-02-01'),
  updatedAt: new Date('2024-02-01'),
};

function channelBinding(discordId: string, leagueId: string, league = league1) {
  return { leagueId, discordId, kind: 'CHANNEL' as const, league };
}

function categoryBinding(discordId: string, leagueId: string, league = league1) {
  return { leagueId, discordId, kind: 'CATEGORY' as const, league };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveLeagueContext', () => {
  beforeEach(() => {
    leagueFindUnique.mockReset();
    leagueFindMany.mockReset();
    bindingFindUnique.mockReset();
  });

  // -------------------------------------------------------------------------
  // Step 1 — explicit leagueIdOption
  // -------------------------------------------------------------------------

  describe('explicit leagueIdOption', () => {
    it('returns the league when option is valid and belongs to the guild', async () => {
      leagueFindUnique.mockResolvedValue(league1);

      const result = await resolveLeagueContext({
        guildId: GUILD,
        leagueIdOption: 'league-1',
      });

      expect(result).toEqual({ ok: true, league: league1 });
      expect(leagueFindUnique).toHaveBeenCalledWith({ where: { id: 'league-1' } });
    });

    it('returns invalid_option when the id does not exist', async () => {
      leagueFindUnique.mockResolvedValue(null);

      const result = await resolveLeagueContext({
        guildId: GUILD,
        leagueIdOption: 'nonexistent',
      });

      expect(result).toEqual({ ok: false, reason: 'invalid_option' });
    });

    it('returns not_in_guild when the league belongs to a different guild', async () => {
      leagueFindUnique.mockResolvedValue({ ...league1, guildId: OTHER_GUILD });

      const result = await resolveLeagueContext({
        guildId: GUILD,
        leagueIdOption: 'league-1',
      });

      expect(result).toEqual({ ok: false, reason: 'not_in_guild' });
    });

    it('does not query bindings or fallback when option is provided', async () => {
      leagueFindUnique.mockResolvedValue(league1);

      await resolveLeagueContext({
        guildId: GUILD,
        channelId: 'chan-x',
        leagueIdOption: 'league-1',
      });

      expect(bindingFindUnique).not.toHaveBeenCalled();
      expect(leagueFindMany).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Step 2 — channel binding
  // -------------------------------------------------------------------------

  describe('channel binding', () => {
    it('resolves via channel binding when no option provided', async () => {
      bindingFindUnique.mockResolvedValueOnce(channelBinding('chan-1', 'league-1'));

      const result = await resolveLeagueContext({
        guildId: GUILD,
        channelId: 'chan-1',
      });

      expect(result).toEqual({ ok: true, league: league1 });
      expect(bindingFindUnique).toHaveBeenCalledWith({
        where: { discordId: 'chan-1' },
        include: { league: true },
      });
    });

    it('skips channel binding when channelId is null', async () => {
      leagueFindMany.mockResolvedValue([league1]);

      await resolveLeagueContext({ guildId: GUILD, channelId: null });

      // binding is never called for the channel step
      expect(bindingFindUnique).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { discordId: null } }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Step 3 — category binding
  // -------------------------------------------------------------------------

  describe('category binding', () => {
    it('resolves via category binding when no channel binding exists', async () => {
      // channel binding lookup returns nothing useful
      bindingFindUnique
        .mockResolvedValueOnce(null) // channel lookup
        .mockResolvedValueOnce(categoryBinding('cat-1', 'league-1')); // category lookup

      const result = await resolveLeagueContext({
        guildId: GUILD,
        channelId: 'chan-no-binding',
        categoryId: 'cat-1',
      });

      expect(result).toEqual({ ok: true, league: league1 });
    });

    it('skips category binding when categoryId is null', async () => {
      bindingFindUnique.mockResolvedValue(null);
      leagueFindMany.mockResolvedValue([league1]);

      await resolveLeagueContext({
        guildId: GUILD,
        channelId: 'chan-no-binding',
        categoryId: null,
      });

      // only one binding lookup (for the channel), none for null category
      expect(bindingFindUnique).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Channel wins over category (step 2 before step 3)
  // -------------------------------------------------------------------------

  describe('channel wins over category', () => {
    it('uses channel binding even when category binding also exists', async () => {
      const league2WithBinding = { ...league2 };
      bindingFindUnique
        .mockResolvedValueOnce(channelBinding('chan-1', 'league-1', league1)) // channel → league1
        .mockResolvedValueOnce(categoryBinding('cat-1', 'league-2', league2WithBinding)); // would be league2

      const result = await resolveLeagueContext({
        guildId: GUILD,
        channelId: 'chan-1',
        categoryId: 'cat-1',
      });

      expect(result).toEqual({ ok: true, league: league1 });
      // category lookup should not even be reached
      expect(bindingFindUnique).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Steps 4-5 — guild fallback
  // -------------------------------------------------------------------------

  describe('guild fallback', () => {
    it('returns the single league when exactly one league exists', async () => {
      bindingFindUnique.mockResolvedValue(null);
      leagueFindMany.mockResolvedValue([league1]);

      const result = await resolveLeagueContext({ guildId: GUILD });

      expect(result).toEqual({ ok: true, league: league1 });
      expect(leagueFindMany).toHaveBeenCalledWith({
        where: { guildId: GUILD },
        orderBy: { createdAt: 'asc' },
      });
    });

    it('returns no_leagues when zero leagues exist', async () => {
      leagueFindMany.mockResolvedValue([]);

      const result = await resolveLeagueContext({ guildId: GUILD });

      expect(result).toEqual({ ok: false, reason: 'no_leagues' });
    });

    it('returns ambiguous when multiple leagues exist and no binding matches', async () => {
      bindingFindUnique.mockResolvedValue(null);
      leagueFindMany.mockResolvedValue([league1, league2]);

      const result = await resolveLeagueContext({
        guildId: GUILD,
        channelId: 'unbound-chan',
      });

      expect(result).toEqual({ ok: false, reason: 'ambiguous' });
    });
  });
});
