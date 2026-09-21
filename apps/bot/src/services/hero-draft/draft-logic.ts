import {
  HERO_DRAFT_SEQUENCE,
  HeroDraftError,
  type HeroDraftState,
  type HeroDraftTeam,
  type HeroDraftTeamSide,
  type HeroDraftTurn,
  type HeroPoolEntry,
} from './draft-types.js';

/** Current turn, or null when the draft is finished. */
export function currentTurn(state: HeroDraftState): HeroDraftTurn | null {
  return HERO_DRAFT_SEQUENCE[state.turnIndex] ?? null;
}

export function isHeroDraftComplete(state: HeroDraftState): boolean {
  return state.turnIndex >= HERO_DRAFT_SEQUENCE.length;
}

export function teamBySide(state: HeroDraftState, side: HeroDraftTeamSide): HeroDraftTeam {
  const team = state.teams.find((entry) => entry.side === side);
  if (!team) {
    throw new HeroDraftError(`Missing team ${side}.`);
  }
  return team;
}

/** Heroes still available (not banned, not picked). */
export function availableHeroes(state: HeroDraftState): HeroPoolEntry[] {
  const taken = new Set<number>();
  for (const team of state.teams) {
    for (const ban of team.bans) {
      if (ban != null) {
        taken.add(ban);
      }
    }
    for (const pick of team.picks) {
      taken.add(pick);
    }
  }
  return state.pool.filter((hero) => !taken.has(hero.objectId));
}

function assertActiveTurn(state: HeroDraftState, kind: 'ban' | 'pick'): HeroDraftTurn {
  const turn = currentTurn(state);
  if (!turn) {
    throw new HeroDraftError('The draft is already complete.');
  }
  if (turn.kind !== kind) {
    throw new HeroDraftError(`Expected a ${kind} action, but it is a ${turn.kind} turn.`);
  }
  return turn;
}

function withAdvancedTurn(
  state: HeroDraftState,
  teams: [HeroDraftTeam, HeroDraftTeam],
): HeroDraftState {
  return {
    ...state,
    teams,
    turnIndex: state.turnIndex + 1,
    selectPage: 0,
    actionDeadlineAt: null,
  };
}

function replaceTeam(
  state: HeroDraftState,
  side: HeroDraftTeamSide,
  next: HeroDraftTeam,
): [HeroDraftTeam, HeroDraftTeam] {
  const first = state.teams[0]!.side === side ? next : state.teams[0]!;
  const second = state.teams[1]!.side === side ? next : state.teams[1]!;
  return [first, second];
}

/** Ban a hero for the team on the clock. */
export function applyBan(state: HeroDraftState, objectId: number): HeroDraftState {
  const turn = assertActiveTurn(state, 'ban');
  const available = availableHeroes(state);
  if (!available.some((hero) => hero.objectId === objectId)) {
    throw new HeroDraftError('That hero is not available.');
  }

  const team = teamBySide(state, turn.team);
  const updated: HeroDraftTeam = {
    ...team,
    bans: [...team.bans, objectId],
  };
  return withAdvancedTurn(state, replaceTeam(state, turn.team, updated));
}

/** Skip the current ban (records null). */
export function applySkipBan(state: HeroDraftState): HeroDraftState {
  const turn = assertActiveTurn(state, 'ban');
  const team = teamBySide(state, turn.team);
  const updated: HeroDraftTeam = {
    ...team,
    bans: [...team.bans, null],
  };
  return withAdvancedTurn(state, replaceTeam(state, turn.team, updated));
}

/** Pick a hero for the team on the clock. */
export function applyPick(state: HeroDraftState, objectId: number): HeroDraftState {
  const turn = assertActiveTurn(state, 'pick');
  const available = availableHeroes(state);
  if (!available.some((hero) => hero.objectId === objectId)) {
    throw new HeroDraftError('That hero is not available.');
  }

  const team = teamBySide(state, turn.team);
  const updated: HeroDraftTeam = {
    ...team,
    picks: [...team.picks, objectId],
  };
  return withAdvancedTurn(state, replaceTeam(state, turn.team, updated));
}

/**
 * Apply timeout for the current turn.
 * Ban → skip; pick → random available hero.
 */
export function applyTimeout(
  state: HeroDraftState,
  rng: () => number = Math.random,
): HeroDraftState {
  const turn = currentTurn(state);
  if (!turn) {
    return state;
  }
  if (turn.kind === 'ban') {
    return applySkipBan(state);
  }

  const available = availableHeroes(state);
  if (available.length === 0) {
    throw new HeroDraftError('No heroes left to pick on timeout.');
  }
  const index = Math.floor(rng() * available.length);
  const hero = available[index]!;
  return applyPick(state, hero.objectId);
}

export function setSelectPage(state: HeroDraftState, page: number): HeroDraftState {
  if (!Number.isInteger(page) || page < 0) {
    throw new HeroDraftError('Invalid select page.');
  }
  return { ...state, selectPage: page };
}

export function setActionDeadline(
  state: HeroDraftState,
  deadlineIso: string | null,
): HeroDraftState {
  return { ...state, actionDeadlineAt: deadlineIso };
}

export function heroNameByObjectId(state: HeroDraftState, objectId: number): string {
  return state.pool.find((hero) => hero.objectId === objectId)?.name ?? `Hero ${objectId}`;
}
