import { normalizeNick } from '../player/player-nick.js';
import type { TeamId } from '../../domain/game-profile.js';

export type LobbyDraftPhase = 'VOTE' | 'COIN_CHOICE' | 'PICK' | 'SIDE' | 'HERO';
export type LobbyDraftStatus = 'ACTIVE' | 'COMPLETE' | 'CANCELLED';
export type CoinChoice = 'FIRST_PICK' | 'SIDE';
/** Index into `LobbyDraftState.teams`; 0 is always the coin-flip winner's team. */
export type TeamIndex = 0 | 1;

export type LobbyDraftParticipant = {
  /** Stable id inside the draft: normalized nick. */
  key: string;
  nick: string;
  /** Present only when the nick is linked to a Discord account for this game. */
  discordId?: string;
};

export type LobbyDraftTeam = {
  captainKey: string;
  /** Participant keys in draft order; captain first. */
  roster: string[];
  side: TeamId | null;
};

export type HeroAssignment = { heroId: number; how: 'wanted' | 'contested' | 'random' };

export type LobbyDraftState = {
  phase: LobbyDraftPhase;
  participants: LobbyDraftParticipant[];
  /** voter Discord id → 1–2 candidate keys. */
  votes: Record<string, string[]>;
  teams: [LobbyDraftTeam, LobbyDraftTeam] | null;
  firstPickTeam: TeamIndex | null;
  sideChooserTeam: TeamIndex | null;
  /** Global snake pick counter (0-based). */
  pickIndex: number;
  /** Participant keys not drafted yet. */
  pool: string[];
  /** participant key → 0–2 hero ids (unordered). */
  heroPrefs: Record<string, number[]>;
  heroLockedIn: string[];
  heroResult: Record<string, HeroAssignment> | null;
  /** participant key → clash weight (1 + PlayerRating.heroPickLosses), loaded during HERO. */
  heroWeights?: Record<string, number>;
  deadlineAt: string | null;
  /** Human-readable history; new entries are posted to the thread. */
  log: string[];
};

export const LOBBY_DRAFT_PHASE_SECONDS: Record<LobbyDraftPhase, number> = {
  VOTE: 60,
  COIN_CHOICE: 30,
  PICK: 30,
  SIDE: 30,
  HERO: 60,
};
export const LOBBY_DRAFT_MIN_PLAYERS = 4;
export const LOBBY_DRAFT_MIN_LINKED = 2;
export const LOBBY_DRAFT_MAX_VOTES = 2;
export const LOBBY_DRAFT_MAX_HERO_PREFS = 2;

export const NEED_2V2_MESSAGE = 'Need at least 2v2 — replace the player or cancel the draft.';
export const NOT_IN_DRAFT_MESSAGE = "You're not in this draft.";
export const STALE_ACTION_MESSAGE = 'That action is no longer valid.';
export const FROZEN_LOBBY_MESSAGE =
  'A captain draft is running for this lobby. Cancel the draft to edit the roster.';
export const HERO_PICK_HELP =
  "Pick up to 2 heroes you'd play. Optional — pick none and you'll get a random hero. Press **Lock in** when you're done.";

export class LobbyDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LobbyDraftError';
  }
}

/** Optimistic-save lost a race; callers reload and retry. */
export class LobbyDraftConflictError extends LobbyDraftError {
  constructor() {
    super(STALE_ACTION_MESSAGE);
    this.name = 'LobbyDraftConflictError';
  }
}

export function participantKey(nick: string): string {
  return normalizeNick(nick);
}

export function initialLobbyDraftState(
  participants: LobbyDraftParticipant[],
  deadlineAt: string | null,
): LobbyDraftState {
  return {
    phase: 'VOTE',
    participants,
    votes: {},
    teams: null,
    firstPickTeam: null,
    sideChooserTeam: null,
    pickIndex: 0,
    pool: participants.map((p) => p.key),
    heroPrefs: {},
    heroLockedIn: [],
    heroResult: null,
    deadlineAt,
    log: [],
  };
}
