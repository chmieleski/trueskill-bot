import { prisma } from '../../lib/prisma.js';
import { PlayerServiceError } from './player-profile.js';

const NOT_LINKED =
  'Link your nick with /link before changing host lobby prompt settings.';

/**
 * Read whether a linked player wants wc3stats host-lobby pings.
 * Returns null when no Player is linked to this Discord id.
 */
export async function getPlayerHostPromptPingsEnabled(
  discordId: string,
): Promise<boolean | null> {
  const row = await prisma.player.findUnique({
    where: { discordId },
    select: { username: true, wc3statsHostPromptPingsEnabled: true },
  });
  if (!row) {
    return null;
  }
  return row.wc3statsHostPromptPingsEnabled !== false;
}

/**
 * Set whether the linked player receives wc3stats host-lobby prompt pings.
 * Preference is global (Player row), default true.
 */
export async function setPlayerHostPromptPingsEnabled(
  discordId: string,
  enabled: boolean,
): Promise<{ username: string; enabled: boolean }> {
  const player = await prisma.player.findUnique({
    where: { discordId },
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
