import type { LeagueBindingKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

export type { LeagueBindingKind };

/**
 * Bind a Discord channel or category to a league.
 * Each discordId maps to exactly one league (upsert replaces any previous binding).
 */
export async function bindDiscordToLeague(input: {
  leagueId: string;
  discordId: string;
  kind: LeagueBindingKind;
}): Promise<void> {
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
