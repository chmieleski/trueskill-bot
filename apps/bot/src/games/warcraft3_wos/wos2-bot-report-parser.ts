import { decodeWos2eExport, Wos2eCodecError } from './wos2e-codec.js';

export const WOS2_BOT_REPORT_FORMAT = 'WOS2_BOT_V2' as const;

export type Wos2BotReportItemRate = {
  objectId: number;
  name: string;
  games: number;
  wins: number;
  winratePct: number;
};

export type Wos2BotReportPlayer = {
  index: number;
  pid: number;
  name: string;
  team: 1 | 2;
  win: boolean;
  /** True when the player left before the match ended (`left=1`). */
  left: boolean;
  /** In-game team position (1–N per side); preferred for bot slot when present. */
  teamSlot: number | null;
  lobbySlot: number | null;
  visualSlot: number | null;
  heroObjectId: number | null;
  heroName: string | null;
  roundsPlayed: number;
  roundWins: number;
  roundLosses: number;
  kills: number;
  deaths: number;
  damagePhys: number;
  damageMagic: number;
  damageTotal: number;
  heal: number;
  takenPhys: number;
  takenMagic: number;
  takenTotal: number;
  itemSlots: [number, number, number, number, number, number];
};

export type Wos2BotReport = {
  format: typeof WOS2_BOT_REPORT_FORMAT;
  externalId: string;
  schema: 2;
  teamsReorganized: boolean;
  team1Rounds: number | null;
  team2Rounds: number | null;
  playerCount: number | null;
  players: Wos2BotReportPlayer[];
  itemRates: Wos2BotReportItemRate[];
};

export class Wos2BotReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Wos2BotReportParseError';
  }
}

type RecordFields = Record<string, string>;

type ParsedRecord = {
  type: string;
  fields: RecordFields;
};

/** Extract payload lines from raw WC3 preload export or plain pipe-delimited text. */
export function extractWos2BotPayloadLines(rawText: string): string[] {
  const lines: string[] = [];

  for (const rawLine of rawText.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }

    const preloadMatch = trimmed.match(/^call\s+Preload\(\s*"([^"]+)"\s*\)/i);
    if (preloadMatch?.[1]) {
      lines.push(preloadMatch[1]);
      continue;
    }

    if (/^(function|endfunction|call\s+Preload(Start|End))/i.test(trimmed)) {
      continue;
    }

    if (trimmed.includes('|')) {
      lines.push(trimmed);
    }
  }

  return lines;
}

function parseRecord(line: string): ParsedRecord {
  const parts = line.split('|');
  const type = parts.shift();
  if (!type) {
    throw new Wos2BotReportParseError('Malformed record: missing type');
  }
  const fields: RecordFields = Object.create(null) as RecordFields;
  for (const part of parts) {
    const split = part.indexOf('=');
    if (split <= 0) {
      throw new Wos2BotReportParseError(`Malformed field in ${type} record`);
    }
    const key = part.slice(0, split);
    if (Object.hasOwn(fields, key)) {
      throw new Wos2BotReportParseError(`Duplicate ${key} field in ${type} record`);
    }
    fields[key] = part.slice(split + 1);
  }
  return { type, fields };
}

