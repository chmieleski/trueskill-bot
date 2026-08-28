import type { MatchPlayerStats } from '@prisma/client';
import { EmbedBuilder } from 'discord.js';
import type { GameProfile } from '../../domain/game-profile.js';
import {
  inferSuggestedWinner,
  parseWos2BotReport,
  winningTeamFromWos2Rounds,
  Wos2BotReportParseError,
  type SuggestedWinner,
  type Wos2BotReport,
  type Wos2BotReportPlayer,
} from '../../games/warcraft3_wos/index.js';
import { teamDisplayName } from '../guild/team-names.js';
import {
  getGameProfileForMatch,
  getMatchById,
  MatchServiceError,
  type MatchWithPlayers,
} from './match-service.js';
import { assertCanManageMatch } from './match-auth.js';
import { normalizeNick } from '../player/player-nick.js';
import { upsertGameItems } from '../game/game-item-catalog.js';
import { formatMonospaceTable, truncateDiscordFieldValue } from '../../lib/discord-embed-table.js';
import { prisma } from '../../lib/prisma.js';
import { clearMatchStatsReport } from './match-stats-store.js';

export type MatchPlayerStatsLine = MatchPlayerStats & {
  username: string;
};

export type UploadMatchStatsResult = {
  matchId: string;
  externalId: string;
  summaryLines: string[];
  warnings: string[];
};

export class MatchStatsUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatchStatsUploadError';
  }
}

export const WOS_MATCH_REPORT_REQUIRED_MESSAGE =
  'Upload the WOS bot match report with `/match upload_report` before completing this match.';

function mapParseError(error: unknown): never {
  if (error instanceof Wos2BotReportParseError) {
    throw new MatchServiceError(error.message);
  }
  throw error;
}

function buildPlayerStatsCreateInput(reportPlayer: Wos2BotReportPlayer, playerId: string) {
  return {
    playerId,
    reportIndex: reportPlayer.index,
    reportPid: reportPlayer.pid,
    reportWin: reportPlayer.win,
    kills: reportPlayer.kills,
    deaths: reportPlayer.deaths,
    damagePhys: reportPlayer.damagePhys,
    damageMagic: reportPlayer.damageMagic,
    damageTotal: reportPlayer.damageTotal,
    heal: reportPlayer.heal,
    takenPhys: reportPlayer.takenPhys,
    takenMagic: reportPlayer.takenMagic,
    takenTotal: reportPlayer.takenTotal,
    heroObjectId: reportPlayer.heroObjectId,
    heroName: reportPlayer.heroName,
    itemSlot1: reportPlayer.itemSlots[0],
    itemSlot2: reportPlayer.itemSlots[1],
    itemSlot3: reportPlayer.itemSlots[2],
    itemSlot4: reportPlayer.itemSlots[3],
    itemSlot5: reportPlayer.itemSlots[4],
    itemSlot6: reportPlayer.itemSlots[5],
  };
}

/** Public nick for stats lines — never show Battle.net `#1234` suffixes. */
function displayPlayerNick(name: string): string {
  return normalizeNick(name);
}

function formatKdaLine(
  username: string,
  kills: number,
  deaths: number,
  heroName: string | null,
): string {
  const heroSuffix = heroName ? ` · ${heroName}` : '';
  return `${displayPlayerNick(username)}: ${kills}/${deaths}${heroSuffix}`;
}

export function formatMatchStatsSummaryLines(stats: MatchPlayerStatsLine[]): string[] {
  return [...stats]
    .sort((left, right) => left.reportIndex - right.reportIndex)
    .map((row) => formatKdaLine(row.username, row.kills, row.deaths, row.heroName));
}

/** Load persisted match stats with usernames for display. */
export async function loadMatchPlayerStatsLines(matchId: string): Promise<MatchPlayerStatsLine[]> {
  const rows = await prisma.matchPlayerStats.findMany({
    where: { matchId },
    include: { player: { select: { username: true } } },
    orderBy: { reportIndex: 'asc' },
  });

  return rows.map((row) => ({
    ...row,
    username: row.player.username,
  }));
}

export async function hasMatchStatsReport(matchId: string): Promise<boolean> {
  const report = await prisma.matchStatsReport.findUnique({
    where: { matchId },
    select: { id: true },
  });
  return report !== null;
}

