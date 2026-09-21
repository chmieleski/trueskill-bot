import { prisma } from '../../lib/prisma.js';
import { PlayerServiceError } from './player-profile.js';

const NOT_LINKED = 'Link your nick with /link before changing host lobby prompt settings.';

/**
 * Read whether a linked player wants wc3stats host-lobby pings.
 * Returns null when no Player is linked to this Discord id for the game.
 */
export async function getPlayerHostPromptPingsEnabled(
  gameId: string,
  discordId: string,
): Promise<boolean | null> {
  const row = await prisma.player.findUnique({
    where: { gameId_discordId: { gameId, discordId } },
    select: { username: true, wc3statsHostPromptPingsEnabled: true },
  });
  if (!row) {
    return null;
  }
  return row.wc3statsHostPromptPingsEnabled !== false;
}

/**
 * Set whether the linked player receives wc3stats host-lobby prompt pings.
 * Preference is per game (Player row), default true.
 */
export async function setPlayerHostPromptPingsEnabled(
  gameId: string,
  discordId: string,
  enabled: boolean,
): Promise<{ username: string; enabled: boolean }> {
  const player = await prisma.player.findUnique({
    where: { gameId_discordId: { gameId, discordId } },
    select: { id: true, username: true },
  });
  if (!player) {
    throw new PlayerServiceError(NOT_LINKED);
  }

  const updated = await prisma.player.update({
    where: { id: player.id },
    data: { wc3statsHostPromptPingsEnabled: enabled },
    select: { username: true, wc3statsHostPromptPingsEnabled: true },
  });

  return {
    username: updated.username,
    enabled: updated.wc3statsHostPromptPingsEnabled !== false,
  };
}
