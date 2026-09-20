import type { HeroDraft, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  HeroDraftError,
  type HeroDraftMember,
  type HeroDraftState,
  type HeroDraftStatus,
  type HeroDraftTeam,
  type HeroPoolEntry,
} from './draft-types.js';

/** Serialize in-memory draft state for Postgres JSON storage. */
export function serializeHeroDraftState(state: HeroDraftState): Prisma.InputJsonValue {
  return state as unknown as Prisma.InputJsonValue;
}

function parseMember(value: unknown, field: string): HeroDraftMember {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HeroDraftError(`Invalid hero draft state (${field}).`);
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.key !== 'string' || typeof entry.label !== 'string') {
    throw new HeroDraftError(`Invalid hero draft state (${field}).`);
  }
  const discordId = entry.discordId;
  if (discordId !== undefined && typeof discordId !== 'string') {
    throw new HeroDraftError(`Invalid hero draft state (${field}.discordId).`);
  }
  return discordId
    ? { key: entry.key, label: entry.label, discordId }
    : { key: entry.key, label: entry.label };
}

function parseTeam(value: unknown, index: number): HeroDraftTeam {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HeroDraftError(`Invalid hero draft state (teams[${index}]).`);
  }
  const team = value as Record<string, unknown>;
  if (team.side !== 1 && team.side !== 2) {
    throw new HeroDraftError(`Invalid hero draft state (teams[${index}].side).`);
  }
  if (typeof team.displayName !== 'string') {
    throw new HeroDraftError(`Invalid hero draft state (teams[${index}].displayName).`);
  }
  if (!Array.isArray(team.roster) || !Array.isArray(team.bans) || !Array.isArray(team.picks)) {
    throw new HeroDraftError(`Invalid hero draft state (teams[${index}] lists).`);
  }

  const bans = team.bans.map((ban, banIndex) => {
    if (ban === null) {
      return null;
    }
    if (typeof ban !== 'number') {
      throw new HeroDraftError(`Invalid hero draft state (teams[${index}].bans[${banIndex}]).`);
    }
    return ban;
  });

  const picks = team.picks.map((pick, pickIndex) => {
    if (typeof pick !== 'number') {
      throw new HeroDraftError(`Invalid hero draft state (teams[${index}].picks[${pickIndex}]).`);
    }
    return pick;
  });

  return {
    side: team.side,
    displayName: team.displayName,
    captain: parseMember(team.captain, `teams[${index}].captain`),
    roster: team.roster.map((member, memberIndex) =>
      parseMember(member, `teams[${index}].roster[${memberIndex}]`),
    ),
    bans,
    picks,
  };
}

function parsePool(value: unknown): HeroPoolEntry[] {
  if (!Array.isArray(value)) {
    throw new HeroDraftError('Invalid hero draft state (pool).');
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new HeroDraftError(`Invalid hero draft state (pool[${index}]).`);
    }
    const hero = entry as Record<string, unknown>;
    if (typeof hero.objectId !== 'number' || typeof hero.name !== 'string') {
      throw new HeroDraftError(`Invalid hero draft state (pool[${index}]).`);
    }
    return { objectId: hero.objectId, name: hero.name };
  });
}

/** Parse persisted JSON into a typed {@link HeroDraftState}. */
export function parseHeroDraftState(row: HeroDraft): HeroDraftState {
  const raw = row.state;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HeroDraftError('Invalid hero draft state in database.');
  }
  const value = raw as Record<string, unknown>;
  if (!Array.isArray(value.teams) || value.teams.length !== 2) {
    throw new HeroDraftError('Invalid hero draft state (teams).');
  }

  const teams = [parseTeam(value.teams[0], 0), parseTeam(value.teams[1], 1)] as [
    HeroDraftTeam,
    HeroDraftTeam,
  ];

  if (
    typeof value.turnIndex !== 'number' ||
    !Number.isInteger(value.turnIndex) ||
    value.turnIndex < 0
  ) {
    throw new HeroDraftError('Invalid hero draft state (turnIndex).');
  }
  if (value.actionDeadlineAt !== null && typeof value.actionDeadlineAt !== 'string') {
    throw new HeroDraftError('Invalid hero draft state (actionDeadlineAt).');
  }
  if (
    typeof value.selectPage !== 'number' ||
    !Number.isInteger(value.selectPage) ||
    value.selectPage < 0
  ) {
    throw new HeroDraftError('Invalid hero draft state (selectPage).');
  }

  return {
    teams,
    pool: parsePool(value.pool),
    turnIndex: value.turnIndex,
    actionDeadlineAt: value.actionDeadlineAt,
    selectPage: value.selectPage,
  };
}

export async function loadHeroDraftById(draftId: string): Promise<HeroDraft> {
  const draft = await prisma.heroDraft.findUnique({ where: { id: draftId } });
  if (!draft) {
    throw new HeroDraftError('Hero draft not found.');
  }
  return draft;
}

export async function findActiveHeroDraftForThread(
  guildId: string,
  threadId: string,
): Promise<HeroDraft | null> {
  return prisma.heroDraft.findFirst({
    where: { guildId, threadId, status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
  });
}

export async function listActiveHeroDrafts(): Promise<HeroDraft[]> {
  return prisma.heroDraft.findMany({ where: { status: 'ACTIVE' } });
}

export async function saveHeroDraftState(
  draftId: string,
  status: HeroDraftStatus,
  state: HeroDraftState,
  extra?: { liveMessageId?: string | null },
): Promise<HeroDraft> {
  return prisma.heroDraft.update({
    where: { id: draftId },
    data: {
      status,
      state: serializeHeroDraftState(state),
      ...(extra?.liveMessageId !== undefined ? { liveMessageId: extra.liveMessageId } : {}),
    },
  });
}
