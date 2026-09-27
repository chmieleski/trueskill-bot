export type ApiHeroStatsScope = 'all' | 'last' | 'range' | 'both';

export type ApiHeroStatsQuery = {
  scope: ApiHeroStatsScope;
  games: number; // 1–100, default 20
  from: Date | null; // required when scope === 'range'
  to: Date | null; // exclusive end; null means "now" at load time when scope === 'range'
  recentLimit: number; // 1–50, default 20
  topPlayers: number; // 0–25, default 5
};

export type ParseApiHeroStatsQueryResult =
  { ok: true; value: ApiHeroStatsQuery } | { ok: false; error: string };

const SCOPES: readonly ApiHeroStatsScope[] = ['all', 'last', 'range', 'both'];

function parseOptionalInt(
  params: URLSearchParams,
  key: string,
  defaultValue: number,
  min: number,
  max: number,
): { ok: true; value: number } | { ok: false; error: string } {
  const raw = params.get(key);
  if (raw === null || raw === '') {
    return { ok: true, value: defaultValue };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    return { ok: false, error: `Invalid ${key}: must be an integer between ${min} and ${max}` };
  }
  return { ok: true, value: n };
}

function parseIsoDate(raw: string): Date | null {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d;
}

/** Parse `URLSearchParams` from the request URL into a validated query. */
export function parseApiHeroStatsQuery(params: URLSearchParams): ParseApiHeroStatsQueryResult {
  const scopeRaw = params.get('scope');
  const scope: ApiHeroStatsScope =
    scopeRaw === null || scopeRaw === '' ? 'both' : (scopeRaw as ApiHeroStatsScope);

  if (!SCOPES.includes(scope)) {
    return { ok: false, error: `Invalid scope: must be one of ${SCOPES.join(', ')}` };
  }

  const hasFrom = params.has('from') && params.get('from') !== '';
  const hasTo = params.has('to') && params.get('to') !== '';

  if (scope !== 'range' && (hasFrom || hasTo)) {
    return {
      ok: false,
      error: 'from and to are only allowed when scope is range',
    };
  }

  const gamesResult = parseOptionalInt(params, 'games', 20, 1, 100);
  if (!gamesResult.ok) {
    return gamesResult;
  }

  const recentLimitResult = parseOptionalInt(params, 'recentLimit', 20, 1, 50);
  if (!recentLimitResult.ok) {
    return recentLimitResult;
  }

  const topPlayersResult = parseOptionalInt(params, 'topPlayers', 5, 0, 25);
  if (!topPlayersResult.ok) {
    return topPlayersResult;
  }

  let from: Date | null = null;
  let to: Date | null = null;

  if (scope === 'range') {
    if (!hasFrom) {
      return { ok: false, error: 'from is required when scope is range' };
    }

    const fromRaw = params.get('from')!;
    from = parseIsoDate(fromRaw);
    if (from === null) {
      return { ok: false, error: 'Invalid from: must be a valid ISO date' };
    }

    if (hasTo) {
      const toRaw = params.get('to')!;
      to = parseIsoDate(toRaw);
      if (to === null) {
        return { ok: false, error: 'Invalid to: must be a valid ISO date' };
      }
      if (from.getTime() >= to.getTime()) {
        return { ok: false, error: 'from must be before to' };
      }
    }
  }

  return {
    ok: true,
    value: {
      scope,
      games: gamesResult.value,
      from,
      to,
      recentLimit: recentLimitResult.value,
      topPlayers: topPlayersResult.value,
    },
  };
}