/** Throws when a WOS league/event match has no persisted bot report yet. */
export async function assertWosMatchStatsReportPresent(matchId: string): Promise<void> {
  if (!(await hasMatchStatsReport(matchId))) {
    throw new MatchServiceError(WOS_MATCH_REPORT_REQUIRED_MESSAGE);
  }
}

function matchReportPlayersToRoster(
  matchPlayers: Array<{ playerId: string; player: { username: string } }>,
  report: Wos2BotReport,
): {
  matched: Array<{ playerId: string; reportPlayer: Wos2BotReportPlayer }>;
  warnings: string[];
} {
  const rosterByNick = new Map(
    matchPlayers.map((entry) => [normalizeNick(entry.player.username), entry]),
  );
  const matched: Array<{ playerId: string; reportPlayer: Wos2BotReportPlayer }> = [];
  const unmatchedReportNames: string[] = [];

  for (const reportPlayer of report.players) {
    const rosterEntry = rosterByNick.get(normalizeNick(reportPlayer.name));
    if (!rosterEntry) {
      unmatchedReportNames.push(reportPlayer.name);
      continue;
    }
    matched.push({ playerId: rosterEntry.playerId, reportPlayer });
  }

  if (unmatchedReportNames.length > 0) {
    throw new MatchServiceError(
      `Could not match these report players to the lobby roster: ${unmatchedReportNames.join(', ')}`,
    );
  }

  const matchedPlayerIds = new Set(matched.map((entry) => entry.playerId));
  const warnings: string[] = [];
  const missingFromReport = matchPlayers
    .filter((entry) => !matchedPlayerIds.has(entry.playerId))
    .map((entry) => entry.player.username);

  if (missingFromReport.length > 0) {
    warnings.push(
      `Roster players not in the report (allowed for partial lobbies): ${missingFromReport.join(', ')}`,
    );
  }

  return { matched, warnings };
}

function buildSummaryLines(
  matched: Array<{ playerId: string; reportPlayer: Wos2BotReportPlayer }>,
): string[] {
  return matched
    .sort((left, right) => left.reportPlayer.index - right.reportPlayer.index)
    .map(({ reportPlayer }) =>
      formatKdaLine(
        reportPlayer.name,
        reportPlayer.kills,
        reportPlayer.deaths,
        reportPlayer.heroName,
      ),
    );
}

/** Persist WOS2 stats for a match that already has a matching roster (PENDING or IN_PROGRESS). */
export async function persistWos2MatchStats(input: {
  matchId: string;
  actorDiscordId: string;
  rawText: string;
  report: Wos2BotReport;
  matchPlayers: Array<{ playerId: string; player: { username: string } }>;
}): Promise<{ externalId: string; summaryLines: string[]; warnings: string[] }> {
  const { matched, warnings } = matchReportPlayersToRoster(input.matchPlayers, input.report);

  await prisma.$transaction(async (tx) => {
    await clearMatchStatsReport(input.matchId, tx);

    await tx.matchStatsReport.create({
      data: {
        matchId: input.matchId,
        format: input.report.format,
        externalId: input.report.externalId,
        rawText: input.rawText,
        team1Rounds: input.report.team1Rounds,
        team2Rounds: input.report.team2Rounds,
        playerCount: input.report.playerCount,
        uploadedByDiscordId: input.actorDiscordId,
        playerStats: {
          create: matched.map(({ playerId, reportPlayer }) => ({
            ...buildPlayerStatsCreateInput(reportPlayer, playerId),
          })),
        },
      },
    });
  });

  const match = await prisma.match.findUnique({
    where: { id: input.matchId },
    select: { league: { select: { gameId: true } } },
  });
  if (match?.league?.gameId && input.report.itemRates.length > 0) {
    await upsertGameItems(match.league.gameId, input.report.itemRates);
  }

  const roundWinner = winningTeamFromWos2Rounds(input.report);
  if (roundWinner !== null) {
    warnings.push(`Report round score suggests Team ${roundWinner} won.`);
  }

  return {
    externalId: input.report.externalId,
    summaryLines: buildSummaryLines(matched),
    warnings,
  };
}

