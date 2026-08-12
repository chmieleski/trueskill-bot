import type { Client } from 'discord.js';
import { createLogger } from '../lib/logger.js';
import { buildMatchCancelledEmbed } from './lobby-preview.js';
import { cancelStalePendingMatches } from './match-service.js';

const log = createLogger('match-cleanup');

const INTERVAL_MS = 60 * 60 * 1000;
const STALE_MS = 2 * 60 * 60 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | undefined;
let clientRef: Client | undefined;

async function editCancelledDiscordMessages(
  client: Client,
  matches: Awaited<ReturnType<typeof cancelStalePendingMatches>>,
): Promise<void> {
  for (const match of matches) {
    if (!match.discordMessageId || !match.discordChannelId) {
      continue;
    }

    try {
      const channel = await client.channels.fetch(match.discordChannelId);

      if (!channel || !('messages' in channel)) {
        continue;
      }

      await channel.messages.edit(match.discordMessageId, {
        embeds: [buildMatchCancelledEmbed(match.id)],
        components: [],
      });
    } catch (error) {
      log.warn(
        {
          err: error,
          matchId: match.id,
          channelId: match.discordChannelId,
          messageId: match.discordMessageId,
        },
        'Failed to update Discord message for cancelled match',
      );
    }
  }
}

export async function runMatchCleanupTick(client?: Client): Promise<number> {
  const cancelled = await cancelStalePendingMatches(STALE_MS);

  if (cancelled.length > 0 && client) {
    await editCancelledDiscordMessages(client, cancelled);
  }

  return cancelled.length;
}

export function startMatchCleanupScheduler(client: Client): void {
  if (intervalHandle) {
    log.warn('Match cleanup scheduler already running');
    return;
  }

  clientRef = client;

  const tick = (): void => {
    void runMatchCleanupTick(clientRef).catch((error: unknown) => {
      log.error({ err: error }, 'Match cleanup tick failed');
    });
  };

  // Run once soon after ready so restarts clear backlog without waiting a full hour.
  setTimeout(tick, 5_000);
  intervalHandle = setInterval(tick, INTERVAL_MS);

  log.info({ intervalMs: INTERVAL_MS, staleMs: STALE_MS }, 'Match cleanup scheduler started');
}

export function stopMatchCleanupScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
    log.info('Match cleanup scheduler stopped');
  }

  clientRef = undefined;
}
