import type { Client } from 'discord.js';
import { refreshLeagueLeaderboard } from '../leaderboard/leaderboard-channel.js';
import { markLeagueHeroChampionRolesDirty } from './mark-dirty.js';

/**
 * After ratings change: mark hero champion roles dirty for scheduled sync,
 * then refresh the live overall board (may no-op when unbound).
 */
export async function notifyLeagueRatingChanged(client: Client, leagueId: string): Promise<void> {
  await markLeagueHeroChampionRolesDirty(leagueId);
  await refreshLeagueLeaderboard(client, leagueId);
}
