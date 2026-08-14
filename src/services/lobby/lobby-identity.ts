import { prisma } from '../../lib/prisma.js';
import { MatchServiceError } from '../match/match-service.js';

export const UNLINKED_DISCORD_MESSAGE =
  'Your Discord is not linked to an in-game nick. Run /link or ask a moderator.';

/**
 * Resolve the linked in-game nick for a Discord user.
 * Throws when the account has no Player.discordId bind.
 */
export async function nickForDiscordId(discordId: string): Promise<string> {
  const player = await prisma.player.findUnique({ where: { discordId } });

  if (!player) {
    throw new MatchServiceError(UNLINKED_DISCORD_MESSAGE);
  }

  return player.username;
}
