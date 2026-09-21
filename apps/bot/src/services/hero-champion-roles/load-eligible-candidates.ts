import { prisma } from '../../lib/prisma.js';
import { displayOrdinal, isCalibrating } from '../rating/rating-math.js';
import { gamesByPlayerFromStats, loadMatchDisplayStats } from '../rating/rank-reset-display.js';
import type { HeroChampionCandidate } from './pick-hero-champion.js';

/**
 * Load Discord-linked, non-calibrating players with hero games, ranked by hero ki.
 */
export async function loadEligibleHeroCandidates(
  leagueId: string,
  heroId: number,
): Promise<HeroChampionCandidate[]> {
  const [rows, displayStats] = await Promise.all([
    prisma.playerHeroRating.findMany({
      where: { leagueId, heroId, matchesPlayed: { gt: 0 } },
      include: {
        player: { select: { username: true, discordId: true } },
      },
    }),
    loadMatchDisplayStats(leagueId),
  ]);

  const leagueGamesByPlayer = gamesByPlayerFromStats(displayStats.byPlayer);

  return rows
    .filter((row) => {
      const discordId = row.player.discordId?.trim();
      if (!discordId) {
        return false;
      }
      const leagueGames = leagueGamesByPlayer.get(row.playerId) ?? 0;
      return !isCalibrating(leagueGames);
    })
    .map((row) => ({
      discordId: row.player.discordId!.trim(),
      ki: displayOrdinal(row.mu, row.sigma, row.matchesPlayed),
      username: row.player.username,
    }));
}
