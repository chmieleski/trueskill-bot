import { prisma } from '../../lib/prisma.js';
import {
  clearAllLeagueWc3statsSlotMaps,
  parseWc3statsMapSha1,
  replaceLeagueWc3statsSlotMaps,
  UDBR_MAP_PATTERN,
  UDBR_MAP_SHA1,
  UDBR_WC3STATS_SLOT_MAP,
} from '../wc3stats/wc3stats-slot-map.js';
import {
  LIVE_LEADERBOARD_DEFAULT_SIZE,
  assertLiveLeaderboardSize,
} from '../leaderboard/leaderboard.js';
import { assertRankResetCooldownDays } from '../rating/rank-reset.js';

/** All IHL settings stored on the League row. */
export interface ResolvedLeagueConfig {
  wc3statsEnabled: boolean;
  wc3statsMapPattern: string | undefined;
  wc3statsMapSha1: string[];
  leaderboardChannelId: string | undefined;
  leaderboardMessageId: string | undefined;
  leaderboardSize: number;
  lobbyPlayerClaimEnabled: boolean;
  rankResetEnabled: boolean;
  rankResetCooldownDays: number;
}

/**
 * Read all IHL config fields from the League row.
 * Returns safe defaults when the league is not found.
 */
export async function resolveLeagueConfig(leagueId: string): Promise<ResolvedLeagueConfig> {
  const row = await prisma.league.findUnique({ where: { id: leagueId } });
  return {
    wc3statsEnabled: row?.wc3statsEnabled === true,
    wc3statsMapPattern: row?.wc3statsMapPattern?.trim() || undefined,
    wc3statsMapSha1: parseWc3statsMapSha1(row?.wc3statsMapSha1),
    leaderboardChannelId: row?.leaderboardChannelId?.trim() || undefined,
    leaderboardMessageId: row?.leaderboardMessageId?.trim() || undefined,
    leaderboardSize:
      row?.leaderboardSize != null
        ? row.leaderboardSize
        : LIVE_LEADERBOARD_DEFAULT_SIZE,
    lobbyPlayerClaimEnabled: row?.lobbyPlayerClaimEnabled !== false,
    rankResetEnabled: row?.rankResetEnabled === true,
    rankResetCooldownDays:
      row?.rankResetCooldownDays != null ? row.rankResetCooldownDays : 30,
  };
}

/**
 * True when the league has wc3stats import enabled and a map pattern set.
 */
export function isLeagueWc3statsImportReady(
  config: Pick<ResolvedLeagueConfig, 'wc3statsEnabled' | 'wc3statsMapPattern'>,
): boolean {
  return config.wc3statsEnabled && Boolean(config.wc3statsMapPattern);
}

/**
 * Apply the built-in UDBR wc3stats preset to a league:
 * enables import, sets map filter, loads the UDBR slot layout.
 */
export async function applyUdbrWc3statsPreset(leagueId: string): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: {
      wc3statsEnabled: true,
      wc3statsMapPattern: UDBR_MAP_PATTERN,
      wc3statsMapSha1: UDBR_MAP_SHA1,
    },
  });
  await replaceLeagueWc3statsSlotMaps(leagueId, [...UDBR_WC3STATS_SLOT_MAP]);
}

/**
 * Clear the wc3stats package for a league:
 * disables import, clears map filter and all slot mappings.
 */
export async function clearLeagueWc3statsPackage(leagueId: string): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: {
      wc3statsEnabled: false,
      wc3statsMapPattern: null,
      wc3statsMapSha1: null,
    },
  });
  await clearAllLeagueWc3statsSlotMaps(leagueId);
}

/**
 * Store the live leaderboard channel + message ids on the league.
 */
export async function setLeagueLeaderboardChannel(
  leagueId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { leaderboardChannelId: channelId, leaderboardMessageId: messageId },
  });
}

/**
 * Remove the live leaderboard binding from the league.
 */
export async function clearLeagueLeaderboardChannel(leagueId: string): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { leaderboardChannelId: null, leaderboardMessageId: null },
  });
}

/**
 * Store the live leaderboard row count on the league.
 */
export async function setLeagueLeaderboardSize(
  leagueId: string,
  size: number,
): Promise<void> {
  const safe = assertLiveLeaderboardSize(size);
  await prisma.league.update({
    where: { id: leagueId },
    data: { leaderboardSize: safe },
  });
}

/**
 * Reset the live leaderboard row count to the default (10).
 */
export async function clearLeagueLeaderboardSize(leagueId: string): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { leaderboardSize: LIVE_LEADERBOARD_DEFAULT_SIZE },
  });
}

/**
 * Enable or disable the player slot-claim feature for a league.
 */
export async function setLeagueLobbyPlayerClaimEnabled(
  leagueId: string,
  enabled: boolean,
): Promise<void> {
  await prisma.league.update({
    where: { id: leagueId },
    data: { lobbyPlayerClaimEnabled: enabled },
  });
}

/**
 * Enable or disable rank reset for a league; optionally set cooldown days in the same update.
 */
export async function setLeagueRankResetEnabled(
  leagueId: string,
  enabled: boolean,
  cooldownDays?: number,
): Promise<void> {
  const data: { rankResetEnabled: boolean; rankResetCooldownDays?: number } = {
    rankResetEnabled: enabled,
  };
  if (cooldownDays !== undefined) {
    data.rankResetCooldownDays = assertRankResetCooldownDays(cooldownDays);
  }
  await prisma.league.update({ where: { id: leagueId }, data });
}

/**
 * Store the rank-reset cooldown (days) on the league.
 */
export async function setLeagueRankResetCooldownDays(
  leagueId: string,
  days: number,
): Promise<void> {
  const safe = assertRankResetCooldownDays(days);
  await prisma.league.update({
    where: { id: leagueId },
    data: { rankResetCooldownDays: safe },
  });
}
