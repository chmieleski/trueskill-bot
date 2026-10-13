import { captainIndexForPick } from '../captain-draft/draft-logic.js';
import { teamForSlot, type GameProfile, type TeamId } from '../../domain/game-profile.js';
import { assignHeroes } from './hero-assign.js';
import {
  LOBBY_DRAFT_MAX_HERO_PREFS,
  LOBBY_DRAFT_MAX_VOTES,
  LOBBY_DRAFT_MIN_LINKED,
  LOBBY_DRAFT_MIN_PLAYERS,
  LobbyDraftError,
  NEED_2V2_MESSAGE,
  NOT_IN_DRAFT_MESSAGE,
  STALE_ACTION_MESSAGE,
  type CoinChoice,
  type HeroAssignment,
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
  if (
    state.phase === 'HERO' &&
    !state.heroResult &&
    profile &&
    heroLockedInCount(state) === linked.length
  ) {
    return resolveHeroPhase(state, profile, rng);
  }
  return state;
}

export function heroLockedInCount(state: LobbyDraftState): number {
  return linkedParticipants(state).filter((p) => state.heroLockedIn.includes(p.key)).length;
}

function heroActor(state: LobbyDraftState, actorDiscordId: string): { key: string; side: TeamId } {
  assertPhase(state, 'HERO');
  if (state.heroResult) throw new LobbyDraftError(STALE_ACTION_MESSAGE);
  const actor = participantByDiscordId(state, actorDiscordId);
  const t = actor ? teamOfKey(state, actor.key) : null;
  const side = t === null ? null : requireTeams(state)[t].side;
  if (!actor || !side) {
    throw new LobbyDraftError(NOT_IN_DRAFT_MESSAGE);
  }
  return { key: actor.key, side };
}

export function setHeroPrefs(
  state: LobbyDraftState,
  actorDiscordId: string,
  heroIds: number[],
  profile: GameProfile,
): LobbyDraftState {
  const { key, side } = heroActor(state, actorDiscordId);
  const unique = [...new Set(heroIds)];
  const sideHeroes = heroIdsForSide(profile, side);
  if (unique.length > LOBBY_DRAFT_MAX_HERO_PREFS || unique.some((h) => !sideHeroes.includes(h))) {
    throw new LobbyDraftError('Pick up to 2 heroes from your side.');
  }
  return { ...state, heroPrefs: { ...state.heroPrefs, [key]: unique } };
}

export function lockInHero(
  state: LobbyDraftState,
  actorDiscordId: string,
  profile: GameProfile,
  rng: Rng = Math.random,
): LobbyDraftState {
  const { key } = heroActor(state, actorDiscordId);
  if (state.heroLockedIn.includes(key)) return state;
  return closeEarlyIfDone({ ...state, heroLockedIn: [...state.heroLockedIn, key] }, profile, rng);
}

export function resolveHeroPhase(
  state: LobbyDraftState,
  profile: GameProfile,
  rng: Rng = Math.random,
): LobbyDraftState {
  assertPhase(state, 'HERO');
  if (state.heroResult) throw new LobbyDraftError(STALE_ACTION_MESSAGE);
  const heroResult: Record<string, HeroAssignment> = Object.assign(
    {},
    ...requireTeams(state).map((team) =>
      assignHeroes(
        team.roster.map((key) => ({ key, wanted: state.heroPrefs[key] ?? [] })),
        heroIdsForSide(profile, team.side!),
        rng,
      ),
    ),
  );
  const lines = Object.entries(heroResult)
    .filter(([, a]) => a.how === 'contested')
    .map(([key, a]) => `🎲 ${nickOf(state, key)} won the roll for hero #${a.heroId}.`);
  return withLog({ ...state, heroResult }, '🦸 Heroes assigned.', ...lines);
}

/** Final team sizes if the remaining pool is drafted in snake order. */
export function projectedTeamSizes(state: LobbyDraftState): [number, number] {
  const teams = requireTeams(state);
  const sizes: [number, number] = [teams[0].roster.length, teams[1].roster.length];
  for (let i = 0; i < state.pool.length; i += 1) {
    sizes[pickingTeam({ ...state, pickIndex: state.pickIndex + i })] += 1;
  }
  return sizes;
}

