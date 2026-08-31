import type { GameProfile } from '../../domain/game-profile.js';
import type { LobbyPlayer } from '../../services/lobby/lobby-ocr.js';
import { normalizeNick } from '../../services/player/player-nick.js';
import type { Wos2BotReport, Wos2BotReportPlayer } from './wos2-bot-report-parser.js';
import { WOS_WC3STATS_SLOT_MAP } from './wos-slot-map.js';

export class Wos2ReportRosterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Wos2ReportRosterError';
  }
}

const PID_TO_SLOT = new Map(
  WOS_WC3STATS_SLOT_MAP.map((entry) => [entry.wc3statsSlot, entry.heroId]),
);

/** Map wc3stats player id (0–9) to bot lobby slot (1–10). Legacy fallback when team_slot is absent. */
export function wc3statsPidToBotSlot(pid: number): number {
  const slot = PID_TO_SLOT.get(pid);
  if (slot === undefined) {
    throw new Wos2ReportRosterError(`Unknown player id (pid) in report: ${pid}`);
  }
  return slot;
}

/**
 * Map a report player to a bot lobby slot using in-match team + team_slot.
 * Falls back to wc3stats pid (lobby color) when team_slot is missing (schema 1 exports).
 */
export function botSlotFromReportPlayer(
  profile: GameProfile,
  reportPlayer: Wos2BotReportPlayer,
): number {
  if (reportPlayer.teamSlot !== null) {
    const maxPerTeam = profile.teamAMaxSlot;
    if (reportPlayer.teamSlot < 1 || reportPlayer.teamSlot > maxPerTeam) {
      throw new Wos2ReportRosterError(
        `Invalid team_slot ${reportPlayer.teamSlot} on player n=${reportPlayer.index} (max ${maxPerTeam}).`,
      );
    }
    return reportPlayer.team === 1
      ? reportPlayer.teamSlot
      : profile.teamAMaxSlot + reportPlayer.teamSlot;
  }

  return wc3statsPidToBotSlot(reportPlayer.pid);
}

function assertBothTeamsInReport(report: Wos2BotReport): void {
  const teamCounts = { 1: 0, 2: 0 };
  for (const player of report.players) {
    teamCounts[player.team] += 1;
  }
  if (teamCounts[1] === 0 || teamCounts[2] === 0) {
    throw new Wos2ReportRosterError('Both teams must have at least one player in the report.');
  }
}

/** Build lobby roster from a parsed WOS2 bot report (team-aware; quitters pre-flagged). */
export function lobbyPlayersFromWos2Report(
  report: Wos2BotReport,
  profile: GameProfile,
): LobbyPlayer[] {
  assertBothTeamsInReport(report);

  const players: LobbyPlayer[] = [];
  const seenSlots = new Set<number>();

  for (const reportPlayer of report.players) {
    const slot = botSlotFromReportPlayer(profile, reportPlayer);
    if (seenSlots.has(slot)) {
      throw new Wos2ReportRosterError(`Duplicate slot ${slot} in report.`);
    }
    seenSlots.add(slot);
    players.push({
      slot,
      nick: normalizeNick(reportPlayer.name),
      ...(reportPlayer.left ? { isQuitter: true } : {}),
    });
  }

  if (players.length === 0) {
    throw new Wos2ReportRosterError('Report contains no players.');
  }

  return players;
}
