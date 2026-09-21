import { prisma } from '../../lib/prisma.js';
import { normalizeNick } from './player-nick.js';
import { PlayerServiceError } from './player-profile.js';

export type LinkPlayerRow = {
  id: string;
  username: string;
  discordId: string | null;
};

const ALREADY_LINKED = 'That nick or Discord account is already linked. Ask a moderator to relink.';

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

async function findPlayerByNick(gameId: string, nick: string): Promise<LinkPlayerRow | null> {
  const exact = await prisma.player.findUnique({
    where: { gameId_username: { gameId, username: normalizeNick(nick) } },
  });
  if (exact) {
    return exact;
  }

  const matches = await prisma.player.findMany({
    where: {
      gameId,
      username: { equals: normalizeNick(nick), mode: 'insensitive' },
    },
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
  gameId: string;
  nick: string;
  discordId: string;
  allowRelink?: boolean;
}): Promise<{ username: string; discordId: string; gameId: string }> {
  const nick = normalizeNick(input.nick);
  if (!nick) {
    throw new PlayerServiceError('Nick cannot be empty.');
  }

  const [player, existingByDiscord] = await Promise.all([
    findPlayerByNick(input.gameId, nick),
    prisma.player.findUnique({
      where: {
        gameId_discordId: { gameId: input.gameId, discordId: input.discordId },
      },
    }),
  ]);

  assertLinkAllowed({
    player,
    existingByDiscord,
    discordId: input.discordId,
    allowRelink: input.allowRelink,
  });

  if (player?.discordId === input.discordId) {
    return {
      username: player.username,
      discordId: input.discordId,
      gameId: input.gameId,
    };
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
        data: {
          gameId: input.gameId,
          username: nick,
          discordId: input.discordId,
        },
      });
      return {
        username: created.username,
        discordId: created.discordId!,
        gameId: created.gameId,
      };
    }

    const updated = await tx.player.update({
      where: { id: player.id },
      data: { discordId: input.discordId },
    });

    return {
      username: updated.username,
      discordId: updated.discordId!,
      gameId: updated.gameId,
    };
  });
}

/** Clears the Discord link for the given account. */
export async function unlinkByDiscordId(
  gameId: string,
  discordId: string,
  options: { self?: boolean } = {},
): Promise<{ username: string }> {
  const self = options.self ?? false;
  const player = await prisma.player.findUnique({
    where: { gameId_discordId: { gameId, discordId } },
  });

  if (!player) {
    throw new PlayerServiceError(
      self
        ? 'Your Discord is not linked for this game.'
        : 'That Discord account is not linked for this game.',
    );
  }

  await prisma.player.update({
    where: { id: player.id },
    data: { discordId: null },
  });

  return { username: player.username };
}
