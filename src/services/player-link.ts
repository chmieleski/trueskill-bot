import { prisma } from '../lib/prisma.js';
import { PlayerServiceError } from './player-profile.js';

export type LinkPlayerRow = {
  id: string;
  username: string;
  discordId: string | null;
};

/** Validates nick and Discord are free to link; returns the player row on success. */
export function assertLinkAllowed(input: {
  player: LinkPlayerRow | null;
  existingByDiscord: LinkPlayerRow | null;
}): LinkPlayerRow {
  if (!input.player) {
    throw new PlayerServiceError('No player with that nick.');
  }

  if (input.player.discordId) {
    throw new PlayerServiceError('That nick or Discord account is already linked.');
  }

  if (input.existingByDiscord && input.existingByDiscord.id !== input.player.id) {
    throw new PlayerServiceError('That nick or Discord account is already linked.');
  }

  return input.player;
}

async function findPlayerByNick(nick: string): Promise<LinkPlayerRow | null> {
  const exact = await prisma.player.findUnique({ where: { username: nick } });
  if (exact) {
    return exact;
  }

  const matches = await prisma.player.findMany({
    where: { username: { equals: nick, mode: 'insensitive' } },
    take: 2,
  });

  return matches.length === 1 ? matches[0]! : null;
}

/** Binds an in-game nick to a Discord account. */
export async function linkPlayer(input: {
  nick: string;
  discordId: string;
}): Promise<{ username: string; discordId: string }> {
  const nick = input.nick.trim();
  if (!nick) {
    throw new PlayerServiceError('No player with that nick.');
  }

  const [player, existingByDiscord] = await Promise.all([
    findPlayerByNick(nick),
    prisma.player.findUnique({ where: { discordId: input.discordId } }),
  ]);

  const allowed = assertLinkAllowed({ player, existingByDiscord });

  const updated = await prisma.player.update({
    where: { id: allowed.id },
    data: { discordId: input.discordId },
  });

  return { username: updated.username, discordId: updated.discordId! };
}

/** Clears the Discord link for the given account. */
export async function unlinkByDiscordId(
  discordId: string,
  options: { self?: boolean } = {},
): Promise<{ username: string }> {
  const self = options.self ?? false;
  const player = await prisma.player.findUnique({ where: { discordId } });

  if (!player) {
    throw new PlayerServiceError(
      self
        ? 'Your Discord is not linked.'
        : 'That Discord account is not linked.',
    );
  }

  await prisma.player.update({
    where: { id: player.id },
    data: { discordId: null },
  });

  return { username: player.username };
}
