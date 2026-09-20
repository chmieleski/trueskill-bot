import type { Client } from 'discord.js';
import { createLogger } from '../../lib/logger.js';
import { refreshLeagueLeaderboard } from '../leaderboard/leaderboard-channel.js';
import { syncHeroChampionRoles } from './sync-hero-champion-roles.js';

const log = createLogger('league_rating_side_effects');

/**
 * After ratings change: sync hero champion roles (always attempted) then refresh
 * the live overall board (may no-op when unbound).
 */
export async function notifyLeagueRatingChanged(client: Client, leagueId: string): Promise<void> {
  try {
    await syncHeroChampionRoles(client, leagueId);
  } catch (error) {
    log.warn({ err: error, leagueId }, 'Hero champion role sync failed');
  }
  await refreshLeagueLeaderboard(client, leagueId);
}
