import type { EventBindingKind } from '@dbz/db';
import { prisma } from '../../lib/prisma.js';
import { MatchServiceError } from '../match/match-service.js';

export type { EventBindingKind };

export const EVENT_BIND_LEAGUE_CONFLICT =
  'That channel or category is already bound to a league. Unbind it from the league first.';

export const LEAGUE_BIND_EVENT_CONFLICT =
  'That channel or category is already bound to an event. Unbind it from the event first.';

/**
 * Bind a Discord channel or category to an event.
 * Rejects when the snowflake is already league-bound.
 */
export async function bindDiscordToEvent(input: {
  eventId: string;
  discordId: string;
  kind: EventBindingKind;
}): Promise<void> {
  const leagueBound = await prisma.leagueChannelBinding.findUnique({
    where: { discordId: input.discordId },
    select: { discordId: true },
  });
  if (leagueBound) {
    throw new MatchServiceError(EVENT_BIND_LEAGUE_CONFLICT);
  }

  await prisma.eventChannelBinding.upsert({
    where: { discordId: input.discordId },
    create: {
      eventId: input.eventId,
      discordId: input.discordId,
      kind: input.kind,
    },
    update: {
      eventId: input.eventId,
      kind: input.kind,
    },
  });
}

/**
 * Remove an event binding. Returns true if a row was deleted.
 */
export async function unbindEventDiscord(discordId: string): Promise<boolean> {
  try {
    await prisma.eventChannelBinding.delete({ where: { discordId } });
    return true;
  } catch {
    return false;
  }
}
