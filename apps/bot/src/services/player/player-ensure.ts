import { Prisma } from '@dbz/db';
import { prisma } from '../../lib/prisma.js';
import { linkPlayer } from './player-link.js';
import { normalizeNick } from './player-nick.js';
import { findPlayerForRankLookup, PlayerServiceError, type RankLookup } from './player-profile.js';

export type ModPlayerLookup = Exclude<RankLookup, { kind: 'both' | 'self' }>;

export type EnsurePlayerForModLookupResult = {
  id: string;
  username: string;
  created: boolean;
};

/**
 * Resolve a player for mod-only commands (`/match sanction`, `/player_new`).
 * Creates a `Player` row when the nick has never been seen (e.g. RMK before `/register_lobby`).
 * Discord `user` lookups fall back to linking via the Discord display name when unlinked.
 */
export async function ensurePlayerForModLookup(
  gameId: string,
  lookup: ModPlayerLookup,
  options: { discordUsername?: string | null } = {},
): Promise<EnsurePlayerForModLookupResult> {
  const existing = await findPlayerForRankLookup(gameId, lookup);
  if (existing) {
    return { id: existing.id, username: existing.username, created: false };
  }

  if (lookup.kind === 'nick') {
    return createPlayerByNick(gameId, lookup.nick);
  }

  const discordUsername = options.discordUsername?.trim();
  if (!discordUsername) {
    throw new PlayerServiceError('Player not found.');
  }

  await linkPlayer({
    gameId,
    nick: discordUsername,
    discordId: lookup.discordId,
  });

  const linked = await prisma.player.findUnique({
    where: { gameId_discordId: { gameId, discordId: lookup.discordId } },
    select: { id: true, username: true },
  });
  if (!linked) {
    throw new PlayerServiceError('Player not found.');
  }

  return { id: linked.id, username: linked.username, created: true };
}

async function createPlayerByNick(
  gameId: string,
  nick: string,
): Promise<EnsurePlayerForModLookupResult> {
  const username = normalizeNick(nick);
  if (!username) {
    throw new PlayerServiceError('Nick cannot be empty.');
  }

  try {
    const created = await prisma.player.create({
      data: { gameId, username },
      select: { id: true, username: true },
    });
    return { id: created.id, username: created.username, created: true };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await findPlayerForRankLookup(gameId, { kind: 'nick', nick: username });
      if (existing) {
        return { id: existing.id, username: existing.username, created: false };
      }
    }
    throw error;
  }
}
