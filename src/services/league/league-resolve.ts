import type { League } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

export type LeagueResolveInput = {
  guildId: string;
  channelId?: string | null;
  categoryId?: string | null;
  leagueIdOption?: string | null;
};

export type LeagueResolveResult =
  | { ok: true; league: League }
  | { ok: false; reason: 'no_leagues' | 'ambiguous' | 'invalid_option' | 'not_in_guild' };

/**
 * Resolve which league a Discord interaction belongs to.
 *
 * Resolution order:
 *  1. Explicit leagueIdOption → load; must match guildId
 *  2. Channel binding (kind CHANNEL) on channelId
 *  3. Category binding (kind CATEGORY) on categoryId
 *  4. Single league for guild → use it
 *  5. Zero leagues → no_leagues; multiple → ambiguous
 */
export async function resolveLeagueContext(
  input: LeagueResolveInput,
): Promise<LeagueResolveResult> {
  // Step 1 — explicit option
  if (input.leagueIdOption) {
    const league = await prisma.league.findUnique({ where: { id: input.leagueIdOption } });
    if (!league) {
      return { ok: false, reason: 'invalid_option' };
    }
    if (league.guildId !== input.guildId) {
      return { ok: false, reason: 'not_in_guild' };
    }
    return { ok: true, league };
  }

  // Step 2 — channel binding
  if (input.channelId) {
    const binding = await prisma.leagueChannelBinding.findUnique({
      where: { discordId: input.channelId },
      include: { league: true },
    });
    if (binding?.kind === 'CHANNEL') {
      return { ok: true, league: binding.league };
    }
  }

  // Step 3 — category binding
  if (input.categoryId) {
    const binding = await prisma.leagueChannelBinding.findUnique({
      where: { discordId: input.categoryId },
      include: { league: true },
    });
    if (binding?.kind === 'CATEGORY') {
      return { ok: true, league: binding.league };
    }
  }

  // Steps 4-5 — guild fallback
  const leagues = await prisma.league.findMany({
    where: { guildId: input.guildId },
    orderBy: { createdAt: 'asc' },
  });

  if (leagues.length === 0) return { ok: false, reason: 'no_leagues' };
  if (leagues.length === 1) return { ok: true, league: leagues[0]! };
  return { ok: false, reason: 'ambiguous' };
}
