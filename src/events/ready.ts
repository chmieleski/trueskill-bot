import type { Client } from 'discord.js';
import { Events } from 'discord.js';
import { startBotApiServer } from '../api/index.js';
import { env } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { resolveLeagueFromApiToken } from '../services/league/league-api-token.js';
import {
  ingestWosReportForApproval,
  postMatchApprovalMessage,
  startMatchCleanupScheduler,
} from '../services/match/index.js';
import { startRatingDecayScheduler } from '../services/rating/index.js';
import {
  refreshAllLeaderboardChannels,
  scheduleLeaderboardRefresh,
} from '../services/leaderboard/index.js';
import { startObservability } from '../services/observability/index.js';
import { syncCurrentReleaseDraft } from '../services/release/index.js';
import { startWc3statsHostPromptScheduler } from '../services/wc3stats/index.js';

const log = createLogger('ready');

export const name = Events.ClientReady;
export const once = true;

export async function execute(client: Client<true>): Promise<void> {
  log.info({ tag: client.user.tag, userId: client.user.id }, 'Bot online');
  startMatchCleanupScheduler(client);
  startRatingDecayScheduler();

  void refreshAllLeaderboardChannels(client).catch((error) => {
    log.warn({ err: error }, 'Initial leaderboard refresh failed');
  });
  scheduleLeaderboardRefresh(client);
  startWc3statsHostPromptScheduler(client);

  if (env.apiEnabled) {
    await startBotApiServer({
      ingest: ingestWosReportForApproval,
      resolveToken: resolveLeagueFromApiToken,
      hostDiscordId: client.user.id,
      postApprovalMessage: async (input) => postMatchApprovalMessage(client, input),
    });
  }

  try {
    await startObservability(client);
  } catch (error) {
    log.warn({ err: error }, 'Failed to start observability');
  }

  if (!env.isDev) {
    void syncCurrentReleaseDraft(client).catch((error) => {
      log.warn({ err: error }, 'Release draft sync failed');
    });
  }
}
