import { getGameProfile, type GameProfile } from '../../domain/game-profile.js';
import { prisma } from '../../lib/prisma.js';

export class LeagueNotFoundError extends Error {
  constructor() {
    super('League not found.');
    this.name = 'LeagueNotFoundError';
  }
}

/** Load the code game profile for a league row. */
export async function getGameProfileForLeague(leagueId: string): Promise<GameProfile> {
  const league = await prisma.league.findUnique({
    where: { id: leagueId },
    select: { gameId: true },
  });
  if (!league) {
    throw new LeagueNotFoundError();
  }
  return getGameProfile(league.gameId);
}
