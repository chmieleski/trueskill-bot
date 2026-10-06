import { normalizeNick } from '../player/player-nick.js';
import type { LobbyPlayer } from './lobby-ocr.js';

export type InGameRosterSource = 'screenshot' | 'wc3stats';

/** One seat of the last roster read from the game, in bot slots. */
export type InGameRosterEntry = { slot: number; nick: string; rawName: string };

/** "Put this player into this bot slot" — absolute, so any order converges. */
export type SwapMove = { name: string; botSlot: number };

/** Snapshot rows from a game read; rawName falls back to the nick. */
export function toInGameRosterSnapshot(players: ReadonlyArray<LobbyPlayer>): InGameRosterEntry[] {
  return players.map((player) => ({
    slot: player.slot,
    nick: normalizeNick(player.nick),
    rawName: player.rawName ?? player.nick,
  }));
}

/** `Match` update data recording a fresh game read. */
export function inGameRosterData(
  players: ReadonlyArray<LobbyPlayer>,
  source: InGameRosterSource,
  now: Date = new Date(),
): {
  inGameRoster: InGameRosterEntry[];
  inGameRosterAt: Date;
  inGameRosterSource: InGameRosterSource;
} {
  return {
    inGameRoster: toInGameRosterSnapshot(players),
    inGameRosterAt: now,
    inGameRosterSource: source,
  };
}

function isEntry(value: unknown): value is InGameRosterEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    Number.isInteger(entry.slot) &&
    typeof entry.nick === 'string' &&
    entry.nick !== '' &&
    typeof entry.rawName === 'string' &&
    entry.rawName !== ''
  );
}

/** Read `Match.inGameRoster` JSON; anything malformed counts as "no snapshot". */
export function parseInGameRoster(value: unknown): InGameRosterEntry[] | null {
  if (!Array.isArray(value) || !value.every(isEntry)) {
    return null;
  }
  return value.map(({ slot, nick, rawName }) => ({ slot, nick, rawName }));
}

export function parseInGameRosterSource(value: unknown): InGameRosterSource | null {
  return value === 'screenshot' || value === 'wc3stats' ? value : null;
}

/**
 * Moves that make the game match `target`. Each move names a player and their
 * final slot; target slots are distinct, so a later move never disturbs an
 * earlier one and the plan converges from any start. The snapshot only skips
 * players it shows already seated — a stale snapshot can drop a line, never
 * produce a wrong swap.
 */
// ponytail: names that prefix another player's name may be ambiguous on prefix-matching host bots.
export function planSwapMoves(
  target: ReadonlyArray<Pick<LobbyPlayer, 'slot' | 'nick'>>,
  snapshot: ReadonlyArray<InGameRosterEntry>,
): SwapMove[] {
  const seen = new Map(snapshot.map((entry) => [entry.nick, entry]));
  return target
    .map((player) => ({ player, inGame: seen.get(normalizeNick(player.nick)) }))
    .filter(({ player, inGame }) => inGame?.slot !== player.slot)
    .map(({ player, inGame }) => ({
      name: inGame?.rawName ?? normalizeNick(player.nick),
      botSlot: player.slot,
    }))
    .sort((a, b) => a.botSlot - b.botSlot);
}
