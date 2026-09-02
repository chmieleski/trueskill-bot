import type { DraftParticipant, DraftState, DraftTeam } from './draft-types.js';
import { CaptainDraftError } from './draft-types.js';

/** Fisher–Yates shuffle of captain pick-order indices `0..count-1`. */
export function shufflePickOrder(count: number, rng: () => number = Math.random): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }
  return order;
}

/** Pick-order slot (0..captainCount-1) for a global snake pick index. */
export function captainIndexForPick(pickIndex: number, captainCount: number): number {
  if (captainCount <= 0) return 0;
  const round = Math.floor(pickIndex / captainCount);
  const pos = pickIndex % captainCount;
  const forward = round % 2 === 0;
  return forward ? pos : captainCount - 1 - pos;
}

/** Build draft teams from captains and shuffled pick-order indices. */
export function buildTeamsFromCaptains(
  captains: DraftParticipant[],
  pickOrder: number[],
): DraftTeam[] {
  return pickOrder.map((captainIdx, pickOrderIndex) => {
    const captain = captains[captainIdx]!;
    return {
      captainKey: captain.key,
      displayName: `Team ${captain.label}`,
      roster: [captain],
      pickOrderIndex,
    };
  });
}

export function findParticipant(state: DraftState, key: string): DraftParticipant | undefined {
  const inPool = state.memberPool.find((p) => p.key === key);
  if (inPool) return inPool;
  for (const team of state.teams) {
    const onTeam = team.roster.find((p) => p.key === key);
    if (onTeam) return onTeam;
  }
  return state.captains.find((p) => p.key === key);
}

function isCaptainKey(state: DraftState, key: string): boolean {
  return state.teams.some((team) => team.captainKey === key);
}

function teamIndexForPick(state: DraftState, pickIndex: number): number {
  const orderIdx = captainIndexForPick(pickIndex, state.teams.length);
  const teamIdx = state.teams.findIndex((team) => team.pickOrderIndex === orderIdx);
  if (teamIdx === -1) {
    throw new CaptainDraftError('No team for current pick');
  }
  return teamIdx;
}

export function applyPick(state: DraftState, participantKey: string): DraftState {
  const poolIdx = state.memberPool.findIndex((p) => p.key === participantKey);
  if (poolIdx === -1) {
    throw new CaptainDraftError('Player not in pool');
  }

  const teamIdx = teamIndexForPick(state, state.pickIndex);
  const player = state.memberPool[poolIdx]!;
  const memberPool = state.memberPool.filter((_, i) => i !== poolIdx);
  const teams = state.teams.map((team, i) =>
    i === teamIdx ? { ...team, roster: [...team.roster, player] } : team,
  );

  return { ...state, memberPool, teams, pickIndex: state.pickIndex + 1 };
}

export function undoLastPick(state: DraftState): DraftState {
  if (state.pickIndex <= 0) {
    throw new CaptainDraftError('Nothing to undo');
  }

  const lastPickIndex = state.pickIndex - 1;
  const teamIdx = teamIndexForPick(state, lastPickIndex);
  const team = state.teams[teamIdx]!;
  if (team.roster.length <= 1) {
    throw new CaptainDraftError('Nothing to undo');
  }

  const picked = team.roster[team.roster.length - 1]!;
  const teams = state.teams.map((t, i) =>
    i === teamIdx ? { ...t, roster: t.roster.slice(0, -1) } : t,
  );

  return {
    ...state,
    memberPool: [...state.memberPool, picked],
    teams,
    pickIndex: lastPickIndex,
  };
}

export function addToPool(state: DraftState, player: DraftParticipant): DraftState {
  return { ...state, memberPool: [...state.memberPool, player] };
}

export function removeFromPool(state: DraftState, participantKey: string): DraftState {
  const memberPool = state.memberPool.filter((p) => p.key !== participantKey);
  if (memberPool.length === state.memberPool.length) {
    throw new CaptainDraftError('Player not in pool');
  }
  return { ...state, memberPool };
}

export function addToTeam(
  state: DraftState,
  participantKey: string,
  captainKey: string,
): DraftState {
  const teamIdx = state.teams.findIndex((team) => team.captainKey === captainKey);
  if (teamIdx === -1) {
    throw new CaptainDraftError('Team not found');
  }

  const poolIdx = state.memberPool.findIndex((p) => p.key === participantKey);
  if (poolIdx === -1) {
    throw new CaptainDraftError('Player not in pool');
  }

  const player = state.memberPool[poolIdx]!;
  const memberPool = state.memberPool.filter((_, i) => i !== poolIdx);
  const teams = state.teams.map((team, i) =>
    i === teamIdx ? { ...team, roster: [...team.roster, player] } : team,
  );

  return { ...state, memberPool, teams };
}

export function removeFromTeam(state: DraftState, participantKey: string): DraftState {
  if (isCaptainKey(state, participantKey)) {
    throw new CaptainDraftError('Cannot remove a captain');
  }

  let removed: DraftParticipant | undefined;
  const teams = state.teams.map((team) => {
    const idx = team.roster.findIndex((p) => p.key === participantKey);
    if (idx === -1) return team;
    removed = team.roster[idx];
    return { ...team, roster: team.roster.filter((p) => p.key !== participantKey) };
  });

  if (!removed) {
    throw new CaptainDraftError('Player not on a team');
  }

  return { ...state, teams, memberPool: [...state.memberPool, removed] };
}