/** Load suggested winner from a stored WOS2 report, if any. */
export async function loadSuggestedWinnerForMatch(
  matchId: string,
): Promise<{ suggested: SuggestedWinner | null; roundLine: string | null }> {
  const stored = await prisma.matchStatsReport.findUnique({
    where: { matchId },
    select: {
      rawText: true,
      team1Rounds: true,
      team2Rounds: true,
    },
  });

  if (!stored?.rawText) {
    return { suggested: null, roundLine: null };
  }

  let report: Wos2BotReport;
  try {
    report = parseWos2BotReport(stored.rawText);
  } catch {
    return { suggested: null, roundLine: null };
  }

  const suggested = inferSuggestedWinner(report);
  const roundLine =
    stored.team1Rounds !== null && stored.team2Rounds !== null
      ? `${stored.team1Rounds}–${stored.team2Rounds} rounds`
      : null;

  return { suggested, roundLine };
}

/** Persist a WOS2 bot match report for an in-progress match. */
export async function uploadMatchStatsReport(input: {
  matchId: string;
  actorDiscordId: string;
  memberRoleIds: string[];
  matchModRoleId: string | undefined;
  rawText: string;
}): Promise<UploadMatchStatsResult> {
  const match = await getMatchById(input.matchId);
  if (!match) {
    throw new MatchServiceError('This match was not found.');
  }

  if (match.status !== 'IN_PROGRESS') {
    throw new MatchServiceError('Match stats can only be uploaded while the match is in progress.');
  }

  assertCanManageMatch({
    hostDiscordId: match.hostDiscordId,
    actorDiscordId: input.actorDiscordId,
    memberRoleIds: input.memberRoleIds,
    matchModRoleId: input.matchModRoleId,
  });

  const profile = await getGameProfileForMatch(match);
  if (profile.postMatchStats !== 'wos2_bot_v1') {
    throw new MatchServiceError('This game does not accept match stats reports.');
  }

  let report: Wos2BotReport;
  try {
    report = parseWos2BotReport(input.rawText);
  } catch (error) {
    mapParseError(error);
  }

  const { matched, warnings } = matchReportPlayersToRoster(match.players, report);

  const persisted = await persistWos2MatchStats({
    matchId: match.id,
    actorDiscordId: input.actorDiscordId,
    rawText: input.rawText,
    report,
    matchPlayers: match.players,
  });

  return {
    matchId: match.id,
    externalId: persisted.externalId,
    summaryLines: persisted.summaryLines,
    warnings: [...warnings, ...persisted.warnings.filter((w) => !warnings.includes(w))],
  };
}

/** Discord field value for completed match stats (truncated). */
export function formatMatchStatsFieldValue(stats: MatchPlayerStatsLine[]): string {
  const lines = formatMatchStatsSummaryLines(stats);
  return truncateDiscordFieldValue(lines.join('\n'));
}

const TEAM_A_EMOJI = '🟥';
const TEAM_B_EMOJI = '🟦';

export type MatchStatsLogContext = {
  profile: GameProfile;
  roster: Array<{ playerId: string; team: number; slot: number }>;
  team1Rounds?: number | null;
  team2Rounds?: number | null;
};

/** Compact stat numbers for Discord embed lines (e.g. 9834 → 10k). */
export function formatCompactStatNumber(value: number): string {
  if (value >= 1_000 || value <= -1_000) {
    return `${Math.round(value / 1000)}k`;
  }
  return String(value);
}

/** One player line for log-channel match stats (hero, K/D, damage, heal, taken). */
export function formatMatchStatsDetailedPlayerLine(row: MatchPlayerStatsLine): string {
  const hero = row.heroName ?? 'Unknown hero';
  const kda = `${row.kills}/${row.deaths}`;
  const dmg = formatCompactStatNumber(row.damageTotal);
  const heal = formatCompactStatNumber(row.heal);
  const taken = formatCompactStatNumber(row.takenTotal);
  return `**${displayPlayerNick(row.username)}** · ${hero} · ${kda} · ${dmg} dmg · ${heal} heal · ${taken} taken`;
}