/** Drop a leaver's ballot (by voter id) and every vote cast for them (by key). */
function withoutVotesFor(votes: LobbyDraftState['votes'], key: string, voterId?: string) {
  const next: LobbyDraftState['votes'] = {};
  for (const [voter, keys] of Object.entries(votes)) {
    if (voter === voterId) continue;
    const kept = keys.filter((k) => k !== key);
    if (kept.length > 0) next[voter] = kept;
  }
  return next;
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

/** Newcomer takes the leaver's seat as-is (pool, roster, captaincy). */
export function replaceParticipant(
  state: LobbyDraftState,
  outgoingKey: string,
  incoming: LobbyDraftParticipant,
  profile: GameProfile,
  rng: Rng = Math.random,
): LobbyDraftState {
  if (state.heroResult) throw new LobbyDraftError(STALE_ACTION_MESSAGE);
  const outgoing = findParticipant(state, outgoingKey);
  if (!outgoing) {
    throw new LobbyDraftError('Participant not found.');
  }
  if (
    findParticipant(state, incoming.key) ||
    (incoming.discordId && participantByDiscordId(state, incoming.discordId))
  ) {
    throw new LobbyDraftError('That player is already in this draft.');
  }
  const isCaptain = state.teams?.some((t) => t.captainKey === outgoingKey) ?? false;
  if (isCaptain && !incoming.discordId) {
    throw new LobbyDraftError(
      'A captain must be linked — remove the captain instead so a teammate takes over.',
    );
  }
  const swap = (k: string) => (k === outgoingKey ? incoming.key : k);
  const next: LobbyDraftState = {
    ...state,
    participants: state.participants.map((p) => (p.key === outgoingKey ? incoming : p)),
    pool: state.pool.map(swap),
    teams: state.teams
      ? (state.teams.map((t) => ({
          ...t,
          captainKey: swap(t.captainKey),
          roster: t.roster.map(swap),
        })) as [LobbyDraftTeam, LobbyDraftTeam])
      : null,
    votes: withoutVotesFor(state.votes, outgoingKey, outgoing.discordId),
    heroPrefs: withoutKey(state.heroPrefs, outgoingKey),
    heroLockedIn: state.heroLockedIn.filter((k) => k !== outgoingKey),
  };
  return closeEarlyIfDone(
    withLog(next, `🔁 ${incoming.nick} replaced ${outgoing.nick}.`),
    profile,
    rng,
  );
}

/**
 * Remove a leaver. Refused when the draft could no longer end at least 2v2.
 * A removed captain is succeeded by the earliest-drafted linked teammate,
 * else a random linked pool player, else the removal is refused.
 */
export function removeParticipant(
  state: LobbyDraftState,
  key: string,
  profile: GameProfile,
  rng: Rng = Math.random,
): LobbyDraftState {
  if (state.heroResult) throw new LobbyDraftError(STALE_ACTION_MESSAGE);
  const outgoing = findParticipant(state, key);
  if (!outgoing) {
    throw new LobbyDraftError('Participant not found.');
  }
  const participants = state.participants.filter((p) => p.key !== key);
  if (participants.length < LOBBY_DRAFT_MIN_PLAYERS) {
    throw new LobbyDraftError(NEED_2V2_MESSAGE);
  }
  let next: LobbyDraftState = {
    ...state,
    participants,
    pool: state.pool.filter((k) => k !== key),
    votes: withoutVotesFor(state.votes, key, outgoing.discordId),
    heroPrefs: withoutKey(state.heroPrefs, key),
    heroLockedIn: state.heroLockedIn.filter((k) => k !== key),
  };
  const lines = [`➖ ${outgoing.nick} was removed.`];

  if (!next.teams) {
    if (linkedParticipants(next).length < LOBBY_DRAFT_MIN_LINKED) {
      throw new LobbyDraftError(NEED_2V2_MESSAGE);
    }
  } else {
    const isLinked = (k: string) => Boolean(findParticipant(next, k)?.discordId);
    const teams = next.teams.map((team) => {
      if (!team.roster.includes(key)) return team;
      const roster = team.roster.filter((k) => k !== key);
      if (team.captainKey !== key) return { ...team, roster };
      let successor = roster.find(isLinked);
      if (!successor) {
        successor = shuffle(next.pool.filter(isLinked), rng)[0];
        if (!successor) {
          throw new LobbyDraftError('No linked player can take over as captain — replace instead.');
        }
        const taken = successor;
        next = { ...next, pool: next.pool.filter((k) => k !== taken) };
      }
      lines.push(`👑 ${nickOf(next, successor)} is now captain.`);
      return {
        ...team,
        captainKey: successor,
        roster: [successor, ...roster.filter((k) => k !== successor)],
      };
    }) as [LobbyDraftTeam, LobbyDraftTeam];
    next = { ...next, teams };
    if (projectedTeamSizes(next).some((n) => n < 2)) {
      throw new LobbyDraftError(NEED_2V2_MESSAGE);
    }
    if (next.phase === 'PICK' && next.pool.length === 0) {
      next = { ...next, phase: phaseAfterPicks(next) };
    }
  }
  return closeEarlyIfDone(withLog(next, ...lines), profile, rng);
}

/** Deadline passed: act at random for whoever is on the clock. */
export function applyTimeout(
  state: LobbyDraftState,
  profile: GameProfile,
  rng: Rng = Math.random,
): LobbyDraftState {
  const timedOut = withLog(state, '⏱️ Time ran out — choosing at random.');
  switch (state.phase) {
    case 'VOTE':
      return closeVote(withLog(state, '⏱️ Voting closed.'), rng);
    case 'COIN_CHOICE':
      return chooseCoin(timedOut, rng() < 0.5 ? 'FIRST_PICK' : 'SIDE');
    case 'PICK':
      return applyPick(timedOut, shuffle(state.pool, rng)[0]!);
    case 'SIDE':
      return applySide(timedOut, rng() < 0.5 ? 1 : 2, profile.teamNames);
    case 'HERO':
      return resolveHeroPhase(withLog(state, '⏱️ Hero pick closed.'), profile, rng);
    default:
      throw new LobbyDraftError(STALE_ACTION_MESSAGE);
  }
}
