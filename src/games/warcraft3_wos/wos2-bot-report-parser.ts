export const WOS2_BOT_REPORT_FORMAT = 'WOS2_BOT_V1' as const;

export type Wos2BotReportPlayer = {
  index: number;
  pid: number;
  name: string;
  team: 1 | 2;
  win: boolean;
  heroObjectId: number | null;
  heroName: string | null;
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
  team1Rounds: number | null;
  team2Rounds: number | null;
  playerCount: number | null;
  players: Wos2BotReportPlayer[];
};

export class Wos2BotReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Wos2BotReportParseError';
  }
}

type PartialPlayer = {
  index: number;
  pid: number;
  name?: string;
  team?: 1 | 2;
  win?: boolean;
  heroObjectId?: number | null;
  heroName?: string | null;
  kills?: number;
  deaths?: number;
  damagePhys?: number;
  damageMagic?: number;
  damageTotal?: number;
  heal?: number;
  takenPhys?: number;
  takenMagic?: number;
  takenTotal?: number;
  itemSlots?: [number, number, number, number, number, number];
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

function parseFields(line: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const part of line.split('|')) {
    const eq = part.indexOf('=');
    if (eq === -1) {
      continue;
    }
    fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  return fields;
}

function requireInt(fields: Map<string, string>, key: string, context: string): number {
  const raw = fields.get(key);
  if (raw === undefined || raw.trim() === '') {
    throw new Wos2BotReportParseError(`Missing ${key} on ${context}.`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Wos2BotReportParseError(`Invalid ${key} on ${context}: ${raw}`);
  }
  return value;
}

function optionalInt(fields: Map<string, string>, key: string): number | null {
  const raw = fields.get(key);
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Wos2BotReportParseError(`Invalid ${key}: ${raw}`);
  }
  return value;
}

function parseTeam(raw: string | undefined, context: string): 1 | 2 {
  const value = Number(raw);
  if (value === 1 || value === 2) {
    return value;
  }
  throw new Wos2BotReportParseError(`Invalid team on ${context}: ${raw ?? ''}`);
}

function parseWin(raw: string | undefined, context: string): boolean {
  if (raw === '1') {
    return true;
  }
  if (raw === '0') {
    return false;
  }
  throw new Wos2BotReportParseError(`Invalid win flag on ${context}: ${raw ?? ''}`);
}

function playerKey(index: number, pid: number): string {
  return `${index}:${pid}`;
}

function getOrCreatePlayer(
  players: Map<string, PartialPlayer>,
  index: number,
  pid: number,
): PartialPlayer {
  const key = playerKey(index, pid);
  const existing = players.get(key);
  if (existing) {
    return existing;
  }

  const created: PartialPlayer = { index, pid };
  players.set(key, created);
  return created;
}

function parseItemSlots(
  fields: Map<string, string>,
  context: string,
): Wos2BotReportPlayer['itemSlots'] {
  return [
    requireInt(fields, 'slot1', context),
    requireInt(fields, 'slot2', context),
    requireInt(fields, 'slot3', context),
    requireInt(fields, 'slot4', context),
    requireInt(fields, 'slot5', context),
    requireInt(fields, 'slot6', context),
  ];
}

function finalizePlayer(partial: PartialPlayer): Wos2BotReportPlayer {
  const context = `player n=${partial.index} pid=${partial.pid}`;

  if (!partial.name?.trim()) {
    throw new Wos2BotReportParseError(`Missing name on ${context}.`);
  }
  if (partial.team === undefined) {
    throw new Wos2BotReportParseError(`Missing team on ${context}.`);
  }
  if (partial.win === undefined) {
    throw new Wos2BotReportParseError(`Missing win on ${context}.`);
  }

  const requiredNumbers: Array<[keyof PartialPlayer, string]> = [
    ['kills', 'kills'],
    ['deaths', 'deaths'],
    ['damagePhys', 'damage_phys'],
    ['damageMagic', 'damage_magic'],
    ['damageTotal', 'damage_total'],
    ['heal', 'heal'],
    ['takenPhys', 'taken_phys'],
    ['takenMagic', 'taken_magic'],
    ['takenTotal', 'taken_total'],
  ];

  for (const [field, label] of requiredNumbers) {
    if (partial[field] === undefined) {
      throw new Wos2BotReportParseError(`Missing ${label} on ${context}.`);
    }
  }

  if (!partial.itemSlots) {
    throw new Wos2BotReportParseError(`Missing items on ${context}.`);
  }

  return {
    index: partial.index,
    pid: partial.pid,
    name: partial.name.trim(),
    team: partial.team,
    win: partial.win,
    heroObjectId: partial.heroObjectId ?? null,
    heroName: partial.heroName ?? null,
    kills: partial.kills!,
    deaths: partial.deaths!,
    damagePhys: partial.damagePhys!,
    damageMagic: partial.damageMagic!,
    damageTotal: partial.damageTotal!,
    heal: partial.heal!,
    takenPhys: partial.takenPhys!,
    takenMagic: partial.takenMagic!,
    takenTotal: partial.takenTotal!,
    itemSlots: partial.itemSlots,
  };
}

/** Parse a WOS2 bot match report export into a typed structure. */
export function parseWos2BotReport(rawText: string): Wos2BotReport {
  const lines = extractWos2BotPayloadLines(rawText);
  if (lines.length === 0) {
    throw new Wos2BotReportParseError('Report file is empty or contains no payload lines.');
  }

  let externalId: string | null = null;
  let format: string | null = null;
  let team1Rounds: number | null = null;
  let team2Rounds: number | null = null;
  let playerCount: number | null = null;
  let endId: string | null = null;
  const partialPlayers = new Map<string, PartialPlayer>();

  for (const line of lines) {
    const type = line.split('|', 1)[0];
    const fields = parseFields(line);

    switch (type) {
      case 'ID': {
        externalId = fields.get('value') ?? null;
        format = fields.get('format') ?? null;
        break;
      }
      case 'MATCH': {
        team1Rounds = optionalInt(fields, 'team1_rounds');
        team2Rounds = optionalInt(fields, 'team2_rounds');
        playerCount = optionalInt(fields, 'players');
        break;
      }
      case 'PLAYER': {
        const index = requireInt(fields, 'n', 'PLAYER');
        const pid = requireInt(fields, 'pid', 'PLAYER');
        const player = getOrCreatePlayer(partialPlayers, index, pid);
        player.name = fields.get('name') ?? player.name;
        player.team = parseTeam(fields.get('team'), `PLAYER n=${index}`);
        player.win = parseWin(fields.get('win'), `PLAYER n=${index}`);
        const heroId = optionalInt(fields, 'hero_id');
        player.heroObjectId = heroId === 0 ? null : heroId;
        player.heroName = fields.get('hero_name') ?? player.heroName ?? null;
        break;
      }
      case 'STATS': {
        const index = requireInt(fields, 'n', 'STATS');
        const pid = requireInt(fields, 'pid', 'STATS');
        const player = getOrCreatePlayer(partialPlayers, index, pid);
        player.kills = requireInt(fields, 'kills', 'STATS');
        player.deaths = requireInt(fields, 'deaths', 'STATS');
        player.damagePhys = requireInt(fields, 'damage_phys', 'STATS');
        player.damageMagic = requireInt(fields, 'damage_magic', 'STATS');
        player.damageTotal = requireInt(fields, 'damage_total', 'STATS');
        player.heal = requireInt(fields, 'heal', 'STATS');
        player.takenPhys = requireInt(fields, 'taken_phys', 'STATS');
        player.takenMagic = requireInt(fields, 'taken_magic', 'STATS');
        player.takenTotal = requireInt(fields, 'taken_total', 'STATS');
        break;
      }
      case 'ITEMS': {
        const index = requireInt(fields, 'n', 'ITEMS');
        const pid = requireInt(fields, 'pid', 'ITEMS');
        const player = getOrCreatePlayer(partialPlayers, index, pid);
        player.itemSlots = parseItemSlots(fields, 'ITEMS');
        break;
      }
      case 'ITEM_RATE':
        break;
      case 'END': {
        endId = fields.get('id') ?? null;
        break;
      }
      default:
        break;
    }
  }

  if (!externalId) {
    throw new Wos2BotReportParseError('Report is missing ID|value=…');
  }
  if (format !== WOS2_BOT_REPORT_FORMAT) {
    throw new Wos2BotReportParseError(
      `Unsupported report format: ${format ?? 'missing'}. Expected ${WOS2_BOT_REPORT_FORMAT}.`,
    );
  }
  if (!endId) {
    throw new Wos2BotReportParseError('Report is missing END|id=…');
  }
  if (endId !== externalId) {
    throw new Wos2BotReportParseError('Report ID and END id do not match.');
  }
  if (partialPlayers.size === 0) {
    throw new Wos2BotReportParseError('Report contains no player rows.');
  }

  const players = [...partialPlayers.values()]
    .sort((left, right) => left.index - right.index)
    .map(finalizePlayer);

  return {
    format: WOS2_BOT_REPORT_FORMAT,
    externalId,
    team1Rounds,
    team2Rounds,
    playerCount,
    players,
  };
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
