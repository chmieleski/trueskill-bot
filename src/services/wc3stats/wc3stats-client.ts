export class Wc3statsClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Wc3statsClientError';
  }
}

export type Wc3statsListGame = {
  id: number;
  name: string;
  host: string;
  map: string;
  slotsTaken: number;
  slotsTotal: number;
  server?: string;
};

export type Wc3statsGameDetail = {
  id: number;
  name?: string;
  host?: { battleTag?: string | null; name?: string | null } | string | null;
  map?:
    | {
        path?: string;
        normalizedName?: string;
        sha1?: string;
        name?: string;
      }
    | string
    | null;
  numPlayers?: number;
  slotsTaken?: number;
  numSlots?: number;
  slots?: Array<{
    status?: string;
    isComputer?: boolean;
    isObserver?: boolean;
    player?: { name?: string | null; battleTag?: string | null } | null;
  }>;
};

const LIST_URL = 'https://api.wc3stats.com/gamelist';

function detailUrl(id: number): string {
  return `${LIST_URL}/${id}`;
}

async function getJson(url: string, timeoutMs: number): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Wc3statsClientError('Could not reach wc3stats.');
  }

  if (!response.ok) {
    throw new Wc3statsClientError(`wc3stats returned HTTP ${response.status}.`);
  }

  try {
    return await response.json();
  } catch {
    throw new Wc3statsClientError('wc3stats returned invalid JSON.');
  }
}

function unwrapBody(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && 'body' in payload) {
    return (payload as { body: unknown }).body;
  }
  return payload;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0;
}

function parseListGame(value: unknown): Wc3statsListGame | null {
  const row = asRecord(value);
  if (!row) {
    return null;
  }

  const id = asNumber(row.id);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }

  return {
    id,
    name: asString(row.name),
    host: asString(row.host),
    map: asString(row.map),
    slotsTaken: asNumber(row.slotsTaken ?? row.slots_taken),
    slotsTotal: asNumber(row.slotsTotal ?? row.slots_total),
    server: asString(row.server) || undefined,
  };
}

function parseDetailMap(value: unknown): Wc3statsGameDetail['map'] {
  if (typeof value === 'string') {
    return { name: value, path: value };
  }
  const row = asRecord(value);
  if (!row) {
    return null;
  }
  return {
    path: asString(row.path) || undefined,
    normalizedName: asString(row.normalizedName ?? row.normalized_name) || undefined,
    sha1: asString(row.sha1) || undefined,
    name: asString(row.name) || undefined,
  };
}

function parseDetailHost(value: unknown): Wc3statsGameDetail['host'] {
  if (typeof value === 'string') {
    return { name: value, battleTag: value };
  }
  const row = asRecord(value);
  if (!row) {
    return null;
  }
  return {
    name: asString(row.name) || null,
    battleTag: asString(row.battleTag ?? row.battletag) || null,
  };
}

function parseGameDetail(value: unknown): Wc3statsGameDetail | null {
  const row = asRecord(value);
  if (!row) {
    return null;
  }

  const id = asNumber(row.id);
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }

  const slots = Array.isArray(row.slots) ? row.slots : [];

  return {
    id,
    name: asString(row.name) || undefined,
    host: parseDetailHost(row.host),
    map: parseDetailMap(row.map),
    numPlayers: asNumber(row.numPlayers ?? row.num_players ?? row.slotsTaken),
    slotsTaken: asNumber(row.slotsTaken ?? row.numPlayers),
    numSlots: asNumber(row.numSlots ?? row.num_slots) || undefined,
    slots,
  };
}

/**
 * Fetch the live wc3stats gamelist.
 */
export async function fetchGamelist(timeoutMs: number): Promise<Wc3statsListGame[]> {
  const payload = unwrapBody(await getJson(LIST_URL, timeoutMs));
  const rows = Array.isArray(payload) ? payload : null;
  if (!rows) {
    throw new Wc3statsClientError('wc3stats gamelist was not a list.');
  }

  return rows.map(parseListGame).filter((game): game is Wc3statsListGame => game !== null);
}

/**
 * Fetch one lobby including slots when wc3stats has published them.
 */
export async function fetchGameDetail(id: number, timeoutMs: number): Promise<Wc3statsGameDetail> {
  const payload = unwrapBody(await getJson(detailUrl(id), timeoutMs));
  const detail = parseGameDetail(payload);
  if (!detail) {
    throw new Wc3statsClientError('wc3stats game detail was not an object.');
  }
  return detail;
}
