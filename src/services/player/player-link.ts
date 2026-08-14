import { prisma } from '../../lib/prisma.js';
import { normalizeNick } from './player-nick.js';
import { PlayerServiceError } from './player-profile.js';

export type LinkPlayerRow = {
  id: string;
  username: string;
  discordId: string | null;
};

const ALREADY_LINKED =
  'That nick or Discord account is already linked. Ask a moderator to relink.';

/**
 * Validates a Discord↔nick bind.
 * First-time binds are allowed for anyone. Relinking an already-linked nick or
 * Discord account requires `allowRelink` (mod-only — no approval queue yet).
 */
export function assertLinkAllowed(input: {
  player: LinkPlayerRow | null;
  existingByDiscord: LinkPlayerRow | null;
  discordId: string;
  allowRelink?: boolean;
}): void {
  const allowRelink = input.allowRelink ?? false;

  if (!input.player) {
    if (input.existingByDiscord && !allowRelink) {
      throw new PlayerServiceError(ALREADY_LINKED);
    }
    return;
  }

  if (input.player.discordId === input.discordId) {
    return;
  }

  const nickTaken = input.player.discordId != null;
  const discordTaken =
    input.existingByDiscord != null && input.existingByDiscord.id !== input.player.id;

  if ((nickTaken || discordTaken) && !allowRelink) {
    throw new PlayerServiceError(ALREADY_LINKED);
  }
}

async function findPlayerByNick(nick: string): Promise<LinkPlayerRow | null> {
  const exact = await prisma.player.findUnique({
    where: { username: normalizeNick(nick) },
  });
  if (exact) {
    return exact;
  }

  const matches = await prisma.player.findMany({
    where: { username: { equals: normalizeNick(nick), mode: 'insensitive' } },
    take: 2,
  });

  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Binds an in-game nick to a Discord account.
 * Creates the Player row when the nick has never been seen (no rating until they play).
 * Pass `allowRelink` to move an existing link (moderator override).
 */
export async function linkPlayer(input: {
  nick: string;
  discordId: string;
  allowRelink?: boolean;
}): Promise<{ username: string; discordId: string }> {
  const nick = normalizeNick(input.nick);
  if (!nick) {
    throw new PlayerServiceError('Nick cannot be empty.');
  }

  const [player, existingByDiscord] = await Promise.all([
    findPlayerByNick(nick),
    prisma.player.findUnique({ where: { discordId: input.discordId } }),
  ]);

  assertLinkAllowed({
    player,
    existingByDiscord,
    discordId: input.discordId,
    allowRelink: input.allowRelink,
  });

  if (player?.discordId === input.discordId) {
    return { username: player.username, discordId: input.discordId };
  }

  return prisma.$transaction(async (tx) => {
    if (existingByDiscord && existingByDiscord.id !== player?.id) {
      await tx.player.update({
        where: { id: existingByDiscord.id },
        data: { discordId: null },
      });
    }

    if (!player) {
      const created = await tx.player.create({
        data: { username: nick, discordId: input.discordId },
      });

      return { username: created.username, discordId: created.discordId! };
    }

    const updated = await tx.player.update({
      where: { id: player.id },
      data: { discordId: input.discordId },
    });

    return { username: updated.username, discordId: updated.discordId! };
  });
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
