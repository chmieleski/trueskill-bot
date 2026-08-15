import type { Client, TextChannel } from 'discord.js';
import { prisma } from '../../lib/prisma.js';
import { createLogger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { findActiveMatchByWc3statsGameId } from '../match/match-service.js';
import { isLeagueWc3statsHostPromptReady } from '../league/league-wc3stats.js';
import { fetchGamelist, Wc3statsClientError } from './wc3stats-client.js';
import { compileWc3statsMapConfig } from './wc3stats-map.js';
import { parseWc3statsMapSha1 } from './wc3stats-slot-map.js';
import { normalizeNick } from '../player/player-nick.js';
import {
  buildHostPromptButtons,
  buildHostPromptMessageContent,
  filterGamelistForHostPrompt,
  hostPromptDedupeKey,
} from './wc3stats-host-prompt.js';

const log = createLogger('wc3stats-host-prompt-poller');

const INTERVAL_MS = 45_000;
const MAX_PROMPTS_PER_TICK = 5;

let intervalHandle: ReturnType<typeof setInterval> | undefined;
let clientRef: Client | undefined;

/** leagueId:wc3statsId keys already prompted in this process. */
const promptedKeys = new Set<string>();

function isSendableTextChannel(channel: unknown): channel is TextChannel {
  return Boolean(
    channel &&
      typeof channel === 'object' &&
      'isTextBased' in channel &&
      typeof (channel as { isTextBased: () => boolean }).isTextBased === 'function' &&
      (channel as { isTextBased: () => boolean }).isTextBased() &&
      'send' in channel &&
      typeof (channel as { send: unknown }).send === 'function',
  );
}

/**
 * Load linked Players (discordId set) keyed by normalized username.
 */
export async function loadLinkedPlayersByNick(): Promise<Map<string, string>> {
  const rows = await prisma.player.findMany({
    where: { discordId: { not: null } },
    select: { username: true, discordId: true },
  });

  const map = new Map<string, string>();
  for (const row of rows) {
    if (!row.discordId) {
      continue;
    }
    map.set(normalizeNick(row.username), row.discordId);
  }
  return map;
}

type PromptReadyLeague = {
  id: string;
  guildId: string;
  channelId: string;
  mapPattern: string;
  mapSha1: string[];
};

/**
 * Leagues that may receive host-lobby prompts this tick.
 */
export async function listHostPromptReadyLeagues(): Promise<PromptReadyLeague[]> {
  const rows = await prisma.league.findMany({
    where: {
      wc3statsHostPromptEnabled: true,
      wc3statsHostPromptChannelId: { not: null },
      wc3statsEnabled: true,
      wc3statsMapPattern: { not: null },
    },
    select: {
      id: true,
      guildId: true,
      wc3statsHostPromptChannelId: true,
      wc3statsMapPattern: true,
      wc3statsMapSha1: true,
      wc3statsEnabled: true,
      wc3statsHostPromptEnabled: true,
    },
  });

  const ready: PromptReadyLeague[] = [];
  for (const row of rows) {
    const config = {
      wc3statsEnabled: row.wc3statsEnabled,
      wc3statsMapPattern: row.wc3statsMapPattern?.trim() || undefined,
      wc3statsHostPromptEnabled: row.wc3statsHostPromptEnabled,
      wc3statsHostPromptChannelId: row.wc3statsHostPromptChannelId?.trim() || undefined,
    };
    if (!isLeagueWc3statsHostPromptReady(config) || !config.wc3statsMapPattern || !config.wc3statsHostPromptChannelId) {
      continue;
    }

    ready.push({
      id: row.id,
      guildId: row.guildId,
      channelId: config.wc3statsHostPromptChannelId,
      mapPattern: config.wc3statsMapPattern,
      mapSha1: parseWc3statsMapSha1(row.wc3statsMapSha1),
    });
  }

  return ready;
}

/**
 * One poller tick: fetch gamelist once, prompt matching linked hosts (capped).
 */
export async function runWc3statsHostPromptTick(client: Client): Promise<number> {
  const leagues = await listHostPromptReadyLeagues();
  if (leagues.length === 0) {
    return 0;
  }

  let games;
  try {
    games = await fetchGamelist(env.wc3statsTimeoutMs);
  } catch (error) {
    if (error instanceof Wc3statsClientError) {
      log.warn({ err: error }, 'wc3stats gamelist fetch failed');
      return 0;
    }
    throw error;
  }

  const linkedByNick = await loadLinkedPlayersByNick();
  if (linkedByNick.size === 0) {
    return 0;
  }

  let posted = 0;

  for (const league of leagues) {
    if (posted >= MAX_PROMPTS_PER_TICK) {
      break;
    }

    let mapConfig;
    try {
      mapConfig = compileWc3statsMapConfig(league.mapPattern, league.mapSha1);
    } catch (error) {
      log.warn({ err: error, leagueId: league.id }, 'Invalid wc3stats map pattern; skipping league');
      continue;
    }

    const matches = filterGamelistForHostPrompt({
      games,
      mapConfig,
      linkedByNick,
    });

    for (const match of matches) {
      if (posted >= MAX_PROMPTS_PER_TICK) {
        break;
      }

      const dedupeKey = hostPromptDedupeKey(league.id, match.wc3statsId);
      if (promptedKeys.has(dedupeKey)) {
        continue;
      }

      const existing = await findActiveMatchByWc3statsGameId(
        league.id,
        String(match.wc3statsId),
      );
      if (existing) {
        promptedKeys.add(dedupeKey);
        continue;
      }

      try {
        const channel = await client.channels.fetch(league.channelId);
        if (!isSendableTextChannel(channel)) {
          log.warn(
            { leagueId: league.id, channelId: league.channelId },
            'Host prompt channel is not a text channel',
          );
          continue;
        }

        await channel.send({
          content: buildHostPromptMessageContent({
            hostDiscordId: match.hostDiscordId,
            lobbyName: match.lobbyName,
            wc3statsId: match.wc3statsId,
          }),
          components: buildHostPromptButtons({
            leagueId: league.id,
            wc3statsId: match.wc3statsId,
            hostDiscordId: match.hostDiscordId,
          }),
          allowedMentions: { users: [match.hostDiscordId] },
        });

        promptedKeys.add(dedupeKey);
        posted += 1;
        log.info(
          {
            leagueId: league.id,
            wc3statsId: match.wc3statsId,
            hostDiscordId: match.hostDiscordId,
          },
          'Posted wc3stats host lobby prompt',
        );
      } catch (error) {
        log.warn(
          {
            err: error,
            leagueId: league.id,
            wc3statsId: match.wc3statsId,
            channelId: league.channelId,
          },
          'Failed to post wc3stats host lobby prompt',
        );
      }
    }
  }

  return posted;
}

/**
 * Remember a prompt key so the poller does not re-post after Open/Dismiss.
 */
export function rememberHostPromptKey(leagueId: string, wc3statsId: number): void {
  promptedKeys.add(hostPromptDedupeKey(leagueId, wc3statsId));
}

/** Test helper: clear in-memory dedupe state. */
export function clearHostPromptDedupeForTests(): void {
  promptedKeys.clear();
}

export function startWc3statsHostPromptScheduler(client: Client): void {
  if (intervalHandle) {
    log.warn('wc3stats host prompt scheduler already running');
    return;
  }

  clientRef = client;

  const tick = (): void => {
    void runWc3statsHostPromptTick(clientRef!).catch((error: unknown) => {
      log.error({ err: error }, 'wc3stats host prompt tick failed');
    });
  };

  setTimeout(tick, 10_000);
  intervalHandle = setInterval(tick, INTERVAL_MS);
  log.info({ intervalMs: INTERVAL_MS, maxPerTick: MAX_PROMPTS_PER_TICK }, 'wc3stats host prompt scheduler started');
}

export function stopWc3statsHostPromptScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = undefined;
    log.info('wc3stats host prompt scheduler stopped');
  }
  clientRef = undefined;
}
