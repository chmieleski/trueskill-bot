import { captainIndexForPick } from '../captain-draft/draft-logic.js';
import { teamForSlot, type GameProfile, type TeamId } from '../../domain/game-profile.js';
import {
  LOBBY_DRAFT_MAX_VOTES,
  LOBBY_DRAFT_MIN_LINKED,
  LOBBY_DRAFT_MIN_PLAYERS,
  LobbyDraftError,
  NEED_2V2_MESSAGE,
  NOT_IN_DRAFT_MESSAGE,
  STALE_ACTION_MESSAGE,
  type CoinChoice,
  type LobbyDraftParticipant,
  type LobbyDraftState,
  type LobbyDraftTeam,
  type TeamIndex,
} from './draft-types.js';

type Rng = () => number;

/** Fisher–Yates copy. */
export function shuffle<T>(items: readonly T[], rng: Rng = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function findParticipant(
  state: LobbyDraftState,
  key: string,
): LobbyDraftParticipant | undefined {
  return state.participants.find((p) => p.key === key);
}

export function participantByDiscordId(
  state: LobbyDraftState,
  discordId: string,
): LobbyDraftParticipant | undefined {
  return state.participants.find((p) => p.discordId === discordId);
}

export function nickOf(state: LobbyDraftState, key: string): string {
  return findParticipant(state, key)?.nick ?? key;
}

export function linkedParticipants(
  state: Pick<LobbyDraftState, 'participants'>,
): LobbyDraftParticipant[] {
  return state.participants.filter((p) => p.discordId);
}

/** True when a lobby roster is big enough for a captain draft (≥4 players, ≥2 linked). */
export function canStartLobbyDraft(participants: LobbyDraftParticipant[]): boolean {
  return (
    participants.length >= LOBBY_DRAFT_MIN_PLAYERS &&
    participants.filter((p) => p.discordId).length >= LOBBY_DRAFT_MIN_LINKED
  );
}

export function assertCanStartLobbyDraft(participants: LobbyDraftParticipant[]): void {
  if (!canStartLobbyDraft(participants)) {
    throw new LobbyDraftError(
      'A captain draft needs at least 4 lobby players (2v2), with at least 2 linked to Discord.',
    );
  }
}

function assertPhase(state: LobbyDraftState, phase: LobbyDraftState['phase']): void {
  if (state.phase !== phase) {
    throw new LobbyDraftError(STALE_ACTION_MESSAGE);
  }
}

function requireTeams(state: LobbyDraftState): [LobbyDraftTeam, LobbyDraftTeam] {
  if (!state.teams) {
    throw new LobbyDraftError(STALE_ACTION_MESSAGE);
  }
  return state.teams;
}

function withLog(state: LobbyDraftState, ...lines: string[]): LobbyDraftState {
  return { ...state, log: [...state.log, ...lines] };
}

/** Linked voters still in the draft who have a ballot on file. */
export function votedCount(state: LobbyDraftState): number {
  return linkedParticipants(state).filter((p) => state.votes[p.discordId!]).length;
}

/** Votes per linked candidate (ballots from people no longer in the draft are ignored). */
export function voteCounts(state: LobbyDraftState): Map<string, number> {
  const counts = new Map(linkedParticipants(state).map((p) => [p.key, 0]));
  for (const [voterId, keys] of Object.entries(state.votes)) {
    if (!participantByDiscordId(state, voterId)) continue;
    for (const key of keys) {
      if (counts.has(key)) counts.set(key, counts.get(key)! + 1);
    }
  }
  return counts;
}

/** Top two linked candidates by votes; ties broken randomly (shuffle, then stable sort). */
export function tallyVotes(state: LobbyDraftState, rng: Rng = Math.random): [string, string] {
  const counts = voteCounts(state);
  const order = shuffle([...counts.keys()], rng).sort((a, b) => counts.get(b)! - counts.get(a)!);
  if (order.length < 2) {
    throw new LobbyDraftError(NEED_2V2_MESSAGE);
  }
  return [order[0]!, order[1]!];
}

function voteSummary(state: LobbyDraftState, captains: [string, string]): string[] {
  const counts = voteCounts(state);
  const voted = [...counts.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (voted.length === 0) return ['🗳️ No votes — captains chosen at random. 🎲'];
  const lines = [`🗳️ Votes: ${voted.map(([key, n]) => `${nickOf(state, key)} ${n}`).join(', ')}`];
  const cutoff = counts.get(captains[1])!;
  const tiedOut = [...counts.entries()].some(([key, n]) => n === cutoff && !captains.includes(key));
  if (tiedOut) lines.push('🎲 Tie for captain broken randomly.');
  return lines;
}

/** End voting: pick captains, flip the coin (teams[0] = winner), fill the pool. */
export function closeVote(state: LobbyDraftState, rng: Rng = Math.random): LobbyDraftState {
  assertPhase(state, 'VOTE');
  const [first, second] = tallyVotes(state, rng);
  const [winner, loser] = rng() < 0.5 ? [first, second] : [second, first];
  return withLog(
    {
      ...state,
      phase: 'COIN_CHOICE',
      teams: [
        { captainKey: winner, roster: [winner], side: null },
        { captainKey: loser, roster: [loser], side: null },
      ],
      pool: state.participants.map((p) => p.key).filter((k) => k !== winner && k !== loser),
    },
    ...voteSummary(state, [first, second]),
    `👑 Captains: ${nickOf(state, first)} and ${nickOf(state, second)}.`,
    `🪙 Coin flip won by ${nickOf(state, winner)} — choose first pick or side.`,
  );
}

export function castVote(
  state: LobbyDraftState,
  voterDiscordId: string,
  candidateKeys: string[],
  rng: Rng = Math.random,
): LobbyDraftState {
  assertPhase(state, 'VOTE');
  if (!participantByDiscordId(state, voterDiscordId)) {
    throw new LobbyDraftError(NOT_IN_DRAFT_MESSAGE);
  }
  const keys = [...new Set(candidateKeys)];
  if (keys.length < 1 || keys.length > LOBBY_DRAFT_MAX_VOTES) {
    throw new LobbyDraftError('Vote for 1 or 2 players.');
  }
  for (const key of keys) {
    if (!findParticipant(state, key)?.discordId) {
      throw new LobbyDraftError('Only linked lobby players can be captains.');
    }
  }
  const next = { ...state, votes: { ...state.votes, [voterDiscordId]: keys } };
  return closeEarlyIfDone(next, null, rng);
}

export function chooseCoin(state: LobbyDraftState, choice: CoinChoice): LobbyDraftState {
  assertPhase(state, 'COIN_CHOICE');
  const teams = requireTeams(state);
  const winner = nickOf(state, teams[0].captainKey);
  if (choice === 'FIRST_PICK') {
    return withLog(
      { ...state, phase: 'PICK', firstPickTeam: 0, sideChooserTeam: 1 },
      `${winner} takes first pick; ${nickOf(state, teams[1].captainKey)} will choose the side.`,
    );
  }
  return withLog(
    { ...state, phase: 'SIDE', firstPickTeam: 1, sideChooserTeam: 0 },
    `${winner} chooses the side; ${nickOf(state, teams[1].captainKey)} picks first.`,
  );
}

/** Team whose captain makes pick number `state.pickIndex`. */
export function pickingTeam(state: LobbyDraftState): TeamIndex {
  const first = state.firstPickTeam ?? 0;
  return captainIndexForPick(state.pickIndex, 2) === 0 ? first : first === 0 ? 1 : 0;
}

function phaseAfterPicks(state: LobbyDraftState): LobbyDraftState['phase'] {
  return requireTeams(state)[0].side ? 'HERO' : 'SIDE';
}

export function applyPick(state: LobbyDraftState, key: string): LobbyDraftState {
  assertPhase(state, 'PICK');
  const teams = requireTeams(state);
  if (!state.pool.includes(key)) {
    throw new LobbyDraftError('Player not in pool.');
  }
  const t = pickingTeam(state);
  const nextTeams = teams.map((team, i) =>
    i === t ? { ...team, roster: [...team.roster, key] } : team,
  ) as [LobbyDraftTeam, LobbyDraftTeam];
  const pool = state.pool.filter((k) => k !== key);
  const next: LobbyDraftState = {
    ...state,
    teams: nextTeams,
    pool,
    pickIndex: state.pickIndex + 1,
  };
  return withLog(
    { ...next, phase: pool.length === 0 ? phaseAfterPicks(next) : 'PICK' },
    `${nickOf(state, teams[t].captainKey)} picked ${nickOf(state, key)}.`,
  );
}

export function applySide(
  state: LobbyDraftState,
  side: TeamId,
  teamNames: { 1: string; 2: string },
): LobbyDraftState {
  assertPhase(state, 'SIDE');
  const teams = requireTeams(state);
  const chooser = state.sideChooserTeam ?? 0;
  const other: TeamId = side === 1 ? 2 : 1;
  const nextTeams = teams.map((team, i) => ({ ...team, side: i === chooser ? side : other })) as [
    LobbyDraftTeam,
    LobbyDraftTeam,
  ];
  return withLog(
    { ...state, teams: nextTeams, phase: state.pool.length > 0 ? 'PICK' : 'HERO' },
    `${nickOf(state, teams[chooser].captainKey)} chose ${teamNames[side]}.`,
  );
}

/** Team that must act now, or null in simultaneous phases. */
export function onClockTeam(state: LobbyDraftState): TeamIndex | null {
  if (state.phase === 'COIN_CHOICE') return 0;
  if (state.phase === 'PICK') return pickingTeam(state);
  if (state.phase === 'SIDE') return state.sideChooserTeam ?? 0;
  return null;
}

export function onClockCaptainKey(state: LobbyDraftState): string | null {
  const t = onClockTeam(state);
  return t === null || !state.teams ? null : state.teams[t].captainKey;
}

export function assertOnClock(state: LobbyDraftState, actorDiscordId: string): void {
  const key = onClockCaptainKey(state);
  if (!key) {
    throw new LobbyDraftError(STALE_ACTION_MESSAGE);
  }
  if (findParticipant(state, key)?.discordId !== actorDiscordId) {
    throw new LobbyDraftError("It's not your turn.");
  }
}

export function teamOfKey(state: LobbyDraftState, key: string): TeamIndex | null {
  const idx = state.teams?.findIndex((t) => t.roster.includes(key)) ?? -1;
  return idx === 0 || idx === 1 ? idx : null;
}

/** Slot-bound hero ids for one side (slot = hero). */
export function heroIdsForSide(profile: GameProfile, side: TeamId): number[] {
  return Array.from({ length: profile.slotCount }, (_, i) => i + 1).filter(
    (slot) => teamForSlot(profile, slot) === side,
  );
}

/** A new deadline is needed when the phase, the pick, or the on-clock captain changed. */
export function clockChanged(prev: LobbyDraftState, next: LobbyDraftState): boolean {
  return (
    prev.phase !== next.phase ||
    prev.pickIndex !== next.pickIndex ||
    onClockCaptainKey(prev) !== onClockCaptainKey(next)
  );
}

/**
 * Close simultaneous phases early: VOTE when every linked player voted,
 * HERO when every linked player locked in (HERO needs `profile`).
 */
export function closeEarlyIfDone(
  state: LobbyDraftState,
  profile: GameProfile | null,
  rng: Rng = Math.random,
): LobbyDraftState {
  const linked = linkedParticipants(state);
  if (state.phase === 'VOTE' && votedCount(state) === linked.length) {
    return closeVote(state, rng);
  }
  return state;
}