type ParticipantLocation =
  { kind: 'pool'; index: number } | { kind: 'team'; teamIndex: number; rosterIndex: number };

function locateParticipant(state: DraftState, key: string): ParticipantLocation | undefined {
  const poolIndex = state.memberPool.findIndex((p) => p.key === key);
  if (poolIndex !== -1) {
    return { kind: 'pool', index: poolIndex };
  }

  for (let teamIndex = 0; teamIndex < state.teams.length; teamIndex += 1) {
    const rosterIndex = state.teams[teamIndex]!.roster.findIndex((p) => p.key === key);
    if (rosterIndex !== -1) {
      return { kind: 'team', teamIndex, rosterIndex };
    }
  }

  return undefined;
}

function cloneStateWithParticipantAt(
  state: DraftState,
  location: ParticipantLocation,
  participant: DraftParticipant,
): DraftState {
  if (location.kind === 'pool') {
    const memberPool = state.memberPool.map((p, i) => (i === location.index ? participant : p));
    return { ...state, memberPool };
  }

  const teams = state.teams.map((team, i) => {
    if (i !== location.teamIndex) return team;
    const roster = team.roster.map((p, j) => (j === location.rosterIndex ? participant : p));
    return { ...team, roster };
  });
  return { ...state, teams };
}

/** Replace a pool or roster player with someone not already in the draft. */
export function replaceParticipant(
  state: DraftState,
  outgoingKey: string,
  incoming: DraftParticipant,
): DraftState {
  if (isCaptainKey(state, outgoingKey)) {
    throw new CaptainDraftError('Cannot replace a captain');
  }

  const location = locateParticipant(state, outgoingKey);
  if (!location) {
    throw new CaptainDraftError('Participant not found');
  }

  if (location.kind === 'pool') {
    const memberPool = state.memberPool.map((player, index) =>
      index === location.index ? incoming : player,
    );
    return { ...state, memberPool };
  }

  const teams = state.teams.map((team, teamIndex) => {
    if (teamIndex !== location.teamIndex) {
      return team;
    }
    const roster = team.roster.map((player, rosterIndex) =>
      rosterIndex === location.rosterIndex ? incoming : player,
    );
    return { ...team, roster };
  });

  return { ...state, teams };
}

export function swapParticipants(state: DraftState, keyA: string, keyB: string): DraftState {
  if (keyA === keyB) {
    return state;
  }
  if (isCaptainKey(state, keyA) || isCaptainKey(state, keyB)) {
    throw new CaptainDraftError('Cannot swap captains');
  }

  const locA = locateParticipant(state, keyA);
  const locB = locateParticipant(state, keyB);
  if (!locA || !locB) {
    throw new CaptainDraftError('Participant not found');
  }

  const participantA = findParticipant(state, keyA)!;
  const participantB = findParticipant(state, keyB)!;

  let next = cloneStateWithParticipantAt(state, locA, participantB);
  next = cloneStateWithParticipantAt(next, locB, participantA);
  return next;
}

export function moveParticipant(
  state: DraftState,
  participantKey: string,
  toCaptainKey: string,
): DraftState {
  if (isCaptainKey(state, participantKey)) {
    throw new CaptainDraftError('Cannot move a captain');
  }

  const targetTeamIdx = state.teams.findIndex((team) => team.captainKey === toCaptainKey);
  if (targetTeamIdx === -1) {
    throw new CaptainDraftError('Team not found');
  }

  const sourceLoc = locateParticipant(state, participantKey);
  if (!sourceLoc) {
    throw new CaptainDraftError('Participant not found');
  }

  if (sourceLoc.kind === 'team' && sourceLoc.teamIndex === targetTeamIdx) {
    throw new CaptainDraftError('Player already on that team');
  }

  const participant = findParticipant(state, participantKey)!;
  let next = state;

  if (sourceLoc.kind === 'pool') {
    next = {
      ...next,
      memberPool: next.memberPool.filter((p) => p.key !== participantKey),
    };
  } else {
    next = {
      ...next,
      teams: next.teams.map((team, i) =>
        i === sourceLoc.teamIndex
          ? { ...team, roster: team.roster.filter((p) => p.key !== participantKey) }
          : team,
      ),
    };
  }

  const teams = next.teams.map((team, i) =>
    i === targetTeamIdx ? { ...team, roster: [...team.roster, participant] } : team,
  );

  return { ...next, teams };
}

export function isDraftComplete(state: DraftState): boolean {
  return state.memberPool.length === 0;
}

export function currentCaptainKey(state: DraftState): string | null {
  if (isDraftComplete(state) || state.teams.length === 0) {
    return null;
  }
  const orderIdx = captainIndexForPick(state.pickIndex, state.teams.length);
  return state.teams.find((team) => team.pickOrderIndex === orderIdx)?.captainKey ?? null;
}
