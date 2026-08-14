import type { Client } from 'discord.js';
import { Events } from 'discord.js';
import { createLogger } from '../lib/logger.js';
import { startMatchCleanupScheduler } from '../services/match/index.js';
import {
  refreshAllLeaderboardChannels,
  scheduleLeaderboardRefresh,
} from '../services/leaderboard/index.js';

const log = createLogger('ready');

export const name = Events.ClientReady;
export const once = true;

export async function execute(client: Client<true>): Promise<void> {
  log.info({ tag: client.user.tag, userId: client.user.id }, 'Bot online');
  startMatchCleanupScheduler(client);

  void refreshAllLeaderboardChannels(client).catch((error) => {
    log.warn({ err: error }, 'Initial leaderboard refresh failed');
  });
  scheduleLeaderboardRefresh(client);
}