function readInt(record: ParsedRecord, key: string, min: number, max: number): number {
  const value = record.fields[key];
  if (value === undefined || !/^-?\d+$/.test(value)) {
    throw new Wos2BotReportParseError(`${record.type}.${key}: expected an integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Wos2BotReportParseError(`${record.type}.${key}: value is out of range`);
  }
  return number;
}

function nullableSlot(value: number): number | null {
  return value < 0 ? null : value;
}

function parseTeam(raw: string | undefined, context: string): 1 | 2 {
  const value = Number(raw);
  if (value === 1 || value === 2) {
    return value;
  }
  throw new Wos2BotReportParseError(`Invalid team on ${context}: ${raw ?? ''}`);
}

function buildReportFromLines(lines: string[], matchId: string): Wos2BotReport {
  const records = lines.map(parseRecord);
  if (records.length < 3 || records[0]?.type !== 'ID' || records[1]?.type !== 'MATCH') {
    throw new Wos2BotReportParseError('Expected ID and MATCH records');
  }

  const idRecord = records[0]!;
  if (idRecord.fields.value !== matchId || idRecord.fields.format !== WOS2_BOT_REPORT_FORMAT) {
    throw new Wos2BotReportParseError('ID or format does not match the container');
  }
  if (idRecord.fields.scope !== 'MATCH') {
    throw new Wos2BotReportParseError('Only scope=MATCH is supported');
  }

  const match = records[1]!;
  const playerCount = readInt(match, 'players', 0, 10);
  const team1Rounds = readInt(match, 'team1_rounds', 0, 10000);
  const team2Rounds = readInt(match, 'team2_rounds', 0, 10000);
  if (readInt(match, 'schema', 2, 2) !== 2) {
    throw new Wos2BotReportParseError('Unsupported schema');
  }
  const teamsReorganized = readInt(match, 'teams_reorganized', 0, 1) === 1;

  const players: Wos2BotReportPlayer[] = [];
  const seenPids = new Set<number>();
  let cursor = 2;

  for (let index = 1; index <= playerCount; index += 1) {
    const player = records[cursor++];
    const stats = records[cursor++];
    const items = records[cursor++];
    if (
      !player ||
      !stats ||
      !items ||
      player.type !== 'PLAYER' ||
      stats.type !== 'STATS' ||
      items.type !== 'ITEMS'
    ) {
      throw new Wos2BotReportParseError(
        `Player ${index}: expected PLAYER, STATS, and ITEMS records`,
      );
    }

    const n = readInt(player, 'n', index, index);
    const pid = readInt(player, 'pid', 0, 15);
    if (seenPids.has(pid)) {
      throw new Wos2BotReportParseError(`Duplicate pid=${pid}`);
    }
    seenPids.add(pid);

    const team = parseTeam(player.fields.team, `PLAYER n=${n}`);
    const win = readInt(player, 'win', 0, 1) === 1;
    const left = readInt(player, 'left', 0, 1) === 1;
    const heroId = readInt(player, 'hero_id', -2147483648, 2147483647);
    const lobbySlot = nullableSlot(readInt(player, 'lobby_slot', -1, 15));
    const teamSlot = nullableSlot(readInt(player, 'team_slot', -1, 15));
    const visualSlot = nullableSlot(readInt(player, 'visual_slot', -1, 15));
    const name = player.fields.name?.trim();
    if (!name) {
      throw new Wos2BotReportParseError(`Missing name on player n=${n} pid=${pid}.`);
    }

    if (readInt(stats, 'n', n, n) !== n || readInt(stats, 'pid', pid, pid) !== pid) {
      throw new Wos2BotReportParseError(`Player ${index}: PLAYER and STATS records do not match`);
    }

    const roundsPlayed = readInt(stats, 'rounds_played', 0, 2147483647);
    const roundWins = readInt(stats, 'round_wins', 0, 2147483647);
    const roundLosses = readInt(stats, 'round_losses', 0, 2147483647);
    const kills = readInt(stats, 'kills', 0, 2147483647);
    const deaths = readInt(stats, 'deaths', 0, 2147483647);
    const damagePhys = readInt(stats, 'damage_phys', 0, 2147483647);
    const damageMagic = readInt(stats, 'damage_magic', 0, 2147483647);
    const damageTotal = readInt(stats, 'damage_total', 0, 2147483647);
    const heal = readInt(stats, 'heal', 0, 2147483647);
    const takenPhys = readInt(stats, 'taken_phys', 0, 2147483647);
    const takenMagic = readInt(stats, 'taken_magic', 0, 2147483647);
    const takenTotal = readInt(stats, 'taken_total', 0, 2147483647);

    if (damageTotal !== damagePhys + damageMagic || takenTotal !== takenPhys + takenMagic) {
      throw new Wos2BotReportParseError(`Player ${index}: invalid damage total`);
    }

    if (readInt(items, 'n', n, n) !== n || readInt(items, 'pid', pid, pid) !== pid) {
      throw new Wos2BotReportParseError(`Player ${index}: PLAYER and ITEMS records do not match`);
    }

    const itemSlots: Wos2BotReportPlayer['itemSlots'] = [
      readInt(items, 'slot1', -2147483648, 2147483647),
      readInt(items, 'slot2', -2147483648, 2147483647),
      readInt(items, 'slot3', -2147483648, 2147483647),
      readInt(items, 'slot4', -2147483648, 2147483647),
      readInt(items, 'slot5', -2147483648, 2147483647),
      readInt(items, 'slot6', -2147483648, 2147483647),
    ];

    players.push({
      index: n,
      pid,
      name,
      team,
      win,
      left,
      teamSlot,
      lobbySlot,
      visualSlot,
      heroObjectId: heroId === 0 ? null : heroId,
      heroName: player.fields.hero_name?.trim() || null,
      roundsPlayed,
      roundWins,
      roundLosses,
      kills,
      deaths,
      damagePhys,
      damageMagic,
      damageTotal,
      heal,
      takenPhys,
      takenMagic,
      takenTotal,
      itemSlots,
    });
  }

  const itemRates: Wos2BotReportItemRate[] = [];
  while (cursor < records.length && records[cursor]?.type === 'ITEM_RATE') {
    const item = records[cursor++]!;
    const objectId = readInt(item, 'item_id', -2147483648, 2147483647);
    const name = item.fields.item_name?.trim();
    if (!name) {
      throw new Wos2BotReportParseError('ITEM_RATE: missing item_name');
    }
    const games = readInt(item, 'games', 1, 10);
    const wins = readInt(item, 'wins', 0, games);
    const winratePct = readInt(item, 'winrate_pct', 0, 100);
    if (winratePct !== Math.floor((wins * 100) / games)) {
      throw new Wos2BotReportParseError('ITEM_RATE: invalid winrate_pct');
    }
    itemRates.push({ objectId, name, games, wins, winratePct });
  }

  const end = records[cursor++];
  if (!end || end.type !== 'END' || end.fields.id !== matchId || cursor !== records.length) {
    throw new Wos2BotReportParseError('Missing a valid final END record');
  }

  if (players.length === 0) {
    throw new Wos2BotReportParseError('Report contains no player rows.');
  }

  return {
    format: WOS2_BOT_REPORT_FORMAT,
    externalId: matchId,
    schema: 2,
    teamsReorganized,
    team1Rounds,
    team2Rounds,
    playerCount,
    players,
    itemRates,
  };
}

/** Parse a WOS2E encrypted bot match report into a typed structure. */
export function parseWos2BotReport(rawText: string): Wos2BotReport {
  let decoded;
  try {
    decoded = decodeWos2eExport(rawText);
  } catch (error) {
    if (error instanceof Wos2eCodecError) {
      throw new Wos2BotReportParseError(error.message);
    }
    throw error;
  }

  return buildReportFromLines(decoded.lines, decoded.matchId);
}

/** Winning team from round scores when both are present; null when inconclusive. */
export function winningTeamFromWos2Rounds(report: Wos2BotReport): 1 | 2 | null {
  if (report.team1Rounds === null || report.team2Rounds === null) {
    return null;
  }
  if (report.team1Rounds === report.team2Rounds) {
    return null;
  }
  return report.team1Rounds > report.team2Rounds ? 1 : 2;
}
