import type { GameProfile } from '../../domain/game-profile.js';
import { teamForSlot } from '../../domain/game-profile.js';
import type { LobbyPlayer } from '../../services/lobby/lobby-ocr.js';
import type { Wos2BotReport } from './wos2-bot-report-parser.js';
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

/** Map wc3stats player id (0–9) to bot lobby slot (1–10). */
export function wc3statsPidToBotSlot(pid: number): number {
  const slot = PID_TO_SLOT.get(pid);
  if (slot === undefined) {
    throw new Wos2ReportRosterError(`Unknown player id (pid) in report: ${pid}`);
  }
  return slot;
}

/** Build lobby roster from a parsed WOS2 bot report. */
export function lobbyPlayersFromWos2Report(
  report: Wos2BotReport,
  profile: GameProfile,
): LobbyPlayer[] {
  const players: LobbyPlayer[] = [];
  const seenSlots = new Set<number>();

  for (const reportPlayer of report.players) {
    const slot = wc3statsPidToBotSlot(reportPlayer.pid);
    if (seenSlots.has(slot)) {
      throw new Wos2ReportRosterError(`Duplicate slot ${slot} in report.`);
    }
    seenSlots.add(slot);
    players.push({ slot, nick: reportPlayer.name.trim() });
  }

  if (players.length === 0) {
    throw new Wos2ReportRosterError('Report contains no players.');
  }

  const teamCounts = { 1: 0, 2: 0 };
  for (const player of players) {
    teamCounts[teamForSlot(profile, player.slot)] += 1;
  }
  if (teamCounts[1] === 0 || teamCounts[2] === 0) {
    throw new Wos2ReportRosterError('Both teams must have at least one player in the report.');
  }

  return players;
}
