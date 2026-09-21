import { ChannelType, EmbedBuilder, type Client } from 'discord.js';
import { env } from '../../config/env.js';
import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { resolveOpsAlertChannelIds } from './channel-resolver.js';
import { AlertCooldown, type AlertType } from './cooldown.js';

const log = createLogger('obs-alerter');

const TITLE: Record<AlertType, string> = {
  boot: 'Bot starting',
  ready: 'Bot ready',
  disconnect: 'Discord disconnected',
  shutdown: 'Bot shutting down',
  crash: 'Uncaught exception',
  unhandled_rejection: 'Unhandled rejection',
  high_rss: 'High memory (RSS)',
  event_loop_lag: 'Event-loop lag',
  db_unhealthy: 'Database unhealthy',
  db_recovered: 'Database recovered',
};

const COLOR: Record<AlertType, number> = {
  boot: 0x5865f2,
  ready: 0x57f287,
  disconnect: 0xfee75c,
  shutdown: 0x99aab5,
  crash: 0xed4245,
  unhandled_rejection: 0xed4245,
  high_rss: 0xfaa61a,
  event_loop_lag: 0xfaa61a,
  db_unhealthy: 0xed4245,
  db_recovered: 0x57f287,
};

let clientRef: Client | undefined;
const cooldown = new AlertCooldown();

/** Bind the Discord client used to post ops embeds. */
export function setOpsAlerterClient(client: Client): void {
  clientRef = client;
}

/**
 * Load env + guild ops channel ids (deduped).
 */
export async function listOpsAlertChannelIds(): Promise<string[]> {
  const rows = await prisma.guildConfig.findMany({
    where: { opsAlertChannelId: { not: null } },
    select: { opsAlertChannelId: true },
  });

  const guildIds = rows
    .map((row) => row.opsAlertChannelId)
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0);

  return resolveOpsAlertChannelIds({
    envChannelId: env.opsAlertChannelId,
    guildChannelIds: guildIds,
  });
}

/**
 * Post an ops alert embed to all configured channels (best-effort).
 * Respects per-type cooldown except for lifecycle/crash.
 */
export async function sendOpsAlert(type: AlertType, details?: string): Promise<void> {
  if (!env.obsEnabled) {
    return;
  }

  if (!cooldown.tryAllow(type)) {
    return;
  }

  const client = clientRef;
  if (!client?.isReady()) {
    log.debug({ type }, 'Skipping ops alert — Discord client not ready');
    return;
  }

  let channelIds: string[];
  try {
    channelIds = await listOpsAlertChannelIds();
  } catch (error) {
    log.warn({ err: error, type }, 'Failed to resolve ops alert channels');
    return;
  }

  if (channelIds.length === 0) {
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(TITLE[type])
    .setColor(COLOR[type])
    .setTimestamp(new Date());

  if (details && details.trim().length > 0) {
    embed.setDescription(details.slice(0, 3500));
  }

  await Promise.all(
    channelIds.map(async (channelId) => {
      try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased() || channel.isDMBased()) {
          log.warn({ channelId, type }, 'Ops alert channel is not a guild text channel');
          return;
        }
        if (
          channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildAnnouncement
        ) {
          log.warn({ channelId, type }, 'Ops alert channel type unsupported');
          return;
        }
        await channel.send({ embeds: [embed] });
      } catch (error) {
        log.warn({ err: error, channelId, type }, 'Failed to post ops alert');
      }
    }),
  );
}
