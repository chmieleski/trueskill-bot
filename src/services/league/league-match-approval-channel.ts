import { prisma } from '../../lib/prisma.js';

/**
 * Set or clear the Discord channel used for WOS HTTP match approval posts.
 * Pass `null` to clear.
 */
export async function setLeagueMatchApprovalChannel(
  leagueId: string,
  channelId: string | null,
): Promise<void> {
  const nextId = channelId?.trim() || null;
  await prisma.league.update({
    where: { id: leagueId },
    data: { matchApprovalChannelId: nextId },
  });
}
