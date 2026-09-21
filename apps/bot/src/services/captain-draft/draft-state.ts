import type { CaptainDraft, Prisma } from '@dbz/db';
import { prisma } from '../../lib/prisma.js';
import type { CaptainDraftStatus, DraftState } from './draft-types.js';
import { CaptainDraftError, emptyDraftState } from './draft-types.js';

const ACTIVE_STATUSES: CaptainDraftStatus[] = ['SETUP', 'ACTIVE', 'COMPLETE'];

/** Serialize in-memory draft state for Postgres JSON storage. */
export function serializeDraftState(state: DraftState): Prisma.InputJsonValue {
  return state as unknown as Prisma.InputJsonValue;
}

/** Parse persisted JSON into a typed {@link DraftState}. */
export function parseDraftState(row: CaptainDraft): DraftState {
  const raw = row.state;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CaptainDraftError('Invalid draft state in database.');
  }

  const value = raw as Record<string, unknown>;

  return {
    captains: parseParticipants(value.captains, 'captains'),
    memberPool: parseParticipants(value.memberPool, 'memberPool'),
    pickOrder: parseNumberArray(value.pickOrder, 'pickOrder'),
    teams: parseTeams(value.teams),
    pickIndex: parsePickIndex(value.pickIndex),
  };
}

function parseParticipants(value: unknown, field: string): DraftState['captains'] {
  if (!Array.isArray(value)) {
    throw new CaptainDraftError(`Invalid draft state in database (${field}).`);
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new CaptainDraftError(`Invalid draft state in database (${field}[${index}]).`);
    }

    const participant = entry as Record<string, unknown>;
    const key = participant.key;
    const label = participant.label;

    if (typeof key !== 'string' || typeof label !== 'string') {
      throw new CaptainDraftError(`Invalid draft state in database (${field}[${index}]).`);
    }

    const discordId = participant.discordId;
    if (discordId !== undefined && typeof discordId !== 'string') {
      throw new CaptainDraftError(
        `Invalid draft state in database (${field}[${index}].discordId).`,
      );
    }

    return discordId ? { key, label, discordId } : { key, label };
  });
}

function parseNumberArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'number')) {
    throw new CaptainDraftError(`Invalid draft state in database (${field}).`);
  }

  return value;
}

function parseTeams(value: unknown): DraftState['teams'] {
  if (!Array.isArray(value)) {
    throw new CaptainDraftError('Invalid draft state in database (teams).');
  }

  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new CaptainDraftError(`Invalid draft state in database (teams[${index}]).`);
    }

    const team = entry as Record<string, unknown>;
    const captainKey = team.captainKey;
    const displayName = team.displayName;
    const pickOrderIndex = team.pickOrderIndex;

    if (
      typeof captainKey !== 'string' ||
      typeof displayName !== 'string' ||
      typeof pickOrderIndex !== 'number'
    ) {
      throw new CaptainDraftError(`Invalid draft state in database (teams[${index}]).`);
    }

    return {
      captainKey,
      displayName,
      pickOrderIndex,
      roster: parseParticipants(team.roster, `teams[${index}].roster`),
    };
  });
}

function parsePickIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new CaptainDraftError('Invalid draft state in database (pickIndex).');
  }

  return value;
}

/** Return the newest non-cancelled draft in a channel, if any. */
export async function findActiveDraftForChannel(
  guildId: string,
  channelId: string,
): Promise<CaptainDraft | null> {
  return prisma.captainDraft.findFirst({
    where: {
      guildId,
      channelId,
      status: { in: ACTIVE_STATUSES },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/** Persist draft status and JSON state; optionally update the live draft message id. */
export async function saveDraftState(
  draftId: string,
  status: CaptainDraftStatus,
  state: DraftState,
  extra?: { draftMessageId?: string | null },
): Promise<CaptainDraft> {
  return prisma.captainDraft.update({
    where: { id: draftId },
    data: {
      status,
      state: serializeDraftState(state),
      ...(extra?.draftMessageId !== undefined ? { draftMessageId: extra.draftMessageId } : {}),
    },
  });
}

/** Create a new draft in SETUP with an empty state payload. */
export async function createDraft(input: {
  guildId: string;
  channelId: string;
  hostDiscordId: string;
  leagueId?: string;
}): Promise<CaptainDraft> {
  return prisma.captainDraft.create({
    data: {
      guildId: input.guildId,
      channelId: input.channelId,
      hostDiscordId: input.hostDiscordId,
      leagueId: input.leagueId ?? null,
      status: 'SETUP',
      state: serializeDraftState(emptyDraftState()),
    },
  });
}
