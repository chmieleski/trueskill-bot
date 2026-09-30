import { prisma } from '../../lib/prisma.js';
import { displayOrdinal, isCalibrating, KI_Z_BLEND_GAMES } from '../rating/rating-math.js';
import { gamesByPlayerFromStats, loadMatchDisplayStats } from '../rating/rank-reset-display.js';
import type { HeroChampionCandidate } from './pick-hero-champion.js';

/** Minimum hero `matchesPlayed` required to hold a champion Discord role. */
export const HERO_CHAMPION_MIN_HERO_MATCHES = KI_Z_BLEND_GAMES;

/**
 * Load Discord-linked, non-calibrating players with enough hero games, ranked by hero ki.
 * Requires {@link HERO_CHAMPION_MIN_HERO_MATCHES} matches on that hero (same threshold as overall calibration).
 */
export async function loadEligibleHeroCandidates(
  leagueId: string,
  heroId: number,
): Promise<HeroChampionCandidate[]> {
  const [rows, displayStats] = await Promise.all([
    prisma.playerHeroRating.findMany({
      where: { leagueId, heroId, matchesPlayed: { gte: HERO_CHAMPION_MIN_HERO_MATCHES } },
      include: {
        player: { select: { username: true, discordId: true } },
      },
    }),
    loadMatchDisplayStats(leagueId),
  ]);

  const leagueGamesByPlayer = gamesByPlayerFromStats(displayStats.byPlayer);

  return rows
    .filter((row) => {
      if (row.matchesPlayed < HERO_CHAMPION_MIN_HERO_MATCHES) {
        return false;
      }
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
