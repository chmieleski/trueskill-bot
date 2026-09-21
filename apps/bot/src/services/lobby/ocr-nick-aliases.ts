import { createLogger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { MatchServiceError } from '../match/match-service.js';
import { normalizeNick } from '../player/player-nick.js';
import type { LobbyPlayer } from './lobby-ocr.js';

const log = createLogger('ocr-nick-aliases');

export type OcrNickAlias = {
  fromNick: string;
  toNick: string;
};

/** Normalize and validate a staff-entered alias pair for storage. */
export function normalizeOcrNickAliasPair(
  fromRaw: string,
  toRaw: string,
): { fromNick: string; toNick: string } {
  const fromNick = normalizeNick(fromRaw);
  const toNick = normalizeNick(toRaw);

  if (fromNick === '' || toNick === '') {
    throw new MatchServiceError('Both `from` and `to` must be non-empty nicks.');
  }

  if (fromNick === toNick) {
    throw new MatchServiceError('`from` and `to` must be different nicks.');
  }

  return { fromNick, toNick };
}

/**
 * Rewrite OCR nicks using an exact from→to map (keys already normalizeNick'd).
 * Does not mutate the input list or player objects.
 */
export function applyOcrNickAliases(
  players: ReadonlyArray<LobbyPlayer>,
  aliasMap: ReadonlyMap<string, string>,
): LobbyPlayer[] {
  if (aliasMap.size === 0) {
    return [...players];
  }

  return players.map((player) => {
    const mapped = aliasMap.get(player.nick);
    if (mapped === undefined || mapped === player.nick) {
      return player;
    }

    log.info(
      { fromNick: player.nick, toNick: mapped, slot: player.slot },
      'OCR nick alias applied',
    );
    return { ...player, nick: mapped };
  });
}

export function formatOcrNickAliasLines(aliases: ReadonlyArray<OcrNickAlias>): string[] {
  if (aliases.length === 0) {
    return ['`unset`'];
  }

  return [...aliases]
    .sort((a, b) => a.fromNick.localeCompare(b.fromNick))
    .map((entry) => `\`${entry.fromNick}\` → \`${entry.toNick}\``);
}

export function formatOcrNickAliasSection(lines: string[]): string {
  return ['**OCR nick aliases**', ...lines.map((line) => `• ${line}`)].join('\n');
}

/** Load league OCR aliases as a Map for apply. */
export async function loadLeagueOcrNickAliasMap(
  leagueId: string,
): Promise<ReadonlyMap<string, string>> {
  const rows = await listLeagueOcrNickAliases(leagueId);
  return new Map(rows.map((row) => [row.fromNick, row.toNick]));
}

export async function listLeagueOcrNickAliases(leagueId: string): Promise<OcrNickAlias[]> {
  return prisma.leagueOcrNickAlias.findMany({
    where: { leagueId },
    orderBy: { fromNick: 'asc' },
    select: { fromNick: true, toNick: true },
  });
}

/** Upsert one OCR nick alias for a league. */
export async function setLeagueOcrNickAlias(
  leagueId: string,
  fromRaw: string,
  toRaw: string,
): Promise<OcrNickAlias> {
  const { fromNick, toNick } = normalizeOcrNickAliasPair(fromRaw, toRaw);

  await prisma.leagueOcrNickAlias.upsert({
    where: {
      leagueId_fromNick: { leagueId, fromNick },
    },
    create: { leagueId, fromNick, toNick },
    update: { toNick },
  });

  return { fromNick, toNick };
}

/** Remove one alias. Returns true when a row was deleted. */
export async function clearLeagueOcrNickAlias(leagueId: string, fromRaw: string): Promise<boolean> {
  const fromNick = normalizeNick(fromRaw);
  if (fromNick === '') {
    throw new MatchServiceError('`from` must be a non-empty nick.');
  }

  const result = await prisma.leagueOcrNickAlias.deleteMany({
    where: { leagueId, fromNick },
  });
  return result.count > 0;
}

/** Delete all OCR nick aliases for a league. Returns deleted count. */
export async function clearAllLeagueOcrNickAliases(leagueId: string): Promise<number> {
  const result = await prisma.leagueOcrNickAlias.deleteMany({
    where: { leagueId },
  });
  return result.count;
}
