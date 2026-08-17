import { prisma } from '../../lib/prisma.js';
import { MatchServiceError } from '../match/match-service.js';

export const UNLINKED_DISCORD_MESSAGE =
  'Your Discord is not linked to an in-game nick for this league’s game. Run /link or ask a moderator.';

/**
 * Resolve the linked in-game nick for a Discord user in a specific game.
 * Throws when the account has no Player bind for that gameId.
 */
export async function nickForDiscordId(
  discordId: string,
  gameId: string,
): Promise<string> {
  const player = await prisma.player.findUnique({
    where: { gameId_discordId: { gameId, discordId } },
  });

  if (!player) {
    throw new MatchServiceError(UNLINKED_DISCORD_MESSAGE);
  }

  return player.username;
}
