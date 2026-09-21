export type HeroDraftStatus = 'ACTIVE' | 'COMPLETE' | 'CANCELLED';

export type HeroDraftActionKind = 'ban' | 'pick';

export type HeroDraftTeamSide = 1 | 2;

export type HeroPoolEntry = {
  objectId: number;
  name: string;
};

export type HeroDraftMember = {
  key: string;
  label: string;
  discordId?: string;
};

export type HeroDraftTeam = {
  side: HeroDraftTeamSide;
  displayName: string;
  captain: HeroDraftMember;
  roster: HeroDraftMember[];
  bans: Array<number | null>;
  picks: number[];
};

export type HeroDraftTurn = {
  kind: HeroDraftActionKind;
  team: HeroDraftTeamSide;
};

/** Fixed ban/pick sequence (Team 1 = first ban). */
export const HERO_DRAFT_SEQUENCE: readonly HeroDraftTurn[] = [
  { kind: 'ban', team: 1 },
  { kind: 'ban', team: 2 },
  { kind: 'ban', team: 1 },
  { kind: 'ban', team: 2 },
  { kind: 'pick', team: 1 },
  { kind: 'pick', team: 2 },
  { kind: 'pick', team: 2 },
  { kind: 'pick', team: 1 },
  { kind: 'pick', team: 1 },
  { kind: 'pick', team: 2 },
  { kind: 'ban', team: 1 },
  { kind: 'ban', team: 2 },
  { kind: 'pick', team: 2 },
  { kind: 'pick', team: 1 },
  { kind: 'pick', team: 1 },
  { kind: 'pick', team: 2 },
] as const;

/** Worst-case unique heroes consumed (6 bans + 10 picks). */
export const HERO_DRAFT_MIN_POOL_SIZE = 16;

export type HeroDraftState = {
  teams: [HeroDraftTeam, HeroDraftTeam];
  pool: HeroPoolEntry[];
  turnIndex: number;
  actionDeadlineAt: string | null;
  selectPage: number;
};

export class HeroDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeroDraftError';
  }
}

export function emptyHeroDraftState(
  teams: [HeroDraftTeam, HeroDraftTeam],
  pool: HeroPoolEntry[],
): HeroDraftState {
  return {
    teams,
    pool,
    turnIndex: 0,
    actionDeadlineAt: null,
    selectPage: 0,
  };
}
