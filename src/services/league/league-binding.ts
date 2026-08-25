import type { LeagueBindingKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { LEAGUE_BIND_EVENT_CONFLICT } from '../event/event-binding.js';
import { MatchServiceError } from '../match/match-service.js';

export type { LeagueBindingKind };

/**
 * Bind a Discord channel or category to a league.
 * Each discordId maps to exactly one league (upsert replaces any previous binding).
 * Rejects when the snowflake is already event-bound.
 */
export async function bindDiscordToLeague(input: {
  leagueId: string;
  discordId: string;
  kind: LeagueBindingKind;
}): Promise<void> {
  const eventBound = await prisma.eventChannelBinding.findUnique({
    where: { discordId: input.discordId },
    select: { discordId: true },
  });
  if (eventBound) {
    throw new MatchServiceError(LEAGUE_BIND_EVENT_CONFLICT);
  }

  await prisma.leagueChannelBinding.upsert({
    where: { discordId: input.discordId },
    create: {
      leagueId: input.leagueId,
      discordId: input.discordId,
      kind: input.kind,
    },
    update: {
      leagueId: input.leagueId,
      kind: input.kind,
    },
  });
}

/**
 * Remove the binding for a Discord channel or category.
 * Returns true if a row was deleted, false if nothing was bound.
 */
export async function unbindDiscord(discordId: string): Promise<boolean> {
  try {
    await prisma.leagueChannelBinding.delete({ where: { discordId } });
    return true;
  } catch {
    // Prisma throws P2025 when the record is not found
    return false;
  }
}