/** Monospace table for a team's match stats (Discord code block). */
export function formatMatchStatsTeamTable(teamStats: MatchPlayerStatsLine[]): string {
  return formatMonospaceTable(teamStats, [
    {
      header: 'Player',
      align: 'left',
      maxWidth: 10,
      cell: (row) => displayPlayerNick(row.username),
    },
    {
      header: 'Hero',
      align: 'left',
      maxWidth: 14,
      cell: (row) => row.heroName ?? 'Unknown',
    },
    {
      header: 'K/D',
      align: 'right',
      maxWidth: 5,
      cell: (row) => `${row.kills}/${row.deaths}`,
    },
    {
      header: 'Dmg',
      align: 'right',
      maxWidth: 5,
      cell: (row) => formatCompactStatNumber(row.damageTotal),
    },
    {
      header: 'Heal',
      align: 'right',
      maxWidth: 5,
      cell: (row) => formatCompactStatNumber(row.heal),
    },
    {
      header: 'Taken',
      align: 'right',
      maxWidth: 5,
      cell: (row) => formatCompactStatNumber(row.takenTotal),
    },
  ]);
}

function sortStatsForTeam(
  stats: MatchPlayerStatsLine[],
  roster: MatchStatsLogContext['roster'],
  team: 1 | 2,
): MatchPlayerStatsLine[] {
  const slotByPlayerId = new Map(
    roster.filter((entry) => entry.team === team).map((entry) => [entry.playerId, entry.slot]),
  );

  return stats
    .filter((row) => slotByPlayerId.has(row.playerId))
    .sort(
      (left, right) =>
        (slotByPlayerId.get(left.playerId) ?? 0) - (slotByPlayerId.get(right.playerId) ?? 0),
    );
}

/** Embed fields for WOS-style match stats on the completed-match log channel. */
export function buildMatchStatsLogEmbedFields(
  stats: MatchPlayerStatsLine[],
  ctx: MatchStatsLogContext,
): Array<{ name: string; value: string; inline: boolean }> {
  const fields: Array<{ name: string; value: string; inline: boolean }> = [];

  if (ctx.team1Rounds != null && ctx.team2Rounds != null) {
    fields.push({
      name: 'Round score',
      value: `${teamDisplayName(1, ctx.profile)} **${ctx.team1Rounds}** – **${ctx.team2Rounds}** ${teamDisplayName(2, ctx.profile)}`,
      inline: false,
    });
  }

  for (const team of [1, 2] as const) {
    const teamStats = sortStatsForTeam(stats, ctx.roster, team);
    if (teamStats.length === 0) {
      continue;
    }

    const emoji = team === 1 ? TEAM_A_EMOJI : TEAM_B_EMOJI;
    fields.push({
      name: `${emoji} ${teamDisplayName(team, ctx.profile)} stats`,
      value: truncateDiscordFieldValue(formatMatchStatsTeamTable(teamStats)),
      inline: false,
    });
  }

  return fields;
}

/** Add persisted WOS match stats to completed-match log embeds; no-op when stats are absent. */
export async function enrichCompletedMatchLogEmbeds(
  match: MatchWithPlayers,
  embeds: EmbedBuilder[],
): Promise<EmbedBuilder[]> {
  if (embeds.length === 0) {
    return embeds;
  }

  const stats = await loadMatchPlayerStatsLines(match.id);
  if (stats.length === 0) {
    return embeds;
  }

  const profile = await getGameProfileForMatch(match);
  const report = await prisma.matchStatsReport.findUnique({
    where: { matchId: match.id },
    select: { team1Rounds: true, team2Rounds: true },
  });

  const fields = buildMatchStatsLogEmbedFields(stats, {
    profile,
    roster: match.players.map((player) => ({
      playerId: player.playerId,
      team: player.team,
      slot: player.slot,
    })),
    team1Rounds: report?.team1Rounds,
    team2Rounds: report?.team2Rounds,
  });

  if (fields.length === 0) {
    return embeds;
  }

  const enriched = EmbedBuilder.from(embeds[0]!.data).addFields(...fields);
  return [enriched, ...embeds.slice(1)];
}

/** Fetch plain-text report content from a Discord attachment URL. */
export async function fetchTextAttachment(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new MatchServiceError('Could not download the report attachment.');
  }
  const text = await response.text();
  if (!text.trim()) {
    throw new MatchServiceError('The report attachment is empty.');
  }
  return text;
}

/** True when the attachment looks like a text report file. */
export function isTextReportAttachment(input: {
  contentType: string | null;
  name: string | null;
}): boolean {
  if (input.contentType?.startsWith('text/')) {
    return true;
  }
  const name = input.name?.toLowerCase() ?? '';
  return name.endsWith('.txt') || name.endsWith('.log');
}
